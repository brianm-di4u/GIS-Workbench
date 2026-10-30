// Hole filling (grid::fill): Laplace interpolation reproduces a plane across a building-sized hole
// and many scattered holes, and a large grid with a large hole converges quickly (cascadic start).
use gw_pointcloud::grid::fill;
use std::time::Instant;

fn plane(x: usize, y: usize) -> f32 {
    0.02 * x as f32 - 0.015 * y as f32 + 1650.0
}

#[test]
fn plane_across_a_large_hole_and_scattered_holes() {
    let (w, h) = (900, 700);
    let mut z: Vec<f32> = (0..w * h).map(|k| plane(k % w, k / w)).collect();
    for y in 200..520 {
        for x in 250..700 {
            z[y * w + x] = f32::NAN;
        }
    }
    for k in (0..w * h).step_by(7) {
        z[k] = f32::NAN;
    }
    let t = Instant::now();
    fill(&mut z, w, h, 800);
    let ms = t.elapsed().as_millis();
    let worst = (0..w * h).map(|k| (z[k] - plane(k % w, k / w)).abs()).fold(0f32, f32::max);
    assert!(worst < 0.02, "worst error {worst} m");
    assert!(ms < 5000, "fill took {ms} ms");
}

#[test]
#[ignore]
fn bench_dtm_like() {
    let (w, h) = (3000, 3000);
    let mut z: Vec<f32> = (0..w * h).map(|k| plane(k % w, k / w) + ((k % w) as f32 * 0.05).sin()).collect();
    let mut s = 12345u64;
    for v in z.iter_mut() {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        if (s >> 33) % 2 == 0 {
            *v = f32::NAN;
        }
    }
    for b in 0..40 {
        let (x0, y0) = (100 + (b * 571) % 2700, 100 + (b * 389) % 2700);
        for y in y0..y0 + 80 {
            for x in x0..x0 + 120 {
                z[y * w + x] = f32::NAN;
            }
        }
    }
    let t = Instant::now();
    fill(&mut z, w, h, 800);
    eprintln!("fill 3000² DTM-like: {} ms", t.elapsed().as_millis());
}

#[test]
fn ground_filter_on_one_point_and_one_row() {
    use gw_pointcloud::smrf::{smrf, Params};
    let p = Params { cell: 1.0, slope: 0.15, window: 18.0, threshold: 0.5, scalar: 1.25, low_noise: 2.0 };
    // A single point (LAS version-matrix files) and a single row of points.
    assert_eq!(smrf(&[470692.44, 4602888.9, 16.0], None, &p), vec![2]);
    let row: Vec<f32> = (0..20).flat_map(|i| [i as f32, 0.0, 10.0]).collect();
    assert!(smrf(&row, None, &p).iter().all(|&c| c == 2));
}
