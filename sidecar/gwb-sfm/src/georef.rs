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
pub fn georef(sparse: &Path, gps_path: &Path, out_model: &Path, sim3_path: &Path, json_path: &Path, refine: bool) -> Res<Value> {
    let (best, registered, models) = largest_model(sparse)?;
    let model = read_model(&best)?;
    let camera = model.cameras.values().next().ok_or("the model has no camera")?;
    let focal = *camera.params.first().ok_or("the model's camera has no focal length")?;
    if !refine && is_colmap_guess(focal, camera.width, camera.height) {
        return Err("the photographs give no focal length COLMAP can use (none in EXIF, or a camera it does not know), so every height would be wrong; refine the focal length only if the block has strong relief or oblique photographs".into());
    }
    let gps: Value = serde_json::from_slice(&fs::read(gps_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let total = gps["images"].as_u64().unwrap_or(0) as usize;
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
    let rms = |f: &dyn Fn(&V3) -> f64| (res.iter().map(|r| f(r).powi(2)).sum::<f64>() / res.len() as f64).sqrt();
    let (rx, ry, rz) = (rms(&|r| r[0]), rms(&|r| r[1]), rms(&|r| r[2]));
    fs::create_dir_all(out_model).map_err(|e| e.to_string())?;
    for f in ["cameras.bin", "images.bin", "points3D.bin", "rigs.bin", "frames.bin"] {
        let from = best.join(f);
        if from.exists() {
            fs::copy(&from, out_model.join(f)).map_err(|e| e.to_string())?;
        }
    }
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
    let out = json!({
        "images": total,
        "registered": registered,
        "models": models,
        "with_gps": pairs.len(),
        "gps_inliers": keep.len(),
        "gps_rms_m": { "east": rx, "north": ry, "up": rz },
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
    fs::write(json_path, serde_json::to_vec_pretty(&out).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colmap_s_default_focal_is_recognised() {
        assert!(is_colmap_guess(1.2 * 4896.0, 4896, 3672));
        assert!(is_colmap_guess(1920.0, 1200, 1600));
        assert!(!is_colmap_guess(3536.883, 4896, 3672));
    }
}
