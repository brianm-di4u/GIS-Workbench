//! Bundle adjustment with ground control (REG-075): camera poses and points are adjusted so that
//! the points reproject onto their observations and the ground control points stay on their survey,
//! each weighted by its sigma.
//!
//! The lens can be adjusted with them (`Calib`): one set of intrinsics for the block, each parameter
//! free, held, or tied to its starting value by a sigma. A near-nadir block fixes its radial
//! distortion and focal length only weakly from tie points, and what is left over is a bend of the
//! whole block (a dome) that no similarity takes out; the control points decide it. The focal length
//! and the flying height still trade off on flat ground, which is why the focal length keeps a prior:
//! with control the ground is fixed by the control, not by that trade.
//!
//! Levenberg-Marquardt with the points eliminated (Schur complement), so the system solved each
//! step is 6 x cameras (+ the lens parameters) square: a dense Cholesky, fine for blocks of hundreds
//! of photographs.

use crate::colmap::Camera;
use crate::geo::{add, mat_mul, mat_vec, rodrigues, sub, transpose, M3, V3};

/// One camera's pose: world to camera `p = r (x - c)`, and its intrinsics.
#[derive(Debug, Clone)]
pub struct Pose {
    pub r: M3,
    pub c: V3,
    pub intr: Camera,
}

#[derive(Debug, Clone, Copy)]
pub struct Obs {
    pub cam: usize,
    pub pt: usize,
    pub xy: [f64; 2],
    /// Standard deviation of the observation in pixels.
    pub sigma: f64,
    /// Whether the Huber loss applies. Tie points are matched by machine and some are wrong; a
    /// mark of a control point is placed by a person and is what the block must follow, so it
    /// counts in full however far off it starts.
    pub robust: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct Prior {
    pub pt: usize,
    pub at: V3,
    /// Standard deviation of the survey in metres.
    pub sigma: f64,
}

/// The lens adjusted with the block: every pose shares one camera, and parameter `k` of it is held
/// when `sigma[k]` is 0, free when it is infinite, and otherwise tied to `start[k]` by that sigma.
#[derive(Debug, Clone)]
pub struct Calib {
    pub start: Vec<f64>,
    pub sigma: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct Problem {
    pub cams: Vec<Pose>,
    pub pts: Vec<V3>,
    pub obs: Vec<Obs>,
    pub priors: Vec<Prior>,
    pub calib: Option<Calib>,
}

#[derive(Debug, Clone)]
pub struct Stats {
    pub iterations: usize,
    pub cost_before: f64,
    pub cost_after: f64,
    /// Root mean square reprojection error in pixels, over the observations used.
    pub rms_px_before: f64,
    pub rms_px_after: f64,
}

/// Huber threshold, in standard deviations.
const HUBER: f64 = 2.0;

/// The camera's distortion of a normalised image point (COLMAP models 0 to 4).
fn distort(c: &Camera, x: f64, y: f64) -> [f64; 2] {
    let p = &c.params;
    let (k1, k2, p1, p2) = match c.model {
        2 => (p[3], 0.0, 0.0, 0.0),
        3 => (p[3], p[4], 0.0, 0.0),
        4 => (p[4], p[5], p[6], p[7]),
        _ => (0.0, 0.0, 0.0, 0.0),
    };
    let r2 = x * x + y * y;
    let radial = 1.0 + k1 * r2 + k2 * r2 * r2;
    [
        x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x),
        y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y,
    ]
}

fn focal(c: &Camera) -> [f64; 4] {
    let p = &c.params;
    match c.model {
        1 | 4 => [p[0], p[1], p[2], p[3]],
        _ => [p[0], p[0], p[1], p[2]],
    }
}

/// Pixel of a camera-frame point, and d pixel / d point (2 x 3). None behind the camera.
fn project(c: &Camera, p: V3) -> Option<([f64; 2], [[f64; 3]; 2])> {
    if p[2] <= 1e-9 {
        return None;
    }
    let (u, v) = (p[0] / p[2], p[1] / p[2]);
    let [fx, fy, cx, cy] = focal(c);
    let d = distort(c, u, v);
    // The 2 x 2 Jacobian of the distortion, by central differences (exact enough, any model).
    let h = 1e-7;
    let du = [distort(c, u + h, v), distort(c, u - h, v)];
    let dv = [distort(c, u, v + h), distort(c, u, v - h)];
    let jd = [
        [
            (du[0][0] - du[1][0]) / (2.0 * h),
            (dv[0][0] - dv[1][0]) / (2.0 * h),
        ],
        [
            (du[0][1] - du[1][1]) / (2.0 * h),
            (dv[0][1] - dv[1][1]) / (2.0 * h),
        ],
    ];
    let ju = [[1.0 / p[2], 0.0, -u / p[2]], [0.0, 1.0 / p[2], -v / p[2]]];
    let mut j = [[0.0; 3]; 2];
    for (a, row) in j.iter_mut().enumerate() {
        let f = if a == 0 { fx } else { fy };
        for (b, cell) in row.iter_mut().enumerate() {
            *cell = f * (jd[a][0] * ju[0][b] + jd[a][1] * ju[1][b]);
        }
    }
    Some(([fx * d[0] + cx, fy * d[1] + cy], j))
}

/// Pixel of a camera-frame point. None behind the camera.
pub fn pixel(c: &Camera, p: V3) -> Option<[f64; 2]> {
    if p[2] <= 1e-9 {
        return None;
    }
    let [fx, fy, cx, cy] = focal(c);
    let d = distort(c, p[0] / p[2], p[1] / p[2]);
    Some([fx * d[0] + cx, fy * d[1] + cy])
}

/// The lens parameters being adjusted (indices into the camera parameters), and for each the
/// camera with that parameter stepped down and up, and the step: for central differences.
fn steps(pr: &Problem) -> Vec<(usize, Camera, Camera, f64)> {
    let (Some(cal), Some(first)) = (&pr.calib, pr.cams.first()) else {
        return vec![];
    };
    (0..cal.sigma.len().min(first.intr.params.len()))
        .filter(|k| cal.sigma[*k] > 0.0)
        .map(|k| {
            let h = 1e-6 * first.intr.params[k].abs().max(1.0);
            let (mut lo, mut hi) = (first.intr.clone(), first.intr.clone());
            lo.params[k] -= h;
            hi.params[k] += h;
            (k, lo, hi, h)
        })
        .collect()
}

fn skew(v: V3) -> M3 {
    [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]]
}

/// Residual (whitened, robust-weighted) and its Jacobians for one observation:
/// d / d camera (rotation increment, centre) 2 x 6, d / d point 2 x 3, d / d each lens parameter.
fn linearise(pr: &Problem, o: &Obs, lens: &[(usize, Camera, Camera, f64)]) -> Option<([f64; 2], [[f64; 6]; 2], [[f64; 3]; 2], Vec<[f64; 2]>)> {
    let cam = &pr.cams[o.cam];
    let x = pr.pts[o.pt];
    let p = mat_vec(&cam.r, sub(x, cam.c));
    let (px, jp) = project(&cam.intr, p)?;
    let r = [(px[0] - o.xy[0]) / o.sigma, (px[1] - o.xy[1]) / o.sigma];
    let e = (r[0] * r[0] + r[1] * r[1]).sqrt();
    let w = if !o.robust || e <= HUBER { 1.0 } else { (HUBER / e).sqrt() };
    // p' = exp(dw) r (x - c): dp/dw = -[p]x; dp/dc = -r; dp/dx = r.
    let dw = skew(p).map(|row| row.map(|v| -v));
    let mut jc = [[0.0; 6]; 2];
    let mut jx = [[0.0; 3]; 2];
    for a in 0..2 {
        for b in 0..3 {
            let mut sw = 0.0;
            let mut sr = 0.0;
            for k in 0..3 {
                sw += jp[a][k] * dw[k][b];
                sr += jp[a][k] * cam.r[k][b];
            }
            jc[a][b] = w * sw / o.sigma;
            jc[a][3 + b] = -w * sr / o.sigma;
            jx[a][b] = w * sr / o.sigma;
        }
    }
    let mut ji = Vec::with_capacity(lens.len());
    for (_, lo, hi, h) in lens {
        let (a, b) = (pixel(lo, p)?, pixel(hi, p)?);
        let k = w / (2.0 * h * o.sigma);
        ji.push([(b[0] - a[0]) * k, (b[1] - a[1]) * k]);
    }
    Some(([w * r[0], w * r[1]], jc, jx, ji))
}

/// Total robust cost (observations plus priors), and the plain RMS reprojection in pixels.
pub fn cost(pr: &Problem) -> (f64, f64) {
    let mut c = 0.0;
    let mut sq = 0.0;
    let mut n = 0usize;
    for o in &pr.obs {
        let cam = &pr.cams[o.cam];
        match project(&cam.intr, mat_vec(&cam.r, sub(pr.pts[o.pt], cam.c))) {
            Some((px, _)) => {
                let d2 = (px[0] - o.xy[0]).powi(2) + (px[1] - o.xy[1]).powi(2);
                let e = d2.sqrt() / o.sigma;
                c += if !o.robust || e <= HUBER {
                    e * e
                } else {
                    2.0 * HUBER * e - HUBER * HUBER
                };
                sq += d2;
                n += 1;
            }
            None => c += 1e6,
        }
    }
    for p in &pr.priors {
        let d = sub(pr.pts[p.pt], p.at);
        c += (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / (p.sigma * p.sigma);
    }
    if let (Some(cal), Some(first)) = (&pr.calib, pr.cams.first()) {
        for (k, v) in first.intr.params.iter().enumerate() {
            let s = cal.sigma.get(k).copied().unwrap_or(0.0);
            if s > 0.0 && s.is_finite() {
                c += ((v - cal.start[k]) / s).powi(2);
            }
        }
    }
    (c, (sq / n.max(1) as f64).sqrt())
}

fn cholesky_solve(a: &mut [f64], b: &mut [f64], n: usize) -> bool {
    for j in 0..n {
        let mut d = a[j * n + j];
        for k in 0..j {
            d -= a[j * n + k] * a[j * n + k];
        }
        if d <= 0.0 || !d.is_finite() {
            return false;
        }
        let d = d.sqrt();
        a[j * n + j] = d;
        for i in j + 1..n {
            let mut s = a[i * n + j];
            for k in 0..j {
                s -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = s / d;
        }
    }
    for i in 0..n {
        let mut s = b[i];
        for k in 0..i {
            s -= a[i * n + k] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    for i in (0..n).rev() {
        let mut s = b[i];
        for k in i + 1..n {
            s -= a[k * n + i] * b[k];
        }
        b[i] = s / a[i * n + i];
    }
    true
}

fn inv3(m: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-300 || !det.is_finite() {
        return None;
    }
    let c = |a: usize, b: usize, cc: usize, d: usize| m[a][b] * m[cc][d] - m[a][d] * m[cc][b];
    Some([
        [
            c(1, 1, 2, 2) / det,
            -c(0, 1, 2, 2) / det,
            c(0, 1, 1, 2) / det,
        ],
        [
            -c(1, 0, 2, 2) / det,
            c(0, 0, 2, 2) / det,
            -c(0, 0, 1, 2) / det,
        ],
        [
            c(1, 0, 2, 1) / det,
            -c(0, 0, 2, 1) / det,
            c(0, 0, 1, 1) / det,
        ],
    ])
}

/// What one point contributes to the reduced system: V (3 x 3), its gradient, the camera block
/// of W for each observation (6 x 3), and the lens block of W (one row per lens parameter).
type PointBlock = ([[f64; 3]; 3], [f64; 3], Vec<(usize, [[f64; 3]; 6])>, Vec<[f64; 3]>);

/// Adjust the problem in place. Points seen fewer than twice and without a prior are held.
pub fn adjust(pr: &mut Problem, max_iter: usize) -> Stats {
    let nc = pr.cams.len();
    let n6 = 6 * nc;
    let (cost0, rms0) = cost(pr);
    let mut current = cost0;
    let mut lambda = 1e-3;
    let mut by_pt: Vec<Vec<usize>> = vec![Vec::new(); pr.pts.len()];
    for (k, o) in pr.obs.iter().enumerate() {
        by_pt[o.pt].push(k);
    }
    let prior_of: std::collections::HashMap<usize, Prior> = pr.priors.iter().map(|p| (p.pt, *p)).collect();
    let free: Vec<bool> = (0..pr.pts.len()).map(|p| by_pt[p].len() >= 2 || prior_of.contains_key(&p)).collect();
    let mut iterations = 0;
    for _ in 0..max_iter {
        iterations += 1;
        let lens = steps(pr);
        let m = lens.len();
        let n = n6 + m;
        let mut u = vec![0.0; n * n];
        let mut gc = vec![0.0; n];
        let mut solved: Vec<Option<PointBlock>> = Vec::with_capacity(pr.pts.len());
        for p in 0..pr.pts.len() {
            if !free[p] {
                solved.push(None);
                continue;
            }
            let mut v = [[0.0; 3]; 3];
            let mut gp = [0.0; 3];
            let mut ws: Vec<(usize, [[f64; 3]; 6])> = Vec::new();
            let mut wl = vec![[0.0; 3]; m];
            for &k in &by_pt[p] {
                let o = pr.obs[k];
                let Some((r, jc, jx, ji)) = linearise(pr, &o, &lens) else {
                    continue;
                };
                let base = 6 * o.cam;
                for a in 0..6 {
                    for b in 0..6 {
                        u[(base + a) * n + base + b] += jc[0][a] * jc[0][b] + jc[1][a] * jc[1][b];
                    }
                    gc[base + a] += jc[0][a] * r[0] + jc[1][a] * r[1];
                    for (k, j) in ji.iter().enumerate() {
                        let x = jc[0][a] * j[0] + jc[1][a] * j[1];
                        u[(base + a) * n + n6 + k] += x;
                        u[(n6 + k) * n + base + a] += x;
                    }
                }
                for (k, j) in ji.iter().enumerate() {
                    for (l, i) in ji.iter().enumerate() {
                        u[(n6 + k) * n + n6 + l] += j[0] * i[0] + j[1] * i[1];
                    }
                    gc[n6 + k] += j[0] * r[0] + j[1] * r[1];
                    for b in 0..3 {
                        wl[k][b] += j[0] * jx[0][b] + j[1] * jx[1][b];
                    }
                }
                let mut w = [[0.0; 3]; 6];
                for a in 0..6 {
                    for b in 0..3 {
                        w[a][b] = jc[0][a] * jx[0][b] + jc[1][a] * jx[1][b];
                    }
                }
                for a in 0..3 {
                    for b in 0..3 {
                        v[a][b] += jx[0][a] * jx[0][b] + jx[1][a] * jx[1][b];
                    }
                    gp[a] += jx[0][a] * r[0] + jx[1][a] * r[1];
                }
                ws.push((o.cam, w));
            }
            if let Some(pri) = prior_of.get(&p) {
                let d = sub(pr.pts[p], pri.at);
                let w2 = 1.0 / (pri.sigma * pri.sigma);
                for a in 0..3 {
                    v[a][a] += w2;
                    gp[a] += w2 * d[a];
                }
            }
            solved.push(Some((v, gp, ws, wl)));
        }
        // What ties each lens parameter to its starting value.
        if let Some(cal) = &pr.calib {
            for (k, (idx, ..)) in lens.iter().enumerate() {
                let s = cal.sigma[*idx];
                if s.is_finite() {
                    u[(n6 + k) * n + n6 + k] += 1.0 / (s * s);
                    gc[n6 + k] += (pr.cams[0].intr.params[*idx] - cal.start[*idx]) / (s * s);
                }
            }
        }
        // Try steps until one lowers the cost (or lambda runs away).
        let mut accepted = false;
        for _ in 0..10 {
            let mut s = u.clone();
            let mut rhs: Vec<f64> = gc.iter().map(|g| -g).collect();
            for i in 0..n {
                s[i * n + i] += lambda * s[i * n + i].max(1e-9) + 1e-12;
            }
            let mut point_steps: Vec<Option<([[f64; 3]; 3], [f64; 3])>> = Vec::with_capacity(pr.pts.len());
            for sp in &solved {
                let Some((v, gp, ws, wl)) = sp else {
                    point_steps.push(None);
                    continue;
                };
                let mut vd = *v;
                for (a, row) in vd.iter_mut().enumerate() {
                    row[a] += lambda * v[a][a].max(1e-9) + 1e-12;
                }
                let Some(vi) = inv3(&vd) else {
                    point_steps.push(None);
                    continue;
                };
                // rhs -= W V^-1 (-g_p); S -= W V^-1 W^T, the rows of W being the cameras and the lens.
                let vg = [0, 1, 2].map(|a| -(vi[a][0] * gp[0] + vi[a][1] * gp[1] + vi[a][2] * gp[2]));
                let times_vi = |w: &[f64; 3]| [0, 1, 2].map(|b| w[0] * vi[0][b] + w[1] * vi[1][b] + w[2] * vi[2][b]);
                let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
                let lvi: Vec<[f64; 3]> = wl.iter().map(times_vi).collect();
                for (k, row) in lvi.iter().enumerate() {
                    rhs[n6 + k] += dot(row, gp);
                    for (l, w) in wl.iter().enumerate() {
                        s[(n6 + k) * n + n6 + l] -= dot(row, w);
                    }
                }
                for (ci, w) in ws {
                    let mvi = w.map(|row| times_vi(&row));
                    for a in 0..6 {
                        rhs[6 * ci + a] += dot(&mvi[a], gp);
                        for (k, l) in wl.iter().enumerate() {
                            let x = dot(&mvi[a], l);
                            s[(6 * ci + a) * n + n6 + k] -= x;
                            s[(n6 + k) * n + 6 * ci + a] -= x;
                        }
                    }
                    for (cj, wj) in ws {
                        for a in 0..6 {
                            for b in 0..6 {
                                s[(6 * ci + a) * n + 6 * cj + b] -= dot(&mvi[a], &wj[b]);
                            }
                        }
                    }
                }
                point_steps.push(Some((vi, vg)));
            }
            if !cholesky_solve(&mut s, &mut rhs, n) {
                lambda *= 10.0;
                continue;
            }
            // Back-substitute the points: dp = V^-1 (-g_p - W^T dc).
            let mut trial = pr.clone();
            for (ci, cam) in trial.cams.iter_mut().enumerate() {
                let d = &rhs[6 * ci..6 * ci + 6];
                cam.r = mat_mul(&rodrigues([d[0], d[1], d[2]]), &cam.r);
                cam.c = add(cam.c, [d[3], d[4], d[5]]);
                for (k, (idx, ..)) in lens.iter().enumerate() {
                    cam.intr.params[*idx] += rhs[n6 + k];
                }
            }
            for (p, step) in point_steps.iter().enumerate() {
                let (Some((vi, vg)), Some((_, _, ws, wl))) = (step, &solved[p]) else {
                    continue;
                };
                let mut wt = [0.0; 3];
                for (c, w) in ws {
                    for b in 0..3 {
                        for a in 0..6 {
                            wt[b] += w[a][b] * rhs[6 * c + a];
                        }
                    }
                }
                for (k, l) in wl.iter().enumerate() {
                    for b in 0..3 {
                        wt[b] += l[b] * rhs[n6 + k];
                    }
                }
                let dp = [0, 1, 2].map(|a| vg[a] - (vi[a][0] * wt[0] + vi[a][1] * wt[1] + vi[a][2] * wt[2]));
                trial.pts[p] = add(trial.pts[p], dp);
            }
            let (c, _) = cost(&trial);
            if c < current {
                let gain = (current - c) / current.max(1e-300);
                *pr = trial;
                current = c;
                lambda = (lambda / 3.0).max(1e-9);
                accepted = true;
                if gain < 1e-9 {
                    return finish(pr, iterations, cost0, rms0);
                }
                break;
            }
            lambda *= 5.0;
        }
        if !accepted {
            break;
        }
    }
    finish(pr, iterations, cost0, rms0)
}

fn finish(pr: &Problem, iterations: usize, cost_before: f64, rms_px_before: f64) -> Stats {
    let (cost_after, rms_px_after) = cost(pr);
    Stats {
        iterations,
        cost_before,
        cost_after,
        rms_px_before,
        rms_px_after,
    }
}

/// World to camera rotation of a camera after a world-frame similarity `y = s q x + t`, given its
/// rotation in the old frame (the centre maps with the similarity itself).
pub fn rotate_into(r_old: &M3, q_world: &M3) -> M3 {
    mat_mul(r_old, &transpose(q_world))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::norm;

    fn camera() -> Camera {
        Camera {
            model: 2,
            width: 4000,
            height: 3000,
            params: vec![3000.0, 2000.5, 1500.5, -0.06],
        }
    }

    /// A 4 x 3 block 60 m up over 200 ground points, observed with 0.3 px noise.
    fn truth() -> Problem {
        let mut cams = Vec::new();
        for i in 0..4 {
            for j in 0..3 {
                let tilt = 0.02 * (i as f64 - 1.5);
                let r = mat_mul(
                    &rodrigues([0.0, tilt, 0.0]),
                    &[[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]],
                );
                cams.push(Pose {
                    r,
                    c: [i as f64 * 18.0 - 27.0, j as f64 * 18.0 - 18.0, 60.0],
                    intr: camera(),
                });
            }
        }
        let mut pts = Vec::new();
        let mut seed = 7u64;
        let mut rnd = || {
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((seed >> 11) as f64 / (1u64 << 53) as f64) - 0.5
        };
        for _ in 0..200 {
            pts.push([rnd() * 70.0, rnd() * 50.0, rnd() * 4.0]);
        }
        let mut obs = Vec::new();
        for (ci, c) in cams.iter().enumerate() {
            for (pi, x) in pts.iter().enumerate() {
                if let Some((px, _)) = project(&c.intr, mat_vec(&c.r, sub(*x, c.c))) {
                    if px[0] > 0.0 && px[0] < 4000.0 && px[1] > 0.0 && px[1] < 3000.0 {
                        obs.push(Obs {
                            cam: ci,
                            pt: pi,
                            xy: [px[0] + 0.3 * rnd(), px[1] + 0.3 * rnd()],
                            sigma: 1.0,
                            robust: true,
                        });
                    }
                }
            }
        }
        Problem {
            cams,
            pts,
            obs,
            priors: vec![],
            calib: None,
        }
    }

    /// Damage the block as a GPS-only fit leaves it (a 1 % scale error, a tilt and a shift), give
    /// five points their survey as priors, and the adjustment brings the other points back.
    #[test]
    fn ground_control_pulls_a_damaged_block_back_onto_its_survey() {
        let t = truth();
        let mut p = t.clone();
        let q = rodrigues([0.004, -0.003, 0.002]);
        let warp = |x: V3| add(crate::geo::scale(mat_vec(&q, x), 1.01), [0.8, -0.5, 1.2]);
        for c in p.cams.iter_mut() {
            c.c = warp(c.c);
            c.r = rotate_into(&c.r, &q);
        }
        for x in p.pts.iter_mut() {
            *x = warp(*x);
        }
        let control = [3usize, 40, 90, 140, 190];
        p.priors = control
            .iter()
            .map(|&k| Prior {
                pt: k,
                at: t.pts[k],
                sigma: 0.02,
            })
            .collect();
        let err = |p: &Problem| {
            (0..p.pts.len())
                .filter(|k| !control.contains(k))
                .map(|k| norm(sub(p.pts[k], t.pts[k])))
                .fold(0.0, f64::max)
        };
        let before = err(&p);
        let s = adjust(&mut p, 50);
        let after = err(&p);
        assert!(before > 0.5, "{before}");
        assert!(
            after < 0.05,
            "max point error {after} m (was {before}), {s:?}"
        );
        assert!(
            s.rms_px_after < 0.5 && s.cost_after < s.cost_before,
            "{s:?}"
        );
    }

    /// A block solved with the wrong radial distortion fits its own tie points and comes out as a
    /// dome. Six control points marked in the photographs flatten it when the lens is adjusted with
    /// the block, and cannot when the lens is held: the tie points outvote them.
    #[test]
    fn control_and_calibration_take_out_the_dome_of_a_wrong_lens() {
        let t = truth();
        let mut domed = t.clone();
        for c in domed.cams.iter_mut() {
            c.intr.params[3] = -0.03;
        }
        adjust(&mut domed, 40);
        // Six control points on the ground, marked where the true cameras see them.
        let ground = [[-30.0, -20.0, 0.5], [30.0, -20.0, 1.0], [-30.0, 20.0, 0.0], [30.0, 20.0, 1.5], [0.0, 0.0, 0.8], [5.0, -18.0, 0.2]];
        let with_control = |base: &Problem, calib: Option<Calib>| {
            let mut p = base.clone();
            for g in ground {
                let pt = p.pts.len();
                p.pts.push(g);
                for (ci, c) in t.cams.iter().enumerate() {
                    if let Some(px) = pixel(&c.intr, mat_vec(&c.r, sub(g, c.c))) {
                        if px[0] > 0.0 && px[0] < 4000.0 && px[1] > 0.0 && px[1] < 3000.0 {
                            p.obs.push(Obs { cam: ci, pt, xy: px, sigma: 2.0, robust: false });
                        }
                    }
                }
                p.priors.push(Prior { pt, at: g, sigma: 0.02 });
            }
            p.calib = calib;
            p
        };
        let worst = |p: &Problem| (0..t.pts.len()).map(|k| norm(sub(p.pts[k], t.pts[k]))).fold(0.0, f64::max);
        let mut held = with_control(&domed, None);
        adjust(&mut held, 40);
        let start = domed.cams[0].intr.params.clone();
        let mut freed = with_control(&domed, Some(Calib { sigma: vec![0.03 * start[0], 0.0, 0.0, f64::INFINITY], start }));
        let s = adjust(&mut freed, 60);
        let k = freed.cams[0].intr.params[3];
        assert!(worst(&held) > 0.15, "the held lens should leave the dome: {} m", worst(&held));
        assert!(worst(&freed) < 0.05, "max point error {} m with the lens adjusted (held: {} m), k {k}, {s:?}", worst(&freed), worst(&held));
        assert!((k + 0.06).abs() < 0.003, "the distortion came back as {k}, not -0.06");
        assert!(freed.cams.iter().all(|c| c.intr.params == freed.cams[0].intr.params), "one lens for the block");
    }

    #[test]
    fn the_projection_jacobian_matches_finite_differences() {
        let c = camera();
        let p = [3.0, -2.0, 50.0];
        let (px, j) = project(&c, p).unwrap();
        for k in 0..3 {
            let mut q = p;
            q[k] += 1e-5;
            let (pq, _) = project(&c, q).unwrap();
            for a in 0..2 {
                let fd = (pq[a] - px[a]) / 1e-5;
                assert!(
                    (fd - j[a][k]).abs() < 1e-3 * fd.abs().max(1.0),
                    "{a} {k}: {fd} vs {}",
                    j[a][k]
                );
            }
        }
    }
}
