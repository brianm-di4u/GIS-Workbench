//! 2.1 fuzz targets (video group, REQ-RUST-12): the MPEG program stream demuxer (gw-parse ps.rs)
//! and the MPEG-1 video decoder (gw-codec mpeg1v.rs). Seeds: the FX-21 video fixtures (MPEG-1 and
//! MPEG-2 program streams, KLV in private stream 1, a bare MPEG-1 stream) and the program-stream
//! files of the T&E corpus when it is mounted (`TE_CORPUS`, default `../TE-corpus`): their
//! first 256 KB. Iterations: GW_FUZZ_ITERS (default 1500 per target); run with --release.

use gw_fuzz::run;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

fn head(p: &Path, n: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut b = vec![0; n];
    let k = f.read(&mut b).ok()?;
    b.truncate(k);
    Some(b)
}

fn seeds() -> Vec<Vec<u8>> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut out = Vec::new();
    let fx = root.join("fixtures/fx21/video");
    for n in ["mpeg1_ps.mpg", "mpeg1_ps_klv.mpg", "mpeg2_ps.mpg", "mpeg1.m1v"] {
        if let Some(b) = head(&fx.join(n), 256 << 10) {
            out.push(b);
        }
    }
    let te = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| root.join("../TE-corpus"));
    for rel in ["fmv-esri-multiplexer-tutorial/FMV_Multiplexer_Tutorial/Raw_Video.mpeg", "mpeg1-ps-prelinger/KingsMou1950.mpg", "mpeg1-ps-prelinger/MissionA1942.mpg", "mpeg1-es-nasa-svs/a001000.mpg", "mpeg1-es-nasa-svs/isabel_640x480.mpg"] {
        if let Some(b) = head(&te.join(rel), 256 << 10) {
            out.push(b);
        }
    }
    out
}

/// The elementary stream of the first video stream in a program stream seed.
fn video_es(b: &[u8]) -> Vec<u8> {
    if b.len() >= 4 && b[..4] == [0, 0, 1, 0xB3] {
        return b.to_vec();
    }
    gw_parse::ps::extract_es(b, 0, 0xE0, true).0
}

fn decode_all(es: &[u8]) {
    let mut d = gw_codec::mpeg1v::Decoder::new();
    let mut rgba = Vec::new();
    let mut n = 0;
    for c in es.chunks(7919) {
        d.push(c);
        while let Ok(Some(o)) = d.decode() {
            d.rgba(o.slot, &mut rgba);
            n += 1;
            if n > 64 {
                return;
            }
        }
    }
    d.end();
    while let Ok(Some(o)) = d.decode() {
        d.rgba(o.slot, &mut rgba);
        n += 1;
        if n > 80 {
            return;
        }
    }
    // A seek: reset and feed the second half.
    d.reset();
    d.push(&es[es.len() / 2..]);
    d.end();
    while let Ok(Some(_)) = d.decode() {
        n += 1;
        if n > 120 {
            return;
        }
    }
}

#[test]
fn fuzz_video_parsers() {
    let n = iters();
    let hang = Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000));
    let o = out();
    let ps = seeds();
    assert!(!ps.is_empty(), "no seeds: run node build/fixtures/fxformats21.mjs --only=video");
    let mut reports = Vec::new();
    reports.push(run("ps", &ps, n, hang, &o, |b| {
        let mut d = gw_parse::ps::Demux::new();
        let mut off = 0;
        for c in b.chunks(65_537) {
            let _ = d.push(c, off as u64);
            off += c.len();
        }
        d.finish();
        let _ = d.to_json();
        let _ = d.times();
        for sid in [0xE0, 0xC0, 0xBD00, 0xBD80, 0] {
            let _ = gw_parse::ps::extract_es(b, 0, sid, false);
            let _ = gw_parse::ps::extract_es(&b[b.len() / 3..], 1234, sid, true);
        }
    }));
    // Decoder seeds: the elementary streams (MPEG-1 only; MPEG-2 seeds exercise the refusal),
    // cut to ~96 KB so each run decodes a handful of pictures.
    let es: Vec<Vec<u8>> = ps.iter().map(|b| video_es(b)).filter(|e| e.len() > 1000).map(|e| e[..e.len().min(96 << 10)].to_vec()).collect();
    reports.push(run("mpeg1v", &es, n, hang, &o, decode_all));
    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("fuzz {:<7} {:>6} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        for (p, m) in &r.crashes {
            bad.push(format!("{}: {} ({})", r.target, m, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
