//! Small dense linear algebra for spectral statistics: symmetric matrices stored row-major
//! (n × n, f64). Cholesky with a ridge, inverse and log-determinant from it, and the cyclic
//! Jacobi eigen-decomposition (eigenvalues descending, eigenvectors as rows).

pub struct Sym {
    pub n: usize,
    pub a: Vec<f64>,
}

impl Sym {
    pub fn zeros(n: usize) -> Sym {
        Sym { n, a: vec![0.0; n * n] }
    }
    pub fn at(&self, i: usize, j: usize) -> f64 {
        self.a[i * self.n + j]
    }
}

/// Cholesky L (lower, row-major) of a + ridge·trace/n·I; None if not positive definite.
pub fn cholesky(s: &Sym, ridge: f64) -> Option<Vec<f64>> {
    let n = s.n;
    let tr: f64 = (0..n).map(|i| s.at(i, i)).sum::<f64>() / n.max(1) as f64;
    let mut l = vec![0.0; n * n];
    for i in 0..n {
        for j in 0..=i {
            let mut v = s.at(i, j) + if i == j { ridge * tr.max(1e-30) } else { 0.0 };
            for k in 0..j {
                v -= l[i * n + k] * l[j * n + k];
            }
            if i == j {
                if !(v > 0.0) {
                    return None;
                }
                l[i * n + i] = v.sqrt();
            } else {
                l[i * n + j] = v / l[j * n + j];
            }
        }
    }
    Some(l)
}

/// Inverse and log-determinant of a symmetric positive definite matrix (with a small ridge).
pub fn inverse_logdet(s: &Sym, ridge: f64) -> Option<(Sym, f64)> {
    let n = s.n;
    let l = cholesky(s, ridge)?;
    let logdet = 2.0 * (0..n).map(|i| l[i * n + i].ln()).sum::<f64>();
    // L⁻¹ by forward substitution, then A⁻¹ = L⁻ᵀ L⁻¹.
    let mut li = vec![0.0; n * n];
    for c in 0..n {
        for i in 0..n {
            let mut v = if i == c { 1.0 } else { 0.0 };
            for k in 0..i {
                v -= l[i * n + k] * li[k * n + c];
            }
            li[i * n + c] = v / l[i * n + i];
        }
    }
    let mut inv = Sym::zeros(n);
    for i in 0..n {
        for j in 0..=i {
            let mut v = 0.0;
            for k in i.max(j)..n {
                v += li[k * n + i] * li[k * n + j];
            }
            inv.a[i * n + j] = v;
            inv.a[j * n + i] = v;
        }
    }
    Some((inv, logdet))
}

/// Quadratic form dᵀ M d.
pub fn quad(m: &Sym, d: &[f64]) -> f64 {
    let n = m.n;
    let mut s = 0.0;
    for i in 0..n {
        let mut r = 0.0;
        for j in 0..n {
            r += m.a[i * n + j] * d[j];
        }
        s += d[i] * r;
    }
    s
}

/// Cyclic Jacobi: (eigenvalues descending, eigenvectors row-major: row k is vector k).
pub fn eigen(s: &Sym) -> (Vec<f64>, Vec<f64>) {
    let n = s.n;
    let mut a = s.a.clone();
    let mut v = vec![0.0; n * n];
    for i in 0..n {
        v[i * n + i] = 1.0;
    }
    for _sweep in 0..60 {
        let mut off = 0.0;
        for i in 0..n {
            for j in i + 1..n {
                off += a[i * n + j] * a[i * n + j];
            }
        }
        let scale: f64 = (0..n).map(|i| a[i * n + i] * a[i * n + i]).sum::<f64>().max(1e-300);
        if off <= 1e-22 * scale {
            break;
        }
        for p in 0..n {
            for q in p + 1..n {
                let apq = a[p * n + q];
                if apq.abs() < 1e-300 {
                    continue;
                }
                let theta = (a[q * n + q] - a[p * n + p]) / (2.0 * apq);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let sn = t * c;
                for k in 0..n {
                    let (akp, akq) = (a[k * n + p], a[k * n + q]);
                    a[k * n + p] = c * akp - sn * akq;
                    a[k * n + q] = sn * akp + c * akq;
                }
                for k in 0..n {
                    let (apk, aqk) = (a[p * n + k], a[q * n + k]);
                    a[p * n + k] = c * apk - sn * aqk;
                    a[q * n + k] = sn * apk + c * aqk;
                }
                for k in 0..n {
                    let (vkp, vkq) = (v[k * n + p], v[k * n + q]);
                    v[k * n + p] = c * vkp - sn * vkq;
                    v[k * n + q] = sn * vkp + c * vkq;
                }
            }
        }
    }
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&i, &j| a[j * n + j].partial_cmp(&a[i * n + i]).unwrap_or(std::cmp::Ordering::Equal));
    let vals: Vec<f64> = idx.iter().map(|&i| a[i * n + i]).collect();
    let mut vecs = vec![0.0; n * n];
    for (r, &i) in idx.iter().enumerate() {
        for k in 0..n {
            vecs[r * n + k] = v[k * n + i];
        }
    }
    (vals, vecs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inverse_and_eigen() {
        let s = Sym { n: 3, a: vec![4.0, 1.0, 0.5, 1.0, 3.0, 0.2, 0.5, 0.2, 2.0] };
        let (inv, ld) = inverse_logdet(&s, 0.0).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                let v: f64 = (0..3).map(|k| s.at(i, k) * inv.at(k, j)).sum();
                assert!((v - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
        let det = 4.0 * (3.0 * 2.0 - 0.04) - 1.0 * (2.0 - 0.1) + 0.5 * (0.2 - 1.5);
        assert!((ld - f64::ln(det)).abs() < 1e-12);
        let (vals, vecs) = eigen(&s);
        assert!(vals[0] >= vals[1] && vals[1] >= vals[2]);
        for k in 0..3 {
            let v = &vecs[k * 3..k * 3 + 3];
            for i in 0..3 {
                let av: f64 = (0..3).map(|j| s.at(i, j) * v[j]).sum();
                assert!((av - vals[k] * v[i]).abs() < 1e-9);
            }
        }
    }
}
