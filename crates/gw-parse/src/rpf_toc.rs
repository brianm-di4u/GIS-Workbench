//! RPF A.TOC table of contents (MIL-STD-2411; FC-15, REQ-FMT-40).
//!
//! An A.TOC is either a NITF file whose header carries the 48-byte RPFHDR TRE, or a bare RPF file
//! that starts with that header. The header points to the location section, which locates the
//! boundary-rectangle section (one record per scale/zone/product: corners, intervals, frame grid)
//! and the frame-file index (one record per frame: boundary, row, column, file name, GEOREF and a
//! pathname record). Rows are returned counted from the north, as GDAL's RPFTOC driver does: TOCs
//! that number boundaries from 0 count frame rows from the south and are flipped; legacy TOCs
//! numbering both from 1 are only shifted. Every read is bounds-checked; no panics.

use gw_abi::{Error, Json, Result};

/// One frame of a boundary rectangle.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub row: u32,
    pub col: u32,
    pub file: String,
    pub dir: String,
    pub georef: String,
}

/// One boundary rectangle (a product at one scale in one ARC zone).
#[derive(Debug, Clone, PartialEq)]
pub struct Boundary {
    pub product: String,
    pub compression: String,
    pub scale: String,
    pub zone: String,
    pub producer: String,
    /// NW, SW, NE, SE corners as (lat, lon).
    pub nw: (f64, f64),
    pub sw: (f64, f64),
    pub ne: (f64, f64),
    pub se: (f64, f64),
    pub vert_resolution: f64,
    pub horiz_resolution: f64,
    pub vert_interval: f64,
    pub horiz_interval: f64,
    pub rows: u32,
    pub cols: u32,
    pub overview: bool,
    pub frames: Vec<Frame>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Toc {
    pub boundaries: Vec<Boundary>,
}

/// Frames in one boundary rectangle at most (GDAL's RPFTOC_MAX_FRAME_COUNT default).
const MAX_FRAMES: u64 = 1_000_000;

fn u16be(b: &[u8], at: usize) -> Result<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]])).ok_or_else(|| gw_abi::err!(RANGE, "A.TOC: read past the end at {at}", at))
}
fn u32be(b: &[u8], at: usize) -> Result<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| gw_abi::err!(RANGE, "A.TOC: read past the end at {at}", at))
}
fn f64be(b: &[u8], at: usize) -> Result<f64> {
    b.get(at..at + 8).map(|s| f64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])).ok_or_else(|| gw_abi::err!(RANGE, "A.TOC: read past the end at {at}", at))
}
fn text(b: &[u8], at: usize, n: usize) -> Result<String> {
    let s = b.get(at..at + n).ok_or_else(|| gw_abi::err!(RANGE, "A.TOC: read past the end at {at}", at))?;
    let s: String = s.iter().take_while(|&&c| c != 0).map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { ' ' }).collect();
    Ok(s.trim().to_string())
}

/// Offset of the 48-byte RPF header: the RPFHDR TRE of a NITF A.TOC, or the start of a bare one.
fn header_offset(b: &[u8]) -> Result<usize> {
    if b.starts_with(b"NITF") || b.starts_with(b"NSIF") {
        // The TRE sits in the file header's user-defined or extended data: tag + 5-digit length.
        let hl = std::str::from_utf8(b.get(354..360).unwrap_or(b"")).ok().and_then(|s| s.trim().parse::<usize>().ok()).unwrap_or(b.len()).min(b.len());
        let scan = &b[..hl.max(b.len().min(1 << 16))];
        let at = scan.windows(11).position(|w| w == b"RPFHDR00048").ok_or_else(|| Error::invalid("A.TOC: NITF file without an RPFHDR TRE"))?;
        Ok(at + 11)
    } else {
        // Bare RPF: endian flag 0 (big-endian) or 0xFF, then the header length 48.
        if b.len() < 48 || u16be(b, 1)? != 48 {
            return Err(Error::invalid("not an RPF table of contents (no RPF header)"));
        }
        Ok(0)
    }
}

fn clean_dir(d: &str) -> Result<String> {
    let d = d.replace('\\', "/");
    let d = d.trim_end_matches('/');
    let d = d.trim_start_matches("./");
    let d = d.trim_start_matches('/');
    if d.split('/').any(|p| p == "..") {
        return Err(gw_abi::err!(INVALID, "A.TOC: path traversal in frame directory ''{d}''", d));
    }
    Ok(if d == "." { String::new() } else { d.to_string() })
}

pub fn parse(b: &[u8]) -> Result<Toc> {
    let h = header_offset(b)?;
    // RPF header: endian 1, header length 2, file name 12, new 1, standard 15, date 8, class 1,
    // country 2, release 2, location section offset 4.
    let loc = u32be(b, h + 1 + 2 + 12 + 1 + 15 + 8 + 1 + 2 + 2)? as usize;
    // Location section: length 2, table offset 4, count 2, record length 2, aggregate 4.
    let table = loc + u32be(b, loc + 2)? as usize;
    let count = u16be(b, loc + 6)? as usize;
    if u16be(b, loc + 8)? != 10 {
        return Err(Error::invalid("A.TOC: unexpected location record length"));
    }
    let (mut br_sub, mut br_table, mut ffi_sub, mut ffi_table) = (0usize, 0usize, 0usize, 0usize);
    for k in 0..count {
        let at = table + 10 * k;
        let id = u16be(b, at)?;
        let off = u32be(b, at + 6)? as usize;
        match id {
            148 => br_sub = off,
            149 => br_table = off,
            150 => ffi_sub = off,
            151 => ffi_table = off,
            _ => {}
        }
    }
    if br_sub == 0 || br_table == 0 || ffi_sub == 0 || ffi_table == 0 {
        return Err(Error::invalid("A.TOC: the location table lacks the boundary-rectangle or frame-file-index sections"));
    }
    let nbound = u16be(b, br_sub + 4)? as usize;
    // Boundary records are 132 bytes; their count is bounded by the file.
    if nbound * 132 > b.len() {
        return Err(Error::range("A.TOC: more boundary rectangles than the file holds"));
    }
    let mut boundaries = Vec::with_capacity(nbound);
    for i in 0..nbound {
        let a = br_table + 132 * i;
        let mut scale = text(b, a + 10, 12)?;
        if let Some(s) = scale.strip_prefix("1:") {
            scale = s.to_string();
        }
        let zone = text(b, a + 22, 1)?;
        let c = |k: usize| f64be(b, a + 28 + 8 * k);
        let (nw, sw, ne, se) = ((c(0)?, c(1)?), (c(2)?, c(3)?), (c(4)?, c(5)?), (c(6)?, c(7)?));
        let (vres, hres, vint, hint) = (c(8)?, c(9)?, c(10)?, c(11)?);
        let rows = u32be(b, a + 124)?;
        let cols = u32be(b, a + 128)?;
        if !(vint.is_finite() && hint.is_finite() && vint > 1e-10 && hint > 1e-10) || rows == 0 || cols == 0 || rows as u64 * cols as u64 > MAX_FRAMES {
            return Err(gw_abi::err!(INVALID, "A.TOC: boundary rectangle {n} has an implausible frame grid ({rows}×{cols}, intervals {vint}, {hint})", rows, cols, vint, hint, n = i + 1));
        }
        let overview = zone == "R" || (zone == "D" && nw == se);
        let polar = zone == "9" || zone == "J";
        if !overview {
            let bad = |v: f64, m: f64| !(v.abs() <= m);
            if bad(se.1, 360.0) || bad(nw.1, 360.0) || bad(nw.0, 90.0) || bad(se.0, 90.0) || (!polar && (se.1 < nw.1 || nw.0 < se.0)) {
                return Err(gw_abi::err!(INVALID, "A.TOC: boundary rectangle {n} has invalid corners", n = i + 1));
            }
        }
        boundaries.push(Boundary {
            product: text(b, a, 5)?,
            compression: text(b, a + 5, 5)?,
            scale,
            zone,
            producer: text(b, a + 23, 5)?,
            nw,
            sw,
            ne,
            se,
            vert_resolution: vres,
            horiz_resolution: hres,
            vert_interval: vint,
            horiz_interval: hint,
            rows,
            cols,
            overview,
            frames: Vec::new(),
        });
    }
    // Frame file index section: classification 1, table offset 4, records 4, pathnames 2, record length 2.
    let nrec = u32be(b, ffi_sub + 5)? as usize;
    let reclen = u16be(b, ffi_sub + 11)? as usize;
    if reclen < 6 {
        return Err(Error::invalid("A.TOC: frame index records are too short"));
    }
    if nrec.saturating_mul(reclen) > b.len() {
        return Err(Error::range("A.TOC: more frame index records than the file holds"));
    }
    let mut zero_based = false;
    for i in 0..nrec {
        let a = ffi_table + reclen * i;
        let mut bid = u16be(b, a)? as usize;
        if i == 0 && bid == 0 {
            zero_based = true;
        }
        if !zero_based {
            bid = bid.checked_sub(1).ok_or_else(|| gw_abi::err!(INVALID, "A.TOC: frame record {n} has boundary 0 in a TOC numbered from 1", n = i + 1))?;
        }
        let bd = boundaries.get_mut(bid).ok_or_else(|| gw_abi::err!(INVALID, "A.TOC: frame record {n} names boundary {boundary} of {nbound}", nbound, n = i + 1, boundary = bid + 1))?;
        let (mut row, mut col) = (u16be(b, a + 2)? as u32, u16be(b, a + 4)? as u32);
        if zero_based {
            // Rows count from the south: frames are numbered north to south here.
            if row >= bd.rows {
                return Err(gw_abi::err!(INVALID, "A.TOC: frame record {n} row {row} outside {rows} rows", row, n = i + 1, rows = bd.rows));
            }
            row = bd.rows - 1 - row;
        } else {
            row = row.checked_sub(1).ok_or_else(|| Error::invalid("A.TOC: frame row 0 in a TOC numbered from 1"))?;
            col = col.checked_sub(1).ok_or_else(|| Error::invalid("A.TOC: frame column 0 in a TOC numbered from 1"))?;
        }
        if row >= bd.rows || col >= bd.cols {
            return Err(gw_abi::err!(INVALID, "A.TOC: frame record {n} at row {row}, column {col} lies outside the {rows}×{cols} grid", row, col, n = i + 1, rows = bd.rows, cols = bd.cols));
        }
        let path_off = u32be(b, a + 6)? as usize;
        let file = text(b, a + 10, 12)?;
        if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
            return Err(gw_abi::err!(INVALID, "A.TOC: frame record {n} has an invalid file name ''{file}''", file, n = i + 1));
        }
        let georef = text(b, a + 22, 6).unwrap_or_default();
        let ext = file.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if ext.starts_with("ovr") || ext.starts_with("lgd") {
            bd.overview = true;
        }
        let pa = ffi_table + path_off;
        let plen = u16be(b, pa)? as usize;
        if plen == 0 || plen > 256 {
            return Err(gw_abi::err!(INVALID, "A.TOC: frame record {n} has a path of {plen} bytes", plen, n = i + 1));
        }
        let dir = clean_dir(&text(b, pa + 2, plen)?)?;
        bd.frames.push(Frame { row, col, file, dir, georef });
    }
    for bd in &mut boundaries {
        bd.frames.sort_by_key(|f| (f.row, f.col));
        bd.frames.dedup_by_key(|f| (f.row, f.col));
    }
    Ok(Toc { boundaries })
}

pub fn to_json(t: &Toc) -> String {
    let mut j = Json::new();
    j.obj().key("boundaries").arr();
    for (i, b) in t.boundaries.iter().enumerate() {
        j.obj().key("id").int(i as i64).kv_str("product", &b.product).kv_str("compression", &b.compression).kv_str("scale", &b.scale).kv_str("zone", &b.zone).kv_str("producer", &b.producer);
        for (k, c) in [("nw", b.nw), ("sw", b.sw), ("ne", b.ne), ("se", b.se)] {
            j.key(k).arr().num(c.0).num(c.1).end_arr();
        }
        j.key("vertResolution").num(b.vert_resolution).key("horizResolution").num(b.horiz_resolution).key("vertInterval").num(b.vert_interval).key("horizInterval").num(b.horiz_interval);
        j.key("rows").int(b.rows as i64).key("cols").int(b.cols as i64).key("overview").bool(b.overview);
        j.key("frames").arr();
        for f in &b.frames {
            j.obj().key("row").int(f.row as i64).key("col").int(f.col as i64).kv_str("file", &f.file).kv_str("dir", &f.dir).kv_str("georef", &f.georef).end_obj();
        }
        j.end_arr().end_obj();
    }
    j.end_arr().end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal bare A.TOC: one boundary (2×3 frames, 0-based ids) and the given frames.
    pub fn sample(frames: &[(u16, u16, &str)]) -> Vec<u8> {
        let mut b = vec![0u8; 48];
        b[1..3].copy_from_slice(&48u16.to_be_bytes());
        b[3..8].copy_from_slice(b"A.TOC");
        let loc = 48usize;
        b[44..48].copy_from_slice(&(loc as u32).to_be_bytes());
        // Location section: 14-byte header, 4 records.
        let recs = [148u16, 149, 150, 151];
        let base = loc + 14 + 40;
        let br_sub = base;
        let br_table = br_sub + 8;
        let ffi_sub = br_table + 132;
        let ffi_table = ffi_sub + 13;
        let offs = [br_sub, br_table, ffi_sub, ffi_table];
        let mut l = vec![0u8; 14];
        l[2..6].copy_from_slice(&14u32.to_be_bytes());
        l[6..8].copy_from_slice(&4u16.to_be_bytes());
        l[8..10].copy_from_slice(&10u16.to_be_bytes());
        for (id, off) in recs.iter().zip(offs) {
            l.extend_from_slice(&id.to_be_bytes());
            l.extend_from_slice(&0u32.to_be_bytes());
            l.extend_from_slice(&(off as u32).to_be_bytes());
        }
        b.extend(l);
        let mut s = vec![0u8; 8];
        s[4..6].copy_from_slice(&1u16.to_be_bytes());
        b.extend(s);
        let mut r = Vec::new();
        r.extend_from_slice(b"CADRG");
        r.extend_from_slice(b"VQ   ");
        r.extend_from_slice(b"1:250K      ");
        r.push(b'2');
        r.extend_from_slice(b"GDAL ");
        for v in [36.0f64, 10.0, 35.0, 10.0, 36.0, 12.0, 35.0, 12.0, 100.0, 100.0, 1.0 / 3072.0, 2.0 / (3.0 * 1536.0), 0.0] {
            r.extend_from_slice(&v.to_be_bytes());
        }
        r.truncate(28 + 96);
        r.extend_from_slice(&2u32.to_be_bytes());
        r.extend_from_slice(&3u32.to_be_bytes());
        b.extend(r);
        let mut f = vec![0u8; 13];
        f[5..9].copy_from_slice(&(frames.len() as u32).to_be_bytes());
        f[9..11].copy_from_slice(&1u16.to_be_bytes());
        f[11..13].copy_from_slice(&33u16.to_be_bytes());
        b.extend(f);
        let path_off = 33 * frames.len();
        for (row, col, name) in frames {
            let mut rec = Vec::new();
            rec.extend_from_slice(&0u16.to_be_bytes());
            rec.extend_from_slice(&row.to_be_bytes());
            rec.extend_from_slice(&col.to_be_bytes());
            rec.extend_from_slice(&(path_off as u32).to_be_bytes());
            let mut n = name.as_bytes().to_vec();
            n.resize(12, b' ');
            rec.extend(n);
            rec.extend_from_slice(b"ABCDEF");
            rec.push(b'U');
            rec.resize(33, b' ');
            b.extend(rec);
        }
        b.extend_from_slice(&8u16.to_be_bytes());
        b.extend_from_slice(b"./ZONE2/");
        b
    }

    #[test]
    fn bare_toc_rows_flip_north_to_south() {
        let t = parse(&sample(&[(0, 0, "00000010.ON2"), (1, 2, "00000020.ON2")])).unwrap();
        let bd = &t.boundaries[0];
        assert_eq!((bd.product.as_str(), bd.scale.as_str(), bd.zone.as_str(), bd.rows, bd.cols), ("CADRG", "250K", "2", 2, 3));
        assert_eq!(bd.frames.len(), 2);
        assert_eq!((bd.frames[0].row, bd.frames[0].col, bd.frames[0].file.as_str(), bd.frames[0].dir.as_str()), (0, 2, "00000020.ON2", "ZONE2"));
        assert_eq!((bd.frames[1].row, bd.frames[1].col), (1, 0));
        assert!(to_json(&t).contains("\"file\":\"00000010.ON2\""));
    }

    #[test]
    fn rejects_traversal_and_truncation() {
        assert!(parse(&sample(&[(0, 0, "../x.ON2")])).is_err());
        let ok = sample(&[(0, 0, "A.ON2")]);
        for n in [0, 10, 47, 60, ok.len() / 2, ok.len() - 3] {
            assert!(parse(&ok[..n]).is_err(), "prefix {n}");
        }
        assert!(parse(&sample(&[(5, 0, "A.ON2")])).is_err());
    }
}
