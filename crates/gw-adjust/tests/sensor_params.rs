//! REQ-GAP-18/19: the block adjustment through adjustable sensor parameters. Two overlapping
//! images whose "true" models differ from the given ones by known parameter corrections; the
//! measurements come from the true models; the adjustment, with GCPs and tie points, must recover
//! the corrections and the checkpoints must improve. Frame cameras (perspective centre, attitude,
//! focal length) and RSMs with an adjustable set (image-space offsets and a ground-space offset).

use gw_adjust::block::{adjust, ImageIn, ObsIn, Options, PointIn, PointKind};
use gw_adjust::rsmfit::{fit_rsm, RsmSpec};
use gw_sensor::adjusted::BiasKind;
use gw_sensor::frame::{Camera, FrameModel};
use gw_sensor::rsm::{Frame, ParamSet, Term};
use gw_sensor::{Ground, SensorModel};
use std::rc::Rc;

fn frames() -> (FrameModel, FrameModel) {
    let cam = Camera { focal_mm: 50.0, pixel_mm: 0.004, cx: 3000.0, cy: 2000.0, width: 6000.0, height: 4000.0, ..Camera::default() };
    let a = FrameModel::new(cam, Ground { lat: 34.500, lon: -116.5050, h: 2100.0 }, [0.0, -10.0, 0.0], "left").unwrap();
    let b = FrameModel::new(cam, Ground { lat: 34.500, lon: -116.4950, h: 2100.0 }, [0.0, 10.0, 0.0], "right").unwrap();
    (a, b)
}

/// Points on the ground seen by both images, measured with the true models.
fn block(truth: &[&dyn SensorModel], given: Vec<Rc<dyn SensorModel>>, priors: Vec<Option<Vec<f64>>>) -> (Vec<ImageIn>, Vec<PointIn>, Vec<ObsIn>, Vec<Ground>) {
    let mut pts = Vec::new();
    let mut gs = Vec::new();
    let mut obs = Vec::new();
    let mut k = 0;
    for j in 0..5 {
        for i in 0..5 {
            let g = Ground { lat: 34.4985 + 0.00075 * j as f64, lon: -116.5015 + 0.00075 * i as f64, h: 600.0 + 15.0 * ((i + j) % 3) as f64 };
            let kind = if (i, j) == (0, 0) || (i, j) == (4, 0) || (i, j) == (0, 4) || (i, j) == (4, 4) || (i, j) == (2, 2) { PointKind::Gcp } else if (i + j) % 2 == 1 { PointKind::Check } else { PointKind::Tie };
            pts.push(PointIn { kind, known: (kind != PointKind::Tie).then_some(g), sigma_h: 0.02, sigma_v: 0.02 });
            gs.push(g);
            for (m, t) in truth.iter().enumerate() {
                let (x, y) = t.ground_to_image(g).unwrap();
                assert!(x > 0.0 && y > 0.0 && x < 6000.0 && y < 4000.0, "point {k} outside image {m}: {x} {y}");
                obs.push(ObsIn { image: m, point: k, x, y, sigma_px: 0.3 });
            }
            k += 1;
        }
    }
    let images = given.into_iter().zip(priors).map(|(model, prior_cov)| ImageIn { model, kind: BiasKind::Shift, fixed: false, centre: (3000.0, 2000.0), half: (3000.0, 2000.0), prior_sigma_px: 0.0, params: true, prior_cov }).collect();
    (images, pts, obs, gs)
}

#[test]
fn frame_parameters_are_recovered() {
    let (a, b) = frames();
    let da = [2.0, -1.5, 1.0, 0.02, -0.01, 0.03, 0.0];
    let db = [-1.0, 2.5, -0.5, -0.015, 0.02, -0.02, 0.0];
    let ta = a.with_params(&da).unwrap();
    let tb = b.with_params(&db).unwrap();
    // A priori: 5 m on the centre, 0.1° on the angles, the focal length held (1 µm).
    let prior = {
        let v = [25.0, 25.0, 25.0, 0.01, 0.01, 0.01, 1e-6];
        let mut c = vec![0.0; 49];
        for i in 0..7 {
            c[i * 8] = v[i];
        }
        Some(c)
    };
    let (images, pts, obs, _) = block(&[&*ta, &*tb], vec![Rc::new(a), Rc::new(b)], vec![prior.clone(), prior]);
    let s = adjust(&images, &pts, &obs, &Options::default()).unwrap();
    assert!(s.converged);
    // A short-baseline pair over nearly flat ground: the centre and the attitude correlate, so
    // they are recovered to the extent the GCPs (σ 2 cm) separate them.
    for (got, want) in [(&s.params[0], da), (&s.params[1], db)] {
        for i in 0..3 {
            assert!((got[i] - want[i]).abs() < 0.15, "centre {i}: {} vs {}", got[i], want[i]);
        }
        for i in 3..6 {
            assert!((got[i] - want[i]).abs() < 4e-3, "angle {i}: {} vs {}", got[i], want[i]);
        }
    }
    assert!(s.checkpoints_before.rmse_r > 1.0, "before {}", s.checkpoints_before.rmse_r);
    assert!(s.checkpoints_after.rmse_r < 0.05, "after {}", s.checkpoints_after.rmse_r);
    assert_eq!(s.bias_cov[0].len(), 49);
    assert!(s.residuals.iter().all(|r| r.v.0.abs() < 0.1 && r.v.1.abs() < 0.1));
}

#[test]
fn rsm_adjustable_parameters_are_recovered() {
    let (a, b) = frames();
    let spec = RsmSpec { rows: 4000.0, cols: 6000.0, h: (400.0, 900.0), sections: (2, 2), ..RsmSpec::default() };
    let mk = |f: &FrameModel| {
        let mut m = fit_rsm(f, &spec).unwrap().model;
        m.adjustable = Some(ParamSet { frame: Frame::Domain, norm_off: [0.0; 3], norm_scale: [1.0; 3], terms: vec![Term::Row(0, 0, 0), Term::Col(0, 0, 0), Term::Ground(2)], values: vec![0.0; 3] });
        m.cov = Some(vec![25.0, 0.0, 0.0, 0.0, 25.0, 0.0, 0.0, 0.0, 9.0]);
        m
    };
    let (ra, rb) = (mk(&a), mk(&b));
    let (da, db) = ([1.5, -2.0, 1.2], [-0.7, 0.9, -0.8]);
    let ta = ra.with_params(&da).unwrap();
    let tb = rb.with_params(&db).unwrap();
    let (images, pts, obs, _) = block(&[&*ta, &*tb], vec![Rc::new(ra), Rc::new(rb)], vec![None, None]);
    let s = adjust(&images, &pts, &obs, &Options::default()).unwrap();
    for (got, want) in [(&s.params[0], da), (&s.params[1], db)] {
        for i in 0..2 {
            assert!((got[i] - want[i]).abs() < 0.02, "image term {i}: {} vs {}", got[i], want[i]);
        }
        assert!((got[2] - want[2]).abs() < 0.05, "ground z offset: {} vs {}", got[2], want[2]);
    }
    assert!(s.checkpoints_after.rmse_3d < 0.05, "after {}", s.checkpoints_after.rmse_3d);
    // The posterior σ of the image terms is below the prior 5 px.
    assert!(s.bias_cov[0][0].sqrt() < 1.0);
}
