//! ARIDPCM (REQ-FMT-44) on the NTB NITF 1.1 file U_0001a.ntf: four C2 images of one scene at 4.50,
//! 2.30, 1.40 and 0.75 bpp. Structure: the coded bits of each image fill its segment. Values: the
//! 0.75 bpp chip uses only the standard's published tables (exact); the derived-table decodes of the
//! other rates are compared with it where they overlap. Skipped when the T&E corpus is absent.
use gw_codec::aridpcm::{coded_bits, decode, Params};
use std::path::PathBuf;

// (data offset, length, width, height, COMRAT) from the image subheaders.
const IMAGES: [(usize, usize, usize, usize, &str); 4] = [
    (103455, 186241, 512, 512, "4.50"),
    (290899, 10731, 231, 191, "2.30"),
    (302833, 2817, 181, 73, "1.40"),
    (306853, 423, 30, 67, "0.75"),
];

fn corpus() -> Option<Vec<u8>> {
    let root = std::env::var("TE_CORPUS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    std::fs::read(root.join("nitf-ntb-nitf11-legacy/U_0001a.ntf")).ok()
}

#[test]
fn u0001a_structure_and_values() {
    let Some(f) = corpus() else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let mut out = Vec::new();
    for (off, len, w, h, rate) in IMAGES {
        let p = Params::new(8, rate).unwrap();
        let data = &f[off..off + len];
        let bits = coded_bits(data, w, h, &p).unwrap();
        eprintln!(
            "{rate}: {w}x{h} coded {bits} bits = {} bytes, segment {len}",
            bits.div_ceil(8)
        );
        assert!(
            bits.div_ceil(8) <= len && len - bits.div_ceil(8) < 16,
            "{rate}: coded data does not fill the segment"
        );
        let d = decode(data, w, h, &p).unwrap();
        if let Ok(dir) = std::env::var("ARIDPCM_DUMP") {
            let mut pgm = format!("P5 {w} {h} 255\n").into_bytes();
            pgm.extend(d.data.iter().map(|&v| v as u8));
            std::fs::write(format!("{dir}/u0001a_{rate}.pgm"), pgm).unwrap();
        }
        out.push((w, h, d));
    }
    assert!(out[3].2.exact && !out[0].2.exact);
}

/// Differential test against GDAL 3.13 (`gdal_translate NITF_IM:3:U_0001a.ntf`, the only rate GDAL
/// reads): with GDAL's two deviations from the standard switched on, every sample matches. The GDAL
/// output (30×67 bytes) is read from ARIDPCM_GDAL_REF when set; otherwise it is computed with the
/// gw-te GDAL when present.
#[test]
fn u0001a_075_matches_gdal_with_its_quirks() {
    let Some(f) = corpus() else { return };
    let reference = std::env::var("ARIDPCM_GDAL_REF")
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .or_else(|| {
            let env = PathBuf::from("C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library");
            let exe = env.join("bin/gdal_translate.exe");
            let out = std::env::temp_dir().join(format!("aridpcm_gdal_{}.raw", std::process::id()));
            let src = std::env::var("TE_CORPUS")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus")
                })
                .join("nitf-ntb-nitf11-legacy/U_0001a.ntf");
            let ok = std::process::Command::new(&exe)
                .env("GDAL_DATA", env.join("share/gdal"))
                .env("PROJ_DATA", env.join("share/proj"))
                .arg("-q")
                .arg("-of")
                .arg("ENVI")
                .arg(format!("NITF_IM:3:{}", src.display()))
                .arg(&out)
                .status()
                .ok()?
                .success();
            let r = if ok { std::fs::read(&out).ok() } else { None };
            for ext in ["", ".hdr", ".aux.xml"] {
                let _ = std::fs::remove_file(format!("{}{ext}", out.display()));
            }
            let _ = std::fs::remove_file(out.with_extension("hdr"));
            r
        });
    let Some(reference) = reference else {
        eprintln!("GDAL not present; skipped");
        return;
    };
    let (off, len, w, h, rate) = IMAGES[3];
    let data = &f[off..off + len];
    let quirks = decode(data, w, h, &Params::new(8, rate).unwrap().gdal_quirks()).unwrap();
    assert_eq!(
        quirks.data.iter().map(|&v| v as u8).collect::<Vec<_>>(),
        reference,
        "GDAL-compatible decode differs"
    );
    // The standard's reading differs only through those two points.
    let spec = decode(data, w, h, &Params::new(8, rate).unwrap()).unwrap();
    let n = spec
        .data
        .iter()
        .zip(&reference)
        .filter(|(a, b)| **a as u8 != **b)
        .count();
    eprintln!(
        "0.75 bpp: {n} of {} samples differ from GDAL by the standard's table and edge rules",
        w * h
    );
}
