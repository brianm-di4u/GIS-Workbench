//! Map-projected (orthorectified) products with their viewing geometry (REQ-GAP-20): Landsat
//! Collection 1/2 Level-1TP (ANG file) and Sentinel-2 Level-1C (MTD_TL viewing-angle grids).
//!
//! What "rigorous" can mean for these products: the pixels are already on a map grid, placed on
//! the terrain model the producer used. The support data adds the line of sight (the direction
//! from each ground point to the satellite). This model keeps the map grid and adds that line of
//! sight, so a point at a height h above or below the reference surface h_ref is displaced in the
//! image by (h − h_ref) along the line of sight's horizontal direction, away from the satellite:
//! the relief displacement the producer removed for the terrain but not for anything above it.
//! That makes heights from parallax between two such images (stereo, multi-image points) and
//! the image position of elevated objects computable. Mono positions on the reference surface are
//! exactly the map grid's.
//!
//! - Base: an affine map model (`crate::geotransform`).
//! - Line of sight: unit east/north/up vectors toward the satellite at the nodes of a regular grid
//!   in image space, bilinearly interpolated. At construction each node's vector becomes an image
//!   displacement per metre of height (pixels/m), through the map projection, so grid convergence
//!   and scale are included.
//! - Reference surface: a height per node (the terrain model the product was made on, as far as the
//!   caller knows it; a constant when no DEM is at hand).

use crate::geotransform::{GeoTransformModel, MapCrs};
use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};

#[derive(Clone, Debug)]
pub struct OrthoLos {
    base: GeoTransformModel,
    pub gt: [f64; 6],
    pub epsg: i32,
    /// Grid: nx × ny nodes at image (x0 + i·dx, y0 + j·dy).
    pub nx: usize,
    pub ny: usize,
    pub x0: f64,
    pub y0: f64,
    pub dx: f64,
    pub dy: f64,
    /// Unit vectors toward the satellite (east, north, up) and the reference height (m) per node.
    pub los: Vec<[f64; 3]>,
    pub href: Vec<f64>,
    /// Image displacement (pixels) per metre above the reference, per node.
    disp: Vec<[f64; 2]>,
    name: String,
}

const UP_MIN: f64 = 0.17; // lines of sight more than 80° from the vertical are refused

impl OrthoLos {
    /// The record: [gt ×6, epsg, nx, ny, x0, y0, dx, dy, then per node (e, n, u, h_ref)].
    pub fn from_record(r: &[f64], name: &str) -> Result<OrthoLos> {
        let bad = || Error::invalid("map + line-of-sight record is malformed");
        if r.len() < 13 {
            return Err(bad());
        }
        let (nx, ny) = (r[7], r[8]);
        if !(nx >= 2.0 && ny >= 2.0 && nx <= 4096.0 && ny <= 4096.0) || nx.fract() != 0.0 || ny.fract() != 0.0 {
            return Err(bad());
        }
        let (nx, ny) = (nx as usize, ny as usize);
        if nx * ny > 1 << 20 {
            return Err(Error::limit("map + line-of-sight record: over 1 048 576 grid nodes"));
        }
        if r.len() != 13 + 4 * nx * ny || !(r[11] > 0.0 && r[12] > 0.0) || r.iter().any(|v| !v.is_finite()) {
            return Err(bad());
        }
        let epsg = r[6] as i32;
        let crs = MapCrs::from_epsg(epsg).ok_or_else(|| gw_abi::err!(UNSUPPORTED, "EPSG:{epsg} is not built in", epsg))?;
        let gt = [r[0], r[1], r[2], r[3], r[4], r[5]];
        let base = GeoTransformModel::new(gt, crs)?;
        let mut los = Vec::with_capacity(nx * ny);
        let mut href = Vec::with_capacity(nx * ny);
        for c in r[13..].chunks_exact(4) {
            let n = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            if !(n > 0.5 && n < 1.5) || c[2] / n < UP_MIN {
                return Err(Error::invalid("map + line-of-sight record: a line of sight is not a unit vector above the horizon"));
            }
            los.push([c[0] / n, c[1] / n, c[2] / n]);
            href.push(c[3]);
        }
        let mut m = OrthoLos { base, gt, epsg, nx, ny, x0: r[9], y0: r[10], dx: r[11], dy: r[12], los, href, disp: Vec::new(), name: name.to_string() };
        m.disp = m.displacements()?;
        Ok(m)
    }

    pub fn to_record(&self) -> Vec<f64> {
        let mut r = self.gt.to_vec();
        r.extend_from_slice(&[self.epsg as f64, self.nx as f64, self.ny as f64, self.x0, self.y0, self.dx, self.dy]);
        for (v, h) in self.los.iter().zip(&self.href) {
            r.extend_from_slice(&[v[0], v[1], v[2], *h]);
        }
        r
    }

    /// Pixels per metre of height at each node: the image shift of the ground point moved by
    /// −tan(zenith) metres horizontally along the line of sight (away from the satellite).
    fn displacements(&self) -> Result<Vec<[f64; 2]>> {
        let mut out = Vec::with_capacity(self.los.len());
        let step = 100.0; // m of height: displacement up to ~60 m horizontally, well inside linear
        for j in 0..self.ny {
            for i in 0..self.nx {
                let k = j * self.nx + i;
                let (x, y) = (self.x0 + i as f64 * self.dx, self.y0 + j as f64 * self.dy);
                let v = self.los[k];
                let g = self.base.image_to_ground(x, y, 0.0)?;
                let (e, n) = (-v[0] / v[2] * step, -v[1] / v[2] * step);
                let (lat, lon, _) = gw_geodesy::wgs84::enu_to_geodetic(e, n, 0.0, g.lat, g.lon, 0.0);
                let (x1, y1) = self.base.ground_to_image(Ground { lat, lon, h: 0.0 })?;
                out.push([(x1 - x) / step, (y1 - y) / step]);
            }
        }
        Ok(out)
    }

    /// Bilinear weights of image point (x, y): (node index of the lower corner, fx, fy), clamped
    /// to the grid.
    fn cell(&self, x: f64, y: f64) -> (usize, usize, f64, f64) {
        let u = ((x - self.x0) / self.dx).clamp(0.0, (self.nx - 1) as f64);
        let v = ((y - self.y0) / self.dy).clamp(0.0, (self.ny - 1) as f64);
        let i = (u.floor() as usize).min(self.nx - 2);
        let j = (v.floor() as usize).min(self.ny - 2);
        (i, j, u - i as f64, v - j as f64)
    }
    fn interp(&self, x: f64, y: f64) -> ([f64; 2], f64) {
        let (i, j, fx, fy) = self.cell(x, y);
        let k = |a: usize, b: usize| (j + b) * self.nx + i + a;
        let w = [(1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy];
        let ks = [k(0, 0), k(1, 0), k(0, 1), k(1, 1)];
        let mut d = [0.0; 2];
        let mut h = 0.0;
        for (wi, ki) in w.iter().zip(ks) {
            d[0] += wi * self.disp[ki][0];
            d[1] += wi * self.disp[ki][1];
            h += wi * self.href[ki];
        }
        (d, h)
    }
    /// Line of sight (east, north, up; unit) toward the satellite at an image point.
    pub fn los_at(&self, x: f64, y: f64) -> [f64; 3] {
        let (i, j, fx, fy) = self.cell(x, y);
        let k = |a: usize, b: usize| (j + b) * self.nx + i + a;
        let w = [(1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy];
        let mut v = [0.0; 3];
        for (wi, ki) in w.iter().zip([k(0, 0), k(1, 0), k(0, 1), k(1, 1)]) {
            for c in 0..3 {
                v[c] += wi * self.los[ki][c];
            }
        }
        let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / n, v[1] / n, v[2] / n]
    }
    /// The image displacement per metre of height (pixels/m) at an image point.
    pub fn displacement_at(&self, x: f64, y: f64) -> [f64; 2] {
        self.interp(x, y).0
    }
    /// Mean view zenith (degrees) over the grid nodes.
    pub fn mean_zenith_deg(&self) -> f64 {
        self.los.iter().map(|v| v[2].clamp(-1.0, 1.0).acos().to_degrees()).sum::<f64>() / self.los.len() as f64
    }
}

impl SensorModel for OrthoLos {
    fn name(&self) -> &str {
        &self.name
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        // The displacement belongs to the ground point, i.e. to its map position.
        let (x0, y0) = self.base.ground_to_image(g)?;
        let (d, h) = self.interp(x0, y0);
        let (x, y) = (x0 + (g.h - h) * d[0], y0 + (g.h - h) * d[1]);
        Ok((x, y))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        // The map position (x0, y0) whose displaced image is (x, y), by fixed-point iteration (the
        // displacement varies slowly over the image).
        let (mut x0, mut y0) = (x, y);
        for _ in 0..8 {
            let (d, hr) = self.interp(x0, y0);
            let (nx, ny) = (x - (h - hr) * d[0], y - (h - hr) * d[1]);
            let done = (nx - x0).abs() < 1e-10 && (ny - y0).abs() < 1e-10;
            x0 = nx;
            y0 = ny;
            if done {
                break;
            }
        }
        let g = self.base.image_to_ground(x0, y0, h)?;
        Ok(Ground { h, ..g })
    }
    fn height_range(&self) -> (f64, f64) {
        (-500.0, 9000.0)
    }
    fn is_3d(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// UTM 10N grid, 30 m pixels, a line of sight 5° from the vertical toward the east-north-east.
    fn sample() -> OrthoLos {
        let mut r = vec![462885.0, 30.0, 0.0, 4264515.0, 0.0, -30.0, 32610.0, 5.0, 4.0, 0.0, 0.0, 2000.0, 2500.0];
        for j in 0..4 {
            for i in 0..5 {
                let z = (5.0f64 + i as f64 * 0.5).to_radians();
                let az = (70.0f64 + j as f64).to_radians();
                r.extend_from_slice(&[z.sin() * az.sin(), z.sin() * az.cos(), z.cos(), 100.0 + 10.0 * i as f64]);
            }
        }
        OrthoLos::from_record(&r, "test").unwrap()
    }

    #[test]
    fn round_trip_and_relief_displacement() {
        let m = sample();
        let mut worst = 0f64;
        for (x, y) in [(10.0, 20.0), (3999.5, 5000.5), (7000.0, 7400.0)] {
            for h in [-100.0, 120.0, 3000.0] {
                let g = m.image_to_ground(x, y, h).unwrap();
                let (x2, y2) = m.ground_to_image(g).unwrap();
                worst = worst.max((x2 - x).hypot(y2 - y));
            }
        }
        assert!(worst < 1e-6, "round trip {worst} px");
        // A point 1000 m above the reference at the first node: 1000·tan 5° = 87.5 m away from the
        // satellite (west-south-west), 2.9 px at 30 m.
        let g0 = m.image_to_ground(0.0, 0.0, 100.0).unwrap();
        let (x, y) = m.ground_to_image(Ground { h: 1100.0, ..g0 }).unwrap();
        let d = x.hypot(y) * 30.0;
        assert!((d - 1000.0 * 5f64.to_radians().tan()).abs() < 0.5, "{d} m");
        assert!(x < 0.0 && y > 0.0, "away from an east-north-east satellite: {x}, {y}");
        // On the reference surface the model is the map grid.
        let (x, y) = m.ground_to_image(Ground { h: 100.0, ..g0 }).unwrap();
        assert!(x.abs() < 1e-9 && y.abs() < 1e-9);
        assert!(OrthoLos::from_record(&m.to_record()[..20], "x").is_err());
        let r = m.to_record();
        let b = OrthoLos::from_record(&r, "x").unwrap();
        assert_eq!(b.to_record(), r);
    }
}
