//! Radargrammetry tests on the SICD models of the three Umbra Hetch Hetchy collects (XML in
//! fixtures/fx25/sarstereo; CC BY 4.0, Umbra Open Data): pair geometry and the pair finder, the
//! geometry lattice against exact projections, and a synthetic pair (terrain, a log-normal
//! reflectivity texture, independent speckle per image, a cross-parallax offset of the second
//! image) imaged through both models and matched back.

use super::*;
use gw_geodesy::wgs84::ecef_to_geodetic;

const A: &str = "2023-09-28-05-16-39_UMBRA-04"; // incidence 35.3°
const B: &str = "2023-07-27-05-21-14_UMBRA-05"; // 44.9°
const C: &str = "2023-08-25-05-12-40_UMBRA-05"; // 22.7°

pub(crate) fn model(name: &str) -> Sicd {
    let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx25/sarstereo").join(format!("umbra_{name}.sicd.xml"));
    let xml = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let root = gw_parse::xml::parse(&xml).unwrap();
    let rec = gw_parse::sicd::record(&root).unwrap();
    Sicd::new(gw_sensor::sicd::Params::from_record(&rec).unwrap(), name)
}

fn scp(m: &Sicd) -> Ground {
    let (lat, lon, h) = ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]);
    Ground { lat, lon, h }
}

#[test]
fn pair_geometry_of_the_hetch_hetchy_pairs() {
    let (a, b, c) = (model(A), model(B), model(C));
    let g = scp(&a);
    let p10 = pair_geometry(&a, &b, g).unwrap();
    let p22 = pair_geometry(&c, &b, g).unwrap();
    // c60 (2.4) measured 0.547 m/m for pair 10 and 1.92 m/m for pair 22 at the SCP.
    assert!(p10.same_side && p22.same_side);
    assert!((p10.intersection_deg - 10.0).abs() < 1.5, "{p10:?}");
    assert!((p22.intersection_deg - 22.0).abs() < 2.0, "{p22:?}");
    assert!((p10.parallax - 0.547).abs() < 0.03, "{p10:?}");
    assert!((p22.parallax - 1.92).abs() < 0.1, "{p22:?}");
    assert!((p10.incidence_deg[0] - 35.3).abs() < 1.0 && (p10.incidence_deg[1] - 44.9).abs() < 1.0, "{p10:?}");
    assert!(!p10.left[0] && !p10.left[1], "right-looking");
    // The finder ranks the 10° pair first and calls the 22° pair wide.
    let pairs = find_pairs(&[c, a, b], &[0.0, 86400.0 * 34.0, -86400.0 * 29.0], PairLimits::default());
    assert_eq!((pairs[0].a, pairs[0].b), (1, 2), "{:?}", pairs[0]);
    assert!(pairs[0].ok && pairs[0].overlap > 0.5);
    let wide = pairs.iter().find(|p| (p.a, p.b) == (0, 2)).unwrap();
    assert!(!wide.ok && wide.reasons.contains(&"wide"), "{wide:?}");
    // Same collect with itself has no height sensitivity.
    let same = find_pairs(&[model(A), model(A)], &[0.0, 0.0], PairLimits::default());
    assert!(same[0].reasons.contains(&"weak"), "{:?}", same[0]);
}

fn grid_about(g: Ground, n: usize, post: f64) -> LatLonGrid {
    let (kn, ke) = metres_per_degree(g.lat);
    let (dlat, dlon) = (post / kn, post / ke);
    let half = (n - 1) as f64 / 2.0;
    LatLonGrid { lat0: g.lat + half * dlat, lon0: g.lon - half * dlon, dlat, dlon, nx: n, ny: n }
}

#[test]
fn lattice_matches_exact_projections() {
    let a = model(A);
    let g0 = scp(&a);
    let g = grid_about(g0, 201, 2.0);
    let lat = Lattice::build(&a, &g, g0.h - 200.0, g0.h + 300.0, 8, 4.0).unwrap();
    let mut worst: f64 = 0.0;
    let mut wd: f64 = 0.0;
    let mut s = 12345u64;
    let mut rnd = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % 1_000_000) as f64 / 1e6
    };
    for _ in 0..300 {
        let (fi, fj, h) = (rnd() * 200.0, rnd() * 200.0, g0.h - 150.0 + rnd() * 400.0);
        let (la, lo) = g.at(fi, fj);
        let (x, y) = a.ground_to_image(Ground { lat: la, lon: lo, h }).unwrap();
        let q = lat.at(fi, fj, h);
        worst = worst.max((q[0] - x).hypot(q[1] - y));
        let (x2, y2) = a.ground_to_image(Ground { lat: la, lon: lo, h: h + 1.0 }).unwrap();
        wd = wd.max((q[2] - (x2 - x)).hypot(q[3] - (y2 - y)));
    }
    assert!(worst < 0.02, "lattice vs exact {worst} px");
    assert!(wd < 1e-3, "height derivative {wd} px/m");
}

#[test]
fn window_similarity_and_multilook() {
    let (w, h) = (20, 16);
    let a: Vec<f64> = (0..w * h).map(|k| ((k * 7919) % 97) as f64 / 10.0).collect();
    let b: Vec<f64> = a.iter().map(|v| 2.0 * v + 3.0).collect();
    let s = window_similarity(&a, &b, w, h, 2, Cost::Zncc);
    assert!(s.iter().filter(|v| v.is_finite()).all(|v| (v - 1.0).abs() < 1e-9));
    let s2 = window_similarity(&a, &a, w, h, 2, Cost::LogRatio);
    assert!(s2.iter().filter(|v| v.is_finite()).all(|v| (v - 1.0).abs() < 1e-9));
    let neg: Vec<f64> = a.iter().map(|v| -v).collect();
    let s3 = window_similarity(&a, &neg, w, h, 2, Cost::Zncc);
    assert!(s3.iter().filter(|v| v.is_finite()).all(|v| (v + 1.0).abs() < 1e-9));
    let (m, mw, mh) = multilook(&[1.0, 2.0, 3.0, f32::NAN, 0.0, 4.0], 3, 2, 2, 2, true).unwrap();
    assert_eq!((mw, mh), (2, 1));
    assert!((m[0] - (1.0 + 4.0) / 2.0).abs() < 1e-6 && (m[1] - (9.0 + 16.0) / 2.0).abs() < 1e-6, "{m:?}");
    assert!(multilook(&[1.0; 5], 3, 2, 1, 1, false).is_err());
}

/// Synthetic scene about the SCP of image A: heights in metres above `h0` at (east, north).
fn terrain(e: f64, n: f64) -> f64 {
    40.0 * (-((e - 40.0).powi(2) + (n + 30.0).powi(2)) / (2.0 * 70.0f64.powi(2))).exp() - 25.0 * (-((e + 80.0).powi(2) + (n - 60.0).powi(2)) / (2.0 * 50.0f64.powi(2))).exp() + 8.0 * (e / 37.0).sin() * (n / 53.0).cos()
}

struct Rng(u64);
impl Rng {
    fn u(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn gauss(&mut self) -> f64 {
        (-2.0 * self.u().ln()).sqrt() * (std::f64::consts::TAU * self.u()).cos()
    }
}

struct Scene {
    g0: Ground,
    ke: f64,
    kn: f64,
    tex: Vec<f64>,
    tn: usize,
    half: f64,
}

impl Scene {
    fn new(g0: Ground, half: f64, seed: u64) -> Scene {
        let (kn, ke) = metres_per_degree(g0.lat);
        // Reflectivity: smoothed white noise on a 1 m grid, log-normal (σ_ln 0.9).
        let tn = (2.0 * half) as usize + 1;
        let mut r = Rng(seed);
        let mut t: Vec<f64> = (0..tn * tn).map(|_| r.gauss()).collect();
        for _ in 0..2 {
            let src = t.clone();
            for j in 0..tn {
                for i in 0..tn {
                    let (mut s, mut c) = (0.0, 0.0);
                    for jj in j.saturating_sub(1)..(j + 2).min(tn) {
                        for ii in i.saturating_sub(1)..(i + 2).min(tn) {
                            s += src[jj * tn + ii];
                            c += 1.0;
                        }
                    }
                    t[j * tn + i] = s / c;
                }
            }
        }
        let sd = (t.iter().map(|v| v * v).sum::<f64>() / t.len() as f64).sqrt();
        let tex = t.iter().map(|v| (0.9 * v / sd).exp()).collect();
        Scene { g0, ke, kn, tex, tn, half }
    }
    fn hae(&self, e: f64, n: f64) -> f64 {
        self.g0.h + terrain(e, n)
    }
    fn refl(&self, e: f64, n: f64) -> f64 {
        let fx = (e + self.half).clamp(0.0, (self.tn - 1) as f64);
        let fy = (self.half - n).clamp(0.0, (self.tn - 1) as f64);
        let (i, j) = ((fx as usize).min(self.tn - 2), (fy as usize).min(self.tn - 2));
        let (tx, ty) = (fx - i as f64, fy - j as f64);
        let q = |a: usize, b: usize| self.tex[b * self.tn + a];
        (q(i, j) * (1.0 - tx) + q(i + 1, j) * tx) * (1.0 - ty) + (q(i, j + 1) * (1.0 - tx) + q(i + 1, j + 1) * tx) * ty
    }
    #[allow(dead_code)]
    fn latlon(&self, e: f64, n: f64) -> (f64, f64) {
        (self.g0.lat + n / self.kn, self.g0.lon + e / self.ke)
    }

    /// Image `m` of the scene: every 0.25 m ground cell splatted (bilinear) at its projection,
    /// seen displaced by `shift` (east, north metres), then independent exponential speckle;
    /// returned as a 2 × 2 multilooked intensity chip.
    fn image(&self, m: &Sicd, shift: [f64; 2], seed: u64) -> Chip {
        let cell = 0.25;
        let n = (2.0 * self.half / cell) as usize;
        let fine = LatLonGrid { lat0: self.g0.lat + self.half / self.kn, lon0: self.g0.lon - self.half / self.ke, dlat: cell / self.kn, dlon: cell / self.ke, nx: n, ny: n };
        let lat = Lattice::build(m, &fine, self.g0.h - 60.0, self.g0.h + 80.0, 32, 4.0 * (shift[0].abs() + shift[1].abs()) / cell + 4.0).unwrap();
        let mut pos = Vec::with_capacity(n * n);
        let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for j in 0..n {
            for i in 0..n {
                let (e, nn) = (-self.half + i as f64 * cell, self.half - j as f64 * cell);
                let h = self.hae(e, nn);
                let q = lat.at(i as f64 + shift[0] / cell, j as f64 - shift[1] / cell, h);
                pos.push((q[0], q[1], self.refl(e, nn) * cell * cell));
                x0 = x0.min(q[0]);
                y0 = y0.min(q[1]);
                x1 = x1.max(q[0]);
                y1 = y1.max(q[1]);
            }
        }
        let (cx, cy) = (x0.floor() + 2.0, y0.floor() + 2.0);
        let (w, h) = ((x1 - cx).floor() as usize - 2, (y1 - cy).floor() as usize - 2);
        let mut acc = vec![0.0f64; w * h];
        for (x, y, v) in pos {
            let (fx, fy) = (x - cx - 0.5, y - cy - 0.5);
            let (i, j) = (fx.floor(), fy.floor());
            let (tx, ty) = (fx - i, fy - j);
            for (a, b, wt) in [(i, j, (1.0 - tx) * (1.0 - ty)), (i + 1.0, j, tx * (1.0 - ty)), (i, j + 1.0, (1.0 - tx) * ty), (i + 1.0, j + 1.0, tx * ty)] {
                if a >= 0.0 && b >= 0.0 && (a as usize) < w && (b as usize) < h {
                    acc[b as usize * w + a as usize] += v * wt;
                }
            }
        }
        let mut r = Rng(seed);
        let amp: Vec<f32> = acc.iter().map(|&v| (v * -r.u().ln()).sqrt() as f32).collect();
        let (ml, mw, mh) = multilook(&amp, w, h, 2, 2, true).unwrap();
        Chip::new(cx, cy, 2.0, 2.0, mw, mh, &ml, 0).unwrap()
    }

    /// A GLO-30-like prior: the terrain block-averaged over 30 m, plus `bias`, on a 5 m grid.
    fn prior(&self, half: f64, bias: f64) -> DemGrid {
        let d = 5.0;
        let n = (2.0 * half / d) as usize + 1;
        let g = LatLonGrid { lat0: self.g0.lat + half / self.kn, lon0: self.g0.lon - half / self.ke, dlat: d / self.kn, dlon: d / self.ke, nx: n, ny: n };
        let mut z = vec![0f32; n * n];
        for j in 0..n {
            for i in 0..n {
                let (e, nn) = (-half + i as f64 * d, half - j as f64 * d);
                let (mut s, mut c) = (0.0, 0.0);
                for b in -3..=3 {
                    for a in -3..=3 {
                        s += self.hae(e + a as f64 * 5.0, nn + b as f64 * 5.0);
                        c += 1.0;
                    }
                }
                z[j * n + i] = (s / c + bias) as f32;
            }
        }
        DemGrid { g, z }
    }
}

fn run_synthetic(anchor: bool) -> (Job, Scene) {
    let (a, b) = (model(A), model(B));
    let g0 = scp(&a);
    let scene = Scene::new(g0, 190.0, 7);
    let geom = pair_geometry(&a, &b, g0).unwrap();
    // B sees the scene 6 m off across the parallax direction (a relative orientation error).
    let s = 6.0;
    let shift = [-geom.parallax_dir[1] * s, geom.parallax_dir[0] * s];
    let ca = scene.image(&a, [0.0, 0.0], 11);
    let cb = scene.image(&b, shift, 23);
    let grid = grid_about(g0, 141, 2.0);
    let prior = scene.prior(330.0, 3.0);
    let p = Params { levels: 2, search_m: 25.0, shift_search_m: 12.0, anchor, ..Params::default() };
    let mut job = Job::new(a, b, grid, prior, ca, cb, p).unwrap();
    job.run().unwrap();
    (job, scene)
}

#[test]
fn synthetic_pair_recovers_the_terrain_and_the_cross_shift() {
    let (job, scene) = run_synthetic(false);
    let g = job.grid;
    let (mut e2, mut p2, mut n) = (0.0, 0.0, 0usize);
    let mut errs = Vec::new();
    let mut within = (0usize, 0usize);
    for j in 0..g.ny {
        for i in 0..g.nx {
            let q = j * g.nx + i;
            let (la, lo) = g.at(i as f64, j as f64);
            let (e, nn) = ((lo - scene.g0.lon) * scene.ke, (la - scene.g0.lat) * scene.kn);
            let truth = scene.hae(e, nn);
            let h = job.heights[q];
            if h.is_finite() {
                let d = h as f64 - truth;
                e2 += d * d;
                errs.push(d);
                let pd = job.prior.sample(la, lo) - truth;
                p2 += pd * pd;
                n += 1;
                let s = job.sigma[q] as f64;
                if d.abs() <= s {
                    within.0 += 1;
                }
                if d.abs() <= 2.0 * s {
                    within.1 += 1;
                }
            }
        }
    }
    let share = n as f64 / g.n() as f64;
    let rmse = (e2 / n as f64).sqrt();
    let prior_rmse = (p2 / n as f64).sqrt();
    let med = median(&mut errs);
    let json = job.stats_json();
    eprintln!("synthetic: matched {share:.3}, RMSE {rmse:.2} m (prior {prior_rmse:.2} m), median {med:.2} m, shift {:.2} m, within 1σ {:.2} 2σ {:.2}\n{json}", job.shift_m, within.0 as f64 / n as f64, within.1 as f64 / n as f64);
    assert!(share > 0.6, "matched share {share}");
    assert!(rmse < 2.0, "RMSE {rmse}");
    assert!(med.abs() < 1.0, "median {med}");
    assert!(prior_rmse > rmse + 1.0, "the DSM beats the biased prior: {rmse} vs {prior_rmse}");
    assert!((job.shift_m - 6.0).abs() < 1.5, "cross shift {}", job.shift_m);
    assert!(job.lattice_max_px < 0.05, "lattice {}", job.lattice_max_px);
    assert!(job.intersect_max_m < 0.05, "intersection {}", job.intersect_max_m);
    assert!(json.contains("\"levels\":[") && json.contains("\"sameSide\":true"));
    // Layover against the SICD Volume 3 R/Rdot-to-DEM crossings (the SARkit port in gw-sensor):
    // a post is laid over when its pixel's contour meets the prior DEM more than once. With 45°
    // squint the Umbra collects lay over at fore slopes of about 26° (not the 35° incidence), so
    // the synthetic hills have some.
    let (zmin, zmax) = job.prior.z.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), &v| (a.min(v as f64), b.max(v as f64)));
    let (mut agree, mut total, mut pos_o, mut pos_m) = (0usize, 0usize, 0usize, 0usize);
    for j in (0..g.ny).step_by(4) {
        for i in (0..g.nx).step_by(4) {
            let (la, lo) = g.at(i as f64, j as f64);
            let h = job.prior.sample(la, lo);
            for (k, bit) in [(0usize, flag::LAYOVER_A), (1, flag::LAYOVER_B)] {
                let m = &job.models[k];
                let (x, y) = m.ground_to_image(Ground { lat: la, lon: lo, h }).unwrap();
                let dem = |a: f64, b: f64| job.prior.sample(a, b);
                let n = match m.surface_crossings(x, y, &dem, zmin - 1.0, zmax + 1.0, 1.0) {
                    Some(Ok(v)) => v.len(),
                    _ => 0,
                };
                let oracle = n >= 2;
                let mine = job.flags[j * g.nx + i] & bit != 0;
                total += 1;
                agree += (oracle == mine) as usize;
                pos_o += oracle as usize;
                pos_m += mine as usize;
            }
        }
    }
    eprintln!("layover vs R/Rdot-to-DEM: {agree}/{total} agree; oracle {pos_o}, mask {pos_m}");
    assert!(pos_o > 0, "the scene has layover");
    assert!(agree as f64 >= 0.97 * total as f64, "{agree}/{total}");
}

#[test]
fn anchoring_levels_the_dsm_on_the_prior() {
    let (job, _) = run_synthetic(true);
    let g = job.grid;
    let mut d: Vec<f64> = (0..g.n()).filter(|&q| job.heights[q].is_finite()).map(|q| {
        let (la, lo) = g.at((q % g.nx) as f64, (q / g.nx) as f64);
        job.heights[q] as f64 - job.prior.sample(la, lo)
    }).collect();
    let med = median(&mut d);
    assert!(med.abs() < 0.05, "median DSM − prior after anchoring {med}");
    // The prior is 3 m high, so the anchor moved the heights by about +3 m.
    assert!((job.anchor_offset + 3.0).abs() < 1.0, "anchor offset {}", job.anchor_offset);
    assert_eq!(job.sigma_sys_source, "prior");
}

#[test]
fn bad_inputs_are_refused() {
    let (a, b) = (model(A), model(B));
    let g0 = scp(&a);
    let grid = grid_about(g0, 50, 2.0);
    let prior = DemGrid { g: grid, z: vec![g0.h as f32; 50 * 50] };
    let chip = || Chip::new(0.0, 0.0, 1.0, 1.0, 4, 4, &[1.0; 16], 0).unwrap();
    assert!(Chip::new(0.0, 0.0, 1.0, 1.0, 4, 4, &[1.0; 15], 0).is_err());
    assert!(Chip::new(0.0, 0.0, 0.0, 1.0, 4, 4, &[1.0; 16], 0).is_err());
    let bad = DemGrid { g: grid, z: vec![1.0; 10] };
    assert!(Job::new(model(A), model(B), grid, bad, chip(), chip(), Params::default()).is_err());
    let p = Params { half_window: 0, ..Params::default() };
    assert!(Job::new(model(A), model(B), grid, prior.clone(), chip(), chip(), p).is_err());
    // The same collect twice: no parallax.
    assert!(Job::new(model(A), model(A), grid, prior.clone(), chip(), chip(), Params::default()).is_err());
    // Chips that do not cover the area: the job runs and matches nothing.
    let mut j = Job::new(a, b, grid, prior, chip(), chip(), Params { levels: 1, ..Params::default() }).unwrap();
    j.run().unwrap();
    assert_eq!(j.heights.iter().filter(|v| v.is_finite()).count(), 0);
    assert!(j.flags.iter().all(|&f| f == flag::NO_DATA || f & flag::MASKED != 0));
}

#[test]
fn weak_pairs_step_within_the_search() {
    // A small search at coarse posts: every level steps at most a quarter of the search and searches
    // no wider than it (the Capella Denver 4.6° pair at 44 m posts once stepped 66 m in ±60 m).
    let (a, b) = (model(A), model(B));
    let g0 = scp(&a);
    let grid = grid_about(g0, 120, 2.0);
    let prior = DemGrid { g: grid_about(g0, 200, 2.0), z: vec![g0.h as f32; 200 * 200] };
    let chip = || Chip::new(0.0, 0.0, 1.0, 1.0, 4, 4, &[1.0; 16], 0).unwrap();
    let mut j = Job::new(a, b, grid, prior, chip(), chip(), Params { levels: 3, search_m: 5.0, shift_search_m: 0.0, ..Params::default() }).unwrap();
    j.run().unwrap();
    assert_eq!(j.levels.len(), 4);
    for s in &j.levels {
        assert!(s.step_m <= 5.0 / 4.0 + 1e-9 && s.range_m <= 5.0 + 1e-9, "{s:?}");
    }
}

#[test]
fn scatter_sees_an_error_shared_by_a_whole_window() {
    // Blocks of 12 posts that move together by -5..+5 m: a 5 x 5 box sees nothing inside a block,
    // the box of a coarse window spans several blocks.
    let (nx, ny) = (96, 96);
    let d: Vec<f64> = (0..nx * ny).map(|q| (((q % nx) / 12 * 7 + (q / nx) / 12 * 3) % 11) as f64 - 5.0).collect();
    let small = scatter_sigma(&d, nx, ny, 2, 0.1);
    let wide = scatter_sigma(&d, nx, ny, 36, 0.1);
    let (c, s) = (54 * nx + 54, 6 * nx + 6);
    assert!(small[c] <= 0.1 + 1e-9 && small[s] <= 0.1 + 1e-9, "{} {}", small[c], small[s]);
    assert!(wide[c] > 2.5 && wide[c] < 6.0, "{}", wide[c]);
    assert!(wide[s] > 2.5, "{}", wide[s]);
}

#[test]
fn scatter_keeps_the_floor_nan_and_sparse_cases() {
    // A flat result gives the floor, not zero.
    assert!(scatter_sigma(&[2.0; 400], 20, 20, 8, 0.25).iter().all(|&v| v == 0.25));
    // Unmatched posts stay unmatched, and an isolated pair of posts takes the whole grid's scatter.
    let mut d = vec![f64::NAN; 900];
    for (k, v) in [(0, -4.0), (1, -2.0), (28, 0.0), (29, 2.0), (870, 4.0), (899, 6.0)] {
        d[k] = v;
    }
    let s = scatter_sigma(&d, 30, 30, 2, 0.1);
    let mut all = vec![-4.0, -2.0, 0.0, 2.0, 4.0, 6.0];
    let whole = nmad(&mut all);
    assert!(s[5].is_nan());
    assert!((s[0] - whole).abs() < 1e-12 && (s[899] - whole).abs() < 1e-12, "{} {whole}", s[0]);
    // Nothing matched at all.
    assert!(scatter_sigma(&[f64::NAN; 16], 4, 4, 2, 0.1).iter().all(|v| v.is_nan()));
}
