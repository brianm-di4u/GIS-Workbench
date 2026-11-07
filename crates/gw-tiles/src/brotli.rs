//! Brotli decompression for PMTiles tiles and directories (FC-06, REQ-FMT-30).
//!
//! Wraps `brotli-decompressor` (BSD-3-Clause/MIT) with an output cap, so a small hostile stream
//! cannot expand without bound, and with errors instead of panics for damaged or cut input.

use gw_abi::{Error, Result};
use std::io::Read;

/// Default output limit for one tile or directory (256 MiB).
pub const MAX_OUT: usize = 256 << 20;

/// Decompress a whole Brotli stream (RFC 7932). Fails when the stream is damaged, ends early,
/// or would expand past `max` bytes.
pub fn decompress(input: &[u8], max: usize) -> Result<Vec<u8>> {
    if input.is_empty() {
        return Err(Error::invalid("the Brotli stream is empty"));
    }
    let mut r = brotli_decompressor::Decompressor::new(input, 4096);
    let mut out = Vec::with_capacity(input.len().saturating_mul(3).min(max).min(1 << 24));
    let mut buf = [0u8; 16384];
    loop {
        let n = r.read(&mut buf).map_err(|e| gw_abi::err!(INVALID, "the Brotli stream is damaged ({e})", e))?;
        if n == 0 {
            break;
        }
        if out.len() + n > max {
            return Err(gw_abi::err!(LIMIT, "the Brotli stream expands past the {mib} MiB limit", mib = max >> 20));
        }
        out.extend_from_slice(&buf[..n]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // "hello hello hello hello\n" compressed at quality 11 (Node zlib, the reference encoder).
    const HELLO: &[u8] = &[0x1b, 0x17, 0x00, 0xf8, 0x8d, 0x94, 0x6e, 0xde, 0x44, 0x55, 0x86, 0xd6, 0x0a, 0x20, 0x6c, 0x6f, 0x4a, 0x11, 0x79, 0xe2, 0x80, 0xae, 0x16];

    #[test]
    fn decodes_reference_stream() {
        let out = decompress(HELLO, MAX_OUT).unwrap();
        assert_eq!(out, b"hello hello hello hello\n");
    }

    #[test]
    fn empty_and_garbage_fail() {
        assert!(decompress(&[], MAX_OUT).is_err());
        assert!(decompress(&[0xff; 64], MAX_OUT).is_err());
    }

    #[test]
    fn truncated_fails_or_is_short() {
        for n in 1..HELLO.len() {
            if let Ok(v) = decompress(&HELLO[..n], MAX_OUT) {
                assert!(v.len() < 24, "cut stream at {n} gave the whole output");
            }
        }
    }

    #[test]
    fn cap_is_enforced() {
        assert!(decompress(HELLO, 8).is_err());
    }
}
