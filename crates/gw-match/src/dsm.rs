//! DSM tiles (REQ-DEM-04): rectify a stereo tile from two source patches through their
//! display-plane affines, run SGM on the pyramid, map disparities to ground with a trilinear
//! lookup of exact two-ray intersections (computed by the caller over the tile), and accumulate
//! heights and figure-of-merit codes on the DSM post grid.

use crate::sgm::{sgm_pyramid, SgmParams, FOM_MATCHED_MIN};

/// Bilinear sample of a patch at corner-origin image coordinates (x, y); NaN outside.
fn sample(px: &[f32], w: usize, h: usize, x0: f64, y0: f64, x: f64, y: f64) -> f32 {
    let fx = x - x0 - 0.5;
    let fy = y - y0 - 0.5;
    if fx < 0.0 || fy < 0.0 || fx > (w - 1) as f64 || fy > (h - 1) as f64 {
        return f32::NAN;
    }
    let i = (fx as usize).min(w.saturating_sub(2));
    let j = (fy as usize).min(h.saturating_sub(2));
    let (ax, ay) = ((fx - i as f64) as f32, (fy - j as f64) as f32);
    let v = |a: usize, b: usize| px[b * w + a];
    v(i, j) * (1.0 - ax) * (1.0 - ay) + v(i + 1, j) * ax * (1.0 - ay) + v(i, j + 1) * (1.0 - ax) * ay + v(i + 1, j + 1) * ax * ay
}

/// Warp a source patch into a W × H tile: tile pixel (u, v) (centre at +0.5) → image a·(u, v, 1).
pub fn warp_affine(src: &[f32], sw: usize, sh: usize, sx0: f64, sy0: f64, a: &[f64; 6], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![f32::NAN; w * h];
    for v in 0..h {
        for u in 0..w {
            let (uu, vv) = (u as f64 + 0.5, v as f64 + 0.5);
            out[v * w + u] = sample(src, sw, sh, sx0, sy0, a[0] + a[1] * uu + a[2] * vv, a[3] + a[4] * uu + a[5] * vv);
        }
    }
    out
}

pub struct Lut {
    pub gu: usize,
    pub gv: usize,
    pub gd: usize,
    pub w: f64,
    pub h: f64,
    pub dmin: f64,
    pub dmax: f64,
    /// (lat, lon, h) at u = w·i/(gu−1), v = h·j/(gv−1), d = dmin + (dmax−dmin)·k/(gd−1); index (k·gv + j)·gu + i.
    pub v: Vec<[f64; 3]>,
}

impl Lut {
    pub fn at(&self, u: f64, v: f64, d: f64) -> [f64; 3] {
        let fu = (u / self.w * (self.gu - 1) as f64).clamp(0.0, (self.gu - 1) as f64);
        let fv = (v / self.h * (self.gv - 1) as f64).clamp(0.0, (self.gv - 1) as f64);
        let fd = ((d - self.dmin) / (self.dmax - self.dmin).max(1e-9) * (self.gd - 1) as f64).clamp(0.0, (self.gd - 1) as f64);
        let (i, j, k) = ((fu as usize).min(self.gu - 2), (fv as usize).min(self.gv - 2), (fd as usize).min(self.gd - 2));
        let (a, b, c) = (fu - i as f64, fv - j as f64, fd - k as f64);
        let idx = |i: usize, j: usize, k: usize| (k * self.gv + j) * self.gu + i;
        let mut out = [0.0; 3];
        for (dk, wk) in [(0, 1.0 - c), (1, c)] {
            for (dj, wj) in [(0, 1.0 - b), (1, b)] {
                for (di, wi) in [(0, 1.0 - a), (1, a)] {
                    let p = self.v[idx(i + di, j + dj, k + dk)];
                    let wgt = wi * wj * wk;
                    for q in 0..3 {
                        out[q] += wgt * p[q];
                    }
                }
            }
        }
        out
    }
}

/// Post grid (sub-grid of the DSM): post (ix, iy) centre at (lat0 − iy·dlat, lon0 + ix·dlon).
pub struct PostGrid {
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub nx: usize,
    pub ny: usize,
}

pub struct TileOut {
    pub sum: Vec<f32>,
    pub count: Vec<f32>,
    /// Highest matched FOM per post (0 when none).
    pub fom_matched: Vec<u8>,
    /// Highest unmatched code (1..=3) per post (0 when none).
    pub fom_unmatched: Vec<u8>,
    pub matched: usize,
    pub pixels: usize,
}

#[allow(clippy::too_many_arguments)]
#[allow(clippy::too_many_arguments)]
pub fn dsm_tile(left: &[f32], right: &[f32], w: usize, h: usize, dmin: i32, dmax: i32, pyr: usize, radius: i32, p: &SgmParams, lut: &Lut, grid: &PostGrid, engine: u32) -> TileOut {
    // Engine 1: NCC Fast (7 × 7 windows, edge-poor); else SGM.
    let r = if engine == 1 { crate::ncc::ncc_fast(left, right, w, h, dmin, dmax, 3, 0.6, p.uniqueness.max(0.5), p.lr_tol.max(1.0)) } else { sgm_pyramid(left, right, w, h, dmin, dmax, pyr, radius, p) };
    let n = grid.nx * grid.ny;
    let mut out = TileOut { sum: vec![0.0; n], count: vec![0.0; n], fom_matched: vec![0; n], fom_unmatched: vec![0; n], matched: 0, pixels: 0 };
    for v in 0..h {
        for u in 0..w {
            let i = v * w + u;
            let f = r.fom[i];
            if f == 0 {
                continue;
            }
            out.pixels += 1;
            let matched = f >= FOM_MATCHED_MIN && r.disparity[i].is_finite();
            let d = if matched { r.disparity[i] } else { r.estimate[i] };
            let g = lut.at(u as f64 + 0.5, v as f64 + 0.5, f64::from(d));
            let ix = ((g[1] - grid.lon0) / grid.dlon).round();
            let iy = ((grid.lat0 - g[0]) / grid.dlat).round();
            if ix < 0.0 || iy < 0.0 || ix >= grid.nx as f64 || iy >= grid.ny as f64 {
                continue;
            }
            let k = iy as usize * grid.nx + ix as usize;
            if matched {
                out.matched += 1;
                out.sum[k] += g[2] as f32;
                out.count[k] += 1.0;
                out.fom_matched[k] = out.fom_matched[k].max(f);
            } else {
                out.fom_unmatched[k] = out.fom_unmatched[k].max(f);
            }
        }
    }
    out
}
