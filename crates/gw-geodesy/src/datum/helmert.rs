//! Time-dependent (15-parameter) Helmert transformations with PROJ's arithmetic
//! (`src/transformations/helmert.cpp`: linearised rotation matrix, position-vector or
//! coordinate-frame convention, parameters moved to the coordinate epoch with their rates),
//! geodetic ↔ geocentric as PROJ's `cart`, and the frame graph of `frames.rs` (REQ-GAP-16).

use super::frames::{FRAMES, OPS};
use super::grid::ARCSEC_TO_RAD;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Helmert {
    /// tx ty tz (m), rx ry rz (arc-seconds), s (ppm), then their rates per year.
    pub p: [f64; 14],
    pub epoch: f64,
    pub position_vector: bool,
}

struct State {
    t: [f64; 3],
    r: [[f64; 3]; 3],
    scale: f64,
    no_rotation: bool,
}

impl Helmert {
    fn state(&self, t_obs: Option<f64>) -> State {
        let p = &self.p;
        let t_obs = t_obs.unwrap_or(self.epoch);
        let dt = t_obs - self.epoch;
        let t = [p[0] + p[7] * dt, p[1] + p[8] * dt, p[2] + p[9] * dt];
        let o = p[3] * ARCSEC_TO_RAD + p[10] * ARCSEC_TO_RAD * dt;
        let ph = p[4] * ARCSEC_TO_RAD + p[11] * ARCSEC_TO_RAD * dt;
        let k = p[5] * ARCSEC_TO_RAD + p[12] * ARCSEC_TO_RAD * dt;
        let scale = p[6] + p[13] * dt;
        // Linearised rotation (PROJ's default), coordinate-frame form; transposed for PV.
        let mut r = [[1.0, k, -ph], [-k, 1.0, o], [ph, -o, 1.0]];
        if self.position_vector {
            let m = r;
            for (i, row) in r.iter_mut().enumerate() {
                for (j, v) in row.iter_mut().enumerate() {
                    *v = m[j][i];
                }
            }
        }
        let no_rotation = p[3] == 0.0 && p[4] == 0.0 && p[5] == 0.0 && p[10] == 0.0 && p[11] == 0.0 && p[12] == 0.0;
        State { t, r, scale, no_rotation }
    }

    pub fn forward(&self, x: [f64; 3], t_obs: Option<f64>) -> [f64; 3] {
        let q = self.state(t_obs);
        if q.no_rotation && q.scale == 0.0 {
            return [x[0] + q.t[0], x[1] + q.t[1], x[2] + q.t[2]];
        }
        let s = 1.0 + q.scale * 1e-6;
        let r = &q.r;
        [
            s * (r[0][0] * x[0] + r[0][1] * x[1] + r[0][2] * x[2]) + q.t[0],
            s * (r[1][0] * x[0] + r[1][1] * x[1] + r[1][2] * x[2]) + q.t[1],
            s * (r[2][0] * x[0] + r[2][1] * x[1] + r[2][2] * x[2]) + q.t[2],
        ]
    }

    pub fn inverse(&self, x: [f64; 3], t_obs: Option<f64>) -> [f64; 3] {
        let q = self.state(t_obs);
        if q.no_rotation && q.scale == 0.0 {
            return [x[0] - q.t[0], x[1] - q.t[1], x[2] - q.t[2]];
        }
        let s = 1.0 + q.scale * 1e-6;
        let (a, b, c) = ((x[0] - q.t[0]) / s, (x[1] - q.t[1]) / s, (x[2] - q.t[2]) / s);
        let r = &q.r;
        [r[0][0] * a + r[1][0] * b + r[2][0] * c, r[0][1] * a + r[1][1] * b + r[2][1] * c, r[0][2] * a + r[1][2] * b + r[2][2] * c]
    }
}

/// An ellipsoid as PROJ holds it.
#[derive(Clone, Copy, Debug)]
pub struct Ellipsoid {
    pub a: f64,
    pub es: f64,
    pub b: f64,
    pub e2s: f64,
}

impl Ellipsoid {
    pub fn from_rf(a: f64, rf: f64) -> Self {
        let f0 = 1.0 / rf;
        let es = 2.0 * f0 - f0 * f0;
        let alpha = es.sqrt().asin();
        let e2s = alpha.tan().powi(2);
        let f = 1.0 - alpha.cos();
        Ellipsoid { a, es, b: (1.0 - f) * a, e2s }
    }
    pub fn grs80() -> Self {
        Self::from_rf(6_378_137.0, 298.257_222_101)
    }
    pub fn wgs84() -> Self {
        Self::from_rf(6_378_137.0, 298.257_223_563)
    }
    fn n(&self, sinphi: f64) -> f64 {
        if self.es == 0.0 {
            self.a
        } else {
            self.a / (1.0 - self.es * sinphi * sinphi).sqrt()
        }
    }
    /// PROJ `cart` forward: (λ, φ radians, h) → XYZ.
    pub fn to_ecef(&self, lam: f64, phi: f64, h: f64) -> [f64; 3] {
        let n = self.n(phi.sin());
        let c = phi.cos();
        [(n + h) * c * lam.cos(), (n + h) * c * lam.sin(), (n * (1.0 - self.es) + h) * phi.sin()]
    }
    /// PROJ `cart` inverse (Bowring 1976, one step, as PROJ).
    pub fn from_ecef(&self, x: [f64; 3]) -> (f64, f64, f64) {
        let p = x[0].hypot(x[1]);
        let theta = (x[2] * self.a).atan2(p * self.b);
        let (s, c) = theta.sin_cos();
        let mut phi = (x[2] + self.e2s * self.b * s * s * s).atan2(p - self.es * self.a * c * c * c);
        if phi.abs() > std::f64::consts::FRAC_PI_2 {
            phi = std::f64::consts::FRAC_PI_2.copysign(phi);
        }
        let lam = x[1].atan2(x[0]);
        let n = self.n(phi.sin());
        let cp = phi.cos();
        let h = if cp.abs() < 1e-6 { x[2].abs() - self.b } else { p / cp - n };
        (lam, phi, h)
    }
}

pub fn frame_count() -> usize {
    FRAMES.len()
}

/// Frame index by name ("ITRF2014", "WGS 84 (G2139)") or by any of its EPSG codes.
pub fn frame_index(key: &str) -> Option<usize> {
    let k = key.trim();
    let code = k.trim_start_matches("EPSG:").parse::<u32>().ok();
    FRAMES.iter().position(|f| f.0.eq_ignore_ascii_case(k) || code.is_some_and(|c| c == f.1 || c == f.2 || c == f.3))
}

pub fn frame_name(i: usize) -> &'static str {
    FRAMES[i].0
}

pub fn frame_ellipsoid(i: usize) -> Ellipsoid {
    if FRAMES[i].4 == 1 {
        Ellipsoid::wgs84()
    } else {
        Ellipsoid::grs80()
    }
}

/// One step of a frame path: an EPSG operation, applied forward or inverse.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub op: usize,
    pub inverse: bool,
}

impl Step {
    pub fn epsg(&self) -> u32 {
        OPS[self.op].0
    }
    pub fn accuracy(&self) -> f64 {
        OPS[self.op].4
    }
    pub fn name(&self) -> &'static str {
        OPS[self.op].7
    }
    pub fn time_dependent(&self) -> bool {
        OPS[self.op].5[7..].iter().any(|&r| r != 0.0)
    }
    pub fn helmert(&self) -> Helmert {
        let o = &OPS[self.op];
        Helmert { p: o.5, epoch: o.6, position_vector: o.3 }
    }
}

/// The frame path from `src` to `dst`: the direct EPSG operation when one exists, otherwise
/// the fewest steps, ties broken by the smallest summed accuracy (unknown counts as 1 m).
pub fn path(src: usize, dst: usize) -> Option<Vec<Step>> {
    if src == dst {
        return Some(Vec::new());
    }
    let n = FRAMES.len();
    let acc = |i: usize| if OPS[i].4 < 0.0 { 1.0 } else { OPS[i].4 };
    // Dijkstra on (steps, accuracy) — the graph is tiny.
    let mut best: Vec<Option<(usize, f64, Vec<Step>)>> = vec![None; n];
    best[src] = Some((0, 0.0, Vec::new()));
    let mut done = vec![false; n];
    loop {
        let mut cur = None;
        for (i, b) in best.iter().enumerate() {
            if let Some((s, a, _)) = b {
                if !done[i] && cur.is_none_or(|(cs, ca, _): (usize, f64, usize)| (*s, *a) < (cs, ca)) {
                    cur = Some((*s, *a, i));
                }
            }
        }
        let Some((s, a, u)) = cur else { break };
        done[u] = true;
        if u == dst {
            break;
        }
        let route = best[u].as_ref().map(|b| b.2.clone()).unwrap_or_default();
        for (k, o) in OPS.iter().enumerate() {
            let (v, inverse) = if o.1 == u {
                (o.2, false)
            } else if o.2 == u {
                (o.1, true)
            } else {
                continue;
            };
            if done[v] {
                continue;
            }
            let cand = (s + 1, a + acc(k));
            if best[v].as_ref().is_none_or(|b| cand < (b.0, b.1)) {
                let mut r = route.clone();
                r.push(Step { op: k, inverse });
                best[v] = Some((cand.0, cand.1, r));
            }
        }
    }
    best[dst].take().map(|b| b.2)
}

/// Transform geodetic coordinates (degrees, metres) between frames at a coordinate epoch
/// (decimal year; None applies each operation at its reference epoch).
pub fn transform(steps: &[Step], src: usize, dst: usize, lon: f64, lat: f64, h: f64, epoch: Option<f64>) -> (f64, f64, f64) {
    let d = std::f64::consts::PI / 180.0;
    let mut x = frame_ellipsoid(src).to_ecef(lon * d, lat * d, h);
    for s in steps {
        let hm = s.helmert();
        x = if s.inverse { hm.inverse(x, epoch) } else { hm.forward(x, epoch) };
    }
    let (l, p, hh) = frame_ellipsoid(dst).from_ecef(x);
    (l / d, p / d, hh)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helmert_inverse_round_trips() {
        let h = Helmert { p: [0.5, -1.2, 3.0, 0.1, -0.2, 0.3, 1.5, 0.001, 0.002, -0.003, 0.0001, 0.0002, -0.0001, 0.01], epoch: 2010.0, position_vector: true };
        let x = [4_000_000.0, 1_000_000.0, 4_800_000.0];
        let y = h.forward(x, Some(2026.5));
        let z = h.inverse(y, Some(2026.5));
        // The linearised rotation's transpose is not its exact inverse (as in PROJ): about
        // |r|² × |x|, 10 µm for 0.3″ rotations at the Earth's surface.
        for i in 0..3 {
            assert!((x[i] - z[i]).abs() < 5e-5, "{i}: {}", x[i] - z[i]);
        }
    }

    #[test]
    fn ecef_round_trip() {
        let e = Ellipsoid::grs80();
        for &(l, p, h) in &[(0.3, 0.8, 120.0), (-2.0, -1.2, -50.0), (3.1, 1.55, 3000.0)] {
            let x = e.to_ecef(l, p, h);
            let (a, b, c) = e.from_ecef(x);
            assert!((a - l).abs() < 1e-12 && (b - p).abs() < 1e-11 && (c - h).abs() < 1e-5, "{a} {b} {c}");
        }
    }

    #[test]
    fn paths_exist_and_prefer_direct() {
        let i20 = frame_index("ITRF2020").unwrap();
        let i14 = frame_index("EPSG:7912").unwrap();
        let p = path(i14, i20).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].epsg(), 9991);
        assert!(!p[0].inverse);
        let g = frame_index("WGS 84 (G1762)").unwrap();
        let nad = frame_index("NAD83(2011)").unwrap();
        assert!(path(g, nad).is_some());
        for a in 0..frame_count() {
            for b in 0..frame_count() {
                assert!(path(a, b).is_some(), "{} → {}", frame_name(a), frame_name(b));
            }
        }
    }

    #[test]
    fn itrf2014_to_2020_matches_iers_magnitude() {
        // ITRF2014 → ITRF2020 at 2015.0: T = (1.4, 0.9, −1.4) mm, D = 0.42 ppb.
        let a = frame_index("ITRF2014").unwrap();
        let b = frame_index("ITRF2020").unwrap();
        let p = path(a, b).unwrap();
        let (lon, lat, h) = transform(&p, a, b, 10.0, 50.0, 100.0, Some(2015.0));
        let e = Ellipsoid::grs80();
        let d = std::f64::consts::PI / 180.0;
        let x0 = e.to_ecef(10.0 * d, 50.0 * d, 100.0);
        let x1 = e.to_ecef(lon * d, lat * d, h);
        let dist = ((x1[0] - x0[0]).powi(2) + (x1[1] - x0[1]).powi(2) + (x1[2] - x0[2]).powi(2)).sqrt();
        assert!(dist > 0.001 && dist < 0.006, "{dist}");
    }
}
