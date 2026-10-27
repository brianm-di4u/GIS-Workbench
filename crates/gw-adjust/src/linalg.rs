//! Small dense linear algebra for the normal equations: row-major symmetric matrices,
//! Cholesky factorisation, solve and inverse.

/// Row-major square matrix of size n.
#[derive(Clone, Debug)]
pub struct Mat {
    pub n: usize,
    pub a: Vec<f64>,
}

impl Mat {
    pub fn zeros(n: usize) -> Self {
        Self { n, a: vec![0.0; n * n] }
    }
    #[inline]
    pub fn at(&self, i: usize, j: usize) -> f64 {
        self.a[i * self.n + j]
    }
    #[inline]
    pub fn add(&mut self, i: usize, j: usize, v: f64) {
        self.a[i * self.n + j] += v;
    }
    #[inline]
    pub fn set(&mut self, i: usize, j: usize, v: f64) {
        self.a[i * self.n + j] = v;
    }
}

/// Lower-triangular Cholesky factor of a symmetric positive-definite matrix, or None.
pub fn cholesky(m: &Mat) -> Option<Mat> {
    let n = m.n;
    let mut l = Mat::zeros(n);
    let scale = (0..n).map(|i| m.at(i, i).abs()).fold(0.0_f64, f64::max).max(1e-300);
    for j in 0..n {
        let mut d = m.at(j, j);
        for k in 0..j {
            d -= l.at(j, k) * l.at(j, k);
        }
        if !(d > 1e-13 * scale) {
            return None;
        }
        let d = d.sqrt();
        l.set(j, j, d);
        for i in j + 1..n {
            let mut s = m.at(i, j);
            for k in 0..j {
                s -= l.at(i, k) * l.at(j, k);
            }
            l.set(i, j, s / d);
        }
    }
    Some(l)
}

/// Solve L·Lᵀ·x = b with the Cholesky factor.
pub fn chol_solve(l: &Mat, b: &[f64]) -> Vec<f64> {
    let n = l.n;
    let mut y = b.to_vec();
    for i in 0..n {
        let mut s = y[i];
        for k in 0..i {
            s -= l.at(i, k) * y[k];
        }
        y[i] = s / l.at(i, i);
    }
    for i in (0..n).rev() {
        let mut s = y[i];
        for k in i + 1..n {
            s -= l.at(k, i) * y[k];
        }
        y[i] = s / l.at(i, i);
    }
    y
}

/// Inverse from the Cholesky factor.
pub fn chol_inverse(l: &Mat) -> Mat {
    let n = l.n;
    let mut inv = Mat::zeros(n);
    let mut e = vec![0.0; n];
    for j in 0..n {
        e.iter_mut().for_each(|v| *v = 0.0);
        e[j] = 1.0;
        let x = chol_solve(l, &e);
        for i in 0..n {
            inv.set(i, j, x[i]);
        }
    }
    inv
}

/// Solve a general square system by Gaussian elimination with partial pivoting.
pub fn solve_general(m: &Mat, b: &[f64]) -> Option<Vec<f64>> {
    let n = m.n;
    let mut a = m.a.clone();
    let mut x = b.to_vec();
    for c in 0..n {
        let p = (c..n).max_by(|&i, &j| a[i * n + c].abs().total_cmp(&a[j * n + c].abs()))?;
        if a[p * n + c].abs() < 1e-300 {
            return None;
        }
        if p != c {
            for k in 0..n {
                a.swap(p * n + k, c * n + k);
            }
            x.swap(p, c);
        }
        let piv = a[c * n + c];
        for r in c + 1..n {
            let f = a[r * n + c] / piv;
            if f == 0.0 {
                continue;
            }
            for k in c..n {
                a[r * n + k] -= f * a[c * n + k];
            }
            x[r] -= f * x[c];
        }
    }
    for c in (0..n).rev() {
        let mut s = x[c];
        for k in c + 1..n {
            s -= a[c * n + k] * x[k];
        }
        x[c] = s / a[c * n + c];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cholesky_solves_and_inverts() {
        let mut m = Mat::zeros(3);
        let v = [[4.0, 2.0, 0.6], [2.0, 5.0, 1.0], [0.6, 1.0, 3.0]];
        for i in 0..3 {
            for j in 0..3 {
                m.set(i, j, v[i][j]);
            }
        }
        let l = cholesky(&m).unwrap();
        let x = chol_solve(&l, &[1.0, 2.0, 3.0]);
        for i in 0..3 {
            let r: f64 = (0..3).map(|j| v[i][j] * x[j]).sum();
            assert!((r - [1.0, 2.0, 3.0][i]).abs() < 1e-12);
        }
        let inv = chol_inverse(&l);
        for i in 0..3 {
            for j in 0..3 {
                let p: f64 = (0..3).map(|k| v[i][k] * inv.at(k, j)).sum();
                assert!((p - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
            }
        }
        let g = solve_general(&m, &[1.0, 2.0, 3.0]).unwrap();
        assert!(g.iter().zip(&x).all(|(a, b)| (a - b).abs() < 1e-12));
    }
}
