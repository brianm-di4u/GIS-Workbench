//! Error propagation for a mono image point (REQ-SNS-08, REQ-MEN-06, `Research/06` §6).
//! C_ground = C_model + J·C_pick·Jᵀ + σ_z²·v·vᵀ, all in local (E, N) metres, where J is the
//! image → ground Jacobian and v the horizontal shift per metre of height (relief
//! displacement along the look direction).

use crate::{Ground, SensorModel};
use gw_abi::Result;
use gw_geodesy::stats;
use gw_geodesy::wgs84::radii;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointError {
    /// Horizontal covariance (m²): σE², σEN, σN².
    pub cov: [f64; 3],
    /// Exact CE90 (m) or NaN when the error is not available.
    pub ce90: f64,
    /// LE90 (m) or NaN.
    pub le90: f64,
    /// Whether the model states its own error (RPC ERR_BIAS/ERR_RAND ≥ 0, etc.).
    pub model_error_known: bool,
    /// Components (m, 1σ): model horizontal, pick (radial), DEM-induced horizontal, DEM vertical.
    pub sigma_model: f64,
    pub sigma_pick: f64,
    pub sigma_dem_h: f64,
    pub sigma_dem_v: f64,
    /// Ground sample distance (m) at the point (mean of the two axes).
    pub gsd: f64,
    /// Off-nadir displacement per metre of height (tan of the off-nadir angle).
    pub tan_off_nadir: f64,
    /// Model σ per axis split into the shared bias and the per-point random part (REQ-MEN-07).
    pub sigma_bias: f64,
    pub sigma_rand: f64,
}

/// Mono point error at image (x, y) and height h. `sigma_pick_px` is the measurement σ
/// in pixels (default 0.5); `sigma_dem_v` the DEM vertical σ (NaN if no DEM).
pub fn mono_point_error<M: SensorModel + ?Sized>(m: &M, x: f64, y: f64, h: f64, sigma_pick_px: f64, sigma_dem_v: f64) -> Result<PointError> {
    let g = m.image_to_ground(x, y, h)?;
    let (mr, nr) = radii(g.lat);
    let to_en = |a: Ground| -> (f64, f64) {
        (((a.lon - g.lon).to_radians()) * (nr + h) * g.lat.to_radians().cos(), (a.lat - g.lat).to_radians() * (mr + h))
    };
    let gx = m.image_to_ground(x + 0.5, y, h)?;
    let gx2 = m.image_to_ground(x - 0.5, y, h)?;
    let gy = m.image_to_ground(x, y + 0.5, h)?;
    let gy2 = m.image_to_ground(x, y - 0.5, h)?;
    let (ex1, nx1) = to_en(gx);
    let (ex2, nx2) = to_en(gx2);
    let (ey1, ny1) = to_en(gy);
    let (ey2, ny2) = to_en(gy2);
    // J columns: ∂(E,N)/∂x, ∂(E,N)/∂y per pixel
    let j = [[ex1 - ex2, ey1 - ey2], [nx1 - nx2, ny1 - ny2]];
    let gsd = (0.5 * ((j[0][0].hypot(j[1][0])) + (j[0][1].hypot(j[1][1])))).abs();
    let sp2 = sigma_pick_px * sigma_pick_px;
    let mut cee = sp2 * (j[0][0] * j[0][0] + j[0][1] * j[0][1]);
    let mut cen = sp2 * (j[0][0] * j[1][0] + j[0][1] * j[1][1]);
    let mut cnn = sp2 * (j[1][0] * j[1][0] + j[1][1] * j[1][1]);
    let sigma_pick = (cee + cnn).sqrt() / std::f64::consts::SQRT_2;

    let model = m.horizontal_sigma();
    let (sigma_bias, sigma_rand) = m.horizontal_sigma_parts().unwrap_or((f64::NAN, f64::NAN));
    let model_error_known = model.is_some();
    let sigma_model = model.unwrap_or(f64::NAN);
    if let Some(s) = model {
        cee += s * s;
        cnn += s * s;
    }
    // Relief displacement per metre of height error.
    let mut tan_off_nadir = 0.0;
    let mut sigma_dem_h = 0.0;
    if m.is_3d() {
        let gh = m.image_to_ground(x, y, h + 1.0)?;
        let (ve, vn) = to_en(gh);
        tan_off_nadir = ve.hypot(vn);
        if sigma_dem_v.is_finite() {
            let s2 = sigma_dem_v * sigma_dem_v;
            cee += s2 * ve * ve;
            cen += s2 * ve * vn;
            cnn += s2 * vn * vn;
            sigma_dem_h = sigma_dem_v * tan_off_nadir;
        }
    }
    let ce90 = if model_error_known { stats::ce90(cee, cen, cnn) } else { f64::NAN };
    let le90 = if sigma_dem_v.is_finite() { stats::le90(sigma_dem_v) } else { f64::NAN };
    Ok(PointError {
        cov: [cee, cen, cnn],
        ce90,
        le90,
        model_error_known,
        sigma_model,
        sigma_pick,
        sigma_dem_h,
        sigma_dem_v,
        gsd,
        tan_off_nadir,
        sigma_bias,
        sigma_rand,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::tests::synthetic;

    #[test]
    fn rpc_point_error() {
        let m = synthetic();
        let (x, y) = m.ground_to_image(Ground { lat: 33.3, lon: 44.4, h: 100.0 }).unwrap();
        let e = mono_point_error(&m, x, y, 100.0, 0.5, 5.0).unwrap();
        assert!(e.model_error_known);
        assert!(e.gsd > 0.5 && e.gsd < 2.0, "gsd {}", e.gsd);
        assert!(e.ce90 > 2.146 * (10.0f64).sqrt() * 0.99, "ce90 {}", e.ce90);
        assert!((e.le90 - 1.6449 * 5.0).abs() < 1e-3);
        assert!(e.tan_off_nadir > 0.0);
    }
}
