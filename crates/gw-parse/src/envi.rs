//! ENVI `.hdr` headers (REQ-MSI-01, REQ-FMT-09, REQ-MSI-13): the required keys (samples, lines,
//! bands, header offset, data type, interleave, byte order) and the useful optional ones
//! (wavelength, wavelength units, fwhm, band names, bbl, data ignore value, reflectance scale
//! factor, data gain/offset values, default bands, map info, coordinate system string, spectra
//! names for spectral libraries, description). Values in braces may span lines.

use gw_abi::{Error, Json, Result};

/// Bytes per sample of an ENVI data type code (1, 2, 3, 4, 5, 6, 9, 12, 13, 14, 15).
pub fn type_bytes(code: u32) -> Option<usize> {
    Some(match code {
        1 => 1,
        2 | 12 => 2,
        3 | 4 | 13 => 4,
        5 | 6 | 14 | 15 => 8,
        9 => 16,
        _ => return None,
    })
}

#[derive(Debug, Default)]
pub struct Header {
    pub pairs: Vec<(String, String)>,
}

impl Header {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.pairs.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    pub fn num(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(|v| v.trim().parse::<f64>().ok())
    }
    /// A brace list split on commas (names keep inner spaces).
    pub fn list(&self, k: &str) -> Vec<String> {
        let Some(v) = self.get(k) else { return Vec::new() };
        let v = v.trim().trim_start_matches('{').trim_end_matches('}');
        v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    }
    pub fn nums(&self, k: &str) -> Vec<f64> {
        self.list(k).iter().map(|s| s.parse::<f64>().unwrap_or(f64::NAN)).collect()
    }
}

pub fn parse(b: &[u8]) -> Result<Header> {
    if b.len() > 16 << 20 {
        return Err(Error::limit("ENVI header larger than 16 MB"));
    }
    let s = String::from_utf8_lossy(b);
    let mut it = s.lines();
    let first = it.next().unwrap_or("").trim_start_matches('\u{feff}').trim();
    if first != "ENVI" {
        return Err(Error::invalid("not an ENVI header (the first line must be ENVI)"));
    }
    let mut h = Header::default();
    let mut pending: Option<(String, String)> = None;
    for line in it {
        if let Some((k, mut v)) = pending.take() {
            v.push(' ');
            v.push_str(line.trim());
            if v.contains('}') {
                h.pairs.push((k, v));
            } else {
                pending = Some((k, v));
            }
            continue;
        }
        let Some(eq) = line.find('=') else { continue };
        let k = line[..eq].trim().to_lowercase();
        let v = line[eq + 1..].trim().to_string();
        if k.is_empty() {
            continue;
        }
        if v.starts_with('{') && !v.contains('}') {
            pending = Some((k, v));
        } else {
            h.pairs.push((k, v));
        }
        if h.pairs.len() > 10_000 {
            return Err(Error::limit("ENVI header has too many keys"));
        }
    }
    if let Some(p) = pending {
        h.pairs.push(p);
    }
    Ok(h)
}

/// Header → JSON with the derived layout facts and the checks a reader needs.
pub fn to_json(h: &Header, data_len: u64) -> Result<String> {
    let need = |k: &str| h.num(k).ok_or_else(|| Error::invalid(format!("ENVI header: '{k}' is missing")));
    let w = need("samples")? as u64;
    let ht = need("lines")? as u64;
    let nb = h.num("bands").unwrap_or(1.0) as u64;
    let dt = need("data type")? as u32;
    let bps = type_bytes(dt).ok_or_else(|| Error::unsupported(format!("ENVI data type {dt}")))? as u64;
    let off = h.num("header offset").unwrap_or(0.0) as u64;
    let il = h.get("interleave").unwrap_or("bsq").trim().to_lowercase();
    if !["bsq", "bil", "bip"].contains(&il.as_str()) {
        return Err(Error::invalid(format!("ENVI interleave '{il}'")));
    }
    let bo = h.num("byte order").unwrap_or(0.0) as i64;
    if w == 0 || ht == 0 || nb == 0 || w > 1 << 24 || ht > 1 << 24 || nb > 100_000 {
        return Err(Error::invalid("ENVI header: implausible dimensions"));
    }
    let need_bytes = off + w * ht * nb * bps;
    let mut j = Json::new();
    j.obj();
    j.kv_int("samples", w as i64).kv_int("lines", ht as i64).kv_int("bands", nb as i64).kv_int("dataType", dt as i64).kv_int("bytesPerSample", bps as i64);
    j.kv_int("headerOffset", off as i64).kv_str("interleave", &il).kv_int("byteOrder", bo).kv_str("fileType", h.get("file type").unwrap_or(""));
    j.kv_bool("sizeOk", data_len == 0 || data_len >= need_bytes).kv_num("needBytes", need_bytes as f64);
    j.kv_str("description", h.get("description").unwrap_or("").trim_matches(|c| c == '{' || c == '}').trim());
    j.kv_str("wavelengthUnits", h.get("wavelength units").unwrap_or(""));
    let arr = |j: &mut Json, k: &str, v: Vec<f64>| {
        j.key(k).arr();
        for x in v {
            j.num(x);
        }
        j.end_arr();
    };
    arr(&mut j, "wavelength", h.nums("wavelength"));
    arr(&mut j, "fwhm", h.nums("fwhm"));
    arr(&mut j, "bbl", h.nums("bbl"));
    arr(&mut j, "gain", h.nums("data gain values"));
    arr(&mut j, "offset", h.nums("data offset values"));
    arr(&mut j, "defaultBands", h.nums("default bands"));
    j.key("bandNames").arr();
    for n in h.list("band names") {
        j.str(&n);
    }
    j.end_arr();
    j.key("spectraNames").arr();
    for n in h.list("spectra names") {
        j.str(&n);
    }
    j.end_arr();
    match h.num("data ignore value") {
        Some(v) => j.kv_num("ignore", v),
        None => j.key("ignore").null(),
    };
    match h.num("reflectance scale factor") {
        Some(v) => j.kv_num("reflectanceScale", v),
        None => j.key("reflectanceScale").null(),
    };
    j.key("mapInfo").arr();
    for n in h.list("map info") {
        j.str(&n);
    }
    j.end_arr();
    j.kv_str("crs", h.get("coordinate system string").unwrap_or("").trim_matches(|c| c == '{' || c == '}').trim());
    j.end_obj();
    Ok(j.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_with_multiline_lists() {
        let t = b"ENVI\ndescription = {a test}\nsamples = 3\nlines = 2\nbands = 4\nheader offset = 0\ndata type = 12\ninterleave = bil\nbyte order = 1\nwavelength = {0.4, 0.5,\n 0.6, 0.7}\nband names = {Blue band, Green,\n Red, NIR}\nbbl = {1, 1, 0, 1}\n";
        let h = parse(t).unwrap();
        assert_eq!(h.nums("wavelength"), vec![0.4, 0.5, 0.6, 0.7]);
        assert_eq!(h.list("band names")[0], "Blue band");
        let j = to_json(&h, 48).unwrap();
        assert!(j.contains("\"sizeOk\":true") && j.contains("\"interleave\":\"bil\""));
        assert!(to_json(&h, 10).unwrap().contains("\"sizeOk\":false"));
        assert!(parse(b"NOTENVI\n").is_err());
    }
}
