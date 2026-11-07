//! Geodesy and the similarity fit: UTM on WGS 84 (Krüger series, order 6) and a robust
//! seven-parameter fit of the model's camera centres to their GPS positions.

const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_223_563;
const K0: f64 = 0.9996;

fn series() -> (f64, [f64; 6], [f64; 6]) {
    let n = F / (2.0 - F);
    let (n2, n3, n4, n5, n6) = (n * n, n.powi(3), n.powi(4), n.powi(5), n.powi(6));
    let r = A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0);
    let alpha = [
        n / 2.0 - 2.0 / 3.0 * n2 + 5.0 / 16.0 * n3 + 41.0 / 180.0 * n4 - 127.0 / 288.0 * n5 + 7891.0 / 37800.0 * n6,
        13.0 / 48.0 * n2 - 3.0 / 5.0 * n3 + 557.0 / 1440.0 * n4 + 281.0 / 630.0 * n5 - 1983433.0 / 1935360.0 * n6,
        61.0 / 240.0 * n3 - 103.0 / 140.0 * n4 + 15061.0 / 26880.0 * n5 + 167603.0 / 181440.0 * n6,
        49561.0 / 161280.0 * n4 - 179.0 / 168.0 * n5 + 6601661.0 / 7257600.0 * n6,
        34729.0 / 80640.0 * n5 - 3418889.0 / 1995840.0 * n6,
        212378941.0 / 319334400.0 * n6,
    ];
    let beta = [
        n / 2.0 - 2.0 / 3.0 * n2 + 37.0 / 96.0 * n3 - n4 / 360.0 - 81.0 / 512.0 * n5 + 96199.0 / 604800.0 * n6,
        n2 / 48.0 + n3 / 15.0 - 437.0 / 1440.0 * n4 + 46.0 / 105.0 * n5 - 1118711.0 / 3870720.0 * n6,
        17.0 / 480.0 * n3 - 37.0 / 840.0 * n4 - 209.0 / 4480.0 * n5 + 5569.0 / 90720.0 * n6,
        4397.0 / 161280.0 * n4 - 11.0 / 504.0 * n5 - 830251.0 / 7257600.0 * n6,
        4583.0 / 161280.0 * n5 - 108847.0 / 3991680.0 * n6,
        20648693.0 / 638668800.0 * n6,
    ];
    (r, alpha, beta)
}

pub fn utm_zone(lon: f64) -> u32 {
    (((lon + 180.0) / 6.0).floor() as i64).rem_euclid(60) as u32 + 1
}

fn central_meridian(zone: u32) -> f64 {
    (zone as f64 * 6.0 - 183.0).to_radians()
}

/// (easting, northing) in `zone`; the southern hemisphere takes the 10 000 km false northing.
pub fn utm_forward(lat: f64, lon: f64, zone: u32) -> (f64, f64) {
    let (r, alpha, _) = series();
    let e = (F * (2.0 - F)).sqrt();
    let (phi, lam) = (lat.to_radians(), lon.to_radians() - central_meridian(zone));
    let tau = phi.tan();
    let sigma = (e * (e * tau / (1.0 + tau * tau).sqrt()).atanh()).sinh();
    let taup = tau * (1.0 + sigma * sigma).sqrt() - sigma * (1.0 + tau * tau).sqrt();
    let (xi0, eta0) = (taup.atan2(lam.cos()), (lam.sin() / (taup * taup + lam.cos().powi(2)).sqrt()).asinh());
    let (mut xi, mut eta) = (xi0, eta0);
    for (j, a) in alpha.iter().enumerate() {
        let k = 2.0 * (j + 1) as f64;
        xi += a * (k * xi0).sin() * (k * eta0).cosh();
        eta += a * (k * xi0).cos() * (k * eta0).sinh();
    }
    (500_000.0 + K0 * r * eta, K0 * r * xi + if lat < 0.0 { 10_000_000.0 } else { 0.0 })
}

/// (lat, lon) in degrees.
pub fn utm_inverse(easting: f64, northing: f64, zone: u32, south: bool) -> (f64, f64) {
    let (r, _, beta) = series();
    let e = (F * (2.0 - F)).sqrt();
    let xi = (northing - if south { 10_000_000.0 } else { 0.0 }) / (K0 * r);
    let eta = (easting - 500_000.0) / (K0 * r);
    let (mut xi0, mut eta0) = (xi, eta);
    for (j, b) in beta.iter().enumerate() {
        let k = 2.0 * (j + 1) as f64;
        xi0 -= b * (k * xi).sin() * (k * eta).cosh();
        eta0 -= b * (k * xi).cos() * (k * eta).sinh();
    }
    let taup = xi0.sin() / (eta0.sinh().powi(2) + xi0.cos().powi(2)).sqrt();
    let mut tau = taup / (1.0 - e * e);
    for _ in 0..8 {
        let s = (e * (e * tau / (1.0 + tau * tau).sqrt()).atanh()).sinh();
        let tp = tau * (1.0 + s * s).sqrt() - s * (1.0 + tau * tau).sqrt();
        let d = (taup - tp) * (1.0 + (1.0 - e * e) * tau * tau) / ((1.0 - e * e) * (1.0 + tau * tau).sqrt() * (1.0 + tp * tp).sqrt());
        tau += d;
    }
    (tau.atan().to_degrees(), (central_meridian(zone) + eta0.sinh().atan2(xi0.cos())).to_degrees())
}

pub type V3 = [f64; 3];
pub type M3 = [[f64; 3]; 3];

pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
pub fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn mat_vec(m: &M3, v: V3) -> V3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}
pub fn transpose(m: &M3) -> M3 {
    [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
}
pub fn mat_mul(a: &M3, b: &M3) -> M3 {
    let t = transpose(b);
    [[dot(a[0], t[0]), dot(a[0], t[1]), dot(a[0], t[2])], [dot(a[1], t[0]), dot(a[1], t[1]), dot(a[1], t[2])], [dot(a[2], t[0]), dot(a[2], t[1]), dot(a[2], t[2])]]
}

/// Rotation matrix of a quaternion (w, x, y, z).
pub fn quat_to_mat(q: [f64; 4]) -> M3 {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt().max(1e-300);
    let (w, x, y, z) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), 1.0 - 2.0 * (x * x + y * y)],
    ]
}

/// Eigenvalues and eigenvectors (columns) of a symmetric matrix by cyclic Jacobi.
pub fn jacobi<const N: usize>(mut a: [[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let mut v = [[0.0; N]; N];
    for (i, r) in v.iter_mut().enumerate() {
        r[i] = 1.0;
    }
    for _ in 0..64 {
        let mut off = 0.0;
        let mut diag = 0.0;
        for (p, row) in a.iter().enumerate() {
            diag += row[p] * row[p];
            for q in row.iter().skip(p + 1) {
                off += q * q;
            }
        }
        if off <= diag * 1e-30 || off < 1e-300 {
            break;
        }
        for p in 0..N {
            for q in p + 1..N {
                if a[p][q].abs() < 1e-300 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = if theta == 0.0 { 1.0 } else { theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt()) };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for row in a.iter_mut() {
                    let (akp, akq) = (row[p], row[q]);
                    row[p] = c * akp - s * akq;
                    row[q] = s * akp + c * akq;
                }
                let (rp, rq) = (a[p], a[q]);
                for (k, (u, v)) in rp.iter().zip(rq.iter()).enumerate() {
                    a[p][k] = c * u - s * v;
                    a[q][k] = s * u + c * v;
                }
                for r in v.iter_mut() {
                    let (vkp, vkq) = (r[p], r[q]);
                    r[p] = c * vkp - s * vkq;
                    r[q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut e = [0.0; N];
    for (i, x) in e.iter_mut().enumerate() {
        *x = a[i][i];
    }
    (e, v)
}

/// y = s R x + t.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sim3 {
    pub s: f64,
    pub q: [f64; 4],
    pub t: V3,
}

impl Sim3 {
    pub fn apply(&self, x: V3) -> V3 {
        add(scale(mat_vec(&quat_to_mat(self.q), x), self.s), self.t)
    }
}

/// Least squares similarity (Horn's quaternion method, so the rotation is proper by construction).
pub fn fit_sim3(src: &[V3], dst: &[V3]) -> Option<Sim3> {
    if src.len() < 3 || src.len() != dst.len() {
        return None;
    }
    let n = src.len() as f64;
    let mean = |p: &[V3]| p.iter().fold([0.0; 3], |a, b| add(a, *b)).map(|x| x / n);
    let (ms, md) = (mean(src), mean(dst));
    let mut h = [[0.0; 3]; 3];
    let mut ss = 0.0;
    for (a, b) in src.iter().zip(dst) {
        let (a, b) = (sub(*a, ms), sub(*b, md));
        ss += dot(a, a);
        for (i, r) in h.iter_mut().enumerate() {
            for (j, c) in r.iter_mut().enumerate() {
                *c += a[i] * b[j];
            }
        }
    }
    if ss <= 0.0 {
        return None;
    }
    let (sxx, sxy, sxz, syx, syy, syz, szx, szy, szz) = (h[0][0], h[0][1], h[0][2], h[1][0], h[1][1], h[1][2], h[2][0], h[2][1], h[2][2]);
    let k = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ];
    let (e, v) = jacobi(k);
    let best = (0..4).max_by(|a, b| e[*a].total_cmp(&e[*b]))?;
    let q = [v[0][best], v[1][best], v[2][best], v[3][best]];
    let r = quat_to_mat(q);
    let mut num = 0.0;
    for (a, b) in src.iter().zip(dst) {
        num += dot(sub(*b, md), mat_vec(&r, sub(*a, ms)));
    }
    let s = num / ss;
    if !s.is_finite() || s <= 0.0 {
        return None;
    }
    Some(Sim3 { s, q, t: sub(md, scale(mat_vec(&r, ms), s)) })
}

/// Second over first principal spread of the points: near 0 when they lie on a line.
pub fn linearity(p: &[V3]) -> f64 {
    let n = p.len().max(1) as f64;
    let m = p.iter().fold([0.0; 3], |a, b| add(a, *b)).map(|x| x / n);
    let mut c = [[0.0; 3]; 3];
    for x in p {
        let d = sub(*x, m);
        for (i, r) in c.iter_mut().enumerate() {
            for (j, v) in r.iter_mut().enumerate() {
                *v += d[i] * d[j];
            }
        }
    }
    let (mut e, _) = jacobi(c);
    e.sort_by(f64::total_cmp);
    if e[2] <= 0.0 {
        0.0
    } else {
        (e[1].max(0.0) / e[2]).sqrt()
    }
}

/// A fit that survives bad GPS fixes: least median of squares over deterministic samples, then
/// least squares on the inliers. Returns the fit and the indices it used.
pub fn fit_sim3_robust(src: &[V3], dst: &[V3]) -> Option<(Sim3, Vec<usize>)> {
    let n = src.len();
    if n < 3 || n != dst.len() {
        return None;
    }
    let resid = |f: &Sim3, i: usize| norm(sub(f.apply(src[i]), dst[i]));
    let median = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    };
    let mut seed = 0x9E37_79B9u32;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as usize
    };
    let mut best: Option<(f64, Sim3)> = None;
    if let Some(f) = fit_sim3(src, dst) {
        let mut r: Vec<f64> = (0..n).map(|i| resid(&f, i)).collect();
        best = Some((median(&mut r), f));
    }
    for _ in 0..500 {
        let (a, b, c) = (next() % n, next() % n, next() % n);
        if a == b || b == c || a == c {
            continue;
        }
        let Some(f) = fit_sim3(&[src[a], src[b], src[c]], &[dst[a], dst[b], dst[c]]) else { continue };
        let mut r: Vec<f64> = (0..n).map(|i| resid(&f, i)).collect();
        let m = median(&mut r);
        if best.as_ref().is_none_or(|(bm, _)| m < *bm) {
            best = Some((m, f));
        }
    }
    let (med, mut f) = best?;
    let gate = (2.5 * 1.4826 * med).max(0.5);
    let mut keep: Vec<usize> = (0..n).filter(|i| resid(&f, *i) <= gate).collect();
    if keep.len() >= 3 {
        let (a, b): (Vec<V3>, Vec<V3>) = keep.iter().map(|i| (src[*i], dst[*i])).unzip();
        if let Some(g) = fit_sim3(&a, &b) {
            f = g;
        }
        keep = (0..n).filter(|i| resid(&f, *i) <= gate).collect();
    }
    Some((f, keep))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utm_round_trips() {
        assert_eq!(utm_zone(-81.5), 17);
        assert_eq!(utm_zone(151.2), 56);
        for (lat, lon) in [(41.1, -81.5), (-33.9, 151.2), (0.5, 3.1), (64.1, -21.9), (-0.01, -80.0)] {
            let z = utm_zone(lon);
            let (e, n) = utm_forward(lat, lon, z);
            let (a, b) = utm_inverse(e, n, z, lat < 0.0);
            assert!((a - lat).abs() < 1e-9 && (b - lon).abs() < 1e-9, "{lat} {lon} {a} {b}");
        }
    }

    #[test]
    fn utm_matches_proj() {
        // From PROJ 9.9.0 (pyproj 3.8.0, gw-te env): EPSG:4326 to EPSG:32617, 32756 and 32627.
        for (lat, lon, zone, e, n) in [
            (41.1_f64, -81.5_f64, 17, 458012.7804_f64, 4549978.5425_f64),
            (-33.9, 151.2, 56, 333568.9410, 6247473.3368),
            (64.1, -21.9, 27, 456137.5541, 7108467.4170),
        ] {
            let (ee, nn) = utm_forward(lat, lon, zone);
            assert!((ee - e).abs() < 0.001 && (nn - n).abs() < 0.001, "{ee} {nn} vs {e} {n}");
        }
    }

    #[test]
    fn fit_recovers_a_similarity_and_ignores_bad_fixes() {
        let n = (1f64 + 4.0 + 9.0 + 16.0).sqrt();
        let truth = Sim3 { s: 3.7, q: [1.0 / n, 2.0 / n, 3.0 / n, 4.0 / n], t: [100.0, -20.0, 300.0] };
        let src: Vec<V3> = (0..40)
            .map(|i| {
                let f = i as f64;
                [f.sin() * 9.0, (f * 0.7).cos() * 7.0, (f * 0.3).sin() * 2.0]
            })
            .collect();
        let mut dst: Vec<V3> = src.iter().map(|p| truth.apply(*p)).collect();
        let f = fit_sim3(&src, &dst).unwrap();
        assert!((f.s - truth.s).abs() < 1e-9);
        for p in &src {
            assert!(norm(sub(f.apply(*p), truth.apply(*p))) < 1e-8);
        }
        for i in [3usize, 11, 19, 27] {
            dst[i][0] += 80.0;
        }
        let (g, keep) = fit_sim3_robust(&src, &dst).unwrap();
        assert_eq!(keep.len(), 36);
        assert!((g.s - truth.s).abs() < 1e-6);
    }

    #[test]
    fn a_straight_strip_reads_as_linear() {
        let line: Vec<V3> = (0..10).map(|i| [i as f64 * 10.0, i as f64 * 5.0, 100.0]).collect();
        assert!(linearity(&line) < 1e-6);
        let grid: Vec<V3> = (0..16).map(|i| [(i % 4) as f64 * 10.0, (i / 4) as f64 * 10.0, 100.0]).collect();
        assert!(linearity(&grid) > 0.5);
    }
}
