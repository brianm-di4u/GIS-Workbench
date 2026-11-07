//! `legacy` exports: aridpcm (NITF IC=C2/M2, MIL-STD-188-197A; REQ-FMT-44/45).

use gw_abi::{set_out, slice, status, Error};
use gw_codec::aridpcm::{decode, encode, Params};
use gw_codec::Raster;

fn params(nbpp: u32, comrat: *const u8, comrat_len: usize) -> gw_abi::Result<Params> {
    // SAFETY: the caller passes a readable COMRAT string.
    let c = String::from_utf8_lossy(unsafe { slice(comrat, comrat_len) }).to_string();
    Params::new(nbpp, &c)
}

/// Decode one ARIDPCM block of `w` × `h` samples → gw-codec raster encoding (u8 planes for 8-bit,
/// u16 LE for 11-bit); the `bits` header field is 8 or 11.
/// # Safety
/// `ptr`/`len` and `comrat`/`comrat_len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_aridpcm_decode(
    ptr: *const u8,
    len: usize,
    w: u32,
    h: u32,
    nbpp: u32,
    comrat: *const u8,
    comrat_len: usize,
) -> i32 {
    status(params(nbpp, comrat, comrat_len).and_then(|p| {
        let d = decode(slice(ptr, len), w as usize, h as usize, &p)?;
        let bits = if nbpp <= 8 { 8 } else { 11 };
        set_out(gw_codec::encode(&Raster {
            width: w,
            height: h,
            comps: 1,
            bits,
            data: d.data,
        }));
        Ok(())
    }))
}

/// 1 when every quantisation table of (NBPP, COMRAT) is the standard's own (8-bit 0.75 bpp), 0 when
/// some are derived (the decode is approximate), negative status for an unsupported rate.
/// # Safety
/// `comrat`/`comrat_len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_aridpcm_exact(nbpp: u32, comrat: *const u8, comrat_len: usize) -> i32 {
    match params(nbpp, comrat, comrat_len) {
        Ok(p) => p.exact() as i32,
        Err(e) => -status::<()>(Err(e)),
    }
}

/// Encode one block (non-driven mode): samples u8 (`nbpp` ≤ 8) or u16 LE → coded bytes.
/// # Safety
/// `ptr`/`len` and `comrat`/`comrat_len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_aridpcm_encode(
    ptr: *const u8,
    len: usize,
    w: u32,
    h: u32,
    nbpp: u32,
    comrat: *const u8,
    comrat_len: usize,
) -> i32 {
    status(params(nbpp, comrat, comrat_len).and_then(|p| {
        let b = slice(ptr, len);
        let n = w as usize * h as usize;
        let px: Vec<u16> = if nbpp <= 8 {
            b.get(..n)
                .ok_or_else(|| Error::range("ARIDPCM encode: short sample buffer"))?
                .iter()
                .map(|&v| v as u16)
                .collect()
        } else {
            b.get(..n * 2)
                .ok_or_else(|| Error::range("ARIDPCM encode: short sample buffer"))?
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect()
        };
        set_out(encode(&px, w as usize, h as usize, &p)?);
        Ok(())
    }))
}

/// Byte extents of `nblocks` consecutive blocks of `w` × `h` in an unmasked C2 segment (each block
/// starts on a byte boundary; its length follows from its busyness codes) → JSON [[offset, length]…].
/// # Safety
/// `ptr`/`len` and `comrat`/`comrat_len` must be readable.
#[no_mangle]
pub unsafe extern "C" fn gw_aridpcm_index(
    ptr: *const u8,
    len: usize,
    nblocks: u32,
    w: u32,
    h: u32,
    nbpp: u32,
    comrat: *const u8,
    comrat_len: usize,
) -> i32 {
    status(params(nbpp, comrat, comrat_len).and_then(|p| {
        let b = slice(ptr, len);
        let mut j = gw_abi::Json::new();
        j.arr();
        let mut at = 0usize;
        for k in 0..nblocks {
            let bits = gw_codec::aridpcm::coded_bits(
                b.get(at..).unwrap_or(&[]),
                w as usize,
                h as usize,
                &p,
            )?;
            let n = bits.div_ceil(8);
            if at + n > b.len() {
                return Err(gw_abi::err!(RANGE, "ARIDPCM block {block} runs past the segment", block = k + 1));
            }
            j.arr().int(at as i64).int(n as i64).end_arr();
            at += n;
        }
        j.end_arr();
        gw_abi::set_out_json(j.finish());
        Ok(())
    }))
}
