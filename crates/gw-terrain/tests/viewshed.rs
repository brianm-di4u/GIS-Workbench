//! REQ-DEM-13 / AT-18.2 proxy: the reference-plane viewshed against the exact ray-cast oracle on
//! the FX-05 analytic terrain (2 m posts), with and without curvature (AT-18.4), plus the fan,
//! range and timing (PRF-07 worker budget 2 s for 1025²).

use gw_terrain::viewshed::{r3, viewshed, Params, OUTSIDE, VISIBLE};
use gw_terrain::Grid;

fn terrain(lat: f64, lon: f64) -> f64 {
    let x = (lon + 116.5) * 111320.0 * 34.5f64.to_radians().cos();
    let y = (lat - 34.5) * 110940.0;
    let a = 25f64.to_radians();
    let u = x * a.cos() + y * a.sin();
    let v = -x * a.sin() + y * a.cos();
    let mut h = 650.0 + 0.01 * x + 60.0 * (-((u - 300.0) / 150.0).powi(2)).exp() - 30.0 * (-((v + 400.0) / 120.0).powi(2)).exp();
    let r = (x + 300.0).hypot(y - 300.0);
    if r <= 150.0 {
        h = 640.0;
    } else if r < 250.0 {
        let t = (r - 150.0) / 100.0;
        let s = t * t * (3.0 - 2.0 * t);
        h = 640.0 * (1.0 - s) + h * s;
    }
    h
}

fn grid(n: usize, post_deg: f64) -> (Vec<f32>, f64, f64) {
    let (lat0, lon0) = (34.5 + post_deg * n as f64 / 2.0, -116.5 - post_deg * n as f64 / 2.0);
    let mut z = vec![0f32; n * n];
    for j in 0..n {
        for i in 0..n {
            z[j * n + i] = terrain(lat0 - j as f64 * post_deg, lon0 + i as f64 * post_deg) as f32;
        }
    }
    (z, post_deg * 111320.0 * 34.5f64.to_radians().cos(), post_deg * 110950.0)
}

#[test]
fn reference_planes_agree_with_ray_casting() {
    let n = 1025;
    let (z, cx, cy) = grid(n, 2e-5);
    let g = Grid { w: n, h: n, z: &z, cell_x: cx, cell_y: cy };
    // Observer on the valley floor south-east of the ridge, 2 m mast, 1.8 m target.
    let p = Params { ox: 700, oy: 640, observer_h: 2.0, target_h: 1.8, cc: 0.87, min_dist: 0.0, max_dist: 0.0, az_start: 0.0, az_end: 0.0 };
    let t0 = std::time::Instant::now();
    let v = viewshed(&g, &p);
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let (mut agree, mut n_test, mut vis) = (0usize, 0usize, 0usize);
    for y in (0..n).step_by(4) {
        for x in (0..n).step_by(4) {
            let k = y * n + x;
            if v[k] == OUTSIDE {
                continue;
            }
            n_test += 1;
            let a = v[k] == VISIBLE;
            vis += usize::from(a);
            if a == r3(&g, &p, x, y) {
                agree += 1;
            }
        }
    }
    let frac = agree as f64 / n_test as f64;
    eprintln!("viewshed 1025²: {ms:.1} ms, {:.2} % agree with ray casting over {n_test} posts ({:.1} % visible)", frac * 100.0, vis as f64 / n_test as f64 * 100.0);
    assert!(frac >= 0.99, "agreement {frac}");
    // PRF-07 timing is a release-build property (debug code is several times slower); the
    // browser perf spec measures it on the shipped bundle.
    if !cfg!(debug_assertions) {
        assert!(ms < 2000.0, "{ms} ms");
    }
    // AT-18.4: curvature off changes long-range results (a long, flat look over 2 km).
    let pf = Params { cc: 0.0, ..p };
    let vf = viewshed(&g, &pf);
    let diff = v.iter().zip(&vf).filter(|(a, b)| a != b).count();
    assert!(diff > 0, "curvature made no difference");
    // Range and sector limits.
    let ps = Params { max_dist: 500.0, az_start: 45.0, az_end: 135.0, ..p };
    let vs = viewshed(&g, &ps);
    let (ox, oy) = (700i64, 640i64);
    for y in (0..n).step_by(16) {
        for x in (0..n).step_by(16) {
            let k = y * n + x;
            let (dx, dy) = ((x as i64 - ox) as f64 * cx, (oy - y as i64) as f64 * cy);
            let az = (dx.atan2(dy).to_degrees() + 360.0) % 360.0;
            if vs[k] != OUTSIDE {
                assert!(dx.hypot(dy) <= 500.0 + 1e-6 && (45.0..=135.0).contains(&az), "post outside the fan was rated");
            }
        }
    }
}
