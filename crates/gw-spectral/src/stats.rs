//! Band statistics, covariance, SNR and class separability (REQ-MSI-07/08, `Research/10` §7).
//! A cube is BIP f32: pixel p, band b at `v[p * nb + b]`; a pixel with any non-finite band is
//! skipped.

use crate::linalg::{inverse_logdet, quad, Sym};

pub struct Cube<'a> {
    pub v: &'a [f32],
    pub nb: usize,
    pub w: usize,
    pub h: usize,
}

impl<'a> Cube<'a> {
    pub fn n(&self) -> usize {
        self.w * self.h
    }
    pub fn px(&self, p: usize) -> &'a [f32] {
        &self.v[p * self.nb..(p + 1) * self.nb]
    }
    pub fn valid(&self, p: usize) -> bool {
        self.px(p).iter().all(|x| x.is_finite())
    }
}

/// Mean and covariance over pixels `idx` (or every `step`-th pixel when idx is None).
pub fn mean_cov(c: &Cube, idx: Option<&[usize]>, step: usize) -> (Vec<f64>, Sym, usize) {
    let nb = c.nb;
    let mut m = vec![0.0; nb];
    let mut s = Sym::zeros(nb);
    let mut n = 0usize;
    let mut each = |p: usize| {
        if !c.valid(p) {
            return;
        }
        let x = c.px(p);
        n += 1;
        // Welford update of the mean and the co-moment.
        let mut d = vec![0.0; nb];
        for b in 0..nb {
            d[b] = x[b] as f64 - m[b];
            m[b] += d[b] / n as f64;
        }
        for i in 0..nb {
            let di = x[i] as f64 - m[i];
            for j in 0..=i {
                s.a[i * nb + j] += d[j] * di;
            }
        }
    };
    match idx {
        Some(ix) => ix.iter().for_each(|&p| each(p)),
        None => (0..c.n()).step_by(step.max(1)).for_each(each),
    }
    let k = (n.max(2) - 1) as f64;
    for i in 0..nb {
        for j in 0..=i {
            let v = s.a[i * nb + j] / k;
            s.a[i * nb + j] = v;
            s.a[j * nb + i] = v;
        }
    }
    (m, s, n)
}

/// Per-band min, max, mean, σ and count.
pub fn band_stats(c: &Cube) -> Vec<[f64; 5]> {
    let mut out = vec![[f64::INFINITY, f64::NEG_INFINITY, 0.0, 0.0, 0.0]; c.nb];
    for p in 0..c.n() {
        let x = c.px(p);
        for b in 0..c.nb {
            let v = x[b] as f64;
            if !v.is_finite() {
                continue;
            }
            let o = &mut out[b];
            o[0] = o[0].min(v);
            o[1] = o[1].max(v);
            o[2] += v;
            o[3] += v * v;
            o[4] += 1.0;
        }
    }
    for o in &mut out {
        if o[4] > 0.0 {
            let m = o[2] / o[4];
            o[3] = (o[3] / o[4] - m * m).max(0.0).sqrt();
            o[2] = m;
        }
    }
    out
}

/// SNR per band: mean over the noise σ estimated from horizontal shift differences
/// (σ_n = std(x(i, j) − x(i, j+1)) / √2), as MNF does.
pub fn snr(c: &Cube) -> Vec<f64> {
    let mut out = vec![0.0; c.nb];
    for (b, o) in out.iter_mut().enumerate() {
        let (mut s, mut s2, mut n, mut sm) = (0.0, 0.0, 0.0, 0.0);
        for y in 0..c.h {
            for x in 0..c.w.saturating_sub(1) {
                let a = c.v[(y * c.w + x) * c.nb + b] as f64;
                let d = c.v[(y * c.w + x + 1) * c.nb + b] as f64;
                if a.is_finite() && d.is_finite() {
                    let e = a - d;
                    s += e;
                    s2 += e * e;
                    sm += a;
                    n += 1.0;
                }
            }
        }
        if n > 1.0 {
            let var = (s2 / n - (s / n) * (s / n)).max(0.0) / 2.0;
            *o = if var > 0.0 { (sm / n) / var.sqrt() } else { f64::INFINITY };
        }
    }
    out
}

/// Jeffries–Matusita distance between two Gaussian classes (0 … 2).
pub fn jeffries_matusita(m1: &[f64], s1: &Sym, m2: &[f64], s2: &Sym) -> f64 {
    let n = s1.n;
    let mut s = Sym::zeros(n);
    for i in 0..n * n {
        s.a[i] = 0.5 * (s1.a[i] + s2.a[i]);
    }
    let (Some((inv, ld)), Some((_, l1)), Some((_, l2))) = (inverse_logdet(&s, 1e-9), inverse_logdet(s1, 1e-9), inverse_logdet(s2, 1e-9)) else {
        return f64::NAN;
    };
    let d: Vec<f64> = m1.iter().zip(m2).map(|(a, b)| a - b).collect();
    let bh = quad(&inv, &d) / 8.0 + 0.5 * (ld - 0.5 * (l1 + l2));
    2.0 * (1.0 - (-bh).exp())
}
