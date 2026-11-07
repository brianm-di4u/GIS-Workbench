//! `legacy` exports: ojpeg (TIFF compression 6 stream reconstruction; REQ-FMT-43).

use gw_abi::{set_out, slice, status, Error};
use gw_codec::ojpeg::{header, stream, Record};

/// Table records packed as [kind u8][index u8][length u32 LE][bytes]… (kinds: 0 quantisation,
/// 1 DC Huffman, 2 AC Huffman, 3 interchange header) → the stream header (SOI, tables[, SOF]).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ojpeg_header(ptr: *const u8, len: usize) -> i32 {
    let b = slice(ptr, len);
    let mut recs = Vec::new();
    let mut i = 0;
    while i + 6 <= b.len() {
        let n = u32::from_le_bytes([b[i + 2], b[i + 3], b[i + 4], b[i + 5]]) as usize;
        let Some(bytes) = b.get(i + 6..i + 6 + n) else {
            return status::<()>(Err(Error::range("OJPEG: table record past the buffer")));
        };
        recs.push(Record { kind: b[i], index: b[i + 1], bytes });
        i += 6 + n;
    }
    status(header(&recs).map(set_out))
}

/// One strip or tile → a complete baseline JPEG stream (see gw_codec::ojpeg::stream).
/// # Safety
/// `hp`/`hn` and `bp`/`bn` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_ojpeg_stream(hp: *const u8, hn: usize, bp: *const u8, bn: usize, w: u32, h: u32, ncomp: u32, hs: u32, vs: u32, restart: u32) -> i32 {
    if w > 65535 || h > 65535 {
        return status::<()>(Err(Error::limit("OJPEG: block larger than 65535 pixels")));
    }
    status(stream(slice(hp, hn), slice(bp, bn), w as u16, h as u16, ncomp.min(255) as u8, hs.min(255) as u8, vs.min(255) as u8, restart.min(65535) as u16).map(set_out))
}

/// Classic-TIFF IFD entries (`ifd` = bytes from the entry count; `le` 1 for II) →
/// JSON {entries: [[tag, type, count, b0, b1, b2, b3]…]} (the value bytes as stored).
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_tiff_ifd(ptr: *const u8, len: usize, le: i32) -> i32 {
    status(gw_codec::ojpeg::ifd_entries(slice(ptr, len), le != 0).map(|es| {
        let mut j = gw_abi::Json::new();
        j.obj().key("entries").arr();
        for e in es {
            j.arr().int(e.tag as i64).int(e.typ as i64).int(e.count as i64);
            for b in e.raw {
                j.int(b as i64);
            }
            j.end_arr();
        }
        j.end_arr().end_obj();
        gw_abi::set_out_json(j.finish());
    }))
}

/// The IFD with invalid-type entries made harmless → output bytes; status 0 with an empty output
/// when no repair was needed.
/// # Safety
/// `ptr`/`len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_tiff_ifd_repair(ptr: *const u8, len: usize, le: i32) -> i32 {
    status(gw_codec::ojpeg::ifd_repair(slice(ptr, len), le != 0).map(|r| set_out(r.unwrap_or_default())))
}
