//! MrSID and ECW footprint headers on the T&E corpus (REQ-FMT-22). Georeferencing is checked against
//! GDAL's own autotest expectations (autotest/gdrivers/ecw.py, mrsid.py) and the .sdw world files of the
//! field mosaics. Skipped when the corpus is absent; the field files (tier U) only when present.
use gw_parse::footprint::{ecw, mrsid};
use std::io::Read;
use std::path::PathBuf;

fn head(p: &PathBuf, n: usize) -> Option<Vec<u8>> {
    let mut f = std::fs::File::open(p).ok()?;
    let mut b = vec![0u8; n];
    let k = f.read(&mut b).ok()?;
    b.truncate(k);
    Some(b)
}

fn root() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

#[test]
fn corpus_mrsid() {
    // (file, width, height, origin x, origin y, pixel, epsg)
    let cases = [
        ("raster-mrsid-gdal-samples/lossless-mg3/utm11-27.sid", 512, 512, 440720.0, 3751320.0, 60.0, Some(26711)),
        ("raster-mrsid-gdal-samples/lossy-mg2/utm11-27.sid", 512, 512, 440720.0, 3751320.0, 60.0, Some(26711)),
        ("raster-mrsid-gdal-samples/lossy-mg3/mercator.sid", 515, 515, f64::NAN, f64::NAN, 60.0, None),
        ("raster-mrsid-gdal-samples/lossy-mg3/laea.sid", 513, 516, f64::NAN, f64::NAN, f64::NAN, None),
        ("raster-mrsid-gdal-samples/autotest/mercator_new.sid", 515, 515, -15436.385771224039, 3321987.8617962394, 60.0, None),
    ];
    for (path, w, h, ox, oy, px, epsg) in cases {
        let Some(b) = head(&root().join(path), 1 << 18) else {
            eprintln!("TE-corpus not present; skipped");
            return;
        };
        let f = mrsid(&b).unwrap_or_else(|e| panic!("{path}: {e}"));
        eprintln!("{path}: {} {}×{}×{} {}-bit {:?}", f.version, f.width, f.height, f.bands, f.bits, f.georef.as_ref().map(|g| (g.gt, g.epsg, &g.source)));
        if w > 0 {
            assert_eq!((f.width, f.height), (w, h), "{path}");
        }
        let g = f.georef.as_ref().unwrap_or_else(|| panic!("{path}: no georeferencing"));
        if ox.is_finite() {
            assert!((g.gt[0] - ox).abs() < 1e-6 && (g.gt[3] - oy).abs() < 1e-6, "{path}: origin {:?}", g.gt);
        }
        if px.is_finite() {
            assert!((g.gt[1] - px).abs() < 1e-9 && (g.gt[5] + px).abs() < 1e-9, "{path}");
        }
        if epsg.is_some() {
            assert_eq!(g.epsg, epsg, "{path}");
        }
        assert!(g.epsg.is_some() || g.wkt.is_some(), "{path}: no CRS");
        if path.contains("lossy-mg3") {
            assert!(g.wkt.as_deref().unwrap_or("").contains(if path.contains("laea") { "+proj=laea" } else { "+proj=merc" }), "{path}: {:?}", g.wkt);
        }
    }
}

#[test]
fn corpus_ecw() {
    // GDAL autotest ecw.py: jrc 467498.5 / 5077883.2825 / 16.5475 (RAW CRS); spif83 test_ecw_23 geotransform.
    let Some(b) = head(&root().join("raster-ecw-negatives-gdal/jrc.ecw"), 4096) else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let f = ecw(&b).unwrap();
    let g = f.georef.unwrap();
    assert_eq!((f.width, f.height, f.bands), (400, 400, 3));
    assert!((g.gt[0] - 467498.5).abs() < 0.1 && (g.gt[3] - 5077883.2825).abs() < 0.1 && (g.gt[1] - 16.5475).abs() < 1e-3 && (g.gt[5] + 16.5475).abs() < 1e-3);
    let f = ecw(&head(&root().join("raster-ecw-negatives-gdal/spif83.ecw"), 4096).unwrap()).unwrap();
    assert_eq!(f.georef.unwrap().gt, [6138559.5576418638, 195.5116973254697, 0.0, 2274798.7836679211, 0.0, -198.32414964918371]);
    let f = ecw(&head(&root().join("raster-ecw-negatives-gdal/sandiego2m_null.ecw"), 4096).unwrap()).unwrap();
    assert_eq!(f.georef.unwrap().epsg, Some(26911));
    for name in ["red_flower.ecw", "stefan_full_rgba_ecwv3_meta.ecw"] {
        let f = ecw(&head(&root().join("raster-ecw-negatives-gdal").join(name), 1 << 16).unwrap()).unwrap();
        eprintln!("{name}: {} {}×{}×{} {:?}", f.version, f.width, f.height, f.bands, f.georef);
        assert!(f.width > 0 && f.height > 0 && f.bands > 0);
    }
}

#[test]
fn field_mosaics_match_their_world_files() {
    let base = PathBuf::from("C:/GIS Workbench/Research/Additional Data Samples");
    for (dir, name) in [("Hamilton_2018_rgb_20x-002", "Hamilton_2018_rgb_20x"), ("StLouisCity-003", "Stl_City")] {
        let sid = base.join(dir).join(format!("{name}.sid"));
        let Some(b) = head(&sid, 1 << 18) else { continue };
        let f = mrsid(&b).unwrap();
        let sdw: Vec<f64> = std::fs::read_to_string(base.join(dir).join(format!("{name}.sdw"))).unwrap().split_whitespace().map(|v| v.parse().unwrap()).collect();
        let g = f.georef.unwrap();
        eprintln!("{name}: {} {}×{}×{} {:?} epsg {:?}", f.version, f.width, f.height, f.bands, g.gt, g.epsg);
        // World file: pixel-centre origin; the geotransform uses the corner.
        assert!((g.gt[0] - (sdw[4] - sdw[0] / 2.0)).abs() < 1e-6 && (g.gt[3] - (sdw[5] - sdw[3] / 2.0)).abs() < 1e-6 && (g.gt[1] - sdw[0]).abs() < 1e-12);
    }
}
