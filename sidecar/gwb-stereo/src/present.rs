//! Which eye goes into which buffer. This is the quad-buffer path, and it is the same code on real
//! OpenGL and in the software GL of the tests.

use crate::gl::*;
use gwb_sidecar_api::{StereoMode, StereoReadback};
use sha2::{Digest, Sha256};

/// What is on the display: never `Auto`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shown {
    Quad,
    Anaglyph,
    SideBySide,
}

impl Shown {
    pub fn api(self) -> StereoMode {
        match self {
            Shown::Quad => StereoMode::Quad,
            Shown::Anaglyph => StereoMode::Anaglyph,
            Shown::SideBySide => StereoMode::SideBySide,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Shown::Quad => "quad-buffer",
            Shown::Anaglyph => "anaglyph",
            Shown::SideBySide => "side-by-side",
        }
    }
}

/// The mode for what was asked and what the context has, and why it differs when it does.
pub fn choose(asked: StereoMode, has_stereo: bool) -> (Shown, Option<String>) {
    match asked {
        StereoMode::Auto | StereoMode::Quad if has_stereo => (Shown::Quad, None),
        StereoMode::Quad => (Shown::Anaglyph, Some("this display offers no quad-buffer pixel format: showing anaglyph".into())),
        StereoMode::Auto | StereoMode::Anaglyph => (Shown::Anaglyph, None),
        StereoMode::SideBySide => (Shown::SideBySide, None),
    }
}

const BLACK: [f32; 3] = [0.0, 0.0, 0.0];

/// Draw one frame into the back buffers. `Err` is a GL error, by name, and the frame is not good.
pub fn present<G: Gl>(g: &mut G, shown: Shown, w: u32, h: u32, left: &[Quad], right: &[Quad]) -> Result<Vec<u32>, String> {
    let (wi, hi) = (w as i32, h as i32);
    let mut used = Vec::new();
    let mut choose_buffer = |g: &mut G, b: u32| -> Result<(), String> {
        g.draw_buffer(b);
        used.push(b);
        match g.error() {
            GL_NO_ERROR => Ok(()),
            e => Err(format!("glDrawBuffer({}) failed with GL error {e:#x}", buffer_name(b))),
        }
    };
    g.color_mask(true, true, true);
    match shown {
        Shown::Quad => {
            choose_buffer(g, GL_BACK_LEFT)?;
            g.viewport(0, 0, wi, hi);
            g.clear(BLACK);
            left.iter().for_each(|q| g.draw_quad(q));
            choose_buffer(g, GL_BACK_RIGHT)?;
            g.clear(BLACK);
            right.iter().for_each(|q| g.draw_quad(q));
        }
        Shown::Anaglyph => {
            choose_buffer(g, GL_BACK)?;
            g.viewport(0, 0, wi, hi);
            g.clear(BLACK);
            g.color_mask(true, false, false);
            left.iter().for_each(|q| g.draw_quad(q));
            g.color_mask(false, true, true);
            right.iter().for_each(|q| g.draw_quad(q));
            g.color_mask(true, true, true);
        }
        Shown::SideBySide => {
            choose_buffer(g, GL_BACK)?;
            g.viewport(0, 0, wi, hi);
            g.clear(BLACK);
            g.viewport(0, 0, wi / 2, hi);
            left.iter().for_each(|q| g.draw_quad(q));
            g.viewport(wi / 2, 0, wi - wi / 2, hi);
            right.iter().for_each(|q| g.draw_quad(q));
            g.viewport(0, 0, wi, hi);
        }
    }
    match g.error() {
        GL_NO_ERROR => Ok(used),
        e => Err(format!("drawing failed with GL error {e:#x}")),
    }
}

/// Grey values, one per pixel.
fn grey(rgba: &[u8]) -> Vec<f32> {
    rgba.chunks_exact(4).map(|p| (p[0] as f32 + p[1] as f32 + p[2] as f32) / 3.0).collect()
}

/// The right image's shift against the left, in pixels, by normalised cross-correlation of the
/// middle rows, to a tenth of a pixel. A pair with no texture scores 0.
pub fn disparity(left: &[f32], right: &[f32], w: usize, h: usize, range: i32) -> (f64, f64) {
    let (top, bottom) = (h / 4, h - h / 4);
    let at = |d: i32| -> f64 {
        let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut n) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for y in top..bottom {
            for x in range as usize..w - range as usize {
                let a = left[y * w + x] as f64;
                let b = right[y * w + (x as i32 + d) as usize] as f64;
                sa += a;
                sb += b;
                saa += a * a;
                sbb += b * b;
                sab += a * b;
                n += 1.0;
            }
        }
        let cov = sab - sa * sb / n;
        let var = (saa - sa * sa / n) * (sbb - sb * sb / n);
        if var <= 1e-9 {
            0.0
        } else {
            cov / var.sqrt()
        }
    };
    let scores: Vec<f64> = (-range..=range).map(at).collect();
    let (mut best, mut score) = (0usize, f64::MIN);
    for (i, s) in scores.iter().enumerate() {
        if *s > score {
            best = i;
            score = *s;
        }
    }
    let mut d = best as f64 - range as f64;
    if best > 0 && best + 1 < scores.len() {
        let (a, b, c) = (scores[best - 1], scores[best], scores[best + 1]);
        let div = a - 2.0 * b + c;
        if div.abs() > 1e-12 {
            d += (0.5 * (a - c) / div).clamp(-0.5, 0.5);
        }
    }
    (d, score.max(0.0))
}

fn mean(rgba: &[u8]) -> [f64; 3] {
    let n = (rgba.len() / 4).max(1) as f64;
    let mut s = [0.0; 3];
    for p in rgba.chunks_exact(4) {
        for c in 0..3 {
            s[c] += p[c] as f64;
        }
    }
    s.map(|v| v / n)
}

fn sha(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// What each eye got, read back from the buffers it went to. Call before the swap.
pub fn read_back<G: Gl>(g: &mut G, shown: Shown, w: u32, h: u32, used: &[u32]) -> StereoReadback {
    let (l, r): (Vec<u8>, Vec<u8>) = match shown {
        Shown::Quad => (g.read(GL_BACK_LEFT, w, h), g.read(GL_BACK_RIGHT, w, h)),
        Shown::Anaglyph => {
            // The eyes are the channels: left in red, right in green and blue.
            let all = g.read(GL_BACK, w, h);
            let split = |take: fn(&[u8]) -> u8| all.chunks_exact(4).flat_map(|p| [take(p), take(p), take(p), 255]).collect::<Vec<u8>>();
            (split(|p| p[0]), split(|p| p[1]))
        }
        Shown::SideBySide => {
            let all = g.read(GL_BACK, w, h);
            let half = (w / 2) as usize;
            let row = w as usize * 4;
            let cut = |skip: usize| all.chunks_exact(row).flat_map(|r| r[skip * 4..(skip + half) * 4].to_vec()).collect::<Vec<u8>>();
            (cut(0), cut(half))
        }
    };
    let eye_w = if shown == Shown::SideBySide { (w / 2) as usize } else { w as usize };
    let range = 64.min(eye_w as i32 / 4);
    let (d, s) = disparity(&grey(&l), &grey(&r), eye_w, h as usize, range);
    StereoReadback { left_sha256: sha(&l), right_sha256: sha(&r), left_mean: mean(&l), right_mean: mean(&r), disparity_px: d, disparity_score: s, gl_stereo: g.stereo(), renderer: g.renderer(), draw_buffers: used.iter().map(|b| buffer_name(*b).to_string()).collect() }
}
