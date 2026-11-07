//! Reading COLMAP's fused PLY and writing LAS 1.2 (point format 2) with an EPSG code, which PDAL
//! then turns into COPC.

use crate::Res;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pt {
    pub xyz: [f32; 3],
    pub rgb: [u8; 3],
}

/// The fused cloud: `binary_little_endian`, a `vertex` element, with x, y, z as float and red,
/// green, blue as uchar. Anything else is refused by name.
pub fn read_ply(path: &Path) -> Res<Vec<Pt>> {
    let f = File::open(path).map_err(|e| format!("cannot read the fused cloud: {e}"))?;
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut line = String::new();
    let read_line = |r: &mut BufReader<File>, l: &mut String| -> Res<()> {
        l.clear();
        r.read_line(l).map_err(|e| e.to_string())?;
        Ok(())
    };
    read_line(&mut r, &mut line)?;
    if line.trim() != "ply" {
        return Err("the fused cloud is not a PLY file".into());
    }
    let mut count = 0usize;
    let mut props: Vec<(String, usize)> = Vec::new();
    loop {
        read_line(&mut r, &mut line)?;
        let t = line.trim();
        if t.is_empty() {
            return Err("the fused cloud's PLY header ends early".into());
        }
        let w: Vec<&str> = t.split_whitespace().collect();
        match w.as_slice() {
            ["end_header"] => break,
            ["format", f, ..] if *f != "binary_little_endian" => return Err(format!("the fused cloud is {f} PLY")),
            ["element", "vertex", n] => count = n.parse().map_err(|_| "the fused cloud has a bad vertex count".to_string())?,
            ["property", ty, name] => {
                let size = match *ty {
                    "float" | "float32" | "int" | "uint" => 4,
                    "double" | "float64" => 8,
                    "uchar" | "uint8" | "char" => 1,
                    "short" | "ushort" => 2,
                    other => return Err(format!("the fused cloud has a {other} property")),
                };
                props.push((name.to_string(), size));
            }
            _ => {}
        }
    }
    let at = |n: &str| -> Option<usize> {
        let mut o = 0;
        for (p, s) in &props {
            if p == n {
                return Some(o);
            }
            o += s;
        }
        None
    };
    let stride: usize = props.iter().map(|p| p.1).sum();
    let (x, y, z) = (at("x").ok_or("no x")?, at("y").ok_or("no y")?, at("z").ok_or("no z")?);
    let rgb = [at("red"), at("green"), at("blue")];
    if stride == 0 {
        return Err("the fused cloud has no properties".into());
    }
    let mut out = Vec::with_capacity(count.min(1 << 28));
    let mut buf = vec![0u8; stride];
    let f32_at = |b: &[u8], o: usize| f32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]]);
    for _ in 0..count {
        r.read_exact(&mut buf).map_err(|_| "the fused cloud is truncated".to_string())?;
        let xyz = [f32_at(&buf, x), f32_at(&buf, y), f32_at(&buf, z)];
        if xyz.iter().all(|v| v.is_finite()) {
            out.push(Pt { xyz, rgb: [rgb[0].map_or(0, |o| buf[o]), rgb[1].map_or(0, |o| buf[o]), rgb[2].map_or(0, |o| buf[o])] });
        }
    }
    Ok(out)
}

pub fn write_las(path: &Path, pts: &[Pt], offset: [f64; 3], epsg: u32) -> Res<()> {
    let e = |e: std::io::Error| format!("cannot write the point cloud: {e}");
    let f = File::create(path).map_err(e)?;
    let mut o = BufWriter::with_capacity(1 << 20, f);
    let mut min = [f64::MAX; 3];
    let mut max = [f64::MIN; 3];
    for p in pts {
        for i in 0..3 {
            let v = p.xyz[i] as f64 + offset[i];
            min[i] = min[i].min(v);
            max[i] = max[i].max(v);
        }
    }
    const SCALE: f64 = 0.001;
    let base = [(min[0] / 1000.0).floor() * 1000.0, (min[1] / 1000.0).floor() * 1000.0, (min[2] / 1000.0).floor() * 1000.0];
    // GeoKeyDirectory VLR: projected, EPSG code.
    let keys: [u16; 16] = [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, epsg as u16];
    let vlr_len = 54 + keys.len() * 2;
    let header = 227usize;
    let data_at = header + vlr_len;
    let mut h = Vec::with_capacity(data_at);
    h.extend(b"LASF");
    h.extend([0u8; 2]); // source id
    h.extend([0u8; 2]); // encoding
    h.extend([0u8; 16]); // GUID
    h.extend([1u8, 2]);
    let mut name = [0u8; 32];
    name[..7].copy_from_slice(b"gwb-sfm");
    h.extend(name);
    let mut soft = [0u8; 32];
    soft[..7].copy_from_slice(b"gwb-sfm");
    h.extend(soft);
    h.extend(1u16.to_le_bytes()); // day
    h.extend(2026u16.to_le_bytes());
    h.extend((header as u16).to_le_bytes());
    h.extend((data_at as u32).to_le_bytes());
    h.extend(1u32.to_le_bytes()); // VLRs
    h.push(2); // point format
    h.extend(26u16.to_le_bytes());
    h.extend((pts.len() as u32).to_le_bytes());
    h.extend((pts.len() as u32).to_le_bytes()); // first return
    for _ in 0..4 {
        h.extend(0u32.to_le_bytes());
    }
    for _ in 0..3 {
        h.extend(SCALE.to_le_bytes());
    }
    for b in base {
        h.extend(b.to_le_bytes());
    }
    for i in 0..3 {
        h.extend(max[i].to_le_bytes());
        h.extend(min[i].to_le_bytes());
    }
    debug_assert_eq!(h.len(), header);
    h.extend(0u16.to_le_bytes());
    let mut user = [0u8; 16];
    user[..15].copy_from_slice(b"LASF_Projection");
    h.extend(user);
    h.extend(34735u16.to_le_bytes());
    h.extend(((keys.len() * 2) as u16).to_le_bytes());
    h.extend([0u8; 32]);
    for k in keys {
        h.extend(k.to_le_bytes());
    }
    o.write_all(&h).map_err(e)?;
    for p in pts {
        let mut r = [0u8; 26];
        for i in 0..3 {
            let v = ((p.xyz[i] as f64 + offset[i] - base[i]) / SCALE).round() as i32;
            r[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        r[14] = 0b0000_1001; // return 1 of 1
        for i in 0..3 {
            r[20 + i * 2..22 + i * 2].copy_from_slice(&(p.rgb[i] as u16 * 257).to_le_bytes());
        }
        o.write_all(&r).map_err(e)?;
    }
    o.flush().map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ply_and_las() {
        let d = std::env::temp_dir().join(format!("gwb-sfm-ply-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let mut b = b"ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float nx\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n".to_vec();
        for (x, c) in [(1.5f32, 9u8), (2.5, 10)] {
            for v in [x, 2.0, 3.0, 0.0] {
                b.extend(v.to_le_bytes());
            }
            b.extend([c, c, c]);
        }
        std::fs::write(d.join("a.ply"), &b).unwrap();
        let p = read_ply(&d.join("a.ply")).unwrap();
        assert_eq!(p, vec![Pt { xyz: [1.5, 2.0, 3.0], rgb: [9, 9, 9] }, Pt { xyz: [2.5, 2.0, 3.0], rgb: [10, 10, 10] }]);
        std::fs::write(d.join("a.ply"), &b[..b.len() - 3]).unwrap();
        assert!(read_ply(&d.join("a.ply")).unwrap_err().contains("truncated"));
        write_las(&d.join("a.las"), &p, [500_000.0, 4_000_000.0, 0.0], 32617).unwrap();
        let l = std::fs::read(d.join("a.las")).unwrap();
        assert_eq!(&l[..4], b"LASF");
        assert_eq!(l.len(), 227 + 54 + 32 + 26 * 2);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
