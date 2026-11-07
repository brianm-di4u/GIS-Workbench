//! Codec checks on the research samples against GDAL autotest values (the oracle):
//! U_4017A mean 2385–2386 (12-bit JPEG), p0_01a band-1 checksum 1054 (JPEG 2000).

use std::path::PathBuf;

fn sample(dir: &str, f: &str) -> Option<Vec<u8>> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../Research/samples").join(dir).join(f);
    std::fs::read(p).ok()
}

fn find(d: &[u8], pat: &[u8]) -> usize {
    d.windows(pat.len()).position(|w| w == pat).expect("signature")
}

/// GDALChecksumImage over one band (integer data).
pub fn gdal_checksum(v: &[u16], w: usize, h: usize) -> u32 {
    const P: [u32; 11] = [7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43];
    let (mut sum, mut ip) = (0u32, 0usize);
    for y in 0..h {
        for x in 0..w {
            sum = (sum + v[y * w + x] as u32 % P[ip]) & 0xffff;
            ip = if ip >= 10 { 0 } else { ip + 1 };
        }
    }
    sum
}

#[test]
fn jpeg_default_tables_u_1005a() {
    let Some(d) = sample("nitf-jitc-jpeg-c3", "U_1005a.ntf") else { return };
    let r = gw_codec::jpeg::decode(&d[find(&d, b"\xFF\xD8\xFF")..], 0, 0).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (64, 64, 1, 8));
    let mean = r.data.iter().map(|&v| v as f64).sum::<f64>() / r.data.len() as f64;
    let (mn, mx) = (r.data.iter().min().unwrap(), r.data.iter().max().unwrap());
    assert!(mx > mn, "flat image");
    eprintln!("U_1005a mean {mean:.2} range {mn}..{mx}");
}

#[test]
fn jpeg_12bit_u_4017a_matches_gdal_mean() {
    let Some(d) = sample("nitf-jitc-jpeg-c3", "U_4017a.ntf") else { return };
    let r = gw_codec::jpeg::decode(&d[find(&d, b"\xFF\xD8\xFF")..], 0, 0).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (64, 64, 1, 12));
    let mean = r.data.iter().map(|&v| v as f64).sum::<f64>() / r.data.len() as f64;
    assert!((2385.0..=2386.0).contains(&mean), "mean {mean}");
}

#[test]
fn jpeg_rgb_u_2005a() {
    let Some(d) = sample("nitf-jitc-jpeg-c3", "U_2005a.ntf") else { return };
    let r = gw_codec::jpeg::decode(&d[find(&d, b"\xFF\xD8\xFF")..], 0, 0).expect("decode");
    assert_eq!((r.width, r.height, r.comps, r.bits), (256, 256, 3, 8));
}

#[cfg(feature = "j2k")]
#[test]
fn j2k_p0_01a_matches_gdal_checksum() {
    let Some(d) = sample("nitf-ntb-j2k-p0_01", "p0_01a.ntf") else { return };
    let r = gw_codec::j2k::decode(&d[find(&d, b"\xFF\x4F\xFF\x51")..], None).expect("decode");
    let n = (r.width * r.height) as usize;
    assert_eq!(gdal_checksum(&r.data[..n], r.width as usize, r.height as usize), 1054, "{}x{}x{} {} bits", r.width, r.height, r.comps, r.bits);
}

#[cfg(feature = "j2k")]
#[test]
fn j2k_wv3_chip_is_lossless_against_the_uncompressed_chip() {
    let (Some(j), Some(nc)) = (sample("nitf-wv3-mvs-stereo-chips", "wv3_a_chip_j2k.ntf"), sample("nitf-wv3-mvs-stereo-chips", "wv3_a_chip.ntf")) else { return };
    let r = gw_codec::j2k::decode(&j[find(&j, b"\xFF\x4F\xFF\x51")..], None).expect("decode");
    assert_eq!((r.width, r.height, r.comps), (1536, 1536, 1));
    // Uncompressed chip: 3×3 blocks of 512×512 big-endian u16 at the end of the file.
    let n = 1536 * 1536;
    let base = nc.len() - n * 2;
    let mut diff = 0usize;
    for y in 0..1536usize {
        for x in 0..1536usize {
            let b = (y / 512) * 3 + x / 512;
            let o = base + (b * 512 * 512 + (y % 512) * 512 + x % 512) * 2;
            let v = u16::from_be_bytes([nc[o], nc[o + 1]]);
            if v != r.data[y * 1536 + x] {
                diff += 1;
            }
        }
    }
    assert_eq!(diff, 0, "{diff} pixels differ");
}
