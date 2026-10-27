//! REQ-SNS-17: the adaptive grid keeps the interpolated mapping within the error bound. A source
//! "image" whose bands are its own column and row makes the ortho output the mapped position, so
//! it can be checked against the exact model + DEM mapping (FX-04 image 1 over the FX-05 terrain).

use gw_raster::ortho::{ortho_tile, OrthoSpec};
use gw_raster::resample::{Kernel, Patch};
use gw_sensor::rpc::Rpc;
use gw_sensor::terrain::DemGrid;
use gw_sensor::{Ground, SensorModel};
use std::path::PathBuf;

fn terrain(lat: f64, lon: f64) -> f64 {
    let x = (lon + 116.5) * 111320.0 * 34.5f64.to_radians().cos();
    let y = (lat - 34.5) * 110940.0;
    let a = 25f64.to_radians();
    let u = x * a.cos() + y * a.sin();
    let v = -x * a.sin() + y * a.cos();
    650.0 + 0.01 * x + 60.0 * (-((u - 300.0) / 150.0).powi(2)).exp() - 30.0 * (-((v + 400.0) / 120.0).powi(2)).exp()
}

#[test]
fn adaptive_grid_meets_the_bound() {
    let t: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx04/fx04_truth.json")).unwrap()).unwrap();
    let mut rec: Vec<f64> = t["images"][0]["rpcTrue"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    rec.extend_from_slice(&[0.0; 6]);
    let model = Rpc::from_record(&rec).unwrap();
    // DEM: 2 m posts over the area (HAE).
    let (lat0, lon0, d) = (34.512, -116.512, 2e-5);
    let (w, h) = (1200, 1200);
    let mut hs = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            hs[j * w + i] = terrain(lat0 - j as f64 * d, lon0 + i as f64 * d) as f32;
        }
    }
    let dem = DemGrid::new(lat0, lon0, d, d, w, h, hs, true, f64::NAN).unwrap();
    // Source: column and row ramps over the whole image.
    let (sw, sh) = (2048usize, 2048usize);
    let mut cx = vec![0f32; sw * sh];
    let mut cy = vec![0f32; sw * sh];
    for y in 0..sh {
        for x in 0..sw {
            cx[y * sw + x] = x as f32 + 0.5;
            cy[y * sw + x] = y as f32 + 0.5;
        }
    }
    let src = [Patch { x0: 0.0, y0: 0.0, w: sw, h: sh, px: &cx }, Patch { x0: 0.0, y0: 0.0, w: sw, h: sh, px: &cy }];
    // A 512 × 512 tile at 0.5 m in UTM zone 11N inside the image.
    let g = gw_geodesy::grids::utmups_forward(34.502, -116.502, Some(11)).unwrap();
    let s = OrthoSpec { zone: 11, north: true, e0: g.easting.floor(), n0: g.northing.floor(), res: 0.5, w: 512, h: 512, kernel: Kernel::Bilinear, bound_px: 0.1, fallback_h: 650.0 };
    let out = ortho_tile(&model, Some(&dem), &|_, _| 0.0, &s, &src).unwrap();
    let mut worst = 0f64;
    let mut n = 0;
    for j in (0..512).step_by(7) {
        for i in (0..512).step_by(7) {
            let k = j * 512 + i;
            if out.mask[k] == 0 {
                continue;
            }
            let (lat, lon, _, _) = gw_geodesy::grids::utmups_reverse(11, true, s.e0 + (i as f64 + 0.5) * 0.5, s.n0 - (j as f64 + 0.5) * 0.5).unwrap();
            let hh = dem.sample(lat, lon);
            let (x, y) = model.ground_to_image(Ground { lat, lon, h: hh }).unwrap();
            worst = worst.max((f64::from(out.bands[0][k]) - x).hypot(f64::from(out.bands[1][k]) - y));
            n += 1;
        }
    }
    eprintln!("ortho: {} cells, reported max {:.3} px, measured worst {worst:.3} px over {n} pixels", out.cells, out.max_err_px);
    assert!(n > 4000);
    assert!(worst <= 0.12, "worst {worst}");
}

#[test]
#[ignore]
fn whole_image_ortho_error() {
    let t: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx04/fx04_truth.json")).unwrap()).unwrap();
    let mut rec: Vec<f64> = t["images"][0]["rpcTrue"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    rec.extend_from_slice(&[0.0; 6]);
    let model = Rpc::from_record(&rec).unwrap();
    let (lat0, lon0, d) = (34.52, -116.52, 2e-5);
    let (w, h) = (2000, 2000);
    let mut hs = vec![0f32; w * h];
    for j in 0..h {
        for i in 0..w {
            hs[j * w + i] = terrain(lat0 - j as f64 * d, lon0 + i as f64 * d) as f32;
        }
    }
    let dem = DemGrid::new(lat0, lon0, d, d, w, h, hs, true, f64::NAN).unwrap();
    let (sw, sh) = (2048usize, 2048usize);
    let cx = vec![1f32; sw * sh];
    let src = [Patch { x0: 0.0, y0: 0.0, w: sw, h: sh, px: &cx }];
    let mut e = Vec::new();
    let mut n = Vec::new();
    for (x, y) in [(0.0, 0.0), (2048.0, 0.0), (0.0, 2048.0), (2048.0, 2048.0)] {
        let g = model.image_to_ground(x, y, 650.0).unwrap();
        let u = gw_geodesy::grids::utmups_forward(g.lat, g.lon, Some(11)).unwrap();
        e.push(u.easting);
        n.push(u.northing);
    }
    let e0 = (e.iter().cloned().fold(f64::INFINITY, f64::min) / 0.5).floor() * 0.5;
    let n0 = (n.iter().cloned().fold(f64::NEG_INFINITY, f64::max) / 0.5).ceil() * 0.5;
    for (tx, ty) in [(0usize, 0usize), (512, 512), (1024, 0), (1536, 1536)] {
        let s = OrthoSpec { zone: 11, north: true, e0: e0 + tx as f64 * 0.5, n0: n0 - ty as f64 * 0.5, res: 0.5, w: 512, h: 512, kernel: Kernel::Bilinear, bound_px: 0.1, fallback_h: 650.0 };
        let out = ortho_tile(&model, Some(&dem), &|_, _| 0.0, &s, &src).unwrap();
        eprintln!("tile ({tx},{ty}): cells {} max {:.3} at {:?}", out.cells, out.max_err_px, out.worst_cell);
    }
}
