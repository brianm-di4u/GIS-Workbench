//! REQ-GAP-39: the triangulation, its edits and the builders against brute-force checks:
//! topology, (constrained) Delaunay emptiness with exact predicates and visibility, every
//! constraint present, vertex and line removal, ridge and drain monotonicity, DEM thinning within
//! its tolerance, state round trips, and replay determinism.

use gw_tin::make::{self, GridSpec};
use gw_tin::mesh::{Fail, Mesh, E_CONS, HARD, INF, SOFT, VOID, V_DEAD};
use gw_tin::ops::{self, Op};
use gw_tin::pred::incircle;
use gw_tin::state;

struct Rng(u64);
impl Rng {
    fn f(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn o128(ax: i128, ay: i128, bx: i128, by: i128, cx: i128, cy: i128) -> i128 {
    (ax - cx) * (by - cy) - (ay - cy) * (bx - cx)
}

/// Do segments p–q and a–b cross properly (exact, on i128)?
fn cross(p: (i128, i128), q: (i128, i128), a: (i128, i128), b: (i128, i128)) -> bool {
    let s = |x: i128| x.signum();
    s(o128(p.0, p.1, q.0, q.1, a.0, a.1)) * s(o128(p.0, p.1, q.0, q.1, b.0, b.1)) < 0 && s(o128(a.0, a.1, b.0, b.1, p.0, p.1)) * s(o128(a.0, a.1, b.0, b.1, q.0, q.1)) < 0
}

/// Every live real triangle has no live vertex strictly inside its circumcircle that it can see
/// (a vertex hidden behind a constrained edge does not count). Returns the number of violations.
fn delaunay_violations(m: &Mesh) -> usize {
    let cons: Vec<((i128, i128), (i128, i128))> = m
        .triangles()
        .flat_map(|t| (0..3).filter(move |&i| m.te[t as usize][i] & E_CONS != 0).map(move |i| (t, i)))
        .map(|(t, i)| {
            let v = m.tv[t as usize];
            let (a, b) = (v[(i + 1) % 3] as usize, v[(i + 2) % 3] as usize);
            ((3 * m.x[a] as i128, 3 * m.y[a] as i128), (3 * m.x[b] as i128, 3 * m.y[b] as i128))
        })
        .collect();
    let live: Vec<usize> = (0..m.nv()).filter(|&v| m.vf[v] & V_DEAD == 0 && m.vt[v] != u32::MAX).collect();
    let mut bad = 0;
    for t in m.triangles() {
        let v = m.tv[t as usize].map(|w| w as usize);
        let c = ((m.x[v[0]] + m.x[v[1]] + m.x[v[2]]) as i128, (m.y[v[0]] + m.y[v[1]] + m.y[v[2]]) as i128);
        for &w in &live {
            if v.contains(&w) {
                continue;
            }
            if incircle(m.x[v[0]], m.y[v[0]], m.x[v[1]], m.y[v[1]], m.x[v[2]], m.y[v[2]], m.x[w], m.y[w]) <= 0 {
                continue;
            }
            let p = (3 * m.x[w] as i128, 3 * m.y[w] as i128);
            if cons.iter().any(|&(a, b)| cross(c, p, a, b)) {
                continue;
            }
            bad += 1;
        }
    }
    bad
}

/// Every unconstrained interior edge locally Delaunay (Lawson): with the constraints that is a
/// constrained Delaunay triangulation. The count of edges that are not.
fn local_violations(m: &Mesh) -> usize {
    let mut bad = 0;
    for t in m.triangles() {
        let v = m.tv[t as usize];
        for i in 0..3 {
            if m.te[t as usize][i] & E_CONS != 0 {
                continue;
            }
            let u = m.tn[t as usize][i];
            let w = m.tv[u as usize];
            if w.contains(&INF) {
                continue;
            }
            let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
            let Some(q) = w.iter().copied().find(|&x| x != a && x != b) else { continue };
            let (p, q) = (q as usize, v.map(|x| x as usize));
            if incircle(m.x[q[0]], m.y[q[0]], m.x[q[1]], m.y[q[1]], m.x[q[2]], m.y[q[2]], m.x[p], m.y[p]) > 0 {
                bad += 1;
            }
        }
    }
    bad
}

fn hull_count(m: &Mesh) -> usize {
    (0..m.tv.len()).filter(|&t| m.tf[t] & 1 == 0 && m.tv[t].contains(&INF)).count()
}

fn random_mesh(n: usize, seed: u64) -> (Mesh, Vec<[f64; 3]>) {
    let mut r = Rng(seed);
    let mut pts = Vec::new();
    for _ in 0..n {
        let (x, y) = (500.0 + 1000.0 * r.f(), -200.0 + 800.0 * r.f());
        pts.push([x, y, 100.0 + 0.05 * x + 20.0 * (y / 90.0).sin()]);
    }
    let flat: Vec<f64> = pts.iter().flatten().copied().collect();
    let (m, rep) = make::from_points(&flat, 0.001, 0.0, 1 << 20).unwrap();
    assert_eq!(rep.vertices, n);
    (m, pts)
}

#[test]
fn random_points_give_the_delaunay_triangulation() {
    for seed in [1, 2, 3] {
        let (m, _) = random_mesh(600, seed);
        m.check().unwrap();
        assert_eq!(delaunay_violations(&m), 0);
        // Euler: 2n − 2 − h triangles for n points with h on the hull.
        assert_eq!(m.nreal, 2 * 600 - 2 - hull_count(&m));
    }
}

#[test]
fn grid_posts_cocircular_everywhere() {
    let (w, h) = (40, 30);
    let z: Vec<f32> = (0..w * h).map(|k| ((k % w) as f32 * 0.3).sin() * 5.0 + (k / w) as f32 * 0.2).collect();
    let g = GridSpec { w, h, ax: 0.0, ay: 0.0, bx: 2.0, by: -2.0 };
    let (m, rep) = make::from_dem(&g, &z, -1.0, 1 << 20, 0.001, |_, _| {}).unwrap();
    assert_eq!(rep.vertices, w * h);
    m.check().unwrap();
    assert_eq!(delaunay_violations(&m), 0);
    assert_eq!(m.nreal, 2 * (w - 1) * (h - 1));
}

#[test]
fn breaklines_are_edges_and_the_rest_is_constrained_delaunay() {
    let (mut m, _) = random_mesh(800, 7);
    let mut r = Rng(99);
    let mut key = 1;
    // Random hard and soft lines, some crossing each other, plus a void ring.
    for k in 0..14 {
        let n = 2 + (k % 4);
        let pts: Vec<[f64; 3]> = (0..n).map(|_| [520.0 + 960.0 * r.f(), -180.0 + 760.0 * r.f(), 120.0 + 10.0 * r.f()]).collect();
        let kind = if k % 2 == 0 { HARD as f64 } else { SOFT as f64 };
        let mut a = vec![1.0, 4.0, key as f64, kind, 0.0, n as f64];
        a.extend(pts.iter().flatten());
        let res = ops::apply_all(&mut m, &ops::parse(&a).unwrap());
        assert!(res[0].is_ok(), "line {k}: {:?}", res[0]);
        key += 1;
    }
    let ring = [[900.0, 100.0, 0.0], [1000.0, 120.0, 0.0], [980.0, 220.0, 0.0], [890.0, 200.0, 0.0]];
    let mut a = vec![1.0, 4.0, 500.0, VOID as f64, 1.0, 4.0];
    a.extend(ring.iter().flatten());
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap())[0].is_ok());
    m.check().unwrap();
    assert_eq!(delaunay_violations(&m), 0);
    // Each line: consecutive path vertices are constrained edges, and every path vertex lies on
    // the drawn polyline (within a few grid steps: crossings are rounded to the grid).
    for l in m.lines.iter().filter(|l| l.alive) {
        let n = l.path.len();
        let segs = if l.closed { n } else { n - 1 };
        for k in 0..segs {
            let (a, b) = (l.path[k], l.path[(k + 1) % n]);
            let (t, i) = m.find_edge(a, b).or_else(|| m.find_edge(b, a)).expect("edge exists");
            assert!(m.te[t as usize][i] & E_CONS != 0);
        }
        for &v in &l.path {
            let (x, y) = (m.px(v), m.py(v));
            let d = l.defs.windows(2).chain(if l.closed { vec![[l.defs[l.defs.len() - 1], l.defs[0]]] } else { vec![] }.iter().map(|p| &p[..])).map(|s| seg(x, y, m.px(s[0]), m.py(s[0]), m.px(s[1]), m.py(s[1]))).fold(f64::INFINITY, f64::min);
            assert!(d < 0.01, "path vertex {d} m off the line");
        }
    }
    assert!(m.stats.steiner > 0, "some lines cross");
    // Exclusion: the ring's inside is NaN, outside is not.
    m.classify();
    assert!(m.height_at(940.0, 160.0).is_nan());
    assert!(m.height_at(800.0, 160.0).is_finite());
}

fn seg(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let s = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - s * dx).powi(2) + (py - ay - s * dy).powi(2)).sqrt()
}

#[test]
fn soft_lines_keep_the_surface_and_removing_lines_restores_it() {
    let (mut m, pts) = random_mesh(500, 11);
    let mut r = Rng(5);
    let probes: Vec<(f64, f64)> = (0..400).map(|_| (560.0 + 880.0 * r.f(), -150.0 + 700.0 * r.f())).collect();
    let before: Vec<f64> = probes.iter().map(|&(x, y)| m.height_at(x, y)).collect();
    let along_before: Vec<f64> = (0..=400).map(|k| k as f64 / 200.0).map(|s| if s <= 1.0 { (600.0 + 700.0 * s, -100.0 + 550.0 * s) } else { (1300.0 + 100.0 * (s - 1.0), 450.0 - 450.0 * (s - 1.0)) }).map(|(x, y)| m.height_at(x, y)).collect();
    let line = [[600.0, -100.0, f64::NAN], [1300.0, 450.0, f64::NAN], [1400.0, 0.0, f64::NAN]];
    let mut a = vec![1.0, 4.0, 1.0, SOFT as f64, 0.0, 3.0];
    a.extend(line.iter().flatten());
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap())[0].is_ok());
    // A soft line is densified at every crossed edge with the surface's heights: along the line
    // the surface is unchanged (to the 1 mm grid). Off the line the Delaunay flips around the new
    // vertices change it (measured, not bounded here).
    let along: Vec<(f64, f64)> = (0..=400).map(|k| k as f64 / 200.0).map(|s| if s <= 1.0 { (600.0 + 700.0 * s, -100.0 + 550.0 * s) } else { (1300.0 + 100.0 * (s - 1.0), 450.0 - 450.0 * (s - 1.0)) }).collect();
    let _ = along_before.len();
    let worst = along.iter().zip(&along_before).map(|(&(x, y), b)| (m.height_at(x, y) - b).abs()).fold(0.0, f64::max);
    assert!(worst < 0.01, "soft line changed the surface along it by {worst} m");
    assert!(ops::apply_all(&mut m, &ops::parse(&[1.0, 5.0, 1.0]).unwrap())[0].is_ok());
    m.check().unwrap();
    assert_eq!(delaunay_violations(&m), 0);
    assert_eq!(m.alive_vertices(), pts.len(), "the line's vertices went with it");
    let after: Vec<f64> = probes.iter().map(|&(x, y)| m.height_at(x, y)).collect();
    let worst = before.iter().zip(&after).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
    assert!(worst < 1e-9, "removing the line left {worst} m");
    // A hard line with its own heights changes the surface; removing it restores it.
    let mut a = vec![1.0, 4.0, 2.0, HARD as f64, 0.0, 2.0, 700.0, 0.0, 300.0, 1200.0, 400.0, 310.0];
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap())[0].is_ok());
    assert!((m.height_at(950.0, 200.0) - 305.0).abs() < 0.01);
    a = vec![1.0, 5.0, 2.0];
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap())[0].is_ok());
    let again: Vec<f64> = probes.iter().map(|&(x, y)| m.height_at(x, y)).collect();
    let worst = before.iter().zip(&again).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
    assert!(worst < 1e-9, "removing the hard line left {worst} m");
}

#[test]
fn a_vertex_on_the_diagonals_of_its_star_goes_without_a_rebuild() {
    // A lattice cell's exact centre: a four-sided star with the vertex on both diagonals.
    let (w, h) = (21, 21);
    let z: Vec<f32> = (0..w * h).map(|k| 100.0 + ((k * 13) % 7) as f32).collect();
    let g = GridSpec { w, h, ax: 0.0, ay: 0.0, bx: 1.0, by: 1.0 };
    let (mut m, _) = make::from_dem(&g, &z, -1.0, 1 << 20, 0.001, |_, _| {}).unwrap();
    let before = m.alive_vertices();
    for (x, y) in [(10.5, 10.5), (3.5, 7.5), (15.5, 2.5)] {
        ops::apply(&mut m, &Op::AddPoint { x, y, z: 110.0 }).unwrap();
        m.check().unwrap();
        ops::apply(&mut m, &Op::DelPoint { x, y, r: 0.001 }).unwrap();
        m.check().unwrap();
    }
    assert_eq!(m.stats.rebuilds, 0, "the star was rebuilt, not re-triangulated");
    assert_eq!(m.alive_vertices(), before);
    assert_eq!(m.height_at(10.0, 10.0), 100.0 + ((10 * 21 + 10) * 13 % 7) as f64);
}

#[test]
fn mass_point_edits_and_removal_keep_delaunay() {
    let (mut m, pts) = random_mesh(400, 21);
    let mut r = Rng(77);
    let mut live: Vec<[f64; 3]> = pts.clone();
    for k in 0..300 {
        let op = if k % 3 == 0 {
            let p = [520.0 + 960.0 * r.f(), -180.0 + 760.0 * r.f(), 150.0];
            live.push(p);
            Op::AddPoint { x: p[0], y: p[1], z: p[2] }
        } else if k % 3 == 1 {
            let i = (r.f() * live.len() as f64) as usize % live.len();
            let p = live.swap_remove(i);
            Op::DelPoint { x: p[0], y: p[1], r: 0.0005 }
        } else {
            let i = (r.f() * live.len() as f64) as usize % live.len();
            let p = live[i];
            let q = [p[0] + 20.0 * (r.f() - 0.5), p[1] + 20.0 * (r.f() - 0.5), p[2] + 1.0];
            live[i] = q;
            Op::MovePoint { x: p[0], y: p[1], r: 0.0005, nx: q[0], ny: q[1], nz: q[2] }
        };
        let res = ops::apply(&mut m, &op);
        assert!(res.is_ok(), "edit {k} {op:?}: {res:?}");
    }
    m.check().unwrap();
    assert_eq!(delaunay_violations(&m), 0);
    assert_eq!(m.alive_vertices(), live.len());
    assert!(m.stats.rebuilds > 0, "some hull vertices were removed");
}

#[test]
fn ridge_and_drain_profiles_are_monotone() {
    // A valley with a dam across it, and a ridge with a saddle.
    let (w, h) = (120, 100);
    let mut z = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            let (x, y) = (i as f32, j as f32);
            let valley = 0.02 * (x - 60.0).powi(2) + 0.5 * y;
            let dam = if (48..52).contains(&j) { 8.0 } else { 0.0 };
            z[j * w + i] = valley + dam;
        }
    }
    let g = GridSpec { w, h, ax: 0.0, ay: 0.0, bx: 1.0, by: 1.0 };
    let (mut m, _) = make::from_dem(&g, &z, 0.05, 1 << 20, 0.001, |_, _| {}).unwrap();
    // Drawn upstream to downstream the wrong way round (low end first): it is turned.
    let line = [60.0, 5.0, 60.3, 50.0, 59.7, 95.0];
    let mut a = vec![1.0, 7.0, 9.0, 1.0, 3.0];
    a.extend(line);
    let res = ops::apply_all(&mut m, &ops::parse(&a).unwrap());
    let d = res[0].as_ref().unwrap();
    let p = d.profile.as_ref().unwrap();
    assert!(p.reversed && p.changed > 0 && p.conflicts == 0, "{p:?}");
    // Sample along the stored path itself (the drawn polyline, downstream).
    let l = *m.by_key.get(&9).unwrap();
    let path = m.lines[l as usize].path.clone();
    let mut samples = Vec::new();
    for s in path.windows(2) {
        for k in 0..=20 {
            let t = k as f64 / 20.0;
            let (x, y) = (m.px(s[0]) + (m.px(s[1]) - m.px(s[0])) * t, m.py(s[0]) + (m.py(s[1]) - m.py(s[0])) * t);
            samples.push(m.height_at(x, y));
        }
    }
    assert!(samples.iter().all(|v| v.is_finite()));
    let rises = samples.windows(2).filter(|w| w[1] > w[0] + 1e-6).count();
    assert_eq!(rises, 0, "the drain profile rises somewhere");
    // The dam was cut: at the dam the surface is now at most the upstream height.
    let cut = m.height_at(60.3, 50.0);
    assert!(cut < 26.5, "dam not cut: {cut}");
    // A ridge fills instead: never lower than before anywhere along it.
    let (mut m2, _) = make::from_dem(&g, &z, 0.05, 1 << 20, 0.001, |_, _| {}).unwrap();
    let before: Vec<f64> = (0..=100).map(|k| m2.height_at(20.0, 5.0 + 0.9 * k as f64)).collect();
    let a = vec![1.0, 7.0, 10.0, 2.0, 2.0, 20.0, 95.0, 20.0, 5.0];
    let res = ops::apply_all(&mut m2, &ops::parse(&a).unwrap());
    assert!(res[0].is_ok(), "{:?}", res[0]);
    let after: Vec<f64> = (0..=100).map(|k| m2.height_at(20.0, 5.0 + 0.9 * k as f64)).collect();
    assert!(before.iter().zip(&after).all(|(b, a)| *a >= *b - 0.02), "a ridge never cuts");
    // Downhill from the high end (y = 95) to y = 5: after[k] (y rising) must not decrease with k.
    assert!(after.windows(2).all(|w| w[1] >= w[0] - 1e-6), "ridge profile not monotone");
    m2.check().unwrap();
    // A ridge across the drain takes the crossing vertex: the conflict is reported, not hidden.
    let mut cross = state::load(&state::save(&m)).unwrap();
    let a = vec![1.0, 7.0, 11.0, 2.0, 2.0, 45.0, 30.0, 75.0, 30.2];
    let res = ops::apply_all(&mut cross, &ops::parse(&a).unwrap());
    let r = res[0].as_ref().unwrap().profile.as_ref().unwrap();
    assert!(r.changed > 0 && r.conflicts == 1, "{r:?}");
    cross.check().unwrap();
    // Deleting the drain restores the dam.
    assert!(ops::apply_all(&mut m, &ops::parse(&[1.0, 5.0, 9.0]).unwrap())[0].is_ok());
    assert!(m.height_at(60.3, 50.0) > 32.0, "dam back: {}", m.height_at(60.3, 50.0));
}

#[test]
fn dem_thinning_meets_its_tolerance_and_raster_matches() {
    let (w, h) = (150, 120);
    let mut z = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            let (x, y) = (i as f32, j as f32);
            z[j * w + i] = 1500.0 + 30.0 * (x / 23.0).sin() * (y / 31.0).cos() + 0.1 * x;
        }
    }
    // Voids, one on the outline.
    for j in 40..55 {
        for i in 60..80 {
            z[j * w + i] = f32::NAN;
        }
    }
    for i in 0..10 {
        z[i] = f32::NAN;
    }
    let g = GridSpec { w, h, ax: 1000.0, ay: 5000.0, bx: 1.0, by: -1.0 };
    for tol in [0.0, 0.1, 0.5, 2.0] {
        let (mut m, rep) = make::from_dem(&g, &z, tol, 1 << 22, 0.001, |_, _| {}).unwrap();
        m.check().unwrap();
        let r = make::rasterize(&mut m, &g);
        let mut worst: f64 = 0.0;
        let mut covered = 0;
        for k in 0..w * h {
            if z[k].is_finite() {
                assert!(r[k].is_finite(), "post {k} not covered (tol {tol})");
                covered += 1;
                worst = worst.max((r[k] as f64 - z[k] as f64).abs());
            }
        }
        // f32 heights near 1500 m carry 1e-4 m of rounding.
        assert!(worst <= tol + 2e-4, "tol {tol}: worst {worst}");
        assert!(rep.max_error <= tol);
        assert!(covered > 0);
        if tol >= 0.5 {
            assert!(rep.vertices < w * h / 4, "tol {tol}: {} vertices", rep.vertices);
        }
    }
}

#[test]
fn state_round_trip_and_damage_refused() {
    let (mut m, _) = random_mesh(300, 31);
    let a = vec![2.0, 4.0, 1.0, HARD as f64, 0.0, 2.0, 600.0, 0.0, 200.0, 1400.0, 500.0, 210.0, 4.0, 3.0, VOID as f64, 1.0, 3.0, 900.0, 100.0, 0.0, 1000.0, 100.0, 0.0, 950.0, 200.0, 0.0];
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap()).iter().all(|r| r.is_ok()));
    let b = state::save(&m);
    let mut m2 = state::load(&b).unwrap();
    assert_eq!(state::save(&m2), b);
    m.classify();
    m2.classify();
    for k in 0..50 {
        let (x, y) = (600.0 + 15.0 * k as f64, 50.0 + 8.0 * k as f64);
        let (h1, h2) = (m.height_at(x, y), m2.height_at(x, y));
        assert!(h1 == h2 || (h1.is_nan() && h2.is_nan()));
    }
    for cut in [0, 7, 8, 100, b.len() / 2, b.len() - 1] {
        assert!(state::load(&b[..cut]).is_err());
    }
    let mut bad = b.clone();
    let k = bad.len() / 2;
    bad[k] ^= 0x40;
    bad[k + 1] ^= 0x13;
    // A flipped byte is either refused or still a consistent mesh (a height can change).
    if let Ok(m3) = state::load(&bad) {
        m3.check().unwrap();
    }
}

#[test]
fn replay_is_deterministic() {
    let build = || random_mesh(500, 41).0;
    let mut r = Rng(3);
    let mut list = vec![0.0];
    let mut n = 0;
    for k in 0..40 {
        match k % 4 {
            0 => list.extend([1.0, 540.0 + 900.0 * r.f(), -160.0 + 700.0 * r.f(), 130.0]),
            1 => list.extend([4.0, 100.0 + k as f64, HARD as f64, 0.0, 2.0, 560.0 + 860.0 * r.f(), -150.0 + 650.0 * r.f(), 140.0, 560.0 + 860.0 * r.f(), -150.0 + 650.0 * r.f(), 145.0]),
            2 => list.extend([4.0, 100.0 + k as f64, SOFT as f64, 0.0, 2.0, 560.0 + 860.0 * r.f(), -150.0 + 650.0 * r.f(), 0.0, 560.0 + 860.0 * r.f(), -150.0 + 650.0 * r.f(), 0.0]),
            _ => list.extend([5.0, 100.0 + (k - 2) as f64]),
        }
        n += 1;
    }
    list[0] = n as f64;
    let ops_all = ops::parse(&list).unwrap();
    let mut a = build();
    let ra = ops::apply_all(&mut a, &ops_all);
    // One by one, with a save/load between each (the worker → main thread hand-over).
    let mut b = build();
    for op in &ops_all {
        let _ = ops::apply(&mut b, op);
        b = state::load(&state::save(&b)).unwrap();
    }
    assert!(ra.iter().filter(|r| r.is_ok()).count() >= 30, "{ra:?}");
    a.dirty = true;
    b.dirty = true;
    assert_eq!(state::save(&a), state::save(&b));
    a.check().unwrap();
    assert_eq!(delaunay_violations(&a), 0);
}

#[test]
fn refusals_by_name() {
    let (mut m, _) = random_mesh(50, 51);
    for (a, want) in [
        (vec![1.0, 1.0, 1e12, 0.0, 1.0], "outside"),
        (vec![1.0, 2.0, -5000.0, -5000.0, 1.0], "no mass point"),
        (vec![1.0, 5.0, 77.0], "no line"),
        (vec![1.0, 4.0, 1.0, SOFT as f64, 0.0, 2.0, -5000.0, 0.0, 0.0, 600.0, 0.0, 0.0], "leaves the surface"),
        (vec![1.0, 4.0, 1.0, HARD as f64, 0.0, 2.0, 600.0, 0.0, f64::NAN, 700.0, 0.0, 1.0], "height"),
    ] {
        let r = ops::apply_all(&mut m, &ops::parse(&a).unwrap());
        match &r[0] {
            Err(Fail::Refused(e)) => assert!(e.contains(want), "{e} vs {want}"),
            other => panic!("{a:?}: {other:?}"),
        }
    }
    for bad in [vec![], vec![1.0], vec![1.0, 99.0], vec![2.0, 1.0, 0.0, 0.0, 0.0], vec![1.0, 4.0, 1.5, 1.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0], vec![1.0, 1.0, 0.0, 0.0, 0.0, 9.0]] {
        assert!(ops::parse(&bad).is_err(), "{bad:?}");
    }
    m.check().unwrap();
    // Collinear and too few points.
    assert!(make::from_points(&[0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 2.0, 2.0, 1.0], 0.001, 0.0, 100).is_err());
    assert!(make::from_points(&[0.0, 0.0, 1.0, 1.0, 0.0, 1.0], 0.001, 0.0, 100).is_err());
    assert!(make::from_points(&[0.0, 0.0, 1.0, 2.0e6, 0.0, 1.0, 0.0, 1.0, 1.0], 0.001, 0.0, 100).is_err(), "over 1000 km");
}

#[test]
fn coordinates_at_the_grid_limit() {
    // ±520 km at 1 mm: the integer predicates must not overflow (debug builds check).
    let s = 520_000.0;
    let pts = [-s, -s, 0.0, s, -s, 1.0, s, s, 2.0, -s, s, 3.0, 0.0, 0.0, 4.0, 1.0, 0.0005, 5.0];
    let (mut m, _) = make::from_points(&pts, 0.001, 0.0, 100).unwrap();
    m.check().unwrap();
    assert_eq!(delaunay_violations(&m), 0);
    assert!((m.height_at(0.0, 0.0) - 4.0).abs() < 1e-9);
    let a = vec![1.0, 4.0, 1.0, HARD as f64, 0.0, 2.0, -s, -s, 0.0, s, s, 2.0];
    assert!(ops::apply_all(&mut m, &ops::parse(&a).unwrap())[0].is_ok());
    m.check().unwrap();
}

#[test]
fn swap_retriangulate_and_line_replacement_stress() {
    // The edits the mixed stress leaves out, among point and line edits. A swapped edge is a
    // constraint, so everything stays constrained Delaunay; re-triangulating gives swaps back.
    let iters: usize = std::env::var("GW_TIN_STRESS").ok().and_then(|v| v.parse().ok()).unwrap_or(600).min(2000);
    let (mut m, _) = random_mesh(700, 67);
    let mut r = Rng(4321);
    let mut lines: Vec<u64> = Vec::new();
    let mut next = 1u64;
    let (mut swaps, mut retris, mut sets) = (0, 0, 0);
    for k in 0..iters {
        let pt = |r: &mut Rng| [540.0 + 920.0 * r.f(), -170.0 + 740.0 * r.f()];
        let c = (r.f() * 8.0) as u32;
        let op = match c {
            0 | 1 | 2 => {
                let p = pt(&mut r);
                next += 1;
                Op::Swap { key: next - 1, x: p[0], y: p[1] }
            }
            3 => {
                let c0 = pt(&mut r);
                let rad = 30.0 + 120.0 * r.f();
                Op::Retri { ring: (0..5).map(|j| {
                    let a = j as f64 * 1.2566;
                    [c0[0] + rad * a.cos(), c0[1] + rad * a.sin()]
                }).collect() }
            }
            4 if !lines.is_empty() => {
                let key = lines[(r.f() * lines.len() as f64) as usize % lines.len()];
                let (p, q) = (pt(&mut r), pt(&mut r));
                Op::SetLine { key, kind: if r.f() < 0.5 { HARD } else { SOFT }, closed: false, pts: vec![[p[0], p[1], 120.0], [q[0], q[1], 125.0]] }
            }
            5 => {
                let (p, q) = (pt(&mut r), pt(&mut r));
                lines.push(next);
                next += 1;
                Op::AddLine { key: next - 1, kind: if r.f() < 0.5 { HARD } else { SOFT }, closed: false, pts: vec![[p[0], p[1], 120.0], [q[0], q[1], 125.0]] }
            }
            6 => {
                let p = pt(&mut r);
                Op::AddPoint { x: p[0], y: p[1], z: 110.0 + 30.0 * r.f() }
            }
            _ => {
                let (p, q) = (pt(&mut r), pt(&mut r));
                Op::MovePoint { x: p[0], y: p[1], r: 40.0, nx: q[0], ny: q[1], nz: f64::NAN }
            }
        };
        match ops::apply(&mut m, &op) {
            Ok(_) => {
                if matches!(op, Op::Swap { .. }) {
                    swaps += 1;
                } else if matches!(op, Op::Retri { .. }) {
                    retris += 1;
                } else if matches!(op, Op::SetLine { .. }) {
                    sets += 1;
                }
            }
            Err(Fail::Refused(_)) => {}
            Err(Fail::Broken(e)) => panic!("edit {k} {op:?} broke the TIN: {e}"),
        }
        assert_eq!(local_violations(&m), 0, "after edit {k} {op:?}");
    }
    m.check().unwrap();
    eprintln!("swap stress: {swaps} swaps, {retris} re-triangulations, {sets} replacements, {} vertices", m.alive_vertices());
    assert!(swaps > 50 && retris > 20 && sets > 10, "{swaps} {retris} {sets}");
}

#[test]
fn mixed_edits_stress() {
    // Random points, then hundreds of mixed edits: every result is a valid constrained Delaunay
    // triangulation with every line's edges present.
    // 600 by default: edit 511 is where a Steiner point just off its edge left a spoke not Delaunay.
    let iters: usize = std::env::var("GW_TIN_STRESS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let (mut m, _) = random_mesh(700, 61);
    let mut r = Rng(1234);
    let mut keys: Vec<u64> = Vec::new();
    let mut next = 1u64;
    let mut ok = 0;
    for k in 0..iters {
        let px = || 0.0;
        let _ = px;
        let pt = |r: &mut Rng| [540.0 + 920.0 * r.f(), -170.0 + 740.0 * r.f()];
        let c = (r.f() * 10.0) as u32;
        let op = match c {
            0 | 1 => {
                let p = pt(&mut r);
                Op::AddPoint { x: p[0], y: p[1], z: 100.0 + 50.0 * r.f() }
            }
            2 => {
                let p = pt(&mut r);
                Op::DelPoint { x: p[0], y: p[1], r: 30.0 }
            }
            3 => {
                let (p, q) = (pt(&mut r), pt(&mut r));
                Op::MovePoint { x: p[0], y: p[1], r: 30.0, nx: q[0], ny: q[1], nz: f64::NAN }
            }
            4 | 5 => {
                let n = 2 + (r.f() * 4.0) as usize;
                let kind = if r.f() < 0.5 { HARD } else { SOFT };
                let pts = (0..n).map(|_| {
                    let p = pt(&mut r);
                    [p[0], p[1], 100.0 + 40.0 * r.f()]
                }).collect();
                keys.push(next);
                next += 1;
                Op::AddLine { key: next - 1, kind, closed: false, pts }
            }
            6 if !keys.is_empty() => {
                let i = (r.f() * keys.len() as f64) as usize % keys.len();
                Op::DelLine { key: keys.swap_remove(i) }
            }
            7 => {
                let c0 = pt(&mut r);
                let rad = 20.0 + 40.0 * r.f();
                let ring = (0..5).map(|j| {
                    let a = j as f64 * 1.2566;
                    [c0[0] + rad * a.cos(), c0[1] + rad * a.sin()]
                }).collect();
                Op::DelIn { ring }
            }
            8 => {
                let (p, q) = (pt(&mut r), pt(&mut r));
                keys.push(next);
                next += 1;
                Op::Profile { key: next - 1, ridge: r.f() < 0.5, pts: vec![p, q] }
            }
            _ => {
                let c0 = pt(&mut r);
                let pts = (0..4).map(|j| {
                    // Not exactly π/2 on purpose: the square's corners stay off the axes.
                    #[allow(clippy::approx_constant)]
                    let a = j as f64 * 1.5708;
                    [c0[0] + 25.0 * a.cos(), c0[1] + 25.0 * a.sin(), 0.0]
                }).collect();
                keys.push(next);
                next += 1;
                Op::AddLine { key: next - 1, kind: VOID, closed: true, pts }
            }
        };
        match ops::apply(&mut m, &op) {
            Ok(_) => ok += 1,
            Err(Fail::Refused(_)) => {
                if let Op::AddLine { key, .. } | Op::Profile { key, .. } = &op {
                    keys.retain(|x| x != key);
                }
            }
            Err(Fail::Broken(e)) => panic!("edit {k} {op:?} broke the TIN: {e}"),
        }
        // Crossing lines breed Steiner points: past 200 000 triangles, every 10th edit.
        if k % 10 == 0 || m.triangles().count() < 200_000 {
            assert_eq!(local_violations(&m), 0, "after edit {k} {op:?}");
        }
        if k % 25 == 0 || k + 1 == iters {
            m.check().unwrap_or_else(|e| panic!("after edit {k} {op:?}: {e}"));
        }
    }
    m.check().unwrap();
    eprintln!("stress: {} vertices, {} triangles, {} lines alive, {ok} of {iters} applied", m.alive_vertices(), m.triangles().count(), m.lines.iter().filter(|l| l.alive).count());
    assert_eq!(local_violations(&m), 0);
    // The brute-force check is triangles × vertices × constraints: only while that is quick in debug
    // (the local check above is sufficient by Lawson's lemma).
    if m.triangles().count() < 30_000 {
        assert_eq!(delaunay_violations(&m), 0);
    }
    for l in m.lines.iter().filter(|l| l.alive) {
        let n = l.path.len();
        let segs = if l.closed { n } else { n - 1 };
        for k in 0..segs {
            let (a, b) = (l.path[k], l.path[(k + 1) % n]);
            let (t, i) = m.find_edge(a, b).expect("line edge");
            assert!(m.te[t as usize][i] & E_CONS != 0);
        }
    }
    assert!(ok > iters / 2, "{ok} of {iters} edits applied");
    let b = state::save(&m);
    assert_eq!(state::save(&state::load(&b).unwrap()), b);
}
