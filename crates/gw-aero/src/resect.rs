//! Space resection of a single image (REQ-GAP-22): the exterior orientation of one frame from
//! known ground points and their image measurements, with the interior orientation held. Without
//! an approximation it starts from a direct solution (the 11-parameter DLT for points spread in
//! depth, a plane homography for flat ground: Zhang's decomposition) and refines by
//! Levenberg–Marquardt on the collinearity equations, optionally Huber-weighted. Degenerate
//! geometry is refused: fewer than four points without an approximation (three with one),
//! collinear points, or a singular normal matrix.
//!
//! Frames: points are in a local Cartesian frame; the attitude rotates it into the camera frame
//! (camera looking along −z, `aero`'s convention). The direct solutions work in the computer-vision
//! convention (z forward, y down), R_cv = diag(1, −1, −1)·R.

use crate::aero::{back_project, project, CameraIn, NIO};
use crate::geom::*;
use gw_adjust::linalg::{cholesky, chol_inverse, chol_solve, solve_general, Mat};
use gw_abi::{Error, Result};

#[derive(Clone, Debug)]
pub struct ResectOut {
    pub c: V3,
    pub r: M3,
    /// Covariance of (X, Y, Z, rotations about the camera axes) (σ₀² scaled; m², rad²).
    pub cov: [[f64; 6]; 6],
    pub residuals: Vec<(f64, f64)>,
    pub weights: Vec<f64>,
    pub sigma0: f64,
    pub dof: i64,
    pub iterations: usize,
    /// "approximation", "DLT" or "homography".
    pub method: &'static str,
    /// The largest correlation between two of the six parameters.
    pub max_corr: f64,
}

const FLIP: M3 = [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];

/// Normalised computer-vision image coordinates of a measurement (None beyond ~80° off axis).
fn cv_coords(cam: &CameraIn, io: &[f64; NIO], film: Option<&[f64; 6]>, p: (f64, f64)) -> Option<(f64, f64)> {
    let d = back_project(cam, io, film, p.0, p.1)?;
    (d[2] < -0.17).then(|| (d[0] / -d[2], -d[1] / -d[2]))
}

fn dlt(pts: &[V3], m: &[(f64, f64)], ctr: V3, s: f64) -> Option<(V3, M3)> {
    let mut rows: Vec<([f64; 11], f64)> = Vec::with_capacity(2 * pts.len());
    for (p, &(u, v)) in pts.iter().zip(m) {
        let q = scale(sub(*p, ctr), 1.0 / s);
        rows.push(([q[0], q[1], q[2], 1.0, 0.0, 0.0, 0.0, 0.0, -u * q[0], -u * q[1], -u * q[2]], u));
        rows.push(([0.0, 0.0, 0.0, 0.0, q[0], q[1], q[2], 1.0, -v * q[0], -v * q[1], -v * q[2]], v));
    }
    let mut n = Mat::zeros(11);
    let mut b = vec![0.0; 11];
    for (x, y) in &rows {
        for i in 0..11 {
            b[i] += x[i] * y;
            for j in 0..11 {
                n.add(i, j, x[i] * x[j]);
            }
        }
    }
    let l = solve_general(&n, &b)?;
    let mm = [[l[0], l[1], l[2]], [l[4], l[5], l[6]], [l[8], l[9], l[10]]];
    let p4 = [l[3], l[7], 1.0];
    let ct = mv(&inv(&mm)?, p4);
    let c = add(ctr, scale(ct, -s));
    let d = det(&mm);
    let lam = d.signum() * d.abs().cbrt();
    if !(lam.abs() > 1e-300) {
        return None;
    }
    let r_cv = orthonormalise(&mm.map(|row| row.map(|v| v / lam)))?;
    Some((c, mul(&FLIP, &r_cv)))
}

fn homography(pts: &[V3], m: &[(f64, f64)], ctr: V3, s: f64, e: [V3; 3]) -> Option<(V3, M3)> {
    let mut n = Mat::zeros(8);
    let mut b = vec![0.0; 8];
    for (p, &(x, y)) in pts.iter().zip(m) {
        let q = sub(*p, ctr);
        let (u, v) = (dot(q, e[0]) / s, dot(q, e[1]) / s);
        for (row, rhs) in [([u, v, 1.0, 0.0, 0.0, 0.0, -x * u, -x * v], x), ([0.0, 0.0, 0.0, u, v, 1.0, -y * u, -y * v], y)] {
            for i in 0..8 {
                b[i] += row[i] * rhs;
                for j in 0..8 {
                    n.add(i, j, row[i] * row[j]);
                }
            }
        }
    }
    let h = solve_general(&n, &b)?;
    let c1 = [h[0], h[3], h[6]];
    let c2 = [h[1], h[4], h[7]];
    let c3 = [h[2], h[5], 1.0];
    let mut lam = 2.0 / (norm(c1) + norm(c2));
    if lam * c3[2] < 0.0 {
        lam = -lam;
    }
    let (r1, r2, t) = (scale(c1, lam), scale(c2, lam), scale(c3, lam));
    let r3 = cross(r1, r2);
    // Rp has columns r1, r2, r3 = R_cv·[e1 e2 e3].
    let rp = [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]];
    let eb = [[e[0][0], e[1][0], e[2][0]], [e[0][1], e[1][1], e[2][1]], [e[0][2], e[1][2], e[2][2]]];
    let r_cv = orthonormalise(&mul(&rp, &tr(&eb)))?;
    let ct = scale(mtv(&r_cv, t), -1.0);
    Some((add(ctr, scale(ct, s)), mul(&FLIP, &r_cv)))
}

/// Resect one image. `sigma` per measurement (px); `robust` turns on Huber weighting (k = 2).
#[allow(clippy::too_many_arguments)]
pub fn resect(cam: &CameraIn, io: &[f64; NIO], film: Option<&[f64; 6]>, pts: &[V3], px: &[(f64, f64)], sigma: &[f64], init: Option<(V3, M3)>, robust: bool) -> Result<ResectOut> {
    let n = pts.len();
    if n != px.len() || n != sigma.len() {
        return Err(Error::invalid("resection: the point, measurement and σ lists differ in length"));
    }
    if pts.iter().any(|p| !p.iter().all(|v| v.is_finite())) || px.iter().any(|p| !p.0.is_finite() || !p.1.is_finite()) || sigma.iter().any(|s| !(*s > 0.0)) {
        return Err(Error::invalid("resection: a coordinate is not a number or a σ is not positive"));
    }
    let need = if init.is_some() { 3 } else { 4 };
    if n < need {
        return Err(gw_abi::err!(INVALID, "resection needs at least {n} points with known ground coordinates", n = need));
    }
    let ctr = scale(pts.iter().fold([0.0; 3], |a, p| add(a, *p)), 1.0 / n as f64);
    let mut cv = [[0.0; 3]; 3];
    for p in pts {
        let d = sub(*p, ctr);
        for i in 0..3 {
            for j in 0..3 {
                cv[i][j] += d[i] * d[j] / n as f64;
            }
        }
    }
    let (vals, vecs) = sym_eigen(&cv);
    if !(vals[2] > 0.0) || vals[1] < 1e-8 * vals[2] {
        return Err(Error::invalid("resection: the ground points are collinear (or coincide): the attitude about their line cannot be determined"));
    }
    let s = vals[2].sqrt();
    let (mut c, mut r, method) = match init {
        Some((c, r)) => (c, r, "approximation"),
        None => {
            let mut p2 = Vec::new();
            let mut m2 = Vec::new();
            for (p, q) in pts.iter().zip(px) {
                if let Some(m) = cv_coords(cam, io, film, *q) {
                    p2.push(*p);
                    m2.push(m);
                }
            }
            if p2.len() < 4 {
                return Err(Error::invalid("resection: fewer than four measurements lie within 80° of the optical axis"));
            }
            let thick = vals[0] / vals[2];
            let e = [vecs[2], vecs[1], cross(vecs[2], vecs[1])];
            let first = if p2.len() >= 6 && thick > 1e-3 { dlt(&p2, &m2, ctr, s).map(|x| (x, "DLT")) } else { None };
            let sol = first.or_else(|| homography(&p2, &m2, ctr, s, e).map(|x| (x, "homography"))).ok_or_else(|| Error::invalid("resection: no direct solution (the measurements are degenerate)"))?;
            (sol.0 .0, sol.0 .1, sol.1)
        }
    };
    // Levenberg–Marquardt on (ΔC, δ), R ← exp(−[δ]×)·R.
    let resid = |c: V3, r: &M3| -> Option<Vec<(f64, f64)>> {
        pts.iter().zip(px).map(|(p, q)| project(cam, io, film, mv(r, sub(*p, c))).map(|(x, y)| (q.0 - x, q.1 - y))).collect()
    };
    let mut w = vec![1.0; n];
    let cost = |res: &[(f64, f64)], w: &[f64]| res.iter().zip(sigma).zip(w).map(|((v, s), w)| w * (v.0 * v.0 + v.1 * v.1) / (s * s)).sum::<f64>();
    let mut res = resid(c, &r).ok_or_else(|| Error::invalid("resection: a point lies behind the approximate camera"))?;
    let mut lambda = 1e-3;
    let mut iterations = 0;
    let normal = |c: V3, r: &M3, res: &[(f64, f64)], w: &[f64]| -> ([[f64; 6]; 6], [f64; 6]) {
        let mut nm = [[0.0; 6]; 6];
        let mut b = [0.0; 6];
        for (k, p) in pts.iter().enumerate() {
            let v = mv(r, sub(*p, c));
            let h = 1e-7 * norm(v);
            let mut jv = [[0.0; 3]; 2];
            for a in 0..3 {
                let mut vp = v;
                let mut vm = v;
                vp[a] += h;
                vm[a] -= h;
                if let (Some(pp), Some(pm)) = (project(cam, io, film, vp), project(cam, io, film, vm)) {
                    jv[0][a] = (pp.0 - pm.0) / (2.0 * h);
                    jv[1][a] = (pp.1 - pm.1) / (2.0 * h);
                }
            }
            let sk = skew(v);
            let mut j = [[0.0; 6]; 2];
            for row in 0..2 {
                for t in 0..3 {
                    j[row][t] = -(0..3).map(|a| jv[row][a] * r[a][t]).sum::<f64>();
                    j[row][3 + t] = (0..3).map(|a| jv[row][a] * sk[a][t]).sum::<f64>();
                }
            }
            let wk = w[k] / (sigma[k] * sigma[k]);
            let rr = [res[k].0, res[k].1];
            for row in 0..2 {
                for a in 0..6 {
                    b[a] += j[row][a] * wk * rr[row];
                    for bb in 0..6 {
                        nm[a][bb] += j[row][a] * wk * j[row][bb];
                    }
                }
            }
        }
        (nm, b)
    };
    let solve6 = |nm: &[[f64; 6]; 6], b: &[f64; 6], lambda: f64| -> Option<Vec<f64>> {
        let mut m = Mat::zeros(6);
        let d: Vec<f64> = (0..6).map(|i| 1.0 / nm[i][i].max(1e-300).sqrt()).collect();
        for i in 0..6 {
            for j in 0..6 {
                m.set(i, j, nm[i][j] * d[i] * d[j] + if i == j { lambda } else { 0.0 });
            }
        }
        let l = cholesky(&m)?;
        let y = chol_solve(&l, &(0..6).map(|i| b[i] * d[i]).collect::<Vec<_>>());
        Some((0..6).map(|i| y[i] * d[i]).collect())
    };
    for it in 0..100 {
        iterations = it + 1;
        if robust && it >= 3 {
            for k in 0..n {
                let z = res[k].0.hypot(res[k].1) / sigma[k];
                w[k] = if z <= 2.0 { 1.0 } else { 2.0 / z };
            }
        }
        let (nm, b) = normal(c, &r, &res, &w);
        let cur = cost(&res, &w);
        let mut ok = false;
        let mut small = false;
        for _ in 0..12 {
            if let Some(dp) = solve6(&nm, &b, lambda) {
                let nc = add(c, [dp[0], dp[1], dp[2]]);
                let nr = orthonormalise(&mul(&expm([-dp[3], -dp[4], -dp[5]]), &r)).unwrap_or(r);
                if let Some(nres) = resid(nc, &nr) {
                    let ncost = cost(&nres, &w);
                    if ncost <= cur * (1.0 + 1e-14) {
                        small = (cur - ncost) <= 1e-12 * cur.max(1e-300) || dp.iter().all(|v| v.abs() < 1e-10 * s.max(1.0));
                        c = nc;
                        r = nr;
                        res = nres;
                        lambda = (lambda / 10.0).max(1e-12);
                        ok = true;
                        break;
                    }
                }
            }
            lambda *= 10.0;
        }
        if !ok || (small && (!robust || it >= 6)) {
            break;
        }
    }
    let (nm, _) = normal(c, &r, &res, &w);
    let mut m = Mat::zeros(6);
    for i in 0..6 {
        for j in 0..6 {
            m.set(i, j, nm[i][j]);
        }
    }
    let d: Vec<f64> = (0..6).map(|i| 1.0 / m.at(i, i).max(1e-300).sqrt()).collect();
    let mut sc = Mat::zeros(6);
    for i in 0..6 {
        for j in 0..6 {
            sc.set(i, j, m.at(i, j) * d[i] * d[j]);
        }
    }
    let l = cholesky(&sc).ok_or_else(|| Error::invalid("resection: the geometry is singular (the points and the camera are in a critical configuration)"))?;
    let qi = chol_inverse(&l);
    let dof = 2 * n as i64 - 6;
    let vpv = cost(&res, &w);
    let sigma0 = if dof > 0 { (vpv / dof as f64).sqrt() } else { f64::NAN };
    let s2 = if sigma0.is_finite() { sigma0 * sigma0 } else { 1.0 };
    let mut cov = [[0.0; 6]; 6];
    let mut max_corr: f64 = 0.0;
    for i in 0..6 {
        for j in 0..6 {
            cov[i][j] = s2 * qi.at(i, j) * d[i] * d[j];
            if i != j {
                max_corr = max_corr.max((qi.at(i, j) / (qi.at(i, i) * qi.at(j, j)).sqrt()).abs());
            }
        }
    }
    // A wrong direct solution can converge to the mirror image behind the points.
    if pts.iter().any(|p| mv(&r, sub(*p, c))[2] >= 0.0 && cam.projection == crate::aero::Projection::Brown) {
        return Err(Error::invalid("resection: the solution puts points behind the camera (wrong measurements or a critical configuration)"));
    }
    Ok(ResectOut { c, r, cov, residuals: res, weights: w, sigma0, dof, iterations, method, max_corr })
}
