//! A small BigTIFF writer for the intermediate DSM and orthomosaic, which `gdal_translate` then
//! turns into COGs. One strip, no compression, GeoTIFF keys for an EPSG code.

use crate::Res;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;

pub struct Geo {
    pub epsg: u32,
    /// World x, y of the upper-left corner of the upper-left pixel.
    pub origin: [f64; 2],
    pub pixel: f64,
}

enum Val {
    Short(Vec<u16>),
    Long(u64),
    Double(Vec<f64>),
    Ascii(Vec<u8>),
}

fn sample_format_tag(float: bool) -> u16 {
    if float {
        3
    } else {
        1
    }
}

/// `data` is interleaved, little-endian, `width * height * samples * bytes` long.
pub fn write(path: &Path, width: usize, height: usize, samples: u16, bits: u16, float: bool, nodata: Option<&str>, geo: &Geo, data: &[u8]) -> Res<()> {
    let expect = width * height * samples as usize * (bits as usize / 8);
    if data.len() != expect {
        return Err(format!("internal: raster holds {} bytes, not {expect}", data.len()));
    }
    let keys = vec![1u16, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, geo.epsg as u16];
    let mut tags: Vec<(u16, Val)> = vec![
        (256, Val::Long(width as u64)),
        (257, Val::Long(height as u64)),
        (258, Val::Short(vec![bits; samples as usize])),
        (259, Val::Short(vec![1])),
        (262, Val::Short(vec![if samples >= 3 { 2 } else { 1 }])),
        (273, Val::Long(0)), // patched below
        (277, Val::Short(vec![samples])),
        (278, Val::Long(height as u64)),
        (279, Val::Long(data.len() as u64)),
        (284, Val::Short(vec![1])),
        (339, Val::Short(vec![sample_format_tag(float); samples as usize])),
        (33550, Val::Double(vec![geo.pixel, geo.pixel, 0.0])),
        (33922, Val::Double(vec![0.0, 0.0, 0.0, geo.origin[0], geo.origin[1], 0.0])),
        (34735, Val::Short(keys)),
    ];
    if samples == 4 {
        tags.push((338, Val::Short(vec![2]))); // unassociated alpha
    }
    if let Some(n) = nodata {
        let mut a = n.as_bytes().to_vec();
        a.push(0);
        tags.push((42113, Val::Ascii(a)));
    }
    tags.sort_by_key(|t| t.0);
    // Layout: 16-byte header, IFD (8 + 20 n + 8), overflow values, pixels.
    let ifd_len = 8 + 20 * tags.len() + 8;
    let mut extra: Vec<u8> = Vec::new();
    let base = 16 + ifd_len;
    let mut entries: Vec<(u16, u16, u64, [u8; 8])> = Vec::new();
    for (tag, v) in &tags {
        let (ty, count, bytes): (u16, u64, Vec<u8>) = match v {
            Val::Short(s) => (3, s.len() as u64, s.iter().flat_map(|x| x.to_le_bytes()).collect()),
            Val::Long(l) => (16, 1, l.to_le_bytes().to_vec()),
            Val::Double(d) => (12, d.len() as u64, d.iter().flat_map(|x| x.to_le_bytes()).collect()),
            Val::Ascii(a) => (2, a.len() as u64, a.clone()),
        };
        let mut inline = [0u8; 8];
        if bytes.len() <= 8 {
            inline[..bytes.len()].copy_from_slice(&bytes);
        } else {
            let off = (base + extra.len()) as u64;
            inline = off.to_le_bytes();
            extra.extend(&bytes);
            if extra.len() % 2 == 1 {
                extra.push(0);
            }
        }
        entries.push((*tag, ty, count, inline));
    }
    let pixels_at = (base + extra.len()) as u64;
    for e in entries.iter_mut().filter(|e| e.0 == 273) {
        e.3 = pixels_at.to_le_bytes();
    }
    let f = File::create(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let mut o = BufWriter::with_capacity(1 << 20, f);
    let mut put = |b: &[u8]| o.write_all(b).map_err(|e| format!("cannot write {}: {e}", path.display()));
    put(b"II")?;
    put(&43u16.to_le_bytes())?;
    put(&8u16.to_le_bytes())?;
    put(&0u16.to_le_bytes())?;
    put(&16u64.to_le_bytes())?;
    put(&(entries.len() as u64).to_le_bytes())?;
    for (tag, ty, count, val) in &entries {
        put(&tag.to_le_bytes())?;
        put(&ty.to_le_bytes())?;
        put(&count.to_le_bytes())?;
        put(val)?;
    }
    put(&0u64.to_le_bytes())?;
    put(&extra)?;
    put(data)?;
    o.flush().map_err(|e| format!("cannot write {}: {e}", path.display()))
}

pub fn f32_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}
