//! REQ-RUST-07, REQ-SEC-02: fuzz every parser of untrusted input that exists in this release (NITF file
//! and segment headers, TREs, mask tables, pixel unpacking, DTED/HGT, JPEG, JPEG 2000, HTJ2K, VQ and
//! RPF tables, T.4), LAS/LAZ, SICD/SIDD XML, MPEG-TS, KLV (ST 0601/0102). Iterations: GW_FUZZ_ITERS (default 1500 per target); run with --release.

use gw_fuzz::run;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[path = "../../test-support/research.rs"]
mod research;

fn root() -> PathBuf {
    research::samples()
}

fn files(pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for d in std::fs::read_dir(root()).into_iter().flatten().flatten() {
        for f in std::fs::read_dir(d.path()).into_iter().flatten().flatten() {
            let n = f.file_name().to_string_lossy().to_lowercase();
            if pred(&n) && f.metadata().map(|m| m.len() < 4 << 20).unwrap_or(false) {
                out.push(f.path());
            }
        }
    }
    out.sort();
    out
}

/// The fixtures in this repository whose lower-case name passes `pred`. A CI runner has these and no
/// Research samples, so each target takes seeds from here as well: with none it ran nothing and passed.
fn fixtures(pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    fn walk(d: &Path, pred: &dyn Fn(&str) -> bool, out: &mut Vec<PathBuf>) {
        for f in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = f.path();
            if p.is_dir() {
                walk(&p, pred, out);
            } else if pred(&f.file_name().to_string_lossy().to_lowercase()) {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    walk(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures"), &pred, &mut out);
    out.sort();
    out
}

/// The first `max` bytes of a file.
fn head(p: &Path, max: usize) -> Vec<u8> {
    use std::io::Read;
    let mut b = Vec::new();
    std::fs::File::open(p).unwrap().take(max as u64).read_to_end(&mut b).unwrap();
    b
}

fn is_nitf(n: &str) -> bool {
    n.ends_with(".ntf") || n.ends_with(".nsf") || n.ends_with(".nitf")
}

fn is_dem(n: &str) -> bool {
    n.ends_with(".dt0") || n.ends_with(".dt1") || n.ends_with(".dt2") || n.ends_with(".hgt")
}

/// A 16 × 16 cell cut from the start of a DTED file: its three header records with the counts
/// rewritten, and the first 16 posts of its first 16 data records, each with its checksum. A whole
/// cell is 26 MB, and its first part alone fails the length check before a data record is read.
fn small_dted(b: &[u8]) -> Option<Vec<u8>> {
    const N: usize = 16;
    let nrows: usize = std::str::from_utf8(b.get(51..55)?).ok()?.trim().parse().ok()?;
    let rec_len = 8 + 2 * nrows + 4;
    let mut out = b.get(..3428)?.to_vec();
    out[47..55].copy_from_slice(b"00160016");
    for c in 0..N {
        let rec = b.get(3428 + c * rec_len..)?.get(..8 + 2 * N)?;
        out.extend_from_slice(rec);
        out.extend_from_slice(&rec.iter().map(|&x| u32::from(x)).sum::<u32>().to_be_bytes());
    }
    Some(out)
}

/// A 400-point LAZ file from the app's own writer. The chunk table is at the end of a LAZ file, so
/// it is only inside a seed that holds the whole file, and the fixtures are 9 MB and more (#317).
fn small_laz() -> Vec<u8> {
    use gw_pointcloud::decode::{Columns, Lattice};
    use gw_pointcloud::write::{write, WriteSpec};
    let n = 400;
    let mut c = Columns::with_capacity(n, false);
    for k in 0..n {
        let f = k as f32;
        c.pos.extend([(f * 0.37) % 90.0, (f * 0.91) % 70.0, 100.0 + (f * 0.013).sin() * 20.0]);
        c.time.push(f * 0.001);
        c.intensity.push((k % 4096) as u16);
        c.source.push(7);
        c.scan.push((k % 90) as i16);
        c.class.push([1u8, 2, 5, 6][k % 4]);
        c.ret.push(0x11);
        c.flags.push(0);
        c.user.push(0);
    }
    c.n = n;
    let inv = Lattice { x0: 0.0, y0: 0.0, dx: 1000.0, dy: 1000.0, nx: 2, ny: 2, nodes: vec![[500000.0, 4000000.0, 0.0], [501000.0, 4000000.0, 0.0], [500000.0, 4001000.0, 0.0], [501000.0, 4001000.0, 0.0]], v_unit: 1.0 };
    let s = WriteSpec { format: 6, scale: [0.001; 3], wkt: "LOCAL_CS[\"fuzz\"]".into(), system_id: "GIS Workbench".into(), software: "fuzz".into(), day: 1, year: 2026, adjusted_gps: true, t0: 0.0, compress: true };
    write(&c, &inv, &s).expect("the writer's own LAZ")
}

/// The LAS/LAZ header, its VLRs and the LAZ chunk table. True when a chunk table was read.
fn las_path(b: &[u8]) -> bool {
    let mut read = false;
    if let Ok(h) = gw_pointcloud::las::header(b) {
        if let Ok(v) = gw_pointcloud::las::vlrs(b, &h) {
            for x in &v {
                let d = b.get(x.data_offset as usize..(x.data_offset + x.data_len) as usize).unwrap_or(&[]);
                if x.user_id == "laszip encoded" {
                    if let Ok(z) = gw_pointcloud::laz::vlr(d) {
                        read |= gw_pointcloud::laz::chunk_table(&b[(h.point_offset as usize).min(b.len())..], &z, h.n_points).is_ok();
                    }
                }
            }
        }
    }
    read
}

fn is_las(n: &str) -> bool {
    n.ends_with(".las") || n.ends_with(".laz")
}

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

fn find(d: &[u8], pat: &[u8]) -> Option<usize> {
    d.windows(pat.len()).position(|w| w == pat)
}

fn num(j: &str, key: &str, from: usize) -> Option<(u64, usize)> {
    let pat = format!("\"{key}\":");
    let i = j[from..].find(&pat)? + from + pat.len();
    let end = j[i..].find(|c: char| !c.is_ascii_digit())? + i;
    Some((j[i..end].parse().ok()?, end))
}

/// The worker's parse path for a NITF prefix: header → each subheader → mask table.
fn nitf_path(b: &[u8]) {
    let Ok(hdr) = gw_parse::nitf::file_header(b, b.len() as u64) else { return };
    let v21 = !hdr.contains("\"version\":\"02.00\"");
    let mut pos = 0;
    while let Some(k) = hdr[pos..].find("\"kind\":\"") {
        let start = pos + k + 8;
        let Some(ke) = hdr[start..].find('"') else { break };
        let kind = hdr[start..start + ke].to_string();
        let Some((sho, e1)) = num(&hdr, "subheaderOffset", start) else { break };
        let Some((shl, e2)) = num(&hdr, "subheaderLength", e1) else { break };
        pos = e2;
        let (sho, shl) = (sho as usize, shl as usize);
        if sho.saturating_add(shl) > b.len() {
            continue;
        }
        let sh = &b[sho..sho + shl];
        if kind == "image" {
            if let Ok(j) = gw_parse::nitf::image_subheader(sh, sho as u64, v21) {
                let data = &b[(sho + shl).min(b.len())..];
                for nbpp in [1u32, 8, 12, 16] {
                    let _ = gw_parse::nitf::mask_table(data, 4 + (j.len() % 64), nbpp);
                }
            }
        } else {
            let _ = gw_parse::nitf::other_subheader(&kind, sh, v21);
        }
    }
}

#[test]
fn fuzz_all_parsers() {
    let n = iters();
    let hang = Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000));
    let o = out();
    let mut reports = Vec::new();

    let nitf: Vec<Vec<u8>> = files(is_nitf).iter().chain(fixtures(is_nitf).iter()).map(|p| head(p, 256 << 10)).collect();
    reports.push(run("nitf", &nitf, n, hang, &o, nitf_path));

    let mut tres: Vec<Vec<u8>> = Vec::new();
    for tag in [&b"RPC00B"[..], b"ICHIPB", b"USE00A", b"STDIDC", b"PIAIMC", b"CSEXRA", b"SENSRB", b"RPFIMG", b"J2KLRA", b"NBLOCA"] {
        for b in &nitf {
            if let Some(i) = find(b, tag) {
                tres.push(b[i..(i + 2048).min(b.len())].to_vec());
            }
        }
    }
    reports.push(run("tre", &tres, n, hang, &o, |b| {
        if let Ok(list) = gw_parse::tre::split(b, 0) {
            for t in list {
                let _ = gw_parse::tre::decode(&t.tag, t.data);
            }
        }
        let tag = std::str::from_utf8(&b[..b.len().min(6)]).unwrap_or("RPC00B");
        let _ = gw_parse::tre::decode(tag, b.get(11..).unwrap_or(&[]));
    }));

    let mut dem: Vec<Vec<u8>> = files(is_dem).iter().map(|p| std::fs::read(p).unwrap()).collect();
    dem.extend(fixtures(is_dem).iter().filter_map(|p| small_dted(&head(p, 256 << 10))));
    assert!(dem.iter().any(|b| gw_parse::dted::parse_dted(b).is_ok_and(|d| d.json.contains("\"checksumErrors\":0"))), "dted: no seed parses, so no data record is read");
    // An HGT grid has no header: only its size says what it is, and the smallest is 601 posts a side (#317).
    dem.push((0..601 * 601 * 2).map(|k| (k % 7) as u8).collect());
    assert!(dem.iter().any(|b| gw_parse::dted::parse_hgt(b, -35.0, -59.0).is_ok()), "dted: no seed is a whole HGT grid");
    reports.push(run("dted", &dem, n, hang, &o, |b| {
        let _ = gw_parse::dted::parse_dted(b);
        let _ = gw_parse::dted::parse_hgt(b, -35.0, -59.0);
    }));

    let small: Vec<Vec<u8>> = nitf.iter().map(|b| b[b.len().saturating_sub(16 << 10)..].to_vec()).collect();
    reports.push(run("unpack", &small, n, hang, &o, |b| {
        let w = 1 + (b.len() % 70);
        let h = 1 + (b.len() / 7 % 50);
        for (nbpp, pv) in [(1u32, 4i32), (8, 0), (11, 0), (12, 0), (16, 1), (32, 2), (64, 3)] {
            for imode in [b'B', b'P', b'R', b'S'] {
                let _ = gw_parse::pixels::unpack_block(b, w, h, 1 + b.len() % 3, nbpp, nbpp.min(16), b.len() % 2 == 0, pv, imode);
            }
        }
    }));

    let mut jpeg: Vec<Vec<u8>> = nitf.iter().filter_map(|b| find(b, b"\xFF\xD8\xFF").map(|i| b[i..(i + (64 << 10)).min(b.len())].to_vec())).collect();
    for p in files(|n| n.ends_with(".jpg")) {
        jpeg.push(std::fs::read(p).unwrap());
    }
    for p in fixtures(|n| n.ends_with(".jpg")) {
        jpeg.push(head(&p, 1 << 20));
    }
    reports.push(run("jpeg", &jpeg, n, hang, &o, |b| {
        let _ = gw_codec::jpeg::decode(b, 0, 0);
        let _ = gw_codec::jpeg::decode(b, 3, 1);
    }));

    let j2k: Vec<Vec<u8>> = files(|n| (n.starts_with("p0_01") && n.ends_with(".ntf")) || n == "two_images_jp2.ntf")
        .iter()
        .chain(fixtures(|n| n == "mie_j2k.ntf").iter())
        .filter_map(|p| {
            let b = head(p, 4 << 20);
            find(&b, b"\xFF\x4F\xFF\x51").map(|i| b[i..].to_vec())
        })
        .collect();
    reports.push(run("j2k", &j2k, (n / 3).max(100), Duration::from_secs(10), &o, |b| {
        let _ = gw_codec::j2k::decode(b, None);
    }));

    // HTJ2K (REQ-FMT-17): the small OpenJPH-encoded fixtures as seeds.
    let ht: Vec<Vec<u8>> = ["ht_mono16.j2c", "ht_rgb8_lossy.j2c"]
        .iter()
        .filter_map(|f| std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/htj2k").join(f)).ok())
        .collect();
    reports.push(run("htj2k", &ht, (n / 3).max(100), Duration::from_secs(10), &o, |b| {
        let _ = gw_codec::j2k::decode(b, None);
        let _ = gw_codec::j2k::decode(b, Some((16, 16)));
    }));

    // RPF frames: U_3058B among the samples, and the CADRG and CIB frames among the fixtures.
    let vq: Vec<Vec<u8>> = files(|n| n == "u_3058b.ntf").iter().chain(fixtures(|n| n.ends_with(".mm2") || n.ends_with(".i13") || n.ends_with(".jn1")).iter()).map(|p| head(p, 4 << 20)).collect();
    reports.push(run("vq", &vq, n, hang, &o, |b| {
        if let Some(i) = find(b, b"RPFIMG") {
            let _ = gw_codec::vq::rpf_locations(b.get(i + 11..).unwrap_or(&[]));
        }
        if let Ok(l) = gw_codec::vq::luts(&b[b.len() / 3..]) {
            let _ = gw_codec::vq::decode_block(&b[b.len().saturating_sub(6144)..], &l);
        }
        let _ = gw_codec::vq::decode_block(b, b);
    }));

    reports.push(run("t4", &small, n, hang, &o, |b| {
        let _ = gw_codec::t4::decode(b, 1 + (b.len() % 2048) as u32, 1 + (b.len() % 512) as u32, "1D");
    }));

    // SICD/SIDD/CPHD XML (REQ-SAR-01/12): the hardened reader, the summary, the projection
    // record and the SICD model built from it.
    let mut xml: Vec<Vec<u8>> = Vec::new();
    for b in &nitf {
        if let (Some(i), Some(j)) = (find(b, b"<SICD"), find(b, b"</SICD>")) {
            xml.push(b[i..j + 7].to_vec());
        }
    }
    for p in files(|n| n.ends_with(".nitf") && n.contains("SIDD") || n.ends_with(".xml")).into_iter().chain(fixtures(|n| n.ends_with(".sicd.xml"))) {
        let b = std::fs::read(&p).unwrap();
        for (a, z) in [(&b"<SICD"[..], &b"</SICD>"[..]), (b"<SIDD", b"</SIDD>")] {
            if let (Some(i), Some(j)) = (find(&b, a), find(&b, z)) {
                xml.push(b[i..j + z.len()].to_vec());
            }
        }
    }
    reports.push(run("sarxml", &xml, n, hang, &o, |b| {
        if let Ok(root) = gw_parse::xml::parse(b) {
            let mut j = gw_abi::Json::new();
            j.obj();
            gw_parse::sicd::summary(&root, "urn:SICD:1.3.0", &mut j);
            gw_parse::sicd::sidd_summary(&root, "urn:SIDD:3.0.0", &mut j);
            j.end_obj();
            if let Ok(rec) = gw_parse::sicd::record(&root) {
                if let Ok(p) = gw_sensor::sicd::Params::from_record(&rec) {
                    let m = gw_sensor::sicd::Sicd::new(p, "fuzz");
                    let s = m.projection_set(10.0, -20.0);
                    let _ = m.r_rdot_to_constant_hae(&s, 0.0);
                    let _ = m.scene_to_image(m.p.scp);
                }
            }
            let _ = gw_parse::sicd::sidd_plane_record(&root);
        }
    }));

    // LAS/LAZ headers, VLRs and the LAZ chunk table (REQ-LDR-01, REQ-FMT-10).
    let mut las: Vec<Vec<u8>> = files(is_las).iter().chain(fixtures(is_las).iter()).map(|p| head(p, 256 << 10)).collect();
    las.push(small_laz());
    assert!(las.iter().any(|b| las_path(b)), "las: no seed holds its LAZ chunk table");
    reports.push(run("las", &las, n, hang, &o, |b| {
        las_path(b);
    }));

    // ENVI headers (REQ-FMT-06) and the Landsat, WorldView and Sentinel-2 metadata files beside a
    // scene: text a user opens, and none had a target.
    let envi: Vec<Vec<u8>> = fixtures(|n| n.ends_with(".hdr")).iter().map(|p| head(p, 256 << 10)).collect();
    reports.push(run("envi", &envi, n, hang, &o, |b| {
        if let Ok(h) = gw_parse::envi::parse(b) {
            let _ = gw_parse::envi::to_json(&h, b.len() as u64);
        }
    }));
    let meta: Vec<Vec<u8>> = vec![
        b"GROUP = LANDSAT_METADATA_FILE\n SPACECRAFT_ID = \"LANDSAT_8\"\n PROCESSING_LEVEL = \"L1TP\"\n SUN_ELEVATION = 55.5\n RADIANCE_MULT_BAND_4 = 9.6476E-03\n RADIANCE_ADD_BAND_4 = -48.23801\n REFLECTANCE_MULT_BAND_4 = 2.0000E-05\n REFLECTANCE_ADD_BAND_4 = -0.100000\n K1_CONSTANT_BAND_10 = 774.8853\n K2_CONSTANT_BAND_10 = 1321.0789\n".to_vec(),
        b"satId = \"WV03\";\nmeanSunEl = 61.2;\nBEGIN_GROUP = BAND_R\n absCalFactor = 1.3e-02;\n effectiveBandwidth = 5.85e-02;\nEND_GROUP = BAND_R\n".to_vec(),
        br#"<n1:Level-2A_User_Product xmlns:n1="x"><General_Info><Product_Info><PROCESSING_BASELINE>05.09</PROCESSING_BASELINE><PROCESSING_LEVEL>Level-2A</PROCESSING_LEVEL></Product_Info><Product_Image_Characteristics><QUANTIFICATION_VALUES_LIST><BOA_QUANTIFICATION_VALUE unit="none">10000</BOA_QUANTIFICATION_VALUE></QUANTIFICATION_VALUES_LIST><BOA_ADD_OFFSET_VALUES_LIST><BOA_ADD_OFFSET band_id="3">-1000</BOA_ADD_OFFSET></BOA_ADD_OFFSET_VALUES_LIST></Product_Image_Characteristics></General_Info></n1:Level-2A_User_Product>"#.to_vec(),
    ];
    reports.push(run("msimeta", &meta, n, hang, &o, |b| {
        let _ = gw_parse::msimeta::landsat_mtl(b);
        let _ = gw_parse::msimeta::worldview_imd(b);
        let _ = gw_parse::msimeta::sentinel2_mtd(b);
    }));

    // MPEG-TS demux and KLV (REQ-FMV-01, 02): FX-10 (Research) and the FX-10/11
    // fixtures; KLV seeds are the packets the demuxer finds.
    let fix = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures");
    let in_fix = |sub: &str, ext: &str| -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(fix.join(sub)).into_iter().flatten().flatten().map(|f| f.path()).filter(|p| p.to_string_lossy().to_lowercase().ends_with(ext)).collect();
        v.sort();
        v
    };
    let mut tsb: Vec<Vec<u8>> = files(|n| n.ends_with(".ts")).iter().chain(in_fix("fx10", ".ts").iter()).map(|p| std::fs::read(p).unwrap()).collect();
    let mut klvs: Vec<Vec<u8>> = Vec::new();
    for b in &tsb {
        let mut d = gw_parse::ts::Demux::new();
        let _ = d.push(&b[..b.len().min(1 << 20)], 0);
        d.finish();
        // Raw KLV payloads: the first PES of each KLV PID.
        for s in d.streams.iter().filter(|s| matches!(s.kind, gw_parse::ts::StreamKind::KlvSync | gw_parse::ts::StreamKind::KlvAsync)) {
            let (data, idx) = gw_parse::ts::extract_pes(&b[..b.len().min(1 << 20)], 0, s.pid, false);
            let mut o = 0;
            for (_, _, n) in idx.iter().take(6) {
                klvs.push(data[o..o + n].to_vec());
                o += n;
            }
        }
    }
    for b in &mut tsb {
        b.truncate(192 * 188);
    }
    reports.push(run("ts", &tsb, n, hang, &o, |b| {
        let mut d = gw_parse::ts::Demux::new();
        for (k, c) in b.chunks(1000).enumerate() {
            let _ = d.push(c, (k * 1000) as u64);
        }
        d.finish();
        let _ = d.to_json();
        if let Some(pid) = d.video_pid {
            let _ = gw_parse::ts::extract_pes(b, 0, pid, false);
        }
    }));
    reports.push(run("klv", &klvs, n, hang, &o, |b| {
        let p = gw_parse::klv::decode_packets(b);
        let _ = gw_parse::klv::to_json(&p);
        for k in [gw_parse::klv::UAS_ITEMS, gw_parse::klv::SECURITY_ITEMS] {
            let _ = gw_parse::klv::local_set(b, k, 0);
        }
    }));

    // GeoPDF scanner (REQ-FMT-14): PDFs among the samples and fixtures.
    let mut pdfs: Vec<Vec<u8>> = files(|n| n.ends_with(".pdf")).iter().chain(in_fix("formats", ".pdf").iter()).map(|p| {
        let b = std::fs::read(p).unwrap();
        b[..b.len().min(1 << 20)].to_vec()
    }).collect();
    if pdfs.is_empty() {
        pdfs.push(b"%PDF-1.4
3 0 obj << /Type /Page /MediaBox [0 0 10 10] /VP [<< /BBox [0 0 10 10] /Measure << /Subtype /GEO /GPTS [1 2 3 4] /LPTS [0 0 1 1] /GCS << /EPSG 4326 >> >> >>] /Resources << /XObject << /I 5 0 R >> >> /Contents 4 0 R >> endobj 4 0 obj << /Length 20 >> stream
q 10 0 0 10 0 0 cm /I Do Q
endstream endobj 5 0 obj << /Subtype /Image /Width 1 /Height 1 /Length 1 >> stream
x
endstream endobj".to_vec());
    }
    reports.push(run("pdf", &pdfs, n, hang, &o, |b| {
        if let Ok(p) = gw_parse::pdf::Pdf::scan(b) {
            let _ = gw_parse::pdf::to_json(&p);
        }
    }));

    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("fuzz {:<7} {:>6} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        assert!(r.runs > 0 || r.skipped, "{}: no seeds", r.target);
        for (p, m) in &r.crashes {
            bad.push(format!("{}: {} ({})", r.target, m, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}
