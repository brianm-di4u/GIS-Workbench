//! Point clouds to grids (REQ-LDR-08): DSM (highest point per post), lowest, mean, DTM (a local
//! plane through the selected points around each post, evaluated at the post, so that slopes do
//! not bias it), mean value (intensity) and density, with Laplace hole filling.

/// Posts at (e0 + i·ce, n0 − j·cn), i < w, j < h; each owns the cell ±ce/2, ±cn/2 around it.
#[derive(Clone, Copy, Debug)]
pub struct GridSpec {
    pub e0: f64,
    pub n0: f64,
    pub ce: f64,
    pub cn: f64,
    pub w: usize,
    pub h: usize,
}

impl GridSpec {
    #[inline]
    pub fn cell(&self, e: f64, n: f64) -> Option<(usize, usize, f64, f64)> {
        let fi = (e - self.e0) / self.ce;
        let fj = (self.n0 - n) / self.cn;
        let (i, j) = (fi.round(), fj.round());
        if i < 0.0 || j < 0.0 || i >= self.w as f64 || j >= self.h as f64 {
            return None;
        }
        // Offsets from the post in metres (east, north).
        Some((i as usize, j as usize, (fi - i) * self.ce, (j - fj) * self.cn))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Max,
    Min,
    Mean,
    Plane,
    MeanValue,
    Density,
}

impl Mode {
    pub fn from_code(c: u32) -> Option<Self> {
        Some(match c {
            0 => Mode::Max,
            1 => Mode::Min,
            2 => Mode::Mean,
            3 => Mode::Plane,
            4 => Mode::MeanValue,
            5 => Mode::Density,
            _ => return None,
        })
    }
}

/// Moments for the plane fit, relative to the post.
#[derive(Clone, Copy, Default)]
struct Mom {
    n: f64,
    x: f64,
    y: f64,
    z: f64,
    xx: f64,
    yy: f64,
    xy: f64,
    xz: f64,
    yz: f64,
}

impl Mom {
    fn add(&mut self, x: f64, y: f64, z: f64) {
        self.n += 1.0;
        self.x += x;
        self.y += y;
        self.z += z;
        self.xx += x * x;
        self.yy += y * y;
        self.xy += x * y;
        self.xz += x * z;
        self.yz += y * z;
    }
    /// The same moments seen from a post that lies (−ox, −oy) metres (east, north) from this one.
    fn shifted(&self, ox: f64, oy: f64) -> Mom {
        Mom {
            n: self.n,
            x: self.x + self.n * ox,
            y: self.y + self.n * oy,
            z: self.z,
            xx: self.xx + 2.0 * ox * self.x + self.n * ox * ox,
            yy: self.yy + 2.0 * oy * self.y + self.n * oy * oy,
            xy: self.xy + oy * self.x + ox * self.y + self.n * ox * oy,
            xz: self.xz + ox * self.z,
            yz: self.yz + oy * self.z,
        }
    }
    fn merge(&mut self, o: &Mom) {
        self.n += o.n;
        self.x += o.x;
        self.y += o.y;
        self.z += o.z;
        self.xx += o.xx;
        self.yy += o.yy;
        self.xy += o.xy;
        self.xz += o.xz;
        self.yz += o.yz;
    }
    /// z at (0, 0) of the least-squares plane, or the mean when the plane is ill-conditioned.
    fn plane_at_origin(&self) -> f64 {
        let m = [[self.n, self.x, self.y], [self.x, self.xx, self.xy], [self.y, self.xy, self.yy]];
        let r = [self.z, self.xz, self.yz];
        let det = |a: &[[f64; 3]; 3]| a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
        let d = det(&m);
        let scale = self.n * (self.xx / self.n.max(1.0)) * (self.yy / self.n.max(1.0));
        if self.n < 4.0 || d.abs() <= 1e-9 * scale.abs().max(1e-12) {
            return self.z / self.n;
        }
        let mut m0 = m;
        for k in 0..3 {
            m0[k][0] = r[k];
        }
        det(&m0) / d
    }
}

/// Grid the selected points (mask[k] != 0). `val` supplies the value for `MeanValue`.
pub fn grid(pos: &[f32], mask: Option<&[u8]>, val: Option<&[f32]>, g: &GridSpec, mode: Mode) -> Vec<f32> {
    let n = pos.len() / 3;
    let cells = g.w * g.h;
    let use_pt = |k: usize| mask.is_none_or(|m| m[k] != 0);
    match mode {
        Mode::Max | Mode::Min => {
            let mut out = vec![f32::NAN; cells];
            for k in 0..n {
                if !use_pt(k) {
                    continue;
                }
                let Some((i, j, _, _)) = g.cell(f64::from(pos[3 * k]), f64::from(pos[3 * k + 1])) else { continue };
                let z = pos[3 * k + 2];
                let c = &mut out[j * g.w + i];
                if c.is_nan() || (mode == Mode::Max && z > *c) || (mode == Mode::Min && z < *c) {
                    *c = z;
                }
            }
            out
        }
        Mode::Mean | Mode::MeanValue | Mode::Density => {
            let mut s = vec![0f64; cells];
            let mut c = vec![0u32; cells];
            for k in 0..n {
                if !use_pt(k) {
                    continue;
                }
                let Some((i, j, _, _)) = g.cell(f64::from(pos[3 * k]), f64::from(pos[3 * k + 1])) else { continue };
                let v = match mode {
                    Mode::MeanValue => f64::from(val.map_or(0.0, |v| v[k])),
                    _ => f64::from(pos[3 * k + 2]),
                };
                s[j * g.w + i] += v;
                c[j * g.w + i] += 1;
            }
            let area = g.ce * g.cn;
            (0..cells)
                .map(|q| match mode {
                    Mode::Density => (f64::from(c[q]) / area) as f32,
                    _ if c[q] == 0 => f32::NAN,
                    _ => (s[q] / f64::from(c[q])) as f32,
                })
                .collect()
        }
        Mode::Plane => {
            let mut m = vec![Mom::default(); cells];
            for k in 0..n {
                if !use_pt(k) {
                    continue;
                }
                let Some((i, j, dx, dy)) = g.cell(f64::from(pos[3 * k]), f64::from(pos[3 * k + 1])) else { continue };
                m[j * g.w + i].add(dx, dy, f64::from(pos[3 * k + 2]));
            }
            let mut out = vec![f32::NAN; cells];
            for j in 0..g.h {
                for i in 0..g.w {
                    let mut acc = Mom::default();
                    for dj in -1i64..=1 {
                        for di in -1i64..=1 {
                            let (ii, jj) = (i as i64 + di, j as i64 + dj);
                            if ii < 0 || jj < 0 || ii >= g.w as i64 || jj >= g.h as i64 {
                                continue;
                            }
                            let c = &m[jj as usize * g.w + ii as usize];
                            if c.n > 0.0 {
                                // That post lies (di·ce, −dj·cn) from this one.
                                acc.merge(&c.shifted(di as f64 * g.ce, -(dj as f64) * g.cn));
                            }
                        }
                    }
                    // Only posts with points of their own get a value; the rest are holes to fill.
                    if m[j * g.w + i].n > 0.0 {
                        out[j * g.w + i] = acc.plane_at_origin() as f32;
                    }
                }
            }
            out
        }
    }
}

/// Fill NaN posts by Laplace interpolation (harmonic: planes are reproduced exactly), started from
/// a push–pull pyramid estimate.
pub fn fill(z: &mut [f32], w: usize, h: usize, iterations: usize) {
    let holes: Vec<usize> = (0..w * h).filter(|&k| z[k].is_nan()).collect();
    if holes.is_empty() || holes.len() == w * h {
        return;
    }
    // Push–pull initial guess.
    let init = push_pull(z, w, h);
    for &k in &holes {
        z[k] = init[k];
    }
    // Gauss–Seidel with over-relaxation on the holes only.
    let omega = 1.8f32;
    for _ in 0..iterations {
        let mut change = 0f32;
        for &k in &holes {
            let (x, y) = (k % w, k / w);
            let mut s = 0f32;
            let mut c = 0f32;
            if x > 0 {
                s += z[k - 1];
                c += 1.0;
            }
            if x + 1 < w {
                s += z[k + 1];
                c += 1.0;
            }
            if y > 0 {
                s += z[k - w];
                c += 1.0;
            }
            if y + 1 < h {
                s += z[k + w];
                c += 1.0;
            }
            let v = z[k] + omega * (s / c - z[k]);
            change = change.max((v - z[k]).abs());
            z[k] = v;
        }
        if change < 1e-4 {
            break;
        }
    }
}

fn push_pull(z: &[f32], w: usize, h: usize) -> Vec<f32> {
    if w <= 1 && h <= 1 {
        return z.to_vec();
    }
    let (w2, h2) = (w.div_ceil(2), h.div_ceil(2));
    let mut c = vec![f32::NAN; w2 * h2];
    for j in 0..h2 {
        for i in 0..w2 {
            let (mut s, mut n) = (0f32, 0f32);
            for dj in 0..2 {
                for di in 0..2 {
                    let (x, y) = (2 * i + di, 2 * j + dj);
                    if x < w && y < h && z[y * w + x].is_finite() {
                        s += z[y * w + x];
                        n += 1.0;
                    }
                }
            }
            if n > 0.0 {
                c[j * w2 + i] = s / n;
            }
        }
    }
    let coarse = if c.iter().any(|v| v.is_nan()) { push_pull(&c, w2, h2) } else { c };
    let mut out = z.to_vec();
    for y in 0..h {
        for x in 0..w {
            if out[y * w + x].is_finite() {
                continue;
            }
            // Bilinear from the coarse level (its posts sit at 2i + 0.5).
            let fx = ((x as f32 - 0.5) / 2.0).clamp(0.0, (w2 - 1) as f32);
            let fy = ((y as f32 - 0.5) / 2.0).clamp(0.0, (h2 - 1) as f32);
            let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(w2 - 1), (y0 + 1).min(h2 - 1));
            let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
            let a = |i: usize, j: usize| coarse[j * w2 + i];
            out[y * w + x] = (a(x0, y0) * (1.0 - tx) + a(x1, y0) * tx) * (1.0 - ty) + (a(x0, y1) * (1.0 - tx) + a(x1, y1) * tx) * ty;
        }
    }
    out
}

/// Bilinear height at (e, n) from a grid (NaN outside or on a NaN post).
pub fn sample(z: &[f32], g: &GridSpec, e: f64, n: f64) -> f64 {
    let fx = (e - g.e0) / g.ce;
    let fy = (g.n0 - n) / g.cn;
    if fx < 0.0 || fy < 0.0 || fx > (g.w - 1) as f64 || fy > (g.h - 1) as f64 {
        return f64::NAN;
    }
    let (x0, y0) = ((fx.floor() as usize).min(g.w - 2), (fy.floor() as usize).min(g.h - 2));
    let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
    let a = |i: usize, j: usize| f64::from(z[j * g.w + i]);
    (a(x0, y0) * (1.0 - tx) + a(x0 + 1, y0) * tx) * (1.0 - ty) + (a(x0, y0 + 1) * (1.0 - tx) + a(x0 + 1, y0 + 1) * tx) * ty
}
