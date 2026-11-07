//! TIFF old-style JPEG (compression 6) stream reconstruction (FC-17, REQ-FMT-43), as libtiff's
//! tif_ojpeg.c does: each strip or tile becomes a self-contained baseline JPEG stream.
//!
//! The tables come either from a JPEG interchange header (JPEGInterchangeFormat: SOI, DQT, DHT, SOF…)
//! or from the JPEGQTables / JPEGDCTables / JPEGACTables tags (64 quantisation values in zig-zag
//! order; 16 Huffman code counts followed by the symbols). The block itself holds entropy-coded data,
//! with or without its own SOS. The stream is: SOI, tables, SOF0 sized to the block, DRI when the
//! restart interval is set, SOS (the block's or a synthesised one), the data and EOI. Inputs are
//! untrusted: every length is checked and errors are returned, never panics.

use gw_abi::{Error, Result};

/// One table record for [`header`]: kind 0 = quantisation (64 bytes), 1 = DC Huffman,
/// 2 = AC Huffman (counts + symbols, the bytes may run past the table), 3 = interchange header.
pub struct Record<'a> {
    pub kind: u8,
    pub index: u8,
    pub bytes: &'a [u8],
}

fn seg(out: &mut Vec<u8>, marker: u8, body: &[u8]) -> Result<()> {
    if body.len() + 2 > 0xffff {
        return Err(Error::invalid("OJPEG: marker segment too long"));
    }
    out.extend_from_slice(&[0xff, marker]);
    out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(body);
    Ok(())
}

/// Marker segments of an interchange header up to (not including) its SOS or EOI, without SOI.
fn interchange_segments(jif: &[u8]) -> Result<Vec<u8>> {
    if jif.len() < 4 || jif[0] != 0xff || jif[1] != 0xd8 {
        return Err(Error::invalid("OJPEG: JPEGInterchangeFormat does not start with SOI"));
    }
    let mut out = Vec::new();
    let mut i = 2;
    while i + 4 <= jif.len() {
        if jif[i] != 0xff {
            return Err(Error::invalid("OJPEG: interchange header is not a marker sequence"));
        }
        let m = jif[i + 1];
        if m == 0xff {
            i += 1;
            continue;
        }
        if m == 0xda || m == 0xd9 {
            break;
        }
        let len = u16::from_be_bytes([jif[i + 2], jif[i + 3]]) as usize;
        if len < 2 || i + 2 + len > jif.len() {
            return Err(Error::range("OJPEG: interchange marker segment runs past its end"));
        }
        // Keep the tables, SOF and DRI; drop comments and application segments.
        if matches!(m, 0xdb | 0xc4 | 0xdd | 0xc0 | 0xc1) {
            out.extend_from_slice(&jif[i..i + 2 + len]);
        } else if (0xc2..=0xcf).contains(&m) && m != 0xc4 && m != 0xc8 && m != 0xcc {
            return Err(Error::unsupported("OJPEG: only baseline (SOF0/SOF1) old-style JPEG is decoded"));
        }
        i += 2 + len;
    }
    Ok(out)
}

/// The tables part of every block's stream (SOI first; with an SOF when it came from an
/// interchange header).
pub fn header(records: &[Record]) -> Result<Vec<u8>> {
    let mut out = vec![0xff, 0xd8];
    if let Some(r) = records.iter().find(|r| r.kind == 3) {
        out.extend(interchange_segments(r.bytes)?);
        return Ok(out);
    }
    for r in records {
        match r.kind {
            0 => {
                let q = r.bytes.get(..64).ok_or_else(|| Error::range("OJPEG: quantisation table shorter than 64 bytes"))?;
                let mut body = vec![r.index & 3];
                body.extend_from_slice(q);
                seg(&mut out, 0xdb, &body)?;
            }
            1 | 2 => {
                let counts = r.bytes.get(..16).ok_or_else(|| Error::range("OJPEG: Huffman table shorter than its counts"))?;
                let n: usize = counts.iter().map(|&c| c as usize).sum();
                if n == 0 || n > 256 {
                    return Err(Error::invalid(format!("OJPEG: Huffman table with {n} codes")));
                }
                let syms = r.bytes.get(16..16 + n).ok_or_else(|| Error::range("OJPEG: Huffman symbols run past the file"))?;
                let mut body = vec![(if r.kind == 2 { 0x10 } else { 0 }) | (r.index & 3)];
                body.extend_from_slice(counts);
                body.extend_from_slice(syms);
                seg(&mut out, 0xc4, &body)?;
            }
            _ => return Err(Error::invalid("OJPEG: unknown table record")),
        }
    }
    Ok(out)
}

/// A complete JPEG stream for one block of `width` × `height` with `ncomp` components (1 or 3),
/// luma sampling `hs` × `vs`, from `header` (see [`header`]) and the block's bytes. Component k uses
/// quantisation and Huffman tables k (clamped to the tables present), as libtiff assigns them.
pub fn stream(header: &[u8], block: &[u8], width: u16, height: u16, ncomp: u8, hs: u8, vs: u8, restart: u16) -> Result<Vec<u8>> {
    if !(ncomp == 1 || ncomp == 3) || width == 0 || height == 0 || !(1..=4).contains(&hs) || !(1..=4).contains(&vs) {
        return Err(gw_abi::err!(INVALID, "OJPEG: unsupported layout ({ncomp} components, {width}×{height}, sampling {hs}×{vs})", ncomp, width, height, hs, vs));
    }
    if header.len() < 2 || header[0] != 0xff || header[1] != 0xd8 {
        return Err(Error::invalid("OJPEG: header does not start with SOI"));
    }
    let mut out = Vec::with_capacity(header.len() + block.len() + 64);
    out.extend_from_slice(&header[..2]);
    // Copy the header's segments, patching SOF dimensions; note which tables exist.
    let (mut have_sof, mut nq, mut ndc, mut nac) = (false, 0u8, 0u8, 0u8);
    let mut i = 2;
    while i + 4 <= header.len() {
        let m = header[i + 1];
        let len = u16::from_be_bytes([header[i + 2], header[i + 3]]) as usize;
        let s = header.get(i..i + 2 + len).ok_or_else(|| Error::range("OJPEG: header segment past its end"))?;
        match m {
            0xc0 | 0xc1 => {
                let mut s = s.to_vec();
                if s.len() >= 9 {
                    s[5..7].copy_from_slice(&height.to_be_bytes());
                    s[7..9].copy_from_slice(&width.to_be_bytes());
                }
                out.extend(s);
                have_sof = true;
            }
            0xdb => {
                let mut p = 4;
                while p < s.len() {
                    nq = nq.max((s[p] & 3) + 1);
                    p += 1 + if s[p] >> 4 == 0 { 64 } else { 128 };
                }
                out.extend_from_slice(s);
            }
            0xc4 => {
                let mut p = 4;
                while p + 17 <= s.len() {
                    let (class, id) = (s[p] >> 4, s[p] & 3);
                    if class == 0 {
                        ndc = ndc.max(id + 1);
                    } else {
                        nac = nac.max(id + 1);
                    }
                    p += 17 + s[p + 1..p + 17].iter().map(|&c| c as usize).sum::<usize>();
                }
                out.extend_from_slice(s);
            }
            _ => out.extend_from_slice(s),
        }
        i += 2 + len;
    }
    if !have_sof {
        let mut sof = vec![8];
        sof.extend_from_slice(&height.to_be_bytes());
        sof.extend_from_slice(&width.to_be_bytes());
        sof.push(ncomp);
        for k in 0..ncomp {
            let samp = if k == 0 { (hs << 4) | vs } else { 0x11 };
            sof.extend_from_slice(&[k + 1, samp, k.min(nq.max(1) - 1)]);
        }
        seg(&mut out, 0xc0, &sof)?;
    }
    if restart > 0 {
        seg(&mut out, 0xdd, &restart.to_be_bytes())?;
    }
    let has_sos = block.len() >= 4 && block[0] == 0xff && block[1] == 0xda;
    if !has_sos {
        let mut sos = vec![ncomp];
        for k in 0..ncomp {
            let d = k.min(ndc.max(1) - 1);
            let a = k.min(nac.max(1) - 1);
            sos.extend_from_slice(&[k + 1, (d << 4) | a]);
        }
        sos.extend_from_slice(&[0, 63, 0]);
        seg(&mut out, 0xda, &sos)?;
    }
    out.extend_from_slice(block);
    if !(out.len() >= 2 && out[out.len() - 2] == 0xff && out[out.len() - 1] == 0xd9) {
        out.extend_from_slice(&[0xff, 0xd9]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_to_stream() {
        let q = [1u8; 64];
        let mut dc = vec![0u8; 16];
        dc[0] = 1;
        dc.push(0);
        let mut ac = vec![0u8; 16];
        ac[1] = 1;
        ac.push(0);
        let h = header(&[Record { kind: 0, index: 0, bytes: &q }, Record { kind: 1, index: 0, bytes: &dc }, Record { kind: 2, index: 0, bytes: &ac }]).unwrap();
        let s = stream(&h, &[0x12, 0x34], 16, 8, 1, 1, 1, 0).unwrap();
        assert_eq!(&s[..2], &[0xff, 0xd8]);
        assert!(s.windows(2).any(|w| w == [0xff, 0xc0]) && s.windows(2).any(|w| w == [0xff, 0xda]));
        assert_eq!(&s[s.len() - 2..], &[0xff, 0xd9]);
    }

    #[test]
    fn interchange_sof_is_resized() {
        let mut jif = vec![0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 2, 63, 1, 136, 1, 1, 0x11, 0];
        jif.extend_from_slice(&[0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
        let h = header(&[Record { kind: 3, index: 0, bytes: &jif }]).unwrap();
        let s = stream(&h, &[0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 5], 392, 24, 1, 1, 1, 0).unwrap();
        let at = s.windows(2).position(|w| w == [0xff, 0xc0]).unwrap();
        assert_eq!(u16::from_be_bytes([s[at + 5], s[at + 6]]), 24);
        assert_eq!(s.windows(2).filter(|w| *w == [0xff, 0xda]).count(), 1);
    }

    #[test]
    fn bad_tables_are_errors() {
        assert!(header(&[Record { kind: 0, index: 0, bytes: &[1, 2] }]).is_err());
        assert!(header(&[Record { kind: 1, index: 0, bytes: &[0; 16] }]).is_err());
        assert!(header(&[Record { kind: 3, index: 0, bytes: &[0, 1, 2] }]).is_err());
        assert!(stream(&[0xff, 0xd8], &[], 0, 8, 1, 1, 1, 0).is_err());
    }
}

/// Size in bytes of a TIFF field type (0 for an invalid type).
pub fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 | 16 | 17 | 18 => 8,
        _ => 0,
    }
}

/// One classic-TIFF IFD entry: tag, type, count and the 4 value/offset bytes as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub tag: u16,
    pub typ: u16,
    pub count: u32,
    pub raw: [u8; 4],
}

/// The entries of a classic-TIFF IFD (`ifd` starts at its entry count). libtiff reads the old-style
/// JPEG tags even where other readers fail on the directory (unsorted tags, entries of type 0).
pub fn ifd_entries(ifd: &[u8], le: bool) -> Result<Vec<Entry>> {
    let rd16 = |b: &[u8]| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) };
    let n = rd16(ifd.get(..2).ok_or_else(|| Error::range("TIFF: IFD past the end"))?) as usize;
    if n == 0 || n > 4096 {
        return Err(Error::invalid(format!("TIFF: IFD with {n} entries")));
    }
    let body = ifd.get(2..2 + 12 * n).ok_or_else(|| Error::range("TIFF: IFD entries past the end"))?;
    Ok(body
        .chunks_exact(12)
        .map(|e| Entry {
            tag: rd16(&e[0..2]),
            typ: rd16(&e[2..4]),
            count: if le { u32::from_le_bytes([e[4], e[5], e[6], e[7]]) } else { u32::from_be_bytes([e[4], e[5], e[6], e[7]]) },
            raw: [e[8], e[9], e[10], e[11]],
        })
        .collect())
}

/// The same IFD with entries of an invalid field type made harmless (BYTE, count 0), so a strict
/// reader opens a directory libtiff tolerates; None when nothing needed repair.
pub fn ifd_repair(ifd: &[u8], le: bool) -> Result<Option<Vec<u8>>> {
    let entries = ifd_entries(ifd, le)?;
    let mut out = ifd.to_vec();
    let mut changed = false;
    for (k, e) in entries.iter().enumerate() {
        if type_size(e.typ) == 0 {
            let at = 2 + 12 * k;
            let one: [u8; 2] = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            out[at + 2..at + 4].copy_from_slice(&one);
            out[at + 4..at + 12].fill(0);
            changed = true;
        }
    }
    Ok(changed.then_some(out))
}

#[cfg(test)]
mod ifd_tests {
    use super::*;

    #[test]
    fn repair_invalid_types() {
        let mut ifd = vec![0, 2];
        ifd.extend_from_slice(&[1, 0, 0, 3, 0, 0, 0, 1, 0, 234, 0, 0]);
        ifd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let e = ifd_entries(&ifd, false).unwrap();
        assert_eq!((e[0].tag, e[0].typ, e[0].count), (256, 3, 1));
        let r = ifd_repair(&ifd, false).unwrap().unwrap();
        assert_eq!(&r[2 + 12 + 2..2 + 12 + 4], &[0, 1]);
        assert!(ifd_repair(&ifd[..14], false).is_err() || ifd_repair(&r, false).unwrap().is_none());
        assert!(ifd_entries(&[0, 9], false).is_err());
    }
}
