//! Frame cameras and line scanners (REQ-SNS-04, REQ-SNS-14): the collinearity model with Brown
//! distortion for aerial frames, and a pushbroom model whose position and attitude are
//! polynomials in time, row by row. This is the pure-Rust fallback that D4 names until a rebuilt
//! usgscsm passes spike S-05.
//!
//! Conventions: attitude (ω, φ, κ) rotates the camera's local east-north-up frame into the camera
//! frame, v_cam = R_κ R_φ R_ω v_enu (ω about east, φ about north, κ about up). The camera looks
//! along −z_cam; image x (mm) is +x_cam, image y (mm) is +y_cam; columns grow with x and rows
//! with −y. With zero angles the image is north-up with east to the right.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::wgs84::{ecef_to_geodetic, enu_rotation, geodetic_to_ecef};

/// Interior orientation.
#[derive(Clone, Copy, Debug)]
pub struct Camera {
    /// Focal length and pixel pitch (mm).
    pub focal_mm: f64,
    pub pixel_mm: f64,
    /// Principal point (corner-origin pixels).
    pub cx: f64,
    pub cy: f64,
    /// Brown radial (k1, k2, k3, mm⁻² …) and decentring (p1, p2) distortion on image mm.
    pub k: [f64; 3],
    pub p: [f64; 2],
    /// Affinity and non-orthogonality (Agisoft B1/f, B2/f): column = cx + (x·(1 + a₁) − y·a₂)/pixel.
    pub aff: [f64; 2],
    pub width: f64,
    pub height: f64,
    /// A fourth radial term (k4·r⁸; REQ-GAP-22 self-calibration).
    pub k4: f64,
    /// Equidistant fisheye projection (REQ-GAP-22): ideal image mm = f·θ along the azimuth of the
    /// ray (θ the angle off the optical axis), and the radial polynomial in θ² (dimensionless k,
    /// the Kannala–Brandt form of OpenCV `cv::fisheye`) instead of r² in mm.
    pub fisheye: bool,
}

impl Default for Camera {
    fn default() -> Self {
        Camera { focal_mm: 100.0, pixel_mm: 0.005, cx: 0.0, cy: 0.0, k: [0.0; 3], p: [0.0; 2], aff: [0.0; 2], width: 0.0, height: 0.0, k4: 0.0, fisheye: false }
    }
}

/// Rotation matrix ENU → camera from ω, φ, κ (degrees).
pub fn rotation(omega: f64, phi: f64, kappa: f64) -> [[f64; 3]; 3] {
    let (so, co) = omega.to_radians().sin_cos();
    let (sp, cp) = phi.to_radians().sin_cos();
    let (sk, ck) = kappa.to_radians().sin_cos();
    let rx = [[1.0, 0.0, 0.0], [0.0, co, so], [0.0, -so, co]];
    let ry = [[cp, 0.0, -sp], [0.0, 1.0, 0.0], [sp, 0.0, cp]];
    let rz = [[ck, sk, 0.0], [-sk, ck, 0.0], [0.0, 0.0, 1.0]];
    mul(&rz, &mul(&ry, &rx))
}

fn mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    o
}
fn mv(a: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}
fn mtv(a: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[0][i] * v[0] + a[1][i] * v[1] + a[2][i] * v[2])
}

impl Camera {
    fn distort(&self, x: f64, y: f64) -> (f64, f64) {
        let r2 = x * x + y * y;
        let s = if self.fisheye { r2 / (self.focal_mm * self.focal_mm) } else { r2 };
        let rad = 1.0 + s * (self.k[0] + s * (self.k[1] + s * (self.k[2] + s * self.k4)));
        (x * rad + self.p[0] * (r2 + 2.0 * x * x) + 2.0 * self.p[1] * x * y, y * rad + self.p[1] * (r2 + 2.0 * y * y) + 2.0 * self.p[0] * x * y)
    }
    fn undistort(&self, xd: f64, yd: f64) -> (f64, f64) {
        let (mut x, mut y) = (xd, yd);
        for _ in 0..20 {
            let (a, b) = self.distort(x, y);
            let (ex, ey) = (xd - a, yd - b);
            x += ex;
            y += ey;
            if ex.abs() + ey.abs() < 1e-12 {
                break;
            }
        }
        (x, y)
    }
    /// Pixel → ideal image mm.
    fn to_mm(&self, col: f64, row: f64) -> (f64, f64) {
        let yd = -(row - self.cy) * self.pixel_mm;
        let xd = ((col - self.cx) * self.pixel_mm + yd * self.aff[1]) / (1.0 + self.aff[0]);
        self.undistort(xd, yd)
    }
    /// Ideal image mm → pixel.
    fn to_px(&self, x: f64, y: f64) -> (f64, f64) {
        let (xd, yd) = self.distort(x, y);
        (self.cx + (xd * (1.0 + self.aff[0]) - yd * self.aff[1]) / self.pixel_mm, self.cy - yd / self.pixel_mm)
    }
    /// Camera-frame vector → ideal image mm (pinhole or equidistant fisheye); None behind the
    /// camera (pinhole) or more than 100° off the optical axis (fisheye).
    pub fn ideal(&self, v: [f64; 3]) -> Option<(f64, f64)> {
        let f = self.focal_mm;
        if !self.fisheye {
            return (v[2] < 0.0).then(|| (-f * v[0] / v[2], -f * v[1] / v[2]));
        }
        let rho = v[0].hypot(v[1]);
        let theta = rho.atan2(-v[2]);
        if !(theta < 100f64.to_radians()) {
            return None;
        }
        let s = if rho > 1e-12 * v[2].abs().max(1e-300) { theta / rho } else { -1.0 / v[2] };
        Some((f * v[0] * s, f * v[1] * s))
    }
    /// Ideal image mm → camera-frame ray (pinhole or fisheye).
    pub fn ray(&self, x: f64, y: f64) -> [f64; 3] {
        if !self.fisheye {
            return [x, y, -self.focal_mm];
        }
        let r = x.hypot(y);
        let theta = r / self.focal_mm;
        if r < 1e-15 {
            return [0.0, 0.0, -1.0];
        }
        let (s, c) = theta.sin_cos();
        [s * x / r, s * y / r, -c]
    }
    /// Camera-frame vector → pixel.
    pub fn project(&self, v: [f64; 3]) -> Option<(f64, f64)> {
        self.ideal(v).map(|(x, y)| self.to_px(x, y))
    }
    /// Pixel → camera-frame ray.
    pub fn back_project(&self, col: f64, row: f64) -> [f64; 3] {
        let (x, y) = self.to_mm(col, row);
        self.ray(x, y)
    }
}

/// Intersect the ray C + t·d (ECEF) with the ellipsoid height `h` (Newton on t).
pub fn ray_at_height(c: [f64; 3], d: [f64; 3], h: f64) -> Result<Ground> {
    let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    let d = [d[0] / n, d[1] / n, d[2] / n];
    let (_, _, h0) = ecef_to_geodetic(c[0], c[1], c[2]);
    // First guess: straight down-range distance to the height.
    let mut t = (h0 - h).max(1.0);
    for _ in 0..40 {
        let p = [c[0] + t * d[0], c[1] + t * d[1], c[2] + t * d[2]];
        let (lat, lon, hp) = ecef_to_geodetic(p[0], p[1], p[2]);
        let dh = hp - h;
        // dh/dt ≈ the ray's component along the local up.
        let up = [lat.to_radians().cos() * lon.to_radians().cos(), lat.to_radians().cos() * lon.to_radians().sin(), lat.to_radians().sin()];
        let rate = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
        if rate.abs() < 1e-6 {
            return Err(Error::range("the ray runs parallel to the surface"));
        }
        let step = dh / rate;
        t -= step;
        if step.abs() < 1e-6 {
            if t <= 0.0 {
                return Err(Error::range("the ground lies behind the camera"));
            }
            return Ok(Ground { lat, lon, h });
        }
    }
    Err(Error::range("ray–height intersection did not converge"))
}

/// A frame camera: interior orientation plus one exterior orientation.
#[derive(Clone)]
pub struct FrameModel {
    pub cam: Camera,
    /// Perspective centre (geodetic) and attitude (degrees).
    pub centre: Ground,
    pub angles: [f64; 3],
    c_ecef: [f64; 3],
    enu: [[f64; 3]; 3],
    r: [[f64; 3]; 3],
    /// A priori covariance of the seven adjustable parameters (see `FRAME_PARAMS`), if known.
    pub cov: Option<Vec<f64>>,
    name: String,
}

/// The frame camera's adjustable parameters (REQ-GAP-19 interface): perspective-centre offsets
/// east, north, up (m); small rotations of the camera frame about its x, y, z axes (degrees); and
/// a focal-length correction (mm).
pub const FRAME_PARAMS: [&str; 7] = ["east offset (m)", "north offset (m)", "up offset (m)", "rotation about camera x (°)", "rotation about camera y (°)", "rotation about camera z (°)", "focal length (mm)"];

impl FrameModel {
    pub fn new(cam: Camera, centre: Ground, angles: [f64; 3], name: &str) -> Result<Self> {
        if cam.focal_mm <= 0.0 || cam.pixel_mm <= 0.0 {
            return Err(Error::invalid("frame: focal length and pixel size must be positive"));
        }
        Ok(FrameModel { cam, centre, angles, c_ecef: geodetic_to_ecef(centre.lat, centre.lon, centre.h), enu: enu_rotation(centre.lat, centre.lon), r: rotation(angles[0], angles[1], angles[2]), cov: None, name: name.to_string() })
    }
}

impl FrameModel {
    /// A frame camera with an explicit ENU → camera rotation.
    pub fn with_rotation(cam: Camera, centre: Ground, r: [[f64; 3]; 3], name: &str) -> Result<Self> {
        let mut m = FrameModel::new(cam, centre, [0.0; 3], name)?;
        m.r = r;
        Ok(m)
    }

    /// The ENU → camera rotation.
    pub fn rotation_matrix(&self) -> [[f64; 3]; 3] {
        self.r
    }

    /// A frame camera from gimbal angles in the local north-east-down frame (drone XMP, SENSRB
    /// Euler angles): yaw about down (from north, clockwise), then pitch about the new y (−90° looks
    /// straight down), then roll about the line of sight. The line of sight is the gimbal x axis,
    /// image right its y, image down its z (the KLV convention of `from_klv`).
    pub fn from_gimbal(cam: Camera, centre: Ground, yaw: f64, pitch: f64, roll: f64, name: &str) -> Result<Self> {
        Self::with_rotation(cam, centre, klv_rotation([yaw, pitch, roll], [0.0; 3]), name)
    }

    /// The motion-imagery frame model from KLV (REQ-SNS-20; `Research/12` §12.2): platform
    /// heading/pitch/roll (ST 0601 Items 5, 6/90, 7/91), sensor relative azimuth/elevation/roll
    /// (Items 18, 19, 20) and the horizontal FOV (Item 16) on a `width` × `height` frame. Square
    /// pixels: the focal length comes from the horizontal FOV (Item 17 is reported, not used).
    ///
    /// The sensor frame is the platform body frame (x nose, y right wing, z down) turned by the
    /// azimuth about z, the elevation about y and the roll about x; its x axis is the line of
    /// sight, y the image's right and z the image's down.
    #[allow(clippy::too_many_arguments)]
    pub fn from_klv(centre: Ground, platform_hpr: [f64; 3], sensor_aer: [f64; 3], hfov: f64, width: f64, height: f64, name: &str) -> Result<Self> {
        if !(hfov > 0.0 && hfov < 180.0) || width <= 0.0 || height <= 0.0 {
            return Err(Error::invalid("KLV frame: needs a field of view in (0°, 180°) and the frame size"));
        }
        let f_px = (width / 2.0) / (hfov.to_radians() / 2.0).tan();
        let cam = Camera { focal_mm: f_px * 0.001, pixel_mm: 0.001, cx: width / 2.0, cy: height / 2.0, width, height, ..Camera::default() };
        Self::with_rotation(cam, centre, klv_rotation(platform_hpr, sensor_aer), name)
    }
}

/// ENU → camera rotation for the KLV frame model (see `FrameModel::from_klv`).
pub fn klv_rotation(platform_hpr: [f64; 3], sensor_aer: [f64; 3]) -> [[f64; 3]; 3] {
    let rz = |a: f64| {
        let (s, c) = a.to_radians().sin_cos();
        [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
    };
    let ry = |a: f64| {
        let (s, c) = a.to_radians().sin_cos();
        [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
    };
    let rx = |a: f64| {
        let (s, c) = a.to_radians().sin_cos();
        [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
    };
    let [h, p, r] = platform_hpr;
    let [az, el, ro] = sensor_aer;
    // Columns: sensor axes (line of sight, image right, image down) in NED.
    let m = mul(&mul(&mul(&rz(h), &ry(p)), &mul(&rx(r), &rz(az))), &mul(&ry(el), &rx(ro)));
    let col = |j: usize| [m[1][j], m[0][j], -m[2][j]]; // NED → ENU
    let (los, right, down) = (col(0), col(1), col(2));
    [right, [-down[0], -down[1], -down[2]], [-los[0], -los[1], -los[2]]]
}

impl SensorModel for FrameModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn param_count(&self) -> usize {
        7
    }
    fn param_name(&self, i: usize) -> String {
        FRAME_PARAMS.get(i).map(|s| s.to_string()).unwrap_or_default()
    }
    fn param_covariance(&self) -> Option<Vec<f64>> {
        self.cov.clone()
    }
    fn param_step(&self, i: usize) -> f64 {
        match i {
            0..=2 => 1e-2,
            3..=5 => 1e-5,
            _ => 1e-4,
        }
    }
    fn with_params(&self, d: &[f64]) -> Result<Box<dyn SensorModel>> {
        if d.len() != 7 {
            return Err(Error::invalid("frame: seven parameter corrections expected"));
        }
        let (lat, lon, h) = gw_geodesy::wgs84::enu_to_geodetic(d[0], d[1], d[2], self.centre.lat, self.centre.lon, self.centre.h);
        let cam = Camera { focal_mm: self.cam.focal_mm + d[6], ..self.cam };
        let centre = Ground { lat, lon, h };
        // The rotation stays relative to ENU at the original centre (offsets are metres, small).
        let mut m = FrameModel::with_rotation(cam, centre, mul(&rotation(d[3], d[4], d[5]), &self.r), &self.name)?;
        m.enu = self.enu;
        m.angles = self.angles;
        m.cov = self.cov.clone();
        Ok(Box::new(m))
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let p = geodetic_to_ecef(g.lat, g.lon, g.h);
        let v_enu = mv(&self.enu, [p[0] - self.c_ecef[0], p[1] - self.c_ecef[1], p[2] - self.c_ecef[2]]);
        let v = mv(&self.r, v_enu);
        self.cam.project(v).ok_or_else(|| Error::range("the point is behind the camera"))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let d_enu = mtv(&self.r, self.cam.back_project(x, y));
        let d = mtv(&self.enu, d_enu);
        ray_at_height(self.c_ecef, d, h)
    }
    fn height_range(&self) -> (f64, f64) {
        (-500.0, self.centre.h - 1.0)
    }
}

/// A pushbroom (line scanner): row r is exposed at t = r·line_time; the centre is
/// origin-ENU p0 + v t + ½ a t² (metres) and the attitude (ω, φ, κ) + rate·t, relative to ENU at
/// the scene origin; the detector line is along image x at y_mm = 0.
pub struct PushbroomModel {
    pub cam: Camera,
    pub origin: Ground,
    pub p0: [f64; 3],
    pub v: [f64; 3],
    pub a: [f64; 3],
    pub angles: [f64; 3],
    pub rates: [f64; 3],
    pub line_time: f64,
    o_ecef: [f64; 3],
    enu: [[f64; 3]; 3],
    name: String,
}

impl PushbroomModel {
    #[allow(clippy::too_many_arguments)]
    pub fn new(cam: Camera, origin: Ground, p0: [f64; 3], v: [f64; 3], a: [f64; 3], angles: [f64; 3], rates: [f64; 3], line_time: f64, name: &str) -> Result<Self> {
        if line_time <= 0.0 {
            return Err(Error::invalid("pushbroom: the line time must be positive"));
        }
        Ok(PushbroomModel { cam, origin, p0, v, a, angles, rates, line_time, o_ecef: geodetic_to_ecef(origin.lat, origin.lon, origin.h), enu: enu_rotation(origin.lat, origin.lon), name: name.to_string() })
    }
    fn state(&self, t: f64) -> ([f64; 3], [[f64; 3]; 3]) {
        let c = [0, 1, 2].map(|i| self.p0[i] + self.v[i] * t + 0.5 * self.a[i] * t * t);
        let r = rotation(self.angles[0] + self.rates[0] * t, self.angles[1] + self.rates[1] * t, self.angles[2] + self.rates[2] * t);
        (c, r)
    }
    /// Camera-frame vector to a ground point (ENU at the origin) at time t.
    fn cam_vec(&self, g_enu: [f64; 3], t: f64) -> [f64; 3] {
        let (c, r) = self.state(t);
        mv(&r, [g_enu[0] - c[0], g_enu[1] - c[1], g_enu[2] - c[2]])
    }
}

impl SensorModel for PushbroomModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let p = geodetic_to_ecef(g.lat, g.lon, g.h);
        let ge = mv(&self.enu, [p[0] - self.o_ecef[0], p[1] - self.o_ecef[1], p[2] - self.o_ecef[2]]);
        let f = self.cam.focal_mm;
        // Find the line time at which the point lies in the detector plane (y_mm = 0).
        let ymm = |t: f64| {
            let v = self.cam_vec(ge, t);
            -f * v[1] / v[2]
        };
        // Start from the along-track position of the point.
        let speed2 = self.v.iter().map(|x| x * x).sum::<f64>().max(1e-9);
        let mut t = ((ge[0] - self.p0[0]) * self.v[0] + (ge[1] - self.p0[1]) * self.v[1] + (ge[2] - self.p0[2]) * self.v[2]) / speed2;
        for _ in 0..30 {
            let y0 = ymm(t);
            let dt = self.line_time.max(1e-6);
            let dy = (ymm(t + dt) - y0) / dt;
            if dy.abs() < 1e-15 {
                break;
            }
            let step = y0 / dy;
            t -= step;
            if step.abs() < 1e-10 * self.line_time.max(1e-6) {
                break;
            }
        }
        let v = self.cam_vec(ge, t);
        if v[2] >= 0.0 {
            return Err(Error::range("the point is behind the sensor"));
        }
        let (x, _) = self.cam.to_px(-f * v[0] / v[2], 0.0);
        Ok((x, t / self.line_time))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let t = y * self.line_time;
        let (c, r) = self.state(t);
        let (xm, _) = self.cam.to_mm(x, self.cam.cy);
        let d_enu = mtv(&r, [xm, 0.0, -self.cam.focal_mm]);
        let c_ecef = {
            let ce = mtv(&self.enu, c);
            [self.o_ecef[0] + ce[0], self.o_ecef[1] + ce[1], self.o_ecef[2] + ce[2]]
        };
        ray_at_height(c_ecef, mtv(&self.enu, d_enu), h)
    }
    fn height_range(&self) -> (f64, f64) {
        (-500.0, self.origin.h + self.p0[2] - 1.0)
    }
}

/// A frame camera from the flat parameter list the core and photo bundles share (REQ-GAP-23):
/// [orientation kind, focal mm, pixel mm, cx, cy, k1, k2, k3, p1, p2, a1, a2, width, height, lat,
/// lon, HAE, orientation…, covariance flag (+ 49 values)]. Orientation kinds: 0 = ω, φ, κ (°,
/// ENU → camera, see `rotation`); 1 = gimbal yaw, pitch, roll (°, NED, see `from_gimbal`);
/// 2 = the ENU → camera matrix (9, rows); 3 = the ECEF → camera matrix (9, rows); 4 = platform
/// heading, pitch, roll and sensor azimuth, elevation, roll (6, °, the KLV order of `klv_rotation`).
pub fn frame_from_params(a: &[f64], name: &str) -> Result<FrameModel> {
    let bad = || Error::invalid("frame: wrong number of parameters for its orientation kind");
    let code = *a.first().ok_or_else(bad)? as i32;
    // Kinds 8–12 are kinds 0–4 with two more camera values after the height: k4 and the
    // projection (0 pinhole, 1 equidistant fisheye) (REQ-GAP-22).
    let (kind, ext) = if (8..=12).contains(&code) { (code - 8, 2) } else { (code, 0) };
    let no = match kind {
        0 | 1 => 3,
        4 => 6,
        2 | 3 => 9,
        _ => return Err(Error::invalid("frame: unknown orientation kind")),
    };
    let base = 17 + ext;
    if a.len() < base + no + 1 {
        return Err(bad());
    }
    let (k4, fisheye) = if ext > 0 {
        if !(a[15] == 0.0 || a[15] == 1.0) {
            return Err(Error::invalid("frame: unknown projection"));
        }
        (a[14], a[15] == 1.0)
    } else {
        (0.0, false)
    };
    let cam = Camera { focal_mm: a[1], pixel_mm: a[2], cx: a[3], cy: a[4], k: [a[5], a[6], a[7]], p: [a[8], a[9]], aff: [a[10], a[11]], width: a[12], height: a[13], k4, fisheye };
    let centre = Ground { lat: a[14 + ext], lon: a[15 + ext], h: a[16 + ext] };
    let o = &a[base..base + no];
    let mut m = match kind {
        0 => FrameModel::new(cam, centre, [o[0], o[1], o[2]], name)?,
        1 => FrameModel::from_gimbal(cam, centre, o[0], o[1], o[2], name)?,
        2 => FrameModel::with_rotation(cam, centre, [[o[0], o[1], o[2]], [o[3], o[4], o[5]], [o[6], o[7], o[8]]], name)?,
        4 => FrameModel::with_rotation(cam, centre, klv_rotation([o[0], o[1], o[2]], [o[3], o[4], o[5]]), name)?,
        _ => {
            // ECEF → camera R_e; v_ecef = Eᵀ v_enu, so ENU → camera = R_e Eᵀ.
            let re = [[o[0], o[1], o[2]], [o[3], o[4], o[5]], [o[6], o[7], o[8]]];
            let e = enu_rotation(centre.lat, centre.lon);
            let et = [[e[0][0], e[1][0], e[2][0]], [e[0][1], e[1][1], e[2][1]], [e[0][2], e[1][2], e[2][2]]];
            FrameModel::with_rotation(cam, centre, mul(&re, &et), name)?
        }
    };
    let f = base + no;
    match a.len() - f {
        1 if a[f] == 0.0 => {}
        50 if a[f] != 0.0 => m.cov = Some(a[f + 1..].to_vec()),
        _ => return Err(bad()),
    }
    // A rotation matrix must be orthonormal.
    let r = m.r;
    for i in 0..3 {
        for j in 0..3 {
            let d: f64 = (0..3).map(|k| r[i][k] * r[j][k]).sum();
            if (d - if i == j { 1.0 } else { 0.0 }).abs() > 1e-6 {
                return Err(Error::invalid("frame: the orientation matrix is not a rotation"));
            }
        }
    }
    Ok(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cam() -> Camera {
        Camera { focal_mm: 8.8, pixel_mm: 0.0024, cx: 2736.0, cy: 1824.0, width: 5472.0, height: 3648.0, ..Camera::default() }
    }

    #[test]
    fn gimbal_nadir_matches_opk_heading() {
        // Gimbal pitch −90° with yaw ψ: nadir, image top towards ψ. With ψ = 0 the image is north-up
        // and east-right: the ω, φ, κ = 0 camera.
        let c = Ground { lat: 41.3, lon: -81.75, h: 400.0 };
        let g = FrameModel::from_gimbal(cam(), c, 0.0, -90.0, 0.0, "g").unwrap();
        let o = FrameModel::new(cam(), c, [0.0, 0.0, 0.0], "o").unwrap();
        for (x, y) in [(100.0, 200.0), (2736.0, 1824.0), (5000.0, 3500.0)] {
            let a = g.image_to_ground(x, y, 300.0).unwrap();
            let b = o.image_to_ground(x, y, 300.0).unwrap();
            assert!((a.lat - b.lat).abs() < 1e-9 && (a.lon - b.lon).abs() < 1e-9);
        }
        // Yaw 90° (heading east): the image top points east, so a point up the image is east.
        let e = FrameModel::from_gimbal(cam(), c, 90.0, -90.0, 0.0, "e").unwrap();
        let top = e.image_to_ground(2736.0, 100.0, 300.0).unwrap();
        let mid = e.image_to_ground(2736.0, 1824.0, 300.0).unwrap();
        assert!(top.lon > mid.lon + 1e-5 && (top.lat - mid.lat).abs() < 1e-6);
        // Pitch −60° tilts the view forward (north for yaw 0): the centre lands north of nadir by
        // H·tan 30°.
        let t = FrameModel::from_gimbal(cam(), c, 0.0, -60.0, 0.0, "t").unwrap();
        let p = t.image_to_ground(2736.0, 1824.0, 300.0).unwrap();
        let d = gw_geodesy::geodesic::inverse(c.lat, c.lon, p.lat, p.lon).0;
        assert!((d - 100.0 * 30f64.to_radians().tan()).abs() < 0.05 && p.lat > c.lat, "{d}");
    }

    #[test]
    fn params_decode_every_orientation_kind() {
        let c = Ground { lat: 41.3, lon: -81.75, h: 400.0 };
        let o = FrameModel::new(cam(), c, [2.0, -3.0, 40.0], "o").unwrap();
        let r = o.rotation_matrix();
        let head = |k: f64| vec![k, 8.8, 0.0024, 2736.0, 1824.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5472.0, 3648.0, 41.3, -81.75, 400.0];
        let mut a = head(0.0);
        a.extend_from_slice(&[2.0, -3.0, 40.0, 0.0]);
        let mut b = head(2.0);
        b.extend(r.iter().flatten());
        b.push(0.0);
        // ECEF → camera = R_enu · E.
        let e = enu_rotation(c.lat, c.lon);
        let re = mul(&r, &e);
        let mut d = head(3.0);
        d.extend(re.iter().flatten());
        d.push(0.0);
        let g = Ground { lat: 41.3004, lon: -81.7493, h: 310.0 };
        let want = o.ground_to_image(g).unwrap();
        for p in [a, b, d] {
            let m = frame_from_params(&p, "x").unwrap();
            let got = m.ground_to_image(g).unwrap();
            assert!((got.0 - want.0).abs() < 1e-6 && (got.1 - want.1).abs() < 1e-6, "{got:?} {want:?}");
        }
        let mut bad = head(2.0);
        bad.extend_from_slice(&[1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        assert!(frame_from_params(&bad, "x").is_err());
    }

    #[test]
    fn affinity_round_trips() {
        let c = Ground { lat: 41.3, lon: -81.75, h: 400.0 };
        let m = FrameModel::new(Camera { aff: [1e-3, -2e-4], k: [1e-3, 0.0, 0.0], ..cam() }, c, [1.0, 2.0, 3.0], "a").unwrap();
        for (x, y) in [(10.0, 20.0), (5400.0, 3600.0)] {
            let g = m.image_to_ground(x, y, 250.0).unwrap();
            let (x2, y2) = m.ground_to_image(g).unwrap();
            assert!((x2 - x).hypot(y2 - y) < 1e-6);
        }
    }
}
