//! REQ-GAP-20, map-projected products: the line of sight of Landsat 8 Collection 1 and 2 L1TP (ANG)
//! and Sentinel-2B L1C (MTD_TL viewing grids) and the map + line-of-sight model built from it.
//! Corpus items: `landsat8-c1-l1tp-044034-20210508`, `landsat8-c2-l1tp-044034-20240820-tierb`,
//! `s2-l1c-jp2-safe-10seh-20240816` (`build/campaign/corpus.json`). The files stay on D:; the tests
//! skip cleanly when they are absent.
//!
//! Errors are stated as the image displacement error, in pixels, of a point at a height above the
//! reference surface: h · |Δ(tan zenith · horizontal direction)| / GSD, over a grid of image points
//! and the heights 500, 1500 and 3000 m.
//!
//! Oracles:
//! - Landsat C2: the USGS per-pixel view-angle bands (VZA, VAA, 0.01°), sampled every 61 pixels by
//!   `D:/gwb25/data-vendor/tools/landsat_angle_oracle.py` into
//!   `D:/gwb25/data-vendor/oracle/landsat8-c2-044034-20240820-vza-vaa.csv`.
//! - Landsat C1 and C2, Sentinel-2: the product's own ephemeris (ANG EPHEMERIS, MTD_DS GPS
//!   points). The line of sight from a ground point must point at the satellite at some time of the
//!   pass; the angle left at the best time is the cross-track inconsistency.
//! - The grid model against the direct evaluation (the cost of interpolating a node grid).

use gw_geodesy::wgs84::{enu_rotation, geodetic_to_ecef};
use gw_sensor::ortholos::OrthoLos;
use gw_sensor::vendor::landsat::{ortholos_record, parse_mtl, Ang};
use gw_sensor::vendor::s2;
use gw_sensor::{Ground, SensorModel};
use std::path::Path;

const HEIGHTS: [f64; 3] = [500.0, 1500.0, 3000.0];

fn tvec(v: [f64; 3]) -> [f64; 2] {
    [v[0] / v[2], v[1] / v[2]]
}

fn summary(e: &[f64]) -> (f64, f64, usize) {
    let n = e.len().max(1) as f64;
    ((e.iter().map(|v| v * v).sum::<f64>() / n).sqrt(), e.iter().cloned().fold(0.0, f64::max), e.len())
}

/// Smallest angle (rad) between the line of sight `u` (ECEF unit) from `g` and the direction to the
/// satellite over the ephemeris (linear interpolation between samples, refined), and the best time.
fn eph_residual(eph: &[(f64, [f64; 3])], g: [f64; 3], u: [f64; 3]) -> (f64, f64) {
    let ang = |p: [f64; 3]| {
        let d = [p[0] - g[0], p[1] - g[1], p[2] - g[2]];
        let n = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        ((d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / n).clamp(-1.0, 1.0).acos()
    };
    let at = |t: f64| -> [f64; 3] {
        // 4-point Lagrange on the (t, p) samples (uniform or not).
        let k = eph.partition_point(|e| e.0 < t).clamp(2, eph.len() - 2);
        let idx = [k - 2, k - 1, k, k + 1];
        let mut p = [0.0; 3];
        for &i in &idx {
            let mut w = 1.0;
            for &j in &idx {
                if j != i {
                    w *= (t - eph[j].0) / (eph[i].0 - eph[j].0);
                }
            }
            for c in 0..3 {
                p[c] += w * eph[i].1[c];
            }
        }
        p
    };
    let (mut lo, mut hi) = (eph[1].0, eph[eph.len() - 2].0);
    // Golden-section search on the angle (unimodal over one pass).
    let gr = 0.5 * (5f64.sqrt() - 1.0);
    for _ in 0..100 {
        let a = hi - gr * (hi - lo);
        let b = lo + gr * (hi - lo);
        if ang(at(a)) < ang(at(b)) {
            hi = b;
        } else {
            lo = a;
        }
    }
    let t = 0.5 * (lo + hi);
    (ang(at(t)), t)
}

fn p99(e: &[f64]) -> f64 {
    let mut v = e.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v.get(((v.len() as f64) * 0.99) as usize).copied().unwrap_or(0.0)
}

fn enu_to_ecef(lat: f64, lon: f64, v: [f64; 3]) -> [f64; 3] {
    let r = enu_rotation(lat, lon);
    [0, 1, 2].map(|c| r[0][c] * v[0] + r[1][c] * v[1] + r[2][c] * v[2])
}

/// The displacement error (pixels) at height h of a line of sight `u` with residual angle `a`
/// perpendicular to it: d(tan z) ≈ a / cos² z.
fn px_of_angle(a: f64, u: [f64; 3], h: f64, gsd: f64) -> f64 {
    h * a / (u[2] * u[2]) / gsd
}

fn landsat(dir: &str) -> Option<(Ang, String)> {
    let d = Path::new(dir);
    let f = std::fs::read_dir(d).ok()?.flatten().map(|e| e.path()).find(|p| p.to_string_lossy().ends_with("_ANG.txt"))?;
    let t = std::fs::read_to_string(&f).ok()?;
    Some((Ang::parse(&t).unwrap(), f.to_string_lossy().replace("_ANG.txt", "_")))
}

#[test]
fn landsat_line_of_sight_against_usgs_angles_and_ephemeris() {
    let items = [("C2 2024-08-20", "D:/TE-corpus/landsat8-c2-l1tp-044034-20240820-tierb"), ("C1 2021-05-08", "D:/TE-corpus/landsat8-c1-l1tp-044034-20210508")];
    let mut any = false;
    for (label, dir) in items {
        let Some((ang, base)) = landsat(dir) else {
            eprintln!("skipped {label}: not on D:");
            continue;
        };
        any = true;
        let b = ang.band(4).unwrap();
        let gt = ang.geotransform(b);
        // The MTL map grid agrees with the ANG's (corner of the 30 m grid).
        if let Ok(t) = std::fs::read_to_string(format!("{base}MTL.txt")) {
            let m = parse_mtl(&t).unwrap();
            assert_eq!(m.zone, ang.utm_zone);
            assert!((m.ul[0] - ang.ul[0]).abs() < 1e-6 && (m.ul[1] - ang.ul[1]).abs() < 1e-6, "MTL and ANG corners differ");
        }
        let crs = gw_sensor::geotransform::MapCrs::from_epsg(ang.epsg()).unwrap();
        let map = gw_sensor::geotransform::GeoTransformModel::new(gt, crs).unwrap();
        // (1) Against the USGS view-angle bands (C2 only).
        let csv = "D:/gwb25/data-vendor/oracle/landsat8-c2-044034-20240820-vza-vaa.csv";
        if label.starts_with("C2") {
            if let Ok(t) = std::fs::read_to_string(csv) {
                // Points one SCA sees: the line of sight against the USGS angles. Points in an SCA
                // overlap: the USGS bands hold the mean of the two SCAs' zenith and azimuth angles,
                // compared with the same mean of ours; and the spread of the two SCAs about the
                // model's line of sight (the ambiguity of an overlap pixel).
                let mut e: [Vec<f64>; 3] = Default::default();
                let mut ov: [Vec<f64>; 3] = Default::default();
                let mut spread: [Vec<f64>; 3] = Default::default();
                let mut dz = Vec::new();
                for l in t.lines().skip(1) {
                    let v: Vec<f64> = l.split(',').map(|s| s.parse().unwrap()).collect();
                    let us = b.sat_vectors(v[0], v[1], Some(0.0));
                    if us.is_empty() {
                        continue;
                    }
                    let (z, a) = ((v[2] / 100.0).to_radians(), (v[3] / 100.0).to_radians());
                    let o = [z.sin() * a.sin(), z.sin() * a.cos(), z.cos()];
                    let n = us.len() as f64;
                    let zm = us.iter().map(|u| u[2].acos()).sum::<f64>() / n;
                    let am = us.iter().map(|u| u[0].atan2(u[1])).sum::<f64>() / n;
                    let usgs_style = [zm.sin() * am.sin(), zm.sin() * am.cos(), zm.cos()];
                    let (t1, t2) = (tvec(usgs_style), tvec(o));
                    let d = (t1[0] - t2[0]).hypot(t1[1] - t2[1]);
                    let m = b.sat_vector(v[0], v[1], Some(0.0)).unwrap();
                    for (k, h) in HEIGHTS.iter().enumerate() {
                        if us.len() == 1 {
                            e[k].push(h * d / 30.0);
                        } else {
                            ov[k].push(h * d / 30.0);
                            let tm = tvec(m);
                            let s = us.iter().map(|u| {
                                let t = tvec(*u);
                                (t[0] - tm[0]).hypot(t[1] - tm[1])
                            });
                            spread[k].push(h * s.fold(0.0, f64::max) / 30.0);
                        }
                    }
                    if us.len() == 1 {
                        dz.push((zm.to_degrees() - v[2] / 100.0).abs());
                    }
                }
                let (zr, zx, n) = summary(&dz);
                println!("{label}: line of sight vs the USGS VZA/VAA bands, {n} points one SCA sees: zenith RMS {zr:.4}°, max {zx:.4}°");
                for (k, h) in HEIGHTS.iter().enumerate() {
                    let (r, m, _) = summary(&e[k]);
                    let (ro, mo, no) = summary(&ov[k]);
                    let (rs, ms, _) = summary(&spread[k]);
                    println!("  at {h} m: single-SCA points RMS {r:.4} px, 99th percentile {:.4} px, max {m:.4} px;", p99(&e[k]));
                    println!("    {no} overlap points (USGS-style mean) RMS {ro:.4} px, max {mo:.4} px; SCA vs model line of sight in overlaps RMS {rs:.3} px, max {ms:.3} px");
                }
                let (r, _, _) = summary(&e[2]);
                let q = p99(&e[2]);
                assert!(r < 0.05 && q < 0.25, "vs USGS angles at 3000 m: RMS {r} px, 99th percentile {q} px");
            } else {
                eprintln!("skipped the USGS angle comparison: {csv} is absent");
            }
        }
        // (2) Against the ANG ephemeris.
        let eph: Vec<(f64, [f64; 3])> = ang.eph.iter().map(|e| (e[0], [e[1], e[2], e[3]])).collect();
        let mut e: [Vec<f64>; 3] = Default::default();
        let mut times = Vec::new();
        for j in 0..=12 {
            for i in 0..=12 {
                let (line, samp) = (j as f64 / 12.0 * (b.l1t_lines - 1.0), i as f64 / 12.0 * (b.l1t_samps - 1.0));
                let Some(u) = b.sat_vector(line, samp, Some(0.0)) else { continue };
                let g = map.image_to_ground(samp + 0.5, line + 0.5, 0.0).unwrap();
                let (a, t) = eph_residual(&eph, geodetic_to_ecef(g.lat, g.lon, 0.0), enu_to_ecef(g.lat, g.lon, u));
                times.push((line, t));
                for (k, h) in HEIGHTS.iter().enumerate() {
                    e[k].push(px_of_angle(a, u, *h, 30.0));
                }
            }
        }
        let (r, m, n) = summary(&e[2]);
        println!("{label}: line of sight vs the ANG ephemeris at {n} points: displacement error at 3000 m RMS {r:.4} px, max {m:.4} px (500 m: max {:.4} px)", summary(&e[0]).1);
        assert!(r < 0.1 && m < 0.3, "{label}: vs ephemeris at 3000 m RMS {r} px, max {m} px");
        // The time of closest approach runs with the line (the satellite moves along the scene).
        let first = times.iter().filter(|t| t.0 == 0.0).map(|t| t.1).sum::<f64>();
        let last = times.iter().filter(|t| t.0 > 7000.0).map(|t| t.1).sum::<f64>();
        assert!(last > first);
        // (3) The grid model (nodes every 32 px) against the direct evaluation, and its round trip.
        let rec = ortholos_record(&ang, 4, 32.0, 0.0).unwrap();
        let m = OrthoLos::from_record(&rec, "Landsat").unwrap();
        let mut e: [Vec<f64>; 3] = Default::default();
        let mut rt = 0f64;
        for j in 0..=40 {
            for i in 0..=40 {
                let (x, y) = (0.5 + i as f64 / 40.0 * (b.l1t_samps - 1.0), 0.5 + j as f64 / 40.0 * (b.l1t_lines - 1.0));
                let Some(u) = b.sat_vector(y - 0.5, x - 0.5, Some(0.0)) else { continue };
                let g0 = map.image_to_ground(x, y, 0.0).unwrap();
                for (k, h) in HEIGHTS.iter().enumerate() {
                    // Direct: the ground point displaced by h·tan z away from the satellite.
                    let t = tvec(u);
                    let (la, lo, _) = gw_geodesy::wgs84::enu_to_geodetic(-h * t[0], -h * t[1], 0.0, g0.lat, g0.lon, 0.0);
                    let (xd, yd) = map.ground_to_image(Ground { lat: la, lon: lo, h: 0.0 }).unwrap();
                    let (xm, ym) = m.ground_to_image(Ground { h: *h, ..g0 }).unwrap();
                    e[k].push((xm - xd).hypot(ym - yd));
                    let g = m.image_to_ground(xm, ym, *h).unwrap();
                    let (x2, y2) = m.ground_to_image(g).unwrap();
                    rt = rt.max((x2 - xm).hypot(y2 - ym));
                }
            }
        }
        for (k, h) in HEIGHTS.iter().enumerate() {
            let (r, mx, n) = summary(&e[k]);
            println!("  grid model (32 px nodes) vs direct at {h} m over {n} points: RMS {r:.4} px, max {mx:.4} px");
        }
        println!("  grid model round trip: worst {rt:.2e} px; mean view zenith {:.2}°", m.mean_zenith_deg());
        assert!(rt < 1e-6);
        let (r, mx, _) = summary(&e[2]);
        // The grid smooths the line-of-sight step at SCA boundaries (about 0.9 px at 3000 m, see the
        // overlap spread above) over one cell.
        assert!(r < 0.12 && mx < 1.0, "grid vs direct at 3000 m: RMS {r}, max {mx}");
    }
    if !any {
        eprintln!("skipped: no Landsat corpus item on D:");
    }
}

#[test]
fn sentinel2_line_of_sight_against_the_datastrip_ephemeris() {
    let root = Path::new("D:/TE-corpus/s2-l1c-jp2-safe-10seh-20240816");
    let Some(safe) = std::fs::read_dir(root).ok().and_then(|r| r.flatten().map(|e| e.path()).find(|p| p.is_dir())) else {
        eprintln!("skipped: the Sentinel-2 SAFE is not on D:");
        return;
    };
    let find = |sub: &str, name: &str| -> Option<String> {
        let d = std::fs::read_dir(safe.join(sub)).ok()?.flatten().map(|e| e.path()).find(|p| p.is_dir())?;
        std::fs::read_to_string(d.join(name)).ok()
    };
    let tl = find("GRANULE", "MTD_TL.xml").unwrap();
    let ds = find("DATASTRIP", "MTD_DS.xml").unwrap();
    let g = s2::parse_mtd_tl(&tl).unwrap();
    assert_eq!(g.epsg, 32610);
    let day0 = gw_sensor::vendor::odl::civil_days(2024, 8, 16);
    let eph = s2::ds_ephemeris(&ds, day0);
    assert!(eph.len() > 20, "{} GPS points", eph.len());
    for band in [1usize, 3, 7, 11] {
        let (nr, nc, step, v) = g.node_vectors(band).unwrap();
        let res = s2::band_resolution(band);
        let crs = gw_sensor::geotransform::MapCrs::from_epsg(g.epsg).unwrap();
        let map = gw_sensor::geotransform::GeoTransformModel::new([g.ulx, res, 0.0, g.uly, 0.0, -res], crs).unwrap();
        let mut e: [Vec<f64>; 3] = Default::default();
        let mut spread: [Vec<f64>; 3] = Default::default();
        let mut eph_max_det = 0f64;
        for j in 0..nr {
            for i in 0..nc {
                let d = &v[j * nc + i];
                if d.is_empty() {
                    continue;
                }
                let gp = map.image_to_ground(i as f64 * step / res, j as f64 * step / res, 0.0).unwrap();
                let ge = geodetic_to_ecef(gp.lat, gp.lon, 0.0);
                let mut s = [0.0; 3];
                for u in d {
                    for c in 0..3 {
                        s[c] += u[c];
                    }
                    // Each detector's own line of sight against the ephemeris.
                    let (a, _) = eph_residual(&eph, ge, enu_to_ecef(gp.lat, gp.lon, *u));
                    eph_max_det = eph_max_det.max(px_of_angle(a, *u, 3000.0, res));
                }
                let n = (s[0] * s[0] + s[1] * s[1] + s[2] * s[2]).sqrt();
                let u = [s[0] / n, s[1] / n, s[2] / n];
                let (a, _) = eph_residual(&eph, ge, enu_to_ecef(gp.lat, gp.lon, u));
                for (k, h) in HEIGHTS.iter().enumerate() {
                    e[k].push(px_of_angle(a, u, *h, res));
                }
                if d.len() == 2 {
                    let (t1, t2) = (tvec(d[0]), tvec(d[1]));
                    let dd = (t1[0] - t2[0]).hypot(t1[1] - t2[1]) / 2.0;
                    for (k, h) in HEIGHTS.iter().enumerate() {
                        spread[k].push(h * dd / res);
                    }
                }
            }
        }
        let (r, m, n) = summary(&e[2]);
        println!("S2 band index {band} ({res} m): mean line of sight vs MTD_DS ephemeris at {n} nodes: 3000 m RMS {r:.3} px, max {m:.3} px; 500 m max {:.3} px; worst single detector at 3000 m {eph_max_det:.3} px", summary(&e[0]).1);
        for (k, h) in HEIGHTS.iter().enumerate() {
            let (r, m, n) = summary(&spread[k]);
            println!("  overlap nodes ({n}): detector vs mean at {h} m: RMS {r:.3} px, max {m:.3} px");
        }
        assert!(m < 1.0, "S2 vs ephemeris: {m} px at 3000 m");
        // The grid model round trip.
        let rec = s2::ortholos_record(&g, band, 0.0).unwrap();
        let om = OrthoLos::from_record(&rec, "S2").unwrap();
        let gp = om.image_to_ground(5000.0 * 10.0 / res, 6000.0 * 10.0 / res, 1200.0).unwrap();
        let (x, y) = om.ground_to_image(gp).unwrap();
        assert!((x - 5000.0 * 10.0 / res).hypot(y - 6000.0 * 10.0 / res) < 1e-6);
    }
}
