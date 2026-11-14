//! Cross-check of the sidecar's bundle adjuster (ba.rs) against the app's (crates/gw-aero): the
//! sidecar does not depend on crates/, so the two share a fixture instead. Both solve the block in
//! tests/fixtures/ba-cross-check/block.json (made by make.mjs there) and must land on the same
//! weighted least-squares optimum, expected.json, within the tolerances it states. A change to the
//! maths of either (the projection, the lens, a weight, the priors) moves its solution off it.
//!
//! The block is in ba.rs's own terms, so this side reads it as it is: poses, points, one shared
//! SIMPLE_RADIAL lens with the focal length tied to its start by a sigma, k1 free and the principal
//! point held, image observations weighted by their sigma in pixels and control by its sigma in
//! metres, with no robust loss. `BA_CROSS_CHECK_WRITE=<path>` writes this side's solution.

use gwb_sfm::ba::{adjust, Calib, Obs, Pose, Prior, Problem};
use gwb_sfm::colmap::Camera;
use gwb_sfm::geo::{norm, sub, M3, V3};
use serde_json::Value;
use std::path::PathBuf;

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

fn problem(b: &Value) -> Problem {
    let lens = &b["lens"];
    assert_eq!(lens["model"], "SIMPLE_RADIAL");
    let start: Vec<f64> = list(&lens["start"]).iter().map(num).collect();
    let intr = Camera { model: 2, width: lens["width"].as_u64().unwrap(), height: lens["height"].as_u64().unwrap(), params: start.clone() };
    Problem {
        cams: list(&b["cameras"]).iter().map(|c| Pose { r: m3(&c["r"]), c: v3(&c["c"]), intr: intr.clone() }).collect(),
        pts: list(&b["points"]).iter().map(v3).collect(),
        obs: list(&b["observations"])
            .iter()
            .map(|o| Obs { cam: o["cam"].as_u64().unwrap() as usize, pt: o["pt"].as_u64().unwrap() as usize, xy: [num(&o["xy"][0]), num(&o["xy"][1])], sigma: num(&o["sigma"]), robust: false })
            .collect(),
        priors: list(&b["gcps"]).iter().map(|g| Prior { pt: g["pt"].as_u64().unwrap() as usize, at: v3(&g["at"]), sigma: num(&g["sigma"]) }).collect(),
        // [f, cx, cy, k1]: f under its prior, the principal point held, k1 free.
        calib: Some(Calib { sigma: vec![num(&lens["focal_sigma"]), 0.0, 0.0, f64::INFINITY], start }),
    }
}

#[test]
fn ba_reaches_the_optimum_gw_aero_reaches() {
    let mut pr = problem(&fixture("block.json"));
    let stats = adjust(&mut pr, 200);
    let lens = &pr.cams[0].intr.params;
    let (focal, k1) = (lens[0], lens[3]);
    let centres: Vec<V3> = pr.cams.iter().map(|c| c.c).collect();

    if let Ok(out) = std::env::var("BA_CROSS_CHECK_WRITE") {
        let json = serde_json::json!({ "source": "ba.rs", "focal": focal, "k1": k1, "centres": centres, "points": pr.pts });
        std::fs::write(&out, serde_json::to_string_pretty(&json).unwrap()).unwrap();
    }

    let expected = fixture("expected.json");
    let worst = |got: &[V3], want: &Value| -> f64 {
        let want = list(want);
        assert_eq!(got.len(), want.len());
        got.iter().zip(want).map(|(g, w)| norm(sub(*g, v3(w)))).fold(0.0, f64::max)
    };
    let tol = &expected["tolerance"];
    let d_pt = worst(&pr.pts, &expected["points"]);
    let d_c = worst(&centres, &expected["centres"]);
    let d_f = (focal - num(&expected["focal"])).abs();
    let d_k = ((k1 - num(&expected["k1"])) / num(&expected["k1"])).abs();
    let summary = format!(
        "ba.rs vs expected ({}): points {d_pt:.2e} m, centres {d_c:.2e} m, focal {d_f:.2e} px, k1 {d_k:.2e} relative; f {focal}, k1 {k1}; {stats:?}",
        expected["source"].as_str().unwrap_or("?")
    );
    println!("{summary}");
    assert!(stats.cost_after < stats.cost_before, "{summary}");
    assert!(d_pt <= num(&tol["point_m"]), "points off: {summary}");
    assert!(d_c <= num(&tol["centre_m"]), "camera centres off: {summary}");
    assert!(d_f <= num(&tol["focal_px"]), "focal length off: {summary}");
    assert!(d_k <= num(&tol["k1_relative"]), "k1 off: {summary}");
}
