//! Delimited text tables of points (REQ-GAP-39): CSV, TSV, semicolon or whitespace separated,
//! with an optional header row and comment lines (# or //). Every field is read as a number
//! where it is one; a column with any text keeps its text too (line names, hard/soft).

use crate::err::{Error, Msg};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Table {
    pub header: Vec<String>,
    pub delimiter: char,
    pub rows: usize,
    pub cols: usize,
    /// rows × cols, NaN where a field is empty or text.
    pub values: Vec<f64>,
    /// (column, text of every row) for columns with any text.
    pub text: Vec<(usize, Vec<String>)>,
}

pub const MAX_COLS: usize = 64;
pub const MAX_VALUES: usize = 64_000_000;

fn split<'a>(line: &'a str, d: char) -> Vec<&'a str> {
    if d == ' ' {
        return line.split_ascii_whitespace().collect();
    }
    // Quoted fields (RFC 4180 style, without embedded newlines).
    let mut out = Vec::new();
    let b = line.as_bytes();
    let mut i = 0;
    let mut start = 0;
    let mut quoted = false;
    while i < b.len() {
        let c = b[i];
        if c == b'"' {
            quoted = !quoted;
        } else if !quoted && c as char == d {
            out.push(&line[start..i]);
            start = i + 1;
        }
        i += 1;
    }
    out.push(&line[start..]);
    out
}

fn field(s: &str) -> &str {
    let s = s.trim();
    let s = s.strip_prefix('"').unwrap_or(s);
    s.strip_suffix('"').unwrap_or(s).trim()
}

fn number(s: &str) -> Option<f64> {
    if s.is_empty() {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

pub fn parse(bytes: &[u8]) -> Result<Table, Msg> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let lines: Vec<&str> = text.split(['\n', '\r']).map(|l| l.trim_end()).filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#') && !l.trim_start().starts_with("//")).collect();
    if lines.is_empty() {
        return Err(Error::invalid("the text file has no rows"));
    }
    // The delimiter giving the same field count (≥ 2) on most of the first lines.
    let sample = &lines[..lines.len().min(50)];
    let mut best = (0usize, ' ', 0usize);
    for d in [',', '\t', ';', '|', ' '] {
        let counts: Vec<usize> = sample.iter().map(|l| split(l, d).len()).collect();
        let first = counts[counts.len().min(2) - 1];
        if first < 2 {
            continue;
        }
        let agree = counts.iter().filter(|&&c| c == first).count();
        if agree > best.0 || (agree == best.0 && first > best.2) {
            best = (agree, d, first);
        }
    }
    if best.0 == 0 {
        return Err(Error::invalid("the text file has fewer than two columns"));
    }
    let d = best.1;
    let first: Vec<&str> = split(lines[0], d).into_iter().map(field).collect();
    let header_row = first.iter().any(|f| !f.is_empty() && number(f).is_none()) && lines.len() > 1 && split(lines[1], d).into_iter().map(field).any(|f| number(f).is_some());
    let cols = if header_row { first.len() } else { best.2 };
    if cols > MAX_COLS {
        return Err(Error::invalid("the text file has more than 64 columns"));
    }
    let body = if header_row { &lines[1..] } else { &lines[..] };
    if body.len().saturating_mul(cols) > MAX_VALUES {
        return Err(Error::invalid("the text file has too many values"));
    }
    let mut t = Table { header: if header_row { first.iter().map(|s| s.to_string()).collect() } else { Vec::new() }, delimiter: d, rows: body.len(), cols, values: vec![f64::NAN; body.len() * cols], text: Vec::new() };
    let mut is_text = vec![false; cols];
    for (r, l) in body.iter().enumerate() {
        for (c, f) in split(l, d).into_iter().map(field).enumerate().take(cols) {
            match number(f) {
                Some(v) => t.values[r * cols + c] = v,
                None if !f.is_empty() => is_text[c] = true,
                None => {}
            }
        }
    }
    // A text column keeps every row's field as written (numbers too).
    for (c, _) in is_text.iter().enumerate().filter(|x| *x.1) {
        let col = body.iter().map(|l| split(l, d).into_iter().map(field).nth(c).unwrap_or("").chars().take(256).collect()).collect();
        t.text.push((c, col));
    }
    Ok(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delimiters_headers_and_text() {
        let t = parse(b"# survey\nx,y,z,kind\n1,2,3,hard\n4.5,5,6,\"soft\"\n").unwrap();
        assert_eq!((t.rows, t.cols, t.delimiter), (2, 4, ','));
        assert_eq!(t.header, vec!["x", "y", "z", "kind"]);
        assert_eq!(&t.values[..3], &[1.0, 2.0, 3.0]);
        assert_eq!(t.text, vec![(3, vec!["hard".to_string(), "soft".to_string()])]);
        let t = parse(b"100 200 5\n101 201 6\n").unwrap();
        assert_eq!((t.rows, t.cols, t.delimiter), (2, 3, ' '));
        assert!(t.header.is_empty());
        let t = parse(b"e\tn\th\r\n1\t2\t3\r\n").unwrap();
        assert_eq!((t.rows, t.cols), (1, 3));
        assert!(parse(b"").is_err());
        assert!(parse(b"one\ntwo\n").is_err());
    }
}
