//! GeoPDF scanner (REQ-FMT-14): just enough of PDF to georeference raster pages — the indirect
//! objects (found by scanning for `n g obj`, so damaged cross-reference tables do not matter),
//! pages with their MediaBox, ISO 32000-2 geospatial viewports (/VP with a /GEO /Measure:
//! /GPTS, /LPTS, /GCS EPSG or WKT), image XObjects (size, colour space, filter, stream range) and
//! where an uncompressed content stream draws them (`a b c d e f cm /Name Do`). Image bytes are
//! decoded by the caller (JPEG through the browser, Flate through DecompressionStream).

use gw_abi::{Error, Json, Result};
use std::collections::HashMap;

const MAX_OBJECTS: usize = 1_000_000;
const MAX_DEPTH: usize = 32;

#[derive(Clone, Debug, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u8>),
    Name(String),
    Arr(Vec<Obj>),
    Dict(Vec<(String, Obj)>),
    Ref(u32, u32),
    /// A stream: its dictionary and the byte range of its data in the file.
    Stream(Vec<(String, Obj)>, usize, usize),
}

impl Obj {
    pub fn get(&self, k: &str) -> Option<&Obj> {
        match self {
            Obj::Dict(d) | Obj::Stream(d, _, _) => d.iter().find(|(x, _)| x == k).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn num(&self) -> Option<f64> {
        if let Obj::Num(v) = self {
            Some(*v)
        } else {
            None
        }
    }
    pub fn name(&self) -> Option<&str> {
        if let Obj::Name(v) = self {
            Some(v)
        } else {
            None
        }
    }
}

struct Lex<'a> {
    b: &'a [u8],
    p: usize,
}

fn ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n' | 0x0c | 0)
}
fn delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

impl<'a> Lex<'a> {
    fn skip(&mut self) {
        while self.p < self.b.len() {
            if ws(self.b[self.p]) {
                self.p += 1;
            } else if self.b[self.p] == b'%' {
                while self.p < self.b.len() && self.b[self.p] != b'\n' && self.b[self.p] != b'\r' {
                    self.p += 1;
                }
            } else {
                break;
            }
        }
    }
    fn peek(&self) -> Option<u8> {
        self.b.get(self.p).copied()
    }
    fn word(&mut self) -> &'a [u8] {
        let s = self.p;
        while self.p < self.b.len() && !ws(self.b[self.p]) && !delim(self.b[self.p]) {
            self.p += 1;
        }
        &self.b[s..self.p]
    }

    fn value(&mut self, depth: usize) -> Result<Obj> {
        if depth > MAX_DEPTH {
            return Err(Error::limit("PDF: objects nested too deep"));
        }
        self.skip();
        let c = self.peek().ok_or_else(|| Error::range("PDF: unexpected end"))?;
        match c {
            b'/' => {
                self.p += 1;
                let w = self.word();
                let mut s = String::new();
                let mut i = 0;
                while i < w.len() {
                    if w[i] == b'#' && i + 2 < w.len() {
                        if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&w[i + 1..i + 3]).unwrap_or("zz"), 16) {
                            s.push(v as char);
                            i += 3;
                            continue;
                        }
                    }
                    s.push(w[i] as char);
                    i += 1;
                }
                Ok(Obj::Name(s))
            }
            b'(' => {
                self.p += 1;
                let mut out = Vec::new();
                let mut nest = 1;
                while self.p < self.b.len() {
                    let x = self.b[self.p];
                    self.p += 1;
                    match x {
                        b'\\' => {
                            if let Some(&e) = self.b.get(self.p) {
                                self.p += 1;
                                out.push(match e {
                                    b'n' => b'\n',
                                    b'r' => b'\r',
                                    b't' => b'\t',
                                    b'b' => 8,
                                    b'f' => 12,
                                    o => o,
                                });
                            }
                        }
                        b'(' => {
                            nest += 1;
                            out.push(x);
                        }
                        b')' => {
                            nest -= 1;
                            if nest == 0 {
                                break;
                            }
                            out.push(x);
                        }
                        _ => out.push(x),
                    }
                    if out.len() > 1 << 24 {
                        return Err(Error::limit("PDF: string too long"));
                    }
                }
                Ok(Obj::Str(out))
            }
            b'<' if self.b.get(self.p + 1) == Some(&b'<') => {
                self.p += 2;
                let mut d = Vec::new();
                loop {
                    self.skip();
                    if self.b.get(self.p..self.p + 2) == Some(b">>") {
                        self.p += 2;
                        break;
                    }
                    let k = match self.value(depth + 1)? {
                        Obj::Name(n) => n,
                        _ => return Err(Error::invalid("PDF: dictionary key is not a name")),
                    };
                    let v = self.value(depth + 1)?;
                    d.push((k, v));
                    if d.len() > 100_000 {
                        return Err(Error::limit("PDF: dictionary too large"));
                    }
                }
                Ok(Obj::Dict(d))
            }
            b'<' => {
                self.p += 1;
                let mut hex = Vec::new();
                while self.p < self.b.len() && self.b[self.p] != b'>' {
                    if self.b[self.p].is_ascii_hexdigit() {
                        hex.push(self.b[self.p]);
                    }
                    self.p += 1;
                }
                self.p += 1;
                if hex.len() % 2 == 1 {
                    hex.push(b'0');
                }
                Ok(Obj::Str(hex.chunks(2).map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap_or("00"), 16).unwrap_or(0)).collect()))
            }
            b'[' => {
                self.p += 1;
                let mut a = Vec::new();
                loop {
                    self.skip();
                    if self.peek() == Some(b']') {
                        self.p += 1;
                        break;
                    }
                    if self.peek().is_none() {
                        return Err(Error::range("PDF: unterminated array"));
                    }
                    a.push(self.value(depth + 1)?);
                    if a.len() > 1_000_000 {
                        return Err(Error::limit("PDF: array too large"));
                    }
                }
                Ok(Obj::Arr(a))
            }
            _ => {
                let w = self.word();
                if w.is_empty() {
                    self.p += 1;
                    return Err(Error::invalid("PDF: unexpected delimiter"));
                }
                let t = std::str::from_utf8(w).unwrap_or("");
                match t {
                    "true" => return Ok(Obj::Bool(true)),
                    "false" => return Ok(Obj::Bool(false)),
                    "null" => return Ok(Obj::Null),
                    _ => {}
                }
                let n: f64 = t.parse().map_err(|_| Error::invalid(format!("PDF: unexpected token {t}")))?;
                // An indirect reference: "n g R".
                let save = self.p;
                self.skip();
                let w2 = self.word();
                if let Ok(g) = std::str::from_utf8(w2).unwrap_or("x").parse::<u32>() {
                    self.skip();
                    if self.peek() == Some(b'R') && self.b.get(self.p + 1).is_none_or(|c| ws(*c) || delim(*c)) {
                        self.p += 1;
                        return Ok(Obj::Ref(n as u32, g));
                    }
                }
                self.p = save;
                Ok(Obj::Num(n))
            }
        }
    }
}

pub struct Pdf<'a> {
    b: &'a [u8],
    /// Object number → its offset (the last definition wins, as incremental updates intend).
    index: HashMap<u32, usize>,
    /// Objects stored in compressed object streams (PDF 1.5 /ObjStm): number → (buffer, offset).
    packed: HashMap<u32, (usize, usize)>,
    bufs: Vec<Vec<u8>>,
}

/// Inflate a zlib (FlateDecode) stream, bounded; bytes after the end of the stream are ignored.
pub fn inflate(data: &[u8], limit: usize) -> Result<Vec<u8>> {
    miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(data, limit).map_err(|e| Error::invalid(format!("PDF: Flate stream: {:?}", e.status)))
}

impl<'a> Pdf<'a> {
    pub fn scan(b: &'a [u8]) -> Result<Self> {
        if b.len() < 8 || &b[..5] != b"%PDF-" {
            return Err(Error::invalid("not a PDF file"));
        }
        let mut index = HashMap::new();
        let mut i = 0;
        while i + 5 < b.len() {
            // "obj" preceded by "<num> <num> " at a token boundary.
            if &b[i..i + 3] == b"obj" && (i + 3 == b.len() || ws(b[i + 3]) || delim(b[i + 3])) && i > 0 && ws(b[i - 1]) {
                let mut j = i - 1;
                while j > 0 && ws(b[j]) {
                    j -= 1;
                }
                let ge = j + 1;
                while j > 0 && b[j].is_ascii_digit() {
                    j -= 1;
                }
                let gs = j + 1;
                if gs < ge {
                    while j > 0 && ws(b[j]) {
                        j -= 1;
                    }
                    let ne = j + 1;
                    while j > 0 && b[j].is_ascii_digit() {
                        j -= 1;
                    }
                    let ns = if b[j].is_ascii_digit() { j } else { j + 1 };
                    if ns < ne {
                        if let Ok(n) = std::str::from_utf8(&b[ns..ne]).unwrap_or("x").parse::<u32>() {
                            index.insert(n, i + 3);
                            if index.len() > MAX_OBJECTS {
                                return Err(Error::limit("PDF: too many objects"));
                            }
                        }
                    }
                }
            }
            i += 1;
        }
        let mut pdf = Pdf { b, index, packed: HashMap::new(), bufs: Vec::new() };
        pdf.unpack_object_streams();
        Ok(pdf)
    }

    /// Read every /Type /ObjStm stream (TE-001: US Topo keeps its viewport and CRS there).
    fn unpack_object_streams(&mut self) {
        let mut nums: Vec<u32> = self.index.keys().copied().collect();
        nums.sort_unstable();
        let mut total = 0usize;
        for n in nums {
            let Ok(Obj::Stream(d, s, len)) = self.object(n) else { continue };
            let dd = Obj::Dict(d);
            if dd.get("Type").and_then(|t| t.name()) != Some("ObjStm") {
                continue;
            }
            let filter_ok = matches!(dd.get("Filter"), None) || dd.get("Filter").and_then(|f| f.name()) == Some("FlateDecode");
            let (Some(count), Some(first)) = (dd.get("N").and_then(|x| x.num()), dd.get("First").and_then(|x| x.num())) else { continue };
            if !filter_ok || count < 0.0 || count > 100_000.0 {
                continue;
            }
            let raw = self.bytes(s, len);
            let data = if dd.get("Filter").is_some() { inflate(raw, 64 << 20).unwrap_or_default() } else { raw.to_vec() };
            total += data.len();
            if data.is_empty() || total > 512 << 20 {
                continue;
            }
            // Header: N pairs "objnum offset" before /First.
            let mut lx = Lex { b: &data[..(first as usize).min(data.len())], p: 0 };
            let mut pairs = Vec::new();
            for _ in 0..count as usize {
                let (Ok(Obj::Num(on)), Ok(Obj::Num(off))) = (lx.value(0), lx.value(0)) else { break };
                pairs.push((on as u32, first as usize + off as usize));
            }
            let bi = self.bufs.len();
            for (on, off) in pairs {
                if off < data.len() && !self.index.contains_key(&on) {
                    self.packed.insert(on, (bi, off));
                }
            }
            self.bufs.push(data);
        }
    }

    /// Parse object n (streams carry their data range).
    pub fn object(&self, n: u32) -> Result<Obj> {
        if !self.index.contains_key(&n) {
            if let Some(&(bi, off)) = self.packed.get(&n) {
                // Objects in object streams are never streams themselves.
                let mut lx = Lex { b: &self.bufs[bi], p: off };
                return lx.value(0);
            }
        }
        let &off = self.index.get(&n).ok_or_else(|| Error::range(format!("PDF: object {n} not found")))?;
        let mut lx = Lex { b: self.b, p: off };
        let v = lx.value(0)?;
        lx.skip();
        if let Obj::Dict(d) = &v {
            if self.b.get(lx.p..lx.p + 6) == Some(b"stream") {
                let mut s = lx.p + 6;
                if self.b.get(s) == Some(&b'\r') {
                    s += 1;
                }
                if self.b.get(s) == Some(&b'\n') {
                    s += 1;
                }
                let len = match v.get("Length") {
                    Some(Obj::Num(l)) => *l as usize,
                    Some(Obj::Ref(r, _)) => self.object(*r).ok().and_then(|o| o.num()).unwrap_or(0.0) as usize,
                    _ => 0,
                };
                let len = if len == 0 || s + len > self.b.len() { self.b[s..].windows(9).position(|w| w == b"endstream").unwrap_or(self.b.len() - s) } else { len };
                return Ok(Obj::Stream(d.clone(), s, len));
            }
        }
        Ok(v)
    }

    /// Follow references (bounded).
    pub fn resolve(&self, o: &Obj) -> Obj {
        let mut cur = o.clone();
        for _ in 0..16 {
            if let Obj::Ref(n, _) = cur {
                cur = self.object(n).unwrap_or(Obj::Null);
            } else {
                break;
            }
        }
        cur
    }

    pub fn bytes(&self, s: usize, n: usize) -> &'a [u8] {
        &self.b[s.min(self.b.len())..(s + n).min(self.b.len())]
    }
}

fn nums(o: &Obj) -> Vec<f64> {
    match o {
        Obj::Arr(a) => a.iter().filter_map(|x| x.num()).collect(),
        _ => vec![],
    }
}

/// Numbers given as numbers or as numeric strings (LGIDict writes `(500000.0)`).
fn nums_or_strs(o: &Obj) -> Vec<f64> {
    match o {
        Obj::Arr(a) => a
            .iter()
            .filter_map(|x| match x {
                Obj::Num(v) => Some(*v),
                Obj::Str(s) => std::str::from_utf8(s).ok().and_then(|t| t.trim().parse().ok()),
                _ => None,
            })
            .collect(),
        _ => vec![],
    }
}

/// `"filters": [...]` (the full chain, e.g. ASCII85Decode then DCTDecode) and, when present,
/// `"decodeParms": {predictor, colors, columns, bpc}` of the last filter that has them.
fn filters(pdf: &Pdf, d: &Obj, j: &mut Json) {
    j.key("filters").arr();
    match pdf.resolve(d.get("Filter").unwrap_or(&Obj::Null)) {
        Obj::Name(f) => {
            j.str(&f);
        }
        Obj::Arr(a) => {
            for f in a.iter().filter_map(|x| x.name()) {
                j.str(f);
            }
        }
        _ => {}
    }
    j.end_arr();
    let dp = match pdf.resolve(d.get("DecodeParms").unwrap_or(&Obj::Null)) {
        Obj::Arr(a) => a.iter().rev().map(|x| pdf.resolve(x)).find(|x| matches!(x, Obj::Dict(_))),
        o @ Obj::Dict(_) => Some(o),
        _ => None,
    };
    if let Some(dp) = dp {
        j.key("decodeParms").obj();
        for (k, out) in [("Predictor", "predictor"), ("Colors", "colors"), ("Columns", "columns"), ("BitsPerComponent", "bpc")] {
            if let Some(v) = pdf.resolve(dp.get(k).unwrap_or(&Obj::Null)).num() {
                j.kv_num(out, v);
            }
        }
        j.end_obj();
    }
}

fn image_json(pdf: &Pdf, id: &str, form: &str, d: &[(String, Obj)], s: usize, n: usize, j: &mut Json) {
    let dd = Obj::Dict(d.to_vec());
    let filter = match pdf.resolve(dd.get("Filter").unwrap_or(&Obj::Null)) {
        Obj::Name(f) => f,
        Obj::Arr(a) => a.iter().filter_map(|x| x.name()).collect::<Vec<_>>().join(","),
        _ => String::new(),
    };
    let cs = match pdf.resolve(dd.get("ColorSpace").unwrap_or(&Obj::Null)) {
        Obj::Name(c) => c,
        Obj::Arr(a) => a.first().and_then(|x| x.name()).unwrap_or("").to_string(),
        _ => String::new(),
    };
    // ICCBased colour spaces: the component count of the profile (1 grey, 3 RGB, 4 CMYK).
    let icc_n = match pdf.resolve(dd.get("ColorSpace").unwrap_or(&Obj::Null)) {
        Obj::Arr(a) if a.first().and_then(|x| x.name()) == Some("ICCBased") => a.get(1).map(|x| pdf.resolve(x)).and_then(|p| p.get("N").and_then(|n| n.num())),
        _ => None,
    };
    j.obj().kv_str("name", id).kv_str("form", form);
    j.kv_num("width", dd.get("Width").and_then(|x| x.num()).unwrap_or(0.0)).kv_num("height", dd.get("Height").and_then(|x| x.num()).unwrap_or(0.0));
    j.kv_num("bpc", dd.get("BitsPerComponent").and_then(|x| x.num()).unwrap_or(8.0)).kv_str("colorSpace", &cs).kv_str("filter", &filter);
    if let Some(n) = icc_n {
        j.kv_num("components", n);
    }
    j.kv_num("offset", s as f64).kv_num("length", n as f64);
    filters(pdf, &dd, j);
    if let Obj::Stream(md, ms, mn) = pdf.resolve(dd.get("SMask").unwrap_or(&Obj::Null)) {
        let m = Obj::Dict(md.clone());
        j.key("smask").obj().kv_num("width", m.get("Width").and_then(|x| x.num()).unwrap_or(0.0)).kv_num("height", m.get("Height").and_then(|x| x.num()).unwrap_or(0.0));
        j.kv_num("bpc", m.get("BitsPerComponent").and_then(|x| x.num()).unwrap_or(8.0)).kv_num("offset", ms as f64).kv_num("length", mn as f64);
        filters(pdf, &m, j);
        j.end_obj();
    }
    j.end_obj();
}

/// Image XObjects of a resource dictionary into `images`, recursing into Form XObjects (listed in
/// `forms` with their id, parent, matrix and content range).
fn xobjects(pdf: &Pdf, res: &Obj, prefix: &str, depth: usize, images: &mut Json, forms: &mut Json) {
    if depth > 8 {
        return;
    }
    let xo = pdf.resolve(res.get("XObject").unwrap_or(&Obj::Null));
    let Obj::Dict(items) = &xo else { return };
    for (name, r) in items.iter().take(8192) {
        let Obj::Stream(d, s, n) = pdf.resolve(r) else { continue };
        let dd = Obj::Dict(d.clone());
        let id = format!("{prefix}{name}");
        match dd.get("Subtype").and_then(|x| x.name()) {
            Some("Image") => image_json(pdf, &id, prefix.trim_end_matches('/'), &d, s, n, images),
            Some("Form") => {
                forms.obj().kv_str("id", &id).kv_str("name", name).kv_str("parent", prefix.trim_end_matches('/')).key("matrix").arr();
                let m = nums(&pdf.resolve(dd.get("Matrix").unwrap_or(&Obj::Null)));
                for v in if m.len() == 6 { m } else { vec![1.0, 0.0, 0.0, 1.0, 0.0, 0.0] } {
                    forms.num(v);
                }
                forms.end_arr().kv_num("offset", s as f64).kv_num("length", n as f64);
                filters(pdf, &dd, forms);
                forms.end_obj();
                let fres = pdf.resolve(dd.get("Resources").unwrap_or(&Obj::Null));
                xobjects(pdf, &fres, &format!("{id}/"), depth + 1, images, forms);
            }
            _ => {}
        }
    }
}

/// Placements in a decoded content stream → JSON [{name, matrix}] (`gw_pdf_placements`).
pub fn placements_json(content: &[u8]) -> String {
    let mut j = Json::new();
    j.arr();
    for (name, m) in placements(content).into_iter().take(100_000) {
        j.obj().kv_str("name", &name).key("matrix").arr();
        for v in m {
            j.num(v);
        }
        j.end_arr().end_obj();
    }
    j.end_arr();
    j.finish()
}

/// `a b c d e f cm /Name Do` placements in an uncompressed content stream.
fn placements(content: &[u8]) -> Vec<(String, [f64; 6])> {
    let mut out = Vec::new();
    let mut lx = Lex { b: content, p: 0 };
    let mut stack: Vec<Obj> = Vec::new();
    let mut ctm = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    let mut saved: Vec<[f64; 6]> = Vec::new();
    let mut guard = 0;
    while lx.p < content.len() && guard < 2_000_000 {
        guard += 1;
        lx.skip();
        let Some(c) = lx.peek() else { break };
        if c.is_ascii_alphabetic() || c == b'\'' || c == b'"' {
            let w = std::str::from_utf8(lx.word()).unwrap_or("").to_string();
            if w.is_empty() {
                lx.p += 1;
            }
            match w.as_str() {
                "q" => saved.push(ctm),
                "Q" => ctm = saved.pop().unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
                "cm" => {
                    let n: Vec<f64> = stack.iter().filter_map(|o| o.num()).collect();
                    if n.len() >= 6 {
                        let m = [n[n.len() - 6], n[n.len() - 5], n[n.len() - 4], n[n.len() - 3], n[n.len() - 2], n[n.len() - 1]];
                        // new = m × ctm
                        ctm = [m[0] * ctm[0] + m[1] * ctm[2], m[0] * ctm[1] + m[1] * ctm[3], m[2] * ctm[0] + m[3] * ctm[2], m[2] * ctm[1] + m[3] * ctm[3], m[4] * ctm[0] + m[5] * ctm[2] + ctm[4], m[4] * ctm[1] + m[5] * ctm[3] + ctm[5]];
                    }
                }
                "Do" => {
                    if let Some(Obj::Name(n)) = stack.last() {
                        out.push((n.clone(), ctm));
                    }
                }
                "BI" => {
                    // Inline image: skip to EI.
                    if let Some(k) = content[lx.p..].windows(2).position(|w| w == b"EI") {
                        lx.p += k + 2;
                    }
                }
                _ => {}
            }
            stack.clear();
        } else {
            match lx.value(0) {
                Ok(v) => stack.push(v),
                Err(_) => lx.p += 1,
            }
            if stack.len() > 64 {
                stack.remove(0);
            }
        }
    }
    out
}

/// Pages, geospatial viewports and images → JSON.
pub fn to_json(pdf: &Pdf) -> Result<String> {
    let mut pages: Vec<u32> = pdf.index.keys().chain(pdf.packed.keys()).copied().filter(|&n| matches!(pdf.object(n).ok().and_then(|o| o.get("Type").and_then(|t| t.name().map(String::from))), Some(ref t) if t == "Page")).collect();
    pages.sort();
    let mut j = Json::new();
    j.obj().kv_int("objects", (pdf.index.len() + pdf.packed.len()) as i64).key("pages").arr();
    for &pn in pages.iter().take(200) {
        let page = pdf.object(pn)?;
        j.obj().kv_int("object", pn as i64);
        j.key("mediaBox").arr();
        for v in nums(&pdf.resolve(page.get("MediaBox").unwrap_or(&Obj::Null))) {
            j.num(v);
        }
        j.end_arr();
        j.key("viewports").arr();
        if let Obj::Arr(vps) = pdf.resolve(page.get("VP").unwrap_or(&Obj::Null)) {
            for vp in vps.iter().take(64) {
                let vp = pdf.resolve(vp);
                let m = pdf.resolve(vp.get("Measure").unwrap_or(&Obj::Null));
                if m.get("Subtype").and_then(|x| x.name()) != Some("GEO") {
                    continue;
                }
                j.obj().key("bbox").arr();
                for v in nums(&pdf.resolve(vp.get("BBox").unwrap_or(&Obj::Null))) {
                    j.num(v);
                }
                j.end_arr().key("gpts").arr();
                for v in nums(&pdf.resolve(m.get("GPTS").unwrap_or(&Obj::Null))) {
                    j.num(v);
                }
                j.end_arr().key("lpts").arr();
                for v in nums(&pdf.resolve(m.get("LPTS").unwrap_or(&Obj::Null))) {
                    j.num(v);
                }
                j.end_arr();
                let gcs = pdf.resolve(m.get("GCS").unwrap_or(&Obj::Null));
                if let Some(e) = gcs.get("EPSG").and_then(|x| x.num()) {
                    j.kv_int("epsg", e as i64);
                }
                if let Some(Obj::Str(w)) = gcs.get("WKT") {
                    j.kv_str("wkt", &String::from_utf8_lossy(w));
                }
                j.end_obj();
            }
        }
        j.end_arr();
        // Images of the page's resources, and of the Form XObjects it uses (nested forms flattened;
        // an image inside form `Fm1` has id `Fm1/Im0`). Forms are listed with their matrix and
        // content-stream range so the caller can place their images (TE-007).
        let res = pdf.resolve(page.get("Resources").unwrap_or(&Obj::Null));
        let mut forms = Json::new();
        forms.arr();
        j.key("images").arr();
        xobjects(pdf, &res, "", 0, &mut j, &mut forms);
        j.end_arr();
        forms.end_arr();
        j.key("forms").raw(&forms.finish());
        // Every content stream, compressed or not: the caller inflates and runs gw_pdf_placements.
        j.key("contents").arr();
        let contents: Vec<Obj> = match pdf.resolve(page.get("Contents").unwrap_or(&Obj::Null)) {
            Obj::Arr(a) => a.iter().map(|x| pdf.resolve(x)).collect(),
            o => vec![o],
        };
        for c in &contents {
            if let Obj::Stream(d, s, n) = c {
                j.obj().kv_num("offset", *s as f64).kv_num("length", *n as f64);
                filters(pdf, &Obj::Dict(d.clone()), &mut j);
                j.end_obj();
            }
        }
        j.end_arr();
        // Pre-ISO GeoPDF georeferencing (TerraGo / OGC best practice LGIDict, e.g. 2009–2013 US Topo).
        j.key("lgi").arr();
        let lgis: Vec<Obj> = match pdf.resolve(page.get("LGIDict").unwrap_or(&Obj::Null)) {
            Obj::Arr(a) => a.iter().map(|x| pdf.resolve(x)).collect(),
            Obj::Null => vec![],
            o => vec![o],
        };
        for l in lgis.iter().take(16) {
            j.obj();
            let ctm = nums_or_strs(&pdf.resolve(l.get("CTM").unwrap_or(&Obj::Null)));
            j.key("ctm").arr();
            for v in ctm {
                j.num(v);
            }
            j.end_arr().key("registration").arr();
            if let Obj::Arr(rs) = pdf.resolve(l.get("Registration").unwrap_or(&Obj::Null)) {
                for r in rs.iter().take(64) {
                    j.arr();
                    for v in nums_or_strs(&pdf.resolve(r)) {
                        j.num(v);
                    }
                    j.end_arr();
                }
            }
            j.end_arr().key("neatline").arr();
            for v in nums_or_strs(&pdf.resolve(l.get("Neatline").unwrap_or(&Obj::Null))) {
                j.num(v);
            }
            j.end_arr();
            let p = pdf.resolve(l.get("Projection").unwrap_or(&Obj::Null));
            j.key("projection").obj();
            for k in ["ProjectionType", "Datum", "Hemisphere", "Units"] {
                match pdf.resolve(p.get(k).unwrap_or(&Obj::Null)) {
                    Obj::Name(v) => {
                        j.kv_str(k, &v);
                    }
                    Obj::Str(v) => {
                        j.kv_str(k, &String::from_utf8_lossy(&v));
                    }
                    d @ Obj::Dict(_) => {
                        // A custom datum dictionary (2009–2013 US Topo): its /Key or /Description.
                        let text = |o: &Obj| match pdf.resolve(o) {
                            Obj::Str(v) => Some(String::from_utf8_lossy(&v).into_owned()),
                            Obj::Name(v) => Some(v),
                            _ => None,
                        };
                        if let Some(v) = d.get("Key").and_then(text).or_else(|| d.get("Description").and_then(text)) {
                            j.kv_str(k, &v);
                        }
                    }
                    _ => {}
                }
            }
            for k in ["Zone", "CentralMeridian", "OriginLatitude", "ScaleFactor", "FalseEasting", "FalseNorthing", "StandardParallelOne", "StandardParallelTwo"] {
                if let Some(v) = nums_or_strs(&Obj::Arr(vec![pdf.resolve(p.get(k).unwrap_or(&Obj::Null))])).first() {
                    j.kv_num(k, *v);
                }
            }
            j.end_obj().end_obj();
        }
        j.end_arr();
        // Placements from uncompressed content streams.
        j.key("draws").arr();
        let contents: Vec<Obj> = match pdf.resolve(page.get("Contents").unwrap_or(&Obj::Null)) {
            Obj::Arr(a) => a.iter().map(|x| pdf.resolve(x)).collect(),
            o => vec![o],
        };
        for c in contents {
            if let Obj::Stream(d, s, n) = &c {
                if Obj::Dict(d.clone()).get("Filter").is_some() {
                    continue;
                }
                for (name, m) in placements(pdf.bytes(*s, *n)) {
                    j.obj().kv_str("name", &name).key("matrix").arr();
                    for v in m {
                        j.num(v);
                    }
                    j.end_arr().end_obj();
                }
            }
        }
        j.end_arr().end_obj();
    }
    j.end_arr().end_obj();
    Ok(j.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geopdf_page_viewport_and_images() {
        let img = b"\xff\xd8\xff\xd9";
        let content = b"q 400 0 0 300 50 60 cm /Im0 Do Q";
        let mut s = String::from("%PDF-1.4\n");
        s += "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
        s += "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n";
        s += "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /VP [<< /Type /Viewport /BBox [50 60 450 360] /Measure << /Type /Measure /Subtype /GEO /GPTS [34 -117 34.1 -117 34.1 -116.9 34 -116.9] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 >> >> >>] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >> endobj\n";
        s += &format!("4 0 obj << /Length {} >>\nstream\n{}\nendstream endobj\n", content.len(), std::str::from_utf8(content).unwrap());
        let mut b = s.into_bytes();
        b.extend_from_slice(format!("5 0 obj << /Type /XObject /Subtype /Image /Width 400 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n", img.len()).as_bytes());
        b.extend_from_slice(img);
        b.extend_from_slice(b"\nendstream endobj\n%%EOF\n");
        let p = Pdf::scan(&b).unwrap();
        let js = to_json(&p).unwrap();
        assert!(js.contains("\"epsg\":4326"), "{js}");
        assert!(js.contains("\"gpts\":[34,-117,34.1,-117,34.1,-116.9,34,-116.9]"), "{js}");
        assert!(js.contains("\"filter\":\"DCTDecode\""));
        assert!(js.contains("\"matrix\":[400,0,0,300,50,60]"), "{js}");
        // Garbage and truncation do not panic.
        assert!(Pdf::scan(b"not a pdf").is_err());
        let cut = Pdf::scan(&b[..b.len() / 2]).unwrap();
        let _ = to_json(&cut);
    }

    // TE-001 / TE-007: US Topo layouts — images inside a Form XObject with a soft mask, filter
    // chains (ASCII85 then DCT), ICC colour spaces, compressed content streams listed for the
    // caller, and the pre-ISO LGIDict georeferencing.
    #[test]
    fn us_topo_forms_chains_and_lgidict() {
        let mut s = String::from("%PDF-1.6\n");
        s += "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n";
        s += "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n";
        s += "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 1638 2088] /LGIDict << /Type /LGIDict /Version (2.1) /CTM [(10) (0) (0) (10) (500000) (4200000)] /Neatline [(100) (100) (1500) (100) (1500) (1900) (100) (1900)] /Projection << /Type /Projection /ProjectionType (UT) /Zone 10 /Hemisphere (N) /Datum (NAR) >> >> /Resources << /XObject << /Fm1 6 0 R >> >> /Contents [4 0 R] >> endobj\n";
        s += "4 0 obj << /Length 5 /Filter /FlateDecode >>\nstream\nxxxxx\nendstream endobj\n";
        s += "6 0 obj << /Type /XObject /Subtype /Form /Matrix [1 0 0 1 10 20] /Resources << /XObject << /Im0 7 0 R >> >> /Length 30 >>\nstream\nq 1024 0 0 1024 0 0 cm /Im0 Do Q\nendstream endobj\n";
        s += "7 0 obj << /Type /XObject /Subtype /Image /Width 1024 /Height 1024 /BitsPerComponent 8 /ColorSpace [/ICCBased 9 0 R] /SMask 8 0 R /Filter [/ASCII85Decode /DCTDecode] /Length 4 >>\nstream\nabcd\nendstream endobj\n";
        s += "8 0 obj << /Type /XObject /Subtype /Image /Width 1024 /Height 1024 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /Columns 1024 >> /Length 4 >>\nstream\nwxyz\nendstream endobj\n";
        s += "9 0 obj << /N 3 /Length 0 >>\nstream\n\nendstream endobj\n%%EOF\n";
        let b = s.into_bytes();
        let js = to_json(&Pdf::scan(&b).unwrap()).unwrap();
        assert!(js.contains("\"name\":\"Fm1/Im0\",\"form\":\"Fm1\""), "{js}");
        assert!(js.contains("\"filters\":[\"ASCII85Decode\",\"DCTDecode\"]"), "{js}");
        assert!(js.contains("\"components\":3"), "{js}");
        assert!(js.contains("\"smask\":{"), "{js}");
        assert!(js.contains("\"predictor\":15"), "{js}");
        assert!(js.contains("\"id\":\"Fm1\",\"name\":\"Fm1\",\"parent\":\"\",\"matrix\":[1,0,0,1,10,20]"), "{js}");
        assert!(js.contains("\"contents\":[{\"offset\""), "{js}");
        assert!(js.contains("\"ctm\":[10,0,0,10,500000,4200000]"), "{js}");
        assert!(js.contains("\"ProjectionType\":\"UT\""), "{js}");
        assert!(js.contains("\"Zone\":10"), "{js}");
        let pj = placements_json(b"q 2 0 0 3 4 5 cm /Fm1 Do Q");
        assert_eq!(pj, "[{\"name\":\"Fm1\",\"matrix\":[2,0,0,3,4,5]}]");
    }
}
