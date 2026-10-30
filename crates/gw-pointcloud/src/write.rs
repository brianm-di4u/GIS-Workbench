//! LAS 1.4 export (REQ-LDR-10): formats 6 (no colour) and 7 (RGB, e.g. after colourising from an
//! image), with an OGC WKT CRS VLR, optionally LAZ-compressed (REQ-LDR-12, D23). Coordinates come
//! out of the local frame through an inverse lattice (east, north → target X, Y, height offset).

use crate::decode::{Columns, Lattice};
use crate::laz;
use gw_abi::{Error, Result};

pub struct WriteSpec {
    pub format: u8,
    pub scale: [f64; 3],
    pub wkt: String,
    pub system_id: String,
    pub software: String,
    pub day: u16,
    pub year: u16,
    /// Global encoding bit 0: adjusted standard GPS time.
    pub adjusted_gps: bool,
    pub t0: f64,
    pub compress: bool,
}

impl Columns {
    /// Read the layout written by `to_bytes`.
    pub fn from_bytes(b: &[u8], n: usize, rgb: bool) -> Option<Columns> {
        let mut o = 0usize;
        let take = |o: &mut usize, len: usize| -> Option<&[u8]> {
            let s = b.get(*o..*o + len)?;
            *o += len.div_ceil(4) * 4;
            Some(s)
        };
        let f32s = |s: &[u8]| s.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect::<Vec<_>>();
        let u16s = |s: &[u8]| s.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>();
        let pos = f32s(take(&mut o, 12 * n)?);
        let time = f32s(take(&mut o, 4 * n)?);
        let intensity = u16s(take(&mut o, 2 * n)?);
        let source = u16s(take(&mut o, 2 * n)?);
        let scan = take(&mut o, 2 * n)?.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        let rgbv = if rgb { u16s(take(&mut o, 6 * n)?) } else { Vec::new() };
        let class = take(&mut o, n)?.to_vec();
        let ret = take(&mut o, n)?.to_vec();
        let flags = take(&mut o, n)?.to_vec();
        let user = take(&mut o, n)?.to_vec();
        Some(Columns { n, pos, time, intensity, source, scan, rgb: rgbv, class, ret, flags, user })
    }
}

fn put_str(b: &mut Vec<u8>, s: &str, len: usize) {
    let mut v = s.as_bytes().to_vec();
    v.truncate(len - 1);
    v.resize(len, 0);
    b.extend_from_slice(&v);
}

fn vlr(user: &str, id: u16, desc: &str, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(54 + payload.len());
    b.extend_from_slice(&0u16.to_le_bytes());
    put_str(&mut b, user, 16);
    b.extend_from_slice(&id.to_le_bytes());
    b.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    put_str(&mut b, desc, 32);
    b.extend_from_slice(payload);
    b
}

/// Encode every point (formats 6/7) onto `out`; returns the counts by return number.
fn encode_points(out: &mut Vec<u8>, c: &Columns, inv: &Lattice, s: &WriteSpec, offset: &[f64; 3]) -> [u64; 15] {
    let mut by_return = [0u64; 15];
    for k in 0..c.n {
        let p = inv.apply(f64::from(c.pos[3 * k]), f64::from(c.pos[3 * k + 1]), f64::from(c.pos[3 * k + 2]));
        for a in 0..3 {
            out.extend_from_slice(&(((p[a] - offset[a]) / s.scale[a]).round() as i32).to_le_bytes());
        }
        out.extend_from_slice(&c.intensity[k].to_le_bytes());
        let r = c.ret[k];
        out.push(r);
        let f = c.flags[k];
        out.push((f & 0x0f) | (((f >> 4) & 1) << 6) | (((f >> 5) & 1) << 7));
        out.push(c.class[k]);
        out.push(c.user[k]);
        out.extend_from_slice(&c.scan[k].to_le_bytes());
        out.extend_from_slice(&c.source[k].to_le_bytes());
        out.extend_from_slice(&(f64::from(c.time[k]) + s.t0).to_le_bytes());
        if s.format == 7 {
            for a in 0..3 {
                out.extend_from_slice(&c.rgb[3 * k + a].to_le_bytes());
            }
        }
        let rn = (r & 0x0f) as usize;
        if (1..=15).contains(&rn) {
            by_return[rn - 1] += 1;
        }
    }
    by_return
}

/// The 375-byte LAS 1.4 header.
#[allow(clippy::too_many_arguments)]
fn header(s: &WriteSpec, n: usize, rl: usize, nvlr: u32, point_offset: u32, offset: &[f64; 3], mn: &[f64; 3], mx: &[f64; 3], by_return: &[u64; 15]) -> Vec<u8> {
    let hs = 375usize;
    let mut h = Vec::with_capacity(hs);
    h.extend_from_slice(b"LASF");
    h.extend_from_slice(&0u16.to_le_bytes()); // file source id
    h.extend_from_slice(&((if s.adjusted_gps { 1u16 } else { 0 }) | 16).to_le_bytes());
    h.extend_from_slice(&[0u8; 16]); // GUID
    h.extend_from_slice(&[1, 4]);
    put_str(&mut h, &s.system_id, 32);
    put_str(&mut h, &s.software, 32);
    h.extend_from_slice(&s.day.to_le_bytes());
    h.extend_from_slice(&s.year.to_le_bytes());
    h.extend_from_slice(&(hs as u16).to_le_bytes());
    h.extend_from_slice(&point_offset.to_le_bytes());
    h.extend_from_slice(&nvlr.to_le_bytes());
    h.push(if s.compress { s.format | 0x80 } else { s.format });
    h.extend_from_slice(&(rl as u16).to_le_bytes());
    h.extend_from_slice(&0u32.to_le_bytes()); // legacy count: 0 for formats 6–10
    h.extend_from_slice(&[0u8; 20]);
    for a in 0..3 {
        h.extend_from_slice(&s.scale[a].to_le_bytes());
    }
    for a in 0..3 {
        h.extend_from_slice(&offset[a].to_le_bytes());
    }
    for a in 0..3 {
        h.extend_from_slice(&mx[a].to_le_bytes());
        h.extend_from_slice(&mn[a].to_le_bytes());
    }
    h.extend_from_slice(&0u64.to_le_bytes()); // waveform
    h.extend_from_slice(&0u64.to_le_bytes()); // first EVLR
    h.extend_from_slice(&0u32.to_le_bytes());
    h.extend_from_slice(&(n as u64).to_le_bytes());
    for v in by_return {
        h.extend_from_slice(&v.to_le_bytes());
    }
    debug_assert_eq!(h.len(), hs);
    h
}

/// LAS 1.4 (or LAZ) bytes of a cloud. Peak memory stays near the columns plus one copy of the
/// points: the bounds come from a first pass (no copy of the target coordinates), and uncompressed
/// points are encoded straight into the output behind a reserved header (TE 2.0.4: a 7.3 M-point
/// export ran past the 1 GiB worker memory and trapped).
pub fn write(c: &Columns, inv: &Lattice, s: &WriteSpec) -> Result<Vec<u8>> {
    if s.format != 6 && s.format != 7 {
        return Err(Error::unsupported("LAS export writes point formats 6 and 7"));
    }
    if s.format == 7 && c.rgb.len() != 3 * c.n {
        return Err(Error::invalid("LAS export: format 7 needs colours"));
    }
    let n = c.n;
    // Bounds of the target coordinates.
    let (mut mn, mut mx) = ([f64::MAX; 3], [f64::MIN; 3]);
    for k in 0..n {
        let p = inv.apply(f64::from(c.pos[3 * k]), f64::from(c.pos[3 * k + 1]), f64::from(c.pos[3 * k + 2]));
        for a in 0..3 {
            mn[a] = mn[a].min(p[a]);
            mx[a] = mx[a].max(p[a]);
        }
    }
    if n == 0 {
        mn = [0.0; 3];
        mx = [0.0; 3];
    }
    let offset: [f64; 3] = std::array::from_fn(|a| (mn[a] / 1000.0).floor() * 1000.0);
    let rl = if s.format == 7 { 36 } else { 30 };
    // VLRs.
    let mut wkt = s.wkt.as_bytes().to_vec();
    wkt.push(0);
    let mut vlrs = vlr("LASF_Projection", 2112, "OGC WKT coordinate system", &wkt);
    let hs = 375usize;
    if s.compress {
        // The LAZ VLR's length is fixed by the item list, so the point offset is known first.
        let items_len = {
            let (p, _) = laz::compress(&[], s.format, 0, 0)?;
            p.len()
        };
        let start = (hs + vlrs.len() + 54 + items_len) as u64;
        let mut raw = Vec::with_capacity(n * rl);
        let by_return = encode_points(&mut raw, c, inv, s, &offset);
        let (payload, data) = laz::compress(&raw, s.format, 0, start)?;
        drop(raw);
        vlrs.extend(vlr("laszip encoded", 22204, "https://laszip.org", &payload));
        let point_offset = (hs + vlrs.len()) as u32;
        let mut out = header(s, n, rl, 2, point_offset, &offset, &mn, &mx, &by_return);
        out.reserve_exact(vlrs.len() + data.len());
        out.extend(vlrs);
        out.extend(data);
        return Ok(out);
    }
    let point_offset = hs + vlrs.len();
    let mut out = Vec::with_capacity(point_offset + n * rl);
    out.resize(hs, 0);
    out.extend_from_slice(&vlrs);
    let by_return = encode_points(&mut out, c, inv, s, &offset);
    out[..hs].copy_from_slice(&header(s, n, rl, 1, point_offset as u32, &offset, &mn, &mx, &by_return));
    Ok(out)
}
