//! `aviation` bundle (lazy; analysis worker): airfield obstruction surfaces (REQ-GAP-73). The
//! surface model (FAA Part 77 §77.19, ICAO Annex 14 Chapter 4 until 2030 and Amendment 18's
//! Chapter 4 from 2030) is built from a definition list
//! (gw_aviation::model) on each call; it is small (a few hundred bytes per runway). With an
//! obstacle-free zone the evaluations return its limit as well as the lowest surface's.

use gw_abi::{set_out, slice, status, Error};
use gw_aviation::frame::ecef;
use gw_aviation::{parse, Model};

gw_abi::export_abi!();

fn model(def: &[f64]) -> gw_abi::Result<Model> {
    let a = parse(def).map_err(Error::invalid)?;
    Model::build(&a).map_err(Error::invalid)
}

/// One height and surface index into the output lists. Model::build keeps indices under 255.
fn put(f: &mut [u8], s: &mut [u8], k: usize, (z, id): (f64, usize)) {
    f[4 * k..4 * k + 4].copy_from_slice(&(z as f32).to_le_bytes());
    s[k] = if id == usize::MAX { 255 } else { id as u8 };
}

/// The two limits at a position (none at a position that is not one).
fn limits_at(m: &Model, la: f64, lo: f64) -> ((f64, usize), (f64, usize)) {
    if la.is_finite() && lo.is_finite() && la.abs() <= 90.0 {
        let l = m.limits_at(la, lo);
        (l.lowest, l.zone)
    } else {
        ((f64::NAN, usize::MAX), (f64::NAN, usize::MAX))
    }
}

/// Surfaces of a definition list, as f64 (no float formatting in the module): `[n, then per
/// surface: kind code, runway, end, slope count, slopes…; bbox s, w, n, e; horizontal height,
/// conical top (NaN for Amendment 18); facet count, then per facet: surface index, vertex count,
/// (lat, lon, h)…; the Amendment 18 assumptions made (gw_aviation::a18 `A_*` bits)]`. Kind codes:
/// 0 primary, 1 approach, 2 transitional, 3 horizontal, 4 conical, 5 strip, 6 inner horizontal, 7
/// take-off climb, 8 inner approach, 9 inner transitional, 10 balked landing, 11 the strip within
/// the obstacle-free zone, 12 straight-in instrument approach, 13 to 16 the approach, missed
/// approach, transitional and lower components of the surface for precision approaches, 17
/// instrument departure (wasm/aviation.js decodes it).
/// # Safety
/// The pointer must hold `dlen` values.
#[no_mangle]
pub unsafe extern "C" fn gw_obs_surfaces(def: *const f64, dlen: usize) -> i32 {
    let d = slice(def, dlen);
    status((|| {
        let m = model(d)?;
        let mut v: Vec<f64> = vec![m.surfaces.len() as f64];
        for s in &m.surfaces {
            v.extend([s.kind as u8 as f64, s.runway as f64, s.end as f64, s.slopes.len() as f64]);
            v.extend_from_slice(&s.slopes);
        }
        v.extend(m.geo_bbox());
        v.extend([m.h_elev, m.h_elev + m.con_reach * m.con_slope]);
        let f = m.facets();
        v.push(f.len() as f64);
        for (s, ring) in f {
            v.extend([s as f64, ring.len() as f64]);
            for (la, lo, z) in ring {
                v.extend([la, lo, z]);
            }
        }
        v.push(m.assumed as f64);
        set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect());
        Ok(())
    })())
}

/// Evaluate every post of a geographic grid. `geo` = [w, h, lat0, lon0, dlat, dlon] (post centres,
/// north-west first), `z` the heights (orthometric m; NaN void). Output: the limiting surface
/// height per post (f32, NaN where no surface lies), then its surface index (u8, 255 none); with an
/// obstacle-free zone, the same two lists again for the zone.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_obs_grid(def: *const f64, dlen: usize, geo: *const f64, z: *const f32, zlen: usize) -> i32 {
    let d = slice(def, dlen);
    let g = slice(geo, 6);
    let _ = slice(z, zlen);
    status((|| {
        let m = model(d)?;
        let (w, h) = (g[0], g[1]);
        if !(w >= 1.0 && h >= 1.0 && w.fract() == 0.0 && h.fract() == 0.0) || !g[2..6].iter().all(|v| v.is_finite()) || g[4] <= 0.0 || g[5] <= 0.0 {
            return Err(Error::invalid("obstruction surfaces: bad grid"));
        }
        let (w, h) = (w as usize, h as usize);
        if w.checked_mul(h) != Some(zlen) {
            return Err(Error::invalid("obstruction surfaces: the grid does not match the heights"));
        }
        if zlen > 64_000_000 {
            return Err(Error::limit("obstruction surfaces: more than 64 M posts in one call"));
        }
        let (lat0, lon0, dlat, dlon) = (g[2], g[3], g[4], g[5]);
        let zoned = m.has_zone();
        let mut lim = vec![0u8; zlen * if zoned { 10 } else { 5 }];
        let (low, zone) = lim.split_at_mut(zlen * 5);
        let (lf, ls) = low.split_at_mut(zlen * 4);
        let (zf, zs) = zone.split_at_mut(if zoned { zlen * 4 } else { 0 });
        // Rows share the latitude terms and columns the longitude terms of the ECEF position.
        let lons: Vec<(f64, f64)> = (0..w).map(|i| (lon0 + i as f64 * dlon).to_radians().sin_cos()).collect();
        let fr = m.frame;
        for j in 0..h {
            let lat = lat0 - j as f64 * dlat;
            let p0 = ecef(lat, 0.0);
            let (rxy, pz) = (p0[0], p0[2]);
            for i in 0..w {
                let (sl, cl) = lons[i];
                let (x, y) = fr.of_ecef([rxy * cl, rxy * sl, pz]);
                let l = m.limits(x, y);
                let k = j * w + i;
                put(lf, ls, k, l.lowest);
                if zoned {
                    put(zf, zs, k, l.zone);
                }
            }
        }
        set_out(lim);
        Ok(())
    })())
}

/// Evaluate points: `ll` = [lat, lon] pairs. Output as for gw_obs_grid, one value per point.
/// # Safety
/// The pointer must hold `n` values.
#[no_mangle]
pub unsafe extern "C" fn gw_obs_points(def: *const f64, dlen: usize, ll: *const f64, n: usize) -> i32 {
    let d = slice(def, dlen);
    let p = slice(ll, n);
    status((|| {
        let m = model(d)?;
        if n % 2 != 0 {
            return Err(Error::invalid("obstruction surfaces: points are lat, lon pairs"));
        }
        let k = n / 2;
        let zoned = m.has_zone();
        let mut out = vec![0u8; k * if zoned { 10 } else { 5 }];
        let (low, zone) = out.split_at_mut(k * 5);
        let (lf, ls) = low.split_at_mut(k * 4);
        let (zf, zs) = zone.split_at_mut(if zoned { k * 4 } else { 0 });
        for q in 0..k {
            let l = limits_at(&m, p[2 * q], p[2 * q + 1]);
            put(lf, ls, q, l.0);
            if zoned {
                put(zf, zs, q, l.1);
            }
        }
        set_out(out);
        Ok(())
    })())
}

/// As gw_obs_points with f64 heights (oracle comparisons): output f64 [height, surface index (−1
/// none), zone height, zone surface index (−1 none)] per point.
/// # Safety
/// The pointer must hold `n` values.
#[no_mangle]
pub unsafe extern "C" fn gw_obs_points64(def: *const f64, dlen: usize, ll: *const f64, n: usize) -> i32 {
    let d = slice(def, dlen);
    let p = slice(ll, n);
    status((|| {
        let m = model(d)?;
        if n % 2 != 0 {
            return Err(Error::invalid("obstruction surfaces: points are lat, lon pairs"));
        }
        let mut out = Vec::with_capacity(n * 16);
        for q in 0..n / 2 {
            let (low, zone) = limits_at(&m, p[2 * q], p[2 * q + 1]);
            for (zl, id) in [low, zone] {
                out.extend_from_slice(&zl.to_le_bytes());
                out.extend_from_slice(&(if id == usize::MAX { -1.0f64 } else { id as f64 }).to_le_bytes());
            }
        }
        set_out(out);
        Ok(())
    })())
}
