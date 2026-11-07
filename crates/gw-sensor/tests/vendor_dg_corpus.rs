//! REQ-GAP-20 differential test: the rigorous line scanner built from each corpus DigitalGlobe
//! product's `.IMD`, `.EPH`, `.ATT` and `.GEO` against the product's own `.RPB` (the vendor RPC).
//! The products are the 21 Level-1B deliveries of the T&E corpus that carry all five files
//! (WorldView-2 Atlanta: `eo-spacenet-atlanta-wv2-l1b-rpc`, `…-nadir10-nadir29`; WorldView-3:
//! the DG tars of `nitf-mvs-wv3-buenos-aires` and `nitf-core3d-jacksonville-wv3`). They stay on D:
//! and the test skips cleanly when they are absent.
//!
//! For each product: an 11 × 11 grid over the image at three heights (the RPC height offset and ±
//! its scale) goes to the ground through the RPB and back through the rigorous model; the
//! differences are summarised in pixels.

use gw_sensor::rpc::Rpc;
use gw_sensor::vendor::dg::{dg_model, rpb_record, DgFiles};
use gw_sensor::SensorModel;
use std::path::{Path, PathBuf};

const ROOTS: [&str; 4] = ["D:/TE-corpus/eo-spacenet-atlanta-wv2-l1b-rpc", "D:/TE-corpus/eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29", "D:/TE-corpus/nitf-mvs-wv3-buenos-aires", "D:/TE-corpus/nitf-core3d-jacksonville-wv3"];

fn walk(d: &Path, out: &mut Vec<PathBuf>) {
    if let Ok(rd) = std::fs::read_dir(d) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().map(|x| x.eq_ignore_ascii_case("geo")).unwrap_or(false) {
                out.push(p);
            }
        }
    }
}

pub fn products() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for r in ROOTS {
        walk(Path::new(r), &mut v);
    }
    v.sort();
    v
}

fn read(p: &Path, ext: &str) -> Option<String> {
    std::fs::read_to_string(p.with_extension(ext)).ok()
}

pub struct Stats {
    pub mean: (f64, f64),
    pub sd: (f64, f64),
    pub rms: f64,
    pub max: f64,
}
pub fn stats(d: &[(f64, f64)]) -> Stats {
    let k = d.len() as f64;
    let (mx, my) = (d.iter().map(|v| v.0).sum::<f64>() / k, d.iter().map(|v| v.1).sum::<f64>() / k);
    let sx = (d.iter().map(|v| (v.0 - mx).powi(2)).sum::<f64>() / k).sqrt();
    let sy = (d.iter().map(|v| (v.1 - my).powi(2)).sum::<f64>() / k).sqrt();
    let rms = (d.iter().map(|v| v.0 * v.0 + v.1 * v.1).sum::<f64>() / k).sqrt();
    let max = d.iter().map(|v| v.0.hypot(v.1)).fold(0.0, f64::max);
    Stats { mean: (mx, my), sd: (sx, sy), rms, max }
}

#[test]
fn dg_rigorous_model_agrees_with_the_rpb_on_the_corpus() {
    let ps = products();
    if ps.is_empty() {
        eprintln!("skipped: the T&E corpus DigitalGlobe products are not on D:");
        return;
    }
    println!("| product | sat | lines × samples | scan | off-nadir | mean dx | mean dy | sd dx | sd dy | RMS | max | no refraction RMS | µs/pt |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    let mut all = Vec::new();
    for p in &ps {
        let (Some(imd), Some(eph), Some(att), Some(geo), Some(rpb)) = (read(p, "IMD"), read(p, "EPH"), read(p, "ATT"), read(p, "GEO"), read(p, "RPB")) else {
            continue;
        };
        let b = dg_model(&DgFiles { imd: &imd, eph: &eph, att: &att, geo: &geo }, 0).unwrap_or_else(|e| panic!("{}: {}", p.display(), e.msg));
        let m = &b.model;
        let rpc = Rpc::from_record(&rpb_record(&rpb).expect("RPB")).unwrap();
        let (h0, h1) = rpc.height_range();
        let hm = 0.5 * (h0 + h1);
        let grid = |m: &dyn SensorModel| {
            let mut d = Vec::new();
            for a in 0..=10 {
                for c in 0..=10 {
                    for h in [h0, hm, h1] {
                        let (x, y) = (0.5 + a as f64 / 10.0 * (m_cols(&b) - 1.0), 0.5 + c as f64 / 10.0 * (b.model.rows - 1.0));
                        let g = rpc.image_to_ground(x, y, h).unwrap();
                        let (x2, y2) = m.ground_to_image(g).unwrap();
                        d.push((x2 - x, y2 - y));
                    }
                }
            }
            d
        };
        let t = std::time::Instant::now();
        let d = grid(m);
        let us = t.elapsed().as_secs_f64() * 1e6 / d.len() as f64;
        let s = stats(&d);
        let mut nr = m.clone();
        nr.refraction_k = 0.0;
        let s_nr = stats(&grid(&nr));
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        let sat = if imd.contains("\"WV02\"") { "WV2" } else if imd.contains("\"WV03\"") { "WV3" } else { "?" };
        println!("| {} | {} | {} × {} | {} | {:.1}° | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.2} | {:.1} |", &name[..name.len().min(33)], sat, m.rows, m.cols, if m.period < 0.0 { "reverse" } else { "forward" }, m.off_nadir_deg(), s.mean.0, s.mean.1, s.sd.0, s.sd.1, s.rms, s.max, s_nr.rms, us);
        // Up to 45° off nadir the RPB and the rigorous model agree to about a pixel. The two WorldView-2
        // strips at 52.7° and 53.8° disagree by 8–10 px with the standard-atmosphere refraction and by
        // 2–3 px without it: their RPB implies about a quarter of that refraction (validation note).
        let on = m.off_nadir_deg();
        if on < 45.0 {
            assert!(s.rms < 1.6 && s.max < 3.5, "{name}: RMS {} px, max {} px", s.rms, s.max);
        } else {
            assert!(s.rms < 12.0, "{name}: RMS {} px", s.rms);
        }
        all.push((s.rms, s.max, on));
        // Round trip of the rigorous model itself.
        let g = m.image_to_ground(0.37 * m.cols, 0.61 * m.rows, hm).unwrap();
        let (x, y) = m.ground_to_image(g).unwrap();
        assert!((x - 0.37 * m.cols).hypot(y - 0.61 * m.rows) < 1e-6);
    }
    assert!(!all.is_empty());
    let n = all.len() as f64;
    let rms = (all.iter().map(|v| v.0 * v.0).sum::<f64>() / n).sqrt();
    let worst = all.iter().map(|v| v.1).fold(0.0, f64::max);
    let low: Vec<_> = all.iter().filter(|v| v.2 < 45.0).collect();
    let rms_low = (low.iter().map(|v| v.0 * v.0).sum::<f64>() / low.len() as f64).sqrt();
    let worst_low = low.iter().map(|v| v.1).fold(0.0, f64::max);
    println!("products {}: RMS {:.3} px, worst {:.3} px; the {} under 45° off nadir: RMS {:.3} px, worst {:.3} px", all.len(), rms, worst, low.len(), rms_low, worst_low);
    assert_eq!(all.len(), 21);
}

fn m_cols(b: &gw_sensor::vendor::dg::Built) -> f64 {
    b.model.cols
}
