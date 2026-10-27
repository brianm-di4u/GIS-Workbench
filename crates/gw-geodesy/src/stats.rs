//! Accuracy statistics (REQ-MEN-06, `Research/05` §6): exact CE90/CE95 from a 2×2
//! covariance by quadrature, LE90, SE90 from a 3×3 covariance, and the error ellipse.

pub const LE90_K: f64 = 1.644_853_626_951_472_2;
pub const LE95_K: f64 = 1.959_963_984_540_054;
pub const CE90_CIRC_K: f64 = 2.145_966_026_289_347;
pub const SE90_SPH_K: f64 = 2.500_252_642_985_19;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ellipse {
    pub sigma_max: f64,
    pub sigma_min: f64,
    /// Azimuth of the major axis, clockwise from north (°).
    pub azimuth: f64,
}

/// Eigen-decomposition of C = [[σE², σEN], [σEN, σN²]].
pub fn ellipse(see: f64, sen: f64, snn: f64) -> Ellipse {
    let m = (see + snn) / 2.0;
    let d = (((see - snn) / 2.0).powi(2) + sen * sen).sqrt();
    let l1 = (m + d).max(0.0);
    let l2 = (m - d).max(0.0);
    let theta = 0.5 * (2.0 * sen).atan2(snn - see);
    let mut az = theta.to_degrees();
    // atan2 here gives the angle of the major axis from north toward east.
    if az < 0.0 {
        az += 180.0;
    }
    Ellipse { sigma_max: l1.sqrt(), sigma_min: l2.sqrt(), azimuth: az }
}

/// P(|e| ≤ R) for a zero-mean 2-D normal with principal σ's a ≥ b.
fn prob_2d(r: f64, a: f64, b: f64) -> f64 {
    if b <= 0.0 {
        // Degenerate: 1-D normal along the major axis.
        return erf(r / (a * std::f64::consts::SQRT_2));
    }
    let ratio = b / a;
    if ratio < 0.05 {
        return prob_2d_thin(r, a, b);
    }
    let n = (64.0f64).max(16.0 / ratio).min(4096.0) as usize;
    let mut sum = 0.0;
    for i in 0..n {
        let th = 2.0 * std::f64::consts::PI * (i as f64 + 0.5) / n as f64;
        let q = th.cos().powi(2) / (a * a) + th.sin().powi(2) / (b * b);
        sum += (1.0 - (-r * r * q / 2.0).exp()) / q;
    }
    sum * (2.0 * std::f64::consts::PI / n as f64) / (2.0 * std::f64::consts::PI * a * b)
}

/// Thin ellipses: P(R) = ∫ φ_a(x) · erf(√(R²−x²)/(b√2)) dx over [−R, R], with x = R·sin t.
fn prob_2d_thin(r: f64, a: f64, b: f64) -> f64 {
    let n = ((8.0 * r / b.max(1e-300)).max(256.0)).min(20_000.0) as usize;
    let h = std::f64::consts::PI / n as f64;
    let mut sum = 0.0;
    for i in 0..n {
        let t = -std::f64::consts::FRAC_PI_2 + (i as f64 + 0.5) * h;
        let x = r * t.sin();
        let y = r * t.cos();
        let inner = if b > 0.0 { erf(y / (b * std::f64::consts::SQRT_2)) } else { 1.0 };
        let phi = (-(x * x) / (2.0 * a * a)).exp() / (a * (2.0 * std::f64::consts::PI).sqrt());
        sum += phi * inner * r * t.cos();
    }
    sum * h
}

/// Radius R with P(radial error ≤ R) = p, from the 2×2 covariance (exact, numerical).
pub fn circular_error(see: f64, sen: f64, snn: f64, p: f64) -> f64 {
    let e = ellipse(see, sen, snn);
    let (a, b) = (e.sigma_max, e.sigma_min);
    if a <= 0.0 {
        return 0.0;
    }
    let (mut lo, mut hi) = (0.0, 4.0 * a);
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if prob_2d(mid, a, b) < p {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo < 1e-12 * a {
            break;
        }
    }
    0.5 * (lo + hi)
}

pub fn ce90(see: f64, sen: f64, snn: f64) -> f64 {
    circular_error(see, sen, snn, 0.9)
}

pub fn ce95(see: f64, sen: f64, snn: f64) -> f64 {
    circular_error(see, sen, snn, 0.95)
}

pub fn le90(sigma_v: f64) -> f64 {
    LE90_K * sigma_v
}

/// SE90 from a symmetric 3×3 covariance by quadrature over the sphere.
pub fn se90(c: [[f64; 3]; 3]) -> f64 {
    let inv = match inv3(c) {
        Some(i) => i,
        None => return f64::NAN,
    };
    let det = det3(c);
    if det <= 0.0 {
        return f64::NAN;
    }
    let (nt, np) = (48usize, 96usize);
    let (gx, gw) = gauss_legendre(nt);
    let prob = |r: f64| -> f64 {
        let mut s = 0.0;
        for (t, w) in gx.iter().zip(&gw) {
            // map [-1,1] → cosθ
            let ct = *t;
            let st = (1.0 - ct * ct).max(0.0).sqrt();
            for j in 0..np {
                let ph = 2.0 * std::f64::consts::PI * (j as f64 + 0.5) / np as f64;
                let u = [st * ph.cos(), st * ph.sin(), ct];
                let mut q = 0.0;
                for a in 0..3 {
                    for b in 0..3 {
                        q += u[a] * inv[a][b] * u[b];
                    }
                }
                let x = r * (q / 2.0).sqrt();
                let f = (std::f64::consts::PI / 2.0).sqrt() * erf(x) / q.powf(1.5) - r * (-r * r * q / 2.0).exp() / q;
                s += w * f * (2.0 * std::f64::consts::PI / np as f64);
            }
        }
        s / ((2.0 * std::f64::consts::PI).powf(1.5) * det.sqrt())
    };
    let smax = c[0][0].max(c[1][1]).max(c[2][2]).sqrt() * 2.0;
    let (mut lo, mut hi) = (0.0, 6.0 * smax.max(1e-12));
    for _ in 0..80 {
        let mid = 0.5 * (lo + hi);
        if prob(mid) < 0.9 {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

fn det3(m: [[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn inv3(m: [[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let d = det3(m);
    if d.abs() < 1e-300 {
        return None;
    }
    let mut r = [[0.0; 3]; 3];
    r[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d;
    r[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d;
    r[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d;
    r[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d;
    r[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d;
    r[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d;
    r[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d;
    r[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d;
    r[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d;
    Some(r)
}

fn gauss_legendre(n: usize) -> (Vec<f64>, Vec<f64>) {
    let mut x = vec![0.0; n];
    let mut w = vec![0.0; n];
    for i in 0..n {
        let mut z = (std::f64::consts::PI * (i as f64 + 0.75) / (n as f64 + 0.5)).cos();
        for _ in 0..100 {
            let (mut p1, mut p2) = (1.0, 0.0);
            for j in 0..n {
                let p3 = p2;
                p2 = p1;
                p1 = ((2 * j + 1) as f64 * z * p2 - j as f64 * p3) / (j + 1) as f64;
            }
            let pp = n as f64 * (z * p1 - p2) / (z * z - 1.0);
            let z1 = z;
            z = z1 - p1 / pp;
            if (z - z1).abs() < 1e-15 {
                x[i] = z;
                w[i] = 2.0 / ((1.0 - z * z) * pp * pp);
                break;
            }
        }
    }
    (x, w)
}

/// erf with ~1e-15 accuracy (Abramowitz–Stegun 7.1.26 is not enough; use series/continued fraction).
pub fn erf(x: f64) -> f64 {
    let ax = x.abs();
    let r = if ax < 2.5 {
        // Maclaurin series.
        let mut sum = ax;
        let mut term = ax;
        let x2 = ax * ax;
        let mut n = 0.0;
        loop {
            n += 1.0;
            term *= -x2 / n;
            let add = term / (2.0 * n + 1.0);
            sum += add;
            if add.abs() < 1e-17 * sum.abs() {
                break;
            }
            if n > 200.0 {
                break;
            }
        }
        2.0 / std::f64::consts::PI.sqrt() * sum
    } else {
        // Continued fraction for erfc.
        let mut f = 0.0;
        for k in (1..=60).rev() {
            f = (k as f64 / 2.0) / (ax + f);
        }
        1.0 - (-ax * ax).exp() / (std::f64::consts::PI.sqrt() * (ax + f))
    };
    if x < 0.0 {
        -r
    } else {
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circular_case() {
        // AT-03.3: CE90 = 2.146σ and LE90 = 1.645σ in the circular case.
        let ce = ce90(4.0, 0.0, 4.0);
        assert!((ce / 2.0 - CE90_CIRC_K).abs() < 1e-6, "{ce}");
        assert!((le90(2.0) / 2.0 - 1.6449).abs() < 1e-4);
        assert!((ce95(1.0, 0.0, 1.0) - 2.4477).abs() < 1e-4);
    }

    #[test]
    fn worked_example() {
        // Research/05 §6.7: C = [[4, 1.5], [1.5, 1]].
        let e = ellipse(4.0, 1.5, 1.0);
        assert!((e.sigma_max - 2.1497).abs() < 1e-4 && (e.sigma_min - 0.6154).abs() < 1e-4);
        assert!((e.azimuth - 67.5).abs() < 0.1, "{}", e.azimuth);
        assert!((ce90(4.0, 1.5, 1.0) - 3.592).abs() < 1e-3);
        assert!((ce95(4.0, 1.5, 1.0) - 4.261).abs() < 1e-3);
    }

    #[test]
    fn thin_ellipse_limit() {
        // r → 0: CE90 → 1.6449 σmax.
        let c = ce90(1.0, 0.0, 1e-10);
        assert!((c - 1.6449).abs() < 2e-3, "{c}");
    }

    #[test]
    fn spherical_se90() {
        let s = se90([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
        assert!((s - SE90_SPH_K).abs() < 1e-3, "{s}");
    }

    #[test]
    fn erf_values() {
        assert!((erf(0.5) - 0.520_499_877_813_046_5).abs() < 1e-14);
        assert!((erf(3.0) - 0.999_977_909_503_001_4).abs() < 1e-14);
    }
}
