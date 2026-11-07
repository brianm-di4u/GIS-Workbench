//! REQ-GAP-46: the joint adjustment of image corrections and a point cloud's datum shift.
//! Synthetic truth: ground points, a cloud whose coordinates are the truth moved by a known
//! (inverse) datum shift, images whose models are off by a known bias, surveyed points on the
//! cloud. The adjustment must recover the shift and the bias to the separation the geometry
//! allows, and its posterior covariance must match the scatter of repeated noisy solutions.

use gw_adjust::block::{adjust_joint, CloudObs, DatumIn, ImageIn, Joint, ObsIn, Options, PointIn, PointKind};
use gw_adjust::gpm;
use gw_sensor::adjusted::{Adjusted, BiasKind, ImageBias};
use gw_sensor::geotransform::{GeoTransformModel, MapCrs};
use gw_sensor::intersect::deg_per_metre;
use gw_sensor::{Ground, SensorModel};
use std::rc::Rc;

const C: Ground = Ground { lat: 39.9000, lon: -105.2900, h: 1700.0 };

fn at(e: f64, n: f64, h: f64) -> Ground {
    let (dlat, dlon) = deg_per_metre(C);
    Ground { lat: C.lat + n * dlat, lon: C.lon + e * dlon, h }
}

/// A 0.6 m ortho (NAIP-like) over ±1 km of C.
fn ortho() -> GeoTransformModel {
    let u = gw_geodesy::grids::utmups_forward(C.lat, C.lon, Some(13)).unwrap();
    GeoTransformModel::new([u.easting - 1200.0, 0.6, 0.0, u.northing + 1200.0, 0.0, -0.6], MapCrs::Utm { zone: 13, north: true }).unwrap()
}

/// Deterministic Gaussian noise (Box–Muller on xorshift).
struct Noise(u64);
impl Noise {
    fn u(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn g(&mut self) -> f64 {
        (-2.0 * self.u().ln()).sqrt() * (2.0 * std::f64::consts::PI * self.u()).cos()
    }
}

struct Case {
    images: Vec<ImageIn>,
    points: Vec<PointIn>,
    obs: Vec<ObsIn>,
    joint: Joint,
}

/// Truth: datum θ (cloud → ground), image bias (dy, dx px). Points on a 9 × 9 grid over ±900 m with
/// 0–200 m of relief; surveyed points on the cloud at 12 spots, 4 of them checkpoints.
fn case(k: usize, theta: &[f64], bias: (f64, f64), noise: Option<&mut Noise>, image_fixed: bool, sigma_px: f64) -> Case {
    let datum = DatumIn { k, centre: Some(C), prior_sigma: if k == 7 { vec![5.0, 5.0, 5.0, 200.0, 200.0, 200.0, 200.0] } else { vec![5.0; k] } };
    let base = ortho();
    let mut tb = ImageBias::zero((2000.0, 2000.0), (2000.0, 2000.0));
    tb.c[0] = bias.0;
    tb.c[3] = bias.1;
    let truth_model = Adjusted { base: Rc::new(base.clone()), bias: tb, sigma: None, name: "truth".into() };
    let mut nz = noise;
    let mut points = Vec::new();
    let mut obs = Vec::new();
    let inv = |g: Ground| -> Ground {
        // Cloud coordinates: truth moved by −θ (iterate: the shift is evaluated at the cloud point).
        let mut l = g;
        for _ in 0..5 {
            let d = datum.apply(theta, l);
            l = Ground { lat: l.lat - (d.lat - l.lat) + (g.lat - l.lat), lon: l.lon - (d.lon - l.lon) + (g.lon - l.lon), h: l.h - (d.h - l.h) + (g.h - l.h) };
            let back = datum.apply(theta, l);
            if (back.lat - g.lat).abs() < 1e-12 && (back.lon - g.lon).abs() < 1e-12 && (back.h - g.h).abs() < 1e-6 {
                break;
            }
        }
        l
    };
    for j in 0..9 {
        for i in 0..9 {
            let (e, n) = (-900.0 + 225.0 * i as f64, -900.0 + 225.0 * j as f64);
            let h = 1650.0 + 200.0 * ((e / 900.0) * 0.5 + 0.5) * ((n / 900.0) * 0.3 + 0.7);
            let g = at(e, n, h);
            let (mut x, mut y) = truth_model.ground_to_image(g).unwrap();
            let mut l = inv(g);
            if let Some(nz) = nz.as_deref_mut() {
                x += sigma_px * nz.g();
                y += sigma_px * nz.g();
                let (dlat, dlon) = deg_per_metre(l);
                l = Ground { lat: l.lat + 0.2 * nz.g() * dlat, lon: l.lon + 0.2 * nz.g() * dlon, h: l.h + 0.1 * nz.g() };
            }
            let kind = if (i + 2 * j) % 7 == 3 { PointKind::LidarCheck } else { PointKind::Lidar };
            points.push(PointIn { kind, known: Some(l), sigma_h: 0.2, sigma_v: 0.1 });
            obs.push(ObsIn { image: 0, point: points.len() - 1, x, y, sigma_px });
        }
    }
    let mut cloud = Vec::new();
    for s in 0..12 {
        let (e, n) = (-800.0 + 145.0 * s as f64, if s % 2 == 0 { -600.0 } else { 650.0 });
        // The cloud surface: a plane with slope (0.05, −0.08); truth = cloud moved by θ.
        let grad = (0.05, -0.08);
        let zc = 1700.0 + grad.0 * e + grad.1 * n;
        let cl = at(e, n, zc);
        let moved = datum.apply(theta, cl);
        // Truth height at the cloud point's lat/lon after the move: surface moved (a plane).
        let (dlat, dlon) = deg_per_metre(cl);
        let (me, mn) = ((moved.lon - cl.lon) / dlon, (moved.lat - cl.lat) / dlat);
        let mut th = moved.h - grad.0 * me - grad.1 * mn;
        if let Some(nz) = nz.as_deref_mut() {
            th += 0.05 * nz.g();
        }
        cloud.push(CloudObs { truth: Ground { h: th, ..cl }, z_cloud: zc, grad, sigma: 0.05, check: s % 3 == 2 });
    }
    let images = vec![ImageIn { model: Rc::new(base), kind: BiasKind::Shift, fixed: image_fixed, centre: (2000.0, 2000.0), half: (2000.0, 2000.0), prior_sigma_px: 50.0, params: false, prior_cov: None }];
    Case { images, points, obs, joint: Joint { datum, cloud } }
}

#[test]
fn three_parameter_shift_with_a_fixed_image() {
    // A trusted image (fixed): the cloud's shift is recovered from the image and the survey.
    let theta = [1.2, -0.8, 0.35];
    let c = case(3, &theta, (0.0, 0.0), None, true, 0.3);
    let s = adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).unwrap();
    for m in 0..3 {
        assert!((s.datum[m] - theta[m]).abs() < 2e-3, "θ{m} {} vs {}", s.datum[m], theta[m]);
    }
    assert!(s.cloud_checks_before.rmse[2] > 0.2 && s.cloud_checks_after.rmse[2] < 0.01, "cloud checks {:?} → {:?}", s.cloud_checks_before.rmse, s.cloud_checks_after.rmse);
    assert!(s.lidar_checks_before.rmse_r > 1.0 && s.lidar_checks_after.rmse_r < 0.01, "held-out {} → {}", s.lidar_checks_before.rmse_r, s.lidar_checks_after.rmse_r);
    assert_eq!(s.datum_cov.len(), 9);
}

#[test]
fn image_bias_and_cloud_shift_together() {
    // The image is off by (−6, +9) px = (5.4 m E, 3.6 m N) and the cloud by θ. A mono ortho sees
    // only image − cloud horizontally, so the split comes from the priors (σ 5 m on θ, 50 px on the
    // bias): the difference is exact, the split is not, and the posterior says so.
    let theta = [1.2, -0.8, 0.35];
    let c = case(3, &theta, (-6.0, 9.0), None, false, 0.3);
    let s = adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).unwrap();
    // The survey sees dU − slope·(dE, dN) on its one plane (slope 0.05, −0.08), not dU alone.
    let seen = |t: &[f64]| t[2] - 0.05 * t[0] + 0.08 * t[1];
    assert!((seen(&s.datum) - seen(&theta)).abs() < 2e-3, "vertical seen by the survey: {} vs {}", seen(&s.datum), seen(&theta));
    // What the image sees of the cloud, in ground metres: its bias (E: dx·GSD, N: −dy·GSD) plus θ.
    let rel_e = s.biases[0].c[3] * 0.6 + s.datum[0];
    let rel_n = -s.biases[0].c[0] * 0.6 + s.datum[1];
    assert!((rel_e - (9.0 * 0.6 + theta[0])).abs() < 0.02 && (rel_n - (6.0 * 0.6 + theta[1])).abs() < 0.02, "relative ({rel_e}, {rel_n})");
    // The held-out cloud control is fitted (the relative registration is what matters there).
    assert!(s.lidar_checks_after.rmse_r < 0.02, "{}", s.lidar_checks_after.rmse_r);
    // dE of the shift is separated from the x bias only by the priors: its unit-weight posterior σ
    // stays near the 5 m prior (noise-free data make σ₀ tiny, so compare without σ₀).
    let sd = s.datum_cov[0].sqrt() / s.sigma0;
    assert!(sd > 2.0 && s.datum.len() == 3, "σ dE / σ₀ = {sd} (poorly separated, as it should be)");
}

#[test]
fn seven_parameters_from_a_fixed_image_and_the_survey() {
    // Rotations of 20–60 µrad and 25 ppm over ±900 m move points by 2–5 cm: recovered from
    // noise-free data to a fraction of that.
    let theta = [0.6, -0.4, 0.25, 40.0, -25.0, 60.0, 25.0];
    let c = case(7, &theta, (0.0, 0.0), None, true, 0.3);
    let s = adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).unwrap();
    let tol = [2e-3, 2e-3, 2e-3, 3.0, 3.0, 3.0, 3.0];
    for m in 0..7 {
        assert!((s.datum[m] - theta[m]).abs() < tol[m], "θ{m} {} vs {}", s.datum[m], theta[m]);
    }
    assert!(s.cloud_checks_after.rmse[2] < 0.005);
}

#[test]
fn posterior_covariance_matches_monte_carlo() {
    // 40 noisy repetitions with a fixed image: the scatter of θ̂ about the truth against the
    // posterior σ (σ₀-scaled), and σ₀ near 1 for correctly weighted noise.
    let theta = [1.2, -0.8, 0.35];
    let mut nz = Noise(0x1234_5678_9abc_def1);
    let mut est: Vec<[f64; 3]> = Vec::new();
    let mut pred = [0.0; 3];
    let mut s0 = 0.0;
    let reps = 40;
    for _ in 0..reps {
        let c = case(3, &theta, (0.0, 0.0), Some(&mut nz), true, 0.3);
        let s = adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).unwrap();
        est.push([s.datum[0], s.datum[1], s.datum[2]]);
        for m in 0..3 {
            pred[m] += s.datum_cov[m * 4] / s.sigma0.powi(2) / reps as f64;
        }
        s0 += s.sigma0 / reps as f64;
    }
    for m in 0..3 {
        let emp = (est.iter().map(|e| (e[m] - theta[m]).powi(2)).sum::<f64>() / reps as f64).sqrt();
        let p = pred[m].sqrt();
        assert!(emp / p > 0.6 && emp / p < 1.5, "θ{m}: empirical {emp:.4} vs predicted {p:.4}");
    }
    assert!((s0 - 1.0).abs() < 0.2, "σ₀ {s0}");
}

#[test]
fn gpm_propagation_of_the_solved_shift() {
    let theta = [1.2, -0.8, 0.35];
    let mut nz = Noise(77);
    let c = case(3, &theta, (0.0, 0.0), Some(&mut nz), true, 0.3);
    let s = adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).unwrap();
    let pts = [at(-500.0, 0.0, 1700.0), at(500.0, 0.0, 1700.0)];
    let f = gpm::Spdcf::new(1.0, 0.1, 1.0, 200.0).unwrap();
    let cov = gpm::propagate(&c.joint.datum, &s.datum_cov, &pts, &[[0.2, 0.2, 0.1]; 2], Some(&f)).unwrap();
    let a = gpm::block(&cov, 2, 0, 0);
    // Absolute: the shift's own σ plus the local 0.2 m.
    assert!((a[0][0] - (s.datum_cov[0] + 0.04)).abs() < 1e-9);
    // Relative: the shift cancels; the local part decorrelates over 1 km.
    let r = gpm::relative(&cov, 2, 0, 1);
    assert!(r[0][0] < 2.0 * 0.04 + 1e-9 && r[0][0] > 0.04, "{}", r[0][0]);
    let (ce, le) = gpm::ce_le(a);
    assert!(ce.is_finite() && le.is_finite());
}

#[test]
fn refuses_bad_datum_and_cloud_inputs() {
    let theta = [0.0; 3];
    let mut c = case(3, &theta, (0.0, 0.0), None, true, 0.3);
    c.joint.datum.k = 4;
    assert!(adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).is_err());
    c.joint.datum.k = 3;
    c.joint.datum.centre = None;
    assert!(adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).is_err());
    c.joint.datum.centre = Some(C);
    c.joint.cloud[0].sigma = 0.0;
    assert!(adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).is_err());
    c.joint.cloud[0].sigma = 0.05;
    c.joint.datum.prior_sigma[1] = f64::NAN;
    assert!(adjust_joint(&c.images, &c.points, &c.obs, &c.joint, &Options::default()).is_err());
}
