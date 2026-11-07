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
    let pts: Vec<[f64; 6]> = all_named(&root, "geolocationGridPoint")
        .into_iter()
        .take(100_000)
        .filter_map(|p| Some([num(p, "line")?, num(p, "pixel")?, num(p, "latitude")?, num(p, "longitude")?, num(p, "height").unwrap_or(0.0), num(p, "incidenceAngle").unwrap_or(f64::NAN)]))
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
        let mut g = vec![[f64::NAN; 4]; pts.len()];
        for p in &pts {
            let (Ok(r), Ok(c)) = (lines.binary_search_by(|x| x.total_cmp(&p[0])), pixels.binary_search_by(|x| x.total_cmp(&p[1]))) else { continue };
            g[r * pixels.len() + c] = [p[2], p[3], p[4], p[5]];
        }
        j.kv_bool("regular", true);
        arr(&mut j, "lines", &lines);
        arr(&mut j, "pixels", &pixels);
        for (k, name) in ["lat", "lon", "height", "incidence"].iter().enumerate() {
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
}
