//! Helicopter landing zones (REQ-DEM-14) on a DSM. A post can be the centre of a landing zone when
//! every post of the touchdown disc (diameter `zone`) has a slope within the class limit and no
//! obstruction stands within the disc plus the safety `buffer`. Obstructions are posts that stand
//! more than `obstruction_h` above the lowest surface around them (a morphological opening of the
//! DSM, which removes objects narrower than `object_w`). Classes: 0 unsuitable, 1 marginal (slope
//! ≤ `slope_marginal`), 2 suitable (slope ≤ `slope_suitable`), 255 no data.

use crate::Grid;

#[derive(Clone, Copy, Debug)]
pub struct Doctrine {
    /// Touchdown zone diameter and the clear buffer around it (m).
    pub zone: f64,
    pub buffer: f64,
    /// Slope limits (degrees).
    pub slope_suitable: f64,
    pub slope_marginal: f64,
    /// Obstruction height (m) and the widest object the opening removes (m).
    pub obstruction_h: f64,
    pub object_w: f64,
}

/// Square min (erode) or max (dilate) filter of radius (rx, ry) posts, separable, NaN-aware.
fn filter(src: &[f32], w: usize, h: usize, rx: usize, ry: usize, max: bool) -> Vec<f32> {
    let pick = |a: f32, b: f32| -> f32 {
        if !a.is_finite() {
            b
        } else if !b.is_finite() {
            a
        } else if max {
            a.max(b)
        } else {
            a.min(b)
        }
    };
    let mut t = vec![f32::NAN; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = f32::NAN;
            for xx in x.saturating_sub(rx)..=(x + rx).min(w - 1) {
                v = pick(v, src[y * w + xx]);
            }
            t[y * w + x] = v;
        }
    }
    let mut o = vec![f32::NAN; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut v = f32::NAN;
            for yy in y.saturating_sub(ry)..=(y + ry).min(h - 1) {
                v = pick(v, t[yy * w + x]);
            }
            o[y * w + x] = v;
        }
    }
    o
}

/// Slope (degrees) by Horn's 3 × 3 method.
pub fn slope(g: &Grid<'_>) -> Vec<f32> {
    let (w, h) = (g.w, g.h);
    let mut s = vec![f32::NAN; w * h];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let z = |dx: i64, dy: i64| f64::from(g.z[((y as i64 + dy) as usize) * w + (x as i64 + dx) as usize]);
            let gx = ((z(1, -1) + 2.0 * z(1, 0) + z(1, 1)) - (z(-1, -1) + 2.0 * z(-1, 0) + z(-1, 1))) / (8.0 * g.cell_x);
            let gy = ((z(-1, 1) + 2.0 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2.0 * z(0, -1) + z(1, -1))) / (8.0 * g.cell_y);
            s[y * w + x] = gx.hypot(gy).atan().to_degrees() as f32;
        }
    }
    s
}

pub struct HlzOut {
    pub classes: Vec<u8>,
    pub slope: Vec<f32>,
    pub obstruction: Vec<u8>,
}

pub fn hlz(g: &Grid<'_>, d: &Doctrine) -> HlzOut {
    let (w, h) = (g.w, g.h);
    let sl = slope(g);
    // Obstructions: height above the opened surface.
    let orx = ((d.object_w / 2.0) / g.cell_x).ceil().max(1.0) as usize;
    let ory = ((d.object_w / 2.0) / g.cell_y).ceil().max(1.0) as usize;
    let opened = filter(&filter(g.z, w, h, orx, ory, false), w, h, orx, ory, true);
    let mut obst = vec![0u8; w * h];
    for k in 0..w * h {
        if g.z[k].is_finite() && opened[k].is_finite() && f64::from(g.z[k] - opened[k]) > d.obstruction_h {
            obst[k] = 1;
        }
    }
    // Obstruction-free surface slope: posts on obstructions take the opened surface's slope, so the
    // object's walls count as obstruction, not as slope.
    let sl_ground = slope(&Grid { w, h, z: &opened, cell_x: g.cell_x, cell_y: g.cell_y });
    let mut s_use = vec![f32::NAN; w * h];
    for k in 0..w * h {
        s_use[k] = if obst[k] == 1 { sl_ground[k] } else { sl[k] };
    }
    // Largest slope over the touchdown disc (square approximation of the disc radius).
    let zrx = ((d.zone / 2.0) / g.cell_x).ceil() as usize;
    let zry = ((d.zone / 2.0) / g.cell_y).ceil() as usize;
    let smax = filter(&s_use, w, h, zrx, zry, true);
    // Any obstruction within the disc plus the buffer: dilate the obstruction mask.
    let brx = (((d.zone / 2.0) + d.buffer) / g.cell_x).ceil() as usize;
    let bry = (((d.zone / 2.0) + d.buffer) / g.cell_y).ceil() as usize;
    let of: Vec<f32> = obst.iter().map(|v| f32::from(*v)).collect();
    let near = filter(&of, w, h, brx, bry, true);
    let mut classes = vec![255u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let k = y * w + x;
            // The disc must lie inside the grid.
            if x < zrx || y < zry || x + zrx >= w || y + zry >= h || !smax[k].is_finite() {
                continue;
            }
            classes[k] = if near[k] > 0.5 {
                0
            } else if f64::from(smax[k]) <= d.slope_suitable {
                2
            } else if f64::from(smax[k]) <= d.slope_marginal {
                1
            } else {
                0
            };
        }
    }
    HlzOut { classes, slope: sl, obstruction: obst }
}
