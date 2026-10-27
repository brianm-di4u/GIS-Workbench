//! UTM/UPS zone logic and the truncating MGRS/USNG, GARS and GEOREF grids (REQ-GEO-06).
//! UTMUPS and MGRS follow GeographicLib (MIT, C. F. F. Karney): truncation on output,
//! cell centre on reverse, Norway/Svalbard exceptions, UPS letters, band tolerance.

use crate::math::*;
use crate::projection::{PolarStereographic, TransverseMercator};
use gw_abi::{Error, Result};

/// Zone 0 means UPS.
pub const UPS: i32 = 0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UtmUps {
    pub zone: i32,
    pub northp: bool,
    pub easting: f64,
    pub northing: f64,
    pub gamma: f64,
    pub k: f64,
}

pub fn latitude_band(lat: f64) -> i32 {
    let ilat = lat.floor() as i32;
    // C++ integer division truncates toward zero; ilat + 80 >= 0 for lat >= -80.
    let v = (ilat + 80) / 8 - 10;
    v.clamp(-10, 9)
}

pub fn standard_zone(lat: f64, lon: f64) -> i32 {
    if lat.is_nan() || lon.is_nan() {
        return -1;
    }
    if (-80.0..84.0).contains(&lat) {
        let mut ilon = ang_normalize(lon).floor() as i32;
        if ilon == 180 {
            ilon = -180;
        }
        let mut zone = (ilon + 186) / 6;
        let band = latitude_band(lat);
        if band == 7 && zone == 31 && ilon >= 3 {
            zone = 32;
        } else if band == 9 && (0..42).contains(&ilon) {
            zone = 2 * ((ilon + 183) / 12) + 1;
        }
        zone
    } else {
        UPS
    }
}

pub fn central_meridian(zone: i32) -> f64 {
    (6 * zone - 183) as f64
}

const FALSE_EASTING: [f64; 4] = [2e6, 2e6, 5e5, 5e5];
const FALSE_NORTHING: [f64; 4] = [2e6, 2e6, 1e7, 0.0];

/// Forward UTM/UPS. `zone` = None picks the standard zone; Some(z) forces zone z (0 = UPS).
pub fn utmups_forward(lat: f64, lon: f64, zone: Option<i32>) -> Result<UtmUps> {
    if !(-90.0..=90.0).contains(&lat) {
        return Err(Error::range(format!("latitude {lat} not in [-90, 90]")));
    }
    let northp = lat >= 0.0;
    let zone = zone.unwrap_or_else(|| standard_zone(lat, lon));
    if zone < 0 || zone > 60 {
        return Err(Error::invalid("invalid zone"));
    }
    let utmp = zone != UPS;
    let p = if utmp {
        let lon0 = central_meridian(zone);
        let dlon = ang_diff(lon0, lon);
        if !(dlon.abs() <= 60.0) {
            return Err(Error::range("longitude more than 60° from the central meridian"));
        }
        TransverseMercator::utm().forward(lon0, lat, lon)
    } else {
        if lat.abs() < 70.0 {
            return Err(Error::range("latitude too far from the pole for UPS"));
        }
        PolarStereographic::ups().forward(northp, lat, lon)
    };
    let ind = (if utmp { 2 } else { 0 }) + usize::from(northp);
    Ok(UtmUps { zone, northp, easting: p.x + FALSE_EASTING[ind], northing: p.y + FALSE_NORTHING[ind], gamma: p.gamma, k: p.k })
}

pub fn utmups_reverse(zone: i32, northp: bool, easting: f64, northing: f64) -> Result<(f64, f64, f64, f64)> {
    if zone < 0 || zone > 60 {
        return Err(Error::invalid("invalid zone"));
    }
    let utmp = zone != UPS;
    let ind = (if utmp { 2 } else { 0 }) + usize::from(northp);
    let x = easting - FALSE_EASTING[ind];
    let y = northing - FALSE_NORTHING[ind];
    let g = if utmp {
        TransverseMercator::utm().reverse(central_meridian(zone), x, y)
    } else {
        PolarStereographic::ups().reverse(northp, x, y)
    };
    Ok((g.lat, g.lon, g.gamma, g.k))
}

// ---- MGRS -------------------------------------------------------------------------------

const DIGITS: &[u8] = b"0123456789";
const LATBAND: &[u8] = b"CDEFGHJKLMNPQRSTUVWX";
const UTMCOLS: [&[u8]; 3] = [b"ABCDEFGH", b"JKLMNPQR", b"STUVWXYZ"];
const UTMROW: &[u8] = b"ABCDEFGHJKLMNPQRSTUV";
const UPSBAND: &[u8] = b"ABYZ";
const UPSCOLS: [&[u8]; 4] = [b"JKLPQRSTUXYZ", b"ABCFGHJKLPQR", b"RSTUXYZ", b"ABCFGHJ"];
const UPSROWS: [&[u8]; 2] = [b"ABCDEFGHJKLMNPQRSTUVWXYZ", b"ABCDEFGHJKLMNP"];
const TILE: f64 = 100_000.0;
const MINUTMCOL: i32 = 1;
const MAXUTMSROW: i32 = 100;
const MINUPSSIND: i32 = 8;
const MINUPSNIND: i32 = 13;
const UPSEASTING: i32 = 20;
const UTMROWPERIOD: i32 = 20;
const UTMEVENROWSHIFT: i32 = 5;
/// Digits per coordinate: 5 is the 1 m standard; up to 6 (0.1 m, "non-standard") is allowed.
pub const MAXPREC: usize = 6;
const MULT: i64 = 1_000_000; // micrometres internally, as GeographicLib does (maxprec 11)

fn utm_row(iband: i32, icol: i32, irow: i32) -> i32 {
    let c = 100.0 * (8 * iband + 4) as f64 / 90.0;
    let northp = f64::from(u8::from(iband >= 0));
    let minrow = if iband > -10 { (c - 4.3 - 0.1 * northp).floor() as i32 } else { -90 };
    let maxrow = if iband < 9 { (c + 4.4 - 0.1 * northp).floor() as i32 } else { 94 };
    let baserow = (minrow + maxrow) / 2 - UTMROWPERIOD / 2;
    let mut irow = (irow - baserow + MAXUTMSROW).rem_euclid(UTMROWPERIOD) + baserow;
    if !(irow >= minrow && irow <= maxrow) {
        let sband = if iband >= 0 { iband } else { -iband - 1 };
        let srow = if irow >= 0 { irow } else { -irow - 1 };
        let scol = if icol < 4 { icol } else { -icol + 7 };
        if !((srow == 70 && sband == 8 && scol >= 2)
            || (srow == 71 && sband == 7 && scol <= 2)
            || (srow == 79 && sband == 9 && scol >= 1)
            || (srow == 80 && sband == 8 && scol <= 1))
        {
            irow = MAXUTMSROW;
        }
    }
    irow
}

/// MGRS from UTM/UPS coordinates and the latitude (needed for the band letter).
/// `prec` is the number of digits per coordinate (0..=6). Output is truncated.
pub fn mgrs_from_utmups(u: &UtmUps, lat: f64, prec: usize) -> Result<String> {
    if prec > MAXPREC {
        return Err(Error::range("MGRS precision must be 0..6 digits per coordinate"));
    }
    let utmp = u.zone != UPS;
    let mut out = String::new();
    let ix = (u.easting * MULT as f64).floor() as i64;
    let iy = (u.northing * MULT as f64).floor() as i64;
    let m = MULT * TILE as i64;
    let xh = ix.div_euclid(m) as i32;
    let yh = iy.div_euclid(m) as i32;
    if utmp {
        out.push_str(&format!("{:02}", u.zone));
        let iband = if lat.abs() < 1e-9 { if u.northp { 0 } else { -1 } } else { latitude_band(lat) };
        let icol = xh - MINUTMCOL;
        if !(0..8).contains(&icol) {
            return Err(Error::range("easting outside the UTM 100 km columns"));
        }
        let irow = utm_row(iband, icol, yh.rem_euclid(UTMROWPERIOD));
        if irow != yh - if u.northp { 0 } else { MAXUTMSROW } {
            return Err(Error::range(format!("latitude {lat} is inconsistent with the UTM coordinates")));
        }
        out.push(LATBAND[(10 + iband) as usize] as char);
        out.push(UTMCOLS[((u.zone - 1) % 3) as usize][icol as usize] as char);
        let shift = if (u.zone - 1) & 1 == 1 { UTMEVENROWSHIFT } else { 0 };
        out.push(UTMROW[((yh + shift).rem_euclid(UTMROWPERIOD)) as usize] as char);
    } else {
        let eastp = xh >= UPSEASTING;
        let iband = (if u.northp { 2 } else { 0 }) + usize::from(eastp);
        out.push(UPSBAND[iband] as char);
        let icol = xh - if eastp { UPSEASTING } else if u.northp { MINUPSNIND } else { MINUPSSIND };
        let irow = yh - if u.northp { MINUPSNIND } else { MINUPSSIND };
        let cols = UPSCOLS[iband];
        let rows = UPSROWS[usize::from(u.northp)];
        if icol < 0 || icol as usize >= cols.len() || irow < 0 || irow as usize >= rows.len() {
            return Err(Error::range("coordinates outside the UPS grid"));
        }
        out.push(cols[icol as usize] as char);
        out.push(rows[irow as usize] as char);
    }
    if prec > 0 {
        let mut rx = ix - m * xh as i64;
        let mut ry = iy - m * yh as i64;
        let d = 10i64.pow((11 - prec) as u32);
        rx /= d;
        ry /= d;
        let mut ex = vec![b'0'; prec];
        let mut ny = vec![b'0'; prec];
        for c in (0..prec).rev() {
            ex[c] = DIGITS[(rx % 10) as usize];
            rx /= 10;
            ny[c] = DIGITS[(ry % 10) as usize];
            ry /= 10;
        }
        out.push_str(std::str::from_utf8(&ex).unwrap_or(""));
        out.push_str(std::str::from_utf8(&ny).unwrap_or(""));
    }
    Ok(out)
}

/// MGRS from geographic coordinates (standard zone).
pub fn mgrs_forward(lat: f64, lon: f64, prec: usize) -> Result<String> {
    let u = utmups_forward(lat, lon, None)?;
    // A latitude so little below the equator that its southern northing quantises to exactly
    // 10 000 km (e.g. -5e-324) is the equator: give it the northern hemisphere, as for 0.
    if u.zone != UPS && !u.northp && (u.northing * MULT as f64).floor() >= 1e7 * MULT as f64 {
        let u = utmups_forward(0.0, lon, None)?;
        return mgrs_from_utmups(&u, 0.0, prec);
    }
    mgrs_from_utmups(&u, lat, prec)
}

/// Parsed MGRS: zone (0 = UPS), hemisphere, cell centre (or SW corner) in UTM/UPS metres,
/// digits per coordinate (-1 for a grid zone designation only) and cell size in metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MgrsCell {
    pub zone: i32,
    pub northp: bool,
    pub easting: f64,
    pub northing: f64,
    pub prec: i32,
    pub cell_m: f64,
}

fn lookup(set: &[u8], c: u8) -> i32 {
    let c = c.to_ascii_uppercase();
    set.iter().position(|&x| x == c).map_or(-1, |p| p as i32)
}

pub fn mgrs_reverse(s: &str, centerp: bool) -> Result<MgrsCell> {
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let len = b.len();
    let mut p = 0usize;
    let mut zone = 0i32;
    while p < len {
        let i = lookup(DIGITS, b[p]);
        if i < 0 {
            break;
        }
        zone = 10 * zone + i;
        p += 1;
    }
    if p > 0 && !(1..=60).contains(&zone) {
        return Err(Error::invalid(format!("zone {zone} not in [1,60]")));
    }
    if p > 2 {
        return Err(Error::invalid("more than 2 digits at the start of MGRS"));
    }
    if len < p + 1 {
        return Err(Error::invalid("MGRS string too short"));
    }
    let utmp = zone != UPS;
    let band = if utmp { LATBAND } else { UPSBAND };
    let mut iband = lookup(band, b[p]);
    p += 1;
    if iband < 0 {
        return Err(Error::invalid(format!("band letter {} not allowed", b[p - 1] as char)));
    }
    let northp = iband >= if utmp { 10 } else { 2 };
    if p == len {
        let deg = (MAXUTMSROW as f64 * TILE) / (90.0 * TILE);
        let (x, y) = if utmp {
            let x = if zone == 31 && iband == 17 { 4.0 } else { 5.0 } * TILE;
            let y = (8.0 * (iband as f64 - 9.5) * deg + 0.5).floor() * TILE + if northp { 0.0 } else { 1e7 };
            (x, y)
        } else {
            let x = ((if iband & 1 == 1 { 1.0 } else { -1.0 }) * (4.0 * deg + 0.5).floor() + UPSEASTING as f64) * TILE;
            (x, UPSEASTING as f64 * TILE)
        };
        return Ok(MgrsCell { zone, northp, easting: x, northing: y, prec: -1, cell_m: f64::NAN });
    }
    if len - p < 2 {
        return Err(Error::invalid("missing row letter"));
    }
    let col = if utmp { UTMCOLS[((zone - 1) % 3) as usize] } else { UPSCOLS[iband as usize] };
    let row = if utmp { UTMROW } else { UPSROWS[usize::from(northp)] };
    let mut icol = lookup(col, b[p]);
    p += 1;
    if icol < 0 {
        return Err(Error::invalid(format!("column letter {} not allowed in this zone", b[p - 1] as char)));
    }
    let mut irow = lookup(row, b[p]);
    p += 1;
    if irow < 0 {
        return Err(Error::invalid(format!("row letter {} not allowed", b[p - 1] as char)));
    }
    if utmp {
        if (zone - 1) & 1 == 1 {
            irow = (irow + UTMROWPERIOD - UTMEVENROWSHIFT) % UTMROWPERIOD;
        }
        iband -= 10;
        irow = utm_row(iband, icol, irow);
        if irow == MAXUTMSROW {
            return Err(Error::invalid("100 km square not in this zone and band"));
        }
        irow = if northp { irow } else { irow + 100 };
        icol += MINUTMCOL;
    } else {
        let eastp = iband & 1 == 1;
        icol += if eastp { UPSEASTING } else if northp { MINUPSNIND } else { MINUPSSIND };
        irow += if northp { MINUPSNIND } else { MINUPSSIND };
    }
    let rest = len - p;
    if rest % 2 == 1 {
        return Err(Error::invalid("MGRS needs an even number of digits"));
    }
    let prec = rest / 2;
    if prec > MAXPREC {
        return Err(Error::invalid("more than 12 digits in MGRS"));
    }
    let mut unit = 1.0;
    let mut x1 = icol as f64;
    let mut y1 = irow as f64;
    for i in 0..prec {
        unit *= 10.0;
        let ix = lookup(DIGITS, b[p + i]);
        let iy = lookup(DIGITS, b[p + i + prec]);
        if ix < 0 || iy < 0 {
            return Err(Error::invalid("non-digit in the MGRS numeric part"));
        }
        x1 = 10.0 * x1 + ix as f64;
        y1 = 10.0 * y1 + iy as f64;
    }
    let cell = TILE / unit;
    if centerp {
        unit *= 2.0;
        x1 = 2.0 * x1 + 1.0;
        y1 = 2.0 * y1 + 1.0;
    }
    Ok(MgrsCell { zone, northp, easting: TILE * x1 / unit, northing: TILE * y1 / unit, prec: prec as i32, cell_m: cell })
}

/// MGRS → geographic (cell centre). Returns (lat, lon, cell size m, digits per coordinate).
pub fn mgrs_to_latlon(s: &str) -> Result<(f64, f64, f64, i32)> {
    let c = mgrs_reverse(s, true)?;
    let (lat, lon, _, _) = utmups_reverse(c.zone, c.northp, c.easting, c.northing)?;
    Ok((lat, lon, c.cell_m, c.prec))
}

/// USNG output: the same engine, spaced as recommended by FGDC-STD-011-2001.
pub fn usng_forward(lat: f64, lon: f64, prec: usize) -> Result<String> {
    let m = mgrs_forward(lat, lon, prec)?;
    let zone_len = m.chars().take_while(|c| c.is_ascii_digit()).count();
    let gzd_end = zone_len + 1;
    let sq_end = gzd_end + 2;
    if m.len() < sq_end {
        return Ok(m);
    }
    let digits = &m[sq_end..];
    let half = digits.len() / 2;
    let mut s = format!("{} {}", &m[..gzd_end], &m[gzd_end..sq_end]);
    if half > 0 {
        s.push_str(&format!(" {} {}", &digits[..half], &digits[half..]));
    }
    Ok(s)
}

// ---- GARS -------------------------------------------------------------------------------

const GARS_LETTERS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";

/// GARS cell (truncating). `prec`: 0 = 30′, 1 = 15′ quadrant, 2 = 5′ keypad.
pub fn gars_forward(lat: f64, lon: f64, prec: u8) -> Result<String> {
    if !(-90.0..=90.0).contains(&lat) {
        return Err(Error::range("latitude out of range"));
    }
    let lon = ang_normalize(lon);
    let lon = if lon == 180.0 { -180.0 } else { lon };
    let lat = if lat == 90.0 { 90.0 - 1e-9 } else { lat };
    // Work in units of 5 minutes.
    let x = ((lon + 180.0) * 12.0).floor() as i64; // 0..4319
    let y = ((lat + 90.0) * 12.0).floor() as i64; // 0..2159
    let ix = x / 6;
    let iy = y / 6;
    let mut s = format!("{:03}", ix + 1);
    s.push(GARS_LETTERS[(iy / 24) as usize] as char);
    s.push(GARS_LETTERS[(iy % 24) as usize] as char);
    if prec >= 1 {
        let qx = (x % 6) / 3;
        let qy = (y % 6) / 3;
        let quad = if qy == 1 { 1 + qx } else { 3 + qx };
        s.push(char::from(b'0' + quad as u8));
        if prec >= 2 {
            let kx = (x % 3) as u8;
            let ky = 2 - (y % 3) as u8;
            s.push(char::from(b'1' + ky * 3 + kx));
        }
    }
    Ok(s)
}

/// GARS → (lat, lon) of the cell centre and the cell size in degrees.
pub fn gars_reverse(s: &str) -> Result<(f64, f64, f64)> {
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).map(|c| c.to_ascii_uppercase()).collect();
    if b.len() < 5 || b.len() > 7 {
        return Err(Error::invalid("GARS must be 5 to 7 characters"));
    }
    let lonband: i64 = std::str::from_utf8(&b[..3]).ok().and_then(|t| t.parse().ok()).ok_or_else(|| Error::invalid("bad GARS longitude band"))?;
    if !(1..=720).contains(&lonband) {
        return Err(Error::invalid("GARS longitude band not in 001..720"));
    }
    let l1 = lookup(GARS_LETTERS, b[3]);
    let l2 = lookup(GARS_LETTERS, b[4]);
    if l1 < 0 || l2 < 0 {
        return Err(Error::invalid("bad GARS latitude letters"));
    }
    let latband = l1 as i64 * 24 + l2 as i64;
    if latband >= 360 {
        return Err(Error::invalid("GARS latitude band out of range"));
    }
    let mut lon0 = -180.0 + (lonband - 1) as f64 * 0.5;
    let mut lat0 = -90.0 + latband as f64 * 0.5;
    let mut size = 0.5;
    if b.len() >= 6 {
        let q = b[5] as i64 - b'0' as i64;
        if !(1..=4).contains(&q) {
            return Err(Error::invalid("GARS quadrant must be 1..4"));
        }
        size = 0.25;
        if q == 2 || q == 4 {
            lon0 += size;
        }
        if q == 1 || q == 2 {
            lat0 += size;
        }
        if b.len() == 7 {
            let k = b[6] as i64 - b'1' as i64;
            if !(0..=8).contains(&k) {
                return Err(Error::invalid("GARS keypad must be 1..9"));
            }
            size = 0.25 / 3.0;
            lon0 += (k % 3) as f64 * size;
            lat0 += (2 - k / 3) as f64 * size;
        }
    }
    Ok((lat0 + size / 2.0, lon0 + size / 2.0, size))
}

// ---- GEOREF -----------------------------------------------------------------------------

const GEOREF_LON: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
const GEOREF_LAT: &[u8] = b"ABCDEFGHJKLM";

/// GEOREF (truncating). `prec`: -1 = 15°, 0 = 1°, 1 = 1′, 2 = 0.1′, … up to 11.
pub fn georef_forward(lat: f64, lon: f64, prec: i32) -> Result<String> {
    if !(-90.0..=90.0).contains(&lat) {
        return Err(Error::range("latitude out of range"));
    }
    let prec = prec.clamp(-1, 11);
    let lon = ang_normalize(lon);
    let lon = if lon == 180.0 { -180.0 } else { lon };
    let lat = if lat == 90.0 { 90.0 - 1e-12 } else { lat };
    let x = lon + 180.0;
    let y = lat + 90.0;
    let xi = (x / 15.0).floor() as usize;
    let yi = (y / 15.0).floor() as usize;
    let mut s = String::new();
    s.push(GEOREF_LON[xi] as char);
    s.push(GEOREF_LAT[yi] as char);
    if prec < 0 {
        return Ok(s);
    }
    let xd = (x - 15.0 * xi as f64).floor() as usize;
    let yd = (y - 15.0 * yi as f64).floor() as usize;
    s.push(GEOREF_LON[xd] as char);
    s.push(GEOREF_LON[yd] as char);
    if prec == 0 {
        return Ok(s);
    }
    let digits = (prec + 1) as u32; // 2 digits for 1′, 3 for 0.1′, …
    let scale = 10f64.powi(digits as i32 - 2);
    let xm = ((x - x.floor()) * 60.0 * scale + 1e-9).floor() as u64;
    let ym = ((y - y.floor()) * 60.0 * scale + 1e-9).floor() as u64;
    s.push_str(&format!("{:0w$}{:0w$}", xm, ym, w = digits as usize));
    Ok(s)
}

/// GEOREF → (lat, lon) of the cell centre and cell size in degrees.
pub fn georef_reverse(s: &str) -> Result<(f64, f64, f64)> {
    let b: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).map(|c| c.to_ascii_uppercase()).collect();
    if b.len() < 2 {
        return Err(Error::invalid("GEOREF too short"));
    }
    let xi = lookup(GEOREF_LON, b[0]);
    let yi = lookup(GEOREF_LAT, b[1]);
    if xi < 0 || yi < 0 {
        return Err(Error::invalid("bad GEOREF 15° letters"));
    }
    let mut lon0 = -180.0 + 15.0 * xi as f64;
    let mut lat0 = -90.0 + 15.0 * yi as f64;
    let mut size = 15.0;
    if b.len() >= 4 {
        let xd = lookup(GEOREF_LON, b[2]);
        let yd = lookup(GEOREF_LON, b[3]);
        if !(0..15).contains(&xd) || !(0..15).contains(&yd) {
            return Err(Error::invalid("bad GEOREF 1° letters"));
        }
        lon0 += xd as f64;
        lat0 += yd as f64;
        size = 1.0;
        let rest = &b[4..];
        if !rest.is_empty() {
            if rest.len() % 2 == 1 || rest.len() < 4 || !rest.iter().all(u8::is_ascii_digit) {
                return Err(Error::invalid("GEOREF minutes need an even number (≥ 4) of digits"));
            }
            let n = rest.len() / 2;
            let parse = |d: &[u8]| -> f64 { d.iter().fold(0.0, |a, &c| a * 10.0 + (c - b'0') as f64) };
            let scale = 10f64.powi(n as i32 - 2);
            let xm = parse(&rest[..n]) / scale;
            let ym = parse(&rest[n..]) / scale;
            if xm >= 60.0 || ym >= 60.0 {
                return Err(Error::invalid("GEOREF minutes must be < 60"));
            }
            size = 1.0 / 60.0 / scale;
            lon0 += xm / 60.0;
            lat0 += ym / 60.0;
        }
    }
    Ok((lat0 + size / 2.0, lon0 + size / 2.0, size))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mgrs_reference_vectors() {
        // Research/05 §3.8 (GeoConvert references), 1 m precision.
        let cases = [
            (33.3, 44.4, "38SMB4414084706"),
            (0.0, 0.0, "31NAA6602100000"),
            (-33.8568, 151.2153, "56HLH3490052288"),
            (60.5, 4.5, "32VKN5292815548"),
            (78.0, 10.0, "33XUG8408563320"),
            (82.0, 35.0, "37XDM3789806976"),
            (38.8895, -77.0353, "18SUJ2347806483"),
            (10.0, 180.0, "01PAM7107106908"),
            (85.0, 30.0, "ZCC7772818959"),
            (-85.0, -45.0, "AUR0723292767"),
            (84.0, 0.0, "ZAA0000033272"),
            (-80.5, 170.0, "BBB8355559007"),
        ];
        for (lat, lon, want) in cases {
            let got = mgrs_forward(lat, lon, 5).unwrap();
            assert_eq!(got, want, "{lat},{lon}");
        }
    }

    #[test]
    fn mgrs_truncates_not_rounds() {
        // AC-07.4: an easting of 444 999.9 m gives "44999".
        let u = UtmUps { zone: 38, northp: true, easting: 444_999.9, northing: 3_684_706.4, gamma: 0.0, k: 1.0 };
        let s = mgrs_from_utmups(&u, 33.3, 5).unwrap();
        assert_eq!(&s[5..10], "44999");
    }

    #[test]
    fn mgrs_reverse_centre() {
        let (lat, lon, cell, prec) = mgrs_to_latlon("38SMB4488").unwrap();
        assert!((lat - 33.33424).abs() < 1e-5 && (lon - 44.40363).abs() < 1e-5, "{lat} {lon}");
        assert_eq!(cell, 1000.0);
        assert_eq!(prec, 2);
        let c = mgrs_reverse("38SMB4488", true).unwrap();
        assert_eq!((c.easting, c.northing), (444_500.0, 3_688_500.0));
    }

    #[test]
    fn mgrs_round_trip_and_rejections() {
        for s in ["38SMB4414084706", "38smb 44140 84706", "ZCC7772818959", "AUR0723292767"] {
            let (lat, lon, _, _) = mgrs_to_latlon(s).unwrap();
            let back = mgrs_forward(lat, lon, 5).unwrap();
            assert_eq!(back, s.to_ascii_uppercase().replace(' ', ""));
        }
        assert!(mgrs_reverse("38SMB441408470", true).is_err()); // odd digits
        assert!(mgrs_reverse("38SMI4414084706", true).is_err()); // letter I
        assert!(mgrs_reverse("38VLS", true).is_ok());
        assert!(mgrs_reverse("38WLS", true).is_ok());
        assert!(mgrs_reverse("38VMS", true).is_err());
    }

    #[test]
    fn usng_spacing() {
        assert_eq!(usng_forward(38.8895, -77.0353, 5).unwrap(), "18S UJ 23478 06483");
    }

    #[test]
    fn gars_reference() {
        assert_eq!(gars_forward(57.64911, 10.40744, 0).unwrap(), "381NH");
        assert_eq!(gars_forward(57.64911, 10.40744, 1).unwrap(), "381NH4");
        assert_eq!(gars_forward(57.64911, 10.40744, 2).unwrap(), "381NH45");
        let (lat, lon, size) = gars_reverse("381NH45").unwrap();
        assert!((lat - 57.625).abs() < 1e-9 && (lon - 10.375).abs() < 1e-9 && (size - 1.0 / 12.0).abs() < 1e-12);
    }

    #[test]
    fn georef_reference() {
        let (lat, lon) = (57.64911, 10.40744);
        assert_eq!(georef_forward(lat, lon, -1).unwrap(), "NK");
        assert_eq!(georef_forward(lat, lon, 0).unwrap(), "NKLN");
        assert_eq!(georef_forward(lat, lon, 1).unwrap(), "NKLN2438");
        assert_eq!(georef_forward(lat, lon, 2).unwrap(), "NKLN244389");
        assert_eq!(georef_forward(lat, lon, 3).unwrap(), "NKLN24443894");
        assert_eq!(georef_forward(lat, lon, 4).unwrap(), "NKLN2444638946");
        let (la, lo, _) = georef_reverse("NKLN2444638946").unwrap();
        assert!((la - lat).abs() < 2e-5 && (lo - lon).abs() < 2e-5);
    }

    #[test]
    fn zone_exceptions() {
        assert_eq!(standard_zone(60.5, 4.5), 32);
        assert_eq!(standard_zone(78.0, 10.0), 33);
        assert_eq!(standard_zone(82.0, 35.0), 37);
        assert_eq!(standard_zone(84.0, 0.0), UPS);
        assert_eq!(standard_zone(10.0, 180.0), 1);
    }
}

#[cfg(test)]
mod equator_tests {
    use super::*;
    #[test]
    fn denormal_south_latitude_is_the_equator() {
        let a = mgrs_forward(-5e-324, 0.0, 5).unwrap();
        let b = mgrs_forward(0.0, 0.0, 5).unwrap();
        assert_eq!(a, b);
        assert!(mgrs_forward(-1e-7, 0.0, 5).unwrap().starts_with("31M"));
    }
}
