//! `tiles` exports: gzip for the writers. Brotli decoding (FC-06) is the separate lazy `brotli`
//! bundle (crates/bundles/brotli): its RFC 7932 dictionary alone would take most of this bundle's
//! 140 KB budget, and only Brotli archives need it.

use gw_abi::{set_out, slice};
use gw_tiles::gz;

/// gzip one member (level 0..10). Output: the gzip bytes.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_gzip(ptr: *const u8, len: usize, level: u32) -> i32 {
    set_out(gz::gzip(slice(ptr, len), level.min(10) as u8));
    gw_abi::OK
}
