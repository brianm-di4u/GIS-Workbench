//! NetCDF-3 classic CDF-1/2/5 reader and writer (FC-04, REQ-FMT-26/27).
//!
//! Reader: the header (dimensions, global and variable attributes, variables with their nc type,
//! shape, `vsize` and `begin`) and the record layout, every length checked against the bytes
//! given. Data are not read here: the JS source (`workers/decode/netcdf3.js`) fetches only the
//! byte ranges a window needs, from the `begin`/`recSize` facts in the JSON.
//!
//! Writer: a small line spec (`dim`, `gatt`, `var`, `att` lines, see [`write_header`]) → the CDF
//! header with every `begin` computed (non-record variables in order, then the record section),
//! plus a JSON layout so the caller streams the data into place.

use gw_abi::{Error, Json, Result};

/// nc types (1..6 classic, 7..11 CDF-5).
pub fn type_size(t: u32) -> Option<usize> {
    Some(match t {
        1 | 2 | 7 => 1,
        3 | 8 => 2,
        4 | 5 | 9 => 4,
        6 | 10 | 11 => 8,
        _ => return None,
    })
}

pub fn type_name(t: u32) -> &'static str {
    match t {
        1 => "byte",
        2 => "char",
        3 => "short",
        4 => "int",
        5 => "float",
        6 => "double",
        7 => "ubyte",
        8 => "ushort",
        9 => "uint",
        10 => "int64",
        11 => "uint64",
        _ => "?",
    }
}

const NC_DIMENSION: u32 = 0x0A;
const NC_VARIABLE: u32 = 0x0B;
const NC_ATTRIBUTE: u32 = 0x0C;
/// Attribute values kept per attribute (longer numeric attributes are cut, with `n` the full count).
const MAX_ATT_VALUES: usize = 4096;
const MAX_ITEMS: u64 = 1 << 20;

#[derive(Debug, Clone)]
pub enum AttValue {
    Text(String),
    Nums(Vec<f64>),
}

#[derive(Debug, Clone)]
pub struct Att {
    pub name: String,
    pub nc_type: u32,
    pub n: u64,
    pub value: AttValue,
}

#[derive(Debug, Clone)]
pub struct Dim {
    pub name: String,
    pub len: u64,
}

#[derive(Debug, Clone)]
pub struct Var {
    pub name: String,
    pub dims: Vec<usize>,
    pub atts: Vec<Att>,
    pub nc_type: u32,
    pub vsize: u64,
    pub begin: u64,
    pub record: bool,
    /// Bytes of one record (record variables) or of the whole variable, unpadded.
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct Header {
    pub version: u8,
    pub numrecs: u64,
    pub streaming: bool,
    pub dims: Vec<Dim>,
    pub atts: Vec<Att>,
    pub vars: Vec<Var>,
    pub rec_size: u64,
    pub header_len: u64,
}

struct R<'a> {
    b: &'a [u8],
    pos: usize,
    v: u8,
}

impl<'a> R<'a> {
    fn need(&self, n: u64) -> Result<usize> {
        let end = (self.pos as u64).checked_add(n).ok_or_else(|| Error::range("NetCDF header: length overflow"))?;
        if end > self.b.len() as u64 {
            return Err(gw_abi::err!(RANGE, "NetCDF header: need {n} bytes at offset {offset}, have {have}", n, offset = self.pos, have = self.b.len()));
        }
        Ok(end as usize)
    }
    fn bytes(&mut self, n: u64) -> Result<&'a [u8]> {
        let end = self.need(n)?;
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u32(&mut self) -> Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn u64(&mut self) -> Result<u64> {
        let b = self.bytes(8)?;
        Ok(u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
    /// NON_NEG / nelems: 4 bytes in CDF-1/2, 8 in CDF-5.
    fn count(&mut self) -> Result<u64> {
        if self.v == 5 {
            self.u64()
        } else {
            Ok(self.u32()? as u64)
        }
    }
    fn pad(&mut self, n: u64) -> Result<()> {
        let p = (4 - (n % 4)) % 4;
        self.bytes(p)?;
        Ok(())
    }
    fn name(&mut self) -> Result<String> {
        let n = self.count()?;
        if n > 1 << 16 {
            return Err(Error::invalid("NetCDF header: a name longer than 64 KB"));
        }
        let s = String::from_utf8_lossy(self.bytes(n)?).into_owned();
        self.pad(n)?;
        Ok(s)
    }
}

fn read_value(b: &[u8], t: u32) -> f64 {
    match t {
        1 => b[0] as i8 as f64,
        2 | 7 => b[0] as f64,
        3 => i16::from_be_bytes([b[0], b[1]]) as f64,
        8 => u16::from_be_bytes([b[0], b[1]]) as f64,
        4 => i32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
        9 => u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
        5 => f32::from_be_bytes([b[0], b[1], b[2], b[3]]) as f64,
        6 => f64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
        10 => i64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f64,
        11 => u64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]) as f64,
        _ => f64::NAN,
    }
}

fn atts(r: &mut R) -> Result<Vec<Att>> {
    let tag = r.u32()?;
    let n = r.count()?;
    if tag == 0 {
        if n != 0 {
            return Err(Error::invalid("NetCDF header: ABSENT attribute list with a count"));
        }
        return Ok(Vec::new());
    }
    if tag != NC_ATTRIBUTE {
        return Err(Error::invalid(format!("NetCDF header: expected an attribute list, found tag {tag}")));
    }
    if n > MAX_ITEMS {
        return Err(Error::limit("NetCDF header: too many attributes"));
    }
    let mut out = Vec::new();
    for _ in 0..n {
        let name = r.name()?;
        let t = r.u32()?;
        let sz = type_size(t).ok_or_else(|| gw_abi::err!(INVALID, "NetCDF attribute {name}: nc type {t}", name, t))?;
        if t > 6 && r.v != 5 {
            return Err(gw_abi::err!(INVALID, "NetCDF attribute {name}: CDF-5 type {t} in a CDF-{v} file", name, t, v = r.v));
        }
        let cnt = r.count()?;
        let len = cnt.checked_mul(sz as u64).ok_or_else(|| Error::range("NetCDF attribute length overflow"))?;
        let raw = r.bytes(len)?;
        r.pad(len)?;
        let value = if t == 2 {
            AttValue::Text(String::from_utf8_lossy(raw).trim_end_matches('\0').to_string())
        } else {
            let k = (cnt as usize).min(MAX_ATT_VALUES);
            AttValue::Nums((0..k).map(|i| read_value(&raw[i * sz..i * sz + sz], t)).collect())
        };
        out.push(Att { name, nc_type: t, n: cnt, value });
    }
    Ok(out)
}

/// Parse a CDF-1/2/5 header. `b` must hold the whole header (a prefix of the file); a RANGE
/// error asks the caller for more bytes.
pub fn parse(b: &[u8]) -> Result<Header> {
    if b.len() < 4 || &b[..3] != b"CDF" {
        return Err(Error::invalid("not a NetCDF-3 file (no CDF signature)"));
    }
    let v = b[3];
    if !matches!(v, 1 | 2 | 5) {
        return Err(gw_abi::err!(UNSUPPORTED, "NetCDF-3 version byte {v} (CDF-1, CDF-2 and CDF-5 are read)", v));
    }
    let mut r = R { b, pos: 4, v };
    let nr = r.count()?;
    let streaming = (v != 5 && nr == 0xFFFF_FFFF) || (v == 5 && nr == u64::MAX);
    // Dimensions.
    let tag = r.u32()?;
    let nd = r.count()?;
    if tag != 0 && tag != NC_DIMENSION {
        return Err(Error::invalid(format!("NetCDF header: expected the dimension list, found tag {tag}")));
    }
    if nd > MAX_ITEMS {
        return Err(Error::limit("NetCDF header: too many dimensions"));
    }
    let mut dims = Vec::new();
    let mut rec_dim = None;
    for i in 0..nd as usize {
        let name = r.name()?;
        let len = r.count()?;
        if len == 0 {
            if rec_dim.is_some() {
                return Err(Error::invalid("NetCDF header: two unlimited dimensions"));
            }
            rec_dim = Some(i);
        }
        dims.push(Dim { name, len });
    }
    let gatts = atts(&mut r)?;
    let tag = r.u32()?;
    let nv = r.count()?;
    if tag != 0 && tag != NC_VARIABLE {
        return Err(Error::invalid(format!("NetCDF header: expected the variable list, found tag {tag}")));
    }
    if nv > MAX_ITEMS {
        return Err(Error::limit("NetCDF header: too many variables"));
    }
    let mut vars = Vec::new();
    for _ in 0..nv {
        let name = r.name()?;
        let nvd = r.count()?;
        if nvd > 1024 {
            return Err(gw_abi::err!(LIMIT, "NetCDF variable {name}: more than 1024 dimensions", name));
        }
        let mut vd = Vec::new();
        for _ in 0..nvd {
            let id = r.count()? as usize;
            if id >= dims.len() {
                return Err(gw_abi::err!(INVALID, "NetCDF variable {name}: dimension id {id} of {count}", name, id, count = dims.len()));
            }
            vd.push(id);
        }
        let va = atts(&mut r)?;
        let t = r.u32()?;
        let sz = type_size(t).ok_or_else(|| gw_abi::err!(INVALID, "NetCDF variable {name}: nc type {t}", name, t))? as u64;
        if t > 6 && v != 5 {
            return Err(gw_abi::err!(INVALID, "NetCDF variable {name}: CDF-5 type {t} in a CDF-{v} file", name, t, v));
        }
        let vsize = r.count()?;
        let begin = if v == 1 { r.u32()? as u64 } else { r.u64()? };
        let record = vd.first().map(|&d| Some(d) == rec_dim).unwrap_or(false);
        if vd.iter().skip(1).any(|&d| Some(d) == rec_dim) {
            return Err(gw_abi::err!(INVALID, "NetCDF variable {name}: the unlimited dimension is not its first", name));
        }
        let mut bytes = sz;
        for &d in vd.iter().skip(if record { 1 } else { 0 }) {
            bytes = bytes.checked_mul(dims[d].len).ok_or_else(|| gw_abi::err!(RANGE, "NetCDF variable {name}: size overflow", name))?;
        }
        vars.push(Var { name, dims: vd, atts: va, nc_type: t, vsize, begin, record, bytes });
    }
    let header_len = r.pos as u64;
    // Record size: the sum of the padded per-record sizes; a lone record variable is not padded.
    let recs: Vec<&Var> = vars.iter().filter(|x| x.record).collect();
    let rec_size = if recs.len() == 1 { recs[0].bytes } else { recs.iter().map(|x| (x.bytes + 3) & !3).sum() };
    let numrecs = if streaming { 0 } else { nr };
    for x in &vars {
        if x.begin < header_len && x.bytes > 0 && !(x.record && numrecs == 0) {
            return Err(gw_abi::err!(INVALID, "NetCDF variable {name}: data begin {begin} is inside the header ({header_len} bytes)", name = x.name, begin = x.begin, header_len));
        }
    }
    Ok(Header { version: v, numrecs, streaming, dims, atts: gatts, vars, rec_size, header_len })
}

fn att_json(j: &mut Json, a: &[Att]) {
    j.arr();
    for x in a {
        j.obj().kv_str("name", &x.name).kv_str("type", type_name(x.nc_type)).kv_int("n", x.n as i64);
        match &x.value {
            AttValue::Text(s) => {
                j.kv_str("value", s);
            }
            AttValue::Nums(v) => {
                j.key("value").arr();
                for &n in v {
                    // NaN fill values stay distinguishable from absent values.
                    if n.is_nan() {
                        j.str("NaN");
                    } else if n.is_infinite() {
                        j.str(if n > 0.0 { "Infinity" } else { "-Infinity" });
                    } else {
                        j.num(n);
                    }
                }
                j.end_arr();
            }
        }
        j.end_obj();
    }
    j.end_arr();
}

pub fn to_json(h: &Header, file_size: u64) -> String {
    let mut j = Json::new();
    j.obj();
    j.kv_int("version", h.version as i64).kv_num("numrecs", h.numrecs as f64).kv_bool("streaming", h.streaming);
    j.kv_num("recSize", h.rec_size as f64).kv_num("headerLength", h.header_len as f64);
    // Records actually present in the file (a streamed or cut file).
    let data_end = h.vars.iter().filter(|v| v.record).map(|v| v.begin).min();
    let present = match data_end {
        Some(b) if h.rec_size > 0 && file_size > 0 => (file_size.saturating_sub(b) / h.rec_size).min(if h.streaming { u64::MAX } else { h.numrecs }),
        _ => h.numrecs,
    };
    j.kv_num("recordsPresent", present as f64);
    j.key("dims").arr();
    for d in &h.dims {
        j.obj().kv_str("name", &d.name).kv_num("len", d.len as f64).kv_bool("unlimited", d.len == 0).end_obj();
    }
    j.end_arr();
    j.key("attrs");
    att_json(&mut j, &h.atts);
    j.key("vars").arr();
    for v in &h.vars {
        j.obj().kv_str("name", &v.name).kv_str("type", type_name(v.nc_type)).kv_int("typeCode", v.nc_type as i64);
        j.kv_int("size", type_size(v.nc_type).unwrap_or(0) as i64);
        j.key("dims").arr();
        for &d in &v.dims {
            j.int(d as i64);
        }
        j.end_arr();
        j.key("shape").arr();
        for &d in &v.dims {
            j.num(if h.dims[d].len == 0 { h.numrecs as f64 } else { h.dims[d].len as f64 });
        }
        j.end_arr();
        j.kv_bool("record", v.record).kv_num("begin", v.begin as f64).kv_num("vsize", v.vsize as f64).kv_num("bytes", v.bytes as f64);
        let end = v.begin + v.bytes;
        j.kv_bool("sizeOk", file_size == 0 || end <= file_size || v.bytes == 0 || (v.record && present == 0));
        j.key("attrs");
        att_json(&mut j, &v.atts);
        j.end_obj();
    }
    j.end_arr();
    j.end_obj();
    j.finish()
}

// ---------------------------------------------------------------------------------------------
// Writer

fn type_code(s: &str) -> Option<u32> {
    Some(match s {
        "byte" | "i1" => 1,
        "char" | "s" => 2,
        "short" | "i2" => 3,
        "int" | "i4" => 4,
        "float" | "f4" => 5,
        "double" | "f8" => 6,
        "ubyte" | "u1" => 7,
        "ushort" | "u2" => 8,
        "uint" | "u4" => 9,
        "int64" | "i8" => 10,
        "uint64" | "u8" => 11,
        _ => return None,
    })
}

struct W {
    b: Vec<u8>,
    v: u8,
}

impl W {
    fn u32(&mut self, x: u32) {
        self.b.extend_from_slice(&x.to_be_bytes());
    }
    fn count(&mut self, x: u64) {
        if self.v == 5 {
            self.b.extend_from_slice(&x.to_be_bytes());
        } else {
            self.u32(x as u32);
        }
    }
    fn pad(&mut self) {
        while !self.b.len().is_multiple_of(4) {
            self.b.push(0);
        }
    }
    fn name(&mut self, s: &str) {
        self.count(s.len() as u64);
        self.b.extend_from_slice(s.as_bytes());
        self.pad();
    }
    fn value(&mut self, t: u32, x: f64) {
        match t {
            1 => self.b.push(x as i8 as u8),
            7 => self.b.push(x as u8),
            3 => self.b.extend_from_slice(&(x as i16).to_be_bytes()),
            8 => self.b.extend_from_slice(&(x as u16).to_be_bytes()),
            4 => self.b.extend_from_slice(&(x as i32).to_be_bytes()),
            9 => self.b.extend_from_slice(&(x as u32).to_be_bytes()),
            5 => self.b.extend_from_slice(&(x as f32).to_be_bytes()),
            6 => self.b.extend_from_slice(&x.to_be_bytes()),
            10 => self.b.extend_from_slice(&(x as i64).to_be_bytes()),
            11 => self.b.extend_from_slice(&(x as u64).to_be_bytes()),
            _ => {}
        }
    }
    fn atts(&mut self, a: &[Att]) {
        if a.is_empty() {
            self.u32(0);
            self.count(0);
            return;
        }
        self.u32(NC_ATTRIBUTE);
        self.count(a.len() as u64);
        for x in a {
            self.name(&x.name);
            self.u32(x.nc_type);
            match &x.value {
                AttValue::Text(s) => {
                    self.count(s.len() as u64);
                    self.b.extend_from_slice(s.as_bytes());
                }
                AttValue::Nums(v) => {
                    self.count(v.len() as u64);
                    for &n in v {
                        self.value(x.nc_type, n);
                    }
                }
            }
            self.pad();
        }
    }
}

/// Unescape `\n`, `\t`, `\\` in a spec text value.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c == '\\' {
            match it.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_att(name: &str, ty: &str, rest: &str) -> Result<Att> {
    let t = type_code(ty).ok_or_else(|| Error::invalid(format!("attribute {name}: type {ty}")))?;
    let value = if t == 2 {
        AttValue::Text(unescape(rest))
    } else {
        let v: Vec<f64> = rest
            .split_whitespace()
            .map(|s| match s {
                "NaN" | "nan" => Ok(f64::NAN),
                _ => s.parse::<f64>().map_err(|_| Error::invalid(format!("attribute {name}: value {s}"))),
            })
            .collect::<Result<_>>()?;
        if v.is_empty() {
            return Err(Error::invalid(format!("attribute {name}: no values")));
        }
        AttValue::Nums(v)
    };
    let n = match &value {
        AttValue::Text(s) => s.len() as u64,
        AttValue::Nums(v) => v.len() as u64,
    };
    Ok(Att { name: name.to_string(), nc_type: t, n, value })
}

/// Build a header from a line spec:
///
/// ```text
/// cdf 2                      version 1, 2 or 5
/// numrecs 3                  records (when a dimension is unlimited)
/// dim <name> <len>           len 0 = the unlimited (record) dimension
/// gatt <name> <type> <values…|text>
/// var <name> <type> [dim …]
/// att <name> <type> <values…|text>   (an attribute of the last `var`)
/// ```
///
/// Returns (header bytes, layout JSON `{headerLength, recSize, numrecs, fileSize, vars:[{name, begin, bytes, record}]}`).
pub fn write_header(spec: &str) -> Result<(Vec<u8>, String)> {
    let mut v = 2u8;
    let mut numrecs = 0u64;
    let mut dims: Vec<Dim> = Vec::new();
    let mut gatts: Vec<Att> = Vec::new();
    let mut vars: Vec<Var> = Vec::new();
    for (ln, line) in spec.lines().enumerate() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut sp = line.splitn(2, ' ');
        let kw = sp.next().unwrap_or("");
        let rest = sp.next().unwrap_or("");
        let err = |m: &str| Error::invalid(format!("NetCDF spec line {}: {m}", ln + 1));
        match kw {
            "cdf" => {
                v = rest.trim().parse::<u8>().map_err(|_| err("cdf version"))?;
                if !matches!(v, 1 | 2 | 5) {
                    return Err(err("cdf version must be 1, 2 or 5"));
                }
            }
            "numrecs" => numrecs = rest.trim().parse::<u64>().map_err(|_| err("numrecs"))?,
            "dim" => {
                let mut p = rest.split_whitespace();
                let name = p.next().ok_or_else(|| err("dim name"))?.to_string();
                let len = p.next().ok_or_else(|| err("dim length"))?.parse::<u64>().map_err(|_| err("dim length"))?;
                dims.push(Dim { name, len });
            }
            "gatt" | "att" => {
                let mut p = rest.splitn(3, ' ');
                let name = p.next().ok_or_else(|| err("attribute name"))?;
                let ty = p.next().ok_or_else(|| err("attribute type"))?;
                let a = parse_att(name, ty, p.next().unwrap_or(""))?;
                if kw == "gatt" {
                    gatts.push(a);
                } else {
                    vars.last_mut().ok_or_else(|| err("att before any var"))?.atts.push(a);
                }
            }
            "var" => {
                let mut p = rest.split_whitespace();
                let name = p.next().ok_or_else(|| err("var name"))?.to_string();
                let ty = p.next().ok_or_else(|| err("var type"))?;
                let t = type_code(ty).ok_or_else(|| err("var type"))?;
                let mut vd = Vec::new();
                for d in p {
                    let id = dims.iter().position(|x| x.name == d).ok_or_else(|| err(&format!("unknown dimension {d}")))?;
                    vd.push(id);
                }
                vars.push(Var { name, dims: vd, atts: Vec::new(), nc_type: t, vsize: 0, begin: 0, record: false, bytes: 0 });
            }
            _ => return Err(err(&format!("unknown keyword {kw}"))),
        }
    }
    if vars.iter().any(|x| x.nc_type > 6) && v != 5 {
        return Err(Error::invalid("CDF-5 types need cdf 5"));
    }
    if dims.iter().filter(|d| d.len == 0).count() > 1 {
        return Err(Error::invalid("NetCDF-3 has one unlimited dimension at most"));
    }
    let rec_dim = dims.iter().position(|d| d.len == 0);
    for x in vars.iter_mut() {
        x.record = x.dims.first().map(|&d| Some(d) == rec_dim).unwrap_or(false);
        if x.dims.iter().skip(1).any(|&d| Some(d) == rec_dim) {
            return Err(gw_abi::err!(INVALID, "variable {name}: the unlimited dimension must come first", name = x.name));
        }
        let mut n = type_size(x.nc_type).unwrap_or(1) as u64;
        for &d in x.dims.iter().skip(x.record as usize) {
            n = n.checked_mul(dims[d].len).ok_or_else(|| Error::range("variable size overflow"))?;
        }
        x.bytes = n;
        x.vsize = (n + 3) & !3;
        if v == 1 && x.vsize > u32::MAX as u64 {
            return Err(gw_abi::err!(LIMIT, "variable {name} is larger than 4 GB: CDF-1 cannot hold it", name = x.name));
        }
    }
    // Encode once with zero begins to learn the header length, then again with the offsets.
    let encode = |vars: &[Var]| -> Vec<u8> {
        let mut w = W { b: Vec::new(), v };
        w.b.extend_from_slice(b"CDF");
        w.b.push(v);
        w.count(numrecs);
        if dims.is_empty() {
            w.u32(0);
            w.count(0);
        } else {
            w.u32(NC_DIMENSION);
            w.count(dims.len() as u64);
            for d in &dims {
                w.name(&d.name);
                w.count(d.len);
            }
        }
        w.atts(&gatts);
        if vars.is_empty() {
            w.u32(0);
            w.count(0);
        } else {
            w.u32(NC_VARIABLE);
            w.count(vars.len() as u64);
            for x in vars {
                w.name(&x.name);
                w.count(x.dims.len() as u64);
                for &d in &x.dims {
                    w.count(d as u64);
                }
                w.atts(&x.atts);
                w.u32(x.nc_type);
                w.count(x.vsize.min(if v == 5 { u64::MAX } else { u32::MAX as u64 }));
                if v == 1 {
                    w.u32(x.begin as u32);
                } else {
                    w.b.extend_from_slice(&x.begin.to_be_bytes());
                }
            }
        }
        w.b
    };
    let hlen = encode(&vars).len() as u64;
    let mut off = hlen;
    for x in vars.iter_mut().filter(|x| !x.record) {
        x.begin = off;
        off += x.vsize;
    }
    let recs = vars.iter().filter(|x| x.record).count();
    let mut rec_size = 0;
    for x in vars.iter_mut().filter(|x| x.record) {
        x.begin = off + rec_size;
        rec_size += if recs == 1 { x.bytes } else { x.vsize };
    }
    if v == 1 && off > u32::MAX as u64 {
        return Err(Error::limit("the data start beyond 4 GB: write CDF-2 (64-bit offset) instead"));
    }
    let head = encode(&vars);
    let file_size = off + rec_size * numrecs;
    let mut j = Json::new();
    j.obj().kv_num("headerLength", head.len() as f64).kv_num("recSize", rec_size as f64).kv_num("numrecs", numrecs as f64).kv_num("fileSize", file_size as f64);
    j.key("vars").arr();
    for x in &vars {
        j.obj().kv_str("name", &x.name).kv_num("begin", x.begin as f64).kv_num("bytes", x.bytes as f64).kv_num("vsize", x.vsize as f64).kv_bool("record", x.record).end_obj();
    }
    j.end_arr().end_obj();
    Ok((head, j.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: &str = "cdf 2\nnumrecs 2\ndim time 0\ndim y 3\ndim x 4\ngatt Conventions char CF-1.8\ngatt title char a\\nb\nvar crs int\natt grid_mapping_name char latitude_longitude\natt semi_major_axis double 6378137\nvar x double x\nvar y double y\nvar t float time y x\natt _FillValue float NaN\natt valid_range short -5 5\nvar u byte time\n";

    #[test]
    fn round_trip_header() {
        for v in [1u8, 2, 5] {
            let spec = SPEC.replacen("cdf 2", &format!("cdf {v}"), 1);
            let (head, layout) = write_header(&spec).unwrap();
            assert!(layout.contains("\"recSize\":52"), "{layout}"); // 48 (float 3×4) + 4 (byte, padded)
            let h = parse(&head).unwrap();
            assert_eq!(h.version, v);
            assert_eq!(h.numrecs, 2);
            assert_eq!(h.dims.len(), 3);
            assert_eq!(h.vars.len(), 5);
            assert_eq!(h.rec_size, 52);
            let t = &h.vars[3];
            assert!(t.record && t.bytes == 48 && t.begin >= h.header_len);
            assert_eq!(h.vars[1].begin, h.header_len + 4); // x, after the scalar crs
            assert_eq!(h.vars[2].begin, h.header_len + 36);
            match &h.atts[1].value {
                AttValue::Text(s) => assert_eq!(s, "a\nb"),
                _ => panic!(),
            }
            match &t.atts[0].value {
                AttValue::Nums(n) => assert!(n[0].is_nan()),
                _ => panic!(),
            }
            let j = to_json(&h, 0);
            assert!(j.contains("\"_FillValue\"") && j.contains("\"NaN\""));
            // Every prefix shorter than the header fails cleanly.
            for n in 0..head.len() {
                assert!(parse(&head[..n]).is_err());
            }
        }
    }

    #[test]
    fn lone_record_variable_is_not_padded() {
        let (head, _) = write_header("cdf 1\nnumrecs 3\ndim t 0\nvar a byte t\n").unwrap();
        let h = parse(&head).unwrap();
        assert_eq!(h.rec_size, 1);
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(b"CDF\x03\0\0\0\0").is_err());
        assert!(parse(b"HDF\x01").is_err());
        // dimension id out of range
        let (mut head, _) = write_header("cdf 1\ndim x 2\nvar a int x\n").unwrap();
        let n = head.len();
        head[n - 24..n - 20].copy_from_slice(&9u32.to_be_bytes()); // the dimid of `a`
        assert!(parse(&head).is_err());
        assert!(write_header("cdf 1\nvar a int nope\n").is_err());
        assert!(write_header("cdf 2\nvar a uint\n").is_err());
    }
}
