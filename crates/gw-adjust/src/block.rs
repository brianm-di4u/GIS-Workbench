//! RPC bias-compensated block adjustment (REQ-SNS-11, `Research/06` §4; Grodecki & Dial 2003):
//! per-image shift, shift + drift or affine corrections in image space, ground points in local
//! metres, GCPs as weighted pseudo-observations with σ, checkpoints left free and compared with
//! their known coordinates afterwards, optional a priori σ on the image parameters,
//! Levenberg–Marquardt with the point blocks eliminated by the Schur complement, σ₀, residuals,
//! posterior covariances and iterative blunder rejection.

use crate::linalg::{chol_inverse, chol_solve, cholesky, Mat};
use gw_abi::{Error, Result};
use gw_geodesy::stats;
use gw_sensor::adjusted::{BiasKind, ImageBias};
use gw_sensor::intersect::{deg_per_metre, enu_partials, intersect, inv3, Observation};
use gw_sensor::{Ground, SensorModel};
use std::rc::Rc;

pub struct ImageIn {
    pub model: Rc<dyn SensorModel>,
    pub kind: BiasKind,
    /// Held fixed (a reference image): no parameters.
    pub fixed: bool,
    /// Normalisation of the bias terms: image centre and half-size (pixels).
    pub centre: (f64, f64),
    pub half: (f64, f64),
    /// A priori σ of each bias term (pixels); 0 = no prior.
    pub prior_sigma_px: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointKind {
    Tie,
    Gcp,
    Check,
}

pub struct PointIn {
    pub kind: PointKind,
    /// Known coordinates (GCPs and checkpoints).
    pub known: Option<Ground>,
    /// σ of the known coordinates (m): horizontal per axis and vertical.
    pub sigma_h: f64,
    pub sigma_v: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct ObsIn {
    pub image: usize,
    pub point: usize,
    pub x: f64,
    pub y: f64,
    pub sigma_px: f64,
}

pub struct Options {
    pub max_iterations: usize,
    /// Flag observations whose residual exceeds k·σ on either axis.
    pub reject_k: f64,
    /// Remove flagged observations one at a time and re-solve, up to this many.
    pub max_reject: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { max_iterations: 50, reject_k: 3.0, max_reject: 0 }
    }
}

#[derive(Clone, Debug)]
pub struct ObsResult {
    /// Measured − adjusted projection (pixels).
    pub v: (f64, f64),
    /// max(|vx|, |vy|) / σ.
    pub normalized: f64,
    pub flagged: bool,
    pub rejected: bool,
}

#[derive(Clone, Debug, Default)]
pub struct AxisStats {
    pub n: usize,
    pub rmse: [f64; 3],
    pub rmse_r: f64,
    /// √(RMSE_x² + RMSE_y² + RMSE_z²).
    pub rmse_3d: f64,
    /// CE90 = 1.5175 · RMSE_r (circular-normal approximation, named), LE90 = 1.6449 · RMSE_z.
    pub ce90: f64,
    pub le90: f64,
    pub max: [f64; 3],
}

#[derive(Clone, Debug)]
pub struct Solution {
    pub biases: Vec<ImageBias>,
    /// Posterior covariance of each image's parameters (row-major, k × k), empty when fixed.
    pub bias_cov: Vec<Vec<f64>>,
    pub points: Vec<Option<Ground>>,
    pub point_cov: Vec<[[f64; 3]; 3]>,
    pub residuals: Vec<ObsResult>,
    pub sigma0: f64,
    pub dof: i64,
    pub iterations: usize,
    pub converged: bool,
    pub checkpoints_before: AxisStats,
    pub checkpoints_after: AxisStats,
    /// GCP residuals (known − adjusted) in E, N, U metres.
    pub gcp_residuals: Vec<(usize, [f64; 3])>,
    pub rejected: Vec<usize>,
    /// Points that could not be used (fewer than two images and no control).
    pub unused_points: Vec<usize>,
}

fn enu_diff(a: Ground, b: Ground) -> [f64; 3] {
    // a − b in local metres at b.
    let (dlat, dlon) = deg_per_metre(b);
    [(a.lon - b.lon) / dlon, (a.lat - b.lat) / dlat, a.h - b.h]
}

fn axis_stats(d: &[[f64; 3]]) -> AxisStats {
    if d.is_empty() {
        return AxisStats::default();
    }
    let n = d.len() as f64;
    let mut rmse = [0.0; 3];
    let mut max = [0.0_f64; 3];
    for v in d {
        for k in 0..3 {
            rmse[k] += v[k] * v[k];
            max[k] = max[k].max(v[k].abs());
        }
    }
    for r in &mut rmse {
        *r = (*r / n).sqrt();
    }
    let rmse_r = rmse[0].hypot(rmse[1]);
    AxisStats { n: d.len(), rmse, rmse_r, rmse_3d: rmse_r.hypot(rmse[2]), ce90: 1.5175 * rmse_r, le90: stats::LE90_K * rmse[2], max }
}

/// Bias term basis [1, u, v] for the six affine terms at normalised (u, v).
fn basis(t: usize, u: f64, v: f64) -> f64 {
    match t % 3 {
        0 => 1.0,
        1 => u,
        _ => v,
    }
}

struct Layout {
    /// Parameter offset per image (None when fixed).
    off: Vec<Option<usize>>,
    p: usize,
}

fn layout(images: &[ImageIn]) -> Layout {
    let mut off = Vec::with_capacity(images.len());
    let mut p = 0;
    for im in images {
        if im.fixed {
            off.push(None);
        } else {
            off.push(Some(p));
            p += im.kind.len();
        }
    }
    Layout { off, p }
}

/// Initial ground points: GCPs at their known coordinates, the others intersected with the
/// unadjusted models.
fn initial_points(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], active: &[bool]) -> Vec<Option<Ground>> {
    let mut out = vec![None; points.len()];
    for (j, p) in points.iter().enumerate() {
        let mine: Vec<&ObsIn> = obs.iter().enumerate().filter(|(k, o)| active[*k] && o.point == j).map(|(_, o)| o).collect();
        if p.kind == PointKind::Gcp {
            if let Some(g) = p.known {
                if !mine.is_empty() {
                    out[j] = Some(g);
                }
                continue;
            }
        }
        if mine.len() < 2 {
            continue;
        }
        let ob: Vec<Observation<'_>> = mine.iter().map(|o| Observation { model: &*images[o.image].model, x: o.x, y: o.y, sigma_px: o.sigma_px }).collect();
        if let Ok(r) = intersect(&ob, p.known) {
            out[j] = Some(r.ground);
        }
    }
    out
}

struct Normal {
    npp: Mat,
    bp: Vec<f64>,
    /// Per point: N_XX (3×3), b_X, N_pX (p × 3, row-major).
    nxx: Vec<[[f64; 3]; 3]>,
    bx: Vec<[f64; 3]>,
    npx: Vec<Vec<f64>>,
    cost: f64,
    nobs: usize,
}

fn assemble(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], active: &[bool], lay: &Layout, biases: &[ImageBias], g: &[Option<Ground>]) -> Result<Normal> {
    let p = lay.p;
    let np = points.len();
    let mut nm = Normal { npp: Mat::zeros(p), bp: vec![0.0; p], nxx: vec![[[0.0; 3]; 3]; np], bx: vec![[0.0; 3]; np], npx: vec![vec![0.0; p * 3]; np], cost: 0.0, nobs: 0 };
    for (k, o) in obs.iter().enumerate() {
        if !active[k] {
            continue;
        }
        let Some(gj) = g[o.point] else { continue };
        let im = &images[o.image];
        let b = &biases[o.image];
        let (x0, y0) = im.model.ground_to_image(gj)?;
        let (x, y) = b.apply(x0, y0);
        let r = [o.x - x, o.y - y];
        let w = 1.0 / (o.sigma_px * o.sigma_px);
        nm.cost += w * (r[0] * r[0] + r[1] * r[1]);
        nm.nobs += 2;
        let jb = enu_partials(&*im.model, gj)?;
        // Chain through the bias: ∂(x, y)/∂(x₀, y₀) = I + D.
        let (hx, hy) = b.half;
        let d = [[1.0 + b.c[4] / hx, b.c[5] / hy], [b.c[1] / hx, 1.0 + b.c[2] / hy]];
        let mut jx = [[0.0; 3]; 2];
        for row in 0..2 {
            for c in 0..3 {
                jx[row][c] = d[row][0] * jb[0][c] + d[row][1] * jb[1][c];
            }
        }
        let (u, v) = b.uv(x0, y0);
        // Parameter partials: terms 0..2 move y (row 1), 3..5 move x (row 0).
        let mut jp: Vec<(usize, [f64; 2])> = Vec::new();
        if let Some(off) = lay.off[o.image] {
            for (q, &t) in im.kind.terms().iter().enumerate() {
                let val = basis(t, u, v);
                jp.push((off + q, if t < 3 { [0.0, val] } else { [val, 0.0] }));
            }
        }
        let j = o.point;
        for row in 0..2 {
            for a in 0..3 {
                nm.bx[j][a] += jx[row][a] * w * r[row];
                for c in 0..3 {
                    nm.nxx[j][a][c] += jx[row][a] * w * jx[row][c];
                }
            }
            for &(ia, ja) in &jp {
                nm.bp[ia] += ja[row] * w * r[row];
                for &(ib, jb2) in &jp {
                    nm.npp.add(ia, ib, ja[row] * w * jb2[row]);
                }
                for c in 0..3 {
                    nm.npx[j][ia * 3 + c] += ja[row] * w * jx[row][c];
                }
            }
        }
    }
    // GCP pseudo-observations on the points.
    for (j, pt) in points.iter().enumerate() {
        if pt.kind != PointKind::Gcp {
            continue;
        }
        let (Some(k), Some(gj)) = (pt.known, g[j]) else { continue };
        let r = enu_diff(k, gj);
        let w = [1.0 / (pt.sigma_h * pt.sigma_h), 1.0 / (pt.sigma_h * pt.sigma_h), 1.0 / (pt.sigma_v * pt.sigma_v)];
        for a in 0..3 {
            nm.nxx[j][a][a] += w[a];
            nm.bx[j][a] += w[a] * r[a];
            nm.cost += w[a] * r[a] * r[a];
        }
        nm.nobs += 3;
    }
    // A priori σ on the image parameters.
    for (i, im) in images.iter().enumerate() {
        let Some(off) = lay.off[i] else { continue };
        if im.prior_sigma_px <= 0.0 {
            continue;
        }
        let w = 1.0 / (im.prior_sigma_px * im.prior_sigma_px);
        for (q, &t) in im.kind.terms().iter().enumerate() {
            let c = biases[i].c[t];
            nm.npp.add(off + q, off + q, w);
            nm.bp[off + q] -= w * c;
            nm.cost += w * c * c;
            nm.nobs += 1;
        }
    }
    Ok(nm)
}

/// Schur-complement solve of the (damped) normal equations: (δp, δX per point).
fn solve_step(nm: &Normal, lambda: f64, used: &[bool]) -> Option<(Vec<f64>, Vec<[f64; 3]>)> {
    let p = nm.npp.n;
    let np = nm.nxx.len();
    let mut s = nm.npp.clone();
    for i in 0..p {
        let d = s.at(i, i);
        s.add(i, i, lambda * d.max(1e-12));
    }
    let mut rhs = nm.bp.clone();
    let mut cinv = vec![[[0.0; 3]; 3]; np];
    for j in 0..np {
        if !used[j] {
            continue;
        }
        let mut c = nm.nxx[j];
        for a in 0..3 {
            c[a][a] += lambda * c[a][a].max(1e-12);
        }
        cinv[j] = inv3(&c)?;
        if p == 0 {
            continue;
        }
        // B C⁻¹ (p × 3)
        let b = &nm.npx[j];
        let mut bc = vec![0.0; p * 3];
        for i in 0..p {
            for c2 in 0..3 {
                bc[i * 3 + c2] = (0..3).map(|k| b[i * 3 + k] * cinv[j][k][c2]).sum();
            }
        }
        for i in 0..p {
            if bc[i * 3..i * 3 + 3].iter().all(|v| *v == 0.0) {
                continue;
            }
            for k in 0..p {
                let v: f64 = (0..3).map(|c2| bc[i * 3 + c2] * b[k * 3 + c2]).sum();
                if v != 0.0 {
                    s.add(i, k, -v);
                }
            }
            rhs[i] -= (0..3).map(|c2| bc[i * 3 + c2] * nm.bx[j][c2]).sum::<f64>();
        }
    }
    let dp = if p > 0 { chol_solve(&cholesky(&s)?, &rhs) } else { Vec::new() };
    let mut dx = vec![[0.0; 3]; np];
    for j in 0..np {
        if !used[j] {
            continue;
        }
        let mut r = nm.bx[j];
        for c2 in 0..3 {
            for i in 0..p {
                r[c2] -= nm.npx[j][i * 3 + c2] * dp[i];
            }
        }
        for a in 0..3 {
            dx[j][a] = (0..3).map(|c2| cinv[j][a][c2] * r[c2]).sum();
        }
    }
    Some((dp, dx))
}

fn apply_step(images: &[ImageIn], lay: &Layout, biases: &[ImageBias], g: &[Option<Ground>], dp: &[f64], dx: &[[f64; 3]]) -> (Vec<ImageBias>, Vec<Option<Ground>>) {
    let mut nb = biases.to_vec();
    for (i, im) in images.iter().enumerate() {
        if let Some(off) = lay.off[i] {
            for (q, &t) in im.kind.terms().iter().enumerate() {
                nb[i].c[t] += dp[off + q];
            }
        }
    }
    let ng = g
        .iter()
        .zip(dx)
        .map(|(gj, d)| {
            gj.map(|gj| {
                let (dlat, dlon) = deg_per_metre(gj);
                Ground { lat: gj.lat + d[1] * dlat, lon: gj.lon + d[0] * dlon, h: gj.h + d[2] }
            })
        })
        .collect();
    (nb, ng)
}

fn solve_once(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], active: &[bool], opts: &Options) -> Result<(Vec<ImageBias>, Vec<Option<Ground>>, usize, bool)> {
    let lay = layout(images);
    let mut biases: Vec<ImageBias> = images.iter().map(|im| ImageBias::zero(im.centre, im.half)).collect();
    let mut g = initial_points(images, points, obs, active);
    let used: Vec<bool> = g.iter().map(Option::is_some).collect();
    let mut lambda = 1e-4;
    let mut nm = assemble(images, points, obs, active, &lay, &biases, &g)?;
    let mut iterations = 0;
    let mut converged = false;
    for it in 0..opts.max_iterations {
        iterations = it + 1;
        let mut accepted = false;
        for _ in 0..12 {
            let Some((dp, dx)) = solve_step(&nm, lambda, &used) else {
                lambda *= 10.0;
                continue;
            };
            let (nb, ng) = apply_step(images, &lay, &biases, &g, &dp, &dx);
            let trial = assemble(images, points, obs, active, &lay, &nb, &ng)?;
            if trial.cost <= nm.cost * (1.0 + 1e-12) {
                let rel = (nm.cost - trial.cost) / nm.cost.max(1e-300);
                let step = dp.iter().map(|v| v.abs()).fold(0.0, f64::max).max(dx.iter().flat_map(|d| d.iter()).map(|v| v.abs()).fold(0.0, f64::max));
                biases = nb;
                g = ng;
                nm = trial;
                lambda = (lambda / 10.0).max(1e-12);
                accepted = true;
                if rel < 1e-12 || step < 1e-7 {
                    converged = true;
                }
                break;
            }
            lambda *= 10.0;
        }
        if !accepted || converged {
            converged = converged || !accepted;
            break;
        }
    }
    Ok((biases, g, iterations, converged))
}

/// Solve the block. Checkpoints are adjusted as tie points and compared with their known
/// coordinates before and after.
pub fn adjust(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], opts: &Options) -> Result<Solution> {
    if images.is_empty() || obs.is_empty() {
        return Err(Error::invalid("the block needs images and observations"));
    }
    for o in obs {
        if o.image >= images.len() || o.point >= points.len() || !(o.sigma_px > 0.0) {
            return Err(Error::invalid("observation refers to a missing image or point, or has σ ≤ 0"));
        }
    }
    for p in points {
        if p.kind == PointKind::Gcp && (p.known.is_none() || !(p.sigma_h > 0.0) || !(p.sigma_v > 0.0)) {
            return Err(Error::invalid("a GCP needs known coordinates and σ > 0"));
        }
    }
    let mut active = vec![true; obs.len()];
    let mut rejected = Vec::new();
    let before_pts = initial_points(images, points, obs, &active);
    let checks = |g: &[Option<Ground>]| -> Vec<[f64; 3]> {
        points.iter().enumerate().filter(|(j, p)| p.kind == PointKind::Check && p.known.is_some() && g[*j].is_some()).map(|(j, p)| enu_diff(g[j].unwrap(), p.known.unwrap())).collect()
    };
    let checkpoints_before = axis_stats(&checks(&before_pts));
    loop {
        let (biases, g, iterations, converged) = solve_once(images, points, obs, &active, opts)?;
        let lay = layout(images);
        let used: Vec<bool> = g.iter().map(Option::is_some).collect();
        let nm = assemble(images, points, obs, &active, &lay, &biases, &g)?;
        let unknowns = lay.p + 3 * used.iter().filter(|u| **u).count();
        let dof = nm.nobs as i64 - unknowns as i64;
        let sigma0 = if dof > 0 { (nm.cost / dof as f64).sqrt() } else { 1.0 };
        // Residuals and flags.
        let mut residuals = Vec::with_capacity(obs.len());
        let mut worst: Option<(usize, f64)> = None;
        for (k, o) in obs.iter().enumerate() {
            let v = match g[o.point] {
                Some(gj) => {
                    let (x0, y0) = images[o.image].model.ground_to_image(gj)?;
                    let (x, y) = biases[o.image].apply(x0, y0);
                    (o.x - x, o.y - y)
                }
                None => (f64::NAN, f64::NAN),
            };
            let z = v.0.abs().max(v.1.abs()) / o.sigma_px;
            let flagged = active[k] && z.is_finite() && z > opts.reject_k;
            if flagged && worst.map_or(true, |(_, wz)| z > wz) {
                worst = Some((k, z));
            }
            residuals.push(ObsResult { v, normalized: z, flagged, rejected: !active[k] });
        }
        if let Some((k, _)) = worst {
            if rejected.len() < opts.max_reject {
                active[k] = false;
                rejected.push(k);
                continue;
            }
        }
        // Posterior covariances (undamped).
        let (bias_cov, point_cov) = posterior(&nm, &lay, images, &used, sigma0);
        let gcp_residuals = points.iter().enumerate().filter(|(j, p)| p.kind == PointKind::Gcp && g[*j].is_some()).map(|(j, p)| (j, enu_diff(p.known.unwrap(), g[j].unwrap()))).collect();
        let unused_points = (0..points.len()).filter(|j| g[*j].is_none()).collect();
        return Ok(Solution { biases, bias_cov, points: g.clone(), point_cov, residuals, sigma0, dof, iterations, converged, checkpoints_before: checkpoints_before.clone(), checkpoints_after: axis_stats(&checks(&g)), gcp_residuals, rejected, unused_points });
    }
}

fn posterior(nm: &Normal, lay: &Layout, images: &[ImageIn], used: &[bool], sigma0: f64) -> (Vec<Vec<f64>>, Vec<[[f64; 3]; 3]>) {
    let p = lay.p;
    let np = nm.nxx.len();
    let s2 = sigma0 * sigma0;
    // Schur complement without damping.
    let mut s = nm.npp.clone();
    let mut cinv = vec![[[0.0; 3]; 3]; np];
    for j in 0..np {
        if !used[j] {
            continue;
        }
        if let Some(c) = inv3(&nm.nxx[j]) {
            cinv[j] = c;
        }
        let b = &nm.npx[j];
        for i in 0..p {
            for k in 0..p {
                let mut v = 0.0;
                for a in 0..3 {
                    for c2 in 0..3 {
                        v += b[i * 3 + a] * cinv[j][a][c2] * b[k * 3 + c2];
                    }
                }
                if v != 0.0 {
                    s.add(i, k, -v);
                }
            }
        }
    }
    let sinv = if p > 0 { cholesky(&s).map(|l| chol_inverse(&l)) } else { None };
    let bias_cov = images
        .iter()
        .enumerate()
        .map(|(i, im)| match (lay.off[i], &sinv) {
            (Some(off), Some(si)) => {
                let k = im.kind.len();
                let mut m = vec![0.0; k * k];
                for a in 0..k {
                    for b in 0..k {
                        m[a * k + b] = s2 * si.at(off + a, off + b);
                    }
                }
                m
            }
            _ => Vec::new(),
        })
        .collect();
    let point_cov = (0..np)
        .map(|j| {
            if !used[j] {
                return [[f64::NAN; 3]; 3];
            }
            let c = cinv[j];
            let mut out = c;
            if let Some(si) = &sinv {
                // C⁻¹ Bᵀ S⁻¹ B C⁻¹
                let b = &nm.npx[j];
                let mut bc = vec![0.0; p * 3]; // B C⁻¹
                for i in 0..p {
                    for c2 in 0..3 {
                        bc[i * 3 + c2] = (0..3).map(|k| b[i * 3 + k] * c[k][c2]).sum();
                    }
                }
                for a in 0..3 {
                    for c2 in 0..3 {
                        let mut v = 0.0;
                        for i in 0..p {
                            for k in 0..p {
                                v += bc[i * 3 + a] * si.at(i, k) * bc[k * 3 + c2];
                            }
                        }
                        out[a][c2] += v;
                    }
                }
            }
            out.map(|r| r.map(|v| v * s2))
        })
        .collect();
    (bias_cov, point_cov)
}
