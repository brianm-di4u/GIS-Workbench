//! Layover and shadow masks of a SAR collect over a prior DEM (REQ-GAP-42, GR-15).
//!
//! Everything is in a local frame at the DEM's centre: east and north in metres, and "up" as the
//! height above the ellipsoid less the Earth-curvature drop (e² + n²)/2R, so that a straight line
//! in the frame is a straight line in space to within a few centimetres over a few kilometres.
//! The sensor (aperture reference point and its velocity at the point's centre of aperture) is
//! given in the same frame per point.
//!
//! * **Shadow**: the straight line of sight from the point to the sensor passes below the terrain
//!   somewhere between them.
//! * **Layover**: the point's range/Doppler locus (the circle about the velocity axis through the
//!   sensor that keeps both the range and the Doppler cone of the point) crosses the terrain again,
//!   so another piece of ground falls in the same image pixel. This covers active layover (fore
//!   slopes steeper than the incidence) and passive layover (the ground in front of and behind
//!   them that lands on the same pixels) for any squint, since it follows the SICD R/Rdot contour.
//!
//! Both are sampled at `step` metres along the ground and use a height tolerance `tol` metres, so
//! grazing contacts within `tol` are not counted.

/// Layover bit of a mask value.
pub const LAYOVER: u8 = 1;
/// Shadow bit of a mask value.
pub const SHADOW: u8 = 2;

/// A DEM on a regular east/north grid in the local frame (row 0 is the northern row).
pub struct DemEnu<'a> {
    pub w: usize,
    pub h: usize,
    /// Heights above the ellipsoid (m), row-major; NaN = no data.
    pub z: &'a [f32],
    /// East and north of the centre of post (0, 0), metres.
    pub e0: f64,
    pub n0: f64,
    /// Post spacing east and north, metres (positive; rows go south).
    pub de: f64,
    pub dn: f64,
    /// Radius of curvature for the drop term (m).
    pub radius: f64,
    /// Lowest and highest finite height (HAE).
    pub zmin: f64,
    pub zmax: f64,
}

impl<'a> DemEnu<'a> {
    /// A DEM view; zmin/zmax are taken from the data.
    pub fn new(w: usize, h: usize, z: &'a [f32], e0: f64, n0: f64, de: f64, dn: f64, radius: f64) -> Option<DemEnu<'a>> {
        if w < 2 || h < 2 || z.len() != w.checked_mul(h)? || !(de > 0.0) || !(dn > 0.0) || !(radius > 0.0) {
            return None;
        }
        let (mut a, mut b) = (f64::INFINITY, f64::NEG_INFINITY);
        for &v in z {
            if v.is_finite() {
                a = a.min(v as f64);
                b = b.max(v as f64);
            }
        }
        if !a.is_finite() {
            return None;
        }
        Some(DemEnu { w, h, z, e0, n0, de, dn, radius, zmin: a, zmax: b })
    }

    fn drop(&self, e: f64, n: f64) -> f64 {
        (e * e + n * n) / (2.0 * self.radius)
    }

    /// Height above the ellipsoid at (e, n), bilinear; None outside the grid or next to no data.
    pub fn hae(&self, e: f64, n: f64) -> Option<f64> {
        let fx = (e - self.e0) / self.de;
        let fy = (self.n0 - n) / self.dn;
        if !(fx >= 0.0 && fy >= 0.0) || fx > (self.w - 1) as f64 || fy > (self.h - 1) as f64 {
            return None;
        }
        let i = (fx.floor() as usize).min(self.w - 2);
        let j = (fy.floor() as usize).min(self.h - 2);
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let q = |a: usize, b: usize| self.z[b * self.w + a] as f64;
        let v = (q(i, j) * (1.0 - tx) + q(i + 1, j) * tx) * (1.0 - ty) + (q(i, j + 1) * (1.0 - tx) + q(i + 1, j + 1) * tx) * ty;
        v.is_finite().then_some(v)
    }

    /// The terrain's "up" coordinate in the local frame.
    pub fn up(&self, e: f64, n: f64) -> Option<f64> {
        self.hae(e, n).map(|h| h - self.drop(e, n))
    }

    /// A point of the terrain in the local frame (None where there is no height).
    pub fn point(&self, e: f64, n: f64) -> Option<[f64; 3]> {
        self.up(e, n).map(|u| [e, n, u])
    }

    /// The up coordinates that bound the terrain at (e, n) (for the march limits).
    fn bounds_at(&self, e: f64, n: f64) -> (f64, f64) {
        let d = self.drop(e, n);
        (self.zmin - d, self.zmax - d)
    }
}

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// At most this many samples per march (a malformed geometry ends, not hangs).
const MAX_STEPS: usize = 200_000;

/// Whether the line of sight from terrain point `p` to the sensor at `s` is blocked.
pub fn shadowed(dem: &DemEnu, p: V3, s: V3, step: f64, tol: f64) -> bool {
    let d = sub(s, p);
    let r = norm(d);
    if !(r > 0.0) || !step.is_finite() || !(step > 0.0) {
        return false;
    }
    let u = [d[0] / r, d[1] / r, d[2] / r];
    let hl = u[0].hypot(u[1]);
    if hl < 1e-6 {
        return false; // looking straight down
    }
    let ds = step / hl;
    for k in 1..MAX_STEPS {
        let t = k as f64 * ds;
        if t >= r {
            return false;
        }
        let q = [p[0] + u[0] * t, p[1] + u[1] * t, p[2] + u[2] * t];
        let (_, top) = dem.bounds_at(q[0], q[1]);
        if q[2] > top + tol {
            return false;
        }
        match dem.up(q[0], q[1]) {
            Some(g) if q[2] < g - tol => return true,
            Some(_) => {}
            None => return false,
        }
    }
    false
}

/// Whether the range/Doppler circle of terrain point `p` (sensor at `s` moving with `v`) meets the
/// terrain again.
pub fn laid_over(dem: &DemEnu, p: V3, s: V3, v: V3, step: f64, tol: f64) -> bool {
    let vn = norm(v);
    if !(vn > 0.0) || !step.is_finite() || !(step > 0.0) {
        return false;
    }
    let a = [v[0] / vn, v[1] / vn, v[2] / vn];
    let ps = sub(p, s);
    let along = dot(ps, a);
    let c = [s[0] + a[0] * along, s[1] + a[1] * along, s[2] + a[2] * along];
    let e1v = sub(p, c);
    let rho = norm(e1v);
    if !(rho > 0.0) {
        return false;
    }
    let e1 = [e1v[0] / rho, e1v[1] / rho, e1v[2] / rho];
    let e2 = cross(a, e1);
    // The circle leaves p along e2; step so that the ground advance is about `step`.
    let hl = e2[0].hypot(e2[1]).max(0.05);
    let dth = step / (rho * hl);
    for dir in [1.0, -1.0] {
        let mut s0 = 0.0f64;
        for k in 1..MAX_STEPS {
            let th = dir * k as f64 * dth;
            let (cs, sn) = (th.cos(), th.sin());
            let q = [c[0] + rho * (cs * e1[0] + sn * e2[0]), c[1] + rho * (cs * e1[1] + sn * e2[1]), c[2] + rho * (cs * e1[2] + sn * e2[2])];
            let (bot, top) = dem.bounds_at(q[0], q[1]);
            if q[2] > top + tol || q[2] < bot - tol {
                break;
            }
            let Some(g) = dem.up(q[0], q[1]) else { break };
            let f = q[2] - g;
            if f.abs() <= tol {
                continue;
            }
            if s0 == 0.0 {
                s0 = f.signum();
            } else if f.signum() != s0 {
                return true;
            }
        }
    }
    false
}

/// Mask value (LAYOVER | SHADOW bits) of terrain point `p`.
pub fn mask(dem: &DemEnu, p: V3, s: V3, v: V3, step: f64, tol: f64) -> u8 {
    (if laid_over(dem, p, s, v, step, tol) { LAYOVER } else { 0 }) | (if shadowed(dem, p, s, step, tol) { SHADOW } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ridge running north–south (x is east) on flat ground at 100 m: height 100 + H·tri(x).
    fn ridge(w: usize, h: usize, d: f64, hgt: f64, half: f64) -> Vec<f32> {
        let mut z = vec![0f32; w * h];
        for j in 0..h {
            for i in 0..w {
                let x = (i as f64 - (w / 2) as f64) * d;
                z[j * w + i] = (100.0 + (hgt * (1.0 - x.abs() / half)).max(0.0)) as f32;
            }
        }
        z
    }

    #[test]
    fn ridge_lit_from_the_west_has_layover_on_the_west_face_and_shadow_to_the_east() {
        let (w, h, d) = (401usize, 21usize, 5.0);
        let z = ridge(w, h, d, 300.0, 200.0); // 56° faces
        let e0 = -((w / 2) as f64) * d;
        let n0 = ((h / 2) as f64) * d;
        let dem = DemEnu::new(w, h, &z, e0, n0, d, d, 6.371e6).unwrap();
        // Sensor 600 km west at 45° elevation, flying north.
        let s = [-600e3, 0.0, 600e3];
        let v = [0.0, 7600.0, 0.0];
        let m = |x: f64| {
            let p = dem.point(x, 0.0).unwrap();
            mask(&dem, p, s, v, 2.5, 0.25)
        };
        // West face (56° > 45° incidence) is in active layover; the far flat ground behind the
        // ridge is in shadow (the back face is steeper than the 45° grazing ray).
        assert_eq!(m(-100.0) & LAYOVER, LAYOVER, "west face");
        assert_eq!(m(150.0) & SHADOW, SHADOW, "behind the ridge");
        assert_eq!(m(250.0) & SHADOW, SHADOW, "behind the ridge, 250 m");
        // Flat ground far from the ridge on either side: clear.
        assert_eq!(m(-900.0), 0, "far west");
        assert_eq!(m(900.0), 0, "far east");
        // Passive layover: the flat ground in front of the ridge whose range equals the upper
        // west face (45° geometry: about the ridge height in front of its foot).
        assert_eq!(m(-250.0) & LAYOVER, LAYOVER, "in front of the foot");
        assert_eq!(m(-330.0) & LAYOVER, 0, "beyond the passive layover");
        // A ridge with gentle faces (11°) has neither.
        let z2 = ridge(w, h, d, 40.0, 200.0);
        let dem2 = DemEnu::new(w, h, &z2, e0, n0, d, d, 6.371e6).unwrap();
        for x in [-150.0, -50.0, 0.0, 50.0, 150.0] {
            let p = dem2.point(x, 0.0).unwrap();
            assert_eq!(mask(&dem2, p, s, v, 2.5, 0.25), 0, "gentle ridge at {x}");
        }
    }

    #[test]
    fn shadow_extent_matches_the_grazing_ray() {
        // A 100 m step (vertical wall) facing west lit from the east at 30° grazing:
        // shadow behind it (west) for 100 / tan 30° ≈ 173 m.
        let (w, h, d) = (801usize, 11usize, 1.0);
        let mut z = vec![0f32; w * h];
        for j in 0..h {
            for i in 0..w {
                z[j * w + i] = if i >= 400 { 100.0 } else { 0.0 };
            }
        }
        let e0 = -400.0;
        let dem = DemEnu::new(w, h, &z, e0, 5.0, d, d, 1e12).unwrap();
        let el = 30f64.to_radians();
        let r = 700e3;
        let s = [r * el.cos(), 0.0, r * el.sin()];
        let mut first_lit = None;
        for k in 0..390 {
            let x = -1.0 - k as f64;
            let p = dem.point(x, 0.0).unwrap();
            if !shadowed(&dem, p, s, 0.5, 0.1) {
                first_lit = Some(-x);
                break;
            }
        }
        let want = 100.0 / el.tan();
        let got = first_lit.expect("lit ground behind the wall");
        assert!((got - want).abs() < 3.0, "shadow length {got} m, want {want} m");
    }
}
