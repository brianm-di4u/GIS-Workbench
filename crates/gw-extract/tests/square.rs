// AC-10.1: squared-building corners are 90° ± 0.1° (here to 1e-9°) on noisy, randomly rotated
// rectangles, L, T and U shapes (Research/13 §2.5 protocol), plus the fallback and thinning.
use gw_extract::{area, max_corner_error, min_area_rect, simplify, square, square_geographic};
use std::f64::consts::PI;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64) / ((1u64 << 53) as f64)
    }
    fn gauss(&mut self) -> f64 {
        let (u, v) = (self.next().max(1e-300), self.next());
        (-2.0 * u.ln()).sqrt() * (2.0 * PI * v).cos()
    }
}

fn shapes() -> Vec<(&'static str, Vec<[f64; 2]>)> {
    vec![
        ("rect", vec![[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]]),
        ("L", vec![[0.0, 0.0], [30.0, 0.0], [30.0, 10.0], [10.0, 10.0], [10.0, 25.0], [0.0, 25.0]]),
        ("T", vec![[0.0, 0.0], [36.0, 0.0], [36.0, 10.0], [23.0, 10.0], [23.0, 30.0], [13.0, 30.0], [13.0, 10.0], [0.0, 10.0]]),
        ("U", vec![[0.0, 0.0], [36.0, 0.0], [36.0, 30.0], [26.0, 30.0], [26.0, 12.0], [10.0, 12.0], [10.0, 30.0], [0.0, 30.0]]),
    ]
}

#[test]
fn squares_noisy_rotated_shapes_to_right_angles() {
    let mut rng = Lcg(42);
    for sigma in [0.3, 1.0] {
        for (name, s) in shapes() {
            let (mut fails, mut worst) = (0, 0.0f64);
            for _ in 0..1000 {
                let rot = rng.next() * 2.0 * PI;
                let (sn, cs) = rot.sin_cos();
                let noisy: Vec<[f64; 2]> = s.iter().map(|p| [cs * p[0] - sn * p[1] + 500.0 + sigma * rng.gauss(), sn * p[0] + cs * p[1] - 300.0 + sigma * rng.gauss()]).collect();
                match square(&noisy, false) {
                    Ok(q) => {
                        assert_eq!(q.ring.len(), s.len(), "{name}: corner count");
                        worst = worst.max(q.max_corner_error_deg);
                    }
                    Err(_) => fails += 1,
                }
            }
            assert!(worst < 1e-9, "{name} σ={sigma}: worst corner {worst}°");
            assert!(fails <= 5, "{name} σ={sigma}: {fails} failures in 1000");
        }
    }
}

#[test]
fn keeps_position_close() {
    let s = &shapes()[0].1;
    let q = square(s, false).unwrap();
    for (a, b) in q.ring.iter().zip(s) {
        assert!((a[0] - b[0]).hypot(a[1] - b[1]) < 1e-9);
    }
    assert!((area(&q.ring) - 200.0).abs() < 1e-9);
}

#[test]
fn diagonals_and_fallback() {
    // An octagon-ish outline with 45° corners squares in the diagonal mode.
    let o = vec![[0.0, 0.0], [10.0, 0.0], [15.0, 5.0], [15.0, 15.0], [0.0, 15.0]];
    let q = square(&o, true).unwrap();
    assert!(max_corner_error(&q.ring, PI / 4.0) < 1e-9);
    assert!(square(&o, false).is_err() || square(&o, false).unwrap().max_corner_error_deg < 1e-9);
    // Minimum-area rectangle of a skewed quad.
    let r = min_area_rect(&[[0.0, 0.0], [10.0, 1.0], [9.0, 6.0], [-1.0, 5.0]]).unwrap();
    assert!(r.max_corner_error_deg < 1e-9);
    assert_eq!(r.ring.len(), 4);
}

#[test]
fn geographic_squaring_is_right_angled_in_enu() {
    // A 20 × 10 m building at 60° N, given in degrees (longitude degrees are half as long).
    let (lat0, lon0) = (60.0, 10.0);
    let mlat = 1.0 / 111_412.0;
    let mlon = 1.0 / 55_800.0;
    let raw = [[0.0, 0.0], [20.2, 0.3], [19.9, 10.1], [-0.1, 9.8]].map(|p| [lon0 + p[0] * mlon, lat0 + p[1] * mlat, 120.0 + p[0] * 0.01]);
    let (ring, sq) = square_geographic(&raw, false).unwrap();
    assert_eq!(ring.len(), 4);
    assert!(sq.max_corner_error_deg < 1e-9);
    // Re-measure the corners in a fresh ENU frame.
    let enu: Vec<[f64; 2]> = ring.iter().map(|p| { let e = gw_geodesy::wgs84::geodetic_to_enu(p[1], p[0], p[2], lat0, lon0, 120.0); [e[0], e[1]] }).collect();
    assert!(max_corner_error(&enu, PI / 2.0) < 1e-6);
    assert!(ring.iter().all(|p| (p[2] - ring[0][2]).abs() < 1e-12));
}

#[test]
fn simplify_keeps_corners() {
    let pts: Vec<[f64; 2]> = (0..=20).map(|i| [i as f64, if i <= 10 { 0.0 } else { (i - 10) as f64 } + 0.01 * (i % 2) as f64]).collect();
    assert_eq!(simplify(&pts, 0.1), vec![0, 10, 20]);
}

#[test]
// REQ-MEN-08: medial-axis length and width of a rotated 100 × 10 m strip and of a curved band.
fn medial_axis_strip_and_curve() {
    use gw_extract::medial::medial_axis;
    for rot in [0.0f64, 0.4, 1.1] {
        let (s, c) = rot.sin_cos();
        let r: Vec<[f64; 2]> = [[0.0, 0.0], [100.0, 0.0], [100.0, 10.0], [0.0, 10.0]].iter().map(|p| [c * p[0] - s * p[1], s * p[0] + c * p[1]]).collect();
        let m = medial_axis(&r, 600).unwrap();
        assert!((m.length - 100.0).abs() < 2.0, "rot {rot}: length {}", m.length);
        assert!((m.mean_width - 10.0).abs() < 0.6, "rot {rot}: width {}", m.mean_width);
    }
    // Half annulus, radii 40 and 50: centre-line length π·45 ≈ 141.4 m, width 10 m.
    let mut ring = Vec::new();
    for k in 0..=90 { let a = PI * k as f64 / 90.0; ring.push([50.0 * a.cos(), 50.0 * a.sin()]); }
    for k in (0..=90).rev() { let a = PI * k as f64 / 90.0; ring.push([40.0 * a.cos(), 40.0 * a.sin()]); }
    let m = medial_axis(&ring, 800).unwrap();
    assert!((m.length - PI * 45.0).abs() / (PI * 45.0) < 0.03, "arc length {}", m.length);
    assert!((m.mean_width - 10.0).abs() < 0.8, "arc width {}", m.mean_width);
}
