//! Sentinel-2 Level-1C granule metadata (`MTD_TL.xml`) → the map + line-of-sight model of
//! `crate::ortholos` (REQ-GAP-20); the datastrip metadata (`MTD_DS.xml`) ephemeris for the
//! validation.
//!
//! MTD_TL gives the tile's map grid (HORIZONTAL_CS_CODE, per resolution NROWS/NCOLS and
//! ULX/ULY/XDIM/YDIM) and, per band and detector, viewing zenith and azimuth grids (5 km nodes,
//! NaN where the detector does not see the node). The first node is taken at the tile's upper-left
//! corner (ULX, ULY). A node seen by two detectors (their overlap) gets the mean of the two lines
//! of sight; the spread between them is the error of that choice and is measured in the
//! validation. The azimuth is read as the azimuth, clockwise from north, of the direction from the
//! ground point to the satellite (established against the MTD_DS ephemeris).
//!
//! The XML is read by a bounded scan for the few elements used, never as a DOM.

use super::odl::{iso_time, numbers};
use gw_abi::{err, Error, Result};

/// Every `<tag …>inner</tag>` (not nested within itself), as (attributes, inner text).
pub(crate) fn elements<'a>(text: &'a str, tag: &str) -> Vec<(&'a str, &'a str)> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(a) = text[i..].find(&open) {
        let s = i + a + open.len();
        let next = text.as_bytes().get(s).copied().unwrap_or(b'>');
        if !(next == b'>' || next == b' ' || next == b'/' || next == b'\t' || next == b'\n' || next == b'\r') {
            i = s;
            continue;
        }
        let Some(g) = text[s..].find('>') else { break };
        let attrs = &text[s..s + g];
        if attrs.ends_with('/') {
            out.push((attrs, ""));
            i = s + g + 1;
            continue;
        }
        let body = s + g + 1;
        let Some(e) = text[body..].find(&close) else { break };
        out.push((attrs, &text[body..body + e]));
        i = body + e + close.len();
        if out.len() > 100_000 {
            break;
        }
    }
    out
}

pub(crate) fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let k = format!("{name}=\"");
    let a = attrs.find(&k)? + k.len();
    let e = attrs[a..].find('"')?;
    Some(&attrs[a..a + e])
}

fn first<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    elements(text, tag).into_iter().next().map(|(_, v)| v.trim())
}

/// sin and cos of an angle in degrees, reduced exactly to ±45° and evaluated by Taylor series to
/// 1e-16 (keeps the general trigonometric range reduction out of the bundle).
pub(crate) fn sincosd(deg: f64) -> (f64, f64) {
    let q = (deg / 90.0).round();
    let r = (deg - 90.0 * q).to_radians();
    let r2 = r * r;
    let (mut s, mut c, mut ts, mut tc) = (r, 1.0, r, 1.0);
    for k in 1..12 {
        let k2 = (2 * k) as f64;
        ts *= -r2 / (k2 * (k2 + 1.0));
        tc *= -r2 / ((k2 - 1.0) * k2);
        s += ts;
        c += tc;
    }
    match (q as i64).rem_euclid(4) {
        0 => (s, c),
        1 => (c, -s),
        2 => (-s, -c),
        _ => (-c, s),
    }
}

/// Band index of a Sentinel-2 band name (B1 … B12, B8A → 0 … 12, the MTD bandId).
pub fn band_index(name: &str) -> Option<usize> {
    const N: [&str; 13] = ["B01", "B02", "B03", "B04", "B05", "B06", "B07", "B08", "B8A", "B09", "B10", "B11", "B12"];
    let n = name.trim().to_ascii_uppercase();
    let n = if n.len() == 2 { format!("B0{}", &n[1..]) } else { n };
    N.iter().position(|b| *b == n)
}

/// The resolution (m) of a band index.
pub fn band_resolution(b: usize) -> f64 {
    match b {
        1 | 2 | 3 | 7 => 10.0,
        0 | 9 | 10 => 60.0,
        _ => 20.0,
    }
}

pub struct Granule {
    pub epsg: i32,
    pub ulx: f64,
    pub uly: f64,
    /// Per band (0 … 12): per detector, (zenith, azimuth) node grids, each rows × cols, and the
    /// node spacing (m).
    pub grids: Vec<(usize, usize, Vec<f64>, Vec<f64>, usize, usize, f64, f64)>,
    /// Sizes per resolution: (resolution, rows, cols).
    pub sizes: Vec<(f64, f64, f64)>,
}

pub fn parse_mtd_tl(text: &str) -> Result<Granule> {
    let code = first(text, "HORIZONTAL_CS_CODE").ok_or_else(|| Error::invalid("MTD_TL: HORIZONTAL_CS_CODE is missing (not a Sentinel-2 L1C/L2A granule file)"))?;
    let epsg: i32 = code.trim_start_matches("EPSG:").parse().map_err(|_| Error::invalid("MTD_TL: HORIZONTAL_CS_CODE is not EPSG:n"))?;
    let mut sizes = Vec::new();
    for (a, v) in elements(text, "Size") {
        let r: f64 = attr(a, "resolution").and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let rows = first(v, "NROWS").and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let cols = first(v, "NCOLS").and_then(|s| s.parse().ok()).unwrap_or(0.0);
        if r > 0.0 && rows > 0.0 && cols > 0.0 {
            sizes.push((r, rows, cols));
        }
    }
    let geo = elements(text, "Geoposition");
    let (_, g10) = geo.first().ok_or_else(|| Error::invalid("MTD_TL: no Geoposition"))?;
    let ulx: f64 = first(g10, "ULX").and_then(|s| s.parse().ok()).ok_or_else(|| Error::invalid("MTD_TL: ULX is missing"))?;
    let uly: f64 = first(g10, "ULY").and_then(|s| s.parse().ok()).ok_or_else(|| Error::invalid("MTD_TL: ULY is missing"))?;
    let mut grids = Vec::new();
    for (a, v) in elements(text, "Viewing_Incidence_Angles_Grids") {
        let band: usize = attr(a, "bandId").and_then(|s| s.parse().ok()).ok_or_else(|| Error::invalid("MTD_TL: a viewing grid has no bandId"))?;
        let det: usize = attr(a, "detectorId").and_then(|s| s.parse().ok()).ok_or_else(|| Error::invalid("MTD_TL: a viewing grid has no detectorId"))?;
        let read = |tag: &str| -> Result<(Vec<f64>, usize, usize, f64, f64)> {
            let z = first(v, tag).ok_or_else(|| err!(INVALID, "MTD_TL: a viewing grid has no {tag}", tag = tag.to_string()))?;
            let cs: f64 = first(z, "COL_STEP").and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            let rs: f64 = first(z, "ROW_STEP").and_then(|s| s.parse().ok()).unwrap_or(f64::NAN);
            let rows: Vec<Vec<f64>> = elements(z, "VALUES").iter().map(|(_, r)| r.split_whitespace().map(|t| t.parse::<f64>().unwrap_or(f64::NAN)).collect()).collect();
            let nr = rows.len();
            let nc = rows.first().map(|r| r.len()).unwrap_or(0);
            if nr < 2 || nc < 2 || rows.iter().any(|r| r.len() != nc) || !(cs > 0.0 && rs > 0.0) {
                return Err(Error::invalid("MTD_TL: a viewing grid is not a rectangular grid with positive steps"));
            }
            Ok((rows.concat(), nr, nc, cs, rs))
        };
        let (zen, nr, nc, cs, rs) = read("Zenith")?;
        let (azi, nr2, nc2, _, _) = read("Azimuth")?;
        if nr2 != nr || nc2 != nc {
            return Err(Error::invalid("MTD_TL: zenith and azimuth grids differ in size"));
        }
        grids.push((band, det, zen, azi, nr, nc, cs, rs));
    }
    if grids.is_empty() {
        return Err(Error::invalid("MTD_TL: no viewing incidence angle grids"));
    }
    Ok(Granule { epsg, ulx, uly, grids, sizes })
}

impl Granule {
    /// Per node of `band`'s grid: the unit line of sight of each detector that sees it.
    pub fn node_vectors(&self, band: usize) -> Result<(usize, usize, f64, Vec<Vec<[f64; 3]>>)> {
        let gs: Vec<_> = self.grids.iter().filter(|g| g.0 == band).collect();
        let g0 = gs.first().ok_or_else(|| err!(INVALID, "MTD_TL: no viewing grid for band {b}", b = band.to_string()))?;
        let (nr, nc, step) = (g0.4, g0.5, g0.6);
        let mut out = vec![Vec::new(); nr * nc];
        for g in &gs {
            if g.4 != nr || g.5 != nc || g.6 != step {
                return Err(Error::invalid("MTD_TL: the detectors' viewing grids differ in size"));
            }
            for k in 0..nr * nc {
                let (z, a) = (g.2[k], g.3[k]);
                if z.is_finite() && a.is_finite() && (0.0..80.0).contains(&z) {
                    let ((sz, cz), (sa, ca)) = (sincosd(z), sincosd(a));
                    out[k].push([sz * sa, sz * ca, cz]);
                }
            }
        }
        Ok((nr, nc, step, out))
    }
}

/// The map + line-of-sight record (`crate::ortholos`) of one band at the band's resolution: one
/// node per angle-grid node (the first at the tile's upper-left corner), the mean of the detectors
/// at each node, nodes no detector sees filled from the nearest seen node.
pub fn ortholos_record(g: &Granule, band: usize, href: f64) -> Result<Vec<f64>> {
    let res = band_resolution(band);
    let (nr, nc, step, v) = g.node_vectors(band)?;
    let mean: Vec<Option<[f64; 3]>> = v
        .iter()
        .map(|d| {
            if d.is_empty() {
                return None;
            }
            let mut s = [0.0; 3];
            for u in d {
                for c in 0..3 {
                    s[c] += u[c];
                }
            }
            let n = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
            Some([s[0] / n, s[1] / n, s[2] / n])
        })
        .collect();
    let filled = super::landsat::fill(&mean, nc, nr).ok_or_else(|| Error::invalid("MTD_TL: no node of the viewing grid is seen by a detector"))?;
    let px = step / res;
    let mut r = vec![g.ulx, res, 0.0, g.uly, 0.0, -res, g.epsg as f64, nc as f64, nr as f64, 0.0, 0.0, px, px];
    for u in filled {
        r.extend_from_slice(&[u[0], u[1], u[2], href]);
    }
    Ok(r)
}

/// MTD_DS GPS ephemeris: (GPS time as seconds from midnight of `day0`, ECEF position m).
pub fn ds_ephemeris(text: &str, day0: i64) -> Vec<(f64, [f64; 3])> {
    let mut out = Vec::new();
    for (_, p) in elements(text, "GPS_Point") {
        let pos = first(p, "POSITION_VALUES").map(numbers).unwrap_or_default();
        let t = first(p, "GPS_TIME").and_then(iso_time);
        if let (3, Some((d, s))) = (pos.len(), t) {
            out.push((s + 86400.0 * (d - day0) as f64, [pos[0] / 1000.0, pos[1] / 1000.0, pos[2] / 1000.0]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn sincosd_matches_std() {
        let mut w = 0f64;
        for i in -7200..=7200 {
            let d = i as f64 * 0.1 + 0.0123;
            let (s, c) = super::sincosd(d);
            w = w.max((s - d.to_radians().sin()).abs()).max((c - d.to_radians().cos()).abs());
        }
        assert!(w < 1e-14, "{w}");
    }
}
