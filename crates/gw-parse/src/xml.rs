//! A small hardened XML reader for SICD/SIDD/CPHD metadata (REQ-SAR-01/12, REQ-SEC-02).
//!
//! It reads elements, attributes, text and CDATA. A DOCTYPE (and with it every entity
//! definition) is refused; only the five predefined entities and numeric character references
//! are expanded, so there is no entity-expansion attack. Names keep only their local part:
//! queries ignore namespace prefixes, as SICD 1.0–1.5 files from different producers need.
//! Depth, node count and size are capped.

use gw_abi::{Error, Json, Result};

pub const MAX_BYTES: usize = 32 << 20;
pub const MAX_DEPTH: usize = 64;
pub const MAX_NODES: usize = 500_000;

#[derive(Clone, Debug, Default)]
pub struct Node {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
    pub text: String,
}

fn local(n: &str) -> &str {
    n.rsplit(':').next().unwrap_or(n)
}

impl Node {
    /// First child with this local name.
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    /// All children with this local name.
    pub fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
    /// A path of local names separated by '/'.
    pub fn find(&self, path: &str) -> Option<&Node> {
        let mut n = self;
        for p in path.split('/') {
            n = n.child(p)?;
        }
        Some(n)
    }
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    pub fn text_at(&self, path: &str) -> Option<&str> {
        self.find(path).map(|n| n.text.trim())
    }
    pub fn num(&self, path: &str) -> Option<f64> {
        self.text_at(path).and_then(|t| t.parse::<f64>().ok())
    }
    pub fn value(&self) -> Option<f64> {
        self.text.trim().parse::<f64>().ok()
    }

    /// {n, a, t, c} JSON tree (attributes as an object, text only when non-blank).
    pub fn to_json(&self, j: &mut Json) {
        j.obj().kv_str("n", &self.name);
        if !self.attrs.is_empty() {
            j.key("a").obj();
            for (k, v) in &self.attrs {
                j.kv_str(k, v);
            }
            j.end_obj();
        }
        let t = self.text.trim();
        if !t.is_empty() {
            j.kv_str("t", t);
        }
        if !self.children.is_empty() {
            j.key("c").arr();
            for c in &self.children {
                c.to_json(j);
            }
            j.end_arr();
        }
        j.end_obj();
    }
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
    nodes: usize,
}

fn is_name(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'-' | b'.') || b >= 0x80
}

impl<'a> P<'a> {
    fn err(&self, m: &str) -> Error {
        Error::invalid(format!("XML: {m} at byte {}", self.i))
    }
    fn starts(&self, t: &str) -> bool {
        self.s[self.i..].starts_with(t.as_bytes())
    }
    fn skip_until(&mut self, t: &str) -> Result<()> {
        let tb = t.as_bytes();
        while self.i + tb.len() <= self.s.len() {
            if &self.s[self.i..self.i + tb.len()] == tb {
                self.i += tb.len();
                return Ok(());
            }
            self.i += 1;
        }
        Err(self.err(&format!("missing '{t}'")))
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_ascii_whitespace() {
            self.i += 1;
        }
    }
    fn name(&mut self) -> Result<String> {
        let a = self.i;
        while self.i < self.s.len() && is_name(self.s[self.i]) {
            self.i += 1;
        }
        if a == self.i {
            return Err(self.err("expected a name"));
        }
        Ok(String::from_utf8_lossy(&self.s[a..self.i]).into_owned())
    }
    /// Skip prolog items: declaration, comments, processing instructions. Refuse DOCTYPE.
    fn misc(&mut self) -> Result<()> {
        loop {
            self.ws();
            if self.starts("<?") {
                self.skip_until("?>")?;
            } else if self.starts("<!--") {
                self.skip_until("-->")?;
            } else if self.starts("<!DOCTYPE") || self.starts("<!doctype") {
                return Err(self.err("DOCTYPE is not allowed (no entity definitions)"));
            } else {
                return Ok(());
            }
        }
    }
    fn element(&mut self, depth: usize) -> Result<Node> {
        if depth > MAX_DEPTH {
            return Err(self.err("nesting too deep"));
        }
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(Error::limit("XML: too many elements"));
        }
        if !self.starts("<") {
            return Err(self.err("expected '<'"));
        }
        self.i += 1;
        let raw = self.name()?;
        let mut node = Node { name: local(&raw).to_string(), ..Default::default() };
        loop {
            self.ws();
            if self.i >= self.s.len() {
                return Err(self.err("unterminated start tag"));
            }
            if self.starts("/>") {
                self.i += 2;
                return Ok(node);
            }
            if self.s[self.i] == b'>' {
                self.i += 1;
                break;
            }
            let k = self.name()?;
            self.ws();
            if self.i >= self.s.len() || self.s[self.i] != b'=' {
                return Err(self.err("expected '=' in attribute"));
            }
            self.i += 1;
            self.ws();
            let q = *self.s.get(self.i).ok_or_else(|| self.err("unterminated attribute"))?;
            if q != b'"' && q != b'\'' {
                return Err(self.err("attribute value must be quoted"));
            }
            self.i += 1;
            let a = self.i;
            while self.i < self.s.len() && self.s[self.i] != q {
                self.i += 1;
            }
            if self.i >= self.s.len() {
                return Err(self.err("unterminated attribute value"));
            }
            let v = unescape(&self.s[a..self.i])?;
            self.i += 1;
            // Namespace declarations are not attributes of the content.
            if k != "xmlns" && !k.starts_with("xmlns:") {
                node.attrs.push((local(&k).to_string(), v));
            }
        }
        let mut text: Vec<u8> = Vec::new();
        loop {
            if self.i >= self.s.len() {
                return Err(self.err(&format!("missing </{raw}>")));
            }
            if self.starts("</") {
                self.i += 2;
                let close = self.name()?;
                if close != raw {
                    return Err(self.err(&format!("</{close}> closes <{raw}>")));
                }
                self.ws();
                if self.s.get(self.i) != Some(&b'>') {
                    return Err(self.err("expected '>'"));
                }
                self.i += 1;
                node.text = unescape(&text)?;
                return Ok(node);
            } else if self.starts("<!--") {
                self.skip_until("-->")?;
            } else if self.starts("<![CDATA[") {
                self.i += 9;
                let a = self.i;
                self.skip_until("]]>")?;
                // CDATA is literal: protect '&' from the later unescape.
                for &c in &self.s[a..self.i - 3] {
                    if c == b'&' {
                        text.extend_from_slice(b"&amp;");
                    } else {
                        text.push(c);
                    }
                }
            } else if self.starts("<?") {
                self.skip_until("?>")?;
            } else if self.starts("<!") {
                return Err(self.err("markup declarations are not allowed"));
            } else if self.s[self.i] == b'<' {
                let c = self.element(depth + 1)?;
                node.children.push(c);
            } else {
                text.push(self.s[self.i]);
                self.i += 1;
            }
        }
    }
}

/// Expand the five predefined entities and numeric character references; refuse others.
fn unescape(b: &[u8]) -> Result<String> {
    let s = String::from_utf8_lossy(b);
    if !s.contains('&') {
        return Ok(s.into_owned());
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = &*s;
    while let Some(p) = rest.find('&') {
        out.push_str(&rest[..p]);
        let r = &rest[p + 1..];
        let e = r.find(';').ok_or_else(|| Error::invalid("XML: '&' without ';'"))?;
        let name = &r[..e];
        let ch = match name {
            "amp" => '&',
            "lt" => '<',
            "gt" => '>',
            "quot" => '"',
            "apos" => '\'',
            _ if name.starts_with("#x") || name.starts_with("#X") => u32::from_str_radix(&name[2..], 16).ok().and_then(char::from_u32).ok_or_else(|| Error::invalid("XML: bad character reference"))?,
            _ if name.starts_with('#') => name[1..].parse::<u32>().ok().and_then(char::from_u32).ok_or_else(|| Error::invalid("XML: bad character reference"))?,
            _ => return Err(Error::invalid(format!("XML: entity &{name}; is not allowed"))),
        };
        out.push(ch);
        rest = &r[e + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Parse a document and return its root element.
pub fn parse(b: &[u8]) -> Result<Node> {
    if b.len() > MAX_BYTES {
        return Err(Error::limit("XML: document too large"));
    }
    // Strip a UTF-8 BOM and trailing NUL padding (DES data is sometimes padded).
    let mut s = b;
    if s.starts_with(&[0xef, 0xbb, 0xbf]) {
        s = &s[3..];
    }
    while let Some((&0, r)) = s.split_last() {
        s = r;
    }
    let mut p = P { s, i: 0, nodes: 0 };
    p.misc()?;
    let root = p.element(0)?;
    p.misc()?;
    if p.i < p.s.len() && !p.s[p.i..].iter().all(|c| c.is_ascii_whitespace()) {
        return Err(p.err("content after the root element"));
    }
    Ok(root)
}

/// Namespace URI declared on the root element (for the SICD/SIDD version), if any.
pub fn root_namespace(b: &[u8]) -> Option<String> {
    let s = String::from_utf8_lossy(&b[..b.len().min(4096)]);
    let i = s.find("xmlns=")?;
    let r = &s[i + 6..];
    let q = r.chars().next()?;
    let r = &r[1..];
    let e = r.find(q)?;
    Some(r[..e].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_are_dropped_and_entities_limited() {
        let x = br#"<?xml version="1.0"?><!-- c --><si:A xmlns:si="urn:x" b="1&amp;2"><si:B>3.5</si:B><C><![CDATA[a<b&c]]></C><D>&#65;&lt;</D></si:A>"#;
        let r = parse(x).unwrap();
        assert_eq!(r.name, "A");
        assert_eq!(r.attr("b"), Some("1&2"));
        assert_eq!(r.num("B"), Some(3.5));
        assert_eq!(r.text_at("C"), Some("a<b&c"));
        assert_eq!(r.text_at("D"), Some("A<"));
    }

    #[test]
    fn hostile_input_is_refused() {
        assert!(parse(b"<!DOCTYPE x [<!ENTITY a 'b'>]><x>&a;</x>").is_err());
        assert!(parse(b"<x>&custom;</x>").is_err());
        assert!(parse(b"<x><y></x>").is_err());
        assert!(parse(b"<x").is_err());
        let deep = "<a>".repeat(100) + &"</a>".repeat(100);
        assert!(parse(deep.as_bytes()).is_err());
    }
}
