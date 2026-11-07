//! CCD co-registration (REQ-SAR-09, `Research/09` §10.2): fine offsets by cross-correlation of
//! detected amplitude patches on a grid, refined to ~0.01 px with an upsampled matrix DFT
//! (Guizar-Sicairos et al. 2008) around the integer peak; an affine warp fitted with outlier
//! rejection; and a complex-safe 8-tap windowed-sinc resampler (bilinear I/Q would cost
//! coherence).

use crate::fft::{fft2, freq, Cx};

/// One tie offset: at image-1 pixel (x, y), image 2 matches at (x + dx, y + dy).
#[derive(Clone, Copy, Debug)]
pub struct Tie {
    pub x: f64,
    pub y: f64,
    pub dx: f64,
    pub dy: f64,
    pub peak: f64,
}

fn patch(a: &[f32], w: usize, h: usize, cx: usize, cy: usize, n: usize) -> Option<Vec<Cx>> {
    let (x0, y0) = (cx.checked_sub(n / 2)?, cy.checked_sub(n / 2)?);
    if x0 + n > w || y0 + n > h {
        return None;
    }
    let mut v: Vec<f64> = Vec::with_capacity(n * n);
    for y in 0..n {
        for x in 0..n {
            let s = a[(y0 + y) * w + x0 + x];
            v.push(if s.is_finite() { s as f64 } else { 0.0 });
        }
    }
    let m = v.iter().sum::<f64>() / v.len() as f64;
    let sd = (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / v.len() as f64).sqrt();
    if !(sd > 0.0) {
        return None;
    }
    // Hann taper against edge leakage.
    let hann = |i: usize| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64 + 0.5) / n as f64).cos();
    Some((0..n * n).map(|i| Cx::new((v[i] - m) / sd * hann(i % n) * hann(i / n), 0.0)).collect())
}

/// A Hann-tapered complex patch (no mean removal: coherent registration), or None outside.
fn cpatch(z: &[Cx], w: usize, h: usize, cx: usize, cy: usize, n: usize) -> Option<Vec<Cx>> {
    let (x0, y0) = (cx.checked_sub(n / 2)?, cy.checked_sub(n / 2)?);
    if x0 + n > w || y0 + n > h {
        return None;
    }
    let hann = |i: usize| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64 + 0.5) / n as f64).cos();
    let mut v = Vec::with_capacity(n * n);
    let mut e = 0.0;
    for y in 0..n {
        for x in 0..n {
            let s = z[(y0 + y) * w + x0 + x];
            let s = if s.re.is_finite() && s.im.is_finite() { s } else { Cx::ZERO };
            e += s.norm2();
            v.push(s.scale(hann(x) * hann(y)));
        }
    }
    if !(e > 0.0) {
        return None;
    }
    Some(v)
}

/// Cross-correlation value at a fractional lag from the cross-power spectrum X (n × n).
/// `magnitude`: maximise |CC| (complex data) instead of Re CC (detected data).
fn upsampled(xs: &[Cx], n: usize, r0: f64, c0: f64, up: usize, half: f64) -> (f64, f64, f64) {
    upsampled_m(xs, n, r0, c0, up, half, false)
}

fn upsampled_m(xs: &[Cx], n: usize, r0: f64, c0: f64, up: usize, half: f64, magnitude: bool) -> (f64, f64, f64) {
    // Output grid: lags r0 + (i − m)/up, c0 + (j − m)/up, i, j in 0..2m+1.
    let m = (half * up as f64).ceil() as usize;
    let k = 2 * m + 1;
    let two_pi = 2.0 * std::f64::consts::PI;
    // Row kernel (k × n) and column kernel (n × k): CC = Kr · X · Kc.
    let kr: Vec<Cx> = (0..k * n).map(|t| {
        let (i, u) = (t / n, t % n);
        let lag = r0 + (i as f64 - m as f64) / up as f64;
        Cx::cis(two_pi * freq(u, n) * lag / n as f64)
    }).collect();
    let kc: Vec<Cx> = (0..n * k).map(|t| {
        let (v, j) = (t / k, t % k);
        let lag = c0 + (j as f64 - m as f64) / up as f64;
        Cx::cis(two_pi * freq(v, n) * lag / n as f64)
    }).collect();
    // T = X · Kc (n × k), then CC = Kr · T (k × k).
    let mut t = vec![Cx::ZERO; n * k];
    for u in 0..n {
        for j in 0..k {
            let mut s = Cx::ZERO;
            for v in 0..n {
                s = s.add(xs[u * n + v].mul(kc[v * k + j]));
            }
            t[u * k + j] = s;
        }
    }
    let (mut best, mut bi, mut bj) = (f64::NEG_INFINITY, m, m);
    for i in 0..k {
        for j in 0..k {
            let mut s = Cx::ZERO;
            for u in 0..n {
                s = s.add(kr[i * n + u].mul(t[u * k + j]));
            }
            let v = if magnitude { s.abs() } else { s.re };
            if v > best {
                best = v;
                bi = i;
                bj = j;
            }
        }
    }
    (r0 + (bi as f64 - m as f64) / up as f64, c0 + (bj as f64 - m as f64) / up as f64, best)
}

/// Offsets on a grid with `spacing` px between patch centres and n × n patches (power of two).
pub fn offsets(a: &[f32], b: &[f32], w: usize, h: usize, spacing: usize, n: usize, max_shift: f64) -> Vec<Tie> {
    let mut out = Vec::new();
    let n = n.next_power_of_two().clamp(16, 256);
    let sp = spacing.max(n / 2);
    let mut cy = n / 2 + 4;
    while cy + n / 2 + 4 <= h {
        let mut cx = n / 2 + 4;
        while cx + n / 2 + 4 <= w {
            if let (Some(mut pa), Some(mut pb)) = (patch(a, w, h, cx, cy, n), patch(b, w, h, cx, cy, n)) {
                fft2(&mut pa, n, n, false);
                fft2(&mut pb, n, n, false);
                // Cross-power spectrum B·A*: its inverse peaks at the shift of b relative to a.
                let xs: Vec<Cx> = pa.iter().zip(&pb).map(|(p, q)| q.mul(p.conj())).collect();
                let mut cc = xs.clone();
                fft2(&mut cc, n, n, true);
                let (mut bi, mut bv) = (0usize, f64::NEG_INFINITY);
                for (i, v) in cc.iter().enumerate() {
                    if v.re > bv {
                        bv = v.re;
                        bi = i;
                    }
                }
                let (r0, c0) = (freq(bi / n, n), freq(bi % n, n));
                if r0.abs() <= max_shift && c0.abs() <= max_shift {
                    let (r1, c1, pk) = upsampled(&xs, n, r0, c0, 20, 1.5);
                    let norm = pa.iter().map(|v| v.norm2()).sum::<f64>().sqrt() * pb.iter().map(|v| v.norm2()).sum::<f64>().sqrt() / (n * n) as f64;
                    out.push(Tie { x: cx as f64, y: cy as f64, dx: c1, dy: r1, peak: if norm > 0.0 { pk / norm } else { 0.0 } });
                }
            }
            cx += sp;
        }
        cy += sp;
    }
    out
}

/// Coherent offsets of two complex images: |Σ f·g*| peaks at the shift exactly for band-limited
/// data, unaffected by a linear interferometric phase (which only lowers the peak).
pub fn offsets_complex(f: &[Cx], g: &[Cx], w: usize, h: usize, spacing: usize, n: usize, max_shift: f64) -> Vec<Tie> {
    let mut out = Vec::new();
    let n = n.next_power_of_two().clamp(16, 256);
    let sp = spacing.max(n / 2);
    let mut cy = n / 2 + 4;
    while cy + n / 2 + 4 <= h {
        let mut cx = n / 2 + 4;
        while cx + n / 2 + 4 <= w {
            if let (Some(mut pa), Some(mut pb)) = (cpatch(f, w, h, cx, cy, n), cpatch(g, w, h, cx, cy, n)) {
                let ea = pa.iter().map(|v| v.norm2()).sum::<f64>();
                let eb = pb.iter().map(|v| v.norm2()).sum::<f64>();
                fft2(&mut pa, n, n, false);
                fft2(&mut pb, n, n, false);
                let xs: Vec<Cx> = pa.iter().zip(&pb).map(|(p, q)| q.mul(p.conj())).collect();
                let mut cc = xs.clone();
                fft2(&mut cc, n, n, true);
                let (mut bi, mut bv) = (0usize, -1.0);
                for (i, v) in cc.iter().enumerate() {
                    let m = v.abs();
                    if m > bv {
                        bv = m;
                        bi = i;
                    }
                }
                let (r0, c0) = (freq(bi / n, n), freq(bi % n, n));
                if r0.abs() <= max_shift && c0.abs() <= max_shift {
                    let (r1, c1, pk) = upsampled_m(&xs, n, r0, c0, 20, 1.5, true);
                    // Normalised: |CC| over √(Ea·Eb) (the inverse DFT carries 1/n² per FFT pair).
                    let norm = (ea * eb).sqrt() * (n * n) as f64 / (n * n) as f64;
                    out.push(Tie { x: cx as f64, y: cy as f64, dx: c1, dy: r1, peak: if norm > 0.0 { pk / norm } else { 0.0 } });
                }
            }
            cx += sp;
        }
        cy += sp;
    }
    out
}

/// Least-squares affine warp dx = a0 + a1·x + a2·y, dy = b0 + b1·x + b2·y with two passes of
/// 3σ outlier rejection. Returns ([a0, a1, a2, b0, b1, b2], rms px, ties used).
pub fn fit_affine(ties: &[Tie]) -> Option<([f64; 6], f64, usize)> {
    let mut use_: Vec<bool> = ties.iter().map(|t| t.peak > 0.15).collect();
    let mut coef = [0f64; 6];
    let mut rms = f64::NAN;
    for _ in 0..3 {
        let idx: Vec<usize> = (0..ties.len()).filter(|&i| use_[i]).collect();
        if idx.len() < 3 {
            return None;
        }
        // Normal equations, 3 × 3, shared by both axes.
        let mut n = [[0f64; 3]; 3];
        let (mut bx, mut by) = ([0f64; 3], [0f64; 3]);
        for &i in &idx {
            let t = &ties[i];
            let row = [1.0, t.x, t.y];
            for r in 0..3 {
                for c in 0..3 {
                    n[r][c] += row[r] * row[c];
                }
                bx[r] += row[r] * t.dx;
                by[r] += row[r] * t.dy;
            }
        }
        let solve = |n: [[f64; 3]; 3], b: [f64; 3]| -> Option<[f64; 3]> {
            let det = |m: [[f64; 3]; 3]| m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
            let d = det(n);
            if d.abs() < 1e-12 {
                return None;
            }
            let mut x = [0f64; 3];
            for k in 0..3 {
                let mut m = n;
                for r in 0..3 {
                    m[r][k] = b[r];
                }
                x[k] = det(m) / d;
            }
            Some(x)
        };
        // An affine needs spread in x and y; with ties on one line, fall back to a shift.
        let (ax, ay) = match (solve(n, bx), solve(n, by)) {
            (Some(a), Some(b)) => (a, b),
            _ => {
                let k = idx.len() as f64;
                ([idx.iter().map(|&i| ties[i].dx).sum::<f64>() / k, 0.0, 0.0], [idx.iter().map(|&i| ties[i].dy).sum::<f64>() / k, 0.0, 0.0])
            }
        };
        coef = [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2]];
        let res: Vec<f64> = (0..ties.len())
            .map(|i| {
                let t = &ties[i];
                let ex = t.dx - (coef[0] + coef[1] * t.x + coef[2] * t.y);
                let ey = t.dy - (coef[3] + coef[4] * t.x + coef[5] * t.y);
                ex.hypot(ey)
            })
            .collect();
        let used: Vec<f64> = idx.iter().map(|&i| res[i]).collect();
        rms = (used.iter().map(|r| r * r).sum::<f64>() / used.len() as f64).sqrt();
        let lim = (3.0 * rms).max(0.05);
        let mut changed = false;
        for i in 0..ties.len() {
            let keep = ties[i].peak > 0.15 && res[i] <= lim;
            if keep != use_[i] {
                changed = true;
            }
            use_[i] = keep;
        }
        if !changed {
            break;
        }
    }
    Some((coef, rms, use_.iter().filter(|&&u| u).count()))
}

fn wsinc(x: f64) -> f64 {
    // 8 taps: sinc with a Hann window of half-width 4.
    if x.abs() >= 4.0 {
        return 0.0;
    }
    let s = if x.abs() < 1e-9 { 1.0 } else { (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x) };
    s * (0.5 + 0.5 * (std::f64::consts::PI * x / 4.0).cos())
}

/// Resample complex image g at (x + dx(x, y), y + dy(x, y)) for every output pixel.
pub fn resample(g: &[Cx], w: usize, h: usize, coef: &[f64; 6]) -> Vec<Cx> {
    let mut out = vec![Cx::ZERO; w * h];
    let mut wx = [0f64; 8];
    let mut wy = [0f64; 8];
    for y in 0..h {
        for x in 0..w {
            let (xf, yf) = (x as f64, y as f64);
            let sx = xf + coef[0] + coef[1] * xf + coef[2] * yf;
            let sy = yf + coef[3] + coef[4] * xf + coef[5] * yf;
            let (ix, iy) = (sx.floor() as isize, sy.floor() as isize);
            let (fx, fy) = (sx - ix as f64, sy - iy as f64);
            let (mut sumx, mut sumy) = (0.0, 0.0);
            for k in 0..8 {
                wx[k] = wsinc(fx - (k as f64 - 3.0));
                wy[k] = wsinc(fy - (k as f64 - 3.0));
                sumx += wx[k];
                sumy += wy[k];
            }
            let mut s = Cx::ZERO;
            let mut ok = true;
            for (ky, wyk) in wy.iter().enumerate() {
                let yy = iy + ky as isize - 3;
                if yy < 0 || yy >= h as isize {
                    ok = false;
                    break;
                }
                let mut r = Cx::ZERO;
                for (kx, wxk) in wx.iter().enumerate() {
                    let xx = ix + kx as isize - 3;
                    if xx < 0 || xx >= w as isize {
                        ok = false;
                        break;
                    }
                    r = r.add(g[yy as usize * w + xx as usize].scale(*wxk));
                }
                if !ok {
                    break;
                }
                s = s.add(r.scale(*wyk));
            }
            out[y * w + x] = if ok { s.scale(1.0 / (sumx * sumy)) } else { Cx::new(f64::NAN, f64::NAN) };
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coherent_shift_is_recovered_through_a_phase_ramp() {
        // Band-limited complex speckle shifted by (0.3, −0.2) px with a fringe ramp.
        let n = 128usize;
        let mut s = 5u64;
        let mut rnd = || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 11) as f64 / (1u64 << 53) as f64) - 0.5
        };
        let mut a: Vec<Cx> = (0..n * n).map(|_| Cx::new(rnd(), rnd())).collect();
        fft2(&mut a, n, n, false);
        for (i, v) in a.iter_mut().enumerate() {
            let (fy, fx) = (freq(i / n, n) / n as f64, freq(i % n, n) / n as f64);
            if fy.abs() > 0.35 || fx.abs() > 0.35 {
                *v = Cx::ZERO;
            }
        }
        let mut b: Vec<Cx> = a.iter().enumerate().map(|(i, v)| {
            let (fy, fx) = (freq(i / n, n) / n as f64, freq(i % n, n) / n as f64);
            v.mul(Cx::cis(-2.0 * std::f64::consts::PI * (fy * 0.3 + fx * -0.2)))
        }).collect();
        fft2(&mut a, n, n, true);
        fft2(&mut b, n, n, true);
        for (i, v) in b.iter_mut().enumerate() {
            *v = v.mul(Cx::cis(2.0 * std::f64::consts::PI * (0.011 * (i / n) as f64 - 0.004 * (i % n) as f64)));
        }
        // Flat earth first (on the integer-aligned pair), then coherent registration.
        let ifg: Vec<Cx> = a.iter().zip(&b).map(|(x, y)| x.mul(y.conj())).collect();
        let (fr, fc) = crate::change::fringe_frequency(&ifg, n, n);
        crate::change::remove_ramp(&mut b, n, n, fr, fc);
        let ties = offsets_complex(&a, &b, n, n, 32, 64, 4.0);
        assert!(!ties.is_empty());
        let (c, _, _) = fit_affine(&ties).unwrap();
        assert!((c[3] - 0.3).abs() < 0.02 && (c[0] + 0.2).abs() < 0.02, "{c:?}");
    }

    #[test]
    fn subpixel_shift_is_recovered() {
        let (w, h) = (192, 160);
        let tex = |x: f64, y: f64| (2.0 + (x / 3.1).sin() * (y / 4.3).cos() + 0.7 * ((x * 0.37 + y * 0.21).sin()) + 0.4 * ((x * 1.3 - y * 0.9).cos())) as f32;
        let a: Vec<f32> = (0..w * h).map(|i| tex((i % w) as f64, (i / w) as f64)).collect();
        let (sx, sy) = (0.3, -0.2);
        // b(x, y) = a(x − sx, y − sy): image 2 content is at (x + sx) of image 1.
        let b: Vec<f32> = (0..w * h).map(|i| tex((i % w) as f64 - sx, (i / w) as f64 - sy)).collect();
        let ties = offsets(&a, &b, w, h, 48, 64, 8.0);
        assert!(ties.len() >= 4);
        let (c, rms, _) = fit_affine(&ties).unwrap();
        assert!((c[0] - sx).abs() < 0.03 && (c[3] - sy).abs() < 0.03, "{c:?} rms {rms}");
    }
}
