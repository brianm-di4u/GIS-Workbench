//! I3S scene layer packages and I3S binary resources (REQ-GAP-35; OGC I3S 1.7–1.9).
//!
//! - **SLPK container.** An SLPK is a ZIP archive (STORE, entries gzip-compressed one by one, up
//!   to many gigabytes): `zip_end` finds the end of central directory (and its ZIP64 record) in
//!   the file's tail, `central_directory` lists the entries (ZIP64 extra fields read), and
//!   `local_data_start` gives where an entry's data begins from its local header. The page reads
//!   only those byte ranges of the file.
//! - **Uncompressed geometry buffers** (the legacy layout every 3DObject and IntegratedMesh layer
//!   carries first): vertexCount, featureCount, then per vertex position, normal, uv0, color,
//!   uvRegion and per feature featureId, faceRange, each present or not as the layer's
//!   geometryDefinitions say. `decode_geometry` checks every count against the buffer and returns
//!   the arrays in fixed types (positions, normals and UVs as f32; colours u8; UV regions u16;
//!   feature ids as f64; face ranges u32), with face ranges checked against the vertex count.
//!
//! Inputs are untrusted: every function returns an error, never panics.

use gw_abi::{err, Error, Result};

const EOCD: u32 = 0x0605_4b50;
const ZIP64_LOCATOR: u32 = 0x0706_4b50;
const ZIP64_EOCD: u32 = 0x0606_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;

fn u16le(b: &[u8], at: usize) -> Result<u16> {
    b.get(at..at + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| Error::invalid("SLPK: the ZIP record is cut short"))
}
fn u32le(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| Error::invalid("SLPK: the ZIP record is cut short"))
}
fn u64le(b: &[u8], at: usize) -> Result<u64> {
    b.get(at..at + 8).map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])).ok_or_else(|| Error::invalid("SLPK: the ZIP record is cut short"))
}

/// Where the central directory is: absolute offset and size, and the number of entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipEnd {
    pub cd_offset: u64,
    pub cd_size: u64,
    pub entries: u64,
}

/// The end of central directory from `tail`, the last bytes of a file of `file_len` bytes
/// (`tail[0]` is at absolute offset `file_len - tail.len()`). A ZIP64 end record must lie inside
/// the tail; a tail of 1 MiB always holds it for archives written by Esri tools and this app.
pub fn zip_end(tail: &[u8], file_len: u64) -> Result<ZipEnd> {
    if tail.len() as u64 > file_len {
        return Err(Error::invalid("SLPK: the tail is longer than the file"));
    }
    let base = file_len - tail.len() as u64;
    if tail.len() < 22 {
        return Err(Error::invalid("not a ZIP archive (SLPK): no end of central directory"));
    }
    // The record is 22 bytes plus a comment of up to 65,535 bytes: scan back from the end.
    let lo = tail.len().saturating_sub(22 + 0xffff);
    let mut at = None;
    let mut i = tail.len() - 22;
    loop {
        if u32le(tail, i)? == EOCD && i + 22 + u16le(tail, i + 20)? as usize <= tail.len() {
            at = Some(i);
            break;
        }
        if i == lo {
            break;
        }
        i -= 1;
    }
    let e = at.ok_or_else(|| Error::invalid("not a ZIP archive (SLPK): no end of central directory"))?;
    let mut end = ZipEnd { cd_offset: u32le(tail, e + 16)? as u64, cd_size: u32le(tail, e + 12)? as u64, entries: u16le(tail, e + 10)? as u64 };
    let zip64 = end.cd_offset == 0xffff_ffff || end.cd_size == 0xffff_ffff || end.entries == 0xffff;
    if e >= 20 && u32le(tail, e - 20)? == ZIP64_LOCATOR {
        let rec = u64le(tail, e - 20 + 8)?;
        if rec < base || rec - base + 56 > tail.len() as u64 {
            if zip64 {
                return Err(Error::invalid("SLPK: the ZIP64 end record is outside the part of the file read"));
            }
        } else {
            let r = (rec - base) as usize;
            if u32le(tail, r)? != ZIP64_EOCD {
                return Err(Error::invalid("SLPK: the ZIP64 end record is damaged"));
            }
            end = ZipEnd { entries: u64le(tail, r + 32)?, cd_size: u64le(tail, r + 40)?, cd_offset: u64le(tail, r + 48)? };
        }
    } else if zip64 {
        return Err(Error::invalid("SLPK: a ZIP64 archive without its ZIP64 end record"));
    }
    if end.cd_offset.checked_add(end.cd_size).is_none_or(|x| x > file_len) {
        return Err(Error::invalid("SLPK: the central directory lies past the end of the file"));
    }
    Ok(end)
}

/// One archive entry: its name, the offset of its local header, sizes and compression method
/// (0 store, 8 deflate).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub local_offset: u64,
    pub csize: u64,
    pub usize: u64,
    pub method: u16,
}

/// The entries of a central directory (`cd`, as read from `ZipEnd`), at most `max` of them.
pub fn central_directory(cd: &[u8], max: usize) -> Result<Vec<Entry>> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p + 46 <= cd.len() {
        if u32le(cd, p)? != CENTRAL {
            if out.is_empty() {
                return Err(Error::invalid("SLPK: the central directory is damaged"));
            }
            break; // digital signature or ZIP64 end record after the entries
        }
        if out.len() >= max {
            return Err(err!(LIMIT, "SLPK: more than {max} entries", max));
        }
        let method = u16le(cd, p + 10)?;
        let mut csize = u32le(cd, p + 20)? as u64;
        let mut usize_ = u32le(cd, p + 24)? as u64;
        let n = u16le(cd, p + 28)? as usize;
        let m = u16le(cd, p + 30)? as usize;
        let k = u16le(cd, p + 32)? as usize;
        let mut local = u32le(cd, p + 42)? as u64;
        let name_b = cd.get(p + 46..p + 46 + n).ok_or_else(|| Error::invalid("SLPK: the central directory is cut short"))?;
        let extra = cd.get(p + 46 + n..p + 46 + n + m).ok_or_else(|| Error::invalid("SLPK: the central directory is cut short"))?;
        // ZIP64 extended information (id 1): the 64-bit values, in order, of the fields set to all ones.
        let mut q = 0usize;
        while q + 4 <= extra.len() {
            let id = u16le(extra, q)?;
            let len = u16le(extra, q + 2)? as usize;
            let body = extra.get(q + 4..q + 4 + len).ok_or_else(|| Error::invalid("SLPK: a ZIP extra field is cut short"))?;
            if id == 1 {
                let mut r = 0usize;
                for f in [&mut usize_, &mut csize, &mut local] {
                    if *f == 0xffff_ffff {
                        *f = u64le(body, r)?;
                        r += 8;
                    }
                }
            }
            q += 4 + len;
        }
        out.push(Entry { name: String::from_utf8_lossy(name_b).replace('\\', "/"), local_offset: local, csize, usize: usize_, method });
        p += 46 + n + m + k;
    }
    Ok(out)
}

/// The entries packed for JS: u32 count, then per entry f64 local offset, f64 compressed size,
/// f64 size, u16 method, u16 name length, the UTF-8 name (little-endian, unaligned).
pub fn pack_entries(es: &[Entry]) -> Vec<u8> {
    let mut o = Vec::with_capacity(4 + es.len() * 48);
    o.extend_from_slice(&(es.len() as u32).to_le_bytes());
    for e in es {
        for v in [e.local_offset, e.csize, e.usize] {
            o.extend_from_slice(&(v as f64).to_le_bytes());
        }
        let name = e.name.as_bytes();
        let name = &name[..name.len().min(0xffff)];
        o.extend_from_slice(&e.method.to_le_bytes());
        o.extend_from_slice(&(name.len() as u16).to_le_bytes());
        o.extend_from_slice(name);
    }
    o
}

/// Offset of an entry's data relative to its local header (`hdr`: at least 30 bytes of it).
pub fn local_data_start(hdr: &[u8]) -> Result<u64> {
    if u32le(hdr, 0)? != LOCAL {
        return Err(Error::invalid("SLPK: an entry's local header is damaged"));
    }
    Ok(30 + u16le(hdr, 26)? as u64 + u16le(hdr, 28)? as u64)
}

/// Component types of I3S binary buffers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ty {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    U64,
    I64,
    F32,
    F64,
}

impl Ty {
    /// The code JS passes: 1 UInt8, 2 Int8, 3 UInt16, 4 Int16, 5 UInt32, 6 Int32, 7 UInt64,
    /// 8 Int64, 9 Float32, 10 Float64.
    pub fn from_code(c: f64) -> Option<Ty> {
        Some(match c as i64 {
            1 => Ty::U8,
            2 => Ty::I8,
            3 => Ty::U16,
            4 => Ty::I16,
            5 => Ty::U32,
            6 => Ty::I32,
            7 => Ty::U64,
            8 => Ty::I64,
            9 => Ty::F32,
            10 => Ty::F64,
            _ => return None,
        })
    }
    fn size(self) -> usize {
        match self {
            Ty::U8 | Ty::I8 => 1,
            Ty::U16 | Ty::I16 => 2,
            Ty::U32 | Ty::I32 | Ty::F32 => 4,
            Ty::U64 | Ty::I64 | Ty::F64 => 8,
        }
    }
    fn read(self, b: &[u8], at: usize) -> f64 {
        let s = &b[at..at + self.size()];
        match self {
            Ty::U8 => s[0] as f64,
            Ty::I8 => s[0] as i8 as f64,
            Ty::U16 => u16::from_le_bytes([s[0], s[1]]) as f64,
            Ty::I16 => i16::from_le_bytes([s[0], s[1]]) as f64,
            Ty::U32 => u32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
            Ty::I32 => i32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
            Ty::F32 => f32::from_le_bytes([s[0], s[1], s[2], s[3]]) as f64,
            Ty::U64 => u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]) as f64,
            Ty::I64 => i64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]) as f64,
            Ty::F64 => f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]),
        }
    }
}

/// One attribute of a geometry layout: its type and number of components (None: absent).
pub type Attr = Option<(Ty, usize)>;

/// The layout of an uncompressed geometry buffer, in the order the attributes are stored.
#[derive(Clone, Copy, Debug, Default)]
pub struct Layout {
    pub offset: usize,
    pub position: Attr,
    pub normal: Attr,
    pub uv0: Attr,
    pub color: Attr,
    pub uv_region: Attr,
    pub feature_id: Attr,
    pub face_range: Attr,
}

/// A decoded geometry buffer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Geometry {
    pub vertex_count: usize,
    pub feature_count: usize,
    pub position: Vec<f32>,
    pub normal: Vec<f32>,
    pub uv0: Vec<f32>,
    pub color: Vec<u8>,
    pub uv_region: Vec<u16>,
    pub feature_id: Vec<f64>,
    pub face_range: Vec<u32>,
}

fn check(a: Attr, comps: &[usize], what: &'static str) -> Result<()> {
    match a {
        Some((_, c)) if !comps.contains(&c) => Err(err!(INVALID, "I3S geometry: {what} has {c} components", what, c)),
        _ => Ok(()),
    }
}

/// Decode an uncompressed I3S geometry buffer with `layout`, at most `max_vertices` vertices.
pub fn decode_geometry(buf: &[u8], l: &Layout, max_vertices: usize) -> Result<Geometry> {
    check(l.position, &[3], "position")?;
    check(l.normal, &[3], "normal")?;
    check(l.uv0, &[2], "uv0")?;
    check(l.color, &[3, 4], "color")?;
    check(l.uv_region, &[4], "uvRegion")?;
    check(l.feature_id, &[1], "featureId")?;
    check(l.face_range, &[2], "faceRange")?;
    if l.position.is_none() {
        return Err(Error::invalid("I3S geometry: the layout has no position"));
    }
    let vertex_count = u32le(buf, 0).map_err(|_| Error::invalid("I3S geometry buffer is shorter than its header"))? as usize;
    let feature_count = u32le(buf, 4).map_err(|_| Error::invalid("I3S geometry buffer is shorter than its header"))? as usize;
    if vertex_count > max_vertices {
        return Err(err!(LIMIT, "I3S geometry: {n} vertices (more than {max})", n = vertex_count, max = max_vertices));
    }
    if vertex_count % 3 != 0 {
        return Err(err!(INVALID, "I3S geometry: {n} vertices is not a whole number of triangles", n = vertex_count));
    }
    if feature_count > vertex_count / 3 + 1 {
        return Err(err!(INVALID, "I3S geometry: {f} features for {n} vertices", f = feature_count, n = vertex_count));
    }
    let mut off = l.offset;
    let mut g = Geometry { vertex_count, feature_count, ..Default::default() };
    let mut take = |a: Attr, count: usize| -> Result<Option<(Ty, usize, usize)>> {
        let Some((t, c)) = a else { return Ok(None) };
        let bytes = t.size().checked_mul(c).and_then(|x| x.checked_mul(count)).ok_or_else(|| Error::invalid("I3S geometry buffer is shorter than its layout"))?;
        let end = off.checked_add(bytes).filter(|&e| e <= buf.len()).ok_or_else(|| Error::invalid("I3S geometry buffer is shorter than its layout"))?;
        let at = off;
        off = end;
        Ok(Some((t, c, at)))
    };
    let pos = take(l.position, vertex_count)?;
    let nrm = take(l.normal, vertex_count)?;
    let uv = take(l.uv0, vertex_count)?;
    let col = take(l.color, vertex_count)?;
    let reg = take(l.uv_region, vertex_count)?;
    let fid = take(l.feature_id, feature_count)?;
    let fr = take(l.face_range, feature_count)?;
    let floats = |s: Option<(Ty, usize, usize)>, n: usize| -> Vec<f32> {
        let Some((t, c, at)) = s else { return Vec::new() };
        (0..n * c).map(|i| t.read(buf, at + i * t.size()) as f32).collect()
    };
    g.position = floats(pos, vertex_count);
    g.normal = floats(nrm, vertex_count);
    g.uv0 = floats(uv, vertex_count);
    if let Some((t, c, at)) = col {
        g.color = Vec::with_capacity(vertex_count * 4);
        for v in 0..vertex_count {
            for k in 0..4 {
                g.color.push(if k < c { t.read(buf, at + (v * c + k) * t.size()).clamp(0.0, 255.0) as u8 } else { 255 });
            }
        }
    }
    if let Some((t, c, at)) = reg {
        g.uv_region = (0..vertex_count * c).map(|i| t.read(buf, at + i * t.size()).clamp(0.0, 65535.0) as u16).collect();
    }
    if let Some((t, _, at)) = fid {
        g.feature_id = (0..feature_count).map(|i| t.read(buf, at + i * t.size())).collect();
    }
    if let Some((t, _, at)) = fr {
        let tris = (vertex_count / 3) as f64;
        g.face_range = Vec::with_capacity(feature_count * 2);
        for f in 0..feature_count {
            let a = t.read(buf, at + 2 * f * t.size());
            let b = t.read(buf, at + (2 * f + 1) * t.size());
            if !(a >= 0.0 && a <= b && b < tris) {
                return Err(err!(INVALID, "I3S geometry: feature {f} has the face range {a}–{b} outside its {n} triangles", f, a, b, n = tris));
            }
            g.face_range.push(a as u32);
            g.face_range.push(b as u32);
        }
    }
    Ok(g)
}

/// A decoded geometry packed for JS (little-endian): u32 vertexCount, u32 featureCount, u32
/// flags (bit 0 normal, 1 uv0, 2 color, 3 uvRegion, 4 featureId, 5 faceRange), u32 padding; then
/// f64 feature ids, f32 positions, normals, UVs, u32 face ranges, u16 UV regions, u8 colours (the
/// 8-byte and 4-byte arrays first, so each is aligned).
pub fn pack_geometry(g: &Geometry) -> Vec<u8> {
    let mut o = Vec::new();
    let flags = (!g.normal.is_empty() as u32) | (!g.uv0.is_empty() as u32) << 1 | (!g.color.is_empty() as u32) << 2 | (!g.uv_region.is_empty() as u32) << 3 | (!g.feature_id.is_empty() as u32) << 4 | (!g.face_range.is_empty() as u32) << 5;
    for v in [g.vertex_count as u32, g.feature_count as u32, flags, 0] {
        o.extend_from_slice(&v.to_le_bytes());
    }
    for v in &g.feature_id {
        o.extend_from_slice(&v.to_le_bytes());
    }
    for a in [&g.position, &g.normal, &g.uv0] {
        for v in a {
            o.extend_from_slice(&v.to_le_bytes());
        }
    }
    for v in &g.face_range {
        o.extend_from_slice(&v.to_le_bytes());
    }
    for v in &g.uv_region {
        o.extend_from_slice(&v.to_le_bytes());
    }
    o.extend_from_slice(&g.color);
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A STORE ZIP of `files` (optionally with ZIP64 records), as an SLPK writer lays it out.
    fn zip(files: &[(&str, &[u8])], zip64: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, data) in files {
            let off = out.len() as u32;
            let crc = crate::gz::crc32(data);
            out.extend_from_slice(&LOCAL.to_le_bytes());
            out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(data.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(data);
            cd.extend_from_slice(&CENTRAL.to_le_bytes());
            cd.extend_from_slice(&[45, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            cd.extend_from_slice(&crc.to_le_bytes());
            if zip64 {
                cd.extend_from_slice(&[0xff; 8]);
            } else {
                cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
                cd.extend_from_slice(&(data.len() as u32).to_le_bytes());
            }
            cd.extend_from_slice(&(name.len() as u16).to_le_bytes());
            cd.extend_from_slice(&(if zip64 { 28u16 } else { 0 }).to_le_bytes());
            cd.extend_from_slice(&[0; 10]);
            cd.extend_from_slice(&(if zip64 { 0xffff_ffff } else { off }).to_le_bytes());
            cd.extend_from_slice(name.as_bytes());
            if zip64 {
                cd.extend_from_slice(&1u16.to_le_bytes());
                cd.extend_from_slice(&24u16.to_le_bytes());
                for v in [data.len() as u64, data.len() as u64, off as u64] {
                    cd.extend_from_slice(&v.to_le_bytes());
                }
            }
        }
        let cd_off = out.len() as u64;
        out.extend_from_slice(&cd);
        if zip64 {
            let rec = out.len() as u64;
            out.extend_from_slice(&ZIP64_EOCD.to_le_bytes());
            out.extend_from_slice(&44u64.to_le_bytes());
            out.extend_from_slice(&[45, 0, 45, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            for v in [files.len() as u64, files.len() as u64, cd.len() as u64, cd_off] {
                out.extend_from_slice(&v.to_le_bytes());
            }
            out.extend_from_slice(&ZIP64_LOCATOR.to_le_bytes());
            out.extend_from_slice(&0u32.to_le_bytes());
            out.extend_from_slice(&rec.to_le_bytes());
            out.extend_from_slice(&1u32.to_le_bytes());
        }
        out.extend_from_slice(&EOCD.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        let n = if zip64 { 0xffff } else { files.len() as u16 };
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(if zip64 { 0xffff_ffff } else { cd.len() as u32 }).to_le_bytes());
        out.extend_from_slice(&(if zip64 { 0xffff_ffff } else { cd_off as u32 }).to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes());
        out.extend_from_slice(b"abc");
        out
    }

    #[test]
    fn zip_directory_plain_and_zip64() {
        for z64 in [false, true] {
            let z = zip(&[("3dSceneLayer.json.gz", b"{}"), ("nodes\\0\\geometries\\0.bin.gz", b"12345")], z64);
            // From a tail shorter than the file, as the page reads it.
            let tail = &z[20..];
            let e = zip_end(tail, z.len() as u64).unwrap();
            assert_eq!(e.entries, 2);
            let cd = &z[e.cd_offset as usize..(e.cd_offset + e.cd_size) as usize];
            let es = central_directory(cd, 10).unwrap();
            assert_eq!(es[1].name, "nodes/0/geometries/0.bin.gz");
            assert_eq!(es[1].csize, 5);
            let at = es[1].local_offset as usize;
            let start = local_data_start(&z[at..at + 30]).unwrap() as usize;
            assert_eq!(&z[at + start..at + start + 5], b"12345");
            let p = pack_entries(&es);
            assert_eq!(u32::from_le_bytes([p[0], p[1], p[2], p[3]]), 2);
            assert!(central_directory(cd, 1).is_err());
        }
        assert!(zip_end(b"PK\x05\x06 short", 12).is_err());
        assert!(zip_end(&[0u8; 100], 100).is_err());
        let z = zip(&[("a", b"x")], true);
        // The ZIP64 record cut away from the tail: refused, not misread.
        assert!(zip_end(&z[z.len() - 30..], z.len() as u64).is_err());
    }

    fn layout_full() -> Layout {
        Layout { offset: 8, position: Some((Ty::F32, 3)), normal: Some((Ty::F32, 3)), uv0: Some((Ty::F32, 2)), color: Some((Ty::U8, 4)), uv_region: None, feature_id: Some((Ty::U64, 1)), face_range: Some((Ty::U32, 2)) }
    }

    fn buffer(nv: u32, nf: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&nv.to_le_bytes());
        b.extend_from_slice(&nf.to_le_bytes());
        for i in 0..nv * 3 {
            b.extend_from_slice(&(i as f32 * 0.5).to_le_bytes());
        }
        for _ in 0..nv * 3 {
            b.extend_from_slice(&1f32.to_le_bytes());
        }
        for i in 0..nv * 2 {
            b.extend_from_slice(&(i as f32 / 10.0).to_le_bytes());
        }
        for i in 0..nv * 4 {
            b.push(i as u8);
        }
        for f in 0..nf {
            b.extend_from_slice(&(7_000_000_000u64 + f as u64).to_le_bytes());
        }
        let per = nv / 3 / nf;
        for f in 0..nf {
            b.extend_from_slice(&(f * per).to_le_bytes());
            b.extend_from_slice(&(f * per + per - 1).to_le_bytes());
        }
        b
    }

    #[test]
    fn geometry_decode_and_checks() {
        let b = buffer(6, 2);
        let g = decode_geometry(&b, &layout_full(), 1000).unwrap();
        assert_eq!((g.vertex_count, g.feature_count), (6, 2));
        assert_eq!(g.position[5], 2.5);
        assert_eq!(g.uv0[3], 0.3);
        assert_eq!(g.color[7], 7);
        assert_eq!(g.feature_id, vec![7e9, 7e9 + 1.0]);
        assert_eq!(g.face_range, vec![0, 0, 1, 1]);
        let p = pack_geometry(&g);
        assert_eq!(p.len(), 16 + 2 * 8 + 6 * 4 * 8 + 4 * 4 + 6 * 4);
        // Cut short, too many vertices, a face range outside the triangles, a bad component count.
        assert!(decode_geometry(&b[..b.len() - 1], &layout_full(), 1000).is_err());
        assert!(decode_geometry(&b, &layout_full(), 5).is_err());
        let mut bad = b.clone();
        let n = bad.len();
        bad[n - 4..].copy_from_slice(&9u32.to_le_bytes());
        assert!(decode_geometry(&bad, &layout_full(), 1000).is_err());
        let mut l = layout_full();
        l.normal = Some((Ty::F32, 2));
        assert!(decode_geometry(&b, &l, 1000).is_err());
        l.normal = None;
        l.position = None;
        assert!(decode_geometry(&b, &l, 1000).is_err());
        // RGB colours are widened to RGBA.
        let mut l = layout_full();
        l.color = Some((Ty::U8, 3));
        l.feature_id = None;
        l.face_range = None;
        let mut b3 = buffer(3, 1);
        b3.truncate(8 + 3 * 12 + 3 * 12 + 3 * 8);
        b3.extend_from_slice(&[10, 20, 30, 40, 50, 60, 70, 80, 90]);
        b3[4..8].copy_from_slice(&0u32.to_le_bytes());
        let g = decode_geometry(&b3, &l, 100).unwrap();
        assert_eq!(&g.color[..8], &[10, 20, 30, 255, 40, 50, 60, 255]);
        assert!(Ty::from_code(11.0).is_none());
    }
}
