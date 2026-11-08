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
    // As two products, O(nb³): with 425 bands the single quadruple loop took minutes.
    let mut ls = vec![0.0; nb * nb];
    for i in 0..nb {
        for b in 0..nb {
            ls[i * nb + b] = (0..nb).map(|a| li[i * nb + a] * s.a[a * nb + b]).sum();
        }
    }
    let mut ws = Sym::zeros(nb);
    for i in 0..nb {
        for j in 0..nb {
            ws.a[i * nb + j] = (0..nb).map(|b| ls[i * nb + b] * li[j * nb + b]).sum();
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

/// Fully constrained linear unmixing (abundances ≥ 0, Σ = 1): least squares on the simplex, solved
/// exactly per pixel by a primal active-set method on the normal equations (the KKT system of the
/// free abundances under the sum-to-one constraint). `e` = endmembers, m × nb row-major. Output: m
/// abundances per pixel and the RMS residual, BIP (m + 1 bands). Similar endmembers make the problem
/// ill-conditioned: the projected gradient used before stalled far from the optimum (abundance RMSE
/// 0.08 with exact endmembers, REQ-GAP-82).
pub fn unmix(c: &Cube, e: &[f64], m: usize) -> Vec<f32> {
    let nb = c.nb;
    let mut g = Sym::zeros(m);
    for i in 0..m {
        for j in 0..m {
            g.a[i * m + j] = (0..nb).map(|b| e[i * nb + b] * e[j * nb + b]).sum();
        }
    }
    // A tiny ridge keeps the free blocks positive definite when two endmembers coincide.
    let ridge = 1e-12 * (0..m).map(|i| g.a[i * m + i]).fold(0.0, f64::max).max(1e-300);
    let mut out = vec![f32::NAN; c.n() * (m + 1)];
    for p in 0..c.n() {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        let ex: Vec<f64> = (0..m).map(|i| (0..nb).map(|b| e[i * nb + b] * x[b] as f64).sum()).collect();
        let a = simplex_ls(&g, &ex, m, ridge);
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

/// Minimise ½ aᵀGa − bᵀa over the simplex (a ≥ 0, Σ a = 1) by a primal active-set method. Starts
/// at the best single endmember; on the free set F solves G_FF s = b_F − λ1 with 1ᵀs = 1; steps back
/// to the boundary when s leaves the simplex, and frees the bound abundance with the most negative
/// multiplier μ_j = (Ga − b)_j + λ until none is negative.
fn simplex_ls(g: &Sym, b: &[f64], m: usize, ridge: f64) -> Vec<f64> {
    let gat = |i: usize, j: usize| g.a[i * m + j] + if i == j { ridge } else { 0.0 };
    let obj = |k: usize| 0.5 * gat(k, k) - b[k];
    let k0 = (0..m).min_by(|&i, &j| obj(i).partial_cmp(&obj(j)).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
    let mut a = vec![0.0; m];
    a[k0] = 1.0;
    let mut free = vec![false; m];
    free[k0] = true;
    for _ in 0..(4 * m + 20) {
        // Solve on the free set.
        let f: Vec<usize> = (0..m).filter(|&i| free[i]).collect();
        let n = f.len();
        let mut sym = Sym::zeros(n);
        for (r, &i) in f.iter().enumerate() {
            for (q, &j) in f.iter().enumerate() {
                sym.a[r * n + q] = gat(i, j);
            }
        }
        let Some(l) = crate::linalg::cholesky(&sym, 0.0) else { break };
        let solve = |rhs: &[f64]| -> Vec<f64> {
            let mut y = vec![0.0; n];
            for i in 0..n {
                y[i] = (rhs[i] - (0..i).map(|k| l[i * n + k] * y[k]).sum::<f64>()) / l[i * n + i];
            }
            for i in (0..n).rev() {
                y[i] = (y[i] - (i + 1..n).map(|k| l[k * n + i] * y[k]).sum::<f64>()) / l[i * n + i];
            }
            y
        };
        let u = solve(&f.iter().map(|&i| b[i]).collect::<Vec<_>>());
        let v = solve(&vec![1.0; n]);
        let (su, sv): (f64, f64) = (u.iter().sum(), v.iter().sum());
        let lambda = (su - 1.0) / sv;
        let sol: Vec<f64> = u.iter().zip(&v).map(|(ui, vi)| ui - lambda * vi).collect();
        if sol.iter().all(|&x| x > 0.0) {
            for (r, &i) in f.iter().enumerate() {
                a[i] = sol[r];
            }
            // Optimal unless a bound abundance has a negative multiplier.
            let mut worst = (usize::MAX, -1e-12);
            for j in (0..m).filter(|&j| !free[j]) {
                let mu = (0..m).map(|k| gat(j, k) * a[k]).sum::<f64>() - b[j] + lambda;
                if mu < worst.1 {
                    worst = (j, mu);
                }
            }
            if worst.0 == usize::MAX {
                break;
            }
            free[worst.0] = true;
        } else {
            // Step from a towards sol until the first free abundance reaches zero, and bind it.
            let mut t = 1.0f64;
            let mut hit = usize::MAX;
            for (r, &i) in f.iter().enumerate() {
                if sol[r] <= 0.0 && a[i] - sol[r] > 0.0 {
                    let ti = a[i] / (a[i] - sol[r]);
                    if ti < t {
                        t = ti;
                        hit = i;
                    }
                }
            }
            for (r, &i) in f.iter().enumerate() {
                a[i] += t * (sol[r] - a[i]);
            }
            for &i in &f {
                if i == hit || a[i] <= 1e-15 {
                    a[i] = 0.0;
                    free[i] = false;
                }
            }
        }
    }
    let s: f64 = a.iter().sum();
    if s > 0.0 {
        a.iter_mut().for_each(|x| *x /= s);
    }
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Noise-free mixtures of three overlapping endmembers, some abundances zero: the active-set
    /// solver returns them exactly, with no residual.
    #[test]
    fn unmix_is_exact_on_the_simplex() {
        let nb = 12;
        let e: Vec<f64> = (0..3).flat_map(|i| (0..nb).map(move |b| 0.4 + 0.1 * ((b as f64 * 0.3 + i as f64).sin()) + 0.02 * i as f64)).collect();
        let truth = [[0.2, 0.5, 0.3], [0.0, 1.0, 0.0], [0.7, 0.0, 0.3], [1.0 / 3.0; 3]];
        let mut v = vec![0f32; truth.len() * nb];
        for (p, a) in truth.iter().enumerate() {
            for b in 0..nb {
                v[p * nb + b] = (0..3).map(|i| a[i] * e[i * nb + b]).sum::<f64>() as f32;
            }
        }
        let c = Cube { v: &v, nb, w: truth.len(), h: 1 };
        let out = unmix(&c, &e, 3);
        for (p, a) in truth.iter().enumerate() {
            for i in 0..3 {
                assert!((out[p * 4 + i] as f64 - a[i]).abs() < 2e-4, "pixel {p} abundance {i}: {} vs {}", out[p * 4 + i], a[i]);
            }
            assert!(out[p * 4 + 3] < 1e-5);
        }
    }
}
