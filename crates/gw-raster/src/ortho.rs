//! Orthorectification (REQ-SNS-17, `Research/06` §7): every output pixel (a UTM grid cell) is
//! mapped back to the image through the DEM height and the sensor model. The exact mapping is
//! evaluated on an adaptive grid: a cell is split until bilinear interpolation of its corner
//! mappings is within the error bound (default 0.1 px) at its centre and edge midpoints; pixels
//! inside a cell are interpolated, then resampled with the chosen kernel.

use crate::resample::{sample, Kernel, Patch};
use gw_abi::Result;
use gw_geodesy::grids::utmups_reverse;
use gw_sensor::terrain::DemGrid;
use gw_sensor::{Ground, SensorModel};
use std::collections::HashMap;

pub struct OrthoSpec {
    pub zone: i32,
    pub north: bool,
    /// West edge easting and north edge northing of the tile (metres), cell size (metres).
    pub e0: f64,
    pub n0: f64,
    pub res: f64,
    pub w: usize,
    pub h: usize,
    pub kernel: Kernel,
    pub bound_px: f64,
    /// Height used where the DEM has no value (m HAE).
    pub fallback_h: f64,
}

pub struct OrthoOut {
    pub bands: Vec<Vec<f32>>,
    /// 1 where the output pixel has data.
    pub mask: Vec<u8>,
    pub cells: usize,
    /// Largest interpolation error found at a test point of an accepted cell (px).
    pub max_err_px: f64,
    /// Where it was: (column, row, cell size) of the worst accepted cell.
    pub worst_cell: (i64, i64, i64),
}

/// Exact mapping of a continuous output position (u, v) (u = 0 at the west edge) to image (x, y).
struct Mapper<'a> {
    model: &'a dyn SensorModel,
    dem: Option<&'a DemGrid>,
    undulation: &'a dyn Fn(f64, f64) -> f64,
    s: &'a OrthoSpec,
    cache: HashMap<(i64, i64), (f64, f64)>,
}

impl Mapper<'_> {
    fn exact(&self, u: f64, v: f64) -> (f64, f64) {
        let e = self.s.e0 + u * self.s.res;
        let n = self.s.n0 - v * self.s.res;
        let Ok((lat, lon, _, _)) = utmups_reverse(self.s.zone, self.s.north, e, n) else { return (f64::NAN, f64::NAN) };
        let mut h = self.dem.map_or(f64::NAN, |d| d.sample(lat, lon));
        if h.is_finite() && !self.dem.is_some_and(|d| d.hae) {
            h += (self.undulation)(lat, lon);
        }
        if !h.is_finite() {
            h = self.s.fallback_h;
        }
        self.model.ground_to_image(Ground { lat, lon, h }).unwrap_or((f64::NAN, f64::NAN))
    }
    /// Exact mapping at an integer lattice vertex (pixel corner), cached.
    fn vertex(&mut self, i: i64, j: i64) -> (f64, f64) {
        if let Some(v) = self.cache.get(&(i, j)) {
            return *v;
        }
        let v = self.exact(i as f64, j as f64);
        self.cache.insert((i, j), v);
        v
    }
}

fn bilerp(c: [(f64, f64); 4], a: f64, b: f64) -> (f64, f64) {
    let (p00, p10, p01, p11) = (c[0], c[1], c[2], c[3]);
    (
        p00.0 * (1.0 - a) * (1.0 - b) + p10.0 * a * (1.0 - b) + p01.0 * (1.0 - a) * b + p11.0 * a * b,
        p00.1 * (1.0 - a) * (1.0 - b) + p10.1 * a * (1.0 - b) + p01.1 * (1.0 - a) * b + p11.1 * a * b,
    )
}

/// Orthorectify one tile from a multi-band source patch (bands planar).
pub fn ortho_tile(model: &dyn SensorModel, dem: Option<&DemGrid>, undulation: &dyn Fn(f64, f64) -> f64, s: &OrthoSpec, src: &[Patch<'_>]) -> Result<OrthoOut> {
    let mut m = Mapper { model, dem, undulation, s, cache: HashMap::new() };
    let n = s.w * s.h;
    let mut bands: Vec<Vec<f32>> = (0..src.len()).map(|_| vec![f32::NAN; n]).collect();
    let mut mask = vec![0u8; n];
    let mut cells = 0usize;
    let mut max_err = 0f64;
    let mut worst = (0i64, 0i64, 0i64);
    // Initial cells of 64 output pixels, split down to 2 px.
    let mut stack: Vec<(i64, i64, i64)> = Vec::new();
    let c0 = 64i64;
    let mut j = 0i64;
    while j < s.h as i64 {
        let mut i = 0i64;
        while i < s.w as i64 {
            stack.push((i, j, c0));
            i += c0;
        }
        j += c0;
    }
    while let Some((i0, j0, sz)) = stack.pop() {
        let (i1, j1) = (i0 + sz, j0 + sz);
        let c = [m.vertex(i0, j0), m.vertex(i1, j0), m.vertex(i0, j1), m.vertex(i1, j1)];
        let finite = c.iter().all(|p| p.0.is_finite() && p.1.is_finite());
        // Test points: the centre and the four edge midpoints.
        let mut err = 0f64;
        if finite {
            for (a, b) in [(0.5, 0.5), (0.5, 0.0), (0.0, 0.5), (1.0, 0.5), (0.5, 1.0)] {
                let ex = m.exact(i0 as f64 + a * sz as f64, j0 as f64 + b * sz as f64);
                let ip = bilerp(c, a, b);
                let d = (ex.0 - ip.0).hypot(ex.1 - ip.1);
                err = if d.is_finite() { err.max(d) } else { f64::INFINITY };
            }
        }
        if (!finite || err > s.bound_px) && sz > 2 {
            let hs = sz / 2;
            stack.extend_from_slice(&[(i0, j0, hs), (i0 + hs, j0, hs), (i0, j0 + hs, hs), (i0 + hs, j0 + hs, hs)]);
            continue;
        }
        cells += 1;
        if finite && err > max_err {
            max_err = err;
            worst = (i0, j0, sz);
        }
        for jj in j0..j1.min(s.h as i64) {
            for ii in i0..i1.min(s.w as i64) {
                let a = (ii as f64 + 0.5 - i0 as f64) / sz as f64;
                let b = (jj as f64 + 0.5 - j0 as f64) / sz as f64;
                let (x, y) = if finite { bilerp(c, a, b) } else { m.exact(ii as f64 + 0.5, jj as f64 + 0.5) };
                if !(x.is_finite() && y.is_finite()) {
                    continue;
                }
                let k = jj as usize * s.w + ii as usize;
                let mut ok = true;
                for (bi, p) in src.iter().enumerate() {
                    let v = sample(p, s.kernel, x, y);
                    if !v.is_finite() {
                        ok = false;
                    }
                    bands[bi][k] = v;
                }
                mask[k] = u8::from(ok);
            }
        }
    }
    Ok(OrthoOut { bands, mask, cells, max_err_px: max_err, worst_cell: worst })
}
