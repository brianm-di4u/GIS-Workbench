//! Cross-check of the app's bundle adjuster (gw-aero) against the sidecar's (sidecar/gwb-sfm,
//! ba.rs): the sidecar does not depend on crates/, so the two share a fixture instead. Both solve
//! the block in tests/fixtures/ba-cross-check/block.json (made by make.mjs there) and must land on
//! the same weighted least-squares optimum, expected.json, within the tolerances it states. A
//! change to the maths of either (the projection, the lens, a weight, the priors) moves its
//! solution off it.
//!
//! The block is in ba.rs's terms, so this side converts it, exactly:
//! - the local frame is ENU at `geodetic_origin`; positions go to geodetic coordinates and back
//!   through gw-geodesy, and gw-aero's own local frame (ENU at the block centre) differs from it by
//!   a rigid motion, which leaves the cost unchanged (the control sigma is the same on every axis);
//! - COLMAP's camera (x right, y down, z forward) is gw-aero's (x right, y up, looking along -z)
//!   turned by diag(1, -1, -1);
//! - the SIMPLE_RADIAL lens [f, cx, cy, k1] (pixels, k1 on the normalised r²) is Brown with
//!   f_mm = f · pixel, x0 = y0 = 0 (cx, cy are the format centre and held on both sides) and
//!   k1_mm = k1 / f_mm², a reparameterisation of the same model (k1 has no prior on either side);
//! - the focal prior σ goes from pixels to mm; control σ on all three axes; no robust weighting.
//!
//! gw-aero intersects its own starting points from the starting poses, so the block's starting
//! points are not used here. `BA_CROSS_CHECK_WRITE=<path>` writes this side's solution, the form
//! expected.json takes (with its tolerances added by hand).

use gw_adjust::block::{ObsIn, PointIn, PointKind};
use gw_aero::aero::*;
use gw_aero::geom::*;
use gw_geodesy::wgs84::{enu_rotation, enu_to_geodetic, geodetic_to_enu};
use gw_sensor::Ground;
use serde_json::Value;
use std::path::PathBuf;

/// Any pixel size gives the same solution; this one is a typical small-format sensor's.
const PIXEL_MM: f64 = 0.004;
/// COLMAP camera frame → gw-aero camera frame.
const FLIP: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/ba-cross-check").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn num(v: &Value) -> f64 {
    v.as_f64().expect("a number")
}
fn v3(v: &Value) -> V3 {
    [num(&v[0]), num(&v[1]), num(&v[2])]
}
fn m3(v: &Value) -> M3 {
    [v3(&v[0]), v3(&v[1]), v3(&v[2])]
}
fn list(v: &Value) -> &Vec<Value> {
    v.as_array().expect("an array")
}

struct Frame {
    lat: f64,
    lon: f64,
    h: f64,
}

impl Frame {
    fn ground(&self, p: V3) -> Ground {
        let (lat, lon, h) = enu_to_geodetic(p[0], p[1], p[2], self.lat, self.lon, self.h);
        Ground { lat, lon, h }
    }
    fn local(&self, g: Ground) -> V3 {
        geodetic_to_enu(g.lat, g.lon, g.h, self.lat, self.lon, self.h)
    }
}

#[test]
fn gw_aero_reaches_the_optimum_ba_reaches() {
    let b = fixture("block.json");
    let o = &b["geodetic_origin"];
    let frame = Frame { lat: num(&o["lat"]), lon: num(&o["lon"]), h: num(&o["h"]) };
    let lens = &b["lens"];
    assert_eq!(lens["model"], "SIMPLE_RADIAL");
    let (width, height) = (num(&lens["width"]), num(&lens["height"]));
    let [f, cx, cy, k1] = [0, 1, 2, 3].map(|k| num(&lens["start"][k]));
    assert!(cx == width / 2.0 && cy == height / 2.0, "the principal point must be the format centre (x0 = y0 = 0)");

    let f_mm = f * PIXEL_MM;
    let mut io = [0.0; NIO];
    io[0] = f_mm;
    io[3] = k1 / (f_mm * f_mm);
    let mut io_free = [false; NIO];
    io_free[0] = true;
    io_free[3] = true;
    let mut io_sigma = [0.0; NIO];
    io_sigma[0] = num(&lens["focal_sigma"]) * PIXEL_MM;
    let cam = CameraIn { projection: Projection::Brown, film: false, pixel_mm: PIXEL_MM, width, height, io, io_free, io_sigma, mount: [0.0; 6], mount_free: [false; 6], mount_sigma: [0.0; 6] };

    let e0 = enu_rotation(frame.lat, frame.lon);
    let images: Vec<ImageIn> = list(&b["cameras"])
        .iter()
        .map(|c| {
            let g = frame.ground(v3(&c["c"]));
            // local → camera, into ENU-at-the-camera → camera: R · E0 · E_gᵀ.
            let r_enu = mul(&mul(&mul(&FLIP, &m3(&c["r"])), &e0), &tr(&enu_rotation(g.lat, g.lon)));
            ImageIn { camera: 0, fixed: false, approx: Some((g, r_enu)), attitude_known: true, gnss: None, imu: None, film: None }
        })
        .collect();
    let mut points: Vec<PointIn> = list(&b["points"]).iter().map(|_| PointIn { kind: PointKind::Tie, known: None, sigma_h: 0.0, sigma_v: 0.0 }).collect();
    for g in list(&b["gcps"]) {
        let s = num(&g["sigma"]);
        points[g["pt"].as_u64().unwrap() as usize] = PointIn { kind: PointKind::Gcp, known: Some(frame.ground(v3(&g["at"]))), sigma_h: s, sigma_v: s };
    }
    let obs: Vec<ObsIn> = list(&b["observations"])
        .iter()
        .map(|o| ObsIn { image: o["cam"].as_u64().unwrap() as usize, point: o["pt"].as_u64().unwrap() as usize, x: num(&o["xy"][0]), y: num(&o["xy"][1]), sigma_px: num(&o["sigma"]) })
        .collect();
    let n_pts = points.len();
    let opts = AeroOptions { max_iterations: 200, robust: Robust::None, max_reject: 0, ..AeroOptions::default() };
    let mut a = Aero::new(vec![cam], images, points, obs, opts).expect("the block is accepted");
    a.run().expect("the block solves");
    let report = a.report().expect("the report");
    assert!(report.converged && a.notes.is_empty(), "nothing left out, converged: {:?}", a.notes);

    let io = a.io(0);
    let focal = io[0] / PIXEL_MM;
    let k1 = io[3] * io[0] * io[0];
    let centres: Vec<V3> = (0..a.images.len()).map(|i| frame.local(a.geodetic(a.eo(i).0))).collect();
    let pts: Vec<V3> = (0..n_pts).map(|j| frame.local(a.geodetic(a.point(j).expect("every point solved")))).collect();

    if let Ok(out) = std::env::var("BA_CROSS_CHECK_WRITE") {
        let json = serde_json::json!({ "source": "gw-aero", "focal": focal, "k1": k1, "centres": centres, "points": pts });
        std::fs::write(&out, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    }

    let expected = fixture("expected.json");
    let worst = |got: &[V3], want: &Value| -> f64 {
        let want = list(want);
        assert_eq!(got.len(), want.len());
        got.iter().zip(want).map(|(g, w)| norm(sub(*g, v3(w)))).fold(0.0, f64::max)
    };
    let tol = &expected["tolerance"];
    let d_pt = worst(&pts, &expected["points"]);
    let d_c = worst(&centres, &expected["centres"]);
    let d_f = (focal - num(&expected["focal"])).abs();
    let d_k = ((k1 - num(&expected["k1"])) / num(&expected["k1"])).abs();
    let summary = format!(
        "gw-aero vs expected ({}): points {d_pt:.2e} m, centres {d_c:.2e} m, focal {d_f:.2e} px, k1 {d_k:.2e} relative; f {focal}, k1 {k1}; sigma0 {}, {} iterations",
        expected["source"].as_str().unwrap_or("?"),
        report.sigma0,
        report.iterations
    );
    println!("{summary}");
    assert!(d_pt <= num(&tol["point_m"]), "points off: {summary}");
    assert!(d_c <= num(&tol["centre_m"]), "camera centres off: {summary}");
    assert!(d_f <= num(&tol["focal_px"]), "focal length off: {summary}");
    assert!(d_k <= num(&tol["k1_relative"]), "k1 off: {summary}");
}
