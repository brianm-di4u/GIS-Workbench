//! PMTiles v3 archives (FC-06/07, REQ-FMT-31): the writer (Hilbert tile ids, content dedup,
//! run-length entries, clustered tile data, root/leaf directories, gzip directories and
//! metadata) and a bounds-checked directory/header reader used by the tests and fuzz targets.
//! Specification: <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>.

use crate::gz;
use gw_abi::{Error, Result};
use std::collections::HashMap;

pub const HEADER_LEN: usize = 127;
/// The first 16 KiB a client reads must hold the header and the root directory.
pub const ROOT_LIMIT: usize = 16384 - HEADER_LEN;

pub const COMP_UNKNOWN: u8 = 0;
pub const COMP_NONE: u8 = 1;
pub const COMP_GZIP: u8 = 2;
pub const COMP_BROTLI: u8 = 3;
pub const COMP_ZSTD: u8 = 4;

pub const TYPE_MVT: u8 = 1;

/// Tile id of (z, x, y) on the Hilbert curve of each zoom, offset by the tiles of lower zooms.
pub fn zxy_to_id(z: u8, x: u32, y: u32) -> Result<u64> {
    if z > 31 {
        return Err(Error::range("zoom above 31"));
    }
    let n = 1u64 << z;
    if x as u64 >= n || y as u64 >= n {
        return Err(Error::range("tile x/y outside its zoom level"));
    }
    let base = ((1u64 << (2 * z as u32)) - 1) / 3; // sum of 4^i, i < z
    let mut d = 0u64;
    let (mut x, mut y) = (x as u64, y as u64);
    let mut s = n / 2;
    while s > 0 {
        let rx = u64::from(x & s > 0);
        let ry = u64::from(y & s > 0);
        d += s * s * ((3 * rx) ^ ry);
        if ry == 0 {
            if rx == 1 {
                x = n - 1 - x;
                y = n - 1 - y;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s /= 2;
    }
    Ok(base + d)
}

/// Inverse of [`zxy_to_id`].
pub fn id_to_zxy(id: u64) -> Result<(u8, u32, u32)> {
    let mut acc = 0u64;
    for z in 0..32u8 {
        let count = 1u64 << (2 * z as u32);
        if id < acc + count {
            let n = 1u64 << z;
            let mut t = id - acc;
            let (mut x, mut y) = (0u64, 0u64);
            let mut s = 1u64;
            while s < n {
                let rx = 1 & (t / 2);
                let ry = 1 & (t ^ rx);
                if ry == 0 {
                    if rx == 1 {
                        x = s - 1 - x;
                        y = s - 1 - y;
                    }
                    std::mem::swap(&mut x, &mut y);
                }
                x += s * rx;
                y += s * ry;
                t /= 4;
                s *= 2;
            }
            return Ok((z, x as u32, y as u32));
        }
        acc += count;
    }
    Err(Error::range("tile id beyond zoom 31"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub tile_id: u64,
    pub offset: u64,
    pub length: u32,
    pub run_length: u32,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(b: &[u8], p: &mut usize) -> Result<u64> {
    let mut v = 0u64;
    for i in 0..10 {
        let c = *b.get(*p).ok_or_else(|| Error::invalid("PMTiles directory cut short"))?;
        *p += 1;
        if i == 9 && c > 1 {
            return Err(Error::invalid("PMTiles varint overflows 64 bits"));
        }
        v |= u64::from(c & 0x7f) << (7 * i);
        if c < 0x80 {
            return Ok(v);
        }
    }
    Err(Error::invalid("PMTiles varint longer than 10 bytes"))
}

/// Serialise directory entries (uncompressed).
pub fn serialize_directory(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::with_capacity(entries.len() * 6 + 4);
    put_varint(&mut out, entries.len() as u64);
    let mut last = 0u64;
    for e in entries {
        put_varint(&mut out, e.tile_id - last);
        last = e.tile_id;
    }
    for e in entries {
        put_varint(&mut out, e.run_length as u64);
    }
    for e in entries {
        put_varint(&mut out, e.length as u64);
    }
    for (i, e) in entries.iter().enumerate() {
        if i > 0 && Some(e.offset) == entries[i - 1].offset.checked_add(entries[i - 1].length as u64) {
            put_varint(&mut out, 0);
        } else {
            put_varint(&mut out, e.offset.saturating_add(1));
        }
    }
    out
}

/// Parse an uncompressed directory (bounds-checked; at most `max_entries`).
pub fn parse_directory(b: &[u8], max_entries: usize) -> Result<Vec<Entry>> {
    let mut p = 0usize;
    let n = get_varint(b, &mut p)? as usize;
    if n > max_entries || n > b.len() {
        return Err(Error::limit("PMTiles directory claims more entries than it can hold"));
    }
    let mut es = vec![Entry { tile_id: 0, offset: 0, length: 0, run_length: 0 }; n];
    let mut last = 0u64;
    for e in es.iter_mut() {
        last = last.checked_add(get_varint(b, &mut p)?).ok_or_else(|| Error::invalid("PMTiles tile id overflows"))?;
        e.tile_id = last;
    }
    for e in es.iter_mut() {
        e.run_length = u32::try_from(get_varint(b, &mut p)?).map_err(|_| Error::invalid("PMTiles run length too large"))?;
    }
    for e in es.iter_mut() {
        e.length = u32::try_from(get_varint(b, &mut p)?).map_err(|_| Error::invalid("PMTiles length too large"))?;
    }
    for i in 0..n {
        let v = get_varint(b, &mut p)?;
        es[i].offset = if v == 0 {
            if i == 0 {
                return Err(Error::invalid("PMTiles first directory entry has no offset"));
            }
            es[i - 1].offset.checked_add(es[i - 1].length as u64).ok_or_else(|| Error::invalid("PMTiles offset overflows"))?
        } else {
            v - 1
        };
    }
    Ok(es)
}

/// The fixed header fields.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Header {
    pub root_offset: u64,
    pub root_length: u64,
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub leaf_offset: u64,
    pub leaf_length: u64,
    pub data_offset: u64,
    pub data_length: u64,
    pub addressed_tiles: u64,
    pub tile_entries: u64,
    pub tile_contents: u64,
    pub clustered: bool,
    pub internal_compression: u8,
    pub tile_compression: u8,
    pub tile_type: u8,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// min lon, min lat, max lon, max lat (degrees).
    pub bounds: [f64; 4],
    pub center_zoom: u8,
    pub center: [f64; 2],
}

fn u64_at(b: &[u8], o: usize) -> u64 {
    let mut a = [0u8; 8];
    a.copy_from_slice(&b[o..o + 8]);
    u64::from_le_bytes(a)
}
fn i32_at(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

pub fn parse_header(b: &[u8]) -> Result<Header> {
    if b.len() < HEADER_LEN || &b[0..7] != b"PMTiles" {
        return Err(Error::invalid("not a PMTiles archive"));
    }
    if b[7] != 3 {
        return Err(gw_abi::err!(UNSUPPORTED, "PMTiles spec version {version} (3 is read)", version = b[7]));
    }
    let e7 = |o| i32_at(b, o) as f64 / 1e7;
    Ok(Header {
        root_offset: u64_at(b, 8),
        root_length: u64_at(b, 16),
        metadata_offset: u64_at(b, 24),
        metadata_length: u64_at(b, 32),
        leaf_offset: u64_at(b, 40),
        leaf_length: u64_at(b, 48),
        data_offset: u64_at(b, 56),
        data_length: u64_at(b, 64),
        addressed_tiles: u64_at(b, 72),
        tile_entries: u64_at(b, 80),
        tile_contents: u64_at(b, 88),
        clustered: b[96] == 1,
        internal_compression: b[97],
        tile_compression: b[98],
        tile_type: b[99],
        min_zoom: b[100],
        max_zoom: b[101],
        bounds: [e7(102), e7(106), e7(110), e7(114)],
        center_zoom: b[118],
        center: [e7(119), e7(123)],
    })
}

fn write_header(h: &Header) -> Vec<u8> {
    let mut b = Vec::with_capacity(HEADER_LEN);
    b.extend_from_slice(b"PMTiles");
    b.push(3);
    for v in [h.root_offset, h.root_length, h.metadata_offset, h.metadata_length, h.leaf_offset, h.leaf_length, h.data_offset, h.data_length, h.addressed_tiles, h.tile_entries, h.tile_contents] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&[u8::from(h.clustered), h.internal_compression, h.tile_compression, h.tile_type, h.min_zoom, h.max_zoom]);
    let e7 = |v: f64| ((v * 1e7).round().clamp(i32::MIN as f64, i32::MAX as f64) as i32).to_le_bytes();
    for v in h.bounds {
        b.extend_from_slice(&e7(v));
    }
    b.push(h.center_zoom);
    b.extend_from_slice(&e7(h.center[0]));
    b.extend_from_slice(&e7(h.center[1]));
    debug_assert_eq!(b.len(), HEADER_LEN);
    b
}

fn decompress(b: &[u8], comp: u8, max: usize) -> Result<Vec<u8>> {
    match comp {
        COMP_NONE => Ok(b.to_vec()),
        COMP_GZIP => gz::gunzip(b, max),
        #[cfg(feature = "brotli")]
        COMP_BROTLI => crate::brotli::decompress(b, max),
        COMP_UNKNOWN => Err(Error::unsupported("PMTiles internal compression is 'unknown'")),
        _ => Err(Error::unsupported("PMTiles compression not decoded here (Zstandard is decoded in JavaScript)")),
    }
}

/// Read a directory from an archive held whole in memory.
pub fn read_directory(archive: &[u8], h: &Header, offset: u64, length: u64) -> Result<Vec<Entry>> {
    let a = usize::try_from(offset).map_err(|_| Error::range("directory offset"))?;
    let n = usize::try_from(length).map_err(|_| Error::range("directory length"))?;
    let end = a.checked_add(n).filter(|&e| e <= archive.len()).ok_or_else(|| Error::range("PMTiles directory lies past the end of the file"))?;
    let raw = decompress(&archive[a..end], h.internal_compression, 64 << 20)?;
    parse_directory(&raw, 1 << 22)
}

/// Find a tile's bytes in an archive held whole in memory (uncompressed by tile compression is
/// left to the caller). Returns `None` when the tile is absent.
pub fn get_tile<'a>(archive: &'a [u8], h: &Header, z: u8, x: u32, y: u32) -> Result<Option<&'a [u8]>> {
    let id = zxy_to_id(z, x, y)?;
    let (mut off, mut len) = (h.root_offset, h.root_length);
    for depth in 0..4 {
        let dir = read_directory(archive, h, off, len)?;
        let i = match dir.binary_search_by(|e| e.tile_id.cmp(&id)) {
            Ok(i) => i,
            Err(0) => return Ok(None),
            Err(i) => i - 1,
        };
        let e = dir[i];
        if e.run_length == 0 {
            if depth == 3 {
                break;
            }
            off = h.leaf_offset.checked_add(e.offset).ok_or_else(|| Error::range("leaf offset"))?;
            len = e.length as u64;
            continue;
        }
        if id >= e.tile_id.saturating_add(e.run_length as u64) {
            return Ok(None);
        }
        let a = usize::try_from(h.data_offset.checked_add(e.offset).ok_or_else(|| Error::range("tile offset"))?).map_err(|_| Error::range("tile offset"))?;
        let end = a.checked_add(e.length as usize).filter(|&x| x <= archive.len()).ok_or_else(|| Error::range("PMTiles tile lies past the end of the file"))?;
        return Ok(Some(&archive[a..end]));
    }
    Err(Error::invalid("PMTiles directories nest deeper than 3 leaves"))
}

/// Verify an archive the way `pmtiles verify` does: header, directories, entry order, run
/// lengths, offsets inside the data section, counts; returns (addressed tiles, entries, contents).
pub fn verify(archive: &[u8]) -> Result<(u64, u64, u64)> {
    let h = parse_header(archive)?;
    if h.root_offset.saturating_add(h.root_length) > 16384 {
        return Err(Error::invalid("the root directory does not fit in the first 16 KiB"));
    }
    let root = read_directory(archive, &h, h.root_offset, h.root_length)?;
    let mut tiles: Vec<Entry> = Vec::new();
    for e in &root {
        if e.run_length == 0 {
            let leaf = read_directory(archive, &h, h.leaf_offset.saturating_add(e.offset), e.length as u64)?;
            if leaf.iter().any(|l| l.run_length == 0) {
                return Err(Error::unsupported("nested leaf directories are not verified"));
            }
            tiles.extend(leaf);
        } else {
            tiles.push(*e);
        }
    }
    let mut addressed = 0u64;
    let mut offsets = std::collections::HashSet::new();
    for (i, e) in tiles.iter().enumerate() {
        if i > 0 && e.tile_id < tiles[i - 1].tile_id.saturating_add(tiles[i - 1].run_length as u64) {
            return Err(Error::invalid("tile entries overlap or are out of order"));
        }
        if e.offset.saturating_add(e.length as u64) > h.data_length {
            return Err(Error::invalid("a tile entry points past the tile data section"));
        }
        if e.length == 0 {
            return Err(Error::invalid("a tile entry has length 0"));
        }
        addressed = addressed.saturating_add(e.run_length as u64);
        offsets.insert(e.offset);
    }
    let counts = (addressed, tiles.len() as u64, offsets.len() as u64);
    if h.addressed_tiles != 0 && (h.addressed_tiles, h.tile_entries, h.tile_contents) != counts {
        return Err(Error::invalid(format!("header counts {}/{}/{} differ from the directories {}/{}/{}", h.addressed_tiles, h.tile_entries, h.tile_contents, counts.0, counts.1, counts.2)));
    }
    Ok(counts)
}

/// Options of a written archive.
#[derive(Clone, Debug)]
pub struct WriteOptions {
    pub tile_type: u8,
    /// Compression of the tile bytes as given (they are stored as they are), or `COMP_GZIP` with
    /// `gzip_tiles` to compress them here.
    pub tile_compression: u8,
    pub gzip_tiles: bool,
    pub bounds: [f64; 4],
    pub center: Option<[f64; 2]>,
    pub center_zoom: Option<u8>,
    pub metadata_json: Vec<u8>,
}

fn build_dirs(entries: &[Entry], leaf_size: usize) -> (Vec<u8>, Vec<u8>) {
    if entries.len() <= leaf_size {
        return (gz::gzip(&serialize_directory(entries), 9), Vec::new());
    }
    let mut leaves = Vec::new();
    let mut root = Vec::new();
    for chunk in entries.chunks(leaf_size) {
        let z = gz::gzip(&serialize_directory(chunk), 9);
        root.push(Entry { tile_id: chunk[0].tile_id, offset: leaves.len() as u64, length: z.len() as u32, run_length: 0 });
        leaves.extend_from_slice(&z);
    }
    (gz::gzip(&serialize_directory(&root), 9), leaves)
}

/// Write an archive from `(z, x, y, bytes)` tiles (any order, duplicates by position refused).
/// Identical contents are stored once; consecutive ids with the same content become one run.
pub fn write(tiles: &[(u8, u32, u32, &[u8])], o: &WriteOptions) -> Result<Vec<u8>> {
    if tiles.is_empty() {
        return Err(Error::invalid("no tiles to write"));
    }
    let mut ids: Vec<(u64, usize)> = Vec::with_capacity(tiles.len());
    let (mut minz, mut maxz) = (u8::MAX, 0u8);
    for (i, t) in tiles.iter().enumerate() {
        ids.push((zxy_to_id(t.0, t.1, t.2)?, i));
        minz = minz.min(t.0);
        maxz = maxz.max(t.0);
    }
    ids.sort_unstable();
    if ids.windows(2).any(|w| w[0].0 == w[1].0) {
        return Err(Error::invalid("two tiles at the same z/x/y"));
    }
    let mut data = Vec::new();
    let mut seen: HashMap<Vec<u8>, (u64, u32)> = HashMap::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (id, i) in ids {
        let raw = tiles[i].3;
        if raw.is_empty() {
            continue;
        }
        let body = if o.gzip_tiles { gz::gzip(raw, 6) } else { raw.to_vec() };
        let (off, len) = match seen.get(&body) {
            Some(&v) => v,
            None => {
                let v = (data.len() as u64, u32::try_from(body.len()).map_err(|_| Error::limit("a tile above 4 GiB"))?);
                data.extend_from_slice(&body);
                seen.insert(body, v);
                v
            }
        };
        if let Some(last) = entries.last_mut() {
            if last.offset == off && last.tile_id + last.run_length as u64 == id && last.run_length < u32::MAX {
                last.run_length += 1;
                continue;
            }
        }
        entries.push(Entry { tile_id: id, offset: off, length: len, run_length: 1 });
    }
    if entries.is_empty() {
        return Err(Error::invalid("every tile is empty"));
    }
    let addressed: u64 = entries.iter().map(|e| e.run_length as u64).sum();
    let mut leaf_size = 4096usize;
    let (root, leaves) = loop {
        let (r, l) = build_dirs(&entries, leaf_size);
        if r.len() <= ROOT_LIMIT {
            break (r, l);
        }
        leaf_size *= 2;
    };
    let meta = gz::gzip(&o.metadata_json, 9);
    let [w, s, e, n] = o.bounds;
    let mut h = Header {
        root_offset: HEADER_LEN as u64,
        root_length: root.len() as u64,
        addressed_tiles: addressed,
        tile_entries: entries.len() as u64,
        tile_contents: seen.len() as u64,
        clustered: true,
        internal_compression: COMP_GZIP,
        tile_compression: if o.gzip_tiles { COMP_GZIP } else { o.tile_compression },
        tile_type: o.tile_type,
        min_zoom: minz,
        max_zoom: maxz,
        bounds: o.bounds,
        center_zoom: o.center_zoom.unwrap_or(minz),
        center: o.center.unwrap_or([(w + e) / 2.0, (s + n) / 2.0]),
        ..Default::default()
    };
    h.metadata_offset = h.root_offset + h.root_length;
    h.metadata_length = meta.len() as u64;
    h.leaf_offset = h.metadata_offset + h.metadata_length;
    h.leaf_length = leaves.len() as u64;
    h.data_offset = h.leaf_offset + h.leaf_length;
    h.data_length = data.len() as u64;
    let mut out = write_header(&h);
    out.reserve(root.len() + meta.len() + leaves.len() + data.len());
    out.extend_from_slice(&root);
    out.extend_from_slice(&meta);
    out.extend_from_slice(&leaves);
    out.extend_from_slice(&data);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tile_ids_match_the_spec() {
        // Spec examples: 0/0/0 → 0; 1/0/0 → 1; 1/0/1 → 2; 1/1/1 → 3; 1/1/0 → 4; 2/0/0 → 5.
        assert_eq!(zxy_to_id(0, 0, 0).unwrap(), 0);
        assert_eq!(zxy_to_id(1, 0, 0).unwrap(), 1);
        assert_eq!(zxy_to_id(1, 0, 1).unwrap(), 2);
        assert_eq!(zxy_to_id(1, 1, 1).unwrap(), 3);
        assert_eq!(zxy_to_id(1, 1, 0).unwrap(), 4);
        assert_eq!(zxy_to_id(2, 0, 0).unwrap(), 5);
        assert_eq!(zxy_to_id(12, 3423, 1763).unwrap(), 19078479);
        for z in 0..9u8 {
            let n = 1u32 << z;
            for x in (0..n).step_by(((n / 7).max(1)) as usize) {
                for y in (0..n).step_by(((n / 5).max(1)) as usize) {
                    let id = zxy_to_id(z, x, y).unwrap();
                    assert_eq!(id_to_zxy(id).unwrap(), (z, x, y));
                }
            }
        }
        assert!(zxy_to_id(1, 2, 0).is_err());
    }

    #[test]
    fn directory_round_trip() {
        let es = vec![
            Entry { tile_id: 0, offset: 0, length: 10, run_length: 1 },
            Entry { tile_id: 1, offset: 10, length: 5, run_length: 3 },
            Entry { tile_id: 9, offset: 0, length: 10, run_length: 1 },
        ];
        let b = serialize_directory(&es);
        assert_eq!(parse_directory(&b, 100).unwrap(), es);
        for n in 0..b.len() {
            let _ = parse_directory(&b[..n], 100);
        }
        assert!(parse_directory(&b, 2).is_err());
    }

    #[test]
    fn write_dedups_runs_and_verifies() {
        let a = b"tile-a".to_vec();
        let b = b"tile-b".to_vec();
        let mut tiles: Vec<(u8, u32, u32, &[u8])> = vec![(0, 0, 0, &a)];
        // All of zoom 1 the same content: ids 1..4 → one run of 4.
        for (x, y) in [(0, 0), (0, 1), (1, 1), (1, 0)] {
            tiles.push((1, x, y, &b));
        }
        let o = WriteOptions { tile_type: 2, tile_compression: COMP_NONE, gzip_tiles: false, bounds: [-180.0, -85.0, 180.0, 85.0], center: None, center_zoom: None, metadata_json: b"{\"name\":\"t\"}".to_vec() };
        let arch = write(&tiles, &o).unwrap();
        let h = parse_header(&arch).unwrap();
        assert_eq!((h.min_zoom, h.max_zoom, h.clustered), (0, 1, true));
        assert_eq!(verify(&arch).unwrap(), (5, 2, 2));
        assert_eq!(get_tile(&arch, &h, 1, 1, 0).unwrap().unwrap(), b"tile-b");
        assert_eq!(get_tile(&arch, &h, 0, 0, 0).unwrap().unwrap(), b"tile-a");
        assert!(get_tile(&arch, &h, 2, 0, 0).unwrap().is_none());
        let meta = gz::gunzip(&arch[h.metadata_offset as usize..(h.metadata_offset + h.metadata_length) as usize], 1000).unwrap();
        assert_eq!(meta, b"{\"name\":\"t\"}");
    }

    #[test]
    fn leaf_directories_when_the_root_is_full() {
        // 120,000 distinct tiles at zoom 9 → the root cannot hold them in 16 KiB.
        let bodies: Vec<Vec<u8>> = (0..120_000u32).map(|i| i.to_le_bytes().to_vec()).collect();
        let mut tiles: Vec<(u8, u32, u32, &[u8])> = Vec::new();
        let mut k = 0;
        'o: for x in 0..512u32 {
            for y in 0..512u32 {
                if k == bodies.len() {
                    break 'o;
                }
                tiles.push((9, x, y, &bodies[k]));
                k += 1;
            }
        }
        let o = WriteOptions { tile_type: 2, tile_compression: COMP_NONE, gzip_tiles: false, bounds: [-180.0, -85.0, 180.0, 85.0], center: None, center_zoom: None, metadata_json: b"{}".to_vec() };
        let arch = write(&tiles, &o).unwrap();
        let h = parse_header(&arch).unwrap();
        assert!(h.leaf_length > 0);
        assert!(h.root_length as usize <= ROOT_LIMIT);
        assert_eq!(verify(&arch).unwrap().0, 120_000);
        let (z, x, y, b) = tiles[77_777];
        assert_eq!(get_tile(&arch, &h, z, x, y).unwrap().unwrap(), b);
    }
}
