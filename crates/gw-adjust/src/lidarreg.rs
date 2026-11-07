//! Image to point-cloud registration (REQ-GAP-46): the cloud's intensity and hillshade, rasterised
//! on the cloud's grid (gw-pointcloud `grid`), are matched with the image resampled onto the same
//! grid through its sensor model and the cloud's DSM; the matches become 3-D control points taken
//! from the cloud, for `block::adjust_joint` with the cloud's datum shift.
//!
//! Steps:
//! 1. the reference: intensity clipped to its 2–98 % range, and a Horn hillshade of the DSM (the
//!    gdaldem formula; the sun from the options, or the azimuth that matches best);
//! 2. the image on the grid: each post (E, N, DSM height) through the model into the image chip,
//!    bilinear (the model is evaluated on a lattice every 16 posts at two heights and
//!    interpolated, which the tests hold to < 0.01 px against the exact model);
//! 3. a coarse shift by phase correlation of large tiles on a reduced grid (median of the tiles
//!    that pass), then per tile at full resolution: phase correlation at the coarse offset, a second
//!    pass at the rounded result, and the NCC at the final shift as the score;
//! 4. outliers: the peak, peak ratio and NCC thresholds, then RANSAC on an affine in ground metres;
//! 5. control: the cloud point at the tile centre (DSM height) and the image pixel of the matched
//!    position, every `hold_out`-th inlier kept back as a checkpoint.

use gw_abi::{Error, Result};
use gw_match::orb::ransac_affine;
use gw_match::phase::phase_correlate;
use gw_match::{ncc, Win};
use gw_sensor::{Ground, SensorModel};

/// The cloud's local frame (DN-36): east = (lon − lon0)·kx, north = (lat − lat0)·ky (metres).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub lat0: f64,
    pub lon0: f64,
    pub kx: f64,
    pub ky: f64,
}

impl Frame {
    pub fn ground(&self, e: f64, n: f64, h: f64) -> Ground {
        Ground { lat: self.lat0 + n / self.ky, lon: self.lon0 + e / self.kx, h }
    }
    pub fn local(&self, g: Ground) -> (f64, f64) {
        ((g.lon - self.lon0) * self.kx, (g.lat - self.lat0) * self.ky)
    }
}

/// Posts at (e0 + i·cell, n0 − j·cell), i < w, j < h (the gw-pointcloud `GridSpec` layout).
pub struct RefGrid<'a> {
    pub frame: Frame,
    pub e0: f64,
    pub n0: f64,
    pub cell: f64,
    pub w: usize,
    pub h: usize,
    /// Surface heights (HAE m, NaN where empty).
    pub dsm: &'a [f32],
    /// Mean intensity per post, if the cloud has it.
    pub intensity: Option<&'a [f32]>,
}

impl RefGrid<'_> {
    pub fn post(&self, i: f64, j: f64) -> (f64, f64) {
        (self.e0 + i * self.cell, self.n0 - j * self.cell)
    }
    /// Bilinear DSM at fractional post (i, j); NaN outside or next to a hole.
    pub fn dsm_at(&self, i: f64, j: f64) -> f64 {
        bilinear(self.dsm, self.w, self.h, i, j)
    }
}

/// Bilinear sample of a post grid at fractional post (i, j) (posts at integers).
pub fn bilinear(z: &[f32], w: usize, h: usize, i: f64, j: f64) -> f64 {
    if !(i >= 0.0 && j >= 0.0 && i <= (w - 1) as f64 && j <= (h - 1) as f64) || w < 2 || h < 2 {
        return f64::NAN;
    }
    let (i0, j0) = ((i.floor() as usize).min(w - 2), (j.floor() as usize).min(h - 2));
    let (tx, ty) = (i - i0 as f64, j - j0 as f64);
    let v = |a: usize, b: usize| f64::from(z[b * w + a]);
    (v(i0, j0) * (1.0 - tx) + v(i0 + 1, j0) * tx) * (1.0 - ty) + (v(i0, j0 + 1) * (1.0 - tx) + v(i0 + 1, j0 + 1) * tx) * ty
}

/// Image pixels read for the footprint: chip pixel (i, j) covers image x in [x0 + i·step,
/// x0 + (i + 1)·step), likewise y.
pub struct Chip<'a> {
    pub px: &'a [f32],
    pub w: usize,
    pub h: usize,
    pub x0: f64,
    pub y0: f64,
    pub step: f64,
}

impl Chip<'_> {
    /// Bilinear value at full-image (x, y); NaN outside.
    pub fn sample(&self, x: f64, y: f64) -> f64 {
        let win = Win { w: self.w, h: self.h, px: self.px };
        win.sample((x - self.x0) / self.step, (y - self.y0) / self.step).unwrap_or(f64::NAN)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reference {
    Intensity,
    Hillshade,
    Both,
}

#[derive(Clone, Debug)]
pub struct RegOptions {
    pub reference: Reference,
    /// Sun azimuth (° from north) and elevation (°) of the hillshade; NaN azimuth = the best of eight.
    pub sun_az: f64,
    pub sun_el: f64,
    /// Fine tile size (posts, a power of two) and spacing (posts).
    pub tile: usize,
    pub spacing: usize,
    /// Largest image error to search for (m).
    pub max_offset_m: f64,
    pub min_peak: f64,
    pub min_ratio: f64,
    pub min_ncc: f64,
    /// RANSAC tolerance (m).
    pub ransac_tol_m: f64,
    /// Keep every n-th inlier back as a checkpoint (0: none).
    pub hold_out: usize,
}

impl Default for RegOptions {
    fn default() -> Self {
        RegOptions { reference: Reference::Both, sun_az: f64::NAN, sun_el: 45.0, tile: 64, spacing: 64, max_offset_m: 60.0, min_peak: 0.05, min_ratio: 1.3, min_ncc: 0.3, ransac_tol_m: 1.5, hold_out: 5 }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Match {
    /// Tile centre in the cloud frame (m) and the cloud's height there.
    pub e: f64,
    pub n: f64,
    pub z: f64,
    /// Where the image shows it, relative to the tile centre (m, through the unadjusted model).
    pub de: f64,
    pub dn: f64,
    /// Image pixel of the feature.
    pub x: f64,
    pub y: f64,
    pub peak: f64,
    pub ratio: f64,
    pub ncc: f64,
    /// 0 intensity, 1 hillshade.
    pub source: u8,
    pub inlier: bool,
    /// Held out as a checkpoint.
    pub check: bool,
}

#[derive(Clone, Debug)]
pub struct RegOut {
    pub matches: Vec<Match>,
    /// Coarse shift (m, E and N) and the sun azimuth used for the hillshade.
    pub coarse: (f64, f64),
    pub sun_az: f64,
    /// Tiles tried, passing the thresholds, and RANSAC inliers.
    pub tiles: usize,
    pub accepted: usize,
    pub inliers: usize,
    /// Ground affine of the inliers (cloud E, N → image E, N, metres about the grid centre), and the
    /// RMS of the inliers about it (m).
    pub affine: [f64; 6],
    pub rms_m: f64,
}

/// Intensity clipped to its 2–98 % range (NaN stays NaN).
pub fn clip_percentiles(v: &[f32]) -> Vec<f32> {
    let mut s: Vec<f32> = v.iter().copied().filter(|x| x.is_finite()).collect();
    if s.len() < 10 {
        return v.to_vec();
    }
    s.sort_by(f32::total_cmp);
    let (lo, hi) = (s[s.len() * 2 / 100], s[(s.len() * 98 / 100).min(s.len() - 1)]);
    v.iter().map(|x| if x.is_finite() { x.clamp(lo, hi) } else { f32::NAN }).collect()
}

/// Horn hillshade as gdaldem (zFactor 1, both cells `cell` m), scaled 0..1 (gdaldem: 1 + 254·this);
/// NaN on the border and next to holes.
pub fn hillshade(z: &[f32], w: usize, h: usize, cell: f64, az_deg: f64, el_deg: f64) -> Vec<f32> {
    let mut out = vec![f32::NAN; w * h];
    if w < 3 || h < 3 {
        return out;
    }
    let (az, alt) = (az_deg.to_radians(), el_deg.to_radians());
    let (sa, ca) = az.sin_cos();
    let (sl, cl) = alt.sin_cos();
    for j in 1..h - 1 {
        for i in 1..w - 1 {
            let v = |di: i64, dj: i64| f64::from(z[(j as i64 + dj) as usize * w + (i as i64 + di) as usize]);
            let (a, b, c, d, f, g, hh, ii) = (v(-1, -1), v(0, -1), v(1, -1), v(-1, 0), v(1, 0), v(-1, 1), v(0, 1), v(1, 1));
            let x = ((a + 2.0 * d + g) - (c + 2.0 * f + ii)) / (8.0 * cell);
            // gdaldem divides by the (negative) north-south pixel size: top minus bottom here.
            let y = ((a + 2.0 * b + c) - (g + 2.0 * hh + ii)) / (8.0 * cell);
            let cang = (sl - (y * ca * cl - x * sa * cl)) / (1.0 + x * x + y * y).sqrt();
            if cang.is_finite() {
                out[j * w + i] = cang.max(0.0) as f32;
            }
        }
    }
    out
}

/// The image resampled onto the grid: each post through the model at its DSM height into the
/// chip. The model is evaluated on a lattice every `step` posts at the lowest and highest DSM
/// height and interpolated (bilinear in the plane, linear in height).
pub fn ortho_on_grid(model: &dyn SensorModel, g: &RefGrid<'_>, chip: &Chip<'_>, step: usize) -> Result<Vec<f32>> {
    let (w, h) = (g.w, g.h);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in g.dsm.iter().filter(|v| v.is_finite()) {
        lo = lo.min(f64::from(*v));
        hi = hi.max(f64::from(*v));
    }
    if !lo.is_finite() {
        return Err(Error::invalid("the cloud's surface grid is empty"));
    }
    if hi - lo < 1.0 {
        hi = lo + 1.0;
    }
    let step = step.max(1);
    let (lw, lh) = ((w - 1).div_ceil(step) + 1, (h - 1).div_ceil(step) + 1);
    let mut lat_lo = vec![(f64::NAN, f64::NAN); lw * lh];
    let mut lat_hi = vec![(f64::NAN, f64::NAN); lw * lh];
    for lj in 0..lh {
        for li in 0..lw {
            let (e, n) = g.post((li * step) as f64, (lj * step) as f64);
            let a = model.ground_to_image(g.frame.ground(e, n, lo)).unwrap_or((f64::NAN, f64::NAN));
            let b = model.ground_to_image(g.frame.ground(e, n, hi)).unwrap_or((f64::NAN, f64::NAN));
            lat_lo[lj * lw + li] = a;
            lat_hi[lj * lw + li] = b;
        }
    }
    let mut out = vec![f32::NAN; w * h];
    let inv = 1.0 / (hi - lo);
    for j in 0..h {
        let lj = (j / step).min(lh - 2);
        let ty = (j as f64 - (lj * step) as f64) / step as f64;
        for i in 0..w {
            let z = f64::from(g.dsm[j * w + i]);
            if !z.is_finite() {
                continue;
            }
            let li = (i / step).min(lw - 2);
            let tx = (i as f64 - (li * step) as f64) / step as f64;
            let at = |l: &[(f64, f64)]| {
                let p = |a: usize, b: usize| l[b * lw + a];
                let (p00, p10, p01, p11) = (p(li, lj), p(li + 1, lj), p(li, lj + 1), p(li + 1, lj + 1));
                let x = (p00.0 * (1.0 - tx) + p10.0 * tx) * (1.0 - ty) + (p01.0 * (1.0 - tx) + p11.0 * tx) * ty;
                let y = (p00.1 * (1.0 - tx) + p10.1 * tx) * (1.0 - ty) + (p01.1 * (1.0 - tx) + p11.1 * tx) * ty;
                (x, y)
            };
            let (a, b) = (at(&lat_lo), at(&lat_hi));
            let t = (z - lo) * inv;
            let (x, y) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            out[j * w + i] = chip.sample(x, y) as f32;
        }
    }
    Ok(out)
}

/// Mean of f × f blocks (NaN-aware; a block with under half its posts finite is NaN).
fn reduce(v: &[f32], w: usize, h: usize, f: usize) -> (Vec<f32>, usize, usize) {
    let (rw, rh) = (w / f, h / f);
    let mut out = vec![f32::NAN; rw * rh];
    for j in 0..rh {
        for i in 0..rw {
            let (mut s, mut c) = (0.0f64, 0usize);
            for b in 0..f {
                for a in 0..f {
                    let x = v[(j * f + b) * w + i * f + a];
                    if x.is_finite() {
                        s += f64::from(x);
                        c += 1;
                    }
                }
            }
            if c * 2 >= f * f {
                out[j * rw + i] = (s / c as f64) as f32;
            }
        }
    }
    (out, rw, rh)
}

/// Window of `t` × `t` posts at (i0, j0); None when it leaves the grid or has more than
/// `holes_max` (a fraction) holes.
fn window(v: &[f32], w: usize, h: usize, i0: i64, j0: i64, t: usize, holes_max: f64) -> Option<Vec<f32>> {
    if i0 < 0 || j0 < 0 || i0 as usize + t > w || j0 as usize + t > h {
        return None;
    }
    let mut out = Vec::with_capacity(t * t);
    let mut holes = 0;
    for j in 0..t {
        let row = &v[(j0 as usize + j) * w + i0 as usize..(j0 as usize + j) * w + i0 as usize + t];
        holes += row.iter().filter(|x| !x.is_finite()).count();
        out.extend_from_slice(row);
    }
    (holes as f64 <= holes_max * (t * t) as f64).then_some(out)
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    if v.is_empty() {
        f64::NAN
    } else {
        v[v.len() / 2]
    }
}

/// Coarse shift (posts of the full grid, E then S) of `img` against `rf`, and a quality score
/// (count × mean peak of the tiles that pass).
fn coarse_shift(rf: &[f32], img: &[f32], w: usize, h: usize, f: usize, min_ratio: f64) -> Option<(f64, f64, f64)> {
    let (r, rw, rh) = reduce(rf, w, h, f);
    let (m, _, _) = reduce(img, w, h, f);
    let mut t = 128usize;
    while t > 16 && (t > rw || t > rh) {
        t /= 2;
    }
    if t > rw || t > rh {
        return None;
    }
    let mut sx = Vec::new();
    let mut sy = Vec::new();
    let mut score = 0.0;
    let stride = (t / 2).max(1);
    let mut j0 = 0;
    while j0 + t <= rh {
        let mut i0 = 0;
        while i0 + t <= rw {
            if let (Some(a), Some(b)) = (window(&r, rw, rh, i0 as i64, j0 as i64, t, 0.4), window(&m, rw, rh, i0 as i64, j0 as i64, t, 0.4)) {
                if let Some(p) = phase_correlate(Win { w: t, h: t, px: &a }, Win { w: t, h: t, px: &b }) {
                    if p.ratio >= min_ratio && p.dx.abs() < t as f64 / 3.0 && p.dy.abs() < t as f64 / 3.0 {
                        sx.push(p.dx);
                        sy.push(p.dy);
                        score += p.peak;
                    }
                }
            }
            i0 += stride;
        }
        j0 += stride;
    }
    if sx.is_empty() {
        return None;
    }
    let n = sx.len() as f64;
    Some((median(sx) * f as f64, median(sy) * f as f64, score * n.sqrt()))
}

/// One fine tile: phase correlation at the coarse offset, a second pass at the rounded result,
/// NCC at the final shift. Returns (dx, dy posts, peak, ratio, ncc).
fn fine_tile(rf: &[f32], img: &[f32], w: usize, h: usize, i0: usize, j0: usize, t: usize, start: (f64, f64)) -> Option<(f64, f64, f64, f64, f64)> {
    let a = window(rf, w, h, i0 as i64, j0 as i64, t, 0.1)?;
    let mut off = (start.0.round() as i64, start.1.round() as i64);
    let mut last = None;
    for _ in 0..2 {
        let b = window(img, w, h, i0 as i64 + off.0, j0 as i64 + off.1, t, 0.1)?;
        let p = phase_correlate(Win { w: t, h: t, px: &a }, Win { w: t, h: t, px: &b })?;
        if p.dx.abs() > t as f64 / 4.0 || p.dy.abs() > t as f64 / 4.0 {
            return None;
        }
        let d = (off.0 as f64 + p.dx, off.1 as f64 + p.dy);
        last = Some((d, p));
        let next = (d.0.round() as i64, d.1.round() as i64);
        if next == off {
            break;
        }
        off = next;
    }
    let ((dx, dy), p) = last?;
    // NCC of the reference tile with the image at the final shift.
    let (mut va, mut vb) = (Vec::with_capacity(t * t), Vec::with_capacity(t * t));
    for j in 0..t {
        for i in 0..t {
            let r = f64::from(a[j * t + i]);
            let s = bilinear(img, w, h, (i0 + i) as f64 + dx, (j0 + j) as f64 + dy);
            if r.is_finite() && s.is_finite() {
                va.push(r);
                vb.push(s);
            }
        }
    }
    if va.len() * 10 < t * t * 8 {
        return None;
    }
    Some((dx, dy, p.peak, p.ratio, ncc(&va, &vb)))
}

/// Peak ratio a coarse tile needs (lower than the fine one: the coarse shift is a median of tiles).
const COARSE_RATIO: f64 = 1.15;

/// Match the image to the cloud and generate control.
pub fn register(model: &dyn SensorModel, g: &RefGrid<'_>, chip: &Chip<'_>, o: &RegOptions) -> Result<RegOut> {
    let (w, h) = (g.w, g.h);
    if w < 16 || h < 16 || g.dsm.len() != w * h || g.intensity.is_some_and(|v| v.len() != w * h) || !(g.cell > 0.0) {
        return Err(Error::invalid("the cloud grid is too small or its arrays do not match it"));
    }
    if chip.px.len() != chip.w * chip.h || chip.w < 2 || chip.h < 2 || !(chip.step > 0.0) {
        return Err(Error::invalid("the image chip does not match its size"));
    }
    if !o.tile.is_power_of_two() || !(16..=256).contains(&o.tile) || o.spacing == 0 {
        return Err(Error::invalid("the tile size must be a power of two from 16 to 256"));
    }
    let want_i = matches!(o.reference, Reference::Intensity | Reference::Both);
    let want_h = matches!(o.reference, Reference::Hillshade | Reference::Both);
    if o.reference == Reference::Intensity && g.intensity.is_none() {
        return Err(gw_abi::err!(UNSUPPORTED, "this cloud has no intensity; use the hillshade"));
    }
    let img = ortho_on_grid(model, g, chip, 16)?;
    if img.iter().filter(|v| v.is_finite()).count() * 4 < w * h {
        return Err(Error::invalid("the image covers under a quarter of the cloud grid: check the model or the area"));
    }
    // Coarse level: tiles of ≤128 reduced posts must hold the largest offset within a quarter.
    let f = ((4.0 * o.max_offset_m / (g.cell * 128.0)).ceil() as usize).clamp(1, (w.min(h) / 32).max(1));
    let mut refs: Vec<(u8, Vec<f32>)> = Vec::new();
    if want_i {
        if let Some(iv) = g.intensity {
            refs.push((0, clip_percentiles(iv)));
        }
    }
    let mut sun_az = o.sun_az;
    let mut coarse: Option<(f64, f64, f64)> = None;
    if want_h {
        let candidates: Vec<f64> = if sun_az.is_finite() { vec![sun_az] } else { (0..8).map(|k| k as f64 * 45.0).collect() };
        let mut best: Option<(f64, Vec<f32>, (f64, f64, f64))> = None;
        for az in candidates {
            let hs = hillshade(g.dsm, w, h, g.cell, az, o.sun_el);
            if let Some(c) = coarse_shift(&hs, &img, w, h, f, COARSE_RATIO) {
                if best.as_ref().map_or(true, |b| c.2 > b.2 .2) {
                    best = Some((az, hs, c));
                }
            }
        }
        if let Some((az, hs, c)) = best {
            sun_az = az;
            coarse = Some(c);
            refs.push((1, hs));
        } else if o.reference == Reference::Hillshade {
            return Err(gw_abi::err!(INVALID, "the hillshade did not match the image at any sun azimuth"));
        }
    }
    if want_i && g.intensity.is_some() {
        if let Some(c) = coarse_shift(&refs[0].1, &img, w, h, f, COARSE_RATIO) {
            if coarse.map_or(true, |b| c.2 > b.2) {
                coarse = Some(c);
            }
        }
    }
    let (cx, cy, _) = coarse.ok_or_else(|| gw_abi::err!(INVALID, "no coarse match between the image and the cloud (try a larger search or the other reference)"))?;
    // Fine tiles.
    let t = o.tile;
    let mut raw: Vec<(usize, usize, u8, (f64, f64, f64, f64, f64))> = Vec::new();
    let mut tiles = 0;
    for (src, rf) in &refs {
        let mut j0 = 0;
        while j0 + t <= h {
            let mut i0 = 0;
            while i0 + t <= w {
                tiles += 1;
                if let Some(r) = fine_tile(rf, &img, w, h, i0, j0, t, (cx, cy)) {
                    if r.2 >= o.min_peak && r.3 >= o.min_ratio && r.4 >= o.min_ncc {
                        raw.push((i0, j0, *src, r));
                    }
                }
                i0 += o.spacing;
            }
            j0 += o.spacing;
        }
    }
    let accepted = raw.len();
    // RANSAC in ground metres about the grid centre: cloud position → image position.
    let (ce, cn) = g.post((w as f64 - 1.0) / 2.0, (h as f64 - 1.0) / 2.0);
    let half = (t as f64 - 1.0) / 2.0;
    let pairs: Vec<([f64; 2], [f64; 2])> = raw
        .iter()
        .map(|(i0, j0, _, r)| {
            let (e, n) = g.post(*i0 as f64 + half, *j0 as f64 + half);
            ([e - ce, n - cn], [e - ce + r.0 * g.cell, n - cn - r.1 * g.cell])
        })
        .collect();
    let (affine, inl) = if pairs.len() >= 3 { ransac_affine(&pairs, o.ransac_tol_m, 500, 0x9e37_79b9_7f4a_7c15).unwrap_or(([0.0, 1.0, 0.0, 0.0, 0.0, 1.0], vec![false; pairs.len()])) } else { ([0.0, 1.0, 0.0, 0.0, 0.0, 1.0], vec![false; pairs.len()]) };
    let mut matches = Vec::with_capacity(raw.len());
    let mut nin = 0usize;
    let mut ss = 0.0;
    for ((k, (i0, j0, src, r)), ok) in raw.iter().enumerate().zip(&inl) {
        let (ic, jc) = (*i0 as f64 + half, *j0 as f64 + half);
        let (e, n) = g.post(ic, jc);
        let z = g.dsm_at(ic, jc);
        let (ie, jn) = (ic + r.0, jc + r.1);
        let zi = g.dsm_at(ie, jn);
        let (pe, pn) = g.post(ie, jn);
        let Ok((x, y)) = model.ground_to_image(g.frame.ground(pe, pn, if zi.is_finite() { zi } else { z })) else { continue };
        if !z.is_finite() {
            continue;
        }
        let inlier = *ok;
        let check = inlier && o.hold_out > 0 && nin % o.hold_out == o.hold_out - 1;
        if inlier {
            nin += 1;
            let q = pairs[k];
            let a = affine;
            let p = [a[0] + a[1] * q.0[0] + a[2] * q.0[1], a[3] + a[4] * q.0[0] + a[5] * q.0[1]];
            ss += (p[0] - q.1[0]).powi(2) + (p[1] - q.1[1]).powi(2);
        }
        matches.push(Match { e, n, z, de: r.0 * g.cell, dn: -r.1 * g.cell, x, y, peak: r.2, ratio: r.3, ncc: r.4, source: *src, inlier, check });
    }
    // An affine through three points always fits them: a consensus needs more than its own minimum.
    if nin < MIN_INLIERS {
        return Err(gw_abi::err!(INVALID, "only {n} consistent matches (at least {min} are needed): the image and the cloud do not match well enough", n = nin, min = MIN_INLIERS));
    }
    Ok(RegOut { matches, coarse: (cx * g.cell, -cy * g.cell), sun_az, tiles, accepted, inliers: nin, affine, rms_m: (ss / nin as f64).sqrt() })
}

/// Fewest RANSAC inliers a registration accepts.
pub const MIN_INLIERS: usize = 6;

#[cfg(test)]
mod tests {
    use super::*;
    use gw_sensor::geotransform::{GeoTransformModel, MapCrs};

    /// A local frame on UTM 13's central meridian (no grid convergence), scaled at its origin.
    fn test_frame() -> Frame {
        let (dlat, dlon) = gw_sensor::intersect::deg_per_metre(Ground { lat: 39.9, lon: -105.0, h: 0.0 });
        Frame { lat0: 39.9, lon0: -105.0, kx: 1.0 / dlon, ky: 1.0 / dlat }
    }

    /// A synthetic scene: terrain with ridges, and an "intensity" pattern of fields and roads.
    /// Periodic random field of side n (a power of two) with amplitude ∝ 1/(1 + |k|)^p.
    fn field(n: usize, p: f64, seed: u64) -> Vec<f64> {
        let mut s = seed | 1;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        let fr = |k: usize| if k > n / 2 { k as f64 - n as f64 } else { k as f64 };
        let (mut re, mut im) = (vec![0.0; n * n], vec![0.0; n * n]);
        for k in 0..n * n {
            let a = 1.0 / (1.0 + fr(k % n).hypot(fr(k / n))).powf(p);
            let ph = 2.0 * std::f64::consts::PI * rnd();
            re[k] = a * ph.cos();
            im[k] = a * ph.sin();
        }
        gw_match::phase::fft2(&mut re, &mut im, n, true);
        let sd = (re.iter().map(|v| v * v).sum::<f64>() / (n * n) as f64).sqrt();
        re.iter().map(|v| v / sd).collect()
    }

    /// A synthetic scene of side n: terrain (σ 15 m, smooth) and an intensity texture.
    fn terrain(w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
        let n = w.max(h).next_power_of_two();
        let (zf, tf) = (field(n, 2.2, 7), field(n, 1.0, 11));
        let mut z = vec![0f32; w * h];
        let mut it = vec![0f32; w * h];
        for j in 0..h {
            for i in 0..w {
                z[j * w + i] = (1600.0 + 15.0 * zf[j * n + i]) as f32;
                it[j * w + i] = (100.0 + 30.0 * tf[j * n + i]) as f32;
            }
        }
        (z, it)
    }

    #[test]
    fn hillshade_matches_the_gdaldem_formula() {
        // A plane rising 1 m per cell to the east, sun from the west (270°) at 45°: the slope faces
        // west, cos(incidence) = cos(45° − 45°)… computed independently below.
        let (w, h) = (5, 5);
        let z: Vec<f32> = (0..w * h).map(|k| (k % w) as f32).collect();
        let hs = hillshade(&z, w, h, 1.0, 270.0, 45.0);
        let slope = 1f64.atan(); // 45°
        // The surface normal points west-up; the sun is west at 45° elevation: incidence 0.
        let expect = (45f64.to_radians().sin() * slope.cos() + 45f64.to_radians().cos() * slope.sin()).min(1.0);
        assert!((f64::from(hs[2 * w + 2]) - expect).abs() < 1e-6, "{} {}", hs[2 * w + 2], expect);
        assert!(hs[0].is_nan());
        // Rows run south: a plane rising to the north faces south, lit by a southern sun (180°)
        // and dark under a northern one (gdaldem's sign; checked against gdaldem on corpus DSMs).
        let zn: Vec<f32> = (0..w * h).map(|k| -((k / w) as f32)).collect();
        assert!((f64::from(hillshade(&zn, w, h, 1.0, 180.0, 45.0)[2 * w + 2]) - 1.0).abs() < 1e-6);
        assert!(hillshade(&zn, w, h, 1.0, 0.0, 45.0)[2 * w + 2] < 1e-6);
    }

    #[test]
    fn ortho_lattice_matches_the_exact_model() {
        let (w, h) = (300, 260);
        let (z, _) = terrain(w, h);
        let frame = test_frame();
        let g = RefGrid { frame, e0: 0.0, n0: 0.0, cell: 0.5, w, h, dsm: &z, intensity: None };
        // An RPC-like 3-D model stand-in: a geotransform is 2-D, so check the lattice against it,
        // and the height interpolation with a model whose image x moves with height.
        struct Tilted(GeoTransformModel);
        impl SensorModel for Tilted {
            fn name(&self) -> &str {
                "tilted"
            }
            fn ground_to_image(&self, gr: Ground) -> gw_abi::Result<(f64, f64)> {
                let (x, y) = self.0.ground_to_image(gr)?;
                Ok((x + 0.3 * (gr.h - 1600.0), y - 0.1 * (gr.h - 1600.0)))
            }
            fn image_to_ground(&self, x: f64, y: f64, hh: f64) -> gw_abi::Result<Ground> {
                self.0.image_to_ground(x - 0.3 * (hh - 1600.0), y + 0.1 * (hh - 1600.0), hh)
            }
        }
        let gt = GeoTransformModel::new([477_000.0, 0.3, 0.0, 4_418_000.0, 0.0, -0.3], MapCrs::Utm { zone: 13, north: true }).unwrap();
        let m = Tilted(gt);
        // A chip whose value is its own x coordinate: the ortho value is then the image x.
        let (cw, ch) = (4000usize, 4000usize);
        let g0 = frame.ground(0.0, 0.0, 1600.0);
        let (x0, y0) = m.ground_to_image(g0).unwrap();
        let chip_px: Vec<f32> = (0..cw * ch).map(|k| (k % cw) as f32).collect();
        let chip = Chip { px: &chip_px, w: cw, h: ch, x0: x0 - 1000.0, y0: y0 - 1000.0, step: 1.0 };
        let o = ortho_on_grid(&m, &g, &chip, 16).unwrap();
        let mut worst = 0f64;
        for j in (0..h).step_by(7) {
            for i in (0..w).step_by(5) {
                let (e, n) = g.post(i as f64, j as f64);
                let (x, _) = m.ground_to_image(frame.ground(e, n, f64::from(z[j * w + i]))).unwrap();
                let want = (x - chip.x0) / chip.step - 0.5;
                worst = worst.max((f64::from(o[j * w + i]) - want).abs());
            }
        }
        assert!(worst < 0.01, "lattice error {worst} px");
    }

    /// Build a synthetic case: an ortho "image" made from the scene with a known ground offset.
    fn case(offset: (f64, f64)) -> (Vec<f32>, Vec<f32>, Frame, GeoTransformModel, Vec<f32>, (usize, usize, f64, f64)) {
        let (w, h) = (512, 512);
        let (z, it) = terrain(w, h);
        let frame = test_frame();
        // The true image: 0.5 m pixels on the cloud's own grid, content = intensity + hillshade mix.
        let hs = hillshade(&z, w, h, 0.5, 135.0, 50.0);
        let truth: Vec<f32> = (0..w * h).map(|k| if hs[k].is_finite() { 0.5 * it[k] + 80.0 * hs[k] } else { it[k] }).collect();
        // The image's model claims the content is `offset` (E, N metres) away from where it is.
        let g0 = frame.ground(0.0, 0.0, 0.0);
        let u = gw_geodesy::grids::utmups_forward(g0.lat, g0.lon, Some(13)).unwrap();
        // Pixel (0, 0) corner of the true image = post (−0.25, +0.25) m around post 0 (posts are centres).
        let gt = GeoTransformModel::new([u.easting - 0.25 + offset.0, 0.5, 0.0, u.northing + 0.25 + offset.1, 0.0, -0.5], MapCrs::Utm { zone: 13, north: true }).unwrap();
        (z, it, frame, gt, truth, (w, h, u.easting, u.northing))
    }

    #[test]
    fn recovers_a_known_offset_with_both_references() {
        for &off in &[(7.0, -4.0), (-18.0, 12.5), (25.0, 16.0)] {
            let (z, it, frame, gt, truth, (w, h, _, _)) = case(off);
            let g = RefGrid { frame, e0: 0.0, n0: 0.0, cell: 0.5, w, h, dsm: &z, intensity: Some(&it) };
            let chip = Chip { px: &truth, w, h, x0: 0.0, y0: 0.0, step: 1.0 };
            let o = RegOptions { max_offset_m: 40.0, ..RegOptions::default() };
            let r = register(&gt, &g, &chip, &o).unwrap();
            // The image places a cloud feature at cloud position + offset (the model's error).
            let inl: Vec<&Match> = r.matches.iter().filter(|m| m.inlier).collect();
            assert!(inl.len() >= 8, "{off:?}: {} inliers of {} ({} tiles)", inl.len(), r.matches.len(), r.tiles);
            let me = inl.iter().map(|m| m.de).sum::<f64>() / inl.len() as f64;
            let mn = inl.iter().map(|m| m.dn).sum::<f64>() / inl.len() as f64;
            // UTM vs the local frame: a scale and convergence of ~1e-3 over 256 m is ~0.3 m; the
            // offset itself is in UTM metres.
            assert!((me - off.0).abs() < 0.5 && (mn - off.1).abs() < 0.5, "{off:?}: mean shift ({me:.3}, {mn:.3}), coarse {:?}", r.coarse);
            assert!(inl.iter().any(|m| m.check));
        }
    }

    #[test]
    fn refuses_bad_inputs() {
        let (z, _, frame, gt, truth, (w, h, _, _)) = case((0.0, 0.0));
        let g = RefGrid { frame, e0: 0.0, n0: 0.0, cell: 0.5, w, h, dsm: &z, intensity: None };
        let chip = Chip { px: &truth, w, h, x0: 0.0, y0: 0.0, step: 1.0 };
        let o = RegOptions { reference: Reference::Intensity, ..RegOptions::default() };
        assert!(register(&gt, &g, &chip, &o).is_err(), "no intensity");
        let o = RegOptions { tile: 48, ..RegOptions::default() };
        assert!(register(&gt, &g, &chip, &o).is_err(), "tile not a power of two");
        let far = Chip { px: &truth, w, h, x0: 1e6, y0: 0.0, step: 1.0 };
        assert!(register(&gt, &g, &far, &RegOptions::default()).is_err(), "image off the grid");
    }
}

