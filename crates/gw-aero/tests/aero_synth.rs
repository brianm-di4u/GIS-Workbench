//! REQ-GAP-22: the aerial triangulation on synthetic blocks with known truth, one test per kind
//! of unknown (exterior orientation, Brown self-calibration, fisheye self-calibration, space
//! resection, GNSS lever arm and IMU boresight, film interior orientation from fiducials), robust
//! weighting with blunders, and the degenerate geometries, which must be refused or flagged.
//!
//! The truth is a flight over rolling ground; measurements are the true projections plus
//! deterministic Gaussian noise. Recovered parameters are compared with the truth in units of
//! their own posterior σ (|Δ| < 4σ) and in absolute terms.

use gw_aero::aero::*;
use gw_adjust::block::{ObsIn, PointIn, PointKind};
use gw_aero::fiducial::{fiducial_io, FidModel};
use gw_aero::geom::*;
use gw_aero::resect::resect;
use gw_geodesy::wgs84::{enu_rotation, enu_to_geodetic};
use gw_sensor::Ground;

const LAT0: f64 = 41.03;
const LON0: f64 = -83.3;
const H0: f64 = 250.0;

/// Deterministic N(0, 1) (Box–Muller over an LCG).
struct Rng(u64);
impl Rng {
    fn uniform(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.uniform(), self.uniform());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

fn geo(e: f64, n: f64, u: f64) -> Ground {
    let (lat, lon, h) = enu_to_geodetic(e, n, u, LAT0, LON0, H0);
    Ground { lat, lon, h }
}
/// ENU at the scene origin → ENU at g: the rotation between the two tangent frames.
fn enu0_to_enu(g: Ground) -> M3 {
    let e0 = enu_rotation(LAT0, LON0);
    mul(&enu_rotation(g.lat, g.lon), &tr(&e0))
}

#[derive(Clone)]
struct Truth {
    cam: CameraIn,
    /// Per image: centre (ENU at the scene origin) and ENU0 → camera rotation.
    eo: Vec<(V3, M3)>,
    film: Vec<Option<[f64; 6]>>,
    pts: Vec<V3>,
}

fn digital(io: [f64; NIO]) -> CameraIn {
    CameraIn { projection: Projection::Brown, film: false, pixel_mm: 0.004, width: 6000.0, height: 4000.0, io, io_free: [false; NIO], io_sigma: [0.0; NIO], mount: [0.0; 6], mount_free: [false; 6], mount_sigma: [0.0; 6] }
}

fn terrain(e: f64, n: f64, relief: f64) -> f64 {
    relief * ((e / 90.0).sin() * (n / 70.0).cos() + 0.4 * (e / 37.0 + n / 53.0).sin())
}

/// A block of `strips` × `per` images at height `hgt` above the ground, alternating headings,
/// forward base `base` and strip spacing `space`; ground points on a grid with `relief`.
fn block(cam: CameraIn, strips: usize, per: usize, hgt: f64, base: f64, space: f64, relief: f64, tilt_deg: f64, rng: &mut Rng) -> Truth {
    let mut eo = Vec::new();
    for s in 0..strips {
        for k in 0..per {
            let e = (k as f64 - (per as f64 - 1.0) / 2.0) * base;
            let n = (s as f64 - (strips as f64 - 1.0) / 2.0) * space;
            let heading = if s % 2 == 0 { 90.0 } else { -90.0 };
            let (om, ph) = (tilt_deg * rng.normal(), tilt_deg * rng.normal());
            // ENU0 → camera ≈ the frame rotation at the camera (tangent frames differ by ~1e-5 rad here).
            let g = geo(e, n, hgt);
            let r_enu = gw_sensor::frame::rotation(om, ph, heading + 3.0 * rng.normal());
            eo.push(([e, n, hgt + 2.0 * rng.normal()], mul(&r_enu, &enu0_to_enu(g))));
        }
    }
    let ext_e = (per as f64) * base * 0.5 + 40.0;
    let ext_n = (strips as f64) * space * 0.5 + 30.0;
    let mut pts = Vec::new();
    let step = 0.06 * hgt;
    let mut e = -ext_e;
    while e <= ext_e {
        let mut n = -ext_n;
        while n <= ext_n {
            pts.push([e + 3.0 * rng.normal(), n + 3.0 * rng.normal(), terrain(e, n, relief)]);
            n += step;
        }
        e += step;
    }
    Truth { film: vec![None; eo.len()], cam, eo, pts }
}

struct Built {
    cams: Vec<CameraIn>,
    images: Vec<ImageIn>,
    points: Vec<PointIn>,
    obs: Vec<ObsIn>,
}

#[derive(Clone, Copy)]
struct Spec {
    sigma_px: f64,
    gcp_every: usize,
    check_every: usize,
    /// Perturbation of the approximate EO (m, °).
    perturb: (f64, f64),
    gnss: Option<f64>,
    imu: Option<f64>,
    attitude_known: bool,
    lever: V3,
    boresight: V3,
    min_rays: usize,
}

impl Default for Spec {
    fn default() -> Self {
        Spec { sigma_px: 0.3, gcp_every: 37, check_every: 23, perturb: (3.0, 1.0), gnss: None, imu: None, attitude_known: true, lever: [0.0; 3], boresight: [0.0; 3], min_rays: 2 }
    }
}

/// Measure the truth: projections with noise; GCPs and checkpoints every so many points.
fn build(t: &Truth, given: CameraIn, sp: Spec, rng: &mut Rng) -> Built {
    let mut obs = Vec::new();
    let mut points = Vec::new();
    for (j, x) in t.pts.iter().enumerate() {
        let mut mine = Vec::new();
        for (i, (c, r)) in t.eo.iter().enumerate() {
            let v = mv(r, sub(*x, *c));
            if let Some((px, py)) = project(&t.cam, &t.cam.io, t.film[i].as_ref(), v) {
                let (w, h) = match t.film[i] {
                    Some(_) => (11000.0, 11000.0),
                    None => (t.cam.width, t.cam.height),
                };
                if px > 5.0 && py > 5.0 && px < w - 5.0 && py < h - 5.0 {
                    mine.push(ObsIn { image: i, point: j, x: px + sp.sigma_px * rng.normal(), y: py + sp.sigma_px * rng.normal(), sigma_px: sp.sigma_px });
                }
            }
        }
        let kind = if sp.gcp_every > 0 && j % sp.gcp_every == 0 { PointKind::Gcp } else if sp.check_every > 0 && j % sp.check_every == 0 { PointKind::Check } else { PointKind::Tie };
        if mine.len() < sp.min_rays && kind != PointKind::Gcp {
            mine.clear();
        }
        let k = points.len();
        for o in &mut mine {
            o.point = k;
        }
        obs.extend(mine);
        points.push(PointIn { kind, known: (kind != PointKind::Tie).then(|| geo(x[0], x[1], x[2])), sigma_h: 0.01, sigma_v: 0.01 });
    }
    let mut images = Vec::new();
    for (i, (c, r)) in t.eo.iter().enumerate() {
        // GNSS antenna and IMU attitude from the truth (+ mount), perturbed.
        let mut pos = add(*c, mtv(r, sp.lever));
        let mut rot = mul(&tr(&expm(sp.boresight)), r);
        match sp.gnss {
            Some(s) => pos = add(pos, [s * rng.normal(), s * rng.normal(), s * rng.normal()]),
            None => pos = add(pos, [sp.perturb.0 * rng.normal(), sp.perturb.0 * rng.normal(), sp.perturb.0 * rng.normal()]),
        }
        let w = match sp.imu {
            Some(s) => [s * rng.normal(), s * rng.normal(), s * rng.normal()],
            None => [0, 1, 2].map(|_| sp.perturb.1.to_radians() * rng.normal()),
        };
        rot = mul(&expm(w), &rot);
        let g = geo(pos[0], pos[1], pos[2]);
        // ENU0 → camera into ENU-at-g → camera.
        let r_enu = mul(&rot, &tr(&enu0_to_enu(g)));
        images.push(ImageIn { camera: 0, fixed: false, approx: Some((g, r_enu)), attitude_known: sp.attitude_known, gnss: sp.gnss.map(|s| [s, s, s]), imu: sp.imu.map(|s| [s; 3]), film: t.film[i] });
    }
    Built { cams: vec![given], images, points, obs }
}

fn solve(b: Built, opts: AeroOptions) -> gw_abi::Result<(Aero, Report)> {
    let mut a = Aero::new(b.cams, b.images, b.points, b.obs, opts)?;
    a.run()?;
    let r = a.report()?;
    Ok((a, r))
}

/// The solved EO in the scene-origin ENU frame (the solver's local frame differs by a rotation).
fn eo_enu0(a: &Aero, r: &Report, i: usize) -> (V3, M3) {
    let im = &r.images[i];
    let c = gw_geodesy::wgs84::geodetic_to_enu(im.centre.lat, im.centre.lon, im.centre.h, LAT0, LON0, H0);
    let _ = a;
    // ECEF → camera times ENU0ᵀ… R_enu0 = R_ecef · E0ᵀ.
    let e0 = enu_rotation(LAT0, LON0);
    (c, mul(&im.r_ecef, &tr(&e0)))
}

/// Worst centre error (m), worst attitude error (°) and the worst centre error per axis in σ.
fn eo_errors(a: &Aero, r: &Report, t: &Truth) -> ((f64, f64), f64) {
    let mut worst = (0.0_f64, 0.0_f64);
    let mut zmax: f64 = 0.0;
    for i in 0..t.eo.len() {
        let (c, rr) = eo_enu0(a, r, i);
        let d = sub(c, t.eo[i].0);
        worst.0 = worst.0.max(norm(d));
        worst.1 = worst.1.max(rot_err_deg(&rr, &t.eo[i].1));
        for k in 0..3 {
            zmax = zmax.max(d[k].abs() / r.images[i].sigma[k]);
        }
    }
    (worst, zmax)
}

/// Checkpoint errors in units of their posterior σ, per axis: (RMS, max).
fn check_z(r: &Report) -> (f64, f64) {
    let mut zs = Vec::new();
    for c in &r.checks {
        let (Some(d), Some(Some((_, cov)))) = (c.d3, r.points.get(c.point)) else { continue };
        for k in 0..3 {
            zs.push(d[k].abs() / cov[k][k].sqrt());
        }
    }
    let rms = (zs.iter().map(|z| z * z).sum::<f64>() / zs.len().max(1) as f64).sqrt();
    (rms, zs.iter().cloned().fold(0.0, f64::max))
}

fn rot_err_deg(a: &M3, b: &M3) -> f64 {
    norm(logm(&mul(a, &tr(b)))).to_degrees()
}

fn base_io() -> [f64; NIO] {
    // 24 mm lens on a 24 × 16 mm, 4 µm sensor, Brown distortion of tens of pixels at the corner.
    [24.0, 0.012, -0.008, 6.5e-5, -1.2e-7, 2.0e-10, 0.0, 1.5e-5, -1.0e-5, 1.0e-4, -5.0e-5]
}

#[test]
fn exterior_orientation_with_gcps() {
    let mut rng = Rng(1);
    let t = block(digital(base_io()), 3, 8, 150.0, 20.0, 55.0, 25.0, 2.0, &mut rng);
    let b = build(&t, digital(base_io()), Spec::default(), &mut rng);
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged, "{:?}", r.notes);
    assert!((r.sigma0 - 1.0).abs() < 0.1, "σ₀ {}", r.sigma0);
    let (worst, zmax) = eo_errors(&a, &r, &t);
    // GSD 2.5 cm: centres to a few cm, attitude to about 0.01°; within 4σ of the posterior.
    assert!(worst.0 < 0.06 && worst.1 < 0.025 && zmax < 4.0, "worst centre {} m, attitude {}°, {zmax}σ", worst.0, worst.1);
    assert!(r.checks_multi.n >= 5 && r.checks_multi.rmse_r < 0.03 && r.checks_multi.rmse[2] < 0.08, "{:?}", r.checks_multi);
    let z = check_z(&r);
    assert!(z.0 < 1.5 && z.1 < 5.0, "checkpoint errors in σ: RMS {} max {}", z.0, z.1);
    eprintln!("EO: {} images, σ₀ {:.3}, worst centre {:.4} m, attitude {:.5}°, checks RMSE E {:.4} N {:.4} U {:.4} m (n {}), {:.2}σ RMS", t.eo.len(), r.sigma0, worst.0, worst.1, r.checks_multi.rmse[0], r.checks_multi.rmse[1], r.checks_multi.rmse[2], r.checks_multi.n, z.0);
}

#[test]
fn brown_self_calibration() {
    let mut rng = Rng(2);
    let truth = base_io();
    let t = block(digital(truth), 4, 10, 150.0, 18.0, 50.0, 30.0, 3.0, &mut rng);
    // Start from the nominal lens: f 0.5 % off, centred principal point, no distortion.
    let mut nominal = [0.0; NIO];
    nominal[0] = 24.12;
    let mut given = digital(nominal);
    for q in [0, 1, 2, 3, 4, 5, 7, 8, 9, 10] {
        given.io_free[q] = true;
    }
    let b = build(&t, given, Spec { gnss: Some(0.03), ..Spec::default() }, &mut rng);
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged && (r.sigma0 - 1.0).abs() < 0.1, "σ₀ {} {:?}", r.sigma0, r.notes);
    let got = a.io(0);
    let cam = &r.cameras[0];
    for q in [0, 1, 2, 3, 4, 5, 7, 8, 9, 10] {
        let z = (got[q] - truth[q]) / cam.sigma[q];
        eprintln!("  {:>3}: truth {:+.6e} solved {:+.6e} σ {:.2e} ({:+.2}σ)", IO_NAMES[q], truth[q], got[q], cam.sigma[q], z);
        assert!(z.abs() < 4.0, "{} off by {z:.1}σ", IO_NAMES[q]);
    }
    // The distortion field (the displacement by k, p, b) matches the truth's to < 0.15 px over
    // the format; f and the principal point trade against the exterior orientation and are
    // compared through their sigma above.
    let field = |io: &[f64; NIO], x: f64, y: f64| {
        let mut plain = *io;
        for q in 3..NIO {
            plain[q] = 0.0;
        }
        let v = [x, y, -io[0]];
        let p = project(&t.cam, io, None, v).unwrap();
        let q = project(&t.cam, &plain, None, v).unwrap();
        (p.0 - q.0, p.1 - q.1)
    };
    let mut worst: f64 = 0.0;
    for (x, y) in [(12.0, 8.0), (-12.0, 8.0), (6.0, -4.0), (0.0, 7.9), (11.9, 0.0), (-9.0, -7.5)] {
        let (a1, b1) = field(&truth, x, y);
        let (a2, b2) = field(&got, x, y);
        worst = worst.max((a1 - a2).hypot(b1 - b2));
    }
    assert!(worst < 0.15, "distortion field differs by {worst} px");
    let z = check_z(&r);
    assert!(z.0 < 1.5 && z.1 < 5.0 && r.checks_multi.rmse_r < 0.03, "checkpoints: {z:?} {:?}", r.checks_multi);
    // The correlation matrix of the free IO is reported and symmetric with a unit diagonal.
    let k = cam.free.len();
    for i in 0..k {
        assert!((cam.corr[i * k + i] - 1.0).abs() < 1e-9);
        for j in 0..k {
            assert!((cam.corr[i * k + j] - cam.corr[j * k + i]).abs() < 1e-9);
        }
    }
    eprintln!("Brown self-calibration: σ₀ {:.3}, distortion field within {:.4} px, checks {:.4} m", r.sigma0, worst, r.checks_multi.rmse_3d);
}

#[test]
fn fisheye_self_calibration() {
    let mut rng = Rng(3);
    let mut truth = [0.0; NIO];
    truth[0] = 4.0;
    truth[1] = 0.01;
    truth[2] = -0.006;
    truth[3] = 0.05;
    truth[4] = -0.01;
    truth[5] = 0.004;
    truth[6] = -0.001;
    let cam = CameraIn { projection: Projection::Fisheye, pixel_mm: 0.003, width: 4000.0, height: 3000.0, ..digital(truth) };
    let t = block(cam.clone(), 3, 8, 60.0, 15.0, 40.0, 20.0, 3.0, &mut rng);
    let mut nominal = [0.0; NIO];
    nominal[0] = 4.05;
    let mut given = CameraIn { io: nominal, ..cam.clone() };
    for q in 0..7 {
        given.io_free[q] = true;
    }
    let b = build(&t, given, Spec { gnss: Some(0.03), ..Spec::default() }, &mut rng);
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged && (r.sigma0 - 1.0).abs() < 0.12, "σ₀ {} {:?}", r.sigma0, r.notes);
    let got = a.io(0);
    for q in 0..7 {
        let z = (got[q] - truth[q]) / r.cameras[0].sigma[q];
        eprintln!("  fisheye {:>3}: truth {:+.6e} solved {:+.6e} ({:+.2}σ)", IO_NAMES[q], truth[q], got[q], z);
        assert!(z.abs() < 4.0, "{} off by {z:.1}σ", IO_NAMES[q]);
    }
    // Within the measured field (to ~60° off axis) the recovered model agrees to < 0.2 px.
    for th in [10.0f64, 30.0, 55.0] {
        let v = [th.to_radians().sin(), 0.0, -th.to_radians().cos()];
        let p = project(&cam, &truth, None, v).unwrap();
        let q = project(&cam, &got, None, v).unwrap();
        assert!((p.0 - q.0).hypot(p.1 - q.1) < 0.2, "θ {th}: {p:?} {q:?}");
    }
}

#[test]
fn space_resection_from_scratch() {
    let mut rng = Rng(4);
    let cam = digital(base_io());
    for (relief, want) in [(40.0, "DLT"), (0.0, "homography")] {
        let t = block(cam.clone(), 1, 1, 150.0, 20.0, 50.0, relief, 4.0, &mut rng);
        let (c, r) = t.eo[0];
        let mut pts = Vec::new();
        let mut px = Vec::new();
        for x in &t.pts {
            if let Some(p) = project(&cam, &cam.io, None, mv(&r, sub(*x, c))) {
                if p.0 > 0.0 && p.1 > 0.0 && p.0 < 6000.0 && p.1 < 4000.0 {
                    pts.push(*x);
                    px.push((p.0 + 0.3 * rng.normal(), p.1 + 0.3 * rng.normal()));
                }
            }
        }
        pts.truncate(30);
        px.truncate(30);
        let sig = vec![0.3; pts.len()];
        let o = resect(&cam, &cam.io, None, &pts, &px, &sig, None, false).unwrap();
        assert_eq!(o.method, want);
        let d = sub(o.c, c);
        let z = (0..3).map(|k| d[k].abs() / o.cov[k][k].sqrt()).fold(0.0, f64::max);
        assert!(norm(d) < 0.25 && rot_err_deg(&o.r, &r) < 0.05 && z < 4.0, "{want}: {} m {}° ({z}σ)", norm(d), rot_err_deg(&o.r, &r));
        assert!((o.sigma0 - 1.0).abs() < 0.4, "σ₀ {}", o.sigma0);
        // A gross error in one point: Huber weighting keeps the solution.
        let mut bad = px.clone();
        bad[3].0 += 40.0;
        let ob = resect(&cam, &cam.io, None, &pts, &bad, &sig, None, true).unwrap();
        assert!(norm(sub(ob.c, o.c)) < 0.1 && ob.weights[3] < 0.1, "robust: {} m from the clean solution, w {}", norm(sub(ob.c, o.c)), ob.weights[3]);
        eprintln!("resection ({want}): {} points, centre {:.4} m, attitude {:.5}°, max correlation {:.3}", pts.len(), norm(sub(o.c, c)), rot_err_deg(&o.r, &r), o.max_corr);
    }
}

#[test]
fn resection_refuses_degenerate_points() {
    let cam = digital(base_io());
    let r = gw_sensor::frame::rotation(0.0, 0.0, 0.0);
    let c = [0.0, 0.0, 150.0];
    let line: Vec<V3> = (0..8).map(|k| [k as f64 * 10.0 - 35.0, k as f64 * 5.0 - 17.0, 0.0]).collect();
    let px: Vec<(f64, f64)> = line.iter().map(|x| project(&cam, &cam.io, None, mv(&r, sub(*x, c))).unwrap()).collect();
    let sig = vec![0.5; 8];
    let e = resect(&cam, &cam.io, None, &line, &px, &sig, None, false).unwrap_err();
    assert!(e.to_string().contains("collinear"), "{e}");
    let e = resect(&cam, &cam.io, None, &line[..3], &px[..3], &sig[..3], None, false).unwrap_err();
    assert!(e.to_string().contains("at least 4"), "{e}");
}

#[test]
fn lever_arm_and_boresight() {
    let mut rng = Rng(5);
    let t = block(digital(base_io()), 4, 9, 150.0, 20.0, 50.0, 25.0, 2.0, &mut rng);
    let lever = [0.12, -0.08, 0.35];
    let bore = [0.004, -0.003, 0.006]; // rad (0.23°, 0.17°, 0.34°)
    let mut given = digital(base_io());
    given.mount_free = [true; 6];
    // Few GCPs: the datum is mostly GNSS.
    let sp = Spec { gcp_every: 150, gnss: Some(0.02), imu: Some(0.005f64.to_radians()), lever, boresight: bore, ..Spec::default() };
    let b = build(&t, given, sp, &mut rng);
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged && (r.sigma0 - 1.0).abs() < 0.1, "σ₀ {}", r.sigma0);
    let m = a.mount(0);
    let s = r.cameras[0].mount_sigma;
    for q in 0..6 {
        let truth = if q < 3 { lever[q] } else { bore[q - 3] };
        let sg = s[q];
        let z = (m[q] - truth) / sg;
        eprintln!("  {:>12}: truth {:+.5} solved {:+.5} σ {:.1e} ({:+.2}σ)", MOUNT_NAMES[q], truth, m[q], sg, z);
        assert!(z.abs() < 4.0, "{} off by {z:.1}σ", MOUNT_NAMES[q]);
    }
    assert!((m[0] - lever[0]).abs() < 0.03 && (m[2] - lever[2]).abs() < 0.03);
    assert!((0..3).all(|q| (m[3 + q] - bore[q]).abs() < 2e-4));
}

#[test]
fn film_interior_orientation_from_fiducials() {
    // The Wild RC30 of USGS report OSL/3707: f 153.313 mm, PP (−0.004, 0.006) mm, eight fiducials.
    let fid: [(f64, f64); 8] = [(-105.994, -105.998), (106.006, 105.998), (-105.990, 106.004), (105.998, -105.998), (-111.994, 0.003), (112.004, 0.002), (0.004, 112.008), (-0.006, -111.994)];
    let mut rng = Rng(6);
    let mut io = [0.0; NIO];
    io[0] = 153.313;
    io[1] = -0.004;
    io[2] = 0.006;
    io[3] = -6.2e-9; // a few µm of radial distortion at the edge
    let cam = CameraIn { film: true, pixel_mm: 0.0, width: 0.0, height: 0.0, ..digital(io) };
    let mut t = block(cam.clone(), 2, 6, 1500.0, 920.0, 1400.0, 60.0, 1.0, &mut rng);
    // Each image scanned at ~20 µm with its own rotation, offset and a slight affinity.
    let mut measured = Vec::new();
    for i in 0..t.eo.len() {
        let a = 1.0 / 0.020;
        let rot = (0.8 * rng.normal()).to_radians();
        let (s, c) = rot.sin_cos();
        let sx = a * (1.0 + 2e-4 * rng.normal());
        let sy = a * (1.0 + 2e-4 * rng.normal());
        let aff = [5700.0 + 30.0 * rng.normal(), sx * c, -sx * s, 5650.0 + 30.0 * rng.normal(), -sy * s, -sy * c];
        t.film[i] = Some(aff);
        let m: Vec<(f64, f64)> = fid.iter().map(|&(x, y)| (aff[0] + aff[1] * x + aff[2] * y + 0.3 * rng.normal(), aff[3] + aff[4] * x + aff[5] * y + 0.3 * rng.normal())).collect();
        measured.push(m);
    }
    // Interior orientation per image from the measured fiducials.
    let mut b = build(&t, cam.clone(), Spec { sigma_px: 0.5, gcp_every: 41, ..Spec::default() }, &mut rng);
    let mut worst_fid: f64 = 0.0;
    for (i, m) in measured.iter().enumerate() {
        let o = fiducial_io(m, &fid, FidModel::Affine).unwrap();
        worst_fid = worst_fid.max(o.rms_um);
        assert!((o.pixel_um.0 - 20.0).abs() < 0.05, "{:?}", o.pixel_um);
        b.images[i].film = Some(o.mm_to_px);
    }
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged && (r.sigma0 - 1.0).abs() < 0.15, "σ₀ {}", r.sigma0);
    let mut worst = (0.0_f64, 0.0_f64);
    for i in 0..t.eo.len() {
        let (c, rr) = eo_enu0(&a, &r, i);
        worst.0 = worst.0.max(norm(sub(c, t.eo[i].0)));
        worst.1 = worst.1.max(rot_err_deg(&rr, &t.eo[i].1));
    }
    // Scale 1:10 000, 20 µm scan: 0.2 m GSD.
    assert!(worst.0 < 0.5 && worst.1 < 0.01, "worst centre {} m, attitude {}°", worst.0, worst.1);
    assert!(r.checks_multi.n > 3 && r.checks_multi.rmse_r < 0.25, "{:?}", r.checks_multi);
    // The solved frame camera re-projects like the film model (scan rotation folded in).
    let rec = a.frame_record(0).unwrap();
    let fm = gw_sensor::frame::frame_from_params(&rec, "film").unwrap();
    use gw_sensor::SensorModel;
    let (c0, r0) = a.eo(0);
    let mut dmax: f64 = 0.0;
    for x in t.pts.iter().step_by(7) {
        let v = mv(&r0, sub(a.local(geo(x[0], x[1], x[2])), c0));
        let Some(p) = project(&a.cams[0], &a.io(0), a.images[0].film.as_ref(), v) else { continue };
        if !(p.0 > 0.0 && p.1 > 0.0 && p.0 < 11400.0 && p.1 < 11400.0) {
            continue;
        }
        let q = fm.ground_to_image(geo(x[0], x[1], x[2])).unwrap();
        dmax = dmax.max((p.0 - q.0).hypot(p.1 - q.1));
    }
    assert!(dmax < 1e-4, "frame record differs from the film model by {dmax} px");
    eprintln!("film: fiducial RMS ≤ {worst_fid:.2} µm, σ₀ {:.3}, worst centre {:.3} m, attitude {:.5}°, checks RMSE_r {:.3} m", r.sigma0, worst.0, worst.1, r.checks_multi.rmse_r);
}

#[test]
fn robust_weighting_and_rejection() {
    let mut rng = Rng(7);
    let t = block(digital(base_io()), 3, 8, 150.0, 20.0, 55.0, 25.0, 2.0, &mut rng);
    let clean = build(&t, digital(base_io()), Spec::default(), &mut rng);
    let mut b = Built { cams: clean.cams.clone(), images: clean.images.clone(), points: clean.points.iter().map(|p| PointIn { ..*p }).collect(), obs: clean.obs.clone() };
    // Blunders on points with four or more rays.
    let rays = |b: &Built, j: usize| b.obs.iter().filter(|o| o.point == j).count();
    let cand: Vec<usize> = (0..b.obs.len()).filter(|&k| rays(&b, b.obs[k].point) >= 4).collect();
    let blunders: Vec<usize> = cand.iter().copied().step_by(cand.len() / 6).take(6).collect();
    for &k in &blunders {
        b.obs[k].x += 25.0;
    }
    let (_, r0) = solve(clean, AeroOptions::default()).unwrap();
    let (_, r) = solve(b, AeroOptions { robust: Robust::Huber(1.5), max_reject: 12, reject_k: 4.0, ..AeroOptions::default() }).unwrap();
    // The solution with blunders (Huber + rejection) matches the clean one within its σ.
    let mut zmax: f64 = 0.0;
    for (a, c) in r.images.iter().zip(&r0.images) {
        let d = gw_geodesy::wgs84::geodetic_to_enu(a.centre.lat, a.centre.lon, a.centre.h, c.centre.lat, c.centre.lon, c.centre.h);
        for k in 0..3 {
            zmax = zmax.max(d[k].abs() / c.sigma[k]);
        }
    }
    let caught = blunders.iter().filter(|&&k| r.rejected.contains(&k)).count();
    assert!(zmax < 1.0 && caught >= 4 && r.rejected.len() <= 12, "EO moved {zmax}σ; {caught} blunders of 6 rejected, {} in all", r.rejected.len());
    let z = check_z(&r);
    assert!((r.sigma0 - 1.0).abs() < 0.12 && z.0 < 1.5, "σ₀ {}, {z:?}", r.sigma0);
    eprintln!("robust: {caught} of 6 blunders rejected, {} rejected in all, σ₀ {:.3}, EO within {zmax:.2}σ of the clean solution", r.rejected.len(), r.sigma0);
}

#[test]
fn heading_unknown_nadir_approximation() {
    // Drone EXIF without angles: positions only, nadir assumed, heading fitted in the plane.
    let mut rng = Rng(8);
    let t = block(digital(base_io()), 3, 8, 150.0, 20.0, 55.0, 15.0, 3.0, &mut rng);
    let b = build(&t, digital(base_io()), Spec { gnss: Some(0.05), attitude_known: false, ..Spec::default() }, &mut rng);
    let (a, r) = solve(b, AeroOptions::default()).unwrap();
    assert!(r.converged && (r.sigma0 - 1.0).abs() < 0.1, "σ₀ {}", r.sigma0);
    // Images that see six or more GCPs are resected first; the rest come from the nadir fit.
    assert!(r.images.iter().all(|im| im.approx == 1 || im.approx == 2) && r.images.iter().filter(|im| im.approx == 1).count() >= 12);
    let (worst, zmax) = eo_errors(&a, &r, &t);
    assert!(worst.0 < 0.06 && worst.1 < 0.025 && zmax < 4.0, "worst centre {} m, attitude {}°, {zmax}σ", worst.0, worst.1);
}

// ---- degenerate geometries: refused or flagged ----

#[test]
fn refuses_a_block_without_datum() {
    let mut rng = Rng(9);
    let t = block(digital(base_io()), 2, 6, 150.0, 20.0, 55.0, 25.0, 2.0, &mut rng);
    let b = build(&t, digital(base_io()), Spec { gcp_every: 0, ..Spec::default() }, &mut rng);
    let e = Aero::new(b.cams, b.images, b.points, b.obs, AeroOptions::default()).err().expect("no datum must be refused");
    assert!(e.to_string().contains("no datum"), "{e}");
}

#[test]
fn focal_length_over_flat_ground_without_gnss_is_refused_or_flagged() {
    // Nadir block over flat ground with GCPs only: f and the flying height cannot be separated.
    let mut rng = Rng(10);
    let t = block(digital(base_io()), 3, 8, 150.0, 20.0, 55.0, 0.0, 0.0, &mut rng);
    let mut given = digital(base_io());
    given.io_free[0] = true;
    let b = build(&t, given, Spec::default(), &mut rng);
    match Aero::new(b.cams, b.images, b.points, b.obs, AeroOptions::default()) {
        Err(e) => {
            assert!(e.to_string().contains("cannot be determined"), "{e}");
            eprintln!("flat ground, f free: refused: {e}");
        }
        Ok(mut a) => {
            a.run().unwrap();
            let r = a.report().unwrap();
            let fz = r.pairs.iter().find(|(p, q, _)| (p.kind == ParamKind::Io && p.which == 0) || (q.kind == ParamKind::Io && q.which == 0)).map(|x| x.2.abs()).unwrap_or(0.0);
            assert!(fz > 0.99, "f must be flagged as correlated: {fz}");
            eprintln!("flat ground, f free: flagged, |ρ| {fz:.5}");
        }
    }
}

#[test]
fn refuses_single_strip_roll_with_gnss_only() {
    // One strip, GNSS positions only (collinear centres), no GCP, no IMU: the roll about the strip
    // axis is undetermined.
    let mut rng = Rng(11);
    let t = block(digital(base_io()), 1, 8, 150.0, 20.0, 55.0, 25.0, 0.0, &mut rng);
    let mut b = build(&t, digital(base_io()), Spec { gcp_every: 0, check_every: 0, gnss: Some(0.02), ..Spec::default() }, &mut rng);
    // Exactly collinear GNSS positions.
    for im in &mut b.images {
        if let Some((g, r)) = im.approx {
            let e = gw_geodesy::wgs84::geodetic_to_enu(g.lat, g.lon, g.h, LAT0, LON0, H0);
            im.approx = Some((geo(e[0], 0.0, 150.0), r));
        }
    }
    let e = Aero::new(b.cams, b.images, b.points, b.obs, AeroOptions::default()).err().expect("must be refused");
    assert!(e.to_string().contains("cannot be determined"), "{e}");
    eprintln!("single strip, GNSS only: {e}");
}

#[test]
fn refuses_mount_without_observations_and_leaves_out_images_without_points() {
    let mut rng = Rng(12);
    let t = block(digital(base_io()), 2, 6, 150.0, 20.0, 55.0, 25.0, 2.0, &mut rng);
    let mut given = digital(base_io());
    given.mount_free[0] = true;
    let b = build(&t, given, Spec::default(), &mut rng);
    let e = Aero::new(b.cams, b.images, b.points, b.obs, AeroOptions::default()).err().unwrap();
    assert!(e.to_string().contains("lever arm"), "{e}");
    // An image that sees two points only.
    let mut b = build(&t, digital(base_io()), Spec::default(), &mut rng);
    let mut seen = 0;
    b.obs.retain(|o| {
        if o.image != 3 {
            return true;
        }
        seen += 1;
        seen <= 2
    });
    let a = Aero::new(b.cams, b.images, b.points, b.obs, AeroOptions::default()).unwrap();
    assert!(a.excluded[3] && a.notes.iter().any(|n| n.contains("fewer than six") && n.contains('4')), "{:?}", a.notes);
    assert!(a.frame_record(3).is_none() && a.frame_record(2).is_some());
}

#[test]
fn flags_principal_point_correlation_in_a_nadir_block() {
    // Flat nadir block with GNSS: the principal point trades against the attitude and position.
    let mut rng = Rng(13);
    let t = block(digital(base_io()), 3, 8, 150.0, 20.0, 55.0, 2.0, 0.0, &mut rng);
    let mut given = digital(base_io());
    given.io_free[1] = true;
    given.io_free[2] = true;
    let b = build(&t, given, Spec { gnss: Some(0.5), gcp_every: 200, ..Spec::default() }, &mut rng);
    let (_, r) = solve(b, AeroOptions::default()).unwrap();
    // No single pair is strong (x0 trades against every image's attitude a little); the global
    // correlation shows it.
    let g = r.cameras[0].global;
    assert!(r.weak.iter().any(|(p, _)| p.kind == ParamKind::Io && p.which == 1), "x0 must be flagged: global {:?}, weak {:?}", g, r.weak);
    eprintln!("principal point: global correlation x0 {:.5}, y0 {:.5}; strongest pair {:?}", g[1], g[2], r.pairs.first());
}

#[test]
fn job_record_round_trip() {
    // A job with one camera, two images (frame records) and points decodes as given.
    let mut job = vec![31.0, 1.0, 1.0, 2.0, 1.0, 2.0, 30.0, 1.0, 1.5, 4.0, 0.0, 0.9];
    let mut cam = vec![0.0, 0.0, 0.004, 6000.0, 4000.0];
    cam.extend(base_io());
    cam.extend([1.0; NIO]);
    cam.extend([0.0; NIO]);
    cam.extend([0.0; 18]);
    job.extend(&cam);
    for k in 0..2 {
        let rec = [0.0, 24.0, 0.004, 3000.0, 2000.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 6000.0, 4000.0, LAT0, LON0 + 0.0002 * k as f64, 400.0, 0.0, 0.0, 90.0, 0.0];
        job.extend([0.0, 0.0, 1.0, 1.0, 3.0, 3.0, 5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, rec.len() as f64]);
        job.extend(rec);
    }
    job.extend([0.0, f64::NAN, f64::NAN, f64::NAN, 0.0, 0.0]);
    job.extend([0.0, 0.0, 100.0, 200.0, 0.5, 1.0, 0.0, 110.0, 205.0, 0.5]);
    let (c, i, p, o, opts) = decode_job(&job).unwrap();
    assert_eq!((c.len(), i.len(), p.len(), o.len()), (1, 2, 1, 2));
    assert!(c[0].io_free.iter().all(|f| *f) && i[0].gnss == Some([3.0, 3.0, 5.0]) && i[1].approx.is_some());
    assert_eq!(opts.robust, Robust::Huber(1.5));
    // Truncations and bad counts are refused, never panic.
    for n in 0..job.len() {
        assert!(decode_job(&job[..n]).is_err());
    }
    let mut bad = job.clone();
    bad[3] = 1e12;
    assert!(decode_job(&bad).is_err());
}
