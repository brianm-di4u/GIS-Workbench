//! `georef`: pick the largest model COLMAP made and fit it to the cameras' GPS. The model is placed
//! in UTM less a round offset, in metres, with Z the height the GPS recorded: fused points are
//! single precision, so full UTM coordinates would lose centimetres.

use crate::colmap::{centre, read_model};
use crate::geo::{dot, fit_sim3_robust, linearity, norm, sub, utm_forward, utm_zone, V3};
use crate::Res;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// A straight strip leaves the roll about the line unresolved.
const MIN_SPREAD: f64 = 0.02;

fn largest_model(sparse: &Path) -> Res<(std::path::PathBuf, usize, usize)> {
    let mut best: Option<(std::path::PathBuf, usize)> = None;
    let mut count = 0;
    for d in fs::read_dir(sparse).map_err(|_| "COLMAP made no model: the photographs did not connect (too little overlap, or too few features)".to_string())?.flatten() {
        let p = d.path();
        if !p.join("images.bin").exists() {
            continue;
        }
        count += 1;
        let n = crate::colmap::parse_images(&fs::read(p.join("images.bin")).map_err(|e| e.to_string())?)?.len();
        if best.as_ref().is_none_or(|(_, m)| n > *m) {
            best = Some((p, n));
        }
    }
    let (p, n) = best.ok_or("COLMAP made no model: the photographs did not connect (too little overlap, or too few features)")?;
    Ok((p, n, count))
}

/// With no focal length in EXIF, COLMAP starts from 1.2 times the longest side.
fn is_colmap_guess(focal: f64, width: u64, height: u64) -> bool {
    (focal - 1.2 * width.max(height) as f64).abs() < 1e-6
}

/// `refine` says the mapper was allowed to change the focal length. It is held by default: a flat
/// near-nadir block cannot calibrate itself. Focal length and height trade off almost freely there,
/// so bundle adjustment can walk far along that line with reprojection error and the fit to GPS
/// both excellent. On the synthetic block it went 55 % long from a prior 4 % off, and every height
/// was 56 m wrong (docs/validation/2.6/sfm.md). Held, the height error is the prior's error.
pub fn georef(sparse: &Path, gps_path: &Path, out_model: &Path, sim3_path: &Path, json_path: &Path, refine: bool, control_path: Option<&Path>) -> Res<Value> {
    let gps: Value = serde_json::from_slice(&fs::read(gps_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // In the second stage of a controlled run the model and its focal setting come from the first.
    let refine = refine || gps["stage_one"]["focal_refined"].as_bool().unwrap_or(false);
    let (best, registered, models) = largest_model(sparse)?;
    let model = read_model(&best)?;
    let camera = model.cameras.values().next().ok_or("the model has no camera")?;
    let focal = *camera.params.first().ok_or("the model's camera has no focal length")?;
    if !refine && is_colmap_guess(focal, camera.width, camera.height) {
        return Err("the photographs give no focal length COLMAP can use (none in EXIF, or a camera it does not know), so every height would be wrong; refine the focal length only if the block has strong relief or oblique photographs".into());
    }
    let control = match control_path {
        Some(p) => Some(crate::gcp::parse(&fs::read_to_string(p).map_err(|e| format!("could not read the control file: {e}"))?)?),
        None => None,
    };
    let total = gps["images"].as_u64().unwrap_or(0) as usize;
    // With ground control, the GPS fit is only reported: the block is placed by the control points,
    // and a block with no GPS at all can be placed by them alone.
    let gps_fit = match (&control, fit_gps(&model, &gps)) {
        (None, r) => Some(r?),
        (Some(_), r) => r.ok(),
    };
    let (fit, zone, south, offset, control_json) = match &control {
        Some(c) => {
            let (zone, south) = (c.epsg % 100, c.epsg >= 32700);
            let n = c.points.len() as f64;
            let mean = |k: usize| c.points.iter().map(|p| p.xyz[k]).sum::<f64>() / n;
            let offset = [(mean(0) / 1000.0).floor() * 1000.0, (mean(1) / 1000.0).floor() * 1000.0];
            let cf = crate::gcp::fit_control(&model, c, [offset[0], offset[1], 0.0])?;
            (cf.sim3, zone, south, offset, Some((c, cf)))
        }
        None => {
            let g = gps_fit.as_ref().ok_or("no GPS fit")?;
            (g.sim3, g.zone, g.south, g.offset, None)
        }
    };
    fs::create_dir_all(out_model).map_err(|e| e.to_string())?;
    // COLMAP 4 takes the poses from frames.bin when it is there and ignores those in images.bin, so a
    // block adjusted with ground control is written without rigs and frames: COLMAP then makes one
    // rig per camera and one frame per photograph from images.bin, which is the same block.
    let files: &[&str] = if control.is_some() { &["cameras.bin", "images.bin", "points3D.bin"] } else { &["cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"] };
    for f in files {
        let from = best.join(f);
        if from.exists() {
            fs::copy(&from, out_model.join(f)).map_err(|e| e.to_string())?;
        }
    }
    // With ground control, the block is adjusted (poses, points and the lens, the control weighted
    // by its sigma) and written back in the model's frame, so the steps after this one are unchanged.
    let control_json = match control_json {
        None => None,
        Some((c, cf)) => {
            let obs = crate::colmap::parse_observations(&fs::read(best.join("images.bin")).map_err(|e| e.to_string())?)?;
            let a = crate::gcp::adjust_block(&model, &obs, c, &fit, [offset[0], offset[1], 0.0])?;
            let images = fs::read(out_model.join("images.bin")).map_err(|e| e.to_string())?;
            fs::write(out_model.join("images.bin"), crate::colmap::patch_poses(&images, &a.poses)?).map_err(|e| e.to_string())?;
            let points = fs::read(out_model.join("points3D.bin")).map_err(|e| e.to_string())?;
            fs::write(out_model.join("points3D.bin"), crate::colmap::patch_points(&points, &a.points)?).map_err(|e| e.to_string())?;
            let cams = fs::read(out_model.join("cameras.bin")).map_err(|e| e.to_string())?;
            fs::write(out_model.join("cameras.bin"), crate::colmap::patch_cameras(&cams, &a.cameras)?).map_err(|e| e.to_string())?;
            let lens = a.cameras.values().next().map(|after| json!({ "model": camera.model, "before": camera.params, "after": after }));
            let mark = |id: &str| a.marks.iter().find(|m| m.id == id).map(|m| json!({ "marks": m.marks, "rms_px": m.rms_px, "max_px": m.max_px, "max_image": m.max_image, "own_rms_px": m.own_rms_px }));
            let axes = |v: Option<V3>| v.map(|v| json!({ "east": v[0], "north": v[1], "up": v[2] }));
            let point = |r: &crate::gcp::Residual| json!({ "id": r.id, "role": if r.check { "check" } else { "gcp" }, "residual_m": { "east": r.d[0], "north": r.d[1], "up": r.d[2] }, "marks_px": mark(&r.id) });
            Some(json!({
                "epsg": c.epsg,
                "gcps": a.residuals.iter().filter(|r| !r.check).count(),
                "checks": a.residuals.iter().filter(|r| r.check).count(),
                "unmarked": cf.unmarked,
                "rmse_gcp_m": axes(crate::gcp::rmse(&a.residuals, false)),
                "rmse_check_m": axes(crate::gcp::rmse(&a.residuals, true)),
                "points": a.residuals.iter().map(point).collect::<Vec<_>>(),
                "before_adjustment": {
                    "rmse_gcp_m": axes(crate::gcp::rmse(&cf.residuals, false)),
                    "rmse_check_m": axes(crate::gcp::rmse(&cf.residuals, true)),
                },
                "adjustment": { "iterations": a.stats.iterations, "reprojection_px_before": a.stats.rms_px_before, "reprojection_px_after": a.stats.rms_px_after, "lens": lens },
            }))
        }
    };
    fs::write(sim3_path, format!("{:.17e} {:.17e} {:.17e} {:.17e} {:.17e} {:.17e} {:.17e} {:.17e}\n", fit.s, fit.q[0], fit.q[1], fit.q[2], fit.q[3], fit.t[0], fit.t[1], fit.t[2])).map_err(|e| e.to_string())?;
    let mut errs: Vec<f64> = model.points.values().map(|p| p.error).filter(|e| e.is_finite()).collect();
    errs.sort_by(f64::total_cmp);
    let track: f64 = model.points.values().map(|p| p.track.len() as f64).sum::<f64>() / model.points.len().max(1) as f64;
    // Nadir check: a downward block has its cameras' optical axes near -Z after the fit.
    let r = crate::geo::quat_to_mat(fit.q);
    let mut tilts: Vec<f64> = model
        .images
        .iter()
        .map(|i| {
            let cam_r = crate::colmap::rotation(i);
            let axis_model = [cam_r[2][0], cam_r[2][1], cam_r[2][2]];
            let axis_world = crate::geo::mat_vec(&r, axis_model);
            (-dot(axis_world, [0.0, 0.0, 1.0]) / norm(axis_world).max(1e-12)).clamp(-1.0, 1.0).acos().to_degrees()
        })
        .collect();
    tilts.sort_by(f64::total_cmp);
    let gps_rms = gps_fit.as_ref().map(|g| json!({ "east": g.rms[0], "north": g.rms[1], "up": g.rms[2] }));
    let mut out = json!({
        "images": total,
        "registered": registered,
        "models": models,
        "with_gps": gps_fit.as_ref().map_or(0, |g| g.with_gps),
        "gps_inliers": gps_fit.as_ref().map_or(0, |g| g.inliers),
        "gps_rms_m": gps_rms,
        "scale": fit.s,
        "utm_zone": zone,
        "south": south,
        "epsg": (if south { 32700 } else { 32600 }) + zone,
        "offset": [offset[0], offset[1], 0.0],
        "sparse_points": model.points.len(),
        "mean_track": track,
        "reprojection_px": { "mean": errs.iter().sum::<f64>() / errs.len().max(1) as f64, "median": errs.get(errs.len() / 2).copied().unwrap_or(0.0) },
        "median_tilt_deg": tilts.get(tilts.len() / 2).copied().unwrap_or(0.0),
        "focal": { "px": focal, "refined": refine, "width": camera.width, "height": camera.height },
    });
    if gps["stage_one"].is_object() {
        out["stage_one"] = gps["stage_one"].clone();
    }
    if let Some(c) = control_json {
        out["control"] = c;
    }
    fs::write(json_path, serde_json::to_vec_pretty(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(out)
}

struct GpsFit {
    sim3: crate::geo::Sim3,
    zone: u32,
    south: bool,
    offset: [f64; 2],
    with_gps: usize,
    inliers: usize,
    rms: V3,
}

/// The model fitted to the cameras' GPS (UTM less a round offset, Z the recorded height).
fn fit_gps(model: &crate::colmap::Model, gps: &Value) -> Res<GpsFit> {
    let tags = gps["gps"].as_object().ok_or("gps.json holds no positions")?;
    let mut pairs: Vec<(V3, f64, f64, f64)> = Vec::new();
    let mut sum_lon = 0.0;
    for im in &model.images {
        if let Some(a) = tags.get(&im.name).and_then(|v| v.as_array()) {
            let (lat, lon, alt) = (a[0].as_f64().unwrap_or(0.0), a[1].as_f64().unwrap_or(0.0), a[2].as_f64().unwrap_or(0.0));
            sum_lon += lon;
            pairs.push((centre(im), lat, lon, alt));
        }
    }
    if pairs.len() < 3 {
        return Err(format!("only {} registered photographs have GPS; at least 3 are needed to georeference the block", pairs.len()));
    }
    let zone = utm_zone(sum_lon / pairs.len() as f64);
    let south = pairs.iter().map(|p| p.1).sum::<f64>() < 0.0;
    let utm: Vec<(f64, f64)> = pairs.iter().map(|p| utm_forward(p.1, p.2, zone)).map(|(e, n)| (e, if south && n < 5_000_000.0 { n + 10_000_000.0 } else { n })).collect();
    let n = utm.len() as f64;
    let offset = [(utm.iter().map(|u| u.0).sum::<f64>() / n / 1000.0).floor() * 1000.0, (utm.iter().map(|u| u.1).sum::<f64>() / n / 1000.0).floor() * 1000.0];
    let dst: Vec<V3> = utm.iter().zip(&pairs).map(|(u, p)| [u.0 - offset[0], u.1 - offset[1], p.3]).collect();
    let src: Vec<V3> = pairs.iter().map(|p| p.0).collect();
    let spread = linearity(&dst);
    if spread < MIN_SPREAD {
        return Err(format!("the camera positions lie on a line (spread ratio {spread:.4}): a single strip cannot be georeferenced from GPS alone"));
    }
    let (fit, keep) = fit_sim3_robust(&src, &dst).ok_or("the GPS positions could not be fitted to the model")?;
    if keep.len() < 3 {
        return Err("the GPS positions disagree with the model; no consistent fit exists".into());
    }
    let res: Vec<V3> = keep.iter().map(|i| sub(fit.apply(src[*i]), dst[*i])).collect();
    let rms = |k: usize| (res.iter().map(|r| r[k].powi(2)).sum::<f64>() / res.len() as f64).sqrt();
    Ok(GpsFit { sim3: fit, zone, south, offset, with_gps: pairs.len(), inliers: keep.len(), rms: [rms(0), rms(1), rms(2)] })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A COLMAP model on disk: one SIMPLE_RADIAL camera and a 3 x 3 grid of photographs looking
    /// down from 100 m, in a frame that is the ground scaled by 1/2.5 and turned (as COLMAP's is).
    fn write_block(dir: &Path) -> (crate::colmap::Model, crate::geo::Sim3) {
        use crate::colmap::{Camera, Image, Model};
        use crate::geo::{mat_vec, quat_to_mat, scale};
        let cam = Camera { model: 2, width: 4000, height: 3000, params: vec![3000.0, 2000.5, 1500.5, -0.08] };
        let mut m = Model::default();
        m.cameras.insert(1, cam.clone());
        let mut c = Vec::new();
        c.extend(1u64.to_le_bytes());
        c.extend(1u32.to_le_bytes());
        c.extend(2u32.to_le_bytes());
        c.extend(4000u64.to_le_bytes());
        c.extend(3000u64.to_le_bytes());
        for v in &cam.params {
            c.extend(v.to_le_bytes());
        }
        let mut im = Vec::new();
        im.extend(9u64.to_le_bytes());
        let mut id = 0u32;
        for i in 0..3 {
            for j in 0..3 {
                id += 1;
                let q = [0.0, 1.0, 0.0, 0.0];
                let centre = [i as f64 * 16.0 - 16.0, j as f64 * 12.0 - 12.0, 40.0];
                let t = scale(mat_vec(&quat_to_mat(q), centre), -1.0);
                let name = format!("IMG_{id}.JPG");
                im.extend(id.to_le_bytes());
                for v in q.iter().chain(t.iter()) {
                    im.extend(v.to_le_bytes());
                }
                im.extend(1u32.to_le_bytes());
                im.extend(name.as_bytes());
                im.push(0);
                im.extend(0u64.to_le_bytes());
                m.images.push(Image { id, q, t, camera: 1, name, points: vec![] });
            }
        }
        let model_dir = dir.join("sparse").join("0");
        fs::create_dir_all(&model_dir).unwrap();
        fs::write(model_dir.join("cameras.bin"), c).unwrap();
        fs::write(model_dir.join("images.bin"), im).unwrap();
        fs::write(model_dir.join("points3D.bin"), 0u64.to_le_bytes()).unwrap();
        let a: f64 = 0.4;
        (m, crate::geo::Sim3 { s: 2.5, q: [(a / 2.0).cos(), 0.0, 0.0, (a / 2.0).sin()], t: [512.0, 734.0, 300.0] })
    }

    fn project(m: &crate::colmap::Model, im: &crate::colmap::Image, x: V3) -> (f64, f64) {
        let c = &m.cameras[&1];
        let p = crate::geo::add(crate::geo::mat_vec(&crate::colmap::rotation(im), x), im.t);
        let (u, v) = (p[0] / p[2], p[1] / p[2]);
        let d = 1.0 + c.params[3] * (u * u + v * v);
        (c.params[0] * u * d + c.params[1], c.params[0] * v * d + c.params[2])
    }

    /// No GPS in any photograph: the control points alone place the block, the checkpoint lands on
    /// its survey, and georef.json carries the control block. Without control the same block is refused.
    #[test]
    fn ground_control_places_a_block_without_gps() {
        let dir = std::env::temp_dir().join(format!("gwb-sfm-gcp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (m, truth) = write_block(&dir);
        let offset = [440000.0, 4564000.0, 0.0];
        let pts = [[-8.0, -6.0, 0.0], [10.0, -4.0, 1.0], [0.0, 8.0, 0.5], [-6.0, 7.0, 2.0], [4.0, 0.0, -0.5]];
        let mut csv = String::from("id,x,y,z,crs,sigma,role,image,px,py\n");
        for (k, x) in pts.iter().enumerate() {
            let g = crate::geo::add(truth.apply(*x), offset);
            let role = if k == 4 { "check" } else { "gcp" };
            for im in &m.images {
                let (px, py) = project(&m, im, *x);
                if px > 0.0 && px < 4000.0 && py > 0.0 && py < 3000.0 {
                    csv += &format!("P{k},{:.6},{:.6},{:.6},EPSG:32617,0.02,{role},{},{px},{py}\n", g[0], g[1], g[2], im.name);
                }
            }
        }
        fs::write(dir.join("gcp.csv"), csv).unwrap();
        fs::write(dir.join("gps.json"), r#"{"images":9,"with_gps":0,"gps":{}}"#).unwrap();
        let run = |control: Option<&Path>| georef(&dir.join("sparse"), &dir.join("gps.json"), &dir.join("model"), &dir.join("sim3.txt"), &dir.join("georef.json"), false, control);
        let err = run(None).unwrap_err();
        assert!(err.contains("only 0 registered photographs have GPS"), "{err}");
        let out = run(Some(&dir.join("gcp.csv"))).unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!((out["epsg"].as_u64(), out["with_gps"].as_u64(), out["gps_rms_m"].is_null()), (Some(32617), Some(0), true));
        assert!((out["scale"].as_f64().unwrap() - truth.s).abs() < 1e-6, "{out}");
        let c = &out["control"];
        assert_eq!((c["gcps"].as_u64(), c["checks"].as_u64()), (Some(4), Some(1)), "{c}");
        for axis in ["east", "north", "up"] {
            assert!(c["rmse_check_m"][axis].as_f64().unwrap() < 1e-4, "{c}");
        }
    }

    /// A bent block, as a weak block drifts: the model is the ground with a dome of up to 2.5 m
    /// added, 20 photographs and 300 tie points seen with up to 0.3 px of noise. A similarity cannot
    /// take the dome out; the adjustment weighted by the control can, and the model it writes back
    /// puts the checkpoints on their survey.
    #[test]
    fn the_adjustment_takes_out_a_bend_a_similarity_cannot() {
        let (out, worst, carried) = bent_block("bend", &|_| 0.02, &|_| [0.0; 3]);
        let c = &out["control"];
        let up = |j: &Value| j["rmse_check_m"]["up"].as_f64().unwrap();
        assert!(
            up(&c["before_adjustment"]) > 0.2,
            "the bend should show before the adjustment: {c}"
        );
        for axis in ["east", "north", "up"] {
            assert!(c["rmse_check_m"][axis].as_f64().unwrap() < 0.05, "{c}");
        }
        assert!(
            worst < 0.05,
            "the written model puts a checkpoint {worst} m off: {c}"
        );
        assert_eq!(carried, [false, false], "rigs.bin and frames.bin would override the adjusted poses");
        // The report names the photograph of each point's worst mark.
        assert!(c["points"][0]["marks_px"]["max_image"].as_str().unwrap().ends_with(".JPG"), "{c}");
    }

    /// The control is weighted by each point's stated sigma: a survey 0.3 m off, given a loose
    /// sigma, is left off and the block stays on the others; given the same sigma as the others, it
    /// pulls the block towards it.
    #[test]
    fn each_control_point_counts_by_its_stated_sigma() {
        let off = |k: usize| if k == 0 { [0.0, 0.0, 0.3] } else { [0.0; 3] };
        let (loose, ..) = bent_block("loose", &|k| if k == 0 { 1.0 } else { 0.02 }, &off);
        let (tight, ..) = bent_block("tight", &|_| 0.02, &off);
        let up = |out: &Value, id: &str| {
            let p = out["control"]["points"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap();
            p["residual_m"]["up"].as_f64().unwrap()
        };
        let others = |out: &Value| ["P1", "P2", "P3", "P4", "P5"].iter().map(|id| up(out, id).abs()).fold(0.0f64, f64::max);
        // Loose: P0 keeps nearly all of its 0.3 m, and the others stay on their survey.
        assert!(up(&loose, "P0") < -0.25, "{}", loose["control"]);
        assert!(others(&loose) < 0.03, "{}", loose["control"]);
        // Tight: P0 pulls the block, so it keeps less of its error and the others take some.
        assert!(up(&tight, "P0") > up(&loose, "P0") + 0.03, "{} / {}", tight["control"], loose["control"]);
        assert!(others(&tight) > others(&loose), "{} / {}", tight["control"], loose["control"]);
    }

    /// The bent block below, its control points' sigmas from `sigma` and their surveys moved by
    /// `shift` (both by index: 0 to 5 are control points, 6 and 7 checkpoints), placed and adjusted
    /// by georef. Returns the report, the worst checkpoint off in the written model, and whether
    /// rigs.bin and frames.bin were carried into it.
    fn bent_block(tag: &str, sigma: &dyn Fn(usize) -> f64, shift: &dyn Fn(usize) -> V3) -> (Value, f64, [bool; 2]) {
        use crate::geo::{add, mat_vec, quat_to_mat, scale, sub};
        let dir = std::env::temp_dir().join(format!("gwb-sfm-ba-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (_, truth) = write_block(&dir);
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64 - 0.5
        };
        let bend = |x: V3| [x[0], x[1], x[2] + 0.002 * (x[0] * x[0] + x[1] * x[1])];
        let mut m = crate::colmap::Model::default();
        m.cameras.insert(
            1,
            crate::colmap::Camera {
                model: 2,
                width: 4000,
                height: 3000,
                params: vec![3000.0, 2000.5, 1500.5, -0.08],
            },
        );
        let q = [0.0, 1.0, 0.0, 0.0];
        for k in 0..20u32 {
            let c = [
                (k % 5) as f64 * 10.0 - 20.0,
                (k / 5) as f64 * 8.0 - 12.0,
                40.0,
            ];
            let t = scale(mat_vec(&quat_to_mat(q), c), -1.0);
            m.images.push(crate::colmap::Image {
                id: k + 1,
                q,
                t,
                camera: 1,
                name: format!("IMG_{}.JPG", k + 1),
                points: vec![],
            });
        }
        let ground: Vec<V3> = (0..300)
            .map(|_| [rnd() * 50.0, rnd() * 40.0, rnd() * 2.0])
            .collect();
        let mut obs: Vec<Vec<(usize, [f64; 2])>> = Vec::new();
        for x in &ground {
            let mut o = Vec::new();
            for (k, im) in m.images.iter().enumerate() {
                let (px, py) = project(&m, im, *x);
                if px > 0.0 && px < 4000.0 && py > 0.0 && py < 3000.0 {
                    o.push((k, [px + 0.6 * rnd(), py + 0.6 * rnd()]));
                }
            }
            obs.push(o);
        }
        let mut seen: Vec<Vec<([f64; 2], u64)>> = vec![Vec::new(); m.images.len()];
        let mut pb = Vec::new();
        pb.extend((obs.iter().filter(|o| o.len() >= 2).count() as u64).to_le_bytes());
        for (p, o) in obs.iter().enumerate().filter(|(_, o)| o.len() >= 2) {
            let id = p as u64 + 1;
            pb.extend(id.to_le_bytes());
            for v in bend(ground[p]) {
                pb.extend(v.to_le_bytes());
            }
            pb.extend([128u8; 3]);
            pb.extend(0.5f64.to_le_bytes());
            pb.extend((o.len() as u64).to_le_bytes());
            for (k, xy) in o {
                pb.extend((*k as u32 + 1).to_le_bytes());
                pb.extend((seen[*k].len() as u32).to_le_bytes());
                seen[*k].push((*xy, id));
            }
        }
        let mut ib = Vec::new();
        ib.extend((m.images.len() as u64).to_le_bytes());
        for (k, im) in m.images.iter().enumerate() {
            let t = scale(
                mat_vec(&quat_to_mat(q), bend(crate::colmap::centre(im))),
                -1.0,
            );
            ib.extend(im.id.to_le_bytes());
            for v in q.iter().chain(t.iter()) {
                ib.extend(v.to_le_bytes());
            }
            ib.extend(1u32.to_le_bytes());
            ib.extend(im.name.as_bytes());
            ib.push(0);
            ib.extend((seen[k].len() as u64).to_le_bytes());
            for (xy, pid) in &seen[k] {
                ib.extend(xy[0].to_le_bytes());
                ib.extend(xy[1].to_le_bytes());
                ib.extend(pid.to_le_bytes());
            }
        }
        let sparse = dir.join("sparse").join("0");
        fs::write(sparse.join("images.bin"), ib).unwrap();
        fs::write(sparse.join("points3D.bin"), pb).unwrap();
        // COLMAP 4's rigs and frames, which would override the adjusted poses if copied.
        fs::write(sparse.join("rigs.bin"), 0u64.to_le_bytes()).unwrap();
        fs::write(sparse.join("frames.bin"), 0u64.to_le_bytes()).unwrap();
        let offset = [440000.0, 4564000.0, 0.0];
        let gcps = [
            [-20.0, -15.0, 0.0],
            [20.0, -15.0, 0.5],
            [-20.0, 15.0, 1.0],
            [20.0, 15.0, 0.0],
            [0.0, 0.0, 0.3],
            [0.0, -15.0, 0.0],
        ];
        let checks = [[-10.0, 8.0, 0.2], [12.0, -6.0, 0.4]];
        let mut csv = String::from("id,x,y,z,crs,sigma,role,image,px,py\n");
        for (k, (x, role)) in gcps
            .iter()
            .map(|x| (x, "gcp"))
            .chain(checks.iter().map(|x| (x, "check")))
            .enumerate()
        {
            let g = add(add(truth.apply(*x), offset), shift(k));
            for im in &m.images {
                let (px, py) = project(&m, im, *x);
                if px > 0.0 && px < 4000.0 && py > 0.0 && py < 3000.0 {
                    csv += &format!(
                        "P{k},{:.4},{:.4},{:.4},EPSG:32617,{},{role},{},{:.2},{:.2}\n",
                        g[0],
                        g[1],
                        g[2],
                        sigma(k),
                        im.name,
                        px + rnd(),
                        py + rnd()
                    );
                }
            }
        }
        fs::write(dir.join("gcp.csv"), &csv).unwrap();
        fs::write(
            dir.join("gps.json"),
            r#"{"images":20,"with_gps":0,"gps":{}}"#,
        )
        .unwrap();
        let out = georef(
            &dir.join("sparse"),
            &dir.join("gps.json"),
            &dir.join("model"),
            &dir.join("sim3.txt"),
            &dir.join("georef.json"),
            false,
            Some(&dir.join("gcp.csv")),
        )
        .unwrap();
        // The model written back, placed by the sim3 written beside it.
        let model = crate::colmap::read_model(&dir.join("model")).unwrap();
        let carried = ["rigs.bin", "frames.bin"].map(|f| dir.join("model").join(f).exists());
        let v: Vec<f64> = fs::read_to_string(dir.join("sim3.txt"))
            .unwrap()
            .split_whitespace()
            .map(|s| s.parse().unwrap())
            .collect();
        let _ = fs::remove_dir_all(&dir);
        let sim3 = crate::geo::Sim3 {
            s: v[0],
            q: [v[1], v[2], v[3], v[4]],
            t: [v[5], v[6], v[7]],
        };
        let control = crate::gcp::parse(&csv).unwrap();
        let mut worst = 0.0f64;
        for p in control.points.iter().filter(|p| p.check) {
            let (x, _) = crate::gcp::triangulate(&model, &p.marks).unwrap().unwrap();
            let d = sub(sim3.apply(x), sub(p.xyz, offset));
            worst = worst.max(d.iter().fold(0.0f64, |a, v| a.max(v.abs())));
        }
        (out, worst, carried)
    }

    #[test]
    fn colmap_s_default_focal_is_recognised() {
        assert!(is_colmap_guess(1.2 * 4896.0, 4896, 3672));
        assert!(is_colmap_guess(1920.0, 1200, 1600));
        assert!(!is_colmap_guess(3536.883, 4896, 3672));
    }
}
