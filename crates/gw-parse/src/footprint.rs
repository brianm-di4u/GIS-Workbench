//! MrSID and ECW container headers for the footprint layer (FC-01, FC-02, REQ-FMT-22): size, bands,
//! depth, generation and the georeferencing the container carries. No pixel data is touched.
//!
//! MrSID (MG2–MG4): the "msid" header gives the generation; the image-information database that
//! GeoExpress writes near the start of the file is a run of records `u32 len | key | NUL | u32 type |
//! u32 count | u32 | u32 | value` (len = key length + 16; types 1 u8, 2 u16, 3 u32, 5 string, 7 f64).
//! IMAGE::WIDTH/HEIGHT, IMAGE::XY_ORIGIN (centre of the first pixel), IMAGE::X/Y_RESOLUTION,
//! IMAGE::WKT and the GeoTIFF keys (GEOTIFF_NUM::3072 / ::2048) are read from it.
//! ECW v2: the 'e' file header (x/y size, bands, block size, cell sizes, origin of the first pixel's
//! corner, ER Mapper datum and projection names). ECW v3 (JP2-style boxes): `ihdr` for the size and
//! the `gtif` box (GeoTIFF tags as u16 tag | u32 length | payload) for the georeferencing.

use gw_abi::{Error, Json, Result};

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Georef {
    /// GDAL geotransform (corner of the first pixel).
    pub gt: [f64; 6],
    pub epsg: Option<u32>,
    pub wkt: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Footprint {
    pub format: String,
    pub version: String,
    pub width: u64,
    pub height: u64,
    pub bands: u32,
    pub bits: u32,
    pub georef: Option<Georef>,
    /// Other facts for the metadata panel (key, value).
    pub meta: Vec<(String, String)>,
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}
fn be32(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn f64be(b: &[u8], at: usize) -> Option<f64> {
    b.get(at..at + 8).map(|s| f64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}
fn f64le(b: &[u8], at: usize) -> Option<f64> {
    b.get(at..at + 8).map(|s| f64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}
fn cstr(b: &[u8], at: usize, max: usize) -> String {
    let s = b.get(at..(at + max).min(b.len())).unwrap_or(&[]);
    s.iter().take_while(|&&c| c != 0).map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { '?' }).collect::<String>().trim().to_string()
}

/// One value of a MrSID metadata record.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Num(Vec<f64>),
    Text(String),
}

/// The metadata records in `b` (keys IMAGE::…, GEOTIFF_NUM::…, GEOTIFF_CHAR::…).
fn mrsid_records(b: &[u8]) -> Vec<(String, Val)> {
    let mut out = Vec::new();
    let mut i = 4;
    while i + 8 < b.len() && out.len() < 4096 {
        // A key starts with one of the known namespaces right after its u32 length.
        let rest = &b[i..];
        let ns = [&b"IMAGE::"[..], b"GEOTIFF_NUM::", b"GEOTIFF_CHAR::", b"WORLD_FILE::"].iter().any(|n| rest.starts_with(n));
        if !ns {
            i += 1;
            continue;
        }
        let Some(len) = be32(b, i - 4) else { break };
        let klen = (len as usize).wrapping_sub(16);
        if klen == 0 || klen > 256 || b.get(i + klen) != Some(&0) {
            i += 1;
            continue;
        }
        let key = cstr(b, i, klen);
        let p = i + klen + 1;
        let (Some(ty), Some(count)) = (be32(b, p), be32(b, p + 4)) else { break };
        let v = p + 16;
        let n = (count as usize).min(64);
        let val = match ty {
            1 => Val::Num((0..n).filter_map(|k| b.get(v + k).map(|&x| x as f64)).collect()),
            2 => Val::Num((0..n).filter_map(|k| be16(b, v + 2 * k).map(|x| x as f64)).collect()),
            3 => Val::Num((0..n).filter_map(|k| be32(b, v + 4 * k).map(|x| x as f64)).collect()),
            7 => Val::Num((0..n).filter_map(|k| f64be(b, v + 8 * k)).collect()),
            5 => Val::Text(cstr(b, v, 4096)),
            _ => {
                i = p;
                continue;
            }
        };
        out.push((key, val));
        i = p + 16;
    }
    out
}

pub fn mrsid(b: &[u8]) -> Result<Footprint> {
    if b.len() < 41 || &b[..4] != b"msid" {
        return Err(Error::invalid("not a MrSID file (no msid header)"));
    }
    let version = b[4];
    let gen = match version {
        0..=2 => "MG2",
        3 => "MG3",
        4 => "MG4",
        _ => "MrSID",
    };
    let mut fp = Footprint { format: "MrSID".into(), version: format!("{gen} (container version {version})"), ..Default::default() };
    // MG2/MG3 header fields (as TE-061 read them); records below take precedence.
    if version <= 3 {
        let (w, h) = (be32(b, 26).unwrap_or(0), be32(b, 30).unwrap_or(0));
        if w > 0 && h > 0 && w < 1 << 31 && h < 1 << 31 {
            fp.width = w as u64;
            fp.height = h as u64;
            fp.bands = b[36] as u32;
            fp.bits = b[40] as u32;
        }
    }
    let recs = mrsid_records(b);
    let num = |k: &str| recs.iter().find(|(key, _)| key == k).and_then(|(_, v)| if let Val::Num(n) = v { n.first().copied() } else { None });
    let nums = |k: &str| recs.iter().find(|(key, _)| key == k).and_then(|(_, v)| if let Val::Num(n) = v { Some(n.clone()) } else { None });
    let text = |k: &str| recs.iter().find(|(key, _)| key == k).and_then(|(_, v)| if let Val::Text(t) = v { Some(t.clone()) } else { None });
    if let (Some(w), Some(h)) = (num("IMAGE::WIDTH"), num("IMAGE::HEIGHT")) {
        if w >= 1.0 && h >= 1.0 && w < 1e10 && h < 1e10 {
            fp.width = w as u64;
            fp.height = h as u64;
        }
    }
    if let Some(n) = num("IMAGE::BITS_PER_SAMPLE") {
        fp.bits = n as u32;
    }
    if let Some(cs) = num("IMAGE::COLOR_SCHEME") {
        fp.meta.push(("Colour scheme code".into(), (cs as u32).to_string()));
    }
    if fp.width == 0 || fp.height == 0 {
        return Err(gw_abi::err!(INVALID, "MrSID {gen}: the image size is not in the header", gen));
    }
    if fp.bits == 0 {
        fp.bits = 8;
    }
    if fp.bands == 0 {
        fp.bands = 1;
    }
    if let Some(f) = text("IMAGE::FORMAT") {
        fp.version = format!("{f} (container version {version})");
    }
    for (k, label) in [("IMAGE::ENCODING_APPLICATION", "Encoded by"), ("IMAGE::MODIFICATIONS", "Modifications"), ("IMAGE::INPUT_FORMAT", "Source format")] {
        if let Some(t) = text(k) {
            fp.meta.push((label.into(), t));
        }
    }
    if let Some(nd) = nums("IMAGE::NO_DATA_VALUE") {
        fp.meta.push(("No-data value".into(), nd.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(", ")));
    }
    let wkt = text("IMAGE::WKT").filter(|w| w.len() > 8).or_else(|| geokeys_proj4(&|k: u16| recs.iter().find(|(key, _)| key.starts_with(&format!("GEOTIFF_NUM::{k}::"))).and_then(|(_, v)| if let Val::Num(n) = v { n.first().copied() } else { None })));
    let epsg = num("GEOTIFF_NUM::3072::ProjectedCSTypeGeoKey").or_else(|| num("GEOTIFF_NUM::2048::GeographicTypeGeoKey")).map(|v| v as u32).filter(|&c| c > 1000 && c < 32767);
    if let (Some(o), Some(rx), Some(ry)) = (nums("IMAGE::XY_ORIGIN"), num("IMAGE::X_RESOLUTION"), num("IMAGE::Y_RESOLUTION")) {
        if o.len() >= 2 && rx.is_finite() && ry.is_finite() && rx != 0.0 && ry != 0.0 && o[0].is_finite() && o[1].is_finite() {
            let ry = -ry.abs();
            fp.georef = Some(Georef { gt: [o[0] - rx / 2.0, rx, 0.0, o[1] - ry / 2.0, 0.0, ry], epsg, wkt: wkt.clone(), source: "MrSID metadata (IMAGE::XY_ORIGIN, X/Y_RESOLUTION)".into() });
        }
    }
    if fp.georef.is_none() && (epsg.is_some() || wkt.is_some()) {
        fp.meta.push(("CRS only".into(), "the file names a CRS but has no origin and resolution".into()));
        fp.georef = Some(Georef { gt: [0.0; 6], epsg, wkt, source: "MrSID metadata (CRS only)".into() });
    }
    Ok(fp)
}

/// A PROJ string for user-defined GeoTIFF keys (ProjectedCSType 32767): the coordinate
/// transformations GeoExpress writes (TM, Mercator, LCC 1/2SP, LAEA, AEA, polar stereographic) on
/// NAD27/NAD83/WGS 84. `key` reads one numeric GeoKey.
fn geokeys_proj4(key: &dyn Fn(u16) -> Option<f64>) -> Option<String> {
    if key(3072).map(|v| v as u32) != Some(32767) {
        return None;
    }
    let ct = key(3075)? as u32;
    let datum = match key(2048).map(|v| v as u32) {
        Some(4267) => "+datum=NAD27",
        Some(4269) => "+datum=NAD83",
        Some(4326) | None => "+datum=WGS84",
        Some(6318) => "+ellps=GRS80 +towgs84=0,0,0",
        _ => "+ellps=GRS80",
    };
    let units = match key(3076).map(|v| v as u32) {
        Some(9002) => "+units=ft",
        Some(9003) => "+units=us-ft",
        _ => "+units=m",
    };
    let g = |a: u16, b: u16| key(a).or_else(|| key(b)).unwrap_or(0.0);
    let x0 = g(3082, 3090);
    let y0 = g(3083, 3091);
    let k = key(3092).or_else(|| key(3093)).unwrap_or(1.0);
    let body = match ct {
        1 => format!("+proj=tmerc +lat_0={} +lon_0={} +k={k} +x_0={x0} +y_0={y0}", g(3081, 3089), g(3080, 3088)),
        7 => format!("+proj=merc +lon_0={} +lat_ts={} +k={k} +x_0={x0} +y_0={y0}", g(3080, 3088), key(3081).unwrap_or(0.0)),
        8 => format!("+proj=lcc +lat_1={} +lat_2={} +lat_0={} +lon_0={} +x_0={} +y_0={}", g(3078, 3081), g(3079, 3078), g(3085, 3081), g(3084, 3080), g(3086, 3082), g(3087, 3083)),
        9 => format!("+proj=lcc +lat_1={0} +lat_0={0} +lon_0={1} +k_0={k} +x_0={x0} +y_0={y0}", g(3081, 3089), g(3080, 3088)),
        10 => format!("+proj=laea +lat_0={} +lon_0={} +x_0={x0} +y_0={y0}", g(3089, 3081), g(3088, 3080)),
        11 => format!("+proj=aea +lat_1={} +lat_2={} +lat_0={} +lon_0={} +x_0={} +y_0={}", g(3078, 3081), g(3079, 3078), g(3085, 3081), g(3084, 3080), g(3086, 3082), g(3087, 3083)),
        15 => format!("+proj=stere +lat_0={} +lon_0={} +k={k} +x_0={x0} +y_0={y0}", if g(3081, 3089) < 0.0 { -90 } else { 90 }, g(3095, 3080)),
        _ => return None,
    };
    Some(format!("{body} {datum} {units} +no_defs"))
}

/// EPSG code for an ER Mapper datum/projection pair, where the pair names a common CRS.
fn ermapper_epsg(datum: &str, proj: &str) -> Option<u32> {
    let d = datum.to_ascii_uppercase();
    let p = proj.to_ascii_uppercase();
    if let Some(code) = p.strip_prefix("EPSG:").and_then(|c| c.parse().ok()) {
        return Some(code);
    }
    if p == "GEODETIC" || p == "LL" {
        return match d.as_str() {
            "WGS84" => Some(4326),
            "NAD83" => Some(4269),
            "NAD27" => Some(4267),
            "GDA94" => Some(4283),
            "ETRF89" | "ETRS89" => Some(4258),
            _ => None,
        };
    }
    let zone = |s: &str| s.parse::<u32>().ok().filter(|z| (1..=60).contains(z));
    if let Some(z) = p.strip_prefix("NUTM").and_then(zone) {
        return match d.as_str() {
            "WGS84" => Some(32600 + z),
            "NAD83" if z <= 23 => Some(26900 + z),
            "NAD27" if z <= 22 => Some(26700 + z),
            "ETRF89" | "ETRS89" if (28..=38).contains(&z) => Some(25800 + z),
            _ => None,
        };
    }
    if let Some(z) = p.strip_prefix("SUTM").and_then(zone) {
        return match d.as_str() {
            "WGS84" => Some(32700 + z),
            _ => None,
        };
    }
    if let Some(z) = p.strip_prefix("MGA").and_then(zone) {
        return if d == "GDA94" { Some(28300 + z) } else if d == "GDA2020" { Some(7800 + z) } else { None };
    }
    None
}

pub fn ecw(b: &[u8]) -> Result<Footprint> {
    if b.first() == Some(&0x65) && b.len() >= 89 {
        let x = be32(b, 6).unwrap_or(0);
        let y = be32(b, 10).unwrap_or(0);
        let bands = be16(b, 14).unwrap_or(0);
        if x == 0 || y == 0 || bands == 0 || bands > 256 {
            return Err(Error::invalid("ECW: implausible header (size or bands)"));
        }
        let mut fp = Footprint { format: "ECW".into(), version: format!("ECW v{}", b[1]), width: x as u64, height: y as u64, bands: bands as u32, bits: 8, ..Default::default() };
        fp.meta.push(("Block size".into(), format!("{} × {}", be16(b, 18).unwrap_or(0), be16(b, 20).unwrap_or(0))));
        fp.meta.push(("Target compression".into(), format!("{}:1", be16(b, 22).unwrap_or(0))));
        fp.meta.push(("Resolution levels".into(), b[4].to_string()));
        let units = match b[24] {
            1 => "metres",
            2 => "degrees",
            3 => "US survey feet",
            _ => "unknown",
        };
        fp.meta.push(("Cell units".into(), units.into()));
        let (cx, cy, ox, oy) = (f64le(b, 25).unwrap_or(f64::NAN), f64le(b, 33).unwrap_or(f64::NAN), f64le(b, 41).unwrap_or(f64::NAN), f64le(b, 49).unwrap_or(f64::NAN));
        let datum = cstr(b, 57, 16);
        let proj = cstr(b, 73, 16);
        fp.meta.push(("ER Mapper datum".into(), datum.clone()));
        fp.meta.push(("ER Mapper projection".into(), proj.clone()));
        if [cx, cy, ox, oy].iter().all(|v| v.is_finite()) && cx != 0.0 && cy != 0.0 && !(proj.eq_ignore_ascii_case("RAW") && datum.eq_ignore_ascii_case("RAW") && ox == 0.0 && oy == 0.0) {
            let epsg = ermapper_epsg(&datum, &proj);
            let raw = proj.eq_ignore_ascii_case("RAW") || datum.eq_ignore_ascii_case("RAW");
            fp.georef = Some(Georef { gt: [ox, cx, 0.0, oy, 0.0, cy], epsg, wkt: None, source: format!("ECW header ({datum} / {proj}{})", if raw { ", RAW: no CRS" } else { "" }) });
        }
        return Ok(fp);
    }
    // ECW v3: JP2-like boxes ('ecw ' signature, 'ecwh' superbox with 'ihdr', 'gtif').
    if b.len() >= 12 && &b[4..8] == b"ecw " {
        let mut fp = Footprint { format: "ECW".into(), version: "ECW v3".into(), bits: 8, ..Default::default() };
        let find = |tag: &[u8; 4]| b.windows(4).take(1 << 20).position(|w| w == tag);
        if let Some(at) = find(b"ihdr") {
            let p = at + 4;
            fp.height = be32(b, p + 3).unwrap_or(0) as u64;
            fp.width = be32(b, p + 7).unwrap_or(0) as u64;
            fp.bands = be16(b, p + 11).unwrap_or(0) as u32;
        }
        if fp.width == 0 || fp.height == 0 || fp.bands == 0 {
            return Err(Error::invalid("ECW v3: no image header box"));
        }
        if let Some(at) = find(b"gtif") {
            let start = at.saturating_sub(4);
            let blen = be32(b, start).unwrap_or(0) as usize;
            let end = start.saturating_add(blen).min(b.len());
            let mut p = at + 8; // box type + u32 payload length
            let (mut tie, mut scale, mut keys, mut citation) = (Vec::new(), Vec::new(), Vec::new(), String::new());
            while p + 6 <= end {
                let tag = be16(b, p).unwrap_or(0);
                let len = be32(b, p + 2).unwrap_or(0) as usize;
                let d = p + 6;
                if d + len > end {
                    break;
                }
                match tag {
                    33922 => tie = (0..len / 8).filter_map(|k| f64le(b, d + 8 * k)).collect(),
                    33550 => scale = (0..len / 8).filter_map(|k| f64le(b, d + 8 * k)).collect(),
                    34735 => keys = (0..len / 2).filter_map(|k| be16(b, d + 2 * k)).collect(),
                    34737 => citation = cstr(b, d, len),
                    _ => {}
                }
                p = d + len;
            }
            let mut epsg = None;
            for k in keys.chunks_exact(4).skip(1) {
                if (k[0] == 3072 || k[0] == 2048) && k[1] == 0 && k[3] > 1000 && k[3] < 32767 {
                    epsg = Some(k[3] as u32);
                }
            }
            if !citation.is_empty() {
                fp.meta.push(("GeoTIFF citation".into(), citation.trim_end_matches('|').to_string()));
            }
            let raw = citation.contains("(RAW, RAW)");
            if tie.len() >= 6 && scale.len() >= 2 && !(raw && epsg.is_none() && tie[3] == 0.0 && tie[4] == 0.0) {
                fp.georef = Some(Georef { gt: [tie[3] - tie[0] * scale[0], scale[0], 0.0, tie[4] + tie[1] * scale[1], 0.0, -scale[1]], epsg, wkt: None, source: "ECW v3 GeoTIFF box".into() });
            }
        }
        return Ok(fp);
    }
    Err(Error::invalid("not an ECW file (no v2 header or v3 box)"))
}

pub fn to_json(f: &Footprint) -> String {
    let mut j = Json::new();
    j.obj().kv_str("format", &f.format).kv_str("version", &f.version).key("width").num(f.width as f64).key("height").num(f.height as f64).key("bands").int(f.bands as i64).key("bits").int(f.bits as i64);
    j.key("georef");
    match &f.georef {
        Some(g) => {
            j.obj().key("gt").arr();
            for v in g.gt {
                j.num(v);
            }
            j.end_arr();
            match g.epsg {
                Some(c) => j.key("epsg").int(c as i64),
                None => j.key("epsg").null(),
            };
            match &g.wkt {
                Some(w) => j.kv_str("wkt", w),
                None => j.key("wkt").null(),
            };
            j.kv_str("source", &g.source).end_obj();
        }
        None => {
            j.null();
        }
    }
    j.key("meta").arr();
    for (k, v) in &f.meta {
        j.arr().str(k).str(v).end_arr();
    }
    j.end_arr().end_obj();
    j.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(key: &str, ty: u32, val: &[u8]) -> Vec<u8> {
        let mut v = ((key.len() + 16) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(key.as_bytes());
        v.push(0);
        for x in [ty, 1, 1, 1] {
            v.extend_from_slice(&x.to_be_bytes());
        }
        v.extend_from_slice(val);
        v
    }

    #[test]
    fn mrsid_records_georeference() {
        let mut b = b"msid\x03".to_vec();
        b.resize(80, 0);
        b.extend(rec("IMAGE::WIDTH", 3, &512u32.to_be_bytes()));
        b.extend(rec("IMAGE::HEIGHT", 3, &256u32.to_be_bytes()));
        let mut o = rec("IMAGE::XY_ORIGIN", 7, &440750f64.to_be_bytes());
        o[4 + 16 + 1 + 4..4 + 16 + 1 + 8].copy_from_slice(&2u32.to_be_bytes());
        o.extend_from_slice(&3751290f64.to_be_bytes());
        b.extend(o);
        b.extend(rec("IMAGE::X_RESOLUTION", 7, &60f64.to_be_bytes()));
        b.extend(rec("IMAGE::Y_RESOLUTION", 7, &60f64.to_be_bytes()));
        b.extend(rec("GEOTIFF_NUM::3072::ProjectedCSTypeGeoKey", 2, &26711u16.to_be_bytes()));
        let f = mrsid(&b).unwrap();
        assert_eq!((f.width, f.height), (512, 256));
        let g = f.georef.unwrap();
        assert_eq!(g.gt, [440720.0, 60.0, 0.0, 3751320.0, 0.0, -60.0]);
        assert_eq!(g.epsg, Some(26711));
    }

    #[test]
    fn ecw_v2_header() {
        let mut b = vec![0x65, 2, 1, 2, 4, 4];
        b.extend_from_slice(&1029u32.to_be_bytes());
        b.extend_from_slice(&1022u32.to_be_bytes());
        b.extend_from_slice(&3u16.to_be_bytes());
        b.extend_from_slice(&[0, 1, 0, 64, 0, 64, 0, 25, 1]);
        for v in [2.0f64, -2.0, 484959.0, 3620175.0] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        let mut s = b"NAD83".to_vec();
        s.resize(16, 0);
        b.extend(&s);
        let mut s = b"NUTM11".to_vec();
        s.resize(16, 0);
        b.extend(&s);
        let f = ecw(&b).unwrap();
        assert_eq!((f.width, f.height, f.bands), (1029, 1022, 3));
        let g = f.georef.unwrap();
        assert_eq!((g.gt[0], g.gt[5], g.epsg), (484959.0, -2.0, Some(26911)));
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        for b in [&b""[..], b"msid", b"e", b"\x65\x02\x01", b"\0\0\0\x0cecw \0\0\0\0"] {
            let _ = mrsid(b);
            let _ = ecw(b);
        }
        assert!(mrsid(b"msid\x03\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0").is_err());
    }
}
