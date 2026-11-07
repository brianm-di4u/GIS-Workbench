//! `tiles` exports: qmesh (REQ-FMT-39, FC-14 writer).

use gw_abi::{set_out, slice, status, Error};
use gw_tiles::qmesh::{encode_tile, TileSpec};

/// Encode one quantized-mesh-1.0 tile. `z` = size² heights above the ellipsoid (row 0 north);
/// `prm` = [size, west, south, east, north (degrees), mercator (0/1), max error (m), normals (0/1)].
/// Output: the tile bytes.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_qmesh_tile(z: *const f32, zlen: usize, prm: *const f64, plen: usize) -> i32 {
    let zz = slice(z, zlen);
    let p = slice(prm, plen);
    status((|| {
        if p.len() < 8 {
            return Err(Error::invalid("qmesh: 8 parameters expected"));
        }
        if !(p[0].is_finite() && p[0] >= 0.0 && p[0] <= 257.0) {
            return Err(Error::invalid("qmesh: grid size out of range"));
        }
        let spec = TileSpec { size: p[0] as usize, west: p[1], south: p[2], east: p[3], north: p[4], mercator: p[5] != 0.0, max_error: p[6] as f32, normals: p[7] != 0.0 };
        set_out(encode_tile(zz, &spec)?);
        Ok(())
    })())
}
