//! 2.1 fuzz targets (sar group, REQ-RUST-12). Seeds: corpus negatives turned positives (SDP-2.1 §7.1):
//! the T&E corpus CPHD headers + XML (GDAL autotest, Capella, Umbra; the first 64 KiB plus the XML block),
//! the UAVSAR annotation, the Sentinel-1 manifest and annotation/calibration/noise XML (cut to 256 KiB),
//! and the FX-21 fixtures (CPHD 1.0.1, UAVSAR, SAFE skeleton). The geolocation-array model is fuzzed with
//! node grids built from mutated bytes. Iterations: GW_FUZZ_ITERS (default 1500 per target); --release.

use gw_fuzz::run;
use gw_sensor::{Ground, SensorModel};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn corpus() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}
fn fx() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx21/sar")
}
fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}

/// The first `head` bytes of a file plus the byte range `[a, a + n)` (a CPHD's XML block).
fn read_part(p: &Path, max: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut b = vec![0u8; max];
    let n = f.read(&mut b).ok()?;
    b.truncate(n);
    Some(b)
}

/// A CPHD seed: header + padding + XML, laid out so the header offsets still point at the XML.
fn cphd_seed(p: &Path) -> Option<Vec<u8>> {
    let head = read_part(p, 1 << 16)?;
    let h = gw_parse::cphd::parse_header(&head).ok()?;
    let (xo, xs) = (h.xml.0 as usize, h.xml.1 as usize);
    if xo + xs <= head.len() {
        return Some(head[..xo + xs].to_vec());
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).ok()?;
    f.seek(SeekFrom::Start(xo as u64)).ok()?;
    let mut x = vec![0u8; xs];
    f.read_exact(&mut x).ok()?;
    let mut v = head[..xo.min(head.len())].to_vec();
    v.resize(xo, 0);
    v.extend(x);
    Some(v)
}

/// The app's CPHD path over one buffer that holds the header, the XML and (if present) the blocks.
fn cphd_path(b: &[u8]) {
    let Ok(h) = gw_parse::cphd::parse_header(b) else { return };
    let (xo, xs) = (h.xml.0 as usize, h.xml.1 as usize);
    if xo.saturating_add(xs) > b.len() {
        return;
    }
    // A file length that claims the blocks are present, so the layout checks and decoders run.
    let claimed = [h.pvp.0 + h.pvp.1, h.signal.0 + h.signal.1, h.support.map(|s| s.0 + s.1).unwrap_or(0)].into_iter().max().unwrap_or(0).max(b.len() as u64);
    let Ok(m) = gw_parse::cphd::parse(b, &b[xo..xo + xs], claimed) else { return };
    let _ = gw_parse::cphd::to_json(&m);
    let rec = m.num_bytes_pvp as usize;
    let tail = &b[(xo + xs).min(b.len())..];
    let k = (tail.len() / rec.max(1)).min(64);
    let _ = gw_parse::cphd::pvp_columns(&m, &tail[..k * rec]);
    for s in &m.support {
        let need = (s.rows as usize).saturating_mul(s.cols as usize).saturating_mul(s.bpe as usize);
        if need <= tail.len() {
            let _ = gw_parse::cphd::support_values(s, &tail[..need]);
        }
    }
    if let Some(c) = m.channels.first() {
        let n = (c.nv as usize).min(k).max(1).min(c.nv as usize);
        if n >= 1 && n * rec <= tail.len() {
            let sub = gw_parse::cphd::Sub { ch: 0, v0: 0, v1: n as u64, s0: 0, s1: c.ns.min(4).max(1) };
            let _ = gw_parse::cphd::subset(&m, &[sub], &tail[..n * rec]);
        }
    }
}

/// A geolocation grid from bytes: sizes from the first bytes, lat/lon from the rest (f32 values).
fn geoloc_path(b: &[u8]) {
    if b.len() < 4 {
        return;
    }
    let nx = 2 + (b[0] as usize % 30);
    let ny = 2 + (b[1] as usize % 30);
    let n = nx * ny;
    let vals: Vec<f64> = b[2..].chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64).collect();
    let pick = |i: usize| vals.get(i % vals.len().max(1)).copied().unwrap_or(0.0);
    let lat: Vec<f64> = (0..n).map(|i| if vals.is_empty() { (i / nx) as f64 } else { pick(2 * i) % 91.0 }).collect();
    let lon: Vec<f64> = (0..n).map(|i| if vals.is_empty() { (i % nx) as f64 } else { pick(2 * i + 1) % 200.0 + 170.0 }).collect();
    let xs: Vec<f64> = (0..nx).map(|i| i as f64 + 0.5).collect();
    let ys: Vec<f64> = (0..ny).map(|j| j as f64 * (1.0 + b[2 % b.len()] as f64 / 64.0) + 0.5).collect();
    let Ok(m) = gw_sensor::geoloc::GeolocModel::new("fuzz", xs, ys, &lat, &lon) else { return };
    for k in 0..16 {
        let (x, y) = ((k * 7 % (nx + 2)) as f64 - 0.7, (k * 5 % (ny + 2)) as f64 - 0.3);
        if let Ok(g) = m.image_to_ground(x, y, 0.0) {
            let _ = m.ground_to_image(g);
        }
        let _ = m.ground_to_image(Ground { lat: pick(k) % 90.0, lon: pick(k + 1) % 180.0, h: 0.0 });
    }
}

#[test]
fn fuzz_sar21_parsers() {
    let n = iters();
    let o = out();
    let c = corpus();
    let mut reports = Vec::new();

    let mut cphd: Vec<Vec<u8>> = [c.join("sar-cphd-gdal-autotest/test.cphd"), c.join("capella-c13-sm-20240924/capella_C13_SM_CPHD.cphd"), c.join("umbra-bingham-20230925-full/umbra_20230925_CPHD.cphd"), c.join("sar-capella-c09-sm-cphd-20240923/capella_C09_SM_CPHD.cphd")].iter().filter_map(|p| cphd_seed(p)).collect();
    // The FX-21 CPHD whole (16 KiB): header, XML, support, PVP and signal for the decoders.
    if let Ok(b) = std::fs::read(fx().join("cphd-1.0.1-spot.cphd")) {
        cphd.push(b);
    }
    reports.push(run("cphd", &cphd, n, hang(), &o, cphd_path));

    let ann: Vec<Vec<u8>> = std::fs::read_dir(c.join("sar-uavsar-quadpol-tierb")).into_iter().flatten().flatten().chain(std::fs::read_dir(fx()).into_iter().flatten().flatten()).filter(|e| e.path().extension().map(|x| x == "ann").unwrap_or(false)).filter_map(|e| std::fs::read(e.path()).ok()).collect();
    reports.push(run("uavsar_ann", &ann, n, hang(), &o, |b| {
        if let Ok(a) = gw_parse::uavsar::parse(b) {
            let _ = gw_parse::uavsar::to_json(&a);
            for (name, len) in [("x_L090HHHH_CX_01.grd", 741630316u64), ("x_L090HHVV_CX_01.grd", 1483260632), ("x.mlc", 293634000), ("x.slc", 9600), ("x.hgt", 24), ("x.dat", 10)] {
                let _ = gw_parse::uavsar::product(&a, name, len);
            }
        }
    }));

    let mut safe: Vec<(i32, Vec<u8>)> = Vec::new();
    let s1 = c.join("sar-s1-iw-slc-vegas-20240626-20240708/S1A_IW_SLC__1SDV_20240626T134404_20240626T134432_054495_06A1B9_6F14.SAFE");
    for dir in [s1, fx().join("S1A_IW_SLC__FX21.SAFE")] {
        if let Some(b) = read_part(&dir.join("manifest.safe"), 1 << 18) {
            safe.push((1, b));
        }
        for (sub, kind) in [("annotation", 2), ("annotation/calibration", 0)] {
            for e in std::fs::read_dir(dir.join(sub)).into_iter().flatten().flatten().take(4) {
                let nm = e.file_name().to_string_lossy().to_string();
                if !nm.ends_with(".xml") {
                    continue;
                }
                let k = if kind == 2 { 2 } else if nm.starts_with("calibration-") { 3 } else { 4 };
                // Cut to 256 KiB on an element boundary so the seed still parses.
                if let Some(mut b) = read_part(&e.path(), 1 << 20) {
                    if b.len() > 256 << 10 {
                        b.truncate(256 << 10);
                    }
                    safe.push((k, b));
                }
            }
        }
    }
    // A Sentinel orbit file (POEORB/RESORB .EOF, REG-085), synthetic: key 5.
    safe.push((5, br#"<?xml version="1.0"?><Earth_Explorer_File><Earth_Explorer_Header><Fixed_Header><Mission>Sentinel-1A</Mission><File_Type>AUX_POEORB</File_Type><Validity_Period><Validity_Start>UTC=2024-06-25T22:59:42</Validity_Start><Validity_Stop>UTC=2024-06-27T00:59:42</Validity_Stop></Validity_Period></Fixed_Header><Variable_Header><Ref_Frame>EARTH_FIXED</Ref_Frame></Variable_Header></Earth_Explorer_Header><Data_Block type="xml"><List_of_OSVs count="2"><OSV><UTC>UTC=2024-06-25T22:59:42.000000</UTC><X unit="m">-2101139.1</X><Y unit="m">6309912.9</Y><Z unit="m">2409496.6</Z><VX unit="m/s">735.5</VX><VY unit="m/s">2920.9</VY><VZ unit="m/s">-7000.1</VZ></OSV><OSV><UTC>UTC=2024-06-25T22:59:52.000000</UTC><X unit="m">-2093000.0</X><Y unit="m">6339000.0</Y><Z unit="m">2339000.0</Z><VX unit="m/s">890.0</VX><VY unit="m/s">2880.0</VY><VZ unit="m/s">-7020.0</VZ></OSV></List_of_OSVs></Data_Block></Earth_Explorer_File>"#.to_vec()));
    let seeds: Vec<Vec<u8>> = safe.iter().map(|(k, b)| [vec![*k as u8], b.clone()].concat()).collect();
    reports.push(run("safe", &seeds, n, hang(), &o, |b| {
        let Some((&k, rest)) = b.split_first() else { return };
        let _ = match k % 5 {
            1 => gw_parse::safe::manifest(rest),
            2 => gw_parse::safe::annotation(rest),
            3 => gw_parse::safe::calibration(rest),
            4 => gw_parse::safe::noise(rest),
            _ => gw_parse::safe::eof(rest),
        };
    }));

    let mut geo: Vec<Vec<u8>> = vec![vec![8, 6, 0], vec![29, 29, 63, 1, 2, 3, 4, 5, 6, 7, 8]];
    for f in ["swath-vegas.nc", "swath-antimeridian.nc"] {
        if let Some(b) = read_part(&fx().join(f), 1 << 14) {
            geo.push(b);
        }
    }
    reports.push(run("geoloc", &geo, n, hang(), &o, geoloc_path));

    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped || r.target == "uavsar_ann", "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}

/// GW_FUZZ_REPLAY=<input>: run one saved input through the CPHD path (panics show their backtrace).
#[test]
fn replay() {
    let Ok(p) = std::env::var("GW_FUZZ_REPLAY") else { return };
    cphd_path(&std::fs::read(p).unwrap());
}

/// Inputs the one-hour runs found (fixtures/fx21/sar/fuzz-regress): each must fail cleanly.
#[test]
fn regressions() {
    let d = fx().join("fuzz-regress");
    let Ok(rd) = std::fs::read_dir(&d) else { return };
    for e in rd.flatten() {
        let b = std::fs::read(e.path()).unwrap();
        cphd_path(&b);
    }
}
