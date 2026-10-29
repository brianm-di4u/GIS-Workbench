//! Tile-window JPEG 2000 decodes (gw_codec::j2k::decode_region) against whole-image decodes of the
//! same codestream, on T&E corpus files (skipped when the corpus is absent):
//!   - Sentinel-2 L1C B02 (10980², 1024² tiles): windows inside, across and at the edge of tiles
//!     equal the same pixels of the whole decode;
//!   - a full WorldView-3 PAN NITF strip (43008 × 31744, 1.37 G samples, above the whole-image
//!     limit): a window decodes, and a reduced-resolution decode of the whole strip is allowed.

#![cfg(feature = "j2k")]
use std::path::PathBuf;

fn corpus(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    std::fs::read(root.join(rel)).ok()
}

const S2_B02: &str = "s2-l1c-jp2-safe-10seh-20240816/S2B_MSIL1C_20240816T184919_N0511_R113_T10SEH_20240816T222835.SAFE/GRANULE/L1C_T10SEH_A038892_20240816T185441/IMG_DATA/T10SEH_20240816T184919_B02.jp2";
const WV3_PAN: &str = "nitf-mvs-wv3-buenos-aires/PAN/07JAN16WV031000016JAN07142142-P1BS-500537128030_01_P001_________AAE_0AAAAABPABE0.NTF";

#[test]
fn s2_windows_equal_the_whole_decode() {
    let Some(d) = corpus(S2_B02) else { return };
    let whole = gw_codec::j2k::decode(&d, None).expect("whole");
    let ww = whole.width as usize;
    for (x, y, w, h) in [(100, 200, 300, 300), (1000, 1000, 100, 100), (10900, 10900, 80, 80), (0, 0, 2048, 1)] {
        let (ox, oy, r) = gw_codec::j2k::decode_region(&d, x, y, w, h, 0).expect("window");
        assert!(ox <= x && oy <= y && ox + r.width >= (x + w).min(10980) && oy + r.height >= (y + h).min(10980), "window covers the request");
        for j in 0..r.height as usize {
            let a = &r.data[j * r.width as usize..(j + 1) * r.width as usize];
            let s = (oy as usize + j) * ww + ox as usize;
            assert_eq!(a, &whole.data[s..s + r.width as usize], "row {j} of window at {x},{y}");
        }
    }
}

#[test]
fn wv3_strip_window_and_reduced_decode() {
    let Some(d) = corpus(WV3_PAN) else { return };
    assert!(gw_codec::j2k::decode(&d, None).is_err(), "1.37 G samples stay above the whole-image limit");
    let (ox, oy, r) = gw_codec::j2k::decode_region(&d, 20_000, 15_000, 1500, 700, 0).expect("window");
    // Rows 15000..15700 cross the tile boundary at 15360: two tile rows.
    assert_eq!((ox, oy, r.width, r.height), (19_456, 14_336, 2048, 2048));
    assert!(r.data.iter().any(|&v| v > 0), "window holds data");
    let small = gw_codec::j2k::decode(&d, Some((43008 / 32, 31744 / 32))).expect("reduced");
    assert_eq!((small.width, small.height), (1344, 992));
}

#[test]
fn s2_reduced_windows_equal_the_reduced_whole_decode() {
    let Some(d) = corpus(S2_B02) else { return };
    // The B02 codestream has four decomposition levels (COD), so 4 is the coarsest native level.
    for l in [1u32, 2, 4] {
        let f = 1u32 << l;
        let whole = gw_codec::j2k::decode(&d, Some((10980 / f, 10980 / f))).expect("reduced whole");
        assert_eq!(whole.width, 10980u32.div_ceil(f));
        let ww = whole.width as usize;
        // An interior tile and the last (partial, 740 px) tile column and row.
        for (x, y) in [(2048u32, 3072u32), (10500, 10500)] {
            let (ox, oy, r) = gw_codec::j2k::decode_region(&d, x, y, 1, 1, l).expect("window");
            let (lx, ly) = ((ox / f) as usize, (oy / f) as usize);
            for j in 0..r.height as usize {
                let a = &r.data[j * r.width as usize..(j + 1) * r.width as usize];
                let s = (ly + j) * ww + lx;
                assert_eq!(a, &whole.data[s..s + r.width as usize], "level {l} row {j} of tile at {x},{y}");
            }
        }
    }
}

#[test]
fn poc_codestream_is_refused_by_name() {
    let Some(d) = corpus("jp2-gdal-autotest-geojp2-gmljp2/byte_one_poc.j2k") else { return };
    let Err(e) = gw_codec::j2k::decode(&d, None) else { panic!("POC is not decoded") };
    assert!(format!("{e}").contains("progression order change (POC marker)"), "{e}");
}

/// Tile-parts of one tile (offsets in `d`), walking SOT headers after the main header.
fn tile_parts(d: &[u8], tile: u16) -> (usize, usize, Vec<(usize, usize)>) {
    let soc = d.windows(4).position(|w| w == b"\xFF\x4F\xFF\x51").unwrap();
    let mut i = soc + 2;
    while u16::from_be_bytes([d[i], d[i + 1]]) != 0xFF90 {
        i += 2 + usize::from(u16::from_be_bytes([d[i + 2], d[i + 3]]));
    }
    let main_end = i;
    let mut parts = Vec::new();
    while i + 12 <= d.len() && u16::from_be_bytes([d[i], d[i + 1]]) == 0xFF90 {
        let t = u16::from_be_bytes([d[i + 4], d[i + 5]]);
        let psot = u32::from_be_bytes([d[i + 6], d[i + 7], d[i + 8], d[i + 9]]) as usize;
        if t == tile {
            parts.push((i, psot));
        }
        if psot == 0 {
            break;
        }
        i += psot;
    }
    (soc, main_end, parts)
}

#[test]
fn wv3_reduced_tile_needs_only_its_resolution_tile_parts() {
    // Maxar's RLCP codestreams split each tile into one tile-part per resolution (TNsot = NL + 1):
    // a level-L decode from the first NL + 1 − L parts equals the decode from all of them.
    let Some(d) = corpus(WV3_PAN) else { return };
    let (soc, main_end, parts) = tile_parts(&d, 600);
    assert_eq!(parts.len(), 6, "one tile-part per resolution (NL = 5)");
    let build = |k: usize| {
        let mut v = d[soc..main_end].to_vec();
        for &(o, l) in &parts[..k] {
            v.extend_from_slice(&d[o..o + l]);
        }
        v.extend_from_slice(b"\xFF\xD9");
        v
    };
    let all = build(6);
    for l in 1..=5u32 {
        let (x, y) = ((600 % 42) * 1024, (600 / 42) * 1024);
        let (_, _, a) = gw_codec::j2k::decode_region(&all, x, y, 1, 1, l).expect("all parts");
        let (_, _, b) = gw_codec::j2k::decode_region(&build(6 - l as usize), x, y, 1, 1, l).expect("resolution parts");
        assert_eq!((a.width, a.height), (b.width, b.height));
        assert_eq!(a.data, b.data, "level {l}");
    }
}

const WV3_MSI: &str = "nitf-core3d-jacksonville-wv3/MSI/21JAN15WV031100015JAN21161243-M1BS-500648061050_01_P001_________GA_E0AAAAAAKAAL0.NTF";

#[test]
fn wv3_eight_band_msi_decodes() {
    // 8-band WorldView-3 MS NITF (11264 × 12288 × 8): no colour space, all eight components kept.
    let Some(d) = corpus(WV3_MSI) else { return };
    let (ox, oy, r) = gw_codec::j2k::decode_region(&d, 5000, 6000, 10, 10, 0).expect("window");
    assert_eq!((ox, oy, r.comps, r.width, r.height), (4096, 5120, 8, 1024, 1024));
    let (_, _, s) = gw_codec::j2k::decode_region(&d, 5000, 6000, 10, 10, 3).expect("level 3");
    assert_eq!((s.comps, s.width, s.height), (8, 128, 128));
    // GDAL 3.x (OpenJPEG) reads bands 1–8 at image (5000, 6000) as these values.
    let at = |c: usize, x: u32, y: u32| r.data[c * 1024 * 1024 + ((y - oy) * 1024 + (x - ox)) as usize];
    assert_eq!((0..8).map(|c| at(c, 5000, 6000)).collect::<Vec<_>>(), vec![178, 241, 263, 121, 97, 189, 413, 269]);
}
