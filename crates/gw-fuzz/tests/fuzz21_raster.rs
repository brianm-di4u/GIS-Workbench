//! 2.1 fuzz targets (raster group, REQ-RUST-12). Seeds: corpus negatives turned positives (SDP-2.1 §7.1).
//!
//! * `hfa`: the decode worker's HFA path — file header, every entry header of the tree, each node's
//!   data through the file's own dictionary, the Edms_State block table and every block (raw and
//!   RLE, every pixel type).
//! * `netcdf3`: the NetCDF-3 header parser (CDF-1/2/5) and its JSON, plus the header writer on
//!   specs derived from the mutated bytes.
//!
//! Seeds: the HFA and NetCDF-3 files of the T&E corpus (TE_CORPUS or ../TE-corpus) and the FX-21
//! fixtures (fixtures/fx21/raster); a built-in seed from the writers keeps the targets meaningful
//! when neither is on disk. Iterations: GW_FUZZ_ITERS (default 1500 per target); run with --release.

use gw_fuzz::run;
use gw_parse::{hfa, netcdf3};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn iters() -> usize {
    std::env::var("GW_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(1500)
}

fn out() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../reports/fuzz-crashes")
}

fn corpus() -> PathBuf {
    std::env::var("TE_CORPUS").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../TE-corpus"))
}

/// Files under the corpus items and fixtures whose name matches, up to 4 MB each.
fn seeds(dirs: &[&str], pred: impl Fn(&str) -> bool) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let fx = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx21/raster");
    let mut paths: Vec<PathBuf> = dirs.iter().map(|d| corpus().join(d)).collect();
    paths.push(fx);
    for d in paths {
        let mut list: Vec<PathBuf> = std::fs::read_dir(&d).into_iter().flatten().flatten().map(|e| e.path()).collect();
        list.sort();
        for p in list {
            let n = p.file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
            if pred(&n) && p.metadata().map(|m| m.len() < 4 << 20).unwrap_or(false) {
                if let Ok(b) = std::fs::read(&p) {
                    out.push(b);
                }
            }
        }
    }
    out
}

fn u32le(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn field(j: &str, key: &str) -> Option<u64> {
    let pat = format!("\"{key}\":");
    let i = j.find(&pat)? + pat.len();
    let end = j[i..].find(|c: char| !c.is_ascii_digit()).map(|e| e + i).unwrap_or(j.len());
    j[i..end].parse().ok()
}

/// The worker's HFA path on a whole (mutated) file: header → tree walk (bounded, loop-safe) →
/// each node decoded by the dictionary → block tables → blocks.
fn hfa_path(b: &[u8]) {
    let Ok(h) = hfa::file_header(b) else { return };
    let (Some(root), Some(dp)) = (field(&h, "root"), field(&h, "dictionary")) else { return };
    let Some(dict_bytes) = b.get(dp as usize..) else { return };
    let dict = hfa::Dict::parse(&dict_bytes[..dict_bytes.len().min(1 << 16)]);
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![root as usize];
    while let Some(p) = stack.pop() {
        if p == 0 || !seen.insert(p) || seen.len() > 4000 {
            continue;
        }
        let Some(e) = b.get(p..(p + 128).min(b.len())) else { continue };
        let Ok(_) = hfa::entry(e) else { continue };
        if let (Some(next), Some(child)) = (u32le(e, 0), u32le(e, 12)) {
            stack.push(next as usize);
            stack.push(child as usize);
        }
        let (Some(dpos), Some(dsz)) = (u32le(e, 16), u32le(e, 20)) else { continue };
        let ty: String = e.get(88..120).map(|t| t.iter().take_while(|&&c| c != 0).map(|&c| c as char).collect()).unwrap_or_default();
        let Some(data) = b.get(dpos as usize..(dpos as usize).saturating_add(dsz as usize).min(b.len())) else { continue };
        if let Ok(d) = &dict {
            let _ = d.decode(&ty, data, 256);
            if ty == "Edms_State" {
                if let Ok(t) = hfa::block_table(d, data) {
                    for k in t.chunks(3).take(8) {
                        let (o, s, f) = (k[0] as usize, k[1] as usize, k[2]);
                        if let Some(blk) = b.get(o..o.saturating_add(s).min(b.len())) {
                            for pt in [0u32, 1, 2, 3, 4, 5, 6, 8, 9, 10] {
                                let _ = hfa::decode_block(blk, pt, 64 * 64, f & 2 != 0);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn nc3_path(b: &[u8]) {
    if let Ok(h) = netcdf3::parse(b) {
        let _ = netcdf3::to_json(&h, b.len() as u64);
    }
    // The writer on a spec made from the bytes (lines of printable text).
    let spec: String = b.iter().take(2048).map(|&c| if c == b'\n' || (0x20..0x7f).contains(&c) { c as char } else { ' ' }).collect();
    if let Ok((head, _)) = netcdf3::write_header(&spec) {
        assert!(netcdf3::parse(&head).is_ok(), "the writer's own header parses");
    }
}

fn hfa_seed() -> Vec<u8> {
    let (meta, layout) = hfa::write("size 100 70\nband Layer_1 3\nnodata 0\nstats 1 2 1.5 1.5 1 0.5\noverview 50 35\nmapinfo UTM|meters|440750 3751290 446690 3747150 60 60\npro 1 11 6378206.4 6356583.8|UTM|Clarke 1866|0 0 0 1 0 0 0 0 0 0 0 0 0 0 0\ndatum NAD27|0 0 0 0 0 0 0\n").unwrap();
    let size = field(&layout, "fileSize").unwrap() as usize;
    let mut f = meta;
    while f.len() < size {
        f.push((f.len() % 251) as u8);
    }
    f
}

#[test]
fn fuzz21_raster() {
    let n = iters();
    let hang = Duration::from_millis(std::env::var("GW_FUZZ_HANG_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000));
    let o = out();
    let mut reports = Vec::new();

    let mut hs = seeds(&["raster-hfa-negatives-gdal", "raster-hfa-gdal-autotest-21", "robustness-hfa-gdal-autotest", "derived-raster-negatives"], |n| n.ends_with(".img") || n.ends_with(".rrd"));
    hs.truncate(24);
    hs.push(hfa_seed());
    reports.push(run("hfa", &hs, n, hang, &o, hfa_path));

    let mut ns = seeds(&["raster-netcdf3-negatives-gdal", "raster-netcdf3-negatives-unidata", "raster-netcdf3-gdal-autotest-21", "raster-netcdf3-noaa-psl"], |n| n.ends_with(".nc"));
    // The header is what the parser reads: seeds are cut to their first 64 KB.
    for s in ns.iter_mut() {
        s.truncate(64 << 10);
    }
    ns.truncate(32);
    for v in [1u8, 2, 5] {
        ns.push(netcdf3::write_header(&format!("cdf {v}\nnumrecs 2\ndim t 0\ndim y 3\ndim x 4\ngatt Conventions char CF-1.8\nvar crs int\natt grid_mapping_name char latitude_longitude\nvar v float t y x\natt _FillValue float -9999\n")).unwrap().0);
    }
    ns.push(b"cdf 2\nnumrecs 1\ndim t 0\ndim x 4\nvar a short t x\natt scale_factor float 0.5\n".to_vec());
    reports.push(run("netcdf3", &ns, n, hang, &o, nc3_path));

    let mut bad = Vec::new();
    for r in &reports {
        eprintln!("fuzz21 {:<8} {:>6} runs, slowest {:?}, {} problem(s)", r.target, r.runs, r.slowest, r.crashes.len());
        for (p, m) in &r.crashes {
            bad.push(format!("{}: {} ({})", r.target, m, p.display()));
        }
    }
    assert!(bad.is_empty(), "fuzz problems:\n{}", bad.join("\n"));
}

/// Replay one saved input: GW_FUZZ_REPLAY=<file> cargo test -p gw-fuzz --test fuzz21_raster replay -- --nocapture
#[test]
fn replay() {
    let Ok(p) = std::env::var("GW_FUZZ_REPLAY") else { return };
    let b = std::fs::read(p).unwrap();
    let spec: String = b.iter().take(2048).map(|&c| if c == b'\n' || (0x20..0x7f).contains(&c) { c as char } else { ' ' }).collect();
    eprintln!("spec: {spec:?}");
    if let Ok((head, layout)) = netcdf3::write_header(&spec) {
        eprintln!("layout {layout}\nparse: {:?}", netcdf3::parse(&head).err());
    }
    hfa_path(&b);
    nc3_path(&b);
}
