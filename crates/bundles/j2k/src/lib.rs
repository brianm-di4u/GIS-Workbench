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
