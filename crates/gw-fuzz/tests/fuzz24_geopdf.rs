//! 2.4 fuzz target (geopdf group): the GeoPDF vector read-out (REQ-GAP-66, gw_parse::pdfvec) on
//! mutations of the FX-24 GeoPDFs GDAL wrote (structure tree, optional content, Flate and plain
//! content streams, a raster page). Mutations must fail cleanly or run to the end, never panic or
//! hang. Iterations: GW_FUZZ_ITERS (default 1500); --release.

use gw_fuzz::run;
use gw_parse::pdf::Pdf;
use gw_parse::pdfvec::{vectors_json, Limits};
use std::path::Path;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}

#[test]
fn fuzz_geopdf24() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx24/geopdf");
    let mut seeds: Vec<Vec<u8>> = std::fs::read_dir(&fx).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "pdf")).filter_map(|p| std::fs::read(p).ok()).filter(|b| b.len() < 64 << 10).collect()).unwrap_or_default();
    if seeds.is_empty() {
        seeds.push(b"%PDF-1.7\n1 0 obj << /Type /Catalog /StructTreeRoot 5 0 R >> endobj 3 0 obj << /Type /Page /VP [<< /BBox [0 0 9 9] /Measure << /Subtype /GEO /GPTS [0 0 1 0 1 1 0 1] /LPTS [0 0 0 1 1 1 1 0] >> >>] /Resources << /Properties << /L 9 0 R >> >> /Contents 4 0 R >> endobj 4 0 obj << /Length 60 >> stream\n/OC /L BDC /feature <</MCID 0>> BDC 0 0 m 5 5 l S EMC EMC\nendstream endobj 5 0 obj << /K [6 0 R] >> endobj 6 0 obj << /S /Feature /T (a) /K [<< /K 0 /A << /O /UserProperties /P [<< /N (n) /V 1 >>] >> >>] >> endobj 9 0 obj << /Type /OCG /Name (L) >> endobj\n".to_vec());
    }
    let reports = [run("pdfvec", &seeds, n, hang(), &o, |b| {
        if let Ok(p) = Pdf::scan(b) {
            let _ = vectors_json(&p, Limits { features: 10_000, vertices: 200_000 });
        }
    })];
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
