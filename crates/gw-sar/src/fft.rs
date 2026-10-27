//! A small complex FFT (iterative radix-2, power-of-two lengths) and 2-D helpers. Sizes that
//! are not powers of two are zero-padded by the callers. Kept local instead of `rustfft` to fit
//! the bundle budget (Appendix D §2.2).

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cx {
    pub re: f64,
    pub im: f64,
}

impl Cx {
    pub const ZERO: Cx = Cx { re: 0.0, im: 0.0 };
    pub fn new(re: f64, im: f64) -> Cx {
        Cx { re, im }
    }
    pub fn mul(self, o: Cx) -> Cx {
        Cx { re: self.re * o.re - self.im * o.im, im: self.re * o.im + self.im * o.re }
    }
    pub fn conj(self) -> Cx {
        Cx { re: self.re, im: -self.im }
    }
    pub fn add(self, o: Cx) -> Cx {
        Cx { re: self.re + o.re, im: self.im + o.im }
    }
    pub fn sub(self, o: Cx) -> Cx {
        Cx { re: self.re - o.re, im: self.im - o.im }
    }
    pub fn scale(self, k: f64) -> Cx {
        Cx { re: self.re * k, im: self.im * k }
    }
    pub fn norm2(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
    pub fn abs(self) -> f64 {
        self.norm2().sqrt()
    }
    pub fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }
    pub fn cis(t: f64) -> Cx {
        Cx { re: t.cos(), im: t.sin() }
    }
}

pub fn next_pow2(n: usize) -> usize {
    n.max(1).next_power_of_two()
}

/// In-place FFT of a power-of-two length; `inverse` divides by n.
pub fn fft(a: &mut [Cx], inverse: bool) {
    let n = a.len();
    if n <= 1 {
        return;
    }
    debug_assert!(n.is_power_of_two());
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            a.swap(i, j);
        }
    }
    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2;
    while len <= n {
        let w = Cx::cis(sign * 2.0 * std::f64::consts::PI / len as f64);
        for s in (0..n).step_by(len) {
            let mut wk = Cx::new(1.0, 0.0);
            for k in 0..len / 2 {
                let u = a[s + k];
                let v = a[s + k + len / 2].mul(wk);
                a[s + k] = u.add(v);
                a[s + k + len / 2] = u.sub(v);
                wk = wk.mul(w);
            }
        }
        len <<= 1;
    }
    if inverse {
        let k = 1.0 / n as f64;
        for x in a.iter_mut() {
            *x = x.scale(k);
        }
    }
}

/// 2-D FFT of a w × h row-major array (both powers of two).
pub fn fft2(a: &mut [Cx], w: usize, h: usize, inverse: bool) {
    let mut col = vec![Cx::ZERO; h];
    for r in 0..h {
        fft(&mut a[r * w..(r + 1) * w], inverse);
    }
    for c in 0..w {
        for r in 0..h {
            col[r] = a[r * w + c];
        }
        fft(&mut col, inverse);
        for r in 0..h {
            a[r * w + c] = col[r];
        }
    }
}

/// Signed frequency index of bin k of an n-point transform.
pub fn freq(k: usize, n: usize) -> f64 {
    if k < n.div_ceil(2) {
        k as f64
    } else {
        k as f64 - n as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_round_trip_and_tone() {
        let n = 64;
        let mut a: Vec<Cx> = (0..n).map(|i| Cx::cis(2.0 * std::f64::consts::PI * 5.0 * i as f64 / n as f64)).collect();
        let b = a.clone();
        fft(&mut a, false);
        let peak = (0..n).max_by(|&i, &j| a[i].abs().partial_cmp(&a[j].abs()).unwrap()).unwrap();
        assert_eq!(peak, 5);
        fft(&mut a, true);
        for (x, y) in a.iter().zip(&b) {
            assert!(x.sub(*y).abs() < 1e-12);
        }
    }
}
