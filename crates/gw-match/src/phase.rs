//! Phase correlation (REQ-GAP-46): the shift between two equal square windows from the normalised
//! cross-power spectrum (Kuglin & Hines 1975), with a Hann window, the integer peak, and a
//! sub-pixel peak from an upsampled matrix DFT around it (Guizar-Sicairos et al. 2008). Used to
//! register images to point-cloud intensity and hillshade, where NCC alone is slow over large
//! search ranges.

use crate::Win;
use std::f64::consts::PI;

/// In-place iterative radix-2 FFT of `re`/`im` (length a power of two); `inverse` without the 1/n.
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let ang = sign * 2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

/// 2-D FFT of an n × n row-major array.
pub fn fft2(re: &mut [f64], im: &mut [f64], n: usize, inverse: bool) {
    for r in 0..n {
        fft(&mut re[r * n..(r + 1) * n], &mut im[r * n..(r + 1) * n], inverse);
    }
    let (mut cr, mut ci) = (vec![0.0; n], vec![0.0; n]);
    for c in 0..n {
        for r in 0..n {
            cr[r] = re[r * n + c];
            ci[r] = im[r * n + c];
        }
        fft(&mut cr, &mut ci, inverse);
        for r in 0..n {
            re[r * n + c] = cr[r];
            im[r * n + c] = ci[r];
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PhaseMatch {
    /// Shift (pixels) of `b` against `a`: a feature at (x, y) in `a` is at (x + dx, y + dy) in `b`.
    pub dx: f64,
    pub dy: f64,
    /// Height of the correlation peak (1 for identical windows, near 0 for unrelated ones).
    pub peak: f64,
    /// Peak over the highest value outside a 3-pixel neighbourhood (≥ 1; higher is less ambiguous).
    pub ratio: f64,
}

/// Phase correlation of two n × n windows (n a power of two, 8..=1024). NaN pixels count as the
/// window mean. None when either window is flat or n is unsupported.
pub fn phase_correlate(a: Win<'_>, b: Win<'_>) -> Option<PhaseMatch> {
    let n = a.w;
    if a.h != n || b.w != n || b.h != n || !n.is_power_of_two() || !(8..=1024).contains(&n) || a.px.len() < n * n || b.px.len() < n * n {
        return None;
    }
    let hann: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * PI * (i as f64 + 0.5) / n as f64).cos()).collect();
    let prep = |w: Win<'_>| -> Option<(Vec<f64>, Vec<f64>)> {
        let vals: Vec<f64> = w.px[..n * n].iter().map(|v| f64::from(*v)).collect();
        let fin: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
        if fin.len() < n * n / 2 {
            return None;
        }
        let m = fin.iter().sum::<f64>() / fin.len() as f64;
        let var = fin.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / fin.len() as f64;
        if var <= 1e-12 {
            return None;
        }
        let re: Vec<f64> = vals.iter().enumerate().map(|(k, v)| if v.is_finite() { (v - m) * hann[k / n] * hann[k % n] } else { 0.0 }).collect();
        Some((re, vec![0.0; n * n]))
    };
    let (mut ar, mut ai) = prep(a)?;
    let (mut br, mut bi) = prep(b)?;
    fft2(&mut ar, &mut ai, n, false);
    fft2(&mut br, &mut bi, n, false);
    // R = conj(A)·B / |conj(A)·B|
    let mut rr = vec![0.0; n * n];
    let mut ri = vec![0.0; n * n];
    for k in 0..n * n {
        let x = ar[k] * br[k] + ai[k] * bi[k];
        let y = ar[k] * bi[k] - ai[k] * br[k];
        let m = x.hypot(y);
        if m > 1e-30 {
            rr[k] = x / m;
            ri[k] = y / m;
        }
    }
    let (mut cr, mut ci) = (rr.clone(), ri.clone());
    fft2(&mut cr, &mut ci, n, true);
    let nn = (n * n) as f64;
    let (mut bk, mut best) = (0, f64::MIN);
    for (k, v) in cr.iter().enumerate() {
        if *v > best {
            best = *v;
            bk = k;
        }
    }
    let (px, py) = (bk % n, bk / n);
    let wrap = |v: usize| if v > n / 2 { v as f64 - n as f64 } else { v as f64 };
    let (ix, iy) = (wrap(px), wrap(py));
    let mut second = f64::MIN;
    for (k, v) in cr.iter().enumerate() {
        let (x, y) = (wrap(k % n), wrap(k / n));
        let (ddx, ddy) = ((x - ix).abs().min(n as f64 - (x - ix).abs()), (y - iy).abs().min(n as f64 - (y - iy).abs()));
        if ddx > 3.0 || ddy > 3.0 {
            second = second.max(*v);
        }
    }
    // Sub-pixel: the inverse DFT of R sampled on a 1/16-pixel grid over ±1 pixel around the peak.
    const UP: f64 = 16.0;
    let m = 33usize;
    let off = |i: usize| (i as f64 - 16.0) / UP;
    // First along x: for each frequency row ky and each sample sx, Σ_kx R e^{+2πi kx·x/n}.
    let freq = |k: usize| if k > n / 2 { k as f64 - n as f64 } else { k as f64 };
    let mut tr = vec![0.0; n * m];
    let mut ti = vec![0.0; n * m];
    for sx in 0..m {
        let x = ix + off(sx);
        let (cs, sn): (Vec<f64>, Vec<f64>) = (0..n).map(|kx| (2.0 * PI * freq(kx) * x / n as f64).sin_cos()).map(|(s, c)| (c, s)).unzip();
        for ky in 0..n {
            let (mut sr, mut si) = (0.0, 0.0);
            for kx in 0..n {
                let (r, i) = (rr[ky * n + kx], ri[ky * n + kx]);
                sr += r * cs[kx] - i * sn[kx];
                si += r * sn[kx] + i * cs[kx];
            }
            tr[ky * m + sx] = sr;
            ti[ky * m + sx] = si;
        }
    }
    let (mut bs, mut bv) = ((16usize, 16usize), f64::MIN);
    for sy in 0..m {
        let y = iy + off(sy);
        let (cs, sn): (Vec<f64>, Vec<f64>) = (0..n).map(|ky| (2.0 * PI * freq(ky) * y / n as f64).sin_cos()).map(|(s, c)| (c, s)).unzip();
        for sx in 0..m {
            let mut sr = 0.0;
            for ky in 0..n {
                sr += tr[ky * m + sx] * cs[ky] - ti[ky * m + sx] * sn[ky];
            }
            if sr > bv {
                bv = sr;
                bs = (sx, sy);
            }
        }
    }
    Some(PhaseMatch { dx: ix + off(bs.0), dy: iy + off(bs.1), peak: (bv / nn).max(best / nn), ratio: if second > 0.0 { best / second } else { f64::INFINITY } })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Broadband periodic texture (a random spectrum, amplitude ∝ 1/(1 + |k|)) moved by (sx, sy)
    /// through the shift theorem: the content moves by +s exactly, also for fractional shifts.
    pub(crate) fn scene(n: usize, sx: f64, sy: f64) -> Vec<f32> {
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 11) as f64 / (1u64 << 53) as f64
        };
        let f = |k: usize| if k > n / 2 { k as f64 - n as f64 } else { k as f64 };
        let (mut re, mut im) = (vec![0.0; n * n], vec![0.0; n * n]);
        for ky in 0..n {
            for kx in 0..n {
                let (u, v) = (f(kx), f(ky));
                let amp = 1.0 / (1.0 + u.hypot(v));
                let ph = 2.0 * PI * rnd() - 2.0 * PI * (u * sx + v * sy) / n as f64;
                re[ky * n + kx] = amp * ph.cos();
                im[ky * n + kx] = amp * ph.sin();
            }
        }
        fft2(&mut re, &mut im, n, true);
        // The real part of a non-Hermitian spectrum is still the same texture moved by s.
        re.iter().map(|v| *v as f32).collect()
    }

    #[test]
    fn fft_round_trip() {
        let mut re: Vec<f64> = (0..64).map(|i| (i as f64 * 0.3).sin()).collect();
        let orig = re.clone();
        let mut im = vec![0.0; 64];
        fft(&mut re, &mut im, false);
        fft(&mut re, &mut im, true);
        for (a, b) in re.iter().zip(&orig) {
            assert!((a / 64.0 - b).abs() < 1e-12);
        }
    }

    #[test]
    fn recovers_integer_and_subpixel_shifts() {
        let n = 64;
        let a = scene(n, 0.0, 0.0);
        for &(sx, sy) in &[(3.0, -5.0), (0.25, 0.75), (-7.4, 2.6), (12.0, 9.0)] {
            let b = scene(n, sx, sy);
            let m = phase_correlate(Win { w: n, h: n, px: &a }, Win { w: n, h: n, px: &b }).unwrap();
            // The window (fixed in both) biases a large shift towards zero by a few per cent.
            let tol = |s: f64| 0.07 + 0.04 * s.abs();
            assert!((m.dx - sx).abs() < tol(sx) && (m.dy - sy).abs() < tol(sy), "({sx}, {sy}) → {m:?}");
            assert!(m.peak > 0.1 && m.ratio > 1.2, "{m:?}");
        }
    }

    #[test]
    fn second_pass_at_the_integer_offset_removes_the_window_bias() {
        // As the registration does: cut b again at the rounded shift and correlate the remainder.
        let (n, big) = (64, 128);
        let full_a = scene(big, 0.0, 0.0);
        let full_b = scene(big, -7.4, 2.6);
        let cut = |f: &[f32], x0: i64, y0: i64| -> Vec<f32> { (0..n * n).map(|k| f[((y0 + (k / n) as i64) as usize) * big + (x0 + (k % n) as i64) as usize]).collect() };
        let a = cut(&full_a, 32, 32);
        let m1 = phase_correlate(Win { w: n, h: n, px: &a }, Win { w: n, h: n, px: &cut(&full_b, 32, 32) }).unwrap();
        let (ox, oy) = (m1.dx.round() as i64, m1.dy.round() as i64);
        let m2 = phase_correlate(Win { w: n, h: n, px: &a }, Win { w: n, h: n, px: &cut(&full_b, 32 + ox, 32 + oy) }).unwrap();
        let (dx, dy) = (ox as f64 + m2.dx, oy as f64 + m2.dy);
        assert!((dx + 7.4).abs() < 0.07 && (dy - 2.6).abs() < 0.07, "{dx} {dy}");
    }

    #[test]
    fn contrast_and_gain_do_not_matter_flat_is_refused() {
        let n = 32;
        let a = scene(n, 0.0, 0.0);
        let b: Vec<f32> = scene(n, 2.0, 1.0).iter().map(|v| v * 40.0 + 1000.0).collect();
        let m = phase_correlate(Win { w: n, h: n, px: &a }, Win { w: n, h: n, px: &b }).unwrap();
        assert!((m.dx - 2.0).abs() < 0.2 && (m.dy - 1.0).abs() < 0.2, "{m:?}");
        let flat = vec![5.0f32; n * n];
        assert!(phase_correlate(Win { w: n, h: n, px: &a }, Win { w: n, h: n, px: &flat }).is_none());
        assert!(phase_correlate(Win { w: 30, h: 30, px: &a }, Win { w: 30, h: 30, px: &a }).is_none());
    }
}
