//! A software OpenGL with the buffers of a stereo context: back and front, left and right. It is not
//! a mock that records calls: it draws, so a test reads back what each eye would have seen. It keeps
//! the rule that matters to the quad-buffer path: a colour buffer the context does not have gives
//! `GL_INVALID_OPERATION` and draws nothing.

use crate::gl::*;
use std::collections::HashMap;

struct Texture {
    w: u32,
    h: u32,
    rgba: Vec<u8>,
}

pub struct SoftGl {
    pub width: u32,
    pub height: u32,
    has_stereo: bool,
    /// RGBA, bottom row first, as OpenGL holds it.
    back_left: Vec<u8>,
    back_right: Vec<u8>,
    front_left: Vec<u8>,
    front_right: Vec<u8>,
    target: Option<u32>,
    mask: [bool; 3],
    view: [i32; 4],
    textures: HashMap<u32, Texture>,
    next: u32,
    err: u32,
    /// Every `glDrawBuffer` since the last swap, in order: the test's view of the stream.
    pub calls: Vec<u32>,
    pub swaps: u64,
}

impl SoftGl {
    pub fn new(width: u32, height: u32, stereo: bool) -> SoftGl {
        let n = (width * height * 4) as usize;
        let buf = || vec![0u8; n];
        SoftGl { width, height, has_stereo: stereo, back_left: buf(), back_right: if stereo { buf() } else { vec![] }, front_left: buf(), front_right: if stereo { buf() } else { vec![] }, target: Some(GL_BACK), mask: [true; 3], view: [0, 0, width as i32, height as i32], textures: HashMap::new(), next: 1, err: GL_NO_ERROR, calls: vec![], swaps: 0 }
    }

    /// `SwapBuffers`: both back buffers become the front ones.
    pub fn swap(&mut self) {
        std::mem::swap(&mut self.back_left, &mut self.front_left);
        std::mem::swap(&mut self.back_right, &mut self.front_right);
        self.swaps += 1;
        self.calls.clear();
    }

    fn set_err(&mut self, e: u32) {
        if self.err == GL_NO_ERROR {
            self.err = e;
        }
    }

    /// What the buffer named holds, or None if this context has no such buffer.
    fn buffers_of(&self, b: u32) -> Option<[u8; 2]> {
        // 0 is back left, 1 back right, 2 front left, 3 front right; 255 means none.
        match (b, self.has_stereo) {
            (GL_BACK, true) => Some([0, 1]),
            (GL_BACK, false) | (GL_BACK_LEFT, _) => Some([0, 255]),
            (GL_FRONT_LEFT, _) => Some([2, 255]),
            (GL_BACK_RIGHT, true) => Some([1, 255]),
            (GL_FRONT_RIGHT, true) => Some([3, 255]),
            _ => None,
        }
    }

    fn plane(&mut self, i: u8) -> &mut Vec<u8> {
        match i {
            0 => &mut self.back_left,
            1 => &mut self.back_right,
            2 => &mut self.front_left,
            _ => &mut self.front_right,
        }
    }

    fn put(&mut self, x: i32, y_up: i32, rgb: [u8; 3]) {
        let Some(t) = self.target else { return };
        let Some(bs) = self.buffers_of(t) else { return };
        let (w, mask) = (self.width as usize, self.mask);
        let at = (y_up as usize * w + x as usize) * 4;
        for i in bs {
            if i == 255 {
                continue;
            }
            let p = self.plane(i);
            for (c, on) in mask.iter().enumerate() {
                if *on {
                    p[at + c] = rgb[c];
                }
            }
            p[at + 3] = 255;
        }
    }
}

impl Gl for SoftGl {
    fn viewport(&mut self, x: i32, y: i32, w: i32, h: i32) {
        self.view = [x, y, w, h];
    }

    /// Like `glClear`, it obeys the colour mask and the buffer chosen, not the viewport's edges.
    fn clear(&mut self, rgb: [f32; 3]) {
        let v = rgb.map(|c| (c.clamp(0.0, 1.0) * 255.0).round() as u8);
        for y in 0..self.height as i32 {
            for x in 0..self.width as i32 {
                self.put(x, y, v);
            }
        }
    }

    fn draw_buffer(&mut self, buffer: u32) {
        self.calls.push(buffer);
        if self.buffers_of(buffer).is_none() {
            self.set_err(GL_INVALID_OPERATION);
            return;
        }
        self.target = Some(buffer);
    }

    fn color_mask(&mut self, r: bool, g: bool, b: bool) {
        self.mask = [r, g, b];
    }

    fn create_texture(&mut self, rgba: &[u8], w: u32, h: u32) -> u32 {
        let id = self.next;
        self.next += 1;
        self.textures.insert(id, Texture { w, h, rgba: rgba.to_vec() });
        id
    }

    fn delete_texture(&mut self, tex: u32) {
        self.textures.remove(&tex);
    }

    /// The parallelogram spanned by its first three corners, sampled at pixel centres, nearest.
    fn draw_quad(&mut self, q: &Quad) {
        let Some((tw, th)) = self.textures.get(&q.tex).map(|t| (t.w, t.h)) else {
            self.set_err(GL_INVALID_OPERATION);
            return;
        };
        let [ox, oy] = q.corners[0].map(|v| v as f64);
        let (ax, ay) = (q.corners[1][0] as f64 - ox, q.corners[1][1] as f64 - oy);
        let (bx, by) = (q.corners[3][0] as f64 - ox, q.corners[3][1] as f64 - oy);
        let det = ax * by - ay * bx;
        if det == 0.0 {
            return;
        }
        let [vx, vy, vw, vh] = self.view;
        let xs = q.corners.map(|c| c[0] as f64);
        let ys = q.corners.map(|c| c[1] as f64);
        let min = |v: &[f64; 4]| v.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = |v: &[f64; 4]| v.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let (x0, x1) = ((min(&xs).floor() as i32).max(0), (max(&xs).ceil() as i32).min(vw));
        let (y0, y1) = ((min(&ys).floor() as i32).max(0), (max(&ys).ceil() as i32).min(vh));
        let (uu, uv) = (q.uv[0] as f64, q.uv[1] as f64);
        for sy in y0..y1 {
            for sx in x0..x1 {
                let (px, py) = (sx as f64 + 0.5 - ox, sy as f64 + 0.5 - oy);
                let s = (px * by - py * bx) / det;
                let t = (ax * py - ay * px) / det;
                if !(0.0..1.0).contains(&s) || !(0.0..1.0).contains(&t) {
                    continue;
                }
                let tx = ((s * uu * tw as f64) as u32).min(tw - 1);
                let ty = ((t * uv * th as f64) as u32).min(th - 1);
                let at = ((ty * tw + tx) * 4) as usize;
                let tex = &self.textures[&q.tex].rgba;
                let rgb = [tex[at], tex[at + 1], tex[at + 2]];
                // The viewport's y counts up from the window's lower edge; the projection's down.
                let (wx, wy) = (vx + sx, vy + vh - 1 - sy);
                if wx >= 0 && wy >= 0 && wx < self.width as i32 && wy < self.height as i32 {
                    self.put(wx, wy, rgb);
                }
            }
        }
    }

    fn error(&mut self) -> u32 {
        std::mem::replace(&mut self.err, GL_NO_ERROR)
    }

    fn read(&mut self, buffer: u32, w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![0u8; (w * h * 4) as usize];
        let Some([i, _]) = self.buffers_of(buffer) else {
            self.set_err(GL_INVALID_OPERATION);
            return out;
        };
        let (sw, sh) = (self.width as usize, self.height as usize);
        let p = self.plane(i).clone();
        for y in 0..(h as usize).min(sh) {
            let from = (h as usize - 1 - y) * sw * 4;
            let n = (w as usize).min(sw) * 4;
            out[y * w as usize * 4..y * w as usize * 4 + n].copy_from_slice(&p[from..from + n]);
        }
        out
    }

    fn stereo(&mut self) -> bool {
        self.has_stereo
    }

    fn renderer(&mut self) -> String {
        "gwb-stereo software GL".into()
    }
}
