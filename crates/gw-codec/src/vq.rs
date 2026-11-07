//! NITF/RPF vector-quantised blocks (IC=C4/M4, CADRG/CIB): each 256×256 block is 64×64
//! 12-bit codewords; each codeword selects a 4×4 kernel from four row tables of 4096 × 4
//! bytes found in the RPF compression lookup subsection.

use gw_abi::{Error, Result};

pub const CODES_PER_BLOCK: usize = 6144;
pub const LUT_BYTES: usize = 4 * 4096 * 4;

/// Extract the four kernel-row tables from the compression lookup subsection (`sub` starts
/// at the subsection; the signature 00 00 00 06 00 0E may sit a few bytes later).
pub fn luts(sub: &[u8]) -> Result<Vec<u8>> {
    const SIG: [u8; 6] = [0, 0, 0, 6, 0, 0x0E];
    let start = (0..sub.len().saturating_sub(6).min(1000)).find(|&i| sub[i..i + 6] == SIG).ok_or_else(|| Error::invalid("VQ: compression lookup signature not found"))?;
    let s = &sub[start..];
    let mut out = vec![0u8; LUT_BYTES];
    for t in 0..4 {
        let at = 6 + t * 14 + 10;
        if at + 4 > s.len() {
            return Err(Error::range("VQ: short lookup offset records"));
        }
        let off = u32::from_be_bytes([s[at], s[at + 1], s[at + 2], s[at + 3]]) as usize;
        let tbl = s.get(off..off + 16384).ok_or_else(|| Error::range("VQ: lookup table beyond the subsection"))?;
        out[t * 16384..(t + 1) * 16384].copy_from_slice(tbl);
    }
    Ok(out)
}

/// Expand one block of codewords to 256×256 8-bit indices.
pub fn decode_block(codes: &[u8], luts: &[u8]) -> Result<Vec<u8>> {
    if codes.len() < CODES_PER_BLOCK || luts.len() < LUT_BYTES {
        return Err(Error::range("VQ: short block or tables"));
    }
    let mut out = vec![0u8; 256 * 256];
    let mut p = 0;
    for i in (0..256).step_by(4) {
        for j in (0..256).step_by(8) {
            let (a, b, c) = (codes[p] as usize, codes[p + 1] as usize, codes[p + 2] as usize);
            p += 3;
            let v1 = (a << 4) | (b >> 4);
            let v2 = ((b & 15) << 8) | c;
            for t in 0..4 {
                let row = (i + t) * 256 + j;
                let lt = &luts[t * 16384..];
                out[row..row + 4].copy_from_slice(&lt[v1 * 4..v1 * 4 + 4]);
                out[row + 4..row + 8].copy_from_slice(&lt[v2 * 4..v2 * 4 + 4]);
            }
        }
    }
    Ok(out)
}

/// RPF location table from an RPFIMG TRE: (id, size, absolute file offset) per component.
pub fn rpf_locations(tre: &[u8]) -> Result<Vec<(u16, u32, u32)>> {
    let r16 = |i: usize| tre.get(i..i + 2).map(|b| u16::from_be_bytes([b[0], b[1]]));
    let r32 = |i: usize| tre.get(i..i + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let sec = r32(2).ok_or_else(|| Error::range("RPFIMG: short"))? as usize;
    let n = r16(6).ok_or_else(|| Error::range("RPFIMG: short"))? as usize;
    let reclen = r16(8).ok_or_else(|| Error::range("RPFIMG: short"))?;
    if reclen != 10 {
        return Err(Error::invalid("RPFIMG: unexpected location record length"));
    }
    let mut out = Vec::new();
    for k in 0..n {
        let at = sec + k * 10;
        match (r16(at), r32(at + 2), r32(at + 6)) {
            (Some(id), Some(size), Some(off)) => out.push((id, size, off)),
            _ => return Err(Error::range("RPFIMG: location records run past the TRE")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kernel_expansion() {
        let mut luts = vec![0u8; LUT_BYTES];
        for t in 0..4 {
            for k in 0..4 {
                luts[t * 16384 + 4 + k] = (t * 10 + k + 1) as u8;
            }
        }
        let mut codes = vec![0u8; CODES_PER_BLOCK];
        codes[1] = 0x10; // v1 = 1, v2 = 0
        let out = decode_block(&codes, &luts).unwrap();
        assert_eq!(&out[0..8], &[1, 2, 3, 4, 0, 0, 0, 0]);
        assert_eq!(&out[3 * 256..3 * 256 + 4], &[31, 32, 33, 34]);
    }
}
