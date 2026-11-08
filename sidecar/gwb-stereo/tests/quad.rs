//! The quad-buffer path, proved in software: the real `present` and `Viewer` against a GL with four
//! colour buffers, and a pair whose answer is known. On Windows, the same code against the real
//! driver in a window that is never shown.

use gwb_sidecar_api::{StereoEye, StereoMode, StereoReport, StereoScene};
use gwb_stereo::feed::Source;
use gwb_stereo::gl::*;
use gwb_stereo::present::{choose, disparity, present, read_back, Shown};
use gwb_stereo::scene::TileKey;
use gwb_stereo::soft::SoftGl;
use gwb_stereo::viewer::Viewer;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TILE: u32 = 64;
const W: u32 = 320;
const H: u32 = 180;

/// Random texture, so a shift has one answer. The right eye's picture is the left's moved `d`
/// pixels to the right.
fn texture(x: i64, y: i64) -> u8 {
    let mut h = (x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663)) as u64;
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1e995);
    (h >> 24) as u8
}

struct Pair {
    size: u32,
    d: i64,
    tiles: Mutex<u32>,
    fail: bool,
}

impl Source for Pair {
    fn scene(&self) -> Result<StereoScene, String> {
        let e = |n: &str| StereoEye { name: n.into(), width: self.size, height: self.size, levels: vec![[self.size, self.size]], affine: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0] };
        Ok(StereoScene { tile: TILE, mode: StereoMode::Auto, left: e("l"), right: e("r") })
    }
    fn tile(&self, k: TileKey) -> Result<Vec<u8>, String> {
        *self.tiles.lock().unwrap() += 1;
        if self.fail {
            return Err("no such tile".into());
        }
        let mut o = Vec::new();
        for y in 0..TILE as i64 {
            for x in 0..TILE as i64 {
                let (ix, iy) = (k.x as i64 * TILE as i64 + x, k.y as i64 * TILE as i64 + y);
                let v = texture(if k.left { ix } else { ix - self.d }, iy);
                o.extend_from_slice(&[v, v, v, 255]);
            }
        }
        Ok(o)
    }
    fn report(&self, _: &StereoReport) -> Result<(), String> {
        Ok(())
    }
}

fn pair(d: i64) -> Arc<Pair> {
    Arc::new(Pair { size: 512, d, tiles: Mutex::new(0), fail: false })
}

fn loaded<G: Gl>(g: G, p: Arc<Pair>) -> Viewer<G, Pair> {
    let mut v = Viewer::new(g, p, W, H).unwrap();
    v.cam.zoom = 1.0;
    let t = Instant::now();
    while !v.complete() {
        assert!(t.elapsed() < Duration::from_secs(20), "tiles did not come");
        v.request();
        v.absorb(Duration::from_millis(50));
    }
    v
}

fn pixels(g: &mut impl Gl, b: u32) -> Vec<u8> {
    g.read(b, W, H)
}

/// What an eye must see at zoom 1 with the camera on `(cx, cy)`, drawn here by hand.
fn expected(cx: f64, cy: f64, d: i64, right: bool, px: f64) -> Vec<u8> {
    let mut o = Vec::new();
    let shift = if right { px / 2.0 } else { -px / 2.0 };
    for y in 0..H as i64 {
        for x in 0..W as i64 {
            let ix = (x as f64 + 0.5 - W as f64 / 2.0 - shift + cx).floor() as i64;
            let iy = (y as f64 + 0.5 - H as f64 / 2.0 + cy).floor() as i64;
            let v = if !(0..512).contains(&ix) || !(0..512).contains(&iy) { 0 } else { texture(if right { ix - d } else { ix }, iy) };
            o.extend_from_slice(&[v, v, v, 255]);
        }
    }
    o
}

#[test]
fn each_eye_gets_its_own_buffer_and_nothing_else() {
    let mut v = loaded(SoftGl::new(W, H, true), pair(0));
    assert_eq!(v.shown, Shown::Quad);
    let c = v.cam;
    v.draw().unwrap();
    assert_eq!(v.used, [GL_BACK_LEFT, GL_BACK_RIGHT], "left, then right, and no other buffer");
    assert_eq!(v.gl.calls, [GL_BACK_LEFT, GL_BACK_RIGHT]);
    assert_eq!(pixels(&mut v.gl, GL_BACK_LEFT), expected(c.cx, c.cy, 0, false, 0.0));
    assert_eq!(pixels(&mut v.gl, GL_BACK_RIGHT), expected(c.cx, c.cy, 0, true, 0.0));
    assert_eq!(v.gl.error(), GL_NO_ERROR);
}

#[test]
fn the_right_eye_is_the_right_image() {
    // A known shift of 12 pixels: buffers match the hand-drawn pictures, byte for byte, and the
    // correlation measures it.
    let mut v = loaded(SoftGl::new(W, H, true), pair(12));
    let c = v.cam;
    v.draw().unwrap();
    let (l, r) = (pixels(&mut v.gl, GL_BACK_LEFT), pixels(&mut v.gl, GL_BACK_RIGHT));
    assert_eq!(l, expected(c.cx, c.cy, 12, false, 0.0));
    assert_eq!(r, expected(c.cx, c.cy, 12, true, 0.0));
    assert_ne!(l, r);
    let rb = read_back(&mut v.gl, Shown::Quad, W, H, &[GL_BACK_LEFT, GL_BACK_RIGHT]);
    assert!((rb.disparity_px - 12.0).abs() < 0.1, "{}", rb.disparity_px);
    assert!(rb.disparity_score > 0.95, "{}", rb.disparity_score);
    assert!(rb.gl_stereo);
    assert_eq!(rb.draw_buffers, ["GL_BACK_LEFT", "GL_BACK_RIGHT"]);
    assert_ne!(rb.left_sha256, rb.right_sha256);
}

#[test]
fn parallax_moves_only_what_it_should() {
    let mut v = loaded(SoftGl::new(W, H, true), pair(12));
    v.cam.parallax_x = -12.0; // cancels the pair's own shift
    v.draw().unwrap();
    let rb = read_back(&mut v.gl, Shown::Quad, W, H, &v.used.clone());
    assert!(rb.disparity_px.abs() < 0.1, "{}", rb.disparity_px);
    v.cam.parallax_x = 8.0;
    v.draw().unwrap();
    let rb = read_back(&mut v.gl, Shown::Quad, W, H, &v.used.clone());
    assert!((rb.disparity_px - 20.0).abs() < 0.1, "{}", rb.disparity_px);
}

#[test]
fn a_swap_presents_both_eyes_together() {
    let mut v = loaded(SoftGl::new(W, H, true), pair(5));
    v.draw().unwrap();
    let (l, r) = (pixels(&mut v.gl, GL_BACK_LEFT), pixels(&mut v.gl, GL_BACK_RIGHT));
    v.gl.swap();
    assert_eq!(pixels(&mut v.gl, GL_FRONT_LEFT), l);
    assert_eq!(pixels(&mut v.gl, GL_FRONT_RIGHT), r);
    assert_eq!(v.gl.swaps, 1);
}

#[test]
fn a_mono_context_has_no_right_buffer() {
    // The rule the fallback rests on: the spec's GL_INVALID_OPERATION, and the frame is refused.
    let mut g = SoftGl::new(W, H, false);
    let e = present(&mut g, Shown::Quad, W, H, &[], &[]).unwrap_err();
    assert!(e.contains("GL_BACK_RIGHT") && e.contains("0x502"), "{e}");
}

#[test]
fn asked_for_quad_with_no_quad_display_says_so() {
    assert_eq!(choose(StereoMode::Auto, true), (Shown::Quad, None));
    assert_eq!(choose(StereoMode::Quad, true), (Shown::Quad, None));
    assert_eq!(choose(StereoMode::Auto, false), (Shown::Anaglyph, None));
    let (m, why) = choose(StereoMode::Quad, false);
    assert_eq!(m, Shown::Anaglyph);
    assert!(why.unwrap().contains("no quad-buffer"));
    assert_eq!(choose(StereoMode::SideBySide, true).0, Shown::SideBySide);
    assert_eq!(choose(StereoMode::Anaglyph, true).0, Shown::Anaglyph);
    let mut v = loaded(SoftGl::new(W, H, false), pair(9));
    assert_eq!(v.shown, Shown::Anaglyph);
    assert!(!v.quad_available);
    v.draw().unwrap();
    assert_eq!(v.used, [GL_BACK]);
}

#[test]
fn anaglyph_keeps_the_eyes_in_their_channels() {
    let mut v = loaded(SoftGl::new(W, H, false), pair(9));
    let c = v.cam;
    v.draw().unwrap();
    let all = pixels(&mut v.gl, GL_BACK);
    let (l, r) = (expected(c.cx, c.cy, 9, false, 0.0), expected(c.cx, c.cy, 9, true, 0.0));
    for i in 0..all.len() / 4 {
        assert_eq!(all[i * 4], l[i * 4], "red is the left eye at {i}");
        assert_eq!(all[i * 4 + 1], r[i * 4], "green is the right eye at {i}");
        assert_eq!(all[i * 4 + 2], r[i * 4], "blue is the right eye at {i}");
    }
    let rb = read_back(&mut v.gl, Shown::Anaglyph, W, H, &[GL_BACK]);
    assert!((rb.disparity_px - 9.0).abs() < 0.1, "{}", rb.disparity_px);
}

#[test]
fn side_by_side_splits_the_window() {
    let mut v = loaded(SoftGl::new(W, H, true), pair(7));
    v.shown = Shown::SideBySide;
    v.draw().unwrap();
    let rb = read_back(&mut v.gl, Shown::SideBySide, W, H, &[GL_BACK]);
    assert!((rb.disparity_px - 7.0).abs() < 0.1, "{}", rb.disparity_px);
}

#[test]
fn a_coarse_level_shows_until_the_fine_one_comes() {
    // Two levels; only the coarse tile has arrived, and the frame is not empty.
    struct Two;
    impl Source for Two {
        fn scene(&self) -> Result<StereoScene, String> {
            let e = |n: &str| StereoEye { name: n.into(), width: 128, height: 128, levels: vec![[128, 128], [64, 64]], affine: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0] };
            Ok(StereoScene { tile: TILE, mode: StereoMode::Auto, left: e("l"), right: e("r") })
        }
        fn tile(&self, k: TileKey) -> Result<Vec<u8>, String> {
            if k.level == 0 {
                std::thread::sleep(Duration::from_secs(30));
            }
            Ok(vec![200; (TILE * TILE * 4) as usize])
        }
        fn report(&self, _: &StereoReport) -> Result<(), String> {
            Ok(())
        }
    }
    let mut v = Viewer::new(SoftGl::new(W, H, true), Arc::new(Two), W, H).unwrap();
    v.cam.zoom = 0.5;
    v.request();
    assert!(v.needed().iter().all(|k| k.level == 1));
    let t = Instant::now();
    while !v.complete() {
        assert!(t.elapsed() < Duration::from_secs(10));
        v.absorb(Duration::from_millis(20));
    }
    v.cam.zoom = 1.0; // now wants level 0, which is slow
    v.request();
    assert!(!v.complete());
    v.draw().unwrap();
    let l = pixels(&mut v.gl, GL_BACK_LEFT);
    assert!(l.chunks_exact(4).any(|p| p[0] == 200), "the coarse tile is on the screen");
}

#[test]
fn a_tile_that_fails_is_named_and_does_not_stop_the_frame() {
    let p = Arc::new(Pair { size: 512, d: 0, tiles: Mutex::new(0), fail: true });
    let mut v = Viewer::new(SoftGl::new(W, H, true), p.clone(), W, H).unwrap();
    let t = Instant::now();
    while !v.complete() {
        assert!(t.elapsed() < Duration::from_secs(10));
        v.request();
        v.absorb(Duration::from_millis(20));
    }
    assert!(v.note.as_deref().unwrap().contains("no such tile"));
    let asked = *p.tiles.lock().unwrap();
    // A tile fetched and not yet taken is still in flight: asking again would fetch it twice.
    assert_eq!(asked as usize, v.needed().len(), "each tile is asked for once");
    for _ in 0..5 {
        v.request();
        v.absorb(Duration::from_millis(5));
    }
    assert_eq!(*p.tiles.lock().unwrap(), asked, "a bad tile is not asked for again and again");
    v.draw().unwrap();
}

#[test]
fn a_short_tile_is_refused() {
    struct Short;
    impl Source for Short {
        fn scene(&self) -> Result<StereoScene, String> {
            pair(0).scene()
        }
        fn tile(&self, _: TileKey) -> Result<Vec<u8>, String> {
            Ok(vec![0; 10])
        }
        fn report(&self, _: &StereoReport) -> Result<(), String> {
            Ok(())
        }
    }
    let mut v = Viewer::new(SoftGl::new(W, H, true), Arc::new(Short), W, H).unwrap();
    let t = Instant::now();
    while !v.complete() {
        assert!(t.elapsed() < Duration::from_secs(10));
        v.request();
        v.absorb(Duration::from_millis(20));
    }
    assert!(v.note.as_deref().unwrap().contains("10 bytes"));
}

#[test]
fn disparity_is_measured_to_a_tenth_of_a_pixel() {
    let (w, h) = (256usize, 64usize);
    for d in [-20, -3, 0, 1, 7, 31] {
        let a: Vec<f32> = (0..w * h).map(|i| texture((i % w) as i64, (i / w) as i64) as f32).collect();
        let b: Vec<f32> = (0..w * h).map(|i| texture((i % w) as i64 - d, (i / w) as i64) as f32).collect();
        let (m, s) = disparity(&a, &b, w, h, 40);
        assert!((m - d as f64).abs() < 0.1, "{d}: {m}");
        assert!(s > 0.9, "{d}: {s}");
    }
    let flat = vec![10.0f32; w * h];
    assert_eq!(disparity(&flat, &flat, w, h, 40).1, 0.0, "no texture, no score");
}

/// The real driver, in a window that is never shown. The display here has no stereo format, so this
/// proves the rest of the path on real OpenGL: the mono fallback, the buffers, the read-back.
#[cfg(windows)]
#[test]
fn the_real_driver_draws_what_the_software_gl_draws() {
    use gwb_stereo::wgl::{Window, WglGl};
    let w = match Window::create("gwb-stereo test", W as i32, H as i32, true, false) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("skipped: {e}");
            return;
        }
    };
    let mut gl = WglGl::new();
    gl.viewport(0, 0, W as i32, H as i32);
    let renderer = gl.renderer();
    // A machine with no graphics driver, such as a CI runner, gets Windows' software OpenGL 1.1,
    // which is the fallback this test is meant to look past, not the real driver.
    if renderer.contains("GDI Generic") {
        eprintln!("skipped: no real OpenGL driver ({renderer})");
        return;
    }
    let stereo = gl.stereo();
    assert_eq!(stereo, w.stereo_formats > 0, "{renderer}: GL_STEREO against {} stereo formats", w.stereo_formats);
    let mut real = loaded(gl, pair(12));
    real.draw().unwrap();
    assert_eq!(real.used, if stereo { vec![GL_BACK_LEFT, GL_BACK_RIGHT] } else { vec![GL_BACK] });
    let rb = real.read_back();
    assert_eq!(real.gl.error(), GL_NO_ERROR);
    println!("real driver: {renderer}, stereo formats {}, disparity {:.2} px, score {:.3}", w.stereo_formats, rb.disparity_px, rb.disparity_score);
    if rb.disparity_score < 0.5 {
        // A window never shown owns no pixels on some drivers; say so instead of failing on it.
        eprintln!("skipped: this driver gave nothing back from a hidden window ({renderer})");
        return;
    }
    assert!((rb.disparity_px - 12.0).abs() < 0.5, "{}", rb.disparity_px);
    // Every pixel read belongs to the window: its means are the software GL's.
    let mut soft = loaded(SoftGl::new(W, H, false), pair(12));
    soft.draw().unwrap();
    let want = soft.read_back();
    assert!((rb.left_mean[0] - want.left_mean[0]).abs() < 1.0, "{} against {}", rb.left_mean[0], want.left_mean[0]);
    assert!((rb.right_mean[0] - want.right_mean[0]).abs() < 1.0, "{} against {}", rb.right_mean[0], want.right_mean[0]);
    // The refusal on the real driver, when it has no right buffer.
    if !stereo {
        let e = present(&mut real.gl, Shown::Quad, W, H, &[], &[]).unwrap_err();
        assert!(e.contains("GL_BACK_RIGHT"), "{e}");
        while real.gl.error() != GL_NO_ERROR {}
    }
}
