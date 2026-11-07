//! gzip (RFC 1952) members over miniz_oxide's deflate, for PMTiles directories, metadata and
//! MVT tiles (REQ-FMT-31, REQ-FMT-33).

use gw_abi::{Error, Result};

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, e) in t.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    t
}

/// CRC-32 (ISO 3309), as gzip stores it.
pub fn crc32(data: &[u8]) -> u32 {
    let t = crc_table();
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c = t[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// One gzip member: no name, mtime 0, OS 255 (so the output is deterministic).
pub fn gzip(data: &[u8], level: u8) -> Vec<u8> {
    let body = miniz_oxide::deflate::compress_to_vec(data, level.min(10));
    let mut out = Vec::with_capacity(body.len() + 18);
    out.extend_from_slice(&[0x1f, 0x8b, 8, 0, 0, 0, 0, 0, if level >= 9 { 2 } else { 0 }, 255]);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out
}

/// Inflate one gzip member (header fields FEXTRA/FNAME/FCOMMENT/FHCRC skipped), checking CRC and size.
pub fn gunzip(data: &[u8], max: usize) -> Result<Vec<u8>> {
    if data.len() < 18 || data[0] != 0x1f || data[1] != 0x8b || data[2] != 8 {
        return Err(Error::invalid("not gzip data"));
    }
    let flg = data[3];
    let mut p = 10usize;
    if flg & 4 != 0 {
        let n = *data.get(p).ok_or_else(|| Error::invalid("gzip header cut"))? as usize | (*data.get(p + 1).ok_or_else(|| Error::invalid("gzip header cut"))? as usize) << 8;
        p += 2 + n;
    }
    for bit in [8u8, 16] {
        if flg & bit != 0 {
            while *data.get(p).ok_or_else(|| Error::invalid("gzip header cut"))? != 0 {
                p += 1;
            }
            p += 1;
        }
    }
    if flg & 2 != 0 {
        p += 2;
    }
    if p + 8 > data.len() {
        return Err(Error::invalid("gzip data cut"));
    }
    let out = miniz_oxide::inflate::decompress_to_vec_with_limit(&data[p..data.len() - 8], max).map_err(|e| match e.status {
        miniz_oxide::inflate::TINFLStatus::HasMoreOutput => gw_abi::err!(LIMIT, "gzip data expands past {mib} MiB", mib = max >> 20),
        _ => Error::invalid("the gzip data is damaged"),
    })?;
    let t = &data[data.len() - 8..];
    if u32::from_le_bytes([t[0], t[1], t[2], t[3]]) != crc32(&out) {
        return Err(Error::invalid("gzip CRC mismatch"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_crc() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        let d: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let z = gzip(&d, 6);
        assert_eq!(gunzip(&z, 1 << 20).unwrap(), d);
        assert!(gunzip(&z, 100).is_err());
        let mut bad = z.clone();
        let n = bad.len();
        bad[n - 6] ^= 1;
        assert!(gunzip(&bad, 1 << 20).is_err());
        assert!(gunzip(&z[..z.len() / 2], 1 << 20).is_err());
    }
}
