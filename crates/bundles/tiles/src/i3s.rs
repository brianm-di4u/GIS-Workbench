//! `tiles` exports: I3S scene layer packages (REQ-GAP-35): the SLPK's ZIP directory and the
//! uncompressed I3S geometry buffer (gw_tiles::i3s), with gzip-compressed resources inflated here.

use gw_abi::{set_out, slice, status, Error};
use gw_tiles::{gz, i3s};

/// The central directory of an SLPK from its tail. `prm` = [file length]. Output: three f64
/// (central directory offset, size, number of entries).
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_slpk_end(tail: *const u8, tlen: usize, prm: *const f64, plen: usize) -> i32 {
    let t = slice(tail, tlen);
    let p = slice(prm, plen);
    status((|| {
        let len = p.first().copied().filter(|v| v.is_finite() && *v >= 0.0).ok_or_else(|| Error::invalid("slpk: the file length is missing"))?;
        let e = i3s::zip_end(t, len as u64)?;
        let mut o = Vec::with_capacity(24);
        for v in [e.cd_offset, e.cd_size, e.entries] {
            o.extend_from_slice(&(v as f64).to_le_bytes());
        }
        set_out(o);
        Ok(())
    })())
}

/// The entries of an SLPK's central directory (`prm` = [maximum entries]), packed as
/// gw_tiles::i3s::pack_entries describes.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_slpk_directory(cd: *const u8, len: usize, prm: *const f64, plen: usize) -> i32 {
    let c = slice(cd, len);
    let p = slice(prm, plen);
    status((|| {
        let max = p.first().copied().filter(|v| v.is_finite() && *v >= 1.0).map(|v| v.min(5.0e7) as usize).unwrap_or(10_000_000);
        set_out(i3s::pack_entries(&i3s::central_directory(c, max)?));
        Ok(())
    })())
}

/// Decode an uncompressed I3S geometry buffer, gzip-compressed or not. `prm` = [offset, max
/// vertices, then type code and components for position, normal, uv0, color, uvRegion,
/// featureId, faceRange (code 0: absent)]. Output: gw_tiles::i3s::pack_geometry.
/// # Safety
/// The pointers must hold the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn gw_i3s_geometry(buf: *const u8, len: usize, prm: *const f64, plen: usize) -> i32 {
    let b = slice(buf, len);
    let p = slice(prm, plen);
    status((|| {
        if p.len() < 16 {
            return Err(Error::invalid("i3s: 16 parameters expected"));
        }
        if !(p[0].is_finite() && p[0] >= 0.0 && p[0] < 1.0e6 && p[1].is_finite() && p[1] >= 0.0) {
            return Err(Error::invalid("i3s: the geometry offset or vertex limit is out of range"));
        }
        let attr = |k: usize| -> Option<(i3s::Ty, usize)> {
            let t = i3s::Ty::from_code(p[2 + 2 * k])?;
            let c = p[3 + 2 * k];
            (c.is_finite() && (1.0..=16.0).contains(&c)).then_some((t, c as usize))
        };
        let l = i3s::Layout { offset: p[0] as usize, position: attr(0), normal: attr(1), uv0: attr(2), color: attr(3), uv_region: attr(4), feature_id: attr(5), face_range: attr(6) };
        let max = p[1].min(5.0e7) as usize;
        let raw;
        let data = if b.len() >= 2 && b[0] == 0x1f && b[1] == 0x8b {
            // A vertex is at most 64 bytes in any I3S layout.
            raw = gz::gunzip(b, max.saturating_mul(64).saturating_add(1 << 20))?;
            &raw[..]
        } else {
            b
        };
        set_out(i3s::pack_geometry(&i3s::decode_geometry(data, &l, max)?));
        Ok(())
    })())
}
