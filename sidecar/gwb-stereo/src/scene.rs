//! From a camera to the tiles of each eye. Both eyes share one display plane, as in the app's stereo
//! panel: an affine takes the plane to each image, and that is how the app's epipolar fit reaches
//! the viewer. Parallax moves the two eyes apart on the screen.

use crate::gl::Quad;
use gwb_sidecar_api::StereoEye;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eye {
    Left,
    Right,
}

impl Eye {
    pub fn name(self) -> &'static str {
        match self {
            Eye::Left => "left",
            Eye::Right => "right",
        }
    }
    fn sign(self) -> f64 {
        match self {
            Eye::Left => -1.0,
            Eye::Right => 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    /// The display plane's point at the middle of the screen.
    pub cx: f64,
    pub cy: f64,
    /// Screen pixels per unit of the display plane.
    pub zoom: f64,
    /// Screen pixels the right eye sits to the right of the left, half each way.
    pub parallax_x: f64,
    pub parallax_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TileKey {
    pub left: bool,
    pub level: u32,
    pub x: u32,
    pub y: u32,
}

/// One eye's geometry: the affine (plane to image) and its inverse.
#[derive(Debug, Clone)]
pub struct EyeGeom {
    pub levels: Vec<[u32; 2]>,
    pub width: u32,
    pub height: u32,
    a: [f64; 6],
    inv: [f64; 6],
    /// Image pixels per unit of the plane.
    scale: f64,
}

pub fn invert(a: &[f64; 6]) -> Option<[f64; 6]> {
    let det = a[0] * a[4] - a[1] * a[3];
    if !det.is_finite() || det == 0.0 {
        return None;
    }
    let (ia, ib, id, ie) = (a[4] / det, -a[1] / det, -a[3] / det, a[0] / det);
    Some([ia, ib, -(ia * a[2] + ib * a[5]), id, ie, -(id * a[2] + ie * a[5])])
}

fn apply(a: &[f64; 6], x: f64, y: f64) -> (f64, f64) {
    (a[0] * x + a[1] * y + a[2], a[3] * x + a[4] * y + a[5])
}

impl EyeGeom {
    pub fn new(e: &StereoEye) -> Result<EyeGeom, String> {
        let inv = invert(&e.affine).ok_or("an eye's affine has no inverse")?;
        if e.levels.is_empty() || e.width == 0 || e.height == 0 {
            return Err("an eye has no levels".into());
        }
        let det = e.affine[0] * e.affine[4] - e.affine[1] * e.affine[3];
        Ok(EyeGeom { levels: e.levels.clone(), width: e.width, height: e.height, a: e.affine, inv, scale: det.abs().sqrt() })
    }

    fn to_screen(&self, c: &Camera, eye: Eye, w: f64, h: f64, ix: f64, iy: f64) -> (f64, f64) {
        let (u, v) = apply(&self.inv, ix, iy);
        ((u - c.cx) * c.zoom + w / 2.0 + eye.sign() * c.parallax_x / 2.0, (v - c.cy) * c.zoom + h / 2.0 + eye.sign() * c.parallax_y / 2.0)
    }

    fn to_image(&self, c: &Camera, eye: Eye, w: f64, h: f64, sx: f64, sy: f64) -> (f64, f64) {
        let u = (sx - w / 2.0 - eye.sign() * c.parallax_x / 2.0) / c.zoom + c.cx;
        let v = (sy - h / 2.0 - eye.sign() * c.parallax_y / 2.0) / c.zoom + c.cy;
        apply(&self.a, u, v)
    }

    /// The finest level that is no finer than the screen.
    pub fn level_for(&self, c: &Camera) -> u32 {
        let per_screen_px = self.scale / c.zoom;
        let l = if per_screen_px <= 1.0 { 0 } else { per_screen_px.log2().floor() as u32 };
        l.min(self.levels.len() as u32 - 1)
    }

    /// The tiles of `level` that touch a screen of `w` × `h`, nearest the middle first.
    pub fn visible(&self, c: &Camera, eye: Eye, w: u32, h: u32, tile: u32, level: u32) -> Vec<TileKey> {
        let (fw, fh) = (w as f64, h as f64);
        let corners = [(0.0, 0.0), (fw, 0.0), (fw, fh), (0.0, fh)].map(|(x, y)| self.to_image(c, eye, fw, fh, x, y));
        let size = tile as f64 * (1u64 << level) as f64;
        let [lw, lh] = self.levels[level as usize];
        let (nx, ny) = (lw.div_ceil(tile), lh.div_ceil(tile));
        let range = |vals: [f64; 4], n: u32| {
            let lo = vals.iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let a = (lo / size).floor().max(0.0);
            let b = ((hi / size).ceil()).min(n as f64);
            (a as u32, (b.max(0.0)) as u32)
        };
        let (x0, x1) = range(corners.map(|p| p.0), nx);
        let (y0, y1) = range(corners.map(|p| p.1), ny);
        let (mx, my) = self.to_image(c, eye, fw, fh, fw / 2.0, fh / 2.0);
        let mut out = Vec::new();
        for y in y0..y1 {
            for x in x0..x1 {
                out.push(TileKey { left: eye == Eye::Left, level, x, y });
            }
        }
        let dist = |k: &TileKey| ((k.x as f64 + 0.5) * size - mx).powi(2) + ((k.y as f64 + 0.5) * size - my).powi(2);
        out.sort_by(|a, b| dist(a).total_cmp(&dist(b)));
        out
    }

    /// Where a tile goes on the screen, and how much of it holds image.
    pub fn quad(&self, c: &Camera, eye: Eye, w: u32, h: u32, tile: u32, k: &TileKey, tex: u32) -> Quad {
        let (fw, fh) = (w as f64, h as f64);
        let s = (1u64 << k.level) as f64;
        let [lw, lh] = self.levels[k.level as usize];
        let t = tile as f64;
        let (x0, y0) = (k.x as f64 * t, k.y as f64 * t);
        let (x1, y1) = ((x0 + t).min(lw as f64), (y0 + t).min(lh as f64));
        let p = |x: f64, y: f64| {
            let (a, b) = self.to_screen(c, eye, fw, fh, x * s, y * s);
            [a as f32, b as f32]
        };
        Quad { tex, corners: [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)], uv: [((x1 - x0) / t) as f32, ((y1 - y0) / t) as f32] }
    }

    /// The display plane's box of the image.
    fn plane_box(&self) -> (f64, f64, f64, f64) {
        let (w, h) = (self.width as f64, self.height as f64);
        let c = [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].map(|(x, y)| apply(&self.inv, x, y));
        let xs = c.map(|p| p.0);
        let ys = c.map(|p| p.1);
        (xs.iter().cloned().fold(f64::INFINITY, f64::min), ys.iter().cloned().fold(f64::INFINITY, f64::min), xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max), ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
    }
}

/// The camera that shows what the two eyes have in common.
pub fn fit(l: &EyeGeom, r: &EyeGeom, w: u32, h: u32) -> Camera {
    let (a, b) = (l.plane_box(), r.plane_box());
    let (x0, y0, x1, y1) = (a.0.max(b.0), a.1.max(b.1), a.2.min(b.2), a.3.min(b.3));
    let (x0, y0, x1, y1) = if x1 > x0 && y1 > y0 { (x0, y0, x1, y1) } else { a };
    let zoom = (w as f64 / (x1 - x0)).min(h as f64 / (y1 - y0));
    Camera { cx: (x0 + x1) / 2.0, cy: (y0 + y1) / 2.0, zoom, parallax_x: 0.0, parallax_y: 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eye(w: u32, h: u32, levels: u32, affine: [f64; 6]) -> EyeGeom {
        let l: Vec<[u32; 2]> = (0..levels).map(|k| [w.div_ceil(1 << k), h.div_ceil(1 << k)]).collect();
        EyeGeom::new(&StereoEye { name: "x".into(), width: w, height: h, levels: l, affine }).unwrap()
    }
    const ID: [f64; 6] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0];

    #[test]
    fn inverse() {
        let a = [0.8, 0.3, 12.0, -0.2, 1.1, -7.0];
        let i = invert(&a).unwrap();
        let (x, y) = apply(&a, 33.0, 55.0);
        let (u, v) = apply(&i, x, y);
        assert!((u - 33.0).abs() < 1e-9 && (v - 55.0).abs() < 1e-9);
        assert_eq!(invert(&[0.0; 6]), None);
    }

    #[test]
    fn screen_and_image_agree() {
        let e = eye(4000, 3000, 4, [0.9, 0.1, 5.0, -0.1, 0.9, 3.0]);
        let c = Camera { cx: 1000.0, cy: 800.0, zoom: 0.37, parallax_x: 14.0, parallax_y: -3.0 };
        for eye_ in [Eye::Left, Eye::Right] {
            let (sx, sy) = e.to_screen(&c, eye_, 900.0, 700.0, 1234.0, 567.0);
            let (ix, iy) = e.to_image(&c, eye_, 900.0, 700.0, sx, sy);
            assert!((ix - 1234.0).abs() < 1e-6 && (iy - 567.0).abs() < 1e-6);
        }
    }

    #[test]
    fn parallax_moves_the_eyes_apart() {
        let e = eye(1000, 1000, 1, ID);
        let c = Camera { cx: 500.0, cy: 500.0, zoom: 1.0, parallax_x: 10.0, parallax_y: 4.0 };
        let (lx, ly) = e.to_screen(&c, Eye::Left, 800.0, 600.0, 500.0, 500.0);
        let (rx, ry) = e.to_screen(&c, Eye::Right, 800.0, 600.0, 500.0, 500.0);
        assert_eq!((rx - lx, ry - ly), (10.0, 4.0));
    }

    #[test]
    fn levels_follow_the_zoom() {
        let e = eye(8192, 8192, 5, ID);
        let c = |zoom| Camera { cx: 0.0, cy: 0.0, zoom, parallax_x: 0.0, parallax_y: 0.0 };
        assert_eq!(e.level_for(&c(1.0)), 0);
        assert_eq!(e.level_for(&c(4.0)), 0);
        assert_eq!(e.level_for(&c(0.5)), 1);
        assert_eq!(e.level_for(&c(0.3)), 1);
        assert_eq!(e.level_for(&c(0.25)), 2);
        assert_eq!(e.level_for(&c(0.001)), 4, "never past the last level");
        let half = eye(8192, 8192, 5, [2.0, 0.0, 0.0, 0.0, 2.0, 0.0]);
        assert_eq!(half.level_for(&c(1.0)), 1, "the plane may be coarser than the image");
    }

    #[test]
    fn only_tiles_on_the_screen_are_asked_for() {
        let e = eye(2048, 1024, 2, ID);
        let c = Camera { cx: 256.0, cy: 256.0, zoom: 1.0, parallax_x: 0.0, parallax_y: 0.0 };
        let v = e.visible(&c, Eye::Left, 512, 512, 512, 0);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].x, v[0].y), (0, 0));
        let c2 = Camera { cx: 512.0, cy: 512.0, ..c };
        assert_eq!(e.visible(&c2, Eye::Left, 512, 512, 512, 0).len(), 4, "four at a corner, none off the image's edge past 1024");
        let off = Camera { cx: 100000.0, ..c };
        assert!(e.visible(&off, Eye::Left, 512, 512, 512, 0).is_empty());
        let w = Camera { cx: 1024.0, cy: 512.0, zoom: 0.25, parallax_x: 0.0, parallax_y: 0.0 };
        assert_eq!(e.visible(&w, Eye::Right, 512, 256, 512, 1).len(), 2);
    }

    #[test]
    fn a_tile_at_the_edge_uses_only_its_image() {
        let e = eye(700, 300, 1, ID);
        let c = Camera { cx: 350.0, cy: 150.0, zoom: 1.0, parallax_x: 0.0, parallax_y: 0.0 };
        let q = e.quad(&c, Eye::Left, 700, 300, 512, &TileKey { left: true, level: 0, x: 1, y: 0 }, 9);
        assert_eq!(q.corners[0], [512.0, 0.0]);
        assert_eq!(q.corners[2], [700.0, 300.0]);
        assert!((q.uv[0] - 188.0 / 512.0).abs() < 1e-6 && (q.uv[1] - 300.0 / 512.0).abs() < 1e-6);
    }

    #[test]
    fn fit_shows_the_overlap() {
        let l = eye(1000, 500, 1, ID);
        let r = eye(1000, 500, 1, [1.0, 0.0, 200.0, 0.0, 1.0, 0.0]);
        let c = fit(&l, &r, 800, 500);
        // The right image starts 200 units left of the left on the plane.
        assert_eq!((c.cx, c.cy), (400.0, 250.0));
        assert_eq!(c.zoom, 1.0);
    }
}
