//! Fit an RPC00B record to any sensor model (REQ-SNS-16, REQ-SNS-15 "write updated RPC00B"):
//! a 13 × 13 × 7 grid over a latitude/longitude box and a height range, the linearised
//! r·den − num = 0 system with a ridge on the denominator terms only (small boxes are nearly
//! affine and unregularised denominators grow until RPC00B's 7 digits lose them), the stored
//! 7-significant-digit rounding, a pole check of the denominators over the normalised cube,
//! and the RMS and maximum error of the rounded model on a separate grid.

use crate::linalg::{solve_general, Mat};
use gw_abi::{Error, Result};
use gw_sensor::rpc::{terms, Rpc, RPC_RECORD_LEN};
use gw_sensor::{Ground, SensorModel};

pub struct FitSpec {
    pub lat: (f64, f64),
    pub lon: (f64, f64),
    pub h: (f64, f64),
    /// Image size (pixels) for the line/sample offsets and scales.
    pub width: f64,
    pub height: f64,
    pub err_bias: f64,
    pub err_rand: f64,
    /// Ridge weight on the denominator terms, relative to the mean diagonal.
    pub lambda: f64,
}

pub struct RpcFit {
    pub record: Vec<f64>,
    pub rms_px: f64,
    pub max_px: f64,
    /// Smallest |denominator| over the normalised cube (1.05 × the fit box); a pole when ≤ 0.
    pub min_denominator: f64,
    pub pole_free: bool,
}

fn sig7(v: f64) -> f64 {
    if v == 0.0 || !v.is_finite() {
        return 0.0;
    }
    let e = v.abs().log10().floor();
    let k = 10f64.powf(6.0 - e);
    (v * k).round() / k
}

fn r4(v: f64) -> f64 {
    (v * 1e4).round() / 1e4
}

/// A ground point and its image position in corner-origin coordinates: lat, lon, h, x, y.
pub type Sample = [f64; 5];

/// The ground points of the fit: 13 × 13 × 7 across the box.
fn fit_lattice(s: &FitSpec) -> Vec<Ground> {
    let mut g = Vec::with_capacity(13 * 13 * 7);
    for k in 0..7 {
        for j in 0..13 {
            for i in 0..13 {
                g.push(Ground { lat: s.lat.0 + (s.lat.1 - s.lat.0) * j as f64 / 12.0, lon: s.lon.0 + (s.lon.1 - s.lon.0) * i as f64 / 12.0, h: s.h.0 + (s.h.1 - s.h.0) * k as f64 / 6.0 });
            }
        }
    }
    g
}

/// The ground points of the check: 9 × 9 × 3 on a lattice the fit does not use.
fn check_lattice(s: &FitSpec) -> Vec<Ground> {
    let mut g = Vec::with_capacity(9 * 9 * 3);
    for j in 0..9 {
        for i in 0..9 {
            for k in 0..3 {
                g.push(Ground { lat: s.lat.0 + (s.lat.1 - s.lat.0) * (j as f64 + 0.37) / 9.0, lon: s.lon.0 + (s.lon.1 - s.lon.0) * (i as f64 + 0.61) / 9.0, h: s.h.0 + (s.h.1 - s.h.0) * k as f64 / 2.0 });
            }
        }
    }
    g
}

/// Fit an RPC00B record to `model` (corner-origin image coordinates).
pub fn fit_rpc(model: &dyn SensorModel, s: &FitSpec) -> Result<RpcFit> {
    fn table(model: &dyn SensorModel, pts: Vec<Ground>) -> Result<Vec<Sample>> {
        pts.into_iter()
            .map(|g| {
                let (x, y) = model.ground_to_image(g)?;
                Ok([g.lat, g.lon, g.h, x, y])
            })
            .collect()
    }
    if !(s.lat.1 > s.lat.0 && s.lon.1 > s.lon.0 && s.h.1 >= s.h.0 && s.width > 0.0 && s.height > 0.0) {
        return Err(Error::invalid("RPC fit: empty box or image size"));
    }
    let fit = table(model, fit_lattice(s))?;
    let check = table(model, check_lattice(s))?;
    fit_rpc_samples(&fit, &check, s)
}

/// Fit an RPC00B record to samples of a model that is not here: a rigorous model of OSSIM's, asked
/// through the sidecar (REQ-GAP-21). `fit` should cover the box as the 13 × 13 × 7 lattice does;
/// the errors are measured on `check`, which the fit does not see.
pub fn fit_rpc_samples(fit: &[Sample], check: &[Sample], s: &FitSpec) -> Result<RpcFit> {
    if !(s.lat.1 > s.lat.0 && s.lon.1 > s.lon.0 && s.h.1 >= s.h.0 && s.width > 0.0 && s.height > 0.0) {
        return Err(Error::invalid("RPC fit: empty box or image size"));
    }
    // 39 unknowns on each side, and a check that is not empty.
    if fit.len() < 39 || check.is_empty() || fit.iter().chain(check).any(|p| p.iter().any(|v| !v.is_finite())) {
        return Err(Error::invalid("RPC fit: too few samples, or a sample that is not finite"));
    }
    let off = [((s.height - 1.0) / 2.0).round(), ((s.width - 1.0) / 2.0).round(), r4((s.lat.0 + s.lat.1) / 2.0), r4((s.lon.0 + s.lon.1) / 2.0), ((s.h.0 + s.h.1) / 2.0).round()];
    let sc = [(s.height / 2.0).ceil() + 1.0, (s.width / 2.0).ceil() + 1.0, r4(((s.lat.1 - s.lat.0) / 2.0).max(1e-4) * 1.05), r4(((s.lon.1 - s.lon.0) / 2.0).max(1e-4) * 1.05), (((s.h.1 - s.h.0) / 2.0) * 1.05).ceil().max(1.0)];
    // Samples: normalised (P, L, H) and normalised (line, samp) in the RPC pixel-centre convention.
    let pts: Vec<([f64; 20], f64, f64)> = fit
        .iter()
        .map(|&[lat, lon, h, x, y]| {
            let t = terms((lat - off[2]) / sc[2], (lon - off[3]) / sc[3], (h - off[4]) / sc[4]);
            (t, (y - 0.5 - off[0]) / sc[0], (x - 0.5 - off[1]) / sc[1])
        })
        .collect();
    let fit_one = |line: bool| -> Result<([f64; 20], [f64; 20])> {
        // Unknowns: num[0..20], den[1..20] (den[0] = 1).
        const N: usize = 39;
        let mut m = Mat::zeros(N);
        let mut b = vec![0.0; N];
        let mut row = [0.0; N];
        for (t, r, c) in &pts {
            let v = if line { *r } else { *c };
            row[..20].copy_from_slice(t);
            for k in 1..20 {
                row[19 + k] = -v * t[k];
            }
            for i in 0..N {
                b[i] += row[i] * v;
                for j in 0..N {
                    m.add(i, j, row[i] * row[j]);
                }
            }
        }
        let tr = (0..N).map(|i| m.at(i, i)).sum::<f64>() / N as f64;
        for i in 0..N {
            m.add(i, i, if i >= 20 { s.lambda * tr } else { 1e-12 });
        }
        let x = solve_general(&m, &b).ok_or_else(|| Error::invalid("RPC fit: singular system"))?;
        let mut num = [0.0; 20];
        let mut den = [0.0; 20];
        for i in 0..20 {
            num[i] = sig7(x[i]);
        }
        den[0] = 1.0;
        for i in 1..20 {
            den[i] = sig7(x[19 + i]);
        }
        Ok((num, den))
    };
    let (ln, ld) = fit_one(true)?;
    let (sn, sd) = fit_one(false)?;
    let mut rec = Vec::with_capacity(RPC_RECORD_LEN);
    rec.extend_from_slice(&[s.err_bias, s.err_rand, off[0], off[1], off[2], off[3], off[4], sc[0], sc[1], sc[2], sc[3], sc[4]]);
    rec.extend_from_slice(&ln);
    rec.extend_from_slice(&ld);
    rec.extend_from_slice(&sn);
    rec.extend_from_slice(&sd);
    rec.extend_from_slice(&[0.0; 6]);
    let fitted = Rpc::from_record(&rec)?;
    // Error of the rounded model on the check samples.
    let (mut sum, mut n, mut max) = (0.0, 0usize, 0.0_f64);
    for &[lat, lon, h, x, y] in check {
        let b = fitted.ground_to_image(Ground { lat, lon, h })?;
        let d = (x - b.0).hypot(y - b.1);
        sum += d * d;
        n += 1;
        max = max.max(d);
    }
    // Pole check: both denominators over the normalised cube ±1.05 (21 × 21 × 11).
    let mut min_den = f64::INFINITY;
    for k in 0..11 {
        for j in 0..21 {
            for i in 0..21 {
                let t = terms(-1.05 + 2.1 * j as f64 / 20.0, -1.05 + 2.1 * i as f64 / 20.0, -1.05 + 2.1 * k as f64 / 10.0);
                let dl: f64 = ld.iter().zip(&t).map(|(a, b)| a * b).sum();
                let ds: f64 = sd.iter().zip(&t).map(|(a, b)| a * b).sum();
                min_den = min_den.min(dl).min(ds);
            }
        }
    }
    Ok(RpcFit { record: rec, rms_px: (sum / n as f64).sqrt(), max_px: max, min_denominator: min_den, pole_free: min_den > 0.05 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An RPC with some curvature, as the model the fit is asked to follow.
    fn model() -> Rpc {
        let mut r = vec![-1.0, -1.0, 1000.0, 2000.0, 39.5, -105.5, 2000.0, 1100.0, 2100.0, 0.25, 0.3, 1600.0];
        let mut num_l = [0.0; 20];
        let mut num_s = [0.0; 20];
        let mut den = [0.0; 20];
        (num_l[1], num_l[2], num_l[3], num_l[4]) = (0.02, -1.0, 0.03, 0.002);
        (num_s[1], num_s[2], num_s[3], num_s[5]) = (1.0, 0.01, -0.04, 0.003);
        den[0] = 1.0;
        (den[1], den[2]) = (0.001, -0.002);
        r.extend_from_slice(&num_l);
        r.extend_from_slice(&den);
        r.extend_from_slice(&num_s);
        r.extend_from_slice(&den);
        r.extend_from_slice(&[0.0; 6]);
        Rpc::from_record(&r).unwrap()
    }

    fn spec() -> FitSpec {
        FitSpec { lat: (39.3, 39.7), lon: (-105.75, -105.25), h: (500.0, 3500.0), width: 4000.0, height: 2000.0, err_bias: -1.0, err_rand: -1.0, lambda: 1e-6 }
    }

    fn table(m: &Rpc, pts: Vec<Ground>) -> Vec<Sample> {
        pts.into_iter()
            .map(|g| {
                let (x, y) = m.ground_to_image(g).unwrap();
                [g.lat, g.lon, g.h, x, y]
            })
            .collect()
    }

    #[test]
    fn samples_of_a_model_fit_as_the_model_does() {
        let (m, s) = (model(), spec());
        let a = fit_rpc(&m, &s).unwrap();
        let b = fit_rpc_samples(&table(&m, fit_lattice(&s)), &table(&m, check_lattice(&s)), &s).unwrap();
        assert_eq!(a.record, b.record);
        assert_eq!((a.rms_px, a.max_px), (b.rms_px, b.max_px));
        assert!(b.pole_free && b.rms_px < 0.05, "{}", b.rms_px);
    }

    #[test]
    fn the_error_is_measured_on_the_check_samples() {
        let (m, s) = (model(), spec());
        let mut check = table(&m, check_lattice(&s));
        check[0][3] += 7.0;
        let f = fit_rpc_samples(&table(&m, fit_lattice(&s)), &check, &s).unwrap();
        assert!(f.max_px > 6.9, "{}", f.max_px);
    }

    #[test]
    fn samples_that_are_refused() {
        let (m, s) = (model(), spec());
        let fit = table(&m, fit_lattice(&s));
        let check = table(&m, check_lattice(&s));
        assert!(fit_rpc_samples(&fit[..38], &check, &s).is_err());
        assert!(fit_rpc_samples(&fit, &[], &s).is_err());
        let mut nan = fit.clone();
        nan[3][4] = f64::NAN;
        assert!(fit_rpc_samples(&nan, &check, &s).is_err());
        let mut inf = check.clone();
        inf[1][0] = f64::INFINITY;
        assert!(fit_rpc_samples(&fit, &inf, &s).is_err());
    }
}
