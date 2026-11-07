//! `tiles` exports: pmtiles — the PMTiles v3 writer (REQ-FMT-31) and a verifier.

use gw_abi::{set_out, set_out_json, slice, status, Error, Json};
use gw_tiles::{mvt, pmtiles};

/// Write a PMTiles archive from packed tiles (the tiler's output layout). `tile_type`: 1 MVT,
/// 2 PNG, 3 JPEG, 4 WebP, 5 AVIF. `gzip_tiles` 1: gzip each tile (MVT). Bounds in degrees;
/// `meta` is the JSON metadata. Output: the archive.
/// # Safety
/// `ptr`/`len` and `meta`/`meta_len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_pmtiles_write(ptr: *const u8, len: usize, meta: *const u8, meta_len: usize, tile_type: u32, gzip_tiles: u32, w: f64, s: f64, e: f64, n: f64, center_zoom: i32) -> i32 {
    let r = mvt::unpack_tiles(slice(ptr, len)).and_then(|tiles| {
        if tile_type == 0 || tile_type > 6 {
            return Err(Error::invalid("unknown PMTiles tile type"));
        }
        let o = pmtiles::WriteOptions {
            tile_type: tile_type as u8,
            // MVT tiles are gzip in PMTiles; images are stored as they are.
            tile_compression: if gzip_tiles != 0 || tile_type == u32::from(pmtiles::TYPE_MVT) { pmtiles::COMP_GZIP } else { pmtiles::COMP_NONE },
            gzip_tiles: gzip_tiles != 0,
            bounds: [w, s, e, n],
            center: None,
            center_zoom: u8::try_from(center_zoom).ok(),
            metadata_json: slice(meta, meta_len).to_vec(),
        };
        pmtiles::write(&tiles, &o)
    });
    status(r.map(set_out))
}

/// Verify an archive held whole → JSON {addressed, entries, contents, minZoom, maxZoom, tileType,
/// clustered}.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_pmtiles_verify(ptr: *const u8, len: usize) -> i32 {
    let b = slice(ptr, len);
    status(pmtiles::verify(b).and_then(|(a, e, c)| {
        let h = pmtiles::parse_header(b)?;
        let mut j = Json::new();
        j.obj().kv_int("addressed", a as i64).kv_int("entries", e as i64).kv_int("contents", c as i64).kv_int("minZoom", h.min_zoom as i64).kv_int("maxZoom", h.max_zoom as i64).kv_int("tileType", h.tile_type as i64).kv_bool("clustered", h.clustered).end_obj();
        set_out_json(j.finish());
        Ok(())
    }))
}
