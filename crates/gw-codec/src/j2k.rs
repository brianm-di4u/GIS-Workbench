//! JPEG 2000 (NITF IC=C8/M8, GeoJP2) and HTJ2K (Part 15, REQ-FMT-17) through hayro-jpeg2000
//! (pure Rust; vendored with HT code-block decoding, crates/vendor). Samples keep their full bit
//! depth; `target` asks the decoder for a reduced resolution (overview levels).

use crate::jpeg::Raster;
use gw_abi::{Error, Result};
use hayro_jpeg2000::{DecodeSettings, DecoderContext, Image};

/// Limits checked from the SIZ marker before decoding: a hostile header can otherwise claim
/// billions of samples or millions of tiles and keep the decoder busy for minutes.
pub const MAX_SAMPLES: u64 = 400_000_000;
pub const MAX_TILES: u64 = 1 << 20;

fn check_siz(d: &[u8]) -> Result<()> {
    let i = d.windows(2).position(|w| w == [0xFF, 0x51]).ok_or_else(|| Error::invalid("JPEG 2000: no SIZ marker"))?;
    let s = d.get(i + 2..i + 40).ok_or_else(|| Error::range("JPEG 2000: short SIZ marker"))?;
    let u32at = |o: usize| u64::from(u32::from_be_bytes([s[o], s[o + 1], s[o + 2], s[o + 3]]));
    let (x, y, xo, yo) = (u32at(4), u32at(8), u32at(12), u32at(16));
    let (tx, ty, txo, tyo) = (u32at(20), u32at(24), u32at(28), u32at(32));
    let c = u64::from(u16::from_be_bytes([s[36], s[37]]));
    if x <= xo || y <= yo || tx == 0 || ty == 0 || c == 0 || txo > xo || tyo > yo {
        return Err(Error::invalid("JPEG 2000: inconsistent image or tile size in SIZ"));
    }
    let samples = (x - xo).saturating_mul(y - yo).saturating_mul(c);
    let tiles = (x - txo).div_ceil(tx).saturating_mul((y - tyo).div_ceil(ty));
    if samples > MAX_SAMPLES {
        return Err(Error::limit(format!("JPEG 2000: {}×{}×{c} samples exceed the decoder limit", x - xo, y - yo)));
    }
    if tiles > MAX_TILES {
        return Err(Error::limit(format!("JPEG 2000: {tiles} tiles exceed the decoder limit")));
    }
    Ok(())
}

/// HTJ2K (Part 15) codestream: Rsiz bit 14 in SIZ, or a CAP marker whose Pcap flags Part 15
/// (Pcap's most significant bit is Part 1, so Part 15 is 0x0002_0000).
pub fn is_htj2k(cs: &[u8]) -> bool {
    if cs.len() < 8 || cs[..4] != [0xFF, 0x4F, 0xFF, 0x51] {
        return false;
    }
    if cs[6] & 0x40 != 0 {
        return true;
    }
    let mut i = 2usize;
    while i + 4 <= cs.len() {
        let m = u16::from_be_bytes([cs[i], cs[i + 1]]);
        if m == 0xFF90 || m == 0xFFD9 {
            break; // SOT or EOC: end of the main header
        }
        if m == 0xFF50 {
            return cs.get(i + 5).is_some_and(|b| b & 0x02 != 0);
        }
        let l = usize::from(u16::from_be_bytes([cs[i + 2], cs[i + 3]]));
        if l < 2 {
            break;
        }
        i += 2 + l;
    }
    false
}

pub fn decode(data: &[u8], target: Option<(u32, u32)>) -> Result<Raster> {
    let start = (0..data.len().saturating_sub(8).min(4096))
        .find(|&i| data[i..].starts_with(b"\xFF\x4F\xFF\x51") || data[i..].starts_with(b"\x00\x00\x00\x0C\x6A\x50\x20\x20"))
        .ok_or_else(|| Error::invalid("JPEG 2000: no codestream or JP2 signature"))?;
    check_siz(&data[start..])?;
    let settings = DecodeSettings { resolve_palette_indices: false, strict: false, target_resolution: target };
    let img = Image::new(&data[start..], &settings).map_err(|e| Error::invalid(format!("JPEG 2000: {e:?}")))?;
    let mut ctx = DecoderContext::default();
    let dec = img.decode(&mut ctx).map_err(|e| Error::invalid(format!("JPEG 2000: {e:?}")))?;
    let comps = dec.components();
    if comps.is_empty() {
        return Err(Error::invalid("JPEG 2000: no components"));
    }
    let n = comps[0].samples().len();
    let bits = comps.iter().map(|c| c.bit_depth() as u32).max().unwrap_or(8).min(16);
    let (w, h) = (img.width(), img.height());
    // The decoded size follows the requested resolution; derive it from the sample count.
    let (ow, oh) = if (w as usize) * (h as usize) == n {
        (w, h)
    } else {
        let f = ((w as f64 * h as f64) / n as f64).sqrt().round().max(1.0) as u32;
        let (ow, oh) = (w.div_ceil(f), h.div_ceil(f));
        if (ow as usize) * (oh as usize) != n {
            return Err(Error::invalid("JPEG 2000: unexpected decoded size"));
        }
        (ow, oh)
    };
    let mut out = Vec::with_capacity(n * comps.len());
    for c in comps {
        let max = ((1u32 << c.bit_depth().min(16)) - 1) as f32;
        out.extend(c.samples().iter().map(|&v| v.round().clamp(0.0, max) as u16));
    }
    Ok(Raster { width: ow, height: oh, comps: comps.len() as u32, bits, data: out })
}
