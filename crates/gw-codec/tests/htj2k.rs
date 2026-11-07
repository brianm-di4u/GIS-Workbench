//! HTJ2K (REQ-FMT-17) on streams encoded by OpenJPH (C++), from build/fixtures/gen-htj2k.py:
//! lossless cases (tiled 11-bit, 16-bit, RGB with the RCT) bit-exact to the source pixels; the
//! 9/7 + ICT case within one count of OpenJPEG's decode; reduced resolution equal to OpenJPEG's.
#![cfg(feature = "j2k")]

use std::path::PathBuf;

fn fx(f: &str) -> Vec<u8> {
    std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/htj2k").join(f)).expect(f)
}

fn reference(f: &str, u8s: bool) -> Vec<u16> {
    let d = fx(f);
    if u8s {
        d.into_iter().map(u16::from).collect()
    } else {
        d.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
    }
}

#[test]
fn detects_part15_codestreams() {
    assert!(gw_codec::j2k::is_htj2k(&fx("ht_mono16.j2c")));
    // A Part 1 header (Rsiz 0, no CAP) is not HTJ2K.
    let part1 = [0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x29, 0x00, 0x00, 0xFF, 0x90];
    assert!(!gw_codec::j2k::is_htj2k(&part1));
}

#[test]
fn mono11_tiled_lossless() {
    let r = gw_codec::j2k::decode(&fx("ht_mono11_tiles.j2c"), None).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (517, 389, 1, 11));
    assert!(r.data == reference("ht_mono11_tiles.ref", false), "not bit-exact");
}

#[test]
fn mono11_reduced_resolution_matches_openjpeg() {
    let r = gw_codec::j2k::decode(&fx("ht_mono11_tiles.j2c"), Some((120, 90))).expect("decode");
    assert_eq!((r.width, r.height), (130, 98));
    let want = reference("ht_mono11_tiles_skip2.ref", false);
    let worst = r.data.iter().zip(&want).map(|(a, b)| (*a as i32 - *b as i32).abs()).max().unwrap();
    assert_eq!(worst, 0, "differs from OpenJPEG by up to {worst}");
}

#[test]
fn mono16_lossless() {
    let r = gw_codec::j2k::decode(&fx("ht_mono16.j2c"), None).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (128, 96, 1, 16));
    assert!(r.data == reference("ht_mono16.ref", false));
}

#[test]
fn rgb8_irreversible_matches_openjpeg() {
    let r = gw_codec::j2k::decode(&fx("ht_rgb8_lossy.j2c"), None).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (301, 203, 3, 8));
    let want = reference("ht_rgb8_lossy.ref", true);
    let diffs: Vec<i32> = r.data.iter().zip(&want).map(|(a, b)| (*a as i32 - *b as i32).abs()).collect();
    let worst = *diffs.iter().max().unwrap();
    let off = diffs.iter().filter(|&&d| d > 0).count();
    eprintln!("RGB 9/7: worst {worst}, {off} of {} samples differ", diffs.len());
    assert!(worst <= 1, "worst difference {worst}");
}

#[test]
fn rgb8_rct_lossless() {
    let r = gw_codec::j2k::decode(&fx("ht_rgb8_rct.j2c"), None).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (301, 203, 3, 8));
    assert!(r.data == reference("ht_rgb8_rct.ref", true));
}

#[test]
fn truncated_streams_fail_cleanly() {
    let d = fx("ht_mono16.j2c");
    for cut in [12usize, 60, 200, d.len() / 2] {
        let _ = gw_codec::j2k::decode(&d[..cut], None); // an error or a partial image, never a hang
    }
}

