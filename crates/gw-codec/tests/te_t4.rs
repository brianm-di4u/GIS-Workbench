//! TE-020 regression: T.4 two-dimensional (Modified READ) blocks of the JITC NITF conformance
//! files decode, and the white fraction matches GDAL's statistics of the same image
//! (U_1050a: 1024², GDAL mean 0.49951). Skipped when TE-corpus is not present.

use std::path::PathBuf;

fn corpus(rel: &str) -> Option<Vec<u8>> {
    let root = std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"));
    std::fs::read(root.join(rel)).ok()
}

fn num_after(json: &str, key: &str) -> Option<u64> {
    let i = json.find(&format!("\"{key}\":"))? + key.len() + 3;
    json[i..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

#[test]
fn te020_jitc_u1050a_two_dimensional_t4_matches_gdal() {
    let Some(b) = corpus("nitf-ntb-nitf20-conformance/U_1050a.ntf") else {
        eprintln!("TE-corpus not present; skipped");
        return;
    };
    let fh = gw_parse::nitf::file_header(&b, b.len() as u64).unwrap();
    let seg = &fh[fh.find("\"segments\"").unwrap()..];
    let off = num_after(seg, "dataOffset").unwrap() as usize;
    let len = num_after(seg, "dataLength").unwrap() as usize;
    let px = gw_codec::t4::decode(&b[off..off + len], 1024, 1024, "2DS").expect("2-D T.4 decodes");
    let white = px.iter().map(|&v| f64::from(v)).sum::<f64>() / px.len() as f64;
    eprintln!("U_1050a white fraction {white:.5} (GDAL mean 0.49951)");
    assert!((white - 0.49951).abs() < 0.002 || (1.0 - white - 0.49951).abs() < 0.002, "white fraction {white}");
}
