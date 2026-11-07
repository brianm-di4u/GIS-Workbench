//! Geolocation-array sensor model for swath products (FC-25, REQ-FMT-54).
//!
//! A swath (PACE OCI, HICO, MODIS-like L1B/L2, any NetCDF/HDF5 with CF or GDAL geolocation arrays)
//! carries latitude and longitude per pixel, or on a regular subsample of the pixels. The model holds
//! those nodes at image positions `xs[i]`, `ys[j]` (continuous, corner-origin: a full-resolution array
//! has its nodes at pixel centres i + 0.5):
//! - image → ground is bilinear interpolation of latitude and longitude in the node cell around the
//!   point, extrapolated linearly from the outer cells up to half a cell past the grid (the image edge);
//! - ground → image inverts that interpolation locally: a bucket index over the cells' latitude/longitude
//!   boxes gives the candidate cells, and Newton's method solves the bilinear map in each.
//!
//! Longitudes are unwrapped along the grid, so a swath that crosses the antimeridian is continuous
//! inside the model; queries and results are normalised to the swath's side. Nodes with no valid
//! position (fill values, off-Earth pixels) make their cells unusable; the model refuses points there.
//! The surface is the one the arrays describe (terrain-corrected or ellipsoid): height is not used.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};

pub const MAX_NODES: usize = 4 << 20;

#[derive(Clone, Debug)]
pub struct GeolocModel {
    name: String,
    nx: usize,
    ny: usize,
    xs: Vec<f64>,
    ys: Vec<f64>,
    lat: Vec<f64>,
    lon: Vec<f64>, // unwrapped
    lon_ref: f64,
    // Bucket index over cell boxes (lat, unwrapped lon).
    b0: (f64, f64),
    bd: (f64, f64),
    bn: (usize, usize),
    start: Vec<u32>,
    items: Vec<u32>, // block ids
    nblk: (usize, usize),
}

/// An angle difference folded into [-180, 180) without fmod (a software routine in wasm: it cost most of
/// the model build on a 2-million-node swath).
fn wrap180(mut d: f64) -> f64 {
    if !d.is_finite() {
        return d;
    }
    if d.abs() > 1e4 {
        return d - 360.0 * ((d + 180.0) / 360.0).floor();
    }
    while d >= 180.0 {
        d -= 360.0;
    }
    while d < -180.0 {
        d += 360.0;
    }
    d
}

/// A cell's [lat0, lat1, lon0, lon1], or None when a corner has no position.
fn cell_bounds(la: &[f64], lu: &[f64], nx: usize, i: usize, j: usize) -> Option<[f64; 4]> {
    let ks = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1];
    if ks.iter().any(|&k| !la[k].is_finite()) {
        return None;
    }
    let (mut b0, mut b1, mut b2, mut b3) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for k in ks {
        b0 = b0.min(la[k]);
        b1 = b1.max(la[k]);
        b2 = b2.min(lu[k]);
        b3 = b3.max(lu[k]);
    }
    Some([b0, b1, b2, b3])
}

const BLOCK: usize = 8;

fn ncell_of(nx: usize, ny: usize) -> usize {
    (nx - 1) * (ny - 1)
}

fn monotonic(v: &[f64]) -> bool {
    v.windows(2).all(|w| w[1] > w[0]) && v.iter().all(|x| x.is_finite())
}

impl GeolocModel {
    /// `lat`/`lon` are ny × nx (row-major, degrees; non-finite or out-of-range = no position).
    pub fn new(name: &str, xs: Vec<f64>, ys: Vec<f64>, lat: &[f64], lon: &[f64]) -> Result<Self> {
        let (nx, ny) = (xs.len(), ys.len());
        if nx < 2 || ny < 2 {
            return Err(Error::invalid("a geolocation grid needs at least 2 × 2 nodes"));
        }
        if nx.saturating_mul(ny) > MAX_NODES {
            return Err(Error::limit("the geolocation grid has too many nodes"));
        }
        if lat.len() != nx * ny || lon.len() != nx * ny {
            return Err(Error::invalid("latitude/longitude arrays do not match the node grid"));
        }
        if !monotonic(&xs) || !monotonic(&ys) {
            return Err(Error::invalid("geolocation node positions must increase"));
        }
        let ok = |la: f64, lo: f64| la.is_finite() && lo.is_finite() && la.abs() <= 90.0 && lo.abs() <= 540.0;
        let mut la = vec![f64::NAN; nx * ny];
        let mut lu = vec![f64::NAN; nx * ny];
        // Unwrap longitude along each row from the left neighbour, and down the first valid column.
        let mut row_ref = f64::NAN;
        let mut valid = 0usize;
        for j in 0..ny {
            let mut prev = f64::NAN;
            for i in 0..nx {
                let k = j * nx + i;
                if !ok(lat[k], lon[k]) {
                    continue;
                }
                let r = if prev.is_finite() {
                    prev
                } else if j > 0 && lu[(j - 1) * nx + i].is_finite() {
                    lu[(j - 1) * nx + i]
                } else if row_ref.is_finite() {
                    row_ref
                } else {
                    lon[k]
                };
                let u = r + wrap180(lon[k] - r);
                lu[k] = u;
                la[k] = lat[k];
                if !row_ref.is_finite() || i == 0 {
                    row_ref = u;
                }
                prev = u;
                valid += 1;
            }
        }
        if valid < 4 {
            return Err(Error::invalid("the geolocation arrays hold fewer than 4 valid positions"));
        }
        let lon_ref = lu.iter().filter(|v| v.is_finite()).sum::<f64>() / valid as f64;
        // The bucket index over blocks of BLOCK × BLOCK cells (their latitude/longitude boxes): one pass over
        // the nodes per block and few index entries, so a 2-million-node swath builds in a few ms; a query
        // tests the cells of the candidate blocks.
        let ncx = nx - 1;
        let ncy = ny - 1;
        let (nbx, nby) = (ncx.div_ceil(BLOCK), ncy.div_ceil(BLOCK));
        let mut boxes = Vec::with_capacity(nbx * nby);
        let (mut a0, mut a1, mut o0, mut o1) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
        for bj in 0..nby {
            for bi in 0..nbx {
                let mut bx = [f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY];
                for j in bj * BLOCK..=((bj + 1) * BLOCK).min(ncy) {
                    for i in bi * BLOCK..=((bi + 1) * BLOCK).min(ncx) {
                        let k = j * nx + i;
                        if la[k].is_finite() {
                            bx[0] = bx[0].min(la[k]);
                            bx[1] = bx[1].max(la[k]);
                            bx[2] = bx[2].min(lu[k]);
                            bx[3] = bx[3].max(lu[k]);
                        }
                    }
                }
                if bx[0].is_finite() {
                    a0 = a0.min(bx[0]);
                    a1 = a1.max(bx[1]);
                    o0 = o0.min(bx[2]);
                    o1 = o1.max(bx[3]);
                }
                boxes.push(bx);
            }
        }
        if !a0.is_finite() || !(0..ncell_of(nx, ny)).any(|c| cell_bounds(&la, &lu, nx, c % ncx, c / ncx).is_some()) {
            return Err(Error::invalid("the geolocation arrays have no cell with four valid corners"));
        }
        let side = (((boxes.len() as f64) / 2.0).sqrt().ceil() as usize).clamp(1, 1024);
        let (bnx, bny) = (side, side);
        let bd = (((a1 - a0) / bny as f64).max(1e-9), ((o1 - o0) / bnx as f64).max(1e-9));
        let span = |b: &[f64; 4]| {
            let j0 = (((b[0] - a0) / bd.0).floor() as isize).clamp(0, bny as isize - 1) as usize;
            let j1 = (((b[1] - a0) / bd.0).floor() as isize).clamp(0, bny as isize - 1) as usize;
            let i0 = (((b[2] - o0) / bd.1).floor() as isize).clamp(0, bnx as isize - 1) as usize;
            let i1 = (((b[3] - o0) / bd.1).floor() as isize).clamp(0, bnx as isize - 1) as usize;
            (j0, j1, i0, i1)
        };
        // CSR layout (counts, offsets, block ids): one allocation, not one per bucket.
        let mut start = vec![0u32; bnx * bny + 1];
        for b in boxes.iter().filter(|b| b[0].is_finite()) {
            let (j0, j1, i0, i1) = span(b);
            for bj in j0..=j1 {
                for bi in i0..=i1 {
                    start[bj * bnx + bi + 1] += 1;
                }
            }
        }
        for k in 0..bnx * bny {
            start[k + 1] += start[k];
        }
        let mut fill = start.clone();
        let mut items = vec![0u32; start[bnx * bny] as usize];
        for (id, b) in boxes.iter().enumerate().filter(|(_, b)| b[0].is_finite()) {
            let (j0, j1, i0, i1) = span(b);
            for bj in j0..=j1 {
                for bi in i0..=i1 {
                    let q = bj * bnx + bi;
                    items[fill[q] as usize] = id as u32;
                    fill[q] += 1;
                }
            }
        }
        let nblk = (nbx, nby);
        Ok(GeolocModel { name: name.to_string(), nx, ny, xs, ys, lat: la, lon: lu, lon_ref, b0: (a0, o0), bd, bn: (bnx, bny), start, items, nblk })
    }

    /// Node interval of `v` in `nodes` (clamped to the outer cells) and its local parameter.
    fn interval(nodes: &[f64], v: f64) -> (usize, f64) {
        let n = nodes.len();
        let i = match nodes.binary_search_by(|p| p.total_cmp(&v)) {
            Ok(i) => i.min(n - 2),
            Err(i) => i.saturating_sub(1).min(n - 2),
        };
        (i, (v - nodes[i]) / (nodes[i + 1] - nodes[i]))
    }

    fn corners(&self, i: usize, j: usize) -> [(f64, f64); 4] {
        let k = |a: usize, b: usize| (self.lat[b * self.nx + a], self.lon[b * self.nx + a]);
        [k(i, j), k(i + 1, j), k(i, j + 1), k(i + 1, j + 1)]
    }

    fn bilinear(c: &[(f64, f64); 4], u: f64, v: f64) -> (f64, f64) {
        let f = |a: f64, b: f64, cc: f64, d: f64| a * (1.0 - u) * (1.0 - v) + b * u * (1.0 - v) + cc * (1.0 - u) * v + d * u * v;
        (f(c[0].0, c[1].0, c[2].0, c[3].0), f(c[0].1, c[1].1, c[2].1, c[3].1))
    }

    /// Solve bilinear(c, u, v) = (lat, lon) by Newton from the cell centre.
    fn invert_cell(c: &[(f64, f64); 4], lat: f64, lon: f64) -> Option<(f64, f64)> {
        let (mut u, mut v) = (0.5, 0.5);
        for _ in 0..12 {
            let (pa, po) = Self::bilinear(c, u, v);
            let (ra, ro) = (lat - pa, lon - po);
            let dau = (c[1].0 - c[0].0) * (1.0 - v) + (c[3].0 - c[2].0) * v;
            let dav = (c[2].0 - c[0].0) * (1.0 - u) + (c[3].0 - c[1].0) * u;
            let dou = (c[1].1 - c[0].1) * (1.0 - v) + (c[3].1 - c[2].1) * v;
            let dov = (c[2].1 - c[0].1) * (1.0 - u) + (c[3].1 - c[1].1) * u;
            let det = dau * dov - dav * dou;
            if det.abs() < 1e-30 {
                return None;
            }
            let du = (ra * dov - dav * ro) / det;
            let dv = (dau * ro - ra * dou) / det;
            u += du;
            v += dv;
            if du.abs() < 1e-12 && dv.abs() < 1e-12 {
                break;
            }
        }
        (u.is_finite() && v.is_finite()).then_some((u, v))
    }

    fn to_image(&self, i: usize, j: usize, u: f64, v: f64) -> (f64, f64) {
        (self.xs[i] + u * (self.xs[i + 1] - self.xs[i]), self.ys[j] + v * (self.ys[j + 1] - self.ys[j]))
    }

    /// Image extent the model answers for: the nodes plus half a node spacing beyond the outer ones.
    fn extent(&self) -> (f64, f64, f64, f64) {
        let (nx, ny) = (self.nx, self.ny);
        (self.xs[0] - 0.5 * (self.xs[1] - self.xs[0]), self.xs[nx - 1] + 0.5 * (self.xs[nx - 1] - self.xs[nx - 2]), self.ys[0] - 0.5 * (self.ys[1] - self.ys[0]), self.ys[ny - 1] + 0.5 * (self.ys[ny - 1] - self.ys[ny - 2]))
    }
}

impl SensorModel for GeolocModel {
    fn name(&self) -> &str {
        &self.name
    }
    fn is_3d(&self) -> bool {
        false
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (x0, x1, y0, y1) = self.extent();
        if !(x >= x0 && x <= x1 && y >= y0 && y <= y1) {
            return Err(Error::range("the point is outside the swath's geolocation grid"));
        }
        let (i, u) = Self::interval(&self.xs, x);
        let (j, v) = Self::interval(&self.ys, y);
        let c = self.corners(i, j);
        if c.iter().any(|p| !p.0.is_finite()) {
            return Err(Error::range("no geolocation at this pixel (fill values in the arrays)"));
        }
        let (lat, lon) = Self::bilinear(&c, u, v);
        let lon = wrap180(lon);
        Ok(Ground { lat: lat.clamp(-90.0, 90.0), lon, h })
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        if !g.lat.is_finite() || !g.lon.is_finite() {
            return Err(Error::invalid("ground point is not finite"));
        }
        let lon = self.lon_ref + wrap180(g.lon - self.lon_ref);
        let (bnx, bny) = self.bn;
        let bj = ((g.lat - self.b0.0) / self.bd.0).floor();
        let bi = ((lon - self.b0.1) / self.bd.1).floor();
        let (x0, x1, y0, y1) = self.extent();
        let ncx = self.nx - 1;
        let mut best: Option<(f64, f64, f64)> = None; // (outside distance, x, y)
        let try_cell = |c: usize| -> Option<(f64, f64, f64)> {
            let (i, j) = (c % ncx, c / ncx);
            let cs = self.corners(i, j);
            let (u, v) = Self::invert_cell(&cs, g.lat, lon)?;
            // Inside the cell (0..1), or past an outer cell into the half-cell margin.
            let out = (-u).max(u - 1.0).max(-v).max(v - 1.0).max(0.0);
            let (x, y) = self.to_image(i, j, u, v);
            let e = 1e-7;
            let ok = out < 1e-9 || (x >= x0 - e && x <= x1 + e && y >= y0 - e && y <= y1 + e && (i == 0 || i == ncx - 1 || j == 0 || j == self.ny - 2));
            ok.then_some((out, x, y))
        };
        let near = |b: f64, n: usize| b >= -1.0 && b <= n as f64;
        if near(bj, bny) && near(bi, bnx) {
            for dj in -1i64..=1 {
                for di in -1i64..=1 {
                    let (jj, ii) = (bj as i64 + dj, bi as i64 + di);
                    if jj < 0 || ii < 0 || jj >= bny as i64 || ii >= bnx as i64 {
                        continue;
                    }
                    let q = jj as usize * bnx + ii as usize;
                    for &blk in &self.items[self.start[q] as usize..self.start[q + 1] as usize] {
                        let (bi0, bj0) = ((blk as usize % self.nblk.0) * BLOCK, (blk as usize / self.nblk.0) * BLOCK);
                        for j in bj0..(bj0 + BLOCK).min(self.ny - 1) {
                            for i in bi0..(bi0 + BLOCK).min(ncx) {
                                let Some(b) = cell_bounds(&self.lat, &self.lon, self.nx, i, j) else { continue };
                                let m = (b[1] - b[0]).max(b[3] - b[2]);
                                if g.lat >= b[0] - m && g.lat <= b[1] + m && lon >= b[2] - m && lon <= b[3] + m {
                                    if let Some(r) = try_cell(j * ncx + i) {
                                        if best.map(|b| r.0 < b.0).unwrap_or(true) {
                                            best = Some(r);
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if best.map(|b| b.0 < 1e-9).unwrap_or(false) {
                        let b = best.unwrap();
                        return Ok((b.1, b.2));
                    }
                }
            }
        }
        best.map(|b| (b.1, b.2)).ok_or_else(|| Error::range("the ground point is outside the swath"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A curved, rotated swath: lat/lon a smooth function of (x, y), optionally across 180°.
    fn swath(w: usize, h: usize, lon0: f64) -> (Vec<f64>, Vec<f64>) {
        let (mut la, mut lo) = (Vec::new(), Vec::new());
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                la.push(30.0 + 0.01 * fy - 0.002 * fx + 1e-6 * fx * fx);
                let l = lon0 + 0.012 * fx + 0.003 * fy + 2e-6 * fy * fx;
                lo.push((l + 540.0).rem_euclid(360.0) - 180.0);
            }
        }
        (la, lo)
    }

    #[test]
    fn round_trips_inside_and_at_edges() {
        let (w, h) = (60, 40);
        let (la, lo) = swath(w, h, 10.0);
        let xs: Vec<f64> = (0..w).map(|i| i as f64 + 0.5).collect();
        let ys: Vec<f64> = (0..h).map(|j| j as f64 + 0.5).collect();
        let m = GeolocModel::new("t", xs, ys, &la, &lo).unwrap();
        // A node is exact.
        let g = m.image_to_ground(10.5, 7.5, 0.0).unwrap();
        assert!((g.lat - la[7 * w + 10]).abs() < 1e-12 && (g.lon - lo[7 * w + 10]).abs() < 1e-12);
        for &(x, y) in &[(0.0, 0.0), (0.2, 39.9), (59.99, 0.01), (31.37, 17.81), (60.0, 40.0)] {
            let g = m.image_to_ground(x, y, 100.0).unwrap();
            let (px, py) = m.ground_to_image(g).unwrap();
            assert!((px - x).abs() < 1e-6 && (py - y).abs() < 1e-6, "{x},{y} → {px},{py}");
        }
        assert!(m.image_to_ground(61.0, 5.0, 0.0).is_err());
        assert!(m.ground_to_image(Ground { lat: -10.0, lon: 10.0, h: 0.0 }).is_err());
    }

    #[test]
    fn antimeridian_and_subsampled_nodes() {
        let (w, h) = (80, 30);
        // Starts at 179.6°E and runs east across the antimeridian.
        let (la, lo) = swath(w, h, 179.6);
        // Every 4th pixel as nodes (plus the last), at their centres.
        let ix: Vec<usize> = (0..w).step_by(4).chain([w - 1]).collect();
        let jx: Vec<usize> = (0..h).step_by(4).chain([h - 1]).collect();
        let (sla, slo): (Vec<f64>, Vec<f64>) = jx.iter().flat_map(|&j| ix.iter().map(move |&i| (j, i))).map(|(j, i)| (la[j * w + i], lo[j * w + i])).unzip();
        let m = GeolocModel::new("t", ix.iter().map(|&i| i as f64 + 0.5).collect(), jx.iter().map(|&j| j as f64 + 0.5).collect(), &sla, &slo).unwrap();
        let mut worst = 0.0f64;
        for j in 0..h {
            for i in 0..w {
                let g = m.image_to_ground(i as f64 + 0.5, j as f64 + 0.5, 0.0).unwrap();
                let dlon = ((g.lon - lo[j * w + i] + 540.0).rem_euclid(360.0) - 180.0).abs();
                worst = worst.max(dlon / 0.012).max((g.lat - la[j * w + i]).abs() / 0.01);
                let (px, py) = m.ground_to_image(Ground { lat: la[j * w + i], lon: lo[j * w + i], h: 0.0 }).unwrap();
                assert!((px - (i as f64 + 0.5)).abs() < 0.05 && (py - (j as f64 + 0.5)).abs() < 0.05, "{i},{j}: {px},{py}");
            }
        }
        // Interpolation between 4-pixel nodes of this curved swath: well under a tenth of a pixel.
        assert!(worst < 0.05, "worst {worst} px");
        let e = m.image_to_ground(70.5, 10.5, 0.0).unwrap();
        assert!(e.lon < -179.0, "{}", e.lon);
    }

    #[test]
    fn fill_values_are_refused_there_only() {
        let (w, h) = (10, 10);
        let (mut la, lo) = swath(w, h, 0.0);
        la[5 * w + 5] = -999.0;
        let xs: Vec<f64> = (0..w).map(|i| i as f64 + 0.5).collect();
        let ys: Vec<f64> = (0..h).map(|j| j as f64 + 0.5).collect();
        let m = GeolocModel::new("t", xs, ys, &la, &lo).unwrap();
        assert!(m.image_to_ground(5.0, 5.0, 0.0).is_err());
        assert!(m.image_to_ground(2.0, 2.0, 0.0).is_ok());
        assert!(GeolocModel::new("t", vec![0.5, 1.5], vec![0.5], &[1.0, 2.0], &[1.0, 2.0]).is_err());
    }
}

#[cfg(test)]
mod bench {
    #[test]
    #[ignore]
    fn build_time() {
        let (nx, ny) = (1272usize, 1710usize);
        let mut la = vec![0.0; nx * ny];
        let mut lo = vec![0.0; nx * ny];
        for j in 0..ny {
            for i in 0..nx {
                la[j * nx + i] = 30.0 + j as f64 * 0.01 + i as f64 * 0.001;
                lo[j * nx + i] = -115.0 + i as f64 * 0.01 - j as f64 * 0.002;
            }
        }
        let t = std::time::Instant::now();
        let _m = super::GeolocModel::new("b", (0..nx).map(|i| i as f64 + 0.5).collect(), (0..ny).map(|j| j as f64 + 0.5).collect(), &la, &lo).unwrap();
        eprintln!("build {:?}", t.elapsed());
    }
}
