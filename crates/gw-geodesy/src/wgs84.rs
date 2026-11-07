//! WGS 84 constants, geodetic ↔ ECEF and the local ENU frame (REQ-GEO-01, REQ-GEO-10).
//! ECEF → geodetic uses Vermeille's closed form as modified by Karney (GeographicLib
//! `Geocentric`, MIT); error < 7 nm within 5000 km of the surface.

use crate::math::*;

pub const A: f64 = 6_378_137.0;
pub const F: f64 = 1.0 / 298.257_223_563;
pub const E2: f64 = F * (2.0 - F);
pub const B: f64 = A * (1.0 - F);
/// Mean radius R1 = (2a + b)/3, used for LOS curvature (`Research/05` §5.5).
pub const R_MEAN: f64 = (2.0 * A + B) / 3.0;

pub fn geodetic_to_ecef(lat: f64, lon: f64, h: f64) -> [f64; 3] {
    let (sphi, cphi) = sincosd(lat);
    let (slam, clam) = sincosd(lon);
    let n = A / (1.0 - E2 * sphi * sphi).sqrt();
    [(n + h) * cphi * clam, (n + h) * cphi * slam, (n * (1.0 - E2) + h) * sphi]
}

pub fn ecef_to_geodetic(x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    let e2m = (1.0 - F) * (1.0 - F);
    let e2a = E2.abs();
    let e4a = E2 * E2;
    let r = x.hypot(y);
    let (slam, clam) = if r != 0.0 { (y / r, x / r) } else { (0.0, 1.0) };
    let h;
    let (sphi, cphi);
    let p = (r / A) * (r / A);
    let q = e2m * (z / A) * (z / A);
    let rr = (p + q - e4a) / 6.0;
    if !(e4a * q == 0.0 && rr <= 0.0) {
        let s = e4a * p * q / 4.0;
        let r2 = rr * rr;
        let r3 = rr * r2;
        let disc = s * (2.0 * r3 + s);
        let mut u = rr;
        if disc >= 0.0 {
            let mut t3 = s + r3;
            t3 += if t3 < 0.0 { -disc.sqrt() } else { disc.sqrt() };
            let t = t3.cbrt();
            u += t + if t != 0.0 { r2 / t } else { 0.0 };
        } else {
            let ang = (-disc).sqrt().atan2(-(s + r3));
            u += 2.0 * rr * (ang / 3.0).cos();
        }
        let v = (u * u + e4a * q).sqrt();
        let uv = if u < 0.0 { e4a * q / (v - u) } else { u + v };
        let w = (e2a * (uv - q) / (2.0 * v)).max(0.0);
        let k = uv / ((uv + w * w).sqrt() + w);
        let k1 = k;
        let k2 = k + E2;
        let d = k1 * r / k2;
        let hh = (z / k1).hypot(r / k2);
        sphi = (z / k1) / hh;
        cphi = (r / k2) / hh;
        h = (1.0 - e2m / k1) * d.hypot(z);
    } else {
        let zz = ((e4a - p) / e2m).sqrt();
        let xx = p.sqrt();
        let hh = zz.hypot(xx);
        sphi = if z < 0.0 { -zz / hh } else { zz / hh };
        cphi = xx / hh;
        h = -A * e2m * hh / e4a;
    }
    (atan2d(sphi, cphi), atan2d(slam, clam), h)
}

/// Rotation from ECEF differences to ENU at (lat0, lon0); rows are e, n, u.
pub fn enu_rotation(lat0: f64, lon0: f64) -> [[f64; 3]; 3] {
    let (sp, cp) = sincosd(lat0);
    let (sl, cl) = sincosd(lon0);
    [[-sl, cl, 0.0], [-sp * cl, -sp * sl, cp], [cp * cl, cp * sl, sp]]
}

/// Geodetic → ENU about an origin (lat0, lon0, h0).
pub fn geodetic_to_enu(lat: f64, lon: f64, h: f64, lat0: f64, lon0: f64, h0: f64) -> [f64; 3] {
    let p = geodetic_to_ecef(lat, lon, h);
    let o = geodetic_to_ecef(lat0, lon0, h0);
    let d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    let r = enu_rotation(lat0, lon0);
    [
        r[0][0] * d[0] + r[0][1] * d[1] + r[0][2] * d[2],
        r[1][0] * d[0] + r[1][1] * d[1] + r[1][2] * d[2],
        r[2][0] * d[0] + r[2][1] * d[1] + r[2][2] * d[2],
    ]
}

pub fn enu_to_geodetic(e: f64, n: f64, u: f64, lat0: f64, lon0: f64, h0: f64) -> (f64, f64, f64) {
    let o = geodetic_to_ecef(lat0, lon0, h0);
    let r = enu_rotation(lat0, lon0);
    // ECEF = o + Rᵀ·enu
    let x = o[0] + r[0][0] * e + r[1][0] * n + r[2][0] * u;
    let y = o[1] + r[0][1] * e + r[1][1] * n + r[2][1] * u;
    let z = o[2] + r[0][2] * e + r[1][2] * n + r[2][2] * u;
    ecef_to_geodetic(x, y, z)
}

/// Meridian radius M and prime-vertical radius N at a latitude.
pub fn radii(lat: f64) -> (f64, f64) {
    let (s, _) = sincosd(lat);
    let w = 1.0 - E2 * s * s;
    (A * (1.0 - E2) / w.powf(1.5), A / w.sqrt())
}

/// Slant range, elevation angle at A (°) and depression angle from B (°).
pub fn slant_geometry(a: (f64, f64, f64), b: (f64, f64, f64)) -> (f64, f64, f64) {
    let pa = geodetic_to_ecef(a.0, a.1, a.2);
    let pb = geodetic_to_ecef(b.0, b.1, b.2);
    let s = ((pa[0] - pb[0]).powi(2) + (pa[1] - pb[1]).powi(2) + (pa[2] - pb[2]).powi(2)).sqrt();
    let eb = geodetic_to_enu(b.0, b.1, b.2, a.0, a.1, a.2);
    let elev = atan2d(eb[2], eb[0].hypot(eb[1]));
    let ea = geodetic_to_enu(a.0, a.1, a.2, b.0, b.1, b.2);
    let dep = -atan2d(ea[2], ea[0].hypot(ea[1]));
    (s, elev, dep)
}

/// Curvature-and-refraction drop at distance d (m) with coefficient k (default 0.13).
pub fn curvature_drop(d: f64, k: f64) -> f64 {
    d * d * (1.0 - k) / (2.0 * R_MEAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecef_reference() {
        // proj4js geocent: 33.3N 44.4E h=0 → 3 812 626.635, 3 733 599.848, 3 481 815.436
        let p = geodetic_to_ecef(33.3, 44.4, 0.0);
        assert!((p[0] - 3_812_626.635).abs() < 1e-3);
        assert!((p[1] - 3_733_599.848).abs() < 1e-3);
        assert!((p[2] - 3_481_815.436).abs() < 1e-3);
    }

    #[test]
    fn ecef_round_trip() {
        for &(lat, lon, h) in &[(33.3, 44.4, 40.0), (-89.9, 10.0, 1000.0), (0.0, -179.0, -100.0), (89.999, 0.0, 9000.0)] {
            let p = geodetic_to_ecef(lat, lon, h);
            let (la, lo, hh) = ecef_to_geodetic(p[0], p[1], p[2]);
            assert!((la - lat).abs() < 1e-11 && (lo - lon).abs() < 1e-11 && (hh - h).abs() < 1e-6);
        }
    }

    #[test]
    fn slant_example() {
        // Research/05 §5.5 worked example.
        let (s, elev, dep) = slant_geometry((33.30, 44.40, 40.0), (33.35, 44.45, 6000.0));
        assert!((s - 9380.69).abs() < 0.05, "{s}");
        assert!((elev - 39.413).abs() < 1e-3, "{elev}");
        assert!((dep - 39.478).abs() < 1e-3, "{dep}");
        let e = geodetic_to_enu(33.35, 44.45, 6000.0, 33.30, 44.40, 40.0);
        assert!((e[0] - 4658.50).abs() < 0.05 && (e[1] - 5551.86).abs() < 0.05 && (e[2] - 5955.88).abs() < 0.05);
    }

    #[test]
    fn curvature_values() {
        assert!((curvature_drop(10_000.0, 0.13) - 6.83).abs() < 0.01);
        assert!((curvature_drop(50_000.0, 0.0) - 196.0).abs() < 0.5);
    }
}
