//! SAR geocoding and terrain correction (REQ-GAP-90, REG-085, SDP-2.7 §4.21).
//!
//! * **Orbit**: state vectors (ECEF position and velocity, times in seconds from any epoch the
//!   caller picks), from a product annotation or a POEORB/RESORB `.EOF` file the user supplies.
//!   Interpolated by cubic Hermite between the two vectors around a time: with Sentinel-1's 10 s
//!   spacing that is within a millimetre of the orbit (spike S-72).
//! * **Range-Doppler**: the zero-Doppler time of a ground point, (X − S(t))·V(t) = 0, by Newton,
//!   and its slant range. Atmospheric delay and solid-Earth tides are not modelled (centimetres to
//!   a few decimetres).
//! * **Image**: zero-Doppler time and slant range → (line, pixel), for slant-range products (SLC,
//!   bursts or one block).
//! * **Backward geocoding** onto a DEM in latitude and longitude with heights above the ellipsoid,
//!   with radiometric terrain flattening: γ⁰ = β⁰ · A_β / A_γ, where A_γ is the DEM's area seen by
//!   each radar pixel, projected on the plane normal to the look direction (Small 2011, the
//!   projected-area method), and A_β the pixel's slant-plane area.
//! * **Masks**: layover and shadow per DEM post, from `gw_terrain::sarmask`.

use gw_geodesy::wgs84::{enu_rotation, geodetic_to_ecef, radii};
use gw_terrain::sarmask::{self, DemEnu};

/// Speed of light (m/s).
pub const C: f64 = 299_792_458.0;

type V3 = [f64; 3];

fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn scale(a: V3, k: f64) -> V3 {
    [a[0] * k, a[1] * k, a[2] * k]
}
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: V3, b: V3) -> V3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
fn rot(r: &[[f64; 3]; 3], d: V3) -> V3 {
    [dot(r[0], d), dot(r[1], d), dot(r[2], d)]
}

// ------------------------------------------------------------------ orbit

/// An orbit: state vectors in time order.
pub struct Orbit {
    t: Vec<f64>,
    p: Vec<V3>,
    v: Vec<V3>,
}

impl Orbit {
    /// At least 4 vectors, finite, in strictly increasing time, at most 10 minutes apart.
    pub fn new(t: Vec<f64>, p: Vec<V3>, v: Vec<V3>) -> Option<Orbit> {
        if t.len() < 4 || t.len() != p.len() || t.len() != v.len() {
            return None;
        }
        let finite = |a: &V3| a.iter().all(|x| x.is_finite());
        if !t.iter().all(|x| x.is_finite()) || !p.iter().all(finite) || !v.iter().all(finite) {
            return None;
        }
        if t.windows(2).any(|w| !(w[1] > w[0]) || w[1] - w[0] > 600.0) {
            return None;
        }
        Some(Orbit { t, p, v })
    }

    pub fn start(&self) -> f64 {
        self.t[0]
    }

    pub fn end(&self) -> f64 {
        self.t[self.t.len() - 1]
    }

    /// Position, velocity and acceleration at `t` (clamped to the orbit's span).
    pub fn state(&self, t: f64) -> (V3, V3, V3) {
        let n = self.t.len();
        let k = self.t.partition_point(|&x| x <= t).clamp(1, n - 1) - 1;
        let h = self.t[k + 1] - self.t[k];
        let s = ((t - self.t[k]) / h).clamp(0.0, 1.0);
        let (s2, s3) = (s * s, s * s * s);
        let (p0, p1) = (self.p[k], self.p[k + 1]);
        let (v0, v1) = (scale(self.v[k], h), scale(self.v[k + 1], h));
        let comb = |a: f64, b: f64, c: f64, d: f64| -> V3 { add(add(scale(p0, a), scale(v0, b)), add(scale(p1, c), scale(v1, d))) };
        let pos = comb(2.0 * s3 - 3.0 * s2 + 1.0, s3 - 2.0 * s2 + s, -2.0 * s3 + 3.0 * s2, s3 - s2);
        let vel = scale(comb(6.0 * s2 - 6.0 * s, 3.0 * s2 - 4.0 * s + 1.0, -6.0 * s2 + 6.0 * s, 3.0 * s2 - 2.0 * s), 1.0 / h);
        let acc = scale(comb(12.0 * s - 6.0, 6.0 * s - 4.0, -12.0 * s + 6.0, 6.0 * s - 2.0), 1.0 / (h * h));
        (pos, vel, acc)
    }
}

/// Zero-Doppler time and slant range of ECEF point `x`, starting the search at `t0`. None when
/// the search leaves the orbit or does not converge.
pub fn zero_doppler(o: &Orbit, x: V3, t0: f64) -> Option<(f64, f64)> {
    let mut t = t0.clamp(o.start(), o.end());
    for _ in 0..30 {
        let (p, v, a) = o.state(t);
        let d = sub(x, p);
        let f = dot(d, v);
        let df = dot(d, a) - dot(v, v);
        if !(df.abs() > 0.0) {
            return None;
        }
        let dt = -f / df;
        t += dt;
        if t < o.start() - 1.0 || t > o.end() + 1.0 || !t.is_finite() {
            return None;
        }
        if dt.abs() < 1e-10 {
            if t < o.start() || t > o.end() {
                return None;
            }
            return Some((t, norm(sub(x, o.state(t).0))));
        }
    }
    None
}

// ------------------------------------------------------------------ image geometry

/// A block of lines with one timing: a TOPS burst, or the whole of a stripmap image.
#[derive(Clone, Copy)]
pub struct Block {
    /// Zero-Doppler time of `first_line`.
    pub t0: f64,
    /// The block's first image line.
    pub first_line: f64,
    /// Its valid lines, [lo, hi) in image lines.
    pub valid: (f64, f64),
}

/// Timing and range of an image.
pub struct Image {
    /// Seconds per line.
    pub dt: f64,
    pub blocks: Vec<Block>,
    /// Slant range of pixel 0 and between pixels (m): pixel = (R − r0) / dr.
    pub r0: f64,
    pub dr: f64,
    /// Along-track spacing of a line on the ground (m), for the β⁰ reference area.
    pub az_spacing: f64,
    /// A pixel's zero-Doppler time less its line's time, a + s·τ (s; τ the two-way slant range
    /// time): Sentinel-1's bistatic azimuth delay, (τ − τ_ref)/2, as the product's own geolocation
    /// grid states it. (0, 0) for none.
    pub az_delay: (f64, f64),
}

impl Image {
    /// The image line of a point at zero-Doppler time `t` and slant range `r` (m): `line` at the
    /// time of its line, its zero-Doppler time less the azimuth delay.
    pub fn line_at(&self, t: f64, r: f64) -> Option<f64> {
        self.line(t - (self.az_delay.0 + self.az_delay.1 * 2.0 * r / C))
    }

    /// The image line of line time `t`, in the block whose valid lines hold it (the one whose
    /// centre is nearest where blocks overlap). None outside every block.
    pub fn line(&self, t: f64) -> Option<f64> {
        let mut best: Option<(f64, f64)> = None;
        for b in &self.blocks {
            let l = b.first_line + (t - b.t0) / self.dt;
            if l >= b.valid.0 && l < b.valid.1 {
                let d = (l - (b.valid.0 + b.valid.1) / 2.0).abs();
                if best.map_or(true, |(_, bd)| d < bd) {
                    best = Some((l, d));
                }
            }
        }
        best.map(|(l, _)| l)
    }

    /// The image pixel of slant range `r`.
    pub fn pixel(&self, r: f64) -> f64 {
        (r - self.r0) / self.dr
    }
}

// ------------------------------------------------------------------ geocoding

/// A DEM on a latitude/longitude grid, heights above the ellipsoid (NaN = no data). Post (0, 0)
/// is the north-west one, at (lat0, lon0); rows go south by `dlat`, columns east by `dlon`.
pub struct Dem {
    pub w: usize,
    pub h: usize,
    pub z: Vec<f32>,
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
}

impl Dem {
    fn ll(&self, i: usize, j: usize) -> (f64, f64) {
        (self.lat0 - j as f64 * self.dlat, self.lon0 + i as f64 * self.dlon)
    }
    fn ecef(&self, i: usize, j: usize) -> Option<V3> {
        let z = self.z[j * self.w + i];
        if !z.is_finite() {
            return None;
        }
        let (la, lo) = self.ll(i, j);
        Some(geodetic_to_ecef(la, lo, z as f64))
    }
}

/// The radar window the caller read: image lines l0 + kl·row and pixels s0 + ks·col (the centre
/// of a kl × ks look), `nl` rows by `ns` columns of β⁰ (linear power).
pub struct Window {
    pub l0: f64,
    pub s0: f64,
    pub kl: f64,
    pub ks: f64,
    pub nl: usize,
    pub ns: usize,
    pub beta: Vec<f32>,
}

impl Window {
    fn at(&self, line: f64, pixel: f64) -> (f64, f64) {
        ((line - self.l0 - (self.kl - 1.0) / 2.0) / self.kl, (pixel - self.s0 - (self.ks - 1.0) / 2.0) / self.ks)
    }
}

fn bilinear(a: &[f32], w: usize, h: usize, y: f64, x: f64) -> f64 {
    if !(x >= 0.0 && y >= 0.0 && x <= (w - 1) as f64 && y <= (h - 1) as f64) {
        return f64::NAN;
    }
    let (i, j) = ((x as usize).min(w.saturating_sub(2)), (y as usize).min(h.saturating_sub(2)));
    let (fx, fy) = (x - i as f64, y - j as f64);
    let g = |ii: usize, jj: usize| a[jj * w + ii] as f64;
    if w < 2 || h < 2 {
        return g(0, 0);
    }
    (g(i, j) * (1.0 - fx) + g(i + 1, j) * fx) * (1.0 - fy) + (g(i, j + 1) * (1.0 - fx) + g(i + 1, j + 1) * fx) * fy
}

/// Options of a geocoding run.
pub struct Opts {
    /// γ⁰ by projected area; otherwise β⁰ is resampled as it is.
    pub flatten: bool,
    /// Layover and shadow masks, every `mask_stride`-th post (0 = none), sampled every `mask_step`
    /// metres with height tolerance `mask_tol`.
    pub mask_stride: usize,
    pub mask_step: f64,
    pub mask_tol: f64,
    /// The side the radar looks to, seen along its velocity: 1 right (Sentinel-1), −1 left, 0 either.
    /// A point and its mirror across the ground track share a zero-Doppler time and a range, so a
    /// post on the other side is left out rather than given the image value of its mirror.
    pub look: f64,
}

/// A geocoding run, a few DEM rows per `step` so the caller can report progress and cancel.
pub struct Job {
    orbit: Orbit,
    img: Image,
    dem: Dem,
    win: Window,
    opts: Opts,
    stage: u8,
    row: usize,
    /// Per post: zero-Doppler time (NaN = none), window row and column.
    t: Vec<f64>,
    wl: Vec<f32>,
    wp: Vec<f32>,
    /// A_γ on a continuous zero-Doppler time grid: rows of kl lines from `at0`, the window's
    /// columns. TOPS bursts restart their lines, so area kept per burst line would end at each
    /// burst's valid edge; in time it runs on across the seam.
    area: Vec<f32>,
    arows: usize,
    at0: f64,
    /// Posts whose window pixel's whole footprint is covered by the DEM (flattening only): a pixel
    /// that only partly is gets too little A_γ and reads bright.
    trusted: Vec<bool>,
    /// The DEM's lowest and highest height, for the mask frame.
    zrange: (f64, f64),
    pub value: Vec<f32>,
    pub mask: Vec<u8>,
    /// Posts with a value, posts in layover, posts in shadow.
    pub counts: [usize; 3],
}

impl Job {
    pub fn new(orbit: Orbit, img: Image, dem: Dem, win: Window, opts: Opts) -> Result<Job, &'static str> {
        let n = dem.w.checked_mul(dem.h).ok_or("sargeo: the DEM is too large")?;
        if dem.w < 2 || dem.h < 2 || dem.z.len() != n || !(dem.dlat > 0.0) || !(dem.dlon > 0.0) {
            return Err("sargeo: the DEM grid is malformed");
        }
        if win.nl == 0 || win.ns == 0 || win.beta.len() != win.nl * win.ns || !(win.kl >= 1.0) || !(win.ks >= 1.0) {
            return Err("sargeo: the radar window is malformed");
        }
        if img.blocks.is_empty() || !(img.dt > 0.0) || !(img.az_spacing > 0.0) || !(img.az_delay.0.abs() < 1.0 && img.az_delay.1.abs() < 10.0) {
            return Err("sargeo: the image timing is malformed");
        }
        if !(img.dr > 0.0) || !img.r0.is_finite() {
            return Err("sargeo: the range spacing must be positive");
        }
        let zrange = dem.z.iter().filter(|v| v.is_finite()).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v as f64), b.max(v as f64)));
        Ok(Job { orbit, img, dem, win, opts, stage: 0, row: 0, t: vec![f64::NAN; n], wl: vec![f32::NAN; n], wp: vec![f32::NAN; n], area: Vec::new(), arows: 0, at0: 0.0, trusted: Vec::new(), zrange, value: vec![f32::NAN; n], mask: vec![0; n], counts: [0; 3] })
    }

    /// The mask as written: 1 layover, 2 shadow, 0 neither, and NO_GEOMETRY where the post has no
    /// image position (outside the swath, on the side the radar does not see, or a void).
    pub fn mask_out(&self) -> Vec<u8> {
        self.mask.iter().zip(&self.t).map(|(&m, t)| if t.is_finite() { m } else { NO_GEOMETRY }).collect()
    }

    /// Each post's image line and pixel, interleaved (NaN where it has none): for checks against
    /// a product's own geolocation grid.
    pub fn image_coords(&self) -> Vec<f32> {
        let w = &self.win;
        self.wl.iter().zip(&self.wp).flat_map(|(&l, &p)| [(w.l0 + (w.kl - 1.0) / 2.0 + l as f64 * w.kl) as f32, (w.s0 + (w.ks - 1.0) / 2.0 + p as f64 * w.ks) as f32]).collect()
    }

    /// Run about `rows` DEM rows of work; returns progress in [0, 1] (1 = done).
    pub fn step(&mut self, rows: usize) -> f64 {
        let rows = rows.max(1);
        let h = self.dem.h;
        for _ in 0..rows {
            if self.stage >= 4 {
                break;
            }
            match self.stage {
                0 => self.map_row(self.row),
                1 => self.area_row(self.row),
                2 => self.value_row(self.row),
                _ => self.mask_row(self.row),
            }
            self.row += 1;
            let end = if self.stage == 1 { h - 1 } else { h };
            if self.row >= end {
                self.row = 0;
                self.stage += 1;
                if self.stage == 1 && !self.opts.flatten {
                    self.stage = 2;
                }
                if self.stage == 1 {
                    self.prepare_area();
                }
                if self.stage == 2 && self.opts.flatten {
                    self.trust();
                }
                if self.stage == 3 && self.opts.mask_stride == 0 {
                    self.stage = 4;
                }
            }
        }
        if self.stage >= 4 {
            return 1.0;
        }
        // Weights: mapping 3, area 2, values 1, masks 3.
        let (w, before) = match self.stage {
            0 => (3.0, 0.0),
            1 => (2.0, 3.0),
            2 => (1.0, 5.0),
            _ => (3.0, 6.0),
        };
        ((before + w * self.row as f64 / h as f64) / 9.0).min(0.999)
    }

    /// Whether `x` is on the side the radar looks to at time `t` (always, with look 0).
    fn seen_side(&self, t: f64, x: V3) -> bool {
        if self.opts.look == 0.0 {
            return true;
        }
        let (p, v, _) = self.orbit.state(t);
        dot(sub(x, p), cross(v, p)) * self.opts.look > 0.0
    }

    /// Stage 0: each post's zero-Doppler time and window position.
    fn map_row(&mut self, j: usize) {
        let w = self.dem.w;
        let mut seed = (self.orbit.start() + self.orbit.end()) / 2.0;
        if j > 0 && self.t[(j - 1) * w].is_finite() {
            seed = self.t[(j - 1) * w];
        }
        for i in 0..w {
            let k = j * w + i;
            let Some(x) = self.dem.ecef(i, j) else { continue };
            let Some((t, r)) = zero_doppler(&self.orbit, x, seed) else { continue };
            seed = t;
            if !self.seen_side(t, x) {
                continue;
            }
            let Some(line) = self.img.line_at(t, r) else { continue };
            let pixel = self.img.pixel(r);
            let (wl, wp) = self.win.at(line, pixel);
            self.t[k] = t;
            self.wl[k] = wl as f32;
            self.wp[k] = wp as f32;
        }
    }

    /// The A_γ grid over the zero-Doppler times the posts mapped to, with two rows of margin.
    fn prepare_area(&mut self) {
        let (lo, hi) = self.t.iter().filter(|t| t.is_finite()).fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &t| (a.min(t), b.max(t)));
        if !lo.is_finite() {
            return;
        }
        let row = self.img.dt * self.win.kl;
        self.at0 = lo - 2.0 * row;
        self.arows = (((hi - lo) / row).ceil() as usize + 5).min(48_000_000 / self.win.ns.max(1));
        self.area = vec![0.0; self.arows * self.win.ns];
    }

    /// The A_γ grid row of zero-Doppler time `t`.
    fn arow(&self, t: f64) -> f64 {
        (t - self.at0) / (self.img.dt * self.win.kl)
    }

    /// A window column of image pixel `pixel`.
    fn wcol(&self, pixel: f64) -> f64 {
        (pixel - self.win.s0 - (self.win.ks - 1.0) / 2.0) / self.win.ks
    }

    /// Stage 1: the DEM cells between rows j and j + 1, as two triangles each; the area each
    /// facing the sensor shows, projected on the plane normal to the look, goes to the window
    /// pixels under its centre.
    fn area_row(&mut self, j: usize) {
        let w = self.dem.w;
        if self.area.is_empty() {
            return;
        }
        for i in 0..w - 1 {
            let ks = [j * w + i, j * w + i + 1, (j + 1) * w + i + 1, (j + 1) * w + i];
            if ks.iter().any(|&k| !self.t[k].is_finite()) {
                continue;
            }
            let (Some(a), Some(b), Some(c), Some(d)) = (self.dem.ecef(i, j), self.dem.ecef(i + 1, j), self.dem.ecef(i + 1, j + 1), self.dem.ecef(i, j + 1)) else { continue };
            for tri in [[(a, ks[0]), (b, ks[1]), (c, ks[2])], [(a, ks[0]), (c, ks[2]), (d, ks[3])]] {
                let p = [tri[0].0, tri[1].0, tri[2].0];
                // Area vector, turned to face up (away from the Earth's centre).
                let mut nrm = scale(cross(sub(p[1], p[0]), sub(p[2], p[0])), 0.5);
                let cen = scale(add(add(p[0], p[1]), p[2]), 1.0 / 3.0);
                if dot(nrm, cen) < 0.0 {
                    nrm = scale(nrm, -1.0);
                }
                // The centre's own image position: averaging the corners' would mix two TOPS bursts
                // where the corners fall either side of a burst switch, about 150 lines apart.
                let tc = (self.t[tri[0].1] + self.t[tri[1].1] + self.t[tri[2].1]) / 3.0;
                let Some((t, r)) = zero_doppler(&self.orbit, cen, tc) else { continue };
                if self.img.line_at(t, r).is_none() || !self.seen_side(t, cen) {
                    continue; // imaged by no block
                }
                let look = sub(self.orbit.state(t).0, cen);
                let a_g = dot(nrm, look) / norm(look);
                if !(a_g > 0.0) {
                    continue; // facing away: no area seen
                }
                let (y, x) = (self.arow(t), self.wcol(self.img.pixel(r)));
                // A triangle can span a pixel or more of the grid (about one post per look is the
                // default), and one splat at its centre then leaves a ripple in A_γ that reads as
                // texture. So its area is spread over n² equal sub-triangles no more than SUB of a
                // pixel apart, placed by its corners' grid positions about the centre's own.
                let c = tri.map(|(_, k)| (self.arow(self.t[k]), self.wp[k] as f64));
                let ext = (0..3).map(|m| (c[m].0 - c[(m + 1) % 3].0).abs().max((c[m].1 - c[(m + 1) % 3].1).abs())).fold(0.0, f64::max);
                let n = ((ext / SUB).ceil() as usize).clamp(1, 16);
                let (eu, ev) = ((c[1].0 - c[0].0, c[1].1 - c[0].1), (c[2].0 - c[0].0, c[2].1 - c[0].1));
                let (nf, wt) = (n as f64, a_g / (n * n) as f64);
                for a in 0..n {
                    for b in 0..n - a {
                        // The sub-triangle pointing up, then (where there is one) the one pointing down.
                        for (d, has) in [(1.0 / 3.0, true), (2.0 / 3.0, a + b + 1 < n)] {
                            if has {
                                let (u, v) = ((a as f64 + d) / nf - 1.0 / 3.0, (b as f64 + d) / nf - 1.0 / 3.0);
                                splat(&mut self.area, self.win.ns, self.arows, y + eu.0 * u + ev.0 * v, x + eu.1 * u + ev.1 * v, wt);
                            }
                        }
                    }
                }
            }
        }
    }

    /// Stage 2: each post's value, β⁰ or γ⁰.
    fn value_row(&mut self, j: usize) {
        let w = self.dem.w;
        for i in 0..w {
            let k = j * w + i;
            if !self.t[k].is_finite() {
                continue;
            }
            let (wl, wp) = (self.wl[k] as f64, self.wp[k] as f64);
            let beta = bilinear(&self.win.beta, self.win.ns, self.win.nl, wl, wp);
            if !beta.is_finite() {
                continue;
            }
            let v = if self.opts.flatten {
                if !self.trusted[k] {
                    continue;
                }
                if self.area.is_empty() {
                    continue;
                }
                let a_g = bilinear(&self.area, self.win.ns, self.arows, self.arow(self.t[k]), wp);
                let a_b = self.img.dr * self.img.az_spacing * self.win.kl * self.win.ks;
                if a_g > 1e-6 * a_b {
                    beta * a_b / a_g
                } else {
                    f64::NAN
                }
            } else {
                beta
            };
            if v.is_finite() {
                self.value[k] = v as f32;
                self.counts[0] += 1;
            }
        }
    }

    /// Which posts can be flattened, worked out in radar geometry (the A_γ grid): a pixel is incomplete when
    /// the edge of the mapped DEM (its border, a void, a post with no solution) passes within two
    /// pixels of it, since a triangle's area spreads over the pixels around its centre. A post is
    /// trusted when none of the four pixels it reads is incomplete. On a slope facing the sensor the
    /// edge's radar footprint stretches, and so does the margin.
    fn trust(&mut self) {
        let (w, h) = (self.dem.w, self.dem.h);
        let (nl, ns) = (self.arows, self.win.ns);
        if nl == 0 {
            self.trusted = vec![false; w * h];
            return;
        }
        let rows: Vec<f32> = self.t.iter().map(|&t| self.arow(t) as f32).collect();
        let mut bad = vec![false; nl * ns];
        let mapped = |t: &[f64], i: isize, j: isize| i >= 0 && j >= 0 && (i as usize) < w && (j as usize) < h && t[j as usize * w + i as usize].is_finite();
        let mut mark = |y: f64, x: f64| {
            let (cy, cx) = (y.round() as isize, x.round() as isize);
            for dy in -2..=2 {
                for dx in -2..=2 {
                    let (yy, xx) = (cy + dy, cx + dx);
                    if yy >= 0 && xx >= 0 && (yy as usize) < nl && (xx as usize) < ns {
                        bad[yy as usize * ns + xx as usize] = true;
                    }
                }
            }
        };
        for j in 0..h as isize {
            for i in 0..w as isize {
                let k = j as usize * w + i as usize;
                if !self.t[k].is_finite() {
                    continue;
                }
                let nb = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)];
                if nb.iter().all(|&(di, dj)| mapped(&self.t, i + di, j + dj)) {
                    continue;
                }
                // A boundary post: mark along the segments to its mapped neighbours, so a stretched
                // footprint leaves no gap.
                let (l0, p0) = (rows[k] as f64, self.wp[k] as f64);
                mark(l0, p0);
                for &(di, dj) in &nb {
                    if !mapped(&self.t, i + di, j + dj) {
                        continue;
                    }
                    let q = (j + dj) as usize * w + (i + di) as usize;
                    let (l1, p1) = (rows[q] as f64, self.wp[q] as f64);
                    let n = ((l1 - l0).abs().max((p1 - p0).abs()).ceil() as usize).min(4096);
                    for s in 1..=n {
                        let f = s as f64 / n as f64;
                        mark(l0 + (l1 - l0) * f, p0 + (p1 - p0) * f);
                    }
                }
            }
        }
        self.trusted = (0..w * h)
            .map(|k| {
                if !self.t[k].is_finite() {
                    return false;
                }
                let (y, x) = (rows[k] as f64, self.wp[k] as f64);
                let (y0, x0) = (y.floor(), x.floor());
                [(y0, x0), (y0, x0 + 1.0), (y0 + 1.0, x0), (y0 + 1.0, x0 + 1.0)].iter().all(|&(yy, xx)| yy >= 0.0 && xx >= 0.0 && (yy as usize) < nl && (xx as usize) < ns && !bad[yy as usize * ns + xx as usize])
            })
            .collect();
    }

    /// Stage 3: layover and shadow for every `mask_stride`-th post of every `mask_stride`-th
    /// row, filling the block it stands for.
    fn mask_row(&mut self, j: usize) {
        let st = self.opts.mask_stride;
        if j % st != 0 {
            return;
        }
        let d = &self.dem;
        let latc = d.lat0 - (d.h - 1) as f64 * d.dlat / 2.0;
        let lonc = d.lon0 + (d.w - 1) as f64 * d.dlon / 2.0;
        let (m, nr) = radii(latc);
        let k = std::f64::consts::PI / 180.0;
        let (kn, ke) = (m * k, nr * k * latc.to_radians().cos());
        if !self.zrange.0.is_finite() {
            return;
        }
        // Built here, not with DemEnu::new, which scans the whole DEM for its height range.
        let enu = DemEnu { w: d.w, h: d.h, z: &d.z, e0: (d.lon0 - lonc) * ke, n0: (d.lat0 - latc) * kn, de: d.dlon * ke, dn: d.dlat * kn, radius: (m * nr).sqrt(), zmin: self.zrange.0, zmax: self.zrange.1 };
        let r = enu_rotation(latc, lonc);
        let o = geodetic_to_ecef(latc, lonc, 0.0);
        let mut i = 0;
        while i < d.w {
            let kk = j * d.w + i;
            let t = self.t[kk];
            if t.is_finite() {
                let (la, lo) = d.ll(i, j);
                let (e, n) = ((lo - lonc) * ke, (la - latc) * kn);
                if let Some(pt) = enu.point(e, n) {
                    let (s, v, _) = self.orbit.state(t);
                    let mk = sarmask::mask(&enu, pt, rot(&r, sub(s, o)), rot(&r, v), self.opts.mask_step, self.opts.mask_tol);
                    if mk != 0 {
                        for jj in j..(j + st).min(d.h) {
                            for ii in i..(i + st).min(d.w) {
                                self.mask[jj * d.w + ii] |= mk;
                            }
                        }
                    }
                }
            }
            i += st;
        }
        if j + st >= d.h || (j + st) % st == 0 {
            // Counted once all blocks of this band are set.
            for jj in j..(j + st).min(d.h) {
                for ii in 0..d.w {
                    let mk = self.mask[jj * d.w + ii];
                    if mk & sarmask::LAYOVER != 0 {
                        self.counts[1] += 1;
                    }
                    if mk & sarmask::SHADOW != 0 {
                        self.counts[2] += 1;
                    }
                }
            }
        }
    }
}

/// The mask value of a post with no image position.
pub const NO_GEOMETRY: u8 = 255;

/// The largest spacing, in A_γ grid pixels, between the points a triangle's area is spread over.
const SUB: f64 = 0.25;

/// Add `v` to the four window pixels around (y, x), bilinearly.
fn splat(a: &mut [f32], w: usize, h: usize, y: f64, x: f64, v: f64) {
    if !(x > -1.0 && y > -1.0 && x < w as f64 && y < h as f64) {
        return;
    }
    let (fx, fy) = (x.floor(), y.floor());
    let (dx, dy) = (x - fx, y - fy);
    for (oy, wy) in [(0.0, 1.0 - dy), (1.0, dy)] {
        for (ox, wx) in [(0.0, 1.0 - dx), (1.0, dx)] {
            let (xx, yy) = (fx + ox, fy + oy);
            if xx >= 0.0 && yy >= 0.0 && (xx as usize) < w && (yy as usize) < h {
                a[yy as usize * w + xx as usize] += (v * wx * wy) as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests;
