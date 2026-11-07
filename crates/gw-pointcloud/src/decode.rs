//! Point records (PDRF 0–10) to columns in the shared local frame (REQ-LDR-01, REQ-LDR-03).
//!
//! The local frame (DN-36) is east/north metres scaled from latitude and longitude at the cloud's
//! origin and up = height above the ellipsoid minus the origin height. The CRS conversion is a
//! lattice the caller builds with its CRS library (proj4js) over the cloud's bounds: each node
//! holds (east, north, vertical correction), interpolated bilinearly per point. Over a 30 m-spaced
//! lattice this reproduces the projection to well under a millimetre.

/// Bilinear CRS lattice over source coordinates.
#[derive(Clone, Debug)]
pub struct Lattice {
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
    pub dy: f64,
    pub nx: usize,
    pub ny: usize,
    /// (east, north, dz) per node, row-major from (x0, y0); dz is added to z·v_unit.
    pub nodes: Vec<[f64; 3]>,
    /// Metres per source height unit.
    pub v_unit: f64,
}

impl Lattice {
    /// Identity in metres (source coordinates already local).
    pub fn identity() -> Self {
        Lattice { x0: 0.0, y0: 0.0, dx: 1.0, dy: 1.0, nx: 2, ny: 2, nodes: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 1.0, 0.0]], v_unit: 1.0 }
    }

    /// From the flat parameter record [x0, y0, dx, dy, nx, ny, v_unit, nodes…].
    pub fn from_flat(a: &[f64]) -> Option<Self> {
        if a.len() < 7 {
            return None;
        }
        let (nx, ny) = (a[4] as usize, a[5] as usize);
        if nx < 2 || ny < 2 || a.len() != 7 + 3 * nx * ny || a[2] == 0.0 || a[3] == 0.0 {
            return None;
        }
        let nodes = a[7..].chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
        Some(Lattice { x0: a[0], y0: a[1], dx: a[2], dy: a[3], nx, ny, nodes, v_unit: a[6] })
    }

    #[inline]
    pub fn apply(&self, x: f64, y: f64, z: f64) -> [f64; 3] {
        let fx = (x - self.x0) / self.dx;
        let fy = (y - self.y0) / self.dy;
        // Clamp the cell, not the fraction: points just outside the header bounds extrapolate.
        let i = (fx.floor() as i64).clamp(0, self.nx as i64 - 2) as usize;
        let j = (fy.floor() as i64).clamp(0, self.ny as i64 - 2) as usize;
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let n = |a: usize, b: usize| &self.nodes[b * self.nx + a];
        let (p00, p10, p01, p11) = (n(i, j), n(i + 1, j), n(i, j + 1), n(i + 1, j + 1));
        let mut o = [0.0; 3];
        for k in 0..3 {
            o[k] = (p00[k] * (1.0 - tx) + p10[k] * tx) * (1.0 - ty) + (p01[k] * (1.0 - tx) + p11[k] * tx) * ty;
        }
        o[2] += z * self.v_unit;
        o
    }
}

/// How to read a block of records.
#[derive(Clone, Debug)]
pub struct RecordSpec {
    pub format: u8,
    pub record_len: usize,
    pub scale: [f64; 3],
    pub offset: [f64; 3],
    /// GPS time origin; times are stored as f32 seconds from it.
    pub t0: f64,
}

/// Columnar points. `ret` packs the return number (low nibble) and the number of returns (high
/// nibble). `flags`: 1 synthetic, 2 key-point, 4 withheld, 8 overlap, 16 scan direction, 32 edge.
/// Scan angles are in 0.006° steps for every format.
#[derive(Clone, Debug, Default)]
pub struct Columns {
    pub n: usize,
    pub pos: Vec<f32>,
    pub time: Vec<f32>,
    pub intensity: Vec<u16>,
    pub source: Vec<u16>,
    pub scan: Vec<i16>,
    pub rgb: Vec<u16>,
    pub class: Vec<u8>,
    pub ret: Vec<u8>,
    pub flags: Vec<u8>,
    pub user: Vec<u8>,
}

pub fn has_time(format: u8) -> bool {
    !matches!(format, 0 | 2)
}
pub fn has_rgb(format: u8) -> bool {
    matches!(format, 2 | 3 | 5 | 7 | 8 | 10)
}

impl Columns {
    pub fn with_capacity(n: usize, rgb: bool) -> Self {
        Columns {
            n: 0,
            pos: Vec::with_capacity(3 * n),
            time: Vec::with_capacity(n),
            intensity: Vec::with_capacity(n),
            source: Vec::with_capacity(n),
            scan: Vec::with_capacity(n),
            rgb: if rgb { Vec::with_capacity(3 * n) } else { Vec::new() },
            class: Vec::with_capacity(n),
            ret: Vec::with_capacity(n),
            flags: Vec::with_capacity(n),
            user: Vec::with_capacity(n),
        }
    }

    /// The JS layout: sections in this order, each padded to 4 bytes: pos f32·3n, time f32·n,
    /// intensity u16·n, source u16·n, scan i16·n, rgb u16·3n (or empty), class, ret, flags, user.
    pub fn to_bytes(&self) -> Vec<u8> {
        let n = self.n;
        let pad = |v: &mut Vec<u8>| {
            while v.len() % 4 != 0 {
                v.push(0);
            }
        };
        let mut b = Vec::with_capacity(n * 32 + 64);
        for v in &self.pos {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for v in &self.time {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for col in [&self.intensity, &self.source] {
            for v in col.iter() {
                b.extend_from_slice(&v.to_le_bytes());
            }
            pad(&mut b);
        }
        for v in &self.scan {
            b.extend_from_slice(&v.to_le_bytes());
        }
        pad(&mut b);
        for v in &self.rgb {
            b.extend_from_slice(&v.to_le_bytes());
        }
        pad(&mut b);
        for col in [&self.class, &self.ret, &self.flags, &self.user] {
            b.extend_from_slice(col);
            pad(&mut b);
        }
        b
    }
}

#[inline]
fn i32at(r: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([r[o], r[o + 1], r[o + 2], r[o + 3]])
}
#[inline]
fn u16at(r: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([r[o], r[o + 1]])
}

/// Decode `raw` (whole records) into `out`, through the lattice.
pub fn decode(raw: &[u8], spec: &RecordSpec, lat: &Lattice, out: &mut Columns) {
    let rl = spec.record_len;
    let f = spec.format;
    let ext = f >= 6;
    let rgb_at = match f {
        2 => Some(20),
        3 | 5 => Some(28),
        7 | 8 | 10 => Some(30),
        _ => None,
    };
    let want_rgb = has_rgb(f);
    for r in raw.chunks_exact(rl) {
        let x = f64::from(i32at(r, 0)) * spec.scale[0] + spec.offset[0];
        let y = f64::from(i32at(r, 4)) * spec.scale[1] + spec.offset[1];
        let z = f64::from(i32at(r, 8)) * spec.scale[2] + spec.offset[2];
        let p = lat.apply(x, y, z);
        out.pos.extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
        out.intensity.push(u16at(r, 12));
        if ext {
            let b14 = r[14];
            let b15 = r[15];
            out.ret.push(b14);
            out.flags.push((b15 & 0x0f) | (((b15 >> 6) & 1) << 4) | (((b15 >> 7) & 1) << 5));
            out.class.push(r[16]);
            out.user.push(r[17]);
            out.scan.push(i16::from_le_bytes([r[18], r[19]]));
            out.source.push(u16at(r, 20));
            out.time.push((f64::from_le_bytes(r[22..30].try_into().unwrap()) - spec.t0) as f32);
        } else {
            let b14 = r[14];
            let rn = b14 & 0x07;
            let nr = (b14 >> 3) & 0x07;
            out.ret.push(rn | (nr << 4));
            let c = r[15];
            out.flags.push(((c >> 5) & 0x07) | (((b14 >> 6) & 1) << 4) | (((b14 >> 7) & 1) << 5));
            out.class.push(c & 0x1f);
            // Scan angle rank in whole degrees → 0.006° steps.
            out.scan.push(((r[16] as i8) as f64 / 0.006).round() as i16);
            out.user.push(r[17]);
            out.source.push(u16at(r, 18));
            out.time.push(if has_time(f) { (f64::from_le_bytes(r[20..28].try_into().unwrap()) - spec.t0) as f32 } else { 0.0 });
        }
        if want_rgb {
            let o = rgb_at.unwrap();
            out.rgb.extend_from_slice(&[u16at(r, o), u16at(r, o + 2), u16at(r, o + 4)]);
        }
        out.n += 1;
    }
}
