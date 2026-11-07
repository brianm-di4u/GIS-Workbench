//! Small 3-D geometry for the aerial triangulation (REQ-GAP-22): 3 × 3 matrices, the rotation
//! exponential, a symmetric eigen-solver (Jacobi) and orthonormalisation.

pub type M3 = [[f64; 3]; 3];
pub type V3 = [f64; 3];

pub const I3: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

pub fn mul(a: &M3, b: &M3) -> M3 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}
pub fn tr(a: &M3) -> M3 {
    [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]]
}
pub fn mv(a: &M3, v: V3) -> V3 {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}
pub fn mtv(a: &M3, v: V3) -> V3 {
    [0, 1, 2].map(|i| a[0][i] * v[0] + a[1][i] * v[1] + a[2][i] * v[2])
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
/// [v]×: skew(v)·w = v × w.
pub fn skew(v: V3) -> M3 {
    [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]]
}
/// exp([w]×) (Rodrigues).
pub fn expm(w: V3) -> M3 {
    let t = norm(w);
    let k = skew(w);
    let k2 = mul(&k, &k);
    let (a, b) = if t < 1e-8 { (1.0 - t * t / 6.0, 0.5 - t * t / 24.0) } else { (t.sin() / t, (1.0 - t.cos()) / (t * t)) };
    let mut o = I3;
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] += a * k[i][j] + b * k2[i][j];
        }
    }
    o
}
/// The rotation vector of a rotation matrix (inverse of `expm`).
pub fn logm(r: &M3) -> V3 {
    let c = ((r[0][0] + r[1][1] + r[2][2] - 1.0) / 2.0).clamp(-1.0, 1.0);
    let t = c.acos();
    let v = [r[2][1] - r[1][2], r[0][2] - r[2][0], r[1][0] - r[0][1]];
    if t < 1e-7 {
        return scale(v, 0.5);
    }
    if t > std::f64::consts::PI - 1e-6 {
        // Near π: the axis from the largest diagonal.
        let i = (0..3).max_by(|&a, &b| r[a][a].total_cmp(&r[b][b])).unwrap_or(0);
        let mut ax = [0.0; 3];
        ax[i] = ((r[i][i] + 1.0) / 2.0).max(0.0).sqrt();
        for j in 0..3 {
            if j != i {
                ax[j] = (r[i][j] + r[j][i]) / (4.0 * ax[i].max(1e-300));
            }
        }
        let n = norm(ax).max(1e-300);
        return scale(ax, t / n);
    }
    scale(v, t / (2.0 * t.sin()))
}
pub fn det(a: &M3) -> f64 {
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
}
pub fn inv(a: &M3) -> Option<M3> {
    gw_sensor::intersect::inv3(a)
}
/// The nearest rotation (polar decomposition by Newton iteration); None for a singular matrix.
pub fn orthonormalise(a: &M3) -> Option<M3> {
    let mut r = *a;
    let d = det(&r);
    if !(d.abs() > 1e-300) || !d.is_finite() {
        return None;
    }
    for _ in 0..30 {
        let it = tr(&inv(&r)?);
        let mut n = [[0.0; 3]; 3];
        let mut ch = 0.0_f64;
        for i in 0..3 {
            for j in 0..3 {
                n[i][j] = 0.5 * (r[i][j] + it[i][j]);
                ch = ch.max((n[i][j] - r[i][j]).abs());
            }
        }
        r = n;
        if ch < 1e-15 {
            break;
        }
    }
    Some(r)
}
/// Eigen-decomposition of a symmetric 3 × 3 matrix (cyclic Jacobi): eigenvalues ascending and
/// the matching unit eigenvectors (as rows).
pub fn sym_eigen(a: &M3) -> ([f64; 3], M3) {
    let mut m = *a;
    let mut v = I3;
    for _ in 0..60 {
        let off = m[0][1].abs() + m[0][2].abs() + m[1][2].abs();
        if off < 1e-300 {
            break;
        }
        for (p, q) in [(0, 1), (0, 2), (1, 2)] {
            if m[p][q].abs() < 1e-300 {
                continue;
            }
            let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
            let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
            let t = if theta == 0.0 { 1.0 } else { t };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            let mut j = I3;
            j[p][p] = c;
            j[q][q] = c;
            j[p][q] = s;
            j[q][p] = -s;
            m = mul(&tr(&j), &mul(&m, &j));
            v = mul(&v, &j);
        }
    }
    let mut idx = [0usize, 1, 2];
    for i in 1..3 {
        let mut j = i;
        while j > 0 && m[idx[j - 1]][idx[j - 1]] > m[idx[j]][idx[j]] {
            idx.swap(j - 1, j);
            j -= 1;
        }
    }
    let vals = idx.map(|i| m[i][i]);
    let vecs = idx.map(|i| [v[0][i], v[1][i], v[2][i]]);
    (vals, vecs)
}

/// Indices of `keys` in ascending order (heap sort; NaN last). One non-generic sort for the
/// whole crate: each `sort_by` call site would instantiate the standard sorts (wasm size).
#[inline(never)]
pub fn order(keys: &[f64]) -> Vec<usize> {
    let k = |i: usize| if keys[i].is_nan() { f64::INFINITY } else { keys[i] };
    let mut v: Vec<usize> = (0..keys.len()).collect();
    let n = v.len();
    let sift = |v: &mut [usize], mut root: usize, end: usize| loop {
        let mut c = 2 * root + 1;
        if c >= end {
            break;
        }
        if c + 1 < end && k(v[c + 1]) > k(v[c]) {
            c += 1;
        }
        if k(v[root]) >= k(v[c]) {
            break;
        }
        v.swap(root, c);
        root = c;
    };
    for s in (0..n / 2).rev() {
        sift(&mut v, s, n);
    }
    for end in (1..n).rev() {
        v.swap(0, end);
        sift(&mut v, 0, end);
    }
    v
}

/// ω, φ, κ (degrees) of an ENU → camera rotation in the convention of
/// `gw_sensor::frame::rotation` (R = R_κ R_φ R_ω).
pub fn opk_of(r: &M3) -> V3 {
    // R = R_κ R_φ R_ω with frame::rotation's matrices: R[2] = (sin φ, −cos φ sin ω, cos φ cos ω),
    // R[0][0] = cos κ cos φ, R[1][0] = −sin κ cos φ.
    let phi = r[2][0].clamp(-1.0, 1.0).asin();
    let omega = (-r[2][1]).atan2(r[2][2]);
    let kappa = (-r[1][0]).atan2(r[0][0]);
    [omega.to_degrees(), phi.to_degrees(), kappa.to_degrees()]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rotation_helpers() {
        let w = [0.3, -0.2, 0.5];
        let r = expm(w);
        let back = logm(&r);
        assert!(norm(sub(back, w)) < 1e-12);
        assert!((det(&r) - 1.0).abs() < 1e-12);
        let q = gw_sensor::frame::rotation(12.0, -7.0, 135.0);
        let o = opk_of(&q);
        assert!((o[0] - 12.0).abs() < 1e-9 && (o[1] + 7.0).abs() < 1e-9 && (o[2] - 135.0).abs() < 1e-9, "{o:?}");
        let mut noisy = r;
        noisy[0][1] += 1e-3;
        let o = orthonormalise(&noisy).unwrap();
        assert!((det(&o) - 1.0).abs() < 1e-12);
        let a = [[4.0, 1.0, 0.5], [1.0, 3.0, 0.2], [0.5, 0.2, 1.0]];
        let (vals, vecs) = sym_eigen(&a);
        for k in 0..3 {
            let av = mv(&a, vecs[k]);
            assert!(norm(sub(av, scale(vecs[k], vals[k]))) < 1e-10);
        }
        assert!(vals[0] <= vals[1] && vals[1] <= vals[2]);
    }
}
