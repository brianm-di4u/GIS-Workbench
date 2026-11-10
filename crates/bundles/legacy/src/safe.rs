//! `legacy` exports: safe (FC-26, REQ-FMT-55), and Sentinel orbit files (REG-085).

use gw_abi::{set_out_json, slice, status, Error};
use gw_parse::safe;

/// kind 1 manifest.safe, 2 product annotation, 3 calibration, 4 noise, 5 orbit file (`.EOF`) → JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_safe_xml(kind: i32, ptr: *const u8, len: usize) -> i32 {
    let b = slice(ptr, len);
    status(match kind {
        1 => safe::manifest(b),
        2 => safe::annotation(b),
        3 => safe::calibration(b),
        4 => safe::noise(b),
        5 => safe::eof(b),
        _ => Err(Error::invalid("unknown SAFE document kind")),
    }
    .map(set_out_json))
}
