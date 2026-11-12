//! REQ-GAP-22 differential against OpenCV (gw-te env, OpenCV 5.0): tests/tools/aero_oracle.py
//! makes a synthetic calibration (a 3-D field in 12 convergent views, Brown lens; a planar board
//! in 14 views, equidistant fisheye lens), solves it with cv2.calibrateCamera,
//! cv2.fisheye.calibrate and cv2.solvePnP, and writes the measurements and OpenCV's solution to
//! E:/gwb25/data-aero/oracle. Here the same measurements go through the bundle adjustment (every
//! target point a GCP held at 1 µm, the views without an approximation: resected from the
//! target, then adjusted with self-calibration), and the two solutions are compared. Skips when
//! the files are absent.

use gw_aero::aero::*;
use gw_adjust::block::{ObsIn, PointIn, PointKind};
use gw_aero::geom::*;
use gw_geodesy::wgs84::{enu_rotation, enu_to_geodetic, geodetic_to_enu};
use gw_sensor::Ground;
use serde_json::Value;

const DIR: &str = "E:/gwb25/data-aero/oracle";
const LAT0: f64 = 41.0;
const LON0: f64 = -83.0;
const H0: f64 = 100.0;
const PIX: f64 = 0.001;
const FLIP: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];

fn m3(v: &Value) -> M3 {
    let r: Vec<Vec<f64>> = serde_json::from_value(v.clone()).unwrap();
    [[r[0][0], r[0][1], r[0][2]], [r[1][0], r[1][1], r[1][2]], [r[2][0], r[2][1], r[2][2]]]
}
fn v3(v: &Value) -> V3 {
    let r: Vec<f64> = serde_json::from_value(v.clone()).unwrap();
    [r[0], r[1], r[2]]
}

/// OpenCV K + distortion → our IO (pixel 1 µm), as tests/tools/aero_oracle.py from_cv.
fn io_of(k: &M3, d: &[f64], w: f64, h: f64, fisheye: bool) -> [f64; NIO] {
    let (fx, fy, cx, cy) = (k[0][0], k[1][1], k[0][2], k[1][2]);
    let f = fy * PIX;
    let mut io = [0.0; NIO];
    io[0] = f;
    io[1] = (cx + 0.5 - w / 2.0) * PIX;
    io[2] = -(cy + 0.5 - h / 2.0) * PIX;
    io[9] = fx / fy - 1.0;
    if fisheye {
        io[3..7].copy_from_slice(&d[..4]);
    } else {
        io[3] = d[0] / f.powi(2);
        io[4] = d[1] / f.powi(4);
        io[5] = d[4] / f.powi(6);
        io[7] = d[3] / f;
        io[8] = -d[2] / f;
    }
    io
}

/// The world frame of the scene is ENU at (LAT0, LON0, H0).
fn geo(p: V3) -> Ground {
    let (lat, lon, h) = enu_to_geodetic(p[0], p[1], p[2], LAT0, LON0, H0);
    Ground { lat, lon, h }
}

struct Case {
    io_cv: [f64; NIO],
    io_truth: [f64; NIO],
    rms_cv: f64,
    views_cv: Vec<(V3, M3)>,
    a: Aero,
    r: Report,
}

fn solve_case(file: &str, fisheye: bool) -> Option<Case> {
    let text = std::fs::read_to_string(format!("{DIR}/{file}")).ok()?;
    let v: Value = serde_json::from_str(&text).unwrap();
    let (w, h) = (v["width"].as_f64().unwrap(), v["height"].as_f64().unwrap());
    let kc = m3(&v["opencv"]["K"]);
    let dc: Vec<f64> = serde_json::from_value(v["opencv"]["dist"].clone()).unwrap();
    let kt = m3(&v["truth"]["K"]);
    let dt: Vec<f64> = serde_json::from_value(v["truth"]["dist"].clone()).unwrap();
    // Points: unique by coordinates across the views.
    let mut pts: Vec<V3> = Vec::new();
    let mut obs = Vec::new();
    let views = v["views"].as_array().unwrap();
    for (i, vw) in views.iter().enumerate() {
        let o: Vec<Vec<f64>> = serde_json::from_value(vw["obj"].clone()).unwrap();
        let uv: Vec<Vec<f64>> = serde_json::from_value(vw["uv"].clone()).unwrap();
        for (p, q) in o.iter().zip(&uv) {
            let p = [p[0], p[1], p[2]];
            let j = match pts.iter().position(|x| norm(sub(*x, p)) < 1e-6) {
                Some(j) => j,
                None => {
                    pts.push(p);
                    pts.len() - 1
                }
            };
            obs.push(ObsIn { image: i, point: j, x: q[0] + 0.5, y: q[1] + 0.5, sigma_px: 0.3 });
        }
    }
    let points: Vec<PointIn> = pts.iter().map(|p| PointIn { kind: PointKind::Gcp, known: Some(geo(*p)), sigma_h: 1e-6, sigma_v: 1e-6 }).collect();
    let mut io0 = [0.0; NIO];
    io0[0] = if fisheye { 600.0 } else { 2300.0 } * PIX;
    let mut cam = CameraIn { projection: if fisheye { Projection::Fisheye } else { Projection::Brown }, film: false, pixel_mm: PIX, width: w, height: h, io: io0, io_free: [false; NIO], io_sigma: [0.0; NIO], mount: [0.0; 6], mount_free: [false; 6], mount_sigma: [0.0; 6] };
    let free: &[usize] = if fisheye { &[0, 1, 2, 3, 4, 5, 6, 9] } else { &[0, 1, 2, 3, 4, 5, 7, 8, 9] };
    for &q in free {
        cam.io_free[q] = true;
    }
    let images = (0..views.len()).map(|_| ImageIn { camera: 0, fixed: false, approx: None, attitude_known: false, gnss: None, imu: None, film: None }).collect();
    let mut a = Aero::new(vec![cam], images, points, obs, AeroOptions { max_iterations: 100, ..AeroOptions::default() }).unwrap();
    a.run().unwrap();
    let r = a.report().unwrap();
    let views_cv = v["opencv"]["views"].as_array().unwrap().iter().map(|x| {
        let rc = m3(&x["R"]);
        let t = v3(&x["t"]);
        (scale(mtv(&rc, t), -1.0), mul(&FLIP, &rc))
    }).collect();
    Some(Case { io_cv: io_of(&kc, &dc, w, h, fisheye), io_truth: io_of(&kt, &dt, w, h, fisheye), rms_cv: v["opencv"]["rms"].as_f64().unwrap(), views_cv, a, r })
}

/// Our view i in the scene frame: centre and scene → camera rotation.
fn view(c: &Case, i: usize) -> (V3, M3) {
    let im = &c.r.images[i];
    let e0 = enu_rotation(LAT0, LON0);
    (geodetic_to_enu(im.centre.lat, im.centre.lon, im.centre.h, LAT0, LON0, H0), mul(&im.r_ecef, &tr(&e0)))
}

fn compare(c: &Case, what: &str, free: &[usize]) {
    // Reprojection RMS: OpenCV's is √(Σ(dx² + dy²)/N); ours per axis.
    let ours_rms = c.r.rms_px * 2f64.sqrt();
    eprintln!("{what}: reprojection RMS ours {ours_rms:.6} px, OpenCV {:.6} px; σ₀ {:.4}", c.rms_cv, c.r.sigma0);
    assert!((ours_rms - c.rms_cv).abs() < 1e-4 * c.rms_cv.max(1e-3) + 1e-6, "{ours_rms} vs {}", c.rms_cv);
    let io = c.a.io(0);
    for &q in free {
        let s = c.r.cameras[0].sigma[q];
        let dz = (io[q] - c.io_cv[q]) / s;
        eprintln!("  {:>3}: ours {:+.9e} OpenCV {:+.9e} truth {:+.6e} (Δ {:+.2e} σ)", IO_NAMES[q], io[q], c.io_cv[q], c.io_truth[q], dz);
        assert!(dz.abs() < 1e-2, "{} differs from OpenCV by {dz} σ", IO_NAMES[q]);
    }
    let mut worst = (0.0_f64, 0.0_f64);
    for i in 0..c.views_cv.len() {
        let (cc, rc) = view(c, i);
        worst.0 = worst.0.max(norm(sub(cc, c.views_cv[i].0)));
        worst.1 = worst.1.max(norm(logm(&mul(&rc, &tr(&c.views_cv[i].1)))).to_degrees());
    }
    eprintln!("  views: centres within {:.3e} m, attitudes within {:.3e}° of OpenCV's", worst.0, worst.1);
    assert!(worst.0 < 1e-4 && worst.1 < 1e-4, "{worst:?}");
}

#[test]
fn opencv_calibrate_camera_brown() {
    let Some(c) = solve_case("synthetic-brown.json", false) else { return eprintln!("skipped: no OpenCV oracle file") };
    compare(&c, "calibrateCamera (Brown, 3-D field, 12 views)", &[0, 1, 2, 3, 4, 5, 7, 8, 9]);
}

#[test]
fn opencv_fisheye_calibrate() {
    let Some(c) = solve_case("synthetic-fisheye.json", true) else { return eprintln!("skipped: no OpenCV oracle file") };
    compare(&c, "fisheye.calibrate (equidistant, board, 14 views)", &[0, 1, 2, 3, 4, 5, 6, 9]);
}

#[test]
fn opencv_solve_pnp() {
    let Ok(text) = std::fs::read_to_string(format!("{DIR}/synthetic-brown.json")) else { return eprintln!("skipped: no OpenCV oracle file") };
    let v: Value = serde_json::from_str(&text).unwrap();
    let (w, h) = (v["width"].as_f64().unwrap(), v["height"].as_f64().unwrap());
    let kt = m3(&v["truth"]["K"]);
    let dt: Vec<f64> = serde_json::from_value(v["truth"]["dist"].clone()).unwrap();
    let k = v["pnp"]["view"].as_u64().unwrap() as usize;
    let vw = &v["views"][k];
    let o: Vec<Vec<f64>> = serde_json::from_value(vw["obj"].clone()).unwrap();
    let uv: Vec<Vec<f64>> = serde_json::from_value(vw["uv"].clone()).unwrap();
    let io = io_of(&kt, &dt, w, h, false);
    let cam = CameraIn { projection: Projection::Brown, film: false, pixel_mm: PIX, width: w, height: h, io, io_free: [false; NIO], io_sigma: [0.0; NIO], mount: [0.0; 6], mount_free: [false; 6], mount_sigma: [0.0; 6] };
    let pts: Vec<V3> = o.iter().map(|p| [p[0], p[1], p[2]]).collect();
    let px: Vec<(f64, f64)> = uv.iter().map(|q| (q[0] + 0.5, q[1] + 0.5)).collect();
    let r = gw_aero::resect::resect(&cam, &io, None, &pts, &px, &vec![0.3; pts.len()], None, false).unwrap();
    let rc = m3(&v["pnp"]["R"]);
    let t = v3(&v["pnp"]["t"]);
    let (c_cv, r_cv) = (scale(mtv(&rc, t), -1.0), mul(&FLIP, &rc));
    let dc = norm(sub(r.c, c_cv));
    let da = norm(logm(&mul(&r.r, &tr(&r_cv)))).to_degrees();
    eprintln!("solvePnP (view {k}, {} points, {}): centre within {dc:.3e} m, attitude within {da:.3e}°", pts.len(), r.method);
    assert!(dc < 1e-5 && da < 1e-4, "{dc} m {da}°");
}
