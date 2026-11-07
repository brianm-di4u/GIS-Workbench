//! MPEG-1 decoder against a reference decode (FC-22): `GW_MPEG1_ES` names an MPEG-1 elementary
//! stream and `GW_MPEG1_RGB` the same stream decoded by an independent decoder (ffmpeg,
//! `-f rawvideo -pix_fmt rgb24`). Skipped when unset (the FX-21 generator writes both).

use gw_codec::mpeg1v::Decoder;
use std::time::Instant;

#[test]
fn matches_reference_decode() {
    let (Ok(es), Ok(rgb)) = (std::env::var("GW_MPEG1_ES"), std::env::var("GW_MPEG1_RGB")) else {
        eprintln!("GW_MPEG1_ES / GW_MPEG1_RGB not set: skipped");
        return;
    };
    let es = std::fs::read(es).unwrap();
    let rgb = std::fs::read(rgb).unwrap();
    let mut d = Decoder::new();
    let t0 = Instant::now();
    let mut frames = Vec::new();
    let mut out = Vec::new();
    for c in es.chunks(65536) {
        d.push(c);
        while let Some(o) = d.decode().unwrap() {
            d.rgba(o.slot, &mut out);
            frames.push((o.ord, out.clone()));
        }
    }
    d.end();
    while let Some(o) = d.decode().unwrap() {
        d.rgba(o.slot, &mut out);
        frames.push((o.ord, out.clone()));
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    let (w, h) = (d.width as usize, d.height as usize);
    let n = rgb.len() / (w * h * 3);
    assert_eq!(frames.len(), n, "frame count");
    let mut worst = f64::INFINITY;
    for (k, (_, f)) in frames.iter().enumerate() {
        let r = &rgb[k * w * h * 3..(k + 1) * w * h * 3];
        let mut se = 0f64;
        for p in 0..w * h {
            for c in 0..3 {
                let e = f[p * 4 + c] as f64 - r[p * 3 + c] as f64;
                se += e * e;
            }
        }
        let mse = se / (w * h * 3) as f64;
        let psnr = if mse == 0.0 { 99.0 } else { 10.0 * (255f64 * 255.0 / mse).log10() };
        worst = worst.min(psnr);
    }
    eprintln!("{n} frames {w}x{h} in {ms:.0} ms ({:.2} ms/frame incl. RGBA); worst PSNR {worst:.1} dB", ms / n as f64);
    assert!(worst > 35.0, "worst PSNR {worst}");
}
