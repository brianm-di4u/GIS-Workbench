//! `j2k` bundle (lazy; decode worker): JPEG 2000 decoding for NITF IC=C8/M8 and JP2 files.
//! Kept apart from `parse` so the decoder loads only when a JPEG 2000 image opens.

use gw_abi::{set_out, slice, status};

gw_abi::export_abi!();

/// Decode a JPEG 2000 codestream or JP2 file. `tw`/`th` > 0 request a reduced resolution.
/// Output: gw-codec raster encoding (16-byte header, planar samples).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_j2k_decode(ptr: *const u8, len: usize, tw: u32, th: u32) -> i32 {
    let target = if tw > 0 && th > 0 { Some((tw, th)) } else { None };
    status(gw_codec::j2k::decode(slice(ptr, len), target).map(|r| set_out(gw_codec::encode(&r))))
}

/// Window `x, y, w, h` (full-resolution pixels) of a tiled codestream, decoded from the intersecting
/// tiles only, at resolution level 1/2^`reduce`.
/// Output: window origin x, y (u32 LE, full-resolution image pixels) then the gw-codec raster encoding of the
/// tile-aligned window. Fails (status ≠ 0) for PPM headers or subsampled components.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_j2k_decode_region(ptr: *const u8, len: usize, x: u32, y: u32, w: u32, h: u32, reduce: u32) -> i32 {
    status(gw_codec::j2k::decode_region(slice(ptr, len), x, y, w, h, reduce).map(|(ox, oy, r)| {
        let mut v = Vec::with_capacity(8);
        v.extend_from_slice(&ox.to_le_bytes());
        v.extend_from_slice(&oy.to_le_bytes());
        v.extend(gw_codec::encode(&r));
        set_out(v)
    }))
}
