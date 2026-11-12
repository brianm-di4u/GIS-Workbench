//! Reader for COLMAP's binary model (cameras.bin, images.bin, points3D.bin). The files come from
//! COLMAP in the same job, but the reader still treats them as untrusted: every length is checked
//! against what is left, so a damaged file is an error and never a panic or a huge allocation.

use crate::geo::{M3, V3};
use crate::Res;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Camera {
    pub model: i32,
    pub width: u64,
    pub height: u64,
    pub params: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Image {
    pub id: u32,
    pub q: [f64; 4],
    pub t: V3,
    pub camera: u32,
    pub name: String,
    pub points: Vec<u64>,
}

#[derive(Debug, Clone)]
pub struct Point {
    pub xyz: V3,
    pub error: f64,
    pub track: Vec<u32>,
}

#[derive(Debug, Default)]
pub struct Model {
    pub cameras: HashMap<u32, Camera>,
    pub images: Vec<Image>,
    pub points: HashMap<u64, Point>,
}

struct Rd<'a> {
    b: &'a [u8],
    p: usize,
    what: &'static str,
}

impl Rd<'_> {
    fn take(&mut self, n: usize) -> Res<&[u8]> {
        let end = self.p.checked_add(n).filter(|e| *e <= self.b.len()).ok_or_else(|| format!("{} is truncated", self.what))?;
        let s = &self.b[self.p..end];
        self.p = end;
        Ok(s)
    }
    fn u8(&mut self) -> Res<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Res<u32> {
        let mut a = [0u8; 4];
        a.copy_from_slice(self.take(4)?);
        Ok(u32::from_le_bytes(a))
    }
    fn u64(&mut self) -> Res<u64> {
        let mut a = [0u8; 8];
        a.copy_from_slice(self.take(8)?);
        Ok(u64::from_le_bytes(a))
    }
    fn f64(&mut self) -> Res<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
    /// A record count, refused when the file cannot hold that many records of `each` bytes.
    fn count(&mut self, each: usize) -> Res<usize> {
        let n = self.u64()?;
        let left = (self.b.len() - self.p) / each.max(1);
        if n > left as u64 {
            return Err(format!("{} claims {n} records in {} bytes", self.what, self.b.len()));
        }
        Ok(n as usize)
    }
}

fn params_of(model: i32) -> Option<usize> {
    Some(match model {
        0 => 3,   // SIMPLE_PINHOLE
        1 => 4,   // PINHOLE
        2 => 4,   // SIMPLE_RADIAL
        3 => 5,   // RADIAL
        4 => 8,   // OPENCV
        5 => 8,   // OPENCV_FISHEYE
        6 => 12,  // FULL_OPENCV
        7 => 5,   // FOV
        8 => 4,   // SIMPLE_RADIAL_FISHEYE
        9 => 5,   // RADIAL_FISHEYE
        10 => 12, // THIN_PRISM_FISHEYE
        _ => return None,
    })
}

pub fn parse_cameras(b: &[u8]) -> Res<HashMap<u32, Camera>> {
    let mut r = Rd { b, p: 0, what: "cameras.bin" };
    let n = r.count(24)?;
    let mut out = HashMap::with_capacity(n);
    for _ in 0..n {
        let id = r.u32()?;
        let model = r.u32()? as i32;
        let (width, height) = (r.u64()?, r.u64()?);
        let np = params_of(model).ok_or_else(|| format!("cameras.bin: camera model {model} is not known"))?;
        let mut params = Vec::with_capacity(np);
        for _ in 0..np {
            params.push(r.f64()?);
        }
        out.insert(id, Camera { model, width, height, params });
    }
    Ok(out)
}

pub fn parse_images(b: &[u8]) -> Res<Vec<Image>> {
    let mut r = Rd { b, p: 0, what: "images.bin" };
    let n = r.count(64)?;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let id = r.u32()?;
        let q = [r.f64()?, r.f64()?, r.f64()?, r.f64()?];
        let t = [r.f64()?, r.f64()?, r.f64()?];
        let camera = r.u32()?;
        let mut name = Vec::new();
        loop {
            match r.u8()? {
                0 => break,
                c => name.push(c),
            }
        }
        let name = String::from_utf8(name).map_err(|_| "images.bin: a name is not UTF-8".to_string())?;
        if name.is_empty() || name.contains("..") {
            return Err(format!("images.bin: bad image name {name:?}"));
        }
        let np = r.count(24)?;
        let mut points = Vec::new();
        for _ in 0..np {
            r.take(16)?;
            let id = r.u64()?;
            if id != u64::MAX {
                points.push(id);
            }
        }
        out.push(Image { id, q, t, camera, name, points });
    }
    Ok(out)
}

pub fn parse_points(b: &[u8]) -> Res<HashMap<u64, Point>> {
    let mut r = Rd { b, p: 0, what: "points3D.bin" };
    let n = r.count(43)?;
    let mut out = HashMap::with_capacity(n);
    for _ in 0..n {
        let id = r.u64()?;
        let xyz = [r.f64()?, r.f64()?, r.f64()?];
        r.take(3)?;
        let error = r.f64()?;
        let nt = r.count(8)?;
        let mut track = Vec::with_capacity(nt);
        for _ in 0..nt {
            track.push(r.u32()?);
            r.take(4)?;
        }
        out.insert(id, Point { xyz, error, track });
    }
    Ok(out)
}

/// Each image's observations of 3D points: image id to (pixel, point id), unmatched ones left out.
pub fn parse_observations(b: &[u8]) -> Res<HashMap<u32, Vec<([f64; 2], u64)>>> {
    let mut r = Rd { b, p: 0, what: "images.bin" };
    let n = r.count(64)?;
    let mut out = HashMap::with_capacity(n);
    for _ in 0..n {
        let id = r.u32()?;
        r.take(7 * 8 + 4)?;
        while r.u8()? != 0 {}
        let np = r.count(24)?;
        let mut obs = Vec::new();
        for _ in 0..np {
            let xy = [r.f64()?, r.f64()?];
            let pid = r.u64()?;
            if pid != u64::MAX {
                obs.push((xy, pid));
            }
        }
        out.insert(id, obs);
    }
    Ok(out)
}

/// images.bin with the poses of the images in `poses` (id to quaternion w x y z, translation)
/// replaced, every other byte kept.
pub fn patch_poses(b: &[u8], poses: &HashMap<u32, ([f64; 4], V3)>) -> Res<Vec<u8>> {
    let mut out = b.to_vec();
    let mut r = Rd { b, p: 0, what: "images.bin" };
    let n = r.count(64)?;
    for _ in 0..n {
        let id = r.u32()?;
        let at = r.p;
        r.take(7 * 8 + 4)?;
        if let Some((q, t)) = poses.get(&id) {
            for (k, v) in q.iter().chain(t.iter()).enumerate() {
                out[at + 8 * k..at + 8 * k + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
        while r.u8()? != 0 {}
        let np = r.count(24)?;
        r.take(np * 24)?;
    }
    Ok(out)
}

/// cameras.bin with the parameters of the cameras in `params` replaced, every other byte kept.
pub fn patch_cameras(b: &[u8], params: &HashMap<u32, Vec<f64>>) -> Res<Vec<u8>> {
    let mut out = b.to_vec();
    let mut r = Rd { b, p: 0, what: "cameras.bin" };
    let n = r.count(24)?;
    for _ in 0..n {
        let id = r.u32()?;
        let model = r.u32()? as i32;
        r.take(16)?;
        let np = params_of(model).ok_or_else(|| format!("cameras.bin: camera model {model} is not known"))?;
        let at = r.p;
        r.take(np * 8)?;
        if let Some(p) = params.get(&id) {
            if p.len() != np {
                return Err(format!("cameras.bin: camera {id} has {np} parameters, not {}", p.len()));
            }
            for (k, v) in p.iter().enumerate() {
                out[at + 8 * k..at + 8 * k + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
    }
    Ok(out)
}

/// points3D.bin with the positions of the points in `xyz` replaced, every other byte kept.
pub fn patch_points(b: &[u8], xyz: &HashMap<u64, V3>) -> Res<Vec<u8>> {
    let mut out = b.to_vec();
    let mut r = Rd { b, p: 0, what: "points3D.bin" };
    let n = r.count(43)?;
    for _ in 0..n {
        let id = r.u64()?;
        let at = r.p;
        r.take(3 * 8 + 3 + 8)?;
        if let Some(x) = xyz.get(&id) {
            for (k, v) in x.iter().enumerate() {
                out[at + 8 * k..at + 8 * k + 8].copy_from_slice(&v.to_le_bytes());
            }
        }
        let nt = r.count(8)?;
        r.take(nt * 8)?;
    }
    Ok(out)
}

pub fn read_model(dir: &Path) -> Res<Model> {
    let rd = |n: &str| std::fs::read(dir.join(n)).map_err(|e| format!("cannot read {n} of the model: {e}"));
    Ok(Model { cameras: parse_cameras(&rd("cameras.bin")?)?, images: parse_images(&rd("images.bin")?)?, points: parse_points(&rd("points3D.bin")?)? })
}

/// Rotation (world to camera) of an image.
pub fn rotation(i: &Image) -> M3 {
    crate::geo::quat_to_mat(i.q)
}

/// Camera centre in the world.
pub fn centre(i: &Image) -> V3 {
    let r = rotation(i);
    crate::geo::scale(crate::geo::mat_vec(&crate::geo::transpose(&r), i.t), -1.0)
}

/// fx, fy, cx, cy of a pinhole camera (undistorted workspaces hold only these).
pub fn pinhole(c: &Camera) -> Res<[f64; 4]> {
    match c.model {
        0 => Ok([c.params[0], c.params[0], c.params[1], c.params[2]]),
        1 => Ok([c.params[0], c.params[1], c.params[2], c.params[3]]),
        m => Err(format!("the undistorted model has camera model {m}, not a pinhole")),
    }
}

/// Write a COLMAP map file: `w&h&c&`, then little-endian f32, planar.
pub fn write_map(path: &Path, w: usize, h: usize, c: usize, data: &[f32]) -> Res<()> {
    use std::io::Write;
    let f = std::fs::File::create(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    let mut o = std::io::BufWriter::new(f);
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    write!(o, "{w}&{h}&{c}&").and_then(|_| o.write_all(&bytes)).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Read a COLMAP map file.
pub fn read_map(path: &Path) -> Res<(usize, usize, usize, Vec<f32>)> {
    let b = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut p = 0;
    let mut head = [0usize; 3];
    for h in head.iter_mut() {
        let end = b[p..].iter().position(|c| *c == b'&').ok_or("a depth map has no header")? + p;
        *h = std::str::from_utf8(&b[p..end]).ok().and_then(|s| s.parse().ok()).ok_or("a depth map has a bad header")?;
        p = end + 1;
    }
    let n = head[0].checked_mul(head[1]).and_then(|x| x.checked_mul(head[2])).ok_or("a depth map is too large")?;
    if b.len() < p + n * 4 {
        return Err("a depth map is truncated".into());
    }
    Ok((head[0], head[1], head[2], b[p..p + n * 4].as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn images_blob() -> Vec<u8> {
        let mut b = 1u64.to_le_bytes().to_vec();
        b.extend(9u32.to_le_bytes());
        for v in [1.0f64, 0.0, 0.0, 0.0, 1.0, 2.0, 3.0] {
            b.extend(v.to_le_bytes());
        }
        b.extend(1u32.to_le_bytes());
        b.extend(b"a.jpg\0");
        b.extend(2u64.to_le_bytes());
        for id in [5u64, u64::MAX] {
            b.extend(1.5f64.to_le_bytes());
            b.extend(2.5f64.to_le_bytes());
            b.extend(id.to_le_bytes());
        }
        b
    }

    #[test]
    fn reads_an_image_record() {
        let v = parse_images(&images_blob()).unwrap();
        assert_eq!((v[0].id, v[0].name.as_str(), v[0].points.as_slice()), (9, "a.jpg", &[5u64][..]));
    }

    #[test]
    fn cuts_and_mutations_are_errors_not_panics() {
        let base = images_blob();
        for cut in 0..base.len() {
            assert!(parse_images(&base[..cut]).is_err());
        }
        let mut seed = 11u32;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for _ in 0..50_000 {
            let mut b = base.clone();
            for _ in 0..4 {
                let i = next() as usize % b.len();
                b[i] = next() as u8;
            }
            let _ = parse_images(&b);
            let _ = parse_cameras(&b);
            let _ = parse_points(&b);
        }
    }

    #[test]
    fn map_round_trip_and_bad_headers() {
        let d = std::env::temp_dir().join(format!("gwb-sfm-map-{}.bin", std::process::id()));
        write_map(&d, 2, 3, 1, &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0]).unwrap();
        let (w, h, c, v) = read_map(&d).unwrap();
        assert_eq!((w, h, c, v[5]), (2, 3, 1, 6.0));
        std::fs::write(&d, b"9&9&9&abc").unwrap();
        assert!(read_map(&d).is_err());
        std::fs::write(&d, b"nonsense").unwrap();
        assert!(read_map(&d).is_err());
        std::fs::remove_file(&d).unwrap();
    }
}
