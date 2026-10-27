//! Coordinate parsing and formatting (REQ-GEO-07, REQ-GEO-08, `Research/05` §3.7).
//! One parser for Go To, GCP entry and tables. It returns the point, its precision and
//! the detected format, so the UI can echo the normalised result before acting.

use crate::grids::*;
use gw_abi::{Error, Result};

#[derive(Clone, Debug, PartialEq)]
pub struct Parsed {
    pub lat: f64,
    pub lon: f64,
    /// Precision of the input as a cell/rounding size in metres (NaN if unknown).
    pub precision_m: f64,
    pub format: &'static str,
    /// Set when an assumption was made (e.g. lon/lat order swapped).
    pub notice: String,
}

fn ok(lat: f64, lon: f64, p: f64, f: &'static str) -> Result<Parsed> {
    if !(-90.0..=90.0).contains(&lat) || !(-540.0..=540.0).contains(&lon) {
        return Err(Error::range("coordinate out of range"));
    }
    Ok(Parsed { lat, lon: crate::math::ang_normalize(lon), precision_m: p, format: f, notice: String::new() })
}

/// Parse a typed coordinate. `lon_first` sets the order of a bare decimal pair.
pub fn parse(input: &str, lon_first: bool) -> Result<Parsed> {
    let s = input.trim();
    if s.is_empty() {
        return Err(Error::invalid("empty coordinate"));
    }
    let up = s.to_ascii_uppercase();
    let compact: String = up.chars().filter(|c| !c.is_whitespace()).collect();

    // 1. MGRS / USNG (UTM and UPS forms).
    if looks_mgrs(&compact) {
        let (lat, lon, cell, prec) = mgrs_to_latlon(&compact)?;
        let mut p = ok(lat, lon, if cell.is_finite() { cell } else { 100_000.0 }, if s.contains(' ') { "USNG/MGRS" } else { "MGRS" })?;
        if prec > 5 {
            p.notice = "sub-metre MGRS (non-standard)".into();
        }
        return Ok(p);
    }
    // 2. UTM / UPS: "38n 444140.545 3684706.356", "38S 444140 3684706", "n 2277729 1518960".
    if let Some(p) = parse_utm(&up)? {
        return Ok(p);
    }
    // 3. GARS and GEOREF.
    if is_gars(&compact) {
        let (lat, lon, size) = gars_reverse(&compact)?;
        return ok(lat, lon, size * 111_320.0, "GARS");
    }
    if is_georef(&compact) {
        let (lat, lon, size) = georef_reverse(&compact)?;
        return ok(lat, lon, size * 111_320.0, "GEOREF");
    }
    // 5. Compact NITF forms (before generic DMS since they have no separators).
    if let Some(p) = parse_nitf_compact(&compact)? {
        return Ok(p);
    }
    // 4/6. Lat/long with hemisphere letters or symbols, or a bare decimal pair.
    parse_latlon(&up, lon_first)
}

fn looks_mgrs(c: &str) -> bool {
    let b = c.as_bytes();
    let nd = b.iter().take_while(|x| x.is_ascii_digit()).count();
    if nd > 2 || b.len() < nd + 1 {
        return false;
    }
    let band = b[nd];
    if nd == 0 {
        // UPS: A, B, Y, Z followed by two letters.
        return matches!(band, b'A' | b'B' | b'Y' | b'Z') && b.len() >= 3 && b[1].is_ascii_alphabetic() && b[2].is_ascii_alphabetic() && b[3..].iter().all(u8::is_ascii_digit);
    }
    if !band.is_ascii_alphabetic() {
        return false;
    }
    if b.len() == nd + 1 {
        return true; // grid zone designation only
    }
    b.len() >= nd + 3 && b[nd + 1].is_ascii_alphabetic() && b[nd + 2].is_ascii_alphabetic() && b[nd + 3..].iter().all(u8::is_ascii_digit)
}

fn parse_utm(up: &str) -> Result<Option<Parsed>> {
    let toks: Vec<&str> = up.split(|c: char| c.is_whitespace() || c == ',').filter(|t| !t.is_empty()).collect();
    if toks.len() != 3 {
        return Ok(None);
    }
    let zt = toks[0];
    let (zone, hemi) = if zt == "N" || zt == "S" {
        (0, zt)
    } else {
        let nd = zt.chars().take_while(|c| c.is_ascii_digit()).count();
        if nd == 0 || nd > 2 || zt.len() != nd + 1 {
            return Ok(None);
        }
        let z: i32 = zt[..nd].parse().map_err(|_| Error::invalid("bad UTM zone"))?;
        (z, &zt[nd..])
    };
    let e: f64 = match toks[1].parse() {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let n: f64 = match toks[2].parse() {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let northp = match hemi {
        "N" => true,
        "S" => false,
        // A band letter: C–M south, N–X north.
        h if h.len() == 1 && "CDEFGHJKLM".contains(h) => false,
        h if h.len() == 1 && "PQRTUVWX".contains(h) => true,
        _ => return Ok(None),
    };
    let (lat, lon, _, _) = utmups_reverse(zone, northp, e, n)?;
    let mut p = ok(lat, lon, 1.0, if zone == 0 { "UPS" } else { "UTM" })?;
    if hemi == "S" && zone != 0 && n < 1_000_000.0 {
        p.notice = "'S' read as southern hemisphere".into();
    }
    Ok(Some(p))
}

fn is_gars(c: &str) -> bool {
    let b = c.as_bytes();
    (5..=7).contains(&b.len()) && b[..3].iter().all(u8::is_ascii_digit) && b[3].is_ascii_alphabetic() && b[4].is_ascii_alphabetic() && b[5..].iter().all(u8::is_ascii_digit)
}

fn is_georef(c: &str) -> bool {
    let b = c.as_bytes();
    b.len() >= 4 && b.len() % 2 == 0 && b[..4].iter().all(u8::is_ascii_alphabetic) && b[4..].iter().all(u8::is_ascii_digit) && !b.contains(&b'I') && !b.contains(&b'O')
}

fn parse_nitf_compact(c: &str) -> Result<Option<Parsed>> {
    let b = c.as_bytes();
    // ddmmss[.ss]Xdddmmss[.ss]Y
    if let Some(ip) = b.iter().position(|&x| x == b'N' || x == b'S') {
        if ip >= 6 && b[..6].iter().all(u8::is_ascii_digit) && ip + 8 <= b.len() {
            let rest = &c[ip + 1..];
            let lp = rest.find(['E', 'W']);
            if let Some(lp) = lp {
                if lp + 1 == rest.len() && lp >= 7 && rest.as_bytes()[..7].iter().all(u8::is_ascii_digit) {
                    let dms = |t: &str, dd: usize| -> Option<f64> {
                        let d: f64 = t.get(..dd)?.parse().ok()?;
                        let m: f64 = t.get(dd..dd + 2)?.parse().ok()?;
                        let s: f64 = t.get(dd + 2..)?.parse().ok()?;
                        if m >= 60.0 || s >= 60.0 {
                            return None;
                        }
                        Some(d + m / 60.0 + s / 3600.0)
                    };
                    let lat = dms(&c[..ip], 2).ok_or_else(|| Error::invalid("bad compact latitude"))?;
                    let lon = dms(&rest[..lp], 3).ok_or_else(|| Error::invalid("bad compact longitude"))?;
                    let lat = if b[ip] == b'S' { -lat } else { lat };
                    let lon = if rest.as_bytes()[lp] == b'W' { -lon } else { lon };
                    return ok(lat, lon, 30.0, "NITF compact DMS").map(Some);
                }
            }
        }
    }
    // ±dd.ddd±ddd.ddd
    if (b[0] == b'+' || b[0] == b'-') && b.len() > 4 {
        if let Some(k) = b[1..].iter().position(|&x| x == b'+' || x == b'-') {
            let (a, o) = c.split_at(k + 1);
            if let (Ok(lat), Ok(lon)) = (a.parse::<f64>(), o.parse::<f64>()) {
                return ok(lat, lon, 110.0, "NITF compact decimal").map(Some);
            }
        }
    }
    Ok(None)
}

/// One latitude or longitude token with optional hemisphere, d/m/s marks or separators.
fn parse_angle(tok: &str) -> Option<(f64, Option<char>, f64)> {
    let mut t = tok.trim().to_string();
    let mut hemi = None;
    for h in ['N', 'S', 'E', 'W'] {
        if t.starts_with(h) {
            hemi = Some(h);
            t = t[1..].to_string();
            break;
        }
        if t.ends_with(h) {
            hemi = Some(h);
            t.pop();
            break;
        }
    }
    let norm: String = t
        .chars()
        .map(|c| match c {
            '°' | 'D' | ':' | '\'' | '′' | '"' | '″' | 'º' => ' ',
            c => c,
        })
        .collect();
    let parts: Vec<&str> = norm.split_whitespace().collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }
    let mut vals = Vec::new();
    for p in &parts {
        vals.push(p.parse::<f64>().ok()?);
    }
    let neg = vals[0] < 0.0 || parts[0].starts_with('-');
    let d = vals[0].abs();
    let (v, prec_deg) = match vals.len() {
        1 => (d, 10f64.powi(-(decimals(parts[0]) as i32))),
        2 => {
            if vals[1] >= 60.0 {
                return None;
            }
            (d + vals[1] / 60.0, 10f64.powi(-(decimals(parts[1]) as i32)) / 60.0)
        }
        _ => {
            if vals[1] >= 60.0 || vals[2] >= 60.0 {
                return None;
            }
            (d + vals[1] / 60.0 + vals[2] / 3600.0, 10f64.powi(-(decimals(parts[2]) as i32)) / 3600.0)
        }
    };
    Some((if neg { -v } else { v }, hemi, prec_deg))
}

fn decimals(s: &str) -> usize {
    s.find('.').map_or(0, |p| s.len() - p - 1)
}

fn parse_latlon(up: &str, lon_first: bool) -> Result<Parsed> {
    // Split into two tokens: by comma, or by hemisphere letters, or by whitespace in half.
    let toks = split_pair(up).ok_or_else(|| Error::invalid(format!("cannot read \"{up}\" as a coordinate")))?;
    let (a, b) = (&toks.0, &toks.1);
    let pa = parse_angle(a).ok_or_else(|| Error::invalid(format!("cannot read \"{a}\"")))?;
    let pb = parse_angle(b).ok_or_else(|| Error::invalid(format!("cannot read \"{b}\"")))?;
    let apply = |v: f64, h: Option<char>| -> f64 {
        match h {
            Some('S') | Some('W') => -v.abs(),
            _ => v,
        }
    };
    let is_lat = |h: Option<char>| matches!(h, Some('N') | Some('S'));
    let is_lon = |h: Option<char>| matches!(h, Some('E') | Some('W'));
    let (lat, lon, plat, notice) = if is_lat(pa.1) || is_lon(pb.1) {
        (apply(pa.0, pa.1), apply(pb.0, pb.1), pa.2, String::new())
    } else if is_lon(pa.1) || is_lat(pb.1) {
        (apply(pb.0, pb.1), apply(pa.0, pa.1), pb.2, String::new())
    } else if lon_first {
        (pb.0, pa.0, pb.2, String::new())
    } else if pa.0.abs() > 90.0 && pb.0.abs() <= 90.0 {
        (pb.0, pa.0, pb.2, "lon/lat order assumed".to_string())
    } else {
        (pa.0, pb.0, pa.2, String::new())
    };
    let fmt = if a.contains(['°', '\'', '"', 'D', ':']) || a.split_whitespace().count() > 1 {
        if a.matches(|c: char| c == '\'' || c == '′').count() > 0 && !a.contains(['"', '″']) && a.split(|c: char| c == '°' || c == 'D').count() == 2 && !a.contains(':') {
            "DDM"
        } else {
            "DMS"
        }
    } else {
        "DD"
    };
    let mut p = ok(lat, lon, plat * 111_320.0, fmt)?;
    p.notice = notice;
    Ok(p)
}

fn split_pair(s: &str) -> Option<(String, String)> {
    if let Some(i) = s.find(',') {
        return Some((s[..i].trim().to_string(), s[i + 1..].trim().to_string()));
    }
    let t = s.trim();
    // A hemisphere letter that ends the first token: "33 18 00N 44 24 00E", "33.3N 44.4E".
    let chars: Vec<char> = t.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if matches!(c, 'N' | 'S' | 'E' | 'W') && i > 0 && i + 1 < chars.len() {
            let prev_digitish = chars[i - 1].is_ascii_digit() || matches!(chars[i - 1], '"' | '\'' | '°' | '″' | '′' | '.');
            if prev_digitish {
                let a: String = chars[..=i].iter().collect();
                let b: String = chars[i + 1..].iter().collect();
                if !b.trim().is_empty() {
                    return Some((a.trim().to_string(), b.trim().to_string()));
                }
            }
        }
    }
    // A leading hemisphere letter starts the second token: "N33 18.000 E044 24.000".
    if let Some(first) = chars.first() {
        if matches!(first, 'N' | 'S' | 'E' | 'W') {
            for (i, &c) in chars.iter().enumerate().skip(1) {
                if matches!(c, 'N' | 'S' | 'E' | 'W') && chars[i - 1].is_whitespace() {
                    let a: String = chars[..i].iter().collect();
                    let b: String = chars[i..].iter().collect();
                    return Some((a.trim().to_string(), b.trim().to_string()));
                }
            }
        }
    }
    let parts: Vec<&str> = t.split_whitespace().collect();
    if parts.len() % 2 == 0 && !parts.is_empty() {
        let h = parts.len() / 2;
        return Some((parts[..h].join(" "), parts[h..].join(" ")));
    }
    None
}

// ---- formatting -------------------------------------------------------------------------

/// Decimal degrees, e.g. "33.300000°N 044.400000°E".
pub fn format_dd(lat: f64, lon: f64, decimals: usize) -> String {
    format!(
        "{:.d$}°{} {:0w$.d$}°{}",
        lat.abs(),
        if lat < 0.0 { 'S' } else { 'N' },
        lon.abs(),
        if lon < 0.0 { 'W' } else { 'E' },
        d = decimals,
        w = decimals + 4
    )
}

fn dms_parts(v: f64, sec_decimals: usize) -> (u32, u32, f64) {
    let scale = 10f64.powi(sec_decimals as i32);
    let total = (v.abs() * 3600.0 * scale).round() / scale;
    let d = (total / 3600.0).floor();
    let m = ((total - d * 3600.0) / 60.0).floor();
    let s = total - d * 3600.0 - m * 60.0;
    (d as u32, m as u32, s)
}

/// DMS, e.g. "33°18'00.00\"N 044°24'00.00\"E" (rounded, as displays round).
pub fn format_dms(lat: f64, lon: f64, sec_decimals: usize) -> String {
    let (ad, am, asec) = dms_parts(lat, sec_decimals);
    let (od, om, osec) = dms_parts(lon, sec_decimals);
    let w = if sec_decimals > 0 { sec_decimals + 3 } else { 2 };
    format!(
        "{ad:02}°{am:02}'{asec:0w$.p$}\"{} {od:03}°{om:02}'{osec:0w$.p$}\"{}",
        if lat < 0.0 { 'S' } else { 'N' },
        if lon < 0.0 { 'W' } else { 'E' },
        p = sec_decimals,
        w = w
    )
}

/// DDM, e.g. "33°18.0000'N 044°24.0000'E".
pub fn format_ddm(lat: f64, lon: f64, min_decimals: usize) -> String {
    let f = |v: f64| -> (u32, f64) {
        let scale = 10f64.powi(min_decimals as i32);
        let total = (v.abs() * 60.0 * scale).round() / scale;
        let d = (total / 60.0).floor();
        (d as u32, total - d * 60.0)
    };
    let (ad, am) = f(lat);
    let (od, om) = f(lon);
    let w = min_decimals + 3;
    format!(
        "{ad:02}°{am:0w$.p$}'{} {od:03}°{om:0w$.p$}'{}",
        if lat < 0.0 { 'S' } else { 'N' },
        if lon < 0.0 { 'W' } else { 'E' },
        p = min_decimals,
        w = w
    )
}

/// UTM/UPS text, GeographicLib style: "38n 444140.545 3684706.356" or "n 2277728.696 1518959.788".
pub fn format_utm(lat: f64, lon: f64, decimals: usize) -> Result<String> {
    let u = utmups_forward(lat, lon, None)?;
    let h = if u.northp { 'n' } else { 's' };
    Ok(if u.zone == UPS {
        format!("{h} {:.d$} {:.d$}", u.easting, u.northing, d = decimals)
    } else {
        format!("{}{h} {:.d$} {:.d$}", u.zone, u.easting, u.northing, d = decimals)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parser_vectors() {
        // Research/05 §3.8: every string gives 33.3N 44.4E within its precision.
        for s in [
            "33.3 44.4",
            "33°18'00\"N 044°24'00\"E",
            "33 18 00N 44 24 00E",
            "N33 18.000 E044 24.000",
            "331800N0442400E",
            "+33.300+044.400",
            "44.4E 33.3N",
            "38SMB4414084706",
            "38S MB 44140 84706",
            "38smb 44140 84706",
            "38n 444140.545 3684706.356",
        ] {
            let p = parse(s, false).unwrap_or_else(|e| panic!("{s}: {e}"));
            assert!((p.lat - 33.3).abs() < 2e-5, "{s}: lat {}", p.lat);
            assert!((p.lon - 44.4).abs() < 2e-5, "{s}: lon {}", p.lon);
        }
        assert!(parse("38SMB441408470", false).is_err());
        assert!(parse("38SMI4414084706", false).is_err());
    }

    #[test]
    fn swaps_obvious_lon_lat() {
        let p = parse("151.2 -33.8", false).unwrap();
        assert!((p.lat + 33.8).abs() < 1e-12 && (p.lon - 151.2).abs() < 1e-12);
        assert_eq!(p.notice, "lon/lat order assumed");
    }

    #[test]
    fn formats() {
        assert_eq!(format_dd(33.3, 44.4, 6), "33.300000°N 044.400000°E");
        assert_eq!(format_dms(33.3, 44.4, 2), "33°18'00.00\"N 044°24'00.00\"E");
        assert_eq!(format_ddm(33.3, 44.4, 4), "33°18.0000'N 044°24.0000'E");
        assert_eq!(format_utm(33.3, 44.4, 3).unwrap(), "38n 444140.545 3684706.356");
        assert_eq!(format_utm(85.0, 30.0, 3).unwrap(), "n 2277728.696 1518959.788");
    }

    #[test]
    fn gars_and_georef_parse() {
        let p = parse("381NH45", false).unwrap();
        assert_eq!(p.format, "GARS");
        assert!((p.lat - 57.625).abs() < 1e-9);
        let g = parse("NKLN2444638946", false).unwrap();
        assert_eq!(g.format, "GEOREF");
    }
}
