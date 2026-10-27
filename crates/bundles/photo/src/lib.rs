//! `photo` bundle (lazy; analysis worker): RPC bias-compensated block adjustment
//! (REQ-SNS-11), RPC fitting (REQ-SNS-15/16) and the tie-point matchers (REQ-SNS-13).
//! Jobs arrive as flat f64 records (Appendix D §3.1); results are JSON in the output buffer.

use gw_abi::{set_out_json, slice, slice_mut, status, Error, Json, Result};
use gw_adjust::block::{adjust, AxisStats, ImageIn, ObsIn, Options, PointIn, PointKind};
use gw_adjust::rpcfit::{fit_rpc, FitSpec};
use gw_match::dsm::{dsm_tile, warp_affine, Lut, PostGrid};
use gw_match::sgm::SgmParams;
use gw_match::orb::orb_match;
use gw_match::{harris, lsm, ncc_search, Win};
use gw_sensor::adjusted::{Adjusted, BiasKind, ImageBias};
use gw_sensor::rpc::{Rpc, RPC_RECORD_LEN};
use gw_sensor::{Ground, SensorModel};
use std::rc::Rc;

gw_abi::export_abi!();

/// Values per image in the job: model type, RPC record, bias kind, fixed, cx, cy, hx, hy, prior σ.
const IMAGE_LEN: usize = 1 + RPC_RECORD_LEN + 7;
const POINT_LEN: usize = 6;
const OBS_LEN: usize = 5;

fn model_from(rec: &[f64]) -> Result<Rc<dyn SensorModel>> {
    match rec[0] as i32 {
        0 => Ok(Rc::new(Rpc::from_record(&rec[1..1 + RPC_RECORD_LEN])?)),
        t => Err(Error::unsupported(format!("model type {t} is not adjustable yet"))),
    }
}

fn stats_json(j: &mut Json, key: &str, s: &AxisStats) {
    j.key(key).obj().kv_int("n", s.n as i64).key("rmse").arr().num(s.rmse[0]).num(s.rmse[1]).num(s.rmse[2]).end_arr();
    j.kv_num("rmseR", s.rmse_r).kv_num("rmse3d", s.rmse_3d).kv_num("ce90", s.ce90).kv_num("le90", s.le90);
    j.key("max").arr().num(s.max[0]).num(s.max[1]).num(s.max[2]).end_arr().end_obj();
}

/// Block adjustment. Job: [version 1, nImages, nPoints, nObs, maxIterations, rejectK,
/// maxReject], then images (type 0 = RPC record, bias kind 0/1/2, fixed, cx, cy, hx, hy,
/// prior σ px), points (kind 0 tie / 1 GCP / 2 checkpoint, lat, lon, h (NaN if unknown),
/// σH, σV), observations (image, point, x, y, σ px).
/// # Safety
/// `job` must hold `len` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_adjust_block(job: *const f64, len: usize) -> i32 {
    let a = slice(job, len);
    status((|| {
        if a.len() < 7 || a[0] != 1.0 {
            return Err(Error::invalid("block job: bad header"));
        }
        let (ni, np, no) = (a[1] as usize, a[2] as usize, a[3] as usize);
        if a.len() != 7 + ni * IMAGE_LEN + np * POINT_LEN + no * OBS_LEN {
            return Err(Error::invalid("block job: length does not match its counts"));
        }
        let opts = Options { max_iterations: (a[4] as usize).clamp(1, 500), reject_k: if a[5] > 0.0 { a[5] } else { 3.0 }, max_reject: a[6].max(0.0) as usize };
        let mut o = 7;
        let mut images = Vec::with_capacity(ni);
        for _ in 0..ni {
            let r = &a[o..o + IMAGE_LEN];
            let t = 1 + RPC_RECORD_LEN;
            let kind = BiasKind::from_i32(r[t] as i32).ok_or_else(|| Error::invalid("unknown bias kind"))?;
            images.push(ImageIn { model: model_from(r)?, kind, fixed: r[t + 1] != 0.0, centre: (r[t + 2], r[t + 3]), half: (r[t + 4].max(1.0), r[t + 5].max(1.0)), prior_sigma_px: r[t + 6].max(0.0) });
            o += IMAGE_LEN;
        }
        let mut points = Vec::with_capacity(np);
        for _ in 0..np {
            let r = &a[o..o + POINT_LEN];
            let kind = match r[0] as i32 {
                1 => PointKind::Gcp,
                2 => PointKind::Check,
                _ => PointKind::Tie,
            };
            let known = (r[1].is_finite() && r[2].is_finite() && r[3].is_finite()).then_some(Ground { lat: r[1], lon: r[2], h: r[3] });
            points.push(PointIn { kind, known, sigma_h: r[4], sigma_v: r[5] });
            o += POINT_LEN;
        }
        let obs: Vec<ObsIn> = a[o..].chunks_exact(OBS_LEN).map(|r| ObsIn { image: r[0] as usize, point: r[1] as usize, x: r[2], y: r[3], sigma_px: r[4] }).collect();
        let s = adjust(&images, &points, &obs, &opts)?;
        let mut j = Json::new();
        j.obj().kv_num("sigma0", s.sigma0).kv_int("dof", s.dof).kv_int("iterations", s.iterations as i64).kv_bool("converged", s.converged);
        j.key("rejected").arr();
        for k in &s.rejected {
            j.int(*k as i64);
        }
        j.end_arr().key("unused").arr();
        for k in &s.unused_points {
            j.int(*k as i64);
        }
        j.end_arr().key("images").arr();
        for (b, c) in s.biases.iter().zip(&s.bias_cov) {
            j.obj().key("c").arr();
            for v in b.c {
                j.num(v);
            }
            j.end_arr().key("cov").arr();
            for v in c {
                j.num(*v);
            }
            j.end_arr().end_obj();
        }
        j.end_arr().key("points").arr();
        for (g, c) in s.points.iter().zip(&s.point_cov) {
            match g {
                Some(g) => {
                    j.obj().kv_num("lat", g.lat).kv_num("lon", g.lon).kv_num("h", g.h).key("cov").arr();
                    for row in c {
                        for v in row {
                            j.num(*v);
                        }
                    }
                    j.end_arr().end_obj();
                }
                None => {
                    j.null();
                }
            }
        }
        j.end_arr().key("residuals").arr();
        for r in &s.residuals {
            j.arr().num(r.v.0).num(r.v.1).num(r.normalized).bool(r.flagged).bool(r.rejected).end_arr();
        }
        j.end_arr();
        stats_json(&mut j, "before", &s.checkpoints_before);
        stats_json(&mut j, "after", &s.checkpoints_after);
        j.key("gcp").arr();
        for (k, d) in &s.gcp_residuals {
            j.arr().int(*k as i64).num(d[0]).num(d[1]).num(d[2]).end_arr();
        }
        j.end_arr().end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Fit an RPC00B to a (possibly bias-adjusted) model. Job: [type 0, RPC record, c[6], cx, cy,
/// hx, hy, lat0, lat1, lon0, lon1, h0, h1, width, height, errBias, errRand]. JSON {record,
/// rmsPx, maxPx, minDenominator, poleFree}.
/// # Safety
/// `job` must hold `len` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_fit_rpc(job: *const f64, len: usize) -> i32 {
    let a = slice(job, len);
    status((|| {
        let t = 1 + RPC_RECORD_LEN;
        if a.len() != t + 20 {
            return Err(Error::invalid("RPC fit job: wrong length"));
        }
        let base = model_from(a)?;
        let r = &a[t..];
        let adj = Adjusted { base, bias: ImageBias { c: [r[0], r[1], r[2], r[3], r[4], r[5]], centre: (r[6], r[7]), half: (r[8].max(1.0), r[9].max(1.0)) }, sigma: None, name: "adjusted".into() };
        let f = fit_rpc(&adj, &FitSpec { lat: (r[10], r[11]), lon: (r[12], r[13]), h: (r[14], r[15]), width: r[16], height: r[17], err_bias: r[18], err_rand: r[19], lambda: 1e-6 })?;
        let mut j = Json::new();
        j.obj().key("record").arr();
        for v in &f.record {
            j.num(*v);
        }
        j.end_arr().kv_num("rmsPx", f.rms_px).kv_num("maxPx", f.max_px).kv_num("minDenominator", f.min_denominator).kv_bool("poleFree", f.pole_free).end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Fit an RPC00B to one video frame (REQ-FMV-09). Job: [mode, model…, lat0, lat1, lon0, lon1, h0,
/// h1, width, height]. Mode 0, the KLV frame model: [sensor lat, lon, HAE, heading, pitch, roll,
/// relative az, el, roll, HFOV] (with width, height from the tail). Mode 1, a projective model
/// through the four footprint corners: [x, y, lat, lon] × 4. JSON as `gw_fit_rpc`.
/// # Safety
/// `job` must hold `len` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_fit_rpc_klv(job: *const f64, len: usize) -> i32 {
    let a = slice(job, len);
    status((|| {
        let (model, tail): (Box<dyn SensorModel>, &[f64]) = match (a.first().map(|m| *m as i32), a.len()) {
            (Some(0), 19) => (Box::new(gw_sensor::frame::FrameModel::from_klv(gw_sensor::Ground { lat: a[1], lon: a[2], h: a[3] }, [a[4], a[5], a[6]], [a[7], a[8], a[9]], a[10], a[17], a[18], "KLV frame")?), &a[11..]),
            (Some(1), 25) => {
                let g: Vec<gw_sensor::gcp::Gcp> = (0..4).map(|k| gw_sensor::gcp::Gcp { x: a[1 + 4 * k], y: a[2 + 4 * k], lat: a[3 + 4 * k], lon: a[4 + 4 * k] }).collect();
                (Box::new(gw_sensor::gcp::ProjectiveModel::fit(&g, "footprint")?), &a[17..])
            }
            _ => return Err(Error::invalid("frame RPC fit job: mode 0 takes 19 values, mode 1 takes 25")),
        };
        let f = fit_rpc(model.as_ref(), &FitSpec { lat: (tail[0], tail[1]), lon: (tail[2], tail[3]), h: (tail[4], tail[5]), width: tail[6], height: tail[7], err_bias: -1.0, err_rand: -1.0, lambda: 1e-6 })?;
        let mut j = Json::new();
        j.obj().key("record").arr();
        for v in &f.record {
            j.num(*v);
        }
        j.end_arr().kv_num("rmsPx", f.rms_px).kv_num("maxPx", f.max_px).kv_num("minDenominator", f.min_denominator).kv_bool("poleFree", f.pole_free).end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Descriptor matching between two windows (REQ-SNS-21): ORB features, mutual ratio-test matches
/// and a RANSAC affine b = A·(a, 1). JSON {affine, pairs: [[ax, ay, bx, by]…], features, candidates},
/// or {affine: null} when no consistent match is found.
/// # Safety
/// `a` must hold aw·ah f32 and `b` bw·bh f32.
#[no_mangle]
pub unsafe extern "C" fn gw_orb_match(a: *const f32, aw: usize, ah: usize, b: *const f32, bw: usize, bh: usize, n: usize, ratio: f64, tol: f64) -> i32 {
    let wa = Win { w: aw, h: ah, px: std::slice::from_raw_parts(a, aw * ah) };
    let wb = Win { w: bw, h: bh, px: std::slice::from_raw_parts(b, bw * bh) };
    status((|| {
        let mut j = Json::new();
        j.obj();
        match orb_match(wa, wb, n.clamp(16, 4000), ratio, tol) {
            Some(m) => {
                j.key("affine").arr();
                for v in m.affine {
                    j.num(v);
                }
                j.end_arr().key("pairs").arr();
                for p in &m.pairs {
                    j.arr();
                    for v in p {
                        j.num(*v);
                    }
                    j.end_arr();
                }
                j.end_arr().key("features").arr().num(m.features.0 as f64).num(m.features.1 as f64).end_arr().kv_num("candidates", m.candidates as f64);
            }
            None => {
                j.key("affine").null();
            }
        }
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    })())
}

/// Harris corners of a window: up to n of them into `out` as (x, y, score); returns the count.
/// # Safety
/// `img` must hold w·h f32 and `out` 3n f64.
#[no_mangle]
pub unsafe extern "C" fn gw_harris(img: *const f32, w: usize, h: usize, n: usize, border: usize, min_dist: f64, out: *mut f64) -> i32 {
    let px = std::slice::from_raw_parts(img, w * h);
    let o = slice_mut(out, 3 * n);
    let c = harris(Win { w, h, px }, n, border, min_dist);
    for (k, p) in c.iter().enumerate() {
        o[3 * k] = p.x;
        o[3 * k + 1] = p.y;
        o[3 * k + 2] = p.score;
    }
    c.len() as i32
}

/// Match a template into a search window: NCC, then LSM when `refine` is set.
/// `out` = (x, y, ncc, ratio, lsm σ, lsm score, ok) with x, y in search-window pixels.
/// # Safety
/// `tpl` must hold tw·th f32, `srch` sw·sh f32, `out` 7 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_match_point(tpl: *const f32, tw: usize, th: usize, srch: *const f32, sw: usize, sh: usize, refine: i32, out: *mut f64) -> i32 {
    let t = Win { w: tw, h: th, px: std::slice::from_raw_parts(tpl, tw * th) };
    let s = Win { w: sw, h: sh, px: std::slice::from_raw_parts(srch, sw * sh) };
    let o = slice_mut(out, 7);
    o.iter_mut().for_each(|v| *v = f64::NAN);
    o[6] = 0.0;
    let Some(m) = ncc_search(t, s) else { return gw_abi::OK };
    o[0] = m.x;
    o[1] = m.y;
    o[2] = m.score;
    o[3] = m.ratio;
    o[6] = 1.0;
    if refine != 0 {
        match lsm(t, s, m.x, m.y) {
            Some(l) if l.converged && (l.x - m.x).abs() < 2.0 && (l.y - m.y).abs() < 2.0 => {
                o[0] = l.x;
                o[1] = l.y;
                o[4] = l.sigma;
                o[5] = l.score;
            }
            _ => o[6] = 0.5, // NCC only
        }
    }
    gw_abi::OK
}

/// One DSM tile (REQ-DEM-04). `prm` = [W, H, A_L(6), A_R(6), lx0, ly0, lw, lh, rx0, ry0, rw, rh,
/// dmin, dmax, pyramid factor, radius, P1, P2, uniqueness, LR tolerance, speckle size,
/// gu, gv, gd, lat0, lon0, dlat, dlon, nx, ny, census half-width, census half-height, then the lookup (gu·gv·gd × lat, lon, h)];
/// `left`/`right` are the source patches. Output (f32): matched, pixels, then sum, count,
/// matched FOM and unmatched FOM per post (nx·ny each).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_dsm_tile(prm: *const f64, plen: usize, left: *const f32, llen: usize, right: *const f32, rlen: usize) -> i32 {
    let a = slice(prm, plen);
    status((|| {
        if a.len() < 42 {
            return Err(Error::invalid("DSM tile: short parameter record"));
        }
        let (w, h) = (a[0] as usize, a[1] as usize);
        let aff = |o: usize| -> [f64; 6] { [a[o], a[o + 1], a[o + 2], a[o + 3], a[o + 4], a[o + 5]] };
        let (al, ar) = (aff(2), aff(8));
        let (lx0, ly0, lw, lh) = (a[14], a[15], a[16] as usize, a[17] as usize);
        let (rx0, ry0, rw, rh) = (a[18], a[19], a[20] as usize, a[21] as usize);
        let (dmin, dmax, pyr, radius) = (a[22] as i32, a[23] as i32, (a[24] as usize).max(1), (a[25] as i32).max(1));
        let p = SgmParams { p1: a[26] as u16, p2: a[27] as u16, uniqueness: a[28] as f32, lr_tol: a[29] as f32, speckle_size: a[30] as usize, census: (a[40] as usize, a[41] as usize) };
        let (gu, gv, gd) = (a[31] as usize, a[32] as usize, a[33] as usize);
        let grid = PostGrid { lat0: a[34], lon0: a[35], dlat: a[36], dlon: a[37], nx: a[38] as usize, ny: a[39] as usize };
        // A 43rd header value selects the engine (0 SGM, 1 NCC Fast, REQ-DEM-05).
        let hdr = if (a.len() - 42) % 3 == 0 { 42 } else { 43 };
        let engine = if hdr == 43 { a[42] as u32 } else { 0 };
        if w * h == 0 || w * h > 4096 * 4096 || gu < 2 || gv < 2 || gd < 2 || a.len() != hdr + gu * gv * gd * 3 || llen != lw * lh || rlen != rw * rh || grid.nx * grid.ny > 64 << 20 || dmax <= dmin {
            return Err(Error::invalid("DSM tile: inconsistent sizes"));
        }
        let lut = Lut { gu, gv, gd, w: w as f64, h: h as f64, dmin: f64::from(dmin), dmax: f64::from(dmax), v: a[hdr..].chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect() };
        let lp = std::slice::from_raw_parts(left, llen);
        let rp = std::slice::from_raw_parts(right, rlen);
        let lt = warp_affine(lp, lw, lh, lx0, ly0, &al, w, h);
        let rt = warp_affine(rp, rw, rh, rx0, ry0, &ar, w, h);
        let o = dsm_tile(&lt, &rt, w, h, dmin, dmax, pyr, radius, &p, &lut, &grid, engine);
        let n = grid.nx * grid.ny;
        let mut v: Vec<f32> = Vec::with_capacity(2 + 4 * n);
        v.push(o.matched as f32);
        v.push(o.pixels as f32);
        v.extend_from_slice(&o.sum);
        v.extend_from_slice(&o.count);
        v.extend(o.fom_matched.iter().map(|x| f32::from(*x)));
        v.extend(o.fom_unmatched.iter().map(|x| f32::from(*x)));
        let mut bytes = Vec::with_capacity(v.len() * 4);
        for x in v {
            bytes.extend_from_slice(&x.to_le_bytes());
        }
        gw_abi::set_out(bytes);
        Ok(())
    })())
}
