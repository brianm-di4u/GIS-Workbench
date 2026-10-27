//! Target and anomaly detection (REQ-MSI-11, `Research/10` §9): global RX, local (dual-window)
//! RX, the matched filter, ACE and CEM against a target spectrum, and a Gaussian-mixture anomaly
//! score. Statistics come from a subsample; above 32 bands the caller reduces dimension first
//! (PCA/MNF) for RX, ML and the GMM.

use crate::linalg::{inverse_logdet, quad, Sym};
use crate::stats::{mean_cov, Cube};

/// Global RX: (x − μ)ᵀ Σ⁻¹ (x − μ) with μ, Σ from every `step`-th pixel.
pub fn rx_global(c: &Cube, step: usize) -> Vec<f32> {
    let (m, s, _) = mean_cov(c, None, step);
    let Some((inv, _)) = inverse_logdet(&s, 1e-6) else { return vec![f32::NAN; c.n()] };
    let mut d = vec![0.0; c.nb];
    (0..c.n())
        .map(|p| {
            if !c.valid(p) {
                return f32::NAN;
            }
            let x = c.px(p);
            for b in 0..c.nb {
                d[b] = x[b] as f64 - m[b];
            }
            quad(&inv, &d) as f32
        })
        .collect()
}

/// Local RX: the background mean from an outer window minus a guard window, the covariance
/// global (a common simplification that keeps it O(n)).
pub fn rx_local(c: &Cube, outer: usize, guard: usize, step: usize) -> Vec<f32> {
    let nb = c.nb;
    let (_, s, _) = mean_cov(c, None, step);
    let Some((inv, _)) = inverse_logdet(&s, 1e-6) else { return vec![f32::NAN; c.n()] };
    // Summed-area tables per band for O(1) window means.
    let (w, h) = (c.w, c.h);
    let iw = w + 1;
    let mut sat = vec![0f64; iw * (h + 1) * nb];
    let mut cnt = vec![0u32; iw * (h + 1)];
    for y in 0..h {
        let mut row = vec![0f64; nb];
        let mut rc = 0u32;
        for x in 0..w {
            let p = y * w + x;
            if c.valid(p) {
                for b in 0..nb {
                    row[b] += c.v[p * nb + b] as f64;
                }
                rc += 1;
            }
            let i = (y + 1) * iw + x + 1;
            for b in 0..nb {
                sat[i * nb + b] = sat[(y * iw + x + 1) * nb + b] + row[b];
            }
            cnt[i] = cnt[y * iw + x + 1] + rc;
        }
    }
    let box_ = |x0: usize, y0: usize, x1: usize, y1: usize, out: &mut [f64]| -> u32 {
        for b in 0..nb {
            out[b] = sat[(y1 * iw + x1) * nb + b] - sat[(y0 * iw + x1) * nb + b] - sat[(y1 * iw + x0) * nb + b] + sat[(y0 * iw + x0) * nb + b];
        }
        cnt[y1 * iw + x1] + cnt[y0 * iw + x0] - cnt[y0 * iw + x1] - cnt[y1 * iw + x0]
    };
    let (ro, rg) = (outer / 2, guard / 2);
    let mut so = vec![0.0; nb];
    let mut sg = vec![0.0; nb];
    let mut d = vec![0.0; nb];
    let mut out = vec![f32::NAN; c.n()];
    for y in 0..h {
        for x in 0..w {
            let p = y * w + x;
            if !c.valid(p) {
                continue;
            }
            let no = box_(x.saturating_sub(ro), y.saturating_sub(ro), (x + ro + 1).min(w), (y + ro + 1).min(h), &mut so);
            let ng = box_(x.saturating_sub(rg), y.saturating_sub(rg), (x + rg + 1).min(w), (y + rg + 1).min(h), &mut sg);
            let n = (no - ng) as f64;
            if n < 1.0 {
                continue;
            }
            for b in 0..nb {
                d[b] = c.v[p * nb + b] as f64 - (so[b] - sg[b]) / n;
            }
            out[p] = quad(&inv, &d) as f32;
        }
    }
    out
}

/// Matched filter, ACE and CEM scores for target t: (mf, ace, cem) per pixel.
pub fn target(c: &Cube, t: &[f64], step: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let nb = c.nb;
    let (m, s, _) = mean_cov(c, None, step);
    let inv = inverse_logdet(&s, 1e-6).map(|x| x.0);
    // Correlation matrix R = Σ + μμᵀ for CEM.
    let mut r = Sym::zeros(nb);
    for i in 0..nb {
        for j in 0..nb {
            r.a[i * nb + j] = s.a[i * nb + j] + m[i] * m[j];
        }
    }
    let rinv = inverse_logdet(&r, 1e-6).map(|x| x.0);
    let n = c.n();
    let (mut mf, mut ace, mut cem) = (vec![f32::NAN; n], vec![f32::NAN; n], vec![f32::NAN; n]);
    let (Some(inv), Some(rinv)) = (inv, rinv) else { return (mf, ace, cem) };
    let tm: Vec<f64> = t.iter().zip(&m).map(|(a, b)| a - b).collect();
    // Σ⁻¹(t − μ) and R⁻¹ t once.
    let mul = |a: &Sym, v: &[f64]| -> Vec<f64> { (0..nb).map(|i| (0..nb).map(|j| a.a[i * nb + j] * v[j]).sum()).collect() };
    let st = mul(&inv, &tm);
    let tst: f64 = tm.iter().zip(&st).map(|(a, b)| a * b).sum();
    let rt = mul(&rinv, t);
    let trt: f64 = t.iter().zip(&rt).map(|(a, b)| a * b).sum();
    let mut d = vec![0.0; nb];
    for p in 0..n {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        for b in 0..nb {
            d[b] = x[b] as f64 - m[b];
        }
        let num: f64 = st.iter().zip(&d).map(|(a, b)| a * b).sum();
        mf[p] = (num / tst) as f32;
        let xx = quad(&inv, &d);
        ace[p] = if xx > 0.0 { (num * num / (tst * xx)) as f32 } else { 0.0 };
        cem[p] = (rt.iter().zip(x).map(|(a, &b)| a * b as f64).sum::<f64>() / trt) as f32;
    }
    (mf, ace, cem)
}

/// Gaussian-mixture anomaly: k components fitted by EM on every `step`-th pixel; the score is
/// the negative log-likelihood of each pixel under the mixture.
pub fn gmm(c: &Cube, k: usize, iters: usize, step: usize) -> Vec<f32> {
    let nb = c.nb;
    let (labels, centres) = crate::classify::kmeans(c, k.max(1), 10, step, 0.01);
    let train: Vec<usize> = (0..c.n()).step_by(step.max(1)).filter(|&p| c.valid(p)).collect();
    // Initialise from the K-means partition.
    let mut comps: Vec<(f64, Vec<f64>, Sym)> = (0..centres.len())
        .map(|j| {
            let ix: Vec<usize> = train.iter().copied().filter(|&p| labels[p] as usize == j + 1).collect();
            let (m, s, n) = mean_cov(c, Some(&ix), 1);
            ((n.max(1) as f64) / train.len().max(1) as f64, m, s)
        })
        .collect();
    let lp = |x: &[f32], m: &[f64], inv: &Sym, ld: f64| -> f64 {
        let d: Vec<f64> = x.iter().zip(m).map(|(&a, b)| a as f64 - b).collect();
        -0.5 * (quad(inv, &d) + ld + nb as f64 * (2.0 * std::f64::consts::PI).ln())
    };
    for _ in 0..iters {
        let invs: Vec<(Sym, f64)> = comps.iter().map(|(_, _, s)| inverse_logdet(s, 1e-6).unwrap_or_else(|| (Sym::zeros(nb), 0.0))).collect();
        let kk = comps.len();
        let mut wsum = vec![0.0; kk];
        let mut msum = vec![vec![0.0; nb]; kk];
        let mut resp_all = Vec::with_capacity(train.len());
        for &p in &train {
            let x = c.px(p);
            let l: Vec<f64> = (0..kk).map(|j| comps[j].0.max(1e-12).ln() + lp(x, &comps[j].1, &invs[j].0, invs[j].1)).collect();
            let mx = l.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let e: Vec<f64> = l.iter().map(|v| (v - mx).exp()).collect();
            let z: f64 = e.iter().sum();
            let r: Vec<f64> = e.iter().map(|v| v / z).collect();
            for j in 0..kk {
                wsum[j] += r[j];
                for b in 0..nb {
                    msum[j][b] += r[j] * x[b] as f64;
                }
            }
            resp_all.push(r);
        }
        let mut next = Vec::with_capacity(kk);
        for j in 0..kk {
            if wsum[j] < 1e-9 {
                continue;
            }
            let m: Vec<f64> = msum[j].iter().map(|v| v / wsum[j]).collect();
            let mut s = Sym::zeros(nb);
            for (q, &p) in train.iter().enumerate() {
                let x = c.px(p);
                let r = resp_all[q][j];
                for a in 0..nb {
                    let da = x[a] as f64 - m[a];
                    for b in 0..=a {
                        s.a[a * nb + b] += r * da * (x[b] as f64 - m[b]);
                    }
                }
            }
            for a in 0..nb {
                for b in 0..=a {
                    let v = s.a[a * nb + b] / wsum[j];
                    s.a[a * nb + b] = v;
                    s.a[b * nb + a] = v;
                }
            }
            next.push((wsum[j] / train.len() as f64, m, s));
        }
        comps = next;
    }
    let invs: Vec<(Sym, f64)> = comps.iter().map(|(_, _, s)| inverse_logdet(s, 1e-6).unwrap_or_else(|| (Sym::zeros(nb), 0.0))).collect();
    (0..c.n())
        .map(|p| {
            if !c.valid(p) {
                return f32::NAN;
            }
            let x = c.px(p);
            let l: Vec<f64> = comps.iter().zip(&invs).map(|(cm, iv)| cm.0.max(1e-12).ln() + lp(x, &cm.1, &iv.0, iv.1)).collect();
            let mx = l.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            (-(mx + l.iter().map(|v| (v - mx).exp()).sum::<f64>().ln())) as f32
        })
        .collect()
}
