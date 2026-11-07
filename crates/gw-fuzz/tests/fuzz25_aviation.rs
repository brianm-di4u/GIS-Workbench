//! 2.5 fuzz target (aviation group, REQ-GAP-73): the obstruction-surface definition list (parse,
//! model build, the limit at positions around the aerodrome, and the display facets). Seeds are valid
//! Part 77 and Annex 14 lists of one to three runways, with and without the 2.6 obstacle-free zone
//! and its code letter F width; mutations must fail cleanly or run to the end, never panic or hang. Iterations: GW_FUZZ_ITERS (default 1500); --release.

use gw_aviation::model::{encode, parse, Airport, EndDef, Regime, RunwayDef};
use gw_aviation::Model;
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

fn end(lat: f64, lon: f64, elev: f64, p77: u8, icao: u8, disp: f64) -> EndDef {
    EndDef { lat, lon, elev, p77, icao, disp, thr_elev: elev, approach: true, takeoff: true, clearway: 0.0 }
}

fn seeds() -> Vec<Vec<u8>> {
    let r1 = RunwayDef { paved: true, code: 4, tocs_width: f64::NAN, ends: [end(36.075, -115.170, 665.0, 5, 2, 178.0), end(36.099, -115.156, 635.0, 3, 1, 0.0)] };
    let r2 = RunwayDef { paved: true, code: 4, tocs_width: f64::NAN, ends: [end(36.076, -115.171, 665.4, 2, 0, 0.0), end(36.076, -115.121, 619.6, 5, 2, 426.0)] };
    let r3 = RunwayDef { paved: false, code: 1, tocs_width: 300.0, ends: [end(36.08, -115.20, 700.0, 0, 0, 0.0), end(36.083, -115.195, 702.0, 0, 0, 0.0)] };
    let mut out = Vec::new();
    // A category II or III end, and one whose threshold is near the far end.
    let r4 = RunwayDef { paved: true, code: 3, tocs_width: f64::NAN, ends: [end(36.075, -115.170, 665.0, 5, 3, 1400.0), end(36.09, -115.16, 640.0, 5, 2, 0.0)] };
    out.push(bytes(&encode(&Airport { regime: Regime::Icao, elev: 665.0, ihs_datum: f64::NAN, code_f: true, runways: vec![r4] })));
    for regime in [Regime::Part77, Regime::Icao] {
        for rw in [vec![r1], vec![r1, r2], vec![r1, r2, r3], vec![r3]] {
            out.push(bytes(&encode(&Airport { regime, elev: 665.4, ihs_datum: 660.0, code_f: rw.len() == 2, runways: rw })));
        }
    }
    out
}

#[test]
fn fuzz_aviation25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let r = run("obstruction_surfaces", &seeds(), n, hang(), &o, |b| {
        if let Ok(a) = parse(&f64s(b)) {
            if let Ok(m) = Model::build(&a) {
                for k in 0..64 {
                    let (la, lo) = (36.0 + (k % 8) as f64 * 0.03, -115.3 + (k / 8) as f64 * 0.04);
                    let _ = m.limit_at(la, lo);
                    let _ = m.limits_at(la, lo);
                }
                let _ = m.geo_bbox();
                let _ = m.facets();
            }
        }
    });
    eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
    assert!(r.runs > 0 || r.skipped, "no seeds");
    let bad: Vec<String> = r.crashes.iter().map(|(p, m)| format!("{} {}: {m}", r.target, p.display())).collect();
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
