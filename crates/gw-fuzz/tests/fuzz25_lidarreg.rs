//! 2.5 fuzz targets (lidarreg group, REQ-GAP-46): the photo bundle's job records for the joint
//! adjustment (block job version 3 with a datum shift and surveyed cloud points), the
//! image-to-point-cloud registration parameters and the GPM-style propagation job. Seeds are valid
//! jobs on a small synthetic site; mutations must fail cleanly or run to the end, never panic or
//! hang. Iterations: GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_fuzz::run;
use std::path::Path;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}
fn f64s(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
pub fn bytes(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

/// UTM 11N geotransform record (model type 4) of a 0.5 m ortho.
const GT: [f64; 7] = [32611.0, 559960.0, 0.5, 0.0, 3818240.0, 0.0, -0.5];
const LAT0: f64 = 34.4977;
const LON0: f64 = -116.3438;

pub fn block_v3(k: usize) -> Vec<f64> {
    let (np, nc) = (8usize, 3usize);
    let mut j = vec![3.0, 1.0, np as f64, np as f64, 20.0, 3.0, 1.0, k as f64, nc as f64, LAT0, LON0, 1500.0];
    j.extend(std::iter::repeat_n(1.0, k));
    j.extend([4.0, 7.0]);
    j.extend(GT);
    j.extend([0.0, 0.0, 280.0, 280.0, 280.0, 280.0, 0.0, 0.0]);
    for p in 0..np {
        let (dlat, dlon) = (p as f64 * 2.0e-4, (p % 3) as f64 * 3.0e-4);
        j.extend([if p == 5 { 4.0 } else { 3.0 }, LAT0 + dlat, LON0 + dlon, 1500.0 + p as f64, 0.3, 0.5]);
    }
    for p in 0..np {
        j.extend([0.0, p as f64, 100.0 + 50.0 * p as f64, 400.0 - 40.0 * p as f64, 1.0]);
    }
    for c in 0..nc {
        j.extend([LAT0 + c as f64 * 1e-4, LON0, 1500.4, 1500.0, 0.05, -0.02, 0.1, if c == 2 { 1.0 } else { 0.0 }]);
    }
    j
}

/// A 64 × 64 grid of 1 m posts with terrain and intensity, and the image chip over it.
fn register_inputs() -> (Vec<f64>, Vec<f32>, Vec<f32>, Vec<f32>) {
    let (w, h) = (64usize, 64usize);
    let dsm: Vec<f32> = (0..w * h).map(|k| 1500.0 + ((k % w) as f32 * 0.21).sin() * 4.0 + ((k / w) as f32 * 0.17).cos() * 3.0).collect();
    let inten: Vec<f32> = (0..w * h).map(|k| (((k % w) * 7 + (k / w) * 13) % 23) as f32).collect();
    let (cw, ch) = (90usize, 90usize);
    let chip: Vec<f32> = (0..cw * ch).map(|k| (((k % cw) * 7 + (k / cw) * 13) % 23) as f32).collect();
    // The grid's frame origin at full-resolution pixel (20, 20) of the ortho.
    let m = gw_sensor::geotransform::GeoTransformModel::new([GT[1], GT[2], GT[3], GT[4], GT[5], GT[6]], gw_sensor::geotransform::MapCrs::from_epsg(32611).unwrap()).unwrap();
    let g = gw_sensor::SensorModel::image_to_ground(&m, 20.0, 20.0, 1500.0).unwrap();
    let (dlat, dlon) = gw_sensor::intersect::deg_per_metre(g);
    let mut prm = vec![4.0, 7.0];
    prm.extend(GT);
    prm.extend([g.lat, g.lon, 1.0 / dlon, 1.0 / dlat, 0.0, 0.0, 1.0, w as f64, h as f64, cw as f64, ch as f64, 0.0, 0.0, 2.0, 2.0, f64::NAN, 45.0, 16.0, 16.0, 10.0, 0.05, 1.3, 0.3, 2.0, 4.0]);
    (prm, dsm, inten, chip)
}

fn gpm_job() -> Vec<f64> {
    let mut j = vec![3.0, LAT0, LON0, 1500.0, 0.04, 0.0, 0.0, 0.0, 0.04, 0.0, 0.0, 0.0, 0.01, 3.0];
    for p in 0..3 {
        j.extend([LAT0 + p as f64 * 1e-3, LON0, 1500.0, 0.3, 0.3, 0.5]);
    }
    j.extend([1.0, 0.1, 1.0, 100.0]);
    j
}

#[test]
fn fuzz_lidarreg25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let mut reports = Vec::new();
    let seeds: Vec<Vec<u8>> = [0, 3].iter().map(|&k| bytes(&block_v3(k))).collect();
    // The seeds themselves must solve (a fuzz target that only ever fails would test nothing).
    for s in &seeds {
        let a = f64s(s);
        assert_eq!(unsafe { gw_bundle_photo::gw_adjust_block(a.as_ptr(), a.len()) }, 0, "block v3 seed did not solve");
    }
    reports.push(run("block_v3", &seeds, n, hang(), &o, |b| {
        let a = f64s(b);
        let _ = unsafe { gw_bundle_photo::gw_adjust_block(a.as_ptr(), a.len()) };
    }));
    let (prm, dsm, inten, chip) = register_inputs();
    assert_eq!(unsafe { gw_bundle_photo::lidar::gw_lidar_register(prm.as_ptr(), prm.len(), dsm.as_ptr(), dsm.len(), inten.as_ptr(), inten.len(), chip.as_ptr(), chip.len()) }, 0, "registration seed failed");
    reports.push(run("lidar_register", &[bytes(&prm)], n, hang(), &o, |b| {
        let p = f64s(b);
        let _ = unsafe { gw_bundle_photo::lidar::gw_lidar_register(p.as_ptr(), p.len(), dsm.as_ptr(), dsm.len(), inten.as_ptr(), inten.len(), chip.as_ptr(), chip.len()) };
    }));
    let g = gpm_job();
    assert_eq!(unsafe { gw_bundle_photo::lidar::gw_gpm_propagate(g.as_ptr(), g.len()) }, 0, "gpm seed failed");
    reports.push(run("gpm_propagate", &[bytes(&g)], n, hang(), &o, |b| {
        let a = f64s(b);
        let _ = unsafe { gw_bundle_photo::lidar::gw_gpm_propagate(a.as_ptr(), a.len()) };
    }));
    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped, "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
