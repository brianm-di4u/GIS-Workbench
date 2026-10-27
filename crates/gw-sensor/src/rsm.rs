//! RSM polynomial model (REQ-SNS-03; STDI-0002 Vol. 1 App. U, RSMIDA + RSMPCA): row and column are
//! ratios of polynomials in normalised ground coordinates, each polynomial with its own maximum
//! powers in x, y and z. Ground domain G: x = longitude (rad), y = latitude (rad), z = HAE (m);
//! H: as G with longitude in 0 … 2π; R: rectangular, a local Cartesian frame (origin and unit
//! vectors in ECEF). One section (RNIS = CNIS = 1). Labelled experimental until it passes the NGA
//! sample set.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::wgs84::geodetic_to_ecef;

#[derive(Clone, Debug)]
pub struct Poly {
    /// Maximum powers of x, y, z; coefficients with x fastest, then y, then z.
    pub px: usize,
    pub py: usize,
    pub pz: usize,
    pub c: Vec<f64>,
}

impl Poly {
    pub fn eval(&self, x: f64, y: f64, z: f64) -> f64 {
        let mut s = 0.0;
        let mut k = 0;
        let mut zk = 1.0;
        for _ in 0..=self.pz {
            let mut yj = 1.0;
            for _ in 0..=self.py {
                let mut xi = 1.0;
                for _ in 0..=self.px {
                    s += self.c.get(k).copied().unwrap_or(0.0) * xi * yj * zk;
                    k += 1;
                    xi *= x;
                }
                yj *= y;
            }
            zk *= z;
        }
        s
    }
    pub fn terms(&self) -> usize {
        (self.px + 1) * (self.py + 1) * (self.pz + 1)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    Geodetic,
    Geodetic2Pi,
    Rectangular,
}

pub struct RsmModel {
    pub domain: Domain,
    /// Rectangular frame: origin (ECEF) and unit vectors (rows x, y, z) when domain = R.
    pub origin: [f64; 3],
    pub axes: [[f64; 3]; 3],
    /// Normalisation offsets and scales: row, col, x, y, z.
    pub off: [f64; 5],
    pub scale: [f64; 5],
    pub row_num: Poly,
    pub row_den: Poly,
    pub col_num: Poly,
    pub col_den: Poly,
    /// Image size (rows, cols) for the iteration's starting point.
    pub size: (f64, f64),
    name: String,
}

impl RsmModel {
    #[allow(clippy::too_many_arguments)]
    pub fn new(domain: Domain, origin: [f64; 3], axes: [[f64; 3]; 3], off: [f64; 5], scale: [f64; 5], polys: [Poly; 4], size: (f64, f64)) -> Result<Self> {
        if scale.iter().any(|s| *s == 0.0 || !s.is_finite()) {
            return Err(Error::invalid("RSM: a normalisation scale is zero"));
        }
        for p in &polys {
            if p.c.len() != p.terms() {
                return Err(Error::invalid(format!("RSM: a polynomial has {} coefficients for {} terms", p.c.len(), p.terms())));
            }
        }
        let [row_num, row_den, col_num, col_den] = polys;
        Ok(RsmModel { domain, origin, axes, off, scale, row_num, row_den, col_num, col_den, size, name: "RSM polynomial (experimental)".into() })
    }

    fn ground_xyz(&self, g: Ground) -> [f64; 3] {
        match self.domain {
            Domain::Geodetic => [g.lon.to_radians(), g.lat.to_radians(), g.h],
            Domain::Geodetic2Pi => [g.lon.to_radians().rem_euclid(2.0 * std::f64::consts::PI), g.lat.to_radians(), g.h],
            Domain::Rectangular => {
                let p = geodetic_to_ecef(g.lat, g.lon, g.h);
                let d = [p[0] - self.origin[0], p[1] - self.origin[1], p[2] - self.origin[2]];
                [0, 1, 2].map(|i| self.axes[i][0] * d[0] + self.axes[i][1] * d[1] + self.axes[i][2] * d[2])
            }
        }
    }
}

impl SensorModel for RsmModel {
    fn name(&self) -> &str {
        &self.name
    }
    /// RSM rows/columns are pixel-centre based (the first pixel's centre is 0): + 0.5 here.
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let [x, y, z] = self.ground_xyz(g);
        let (xn, yn, zn) = ((x - self.off[2]) / self.scale[2], (y - self.off[3]) / self.scale[3], (z - self.off[4]) / self.scale[4]);
        let rd = self.row_den.eval(xn, yn, zn);
        let cd = self.col_den.eval(xn, yn, zn);
        if rd == 0.0 || cd == 0.0 {
            return Err(Error::range("RSM: zero denominator"));
        }
        let row = self.row_num.eval(xn, yn, zn) / rd * self.scale[0] + self.off[0];
        let col = self.col_num.eval(xn, yn, zn) / cd * self.scale[1] + self.off[1];
        Ok((col + 0.5, row + 0.5))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        // Newton on (lat, lon) at fixed h with numerical partials, from the domain centre.
        let mut g = match self.domain {
            Domain::Rectangular => {
                // Start at the frame origin's geodetic position.
                let (lat, lon, _) = gw_geodesy::wgs84::ecef_to_geodetic(self.origin[0], self.origin[1], self.origin[2]);
                Ground { lat, lon, h }
            }
            _ => Ground { lat: self.off[3].to_degrees(), lon: self.off[2].to_degrees(), h },
        };
        for _ in 0..30 {
            let (cx, cy) = self.ground_to_image(g)?;
            let (ex, ey) = (x - cx, y - cy);
            if ex.abs() + ey.abs() < 1e-7 {
                return Ok(g);
            }
            let d = 1e-6;
            let (ax, ay) = self.ground_to_image(Ground { lat: g.lat + d, ..g })?;
            let (bx, by) = self.ground_to_image(Ground { lon: g.lon + d, ..g })?;
            let (j11, j12, j21, j22) = ((ax - cx) / d, (bx - cx) / d, (ay - cy) / d, (by - cy) / d);
            let det = j11 * j22 - j12 * j21;
            if det.abs() < 1e-18 {
                return Err(Error::range("RSM: singular image-to-ground step"));
            }
            g.lat += (j22 * ex - j12 * ey) / det;
            g.lon += (-j21 * ex + j11 * ey) / det;
        }
        Err(Error::range("RSM image-to-ground did not converge"))
    }
}
