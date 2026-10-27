//! Image codecs for the decode worker (REQ-FMT-02): NITF JPEG (8/12-bit, default tables),
//! VQ, T.4 bi-level and, behind the `j2k` feature, JPEG 2000. Inputs are untrusted; every
//! decoder returns an error instead of panicking.

pub mod jpeg;
pub mod t4;
pub mod vq;
#[cfg(feature = "j2k")]
pub mod j2k;

pub use jpeg::Raster;

/// Encode a raster for the ABI output buffer: [u32 width, height, comps, bits] (LE) then
/// planar samples, u8 when bits ≤ 8 else u16 LE.
pub fn encode(r: &Raster) -> Vec<u8> {
    let mut v = Vec::with_capacity(16 + r.data.len() * 2);
    for x in [r.width, r.height, r.comps, r.bits] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    if r.bits <= 8 {
        v.extend(r.data.iter().map(|&s| s as u8));
    } else {
        for s in &r.data {
            v.extend_from_slice(&s.to_le_bytes());
        }
    }
    v
}
