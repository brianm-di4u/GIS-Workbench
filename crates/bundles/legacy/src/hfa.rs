//! `legacy` exports: hfa (FC-03, REQ-FMT-24/25).

use gw_abi::{set_out, set_out_json, slice, status, Error};
use gw_parse::hfa;

/// `EHFA_HEADER_TAG` + `Ehfa_File` → JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_file_header(ptr: *const u8, len: usize) -> i32 {
    status(hfa::file_header(slice(ptr, len)).map(set_out_json))
}

/// One 128-byte entry header → JSON.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_entry(ptr: *const u8, len: usize) -> i32 {
    status(hfa::entry(slice(ptr, len)).map(set_out_json))
}

fn type_name(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

/// Node data of type `ty` decoded by the dictionary text `dict` → JSON (arrays cut at `max`).
/// # Safety
/// All pointers must be readable for their lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_node(dict: *const u8, dict_len: usize, ty: *const u8, ty_len: usize, data: *const u8, data_len: usize, max: u32) -> i32 {
    let r = hfa::Dict::parse(slice(dict, dict_len)).and_then(|d| d.decode(&type_name(slice(ty, ty_len)), slice(data, data_len), max.max(1) as usize));
    status(r.map(set_out_json))
}

/// `Edms_State` node data → Uint32 (offset, size, flags) per block.
/// # Safety
/// All pointers must be readable for their lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_blocks(dict: *const u8, dict_len: usize, data: *const u8, data_len: usize) -> i32 {
    let r = hfa::Dict::parse(slice(dict, dict_len)).and_then(|d| hfa::block_table(&d, slice(data, data_len)));
    status(r.map(|v| set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect())))
}

/// One raster block → little-endian samples (`n` pixels; sub-byte types one byte per pixel).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_block(ptr: *const u8, len: usize, pixel_type: u32, n: u32, compressed: u32) -> i32 {
    status(hfa::decode_block(slice(ptr, len), pixel_type, n as usize, compressed != 0).map(set_out))
}

/// Writer: line spec → output = u32 LE JSON length, layout JSON, then the metadata bytes.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_hfa_write(ptr: *const u8, len: usize) -> i32 {
    let spec = String::from_utf8_lossy(slice(ptr, len)).into_owned();
    status(hfa::write(&spec).and_then(|(meta, layout)| {
        if layout.len() > u32::MAX as usize {
            return Err(Error::limit("layout too large"));
        }
        let jb = layout.into_bytes();
        let mut out = Vec::with_capacity(4 + jb.len() + meta.len());
        out.extend_from_slice(&(jb.len() as u32).to_le_bytes());
        out.extend_from_slice(&jb);
        out.extend_from_slice(&meta);
        set_out(out);
        Ok(())
    }))
}
