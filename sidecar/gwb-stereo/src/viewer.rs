//! The viewer without its window: tiles in, frames out. `main` gives it a device; the tests give it
//! the software GL and a source of their own.

use crate::feed::{Fetcher, Source};
use crate::gl::{Gl, Quad};
use crate::present::{choose, present, read_back, Shown};
use crate::scene::{fit, Camera, Eye, EyeGeom, TileKey};
use gwb_sidecar_api::{StereoMode, StereoReadback, StereoReport, StereoState};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::Duration;

/// Textures kept: at 1 MiB each, more than a 4K screen of both eyes at two levels.
pub const MAX_TEXTURES: usize = 400;

pub struct Viewer<G: Gl, S: Source> {
    pub gl: G,
    pub src: Arc<S>,
    fetch: Fetcher,
    left: EyeGeom,
    right: EyeGeom,
    tile: u32,
    asked: StereoMode,
    pub shown: Shown,
    /// Why the mode is not the one asked for, or what went wrong with a tile.
    pub note: Option<String>,
    pub quad_available: bool,
    pub cam: Camera,
    pub w: u32,
    pub h: u32,
    cache: HashMap<TileKey, (u32, u64)>,
    bad: HashSet<TileKey>,
    clock: u64,
    pub frames: u64,
    pub used: Vec<u32>,
}

impl<G: Gl, S: Source + 'static> Viewer<G, S> {
    pub fn new(mut gl: G, src: Arc<S>, w: u32, h: u32) -> Result<Viewer<G, S>, String> {
        let scene = src.scene()?;
        if scene.tile == 0 || scene.tile > 4096 {
            return Err("the scene's tile size is out of range".into());
        }
        let (left, right) = (EyeGeom::new(&scene.left)?, EyeGeom::new(&scene.right)?);
        let quad_available = gl.stereo();
        let (shown, note) = choose(scene.mode, quad_available);
        let eye_w = if shown == Shown::SideBySide { w / 2 } else { w };
        let cam = fit(&left, &right, eye_w, h);
        let fetch = Fetcher::start(src.clone(), 4);
        Ok(Viewer { gl, src, fetch, left, right, tile: scene.tile, asked: scene.mode, shown, note, quad_available, cam, w, h, cache: HashMap::new(), bad: HashSet::new(), clock: 0, frames: 0, used: vec![] })
    }

    fn eye_w(&self) -> u32 {
        if self.shown == Shown::SideBySide {
            self.w / 2
        } else {
            self.w
        }
    }

    fn keys_for(&self, geom: &EyeGeom, eye: Eye) -> Vec<TileKey> {
        let l = geom.level_for(&self.cam);
        geom.visible(&self.cam, eye, self.eye_w(), self.h, self.tile, l)
    }

    /// What the screen needs now, both eyes in turn so neither starves.
    pub fn needed(&self) -> Vec<TileKey> {
        let (a, b) = (self.keys_for(&self.left, Eye::Left), self.keys_for(&self.right, Eye::Right));
        let mut out = Vec::with_capacity(a.len() + b.len());
        for i in 0..a.len().max(b.len()) {
            out.extend(a.get(i));
            out.extend(b.get(i));
        }
        out
    }

    pub fn request(&mut self) {
        let want: Vec<TileKey> = self.needed().into_iter().filter(|k| !self.cache.contains_key(k) && !self.bad.contains(k)).collect();
        self.fetch.want(want);
    }

    /// True when every tile the screen needs has come.
    pub fn complete(&self) -> bool {
        self.needed().iter().all(|k| self.cache.contains_key(k) || self.bad.contains(k))
    }

    fn take(&mut self, key: TileKey, rgba: Result<Vec<u8>, String>) -> bool {
        if self.cache.contains_key(&key) {
            return false; // asked for twice around the moment it arrived
        }
        let need = (self.tile * self.tile * 4) as usize;
        match rgba {
            Ok(b) if b.len() == need => {
                self.clock += 1;
                let tex = self.gl.create_texture(&b, self.tile, self.tile);
                self.cache.insert(key, (tex, self.clock));
                true
            }
            Ok(b) => {
                self.bad.insert(key);
                self.note = Some(format!("a tile came with {} bytes, not {need}", b.len()));
                false
            }
            Err(e) => {
                self.bad.insert(key);
                self.note = Some(format!("a tile could not be read: {e}"));
                false
            }
        }
    }

    /// Take what has arrived, waiting up to `wait` for the first. True if a tile is new.
    pub fn absorb(&mut self, wait: Duration) -> bool {
        let mut got = false;
        match self.fetch.rx.recv_timeout(wait) {
            Ok(l) => got |= self.take(l.key, l.rgba),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => return false,
        }
        while let Ok(l) = self.fetch.rx.try_recv() {
            got |= self.take(l.key, l.rgba);
        }
        self.evict();
        got
    }

    fn evict(&mut self) {
        if self.cache.len() <= MAX_TEXTURES {
            return;
        }
        let keep: HashSet<TileKey> = self.needed().into_iter().collect();
        let mut old: Vec<(u64, TileKey)> = self.cache.iter().filter(|(k, _)| !keep.contains(k)).map(|(k, v)| (v.1, *k)).collect();
        old.sort();
        for (_, k) in old.into_iter().take(self.cache.len() - MAX_TEXTURES) {
            if let Some((t, _)) = self.cache.remove(&k) {
                self.gl.delete_texture(t);
            }
        }
    }

    /// An eye's tiles: coarser levels first, so a level not yet here shows the one above it.
    pub fn quads(&mut self, eye: Eye) -> Vec<Quad> {
        let geom = if eye == Eye::Left { &self.left } else { &self.right };
        let target = geom.level_for(&self.cam);
        let mut out = Vec::new();
        self.clock += 1;
        let top = geom.levels.len() as u32 - 1;
        let eye_w = self.eye_w();
        for level in (target..=top).rev() {
            for k in geom.visible(&self.cam, eye, eye_w, self.h, self.tile, level) {
                if let Some(e) = self.cache.get_mut(&k) {
                    e.1 = self.clock;
                    out.push(geom.quad(&self.cam, eye, eye_w, self.h, self.tile, &k, e.0));
                }
            }
        }
        out
    }

    /// One frame into the back buffers. The caller reads them, if it wants to, and swaps.
    pub fn draw(&mut self) -> Result<(), String> {
        let (l, r) = (self.quads(Eye::Left), self.quads(Eye::Right));
        self.used = present(&mut self.gl, self.shown, self.w, self.h, &l, &r)?;
        self.frames += 1;
        Ok(())
    }

    pub fn read_back(&mut self) -> StereoReadback {
        read_back(&mut self.gl, self.shown, self.w, self.h, &self.used)
    }

    pub fn report(&self, state: StereoState, readback: Option<StereoReadback>) -> StereoReport {
        StereoReport { state, shown: self.shown.api(), quad_available: self.quad_available, frames: self.frames, detail: self.note.clone(), readback }
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.w = w.max(1);
        self.h = h.max(1);
        self.gl.viewport(0, 0, self.w as i32, self.h as i32);
    }

    pub fn pan(&mut self, dx_px: f64, dy_px: f64) {
        self.cam.cx -= dx_px / self.cam.zoom;
        self.cam.cy -= dy_px / self.cam.zoom;
    }

    pub fn zoom_by(&mut self, factor: f64) {
        self.cam.zoom = (self.cam.zoom * factor).clamp(1e-4, 64.0);
    }

    pub fn fit(&mut self) {
        let (px, py) = (self.cam.parallax_x, self.cam.parallax_y);
        self.cam = fit(&self.left, &self.right, self.eye_w(), self.h);
        self.cam.parallax_x = px;
        self.cam.parallax_y = py;
    }

    /// The next mode this display can show.
    pub fn next_mode(&mut self) {
        self.shown = match self.shown {
            Shown::Quad => Shown::Anaglyph,
            Shown::Anaglyph => Shown::SideBySide,
            Shown::SideBySide if self.quad_available => Shown::Quad,
            Shown::SideBySide => Shown::Anaglyph,
        };
        self.note = None;
    }

    pub fn asked(&self) -> StereoMode {
        self.asked
    }
}
