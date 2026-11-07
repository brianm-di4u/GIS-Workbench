//! Image-to-point-cloud registration exports (REQ-GAP-46): matching and control generation
//! (`gw_adjust::lidarreg`) and GPM-style error propagation (`gw_adjust::gpm`). The joint
//! adjustment itself is `gw_adjust_block` version 3.

use crate::model_of;
use gw_abi::{set_out_json, slice, status, Error, Json};
use gw_adjust::block::DatumIn;
use gw_adjust::gpm::{block, ce_le, propagate, relative, Spdcf};
use gw_adjust::lidarreg::{register, Chip, Frame, RefGrid, RegOptions, Reference};
use gw_sensor::Ground;

/// Number of values after the model record in a registration job.
const REG_PRM: usize = 25;

/// Image-to-point-cloud registration. prm: [model record type, record length, record…, lat0,
/// lon0, kx, ky, e0, n0, cell, w, h, chip w, chip h, chip x0, chip y0, chip step, reference (0
/// intensity, 1 hillshade, 2 both), sun azimuth (NaN: the best of eight), sun elevation, tile,
/// spacing, largest offset (m), min peak, min peak ratio, min NCC, RANSAC tolerance (m), hold-out
/// (every n-th inlier; 0 none)]. `dsm` and `inten` (empty: none) hold w × h posts, `chip` chip w ×
/// chip h pixels. JSON: the statistics and the matches as rows [e, n, z, de, dn, x, y, peak, ratio,
/// ncc, source, inlier, check].
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_lidar_register(prm: *const f64, plen: usize, dsm: *const f32, dlen: usize, inten: *const f32, ilen: usize, chip: *const f32, clen: usize) -> i32 {
    let (a, d, it, c) = (slice(prm, plen), slice(dsm, dlen), slice(inten, ilen), slice(chip, clen));
    status((|| {
        let head = a.get(0..2).ok_or_else(|| Error::invalid("registration: bad parameters"))?;
        if !head.iter().all(|v| v.is_finite() && *v >= 0.0) {
            return Err(Error::invalid("registration: bad parameters"));
        }
        let n = (head[1] as usize).min(a.len());
        let rec = a.get(2..2 + n).ok_or_else(|| Error::invalid("registration: truncated model record"))?;
        let model = model_of(head[0] as i32, rec)?;
        let p = a.get(2 + n..2 + n + REG_PRM).ok_or_else(|| Error::invalid("registration: truncated parameters"))?;
        if a.len() != 2 + n + REG_PRM || p.iter().enumerate().any(|(k, v)| k != 15 && !v.is_finite()) {
            return Err(Error::invalid("registration: a parameter is missing or not finite"));
        }
        if p[7..11].iter().any(|v| *v < 0.0 || *v > 1e9) || !(p[6] > 0.0) || !(p[13] > 0.0) {
            return Err(Error::invalid("registration: bad grid or chip size"));
        }
        let (w, h, cw, chh) = (p[7] as usize, p[8] as usize, p[9] as usize, p[10] as usize);
        if w.saturating_mul(h) != d.len() || (!it.is_empty() && it.len() != d.len()) || cw.saturating_mul(chh) != c.len() || d.len() > 64_000_000 {
            return Err(Error::invalid("registration: the grids do not match their sizes"));
        }
        let g = RefGrid { frame: Frame { lat0: p[0], lon0: p[1], kx: p[2], ky: p[3] }, e0: p[4], n0: p[5], cell: p[6], w, h, dsm: d, intensity: (!it.is_empty()).then_some(it) };
        let ch = Chip { px: c, w: cw, h: chh, x0: p[11], y0: p[12], step: p[13] };
        let reference = match p[14] as i32 {
            0 => Reference::Intensity,
            1 => Reference::Hillshade,
            _ => Reference::Both,
        };
        let o = RegOptions { reference, sun_az: p[15], sun_el: p[16], tile: p[17] as usize, spacing: p[18].max(1.0) as usize, max_offset_m: p[19].clamp(1.0, 500.0), min_peak: p[20], min_ratio: p[21], min_ncc: p[22], ransac_tol_m: p[23].max(0.01), hold_out: p[24].max(0.0) as usize };
        let r = register(&*model, &g, &ch, &o)?;
        let mut j = Json::new();
        j.obj().kv_int("tiles", r.tiles as i64).kv_int("accepted", r.accepted as i64).kv_int("inliers", r.inliers as i64).kv_num("sunAz", r.sun_az).kv_num("rmsM", r.rms_m);
        j.key("coarse").arr().num(r.coarse.0).num(r.coarse.1).end_arr().key("affine").arr();
        for v in r.affine {
            j.num(v);
        }
        j.end_arr().key("matches").arr();
        for m in &r.matches {
            j.arr().num(m.e).num(m.n).num(m.z).num(m.de).num(m.dn).num(m.x).num(m.y).num(m.peak).num(m.ratio).num(m.ncc).int(i64::from(m.source)).bool(m.inlier).bool(m.check).end_arr();
        }
        j.end_arr().end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// GPM-style propagation: job [k, centre lat, lon, h, covariance (k × k), n, then per point lat,
/// lon, h, σE, σN, σU, then A, α, β, T of the correlation function (A = 0: none)]. JSON {cov
/// (3n × 3n), ce90 and le90 per point, relCe90 and relLe90 between consecutive points}.
/// # Safety
/// `job` must hold `len` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_gpm_propagate(job: *const f64, len: usize) -> i32 {
    let a = slice(job, len);
    status((|| {
        let k0 = *a.first().ok_or_else(|| Error::invalid("propagation: empty job"))?;
        if !matches!(k0, 0.0 | 3.0 | 7.0) {
            return Err(Error::invalid("propagation: the datum shift has 0, 3 or 7 parameters"));
        }
        let k = k0 as usize;
        let c = a.get(1..4 + k * k).ok_or_else(|| Error::invalid("propagation: truncated job"))?;
        let datum = DatumIn { k, centre: Some(Ground { lat: c[0], lon: c[1], h: c[2] }), prior_sigma: vec![] };
        let cov = &c[3..];
        let nv = *a.get(4 + k * k).ok_or_else(|| Error::invalid("propagation: truncated job"))?;
        if !(0.0..=2000.0).contains(&nv) {
            return Err(Error::invalid("propagation: at most 2000 points"));
        }
        let n = nv as usize;
        let o = 5 + k * k;
        if a.len() != o + 6 * n + 4 || a.iter().any(|v| !v.is_finite()) {
            return Err(Error::invalid("propagation: length does not match its counts, or a value is not finite"));
        }
        let rows: Vec<&[f64]> = a[o..o + 6 * n].chunks_exact(6).collect();
        let pts: Vec<Ground> = rows.iter().map(|r| Ground { lat: r[0], lon: r[1], h: r[2] }).collect();
        let local: Vec<[f64; 3]> = rows.iter().map(|r| [r[3], r[4], r[5]]).collect();
        let f = &a[o + 6 * n..];
        let spdcf = if f[0] > 0.0 { Some(Spdcf::new(f[0], f[1], f[2], f[3])?) } else { None };
        let m = propagate(&datum, cov, &pts, &local, spdcf.as_ref())?;
        let mut j = Json::new();
        j.obj().key("cov").arr();
        for v in &m {
            j.num(*v);
        }
        j.end_arr().key("ce90").arr();
        for i in 0..n {
            j.num(ce_le(block(&m, n, i, i)).0);
        }
        j.end_arr().key("le90").arr();
        for i in 0..n {
            j.num(ce_le(block(&m, n, i, i)).1);
        }
        j.end_arr().key("relCe90").arr();
        for i in 1..n {
            j.num(ce_le(relative(&m, n, i - 1, i)).0);
        }
        j.end_arr().key("relLe90").arr();
        for i in 1..n {
            j.num(ce_le(relative(&m, n, i - 1, i)).1);
        }
        j.end_arr().end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}
