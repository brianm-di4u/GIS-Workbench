//! Sentinel-1 SAFE products (FC-26, REQ-FMT-55): `manifest.safe` and the per-swath, per-polarisation
//! annotation, calibration and noise XML of a Level-1 product (SLC or GRD, SM/IW/EW/WV).
//!
//! - the manifest gives the mission, mode, product type, polarisations, swaths, times, orbit, the frame
//!   footprint and the data objects (measurement, annotation, calibration, noise) by their hrefs;
//! - an annotation gives the image size and spacing, the TOPS burst list (azimuth time, the valid lines
//!   and samples of each burst) and the geolocation grid (line, pixel → latitude, longitude, height,
//!   incidence), returned as a regular lines × pixels grid when the points form one;
//! - calibration gives the sigma⁰/beta⁰/gamma/DN look-up vectors (one per line, on a pixel list);
//! - noise gives the range noise vectors and the azimuth noise blocks (IPF 2.9+), or the older single
//!   `noiseVector` list.
//! All XML goes through the hardened reader; numeric lists are bounded.

use crate::xml::{self, Node};
use gw_abi::{Error, Json, Result};

const MAX_LIST: usize = 1 << 22;

fn nums(t: &str) -> Result<Vec<f64>> {
    let mut v = Vec::new();
    for s in t.split_ascii_whitespace() {
        if v.len() >= MAX_LIST {
            return Err(Error::limit("SAFE numeric list too long"));
        }
        v.push(s.parse::<f64>().map_err(|_| gw_abi::err!(INVALID, "SAFE list value ''{value}'' is not a number", value = crate::bytes::printable(s.as_bytes(), 24)))?);
    }
    Ok(v)
}

fn desc<'a>(n: &'a Node, name: &str, out: &mut Vec<&'a Node>, depth: usize) {
    if depth > 40 || out.len() > 10000 {
        return;
    }
    for c in &n.children {
        if c.name == name {
            out.push(c);
        }
        desc(c, name, out, depth + 1);
    }
}
fn all_named<'a>(n: &'a Node, name: &str) -> Vec<&'a Node> {
    let mut v = Vec::new();
    desc(n, name, &mut v, 0);
    v
}
fn first<'a>(n: &'a Node, name: &str) -> Option<&'a Node> {
    all_named(n, name).into_iter().next()
}
fn text<'a>(n: &'a Node, name: &str) -> &'a str {
    first(n, name).map(|x| x.text.trim()).unwrap_or("")
}

fn arr(j: &mut Json, k: &str, v: &[f64]) {
    j.key(k).arr();
    for &x in v {
        j.num(x);
    }
    j.end_arr();
}

/// Seconds since 2000-01-01T00:00:00 of an ISO date and time in UTC (`2024-06-26T13:44:05.435629`,
/// with an optional `UTC=` prefix or `Z` suffix). As an f64 this keeps about 0.1 µs (S-72).
pub fn utc_secs(s: &str) -> Option<f64> {
    let s = s.trim().trim_start_matches("UTC=").trim_end_matches('Z');
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-');
    let (y, mo, da): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let mut t = time.split(':');
    let (hh, mm): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let ss: f64 = t.next()?.parse().ok()?;
    if d.next().is_some() || t.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&da) || !(1000..=9999).contains(&y) || !(0..24).contains(&hh) || !(0..60).contains(&mm) || !(0.0..61.0).contains(&ss) {
        return None;
    }
    // Days from the civil date (H. Hinnant's algorithm), counted from 2000-01-01.
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468 - 10_957;
    Some(days as f64 * 86_400.0 + (hh * 3600 + mm * 60) as f64 + ss)
}

/// The text at a slash-separated path of first children (`position/x`).
fn at<'a>(n: &'a Node, path: &str) -> &'a str {
    let mut cur = n;
    for seg in path.split('/') {
        match first(cur, seg) {
            Some(c) => cur = c,
            None => return "",
        }
    }
    cur.text.trim()
}

fn utc(j: &mut Json, k: &str, s: &str) {
    match utc_secs(s) {
        Some(v) => j.kv_num(k, v),
        None => j.key(k).null(),
    };
}

/// State vectors as { t: [s since 2000], p: [x, y, z, …], v: [vx, vy, vz, …] } (ECEF, m and m/s),
/// skipping any vector with a missing or non-numeric field.
fn state_vectors(j: &mut Json, k: &str, nodes: &[&Node], time: &str, pos: [&str; 3], vel: [&str; 3]) {
    let mut out: Vec<[f64; 7]> = Vec::new();
    for o in nodes.iter().take(100_000) {
        let f = |p: &str| at(o, p).parse::<f64>().ok().filter(|v| v.is_finite());
        let (Some(t), Some(x), Some(y), Some(z), Some(vx), Some(vy), Some(vz)) = (utc_secs(at(o, time)), f(pos[0]), f(pos[1]), f(pos[2]), f(vel[0]), f(vel[1]), f(vel[2])) else { continue };
        out.push([t, x, y, z, vx, vy, vz]);
    }
    j.key(k).obj();
    arr(j, "t", &out.iter().map(|v| v[0]).collect::<Vec<_>>());
    arr(j, "p", &out.iter().flat_map(|v| [v[1], v[2], v[3]]).collect::<Vec<_>>());
    arr(j, "v", &out.iter().flat_map(|v| [v[4], v[5], v[6]]).collect::<Vec<_>>());
    j.end_obj();
}

/// A POEORB or RESORB orbit file (`.EOF`, Earth Explorer XML) → { mission, type, start, stop,
/// orbit: { t, p, v } } with times in seconds since 2000 (UTC) and earth-fixed vectors (REG-085).
pub fn eof(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    if root.name != "Earth_Explorer_File" || first(&root, "List_of_OSVs").is_none() {
        return Err(Error::invalid("not a Sentinel orbit file (no <Earth_Explorer_File>/<List_of_OSVs>)"));
    }
    let frame = text(&root, "Ref_Frame");
    if !frame.is_empty() && frame != "EARTH_FIXED" {
        return Err(gw_abi::err!(INVALID, "the orbit file is in the {frame} frame; an earth-fixed one is needed", frame = crate::bytes::printable(frame.as_bytes(), 24)));
    }
    let mut j = Json::new();
    j.obj();
    j.kv_str("mission", text(&root, "Mission")).kv_str("type", text(&root, "File_Type"));
    utc(&mut j, "start", text(&root, "Validity_Start"));
    utc(&mut j, "stop", text(&root, "Validity_Stop"));
    let osv = all_named(&root, "OSV");
    state_vectors(&mut j, "orbit", &osv, "UTC", ["X", "Y", "Z"], ["VX", "VY", "VZ"]);
    j.end_obj();
    Ok(j.finish())
}

/// `manifest.safe` → product summary and data objects.
pub fn manifest(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    if root.name != "XFDU" {
        return Err(gw_abi::err!(INVALID, "not a SAFE manifest (root <{root}>, not <XFDU>)", root = root.name));
    }
    let mut j = Json::new();
    j.obj();
    j.kv_str("mission", &format!("{}{}", text(&root, "familyName"), text(&root, "number")));
    j.kv_str("mode", text(&root, "mode")).kv_str("productType", text(&root, "productType")).kv_str("productClass", text(&root, "productClass"));
    j.kv_str("start", text(&root, "startTime")).kv_str("stop", text(&root, "stopTime")).kv_str("pass", text(&root, "pass"));
    j.kv_str("orbit", text(&root, "orbitNumber")).kv_str("relativeOrbit", text(&root, "relativeOrbitNumber"));
    j.key("polarisations").arr();
    for p in all_named(&root, "transmitterReceiverPolarisation") {
        j.str(p.text.trim());
    }
    j.end_arr();
    j.key("swaths").arr();
    for s in all_named(&root, "swath") {
        j.str(s.text.trim());
    }
    j.end_arr();
    j.key("footprint").arr();
    if let Some(c) = first(&root, "coordinates") {
        for pt in c.text.split_ascii_whitespace().take(1000) {
            if let Some((a, o)) = pt.split_once(',') {
                if let (Ok(a), Ok(o)) = (a.parse::<f64>(), o.parse::<f64>()) {
                    j.arr().num(a).num(o).end_arr();
                }
            }
        }
    }
    j.end_arr();
    j.key("objects").arr();
    for d in all_named(&root, "dataObject").into_iter().take(2000) {
        let id = d.attr("ID").unwrap_or("");
        let href = first(d, "fileLocation").and_then(|f| f.attr("href")).unwrap_or("");
        let rep = d.attr("repID").unwrap_or("");
        let kind = if rep.contains("Measurement") || href.contains("measurement/") {
            "measurement"
        } else if rep.contains("Calibration") || href.contains("/calibration/calibration-") {
            "calibration"
        } else if rep.contains("Noise") || href.contains("/calibration/noise-") {
            "noise"
        } else if rep.contains("ProductSchema") || (href.contains("annotation/") && !href.contains("/rfi/") && !href.contains("/calibration/")) {
            "annotation"
        } else {
            "other"
        };
        j.obj().kv_str("id", id).kv_str("href", href).kv_str("kind", kind).end_obj();
    }
    j.end_arr();
    j.end_obj();
    Ok(j.finish())
}

/// An annotation XML → size, spacing, bursts and the geolocation grid.
pub fn annotation(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    if root.name != "product" || first(&root, "adsHeader").is_none() {
        return Err(Error::invalid("not a Sentinel-1 product annotation (no <product>/<adsHeader>)"));
    }
    let h = first(&root, "adsHeader").unwrap();
    let num = |n: &Node, k: &str| text(n, k).parse::<f64>().ok();
    let mut j = Json::new();
    j.obj();
    for k in ["missionId", "productType", "polarisation", "mode", "swath", "startTime", "stopTime", "absoluteOrbitNumber", "imageNumber"] {
        j.kv_str(k, text(h, k));
    }
    let info = first(&root, "imageInformation");
    for (k, src) in [("samples", "numberOfSamples"), ("lines", "numberOfLines"), ("rangeSpacing", "rangePixelSpacing"), ("azimuthSpacing", "azimuthPixelSpacing"), ("azimuthTimeInterval", "azimuthTimeInterval"), ("incidenceMid", "incidenceAngleMidSwath"), ("slantRangeTime", "slantRangeTime")] {
        match info.and_then(|i| num(i, src)) {
            Some(v) => j.kv_num(k, v),
            None => j.key(k).null(),
        };
    }
    j.kv_str("pass", text(&root, "pass"));
    match num(&root, "radarFrequency") {
        Some(v) => j.kv_num("radarFrequency", v),
        None => j.key("radarFrequency").null(),
    };
    // For range-Doppler geocoding (REG-085): sampling, line times and the orbit. Times are seconds
    // since 2000 (UTC).
    match first(&root, "productInformation").and_then(|p| num(p, "rangeSamplingRate")) {
        Some(v) => j.kv_num("rangeSamplingRate", v),
        None => j.key("rangeSamplingRate").null(),
    };
    utc(&mut j, "t0", info.map(|i| text(i, "productFirstLineUtcTime")).unwrap_or(""));
    utc(&mut j, "t1", info.map(|i| text(i, "productLastLineUtcTime")).unwrap_or(""));
    let orbit = first(&root, "orbitList").map(|o| all_named(o, "orbit")).unwrap_or_default();
    state_vectors(&mut j, "orbit", &orbit, "time", ["position/x", "position/y", "position/z"], ["velocity/x", "velocity/y", "velocity/z"]);
    // TOPS bursts: each burst's lines, and its valid line and sample ranges.
    let st = first(&root, "swathTiming");
    let lpb = st.and_then(|s| num(s, "linesPerBurst")).unwrap_or(0.0);
    j.kv_num("linesPerBurst", lpb);
    j.key("bursts").arr();
    if let Some(st) = st {
        for (k, bu) in all_named(st, "burst").into_iter().enumerate().take(1000) {
            let fv = nums(text(bu, "firstValidSample"))?;
            let lv = nums(text(bu, "lastValidSample"))?;
            let valid: Vec<usize> = fv.iter().enumerate().filter(|(_, v)| **v >= 0.0).map(|(i, _)| i).collect();
            let first_line = k as f64 * lpb;
            j.obj().kv_str("azimuthTime", text(bu, "azimuthTime")).kv_num("firstLine", first_line).kv_num("lines", lpb);
            utc(&mut j, "t", text(bu, "azimuthTime"));
            match (valid.first(), valid.last()) {
                (Some(&a), Some(&z)) => {
                    let s0 = valid.iter().map(|&i| fv[i]).fold(f64::INFINITY, f64::min);
                    let s1 = valid.iter().filter_map(|&i| lv.get(i)).cloned().fold(f64::NEG_INFINITY, f64::max);
                    j.key("validLines").arr().num(first_line + a as f64).num(first_line + z as f64 + 1.0).end_arr();
                    j.key("validSamples").arr().num(s0).num(s1 + 1.0).end_arr();
                }
                _ => {
                    j.key("validLines").null();
                }
            }
            j.kv_str("burstId", text(bu, "burstId"));
            j.end_obj();
        }
    }
    j.end_arr();
    // The geolocation grid: (line, pixel) points, as a regular grid when they form one.
    let pts: Vec<[f64; 8]> = all_named(&root, "geolocationGridPoint")
        .into_iter()
        .take(100_000)
        .filter_map(|p| {
            let t = utc_secs(text(p, "azimuthTime")).unwrap_or(f64::NAN);
            Some([num(p, "line")?, num(p, "pixel")?, num(p, "latitude")?, num(p, "longitude")?, num(p, "height").unwrap_or(0.0), num(p, "incidenceAngle").unwrap_or(f64::NAN), t, num(p, "slantRangeTime").unwrap_or(f64::NAN)])
        })
        .collect();
    let mut lines: Vec<f64> = pts.iter().map(|p| p[0]).collect();
    let mut pixels: Vec<f64> = pts.iter().map(|p| p[1]).collect();
    lines.sort_by(|a, b| a.total_cmp(b));
    lines.dedup();
    pixels.sort_by(|a, b| a.total_cmp(b));
    pixels.dedup();
    j.key("grid").obj();
    j.kv_num("count", pts.len() as f64);
    if !pts.is_empty() && lines.len() * pixels.len() == pts.len() {
        let mut g = vec![[f64::NAN; 6]; pts.len()];
        for p in &pts {
            let (Ok(r), Ok(c)) = (lines.binary_search_by(|x| x.total_cmp(&p[0])), pixels.binary_search_by(|x| x.total_cmp(&p[1]))) else { continue };
            g[r * pixels.len() + c] = [p[2], p[3], p[4], p[5], p[6], p[7]];
        }
        j.kv_bool("regular", true);
        arr(&mut j, "lines", &lines);
        arr(&mut j, "pixels", &pixels);
        for (k, name) in ["lat", "lon", "height", "incidence", "t", "tau"].iter().enumerate() {
            arr(&mut j, name, &g.iter().map(|v| v[k]).collect::<Vec<_>>());
        }
    } else {
        j.kv_bool("regular", false);
        j.key("points").arr();
        for p in &pts {
            j.arr().num(p[0]).num(p[1]).num(p[2]).num(p[3]).num(p[4]).end_arr();
        }
        j.end_arr();
    }
    j.end_obj();
    j.end_obj();
    Ok(j.finish())
}

/// Calibration XML → {absolute, lines, pixels, sigma, beta, gamma, dn} (vectors on one pixel list).
pub fn calibration(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    if root.name != "calibration" {
        return Err(gw_abi::err!(INVALID, "not a Sentinel-1 calibration annotation (root <{root}>)", root = root.name));
    }
    let vs = all_named(&root, "calibrationVector");
    if vs.is_empty() {
        return Err(Error::invalid("the calibration annotation has no calibrationVector"));
    }
    let pixels = nums(text(vs[0], "pixel"))?;
    let mut lines = Vec::new();
    let mut luts: [Vec<f64>; 4] = Default::default();
    for v in &vs {
        let p = nums(text(v, "pixel"))?;
        if p != pixels {
            return Err(Error::unsupported("calibration vectors on different pixel lists are not read"));
        }
        lines.push(text(v, "line").parse::<f64>().map_err(|_| Error::invalid("calibration vector line is not a number"))?);
        for (k, name) in ["sigmaNought", "betaNought", "gamma", "dn"].iter().enumerate() {
            let l = nums(text(v, name))?;
            if l.len() != pixels.len() {
                return Err(gw_abi::err!(INVALID, "calibration {name} has {values} values for {pixels} pixels", name, values = l.len(), pixels = pixels.len()));
            }
            luts[k].extend(l);
        }
    }
    let mut j = Json::new();
    j.obj();
    match text(&root, "absoluteCalibrationConstant").parse::<f64>() {
        Ok(v) => j.kv_num("absolute", v),
        Err(_) => j.kv_num("absolute", 1.0),
    };
    arr(&mut j, "lines", &lines);
    arr(&mut j, "pixels", &pixels);
    for (k, name) in ["sigma", "beta", "gamma", "dn"].iter().enumerate() {
        arr(&mut j, name, &luts[k]);
    }
    j.end_obj();
    Ok(j.finish())
}

/// Noise XML → {range: [{line, pixels, values}], azimuth: [{lines, values, firstLine, lastLine, firstSample, lastSample}]}.
pub fn noise(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    if root.name != "noise" {
        return Err(gw_abi::err!(INVALID, "not a Sentinel-1 noise annotation (root <{root}>)", root = root.name));
    }
    let mut j = Json::new();
    j.obj();
    j.key("range").arr();
    // IPF 2.9+: noiseRangeVector/noiseRangeLut; earlier: noiseVector/noiseLut.
    let mut rv = all_named(&root, "noiseRangeVector");
    let (lut_name, legacy) = if rv.is_empty() {
        rv = all_named(&root, "noiseVector");
        ("noiseLut", true)
    } else {
        ("noiseRangeLut", false)
    };
    for v in rv.iter().take(5000) {
        let p = nums(text(v, "pixel"))?;
        let l = nums(text(v, lut_name))?;
        if p.len() != l.len() {
            return Err(Error::invalid("a noise range vector's pixels and values differ in length"));
        }
        j.obj().kv_num("line", text(v, "line").parse::<f64>().unwrap_or(f64::NAN));
        arr(&mut j, "pixels", &p);
        arr(&mut j, "values", &l);
        j.end_obj();
    }
    j.end_arr();
    j.kv_bool("legacy", legacy);
    j.key("azimuth").arr();
    for v in all_named(&root, "noiseAzimuthVector").into_iter().take(1000) {
        let l = nums(text(v, "line"))?;
        let a = nums(text(v, "noiseAzimuthLut"))?;
        if l.len() != a.len() {
            return Err(Error::invalid("a noise azimuth vector's lines and values differ in length"));
        }
        j.obj();
        for k in ["firstAzimuthLine", "lastAzimuthLine", "firstRangeSample", "lastRangeSample"] {
            j.kv_num(k, text(v, k).parse::<f64>().unwrap_or(f64::NAN));
        }
        arr(&mut j, "lines", &l);
        arr(&mut j, "values", &a);
        j.end_obj();
    }
    j.end_arr();
    j.end_obj();
    Ok(j.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_grid_bursts_calibration_noise() {
        let a = br#"<?xml version="1.0"?><product><adsHeader><missionId>S1A</missionId><productType>SLC</productType><polarisation>VV</polarisation><mode>IW</mode><swath>IW1</swath><startTime>t0</startTime><stopTime>t1</stopTime></adsHeader><imageAnnotation><imageInformation><numberOfSamples>20</numberOfSamples><numberOfLines>8</numberOfLines><rangePixelSpacing>2.3</rangePixelSpacing></imageInformation></imageAnnotation><swathTiming><linesPerBurst>4</linesPerBurst><burstList count="2"><burst><azimuthTime>a</azimuthTime><firstValidSample count="4">-1 2 2 -1</firstValidSample><lastValidSample count="4">-1 17 18 -1</lastValidSample></burst><burst><azimuthTime>b</azimuthTime><firstValidSample count="4">3 3 3 3</firstValidSample><lastValidSample count="4">15 15 15 15</lastValidSample></burst></burstList></swathTiming><geolocationGrid><geolocationGridPointList count="4"><geolocationGridPoint><line>0</line><pixel>0</pixel><latitude>36</latitude><longitude>-115</longitude><height>600</height></geolocationGridPoint><geolocationGridPoint><line>0</line><pixel>19</pixel><latitude>36.1</latitude><longitude>-115.2</longitude><height>600</height></geolocationGridPoint><geolocationGridPoint><line>7</line><pixel>0</pixel><latitude>35.9</latitude><longitude>-115</longitude><height>600</height></geolocationGridPoint><geolocationGridPoint><line>7</line><pixel>19</pixel><latitude>36</latitude><longitude>-115.2</longitude><height>600</height></geolocationGridPoint></geolocationGridPointList></geolocationGrid></product>"#;
        let s = annotation(a).unwrap();
        assert!(s.contains("\"regular\":true"), "{s}");
        assert!(s.contains("\"validLines\":[1,3]"), "{s}");
        assert!(s.contains("\"validSamples\":[2,19]"), "{s}");
        assert!(s.contains("\"lat\":[36,36.1,35.9,36]"), "{s}");
        let c = br#"<calibration><calibrationInformation><absoluteCalibrationConstant>1</absoluteCalibrationConstant></calibrationInformation><calibrationVectorList count="2"><calibrationVector><line>0</line><pixel count="2">0 19</pixel><sigmaNought count="2">500 510</sigmaNought><betaNought count="2">400 400</betaNought><gamma count="2">450 460</gamma><dn count="2">400 400</dn></calibrationVector><calibrationVector><line>7</line><pixel count="2">0 19</pixel><sigmaNought count="2">501 511</sigmaNought><betaNought count="2">400 400</betaNought><gamma count="2">451 461</gamma><dn count="2">400 400</dn></calibrationVector></calibrationVectorList></calibration>"#;
        let s = calibration(c).unwrap();
        assert!(s.contains("\"sigma\":[500,510,501,511]"), "{s}");
        let n = br#"<noise><noiseRangeVectorList count="1"><noiseRangeVector><line>0</line><pixel count="2">0 19</pixel><noiseRangeLut count="2">1 2</noiseRangeLut></noiseRangeVector></noiseRangeVectorList><noiseAzimuthVectorList count="1"><noiseAzimuthVector><firstAzimuthLine>0</firstAzimuthLine><lastAzimuthLine>7</lastAzimuthLine><firstRangeSample>0</firstRangeSample><lastRangeSample>19</lastRangeSample><line count="2">0 7</line><noiseAzimuthLut count="2">1 1</noiseAzimuthLut></noiseAzimuthVector></noiseAzimuthVectorList></noise>"#;
        let s = noise(n).unwrap();
        assert!(s.contains("\"values\":[1,2]") && s.contains("\"legacy\":false"), "{s}");
        assert!(annotation(b"<calibration/>").is_err());
        assert!(calibration(b"<calibration><calibrationVector><line>0</line><pixel>0 1</pixel><sigmaNought>1</sigmaNought></calibrationVector></calibration>").is_err());
        let m = br#"<XFDU><metadataSection><metadataObject><metadataWrap><xmlData><safe:platform xmlns:safe="x"><safe:familyName>SENTINEL-1</safe:familyName><safe:number>A</safe:number></safe:platform><gml:coordinates xmlns:gml="g">34.6,-114.1 35.0,-116.9</gml:coordinates></xmlData></metadataWrap></metadataObject></metadataSection><dataObjectSection><dataObject ID="s1aiw1" repID="s1Level1MeasurementSchema"><byteStream><fileLocation href="./measurement/a.tiff"/></byteStream></dataObject></dataObjectSection></XFDU>"#;
        let s = manifest(m).unwrap();
        assert!(s.contains("\"kind\":\"measurement\"") && s.contains("[34.6,-114.1]"), "{s}");
    }

    #[test]
    fn utc_seconds_since_2000() {
        assert_eq!(utc_secs("2000-01-01T00:00:00"), Some(0.0));
        assert_eq!(utc_secs("UTC=2000-03-01T00:00:00"), Some(60.0 * 86_400.0)); // 2000 is a leap year
        // 2024-06-26 is day 8943: 24 years with six leap days, then 177 days into 2024.
        let t = utc_secs("2024-06-26T13:44:05.435629").unwrap();
        assert!((t - (8943.0 * 86_400.0 + 49_445.435_629)).abs() < 1e-6, "{t}");
        assert!(utc_secs("1999-12-31T23:59:59Z").unwrap() == -1.0);
        for bad in ["", "2024-06-26", "2024-13-01T00:00:00", "2024-06-26T24:00:00", "2024-06-26T13:44", "x-06-26T13:44:05", "2024-06-26T13:44:05:01"] {
            assert!(utc_secs(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn orbit_file_and_annotation_orbit() {
        let e = br#"<?xml version="1.0"?><Earth_Explorer_File><Earth_Explorer_Header><Fixed_Header><Mission>Sentinel-1A</Mission><File_Type>AUX_POEORB</File_Type><Validity_Period><Validity_Start>UTC=2024-06-25T22:59:42</Validity_Start><Validity_Stop>UTC=2024-06-27T00:59:42</Validity_Stop></Validity_Period></Fixed_Header><Variable_Header><Ref_Frame>EARTH_FIXED</Ref_Frame></Variable_Header></Earth_Explorer_Header><Data_Block type="xml"><List_of_OSVs count="2"><OSV><UTC>UTC=2024-06-25T22:59:42.000000</UTC><X unit="m">1</X><Y unit="m">2</Y><Z unit="m">3</Z><VX unit="m/s">4</VX><VY unit="m/s">5</VY><VZ unit="m/s">6</VZ></OSV><OSV><UTC>UTC=2024-06-25T22:59:52.000000</UTC><X unit="m">7</X><Y unit="m">8</Y><Z unit="m">9</Z><VX unit="m/s">10</VX><VY unit="m/s">11</VY><VZ unit="m/s">x</VZ></OSV></List_of_OSVs></Data_Block></Earth_Explorer_File>"#;
        let s = eof(e).unwrap();
        // The second vector has a non-numeric VZ and is skipped.
        assert!(s.contains("\"p\":[1,2,3]") && s.contains("\"v\":[4,5,6]") && s.contains("\"type\":\"AUX_POEORB\""), "{s}");
        assert!(eof(String::from_utf8_lossy(e).replace("EARTH_FIXED", "INERTIAL").as_bytes()).is_err());
        assert!(eof(b"<product/>").is_err());
        let a = br#"<product><adsHeader><missionId>S1A</missionId></adsHeader><generalAnnotation><productInformation><rangeSamplingRate>6.4e7</rangeSamplingRate><radarFrequency>5.405e9</radarFrequency></productInformation><orbitList count="1"><orbit><time>2024-06-26T13:43:55.000000</time><frame>Earth Fixed</frame><position><x>1</x><y>2</y><z>3</z></position><velocity><x>4</x><y>5</y><z>6</z></velocity></orbit></orbitList></generalAnnotation><imageAnnotation><imageInformation><productFirstLineUtcTime>2024-06-26T13:44:05.5</productFirstLineUtcTime></imageInformation></imageAnnotation></product>"#;
        let s = annotation(a).unwrap();
        assert!(s.contains("\"orbit\":{\"t\":[772724635],\"p\":[1,2,3],\"v\":[4,5,6]}"), "{s}");
        assert!(s.contains("\"rangeSamplingRate\":64000000") && s.contains("\"t0\":772724645.5"), "{s}");
    }
}
