//! REQ-SNS-20: the KLV frame model reproduces FX-10's frame centre and footprint (flat ground at
//! 10 m HAE). The FX-10 truth used spherical-earth ENU offsets, so the agreement is to a few
//! metres, not millimetres.

use gw_geodesy::geodesic::inverse;
use gw_sensor::{frame::FrameModel, Ground, SensorModel};

#[test]
fn fx10_frame0_footprint() {
    let m = FrameModel::from_klv(Ground { lat: -34.51, lon: -58.61, h: 1500.0 }, [0.0, 0.0, 0.0], [90.0, -45.0, 0.0], 20.0, 640.0, 360.0, "KLV").unwrap();
    let c = m.image_to_ground(320.0, 180.0, 10.0).unwrap();
    let d = inverse(c.lat, c.lon, -34.51, -58.59375673061305).0;
    assert!(d < 5.0, "centre off by {d} m");
    let truth = [(-34.50629763736962, -58.590207518984926), (-34.513702362630376, -58.590207518984926), (-34.51303845048671, -58.59666949332041), (-34.506961549513285, -58.59666949332041)];
    for (k, (x, y)) in [(0.0, 0.0), (640.0, 0.0), (640.0, 360.0), (0.0, 360.0)].iter().enumerate() {
        let g = m.image_to_ground(*x, *y, 10.0).unwrap();
        let e = inverse(g.lat, g.lon, truth[k].0, truth[k].1).0;
        eprintln!("corner {k}: {:.7} {:.7} off {e:.1} m", g.lat, g.lon);
        assert!(e < 10.0, "corner {k} off by {e} m");
        // Round trip.
        let (ix, iy) = m.ground_to_image(g).unwrap();
        assert!((ix - x).abs() < 1e-6 && (iy - y).abs() < 1e-6);
    }
}
