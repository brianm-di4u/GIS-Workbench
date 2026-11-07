//! A stand-in for liblzo2 (GPL-2.0-or-later) in the sidecar's Linux Core GDAL module (REQ-SDC-12).
//!
//! conda-forge's Linux libarchive links liblzo2 for the lzop format only; GDAL uses libarchive for
//! /vsi7z/ and /vsirar/. Every entry point libarchive imports is here: initialisation and every
//! (de)compressor return LZO_E_ERROR, so lzop data is refused and nothing else changes.

#![no_std]

use core::ffi::{c_char, c_int, c_uint, c_ulong};

const LZO_E_ERROR: c_int = -1;

#[no_mangle]
pub extern "C" fn __lzo_init_v2() -> c_int {
    LZO_E_ERROR
}

#[no_mangle]
pub extern "C" fn lzo1x_1_compress() -> c_int {
    LZO_E_ERROR
}

#[no_mangle]
pub extern "C" fn lzo1x_1_15_compress() -> c_int {
    LZO_E_ERROR
}

#[no_mangle]
pub extern "C" fn lzo1x_999_compress_level() -> c_int {
    LZO_E_ERROR
}

#[no_mangle]
pub extern "C" fn lzo1x_decompress_safe() -> c_int {
    LZO_E_ERROR
}

#[no_mangle]
pub extern "C" fn lzo_adler32(adler: c_ulong, _buf: *const u8, _len: c_uint) -> c_ulong {
    adler
}

#[no_mangle]
pub extern "C" fn lzo_version() -> c_uint {
    0
}

#[no_mangle]
pub extern "C" fn lzo_version_string() -> *const c_char {
    c"none (LZO is not included: GIS Workbench sidecar)".as_ptr()
}

// No allocation, no unwinding: the library needs nothing from libc (Linux: no glibc version floor).
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
