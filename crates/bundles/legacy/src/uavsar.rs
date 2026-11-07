//! `legacy` exports: uavsar (FC-24, REQ-FMT-53).

use gw_abi::{set_out_json, slice, status};
use gw_parse::uavsar;

/// Annotation → JSON (entries, layers, named files, corners).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_uavsar_ann(ptr: *const u8, len: usize) -> i32 {
    status(uavsar::parse(slice(ptr, len)).map(|a| set_out_json(uavsar::to_json(&a))))
}

/// Annotation + a binary file's name and size → the product JSON (layer, size, type, georeferencing).
/// # Safety
/// Pointers/lengths must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_uavsar_product(ptr: *const u8, len: usize, np: *const u8, nn: usize, file_len: f64) -> i32 {
    let name = String::from_utf8_lossy(slice(np, nn)).into_owned();
    status(uavsar::parse(slice(ptr, len)).and_then(|a| uavsar::product(&a, &name, file_len.max(0.0) as u64)).map(|p| set_out_json(uavsar::product_json(&p))))
}
