//! 2.1 fuzz targets (nitf group, REQ-RUST-12): RPF A.TOC, ARIDPCM decode and encode→decode round
//! trip, TIFF old-style JPEG stream rebuilding and IFD reading, MrSID/ECW
//! footprint headers, and JPEG 2000 codestreams with progression order changes (POC) and ROI.
//! Seeds: the T&E corpus files these readers turned from negatives into positives (SDP-2.1 §7.1);
//! synthetic seeds when the corpus is absent. Iterations: GW_FUZZ_ITERS (default 1500 per target);
//! run with --release.

use gw_fuzz::run;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn corpus() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

fn read(rel: &str, max: usize) -> Option<Vec<u8>> {
    let b = std::fs::read(corpus().join(rel)).ok()?;
    Some(b[..b.len().min(max)].to_vec())
}

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

#[test]
fn fuzz21_nitf() {
    let n = iters();
    let hang = Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000));
    let o = out();
    let mut reports = Vec::new();

    // RPF A.TOC: NITF-wrapped and bare tables of contents.
    let tocs: Vec<Vec<u8>> = ["derived-rpf-cadrg-from-cib10/n35e011/RPF/A.TOC", "derived-rpf-cadrg-from-cib10/n60w156/RPF/A.TOC", "raster-gdal-autotest-dimap2-rpf-nm/rpftoc/zone9/RPF/A.TOC", "nitf-rpf-cadrg-frames/rpf_toc/A.TOC"].iter().filter_map(|p| read(p, 1 << 20)).collect();
    reports.push(run("rpf_toc", &tocs, n, hang, &o, |b| {
        if let Ok(t) = gw_parse::rpf_toc::parse(b) {
            let _ = gw_parse::rpf_toc::to_json(&t);
        }
    }));

    // ARIDPCM decode: the four C2 images of U_0001a (4.50, 2.30, 1.40, 0.75 bpp) and encoded blocks.
    let mut arid: Vec<Vec<u8>> = Vec::new();
    if let Some(f) = read("nitf-ntb-nitf11-legacy/U_0001a.ntf", 1 << 20) {
        for (off, len) in [(103455usize, 186241usize), (290899, 10731), (302833, 2817), (306853, 423)] {
            if let Some(s) = f.get(off..off + len) {
                arid.push(s.to_vec());
            }
        }
    }
    let px: Vec<u16> = (0..40 * 24).map(|k| ((k * 37) % 251) as u16).collect();
    for rate in ["0.75", "1.40", "2.30", "4.50"] {
        let p = gw_codec::aridpcm::Params::new(8, rate).unwrap();
        arid.push(gw_codec::aridpcm::encode(&px, 40, 24, &p).unwrap());
    }
    reports.push(run("aridpcm_decode", &arid, n, hang, &o, |b| {
        let w = 8 + (b.first().copied().unwrap_or(0) as usize % 64) * 8;
        let h = 8 + (b.get(1).copied().unwrap_or(0) as usize % 64) * 8;
        for (depth, rate) in [(8, "0.75"), (8, "4.50"), (11, "1.40"), (11, "6.40")] {
            let p = gw_codec::aridpcm::Params::new(depth, rate).unwrap();
            let _ = gw_codec::aridpcm::decode(b, w, h, &p);
            let _ = gw_codec::aridpcm::coded_bits(b, w, h, &p);
        }
    }));
    // Round trip: any samples encode, decode to the same size and stay in range.
    reports.push(run("aridpcm_roundtrip", &[px.iter().map(|&v| v as u8).collect::<Vec<u8>>()], n, hang, &o, |b| {
        if b.len() < 2 {
            return;
        }
        let w = 1 + b[0] as usize % 70;
        let h = 1 + b[1] as usize % 40;
        let s: Vec<u16> = (0..w * h).map(|k| b.get(2 + k % (b.len() - 2).max(1)).copied().unwrap_or(0) as u16 * 8).collect();
        for (depth, rate) in [(8u32, "0.75"), (8, "2.30"), (11, "4.50")] {
            let p = gw_codec::aridpcm::Params::new(depth, rate).unwrap();
            let px: Vec<u16> = s.iter().map(|&v| if depth == 8 { v / 8 } else { v }).collect();
            let enc = gw_codec::aridpcm::encode(&px, w, h, &p).expect("encode");
            let dec = gw_codec::aridpcm::decode(&enc, w, h, &p).expect("decode of an encoded block");
            assert_eq!(dec.data.len(), w * h);
            assert!(dec.data.iter().all(|&v| u32::from(v) < 1 << depth));
        }
    }));

    // Old-style JPEG: interchange headers and table records, strip data, raw IFDs.
    let mut oj: Vec<Vec<u8>> = Vec::new();
    for f in ["ojpeg_chewey_subsamp21_multi_strip.tiff", "ojpeg_single_strip_no_rowsperstrip.tiff", "ojpeg_zackthecat_subsamp22_single_strip.tiff"] {
        if let Some(b) = read(&format!("raster-ojpeg-libtiff-negatives/{f}"), 1 << 20) {
            oj.push(b);
        }
    }
    reports.push(run("ojpeg", &oj, n, hang, &o, |b| {
        use gw_codec::ojpeg::{header, ifd_entries, ifd_repair, stream, Record};
        let le = b.first() == Some(&0x49);
        let off = b.get(4..8).map(|s| if le { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) } as usize).unwrap_or(8);
        if let Some(ifd) = b.get(off.min(b.len())..) {
            let _ = ifd_entries(ifd, le);
            let _ = ifd_repair(ifd, le);
        }
        // Whatever looks like an interchange header, and the tail as tables.
        let jif = b.windows(2).position(|w| w == [0xFF, 0xD8]).map(|i| &b[i..]).unwrap_or(b);
        let mid = b.len() / 2;
        for recs in [vec![Record { kind: 3, index: 0, bytes: jif }], vec![Record { kind: 0, index: 0, bytes: &b[mid..] }, Record { kind: 1, index: 0, bytes: &b[mid / 2..] }, Record { kind: 2, index: 1, bytes: &b[mid..] }]] {
            if let Ok(h) = header(&recs) {
                let _ = stream(&h, &b[mid..], 64, 16, 3, 2, 1, 4);
                let _ = stream(&h, &b[..mid], 8, 8, 1, 1, 1, 0);
            }
        }
    }));

    // MrSID and ECW footprint headers.
    let mut fp: Vec<Vec<u8>> = Vec::new();
    for f in ["raster-mrsid-gdal-samples/lossless-mg3/utm11-27.sid", "raster-mrsid-gdal-samples/lossy-mg2/utm11-27.sid", "raster-mrsid-gdal-samples/lossy-mg3/laea.sid", "raster-ecw-negatives-gdal/sandiego2m_null.ecw", "raster-ecw-negatives-gdal/stefan_full_rgba_ecwv3_meta.ecw", "raster-ecw-negatives-gdal/spif83.ecw"] {
        if let Some(b) = read(f, 64 << 10) {
            fp.push(b);
        }
    }
    reports.push(run("footprint", &fp, n, hang, &o, |b| {
        for f in [gw_parse::footprint::mrsid(b), gw_parse::footprint::ecw(b)].into_iter().flatten() {
            let _ = gw_parse::footprint::to_json(&f);
        }
    }));

    // JPEG 2000 with POC (main and tile-part headers) and ROI maxshift.
    let j2k: Vec<Vec<u8>> = ["j2k-openjpeg-poc-conformance/p0_03.j2k", "j2k-openjpeg-poc-conformance/p0_15.j2k", "j2k-openjpeg-poc-conformance/p0_13.j2k", "jp2-gdal-autotest-geojp2-gmljp2/byte_one_poc.j2k"].iter().filter_map(|p| read(p, 1 << 20)).collect();
    // The decoder may legitimately reconstruct up to MAX_SAMPLES (400 M) declared samples from a tiny
    // file (seconds of work in a worker, by design), so this target's slow threshold is 15 s.
    reports.push(run("j2k_poc", &j2k, n.min(600), hang.max(Duration::from_secs(15)), &o, |b| {
        let _ = gw_codec::j2k::decode(b, None);
    }));

    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("{}: {} runs, slowest {:?}, {} problems", r.target, r.runs, r.slowest, r.crashes.len());
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
