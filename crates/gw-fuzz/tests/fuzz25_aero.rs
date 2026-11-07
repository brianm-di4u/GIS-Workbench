//! 2.5 fuzz targets (aero group, REQ-GAP-22): the aerial triangulation job record
//! (`gw_aero::aero::decode_job`) through set-up, a few solver steps and the report; the
//! resection and fiducial jobs. Seeds are valid jobs of a small synthetic block (a 2 × 3 frame
//! block with GCPs, GNSS weights and self-calibration); mutations must fail cleanly or run to the
//! end, never panic or hang. Iterations: GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_aero::aero::{decode_job, fiducial_job, report_json, resect_job, Aero, AeroOptions, NIO};
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
fn bytes(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

const LAT0: f64 = 41.03;
const LON0: f64 = -83.3;

fn camera() -> Vec<f64> {
    let mut c = vec![0.0, 0.0, 0.004, 6000.0, 4000.0];
    c.extend([24.0, 0.01, -0.01, 6e-5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    c.extend([1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    c.extend([0.0; NIO]);
    c.extend([0.0; 18]);
    c
}

/// A 2 × 3 nadir block 150 m above flat-ish ground, measured with a pinhole (no distortion in
/// the truth: the seed only has to be valid, not exact).
fn job() -> Vec<f64> {
    let (mn, me) = (1.0 / 111000.0, 1.0 / (111000.0 * LAT0.to_radians().cos()));
    let mut images = Vec::new();
    let mut centres = Vec::new();
    for s in 0..2 {
        for k in 0..3 {
            let (e, n) = ((k as f64 - 1.0) * 20.0, (s as f64 - 0.5) * 50.0);
            centres.push((e, n));
            let rec = [0.0, 24.0, 0.004, 3000.0, 2000.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 6000.0, 4000.0, LAT0 + n * mn, LON0 + e * me, 400.0, 0.0, 0.0, 0.0, 0.0];
            images.extend([0.0, 0.0, 1.0, 1.0, 0.05, 0.05, 0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, rec.len() as f64]);
            images.extend(rec);
        }
    }
    let mut points = Vec::new();
    let mut obs = Vec::new();
    let mut np = 0;
    for gi in -3..=3 {
        for gj in -3..=3 {
            let (e, n, u) = (gi as f64 * 9.0, gj as f64 * 9.0, 250.0 + (gi * gj) as f64 * 0.7);
            let mut mine = Vec::new();
            for (i, &(ce, cn)) in centres.iter().enumerate() {
                let (x, y) = (3000.0 + (e - ce) / (150.0 - u + 250.0) * 24.0 / 0.004, 2000.0 - (n - cn) / (150.0 - u + 250.0) * 24.0 / 0.004);
                if x > 0.0 && y > 0.0 && x < 6000.0 && y < 4000.0 {
                    mine.push([i as f64, np as f64, x, y, 0.5]);
                }
            }
            if mine.len() < 2 {
                continue;
            }
            let gcp = (gi + gj) % 4 == 0;
            points.extend([if gcp { 1.0 } else { 0.0 }, LAT0 + n * mn, LON0 + e * me, if gcp { u } else { f64::NAN }, 0.02, 0.05]);
            for m in mine {
                obs.extend(m);
            }
            np += 1;
        }
    }
    let mut j = vec![31.0, 1.0, 1.0, 6.0, np as f64, (obs.len() / 5) as f64, 4.0, 1.0, 1.5, 4.0, 5.0, 0.9];
    j.extend(camera());
    j.extend(images);
    j.extend(points);
    j.extend(obs);
    j
}

fn resect_seed() -> Vec<f64> {
    let mut j = camera();
    j.extend([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 8.0, 0.0]);
    let (mn, me) = (1.0 / 111000.0, 1.0 / (111000.0 * LAT0.to_radians().cos()));
    for k in 0..8 {
        let (e, n) = ((k % 4) as f64 * 15.0 - 22.0, (k / 4) as f64 * 20.0 - 10.0);
        j.extend([LAT0 + n * mn, LON0 + e * me, 250.0 + k as f64, 3000.0 + e * 40.0, 2000.0 - n * 40.0, 0.5]);
    }
    j
}

fn fiducial_seed() -> Vec<f64> {
    let fid = [(-105.994, -105.998), (106.006, 105.998), (-105.990, 106.004), (105.998, -105.998), (-111.994, 0.003), (112.004, 0.002), (0.004, 112.008), (-0.006, -111.994)];
    let mut j = vec![1.0, 8.0];
    for (x, y) in fid {
        j.extend([5750.0 + x / 0.02, 5750.0 - y / 0.02, x, y]);
    }
    j
}

#[test]
fn fuzz_aero25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    // The seed job must solve (so mutations explore the real paths).
    let seed = job();
    let (c, i, p, ob, opts) = decode_job(&seed).expect("seed job decodes");
    let mut a = Aero::new(c, i, p, ob, opts).expect("seed job sets up");
    a.run().expect("seed job solves");
    let mut reports = Vec::new();
    reports.push(run("aero_job", &[bytes(&seed)], n, hang(), &o, |b| {
        let Ok((c, i, p, ob, opts)) = decode_job(&f64s(b)) else { return };
        let Ok(mut a) = Aero::new(c, i, p, ob, AeroOptions { max_iterations: opts.max_iterations.min(4), ..opts }) else { return };
        for _ in 0..6 {
            match a.step() {
                Ok(p) if p.done => break,
                Ok(_) => {}
                Err(_) => return,
            }
        }
        if let Ok(r) = a.report() {
            let _ = report_json(&a, &r);
        }
    }));
    reports.push(run("aero_resect", &[bytes(&resect_seed())], n, hang(), &o, |b| {
        let _ = resect_job(&f64s(b));
    }));
    reports.push(run("aero_fiducial", &[bytes(&fiducial_seed())], n, hang(), &o, |b| {
        let _ = fiducial_job(&f64s(b));
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
