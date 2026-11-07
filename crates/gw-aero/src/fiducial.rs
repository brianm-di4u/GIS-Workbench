//! Film interior orientation from fiducial marks (REQ-GAP-22): the scan's pixel → film
//! millimetre transform, fitted to the fiducials measured in the scan and their calibrated
//! coordinates (the camera calibration report). An affine (6 parameters: two scales, shear,
//! rotation, shift; the film's affinity and the scanner's) or a similarity (4: one scale, rotation,
//! shift; mirrored when the scan is), with the residuals, σ₀ and the scan's pixel size it implies.
//!
//! Film coordinates are millimetres with y up (the report's convention); scan pixels have rows
//! growing down, so the transform normally has a negative determinant.

use gw_abi::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FidModel {
    Similarity,
    Affine,
}

#[derive(Clone, Debug)]
pub struct FidOut {
    pub model: FidModel,
    /// x_mm = a0 + a1·col + a2·row; y_mm = a3 + a4·col + a5·row.
    pub px_to_mm: [f64; 6],
    /// col = b0 + b1·x + b2·y; row = b3 + b4·x + b5·y.
    pub mm_to_px: [f64; 6],
    /// Residuals (calibrated − transformed measured), µm, per fiducial.
    pub residuals_um: Vec<(f64, f64)>,
    pub rms_um: f64,
    pub max_um: f64,
    /// √(vᵀv / dof) in µm; NaN without redundancy.
    pub sigma0_um: f64,
    pub dof: i64,
    /// Scan pixel size along columns and rows (µm), the rotation of the film in the scan
    /// (degrees, counter-clockwise on the film's y-up axes: the angle from the scan's columns to
    /// the film x axis) and the non-orthogonality (degrees, affine only).
    pub pixel_um: (f64, f64),
    pub rotation_deg: f64,
    pub shear_deg: f64,
    pub mirrored: bool,
}

fn inv_affine(a: &[f64; 6]) -> Option<[f64; 6]> {
    let det = a[1] * a[5] - a[2] * a[4];
    if !(det.abs() > 1e-300) {
        return None;
    }
    let (i11, i12, i21, i22) = (a[5] / det, -a[2] / det, -a[4] / det, a[1] / det);
    Some([-(i11 * a[0] + i12 * a[3]), i11, i12, -(i21 * a[0] + i22 * a[3]), i21, i22])
}

/// Least squares of a small system by the normal equations.
fn lsq(rows: &[(Vec<f64>, f64)], n: usize) -> Option<Vec<f64>> {
    let mut m = gw_adjust::linalg::Mat::zeros(n);
    let mut b = vec![0.0; n];
    for (x, y) in rows {
        for i in 0..n {
            b[i] += x[i] * y;
            for j in 0..n {
                m.add(i, j, x[i] * x[j]);
            }
        }
    }
    gw_adjust::linalg::solve_general(&m, &b)
}

/// Fit the transform. `px` are the measured fiducial centres (corner-origin pixels), `mm` the
/// calibrated coordinates in the same order.
pub fn fiducial_io(px: &[(f64, f64)], mm: &[(f64, f64)], model: FidModel) -> Result<FidOut> {
    let n = px.len();
    if n != mm.len() {
        return Err(Error::invalid("fiducial IO: the measured and calibrated lists differ in length"));
    }
    if px.iter().chain(mm).any(|(a, b)| !a.is_finite() || !b.is_finite()) {
        return Err(Error::invalid("fiducial IO: a coordinate is not a number"));
    }
    let need = if model == FidModel::Affine { 3 } else { 2 };
    if n < need {
        return Err(gw_abi::err!(INVALID, "fiducial IO: the {model} transform needs at least {n} fiducials", model = if model == FidModel::Affine { "affine" } else { "similarity" }, n = need));
    }
    // Normalise the pixels (centroid, scale) for conditioning.
    let (cx, cy) = (px.iter().map(|p| p.0).sum::<f64>() / n as f64, px.iter().map(|p| p.1).sum::<f64>() / n as f64);
    let s = (px.iter().map(|p| (p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sum::<f64>() / n as f64).sqrt();
    let sm = (mm.iter().map(|p| p.0 * p.0 + p.1 * p.1).sum::<f64>() / n as f64).sqrt();
    if !(s > 1e-9) {
        return Err(Error::invalid("fiducial IO: the measured fiducials coincide"));
    }
    // Collinearity (affine): the smaller spread of the measured points.
    if model == FidModel::Affine {
        let (mut sxx, mut syy, mut sxy) = (0.0, 0.0, 0.0);
        for p in px {
            let (u, v) = ((p.0 - cx) / s, (p.1 - cy) / s);
            sxx += u * u;
            syy += v * v;
            sxy += u * v;
        }
        let tr = sxx + syy;
        let det = sxx * syy - sxy * sxy;
        let lmin = tr / 2.0 - ((tr / 2.0).powi(2) - det).max(0.0).sqrt();
        if lmin < 1e-6 * tr {
            return Err(Error::invalid("fiducial IO: the fiducials are collinear; an affine transform needs three not on a line"));
        }
    }
    let norm = |p: &(f64, f64)| ((p.0 - cx) / s, (p.1 - cy) / s);
    let fit = |mirror: bool| -> Option<[f64; 6]> {
        match model {
            FidModel::Affine => {
                let rx: Vec<(Vec<f64>, f64)> = px.iter().zip(mm).map(|(p, m)| {
                    let (u, v) = norm(p);
                    (vec![1.0, u, v], m.0)
                }).collect();
                let ry: Vec<(Vec<f64>, f64)> = px.iter().zip(mm).map(|(p, m)| {
                    let (u, v) = norm(p);
                    (vec![1.0, u, v], m.1)
                }).collect();
                let a = lsq(&rx, 3)?;
                let b = lsq(&ry, 3)?;
                Some([a[0], a[1], a[2], b[0], b[1], b[2]])
            }
            FidModel::Similarity => {
                // x = t0 + a u + b v; y = t1 + b u − a v (mirrored: rows down), or + (−b u + a v).
                let sg = if mirror { -1.0 } else { 1.0 };
                let mut rows = Vec::with_capacity(2 * n);
                for (p, m) in px.iter().zip(mm) {
                    let (u, v) = norm(p);
                    rows.push((vec![1.0, 0.0, u, v], m.0));
                    rows.push((vec![0.0, 1.0, -sg * v, sg * u], m.1));
                }
                let c = lsq(&rows, 4)?;
                Some([c[0], c[2], c[3], c[1], sg * c[3], -sg * c[2]])
            }
        }
    };
    let resid = |a: &[f64; 6]| -> Vec<(f64, f64)> {
        px.iter().zip(mm).map(|(p, m)| {
            let (u, v) = norm(p);
            ((m.0 - (a[0] + a[1] * u + a[2] * v)) * 1000.0, (m.1 - (a[3] + a[4] * u + a[5] * v)) * 1000.0)
        }).collect()
    };
    let ss = |r: &[(f64, f64)]| r.iter().map(|(x, y)| x * x + y * y).sum::<f64>();
    let an = match model {
        FidModel::Affine => fit(false).ok_or_else(|| Error::invalid("fiducial IO: the transform is singular"))?,
        FidModel::Similarity => {
            let a = fit(false);
            let b = fit(true);
            match (a, b) {
                (Some(a), Some(b)) => {
                    if ss(&resid(&a)) <= ss(&resid(&b)) {
                        a
                    } else {
                        b
                    }
                }
                (Some(a), None) | (None, Some(a)) => a,
                _ => return Err(Error::invalid("fiducial IO: the transform is singular")),
            }
        }
    };
    let r = resid(&an);
    // Back to raw pixels: u = (col − cx)/s.
    let px_to_mm = [an[0] - (an[1] * cx + an[2] * cy) / s, an[1] / s, an[2] / s, an[3] - (an[4] * cx + an[5] * cy) / s, an[4] / s, an[5] / s];
    let mm_to_px = inv_affine(&px_to_mm).ok_or_else(|| Error::invalid("fiducial IO: the transform is singular"))?;
    let k = if model == FidModel::Affine { 6 } else { 4 };
    let dof = 2 * n as i64 - k;
    let sum = ss(&r);
    let rms_um = (sum / n as f64).sqrt();
    let max_um = r.iter().map(|(x, y)| x.hypot(*y)).fold(0.0, f64::max);
    let sigma0_um = if dof > 0 { (sum / dof as f64).sqrt() } else { f64::NAN };
    // Columns of the px → mm matrix: the film vectors of one pixel step.
    let (c1, c2) = ((px_to_mm[1], px_to_mm[4]), (px_to_mm[2], px_to_mm[5]));
    let pixel_um = (c1.0.hypot(c1.1) * 1000.0, c2.0.hypot(c2.1) * 1000.0);
    let det = px_to_mm[1] * px_to_mm[5] - px_to_mm[2] * px_to_mm[4];
    let rotation_deg = (-c1.1).atan2(c1.0).to_degrees();
    // Rows normally grow down (film y up): the column and −row vectors should be orthogonal.
    let angle = (c1.0 * -c2.0 + c1.1 * -c2.1) / (pixel_um.0 * pixel_um.1 / 1e6).max(1e-300);
    let shear_deg = if model == FidModel::Affine { 90.0 - angle.clamp(-1.0, 1.0).acos().to_degrees() } else { 0.0 };
    let _ = sm;
    Ok(FidOut { model, px_to_mm, mm_to_px, residuals_um: r, rms_um, max_um, sigma0_um, dof, pixel_um, rotation_deg, shear_deg, mirrored: det > 0.0 })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The eight fiducials of USGS report OSL/3707 (Wild RC30 5355, 2017), mm.
    pub const RC30: [(f64, f64); 8] = [(-105.994, -105.998), (106.006, 105.998), (-105.990, 106.004), (105.998, -105.998), (-111.994, 0.003), (112.004, 0.002), (0.004, 112.008), (-0.006, -111.994)];

    fn scan(px_um: (f64, f64), rot_deg: f64, shear: f64, off: (f64, f64)) -> Vec<(f64, f64)> {
        // mm → pixel: film rotated, sheared and scaled, rows down.
        let (s, c) = rot_deg.to_radians().sin_cos();
        RC30.iter().map(|&(x, y)| {
            let (xr, yr) = (c * x - s * y + shear * y, s * x + c * y);
            (off.0 + xr / (px_um.0 / 1000.0), off.1 - yr / (px_um.1 / 1000.0))
        }).collect()
    }

    #[test]
    fn affine_recovers_scan_geometry() {
        let px = scan((12.0, 12.02), 0.7, 2e-4, (9800.0, 9750.0));
        let o = fiducial_io(&px, &RC30, FidModel::Affine).unwrap();
        assert!(o.rms_um < 1e-6, "{}", o.rms_um);
        // The shear lengthens the column step by ~shear²: µm to 1e-3.
        assert!((o.pixel_um.0 - 12.0).abs() < 1e-3 && (o.pixel_um.1 - 12.02).abs() < 1e-3, "{:?}", o.pixel_um);
        assert!((o.rotation_deg - 0.7).abs() < 1e-6, "{}", o.rotation_deg);
        assert!(!o.mirrored && o.dof == 10);
        // Round trip.
        for (&(c, r), &(x, y)) in px.iter().zip(&RC30) {
            let b = o.mm_to_px;
            assert!((b[0] + b[1] * x + b[2] * y - c).abs() < 1e-6 && (b[3] + b[4] * x + b[5] * y - r).abs() < 1e-6);
        }
        // A similarity cannot absorb the shear and the unequal scales (0.17 % over 110 mm is
        // ~190 µm): residuals of tens to hundreds of µm.
        let s = fiducial_io(&px, &RC30, FidModel::Similarity).unwrap();
        assert!(s.rms_um > 10.0 && s.rms_um < 300.0, "{}", s.rms_um);
    }

    #[test]
    fn similarity_mirrored_and_refusals() {
        // A mirrored scan (emulsion down): columns run the other way.
        let px: Vec<(f64, f64)> = scan((20.0, 20.0), -1.2, 0.0, (5600.0, 5600.0)).into_iter().map(|(c, r)| (11200.0 - c, r)).collect();
        let s = fiducial_io(&px, &RC30, FidModel::Similarity).unwrap();
        assert!(s.mirrored && s.rms_um < 1e-6, "{s:?}");
        assert!((s.pixel_um.0 - 20.0).abs() < 1e-6);
        // Too few, collinear, coincident.
        assert!(fiducial_io(&px[..2], &RC30[..2], FidModel::Affine).is_err());
        let line = [(0.0, 0.0), (100.0, 100.0), (200.0, 200.0), (300.0, 300.0)];
        assert!(fiducial_io(&line, &RC30[..4], FidModel::Affine).is_err());
        let same = [(5.0, 5.0); 3];
        assert!(fiducial_io(&same, &RC30[..3], FidModel::Similarity).is_err());
        // Exactly determined: no σ₀.
        let a = fiducial_io(&px[..3], &RC30[..3], FidModel::Affine).unwrap();
        assert!(a.dof == 0 && a.sigma0_um.is_nan());
    }
}
