//! `legacy` exports: netcdf3 (FC-04, REQ-FMT-26/27).

use gw_abi::{set_out, set_out_json, slice, status};
use gw_parse::netcdf3;

/// NetCDF-3 header (a prefix of the file) → JSON. RANGE: give a longer prefix.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nc3_header(ptr: *const u8, len: usize, file_size: f64) -> i32 {
    status(netcdf3::parse(slice(ptr, len)).map(|h| set_out_json(netcdf3::to_json(&h, file_size as u64))))
}

/// Writer: line spec → output = u32 LE JSON length, layout JSON, then the header bytes.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_nc3_write_header(ptr: *const u8, len: usize) -> i32 {
    let spec = String::from_utf8_lossy(slice(ptr, len)).into_owned();
    status(netcdf3::write_header(&spec).map(|(head, layout)| {
        let jb = layout.into_bytes();
        let mut out = Vec::with_capacity(4 + jb.len() + head.len());
        out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
        out.extend_from_slice(&jb);
        out.extend_from_slice(&head);
        set_out(out);
    }))
}
