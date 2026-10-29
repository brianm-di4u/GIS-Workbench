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
/// A reduced-resolution decode only reconstructs the levels it returns, so the source may be larger
/// (a full WorldView-3 strip is ~1.5 G samples); this caps what a hostile header can claim.
pub const MAX_REDUCED_SOURCE: u64 = 16_000_000_000;

/// What hayro's "Marker(Unsupported)" refers to, from the main header: a progression order change,
/// mixed HTJ2K / Part 1 code-blocks, or the first marker it does not know.
fn unsupported_feature(d: &[u8]) -> String {
    let Some(soc) = d.windows(4).position(|w| w == [0xFF, 0x4F, 0xFF, 0x51]) else { return "this codestream".into() };
    // The main header, then the first tile-part header (SOT … SOD), where POC may also sit.
    let mut i = soc + 2;
    let mut in_tile = false;
    while i + 4 <= d.len() {
        let m = u16::from_be_bytes([d[i], d[i + 1]]);
        match m {
            0xFF90 if !in_tile => in_tile = true,
            0xFF93 | 0xFFD9 | 0xFF90 => break,
            0xFF5F => return "a progression order change (POC marker)".into(),
            0xFF51..=0xFF5E | 0xFF60..=0xFF64 | 0xFF50 | 0xFF55 | 0xFF59 => {}
            0xFF30..=0xFF3F => {
                i += 2;
                continue;
            }
            _ => return format!("marker 0x{m:04X}"),
        }
        i += 2 + usize::from(u16::from_be_bytes([d[i + 2], d[i + 3]]));
    }
    "mixed HTJ2K and Part 1 code-blocks".into()
}

/// Xsiz, Ysiz, XOsiz, YOsiz of the first SIZ marker.
fn siz_extent(d: &[u8]) -> Option<(u32, u32, u32, u32)> {
    let i = d.windows(4).position(|w| w == [0xFF, 0x4F, 0xFF, 0x51])? + 2;
    let s = d.get(i + 6..i + 22)?;
    let u = |o: usize| u32::from_be_bytes([s[o], s[o + 1], s[o + 2], s[o + 3]]);
    Some((u(0), u(4), u(8), u(12)))
}

fn check_siz(d: &[u8], target: Option<(u32, u32)>) -> Result<()> {
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
    let out = match target {
        Some((tw, th)) => u64::from(tw).saturating_mul(u64::from(th)).saturating_mul(c),
        None => samples,
    };
    if out > MAX_SAMPLES || samples > MAX_REDUCED_SOURCE {
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
    check_siz(&data[start..], target)?;
    let settings = DecodeSettings { resolve_palette_indices: false, strict: false, target_resolution: target };
    let named = |e: hayro_jpeg2000::DecodeError| {
        let d = format!("{e:?}");
        if d.contains("Unsupported") {
            Error::unsupported(format!("JPEG 2000: {} is not decoded in this release", unsupported_feature(&data[start..])))
        } else {
            Error::invalid(format!("JPEG 2000: {d}"))
        }
    };
    let img = Image::new(&data[start..], &settings).map_err(named)?;
    let mut ctx = DecoderContext::default();
    let dec = img.decode(&mut ctx).map_err(named)?;
    let comps = dec.components();
    if comps.is_empty() {
        return Err(Error::invalid("JPEG 2000: no components"));
    }
    let n = comps[0].samples().len();
    let bits = comps.iter().map(|c| c.bit_depth() as u32).max().unwrap_or(8).min(16);
    let (w, h) = (img.width(), img.height());
    // The decoded size follows the requested resolution; derive it from the sample count. With an
    // image offset (a tile window) the reduced extent is ceil(Xsiz/f) − ceil(XOsiz/f), not ceil(w/f).
    let siz = siz_extent(&data[start..]);
    let (ow, oh) = (0..16)
        .map(|k| 1u32 << k)
        .flat_map(|f| {
            let off = siz.map(|(xs, ys, xo, yo)| (xs.div_ceil(f) - xo.div_ceil(f), ys.div_ceil(f) - yo.div_ceil(f)));
            [Some((w.div_ceil(f), h.div_ceil(f))), off]
        })
        .flatten()
        .find(|&(a, b)| (a as usize) * (b as usize) == n)
        .ok_or_else(|| Error::invalid("JPEG 2000: unexpected decoded size"))?;
    let mut out = Vec::with_capacity(n * comps.len());
    for c in comps {
        let max = ((1u32 << c.bit_depth().min(16)) - 1) as f32;
        out.extend(c.samples().iter().map(|&v| v.round().clamp(0.0, max) as u16));
    }
    Ok(Raster { width: ow, height: oh, comps: comps.len() as u32, bits, data: out })
}

/// Full-resolution window of a tiled codestream: the tiles that intersect `x, y, w, h` (image
/// pixels from the image origin) are re-wrapped as a codestream of their own (SIZ moved to the
/// tile-aligned window, tile indices renumbered, TLM dropped) and decoded alone. Code-block and
/// precinct partitions stay anchored to the reference grid, so the samples equal the same pixels of
/// a whole-image decode. `reduce` > 0 decodes resolution level 1/2^reduce (each tile skips its finer
/// resolutions; tile sizes are multiples of 2^reduce in practice, so windows tile the reduced image).
/// Returns the window's origin (full-resolution image pixels) and its raster at that level.
/// Refused (the caller falls back to a whole or reduced decode) for PPM headers and subsampled components.
pub fn decode_region(data: &[u8], x: u32, y: u32, w: u32, h: u32, reduce: u32) -> Result<(u32, u32, Raster)> {
    let s0 = data.windows(4).position(|q| q == b"\xFF\x4F\xFF\x51").ok_or_else(|| Error::invalid("JPEG 2000: no codestream"))?;
    let cs = &data[s0..];
    let be16 = |o: usize| -> Result<u32> { cs.get(o..o + 2).map(|b| u32::from(u16::from_be_bytes([b[0], b[1]]))).ok_or_else(|| Error::range("JPEG 2000: truncated header")) };
    let be32 = |o: usize| -> Result<u32> { cs.get(o..o + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]])).ok_or_else(|| Error::range("JPEG 2000: truncated header")) };
    // Main header: every marker segment up to the first SOT.
    let (mut i, mut siz, mut segs) = (2usize, 0usize, Vec::new());
    loop {
        let m = be16(i)?;
        if m == 0xFF90 {
            break;
        }
        let l = be16(i + 2)? as usize;
        if l < 2 {
            return Err(Error::invalid("JPEG 2000: bad marker length"));
        }
        match m {
            0xFF51 => siz = i,
            0xFF60 => return Err(Error::unsupported("JPEG 2000: PPM packet headers (window decode)")),
            _ => {}
        }
        if m != 0xFF55 {
            segs.push((i, i + 2 + l));
        }
        i += 2 + l;
    }
    let first_sot = i;
    let (xs, ys, xo, yo) = (be32(siz + 6)?, be32(siz + 10)?, be32(siz + 14)?, be32(siz + 18)?);
    let (tx, ty, txo, tyo) = (be32(siz + 22)?, be32(siz + 26)?, be32(siz + 30)?, be32(siz + 34)?);
    let nc = be16(siz + 38)? as usize;
    if tx == 0 || ty == 0 || xs <= xo || ys <= yo || w == 0 || h == 0 {
        return Err(Error::invalid("JPEG 2000: inconsistent SIZ"));
    }
    for c in 0..nc {
        if cs.get(siz + 41 + 3 * c..siz + 43 + 3 * c) != Some(&[1, 1][..]) {
            return Err(Error::unsupported("JPEG 2000: subsampled components (window decode)"));
        }
    }
    let ntx = (xs - txo).div_ceil(tx);
    let (ax, ay) = (xo.saturating_add(x).min(xs - 1), yo.saturating_add(y).min(ys - 1));
    let (bx, by) = (xo.saturating_add(x).saturating_add(w - 1).min(xs - 1), yo.saturating_add(y).saturating_add(h - 1).min(ys - 1));
    let (c0, c1, r0, r1) = ((ax - txo) / tx, (bx - txo) / tx, (ay - tyo) / ty, (by - tyo) / ty);
    let (ntx2, wtxo, wtyo) = (c1 - c0 + 1, txo + c0 * tx, tyo + r0 * ty);
    let (wxo, wyo) = (xo.max(wtxo), yo.max(wtyo));
    let (wxs, wys) = (xs.min(wtxo.saturating_add((c1 - c0 + 1) * tx)), ys.min(wtyo.saturating_add((r1 - r0 + 1) * ty)));
    // hayro reconstructs no coefficients at a reduced resolution when the image starts away from the
    // canvas origin, so the window is moved there: a shift by whole power-of-two tiles (grid at 0)
    // keeps every code-block and precinct partition and the parity of every wavelet split.
    let shifts = txo == 0 && tyo == 0 && tx.is_power_of_two() && ty.is_power_of_two();
    if !shifts && reduce > 0 {
        return Err(Error::unsupported("JPEG 2000: reduced window of an offset or non-power-of-two tile grid"));
    }
    let (sx, sy) = if shifts { (wtxo, wtyo) } else { (0, 0) };
    let mut out = Vec::with_capacity(4096);
    out.extend_from_slice(b"\xFF\x4F");
    for &(a, b) in &segs {
        let at = out.len();
        out.extend_from_slice(&cs[a..b]);
        if a == siz {
            for (o, v) in [(6, wxs - sx), (10, wys - sy), (14, wxo - sx), (18, wyo - sy), (30, wtxo - sx), (34, wtyo - sy)] {
                out[at + o..at + o + 4].copy_from_slice(&v.to_be_bytes());
            }
        }
    }
    // Tile-parts of the selected tiles, renumbered for the window's grid.
    let mut i = first_sot;
    let mut any = false;
    while i + 12 <= cs.len() && be16(i)? == 0xFF90 {
        let (t, psot) = (be16(i + 4)?, be32(i + 6)? as usize);
        let end = if psot == 0 { cs.len().saturating_sub(2) } else { i + psot };
        if end > cs.len() || end < i + 12 {
            return Err(Error::range("JPEG 2000: tile-part runs past the codestream"));
        }
        let (c, r) = (t % ntx, t / ntx);
        if (c0..=c1).contains(&c) && (r0..=r1).contains(&r) {
            let at = out.len();
            out.extend_from_slice(&cs[i..end]);
            let nt = (r - r0) * ntx2 + (c - c0);
            out[at + 4..at + 6].copy_from_slice(&(nt as u16).to_be_bytes());
            if psot == 0 {
                let len = (end - i) as u32;
                out[at + 6..at + 10].copy_from_slice(&len.to_be_bytes());
            }
            any = true;
        }
        if psot == 0 {
            break;
        }
        i = end;
    }
    if !any {
        return Err(Error::invalid("JPEG 2000: no tile-parts in the window"));
    }
    out.extend_from_slice(b"\xFF\xD9");
    let f = 1u32 << reduce.min(15);
    let (ex, ey) = (wxs.div_ceil(f) - wxo.div_ceil(f), wys.div_ceil(f) - wyo.div_ceil(f));
    let target = (reduce > 0).then(|| (((wxs - wxo) >> reduce).max(1), ((wys - wyo) >> reduce).max(1)));
    debug_assert!(sx % f == 0 && sy % f == 0);
    let r = decode(&out, target)?;
    // A sliver of a window (an edge tile a few pixels wide) cannot skip as many levels: decimate it.
    let r = if (r.width, r.height) == (ex, ey) { r } else { decimate(&r, ex, ey) };
    Ok((wxo - xo, wyo - yo, r))
}

fn decimate(r: &Raster, w: u32, h: u32) -> Raster {
    let (sw, sh) = (r.width as usize, r.height as usize);
    let mut data = Vec::with_capacity(w as usize * h as usize * r.comps as usize);
    for c in 0..r.comps as usize {
        let plane = &r.data[c * sw * sh..(c + 1) * sw * sh];
        for y in 0..h as usize {
            let sy = (y * sh / h as usize).min(sh - 1);
            data.extend((0..w as usize).map(|x| plane[sy * sw + (x * sw / w as usize).min(sw - 1)]));
        }
    }
    Raster { width: w, height: h, comps: r.comps, bits: r.bits, data }
}
