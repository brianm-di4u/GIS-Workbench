//! 2.1 fuzz targets (tiles group, REQ-RUST-12, REQ-SEC-02). Seeds: the corpus PMTiles/MBTiles
//! samples turned positives in 2.1 (TE-corpus `vector-pmtiles-*`, `raster-pmtiles-*`, the Brotli
//! fixture), FX-21 tiles fixtures when generated, and tiler output.
//!
//! Targets: `brotli` (the Brotli wrapper), `pmtiles-dir` (directory varints), `pmtiles` (header,
//! directories, tile lookup, verify), `mvt-decode` (MVT protobuf), `mvt-input` (the tiler's GWVT
//! input parser) and `mvt-roundtrip` (random layers → tiler → decoder: every tile decodes, every
//! feature id comes back). Iterations: GW_FUZZ_ITERS (default 1500 per target); run with --release
//! for long runs (one hour per target nightly, SDP-2.1 §7.1).

use gw_fuzz::run;
use gw_tiles::{brotli, gz, mvt, pmtiles};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn corpus() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

fn files(dir: &Path, pred: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>, depth: usize) {
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let n = e.file_name().to_string_lossy().to_lowercase();
        if p.is_dir() && depth > 0 && !n.starts_with('_') {
            files(&p, pred, out, depth - 1);
        } else if pred(&n) && e.metadata().map(|m| m.len() < 8 << 20).unwrap_or(false) {
            out.push(p);
        }
    }
}

fn seeds(pred: &dyn Fn(&str) -> bool) -> Vec<Vec<u8>> {
    let mut ps = Vec::new();
    for d in [corpus(), Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx21/tiles")] {
        files(&d, pred, &mut ps, 2);
    }
    ps.sort();
    ps.iter().filter_map(|p| std::fs::read(p).ok()).collect()
}

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

/// Directories (decompressed) and tiles (as stored) of an archive held whole.
fn parts(b: &[u8]) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
    let (mut dirs, mut tiles) = (Vec::new(), Vec::new());
    let Ok(h) = pmtiles::parse_header(b) else { return (dirs, tiles) };
    let raw = |o: u64, l: u64| -> Option<Vec<u8>> {
        let (o, l) = (o as usize, l as usize);
        let s = b.get(o..o.checked_add(l)?)?;
        match h.internal_compression {
            pmtiles::COMP_GZIP => gz::gunzip(s, 64 << 20).ok(),
            pmtiles::COMP_BROTLI => brotli::decompress(s, 64 << 20).ok(),
            pmtiles::COMP_NONE => Some(s.to_vec()),
            _ => None,
        }
    };
    if let Some(r) = raw(h.root_offset, h.root_length) {
        if let Ok(es) = pmtiles::parse_directory(&r, 1 << 20) {
            for e in es.iter().take(64) {
                if e.run_length == 0 {
                    if let Some(l) = raw(h.leaf_offset + e.offset, e.length as u64) {
                        dirs.push(l);
                    }
                } else if let Some(t) = b.get((h.data_offset + e.offset) as usize..(h.data_offset + e.offset + e.length as u64) as usize) {
                    tiles.push(t.to_vec());
                }
            }
        }
        dirs.push(r);
    }
    (dirs, tiles)
}

/// A deterministic layer set from fuzz bytes: points, lines and polygons with ids and tags.
fn layers_from(b: &[u8]) -> Vec<mvt::Layer> {
    let mut it = b.iter().copied().cycle();
    let mut next = || it.next().unwrap_or(0) as f64;
    let n = (b.len() % 13) + 1;
    let mut features = Vec::new();
    for i in 0..n {
        let k = (next() as usize % 3) + 1;
        let pt = |a: f64, c: f64| [a / 255.0 * 340.0 - 170.0, c / 255.0 * 160.0 - 80.0];
        let geom = match k {
            1 => mvt::Geom::Points(vec![pt(next(), next())]),
            2 => mvt::Geom::Lines(vec![(0..(next() as usize % 6 + 2)).map(|_| pt(next(), next())).collect()]),
            _ => mvt::Geom::Polys(vec![vec![(0..(next() as usize % 6 + 3)).map(|_| pt(next(), next())).collect()]]),
        };
        features.push(mvt::Feature { id: Some(i as u64), tags: vec![(0, (i % 2) as u32)], geom });
    }
    vec![mvt::Layer { name: "f".into(), keys: vec!["k".into()], values: vec![mvt::Value::I64(-3), mvt::Value::Str("v".into())], features }]
}

#[test]
fn fuzz_tiles_21() {
    let n = iters();
    let hang = Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000));
    let o = out();
    let mut reports = Vec::new();

    let archives = seeds(&|n: &str| n.ends_with(".pmtiles"));
    let (mut dirs, mut tiles) = (Vec::new(), Vec::new());
    for a in &archives {
        let (d, t) = parts(a);
        dirs.extend(d);
        tiles.extend(t);
    }
    // MVT bodies: gunzipped tiles that look like protobuf (field 3), plus the tiler's own output.
    let mut mvts: Vec<Vec<u8>> = tiles.iter().filter_map(|t| if t.starts_with(&[0x1f, 0x8b]) { gz::gunzip(t, 16 << 20).ok() } else { Some(t.clone()) }).filter(|t| t.first() == Some(&0x1a)).take(64).collect();
    let synth = layers_from(b"seed layers for the tiler 0123456789");
    let opts = mvt::TileOptions { min_zoom: 0, max_zoom: 3, ..Default::default() };
    mvts.extend(mvt::tile_layers(&synth, &opts).unwrap().into_iter().map(|t| t.3));

    // Brotli: the corpus Brotli archive's blocks and a few streams of known shape.
    let mut br: Vec<Vec<u8>> = archives.iter().filter(|a| a.len() > 98 && (a[97] == 3 || a[98] == 3)).flat_map(|a| {
        let h = pmtiles::parse_header(a).ok();
        h.map(|h| vec![a.get(h.root_offset as usize..(h.root_offset + h.root_length) as usize).unwrap_or(&[]).to_vec(), a.get(h.metadata_offset as usize..(h.metadata_offset + h.metadata_length) as usize).unwrap_or(&[]).to_vec()]).unwrap_or_default()
    }).filter(|v| !v.is_empty()).collect();
    br.push(vec![0x1b, 0x17, 0x00, 0xf8, 0x8d, 0x94, 0x6e, 0xde, 0x44, 0x55, 0x86, 0xd6, 0x0a, 0x20, 0x6c, 0x6f, 0x4a, 0x11, 0x79, 0xe2, 0x80, 0xae, 0x16]);
    br.push(vec![0x0b, 0x02, 0x80, 0x61, 0x03]);
    reports.push(run("brotli", &br, n, hang, &o, |b| {
        let _ = brotli::decompress(b, 16 << 20);
    }));

    reports.push(run("pmtiles-dir", &dirs, n, hang, &o, |b| {
        if let Ok(es) = pmtiles::parse_directory(b, 1 << 20) {
            let _ = pmtiles::serialize_directory(&es);
        }
    }));

    let small: Vec<Vec<u8>> = archives.iter().filter(|a| a.len() < 512 << 10).cloned().collect();
    reports.push(run("pmtiles", &small, n, hang, &o, |b| {
        if let Ok(h) = pmtiles::parse_header(b) {
            let _ = pmtiles::verify(b);
            for (z, x, y) in [(0u8, 0u32, 0u32), (1, 1, 0), (5, 16, 11), (h.max_zoom.min(20), 0, 0)] {
                let _ = pmtiles::get_tile(b, &h, z, x, y);
            }
        }
    }));

    reports.push(run("mvt-decode", &mvts, n, hang, &o, |b| {
        let _ = mvt::decode(b);
    }));

    // The tiler's binary input (from JS): seeds are encoded layer sets.
    let inputs = vec![encode_input(&synth), encode_input(&layers_from(b"another set of layers"))];
    reports.push(run("mvt-input", &inputs, n, hang, &o, |b| {
        if let Ok(l) = mvt::parse_input(b) {
            let _ = mvt::tile_layers(&l, &mvt::TileOptions { min_zoom: 0, max_zoom: 2, max_tiles: 64, ..Default::default() });
        }
    }));

    // Round trip: any layer set tiles, every tile decodes, and each feature id is somewhere at zoom 2.
    let rt: Vec<Vec<u8>> = (0..16u8).map(|i| (0..64u8).map(|j| i.wrapping_mul(37).wrapping_add(j.wrapping_mul(11))).collect()).collect();
    reports.push(run("mvt-roundtrip", &rt, n.min(600), hang, &o, |b| {
        let layers = layers_from(b);
        let tiles = mvt::tile_layers(&layers, &mvt::TileOptions { min_zoom: 2, max_zoom: 2, tolerance: 0.0, ..Default::default() }).expect("tiling never fails on finite input");
        let mut ids = std::collections::BTreeSet::new();
        for t in &tiles {
            for l in mvt::decode(&t.3).expect("the tiler's own tile decodes") {
                assert_eq!(l.extent, 4096);
                ids.extend(l.features.iter().filter_map(|f| f.id));
            }
        }
        // Lines and polygons can quantise away below a tile unit; points never do.
        for f in &layers[0].features {
            if matches!(f.geom, mvt::Geom::Points(_)) {
                assert!(ids.contains(&f.id.unwrap()), "point {:?} lost", f.id);
            }
        }
        let packed = mvt::pack_tiles(&tiles);
        assert_eq!(mvt::unpack_tiles(&packed).unwrap().len(), tiles.len());
    }));

    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("fuzz21-tiles {}: {} runs, slowest {:?}, {} problems", r.target, r.runs, r.slowest, r.crashes.len());
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {}", r.target, p.display(), m));
        }
    }
    assert!(reports.iter().all(|r| r.runs > 0 || r.skipped), "a target had no seeds: {:?}", reports.iter().filter(|r| r.runs == 0 && !r.skipped).map(|r| r.target).collect::<Vec<_>>());
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}

/// The GWVT input the JS side writes (app/src/tiles/tiler.js), for seeds.
fn encode_input(layers: &[mvt::Layer]) -> Vec<u8> {
    let mut b = b"GWVT".to_vec();
    let u32le = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
    let s = |b: &mut Vec<u8>, t: &str| {
        b.extend_from_slice(&(t.len() as u32).to_le_bytes());
        b.extend_from_slice(t.as_bytes());
    };
    let pts = |b: &mut Vec<u8>, p: &[mvt::P]| {
        b.extend_from_slice(&(p.len() as u32).to_le_bytes());
        for q in p {
            b.extend_from_slice(&q[0].to_le_bytes());
            b.extend_from_slice(&q[1].to_le_bytes());
        }
    };
    u32le(&mut b, 1);
    u32le(&mut b, layers.len() as u32);
    for l in layers {
        s(&mut b, &l.name);
        u32le(&mut b, l.keys.len() as u32);
        for k in &l.keys {
            s(&mut b, k);
        }
        u32le(&mut b, l.values.len() as u32);
        for v in &l.values {
            match v {
                mvt::Value::Str(t) => {
                    b.push(1);
                    s(&mut b, t);
                }
                mvt::Value::F64(f) => {
                    b.push(2);
                    b.extend_from_slice(&f.to_le_bytes());
                }
                mvt::Value::I64(i) => {
                    b.push(3);
                    b.extend_from_slice(&i.to_le_bytes());
                }
                mvt::Value::Bool(t) => {
                    b.push(4);
                    b.push(u8::from(*t));
                }
            }
        }
        u32le(&mut b, l.features.len() as u32);
        for f in &l.features {
            match f.id {
                Some(id) => {
                    b.push(1);
                    b.extend_from_slice(&id.to_le_bytes());
                }
                None => b.push(0),
            }
            match &f.geom {
                mvt::Geom::Points(p) => {
                    b.push(1);
                    u32le(&mut b, f.tags.len() as u32);
                    for (k, v) in &f.tags {
                        u32le(&mut b, *k);
                        u32le(&mut b, *v);
                    }
                    pts(&mut b, p);
                }
                mvt::Geom::Lines(ls) => {
                    b.push(2);
                    u32le(&mut b, f.tags.len() as u32);
                    for (k, v) in &f.tags {
                        u32le(&mut b, *k);
                        u32le(&mut b, *v);
                    }
                    u32le(&mut b, ls.len() as u32);
                    for l in ls {
                        pts(&mut b, l);
                    }
                }
                mvt::Geom::Polys(ps) => {
                    b.push(3);
                    u32le(&mut b, f.tags.len() as u32);
                    for (k, v) in &f.tags {
                        u32le(&mut b, *k);
                        u32le(&mut b, *v);
                    }
                    u32le(&mut b, ps.len() as u32);
                    for p in ps {
                        u32le(&mut b, p.len() as u32);
                        for r in p {
                            pts(&mut b, r);
                        }
                    }
                }
            }
        }
    }
    b
}
