//! Transverse Mercator (Krüger 6th-order series) and polar stereographic projections,
//! ported from GeographicLib's `TransverseMercator` and `PolarStereographic` (MIT).
//! Accuracy: 5 nm within 35° of the central meridian (`Research/05` §3.2).

use crate::math::*;
use crate::wgs84::{A, F};

#[derive(Clone, Copy, Debug)]
struct C64 {
    re: f64,
    im: f64,
}

impl C64 {
    fn new(re: f64, im: f64) -> Self {
        C64 { re, im }
    }
    fn add(self, o: C64) -> C64 {
        C64::new(self.re + o.re, self.im + o.im)
    }
    fn scale(self, k: f64) -> C64 {
        C64::new(self.re * k, self.im * k)
    }
    fn sin(self) -> C64 {
        C64::new(self.re.sin() * self.im.cosh(), self.re.cos() * self.im.sinh())
    }
    fn cos(self) -> C64 {
        C64::new(self.re.cos() * self.im.cosh(), -self.re.sin() * self.im.sinh())
    }
    fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }
    fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }
}

/// Result of a forward projection: easting, northing (m), meridian convergence γ (°,
/// bearing of grid north clockwise from true north) and point scale k.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Projected {
    pub x: f64,
    pub y: f64,
    pub gamma: f64,
    pub k: f64,
}

/// Result of an inverse projection.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geographic {
    pub lat: f64,
    pub lon: f64,
    pub gamma: f64,
    pub k: f64,
}

pub struct TransverseMercator {
    k0: f64,
    a1: f64,
    b1: f64,
    es: f64,
    e2: f64,
    e2m: f64,
    alp: [f64; 7],
    bet: [f64; 7],
}

impl TransverseMercator {
    pub fn new(a: f64, f: f64, k0: f64) -> Self {
        let e2 = f * (2.0 - f);
        let es = e2.sqrt();
        let n = f / (2.0 - f);
        let n2 = n * n;
        let n3 = n2 * n;
        let n4 = n3 * n;
        let n5 = n4 * n;
        let n6 = n5 * n;
        let b1 = (1.0 + n2 / 4.0 + n4 / 64.0 + n6 / 256.0) / (1.0 + n);
        let alp = [
            0.0,
            n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0 + 41.0 * n4 / 180.0 - 127.0 * n5 / 288.0 + 7891.0 * n6 / 37800.0,
            13.0 * n2 / 48.0 - 3.0 * n3 / 5.0 + 557.0 * n4 / 1440.0 + 281.0 * n5 / 630.0 - 1983433.0 * n6 / 1935360.0,
            61.0 * n3 / 240.0 - 103.0 * n4 / 140.0 + 15061.0 * n5 / 26880.0 + 167603.0 * n6 / 181440.0,
            49561.0 * n4 / 161280.0 - 179.0 * n5 / 168.0 + 6601661.0 * n6 / 7257600.0,
            34729.0 * n5 / 80640.0 - 3418889.0 * n6 / 1995840.0,
            212378941.0 * n6 / 319334400.0,
        ];
        let bet = [
            0.0,
            n / 2.0 - 2.0 * n2 / 3.0 + 37.0 * n3 / 96.0 - n4 / 360.0 - 81.0 * n5 / 512.0 + 96199.0 * n6 / 604800.0,
            n2 / 48.0 + n3 / 15.0 - 437.0 * n4 / 1440.0 + 46.0 * n5 / 105.0 - 1118711.0 * n6 / 3870720.0,
            17.0 * n3 / 480.0 - 37.0 * n4 / 840.0 - 209.0 * n5 / 4480.0 + 5569.0 * n6 / 90720.0,
            4397.0 * n4 / 161280.0 - 11.0 * n5 / 504.0 - 830251.0 * n6 / 7257600.0,
            4583.0 * n5 / 161280.0 - 108847.0 * n6 / 3991680.0,
            20648693.0 * n6 / 638668800.0,
        ];
        TransverseMercator { k0, a1: b1 * a, b1, es, e2, e2m: 1.0 - e2, alp, bet }
    }

    /// The UTM projection on WGS 84 (k0 = 0.9996).
    pub fn utm() -> &'static TransverseMercator {
        use std::sync::OnceLock;
        static TM: OnceLock<TransverseMercator> = OnceLock::new();
        TM.get_or_init(|| TransverseMercator::new(A, F, 0.9996))
    }

    pub fn forward(&self, lon0: f64, lat: f64, lon: f64) -> Projected {
        let lat = lat_fix(lat);
        let lam = ang_diff(lon0, lon);
        let (sphi, cphi) = sincosd(lat);
        let (slam, clam) = sincosd(lam);
        let (xip, etap, mut gamma, mut k);
        if lat.abs() != 90.0 {
            let tau = sphi / cphi;
            let taup = taupf(tau, self.es);
            xip = taup.atan2(clam);
            etap = (slam / taup.hypot(clam)).asinh();
            gamma = atan2d(slam * taup, clam * 1f64.hypot(taup));
            k = (self.e2m + self.e2 * cphi * cphi).sqrt() * 1f64.hypot(tau) / taup.hypot(clam);
        } else {
            xip = std::f64::consts::FRAC_PI_2.copysign(lat);
            etap = 0.0;
            gamma = lam;
            // c = sqrt(e2m) * exp(eatanhe(1, es))
            k = self.e2m.sqrt() * eatanhe(1.0, self.es).exp();
        }
        let zp = C64::new(xip, etap);
        let mut z = zp;
        let mut dz = C64::new(1.0, 0.0);
        for j in 1..=6 {
            let jj = (2 * j) as f64;
            z = z.add(zp.scale(jj).sin().scale(self.alp[j]));
            dz = dz.add(zp.scale(jj).cos().scale(jj * self.alp[j]));
        }
        gamma -= dz.arg() / DEG;
        k *= self.b1 * dz.abs();
        Projected { x: self.a1 * self.k0 * z.im, y: self.a1 * self.k0 * z.re, gamma, k: k * self.k0 }
    }

    pub fn reverse(&self, lon0: f64, x: f64, y: f64) -> Geographic {
        let xi = y / (self.a1 * self.k0);
        let eta = x / (self.a1 * self.k0);
        let zeta = C64::new(xi, eta);
        let mut zp = zeta;
        let mut dzp = C64::new(1.0, 0.0);
        for j in 1..=6 {
            let jj = (2 * j) as f64;
            zp = zp.add(zeta.scale(jj).sin().scale(-self.bet[j]));
            dzp = dzp.add(zeta.scale(jj).cos().scale(-jj * self.bet[j]));
        }
        let (xip, etap) = (zp.re, zp.im);
        let (s, c) = (xip.sin(), xip.cos());
        let r = etap.sinh().hypot(c);
        let (lat, lam, mut gamma, mut k);
        if r != 0.0 {
            lam = atan2d(etap.sinh(), c);
            let taup = s / r;
            let tau = tauf(taup, self.es);
            lat = atand(tau);
            gamma = atan2d(s * etap.tanh(), c);
            k = (self.e2m + self.e2 / (1.0 + tau * tau)).sqrt() * 1f64.hypot(tau) * r;
        } else {
            lat = 90.0;
            lam = 0.0;
            gamma = 0.0;
            k = self.e2m.sqrt() * eatanhe(1.0, self.es).exp();
        }
        // dzp = dζ'/dζ, so convergence uses its argument with the opposite sign of forward.
        gamma += dzp.arg() / DEG;
        k *= self.b1 / dzp.abs();
        Geographic { lat, lon: ang_normalize(lon0 + lam), gamma, k: k * self.k0 }
    }
}

pub struct PolarStereographic {
    a: f64,
    k0: f64,
    e2: f64,
    es: f64,
    e2m: f64,
    c: f64,
}

impl PolarStereographic {
    pub fn new(a: f64, f: f64, k0: f64) -> Self {
        let e2 = f * (2.0 - f);
        let es = e2.sqrt();
        PolarStereographic { a, k0, e2, es, e2m: 1.0 - e2, c: (1.0 - f) * eatanhe(1.0, es).exp() }
    }

    /// The UPS projection on WGS 84 (k0 = 0.994).
    pub fn ups() -> &'static PolarStereographic {
        use std::sync::OnceLock;
        static PS: OnceLock<PolarStereographic> = OnceLock::new();
        PS.get_or_init(|| PolarStereographic::new(A, F, 0.994))
    }

    pub fn forward(&self, northp: bool, lat: f64, lon: f64) -> Projected {
        let lat = lat_fix(lat) * if northp { 1.0 } else { -1.0 };
        let tau = tand(lat);
        let secphi = 1f64.hypot(tau);
        let taup = taupf(tau, self.es);
        let mut rho = 1f64.hypot(taup) + taup.abs();
        rho = if taup >= 0.0 {
            if lat != 90.0 {
                1.0 / rho
            } else {
                0.0
            }
        } else {
            rho
        };
        rho *= 2.0 * self.k0 * self.a / self.c;
        let k = if lat != 90.0 {
            (rho / self.a) * secphi * (self.e2m + self.e2 / (secphi * secphi)).sqrt()
        } else {
            self.k0
        };
        let (sx, cy) = sincosd(lon);
        let x = sx * rho;
        let y = cy * if northp { -rho } else { rho };
        let gamma = ang_normalize(if northp { lon } else { -lon });
        Projected { x, y, gamma, k }
    }

    pub fn reverse(&self, northp: bool, x: f64, y: f64) -> Geographic {
        let rho = x.hypot(y);
        let t = if rho != 0.0 {
            rho / (2.0 * self.k0 * self.a / self.c)
        } else {
            f64::EPSILON * f64::EPSILON
        };
        let taup = (1.0 / t - t) / 2.0;
        let tau = tauf(taup, self.es);
        let secphi = 1f64.hypot(tau);
        let k = if rho != 0.0 {
            (rho / self.a) * secphi * (self.e2m + self.e2 / (secphi * secphi)).sqrt()
        } else {
            self.k0
        };
        let lat = if northp { 1.0 } else { -1.0 } * atand(tau);
        let lon = atan2d(x, if northp { -y } else { y });
        let gamma = ang_normalize(if northp { lon } else { -lon });
        Geographic { lat, lon, gamma, k }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utm_38n_reference() {
        // GeoConvert: 33.3, 44.4 -> 38n 444140.545 3684706.356 (Research/05 §3.8)
        let p = TransverseMercator::utm().forward(45.0, 33.3, 44.4);
        assert!((p.x + 500_000.0 - 444_140.545).abs() < 1e-3, "{}", p.x + 500000.0);
        assert!((p.y - 3_684_706.356).abs() < 1e-3, "{}", p.y);
    }

    #[test]
    fn utm_far_from_central_meridian() {
        // 60, 10 forced into zone 31 -> 31n 889956.701 6672079.494
        let p = TransverseMercator::utm().forward(3.0, 60.0, 10.0);
        assert!((p.x + 500_000.0 - 889_956.701).abs() < 1e-3);
        assert!((p.y - 6_672_079.494).abs() < 1e-3);
    }

    #[test]
    fn utm_round_trip() {
        let tm = TransverseMercator::utm();
        for &(lat, lon) in &[(33.3, 44.4), (-33.8568, 151.2153), (0.0, 3.0), (79.0, 20.0), (-60.0, -150.0)] {
            let lon0 = ((lon / 6.0f64).floor() * 6.0) + 3.0;
            let p = tm.forward(lon0, lat, lon);
            let g = tm.reverse(lon0, p.x, p.y);
            assert!((g.lat - lat).abs() < 1e-11, "{lat} {}", g.lat);
            assert!((g.lon - lon).abs() < 1e-11, "{lon} {}", g.lon);
            assert!((g.gamma - p.gamma).abs() < 1e-9);
            assert!((g.k - p.k).abs() < 1e-12);
        }
    }

    #[test]
    fn ups_north_reference() {
        // 85, 30 -> n 2277728.696 1518959.788
        let p = PolarStereographic::ups().forward(true, 85.0, 30.0);
        assert!((p.x + 2_000_000.0 - 2_277_728.696).abs() < 1e-3, "{}", p.x + 2e6);
        assert!((p.y + 2_000_000.0 - 1_518_959.788).abs() < 1e-3, "{}", p.y + 2e6);
        let g = PolarStereographic::ups().reverse(true, p.x, p.y);
        assert!((g.lat - 85.0).abs() < 1e-11 && (g.lon - 30.0).abs() < 1e-11);
    }
}
