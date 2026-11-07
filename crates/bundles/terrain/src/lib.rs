//! `terrain` bundle (lazy; analysis worker): viewsheds (REQ-DEM-13) and helicopter landing zones
//! (REQ-DEM-14) on height grids, and the DEM edit kernels (REQ-DEM-08/09, REQ-GAP-37/38).

use gw_abi::{set_out, slice, status, Error};
use gw_terrain::hlz::{hlz, Doctrine};
use gw_terrain::viewshed::{viewshed, Params};
use gw_terrain::Grid;

gw_abi::export_abi!();

/// Viewshed. `prm` = [w, h, cell x, cell y, then per observer: column, row, observer h, target h,
/// cc, min distance, max distance, azimuth start, azimuth end]; `z` = heights (m). With several
/// observers the output counts how many see each post (255 = outside every range). Output: u8 w·h.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_viewshed(prm: *const f64, plen: usize, z: *const f32, zlen: usize) -> i32 {
    let a = slice(prm, plen);
    status((|| {
        if a.len() < 13 || (a.len() - 4) % 9 != 0 {
            return Err(Error::invalid("viewshed: bad parameters"));
        }
        let (w, h) = (a[0] as usize, a[1] as usize);
        if w < 2 || h < 2 || zlen != w * h {
            return Err(Error::invalid("viewshed: grid size"));
        }
        let g = Grid { w, h, z: std::slice::from_raw_parts(z, zlen), cell_x: a[2], cell_y: a[3] };
        let obs: Vec<&[f64]> = a[4..].chunks_exact(9).collect();
        let mut out = vec![255u8; w * h];
        for (n, o) in obs.iter().enumerate() {
            let p = Params { ox: o[0] as usize, oy: o[1] as usize, observer_h: o[2], target_h: o[3], cc: o[4], min_dist: o[5], max_dist: o[6], az_start: o[7], az_end: o[8] };
            let v = viewshed(&g, &p);
            for k in 0..w * h {
                if v[k] == 255 {
                    continue;
                }
                if obs.len() == 1 {
                    out[k] = v[k];
                } else {
                    let c = if out[k] == 255 { 0 } else { out[k] };
                    out[k] = c + v[k];
                }
            }
            let _ = n;
        }
        set_out(out);
        Ok(())
    })())
}

/// Landing zones. `prm` = [w, h, cell x, cell y, zone, buffer, slope suitable, slope marginal,
/// obstruction height, object width]; `z` = DSM heights. Output: classes (w·h u8), then the slope
/// as f32 (w·h), then the obstruction mask (w·h u8).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_hlz(prm: *const f64, plen: usize, z: *const f32, zlen: usize) -> i32 {
    let a = slice(prm, plen);
    status((|| {
        if a.len() != 10 {
            return Err(Error::invalid("hlz: bad parameters"));
        }
        let (w, h) = (a[0] as usize, a[1] as usize);
        if w < 3 || h < 3 || zlen != w * h {
            return Err(Error::invalid("hlz: grid size"));
        }
        let g = Grid { w, h, z: std::slice::from_raw_parts(z, zlen), cell_x: a[2], cell_y: a[3] };
        let d = Doctrine { zone: a[4], buffer: a[5], slope_suitable: a[6], slope_marginal: a[7], obstruction_h: a[8], object_w: a[9] };
        let o = hlz(&g, &d);
        let mut b = Vec::with_capacity(w * h * 6);
        b.extend_from_slice(&o.classes);
        for s in &o.slope {
            b.extend_from_slice(&s.to_le_bytes());
        }
        b.extend_from_slice(&o.obstruction);
        set_out(b);
        Ok(())
    })())
}

/// Buildings and trees from a DSM (REQ-EXT-16). `prm` = [w, h, cell x, cell y, min height,
/// min area, min tree area, roughness, simplify, square]; `dsm`, `ndsm` = w·h heights. Output:
/// JSON {buildings: [{ring, height, area, posts, squared, cornerErrorDeg}], trees: [{at, height,
/// crown}]} in metres from post (0, 0), x east, y north.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_buildings(prm: *const f64, plen: usize, dsm: *const f32, ndsm: *const f32, zlen: usize) -> i32 {
    let a = slice(prm, plen);
    status((|| {
        if a.len() != 10 {
            return Err(Error::invalid("buildings: bad parameters"));
        }
        let (w, h) = (a[0] as usize, a[1] as usize);
        if w < 3 || h < 3 || zlen != w * h {
            return Err(Error::invalid("buildings: grid size"));
        }
        let g = Grid { w, h, z: std::slice::from_raw_parts(dsm, zlen), cell_x: a[2], cell_y: a[3] };
        let p = gw_terrain::buildings::Params { min_height: a[4], min_area: a[5], min_tree_area: a[6], roughness: a[7], simplify: a[8], square: a[9] != 0.0 };
        let (bs, ts) = gw_terrain::buildings::extract(&g, std::slice::from_raw_parts(ndsm, zlen), &p);
        let mut j = gw_abi::Json::new();
        j.obj().key("buildings").arr();
        for b in &bs {
            j.obj().key("ring").arr();
            for v in &b.ring {
                j.arr().num(v[0]).num(v[1]).end_arr();
            }
            j.end_arr();
            j.kv_num("height", b.height).kv_num("area", b.area).kv_int("posts", b.posts as i64).kv_bool("squared", b.squared).kv_num("cornerErrorDeg", b.corner_error_deg).end_obj();
        }
        j.end_arr().key("trees").arr();
        for t in &ts {
            j.obj().key("at").arr().num(t.at[0]).num(t.at[1]).end_arr().kv_num("height", t.height).kv_num("crown", t.crown).end_obj();
        }
        j.end_arr().end_obj();
        gw_abi::set_out_json(j.finish());
        Ok(())
    })())
}

/// RTIN terrain mesh (REQ-STR-11). `z` = size² heights (size = 2^k + 1, no NaN); output:
/// [vertex count u32, triangle count u32], vertices (u16 x, u16 y), triangles (u32 ×3).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_rtin(z: *const f32, zlen: usize, size: u32, max_error: f64) -> i32 {
    let zz = slice(z, zlen);
    status((|| {
        let r = gw_terrain::rtin::Rtin::new(zz, size as usize).ok_or_else(|| Error::invalid("rtin: the grid must be (2^k + 1)² heights"))?;
        let (v, t) = r.mesh(max_error as f32);
        let mut b = Vec::with_capacity(8 + 4 * v.len() + 12 * t.len());
        b.extend_from_slice(&(v.len() as u32).to_le_bytes());
        b.extend_from_slice(&(t.len() as u32).to_le_bytes());
        for p in &v {
            b.extend_from_slice(&(p[0] as u16).to_le_bytes());
            b.extend_from_slice(&(p[1] as u16).to_le_bytes());
        }
        for tr in &t {
            for i in tr {
                b.extend_from_slice(&i.to_le_bytes());
            }
        }
        set_out(b);
        Ok(())
    })())
}

/// DEM edit replay (REQ-DEM-08/09, REQ-GAP-37/38). `geo` = [w, h, lat0, lon0, dlat, dlon]; `ops`
/// the flat edit list of `gw_terrain::edit::parse`; `z` the source heights. Output: f32 w·h
/// edited heights.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_dem_replay(geo: *const f64, ops: *const f64, olen: usize, z: *const f32, zlen: usize) -> i32 {
    let g = slice(geo, 6);
    let a = slice(ops, olen);
    let zz = slice(z, zlen);
    status((|| {
        let geo = dem_geo(g, zlen)?;
        let ops = gw_terrain::edit::parse(a).map_err(Error::invalid)?;
        let out = gw_terrain::edit::replay(&geo, zz, &ops);
        let mut b = Vec::with_capacity(out.len() * 4);
        for v in &out {
            b.extend_from_slice(&v.to_le_bytes());
        }
        set_out(b);
        Ok(())
    })())
}

/// Block status (REQ-GAP-37): `geo` as for gw_dem_replay, `src` and `cur` the source and edited
/// heights, `tile` the block size in posts. Output: f64 rows [tx, ty, posts, voids, edited, max |Δh|].
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_dem_blocks(geo: *const f64, src: *const f32, cur: *const f32, zlen: usize, tile: u32) -> i32 {
    let g = slice(geo, 6);
    status((|| {
        let geo = dem_geo(g, zlen)?;
        if !(16..=4096).contains(&tile) {
            return Err(Error::invalid("dem blocks: block size"));
        }
        let rows = gw_terrain::edit::blocks(&geo, slice(src, zlen), slice(cur, zlen), tile as usize);
        let mut b = Vec::with_capacity(rows.len() * 48);
        for r in &rows {
            for v in r {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        set_out(b);
        Ok(())
    })())
}

fn dem_geo(g: &[f64], zlen: usize) -> gw_abi::Result<gw_terrain::edit::Geo> {
    let (w, h) = (g[0] as usize, g[1] as usize);
    if w < 1 || h < 1 || w.checked_mul(h) != Some(zlen) || !g[2..6].iter().all(|v| v.is_finite()) || g[4] <= 0.0 || g[5] <= 0.0 {
        return Err(Error::invalid("dem edit: grid does not match the heights"));
    }
    Ok(gw_terrain::edit::Geo { w, h, lat0: g[2], lon0: g[3], dlat: g[4], dlon: g[5] })
}
