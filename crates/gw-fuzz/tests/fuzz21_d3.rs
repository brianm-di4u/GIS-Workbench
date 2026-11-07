//! 2.1 fuzz targets (d3 group, REQ-RUST-12): the quantized-mesh writer and its strict decoder
//! (gw-tiles qmesh). Seeds: real quantized-mesh tiles from the T&E corpus (Cesium specs, HERE,
//! swisstopo, the derived geodetic set) and tiles the encoder writes. Iterations: GW_FUZZ_ITERS.
//! The JS readers of untrusted 3D Tiles and quantized-mesh bytes are fuzzed in
//! tests/unit/tiles3d-content.test.js and tests/unit/qmesh.test.js.

use gw_fuzz::run;
use gw_tiles::qmesh::{decode_tile, encode_tile, TileSpec};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

/// .terrain files under the corpus items that hold them (at most `max`).
fn corpus_tiles(max: usize) -> Vec<Vec<u8>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus");
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = ["3d-qmesh-cesiumjs-specs-4326", "terrain-qmesh-heremaps-examples", "3d-qmesh-swisstopo-4326", "derived-qmesh-geodetic"].iter().map(|d| root.join(d)).collect();
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "terrain") && out.len() < max {
                if let Ok(b) = std::fs::read(&p) {
                    if b.len() < 1 << 20 {
                        out.push(b);
                    }
                }
            }
        }
    }
    out
}

fn spec(size: usize, normals: bool) -> TileSpec {
    TileSpec { size, west: -106.171875, south: 38.671875, east: -105.8203125, north: 39.0234375, mercator: false, max_error: 1.0, normals }
}

#[test]
fn fuzz21_d3() {
    let n = iters();
    let hang = Duration::from_secs(2);
    let o = out();
    let mut seeds = corpus_tiles(40);
    // Encoder output seeds (always present, also without the corpus).
    for (k, size) in [17usize, 33, 65].into_iter().enumerate() {
        let z: Vec<f32> = (0..size * size).map(|i| (1000.0 + 200.0 * ((i % size) as f32 * 0.3).sin() + 50.0 * ((i / size) as f32 * 0.2).cos()) as f32).collect();
        seeds.push(encode_tile(&z, &spec(size, k % 2 == 0)).unwrap());
    }
    let mut reports = vec![run("qm-decode", &seeds, n, hang, &o, |b| {
        let _ = decode_tile(b);
    })];
    // Encoder: mutated bytes as heights (NaN, ±inf, huge ranges) and as tile parameters.
    let grids: Vec<Vec<u8>> = [9usize, 17, 33].iter().map(|&s| (0..s * s).flat_map(|i| (500.0f32 + i as f32).to_le_bytes()).collect()).collect();
    reports.push(run("qm-encode", &grids, n, hang, &o, |b| {
        let z: Vec<f32> = b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
        let size = (z.len() as f64).sqrt() as usize;
        let lim = b.first().copied().unwrap_or(0) as f64 / 255.0;
        let s = TileSpec { size, west: -180.0 + lim, south: -85.0, east: 180.0 - lim, north: 85.0, mercator: b.len() % 2 == 0, max_error: (lim * 10.0) as f32 - 1.0, normals: b.len() % 3 == 0 };
        if let Ok(t) = encode_tile(&z, &s) {
            let d = decode_tile(&t).expect("the decoder reads what the encoder writes");
            assert!(d.indices.iter().all(|&i| (i as usize) < d.u.len()));
        }
    }));
    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("fuzz {:<10} {:>6} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        for (p, m) in &r.crashes {
            bad.push(format!("{}: {} ({})", r.target, m, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
