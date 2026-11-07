//! REQ-GAP-19 differential test: the rigorous pushbroom model built from each corpus NITF's
//! CSEPHA, CSATTA, CSSFAA, CSEXRA and USE00A against the RPC00B of the same file (the 16
//! WorldView-3 NITFs of the T&E corpus that carry CSEPHA; `build/campaign/corpus.json` items
//! nitf-mvs-wv3-buenos-aires and nitf-core3d-jacksonville-wv3). The files stay on D: (the
//! TE-corpus junction); the test skips cleanly when they are absent. Only the headers and the DES
//! at the end of each file are read.
//!
//! For each image: an 11 × 11 grid of image points at three heights (the RPC height offset and
//! ± its scale) is taken to the ground with the RPC, back to the image with the rigorous model,
//! and the differences are summarised (mean, standard deviation, RMS, maximum, pixels).

use gw_sensor::linescan::{LineScanner, NitfSupport};
use gw_sensor::rpc::{record_from_tre, Rpc};
use gw_sensor::{Ground, SensorModel};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const DIRS: [&str; 3] = ["D:/TE-corpus/nitf-mvs-wv3-buenos-aires/PAN", "D:/TE-corpus/nitf-core3d-jacksonville-wv3/PAN", "D:/TE-corpus/nitf-core3d-jacksonville-wv3/MSI"];

fn read_at(f: &mut File, off: u64, n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    f.seek(SeekFrom::Start(off)).unwrap();
    f.read_exact(&mut b).unwrap();
    b
}
fn num(b: &[u8]) -> u64 {
    std::str::from_utf8(b).unwrap().trim().parse().unwrap()
}
fn tre<'a>(area: &'a [u8], tag: &str) -> Option<&'a [u8]> {
    let mut o = 0;
    while o + 11 <= area.len() {
        let t = std::str::from_utf8(&area[o..o + 6]).ok()?;
        let n = std::str::from_utf8(&area[o + 6..o + 11]).ok()?.trim().parse::<usize>().ok()?;
        if t == tag {
            return area.get(o + 11..o + 11 + n);
        }
        o += 11 + n;
    }
    None
}

struct Parts {
    rows: f64,
    cols: f64,
    idatim: String,
    rpc: Vec<u8>,
    csexra: Vec<u8>,
    use00a: Option<Vec<u8>>,
    csepha: Vec<u8>,
    cssfaa: Vec<u8>,
    att_h: Vec<u8>,
    att_d: Vec<u8>,
}

/// NITF 2.1: the first image's subheader TREs and the DES (TRE_OVERFLOW, CSATTA DES).
fn parts(p: &Path) -> Parts {
    let mut f = File::open(p).unwrap();
    let h = read_at(&mut f, 0, 2000);
    let hl = num(&h[354..360]);
    let numi = num(&h[360..363]) as usize;
    let mut o = 363;
    let mut img = Vec::new();
    for _ in 0..numi {
        img.push((num(&h[o..o + 6]), num(&h[o + 6..o + 16])));
        o += 16;
    }
    let nums = num(&h[o..o + 3]) as usize;
    o += 3 + nums * 10;
    o += 3; // NUMX
    let numt = num(&h[o..o + 3]) as usize;
    o += 3;
    let mut text = 0;
    for _ in 0..numt {
        text += num(&h[o..o + 4]) + num(&h[o + 4..o + 9]);
        o += 9;
    }
    let numd = num(&h[o..o + 3]) as usize;
    o += 3;
    let mut des = Vec::new();
    for _ in 0..numd {
        des.push((num(&h[o..o + 4]), num(&h[o + 4..o + 13])));
        o += 13;
    }
    let ish = read_at(&mut f, hl, img[0].0 as usize);
    let rows = num(&ish[333..341]) as f64;
    let cols = num(&ish[341..349]) as f64;
    let idatim = String::from_utf8_lossy(&ish[12..26]).to_string();
    // Image subheader TREs: after the band and blocking fields; find the UDIDL/IXSHDL area by tag scan.
    // The extended subheader area: the first TRE these files carry is CSDIDA or CSCCGA/CSCRNA.
    let start = ish.windows(6).position(|w| w == b"CSDIDA" || w == b"CSCCGA" || w == b"CSCRNA").unwrap();
    let area = &ish[start..];
    let mut off = hl + img.iter().map(|(s, d)| s + d).sum::<u64>() + text;
    let (mut csepha, mut cssfaa, mut att_h, mut att_d) = (None, None, None, None);
    for (sl, dl) in des {
        let sh = read_at(&mut f, off, sl as usize);
        let id = String::from_utf8_lossy(&sh[2..27]).trim().to_string();
        if id == "TRE_OVERFLOW" || id == "CSATTA DES" {
            let d = read_at(&mut f, off + sl, dl as usize);
            if id == "TRE_OVERFLOW" {
                csepha = csepha.or(tre(&d, "CSEPHA").map(|v| v.to_vec()));
                cssfaa = cssfaa.or(tre(&d, "CSSFAA").map(|v| v.to_vec()));
            } else {
                let b = 27 + 2 + 167;
                let shl = num(&sh[b..b + 4]) as usize;
                att_h = Some(sh[b + 4..b + 4 + shl].to_vec());
                att_d = Some(d);
            }
        }
        off += sl + dl;
    }
    Parts { rows, cols, idatim, rpc: tre(area, "RPC00B").unwrap().to_vec(), csexra: tre(area, "CSEXRA").unwrap().to_vec(), use00a: tre(area, "USE00A").map(|v| v.to_vec()), csepha: csepha.unwrap(), cssfaa: cssfaa.unwrap(), att_h: att_h.unwrap(), att_d: att_d.unwrap() }
}

fn rpc_of(t: &[u8]) -> Rpc {
    let s = std::str::from_utf8(t).unwrap();
    let mut o = 1;
    let mut take = |n: usize| {
        let v: f64 = s[o..o + n].trim().parse().unwrap();
        o += n;
        v
    };
    let sc = [take(7), take(7), take(6), take(5), take(8), take(9), take(5), take(6), take(5), take(8), take(9), take(5)];
    let mut c = [[0.0; 20]; 4];
    for row in c.iter_mut() {
        for v in row.iter_mut() {
            *v = take(12);
        }
    }
    Rpc::from_record(&record_from_tre(sc, c, false, None)).unwrap()
}

fn files() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for d in DIRS {
        if let Ok(rd) = std::fs::read_dir(d) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().map(|x| x.eq_ignore_ascii_case("ntf")).unwrap_or(false) {
                    v.push(p);
                }
            }
        }
    }
    v.sort();
    v
}

#[test]
fn rigorous_pushbroom_agrees_with_the_rpc_on_the_corpus() {
    let fs = files();
    if fs.is_empty() {
        eprintln!("skipped: the T&E corpus WorldView-3 NITFs are not on D:");
        return;
    }
    let mut all = Vec::new();
    let mut ablation: [Vec<(f64, f64)>; 2] = [Vec::new(), Vec::new()];
    println!("| image | lines × samples | scan | mean dx | mean dy | sd dx | sd dy | RMS | max | g→i ms |");
    println!("|---|---|---|---|---|---|---|---|---|---|");
    for p in &fs {
        let q = parts(p);
        let rpc = rpc_of(&q.rpc);
        let m = LineScanner::from_nitf(&NitfSupport { rows: q.rows, cols: q.cols, image_date: &q.idatim, csepha: &q.csepha, csatta_header: &q.att_h, csatta_data: &q.att_d, cssfaa: &q.cssfaa, csexra: &q.csexra, use00a: q.use00a.as_deref(), band: 0 }).unwrap();
        let (h0, h1) = rpc.height_range();
        let hm = 0.5 * (h0 + h1);
        // The valid samples are the detectors (CSSFAA DELTA); the valid lines USE00A MAX_LP_SEG.
        let w = m.n_det;
        let lines = valid_lines(&q).unwrap_or(q.rows);
        let mut d = Vec::new();
        let t = std::time::Instant::now();
        let mut n = 0;
        for a in 0..=10 {
            for b in 0..=10 {
                for h in [h0, hm, h1] {
                    let (x, y) = (0.5 + a as f64 / 10.0 * (w - 1.0), 0.5 + b as f64 / 10.0 * (lines - 1.0));
                    let g: Ground = rpc.image_to_ground(x, y, h).unwrap();
                    let (x2, y2) = m.ground_to_image(g).unwrap();
                    n += 1;
                    d.push((x2 - x, y2 - y));
                }
            }
        }
        let ms = t.elapsed().as_secs_f64() * 1000.0 / n as f64;
        let k = d.len() as f64;
        let (mx, my) = (d.iter().map(|v| v.0).sum::<f64>() / k, d.iter().map(|v| v.1).sum::<f64>() / k);
        let sx = (d.iter().map(|v| (v.0 - mx).powi(2)).sum::<f64>() / k).sqrt();
        let sy = (d.iter().map(|v| (v.1 - my).powi(2)).sum::<f64>() / k).sqrt();
        let rms = (d.iter().map(|v| v.0 * v.0 + v.1 * v.1).sum::<f64>() / k).sqrt();
        let max = d.iter().map(|v| v.0.hypot(v.1)).fold(0.0, f64::max);
        let name = p.file_name().unwrap().to_string_lossy();
        println!("| {} | {} × {} | {} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.3} |", &name[..name.find("-P1BS").or(name.find("-M1BS")).map(|i| i + 5).unwrap_or(30)], lines, w, if m.period < 0.0 { "reverse" } else { "forward" }, mx, my, sx, sy, rms, max, ms);
        all.push((rms, max, mx.hypot(my)));
        // Ablation: the same grid without refraction, and without any light correction.
        for (k, (ab, rf)) in [(true, 0.0), (false, 0.0)].into_iter().enumerate() {
            let mut a = m.clone();
            a.aberration = ab;
            a.refraction_k = rf;
            let mut s2 = 0.0;
            let mut bx = (0.0, 0.0);
            for a2 in 0..=10 {
                for b2 in 0..=10 {
                    let (x, y) = (0.5 + a2 as f64 / 10.0 * (w - 1.0), 0.5 + b2 as f64 / 10.0 * (lines - 1.0));
                    let g = rpc.image_to_ground(x, y, hm).unwrap();
                    let (x2, y2) = a.ground_to_image(g).unwrap();
                    s2 += (x2 - x).powi(2) + (y2 - y).powi(2);
                    bx.0 += x2 - x;
                    bx.1 += y2 - y;
                }
            }
            ablation[k].push(((s2 / 121.0).sqrt(), (bx.0 / 121.0).hypot(bx.1 / 121.0)));
        }
    }
    for (k, label) in ["aberration and light time only (no refraction)", "no light corrections"].iter().enumerate() {
        let r = (ablation[k].iter().map(|v| v.0 * v.0).sum::<f64>() / ablation[k].len() as f64).sqrt();
        let b = ablation[k].iter().map(|v| v.1).fold(0.0, f64::max);
        println!("ablation, {label}: RMS {r:.2} px, largest mean offset {b:.2} px");
    }
    let n = all.len();
    let rms = (all.iter().map(|v| v.0 * v.0).sum::<f64>() / n as f64).sqrt();
    let max = all.iter().map(|v| v.1).fold(0.0, f64::max);
    let bias = all.iter().map(|v| v.2).fold(0.0, f64::max);
    println!("{n} images: RMS {rms:.2} px over all, worst image maximum {max:.2} px, largest mean offset {bias:.2} px");
    assert_eq!(n, 16, "the corpus should have 16 WorldView-3 NITFs with CSEPHA");
    // Measured 2026-11-02: RMS 0.65 px, worst maximum 1.82 px, largest mean offset 0.54 px.
    assert!(rms < 1.0 && max < 2.5 && bias < 0.8, "rigorous vs RPC: RMS {rms} max {max} bias {bias}");
}

fn valid_lines(q: &Parts) -> Option<f64> {
    q.use00a.as_ref().and_then(|u| std::str::from_utf8(&u[79..85]).ok()).and_then(|v| v.trim().parse().ok())
}
