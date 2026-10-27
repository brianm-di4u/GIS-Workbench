//! PCA, MNF, decorrelation stretch, FastICA and fully constrained unmixing (REQ-MSI-12,
//! `Research/10` §9). MNF whitens by the noise covariance from horizontal shift differences
//! (x(i, j) − x(i, j+1))/√2, then runs PCA, so components are ordered by SNR.

use crate::linalg::{cholesky, eigen, Sym};
use crate::stats::{mean_cov, Cube};

pub struct Components {
    pub mean: Vec<f64>,
    /// Row k: the k-th component's coefficients over the bands.
    pub vectors: Vec<f64>,
    pub values: Vec<f64>,
}

pub fn pca(c: &Cube, step: usize) -> Components {
    let (m, s, _) = mean_cov(c, None, step);
    let (values, vectors) = eigen(&s);
    Components { mean: m, vectors, values }
}

/// Noise covariance from shift differences.
fn noise_cov(c: &Cube, step: usize) -> Sym {
    let nb = c.nb;
    let mut s = Sym::zeros(nb);
    let mut n = 0.0f64;
    let mut d = vec![0.0; nb];
    for p in (0..c.n()).step_by(step.max(1)) {
        if p % c.w + 1 >= c.w || !c.valid(p) || !c.valid(p + 1) {
            continue;
        }
        for b in 0..nb {
            d[b] = (c.v[p * nb + b] as f64 - c.v[(p + 1) * nb + b] as f64) / std::f64::consts::SQRT_2;
        }
        for i in 0..nb {
            for j in 0..=i {
                s.a[i * nb + j] += d[i] * d[j];
            }
        }
        n += 1.0;
    }
    for i in 0..nb {
        for j in 0..=i {
            let v = s.a[i * nb + j] / n.max(1.0);
            s.a[i * nb + j] = v;
            s.a[j * nb + i] = v;
        }
    }
    s
}

/// MNF: whiten by Σ_N^{-1/2} (Cholesky), PCA of the whitened data; vectors map raw bands to
/// components directly. Eigenvalues are SNR + 1 (noise-whitened variances).
pub fn mnf(c: &Cube, step: usize) -> Components {
    let nb = c.nb;
    let (m, s, _) = mean_cov(c, None, step);
    let sn = noise_cov(c, step);
    let l = cholesky(&sn, 1e-9).unwrap_or_else(|| {
        let mut id = vec![0.0; nb * nb];
        for i in 0..nb {
            id[i * nb + i] = 1.0;
        }
        id
    });
    // W = L⁻¹ (whitening); Σ_w = W Σ Wᵀ.
    let mut li = vec![0.0; nb * nb];
    for col in 0..nb {
        for i in 0..nb {
            let mut v = if i == col { 1.0 } else { 0.0 };
            for k in 0..i {
                v -= l[i * nb + k] * li[k * nb + col];
            }
            li[i * nb + col] = v / l[i * nb + i];
        }
    }
    let mut ws = Sym::zeros(nb);
    for i in 0..nb {
        for j in 0..nb {
            let mut v = 0.0;
            for a in 0..nb {
                for b in 0..nb {
                    v += li[i * nb + a] * s.a[a * nb + b] * li[j * nb + b];
                }
            }
            ws.a[i * nb + j] = v;
        }
    }
    let (values, ev) = eigen(&ws);
    // Component k of raw x: e_kᵀ W (x − μ) → coefficients (e_kᵀ W).
    let mut vectors = vec![0.0; nb * nb];
    for k in 0..nb {
        for b in 0..nb {
            vectors[k * nb + b] = (0..nb).map(|i| ev[k * nb + i] * li[i * nb + b]).sum();
        }
    }
    Components { mean: m, vectors, values }
}

/// Project onto the first `k` components → BIP f32 with k bands.
pub fn project(c: &Cube, t: &Components, k: usize) -> Vec<f32> {
    let nb = c.nb;
    let k = k.min(nb).max(1);
    let mut out = vec![f32::NAN; c.n() * k];
    for p in 0..c.n() {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        for q in 0..k {
            let mut v = 0.0;
            for b in 0..nb {
                v += t.vectors[q * nb + b] * (x[b] as f64 - t.mean[b]);
            }
            out[p * k + q] = v as f32;
        }
    }
    out
}

/// Decorrelation stretch of three bands: PCA, equalise the component variances, rotate back;
/// output keeps the input means and the mean σ.
pub fn decorrelation(c: &Cube) -> Vec<f32> {
    let t = pca(c, 4);
    let nb = c.nb;
    let target = (t.values.iter().map(|v| v.max(0.0)).sum::<f64>() / nb as f64).sqrt();
    let mut out = vec![f32::NAN; c.n() * nb];
    for p in 0..c.n() {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        let pc: Vec<f64> = (0..nb).map(|q| (0..nb).map(|b| t.vectors[q * nb + b] * (x[b] as f64 - t.mean[b])).sum::<f64>() * target / t.values[q].max(1e-12).sqrt()).collect();
        for b in 0..nb {
            out[p * nb + b] = (t.mean[b] + (0..nb).map(|q| t.vectors[q * nb + b] * pc[q]).sum::<f64>()) as f32;
        }
    }
    out
}

/// FastICA (deflation, tanh contrast) on PCA-whitened data: `k` independent components.
pub fn ica(c: &Cube, k: usize, iters: usize, step: usize) -> Vec<f32> {
    let nb = c.nb;
    let t = pca(c, step);
    let k = k.min(nb).max(1);
    let train: Vec<usize> = (0..c.n()).step_by(step.max(1)).filter(|&p| c.valid(p)).collect();
    let white = |x: &[f32]| -> Vec<f64> { (0..nb).map(|q| (0..nb).map(|b| t.vectors[q * nb + b] * (x[b] as f64 - t.mean[b])).sum::<f64>() / t.values[q].max(1e-12).sqrt()).collect() };
    let z: Vec<Vec<f64>> = train.iter().map(|&p| white(c.px(p))).collect();
    let mut ws: Vec<Vec<f64>> = Vec::new();
    for comp in 0..k {
        let mut w: Vec<f64> = (0..nb).map(|i| if i == comp { 1.0 } else { 0.1 }).collect();
        for _ in 0..iters.max(1) {
            let mut nw = vec![0.0; nb];
            let mut gd = 0.0;
            for zi in &z {
                let u: f64 = w.iter().zip(zi).map(|(a, b)| a * b).sum();
                let g = u.tanh();
                gd += 1.0 - g * g;
                for b in 0..nb {
                    nw[b] += zi[b] * g;
                }
            }
            let n = z.len().max(1) as f64;
            for b in 0..nb {
                nw[b] = nw[b] / n - gd / n * w[b];
            }
            for prev in &ws {
                let d: f64 = nw.iter().zip(prev).map(|(a, b)| a * b).sum();
                for b in 0..nb {
                    nw[b] -= d * prev[b];
                }
            }
            let norm = nw.iter().map(|v| v * v).sum::<f64>().sqrt().max(1e-30);
            nw.iter_mut().for_each(|v| *v /= norm);
            let conv = (nw.iter().zip(&w).map(|(a, b)| a * b).sum::<f64>().abs() - 1.0).abs();
            w = nw;
            if conv < 1e-6 {
                break;
            }
        }
        ws.push(w);
    }
    let mut out = vec![f32::NAN; c.n() * k];
    for p in 0..c.n() {
        if !c.valid(p) {
            continue;
        }
        let zi = white(c.px(p));
        for (q, w) in ws.iter().enumerate() {
            out[p * k + q] = w.iter().zip(&zi).map(|(a, b)| a * b).sum::<f64>() as f32;
        }
    }
    out
}

/// Fully constrained linear unmixing (abundances ≥ 0, Σ = 1) by projected gradient on the
/// normal equations. `e` = endmembers, m × nb row-major. Output: m abundances per pixel and the
/// RMS residual, BIP (m + 1 bands).
pub fn unmix(c: &Cube, e: &[f64], m: usize) -> Vec<f32> {
    let nb = c.nb;
    let mut g = Sym::zeros(m);
    for i in 0..m {
        for j in 0..m {
            g.a[i * m + j] = (0..nb).map(|b| e[i * nb + b] * e[j * nb + b]).sum();
        }
    }
    let lmax = crate::linalg::eigen(&g).0.first().copied().unwrap_or(1.0).max(1e-12);
    let step = 1.0 / lmax;
    let mut out = vec![f32::NAN; c.n() * (m + 1)];
    for p in 0..c.n() {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        let ex: Vec<f64> = (0..m).map(|i| (0..nb).map(|b| e[i * nb + b] * x[b] as f64).sum()).collect();
        let mut a = vec![1.0 / m as f64; m];
        for _ in 0..200 {
            let grad: Vec<f64> = (0..m).map(|i| (0..m).map(|j| g.a[i * m + j] * a[j]).sum::<f64>() - ex[i]).collect();
            let mut y: Vec<f64> = a.iter().zip(&grad).map(|(ai, gi)| ai - step * gi).collect();
            // Project onto the simplex (Duchi et al. 2008).
            let mut u = y.clone();
            u.sort_by(|p, q| q.partial_cmp(p).unwrap());
            let (mut css, mut theta) = (0.0, 0.0);
            for (i, &ui) in u.iter().enumerate() {
                css += ui;
                let t = (css - 1.0) / (i + 1) as f64;
                if ui - t > 0.0 {
                    theta = t;
                }
            }
            y.iter_mut().for_each(|v| *v = (*v - theta).max(0.0));
            let d: f64 = y.iter().zip(&a).map(|(p, q)| (p - q).abs()).sum();
            a = y;
            if d < 1e-7 {
                break;
            }
        }
        let mut r2 = 0.0;
        for b in 0..nb {
            let model: f64 = (0..m).map(|i| a[i] * e[i * nb + b]).sum();
            r2 += (x[b] as f64 - model).powi(2);
        }
        for i in 0..m {
            out[p * (m + 1) + i] = a[i] as f32;
        }
        out[p * (m + 1) + m] = (r2 / nb as f64).sqrt() as f32;
    }
    out
}
