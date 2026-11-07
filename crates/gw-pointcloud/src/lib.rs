//! GIS Workbench point clouds (Appendix D `gw-pointcloud`, REQ-LDR-01..10): LAS 1.0–1.5 headers,
//! VLRs and CRS keys, PDRF 0–10 records, LAZ by chunks (the `laz` crate, D23), a level-of-detail
//! index for budgeted rendering, gridding to DSM/DTM/intensity/density, SMRF ground filtering,
//! profiles and LAS 1.4 export.

pub mod decode;
pub mod grid;
pub mod las;
pub mod laz;
pub mod lod;
pub mod profile;
pub mod smrf;
pub mod write;

use gw_abi::{Error, Result};

/// Re-pack an uncompressed LAS file as LAZ (same header and VLRs, plus the laszip VLR).
/// EVLRs are not carried over.
pub fn las_to_laz(file: &[u8]) -> Result<Vec<u8>> {
    let h = las::header(file)?;
    if h.compressed {
        return Err(Error::invalid("already LAZ"));
    }
    let po = h.point_offset as usize;
    let rl = h.record_len as usize;
    let base = las::base_size(h.format).unwrap();
    let n = h.n_points as usize;
    let raw = file.get(po..po + n * rl).ok_or_else(|| Error::invalid("LAS: truncated point data"))?;
    let extra = (rl - base) as u16;
    let (p0, _) = laz::compress(&[], h.format, extra, 0)?;
    let start = (po + 54 + p0.len()) as u64;
    let (payload, body) = laz::compress(raw, h.format, extra, start)?;
    let mut out = file[..po].to_vec();
    // The laszip VLR goes after the existing ones.
    let mut v = Vec::new();
    v.extend_from_slice(&0u16.to_le_bytes());
    let mut uid = b"laszip encoded".to_vec();
    uid.resize(16, 0);
    v.extend_from_slice(&uid);
    v.extend_from_slice(&22204u16.to_le_bytes());
    v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    let mut d = b"https://laszip.org".to_vec();
    d.resize(32, 0);
    v.extend_from_slice(&d);
    v.extend_from_slice(&payload);
    out.extend(v);
    out[96..100].copy_from_slice(&(start as u32).to_le_bytes());
    out[100..104].copy_from_slice(&(h.n_vlrs + 1).to_le_bytes());
    out[104] = h.format | 0x80;
    if h.version.1 >= 4 && h.header_size >= 375 {
        out[235..243].copy_from_slice(&0u64.to_le_bytes());
        out[243..247].copy_from_slice(&0u32.to_le_bytes());
    }
    out.extend(body);
    Ok(out)
}
