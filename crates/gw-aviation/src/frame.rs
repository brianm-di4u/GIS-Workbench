//! A local tangent plane (east, north) on the WGS 84 ellipsoid at the aerodrome. A geodetic
//! position on the ellipsoid maps to its orthogonal projection on the plane; the inverse finds the
//! point of the ellipsoid that projects to (e, n). Horizontal distances in the plane differ from the
//! geodesic by d³/(6R²)-order terms: 1.4 cm at 15 km.

const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_223_563;
const E2: f64 = F * (2.0 - F);
const B: f64 = A * (1.0 - F);

#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub lat0: f64,
    pub lon0: f64,
    o: [f64; 3],
    e: [f64; 3],
    n: [f64; 3],
    u: [f64; 3],
}

/// Earth-centred coordinates of a point on the ellipsoid (height 0).
pub fn ecef(lat: f64, lon: f64) -> [f64; 3] {
    let (sp, cp) = lat.to_radians().sin_cos();
    let (sl, cl) = lon.to_radians().sin_cos();
    let nn = A / (1.0 - E2 * sp * sp).sqrt();
    [nn * cp * cl, nn * cp * sl, nn * (1.0 - E2) * sp]
}

impl Frame {
    pub fn new(lat0: f64, lon0: f64) -> Self {
        let (sp, cp) = lat0.to_radians().sin_cos();
        let (sl, cl) = lon0.to_radians().sin_cos();
        Frame { lat0, lon0, o: ecef(lat0, lon0), e: [-sl, cl, 0.0], n: [-sp * cl, -sp * sl, cp], u: [cp * cl, cp * sl, sp] }
    }

    /// (east, north) of an earth-centred point.
    #[inline]
    pub fn of_ecef(&self, p: [f64; 3]) -> (f64, f64) {
        let d = [p[0] - self.o[0], p[1] - self.o[1], p[2] - self.o[2]];
        (d[0] * self.e[0] + d[1] * self.e[1] + d[2] * self.e[2], d[0] * self.n[0] + d[1] * self.n[1] + d[2] * self.n[2])
    }

    #[inline]
    pub fn fwd(&self, lat: f64, lon: f64) -> (f64, f64) {
        self.of_ecef(ecef(lat, lon))
    }

    /// The geodetic position (lat, lon) on the ellipsoid that projects to (e, n).
    pub fn inv(&self, e: f64, n: f64) -> (f64, f64) {
        let q = [self.o[0] + e * self.e[0] + n * self.n[0], self.o[1] + e * self.e[1] + n * self.n[1], self.o[2] + e * self.e[2] + n * self.n[2]];
        let u = self.u;
        let (a2, b2) = (A * A, B * B);
        let al = (u[0] * u[0] + u[1] * u[1]) / a2 + u[2] * u[2] / b2;
        let be = 2.0 * ((q[0] * u[0] + q[1] * u[1]) / a2 + q[2] * u[2] / b2);
        let ga = (q[0] * q[0] + q[1] * q[1]) / a2 + q[2] * q[2] / b2 - 1.0;
        let disc = (be * be - 4.0 * al * ga).max(0.0);
        let t = (-be + disc.sqrt()) / (2.0 * al);
        let p = [q[0] + t * u[0], q[1] + t * u[1], q[2] + t * u[2]];
        let lon = p[1].atan2(p[0]).to_degrees();
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        // On the ellipsoid, tan φ = z / ((1 − e²) r) exactly.
        let lat = p[2].atan2((1.0 - E2) * r).to_degrees();
        (lat, lon)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_distance() {
        let f = Frame::new(36.08, -115.15);
        for &(la, lo) in &[(36.08, -115.15), (36.2, -115.0), (35.95, -115.3), (36.08, -114.98)] {
            let (e, n) = f.fwd(la, lo);
            let (la2, lo2) = f.inv(e, n);
            assert!((la - la2).abs() < 1e-10 && (lo - lo2).abs() < 1e-10, "{la} {lo} -> {la2} {lo2}");
        }
        // 0.1° of latitude near 36° N is 11 095.5 m on WGS 84 (meridian arc); the projection shortens
        // it by d³/(6R²)-order terms only.
        let (_, n1) = f.fwd(36.13, -115.15);
        let (_, n0) = f.fwd(36.03, -115.15);
        assert!(((n1 - n0) - 11_095.5).abs() < 2.0, "{}", n1 - n0);
    }
}
