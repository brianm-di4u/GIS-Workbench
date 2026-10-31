//! NITF 1.1 (JITC conformance files U_0001a…U_0005a in the TE corpus, when present): the file
//! header and every image subheader parse with the NITF 2.0 layout, with a "NITF 1.1" warning;
//! U_0001a's first four images are ARIDPCM (IC=C2), as the census's own 1.1 reader found.

use gw_parse::nitf;

fn segs(hdr: &str) -> Vec<(u64, u64, String)> {
    // (subheaderOffset, subheaderLength, kind) from the JSON without a JSON crate.
    let mut out = Vec::new();
    for part in hdr.split("{\"kind\":\"").skip(1) {
        let kind = part.split('"').next().unwrap().to_string();
        let num = |k: &str| -> u64 { part.split(&format!("\"{k}\":")).nth(1).unwrap().split(|c: char| !c.is_ascii_digit()).next().unwrap().parse().unwrap() };
        out.push((num("subheaderOffset"), num("subheaderLength"), kind));
    }
    out
}

#[test]
fn nitf11_conformance_files_parse() {
    let dir = std::path::Path::new("C:/GIS Workbench/TE-corpus/nitf-ntb-nitf11-legacy");
    if !dir.exists() {
        return;
    }
    for name in ["U_0001a.ntf", "U_0001b.ntf", "U_0001c.ntf", "U_0002a.ntf", "U_0004a.ntf", "U_0005a.ntf"] {
        let b = std::fs::read(dir.join(name)).unwrap();
        let hdr = nitf::file_header(&b, b.len() as u64).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert!(hdr.contains("\"version\":\"01.10\""), "{name}");
        assert!(hdr.contains("NITF 1.1: read with the NITF 2.0 layout"), "{name}");
        let mut ics = Vec::new();
        for (o, l, kind) in segs(&hdr).into_iter().filter(|s| s.2 == "image") {
            let sh = &b[o as usize..(o + l) as usize];
            let j = nitf::image_subheader_v(sh, o, 2).unwrap_or_else(|e| panic!("{name} {kind} at {o}: {e:?}"));
            assert!(!j.contains("\"NROWS\":0,") && !j.contains("\"NCOLS\":0,"), "{name}: size from the blocks: {j}");
            ics.push(j.split("\"IC\":\"").nth(1).unwrap()[..2].to_string());
        }
        if name == "U_0001a.ntf" {
            assert_eq!(&ics[..4], ["C2", "C2", "C2", "C2"]);
        }
        // U_0002a is a header alone and U_0004a holds symbols only.
        assert_eq!(ics.is_empty(), matches!(name, "U_0002a.ntf" | "U_0004a.ntf"), "{name}: image segments");
    }
}
