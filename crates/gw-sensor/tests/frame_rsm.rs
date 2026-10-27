//! REQ-SNS-03/04: frame camera (with distortion), pushbroom and RSM polynomial models round-trip
//! image → ground → image, and behave as their geometry says.

use gw_sensor::frame::{Camera, FrameModel, PushbroomModel};
use gw_sensor::rsm::{Domain, Poly, RsmModel};
use gw_sensor::{Ground, SensorModel};

fn camera(w: f64, h: f64) -> Camera {
    Camera { focal_mm: 100.0, pixel_mm: 0.005, cx: w / 2.0, cy: h / 2.0, k: [1e-5, -2e-9, 0.0], p: [1e-6, -2e-6], width: w, height: h }
}

#[test]
fn frame_round_trip_and_nadir() {
    let cam = camera(10000.0, 7000.0);
    let m = FrameModel::new(cam, Ground { lat: 34.5, lon: -116.5, h: 3650.0 }, [2.0, -3.0, 30.0], "frame").unwrap();
    let mut worst = 0f64;
    for j in 0..=10 {
        for i in 0..=10 {
            let (x, y) = (i as f64 * 1000.0, j as f64 * 700.0);
            let g = m.image_to_ground(x, y, 650.0).unwrap();
            let (x2, y2) = m.ground_to_image(g).unwrap();
            worst = worst.max((x2 - x).hypot(y2 - y));
            assert!((g.h - 650.0).abs() < 1e-3);
        }
    }
    assert!(worst < 1e-6, "round trip {worst} px");
    // Nadir camera: the principal point looks straight down; east is to the right, north up.
    let n = FrameModel::new(Camera { k: [0.0; 3], p: [0.0; 2], ..cam }, Ground { lat: 34.5, lon: -116.5, h: 3650.0 }, [0.0, 0.0, 0.0], "nadir").unwrap();
    let c = n.image_to_ground(5000.0, 3500.0, 650.0).unwrap();
    assert!((c.lat - 34.5).abs() < 1e-7 && (c.lon + 116.5).abs() < 1e-7);
    let e = n.image_to_ground(6000.0, 3500.0, 650.0).unwrap();
    let nn = n.image_to_ground(5000.0, 2500.0, 650.0).unwrap();
    assert!(e.lon > c.lon && (e.lat - c.lat).abs() < 1e-6);
    assert!(nn.lat > c.lat && (nn.lon - c.lon).abs() < 1e-6);
    // Ground sample distance: H/f · pixel = 3000 m / 100 mm × 5 µm = 0.15 m.
    let d = gw_geodesy::geodesic::inverse(c.lat, c.lon, e.lat, e.lon).0;
    assert!((d / 1000.0 - 0.15).abs() < 1e-3, "GSD {}", d / 1000.0);
}

#[test]
fn pushbroom_round_trip() {
    let cam = Camera { focal_mm: 1000.0, pixel_mm: 0.008, cx: 6000.0, cy: 0.5, k: [0.0; 3], p: [0.0; 2], width: 12000.0, height: 20000.0 };
    // 450 km up, flying north at 7 km/s, 1 ms per line, a little roll, pitch and yaw drift.
    let m = PushbroomModel::new(cam, Ground { lat: 34.5, lon: -116.5, h: 0.0 }, [-2000.0, -60000.0, 450000.0], [0.0, 7000.0, 0.0], [0.0, -1.0, 0.0], [3.0, -1.0, 0.5], [0.01, 0.0, 0.002], 1e-3, "pushbroom").unwrap();
    let mut worst = 0f64;
    for j in 0..=8 {
        for i in 0..=8 {
            let (x, y) = (i as f64 * 1500.0, j as f64 * 2500.0);
            let g = m.image_to_ground(x, y, 650.0).unwrap();
            let (x2, y2) = m.ground_to_image(g).unwrap();
            worst = worst.max((x2 - x).hypot(y2 - y));
        }
    }
    assert!(worst < 1e-4, "round trip {worst} px");
}

#[test]
fn rsm_round_trip() {
    // A first-order polynomial pair with a mild denominator, geodetic domain.
    let one = |px, py, pz, c: Vec<f64>| Poly { px, py, pz, c };
    let rn = one(1, 1, 1, vec![0.01, -0.02, 1.0, 0.001, 0.05, 0.0, 0.0, 0.0]);
    let rd = one(1, 1, 0, vec![1.0, 0.001, 0.002, 0.0]);
    let cn = one(1, 1, 1, vec![-0.01, 1.0, 0.03, -0.002, 0.04, 0.0, 0.0, 0.0]);
    let cd = one(1, 1, 0, vec![1.0, -0.001, 0.001, 0.0]);
    let off = [2048.0, 2048.0, (-116.5f64).to_radians(), 34.5f64.to_radians(), 650.0];
    let scale = [2048.0, 2048.0, 0.01f64.to_radians(), 0.01f64.to_radians(), 500.0];
    let m = RsmModel::new(Domain::Geodetic, [0.0; 3], [[0.0; 3]; 3], off, scale, [rn, rd, cn, cd], (4096.0, 4096.0)).unwrap();
    let mut worst = 0f64;
    for j in 0..=8 {
        for i in 0..=8 {
            let (x, y) = (i as f64 * 500.0, j as f64 * 500.0);
            let g = m.image_to_ground(x, y, 700.0).unwrap();
            let (x2, y2) = m.ground_to_image(g).unwrap();
            worst = worst.max((x2 - x).hypot(y2 - y));
        }
    }
    assert!(worst < 1e-6, "round trip {worst} px");
    assert!(m.name().contains("experimental"));
}
