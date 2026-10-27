//! FX-04 block (SCN-06, SCN-07): four images whose RPC00B carry known image-space biases, six
//! GCPs and three checkpoints observed at their true image positions with 0.3 px noise, plus
//! tie points on the FX-05 terrain. AT-06.1 (checkpoint RMSE > 10 m before, ≤ 1.5 GSD after),
//! AT-06.2 (a planted blunder is flagged and removing it lowers σ₀), AT-07.1 (multi-image point
//! ≤ 1 GSD horizontal, ≤ 1.5 GSD vertical with three adjusted images), RPC refit (REQ-SNS-15/16).

use gw_adjust::block::{adjust, ImageIn, ObsIn, Options, PointIn, PointKind};
use gw_adjust::rpcfit::{fit_rpc, FitSpec};
use gw_sensor::adjusted::{Adjusted, BiasKind};
use gw_sensor::intersect::{intersect, Observation};
use gw_sensor::rpc::Rpc;
use gw_sensor::{Ground, SensorModel};
use serde_json::Value;
use std::path::PathBuf;
use std::rc::Rc;

const GSD: f64 = 0.5;

fn truth() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx04/fx04_truth.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("fx04 truth (node build/fixtures/fx04.mjs)")).unwrap()
}

/// FX-05 terrain (build/fixtures/site.mjs).
fn terrain(lat: f64, lon: f64) -> f64 {
    let (lat0, lon0) = (34.5, -116.5);
    let x = (lon - lon0) * 111320.0 * (lat0 as f64).to_radians().cos();
    let y = (lat - lat0) * 110940.0;
    let a = 25f64.to_radians();
    let u = x * a.cos() + y * a.sin();
    let v = -x * a.sin() + y * a.cos();
    let mut h = 650.0 + 0.01 * x + 60.0 * (-((u - 300.0) / 150.0).powi(2)).exp() - 30.0 * (-((v + 400.0) / 120.0).powi(2)).exp();
    let r = (x + 300.0).hypot(y - 300.0);
    if r <= 150.0 {
        h = 640.0;
    } else if r < 250.0 {
        let t = (r - 150.0) / 100.0;
        let s = t * t * (3.0 - 2.0 * t);
        h = 640.0 * (1.0 - s) + h * s;
    }
    h
}

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
    fn gauss(&mut self) -> f64 {
        (-2.0 * (self.next() + 1e-12).ln()).sqrt() * (2.0 * std::f64::consts::PI * self.next()).cos()
    }
}

fn rpc_from(v: &Value, bias: Option<(f64, f64)>) -> Rpc {
    let mut rec: Vec<f64> = v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect();
    if let Some((bl, bs)) = bias {
        rec[2] += bl;
        rec[3] += bs;
    }
    rec.extend_from_slice(&[0.0; 6]);
    Rpc::from_record(&rec).unwrap()
}

struct Block {
    images: Vec<ImageIn>,
    truths: Vec<Rpc>,
    points: Vec<PointIn>,
    obs: Vec<ObsIn>,
    check_ids: Vec<usize>,
    biases: Vec<(f64, f64)>,
}

fn block(kind: BiasKind) -> Block {
    let t = truth();
    let mut rng = Lcg(0xf04);
    let mut images = Vec::new();
    let mut truths = Vec::new();
    let mut biases = Vec::new();
    for im in t["images"].as_array().unwrap() {
        let b = (im["biasPx"]["line"].as_f64().unwrap(), im["biasPx"]["sample"].as_f64().unwrap());
        biases.push(b);
        truths.push(rpc_from(&im["rpcTrue"], None));
        images.push(ImageIn { model: Rc::new(rpc_from(&im["rpcTrue"], Some(b))), kind, fixed: false, centre: (1024.0, 1024.0), half: (1024.0, 1024.0), prior_sigma_px: 0.0 });
    }
    let mut points = Vec::new();
    let mut obs = Vec::new();
    let mut check_ids = Vec::new();
    // Control points at their true image positions (+0.3 px noise).
    let ctrl = t["control"].as_array().unwrap();
    for c in ctrl {
        let g = Ground { lat: c["lat"].as_f64().unwrap(), lon: c["lon"].as_f64().unwrap(), h: c["hae"].as_f64().unwrap() };
        let kind = if c["kind"] == "gcp" { PointKind::Gcp } else { PointKind::Check };
        let j = points.len();
        if kind == PointKind::Check {
            check_ids.push(j);
        }
        points.push(PointIn { kind, known: Some(g), sigma_h: 0.1, sigma_v: 0.2 });
        for (i, im) in t["images"].as_array().unwrap().iter().enumerate() {
            for o in im["control"].as_array().unwrap() {
                if o["id"] == c["id"] {
                    obs.push(ObsIn { image: i, point: j, x: o["x"].as_f64().unwrap() + 0.3 * rng.gauss(), y: o["y"].as_f64().unwrap() + 0.3 * rng.gauss(), sigma_px: 0.5 });
                }
            }
        }
    }
    // Tie points: a 9 × 9 grid on the terrain, measured in every image that sees them.
    for jy in 0..9 {
        for jx in 0..9 {
            let e = -640.0 + 160.0 * jx as f64;
            let n = -640.0 + 160.0 * jy as f64;
            let lat = 34.5 + n / 110940.0;
            let lon = -116.5 + e / (111320.0 * 34.5f64.to_radians().cos());
            let g = Ground { lat, lon, h: terrain(lat, lon) };
            let mut seen = Vec::new();
            for (i, tr) in truths.iter().enumerate() {
                let (x, y) = tr.ground_to_image(g).unwrap();
                if (8.0..2040.0).contains(&x) && (8.0..2040.0).contains(&y) {
                    seen.push((i, x, y));
                }
            }
            if seen.len() < 2 {
                continue;
            }
            let j = points.len();
            points.push(PointIn { kind: PointKind::Tie, known: None, sigma_h: 0.0, sigma_v: 0.0 });
            for (i, x, y) in seen {
                obs.push(ObsIn { image: i, point: j, x: x + 0.3 * rng.gauss(), y: y + 0.3 * rng.gauss(), sigma_px: 0.5 });
            }
        }
    }
    Block { images, truths, points, obs, check_ids, biases }
}

#[test]
fn fx04_shift_adjustment_recovers_biases_and_checkpoints() {
    let b = block(BiasKind::Shift);
    let s = adjust(&b.images, &b.points, &b.obs, &Options::default()).unwrap();
    eprintln!(
        "σ0 {:.3}, {} it, dof {}, before RMSE {:?} after RMSE {:?} CE90 {:.3} LE90 {:.3}",
        s.sigma0, s.iterations, s.dof, s.checkpoints_before.rmse, s.checkpoints_after.rmse, s.checkpoints_after.ce90, s.checkpoints_after.le90
    );
    assert!(s.converged);
    assert_eq!(s.checkpoints_before.n, 3);
    assert!(s.checkpoints_before.rmse_3d > 10.0, "before {:?}", s.checkpoints_before.rmse);
    assert!(s.checkpoints_after.rmse_r <= 1.5 * GSD && s.checkpoints_after.rmse[2] <= 1.5 * GSD, "after {:?}", s.checkpoints_after.rmse);
    for (i, bias) in s.biases.iter().enumerate() {
        // Δ cancels the planted bias: Δy ≈ −line bias, Δx ≈ −sample bias.
        assert!((bias.c[0] + b.biases[i].0).abs() < 0.5 && (bias.c[3] + b.biases[i].1).abs() < 0.5, "image {i}: {:?} vs {:?}", bias.c, b.biases[i]);
        assert_eq!(s.bias_cov[i].len(), 4);
    }
    assert!(s.sigma0 > 0.3 && s.sigma0 < 1.5, "σ0 {}", s.sigma0);
    assert!(s.residuals.iter().all(|r| !r.flagged));
}

#[test]
fn fx04_blunder_is_flagged_and_removal_lowers_sigma0() {
    let mut b = block(BiasKind::Shift);
    let k = b.obs.iter().position(|o| b.points[o.point].kind == PointKind::Tie).unwrap();
    b.obs[k].x += 9.0;
    let s1 = adjust(&b.images, &b.points, &b.obs, &Options { max_reject: 0, ..Options::default() }).unwrap();
    assert!(s1.residuals[k].flagged, "blunder not flagged: {:?}", s1.residuals[k]);
    let s2 = adjust(&b.images, &b.points, &b.obs, &Options { max_reject: 3, ..Options::default() }).unwrap();
    assert_eq!(s2.rejected.first(), Some(&k));
    assert!(s2.sigma0 < s1.sigma0, "σ0 {} → {}", s1.sigma0, s2.sigma0);
}

#[test]
fn fx04_affine_block_and_multi_image_point() {
    let b = block(BiasKind::Affine);
    let s = adjust(&b.images, &b.points, &b.obs, &Options::default()).unwrap();
    assert!(s.checkpoints_after.rmse_r <= 1.5 * GSD, "affine after {:?}", s.checkpoints_after.rmse);
    // Adjusted models of three images; intersect each checkpoint from them (AT-07.1).
    let models: Vec<Adjusted> = (0..3).map(|i| Adjusted { base: b.images[i].model.clone(), bias: s.biases[i], sigma: Some(0.3), name: "adjusted".into() }).collect();
    for &j in &b.check_ids {
        let known = b.points[j].known.unwrap();
        let ob: Vec<Observation<'_>> = (0..3)
            .map(|i| {
                let (x, y) = b.truths[i].ground_to_image(known).unwrap();
                Observation { model: &models[i] as &dyn SensorModel, x, y, sigma_px: 0.5 }
            })
            .collect();
        let r = intersect(&ob, None).unwrap();
        let (dlat, dlon) = gw_sensor::intersect::deg_per_metre(known);
        let de = (r.ground.lon - known.lon) / dlon;
        let dn = (r.ground.lat - known.lat) / dlat;
        let du = r.ground.h - known.h;
        eprintln!("multi-image point: dE {de:.3} dN {dn:.3} dU {du:.3}, CE90 {:.3} LE90 {:.3}, convergence {:.1}°–{:.1}°", r.ce90, r.le90, r.min_convergence_deg, r.max_convergence_deg);
        assert!(de.hypot(dn) <= GSD && du.abs() <= 1.5 * GSD);
        assert!(r.min_convergence_deg > 10.0);
        assert!(r.ce90 > 0.0 && r.le90 > 0.0);
    }
    // Updated RPC00B for an adjusted image: the refit error is tiny and the model is pole-free.
    let fit = fit_rpc(&models[1], &FitSpec { lat: (34.494, 34.5085), lon: (-116.5085, -116.4915), h: (560.0, 780.0), width: 2048.0, height: 2048.0, err_bias: 0.3, err_rand: 0.3, lambda: 1e-6 }).unwrap();
    eprintln!("refit: rms {:.2e} px, max {:.2e} px, min denominator {:.3}", fit.rms_px, fit.max_px, fit.min_denominator);
    assert!(fit.max_px < 0.02 && fit.pole_free);
}

#[test]
fn convergence_below_ten_degrees_is_reported() {
    let b = block(BiasKind::Shift);
    // Images 1 and 2 of FX-04 converge widely; a pair of nearly parallel rays comes from one
    // image measured twice with a tiny offset of the second model.
    let m = &b.truths[0];
    let g = Ground { lat: 34.5, lon: -116.5, h: terrain(34.5, -116.5) };
    let (x, y) = m.ground_to_image(g).unwrap();
    let ob = [Observation { model: m, x, y, sigma_px: 0.5 }, Observation { model: m, x: x + 0.01, y, sigma_px: 0.5 }];
    match intersect(&ob, Some(g)) {
        Ok(r) => assert!(r.min_convergence_deg < 10.0),
        Err(_) => {} // a singular geometry is refused outright
    }
}
