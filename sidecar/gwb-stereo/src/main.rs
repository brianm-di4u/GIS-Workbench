//! `gwb-stereo-viewer --sidecar 127.0.0.1:<port> --session <id>` (the ticket in GWB_STEREO_TICKET):
//! the sidecar starts it for a paired page.
//! `gwb-stereo-viewer --test-pattern`: the hardware test, with no sidecar (an L for the left eye, an
//! R for the right).
//! `--device soft-quad|soft-mono|hidden`: no window on the screen, for tests: the software GL with or
//! without a right buffer, or the real driver in a window never shown.
//! `--test-exit-after N`: the real window, without taking the focus, closing itself after N frames
//! and printing what it showed. The one test of the window loop; it opens and closes by itself.
//!
//! Keys: arrows parallax (shift for y), M next mode, F whole screen, Home fit, Esc close. Mouse: drag
//! to pan, wheel to zoom.
#![windows_subsystem = "windows"]

use gwb_sidecar_api::{StereoReport, StereoState};
use gwb_stereo::feed::{Link, Pattern, Source};
use gwb_stereo::gl::Gl;
use gwb_stereo::soft::SoftGl;
use gwb_stereo::viewer::Viewer;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const TEST_W: u32 = 960;
const TEST_H: u32 = 540;
/// A frame's tiles can take this long on a very large file.
const FIRST_FRAME: Duration = Duration::from_secs(180);

/// Tell the sidecar what is happening, and leave if it has gone: a viewer outlives nothing.
fn heartbeat<S: Source + 'static>(src: Arc<S>, last: Arc<Mutex<Option<StereoReport>>>) {
    std::thread::spawn(move || {
        let mut fails = 0;
        let mut sent: Option<StereoReport> = None;
        let mut at = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let now = last.lock().unwrap().clone();
            let Some(r) = now else { continue };
            if sent.as_ref() == Some(&r) && at.elapsed() < Duration::from_secs(2) {
                continue;
            }
            match src.report(&r) {
                Ok(()) => {
                    fails = 0;
                    sent = Some(r);
                    at = Instant::now();
                }
                Err(_) => {
                    fails += 1;
                    if fails >= 4 {
                        std::process::exit(0);
                    }
                }
            }
        }
    });
}

/// A device with no window: draw the pair once, read the buffers back, report, and stay until the
/// sidecar ends the session.
fn run_test<G: Gl, S: Source + 'static>(mut v: Viewer<G, S>, swap: impl Fn(&mut G)) -> Result<(), String> {
    let last = Arc::new(Mutex::new(Some(v.report(StereoState::Starting, None))));
    heartbeat(v.src.clone(), last.clone());
    let start = Instant::now();
    while !v.complete() {
        if start.elapsed() > FIRST_FRAME {
            return Err("the first frame's tiles did not come".into());
        }
        v.request();
        v.absorb(Duration::from_millis(200));
    }
    v.draw()?;
    let rb = v.read_back();
    swap(&mut v.gl);
    *last.lock().unwrap() = Some(v.report(StereoState::Showing, Some(rb)));
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

#[cfg(windows)]
fn run_window<S: Source + 'static>(src: Arc<S>, want_title: &str, exit_after: Option<u64>) -> Result<(), String> {
    use gwb_stereo::wgl::{Event, Window, WglGl};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    let mut win = Window::create(want_title, 1280, 800, true, exit_after.is_none())?;
    if exit_after.is_some() {
        win.show_quietly();
    }
    let gl = WglGl::new();
    let mut v = Viewer::new(gl, src.clone(), 1280, 800)?;
    v.gl.viewport(0, 0, v.w as i32, v.h as i32);
    let last = Arc::new(Mutex::new(None));
    heartbeat(src, last.clone());
    let mut dirty = true;
    let mut shown_once = false;
    loop {
        for e in win.events(if dirty { 0 } else { 15 }) {
            dirty = true;
            match e {
                Event::Close => return Ok(()),
                Event::Resize(w, h) if w > 0 && h > 0 => v.resize(w, h),
                Event::Drag(x, y) => v.pan(x as f64, y as f64),
                Event::Wheel(d) => v.zoom_by(1.2f64.powf(d as f64 / 120.0)),
                Event::Key(k) => {
                    let k = k as u16;
                    let shift = unsafe { GetKeyState(VK_SHIFT as i32) } < 0;
                    match k {
                        VK_ESCAPE => return Ok(()),
                        VK_LEFT if !shift => v.cam.parallax_x -= 1.0,
                        VK_RIGHT if !shift => v.cam.parallax_x += 1.0,
                        VK_UP if shift => v.cam.parallax_y -= 1.0,
                        VK_DOWN if shift => v.cam.parallax_y += 1.0,
                        VK_HOME => v.fit(),
                        0x4D => v.next_mode(),
                        0x46 => win.toggle_fullscreen(),
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        v.request();
        dirty |= v.absorb(Duration::ZERO);
        if dirty {
            v.draw()?;
            win.swap();
            win.set_title(&format!("{want_title}: {}, parallax {:+.0} px", v.shown.name(), v.cam.parallax_x));
            let done = v.complete();
            shown_once |= done;
            if exit_after.is_some_and(|n| done && v.frames >= n) {
                use std::io::Write;
                let _ = writeln!(std::io::stdout(), "frames={} shown={} quad={} renderer={}", v.frames, v.shown.name(), v.quad_available, v.gl.renderer());
                return Ok(());
            }
            // A self-closing run has nothing to wait for between frames.
            dirty = exit_after.is_some();
            *last.lock().unwrap() = Some(v.report(if shown_once { StereoState::Showing } else { StereoState::Starting }, None));
        }
    }
}

#[cfg(windows)]
fn run_hidden<S: Source + 'static>(src: Arc<S>) -> Result<(), String> {
    use gwb_stereo::wgl::{Window, WglGl};
    let win = Window::create("GIS Workbench stereo (test)", TEST_W as i32, TEST_H as i32, true, false)?;
    let mut gl = WglGl::new();
    gl.viewport(0, 0, TEST_W as i32, TEST_H as i32);
    let v = Viewer::new(gl, src, TEST_W, TEST_H)?;
    let w = &win;
    run_test(v, move |_| w.swap())
}

#[cfg(not(windows))]
fn run_hidden<S: Source + 'static>(_: Arc<S>) -> Result<(), String> {
    Err("no window on this platform".into())
}

#[cfg(not(windows))]
fn run_window<S: Source + 'static>(_: Arc<S>, _: &str, _: Option<u64>) -> Result<(), String> {
    Err("the native window is built for Windows only in this release".into())
}

fn run_device<S: Source + 'static>(src: Arc<S>, device: Option<&str>, title: &str, exit_after: Option<u64>) -> Result<(), String> {
    match device {
        None => run_window(src, title, exit_after),
        Some("hidden") => run_hidden(src),
        Some(d @ ("soft-quad" | "soft-mono")) => {
            let v = Viewer::new(SoftGl::new(TEST_W, TEST_H, d == "soft-quad"), src, TEST_W, TEST_H)?;
            run_test(v, |g| g.swap())
        }
        Some(o) => Err(format!("unknown device {o}")),
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let val = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).map(String::as_str);
    let device = val("--device");
    let exit_after = val("--test-exit-after").map(|v| v.parse::<u64>().map_err(|_| "--test-exit-after needs a number")).transpose()?;
    if args.iter().any(|a| a == "--test-pattern") {
        return run_device(Arc::new(Pattern), device, "GIS Workbench stereo test pattern", exit_after);
    }
    let addr = val("--sidecar").ok_or("--sidecar 127.0.0.1:<port> is needed")?;
    let session = val("--session").ok_or("--session is needed")?;
    let ticket = std::env::var("GWB_STEREO_TICKET").map_err(|_| "GWB_STEREO_TICKET is not set")?;
    run_device(Arc::new(Link::new(addr, session, &ticket)?), device, "GIS Workbench stereo", exit_after)
}

fn main() {
    if let Err(e) = run() {
        use std::io::Write;
        let _ = writeln!(std::io::stderr(), "gwb-stereo-viewer: {e}");
        std::process::exit(1);
    }
}
