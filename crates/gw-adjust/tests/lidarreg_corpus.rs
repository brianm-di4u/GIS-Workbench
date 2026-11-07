//! REQ-GAP-46 corpus validation (2.5 group lidarreg): image-to-LiDAR registration on the T&E corpus.
//!
//! Inputs come from `build/campaign/oracles/lidarreg.py prep` (image chips, DEM crops, surveyed
//! points) in D:/gwb25/data-lidarreg/work (override with GW_LIDARREG_WORK), and the LAZ tiles in
//! the corpus. Results and the dumps the oracles read go to <work>/harness.
//!
//! Heavy (147 M LAZ points): ignored by default; run in release:
//!   cargo test --release -p gw-adjust --test lidarreg_corpus -- --ignored --nocapture
//! It skips (passes) when the data is absent.

use gw_adjust::block::{adjust_joint, CloudObs, DatumIn, ImageIn, Joint, ObsIn, Options, PointIn, PointKind, Solution};
use gw_adjust::lidarreg::{hillshade, register, Chip, Frame, RefGrid, RegOptions, RegOut, Reference};
use gw_geodesy::grids::{utmups_forward, utmups_reverse};
use gw_pointcloud::decode::{decode, Columns, Lattice, RecordSpec};
use gw_pointcloud::grid::{fill, grid, GridSpec, Mode};
use gw_pointcloud::{las, laz};
use gw_sensor::adjusted::{Adjusted, BiasKind};
use gw_sensor::geotransform::{GeoTransformModel, MapCrs};
use gw_sensor::intersect::enu_partials;
use gw_sensor::rpc::Rpc;
use gw_sensor::{Ground, SensorModel};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Instant;

fn work() -> PathBuf {
    std::env::var("GW_LIDARREG_WORK").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("D:/gwb25/data-lidarreg/work"))
}

fn out_dir() -> PathBuf {
    let d = work().join("harness");
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn dump_f32(name: &str, v: &[f32]) {
    let b: Vec<u8> = v.iter().flat_map(|x| x.to_le_bytes()).collect();
    std::fs::write(out_dir().join(name), b).unwrap();
}

struct ChipData {
    px: Vec<f32>,
    meta: Value,
}

fn load(name: &str) -> Option<ChipData> {
    let m: Value = serde_json::from_str(&std::fs::read_to_string(work().join(format!("{name}.json"))).ok()?).ok()?;
    let b = std::fs::read(work().join(m["file"].as_str()?)).ok()?;
    let px = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    Some(ChipData { px, meta: m })
}

fn chip_of(c: &ChipData) -> Chip<'_> {
    Chip { px: &c.px, w: c.meta["w"].as_u64().unwrap() as usize, h: c.meta["h"].as_u64().unwrap() as usize, x0: c.meta["x0"].as_f64().unwrap(), y0: c.meta["y0"].as_f64().unwrap(), step: c.meta["step"].as_f64().unwrap() }
}

fn model_of(c: &ChipData) -> Rc<dyn SensorModel> {
    match c.meta["model"].as_str().unwrap() {
        "geotransform" => {
            let g: Vec<f64> = c.meta["gt"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            Rc::new(GeoTransformModel::new([g[0], g[1], g[2], g[3], g[4], g[5]], MapCrs::from_epsg(c.meta["epsg"].as_i64().unwrap() as i32).unwrap()).unwrap())
        }
        "rpc" => {
            let r: Vec<f64> = c.meta["rpc"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            Rc::new(Rpc::from_record(&r).unwrap())
        }
        m => panic!("model {m}"),
    }
}

/// The app's local frame at a UTM point (formats/las.js: kx = N cos φ π/180, ky = M π/180).
fn frame_at(zone: i32, e: f64, n: f64) -> Frame {
    let (lat0, lon0, _, _) = utmups_reverse(zone, true, e, n).unwrap();
    let (dlat, dlon) = gw_sensor::intersect::deg_per_metre(Ground { lat: lat0, lon: lon0, h: 0.0 });
    Frame { lat0, lon0, kx: 1.0 / dlon, ky: 1.0 / dlat }
}

/// Posts on multiples of `cell` covering a UTM box in the local frame.
fn grid_over(frame: &Frame, zone: i32, b: [f64; 4], cell: f64) -> GridSpec {
    let mut lo = (f64::INFINITY, f64::INFINITY);
    let mut hi = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for &(e, n) in &[(b[0], b[2]), (b[1], b[2]), (b[0], b[3]), (b[1], b[3])] {
        let (lat, lon, _, _) = utmups_reverse(zone, true, e, n).unwrap();
        let (x, y) = frame.local(Ground { lat, lon, h: 0.0 });
        lo = (lo.0.min(x), lo.1.min(y));
        hi = (hi.0.max(x), hi.1.max(y));
    }
    let e0 = (lo.0 / cell).ceil() * cell;
    let n0 = (hi.1 / cell).floor() * cell;
    GridSpec { e0, n0, ce: cell, cn: cell, w: ((hi.0 - e0) / cell).floor() as usize + 1, h: ((n0 - lo.1) / cell).floor() as usize + 1 }
}

/// A UTM → local lattice over a LAS tile (30 m nodes), heights unchanged (NAVD88 stays NAVD88).
fn lattice(frame: &Frame, zone: i32, h: &las::Header) -> Lattice {
    let (x0, y0) = (h.min[0] - 30.0, h.min[1] - 30.0);
    let (nx, ny) = (((h.max[0] - x0) / 30.0).ceil() as usize + 2, ((h.max[1] - y0) / 30.0).ceil() as usize + 2);
    let mut nodes = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        for i in 0..nx {
            let (lat, lon, _, _) = utmups_reverse(zone, true, x0 + i as f64 * 30.0, y0 + j as f64 * 30.0).unwrap();
            let (e, n) = frame.local(Ground { lat, lon, h: 0.0 });
            nodes.push([e, n, 0.0]);
        }
    }
    Lattice { x0, y0, dx: 30.0, dy: 30.0, nx, ny, nodes, v_unit: 1.0 }
}

/// Decode LAZ tiles in chunk runs through gw-pointcloud and grid each run (max height, mean
/// intensity, count), merged: the app's own decoder and rasteriser. Noise (7, 18) and withheld
/// points are left out, as `features/pointcloud.js` does for the DSM.
struct Grids {
    dsm: Vec<f32>,
    intensity: Vec<f32>,
    /// Mean height of the ground-classified (class 2) points, as the app's DTM.
    dtm: Vec<f32>,
    points: u64,
}

fn rasterise(files: &[PathBuf], frame: &Frame, zone: i32, g: &GridSpec, identity_utm: Option<(f64, f64)>) -> Grids {
    let cells = g.w * g.h;
    let mut dsm = vec![f32::NAN; cells];
    let mut isum = vec![0f64; cells];
    let mut icnt = vec![0f64; cells];
    let mut gsum = vec![0f64; cells];
    let mut gcnt = vec![0f64; cells];
    let mut total = 0u64;
    for f in files {
        let b = std::fs::read(f).unwrap();
        let h = las::header(&b).unwrap();
        let v = las::vlrs(&b, &h).unwrap();
        let zv = v.iter().find(|x| x.user_id == "laszip encoded" && x.record_id == 22204).expect("laszip VLR");
        let zvlr = laz::vlr(&b[zv.data_offset as usize..(zv.data_offset + zv.data_len) as usize]).unwrap();
        let po = h.point_offset as usize;
        let table_at = i64::from_le_bytes(b[po..po + 8].try_into().unwrap()) as usize;
        let table_end = if h.evlr_start > 0 { (h.evlr_start as usize).min(b.len()) } else { b.len() };
        let chunks = laz::chunk_table(&b[table_at..table_end], &zvlr, h.n_points).unwrap();
        let spec = RecordSpec { format: h.format, record_len: h.record_len as usize, scale: h.scale, offset: h.offset, t0: 0.0 };
        let lat = match identity_utm {
            Some((ox, oy)) => Lattice { x0: ox, y0: oy, dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[0.0, 0.0, 0.0], [1000.0, 0.0, 0.0], [0.0, 1000.0, 0.0], [1000.0, 1000.0, 0.0]], v_unit: 1.0 },
            None => lattice(frame, zone, &h),
        };
        let mut at = po + 8;
        for run in chunks.chunks(40) {
            let bytes: u64 = run.iter().map(|c| c.1).sum();
            let raw = laz::decode_chunks(&zvlr, &b[at..at + bytes as usize], run).unwrap();
            at += bytes as usize;
            let mut cols = Columns::with_capacity(raw.len() / spec.record_len, false);
            decode(&raw, &spec, &lat, &mut cols);
            total += cols.n as u64;
            let mask: Vec<u8> = (0..cols.n).map(|k| u8::from(cols.class[k] != 7 && cols.class[k] != 18 && cols.flags[k] & 4 == 0)).collect();
            let inten: Vec<f32> = cols.intensity.iter().map(|v| f32::from(*v)).collect();
            let mx = grid(&cols.pos, Some(&mask), None, g, Mode::Max);
            let mv = grid(&cols.pos, Some(&mask), Some(&inten), g, Mode::MeanValue);
            let dn = grid(&cols.pos, Some(&mask), None, g, Mode::Density);
            let gmask: Vec<u8> = (0..cols.n).map(|k| u8::from(cols.class[k] == 2 && cols.flags[k] & 4 == 0)).collect();
            let gm = grid(&cols.pos, Some(&gmask), None, g, Mode::Mean);
            let gd = grid(&cols.pos, Some(&gmask), None, g, Mode::Density);
            let area = g.ce * g.cn;
            for q in 0..cells {
                if mx[q].is_finite() && (dsm[q].is_nan() || mx[q] > dsm[q]) {
                    dsm[q] = mx[q];
                }
                let c = f64::from(dn[q]) * area;
                if c > 0.5 {
                    isum[q] += f64::from(mv[q]) * c;
                    icnt[q] += c;
                }
                let c = f64::from(gd[q]) * area;
                if c > 0.5 {
                    gsum[q] += f64::from(gm[q]) * c;
                    gcnt[q] += c;
                }
            }
        }
    }
    let mean = |s: &[f64], c: &[f64]| -> Vec<f32> { (0..cells).map(|q| if c[q] > 0.0 { (s[q] / c[q]) as f32 } else { f32::NAN }).collect() };
    Grids { dsm, intensity: mean(&isum, &icnt), dtm: mean(&gsum, &gcnt), points: total }
}

/// A DEM crop (UTM, `gt`) resampled onto the local posts (bilinear), plus `dz`.
fn dem_on_grid(d: &ChipData, frame: &Frame, zone: i32, g: &GridSpec, dz: f64) -> Vec<f32> {
    let gt: Vec<f64> = d.meta["gt"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let (w, h) = (d.meta["w"].as_u64().unwrap() as usize, d.meta["h"].as_u64().unwrap() as usize);
    let mut out = vec![f32::NAN; g.w * g.h];
    for j in 0..g.h {
        for i in 0..g.w {
            let gr = frame.ground(g.e0 + i as f64 * g.ce, g.n0 - j as f64 * g.cn, 0.0);
            let u = utmups_forward(gr.lat, gr.lon, Some(zone)).unwrap();
            // Pixel centres at integer + 0.5 → post index.
            let fx = (u.easting - gt[0]) / gt[1] - 0.5;
            let fy = (u.northing - gt[3]) / gt[5] - 0.5;
            let v = gw_adjust::lidarreg::bilinear(&d.px, w, h, fx, fy);
            if v.is_finite() && v > -1000.0 {
                out[j * g.w + i] = (v + dz) as f32;
            }
        }
    }
    out
}

/// The image model in error by (de, dn) metres: it maps a ground point to where the given model
/// maps the point (de, dn) away, so it shows every feature (−de, −dn) from its true place.
struct Offset {
    inner: Rc<dyn SensorModel>,
    de: f64,
    dn: f64,
}
impl Offset {
    fn mv(&self, g: Ground, s: f64) -> Ground {
        let (dlat, dlon) = gw_sensor::intersect::deg_per_metre(g);
        Ground { lat: g.lat + s * self.dn * dlat, lon: g.lon + s * self.de * dlon, h: g.h }
    }
}
impl SensorModel for Offset {
    fn name(&self) -> &str {
        "offset"
    }
    fn ground_to_image(&self, g: Ground) -> gw_abi::Result<(f64, f64)> {
        self.inner.ground_to_image(self.mv(g, 1.0))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> gw_abi::Result<Ground> {
        Ok(self.mv(self.inner.image_to_ground(x, y, h)?, -1.0))
    }
    fn is_3d(&self) -> bool {
        self.inner.is_3d()
    }
}

struct Run {
    reg: Vec<(Reference, RegOut)>,
    sol: Solution,
    t_ortho_match: f64,
    t_adjust: f64,
    points: Vec<PointIn>,
    obs: Vec<ObsIn>,
}

/// Register (each reference with its own chip), build the block and solve.
#[allow(clippy::too_many_arguments)]
fn run(model: Rc<dyn SensorModel>, g: &RefGrid<'_>, chips: &[(Reference, &Chip<'_>)], opts: &RegOptions, kind: BiasKind, datum: DatumIn, cloud: Vec<CloudObs>, prior_px: f64) -> Result<Run, String> {
    let t0 = Instant::now();
    let mut reg = Vec::new();
    for (r, c) in chips {
        let o = RegOptions { reference: *r, ..opts.clone() };
        match register(&*model, g, c, &o) {
            Ok(x) => reg.push((*r, x)),
            Err(e) => eprintln!("  {r:?}: {}", e.msg),
        }
    }
    if reg.is_empty() {
        return Err("no reference matched".into());
    }
    let t_ortho_match = t0.elapsed().as_secs_f64();
    let mut points = Vec::new();
    let mut obs = Vec::new();
    // Image σ: half a grid cell in image pixels.
    let gc = g.frame.ground(g.e0 + g.cell * g.w as f64 / 2.0, g.n0 - g.cell * g.h as f64 / 2.0, 0.0);
    let jp = enu_partials(&*model, Ground { h: f64::from(g.dsm[g.w * g.h / 2 + g.w / 2]).max(0.0), ..gc }).unwrap();
    let px_per_m = (jp[0][0].hypot(jp[0][1]) + jp[1][0].hypot(jp[1][1])) / 2.0;
    let sigma_px = 0.5 * g.cell * px_per_m;
    for (_, r) in &reg {
        for m in r.matches.iter().filter(|m| m.inlier) {
            let known = g.frame.ground(m.e, m.n, m.z);
            points.push(PointIn { kind: if m.check { PointKind::LidarCheck } else { PointKind::Lidar }, known: Some(known), sigma_h: 0.3, sigma_v: 0.5 });
            obs.push(ObsIn { image: 0, point: points.len() - 1, x: m.x, y: m.y, sigma_px });
        }
    }
    let (cx, cy) = (g.frame.ground(0.0, 0.0, 0.0), ());
    let _ = cy;
    let half = (5000.0, 5000.0);
    let images = vec![ImageIn { model: model.clone(), kind, fixed: false, centre: model.ground_to_image(Ground { h: 0.0, ..cx }).map(|p| (p.0, p.1)).unwrap_or((0.0, 0.0)), half, prior_sigma_px: prior_px, params: false, prior_cov: None }];
    let t1 = Instant::now();
    let sol = adjust_joint(&images, &points, &obs, &Joint { datum, cloud }, &Options { max_reject: 0, ..Options::default() }).map_err(|e| e.msg)?;
    Ok(Run { reg, sol, t_ortho_match, t_adjust: t1.elapsed().as_secs_f64(), points, obs })
}

fn adjusted(model: &Rc<dyn SensorModel>, s: &Solution, centre: (f64, f64)) -> Adjusted {
    let mut b = s.biases[0].clone();
    b.centre = centre;
    Adjusted { base: model.clone(), bias: b, sigma: None, name: "adjusted".into() }
}

/// RMS and max ground difference (m) between two models over a 9 × 9 set of points of the grid.
fn model_diff(a: &dyn SensorModel, b: &dyn SensorModel, g: &RefGrid<'_>) -> (f64, f64) {
    let (mut ss, mut mx, mut n) = (0.0, 0.0f64, 0);
    for j in 1..10 {
        for i in 1..10 {
            let (pi, pj) = (g.w as f64 * i as f64 / 10.0, g.h as f64 * j as f64 / 10.0);
            let z = g.dsm_at(pi, pj);
            if !z.is_finite() {
                continue;
            }
            let (e, nn) = g.post(pi, pj);
            let gr = g.frame.ground(e, nn, z);
            let (Ok(pa), Ok(pb)) = (a.ground_to_image(gr), b.ground_to_image(gr)) else { continue };
            let jp = enu_partials(a, gr).unwrap();
            let det = jp[0][0] * jp[1][1] - jp[0][1] * jp[1][0];
            let (vx, vy) = (pb.0 - pa.0, pb.1 - pa.1);
            let de = (jp[1][1] * vx - jp[0][1] * vy) / det;
            let dn = (-jp[1][0] * vx + jp[0][0] * vy) / det;
            let d = de.hypot(dn);
            ss += d * d;
            mx = mx.max(d);
            n += 1;
        }
    }
    ((ss / n.max(1) as f64).sqrt(), mx)
}

fn stats_json(s: &gw_adjust::block::AxisStats) -> Value {
    json!({ "n": s.n, "rmseE": s.rmse[0], "rmseN": s.rmse[1], "rmseR": s.rmse_r, "rmseU": s.rmse[2], "ce90": s.ce90, "maxE": s.max[0], "maxN": s.max[1], "maxU": s.max[2] })
}

fn summary(r: &Run, model: &Rc<dyn SensorModel>, g: &RefGrid<'_>) -> Value {
    let s = &r.sol;
    let regs: Vec<Value> = r.reg.iter().map(|(k, x)| json!({ "reference": format!("{k:?}"), "tiles": x.tiles, "accepted": x.accepted, "inliers": x.inliers, "coarseE": x.coarse.0, "coarseN": x.coarse.1, "sunAz": x.sun_az, "ransacRmsM": x.rms_m, "affine": x.affine })).collect();
    // Bias in ground metres at the grid centre.
    let un = Adjusted { base: model.clone(), bias: gw_sensor::adjusted::ImageBias::zero((0.0, 0.0), (1.0, 1.0)), sigma: None, name: "u".into() };
    let adj = adjusted(model, s, s.biases[0].centre);
    let (rms, mx) = model_diff(&un, &adj, g);
    json!({
        "registration": regs,
        "controlPoints": r.points.iter().filter(|p| p.kind == PointKind::Lidar).count(),
        "heldOut": r.points.iter().filter(|p| p.kind == PointKind::LidarCheck).count(),
        "observations": r.obs.len(),
        "sigma0": s.sigma0, "dof": s.dof, "iterations": s.iterations, "converged": s.converged,
        "bias": s.biases[0].c, "biasCov": s.bias_cov[0],
        "correctionRmsM": rms, "correctionMaxM": mx,
        "datum": s.datum, "datumCov": s.datum_cov,
        "heldOutBefore": stats_json(&s.lidar_checks_before), "heldOutAfter": stats_json(&s.lidar_checks_after),
        "cloudChecksBefore": stats_json(&s.cloud_checks_before), "cloudChecksAfter": stats_json(&s.cloud_checks_after),
        "cloud": s.cloud,
        "secondsOrthoMatch": r.t_ortho_match, "secondsAdjust": r.t_adjust,
    })
}

/// Surveyed points on the cloud: NGS marks (orthometric heights, NAVD88) against the grid surface.
fn cloud_obs(marks: &[Value], g: &RefGrid<'_>, zone: i32, surface: &[f32], check_every: usize) -> Vec<(String, CloudObs)> {
    let mut out = Vec::new();
    for (k, m) in marks.iter().enumerate() {
        let (lat, lon) = utmups_reverse(zone, true, m["e"].as_f64().unwrap(), m["n"].as_f64().unwrap()).map(|r| (r.0, r.1)).unwrap();
        let (e, n) = g.frame.local(Ground { lat, lon, h: 0.0 });
        let (fi, fj) = ((e - g.e0) / g.cell, (g.n0 - n) / g.cell);
        let z = gw_adjust::lidarreg::bilinear(surface, g.w, g.h, fi, fj);
        if !z.is_finite() {
            continue;
        }
        let ge = (gw_adjust::lidarreg::bilinear(surface, g.w, g.h, fi + 1.0, fj) - gw_adjust::lidarreg::bilinear(surface, g.w, g.h, fi - 1.0, fj)) / (2.0 * g.cell);
        let gn = (gw_adjust::lidarreg::bilinear(surface, g.w, g.h, fi, fj - 1.0) - gw_adjust::lidarreg::bilinear(surface, g.w, g.h, fi, fj + 1.0)) / (2.0 * g.cell);
        let oh = m["orthoHt"].as_f64().unwrap();
        let (ge, gn) = (if ge.is_finite() { ge } else { 0.0 }, if gn.is_finite() { gn } else { 0.0 });
        // σ: the height (leveled 2 cm, otherwise 15 cm), the surface (10 cm), and the mark's
        // horizontal uncertainty times the slope (SCALED positions, read off maps: 100 m; adjusted: 5 cm).
        let sv = if m["vertSource"].as_str().unwrap_or("").contains("ADJUSTED") { 0.02 } else { 0.15 };
        let sh = if m["posSource"].as_str().unwrap_or("").contains("SCALED") { 100.0 } else { 0.05 };
        let sigma = (sv * sv + 0.01 + (ge * ge + gn * gn) * sh * sh).sqrt();
        out.push((m["id"].as_str().unwrap().to_string(), CloudObs { truth: Ground { lat, lon, h: oh }, z_cloud: z, grad: (ge, gn), sigma, check: check_every > 0 && k % check_every == check_every - 1 }));
    }
    out
}

/// Robustness: inject offsets of 5–30 m in four directions and compare the adjusted model with the
/// adjusted model of the run without an injected offset.
fn robustness(model: &Rc<dyn SensorModel>, g: &RefGrid<'_>, chips: &[(Reference, &Chip<'_>)], opts: &RegOptions, base: &Run) -> Value {
    let base_adj = adjusted(model, &base.sol, base.sol.biases[0].centre);
    let mut rows = Vec::new();
    for &mag in &[5.0, 10.0, 20.0, 30.0] {
        for &dir in &[45.0f64, 135.0, 225.0, 315.0] {
            let (de, dn) = (mag * dir.to_radians().sin(), mag * dir.to_radians().cos());
            let m: Rc<dyn SensorModel> = Rc::new(Offset { inner: model.clone(), de, dn });
            let t = Instant::now();
            match run(m.clone(), g, chips, opts, BiasKind::Shift, DatumIn::default(), Vec::new(), 0.0) {
                Ok(r) => {
                    let adj = adjusted(&m, &r.sol, r.sol.biases[0].centre);
                    let (rms, mx) = model_diff(&base_adj, &adj, g);
                    let inl: usize = r.reg.iter().map(|x| x.1.inliers).sum();
                    rows.push(json!({ "offsetM": mag, "azimuth": dir, "ok": rms < 1.0, "vsBaselineRmsM": rms, "vsBaselineMaxM": mx, "inliers": inl, "heldOutAfterRmseR": r.sol.lidar_checks_after.rmse_r, "seconds": t.elapsed().as_secs_f64() }));
                }
                Err(e) => rows.push(json!({ "offsetM": mag, "azimuth": dir, "ok": false, "error": e, "seconds": t.elapsed().as_secs_f64() })),
            }
            eprintln!("  offset {mag} m az {dir}: {}", rows.last().unwrap());
        }
    }
    Value::Array(rows)
}

fn have(p: &Path) -> bool {
    p.exists()
}

#[test]
#[ignore = "corpus validation: 147 M LAZ points; run in release with --ignored"]
fn lidarreg_corpus() {
    let cases: Value = match std::fs::read_to_string(work().join("cases.json")) {
        Ok(t) => serde_json::from_str(&t).unwrap(),
        Err(_) => {
            eprintln!("lidarreg work data absent ({}); run build/campaign/oracles/lidarreg.py prep. Skipped.", work().display());
            return;
        }
    };
    let mut results = serde_json::Map::new();
    let opts = RegOptions { max_offset_m: 40.0, ..RegOptions::default() };

    // ---- 1. DRCOG 2020 LAZ 2 × 2 with NAIP 2023 (NIR to intensity, RGB to hillshade) ----
    let c = &cases["drcog"];
    let files: Vec<PathBuf> = c["laz"].as_array().unwrap().iter().map(|v| PathBuf::from(v.as_str().unwrap())).collect();
    if files.iter().all(|f| have(f)) {
        let (nir, rgb) = (load("drcog_naip_nir").unwrap(), load("drcog_naip_rgb").unwrap());
        let frame = frame_at(13, 475000.0, 4417000.0);
        let b = [474000.0, 476000.0, 4416000.0, 4418000.0];
        let gs = grid_over(&frame, 13, b, 0.6);
        let t = Instant::now();
        let Grids { mut dsm, intensity: mut inten, mut dtm, points: n } = rasterise(&files, &frame, 13, &gs, None);
        let t_decode = t.elapsed().as_secs_f64();
        let holes = dsm.iter().filter(|v| v.is_nan()).count();
        fill(&mut dsm, gs.w, gs.h, 300);
        fill(&mut inten, gs.w, gs.h, 50);
        fill(&mut dtm, gs.w, gs.h, 800);
        eprintln!("DRCOG: {n} points → {} × {} posts at 0.6 m ({holes} holes filled) in {t_decode:.1} s", gs.w, gs.h);
        let g = RefGrid { frame, e0: gs.e0, n0: gs.n0, cell: 0.6, w: gs.w, h: gs.h, dsm: &dsm, intensity: Some(&inten) };
        let model = model_of(&nir);
        let (cn, cr) = (chip_of(&nir), chip_of(&rgb));
        let chips = [(Reference::Intensity, &cn), (Reference::Hillshade, &cr)];
        // Hillshade dump for the gdaldem oracle (a 1024² window), and the DSM.
        {
            let (w0, h0, s) = (1024usize, 1024usize, 1000usize);
            let sub: Vec<f32> = (0..w0 * h0).map(|k| dsm[(s + k / w0) * gs.w + s + k % w0]).collect();
            let hs = hillshade(&sub, w0, h0, 0.6, 135.0, 45.0);
            dump_f32("hs_dsm.f32", &sub);
            dump_f32("hs_ours.f32", &hs);
            std::fs::write(out_dir().join("hillshade.json"), json!({ "w": w0, "h": h0, "cell": 0.6, "az": 135.0, "el": 45.0, "dsm": "hs_dsm.f32", "hs": "hs_ours.f32" }).to_string()).unwrap();
        }
        let marks = c["ngs"].as_array().unwrap().clone();
        let co = cloud_obs(&marks, &g, 13, &dtm, 0);
        eprintln!("DRCOG NGS marks on the cloud: {:?}", co.iter().map(|(id, o)| (id.clone(), o.truth.h - o.z_cloud)).collect::<Vec<_>>());
        let base = run(model.clone(), &g, &chips, &opts, BiasKind::Shift, DatumIn::default(), co.iter().map(|x| x.1).collect(), 0.0).expect("DRCOG baseline");
        let mut v = summary(&base, &model, &g);
        v["points"] = json!(n);
        v["posts"] = json!([gs.w, gs.h]);
        v["holesFilled"] = json!(holes);
        v["secondsDecodeGrid"] = json!(t_decode);
        v["ngsMarks"] = json!(co.iter().map(|(id, o)| json!({ "id": id, "truthMinusCloud": o.truth.h - o.z_cloud, "slope": [o.grad.0, o.grad.1], "sigma": o.sigma })).collect::<Vec<_>>());
        v["usgsCheckpointsInside"] = c["usgsCheckpointsInside"].clone();
        eprintln!("DRCOG baseline: {}", v);
        // Affine bias for comparison.
        if let Ok(a) = run(model.clone(), &g, &chips, &opts, BiasKind::Affine, DatumIn::default(), Vec::new(), 0.0) {
            v["affine"] = summary(&a, &model, &g);
        }
        // Joint with a 3-parameter datum shift: σ 1 m horizontal, 0.5 m vertical, NGS marks as cloud control.
        let d3 = DatumIn { k: 3, centre: Some(frame.ground(0.0, 0.0, 2000.0)), prior_sigma: vec![1.0, 1.0, 0.5] };
        if let Ok(j) = run(model.clone(), &g, &chips, &opts, BiasKind::Shift, d3, co.iter().map(|x| x.1).collect(), 30.0) {
            v["datum3"] = summary(&j, &model, &g);
            dump_adjust(&j, &nir, &co.iter().map(|x| x.1).collect::<Vec<_>>(), 30.0, [1.0, 1.0, 0.5]);
        }
        // Dumps: phase-correlation tile pairs for the OpenCV oracle and one adjustment for SciPy.
        dump_oracles(&model, &g, &cn, &base);
        v["robustness"] = robustness(&model, &g, &chips, &opts, &base);
        results.insert("drcog".into(), v);

        // Grid oracle: one tile in UTM posts (identity frame) for PDAL.
        let f0 = &files[0];
        let hd = las::header(&std::fs::read(f0).unwrap()).unwrap();
        let (ox, oy) = (hd.min[0].floor(), hd.min[1].floor());
        let gu = GridSpec { e0: 0.5, n0: (hd.max[1] - oy).floor() - 0.5, ce: 1.0, cn: 1.0, w: (hd.max[0] - ox).floor() as usize, h: (hd.max[1] - oy).floor() as usize };
        let gr = rasterise(std::slice::from_ref(f0), &frame, 13, &gu, Some((ox, oy)));
        dump_f32("grid_max.f32", &gr.dsm);
        dump_f32("grid_int.f32", &gr.intensity);
        std::fs::write(out_dir().join("grid_utm.json"), json!({ "laz": f0.to_string_lossy(), "w": gu.w, "h": gu.h, "cell": 1.0, "e0": ox + gu.e0, "n0": oy + gu.n0, "max": "grid_max.f32", "intensity": "grid_int.f32" }).to_string()).unwrap();

        // ---- 2. SoPlatte 2013 (sparser, other epoch) on the same block and image ----
        let sp: Vec<PathBuf> = c["lazSoPlatte"].as_array().unwrap().iter().map(|v| PathBuf::from(v.as_str().unwrap())).collect();
        if sp.iter().all(|f| have(f)) {
            let gs2 = grid_over(&frame, 13, b, 1.0);
            let t = Instant::now();
            let Grids { dsm: mut dsm2, intensity: mut int2, dtm: mut dtm2, points: n2 } = rasterise(&sp, &frame, 13, &gs2, None);
            let t2 = t.elapsed().as_secs_f64();
            let holes2 = dsm2.iter().filter(|v| v.is_nan()).count();
            fill(&mut dsm2, gs2.w, gs2.h, 300);
            fill(&mut int2, gs2.w, gs2.h, 50);
            fill(&mut dtm2, gs2.w, gs2.h, 800);
            eprintln!("SoPlatte: {n2} points → {} × {} posts at 1 m ({holes2} holes) in {t2:.1} s", gs2.w, gs2.h);
            let g2 = RefGrid { frame, e0: gs2.e0, n0: gs2.n0, cell: 1.0, w: gs2.w, h: gs2.h, dsm: &dsm2, intensity: Some(&int2) };
            match run(model.clone(), &g2, &chips, &opts, BiasKind::Shift, DatumIn::default(), cloud_obs(&marks, &g2, 13, &dtm2, 0).into_iter().map(|x| x.1).collect(), 0.0) {
                Ok(r2) => {
                    let mut v2 = summary(&r2, &model, &g2);
                    v2["points"] = json!(n2);
                    v2["secondsDecodeGrid"] = json!(t2);
                    // The NAIP corrections from the two lidar epochs, compared over the block.
                    let a1 = adjusted(&model, &base.sol, base.sol.biases[0].centre);
                    let a2 = adjusted(&model, &r2.sol, r2.sol.biases[0].centre);
                    let (rms, mx) = model_diff(&a1, &a2, &g2);
                    v2["vsDrcogCorrectionRmsM"] = json!(rms);
                    v2["vsDrcogCorrectionMaxM"] = json!(mx);
                    // Independent checkpoints: the matches to the other survey (2013 lidar, other
                    // contractor and epoch) held out of a solve controlled by the 2020 cloud, and the reverse.
                    v2["independent"] = json!({
                        "drcogControlSoplatteChecks": cross_checks(&model, &base, &r2),
                        "soplatteControlDrcogChecks": cross_checks(&model, &r2, &base),
                    });
                    eprintln!("SoPlatte: {}", v2);
                    results.insert("soplatte".into(), v2);
                }
                Err(e) => {
                    results.insert("soplatte".into(), json!({ "error": e }));
                }
            }
        }
    } else {
        eprintln!("DRCOG LAZ absent; skipped");
    }

    // ---- 3. Golden x48y441: 1 m DEM (hillshade only) with NAIP ----
    if let (Some(dem), Some(rgb)) = (load("golden_dem"), load("golden_naip_rgb")) {
        let c = &cases["golden"];
        let b: Vec<f64> = c["box"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let frame = frame_at(13, (b[0] + b[1]) / 2.0, (b[2] + b[3]) / 2.0);
        let gs = grid_over(&frame, 13, [b[0] + 50.0, b[1] - 50.0, b[2] + 50.0, b[3] - 50.0], 1.0);
        let z = dem_on_grid(&dem, &frame, 13, &gs, 0.0);
        let g = RefGrid { frame, e0: gs.e0, n0: gs.n0, cell: 1.0, w: gs.w, h: gs.h, dsm: &z, intensity: None };
        let model = model_of(&rgb);
        let cr = chip_of(&rgb);
        let chips = [(Reference::Hillshade, &cr)];
        let marks = c["ngs"].as_array().unwrap().clone();
        let co = cloud_obs(&marks, &g, 13, &z, 2);
        match run(model.clone(), &g, &chips, &opts, BiasKind::Shift, DatumIn::default(), co.iter().map(|x| x.1).collect(), 0.0) {
            Ok(r) => {
                let mut v = summary(&r, &model, &g);
                v["ngsMarks"] = json!(co.iter().map(|(id, o)| json!({ "id": id, "truthMinusCloud": o.truth.h - o.z_cloud, "check": o.check })).collect::<Vec<_>>());
                let d3 = DatumIn { k: 3, centre: Some(frame.ground(0.0, 0.0, 1800.0)), prior_sigma: vec![1.0, 1.0, 0.5] };
                if let Ok(j) = run(model.clone(), &g, &chips, &opts, BiasKind::Shift, d3, co.iter().map(|x| x.1).collect(), 30.0) {
                    v["datum3"] = summary(&j, &model, &g);
                }
                v["robustness"] = robustness(&model, &g, &chips, &opts, &r);
                eprintln!("Golden: {}", v);
                results.insert("golden".into(), v);
            }
            Err(e) => {
                results.insert("golden".into(), json!({ "error": e }));
            }
        }
    }

    // ---- 4. Las Vegas: WV-3 PAN (RPC) with the 1 m DEM (hillshade only, bare earth) ----
    if let (Some(dem), Some(pan)) = (load("vegas_dem"), load("vegas_wv3_pan")) {
        let c = &cases["vegas"];
        let b: Vec<f64> = c["box"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let frame = frame_at(11, (b[0] + b[1]) / 2.0, (b[2] + b[3]) / 2.0);
        let gs = grid_over(&frame, 11, [b[0] + 50.0, b[1] - 50.0, b[2] + 50.0, b[3] - 50.0], 1.0);
        // NAVD88 → HAE with the mean GEOID18 undulation of the NGS marks around the area.
        let n_geoid = dem.meta["geoidN"].as_f64().unwrap_or(0.0);
        let z = dem_on_grid(&dem, &frame, 11, &gs, n_geoid);
        let g = RefGrid { frame, e0: gs.e0, n0: gs.n0, cell: 1.0, w: gs.w, h: gs.h, dsm: &z, intensity: None };
        let model = model_of(&pan);
        let cp = chip_of(&pan);
        let chips = [(Reference::Hillshade, &cp)];
        match run(model.clone(), &g, &chips, &opts, BiasKind::Shift, DatumIn::default(), Vec::new(), 0.0) {
            Ok(r) => {
                let mut v = summary(&r, &model, &g);
                v["geoidN"] = json!(n_geoid);
                v["robustness"] = robustness(&model, &g, &chips, &opts, &r);
                eprintln!("Vegas: {}", v);
                results.insert("vegas".into(), v);
            }
            Err(e) => {
                eprintln!("Vegas: {e}");
                results.insert("vegas".into(), json!({ "error": e, "geoidN": n_geoid }));
            }
        }
    }
    std::fs::write(out_dir().join("results.json"), serde_json::to_string_pretty(&Value::Object(results)).unwrap()).unwrap();
}

/// Solve with the control of `control` and hold out every inlier match of `checks` (another
/// survey of the same ground, in the same frame): the before/after statistics of those checks.
fn cross_checks(model: &Rc<dyn SensorModel>, control: &Run, checks: &Run) -> Value {
    let mut points: Vec<PointIn> = control.points.iter().map(|p| PointIn { kind: if p.kind == PointKind::LidarCheck { PointKind::Lidar } else { p.kind }, ..*p }).collect();
    let mut obs = control.obs.clone();
    let first = obs.len();
    for (p, o) in checks.points.iter().zip(&checks.obs) {
        points.push(PointIn { kind: PointKind::LidarCheck, ..*p });
        obs.push(ObsIn { point: points.len() - 1, ..*o });
    }
    let im = ImageIn { model: model.clone(), kind: BiasKind::Shift, fixed: false, centre: (0.0, 0.0), half: (5000.0, 5000.0), prior_sigma_px: 0.0, params: false, prior_cov: None };
    match adjust_joint(&[im], &points, &obs, &Joint::default(), &Options { max_reject: 0, ..Options::default() }) {
        Ok(s) => {
            let mine: Vec<_> = s.lidar_checks.iter().filter(|c| c.0 >= first).collect();
            let st = |after: bool| {
                let d: Vec<[f64; 2]> = mine.iter().map(|c| if after { c.2 } else { c.1 }).collect();
                let n = d.len().max(1) as f64;
                let (e, nn) = (d.iter().map(|v| v[0] * v[0]).sum::<f64>() / n, d.iter().map(|v| v[1] * v[1]).sum::<f64>() / n);
                let mean = (d.iter().map(|v| v[0]).sum::<f64>() / n, d.iter().map(|v| v[1]).sum::<f64>() / n);
                json!({ "n": d.len(), "rmseE": e.sqrt(), "rmseN": nn.sqrt(), "rmseR": (e + nn).sqrt(), "meanE": mean.0, "meanN": mean.1, "ce90": 1.5175 * (e + nn).sqrt() })
            };
            json!({ "before": st(false), "after": st(true) })
        }
        Err(e) => json!({ "error": e.msg }),
    }
}

/// The observations of a joint solve (2-D ortho, 3-parameter datum) in UTM for the SciPy oracle.
fn dump_adjust(r: &Run, chip: &ChipData, cloud: &[CloudObs], prior_px: f64, prior_datum: [f64; 3]) {
    let gt: Vec<f64> = chip.meta["gt"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let mut pts = Vec::new();
    for o in &r.obs {
        let p = &r.points[o.point];
        if p.kind != PointKind::Lidar {
            continue;
        }
        let k = p.known.unwrap();
        let u = utmups_forward(k.lat, k.lon, Some(13)).unwrap();
        pts.push(json!({ "E": u.easting, "N": u.northing, "U": k.h, "x": o.x, "y": o.y, "sx": o.sigma_px, "sh": p.sigma_h, "sv": p.sigma_v }));
    }
    let cl: Vec<Value> = cloud.iter().filter(|c| !c.check).map(|c| json!({ "z": c.z_cloud, "h": c.truth.h, "gE": c.grad.0, "gN": c.grad.1, "s": c.sigma })).collect();
    let s = &r.sol;
    let ours = json!({ "bias": [s.biases[0].c[3], s.biases[0].c[0]], "datum": s.datum, "sigma0": s.sigma0, "datumSigma": (0..3).map(|m| s.datum_cov[m * 4].sqrt()).collect::<Vec<_>>() });
    std::fs::write(out_dir().join("adjust_case.json"), json!({ "gt": gt, "points": pts, "cloud": cl, "priorPx": prior_px, "priorDatum": prior_datum, "ours": ours }).to_string()).unwrap();
}

/// Tile pairs (reference, image on the grid) at the found integer offsets for the OpenCV oracle,
/// and the baseline's observations for the SciPy oracle (2-D ortho, 3-parameter datum).
fn dump_oracles(model: &Rc<dyn SensorModel>, g: &RefGrid<'_>, chip: &Chip<'_>, base: &Run) {
    use gw_match::phase::phase_correlate;
    use gw_match::Win;
    let img = gw_adjust::lidarreg::ortho_on_grid(&**model, g, chip, 16).unwrap();
    let rf = gw_adjust::lidarreg::clip_percentiles(g.intensity.unwrap());
    let n = 64usize;
    let (mut a, mut b, mut shifts) = (Vec::new(), Vec::new(), Vec::new());
    let (_, r) = &base.reg[0];
    for m in r.matches.iter().filter(|m| m.inlier && m.source == 0).take(60) {
        let ic = (m.e - g.e0) / g.cell;
        let jc = (g.n0 - m.n) / g.cell;
        let (i0, j0) = ((ic - 31.5).round() as i64, (jc - 31.5).round() as i64);
        let (ox, oy) = ((m.de / g.cell).round() as i64, (-m.dn / g.cell).round() as i64);
        let cut = |v: &[f32], x0: i64, y0: i64| -> Option<Vec<f32>> {
            if x0 < 0 || y0 < 0 || x0 as usize + n > g.w || y0 as usize + n > g.h {
                return None;
            }
            Some((0..n * n).map(|k| v[(y0 as usize + k / n) * g.w + x0 as usize + k % n]).collect())
        };
        let (Some(wa), Some(wb)) = (cut(&rf, i0, j0), cut(&img, i0 + ox, j0 + oy)) else { continue };
        if let Some(p) = phase_correlate(Win { w: n, h: n, px: &wa }, Win { w: n, h: n, px: &wb }) {
            shifts.push(json!([p.dx, p.dy, p.peak]));
            a.extend_from_slice(&wa);
            b.extend_from_slice(&wb);
        }
    }
    dump_f32("phase_a.f32", &a);
    dump_f32("phase_b.f32", &b);
    // Known shifts on the same real tiles: b = a moved by s through the shift theorem (periodic),
    // for the truth comparison of both estimators.
    let (mut ka, mut kb, mut truth, mut ours) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut seed = 0x51ed_270b_0f3a_9c7du64;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    for t0 in a.chunks_exact(n * n).take(40) {
        let (sx, sy) = (6.0 * rnd() - 3.0, 6.0 * rnd() - 3.0);
        let m: f64 = t0.iter().map(|v| f64::from(*v)).sum::<f64>() / (n * n) as f64;
        let (mut re, mut im): (Vec<f64>, Vec<f64>) = (t0.iter().map(|v| f64::from(*v) - m).collect(), vec![0.0; n * n]);
        gw_match::phase::fft2(&mut re, &mut im, n, false);
        let fr = |k: usize| if k > n / 2 { k as f64 - n as f64 } else { k as f64 };
        for k in 0..n * n {
            let ph = -2.0 * std::f64::consts::PI * (fr(k % n) * sx + fr(k / n) * sy) / n as f64;
            let (c, s) = (ph.cos(), ph.sin());
            let (r, i) = (re[k], im[k]);
            re[k] = r * c - i * s;
            im[k] = r * s + i * c;
        }
        gw_match::phase::fft2(&mut re, &mut im, n, true);
        let t1: Vec<f32> = re.iter().map(|v| (v / (n * n) as f64 + m) as f32).collect();
        if let Some(p) = phase_correlate(Win { w: n, h: n, px: t0 }, Win { w: n, h: n, px: &t1 }) {
            ka.extend_from_slice(t0);
            kb.extend_from_slice(&t1);
            truth.push(json!([sx, sy]));
            ours.push(json!([p.dx, p.dy, p.peak]));
        }
    }
    dump_f32("phase_ka.f32", &ka);
    dump_f32("phase_kb.f32", &kb);
    std::fs::write(out_dir().join("phase_known.json"), json!({ "n": n, "a": "phase_ka.f32", "b": "phase_kb.f32", "truth": truth, "ours": ours }).to_string()).unwrap();
    std::fs::write(out_dir().join("phase_pairs.json"), json!({ "n": n, "a": "phase_a.f32", "b": "phase_b.f32", "shifts": shifts }).to_string()).unwrap();
}

/// The hillshade's sun azimuth: inliers per fixed azimuth on Golden (NAIP 2023-09-25).
#[test]
#[ignore = "corpus validation; run in release with --ignored"]
fn lidarreg_sun_scan() {
    let (Some(dem), Some(rgb)) = (load("golden_dem"), load("golden_naip_rgb")) else {
        eprintln!("work data absent; skipped");
        return;
    };
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(work().join("cases.json")).unwrap()).unwrap();
    let b: Vec<f64> = cases["golden"]["box"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    let frame = frame_at(13, (b[0] + b[1]) / 2.0, (b[2] + b[3]) / 2.0);
    let gs = grid_over(&frame, 13, [b[0] + 50.0, b[1] - 50.0, b[2] + 50.0, b[3] - 50.0], 1.0);
    let z = dem_on_grid(&dem, &frame, 13, &gs, 0.0);
    let g = RefGrid { frame, e0: gs.e0, n0: gs.n0, cell: 1.0, w: gs.w, h: gs.h, dsm: &z, intensity: None };
    let model = model_of(&rgb);
    let cr = chip_of(&rgb);
    let mut rows = Vec::new();
    for az in (0..12).map(|k| k as f64 * 30.0) {
        let o = RegOptions { reference: Reference::Hillshade, sun_az: az, max_offset_m: 40.0, ..RegOptions::default() };
        let r = register(&*model, &g, &cr, &o);
        let row = match r {
            Ok(r) => json!({ "az": az, "accepted": r.accepted, "inliers": r.inliers, "coarse": [r.coarse.0, r.coarse.1], "rms": r.rms_m, "meanNcc": r.matches.iter().filter(|m| m.inlier).map(|m| m.ncc).sum::<f64>() / r.inliers.max(1) as f64 }),
            Err(e) => json!({ "az": az, "error": e.msg }),
        };
        eprintln!("{row}");
        rows.push(row);
    }
    std::fs::write(out_dir().join("sun_scan.json"), Value::Array(rows).to_string()).unwrap();
}
