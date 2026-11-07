//! Pan-sharpening at pan resolution (REQ-GAP-14): weighted Brovey (as GDAL's gdal_pansharpen),
//! Laben–Brower Gram–Schmidt with a simulated pan (the closed form: only the first GS component
//! is replaced, so each band gains `g_k (P' − I)` with `g_k = cov(MS_k, I) / var(I)`), PCA
//! (first principal component replaced), Ehlers (linear IHS per band triple, the pan's high
//! frequencies injected through an FFT-domain filter) and HCS (Padwick's hyperspherical colour
//! sharpening, "smart" mode). Quality: ERGAS, SAM and the Q2ⁿ index (Q4 for four bands; Garzelli
//! & Nencini's hypercomplex generalisation) over 32 × 32 blocks, accumulated tile by tile.
//!
//! Grids. Full-resolution pan pixel (x, y) has its centre at corner coordinates (x + ½, y + ½).
//! An affine `a` maps pan corner coordinates to MS corner coordinates (u = a0 + a1 X + a2 Y,
//! v = a3 + a4 X + a5 Y). The work grid G_L has `r` × `r` pan pixels per sample (r = the
//! resolution ratio): sample (i, j) covers pan pixels [i r, (i + 1) r). Degradation (Wald's
//! protocol) is a Gaussian whose response at the coarse Nyquist is `gnyq`, sampled at each coarse
//! pixel's centre; all kernels renormalise over the samples inside the image, so a tile with
//! enough apron gives the same values as the whole image.

use crate::resample::Kernel;
use gw_abi::{Error, Result};

// ---------------------------------------------------------------------------------------------
// Images (planar f32 bands with a grid origin)

/// Planar bands on a grid: pixel (x0 + i, y0 + j) of its grid at `data[b·w·h + j·w + i]`.
#[derive(Clone, Debug)]
pub struct Img {
    pub x0: i64,
    pub y0: i64,
    pub w: usize,
    pub h: usize,
    pub nb: usize,
    pub data: Vec<f32>,
}

impl Img {
    pub fn new(x0: i64, y0: i64, w: usize, h: usize, nb: usize) -> Self {
        Img { x0, y0, w, h, nb, data: vec![0.0; w * h * nb] }
    }
    #[inline]
    pub fn band(&self, b: usize) -> &[f32] {
        &self.data[b * self.w * self.h..(b + 1) * self.w * self.h]
    }
    #[inline]
    pub fn band_mut(&mut self, b: usize) -> &mut [f32] {
        let n = self.w * self.h;
        &mut self.data[b * n..(b + 1) * n]
    }
    /// The sub-region (x0, y0, w, h) in grid coordinates (must lie inside).
    pub fn crop(&self, x0: i64, y0: i64, w: usize, h: usize) -> Img {
        let mut o = Img::new(x0, y0, w, h, self.nb);
        let (ox, oy) = ((x0 - self.x0) as usize, (y0 - self.y0) as usize);
        for b in 0..self.nb {
            let s = self.band(b);
            let d = o.band_mut(b);
            for j in 0..h {
                d[j * w..(j + 1) * w].copy_from_slice(&s[(oy + j) * self.w + ox..(oy + j) * self.w + ox + w]);
            }
        }
        o
    }
}

fn cubic(t: f64) -> f64 {
    let a = -0.5;
    let t = t.abs();
    if t < 1.0 {
        (a + 2.0) * t * t * t - (a + 3.0) * t * t + 1.0
    } else if t < 2.0 {
        a * t * t * t - 5.0 * a * t * t + 8.0 * a * t - 4.0 * a
    } else {
        0.0
    }
}

/// 1-D taps (first index, weights) at centre-index coordinate `f` inside [0, n), renormalised.
fn taps(f: f64, n: usize, k: Kernel) -> (i64, Vec<f64>) {
    let n = n as i64;
    let (lo, hi, wf): (i64, i64, fn(f64) -> f64) = match k {
        Kernel::Nearest => {
            let i = (f.round() as i64).clamp(0, n - 1);
            return (i, vec![1.0]);
        }
        Kernel::Bilinear => (f.floor() as i64, f.floor() as i64 + 1, |t: f64| (1.0 - t.abs()).max(0.0)),
        _ => (f.floor() as i64 - 1, f.floor() as i64 + 2, cubic),
    };
    let (a, b) = (lo.max(0), hi.min(n - 1));
    if a > b {
        // Outside the image: the nearest edge sample.
        return ((f.round() as i64).clamp(0, n - 1), vec![1.0]);
    }
    let mut w: Vec<f64> = (a..=b).map(|i| wf(f - i as f64)).collect();
    let s: f64 = w.iter().sum();
    if s.abs() < 1e-12 {
        return ((f.round() as i64).clamp(0, n - 1), vec![1.0]);
    }
    for x in &mut w {
        *x /= s;
    }
    (a, w)
}

/// An output grid in pan corner coordinates: sample (c, l) centred at (ox + (c + ½) s, oy + (l + ½) s).
#[derive(Clone, Copy, Debug)]
pub struct Grid {
    pub ox: f64,
    pub oy: f64,
    pub s: f64,
    pub w: usize,
    pub h: usize,
}

/// Resample the MS patch onto `g` through the affine `a` (pan corner → MS corner). `img_w`,
/// `img_h`: the whole MS image (kernels renormalise at its edges); the patch must hold every tap.
pub fn resample(ms: &Img, img_w: usize, img_h: usize, a: &[f64; 6], g: Grid, k: Kernel) -> Result<Img> {
    let mut out = Img::new(0, 0, g.w, g.h, ms.nb);
    let sep = a[2].abs() < 1e-12 && a[4].abs() < 1e-12;
    let local = |i: i64, j: i64| -> Option<usize> {
        let (li, lj) = (i - ms.x0, j - ms.y0);
        if li < 0 || lj < 0 || li >= ms.w as i64 || lj >= ms.h as i64 {
            None
        } else {
            Some(lj as usize * ms.w + li as usize)
        }
    };
    if sep {
        let cols: Vec<(i64, Vec<f64>)> = (0..g.w).map(|c| taps(a[0] + a[1] * (g.ox + (c as f64 + 0.5) * g.s) - 0.5, img_w, k)).collect();
        let rows: Vec<(i64, Vec<f64>)> = (0..g.h).map(|l| taps(a[3] + a[5] * (g.oy + (l as f64 + 0.5) * g.s) - 0.5, img_h, k)).collect();
        // Check the patch holds every tap.
        let (cx0, cx1) = (cols.iter().map(|c| c.0).min().unwrap_or(0), cols.iter().map(|c| c.0 + c.1.len() as i64 - 1).max().unwrap_or(0));
        let (ry0, ry1) = (rows.iter().map(|r| r.0).min().unwrap_or(0), rows.iter().map(|r| r.0 + r.1.len() as i64 - 1).max().unwrap_or(0));
        if local(cx0, ry0).is_none() || local(cx1, ry1).is_none() {
            return Err(Error::range("pan-sharpen: the MS patch does not cover the tile"));
        }
        let mut tmp = vec![0f64; ms.w];
        for b in 0..ms.nb {
            let src = ms.band(b);
            let dst = out.band_mut(b);
            for (l, (j0, wy)) in rows.iter().enumerate() {
                // Vertical pass into one row of the patch, then the horizontal taps.
                for (x, t) in tmp.iter_mut().enumerate() {
                    let mut s = 0.0;
                    for (q, wq) in wy.iter().enumerate() {
                        s += wq * f64::from(src[(j0 + q as i64 - ms.y0) as usize * ms.w + x]);
                    }
                    *t = s;
                }
                for (c, (i0, wx)) in cols.iter().enumerate() {
                    let mut s = 0.0;
                    for (q, wq) in wx.iter().enumerate() {
                        s += wq * tmp[(i0 + q as i64 - ms.x0) as usize];
                    }
                    dst[l * g.w + c] = s as f32;
                }
            }
        }
        return Ok(out);
    }
    // A rotated or sheared mapping (sensor models): 2-D taps per sample.
    for l in 0..g.h {
        for c in 0..g.w {
            let (x, y) = (g.ox + (c as f64 + 0.5) * g.s, g.oy + (l as f64 + 0.5) * g.s);
            let (u, v) = (a[0] + a[1] * x + a[2] * y - 0.5, a[3] + a[4] * x + a[5] * y - 0.5);
            let (i0, wx) = taps(u, img_w, k);
            let (j0, wy) = (taps(v, img_h, k).0, taps(v, img_h, k).1);
            for b in 0..ms.nb {
                let src = ms.band(b);
                let mut s = 0.0;
                for (q, wq) in wy.iter().enumerate() {
                    for (p, wp) in wx.iter().enumerate() {
                        let li = local(i0 + p as i64, j0 + q as i64).ok_or_else(|| Error::range("pan-sharpen: the MS patch does not cover the tile"))?;
                        s += wq * wp * f64::from(src[li]);
                    }
                }
                out.band_mut(b)[l * g.w + c] = s as f32;
            }
        }
    }
    Ok(out)
}

/// Gaussian σ (fine pixels) whose response at the coarse Nyquist (1 / 2r) is `gnyq`.
pub fn sigma_for(r: usize, gnyq: f64) -> f64 {
    r as f64 * (-2.0 * gnyq.clamp(1e-3, 0.999).ln()).sqrt() / std::f64::consts::PI
}

/// Kernel radius (fine pixels) of the degradation.
pub fn degrade_radius(r: usize, gnyq: f64) -> usize {
    (3.0 * sigma_for(r, gnyq)).ceil() as usize + r
}

/// Degrade a fine-grid image by `r` (Gaussian + decimation at block centres) onto the coarse
/// samples (cx0 … cx0 + cw, cy0 … cy0 + ch). `fw`, `fh`: the fine image size (renormalising at
/// its edges); the patch must hold every tap inside the image.
pub fn degrade(img: &Img, fw: usize, fh: usize, r: usize, gnyq: f64, cx0: i64, cy0: i64, cw: usize, ch: usize) -> Result<Img> {
    let sg = sigma_for(r, gnyq);
    let rad = (3.0 * sg).ceil();
    let wt = |d: f64| (-0.5 * d * d / (sg * sg)).exp();
    let tap1 = |ci: i64, n: usize| -> (i64, Vec<f64>) {
        let c = ci as f64 * r as f64 + (r as f64 - 1.0) / 2.0;
        let (a, b) = (((c - rad).ceil() as i64).max(0), ((c + rad).floor() as i64).min(n as i64 - 1));
        let mut w: Vec<f64> = (a..=b).map(|j| wt(j as f64 - c)).collect();
        let s: f64 = w.iter().sum::<f64>().max(1e-300);
        for x in &mut w {
            *x /= s;
        }
        (a, w)
    };
    let cols: Vec<(i64, Vec<f64>)> = (0..cw as i64).map(|i| tap1(cx0 + i, fw)).collect();
    let rows: Vec<(i64, Vec<f64>)> = (0..ch as i64).map(|j| tap1(cy0 + j, fh)).collect();
    let in_patch = |x: i64, y: i64| x >= img.x0 && y >= img.y0 && x < img.x0 + img.w as i64 && y < img.y0 + img.h as i64;
    for c in &cols {
        if !in_patch(c.0, img.y0) || !in_patch(c.0 + c.1.len() as i64 - 1, img.y0) {
            return Err(Error::range("pan-sharpen: degradation taps outside the patch"));
        }
    }
    for rr in &rows {
        if !in_patch(img.x0, rr.0) || !in_patch(img.x0, rr.0 + rr.1.len() as i64 - 1) {
            return Err(Error::range("pan-sharpen: degradation taps outside the patch"));
        }
    }
    let mut out = Img::new(cx0, cy0, cw, ch, img.nb);
    let mut tmp = vec![0f64; img.w];
    for b in 0..img.nb {
        let src = img.band(b);
        let dst = out.band_mut(b);
        for (l, (j0, wy)) in rows.iter().enumerate() {
            for (x, t) in tmp.iter_mut().enumerate() {
                let mut s = 0.0;
                for (q, wq) in wy.iter().enumerate() {
                    s += wq * f64::from(src[(j0 + q as i64 - img.y0) as usize * img.w + x]);
                }
                *t = s;
            }
            for (c, (i0, wx)) in cols.iter().enumerate() {
                let mut s = 0.0;
                for (q, wq) in wx.iter().enumerate() {
                    s += wq * tmp[(i0 + q as i64 - img.x0) as usize];
                }
                dst[l * cw + c] = s as f32;
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// FFT (mixed radix 2, 3, 5; sizes 2^a 3^b 5^c)

/// The smallest 2^a 3^b 5^c ≥ n.
pub fn fft_size(n: usize) -> usize {
    let mut m = n.max(1);
    loop {
        let mut k = m;
        for p in [2, 3, 5] {
            while k % p == 0 {
                k /= p;
            }
        }
        if k == 1 {
            return m;
        }
        m += 1;
    }
}

fn fft_rec(re: &mut [f64], im: &mut [f64], tw: &(Vec<f64>, Vec<f64>), stride: usize, tmp_re: &mut [f64], tmp_im: &mut [f64]) {
    let n = re.len();
    if n == 1 {
        return;
    }
    let big = tw.0.len();
    let p = if n % 2 == 0 { 2 } else if n % 3 == 0 { 3 } else { 5 };
    let m = n / p;
    // Split into p decimated sub-sequences, transform each.
    for q in 0..p {
        for k in 0..m {
            tmp_re[q * m + k] = re[k * p + q];
            tmp_im[q * m + k] = im[k * p + q];
        }
    }
    re.copy_from_slice(&tmp_re[..n]);
    im.copy_from_slice(&tmp_im[..n]);
    for q in 0..p {
        let (r, i) = (&mut re[q * m..(q + 1) * m], &mut im[q * m..(q + 1) * m]);
        let (tr, ti) = (&mut tmp_re[q * m..(q + 1) * m], &mut tmp_im[q * m..(q + 1) * m]);
        fft_rec(r, i, tw, stride * p, tr, ti);
    }
    // Butterflies: X[k + s m] = Σ_q W_n^{q (k + s m)} Y_q[k], W_n^t = tw[(t · stride) mod N].
    for k in 0..m {
        for s in 0..p {
            let kk = k + s * m;
            let (mut ar, mut ai) = (0.0, 0.0);
            for q in 0..p {
                let t = (q * kk * stride) % big;
                let (c, sn) = (tw.0[t], tw.1[t]);
                let (xr, xi) = (re[q * m + k], im[q * m + k]);
                ar += xr * c - xi * sn;
                ai += xr * sn + xi * c;
            }
            tmp_re[kk] = ar;
            tmp_im[kk] = ai;
        }
    }
    re.copy_from_slice(&tmp_re[..n]);
    im.copy_from_slice(&tmp_im[..n]);
}

/// Twiddles e^{∓2πi t/n} for t < n.
fn twiddles(n: usize, inverse: bool) -> (Vec<f64>, Vec<f64>) {
    let sgn = if inverse { 1.0 } else { -1.0 };
    (0..n).map(|t| sgn * 2.0 * std::f64::consts::PI * t as f64 / n as f64).map(|a| (a.cos(), a.sin())).unzip()
}

fn fft_with(re: &mut [f64], im: &mut [f64], tw: &(Vec<f64>, Vec<f64>), inverse: bool, tr: &mut [f64], ti: &mut [f64]) {
    let n = re.len();
    fft_rec(re, im, tw, 1, tr, ti);
    if inverse {
        for k in 0..n {
            re[k] /= n as f64;
            im[k] /= n as f64;
        }
    }
}

/// In-place DFT of a complex sequence whose length is 2^a 3^b 5^c (unnormalised; the inverse is
/// scaled by 1/n).
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    let tw = twiddles(n, inverse);
    let (mut tr, mut ti) = (vec![0.0; n], vec![0.0; n]);
    fft_with(re, im, &tw, inverse, &mut tr, &mut ti);
}

/// 2-D DFT (rows then columns) of an n × m complex image (row-major, n columns).
pub fn fft2(re: &mut [f64], im: &mut [f64], w: usize, h: usize, inverse: bool) {
    let twx = twiddles(w, inverse);
    let (mut tr, mut ti) = (vec![0.0; w.max(h)], vec![0.0; w.max(h)]);
    for j in 0..h {
        fft_with(&mut re[j * w..(j + 1) * w], &mut im[j * w..(j + 1) * w], &twx, inverse, &mut tr[..w], &mut ti[..w]);
    }
    let twy = twiddles(h, inverse);
    let (mut cr, mut ci) = (vec![0.0; h], vec![0.0; h]);
    for i in 0..w {
        for j in 0..h {
            cr[j] = re[j * w + i];
            ci[j] = im[j * w + i];
        }
        fft_with(&mut cr, &mut ci, &twy, inverse, &mut tr[..h], &mut ti[..h]);
        for j in 0..h {
            re[j * w + i] = cr[j];
            im[j * w + i] = ci[j];
        }
    }
}

/// Ehlers' low-pass response at radial frequency ρ (cycles per pixel): 1 to ρc(1 − β), a Hann
/// (cos²) roll-off to 0 at ρc(1 + β). The pan's high-pass is 1 − this.
pub fn ehlers_lowpass(rho: f64, rc: f64, beta: f64) -> f64 {
    let (a, b) = (rc * (1.0 - beta), rc * (1.0 + beta));
    if rho <= a {
        1.0
    } else if rho >= b {
        0.0
    } else {
        let t = (rho - a) / (b - a);
        (0.5 * std::f64::consts::PI * t).cos().powi(2)
    }
}

/// High-pass filter two real images (w × h, row-major) at once (packed as one complex image),
/// mirror-extended to an FFT size; returns them filtered.
fn highpass_pair(x: &[f64], y: &[f64], w: usize, h: usize, rc: f64, beta: f64) -> (Vec<f64>, Vec<f64>) {
    let (nw, nh) = (fft_size(w + 16), fft_size(h + 16));
    let (px, py) = ((nw - w) / 2, (nh - h) / 2);
    let mirror = |i: i64, n: usize| -> usize {
        let n = n as i64;
        let mut i = i;
        while i < 0 || i >= n {
            i = if i < 0 { -i - 1 } else { 2 * n - i - 1 };
        }
        i as usize
    };
    let mut re = vec![0.0; nw * nh];
    let mut im = vec![0.0; nw * nh];
    for j in 0..nh {
        let sj = mirror(j as i64 - py as i64, h);
        for i in 0..nw {
            let si = mirror(i as i64 - px as i64, w);
            re[j * nw + i] = x[sj * w + si];
            im[j * nw + i] = y[sj * w + si];
        }
    }
    fft2(&mut re, &mut im, nw, nh, false);
    for j in 0..nh {
        let fy = (if j <= nh / 2 { j as f64 } else { j as f64 - nh as f64 }) / nh as f64;
        for i in 0..nw {
            let fx = (if i <= nw / 2 { i as f64 } else { i as f64 - nw as f64 }) / nw as f64;
            let g = 1.0 - ehlers_lowpass((fx * fx + fy * fy).sqrt(), rc, beta);
            re[j * nw + i] *= g;
            im[j * nw + i] *= g;
        }
    }
    fft2(&mut re, &mut im, nw, nh, true);
    let mut ox = vec![0.0; w * h];
    let mut oy = vec![0.0; w * h];
    for j in 0..h {
        for i in 0..w {
            ox[j * w + i] = re[(j + py) * nw + i + px];
            oy[j * w + i] = im[(j + py) * nw + i + px];
        }
    }
    (ox, oy)
}

// ---------------------------------------------------------------------------------------------
// Fusion

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Brovey,
    Gs,
    Pca,
    Ehlers,
    Hcs,
}

impl Method {
    pub fn from_i32(v: i32) -> Result<Self> {
        Ok(match v {
            0 => Self::Brovey,
            1 => Self::Gs,
            2 => Self::Pca,
            3 => Self::Ehlers,
            4 => Self::Hcs,
            _ => return Err(Error::invalid("pan-sharpen: unknown method")),
        })
    }
    /// Pan apron (fine pixels) the method needs around a tile.
    pub fn apron(self, r: usize) -> usize {
        match self {
            Self::Ehlers => 32,
            Self::Hcs => r,
            _ => 0,
        }
    }
}

/// Global parameters of one fusion (planned from the image statistics, see `stats_layout`).
///   Brovey: I = Σ c_k m_k; out_k = m_k · P / I.
///   GS, PCA: I = Σ c_k m_k + c0; out_k = m_k + g_k (aP P + bP − I).
///   HCS: P²′ = a2 P² + b2 (and the smoothed pan likewise); I_adj = √(I² P²′ / PS²′); out_k = m_k I_adj / √I².
///   Ehlers: per band triple t: I_t = mean of its bands; out_k = m_k + HP(aP_t P + bP_t − I_t).
#[derive(Clone, Debug)]
pub struct Params {
    pub method: Method,
    pub c: Vec<f64>,
    pub c0: f64,
    pub g: Vec<f64>,
    pub a_p: f64,
    pub b_p: f64,
    pub a2: f64,
    pub b2: f64,
    /// Ehlers band triples (indices) with their pan match (aP, bP).
    pub triples: Vec<([usize; 3], f64, f64)>,
    /// Ehlers cut-off (cycles per pan pixel) and roll-off.
    pub rc: f64,
    pub beta: f64,
    /// HCS smoothing box width (pan pixels).
    pub box_w: usize,
}

/// Fuse: `ms` upsampled onto the pan grid of `pan` (same size). `pan` may extend beyond the
/// output core by an apron (`core` = x, y, w, h inside `pan`'s local pixels); `ms` covers the
/// same pixels as `pan`. Returns the fused core.
pub fn fuse(p: &Params, ms: &Img, pan: &[f32], core: (usize, usize, usize, usize)) -> Result<Img> {
    let (w, h, nb) = (ms.w, ms.h, ms.nb);
    if pan.len() != w * h {
        return Err(Error::invalid("pan-sharpen: pan and MS sizes differ"));
    }
    let (cx, cy, cw, ch) = core;
    if cx + cw > w || cy + ch > h {
        return Err(Error::invalid("pan-sharpen: core outside the tile"));
    }
    let mut out = Img::new(0, 0, cw, ch, nb);
    let at = |x: usize, y: usize| (cy + y) * w + cx + x;
    match p.method {
        Method::Brovey => {
            for y in 0..ch {
                for x in 0..cw {
                    let i = at(x, y);
                    let ii: f64 = (0..nb).map(|k| p.c[k] * f64::from(ms.data[k * w * h + i])).sum();
                    let f = if ii != 0.0 { f64::from(pan[i]) / ii } else { 0.0 };
                    for k in 0..nb {
                        out.data[k * cw * ch + y * cw + x] = (f64::from(ms.data[k * w * h + i]) * f) as f32;
                    }
                }
            }
        }
        Method::Gs | Method::Pca => {
            for y in 0..ch {
                for x in 0..cw {
                    let i = at(x, y);
                    let ii: f64 = p.c0 + (0..nb).map(|k| p.c[k] * f64::from(ms.data[k * w * h + i])).sum::<f64>();
                    let d = p.a_p * f64::from(pan[i]) + p.b_p - ii;
                    for k in 0..nb {
                        out.data[k * cw * ch + y * cw + x] = (f64::from(ms.data[k * w * h + i]) + p.g[k] * d) as f32;
                    }
                }
            }
        }
        Method::Hcs => {
            // Box-smoothed pan (renormalised at the tile's edges: the apron keeps the core exact).
            let bw = p.box_w.max(1) as i64;
            let half = bw / 2;
            let mut rows = vec![0f64; w * h];
            for y in 0..h {
                let mut acc = vec![0f64; w + 1];
                for x in 0..w {
                    acc[x + 1] = acc[x] + f64::from(pan[y * w + x]);
                }
                for x in 0..w as i64 {
                    let (a, b) = ((x - half).max(0) as usize, ((x - half + bw).min(w as i64)) as usize);
                    rows[y * w + x as usize] = (acc[b] - acc[a]) / (b - a) as f64;
                }
            }
            for y in 0..ch {
                for x in 0..cw {
                    let (gx, gy) = (cx + x, cy + y);
                    let (a, b) = ((gy as i64 - half).max(0) as usize, ((gy as i64 - half + bw).min(h as i64)) as usize);
                    let ps = (a..b).map(|yy| rows[yy * w + gx]).sum::<f64>() / (b - a) as f64;
                    let i = at(x, y);
                    let pv = f64::from(pan[i]);
                    let i2: f64 = (0..nb).map(|k| f64::from(ms.data[k * w * h + i]).powi(2)).sum();
                    let p2 = p.a2 * pv * pv + p.b2;
                    let ps2 = p.a2 * ps * ps + p.b2;
                    let iadj = if ps2 > 1e-12 && p2 > 0.0 { (i2 * p2 / ps2).sqrt() } else { i2.sqrt() };
                    let f = if i2 > 1e-24 { iadj / i2.sqrt() } else { 0.0 };
                    for k in 0..nb {
                        out.data[k * cw * ch + y * cw + x] = (f64::from(ms.data[k * w * h + i]) * f) as f32;
                    }
                }
            }
        }
        Method::Ehlers => {
            let n = w * h;
            let mut done = vec![false; nb];
            let mut diffs: Vec<(Vec<usize>, Vec<f64>)> = Vec::new();
            for (t, ap, bp) in &p.triples {
                let d: Vec<f64> = (0..n).map(|i| ap * f64::from(pan[i]) + bp - t.iter().map(|&k| f64::from(ms.data[k * n + i])).sum::<f64>() / 3.0).collect();
                // Each band takes the injection of the first triple that holds it.
                let mine: Vec<usize> = t.iter().copied().filter(|&k| !done[k]).collect();
                for &k in &mine {
                    done[k] = true;
                }
                diffs.push((mine, d));
            }
            let mut hp: Vec<Vec<f64>> = Vec::with_capacity(diffs.len());
            let mut k = 0;
            while k < diffs.len() {
                if k + 1 < diffs.len() {
                    let (a, b) = highpass_pair(&diffs[k].1, &diffs[k + 1].1, w, h, p.rc, p.beta);
                    hp.push(a);
                    hp.push(b);
                    k += 2;
                } else {
                    let (a, _) = highpass_pair(&diffs[k].1, &vec![0.0; n], w, h, p.rc, p.beta);
                    hp.push(a);
                    k += 1;
                }
            }
            for b in 0..nb {
                let ti = diffs.iter().position(|d| d.0.contains(&b));
                for y in 0..ch {
                    for x in 0..cw {
                        let i = at(x, y);
                        let v = f64::from(ms.data[b * n + i]) + ti.map(|t| hp[t][i]).unwrap_or(0.0);
                        out.data[b * cw * ch + y * cw + x] = v as f32;
                    }
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Statistics and quality

/// Length of a statistics accumulator for `nb` bands: [n, Σm (nb), Σm mᵀ (nb²), Σp, Σp², Σm p (nb),
/// ΣI², ΣI⁴ (I² = Σ m²), then the full-resolution pan: nP, ΣP, ΣP², ΣP⁴].
pub fn stats_len(nb: usize) -> usize {
    1 + nb + nb * nb + 2 + nb + 2 + 4
}

/// Accumulate the pairs (MS samples `m`, degraded pan `p`) of a region into `acc`.
pub fn accumulate(acc: &mut [f64], m: &Img, p: &[f32]) {
    let nb = m.nb;
    let n = m.w * m.h;
    let (o_m, o_mm, o_p, o_mp, o_i) = (1, 1 + nb, 1 + nb + nb * nb, 3 + nb + nb * nb, 3 + 2 * nb + nb * nb);
    let mut v = vec![0f64; nb];
    for i in 0..n {
        for (k, x) in v.iter_mut().enumerate() {
            *x = f64::from(m.data[k * n + i]);
        }
        let pv = f64::from(p[i]);
        acc[0] += 1.0;
        let mut i2 = 0.0;
        for k in 0..nb {
            acc[o_m + k] += v[k];
            for j in 0..nb {
                acc[o_mm + k * nb + j] += v[k] * v[j];
            }
            acc[o_mp + k] += v[k] * pv;
            i2 += v[k] * v[k];
        }
        acc[o_p] += pv;
        acc[o_p + 1] += pv * pv;
        acc[o_i] += i2;
        acc[o_i + 1] += i2 * i2;
    }
}

/// Accumulate full-resolution pan samples (nP, ΣP, ΣP², ΣP⁴).
pub fn accumulate_pan(acc: &mut [f64], nb: usize, p: &[f32]) {
    let o = 5 + 2 * nb + nb * nb;
    for &x in p {
        let v = f64::from(x);
        acc[o] += 1.0;
        acc[o + 1] += v;
        acc[o + 2] += v * v;
        acc[o + 3] += v * v * v * v;
    }
}

/// Cayley–Dickson product of two hypercomplex numbers of dimension 2^n: (a, b)(c, d) = (ac − d*b, da + bc*).
pub fn hc_mul(x: &[f64], y: &[f64], out: &mut [f64]) {
    let n = x.len();
    if n == 1 {
        out[0] = x[0] * y[0];
        return;
    }
    let m = n / 2;
    let (a, b) = x.split_at(m);
    let (c, d) = y.split_at(m);
    let conj = |v: &[f64]| -> Vec<f64> { v.iter().enumerate().map(|(i, &t)| if i == 0 { t } else { -t }).collect() };
    let (mut ac, mut db, mut da, mut bc) = (vec![0.0; m], vec![0.0; m], vec![0.0; m], vec![0.0; m]);
    hc_mul(a, c, &mut ac);
    hc_mul(&conj(d), b, &mut db);
    hc_mul(d, a, &mut da);
    hc_mul(b, &conj(c), &mut bc);
    for i in 0..m {
        out[i] = ac[i] - db[i];
        out[m + i] = da[i] + bc[i];
    }
}

/// The Q2ⁿ index of one block: `z` reference and `v` test, each `nb` planes of `n` samples (nb a power of two).
pub fn q2n_block(z: &[Vec<f64>], v: &[Vec<f64>]) -> f64 {
    let d = z.len();
    let n = z[0].len() as f64;
    let mut mz = vec![0.0; d];
    let mut mv = vec![0.0; d];
    for k in 0..d {
        mz[k] = z[k].iter().sum::<f64>() / n;
        mv[k] = v[k].iter().sum::<f64>() / n;
    }
    let (mut ez2, mut ev2) = (0.0, 0.0);
    let mut ezv = vec![0.0; d];
    let mut a = vec![0.0; d];
    let mut b = vec![0.0; d];
    let mut pr = vec![0.0; d];
    for i in 0..z[0].len() {
        for k in 0..d {
            a[k] = z[k][i];
            b[k] = if k == 0 { v[k][i] } else { -v[k][i] };
        }
        ez2 += a.iter().map(|x| x * x).sum::<f64>();
        ev2 += b.iter().map(|x| x * x).sum::<f64>();
        hc_mul(&a, &b, &mut pr);
        for k in 0..d {
            ezv[k] += pr[k];
        }
    }
    let mvc: Vec<f64> = mv.iter().enumerate().map(|(k, &t)| if k == 0 { t } else { -t }).collect();
    hc_mul(&mz, &mvc, &mut pr);
    let cov: f64 = (0..d).map(|k| (ezv[k] / n - pr[k]).powi(2)).sum::<f64>().sqrt();
    let nz2: f64 = mz.iter().map(|x| x * x).sum();
    let nv2: f64 = mv.iter().map(|x| x * x).sum();
    let vz = ez2 / n - nz2;
    let vv = ev2 / n - nv2;
    let den = (vz + vv) * (nz2 + nv2);
    if den <= 1e-300 {
        return if vz.abs() < 1e-12 && vv.abs() < 1e-12 && (nz2 - nv2).abs() < 1e-12 { 1.0 } else { 0.0 };
    }
    4.0 * cov * nz2.sqrt() * nv2.sqrt() / den
}

/// Length of a quality accumulator for `nb` bands: [n, Σref (nb), Σ(ref − test)² (nb), ΣSAM°, nSAM,
/// ΣQ2ⁿ, nQ2ⁿ, ΣQ4, nQ4].
pub fn quality_len(nb: usize) -> usize {
    1 + 2 * nb + 6
}

/// Accumulate the quality of `test` against `reference` (same grid, w × h) into `acc`. Q blocks of
/// `block` px start at (bx0, by0) local; `q4` names four bands for Q4 when the image has more.
pub fn accumulate_quality(acc: &mut [f64], reference: &Img, test: &Img, block: usize, q4: Option<[usize; 4]>) {
    let (w, h, nb) = (reference.w, reference.h, reference.nb);
    let n = w * h;
    for i in 0..n {
        let (mut dot, mut na, mut nt) = (0.0, 0.0, 0.0);
        for k in 0..nb {
            let a = f64::from(reference.data[k * n + i]);
            let t = f64::from(test.data[k * n + i]);
            acc[1 + k] += a;
            acc[1 + nb + k] += (a - t) * (a - t);
            dot += a * t;
            na += a * a;
            nt += t * t;
        }
        acc[0] += 1.0;
        if na > 0.0 && nt > 0.0 {
            acc[1 + 2 * nb] += (dot / (na * nt).sqrt()).clamp(-1.0, 1.0).acos().to_degrees();
            acc[2 + 2 * nb] += 1.0;
        }
    }
    let dim = nb.next_power_of_two();
    for by in (0..h / block).map(|j| j * block) {
        for bx in (0..w / block).map(|i| i * block) {
            let take = |img: &Img, bands: &[usize], d: usize| -> Vec<Vec<f64>> {
                (0..d).map(|k| if k < bands.len() { (0..block * block).map(|q| f64::from(img.data[bands[k] * n + (by + q / block) * w + bx + q % block])).collect() } else { vec![0.0; block * block] }).collect()
            };
            let all: Vec<usize> = (0..nb).collect();
            let q = q2n_block(&take(reference, &all, dim), &take(test, &all, dim));
            acc[3 + 2 * nb] += q;
            acc[4 + 2 * nb] += 1.0;
            let sel = if nb == 4 { Some([0, 1, 2, 3]) } else { q4 };
            if let Some(s) = sel.filter(|s| s.iter().all(|&k| k < nb)) {
                let q = q2n_block(&take(reference, &s, 4), &take(test, &s, 4));
                acc[5 + 2 * nb] += q;
                acc[6 + 2 * nb] += 1.0;
            }
        }
    }
}

/// ERGAS, SAM (degrees), Q2ⁿ and Q4 (NaN without blocks) of an accumulator; `r` the resolution ratio.
pub fn quality_of(acc: &[f64], nb: usize, r: f64) -> (f64, f64, f64, f64) {
    let n = acc[0].max(1.0);
    let s: f64 = (0..nb).map(|k| (acc[1 + nb + k] / n) / (acc[1 + k] / n).powi(2).max(1e-300)).sum::<f64>() / nb as f64;
    let ergas = 100.0 / r * s.sqrt();
    let sam = acc[1 + 2 * nb] / acc[2 + 2 * nb].max(1.0);
    let q = if acc[4 + 2 * nb] > 0.0 { acc[3 + 2 * nb] / acc[4 + 2 * nb] } else { f64::NAN };
    let q4 = if acc[6 + 2 * nb] > 0.0 { acc[5 + 2 * nb] / acc[6 + 2 * nb] } else { f64::NAN };
    (ergas, sam, q, q4)
}

// ---------------------------------------------------------------------------------------------
// Tiles (the bundle's three jobs). A spec is a flat f64 record:
//  [0] version 1, [1] nb, [2] r, [3] kernel (1 bilinear, 2 cubic), [4] gnyq,
//  [5..9] MS width, height, pan width, height, [9..15] affine (pan corner → MS corner),
//  [15..19] MS patch x0, y0, w, h, [19..23] source patch (pan, or the degraded pan for a Wald
//  tile) x0, y0, w, h, [23..27] core x0, y0, w, h (pan pixels for a fusion tile, G_L samples
//  otherwise), [27] output type (0 f32, 1 u8, 2 u16, 3 i16), [28] output maximum (0: the type's),
//  [29] round the upsampled MS and clamp it to the output maximum (GDAL's integer work buffer), [30] quality on, [31..35] Q4 bands
//  (−1: none), [35] reserved, then the parameters: method, c (nb), c0, g (nb), aP, bP, a2, b2,
//  triples n, n × (3 bands, aP, bP), rc, beta, box width.

#[derive(Clone, Debug)]
pub struct TileSpec {
    pub nb: usize,
    pub r: usize,
    pub kernel: Kernel,
    pub gnyq: f64,
    pub ms_size: (usize, usize),
    pub pan_size: (usize, usize),
    pub a: [f64; 6],
    pub ms_patch: (i64, i64, usize, usize),
    pub src_patch: (i64, i64, usize, usize),
    pub core: (i64, i64, usize, usize),
    pub out_type: u8,
    pub out_max: f64,
    pub round_ms: bool,
    pub quality: bool,
    pub q4: Option<[usize; 4]>,
    pub params: Params,
}

pub const SPEC_HEAD: usize = 36;

impl TileSpec {
    pub fn parse(a: &[f64]) -> Result<Self> {
        if a.len() < SPEC_HEAD + 1 || a[0] != 1.0 {
            return Err(Error::invalid("pan-sharpen tile: bad spec"));
        }
        let us = |v: f64| -> usize {
            if v.is_finite() && v > 0.0 {
                v as usize
            } else {
                0
            }
        };
        let nb = us(a[1]);
        let r = us(a[2]);
        if nb == 0 || nb > 16 || r == 0 || r > 16 {
            return Err(Error::invalid("pan-sharpen tile: bands or ratio"));
        }
        let rect = |o: usize| (a[o] as i64, a[o + 1] as i64, us(a[o + 2]), us(a[o + 3]));
        let q4 = if a[31] >= 0.0 { Some([us(a[31]), us(a[32]), us(a[33]), us(a[34])]) } else { None };
        let p = &a[SPEC_HEAD..];
        let need = 1 + nb + 1 + nb + 4 + 1;
        if p.len() < need {
            return Err(Error::invalid("pan-sharpen tile: short parameters"));
        }
        let method = Method::from_i32(p[0] as i32)?;
        let c = p[1..1 + nb].to_vec();
        let c0 = p[1 + nb];
        let g = p[2 + nb..2 + 2 * nb].to_vec();
        let o = 2 + 2 * nb;
        let (a_p, b_p, a2, b2) = (p[o], p[o + 1], p[o + 2], p[o + 3]);
        let nt = us(p[o + 4]);
        if p.len() < o + 5 + 5 * nt + 3 || nt > 16 {
            return Err(Error::invalid("pan-sharpen tile: short parameters"));
        }
        let mut triples = Vec::with_capacity(nt);
        for t in 0..nt {
            let q = &p[o + 5 + 5 * t..o + 10 + 5 * t];
            let idx = [us(q[0]), us(q[1]), us(q[2])];
            if idx.iter().any(|&k| k >= nb) {
                return Err(Error::invalid("pan-sharpen tile: triple band"));
            }
            triples.push((idx, q[3], q[4]));
        }
        let e = o + 5 + 5 * nt;
        let params = Params { method, c, c0, g, a_p, b_p, a2, b2, triples, rc: p[e], beta: p[e + 1], box_w: us(p[e + 2]).max(1) };
        if method == Method::Ehlers && params.triples.is_empty() {
            return Err(Error::invalid("pan-sharpen tile: Ehlers needs band triples"));
        }
        Ok(TileSpec {
            nb,
            r,
            kernel: match a[3] as i32 {
                2 => Kernel::Cubic,
                0 => Kernel::Nearest,
                _ => Kernel::Bilinear,
            },
            gnyq: a[4],
            ms_size: (us(a[5]), us(a[6])),
            pan_size: (us(a[7]), us(a[8])),
            a: [a[9], a[10], a[11], a[12], a[13], a[14]],
            ms_patch: rect(15),
            src_patch: rect(19),
            core: rect(23),
            out_type: a[27] as u8,
            out_max: a[28],
            round_ms: a[29] != 0.0,
            quality: a[30] != 0.0,
            q4,
            params,
        })
    }
    fn gl_size(&self) -> (usize, usize) {
        (self.pan_size.0.div_ceil(self.r), self.pan_size.1.div_ceil(self.r))
    }
    /// G_L apron of a stats or Wald tile: the method's, the cubic reach of the degraded MS and the degradation.
    fn gl_apron(&self) -> i64 {
        let r = self.r as i64;
        let need = self.params.method.apron(self.r) as i64 + 3 * r + degrade_radius(self.r, self.gnyq) as i64;
        (need + r - 1) / r * r
    }
}

fn check_patch(name: &str, (x0, y0, w, h): (i64, i64, usize, usize), len: usize, nb: usize) -> Result<()> {
    if w == 0 || h == 0 || w * h > 64 << 20 || len != w * h * nb || x0 < 0 || y0 < 0 {
        return Err(gw_abi::err!(INVALID, "pan-sharpen tile: the {name} patch size", name = name));
    }
    Ok(())
}

/// A rectangle grown by `m` on every side, clamped to [0, w) × [0, h).
fn grow(r: (i64, i64, usize, usize), m: i64, w: usize, h: usize) -> (i64, i64, usize, usize) {
    let (x0, y0) = ((r.0 - m).max(0), (r.1 - m).max(0));
    let (x1, y1) = ((r.0 + r.2 as i64 + m).min(w as i64), (r.1 + r.3 as i64 + m).min(h as i64));
    (x0, y0, (x1 - x0).max(0) as usize, (y1 - y0).max(0) as usize)
}

/// GDAL's integer work buffer: the upsampled MS rounded and clamped to [0, max] (max 0: no upper clamp).
fn round_all(img: &mut Img, max: f64) {
    let hi = if max > 0.0 { max as f32 } else { f32::INFINITY };
    for v in &mut img.data {
        *v = v.round().clamp(0.0, hi);
    }
}

fn holds(p: &Img, r: (i64, i64, usize, usize)) -> bool {
    r.0 >= p.x0 && r.1 >= p.y0 && r.0 + r.2 as i64 <= p.x0 + p.w as i64 && r.1 + r.3 as i64 <= p.y0 + p.h as i64
}

/// Statistics of one G_L tile: (S1 at G_L, S2 at the reduced scale, the degraded pan over the
/// tile and its apron for the Wald pass).
pub fn stats_tile(s: &TileSpec, ms_px: &[f32], pan_px: &[f32]) -> Result<(Vec<f64>, Vec<f64>, Img)> {
    check_patch("MS", s.ms_patch, ms_px.len(), s.nb)?;
    check_patch("pan", s.src_patch, pan_px.len(), 1)?;
    let (gw, gh) = s.gl_size();
    let (r, nb) = (s.r, s.nb);
    let ri = r as i64;
    let e = grow(s.core, s.gl_apron(), gw, gh);
    let ms = Img { x0: s.ms_patch.0, y0: s.ms_patch.1, w: s.ms_patch.2, h: s.ms_patch.3, nb, data: ms_px.to_vec() };
    let pan = Img { x0: s.src_patch.0, y0: s.src_patch.1, w: s.src_patch.2, h: s.src_patch.3, nb: 1, data: pan_px.to_vec() };
    let pan_low = degrade(&pan, s.pan_size.0, s.pan_size.1, r, s.gnyq, e.0, e.1, e.2, e.3)?;
    let mut ms_ref = resample(&ms, s.ms_size.0, s.ms_size.1, &s.a, Grid { ox: (e.0 * ri) as f64, oy: (e.1 * ri) as f64, s: r as f64, w: e.2, h: e.3 }, s.kernel)?;
    ms_ref.x0 = e.0;
    ms_ref.y0 = e.1;
    let mut s1 = vec![0.0; stats_len(nb)];
    let mut s2 = vec![0.0; stats_len(nb)];
    let (cx0, cy0, cw, ch) = s.core;
    let pan_core = pan_low.crop(cx0, cy0, cw, ch);
    accumulate(&mut s1, &ms_ref.crop(cx0, cy0, cw, ch), pan_core.band(0));
    // Full-resolution pan of the core's blocks.
    let (px0, py0) = (cx0 * ri, cy0 * ri);
    let (px1, py1) = (((cx0 + cw as i64) * ri).min(s.pan_size.0 as i64), ((cy0 + ch as i64) * ri).min(s.pan_size.1 as i64));
    let fr = (px0, py0, (px1 - px0) as usize, (py1 - py0) as usize);
    if !holds(&pan, fr) {
        return Err(Error::range("pan-sharpen: the pan patch does not cover the tile"));
    }
    accumulate_pan(&mut s1, nb, &pan.crop(fr.0, fr.1, fr.2, fr.3).data);
    // Reduced scale: the MS and the degraded pan, degraded again by r.
    let (lw, lh) = (gw.div_ceil(r), gh.div_ceil(r));
    let (lx0, ly0) = (cx0 / ri, cy0 / ri);
    let lx1 = ((cx0 + cw as i64) as usize).div_ceil(r).min(lw) as i64;
    let ly1 = ((cy0 + ch as i64) as usize).div_ceil(r).min(lh) as i64;
    let (lcw, lch) = ((lx1 - lx0) as usize, (ly1 - ly0) as usize);
    let ms_low = degrade(&ms_ref, gw, gh, r, s.gnyq, lx0, ly0, lcw, lch)?;
    let pan_ll = degrade(&pan_low, gw, gh, r, s.gnyq, lx0, ly0, lcw, lch)?;
    accumulate(&mut s2, &ms_low, pan_ll.band(0));
    accumulate_pan(&mut s2, nb, pan_core.band(0));
    Ok((s1, s2, pan_low))
}

/// Wald's synthesis check on one G_L tile: the MS degraded by r and fused with the degraded pan
/// (`src_patch` = the stats tile's degraded pan) against the MS itself. → the quality accumulator.
pub fn wald_tile(s: &TileSpec, ms_px: &[f32], pan_low_px: &[f32]) -> Result<Vec<f64>> {
    check_patch("MS", s.ms_patch, ms_px.len(), s.nb)?;
    check_patch("degraded pan", s.src_patch, pan_low_px.len(), 1)?;
    let (gw, gh) = s.gl_size();
    let (r, nb) = (s.r, s.nb);
    let ri = r as i64;
    let e = grow(s.core, s.gl_apron(), gw, gh);
    let pan_low = Img { x0: s.src_patch.0, y0: s.src_patch.1, w: s.src_patch.2, h: s.src_patch.3, nb: 1, data: pan_low_px.to_vec() };
    if (pan_low.x0, pan_low.y0, pan_low.w, pan_low.h) != e {
        return Err(Error::invalid("pan-sharpen Wald tile: the degraded pan is not the stats tile's"));
    }
    let ms = Img { x0: s.ms_patch.0, y0: s.ms_patch.1, w: s.ms_patch.2, h: s.ms_patch.3, nb, data: ms_px.to_vec() };
    let mut ms_ref = resample(&ms, s.ms_size.0, s.ms_size.1, &s.a, Grid { ox: (e.0 * ri) as f64, oy: (e.1 * ri) as f64, s: r as f64, w: e.2, h: e.3 }, s.kernel)?;
    ms_ref.x0 = e.0;
    ms_ref.y0 = e.1;
    // The fusion region (core and the method's apron); the degraded MS around it (+2 for cubic).
    let f = grow(s.core, s.params.method.apron(r) as i64, gw, gh);
    let (lw, lh) = (gw.div_ceil(r), gh.div_ceil(r));
    let (fx0, fy0) = (f.0 / ri, f.1 / ri);
    let fl = (fx0, fy0, ((f.0 + f.2 as i64) as usize).div_ceil(r) - fx0 as usize, ((f.1 + f.3 as i64) as usize).div_ceil(r) - fy0 as usize);
    let lc = grow(fl, 2, lw, lh);
    let mut ms_low = degrade(&ms_ref, gw, gh, r, s.gnyq, lc.0, lc.1, lc.2, lc.3)?;
    if s.round_ms {
        round_all(&mut ms_low, s.out_max);
    }
    let k = 1.0 / r as f64;
    let mut up = resample(&ms_low, lw, lh, &[0.0, k, 0.0, 0.0, 0.0, k], Grid { ox: f.0 as f64, oy: f.1 as f64, s: 1.0, w: f.2, h: f.3 }, s.kernel)?;
    if s.round_ms {
        round_all(&mut up, s.out_max);
    }
    let pan_f = pan_low.crop(f.0, f.1, f.2, f.3);
    let core = ((s.core.0 - f.0) as usize, (s.core.1 - f.1) as usize, s.core.2, s.core.3);
    let fused = fuse(&s.params, &up, pan_f.band(0), core)?;
    let reference = ms_ref.crop(s.core.0, s.core.1, s.core.2, s.core.3);
    let mut acc = vec![0.0; quality_len(nb)];
    accumulate_quality(&mut acc, &reference, &fused, 32, s.q4);
    Ok(acc)
}

/// A fused full-resolution tile → (the core in the output type, pixel-interleaved little-endian
/// bytes; the consistency accumulator: the fused tile degraded by r against the MS).
pub fn fuse_tile(s: &TileSpec, ms_px: &[f32], pan_px: &[f32]) -> Result<(Vec<u8>, Vec<f64>)> {
    check_patch("MS", s.ms_patch, ms_px.len(), s.nb)?;
    check_patch("pan", s.src_patch, pan_px.len(), 1)?;
    let (r, nb) = (s.r, s.nb);
    let ri = r as i64;
    let (pw, ph) = s.pan_size;
    let rad = if s.quality { degrade_radius(r, s.gnyq) as i64 } else { 0 };
    let f = grow(s.core, rad, pw, ph);
    let p = grow(f, s.params.method.apron(r) as i64, pw, ph);
    let pan = Img { x0: s.src_patch.0, y0: s.src_patch.1, w: s.src_patch.2, h: s.src_patch.3, nb: 1, data: pan_px.to_vec() };
    if !holds(&pan, p) {
        return Err(Error::range("pan-sharpen: the pan patch does not cover the tile"));
    }
    let ms = Img { x0: s.ms_patch.0, y0: s.ms_patch.1, w: s.ms_patch.2, h: s.ms_patch.3, nb, data: ms_px.to_vec() };
    let mut up = resample(&ms, s.ms_size.0, s.ms_size.1, &s.a, Grid { ox: p.0 as f64, oy: p.1 as f64, s: 1.0, w: p.2, h: p.3 }, s.kernel)?;
    if s.round_ms {
        round_all(&mut up, s.out_max);
    }
    let pan_p = pan.crop(p.0, p.1, p.2, p.3);
    let mut fused = fuse(&s.params, &up, pan_p.band(0), ((f.0 - p.0) as usize, (f.1 - p.1) as usize, f.2, f.3))?;
    fused.x0 = f.0;
    fused.y0 = f.1;
    // Consistency: the G_L samples whose blocks lie inside the core.
    let mut acc = vec![0.0; quality_len(nb)];
    if s.quality {
        let (gx0, gy0) = ((s.core.0 + ri - 1) / ri, (s.core.1 + ri - 1) / ri);
        let (gx1, gy1) = ((s.core.0 + s.core.2 as i64) / ri, (s.core.1 + s.core.3 as i64) / ri);
        if gx1 > gx0 && gy1 > gy0 {
            let (gw, gh) = ((gx1 - gx0) as usize, (gy1 - gy0) as usize);
            let low = degrade(&fused, pw, ph, r, s.gnyq, gx0, gy0, gw, gh)?;
            let reference = resample(&ms, s.ms_size.0, s.ms_size.1, &s.a, Grid { ox: (gx0 * ri) as f64, oy: (gy0 * ri) as f64, s: r as f64, w: gw, h: gh }, s.kernel)?;
            accumulate_quality(&mut acc, &reference, &low, 32, s.q4);
        }
    }
    let core = fused.crop(s.core.0, s.core.1, s.core.2, s.core.3);
    let n = core.w * core.h;
    let top = |t: usize| if s.out_max > 0.0 { s.out_max } else { [f64::INFINITY, 255.0, 65535.0, 32767.0][t] };
    let t = (s.out_type as usize).min(3);
    let mut out = Vec::with_capacity(n * nb * [4, 1, 2, 2][t]);
    for i in 0..n {
        for b in 0..nb {
            let v = f64::from(core.data[b * n + i]);
            match t {
                1 => out.push(v.round().clamp(0.0, top(1)) as u8),
                2 => out.extend_from_slice(&(v.round().clamp(0.0, top(2)) as u16).to_le_bytes()),
                3 => out.extend_from_slice(&(v.round().clamp(-32768.0, top(3)) as i16).to_le_bytes()),
                _ => out.extend_from_slice(&(v as f32).to_le_bytes()),
            }
        }
    }
    Ok((out, acc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rnd(seed: &mut u64) -> f64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        (*seed % 1_000_000) as f64 / 1e6
    }

    #[test]
    fn fft_matches_a_direct_dft_and_inverts() {
        for n in [1usize, 2, 6, 15, 40, 45, 60] {
            let mut s = 7u64 + n as u64;
            let x: Vec<f64> = (0..n).map(|_| rnd(&mut s)).collect();
            let y: Vec<f64> = (0..n).map(|_| rnd(&mut s)).collect();
            let (mut re, mut im) = (x.clone(), y.clone());
            fft(&mut re, &mut im, false);
            for k in 0..n {
                let (mut ar, mut ai) = (0.0, 0.0);
                for t in 0..n {
                    let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
                    ar += x[t] * a.cos() - y[t] * a.sin();
                    ai += x[t] * a.sin() + y[t] * a.cos();
                }
                assert!((ar - re[k]).abs() < 1e-9 && (ai - im[k]).abs() < 1e-9, "n {n} k {k}");
            }
            fft(&mut re, &mut im, true);
            for t in 0..n {
                assert!((re[t] - x[t]).abs() < 1e-12 && (im[t] - y[t]).abs() < 1e-12);
            }
        }
        assert_eq!(fft_size(592), 600);
        assert_eq!(fft_size(512), 512);
    }

    #[test]
    fn quaternion_product_is_hamiltons() {
        // i·j = k, j·i = −k, k·k = −1.
        let (i, j, k) = ([0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]);
        let mut o = [0.0; 4];
        hc_mul(&i, &j, &mut o);
        assert_eq!(o, [0.0, 0.0, 0.0, 1.0]);
        hc_mul(&j, &i, &mut o);
        assert_eq!(o, [0.0, 0.0, 0.0, -1.0]);
        hc_mul(&k, &k, &mut o);
        assert_eq!(o, [-1.0, 0.0, 0.0, 0.0]);
        // Octonion norms multiply.
        let mut s = 3u64;
        let a: Vec<f64> = (0..8).map(|_| rnd(&mut s) - 0.5).collect();
        let b: Vec<f64> = (0..8).map(|_| rnd(&mut s) - 0.5).collect();
        let mut p = vec![0.0; 8];
        hc_mul(&a, &b, &mut p);
        let nrm = |v: &[f64]| v.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((nrm(&p) - nrm(&a) * nrm(&b)).abs() < 1e-12);
    }

    #[test]
    fn q_index_is_one_for_identical_blocks_and_drops_with_noise() {
        let mut s = 11u64;
        let z: Vec<Vec<f64>> = (0..4).map(|_| (0..1024).map(|_| 100.0 + 50.0 * rnd(&mut s)).collect()).collect();
        assert!((q2n_block(&z, &z) - 1.0).abs() < 1e-12);
        let v: Vec<Vec<f64>> = z.iter().map(|b| b.iter().map(|x| x + 20.0 * (rnd(&mut s) - 0.5)).collect()).collect();
        let q = q2n_block(&z, &v);
        assert!(q > 0.5 && q < 0.99, "{q}");
        // A gain changes Q (contrast term) but not SAM.
        let g: Vec<Vec<f64>> = z.iter().map(|b| b.iter().map(|x| 1.3 * x).collect()).collect();
        assert!(q2n_block(&z, &g) < 0.999);
    }

    #[test]
    fn identity_resampling_and_constant_degradation() {
        let mut ms = Img::new(0, 0, 16, 12, 2);
        for (i, v) in ms.data.iter_mut().enumerate() {
            *v = (i % 97) as f32;
        }
        let a = [0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        for k in [Kernel::Bilinear, Kernel::Cubic] {
            let o = resample(&ms, 16, 12, &a, Grid { ox: 0.0, oy: 0.0, s: 1.0, w: 16, h: 12 }, k).unwrap();
            assert!(o.data.iter().zip(&ms.data).all(|(x, y)| (x - y).abs() < 1e-4));
        }
        let mut c = Img::new(0, 0, 40, 40, 1);
        c.data.iter_mut().for_each(|v| *v = 7.5);
        let d = degrade(&c, 40, 40, 4, 0.3, 0, 0, 10, 10).unwrap();
        assert!(d.data.iter().all(|v| (v - 7.5).abs() < 1e-5));
        // Gain at the coarse Nyquist.
        let sg = sigma_for(4, 0.3);
        let f = 1.0 / 8.0;
        assert!(((-2.0 * (std::f64::consts::PI * sg * f).powi(2)).exp() - 0.3).abs() < 1e-12);
    }

    /// The closed form against a literal Gram–Schmidt transform (forward, replace GS1, inverse).
    #[test]
    fn gs_closed_form_equals_the_literal_transform() {
        let (w, h, nb) = (24, 20, 4);
        let n = w * h;
        let mut s = 5u64;
        let mut ms = Img::new(0, 0, w, h, nb);
        for v in ms.data.iter_mut() {
            *v = (200.0 + 300.0 * rnd(&mut s)) as f32;
        }
        let pan: Vec<f32> = (0..n).map(|i| (0..nb).map(|k| ms.data[k * n + i]).sum::<f32>() / nb as f32 + (50.0 * (rnd(&mut s) - 0.5)) as f32).collect();
        let wts = [0.1, 0.3, 0.4, 0.2];
        // Statistics.
        let col = |k: usize| -> Vec<f64> { (0..n).map(|i| f64::from(ms.data[k * n + i])).collect() };
        let sim: Vec<f64> = (0..n).map(|i| (0..nb).map(|k| wts[k] * f64::from(ms.data[k * n + i])).sum()).collect();
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let cov = |a: &[f64], b: &[f64]| {
            let (ma, mb) = (mean(a), mean(b));
            a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum::<f64>() / a.len() as f64
        };
        let pf: Vec<f64> = pan.iter().map(|&v| f64::from(v)).collect();
        let (mi, si) = (mean(&sim), cov(&sim, &sim).sqrt());
        let (mp, sp) = (mean(&pf), cov(&pf, &pf).sqrt());
        let g: Vec<f64> = (0..nb).map(|k| cov(&col(k), &sim) / cov(&sim, &sim)).collect();
        let p = Params { method: Method::Gs, c: wts.to_vec(), c0: 0.0, g, a_p: si / sp, b_p: mi - si / sp * mp, a2: 0.0, b2: 0.0, triples: vec![], rc: 0.0, beta: 0.0, box_w: 1 };
        let fast = fuse(&p, &ms, &pan, (0, 0, w, h)).unwrap();
        // Literal: GS components of [sim, m1..mn] (centred), GS1 ← matched pan − mean, inverse.
        let mut comps: Vec<Vec<f64>> = vec![sim.iter().map(|v| v - mi).collect()];
        let mut phi = vec![vec![0.0; nb + 1]; nb + 1];
        for k in 0..nb {
            let mut v: Vec<f64> = col(k).iter().map(|x| x - mean(&col(k))).collect();
            for (j, c) in comps.iter().enumerate() {
                let f = cov(&col(k), c) / cov(c, c);
                phi[k + 1][j] = f;
                for (a, b) in v.iter_mut().zip(c) {
                    *a -= f * b;
                }
            }
            comps.push(v);
        }
        comps[0] = pf.iter().map(|x| (x - mp) * si / sp).collect();
        for k in 0..nb {
            let m = mean(&col(k));
            for i in 0..n {
                let mut v = m + comps[k + 1][i];
                for j in 0..=k {
                    v += phi[k + 1][j] * comps[j][i];
                }
                assert!((v - f64::from(fast.data[k * n + i])).abs() < 1e-3, "band {k} px {i}: {v} vs {}", fast.data[k * n + i]);
            }
        }
    }

    #[test]
    fn ehlers_highpass_removes_low_frequencies_and_keeps_fine_detail() {
        let (w, h) = (96, 80);
        let tau = 2.0 * std::f64::consts::PI;
        let lo = |i: usize, j: usize| 5.0 + (tau * 0.02 * i as f64).cos() * (tau * 0.015 * j as f64).cos();
        let hi = |i: usize, j: usize| (tau * 0.4 * i as f64).cos() + (tau * 0.35 * j as f64).sin();
        let x: Vec<f64> = (0..w * h).map(|k| lo(k % w, k / w) + hi(k % w, k / w)).collect();
        let (a, _) = highpass_pair(&x, &vec![0.0; w * h], w, h, 1.0 / 8.0, 0.5);
        let mut worst: f64 = 0.0;
        for j in 16..h - 16 {
            for i in 16..w - 16 {
                worst = worst.max((a[j * w + i] - hi(i, j)).abs());
            }
        }
        assert!(worst < 0.02, "{worst}");
    }

    /// A synthetic pair (r = 4): smooth MS, pan = weighted MS at full resolution plus detail.
    fn pair(pw: usize, ph: usize, nb: usize) -> (Vec<f32>, Vec<f32>, usize, usize) {
        let (mw, mh) = (pw / 4, ph / 4);
        let mut s = 99u64;
        let ms: Vec<f32> = (0..nb * mw * mh).map(|i| (300.0 + 100.0 * ((i % mw) as f64 / 7.0).sin() + 80.0 * ((i / mw % mh) as f64 / 5.0).cos() + 40.0 * rnd(&mut s) + 30.0 * (i / (mw * mh)) as f64) as f32).collect();
        let pan: Vec<f32> = (0..pw * ph).map(|i| {
            let (x, y) = (i % pw, i / pw);
            let m: f32 = (0..nb).map(|k| ms[k * mw * mh + (y / 4) * mw + x / 4]).sum::<f32>() / nb as f32;
            m + (25.0 * ((x as f64 / 1.7).sin() * (y as f64 / 2.3).cos())) as f32
        }).collect();
        (ms, pan, mw, mh)
    }

    fn spec(method: Method, nb: usize, pw: usize, ph: usize, mw: usize, mh: usize) -> TileSpec {
        let c = vec![1.0 / nb as f64; nb];
        let triples = if method == Method::Ehlers { vec![([0, 1, 2], 1.1, -20.0), ([1, 2, 3], 0.9, 15.0)] } else { vec![] };
        TileSpec {
            nb,
            r: 4,
            kernel: Kernel::Cubic,
            gnyq: 0.3,
            ms_size: (mw, mh),
            pan_size: (pw, ph),
            a: [0.0, 0.25, 0.0, 0.0, 0.0, 0.25],
            ms_patch: (0, 0, mw, mh),
            src_patch: (0, 0, pw, ph),
            core: (0, 0, pw, ph),
            out_type: 0,
            out_max: 0.0,
            round_ms: false,
            quality: true,
            q4: None,
            params: Params { method, c: c.clone(), c0: 0.0, g: vec![0.8, 1.0, 1.1, 0.9], a_p: 1.05, b_p: -3.0, a2: 0.9, b2: 1000.0, triples, rc: 0.125, beta: 0.5, box_w: 7 },
        }
    }

    /// Tiles with aprons give the whole image's values (fusion, statistics, Wald), every method.
    #[test]
    fn tiles_equal_the_whole_image() {
        let (pw, ph, nb) = (256, 256, 4);
        let (ms, pan, mw, mh) = pair(pw, ph, nb);
        for method in [Method::Brovey, Method::Gs, Method::Pca, Method::Ehlers, Method::Hcs] {
            let whole = spec(method, nb, pw, ph, mw, mh);
            let (wb, wq) = fuse_tile(&whole, &ms, &pan).unwrap();
            let wf: Vec<f32> = wb.chunks(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
            let mut acc = vec![0.0; quality_len(nb)];
            let tile = 128usize;
            let mut worst = 0f32;
            for ty in (0..ph).step_by(tile) {
                for tx in (0..pw).step_by(tile) {
                    let mut t = whole.clone();
                    t.core = (tx as i64, ty as i64, tile.min(pw - tx), tile.min(ph - ty));
                    // Patches: the needed region only (as the app reads them).
                    let m = degrade_radius(4, 0.3) as i64 + method.apron(4) as i64;
                    let p = grow(t.core, m, pw, ph);
                    t.src_patch = p;
                    let crop = Img { x0: 0, y0: 0, w: pw, h: ph, nb: 1, data: pan.clone() }.crop(p.0, p.1, p.2, p.3);
                    let mp = grow((p.0 / 4, p.1 / 4, p.2.div_ceil(4) + 1, p.3.div_ceil(4) + 1), 3, mw, mh);
                    t.ms_patch = mp;
                    let mcrop = Img { x0: 0, y0: 0, w: mw, h: mh, nb, data: ms.clone() }.crop(mp.0, mp.1, mp.2, mp.3);
                    let (b, q) = fuse_tile(&t, &mcrop.data, &crop.data).unwrap();
                    for (k, v) in acc.iter_mut().enumerate() {
                        *v += q[k];
                    }
                    let f: Vec<f32> = b.chunks(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
                    let (cw, ch) = (t.core.2, t.core.3);
                    for y in 0..ch {
                        for x in 0..cw {
                            for k in 0..nb {
                                let a = f[(y * cw + x) * nb + k];
                                let w = wf[((ty + y) * pw + tx + x) * nb + k];
                                worst = worst.max((a - w).abs() / w.abs().max(1.0));
                            }
                        }
                    }
                }
            }
            // Ehlers' FFT blocks differ from the whole image's by their mirror-extended edges.
            let tol = if method == Method::Ehlers { 2e-2 } else { 1e-5 };
            assert!(worst < tol, "{method:?}: {worst}");
            let (e1, s1, q1, _) = quality_of(&wq, nb, 4.0);
            let (e2, s2, q2, _) = quality_of(&acc, nb, 4.0);
            assert!((e1 - e2).abs() < 1e-2 * e1.max(1e-3) && (s1 - s2).abs() < 1e-2 * s1.max(1e-3) && (q1 - q2).abs() < 2e-2, "{method:?} quality {e1} {e2} {s1} {s2} {q1} {q2}");
        }
    }

    #[test]
    fn stats_and_wald_tiles_sum_to_the_whole_image() {
        let (pw, ph, nb) = (256, 256, 4);
        let (ms, pan, mw, mh) = pair(pw, ph, nb);
        let mut whole = spec(Method::Gs, nb, pw, ph, mw, mh);
        whole.core = (0, 0, pw / 4, ph / 4);
        let (a1, a2, low) = stats_tile(&whole, &ms, &pan).unwrap();
        let mut w2 = whole.clone();
        w2.src_patch = (low.x0, low.y0, low.w, low.h);
        let qa = wald_tile(&w2, &ms, &low.data).unwrap();
        let (mut b1, mut b2, mut qb) = (vec![0.0; a1.len()], vec![0.0; a2.len()], vec![0.0; qa.len()]);
        for (cx, cy, cw, ch) in [(0, 0, 32, 32), (32, 0, 32, 32), (0, 32, 32, 32), (32, 32, 32, 32)] {
            let mut t = whole.clone();
            t.core = (cx, cy, cw, ch);
            let (s1, s2, lo) = stats_tile(&t, &ms, &pan).unwrap();
            for k in 0..s1.len() {
                b1[k] += s1[k];
                b2[k] += s2[k];
            }
            t.src_patch = (lo.x0, lo.y0, lo.w, lo.h);
            let q = wald_tile(&t, &ms, &lo.data).unwrap();
            for k in 0..q.len() {
                qb[k] += q[k];
            }
        }
        for k in 0..a1.len() {
            assert!((a1[k] - b1[k]).abs() <= 1e-9 * a1[k].abs().max(1.0), "S1[{k}] {} {}", a1[k], b1[k]);
            assert!((a2[k] - b2[k]).abs() <= 1e-9 * a2[k].abs().max(1.0), "S2[{k}] {} {}", a2[k], b2[k]);
        }
        for k in 0..qa.len() {
            assert!((qa[k] - qb[k]).abs() <= 1e-6 * qa[k].abs().max(1.0), "Q[{k}] {} {}", qa[k], qb[k]);
        }
        // Counts: every G_L sample once, every pan pixel once.
        assert_eq!(a1[0] as usize, (pw / 4) * (ph / 4));
        assert_eq!(a1[stats_len(nb) - 4] as usize, pw * ph);
    }
}
