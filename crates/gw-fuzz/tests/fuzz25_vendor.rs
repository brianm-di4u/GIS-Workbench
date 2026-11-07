//! 2.5 fuzz targets (vendor group, REQ-GAP-20): the DigitalGlobe IMD/EPH/ATT/GEO reader and the
//! line scanner it builds, the Landsat ANG reader and its line-of-sight grid, and the Sentinel-2
//! MTD_TL reader and its grid, each through the map + line-of-sight model. Seeds are small
//! synthetic files with the corpus layouts (and the corpus files themselves when D: is there);
//! mutations must fail cleanly or run to the end, never panic or hang. Iterations: GW_FUZZ_ITERS
//! (default 1500 per target); --release.

use gw_fuzz::run;
use gw_sensor::ortholos::OrthoLos;
use gw_sensor::vendor::{dg, landsat, s2};
use gw_sensor::{Ground, SensorModel};
use std::path::Path;
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}
fn hang() -> Duration {
    Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000))
}

/// A small, self-consistent DG product: a 600 km circular polar orbit, a nadir camera.
fn dg_seed() -> Vec<u8> {
    let r0 = 6_378_137.0 + 600_000.0;
    let w = 7560.0 / r0;
    let mut eph = String::from("satId = \"WV03\";\nstartTime = 2015-01-01T00:00:00.000000Z;\nnumPoints = 30;\ntimeInterval = 1.0;\nephemList = (\n");
    let mut att = String::from("satId = \"WV03\";\nstartTime = 2015-01-01T00:00:00.000000Z;\nnumPoints = 30;\ntimeInterval = 1.0;\nattList = (\n");
    for k in 0..30 {
        let a = w * (k as f64 - 15.0);
        let (x, z) = (r0 * a.cos(), r0 * a.sin());
        eph.push_str(&format!("({}, {x:.4}, 0.0, {z:.4}, {:.4}, 0.0, {:.4}, 0.01, 0, 0, 0.01, 0, 0.01){}\n", k + 1, -7560.0 * a.sin(), 7560.0 * a.cos(), if k < 29 { "," } else { ");" }));
        // Camera z toward the geocentre, x along track: a rotation about y by −(90° + a).
        let t = -(std::f64::consts::FRAC_PI_2 + a) / 2.0;
        att.push_str(&format!("({}, 0.0, {:.12}, 0.0, {:.12}, 1e-11, 0, 0, 0, 1e-11, 0, 0, 1e-11, 0, 1e-11){}\n", k + 1, t.sin(), t.cos(), if k < 29 { "," } else { ");" }));
    }
    let imd = "version = \"28.3\";\nnumRows = 2000;\nnumColumns = 3000;\nBEGIN_GROUP = IMAGE_1\n\tfirstLineTime = 2015-01-01T00:00:14.000000Z;\n\tavgLineRate = 1000.00;\n\tTLCTime = 2015-01-01T00:00:14.000000Z;\n\tnumTLC = 2;\n\tTLCList = (\n\t(0, 0.000000),\n\t(2000, 2.000000));\nEND_GROUP = IMAGE_1\nEND;";
    let geo = "effectiveTime = 2014-08-01T00:00:00.000000Z;\nBEGIN_GROUP = PRINCIPAL_DISTANCE\n\tPD = 16000.0;\nEND_GROUP = PRINCIPAL_DISTANCE\nBEGIN_GROUP = OPTICAL_DISTORTION\n\tpolyOrder = -1;\nEND_GROUP = OPTICAL_DISTORTION\nBEGIN_GROUP = CAMERA_ATTITUDE\n\tqcs1 = 0.0;\n\tqcs2 = 0.0;\n\tqcs3 = 0.0;\n\tqcs4 = 1.0;\nEND_GROUP = CAMERA_ATTITUDE\nBEGIN_GROUP = DETECTOR_MOUNTING\n\tBEGIN_GROUP = BAND_P\n\t\tBEGIN_GROUP = DETECTOR_ARRAY_1\n\t\t\tdetOriginX = 0.0;\n\t\t\tdetOriginY = 12.0;\n\t\t\tdetRotAngle = 0.0;\n\t\t\tdetPitch = 0.008;\n\t\tEND_GROUP = DETECTOR_ARRAY_1\n\tEND_GROUP = BAND_P\nEND_GROUP = DETECTOR_MOUNTING\nEND;";
    [imd, &eph, &att, geo].join("\0").into_bytes()
}

fn ang_seed() -> Vec<u8> {
    let mut s = String::from("GROUP = FILE_HEADER\n  SPACECRAFT_ID = \"LANDSAT_8\"\nEND_GROUP = FILE_HEADER\nGROUP = PROJECTION\n  MAP_PROJECTION = \"UTM\"\n  UTM_ZONE = 10\n  UL_CORNER = ( 462900.000,  4264500.000)\nEND_GROUP = PROJECTION\nGROUP = EPHEMERIS\n  EPHEMERIS_TIME = (0.0, 1.0)\n  EPHEMERIS_ECEF_X = (1.0, 2.0)\n  EPHEMERIS_ECEF_Y = (1.0, 2.0)\n  EPHEMERIS_ECEF_Z = (1.0, 2.0)\nEND_GROUP = EPHEMERIS\nGROUP = RPC_BAND04\n");
    s.push_str("  BAND04_NUMBER_OF_SCAS = 2\n  BAND04_NUM_L1T_LINES = 400\n  BAND04_NUM_L1T_SAMPS = 300\n  BAND04_NUM_L1R_LINES = 420\n  BAND04_NUM_L1R_SAMPS = 160\n  BAND04_PIXEL_SIZE = 30.000\n  BAND04_MEAN_HEIGHT = 1000.000\n  BAND04_MEAN_L1R_LINE_SAMP = (200.0, 160.0)\n  BAND04_MEAN_L1T_LINE_SAMP = (200.0, 150.0)\n  BAND04_MEAN_SAT_VECTOR = (0.0, 0.0, 0.996)\n");
    for c in ["X", "Y", "Z"] {
        s.push_str(&format!("  BAND04_SAT_{c}_NUM_COEF = (1e-4, 1e-6, {}, 0, 0, 0, 0, 0, 0, 0)\n  BAND04_SAT_{c}_DEN_COEF = (0, 0, 0, 0, 0, 0, 0, 0, 0)\n", if c == "X" { "4e-5" } else { "0" }));
    }
    for k in 1..=2 {
        s.push_str(&format!("  BAND04_SCA{k:02}_MEAN_HEIGHT = 1000.000\n  BAND04_SCA{k:02}_MEAN_L1R_LINE_SAMP = (200.0, 80.0)\n  BAND04_SCA{k:02}_MEAN_L1T_LINE_SAMP = (200.0, {}.0)\n  BAND04_SCA{k:02}_LINE_NUM_COEF = (0, 1, 0, 0, 0)\n  BAND04_SCA{k:02}_LINE_DEN_COEF = (0, 0, 0, 0)\n  BAND04_SCA{k:02}_SAMP_NUM_COEF = (0, 0, 1, -0.004, 0)\n  BAND04_SCA{k:02}_SAMP_DEN_COEF = (0, 0, 0, 0)\n", 75 + 150 * (k - 1)));
    }
    s.push_str("END_GROUP = RPC_BAND04\nEND\n");
    s.into_bytes()
}

fn s2_seed() -> Vec<u8> {
    let grid = |z0: f64| -> String {
        let rows: Vec<String> = (0..4).map(|j| (0..4).map(|i| format!("{:.3}", z0 + 0.1 * i as f64 + 0.01 * j as f64)).collect::<Vec<_>>().join(" ")).collect();
        format!("<COL_STEP unit=\"m\">5000</COL_STEP><ROW_STEP unit=\"m\">5000</ROW_STEP><Values_List>{}</Values_List>", rows.iter().map(|r| format!("<VALUES>{r}</VALUES>")).collect::<String>())
    };
    format!("<Tile_Geocoding><HORIZONTAL_CS_CODE>EPSG:32610</HORIZONTAL_CS_CODE><Size resolution=\"10\"><NROWS>1500</NROWS><NCOLS>1500</NCOLS></Size><Geoposition resolution=\"10\"><ULX>499980</ULX><ULY>4300020</ULY></Geoposition></Tile_Geocoding><Viewing_Incidence_Angles_Grids bandId=\"3\" detectorId=\"1\"><Zenith>{}</Zenith><Azimuth>{}</Azimuth></Viewing_Incidence_Angles_Grids><Viewing_Incidence_Angles_Grids bandId=\"3\" detectorId=\"2\"><Zenith>{}</Zenith><Azimuth>{}</Azimuth></Viewing_Incidence_Angles_Grids>", grid(5.0), grid(100.0), grid(5.5), grid(280.0)).into_bytes()
}

fn probe(m: &dyn SensorModel, w: f64, h: f64) {
    for (x, y) in [(0.5, 0.5), (w * 0.5, h * 0.5), (w - 0.5, h - 0.5)] {
        if let Ok(g) = m.image_to_ground(x, y, 200.0) {
            let _ = m.ground_to_image(g);
            let _ = m.ground_to_image(Ground { h: 2500.0, ..g });
        }
    }
}

#[test]
fn fuzz_vendor25() {
    let n = iters();
    let o = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes");
    let mut dg_seeds = vec![dg_seed()];
    let wv = Path::new("D:/TE-corpus/eo-spacenet-atlanta-wv2-l1b-rpc/nadir52_BDDC00_MUL/09DEC22163912-M1BS-058332896010_01_P005");
    if let (Ok(a), Ok(b), Ok(c), Ok(d)) = (std::fs::read_to_string(wv.with_extension("IMD")), std::fs::read_to_string(wv.with_extension("EPH")), std::fs::read_to_string(wv.with_extension("ATT")), std::fs::read_to_string(wv.with_extension("GEO"))) {
        // Trimmed: the first 60 ephemeris and attitude records keep the seed small.
        let cut = |s: &str, key: &str| -> String {
            let i = s.find(key).unwrap_or(0);
            let mut lines: Vec<&str> = s[i..].lines().take(62).collect();
            if let Some(l) = lines.last_mut() {
                *l = l.trim_end_matches(',');
            }
            format!("{}{});\nEND;", &s[..i], lines.join("\n"))
        };
        dg_seeds.push([a, cut(&b, "ephemList"), cut(&c, "attList"), d].join("\0").into_bytes());
    }
    let mut reports = Vec::new();
    reports.push(run("vendor_dg", &dg_seeds, n, hang(), &o, |b| {
        let t = String::from_utf8_lossy(b);
        let p: Vec<&str> = t.split('\0').collect();
        if p.len() != 4 {
            return;
        }
        if let Ok(m) = dg::dg_model(&dg::DgFiles { imd: p[0], eph: p[1], att: p[2], geo: p[3] }, 0) {
            probe(&m.model, m.model.cols, m.model.rows);
            let _ = gw_sensor::linescan::LineScanner::from_record(&m.model.to_record(), "x");
        }
        let _ = dg::rpb_record(p[0]);
        let _ = dg::til_offset(p[1], "x.tif");
    }));
    let mut ang_seeds = vec![ang_seed()];
    if let Ok(a) = std::fs::read("D:/TE-corpus/landsat8-c2-l1tp-044034-20240820-tierb/LC08_L1TP_044034_20240820_20240830_02_T1_ANG.txt") {
        ang_seeds.push(a);
    }
    reports.push(run("vendor_ang", &ang_seeds, n, hang(), &o, |b| {
        let t = String::from_utf8_lossy(b);
        if let Ok(a) = landsat::Ang::parse(&t) {
            for band in a.bands.iter().map(|b| b.band).take(2).collect::<Vec<_>>() {
                if let Ok(r) = landsat::ortholos_record(&a, band, 256.0, 0.0) {
                    if let Ok(m) = OrthoLos::from_record(&r, "x") {
                        probe(&m, 1000.0, 1000.0);
                    }
                }
            }
        }
        let _ = landsat::parse_mtl(&t);
    }));
    reports.push(run("vendor_s2", &[s2_seed()], n, hang(), &o, |b| {
        let t = String::from_utf8_lossy(b);
        if let Ok(g) = s2::parse_mtd_tl(&t) {
            if let Ok(r) = s2::ortholos_record(&g, 3, 0.0) {
                if let Ok(m) = OrthoLos::from_record(&r, "x") {
                    probe(&m, 1500.0, 1500.0);
                }
            }
        }
        let _ = s2::ds_ephemeris(&t, 0);
    }));
    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("{}: {} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped, "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{} {}: {m}", r.target, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
