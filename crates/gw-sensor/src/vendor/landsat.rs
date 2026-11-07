//! Landsat 8/9 Collection 1 and 2 Level-1 angle coefficient files (`*_ANG.txt`), and the MTL map
//! grid, → the map + line-of-sight model of `crate::ortholos` (REQ-GAP-20).
//!
//! The ANG file gives, per band and per sensor chip assembly (SCA), a rational map from the L1T
//! (map grid) line/sample and height to the L1R (raw) line/sample, and per band a rational
//! polynomial of the satellite viewing vector (local east, north, up toward the satellite) in L1T
//! and L1R coordinates and height. The evaluation below follows the USGS public-domain Landsat
//! angle tool (`l8_angles`, `ias_angle_gen_find_scas.c` and `ias_angle_gen_calculate_angles_rpc.c`,
//! read for the term order): the L1T point is tried on the SCAs from the middle outwards; a point
//! in the overlap of two SCAs gets the mean of their two vectors. L1T line/sample 0 is the first
//! pixel's centre. The ANG PROJECTION corners are pixel centres of the 30 m grid.
//!
//! The ANG file also carries the ephemeris (ECEF, 1 s) used for the consistency check in the
//! validation, not by the model.

use super::odl::Odl;
use gw_abi::{err, Error, Result};

#[derive(Clone, Debug)]
struct ScaTerms {
    mean_h: f64,
    l1r: [f64; 2],
    l1t: [f64; 2],
    line_num: [f64; 5],
    line_den: [f64; 4],
    samp_num: [f64; 5],
    samp_den: [f64; 4],
}

#[derive(Clone, Debug)]
pub struct AngBand {
    pub band: u32,
    pub l1t_lines: f64,
    pub l1t_samps: f64,
    pub pixel_size: f64,
    l1r_lines: f64,
    l1r_samps: f64,
    mean_h: f64,
    mean_l1r: [f64; 2],
    mean_l1t: [f64; 2],
    mean_vec: [f64; 3],
    num: [[f64; 10]; 3],
    den: [[f64; 9]; 3],
    scas: Vec<ScaTerms>,
}

#[derive(Clone, Debug)]
pub struct Ang {
    pub utm_zone: i32,
    /// Upper-left pixel centre of the 30 m grid (E, N).
    pub ul: [f64; 2],
    pub bands: Vec<AngBand>,
    /// Ephemeris: epoch (year, day of year, seconds of day) and (t, x, y, z) ECEF.
    pub epoch: (i64, i64, f64),
    pub eph: Vec<[f64; 4]>,
}

fn fixed<const N: usize>(v: Option<Vec<f64>>, what: &str) -> Result<[f64; N]> {
    let v = v.ok_or_else(|| err!(INVALID, "ANG: {what} is missing", what = what.to_string()))?;
    v.try_into().map_err(|_| err!(INVALID, "ANG: {what} does not have {n} values", what = what.to_string(), n = N.to_string()))
}

impl Ang {
    pub fn parse(text: &str) -> Result<Ang> {
        let o = Odl::parse(text);
        if o.get("FILE_HEADER", "SPACECRAFT_ID").is_none() || o.get("PROJECTION", "UL_CORNER").is_none() {
            return Err(Error::invalid("not a Landsat angle coefficient (ANG) file"));
        }
        if o.get("PROJECTION", "MAP_PROJECTION") != Some("UTM") {
            return Err(Error::unsupported("ANG: only UTM products are read (polar-stereographic scenes are not)"));
        }
        let zone = o.num("PROJECTION", "UTM_ZONE").ok_or_else(|| Error::invalid("ANG: UTM_ZONE is missing"))? as i32;
        if !(-60..=60).contains(&zone) || zone == 0 {
            return Err(Error::invalid("ANG: UTM_ZONE is out of range"));
        }
        let ul: [f64; 2] = fixed(o.nums("PROJECTION", "UL_CORNER"), "UL_CORNER")?;
        let mut bands = Vec::new();
        let heads: Vec<(String, String)> = o.entries.iter().filter(|e| e.key.starts_with("BAND") && e.key.ends_with("_NUM_L1T_LINES")).map(|e| (e.group.clone(), e.key.clone())).collect();
        for (g, key) in &heads {
            let g = g.as_str();
            let prefix = key.trim_end_matches("NUM_L1T_LINES").to_string();
            let band: u32 = prefix.trim_start_matches("BAND").trim_end_matches('_').parse().map_err(|_| Error::invalid("ANG: a band group has no band number"))?;
            if bands.iter().any(|b: &AngBand| b.band == band) {
                continue;
            }
            let k = |s: &str| format!("{prefix}{s}");
            let n = |s: &str| o.num(g, &k(s)).ok_or_else(|| err!(INVALID, "ANG: {key} is missing", key = k(s)));
            let nsca = n("NUMBER_OF_SCAS")? as usize;
            if !(1..=32).contains(&nsca) {
                return Err(Error::invalid("ANG: NUMBER_OF_SCAS is out of range"));
            }
            let mut scas = Vec::with_capacity(nsca);
            for s in 1..=nsca {
                let p = format!("{prefix}SCA{s:02}_");
                let f = |x: &str| o.nums(g, &format!("{p}{x}"));
                scas.push(ScaTerms {
                    mean_h: fixed::<1>(f("MEAN_HEIGHT"), "SCA MEAN_HEIGHT")?[0],
                    l1r: fixed(f("MEAN_L1R_LINE_SAMP"), "SCA MEAN_L1R_LINE_SAMP")?,
                    l1t: fixed(f("MEAN_L1T_LINE_SAMP"), "SCA MEAN_L1T_LINE_SAMP")?,
                    line_num: fixed(f("LINE_NUM_COEF"), "SCA LINE_NUM_COEF")?,
                    line_den: fixed(f("LINE_DEN_COEF"), "SCA LINE_DEN_COEF")?,
                    samp_num: fixed(f("SAMP_NUM_COEF"), "SCA SAMP_NUM_COEF")?,
                    samp_den: fixed(f("SAMP_DEN_COEF"), "SCA SAMP_DEN_COEF")?,
                });
            }
            let v = |a: &str| o.nums(g, &k(a));
            let b = AngBand {
                band,
                l1t_lines: n("NUM_L1T_LINES")?,
                l1t_samps: n("NUM_L1T_SAMPS")?,
                pixel_size: n("PIXEL_SIZE")?,
                l1r_lines: n("NUM_L1R_LINES")?,
                l1r_samps: n("NUM_L1R_SAMPS")?,
                mean_h: n("MEAN_HEIGHT")?,
                mean_l1r: fixed(v("MEAN_L1R_LINE_SAMP"), "MEAN_L1R_LINE_SAMP")?,
                mean_l1t: fixed(v("MEAN_L1T_LINE_SAMP"), "MEAN_L1T_LINE_SAMP")?,
                mean_vec: fixed(v("MEAN_SAT_VECTOR"), "MEAN_SAT_VECTOR")?,
                num: [fixed(v("SAT_X_NUM_COEF"), "SAT_X_NUM_COEF")?, fixed(v("SAT_Y_NUM_COEF"), "SAT_Y_NUM_COEF")?, fixed(v("SAT_Z_NUM_COEF"), "SAT_Z_NUM_COEF")?],
                den: [fixed(v("SAT_X_DEN_COEF"), "SAT_X_DEN_COEF")?, fixed(v("SAT_Y_DEN_COEF"), "SAT_Y_DEN_COEF")?, fixed(v("SAT_Z_DEN_COEF"), "SAT_Z_DEN_COEF")?],
                scas,
            };
            if !(b.l1t_lines >= 2.0 && b.l1t_samps >= 2.0 && b.pixel_size > 0.0 && b.l1r_samps >= 2.0 && b.l1r_lines >= 1.0) {
                return Err(Error::invalid("ANG: a band's image size is not valid"));
            }
            bands.push(b);
        }
        if bands.is_empty() {
            return Err(Error::invalid("ANG: no band coefficients"));
        }
        let epoch = (o.num("EPHEMERIS", "EPHEMERIS_EPOCH_YEAR").unwrap_or(0.0) as i64, o.num("EPHEMERIS", "EPHEMERIS_EPOCH_DAY").unwrap_or(0.0) as i64, o.num("EPHEMERIS", "EPHEMERIS_EPOCH_SECONDS").unwrap_or(0.0));
        let (t, x, y, z) = (o.nums("EPHEMERIS", "EPHEMERIS_TIME").unwrap_or_default(), o.nums("EPHEMERIS", "EPHEMERIS_ECEF_X").unwrap_or_default(), o.nums("EPHEMERIS", "EPHEMERIS_ECEF_Y").unwrap_or_default(), o.nums("EPHEMERIS", "EPHEMERIS_ECEF_Z").unwrap_or_default());
        let n = t.len().min(x.len()).min(y.len()).min(z.len());
        let eph = (0..n).map(|i| [t[i], x[i], y[i], z[i]]).collect();
        Ok(Ang { utm_zone: zone, ul, bands, epoch, eph })
    }

    pub fn band(&self, band: u32) -> Result<&AngBand> {
        self.bands.iter().find(|b| b.band == band).ok_or_else(|| err!(INVALID, "ANG: no coefficients for band {b}", b = band.to_string()))
    }

    /// EPSG code of the map grid (WGS 84 / UTM; a negative zone is the southern hemisphere).
    pub fn epsg(&self) -> i32 {
        if self.utm_zone > 0 {
            32600 + self.utm_zone
        } else {
            32700 - self.utm_zone
        }
    }

    /// The band's geotransform (corner origin; the ANG corners are pixel centres of the 30 m
    /// grid).
    pub fn geotransform(&self, b: &AngBand) -> [f64; 6] {
        let p = b.pixel_size;
        let (cx, cy) = (self.ul[0] - 15.0, self.ul[1] + 15.0);
        [cx, p, 0.0, cy, 0.0, -p]
    }
}

impl AngBand {
    /// The L1R (line, band-wide sample) of every SCA that sees the L1T point, as the USGS tool
    /// finds them (at most two).
    fn find_scas(&self, line: f64, samp: f64, h: Option<f64>) -> Vec<(f64, f64)> {
        let mut out = Vec::new();
        let n = self.scas.len() as isize;
        let mut k = n / 2;
        let mut tested = 0;
        let ns = self.l1r_samps;
        for _ in 0..(2 * n + 4) {
            if k < 0 || k >= n {
                break;
            }
            let s = &self.scas[k as usize];
            let (lo, so) = (line - s.l1t[0], samp - s.l1t[1]);
            let ho = h.map(|h| h - s.mean_h).unwrap_or(0.0);
            let t = [1.0, lo, so, ho, lo * so];
            let rat = |nu: &[f64; 5], de: &[f64; 4]| (0..5).map(|i| nu[i] * t[i]).sum::<f64>() / (1.0 + (0..4).map(|i| de[i] * t[i + 1]).sum::<f64>());
            let rl = rat(&s.line_num, &s.line_den) + s.l1r[0];
            let rs = rat(&s.samp_num, &s.samp_den) + s.l1r[1];
            if !(rl.is_finite() && rs.is_finite()) {
                break;
            }
            if rs >= 0.0 && rs <= ns - 1.0 {
                tested += 1;
                if rl >= 0.0 && rl < self.l1r_lines {
                    out.push((rl, rs + k as f64 * ns));
                }
                if tested > 1 {
                    break;
                }
                // The overlap width of the USGS tool (SCA_OVERLAP) is 50 samples.
                if rs < 50.0 {
                    k -= 1;
                } else if rs > ns - 50.0 {
                    k += 1;
                } else {
                    break;
                }
            } else {
                if tested > 0 || (k == 0 && rs < 0.0) || (k == n - 1 && rs > ns - 1.0) {
                    break;
                }
                let full = rs + k as f64 * ns;
                let next = if rs < 0.0 { (full / ns) as isize } else { ((full + 1.0) / ns) as isize };
                let next = next.clamp(0, n - 1);
                if next == k {
                    break;
                }
                k = next;
            }
        }
        out
    }

    /// Unit vectors toward the satellite (east, north, up), one per SCA that sees L1T (line, sample)
    /// (0 = the first pixel's centre; two in an SCA overlap, none outside the active image), at
    /// height h (m; None = the band's mean height and no height offset in the SCA search, as the USGS
    /// tool without a DEM).
    pub fn sat_vectors(&self, line: f64, samp: f64, h: Option<f64>) -> Vec<[f64; 3]> {
        let (lt, st) = (line - self.mean_l1t[0], samp - self.mean_l1t[1]);
        let hh = h.unwrap_or(self.mean_h) - self.mean_h;
        let mut out = Vec::new();
        for (rl, rs) in self.find_scas(line, samp, h) {
            let (lr, sr) = (rl - self.mean_l1r[0], rs - self.mean_l1r[1]);
            let t = [1.0, lt, st, hh, lr, lt * lt, st * lt, st * st, sr * lr * lr, lr * lr * lr];
            let mut v = [0.0; 3];
            for c in 0..3 {
                let num: f64 = (0..10).map(|i| self.num[c][i] * t[i]).sum();
                let den = 1.0 + (0..9).map(|i| self.den[c][i] * t[i + 1]).sum::<f64>();
                v[c] = self.mean_vec[c] + num / den;
            }
            let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
            if n > 0.0 && v[2] / n > 0.17 {
                out.push([v[0] / n, v[1] / n, v[2] / n]);
            }
        }
        out
    }

    /// The line of sight the model uses: the SCA's, or in an SCA overlap the normalised mean of the
    /// two (the pixel came from one of them; which one the L1T product used is not in the ANG file).
    /// The USGS tool averages zenith and azimuth instead, which near nadir is not a direction between
    /// the two.
    pub fn sat_vector(&self, line: f64, samp: f64, h: Option<f64>) -> Option<[f64; 3]> {
        let v = self.sat_vectors(line, samp, h);
        if v.is_empty() {
            return None;
        }
        let mut s = [0.0; 3];
        for u in &v {
            for c in 0..3 {
                s[c] += u[c];
            }
        }
        let n = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
        Some([s[0] / n, s[1] / n, s[2] / n])
    }
}

/// The map + line-of-sight record (`crate::ortholos`) of one band: nodes every `step` pixels, the
/// line of sight at the reference height `href` (constant), nodes outside the active image filled
/// from the nearest active node of the same row, then column.
pub fn ortholos_record(ang: &Ang, band: u32, step: f64, href: f64) -> Result<Vec<f64>> {
    let b = ang.band(band)?;
    if !(step >= 4.0) {
        return Err(Error::invalid("ANG: the grid step must be at least 4 pixels"));
    }
    let nx = ((b.l1t_samps / step).ceil() as usize + 1).max(2);
    let ny = ((b.l1t_lines / step).ceil() as usize + 1).max(2);
    if nx * ny > 1 << 18 {
        return Err(Error::limit("ANG: the line-of-sight grid would be too large"));
    }
    let mut v: Vec<Option<[f64; 3]>> = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        for i in 0..nx {
            let (x, y) = (i as f64 * step, j as f64 * step);
            // Image (x, y) corner-origin → L1T (line, sample) centre-origin.
            v.push(b.sat_vector(y - 0.5, x - 0.5, Some(href)));
        }
    }
    let filled = fill(&v, nx, ny).ok_or_else(|| Error::invalid("ANG: no point of the band's grid is inside the active image"))?;
    let mut r = ang.geotransform(b).to_vec();
    r.extend_from_slice(&[ang.epsg() as f64, nx as f64, ny as f64, 0.0, 0.0, step, step]);
    for u in filled {
        r.extend_from_slice(&[u[0], u[1], u[2], href]);
    }
    Ok(r)
}

/// Fill missing nodes from the nearest present node of the row, then of the column.
pub(crate) fn fill(v: &[Option<[f64; 3]>], nx: usize, ny: usize) -> Option<Vec<[f64; 3]>> {
    let mut g: Vec<Option<[f64; 3]>> = v.to_vec();
    for j in 0..ny {
        let row: Vec<usize> = (0..nx).filter(|&i| g[j * nx + i].is_some()).collect();
        if row.is_empty() {
            continue;
        }
        for i in 0..nx {
            if g[j * nx + i].is_none() {
                let k = *row.iter().min_by_key(|&&k| (k as isize - i as isize).unsigned_abs()).unwrap();
                g[j * nx + i] = g[j * nx + k];
            }
        }
    }
    for i in 0..nx {
        let col: Vec<usize> = (0..ny).filter(|&j| g[j * nx + i].is_some()).collect();
        if col.is_empty() {
            return None;
        }
        for j in 0..ny {
            if g[j * nx + i].is_none() {
                let k = *col.iter().min_by_key(|&&k| (k as isize - j as isize).unsigned_abs()).unwrap();
                g[j * nx + i] = g[k * nx + i];
            }
        }
    }
    Some(g.into_iter().map(|x| x.unwrap()).collect())
}

/// Landsat MTL (`*_MTL.txt`): the map grid of a band file (C1 and C2 key names), for a check
/// against the ANG and for a product whose band GeoTIFF has lost its georeferencing.
pub struct Mtl {
    pub zone: i32,
    pub ul: [f64; 2],
    pub date_time: Option<String>,
}

pub fn parse_mtl(text: &str) -> Result<Mtl> {
    let o = Odl::parse(text);
    let zone = o.num("", "UTM_ZONE").ok_or_else(|| Error::invalid("MTL: UTM_ZONE is missing"))? as i32;
    let x = o.num("", "CORNER_UL_PROJECTION_X_PRODUCT").ok_or_else(|| Error::invalid("MTL: CORNER_UL_PROJECTION_X_PRODUCT is missing"))?;
    let y = o.num("", "CORNER_UL_PROJECTION_Y_PRODUCT").ok_or_else(|| Error::invalid("MTL: CORNER_UL_PROJECTION_Y_PRODUCT is missing"))?;
    let date = o.get("", "DATE_ACQUIRED").map(|d| format!("{}T{}", d, o.get("", "SCENE_CENTER_TIME").unwrap_or("00:00:00")));
    Ok(Mtl { zone, ul: [x, y], date_time: date })
}
