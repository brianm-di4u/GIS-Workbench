//! REQ-EXT-16 / AC-10.4 on a synthetic DSM: rotated flat-roofed buildings on sloping ground with
//! trees; every building found at IoU ≥ 0.8 with its height within 0.5 m, trees found as trees.

use gw_terrain::buildings::{extract, Params};
use gw_terrain::Grid;

fn inside(r: &[[f64; 2]], p: [f64; 2]) -> bool {
    let mut c = false;
    let n = r.len();
    let mut j = n - 1;
    for i in 0..n {
        if (r[i][1] > p[1]) != (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0] {
            c = !c;
        }
        j = i;
    }
    c
}

fn rect(cx: f64, cy: f64, w: f64, h: f64, deg: f64) -> Vec<[f64; 2]> {
    let (s, c) = deg.to_radians().sin_cos();
    [[-w / 2.0, -h / 2.0], [w / 2.0, -h / 2.0], [w / 2.0, h / 2.0], [-w / 2.0, h / 2.0]].iter().map(|[x, y]| [cx + x * c - y * s, cy + x * s + y * c]).collect()
}

#[test]
fn finds_buildings_and_trees() {
    let (w, h, cell) = (400usize, 300usize, 0.5f64);
    let bs = vec![(rect(30.0, -30.0, 24.0, 16.0, 0.0), 9.0), (rect(90.0, -50.0, 30.0, 20.0, 15.0), 12.0), (rect(150.0, -100.0, 20.0, 30.0, 30.0), 8.0), (rect(60.0, -110.0, 22.0, 22.0, 45.0), 6.0)];
    let trees = [(120.0, -20.0, 4.0, 10.0), (170.0, -30.0, 3.0, 8.0), (30.0, -80.0, 3.5, 12.0)];
    let mut dsm = vec![0f32; w * h];
    let mut ndsm = vec![0f32; w * h];
    let mut seed = 7u64;
    let mut rnd = || {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
    };
    for j in 0..h {
        for i in 0..w {
            let (x, y) = (i as f64 * cell, -(j as f64) * cell);
            let ground = 600.0 + 0.03 * x - 0.02 * y;
            let mut z = 0.0;
            for (r, hh) in &bs {
                if inside(r, [x, y]) {
                    z = *hh;
                }
            }
            for (tx, ty, tr, th) in trees {
                let d = (x - tx).hypot(y - ty);
                if d < tr {
                    z = f64::max(z, th * (0.6 + 0.4 * (1.0 - (d / tr).powi(2)).sqrt()) - 1.2 * (rnd() + 0.5));
                }
            }
            dsm[j * w + i] = (ground + z + 0.03 * rnd()) as f32;
            ndsm[j * w + i] = (z + 0.03 * rnd()) as f32;
        }
    }
    let g = Grid { w, h, z: &dsm, cell_x: cell, cell_y: cell };
    let (found, tr) = extract(&g, &ndsm, &Params::default());
    eprintln!("{} buildings, {} trees", found.len(), tr.len());
    for (r, hh) in &bs {
        // IoU on a 0.25 m lattice.
        let best = found
            .iter()
            .map(|b| {
                let (mut i, mut u) = (0usize, 0usize);
                let mut y = 0.0;
                while y > -(h as f64) * cell {
                    let mut x = 0.0;
                    while x < w as f64 * cell {
                        let (a, c) = (inside(r, [x, y]), inside(&b.ring, [x, y]));
                        i += usize::from(a && c);
                        u += usize::from(a || c);
                        x += 0.25;
                    }
                    y -= 0.25;
                }
                (i as f64 / u.max(1) as f64, b)
            })
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap())
            .unwrap();
        eprintln!("IoU {:.3} height {:.2} (truth {hh}) squared {} err {:.3}° vertices {}", best.0, best.1.height, best.1.squared, best.1.corner_error_deg, best.1.ring.len());
        assert!(best.0 >= 0.8, "IoU {}", best.0);
        assert!((best.1.height - hh).abs() < 0.5);
    }
    assert_eq!(found.len(), bs.len(), "a tree became a building");
    assert!(tr.len() >= trees.len());
}
