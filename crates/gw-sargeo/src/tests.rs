use super::*;
use gw_geodesy::wgs84::geodetic_to_ecef;

// A circular orbit in the equatorial plane, radius RS, angular rate W: S(t) = RS(cos Wt, sin Wt, 0).
// For any ground point at longitude φ, (X − S)·V = 0 gives Wt = φ exactly, ellipsoid or not.
const RS: f64 = 7.0e6;
const GM: f64 = 3.986_004_418e14;

fn omega() -> f64 {
    (GM / (RS * RS * RS)).sqrt()
}

fn truth(t: f64) -> (V3, V3) {
    let (s, c) = (omega() * t).sin_cos();
    ([RS * c, RS * s, 0.0], [-RS * omega() * s, RS * omega() * c, 0.0])
}

fn orbit(t0: f64, t1: f64, step: f64) -> Orbit {
    let n = ((t1 - t0) / step).round() as usize + 1;
    let ts: Vec<f64> = (0..n).map(|k| t0 + k as f64 * step).collect();
    let (p, v): (Vec<V3>, Vec<V3>) = ts.iter().map(|&t| truth(t)).unzip();
    Orbit::new(ts, p, v).unwrap()
}

#[test]
fn orbit_rejects_bad_vectors() {
    let (p, v) = (vec![[7e6, 0.0, 0.0]; 4], vec![[0.0, 7e3, 0.0]; 4]);
    assert!(Orbit::new(vec![0.0, 10.0, 20.0], p[..3].to_vec(), v[..3].to_vec()).is_none(), "fewer than 4");
    assert!(Orbit::new(vec![0.0, 10.0, 10.0, 20.0], p.clone(), v.clone()).is_none(), "not increasing");
    assert!(Orbit::new(vec![0.0, 10.0, 20.0, f64::NAN], p.clone(), v.clone()).is_none(), "not finite");
    assert!(Orbit::new(vec![0.0, 10.0, 20.0, 1000.0], p.clone(), v.clone()).is_none(), "a gap over 10 minutes");
    assert!(Orbit::new(vec![0.0, 10.0, 20.0, 30.0], p, v).is_some());
}

#[test]
fn hermite_is_within_a_millimetre_between_10_s_vectors() {
    let o = orbit(-100.0, 100.0, 10.0);
    let (mut ep, mut ev) = (0.0f64, 0.0f64);
    for k in 0..400 {
        let t = -99.0 + k as f64 * 0.4937;
        let (p, v, _) = o.state(t);
        let (tp, tv) = truth(t);
        ep = ep.max(norm(sub(p, tp)));
        ev = ev.max(norm(sub(v, tv)));
    }
    assert!(ep < 1e-3, "position error {ep} m");
    assert!(ev < 1e-3, "velocity error {ev} m/s");
}

#[test]
fn zero_doppler_matches_the_closed_form() {
    let o = orbit(-100.0, 100.0, 10.0);
    for (lat, lon, h) in [(4.0, 0.01, 0.0), (6.5, -0.3, 1500.0), (3.0, 0.4, -50.0)] {
        let x = geodetic_to_ecef(lat, lon, h);
        let (t, r) = zero_doppler(&o, x, 0.0).expect("converges");
        let tt = lon.to_radians() / omega();
        let rr = norm(sub(x, truth(tt).0));
        // 1 µs is 7.5 mm along track. The limit is the interpolated velocity, which the Doppler
        // condition weights by the 800 km range; ESA's own geolocation grid agreed to 2.4 µs (S-72).
        assert!((t - tt).abs() < 1e-6, "time {t} vs {tt}");
        assert!((r - rr).abs() < 1e-3, "range {r} vs {rr}");
    }
    // Outside the orbit's span: no solution.
    assert!(zero_doppler(&o, geodetic_to_ecef(4.0, 20.0, 0.0), 0.0).is_none());
}

#[test]
fn image_lines_follow_blocks_and_ground_range_round_trips() {
    // Two overlapping bursts: the nearest centre wins in the overlap.
    let mk = |az_delay| Image {
        dt: 0.002,
        blocks: vec![Block { t0: 0.0, first_line: 0.0, valid: (10.0, 990.0) }, Block { t0: 1.9, first_line: 1000.0, valid: (1010.0, 1990.0) }],
        range: Range::Slant { r0: 800e3, dr: 2.33 },
        az_spacing: 14.0,
        az_delay,
    };
    let img = mk((0.0, 0.0));
    assert!(img.line(0.0).is_none(), "before the first valid line");
    // The azimuth delay a + s·τ comes off the zero-Doppler time before the line is found: with
    // s = ½ at τ = 4 ms it is 2 ms, one line; a = 4 ms is two.
    assert!((mk((0.0, 0.5)).line_at(1.0, 0.004 * C / 2.0).unwrap() - 499.0).abs() < 1e-6);
    assert!((mk((0.004, 0.0)).line_at(1.0, 9e5).unwrap() - 498.0).abs() < 1e-6);
    assert!((img.line_at(1.0, 9e5).unwrap() - 500.0).abs() < 1e-9);
    assert!((img.line(1.0).unwrap() - 500.0).abs() < 1e-9);
    let l = img.line(1.95).unwrap();
    assert!((l - 975.0).abs() < 1e-9 || (l - 1025.0).abs() < 1e-9);
    assert!((img.pixel(1.0, 800e3 + 23.3) - 10.0).abs() < 1e-9);
    // GRD, as Sentinel-1 annotates it: grsr gives slant = 850 km + 0.6·(g − g0) + 1e-8·(g − g0)²,
    // srgr the ground range from (R − sr0), its inverse to second order.
    let (a, b) = (0.6, 1e-8);
    let rec = |t| GrRec { t, r0: 850e3, g0: 0.0, grsr: vec![850e3, a, b], srgr: vec![0.0, 1.0 / a, -b / (a * a * a)] };
    let grd = Image { dt: 0.002, blocks: vec![Block { t0: 0.0, first_line: 0.0, valid: (0.0, 1e4) }], range: Range::Ground { dg: 10.0, recs: vec![rec(0.0), rec(5.0)] }, az_spacing: 10.0, az_delay: (0.0, 0.0) };
    for px in [0.0, 100.0, 2500.0] {
        let g: f64 = px * 10.0;
        let r = 850e3 + a * g + b * g * g;
        assert!((grd.pixel(2.0, r) - px).abs() < 0.05, "pixel {px}: {}", grd.pixel(2.0, r));
        assert!((grd.slant_spacing(2.0, px) - (a + 2.0 * b * g) * 10.0).abs() < 1e-9);
    }
}

/// A flat patch around latitude 4°, longitude 0, seen from the equatorial orbit (incidence near
/// 38°), DEM posts 5 m, radar pixels 20 m. β⁰ = 1 everywhere.
struct Scene {
    z: Vec<f32>,
    beta: Vec<f32>,
    w: usize,
    h: usize,
    nl: usize,
    ns: usize,
    r0: f64,
    dt: f64,
    az: f64,
    dd: f64,
}

const LAT0: f64 = 4.02;
const LON0: f64 = -0.01;
const DD: f64 = 0.000_045; // ≈ 5 m

fn scene(height: impl Fn(f64, f64) -> f64) -> Scene {
    scene_at(DD, 450, height)
}

/// A patch of n × n posts `dd` degrees apart.
fn scene_at(dd: f64, n: usize, height: impl Fn(f64, f64) -> f64) -> Scene {
    let (w, h) = (n, n);
    let mut z = vec![0.0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            z[j * w + i] = height(LAT0 - j as f64 * dd, LON0 + i as f64 * dd) as f32;
        }
    }
    // Along-track ground spacing of a line at the patch: the zero-Doppler plane turns at W, so a
    // point at distance ρ from the axis moves by W·ρ per second.
    let x = geodetic_to_ecef(LAT0 - (h / 2) as f64 * dd, 0.0, 0.0);
    let rho = x[0].hypot(x[1]);
    let dt = 20.0 / (omega() * rho);
    let o = orbit(-100.0, 100.0, 10.0);
    let r_min = (0..h).step_by(50).flat_map(|j| [0usize, w - 1].map(move |i| (i, j))).filter_map(|(i, j)| zero_doppler(&o, geodetic_to_ecef(LAT0 - j as f64 * dd, LON0 + i as f64 * dd, 0.0), 0.0).map(|r| r.1)).fold(f64::INFINITY, f64::min);
    let (nl, ns) = (4000, 300);
    Scene { z, beta: vec![1.0; nl * ns], w, h, nl, ns, r0: r_min - 2000.0, dt, az: 20.0, dd }
}

fn run(s: &Scene, flatten: bool, masks: bool) -> Job {
    run_with(s, flatten, masks, vec![Block { t0: -5.0, first_line: 0.0, valid: (0.0, s.nl as f64) }])
}

fn run_with(s: &Scene, flatten: bool, masks: bool, blocks: Vec<Block>) -> Job {
    run_side(s, flatten, masks, blocks, -1.0)
}

/// The test orbit runs east along the equator, so the patch north of it is on its left.
fn run_side(s: &Scene, flatten: bool, masks: bool, blocks: Vec<Block>, look: f64) -> Job {
    let win = Window { l0: 0.0, s0: 0.0, kl: 1.0, ks: 1.0, nl: s.nl, ns: s.ns, beta: s.beta.clone() };
    run_window(s, flatten, masks, blocks, look, win)
}

fn run_window(s: &Scene, flatten: bool, masks: bool, blocks: Vec<Block>, look: f64, win: Window) -> Job {
    let img = Image { dt: s.dt, blocks, range: Range::Slant { r0: s.r0, dr: 20.0 }, az_spacing: s.az, az_delay: (0.0, 0.0) };
    let dem = Dem { w: s.w, h: s.h, z: s.z.clone(), lat0: LAT0, lon0: LON0, dlat: s.dd, dlon: s.dd };
    let opts = Opts { flatten, mask_stride: if masks { 4 } else { 0 }, mask_step: 2.5, mask_tol: 0.5, look };
    let mut job = Job::new(orbit(-100.0, 100.0, 10.0), img, dem, win, opts).unwrap();
    let mut last = 0.0;
    loop {
        let p = job.step(37);
        assert!(p >= last, "progress goes forward");
        last = p;
        if p >= 1.0 {
            break;
        }
    }
    job
}

/// Incidence on the ellipsoid at a post (geodetic normal against the look to the sensor).
fn tan_incidence(lat: f64, lon: f64) -> f64 {
    let x = geodetic_to_ecef(lat, lon, 0.0);
    let o = orbit(-100.0, 100.0, 10.0);
    let (t, _) = zero_doppler(&o, x, 0.0).unwrap();
    let look = sub(o.state(t).0, x);
    let (la, lo) = (lat.to_radians(), lon.to_radians());
    let n = [la.cos() * lo.cos(), la.cos() * lo.sin(), la.sin()];
    let c = dot(n, look) / norm(look);
    (1.0 - c * c).sqrt() / c
}

#[test]
fn flat_ground_gives_gamma_of_beta_times_tan_incidence() {
    let s = scene(|_, _| 0.0);
    let j = run(&s, true, false);
    let mut worst = 0.0f64;
    let mut n = 0;
    for jj in (40..s.h - 40).step_by(23) {
        for ii in (40..s.w - 40).step_by(23) {
            let v = j.value[jj * s.w + ii] as f64;
            let want = tan_incidence(LAT0 - jj as f64 * DD, LON0 + ii as f64 * DD);
            worst = worst.max((v / want - 1.0).abs());
            n += 1;
        }
    }
    assert!(n > 200);
    assert!(worst < 0.03, "γ⁰/β⁰ off tan θ by {:.2} %", worst * 100.0);
    // Unflattened: β⁰ as it was.
    let b = run(&s, false, false);
    assert!((b.value[225 * s.w + 225] - 1.0).abs() < 1e-6);
}

#[test]
fn posts_about_one_look_apart_flatten_without_a_ripple() {
    // 28 m posts against 20 m slant (about 32 m ground) pixels and 20 m lines: about one post per
    // pixel, where one splat per triangle left γ⁰ 0.89 to 1.21 of β⁰·tan θ from post to post.
    let dd = 0.000_252;
    let s = scene_at(dd, 80, |_, _| 0.0);
    let j = run(&s, true, false);
    let (mut lo, mut hi, mut n) = (f64::INFINITY, 0.0f64, 0);
    for jj in 10..s.h - 10 {
        for ii in 10..s.w - 10 {
            let v = j.value[jj * s.w + ii] as f64;
            if !v.is_finite() {
                continue;
            }
            let r = v / tan_incidence(LAT0 - jj as f64 * dd, LON0 + ii as f64 * dd);
            (lo, hi, n) = (lo.min(r), hi.max(r), n + 1);
        }
    }
    assert!(n > 3000, "{n} posts flattened");
    assert!(lo > 0.97 && hi < 1.03, "γ⁰/(β⁰·tan θ) from {lo:.3} to {hi:.3}");
}

#[test]
fn a_slope_facing_the_sensor_is_darkened_and_one_facing_away_brightened() {
    // The sensor is to the south (over the equator). Ground that rises to the north faces it: more
    // of it falls in each radar pixel, so A_γ grows and, for the same β⁰, γ⁰ falls.
    let tilt = 0.15; // rise per metre of ground (≈ 8.5°)
    let toward = scene(|lat, _| (lat - (LAT0 - 450.0 * DD)) * 111_000.0 * tilt);
    let away = scene(|lat, _| (LAT0 - lat) * 111_000.0 * tilt);
    let flat = scene(|_, _| 0.0);
    let (a, b, f) = (run(&toward, true, false), run(&away, true, false), run(&flat, true, false));
    let k = 225 * flat.w + 225;
    assert!(a.value[k] < f.value[k] * 0.9, "toward {} vs flat {}", a.value[k], f.value[k]);
    assert!(b.value[k] > f.value[k] * 1.1, "away {} vs flat {}", b.value[k], f.value[k]);
    // And by how much: the tilt is in the range plane (north-south, across this orbit), so the
    // look meets the plane at the ellipsoid incidence θ less (facing) or plus (away) the slope α,
    // and γ⁰/β⁰ is tan(θ ∓ α), as tan θ is on flat ground.
    let alpha = tilt.atan();
    let mut worst = 0.0f64;
    for jj in (100..=350).step_by(50) {
        for ii in (100..=350).step_by(50) {
            let th = tan_incidence(LAT0 - jj as f64 * DD, LON0 + ii as f64 * DD).atan();
            let k = jj * flat.w + ii;
            for (v, want) in [(a.value[k], (th - alpha).tan()), (b.value[k], (th + alpha).tan())] {
                worst = worst.max((v as f64 / want - 1.0).abs());
            }
        }
    }
    assert!(worst < 0.03, "γ⁰/β⁰ off tan(θ ∓ α) by {:.2} %", worst * 100.0);
}

#[test]
fn a_steep_ridge_has_layover_on_its_fore_slope_and_shadow_behind() {
    // An east-west ridge 600 m high and 600 m wide across the patch's middle: the side facing the
    // sensor (south) is steeper than the incidence, the far side drops away beyond the look.
    let mid = LAT0 - 225.0 * DD;
    let s = scene(|lat, _| {
        let d = (lat - mid) * 111_000.0; // metres north of the crest
        (600.0 - 2.0 * d.abs()).max(0.0)
    });
    let j = run(&s, true, true);
    assert!(j.counts[1] > 0, "layover posts: {}", j.counts[1]);
    assert!(j.counts[2] > 0, "shadow posts: {}", j.counts[2]);
    // The far south and north edges are flat and clear.
    assert_eq!(j.mask[5 * s.w + 225] & sarmask::LAYOVER, 0);
    // Rows run south from the crest (row 225); each face is 60 rows of 5 m. Layover on the face
    // toward the sensor (south) and no shadow there; shadow on the face away (north). The fore slope
    // spans 300·sin θ − 600·cos θ ≈ −290 m of range (its top is nearest), and the back slope moves
    // away at sin θ + 2·cos θ ≈ 2.2 m of range per metre, so its first ≈ 130 m share range with
    // the fore slope and are laid over too, and the rest is not.
    let share = |rows: std::ops::Range<usize>, bit: u8| {
        let n = rows.len() * 200;
        rows.flat_map(|jj| (125..325).map(move |ii| (jj, ii))).filter(|&(jj, ii)| j.mask[jj * s.w + ii] & bit != 0).count() as f64 / n as f64
    };
    let (fore, back) = (235..280, 170..215);
    assert!(share(fore.clone(), sarmask::LAYOVER) > 0.9, "layover on the fore slope: {:.2}", share(fore.clone(), sarmask::LAYOVER));
    assert!(share(back.clone(), sarmask::SHADOW) > 0.9, "shadow on the back slope: {:.2}", share(back.clone(), sarmask::SHADOW));
    assert!(share(fore.clone(), sarmask::SHADOW) < 0.05, "shadow on the fore slope: {:.2}", share(fore, sarmask::SHADOW));
    let (near, far) = (205..215, 170..190); // 50 to 100 m and 175 to 275 m north of the crest
    assert!(share(near.clone(), sarmask::LAYOVER) > 0.9, "layover just behind the crest: {:.2}", share(near, sarmask::LAYOVER));
    assert!(share(far.clone(), sarmask::LAYOVER) < 0.05, "layover far down the back slope: {:.2}", share(far, sarmask::LAYOVER));
}

#[test]
fn malformed_inputs_are_refused() {
    let s = scene(|_, _| 0.0);
    let img = || Image { dt: s.dt, blocks: vec![Block { t0: -5.0, first_line: 0.0, valid: (0.0, 10.0) }], range: Range::Slant { r0: s.r0, dr: 20.0 }, az_spacing: 20.0, az_delay: (0.0, 0.0) };
    let dem = |w| Dem { w, h: s.h, z: s.z.clone(), lat0: LAT0, lon0: LON0, dlat: DD, dlon: DD };
    let win = |nl| Window { l0: 0.0, s0: 0.0, kl: 1.0, ks: 1.0, nl, ns: s.ns, beta: s.beta.clone() };
    let opts = || Opts { flatten: true, mask_stride: 0, mask_step: 1.0, mask_tol: 0.5, look: -1.0 };
    let o = || orbit(-100.0, 100.0, 10.0);
    assert!(Job::new(o(), img(), dem(s.w + 1), win(s.nl), opts()).is_err(), "DEM size");
    assert!(Job::new(o(), img(), dem(s.w), win(s.nl + 1), opts()).is_err(), "window size");
    let bad = Image { range: Range::Ground { dg: 10.0, recs: Vec::new() }, ..img() };
    assert!(Job::new(o(), bad, dem(s.w), win(s.nl), opts()).is_err(), "GRD with no records");
    assert!(Job::new(o(), img(), dem(s.w), win(s.nl), opts()).is_ok());
}

#[test]
fn a_burst_switch_inside_the_patch_flattens_like_one_block() {
    // Two TOPS-like bursts of the same length that overlap by 120 lines in time, the second stored
    // 160 image lines further on than one block would put it. The nearest-centre switch falls in
    // the middle of the overlap, across the patch. Area must land where each triangle's own
    // centre images, not at the mean of corners imaged in different bursts.
    let s = scene(|_, _| 0.0);
    let t1 = -5.0 + 1640.0 * s.dt;
    let blocks = vec![Block { t0: -5.0, first_line: 0.0, valid: (0.0, 1760.0) }, Block { t0: t1, first_line: 1800.0, valid: (1800.0, 3560.0) }];
    let j = run_with(&s, true, false, blocks);
    let (mut worst, mut n, mut second) = (0.0f64, 0, 0);
    for jj in (20..s.h - 20).step_by(7) {
        for ii in (20..s.w - 20).step_by(7) {
            let v = j.value[jj * s.w + ii] as f64;
            if !v.is_finite() {
                continue;
            }
            let want = tan_incidence(LAT0 - jj as f64 * DD, LON0 + ii as f64 * DD);
            worst = worst.max((v / want - 1.0).abs());
            n += 1;
            if j.image_coords()[2 * (jj * s.w + ii)] >= 1800.0 {
                second += 1;
            }
        }
    }
    assert!(second > 100 && n - second > 100, "both blocks used: {second} of {n}");
    assert!(worst < 0.03, "γ⁰/β⁰ off tan θ by {:.2} % across the switch", worst * 100.0);
}

#[test]
fn posts_whose_look_is_partly_off_the_dem_get_no_gamma() {
    let s = scene(|_, _| 0.0);
    let j = run(&s, true, false);
    // The rim, a look's footprint wide, has no value; the posts just inside it are right.
    assert!(!j.value[0].is_finite() && !j.value[225].is_finite() && !j.value[225 * s.w].is_finite());
    let rim = (0..s.w).take_while(|&i| !j.value[225 * s.w + i].is_finite()).count();
    assert!((1..15).contains(&rim), "rim {rim} posts");
    let k = 225 * s.w + rim;
    let want = tan_incidence(LAT0 - 225.0 * DD, LON0 + rim as f64 * DD);
    assert!((j.value[k] as f64 / want - 1.0).abs() < 0.03, "first post inside the rim: {} vs {want}", j.value[k]);
    // A void inside the DEM takes its neighbourhood with it.
    let mut z = s.z.clone();
    z[225 * s.w + 225] = f32::NAN;
    let holed = Scene { z, ..scene(|_, _| 0.0) };
    let jh = run(&holed, true, false);
    assert!(!jh.value[225 * s.w + 226].is_finite());
    assert!(jh.value[225 * s.w + 225 + 3 * rim].is_finite());
    // β⁰ alone has no rim.
    assert!(run(&s, false, false).value[0].is_finite());
}

#[test]
fn on_a_slope_facing_the_sensor_the_rim_widens_and_the_posts_inside_it_are_right() {
    // Ground rising to the north at 0.3 faces the sensor (south): a range pixel spans more ground,
    // so the margin must follow it. Along the range direction (a column), the first post with a
    // value must read as the slope's interior does.
    let s = scene(|lat, _| (lat - (LAT0 - 450.0 * DD)) * 111_000.0 * 0.3);
    let j = run(&s, true, false);
    let col = |jj: usize| j.value[jj * s.w + 225] as f64;
    let mid = col(225);
    assert!(mid.is_finite());
    let first = (0..s.h).find(|&jj| col(jj).is_finite()).unwrap();
    let last = (0..s.h).rev().find(|&jj| col(jj).is_finite()).unwrap();
    for jj in [first, first + 1, last - 1, last] {
        assert!((col(jj) / mid - 1.0).abs() < 0.03, "post {jj}: {} against {mid} inside", col(jj));
    }
}

#[test]
fn posts_on_the_side_the_radar_does_not_look_get_no_value() {
    // Every post north of the track has a mirror south of it with the same zero-Doppler time and
    // range. Told the radar looks right (south), the run leaves the whole northern patch out.
    let s = scene(|_, _| 0.0);
    let blocks = || vec![Block { t0: -5.0, first_line: 0.0, valid: (0.0, s.nl as f64) }];
    let left = run_side(&s, true, true, blocks(), -1.0);
    let right = run_side(&s, true, true, blocks(), 1.0);
    let valued = |j: &Job| j.value.iter().filter(|v| v.is_finite()).count();
    assert!(valued(&left) > s.w * s.h / 2, "seen side: {} of {}", valued(&left), s.w * s.h);
    assert_eq!(valued(&right), 0);
    assert!(right.mask.iter().all(|&m| m == 0), "no layover or shadow on posts never seen");
    // As written, they are marked as having no image position, not as clear.
    assert!(right.mask_out().iter().all(|&m| m == NO_GEOMETRY));
    assert!(left.mask_out().iter().filter(|&&m| m != NO_GEOMETRY).count() >= valued(&left));
    // Either side (0) is the old behaviour: the patch is valued.
    assert_eq!(valued(&run_side(&s, true, false, blocks(), 0.0)), valued(&run_side(&s, true, false, blocks(), -1.0)));
}

#[test]
fn an_offset_multi_look_window_samples_the_same_image_position() {
    // A β⁰ ramp over the full-resolution image: the mean of a look is the ramp at the look's
    // centre, and bilinear sampling of a ramp is exact, so every post must read the ramp at its
    // own image position whatever the window's offset and looks.
    let ramp = |l: f64, p: f64| 1.0 + 0.001 * l + 0.01 * p;
    let mut s = scene_at(DD * 4.0, 120, |_, _| 0.0);
    let blocks = || vec![Block { t0: -5.0, first_line: 0.0, valid: (0.0, s.nl as f64) }];
    let base = run_side(&s, false, false, blocks(), -1.0);
    let at = base.image_coords();
    let (mut l_lo, mut l_hi, mut p_lo, mut p_hi) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for c in at.chunks(2).filter(|c| c[0].is_finite()) {
        (l_lo, l_hi, p_lo, p_hi) = (l_lo.min(c[0] as f64), l_hi.max(c[0] as f64), p_lo.min(c[1] as f64), p_hi.max(c[1] as f64));
    }
    assert!(l_hi - l_lo > 50.0 && p_hi - p_lo > 20.0, "the patch spans the image");
    let (kl, ks) = (3usize, 5usize);
    let (l0, s0) = ((l_lo - 7.0).floor(), (p_lo - 11.0).floor());
    let nl = ((l_hi + 10.0 - l0) / kl as f64).ceil() as usize;
    let ns = ((p_hi + 15.0 - s0) / ks as f64).ceil() as usize;
    let mut beta = vec![0.0f32; nl * ns];
    for r in 0..nl {
        for c in 0..ns {
            let mut sum = 0.0;
            for y in 0..kl {
                for x in 0..ks {
                    sum += ramp(l0 + (r * kl + y) as f64, s0 + (c * ks + x) as f64);
                }
            }
            beta[r * ns + c] = (sum / (kl * ks) as f64) as f32;
        }
    }
    s.beta = beta.clone();
    let win = Window { l0, s0, kl: kl as f64, ks: ks as f64, nl, ns, beta };
    let j = run_window(&s, false, false, blocks(), -1.0, win);
    let mut n = 0;
    let mut worst = 0.0f64;
    for (i, c) in at.chunks(2).enumerate() {
        if !c[0].is_finite() {
            continue;
        }
        let want = ramp(c[0] as f64, c[1] as f64);
        worst = worst.max((j.value[i] as f64 - want).abs() / want);
        n += 1;
    }
    assert!(n > 10_000, "{n} posts checked");
    assert!(worst < 1e-5, "β⁰ off its image position by {:.2e} (relative)", worst);
}
