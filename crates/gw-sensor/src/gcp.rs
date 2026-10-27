//! Generic models from ground control (REQ-SNS-05): affine, polynomial (1st–3rd order) and
//! projective. Used for imagery without rigorous support data, and for NITF IGEOLO corners
//! (a projective model through the four corners, labelled approximate).

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Gcp {
    pub x: f64,
    pub y: f64,
    pub lat: f64,
    pub lon: f64,
}

fn poly_terms(order: usize, u: f64, v: f64) -> Vec<f64> {
    let mut t = vec![1.0, u, v];
    if order >= 2 {
        t.extend_from_slice(&[u * u, u * v, v * v]);
    }
    if order >= 3 {
        t.extend_from_slice(&[u * u * u, u * u * v, u * v * v, v * v * v]);
    }
    t
}

/// Solve the normal equations AᵀA x = Aᵀb by Gaussian elimination with partial pivoting.
fn lstsq(rows: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = rows.first()?.len();
    let mut m = vec![vec![0.0; n + 1]; n];
    for (r, &bv) in rows.iter().zip(b) {
        for i in 0..n {
            for j in 0..n {
                m[i][j] += r[i] * r[j];
            }
            m[i][n] += r[i] * bv;
        }
    }
    for col in 0..n {
        let piv = (col..n).max_by(|&i, &j| m[i][col].abs().total_cmp(&m[j][col].abs()))?;
        if m[piv][col].abs() < 1e-300 {
            return None;
        }
        m.swap(col, piv);
        for r in 0..n {
            if r != col {
                let f = m[r][col] / m[col][col];
                for k in col..=n {
                    m[r][k] -= f * m[col][k];
                }
            }
        }
    }
    Some((0..n).map(|i| m[i][n] / m[i][i]).collect())
}

/// Polynomial model, normalised for conditioning: forward (image → ground) and reverse
/// (ground → image) polynomials are fitted separately.
#[derive(Clone, Debug)]
pub struct PolyModel {
    pub order: usize,
    name: String,
    // normalisation
    xo: f64,
    xs: f64,
    yo: f64,
    ys: f64,
    lato: f64,
    lats: f64,
    lono: f64,
    lons: f64,
    f_lat: Vec<f64>,
    f_lon: Vec<f64>,
    r_x: Vec<f64>,
    r_y: Vec<f64>,
    /// RMS residual of the fit in pixels (image space).
    pub rms_px: f64,
}

impl PolyModel {
    pub fn fit(gcps: &[Gcp], order: usize) -> Result<PolyModel> {
        let order = order.clamp(1, 3);
        let need = [0, 3, 6, 10][order];
        if gcps.len() < need {
            return Err(Error::invalid(format!("order {order} needs at least {need} GCPs")));
        }
        let stat = |f: &dyn Fn(&Gcp) -> f64| -> (f64, f64) {
            let n = gcps.len() as f64;
            let m = gcps.iter().map(f).sum::<f64>() / n;
            let s = gcps.iter().map(|g| (f(g) - m).abs()).fold(0.0, f64::max).max(1e-12);
            (m, s)
        };
        let (xo, xs) = stat(&|g| g.x);
        let (yo, ys) = stat(&|g| g.y);
        let (lato, lats) = stat(&|g| g.lat);
        let (lono, lons) = stat(&|g| g.lon);
        let img_rows: Vec<Vec<f64>> = gcps.iter().map(|g| poly_terms(order, (g.x - xo) / xs, (g.y - yo) / ys)).collect();
        let gnd_rows: Vec<Vec<f64>> = gcps.iter().map(|g| poly_terms(order, (g.lon - lono) / lons, (g.lat - lato) / lats)).collect();
        let f_lat = lstsq(&img_rows, &gcps.iter().map(|g| (g.lat - lato) / lats).collect::<Vec<_>>()).ok_or_else(|| Error::invalid("GCPs are degenerate"))?;
        let f_lon = lstsq(&img_rows, &gcps.iter().map(|g| (g.lon - lono) / lons).collect::<Vec<_>>()).ok_or_else(|| Error::invalid("GCPs are degenerate"))?;
        let r_x = lstsq(&gnd_rows, &gcps.iter().map(|g| (g.x - xo) / xs).collect::<Vec<_>>()).ok_or_else(|| Error::invalid("GCPs are degenerate"))?;
        let r_y = lstsq(&gnd_rows, &gcps.iter().map(|g| (g.y - yo) / ys).collect::<Vec<_>>()).ok_or_else(|| Error::invalid("GCPs are degenerate"))?;
        let mut m = PolyModel {
            order,
            name: ["", "Affine (GCP)", "Polynomial 2 (GCP)", "Polynomial 3 (GCP)"][order].to_string(),
            xo,
            xs,
            yo,
            ys,
            lato,
            lats,
            lono,
            lons,
            f_lat,
            f_lon,
            r_x,
            r_y,
            rms_px: 0.0,
        };
        let mut ss = 0.0;
        for g in gcps {
            let (x, y) = m.ground_to_image(Ground { lat: g.lat, lon: g.lon, h: 0.0 })?;
            ss += (x - g.x).powi(2) + (y - g.y).powi(2);
        }
        m.rms_px = (ss / gcps.len() as f64).sqrt();
        Ok(m)
    }
}

impl SensorModel for PolyModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let t = poly_terms(self.order, (g.lon - self.lono) / self.lons, (g.lat - self.lato) / self.lats);
        let x: f64 = t.iter().zip(&self.r_x).map(|(a, b)| a * b).sum();
        let y: f64 = t.iter().zip(&self.r_y).map(|(a, b)| a * b).sum();
        Ok((x * self.xs + self.xo, y * self.ys + self.yo))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let t = poly_terms(self.order, (x - self.xo) / self.xs, (y - self.yo) / self.ys);
        let lat: f64 = t.iter().zip(&self.f_lat).map(|(a, b)| a * b).sum();
        let lon: f64 = t.iter().zip(&self.f_lon).map(|(a, b)| a * b).sum();
        Ok(Ground { lat: lat * self.lats + self.lato, lon: lon * self.lons + self.lono, h })
    }
    fn is_3d(&self) -> bool {
        false
    }
}

/// Projective (8-parameter homography) model image ↔ (lon, lat). Exact through 4 points.
#[derive(Clone, Debug)]
pub struct ProjectiveModel {
    h: [f64; 9],
    hinv: [f64; 9],
    name: String,
}

fn homography(src: &[(f64, f64)], dst: &[(f64, f64)]) -> Option<[f64; 9]> {
    // Least squares over ≥4 points with h22 = 1.
    let mut rows = Vec::new();
    let mut b = Vec::new();
    for (&(x, y), &(u, v)) in src.iter().zip(dst) {
        rows.push(vec![x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y]);
        b.push(u);
        rows.push(vec![0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y]);
        b.push(v);
    }
    let p = lstsq(&rows, &b)?;
    Some([p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], 1.0])
}

fn apply_h(h: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    ((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w)
}

impl ProjectiveModel {
    pub fn fit(gcps: &[Gcp], name: &str) -> Result<ProjectiveModel> {
        if gcps.len() < 4 {
            return Err(Error::invalid("a projective model needs at least 4 points"));
        }
        // Normalise for conditioning.
        let n = gcps.len() as f64;
        let (mx, my) = (gcps.iter().map(|g| g.x).sum::<f64>() / n, gcps.iter().map(|g| g.y).sum::<f64>() / n);
        let (mlon, mlat) = (gcps.iter().map(|g| g.lon).sum::<f64>() / n, gcps.iter().map(|g| g.lat).sum::<f64>() / n);
        let sx = gcps.iter().map(|g| (g.x - mx).abs().max((g.y - my).abs())).fold(1e-12, f64::max);
        let sg = gcps.iter().map(|g| (g.lon - mlon).abs().max((g.lat - mlat).abs())).fold(1e-12, f64::max);
        let src: Vec<(f64, f64)> = gcps.iter().map(|g| ((g.x - mx) / sx, (g.y - my) / sx)).collect();
        let dst: Vec<(f64, f64)> = gcps.iter().map(|g| ((g.lon - mlon) / sg, (g.lat - mlat) / sg)).collect();
        let hn = homography(&src, &dst).ok_or_else(|| Error::invalid("degenerate corner points"))?;
        let hin = homography(&dst, &src).ok_or_else(|| Error::invalid("degenerate corner points"))?;
        // Compose normalisations: T_dst⁻¹ · Hn · T_src
        let tsrc = [1.0 / sx, 0.0, -mx / sx, 0.0, 1.0 / sx, -my / sx, 0.0, 0.0, 1.0];
        let tdst_inv = [sg, 0.0, mlon, 0.0, sg, mlat, 0.0, 0.0, 1.0];
        let tdst = [1.0 / sg, 0.0, -mlon / sg, 0.0, 1.0 / sg, -mlat / sg, 0.0, 0.0, 1.0];
        let tsrc_inv = [sx, 0.0, mx, 0.0, sx, my, 0.0, 0.0, 1.0];
        let h = mul3(&tdst_inv, &mul3(&hn, &tsrc));
        let hinv = mul3(&tsrc_inv, &mul3(&hin, &tdst));
        Ok(ProjectiveModel { h, hinv, name: name.to_string() })
    }
}

fn mul3(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut r = [0.0; 9];
    for i in 0..3 {
        for j in 0..3 {
            r[3 * i + j] = (0..3).map(|k| a[3 * i + k] * b[3 * k + j]).sum();
        }
    }
    r
}

impl SensorModel for ProjectiveModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        Ok(apply_h(&self.hinv, g.lon, g.lat))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (lon, lat) = apply_h(&self.h, x, y);
        Ok(Ground { lat, lon, h })
    }
    fn is_3d(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corners() -> Vec<Gcp> {
        vec![
            Gcp { x: 0.0, y: 0.0, lat: 33.31, lon: 44.39 },
            Gcp { x: 1000.0, y: 0.0, lat: 33.312, lon: 44.41 },
            Gcp { x: 1000.0, y: 800.0, lat: 33.295, lon: 44.411 },
            Gcp { x: 0.0, y: 800.0, lat: 33.293, lon: 44.388 },
        ]
    }

    #[test]
    // REQ-SNS-05: generic affine, polynomial and projective models from GCPs.
    fn projective_is_exact_at_corners() {
        let m = ProjectiveModel::fit(&corners(), "IGEOLO").unwrap();
        for c in corners() {
            let g = m.image_to_ground(c.x, c.y, 0.0).unwrap();
            assert!((g.lat - c.lat).abs() < 1e-10 && (g.lon - c.lon).abs() < 1e-10);
            let (x, y) = m.ground_to_image(g).unwrap();
            assert!((x - c.x).abs() < 1e-6 && (y - c.y).abs() < 1e-6);
        }
    }

    #[test]
    fn affine_fit_rms() {
        // Points from an exact affine map: the fit must reproduce it.
        let f = |x: f64, y: f64| Gcp { x, y, lat: 33.31 - 2e-5 * y + 1e-6 * x, lon: 44.39 + 2e-5 * x + 3e-7 * y };
        let g = vec![f(0.0, 0.0), f(1000.0, 0.0), f(1000.0, 800.0), f(0.0, 800.0), f(500.0, 400.0)];
        let m = PolyModel::fit(&g, 1).unwrap();
        assert!(m.rms_px < 1e-6, "{}", m.rms_px);
        let p = m.image_to_ground(250.0, 100.0, 0.0).unwrap();
        let t = f(250.0, 100.0);
        assert!((p.lat - t.lat).abs() < 1e-12 && (p.lon - t.lon).abs() < 1e-12);
        assert!(PolyModel::fit(&g[..2], 1).is_err());
        // Second order reproduces a quadratic distortion that affine cannot.
        let q = |x: f64, y: f64| Gcp { x, y, lat: 33.3 - 1e-5 * y + 1e-10 * x * x, lon: 44.4 + 1e-5 * x };
        let gq: Vec<Gcp> = (0..4).flat_map(|i| (0..4).map(move |j| q(i as f64 * 300.0, j as f64 * 300.0))).collect();
        assert!(PolyModel::fit(&gq, 2).unwrap().rms_px < 1e-6);
        assert!(PolyModel::fit(&gq, 1).unwrap().rms_px > 1e-3);
    }
}
