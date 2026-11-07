//! Viewsheds (REQ-DEM-13, D16; Wang, Robinson & White 2000 reference planes, as `gdal_viewshed`
//! uses): cells are visited ring by ring outward from the observer; each cell's sight-line height is
//! extrapolated from the observer through the line between its two neighbours nearer the observer,
//! using their stored horizon heights, so no sight line is traced. Heights are corrected for earth
//! curvature and refraction as `gdal_viewshed -cc` does: Z − cc·d²/(2R). A cell is visible when its
//! height plus the target height reaches the sight line; its horizon height is then the larger of
//! the two. An exact ray-cast (`r3`) is the test oracle.

use crate::Grid;

/// Earth radius used for the curvature correction (GDAL's 12 740 000 m sphere diameter / 2).
pub const EARTH_RADIUS: f64 = 6_370_000.0;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Observer post (column, row).
    pub ox: usize,
    pub oy: usize,
    /// Observer height above the ground and target height above the ground (m).
    pub observer_h: f64,
    pub target_h: f64,
    /// Curvature/refraction coefficient (GDAL -cc; 0.87 for k = 0.13; 0 = flat earth).
    pub cc: f64,
    /// Range limits (m); max ≤ 0 = unlimited.
    pub min_dist: f64,
    pub max_dist: f64,
    /// Sector (degrees clockwise from north, start → end); a full circle when equal.
    pub az_start: f64,
    pub az_end: f64,
}

pub const INVISIBLE: u8 = 0;
pub const VISIBLE: u8 = 1;
pub const OUTSIDE: u8 = 255;

fn corrected(g: &Grid<'_>, p: &Params, x: usize, y: usize) -> f64 {
    let z = f64::from(g.z[y * g.w + x]);
    if p.cc == 0.0 {
        return z;
    }
    let dx = (x as f64 - p.ox as f64) * g.cell_x;
    let dy = (y as f64 - p.oy as f64) * g.cell_y;
    z - p.cc * (dx * dx + dy * dy) / (2.0 * EARTH_RADIUS)
}

fn in_sector(p: &Params, dx: f64, dy_north: f64) -> bool {
    if (p.az_end - p.az_start).abs() < 1e-9 || (p.az_end - p.az_start).abs() >= 360.0 {
        return true;
    }
    let az = (dx.atan2(dy_north).to_degrees() + 360.0) % 360.0;
    let (a, b) = ((p.az_start % 360.0 + 360.0) % 360.0, (p.az_end % 360.0 + 360.0) % 360.0);
    if a <= b {
        az >= a && az <= b
    } else {
        az >= a || az <= b
    }
}

/// Reference-plane viewshed: VISIBLE / INVISIBLE per post, OUTSIDE beyond the range or sector or on
/// a void post.
pub fn viewshed(g: &Grid<'_>, p: &Params) -> Vec<u8> {
    let (w, h) = (g.w as i64, g.h as i64);
    let mut out = vec![OUTSIDE; g.w * g.h];
    let mut horizon = vec![f64::NAN; g.w * g.h];
    let (ox, oy) = (p.ox as i64, p.oy as i64);
    if ox >= w || oy >= h {
        return out;
    }
    let zo = f64::from(g.z[(oy * w + ox) as usize]) + p.observer_h;
    let oi = (oy * w + ox) as usize;
    horizon[oi] = zo;
    out[oi] = VISIBLE;
    let maxr = (ox.max(w - 1 - ox)).max(oy.max(h - 1 - oy));
    // Rings of Chebyshev radius r; within a ring, every cell's neighbours at radius r − 1 are done.
    for r in 1..=maxr {
        for dy in -r..=r {
            for dx in -r..=r {
                if dx.abs() != r && dy.abs() != r {
                    continue;
                }
                let (x, y) = (ox + dx, oy + dy);
                if x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let k = (y * w + x) as usize;
                let zr = f64::from(g.z[k]);
                if !zr.is_finite() {
                    continue;
                }
                let zc = corrected(g, p, x as usize, y as usize);
                // Octant coordinates: i along the major axis, j along the minor (0 ≤ j ≤ i).
                let (i, j) = (dx.abs().max(dy.abs()), dx.abs().min(dy.abs()));
                let major_x = dx.abs() >= dy.abs();
                let (sx, sy) = (dx.signum(), dy.signum());
                let hline = if i == 1 {
                    zo
                } else {
                    // The two cells on the previous ring line x = i − 1 (major axis) around the crossing.
                    let (ax, ay, bx, by) = if major_x { (x - sx, y, x - sx, y - sy) } else { (x, y - sy, x - sx, y - sy) };
                    let get = |xx: i64, yy: i64| -> f64 {
                        if xx < 0 || yy < 0 || xx >= w || yy >= h {
                            return f64::NAN;
                        }
                        horizon[(yy * w + xx) as usize]
                    };
                    let (ha, hb) = (get(ax, ay), get(bx, by));
                    let t = j as f64 / i as f64; // weight of the diagonal neighbour b
                    let hc = match (ha.is_finite(), hb.is_finite()) {
                        (true, true) => ha * (1.0 - t) + hb * t,
                        (true, false) => ha,
                        (false, true) => hb,
                        _ => f64::NAN,
                    };
                    if hc.is_finite() {
                        zo + (hc - zo) * i as f64 / (i - 1) as f64
                    } else {
                        f64::NEG_INFINITY
                    }
                };
                let visible = i == 1 || zc + p.target_h >= hline;
                horizon[k] = zc.max(if i == 1 { zc } else { hline });
                let dist = (dx as f64 * g.cell_x).hypot(dy as f64 * g.cell_y);
                let in_range = dist >= p.min_dist && (p.max_dist <= 0.0 || dist <= p.max_dist) && in_sector(p, dx as f64 * g.cell_x, -(dy as f64) * g.cell_y);
                out[k] = if !in_range { OUTSIDE } else if visible { VISIBLE } else { INVISIBLE };
            }
        }
    }
    out
}

/// Exact ray-cast oracle (tests): samples every half post along the sight line with bilinear
/// heights, the same curvature correction and the same observer/target heights.
pub fn r3(g: &Grid<'_>, p: &Params, x: usize, y: usize) -> bool {
    let at = |fx: f64, fy: f64| -> f64 {
        let (i, j) = (fx.floor().max(0.0) as usize, fy.floor().max(0.0) as usize);
        let (i, j) = (i.min(g.w - 2), j.min(g.h - 2));
        let (a, b) = (fx - i as f64, fy - j as f64);
        let v = |ii: usize, jj: usize| f64::from(g.z[jj * g.w + ii]);
        let z = v(i, j) * (1.0 - a) * (1.0 - b) + v(i + 1, j) * a * (1.0 - b) + v(i, j + 1) * (1.0 - a) * b + v(i + 1, j + 1) * a * b;
        let dx = (fx - p.ox as f64) * g.cell_x;
        let dy = (fy - p.oy as f64) * g.cell_y;
        z - p.cc * (dx * dx + dy * dy) / (2.0 * EARTH_RADIUS)
    };
    let zo = f64::from(g.z[p.oy * g.w + p.ox]) + p.observer_h;
    let zt = at(x as f64, y as f64) + p.target_h;
    let (dx, dy) = (x as f64 - p.ox as f64, y as f64 - p.oy as f64);
    let n = ((dx.abs().max(dy.abs())) * 2.0).ceil() as usize;
    for s in 1..n {
        let t = s as f64 / n as f64;
        let line = zo + (zt - zo) * t;
        if at(p.ox as f64 + dx * t, p.oy as f64 + dy * t) > line + 1e-6 {
            return false;
        }
    }
    true
}
