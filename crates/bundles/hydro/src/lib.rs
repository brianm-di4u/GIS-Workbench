//! `hydro` bundle (lazy; analysis worker): hydrology on whole grids (REQ-GAP-80, SDP-2.7 §4.2).
//! JS allocates the planes with `gw_alloc` and runs one stage per call, so the worker reports
//! progress and takes a cancel between stages (S-63: 26–39 s at 48 M posts). Every plane is
//! `w * h` long; an empty optional plane is passed as a null pointer.

use gw_abi::{set_out, slice, slice_mut, status, Error};

gw_abi::export_abi!();

/// The refusal threshold (`TERRAIN_POSTS`, S-63): the worker checks it before allocating, and
/// every stage checks it again.
const MAX_POSTS: usize = 48_000_000;

fn posts(w: usize, h: usize) -> gw_abi::Result<usize> {
    let n = w.checked_mul(h).ok_or_else(|| Error::invalid("hydrology: the grid size overflows"))?;
    if w < 3 || h < 3 {
        return Err(Error::invalid("hydrology: the grid needs at least 3 × 3 posts"));
    }
    if n > MAX_POSTS {
        return Err(Error::limit("hydrology: the grid is larger than 48 million posts"));
    }
    Ok(n)
}

fn spacing(dx: f64, dy: f64) -> gw_abi::Result<()> {
    if dx > 0.0 && dy > 0.0 && dx.is_finite() && dy.is_finite() {
        Ok(())
    } else {
        Err(Error::invalid("hydrology: the post spacing must be positive"))
    }
}

/// Priority-flood fill in place on `z` (eps 1 = epsilon fill), directions of raised posts into
/// `dir`. Output: `[valid, raised]` as u32.
/// # Safety
/// `z` and `dir` must hold `w * h` elements.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_fill(z: *mut f32, dir: *mut u8, w: usize, h: usize, eps: u32) -> i32 {
    status(posts(w, h).map(|n| {
        let st = gw_hydro::fill(slice_mut(z, n), w, h, eps != 0, slice_mut(dir, n), n);
        set_out([st.valid, st.raised].iter().flat_map(|v| v.to_le_bytes()).collect());
    }))
}

/// D8 directions for the posts the fill left unassigned. Output: `[outlets found]` as u32.
/// # Safety
/// `z` and `dir` must hold `w * h` elements.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_d8(z: *const f32, dir: *mut u8, w: usize, h: usize, dx: f64, dy: f64) -> i32 {
    status(posts(w, h).and_then(|n| {
        spacing(dx, dy)?;
        let stuck = gw_hydro::d8(slice(z, n), w, h, dx, dy, slice_mut(dir, n));
        set_out(stuck.to_le_bytes().to_vec());
        Ok(())
    }))
}

/// D8 accumulation into `acc`, with Strahler order and Shreve magnitude on posts with
/// `acc >= thresh` when those planes are given. Output: `[posts done]` as u32.
/// # Safety
/// `dir`, `acc` and each non-null plane must hold `w * h` elements.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_accum(dir: *mut u8, acc: *mut u32, strahler: *mut u8, shreve: *mut u32, w: usize, h: usize, thresh: u32) -> i32 {
    status(posts(w, h).map(|n| {
        let so = if strahler.is_null() { &mut [][..] } else { slice_mut(strahler, n) };
        let sh = if shreve.is_null() { &mut [][..] } else { slice_mut(shreve, n) };
        let done = gw_hydro::accumulate(slice_mut(dir, n), w, h, slice_mut(acc, n), so, sh, thresh.max(1));
        set_out(done.to_le_bytes().to_vec());
    }))
}

/// Snap `k` pour points (post indices, in place) to the largest accumulation within `r` posts.
/// # Safety
/// `acc` must hold `w * h` elements and `pts` `k`.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_snap(acc: *const u32, pts: *mut u32, k: usize, w: usize, h: usize, r: i32) -> i32 {
    status(posts(w, h).and_then(|n| {
        let pts = slice_mut(pts, k);
        if pts.iter().any(|&p| p as usize >= n) {
            return Err(Error::range("hydrology: a pour point is outside the grid"));
        }
        gw_hydro::snap(slice(acc, n), w, h, pts, r.clamp(0, 1000));
        Ok(())
    }))
}

/// Watershed labels 1..=k of `k` pour points into `labels` (0 elsewhere).
/// # Safety
/// `dir` and `labels` must hold `w * h` elements and `pts` `k`.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_label(dir: *const u8, pts: *const u32, k: usize, labels: *mut u32, w: usize, h: usize) -> i32 {
    status(posts(w, h).and_then(|n| {
        let pts = slice(pts, k);
        if pts.iter().any(|&p| p as usize >= n) {
            return Err(Error::range("hydrology: a pour point is outside the grid"));
        }
        gw_hydro::label(slice(dir, n), w, pts, slice_mut(labels, n));
        Ok(())
    }))
}

/// Stream links of `acc >= thresh` as u32 `[count, strahler, shreve, post…]` per link.
/// # Safety
/// `dir` and `acc` must hold `w * h` elements, and so must each non-null plane.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_streams(dir: *const u8, acc: *const u32, strahler: *const u8, shreve: *const u32, w: usize, h: usize, thresh: u32) -> i32 {
    status(posts(w, h).map(|n| {
        let so = if strahler.is_null() { &[][..] } else { slice(strahler, n) };
        let sh = if shreve.is_null() { &[][..] } else { slice(shreve, n) };
        let v = gw_hydro::streams(slice(dir, n), slice(acc, n), so, sh, w, thresh.max(1));
        set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect());
    }))
}

/// D-infinity facet and share per post into `ang` (see `gw_hydro::dinf`).
/// # Safety
/// `z`, `dir` and `ang` must hold `w * h` elements.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_dinf(z: *const f32, dir: *const u8, ang: *mut f32, w: usize, h: usize, dx: f64, dy: f64) -> i32 {
    status(posts(w, h).and_then(|n| {
        spacing(dx, dy)?;
        gw_hydro::dinf(slice(z, n), w, h, dx, dy, slice(dir, n), slice_mut(ang, n));
        Ok(())
    }))
}

/// D-infinity accumulation into `acc`; `indeg` is scratch. Output: `[posts done]` u32, then the
/// flow that left the grid as f64.
/// # Safety
/// `ang`, `indeg` and `acc` must hold `w * h` elements.
#[no_mangle]
pub unsafe extern "C" fn gw_hy_dinf_accum(ang: *const f32, indeg: *mut u8, acc: *mut f32, w: usize, h: usize) -> i32 {
    status(posts(w, h).map(|n| {
        let (done, lost) = gw_hydro::dinf_accumulate(slice(ang, n), w, h, slice_mut(indeg, n), slice_mut(acc, n));
        let mut o = done.to_le_bytes().to_vec();
        o.extend_from_slice(&[0; 4]);
        o.extend_from_slice(&lost.to_le_bytes());
        set_out(o);
    }))
}
