//! REQ-FMT-16 (parse layer): every NITF/NSIF sample in Research/samples parses its file
//! header and every image subheader, or is refused with a clear error, without panicking.

use std::path::{Path, PathBuf};

fn samples() -> Vec<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../Research/samples");
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(&root) else { return out };
    for d in dirs.flatten() {
        if let Ok(files) = std::fs::read_dir(d.path()) {
            for f in files.flatten() {
                let p = f.path();
                let name = p.file_name().unwrap().to_string_lossy().to_lowercase();
                if name.ends_with(".ntf") || name.ends_with(".nsf") || name.ends_with(".nitf") || name.contains(".ntf.r") {
                    out.push(p);
                }
            }
        }
    }
    out.sort();
    out
}

fn num(j: &str, key: &str, from: usize) -> Option<(u64, usize)> {
    let pat = format!("\"{key}\":");
    let i = j[from..].find(&pat)? + from + pat.len();
    let end = j[i..].find(|c: char| !c.is_ascii_digit())? + i;
    Some((j[i..end].parse().ok()?, end))
}

#[test]
fn every_nitf_sample_parses() {
    let files = samples();
    if files.is_empty() {
        return; // samples not present (CI without the research corpus)
    }
    let mut images = 0;
    for p in &files {
        let b = std::fs::read(p).unwrap();
        let hdr = gw_parse::nitf::file_header(&b, b.len() as u64).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        let v21 = !hdr.contains("\"version\":\"02.00\"");
        // Walk image segments.
        let mut pos = 0;
        while let Some(k) = hdr[pos..].find("\"kind\":\"") {
            let start = pos + k + 8;
            let kind_end = hdr[start..].find('"').unwrap() + start;
            let kind = &hdr[start..kind_end];
            let (sho, e1) = num(&hdr, "subheaderOffset", kind_end).unwrap();
            let (shl, e2) = num(&hdr, "subheaderLength", e1).unwrap();
            pos = e2;
            let (sho, shl) = (sho as usize, shl as usize);
            if sho + shl > b.len() {
                continue; // truncated sample; header parse already warned
            }
            let sh = &b[sho..sho + shl];
            if kind == "image" {
                let j = gw_parse::nitf::image_subheader(sh, sho as u64, v21).unwrap_or_else(|e| panic!("{} image @{sho}: {e}", p.display()));
                assert!(j.contains("\"NROWS\""), "{}", p.display());
                images += 1;
            } else {
                gw_parse::nitf::other_subheader(kind, sh, v21).unwrap_or_else(|e| panic!("{} {kind} @{sho}: {e}", p.display()));
            }
        }
    }
    assert!(images >= 20, "only {images} image segments parsed from {} files", files.len());
}

#[test]
fn truncation_and_mutation_never_panic() {
    // A cheap stand-in for fuzzing in unit CI: truncate and flip bytes of each header.
    for p in samples().iter().take(12) {
        let b = std::fs::read(p).unwrap();
        let n = b.len().min(4096);
        for cut in (0..n).step_by(97) {
            let _ = gw_parse::nitf::file_header(&b[..cut], b.len() as u64);
        }
        let mut m = b[..n].to_vec();
        for i in (0..n).step_by(13) {
            m[i] = m[i].wrapping_add(17);
            let _ = gw_parse::nitf::file_header(&m, b.len() as u64);
            let _ = gw_parse::nitf::image_subheader(&m, 0, true);
        }
    }
}
