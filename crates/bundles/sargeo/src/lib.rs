//! `sargeo` bundle (lazy; analysis worker): SAR geocoding and terrain correction (REQ-GAP-90,
//! REG-085, SDP-2.7 §4.21). A run is a job behind a handle: JS creates it with the orbit, the
//! image timing, the DEM and the β⁰ window, steps it a few DEM rows at a time (progress and
//! cancel between steps), then takes the values and the mask and frees it.
//!
//! Parameters, one f64 list:
//! `n, t[n], p[3n], v[3n]` (orbit), `dt, az_spacing, nb, (t0, first_line, valid_lo, valid_hi)×nb`
//! (image timing), `0, r0, dr` (slant range) or `1, dg, nr, (t, r0, g0, ng, grsr[ng], ns,
//! srgr[ns])×nr` (ground range), `w, h, lat0, lon0, dlat, dlon` (DEM), `l0, s0, kl, ks, nl, ns`
//! (window), `flatten, mask_stride, mask_step, mask_tol`. The DEM heights (HAE, `w·h` f32) and the
//! window's β⁰ (`nl·ns` f32) are their own buffers.

use gw_abi::{set_out, slice, status, Error, Result};
use gw_sargeo::{Block, Dem, GrRec, Image, Job, Opts, Orbit, Range, Window};
use std::cell::RefCell;

gw_abi::export_abi!();

thread_local! {
    static JOBS: RefCell<Vec<Option<Job>>> = const { RefCell::new(Vec::new()) };
}

/// The largest DEM or window a job takes (posts or pixels), as the worker's memory allows.
const MAX_CELLS: usize = 48_000_000;

struct Rd<'a> {
    v: &'a [f64],
    i: usize,
}

impl Rd<'_> {
    fn f(&mut self) -> Result<f64> {
        let x = *self.v.get(self.i).ok_or_else(|| Error::invalid("sargeo: the parameter list is short"))?;
        self.i += 1;
        Ok(x)
    }
    fn n(&mut self, max: usize) -> Result<usize> {
        let x = self.f()?;
        if !(x >= 0.0 && x.fract() == 0.0 && x <= max as f64) {
            return Err(Error::invalid("sargeo: a count in the parameter list is out of range"));
        }
        Ok(x as usize)
    }
    fn take(&mut self, n: usize) -> Result<Vec<f64>> {
        let end = self.i.checked_add(n).filter(|&e| e <= self.v.len()).ok_or_else(|| Error::invalid("sargeo: the parameter list is short"))?;
        let out = self.v[self.i..end].to_vec();
        self.i = end;
        Ok(out)
    }
    fn v3s(&mut self, n: usize) -> Result<Vec<[f64; 3]>> {
        Ok(self.take(3 * n)?.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    }
}

fn job(prm: &[f64], z: &[f32], beta: &[f32]) -> Result<Job> {
    let mut r = Rd { v: prm, i: 0 };
    let n = r.n(100_000)?;
    let t = r.take(n)?;
    let (p, v) = (r.v3s(n)?, r.v3s(n)?);
    let orbit = Orbit::new(t, p, v).ok_or_else(|| Error::invalid("sargeo: the orbit needs at least 4 state vectors in time order, under 10 minutes apart"))?;
    let (dt, az_spacing) = (r.f()?, r.f()?);
    let nb = r.n(10_000)?;
    let mut blocks = Vec::with_capacity(nb);
    for _ in 0..nb {
        let (t0, first_line, lo, hi) = (r.f()?, r.f()?, r.f()?, r.f()?);
        blocks.push(Block { t0, first_line, valid: (lo, hi) });
    }
    let range = match r.n(1)? {
        0 => Range::Slant { r0: r.f()?, dr: r.f()? },
        _ => {
            let dg = r.f()?;
            let nr = r.n(10_000)?;
            let mut recs = Vec::with_capacity(nr);
            for _ in 0..nr {
                let (t, r0, g0) = (r.f()?, r.f()?, r.f()?);
                let ng = r.n(16)?;
                let grsr = r.take(ng)?;
                let ns = r.n(16)?;
                let srgr = r.take(ns)?;
                recs.push(GrRec { t, r0, g0, grsr, srgr });
            }
            Range::Ground { dg, recs }
        }
    };
    let img = Image { dt, blocks, range, az_spacing };
    let (w, h) = (r.n(MAX_CELLS)?, r.n(MAX_CELLS)?);
    let (lat0, lon0, dlat, dlon) = (r.f()?, r.f()?, r.f()?, r.f()?);
    if w.checked_mul(h).map_or(true, |c| c > MAX_CELLS) || z.len() != w * h {
        return Err(Error::limit("sargeo: the DEM is larger than 48 million posts, or its heights are the wrong length"));
    }
    let (l0, s0, kl, ks) = (r.f()?, r.f()?, r.f()?, r.f()?);
    let (nl, ns) = (r.n(MAX_CELLS)?, r.n(MAX_CELLS)?);
    if nl.checked_mul(ns).map_or(true, |c| c > MAX_CELLS) || beta.len() != nl * ns {
        return Err(Error::limit("sargeo: the radar window is larger than 48 million pixels, or its values are the wrong length"));
    }
    let (flatten, stride, step, tol) = (r.f()?, r.n(1024)?, r.f()?, r.f()?);
    if stride > 0 && !(step > 0.0 && step.is_finite() && tol >= 0.0) {
        return Err(Error::invalid("sargeo: the mask step must be positive"));
    }
    let dem = Dem { w, h, z: z.to_vec(), lat0, lon0, dlat, dlon };
    let win = Window { l0, s0, kl, ks, nl, ns, beta: beta.to_vec() };
    Job::new(orbit, img, dem, win, Opts { flatten: flatten != 0.0, mask_stride: stride, mask_step: step, mask_tol: tol }).map_err(Error::invalid)
}

/// Create a job. Output: its handle (u32).
/// # Safety
/// `prm` must hold `n` f64, `z` `nz` f32 and `beta` `nb` f32.
#[no_mangle]
pub unsafe extern "C" fn gw_sargeo_new(prm: *const f64, n: usize, z: *const f32, nz: usize, beta: *const f32, nb: usize) -> i32 {
    let (prm, z, beta) = (slice(prm, n), slice(z, nz), slice(beta, nb));
    status(job(prm, z, beta).map(|j| {
        let h = JOBS.with(|jobs| {
            let mut jobs = jobs.borrow_mut();
            match jobs.iter().position(Option::is_none) {
                Some(k) => {
                    jobs[k] = Some(j);
                    k
                }
                None => {
                    jobs.push(Some(j));
                    jobs.len() - 1
                }
            }
        });
        set_out((h as u32).to_le_bytes().to_vec());
    }))
}

fn with_job<T>(h: u32, f: impl FnOnce(&mut Job) -> T) -> Result<T> {
    JOBS.with(|jobs| jobs.borrow_mut().get_mut(h as usize).and_then(Option::as_mut).map(f).ok_or_else(|| Error::invalid("sargeo: no such job")))
}

/// Run about `rows` DEM rows. Output: progress in [0, 1] (f64; 1 = done).
#[no_mangle]
pub extern "C" fn gw_sargeo_step(h: u32, rows: u32) -> i32 {
    status(with_job(h, |j| set_out(j.step(rows as usize).to_le_bytes().to_vec())))
}

/// A finished job's output: 0 the values (f32 per DEM post, NaN = none), 1 the mask (u8 per post:
/// 1 layover, 2 shadow), 2 the counts [posts with a value, layover, shadow] (f64), 3 each post's
/// image line and pixel (f32 pairs, NaN where it has none).
#[no_mangle]
pub extern "C" fn gw_sargeo_result(h: u32, what: u32) -> i32 {
    status(with_job(h, |j| match what {
        0 => Ok(set_out(j.value.iter().flat_map(|v| v.to_le_bytes()).collect())),
        1 => Ok(set_out(j.mask.clone())),
        2 => Ok(set_out(j.counts.iter().flat_map(|&c| (c as f64).to_le_bytes()).collect())),
        3 => Ok(set_out(j.image_coords().iter().flat_map(|v| v.to_le_bytes()).collect())),
        _ => Err(Error::invalid("sargeo: unknown output")),
    })
    .and_then(|r| r))
}

/// Free a job (its handle may be reused).
#[no_mangle]
pub extern "C" fn gw_sargeo_free(h: u32) -> i32 {
    JOBS.with(|jobs| {
        if let Some(slot) = jobs.borrow_mut().get_mut(h as usize) {
            *slot = None;
        }
    });
    0
}
