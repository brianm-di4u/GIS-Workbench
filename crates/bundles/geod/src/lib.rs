//! `geod` bundle (lazy; main thread, loaded with the first grid pack or frame transformation):
//! grid-based datum and height transformations (NTv2, NADCON5, OSTN15 and the other PROJ-data
//! grids; GEOID18, OSGM15, AUSGeoid2020, CGG2013 and EGM2008 geoids) and time-dependent
//! Helmert transformations between reference frames (REQ-GAP-16). Arithmetic as PROJ 9.9.

use gw_abi::{set_out_json, slice, slice_mut, status, Error, Json};
use gw_geodesy::datum::grid::{Format, GridSet, Role, DEG_TO_RAD};
use gw_geodesy::datum::helmert::{frame_count, frame_index, frame_name, path, transform, Step};
use gw_geodesy::datum::shift::{generic_plan, gridshift_apply, hgrid_apply, vgrid_value, vgrid_value_fwd};
use gw_geodesy::datum::frames::FRAMES;
use std::cell::RefCell;

gw_abi::export_abi!();

thread_local! {
    static SETS: RefCell<Vec<(i32, GridSet)>> = const { RefCell::new(Vec::new()) };
    static NEXT: RefCell<i32> = const { RefCell::new(1) };
}

fn str_arg(p: *const u8, n: usize) -> String {
    // SAFETY: JS passes a valid (ptr, len) UTF-8 buffer.
    String::from_utf8_lossy(unsafe { slice(p, n) }).into_owned()
}

/// Open a grid file (GeoTIFF, NTv2 or GTX). role 0 horizontal (hgridshift), 1 vertical
/// (vgridshift), 2 generic (gridshift). `cache_mb` bounds the decoded-block cache. Returns an
/// id > 0, or minus the error status.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_grid_open(ptr: *const u8, len: usize, role: i32, name: *const u8, name_len: usize, cache_mb: i32) -> i32 {
    let bytes = slice(ptr, len).to_vec();
    let name = str_arg(name, name_len);
    let role = match role {
        0 => Role::Horizontal,
        1 => Role::Vertical,
        _ => Role::Generic,
    };
    match GridSet::open(&name, bytes, role, (cache_mb.clamp(1, 1024) as usize) << 20) {
        Ok(s) => {
            let id = NEXT.with(|n| {
                let mut n = n.borrow_mut();
                let id = *n;
                *n += 1;
                id
            });
            SETS.with(|m| m.borrow_mut().push((id, s)));
            id
        }
        Err(e) => -status::<()>(Err(e)),
    }
}

#[no_mangle]
pub extern "C" fn gw_grid_free(id: i32) {
    SETS.with(|m| m.borrow_mut().retain(|e| e.0 != id));
}

fn find(m: &[(i32, GridSet)], id: i32) -> gw_abi::Result<&GridSet> {
    m.iter().find(|e| e.0 == id).map(|e| &e.1).ok_or_else(|| Error::invalid("unknown grid id"))
}

/// Grid set description as JSON: name, format, role, cached bytes and every (sub-)grid with
/// its size, type and interpolation (no floats: extents come from `gw_grid_extents`).
#[no_mangle]
pub extern "C" fn gw_grid_info(id: i32) -> i32 {
    status(SETS.with(|m| {
        let m = m.borrow();
        let s = find(&m, id)?;
        let mut j = Json::new();
        j.obj();
        j.key("name").str(&s.name);
        j.key("format").str(match s.format {
            Format::GTiff => "GTiff",
            Format::Ntv2 => "NTv2",
            Format::Gtx => "GTX",
        });
        j.key("role").str(match s.role {
            Role::Horizontal => "horizontal",
            Role::Vertical => "vertical",
            Role::Generic => "generic",
        });
        j.key("cachedBytes").int(s.tiff_cached_bytes() as i64);
        j.key("grids").arr();
        for g in s.all() {
            j.obj();
            j.key("name").str(&g.name);
            j.key("width").int(g.width as i64);
            j.key("height").int(g.height as i64);
            j.key("type").str(&g.gtype);
            j.key("biquadratic").bool(g.biquadratic);
            j.key("children").int(g.children.len() as i64);
            j.end_obj();
        }
        j.end_arr();
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// Extents of every (sub-)grid of a set, depth first as in `gw_grid_info`: west, south, east,
/// north, resolution x and y (degrees, node centres) per grid into `out` (cap values). Returns
/// the number of grids.
/// # Safety
/// `out` must hold `cap` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_grid_extents(id: i32, out: *mut f64, cap: usize) -> i32 {
    let o = slice_mut(out, cap);
    SETS.with(|m| {
        let m = m.borrow();
        let Ok(s) = find(&m, id) else { return -1 };
        let all = s.all();
        let d = 1.0 / DEG_TO_RAD;
        for (k, g) in all.iter().enumerate() {
            if 6 * k + 6 > o.len() {
                break;
            }
            let e = &g.extent;
            o[6 * k..6 * k + 6].copy_from_slice(&[e.west * d, e.south * d, e.east * d, e.north * d, e.res_x * d, e.res_y * d]);
        }
        all.len() as i32
    })
}

/// Apply grids to points in place. kind 0 hgridshift, 1 gridshift, 2 vgridshift; `pts` holds
/// (longitude °, latitude °, height m) triples. flags: bit 0 overrides the interpolation with
/// bit 1 (1 = biquadratic, 0 = bilinear); bit 2 skips the height (gridshift +no_z_transform).
/// For vgridshift the height becomes h + mult·value (PROJ: forward multiplier −1 by default;
/// `+inv` with multiplier 1 gives H = h − N). A point outside every grid, or on nodata,
/// becomes NaN. Output JSON: {"failed": n, "grids": {name: count}}.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_grid_apply(kind: i32, ids: *const i32, nids: usize, inverse: i32, pts: *mut f64, n: usize, flags: i32, mult: f64) -> i32 {
    let ids = slice(ids, nids).to_vec();
    let p = slice_mut(pts, n * 3);
    status(SETS.with(|m| {
        let m = m.borrow();
        let mut sets = Vec::with_capacity(ids.len());
        for id in &ids {
            sets.push(find(&m, *id)?);
        }
        if sets.is_empty() {
            return Err(Error::invalid("no grid given"));
        }
        let force = if flags & 1 != 0 { Some(flags & 2 != 0) } else { None };
        let want_z = flags & 4 == 0;
        let plan = if kind == 1 { Some(generic_plan(&sets).ok_or_else(|| Error::invalid("gridshift: unsupported mix of grid types"))?) } else { None };
        let mut used: Vec<(String, usize)> = Vec::new();
        let mut failed = 0usize;
        let inv = inverse != 0;
        for k in 0..n {
            let (lam, phi, h) = (p[3 * k] * DEG_TO_RAD, p[3 * k + 1] * DEG_TO_RAD, p[3 * k + 2]);
            let r: Option<((f64, f64, f64), String)> = match kind {
                0 => hgrid_apply(&sets, lam, phi, inv).map(|(l, f, u)| ((l, f, h), u.grid.name.clone())),
                1 => gridshift_apply(&sets, plan.as_ref().expect("plan"), (lam, phi, h), inv, force, want_z).map(|(o, u)| (o, u.grid.name.clone())),
                _ => if inv { vgrid_value(&sets, lam, phi, mult) } else { vgrid_value_fwd(&sets, lam, phi, mult) }.map(|(v, u)| ((lam, phi, if inv { h - v } else { h + v }), u.grid.name.clone())),
            };
            match r {
                Some(((l, f, z), name)) if l.is_finite() && f.is_finite() && z.is_finite() => {
                    p[3 * k] = l / DEG_TO_RAD;
                    p[3 * k + 1] = f / DEG_TO_RAD;
                    p[3 * k + 2] = z;
                    match used.iter_mut().find(|e| e.0 == name) {
                        Some(e) => e.1 += 1,
                        None => used.push((name, 1)),
                    }
                }
                _ => {
                    p[3 * k] = f64::NAN;
                    p[3 * k + 1] = f64::NAN;
                    p[3 * k + 2] = f64::NAN;
                    failed += 1;
                }
            }
        }
        let mut j = Json::new();
        j.obj();
        j.key("failed").int(failed as i64);
        j.key("grids").obj();
        for (k, v) in &used {
            j.key(k).int(*v as i64);
        }
        j.end_obj();
        j.end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}

/// The reference frames as JSON: [{name, geocentric, geographic3d, geographic2d, ellipsoid}].
#[no_mangle]
pub extern "C" fn gw_frames() -> i32 {
    let mut j = Json::new();
    j.arr();
    for f in FRAMES {
        j.obj();
        j.key("name").str(f.0);
        j.key("geocentric").int(f.1 as i64);
        j.key("geographic3d").int(f.2 as i64);
        j.key("geographic2d").int(f.3 as i64);
        j.key("ellipsoid").str(if f.4 == 1 { "WGS 84" } else { "GRS 1980" });
        j.end_obj();
    }
    j.end_arr();
    set_out_json(j.finish());
    0
}

fn frame_arg(p: *const u8, n: usize) -> gw_abi::Result<usize> {
    let s = str_arg(p, n);
    frame_index(&s).ok_or_else(|| gw_abi::err!(INVALID, "unknown reference frame {frame}", frame = s))
}

fn path_json(steps: &[Step], src: usize, dst: usize) -> String {
    let mut j = Json::new();
    j.obj();
    j.key("source").str(frame_name(src));
    j.key("target").str(frame_name(dst));
    let total: f64 = steps.iter().map(|s| s.accuracy().max(0.0)).sum();
    let unknown = steps.iter().any(|s| s.accuracy() < 0.0);
    // Accuracies in micrometres, as integers (EPSG gives them in metres).
    if unknown {
        j.key("accuracyUm").null();
    } else {
        j.key("accuracyUm").int((total * 1e6).round() as i64);
    }
    j.key("timeDependent").bool(steps.iter().any(Step::time_dependent));
    j.key("steps").arr();
    for s in steps {
        j.obj();
        j.key("epsg").int(s.epsg() as i64);
        j.key("name").str(s.name());
        j.key("inverse").bool(s.inverse);
        if s.accuracy() < 0.0 {
            j.key("accuracyUm").null();
        } else {
            j.key("accuracyUm").int((s.accuracy() * 1e6).round() as i64);
        }
        j.key("timeDependent").bool(s.time_dependent());
        j.end_obj();
    }
    j.end_arr();
    j.end_obj();
    j.finish()
}

/// The EPSG operation chain between two frames (names or EPSG codes) as JSON.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_frame_path(src: *const u8, sn: usize, dst: *const u8, dn: usize) -> i32 {
    status((|| {
        let a = frame_arg(src, sn)?;
        let b = frame_arg(dst, dn)?;
        let steps = path(a, b).ok_or_else(|| Error::invalid("no transformation between these frames"))?;
        set_out_json(path_json(&steps, a, b));
        Ok(())
    })())
}

/// Transform (longitude °, latitude °, ellipsoidal height m) triples in place from one frame to
/// another at a coordinate epoch (decimal year; NaN = each operation's reference epoch).
/// Output: the path JSON.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_frame_transform(src: *const u8, sn: usize, dst: *const u8, dn: usize, epoch: f64, pts: *mut f64, n: usize) -> i32 {
    let p = slice_mut(pts, n * 3);
    status((|| {
        let a = frame_arg(src, sn)?;
        let b = frame_arg(dst, dn)?;
        let steps = path(a, b).ok_or_else(|| Error::invalid("no transformation between these frames"))?;
        let ep = if epoch.is_finite() { Some(epoch) } else { None };
        for k in 0..n {
            let (l, f, h) = transform(&steps, a, b, p[3 * k], p[3 * k + 1], p[3 * k + 2], ep);
            p[3 * k] = l;
            p[3 * k + 1] = f;
            p[3 * k + 2] = h;
        }
        set_out_json(path_json(&steps, a, b));
        Ok(())
    })())
}

/// Number of frames (for tests).
#[no_mangle]
pub extern "C" fn gw_frame_count() -> i32 {
    frame_count() as i32
}

/// One grid value × multiplier at a point (vgridshift arithmetic, forward entry), NaN outside
/// the grid or on nodata. The fast path for geoid heights at the cursor and over DEM posts.
#[no_mangle]
pub extern "C" fn gw_vgrid_value(id: i32, lon: f64, lat: f64, mult: f64) -> f64 {
    SETS.with(|m| {
        let m = m.borrow();
        let Ok(s) = find(&m, id) else { return f64::NAN };
        vgrid_value_fwd(&[s], lon * DEG_TO_RAD, lat * DEG_TO_RAD, mult).map_or(f64::NAN, |(v, _)| v)
    })
}
