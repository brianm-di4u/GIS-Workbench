//! Map-projected images (GeoTIFF, world files): an affine pixel → map transform plus the
//! map CRS. These are 2-D models: the height does not move the image point.

use crate::{Ground, SensorModel};
use gw_abi::{Error, Result};
use gw_geodesy::grids::{utmups_forward, utmups_reverse};
use gw_geodesy::wgs84::A;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MapCrs {
    /// EPSG:4326 / 4979 — map x = lon, y = lat (degrees).
    Geographic,
    /// UTM zone (EPSG:326zz north, 327zz south).
    Utm { zone: i32, north: bool },
    /// UPS (EPSG:5041 north, 5042 south).
    Ups { north: bool },
    /// EPSG:3857 (display only, never for measurement).
    WebMercator,
    /// ARC polar zone 9 (north) / 18 (south) of RPF (MIL-A-89007): azimuthal equidistant on a
    /// sphere of radius 6 378 137 m centred on the pole, as GDAL's NITF driver. No EPSG code; the
    /// internal codes 990009 / 990018 select it (IMP-14).
    ArcPolar { north: bool },
}

impl MapCrs {
    pub fn from_epsg(code: i32) -> Option<MapCrs> {
        match code {
            4326 | 4979 | 4030 => Some(MapCrs::Geographic),
            32601..=32660 => Some(MapCrs::Utm { zone: code - 32600, north: true }),
            32701..=32760 => Some(MapCrs::Utm { zone: code - 32700, north: false }),
            // NAD83 / UTM 1N–23N (IMP-12): the same transverse Mercator on GRS80 (flattening differs
            // from WGS 84 by 1e-11). NAD83 is taken as WGS 84, as the embedded proj4 definition does
            // (towgs84 = 0); the datum offset (~1–2 m in CONUS) is not applied either way.
            26901..=26923 => Some(MapCrs::Utm { zone: code - 26900, north: true }),
            5041 | 32661 => Some(MapCrs::Ups { north: true }),
            5042 | 32761 => Some(MapCrs::Ups { north: false }),
            3857 | 900913 | 3785 => Some(MapCrs::WebMercator),
            990009 => Some(MapCrs::ArcPolar { north: true }),
            990018 => Some(MapCrs::ArcPolar { north: false }),
            _ => None,
        }
    }

    pub fn to_geographic(&self, x: f64, y: f64) -> Result<(f64, f64)> {
        Ok(match *self {
            MapCrs::Geographic => (y, x),
            MapCrs::Utm { zone, north } => {
                let (lat, lon, _, _) = utmups_reverse(zone, north, x, y)?;
                (lat, lon)
            }
            MapCrs::Ups { north } => {
                let (lat, lon, _, _) = utmups_reverse(0, north, x, y)?;
                (lat, lon)
            }
            MapCrs::ArcPolar { north } => {
                let rho = x.hypot(y);
                let colat = (rho / A).to_degrees();
                let lon = if north { x.atan2(-y) } else { x.atan2(y) }.to_degrees();
                (if north { 90.0 - colat } else { colat - 90.0 }, lon)
            }
            MapCrs::WebMercator => {
                let lon = (x / A).to_degrees();
                let lat = (2.0 * (y / A).exp().atan() - std::f64::consts::FRAC_PI_2).to_degrees();
                (lat, lon)
            }
        })
    }

    pub fn from_geographic(&self, lat: f64, lon: f64) -> Result<(f64, f64)> {
        Ok(match *self {
            MapCrs::Geographic => (lon, lat),
            MapCrs::Utm { zone, .. } => {
                let u = utmups_forward(lat, lon, Some(zone))?;
                (u.easting, u.northing)
            }
            MapCrs::Ups { .. } => {
                let u = utmups_forward(lat, lon, Some(0))?;
                (u.easting, u.northing)
            }
            MapCrs::ArcPolar { north } => {
                let rho = A * (90.0 - lat.abs()).to_radians();
                let l = lon.to_radians();
                (rho * l.sin(), if north { -rho * l.cos() } else { rho * l.cos() })
            }
            MapCrs::WebMercator => {
                let lat = lat.clamp(-85.051_128_78, 85.051_128_78);
                (A * lon.to_radians(), A * (std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan().ln())
            }
        })
    }
}

/// GDAL-style geotransform: map_x = g0 + g1·x + g2·y; map_y = g3 + g4·x + g5·y, with
/// (x, y) corner-origin pixel coordinates.
#[derive(Clone, Debug, PartialEq)]
pub struct GeoTransformModel {
    pub gt: [f64; 6],
    inv: [f64; 6],
    pub crs: MapCrs,
}

impl GeoTransformModel {
    pub fn new(gt: [f64; 6], crs: MapCrs) -> Result<Self> {
        let det = gt[1] * gt[5] - gt[2] * gt[4];
        if det.abs() < 1e-300 || gt.iter().any(|v| !v.is_finite()) {
            return Err(Error::invalid("degenerate geotransform"));
        }
        let i1 = gt[5] / det;
        let i2 = -gt[2] / det;
        let j1 = -gt[4] / det;
        let j2 = gt[1] / det;
        let inv = [-(i1 * gt[0] + i2 * gt[3]), i1, i2, -(j1 * gt[0] + j2 * gt[3]), j1, j2];
        Ok(GeoTransformModel { gt, inv, crs })
    }

    pub fn pixel_to_map(&self, x: f64, y: f64) -> (f64, f64) {
        (self.gt[0] + self.gt[1] * x + self.gt[2] * y, self.gt[3] + self.gt[4] * x + self.gt[5] * y)
    }

    pub fn map_to_pixel(&self, mx: f64, my: f64) -> (f64, f64) {
        (self.inv[0] + self.inv[1] * mx + self.inv[2] * my, self.inv[3] + self.inv[4] * mx + self.inv[5] * my)
    }
}

impl SensorModel for GeoTransformModel {
    fn name(&self) -> &str {
        match self.crs {
            MapCrs::Geographic => "Map (geographic)",
            MapCrs::Utm { .. } => "Map (UTM)",
            MapCrs::Ups { .. } => "Map (UPS)",
            MapCrs::WebMercator => "Map (Web Mercator)",
            MapCrs::ArcPolar { .. } => "Map (ARC polar zone)",
        }
    }
    fn ground_to_image(&self, g: Ground) -> Result<(f64, f64)> {
        let (mx, my) = self.crs.from_geographic(g.lat, g.lon)?;
        Ok(self.map_to_pixel(mx, my))
    }
    fn image_to_ground(&self, x: f64, y: f64, h: f64) -> Result<Ground> {
        let (mx, my) = self.pixel_to_map(x, y);
        let (lat, lon) = self.crs.to_geographic(mx, my)?;
        Ok(Ground { lat, lon, h })
    }
    fn is_3d(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utm_geotransform_round_trip() {
        let m = GeoTransformModel::new([444_000.0, 0.5, 0.0, 3_685_000.0, 0.0, -0.5], MapCrs::Utm { zone: 38, north: true }).unwrap();
        let g = m.image_to_ground(281.09, 587.288, 0.0).unwrap();
        assert!((g.lat - 33.3).abs() < 1e-6 && (g.lon - 44.4).abs() < 1e-6, "{g:?}");
        let (x, y) = m.ground_to_image(g).unwrap();
        assert!((x - 281.09).abs() < 1e-6 && (y - 587.288).abs() < 1e-6);
    }

    #[test]
    fn arc_polar_matches_gdal() {
        // GDAL 3.13's ARC_System_Zone_09 geotransform for bug3337.ntf (GDAL data server) and its
        // corner coordinates (TE oracle truth).
        let m = GeoTransformModel::new([-1669792.3618991037, 724.736268185375, 0.0, -556597.453966368, 0.0, -724.7362681853748], MapCrs::from_epsg(990009).unwrap()).unwrap();
        let g = m.image_to_ground(0.0, 0.0, 0.0).unwrap();
        assert!((g.lat - 74.188_611_699_158_1).abs() < 1e-9 && (g.lon + 71.565_051_177_077_99).abs() < 1e-9, "{g:?}");
        let g = m.image_to_ground(1536.0, 0.0, 0.0).unwrap();
        assert!((g.lat - 82.928_932_188_134_52).abs() < 1e-9 && (g.lon + 45.0).abs() < 1e-9, "{g:?}");
        let (x, y) = m.ground_to_image(Ground { lat: 75.857_864_376_269_05, lon: -45.0, h: 0.0 }).unwrap();
        assert!((x - 768.0).abs() < 0.01 && (y - 768.0).abs() < 0.01, "{x} {y}");
    }

    #[test]
    fn web_mercator_round_trip() {
        let c = MapCrs::WebMercator;
        let (x, y) = c.from_geographic(51.5, -0.12).unwrap();
        let (lat, lon) = c.to_geographic(x, y).unwrap();
        assert!((lat - 51.5).abs() < 1e-10 && (lon + 0.12).abs() < 1e-10);
    }
}
