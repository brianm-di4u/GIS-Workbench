//! TE-015 regression: every LAS file of the T&E corpus version matrix parses (header, VLRs,
//! EVLRs, GeoKeys/WKT) without a panic — a panic is a WebAssembly trap in the browser.
//! Skipped when TE-corpus is not present.

use gw_pointcloud::las;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

fn walk(d: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(d) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk(&p, out);
        } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("las") || x.eq_ignore_ascii_case("laz")) {
            out.push(p);
        }
    }
}

#[test]
fn te015_corpus_las_headers_parse_without_panic() {
    let mut files = Vec::new();
    for d in ["lidar-las-version-matrix", "derived-las-pdrf-5-9"] {
        walk(&root().join(d), &mut files);
    }
    if files.is_empty() {
        eprintln!("TE-corpus not present; skipped");
        return;
    }
    let mut failures = Vec::new();
    for f in &files {
        let b = std::fs::read(f).unwrap();
        let r = std::panic::catch_unwind(|| {
            let h = las::header(&b)?;
            let v = las::vlrs(&b, &h)?;
            for x in &v {
                if x.user_id == "LASF_Projection" && x.record_id == 2112 {
                    let (o, n) = (x.data_offset as usize, x.data_len as usize);
                    let _ = las::wkt(&String::from_utf8_lossy(b.get(o..o + n).unwrap_or(&[])));
                }
            }
            let _ = las::evlrs(&b, h.evlr_start, h.n_evlrs);
            Ok::<_, gw_abi::Error>(())
        });
        if r.is_err() {
            failures.push(f.display().to_string());
        }
    }
    assert!(failures.is_empty(), "panicked on: {failures:?}");
}
