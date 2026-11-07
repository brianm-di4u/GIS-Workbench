//! 2.4 fuzz targets (terrsar group): the DEM edit list parser and replay (REQ-DEM-08 "Fuzz",
//! REQ-GAP-37/38) and the polarimetric kernels on arbitrary sample values (REQ-GAP-40). Seeds are
//! valid edit lists of every kind and small quad-pol chips; mutations must fail cleanly or run to
//! the end, never panic or hang. Iterations: GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_fuzz::run;
use gw_sar::polsar;
use gw_terrain::edit::{parse, replay, Geo};
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

const G: Geo = Geo { w: 48, h: 40, lat0: 34.52, lon0: -116.53, dlat: 1.0 / 36000.0, dlon: 1.0 / 36000.0 };

fn ring(v: &mut Vec<f64>) {
    v.push(4.0);
    for (i, j) in [(5.0, 5.0), (30.0, 6.0), (28.0, 30.0), (6.0, 28.0)] {
        v.push(G.lon0 + i * G.dlon);
        v.push(G.lat0 - j * G.dlat);
    }
}

/// One valid edit list per kind, and one with all of them.
fn edit_seeds() -> Vec<Vec<u8>> {
    let mut all = vec![0.0];
    let mut seeds = Vec::new();
    for code in 1..=11 {
        let mut v = vec![1.0, code as f64];
        match code {
            1 => v.extend([G.lat0 - 10.0 * G.dlat, G.lon0 + 10.0 * G.dlon, 500.0]),
            2 => {
                v.extend([3.0, 20.0]);
                ring(&mut v);
            }
            3 | 6 => {
                v.push(if code == 3 { f64::NAN } else { 2.0 });
                ring(&mut v);
            }
            4 | 7 => ring(&mut v),
            5 => {
                v.push(f64::NAN);
                ring(&mut v);
                v.push(0.0);
            }
            8 => v.extend([5.0, 0.0]),
            9 => v.extend([2.0, 2.0, G.lon0 + 3.0 * G.dlon, G.lat0 - 3.0 * G.dlat, 600.0, G.lon0 + 40.0 * G.dlon, G.lat0 - 30.0 * G.dlat, 610.0]),
            10 => {
                v.extend([20.0, 0.15, 0.5, 1.25]);
                ring(&mut v);
            }
            _ => {
                v.extend([G.lat0, G.lon0, G.dlat * 2.0, G.dlon * 2.0, 6.0, 6.0]);
                ring(&mut v);
                v.extend((0..36).map(|k| 600.0 + k as f64));
            }
        }
        all[0] += 1.0;
        all.extend_from_slice(&v[1..]);
        seeds.push(bytes(&v));
    }
    seeds.push(bytes(&all));
    seeds
}

#[test]
fn fuzz_terrsar24() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let z: Vec<f32> = (0..G.w * G.h).map(|k| 600.0 + (k % G.w) as f32 * 0.3 + (k / G.w) as f32 * 0.2).collect();
    let mut reports = Vec::new();
    reports.push(run("dem_edit", &edit_seeds(), n, hang(), &o, |b| {
        if let Ok(ops) = parse(&f64s(b)) {
            // Every vertex and patch post is read from the input, so the replay cost is bounded by it.
            let _ = replay(&G, &z, &ops);
        }
    }));
    // Polarimetry: a 12 × 10 chip of three complex channels (and a two-channel one), any values.
    let (w, h) = (12usize, 10usize);
    let seed: Vec<u8> = (0..w * h * 6).flat_map(|k| (((k * 7919) % 97) as f32 / 13.0 - 3.5).to_le_bytes()).collect();
    reports.push(run("polsar", &[seed], n, hang(), &o, |b| {
        let f: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
        if f.len() < w * h * 6 {
            return;
        }
        let cx = |k: usize| (0..w * h).map(|i| gw_sar::fft::Cx::new(f[k * 2 * w * h + 2 * i] as f64, f[k * 2 * w * h + 2 * i + 1] as f64)).collect::<Vec<_>>();
        let (hh, hv, vv) = (cx(0), cx(1), cx(2));
        for t in [polsar::boxcar(&polsar::from_quad(&hh, &hv, None, &vv, w, h, true), 3), polsar::refined_lee(&polsar::from_quad(&hh, &hv, None, &vv, w, h, true), 1.0)] {
            let haa: Vec<[f64; 6]> = (0..w * h).map(|i| polsar::h_a_alpha(&t.m9(i))).collect();
            for i in 0..w * h {
                let m = t.m9(i);
                let _ = polsar::freeman(&polsar::convert3(&m, false));
                let _ = polsar::yamaguchi(&m, true);
            }
            let _ = polsar::wishart(&t, &haa, true, 5, 0.01);
        }
        let (eh, ev) = polsar::ctlr(&hh, &hv, None, &vv);
        let c = polsar::boxcar(&polsar::from_dual(&eh, &ev, w, h), 3);
        for i in 0..w * h {
            let _ = polsar::h_alpha2(&[c.at(0, i), c.at(1, i), c.at(2, i), c.at(3, i)]);
        }
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
