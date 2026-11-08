//! Automatic endmembers (REQ-GAP-82): Vertex Component Analysis (Nascimento and Bioucas-Dias,
//! IEEE TGRS 43(4), 2005) on the MNF-reduced cube, with the Pixel Purity Index (Boardman et al.,
//! 1995) as a purity image. S-62 chose VCA over N-FINDR: the same accuracy on synthetic mixtures,
//! faster and smaller (validation/2.7/I0-baseline-spikes.md).
//!
//! Both run on the cube projected onto its leading MNF components (`transform::mnf`, `project`),
//! which orders components by signal-to-noise ratio. Random directions come from a seeded
//! generator, so a seed gives the same result on every machine.

use crate::stats::Cube;
use crate::transform::{mnf, project};

/// xorshift64* with Box-Muller normals: small, portable and deterministic for a seed.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }
    fn next_u64(&mut self) -> u64 {
        let mut s = self.0;
        s ^= s >> 12;
        s ^= s << 25;
        s ^= s >> 27;
        self.0 = s;
        s.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    }
    fn normal(&mut self) -> f64 {
        let (u, v) = (self.unit(), self.unit());
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f64::consts::PI * v).cos()
    }
}

fn valid(x: &[f32], k: usize, p: usize) -> bool {
    x[p * k..(p + 1) * k].iter().all(|v| v.is_finite())
}

/// Pixel Purity Index on a reduced cube `x` (BIP, `k` bands, `n` pixels): each of `skewers`
/// random unit directions counts the pixels with the lowest and highest projection.
pub fn ppi(x: &[f32], n: usize, k: usize, skewers: usize, seed: u64) -> Vec<u32> {
    // Eight skewers per pass over the pixels.
    const SB: usize = 8;
    let mut rng = Rng::new(seed);
    let mut counts = vec![0u32; n];
    let ok: Vec<bool> = (0..n).map(|p| valid(x, k, p)).collect();
    let mut done = 0;
    let mut sk = vec![0f32; SB * k];
    while done < skewers {
        let b = SB.min(skewers - done);
        for s in 0..b {
            let v: Vec<f64> = (0..k).map(|_| rng.normal()).collect();
            let nr = v.iter().map(|a| a * a).sum::<f64>().sqrt().max(1e-30);
            for d in 0..k {
                sk[s * k + d] = (v[d] / nr) as f32;
            }
        }
        let mut lo = [(f32::INFINITY, usize::MAX); SB];
        let mut hi = [(f32::NEG_INFINITY, usize::MAX); SB];
        for p in (0..n).filter(|&p| ok[p]) {
            let px = &x[p * k..(p + 1) * k];
            for s in 0..b {
                let d: f32 = px.iter().zip(&sk[s * k..(s + 1) * k]).map(|(a, w)| a * w).sum();
                if d < lo[s].0 {
                    lo[s] = (d, p);
                }
                if d > hi[s].0 {
                    hi[s] = (d, p);
                }
            }
        }
        for s in 0..b {
            for p in [lo[s].1, hi[s].1] {
                if p != usize::MAX {
                    counts[p] += 1;
                }
            }
        }
        done += b;
    }
    counts
}

/// VCA on a reduced, mean-removed cube `x` (BIP, `k` ≥ m − 1 bands, `n` pixels): `m` endmember
/// pixel indices. The low-SNR form of the paper: the first m − 1 components plus a constant
/// coordinate equal to the largest pixel norm, then m projections, each on a random direction
/// orthogonal to the endmembers found so far; the pixel with the largest |projection| is the next.
/// None when there are fewer valid pixels than endmembers.
pub fn vca(x: &[f32], n: usize, k: usize, m: usize, seed: u64) -> Option<Vec<usize>> {
    if m < 2 || m - 1 > k {
        return None;
    }
    let d = m - 1;
    let ok: Vec<bool> = (0..n).map(|p| valid(x, k, p)).collect();
    if ok.iter().filter(|&&v| v).count() < m {
        return None;
    }
    let mut rng = Rng::new(seed);
    let norm2 = |p: usize| (0..d).map(|i| (x[p * k + i] as f64).powi(2)).sum::<f64>();
    let c = (0..n).filter(|&p| ok[p]).map(norm2).fold(0.0f64, f64::max).sqrt().max(1e-12);
    let point = |p: usize, out: &mut [f64]| {
        for r in 0..d {
            out[r] = x[p * k + r] as f64;
        }
        out[d] = c;
    };
    // Orthonormal basis of the span of the endmembers found so far. Before the first, the
    // constant axis stands in for it (the paper's auxiliary e_u), so the first direction lies in
    // the reduced components.
    let mut basis: Vec<Vec<f64>> = vec![{
        let mut e = vec![0.0; m];
        e[d] = 1.0;
        e
    }];
    let mut idx = Vec::with_capacity(m);
    let mut y = vec![0.0; m];
    for i in 0..m {
        let mut f: Vec<f64> = (0..m).map(|_| rng.normal()).collect();
        for b in &basis {
            let dp: f64 = b.iter().zip(&f).map(|(a, c)| a * c).sum();
            f.iter_mut().zip(b).for_each(|(v, a)| *v -= dp * a);
        }
        let nf = f.iter().map(|a| a * a).sum::<f64>().sqrt().max(1e-30);
        f.iter_mut().for_each(|v| *v /= nf);
        let mut best = (usize::MAX, -1.0f64);
        for p in (0..n).filter(|&p| ok[p]) {
            point(p, &mut y);
            let v = y.iter().zip(&f).map(|(a, b)| a * b).sum::<f64>().abs();
            if v > best.1 {
                best = (p, v);
            }
        }
        idx.push(best.0);
        if i == 0 {
            basis.clear();
        }
        point(best.0, &mut y);
        for b in &basis {
            let dp: f64 = b.iter().zip(&y).map(|(a, c)| a * c).sum();
            y.iter_mut().zip(b).for_each(|(v, a)| *v -= dp * a);
        }
        let ny = y.iter().map(|a| a * a).sum::<f64>().sqrt();
        if ny > 1e-12 {
            basis.push(y.iter().map(|v| v / ny).collect());
        }
    }
    Some(idx)
}

/// Endmembers of a cube: their pixel indices (VCA) and, when `skewers` > 0, the PPI count of every
/// pixel, both on the cube projected onto its leading max(m − 1, 10) MNF components (all bands
/// when there are fewer). `step` thins the pixels used for the MNF statistics.
pub struct Endmembers {
    pub pixels: Vec<usize>,
    pub ppi: Vec<u32>,
    pub components: usize,
}

pub fn extract(c: &Cube, m: usize, skewers: usize, seed: u64, step: usize) -> Option<Endmembers> {
    let k = (m.saturating_sub(1)).max(10).min(c.nb);
    if m < 2 || m - 1 > k {
        return None;
    }
    let t = mnf(c, step.max(1));
    let x = project(c, &t, k);
    let n = c.n();
    let pixels = vca(&x, n, k, m, seed)?;
    let ppi = if skewers > 0 { ppi(&x, n, k, skewers, seed ^ 0x5DEE_CE66) } else { Vec::new() };
    Some(Endmembers { pixels, ppi, components: k })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn angle(a: &[f64], b: &[f32]) -> f64 {
        let (mut d, mut x, mut y) = (0.0, 0.0, 0.0);
        for (p, q) in a.iter().zip(b) {
            d += p * *q as f64;
            x += p * p;
            y += (*q as f64) * (*q as f64);
        }
        (d / (x * y).sqrt()).clamp(-1.0, 1.0).acos()
    }

    /// Four smooth, distinct reflectance-like spectra mixed with Dirichlet-like abundances and
    /// noise, a pure patch each: VCA finds each within 0.05 rad, and PPI ranks the patches purest.
    #[test]
    fn recovers_mixed_endmembers() {
        let (w, h, nb, m) = (60usize, 50usize, 40usize, 4usize);
        let ends: Vec<Vec<f64>> = (0..m)
            .map(|e| {
                (0..nb)
                    .map(|b| {
                        let t = b as f64 / nb as f64;
                        0.3 + 0.2 * ((e as f64 + 1.0) * 3.0 * t + e as f64).sin() + 0.1 * e as f64 * t
                    })
                    .collect()
            })
            .collect();
        let mut rng = Rng::new(42);
        let n = w * h;
        // Abundances vary smoothly across the scene, as land cover does (MNF estimates noise from
        // neighbouring pixels), with a pure 3 × 3 patch of each endmember.
        let pure = [(5usize, 5usize), (50, 8), (12, 40), (45, 42)];
        let patch = |p: usize| pure.iter().position(|&(x, y)| (p % w).abs_diff(x + 1) <= 1 && (p / w).abs_diff(y + 1) <= 1 && p % w >= x && p / w >= y);
        let mut v = vec![0f32; n * nb];
        for p in 0..n {
            let (x, y) = ((p % w) as f64 / w as f64, (p / w) as f64 / h as f64);
            let mut a: Vec<f64> = (0..m).map(|i| (1.5 * ((i as f64 + 1.0) * 2.1 * x + (i as f64) * 1.3).sin() * ((m - i) as f64 * 1.7 * y).cos()).exp()).collect();
            if let Some(e) = patch(p) {
                a = (0..m).map(|i| if i == e { 1.0 } else { 0.0 }).collect();
            }
            let s: f64 = a.iter().sum();
            for b in 0..nb {
                let val: f64 = (0..m).map(|i| a[i] / s * ends[i][b]).sum();
                v[p * nb + b] = (val + 0.002 * rng.normal()) as f32;
            }
        }
        let c = Cube { v: &v, nb, w, h };
        let r = extract(&c, m, 2000, 1, 1).expect("endmembers");
        assert_eq!(r.pixels.len(), m);
        for e in &ends {
            let best = r.pixels.iter().map(|&p| angle(e, c.px(p))).fold(f64::INFINITY, f64::min);
            assert!(best < 0.05, "endmember not found: best angle {best}");
        }
        // The purest pixels by PPI lie in the pure patches.
        let mut top: Vec<usize> = (0..n).collect();
        top.sort_by_key(|&p| std::cmp::Reverse(r.ppi[p]));
        let hit: std::collections::BTreeSet<usize> = top[..16].iter().filter_map(|&p| patch(p)).collect();
        assert!(hit.len() == m, "PPI's 16 purest pixels cover {} of the {m} pure patches", hit.len());
        // Deterministic for a seed.
        assert_eq!(extract(&c, m, 0, 1, 1).unwrap().pixels, r.pixels);
    }

    #[test]
    fn refuses_impossible_requests() {
        let v = vec![0.5f32; 4 * 3];
        let c = Cube { v: &v, nb: 3, w: 2, h: 2 };
        assert!(extract(&c, 1, 0, 1, 1).is_none());
        assert!(extract(&c, 5, 0, 1, 1).is_none());
        let v = vec![f32::NAN; 4 * 3];
        let c = Cube { v: &v, nb: 3, w: 2, h: 2 };
        assert!(extract(&c, 3, 0, 1, 1).is_none());
    }
}
