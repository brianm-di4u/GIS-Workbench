//! DEM grids and ray–DEM intersection by march-and-bisect (REQ-SNS-07, D17): every
//! crossing is returned and the one used is labelled.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};

/// A geographic post grid (DTED/SRTM layout or a resampled GeoTIFF DEM).
#[derive(Clone, Debug)]
pub struct DemGrid {
    /// Latitude/longitude of post (0, 0), the north-west post.
    pub lat0: f64,
    pub lon0: f64,
    /// Post spacing in degrees (positive).
    pub dlat: f64,
    pub dlon: f64,
    pub width: usize,
    pub height: usize,
    /// Heights in metres, row-major from the north row; NaN = void.
    pub h: Vec<f32>,
    /// Heights are above the ellipsoid already (true) or MSL (false: add N).
    pub hae: bool,
    /// Vertical σ of the DEM (m), from its accuracy record; NaN if unknown.
    pub sigma_v: f64,
}

impl DemGrid {
    pub fn new(lat0: f64, lon0: f64, dlat: f64, dlon: f64, width: usize, height: usize, h: Vec<f32>, hae: bool, sigma_v: f64) -> Result<Self> {
        if width < 2 || height < 2 || h.len() != width * height || !(dlat > 0.0) || !(dlon > 0.0) {
            return Err(Error::invalid("bad DEM grid"));
        }
        Ok(DemGrid { lat0, lon0, dlat, dlon, width, height, h, hae, sigma_v })
    }

    /// Bilinear height at a point (in the grid's own vertical reference); NaN outside or void.
    pub fn sample(&self, lat: f64, lon: f64) -> f64 {
        let fy = (self.lat0 - lat) / self.dlat;
        let fx = (lon - self.lon0) / self.dlon;
        if !(fx >= 0.0 && fy >= 0.0 && fx <= (self.width - 1) as f64 && fy <= (self.height - 1) as f64) {
            return f64::NAN;
        }
        let ix = (fx.floor() as usize).min(self.width - 2);
        let iy = (fy.floor() as usize).min(self.height - 2);
        let tx = fx - ix as f64;
        let ty = fy - iy as f64;
        let at = |r: usize, c: usize| self.h[r * self.width + c] as f64;
        let (a, b, c, d) = (at(iy, ix), at(iy, ix + 1), at(iy + 1, ix), at(iy + 1, ix + 1));
        let top = a + (b - a) * tx;
        let bot = c + (d - c) * tx;
        top + (bot - top) * ty
    }
}

/// One crossing of the image ray with the terrain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Crossing {
    pub ground: Ground,
}

/// Intersect the ray of image point (x, y) with the DEM. `to_hae` converts a DEM height at
/// (lat, lon) to HAE. Returns all crossings ordered from the highest; the first is the one a
/// sensor sees. Fails if the ray never meets the surface inside the model's height range.
pub fn ray_dem<M: SensorModel + ?Sized>(m: &M, x: f64, y: f64, dem: &DemGrid, to_hae: &dyn Fn(f64, f64, f64) -> f64) -> Result<Vec<Crossing>> {
    let (hmin, hmax) = m.height_range();
    let f = |h: f64| -> Result<(f64, Ground)> {
        let g = m.image_to_ground(x, y, h)?;
        let t = dem.sample(g.lat, g.lon);
        Ok((h - to_hae(g.lat, g.lon, t), g))
    };
    let steps = 400usize;
    let dh = (hmax - hmin) / steps as f64;
    let mut out = Vec::new();
    let (mut prev_h, mut prev) = (hmax, f(hmax)?.0);
    for i in 1..=steps {
        let h = hmax - dh * i as f64;
        let (v, _) = f(h)?;
        if prev.is_finite() && v.is_finite() && (prev > 0.0) != (v > 0.0) {
            // Bisect between prev_h (above) and h (below).
            let (mut hi, mut lo) = (prev_h, h);
            let mut fhi = prev;
            for _ in 0..60 {
                let mid = 0.5 * (hi + lo);
                let (fm, _) = f(mid)?;
                if !fm.is_finite() {
                    break;
                }
                if (fm > 0.0) == (fhi > 0.0) {
                    hi = mid;
                    fhi = fm;
                } else {
                    lo = mid;
                }
                if (hi - lo).abs() < 1e-4 {
                    break;
                }
            }
            let hh = 0.5 * (hi + lo);
            let (_, g) = f(hh)?;
            out.push(Crossing { ground: g });
        }
        prev = v;
        prev_h = h;
    }
    if out.is_empty() {
        return Err(Error::range("the image ray does not meet the DEM inside the model height range"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::tests::synthetic;

    #[test]
    // REQ-SNS-07: march-and-bisect returns every crossing and labels the one used.
    fn flat_dem_single_crossing() {
        let m = synthetic();
        let w = 200;
        let dem = DemGrid::new(33.6, 44.1, 0.005, 0.005, w, w, vec![123.0; w * w], true, 5.0).unwrap();
        let (x, y) = m.ground_to_image(Ground { lat: 33.3, lon: 44.4, h: 123.0 }).unwrap();
        let c = ray_dem(&m, x, y, &dem, &|_, _, h| h).unwrap();
        assert_eq!(c.len(), 1);
        assert!((c[0].ground.h - 123.0).abs() < 1e-3);
        assert!((c[0].ground.lat - 33.3).abs() < 1e-8 && (c[0].ground.lon - 44.4).abs() < 1e-8);
    }

    #[test]
    fn sample_bilinear() {
        let dem = DemGrid::new(1.0, 0.0, 1.0, 1.0, 2, 2, vec![0.0, 10.0, 20.0, 30.0], true, f64::NAN).unwrap();
        assert!((dem.sample(0.5, 0.5) - 15.0).abs() < 1e-12);
        assert!(dem.sample(2.0, 0.0).is_nan());
    }
}
