//! 2.5 fuzz target (csm group, REQ-GAP-24): the Rust side of CSM host models
//! (gw_sensor::host). Two targets over mutated bytes, with a test host standing in for the usgscsm
//! bridge:
//!  - `csm-record`: block-job records (type 9: a byte length, then the model state packed four
//!    bytes per value), from usgscsm test ISDs, read back as f64 values after byte mutation;
//!  - `csm-meta`: the model facts and names a host returns (parameter count, height range,
//!    covariance flag and values, the names text), as `HostModel::from_handle` reads them, then
//!    the trait calls that size their buffers from them.
//! Mutations must fail cleanly or run to the end, never panic or hang. The ISD parser itself is
//! usgscsm's (C++, nlohmann/json): tests/unit/csm-diff.test.js mutates ISDs against the wasm
//! module. Iterations: GW_FUZZ_ITERS (default 1500); --release.

use gw_fuzz::run;
use gw_sensor::host::{set_host, HostApi, HostModel};
use gw_sensor::{Ground, SensorModel};
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}

/// A host answering from `meta` and `names` (the fuzz input) for every handle.
struct FuzzHost {
    meta: RefCell<Vec<f64>>,
    names: RefCell<Vec<u8>>,
}

impl HostApi for FuzzHost {
    fn g2i(&self, _h: i32, lat: f64, lon: f64, _hae: f64, out: &mut [f64; 2]) -> i32 {
        *out = [lon, -lat];
        0
    }
    fn i2g(&self, _h: i32, x: f64, y: f64, hae: f64, out: &mut [f64; 3]) -> i32 {
        *out = [-y, x, hae];
        0
    }
    fn partials(&self, _h: i32, _lat: f64, _lon: f64, _hae: f64, out: &mut [f64]) -> i32 {
        let n = self.meta.borrow().first().copied().unwrap_or(0.0);
        let n = if n.is_finite() && n >= 0.0 && n < 1e6 { n as usize } else { 0 };
        for v in out.iter_mut() {
            *v = 1.0;
        }
        n as i32
    }
    fn with_params(&self, h: i32, _delta: &[f64]) -> i32 {
        h + 1
    }
    fn unmodelled(&self, _h: i32, _x: f64, _y: f64, out: &mut [f64; 3]) -> i32 {
        *out = [1.0, 0.0, 1.0];
        0
    }
    fn meta(&self, _h: i32, out: &mut [f64]) -> i32 {
        let m = self.meta.borrow();
        let n = m.len().min(out.len());
        out[..n].copy_from_slice(&m[..n]);
        m.len() as i32
    }
    fn names(&self, _h: i32, out: &mut [u8]) -> i32 {
        let m = self.names.borrow();
        let n = m.len().min(out.len());
        out[..n].copy_from_slice(&m[..n]);
        m.len() as i32
    }
    fn load(&self, state: &[u8]) -> i32 {
        if state.first() == Some(&b'!') {
            -1
        } else {
            1
        }
    }
    fn error(&self, _h: i32, out: &mut [u8]) -> i32 {
        let s = b"fuzz host error";
        let n = s.len().min(out.len());
        out[..n].copy_from_slice(&s[..n]);
        s.len() as i32
    }
    fn free(&self, _h: i32) {}
}

fn f64s(b: &[u8]) -> Vec<f64> {
    b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect()
}
fn bytes(v: &[f64]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn exercise(m: &HostModel) {
    let g = Ground { lat: 1.0, lon: 2.0, h: 3.0 };
    let _ = m.ground_to_image(g);
    let _ = m.image_to_ground(1.0, 2.0, 0.0);
    let _ = m.param_partials(g);
    let _ = m.param_covariance();
    let _ = m.unmodelled_covariance(1.0, 1.0);
    let n = m.param_count();
    let _ = m.with_params(&vec![0.1; n.min(64)]);
    for i in 0..n.min(64) {
        let _ = m.param_name(i);
    }
    let _ = gw_sensor::image_covariance(m, 1.0, 1.0, 0.0);
}

#[test]
fn fuzz_csm25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx25/csm/isd");
    let isds: Vec<Vec<u8>> = std::fs::read_dir(&fx).map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).filter_map(|p| std::fs::read(p).ok()).filter(|b| b.len() < 16 << 10).collect()).unwrap_or_default();
    let host = Rc::new(FuzzHost { meta: RefCell::new(vec![3.0, -1000.0, 1000.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]), names: RefCell::new(b"CSM frame camera (usgscsm)\na\nb\nc".to_vec()) });
    set_host(Some(host.clone()));
    // Records: the states of small ISDs (their text stands in for a state), as f64 bytes.
    let mut seeds: Vec<Vec<u8>> = isds.iter().map(|s| bytes(&HostModel::record_of(s))).collect();
    seeds.push(bytes(&HostModel::record_of(b"{}")));
    let rec = run("csm-record", &seeds, n, hang(), &o, |b| {
        if let Ok(m) = HostModel::from_record(&f64s(b)) {
            exercise(&m);
        }
    });
    // Meta + names: [meta f64s] 0xFF×8 [names bytes].
    let sep = [0xFFu8; 8];
    let mut ms = Vec::new();
    for np in [0usize, 3, 7, 16] {
        let mut meta = vec![np as f64, -1000.0, 1000.0, 1737400.0, 1737400.0, 1.0];
        meta.extend((0..np * np).map(|i| if i % (np + 1) == 0 { 1.0 } else { 0.0 }));
        let mut s = bytes(&meta);
        s.extend_from_slice(&sep);
        let names: Vec<String> = std::iter::once("CSM line scanner (usgscsm)".to_string()).chain((0..np).map(|i| format!("P{i} (m)"))).collect();
        s.extend_from_slice(names.join("\n").as_bytes());
        ms.push(s);
    }
    let meta = run("csm-meta", &ms, n, hang(), &o, |b| {
        let cut = b.windows(8).position(|w| w == sep).unwrap_or(b.len());
        *host.meta.borrow_mut() = f64s(&b[..cut]);
        *host.names.borrow_mut() = b.get(cut + 8..).unwrap_or(&[]).to_vec();
        if let Ok(m) = HostModel::from_handle(1) {
            exercise(&m);
        }
    });
    set_host(None);
    let mut bad = Vec::new();
    for r in [&rec, &meta] {
        eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped, "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
