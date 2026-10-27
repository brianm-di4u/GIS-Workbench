//! `spectral` bundle (lazy; analysis worker): band statistics and SNR, training statistics and
//! separability, supervised and unsupervised classification and clean-up, accuracy, RX/MF/ACE/
//! CEM/GMM, PCA/MNF/ICA/decorrelation/unmixing, DOS/ELM/IARR, brightness temperature, library
//! resampling and continuum removal, destriping, change vectors and template matching
//! (REQ-MSI-05..14, 16; REQ-EXT-28).
//!
//! Cubes are BIP f32. Every output is `[u32 json length][json][padding to 4][sections…]` where
//! the JSON lists the sections {name, type ('f32'|'u8'), len} in order.

use gw_abi::{set_out, slice, status, Error, Json, Result};
use gw_spectral::stats::Cube;
use gw_spectral::{accuracy, classify, detect, misc, stats, transform};

gw_abi::export_abi!();

enum Sec<'a> {
    F32(&'a str, &'a [f32]),
    U8(&'a str, &'a [u8]),
}

fn pack(mut j: Json, secs: &[Sec]) -> Vec<u8> {
    j.key("sections").arr();
    for s in secs {
        match s {
            Sec::F32(n, v) => j.obj().kv_str("name", n).kv_str("type", "f32").kv_int("len", v.len() as i64).end_obj(),
            Sec::U8(n, v) => j.obj().kv_str("name", n).kv_str("type", "u8").kv_int("len", v.len() as i64).end_obj(),
        };
    }
    j.end_arr().end_obj();
    let jb = j.finish().into_bytes();
    let mut o = Vec::new();
    o.extend_from_slice(&(jb.len() as u32).to_le_bytes());
    o.extend_from_slice(&jb);
    for s in secs {
        while o.len() % 4 != 0 {
            o.push(b' ');
        }
        match s {
            Sec::F32(_, v) => v.iter().for_each(|x| o.extend_from_slice(&x.to_le_bytes())),
            Sec::U8(_, v) => o.extend_from_slice(v),
        }
    }
    o
}

fn cube<'a>(p: &[f64], v: &'a [f32]) -> Result<Cube<'a>> {
    let (w, h, nb) = (p[0] as usize, p[1] as usize, p[2] as usize);
    if w == 0 || h == 0 || nb == 0 || w.checked_mul(h).and_then(|x| x.checked_mul(nb)) != Some(v.len()) || nb > 1024 {
        return Err(Error::invalid("spectral: cube size does not match w × h × bands"));
    }
    Ok(Cube { v, nb, w, h })
}

fn nums(j: &mut Json, k: &str, v: &[f64]) {
    j.key(k).arr();
    for x in v {
        j.num(*x);
    }
    j.end_arr();
}

/// Training sets from `[n0, n1, …]` counts and the concatenated pixel indices.
fn sets(counts: &[f64], idx: &[f64], npx: usize) -> Result<Vec<Vec<usize>>> {
    let mut out = Vec::new();
    let mut o = 0;
    for &c in counts {
        let c = c as usize;
        let s: Vec<usize> = idx.get(o..o + c).ok_or_else(|| Error::invalid("spectral: truncated training indices"))?.iter().map(|&v| v as usize).filter(|&v| v < npx).collect();
        out.push(s);
        o += c;
    }
    Ok(out)
}

/// Band statistics and SNR. `prm` = [w, h, nb].
/// # Safety
/// `v` must hold n f32, `prm` 3 f64.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_stats(prm: *const f64, v: *const f32, n: usize) -> i32 {
    let p = slice(prm, 3);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let bs = stats::band_stats(&c);
        let sn = stats::snr(&c);
        let mut j = Json::new();
        j.obj().key("bands").arr();
        for (b, s) in bs.iter().enumerate() {
            j.obj().kv_num("min", s[0]).kv_num("max", s[1]).kv_num("mean", s[2]).kv_num("std", s[3]).kv_num("n", s[4]).kv_num("snr", sn[b]).end_obj();
        }
        j.end_arr();
        set_out(pack(j, &[]));
        Ok(())
    })())
}

/// Training statistics and pairwise Jeffries–Matusita separability. `prm` = [w, h, nb, k,
/// counts ×k]; `idx` = concatenated pixel indices.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_train(prm: *const f64, plen: usize, v: *const f32, n: usize, idx: *const f64, nidx: usize) -> i32 {
    let p = slice(prm, plen);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let k = p[3] as usize;
        let s = sets(p.get(4..4 + k).ok_or_else(|| Error::invalid("spectral: counts"))?, slice(idx, nidx), c.n())?;
        let cls = classify::train(&c, &s);
        let mut j = Json::new();
        j.obj().key("classes").arr();
        for cl in &cls {
            j.obj().kv_int("n", cl.n as i64);
            nums(&mut j, "mean", &cl.mean);
            let sd: Vec<f64> = (0..c.nb).map(|b| cl.cov.at(b, b).max(0.0).sqrt()).collect();
            nums(&mut j, "std", &sd);
            j.end_obj();
        }
        j.end_arr().key("jm").arr();
        for a in &cls {
            j.arr();
            for b in &cls {
                j.num(stats::jeffries_matusita(&a.mean, &a.cov, &b.mean, &b.cov));
            }
            j.end_arr();
        }
        j.end_arr();
        set_out(pack(j, &[]));
        Ok(())
    })())
}

/// Supervised classification. `prm` = [w, h, nb, method (0 MD, 1 ML, 2 Mahalanobis, 3 SAM,
/// 4 SID), threshold (NaN = none), k, counts ×k]. Training from `idx`, or class means given
/// directly in `means` (k × nb, for library/SAM signatures) when `nmeans` > 0.
/// Output sections: labels (u8), scores (f32).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_classify(prm: *const f64, plen: usize, v: *const f32, n: usize, idx: *const f64, nidx: usize, means: *const f64, nmeans: usize) -> i32 {
    let p = slice(prm, plen);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let m = classify::Method::from_code(p[3] as i32).ok_or_else(|| Error::invalid("spectral: unknown method"))?;
        let k = p[5] as usize;
        let mut cls = if nmeans > 0 {
            Vec::new()
        } else {
            classify::train(&c, &sets(p.get(6..6 + k).ok_or_else(|| Error::invalid("spectral: counts"))?, slice(idx, nidx), c.n())?)
        };
        if nmeans > 0 {
            let mv = slice(means, nmeans);
            for q in 0..k {
                let mean = mv.get(q * c.nb..(q + 1) * c.nb).ok_or_else(|| Error::invalid("spectral: means"))?.to_vec();
                cls.push(classify::Class { mean, cov: gw_spectral::linalg::Sym::zeros(c.nb), inv: gw_spectral::linalg::Sym::zeros(c.nb), logdet: 0.0, n: 1 });
            }
            if !matches!(m, classify::Method::Sam | classify::Method::Sid | classify::Method::MinDistance) {
                return Err(Error::invalid("spectral: signatures without training pixels classify by SAM, SID or minimum distance only"));
            }
        }
        let (labels, scores) = classify::classify(&c, &cls, m, p[4]);
        let mut j = Json::new();
        j.obj();
        set_out(pack(j, &[Sec::U8("labels", &labels), Sec::F32("scores", &scores)]));
        Ok(())
    })())
}

/// K-means (`algo` 0, prm = [w, h, nb, k, iterations, step, change]) or ISODATA (`algo` 1,
/// prm = [w, h, nb, k min, k max, iterations, change, min pixels, max σ, min distance, max
/// merges, step]). Output: centres JSON + labels (u8).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_cluster(algo: i32, prm: *const f64, plen: usize, v: *const f32, n: usize) -> i32 {
    let p = slice(prm, plen);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let (labels, centres) = if algo == 0 {
            classify::kmeans(&c, (p[3] as usize).clamp(1, 255), p[4] as usize, p[5] as usize, p[6])
        } else {
            let q = classify::Isodata { k_min: (p[3] as usize).max(1), k_max: (p[4] as usize).clamp(1, 255), iters: p[5] as usize, change: p[6], min_pixels: p[7] as usize, max_std: p[8], min_dist: p[9], max_merge: p[10] as usize, step: p[11] as usize };
            classify::isodata(&c, q)
        };
        let mut j = Json::new();
        j.obj().key("centres").arr();
        for m in &centres {
            j.arr();
            for x in m {
                j.num(*x);
            }
            j.end_arr();
        }
        j.end_arr();
        set_out(pack(j, &[Sec::U8("labels", &labels)]));
        Ok(())
    })())
}

/// Post-classification clean-up: op 0 majority (param = window), 1 sieve (param = minimum
/// pixels), 2 fill. Output: labels (u8).
/// # Safety
/// `l` must hold w·h bytes.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_post(op: i32, w: f64, h: f64, param: f64, l: *const u8, n: usize) -> i32 {
    status((|| {
        let (w, h) = (w as usize, h as usize);
        if w * h != n {
            return Err(Error::invalid("spectral: label size"));
        }
        let lab = slice(l, n);
        let out = match op {
            0 => classify::majority(lab, w, h, param as usize),
            1 => classify::sieve(lab, w, h, param as usize),
            2 => classify::fill(lab, w, h),
            _ => return Err(Error::invalid("spectral: unknown clean-up")),
        };
        let mut j = Json::new();
        j.obj();
        set_out(pack(j, &[Sec::U8("labels", &out)]));
        Ok(())
    })())
}

/// Accuracy from reference and mapped labels (1-based, 0 = none); `weights` = mapped-area
/// weights per class (nw = 0: none).
/// # Safety
/// `r` and `m` must hold n bytes, `wts` nw f64.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_accuracy(k: i32, r: *const u8, m: *const u8, n: usize, wts: *const f64, nw: usize) -> i32 {
    status((|| {
        let k = (k as usize).clamp(1, 254);
        let wv = if nw > 0 { Some(slice(wts, nw)) } else { None };
        let a = accuracy::assess(slice(r, n), slice(m, n), k, wv);
        let mut j = Json::new();
        j.obj().kv_int("k", a.k as i64).kv_int("n", a.n as i64).kv_num("oa", a.oa).kv_num("kappa", a.kappa).kv_num("quantity", a.quantity).kv_num("allocation", a.allocation);
        nums(&mut j, "producers", &a.producers);
        nums(&mut j, "users", &a.users);
        j.key("matrix").arr();
        for row in a.matrix.chunks(k + 1) {
            j.arr();
            for v in row {
                j.int(*v as i64);
            }
            j.end_arr();
        }
        j.end_arr();
        match a.oa_area {
            Some((o, ci)) => j.key("oaArea").arr().num(o).num(ci).end_arr(),
            None => j.key("oaArea").null(),
        };
        set_out(pack(j, &[]));
        Ok(())
    })())
}

/// Anomaly and target detection. kind 0 global RX, 1 local RX, 2 MF/ACE/CEM (target `t`),
/// 3 GMM. `prm` = [w, h, nb, step, outer | k, guard | iterations].
/// Output: scores (f32), or mf, ace, cem.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_detect(kind: i32, prm: *const f64, v: *const f32, n: usize, t: *const f64, nt: usize) -> i32 {
    let p = slice(prm, 6);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let step = (p[3] as usize).max(1);
        let j = {
            let mut j = Json::new();
            j.obj();
            j
        };
        match kind {
            0 => set_out(pack(j, &[Sec::F32("scores", &detect::rx_global(&c, step))])),
            1 => set_out(pack(j, &[Sec::F32("scores", &detect::rx_local(&c, (p[4] as usize).max(3), p[5] as usize, step))])),
            2 => {
                let tv = slice(t, nt);
                if tv.len() != c.nb {
                    return Err(Error::invalid("spectral: the target has a different number of bands"));
                }
                let (mf, ace, cem) = detect::target(&c, tv, step);
                set_out(pack(j, &[Sec::F32("mf", &mf), Sec::F32("ace", &ace), Sec::F32("cem", &cem)]));
            }
            3 => set_out(pack(j, &[Sec::F32("scores", &detect::gmm(&c, (p[4] as usize).clamp(1, 12), (p[5] as usize).max(1), step))])),
            _ => return Err(Error::invalid("spectral: unknown detector")),
        }
        Ok(())
    })())
}

/// Transforms: kind 0 PCA, 1 MNF (prm = [w, h, nb, k, step]; JSON values/vectors/mean + the
/// projected k-band cube), 2 decorrelation stretch, 3 FastICA (prm k, iterations, step),
/// 4 unmixing (endmembers `e`, m × nb; prm[3] = m).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_transform(kind: i32, prm: *const f64, v: *const f32, n: usize, e: *const f64, ne: usize) -> i32 {
    let p = slice(prm, 6);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let mut j = Json::new();
        j.obj();
        match kind {
            0 | 1 => {
                let t = if kind == 0 { transform::pca(&c, (p[4] as usize).max(1)) } else { transform::mnf(&c, (p[4] as usize).max(1)) };
                nums(&mut j, "values", &t.values);
                nums(&mut j, "vectors", &t.vectors);
                nums(&mut j, "mean", &t.mean);
                let pr = transform::project(&c, &t, (p[3] as usize).max(1));
                set_out(pack(j, &[Sec::F32("cube", &pr)]));
            }
            2 => set_out(pack(j, &[Sec::F32("cube", &transform::decorrelation(&c))])),
            3 => set_out(pack(j, &[Sec::F32("cube", &transform::ica(&c, (p[3] as usize).max(1), (p[4] as usize).max(1), (p[5] as usize).max(1)))])),
            4 => {
                let m = (p[3] as usize).max(1);
                let ev = slice(e, ne);
                if ev.len() != m * c.nb {
                    return Err(Error::invalid("spectral: endmembers must be m × bands"));
                }
                set_out(pack(j, &[Sec::F32("cube", &transform::unmix(&c, ev, m))]));
            }
            _ => return Err(Error::invalid("spectral: unknown transform")),
        }
        Ok(())
    })())
}

/// Corrections: kind 0 dark objects (prm[3] = percentile), 1 mean spectrum over `idx` (IARR:
/// none, flat field: an AOI), 2 destripe (cube out), 3 change vector against cube `b`
/// (magnitude, angle). `prm` = [w, h, nb, param].
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_correct(kind: i32, prm: *const f64, v: *const f32, n: usize, aux: *const f64, naux: usize, b: *const f32, nbv: usize) -> i32 {
    let p = slice(prm, 4);
    status((|| {
        let c = cube(p, slice(v, n))?;
        let mut j = Json::new();
        j.obj();
        match kind {
            0 => {
                nums(&mut j, "dark", &misc::dark_objects(&c, p[3]));
                set_out(pack(j, &[]));
            }
            1 => {
                let ix: Vec<usize> = slice(aux, naux).iter().map(|&x| x as usize).filter(|&x| x < c.n()).collect();
                nums(&mut j, "mean", &misc::mean_spectrum(&c, if ix.is_empty() { None } else { Some(&ix) }));
                set_out(pack(j, &[]));
            }
            2 => set_out(pack(j, &[Sec::F32("cube", &misc::destripe(&c))])),
            3 => {
                let cb = cube(p, slice(b, nbv))?;
                let (m, a) = misc::change_vector(&c, &cb);
                set_out(pack(j, &[Sec::F32("magnitude", &m), Sec::F32("angle", &a)]));
            }
            _ => return Err(Error::invalid("spectral: unknown correction")),
        }
        Ok(())
    })())
}

/// Empirical line: `img` and `refl` = t targets × nb mean spectra. Output JSON gain/offset/r2.
/// # Safety
/// Both pointers must hold t·nb f64.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_elm(t: usize, nb: usize, img: *const f64, refl: *const f64) -> i32 {
    status((|| {
        if t < 2 || nb == 0 || nb > 1024 {
            return Err(Error::invalid("spectral: the empirical line needs at least two targets"));
        }
        let a = slice(img, t * nb);
        let r = slice(refl, t * nb);
        let iv: Vec<Vec<f64>> = a.chunks(nb).map(|x| x.to_vec()).collect();
        let rv: Vec<Vec<f64>> = r.chunks(nb).map(|x| x.to_vec()).collect();
        let f = misc::empirical_line(&iv, &rv);
        let mut j = Json::new();
        j.obj();
        nums(&mut j, "gain", &f.iter().map(|x| x.0).collect::<Vec<_>>());
        nums(&mut j, "offset", &f.iter().map(|x| x.1).collect::<Vec<_>>());
        nums(&mut j, "r2", &f.iter().map(|x| x.2).collect::<Vec<_>>());
        set_out(pack(j, &[]));
        Ok(())
    })())
}

/// Brightness temperature (K) of radiance samples. `prm` = [k1, k2, λ µm, emissivity].
/// # Safety
/// `l` must hold n f32.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_bt(prm: *const f64, l: *const f32, n: usize) -> i32 {
    let p = slice(prm, 4);
    let v = slice(l, n);
    let out: Vec<f32> = v.iter().map(|&x| if x.is_finite() && x > 0.0 { misc::brightness_temperature(x as f64, p[0], p[1], p[2], p[3]) as f32 } else { f32::NAN }).collect();
    let mut j = Json::new();
    j.obj();
    set_out(pack(j, &[Sec::F32("kelvin", &out)]));
    0
}

/// Library spectrum → sensor bands (Gaussian SRFs) and its continuum-removed form.
/// `lib` = [n, wavelengths ×n, values ×n]; `bands` = [m, centres ×m, fwhm ×m] (µm).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_resample(lib: *const f64, nl: usize, bands: *const f64, nbands: usize) -> i32 {
    let l = slice(lib, nl);
    let b = slice(bands, nbands);
    status((|| {
        let n = *l.first().ok_or_else(|| Error::invalid("spectral: library"))? as usize;
        let m = *b.first().ok_or_else(|| Error::invalid("spectral: bands"))? as usize;
        if l.len() < 1 + 2 * n || b.len() < 1 + 2 * m {
            return Err(Error::invalid("spectral: truncated spectrum"));
        }
        let (wl, val) = (&l[1..1 + n], &l[1 + n..1 + 2 * n]);
        let (cw, fw) = (&b[1..1 + m], &b[1 + m..1 + 2 * m]);
        let mut j = Json::new();
        j.obj();
        nums(&mut j, "resampled", &misc::resample(wl, val, cw, fw));
        nums(&mut j, "continuum", &misc::continuum_removed(wl, val));
        set_out(pack(j, &[]));
        Ok(())
    })())
}

/// Template matching (REQ-EXT-28): NCC of a tw × th template over a w × h band.
/// Output: ncc (f32, (w − tw + 1) × (h − th + 1)).
/// # Safety
/// `img` must hold w·h f32 and `t` tw·th f32.
#[no_mangle]
pub unsafe extern "C" fn gw_spec_template(w: f64, h: f64, img: *const f32, tw: f64, th: f64, t: *const f32) -> i32 {
    let (w, h, tw, th) = (w as usize, h as usize, tw as usize, th as usize);
    status((|| {
        if w * h > 64 << 20 || tw * th > 1 << 20 {
            return Err(Error::limit("spectral: template search too large"));
        }
        let r = misc::template_ncc(slice(img, w * h), w, h, slice(t, tw * th), tw, th);
        let mut j = Json::new();
        j.obj().kv_int("w", (w + 1).saturating_sub(tw) as i64).kv_int("h", (h + 1).saturating_sub(th) as i64);
        set_out(pack(j, &[Sec::F32("ncc", &r)]));
        Ok(())
    })())
}
