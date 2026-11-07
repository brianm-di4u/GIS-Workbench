//! GeoPDF vector content (REQ-GAP-66): the paths a georeferenced page paints, grouped into layers
//! the way GDAL's PDF driver groups them, in PDF user space (the caller georeferences them with the
//! page's viewports).
//!
//! * **Structured** pages (a /StructTreeRoot whose elements mark content with MCIDs, as GDAL's
//!   writer and GIS Workbench write them): one feature per structure element that owns marked
//!   content, its layer the parent element's /T, its attributes the element's /UserProperties
//!   (/A << /O /UserProperties /P [<< /N name /V value >> …] >>).
//! * **Unstructured** pages with optional content (US Topo, TerraGo-style maps): one feature per
//!   painting operator inside an optional-content group, the layer the OCG (its path in the
//!   /OCProperties /Order tree), no attributes. Paths outside every OCG are not features.
//!
//! Content streams and Form XObjects are decoded through FlateDecode, ASCIIHexDecode and
//! ASCII85Decode chains; any other filter is named in `notes` and that stream left out. Paths
//! become geometry as GDAL builds it: curve end points only, a closed four-curve circle is a
//! point at its centre, filled paths are polygons (later rings inside an earlier one are holes),
//! stroked paths lines, and paths ended with `n` (clipping) nothing.

use crate::pdf::{delim, inflate, ws, Lex, Obj, Pdf};
use gw_abi::{Json, Result};
use std::collections::HashMap;

const MAX_DEPTH: usize = 12;

/// Limits of one read-out (the caller passes them; 0 = default).
#[derive(Clone, Copy)]
pub struct Limits {
    pub features: usize,
    pub vertices: usize,
}

fn text_string(s: &[u8]) -> String {
    if s.len() >= 2 && s[0] == 0xfe && s[1] == 0xff {
        let u: Vec<u16> = s[2..].chunks(2).map(|c| ((c[0] as u16) << 8) | *c.get(1).unwrap_or(&0) as u16).collect();
        return String::from_utf16_lossy(&u);
    }
    if s.len() >= 3 && s[..3] == [0xef, 0xbb, 0xbf] {
        return String::from_utf8_lossy(&s[3..]).into_owned();
    }
    // PDFDocEncoding: Latin-1 apart from 0x80–0x9F (the common ones mapped).
    s.iter()
        .map(|&c| match c {
            0x80 => '\u{2022}',
            0x84 => '\u{2014}',
            0x85 => '\u{2013}',
            0x8d => '\u{201c}',
            0x8e => '\u{201d}',
            0x8f => '\u{2018}',
            0x90 => '\u{2019}',
            0xa0 => '\u{20ac}',
            c => c as char,
        })
        .collect()
}

fn ascii_hex(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len() / 2);
    let mut hi: Option<u8> = None;
    for &c in b {
        if c == b'>' {
            break;
        }
        let v = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => continue,
        };
        match hi.take() {
            Some(h) => out.push((h << 4) | v),
            None => hi = Some(v),
        }
    }
    if let Some(h) = hi {
        out.push(h << 4);
    }
    out
}

fn ascii85(b: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(b.len() * 4 / 5 + 4);
    let (mut t, mut k) = (0u64, 0);
    let mut i = if b.starts_with(b"<~") { 2 } else { 0 };
    while i < b.len() {
        let c = b[i];
        i += 1;
        if c == b'~' {
            break;
        }
        if c <= b' ' {
            continue;
        }
        if c == b'z' && k == 0 {
            out.extend_from_slice(&[0; 4]);
            continue;
        }
        if !(b'!'..=b'u').contains(&c) {
            return Err("ASCII85Decode (invalid data)".into());
        }
        t = t * 85 + (c - 33) as u64;
        k += 1;
        if k == 5 {
            out.extend_from_slice(&(t as u32).to_be_bytes());
            t = 0;
            k = 0;
        }
    }
    if k > 1 {
        for _ in k..5 {
            t = t * 85 + 84;
        }
        out.extend_from_slice(&(t as u32).to_be_bytes()[..k - 1]);
    }
    Ok(out)
}

/// A stream's data through its filter chain; Err names the filter that is not read.
pub fn decode_stream(pdf: &Pdf, d: &Obj, s: usize, n: usize) -> std::result::Result<Vec<u8>, String> {
    let filters: Vec<String> = match pdf.resolve(d.get("Filter").unwrap_or(&Obj::Null)) {
        Obj::Name(f) => vec![f],
        Obj::Arr(a) => a.iter().filter_map(|x| x.name().map(String::from)).collect(),
        _ => vec![],
    };
    let parms: Vec<Obj> = match pdf.resolve(d.get("DecodeParms").unwrap_or(&Obj::Null)) {
        Obj::Arr(a) => a.iter().map(|x| pdf.resolve(x)).collect(),
        o => vec![o],
    };
    let mut b = pdf.bytes(s, n).to_vec();
    for (i, f) in filters.iter().enumerate() {
        b = match f.as_str() {
            "FlateDecode" | "Fl" => {
                let pred = parms.get(i).and_then(|p| p.get("Predictor")).and_then(|x| x.num()).unwrap_or(1.0);
                if pred > 1.0 {
                    return Err(format!("{f} with predictor {pred}"));
                }
                inflate(&b, 256 << 20).map_err(|_| format!("{f} (corrupt data)"))?
            }
            "ASCIIHexDecode" | "AHx" => ascii_hex(&b),
            "ASCII85Decode" | "A85" => ascii85(&b)?,
            other => return Err(other.to_string()),
        };
    }
    Ok(b)
}

// ---- content tokens ----

enum Tok<'a> {
    Num(f64),
    Name(&'a [u8]),
    Op(&'a [u8]),
    Val(Obj),
    End,
}

struct Toks<'a> {
    lx: Lex<'a>,
}

fn fast_num(w: &[u8]) -> Option<f64> {
    let (mut i, mut neg) = (0, false);
    if let Some(&c) = w.first() {
        if c == b'-' || c == b'+' {
            neg = c == b'-';
            i = 1;
        }
    }
    let (mut v, mut scale, mut dot, mut digits) = (0f64, 1f64, false, 0);
    while i < w.len() {
        let c = w[i];
        if c.is_ascii_digit() {
            v = v * 10.0 + (c - b'0') as f64;
            if dot {
                scale *= 10.0;
            }
            digits += 1;
        } else if c == b'.' && !dot {
            dot = true;
        } else {
            return None;
        }
        i += 1;
    }
    if digits == 0 {
        return None;
    }
    Some(if neg { -v / scale } else { v / scale })
}

impl<'a> Toks<'a> {
    fn next(&mut self) -> Tok<'a> {
        let lx = &mut self.lx;
        lx.skip();
        let Some(c) = lx.b.get(lx.p).copied() else { return Tok::End };
        match c {
            b'/' => {
                lx.p += 1;
                Tok::Name(lx.word())
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                let w = lx.word();
                if w.is_empty() {
                    lx.p += 1;
                    return Tok::Val(Obj::Null);
                }
                fast_num(w).map(Tok::Num).unwrap_or(Tok::Val(Obj::Null))
            }
            b'(' | b'<' | b'[' => match lx.value(0) {
                Ok(v) => Tok::Val(v),
                Err(_) => {
                    lx.p = lx.b.len();
                    Tok::End
                }
            },
            b')' | b'>' | b']' | b'{' | b'}' => {
                lx.p += 1;
                Tok::Val(Obj::Null)
            }
            _ => {
                let w = lx.word();
                if w.is_empty() {
                    lx.p += 1;
                    return Tok::Val(Obj::Null);
                }
                Tok::Op(w)
            }
        }
    }

    /// After `ID`: skip an inline image's data to its `EI`.
    fn skip_inline_image(&mut self) {
        let b = self.lx.b;
        let mut i = self.lx.p + 1;
        while i + 2 <= b.len() {
            if &b[i..i + 2] == b"EI" && ws(b[i - 1]) && b.get(i + 2).is_none_or(|c| ws(*c) || delim(*c)) {
                self.lx.p = i + 2;
                return;
            }
            i += 1;
        }
        self.lx.p = b.len();
    }
}

// ---- interpreter ----

type M = [f64; 6];
const ID: M = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: &M, c: &M) -> M {
    [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]]
}

#[derive(Clone)]
struct Gs {
    ctm: M,
    stroke: [f64; 3],
    fill: [f64; 3],
    lw: f64,
}

#[derive(Default)]
struct Sub {
    pts: Vec<[f64; 2]>,
    curves: u32,
    lines: u32,
    closed: bool,
}

/// A geometry in page space: kind 0 point, 1 line, 2 polygon; parts are point lists (points: one
/// per part; polygons: rings with `outer` marking where each polygon starts).
#[derive(Default)]
struct Geom {
    kind: u8,
    parts: Vec<Vec<[f64; 2]>>,
    outer: Vec<bool>,
}

struct Feat {
    ocg: Option<u32>,
    mcid: Option<i64>,
    geom: Geom,
    stroke: Option<[f64; 3]>,
    fill: Option<[f64; 3]>,
    lw: f64,
}

#[derive(Clone, Copy)]
struct Mc {
    mcid: Option<i64>,
    ocg: Option<u32>,
}

struct Run<'p, 'a> {
    pdf: &'p Pdf<'a>,
    paths: &'p HashMap<u32, Vec<String>>,
    gs: Gs,
    saved: Vec<Gs>,
    path: Vec<Sub>,
    cur: [f64; 2],
    mc: Vec<Mc>,
    feats: Vec<Feat>,
    notes: Vec<String>,
    vertices: usize,
    limits: Limits,
    truncated: usize,
    ops: u64,
}

fn rgb(n: &[f64]) -> Option<[f64; 3]> {
    match n.len() {
        1 => Some([n[0]; 3]),
        3 => Some([n[0], n[1], n[2]]),
        4 => Some([(1.0 - n[0]) * (1.0 - n[3]), (1.0 - n[1]) * (1.0 - n[3]), (1.0 - n[2]) * (1.0 - n[3])]),
        _ => None,
    }
}

/// A closed four-curve subpath whose box is square: a circle (GDAL's point symbol).
fn circle(s: &Sub) -> Option<[f64; 2]> {
    if s.curves != 4 || s.lines > 1 || s.pts.len() < 5 {
        return None;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in &s.pts {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let (w, h) = (x1 - x0, y1 - y0);
    if w <= 0.0 || (w - h).abs() > 0.05 * w.max(h) {
        return None;
    }
    let f = s.pts[0];
    let l = s.pts[s.pts.len() - 1];
    if (f[0] - l[0]).abs() > 0.01 * w || (f[1] - l[1]).abs() > 0.01 * w {
        return None;
    }
    Some([(x0 + x1) / 2.0, (y0 + y1) / 2.0])
}

fn inside(p: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let mut c = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            c = !c;
        }
        j = i;
    }
    c
}

impl<'p, 'a> Run<'p, 'a> {
    fn tf(&self, x: f64, y: f64) -> [f64; 2] {
        let m = &self.gs.ctm;
        [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
    }

    fn add_pt(&mut self, p: [f64; 2], curve: bool) {
        if self.path.is_empty() {
            self.path.push(Sub { pts: vec![self.cur], ..Default::default() });
        }
        let s = self.path.last_mut().unwrap();
        s.pts.push(p);
        if curve {
            s.curves += 1;
        } else {
            s.lines += 1;
        }
        self.cur = p;
    }

    fn paint(&mut self, op: &[u8]) {
        let path = std::mem::take(&mut self.path);
        if op == b"n" || path.is_empty() {
            return;
        }
        let fill = matches!(op, b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*");
        let stroke = matches!(op, b"S" | b"s" | b"B" | b"B*" | b"b" | b"b*");
        let close_all = matches!(op, b"s" | b"b" | b"b*");
        let top = self.mc.iter().rev().find(|m| m.mcid.is_some()).and_then(|m| m.mcid);
        let ocg = self.mc.iter().rev().find(|m| m.ocg.is_some()).and_then(|m| m.ocg);
        if top.is_none() && ocg.is_none() {
            return; // outside every layer and every structure element
        }
        let mut g = Geom::default();
        let centres: Vec<[f64; 2]> = path.iter().filter_map(circle).collect();
        if !centres.is_empty() && centres.len() == path.len() {
            g.kind = 0;
            g.parts = centres.into_iter().map(|c| vec![c]).collect();
        } else if fill {
            g.kind = 2;
            let mut outers: Vec<usize> = Vec::new();
            for s in path {
                let mut r = s.pts;
                r.dedup();
                if r.len() > 1 && r[0] == r[r.len() - 1] {
                    r.pop();
                }
                if r.len() < 3 {
                    continue;
                }
                r.push(r[0]);
                let hole = outers.iter().any(|&o| inside(r[0], &g.parts[o]));
                if !hole {
                    outers.push(g.parts.len());
                }
                g.outer.push(!hole);
                g.parts.push(r);
            }
        } else {
            g.kind = 1;
            for s in path {
                let mut r = s.pts;
                r.dedup();
                if (s.closed || close_all) && r.len() > 2 && r[0] != r[r.len() - 1] {
                    r.push(r[0]);
                }
                if r.len() >= 2 {
                    g.parts.push(r);
                }
            }
        }
        if g.parts.is_empty() {
            return;
        }
        let nv: usize = g.parts.iter().map(|p| p.len()).sum();
        if self.feats.len() >= self.limits.features || self.vertices + nv > self.limits.vertices {
            self.truncated += 1;
            return;
        }
        self.vertices += nv;
        let det = (self.gs.ctm[0] * self.gs.ctm[3] - self.gs.ctm[1] * self.gs.ctm[2]).abs().sqrt();
        self.feats.push(Feat { ocg, mcid: top, geom: g, stroke: stroke.then_some(self.gs.stroke), fill: fill.then_some(self.gs.fill), lw: self.gs.lw * det });
    }

    /// The OCG (object number) an /OC property names: an OCG, or of an OCMD's OCGs the one deepest
    /// in the /Order tree (US Topo lists a layer with all its parents, in no fixed order).
    fn ocg_of(&self, res: &Obj, name: &[u8]) -> Option<u32> {
        let props = self.pdf.resolve(res.get("Properties").unwrap_or(&Obj::Null));
        let key = String::from_utf8_lossy(name);
        let r = props.get(&key)?;
        let n = match r {
            Obj::Ref(n, _) => *n,
            _ => return None,
        };
        let o = self.pdf.resolve(r);
        if o.get("Type").and_then(|t| t.name()) == Some("OCMD") {
            let refs: Vec<u32> = match self.pdf.resolve(o.get("OCGs").unwrap_or(&Obj::Null)) {
                Obj::Arr(a) => a.iter().filter_map(|x| if let Obj::Ref(n, _) = x { Some(*n) } else { None }).collect(),
                _ => match o.get("OCGs") {
                    Some(Obj::Ref(n, _)) => vec![*n],
                    _ => vec![],
                },
            };
            let depth = |n: &u32| self.paths.get(n).map_or(0, |p| p.len());
            return refs.iter().copied().enumerate().max_by_key(|(i, n)| (depth(n), usize::MAX - i)).map(|(_, n)| n);
        }
        Some(n)
    }

    fn content(&mut self, data: &[u8], res: &Obj, depth: usize) {
        let mut tk = Toks { lx: Lex { b: data, p: 0 } };
        let mut nums: Vec<f64> = Vec::with_capacity(16);
        let mut names: Vec<Vec<u8>> = Vec::new();
        let mut vals: Vec<Obj> = Vec::new();
        loop {
            match tk.next() {
                Tok::End => break,
                Tok::Num(v) => {
                    if nums.len() < 64 {
                        nums.push(v);
                    }
                }
                Tok::Name(n) => {
                    if names.len() < 8 {
                        names.push(n.to_vec());
                    }
                }
                Tok::Val(v) => {
                    if vals.len() < 8 {
                        vals.push(v);
                    }
                }
                Tok::Op(op) => {
                    self.ops += 1;
                    if self.ops > 200_000_000 {
                        self.notes.push("content: operator limit reached".into());
                        return;
                    }
                    self.op(op, &nums, &names, &vals, res, depth);
                    if op == b"ID" {
                        tk.skip_inline_image();
                    }
                    nums.clear();
                    names.clear();
                    vals.clear();
                }
            }
        }
    }

    fn op(&mut self, op: &[u8], n: &[f64], names: &[Vec<u8>], vals: &[Obj], res: &Obj, depth: usize) {
        let last = |k: usize| -> Option<&[f64]> { (n.len() >= k).then(|| &n[n.len() - k..]) };
        match op {
            b"q" => {
                if self.saved.len() < 256 {
                    self.saved.push(self.gs.clone());
                }
            }
            b"Q" => {
                if let Some(g) = self.saved.pop() {
                    self.gs = g;
                }
            }
            b"cm" => {
                if let Some(m) = last(6) {
                    self.gs.ctm = mul(&[m[0], m[1], m[2], m[3], m[4], m[5]], &self.gs.ctm);
                }
            }
            b"w" => {
                if let Some(v) = last(1) {
                    self.gs.lw = v[0];
                }
            }
            b"m" => {
                if let Some(v) = last(2) {
                    let p = self.tf(v[0], v[1]);
                    // A move after a lone move replaces it.
                    if self.path.last().is_some_and(|s| s.pts.len() == 1) {
                        self.path.pop();
                    }
                    self.path.push(Sub { pts: vec![p], ..Default::default() });
                    self.cur = p;
                }
            }
            b"l" => {
                if let Some(v) = last(2) {
                    let p = self.tf(v[0], v[1]);
                    self.add_pt(p, false);
                }
            }
            b"c" => {
                if let Some(v) = last(6) {
                    let p = self.tf(v[4], v[5]);
                    self.add_pt(p, true);
                }
            }
            b"v" | b"y" => {
                if let Some(v) = last(4) {
                    let p = self.tf(v[2], v[3]);
                    self.add_pt(p, true);
                }
            }
            b"h" => {
                if let Some(s) = self.path.last_mut() {
                    s.closed = true;
                    if let Some(&f) = s.pts.first() {
                        self.cur = f;
                    }
                }
            }
            b"re" => {
                if let Some(v) = last(4) {
                    let (x, y, w, h) = (v[0], v[1], v[2], v[3]);
                    let pts = vec![self.tf(x, y), self.tf(x + w, y), self.tf(x + w, y + h), self.tf(x, y + h), self.tf(x, y)];
                    self.cur = pts[0];
                    self.path.push(Sub { pts, lines: 4, closed: true, curves: 0 });
                }
            }
            b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n" => self.paint(op),
            b"W" | b"W*" => {}
            b"RG" | b"G" | b"K" | b"SC" | b"SCN" => {
                if let Some(c) = rgb(n) {
                    self.gs.stroke = c;
                }
            }
            b"rg" | b"g" | b"k" | b"sc" | b"scn" => {
                if let Some(c) = rgb(n) {
                    self.gs.fill = c;
                }
            }
            b"BMC" => self.mc.push(Mc { mcid: None, ocg: None }),
            b"BDC" => {
                let mut m = Mc { mcid: None, ocg: None };
                let tag = names.first().map(|x| x.as_slice());
                if tag == Some(b"OC") {
                    if let Some(p) = names.get(1) {
                        m.ocg = self.ocg_of(res, p);
                    }
                } else {
                    // Properties inline (<< /MCID n >>) or named in the resources.
                    let d = match vals.first() {
                        Some(d @ Obj::Dict(_)) => Some(d.clone()),
                        _ => names.get(1).map(|p| {
                            let props = self.pdf.resolve(res.get("Properties").unwrap_or(&Obj::Null));
                            self.pdf.resolve(props.get(&String::from_utf8_lossy(p)).unwrap_or(&Obj::Null))
                        }),
                    };
                    m.mcid = d.and_then(|d| d.get("MCID").and_then(|x| x.num())).map(|v| v as i64);
                }
                if self.mc.len() < 256 {
                    self.mc.push(m);
                }
            }
            b"EMC" => {
                self.mc.pop();
            }
            b"Do" => {
                let Some(name) = names.last() else { return };
                if depth >= MAX_DEPTH {
                    return;
                }
                let xo = self.pdf.resolve(res.get("XObject").unwrap_or(&Obj::Null));
                let Some(r) = xo.get(&String::from_utf8_lossy(name)) else { return };
                let Obj::Stream(d, s, len) = self.pdf.resolve(r) else { return };
                let dd = Obj::Dict(d);
                if dd.get("Subtype").and_then(|x| x.name()) != Some("Form") {
                    return;
                }
                let data = match decode_stream(self.pdf, &dd, s, len) {
                    Ok(b) => b,
                    Err(f) => {
                        self.note_filter(&f);
                        return;
                    }
                };
                let fm = match self.pdf.resolve(dd.get("Matrix").unwrap_or(&Obj::Null)) {
                    Obj::Arr(a) if a.len() == 6 => {
                        let v: Vec<f64> = a.iter().map(|x| x.num().unwrap_or(0.0)).collect();
                        [v[0], v[1], v[2], v[3], v[4], v[5]]
                    }
                    _ => ID,
                };
                let fres = match self.pdf.resolve(dd.get("Resources").unwrap_or(&Obj::Null)) {
                    o @ Obj::Dict(_) => o,
                    _ => res.clone(),
                };
                // Optional content on the form itself (/OC on the XObject dictionary).
                let foc = match dd.get("OC") {
                    Some(Obj::Ref(n, _)) => Some(*n),
                    _ => None,
                };
                let save = self.gs.clone();
                let path = std::mem::take(&mut self.path);
                let mcs = self.mc.len();
                if foc.is_some() {
                    self.mc.push(Mc { mcid: None, ocg: foc });
                }
                self.gs.ctm = mul(&fm, &self.gs.ctm);
                let saved = self.saved.len();
                self.content(&data, &fres, depth + 1);
                self.saved.truncate(saved);
                self.mc.truncate(mcs);
                self.gs = save;
                self.path = path;
            }
            _ => {}
        }
    }

    fn note_filter(&mut self, f: &str) {
        let s = format!("filter:{f}");
        if !self.notes.contains(&s) {
            self.notes.push(s);
        }
    }
}

// ---- structure tree (GDAL's ExploreTree) ----

struct SFeat {
    layer: usize,
    attrs: Vec<(String, Obj)>,
    page: u32,
}

struct Tree {
    layers: Vec<String>,
    feats: Vec<SFeat>,
    /// (page object, MCID) → feature index.
    by_mcid: HashMap<(u32, i64), usize>,
}

fn user_props(pdf: &Pdf, a: &Obj, out: &mut Vec<(String, Obj)>) {
    match pdf.resolve(a) {
        Obj::Arr(v) => {
            for x in v.iter().take(64) {
                user_props(pdf, x, out);
            }
        }
        d @ Obj::Dict(_) => {
            if d.get("O").and_then(|o| o.name()) != Some("UserProperties") {
                return;
            }
            if let Obj::Arr(p) = pdf.resolve(d.get("P").unwrap_or(&Obj::Null)) {
                for e in p.iter().take(4096) {
                    let e = pdf.resolve(e);
                    let Some(Obj::Str(n)) = e.get("N") else { continue };
                    let v = pdf.resolve(e.get("V").unwrap_or(&Obj::Null));
                    out.push((text_string(n), v));
                }
            }
        }
        _ => {}
    }
}

/// MCIDs an element owns directly: integer /K, MCR dictionaries, arrays of them.
fn mcids(pdf: &Pdf, k: &Obj, page: Option<u32>, out: &mut Vec<(Option<u32>, i64)>) -> bool {
    match k {
        Obj::Num(v) => {
            out.push((page, *v as i64));
            true
        }
        Obj::Arr(a) => {
            let mut any = false;
            for x in a.iter().take(100_000) {
                if matches!(x, Obj::Num(_)) || matches!(pdf.resolve(x), Obj::Dict(ref d) if d.iter().any(|(k, _)| k == "MCID")) {
                    any |= mcids(pdf, &pdf.resolve(x), page, out);
                }
            }
            any
        }
        d @ Obj::Dict(_) if d.get("MCID").is_some() => {
            let pg = match d.get("Pg") {
                Some(Obj::Ref(n, _)) => Some(*n),
                _ => page,
            };
            out.push((pg, d.get("MCID").and_then(|x| x.num()).unwrap_or(-1.0) as i64));
            true
        }
        _ => false,
    }
}

/// GDAL's rule: an element whose /K array starts with an element that has an integer /K is a
/// layer (named by its /T, else /S), and each element of that array a feature; anything else is
/// searched further down.
fn explore(pdf: &Pdf, e: &Obj, page: Option<u32>, depth: usize, seen: &mut std::collections::HashSet<u32>, t: &mut Tree, first_page: u32) {
    if depth > 64 || t.feats.len() > 1_000_000 {
        return;
    }
    if let Obj::Ref(n, _) = e {
        if !seen.insert(*n) {
            return;
        }
    }
    let el = pdf.resolve(e);
    let pg_of = |o: &Obj, dflt: Option<u32>| match o.get("Pg") {
        Some(Obj::Ref(n, _)) => Some(*n),
        _ => dflt,
    };
    let page = pg_of(&el, page);
    match pdf.resolve(el.get("K").unwrap_or(&Obj::Null)) {
        Obj::Arr(a) => {
            let first = a.first().map(|x| pdf.resolve(x)).unwrap_or(Obj::Null);
            let is_layer = matches!(first, Obj::Dict(_)) && matches!(first.get("K").map(|k| pdf.resolve(k)), Some(Obj::Num(_)));
            if !is_layer {
                for x in a.iter().take(1_000_000) {
                    if matches!(pdf.resolve(x), Obj::Dict(_)) {
                        explore(pdf, x, page, depth + 1, seen, t, first_page);
                    }
                }
                return;
            }
            let name = match el.get("T") {
                Some(Obj::Str(s)) => text_string(s),
                _ => el.get("S").and_then(|s| s.name()).map(String::from).unwrap_or_else(|| format!("Layer{}", t.layers.len() + 1)),
            };
            t.layers.push(name);
            let li = t.layers.len() - 1;
            for x in a.iter().take(1_000_000) {
                let f = pdf.resolve(x);
                if !matches!(f, Obj::Dict(_)) {
                    continue;
                }
                let mut own = Vec::new();
                mcids(pdf, &pdf.resolve(f.get("K").unwrap_or(&Obj::Null)), pg_of(&f, page), &mut own);
                let mut attrs = Vec::new();
                user_props(pdf, f.get("A").unwrap_or(&Obj::Null), &mut attrs);
                let fi = t.feats.len();
                t.feats.push(SFeat { layer: li, attrs, page: pg_of(&f, page).unwrap_or(first_page) });
                for (pg, m) in own {
                    t.by_mcid.entry((pg.unwrap_or(first_page), m)).or_insert(fi);
                }
            }
        }
        k @ Obj::Dict(_) => {
            let x = el.get("K").cloned().unwrap_or(k);
            explore(pdf, &x, page, depth + 1, seen, t, first_page);
        }
        _ => {}
    }
}

fn catalog(pdf: &Pdf) -> Obj {
    for n in pdf.numbers() {
        if let Ok(o @ Obj::Dict(_)) = pdf.object(n) {
            if o.get("Type").and_then(|t| t.name()) == Some("Catalog") {
                return o;
            }
        }
    }
    Obj::Null
}

/// OCG object number → path of names from /OCProperties /D /Order (a group's label or parent OCG first).
fn ocg_paths(pdf: &Pdf, cat: &Obj) -> HashMap<u32, Vec<String>> {
    let mut out = HashMap::new();
    let ocp = pdf.resolve(cat.get("OCProperties").unwrap_or(&Obj::Null));
    let name_of = |n: u32| match pdf.object(n) {
        Ok(o) => match o.get("Name") {
            Some(Obj::Str(s)) => text_string(s),
            _ => format!("OCG {n}"),
        },
        Err(_) => format!("OCG {n}"),
    };
    fn walk(pdf: &Pdf, a: &[Obj], prefix: &[String], out: &mut HashMap<u32, Vec<String>>, name_of: &dyn Fn(u32) -> String, depth: usize) {
        if depth > 16 {
            return;
        }
        let mut pre: Vec<String> = prefix.to_vec();
        let mut i = 0;
        // A labelled group: [(Label) …].
        if let Some(Obj::Str(s)) = a.first() {
            pre.push(text_string(s));
            i = 1;
        }
        let mut last: Option<String> = None;
        while i < a.len() {
            let item = match &a[i] {
                r @ Obj::Ref(..) if matches!(pdf.resolve(r), Obj::Arr(_)) => pdf.resolve(r),
                x => x.clone(),
            };
            match &item {
                Obj::Ref(n, _) => {
                    let nm = name_of(*n);
                    let mut p = pre.clone();
                    p.push(nm.clone());
                    out.entry(*n).or_insert(p);
                    last = Some(nm);
                }
                x => {
                    if let Obj::Arr(sub) = pdf.resolve(x) {
                        let mut p = pre.clone();
                        // Children of the OCG just before; a labelled array names itself.
                        if !matches!(sub.first(), Some(Obj::Str(_))) {
                            if let Some(l) = last.take() {
                                p.push(l);
                            }
                        }
                        walk(pdf, &sub, &p, out, name_of, depth + 1);
                    }
                }
            }
            i += 1;
        }
    }
    let d = pdf.resolve(ocp.get("D").unwrap_or(&Obj::Null));
    if let Obj::Arr(order) = pdf.resolve(d.get("Order").unwrap_or(&Obj::Null)) {
        walk(pdf, &order, &[], &mut out, &name_of, 0);
    }
    if let Obj::Arr(all) = pdf.resolve(ocp.get("OCGs").unwrap_or(&Obj::Null)) {
        for x in all.iter() {
            if let Obj::Ref(n, _) = x {
                out.entry(*n).or_insert_with(|| vec![name_of(*n)]);
            }
        }
    }
    out
}

fn hex(c: [f64; 3]) -> String {
    let b = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", b(c[0]), b(c[1]), b(c[2]))
}

fn pt(j: &mut Json, p: [f64; 2]) {
    j.arr().num((p[0] * 1000.0).round() / 1000.0).num((p[1] * 1000.0).round() / 1000.0).end_arr();
}

fn line(j: &mut Json, r: &[[f64; 2]]) {
    j.arr();
    for &p in r {
        pt(j, p);
    }
    j.end_arr();
}

/// GeoJSON geometry (page coordinates) of merged pieces of one family.
fn geom_json(j: &mut Json, pieces: &[&Geom]) {
    let kind = pieces[0].kind;
    let parts: Vec<&Vec<[f64; 2]>> = pieces.iter().filter(|g| g.kind == kind).flat_map(|g| g.parts.iter()).collect();
    match kind {
        0 => {
            if parts.len() == 1 {
                j.kv_str("type", "Point").key("coordinates");
                pt(j, parts[0][0]);
            } else {
                j.kv_str("type", "MultiPoint").key("coordinates").arr();
                for p in &parts {
                    pt(j, p[0]);
                }
                j.end_arr();
            }
        }
        1 => {
            if parts.len() == 1 {
                j.kv_str("type", "LineString").key("coordinates");
                line(j, parts[0]);
            } else {
                j.kv_str("type", "MultiLineString").key("coordinates").arr();
                for p in &parts {
                    line(j, p);
                }
                j.end_arr();
            }
        }
        _ => {
            // Polygons: each outer ring with the holes after it.
            let mut polys: Vec<Vec<&Vec<[f64; 2]>>> = Vec::new();
            for g in pieces.iter().filter(|g| g.kind == 2) {
                for (r, &o) in g.parts.iter().zip(g.outer.iter()) {
                    if o || polys.is_empty() {
                        polys.push(vec![r]);
                    } else {
                        polys.last_mut().unwrap().push(r);
                    }
                }
            }
            let poly = |j: &mut Json, p: &Vec<&Vec<[f64; 2]>>| {
                j.arr();
                for r in p {
                    line(j, r);
                }
                j.end_arr();
            };
            if polys.len() == 1 {
                j.kv_str("type", "Polygon").key("coordinates");
                poly(j, &polys[0]);
            } else {
                j.kv_str("type", "MultiPolygon").key("coordinates").arr();
                for p in &polys {
                    poly(j, p);
                }
                j.end_arr();
            }
        }
    }
}

fn value_json(j: &mut Json, v: &Obj) {
    match v {
        Obj::Num(x) => {
            j.num(*x);
        }
        Obj::Bool(b) => {
            j.bool(*b);
        }
        Obj::Str(s) => {
            j.str(&text_string(s));
        }
        Obj::Name(n) => {
            j.str(n);
        }
        _ => {
            j.null();
        }
    }
}

/// Vector features of every georeferenced page → JSON (see the module header).
pub fn vectors_json(pdf: &Pdf, limits: Limits) -> Result<String> {
    let limits = Limits { features: if limits.features == 0 { 200_000 } else { limits.features }, vertices: if limits.vertices == 0 { 8_000_000 } else { limits.vertices } };
    let cat = catalog(pdf);
    let paths = ocg_paths(pdf, &cat);
    let pages = pdf.pages();
    let first_page = pages.first().copied().unwrap_or(0);
    let mut tree = Tree { layers: Vec::new(), feats: Vec::new(), by_mcid: HashMap::new() };
    let root = cat.get("StructTreeRoot").cloned().unwrap_or(Obj::Null);
    if !matches!(root, Obj::Null) {
        let r = pdf.resolve(&root);
        let k = r.get("K").cloned().unwrap_or(Obj::Null);
        let mut seen = std::collections::HashSet::new();
        explore(pdf, &Obj::Dict(vec![("K".into(), k)]), None, 0, &mut seen, &mut tree, first_page);
    }
    let mut j = Json::new();
    j.obj().key("notes").arr();
    for f in &pdf.skipped_objstm {
        j.str(&format!("objstm:{f}"));
    }
    j.end_arr().key("pages").arr();
    let mut budget = limits;
    for &pn in pages.iter().take(200) {
        let page = pdf.object(pn)?;
        let georef = matches!(pdf.resolve(page.get("VP").unwrap_or(&Obj::Null)), Obj::Arr(ref a) if !a.is_empty()) || page.get("LGIDict").is_some();
        if !georef {
            continue;
        }
        let res = pdf.resolve(page.get("Resources").unwrap_or(&Obj::Null));
        let mut run = Run { pdf, paths: &paths, gs: Gs { ctm: ID, stroke: [0.0; 3], fill: [0.0; 3], lw: 1.0 }, saved: Vec::new(), path: Vec::new(), cur: [0.0; 2], mc: Vec::new(), feats: Vec::new(), notes: Vec::new(), vertices: 0, limits: budget, truncated: 0, ops: 0 };
        let contents: Vec<Obj> = match pdf.resolve(page.get("Contents").unwrap_or(&Obj::Null)) {
            Obj::Arr(a) => a.iter().map(|x| pdf.resolve(x)).collect(),
            o => vec![o],
        };
        // A page's content streams are one stream split anywhere (ISO 32000-1 §7.8.2).
        let mut all = Vec::new();
        for c in &contents {
            if let Obj::Stream(d, s, n) = c {
                match decode_stream(pdf, &Obj::Dict(d.clone()), *s, *n) {
                    Ok(b) => {
                        all.extend_from_slice(&b);
                        all.push(b'\n');
                    }
                    Err(f) => run.note_filter(&f),
                }
            }
        }
        run.content(&all, &res, 0);
        budget.features = budget.features.saturating_sub(run.feats.len());
        budget.vertices = budget.vertices.saturating_sub(run.vertices);
        // Structured when the structure tree has features on this page (GDAL then reads only those).
        let structured = tree.feats.iter().any(|f| f.page == pn);
        j.obj().kv_int("object", pn as i64).kv_bool("structured", structured).kv_int("truncated", run.truncated as i64).key("notes").arr();
        for n in &run.notes {
            j.str(n);
        }
        j.end_arr();
        // Layers and features.
        let mut layer_ids: Vec<(String, Vec<String>, i64)> = Vec::new();
        let mut layer_of = |name: String, path: Vec<String>, ocg: i64| -> usize {
            match layer_ids.iter().position(|l| l.0 == name && l.2 == ocg) {
                Some(i) => i,
                None => {
                    layer_ids.push((name, path, ocg));
                    layer_ids.len() - 1
                }
            }
        };
        let mut fj = Json::new();
        fj.arr();
        if structured {
            // One feature per structure element: its pieces merged, in element order.
            let mut groups: Vec<(usize, Vec<usize>)> = Vec::new();
            let mut gi: HashMap<usize, usize> = HashMap::new();
            for (i, f) in run.feats.iter().enumerate() {
                let Some(&si) = f.mcid.and_then(|m| tree.by_mcid.get(&(pn, m))) else { continue };
                match gi.get(&si) {
                    Some(&g) => groups[g].1.push(i),
                    None => {
                        gi.insert(si, groups.len());
                        groups.push((si, vec![i]));
                    }
                }
            }
            // Every structure feature of the page in element order, also those that draw nothing
            // (GDAL keeps them, with no geometry).
            let mut by_el: HashMap<usize, Vec<usize>> = groups.into_iter().collect();
            for (si, sf) in tree.feats.iter().enumerate() {
                if sf.page != pn {
                    continue;
                }
                let lname = tree.layers[sf.layer].clone();
                let li = layer_of(lname.clone(), vec![lname], -1);
                fj.obj().kv_int("l", li as i64).key("g");
                match by_el.remove(&si) {
                    Some(idx) => {
                        let pieces: Vec<&Geom> = idx.iter().map(|&i| &run.feats[i].geom).collect();
                        fj.obj();
                        geom_json(&mut fj, &pieces);
                        fj.end_obj();
                        style(&mut fj, &run.feats[idx[0]]);
                    }
                    None => {
                        fj.null();
                    }
                }
                fj.key("a").obj();
                for (k, v) in &sf.attrs {
                    fj.key(k);
                    value_json(&mut fj, v);
                }
                fj.end_obj().end_obj();
            }
        } else {
            for f in &run.feats {
                let Some(o) = f.ocg else { continue };
                let path = paths.get(&o).cloned().unwrap_or_else(|| vec![format!("OCG {o}")]);
                let li = layer_of(path.last().cloned().unwrap_or_default(), path, o as i64);
                fj.obj().kv_int("l", li as i64).key("g").obj();
                geom_json(&mut fj, &[&f.geom]);
                fj.end_obj();
                style(&mut fj, f);
                fj.end_obj();
            }
        }
        fj.end_arr();
        j.key("layers").arr();
        for (name, path, ocg) in &layer_ids {
            j.obj().kv_str("name", name).key("path").arr();
            for p in path {
                j.str(p);
            }
            j.end_arr();
            if *ocg >= 0 {
                j.kv_int("ocg", *ocg);
            }
            j.end_obj();
        }
        j.end_arr().key("features").raw(&fj.finish()).end_obj();
    }
    j.end_arr().end_obj();
    Ok(j.finish())
}

fn style(j: &mut Json, f: &Feat) {
    if let Some(s) = f.stroke {
        j.kv_str("s", &hex(s));
    }
    if let Some(c) = f.fill {
        j.kv_str("f", &hex(c));
    }
    j.kv_num("w", (f.lw * 100.0).round() / 100.0);
}

/// `a b c d e f cm /Name Do` placements in a decoded content stream (the fast tokenizer).
pub fn placements(content: &[u8]) -> Vec<(String, [f64; 6])> {
    let mut out = Vec::new();
    let mut tk = Toks { lx: Lex { b: content, p: 0 } };
    let mut nums: Vec<f64> = Vec::with_capacity(16);
    let mut name: Option<&[u8]> = None;
    let mut ctm = ID;
    let mut saved: Vec<M> = Vec::new();
    loop {
        match tk.next() {
            Tok::End => break,
            Tok::Num(v) => {
                if nums.len() < 64 {
                    nums.push(v);
                }
            }
            Tok::Name(n) => name = Some(n),
            Tok::Val(_) => {}
            Tok::Op(op) => {
                match op {
                    b"q" => saved.push(ctm),
                    b"Q" => ctm = saved.pop().unwrap_or(ID),
                    b"cm" if nums.len() >= 6 => {
                        let m = &nums[nums.len() - 6..];
                        ctm = mul(&[m[0], m[1], m[2], m[3], m[4], m[5]], &ctm);
                    }
                    b"Do" => {
                        if let Some(n) = name {
                            if out.len() < 100_000 {
                                out.push((String::from_utf8_lossy(n).into_owned(), ctm));
                            }
                        }
                    }
                    b"ID" => tk.skip_inline_image(),
                    _ => {}
                }
                nums.clear();
                name = None;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(objs: &[(u32, String)], streams: &[(u32, &str, &[u8])]) -> Vec<u8> {
        let mut b = b"%PDF-1.7\n".to_vec();
        for (n, s) in objs {
            b.extend_from_slice(format!("{n} 0 obj {s} endobj\n").as_bytes());
        }
        for (n, d, data) in streams {
            b.extend_from_slice(format!("{n} 0 obj << {d} /Length {} >>\nstream\n", data.len()).as_bytes());
            b.extend_from_slice(data);
            b.extend_from_slice(b"\nendstream endobj\n");
        }
        b.extend_from_slice(b"%%EOF\n");
        b
    }

    const VP: &str = "/VP [<< /Type /Viewport /BBox [0 0 100 100] /Measure << /Type /Measure /Subtype /GEO /GPTS [0 0 1 0 1 1 0 1] /LPTS [0 0 0 1 1 1 1 0] /GCS << /Type /GEOGCS /EPSG 4326 >> >> >>]";

    #[test]
    fn structured_features_with_attributes_through_forms_and_flate() {
        // GDAL's layout: each feature a Form XObject drawn inside /feature <</MCID n>> BDC.
        let poly = b"q 1 0 0 RG 0 1 0 rg 10 10 m 50 10 l 50 50 l 10 50 l 10 10 l h 20 20 m 20 30 l 30 30 l 30 20 l h b* Q";
        let circle = b"20 80 m 20 82.76 17.76 85 15 85 c 12.24 85 10 82.76 10 80 c 10 77.24 12.24 75 15 75 c 17.76 75 20 77.24 20 80 c b";
        let page = b"/OC /L1 BDC /feature <</MCID 0>> BDC /V0 Do EMC /feature <</MCID 1>> BDC /V1 Do EMC /feature <</MCID 2>> BDC 0 0 m 60 60 l 90 10 l S EMC EMC";
        let z = miniz_oxide::deflate::compress_to_vec_zlib(page, 6);
        let objs = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 20 0 R /OCProperties << /OCGs [9 0 R] /D << /Order [9 0 R] >> >> >>".to_string()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
            (3, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] {VP} /Resources << /Properties << /L1 9 0 R >> /XObject << /V0 5 0 R /V1 6 0 R >> >> /Contents 4 0 R >>")),
            (9, "<< /Type /OCG /Name (Buildings) >>".to_string()),
            (20, "<< /Type /StructTreeRoot /K [21 0 R] >>".to_string()),
            (21, "<< /Type /StructElem /S /Feature /T (Buildings) /K [22 0 R 23 0 R 24 0 R] >>".to_string()),
            (22, "<< /Type /StructElem /S /feature /K 0 /Pg 3 0 R /A << /O /UserProperties /P [<< /N (name) /V <FEFF0421043A043B04300434> >> << /N (floors) /V 3 >> << /N (h) /V 12.5 >>] >> >>".to_string()),
            (23, "<< /Type /StructElem /S /feature /K 1 /Pg 3 0 R /A << /O /UserProperties /P [<< /N (name) /V (Mast) >>] >> >>".to_string()),
            (24, "<< /Type /StructElem /S /feature /K 2 /Pg 3 0 R /A << /O /UserProperties /P [<< /N (name) /V (Road) >>] >> >>".to_string()),
        ];
        let b = doc(&objs, &[(4, "/Filter /FlateDecode", &z), (5, "/Type /XObject /Subtype /Form /BBox [0 0 100 100]", poly), (6, "/Type /XObject /Subtype /Form /BBox [0 0 100 100]", circle)]);
        let p = Pdf::scan(&b).unwrap();
        let js = vectors_json(&p, Limits { features: 0, vertices: 0 }).unwrap();
        assert!(js.contains("\"structured\":true"), "{js}");
        assert!(js.contains("\"layers\":[{\"name\":\"Buildings\""), "{js}");
        assert!(js.contains("\"type\":\"Polygon\",\"coordinates\":[[[10,10],[50,10],[50,50],[10,50],[10,10]],[[20,20],[20,30],[30,30],[30,20],[20,20]]]"), "{js}");
        assert!(js.contains("\"name\":\"Склад\",\"floors\":3,\"h\":12.5"), "{js}");
        assert!(js.contains("\"type\":\"Point\",\"coordinates\":[15,80]"), "{js}");
        assert!(js.contains("\"type\":\"LineString\",\"coordinates\":[[0,0],[60,60],[90,10]]"), "{js}");
        assert!(js.contains("\"s\":\"#ff0000\",\"f\":\"#00ff00\""), "{js}");
    }

    #[test]
    fn unstructured_ocg_layers_with_nested_order_and_refused_filters() {
        let page = b"/OC /a BDC 0 0 1 rg 0 0 10 10 re f EMC /OC /b BDC 1 w 0 0 m 5 5 l S 10 10 m 20 20 l S EMC 0 0 m 1 1 l S /OC /a BDC q 0 0 100 100 re W n Q EMC";
        let objs = vec![
            (1, "<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [9 0 R 10 0 R] /D << /Order [(Map Frame) 9 0 R [10 0 R]] >> >> >>".to_string()),
            (2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string()),
            (3, format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] {VP} /Resources << /Properties << /a 9 0 R /b 10 0 R >> >> /Contents [4 0 R 5 0 R] >>")),
            (9, "<< /Type /OCG /Name (Hydrography) >>".to_string()),
            (10, "<< /Type /OCG /Name (Streams) >>".to_string()),
        ];
        let hexed: String = page.iter().map(|c| format!("{c:02x}")).collect::<String>() + ">";
        let b = doc(&objs, &[(4, "/Filter /ASCIIHexDecode", hexed.as_bytes()), (5, "/Filter /LZWDecode", b"xx")]);
        let js = vectors_json(&Pdf::scan(&b).unwrap(), Limits { features: 0, vertices: 0 }).unwrap();
        assert!(js.contains("\"structured\":false"), "{js}");
        assert!(js.contains("{\"name\":\"Hydrography\",\"path\":[\"Map Frame\",\"Hydrography\"],\"ocg\":9}"), "{js}");
        assert!(js.contains("{\"name\":\"Streams\",\"path\":[\"Map Frame\",\"Hydrography\",\"Streams\"],\"ocg\":10}"), "{js}");
        assert!(js.contains("filter:LZWDecode"), "{js}");
        // Two lines in Streams, one polygon in Hydrography; the clip path and the path outside any layer are not features.
        assert_eq!(js.matches("\"type\":\"LineString\"").count(), 2, "{js}");
        assert_eq!(js.matches("\"type\":\"Polygon\"").count(), 1, "{js}");
        assert!(js.contains("\"f\":\"#0000ff\""), "{js}");
        // Feature limit: truncated and counted.
        let js = vectors_json(&Pdf::scan(&b).unwrap(), Limits { features: 1, vertices: 0 }).unwrap();
        assert!(js.contains("\"truncated\":2"), "{js}");
    }

    #[test]
    fn filters_tokens_and_encryption() {
        assert_eq!(ascii85(b"<~87cURD]i,\"Ebo80~>").unwrap(), b"Hello World!");
        assert_eq!(ascii_hex(b"48 65 6c6C6f>"), b"Hello");
        assert_eq!(fast_num(b"-12.5"), Some(-12.5));
        assert_eq!(fast_num(b".5"), Some(0.5));
        assert_eq!(fast_num(b"1e5"), None);
        assert_eq!(text_string(b"\xfe\xff\x04\x1c\x00a"), "Мa");
        let pl = placements(b"q 2 0 0 3 4 5 cm /Im0 Do Q BI /W 1 /H 1 ID \x00\x01\nEI q /Fm1 Do Q (str) Tj [(a) 2 (b)] TJ");
        assert_eq!(pl.len(), 2);
        assert_eq!(pl[0], ("Im0".to_string(), [2.0, 0.0, 0.0, 3.0, 4.0, 5.0]));
        assert_eq!(pl[1].0, "Fm1");
        let enc = b"%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF".to_vec();
        assert!(Pdf::scan(&enc).is_err());
        // Garbage content does not panic.
        let empty = Pdf::scan(b"%PDF-1.4\n%%EOF").unwrap();
        let no_paths = HashMap::new();
        let mut r = Run { pdf: &empty, paths: &no_paths, gs: Gs { ctm: ID, stroke: [0.0; 3], fill: [0.0; 3], lw: 1.0 }, saved: vec![], path: vec![], cur: [0.0; 2], mc: vec![], feats: vec![], notes: vec![], vertices: 0, limits: Limits { features: 10, vertices: 100 }, truncated: 0, ops: 0 };
        r.content(b"<< /x [ ( ] >> m l c BDC EMC EMC Q Q 1 2 3 re f ( \\", &Obj::Null, 0);
    }
}
