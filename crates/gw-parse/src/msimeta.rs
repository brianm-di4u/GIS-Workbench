//! Radiometric metadata for DN → radiance → reflectance (REQ-MSI-05, REQ-MSI-14,
//! `Research/10` §6): Landsat Collection 2 MTL text (Level-1 and Level-2), Sentinel-2 MTD XML
//! (L1C RADIO_ADD_OFFSET or L2A BOA_ADD_OFFSET with the quantification value) and Maxar
//! WorldView IMD text (absCalFactor, effectiveBandwidth, sun elevation). Nothing is hard-coded
//! from the sensor except WorldView's published gain/offset/ESUN table, which the caller applies.

use crate::xml;
use gw_abi::{Error, Json, Result};
use std::collections::BTreeMap;

fn kv_text(s: &str, sep: char) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for line in s.lines().take(200_000) {
        if let Some(i) = line.find(sep) {
            let k = line[..i].trim().to_string();
            let v = line[i + 1..].trim().trim_end_matches(';').trim().trim_matches('"').to_string();
            if !k.is_empty() {
                m.entry(k).or_insert(v);
            }
        }
    }
    m
}

fn num(m: &BTreeMap<String, String>, k: &str) -> f64 {
    m.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(f64::NAN)
}

/// Landsat MTL (Collection 2): per-band multiplicative/additive radiance and reflectance
/// rescaling, thermal K1/K2, sun angles and the Earth–Sun distance.
pub fn landsat_mtl(b: &[u8]) -> Result<String> {
    let s = String::from_utf8_lossy(b);
    if !s.contains("LANDSAT_METADATA_FILE") && !s.contains("L1_METADATA_FILE") && !s.contains("SPACECRAFT_ID") {
        return Err(Error::invalid("not a Landsat MTL file"));
    }
    let m = kv_text(&s, '=');
    let level = m.get("PROCESSING_LEVEL").cloned().unwrap_or_default();
    let mut j = Json::new();
    j.obj().kv_str("sensor", "landsat").kv_str("spacecraft", m.get("SPACECRAFT_ID").map(String::as_str).unwrap_or("")).kv_str("level", &level);
    j.kv_num("sunElevation", num(&m, "SUN_ELEVATION")).kv_num("sunAzimuth", num(&m, "SUN_AZIMUTH")).kv_num("earthSunDistance", num(&m, "EARTH_SUN_DISTANCE"));
    j.kv_str("date", m.get("DATE_ACQUIRED").map(String::as_str).unwrap_or(""));
    j.key("bands").arr();
    for k in 1..=11 {
        let g = |p: &str| num(&m, &format!("{p}_BAND_{k}"));
        let (rm, ra, fm, fa, k1, k2) = (g("RADIANCE_MULT"), g("RADIANCE_ADD"), g("REFLECTANCE_MULT"), g("REFLECTANCE_ADD"), g("K1_CONSTANT"), g("K2_CONSTANT"));
        // Level-2 science products publish their own scale factors per band.
        let (sm, sa) = (g("REFLECTANCE_MULT"), g("REFLECTANCE_ADD"));
        if [rm, ra, fm, fa, k1, k2, sm, sa].iter().all(|v| !v.is_finite()) {
            continue;
        }
        j.obj().kv_int("band", k as i64);
        for (n, v) in [("radMult", rm), ("radAdd", ra), ("reflMult", fm), ("reflAdd", fa), ("k1", k1), ("k2", k2)] {
            j.kv_num(n, v);
        }
        j.end_obj();
    }
    j.end_arr();
    // Collection 2 Level-2 surface reflectance and temperature scaling (USGS, constant).
    if level.starts_with("L2") {
        j.key("level2").obj().kv_num("srMult", 2.75e-5).kv_num("srAdd", -0.2).kv_num("stMult", 0.003_418_02).kv_num("stAdd", 149.0).end_obj();
    }
    j.end_obj();
    Ok(j.finish())
}

/// Sentinel-2 MTD_MSIL1C/MSIL2A XML: quantification value, per-band additive offsets (baseline
/// 04.00 and later), U and the solar irradiance list.
pub fn sentinel2_mtd(b: &[u8]) -> Result<String> {
    let root = xml::parse(b)?;
    let find_all = |n: &xml::Node, name: &str, out: &mut Vec<xml::Node>| {
        fn walk(n: &xml::Node, name: &str, out: &mut Vec<xml::Node>, depth: usize) {
            if depth > 32 {
                return;
            }
            for c in &n.children {
                if c.name == name {
                    out.push(c.clone());
                }
                walk(c, name, out, depth + 1);
            }
        }
        walk(n, name, out, 0);
    };
    let first = |name: &str| -> Option<String> {
        let mut v = Vec::new();
        find_all(&root, name, &mut v);
        v.first().map(|n| n.text.trim().to_string())
    };
    let pbl = first("PROCESSING_BASELINE").unwrap_or_default();
    let level = first("PROCESSING_LEVEL").or_else(|| first("PRODUCT_TYPE")).unwrap_or_default();
    let l2 = level.contains("2A") || first("BOA_QUANTIFICATION_VALUE").is_some();
    let q = if l2 { first("BOA_QUANTIFICATION_VALUE") } else { first("QUANTIFICATION_VALUE") }.and_then(|v| v.parse::<f64>().ok()).unwrap_or(10000.0);
    let mut offs = Vec::new();
    find_all(&root, if l2 { "BOA_ADD_OFFSET" } else { "RADIO_ADD_OFFSET" }, &mut offs);
    let mut irr = Vec::new();
    find_all(&root, "SOLAR_IRRADIANCE", &mut irr);
    let u = first("U").and_then(|v| v.parse::<f64>().ok()).unwrap_or(f64::NAN);
    let mut j = Json::new();
    j.obj().kv_str("sensor", "sentinel2").kv_str("level", if l2 { "L2A" } else { "L1C" }).kv_str("baseline", &pbl).kv_num("quantification", q).kv_num("u", u);
    j.key("bands").arr();
    // band_id 0 … 12 = B1 … B12 with B8A at 8.
    for id in 0..13 {
        let off = offs.iter().find(|n| n.attr("band_id").map(str::trim) == Some(&id.to_string()[..])).and_then(|n| n.value()).unwrap_or(0.0);
        let e = irr.iter().find(|n| n.attr("bandId").map(str::trim) == Some(&id.to_string()[..])).and_then(|n| n.value()).unwrap_or(f64::NAN);
        j.obj().kv_int("bandId", id).kv_num("offset", off).kv_num("esun", e).end_obj();
    }
    j.end_arr().end_obj();
    Ok(j.finish())
}

/// WorldView IMD: per-band absCalFactor and effectiveBandwidth, sun elevation/azimuth, time.
pub fn worldview_imd(b: &[u8]) -> Result<String> {
    let s = String::from_utf8_lossy(b);
    if !s.contains("BEGIN_GROUP = BAND_") {
        return Err(Error::invalid("not a WorldView IMD file"));
    }
    let mut j = Json::new();
    let top = kv_text(&s, '=');
    j.obj().kv_str("sensor", "worldview").kv_str("satId", top.get("satId").map(String::as_str).unwrap_or(""));
    j.kv_num("sunElevation", num(&top, "meanSunEl")).kv_num("sunAzimuth", num(&top, "meanSunAz"));
    j.kv_str("time", top.get("firstLineTime").or(top.get("earliestAcqTime")).map(String::as_str).unwrap_or(""));
    j.key("bands").arr();
    let mut rest = &s[..];
    let mut n = 0;
    while let Some(i) = rest.find("BEGIN_GROUP = BAND_") {
        let r = &rest[i + 19..];
        let name: String = r.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        let end = r.find("END_GROUP").unwrap_or(r.len());
        let m = kv_text(&r[..end], '=');
        j.obj().kv_str("band", &name).kv_num("absCalFactor", num(&m, "absCalFactor")).kv_num("effectiveBandwidth", num(&m, "effectiveBandwidth")).end_obj();
        rest = &r[end..];
        n += 1;
        if n > 64 {
            break;
        }
    }
    j.end_arr().end_obj();
    Ok(j.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mtl_imd_and_mtd() {
        let mtl = b"GROUP = LANDSAT_METADATA_FILE\n SPACECRAFT_ID = \"LANDSAT_8\"\n PROCESSING_LEVEL = \"L1TP\"\n SUN_ELEVATION = 55.5\n RADIANCE_MULT_BAND_4 = 9.6476E-03\n RADIANCE_ADD_BAND_4 = -48.23801\n REFLECTANCE_MULT_BAND_4 = 2.0000E-05\n REFLECTANCE_ADD_BAND_4 = -0.100000\n K1_CONSTANT_BAND_10 = 774.8853\n K2_CONSTANT_BAND_10 = 1321.0789\n";
        let j = landsat_mtl(mtl).unwrap();
        assert!(j.contains("\"reflMult\":0.00002") && j.contains("\"k1\":774.8853"), "{j}");
        let imd = b"satId = \"WV03\";\nmeanSunEl = 61.2;\nBEGIN_GROUP = BAND_R\n absCalFactor = 1.3e-02;\n effectiveBandwidth = 5.85e-02;\nEND_GROUP = BAND_R\n";
        assert!(worldview_imd(imd).unwrap().contains("\"absCalFactor\":0.013"));
        let mtd = br#"<n1:Level-2A_User_Product xmlns:n1="x"><General_Info><Product_Info><PROCESSING_BASELINE>05.09</PROCESSING_BASELINE><PROCESSING_LEVEL>Level-2A</PROCESSING_LEVEL></Product_Info><Product_Image_Characteristics><QUANTIFICATION_VALUES_LIST><BOA_QUANTIFICATION_VALUE unit="none">10000</BOA_QUANTIFICATION_VALUE></QUANTIFICATION_VALUES_LIST><BOA_ADD_OFFSET_VALUES_LIST><BOA_ADD_OFFSET band_id="3">-1000</BOA_ADD_OFFSET></BOA_ADD_OFFSET_VALUES_LIST></Product_Image_Characteristics></General_Info></n1:Level-2A_User_Product>"#;
        let j = sentinel2_mtd(mtd).unwrap();
        assert!(j.contains("\"level\":\"L2A\"") && j.contains("{\"bandId\":3,\"offset\":-1000"), "{j}");
    }
}
