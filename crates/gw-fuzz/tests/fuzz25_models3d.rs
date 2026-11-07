//! 2.5 fuzz target (models3d group): the SLPK container and I3S geometry readers (REQ-GAP-35,
//! gw_tiles::i3s) on mutations of a scene layer package the app wrote and of its uncompressed
//! geometry buffer (fixtures/fx25/models3d). The ZIP end record, the central directory and the
//! local headers are read from the mutated package; the geometry decoder runs with the layout of
//! the app's packages and with a layout read from the mutation's first bytes. Mutations must fail
//! cleanly or run to the end, never panic or hang. Iterations: GW_FUZZ_ITERS (default 1500).

use gw_fuzz::run;
use gw_tiles::i3s::{central_directory, decode_geometry, local_data_start, zip_end, Layout, Ty};
use std::path::Path;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}

fn app_layout() -> Layout {
    Layout { offset: 8, position: Some((Ty::F32, 3)), normal: Some((Ty::F32, 3)), uv0: Some((Ty::F32, 2)), color: Some((Ty::U8, 4)), uv_region: None, feature_id: Some((Ty::U64, 1)), face_range: Some((Ty::U32, 2)) }
}

#[test]
fn fuzz_models3d25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx25/models3d");
    let slpk: Vec<Vec<u8>> = std::fs::read(fx.join("b1.slpk")).into_iter().collect();
    let geom: Vec<Vec<u8>> = std::fs::read(fx.join("b1-geometry.bin")).into_iter().collect();
    let reports = [
        run("slpk", &slpk, n, hang(), &o, |b| {
            if let Ok(e) = zip_end(b, b.len() as u64) {
                let (a, s) = (e.cd_offset as usize, e.cd_size as usize);
                if let Some(cd) = b.get(a..a.saturating_add(s)) {
                    if let Ok(es) = central_directory(cd, 100_000) {
                        for x in es {
                            if let Some(h) = b.get(x.local_offset as usize..) {
                                let _ = local_data_start(h);
                            }
                        }
                    }
                }
            }
        }),
        run("i3s-geometry", &geom, n, hang(), &o, |b| {
            let _ = decode_geometry(b, &app_layout(), 1 << 20);
            // A layout from the input: types and component counts of every attribute.
            let pick = |i: usize| -> Option<(Ty, usize)> {
                let t = Ty::from_code(*b.get(i)? as f64 % 11.0)?;
                Some((t, (*b.get(i + 1)? as usize % 5).max(1)))
            };
            let l = Layout { offset: b.first().map_or(0, |v| *v as usize % 16), position: Some((Ty::F32, 3)), normal: pick(9), uv0: pick(11), color: pick(13), uv_region: pick(15), feature_id: pick(17), face_range: pick(19) };
            let _ = decode_geometry(b, &l, 1 << 16);
        }),
    ];
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
