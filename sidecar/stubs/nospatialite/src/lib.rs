//! A stand-in for libspatialite (the sidecar's Core GDAL module, REQ-SDC-12).
//!
//! conda-forge's libspatialite links librttopo (GPL-2.0-or-later): statically on Windows,
//! dynamically on Linux. GDAL is linked against libspatialite but needs it only for SpatiaLite's
//! SQL functions in the SQLite dialect and for creating SpatiaLite databases. This library has the
//! five entry points GDAL calls: `spatialite_alloc_connection` returns no connection, so GDAL finds
//! no SpatiaLite. GeoPackage (with its SQL functions) and every raster and vector driver keep
//! working; creating SpatiaLite databases and spatial SQL functions in GDAL's SQLite dialect do
//! not (GDAL reports "Spatialite extensions are not loaded"). No conversion profile uses either.

#![no_std]

use core::ffi::{c_char, c_int, c_void};

#[no_mangle]
pub extern "C" fn spatialite_alloc_connection() -> *mut c_void {
    core::ptr::null_mut()
}

#[no_mangle]
pub extern "C" fn spatialite_init_ex(_db: *mut c_void, _ptr: *const c_void, _verbose: c_int) {}

#[no_mangle]
pub extern "C" fn spatialite_cleanup_ex(_ptr: *const c_void) {}

#[no_mangle]
pub extern "C" fn spatialite_shutdown() {}

#[no_mangle]
pub extern "C" fn spatialite_version() -> *const c_char {
    c"0.0.0 (not included: GIS Workbench sidecar)".as_ptr()
}

// No allocation, no unwinding: the library needs nothing from libc (Linux: no glibc version floor).
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
