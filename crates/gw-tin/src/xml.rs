//! A small, bounded XML pull reader for LandXML (REQ-GAP-39): elements, attributes, text,
//! character and the five predefined entity references, CDATA, comments and processing
//! instructions. A DTD is skipped (its entities are not expanded). Names lose their prefix.

use crate::err::{Error, Msg};

#[derive(Debug, PartialEq)]
pub enum Ev<'a> {
    Start(&'a str, Vec<(&'a str, String)>, bool),
    End(&'a str),
    Text(String),
}

pub const MAX_DEPTH: usize = 256;

/// Index of `pat` in `s` (bytes).
fn find(s: &str, pat: &[u8]) -> Option<usize> {
    let b = s.as_bytes();
    if pat.is_empty() || b.len() < pat.len() {
        return None;
    }
    (0..=b.len() - pat.len()).find(|&i| b[i] == pat[0] && &b[i..i + pat.len()] == pat)
}

fn local(n: &str) -> &str {
    n.rsplit(':').next().unwrap_or(n)
}

fn unescape(s: &str) -> Result<String, Msg> {
    if !s.contains('&') {
        return Ok(s.to_string());
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(p) = find(rest, b"&") {
        out.push_str(&rest[..p]);
        let after = &rest[p + 1..];
        let e = find(after, b";").filter(|&e| e <= 12).ok_or_else(|| Error::invalid("XML: a bad entity reference"))?;
        let name = &after[..e];
        let c = match name {
            "lt" => '<',
            "gt" => '>',
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            _ if name.starts_with("#x") || name.starts_with("#X") => char::from_u32(u32::from_str_radix(&name[2..], 16).map_err(|_| Error::invalid("XML: a bad character reference"))?).ok_or_else(|| Error::invalid("XML: a bad character reference"))?,
            _ if name.starts_with('#') => char::from_u32(name[1..].parse::<u32>().map_err(|_| Error::invalid("XML: a bad character reference"))?).ok_or_else(|| Error::invalid("XML: a bad character reference"))?,
            _ => return Err(Error::invalid("XML: an entity that is not predefined (DTD entities are not read)")),
        };
        out.push(c);
        rest = &after[e + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Read `text`, calling `f` for each event. Stops at the first error.
pub fn read<'a>(text: &'a str, mut f: impl FnMut(Ev<'a>) -> Result<(), Msg>) -> Result<(), Msg> {
    let b = text.as_bytes();
    let mut i = 0usize;
    let mut stack: Vec<&'a str> = Vec::new();
    let mut seen_root = false;
    while i < b.len() {
        if b[i] != b'<' {
            let j = find(&text[i..], b"<").map(|k| i + k).unwrap_or(b.len());
            let raw = &text[i..j];
            if !raw.trim().is_empty() {
                if stack.is_empty() {
                    return Err(Error::invalid("XML: text outside the root element"));
                }
                f(Ev::Text(unescape(raw)?))?;
            }
            i = j;
            continue;
        }
        let rest = &text[i..];
        if rest.starts_with("<?") {
            i += find(rest, b"?>").ok_or_else(|| Error::invalid("XML: an unterminated processing instruction"))? + 2;
        } else if rest.starts_with("<!--") {
            i += find(&rest[4..], b"-->").ok_or_else(|| Error::invalid("XML: an unterminated comment"))? + 7;
        } else if rest.starts_with("<![CDATA[") {
            let e = find(rest, b"]]>").ok_or_else(|| Error::invalid("XML: an unterminated CDATA section"))?;
            if stack.is_empty() {
                return Err(Error::invalid("XML: text outside the root element"));
            }
            f(Ev::Text(rest[9..e].to_string()))?;
            i += e + 3;
        } else if rest.starts_with("<!") {
            // DOCTYPE (with an internal subset in brackets): skipped.
            let mut depth = 0i32;
            let mut k = 2;
            let rb = rest.as_bytes();
            loop {
                if k >= rb.len() {
                    return Err(Error::invalid("XML: an unterminated declaration"));
                }
                match rb[k] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'>' if depth <= 0 => break,
                    _ => {}
                }
                k += 1;
            }
            i += k + 1;
        } else if rest.starts_with("</") {
            let e = find(rest, b">").ok_or_else(|| Error::invalid("XML: an unterminated end tag"))?;
            let name = local(rest[2..e].trim());
            match stack.pop() {
                Some(open) if open == name => {}
                _ => return Err(Error::invalid("XML: an end tag does not match its start tag")),
            }
            f(Ev::End(name))?;
            i += e + 1;
        } else {
            // Start tag: name, attributes, maybe self-closing. Quoted values may hold '>'.
            let rb = rest.as_bytes();
            let mut k = 1;
            while k < rb.len() && !rb[k].is_ascii_whitespace() && rb[k] != b'>' && rb[k] != b'/' {
                k += 1;
            }
            let name = local(&rest[1..k]);
            if name.is_empty() {
                return Err(Error::invalid("XML: an element without a name"));
            }
            let mut attrs = Vec::new();
            let empty;
            loop {
                while k < rb.len() && rb[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k >= rb.len() {
                    return Err(Error::invalid("XML: an unterminated start tag"));
                }
                if rb[k] == b'>' {
                    empty = false;
                    k += 1;
                    break;
                }
                if rb[k] == b'/' {
                    if rb.get(k + 1) != Some(&b'>') {
                        return Err(Error::invalid("XML: a bad start tag"));
                    }
                    empty = true;
                    k += 2;
                    break;
                }
                let a0 = k;
                while k < rb.len() && rb[k] != b'=' && !rb[k].is_ascii_whitespace() && rb[k] != b'>' {
                    k += 1;
                }
                let an = local(&rest[a0..k]);
                while k < rb.len() && rb[k].is_ascii_whitespace() {
                    k += 1;
                }
                if rb.get(k) != Some(&b'=') {
                    return Err(Error::invalid("XML: an attribute without a value"));
                }
                k += 1;
                while k < rb.len() && rb[k].is_ascii_whitespace() {
                    k += 1;
                }
                let q = *rb.get(k).ok_or_else(|| Error::invalid("XML: an unterminated start tag"))?;
                if q != b'"' && q != b'\'' {
                    return Err(Error::invalid("XML: an attribute value without quotes"));
                }
                let v0 = k + 1;
                let v1 = find(&rest[v0..], &[q]).map(|e| v0 + e).ok_or_else(|| Error::invalid("XML: an unterminated attribute value"))?;
                attrs.push((an, unescape(&rest[v0..v1])?));
                if attrs.len() > 1024 {
                    return Err(Error::invalid("XML: too many attributes"));
                }
                k = v1 + 1;
            }
            if stack.is_empty() {
                if seen_root {
                    return Err(Error::invalid("XML: more than one root element"));
                }
                seen_root = true;
            }
            if stack.len() >= MAX_DEPTH {
                return Err(Error::invalid("XML: elements nested too deeply"));
            }
            f(Ev::Start(name, attrs, empty))?;
            if empty {
                f(Ev::End(name))?;
                if stack.is_empty() {
                    // A self-closing root.
                }
            } else {
                stack.push(name);
            }
            i += k;
        }
    }
    if !stack.is_empty() {
        return Err(Error::invalid("XML: the document ends inside an element"));
    }
    if !seen_root {
        return Err(Error::invalid("XML: no root element"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_elements_attributes_and_text() {
        let x = "<?xml version='1.0'?><!DOCTYPE a [<!ENTITY e 'x'>]><a:Root xmlns:a='u' k=\"v &amp; w\"><!-- c --><P id='1'>1 2 3</P><E/><![CDATA[<z>]]></a:Root>";
        let mut ev = Vec::new();
        read(x, |e| {
            ev.push(format!("{e:?}"));
            Ok(())
        })
        .unwrap();
        assert_eq!(ev.len(), 8, "{ev:?}");
        assert!(ev[0].contains("Root") && ev[0].contains("v & w"));
        assert!(ev[2].contains("1 2 3"));
        assert!(ev[7].contains("Root"));
        for bad in ["<a><b></a></b>", "<a>", "<a b=c/>", "x<a/>", "<a/><b/>", "<a>&ent;</a>", "<a>&#xZZ;</a>"] {
            assert!(read(bad, |_| Ok(())).is_err(), "{bad}");
        }
    }
}
