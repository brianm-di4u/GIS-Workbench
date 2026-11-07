//! Angle and auxiliary-latitude helpers, following GeographicLib's `Math` (MIT, C. F. F. Karney).

pub const DEG: f64 = std::f64::consts::PI / 180.0;

/// sin and cos of an angle in degrees, with exact results at multiples of 90°.
pub fn sincosd(x: f64) -> (f64, f64) {
    let mut r = x % 360.0;
    let q = (r / 90.0).round();
    r -= 90.0 * q;
    let rr = r * DEG;
    let (s, c) = rr.sin_cos();
    let (mut sinx, mut cosx) = match (q as i64).rem_euclid(4) {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    };
    if sinx == 0.0 {
        sinx = 0.0f64.copysign(x);
    }
    cosx += 0.0;
    (sinx, cosx)
}

/// Normalise an angle to (-180, 180].
pub fn ang_normalize(x: f64) -> f64 {
    let y = x % 360.0;
    let y = if y <= -180.0 {
        y + 360.0
    } else if y > 180.0 {
        y - 360.0
    } else {
        y
    };
    if y == -180.0 {
        180.0
    } else {
        y
    }
}

/// y − x, reduced to (-180, 180].
pub fn ang_diff(x: f64, y: f64) -> f64 {
    ang_normalize(ang_normalize(y) - ang_normalize(x))
}

pub fn atan2d(y: f64, x: f64) -> f64 {
    y.atan2(x) / DEG
}

pub fn atand(x: f64) -> f64 {
    x.atan() / DEG
}

pub fn tand(x: f64) -> f64 {
    let (s, c) = sincosd(x);
    if c != 0.0 {
        s / c
    } else if s < 0.0 {
        -f64::MAX
    } else {
        f64::MAX
    }
}

/// e·atanh(e·x) for e > 0 (oblate).
pub fn eatanhe(x: f64, es: f64) -> f64 {
    if es > 0.0 {
        es * (es * x).atanh()
    } else {
        -es * (es * x).atan()
    }
}

/// tan of the conformal latitude from tan of the geodetic latitude.
pub fn taupf(tau: f64, es: f64) -> f64 {
    if !tau.is_finite() {
        return tau;
    }
    let tau1 = 1f64.hypot(tau);
    let sig = eatanhe(tau / tau1, es).sinh();
    1f64.hypot(sig) * tau - sig * tau1
}

/// Inverse of `taupf` by Newton's method.
pub fn tauf(taup: f64, es: f64) -> f64 {
    const NUMIT: usize = 5;
    let tol = f64::EPSILON.sqrt() / 10.0;
    let taumax = 2.0 / f64::EPSILON.sqrt();
    let e2m = 1.0 - es * es;
    let mut tau = if taup.abs() > 70.0 {
        taup * eatanhe(1.0, es).exp()
    } else {
        taup / e2m
    };
    let stol = tol * 1f64.max(taup.abs());
    if !(tau.abs() < taumax) {
        return tau;
    }
    for _ in 0..NUMIT {
        let taupa = taupf(tau, es);
        let dtau = (taup - taupa) * (1.0 + e2m * tau * tau) / (e2m * 1f64.hypot(tau) * 1f64.hypot(taupa));
        tau += dtau;
        if !(dtau.abs() >= stol) {
            break;
        }
    }
    tau
}

/// Clamp a latitude to [-90, 90]; NaN outside.
pub fn lat_fix(x: f64) -> f64 {
    if x.abs() > 90.0 {
        f64::NAN
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_quadrants() {
        assert_eq!(sincosd(90.0), (1.0, 0.0));
        assert_eq!(sincosd(180.0).1, -1.0);
        assert_eq!(ang_normalize(-180.0), 180.0);
        assert_eq!(ang_normalize(540.0), 180.0);
        assert_eq!(ang_diff(170.0, -170.0), 20.0);
    }
    #[test]
    fn tau_round_trip() {
        let es = (0.006_694_379_990_14f64).sqrt();
        for &t in &[-3.0, -0.5, 0.0, 0.3, 1.0, 10.0] {
            let tp = taupf(t, es);
            assert!((tauf(tp, es) - t).abs() < 1e-14 * (1.0 + t.abs()));
        }
    }
}
