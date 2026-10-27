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
    pub width: f64,
    pub height: f64,
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
        let rad = 1.0 + self.k[0] * r2 + self.k[1] * r2 * r2 + self.k[2] * r2 * r2 * r2;
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
        self.undistort((col - self.cx) * self.pixel_mm, -(row - self.cy) * self.pixel_mm)
    }
    /// Ideal image mm → pixel.
    fn to_px(&self, x: f64, y: f64) -> (f64, f64) {
        let (xd, yd) = self.distort(x, y);
        (self.cx + xd / self.pixel_mm, self.cy - yd / self.pixel_mm)
    }
}

/// Intersect the ray C + t·d (ECEF) with the ellipsoid height `h` (Newton on t).
fn ray_at_height(c: [f64; 3], d: [f64; 3], h: f64) -> Result<Ground> {
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
pub struct FrameModel {
    pub cam: Camera,
    /// Perspective centre (geodetic) and attitude (degrees).
    pub centre: Ground,
    pub angles: [f64; 3],
    c_ecef: [f64; 3],
    enu: [[f64; 3]; 3],
    r: [[f64; 3]; 3],
    name: String,
}

impl FrameModel {
    pub fn new(cam: Camera, centre: Ground, angles: [f64; 3], name: &str) -> Result<Self> {
        if cam.focal_mm <= 0.0 || cam.pixel_mm <= 0.0 {
            return Err(Error::invalid("frame: focal length and pixel size must be positive"));
        }
        Ok(FrameModel { cam, centre, angles, c_ecef: geodetic_to_ecef(centre.lat, centre.lon, centre.h), enu: enu_rotation(centre.lat, centre.lon), r: rotation(angles[0], angles[1], angles[2]), name: name.to_string() })
    }
}

impl FrameModel {
    /// A frame camera with an explicit ENU → camera rotation.
    pub fn with_rotation(cam: Camera, centre: Ground, r: [[f64; 3]; 3], name: &str) -> Result<Self> {
        let mut m = FrameModel::new(cam, centre, [0.0; 3], name)?;
        m.r = r;
        Ok(m)
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
        let cam = Camera { focal_mm: f_px * 0.001, pixel_mm: 0.001, cx: width / 2.0, cy: height / 2.0, k: [0.0; 3], p: [0.0; 2], width, height };
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
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let p = geodetic_to_ecef(g.lat, g.lon, g.h);
        let v_enu = mv(&self.enu, [p[0] - self.c_ecef[0], p[1] - self.c_ecef[1], p[2] - self.c_ecef[2]]);
        let v = mv(&self.r, v_enu);
        if v[2] >= 0.0 {
            return Err(Error::range("the point is behind the camera"));
        }
        let f = self.cam.focal_mm;
        Ok(self.cam.to_px(-f * v[0] / v[2], -f * v[1] / v[2]))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (xm, ym) = self.cam.to_mm(x, y);
        let d_enu = mtv(&self.r, [xm, ym, -self.cam.focal_mm]);
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
