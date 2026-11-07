//! `brotli` bundle (lazy, 2.1 tiles group): Brotli decompression for PMTiles directories and
//! tiles (FC-06, REQ-FMT-30). Kept apart from `tiles` because the RFC 7932 static dictionary
//! (122,784 bytes) dominates its size and only Brotli archives need it.

use gw_abi::{set_out, slice, status};
use gw_tiles::brotli;

gw_abi::export_abi!();

/// Decompress a Brotli stream; at most `max` bytes out (0 = 256 MiB). Output: the bytes.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_brotli_decompress(ptr: *const u8, len: usize, max: f64) -> i32 {
    let cap = if max > 0.0 { (max as usize).min(brotli::MAX_OUT) } else { brotli::MAX_OUT };
    status(brotli::decompress(slice(ptr, len), cap).map(set_out))
}
