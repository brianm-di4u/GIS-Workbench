//! LAZ through the `laz` crate (D23, REQ-LDR-01): the chunk table, and decoding a run of whole
//! chunks on its own so that workers can decode a file in parallel; compression for export.

use gw_abi::{Error, Result};
use laz::laszip::ChunkTable;
use laz::{LazItemRecordBuilder, LazVlr};
use std::io::{Cursor, Seek, SeekFrom, Write};

/// Chunk-table entries are 16 bytes each in memory: 2^20 of them is 16 MB.
const MAX_CHUNKS: u64 = 1 << 20;

pub fn vlr(payload: &[u8]) -> Result<LazVlr> {
    LazVlr::from_buffer(payload).map_err(|e| Error::invalid(format!("LAZ: bad laszip VLR ({e})")))
}

/// Chunk table entries (points, bytes) from the table's bytes (which start at the offset that the
/// first 8 bytes of the point data give). Fixed-size tables carry no counts: every chunk gets the
/// VLR's chunk size and the last is trimmed to `n_points`.
pub fn chunk_table(table: &[u8], v: &LazVlr, n_points: u64) -> Result<Vec<(u64, u64)>> {
    let variable = v.uses_variable_size_chunks();
    // TE-059: the laz crate allocates the table from the file's chunk count before decoding it, so a
    // corrupt count aborted the worker (a 67 GB allocation). A chunk holds at least one point.
    let count = table.get(4..8).map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u64);
    let most = if variable { n_points } else { n_points.div_ceil(u64::from(v.chunk_size().max(1))) };
    if count > most.saturating_add(1) || count > MAX_CHUNKS {
        return Err(Error::invalid(format!("LAZ: chunk table claims {count} chunks for {n_points} points")));
    }
    let t = ChunkTable::read(&mut Cursor::new(table), variable).map_err(|e| Error::invalid(format!("LAZ: unreadable chunk table ({e})")))?;
    let mut out: Vec<(u64, u64)> = t.as_ref().iter().map(|e| (if variable { e.point_count } else { u64::from(v.chunk_size()) }, e.byte_count)).collect();
    if !variable {
        let mut left = n_points;
        for e in &mut out {
            e.0 = e.0.min(left);
            left -= e.0;
        }
    }
    Ok(out)
}

/// Decode consecutive whole chunks. `data` holds their bytes; `chunks` their (points, bytes).
/// Returns the uncompressed records.
pub fn decode_chunks(v: &LazVlr, data: &[u8], chunks: &[(u64, u64)]) -> Result<Vec<u8>> {
    let total: u64 = chunks.iter().map(|c| c.1).sum();
    if total as usize != data.len() {
        return Err(Error::invalid(format!("LAZ: chunk bytes {} do not match the table ({total})", data.len())));
    }
    let n: u64 = chunks.iter().map(|c| c.0).sum();
    let rec = v.items_size() as usize;
    // A self-contained stream: offset to the chunk table, the chunks, then a table for just these.
    let mut buf = Cursor::new(Vec::with_capacity(data.len() + 64));
    buf.write_all(&((8 + data.len()) as i64).to_le_bytes()).map_err(io)?;
    buf.write_all(data).map_err(io)?;
    let mut table = ChunkTable::with_capacity(chunks.len());
    for c in chunks {
        table.push(laz::laszip::ChunkTableEntry { point_count: c.0, byte_count: c.1 });
    }
    table.write_to(&mut buf, v).map_err(io)?;
    let mut out = vec![0u8; n as usize * rec];
    laz::decompress_buffer(buf.get_ref(), &mut out, v.clone()).map_err(|e| Error::invalid(format!("LAZ: decompression failed ({e})")))?;
    Ok(out)
}

fn io(e: std::io::Error) -> Error {
    Error::new(5, format!("LAZ: {e}"))
}

/// Compress records of `format` (with `extra` extra bytes) for a file whose point data starts at
/// `start`. Returns (laszip VLR payload, point-data bytes including the chunk-table offset and the
/// table); the offset is absolute, so the bytes must be written at `start`.
pub fn compress(raw: &[u8], format: u8, extra: u16, start: u64) -> Result<(Vec<u8>, Vec<u8>)> {
    let items = LazItemRecordBuilder::default_for_point_format_id(format, extra).map_err(|e| Error::unsupported(format!("LAZ: format {format} ({e})")))?;
    let v = LazVlr::from_laz_items(items);
    let mut payload = Vec::new();
    v.write_to(&mut payload).map_err(io)?;
    let mut cur = Cursor::new(vec![0u8; start as usize]);
    cur.seek(SeekFrom::Start(start)).map_err(io)?;
    laz::compress_buffer(&mut cur, raw, v).map_err(|e| Error::new(5, format!("LAZ: compression failed ({e})")))?;
    let mut all = cur.into_inner();
    let body = all.split_off(start as usize);
    Ok((payload, body))
}

/// TE-022: decode a LAZ point stream sequentially when it has no chunk table (streamed writers
/// leave the offset at −1). Works for fixed-size chunks, where each chunk's point count is the
/// VLR's chunk size; variable-size chunks need the table and are refused by the caller.
/// `data` starts at the point data (with its 8-byte table offset). Returns the records.
pub fn decode_stream(v: &LazVlr, data: &[u8], n_points: u64) -> Result<Vec<u8>> {
    if v.uses_variable_size_chunks() {
        return Err(Error::invalid("LAZ: variable-size chunks without a chunk table cannot be decoded"));
    }
    let rec = v.items_size() as usize;
    let n = usize::try_from(n_points).map_err(|_| Error::limit("LAZ: too many points"))?;
    if n.checked_mul(rec).map_or(true, |b| b > 1 << 30) {
        return Err(Error::limit("LAZ: the decoded points would exceed 1 GiB"));
    }
    let mut d = laz::LasZipDecompressor::new(Cursor::new(data), v.clone()).map_err(|e| Error::invalid(format!("LAZ: {e}")))?;
    let mut out = vec![0u8; n * rec];
    d.decompress_many(&mut out).map_err(|e| Error::invalid(format!("LAZ: decompression failed ({e})")))?;
    Ok(out)
}

/// LAZ fixed-size chunks (the default 50 000 points) compressed one by one: `raw` holds whole
/// records; returns the concatenated chunk bytes and (points, bytes) per chunk. Each chunk is coded
/// independently in LAZ, so this gives exactly the bytes `compress` writes for those points, and a
/// large cloud can be compressed slab by slab within the worker's memory (TE 2.0.4).
pub fn compress_chunks(raw: &[u8], format: u8, extra: u16) -> Result<(Vec<u8>, Vec<(u64, u64)>)> {
    let items = LazItemRecordBuilder::default_for_point_format_id(format, extra).map_err(|e| Error::unsupported(format!("LAZ: format {format} ({e})")))?;
    let v = LazVlr::from_laz_items(items);
    let rec = v.items_size() as usize;
    let per = v.chunk_size() as usize;
    let mut out = Vec::new();
    let mut entries = Vec::new();
    for chunk in raw.chunks(rec * per) {
        let mut c = laz::LasZipCompressor::new(Cursor::new(Vec::new()), v.clone()).map_err(|e| Error::new(5, format!("LAZ: {e}")))?;
        c.compress_many(chunk).map_err(io)?;
        c.done().map_err(io)?;
        let buf = c.into_inner().into_inner();
        // [i64 offset of the chunk table][chunk][one-entry table]: the offset ends the chunk.
        let end = i64::from_le_bytes(buf[..8].try_into().unwrap()) as usize;
        out.extend_from_slice(&buf[8..end]);
        entries.push(((chunk.len() / rec) as u64, (end - 8) as u64));
    }
    Ok((out, entries))
}

/// The LAZ VLR payload and the chunk table bytes for `entries` (fixed-size chunks).
pub fn laz_table(entries: &[(u64, u64)], format: u8, extra: u16) -> Result<(Vec<u8>, Vec<u8>)> {
    let items = LazItemRecordBuilder::default_for_point_format_id(format, extra).map_err(|e| Error::unsupported(format!("LAZ: format {format} ({e})")))?;
    let v = LazVlr::from_laz_items(items);
    let mut payload = Vec::new();
    v.write_to(&mut payload).map_err(io)?;
    let mut table = ChunkTable::default();
    for &(p, b) in entries {
        table.push(laz::laszip::ChunkTableEntry { point_count: p, byte_count: b });
    }
    let mut t = Vec::new();
    table.write_to(&mut t, &v).map_err(io)?;
    Ok((payload, t))
}
