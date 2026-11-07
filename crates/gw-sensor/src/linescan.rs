//! Rigorous pushbroom (line-scanner) model from NITF support data (REQ-GAP-19): ephemeris from
//! CSEPHA, attitude quaternions from the CSATTA DES, the detector line and focal length from
//! CSSFAA, line timing from CSEXRA and USE00A. Field layouts follow GDAL's `nitf_spec.xml`
//! (CSEPHA, CSSFAA, CSEXRA, USE00A) and the CSATTA DES as DigitalGlobe/Maxar NITFs carry it
//! (a 52-byte user-defined subheader, then big-endian IEEE doubles); STDI-0006 itself was not
//! read, and the conventions below were established on the WorldView-3 corpus files against their
//! own RPC00B (`docs/validation/2.4/sensor.md`).
//!
//! - Time: seconds of the day. CSEXRA TIME_FIRST_LINE_IMAGE is the time of the first line; a
//!   negative TIME_IMAGE_DURATION is a reverse scan (time falls with the line number) and then the
//!   CSEPHA and CSATTA vectors run backwards in time from their T0. The line period is
//!   |duration| / (lines − 1), the lines being USE00A MAX_LP_SEG (the valid lines; NROWS is padded
//!   to whole blocks), or NROWS without USE00A.
//! - Position: ECEF metres, Lagrange-interpolated (8 points). Attitude: unit quaternions
//!   (q1, q2, q3, q4 = scalar) rotating camera → ECEF, Lagrange-interpolated (4 points) and
//!   renormalised.
//! - Camera: looks along +z; a ground point's focal-plane position is f·(vx/vz, vy/vz) mm. The
//!   detector line runs from CSSFAA START to FINISH (mm) with DELTA detectors; column c (corner
//!   origin) is detector c − 0.5 counted from NUM_FIR − 1.
//! - Light: velocity aberration from the inertial velocity, light time (Earth rotation during the
//!   flight of the light) and a standard-atmosphere refraction displacement
//!   K·tan z·(1 + tan² z), K = (n₀ − 1)·H·e^(−h/H) with n₀ − 1 = 2.9·10⁻⁴ and H = 8.4 km. These
//!   are physical constants, not fitted.
//! - Adjustable parameters (7): satellite position offsets in-track, cross-track, radial (m);
//!   small rotations of the camera frame about x, y, z (µrad); focal-length correction (mm). The
//!   a priori covariance comes from the CSEXRA CE90 (feet), split between position and attitude.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, geodetic_to_ecef};

const C_LIGHT: f64 = 299_792_458.0;
const OMEGA_E: f64 = 7.292_115_146_7e-5;
const REFRACTIVITY: f64 = 2.9e-4;
const SCALE_HEIGHT: f64 = 8400.0;
/// CE90 / σ per axis for a circular normal error.
const CE90_K: f64 = 2.1460;
/// The standard-atmosphere refraction constant K at sea level (m).
pub const REFRACTION_K: f64 = REFRACTIVITY * SCALE_HEIGHT;

pub const LINESCAN_PARAMS: [&str; 7] = ["in-track offset (m)", "cross-track offset (m)", "radial offset (m)", "rotation about camera x (µrad)", "rotation about camera y (µrad)", "rotation about camera z (µrad)", "focal length (mm)"];

#[derive(Clone, Debug)]
pub struct LineScanner {
    pub rows: f64,
    pub cols: f64,
    /// Time (s of day) of the first line and the signed line period (s per line).
    pub t_first: f64,
    pub period: f64,
    pub focal_mm: f64,
    /// Detector line ends in the focal plane (mm), detector count and the first detector number.
    pub det_start: [f64; 2],
    pub det_end: [f64; 2],
    pub n_det: f64,
    pub first_det: f64,
    /// Perspective-centre offset in the camera frame (m; CSSFAA OPPOFF).
    pub pc_offset: [f64; 3],
    /// Ephemeris and attitude in increasing time.
    pub eph_t0: f64,
    pub eph_dt: f64,
    pub eph: Vec<[f64; 3]>,
    pub att_t0: f64,
    pub att_dt: f64,
    pub att: Vec<[f64; 4]>,
    /// Aberration and light time; refraction constant K at sea level (m, 0 = off).
    pub aberration: bool,
    pub refraction_k: f64,
    /// Adjustable-parameter corrections and their a priori covariance (7 × 7).
    pub params: [f64; 7],
    pub cov: Option<Vec<f64>>,
    /// CE90 stated by the file (m), if any.
    pub ce90_m: f64,
    pub(crate) name: String,
}

fn lagrange<const N: usize>(v: &[[f64; N]], t0: f64, dt: f64, t: f64, order: usize) -> [f64; N] {
    let n = v.len();
    let order = order.min(n);
    let u = (t - t0) / dt;
    let i0 = ((u.floor() as isize) - (order as isize) / 2 + 1).clamp(0, (n - order) as isize) as usize;
    let mut out = [0.0; N];
    for i in i0..i0 + order {
        let mut w = 1.0;
        for j in i0..i0 + order {
            if j != i {
                w *= (u - j as f64) / (i as f64 - j as f64);
            }
        }
        for k in 0..N {
            out[k] += w * v[i][k];
        }
    }
    out
}

fn rot_q(q: [f64; 4]) -> [[f64; 3]; 3] {
    let [x, y, z, w] = q;
    [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ]
}
fn mv(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2])
}
fn mtv(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2])
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let n = norm(a);
    [a[0] / n, a[1] / n, a[2] / n]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
/// Small rotation (rad) about x, y, z: I + [δ]×, applied to camera-frame vectors.
fn small_rot(d: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [v[0] - d[2] * v[1] + d[1] * v[2], v[1] + d[2] * v[0] - d[0] * v[2], v[2] - d[1] * v[0] + d[0] * v[1]]
}

impl LineScanner {
    fn pos(&self, t: f64) -> [f64; 3] {
        lagrange(&self.eph, self.eph_t0, self.eph_dt, t, 8)
    }
    fn vel(&self, t: f64) -> [f64; 3] {
        let h = 1e-3;
        let (a, b) = (self.pos(t + h), self.pos(t - h));
        [0, 1, 2].map(|i| (a[i] - b[i]) / (2.0 * h))
    }
    fn quat(&self, t: f64) -> [f64; 4] {
        let q = lagrange(&self.att, self.att_t0, self.att_dt, t, 4);
        let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
        q.map(|v| v / n)
    }
    /// Camera position (ECEF) at t with the position corrections.
    fn centre(&self, t: f64, r: &[[f64; 3]; 3]) -> [f64; 3] {
        let p = self.pos(t);
        let v = self.vel(t);
        let radial = unit(p);
        let cross_t = unit(cross(p, v));
        let in_t = cross(cross_t, radial);
        let o = mv(r, self.pc_offset);
        [0, 1, 2].map(|i| p[i] + o[i] + self.params[0] * in_t[i] + self.params[1] * cross_t[i] + self.params[2] * radial[i])
    }
    fn time_span(&self) -> ((f64, f64), (f64, f64)) {
        ((self.eph_t0, self.eph_t0 + self.eph_dt * (self.eph.len() - 1) as f64), (self.att_t0, self.att_t0 + self.att_dt * (self.att.len() - 1) as f64))
    }
    /// Displace a ground point for refraction: the straight line to the camera at `p` meets the
    /// ground at the returned point.
    fn refract(&self, g: [f64; 3], p: [f64; 3], h: f64) -> [f64; 3] {
        if self.refraction_k == 0.0 {
            return g;
        }
        let up = unit(g);
        let d = unit(sub(p, g));
        let cz = dot(d, up).clamp(1e-3, 1.0);
        let tz = (1.0 - cz * cz).sqrt() / cz;
        let hz = [d[0] - cz * up[0], d[1] - cz * up[1], d[2] - cz * up[2]];
        let hn = norm(hz);
        if hn < 1e-12 {
            return g;
        }
        let k = self.refraction_k * (-h.max(-500.0) / SCALE_HEIGHT).exp() * tz * (1.0 + tz * tz);
        [0, 1, 2].map(|i| g[i] - k * hz[i] / hn)
    }
    /// Line of sight to a ground point in the camera frame at time t (apparent: refraction, light
    /// time and aberration applied, then the attitude corrections).
    fn cam_vec(&self, g: [f64; 3], h: f64, t: f64) -> [f64; 3] {
        let r = rot_q(self.quat(t));
        let p = self.centre(t, &r);
        let g = self.refract(g, p, h);
        let mut d = sub(g, p);
        if self.aberration {
            let tau = norm(d) / C_LIGHT;
            let (sn, cs) = (OMEGA_E * tau).sin_cos();
            let ge = [g[0] * cs + g[1] * sn, -g[0] * sn + g[1] * cs, g[2]];
            let u = unit(sub(ge, p));
            let v = self.vel(t);
            let vi = [v[0] - OMEGA_E * p[1], v[1] + OMEGA_E * p[0], v[2]];
            d = [0, 1, 2].map(|i| u[i] + vi[i] / C_LIGHT);
        }
        small_rot([self.params[3] * 1e-6, self.params[4] * 1e-6, self.params[5] * 1e-6], mtv(&r, d))
    }
    fn focal(&self) -> f64 {
        self.focal_mm + self.params[6]
    }
    /// Signed distance of a focal-plane point from the detector line, and its position along it
    /// (0 at START, 1 at FINISH).
    fn on_line(&self, xf: f64, yf: f64) -> (f64, f64) {
        let (sx, sy) = (self.det_start[0], self.det_start[1]);
        let (ex, ey) = (self.det_end[0] - sx, self.det_end[1] - sy);
        let l2 = ex * ex + ey * ey;
        let (px, py) = (xf - sx, yf - sy);
        ((px * ey - py * ex) / l2.sqrt(), (px * ex + py * ey) / l2)
    }
    fn time_of_row(&self, y: f64) -> f64 {
        self.t_first + (y - 0.5) * self.period
    }
}

impl SensorModel for LineScanner {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let ge = geodetic_to_ecef(g.lat, g.lon, g.h);
        let f = self.focal();
        let dist = |t: f64| -> Result<(f64, f64)> {
            let v = self.cam_vec(ge, g.h, t);
            if v[2] <= 0.0 {
                return Err(Error::range("the point is behind the sensor"));
            }
            Ok(self.on_line(f * v[0] / v[2], f * v[1] / v[2]))
        };
        let mut t = self.time_of_row(0.5 * self.rows);
        let ((e0, e1), (a0, a1)) = self.time_span();
        let (lo, hi) = (e0.max(a0), e1.min(a1));
        let h = 1e-4;
        for _ in 0..40 {
            let (d0, _) = dist(t)?;
            let (d1, _) = dist(t + h)?;
            let rate = (d1 - d0) / h;
            if rate.abs() < 1e-12 {
                return Err(Error::range("line scanner: the detector line does not sweep this point"));
            }
            let step = (d0 / rate).clamp(-5.0, 5.0);
            t -= step;
            if step.abs() < 1e-11 {
                break;
            }
        }
        if !(t >= lo - 1e-6 && t <= hi + 1e-6) {
            return Err(Error::range("the point is outside the time span of the ephemeris and attitude"));
        }
        let (_, u) = dist(t)?;
        Ok((u * (self.n_det - 1.0) + 0.5 + (self.first_det - 1.0), 0.5 + (t - self.t_first) / self.period))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        // A straight ray for the start, then Newton on the full ground → image (exact inverse).
        let t = self.time_of_row(y);
        let r = rot_q(self.quat(t));
        let p = self.centre(t, &r);
        let u = (x - 0.5 - (self.first_det - 1.0)) / (self.n_det - 1.0);
        let xf = self.det_start[0] + u * (self.det_end[0] - self.det_start[0]);
        let yf = self.det_start[1] + u * (self.det_end[1] - self.det_start[1]);
        let d = mv(&r, [xf, yf, self.focal()]);
        let g0 = crate::frame::ray_at_height(p, d, h)?;
        crate::invert_at_height(self, x, y, h, (g0.lat, g0.lon))
    }
    fn height_range(&self) -> (f64, f64) {
        (-500.0, 9000.0)
    }
    fn horizontal_sigma(&self) -> Option<f64> {
        (self.ce90_m > 0.0).then_some(self.ce90_m / CE90_K)
    }
    fn param_count(&self) -> usize {
        7
    }
    fn param_name(&self, i: usize) -> String {
        LINESCAN_PARAMS.get(i).map(|s| s.to_string()).unwrap_or_default()
    }
    fn param_covariance(&self) -> Option<Vec<f64>> {
        self.cov.clone()
    }
    fn param_step(&self, i: usize) -> f64 {
        match i {
            0..=2 => 0.1,
            3..=5 => 0.1,
            _ => 1e-3,
        }
    }
    fn with_params(&self, d: &[f64]) -> Result<Box<dyn SensorModel>> {
        if d.len() != 7 {
            return Err(Error::invalid("line scanner: seven parameter corrections expected"));
        }
        let mut m = self.clone();
        for i in 0..7 {
            m.params[i] += d[i];
        }
        Ok(Box::new(m))
    }
}

/// The raw NITF support data of one image (text of the TREs, the CSATTA DES subheader fields and
/// data).
pub struct NitfSupport<'a> {
    pub rows: f64,
    pub cols: f64,
    /// IDATIM or the acquisition date, YYYYMMDD….
    pub image_date: &'a str,
    pub csepha: &'a [u8],
    pub csatta_header: &'a [u8],
    pub csatta_data: &'a [u8],
    pub cssfaa: &'a [u8],
    pub csexra: &'a [u8],
    pub use00a: Option<&'a [u8]>,
    /// CSSFAA band (0-based) whose detector line to use.
    pub band: usize,
}

struct Txt<'a> {
    b: &'a [u8],
    o: usize,
    what: &'static str,
}

impl Txt<'_> {
    fn s(&mut self, n: usize) -> Result<&str> {
        let s = self.b.get(self.o..self.o + n).ok_or_else(|| gw_abi::err!(INVALID, "{tre} is shorter than its fields", tre = self.what))?;
        self.o += n;
        std::str::from_utf8(s).map_err(|_| gw_abi::err!(INVALID, "{tre} has non-ASCII text", tre = self.what))
    }
    fn f(&mut self, n: usize) -> Result<f64> {
        let what = self.what;
        let v = self.s(n)?.trim();
        v.parse::<f64>().map_err(|_| gw_abi::err!(INVALID, "{tre}: \"{v}\" is not a number", tre = what, v = v))
    }
}

fn be_f64(b: &[u8], i: usize) -> f64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[i..i + 8]);
    f64::from_be_bytes(a)
}

/// HHMMSS.ssssss → seconds of the day.
fn hms(s: &str) -> Result<f64> {
    let s = s.trim();
    if s.len() < 6 {
        return Err(Error::invalid("time is not HHMMSS.ssssss"));
    }
    let h: f64 = s[0..2].parse().map_err(|_| Error::invalid("bad hour"))?;
    let m: f64 = s[2..4].parse().map_err(|_| Error::invalid("bad minute"))?;
    let sec: f64 = s[4..].parse().map_err(|_| Error::invalid("bad second"))?;
    Ok(h * 3600.0 + m * 60.0 + sec)
}

/// Days from 2000-01-01 of YYYYMMDD (proleptic Gregorian).
fn day_number(s: &str) -> Result<i64> {
    let s = s.trim();
    if s.len() < 8 {
        return Err(Error::invalid("date is not YYYYMMDD"));
    }
    let y: i64 = s[0..4].parse().map_err(|_| Error::invalid("bad year"))?;
    let m: i64 = s[4..6].parse().map_err(|_| Error::invalid("bad month"))?;
    let d: i64 = s[6..8].parse().map_err(|_| Error::invalid("bad day"))?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(Error::invalid("date is not YYYYMMDD"));
    }
    // Days from the civil date (H. Hinnant's algorithm), relative to 2000-01-01.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Ok(era * 146_097 + doe - 719_468 - 10_957)
}

impl LineScanner {
    /// Build the model from the NITF support data.
    pub fn from_nitf(s: &NitfSupport) -> Result<LineScanner> {
        let day0 = day_number(s.image_date)?;
        // CSEPHA
        let mut e = Txt { b: s.csepha, o: 0, what: "CSEPHA" };
        e.s(12)?;
        let edt = e.f(5)?;
        let edate = day_number(e.s(8)?)?;
        let et0 = hms(e.s(13)?)? + 86400.0 * (edate - day0) as f64;
        let en = e.f(3)? as usize;
        if en < 8 || !(edt > 0.0) {
            return Err(Error::invalid("CSEPHA: needs eight or more ephemeris vectors and a positive interval"));
        }
        let mut eph = Vec::with_capacity(en);
        for _ in 0..en {
            eph.push([e.f(12)?, e.f(12)?, e.f(12)?]);
        }
        // CSATTA DES: ATT_TYPE 12, DT_ATT 14, DATE_ATT 8, T0_ATT 13, NUM_ATT 5; quaternions as
        // big-endian doubles.
        let mut a = Txt { b: s.csatta_header, o: 0, what: "CSATTA" };
        a.s(12)?;
        let adt = a.f(14)?;
        let adate = day_number(a.s(8)?)?;
        let at0 = hms(a.s(13)?)? + 86400.0 * (adate - day0) as f64;
        let an = a.f(5)? as usize;
        if an < 4 || !(adt > 0.0) || s.csatta_data.len() < an * 32 {
            return Err(Error::invalid("CSATTA: needs four or more quaternions (32 bytes each) and a positive interval"));
        }
        let mut att: Vec<[f64; 4]> = (0..an).map(|k| [0, 1, 2, 3].map(|j| be_f64(s.csatta_data, 32 * k + 8 * j))).collect();
        for q in &att {
            let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
            if !((n - 1.0).abs() < 1e-3) {
                return Err(Error::invalid("CSATTA: a quaternion is not a unit quaternion"));
            }
        }
        // CSEXRA: SENSOR 6, TIME_FIRST_LINE_IMAGE 12, TIME_IMAGE_DURATION 12, …, CIRCL_ERR at 126.
        let mut x = Txt { b: s.csexra, o: 0, what: "CSEXRA" };
        x.s(6)?;
        let t_first = x.f(12)?;
        let dur = x.f(12)?;
        let ce90_ft = std::str::from_utf8(s.csexra.get(126..129).unwrap_or(b"")).ok().and_then(|v| v.trim().parse::<f64>().ok()).unwrap_or(f64::NAN);
        let reverse = dur < 0.0;
        // USE00A MAX_LP_SEG (valid lines) at 79..85.
        let valid = s.use00a.and_then(|u| u.get(79..85)).and_then(|v| std::str::from_utf8(v).ok()).and_then(|v| v.trim().parse::<f64>().ok()).filter(|v| *v >= 2.0 && *v <= s.rows);
        let lines = valid.unwrap_or(s.rows);
        if !(dur.abs() > 0.0) || lines < 2.0 {
            return Err(Error::invalid("CSEXRA: the image duration is zero"));
        }
        let period = dur / (lines - 1.0);
        // Store the vectors in increasing time.
        let (eph_t0, att_t0) = if reverse {
            eph.reverse();
            att.reverse();
            (et0 - edt * (en - 1) as f64, at0 - adt * (an - 1) as f64)
        } else {
            (et0, at0)
        };
        for k in 1..att.len() {
            let d: f64 = (0..4).map(|i| att[k][i] * att[k - 1][i]).sum();
            if d < 0.0 {
                att[k] = att[k].map(|v| -v);
            }
        }
        // CSSFAA: NUM_BANDS 1, then per band BAND_TYPE 1, BAND_ID 6, FOC_LENGTH 11, NUM_DAP 8,
        // NUM_FIR 8, DELTA 7, OPPOFF_X/Y/Z 7 each, START_X/Y, FINISH_X/Y 11 each.
        let mut c = Txt { b: s.cssfaa, o: 0, what: "CSSFAA" };
        let nb = c.f(1)? as usize;
        if s.band >= nb.max(1) {
            return Err(Error::invalid("CSSFAA: no such band"));
        }
        let mut band = None;
        for i in 0..nb {
            c.s(1)?;
            c.s(6)?;
            let f = c.f(11)?;
            c.f(8)?;
            let fir = c.f(8)?;
            let n = c.f(7)?;
            let opp = [c.f(7)?, c.f(7)?, c.f(7)?];
            let st = [c.f(11)?, c.f(11)?];
            let fi = [c.f(11)?, c.f(11)?];
            if i == s.band {
                band = Some((f, fir, n, opp, st, fi));
            }
        }
        let (focal_mm, first_det, n_det, pc_offset, det_start, det_end) = band.ok_or_else(|| Error::invalid("CSSFAA: no bands"))?;
        if !(focal_mm > 0.0 && n_det >= 2.0) || (det_start[0] - det_end[0]).hypot(det_start[1] - det_end[1]) == 0.0 {
            return Err(Error::invalid("CSSFAA: needs a focal length, two or more detectors and a detector line"));
        }
        let mut m = LineScanner {
            rows: s.rows,
            cols: s.cols,
            t_first,
            period,
            focal_mm,
            det_start,
            det_end,
            n_det,
            first_det: first_det.max(1.0),
            pc_offset,
            eph_t0,
            eph_dt: edt,
            eph,
            att_t0,
            att_dt: adt,
            att,
            aberration: true,
            refraction_k: REFRACTIVITY * SCALE_HEIGHT,
            params: [0.0; 7],
            cov: None,
            ce90_m: if ce90_ft > 0.0 { ce90_ft * 0.3048 } else { f64::NAN },
            name: String::new(),
        };
        // The image's time span must lie inside the support data.
        let ((e0, e1), (a0, a1)) = m.time_span();
        let t0 = m.t_first;
        let valid_end = m.time_of_row(lines);
        let (vlo, vhi) = (t0.min(valid_end), t0.max(valid_end));
        if vlo < e0.max(a0) - 1e-6 || vhi > e1.min(a1) + 1e-6 {
            return Err(Error::invalid("the ephemeris and attitude do not cover the image's time span"));
        }
        m.cov = m.a_priori_cov();
        m.name = if reverse { "Pushbroom (CSEPHA/CSATTA, reverse scan)".into() } else { "Pushbroom (CSEPHA/CSATTA)".into() };
        Ok(m)
    }

    /// A priori covariance from the CSEXRA CE90: σ per horizontal axis = CE90 / 2.146, half of the
    /// variance to the satellite position, half to the attitude; radial position σ the same as
    /// horizontal; yaw and focal length loosely constrained.
    pub(crate) fn a_priori_cov(&self) -> Option<Vec<f64>> {
        if !(self.ce90_m > 0.0) {
            return None;
        }
        let s = self.ce90_m / CE90_K;
        let t = 0.5 * (self.t_first + self.time_of_row(self.rows));
        let range = {
            let p = self.pos(t);
            norm(p) - 6_371_000.0
        }
        .max(1000.0);
        let half = s / std::f64::consts::SQRT_2;
        let att = half / range * 1e6; // µrad
        let var = [half * half, half * half, s * s, att * att, att * att, 100.0 * 100.0, 1e-2];
        let mut c = vec![0.0; 49];
        for i in 0..7 {
            c[i * 8] = var[i];
        }
        Some(c)
    }

    /// The flat record (for the analysis worker):
    /// [1, rows, cols, t_first, period, focal, start ×2, end ×2, n_det, first_det, pc_offset ×3,
    /// aberration, refraction K, ce90, params ×7, cov flag (+ 49), n_eph, t0, dt, xyz…, n_att, t0,
    /// dt, q×4…].
    pub fn to_record(&self) -> Vec<f64> {
        let mut r = vec![1.0, self.rows, self.cols, self.t_first, self.period, self.focal_mm, self.det_start[0], self.det_start[1], self.det_end[0], self.det_end[1], self.n_det, self.first_det];
        r.extend_from_slice(&self.pc_offset);
        r.extend_from_slice(&[if self.aberration { 1.0 } else { 0.0 }, self.refraction_k, self.ce90_m]);
        r.extend_from_slice(&self.params);
        match &self.cov {
            Some(c) => {
                r.push(1.0);
                r.extend_from_slice(c);
            }
            None => r.push(0.0),
        }
        r.extend_from_slice(&[self.eph.len() as f64, self.eph_t0, self.eph_dt]);
        for p in &self.eph {
            r.extend_from_slice(p);
        }
        r.extend_from_slice(&[self.att.len() as f64, self.att_t0, self.att_dt]);
        for q in &self.att {
            r.extend_from_slice(q);
        }
        r
    }

    pub fn from_record(a: &[f64], name: &str) -> Result<LineScanner> {
        let bad = || Error::invalid("line-scanner record is malformed");
        if a.len() < 30 || a[0] != 1.0 {
            return Err(bad());
        }
        let mut o = 25;
        let cov = if a[o] != 0.0 {
            let c = a.get(o + 1..o + 50).ok_or_else(bad)?.to_vec();
            o += 50;
            Some(c)
        } else {
            o += 1;
            None
        };
        let ne = *a.get(o).ok_or_else(bad)? as usize;
        let (et0, edt) = (*a.get(o + 1).ok_or_else(bad)?, *a.get(o + 2).ok_or_else(bad)?);
        o += 3;
        let eph: Vec<[f64; 3]> = a.get(o..o + 3 * ne).ok_or_else(bad)?.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        o += 3 * ne;
        let na = *a.get(o).ok_or_else(bad)? as usize;
        let (at0, adt) = (*a.get(o + 1).ok_or_else(bad)?, *a.get(o + 2).ok_or_else(bad)?);
        o += 3;
        let att: Vec<[f64; 4]> = a.get(o..o + 4 * na).ok_or_else(bad)?.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect();
        o += 4 * na;
        if o != a.len() || ne < 8 || na < 4 || !(edt > 0.0 && adt > 0.0 && a[4] != 0.0 && a[5] > 0.0 && a[10] >= 2.0) {
            return Err(bad());
        }
        let mut params = [0.0; 7];
        params.copy_from_slice(&a[18..25]);
        Ok(LineScanner {
            rows: a[1],
            cols: a[2],
            t_first: a[3],
            period: a[4],
            focal_mm: a[5],
            det_start: [a[6], a[7]],
            det_end: [a[8], a[9]],
            n_det: a[10],
            first_det: a[11],
            pc_offset: [a[12], a[13], a[14]],
            aberration: a[15] != 0.0,
            refraction_k: a[16],
            ce90_m: a[17],
            params,
            cov,
            eph_t0: et0,
            eph_dt: edt,
            eph,
            att_t0: at0,
            att_dt: adt,
            att,
            name: if name.is_empty() { "Pushbroom (CSEPHA/CSATTA)".into() } else { name.into() },
        })
    }

    /// An error unless the ephemeris and attitude cover every line of the image.
    pub fn check_coverage(&self) -> Result<()> {
        let ((e0, e1), (a0, a1)) = self.time_span();
        let (t0, t1) = (self.time_of_row(0.0), self.time_of_row(self.rows));
        if t0.min(t1) < e0.max(a0) - 1e-6 || t0.max(t1) > e1.min(a1) + 1e-6 {
            return Err(Error::invalid("the ephemeris and attitude do not cover the image's time span"));
        }
        Ok(())
    }

    /// The same model under another name.
    pub fn named(mut self, name: &str) -> LineScanner {
        self.name = name.to_string();
        self
    }

    /// Satellite position (ECEF) and camera → ECEF rotation at an image line (for tests).
    pub fn state_at_row(&self, y: f64) -> ([f64; 3], [[f64; 3]; 3]) {
        let t = self.time_of_row(y);
        let r = rot_q(self.quat(t));
        (self.centre(t, &r), r)
    }

    /// Off-nadir angle (degrees) at the image centre.
    pub fn off_nadir_deg(&self) -> f64 {
        let (p, r) = self.state_at_row(0.5 * self.rows);
        let look = mv(&r, [0.0, 0.0, 1.0]);
        let (lat, lon, _) = ecef_to_geodetic(p[0], p[1], p[2]);
        let (la, lo) = (lat.to_radians(), lon.to_radians());
        let down = [-la.cos() * lo.cos(), -la.cos() * lo.sin(), -la.sin()];
        dot(unit(look), down).clamp(-1.0, 1.0).acos().to_degrees()
    }

}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A synthetic straight-orbit scanner: 620 km up, flying north at 7.5 km/s, nadir-looking,
    /// 0.31 m pixels.
    pub fn synthetic(reverse: bool) -> LineScanner {
        let (lat0, lon0) = (30.0f64, -81.0f64);
        let r0 = 6_378_137.0 + 620_000.0;
        let w = 7500.0 / r0; // rad/s along the meridian
        let n = 200;
        let dt = 0.1;
        let t0 = 58000.0;
        let mut eph = Vec::new();
        let mut att = Vec::new();
        for k in 0..n {
            let t = k as f64 * dt - 10.0;
            let lat = (lat0 + (w * t).to_degrees()).to_radians();
            let lon = lon0.to_radians();
            let p = [r0 * lat.cos() * lon.cos(), r0 * lat.cos() * lon.sin(), r0 * lat.sin()];
            eph.push(p);
            // Camera z down (−r̂), x along track (north), y = z × x.
            let z = unit([-p[0], -p[1], -p[2]]);
            let north = [-lat.sin() * lon.cos(), -lat.sin() * lon.sin(), lat.cos()];
            let x = north;
            let y = cross(z, x);
            // Rotation camera → ECEF has columns x, y, z; to a quaternion.
            let m = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
            let tr = m[0][0] + m[1][1] + m[2][2];
            let qw = (1.0 + tr).max(0.0).sqrt() / 2.0;
            let q = if qw > 1e-3 {
                [(m[2][1] - m[1][2]) / (4.0 * qw), (m[0][2] - m[2][0]) / (4.0 * qw), (m[1][0] - m[0][1]) / (4.0 * qw), qw]
            } else {
                let qx = (1.0 + m[0][0] - m[1][1] - m[2][2]).max(0.0).sqrt() / 2.0;
                [qx, (m[0][1] + m[1][0]) / (4.0 * qx), (m[0][2] + m[2][0]) / (4.0 * qx), (m[2][1] - m[1][2]) / (4.0 * qx)]
            };
            att.push(q);
        }
        let f = 16000.0;
        let mut m = LineScanner {
            rows: 20000.0,
            cols: 20000.0,
            t_first: t0,
            period: if reverse { -5e-5 } else { 5e-5 },
            focal_mm: f,
            det_start: [0.0, 80.0],
            det_end: [0.0, -80.0],
            n_det: 20001.0,
            first_det: 1.0,
            pc_offset: [0.0; 3],
            eph_t0: t0 - 10.0,
            eph_dt: dt,
            eph,
            att_t0: t0 - 10.0,
            att_dt: dt,
            att,
            aberration: true,
            refraction_k: REFRACTIVITY * SCALE_HEIGHT,
            params: [0.0; 7],
            cov: None,
            ce90_m: 5.0,
            name: "synthetic".into(),
        };
        m.cov = m.a_priori_cov();
        m
    }

    #[test]
    fn round_trip_and_off_nadir() {
        for rev in [false, true] {
            let m = synthetic(rev);
            let mut worst = 0f64;
            for j in 0..=6 {
                for i in 0..=6 {
                    let (x, y) = (0.5 + i as f64 * 3333.0, 0.5 + j as f64 * 3333.0);
                    for h in [-50.0, 300.0, 2500.0] {
                        let g = m.image_to_ground(x, y, h).unwrap();
                        let (x2, y2) = m.ground_to_image(g).unwrap();
                        worst = worst.max((x2 - x).hypot(y2 - y));
                    }
                }
            }
            assert!(worst < 1e-6, "round trip {worst} px");
            // The synthetic camera looks to the geocentre: 0.17° off the geodetic vertical at 30° N.
            assert!((m.off_nadir_deg() - 0.166).abs() < 0.02, "{}", m.off_nadir_deg());
            // Aberration moves the ground point along track by v/c × range ≈ 15.5 m.
            let c = m.image_to_ground(10000.5, 10000.5, 0.0).unwrap();
            let mut n = m.clone();
            n.aberration = false;
            n.refraction_k = 0.0;
            let s = n.image_to_ground(10000.5, 10000.5, 0.0).unwrap();
            let d = gw_geodesy::geodesic::inverse(c.lat, c.lon, s.lat, s.lon).0;
            assert!(d > 13.0 && d < 18.0, "aberration shift {d} m");
        }
    }

    #[test]
    fn record_round_trip_and_params() {
        let m = synthetic(true);
        let r = m.to_record();
        let b = LineScanner::from_record(&r, "x").unwrap();
        let g = m.image_to_ground(1234.5, 5678.5, 100.0).unwrap();
        let (p, q) = (m.ground_to_image(g).unwrap(), b.ground_to_image(g).unwrap());
        assert!((p.0 - q.0).abs() < 1e-9 && (p.1 - q.1).abs() < 1e-9);
        // 1 m in-track ≈ 2.93 lines (0.342 m of ground per line); 1 m cross-track ≈ 3.2 columns
        // (0.31 m GSD).
        let j = m.param_partials(g).unwrap();
        assert!((j[0][1].abs() - 2.93).abs() < 0.05, "{:?}", j[0]);
        assert!((j[1][0].abs() - 1.0 / 0.31).abs() < 0.2, "{:?}", j[1]);
        // A priori CE90 reproduces the stated 5 m.
        let e = crate::error::mono_point_error(&m, 1234.5, 5678.5, 100.0, 0.0, f64::NAN).unwrap();
        assert!((e.ce90 - 5.0).abs() < 0.3, "ce90 {}", e.ce90);
        assert!(LineScanner::from_record(&r[..r.len() - 1], "x").is_err());
    }

    #[test]
    fn dates_and_times() {
        assert_eq!(day_number("20000101").unwrap(), 0);
        assert_eq!(day_number("20150121").unwrap() - day_number("20141231").unwrap(), 21);
        assert!((hms("161255.916222").unwrap() - 58375.916222).abs() < 1e-9);
    }
}
