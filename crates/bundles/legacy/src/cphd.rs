//! `legacy` exports: cphd (FC-21, REQ-FMT-49, REQ-FMT-51).
//!
//! Every call takes the file header bytes (the first 64 KiB at most), the XML block and the file
//! length, and parses and checks them again: the XML is small, so no state is kept between calls.

use gw_abi::{set_out, set_out_json, slice, status, Error, Result};
use gw_parse::cphd;

unsafe fn meta(hp: *const u8, hn: usize, xp: *const u8, xn: usize, file_len: f64) -> Result<cphd::Meta> {
    if !(file_len >= 0.0) {
        return Err(Error::invalid("CPHD file length is not a number"));
    }
    cphd::parse(slice(hp, hn), slice(xp, xn), file_len as u64)
}

/// Header + XML → summary/layout JSON with the XML tree.
/// # Safety
/// Pointers/lengths must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_cphd_open(hp: *const u8, hn: usize, xp: *const u8, xn: usize, file_len: f64) -> i32 {
    status(meta(hp, hn, xp, xn, file_len).map(|m| set_out_json(cphd::to_json(&m))))
}

/// PVP records (whole records) → f64 columns (little-endian), see `cphd::pvp_columns`.
/// # Safety
/// Pointers/lengths must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_cphd_pvp(hp: *const u8, hn: usize, xp: *const u8, xn: usize, file_len: f64, bp: *const u8, bn: usize) -> i32 {
    status(meta(hp, hn, xp, xn, file_len).and_then(|m| cphd::pvp_columns(&m, slice(bp, bn))).map(|v| set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect())))
}

/// Support array `index` (its bytes) → f32 values (little-endian), components interleaved.
/// # Safety
/// Pointers/lengths must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_cphd_support(hp: *const u8, hn: usize, xp: *const u8, xn: usize, file_len: f64, index: usize, bp: *const u8, bn: usize) -> i32 {
    status(meta(hp, hn, xp, xn, file_len).and_then(|m| {
        let s = m.support.get(index).ok_or_else(|| Error::range("no such CPHD support array"))?;
        cphd::support_values(s, slice(bp, bn))
    }).map(|v| set_out(v.iter().flat_map(|x| x.to_le_bytes()).collect())))
}

/// Subset (REQ-FMT-51): spec = [n, (channel index, v0, v1, s0, s1) × n] as f64; `pvp` = the source PVP
/// records of the kept vectors, channel after channel. Output: u64 LE prefix length, the prefix
/// (header + XML, padded to the support block), u64 LE padding after the support block, the new PVP block.
/// # Safety
/// Pointers/lengths must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_cphd_subset(hp: *const u8, hn: usize, xp: *const u8, xn: usize, file_len: f64, sp: *const f64, sn: usize, pp: *const u8, pn: usize) -> i32 {
    status(meta(hp, hn, xp, xn, file_len).and_then(|m| {
        let spec = slice(sp, sn);
        let n = spec.first().copied().unwrap_or(0.0) as usize;
        if n == 0 || sn != 1 + 5 * n {
            return Err(Error::invalid("CPHD subset spec is malformed"));
        }
        let whole = |v: f64| if v >= 0.0 && v.fract() == 0.0 && v < 9e15 { Ok(v as u64) } else { Err(Error::invalid("CPHD subset spec holds a value that is not a whole number")) };
        let mut subs = Vec::with_capacity(n);
        for k in 0..n {
            let r = &spec[1 + 5 * k..6 + 5 * k];
            subs.push(cphd::Sub { ch: whole(r[0])? as usize, v0: whole(r[1])?, v1: whole(r[2])?, s0: whole(r[3])?, s1: whole(r[4])? });
        }
        let (prefix, pvp) = cphd::subset(&m, &subs, slice(pp, pn))?;
        let mut out = Vec::with_capacity(16 + prefix.len() + pvp.len());
        out.extend_from_slice(&(prefix.len() as u64).to_le_bytes());
        out.extend_from_slice(&prefix);
        out.extend_from_slice(&cphd::pad_after_support(&m).to_le_bytes());
        out.extend_from_slice(&pvp);
        Ok(out)
    }).map(set_out))
}
