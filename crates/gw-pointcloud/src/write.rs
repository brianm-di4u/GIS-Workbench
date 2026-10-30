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

fn check_spec(c: &Columns, s: &WriteSpec) -> Result<()> {
    if s.format != 6 && s.format != 7 {
        return Err(Error::unsupported("LAS export writes point formats 6 and 7"));
    }
    if s.format == 7 && c.rgb.len() != 3 * c.n {
        return Err(Error::invalid("LAS export: format 7 needs colours"));
    }
    Ok(())
}

/// Bounds of the target coordinates of a cloud (or a slab of it).
pub fn bounds(c: &Columns, inv: &Lattice) -> ([f64; 3], [f64; 3]) {
    let (mut mn, mut mx) = ([f64::MAX; 3], [f64::MIN; 3]);
    for k in 0..c.n {
        let p = inv.apply(f64::from(c.pos[3 * k]), f64::from(c.pos[3 * k + 1]), f64::from(c.pos[3 * k + 2]));
        for a in 0..3 {
            mn[a] = mn[a].min(p[a]);
            mx[a] = mx[a].max(p[a]);
        }
    }
    (mn, mx)
}

/// The coordinate offset the header uses for bounds `mn` (whole kilometres below).
pub fn offset_for(mn: &[f64; 3]) -> [f64; 3] {
    std::array::from_fn(|a| if mn[a] == f64::MAX { 0.0 } else { (mn[a] / 1000.0).floor() * 1000.0 })
}

/// The point records of a cloud (or a slab) against `offset`, and its counts by return number.
pub fn points(c: &Columns, inv: &Lattice, s: &WriteSpec, offset: &[f64; 3]) -> Result<(Vec<u8>, [u64; 15])> {
    check_spec(c, s)?;
    let rl = if s.format == 7 { 36 } else { 30 };
    let mut raw = Vec::with_capacity(c.n * rl);
    let by_return = encode_points(&mut raw, c, inv, s, offset);
    Ok((raw, by_return))
}

/// Header and VLRs (and, for LAZ, the point data's leading chunk-table offset) of `n` points with
/// bounds mn/mx; `laz` is the chunk-table entries and the compressed bytes' length.
#[allow(clippy::too_many_arguments)]
pub fn head(s: &WriteSpec, n: usize, offset: &[f64; 3], mn: &[f64; 3], mx: &[f64; 3], by_return: &[u64; 15], laz: Option<(&[(u64, u64)], u64)>) -> Result<Vec<u8>> {
    let rl = if s.format == 7 { 36 } else { 30 };
    let (mn, mx) = if n == 0 { ([0.0; 3], [0.0; 3]) } else { (*mn, *mx) };
    let mut wkt = s.wkt.as_bytes().to_vec();
    wkt.push(0);
    let mut vlrs = vlr("LASF_Projection", 2112, "OGC WKT coordinate system", &wkt);
    let hs = 375usize;
    let mut nvlr = 1u32;
    if let Some((entries, _)) = laz {
        let (payload, _) = laz::laz_table(entries, s.format, 0)?;
        vlrs.extend(vlr("laszip encoded", 22204, "https://laszip.org", &payload));
        nvlr += 1;
    }
    let point_offset = hs + vlrs.len();
    let mut out = header(s, n, rl, nvlr, point_offset as u32, offset, &mn, &mx, by_return);
    out.extend(vlrs);
    if let Some((_, body)) = laz {
        // LAZ point data starts with the absolute offset of the chunk table, after the chunks.
        out.extend_from_slice(&((point_offset as u64 + 8 + body) as i64).to_le_bytes());
    }
    Ok(out)
}

/// LAS 1.4 (or LAZ) bytes of a cloud, in one piece (the worker splits larger clouds into slabs with
/// `bounds`, `points`, `laz::compress_chunks` and `head`). Peak memory stays near the columns plus one
/// copy of the points (TE 2.0.4: a 7.3 M-point export ran past the 1 GiB worker memory and trapped).
pub fn write(c: &Columns, inv: &Lattice, s: &WriteSpec) -> Result<Vec<u8>> {
    check_spec(c, s)?;
    let (mn, mx) = bounds(c, inv);
    let offset = offset_for(&mn);
    if s.compress {
        let (raw, by_return) = points(c, inv, s, &offset)?;
        let (body, entries) = laz::compress_chunks(&raw, s.format, 0)?;
        drop(raw);
        let (_, table) = laz::laz_table(&entries, s.format, 0)?;
        let mut out = head(s, c.n, &offset, &mn, &mx, &by_return, Some((&entries, body.len() as u64)))?;
        out.reserve_exact(body.len() + table.len());
        out.extend(body);
        out.extend(table);
        return Ok(out);
    }
    // Uncompressed points go straight into the output, behind a header written last.
    let rl = if s.format == 7 { 36 } else { 30 };
    let probe = head(s, c.n, &offset, &mn, &mx, &[0; 15], None)?;
    let mut out = Vec::with_capacity(probe.len() + c.n * rl);
    out.extend_from_slice(&probe);
    let by_return = encode_points(&mut out, c, inv, s, &offset);
    let h = head(s, c.n, &offset, &mn, &mx, &by_return, None)?;
    out[..h.len()].copy_from_slice(&h);
    Ok(out)
}
