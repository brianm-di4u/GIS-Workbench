//! `products`: from the fused cloud and the undistorted views to a DSM, an orthomosaic, the
//! oriented frames and a LAS file. Coordinates inside the workspace are UTM less the offset in
//! georef.json; everything written is in full UTM metres (WGS 84), and the frames in WGS 84 degrees
//! as GeoJSON requires. Heights stay what the GPS recorded: the block has no vertical datum beyond
//! that, and the report says so.

use crate::colmap::{centre, pinhole, read_map, read_model, rotation, Model};
use crate::geo::{mat_vec, norm, sub, transpose, utm_inverse, M3, V3};
use crate::las::{read_ply, write_las, Pt};
use crate::tiff::{f32_bytes, write as write_tiff, Geo};
use crate::{progress, Res};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

pub const NODATA: f32 = -9999.0;
const MIN_POINTS: usize = 1000;
/// Largest raster side; a coarser pixel is chosen beyond it, and the report says so.
const MAX_SIDE: f64 = 30000.0;

pub struct Paths<'a> {
    pub workspace: &'a Path,
    pub georef: &'a Path,
    pub ply: &'a Path,
    pub dsm: &'a Path,
    pub ortho: &'a Path,
    pub frames: &'a Path,
    pub las: &'a Path,
    pub report: &'a Path,
}

/// A raster over the block, in workspace coordinates; row 0 is north.
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub x0: f64,
    pub y1: f64,
    pub res: f64,
    pub w: usize,
    pub h: usize,
}

impl Grid {
    fn cell(&self, x: f64, y: f64) -> Option<usize> {
        let (c, r) = (((x - self.x0) / self.res).floor(), ((self.y1 - y) / self.res).floor());
        if c < 0.0 || r < 0.0 || c >= self.w as f64 || r >= self.h as f64 {
            return None;
        }
        Some(r as usize * self.w + c as usize)
    }
    fn xy(&self, c: usize, r: usize) -> (f64, f64) {
        (self.x0 + (c as f64 + 0.5) * self.res, self.y1 - (r as f64 + 0.5) * self.res)
    }
}

fn percentile(v: &mut [f32], q: f64) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let i = ((v.len() - 1) as f64 * q) as usize;
    *v.select_nth_unstable_by(i, f32::total_cmp).1
}

/// Per-cell median height, then gaps filled from their neighbours up to `fill` cells across, then a
/// 3 x 3 median. Returns the raster and the share of data cells that were filled.
pub fn grid_dsm(pts: &[Pt], g: &Grid, fill: usize) -> (Vec<f32>, f64) {
    let mut keyed: Vec<(u32, f32)> = pts.iter().filter_map(|p| g.cell(p.xyz[0] as f64, p.xyz[1] as f64).map(|c| (c as u32, p.xyz[2]))).collect();
    keyed.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut dsm = vec![NODATA; g.w * g.h];
    let mut i = 0;
    while i < keyed.len() {
        let mut j = i;
        while j < keyed.len() && keyed[j].0 == keyed[i].0 {
            j += 1;
        }
        dsm[keyed[i].0 as usize] = keyed[(i + j) / 2].1;
        i = j;
    }
    let measured = dsm.iter().filter(|v| **v != NODATA).count();
    let (w, h) = (g.w, g.h);
    for _ in 0..fill {
        let prev = dsm.clone();
        let changed: Vec<(usize, f32)> = (0..h)
            .into_par_iter()
            .flat_map_iter(|y| {
                let prev = &prev;
                (0..w).filter_map(move |x| {
                    let i = y * w + x;
                    if prev[i] != NODATA {
                        return None;
                    }
                    let (mut s, mut n) = (0f32, 0);
                    for (dx, dy) in [(-1isize, 0isize), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1)] {
                        let (a, b) = (x as isize + dx, y as isize + dy);
                        if a >= 0 && b >= 0 && a < w as isize && b < h as isize {
                            let v = prev[b as usize * w + a as usize];
                            if v != NODATA {
                                s += v;
                                n += 1;
                            }
                        }
                    }
                    (n >= 3).then(|| (i, s / n as f32))
                })
            })
            .collect();
        if changed.is_empty() {
            break;
        }
        for (i, v) in changed {
            dsm[i] = v;
        }
    }
    let filled = dsm.iter().filter(|v| **v != NODATA).count();
    let src = dsm.clone();
    dsm.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        let mut n = [0f32; 9];
        for (x, v) in row.iter_mut().enumerate() {
            if *v == NODATA {
                continue;
            }
            let mut k = 0;
            for b in y.saturating_sub(1)..(y + 2).min(h) {
                for a in x.saturating_sub(1)..(x + 2).min(w) {
                    let u = src[b * w + a];
                    if u != NODATA {
                        n[k] = u;
                        k += 1;
                    }
                }
            }
            n[..k].sort_unstable_by(f32::total_cmp);
            *v = n[k / 2];
        }
    });
    (dsm, (filled - measured) as f64 / filled.max(1) as f64)
}

/// The surface the photographs are draped on: the DSM where it has data, and elsewhere a coarse
/// filled surface. Vegetation matches poorly, so without this the mosaic would stop at the edge of
/// the cloud. The fill is for draping only: it never reaches the DSM, which keeps its holes, and
/// the report gives the share of the mosaic that lies on it. Pixels there can be displaced by the
/// height error, tree tops most.
struct Surface<'a> {
    dsm: &'a [f32],
    dg: Grid,
    coarse: &'a [f32],
    cg: Grid,
}

impl Surface<'_> {
    /// Height at a point, and whether it was measured there.
    #[inline]
    fn at(&self, x: f64, y: f64) -> Option<(f32, bool)> {
        if let Some(i) = self.dg.cell(x, y) {
            let v = self.dsm[i];
            if v != NODATA {
                return Some((v, true));
            }
        }
        let v = self.coarse[self.cg.cell(x, y)?];
        (v != NODATA).then_some((v, false))
    }
}

/// Fill every empty cell from a coarser copy of the raster (push-pull), then smooth what was filled.
pub fn fill_all(v: &mut [f32], w: usize, h: usize) {
    if !v.contains(&NODATA) || v.iter().all(|x| *x == NODATA) {
        return;
    }
    let holes: Vec<bool> = v.iter().map(|x| *x == NODATA).collect();
    if w > 1 || h > 1 {
        let (nw, nh) = (w.div_ceil(2), h.div_ceil(2));
        let mut down = vec![NODATA; nw * nh];
        for y in 0..nh {
            for x in 0..nw {
                let (mut s, mut n) = (0f32, 0);
                for b in (y * 2)..((y * 2 + 2).min(h)) {
                    for a in (x * 2)..((x * 2 + 2).min(w)) {
                        if v[b * w + a] != NODATA {
                            s += v[b * w + a];
                            n += 1;
                        }
                    }
                }
                if n > 0 {
                    down[y * nw + x] = s / n as f32;
                }
            }
        }
        fill_all(&mut down, nw, nh);
        for y in 0..h {
            for x in 0..w {
                if holes[y * w + x] {
                    v[y * w + x] = down[(y / 2) * nw + x / 2];
                }
            }
        }
    }
    for _ in 0..2 {
        let src = v.to_vec();
        for y in 0..h {
            for x in 0..w {
                if !holes[y * w + x] {
                    continue;
                }
                let (mut s, mut n) = (0f32, 0f32);
                for b in y.saturating_sub(1)..(y + 2).min(h) {
                    for a in x.saturating_sub(1)..(x + 2).min(w) {
                        s += src[b * w + a];
                        n += 1.0;
                    }
                }
                v[y * w + x] = s / n;
            }
        }
    }
}

/// Median height per coarse cell of the given points, with every other cell filled.
fn coarse_surface(pts: impl Iterator<Item = (f64, f64, f32)>, g: &Grid) -> Vec<f32> {
    let mut keyed: Vec<(u32, f32)> = pts.filter_map(|(x, y, z)| g.cell(x, y).map(|c| (c as u32, z))).collect();
    keyed.par_sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    let mut out = vec![NODATA; g.w * g.h];
    let mut i = 0;
    while i < keyed.len() {
        let mut j = i;
        while j < keyed.len() && keyed[j].0 == keyed[i].0 {
            j += 1;
        }
        out[keyed[i].0 as usize] = keyed[(i + j) / 2].1;
        i = j;
    }
    fill_all(&mut out, g.w, g.h);
    out
}

struct Cam {
    name: String,
    k: [f64; 4],
    w: usize,
    h: usize,
    r: M3,
    t: V3,
    c: V3,
}

fn cams(m: &Model) -> Res<Vec<Cam>> {
    m.images
        .iter()
        .map(|im| {
            let c = m.cameras.get(&im.camera).ok_or_else(|| format!("{} has no camera", im.name))?;
            Ok(Cam { name: im.name.clone(), k: pinhole(c)?, w: c.width as usize, h: c.height as usize, r: rotation(im), t: im.t, c: centre(im) })
        })
        .collect()
}

/// Where a pixel's ray meets the plane z.
fn on_plane(c: &Cam, u: f64, v: f64, z: f64) -> Option<(f64, f64)> {
    let d = mat_vec(&transpose(&c.r), [(u - c.k[2]) / c.k[0], (v - c.k[3]) / c.k[1], 1.0]);
    if d[2] >= -1e-6 {
        return None;
    }
    let s = (z - c.c[2]) / d[2];
    (s > 0.0).then(|| (c.c[0] + d[0] * s, c.c[1] + d[1] * s))
}

fn weight_edge(u: f64, v: f64, w: usize, h: usize) -> f32 {
    let ramp = 0.08 * w.min(h) as f64;
    let e = u.min(v).min(w as f64 - u).min(h as f64 - v).max(0.0) / ramp;
    e.min(1.0) as f32
}

/// Blend every view over the DSM. Views are read one at a time, so memory follows the raster, not
/// the block. A view is left out at a ground point when its own depth map says something stands
/// nearer along the ray.
fn mosaic(ws: &Path, list: &[Cam], surface: &Surface, og: &Grid, zmed: f64, step: impl Fn(f64) + Sync) -> Res<(Vec<u8>, f64, f64)> {
    let mut acc = vec![[0f32; 4]; og.w * og.h];
    let dir = ws.join("stereo").join("depth_maps");
    for (idx, c) in list.iter().enumerate() {
        // The footprint on the median height, with a margin for relief and tilt.
        let corners = [(0.0, 0.0), (c.w as f64, 0.0), (0.0, c.h as f64), (c.w as f64, c.h as f64)];
        let foot: Vec<(f64, f64)> = corners.iter().filter_map(|(u, v)| on_plane(c, *u, *v, zmed)).collect();
        if foot.len() < 4 {
            continue;
        }
        let span = foot.iter().map(|f| (f.0 - foot[0].0).abs().max((f.1 - foot[0].1).abs())).fold(0.0, f64::max);
        let m = span * 0.15;
        let xs = foot.iter().map(|f| f.0);
        let ys = foot.iter().map(|f| f.1);
        let (x0, x1) = (xs.clone().fold(f64::MAX, f64::min) - m, xs.fold(f64::MIN, f64::max) + m);
        let (y0, y1) = (ys.clone().fold(f64::MAX, f64::min) - m, ys.fold(f64::MIN, f64::max) + m);
        let c0 = (((x0 - og.x0) / og.res).floor().max(0.0)) as usize;
        let c1 = (((x1 - og.x0) / og.res).ceil().max(0.0) as usize).min(og.w);
        let r0 = (((og.y1 - y1) / og.res).floor().max(0.0)) as usize;
        let r1 = (((og.y1 - y0) / og.res).ceil().max(0.0) as usize).min(og.h);
        if c0 >= c1 || r0 >= r1 {
            continue;
        }
        let img = image::open(ws.join("images").join(&c.name)).map_err(|e| format!("cannot read {}: {e}", c.name))?.to_rgb8();
        let (iw, ih) = (img.width() as usize, img.height() as usize);
        if iw != c.w || ih != c.h {
            return Err(format!("{} is {iw} by {ih}, not the size in the model", c.name));
        }
        let raw = img.as_raw();
        let dp = dir.join(format!("{}.geometric.bin", c.name));
        let depth = if dp.exists() { Some(read_map(&dp)?) } else { None };
        let (sx, sy) = depth.as_ref().map_or((1.0, 1.0), |d| (d.0 as f64 / c.w as f64, d.1 as f64 / c.h as f64));
        acc.par_chunks_mut(og.w).enumerate().take(r1).skip(r0).for_each(|(r, row)| {
            for (cc, a) in row.iter_mut().enumerate().take(c1).skip(c0) {
                let (x, y) = og.xy(cc, r);
                let Some((z, _)) = surface.at(x, y) else { continue };
                let p = [x, y, z as f64];
                let cam = crate::geo::add(mat_vec(&c.r, p), c.t);
                if cam[2] <= 0.0 {
                    continue;
                }
                let (u, v) = (c.k[0] * cam[0] / cam[2] + c.k[2], c.k[1] * cam[1] / cam[2] + c.k[3]);
                let (fx, fy) = (u - 0.5, v - 0.5);
                if fx < 0.0 || fy < 0.0 || fx >= (c.w - 1) as f64 || fy >= (c.h - 1) as f64 {
                    continue;
                }
                if let Some((dw, dh, _, dm)) = &depth {
                    let (a2, b2) = (((u * sx) as usize).min(dw - 1), ((v * sy) as usize).min(dh - 1));
                    let near = dm[b2 * dw + a2] as f64;
                    if near > 0.0 && cam[2] > near * 1.01 + 0.15 {
                        continue;
                    }
                }
                let to_cam = sub(c.c, p);
                let cosv = (to_cam[2] / norm(to_cam).max(1e-9)).max(0.0) as f32;
                let e = weight_edge(u, v, c.w, c.h);
                // A sharp preference for the most vertical view: blending hides seams, and the
                // power keeps the blend narrow, so relief errors do not smear.
                let wt = cosv.powi(32) * e * e;
                if wt <= 0.0 {
                    continue;
                }
                let (ix, iy) = (fx as usize, fy as usize);
                let (ax, ay) = ((fx - ix as f64) as f32, (fy - iy as f64) as f32);
                for ch in 0..3 {
                    let at = |px: usize, py: usize| raw[(py * c.w + px) * 3 + ch] as f32;
                    let top = at(ix, iy) * (1.0 - ax) + at(ix + 1, iy) * ax;
                    let bot = at(ix, iy + 1) * (1.0 - ax) + at(ix + 1, iy + 1) * ax;
                    a[ch] += wt * (top * (1.0 - ay) + bot * ay);
                }
                a[3] += wt;
            }
        });
        step((idx + 1) as f64 / list.len() as f64);
    }
    let covered = acc.iter().filter(|a| a[3] > 0.0).count();
    let draped: usize = acc
        .par_chunks(og.w)
        .enumerate()
        .map(|(r, row)| row.iter().enumerate().filter(|(c, a)| a[3] > 0.0 && surface.at(og.xy(*c, r).0, og.xy(*c, r).1).is_some_and(|h| !h.1)).count())
        .sum();
    let (filled_share, covered) = (draped as f64 / covered.max(1) as f64, covered as f64 / acc.len().max(1) as f64);
    let mut out = vec![0u8; og.w * og.h * 4];
    out.par_chunks_mut(4).zip(acc.par_iter()).for_each(|(o, a)| {
        if a[3] > 0.0 {
            for c in 0..3 {
                o[c] = (a[c] / a[3]).round().clamp(0.0, 255.0) as u8;
            }
            o[3] = 255;
        }
    });
    Ok((out, covered, filled_share))
}

/// Omega, phi, kappa in degrees: the rotation world to image with x right, y up and z back
/// (photogrammetric camera axes), R = Rz(kappa) Ry(phi) Rx(omega).
pub fn opk(r: &M3) -> [f64; 3] {
    let m = [r[0], [-r[1][0], -r[1][1], -r[1][2]], [-r[2][0], -r[2][1], -r[2][2]]];
    let phi = m[0][2].clamp(-1.0, 1.0).asin();
    let omega = (-m[1][2]).atan2(m[2][2]);
    let kappa = (-m[0][1]).atan2(m[0][0]);
    [omega.to_degrees(), phi.to_degrees(), kappa.to_degrees()]
}

fn three(v: f64) -> f64 {
    if v <= 0.0 {
        return v;
    }
    let p = 10f64.powf(v.log10().floor() - 1.0);
    (v / p).ceil() * p
}

pub fn run(p: &Paths, dsm_res: f64, ortho_res: f64) -> Res<Value> {
    let geo: Value = serde_json::from_slice(&fs::read(p.georef).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let epsg = geo["epsg"].as_u64().ok_or("georef.json has no EPSG code")? as u32;
    let zone = geo["utm_zone"].as_u64().unwrap_or(0) as u32;
    let south = geo["south"].as_bool().unwrap_or(false);
    let off = [geo["offset"][0].as_f64().unwrap_or(0.0), geo["offset"][1].as_f64().unwrap_or(0.0), 0.0];
    let pts = read_ply(p.ply)?;
    if pts.len() < MIN_POINTS {
        return Err(format!("the dense stage kept only {} points: the photographs matched too poorly for a surface", pts.len()));
    }
    progress(0.02);
    let m = read_model(&p.workspace.join("sparse"))?;
    let list = cams(&m)?;
    // Reject far outliers from the extent and heights (a few stray matches would stretch both).
    let mut zs: Vec<f32> = pts.iter().map(|q| q.xyz[2]).collect();
    let (zlo, zmed, zhi) = (percentile(&mut zs, 0.001), percentile(&mut zs, 0.5), percentile(&mut zs, 0.999));
    drop(zs);
    let band = (zhi - zlo).max(1.0) * 0.5;
    let kept: Vec<Pt> = pts.iter().filter(|q| q.xyz[2] >= zlo - band && q.xyz[2] <= zhi + band).copied().collect();
    let mut xs: Vec<f32> = kept.iter().map(|q| q.xyz[0]).collect();
    let mut ys: Vec<f32> = kept.iter().map(|q| q.xyz[1]).collect();
    let (x0, x1) = (percentile(&mut xs, 0.0005) as f64, percentile(&mut xs, 0.9995) as f64);
    let (y0, y1) = (percentile(&mut ys, 0.0005) as f64, percentile(&mut ys, 0.9995) as f64);
    drop((xs, ys));
    // Ground sample distance of the undistorted views at the median height.
    let mut gsd: Vec<f64> = list.iter().map(|c| (c.c[2] - zmed as f64).abs() / c.k[0]).collect();
    gsd.sort_by(f64::total_cmp);
    let g0 = gsd[gsd.len() / 2];
    let any_map = list.iter().find_map(|c| read_map(&p.workspace.join("stereo").join("depth_maps").join(format!("{}.geometric.bin", c.name))).ok().map(|d| (d.0, c.w)));
    let depth_scale = any_map.map_or(1.0, |(d, w)| w as f64 / d as f64);
    // The mosaic reaches as far as the photographs do, which is further than the cloud.
    let foot: Vec<(f64, f64)> = list.iter().flat_map(|c| [(0.0, 0.0), (c.w as f64, 0.0), (0.0, c.h as f64), (c.w as f64, c.h as f64)].map(|(u, v)| on_plane(c, u, v, zmed as f64))).flatten().collect();
    let ex0 = foot.iter().map(|f| f.0).fold(x0, f64::min);
    let ex1 = foot.iter().map(|f| f.0).fold(x1, f64::max);
    let ey0 = foot.iter().map(|f| f.1).fold(y0, f64::min);
    let ey1 = foot.iter().map(|f| f.1).fold(y1, f64::max);
    let span = (ex1 - ex0).max(ey1 - ey0);
    let mut res_d = if dsm_res > 0.0 { dsm_res } else { three(g0 * depth_scale * 2.0) };
    let mut res_o = if ortho_res > 0.0 { ortho_res } else { three(g0) };
    let mut coarsened = false;
    if span / res_d > MAX_SIDE {
        res_d = three(span / MAX_SIDE);
        coarsened = true;
    }
    if span / res_o > MAX_SIDE {
        res_o = three(span / MAX_SIDE);
        coarsened = true;
    }
    let snap = |v: f64, r: f64| (v / r).floor() * r;
    let dg = Grid { x0: snap(x0, res_d), y1: snap(y1, res_d) + res_d, res: res_d, w: (((x1 - snap(x0, res_d)) / res_d).ceil() as usize).max(1), h: (((snap(y1, res_d) + res_d - y0) / res_d).ceil() as usize).max(1) };
    let og = Grid { x0: snap(ex0, res_o), y1: snap(ey1, res_o) + res_o, res: res_o, w: (((ex1 - snap(ex0, res_o)) / res_o).ceil() as usize).max(1), h: (((snap(ey1, res_o) + res_o - ey0) / res_o).ceil() as usize).max(1) };
    let res_c = (res_d * 10.0).max(1.0);
    let cg = Grid { x0: snap(ex0, res_c), y1: snap(ey1, res_c) + res_c, res: res_c, w: (((ex1 - snap(ex0, res_c)) / res_c).ceil() as usize).max(1), h: (((snap(ey1, res_c) + res_c - ey0) / res_c).ceil() as usize).max(1) };
    let fill = (4.0 / res_d).ceil().clamp(2.0, 64.0) as usize;
    let (dsm, filled) = grid_dsm(&kept, &dg, fill);
    let data = dsm.iter().filter(|v| **v != NODATA).count();
    if data == 0 {
        return Err("no DSM cell received a point".into());
    }
    write_tiff(p.dsm, dg.w, dg.h, 1, 32, true, Some("-9999"), &Geo { epsg, origin: [dg.x0 + off[0], dg.y1 + off[1]], pixel: res_d }, &f32_bytes(&dsm))?;
    progress(0.15);
    let (lo, hi) = (zlo - band, zhi + band);
    let sparse = m.points.values().map(|q| (q.xyz[0], q.xyz[1], q.xyz[2] as f32)).filter(|q| q.2 >= lo && q.2 <= hi);
    let coarse = coarse_surface(kept.iter().map(|q| (q.xyz[0] as f64, q.xyz[1] as f64, q.xyz[2])).chain(sparse), &cg);
    let surface = Surface { dsm: &dsm, dg, coarse: &coarse, cg };
    let (ortho, covered, on_fill) = mosaic(p.workspace, &list, &surface, &og, zmed as f64, |f| progress(0.15 + 0.75 * f))?;
    write_tiff(p.ortho, og.w, og.h, 4, 8, false, None, &Geo { epsg, origin: [og.x0 + off[0], og.y1 + off[1]], pixel: res_o }, &ortho)?;
    drop(ortho);
    progress(0.92);
    write_las(p.las, &kept, off, epsg)?;
    // Oriented frames.
    let features: Vec<Value> = list
        .iter()
        .zip(&m.images)
        .map(|(c, im)| {
            let to_ll = |x: f64, y: f64| {
                let (lat, lon) = utm_inverse(x + off[0], y + off[1], zone, south);
                json!([lon, lat])
            };
            let ring: Vec<Value> = [(0.0, 0.0), (c.w as f64, 0.0), (c.w as f64, c.h as f64), (0.0, c.h as f64), (0.0, 0.0)].iter().filter_map(|(u, v)| on_plane(c, *u, *v, zmed as f64)).map(|(x, y)| to_ll(x, y)).collect();
            let [omega, phi, kappa] = opk(&c.r);
            let (lat, lon) = utm_inverse(c.c[0] + off[0], c.c[1] + off[1], zone, south);
            let geom = if ring.len() == 5 { json!({"type": "Polygon", "coordinates": [ring]}) } else { json!({"type": "Point", "coordinates": [lon, lat]}) };
            json!({"type": "Feature", "geometry": geom, "properties": {
                "name": c.name, "lon": lon, "lat": lat, "height_m": c.c[2],
                "easting": c.c[0] + off[0], "northing": c.c[1] + off[1],
                "omega_deg": omega, "phi_deg": phi, "kappa_deg": kappa,
                "focal_px": c.k[0], "width": c.w, "height": c.h, "tie_points": im.points.len(),
                "gsd_m": (c.c[2] - zmed as f64).abs() / c.k[0],
            }})
        })
        .collect();
    fs::write(p.frames, serde_json::to_vec(&json!({"type": "FeatureCollection", "features": features})).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut report = json!({
        "route": "COLMAP 4.2.1 (sidecar build, CPU) and gwb-sfm CPU PatchMatch",
        "crs": format!("EPSG:{epsg}"),
        "vertical": "heights are as the GPS recorded them; no geoid or datum is applied",
        "georef": geo,
        "dense_points": pts.len(),
        "cloud_points": kept.len(),
        "median_height_m": zmed,
        "gsd_m": g0,
        "dsm": { "resolution_m": res_d, "width": dg.w, "height": dg.h, "cells": data, "filled_share": filled },
        "ortho": { "resolution_m": res_o, "width": og.w, "height": og.h, "covered_share": covered, "on_filled_surface_share": on_fill },
        "coarsened_for_size": coarsened,
    });
    if !report["georef"]["gps_rms_m"].is_object() {
        report["georef"] = Value::Null;
    }
    fs::write(p.report, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    progress(1.0);
    Ok(report)
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_takes_the_median_fills_small_gaps_and_leaves_large_ones() {
        let g = Grid { x0: 0.0, y1: 10.0, res: 1.0, w: 10, h: 10 };
        let mut pts = Vec::new();
        for y in 0..10 {
            for x in 0..4 {
                if (x, y) == (1, 5) {
                    continue; // a one-cell hole
                }
                for (i, z) in [10.0f32, 10.5, 90.0].iter().enumerate() {
                    pts.push(Pt { xyz: [x as f32 + 0.5, y as f32 + 0.5 + i as f32 * 0.01, *z], rgb: [0, 0, 0] });
                }
            }
        }
        let (d, filled) = grid_dsm(&pts, &g, 1);
        let at = |x: usize, y: usize| d[(9 - y) * 10 + x];
        assert_eq!(at(0, 0), 10.5, "the median ignores the outlier");
        assert_eq!(at(1, 5), 10.5, "a small hole is filled");
        assert!(at(8, 5) == NODATA, "a hole far from data stays empty");
        assert!(filled > 0.0);
    }

    #[test]
    fn the_fill_reaches_every_cell_and_keeps_what_was_measured() {
        let (w, h) = (9, 7);
        let mut v = vec![NODATA; w * h];
        v[3 * w + 4] = 10.0;
        v[0] = 20.0;
        let keep = v.clone();
        fill_all(&mut v, w, h);
        assert!(v.iter().all(|x| *x != NODATA));
        assert!(v.iter().all(|x| (10.0..=20.0).contains(x)), "{v:?}");
        assert_eq!((v[3 * w + 4], v[0]), (keep[3 * w + 4], keep[0]));
        let mut empty = vec![NODATA; 4];
        fill_all(&mut empty, 2, 2);
        assert!(empty.iter().all(|x| *x == NODATA), "nothing to fill from");
    }

    #[test]
    fn the_surface_prefers_the_dsm_and_says_when_it_did_not() {
        let dg = Grid { x0: 0.0, y1: 2.0, res: 1.0, w: 2, h: 2 };
        let cg = Grid { x0: -10.0, y1: 12.0, res: 22.0, w: 1, h: 1 };
        let dsm = [5.0, NODATA, NODATA, NODATA];
        let coarse = [7.0];
        let s = Surface { dsm: &dsm, dg, coarse: &coarse, cg };
        assert_eq!(s.at(0.5, 1.5), Some((5.0, true)));
        assert_eq!(s.at(1.5, 1.5), Some((7.0, false)));
        assert_eq!(s.at(-5.0, 5.0), Some((7.0, false)));
        assert_eq!(s.at(100.0, 0.0), None);
    }

    #[test]
    fn opk_of_a_nadir_camera() {
        // Camera axes x east, y south, z down: the usual nadir view with north up.
        let r: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];
        let a = opk(&r);
        assert!(a.iter().all(|v| v.abs() < 1e-9), "{a:?}");
    }

    #[test]
    fn plane_intersection() {
        let r: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];
        let c = Cam { name: "a".into(), k: [1000.0, 1000.0, 500.0, 500.0], w: 1000, h: 1000, r, t: [0.0, 0.0, 100.0], c: [0.0, 0.0, 100.0] };
        let (x, y) = on_plane(&c, 1000.0, 500.0, 0.0).unwrap();
        assert!((x - 50.0).abs() < 1e-9 && y.abs() < 1e-9, "{x} {y}");
    }

    #[test]
    fn rounding_up_keeps_two_figures() {
        assert!((three(0.0234) - 0.024).abs() < 1e-12);
        assert!((three(0.15) - 0.15).abs() < 1e-12);
    }
}
