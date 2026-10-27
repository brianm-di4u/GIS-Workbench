//! GIS Workbench sensor models (Appendix D `gw-sensor`, REQ-SNS-01..08).
//!
//! Image coordinates everywhere in GIS Workbench are *continuous, corner-origin*:
//! (x, y) = (0, 0) is the top-left corner of the first pixel and the first pixel's centre
//! is (0.5, 0.5). x runs along samples (columns), y along lines (rows). Models that use a
//! pixel-centre convention internally (RPC00B, ICHIPB) convert at their boundary.

pub mod adjusted;
pub mod error;
pub mod gcp;
pub mod frame;
pub mod geotransform;
pub mod intersect;
pub mod rpc;
pub mod rsm;
pub mod sicd;
pub mod terrain;

use gw_abi::Result;

/// Ground point: geodetic latitude/longitude (°, WGS 84) and height above the ellipsoid (m).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ground {
    pub lat: f64,
    pub lon: f64,
    pub h: f64,
}

/// The CSM-like interface (REQ-SNS-01).
pub trait SensorModel {
    fn name(&self) -> &str;
    /// Ground → image (x, y).
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)>;
    /// Image → ground at a given HAE.
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground>;
    /// Valid HAE range of the model (m).
    fn height_range(&self) -> (f64, f64) {
        (-1000.0, 10000.0)
    }
    /// Unmodelled horizontal error σ per axis (m), if the support data states one.
    fn horizontal_sigma(&self) -> Option<f64> {
        None
    }
    /// The model σ split into a bias part (shared by every point of the image) and a random
    /// part (independent per point), per axis. Relative measurements cancel the bias
    /// (REQ-MEN-07). Default: all of it treated as random (no cancellation, conservative).
    fn horizontal_sigma_parts(&self) -> Option<(f64, f64)> {
        self.horizontal_sigma().map(|s| (0.0, s))
    }
    /// Whether the model needs a height (a 3-D sensor model) or maps the image to a surface.
    fn is_3d(&self) -> bool {
        true
    }
    /// Every surface crossing of the image point's locus by a model-specific rule (SICD: the
    /// R/Rdot contour stepped as Volume 3 says, ordered by increasing HAE). `dem_hae(lat, lon)` is
    /// the surface HAE; `post_m` the DEM post spacing. None = use the generic ray march.
    fn surface_crossings(&self, _x: f64, _y: f64, _dem_hae: &dyn Fn(f64, f64) -> f64, _hae_min: f64, _hae_max: f64, _post_m: f64) -> Option<Result<Vec<Ground>>> {
        None
    }
    /// Ground partials ∂(x, y)/∂(lat, lon, h) by central differences.
    fn ground_partials(&self, g: Ground) -> Result<[[f64; 3]; 2]> {
        let (dl, dh) = (1e-6, 1.0);
        let p = |g: Ground| self.ground_to_image(g);
        let a = p(Ground { lat: g.lat + dl, ..g })?;
        let b = p(Ground { lat: g.lat - dl, ..g })?;
        let c = p(Ground { lon: g.lon + dl, ..g })?;
        let d = p(Ground { lon: g.lon - dl, ..g })?;
        let e = p(Ground { h: g.h + dh, ..g })?;
        let f = p(Ground { h: g.h - dh, ..g })?;
        Ok([
            [(a.0 - b.0) / (2.0 * dl), (c.0 - d.0) / (2.0 * dl), (e.0 - f.0) / (2.0 * dh)],
            [(a.1 - b.1) / (2.0 * dl), (c.1 - d.1) / (2.0 * dl), (e.1 - f.1) / (2.0 * dh)],
        ])
    }
}

/// Generic Newton inversion of ground_to_image at a fixed height, used by models without
/// a closed-form inverse (RPC). Converges in 3–5 steps on satellite RPCs.
pub fn invert_at_height<M: SensorModel + ?Sized>(m: &M, x: f64, y: f64, h: f64, start: (f64, f64)) -> Result<Ground> {
    let (mut lat, mut lon) = start;
    for _ in 0..30 {
        let g = Ground { lat, lon, h };
        let (px, py) = m.ground_to_image(g)?;
        let rx = x - px;
        let ry = y - py;
        if rx.abs() < 1e-9 && ry.abs() < 1e-9 {
            return Ok(g);
        }
        let j = m.ground_partials(g)?;
        let (a, b, c, d) = (j[0][0], j[0][1], j[1][0], j[1][1]);
        let det = a * d - b * c;
        if det.abs() < 1e-30 {
            return Err(gw_abi::Error::new(gw_abi::INTERNAL, "singular model Jacobian"));
        }
        let dlat = (d * rx - b * ry) / det;
        let dlon = (-c * rx + a * ry) / det;
        lat += dlat;
        lon += dlon;
        if dlat.abs() < 1e-12 && dlon.abs() < 1e-12 {
            return Ok(Ground { lat, lon, h });
        }
    }
    Ok(Ground { lat, lon, h })
}
