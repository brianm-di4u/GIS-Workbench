//! REQ-GAP-22 on real data: the OpenDroneMap blocks of the T&E corpus (frames-odm-aukerman,
//! -bellus-gcp, -copr-gcp, -seneca). Tie points come from tests/tools/aero_ties.py (OpenCV SIFT,
//! independent of this solver) in E:/gwb25/data-aero/ties; each test skips when its file or the
//! corpus is absent. Results (σ₀, the camera, GNSS residuals, check-point errors against the
//! surveyed GCPs) are printed and written to E:/gwb25/data-aero/results for the validation note
//! and the OpenCV oracle (tests/tools/aero_oracle.py).
//!
//! Debug builds use a tenth of the tracks (the solver's arithmetic is the same; debug is for
//! overflow checks).

use gw_aero::aero::*;
use gw_adjust::block::{ObsIn, PointIn, PointKind};
use gw_sensor::Ground;
use serde_json::Value;
use std::path::Path;

const TIES: &str = "E:/gwb25/data-aero/ties";
const CORPUS: &str = "E:/TE-corpus";
const OUT: &str = "E:/gwb25/data-aero/results";

struct Img {
    file: String,
    w: f64,
    h: f64,
    focal: f64,
    pixel: f64,
    gps: Option<Ground>,
}

struct Ties {
    images: Vec<Img>,
    tracks: Vec<Vec<(usize, f64, f64)>>,
}

fn load(block: &str) -> Option<Ties> {
    let p = format!("{TIES}/{block}.json");
    let text = std::fs::read_to_string(&p).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let images = v["images"]
        .as_array()?
        .iter()
        .map(|im| {
            let ex = &im["exif"];
            let w = im["width"].as_f64().unwrap();
            let h = im["height"].as_f64().unwrap();
            let fpr = ex["FocalPlaneXResolution"].as_f64();
            let unit = ex["FocalPlaneResolutionUnit"].as_f64().unwrap_or(2.0);
            let ew = ex["ExifImageWidth"].as_f64().unwrap_or(w);
            // Pixel pitch from the focal-plane resolution (per inch or cm, at the EXIF width),
            // else the 1/2.3" sensor (6.17 mm wide) of the Sony DSC-WX220 (Aukerman).
            let pixel = match fpr {
                Some(r) if r > 0.0 => (if unit == 3.0 { 10.0 } else { 25.4 }) / r * ew / w,
                _ => 6.17 / w,
            };
            let xmp = &ex["xmp"];
            let wgs = xmp["sensefly:AltitudeWGS84"].as_str().and_then(|s| s.parse::<f64>().ok());
            let gps = match (ex["lat"].as_f64(), ex["lon"].as_f64(), ex["alt"].as_f64()) {
                (Some(lat), Some(lon), Some(alt)) => Some(Ground { lat, lon, h: wgs.unwrap_or(alt) }),
                _ => None,
            };
            Img { file: im["file"].as_str().unwrap().to_string(), w, h, focal: ex["focal_mm"].as_f64().unwrap_or(0.0), pixel, gps }
        })
        .collect();
    let tracks = v["tracks"].as_array()?.iter().map(|t| t.as_array().unwrap().iter().map(|o| (o[0].as_u64().unwrap() as usize, o[1].as_f64().unwrap(), o[2].as_f64().unwrap())).collect()).collect();
    Some(Ties { images, tracks })
}

/// ODM gcp_list.txt: a header (projection), then easting northing elevation px py image [name].
fn gcps(path: &str, zone: i32, north: bool) -> Vec<(String, Ground, String, f64, f64)> {
    let Ok(t) = std::fs::read_to_string(path) else { return Vec::new() };
    t.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 6 {
                return None;
            }
            let (e, n, z, px, py) = (f[0].parse::<f64>().ok()?, f[1].parse::<f64>().ok()?, f[2].parse::<f64>().ok()?, f[3].parse::<f64>().ok()?, f[4].parse::<f64>().ok()?);
            let (lat, lon, _, _) = gw_geodesy::grids::utmups_reverse(zone, north, e, n).ok()?;
            let name = f.get(6).map(|s| s.to_string()).unwrap_or_else(|| format!("{e:.2},{n:.2}"));
            Some((name, Ground { lat, lon, h: z }, f[5].to_string(), px, py))
        })
        .collect()
}

#[derive(Clone)]
struct Cfg {
    name: &'static str,
    selfcal: Vec<usize>,
    gnss: Option<(f64, f64)>,
    nadir: bool,
    /// Geoid undulation added to the GCP heights (orthometric → ellipsoidal), m.
    geoid_n: f64,
    gcp_sigma: (f64, f64),
    /// GCP names (or image-measurement indices) held out as checkpoints.
    checks: Vec<String>,
    sigma_px: f64,
    max_reject: usize,
    min_rays: usize,
    /// A priori σ of the focal length (mm; 0 = free).
    f_sigma: f64,
}

struct Run {
    report: Report,
    aero: Aero,
    names: Vec<String>,
    gcp_names: Vec<(usize, String)>,
    elapsed: f64,
}

fn run(t: &Ties, gcp: &[(String, Ground, String, f64, f64)], cfg: &Cfg) -> Run {
    // The most common image size is the camera (Seneca's first image is smaller).
    let mut sizes: Vec<((u64, u64), usize)> = Vec::new();
    for im in &t.images {
        let k = (im.w as u64, im.h as u64);
        match sizes.iter_mut().find(|x| x.0 == k) {
            Some(x) => x.1 += 1,
            None => sizes.push((k, 1)),
        }
    }
    sizes.sort_by(|a, b| b.1.cmp(&a.1));
    let im0 = t.images.iter().find(|im| (im.w as u64, im.h as u64) == sizes[0].0).unwrap();
    let mut io = [0.0; NIO];
    io[0] = im0.focal;
    let mut cam = CameraIn { projection: Projection::Brown, film: false, pixel_mm: im0.pixel, width: im0.w, height: im0.h, io, io_free: [false; NIO], io_sigma: [0.0; NIO], mount: [0.0; 6], mount_free: [false; 6], mount_sigma: [0.0; 6] };
    for &q in &cfg.selfcal {
        cam.io_free[q] = true;
    }
    cam.io_sigma[0] = cfg.f_sigma;
    // Images of another size are left out: one camera.
    let keep: Vec<usize> = (0..t.images.len()).filter(|&i| t.images[i].w == im0.w && t.images[i].h == im0.h).collect();
    let idx: std::collections::HashMap<usize, usize> = keep.iter().enumerate().map(|(k, &i)| (i, k)).collect();
    let mut images = Vec::new();
    for &i in &keep {
        let im = &t.images[i];
        let approx = im.gps.map(|g| (g, gw_sensor::frame::rotation(0.0, 0.0, 0.0)));
        images.push(ImageIn { camera: 0, fixed: false, approx, attitude_known: !cfg.nadir && approx.is_some(), gnss: match (cfg.gnss, im.gps) {
            (Some((sh, sv)), Some(_)) => Some([sh, sh, sv]),
            _ => None,
        }, imu: None, film: None });
    }
    let mut points = Vec::new();
    let mut obs = Vec::new();
    let stride = if cfg!(debug_assertions) { 10 } else { 1 };
    for tr in t.tracks.iter().step_by(stride) {
        let rays: Vec<&(usize, f64, f64)> = tr.iter().filter(|o| idx.contains_key(&o.0)).collect();
        if rays.len() < cfg.min_rays {
            continue;
        }
        let j = points.len();
        points.push(PointIn { kind: PointKind::Tie, known: None, sigma_h: 0.0, sigma_v: 0.0 });
        for o in rays {
            obs.push(ObsIn { image: idx[&o.0], point: j, x: o.1, y: o.2, sigma_px: cfg.sigma_px });
        }
    }
    // Control: one point per GCP name, with every image measurement of it.
    let mut gcp_names = Vec::new();
    let mut by_name: Vec<(String, usize)> = Vec::new();
    for (name, g, file, px, py) in gcp {
        let Some(i) = t.images.iter().position(|im| &im.file == file) else { continue };
        let Some(&k) = idx.get(&i) else { continue };
        let j = match by_name.iter().find(|(n, _)| n == name) {
            Some((_, j)) => *j,
            None => {
                let j = points.len();
                let check = cfg.checks.iter().any(|c| c == name);
                points.push(PointIn { kind: if check { PointKind::Check } else { PointKind::Gcp }, known: Some(Ground { h: g.h + cfg.geoid_n, ..*g }), sigma_h: cfg.gcp_sigma.0, sigma_v: cfg.gcp_sigma.1 });
                by_name.push((name.clone(), j));
                gcp_names.push((j, name.clone()));
                j
            }
        };
        obs.push(ObsIn { image: k, point: j, x: *px, y: *py, sigma_px: 2.0 });
    }
    let opts = AeroOptions { robust: Robust::Huber(2.0), reject_k: 4.0, max_reject: cfg.max_reject, max_iterations: 100, ..AeroOptions::default() };
    let t0 = std::time::Instant::now();
    let mut a = Aero::new(vec![cam], images, points, obs, opts).unwrap_or_else(|e| panic!("{}: {e}", cfg.name));
    let trace = std::env::var("GW_AERO_TRACE").is_ok();
    loop {
        let p = a.step().unwrap_or_else(|e| panic!("{}: {e}", cfg.name));
        if trace {
            eprintln!("  {:?}", p);
        }
        if p.done {
            break;
        }
    }
    let report = a.report().unwrap();
    let elapsed = t0.elapsed().as_secs_f64();
    let names = keep.iter().map(|&i| t.images[i].file.clone()).collect();
    Run { report, aero: a, names, gcp_names, elapsed }
}

/// Self-calibration must explain the measurements better than the nominal lens: fewer rejected
/// as blunders, and a smaller horizontal GNSS misfit (the RMS of the kept measurements is not
/// comparable between runs that keep different sets).
fn better(fixed: &Run, sc: &Run) {
    // Debug builds use a tenth of the tracks: they check arithmetic (overflow), not accuracy.
    if cfg!(debug_assertions) {
        return;
    }
    let h = |r: &Run| {
        let g: Vec<[f64; 3]> = r.report.images.iter().filter_map(|i| i.gnss).collect();
        rms(&g.iter().map(|v| v[0].hypot(v[1])).collect::<Vec<_>>())
    };
    assert!(sc.report.converged && fixed.report.converged);
    assert!(sc.report.rejected.len() < fixed.report.rejected.len(), "rejected {} vs {}", sc.report.rejected.len(), fixed.report.rejected.len());
    assert!(h(sc) < h(fixed), "GNSS horizontal RMS {} vs {}", h(sc), h(fixed));
}

fn rms(v: &[f64]) -> f64 {
    (v.iter().map(|x| x * x).sum::<f64>() / v.len().max(1) as f64).sqrt()
}

/// Print and save a run: the summary line, the camera, the checks.
fn record(block: &str, r: &Run, cfg: &Cfg) -> Value {
    let rep = &r.report;
    let g: Vec<[f64; 3]> = rep.images.iter().filter_map(|i| i.gnss).collect();
    let grms = [0, 1, 2].map(|k| rms(&g.iter().map(|v| v[k]).collect::<Vec<_>>()));
    let cam = &rep.cameras[0];
    let checks: Vec<Value> = rep
        .checks
        .iter()
        .map(|c| {
            let name = r.gcp_names.iter().find(|(j, _)| *j == c.point).map(|x| x.1.clone()).unwrap_or_default();
            serde_json::json!({ "name": name, "d3": c.d3, "d2": c.d2, "px": c.image_px.iter().map(|(i, x, y)| serde_json::json!([r.names[*i], x, y])).collect::<Vec<_>>() })
        })
        .collect();
    eprintln!(
        "{block} [{}]: {} images, {} points, σ₀ {:.3}, RMS {:.3} px, {} rejected, {} iterations ({:.1} s); GNSS RMS E {:.2} N {:.2} U {:.2} m; f {:.4} mm x0 {:.4} y0 {:.4} k1 {:.3e} k2 {:.3e} k3 {:.3e} p1 {:.2e} p2 {:.2e}; checks single-ray RMSE_r {:.3} m (n {}), image {:?}",
        cfg.name,
        rep.images.len(),
        rep.points.iter().flatten().count(),
        rep.sigma0,
        rep.rms_px,
        rep.rejected.len(),
        rep.iterations,
        r.elapsed,
        grms[0],
        grms[1],
        grms[2],
        cam.io[0],
        cam.io[1],
        cam.io[2],
        cam.io[3],
        cam.io[4],
        cam.io[5],
        cam.io[7],
        cam.io[8],
        rep.checks_single.rmse_r,
        rep.checks_single.n,
        rep.checks_image
    );
    for c in &checks {
        eprintln!("    check {}: d2 {:?} d3 {:?} px {:?}", c["name"], c["d2"], c["d3"], c["px"]);
    }
    eprintln!("    converged {}; notes {:?}; weak (global correlation ≥ 0.99): {:?}", rep.converged, rep.notes, rep.weak.iter().map(|(p, g)| format!("{} {:.4}", IO_NAMES.get(p.which).unwrap_or(&"?"), g)).collect::<Vec<_>>());
    serde_json::json!({
        "block": block, "config": cfg.name, "images": rep.images.len(), "points": rep.points.iter().flatten().count(),
        "sigma0": rep.sigma0, "rmsPx": rep.rms_px, "rejected": rep.rejected.len(), "iterations": rep.iterations, "seconds": r.elapsed,
        "gnssRms": grms, "io": cam.io, "ioSigma": cam.sigma, "ioGlobal": cam.global, "free": cam.free,
        "checkSingle": [rep.checks_single.n, rep.checks_single.rmse[0], rep.checks_single.rmse[1], rep.checks_single.rmse_r],
        "checkMulti": [rep.checks_multi.n, rep.checks_multi.rmse[0], rep.checks_multi.rmse[1], rep.checks_multi.rmse[2]],
        "checkImage": [rep.checks_image.0, rep.checks_image.1, rep.checks_image.2],
        "checks": checks,
        "weak": rep.weak.iter().map(|(p, g)| serde_json::json!([format!("{:?}", p.kind), p.owner, p.which, g])).collect::<Vec<_>>(),
        "notes": rep.notes,
    })
}

/// The solved block for the OpenCV oracle: the camera, each image's EO (local frame) and its
/// used measurements with the adjusted points.
fn oracle_dump(block: &str, cfg: &str, r: &Run) {
    let a = &r.aero;
    let mut imgs = Vec::new();
    for i in 0..r.names.len() {
        let (c, rot) = a.eo(i);
        let mut m = Vec::new();
        for (k, o) in a.obs.iter().enumerate() {
            if o.image != i || !r.report.residuals[k].used {
                continue;
            }
            if let Some(x) = a.point(o.point) {
                m.push(serde_json::json!([o.x, o.y, x[0], x[1], x[2], r.report.residuals[k].weight]));
            }
        }
        imgs.push(serde_json::json!({ "file": r.names[i], "c": c, "r": rot, "obs": m }));
    }
    let cam = &a.cams[0];
    let v = serde_json::json!({ "block": block, "config": cfg, "pixelMm": cam.pixel_mm, "width": cam.width, "height": cam.height, "io": a.io(0), "images": imgs });
    std::fs::create_dir_all(OUT).ok();
    std::fs::write(format!("{OUT}/{block}-{cfg}-solution.json"), v.to_string()).unwrap();
}

fn save(block: &str, runs: Vec<Value>) {
    if cfg!(debug_assertions) {
        return;
    }
    std::fs::create_dir_all(OUT).ok();
    std::fs::write(format!("{OUT}/{block}.json"), serde_json::to_string_pretty(&runs).unwrap()).unwrap();
}

const SELFCAL: [usize; 8] = [0, 1, 2, 3, 4, 5, 7, 8];

fn base(name: &'static str) -> Cfg {
    Cfg { name, selfcal: Vec::new(), gnss: Some((5.0, 10.0)), nadir: true, geoid_n: 0.0, gcp_sigma: (0.05, 0.1), checks: Vec::new(), sigma_px: 1.0, max_reject: 20000, min_rays: 3, f_sigma: 0.0 }
}

#[test]
fn odm_aukerman_gnss_only() {
    let Some(t) = load("aukerman") else { return eprintln!("skipped: no ties for aukerman") };
    // EXIF GPS altitude (Sony): above mean sea level; EGM96 N = −34.46 m at the park.
    let mut t = t;
    for im in &mut t.images {
        if let Some(g) = &mut im.gps {
            g.h += -34.46;
        }
    }
    let fixed = run(&t, &[], &base("nominal camera"));
    let sc = run(&t, &[], &Cfg { selfcal: SELFCAL.to_vec(), ..base("self-calibration") });
    let a = record("aukerman", &fixed, &base("nominal camera"));
    let b = record("aukerman", &sc, &Cfg { selfcal: SELFCAL.to_vec(), ..base("self-calibration") });
    if !cfg!(debug_assertions) {
        oracle_dump("aukerman", "selfcal", &sc);
    }
    better(&fixed, &sc);
    save("aukerman", vec![a, b]);
}

#[test]
fn odm_seneca_gnss_only() {
    let Some(t) = load("seneca") else { return eprintln!("skipped: no ties for seneca") };
    let fixed = run(&t, &[], &base("nominal camera"));
    let sc = run(&t, &[], &Cfg { selfcal: SELFCAL.to_vec(), ..base("self-calibration") });
    let a = record("seneca", &fixed, &base("nominal camera"));
    let b = record("seneca", &sc, &Cfg { selfcal: SELFCAL.to_vec(), ..base("self-calibration") });
    if !cfg!(debug_assertions) {
        oracle_dump("seneca", "selfcal", &sc);
    }
    better(&fixed, &sc);
    save("seneca", vec![a, b]);
}

#[test]
fn odm_bellus_gcps_as_checks() {
    // Full-resolution SIFT (AERO_SCALE=1, 16 000 features): the half-resolution set links too few images.
    let Some(t) = load("bellus-full").or_else(|| load("bellus-gcp")) else { return eprintln!("skipped: no ties for bellus") };
    let g = gcps(&format!("{CORPUS}/frames-odm-bellus-gcp/gcp_list.txt"), 17, true);
    if g.is_empty() {
        return eprintln!("skipped: no Bellus GCP list");
    }
    // The GCP elevations read as orthometric (EGM96 N at the site, 41.2257 N 81.7025 W, from the
    // app's egm96-universal).
    let n = -34.28;
    // The senseFly EXIF altitude is above mean sea level (its GNSS heights disagree with the
    // photogrammetric scale by 25 m RMS read as ellipsoidal): + N.
    let mut t = t;
    for im in &mut t.images {
        if let Some(g) = &mut im.gps {
            g.h += n;
        }
    }
    let names: Vec<String> = g.iter().map(|x| x.0.clone()).collect();
    let mut out = Vec::new();
    // GNSS datum only: every GCP is a checkpoint; nominal lens, then self-calibration.
    for (label, sc) in [("GNSS datum, nominal camera", vec![]), ("GNSS datum, self-calibration", SELFCAL.to_vec())] {
        let cfg = Cfg { name: label, selfcal: sc, geoid_n: n, checks: names.clone(), ..base(label) };
        let r = run(&t, &g, &cfg);
        out.push(record("bellus", &r, &cfg));
        if label.contains("self") && !cfg!(debug_assertions) {
            oracle_dump("bellus", "selfcal", &r);
        }
    }
    // GCP datum, leave one out: three GCPs hold the block, the fourth is checked.
    for k in 0..names.len() {
        // GNSS σ 15 m / 30 m: approximations and a weak tie only, the GCPs hold the datum (the
        // GNSS-only runs show a common offset of about 10 m against the GCPs).
        let cfg = Cfg { name: "GCP datum (3), self-calibration, leave one out", selfcal: SELFCAL.to_vec(), geoid_n: n, checks: vec![names[k].clone()], gnss: Some((15.0, 30.0)), ..base("loo") };
        let r = run(&t, &g, &cfg);
        out.push(record("bellus", &r, &cfg));
    }
    save("bellus", out);
}

#[test]
fn odm_copr_gcp_datum() {
    let Some(t) = load("copr-gcp") else { return eprintln!("skipped: no ties for copr") };
    let g = gcps(&format!("{CORPUS}/frames-odm-copr-gcp/gcp_list.txt"), 11, true);
    if g.is_empty() || !Path::new(&format!("{CORPUS}/frames-odm-copr-gcp")).exists() {
        return eprintln!("skipped: no COPR GCP list");
    }
    // No GPS: the datum is the GCPs, horizontal only (the list's elevations are all 0). The
    // reserve's ground is taken as mean sea level ± 3 m (an assumption, stated in the note).
    let mut names: Vec<String> = g.iter().map(|x| x.0.clone()).collect();
    names.dedup();
    let mut out = Vec::new();
    for k in 0..names.len() {
        let cfg = Cfg { name: "GCP datum, self-calibration, leave one out", selfcal: SELFCAL.to_vec(), gnss: None, geoid_n: -35.61, gcp_sigma: (0.05, 3.0), checks: vec![names[k].clone()], min_rays: 3, f_sigma: 0.3, ..base("copr") };
        let r = std::panic::catch_unwind(|| run(&t, &g, &cfg));
        match r {
            Ok(r) => out.push(record("copr", &r, &cfg)),
            Err(e) => eprintln!("copr leave-out {}: {:?}", names[k], e.downcast_ref::<String>()),
        }
    }
    save("copr", out);
}
