//! A tolerant reader for the `key = value` text that DigitalGlobe/Maxar support files (IMD, EPH,
//! ATT, GEO, TIL, RPB) and Landsat MTL/ANG files use: `BEGIN_GROUP = X` / `GROUP = X` open a group,
//! `END_GROUP` closes it, a value runs to `;` or the end of the line, and a value that starts with
//! `(` runs to its matching `)` across lines. Quotes are removed. Nothing is evaluated; numbers are
//! read on request. Input of any size or content gives entries or nothing, never a panic.

/// One `key = value` with the group path it sits in (outermost first, joined by '.').
#[derive(Clone, Debug)]
pub struct Entry {
    pub group: String,
    pub key: String,
    pub value: String,
}

pub struct Odl {
    pub entries: Vec<Entry>,
}

/// Limits that keep a hostile file bounded: entries and group depth.
const MAX_ENTRIES: usize = 200_000;
const MAX_DEPTH: usize = 32;

impl Odl {
    pub fn parse(text: &str) -> Odl {
        let b = text.as_bytes();
        let mut entries = Vec::new();
        let mut stack: Vec<String> = Vec::new();
        let mut i = 0;
        let n = b.len();
        while i < n && entries.len() < MAX_ENTRIES {
            // Skip blank space and statement separators.
            while i < n && (b[i].is_ascii_whitespace() || b[i] == b';') {
                i += 1;
            }
            if i >= n {
                break;
            }
            // Key: up to '=' or the end of the line.
            let ks = i;
            while i < n && b[i] != b'=' && b[i] != b'\n' && b[i] != b';' {
                i += 1;
            }
            let key = text[ks..i].trim().to_string();
            if i >= n || b[i] != b'=' {
                if key == "END" {
                    break;
                }
                continue;
            }
            i += 1;
            while i < n && (b[i] == b' ' || b[i] == b'\t') {
                i += 1;
            }
            let vs = i;
            if i < n && b[i] == b'(' {
                let mut depth = 0usize;
                while i < n {
                    match b[i] {
                        b'(' => depth += 1,
                        b')' => {
                            depth = depth.saturating_sub(1);
                            if depth == 0 {
                                i += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
            } else {
                while i < n && b[i] != b';' && b[i] != b'\n' {
                    i += 1;
                }
            }
            let mut value = text.get(vs..i).unwrap_or("").trim().to_string();
            if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
                value = value[1..value.len() - 1].to_string();
            }
            match key.as_str() {
                "BEGIN_GROUP" | "GROUP" | "BEGIN_OBJECT" | "OBJECT" => {
                    if stack.len() < MAX_DEPTH {
                        stack.push(value);
                    }
                }
                "END_GROUP" | "END_OBJECT" => {
                    stack.pop();
                }
                _ => entries.push(Entry { group: stack.join("."), key, value }),
            }
        }
        Odl { entries }
    }

    /// The first value of `key` in a group whose path ends with `group` ("" = any group).
    pub fn get(&self, group: &str, key: &str) -> Option<&str> {
        self.entries.iter().find(|e| e.key == key && (group.is_empty() || e.group == group || e.group.ends_with(&format!(".{group}")))).map(|e| e.value.as_str())
    }
    pub fn num(&self, group: &str, key: &str) -> Option<f64> {
        self.get(group, key).and_then(|v| v.trim().parse::<f64>().ok())
    }
    /// The numbers of a value, list or not ("(1, 2.5,\n 3e-4)" → [1, 2.5, 3e-4]).
    pub fn nums(&self, group: &str, key: &str) -> Option<Vec<f64>> {
        self.get(group, key).map(numbers)
    }
    /// Group paths that contain `key`, in file order, without repeats.
    pub fn groups_with(&self, key: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for e in &self.entries {
            if e.key == key && !out.contains(&e.group) {
                out.push(e.group.clone());
            }
        }
        out
    }
}

/// Every number in a text, in order (separators: anything that cannot be part of a number).
pub fn numbers(s: &str) -> Vec<f64> {
    s.split(|c: char| !(c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E')))
        .filter(|t| !t.is_empty())
        .filter_map(|t| t.parse::<f64>().ok())
        .collect()
}

/// An ISO 8601 UTC time `YYYY-MM-DDThh:mm:ss.ssssss[Z]` (or with a space, or `YYYY-MM-DD` alone)
/// → (days from 2000-01-01, seconds of that day).
pub fn iso_time(s: &str) -> Option<(i64, f64)> {
    let s = s.trim().trim_matches('"').trim_end_matches('Z');
    let (d, t) = match s.find(['T', ' ']) {
        Some(k) => (&s[..k], &s[k + 1..]),
        None => (s, "00:00:00"),
    };
    let dp: Vec<&str> = d.split('-').collect();
    if dp.len() != 3 {
        return None;
    }
    let (y, m, dd) = (dp[0].parse::<i64>().ok()?, dp[1].parse::<i64>().ok()?, dp[2].parse::<i64>().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&dd) || !(1900..=2200).contains(&y) {
        return None;
    }
    let tp: Vec<&str> = t.split(':').collect();
    if tp.len() != 3 {
        return None;
    }
    let sec = tp[0].parse::<f64>().ok()? * 3600.0 + tp[1].parse::<f64>().ok()? * 60.0 + tp[2].parse::<f64>().ok()?;
    if !(0.0..=86_401.0).contains(&sec) {
        return None;
    }
    Some((civil_days(y, m, dd), sec))
}

/// Days from 2000-01-01 of a civil date (proleptic Gregorian; H. Hinnant's algorithm).
pub fn civil_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 - 10_957
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_lists_and_times() {
        let t = "a = 1;\nBEGIN_GROUP = G\n\tb = \"x\";\n\tl = (\n(1, 2.5),\n(3, -4e-3));\nEND_GROUP = G\nGROUP = H\n  C = (1.0, 2.0,\n       3.0)\n  D = 7\nEND_GROUP = H\nEND;";
        let o = Odl::parse(t);
        assert_eq!(o.num("", "a"), Some(1.0));
        assert_eq!(o.get("G", "b"), Some("x"));
        assert_eq!(o.nums("G", "l").unwrap(), vec![1.0, 2.5, 3.0, -4e-3]);
        assert_eq!(o.nums("H", "C").unwrap(), vec![1.0, 2.0, 3.0]);
        assert_eq!(o.num("H", "D"), Some(7.0));
        let (d, s) = iso_time("2009-12-22T16:39:12.188175Z").unwrap();
        assert_eq!(d, civil_days(2009, 12, 22));
        assert!((s - 59952.188175).abs() < 1e-9);
        assert!(iso_time("2009-13-22T00:00:00Z").is_none());
        // Unbalanced and binary input never panics.
        let _ = Odl::parse("x = (((;\n=\n= =");
        let _ = Odl::parse(&String::from_utf8_lossy(&[0xff, b'=', b'(', 0, 0x80]));
    }
}
