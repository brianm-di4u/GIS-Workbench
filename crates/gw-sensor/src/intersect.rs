//! Multi-image point intersection (REQ-MEN-11, targeting-grade, `Research/06` §5): the
//! least-squares ground point of two or more image observations, with per-image residuals, the
//! 3 × 3 ENU covariance, CE90/LE90 and the ray convergence (warning under 10°, AC-07.3).

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::stats;
use gw_geodesy::wgs84::{geodetic_to_ecef, radii};

/// One measurement of the point in one image. `sigma_px` is the total image-space σ (pick and
/// model), per axis.
pub struct Observation<'a> {
    pub model: &'a dyn SensorModel,
    pub x: f64,
    pub y: f64,
    pub sigma_px: f64,
}

#[derive(Clone, Debug)]
pub struct Intersection {
    pub ground: Ground,
    /// Covariance of (E, N, U) in metres², from the a priori observation σ.
    pub cov_enu: [[f64; 3]; 3],
    /// Residual (measured − projected) per observation, pixels.
    pub residuals: Vec<(f64, f64)>,
    /// A posteriori σ₀ (1 when there are no redundant observations).
    pub sigma0: f64,
    pub iterations: usize,
    /// Smallest and largest angle between any two rays (degrees).
    pub min_convergence_deg: f64,
    pub max_convergence_deg: f64,
    pub ce90: f64,
    pub le90: f64,
}

/// Metres → degrees factors at a point: (∂lat/∂N, ∂lon/∂E).
pub fn deg_per_metre(g: Ground) -> (f64, f64) {
    let (m, n) = radii(g.lat);
    let k = 180.0 / std::f64::consts::PI;
    (k / (m + g.h), k / ((n + g.h) * g.lat.to_radians().cos()))
}

/// ∂(x, y)/∂(E, N, U) per metre at g.
pub fn enu_partials<M: SensorModel + ?Sized>(m: &M, g: Ground) -> Result<[[f64; 3]; 2]> {
    let j = m.ground_partials(g)?;
    let (dlat, dlon) = deg_per_metre(g);
    Ok([[j[0][1] * dlon, j[0][0] * dlat, j[0][2]], [j[1][1] * dlon, j[1][0] * dlat, j[1][2]]])
}

/// Inverse of a symmetric 3 × 3 matrix, or None when it is singular.
pub fn inv3(a: &[[f64; 3]; 3]) -> Option<[[f64; 3]; 3]> {
    let c00 = a[1][1] * a[2][2] - a[1][2] * a[2][1];
    let c01 = a[1][2] * a[2][0] - a[1][0] * a[2][2];
    let c02 = a[1][0] * a[2][1] - a[1][1] * a[2][0];
    let det = a[0][0] * c00 + a[0][1] * c01 + a[0][2] * c02;
    let scale = a[0][0].abs().max(a[1][1].abs()).max(a[2][2].abs());
    if !det.is_finite() || det.abs() <= 1e-14 * scale * scale * scale {
        return None;
    }
    let d = 1.0 / det;
    Some([
        [c00 * d, (a[0][2] * a[2][1] - a[0][1] * a[2][2]) * d, (a[0][1] * a[1][2] - a[0][2] * a[1][1]) * d],
        [c01 * d, (a[0][0] * a[2][2] - a[0][2] * a[2][0]) * d, (a[0][2] * a[1][0] - a[0][0] * a[1][2]) * d],
        [c02 * d, (a[0][1] * a[2][0] - a[0][0] * a[2][1]) * d, (a[0][0] * a[1][1] - a[0][1] * a[1][0]) * d],
    ])
}

/// Unit ECEF direction of the ray through (x, y), from two heights of the model.
pub fn ray_direction<M: SensorModel + ?Sized>(m: &M, x: f64, y: f64, h: f64) -> Result<[f64; 3]> {
    let a = m.image_to_ground(x, y, h + 100.0)?;
    let b = m.image_to_ground(x, y, h - 100.0)?;
    let pa = geodetic_to_ecef(a.lat, a.lon, a.h);
    let pb = geodetic_to_ecef(b.lat, b.lon, b.h);
    let d = [pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]];
    let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
    if n == 0.0 || !n.is_finite() {
        return Err(Error::new(gw_abi::INTERNAL, "degenerate ray"));
    }
    Ok([d[0] / n, d[1] / n, d[2] / n])
}

/// Least-squares intersection of the observations, starting from `start` or from the first
/// observation at the middle of its model's height range.
pub fn intersect(obs: &[Observation<'_>], start: Option<Ground>) -> Result<Intersection> {
    if obs.len() < 2 {
        return Err(Error::invalid("a multi-image point needs two or more images"));
    }
    if obs.iter().any(|o| !(o.sigma_px > 0.0) || !o.x.is_finite() || !o.y.is_finite()) {
        return Err(Error::invalid("observation with a non-positive σ or a non-finite position"));
    }
    let mut g = match start {
        Some(g) => g,
        None => {
            let (h0, h1) = obs[0].model.height_range();
            let h = if h0.is_finite() && h1.is_finite() && h1 - h0 < 20000.0 { 0.5 * (h0 + h1) } else { 0.0 };
            obs[0].model.image_to_ground(obs[0].x, obs[0].y, h)?
        }
    };
    let mut ninv = [[0.0; 3]; 3];
    let mut iterations = 0;
    for it in 0..30 {
        iterations = it + 1;
        let mut n = [[0.0; 3]; 3];
        let mut b = [0.0; 3];
        for o in obs {
            let (px, py) = o.model.ground_to_image(g)?;
            let j = enu_partials(o.model, g)?;
            let w = 1.0 / (o.sigma_px * o.sigma_px);
            let r = [o.x - px, o.y - py];
            for (row, rr) in j.iter().zip(r) {
                for a in 0..3 {
                    b[a] += row[a] * w * rr;
                    for c in 0..3 {
                        n[a][c] += row[a] * w * row[c];
                    }
                }
            }
        }
        ninv = inv3(&n).ok_or_else(|| Error::invalid("the rays do not intersect (singular geometry)"))?;
        let d: Vec<f64> = (0..3).map(|a| (0..3).map(|c| ninv[a][c] * b[c]).sum()).collect();
        let (dlat, dlon) = deg_per_metre(g);
        g = Ground { lat: g.lat + d[1] * dlat, lon: g.lon + d[0] * dlon, h: g.h + d[2] };
        if !(g.lat.is_finite() && g.lon.is_finite() && g.h.is_finite()) {
            return Err(Error::invalid("intersection diverged"));
        }
        if d[0].abs() + d[1].abs() + d[2].abs() < 1e-5 {
            break;
        }
    }
    let mut residuals = Vec::with_capacity(obs.len());
    let mut vpv = 0.0;
    for o in obs {
        let (px, py) = o.model.ground_to_image(g)?;
        let r = (o.x - px, o.y - py);
        vpv += (r.0 * r.0 + r.1 * r.1) / (o.sigma_px * o.sigma_px);
        residuals.push(r);
    }
    let dof = 2 * obs.len() as i64 - 3;
    let sigma0 = if dof > 0 { (vpv / dof as f64).sqrt() } else { 1.0 };
    let dirs: Vec<[f64; 3]> = obs.iter().map(|o| ray_direction(o.model, o.x, o.y, g.h)).collect::<Result<_>>()?;
    let (mut mn, mut mx) = (f64::INFINITY, 0.0_f64);
    for i in 0..dirs.len() {
        for k in i + 1..dirs.len() {
            let c = (dirs[i][0] * dirs[k][0] + dirs[i][1] * dirs[k][1] + dirs[i][2] * dirs[k][2]).abs().min(1.0);
            let a = c.acos().to_degrees();
            mn = mn.min(a);
            mx = mx.max(a);
        }
    }
    Ok(Intersection {
        ground: g,
        cov_enu: ninv,
        residuals,
        sigma0,
        iterations,
        min_convergence_deg: mn,
        max_convergence_deg: mx,
        ce90: stats::ce90(ninv[0][0], ninv[0][1], ninv[1][1]),
        le90: stats::le90(ninv[2][2].sqrt()),
    })
}

/// Image-space σ (px) for an observation: the pick σ and the model's horizontal σ over the GSD.
pub fn observation_sigma<M: SensorModel + ?Sized>(m: &M, x: f64, y: f64, h: f64, sigma_pick_px: f64) -> Result<f64> {
    let model = m.horizontal_sigma().unwrap_or(0.0).max(0.0);
    if model == 0.0 {
        return Ok(sigma_pick_px);
    }
    let a = m.image_to_ground(x, y, h)?;
    let b = m.image_to_ground(x + 1.0, y, h)?;
    let c = m.image_to_ground(x, y + 1.0, h)?;
    let (dlat, dlon) = deg_per_metre(a);
    let gx = ((b.lon - a.lon) / dlon).hypot((b.lat - a.lat) / dlat);
    let gy = ((c.lon - a.lon) / dlon).hypot((c.lat - a.lat) / dlat);
    let gsd = 0.5 * (gx + gy);
    Ok(sigma_pick_px.hypot(model / gsd))
}
