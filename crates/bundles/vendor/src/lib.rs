//! `vendor` bundle (lazy; analysis worker): the vendor sensor-metadata readers of
//! `gw_sensor::vendor` (REQ-GAP-20). A job gives the files' text; the result is the model record the
//! core bundle registers (`gw_model_record`).

use gw_abi::{slice, status, Error, Result};

gw_abi::export_abi!();

/// Length-prefixed parts (u32 little-endian length, then the bytes), as UTF-8 text.
fn text_parts(b: &[u8], n: usize) -> Result<Vec<String>> {
    let mut out = Vec::with_capacity(n);
    let mut o = 0usize;
    for _ in 0..n {
        let l = b.get(o..o + 4).ok_or_else(|| Error::invalid("vendor model: truncated support data"))?;
        let len = u32::from_le_bytes([l[0], l[1], l[2], l[3]]) as usize;
        let p = b.get(o + 4..o + 4 + len).ok_or_else(|| Error::invalid("vendor model: truncated support data"))?;
        out.push(String::from_utf8_lossy(p).into_owned());
        o += 4 + len;
    }
    Ok(out)
}

/// A model from vendor metadata (REQ-GAP-20). `kind` 1: DigitalGlobe/Maxar parts IMD, EPH, ATT,
/// GEO (`band` = the GEO band index); 2: Landsat ANG (`band` = the band number, `step` the
/// line-of-sight grid step in pixels); 3: Sentinel-2 MTD_TL (`band` = the band index 0–12).
/// `href` is the reference height (m) of the map + line-of-sight models. Output (f64
/// little-endian): a header [model record type (2 line scanner, 4 map + line of sight), rows,
/// cols, note flags (gw_sensor::vendor::dg::NOTE_*), a priori σ in-track, cross-track, radial (m),
/// attitude (µrad) (NaN when none)], then the model record. Numbers only: no float formatting in
/// this bundle.
/// # Safety
/// `buf` must hold `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_vendor_model(kind: i32, buf: *const u8, len: usize, band: i32, step: f64, href: f64) -> i32 {
    let b = slice(buf, len);
    status((|| {
        let (ty, rows, cols, flags, sigma, rec): (f64, f64, f64, u32, [f64; 4], Vec<f64>) = match kind {
            1 => {
                let p = text_parts(b, 4)?;
                let f = gw_sensor::vendor::dg::DgFiles { imd: &p[0], eph: &p[1], att: &p[2], geo: &p[3] };
                let m = gw_sensor::vendor::dg::dg_model(&f, band.max(0) as usize)?;
                (2.0, m.model.rows, m.model.cols, m.flags, m.sigma.unwrap_or([f64::NAN; 4]), m.model.to_record())
            }
            2 => {
                let p = text_parts(b, 1)?;
                let a = gw_sensor::vendor::landsat::Ang::parse(&p[0])?;
                let bd = a.band(band.max(0) as u32)?;
                let (r, c) = (bd.l1t_lines, bd.l1t_samps);
                let rec = gw_sensor::vendor::landsat::ortholos_record(&a, band.max(0) as u32, if step > 0.0 { step } else { 32.0 }, href)?;
                (4.0, r, c, 0, [f64::NAN; 4], rec)
            }
            3 => {
                let p = text_parts(b, 1)?;
                let g = gw_sensor::vendor::s2::parse_mtd_tl(&p[0])?;
                let bi = band.max(0) as usize;
                let res = gw_sensor::vendor::s2::band_resolution(bi);
                let (r, c) = g.sizes.iter().find(|s| s.0 == res).map(|s| (s.1, s.2)).unwrap_or((f64::NAN, f64::NAN));
                let rec = gw_sensor::vendor::s2::ortholos_record(&g, bi, href)?;
                (4.0, r, c, 0, [f64::NAN; 4], rec)
            }
            _ => return Err(Error::invalid("unknown vendor model kind")),
        };
        let head = [ty, rows, cols, flags as f64, sigma[0], sigma[1], sigma[2], sigma[3]];
        let mut out = Vec::with_capacity(8 * (head.len() + rec.len()));
        for v in head.iter().chain(rec.iter()) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        gw_abi::set_out(out);
        Ok(())
    })())
}
