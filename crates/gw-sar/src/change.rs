//! Amplitude and coherent change detection (REQ-SAR-08/09/14, `Research/09` §10).
//!
//! * Log-ratio r = 10·log10(Ī₂/Ī₁) of window means (multi-looked intensities).
//! * Sample coherence γ̂ = |Σ f g*| / √(Σ|f|² Σ|g|²) over a 3×3 … 9×9 window, and the
//!   interferometric phase of Σ f g*, by summed-area tables.
//! * A noise-compensated estimator (after Wahl et al. 2016): the noise powers are taken out of
//!   the window powers, so low clutter-to-noise areas do not read as change. Pixels whose CNR is
//!   below the threshold are "no decision" (NaN).
//! * Flat-earth removal: the dominant interferogram fringe frequency from a 2-D FFT peak with
//!   sub-bin refinement, removed as a linear phase ramp.
//! * Goldstein–Werner adaptive interferogram filter (overlapping 32² patches, |S|^α weights).

use crate::fft::{fft2, freq, next_pow2, Cx};

/// Complex summed-area table.
struct CSat {
    w: usize,
    t: Vec<Cx>,
}
impl CSat {
    fn new(v: &[Cx], w: usize, h: usize) -> CSat {
        let iw = w + 1;
        let mut t = vec![Cx::ZERO; iw * (h + 1)];
        for y in 0..h {
            let mut r = Cx::ZERO;
            for x in 0..w {
                r = r.add(v[y * w + x]);
                t[(y + 1) * iw + x + 1] = t[y * iw + x + 1].add(r);
            }
        }
        CSat { w: iw, t }
    }
    fn sum(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> Cx {
        let w = self.w;
        self.t[y1 * w + x1].sub(self.t[y0 * w + x1]).sub(self.t[y1 * w + x0]).add(self.t[y0 * w + x0])
    }
}

fn rsat(v: &[f64], w: usize, h: usize) -> Vec<f64> {
    let iw = w + 1;
    let mut t = vec![0f64; iw * (h + 1)];
    for y in 0..h {
        let mut r = 0.0;
        for x in 0..w {
            r += v[y * w + x];
            t[(y + 1) * iw + x + 1] = t[y * iw + x + 1] + r;
        }
    }
    t
}
fn rsum(t: &[f64], w: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
    let iw = w + 1;
    t[y1 * iw + x1] - t[y0 * iw + x1] - t[y1 * iw + x0] + t[y0 * iw + x0]
}

/// Output of [`coherence`].
pub struct Coherence {
    pub gamma: Vec<f32>,
    pub phase: Vec<f32>,
    /// Mean intensity of each image in the window (for the colour products and the CNR mask).
    pub i1: Vec<f32>,
    pub i2: Vec<f32>,
}

/// Coherence over a win × win window (odd, 3–9). `noise` = (σ²ₙ₁, σ²ₙ₂) noise powers, used by
/// the compensated estimator when `compensate`; pixels whose CNR (dB) is below `cnr_db` in either
/// image get NaN ("no decision"). NaN `cnr_db` disables the mask.
pub fn coherence(f: &[Cx], g: &[Cx], w: usize, h: usize, win: usize, noise: (f64, f64), compensate: bool, cnr_db: f64) -> Coherence {
    let r = (win.clamp(3, 9) | 1) / 2;
    let fg: Vec<Cx> = f.iter().zip(g).map(|(a, b)| a.mul(b.conj())).collect();
    let pf: Vec<f64> = f.iter().map(|a| a.norm2()).collect();
    let pg: Vec<f64> = g.iter().map(|a| a.norm2()).collect();
    let s = CSat::new(&fg, w, h);
    let tf = rsat(&pf, w, h);
    let tg = rsat(&pg, w, h);
    let n = w * h;
    let mut out = Coherence { gamma: vec![f32::NAN; n], phase: vec![f32::NAN; n], i1: vec![f32::NAN; n], i2: vec![f32::NAN; n] };
    let cnr_lin = if cnr_db.is_finite() { 10f64.powf(cnr_db / 10.0) } else { 0.0 };
    for y in 0..h {
        for x in 0..w {
            let (x0, y0, x1, y1) = (x.saturating_sub(r), y.saturating_sub(r), (x + r + 1).min(w), (y + r + 1).min(h));
            let k = ((x1 - x0) * (y1 - y0)) as f64;
            let c = s.sum(x0, y0, x1, y1);
            let (a, b) = (rsum(&tf, w, x0, y0, x1, y1), rsum(&tg, w, x0, y0, x1, y1));
            let i = y * w + x;
            out.i1[i] = (a / k) as f32;
            out.i2[i] = (b / k) as f32;
            out.phase[i] = c.arg() as f32;
            if cnr_db.is_finite() && (a / k < (1.0 + cnr_lin) * noise.0.max(1e-30) || b / k < (1.0 + cnr_lin) * noise.1.max(1e-30)) {
                continue; // clutter + noise below (1 + CNR)·noise: no decision
            }
            let (a2, b2) = if compensate { ((a - k * noise.0).max(1e-30), (b - k * noise.1).max(1e-30)) } else { (a, b) };
            let d = (a2 * b2).sqrt();
            out.gamma[i] = if d > 0.0 { (c.abs() / d).min(1.0) as f32 } else { f32::NAN };
        }
    }
    out
}

/// 10·log10 of the ratio of window-mean intensities (image 2 over image 1), dB.
pub fn log_ratio(i1: &[f32], i2: &[f32], w: usize, h: usize, win: usize) -> Vec<f32> {
    let r = win.max(1) / 2;
    let a: Vec<f64> = i1.iter().map(|&v| if v.is_finite() { v as f64 } else { 0.0 }).collect();
    let b: Vec<f64> = i2.iter().map(|&v| if v.is_finite() { v as f64 } else { 0.0 }).collect();
    let (ta, tb) = (rsat(&a, w, h), rsat(&b, w, h));
    let mut out = vec![f32::NAN; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, y0, x1, y1) = (x.saturating_sub(r), y.saturating_sub(r), (x + r + 1).min(w), (y + r + 1).min(h));
            let (sa, sb) = (rsum(&ta, w, x0, y0, x1, y1), rsum(&tb, w, x0, y0, x1, y1));
            if sa > 0.0 && sb > 0.0 {
                out[y * w + x] = (10.0 * (sb / sa).log10()) as f32;
            }
        }
    }
    out
}

/// The interferogram's dominant fringe frequency (cycles per pixel, rows then columns).
pub fn fringe_frequency(ifg: &[Cx], w: usize, h: usize) -> (f64, f64) {
    let (pw, ph) = (next_pow2(w), next_pow2(h));
    let mut a = vec![Cx::ZERO; pw * ph];
    for y in 0..h {
        for x in 0..w {
            let v = ifg[y * w + x];
            let m = v.abs();
            // Unit phasors: amplitude does not bias the peak.
            if m > 0.0 && m.is_finite() {
                a[y * pw + x] = v.scale(1.0 / m);
            }
        }
    }
    fft2(&mut a, pw, ph, false);
    let (mut bi, mut bv) = (0usize, -1.0);
    for (i, v) in a.iter().enumerate() {
        let m = v.norm2();
        if m > bv {
            bv = m;
            bi = i;
        }
    }
    let (kx, ky) = (bi % pw, bi / pw);
    let (mut fr, mut fc) = (freq(ky, ph) / ph as f64, freq(kx, pw) / pw as f64);
    // Refine inside ±1 bin by maximising |Σ ifg·e^{−j2π(fr·r + fc·c)}| (golden section per axis,
    // on every 2nd sample).
    let obj = |fr: f64, fc: f64| {
        let mut s = Cx::ZERO;
        for y in (0..h).step_by(2) {
            for x in (0..w).step_by(2) {
                let v = ifg[y * w + x];
                let m = v.abs();
                if m > 0.0 && m.is_finite() {
                    s = s.add(v.scale(1.0 / m).mul(Cx::cis(-2.0 * std::f64::consts::PI * (fr * y as f64 + fc * x as f64))));
                }
            }
        }
        s.abs()
    };
    let golden = |f: &dyn Fn(f64) -> f64, mut a: f64, mut b: f64| {
        let g = 0.618_033_988_75;
        let (mut c, mut d) = (b - g * (b - a), a + g * (b - a));
        let (mut fc_, mut fd) = (f(c), f(d));
        for _ in 0..40 {
            if fc_ > fd {
                b = d;
                d = c;
                fd = fc_;
                c = b - g * (b - a);
                fc_ = f(c);
            } else {
                a = c;
                c = d;
                fc_ = fd;
                d = a + g * (b - a);
                fd = f(d);
            }
        }
        0.5 * (a + b)
    };
    for _ in 0..2 {
        let br = 1.0 / ph as f64;
        fr = golden(&|t| obj(t, fc), fr - br, fr + br);
        let bc = 1.0 / pw as f64;
        fc = golden(&|t| obj(fr, t), fc - bc, fc + bc);
    }
    (fr, fc)
}

/// Flatten an interferogram whose fringe frequency is (fr, fc) cycles per pixel by changing
/// image g: f·(g·e^{jt})* = (f g*)·e^{−jt} with t = 2π (fr·row + fc·col).
pub fn remove_ramp(g: &mut [Cx], w: usize, h: usize, fr: f64, fc: f64) {
    for y in 0..h {
        for x in 0..w {
            let t = 2.0 * std::f64::consts::PI * (fr * y as f64 + fc * x as f64);
            let i = y * w + x;
            g[i] = g[i].mul(Cx::cis(t));
        }
    }
}

/// Goldstein–Werner filter of an interferogram: 32² patches with step 8, spectrum weighted by
/// |S|^α (α 0 … 1) after a 3×3 smoothing of |S|, overlap-added with a triangular window.
pub fn goldstein(ifg: &[Cx], w: usize, h: usize, alpha: f64) -> Vec<Cx> {
    let p = 32usize;
    let step = 8usize;
    let mut acc = vec![Cx::ZERO; w * h];
    let mut wsum = vec![0f64; w * h];
    let tri = |i: usize| 1.0 - ((i as f64 + 0.5) - p as f64 / 2.0).abs() / (p as f64 / 2.0);
    let ys: Vec<usize> = (0..h.saturating_sub(p) + 1).step_by(step).chain(std::iter::once(h.saturating_sub(p))).collect();
    let xs: Vec<usize> = (0..w.saturating_sub(p) + 1).step_by(step).chain(std::iter::once(w.saturating_sub(p))).collect();
    let mut buf = vec![Cx::ZERO; p * p];
    for &y0 in &ys {
        for &x0 in &xs {
            for y in 0..p {
                for x in 0..p {
                    let (yy, xx) = (y0 + y, x0 + x);
                    buf[y * p + x] = if yy < h && xx < w { ifg[yy * w + xx] } else { Cx::ZERO };
                }
            }
            fft2(&mut buf, p, p, false);
            let mag: Vec<f64> = buf.iter().map(|v| v.abs()).collect();
            for y in 0..p {
                for x in 0..p {
                    let mut s = 0.0;
                    for dy in [p - 1, 0, 1] {
                        for dx in [p - 1, 0, 1] {
                            s += mag[((y + dy) % p) * p + (x + dx) % p];
                        }
                    }
                    let k = (s / 9.0).powf(alpha);
                    buf[y * p + x] = buf[y * p + x].scale(k);
                }
            }
            fft2(&mut buf, p, p, true);
            for y in 0..p {
                for x in 0..p {
                    let (yy, xx) = (y0 + y, x0 + x);
                    if yy < h && xx < w {
                        let wt = tri(y) * tri(x);
                        acc[yy * w + xx] = acc[yy * w + xx].add(buf[y * p + x].scale(wt));
                        wsum[yy * w + xx] += wt;
                    }
                }
            }
        }
    }
    acc.iter().zip(&wsum).map(|(a, &s)| if s > 0.0 { a.scale(1.0 / s) } else { Cx::ZERO }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rng(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64 / (1u64 << 53) as f64).max(1e-12)
    }
    fn gauss(seed: &mut u64) -> Cx {
        let (u, v) = (rng(seed), rng(seed));
        let r = (-u.ln()).sqrt();
        Cx::new(r * (2.0 * std::f64::consts::PI * v).cos(), r * (2.0 * std::f64::consts::PI * v).sin())
    }

    #[test]
    fn coherence_of_correlated_and_independent_speckle() {
        let (w, h) = (96, 48);
        let mut s = 11u64;
        let f: Vec<Cx> = (0..w * h).map(|_| gauss(&mut s)).collect();
        let g: Vec<Cx> = (0..w * h)
            .map(|i| {
                let e = gauss(&mut s);
                if i % w < w / 2 {
                    f[i].scale(0.98).add(e.scale((1.0f64 - 0.98 * 0.98).sqrt()))
                } else {
                    e
                }
            })
            .collect();
        let c = coherence(&f, &g, w, h, 5, (0.0, 0.0), false, f64::NAN);
        let mean = |x0: usize, x1: usize| {
            let (mut a, mut n) = (0.0, 0.0);
            for y in 4..h - 4 {
                for x in x0..x1 {
                    a += c.gamma[y * w + x] as f64;
                    n += 1.0;
                }
            }
            a / n
        };
        assert!(mean(4, w / 2 - 4) > 0.9);
        assert!(mean(w / 2 + 4, w - 4) < 0.4);
    }

    #[test]
    fn fringe_frequency_is_found() {
        let (w, h) = (64, 64);
        let ifg: Vec<Cx> = (0..w * h).map(|i| Cx::cis(2.0 * std::f64::consts::PI * (0.011 * (i / w) as f64 - 0.004 * (i % w) as f64))).collect();
        let (fr, fc) = fringe_frequency(&ifg, w, h);
        assert!((fr - 0.011).abs() < 0.003 && (fc + 0.004).abs() < 0.003, "{fr} {fc}");
    }
}
