//! CPU multi-view stereo: depth and normal maps for COLMAP's `stereo_fusion`.
//!
//! PatchMatch stereo with slanted planes (Bleyer 2011; Galliani 2015 for the red-black schedule),
//! coarse to fine, written for this project. One hypothesis is a depth and a normal at a pixel. It
//! is scored by bilateral-weighted normalised cross-correlation of the reference window against
//! each source view through the plane's homography; the score is the mean of the better half of
//! the views, so an occluded view does not count. A pixel keeps its hypothesis only if neighbouring
//! views agree on the same surface (the geometric check), which is what makes the result usable.
//!
//! Coordinates: continuous image coordinates with pixel i covering [i, i + 1), COLMAP's sparse
//! convention. `stereo_fusion` reads pixel i as ray i, half a pixel off that, so the fused cloud
//! would carry a shift of half a depth-map pixel, so `to_fusion_grid` resamples the maps it writes.

use crate::colmap::{pinhole, read_map, read_model, rotation, write_map, Model};
use crate::geo::{dot, mat_mul, mat_vec, sub, transpose, M3, V3};
use crate::{progress, Res};
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub struct Options {
    /// Longest side of a depth map, in pixels.
    pub max_size: usize,
    /// Source views per reference view.
    pub views: usize,
    /// Pyramid levels above the finest.
    pub levels: usize,
    /// Red-black passes at the finest level (coarser levels take twice as many).
    pub iterations: usize,
    /// Lowest accepted normalised cross-correlation.
    pub min_ncc: f32,
    /// How many neighbouring views must confirm a pixel.
    pub min_agree: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_size: 1600, views: 6, levels: 2, iterations: 3, min_ncc: 0.5, min_agree: 2 }
    }
}

const SAMPLES: usize = 36;
const OFFS: [f32; 6] = [-5.0, -3.0, -1.0, 1.0, 3.0, 5.0];
const RADIUS: usize = 6;
/// Weighted variance of a window below this has no texture to match (grey levels 0..1).
const MIN_VARIANCE: f32 = 2e-5;
const NO_MATCH: f32 = 2.0;

#[derive(Clone, Debug)]
pub struct View {
    pub name: String,
    pub k: [f32; 4],
    pub r: M3,
    pub t: V3,
    pub w: usize,
    pub h: usize,
}

impl View {
    /// The same camera on a grid 2^level coarser.
    fn at(&self, level: usize) -> View {
        let s = (1usize << level) as f32;
        View { name: self.name.clone(), k: self.k.map(|v| v / s), r: self.r, t: self.t, w: self.w >> level, h: self.h >> level }
    }
    fn ray(&self, x: f32, y: f32) -> [f32; 3] {
        [(x + 0.5 - self.k[2]) / self.k[0], (y + 0.5 - self.k[3]) / self.k[1], 1.0]
    }
}

/// One grey image and its coarser copies; `g[l]` is 2^l smaller.
pub struct Pyramid {
    pub g: Vec<Vec<f32>>,
}

pub fn pyramid(base: Vec<f32>, w: usize, h: usize, levels: usize) -> Pyramid {
    let mut g = vec![base];
    let (mut cw, mut ch) = (w, h);
    for l in 0..levels {
        let (nw, nh) = (cw >> 1, ch >> 1);
        let src = &g[l];
        let mut out = vec![0f32; nw * nh];
        out.par_chunks_mut(nw.max(1)).enumerate().for_each(|(y, row)| {
            for (x, v) in row.iter_mut().enumerate() {
                let (i, j) = (y * 2 * cw + x * 2, (y * 2 + 1) * cw + x * 2);
                *v = (src[i] + src[i + 1] + src[j] + src[j + 1]) * 0.25;
            }
        });
        g.push(out);
        (cw, ch) = (nw, nh);
    }
    Pyramid { g }
}

#[inline]
fn bilinear(g: &[f32], w: usize, h: usize, x: f32, y: f32) -> Option<f32> {
    // Continuous coordinates: pixel centres at i + 0.5.
    let (fx, fy) = (x - 0.5, y - 0.5);
    if fx < 0.0 || fy < 0.0 {
        return None;
    }
    let (ix, iy) = (fx as usize, fy as usize);
    if ix + 1 >= w || iy + 1 >= h {
        return None;
    }
    let (ax, ay) = (fx - ix as f32, fy - iy as f32);
    let i = iy * w + ix;
    let (a, b, c, d) = (g[i], g[i + 1], g[i + w], g[i + w + 1]);
    Some(a + (b - a) * ax + (c - a) * ay + (a - b - c + d) * ax * ay)
}

struct Xorshift(u32);
impl Xorshift {
    fn seed(a: usize, b: usize, c: usize) -> Xorshift {
        let mut s = (a as u32).wrapping_mul(0x9E37_79B1) ^ (b as u32).wrapping_mul(0x85EB_CA77) ^ (c as u32).wrapping_mul(0xC2B2_AE3D);
        if s == 0 {
            s = 0x1234_5678;
        }
        Xorshift(s)
    }
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn unit(&mut self) -> f32 {
        (self.next() >> 8) as f32 / (1u32 << 24) as f32
    }
    fn signed(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

#[inline]
fn fdot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn normalise(v: [f32; 3]) -> [f32; 3] {
    let n = fdot(v, v).sqrt().max(1e-9);
    [v[0] / n, v[1] / n, v[2] / n]
}

/// K_s R K_r^-1 and K_s t for one reference and source.
struct Pair<'a> {
    a: [[f32; 3]; 3],
    b: [f32; 3],
    g: &'a [f32],
    w: usize,
    h: usize,
}

fn relative(rf: &View, src: &View) -> (M3, V3) {
    let rt = transpose(&rf.r);
    let r = mat_mul(&src.r, &rt);
    let t = sub(src.t, mat_vec(&r, rf.t));
    (r, t)
}

fn pair<'a>(rf: &View, src: &View, g: &'a [f32]) -> Pair<'a> {
    let (r, t) = relative(rf, src);
    let [fx, fy, cx, cy] = src.k.map(|v| v as f64);
    let ki: M3 = {
        let [rx, ry, rcx, rcy] = rf.k.map(|v| v as f64);
        [[1.0 / rx, 0.0, -rcx / rx], [0.0, 1.0 / ry, -rcy / ry], [0.0, 0.0, 1.0]]
    };
    let ks: M3 = [[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]];
    let m = mat_mul(&mat_mul(&ks, &r), &ki);
    let b = mat_vec(&ks, t);
    Pair { a: m.map(|r| r.map(|v| v as f32)), b: b.map(|v| v as f32), g, w: src.w, h: src.h }
}

/// A reference window: intensities less their weighted mean, and bilateral weights.
struct Patch {
    a: [f32; SAMPLES],
    wt: [f32; SAMPLES],
    var: f32,
}

fn patch(g: &[f32], w: usize, x: usize, y: usize) -> Patch {
    let c = g[y * w + x];
    let mut a = [0f32; SAMPLES];
    let mut wt = [0f32; SAMPLES];
    let mut k = 0;
    let (mut sum, mut mean) = (0f32, 0f32);
    for dy in OFFS {
        for dx in OFFS {
            let (ix, iy) = (x as isize + dx as isize, y as isize + dy as isize);
            let v = g[iy as usize * w + ix as usize];
            let d = v - c;
            let wgt = (-(d * d) / 0.02).exp() * (-(dx * dx + dy * dy) / 40.0).exp();
            a[k] = v;
            wt[k] = wgt;
            sum += wgt;
            mean += wgt * v;
            k += 1;
        }
    }
    let sum = sum.max(1e-9);
    mean /= sum;
    let mut var = 0.0;
    for k in 0..SAMPLES {
        wt[k] /= sum;
        a[k] -= mean;
        var += wt[k] * a[k] * a[k];
    }
    Patch { a, wt, var }
}

#[inline]
fn view_cost(p: &Patch, x: f32, y: f32, c: [f32; 3], s: &Pair) -> f32 {
    // H = A + b c^T.
    let h = [
        [s.a[0][0] + s.b[0] * c[0], s.a[0][1] + s.b[0] * c[1], s.a[0][2] + s.b[0] * c[2]],
        [s.a[1][0] + s.b[1] * c[0], s.a[1][1] + s.b[1] * c[1], s.a[1][2] + s.b[1] * c[2]],
        [s.a[2][0] + s.b[2] * c[0], s.a[2][1] + s.b[2] * c[1], s.a[2][2] + s.b[2] * c[2]],
    ];
    let (mut sm, mut sq, mut cr) = (0f32, 0f32, 0f32);
    let mut k = 0;
    for dy in OFFS {
        let py = y + dy;
        for dx in OFFS {
            let px = x + dx;
            let q2 = h[2][0] * px + h[2][1] * py + h[2][2];
            if q2 <= 1e-6 {
                return NO_MATCH;
            }
            let u = (h[0][0] * px + h[0][1] * py + h[0][2]) / q2;
            let v = (h[1][0] * px + h[1][1] * py + h[1][2]) / q2;
            let Some(b) = bilinear(s.g, s.w, s.h, u, v) else { return NO_MATCH };
            let wt = p.wt[k];
            sm += wt * b;
            sq += wt * b * b;
            cr += wt * p.a[k] * b;
            k += 1;
        }
    }
    let vb = sq - sm * sm;
    if vb < MIN_VARIANCE {
        return NO_MATCH;
    }
    let ncc = cr / (p.var * vb).sqrt();
    (1.0 - ncc).clamp(0.0, NO_MATCH)
}

/// The score of a hypothesis: the mean cost of the better half of the views that see the point. A
/// view that cannot see it says nothing about it: counted as a failed match, it would drag every
/// pixel near the edge of its coverage over the threshold.
#[inline]
fn score(p: &Patch, cx: f32, cy: f32, ray: [f32; 3], rki: &[[f32; 3]; 3], d: f32, n: [f32; 3], pairs: &[Pair]) -> f32 {
    // The plane n . X = rho through the point at depth d on this pixel's ray.
    let rho = d * fdot(n, ray);
    if rho >= -1e-6 {
        return NO_MATCH; // facing away
    }
    // c = K_r^-T n / rho.
    let c = [fdot([rki[0][0], rki[1][0], rki[2][0]], n) / rho, fdot([rki[0][1], rki[1][1], rki[2][1]], n) / rho, fdot([rki[0][2], rki[1][2], rki[2][2]], n) / rho];
    let mut best = [NO_MATCH; 12];
    let mut m = 0;
    for s in pairs.iter().take(12) {
        let cost = view_cost(p, cx, cy, c, s);
        if cost < NO_MATCH {
            best[m] = cost;
            m += 1;
        }
    }
    if m < 2 {
        return NO_MATCH; // one view against the reference matches too much by chance
    }
    let b = &mut best[..m];
    b.sort_unstable_by(f32::total_cmp);
    let keep = (m / 2).max(2);
    b[..keep].iter().sum::<f32>() / keep as f32
}

/// Per-pixel state.
pub struct State {
    pub d: Vec<f32>,
    pub n: Vec<[f32; 3]>,
    pub c: Vec<f32>,
}

struct Ctx<'a> {
    w: usize,
    h: usize,
    g: &'a [f32],
    view: View,
    ki: [[f32; 3]; 3],
    pairs: Vec<Pair<'a>>,
    dmin: f32,
    dmax: f32,
}

fn random_hypothesis(r: &mut Xorshift, ray: [f32; 3], dmin: f32, dmax: f32) -> (f32, [f32; 3]) {
    let d = 1.0 / (1.0 / dmax + r.unit() * (1.0 / dmin - 1.0 / dmax));
    let t = normalise(ray);
    let n = normalise([-t[0] + r.signed() * 0.5, -t[1] + r.signed() * 0.5, -t[2] + r.signed() * 0.5]);
    (d, n)
}

fn sweep(ctx: &Ctx, st: &mut State, color: usize, iter: usize, spread: f32, explore: bool, seed: usize) {
    let (w, h) = (ctx.w, ctx.h);
    const NB: [(isize, isize); 8] = [(-1, 0), (1, 0), (0, -1), (0, 1), (-3, 0), (3, 0), (0, -3), (0, 3)];
    let updates: Vec<Vec<(usize, f32, [f32; 3], f32)>> = (RADIUS..h.saturating_sub(RADIUS))
        .into_par_iter()
        .map(|y| {
            let mut out = Vec::with_capacity(w / 2);
            let mut r = Xorshift::seed(seed, y * 2 + color, iter + 1);
            let start = RADIUS + ((RADIUS + y + color) & 1);
            for x in (start..w.saturating_sub(RADIUS)).step_by(2) {
                let i = y * w + x;
                let p = patch(ctx.g, w, x, y);
                if p.var < MIN_VARIANCE {
                    continue;
                }
                let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
                let ray = ctx.view.ray(x as f32, y as f32);
                let (mut bd, mut bn, mut bc) = (st.d[i], st.n[i], st.c[i]);
                let try_it = |d: f32, n: [f32; 3], bd: &mut f32, bn: &mut [f32; 3], bc: &mut f32| {
                    if d < ctx.dmin || d > ctx.dmax {
                        return;
                    }
                    let c = score(&p, cx, cy, ray, &ctx.ki, d, n, &ctx.pairs);
                    if c < *bc {
                        (*bd, *bn, *bc) = (d, n, c);
                    }
                };
                for (dx, dy) in NB {
                    let (nx, ny) = (x as isize + dx, y as isize + dy);
                    if nx < 0 || ny < 0 || nx >= w as isize || ny >= h as isize {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if st.c[j] >= NO_MATCH {
                        continue;
                    }
                    // The neighbour's plane, at this pixel's ray.
                    let (dn, nn) = (st.d[j], st.n[j]);
                    let rho = dn * fdot(nn, ctx.view.ray(nx as f32, ny as f32));
                    let den = fdot(nn, ray);
                    if den < -1e-6 {
                        try_it(rho / den, nn, &mut bd, &mut bn, &mut bc);
                    }
                }
                let (d0, n0) = (bd, bn);
                let d1 = d0 * (1.0 + spread * r.signed());
                let n1 = normalise([n0[0] + spread * 3.0 * r.signed(), n0[1] + spread * 3.0 * r.signed(), n0[2] + spread * 3.0 * r.signed()]);
                try_it(d1, n0, &mut bd, &mut bn, &mut bc);
                try_it(d0, n1, &mut bd, &mut bn, &mut bc);
                try_it(d1, n1, &mut bd, &mut bn, &mut bc);
                if explore {
                    let (d2, n2) = random_hypothesis(&mut r, ray, ctx.dmin, ctx.dmax);
                    try_it(d2, n2, &mut bd, &mut bn, &mut bc);
                    try_it(d0, n2, &mut bd, &mut bn, &mut bc);
                }
                if bc < st.c[i] {
                    out.push((i, bd, bn, bc));
                }
            }
            out
        })
        .collect();
    for row in updates {
        for (i, d, n, c) in row {
            st.d[i] = d;
            st.n[i] = n;
            st.c[i] = c;
        }
    }
}

fn rescore(ctx: &Ctx, st: &mut State) {
    let (w, h) = (ctx.w, ctx.h);
    let (d, n) = (&st.d, &st.n);
    st.c.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        if y < RADIUS || y + RADIUS >= h {
            return;
        }
        for (x, c) in row.iter_mut().enumerate().take(w.saturating_sub(RADIUS)).skip(RADIUS) {
            let p = patch(ctx.g, w, x, y);
            let i = y * w + x;
            *c = if p.var < MIN_VARIANCE { NO_MATCH } else { score(&p, x as f32 + 0.5, y as f32 + 0.5, ctx.view.ray(x as f32, y as f32), &ctx.ki, d[i], n[i], &ctx.pairs) };
        }
    });
}

/// Solve one reference view. `pyr` and `srcs` hold the pyramids; returns depth, normals and cost at
/// the finest level, unfiltered.
pub fn solve(rf: &View, pyr: &Pyramid, srcs: &[(&View, &Pyramid)], dmin: f32, dmax: f32, o: &Options, seed: usize) -> State {
    let levels = pyr.g.len();
    let mut st: Option<State> = None;
    for l in (0..levels).rev() {
        let view = rf.at(l);
        let (w, h) = (view.w, view.h);
        let [fx, fy, cx, cy] = view.k;
        let ki = [[1.0 / fx, 0.0, -cx / fx], [0.0, 1.0 / fy, -cy / fy], [0.0, 0.0, 1.0]];
        let pairs: Vec<Pair> = srcs.iter().map(|(v, p)| pair(&view, &v.at(l), &p.g[l])).collect();
        let ctx = Ctx { w, h, g: &pyr.g[l], view: view.clone(), ki, pairs, dmin, dmax };
        let mut s = match st.take() {
            None => {
                let mut r = Xorshift::seed(seed, l, 7);
                let mut d = vec![0f32; w * h];
                let mut n = vec![[0f32, 0.0, -1.0]; w * h];
                for y in 0..h {
                    for x in 0..w {
                        let (a, b) = random_hypothesis(&mut r, view.ray(x as f32, y as f32), dmin, dmax);
                        d[y * w + x] = a;
                        n[y * w + x] = b;
                    }
                }
                State { d, n, c: vec![NO_MATCH; w * h] }
            }
            Some(prev) => {
                let (pw, ph) = (w >> 1, h >> 1);
                let mut d = vec![0f32; w * h];
                let mut n = vec![[0f32, 0.0, -1.0]; w * h];
                for y in 0..h {
                    for x in 0..w {
                        let j = (y >> 1).min(ph - 1) * pw + (x >> 1).min(pw - 1);
                        d[y * w + x] = prev.d[j];
                        n[y * w + x] = prev.n[j];
                    }
                }
                State { d, n, c: vec![NO_MATCH; w * h] }
            }
        };
        rescore(&ctx, &mut s);
        let passes = if l == 0 { o.iterations } else { o.iterations * 2 };
        for it in 0..passes {
            // Relative depth step: about a pixel of parallax at this level to begin with, halving
            // each pass down to a tenth of that, so the finest passes refine below a pixel.
            let spread = 0.02 * (1usize << l) as f32 * 0.5f32.powi(it as i32).max(0.1);
            let explore = l + 1 == levels || it == 0;
            sweep(&ctx, &mut s, 0, it * 2 + l * 100, spread, explore, seed);
            sweep(&ctx, &mut s, 1, it * 2 + 1 + l * 100, spread, explore, seed);
        }
        st = Some(s);
    }
    st.expect("at least one level")
}

/// Source views and the depth range of one image, from the sparse model.
pub struct Plan {
    pub sources: Vec<usize>,
    pub dmin: f32,
    pub dmax: f32,
}

/// How many sources each part of the reference image should get.
const WANT: u8 = 3;
const CELLS: (usize, usize) = (8, 6);

/// Choose sources so that the whole reference image is seen, not just its best-connected side. Each
/// pick is the view that adds most to the cells still short of `WANT` sources, with the shared
/// score breaking ties. The best-scoring views alone can all lie on one side of the reference: they
/// left 40 % of a synthetic block's depth maps empty, and a whole roof with them.
fn choose_sources(candidates: &[(usize, f64, u64)], views: usize) -> Vec<usize> {
    let mut left = [WANT; 64];
    let mut pool = candidates.to_vec();
    let mut out = Vec::new();
    while out.len() < views && !pool.is_empty() {
        let gain = |mask: u64| (0..64).filter(|b| mask >> b & 1 == 1 && left[*b] > 0).count();
        let best = (0..pool.len()).max_by(|a, b| gain(pool[*a].2).cmp(&gain(pool[*b].2)).then(pool[*a].1.total_cmp(&pool[*b].1)).then(pool[*b].0.cmp(&pool[*a].0))).unwrap_or(0);
        let (id, _, mask) = pool.swap_remove(best);
        for (b, l) in left.iter_mut().enumerate() {
            if mask >> b & 1 == 1 {
                *l = l.saturating_sub(1);
            }
        }
        out.push(id);
    }
    out
}

pub fn plan(m: &Model, views: usize) -> Vec<Option<Plan>> {
    let index: HashMap<u32, usize> = m.images.iter().enumerate().map(|(i, v)| (v.id, i)).collect();
    let centres: Vec<V3> = m.images.iter().map(crate::colmap::centre).collect();
    let mut shared: Vec<HashMap<usize, (f64, u64)>> = vec![HashMap::new(); m.images.len()];
    let geometry: Vec<Option<(M3, V3, [f64; 4], f64, f64)>> = m
        .images
        .iter()
        .map(|im| {
            let c = m.cameras.get(&im.camera)?;
            Some((rotation(im), im.t, pinhole(c).ok()?, c.width as f64, c.height as f64))
        })
        .collect();
    // The coverage cell of a world point in view i, as a bit.
    let cell = |i: usize, x: V3| -> u64 {
        let Some((r, t, k, w, h)) = &geometry[i] else { return 0 };
        let q = crate::geo::add(mat_vec(r, x), *t);
        if q[2] <= 0.0 {
            return 0;
        }
        let (u, v) = ((k[0] * q[0] / q[2] + k[2]) / w, (k[1] * q[1] / q[2] + k[3]) / h);
        if !(0.0..1.0).contains(&u) || !(0.0..1.0).contains(&v) {
            return 0;
        }
        1 << ((v * CELLS.1 as f64) as usize * CELLS.0 + (u * CELLS.0 as f64) as usize)
    };
    for p in m.points.values() {
        let ids: Vec<usize> = p.track.iter().filter_map(|t| index.get(t).copied()).collect();
        for (a, &i) in ids.iter().enumerate() {
            for &j in ids.iter().skip(a + 1) {
                if i == j {
                    continue;
                }
                let (u, v) = (sub(centres[i], p.xyz), sub(centres[j], p.xyz));
                let cos = dot(u, v) / (dot(u, u) * dot(v, v)).sqrt().max(1e-12);
                let angle = cos.clamp(-1.0, 1.0).acos().to_degrees();
                if angle < 1.0 {
                    continue;
                }
                let weight = (angle / 5.0).min(1.0).powi(2);
                let e = shared[i].entry(j).or_default();
                e.0 += weight;
                e.1 |= cell(i, p.xyz);
                let e = shared[j].entry(i).or_default();
                e.0 += weight;
                e.1 |= cell(j, p.xyz);
            }
        }
    }
    m.images
        .iter()
        .enumerate()
        .map(|(i, im)| {
            let r = rotation(im);
            let mut depths: Vec<f64> = im.points.iter().filter_map(|id| m.points.get(id)).map(|p| crate::geo::add(mat_vec(&r, p.xyz), im.t)[2]).filter(|z| *z > 0.0).collect();
            if depths.len() < 10 {
                return None;
            }
            depths.sort_by(f64::total_cmp);
            let at = |q: f64| depths[((depths.len() - 1) as f64 * q) as usize];
            let mut s: Vec<(usize, f64, u64)> = shared[i].iter().map(|(a, b)| (*a, b.0, b.1)).collect();
            s.sort_by_key(|x| x.0);
            let sources = choose_sources(&s, views);
            if sources.len() < 2 {
                return None;
            }
            Some(Plan { sources, dmin: (at(0.01) * 0.75) as f32, dmax: (at(0.99) * 1.25) as f32 })
        })
        .collect()
}

fn load_grey(path: &Path, w: usize, h: usize) -> Res<Vec<f32>> {
    let img = image::open(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let g = img.to_luma8();
    let g = if g.width() as usize == w && g.height() as usize == h { g } else { image::imageops::resize(&g, w as u32, h as u32, image::imageops::FilterType::Triangle) };
    Ok(g.as_raw().iter().map(|v| *v as f32 / 255.0).collect())
}

fn stereo_dirs(ws: &Path) -> Res<(PathBuf, PathBuf)> {
    let (d, n) = (ws.join("stereo").join("depth_maps"), ws.join("stereo").join("normal_maps"));
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&n).map_err(|e| e.to_string())?;
    Ok((d, n))
}

fn map_name(image: &str, kind: &str) -> String {
    format!("{image}.{kind}.bin")
}

/// All views of a workspace at depth-map scale.
pub fn views_of(m: &Model, max_size: usize) -> Res<Vec<View>> {
    m.images
        .iter()
        .map(|im| {
            let c = m.cameras.get(&im.camera).ok_or_else(|| format!("{} has no camera", im.name))?;
            let k = pinhole(c)?;
            let (w0, h0) = (c.width as usize, c.height as usize);
            let s = (max_size as f64 / w0.max(h0) as f64).min(1.0);
            let (w, h) = (((w0 as f64 * s).round() as usize).max(1), ((h0 as f64 * s).round() as usize).max(1));
            let (sx, sy) = (w as f64 / w0 as f64, h as f64 / h0 as f64);
            Ok(View { name: im.name.clone(), k: [(k[0] * sx) as f32, (k[1] * sy) as f32, (k[2] * sx) as f32, (k[3] * sy) as f32], r: rotation(im), t: im.t, w, h })
        })
        .collect()
}

/// Keep what a pixel's neighbours confirm; zero the rest.
pub fn agree(view: &View, depth: &mut [f32], others: &[(&View, &[f32])], min_agree: usize) -> usize {
    let (w, h) = (view.w, view.h);
    debug_assert_eq!(depth.len(), w * h);
    let rel: Vec<_> = others.iter().map(|(v, d)| (relative(view, v), transpose(&relative(view, v).0), *v, *d)).collect();
    let keep: Vec<bool> = depth
        .par_iter()
        .enumerate()
        .map(|(i, &d)| {
            if d <= 0.0 {
                return false;
            }
            let (x, y) = (i % w, i / w);
            let ray = view.ray(x as f32, y as f32);
            let p = [ray[0] as f64 * d as f64, ray[1] as f64 * d as f64, ray[2] as f64 * d as f64];
            let mut ok = 0;
            for ((r, t), ri, v, dm) in &rel {
                let q = crate::geo::add(mat_vec(r, p), *t);
                if q[2] <= 0.0 {
                    continue;
                }
                let (u, w2) = (v.k[0] as f64 * q[0] / q[2] + v.k[2] as f64, v.k[1] as f64 * q[1] / q[2] + v.k[3] as f64);
                if u < 0.0 || w2 < 0.0 {
                    continue;
                }
                let (iu, iv) = (u as usize, w2 as usize);
                if iu >= v.w || iv >= v.h {
                    continue;
                }
                let dj = dm[iv * v.w + iu] as f64;
                if dj <= 0.0 || (dj - q[2]).abs() / q[2] > 0.01 {
                    continue;
                }
                // Back through the neighbour's own depth: is it the same point?
                let rj = v.ray(iu as f32, iv as f32);
                let back = mat_vec(ri, sub([rj[0] as f64 * dj, rj[1] as f64 * dj, rj[2] as f64 * dj], *t));
                if back[2] <= 0.0 {
                    continue;
                }
                let (bu, bv) = (view.k[0] as f64 * back[0] / back[2] + view.k[2] as f64, view.k[1] as f64 * back[1] / back[2] + view.k[3] as f64);
                let (e0, e1) = (bu - (x as f64 + 0.5), bv - (y as f64 + 0.5));
                if e0 * e0 + e1 * e1 <= 2.25 {
                    ok += 1;
                    if ok >= min_agree {
                        return true;
                    }
                }
            }
            false
        })
        .collect();
    let mut n = 0;
    for (d, k) in depth.iter_mut().zip(keep) {
        if k {
            n += 1;
        } else {
            *d = 0.0;
        }
    }
    n
}

/// Put maps on the grid `stereo_fusion` reads. It takes map pixel (x, y) as the ray through image
/// point (x, y), a pixel corner, while the maps here hold the ray through the pixel's centre, so
/// the fused cloud would sit half a depth-map pixel off. Each value becomes the surface at that
/// corner: the mean of the (up to four) pixels around it that agree within 1 %.
pub fn to_fusion_grid(depth: &[f32], normal: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    let mut d = vec![0f32; w * h];
    let mut n = vec![0f32; w * h * 3];
    for y in 0..h {
        for x in 0..w {
            let mut around = [(0f32, 0usize); 4];
            let mut k = 0;
            for (a, b) in [(x, y), (x.wrapping_sub(1), y), (x, y.wrapping_sub(1)), (x.wrapping_sub(1), y.wrapping_sub(1))] {
                if a < w && b < h && depth[b * w + a] > 0.0 {
                    around[k] = (depth[b * w + a], b * w + a);
                    k += 1;
                }
            }
            if k == 0 {
                continue;
            }
            let mut sorted = around;
            sorted[..k].sort_unstable_by(|p, q| p.0.total_cmp(&q.0));
            let mid = sorted[k / 2].0;
            let (mut sum, mut m, mut v) = (0f32, 0f32, [0f32; 3]);
            for (dv, i) in &around[..k] {
                if (dv - mid).abs() <= mid * 0.01 {
                    sum += dv;
                    m += 1.0;
                    for (c, t) in v.iter_mut().enumerate() {
                        *t += normal[c * w * h + i];
                    }
                }
            }
            let at = y * w + x;
            d[at] = sum / m;
            let unit = normalise(v);
            for c in 0..3 {
                n[c * w * h + at] = unit[c];
            }
        }
    }
    (d, n)
}

/// The dense stage over a workspace made by `colmap image_undistorter`.
pub fn run(ws: &Path, o: &Options) -> Res<serde_json::Value> {
    let m = read_model(&ws.join("sparse"))?;
    let views = views_of(&m, o.max_size)?;
    let plans = plan(&m, o.views);
    let usable = plans.iter().filter(|p| p.is_some()).count();
    if usable == 0 {
        return Err("no photograph shares enough points with its neighbours for dense matching".into());
    }
    let (dep, nor) = stereo_dirs(ws)?;
    let images = ws.join("images");
    let levels = (0..=o.levels).take_while(|l| views.iter().all(|v| (v.w >> l) > 2 * RADIUS + 2 && (v.h >> l) > 2 * RADIUS + 2)).count().max(1) - 1;
    // Photometric pass. Neighbouring images stay loaded: most sources of the next view are shared.
    let mut cache: HashMap<usize, Arc<Pyramid>> = HashMap::new();
    let mut done = 0usize;
    let total = usable * 2;
    for (i, p) in plans.iter().enumerate() {
        let Some(p) = p else { continue };
        let need: Vec<usize> = std::iter::once(i).chain(p.sources.iter().copied()).collect();
        cache.retain(|k, _| need.contains(k) || cache_keep(*k, i));
        let missing: Vec<usize> = need.iter().copied().filter(|k| !cache.contains_key(k)).collect();
        let loaded: Vec<Res<(usize, Pyramid)>> = missing
            .par_iter()
            .map(|&k| {
                let g = load_grey(&images.join(&views[k].name), views[k].w, views[k].h)?;
                Ok((k, pyramid(g, views[k].w, views[k].h, levels)))
            })
            .collect();
        for l in loaded {
            let (k, py) = l?;
            cache.insert(k, Arc::new(py));
        }
        let rf = cache[&i].clone();
        let srcs: Vec<(usize, Arc<Pyramid>)> = p.sources.iter().map(|k| (*k, cache[k].clone())).collect();
        let list: Vec<(&View, &Pyramid)> = srcs.iter().map(|(k, a)| (&views[*k], a.as_ref())).collect();
        let st = solve(&views[i], &rf, &list, p.dmin, p.dmax, o, i);
        let (w, h) = (views[i].w, views[i].h);
        let limit = 1.0 - o.min_ncc;
        let depth: Vec<f32> = st.d.iter().zip(&st.c).map(|(d, c)| if *c <= limit { *d } else { 0.0 }).collect();
        write_map(&dep.join(map_name(&views[i].name, "photometric")), w, h, 1, &depth)?;
        let mut normal = vec![0f32; w * h * 3];
        for (j, n) in st.n.iter().enumerate() {
            for c in 0..3 {
                normal[c * w * h + j] = if depth[j] > 0.0 { n[c] } else { 0.0 };
            }
        }
        write_map(&nor.join(map_name(&views[i].name, "photometric")), w, h, 3, &normal)?;
        done += 1;
        progress(done as f64 / total as f64);
    }
    drop(cache);
    // Geometric pass.
    let mut maps: HashMap<usize, Arc<Vec<f32>>> = HashMap::new();
    let mut kept = 0u64;
    let mut pixels = 0u64;
    for (i, p) in plans.iter().enumerate() {
        let Some(p) = p else { continue };
        let need: Vec<usize> = std::iter::once(i).chain(p.sources.iter().copied()).collect();
        maps.retain(|k, _| need.contains(k) || cache_keep(*k, i));
        for &k in &need {
            if let std::collections::hash_map::Entry::Vacant(e) = maps.entry(k) {
                // A view with no plan has no map; its pixels simply cannot confirm.
                let path = dep.join(map_name(&views[k].name, "photometric"));
                let d = if path.exists() { read_map(&path)?.3 } else { vec![0f32; views[k].w * views[k].h] };
                e.insert(Arc::new(d));
            }
        }
        let mut depth = maps[&i].as_ref().clone();
        let others: Vec<(&View, &[f32])> = p.sources.iter().map(|k| (&views[*k], maps[k].as_slice())).collect();
        let good = agree(&views[i], &mut depth, &others, o.min_agree.min(p.sources.len()));
        kept += good as u64;
        pixels += depth.len() as u64;
        let (w, h) = (views[i].w, views[i].h);
        let (_, _, _, n) = read_map(&nor.join(map_name(&views[i].name, "photometric")))?;
        let (fused_d, fused_n) = to_fusion_grid(&depth, &n, w, h);
        write_map(&dep.join(map_name(&views[i].name, "geometric")), w, h, 1, &fused_d)?;
        write_map(&nor.join(map_name(&views[i].name, "geometric")), w, h, 3, &fused_n)?;
        done += 1;
        progress(done as f64 / total as f64);
    }
    for (i, p) in plans.iter().enumerate() {
        if p.is_some() {
            let _ = std::fs::remove_file(dep.join(map_name(&views[i].name, "photometric")));
            let _ = std::fs::remove_file(nor.join(map_name(&views[i].name, "photometric")));
        }
    }
    Ok(serde_json::json!({ "views": usable, "of": views.len(), "kept_fraction": kept as f64 / pixels.max(1) as f64, "max_size": o.max_size }))
}

/// Neighbouring acquisitions tend to share sources: keep a small window of them.
fn cache_keep(k: usize, i: usize) -> bool {
    k + 12 >= i && k <= i + 12
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured plane z = 100 + 0.1 x (with a raised box) seen from above by a line of cameras.
    fn scene(w: usize, h: usize) -> (Vec<View>, Vec<Vec<f32>>, Box<dyn Fn(f64, f64) -> f64 + Sync>) {
        let ground = |x: f64, y: f64| -> f64 { 100.0 + 0.1 * x + if x.abs() < 4.0 && y.abs() < 4.0 { -5.0 } else { 0.0 } };
        let tex = |x: f64, y: f64| -> f32 {
            let mut v = 0.5;
            let mut f = 0.5;
            let mut a = 0.25;
            for i in 0..4 {
                let p = i as f64;
                v += a * (((x * f + p * 1.3).sin() * (y * f * 1.1 + p * 0.7).cos()) as f32);
                f *= 1.9;
                a *= 0.7;
            }
            v.clamp(0.0, 1.0)
        };
        let fx = w as f64 * 1.2;
        let mut views = Vec::new();
        let mut imgs = Vec::new();
        for (cam, (ox, oy)) in [(0.0, 0.0), (6.0, 0.0), (-6.0, 0.0), (0.0, 6.0), (0.0, -6.0), (6.0, 6.0)].iter().enumerate() {
            // Camera above the origin looking along +Z (ground is at larger z), x right, y down.
            let r: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
            let t: V3 = [-*ox, -*oy, 0.0];
            let v = View { name: format!("c{cam}"), k: [fx as f32, fx as f32, w as f32 / 2.0, h as f32 / 2.0], r, t, w, h };
            let mut g = vec![0f32; w * h];
            for y in 0..h {
                for x in 0..w {
                    // March down the ray to the surface.
                    let (rx, ry) = ((x as f64 + 0.5 - w as f64 / 2.0) / fx, (y as f64 + 0.5 - h as f64 / 2.0) / fx);
                    let mut z = 100.0;
                    for _ in 0..30 {
                        z = ground(ox + rx * z, oy + ry * z);
                    }
                    g[y * w + x] = tex(ox + rx * z, oy + ry * z);
                }
            }
            views.push(v);
            imgs.push(g);
        }
        (views, imgs, Box::new(ground))
    }

    #[test]
    fn recovers_a_known_surface() {
        let (w, h) = (240, 180);
        let (views, imgs, ground) = scene(w, h);
        let pyr: Vec<Pyramid> = imgs.iter().map(|g| pyramid(g.clone(), w, h, 2)).collect();
        let srcs: Vec<(&View, &Pyramid)> = (1..views.len()).map(|i| (&views[i], &pyr[i])).collect();
        let o = Options::default();
        let st = solve(&views[0], &pyr[0], &srcs, 80.0, 130.0, &o, 1);
        let fx = views[0].k[0] as f64;
        let mut errs = Vec::new();
        for y in 20..h - 20 {
            for x in 20..w - 20 {
                let i = y * w + x;
                if st.c[i] > 0.5 {
                    continue;
                }
                let (rx, ry) = ((x as f64 + 0.5 - w as f64 / 2.0) / fx, (y as f64 + 0.5 - h as f64 / 2.0) / fx);
                let mut z = 100.0;
                for _ in 0..30 {
                    z = ground(rx * z, ry * z);
                }
                errs.push(st.d[i] as f64 - z);
            }
        }
        let area = ((w - 40) * (h - 40)) as f64;
        let share = errs.len() as f64 / area;
        let mut signed = errs.clone();
        signed.sort_by(f64::total_cmp);
        let bias = signed[signed.len() / 2];
        errs.iter_mut().for_each(|e| *e = e.abs());
        errs.sort_by(f64::total_cmp);
        let median = errs[errs.len() / 2];
        let p90 = errs[errs.len() * 9 / 10];
        // One pixel of parallax at the 6 m baseline is 100 * 100 / (6 * fx) = 0.58 m of depth.
        let msg = format!("share {share:.3} bias {bias:.4} median {median:.4} p90 {p90:.4}");
        eprintln!("{msg}");
        assert!(share > 0.85, "{msg}");
        assert!(bias.abs() < 0.02, "{msg}");
        assert!(median < 0.06, "{msg}");
        assert!(p90 < 0.3, "{msg}");
    }

    #[test]
    fn the_same_input_gives_the_same_map() {
        let (w, h) = (120, 90);
        let (views, imgs, _) = scene(w, h);
        let pyr: Vec<Pyramid> = imgs.iter().map(|g| pyramid(g.clone(), w, h, 1)).collect();
        let srcs: Vec<(&View, &Pyramid)> = (1..views.len()).map(|i| (&views[i], &pyr[i])).collect();
        let o = Options { levels: 1, iterations: 2, ..Options::default() };
        let a = solve(&views[0], &pyr[0], &srcs, 80.0, 130.0, &o, 3);
        let b = solve(&views[0], &pyr[0], &srcs, 80.0, 130.0, &o, 3);
        assert_eq!(a.d, b.d);
    }

    #[test]
    fn sources_cover_the_whole_reference_not_its_best_side() {
        let east = 0x0F0F_0F0F_0F0F_u64 << 4 & 0xF0F0_F0F0_F0F0; // the right half of the grid
        let west = 0x0F0F_0F0F_0F0F_u64; // the left half
        // Five strong sources all on the right, three weak ones on the left.
        let c = [(0, 900.0, east), (1, 880.0, east), (2, 860.0, east), (3, 840.0, east), (4, 820.0, east), (5, 40.0, west), (6, 30.0, west), (7, 20.0, west)];
        let got = choose_sources(&c, 6);
        assert_eq!(got.iter().filter(|i| **i >= 5).count(), 3, "{got:?}");
        assert_eq!(got.iter().filter(|i| **i < 5).count(), 3, "{got:?}");
        assert_eq!(choose_sources(&c, 6), got, "the same input gives the same sources");
        // With nothing to add, the score decides.
        let same = [(0, 1.0, west), (1, 3.0, west), (2, 2.0, west)];
        assert_eq!(choose_sources(&same, 2), vec![1, 2]);
        assert!(choose_sources(&[], 6).is_empty());
    }

    #[test]
    fn a_view_that_cannot_see_the_point_does_not_count_against_it() {
        let (w, h) = (200, 150);
        let (views, imgs, _) = scene(w, h);
        // One real source and one that sees the scene, plus four looking at nothing it can match.
        let pyr: Vec<Pyramid> = imgs.iter().map(|g| pyramid(g.clone(), w, h, 1)).collect();
        let blank = pyramid(vec![0.5f32; w * h], w, h, 1);
        let srcs: Vec<(&View, &Pyramid)> = vec![(&views[1], &pyr[1]), (&views[2], &pyr[2]), (&views[3], &blank), (&views[4], &blank), (&views[5], &blank)];
        let o = Options { levels: 1, iterations: 3, ..Options::default() };
        let st = solve(&views[0], &pyr[0], &srcs, 80.0, 130.0, &o, 2);
        let good = st.c.iter().filter(|c| **c < 0.5).count() as f64 / st.c.len() as f64;
        assert!(good > 0.6, "only {good} of the pixels matched with two good views of five");
    }

    #[test]
    fn the_fusion_grid_holds_the_surface_at_pixel_corners() {
        let (w, h) = (6, 5);
        // A plane rising 0.1 per pixel in x: pixel i holds its value at continuous i + 0.5.
        let depth: Vec<f32> = (0..w * h).map(|i| 50.0 + 0.1 * (i % w) as f32).collect();
        let mut normal = vec![0f32; w * h * 3];
        normal[2 * w * h..].fill(-1.0);
        let (d, n) = to_fusion_grid(&depth, &normal, w, h);
        for x in 1..w {
            assert!((d[2 * w + x] - (50.0 + 0.1 * (x as f32 - 0.5))).abs() < 1e-4, "{x}: {}", d[2 * w + x]);
        }
        assert_eq!(n[2 * w * h + 2 * w + 2], -1.0);
        // A pixel beside a step takes one side of it, not a surface in the air.
        let step: Vec<f32> = (0..w * h).map(|i| if i % w >= 3 { 80.0 } else { 50.0 }).collect();
        let (d, _) = to_fusion_grid(&step, &normal, w, h);
        assert!(d.iter().all(|v| *v == 50.0 || *v == 80.0), "{d:?}");
        // Nothing is invented where there is no data.
        let none = vec![0f32; w * h];
        assert!(to_fusion_grid(&none, &normal, w, h).0.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn a_blank_image_matches_nothing() {
        let (w, h) = (80, 60);
        let (views, _, _) = scene(w, h);
        let blank = pyramid(vec![0.5f32; w * h], w, h, 1);
        let srcs: Vec<(&View, &Pyramid)> = (1..views.len()).map(|i| (&views[i], &blank)).collect();
        let o = Options { levels: 1, iterations: 1, ..Options::default() };
        let st = solve(&views[0], &blank, &srcs, 80.0, 130.0, &o, 5);
        assert!(st.c.iter().all(|c| *c >= NO_MATCH), "a textureless window must stay unmatched");
    }

    #[test]
    fn the_check_removes_what_neighbours_deny() {
        let (w, h) = (60, 40);
        let v0 = View { name: "a".into(), k: [60.0, 60.0, 30.0, 20.0], r: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], t: [0.0, 0.0, 0.0], w, h };
        let mut v1 = v0.clone();
        v1.t = [-1.0, 0.0, 0.0];
        let mut v2 = v0.clone();
        v2.t = [1.0, 0.0, 0.0];
        // Both neighbours see a plane at 50 m; the reference has one pixel far off it.
        let d1 = vec![50f32; w * h];
        let d2 = vec![50f32; w * h];
        let mut d0 = vec![50f32; w * h];
        d0[20 * w + 30] = 80.0;
        let n = agree(&v0, &mut d0, &[(&v1, d1.as_slice()), (&v2, d2.as_slice())], 2);
        assert_eq!(d0[20 * w + 30], 0.0);
        assert!(n > (w * h) / 2, "{n}");
        assert_eq!(d0[20 * w + 29], 50.0);
    }
}
