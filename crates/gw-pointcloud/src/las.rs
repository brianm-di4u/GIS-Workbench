//! LAS 1.0–1.5 headers, VLRs and EVLRs (REQ-LDR-01), read by header size and record length so
//! that unknown trailing fields and extra bytes are skipped, never misread.

use gw_abi::{Error, Result};

/// The public header block. Fields a version lacks are zero.
#[derive(Clone, Debug, Default)]
pub struct Header {
    pub file_source_id: u16,
    pub global_encoding: u16,
    pub guid: [u8; 16],
    pub version: (u8, u8),
    pub system_id: String,
    pub software: String,
    pub day: u16,
    pub year: u16,
    pub header_size: u16,
    pub point_offset: u32,
    pub n_vlrs: u32,
    /// Point data record format (0–10) with the LAZ bits (6 and 7) cleared.
    pub format: u8,
    pub compressed: bool,
    pub record_len: u16,
    pub n_points: u64,
    pub by_return: [u64; 15],
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    pub max: [f64; 3],
    pub min: [f64; 3],
    pub waveform_start: u64,
    pub evlr_start: u64,
    pub n_evlrs: u32,
}

/// A variable-length record (or an extended one) with its payload position in the file.
#[derive(Clone, Debug)]
pub struct Vlr {
    pub user_id: String,
    pub record_id: u16,
    pub description: String,
    pub extended: bool,
    /// Byte offset of the payload in the file, and its length.
    pub data_offset: u64,
    pub data_len: u64,
}

/// Size in bytes of the standard part of each point data record format.
pub fn base_size(format: u8) -> Option<usize> {
    Some(match format {
        0 => 20,
        1 => 28,
        2 => 26,
        3 => 34,
        4 => 57,
        5 => 63,
        6 => 30,
        7 => 36,
        8 => 38,
        9 => 59,
        10 => 67,
        _ => return None,
    })
}

fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64le(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn f64le(b: &[u8], o: usize) -> f64 {
    f64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn text(b: &[u8]) -> String {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).trim_end().to_string()
}

/// Parse the public header block from the first bytes of the file (at least the header size).
pub fn header(b: &[u8]) -> Result<Header> {
    if b.len() < 227 || &b[0..4] != b"LASF" {
        return Err(Error::invalid("LAS: not a LAS file (no LASF signature)"));
    }
    let mut h = Header {
        file_source_id: u16le(b, 4),
        global_encoding: u16le(b, 6),
        version: (b[24], b[25]),
        system_id: text(&b[26..58]),
        software: text(&b[58..90]),
        day: u16le(b, 90),
        year: u16le(b, 92),
        header_size: u16le(b, 94),
        point_offset: u32le(b, 96),
        n_vlrs: u32le(b, 100),
        record_len: u16le(b, 105),
        ..Header::default()
    };
    h.guid.copy_from_slice(&b[8..24]);
    let fmt = b[104];
    h.compressed = fmt & 0x80 != 0;
    h.format = fmt & 0x3f;
    if h.version.0 != 1 || h.version.1 > 5 {
        return Err(Error::unsupported(format!("LAS {}.{}: only versions 1.0–1.5 are read", h.version.0, h.version.1)));
    }
    let hs = h.header_size as usize;
    if hs < 227 || b.len() < hs {
        return Err(Error::invalid(format!("LAS: header size {hs} is too small or truncated")));
    }
    let Some(base) = base_size(h.format) else {
        return Err(Error::unsupported(format!("LAS: point data record format {} is not defined", h.format)));
    };
    if (h.record_len as usize) < base {
        return Err(Error::invalid(format!("LAS: record length {} is shorter than format {}'s {} bytes", h.record_len, h.format, base)));
    }
    h.n_points = u64::from(u32le(b, 107));
    for i in 0..5 {
        h.by_return[i] = u64::from(u32le(b, 111 + 4 * i));
    }
    for i in 0..3 {
        h.scale[i] = f64le(b, 131 + 8 * i);
        h.offset[i] = f64le(b, 155 + 8 * i);
        h.max[i] = f64le(b, 179 + 16 * i);
        h.min[i] = f64le(b, 187 + 16 * i);
    }
    if h.version.1 >= 3 && hs >= 235 {
        h.waveform_start = u64le(b, 227);
    }
    if h.version.1 >= 4 && hs >= 375 {
        h.evlr_start = u64le(b, 235);
        h.n_evlrs = u32le(b, 243);
        let n64 = u64le(b, 247);
        // The 64-bit count governs; the legacy one is zero for formats 6–10 or large files.
        if n64 > 0 || h.n_points == 0 {
            h.n_points = n64;
            for i in 0..15 {
                h.by_return[i] = u64le(b, 255 + 8 * i);
            }
        }
    }
    if h.scale.iter().any(|s| !s.is_finite() || *s == 0.0) {
        return Err(Error::invalid("LAS: a coordinate scale factor is zero or not finite"));
    }
    if (h.point_offset as usize) < hs {
        return Err(Error::invalid("LAS: the point data offset lies inside the header"));
    }
    Ok(h)
}

/// Parse the VLRs that follow the header. `b` holds the file from byte 0 up to the point data.
pub fn vlrs(b: &[u8], h: &Header) -> Result<Vec<Vlr>> {
    let mut out = Vec::new();
    let mut o = h.header_size as usize;
    let end = (h.point_offset as usize).min(b.len());
    for _ in 0..h.n_vlrs {
        if o + 54 > end {
            break; // A truncated VLR list: keep what was read (the header count is often wrong).
        }
        let len = u64::from(u16le(b, o + 20));
        let v = Vlr { user_id: text(&b[o + 2..o + 18]), record_id: u16le(b, o + 18), description: text(&b[o + 22..o + 54]), extended: false, data_offset: (o + 54) as u64, data_len: len };
        o += 54 + len as usize;
        if o > end {
            return Err(Error::invalid(format!("LAS: VLR {}/{} runs past the point data", v.user_id, v.record_id)));
        }
        out.push(v);
    }
    Ok(out)
}

/// Parse EVLR headers from a buffer that starts at `start` in the file.
pub fn evlrs(b: &[u8], start: u64, count: u32) -> Vec<Vlr> {
    let mut out = Vec::new();
    let mut o = 0usize;
    for _ in 0..count {
        if o + 60 > b.len() {
            break;
        }
        let len = u64le(b, o + 20);
        out.push(Vlr { user_id: text(&b[o + 2..o + 18]), record_id: u16le(b, o + 18), description: text(&b[o + 28..o + 60]), extended: true, data_offset: start + o as u64 + 60, data_len: len });
        o = match o.checked_add(60 + len as usize) {
            Some(x) => x,
            None => break,
        };
    }
    out
}

/// GeoTIFF keys from the GeoKeyDirectoryTag VLR (34735) with its double (34736) and ASCII (34737)
/// parameters: (key id, value) where value is an integer, a double or a string.
#[derive(Clone, Debug)]
pub enum KeyValue {
    Int(u16),
    Double(f64),
    Ascii(String),
}

pub fn geokeys(dir: &[u8], doubles: &[u8], ascii: &[u8]) -> Vec<(u16, KeyValue)> {
    let w = |i: usize| -> Option<u16> { dir.get(2 * i..2 * i + 2).map(|s| u16::from_le_bytes([s[0], s[1]])) };
    let Some(n) = w(3) else { return Vec::new() };
    let mut out = Vec::new();
    for k in 0..n as usize {
        let (Some(id), Some(loc), Some(count), Some(off)) = (w(4 + 4 * k), w(5 + 4 * k), w(6 + 4 * k), w(7 + 4 * k)) else { break };
        let v = match loc {
            0 => KeyValue::Int(off),
            34736 => {
                let o = 8 * off as usize;
                match doubles.get(o..o + 8) {
                    Some(s) => KeyValue::Double(f64::from_le_bytes(s.try_into().unwrap())),
                    None => continue,
                }
            }
            34737 => {
                let (o, c) = (off as usize, count as usize);
                match ascii.get(o..(o + c).min(ascii.len())) {
                    Some(s) => KeyValue::Ascii(String::from_utf8_lossy(s).trim_end_matches(['|', '\0']).to_string()),
                    None => continue,
                }
            }
            _ => continue,
        };
        out.push((id, v));
    }
    out
}

/// Units and vertical datum read from WKT 1 or WKT 2 (REQ-LDR-03): the horizontal CRS text, the
/// linear unit of the horizontal and vertical axes (metres per unit) and any EPSG codes found.
#[derive(Clone, Debug, Default)]
pub struct WktInfo {
    pub horizontal: String,
    pub h_unit: f64,
    pub h_unit_name: String,
    pub vertical: String,
    pub v_unit: f64,
    pub v_unit_name: String,
    pub h_epsg: Option<u32>,
    pub v_epsg: Option<u32>,
    pub geographic: bool,
}

/// Index of the bracket that closes the one opened at `open`.
fn close_of(s: &[u8], open: usize) -> Option<usize> {
    let mut depth = 0i32;
    let mut quoted = false;
    for (i, c) in s.iter().enumerate().skip(open) {
        match c {
            b'"' => quoted = !quoted,
            b'[' | b'(' if !quoted => depth += 1,
            b']' | b')' if !quoted => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// Top-level child nodes of a WKT node body: (keyword, full text).
fn children(body: &str) -> Vec<(String, String)> {
    let b = body.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphabetic() {
            let s = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            if i < b.len() && (b[i] == b'[' || b[i] == b'(') {
                if let Some(e) = close_of(b, i) {
                    out.push((body[s..i].to_ascii_uppercase(), body[s..=e].to_string()));
                    i = e + 1;
                    continue;
                }
            }
        } else if b[i] == b'"' {
            i += 1;
            while i < b.len() && b[i] != b'"' {
                i += 1;
            }
        }
        i += 1;
    }
    out
}

fn inner(node: &str) -> &str {
    match (node.find(['[', '(']), node.rfind([']', ')'])) {
        (Some(a), Some(b)) if b > a => &node[a + 1..b],
        _ => "",
    }
}

/// The last direct UNIT / LENGTHUNIT child, as (name, metres per unit), and the authority code.
fn unit_and_id(node: &str) -> (Option<(String, f64)>, Option<u32>) {
    let mut unit = None;
    let mut id = None;
    for (k, t) in children(inner(node)) {
        match k.as_str() {
            "UNIT" | "LENGTHUNIT" => {
                let body = inner(&t);
                let name = body.split('"').nth(1).unwrap_or("").to_string();
                let f = body.rsplit_once('"').map(|(_, r)| r).unwrap_or("").trim_start_matches(',').split(',').next().and_then(|x| x.trim().parse::<f64>().ok());
                if let Some(f) = f {
                    unit = Some((name, f));
                }
            }
            "AUTHORITY" | "ID" => {
                let body = inner(&t);
                if body.to_ascii_uppercase().contains("EPSG") {
                    let digits: String = body.rsplit(',').next().unwrap_or("").chars().filter(|c| c.is_ascii_digit()).collect();
                    id = digits.parse().ok();
                }
            }
            _ => {}
        }
    }
    (unit, id)
}

/// WKT 2 puts the length unit inside CS/AXIS nodes: the first LENGTHUNIT anywhere in the node.
fn first_lengthunit(body: &str) -> Option<(String, f64)> {
    let p = body.to_ascii_uppercase().find("LENGTHUNIT[")?;
    let e = close_of(body.as_bytes(), p + 10)?;
    unit_and_id(&format!("X[{}]", &body[p..=e])).0
}

pub fn wkt(text: &str) -> WktInfo {
    let mut w = WktInfo { h_unit: 1.0, v_unit: 1.0, ..WktInfo::default() };
    let t = text.trim_matches(char::from(0)).trim();
    let top = children(t);
    let mut nodes: Vec<(String, String)> = Vec::new();
    for (k, body) in top {
        if k == "COMPD_CS" || k == "COMPOUNDCRS" {
            nodes.extend(children(inner(&body)));
        } else {
            nodes.push((k, body));
        }
    }
    for (k, body) in nodes {
        match k.as_str() {
            "PROJCS" | "PROJCRS" | "PROJECTEDCRS" => {
                let (u, id) = unit_and_id(&body);
                w.horizontal = body.clone();
                w.h_epsg = id;
                if let Some((n, f)) = u.or_else(|| first_lengthunit(&body)) {
                    w.h_unit_name = n;
                    w.h_unit = f;
                }
            }
            "GEOGCS" | "GEOGCRS" | "GEODCRS" | "GEOGRAPHICCRS" => {
                let (_, id) = unit_and_id(&body);
                w.horizontal = body.clone();
                w.h_epsg = id;
                w.geographic = true;
                w.h_unit_name = "degree".into();
            }
            "VERT_CS" | "VERTCRS" | "VERTICALCRS" => {
                let (u, id) = unit_and_id(&body);
                w.vertical = body.clone();
                w.v_epsg = id;
                if let Some((n, f)) = u.or_else(|| first_lengthunit(&body)) {
                    w.v_unit_name = n;
                    w.v_unit = f;
                }
            }
            _ => {}
        }
    }
    // Without a vertical CRS the heights use the horizontal unit when it is linear.
    if w.vertical.is_empty() && !w.geographic {
        w.v_unit = w.h_unit;
        w.v_unit_name = w.h_unit_name.clone();
    }
    w
}
