//! Geodesic inverse/direct problems and polygon area on WGS 84 (REQ-GEO-05, REQ-MEN-02),
//! through `geographiclib-rs` (MIT), Karney's algorithms. Method label for results:
//! "geodesic (Karney 2013, WGS 84)".

use geographiclib_rs::{DirectGeodesic, Geodesic, InverseGeodesic, PolygonArea, Winding};
use std::sync::OnceLock;

pub const METHOD: &str = "geodesic (Karney 2013, WGS 84)";

fn wgs84() -> &'static Geodesic {
    static G: OnceLock<Geodesic> = OnceLock::new();
    G.get_or_init(Geodesic::wgs84)
}

/// Inverse problem: distance (m), forward azimuth at 1 and at 2 (°, true).
pub fn inverse(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> (f64, f64, f64) {
    let (s12, azi1, azi2, _a12) = wgs84().inverse(lat1, lon1, lat2, lon2);
    (s12, azi1, azi2)
}

/// Direct problem: end point and forward azimuth at the end.
pub fn direct(lat1: f64, lon1: f64, azi1: f64, s12: f64) -> (f64, f64, f64) {
    let (lat2, lon2, azi2) = wgs84().direct(lat1, lon1, azi1, s12);
    (lat2, lon2, azi2)
}

/// Polygon (geodesic edges): absolute area (m²) and perimeter (m). Vertex order free.
pub fn polygon_area(lats: &[f64], lons: &[f64]) -> (f64, f64) {
    let mut pa = PolygonArea::new(wgs84(), Winding::CounterClockwise);
    for (&la, &lo) in lats.iter().zip(lons) {
        pa.add_point(la, lo);
    }
    // Signed area, then its magnitude: either winding gives the enclosed area (an unsigned
    // compute returns the rest of the earth for a clockwise ring).
    let (perim, area, _n) = pa.compute(true);
    (area.abs(), perim)
}

/// Length of a polyline with geodesic edges.
pub fn polyline_length(lats: &[f64], lons: &[f64]) -> f64 {
    let mut s = 0.0;
    for i in 1..lats.len().min(lons.len()) {
        s += inverse(lats[i - 1], lons[i - 1], lats[i], lons[i]).0;
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jfk_lhr() {
        // GeodSolve: 40.6N 73.8W → 51.6N 0.5W: s12 = 5 551 759.400 m, azi1 51.198883, azi2 107.821777
        let (s, a1, a2) = inverse(40.6, -73.8, 51.6, -0.5);
        assert!((s - 5_551_759.400).abs() < 1e-3, "{s}");
        assert!((a1 - 51.198_883).abs() < 1e-6 && (a2 - 107.821_777).abs() < 1e-6);
        let (la, lo, _) = direct(40.6, -73.8, a1, s);
        assert!((la - 51.6).abs() < 1e-9 && (lo + 0.5).abs() < 1e-9);
    }

    #[test]
    fn planimeter_quad() {
        // Perimeter 3 989.378 845 m, area 994 695.8 m² (Research/05 §5.2)
        let (area, perim) = polygon_area(&[33.300, 33.300, 33.309, 33.309], &[44.400, 44.4107, 44.4107, 44.400]);
        assert!((perim - 3_989.378_845).abs() < 1e-5, "{perim}");
        assert!((area - 994_695.8).abs() < 0.1, "{area}");
    }

    #[test]
    fn ten_km_distance() {
        // AT-03.2 support: 10 km along the meridian, direct then inverse within 1 mm.
        let (la, lo, _) = direct(33.3, 44.4, 0.0, 10_000.0);
        let (s, _, _) = inverse(33.3, 44.4, la, lo);
        assert!((s - 10_000.0).abs() < 1e-3);
    }
}

#[cfg(test)]
mod winding_tests {
    use super::*;

    #[test]
    fn clockwise_and_counter_clockwise_rings_give_the_same_area() {
        let (lats, lons) = (vec![0.0, 0.0, 0.01, 0.01], vec![0.0, 0.01, 0.01, 0.0]);
        let (a, _) = polygon_area(&lats, &lons);
        let rl: Vec<f64> = lats.iter().rev().copied().collect();
        let ro: Vec<f64> = lons.iter().rev().copied().collect();
        let (b, _) = polygon_area(&rl, &ro);
        assert!((a - b).abs() < 1e-6 && a > 1.2e6 && a < 1.3e6, "{a} {b}");
    }
}
