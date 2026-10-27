//! `sar` bundle (lazy; analysis worker): speckle filters (REQ-SAR-07), amplitude change
//! (REQ-SAR-08), CCD with registration, flat-earth removal, CNR mask and Goldstein filtering
//! (REQ-SAR-09/14), the pair finder (REQ-SAR-10), sub-apertures and CSI (REQ-SAR-11) and Pauli
//! composites (REQ-SAR-13). Complex inputs are interleaved f32 (re, im). Multi-array outputs are
//! `[u32 json length][json][padding to 4][f32 arrays…]`.

use gw_abi::{set_out, slice, status, Error, Json, Result};
use gw_sar::change::{coherence, fringe_frequency, goldstein, log_ratio, remove_ramp};
use gw_sar::fft::Cx;
use gw_sar::pairs::{find, Collect, Limits};
use gw_sar::register::{fit_affine, offsets_complex, resample};
use gw_sar::speckle::{filter, Filter};
use gw_sar::subap::{csi, pauli, subaperture};

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
