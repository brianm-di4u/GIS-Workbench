//! Point-cloud error propagation in the manner of the Generic Point-cloud Model (REQ-GAP-46, spike
//! S-57). What is implemented is only what public sources describe (the standard itself,
//! NGA.STND.0046, could not be read; see docs/validation/2.5/lidarreg.md):
//!
//! - a **global** error: the adjustable parameters shared by every point of the cloud (here the
//!   3- or 7-parameter datum shift of `block::DatumIn`) with their covariance Σθ, which reaches a
//!   point as A Σθ Aᵀ and correlates every pair of points fully through A_i Σθ A_jᵀ;
//! - a **local** (unmodelled, per point) error, σ per axis, correlated between points by a strictly
//!   positive definite correlation function of the CSM form
//!   ρ(d) = A·(α + (1 − α)(1 + β)/(β + e^(d/T))), with d the distance between the points (CesiumJS's
//!   Apache-2.0 GPM reader writes it with a time difference; using a distance is this code's reading);
//! - the full 3n × 3n covariance of a set of ground points, the relative covariance of any two, and
//!   CE90 / LE90 from them.
//!
//! Not implemented: anchor points and their interpolation, GPM metadata in any file, per-point
//! error (PPE) records, and the standard's own parameter sets.

use crate::block::DatumIn;
use gw_abi::{Error, Result};
use gw_geodesy::stats;
use gw_sensor::Ground;

/// Strictly positive definite correlation function (CSM form).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Spdcf {
    pub a: f64,
    pub alpha: f64,
    pub beta: f64,
    /// Decorrelation distance (m).
    pub t: f64,
}

impl Spdcf {
    /// The function, checked against the ranges the CSM form allows: A in (0, 1], α in [0, 1),
    /// β in [0, 10], T > 0.
    pub fn new(a: f64, alpha: f64, beta: f64, t: f64) -> Result<Spdcf> {
        if !(a > 0.0 && a <= 1.0) || !(0.0..1.0).contains(&alpha) || !(0.0..=10.0).contains(&beta) || !(t > 0.0 && t.is_finite()) {
            return Err(Error::invalid("correlation function out of range: A in (0, 1], alpha in [0, 1), beta in [0, 10], T > 0"));
        }
        Ok(Spdcf { a, alpha, beta, t })
    }
    /// ρ(d); ρ(0) = A.
    pub fn rho(&self, d: f64) -> f64 {
        self.a * (self.alpha + (1.0 - self.alpha) * (1.0 + self.beta) / (self.beta + (d.abs() / self.t).exp()))
    }
}

/// Covariance (3n × 3n, row-major, E N U per point, m²) of ground points `pts` taken from the cloud:
/// the global part A_i Σθ A_jᵀ of the datum shift with covariance `cov` (k × k), plus the local
/// part σ_i σ_j ρ(d_ij) per axis (`local[i]` = σ E, N, U in m; ρ = 1 on the diagonal, 0 between
/// points without a correlation function).
pub fn propagate(datum: &DatumIn, cov: &[f64], pts: &[Ground], local: &[[f64; 3]], spdcf: Option<&Spdcf>) -> Result<Vec<f64>> {
    let n = pts.len();
    let k = datum.k;
    if cov.len() != k * k {
        return Err(Error::invalid("the datum covariance does not match its parameter count"));
    }
    if local.len() != n {
        return Err(Error::invalid("one local σ per point is needed"));
    }
    let a: Vec<[[f64; 7]; 3]> = pts.iter().map(|g| datum.partials(datum.local(*g))).collect();
    let q: Vec<[f64; 3]> = pts.iter().map(|g| datum.local(*g)).collect();
    let m = 3 * n;
    let mut c = vec![0.0; m * m];
    // A_i Σ (k × 3) once per point.
    let asg: Vec<[[f64; 7]; 3]> = a
        .iter()
        .map(|ai| {
            let mut o = [[0.0; 7]; 3];
            for r in 0..3 {
                for b in 0..k {
                    o[r][b] = (0..k).map(|x| ai[r][x] * cov[x * k + b]).sum();
                }
            }
            o
        })
        .collect();
    for i in 0..n {
        for j in i..n {
            for r in 0..3 {
                for s in 0..3 {
                    let mut v: f64 = (0..k).map(|b| asg[i][r][b] * a[j][s][b]).sum();
                    if r == s {
                        let rho = if i == j {
                            1.0
                        } else {
                            match spdcf {
                                Some(f) => {
                                    let d = ((q[i][0] - q[j][0]).powi(2) + (q[i][1] - q[j][1]).powi(2) + (q[i][2] - q[j][2]).powi(2)).sqrt();
                                    f.rho(d)
                                }
                                None => 0.0,
                            }
                        };
                        v += local[i][r] * local[j][r] * rho;
                    }
                    c[(3 * i + r) * m + 3 * j + s] = v;
                    c[(3 * j + s) * m + 3 * i + r] = v;
                }
            }
        }
    }
    Ok(c)
}

/// The 3 × 3 block (i, j) of a 3n × 3n covariance.
pub fn block(c: &[f64], n: usize, i: usize, j: usize) -> [[f64; 3]; 3] {
    let m = 3 * n;
    let mut o = [[0.0; 3]; 3];
    for (r, row) in o.iter_mut().enumerate() {
        for (s, v) in row.iter_mut().enumerate() {
            *v = c[(3 * i + r) * m + 3 * j + s];
        }
    }
    o
}

/// Covariance of p_i − p_j: C_ii + C_jj − C_ij − C_ji.
pub fn relative(c: &[f64], n: usize, i: usize, j: usize) -> [[f64; 3]; 3] {
    let (a, b, x, y) = (block(c, n, i, i), block(c, n, j, j), block(c, n, i, j), block(c, n, j, i));
    let mut o = [[0.0; 3]; 3];
    for r in 0..3 {
        for s in 0..3 {
            o[r][s] = a[r][s] + b[r][s] - x[r][s] - y[r][s];
        }
    }
    o
}

/// CE90 (m) and LE90 (m) of a 3 × 3 E N U covariance.
pub fn ce_le(c: [[f64; 3]; 3]) -> (f64, f64) {
    (stats::ce90(c[0][0], c[0][1], c[1][1]), stats::le90(c[2][2].max(0.0).sqrt()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn datum(k: usize) -> DatumIn {
        DatumIn { k, centre: Some(Ground { lat: 39.9, lon: -105.29, h: 1700.0 }), prior_sigma: vec![] }
    }

    #[test]
    fn spdcf_form_and_ranges() {
        let f = Spdcf::new(0.8, 0.2, 1.0, 100.0).unwrap();
        assert!((f.rho(0.0) - 0.8).abs() < 1e-12);
        assert!(f.rho(50.0) < f.rho(10.0) && f.rho(1e6) > 0.8 * 0.2 - 1e-9);
        assert!((f.rho(1e9) - 0.8 * 0.2).abs() < 1e-9, "the floor is A·α");
        assert!(Spdcf::new(0.0, 0.2, 1.0, 100.0).is_err() && Spdcf::new(1.0, 1.0, 1.0, 1.0).is_err() && Spdcf::new(1.0, 0.0, 11.0, 1.0).is_err() && Spdcf::new(1.0, 0.0, 1.0, 0.0).is_err());
    }

    #[test]
    fn translation_only_is_fully_correlated() {
        // Three translations with σ 0.3, 0.4, 0.5 m: every point gets the same covariance, the
        // relative covariance of two points is zero (the shift cancels).
        let d = datum(3);
        let cov = vec![0.09, 0.0, 0.0, 0.0, 0.16, 0.0, 0.0, 0.0, 0.25];
        let pts = [Ground { lat: 39.9, lon: -105.29, h: 1700.0 }, Ground { lat: 39.905, lon: -105.28, h: 1800.0 }];
        let c = propagate(&d, &cov, &pts, &[[0.0; 3]; 2], None).unwrap();
        let b = block(&c, 2, 1, 1);
        assert!((b[0][0] - 0.09).abs() < 1e-12 && (b[1][1] - 0.16).abs() < 1e-12 && (b[2][2] - 0.25).abs() < 1e-12);
        let r = relative(&c, 2, 0, 1);
        assert!(r.iter().flatten().all(|v| v.abs() < 1e-12), "{r:?}");
        let (ce, le) = ce_le(b);
        assert!(ce > 0.0 && (le - 1.6449 * 0.5).abs() < 1e-3);
    }

    #[test]
    fn rotation_and_scale_grow_with_distance() {
        // 7 parameters, only the scale uncertain (10 ppm): σ at 1 km from the centre is 1 cm along
        // the offset, and zero at the centre.
        let d = datum(7);
        let mut cov = vec![0.0; 49];
        cov[48] = 100.0;
        let c0 = d.centre.unwrap();
        let (dlat, _) = gw_sensor::intersect::deg_per_metre(c0);
        let pts = [c0, Ground { lat: c0.lat + 1000.0 * dlat, ..c0 }];
        let c = propagate(&d, &cov, &pts, &[[0.0; 3]; 2], None).unwrap();
        assert!(block(&c, 2, 0, 0).iter().flatten().all(|v| v.abs() < 1e-12));
        assert!((block(&c, 2, 1, 1)[1][1].sqrt() - 0.01).abs() < 1e-6);
    }

    #[test]
    fn local_error_correlation_by_distance() {
        let d = datum(0);
        let f = Spdcf::new(1.0, 0.0, 0.0, 50.0).unwrap();
        let c0 = d.centre.unwrap();
        let (dlat, _) = gw_sensor::intersect::deg_per_metre(c0);
        let pts = [c0, Ground { lat: c0.lat + 50.0 * dlat, ..c0 }];
        let c = propagate(&d, &[], &pts, &[[0.2, 0.2, 0.1]; 2], Some(&f)).unwrap();
        // β = 0, α = 0: ρ(d) = e^(−d/T) → e^(−1) at 50 m.
        assert!((block(&c, 2, 0, 1)[0][0] - 0.04 * (-1.0f64).exp()).abs() < 1e-6);
        // Relative variance 2σ²(1 − ρ).
        assert!((relative(&c, 2, 0, 1)[2][2] - 2.0 * 0.01 * (1.0 - (-1.0f64).exp())).abs() < 1e-6);
        assert!(propagate(&d, &[1.0], &pts, &[[0.0; 3]; 2], None).is_err());
    }
}
