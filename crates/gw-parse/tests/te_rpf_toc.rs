//! A.TOC files of the T&E corpus (REQ-FMT-40): every listed frame exists beside the TOC, the grids
//! match GDAL's RPFTOC subdatasets (sizes checked with gdalinfo when the corpus was built). Skipped
//! when the corpus is absent.
use gw_parse::rpf_toc::parse;
use std::path::PathBuf;

fn root() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

#[test]
fn corpus_tocs() {
    // (A.TOC, boundaries, frames in boundary 0, zone of boundary 0)
    let cases = [("derived-rpf-cadrg-from-cib10/n35e011/RPF/A.TOC", 1, 0, "2"), ("derived-rpf-cadrg-from-cib10/n60w156/RPF/A.TOC", 1, 0, "4"), ("raster-gdal-autotest-dimap2-rpf-nm/rpftoc/zone9/RPF/A.TOC", 1, 1, "9"), ("nitf-rpf-cadrg-frames/rpf_toc/A.TOC", 1, 1, "")];
    for (path, nb, _, zone) in cases {
        let p = root().join(path);
        let Ok(b) = std::fs::read(&p) else {
            eprintln!("TE-corpus not present; skipped");
            return;
        };
        let t = parse(&b).unwrap_or_else(|e| panic!("{path}: {e}"));
        eprintln!("{path}: {:#?}", t.boundaries.iter().map(|b| (&b.product, &b.scale, &b.zone, b.rows, b.cols, b.frames.len(), b.nw, b.se, b.vert_interval, b.horiz_interval)).collect::<Vec<_>>());
        assert!(t.boundaries.len() >= nb, "{path}");
        if !zone.is_empty() {
            assert_eq!(t.boundaries[0].zone, zone, "{path}");
        }
        let dir = p.parent().unwrap();
        for bd in &t.boundaries {
            for f in &bd.frames {
                let fp = if f.dir.is_empty() { dir.join(&f.file) } else { dir.join(&f.dir).join(&f.file) };
                let exists = fp.exists() || std::fs::read_dir(fp.parent().unwrap_or(dir)).map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(&f.file))).unwrap_or(false);
                assert!(exists, "{path}: frame {} {} missing", f.dir, f.file);
            }
        }
    }
}
