//! SMRF ground classification (REQ-LDR-09; Pingel, Clarke and McBride 2013): a minimum surface,
//! a progressive morphological opening with a growing window and a slope threshold, a provisional
//! bare-earth surface interpolated over the removed cells, then each point is ground when it lies
//! within an elevation threshold of that surface (scaled by its local slope). Low outliers (more
//! than `low_noise` m below the median of the surrounding cell minima) are flagged first.

use crate::grid::{fill, sample, GridSpec};

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Cell size (m), slope (rise/run), largest window radius (m), elevation threshold (m) and
    /// elevation scaling factor.
    pub cell: f64,
    pub slope: f64,
    pub window: f64,
    pub threshold: f64,
    pub scalar: f64,
    /// Low-noise depth (m); 0 = no low-noise test.
    pub low_noise: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params { cell: 1.0, slope: 0.15, window: 18.0, threshold: 0.5, scalar: 1.25, low_noise: 2.0 }
    }
}

pub const GROUND: u8 = 2;
pub const NON_GROUND: u8 = 1;
pub const LOW_NOISE: u8 = 7;

/// Minimum or maximum over each cell and its four edge neighbours (a radius-1 diamond), NaN-aware.
/// Applied r times it is the radius-r diamond of PDAL's SMRF (TE-040: the square window it
/// replaces reached r·√2 along diagonals and removed raised ground such as embankments).
fn cross(src: &[f32], w: usize, h: usize, max: bool) -> Vec<f32> {
    let mut out = vec![f32::NAN; src.len()];
    for j in 0..h {
        for i in 0..w {
            let mut best = f32::NAN;
            let mut take = |v: f32| {
                if v.is_finite() && (best.is_nan() || (max && v > best) || (!max && v < best)) {
                    best = v;
                }
            };
            take(src[j * w + i]);
            if i > 0 {
                take(src[j * w + i - 1]);
            }
            if i + 1 < w {
                take(src[j * w + i + 1]);
            }
            if j > 0 {
                take(src[(j - 1) * w + i]);
            }
            if j + 1 < h {
                take(src[(j + 1) * w + i]);
            }
            out[j * w + i] = best;
        }
    }
    out
}

/// Classify points (mask[k] == 0 → left as they are and reported 0). Returns per-point codes.
pub fn smrf(pos: &[f32], mask: Option<&[u8]>, p: &Params) -> Vec<u8> {
    let n = pos.len() / 3;
    let use_pt = |k: usize| mask.is_none_or(|m| m[k] != 0);
    let mut out = vec![0u8; n];
    let (mut e0, mut e1, mut n0, mut n1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
    for k in 0..n {
        if use_pt(k) {
            let (e, nn) = (f64::from(pos[3 * k]), f64::from(pos[3 * k + 1]));
            e0 = e0.min(e);
            e1 = e1.max(e);
            n0 = n0.min(nn);
            n1 = n1.max(nn);
        }
    }
    if e0 > e1 {
        return out;
    }
    let c = p.cell;
    let w = ((e1 - e0) / c).ceil() as usize + 1;
    let h = ((n1 - n0) / c).ceil() as usize + 1;
    let g = GridSpec { e0, n0: n1, ce: c, cn: c, w, h };
    // 1. Minimum surface.
    let mut zmin = vec![f32::NAN; w * h];
    let cell_of = |k: usize| g.cell(f64::from(pos[3 * k]), f64::from(pos[3 * k + 1])).map(|(i, j, _, _)| j * w + i);
    for k in 0..n {
        if !use_pt(k) {
            continue;
        }
        if let Some(q) = cell_of(k) {
            let z = pos[3 * k + 2];
            if zmin[q].is_nan() || z < zmin[q] {
                zmin[q] = z;
            }
        }
    }
    // Low noise: cell minima well below the median of their 5 × 5 neighbourhood.
    let mut low = vec![false; n];
    if p.low_noise > 0.0 {
        let mut med = vec![f32::NAN; w * h];
        let mut buf = Vec::with_capacity(25);
        for j in 0..h {
            for i in 0..w {
                buf.clear();
                for jj in j.saturating_sub(2)..=(j + 2).min(h - 1) {
                    for ii in i.saturating_sub(2)..=(i + 2).min(w - 1) {
                        let v = zmin[jj * w + ii];
                        if v.is_finite() {
                            buf.push(v);
                        }
                    }
                }
                if buf.len() >= 5 {
                    buf.sort_by(|a, b| a.partial_cmp(b).unwrap());
                    med[j * w + i] = buf[buf.len() / 2];
                }
            }
        }
        let mut again = false;
        for k in 0..n {
            if !use_pt(k) {
                continue;
            }
            if let Some(q) = cell_of(k) {
                if med[q].is_finite() && f64::from(med[q] - pos[3 * k + 2]) > p.low_noise {
                    low[k] = true;
                    again = true;
                }
            }
        }
        if again {
            zmin.iter_mut().for_each(|v| *v = f32::NAN);
            for k in 0..n {
                if !use_pt(k) || low[k] {
                    continue;
                }
                if let Some(q) = cell_of(k) {
                    let z = pos[3 * k + 2];
                    if zmin[q].is_nan() || z < zmin[q] {
                        zmin[q] = z;
                    }
                }
            }
        }
    }
    let empty: Vec<bool> = zmin.iter().map(|v| v.is_nan()).collect();
    fill(&mut zmin, w, h, 300);
    // 2. Progressive opening.
    // As PDAL: the erosion grows by one diamond step per level; the opening at radius r dilates
    // that erosion r times.
    let mut object = vec![false; w * h];
    let mut last = zmin.clone();
    let mut eroded = zmin.clone();
    let wmax = (p.window / c).ceil().max(1.0) as usize;
    for r in 1..=wmax {
        eroded = cross(&eroded, w, h, false);
        let mut opened = eroded.clone();
        for _ in 0..r {
            opened = cross(&opened, w, h, true);
        }
        let thr = (p.slope * r as f64 * c) as f32;
        for q in 0..w * h {
            if last[q] - opened[q] > thr {
                object[q] = true;
            }
        }
        last = opened;
    }
    // 3. Provisional DEM: the minimum surface without object (or empty) cells, re-interpolated.
    let mut dem: Vec<f32> = (0..w * h).map(|q| if object[q] || empty[q] { f32::NAN } else { zmin[q] }).collect();
    fill(&mut dem, w, h, 500);
    // Slope of the DEM (rise/run), central differences.
    let mut slope = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            let at = |x: usize, y: usize| dem[y * w + x];
            let (xa, xb) = (i.saturating_sub(1), (i + 1).min(w - 1));
            let (ya, yb) = (j.saturating_sub(1), (j + 1).min(h - 1));
            let gx = (at(xb, j) - at(xa, j)) / (((xb - xa).max(1)) as f32 * c as f32);
            let gy = (at(i, yb) - at(i, ya)) / (((yb - ya).max(1)) as f32 * c as f32);
            slope[j * w + i] = gx.hypot(gy);
        }
    }
    // 4. Classify.
    for k in 0..n {
        if !use_pt(k) {
            continue;
        }
        if low[k] {
            out[k] = LOW_NOISE;
            continue;
        }
        let (e, nn) = (f64::from(pos[3 * k]), f64::from(pos[3 * k + 1]));
        let z0 = sample(&dem, &g, e, nn);
        let s = cell_of(k).map_or(0.0, |q| f64::from(slope[q]));
        let dz = f64::from(pos[3 * k + 2]) - z0;
        out[k] = if z0.is_finite() && dz.abs() <= p.threshold + p.scalar * s { GROUND } else { NON_GROUND };
    }
    out
}
