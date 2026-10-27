//! Unpack an uncompressed NITF block into band-sequential planes of the native sample type
//! (`Research/14` §2.7). Handles IMODE B, P, R and S, any NBPP from 1 to 64 (bit-packed, MSB
//! first, e.g. 12-bit), ABPP/PJUST, and the INT/SI/R/C/B pixel types. Output is little-endian.

use gw_abi::{Error, Result};

/// Output sample type codes (shared with the JS wrapper).
pub const T_U8: i32 = 1;
pub const T_U16: i32 = 2;
pub const T_I16: i32 = 3;
pub const T_U32: i32 = 4;
pub const T_I32: i32 = 5;
pub const T_F32: i32 = 6;
/// Complex: two f32 (I, Q) per sample, interleaved inside each band plane.
pub const T_CF32: i32 = 7;

/// pvtype: 0 INT, 1 SI, 2 R, 3 C, 4 B
pub fn sample_type(nbpp: u32, pvtype: i32) -> Result<i32> {
    Ok(match (pvtype, nbpp) {
        (4, _) => T_U8,
        (0, 1..=8) => T_U8,
        (0, 9..=16) => T_U16,
        (0, 17..=32) => T_U32,
        (1, 1..=16) => T_I16,
        (1, 17..=32) => T_I32,
        (2, 32) | (2, 64) => T_F32,
        (3, 64) => T_CF32,
        _ => return Err(Error::unsupported(format!("pixel type {pvtype} with NBPP {nbpp} is not supported"))),
    })
}

pub fn bytes_per_sample(t: i32) -> usize {
    match t {
        T_U8 => 1,
        T_U16 | T_I16 => 2,
        T_U32 | T_I32 | T_F32 => 4,
        _ => 8,
    }
}

struct Bits<'a> {
    b: &'a [u8],
    bit: usize,
}

impl Bits<'_> {
    #[inline]
    fn read(&mut self, n: u32) -> u64 {
        let mut v: u64 = 0;
        let mut need = n as usize;
        while need > 0 {
            let byte = self.bit >> 3;
            let off = self.bit & 7;
            let avail = 8 - off;
            let take = avail.min(need);
            let cur = *self.b.get(byte).unwrap_or(&0) as u64;
            let bits = (cur >> (avail - take)) & ((1u64 << take) - 1);
            v = (v << take) | bits;
            self.bit += take;
            need -= take;
        }
        v
    }
}

/// imode: b'B', b'P', b'R', b'S' (S = the block holds one band; pass nbands = 1).
#[allow(clippy::too_many_arguments)]
pub fn unpack_block(raw: &[u8], w: usize, h: usize, nbands: usize, nbpp: u32, abpp: u32, pjust_left: bool, pvtype: i32, imode: u8) -> Result<(i32, Vec<u8>)> {
    if w == 0 || h == 0 || nbands == 0 {
        return Err(Error::invalid("empty block"));
    }
    let npix = w.checked_mul(h).ok_or_else(|| Error::limit("block too large"))?;
    if npix > 64 * 1024 * 1024 || nbands > 4096 {
        return Err(Error::limit("block too large"));
    }
    let t = sample_type(nbpp, pvtype)?;
    let bps = bytes_per_sample(t);
    let band_bits = npix * nbpp as usize;
    let band_bytes = band_bits.div_ceil(8);
    let need = match imode {
        b'B' => band_bytes * nbands,
        _ => (band_bits * nbands).div_ceil(8),
    };
    if raw.len() < need {
        return Err(Error::range(format!("block has {} bytes, needs {}", raw.len(), need)));
    }
    let mut out = vec![0u8; npix * nbands * bps];
    let shift = if pjust_left && abpp > 0 && abpp < nbpp { nbpp - abpp } else { 0 };
    let mask: u64 = if !pjust_left && abpp > 0 && abpp < nbpp { (1u64 << abpp) - 1 } else { u64::MAX };
    let mut put = |band: usize, idx: usize, v: u64| {
        let v = (v >> shift) & mask;
        let o = (band * npix + idx) * bps;
        match t {
            T_U8 => out[o] = if pvtype == 4 { (v as u8) * 255 } else { v as u8 },
            T_U16 => out[o..o + 2].copy_from_slice(&(v as u16).to_le_bytes()),
            T_I16 => {
                let s = sign_extend(v, nbpp) as i16;
                out[o..o + 2].copy_from_slice(&s.to_le_bytes());
            }
            T_U32 => out[o..o + 4].copy_from_slice(&(v as u32).to_le_bytes()),
            T_I32 => out[o..o + 4].copy_from_slice(&(sign_extend(v, nbpp) as i32).to_le_bytes()),
            T_F32 => {
                let f = if nbpp == 32 { f32::from_bits(v as u32) } else { f64::from_bits(v) as f32 };
                out[o..o + 4].copy_from_slice(&f.to_le_bytes());
            }
            _ => {
                // complex: 64 bits = I (f32) then Q (f32)
                let i = f32::from_bits((v >> 32) as u32);
                let q = f32::from_bits(v as u32);
                out[o..o + 4].copy_from_slice(&i.to_le_bytes());
                out[o + 4..o + 8].copy_from_slice(&q.to_le_bytes());
            }
        }
    };
    // Fast path for byte-aligned 8/16-bit data in planar order.
    match imode {
        b'B' | b'S' => {
            for band in 0..nbands {
                let mut bits = Bits { b: &raw[band * band_bytes..], bit: 0 };
                for i in 0..npix {
                    put(band, i, bits.read(nbpp));
                }
            }
        }
        b'P' => {
            let mut bits = Bits { b: raw, bit: 0 };
            for i in 0..npix {
                for band in 0..nbands {
                    put(band, i, bits.read(nbpp));
                }
            }
        }
        b'R' => {
            let mut bits = Bits { b: raw, bit: 0 };
            for y in 0..h {
                for band in 0..nbands {
                    for x in 0..w {
                        put(band, y * w + x, bits.read(nbpp));
                    }
                }
            }
        }
        _ => return Err(Error::unsupported("unknown IMODE")),
    }
    Ok((t, out))
}

fn sign_extend(v: u64, bits: u32) -> i64 {
    if bits >= 64 {
        return v as i64;
    }
    let s = 64 - bits;
    ((v << s) as i64) >> s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twelve_bit_packed() {
        // Two 12-bit pixels 0xABC, 0x123 packed in 3 bytes.
        let (t, out) = unpack_block(&[0xAB, 0xC1, 0x23], 2, 1, 1, 12, 12, false, 0, b'B').unwrap();
        assert_eq!(t, T_U16);
        assert_eq!(u16::from_le_bytes([out[0], out[1]]), 0xABC);
        assert_eq!(u16::from_le_bytes([out[2], out[3]]), 0x123);
    }

    #[test]
    fn imodes_agree() {
        // 2×2 pixels, 3 bands, 8-bit: band k pixel i = 10k + i
        let planar: Vec<u8> = (0..3).flat_map(|k| (0..4).map(move |i| (10 * k + i) as u8)).collect();
        let pixel: Vec<u8> = (0..4).flat_map(|i| (0..3).map(move |k| (10 * k + i) as u8)).collect();
        let row: Vec<u8> = (0..2).flat_map(|y| (0..3).flat_map(move |k| (0..2).map(move |x| (10 * k + y * 2 + x) as u8))).collect();
        let a = unpack_block(&planar, 2, 2, 3, 8, 8, false, 0, b'B').unwrap().1;
        let b = unpack_block(&pixel, 2, 2, 3, 8, 8, false, 0, b'P').unwrap().1;
        let c = unpack_block(&row, 2, 2, 3, 8, 8, false, 0, b'R').unwrap().1;
        assert_eq!(a, planar);
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn abpp_justification() {
        // 16-bit container, 11 bits used. Right-justified: mask; left: shift.
        let (_, r) = unpack_block(&[0xF8, 0x01], 1, 1, 1, 16, 11, false, 0, b'B').unwrap();
        assert_eq!(u16::from_le_bytes([r[0], r[1]]), 0x0001);
        let (_, l) = unpack_block(&[0xFF, 0xE0], 1, 1, 1, 16, 11, true, 0, b'B').unwrap();
        assert_eq!(u16::from_le_bytes([l[0], l[1]]), 0x7FF);
    }

    #[test]
    fn signed_float_and_bilevel() {
        let (t, s) = unpack_block(&[0xFF, 0xFE], 1, 1, 1, 16, 16, false, 1, b'B').unwrap();
        assert_eq!(t, T_I16);
        assert_eq!(i16::from_le_bytes([s[0], s[1]]), -2);
        let (t, f) = unpack_block(&1.5f32.to_be_bytes(), 1, 1, 1, 32, 32, false, 2, b'B').unwrap();
        assert_eq!(t, T_F32);
        assert_eq!(f32::from_le_bytes([f[0], f[1], f[2], f[3]]), 1.5);
        let (_, b) = unpack_block(&[0b1010_0000], 3, 1, 1, 1, 1, false, 4, b'B').unwrap();
        assert_eq!(b, vec![255, 0, 255]);
    }

    #[test]
    fn short_block_is_an_error() {
        assert!(unpack_block(&[0; 3], 2, 2, 1, 8, 8, false, 0, b'B').is_err());
    }
}
