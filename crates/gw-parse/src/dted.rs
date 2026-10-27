//! DTED level 0/1/2 and SRTM HGT readers (REQ-FMT-07, REQ-DEM-01). Both are EGM96 (MSL)
//! heights on WGS 84. The output grid is row-major from the north row, west to east, f32
//! metres, NaN for voids.

use crate::bytes::Reader;
use gw_abi::{Error, Json, Result};

fn dms(s: &str) -> Option<f64> {
    // DDDMMSSH (longitude) or DDDMMSSH with leading zero for latitude in the UHL.
    let s = s.trim();
    if s.len() < 7 {
        return None;
    }
    let (num, h) = s.split_at(s.len() - 1);
    let n = num.len();
    let d: f64 = num.get(..n - 4)?.parse().ok()?;
    let m: f64 = num.get(n - 4..n - 2)?.parse().ok()?;
    let sec: f64 = num.get(n - 2..)?.parse().ok()?;
    let v = d + m / 60.0 + sec / 3600.0;
    Some(if h == "S" || h == "W" { -v } else { v })
}

pub struct Dted {
    pub json: String,
    pub width: usize,
    pub height: usize,
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub heights: Vec<f32>,
}

pub fn parse_dted(b: &[u8]) -> Result<Dted> {
    // Some cells keep an 80-byte tape label (VOL/HDR) in front of the UHL record.
    let b = if b.len() > 83 && (&b[..3] == b"HDR" || &b[..3] == b"VOL") && &b[80..83] == b"UHL" { &b[80..] } else { b };
    let mut r = Reader::new(b);
    let uhl = r.bytes(80)?;
    if &uhl[..3] != b"UHL" {
        return Err(Error::unsupported("not a DTED file (no UHL record)"));
    }
    let t = |o: usize, n: usize| String::from_utf8_lossy(&uhl[o..o + n]).to_string();
    let lon0 = dms(&t(4, 8)).ok_or_else(|| Error::invalid("bad UHL origin longitude"))?;
    let lat0 = dms(&t(12, 8)).ok_or_else(|| Error::invalid("bad UHL origin latitude"))?;
    let dlon_ts: f64 = t(20, 4).trim().parse().map_err(|_| Error::invalid("bad UHL longitude interval"))?;
    let dlat_ts: f64 = t(24, 4).trim().parse().map_err(|_| Error::invalid("bad UHL latitude interval"))?;
    let vacc = t(28, 4).trim().to_string();
    let ncols: usize = t(47, 4).trim().parse().map_err(|_| Error::invalid("bad UHL column count"))?;
    let nrows: usize = t(51, 4).trim().parse().map_err(|_| Error::invalid("bad UHL row count"))?;
    if !(2..=10_000).contains(&ncols) || !(2..=10_000).contains(&nrows) || dlon_ts <= 0.0 || dlat_ts <= 0.0 {
        return Err(Error::invalid("DTED dimensions out of range"));
    }
    let dsi = r.bytes(648)?;
    if &dsi[..3] != b"DSI" {
        return Err(Error::invalid("DTED DSI record missing"));
    }
    let d = |o: usize, n: usize| String::from_utf8_lossy(&dsi[o..o + n]).trim().to_string();
    let acc = r.bytes(2700)?;
    if &acc[..3] != b"ACC" {
        return Err(Error::invalid("DTED ACC record missing"));
    }
    let a = |o: usize, n: usize| String::from_utf8_lossy(&acc[o..o + n]).trim().to_string();
    let rec_len = 8 + 2 * nrows + 4;
    let need = 3428 + rec_len * ncols;
    if b.len() < need {
        return Err(Error::range(format!("DTED data records truncated: {} of {} bytes", b.len(), need)));
    }
    let mut heights = vec![f32::NAN; ncols * nrows];
    let mut checksum_errors = 0usize;
    for c in 0..ncols {
        let o = 3428 + c * rec_len;
        let rec = &b[o..o + rec_len];
        if rec[0] != 0xAA {
            return Err(Error::invalid(format!("DTED record {c} has no 0xAA sentinel")));
        }
        let mut sum: u32 = 0;
        for &x in &rec[..rec_len - 4] {
            sum = sum.wrapping_add(x as u32);
        }
        let stored = u32::from_be_bytes([rec[rec_len - 4], rec[rec_len - 3], rec[rec_len - 2], rec[rec_len - 1]]);
        if sum != stored {
            checksum_errors += 1;
        }
        for p in 0..nrows {
            let hi = rec[8 + 2 * p];
            let lo = rec[9 + 2 * p];
            let raw = u16::from_be_bytes([hi, lo]);
            // Sign-magnitude; -32767 (0xFFFF) is void.
            let v = if raw & 0x8000 != 0 { -((raw & 0x7FFF) as i32) } else { raw as i32 };
            let row = nrows - 1 - p; // file is south → north
            heights[row * ncols + c] = if v == -32767 { f32::NAN } else { v as f32 };
        }
    }
    let dlat = dlat_ts / 36_000.0;
    let dlon = dlon_ts / 36_000.0;
    let north = lat0 + dlat * (nrows - 1) as f64;
    let mut j = Json::new();
    j.obj();
    j.kv_str("format", "DTED").kv_str("level", &d(59, 5)).kv_str("securityClass", &d(3, 1));
    j.kv_str("verticalDatum", &d(141, 3)).kv_str("horizontalDatum", &d(144, 5));
    j.kv_str("absVerticalAccuracy", &vacc).kv_str("accAbsHorizontal", &a(3, 4)).kv_str("accAbsVertical", &a(7, 4));
    j.kv_int("width", ncols as i64).kv_int("height", nrows as i64);
    j.kv_num("swLat", lat0).kv_num("swLon", lon0).kv_num("nwLat", north).kv_num("dlat", dlat).kv_num("dlon", dlon);
    j.kv_int("checksumErrors", checksum_errors as i64);
    j.end_obj();
    Ok(Dted { json: j.finish(), width: ncols, height: nrows, lat0: north, lon0, dlat, dlon, heights })
}

/// SRTM HGT: square big-endian int16 grid (1201² = 3″, 3601² = 1″), void −32768.
/// `sw_lat`/`sw_lon` come from the file name (e.g. S35W059).
pub fn parse_hgt(b: &[u8], sw_lat: f64, sw_lon: f64) -> Result<Dted> {
    let n = ((b.len() / 2) as f64).sqrt() as usize;
    if n * n * 2 != b.len() || !(n == 1201 || n == 3601 || n == 2401 || n == 601) {
        return Err(Error::invalid(format!("HGT file of {} bytes is not a square 1201²/3601² grid", b.len())));
    }
    let mut heights = vec![f32::NAN; n * n];
    for (i, hv) in heights.iter_mut().enumerate() {
        let v = i16::from_be_bytes([b[2 * i], b[2 * i + 1]]);
        if v != -32768 {
            *hv = v as f32;
        }
    }
    let step = 1.0 / (n - 1) as f64;
    let mut j = Json::new();
    j.obj().kv_str("format", "SRTM HGT").kv_str("verticalDatum", "EGM96").kv_int("width", n as i64).kv_int("height", n as i64);
    j.kv_num("swLat", sw_lat).kv_num("swLon", sw_lon).kv_num("nwLat", sw_lat + 1.0).kv_num("dlat", step).kv_num("dlon", step).end_obj();
    Ok(Dted { json: j.finish(), width: n, height: n, lat0: sw_lat + 1.0, lon0: sw_lon, dlat: step, dlon: step, heights })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_files() {
        for name in ["dted-gdal/n43.dt0", "dted-gdal/w118n033.dt1", "dem-derived-s35w059/s35_w059_from_srtm.dt1"] {
            let p = format!("{}/../../../Research/samples/{name}", env!("CARGO_MANIFEST_DIR"));
            let Ok(b) = std::fs::read(&p) else { continue };
            let d = parse_dted(&b).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert!(d.width >= 2 && d.height >= 2);
            if name.ends_with("n43.dt0") {
                assert!(d.json.contains("\"checksumErrors\":0"), "{name}: {}", d.json);
            }
            let valid = d.heights.iter().filter(|h| h.is_finite()).count();
            assert!(valid > 0, "{name} has no valid posts");
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_dted(&[0u8; 100]).is_err());
        let mut b = vec![b' '; 4000];
        b[..3].copy_from_slice(b"UHL");
        assert!(parse_dted(&b).is_err());
        assert!(parse_hgt(&[0u8; 1000], 0.0, 0.0).is_err());
    }
}
