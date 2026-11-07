//! UAVSAR `.ann` annotation and the raw binary products it describes (FC-24, REQ-FMT-53).
//!
//! An annotation is text: `key (units) = value ; comment`, `;` comment lines. PolSAR annotations
//! describe each layer by `<layer>.set_rows`, `.set_cols`, `.val_size`, `.val_frmt`, `.set_proj`
//! (`SCX` slant range, `EQA` equiangular ground range), `.row_addr`/`.col_addr` (for EQA the centre
//! latitude/longitude of the upper-left pixel) and `.row_mult`/`.col_mult` (pixel spacing, degrees for
//! EQA), and name the product files (`grdHHHH = …grd`). InSAR annotations give the ground grid as
//! `Ground Range Data Latitude Lines` and friends. Products are headerless (`set_hddr` bytes may lead),
//! little-endian unless `val_endi` says otherwise: REAL*4, COMPLEX (two REAL*4), or two REAL*4 per pixel.
//! `product` picks the layer a binary file is, from its name in the annotation and its size.

use gw_abi::{Error, Json, Result};

pub const MAX_BYTES: usize = 4 << 20;

#[derive(Clone, Debug)]
pub struct Entry {
    pub key: String,
    pub units: String,
    pub value: String,
}

#[derive(Clone, Debug, Default)]
pub struct Ann {
    pub entries: Vec<Entry>,
}

impl Ann {
    pub fn get(&self, k: &str) -> Option<&str> {
        let k = k.to_ascii_lowercase();
        self.entries.iter().find(|e| e.key.to_ascii_lowercase() == k).map(|e| e.value.as_str())
    }
    pub fn num(&self, k: &str) -> Option<f64> {
        self.get(k).and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite())
    }
}

/// Parse an annotation file.
pub fn parse(b: &[u8]) -> Result<Ann> {
    if b.len() > MAX_BYTES {
        return Err(Error::limit("UAVSAR annotation is larger than 4 MiB"));
    }
    let text = String::from_utf8_lossy(b);
    let mut entries = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with(';') {
            continue;
        }
        let Some(eq) = l.find('=') else { continue };
        let (lhs, rhs) = (l[..eq].trim(), &l[eq + 1..]);
        // A value runs to a ';' comment (URLs and dates hold no ';').
        let value = rhs.split(';').next().unwrap_or("").trim().to_string();
        let (key, units) = match (lhs.rfind('('), lhs.ends_with(')')) {
            (Some(p), true) => (lhs[..p].trim().to_string(), lhs[p + 1..lhs.len() - 1].trim().to_string()),
            _ => (lhs.to_string(), String::new()),
        };
        if key.is_empty() {
            continue;
        }
        entries.push(Entry { key, units, value });
        if entries.len() > 20000 {
            return Err(Error::limit("UAVSAR annotation has too many lines"));
        }
    }
    let ann = Ann { entries };
    if ann.entries.len() < 3 || !ann.entries.iter().any(|e| e.key.contains("set_rows") || e.key.starts_with("Ground Range Data") || e.key.contains("UAVSAR") || e.key.contains("Annotation")) {
        return Err(Error::invalid("not a UAVSAR annotation (no layer sizes)"));
    }
    Ok(ann)
}

/// The data type of a layer: REAL*4, COMPLEX (two REAL*4), or two REAL*4 values per pixel.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Real,
    Complex,
    Pair,
}

#[derive(Clone, Debug)]
pub struct Product {
    pub key: String,
    pub layer: String,
    pub rows: u64,
    pub cols: u64,
    pub val_size: u64,
    pub kind: Kind,
    pub header: u64,
    pub little: bool,
    pub proj: String,
    /// GDAL geotransform (pixel corner) for EQA layers in EPSG:4326.
    pub gt: Option<[f64; 6]>,
    pub units: String,
}

fn layer_dims(a: &Ann, layer: &str) -> Option<(u64, u64, u64)> {
    let r = a.num(&format!("{layer}.set_rows"))?;
    let c = a.num(&format!("{layer}.set_cols"))?;
    let v = a.num(&format!("{layer}.val_size")).unwrap_or(4.0);
    if r < 1.0 || c < 1.0 || r > 1e8 || c > 1e8 || !(1.0..=64.0).contains(&v) {
        return None;
    }
    Some((r as u64, c as u64, v as u64))
}

/// The product a binary file is: by its name in the annotation (`grdHHHH = name`), else by extension,
/// and checked against its size.
pub fn product(a: &Ann, file_name: &str, file_len: u64) -> Result<Product> {
    let fname = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    let lower = fname.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("").to_string();
    let named = a.entries.iter().find(|e| e.value.split_whitespace().next().map(|v| v.eq_ignore_ascii_case(fname)).unwrap_or(false)).map(|e| e.key.clone());
    let key = named.clone().unwrap_or_else(|| ext.clone());
    let kl = key.to_ascii_lowercase();
    let pol = kl.trim_start_matches(|c: char| c.is_ascii_lowercase() && !"hv".contains(c)).to_ascii_uppercase();
    let diag = pol.len() == 4 && pol[..2] == pol[2..];
    let header = a.num("set_hddr").unwrap_or(0.0).max(0.0) as u64;
    let little = !a.get("val_endi").map(|v| v.to_ascii_uppercase().contains("BIG")).unwrap_or(false);
    // Candidate layers in preference order.
    let cands: Vec<&str> = match ext.as_str() {
        "slc" => vec!["slc_mag", "slc"],
        "mlc" => if diag { vec!["mlc_pwr", "mlc_mag"] } else { vec!["mlc_mag", "mlc_pwr"] },
        "grd" => if diag { vec!["grd_pwr", "grd_mag"] } else { vec!["grd_mag", "grd_pwr"] },
        "hgt" => vec!["hgt", "grd_pwr"],
        "inc" => vec!["inc", "grd_pwr"],
        "slope" => vec!["slope"],
        "cor" => vec!["cor", "cor_grd"],
        "unw" => vec!["unw", "unw_grd"],
        "int" => vec!["int", "int_grd"],
        "amp" | "amp1" | "amp2" => vec!["amp1", "amp", "amp2"],
        "dat" => return Err(Error::unsupported("UAVSAR .dat holds compressed Stokes matrices, which are not read: open the .mlc or .grd covariance products")),
        _ => vec![],
    };
    let fmt_kind = |layer: &str, vs: u64| -> Kind {
        let f = a.get(&format!("{layer}.val_frmt")).unwrap_or("").to_ascii_uppercase();
        if f.contains("COMPLEX") || ((layer.ends_with("_mag") || layer == "int") && vs == 8) {
            Kind::Complex
        } else if vs == 8 {
            Kind::Pair
        } else {
            Kind::Real
        }
    };
    let mut pick: Option<Product> = None;
    for l in &cands {
        let Some((rows, cols, vs)) = layer_dims(a, l) else { continue };
        if rows.saturating_mul(cols).saturating_mul(vs).saturating_add(header) != file_len {
            continue;
        }
        let kind = fmt_kind(l, vs);
        if (kind == Kind::Real && vs != 4) || (kind != Kind::Real && vs != 8) {
            continue;
        }
        let proj = a.get(&format!("{l}.set_proj")).unwrap_or("").to_string();
        let gt = if proj.eq_ignore_ascii_case("EQA") {
            match (a.num(&format!("{l}.row_addr")), a.num(&format!("{l}.col_addr")), a.num(&format!("{l}.row_mult")), a.num(&format!("{l}.col_mult"))) {
                (Some(la), Some(lo), Some(dla), Some(dlo)) if dla != 0.0 && dlo != 0.0 => Some([lo - dlo / 2.0, dlo, 0.0, la - dla / 2.0, 0.0, dla]),
                _ => None,
            }
        } else {
            None
        };
        let prefix = l.split('_').next().unwrap_or(l).to_ascii_uppercase();
        let units = a.get(&format!("{prefix} Data Units")).unwrap_or("").to_string();
        pick = Some(Product { key: key.clone(), layer: l.to_string(), rows, cols, val_size: vs, kind, header, little, proj, gt, units });
        break;
    }
    // InSAR ground products: the ground grid lines.
    if pick.is_none() {
        let (r, c) = (a.num("Ground Range Data Latitude Lines"), a.num("Ground Range Data Longitude Samples"));
        if let (Some(r), Some(c)) = (r, c) {
            let (rows, cols) = (r as u64, c as u64);
            for (vs, kind) in [(4u64, Kind::Real), (8, Kind::Complex)] {
                if rows.saturating_mul(cols).saturating_mul(vs).saturating_add(header) == file_len {
                    let gt = match (a.num("Ground Range Data Starting Latitude"), a.num("Ground Range Data Starting Longitude"), a.num("Ground Range Data Latitude Spacing"), a.num("Ground Range Data Longitude Spacing")) {
                        (Some(la), Some(lo), Some(dla), Some(dlo)) if dla != 0.0 && dlo != 0.0 => Some([lo - dlo / 2.0, dlo, 0.0, la - dla / 2.0, 0.0, dla]),
                        _ => None,
                    };
                    pick = Some(Product { key: key.clone(), layer: "grd".into(), rows, cols, val_size: vs, kind, header, little, proj: "EQA".into(), gt, units: String::new() });
                    break;
                }
            }
        }
    }
    pick.ok_or_else(|| {
        let what = cands.iter().filter_map(|l| layer_dims(a, l).map(|(r, c, v)| format!("{l} {r} × {c} × {v} B"))).collect::<Vec<_>>().join(", ");
        gw_abi::err!(INVALID, "UAVSAR {fname} ({file_len} bytes) matches no layer of its annotation{detail}", fname, file_len, detail = if what.is_empty() { String::new() } else { format!(" ({what})") })
    })
}

/// The approximate swath corners (UL, UR, LR, LL) as (lat, lon), when the annotation gives them.
pub fn corners(a: &Ann) -> Option<[(f64, f64); 4]> {
    let c = |p: &str| Some((a.num(&format!("Approximate {p} Latitude"))?, a.num(&format!("Approximate {p} Longitude"))?));
    Some([c("Upper Left")?, c("Upper Right")?, c("Lower Right")?, c("Lower Left")?])
}

/// Annotation JSON: entries, layers, named files, corners, peg and the acquisition.
pub fn to_json(a: &Ann) -> String {
    let mut j = Json::new();
    j.obj();
    j.key("entries").obj();
    for e in &a.entries {
        j.kv_str(&e.key, &e.value);
    }
    j.end_obj();
    j.key("layers").obj();
    for e in a.entries.iter().filter(|e| e.key.ends_with(".set_rows")) {
        let l = &e.key[..e.key.len() - 9];
        if let Some((r, c, v)) = layer_dims(a, l) {
            j.key(l).obj().kv_num("rows", r as f64).kv_num("cols", c as f64).kv_num("valSize", v as f64).kv_str("format", a.get(&format!("{l}.val_frmt")).unwrap_or("")).kv_str("proj", a.get(&format!("{l}.set_proj")).unwrap_or("")).end_obj();
        }
    }
    j.end_obj();
    j.key("files").obj();
    for e in &a.entries {
        let v = e.value.split_whitespace().next().unwrap_or("");
        if v.contains('.') && !v.contains('/') && !e.key.contains(' ') && v.len() < 200 && v.rsplit('.').next().map(|x| matches!(x.to_ascii_lowercase().as_str(), "slc" | "mlc" | "grd" | "hgt" | "inc" | "slope" | "dat" | "kmz" | "cor" | "unw" | "int" | "amp" | "amp1" | "amp2" | "h5")).unwrap_or(false) {
            j.kv_str(&e.key, v);
        }
    }
    j.end_obj();
    match corners(a) {
        Some(c) => {
            j.key("corners").arr();
            for (la, lo) in c {
                j.arr().num(la).num(lo).end_arr();
            }
            j.end_arr();
        }
        None => {
            j.key("corners").null();
        }
    }
    for (k, src) in [("site", "Site Description"), ("mode", "Acquisition Mode"), ("start", "Start Time of Acquisition"), ("stop", "Stop Time of Acquisition"), ("look", "Look Direction"), ("url", "URL")] {
        j.kv_str(k, a.get(src).unwrap_or(""));
    }
    for (k, src) in [("wavelengthCm", "Center Wavelength"), ("pegLat", "Peg Latitude"), ("pegLon", "Peg Longitude"), ("pegHeading", "Peg Heading"), ("altitude", "Average Altitude")] {
        match a.num(src) {
            Some(v) => j.kv_num(k, v),
            None => j.key(k).null(),
        };
    }
    j.end_obj();
    j.finish()
}

pub fn product_json(p: &Product) -> String {
    let mut j = Json::new();
    j.obj().kv_str("key", &p.key).kv_str("layer", &p.layer).kv_num("rows", p.rows as f64).kv_num("cols", p.cols as f64).kv_num("valSize", p.val_size as f64);
    j.kv_str("kind", match p.kind {
        Kind::Real => "real",
        Kind::Complex => "complex",
        Kind::Pair => "pair",
    });
    j.kv_num("header", p.header as f64).kv_bool("littleEndian", p.little).kv_str("proj", &p.proj).kv_str("units", &p.units);
    match p.gt {
        Some(g) => {
            j.key("geotransform").arr();
            for v in g {
                j.num(v);
            }
            j.end_arr();
        }
        None => {
            j.key("geotransform").null();
        }
    }
    j.end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANN: &str = "; comment\nUAVSAR PolSAR Annotation File Version Number      (-)             = 2.0\ngrdHHHH   = T_L090HHHH_CX_01.grd    ; File Size 24 bytes\ngrdHHVV   = T_L090HHVV_CX_01.grd\ngrd_pwr.set_rows (pixels) = 2 ; rows\ngrd_pwr.set_cols (pixels) = 3\ngrd_pwr.val_size (bytes) = 4\ngrd_pwr.val_frmt (&) = REAL*4\ngrd_pwr.set_proj (&) = EQA\ngrd_pwr.row_addr (deg) = 34.5\ngrd_pwr.col_addr (deg) = -119.5\ngrd_pwr.row_mult (deg/pixel) = -0.001\ngrd_pwr.col_mult (deg/pixel) = 0.001\ngrd_mag.set_rows (pixels) = 2\ngrd_mag.set_cols (pixels) = 3\ngrd_mag.val_size (bytes) = 8\ngrd_mag.val_frmt (&) = COMPLEX_MAGNITUDE\ngrd_mag.set_proj (&) = EQA\ngrd_mag.row_addr (deg) = 34.5\ngrd_mag.col_addr (deg) = -119.5\ngrd_mag.row_mult (deg/pixel) = -0.001\ngrd_mag.col_mult (deg/pixel) = 0.001\nval_endi (&) = LITTLE ENDIAN\nApproximate Upper Left Latitude (deg) = 34.5\nApproximate Upper Left Longitude (deg) = -119.5\nApproximate Upper Right Latitude (deg) = 34.5\nApproximate Upper Right Longitude (deg) = -119.497\nApproximate Lower Right Latitude (deg) = 34.498\nApproximate Lower Right Longitude (deg) = -119.497\nApproximate Lower Left Latitude (deg) = 34.498\nApproximate Lower Left Longitude (deg) = -119.5\n";

    #[test]
    fn layers_by_name_and_size() {
        let a = parse(ANN.as_bytes()).unwrap();
        assert_eq!(a.get("grd_pwr.set_rows"), Some("2"));
        let p = product(&a, "T_L090HHHH_CX_01.grd", 24).unwrap();
        assert_eq!((p.layer.as_str(), p.kind), ("grd_pwr", Kind::Real));
        let g = p.gt.unwrap();
        assert!((g[0] + 119.5005).abs() < 1e-12 && (g[3] - 34.5005).abs() < 1e-12);
        let c = product(&a, "dir/T_L090HHVV_CX_01.grd", 48).unwrap();
        assert_eq!((c.layer.as_str(), c.kind), ("grd_mag", Kind::Complex));
        let e = product(&a, "T_L090HHHH_CX_01.grd", 25).unwrap_err();
        assert!(e.msg.contains("matches no layer"), "{}", e.msg);
        assert!(product(&a, "x.dat", 10).unwrap_err().msg.contains("Stokes"));
        assert!(to_json(&a).contains("\"corners\":[[34.5,-119.5]"));
        assert!(parse(b"hello\nworld = 1\n").is_err());
    }
}
