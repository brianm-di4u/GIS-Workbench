//! `geoproc` bundle (lazy; analysis worker): buffer and dissolve for vector geoprocessing
//! (REQ-GAP-79), on planar coordinates the caller has projected (gw_geoproc). Overlay and spatial
//! join run in JavaScript (S-62).

use gw_abi::{set_out, slice, status, Error};
use gw_geoproc::{buffer, decode, dissolve, encode, Cap};

gw_abi::export_abi!();

fn out(v: Vec<f64>) {
    set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect());
}

/// Buffer every geometry of `g` (gw_geoproc encoding) by `d` with `cap` (0 round, 1 flat,
/// 2 square) and round joins of `quad_segs` segments per quarter circle. Output: one multipolygon
/// per input geometry, in order.
/// # Safety
/// `g` must hold `n` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_geo_buffer(g: *const f64, n: usize, d: f64, cap: u32, quad_segs: u32) -> i32 {
    let v = slice(g, n);
    status((|| {
        let geoms = decode(v).ok_or_else(|| Error::invalid("geoprocessing: malformed geometry list"))?;
        if !d.is_finite() || d.abs() > 2.0e7 {
            return Err(Error::invalid("geoprocessing: the buffer distance must be finite and within 20,000 km"));
        }
        let c = match cap {
            0 => Cap::Round,
            1 => Cap::Flat,
            2 => Cap::Square,
            _ => return Err(Error::invalid("geoprocessing: unknown line end")),
        };
        let mut o = Vec::new();
        for g in &geoms {
            encode(&buffer(g, d, c, quad_segs), &mut o);
        }
        out(o);
        Ok(())
    })())
}

/// Dissolve: the union of the polygons of each group. `groups` gives one group number (0, 1 …)
/// per geometry. Output: one multipolygon per group, in group order.
/// # Safety
/// `g` must hold `n` f64 and `groups` `ng` f64.
#[no_mangle]
pub unsafe extern "C" fn gw_geo_dissolve(g: *const f64, n: usize, groups: *const f64, ng: usize) -> i32 {
    let v = slice(g, n);
    let gr = slice(groups, ng);
    status((|| {
        let geoms = decode(v).ok_or_else(|| Error::invalid("geoprocessing: malformed geometry list"))?;
        if gr.len() != geoms.len() || gr.iter().any(|&k| !(k >= 0.0 && k.fract() == 0.0 && k < geoms.len().max(1) as f64)) {
            return Err(Error::invalid("geoprocessing: one group number per geometry, from 0"));
        }
        let groups: Vec<usize> = gr.iter().map(|&k| k as usize).collect();
        let mut o = Vec::new();
        for s in dissolve(&geoms, &groups) {
            encode(&s, &mut o);
        }
        out(o);
        Ok(())
    })())
}
