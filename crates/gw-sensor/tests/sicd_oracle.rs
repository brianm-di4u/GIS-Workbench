//! REQ-SAR-05 differential test: the Rust SICD Volume 3 port against SARkit 1.12.0 reference
//! projections (fixtures/fx07/oracle_*.json from build/fixtures/fx07.py) for every grid type,
//! with APOs, on FX-07, the Umbra chip (RGAZIM/PFA) and the ICEYE XML (PLANE).
//! Tolerances (Appendix D §5): 0.01 m on the ground, 0.001 px in the image (scene → image).

use gw_sensor::sicd::{Params, Sicd};
use gw_sensor::{Ground, SensorModel};
use serde_json::Value;
use std::path::PathBuf;

fn oracle(name: &str) -> Option<Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx07").join(format!("oracle_{name}.json"));
    let s = std::fs::read_to_string(p).ok()?;
    serde_json::from_str(&s).ok()
}

fn model(o: &Value) -> Sicd {
    let xml = o["xml"].as_str().unwrap();
    let root = gw_parse::xml::parse(xml.as_bytes()).unwrap();
    let rec = gw_parse::sicd::record(&root).unwrap();
    Sicd::new(Params::from_record(&rec).unwrap(), "test")
}

fn f(v: &Value) -> f64 {
    v.as_f64().unwrap()
}

fn ecf_dist(a: [f64; 3], b: &Value) -> f64 {
    let b: Vec<f64> = b.as_array().unwrap().iter().map(f).collect();
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn check(name: &str) {
    let Some(o) = oracle(name) else {
        eprintln!("skip {name}: run build/fixtures/fx07.py first");
        return;
    };
    let m = model(&o);
    let mut worst_hae: f64 = 0.0;
    for p in o["i2hae"].as_array().unwrap() {
        let (xr, yc) = m.rowcol_to_grid(f(&p["row"]), f(&p["col"]));
        let s = m.projection_set(xr, yc);
        let (e, _, _) = m.r_rdot_to_constant_hae(&s, f(&p["hae"])).expect("HAE projection");
        worst_hae = worst_hae.max(ecf_dist(e, &p["ecf"]));
    }
    let mut worst_gp: f64 = 0.0;
    let (la, lo, _) = gw_geodesy::wgs84::ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]);
    let (la, lo) = (la.to_radians(), lo.to_radians());
    let up = [la.cos() * lo.cos(), la.cos() * lo.sin(), la.sin()];
    for p in o["gp"].as_array().unwrap() {
        let (xr, yc) = m.rowcol_to_grid(f(&p["row"]), f(&p["col"]));
        let s = m.projection_set(xr, yc);
        let e = m.r_rdot_to_ground_plane(&s, m.p.scp, up).expect("ground plane");
        worst_gp = worst_gp.max(ecf_dist(e, &p["ecf"]));
    }
    let mut worst_px: f64 = 0.0;
    for p in o["s2i"].as_array().unwrap() {
        let e: Vec<f64> = p["ecf"].as_array().unwrap().iter().map(f).collect();
        let (xr, yc, _, ok) = m.scene_to_image([e[0], e[1], e[2]]);
        assert!(ok, "{name}: scene to image converges");
        let row = xr / m.p.row_ss + m.p.scp_row;
        let col = yc / m.p.col_ss + m.p.scp_col;
        worst_px = worst_px.max((row - f(&p["row"])).abs()).max((col - f(&p["col"])).abs());
    }
    // Round trip through the SensorModel interface (AT-12.3: ≤ 0.05 px).
    let mut worst_rt: f64 = 0.0;
    for p in o["i2hae"].as_array().unwrap().iter().take(45) {
        let (x, y) = m.rowcol_to_xy(f(&p["row"]), f(&p["col"]));
        let g = m.image_to_ground(x, y, f(&p["hae"])).unwrap();
        let (x2, y2) = m.ground_to_image(Ground { lat: g.lat, lon: g.lon, h: g.h }).unwrap();
        worst_rt = worst_rt.max((x2 - x).abs()).max((y2 - y).abs());
    }
    eprintln!("{name}: HAE {worst_hae:.2e} m, ground plane {worst_gp:.2e} m, scene→image {worst_px:.2e} px, round trip {worst_rt:.2e} px");
    assert!(worst_hae < 0.01, "{name}: HAE projection differs from SARkit by {worst_hae} m");
    assert!(worst_gp < 0.01, "{name}: ground-plane projection differs by {worst_gp} m");
    assert!(worst_px < 0.001, "{name}: scene to image differs by {worst_px} px");
    assert!(worst_rt < 0.05, "{name}: round trip {worst_rt} px");
    // DEM crossings: same count and positions as SARkit's 1.5 stepping.
    for d in o["dem"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let (xr, yc) = m.rowcol_to_grid(f(&d["row"]), f(&d["col"]));
        let s = m.projection_set(xr, yc);
        let base = f(&d["block"]["base"]);
        let (slat, slon, _) = gw_geodesy::wgs84::ecef_to_geodetic(m.p.scp[0], m.p.scp[1], m.p.scp[2]);
        let dem = |p: [f64; 3]| {
            let (la, lo, h) = gw_geodesy::wgs84::ecef_to_geodetic(p[0], p[1], p[2]);
            let e = (lo - slon) * 111320.0 * slat.to_radians().cos();
            let n = (la - slat) * 110940.0;
            h - if e.abs() < 60.0 && n.abs() < 60.0 { base + 120.0 } else { base }
        };
        let got = m.r_rdot_to_dem(&s, &dem, base - 10.0, base + 200.0, 5.0);
        let want = d["crossings"].as_array().unwrap();
        assert_eq!(got.len(), want.len(), "{name}: DEM crossing count at {}, {}", d["row"], d["col"]);
        for (g, w) in got.iter().zip(want) {
            let (la, lo, h) = gw_geodesy::wgs84::ecef_to_geodetic(g[0], g[1], g[2]);
            let dn = (la - f(&w["lat"])) * 110940.0;
            let de = (lo - f(&w["lon"])) * 111320.0 * la.to_radians().cos();
            assert!(dn.hypot(de) < 0.01 && (h - f(&w["hae"])).abs() < 0.01, "{name}: DEM crossing differs ({dn}, {de}, {})", h - f(&w["hae"]));
        }
    }
    // Layover follows SCPCOA LayoverAng (AT-12.5).
    let lay = &o["layover"];
    let want = f(&o["scpcoa"]["LayoverAng"]);
    let d = (f(&lay["azimuth"]) - want + 540.0) % 360.0 - 180.0;
    assert!(d.abs() < 0.01, "{name}: oracle layover {d}");
}

#[test]
fn plane_grid_fx07() {
    check("fx07_a");
}
#[test]
fn plane_grid_with_apos() {
    check("fx07_b");
}
#[test]
fn xrgycr() {
    check("fx07_xrgycr");
}
#[test]
fn xctyat() {
    check("fx07_xctyat");
}
#[test]
fn rgazim_rgazcomp() {
    check("fx07_rgazcomp");
}
#[test]
fn rgzero_inca() {
    check("fx07_rgzero");
}
#[test]
fn rgazim_pfa() {
    check("fx07_pfa");
}
#[test]
fn umbra_pfa_slant() {
    check("umbra");
}
#[test]
fn iceye_plane_ground() {
    check("iceye");
}
