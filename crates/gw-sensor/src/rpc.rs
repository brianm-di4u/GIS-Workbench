//! RPC00B / RPC00A rational polynomial model with ICHIPB chip handling (REQ-SNS-02).
//! Equations and term order: `Research/06` §2.2. RPC line/sample offsets refer to pixel
//! centres; this model converts to the corner-origin image convention of the crate.

use crate::{invert_at_height, Ground, SensorModel};
use gw_abi::{Error, Result};

/// GDAL's RPC00A → RPC00B coefficient remapping (`Research/06` §2.2).
pub const RPC00A_TO_B: [usize; 20] = [0, 1, 2, 3, 4, 5, 6, 10, 7, 8, 9, 11, 14, 17, 12, 15, 18, 13, 16, 19];

/// A 6-term affine map chip (x, y) → full image (x, y), both corner-origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub c: [f64; 6], // fx = c0 + c1 x + c2 y ; fy = c3 + c4 x + c5 y
}

impl Affine {
    pub const IDENTITY: Affine = Affine { c: [0.0, 1.0, 0.0, 0.0, 0.0, 1.0] };
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        (self.c[0] + self.c[1] * x + self.c[2] * y, self.c[3] + self.c[4] * x + self.c[5] * y)
    }
    pub fn invert(&self) -> Option<Affine> {
        let [a0, a1, a2, b0, b1, b2] = self.c;
        let det = a1 * b2 - a2 * b1;
        if det.abs() < 1e-300 {
            return None;
        }
        let i1 = b2 / det;
        let i2 = -a2 / det;
        let j1 = -b1 / det;
        let j2 = a1 / det;
        Some(Affine { c: [-(i1 * a0 + i2 * b0), i1, i2, -(j1 * a0 + j2 * b0), j1, j2] })
    }
    /// Least-squares fit from point pairs (src → dst). Needs ≥ 3 non-collinear pairs.
    pub fn fit(src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<Affine> {
        if src.len() < 3 || src.len() != dst.len() {
            return None;
        }
        let mut ata = [[0.0; 3]; 3];
        let mut atx = [0.0; 3];
        let mut aty = [0.0; 3];
        for (s, d) in src.iter().zip(dst) {
            let row = [1.0, s.0, s.1];
            for i in 0..3 {
                for j in 0..3 {
                    ata[i][j] += row[i] * row[j];
                }
                atx[i] += row[i] * d.0;
                aty[i] += row[i] * d.1;
            }
        }
        let px = solve3(ata, atx)?;
        let py = solve3(ata, aty)?;
        Some(Affine { c: [px[0], px[1], px[2], py[0], py[1], py[2]] })
    }
}

pub(crate) fn solve3(m: [[f64; 3]; 3], b: [f64; 3]) -> Option<[f64; 3]> {
    let mut a = [[0.0; 4]; 3];
    for i in 0..3 {
        a[i][..3].copy_from_slice(&m[i]);
        a[i][3] = b[i];
    }
    for col in 0..3 {
        let piv = (col..3).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[piv][col].abs() < 1e-300 {
            return None;
        }
        a.swap(col, piv);
        for r in 0..3 {
            if r != col {
                let f = a[r][col] / a[col][col];
                for k in col..4 {
                    a[r][k] -= f * a[col][k];
                }
            }
        }
    }
    Some([a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]])
}

#[derive(Clone, Debug, PartialEq)]
pub struct Rpc {
    pub err_bias: f64,
    pub err_rand: f64,
    pub line_off: f64,
    pub samp_off: f64,
    pub lat_off: f64,
    pub long_off: f64,
    pub height_off: f64,
    pub line_scale: f64,
    pub samp_scale: f64,
    pub lat_scale: f64,
    pub long_scale: f64,
    pub height_scale: f64,
    pub line_num: [f64; 20],
    pub line_den: [f64; 20],
    pub samp_num: [f64; 20],
    pub samp_den: [f64; 20],
    /// Chip → full image (ICHIPB), identity for a full image.
    pub chip_to_full: Affine,
    full_to_chip: Affine,
}

/// Number of f64 values in the flat RPC record passed over the ABI.
pub const RPC_RECORD_LEN: usize = 12 + 80 + 6;

/// RPC00B terms of normalised latitude p, longitude l and height h (`Research/06` §2.2 order).
#[inline]
pub fn terms(p: f64, l: f64, h: f64) -> [f64; 20] {
    [
        1.0,
        l,
        p,
        h,
        l * p,
        l * h,
        p * h,
        l * l,
        p * p,
        h * h,
        p * l * h,
        l * l * l,
        l * p * p,
        l * h * h,
        l * l * p,
        p * p * p,
        p * h * h,
        l * l * h,
        p * p * h,
        h * h * h,
    ]
}

#[inline]
fn dot(a: &[f64; 20], t: &[f64; 20]) -> f64 {
    let mut s = 0.0;
    for i in 0..20 {
        s += a[i] * t[i];
    }
    s
}

impl Rpc {
    /// Build from the flat record: 12 scalars in TRE order, the four coefficient arrays
    /// (RPC00B order), then the six chip→full affine coefficients.
    pub fn from_record(r: &[f64]) -> Result<Rpc> {
        if r.len() < RPC_RECORD_LEN {
            return Err(Error::invalid("RPC record too short"));
        }
        let arr = |o: usize| -> [f64; 20] {
            let mut a = [0.0; 20];
            a.copy_from_slice(&r[o..o + 20]);
            a
        };
        let mut chip = Affine { c: [0.0; 6] };
        chip.c.copy_from_slice(&r[92..98]);
        if chip.c.iter().all(|v| *v == 0.0) {
            chip = Affine::IDENTITY;
        }
        let full_to_chip = chip.invert().ok_or_else(|| Error::invalid("singular ICHIPB transform"))?;
        let m = Rpc {
            err_bias: r[0],
            err_rand: r[1],
            line_off: r[2],
            samp_off: r[3],
            lat_off: r[4],
            long_off: r[5],
            height_off: r[6],
            line_scale: r[7],
            samp_scale: r[8],
            lat_scale: r[9],
            long_scale: r[10],
            height_scale: r[11],
            line_num: arr(12),
            line_den: arr(32),
            samp_num: arr(52),
            samp_den: arr(72),
            chip_to_full: chip,
            full_to_chip,
        };
        if m.line_scale == 0.0 || m.samp_scale == 0.0 || m.lat_scale == 0.0 || m.long_scale == 0.0 || m.height_scale == 0.0 {
            return Err(Error::invalid("RPC scale of zero"));
        }
        if r.iter().take(92).any(|v| !v.is_finite()) {
            return Err(Error::invalid("RPC contains a non-finite value"));
        }
        Ok(m)
    }

    /// Normalised RPC evaluation: full-image line/sample in the RPC pixel-centre convention.
    pub fn eval(&self, lat: f64, lon: f64, h: f64) -> (f64, f64) {
        let p = (lat - self.lat_off) / self.lat_scale;
        let mut dl = lon - self.long_off;
        if dl > 180.0 {
            dl -= 360.0;
        } else if dl < -180.0 {
            dl += 360.0;
        }
        let l = dl / self.long_scale;
        let hh = (h - self.height_off) / self.height_scale;
        let t = terms(p, l, hh);
        let rn = dot(&self.line_num, &t) / dot(&self.line_den, &t);
        let cn = dot(&self.samp_num, &t) / dot(&self.samp_den, &t);
        (rn * self.line_scale + self.line_off, cn * self.samp_scale + self.samp_off)
    }
}

impl SensorModel for Rpc {
    fn name(&self) -> &str {
        "RPC00B"
    }

    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let (line, samp) = self.eval(g.lat, g.lon, g.h);
        if !line.is_finite() || !samp.is_finite() {
            return Err(Error::range("RPC denominator is zero at this point"));
        }
        // RPC pixel centre → corner-origin full image → chip.
        Ok(self.full_to_chip.apply(samp + 0.5, line + 0.5))
    }

    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        invert_at_height(self, x, y, h, (self.lat_off, self.long_off))
    }

    fn height_range(&self) -> (f64, f64) {
        (self.height_off - self.height_scale, self.height_off + self.height_scale)
    }

    fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
        if self.err_bias < 0.0 || self.err_rand < 0.0 {
            None
        } else {
            Some((self.err_bias, self.err_rand))
        }
    }

    fn horizontal_sigma(&self) -> Option<f64> {
        if self.err_bias < 0.0 || self.err_rand < 0.0 {
            None
        } else {
            Some((self.err_bias * self.err_bias + self.err_rand * self.err_rand).sqrt())
        }
    }
}

/// Build the flat record from RPC00A or RPC00B coefficient arrays in their own order.
pub fn record_from_tre(scalars: [f64; 12], coeffs: [[f64; 20]; 4], rpc00a: bool, chip: Option<Affine>) -> Vec<f64> {
    let mut r = Vec::with_capacity(RPC_RECORD_LEN);
    r.extend_from_slice(&scalars);
    for c in coeffs.iter() {
        if rpc00a {
            let mut b = [0.0; 20];
            for (i, &src) in RPC00A_TO_B.iter().enumerate() {
                b[i] = c[src];
            }
            r.extend_from_slice(&b);
        } else {
            r.extend_from_slice(c);
        }
    }
    r.extend_from_slice(&chip.unwrap_or(Affine::IDENTITY).c);
    r
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A synthetic but realistic RPC: an affine-like camera with small height parallax.
    pub fn synthetic() -> Rpc {
        let mut ln = [0.0; 20];
        let mut sn = [0.0; 20];
        let mut den = [0.0; 20];
        den[0] = 1.0;
        // line ~ -P + 0.02 H, sample ~ L + 0.01 H (+ small cross terms)
        ln[2] = -1.0;
        ln[3] = 0.02;
        ln[1] = 0.001;
        sn[1] = 1.0;
        sn[3] = 0.01;
        sn[2] = 0.002;
        sn[7] = 0.0005;
        let mut r = vec![3.0, 1.0, 5000.0, 5000.0, 33.3, 44.4, 100.0, 5000.0, 5000.0, 0.05, 0.06, 500.0];
        r.extend_from_slice(&ln);
        r.extend_from_slice(&den);
        r.extend_from_slice(&sn);
        r.extend_from_slice(&den);
        r.extend_from_slice(&[0.0; 6]);
        Rpc::from_record(&r).unwrap()
    }

    #[test]
    fn centre_maps_to_offsets() {
        let m = synthetic();
        let (x, y) = m.ground_to_image(Ground { lat: 33.3, lon: 44.4, h: 100.0 }).unwrap();
        assert!((x - 5000.5).abs() < 1e-9 && (y - 5000.5).abs() < 1e-9);
    }

    #[test]
    fn round_trip_g2i_i2g() {
        let m = synthetic();
        for &(lat, lon, h) in &[(33.31, 44.42, 50.0), (33.27, 44.37, 400.0), (33.33, 44.45, -20.0)] {
            let (x, y) = m.ground_to_image(Ground { lat, lon, h }).unwrap();
            let g = m.image_to_ground(x, y, h).unwrap();
            assert!((g.lat - lat).abs() < 1e-10 && (g.lon - lon).abs() < 1e-10);
            // REQ-RUST-06 tolerance: 1e-6 px
            let (x2, y2) = m.ground_to_image(g).unwrap();
            assert!((x2 - x).abs() < 1e-6 && (y2 - y).abs() < 1e-6);
        }
    }

    #[test]
    fn chip_offsets_apply() {
        let base = synthetic();
        let mut r = vec![3.0, 1.0, 5000.0, 5000.0, 33.3, 44.4, 100.0, 5000.0, 5000.0, 0.05, 0.06, 500.0];
        r.extend_from_slice(&base.line_num);
        r.extend_from_slice(&base.line_den);
        r.extend_from_slice(&base.samp_num);
        r.extend_from_slice(&base.samp_den);
        // chip starts at full (x=1000, y=2000), 2× decimated
        r.extend_from_slice(&[1000.0, 2.0, 0.0, 2000.0, 0.0, 2.0]);
        let chip = Rpc::from_record(&r).unwrap();
        let g = Ground { lat: 33.29, lon: 44.41, h: 0.0 };
        let (fx, fy) = base.ground_to_image(g).unwrap();
        let (cx, cy) = chip.ground_to_image(g).unwrap();
        assert!(((fx - 1000.0) / 2.0 - cx).abs() < 1e-9 && ((fy - 2000.0) / 2.0 - cy).abs() < 1e-9);
    }

    #[test]
    fn rpc00a_remap_is_a_permutation() {
        let mut seen = [false; 20];
        for &i in &RPC00A_TO_B {
            seen[i] = true;
        }
        assert!(seen.iter().all(|s| *s));
    }

    #[test]
    fn affine_fit_and_invert() {
        let src = [(0.5, 0.5), (100.5, 0.5), (0.5, 50.5), (100.5, 50.5)];
        let dst: Vec<(f64, f64)> = src.iter().map(|&(x, y)| (10.0 + 2.0 * x, 20.0 + 2.0 * y)).collect();
        let a = Affine::fit(&src, &dst).unwrap();
        let (x, y) = a.apply(3.0, 4.0);
        assert!((x - 16.0).abs() < 1e-9 && (y - 28.0).abs() < 1e-9);
        let inv = a.invert().unwrap();
        let (u, v) = inv.apply(x, y);
        assert!((u - 3.0).abs() < 1e-9 && (v - 4.0).abs() < 1e-9);
    }
}
