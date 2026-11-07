//! MPEG-2 decoder against FFmpeg (REQ-GAP-48, S-58): `GW_MPEG2_DIR` holds MPEG-2 elementary
//! streams `<name>.m2v`, each with `<name>.simple.yuv` (`ffmpeg -idct simple … -pix_fmt yuv420p`)
//! and optionally `<name>.auto.yuv` (FFmpeg's default IDCT). Every frame is compared in display
//! order: bit-exact frames against the simple-IDCT decode, and the PSNR of each plane against
//! both. Skipped when unset (docs/validation/2.4/motion.md lists how the vectors are made).

use gw_codec::mpeg2v::{Decoder, Slot};
use std::time::Instant;

fn decode_all(es: &[u8]) -> (Decoder, Vec<(Vec<u8>, Vec<u8>, Vec<u8>)>, f64) {
    let mut d = Decoder::new();
    let mut frames = Vec::new();
    let t0 = Instant::now();
    let grab = |d: &Decoder, s: Slot, frames: &mut Vec<(Vec<u8>, Vec<u8>, Vec<u8>)>| {
        let f = d.frame(s);
        let (lw, cw) = d.strides();
        let (w, h) = (d.width as usize, d.height as usize);
        let (cwv, chv) = (w.div_ceil(2), h.div_ceil(2));
        let y = (0..h).flat_map(|r| f.y[r * lw..r * lw + w].iter().copied()).collect();
        let cb = (0..chv).flat_map(|r| f.cb[r * cw..r * cw + cwv].iter().copied()).collect();
        let cr = (0..chv).flat_map(|r| f.cr[r * cw..r * cw + cwv].iter().copied()).collect();
        frames.push((y, cb, cr));
    };
    for c in es.chunks(188 * 7 * 16) {
        d.push(c);
        while let Some(o) = d.decode().unwrap() {
            grab(&d, o.slot, &mut frames);
        }
    }
    d.end();
    while let Some(o) = d.decode().unwrap() {
        grab(&d, o.slot, &mut frames);
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    (d, frames, ms)
}

fn psnr(a: &[u8], b: &[u8]) -> f64 {
    let se: f64 = a.iter().zip(b).map(|(&x, &y)| ((x as f64) - (y as f64)).powi(2)).sum();
    if se == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (255f64 * 255.0 / (se / a.len() as f64)).log10()
}

struct Cmp {
    exact: usize,
    worst: f64,
    mean: f64,
}

fn compare(frames: &[(Vec<u8>, Vec<u8>, Vec<u8>)], yuv: &[u8], w: usize, h: usize) -> Cmp {
    let (cw, ch) = (w.div_ceil(2), h.div_ceil(2));
    let fsz = w * h + 2 * cw * ch;
    assert_eq!(yuv.len() / fsz, frames.len(), "frame count against the reference");
    let mut c = Cmp { exact: 0, worst: f64::INFINITY, mean: 0.0 };
    let mut finite = 0usize;
    for (k, (y, cb, cr)) in frames.iter().enumerate() {
        let r = &yuv[k * fsz..(k + 1) * fsz];
        let (ry, rest) = r.split_at(w * h);
        let (rcb, rcr) = rest.split_at(cw * ch);
        if y == ry && cb == rcb && cr == rcr {
            c.exact += 1;
        }
        // PSNR of the whole frame (Y, Cb, Cr samples together).
        let mut all_a = Vec::with_capacity(fsz);
        all_a.extend_from_slice(y);
        all_a.extend_from_slice(cb);
        all_a.extend_from_slice(cr);
        let p = psnr(&all_a, r);
        c.worst = c.worst.min(p);
        if p.is_finite() {
            c.mean += p;
            finite += 1;
        }
    }
    if finite > 0 {
        c.mean /= finite as f64;
    } else {
        c.mean = f64::INFINITY;
    }
    c
}

#[test]
fn matches_ffmpeg() {
    let Ok(dir) = std::env::var("GW_MPEG2_DIR") else {
        eprintln!("GW_MPEG2_DIR not set: skipped");
        return;
    };
    let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "m2v")).collect();
    names.sort();
    assert!(!names.is_empty(), "no .m2v in {dir}");
    for p in names {
        let es = std::fs::read(&p).unwrap();
        let (d, frames, ms) = decode_all(&es);
        let (w, h) = (d.width as usize, d.height as usize);
        let stem = p.with_extension("");
        let simple = std::fs::read(format!("{}.simple.yuv", stem.display())).unwrap();
        let s = compare(&frames, &simple, w, h);
        let auto = std::fs::read(format!("{}.auto.yuv", stem.display())).ok().map(|a| compare(&frames, &a, w, h));
        eprintln!(
            "{}: {} frames {w}x{h} ({} field pictures, {} interlaced frame pictures) in {ms:.0} ms ({:.2} ms/frame native, YUV only); vs ffmpeg -idct simple: {} of {} bit-exact, worst PSNR {:.2} dB; vs ffmpeg default IDCT: {}",
            p.file_name().unwrap().to_string_lossy(),
            frames.len(),
            d.field_pictures,
            d.interlaced_frames,
            ms / frames.len() as f64,
            s.exact,
            frames.len(),
            s.worst,
            auto.as_ref().map_or("not given".into(), |a| format!("{} bit-exact, worst {:.2} dB, mean {:.2} dB", a.exact, a.worst, a.mean)),
        );
        assert!(s.worst >= 45.0, "{}: worst PSNR {} dB against ffmpeg -idct simple", p.display(), s.worst);
        if let Some(a) = auto {
            assert!(a.worst >= 45.0, "{}: worst PSNR {} dB against ffmpeg", p.display(), a.worst);
        }
    }
}
