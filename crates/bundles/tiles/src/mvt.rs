//! `tiles` exports: mvt — the MVT tiler (FC-07, REQ-FMT-33) and a decoder summary for checks.

use gw_abi::{set_out, set_out_json, slice, status, Json};
use gw_tiles::mvt;

/// Tile layers (GWVT input, see `app/src/tiles/tiler.js`) over min..max zoom. Output: packed
/// tiles (u32 count; per tile u8 z, u32 x, u32 y, u32 length, uncompressed MVT bytes).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_mvt_tile(ptr: *const u8, len: usize, min_zoom: u32, max_zoom: u32, extent: u32, buffer: u32, tolerance: f64, max_tiles: u32) -> i32 {
    let r = mvt::parse_input(slice(ptr, len)).and_then(|layers| {
        let o = mvt::TileOptions { min_zoom: min_zoom.min(255) as u8, max_zoom: max_zoom.min(255) as u8, extent, buffer, tolerance: if tolerance.is_finite() { tolerance.max(0.0) } else { 1.0 }, max_tiles: max_tiles as usize, ..Default::default() };
        mvt::tile_layers(&layers, &o)
    });
    status(r.map(|t| set_out(mvt::pack_tiles(&t))))
}

/// Decode one uncompressed MVT tile → JSON [{name, version, extent, features, keys}] (checks).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_mvt_summary(ptr: *const u8, len: usize) -> i32 {
    status(mvt::decode(slice(ptr, len)).map(|layers| {
        let mut j = Json::new();
        j.arr();
        for l in &layers {
            j.obj().kv_str("name", &l.name).kv_int("version", l.version as i64).kv_int("extent", l.extent as i64).kv_int("features", l.features.len() as i64);
            j.key("keys").arr();
            for k in &l.keys {
                j.str(k);
            }
            j.end_arr().end_obj();
        }
        j.end_arr();
        set_out_json(j.finish());
    }))
}
