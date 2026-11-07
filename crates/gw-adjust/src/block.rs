//! RPC bias-compensated block adjustment (REQ-SNS-11, `Research/06` §4; Grodecki & Dial 2003):
//! per-image shift, shift + drift or affine corrections in image space, ground points in local
//! metres, GCPs as weighted pseudo-observations with σ, checkpoints left free and compared with
//! their known coordinates afterwards, optional a priori σ on the image parameters,
//! Levenberg–Marquardt with the point blocks eliminated by the Schur complement, σ₀, residuals,
//! posterior covariances and iterative blunder rejection.
//!
//! An image whose model has adjustable sensor parameters (RSM RSMAPA/APB/ECA sets, the CSEPHA
//! pushbroom, frame cameras; REQ-GAP-18/19) can instead be corrected through those parameters:
//! the sensor partials replace the bias partials and the model's parameter covariance (or a
//! given one) is the a priori constraint.
//!
//! Point-cloud registration (REQ-GAP-46) adds a datum shift of the cloud: 3 translations, or 7
//! parameters (translations, three small rotations, scale) in a local level frame about the
//! cloud's centre, with a priori σ. Control generated from the cloud (`PointKind::Lidar`) is a
//! pseudo-observation of the ground point through that shift, so the image corrections and the
//! shift are estimated together. Surveyed points on the cloud (`CloudObs`) observe the shift as a
//! height difference against the cloud surface (with its slope, so a horizontal shift on a slope
//! is seen too). Held-out cloud control (`PointKind::LidarCheck`) and surveyed checkpoints on the
//! cloud are compared before and after.

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
    /// Correct the image through the model's adjustable sensor parameters instead of a bias.
    pub params: bool,
    /// A priori covariance of the sensor parameters (k × k); None = the model's own, if any.
    pub prior_cov: Option<Vec<f64>>,
}

impl ImageIn {
    fn n_params(&self) -> usize {
        if self.params {
            self.model.param_count()
        } else {
            self.kind.len()
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointKind {
    Tie,
    Gcp,
    Check,
    /// Control generated from a point cloud: `known` holds the cloud's coordinates, which reach the
    /// ground through the datum shift (a GCP when there is no shift).
    Lidar,
    /// Cloud control held out of the solve: its image residual before and after is reported.
    LidarCheck,
}

/// The point cloud's datum shift (REQ-GAP-46): k = 0 (none), 3 (ΔE, ΔN, ΔU in metres) or 7 (plus
/// rotations about E, N and U in µrad and a scale in ppm), in the local level frame at `centre`:
/// ground = cloud + Δ + s·q + ω × q, where q is the cloud point relative to the centre (metres).
#[derive(Clone, Debug, Default)]
pub struct DatumIn {
    pub k: usize,
    pub centre: Option<Ground>,
    /// A priori σ per parameter (m, µrad, ppm); 0 = no prior on that parameter.
    pub prior_sigma: Vec<f64>,
}

/// Names and units of the datum parameters.
pub const DATUM_NAMES: [&str; 7] = ["dE (m)", "dN (m)", "dU (m)", "rotation E (µrad)", "rotation N (µrad)", "rotation U (µrad)", "scale (ppm)"];

impl DatumIn {
    /// ∂(E, N, U)/∂θ of the shift at local offset q (rows E, N, U; the first k columns are used).
    pub fn partials(&self, q: [f64; 3]) -> [[f64; 7]; 3] {
        let u = 1e-6;
        let mut a = [[0.0; 7]; 3];
        if self.k >= 3 {
            for (r, row) in a.iter_mut().enumerate() {
                row[r] = 1.0;
            }
        }
        if self.k >= 7 {
            // ω × q = [ωN qU − ωU qN, ωU qE − ωE qU, ωE qN − ωN qE]
            a[1][3] = -q[2] * u;
            a[2][3] = q[1] * u;
            a[0][4] = q[2] * u;
            a[2][4] = -q[0] * u;
            a[0][5] = -q[1] * u;
            a[1][5] = q[0] * u;
            for (r, row) in a.iter_mut().enumerate() {
                row[6] = q[r] * u;
            }
        }
        a
    }
    /// The shift (E, N, U metres) at local offset q for parameters θ.
    pub fn delta(&self, theta: &[f64], q: [f64; 3]) -> [f64; 3] {
        let a = self.partials(q);
        let mut d = [0.0; 3];
        for (r, dr) in d.iter_mut().enumerate() {
            for (m, t) in theta.iter().enumerate().take(self.k) {
                *dr += a[r][m] * t;
            }
        }
        d
    }
    /// Local offset (E, N, U metres) of g from the centre.
    pub fn local(&self, g: Ground) -> [f64; 3] {
        self.centre.map_or([0.0; 3], |c| enu_diff(g, c))
    }
    /// The cloud point g moved by the shift θ.
    pub fn apply(&self, theta: &[f64], g: Ground) -> Ground {
        if self.k == 0 {
            return g;
        }
        let d = self.delta(theta, self.local(g));
        let (dlat, dlon) = deg_per_metre(g);
        Ground { lat: g.lat + d[1] * dlat, lon: g.lon + d[0] * dlon, h: g.h + d[2] }
    }
}

/// A surveyed point on the point cloud (REQ-GAP-46): its true position, and the cloud surface's
/// height and slope there. It observes the datum shift as a height difference.
#[derive(Clone, Copy, Debug)]
pub struct CloudObs {
    pub truth: Ground,
    /// Cloud surface height at the truth's latitude and longitude (in the truth's vertical datum).
    pub z_cloud: f64,
    /// Surface slope (dz/dE, dz/dN).
    pub grad: (f64, f64),
    /// σ of the difference (survey and surface together, m).
    pub sigma: f64,
    /// A checkpoint: compared before and after, not used in the solve.
    pub check: bool,
}

impl CloudObs {
    /// ∂(predicted true height)/∂θ: the shift's U minus the slope times its E and N.
    pub fn row(&self, d: &DatumIn) -> [f64; 7] {
        let a = d.partials(d.local(Ground { h: self.z_cloud, ..self.truth }));
        let mut r = [0.0; 7];
        for (m, v) in r.iter_mut().enumerate().take(d.k) {
            *v = a[2][m] - self.grad.0 * a[0][m] - self.grad.1 * a[1][m];
        }
        r
    }
    /// Truth − (the cloud surface moved by θ), metres.
    pub fn misfit(&self, d: &DatumIn, theta: &[f64]) -> f64 {
        let r = self.row(d);
        self.truth.h - self.z_cloud - (0..d.k.min(theta.len())).map(|m| r[m] * theta[m]).sum::<f64>()
    }
    /// σ of the misfit after the solve: the survey and surface σ plus the shift's covariance.
    pub fn sigma_after(&self, d: &DatumIn, cov: &[f64]) -> f64 {
        let r = self.row(d);
        let k = d.k;
        let mut v = self.sigma * self.sigma;
        if cov.len() == k * k {
            for a in 0..k {
                for b in 0..k {
                    v += r[a] * cov[a * k + b] * r[b];
                }
            }
        }
        v.max(0.0).sqrt()
    }
}

/// The point-cloud part of a joint adjustment.
#[derive(Clone, Debug, Default)]
pub struct Joint {
    pub datum: DatumIn,
    pub cloud: Vec<CloudObs>,
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
    /// Sensor-parameter corrections per image (empty for bias-corrected images).
    pub params: Vec<Vec<f64>>,
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
    /// The datum shift θ (k values) and its posterior covariance (k × k, row-major).
    pub datum: Vec<f64>,
    pub datum_cov: Vec<f64>,
    /// Surveyed points on the cloud, per CloudObs: misfit before, misfit after (m), σ after.
    pub cloud: Vec<(f64, f64, f64)>,
    /// The cloud checkpoints' height statistics (rmse[2], max[2]).
    pub cloud_checks_before: AxisStats,
    pub cloud_checks_after: AxisStats,
    /// Held-out cloud control, per observation: (observation index, ground error (E, N) m before,
    /// after), and their statistics.
    pub lidar_checks: Vec<(usize, [f64; 2], [f64; 2])>,
    pub lidar_checks_before: AxisStats,
    pub lidar_checks_after: AxisStats,
}

pub fn enu_diff(a: Ground, b: Ground) -> [f64; 3] {
    // a − b in local metres at b.
    let (dlat, dlon) = deg_per_metre(b);
    [(a.lon - b.lon) / dlon, (a.lat - b.lat) / dlat, a.h - b.h]
}

pub fn axis_stats(d: &[[f64; 3]]) -> AxisStats {
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
    /// Offset of the datum parameters (None without a datum shift).
    dat: Option<usize>,
    p: usize,
}

fn layout(images: &[ImageIn], datum: &DatumIn) -> Layout {
    let mut off = Vec::with_capacity(images.len());
    let mut p = 0;
    for im in images {
        if im.fixed {
            off.push(None);
        } else {
            off.push(Some(p));
            p += im.n_params();
        }
    }
    let dat = (datum.k > 0).then_some(p);
    p += datum.k;
    Layout { off, dat, p }
}

/// Initial ground points: GCPs at their known coordinates, the others intersected with the
/// unadjusted models.
fn initial_points(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], active: &[bool]) -> Vec<Option<Ground>> {
    let mut out = vec![None; points.len()];
    for (j, p) in points.iter().enumerate() {
        if p.kind == PointKind::LidarCheck {
            continue;
        }
        let mine: Vec<&ObsIn> = obs.iter().enumerate().filter(|(k, o)| active[*k] && o.point == j).map(|(_, o)| o).collect();
        if matches!(p.kind, PointKind::Gcp | PointKind::Lidar) {
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

/// The current corrections: a bias per image, and for sensor-parameter images the corrections and
/// the corrected model.
#[derive(Clone)]
struct State {
    biases: Vec<ImageBias>,
    params: Vec<Vec<f64>>,
    models: Vec<Rc<dyn SensorModel>>,
    datum: Vec<f64>,
}

impl State {
    fn new(images: &[ImageIn], datum: &DatumIn) -> State {
        State {
            biases: images.iter().map(|im| ImageBias::zero(im.centre, im.half)).collect(),
            params: images.iter().map(|im| if im.params { vec![0.0; im.model.param_count()] } else { Vec::new() }).collect(),
            models: images.iter().map(|im| im.model.clone()).collect(),
            datum: vec![0.0; datum.k],
        }
    }
}

/// Inverse of an a priori covariance (k × k) as an information matrix; the diagonal only when
/// the covariance is not positive definite.
fn information(c: &[f64], k: usize) -> Vec<f64> {
    let mut m = Mat::zeros(k);
    for i in 0..k {
        for j in 0..k {
            m.set(i, j, c[i * k + j]);
        }
    }
    if let Some(l) = cholesky(&m) {
        return chol_inverse(&l).a;
    }
    let mut w = vec![0.0; k * k];
    for i in 0..k {
        let d = c[i * k + i];
        if d > 0.0 {
            w[i * k + i] = 1.0 / d;
        }
    }
    w
}

#[allow(clippy::too_many_arguments)]
fn assemble(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], joint: &Joint, active: &[bool], lay: &Layout, st: &State, g: &[Option<Ground>]) -> Result<Normal> {
    let biases = &st.biases;
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
        let model = &st.models[o.image];
        let (x0, y0) = model.ground_to_image(gj)?;
        let (x, y) = if im.params { (x0, y0) } else { b.apply(x0, y0) };
        let r = [o.x - x, o.y - y];
        let w = 1.0 / (o.sigma_px * o.sigma_px);
        nm.cost += w * (r[0] * r[0] + r[1] * r[1]);
        nm.nobs += 2;
        let jb = enu_partials(&**model, gj)?;
        // Chain through the bias: ∂(x, y)/∂(x₀, y₀) = I + D.
        let (hx, hy) = b.half;
        let d = if im.params { [[1.0, 0.0], [0.0, 1.0]] } else { [[1.0 + b.c[4] / hx, b.c[5] / hy], [b.c[1] / hx, 1.0 + b.c[2] / hy]] };
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
            if im.params {
                for (q, d) in model.param_partials(gj)?.into_iter().enumerate() {
                    jp.push((off + q, d));
                }
            } else {
                for (q, &t) in im.kind.terms().iter().enumerate() {
                    let val = basis(t, u, v);
                    jp.push((off + q, if t < 3 { [0.0, val] } else { [val, 0.0] }));
                }
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
    // GCP pseudo-observations on the points; cloud control through the datum shift.
    let datum = &joint.datum;
    for (j, pt) in points.iter().enumerate() {
        if !matches!(pt.kind, PointKind::Gcp | PointKind::Lidar) {
            continue;
        }
        let (Some(k), Some(gj)) = (pt.known, g[j]) else { continue };
        let shifted = pt.kind == PointKind::Lidar && lay.dat.is_some();
        let target = if shifted { datum.apply(&st.datum, k) } else { k };
        let r = enu_diff(target, gj);
        let w = [1.0 / (pt.sigma_h * pt.sigma_h), 1.0 / (pt.sigma_h * pt.sigma_h), 1.0 / (pt.sigma_v * pt.sigma_v)];
        for a in 0..3 {
            nm.nxx[j][a][a] += w[a];
            nm.bx[j][a] += w[a] * r[a];
            nm.cost += w[a] * r[a] * r[a];
        }
        nm.nobs += 3;
        if let (true, Some(d0)) = (shifted, lay.dat) {
            // Predicted pseudo-observation X − T(θ)·L: ∂/∂X = I, ∂/∂θ = −A.
            let a = datum.partials(datum.local(k));
            for m in 0..datum.k {
                for c in 0..3 {
                    if a[c][m] == 0.0 {
                        continue;
                    }
                    nm.bp[d0 + m] -= a[c][m] * w[c] * r[c];
                    nm.npx[j][(d0 + m) * 3 + c] -= a[c][m] * w[c];
                    for m2 in 0..datum.k {
                        nm.npp.add(d0 + m, d0 + m2, a[c][m] * w[c] * a[c][m2]);
                    }
                }
            }
        }
    }
    if let Some(d0) = lay.dat {
        // Surveyed points on the cloud: height misfits, linear in θ.
        for co in joint.cloud.iter().filter(|c| !c.check) {
            let row = co.row(datum);
            let r = co.misfit(datum, &st.datum);
            let w = 1.0 / (co.sigma * co.sigma);
            for m in 0..datum.k {
                nm.bp[d0 + m] += row[m] * w * r;
                for m2 in 0..datum.k {
                    nm.npp.add(d0 + m, d0 + m2, row[m] * w * row[m2]);
                }
            }
            nm.cost += w * r * r;
            nm.nobs += 1;
        }
        // A priori σ of the shift (about zero).
        for m in 0..datum.k {
            let s = datum.prior_sigma.get(m).copied().unwrap_or(0.0);
            if s > 0.0 {
                let w = 1.0 / (s * s);
                let v = st.datum[m];
                nm.npp.add(d0 + m, d0 + m, w);
                nm.bp[d0 + m] -= w * v;
                nm.cost += w * v * v;
                nm.nobs += 1;
            }
        }
    }
    // A priori σ on the image parameters.
    for (i, im) in images.iter().enumerate() {
        let Some(off) = lay.off[i] else { continue };
        if im.params {
            // The sensor parameters' a priori covariance: pᵀ W p on the corrections.
            let k = im.model.param_count();
            let Some(c) = im.prior_cov.clone().or_else(|| im.model.param_covariance()).filter(|c| c.len() == k * k) else { continue };
            let wm = information(&c, k);
            let p = &st.params[i];
            for a in 0..k {
                for b2 in 0..k {
                    let wv = wm[a * k + b2];
                    if wv == 0.0 {
                        continue;
                    }
                    nm.npp.add(off + a, off + b2, wv);
                    nm.bp[off + a] -= wv * p[b2];
                    nm.cost += p[a] * wv * p[b2];
                }
            }
            nm.nobs += k;
            continue;
        }
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

fn apply_step(images: &[ImageIn], lay: &Layout, st: &State, g: &[Option<Ground>], dp: &[f64], dx: &[[f64; 3]]) -> Result<(State, Vec<Option<Ground>>)> {
    let mut ns = st.clone();
    for (i, im) in images.iter().enumerate() {
        if let Some(off) = lay.off[i] {
            if im.params {
                for (q, v) in ns.params[i].iter_mut().enumerate() {
                    *v += dp[off + q];
                }
                ns.models[i] = Rc::from(im.model.with_params(&ns.params[i])?);
            } else {
                for (q, &t) in im.kind.terms().iter().enumerate() {
                    ns.biases[i].c[t] += dp[off + q];
                }
            }
        }
    }
    if let Some(d0) = lay.dat {
        for (m, v) in ns.datum.iter_mut().enumerate() {
            *v += dp[d0 + m];
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
    Ok((ns, ng))
}

fn solve_once(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], joint: &Joint, active: &[bool], opts: &Options) -> Result<(State, Vec<Option<Ground>>, usize, bool)> {
    let lay = layout(images, &joint.datum);
    let mut st = State::new(images, &joint.datum);
    let mut g = initial_points(images, points, obs, active);
    let used: Vec<bool> = g.iter().map(Option::is_some).collect();
    let mut lambda = 1e-4;
    let mut nm = assemble(images, points, obs, joint, active, &lay, &st, &g)?;
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
            let Ok((nb, ng)) = apply_step(images, &lay, &st, &g, &dp, &dx) else {
                lambda *= 10.0;
                continue;
            };
            let Ok(trial) = assemble(images, points, obs, joint, active, &lay, &nb, &ng) else {
                lambda *= 10.0;
                continue;
            };
            if trial.cost <= nm.cost * (1.0 + 1e-12) {
                let rel = (nm.cost - trial.cost) / nm.cost.max(1e-300);
                let step = dp.iter().map(|v| v.abs()).fold(0.0, f64::max).max(dx.iter().flat_map(|d| d.iter()).map(|v| v.abs()).fold(0.0, f64::max));
                st = nb;
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
    Ok((st, g, iterations, converged))
}

/// Ground error (E, N metres) of a held-out cloud-control observation in state `st`: the image
/// residual (measured − predicted at the shifted cloud point) through the inverse of the model's
/// horizontal ground partials.
fn lidar_check_error(images: &[ImageIn], st: &State, datum: &DatumIn, known: Ground, o: &ObsIn) -> Option<[f64; 2]> {
    let g = datum.apply(&st.datum, known);
    let m = &st.models[o.image];
    let (x0, y0) = m.ground_to_image(g).ok()?;
    let (x, y) = if images[o.image].params { (x0, y0) } else { st.biases[o.image].apply(x0, y0) };
    let (vx, vy) = (o.x - x, o.y - y);
    let j = enu_partials(&**m, g).ok()?;
    let det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    if !det.is_finite() || det.abs() < 1e-30 {
        return None;
    }
    Some([(j[1][1] * vx - j[0][1] * vy) / det, (-j[1][0] * vx + j[0][0] * vy) / det])
}

/// Solve the block. Checkpoints are adjusted as tie points and compared with their known
/// coordinates before and after.
pub fn adjust(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], opts: &Options) -> Result<Solution> {
    adjust_joint(images, points, obs, &Joint::default(), opts)
}

/// Solve the block together with a point cloud's datum shift and its surveyed points (REQ-GAP-46).
pub fn adjust_joint(images: &[ImageIn], points: &[PointIn], obs: &[ObsIn], joint: &Joint, opts: &Options) -> Result<Solution> {
    if images.is_empty() || obs.is_empty() {
        return Err(Error::invalid("the block needs images and observations"));
    }
    for o in obs {
        if o.image >= images.len() || o.point >= points.len() || !(o.sigma_px > 0.0) || !o.x.is_finite() || !o.y.is_finite() {
            return Err(Error::invalid("observation refers to a missing image or point, or has σ ≤ 0"));
        }
    }
    for p in points {
        if matches!(p.kind, PointKind::Gcp | PointKind::Lidar) && (p.known.is_none() || !(p.sigma_h > 0.0) || !(p.sigma_v > 0.0)) {
            return Err(Error::invalid("a GCP needs known coordinates and σ > 0"));
        }
        if p.kind == PointKind::LidarCheck && p.known.is_none() {
            return Err(Error::invalid("a cloud checkpoint needs its cloud coordinates"));
        }
    }
    let datum = &joint.datum;
    if !matches!(datum.k, 0 | 3 | 7) {
        return Err(Error::invalid("the datum shift has 0, 3 or 7 parameters"));
    }
    if datum.k > 0 && datum.centre.is_none() {
        return Err(Error::invalid("the datum shift needs the cloud's centre"));
    }
    if datum.prior_sigma.iter().any(|s| !(s.is_finite() && *s >= 0.0)) {
        return Err(Error::invalid("a datum a priori σ is negative or not finite"));
    }
    if joint.cloud.iter().any(|c| !(c.sigma > 0.0) || !c.z_cloud.is_finite() || !c.truth.h.is_finite() || !c.grad.0.is_finite() || !c.grad.1.is_finite()) {
        return Err(Error::invalid("a surveyed cloud point needs a cloud height, a slope and σ > 0"));
    }
    let mut active = vec![true; obs.len()];
    let mut rejected = Vec::new();
    let before_pts = initial_points(images, points, obs, &active);
    let checks = |g: &[Option<Ground>]| -> Vec<[f64; 3]> {
        points.iter().enumerate().filter(|(j, p)| p.kind == PointKind::Check && p.known.is_some() && g[*j].is_some()).map(|(j, p)| enu_diff(g[j].unwrap(), p.known.unwrap())).collect()
    };
    let checkpoints_before = axis_stats(&checks(&before_pts));
    let st0 = State::new(images, datum);
    let lidar_obs: Vec<usize> = (0..obs.len()).filter(|&k| points[obs[k].point].kind == PointKind::LidarCheck).collect();
    loop {
        let (st, g, iterations, converged) = solve_once(images, points, obs, joint, &active, opts)?;
        let lay = layout(images, datum);
        let used: Vec<bool> = g.iter().map(Option::is_some).collect();
        let nm = assemble(images, points, obs, joint, &active, &lay, &st, &g)?;
        let unknowns = lay.p + 3 * used.iter().filter(|u| **u).count();
        let dof = nm.nobs as i64 - unknowns as i64;
        let sigma0 = if dof > 0 { (nm.cost / dof as f64).sqrt() } else { 1.0 };
        // Residuals and flags.
        let mut residuals = Vec::with_capacity(obs.len());
        let mut worst: Option<(usize, f64)> = None;
        for (k, o) in obs.iter().enumerate() {
            let v = match g[o.point] {
                Some(gj) => {
                    let (x0, y0) = st.models[o.image].ground_to_image(gj)?;
                    let (x, y) = if images[o.image].params { (x0, y0) } else { st.biases[o.image].apply(x0, y0) };
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
        let (bias_cov, point_cov, datum_cov) = posterior(&nm, &lay, images, &used, sigma0);
        let gcp_residuals = points.iter().enumerate().filter(|(j, p)| p.kind == PointKind::Gcp && g[*j].is_some()).map(|(j, p)| (j, enu_diff(p.known.unwrap(), g[j].unwrap()))).collect();
        let unused_points = (0..points.len()).filter(|j| g[*j].is_none() && points[*j].kind != PointKind::LidarCheck).collect();
        // Surveyed points on the cloud.
        let cloud: Vec<(f64, f64, f64)> = joint.cloud.iter().map(|c| (c.misfit(datum, &st0.datum), c.misfit(datum, &st.datum), c.sigma_after(datum, &datum_cov))).collect();
        let zstats = |after: bool| axis_stats(&joint.cloud.iter().zip(&cloud).filter(|(c, _)| c.check).map(|(_, r)| [0.0, 0.0, if after { r.1 } else { r.0 }]).collect::<Vec<_>>());
        // Held-out cloud control.
        let mut lidar_checks = Vec::new();
        for &k in &lidar_obs {
            let o = &obs[k];
            let known = points[o.point].known.unwrap();
            if let (Some(b), Some(a)) = (lidar_check_error(images, &st0, datum, known, o), lidar_check_error(images, &st, datum, known, o)) {
                lidar_checks.push((k, b, a));
            }
        }
        let lstats = |after: bool| axis_stats(&lidar_checks.iter().map(|(_, b, a)| if after { [a[0], a[1], 0.0] } else { [b[0], b[1], 0.0] }).collect::<Vec<_>>());
        return Ok(Solution {
            biases: st.biases.clone(),
            params: st.params.clone(),
            bias_cov,
            points: g.clone(),
            point_cov,
            residuals,
            sigma0,
            dof,
            iterations,
            converged,
            checkpoints_before: checkpoints_before.clone(),
            checkpoints_after: axis_stats(&checks(&g)),
            gcp_residuals,
            rejected,
            unused_points,
            datum: st.datum.clone(),
            datum_cov,
            cloud_checks_before: zstats(false),
            cloud_checks_after: zstats(true),
            cloud,
            lidar_checks_before: lstats(false),
            lidar_checks_after: lstats(true),
            lidar_checks,
        });
    }
}

#[allow(clippy::type_complexity)]
fn posterior(nm: &Normal, lay: &Layout, images: &[ImageIn], used: &[bool], sigma0: f64) -> (Vec<Vec<f64>>, Vec<[[f64; 3]; 3]>, Vec<f64>) {
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
                let k = im.n_params();
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
    let datum_cov = match (lay.dat, &sinv) {
        (Some(d0), Some(si)) => {
            let k = p - d0;
            let mut m = vec![0.0; k * k];
            for a in 0..k {
                for b in 0..k {
                    m[a * k + b] = s2 * si.at(d0 + a, d0 + b);
                }
            }
            m
        }
        _ => Vec::new(),
    };
    (bias_cov, point_cov, datum_cov)
}
