//! Aerial triangulation (REQ-GAP-22, GR-08): a photogrammetric bundle adjustment of frame
//! cameras. Unknowns:
//!
//! - per image, the exterior orientation (perspective centre and attitude);
//! - per camera, the interior orientation with self-calibration: focal length, principal point,
//!   radial k1–k4 (Brown, r² in mm; or the equidistant fisheye in θ²), decentring p1, p2 and the
//!   affinity b1, b2, each free, free with an a priori σ, or held;
//! - per camera, the GNSS lever arm (camera frame, m) and the IMU boresight (small rotations);
//! - per point, the ground coordinates (eliminated by the Schur complement).
//!
//! Observations: image measurements (σ px, optional Huber or Cauchy weighting and blunder
//! rejection), GCPs (σ horizontal, vertical), GNSS antenna positions (σ E, N, U), IMU attitudes
//! (σ per axis) and a priori parameter values. The datum comes from GCPs, GNSS or held images;
//! a block without one, or whose normal matrix is singular, is refused with the parameter named.
//! Film images carry their scan's film → pixel affine (`fiducial::fiducial_io`).
//!
//! The solver works in a local Cartesian frame (ENU at the block centre, an exact rotation of
//! ECEF), runs Levenberg–Marquardt with the point blocks eliminated, and is stepped one iteration
//! at a time (`Aero::step`) so the worker can report progress and honour cancel between steps.
//! The report gives σ₀, residuals, check-point statistics (multi-ray 3-D, single-ray horizontal
//! at the known height, and image-space), the parameter covariance (σ and the IO correlation
//! matrices) and every strongly correlated pair of parameters (weak geometry).
//!
//! Conventions as `gw_sensor::frame`: the camera looks along −z, image x right, y up (mm); the
//! attitude rotates the local frame into the camera frame; pixels are corner-origin.

use gw_adjust::block::{axis_stats, AxisStats, ObsIn, PointIn, PointKind};
use crate::geom::*;
use gw_adjust::linalg::{cholesky, Mat};
use gw_abi::{Error, Json, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, enu_rotation, geodetic_to_ecef};
use gw_sensor::Ground;

/// Interior orientation parameters, in this order.
pub const NIO: usize = 11;
pub const IO_NAMES: [&str; NIO] = ["f", "x0", "y0", "k1", "k2", "k3", "k4", "p1", "p2", "b1", "b2"];
pub const MOUNT_NAMES: [&str; 6] = ["lever x", "lever y", "lever z", "boresight x", "boresight y", "boresight z"];
pub const EO_NAMES: [&str; 6] = ["X", "Y", "Z", "rotation x", "rotation y", "rotation z"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Projection {
    Brown,
    Fisheye,
}

#[derive(Clone, Debug)]
pub struct CameraIn {
    pub projection: Projection,
    /// Film: each image gives its own film-mm → pixel affine; `pixel_mm` is then unused.
    pub film: bool,
    pub pixel_mm: f64,
    pub width: f64,
    pub height: f64,
    /// [f, x0, y0 (mm, from the format centre or the fiducial centre), k1..k4, p1, p2, b1, b2].
    pub io: [f64; NIO],
    pub io_free: [bool; NIO],
    /// A priori σ of a free parameter about its given value (0: no prior).
    pub io_sigma: [f64; NIO],
    /// Lever arm (camera frame, m) and boresight (rad): the antenna is at C + Rᵀ·lever, and the
    /// camera attitude is exp([β]×) times the IMU attitude.
    pub mount: [f64; 6],
    pub mount_free: [bool; 6],
    pub mount_sigma: [f64; 6],
}

#[derive(Clone, Debug)]
pub struct ImageIn {
    pub camera: usize,
    pub fixed: bool,
    /// Approximate (or observed) perspective centre and ENU-at-centre → camera rotation.
    pub approx: Option<(Ground, M3)>,
    /// The attitude in `approx` is known (else nadir is assumed and the heading is fitted).
    pub attitude_known: bool,
    /// The approx position is a GNSS antenna observation with σ (E, N, U, m).
    pub gnss: Option<[f64; 3]>,
    /// The approx attitude is an IMU observation with σ (rad, about the camera axes).
    pub imu: Option<[f64; 3]>,
    /// Film-mm → pixel affine (col = a0 + a1 x + a2 y; row = a3 + a4 x + a5 y).
    pub film: Option<[f64; 6]>,
}

/// The RMS distance of points from their best-fit line, in their own units.
fn line_spread(points: &[V3]) -> f64 {
    let n = points.len().max(1) as f64;
    let mut c = [0.0; 3];
    for p in points {
        for t in 0..3 {
            c[t] += p[t] / n;
        }
    }
    let mut cov = [[0.0; 3]; 3];
    for p in points {
        for r in 0..3 {
            for s in 0..3 {
                cov[r][s] += (p[r] - c[r]) * (p[s] - c[s]) / n;
            }
        }
    }
    sym_eigen(&cov).0[1].max(0.0).sqrt()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Robust {
    None,
    Huber(f64),
    Cauchy(f64),
}

#[derive(Clone, Debug)]
pub struct AeroOptions {
    pub max_iterations: usize,
    pub robust: Robust,
    /// Flag observations whose residual exceeds k·σ·σ₀ (2-D norm).
    pub reject_k: f64,
    /// Remove up to this many flagged observations, worst first, re-solving after each.
    pub max_reject: usize,
    /// Report parameter pairs whose correlation reaches this (IO or mount involved).
    pub corr_flag: f64,
    /// Flag IO and mount parameters whose global correlation (with all the other parameters
    /// together) reaches this: weak geometry that no single pair shows.
    pub global_flag: f64,
}

impl Default for AeroOptions {
    fn default() -> Self {
        AeroOptions { max_iterations: 60, robust: Robust::None, reject_k: 4.0, max_reject: 0, corr_flag: 0.9, global_flag: 0.99 }
    }
}

// ---- the camera model --------------------------------------------------------------------

fn ideal(proj: Projection, f: f64, v: V3) -> Option<(f64, f64)> {
    match proj {
        Projection::Brown => (v[2] < 0.0).then(|| (-f * v[0] / v[2], -f * v[1] / v[2])),
        Projection::Fisheye => {
            let rho = v[0].hypot(v[1]);
            let th = rho.atan2(-v[2]);
            if !(th < 100f64.to_radians()) {
                return None;
            }
            let s = if rho > 1e-12 * v[2].abs().max(1e-300) { th / rho } else { -1.0 / v[2] };
            Some((f * v[0] * s, f * v[1] * s))
        }
    }
}

fn distort(proj: Projection, io: &[f64; NIO], x: f64, y: f64) -> (f64, f64) {
    let r2 = x * x + y * y;
    let s = if proj == Projection::Fisheye { r2 / (io[0] * io[0]) } else { r2 };
    let rad = 1.0 + s * (io[3] + s * (io[4] + s * (io[5] + s * io[6])));
    (x * rad + io[7] * (r2 + 2.0 * x * x) + 2.0 * io[8] * x * y, y * rad + io[8] * (r2 + 2.0 * y * y) + 2.0 * io[7] * x * y)
}

/// Camera-frame vector → pixel.
pub fn project(cam: &CameraIn, io: &[f64; NIO], film: Option<&[f64; 6]>, v: V3) -> Option<(f64, f64)> {
    let (x, y) = ideal(cam.projection, io[0], v)?;
    let (xd, yd) = distort(cam.projection, io, x, y);
    let xf = xd * (1.0 + io[9]) - yd * io[10] + io[1];
    let yf = yd + io[2];
    Some(match film {
        Some(a) => (a[0] + a[1] * xf + a[2] * yf, a[3] + a[4] * xf + a[5] * yf),
        None => (cam.width / 2.0 + xf / cam.pixel_mm, cam.height / 2.0 - yf / cam.pixel_mm),
    })
}

/// Pixel → camera-frame ray (unit vector).
pub fn back_project(cam: &CameraIn, io: &[f64; NIO], film: Option<&[f64; 6]>, col: f64, row: f64) -> Option<V3> {
    let (xf, yf) = match film {
        Some(a) => {
            let det = a[1] * a[5] - a[2] * a[4];
            if det.abs() < 1e-300 {
                return None;
            }
            let (dc, dr) = (col - a[0], row - a[3]);
            ((a[5] * dc - a[2] * dr) / det, (-a[4] * dc + a[1] * dr) / det)
        }
        None => ((col - cam.width / 2.0) * cam.pixel_mm, -(row - cam.height / 2.0) * cam.pixel_mm),
    };
    let yd = yf - io[2];
    let xd = (xf - io[1] + yd * io[10]) / (1.0 + io[9]);
    let (mut x, mut y) = (xd, yd);
    for _ in 0..30 {
        let (a, b) = distort(cam.projection, io, x, y);
        let (ex, ey) = (xd - a, yd - b);
        x += ex;
        y += ey;
        if ex.abs() + ey.abs() < 1e-13 * io[0].abs().max(1.0) {
            break;
        }
    }
    let f = io[0];
    let d = match cam.projection {
        Projection::Brown => [x, y, -f],
        Projection::Fisheye => {
            let r = x.hypot(y);
            if r < 1e-15 {
                [0.0, 0.0, -1.0]
            } else {
                let (s, c) = (r / f).sin_cos();
                [s * x / r, s * y / r, -c]
            }
        }
    };
    let n = norm(d);
    (n > 0.0 && n.is_finite()).then(|| scale(d, 1.0 / n))
}

/// The half-diagonal of the format (mm), for parameter steps and scaling.
fn format_radius(cam: &CameraIn) -> f64 {
    if cam.film {
        // Typical 230 mm film; the fiducial affine gives the true size per image.
        return 150.0;
    }
    (0.5 * cam.width.hypot(cam.height) * cam.pixel_mm).max(1e-6)
}

/// Finite-difference step of each IO parameter.
fn io_step(cam: &CameraIn, io: &[f64; NIO], q: usize) -> f64 {
    let r = format_radius(cam);
    let s = if cam.projection == Projection::Fisheye { (r / io[0]).powi(2).max(1e-6) } else { r * r };
    match q {
        0 => 1e-5 * io[0].abs().max(1e-3),
        1 | 2 => 1e-5 * io[0].abs().max(1e-3),
        3..=6 => 1e-4 / s.powi(q as i32 - 2),
        7 | 8 => 1e-5 / r,
        _ => 1e-6,
    }
}

// ---- the problem and its state ---------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamKind {
    Eo,
    Io,
    Mount,
}

#[derive(Clone, Copy, Debug)]
pub struct ParamId {
    pub kind: ParamKind,
    /// The image (EO) or camera (IO, mount).
    pub owner: usize,
    pub which: usize,
}

#[derive(Clone)]
struct State {
    c: Vec<V3>,
    r: Vec<M3>,
    io: Vec<[f64; NIO]>,
    mount: Vec<[f64; 6]>,
    x: Vec<Option<V3>>,
}

#[derive(Clone, Debug, Default)]
pub struct Progress {
    pub iteration: usize,
    pub cost: f64,
    pub lambda: f64,
    pub rejected: usize,
    pub done: bool,
    /// The last accepted step's largest parameter change, in units of the scaled normal matrix.
    pub step: f64,
}

struct PtBlock {
    nxx: M3,
    bx: V3,
    rows: Vec<(usize, V3)>,
}

struct Normal {
    s: Mat,
    b: Vec<f64>,
    pts: Vec<Option<PtBlock>>,
    cost: f64,
}

pub struct Aero {
    pub cams: Vec<CameraIn>,
    pub images: Vec<ImageIn>,
    pub points: Vec<PointIn>,
    pub obs: Vec<ObsIn>,
    pub opts: AeroOptions,
    origin: Ground,
    o_ecef: V3,
    /// ECEF → local rotation.
    e_o: M3,
    eo_off: Vec<Option<usize>>,
    io_idx: Vec<[Option<usize>; NIO]>,
    mount_idx: Vec<[Option<usize>; 6]>,
    pub params: Vec<ParamId>,
    st: State,
    gnss: Vec<Option<V3>>,
    imu: Vec<Option<M3>>,
    gcp: Vec<Option<V3>>,
    by_point: Vec<Vec<usize>>,
    active: Vec<bool>,
    /// Points in the solve (ties with ≥ 2 rays, GCPs with ≥ 1, checkpoints with ≥ 2).
    used: Vec<bool>,
    weights: Vec<f64>,
    lambda: f64,
    cost: f64,
    last_step: f64,
    /// The relative cost change of the last accepted step.
    last_rel: f64,
    iteration: usize,
    /// Iterations since the last rejection (the limit applies per solve).
    round: usize,
    /// The 15-iteration rejection trigger fired (`forced`), or fired and found nothing to reject
    /// (`no_force`: not again this round).
    forced: bool,
    no_force: bool,
    converged: bool,
    finished: bool,
    pub rejected: Vec<usize>,
    pub notes: Vec<String>,
    /// How each image got its approximation: 0 given, 1 nadir planimetric fit, 2 resection.
    pub approx_kind: Vec<u8>,
    /// Images left out: no approximation could be made (no position, no attitude, no control).
    pub excluded: Vec<bool>,
}

/// "1, 2, 5" (image numbers in notes).
fn numbers(v: &[usize]) -> String {
    let mut s = String::new();
    for (n, i) in v.iter().enumerate() {
        if n > 0 {
            s.push_str(", ");
        }
        s.push_str(&i.to_string());
    }
    s
}

fn huber_weight(r: Robust, z: f64) -> (f64, f64) {
    // (weight, ρ(z)) for the normalised residual magnitude z.
    match r {
        Robust::None => (1.0, z * z),
        Robust::Huber(k) => {
            if z <= k {
                (1.0, z * z)
            } else {
                (k / z, 2.0 * k * z - k * k)
            }
        }
        Robust::Cauchy(k) => {
            let q = 1.0 + (z / k).powi(2);
            (1.0 / q, k * k * q.ln())
        }
    }
}

impl Aero {
    /// Set up the problem: the local frame, the parameter layout and the approximations.
    pub fn new(cams: Vec<CameraIn>, images: Vec<ImageIn>, points: Vec<PointIn>, obs: Vec<ObsIn>, opts: AeroOptions) -> Result<Aero> {
        if images.is_empty() || obs.is_empty() || cams.is_empty() {
            return Err(Error::invalid("aerial triangulation: the block needs cameras, images and image measurements"));
        }
        if images.len() > 5000 || points.len() > 2_000_000 || obs.len() > 20_000_000 {
            return Err(Error::limit("aerial triangulation: at most 5000 images, 2 million points and 20 million measurements"));
        }
        for (k, c) in cams.iter().enumerate() {
            let ok = c.io.iter().chain(&c.mount).chain(&c.io_sigma).chain(&c.mount_sigma).all(|v| v.is_finite()) && c.io[0] > 0.0 && (c.film || (c.pixel_mm > 0.0 && c.width > 0.0 && c.height > 0.0));
            if !ok {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: camera {k} needs a positive focal length, pixel size and format", k = k + 1));
            }
        }
        for (i, im) in images.iter().enumerate() {
            if im.camera >= cams.len() {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: image {i} refers to a missing camera", i = i + 1));
            }
            if cams[im.camera].film != im.film.is_some() {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: image {i} needs its fiducial interior orientation (film camera), or has one on a digital camera", i = i + 1));
            }
            if (im.gnss.is_some() || im.imu.is_some()) && im.approx.is_none() {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: image {i} has GNSS/IMU weights but no position or attitude", i = i + 1));
            }
            if im.imu.is_some() && !im.attitude_known {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: image {i} has an IMU weight but no attitude", i = i + 1));
            }
            let bad_sigma = |s: &Option<[f64; 3]>| s.map_or(false, |s| !s.iter().all(|v| *v > 0.0 && v.is_finite()));
            if bad_sigma(&im.gnss) || bad_sigma(&im.imu) {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: image {i} has a GNSS or IMU σ that is not positive", i = i + 1));
            }
        }
        for o in &obs {
            if o.image >= images.len() || o.point >= points.len() || !(o.sigma_px > 0.0) || !o.x.is_finite() || !o.y.is_finite() {
                return Err(Error::invalid("aerial triangulation: a measurement refers to a missing image or point, or has σ ≤ 0"));
            }
        }
        for p in &points {
            if p.kind != PointKind::Tie && p.known.is_none() {
                return Err(Error::invalid("aerial triangulation: a GCP or checkpoint needs known coordinates"));
            }
            if p.kind == PointKind::Gcp && !(p.sigma_h > 0.0 && p.sigma_v > 0.0) {
                return Err(Error::invalid("aerial triangulation: a GCP needs σ > 0"));
            }
        }
        // The block origin: the mean of the known positions (images, then control).
        let mut acc = [0.0; 3];
        let mut n = 0.0;
        for im in &images {
            if let Some((g, _)) = im.approx {
                acc = add(acc, geodetic_to_ecef(g.lat, g.lon, g.h));
                n += 1.0;
            }
        }
        if n == 0.0 {
            for p in &points {
                if let Some(g) = p.known {
                    acc = add(acc, geodetic_to_ecef(g.lat, g.lon, g.h));
                    n += 1.0;
                }
            }
        }
        if n == 0.0 {
            return Err(Error::invalid("aerial triangulation: no image position and no control point: the block has no datum and no approximation"));
        }
        let oe = scale(acc, 1.0 / n);
        let (lat, lon, h) = ecef_to_geodetic(oe[0], oe[1], oe[2]);
        let origin = Ground { lat, lon, h };
        let o_ecef = geodetic_to_ecef(lat, lon, h);
        let e_o = enu_rotation(lat, lon);

        let mut by_point = vec![Vec::new(); points.len()];
        for (k, o) in obs.iter().enumerate() {
            by_point[o.point].push(k);
        }
        let ni = images.len();
        let mut a = Aero {
            st: State { c: vec![[0.0; 3]; ni], r: vec![I3; ni], io: cams.iter().map(|c| c.io).collect(), mount: cams.iter().map(|c| c.mount).collect(), x: vec![None; points.len()] },
            gnss: vec![None; ni],
            imu: vec![None; ni],
            gcp: vec![None; points.len()],
            by_point,
            active: vec![true; obs.len()],
            used: vec![false; points.len()],
            weights: vec![1.0; obs.len()],
            eo_off: Vec::new(),
            io_idx: Vec::new(),
            mount_idx: Vec::new(),
            params: Vec::new(),
            cams,
            images,
            points,
            obs,
            opts,
            origin,
            o_ecef,
            e_o,
            lambda: 1e-3,
            cost: f64::INFINITY,
            last_step: f64::NAN,
            last_rel: f64::INFINITY,
            iteration: 0,
            round: 0,
            forced: false,
            no_force: false,
            converged: false,
            finished: false,
            rejected: Vec::new(),
            notes: Vec::new(),
            approx_kind: vec![0; ni],
            excluded: vec![false; ni],
        };
        for (j, p) in a.points.iter().enumerate() {
            if let Some(g) = p.known {
                a.gcp[j] = Some(a.local(g));
            }
        }
        a.approximate()?;
        a.layout()?;
        // The reduced normal matrix is dense (n² values, factored in place): at most 3000
        // parameters, about 500 images, keeps a solve under ~350 MB in the worker.
        if a.params.len() > 3000 {
            return Err(gw_abi::err!(LIMIT, "aerial triangulation: {n} parameters; this solver takes at most 3000 per block (about 500 images): split the block", n = a.params.len()));
        }
        a.check_datum()?;
        a.structure_check()?;
        Ok(a)
    }

    /// Geodetic → local.
    pub fn local(&self, g: Ground) -> V3 {
        mv(&self.e_o, sub(geodetic_to_ecef(g.lat, g.lon, g.h), self.o_ecef))
    }
    /// Local → geodetic.
    pub fn geodetic(&self, p: V3) -> Ground {
        let e = add(self.o_ecef, mtv(&self.e_o, p));
        let (lat, lon, h) = ecef_to_geodetic(e[0], e[1], e[2]);
        Ground { lat, lon, h }
    }
    /// ENU-at-g → camera rotation into local → camera.
    fn rot_to_local(&self, g: Ground, r_enu: &M3) -> M3 {
        mul(&mul(r_enu, &enu_rotation(g.lat, g.lon)), &tr(&self.e_o))
    }
    /// Local → camera rotation into ENU-at-g → camera.
    pub fn rot_to_enu(&self, g: Ground, r: &M3) -> M3 {
        mul(&mul(r, &self.e_o), &tr(&enu_rotation(g.lat, g.lon)))
    }

    fn layout(&mut self) -> Result<()> {
        let mut p = 0;
        for (i, im) in self.images.iter().enumerate() {
            if im.fixed || self.excluded[i] {
                self.eo_off.push(None);
            } else {
                self.eo_off.push(Some(p));
                for w in 0..6 {
                    self.params.push(ParamId { kind: ParamKind::Eo, owner: i, which: w });
                }
                p += 6;
            }
        }
        for (c, cam) in self.cams.iter().enumerate() {
            let mut io = [None; NIO];
            for q in 0..NIO {
                if cam.io_free[q] {
                    io[q] = Some(p);
                    self.params.push(ParamId { kind: ParamKind::Io, owner: c, which: q });
                    p += 1;
                }
            }
            self.io_idx.push(io);
            let has_gnss = self.images.iter().any(|im| im.camera == c && im.gnss.is_some());
            let has_imu = self.images.iter().any(|im| im.camera == c && im.imu.is_some());
            let mut mo = [None; 6];
            for q in 0..6 {
                if cam.mount_free[q] {
                    if (q < 3 && !has_gnss) || (q >= 3 && !has_imu) {
                        return Err(gw_abi::err!(INVALID, "aerial triangulation: camera {c}: the {what} cannot be solved without {obs} observations", c = c + 1, what = if q < 3 { "lever arm" } else { "boresight" }, obs = if q < 3 { "GNSS" } else { "IMU" }));
                    }
                    mo[q] = Some(p);
                    self.params.push(ParamId { kind: ParamKind::Mount, owner: c, which: q });
                    p += 1;
                }
            }
            self.mount_idx.push(mo);
        }
        Ok(())
    }

    pub fn param_count(&self) -> usize {
        self.params.len()
    }

    /// A parameter's English name, for messages (the app names them through its own catalogue).
    pub fn param_label(&self, k: usize) -> String {
        let p = self.params[k];
        match p.kind {
            ParamKind::Eo => format!("image {} {}", p.owner + 1, EO_NAMES[p.which]),
            ParamKind::Io => format!("camera {} {}", p.owner + 1, IO_NAMES[p.which]),
            ParamKind::Mount => format!("camera {} {}", p.owner + 1, MOUNT_NAMES[p.which]),
        }
    }

    // ---- approximations ----

    fn approximate(&mut self) -> Result<()> {
        let ni = self.images.len();
        let mut have = vec![false; ni];
        for i in 0..ni {
            if let Some((g, r)) = self.images[i].approx {
                self.st.c[i] = self.local(g);
                if self.images[i].attitude_known {
                    self.st.r[i] = self.rot_to_local(g, &r);
                    have[i] = true;
                }
                if let Some(_s) = self.images[i].gnss {
                    self.gnss[i] = Some(self.st.c[i]);
                }
                if self.images[i].imu.is_some() {
                    self.imu[i] = Some(self.st.r[i]);
                }
            }
        }
        // Images that see six or more GCPs: resected from them (convergent or oblique views).
        for i in 0..ni {
            if !have[i] && self.resect_image(i, false) {
                have[i] = true;
            }
        }
        // Headings and heights of nadir images with a position but no attitude (drone EXIF GPS
        // only), and positions of images with neither when control ties them: a linear
        // planimetric block of 2-D similarities. Without any image oriented yet it must succeed.
        let need: Vec<usize> = (0..ni).filter(|&i| !have[i]).collect();
        if !need.is_empty() {
            if let Err(e) = self.planimetric(&need, &mut have) {
                if !have.iter().any(|h| *h) {
                    return Err(e);
                }
            }
        }
        // Resection–intersection for what is left.
        for _round in 0..ni + 1 {
            if have.iter().all(|h| *h) {
                break;
            }
            self.triangulate_all(&have);
            let mut progress = false;
            for i in 0..ni {
                if !have[i] && self.resect_image(i, true) {
                    have[i] = true;
                    progress = true;
                }
            }
            if !progress {
                break;
            }
        }
        // Images still without an approximation are left out (named in a note); a block with
        // none oriented is refused.
        if !have.iter().any(|h| *h) {
            return Err(Error::invalid("aerial triangulation: no image has an approximate orientation: give the images positions (GNSS, EXIF or an EO list) or measure four or more control points in them"));
        }
        let left: Vec<usize> = (0..ni).filter(|&i| !have[i]).collect();
        if !left.is_empty() {
            for &i in &left {
                self.excluded[i] = true;
                for k in 0..self.obs.len() {
                    if self.obs[k].image == i {
                        self.active[k] = false;
                    }
                }
            }
            let names = numbers(&left.iter().map(|i| i + 1).collect::<Vec<_>>());
            self.notes.push(format!("images left out (no approximation could be made: no attitude, and no tie points or control to fit a heading or resect from): {names}"));
        }
        self.triangulate_all(&have);
        // Measurements that do not project (behind the camera, outside a fisheye's field) at the
        // approximation are left out, with a note.
        let mut dropped = 0;
        for k in 0..self.obs.len() {
            let o = self.obs[k];
            let x = if self.points[o.point].kind == PointKind::Gcp { self.gcp[o.point] } else { self.st.x[o.point] };
            if let Some(x) = x {
                if self.image_obs(&self.st, k, x).is_none() {
                    self.active[k] = false;
                    dropped += 1;
                }
            }
        }
        if dropped > 0 {
            self.notes.push(format!("{dropped} measurements do not project at the approximate orientation and were left out"));
        }
        // Points in the solve.
        for j in 0..self.points.len() {
            let n = self.by_point[j].iter().filter(|&&k| self.active[k]).count();
            let p = &self.points[j];
            self.used[j] = match p.kind {
                PointKind::Gcp => n >= 1,
                _ => n >= 2 && self.st.x[j].is_some(),
            };
            if p.kind == PointKind::Gcp && self.used[j] {
                self.st.x[j] = self.gcp[j];
            }
            if !self.used[j] {
                self.st.x[j] = None;
            }
        }
        // Images left with fewer than six usable measurements are left out (named in a note),
        // and the points that then have too few rays with them, until nothing changes.
        let mut weak_images = Vec::new();
        loop {
            let mut count = vec![0usize; ni];
            for (k, o) in self.obs.iter().enumerate() {
                if self.active[k] && self.used[o.point] && self.points[o.point].kind != PointKind::Check {
                    count[o.image] += 1;
                }
            }
            let drop: Vec<usize> = (0..ni).filter(|&i| !self.excluded[i] && !self.images[i].fixed && count[i] < 6).collect();
            if drop.is_empty() {
                break;
            }
            for &i in &drop {
                self.excluded[i] = true;
                weak_images.push(i + 1);
                for k in 0..self.obs.len() {
                    if self.obs[k].image == i {
                        self.active[k] = false;
                    }
                }
            }
            for j in 0..self.points.len() {
                let n = self.by_point[j].iter().filter(|&&k| self.active[k]).count();
                let need = if self.points[j].kind == PointKind::Gcp { 1 } else { 2 };
                if self.used[j] && n < need {
                    self.used[j] = false;
                    self.st.x[j] = None;
                }
            }
        }
        self.exclude_islands();
        if !weak_images.is_empty() {
            let o = order(&weak_images.iter().map(|&i| i as f64).collect::<Vec<_>>());
            weak_images = o.into_iter().map(|k| weak_images[k]).collect();
            let names = numbers(&weak_images);
            self.notes.push(format!("images left out (fewer than six usable measurements): {names}"));
        }
        if self.excluded.iter().all(|e| *e) {
            return Err(Error::invalid("aerial triangulation: no image has six or more usable measurements"));
        }
        Ok(())
    }

    /// Images are linked when they share four or more points in the solve. A group of linked
    /// images with no datum of its own (fewer than three GNSS positions, fewer than three GCPs,
    /// no image held) floats: its images are left out, named in a note. The group that holds
    /// most images is kept when every group floats (the datum check then refuses the block).
    fn exclude_islands(&mut self) {
        let ni = self.images.len();
        let mut parent: Vec<usize> = (0..ni).collect();
        fn find(p: &mut [usize], mut a: usize) -> usize {
            while p[a] != a {
                p[a] = p[p[a]];
                a = p[a];
            }
            a
        }
        // Points shared per image pair: each image's (neighbour, count) list.
        let mut shared: Vec<Vec<(usize, u32)>> = vec![Vec::new(); ni];
        for j in 0..self.points.len() {
            if !self.used[j] {
                continue;
            }
            let ims: Vec<usize> = self.by_point[j].iter().filter(|&&k| self.active[k]).map(|&k| self.obs[k].image).collect();
            for a in 0..ims.len() {
                for b in a + 1..ims.len() {
                    let (lo, hi) = (ims[a].min(ims[b]), ims[a].max(ims[b]));
                    match shared[lo].iter_mut().find(|e| e.0 == hi) {
                        Some(e) => e.1 += 1,
                        None => shared[lo].push((hi, 1)),
                    }
                }
            }
        }
        for (a, list) in shared.iter().enumerate() {
            for &(b, n) in list {
                if n >= 4 {
                    let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
                    if ra != rb {
                        parent[ra] = rb;
                    }
                }
            }
        }
        let mut root_of: Vec<usize> = Vec::new();
        let mut list: Vec<Vec<usize>> = Vec::new();
        for i in 0..ni {
            if !self.excluded[i] {
                let r = find(&mut parent, i);
                match root_of.iter().position(|&x| x == r) {
                    Some(g) => list[g].push(i),
                    None => {
                        root_of.push(r);
                        list.push(vec![i]);
                    }
                }
            }
        }
        let anchored = |g: &[usize], a: &Aero| {
            let gnss = g.iter().filter(|&&i| a.gnss[i].is_some()).count();
            let fixed = g.iter().any(|&i| a.images[i].fixed);
            let mut seen = vec![false; a.points.len()];
            let mut gcps = 0;
            for (k, o) in a.obs.iter().enumerate() {
                if a.active[k] && a.points[o.point].kind == PointKind::Gcp && a.used[o.point] && !seen[o.point] && g.contains(&o.image) {
                    seen[o.point] = true;
                    gcps += 1;
                }
            }
            gnss >= 3 || gcps >= 3 || fixed
        };
        // Largest group first.
        let o = order(&list.iter().map(|g| -(g.len() as f64)).collect::<Vec<_>>());
        let list: Vec<Vec<usize>> = o.into_iter().map(|k| list[k].clone()).collect();
        let any = list.iter().any(|g| anchored(g, self));
        let mut out = Vec::new();
        for (n, g) in list.iter().enumerate() {
            if anchored(g, self) || (!any && n == 0) {
                continue;
            }
            for &i in g {
                self.excluded[i] = true;
                out.push(i + 1);
                for k in 0..self.obs.len() {
                    if self.obs[k].image == i {
                        self.active[k] = false;
                    }
                }
            }
        }
        if !out.is_empty() {
            for j in 0..self.points.len() {
                let n = self.by_point[j].iter().filter(|&&k| self.active[k]).count();
                let need = if self.points[j].kind == PointKind::Gcp { 1 } else { 2 };
                if self.used[j] && n < need {
                    self.used[j] = false;
                    self.st.x[j] = None;
                }
            }
            let o = order(&out.iter().map(|&i| i as f64).collect::<Vec<_>>());
            let out: Vec<usize> = o.into_iter().map(|k| out[k]).collect();
            let names = numbers(&out);
            self.notes.push(format!("images left out (linked to the rest by fewer than four points, and without a datum of their own): {names}"));
        }
    }

    /// Resect image i from the GCPs it sees (six or more), and with `ties` from the tie points
    /// intersected so far (four or more points in all). True when it worked.
    fn resect_image(&mut self, i: usize, ties: bool) -> bool {
        let mut pts = Vec::new();
        let mut px = Vec::new();
        for &k in self.obs_of_image(i).iter() {
            let o = self.obs[k];
            let xj = if self.points[o.point].kind == PointKind::Gcp { self.gcp[o.point] } else if ties { self.st.x[o.point] } else { None };
            if let Some(x) = xj {
                pts.push(x);
                px.push((o.x, o.y));
            }
        }
        if pts.len() < if ties { 4 } else { 6 } {
            return false;
        }
        let cam = &self.cams[self.images[i].camera];
        let sig = vec![1.0; pts.len()];
        match crate::resect::resect(cam, &self.st.io[self.images[i].camera], self.images[i].film.as_ref(), &pts, &px, &sig, None, true) {
            Ok(r) => {
                self.st.c[i] = r.c;
                self.st.r[i] = r.r;
                self.approx_kind[i] = 2;
                true
            }
            Err(_) => false,
        }
    }

    fn obs_of_image(&self, i: usize) -> Vec<usize> {
        (0..self.obs.len()).filter(|&k| self.obs[k].image == i && self.active[k]).collect()
    }

    /// Linear intersection of every point from the oriented images.
    fn triangulate_all(&mut self, have: &[bool]) {
        for j in 0..self.points.len() {
            let mut a = [[0.0; 3]; 3];
            let mut b = [0.0; 3];
            let mut n = 0;
            let mut rays = Vec::new();
            for &k in &self.by_point[j] {
                let o = self.obs[k];
                if !self.active[k] || !have[o.image] {
                    continue;
                }
                let im = &self.images[o.image];
                let cam = &self.cams[im.camera];
                let Some(d) = back_project(cam, &self.st.io[im.camera], im.film.as_ref(), o.x, o.y) else { continue };
                let dl = mtv(&self.st.r[o.image], d);
                let c = self.st.c[o.image];
                for r in 0..3 {
                    for s in 0..3 {
                        let m = if r == s { 1.0 } else { 0.0 } - dl[r] * dl[s];
                        a[r][s] += m;
                        b[r] += m * c[s];
                    }
                }
                rays.push((c, dl));
                n += 1;
            }
            if n < 2 {
                continue;
            }
            let (vals, _) = sym_eigen(&a);
            // Rays closer than ~0.5° are not intersected.
            if vals[0] < 1e-4 * n as f64 {
                continue;
            }
            let Some(ai) = inv(&a) else { continue };
            let x = mv(&ai, b);
            if rays.iter().all(|(c, d)| dot(sub(x, *c), *d) > 0.0) {
                self.st.x[j] = Some(x);
            }
        }
    }

    /// Linear 2-D similarity block for the images in `need` (nadir assumed): per image (a, b)
    /// (and a shift without a position), per point the plane coordinates; GCPs fixed.
    fn planimetric(&mut self, need: &[usize], have: &mut [bool]) -> Result<()> {
        let ni = self.images.len();
        // Unknown index per image: a, b (+ tx, ty without a position).
        let mut off = vec![None; ni];
        let mut haspos = vec![false; ni];
        let mut n = 0;
        for i in 0..ni {
            haspos[i] = self.images[i].approx.is_some();
            off[i] = Some(n);
            n += if haspos[i] { 2 } else { 4 };
        }
        let mut s = Mat::zeros(n);
        let mut bv = vec![0.0; n];
        let mut any = false;
        for j in 0..self.points.len() {
            let mine: Vec<usize> = self.by_point[j].iter().copied().filter(|&k| self.active[k]).collect();
            let gcp = if self.points[j].kind == PointKind::Gcp { self.gcp[j] } else { None };
            if mine.len() < 2 && gcp.is_none() {
                continue;
            }
            // Per observation: X_p − a u + b v − tx = Cx; Y_p − b u − a v − ty = Cy, with
            // (u, v) the ideal image mm of a nadir camera (scale H/f absorbed in a, b).
            let mut rows: Vec<(Vec<(usize, f64)>, [f64; 2], f64)> = Vec::new(); // (image terms, point terms [Xp, Yp], rhs)
            for &k in &mine {
                let o = self.obs[k];
                let im = &self.images[o.image];
                let cam = &self.cams[im.camera];
                let Some(d) = back_project(cam, &self.st.io[im.camera], im.film.as_ref(), o.x, o.y) else { continue };
                if d[2] > -0.2 {
                    continue;
                }
                let (u, v) = (-d[0] / d[2], -d[1] / d[2]);
                let base = off[o.image].unwrap();
                let c = if haspos[o.image] { self.st.c[o.image] } else { [0.0; 3] };
                let mut ex = vec![(base, -u), (base + 1, v)];
                let mut ey = vec![(base, -v), (base + 1, -u)];
                if !haspos[o.image] {
                    ex.push((base + 2, -1.0));
                    ey.push((base + 3, -1.0));
                }
                rows.push((ex, [1.0, 0.0], c[0]));
                rows.push((ey, [0.0, 1.0], c[1]));
            }
            if rows.len() < 2 {
                continue;
            }
            match gcp {
                Some(g) => {
                    // Point fixed: move it to the right-hand side.
                    for (terms, pt, rhs) in &rows {
                        let r = rhs - pt[0] * g[0] - pt[1] * g[1];
                        for &(a, va) in terms {
                            bv[a] += va * r;
                            for &(b, vb) in terms {
                                s.add(a, b, va * vb);
                            }
                        }
                    }
                    any = true;
                }
                None => {
                    if rows.len() < 4 {
                        continue;
                    }
                    // Eliminate the point (2 × 2, diagonal: count of rows per axis).
                    let nx = rows.iter().filter(|r| r.1[0] != 0.0).count() as f64;
                    let ny = rows.iter().filter(|r| r.1[1] != 0.0).count() as f64;
                    let (mut sx, mut sy) = (0.0, 0.0);
                    for (_, pt, rhs) in &rows {
                        sx += pt[0] * rhs;
                        sy += pt[1] * rhs;
                    }
                    // Per axis: rows r = rhs − Σ terms·p − pt·X: X = (Σ rhs − Σ terms·p)/n.
                    for axis in 0..2 {
                        let nn = if axis == 0 { nx } else { ny };
                        let sr = if axis == 0 { sx } else { sy };
                        let ax: Vec<&(Vec<(usize, f64)>, [f64; 2], f64)> = rows.iter().filter(|r| r.1[axis] != 0.0).collect();
                        // Normal of the image terms with the point eliminated:
                        // Σ tᵀt − (Σ t)ᵀ(Σ t)/n; rhs: −Σ tᵀ rhs + (Σ t) Σ rhs / n (sign: model
                        // terms·p + X = rhs → residual rhs − terms·p − X).
                        let mut sum_t: Vec<(usize, f64)> = Vec::new();
                        for r in &ax {
                            for &(a, va) in &r.0 {
                                match sum_t.iter_mut().find(|e| e.0 == a) {
                                    Some(e) => e.1 += va,
                                    None => sum_t.push((a, va)),
                                }
                            }
                        }
                        for r in &ax {
                            for &(a, va) in &r.0 {
                                bv[a] += va * r.2;
                                for &(b, vb) in &r.0 {
                                    s.add(a, b, va * vb);
                                }
                            }
                        }
                        for &(a, va) in &sum_t {
                            bv[a] -= va * sr / nn;
                            for &(b, vb) in &sum_t {
                                s.add(a, b, -va * vb / nn);
                            }
                        }
                    }
                    any = true;
                }
            }
        }
        if !any {
            return Err(Error::invalid("aerial triangulation: the images without an attitude share no tie points or control: no approximation can be made"));
        }
        // Unknowns without measurements are decoupled (they stay 0 and are not used); a weak
        // ridge keeps images tied by a single point solvable (the bundle then judges them).
        let maxd = (0..n).map(|i| s.at(i, i)).fold(0.0_f64, f64::max).max(1e-300);
        for i in 0..n {
            let d = s.at(i, i);
            if d == 0.0 {
                s.set(i, i, 1.0);
            } else {
                s.add(i, i, 1e-9 * maxd);
            }
        }
        let sol = cholesky(&s).map(|l| gw_adjust::linalg::chol_solve(&l, &bv)).ok_or_else(|| Error::invalid("aerial triangulation: the nadir approximation is singular (images without attitude need GNSS positions or two or more control points tying them)"))?;
        let gz = {
            let hs: Vec<f64> = self.gcp.iter().flatten().map(|g| g[2]).collect();
            if hs.is_empty() {
                None
            } else {
                Some(hs.iter().sum::<f64>() / hs.len() as f64)
            }
        };
        for &i in need {
            let o = off[i].unwrap();
            let (a, b) = (sol[o], sol[o + 1]);
            let sc = a.hypot(b);
            if !(sc > 0.0) || !sc.is_finite() {
                continue;
            }
            let kappa = b.atan2(a);
            // (u, v) are tangents of the ray, so the scale is the height above the ground (m).
            let hgt = sc;
            if !haspos[i] {
                let Some(z0) = gz else { continue };
                self.st.c[i] = [sol[o + 2], sol[o + 3], z0 + hgt];
            }
            self.st.r[i] = gw_sensor::frame::rotation(0.0, 0.0, kappa.to_degrees());
            have[i] = true;
            self.approx_kind[i] = 1;
        }
        Ok(())
    }

    fn check_datum(&self) -> Result<()> {
        let gcps: Vec<V3> = (0..self.points.len()).filter(|&j| self.points[j].kind == PointKind::Gcp && self.used[j]).filter_map(|j| self.gcp[j]).collect();
        let gn: Vec<V3> = (0..self.images.len()).filter_map(|i| self.gnss[i]).collect();
        let fixed = self.images.iter().filter(|im| im.fixed).count();
        if gcps.is_empty() && gn.is_empty() && fixed == 0 {
            return Err(Error::invalid("aerial triangulation: the block has no datum: measure GCPs, weight the GNSS positions or hold an image fixed"));
        }
        // GNSS positions on one line leave the whole block free to roll about that line. This is
        // checked here because the normal matrix shows it only as a pivot at rounding level, and
        // that level differs from one platform to the next.
        let imu = self.images.iter().any(|im| im.imu.is_some());
        if gcps.is_empty() && fixed == 0 && !imu && line_spread(&gn) < 1e-3 {
            return Err(Error::invalid("aerial triangulation: the roll about the strip axis cannot be determined: the GNSS positions lie on one line and nothing else holds the block; add GCPs, an IMU attitude or a second strip"));
        }
        Ok(())
    }

    /// Refuse a block whose normal matrix is singular, naming the first parameter that cannot
    /// be determined.
    fn structure_check(&mut self) -> Result<()> {
        let mut nm = self.assemble(&self.st.clone(), true)?;
        // Points whose rays are (nearly) parallel cannot be intersected: left out, with a note.
        let mut weak = 0;
        for j in 0..self.points.len() {
            let Some(blk) = nm.pts[j].as_ref() else { continue };
            let (vals, _) = sym_eigen(&blk.nxx);
            if !(vals[0] > 1e-9 * vals[2].max(1e-300)) || inv(&blk.nxx).is_none() {
                self.used[j] = false;
                self.st.x[j] = None;
                weak += 1;
            }
        }
        if weak > 0 {
            self.notes.push(format!("{weak} points with nearly parallel rays were left out"));
            nm = self.assemble(&self.st.clone(), true)?;
        }
        let (_, sing) = self.factor_check(&nm);
        if let Some((k, with)) = sing {
            if !with.is_empty() {
                let mut names = String::new();
                for (n, &q) in with.iter().enumerate() {
                    if n > 0 {
                        names.push_str(", ");
                    }
                    names.push_str(&self.param_label(q));
                }
                return Err(gw_abi::err!(INVALID, "aerial triangulation: {param} cannot be determined: it trades against {others} (the block is singular there); hold one of them, give it an a priori σ, or add control or GNSS", param = self.param_label(k), others = names));
            }
            let p = self.params.get(k).copied();
            let rays = match p {
                Some(ParamId { kind: ParamKind::Eo, owner, .. }) => self.obs.iter().enumerate().filter(|(q, o)| o.image == owner && self.active[*q] && self.used[o.point]).count(),
                _ => usize::MAX,
            };
            if rays != usize::MAX {
                return Err(gw_abi::err!(INVALID, "aerial triangulation: {param} cannot be determined: the block is singular there ({n} usable measurements in that image; no datum, too few points, or a geometry that cannot separate it); hold it, give it an a priori σ, or add control", param = self.param_label(k), n = rays));
            }
            return Err(gw_abi::err!(INVALID, "aerial triangulation: {param} cannot be determined: the block is singular there (no datum, too few measurements in an image, or a geometry that cannot separate it); hold it, give it an a priori σ, or add control", param = self.param_label(k)));
        }
        Ok(())
    }

    /// Schur-reduce and factor without damping: the scaled factor's first failing pivot.
    fn factor_check(&self, nm: &Normal) -> (Option<Mat>, Option<(usize, Vec<usize>)>) {
        let red = self.reduce(nm, 0.0);
        let Some((a, _)) = red else { return (None, None) };
        let n = a.n;
        if n == 0 {
            return (Some(a), None);
        }
        let d: Vec<f64> = (0..n).map(|i| 1.0 / a.at(i, i).max(1e-300).sqrt()).collect();
        let mut sc = a.clone();
        for i in 0..n {
            for j in 0..n {
                sc.set(i, j, a.at(i, j) * d[i] * d[j]);
            }
        }
        // Cholesky with pivot tracking.
        let mut l = Mat::zeros(n);
        for j in 0..n {
            let mut dd = sc.at(j, j);
            for k in 0..j {
                dd -= l.at(j, k) * l.at(j, k);
            }
            if !(dd > 1e-10) {
                // Column j depends on the earlier ones: x = A₁₁⁻¹·a₁₂ gives the null direction
                // (−x, 1); the parameters with the largest share trade against parameter j.
                let mut y: Vec<f64> = (0..j).map(|i| sc.at(i, j)).collect();
                for i in 0..j {
                    let mut v = y[i];
                    for k in 0..i {
                        v -= l.at(i, k) * y[k];
                    }
                    y[i] = v / l.at(i, i);
                }
                for i in (0..j).rev() {
                    let mut v = y[i];
                    for k in i + 1..j {
                        v -= l.at(k, i) * y[k];
                    }
                    y[i] = v / l.at(i, i);
                }
                let share: Vec<(usize, f64)> = (0..j).map(|i| (i, y[i].abs())).filter(|x| x.1 > 0.05).collect();
                // Interior orientation and mount parameters first: they are the usual cause.
                // Shares are at most ~1e6 (scaled): IO and mount parameters rank above EO.
                let keys: Vec<f64> = share.iter().map(|x| -(x.1.min(1e6) + if self.params[x.0].kind != ParamKind::Eo { 1e7 } else { 0.0 })).collect();
                let share: Vec<(usize, f64)> = order(&keys).into_iter().take(3).map(|k| share[k]).collect();
                return (None, Some((j, share.into_iter().map(|x| x.0).collect())));
            }
            let dd = dd.sqrt();
            l.set(j, j, dd);
            for i in j + 1..n {
                let mut s = sc.at(i, j);
                for k in 0..j {
                    s -= l.at(i, k) * l.at(j, k);
                }
                l.set(i, j, s / dd);
            }
        }
        (Some(l), None)
    }

    // ---- the normal equations ----

    fn image_obs(&self, st: &State, k: usize, x: V3) -> Option<(f64, f64, V3)> {
        let o = self.obs[k];
        let im = &self.images[o.image];
        let v = mv(&st.r[o.image], sub(x, st.c[o.image]));
        let (px, py) = project(&self.cams[im.camera], &st.io[im.camera], im.film.as_ref(), v)?;
        Some((o.x - px, o.y - py, v))
    }

    /// The robust weight and ρ of observation k at residual r.
    fn rho(&self, k: usize, rx: f64, ry: f64) -> (f64, f64) {
        let s = self.obs[k].sigma_px;
        let z = rx.hypot(ry) / s;
        // Control measurements (GCPs) are the user's own: full weight, never rejected; their
        // residuals are reported instead. Robust weighting is for the (automatic) tie points.
        if self.points[self.obs[k].point].kind == PointKind::Gcp {
            return (1.0, z * z);
        }
        huber_weight(self.opts.robust, z)
    }

    fn imu_residual(&self, st: &State, i: usize) -> Option<V3> {
        let r_obs = self.imu[i]?;
        let c = self.images[i].camera;
        let b = expm([st.mount[c][3], st.mount[c][4], st.mount[c][5]]);
        // R_cam = B·R_imu: E = B·R_obs·R_camᵀ = I when consistent.
        let e = mul(&mul(&b, &r_obs), &tr(&st.r[i]));
        Some(logm(&e))
    }

    fn gnss_residual(&self, st: &State, i: usize) -> Option<V3> {
        let a = self.gnss[i]?;
        let c = self.images[i].camera;
        let l = [st.mount[c][0], st.mount[c][1], st.mount[c][2]];
        Some(sub(a, add(st.c[i], mtv(&st.r[i], l))))
    }

    /// Cost at a state (robust image term with the current weights' ρ, plus the quadratic terms).
    fn cost_at(&self, st: &State) -> Option<f64> {
        let mut cost = 0.0;
        for (k, o) in self.obs.iter().enumerate() {
            if !self.active[k] || !self.used[o.point] {
                continue;
            }
            let x = st.x[o.point]?;
            let (rx, ry, _) = self.image_obs(st, k, x)?;
            cost += self.rho(k, rx, ry).1;
        }
        cost += self.quad_cost(st);
        cost.is_finite().then_some(cost)
    }

    fn quad_cost(&self, st: &State) -> f64 {
        let mut cost = 0.0;
        for j in 0..self.points.len() {
            if self.points[j].kind == PointKind::Gcp && self.used[j] {
                let (Some(g), Some(x)) = (self.gcp[j], st.x[j]) else { continue };
                let p = &self.points[j];
                let d = sub(g, x);
                cost += (d[0] / p.sigma_h).powi(2) + (d[1] / p.sigma_h).powi(2) + (d[2] / p.sigma_v).powi(2);
            }
        }
        for i in 0..self.images.len() {
            if let (Some(r), Some(s)) = (self.gnss_residual(st, i), self.images[i].gnss) {
                cost += (0..3).map(|a| (r[a] / s[a]).powi(2)).sum::<f64>();
            }
            if let (Some(r), Some(s)) = (self.imu_residual(st, i), self.images[i].imu) {
                cost += (0..3).map(|a| (r[a] / s[a]).powi(2)).sum::<f64>();
            }
        }
        for (c, cam) in self.cams.iter().enumerate() {
            for q in 0..NIO {
                if cam.io_free[q] && cam.io_sigma[q] > 0.0 {
                    cost += ((st.io[c][q] - cam.io[q]) / cam.io_sigma[q]).powi(2);
                }
            }
            for q in 0..6 {
                if cam.mount_free[q] && cam.mount_sigma[q] > 0.0 {
                    cost += ((st.mount[c][q] - cam.mount[q]) / cam.mount_sigma[q]).powi(2);
                }
            }
        }
        cost
    }

    /// Assemble the (undamped) normal equations at `st` with the current robust weights.
    fn assemble(&self, st: &State, unit_weights: bool) -> Result<Normal> {
        let n = self.params.len();
        let mut s = Mat::zeros(n);
        let mut b = vec![0.0; n];
        let mut pts: Vec<Option<PtBlock>> = Vec::with_capacity(self.points.len());
        let mut cost = 0.0;
        let mut idx: Vec<usize> = Vec::with_capacity(32);
        let mut jac: Vec<[f64; 2]> = Vec::with_capacity(32);
        for j in 0..self.points.len() {
            if !self.used[j] {
                pts.push(None);
                continue;
            }
            let Some(x) = st.x[j] else {
                pts.push(None);
                continue;
            };
            let mut blk = PtBlock { nxx: [[0.0; 3]; 3], bx: [0.0; 3], rows: Vec::new() };
            for &k in &self.by_point[j] {
                if !self.active[k] {
                    continue;
                }
                let o = self.obs[k];
                let i = o.image;
                let im = &self.images[i];
                let ci = im.camera;
                let cam = &self.cams[ci];
                let Some((rx, ry, v)) = self.image_obs(st, k, x) else {
                    return Err(gw_abi::err!(RANGE, "aerial triangulation: point {j} projects behind image {i} or outside the fisheye's field: check the approximations", j = j + 1, i = i + 1));
                };
                let (wr, rho) = if unit_weights { (1.0, (rx * rx + ry * ry) / (o.sigma_px * o.sigma_px)) } else { self.rho(k, rx, ry) };
                let w = if unit_weights { 1.0 } else { self.weights[k] } / (o.sigma_px * o.sigma_px);
                let _ = wr;
                cost += rho;
                // ∂pixel/∂v by central differences.
                let io = &st.io[ci];
                let film = im.film.as_ref();
                let hv = 1e-7 * norm(v).max(1e-9);
                let mut jv = [[0.0; 3]; 2];
                for a in 0..3 {
                    let mut vp = v;
                    let mut vm = v;
                    vp[a] += hv;
                    vm[a] -= hv;
                    let (Some(p), Some(m)) = (project(cam, io, film, vp), project(cam, io, film, vm)) else {
                        return Err(gw_abi::err!(RANGE, "aerial triangulation: point {j} lies at the edge of image {i}'s projection", j = j + 1, i = i + 1));
                    };
                    jv[0][a] = (p.0 - m.0) / (2.0 * hv);
                    jv[1][a] = (p.1 - m.1) / (2.0 * hv);
                }
                let r = &st.r[i];
                // Point: J_v R; centre: −J_v R; rotation: J_v [v]×.
                let mut jx = [[0.0; 3]; 2];
                let sk = skew(v);
                let mut jrot = [[0.0; 3]; 2];
                for row in 0..2 {
                    for c in 0..3 {
                        jx[row][c] = (0..3).map(|a| jv[row][a] * r[a][c]).sum();
                        jrot[row][c] = (0..3).map(|a| jv[row][a] * sk[a][c]).sum();
                    }
                }
                idx.clear();
                jac.clear();
                if let Some(off) = self.eo_off[i] {
                    for c in 0..3 {
                        idx.push(off + c);
                        jac.push([-jx[0][c], -jx[1][c]]);
                    }
                    for c in 0..3 {
                        idx.push(off + 3 + c);
                        jac.push([jrot[0][c], jrot[1][c]]);
                    }
                }
                for q in 0..NIO {
                    let Some(p) = self.io_idx[ci][q] else { continue };
                    let h = io_step(cam, io, q);
                    let mut a = *io;
                    let mut m = *io;
                    a[q] += h;
                    m[q] -= h;
                    let (Some(pa), Some(pm)) = (project(cam, &a, film, v), project(cam, &m, film, v)) else { continue };
                    idx.push(p);
                    jac.push([(pa.0 - pm.0) / (2.0 * h), (pa.1 - pm.1) / (2.0 * h)]);
                }
                let res = [rx, ry];
                for row in 0..2 {
                    for a in 0..3 {
                        blk.bx[a] += jx[row][a] * w * res[row];
                        for c in 0..3 {
                            blk.nxx[a][c] += jx[row][a] * w * jx[row][c];
                        }
                    }
                }
                for (u, &ia) in idx.iter().enumerate() {
                    let ja = jac[u];
                    b[ia] += w * (ja[0] * res[0] + ja[1] * res[1]);
                    for (t, &ib) in idx.iter().enumerate() {
                        let jb = jac[t];
                        s.add(ia, ib, w * (ja[0] * jb[0] + ja[1] * jb[1]));
                    }
                    let cross = [0, 1, 2].map(|c| w * (ja[0] * jx[0][c] + ja[1] * jx[1][c]));
                    match blk.rows.iter_mut().find(|e| e.0 == ia) {
                        Some(e) => e.1 = add(e.1, cross),
                        None => blk.rows.push((ia, cross)),
                    }
                }
            }
            if self.points[j].kind == PointKind::Gcp {
                if let Some(g) = self.gcp[j] {
                    let p = &self.points[j];
                    let d = sub(g, x);
                    let w = [1.0 / p.sigma_h.powi(2), 1.0 / p.sigma_h.powi(2), 1.0 / p.sigma_v.powi(2)];
                    for a in 0..3 {
                        blk.nxx[a][a] += w[a];
                        blk.bx[a] += w[a] * d[a];
                        cost += w[a] * d[a] * d[a];
                    }
                }
            }
            pts.push(Some(blk));
        }
        // GNSS and IMU, per image.
        for i in 0..self.images.len() {
            let ci = self.images[i].camera;
            if let (Some(res), Some(sg)) = (self.gnss_residual(st, i), self.images[i].gnss) {
                let l = [st.mount[ci][0], st.mount[ci][1], st.mount[ci][2]];
                let rt = tr(&st.r[i]);
                let drot = mul(&rt, &skew(l)).map(|row| row.map(|v| -v));
                let mut terms: Vec<(usize, V3)> = Vec::new(); // (param, ∂model/∂param, a column)
                if let Some(off) = self.eo_off[i] {
                    for c in 0..3 {
                        let mut e = [0.0; 3];
                        e[c] = 1.0;
                        terms.push((off + c, e));
                        terms.push((off + 3 + c, [drot[0][c], drot[1][c], drot[2][c]]));
                    }
                }
                for q in 0..3 {
                    if let Some(p) = self.mount_idx[ci][q] {
                        terms.push((p, [rt[0][q], rt[1][q], rt[2][q]]));
                    }
                }
                self.add_vec_obs(&mut s, &mut b, &terms, res, sg, &mut cost);
            }
            if let (Some(res), Some(sg)) = (self.imu_residual(st, i), self.images[i].imu) {
                // Numerical partials of the residual (the model is −residual).
                let mut terms: Vec<(usize, V3)> = Vec::new();
                let h = 1e-7;
                let mut probe = |p: usize, f: &dyn Fn(&mut State, f64)| {
                    let mut a = st.clone_light(i, ci);
                    let mut m = st.clone_light(i, ci);
                    f(&mut a, h);
                    f(&mut m, -h);
                    if let (Some(ra), Some(rm)) = (self.imu_residual_light(&a, i, ci), self.imu_residual_light(&m, i, ci)) {
                        // ∂model = −∂residual.
                        terms.push((p, [0, 1, 2].map(|t| -(ra[t] - rm[t]) / (2.0 * h))));
                    }
                };
                if let Some(off) = self.eo_off[i] {
                    for c in 0..3 {
                        probe(off + 3 + c, &|s: &mut State, d: f64| {
                            let mut w = [0.0; 3];
                            w[c] = -d;
                            s.r[0] = mul(&expm(w), &s.r[0]);
                        });
                    }
                }
                for q in 3..6 {
                    if let Some(p) = self.mount_idx[ci][q] {
                        probe(p, &|s: &mut State, d: f64| s.mount[0][q] += d);
                    }
                }
                self.add_vec_obs(&mut s, &mut b, &terms, res, sg, &mut cost);
            }
        }
        // A priori values.
        for (c, cam) in self.cams.iter().enumerate() {
            for q in 0..NIO {
                if let (Some(p), true) = (self.io_idx[c][q], cam.io_sigma[q] > 0.0) {
                    let w = 1.0 / cam.io_sigma[q].powi(2);
                    let r = cam.io[q] - st.io[c][q];
                    s.add(p, p, w);
                    b[p] += w * r;
                    cost += w * r * r;
                }
            }
            for q in 0..6 {
                if let (Some(p), true) = (self.mount_idx[c][q], cam.mount_sigma[q] > 0.0) {
                    let w = 1.0 / cam.mount_sigma[q].powi(2);
                    let r = cam.mount[q] - st.mount[c][q];
                    s.add(p, p, w);
                    b[p] += w * r;
                    cost += w * r * r;
                }
            }
        }
        Ok(Normal { s, b, pts, cost })
    }

    fn imu_residual_light(&self, st: &State, i: usize, _c: usize) -> Option<V3> {
        let r_obs = self.imu[i]?;
        let b = expm([st.mount[0][3], st.mount[0][4], st.mount[0][5]]);
        Some(logm(&mul(&mul(&b, &r_obs), &tr(&st.r[0]))))
    }

    /// A 3-vector observation with diagonal σ: residual `res` (observed − model), ∂model terms.
    fn add_vec_obs(&self, s: &mut Mat, b: &mut [f64], terms: &[(usize, V3)], res: V3, sg: [f64; 3], cost: &mut f64) {
        for a in 0..3 {
            let w = 1.0 / (sg[a] * sg[a]);
            *cost += w * res[a] * res[a];
            for &(p, jp) in terms {
                if jp[a] == 0.0 {
                    continue;
                }
                b[p] += w * jp[a] * res[a];
                for &(q, jq) in terms {
                    if jq[a] != 0.0 {
                        s.add(p, q, w * jp[a] * jq[a]);
                    }
                }
            }
        }
    }

    /// The Schur-reduced system with damping λ: (matrix, right-hand side).
    fn reduce(&self, nm: &Normal, lambda: f64) -> Option<(Mat, Vec<f64>)> {
        let n = nm.s.n;
        let mut a = nm.s.clone();
        for i in 0..n {
            let d = a.at(i, i);
            a.add(i, i, lambda * d.max(1e-12));
        }
        let mut rhs = nm.b.clone();
        for blk in nm.pts.iter().flatten() {
            let mut c = blk.nxx;
            for t in 0..3 {
                c[t][t] += lambda * c[t][t].max(1e-12);
            }
            // A block that became singular (rays nearly parallel) is left out of this step.
            let Some(ci) = inv(&c) else { continue };
            for &(ia, va) in &blk.rows {
                let vc = mtv(&ci, va); // ci symmetric: va·ci
                rhs[ia] -= dot(vc, blk.bx);
                for &(ib, vb) in &blk.rows {
                    a.add(ia, ib, -dot(vc, vb));
                }
            }
        }
        Some((a, rhs))
    }

    /// The damped step: (parameter step, point steps, the largest parameter step in units of
    /// the scaled normal matrix, i.e. roughly in σ).
    fn solve_damped(&self, nm: &Normal, lambda: f64) -> Option<(Vec<f64>, Vec<Option<V3>>, f64)> {
        let (a, rhs) = self.reduce(nm, lambda)?;
        let n = a.n;
        let mut ymax: f64 = 0.0;
        let dc = if n > 0 {
            let d: Vec<f64> = (0..n).map(|i| 1.0 / a.at(i, i).max(1e-300).sqrt()).collect();
            let mut sc = a.clone();
            for i in 0..n {
                for j in 0..n {
                    sc.set(i, j, a.at(i, j) * d[i] * d[j]);
                }
            }
            let l = cholesky(&sc)?;
            let y = gw_adjust::linalg::chol_solve(&l, &(0..n).map(|i| rhs[i] * d[i]).collect::<Vec<_>>());
            ymax = y.iter().map(|v| v.abs()).fold(0.0, f64::max);
            (0..n).map(|i| y[i] * d[i]).collect()
        } else {
            Vec::new()
        };
        let dx = nm
            .pts
            .iter()
            .map(|b| {
                let blk = b.as_ref()?;
                let mut c = blk.nxx;
                for t in 0..3 {
                    c[t][t] += lambda * c[t][t].max(1e-12);
                }
                let ci = inv(&c)?;
                let mut r = blk.bx;
                for &(ia, va) in &blk.rows {
                    r = sub(r, scale(va, dc[ia]));
                }
                Some(mv(&ci, r))
            })
            .collect();
        Some((dc, dx, ymax))
    }

    fn apply(&self, st: &State, dc: &[f64], dx: &[Option<V3>]) -> State {
        let mut ns = st.clone();
        for i in 0..self.images.len() {
            if let Some(off) = self.eo_off[i] {
                ns.c[i] = add(ns.c[i], [dc[off], dc[off + 1], dc[off + 2]]);
                ns.r[i] = orthonormalise(&mul(&expm([-dc[off + 3], -dc[off + 4], -dc[off + 5]]), &ns.r[i])).unwrap_or(ns.r[i]);
            }
        }
        for c in 0..self.cams.len() {
            for q in 0..NIO {
                if let Some(p) = self.io_idx[c][q] {
                    ns.io[c][q] += dc[p];
                }
            }
            for q in 0..6 {
                if let Some(p) = self.mount_idx[c][q] {
                    ns.mount[c][q] += dc[p];
                }
            }
        }
        for (j, d) in dx.iter().enumerate() {
            if let (Some(x), Some(d)) = (ns.x[j], d) {
                ns.x[j] = Some(add(x, *d));
            }
        }
        ns
    }

    fn update_weights(&mut self) {
        for k in 0..self.obs.len() {
            let o = self.obs[k];
            if !self.active[k] || !self.used[o.point] {
                continue;
            }
            let Some(x) = self.st.x[o.point] else { continue };
            if let Some((rx, ry, _)) = self.image_obs(&self.st, k, x) {
                self.weights[k] = self.rho(k, rx, ry).0;
            }
        }
    }

    /// One Levenberg–Marquardt iteration (or one rejection). Returns the progress; `done` when
    /// the solve has converged (and every rejection has been made) or the iteration limit is hit.
    pub fn step(&mut self) -> Result<Progress> {
        if self.finished {
            return Ok(self.progress());
        }
        if self.converged {
            // Blunder rejection: every point's worst measurement beyond k·σ·σ₀ (worst first,
            // within the budget), then solve again. A batch that would leave a parameter
            // undetermined is taken back and rejection stops there.
            if self.rejected.len() < self.opts.max_reject {
                // The robust scale of the normalised residuals (the median of the 2-D norm,
                // whose median is 1.1774 for unit Gaussian noise), not σ₀, which the blunders
                // themselves inflate.
                let s0 = self.robust_scale().max(0.5);
                let mut worst: Vec<(usize, f64)> = Vec::new();
                for j in 0..self.points.len() {
                    if !self.used[j] || self.points[j].kind == PointKind::Gcp {
                        continue;
                    }
                    let Some(x) = self.st.x[j] else { continue };
                    let mut best: Option<(usize, f64)> = None;
                    for &k in &self.by_point[j] {
                        if !self.active[k] {
                            continue;
                        }
                        let Some((rx, ry, _)) = self.image_obs(&self.st, k, x) else { continue };
                        let z = rx.hypot(ry) / (self.obs[k].sigma_px * s0);
                        if z > self.opts.reject_k && best.map_or(true, |(_, w)| z > w) {
                            best = Some((k, z));
                        }
                    }
                    worst.extend(best);
                }
                let o = order(&worst.iter().map(|w| -w.1).collect::<Vec<_>>());
                let mut worst: Vec<(usize, f64)> = o.into_iter().map(|k| worst[k]).collect();
                worst.truncate(self.opts.max_reject - self.rejected.len());
                if !worst.is_empty() {
                    let saved = (self.active.clone(), self.used.clone(), self.st.x.clone(), self.rejected.len());
                    for &(k, _) in &worst {
                        self.active[k] = false;
                        self.rejected.push(k);
                        let j = self.obs[k].point;
                        let left = self.by_point[j].iter().filter(|&&q| self.active[q]).count();
                        if left < if self.points[j].kind == PointKind::Gcp { 1 } else { 2 } {
                            self.used[j] = false;
                            self.st.x[j] = None;
                        }
                    }
                    self.forced = false;
                    self.no_force = false;
                    if let Err(e) = self.structure_check() {
                        self.active = saved.0;
                        self.used = saved.1;
                        self.st.x = saved.2;
                        self.rejected.truncate(saved.3);
                        self.notes.push(format!("blunder rejection stopped: rejecting more would leave the block singular ({e})"));
                    } else {
                        self.converged = false;
                        self.round = 0;
                        self.cost = f64::INFINITY;
                        self.lambda = 1e-3;
                        return Ok(self.progress());
                    }
                }
            }
            if self.forced {
                // Triggered by the iteration count, with nothing beyond the threshold: not the
                // end of the solve. Iterate on.
                self.forced = false;
                self.no_force = true;
                self.converged = false;
                return Ok(self.progress());
            }
            self.finished = true;
            return Ok(self.progress());
        }
        self.update_weights();
        let nm = self.assemble(&self.st, false)?;
        let cur = nm.cost;
        let mut accepted = false;
        for _ in 0..14 {
            if let Some((dc, dx, ymax)) = self.solve_damped(&nm, self.lambda) {
                let trial = self.apply(&self.st, &dc, &dx);
                if let Some(c) = self.cost_at(&trial) {
                    if c <= cur * (1.0 + 1e-14) {
                        let rel = (cur - c) / cur.max(1e-300);
                        self.last_rel = rel;
                        self.st = trial;
                        self.cost = c;
                        self.last_step = ymax;
                        self.lambda = (self.lambda / 10.0).max(1e-12);
                        accepted = true;
                        // Converged when the cost no longer falls or the step is a small fraction
                        // of σ (IRLS converges linearly: 1e-4 σ is far below the precision).
                        // Under robust weighting a point whose rays all sit in the linear part of
                        // the loss can slide along a flat valley (an L1-like non-uniqueness): a
                        // cost change under 0.01 (units of σ²) with a step under 1 % of σ is the end.
                        if rel < 1e-10 || ymax < 1e-4 || (cur - c < 1e-2 && ymax < 1e-2) {
                            self.converged = true;
                        } else if self.opts.robust != Robust::None && (rel < 1e-5 || (self.rejected.len() < self.opts.max_reject && ((rel < 1e-4 && self.round >= 3) || (self.round >= 15 && !self.no_force)))) {
                            // The robust cost has stalled while parameters still move: points in
                            // the linear part of the loss (blunders). Reject (from a stall of 1e-4
                            // per iteration, or after 15 iterations, while the rejection budget
                            // lasts), or stop with a note.
                            self.converged = true;
                            self.forced = !(rel < 1e-4);
                            if self.rejected.len() >= self.opts.max_reject {
                                self.notes.push(format!("the robust cost stopped falling while parameters still moved by up to {ymax:.1} σ: many measurements are in the linear part of the loss (blunders); allow blunder rejection"));
                            }
                        }
                        break;
                    }
                }
            }
            self.lambda *= 10.0;
        }
        self.iteration += 1;
        self.round += 1;
        if !accepted {
            self.cost = cur;
            if self.last_rel < 1e-6 || self.round == 0 {
                // No step lowers the cost after a small last change: the minimum (to rounding).
                self.converged = true;
            } else {
                // No step lowers the cost while the last one still moved it: a stall (a point
                // behind its camera at every trial, or a geometry too weak to step in). Not a
                // solution: stop and say so.
                self.notes.push("the solve stalled: no step lowers the cost although the last one changed it (check the approximations and the blunders); the result is not converged".to_string());
                self.finished = true;
            }
        }
        if self.round >= self.opts.max_iterations && !self.converged {
            self.notes.push(format!("stopped at the iteration limit ({})", self.opts.max_iterations));
            self.finished = true;
        }
        Ok(self.progress())
    }

    fn progress(&self) -> Progress {
        Progress { iteration: self.iteration, cost: self.cost, lambda: self.lambda, rejected: self.rejected.len(), done: self.finished, step: self.last_step }
    }

    /// Run to the end (tests, the command line).
    pub fn run(&mut self) -> Result<()> {
        while !self.step()?.done {}
        Ok(())
    }

    /// The median 2-D normalised residual of the used measurements over its value for unit
    /// Gaussian noise (1.1774): a scale the blunders do not inflate.
    pub fn robust_scale(&self) -> f64 {
        let mut z: Vec<f64> = Vec::with_capacity(self.obs.len());
        for (k, o) in self.obs.iter().enumerate() {
            if !self.active[k] || !self.used[o.point] {
                continue;
            }
            let Some(x) = self.st.x[o.point] else { continue };
            if let Some((rx, ry, _)) = self.image_obs(&self.st, k, x) {
                z.push(rx.hypot(ry) / o.sigma_px);
            }
        }
        if z.is_empty() {
            return 1.0;
        }
        let o = order(&z);
        z[o[z.len() / 2]] / 1.1774
    }

    /// (σ₀, degrees of freedom) at the current state.
    pub fn sigma0(&self) -> (f64, i64) {
        let mut nobs = 0i64;
        let mut vpv = 0.0;
        for (k, o) in self.obs.iter().enumerate() {
            if !self.active[k] || !self.used[o.point] {
                continue;
            }
            let Some(x) = self.st.x[o.point] else { continue };
            if let Some((rx, ry, _)) = self.image_obs(&self.st, k, x) {
                vpv += self.weights[k] * (rx * rx + ry * ry) / o.sigma_px.powi(2);
                nobs += 2;
            }
        }
        vpv += self.quad_cost(&self.st);
        nobs += 3 * (0..self.points.len()).filter(|&j| self.points[j].kind == PointKind::Gcp && self.used[j]).count() as i64;
        nobs += 3 * self.gnss.iter().flatten().count() as i64 + 3 * self.imu.iter().flatten().count() as i64;
        for c in &self.cams {
            nobs += (0..NIO).filter(|&q| c.io_free[q] && c.io_sigma[q] > 0.0).count() as i64;
            nobs += (0..6).filter(|&q| c.mount_free[q] && c.mount_sigma[q] > 0.0).count() as i64;
        }
        let unknowns = self.params.len() as i64 + 3 * self.used.iter().filter(|u| **u).count() as i64;
        let dof = nobs - unknowns;
        ((if dof > 0 { (vpv / dof as f64).sqrt() } else { f64::NAN }), dof)
    }

    // ---- the report ----

    pub fn report(&self) -> Result<Report> {
        let (sigma0, dof) = self.sigma0();
        let s2 = if sigma0.is_finite() { sigma0 * sigma0 } else { 1.0 };
        let mut notes = self.notes.clone();
        let nm = self.assemble(&self.st, false)?;
        let (red, _) = self.reduce(&nm, 0.0).ok_or_else(|| Error::invalid("aerial triangulation: a point's normal block is singular"))?;
        let n = red.n;
        // Q = S⁻¹ (scaled Cholesky).
        let q = if n > 0 {
            let d: Vec<f64> = (0..n).map(|i| 1.0 / red.at(i, i).max(1e-300).sqrt()).collect();
            let mut sc = red.clone();
            for i in 0..n {
                for j in 0..n {
                    sc.set(i, j, red.at(i, j) * d[i] * d[j]);
                }
            }
            match cholesky(&sc) {
                Some(l) => {
                    let inv = gw_adjust::linalg::chol_inverse(&l);
                    let mut qm = Mat::zeros(n);
                    for i in 0..n {
                        for j in 0..n {
                            qm.set(i, j, inv.at(i, j) * d[i] * d[j]);
                        }
                    }
                    qm
                }
                None => {
                    // The solution stands; its covariance does not (σ, correlations: NaN).
                    notes.push("the normal matrix is singular at the solution: no covariance (σ and correlations are not given); hold or give a priori σ to the weak parameters".to_string());
                    let mut qm = Mat::zeros(n);
                    qm.a.iter_mut().for_each(|v| *v = f64::NAN);
                    qm
                }
            }
        } else {
            Mat::zeros(0)
        };
        let sigma = |k: usize| (s2 * q.at(k, k)).max(0.0).sqrt();
        // Global correlation: sqrt(1 - 1/(Q_ii N_ii)).
        let global = |k: usize| (1.0 - 1.0 / (q.at(k, k) * red.at(k, k)).max(1.0)).max(0.0).sqrt();
        let corr = |a: usize, b: usize| q.at(a, b) / (q.at(a, a) * q.at(b, b)).max(1e-300).sqrt();
        // Images.
        let mut images = Vec::new();
        for i in 0..self.images.len() {
            let g = self.geodetic(self.st.c[i]);
            let r_enu = self.rot_to_enu(g, &self.st.r[i]);
            let mut sg = [f64::NAN; 6];
            if let Some(off) = self.eo_off[i] {
                for t in 0..6 {
                    sg[t] = sigma(off + t);
                }
                for t in 3..6 {
                    sg[t] = sg[t].to_degrees();
                }
            }
            images.push(ImageOut { centre: g, r_ecef: mul(&self.st.r[i], &self.e_o), opk: opk_of(&r_enu), sigma: sg, gnss: self.gnss_residual(&self.st, i), imu: self.imu_residual(&self.st, i).map(|v| v.map(f64::to_degrees)), approx: self.approx_kind[i] });
        }
        // Cameras.
        let mut cameras = Vec::new();
        for c in 0..self.cams.len() {
            let free: Vec<usize> = (0..NIO).filter(|&t| self.io_idx[c][t].is_some()).collect();
            let mut s = [f64::NAN; NIO];
            for &t in &free {
                s[t] = sigma(self.io_idx[c][t].unwrap());
            }
            let mut cm = Vec::with_capacity(free.len() * free.len());
            for &a in &free {
                for &b in &free {
                    cm.push(corr(self.io_idx[c][a].unwrap(), self.io_idx[c][b].unwrap()));
                }
            }
            let mut ms = [f64::NAN; 6];
            let mut mg = [f64::NAN; 6];
            for t in 0..6 {
                if let Some(p) = self.mount_idx[c][t] {
                    ms[t] = sigma(p);
                    mg[t] = global(p);
                }
            }
            let mut gl = [f64::NAN; NIO];
            for &t in &free {
                gl[t] = global(self.io_idx[c][t].unwrap());
            }
            cameras.push(CameraOut { io: self.st.io[c], sigma: s, free, corr: cm, global: gl, mount: self.st.mount[c], mount_sigma: ms, mount_global: mg });
        }
        // Strongly correlated pairs.
        let mut pairs = Vec::new();
        for a in 0..n {
            for b in a + 1..n {
                let pa = self.params[a];
                let pb = self.params[b];
                let involves = pa.kind != ParamKind::Eo || pb.kind != ParamKind::Eo;
                let r = corr(a, b);
                let lim = if involves { self.opts.corr_flag } else { 0.995 };
                if r.abs() >= lim {
                    pairs.push((a, b, r));
                }
            }
        }
        let o = order(&pairs.iter().map(|p| -p.2.abs()).collect::<Vec<_>>());
        let pairs: Vec<(usize, usize, f64)> = o.into_iter().take(200).map(|k| pairs[k]).collect();
        let weak: Vec<(ParamId, f64)> = (0..n).filter(|&k| self.params[k].kind != ParamKind::Eo).map(|k| (self.params[k], global(k))).filter(|x| x.1 >= self.opts.global_flag).collect();
        // Points, with their covariance C = σ₀²(N⁻¹ + N⁻¹ Nᵀ Q N N⁻¹).
        let mut points = Vec::with_capacity(self.points.len());
        for j in 0..self.points.len() {
            let (Some(x), Some(blk)) = (self.st.x[j], nm.pts[j].as_ref()) else {
                points.push(None);
                continue;
            };
            let Some(ci) = inv(&blk.nxx) else {
                points.push(None);
                continue;
            };
            let mut cov = ci;
            if n > 0 {
                // T = Nᵀ_cj (rows) · N⁻¹ → for each row a: t_a = ci·va.
                let ts: Vec<(usize, V3)> = blk.rows.iter().map(|&(a, va)| (a, mv(&ci, va))).collect();
                for &(a, ta) in &ts {
                    for &(b, tb) in &ts {
                        let qab = q.at(a, b);
                        for u in 0..3 {
                            for v in 0..3 {
                                cov[u][v] += ta[u] * qab * tb[v];
                            }
                        }
                    }
                }
            }
            let cov = cov.map(|r| r.map(|v| v * s2));
            points.push(Some((self.geodetic(x), cov)));
        }
        // Residuals.
        let mut residuals = Vec::with_capacity(self.obs.len());
        let mut sx = 0.0;
        let mut nres = 0usize;
        for (k, o) in self.obs.iter().enumerate() {
            let known_proj = |x: V3| self.image_obs(&self.st, k, x).map(|(a, b, _)| (a, b));
            let v = match self.st.x[o.point] {
                Some(x) => known_proj(x),
                None => self.gcp[o.point].and_then(known_proj),
            };
            let (vx, vy) = v.unwrap_or((f64::NAN, f64::NAN));
            let z = vx.hypot(vy) / o.sigma_px;
            if self.active[k] && self.used[o.point] && z.is_finite() {
                sx += vx * vx + vy * vy;
                nres += 1;
            }
            residuals.push(ResidualOut { v: (vx, vy), normalized: z, weight: self.weights[k], used: self.active[k] && self.used[o.point], rejected: !self.active[k] });
        }
        let rms_px = if nres > 0 { (sx / (2 * nres) as f64).sqrt() } else { f64::NAN };
        // A minimum of the (robust) cost can still be a poor one: say so when the residuals are
        // far beyond the measurements' own σ.
        let mean_sigma = {
            let s: Vec<f64> = self.obs.iter().enumerate().filter(|(k, o)| self.active[*k] && self.used[o.point]).map(|(_, o)| o.sigma_px).collect();
            s.iter().sum::<f64>() / s.len().max(1) as f64
        };
        if rms_px > 5.0 * mean_sigma {
            notes.push(format!("the residuals are large (RMS {rms_px:.1} px against a measurement σ of {mean_sigma:.1} px): probably a false minimum; check the approximations, the tie points and the datum"));
        }
        // Checkpoints: multi-ray (adjusted as ties), single-ray (horizontal at the known
        // height), and in image space (the known point projected into each image it is measured in).
        let mut multi = Vec::new();
        let mut single = Vec::new();
        let mut image_px = Vec::new();
        let mut check_list = Vec::new();
        for j in 0..self.points.len() {
            let p = &self.points[j];
            if p.kind != PointKind::Check {
                continue;
            }
            let Some(known) = self.gcp[j] else { continue };
            let mut ipx = Vec::new();
            for &k in &self.by_point[j] {
                if !self.active[k] {
                    continue;
                }
                if let Some((vx, vy, _)) = self.image_obs(&self.st, k, known) {
                    ipx.push((self.obs[k].image, vx, vy));
                    image_px.push([vx, vy, 0.0]);
                }
            }
            let mut d3 = None;
            if let Some(x) = self.st.x[j] {
                let d = gw_adjust::block::enu_diff(self.geodetic(x), self.geodetic(known));
                multi.push(d);
                d3 = Some(d);
            }
            // Single ray: the first measurement, intersected with the known height.
            let mut d2 = None;
            if let Some(&k) = self.by_point[j].iter().find(|&&k| self.active[k]) {
                let o = self.obs[k];
                let im = &self.images[o.image];
                if let Some(dr) = back_project(&self.cams[im.camera], &self.st.io[im.camera], im.film.as_ref(), o.x, o.y) {
                    let kg = self.geodetic(known);
                    let dl = mtv(&self.st.r[o.image], dr);
                    let c = self.geodetic(self.st.c[o.image]);
                    // Intersect with the ellipsoidal height of the known point.
                    let ce = geodetic_to_ecef(c.lat, c.lon, c.h);
                    let de = mtv(&self.e_o, dl);
                    if let Ok(g) = gw_sensor::frame::ray_at_height(ce, de, kg.h) {
                        let d = gw_adjust::block::enu_diff(g, kg);
                        single.push([d[0], d[1], 0.0]);
                        d2 = Some([d[0], d[1]]);
                    }
                }
            }
            check_list.push(CheckOut { point: j, d3, d2, image_px: ipx });
        }
        let image_stats = {
            let n = image_px.len();
            if n == 0 {
                (0, f64::NAN, f64::NAN)
            } else {
                let rx = (image_px.iter().map(|v| v[0] * v[0]).sum::<f64>() / n as f64).sqrt();
                let ry = (image_px.iter().map(|v| v[1] * v[1]).sum::<f64>() / n as f64).sqrt();
                (n, rx, ry)
            }
        };
        let gcp = (0..self.points.len())
            .filter(|&j| self.points[j].kind == PointKind::Gcp && self.used[j])
            .filter_map(|j| Some((j, gw_adjust::block::enu_diff(self.geodetic(self.gcp[j]?), self.geodetic(self.st.x[j]?)))))
            .collect();
        let unused = (0..self.points.len()).filter(|&j| !self.used[j] && self.points[j].kind != PointKind::Check).collect();
        Ok(Report {
            sigma0,
            dof,
            iterations: self.iteration,
            converged: self.converged,
            rms_px,
            images,
            cameras,
            pairs: pairs.into_iter().map(|(a, b, r)| (self.params[a], self.params[b], r)).collect(),
            weak,
            points,
            residuals,
            checks_multi: axis_stats(&multi),
            checks_single: axis_stats(&single),
            checks_image: image_stats,
            checks: check_list,
            gcp,
            rejected: self.rejected.clone(),
            unused,
            notes,
            origin: self.origin,
        })
    }

    /// The solved camera of image i as a `gw_sensor::frame` parameter record (orientation kind
    /// 3 or 11: the ECEF → camera matrix), for the app's frame model. Film: the scan affine is
    /// folded into the pixel size, principal point, affinity and a rotation of the camera frame;
    /// a mirrored scan cannot be expressed and gives None.
    pub fn frame_record(&self, i: usize) -> Option<Vec<f64>> {
        if self.excluded[i] {
            return None;
        }
        let im = &self.images[i];
        frame_record_of(&self.cams[im.camera], &self.st.io[im.camera], im.film.as_ref(), self.geodetic(self.st.c[i]), mul(&self.st.r[i], &self.e_o))
    }

    /// The state for tests: local centre, local → camera rotation, IO, mount, point.
    pub fn eo(&self, i: usize) -> (V3, M3) {
        (self.st.c[i], self.st.r[i])
    }
    pub fn io(&self, c: usize) -> [f64; NIO] {
        self.st.io[c]
    }
    pub fn mount(&self, c: usize) -> [f64; 6] {
        self.st.mount[c]
    }
    pub fn point(&self, j: usize) -> Option<V3> {
        self.st.x[j]
    }
}

impl State {
    /// A one-image, one-camera copy (index 0) for the IMU partials.
    fn clone_light(&self, i: usize, c: usize) -> State {
        State { c: vec![self.c[i]], r: vec![self.r[i]], io: vec![self.io[c]], mount: vec![self.mount[c]], x: Vec::new() }
    }
}


/// A solved camera as a `gw_sensor::frame` parameter record (orientation kind 3 or 11: the ECEF →
/// camera matrix), for the app's frame model. Film: the scan affine is folded into the pixel size,
/// principal point, affinity and a rotation of the camera frame; a mirrored scan cannot be
/// expressed and gives None.
pub fn frame_record_of(cam: &CameraIn, io: &[f64; NIO], film: Option<&[f64; 6]>, g: Ground, r_ecef: M3) -> Option<Vec<f64>> {
        let mut r_ecef = r_ecef;
        let (pix, cx, cy, a1, a2, p) = match film {
            None => (cam.pixel_mm, cam.width / 2.0 + io[1] / cam.pixel_mm, cam.height / 2.0 - io[2] / cam.pixel_mm, io[9], io[10], [io[7], io[8]]),
            Some(a) => {
                // px = T + A·(B·xd + pp), B the affinity; A·B = U·Q (RQ), U upper triangular.
                let am = [[a[1], a[2]], [a[4], a[5]]];
                let bm = [[1.0 + io[9], -io[10]], [0.0, 1.0]];
                let m = [[am[0][0] * bm[0][0] + am[0][1] * bm[1][0], am[0][0] * bm[0][1] + am[0][1] * bm[1][1]], [am[1][0] * bm[0][0] + am[1][1] * bm[1][0], am[1][0] * bm[0][1] + am[1][1] * bm[1][1]]];
                let u22 = -m[1][0].hypot(m[1][1]);
                let (s, c) = (m[1][0] / u22, m[1][1] / u22);
                let u11 = m[0][0] * c - m[0][1] * s;
                let u12 = m[0][0] * s + m[0][1] * c;
                let pix = -1.0 / u22;
                if !(u11 > 0.0) {
                    return None;
                }
                let cxy = (a[0] + a[1] * io[1] + a[2] * io[2], a[3] + a[4] * io[1] + a[5] * io[2]);
                // Rotate the camera frame by Q about z (v' = Rz v, Rz's xy block = Q).
                let rz = [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]];
                r_ecef = mul(&rz, &r_ecef);
                let p = [c * io[7] - s * io[8], s * io[7] + c * io[8]];
                (pix, cxy.0, cxy.1, u11 * pix - 1.0, -u12 * pix, p)
            }
        };
        let (w, h) = if let Some(a) = film {
            // The scan's extent from the film corners (±115 mm).
            let xs = [-115.0, 115.0];
            let mut wmax: f64 = 0.0;
            let mut hmax: f64 = 0.0;
            for x in xs {
                for y in xs {
                    wmax = wmax.max(a[0] + a[1] * x + a[2] * y);
                    hmax = hmax.max(a[3] + a[4] * x + a[5] * y);
                }
            }
            (wmax, hmax)
        } else {
            (cam.width, cam.height)
        };
        let ext = io[6] != 0.0 || cam.projection == Projection::Fisheye;
        let mut v = vec![if ext { 11.0 } else { 3.0 }, io[0], pix, cx, cy, io[3], io[4], io[5], p[0], p[1], a1, a2, w, h];
        if ext {
            v.push(io[6]);
            v.push(if cam.projection == Projection::Fisheye { 1.0 } else { 0.0 });
        }
        v.extend_from_slice(&[g.lat, g.lon, g.h]);
        v.extend(r_ecef.iter().flatten());
        v.push(0.0);
        Some(v)
    }

#[derive(Clone, Debug)]
pub struct ImageOut {
    pub centre: Ground,
    pub r_ecef: M3,
    /// ω, φ, κ (°) relative to ENU at the centre (`gw_sensor::frame::rotation`).
    pub opk: V3,
    /// σ of X, Y, Z (m) and the three rotations (°).
    pub sigma: [f64; 6],
    pub gnss: Option<V3>,
    pub imu: Option<V3>,
    pub approx: u8,
}

#[derive(Clone, Debug)]
pub struct CameraOut {
    pub io: [f64; NIO],
    pub sigma: [f64; NIO],
    pub free: Vec<usize>,
    /// Correlation matrix of the free IO parameters (row-major, free × free).
    pub corr: Vec<f64>,
    /// Global correlation of each free IO parameter with all the other parameters.
    pub global: [f64; NIO],
    pub mount: [f64; 6],
    pub mount_sigma: [f64; 6],
    pub mount_global: [f64; 6],
}

#[derive(Clone, Debug)]
pub struct ResidualOut {
    pub v: (f64, f64),
    pub normalized: f64,
    pub weight: f64,
    pub used: bool,
    pub rejected: bool,
}

#[derive(Clone, Debug)]
pub struct CheckOut {
    pub point: usize,
    /// Adjusted − known (E, N, U m) when the point has two or more rays.
    pub d3: Option<V3>,
    /// The first ray at the known height − known (E, N m).
    pub d2: Option<[f64; 2]>,
    /// (image, vx, vy): measured − known point projected (px).
    pub image_px: Vec<(usize, f64, f64)>,
}

#[derive(Clone, Debug)]
pub struct Report {
    pub sigma0: f64,
    pub dof: i64,
    pub iterations: usize,
    pub converged: bool,
    pub rms_px: f64,
    pub images: Vec<ImageOut>,
    pub cameras: Vec<CameraOut>,
    pub pairs: Vec<(ParamId, ParamId, f64)>,
    /// IO and mount parameters with a global correlation of at least `global_flag`.
    pub weak: Vec<(ParamId, f64)>,
    pub points: Vec<Option<(Ground, M3)>>,
    pub residuals: Vec<ResidualOut>,
    pub checks_multi: AxisStats,
    pub checks_single: AxisStats,
    /// (n, RMS vx, RMS vy) px of the known checkpoints projected into the images.
    pub checks_image: (usize, f64, f64),
    pub checks: Vec<CheckOut>,
    pub gcp: Vec<(usize, V3)>,
    pub rejected: Vec<usize>,
    pub unused: Vec<usize>,
    pub notes: Vec<String>,
    pub origin: Ground,
}

// ---- the job record (photo bundle, fuzz target) -----------------------------------------

fn take<'a>(a: &'a [f64], o: &mut usize, n: usize) -> Result<&'a [f64]> {
    let s = a.get(*o..o.saturating_add(n)).ok_or_else(|| Error::invalid("aerial triangulation job: truncated"))?;
    *o += n;
    Ok(s)
}

/// Values per camera in the job.
pub const CAM_LEN: usize = 5 + 3 * NIO + 18;

/// One camera record of a job (`CAM_LEN` values; see `decode_job`).
pub fn decode_camera(r: &[f64]) -> CameraIn {
    let mut io = [0.0; NIO];
    let mut free = [false; NIO];
    let mut sg = [0.0; NIO];
    for q in 0..NIO {
        io[q] = r[5 + q];
        free[q] = r[5 + NIO + q] != 0.0;
        sg[q] = r[5 + 2 * NIO + q].max(0.0);
    }
    let m = &r[5 + 3 * NIO..];
    let deg = std::f64::consts::PI / 180.0;
    CameraIn {
        projection: if r[0] == 1.0 { Projection::Fisheye } else { Projection::Brown },
        film: r[1] != 0.0,
        pixel_mm: r[2],
        width: r[3],
        height: r[4],
        io,
        io_free: free,
        io_sigma: sg,
        mount: [m[0], m[1], m[2], m[3] * deg, m[4] * deg, m[5] * deg],
        mount_free: [0, 1, 2, 3, 4, 5].map(|q| m[6 + q] != 0.0),
        mount_sigma: [m[12].max(0.0), m[13].max(0.0), m[14].max(0.0), m[15].max(0.0) * deg, m[16].max(0.0) * deg, m[17].max(0.0) * deg],
    }
}

/// Space resection of one image (REQ-GAP-22): job [camera record (`CAM_LEN`), film flag,
/// affine[6], robust (0/1), n, approximation record length m (0 none), the frame record (m),
/// then n × (lat, lon, h, x, y, σ px)]. JSON {lat, lon, h, opk, record, sigma (X, Y, Z m and the
/// rotations °), residuals [[vx, vy, weight]], sigma0, dof, method, maxCorr, iterations}.
pub fn resect_job(a: &[f64]) -> Result<String> {
    let mut o = 0;
    let cam = decode_camera(take(a, &mut o, CAM_LEN)?);
    let h = take(a, &mut o, 10)?;
    let film = (h[0] != 0.0).then(|| [h[1], h[2], h[3], h[4], h[5], h[6]]);
    let robust = h[7] != 0.0;
    let n = h[8];
    let m = h[9];
    if !(n >= 0.0 && n <= 1e5 && n.fract() == 0.0 && m >= 0.0 && m <= 200.0 && m.fract() == 0.0) {
        return Err(Error::invalid("resection job: a count is out of range"));
    }
    let (n, m) = (n as usize, m as usize);
    if cam.film != film.is_some() || !(cam.io[0] > 0.0) || (!cam.film && !(cam.pixel_mm > 0.0 && cam.width > 0.0 && cam.height > 0.0)) {
        return Err(Error::invalid("resection job: the camera needs a focal length and format (or the film transform)"));
    }
    let rec = take(a, &mut o, m)?;
    let init_g = if m > 0 { Some(gw_sensor::frame::frame_from_params(rec, "")?) } else { None };
    let rows = take(a, &mut o, n * 6)?;
    if o != a.len() {
        return Err(Error::invalid("resection job: length does not match its counts"));
    }
    let gs: Vec<Ground> = rows.chunks_exact(6).map(|r| Ground { lat: r[0], lon: r[1], h: r[2] }).collect();
    if gs.iter().any(|g| !(g.lat.abs() <= 90.0 && g.lon.is_finite() && g.h.is_finite())) {
        return Err(Error::invalid("resection job: a ground point is not a valid latitude, longitude and height"));
    }
    if gs.is_empty() {
        return Err(gw_abi::err!(INVALID, "resection needs at least {n} points with known ground coordinates", n = 4));
    }
    // A local frame at the points' centroid.
    let mut acc = [0.0; 3];
    for g in &gs {
        acc = add(acc, geodetic_to_ecef(g.lat, g.lon, g.h));
    }
    let oe = scale(acc, 1.0 / gs.len() as f64);
    let (lat0, lon0, _) = ecef_to_geodetic(oe[0], oe[1], oe[2]);
    let e_o = enu_rotation(lat0, lon0);
    let local = |g: &Ground| mv(&e_o, sub(geodetic_to_ecef(g.lat, g.lon, g.h), oe));
    let pts: Vec<V3> = gs.iter().map(local).collect();
    let px: Vec<(f64, f64)> = rows.chunks_exact(6).map(|r| (r[3], r[4])).collect();
    let sg: Vec<f64> = rows.chunks_exact(6).map(|r| r[5]).collect();
    let init = init_g.map(|f| {
        let c = local(&f.centre);
        let r = mul(&mul(&f.rotation_matrix(), &enu_rotation(f.centre.lat, f.centre.lon)), &tr(&e_o));
        (c, r)
    });
    let out = crate::resect::resect(&cam, &cam.io, film.as_ref(), &pts, &px, &sg, init, robust)?;
    let ce = add(oe, mtv(&e_o, out.c));
    let (lat, lon, hh) = ecef_to_geodetic(ce[0], ce[1], ce[2]);
    let g = Ground { lat, lon, h: hh };
    let r_ecef = mul(&out.r, &e_o);
    let r_enu = mul(&r_ecef, &tr(&enu_rotation(lat, lon)));
    let opk = opk_of(&r_enu);
    let mut j = Json::new();
    j.obj().kv_num("lat", lat).kv_num("lon", lon).kv_num("h", hh).key("opk").arr().num(opk[0]).num(opk[1]).num(opk[2]).end_arr();
    match frame_record_of(&cam, &cam.io, film.as_ref(), g, r_ecef) {
        Some(rec) => {
            j.key("record").arr();
            for v in rec {
                j.num(v);
            }
            j.end_arr();
        }
        None => {
            j.key("record").null();
        }
    }
    j.key("sigma").arr();
    for k in 0..6 {
        let s = out.cov[k][k].max(0.0).sqrt();
        j.num(if k >= 3 { s.to_degrees() } else { s });
    }
    j.end_arr().key("residuals").arr();
    for (v, w) in out.residuals.iter().zip(&out.weights) {
        j.arr().num(v.0).num(v.1).num(*w).end_arr();
    }
    j.end_arr().kv_num("sigma0", out.sigma0).kv_int("dof", out.dof).kv_str("method", out.method).kv_num("maxCorr", out.max_corr).kv_int("iterations", out.iterations as i64).end_obj();
    Ok(j.finish())
}

/// Film interior orientation (REQ-GAP-22): job [model (0 similarity, 1 affine), n, n × (col, row,
/// x mm, y mm)]. JSON {pxToMm, mmToPx, residualsUm, rmsUm, maxUm, sigma0Um, dof, pixelUm,
/// rotationDeg, shearDeg, mirrored}.
pub fn fiducial_job(a: &[f64]) -> Result<String> {
    use crate::fiducial::{fiducial_io, FidModel};
    if a.len() < 2 || !(a[1] >= 0.0 && a[1] <= 64.0 && a[1].fract() == 0.0) || a.len() != 2 + 4 * a[1] as usize {
        return Err(Error::invalid("fiducial job: wrong length"));
    }
    let model = if a[0] == 0.0 { FidModel::Similarity } else { FidModel::Affine };
    let px: Vec<(f64, f64)> = a[2..].chunks_exact(4).map(|r| (r[0], r[1])).collect();
    let mm: Vec<(f64, f64)> = a[2..].chunks_exact(4).map(|r| (r[2], r[3])).collect();
    let o = fiducial_io(&px, &mm, model)?;
    let mut j = Json::new();
    j.obj().key("pxToMm").arr();
    for v in o.px_to_mm {
        j.num(v);
    }
    j.end_arr().key("mmToPx").arr();
    for v in o.mm_to_px {
        j.num(v);
    }
    j.end_arr().key("residualsUm").arr();
    for (x, y) in &o.residuals_um {
        j.arr().num(*x).num(*y).end_arr();
    }
    j.end_arr().kv_num("rmsUm", o.rms_um).kv_num("maxUm", o.max_um).kv_num("sigma0Um", o.sigma0_um).kv_int("dof", o.dof);
    j.key("pixelUm").arr().num(o.pixel_um.0).num(o.pixel_um.1).end_arr().kv_num("rotationDeg", o.rotation_deg).kv_num("shearDeg", o.shear_deg).kv_bool("mirrored", o.mirrored).end_obj();
    Ok(j.finish())
}

/// Decode an AT job: [31, 1, nCams, nImages, nPoints, nObs, maxIterations, robust (0 none, 1
/// Huber, 2 Cauchy), robust k, reject k, max reject, correlation flag], then per camera
/// [projection (0 Brown, 1 fisheye), film, pixel mm, width, height, io[11], io free[11], io σ[11],
/// lever xyz (m), boresight xyz (°), mount free[6], mount σ[6] (m, °)], per image [camera,
/// fixed, attitude known, gnss flag, σE, σN, σU, imu flag, σ x, y, z (°), film flag, affine[6],
/// record length n, frame record (n; `gw_sensor::frame::frame_from_params`, 0 = none)], points
/// [kind 0 tie / 1 GCP / 2 check, lat, lon, h, σH, σV] and measurements [image, point, x, y, σ px].
pub fn decode_job(a: &[f64]) -> Result<(Vec<CameraIn>, Vec<ImageIn>, Vec<PointIn>, Vec<ObsIn>, AeroOptions)> {
    let bad = |w: &str| gw_abi::err!(INVALID, "aerial triangulation job: {what}", what = w.to_string());
    if a.len() < 12 || a[0] != 31.0 || a[1] != 1.0 {
        return Err(bad("bad header"));
    }
    let cnt = |v: f64, max: f64| -> Result<usize> {
        if v.is_finite() && v >= 0.0 && v <= max && v.fract() == 0.0 {
            Ok(v as usize)
        } else {
            Err(Error::invalid("aerial triangulation job: a count is out of range"))
        }
    };
    let (nc, ni, np, no) = (cnt(a[2], 64.0)?, cnt(a[3], 5000.0)?, cnt(a[4], 2e6)?, cnt(a[5], 2e7)?);
    let robust = match a[7] as i32 {
        1 => Robust::Huber(if a[8] > 0.0 { a[8] } else { 1.5 }),
        2 => Robust::Cauchy(if a[8] > 0.0 { a[8] } else { 2.0 }),
        _ => Robust::None,
    };
    let opts = AeroOptions { max_iterations: cnt(a[6].clamp(1.0, 500.0).round(), 500.0)?, robust, reject_k: if a[9] > 0.0 { a[9] } else { 4.0 }, max_reject: cnt(a[10].clamp(0.0, 1e6).round(), 1e6)?, corr_flag: if a[11] > 0.0 && a[11] < 1.0 { a[11] } else { 0.9 }, global_flag: 0.99 };
    let mut o = 12;
    let mut cams = Vec::with_capacity(nc);
    for _ in 0..nc {
        cams.push(decode_camera(take(a, &mut o, CAM_LEN)?));
    }
    let mut images = Vec::with_capacity(ni);
    for _ in 0..ni {
        let r = take(a, &mut o, 19)?;
        let n = cnt(r[18], 200.0)?;
        let rec = take(a, &mut o, n)?;
        let approx = if n > 0 {
            let m = gw_sensor::frame::frame_from_params(rec, "")?;
            Some((m.centre, m.rotation_matrix()))
        } else {
            None
        };
        let deg = std::f64::consts::PI / 180.0;
        images.push(ImageIn {
            camera: cnt(r[0], 63.0)?,
            fixed: r[1] != 0.0,
            attitude_known: r[2] != 0.0 && n > 0,
            gnss: (r[3] != 0.0).then(|| [r[4], r[5], r[6]]),
            imu: (r[7] != 0.0).then(|| [r[8] * deg, r[9] * deg, r[10] * deg]),
            film: (r[11] != 0.0).then(|| [r[12], r[13], r[14], r[15], r[16], r[17]]),
            approx,
        });
    }
    let mut points = Vec::with_capacity(np);
    for _ in 0..np {
        let r = take(a, &mut o, 6)?;
        let kind = match r[0] as i32 {
            1 => PointKind::Gcp,
            2 => PointKind::Check,
            _ => PointKind::Tie,
        };
        let known = (r[1].is_finite() && r[2].is_finite() && r[3].is_finite() && r[1].abs() <= 90.0).then_some(Ground { lat: r[1], lon: r[2], h: r[3] });
        points.push(PointIn { kind, known, sigma_h: r[4], sigma_v: r[5] });
    }
    let rest = take(a, &mut o, no * 5)?;
    if o != a.len() {
        return Err(bad("length does not match its counts"));
    }
    let mut obs = Vec::with_capacity(no);
    for r in rest.chunks_exact(5) {
        obs.push(ObsIn { image: cnt(r[0], 1e9)?, point: cnt(r[1], 1e9)?, x: r[2], y: r[3], sigma_px: r[4] });
    }
    Ok((cams, images, points, obs, opts))
}

fn stats_json(j: &mut Json, key: &str, s: &AxisStats) {
    j.key(key).obj().kv_int("n", s.n as i64).key("rmse").arr().num(s.rmse[0]).num(s.rmse[1]).num(s.rmse[2]).end_arr();
    j.kv_num("rmseR", s.rmse_r).kv_num("rmse3d", s.rmse_3d).kv_num("ce90", s.ce90).kv_num("le90", s.le90);
    j.key("max").arr().num(s.max[0]).num(s.max[1]).num(s.max[2]).end_arr().end_obj();
}

/// "key": [values…].
#[inline(never)]
fn nums(j: &mut Json, key: &str, v: &[f64]) {
    j.key(key).arr();
    for x in v {
        j.num(*x);
    }
    j.end_arr();
}

fn pid_json(j: &mut Json, p: &ParamId) {
    j.arr().int(match p.kind {
        ParamKind::Eo => 0,
        ParamKind::Io => 1,
        ParamKind::Mount => 2,
    })
    .int(p.owner as i64)
    .int(p.which as i64)
    .end_arr();
}

/// The report as JSON (the photo bundle's output; see `features/aero` in the app).
pub fn report_json(a: &Aero, r: &Report) -> String {
    let mut j = Json::new();
    j.obj().kv_num("sigma0", r.sigma0).kv_int("dof", r.dof).kv_int("iterations", r.iterations as i64).kv_bool("converged", r.converged).kv_num("rmsPx", r.rms_px);
    j.key("origin").arr().num(r.origin.lat).num(r.origin.lon).num(r.origin.h).end_arr();
    j.key("cameras").arr();
    for c in &r.cameras {
        j.obj().key("io").arr();
        for v in c.io {
            j.num(v);
        }
        j.end_arr();
        nums(&mut j, "sigma", &c.sigma);
        j.key("free").arr();
        for v in &c.free {
            j.int(*v as i64);
        }
        j.end_arr();
        nums(&mut j, "corr", &c.corr);
        j.key("global").arr();
        for v in c.global {
            j.num(v);
        }
        j.end_arr();
        nums(&mut j, "mountGlobal", &c.mount_global);
        j.key("mount").arr();
        for (q, v) in c.mount.iter().enumerate() {
            j.num(if q >= 3 { v.to_degrees() } else { *v });
        }
        j.end_arr().key("mountSigma").arr();
        for (q, v) in c.mount_sigma.iter().enumerate() {
            j.num(if q >= 3 { v.to_degrees() } else { *v });
        }
        j.end_arr().end_obj();
    }
    j.end_arr().key("images").arr();
    for (i, im) in r.images.iter().enumerate() {
        j.obj().kv_num("lat", im.centre.lat).kv_num("lon", im.centre.lon).kv_num("h", im.centre.h).kv_int("approx", im.approx as i64).kv_bool("excluded", a.excluded[i]);
        j.key("opk").arr().num(im.opk[0]).num(im.opk[1]).num(im.opk[2]).end_arr();
        nums(&mut j, "sigma", &im.sigma);
        match im.gnss {
            Some(g) => {
                j.key("gnss").arr().num(g[0]).num(g[1]).num(g[2]).end_arr();
            }
            None => {
                j.key("gnss").null();
            }
        }
        match im.imu {
            Some(g) => {
                j.key("imu").arr().num(g[0]).num(g[1]).num(g[2]).end_arr();
            }
            None => {
                j.key("imu").null();
            }
        }
        match a.frame_record(i) {
            Some(rec) => {
                nums(&mut j, "record", &rec);
            }
            None => {
                j.key("record").null();
            }
        }
        j.end_obj();
    }
    j.end_arr().key("pairs").arr();
    for (pa, pb, rr) in &r.pairs {
        j.arr();
        pid_json(&mut j, pa);
        pid_json(&mut j, pb);
        j.num(*rr).end_arr();
    }
    j.end_arr().key("weak").arr();
    for (p, g) in &r.weak {
        j.arr();
        pid_json(&mut j, p);
        j.num(*g).end_arr();
    }
    j.end_arr().key("points").arr();
    for p in &r.points {
        match p {
            Some((g, c)) => {
                j.arr().num(g.lat).num(g.lon).num(g.h).num(c[0][0].max(0.0).sqrt()).num(c[1][1].max(0.0).sqrt()).num(c[2][2].max(0.0).sqrt()).end_arr();
            }
            None => {
                j.null();
            }
        }
    }
    j.end_arr().key("residuals").arr();
    for v in &r.residuals {
        j.arr().num(v.v.0).num(v.v.1).num(v.normalized).num(v.weight).bool(v.used).bool(v.rejected).end_arr();
    }
    j.end_arr();
    stats_json(&mut j, "checkMulti", &r.checks_multi);
    stats_json(&mut j, "checkSingle", &r.checks_single);
    j.key("checkImage").arr().int(r.checks_image.0 as i64).num(r.checks_image.1).num(r.checks_image.2).end_arr();
    j.key("checks").arr();
    for c in &r.checks {
        j.obj().kv_int("point", c.point as i64);
        match c.d3 {
            Some(d) => {
                j.key("d3").arr().num(d[0]).num(d[1]).num(d[2]).end_arr();
            }
            None => {
                j.key("d3").null();
            }
        }
        match c.d2 {
            Some(d) => {
                j.key("d2").arr().num(d[0]).num(d[1]).end_arr();
            }
            None => {
                j.key("d2").null();
            }
        }
        j.key("px").arr();
        for (i, x, y) in &c.image_px {
            j.arr().int(*i as i64).num(*x).num(*y).end_arr();
        }
        j.end_arr().end_obj();
    }
    j.end_arr().key("gcp").arr();
    for (k, d) in &r.gcp {
        j.arr().int(*k as i64).num(d[0]).num(d[1]).num(d[2]).end_arr();
    }
    j.end_arr().key("rejected").arr();
    for k in &r.rejected {
        j.int(*k as i64);
    }
    j.end_arr().key("unused").arr();
    for k in &r.unused {
        j.int(*k as i64);
    }
    j.end_arr().key("notes").arr();
    for n in &r.notes {
        j.str(n);
    }
    j.end_arr().end_obj();
    j.finish()
}
