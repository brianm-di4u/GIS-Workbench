//! TRE (tagged record extension) parsing (REQ-FMT-03). Every TRE is kept raw; known ones
//! are decoded through the 98-entry catalogue compiled from `Research/data/nitf-tre-catalog.json`
//! (`build/gen-tre-catalog.mjs`). The decoder is iterative over the catalogue program, never
//! reads past CEL, and stops (marking the result partial) on anything it cannot evaluate.

use crate::bytes::{latin1, Reader};
use gw_abi::{Error, Json, Result};
use std::collections::HashMap;
use std::sync::OnceLock;

const CATALOG: &str = include_str!("../data/tre-catalog.txt");

#[derive(Debug, Clone)]
enum Op {
    Field { name: String, size: Size, ty: u8 },
    Loop { name: String, repeat: String, body: Vec<Op> },
    If { cond: String, body: Vec<Op> },
}

#[derive(Debug, Clone)]
enum Size {
    Fixed(usize),
    ValueOf(String),
    Rest,
}

pub struct TreDef {
    pub name: String,
    pub length: Option<usize>,
    pub priority: String,
    ops: Vec<Op>,
}

fn catalog() -> &'static HashMap<String, TreDef> {
    static C: OnceLock<HashMap<String, TreDef>> = OnceLock::new();
    C.get_or_init(|| {
        let mut map = HashMap::new();
        let mut lines = CATALOG.lines().filter(|l| !l.starts_with('#') && !l.trim().is_empty()).peekable();
        while let Some(line) = lines.next() {
            let mut it = line.splitn(4, ' ');
            if it.next() != Some("T") {
                continue;
            }
            let name = it.next().unwrap_or("").to_string();
            let length = it.next().and_then(|v| v.parse().ok());
            let priority = it.next().unwrap_or("COULD").to_string();
            let ops = parse_block(&mut lines);
            map.insert(name.clone(), TreDef { name, length, priority, ops });
        }
        map
    })
}

fn parse_block<'a, I: Iterator<Item = &'a str>>(lines: &mut std::iter::Peekable<I>) -> Vec<Op> {
    let mut ops = Vec::new();
    while let Some(&l) = lines.peek() {
        if l.starts_with("T ") {
            break;
        }
        lines.next();
        if l == "E" {
            break;
        }
        let (kind, rest) = l.split_at(1);
        let rest = rest.trim_start();
        match kind {
            "F" => {
                let mut p = rest.split(' ');
                let name = p.next().unwrap_or("").to_string();
                let size = match p.next().unwrap_or("*") {
                    "*" => Size::Rest,
                    s if s.starts_with('$') => Size::ValueOf(s[1..].to_string()),
                    s => s.parse().map(Size::Fixed).unwrap_or(Size::Rest),
                };
                let ty = p.next().and_then(|t| t.bytes().next()).unwrap_or(b's');
                ops.push(Op::Field { name, size, ty });
            }
            "L" => {
                let (name, repeat) = rest.split_once(' ').unwrap_or((rest, "0"));
                let body = parse_block(lines);
                ops.push(Op::Loop { name: name.to_string(), repeat: repeat.to_string(), body });
            }
            "I" => {
                let body = parse_block(lines);
                ops.push(Op::If { cond: rest.to_string(), body });
            }
            _ => {}
        }
    }
    ops
}

/// A decoded TRE: raw position plus a flat list of (path, value) pairs.
#[derive(Debug, Clone)]
pub struct Tre<'a> {
    pub tag: String,
    pub data: &'a [u8],
    /// Offset of the CEDATA inside the buffer the TREs were read from.
    pub offset: usize,
}

/// Split a TRE area (UDID/IXSHD etc.) into tagged records.
pub fn split(area: &[u8], base_offset: usize) -> Result<Vec<Tre<'_>>> {
    let mut r = Reader::new(area);
    let mut out = Vec::new();
    while r.remaining() > 0 {
        if r.remaining() < 11 {
            return Err(Error::invalid("truncated TRE header"));
        }
        let tag = r.trimmed(6)?;
        let cel = r.num(5, "CEL")? as usize;
        let offset = base_offset + r.pos;
        let data = r.bytes(cel).map_err(|_| Error::invalid(format!("TRE {tag} length {cel} overruns its area")))?;
        out.push(Tre { tag, data, offset });
    }
    Ok(out)
}

struct Ctx<'a> {
    r: Reader<'a>,
    vals: HashMap<String, String>,
    out: Vec<(String, String)>,
    budget: usize,
}

/// Decode a TRE through the catalogue. Returns (fields, complete).
pub fn decode(tag: &str, data: &[u8]) -> (Vec<(String, String)>, bool, Option<String>) {
    let Some(def) = catalog().get(tag) else {
        return (Vec::new(), false, Some("not in catalogue".into()));
    };
    let mut ctx = Ctx { r: Reader::new(data), vals: HashMap::new(), out: Vec::new(), budget: 200_000 };
    match run(&def.ops, &mut ctx, "") {
        Ok(()) => {
            let complete = ctx.r.remaining() == 0;
            let note = if complete { None } else { Some(format!("{} bytes not described by the catalogue", ctx.r.remaining())) };
            (ctx.out, complete, note)
        }
        Err(e) => (ctx.out, false, Some(e.msg)),
    }
}

fn run(ops: &[Op], ctx: &mut Ctx, prefix: &str) -> Result<()> {
    for op in ops {
        if ctx.budget == 0 {
            return Err(Error::limit("TRE decode step budget exceeded"));
        }
        ctx.budget -= 1;
        match op {
            Op::Field { name, size, ty } => {
                let n = match size {
                    Size::Fixed(n) => *n,
                    Size::Rest => ctx.r.remaining(),
                    Size::ValueOf(f) => {
                        let v = ctx.vals.get(f).ok_or_else(|| Error::invalid(format!("size field {f} not seen")))?;
                        v.trim().parse::<usize>().map_err(|_| Error::invalid(format!("size field {f} is not a number")))?
                    }
                };
                let raw = ctx.r.bytes(n)?;
                let v = match ty {
                    b'u' => {
                        if n <= 8 {
                            raw.iter().fold(0u64, |a, &b| (a << 8) | b as u64).to_string()
                        } else {
                            hex(raw)
                        }
                    }
                    b'f' if n == 4 => f32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]).to_string(),
                    b'b' => hex(&raw[..raw.len().min(64)]),
                    _ => latin1(raw),
                };
                ctx.vals.insert(name.clone(), v.clone());
                ctx.out.push((format!("{prefix}{name}"), v));
            }
            Op::Loop { name, repeat, body } => {
                let n = eval_num(repeat, &ctx.vals)?;
                if !(0.0..=1e6).contains(&n) {
                    return Err(Error::limit(format!("loop {name} repeat {n} out of range")));
                }
                for i in 0..n as usize {
                    let p = format!("{prefix}{name}[{i}].");
                    run(body, ctx, &p)?;
                }
            }
            Op::If { cond, body } => {
                if eval_cond(cond, &ctx.vals)? {
                    run(body, ctx, prefix)?;
                }
            }
        }
    }
    Ok(())
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- tiny expression evaluator for repeats and conditions --------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Id(String),
    Op(String),
}

fn lex(s: &str) -> Result<Vec<Tok>> {
    let s = s.replace(".to_i", "");
    let c: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut t = Vec::new();
    while i < c.len() {
        let ch = c[i];
        if ch.is_whitespace() {
            i += 1;
        } else if ch.is_ascii_digit() {
            let st = i;
            while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '.') {
                i += 1;
            }
            let w: String = c[st..i].iter().collect();
            match w.parse::<f64>() {
                Ok(n) => t.push(Tok::Num(n)),
                Err(_) => t.push(Tok::Str(w)),
            }
        } else if ch.is_ascii_alphabetic() || ch == '_' {
            let st = i;
            while i < c.len() && (c[i].is_ascii_alphanumeric() || c[i] == '_') {
                i += 1;
            }
            t.push(Tok::Id(c[st..i].iter().collect()));
        } else if ch == '"' {
            let st = i + 1;
            i += 1;
            while i < c.len() && c[i] != '"' {
                i += 1;
            }
            t.push(Tok::Str(c[st..i.min(c.len())].iter().collect()));
            i += 1;
        } else {
            let two: String = c[i..(i + 2).min(c.len())].iter().collect();
            if ["==", "!=", ">=", "<="].contains(&two.as_str()) {
                t.push(Tok::Op(two));
                i += 2;
            } else {
                t.push(Tok::Op(ch.to_string()));
                i += 1;
            }
        }
    }
    Ok(t)
}

fn value_of(id: &str, vals: &HashMap<String, String>) -> Result<String> {
    vals.get(id).cloned().ok_or_else(|| Error::invalid(format!("unknown field {id} in expression")))
}

fn as_num(v: &str) -> Result<f64> {
    v.trim().parse::<f64>().map_err(|_| Error::invalid(format!("\"{}\" is not a number", v.trim())))
}

/// Arithmetic: + - * / ( ) over numbers and field values.
fn eval_num(expr: &str, vals: &HashMap<String, String>) -> Result<f64> {
    let toks = lex(expr)?;
    let mut p = 0usize;
    let v = arith(&toks, &mut p, vals)?;
    if p != toks.len() {
        return Err(Error::unsupported(format!("cannot evaluate \"{expr}\"")));
    }
    Ok(v)
}

fn arith(t: &[Tok], p: &mut usize, vals: &HashMap<String, String>) -> Result<f64> {
    let mut v = term(t, p, vals)?;
    while *p < t.len() {
        match &t[*p] {
            Tok::Op(o) if o == "+" => {
                *p += 1;
                v += term(t, p, vals)?;
            }
            Tok::Op(o) if o == "-" => {
                *p += 1;
                v -= term(t, p, vals)?;
            }
            _ => break,
        }
    }
    Ok(v)
}

fn term(t: &[Tok], p: &mut usize, vals: &HashMap<String, String>) -> Result<f64> {
    let mut v = atom(t, p, vals)?;
    while *p < t.len() {
        match &t[*p] {
            Tok::Op(o) if o == "*" => {
                *p += 1;
                v *= atom(t, p, vals)?;
            }
            Tok::Op(o) if o == "/" => {
                *p += 1;
                let d = atom(t, p, vals)?;
                if d == 0.0 {
                    return Err(Error::invalid("division by zero in TRE expression"));
                }
                v = (v / d).floor();
            }
            _ => break,
        }
    }
    Ok(v)
}

fn atom(t: &[Tok], p: &mut usize, vals: &HashMap<String, String>) -> Result<f64> {
    let tok = t.get(*p).ok_or_else(|| Error::invalid("unexpected end of expression"))?.clone();
    *p += 1;
    match tok {
        Tok::Num(n) => Ok(n),
        Tok::Id(id) => as_num(&value_of(&id, vals)?),
        Tok::Op(o) if o == "(" => {
            let v = arith(t, p, vals)?;
            if t.get(*p) != Some(&Tok::Op(")".into())) {
                return Err(Error::invalid("missing )"));
            }
            *p += 1;
            Ok(v)
        }
        Tok::Op(o) if o == "-" => Ok(-atom(t, p, vals)?),
        _ => Err(Error::unsupported("unsupported expression token")),
    }
}

/// Conditions: `A:bit` (bitmask test), `F=V`, `F!=V`, `F == "v"`, `F > n`, joined by and/or.
fn eval_cond(cond: &str, vals: &HashMap<String, String>) -> Result<bool> {
    let lower = cond.replace(" OR ", " or ").replace(" AND ", " and ");
    if lower.contains(" or ") {
        for part in lower.split(" or ") {
            if eval_cond(part, vals)? {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    if lower.contains(" and ") {
        for part in lower.split(" and ") {
            if !eval_cond(part, vals)? {
                return Ok(false);
            }
        }
        return Ok(true);
    }
    let c = lower.trim().replace(".to_i", "");
    // GDAL bitmask test FIELD:bit
    if let Some((f, bit)) = c.split_once(':') {
        if let Ok(bit) = bit.trim().parse::<u32>() {
            let v = value_of(f.trim(), vals)?;
            let n = as_num(&v)? as u64;
            return Ok(bit < 64 && (n >> bit) & 1 == 1);
        }
    }
    for op in ["!=", "==", ">=", "<=", "=", ">", "<"] {
        if let Some((l, r)) = c.split_once(op) {
            let lv = value_of(l.trim(), vals)?;
            let rv = r.trim().trim_matches('"').to_string();
            return Ok(match op {
                "!=" => lv.trim() != rv.trim() && lv != rv,
                "==" | "=" => lv.trim() == rv.trim() || lv == rv,
                ">" => as_num(&lv)? > as_num(&rv)?,
                "<" => as_num(&lv)? < as_num(&rv)?,
                ">=" => as_num(&lv)? >= as_num(&rv)?,
                _ => as_num(&lv)? <= as_num(&rv)?,
            });
        }
    }
    Err(Error::unsupported(format!("cannot evaluate condition \"{cond}\"")))
}

/// Serialise a list of TREs (raw position + decoded fields) as JSON.
pub fn to_json(j: &mut Json, tres: &[Tre]) {
    j.arr();
    for t in tres {
        let (fields, complete, note) = decode(&t.tag, t.data);
        j.obj().kv_str("tag", &t.tag).kv_int("length", t.data.len() as i64).kv_int("offset", t.offset as i64);
        let pri = catalog().get(&t.tag).map(|d| d.priority.as_str()).unwrap_or("");
        j.kv_str("priority", pri).kv_bool("complete", complete);
        if let Some(n) = note {
            j.kv_str("note", &n);
        }
        j.key("fields").arr();
        for (k, v) in fields.iter().take(5000) {
            j.arr().str(k).str(v).end_arr();
        }
        j.end_arr();
        j.end_obj();
    }
    j.end_arr();
}

/// Look up a decoded field value by exact path.
pub fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

pub fn catalog_size() -> usize {
    catalog().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rpc00b_bytes() -> Vec<u8> {
        let mut s = String::new();
        s.push('1');
        s.push_str("0003.00");
        s.push_str("0001.00");
        s.push_str("005000");
        s.push_str("05000");
        s.push_str("+33.3000");
        s.push_str("+044.4000");
        s.push_str("+0100");
        s.push_str("005000");
        s.push_str("05000");
        s.push_str("+00.0500");
        s.push_str("+000.0600");
        s.push_str("+0500");
        for k in 0..80 {
            let v = if k % 20 == 0 { "+1.000000E+0" } else { "+0.000000E+0" };
            s.push_str(v);
        }
        s.into_bytes()
    }

    #[test]
    fn catalogue_loads() {
        assert_eq!(catalog_size(), 98);
        assert_eq!(catalog().get("RPC00B").unwrap().length, Some(1041));
    }

    #[test]
    fn rpc00b_decodes_exactly() {
        let b = rpc00b_bytes();
        assert_eq!(b.len(), 1041);
        let (f, complete, note) = decode("RPC00B", &b);
        assert!(complete, "{note:?}");
        assert_eq!(field(&f, "LAT_OFF"), Some("+33.3000"));
        assert_eq!(field(&f, "LINE_NUM_COEFF[0].LINE_NUM_COEFF"), Some("+1.000000E+0"));
        assert_eq!(f.len(), 13 + 80);
    }

    #[test]
    fn hostile_lengths_are_refused() {
        // CEL claims more than the area holds.
        let area = b"RPC00B99999xx";
        assert!(split(area, 0).is_err());
        // Loop counter absurdly large: J2KLRA with NLAYERS_O = 999 but no data.
        let (_f, complete, note) = decode("J2KLRA", b"0050000199");
        assert!(!complete && note.is_some());
    }

    #[test]
    fn expressions() {
        let mut v = HashMap::new();
        v.insert("NUMOPG".to_string(), "4".to_string());
        v.insert("MASK".to_string(), "5".to_string());
        v.insert("APTYP".to_string(), "I".to_string());
        assert_eq!(eval_num("(NUMOPG+1)*(NUMOPG)/2", &v).unwrap(), 10.0);
        assert!(eval_cond("MASK:0", &v).unwrap());
        assert!(!eval_cond("MASK:1", &v).unwrap());
        assert!(eval_cond("APTYP=I", &v).unwrap());
        assert!(eval_cond("APTYP=G OR MASK:2", &v).unwrap());
        assert!(eval_cond("NUMOPG.to_i > 3 and APTYP == \"I\"", &v).unwrap());
    }
}
