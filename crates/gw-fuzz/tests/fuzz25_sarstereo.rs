//! 2.5 fuzz targets (sarstereo group, REQ-GAP-42): the `sar` bundle's radargrammetry entry points
//! on mutated inputs — the stereo pair finder's parameter list (SICD records included), the DSM
//! job's parameter record and arrays (run to the end), multilooking — and the layover/shadow
//! marches on arbitrary geometry. Mutations must fail cleanly or finish, never panic or hang.
//! Seeds are built from the Umbra SICD XML fixtures (fixtures/fx25/sarstereo). Iterations:
//! GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_fuzz::run;
use gw_sensor::sicd::{Params, Sicd};
use gw_sensor::{Ground, SensorModel};
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
fn f32s(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()
}
fn bytes64(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
fn bytes32(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn record(name: &str) -> Vec<f64> {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx25/sarstereo").join(format!("umbra_{name}.sicd.xml"));
    let root = gw_parse::xml::parse(&std::fs::read(p).unwrap()).unwrap();
    gw_parse::sicd::record(&root).unwrap()
}

const A: &str = "2023-09-28-05-16-39_UMBRA-04";
const B: &str = "2023-07-27-05-21-14_UMBRA-05";

#[test]
fn fuzz_sarstereo25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let (ra, rb) = (record(A), record(B));
    let mut reports = Vec::new();

    // Pair finder: limits, count, then (start, length, record) per collect.
    let mut prm = vec![0.3, 3.0, 15.0, 90.0, 8.0, 2.0];
    for (k, r) in [&ra, &rb].into_iter().enumerate() {
        prm.extend([k as f64 * 86400.0, r.len() as f64]);
        prm.extend_from_slice(r);
    }
    reports.push(run("sar_stereo_pairs", &[bytes64(&prm)], n, hang(), &o, |b| {
        let v = f64s(b);
        if v.is_empty() {
            return;
        }
        unsafe {
            let _ = gw_bundle_sar::gw_sar_stereo_pairs(v.as_ptr(), v.len());
        }
    }));

    // Multilook: [w, h, mx, my, amplitude] then the samples.
    let mut ml = bytes64(&[6.0, 5.0, 2.0, 3.0, 1.0]);
    ml.extend(bytes32(&(0..30).map(|k| k as f32 * 0.5).collect::<Vec<_>>()));
    reports.push(run("sar_multilook", &[ml], n, hang(), &o, |b| {
        if b.len() < 40 {
            return;
        }
        let p = f64s(&b[..40]);
        let v = f32s(&b[40..]);
        unsafe {
            let _ = gw_bundle_sar::gw_sar_multilook(p.as_ptr(), v.as_ptr(), v.len());
        }
    }));

    // DSM job: the 40-value parameter record, then the prior, chip A and chip B samples (f32, in
    // the sizes the record names, as far as the input reaches). A 24 × 24-post area at 2 m about
    // the SCP of A, chips of 48 × 48 samples (4 × 4 looks) around its projection in each image.
    let (ma, mb) = (Sicd::new(Params::from_record(&ra).unwrap(), "A"), Sicd::new(Params::from_record(&rb).unwrap(), "B"));
    let (lat, lon, h) = gw_geodesy::wgs84::ecef_to_geodetic(ma.p.scp[0], ma.p.scp[1], ma.p.scp[2]);
    let (dlat, dlon) = (2.0 / 111_000.0, 2.0 / (111_000.0 * lat.to_radians().cos()));
    let (pa, pb) = (ma.ground_to_image(Ground { lat, lon, h }).unwrap(), mb.ground_to_image(Ground { lat, lon, h }).unwrap());
    let mut job = vec![1.0, lat + 12.0 * dlat, lon - 12.0 * dlon, dlat, dlon, 24.0, 24.0];
    job.extend([lat + 40.0 * dlat, lon - 40.0 * dlon, 2.0 * dlat, 2.0 * dlon, 40.0, 40.0]);
    job.extend([pa.0 - 96.0, pa.1 - 96.0, 4.0, 4.0, 48.0, 48.0, pb.0 - 96.0, pb.1 - 96.0, 4.0, 4.0, 48.0, 48.0]);
    job.extend([1.0, 2.0, 20.0, 0.5, 0.0, 0.3, 0.03, 6.0, 0.0, 5.0, 0.5, 2.0, 4.0, 0.0, 8.0]);
    assert_eq!(job.len(), 40);
    let mut seed = bytes64(&job);
    seed.extend(bytes32(&vec![h as f32; 1600]));
    seed.extend(bytes32(&(0..2304).map(|k| 1.0 + ((k * 7919) % 101) as f32 / 10.0).collect::<Vec<_>>()));
    seed.extend(bytes32(&(0..2304).map(|k| 1.0 + ((k * 104_729) % 97) as f32 / 10.0).collect::<Vec<_>>()));
    let mut anchored = job.clone();
    anchored[29] = 1.0; // log-ratio
    anchored[33] = 1.0; // anchor
    anchored[38] = 2.0; // Lee filter
    let mut seed2 = bytes64(&anchored);
    seed2.extend_from_slice(&seed[320..]);
    reports.push(run("sar_stereo_job", &[seed, seed2], n, hang(), &o, |b| {
        if b.len() < 320 {
            return;
        }
        let p = f64s(&b[..320]);
        // The work grows with the posts the record asks for; the app caps them (4 M), the kernel at
        // 16 M. Keep fuzz runs small.
        let posts = p[5] * p[6];
        if !(posts.is_finite() && posts <= 4096.0) {
            return;
        }
        let rest = f32s(&b[320..]);
        let size = |w: f64, h: f64| if w.is_finite() && h.is_finite() && w >= 0.0 && h >= 0.0 && w * h < 1e7 { (w * h) as usize } else { 0 };
        let (np, na) = (size(p[11], p[12]), size(p[17], p[18]));
        let pz = &rest[..np.min(rest.len())];
        let ca = &rest[pz.len()..(pz.len() + na).min(rest.len())];
        let cb = &rest[pz.len() + ca.len()..];
        unsafe {
            let id = gw_bundle_sar::gw_sar_stereo_new(p.as_ptr(), p.len(), ra.as_ptr(), ra.len(), rb.as_ptr(), rb.len(), pz.as_ptr(), pz.len(), ca.as_ptr(), ca.len(), cb.as_ptr(), cb.len());
            if id <= 0 {
                return;
            }
            for _ in 0..100_000 {
                if gw_bundle_sar::gw_sar_stereo_step(id, 16) != 0 || gw_bundle_sar::gw_sar_stereo_progress(id) >= 1.0 {
                    break;
                }
            }
            let _ = gw_bundle_sar::gw_sar_stereo_result(id);
            gw_bundle_sar::gw_sar_stereo_free(id);
        }
    }));

    // Layover and shadow marches: a 32 × 32 DEM from the input, then point, sensor, velocity,
    // step and tolerance.
    let mut mk: Vec<f64> = (0..1024).map(|k| 100.0 + ((k * 37) % 23) as f64 * 3.0).collect();
    mk.extend([0.0, 0.0, 130.0, -600e3, 0.0, 600e3, 0.0, 7600.0, 0.0, 2.5, 0.25]);
    reports.push(run("sar_mask", &[bytes64(&mk)], n, hang(), &o, |b| {
        let v = f64s(b);
        if v.len() < 1024 + 11 {
            return;
        }
        let z: Vec<f32> = v[..1024].iter().map(|&x| x as f32).collect();
        let Some(dem) = gw_terrain::sarmask::DemEnu::new(32, 32, &z, -155.0, 155.0, 10.0, 10.0, 6.371e6) else { return };
        let q = &v[1024..];
        // Steps below 1 cm are refused by the caller (radargram uses at least 0.25 m).
        let step = q[9].abs().max(0.01);
        let _ = gw_terrain::sarmask::mask(&dem, [q[0], q[1], q[2]], [q[3], q[4], q[5]], [q[6], q[7], q[8]], step, q[10].abs());
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
