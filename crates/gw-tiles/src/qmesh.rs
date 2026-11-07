//! Quantized-mesh 1.0 tile encoding from a DEM (FC-14 writer, REQ-FMT-39), and a strict decoder
//! for round-trip checks and fuzzing.
//!
//! A tile is a (2^k + 1)² height grid (heights above the WGS 84 ellipsoid, row 0 = north) over a
//! TMS tile in the geographic (EPSG:4326) or Web Mercator (EPSG:3857) tiling. The grid is meshed
//! with an RTIN (gw-terrain, the "Martini" scheme) for a vertical error bound, the vertices are
//! put in first-use order (so the high-water-mark index code is never negative), triangles are
//! wound counter-clockwise in (u, v), and the tile is written as Cesium's quantized-mesh-1.0:
//! header (centre, height range, bounding sphere, horizon occlusion point), zig-zag delta coded
//! u/v/height, high-water-mark indices (16- or 32-bit), edge lists and, optionally, the
//! oct-encoded vertex normals extension (id 1). Never panics on bad input.

use gw_abi::Error;
use gw_terrain::rtin::Rtin;

const A: f64 = 6378137.0;
const B: f64 = 6356752.314245179;
const E2: f64 = 0.006694379990141317;
const MERC_R: f64 = 6378137.0;

/// One tile to encode.
#[derive(Clone, Copy, Debug)]
pub struct TileSpec {
    pub size: usize,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
    pub mercator: bool,
    pub max_error: f32,
    pub normals: bool,
}

fn ecef(lat: f64, lon: f64, h: f64) -> [f64; 3] {
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    let s = la.sin();
    let n = A / (1.0 - E2 * s * s).sqrt();
    [(n + h) * la.cos() * lo.cos(), (n + h) * la.cos() * lo.sin(), (n * (1.0 - E2) + h) * s]
}

fn merc_y(lat: f64) -> f64 {
    let l = lat.clamp(-85.051_128_78, 85.051_128_78).to_radians();
    MERC_R * (std::f64::consts::FRAC_PI_4 + l / 2.0).tan().ln()
}
fn merc_lat(y: f64) -> f64 {
    (y / MERC_R).sinh().atan().to_degrees()
}

fn zigzag(v: i32) -> u16 {
    ((v << 1) ^ (v >> 31)) as u16
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: [f64; 3]) -> f64 {
    dot(a, a).sqrt()
}

/// Cesium's horizon-culling point (EllipsoidalOccluder.computeHorizonCullingPointFromPoints), in
/// the ellipsoid-scaled space the header stores.
fn horizon_point(center: [f64; 3], pts: &[[f64; 3]]) -> [f64; 3] {
    let scale = |p: [f64; 3]| [p[0] / A, p[1] / A, p[2] / B];
    let c = scale(center);
    let cn = norm(c);
    if cn == 0.0 {
        return [0.0, 0.0, 0.0];
    }
    let dir = [c[0] / cn, c[1] / cn, c[2] / cn];
    let mut best = 0f64;
    for &p in pts {
        let s = scale(p);
        let m2 = dot(s, s);
        let m = m2.sqrt();
        if m == 0.0 {
            continue;
        }
        let d = [s[0] / m, s[1] / m, s[2] / m];
        let (m2, m) = (m2.max(1.0), m.max(1.0));
        let cos_a = dot(d, dir);
        let sin_a = norm(cross(d, dir));
        let cos_b = 1.0 / m;
        let sin_b = (m2 - 1.0).sqrt() * cos_b;
        let den = cos_a * cos_b - sin_a * sin_b;
        if den <= 0.0 {
            // No horizon point exists for this set (it wraps past the horizon): the centre direction at radius 1.
            return dir;
        }
        best = best.max(1.0 / den);
    }
    [dir[0] * best, dir[1] * best, dir[2] * best]
}

/// Cesium oct encoding to two bytes (range 255).
fn oct_encode(n: [f64; 3]) -> [u8; 2] {
    let l1 = n[0].abs() + n[1].abs() + n[2].abs();
    if l1 == 0.0 {
        return [128, 128];
    }
    let (mut x, mut y) = (n[0] / l1, n[1] / l1);
    if n[2] < 0.0 {
        let (ox, oy) = (x, y);
        x = (1.0 - oy.abs()) * if ox >= 0.0 { 1.0 } else { -1.0 };
        y = (1.0 - ox.abs()) * if oy >= 0.0 { 1.0 } else { -1.0 };
    }
    let q = |v: f64| ((v.clamp(-1.0, 1.0) * 0.5 + 0.5) * 255.0).round() as u8;
    [q(x), q(y)]
}

/// Encode one tile. `z` holds size² heights (metres above the ellipsoid), row 0 at the north edge.
pub fn encode_tile(z: &[f32], s: &TileSpec) -> Result<Vec<u8>, Error> {
    let size = s.size;
    if !(3..=257).contains(&size) || (size - 1) & (size - 2) != 0 {
        return Err(Error::invalid("quantized-mesh: the grid must be (2^k + 1)² with 2 ≤ 2^k ≤ 256"));
    }
    if z.len() != size * size {
        return Err(Error::invalid(format!("quantized-mesh: {} heights for a {size}² grid", z.len())));
    }
    if z.iter().any(|h| !h.is_finite()) {
        return Err(Error::invalid("quantized-mesh: heights must be finite (fill nodata first)"));
    }
    let bounds_ok = s.west.is_finite() && s.east.is_finite() && s.south.is_finite() && s.north.is_finite() && s.west < s.east && s.south < s.north && s.south >= -90.0 && s.north <= 90.0;
    if !bounds_ok {
        return Err(Error::invalid("quantized-mesh: the tile bounds are not valid"));
    }
    let rtin = Rtin::new(z, size).ok_or_else(|| Error::invalid("quantized-mesh: RTIN needs a (2^k + 1)² grid"))?;
    let (verts, tris) = rtin.mesh(if s.max_error.is_finite() { s.max_error } else { 0.0 }); // negative: every post
    let max = (size - 1) as f64;
    // First-use order.
    let mut remap = vec![u32::MAX; verts.len()];
    let mut order: Vec<usize> = Vec::with_capacity(verts.len());
    let mut idx: Vec<u32> = Vec::with_capacity(tris.len() * 3);
    let uv = |i: usize| -> (u16, u16) {
        let [x, y] = verts[i];
        (((x as f64 / max) * 32767.0).round() as u16, (((max - y as f64) / max) * 32767.0).round() as u16)
    };
    for t in &tris {
        let (a, b, c) = (t[0] as usize, t[1] as usize, t[2] as usize);
        // Counter-clockwise in (u, v).
        let (ua, va) = uv(a);
        let (ub, vb) = uv(b);
        let (uc, vc) = uv(c);
        let area = (ub as f64 - ua as f64) * (vc as f64 - va as f64) - (uc as f64 - ua as f64) * (vb as f64 - va as f64);
        if area == 0.0 {
            continue;
        }
        let tri = if area > 0.0 { [a, b, c] } else { [a, c, b] };
        for k in tri {
            if remap[k] == u32::MAX {
                remap[k] = order.len() as u32;
                order.push(k);
            }
            idx.push(remap[k]);
        }
    }
    let n = order.len();
    if n == 0 {
        return Err(Error::invalid("quantized-mesh: the mesh is empty"));
    }
    let hs: Vec<f32> = order.iter().map(|&i| z[verts[i][1] as usize * size + verts[i][0] as usize]).collect();
    let (mut hmin, mut hmax) = (f32::INFINITY, f32::NEG_INFINITY);
    for &h in &hs {
        hmin = hmin.min(h);
        hmax = hmax.max(h);
    }
    if hmax - hmin < 1e-3 {
        hmax = hmin + 1e-3;
    }
    let us: Vec<u16> = order.iter().map(|&i| uv(i).0).collect();
    let vs: Vec<u16> = order.iter().map(|&i| uv(i).1).collect();
    let qh: Vec<u16> = hs.iter().map(|&h| (((h - hmin) / (hmax - hmin)) as f64 * 32767.0).round().clamp(0.0, 32767.0) as u16).collect();
    // Geographic position of each vertex (the quantized one, as a decoder sees it).
    let (ys, yn) = if s.mercator { (merc_y(s.south), merc_y(s.north)) } else { (0.0, 0.0) };
    let geo = |i: usize| -> (f64, f64, f64) {
        let lon = s.west + us[i] as f64 / 32767.0 * (s.east - s.west);
        let lat = if s.mercator { merc_lat(ys + vs[i] as f64 / 32767.0 * (yn - ys)) } else { s.south + vs[i] as f64 / 32767.0 * (s.north - s.south) };
        let h = hmin as f64 + qh[i] as f64 / 32767.0 * (hmax - hmin) as f64;
        (lat, lon, h)
    };
    let pts: Vec<[f64; 3]> = (0..n).map(|i| {
        let (la, lo, h) = geo(i);
        ecef(la, lo, h)
    }).collect();
    let (mut lo3, mut hi3) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for p in &pts {
        for k in 0..3 {
            lo3[k] = lo3[k].min(p[k]);
            hi3[k] = hi3[k].max(p[k]);
        }
    }
    let center = [(lo3[0] + hi3[0]) / 2.0, (lo3[1] + hi3[1]) / 2.0, (lo3[2] + hi3[2]) / 2.0];
    let radius = pts.iter().map(|p| norm(sub(*p, center))).fold(0.0, f64::max);
    let horizon = horizon_point(center, &pts);

    let wide = n > 65536;
    let mut b: Vec<u8> = Vec::with_capacity(92 + 6 * n + idx.len() * 4 + 64);
    for v in center {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&hmin.to_le_bytes());
    b.extend_from_slice(&hmax.to_le_bytes());
    for v in center {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&radius.to_le_bytes());
    for v in horizon {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b.extend_from_slice(&(n as u32).to_le_bytes());
    for arr in [&us, &vs, &qh] {
        let mut prev = 0i32;
        for &x in arr.iter() {
            b.extend_from_slice(&zigzag(x as i32 - prev).to_le_bytes());
            prev = x as i32;
        }
    }
    let put_idx = |b: &mut Vec<u8>, v: u32| {
        if wide {
            b.extend_from_slice(&v.to_le_bytes());
        } else {
            b.extend_from_slice(&(v as u16).to_le_bytes());
        }
    };
    if wide {
        while b.len() % 4 != 0 {
            b.push(0);
        }
    }
    b.extend_from_slice(&((idx.len() / 3) as u32).to_le_bytes());
    let mut highest = 0u32;
    for &i in &idx {
        let code = highest - i;
        put_idx(&mut b, code);
        if code == 0 {
            highest += 1;
        }
    }
    // Edge lists: west (u = 0), south (v = 0), east (u = 32767), north (v = 32767).
    for test in [0u8, 1, 2, 3] {
        let list: Vec<u32> = (0..n).filter(|&i| match test {
            0 => us[i] == 0,
            1 => vs[i] == 0,
            2 => us[i] == 32767,
            _ => vs[i] == 32767,
        }).map(|i| i as u32).collect();
        b.extend_from_slice(&(list.len() as u32).to_le_bytes());
        for v in list {
            put_idx(&mut b, v);
        }
    }
    if s.normals {
        let mut acc = vec![[0f64; 3]; n];
        for t in idx.chunks_exact(3) {
            let (a, c1, c2) = (t[0] as usize, t[1] as usize, t[2] as usize);
            let nn = cross(sub(pts[c1], pts[a]), sub(pts[c2], pts[a]));
            for k in [a, c1, c2] {
                for d in 0..3 {
                    acc[k][d] += nn[d];
                }
            }
        }
        b.push(1);
        b.extend_from_slice(&((2 * n) as u32).to_le_bytes());
        for (i, a) in acc.iter().enumerate() {
            let l = norm(*a);
            let v = if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else {
                let p = pts[i];
                let lp = norm(p).max(1.0);
                [p[0] / lp, p[1] / lp, p[2] / lp]
            };
            b.extend_from_slice(&oct_encode(v));
        }
    }
    Ok(b)
}

/// A decoded tile (for round trips and the fuzz target).
#[derive(Debug)]
pub struct Decoded {
    pub min: f32,
    pub max: f32,
    pub u: Vec<u16>,
    pub v: Vec<u16>,
    pub h: Vec<u16>,
    pub indices: Vec<u32>,
    pub edges: [usize; 4],
    pub extensions: Vec<u8>,
}

/// Strict decoder: every length is checked; indices must address vertices.
pub fn decode_tile(b: &[u8]) -> Result<Decoded, Error> {
    let bad = |m: &str| Error::invalid(format!("quantized-mesh: {m}"));
    let rd32 = |p: usize| -> Result<u32, Error> { b.get(p..p + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| bad("truncated")) };
    let rd16 = |p: usize| -> Result<u16, Error> { b.get(p..p + 2).map(|s| u16::from_le_bytes([s[0], s[1]])).ok_or_else(|| bad("truncated")) };
    if b.len() < 92 {
        return Err(bad("shorter than the header"));
    }
    let min = f32::from_le_bytes([b[24], b[25], b[26], b[27]]);
    let max = f32::from_le_bytes([b[28], b[29], b[30], b[31]]);
    let n = rd32(88)? as usize;
    let mut p = 92usize;
    if n == 0 || n > 1 << 24 || p + 6 * n > b.len() {
        return Err(bad("vertex data runs past the tile"));
    }
    let mut arrs = [Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n)];
    for (k, arr) in arrs.iter_mut().enumerate() {
        let mut acc = 0i32;
        for i in 0..n {
            let z = rd16(p + 2 * (k * n + i))? as i32;
            acc += (z >> 1) ^ -(z & 1);
            arr.push(acc as u16);
        }
    }
    p += 6 * n;
    let wide = n > 65536;
    let sz = if wide { 4 } else { 2 };
    if p % sz != 0 {
        p += sz - p % sz;
    }
    let tri = rd32(p)? as usize;
    p += 4;
    if tri > 1 << 25 || p + tri * 3 * sz > b.len() {
        return Err(bad("index data runs past the tile"));
    }
    let mut indices = Vec::with_capacity(tri * 3);
    let mut highest = 0u32;
    for i in 0..tri * 3 {
        let code = if wide { rd32(p + 4 * i)? } else { rd16(p + 2 * i)? as u32 };
        let k = if wide { highest.wrapping_sub(code) } else { (highest.wrapping_sub(code)) & 0xffff };
        if k as usize >= n {
            return Err(bad("an index is out of range"));
        }
        indices.push(k);
        if code == 0 {
            highest += 1;
        }
    }
    p += tri * 3 * sz;
    let mut edges = [0usize; 4];
    for e in edges.iter_mut() {
        let m = rd32(p)? as usize;
        p += 4;
        if m > n || p + m * sz > b.len() {
            return Err(bad("an edge list runs past the tile"));
        }
        *e = m;
        p += m * sz;
    }
    let mut extensions = Vec::new();
    while p + 5 <= b.len() {
        let id = b[p];
        let l = rd32(p + 1)? as usize;
        p += 5;
        if p + l > b.len() {
            return Err(bad("an extension runs past the tile"));
        }
        if id == 1 && l < 2 * n {
            return Err(bad("the normals are shorter than the vertices"));
        }
        extensions.push(id);
        p += l;
    }
    let [u, v, h] = arrs;
    Ok(Decoded { min, max, u, v, h, indices, edges, extensions })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(size: usize, f: impl Fn(f64, f64) -> f32) -> Vec<f32> {
        let mut z = Vec::with_capacity(size * size);
        for r in 0..size {
            for c in 0..size {
                z.push(f(c as f64 / (size - 1) as f64, r as f64 / (size - 1) as f64));
            }
        }
        z
    }

    #[test]
    fn round_trip_heights_within_quantisation() {
        let size = 65;
        let z = grid(size, |x, y| (1000.0 + 300.0 * (x * 6.0).sin() * (y * 4.0).cos()) as f32);
        let spec = TileSpec { size, west: -106.0, south: 39.0, east: -105.0, north: 40.0, mercator: false, max_error: -1.0, normals: true };
        let b = encode_tile(&z, &spec).unwrap();
        let d = decode_tile(&b).unwrap();
        assert_eq!(d.u.len(), size * size, "a negative max error keeps every post");
        assert_eq!(d.extensions, vec![1]);
        let step = (d.max - d.min) / 32767.0;
        for i in 0..d.u.len() {
            let c = (d.u[i] as f64 / 32767.0 * 64.0).round() as usize;
            let r = 64 - (d.v[i] as f64 / 32767.0 * 64.0).round() as usize;
            let h = d.min + d.h[i] as f32 * step;
            assert!((h - z[r * size + c]).abs() <= step, "vertex {i}");
        }
        assert_eq!(d.edges, [65, 65, 65, 65]);
        assert_eq!(d.indices.len() / 3, 2 * 64 * 64);
    }

    #[test]
    fn simplified_mesh_and_mercator() {
        let size = 33;
        let z = grid(size, |x, _| (100.0 + 50.0 * x) as f32); // a plane: two triangles suffice
        let spec = TileSpec { size, west: -122.7, south: 42.5, east: -122.3, north: 42.8, mercator: true, max_error: 0.5, normals: false };
        let d = decode_tile(&encode_tile(&z, &spec).unwrap()).unwrap();
        assert_eq!(d.u.len(), 4);
        assert_eq!(d.indices.len(), 6);
        assert!(d.extensions.is_empty());
    }

    #[test]
    fn horizon_point_is_beyond_the_tile() {
        let c = ecef(39.5, -105.5, 2000.0);
        let pts = [ecef(39.0, -106.0, 1500.0), ecef(40.0, -105.0, 3000.0)];
        let h = horizon_point(c, &pts);
        assert!(norm(h) > 1.0 && norm(h) < 1.01);
    }

    #[test]
    fn refuses_bad_input() {
        let spec = TileSpec { size: 5, west: 0.0, south: 0.0, east: 1.0, north: 1.0, mercator: false, max_error: 1.0, normals: false };
        assert!(encode_tile(&[0.0; 24], &spec).is_err());
        let mut z = vec![0.0; 25];
        z[3] = f32::NAN;
        assert!(encode_tile(&z, &spec).is_err());
        assert!(encode_tile(&[0.0; 36], &TileSpec { size: 6, ..spec }).is_err());
        assert!(decode_tile(&[0u8; 10]).is_err());
    }
}
