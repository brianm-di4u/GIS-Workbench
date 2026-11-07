//! `legacy` exports: rpf (A.TOC table of contents, MIL-STD-2411; REQ-FMT-40).

use gw_abi::{set_out_json, slice, status};
use gw_parse::rpf_toc;

/// A.TOC bytes (whole file) → JSON {boundaries: [{product, scale, zone, nw, se, …, frames: […]}]}.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_rpf_toc(ptr: *const u8, len: usize) -> i32 {
    status(rpf_toc::parse(slice(ptr, len)).map(|t| set_out_json(rpf_toc::to_json(&t))))
}

/// MrSID (kind 1) or ECW (kind 2) container header (first bytes of the file) → footprint JSON
/// {format, version, width, height, bands, bits, georef: {gt, epsg, wkt, source} | null, meta}.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_footprint_header(kind: i32, ptr: *const u8, len: usize) -> i32 {
    use gw_parse::footprint;
    let b = slice(ptr, len);
    status(if kind == 1 { footprint::mrsid(b) } else { footprint::ecw(b) }.map(|f| set_out_json(footprint::to_json(&f))))
}
