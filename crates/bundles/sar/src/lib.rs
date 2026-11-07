//! `sar` bundle (lazy; analysis worker): speckle filters (REQ-SAR-07), amplitude change
//! (REQ-SAR-08), CCD with registration, flat-earth removal, CNR mask and Goldstein filtering
//! (REQ-SAR-09/14), the pair finder (REQ-SAR-10), sub-apertures and CSI (REQ-SAR-11) and Pauli
//! composites (REQ-SAR-13), polarimetry (REQ-GAP-40) and radargrammetry (REQ-GAP-42). Complex
//! inputs are interleaved f32 (re, im). Multi-array outputs are
//! `[u32 json length][json][padding to 4][f32 arrays…]`.

use gw_abi::{set_out, slice, status, Error, Json, Result};
use gw_sar::change::{coherence, fringe_frequency, goldstein, log_ratio, remove_ramp};
use gw_sar::fft::Cx;
use gw_sar::pairs::{find, Collect, Limits};
use gw_sar::register::{fit_affine, offsets_complex, resample};
use gw_sar::speckle::{filter, Filter};
use gw_sar::subap::{csi, pauli, subaperture};
use gw_sar::polsar;

gw_abi::export_abi!();

fn cplx(a: &[f32]) -> Vec<Cx> {
    a.chunks_exact(2).map(|c| Cx::new(c[0] as f64, c[1] as f64)).collect()
}

fn f32_bytes(v: &[f32]) -> Vec<u8> {
    let mut o = Vec::with_capacity(v.len() * 4);
    for x in v {
        o.extend_from_slice(&x.to_le_bytes());
    }
    o
}

fn packed(json: String, arrays: &[&[f32]]) -> Vec<u8> {
    let jb = json.into_bytes();
    let mut o = Vec::new();
    o.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    o.extend_from_slice(&jb);
    while o.len() % 4 != 0 {
        o.push(b' ');
    }
    for a in arrays {
        o.extend(f32_bytes(a));
    }
    o
}

fn dims(w: f64, h: f64, n: usize, per: usize) -> Result<(usize, usize)> {
    let (w, h) = (w as usize, h as usize);
    if w == 0 || h == 0 || w.checked_mul(h).and_then(|x| x.checked_mul(per)) != Some(n) || w * h > 64 << 20 {
        return Err(Error::invalid("sar: array size does not match the dimensions"));
    }
    Ok((w, h))
}

/// Speckle filter on intensity. kind 0 mean, 1 median, 2 Lee, 3 Kuan, 4 Gamma-MAP, 5 Frost,
/// 6 Refined Lee. Output: f32 w·h.
/// # Safety
/// `v` must hold `n` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_speckle(kind: i32, win: i32, looks: f64, damping: f64, w: f64, h: f64, v: *const f32, n: usize) -> i32 {
    status((|| {
        let f = Filter::from_code(kind).ok_or_else(|| Error::invalid("sar: unknown filter"))?;
        let (w, h) = dims(w, h, n, 1)?;
        set_out(f32_bytes(&filter(slice(v, n), w, h, f, win.max(3) as usize, looks, damping)));
        Ok(())
    })())
}

/// Log-ratio (dB) of window-mean intensities, image 2 over image 1. Output: f32 w·h.
/// # Safety
/// `a` and `b` must hold `n` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_logratio(win: i32, w: f64, h: f64, a: *const f32, b: *const f32, n: usize) -> i32 {
    status((|| {
        let (w, h) = dims(w, h, n, 1)?;
        set_out(f32_bytes(&log_ratio(slice(a, n), slice(b, n), w, h, win.max(1) as usize)));
        Ok(())
    })())
}

/// CCD on two complex AOI chips of the same size. `prm` = [w, h, window, register (0/1),
/// tie spacing, patch, max shift, flat earth (0/1), noise power 1, noise power 2, compensate
/// (0/1), CNR threshold dB (NaN = off), Goldstein α (0 = off)]. Output: packed JSON {ties,
/// warp, rms, fringe} + [γ, phase, mean intensity 1, mean intensity 2].
/// # Safety
/// `f` and `g` must hold 2n f32; `prm` 13 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_ccd(prm: *const f64, f: *const f32, g: *const f32, n2: usize) -> i32 {
    let p = slice(prm, 13);
    status((|| {
        let (w, h) = dims(p[0], p[1], n2, 2)?;
        let fa = cplx(slice(f, n2));
        let mut gb = cplx(slice(g, n2));
        let mut j = Json::new();
        j.obj();
        // Flat earth before fine registration (a fringe ramp biases the coherent peak), then
        // again after it for the residual.
        let mut fringe = (0.0, 0.0);
        if p[3] != 0.0 && p[7] != 0.0 {
            let ifg: Vec<Cx> = fa.iter().zip(&gb).map(|(a, b)| a.mul(b.conj())).collect();
            fringe = fringe_frequency(&ifg, w, h);
            remove_ramp(&mut gb, w, h, fringe.0, fringe.1);
        }
        if p[3] != 0.0 {
            // Coherent registration on the complex chips (exact for band-limited data).
            let ties = offsets_complex(&fa, &gb, w, h, p[4].max(16.0) as usize, p[5].max(16.0) as usize, p[6].max(1.0));
            let fit = fit_affine(&ties);
            j.key("ties").arr();
            for t in &ties {
                j.arr().num(t.x).num(t.y).num(t.dx).num(t.dy).num(t.peak).end_arr();
            }
            j.end_arr();
            match fit {
                Some((c, rms, used)) => {
                    j.key("warp").arr();
                    for v in c {
                        j.num(v);
                    }
                    j.end_arr().kv_num("rms", rms).kv_int("used", used as i64);
                    gb = resample(&gb, w, h, &c);
                }
                None => {
                    j.key("warp").null().kv_str("registrationError", "too few reliable tie offsets (the chips may not overlap or not correlate)");
                }
            }
        }
        if p[7] != 0.0 {
            let ifg: Vec<Cx> = fa.iter().zip(&gb).map(|(a, b)| if b.re.is_finite() { a.mul(b.conj()) } else { Cx::ZERO }).collect();
            let (fr, fc) = fringe_frequency(&ifg, w, h);
            remove_ramp(&mut gb, w, h, fr, fc);
            j.key("fringe").arr().num(fr + fringe.0).num(fc + fringe.1).end_arr();
        }
        let gz: Vec<Cx> = gb.iter().map(|v| if v.re.is_finite() { *v } else { Cx::ZERO }).collect();
        let mut c = coherence(&fa, &gz, w, h, p[2] as usize, (p[8].max(0.0), p[9].max(0.0)), p[10] != 0.0, p[11]);
        if p[12] > 0.0 {
            // Goldstein filtering of the interferogram changes the phase product only.
            let ifg: Vec<Cx> = fa.iter().zip(&gz).map(|(a, b)| a.mul(b.conj())).collect();
            let fl = goldstein(&ifg, w, h, p[12].min(1.0));
            c.phase = fl.iter().map(|v| v.arg() as f32).collect();
            j.kv_num("goldstein", p[12]);
        }
        j.end_obj();
        set_out(packed(j.finish(), &[&c.gamma, &c.phase, &c.i1, &c.i2]));
        Ok(())
    })())
}

/// Sub-aperture stack. `prm` = [w, h, dimension (1 columns, 0 rows), frames, fraction, fill].
/// Output: f32 frames·w·h magnitudes.
/// # Safety
/// `z` must hold 2n f32; `prm` 6 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_subaperture(prm: *const f64, z: *const f32, n2: usize) -> i32 {
    let p = slice(prm, 6);
    status((|| {
        let (w, h) = dims(p[0], p[1], n2, 2)?;
        if (p[3] as usize).clamp(1, 32) * w * h > 256 << 20 {
            return Err(Error::limit("sar: sub-aperture stack too large for an AOI chip"));
        }
        set_out(f32_bytes(&subaperture(&cplx(slice(z, n2)), w, h, p[2] as u8, p[3] as usize, p[4], p[5])));
        Ok(())
    })())
}

/// Colour sub-aperture image. `prm` = [w, h, dimension, fill]. Output: f32 3·w·h (R, G, B).
/// # Safety
/// `z` must hold 2n f32; `prm` 4 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_csi(prm: *const f64, z: *const f32, n2: usize) -> i32 {
    let p = slice(prm, 4);
    status((|| {
        let (w, h) = dims(p[0], p[1], n2, 2)?;
        set_out(f32_bytes(&csi(&cplx(slice(z, n2)), w, h, p[2] as u8, p[3])));
        Ok(())
    })())
}

/// Pauli composite from three co-registered complex chips (HH, HV, VV). Output: f32 3·n.
/// # Safety
/// Each pointer must hold 2n f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_pauli(hh: *const f32, hv: *const f32, vv: *const f32, n2: usize) -> i32 {
    status((|| {
        if n2 % 2 != 0 {
            return Err(Error::invalid("sar: complex arrays have an even length"));
        }
        set_out(f32_bytes(&pauli(&cplx(slice(hh, n2)), &cplx(slice(hv, n2)), &cplx(slice(vv, n2)))));
        Ok(())
    })())
}

/// Polarimetric matrices and decompositions (REQ-GAP-40). `prm` = [w, h, input, filter, window,
/// looks, products, rotate (0/1), H/A/α Wishart (0/1), Wishart iterations, VH present (0/1)].
/// input: 0 quad-pol complex (HH, HV, [VH], VV, interleaved f32 each), 1 C3 planes, 2 two complex
/// channels (dual-pol, co-pol first), 3 quad-pol complex simulated as compact-pol CTLR, 4 C2
/// planes, 5 T3 planes. filter: 0 none, 1 boxcar, 2 refined Lee (7 × 7). products (bits): 1 T3,
/// 2 C3, 4 Freeman–Durden, 8 Yamaguchi, 16 H/A/α, 32 Wishart, 64 dual/compact H/A/α, 128 C2,
/// 256 span. Output: packed JSON {products: [{name, planes}], wishart} + the planes in order.
/// # Safety
/// `prm` must hold `plen` f64 and `data` `n` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_polsar(prm: *const f64, plen: usize, data: *const f32, n: usize) -> i32 {
    let p = slice(prm, plen);
    status((|| {
        if p.len() < 11 {
            return Err(Error::invalid("sar: polarimetric parameters"));
        }
        let (w, h) = (p[0] as usize, p[1] as usize);
        let px = w.checked_mul(h).filter(|&v| v > 0 && v <= 16 << 20).ok_or_else(|| Error::limit("sar: polarimetric chip size"))?;
        let input = p[2] as i32;
        let has_vh = p[10] != 0.0;
        let want = p[6] as u32;
        let per = match input {
            0 | 3 => 2 * if has_vh { 4 } else { 3 },
            1 | 5 => 9,
            2 => 4,
            4 => 4,
            _ => return Err(Error::invalid("sar: unknown polarimetric input")),
        };
        if px.checked_mul(per) != Some(n) {
            return Err(Error::invalid("sar: array size does not match the dimensions"));
        }
        let d = slice(data, n);
        let ch = |k: usize| cplx(&d[k * 2 * px..(k + 1) * 2 * px]);
        let planes = |k: usize| -> polsar::Planes { polsar::Planes { w, h, k, d: d.to_vec() } };
        // Single-look (or given) matrices: 3 × 3 as T3, or 2 × 2 as C2.
        let mut m = match input {
            0 => {
                let (hh, hv) = (ch(0), ch(1));
                let (vh, vv) = if has_vh { (Some(ch(2)), ch(3)) } else { (None, ch(2)) };
                polsar::from_quad(&hh, &hv, vh.as_deref(), &vv, w, h, true)
            }
            3 => {
                let (hh, hv) = (ch(0), ch(1));
                let (vh, vv) = if has_vh { (Some(ch(2)), ch(3)) } else { (None, ch(2)) };
                let (eh, ev) = polsar::ctlr(&hh, &hv, vh.as_deref(), &vv);
                polsar::from_dual(&eh, &ev, w, h)
            }
            2 => polsar::from_dual(&ch(0), &ch(1), w, h),
            1 => polsar::convert_planes(&planes(9), true),
            5 => planes(9),
            _ => planes(4),
        };
        m = match p[3] as i32 {
            1 => polsar::boxcar(&m, (p[4].max(1.0) as usize) | 1),
            2 => polsar::refined_lee(&m, p[5]),
            _ => m,
        };
        let three = m.k == 9;
        if three && want & (64 | 128) != 0 {
            return Err(Error::invalid("sar: dual-pol products need a two-channel input"));
        }
        if !three && want & (1 | 2 | 4 | 8 | 16 | 32) != 0 {
            return Err(Error::invalid("sar: quad-pol products need a quad-pol input"));
        }
        let mut j = Json::new();
        j.obj().key("products").arr();
        let mut out: Vec<Vec<f32>> = Vec::new();
        let mut emit = |j: &mut Json, name: &str, names: &[&str], data: Vec<Vec<f32>>| {
            j.obj().kv_str("name", name).key("planes").arr();
            for s in names {
                j.str(s);
            }
            j.end_arr().end_obj();
            out.extend(data);
        };
        let split = |pl: &polsar::Planes| (0..pl.k).map(|c| pl.plane(c).to_vec()).collect::<Vec<_>>();
        let per_px = |k: usize, f: &dyn Fn(usize) -> Vec<f64>| {
            let mut o = vec![vec![0f32; px]; k];
            for i in 0..px {
                let v = f(i);
                for c in 0..k {
                    o[c][i] = v[c] as f32;
                }
            }
            o
        };
        let finite9 = |a: &[f64; 9]| a.iter().all(|v| v.is_finite());
        if want & 1 != 0 {
            emit(&mut j, "T3", &polsar::T3_PLANES, split(&m));
        }
        if want & 2 != 0 {
            emit(&mut j, "C3", &polsar::C3_PLANES, split(&polsar::convert_planes(&m, false)));
        }
        if want & 128 != 0 {
            emit(&mut j, "C2", &polsar::C2_PLANES, split(&m));
        }
        if want & 256 != 0 {
            emit(&mut j, "Span", &["Span"], vec![m.span()]);
        }
        if want & 4 != 0 {
            let o = per_px(3, &|i| {
                let t = m.m9(i);
                if finite9(&t) {
                    polsar::freeman(&polsar::convert3(&t, false)).to_vec()
                } else {
                    vec![f64::NAN; 3]
                }
            });
            emit(&mut j, "Freeman-Durden", &["Ps", "Pd", "Pv"], o);
        }
        if want & 8 != 0 {
            let rot = p[7] != 0.0;
            let o = per_px(4, &|i| {
                let t = m.m9(i);
                if finite9(&t) {
                    polsar::yamaguchi(&t, rot).to_vec()
                } else {
                    vec![f64::NAN; 4]
                }
            });
            emit(&mut j, if rot { "Yamaguchi Y4R" } else { "Yamaguchi Y4O" }, &["Ps", "Pd", "Pv", "Pc"], o);
        }
        let haa: Vec<[f64; 6]> = if want & (16 | 32) != 0 {
            (0..px).map(|i| {
                let t = m.m9(i);
                if finite9(&t) {
                    polsar::h_a_alpha(&t)
                } else {
                    [f64::NAN; 6]
                }
            }).collect()
        } else {
            Vec::new()
        };
        if want & 16 != 0 {
            emit(&mut j, "H/A/alpha", &["H", "A", "alpha"], per_px(3, &|i| haa[i][..3].to_vec()));
        }
        let mut wj = None;
        if want & 32 != 0 {
            let r = polsar::wishart(&m, &haa, p[8] != 0.0, (p[9].max(0.0) as usize).min(50), 0.01);
            emit(&mut j, if p[8] != 0.0 { "H/A/alpha Wishart" } else { "H/alpha Wishart" }, &["class"], vec![r.labels.iter().map(|&v| v as f32).collect()]);
            wj = Some(r);
        }
        if want & 64 != 0 {
            let o = per_px(3, &|i| {
                let c = [m.at(0, i), m.at(1, i), m.at(2, i), m.at(3, i)];
                if c.iter().all(|v| v.is_finite()) {
                    polsar::h_alpha2(&c)[..3].to_vec()
                } else {
                    vec![f64::NAN; 3]
                }
            });
            emit(&mut j, if input == 3 { "Compact-pol H/A/alpha" } else { "Dual-pol H/A/alpha" }, &["H", "A", "alpha"], o);
        }
        j.end_arr();
        if let Some(r) = wj {
            j.key("wishart").obj().kv_int("iterations", r.iterations as i64).kv_num("changed", r.changed).key("classes").arr();
            for c in &r.classes {
                j.obj().kv_int("label", c.label as i64).kv_int("count", c.count as i64).key("centre").arr();
                for v in c.centre {
                    j.num(v);
                }
                j.end_arr().end_obj();
            }
            j.end_arr().end_obj();
        }
        j.end_obj();
        let refs: Vec<&[f32]> = out.iter().map(|v| v.as_slice()).collect();
        set_out(packed(j.finish(), &refs));
        Ok(())
    })())
}

/// Pair finder. `prm` = [min overlap, max days, max Δincidence, max Δazimuth, then per collect:
/// family, core, mode, polarisation, side, start (s), incidence, azimuth, n footprint vertices,
/// n × (lat, lon), n matches, match core ids…]. Output JSON [{a, b, overlap, days, dInc, dAz,
/// matched, ok, reasons}] ranked.
/// # Safety
/// `prm` must hold `n` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_pairs(prm: *const f64, n: usize) -> i32 {
    let a = slice(prm, n);
    status((|| {
        if a.len() < 4 {
            return Err(Error::invalid("sar: pair finder parameters"));
        }
        let lim = Limits { min_overlap: a[0], max_days: a[1], max_incidence: a[2], max_azimuth: a[3] };
        let mut cs = Vec::new();
        let mut o = 4;
        let get = |o: usize| a.get(o).copied().ok_or_else(|| Error::invalid("sar: truncated collect"));
        while o < a.len() {
            let nf = get(o + 8)? as usize;
            if nf > 1000 {
                return Err(Error::invalid("sar: footprint too long"));
            }
            let mut fp = Vec::with_capacity(nf);
            for k in 0..nf {
                fp.push((get(o + 9 + 2 * k)?, get(o + 10 + 2 * k)?));
            }
            let mo = o + 9 + 2 * nf;
            let nm = get(mo)? as usize;
            let mut m = Vec::with_capacity(nm);
            for k in 0..nm {
                m.push(get(mo + 1 + k)? as u32);
            }
            cs.push(Collect { family: get(o)? as u32, core_name: get(o + 1)? as u32, mode: get(o + 2)? as u32, polarization: get(o + 3)? as u32, side: get(o + 4)? as u32, start: get(o + 5)?, incidence: get(o + 6)?, azimuth: get(o + 7)?, footprint: fp, matches: m });
            o = mo + 1 + nm;
        }
        let pairs = find(&cs, lim);
        let mut j = Json::new();
        j.arr();
        for p in &pairs {
            j.obj().kv_int("a", p.a as i64).kv_int("b", p.b as i64).kv_num("overlap", p.overlap).kv_num("days", p.days).kv_num("dInc", p.d_incidence).kv_num("dAz", p.d_azimuth).kv_bool("matched", p.matched).kv_bool("ok", p.ok);
            j.key("reasons").arr();
            for r in &p.reasons {
                j.str(r);
            }
            j.end_arr().end_obj();
        }
        j.end_arr();
        gw_abi::set_out_json(j.finish());
        Ok(())
    })())
}

// ---- radargrammetry (REQ-GAP-42, GR-15) ----

use gw_sar::radargram::{self, Chip, Cost, DemGrid, Job, LatLonGrid, PairLimits};
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static STEREO: RefCell<HashMap<i32, Box<Job>>> = RefCell::new(HashMap::new());
    static NEXT: RefCell<i32> = const { RefCell::new(1) };
}

/// A count or size from a parameter: finite, whole and in [lo, hi].
fn whole(v: f64, lo: usize, hi: usize, what: &'static str) -> Result<usize> {
    if v.is_finite() && v.fract() == 0.0 && v >= lo as f64 && v <= hi as f64 {
        Ok(v as usize)
    } else {
        Err(gw_abi::err!(INVALID, "radargrammetry: {what} out of range", what = what))
    }
}

fn sicd_of(rec: &[f64], name: &str) -> Result<gw_sensor::sicd::Sicd> {
    Ok(gw_sensor::sicd::Sicd::new(gw_sensor::sicd::Params::from_record(rec)?, name))
}

fn grid_of(a: &[f64], what: &'static str) -> Result<LatLonGrid> {
    Ok(LatLonGrid { lat0: a[0], lon0: a[1], dlat: a[2], dlon: a[3], nx: whole(a[4], 2, 20_000, what)?, ny: whole(a[5], 2, 20_000, what)? })
}

/// SAR stereo pair finder. `prm` = [min overlap, min angle °, max same-side angle °, max days,
/// target angle °, n, then per collect: start (s), record length m, record (m values)]. Output
/// JSON [{a, b, ok, score, overlap, days, centre {lat, lon, h}, reasons, notes, geometry {…}}],
/// ranked.
/// # Safety
/// `prm` must hold `n` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_stereo_pairs(prm: *const f64, n: usize) -> i32 {
    let a = slice(prm, n);
    status((|| {
        if a.len() < 6 {
            return Err(Error::invalid("radargrammetry: pair finder parameters"));
        }
        let lim = PairLimits { min_overlap: a[0], min_angle: a[1], max_angle_same: a[2], max_days: a[3], target_angle: a[4] };
        let count = whole(a[5], 0, 64, "collect count")?;
        let mut models = Vec::with_capacity(count);
        let mut starts = Vec::with_capacity(count);
        let mut o = 6;
        let trunc = || Error::invalid("radargrammetry: truncated collect");
        for k in 0..count {
            let start = *a.get(o).ok_or_else(trunc)?;
            let m = whole(*a.get(o + 1).ok_or_else(trunc)?, 1, 100_000, "record length")?;
            let rec = a.get(o + 2..o + 2 + m).ok_or_else(trunc)?;
            models.push(sicd_of(rec, &format!("collect {k}"))?);
            starts.push(start);
            o += 2 + m;
        }
        let pairs = radargram::find_pairs(&models, &starts, lim);
        let mut j = Json::new();
        j.arr();
        for p in &pairs {
            j.obj().kv_int("a", p.a as i64).kv_int("b", p.b as i64).kv_bool("ok", p.ok).kv_num("score", p.score).kv_num("overlap", p.overlap).kv_num("days", p.days);
            j.key("centre").obj().kv_num("lat", p.centre.lat).kv_num("lon", p.centre.lon).kv_num("h", p.centre.h).end_obj();
            j.key("reasons").arr();
            for r in &p.reasons {
                j.str(r);
            }
            j.end_arr().key("notes").arr();
            for r in &p.notes {
                j.str(r);
            }
            j.end_arr();
            match &p.geom {
                Some(g) => {
                    j.key("geometry").obj().kv_num("intersectionDeg", g.intersection_deg).kv_bool("sameSide", g.same_side).kv_num("dAzimuthDeg", g.d_azimuth_deg).kv_num("parallax", g.parallax);
                    j.key("incidenceDeg").arr().num(g.incidence_deg[0]).num(g.incidence_deg[1]).end_arr();
                    j.key("lookAzimuthDeg").arr().num(g.look_azimuth_deg[0]).num(g.look_azimuth_deg[1]).end_arr();
                    j.key("left").arr().bool(g.left[0]).bool(g.left[1]).end_arr();
                    j.end_obj();
                }
                None => {
                    j.key("geometry").null();
                }
            }
            j.end_obj();
        }
        j.end_arr();
        gw_abi::set_out_json(j.finish());
        Ok(())
    })())
}

/// Block-average amplitude (`prm[4]` not 0) or intensity samples to mean intensity. `prm` = [w,
/// h, mx, my, amplitude]. Output: packed JSON {w, h} + f32 w·h.
/// # Safety
/// `prm` must hold 5 f64 and `v` `n` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sar_multilook(prm: *const f64, v: *const f32, n: usize) -> i32 {
    let p = slice(prm, 5);
    let v = slice(v, n);
    status((|| {
        let (w, h) = (whole(p[0], 1, 1 << 20, "width")?, whole(p[1], 1, 1 << 20, "height")?);
        let (mx, my) = (whole(p[2], 1, 4096, "look factor")?, whole(p[3], 1, 4096, "look factor")?);
        let (o, ow, oh) = radargram::multilook(v, w, h, mx, my, p[4] != 0.0)?;
        set_out(packed(format!("{{\"w\":{ow},\"h\":{oh}}}"), &[&o]));
        Ok(())
    })())
}

/// Start a radargrammetric DSM job: id > 0, or minus the status. `prm` (40 f64): version 1;
/// output grid (lat0, lon0, dlat, dlon, nx, ny); prior grid (same); chip A (x0, y0, mx, my, w,
/// h); chip B; levels, half window, search m, step share, cost (0 ZNCC, 1 log-ratio), min score,
/// min margin, shift search m, anchor, mask step m, mask tolerance m, sub-cells, prior sigma m,
/// speckle filter code, lattice step. `ra`/`rb` are the SICD records, `prior` the prior heights
/// (HAE), `ca`/`cb` the mean intensities of the chips.
/// # Safety
/// Each pointer must hold its count of values.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn gw_sar_stereo_new(prm: *const f64, plen: usize, ra: *const f64, na: usize, rb: *const f64, nb: usize, prior: *const f32, np: usize, ca: *const f32, nca: usize, cb: *const f32, ncb: usize) -> i32 {
    let p = slice(prm, plen);
    let r = (|| -> Result<i32> {
        if p.len() < 40 || p[0] != 1.0 {
            return Err(Error::invalid("radargrammetry: job parameters"));
        }
        let grid = grid_of(&p[1..7], "output grid")?;
        let pg = grid_of(&p[7..13], "prior grid")?;
        let despeckle = match p[38] {
            v if v == 0.0 => 0,
            v if v == 2.0 => 2,
            v if v == 6.0 => 6,
            _ => return Err(Error::invalid("radargrammetry: unknown speckle filter")),
        };
        let chip = |o: usize, v: &[f32]| -> Result<Chip> { Chip::new(p[o], p[o + 1], p[o + 2], p[o + 3], whole(p[o + 4], 2, 1 << 20, "chip width")?, whole(p[o + 5], 2, 1 << 20, "chip height")?, v, despeckle) };
        let c_a = chip(13, slice(ca, nca))?;
        let c_b = chip(19, slice(cb, ncb))?;
        let params = radargram::Params {
            levels: whole(p[25], 0, 6, "levels")?,
            half_window: whole(p[26], 1, 12, "window")?,
            search_m: p[27],
            step_frac: p[28],
            cost: if p[29] == 1.0 { Cost::LogRatio } else { Cost::Zncc },
            min_score: p[30],
            min_margin: p[31],
            shift_search_m: p[32],
            anchor: p[33] != 0.0,
            mask_step_m: p[34],
            mask_tol: p[35],
            subs: whole(p[36], 1, 4, "sub-cells")?,
            prior_sigma: p[37],
            despeckle,
            lattice_step: whole(p[39], 1, 64, "lattice step")?,
        };
        let job = Job::new(sicd_of(slice(ra, na), "A")?, sicd_of(slice(rb, nb), "B")?, grid, DemGrid { g: pg, z: slice(prior, np).to_vec() }, c_a, c_b, params)?;
        let id = NEXT.with(|n| {
            let mut n = n.borrow_mut();
            let id = *n;
            *n = if *n >= i32::MAX - 1 { 1 } else { *n + 1 };
            id
        });
        STEREO.with(|s| s.borrow_mut().insert(id, Box::new(job)));
        Ok(id)
    })();
    match r {
        Ok(id) => id,
        Err(e) => -status::<()>(Err(e)),
    }
}

fn with_job<T>(id: i32, f: impl FnOnce(&mut Job) -> Result<T>) -> Result<T> {
    STEREO.with(|s| {
        let mut s = s.borrow_mut();
        let j = s.get_mut(&id).ok_or_else(|| Error::invalid("radargrammetry: no such job"))?;
        f(j)
    })
}

/// Run up to `n` steps of job `id` (each a bounded unit of work).
#[no_mangle]
pub extern "C" fn gw_sar_stereo_step(id: i32, n: i32) -> i32 {
    status(with_job(id, |j| {
        for _ in 0..n.max(1) {
            if j.done() {
                break;
            }
            j.step()?;
        }
        Ok(())
    }))
}

/// Progress of job `id` (0 to 1; 1 = done), or -1 for an unknown job.
#[no_mangle]
pub extern "C" fn gw_sar_stereo_progress(id: i32) -> f64 {
    with_job(id, |j| Ok(j.progress())).unwrap_or(-1.0)
}

/// Outputs of a finished job: packed JSON statistics + f32 heights (HAE), sigma, score, flags.
#[no_mangle]
pub extern "C" fn gw_sar_stereo_result(id: i32) -> i32 {
    status(with_job(id, |j| {
        if !j.done() {
            return Err(Error::invalid("radargrammetry: the job has not finished"));
        }
        let fl: Vec<f32> = j.flags.iter().map(|&v| v as f32).collect();
        set_out(packed(j.stats_json(), &[&j.heights, &j.sigma, &j.score, &fl]));
        Ok(())
    }))
}

/// Discard job `id`.
#[no_mangle]
pub extern "C" fn gw_sar_stereo_free(id: i32) {
    STEREO.with(|s| s.borrow_mut().remove(&id));
}
