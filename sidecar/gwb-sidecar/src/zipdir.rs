//! A folder as one ZIP file (stored, not deflated): a job's output that a tool leaves as a tree,
//! such as an RPF product or a FileGDB. ZIP64 records are written when the sizes need them, so a
//! product past 4 GB stays readable. Only regular files are taken; links are refused.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;

const MAX4: u64 = 0xFFFF_FFFF;

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, e) in t.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *e = c;
    }
    t
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    let mut rd: Vec<_> = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().collect();
    rd.sort_by_key(|e| e.file_name());
    for e in rd {
        let t = e.file_type().map_err(|err| err.to_string())?;
        let p = e.path();
        if t.is_symlink() {
            return Err(format!("{} is a link", p.display()));
        }
        if t.is_dir() {
            walk(base, &p, out)?;
        } else {
            let rel: Vec<String> = p.strip_prefix(base).map_err(|err| err.to_string())?.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            out.push((rel.join("/"), p));
        }
    }
    Ok(())
}

fn put(w: &mut impl Write, b: &[u8]) -> Result<(), String> {
    w.write_all(b).map_err(|e| e.to_string())
}

/// Write `src` (its contents, under the folder's own name) to `out`.
pub fn zip_dir(src: &Path, out: &Path, cancel: &CancellationToken) -> Result<(), String> {
    let table = crc_table();
    let root = src.file_name().map(|s| s.to_string_lossy().into_owned()).ok_or("the folder has no name")?;
    let mut files = Vec::new();
    walk(src, src, &mut files)?;
    if files.is_empty() {
        return Err(format!("{root} is empty"));
    }
    let mut w = BufWriter::with_capacity(1 << 20, File::create(out).map_err(|e| e.to_string())?);
    let mut pos = 0u64;
    let mut central = Vec::new();
    let mut buf = vec![0u8; 1 << 20];
    for (rel, path) in &files {
        if cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let name = format!("{root}/{rel}");
        let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        let big = size >= MAX4 || pos >= MAX4;
        // Local header: CRC and sizes follow in a data descriptor, so nothing is read twice.
        let version: u16 = if big { 45 } else { 20 };
        let mut h = Vec::with_capacity(64 + name.len());
        h.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        h.extend_from_slice(&version.to_le_bytes());
        h.extend_from_slice(&0x0808u16.to_le_bytes()); // data descriptor, UTF-8 names
        h.extend_from_slice(&[0u8; 2]); // stored
        h.extend_from_slice(&[0u8; 4]); // no time or date: the same files give the same archive
        h.extend_from_slice(&[0u8; 12]); // CRC and sizes: in the descriptor
        h.extend_from_slice(&(name.len() as u16).to_le_bytes());
        h.extend_from_slice(&[0u8; 2]);
        h.extend_from_slice(name.as_bytes());
        put(&mut w, &h)?;
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        let mut crc = 0xFFFF_FFFFu32;
        let mut n = 0u64;
        loop {
            let k = f.read(&mut buf).map_err(|e| e.to_string())?;
            if k == 0 {
                break;
            }
            for b in &buf[..k] {
                crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
            }
            put(&mut w, &buf[..k])?;
            n += k as u64;
        }
        if n != size {
            return Err(format!("{name} changed while it was packed"));
        }
        let crc = !crc;
        put(&mut w, &0x0807_4b50u32.to_le_bytes())?;
        put(&mut w, &crc.to_le_bytes())?;
        if big {
            put(&mut w, &n.to_le_bytes())?;
            put(&mut w, &n.to_le_bytes())?;
        } else {
            put(&mut w, &(n as u32).to_le_bytes())?;
            put(&mut w, &(n as u32).to_le_bytes())?;
        }
        let len = h.len() as u64 + n + if big { 24 } else { 16 };
        // Central directory record.
        let mut ex = Vec::new();
        if big {
            ex.extend_from_slice(&1u16.to_le_bytes());
            ex.extend_from_slice(&24u16.to_le_bytes());
            ex.extend_from_slice(&n.to_le_bytes());
            ex.extend_from_slice(&n.to_le_bytes());
            ex.extend_from_slice(&pos.to_le_bytes());
        }
        let s32 = if big { u32::MAX } else { n as u32 };
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&version.to_le_bytes());
        central.extend_from_slice(&version.to_le_bytes());
        central.extend_from_slice(&0x0808u16.to_le_bytes());
        central.extend_from_slice(&[0u8; 6]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&s32.to_le_bytes());
        central.extend_from_slice(&s32.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&(ex.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0u8; 10]);
        central.extend_from_slice(&(if big { u32::MAX } else { pos as u32 }).to_le_bytes());
        central.extend_from_slice(name.as_bytes());
        central.extend_from_slice(&ex);
        pos += len;
    }
    put(&mut w, &central)?;
    let cd = central.len() as u64;
    let count = files.len() as u64;
    let z64 = pos >= MAX4 || cd >= MAX4 || count >= 0xFFFF;
    if z64 {
        put(&mut w, &0x0606_4b50u32.to_le_bytes())?;
        put(&mut w, &44u64.to_le_bytes())?;
        put(&mut w, &45u16.to_le_bytes())?;
        put(&mut w, &45u16.to_le_bytes())?;
        put(&mut w, &[0u8; 8])?;
        put(&mut w, &count.to_le_bytes())?;
        put(&mut w, &count.to_le_bytes())?;
        put(&mut w, &cd.to_le_bytes())?;
        put(&mut w, &pos.to_le_bytes())?;
        put(&mut w, &0x0706_4b50u32.to_le_bytes())?;
        put(&mut w, &[0u8; 4])?;
        put(&mut w, &(pos + cd).to_le_bytes())?;
        put(&mut w, &1u32.to_le_bytes())?;
    }
    put(&mut w, &0x0605_4b50u32.to_le_bytes())?;
    put(&mut w, &[0u8; 4])?;
    let c16: u16 = if z64 { 0xFFFF } else { count as u16 };
    put(&mut w, &c16.to_le_bytes())?;
    put(&mut w, &c16.to_le_bytes())?;
    put(&mut w, &(if z64 { u32::MAX } else { cd as u32 }).to_le_bytes())?;
    put(&mut w, &(if z64 { u32::MAX } else { pos as u32 }).to_le_bytes())?;
    put(&mut w, &[0u8; 2])?;
    w.flush().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packs_a_tree_that_a_reader_can_walk() {
        let d = std::env::temp_dir().join(format!("gwb-zip-{}", crate::util::random_hex(4)));
        let src = d.join("RPF");
        std::fs::create_dir_all(src.join("zone")).unwrap();
        std::fs::write(src.join("A.TOC"), b"hello").unwrap();
        std::fs::write(src.join("zone").join("f.I22"), vec![7u8; 70_000]).unwrap();
        let out = d.join("x.zip");
        zip_dir(&src, &out, &CancellationToken::new()).unwrap();
        let b = std::fs::read(&out).unwrap();
        // The end record, then the central directory it names.
        let e = b.len() - 22;
        assert_eq!(&b[e..e + 4], &[0x50, 0x4b, 5, 6]);
        assert_eq!(u16::from_le_bytes([b[e + 10], b[e + 11]]), 2);
        let size = u32::from_le_bytes(b[e + 12..e + 16].try_into().unwrap()) as usize;
        let cd = u32::from_le_bytes(b[e + 16..e + 20].try_into().unwrap()) as usize;
        assert_eq!(cd + size, e);
        assert_eq!(&b[cd..cd + 4], &[0x50, 0x4b, 1, 2]);
        // The published CRC-32 of "hello".
        assert_eq!(u32::from_le_bytes(b[cd + 16..cd + 20].try_into().unwrap()), 0x3610_a686);
        let n = u16::from_le_bytes([b[cd + 28], b[cd + 29]]) as usize;
        assert_eq!(&b[cd + 46..cd + 46 + n], b"RPF/A.TOC");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn an_empty_folder_is_refused() {
        let d = std::env::temp_dir().join(format!("gwb-zip-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(d.join("e")).unwrap();
        assert!(zip_dir(&d.join("e"), &d.join("x.zip"), &CancellationToken::new()).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod zip64 {
    use super::*;

    /// Past 4 GB, on a sparse file. Off by default for its 4 GB of output: GWB_ZIP64_DIR names a folder
    /// on a disk with room, and tests/tools/plugindata_oracle.py `unzip` reads the result.
    #[test]
    #[ignore]
    fn a_tree_past_four_gigabytes_needs_zip64() {
        let root = std::path::PathBuf::from(std::env::var("GWB_ZIP64_DIR").unwrap());
        let src = root.join("tree");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        let f = File::create(src.join("big.bin")).unwrap();
        f.set_len((1 << 32) + (1 << 28)).unwrap();
        std::fs::write(src.join("sub").join("after.txt"), b"after the 4 GB mark").unwrap();
        zip_dir(&src, &root.join("big.zip"), &CancellationToken::new()).unwrap();
    }
}
