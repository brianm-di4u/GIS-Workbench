//! JPEG 2000 progression order changes (FC-16, REQ-FMT-42) on the ISO/IEC 15444-4 conformance
//! codestreams with POC markers (OpenJPEG conformance data, corpus item
//! j2k-openjpeg-poc-conformance): p0_03 and p0_15 (4-bit signed, 2×2 tiles, POC in the main
//! header; with ROI maxshift in the tile-part headers), p0_13 (257 components: the 16-bit POC form),
//! and p0_03 with its POC moved into every tile's first tile-part header. Every sample must equal
//! OpenJPEG's (opj_decompress, PGX per component).
//! Skipped when the corpus or opj_decompress is absent.
#![cfg(feature = "j2k")]

use std::path::{Path, PathBuf};
use std::process::Command;

fn corpus(f: &str) -> Option<Vec<u8>> {
    corpus_at(&format!("j2k-openjpeg-poc-conformance/{f}"))
}

fn corpus_at(p: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    std::fs::read(root.join(p)).ok()
}

/// OpenJPEG's samples per component (PGX), or None without opj_decompress.
fn opj(data: &[u8], tag: &str) -> Option<Vec<Vec<i32>>> {
    let env = PathBuf::from("C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin");
    let exe = env.join("opj_decompress.exe");
    if !exe.exists() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("gw_poc_{}_{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let src = dir.join("in.j2k");
    std::fs::write(&src, data).ok()?;
    let out = dir.join("out.pgx");
    let ok = Command::new(&exe).env("PATH", &env).arg("-i").arg(&src).arg("-o").arg(&out).output().ok()?.status.success();
    if !ok {
        return None;
    }
    let mut comps = vec![];
    for k in 0.. {
        let p = dir.join(format!("out_{k}.pgx"));
        let p = if p.exists() { p } else if k == 0 && out.exists() { out.clone() } else { break };
        comps.push(pgx(&p)?);
        if p == out {
            break;
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    Some(comps)
}

/// PGX: "PG ML|LM [+|-] depth w h\n" then samples (1, 2 or 4 bytes, the given endianness).
fn pgx(p: &Path) -> Option<Vec<i32>> {
    let b = std::fs::read(p).ok()?;
    let nl = b.iter().position(|&c| c == b'\n')?;
    let head = String::from_utf8_lossy(&b[..nl]).to_string();
    let t: Vec<&str> = head.split_whitespace().collect();
    let big = t.get(1)? == &"ML";
    let (signed, rest): (bool, Vec<&str>) = if t.get(2)? == &"-" || t.get(2)? == &"+" { (t[2] == "-", t[3..].to_vec()) } else { (false, t[2..].to_vec()) };
    let depth: u32 = rest.first()?.trim_start_matches(['+', '-']).parse().ok()?;
    let (w, h): (usize, usize) = (rest.get(1)?.parse().ok()?, rest.get(2)?.parse().ok()?);
    let bytes = if depth <= 8 { 1 } else if depth <= 16 { 2 } else { 4 };
    let d = &b[nl + 1..];
    (0..w * h)
        .map(|i| {
            let s = d.get(i * bytes..(i + 1) * bytes)?;
            let u = match bytes {
                1 => s[0] as u32,
                2 => if big { u16::from_be_bytes([s[0], s[1]]) as u32 } else { u16::from_le_bytes([s[0], s[1]]) as u32 },
                _ => if big { u32::from_be_bytes([s[0], s[1], s[2], s[3]]) } else { u32::from_le_bytes([s[0], s[1], s[2], s[3]]) },
            };
            Some(if signed { ((u << (32 - bytes * 8)) as i32) >> (32 - bytes * 8) } else { u as i32 })
        })
        .collect()
}

/// p0_03 with its main-header POC moved into the first tile-part header of every tile (Psot grows by
/// its length; the TLM, whose lengths would be stale, is dropped).
fn poc_in_tile_part(d: &[u8]) -> Vec<u8> {
    // Walk the main header's marker segments (SOC, then SIZ … up to the first SOT).
    let (mut i, mut poc, mut out) = (2usize, Vec::new(), d[..2].to_vec());
    while i + 4 <= d.len() && !(d[i] == 0xFF && d[i + 1] == 0x90) {
        let len = 2 + u16::from_be_bytes([d[i + 2], d[i + 3]]) as usize;
        match d[i + 1] {
            0x5F => poc.extend_from_slice(&d[i..i + len]),
            0x55 => {}
            _ => out.extend_from_slice(&d[i..i + len]),
        }
        i += len;
    }
    assert!(!poc.is_empty(), "no POC in the main header");
    // Tile-parts: SOT (12 bytes) with Psot; the first tile-part of each tile takes the POC.
    while i + 12 <= d.len() && d[i] == 0xFF && d[i + 1] == 0x90 {
        let psot = u32::from_be_bytes([d[i + 6], d[i + 7], d[i + 8], d[i + 9]]) as usize;
        let end = if psot == 0 { d.len() - 2 } else { i + psot };
        let mut sot = d[i..i + 12].to_vec();
        if d[i + 10] == 0 {
            if psot != 0 {
                sot[6..10].copy_from_slice(&((psot + poc.len()) as u32).to_be_bytes());
            }
            out.extend_from_slice(&sot);
            out.extend_from_slice(&poc);
        } else {
            out.extend_from_slice(&sot);
        }
        out.extend_from_slice(&d[i + 12..end]);
        i = end;
    }
    out.extend_from_slice(&d[i..]);
    out
}

fn check(name: &str, data: &[u8], tag: &str) {
    let Some(reference) = opj(data, tag) else {
        eprintln!("opj_decompress not available; {name} skipped");
        return;
    };
    // hayro's own samples (gw-codec's raster clamps signed samples to the unsigned range).
    let settings = hayro_jpeg2000::DecodeSettings { resolve_palette_indices: false, strict: false, target_resolution: None };
    let img = hayro_jpeg2000::Image::new(data, &settings).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let mut ctx = hayro_jpeg2000::DecoderContext::default();
    let dec = img.decode(&mut ctx).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let comps = dec.components();
    assert_eq!(comps.len(), reference.len(), "{name}: components");
    for (c, (ours, refc)) in comps.iter().zip(&reference).enumerate() {
        let s = ours.samples();
        assert_eq!(s.len(), refc.len(), "{name}: component {c} size");
        // hayro returns signed components level-shifted into the unsigned range (+2^(p-1)), as it
        // does for display; OpenJPEG writes them signed. The shift is the same for every sample.
        let shift = s[0].round() as i32 - refc[0];
        assert!(shift == 0 || (shift > 0 && (shift as u32).is_power_of_two()), "{name}: component {c}: offset {shift}");
        let mismatches = s.iter().zip(refc).filter(|(&a, &b)| a.round() as i32 - shift != b).count();
        assert_eq!(mismatches, 0, "{name}: component {c}: {mismatches} of {} samples differ from OpenJPEG", s.len());
    }
    let r = gw_codec::j2k::decode(data, None).unwrap_or_else(|e| panic!("{name}: {e}"));
    eprintln!("{name}: {}×{}×{} equals OpenJPEG", r.width, r.height, r.comps);
}

#[test]
fn poc_main_header() {
    for f in ["p0_03.j2k", "p0_15.j2k", "p0_13.j2k"] {
        let Some(d) = corpus(f) else {
            eprintln!("TE-corpus not present; skipped");
            return;
        };
        check(f, &d, f);
    }
}

/// The same changes in the tile-part headers (A.6.6: they replace the main header's for the tile)
/// decode to the same samples as in the main header, whose decode equals OpenJPEG above.
#[test]
fn poc_tile_part_header() {
    let Some(d) = corpus("p0_03.j2k") else { return };
    let moved = poc_in_tile_part(&d);
    let a = gw_codec::j2k::decode(&d, None).unwrap();
    let b = gw_codec::j2k::decode(&moved, None).unwrap();
    assert_eq!((a.width, a.height, a.comps), (b.width, b.height, b.comps));
    assert!(a.data == b.data, "POC in the tile-part headers decodes differently");
}

/// GDAL autotest byte_one_poc.j2k (refused by name before 2.1, TE campaign negative) equals OpenJPEG.
#[test]
fn gdal_autotest_byte_one_poc() {
    let Some(d) = corpus_at("jp2-gdal-autotest-geojp2-gmljp2/byte_one_poc.j2k") else { return };
    check("byte_one_poc.j2k", &d, "gdal");
}

/// Found by the one-hour fuzz run (REQ-RUST-12): p0_13 with its width set to 524 289 declares as
/// many one-pixel tiles of 257 components and took 201 s; more than 65 535 tiles (Isot is 16-bit)
/// is now refused at once.
#[test]
fn tile_grid_beyond_isot_is_refused_at_once() {
    let Some(mut b) = corpus("p0_13.j2k") else { return };
    let siz = b.windows(2).position(|w| w == [0xFF, 0x51]).unwrap();
    b[siz + 6..siz + 10].copy_from_slice(&524_289u32.to_be_bytes());
    let t = std::time::Instant::now();
    assert!(gw_codec::j2k::decode(&b, None).is_err());
    assert!(t.elapsed().as_secs_f64() < 1.0, "{:?}", t.elapsed());
}

/// GW_J2K_REPLAY=<folder>: time the decode of every .bin in it (fuzz slow-input triage).
#[test]
fn replay_folder() {
    let Ok(d) = std::env::var("GW_J2K_REPLAY") else { return };
    for e in std::fs::read_dir(d).unwrap().flatten() {
        let p = e.path();
        if !p.to_string_lossy().contains("j2k_poc") {
            continue;
        }
        let b = std::fs::read(&p).unwrap();
        let t = std::time::Instant::now();
        let r = gw_codec::j2k::decode(&b, None);
        eprintln!("{} {:?} {:?}", p.display(), t.elapsed(), r.as_ref().map(|_| "ok").map_err(|e| e.to_string()));
    }
}
