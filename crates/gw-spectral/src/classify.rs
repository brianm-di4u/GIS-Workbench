//! Supervised and unsupervised classification and post-classification clean-up (REQ-MSI-08/09,
//! `Research/10` §7). Labels: 0 = unclassified, k + 1 = class k. Scores: the classifier's
//! distance or angle for the chosen class (lower is better), so a threshold can be applied live.

use crate::linalg::{inverse_logdet, quad, Sym};
use crate::stats::{mean_cov, Cube};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Method {
    MinDistance,
    MaxLikelihood,
    Mahalanobis,
    Sam,
    Sid,
}

impl Method {
    pub fn from_code(c: i32) -> Option<Method> {
        Some(match c {
            0 => Method::MinDistance,
            1 => Method::MaxLikelihood,
            2 => Method::Mahalanobis,
            3 => Method::Sam,
            4 => Method::Sid,
            _ => return None,
        })
    }
}

pub struct Class {
    pub mean: Vec<f64>,
    pub cov: Sym,
    pub inv: Sym,
    pub logdet: f64,
    pub n: usize,
}

/// Class statistics from training pixel index lists.
pub fn train(c: &Cube, sets: &[Vec<usize>]) -> Vec<Class> {
    sets.iter()
        .map(|ix| {
            let (m, s, n) = mean_cov(c, Some(ix), 1);
            let (inv, ld) = inverse_logdet(&s, 1e-6).unwrap_or_else(|| (Sym::zeros(c.nb), 0.0));
            Class { mean: m, cov: s, inv, logdet: ld, n }
        })
        .collect()
}

fn sam(x: &[f32], r: &[f64]) -> f64 {
    let (mut d, mut a, mut b) = (0.0, 0.0, 0.0);
    for (i, &v) in x.iter().enumerate() {
        let v = v as f64;
        d += v * r[i];
        a += v * v;
        b += r[i] * r[i];
    }
    if a <= 0.0 || b <= 0.0 {
        return std::f64::consts::FRAC_PI_2;
    }
    (d / (a.sqrt() * b.sqrt())).clamp(-1.0, 1.0).acos()
}

fn sid(x: &[f32], r: &[f64]) -> f64 {
    let sx: f64 = x.iter().map(|&v| (v as f64).max(1e-12)).sum();
    let sr: f64 = r.iter().map(|&v| v.max(1e-12)).sum();
    let mut d = 0.0;
    for (i, &v) in x.iter().enumerate() {
        let p = (v as f64).max(1e-12) / sx;
        let q = r[i].max(1e-12) / sr;
        d += p * (p / q).ln() + q * (q / p).ln();
    }
    d
}

/// Classify every pixel. `threshold` (NaN = none) rejects pixels whose score exceeds it
/// (SAM in radians, SID, distances in data units, ML as a χ² quadratic form).
pub fn classify(c: &Cube, classes: &[Class], m: Method, threshold: f64) -> (Vec<u8>, Vec<f32>) {
    let n = c.n();
    let nb = c.nb;
    let mut labels = vec![0u8; n];
    let mut scores = vec![f32::NAN; n];
    // Pooled covariance for Mahalanobis.
    let pooled = if m == Method::Mahalanobis {
        let mut s = Sym::zeros(nb);
        let tot: usize = classes.iter().map(|k| k.n).sum();
        for k in classes {
            for i in 0..nb * nb {
                s.a[i] += k.cov.a[i] * k.n as f64 / tot.max(1) as f64;
            }
        }
        inverse_logdet(&s, 1e-6).map(|x| x.0)
    } else {
        None
    };
    let mut d = vec![0.0; nb];
    for p in 0..n {
        if !c.valid(p) {
            continue;
        }
        let x = c.px(p);
        let (mut best, mut bk, mut bscore) = (f64::INFINITY, usize::MAX, f64::NAN);
        for (k, cl) in classes.iter().enumerate() {
            for b in 0..nb {
                d[b] = x[b] as f64 - cl.mean[b];
            }
            let (cost, score) = match m {
                Method::MinDistance => {
                    let e = d.iter().map(|v| v * v).sum::<f64>().sqrt();
                    (e, e)
                }
                Method::MaxLikelihood => {
                    let q = quad(&cl.inv, &d);
                    // −2 ln p up to a constant (equal priors): ln|Σ| + q; the score is q (χ²).
                    (cl.logdet + q, q)
                }
                Method::Mahalanobis => {
                    let q = pooled.as_ref().map_or(f64::INFINITY, |inv| quad(inv, &d));
                    (q, q.sqrt())
                }
                Method::Sam => {
                    let a = sam(x, &cl.mean);
                    (a, a)
                }
                Method::Sid => {
                    let s = sid(x, &cl.mean);
                    (s, s)
                }
            };
            if cost < best {
                best = cost;
                bk = k;
                bscore = score;
            }
        }
        if bk != usize::MAX && (!threshold.is_finite() || bscore <= threshold) {
            labels[p] = (bk + 1).min(255) as u8;
        }
        scores[p] = bscore as f32;
    }
    (labels, scores)
}

/// K-means (k-means++ seeding with a fixed seed; trained on every `step`-th pixel, then the whole
/// image classified once). Returns labels 1…k and the centres.
pub fn kmeans(c: &Cube, k: usize, iters: usize, step: usize, change: f64) -> (Vec<u8>, Vec<Vec<f64>>) {
    let nb = c.nb;
    let train: Vec<usize> = (0..c.n()).step_by(step.max(1)).filter(|&p| c.valid(p)).collect();
    if train.is_empty() || k == 0 {
        return (vec![0; c.n()], Vec::new());
    }
    let mut seed = 0x9E3779B97F4A7C15u64;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 11) as f64 / (1u64 << 53) as f64
    };
    let dist = |x: &[f32], m: &[f64]| x.iter().zip(m).map(|(&a, b)| (a as f64 - b).powi(2)).sum::<f64>();
    let mut centres: Vec<Vec<f64>> = vec![c.px(train[(rnd() * train.len() as f64) as usize % train.len()]).iter().map(|&v| v as f64).collect()];
    while centres.len() < k {
        let d2: Vec<f64> = train.iter().map(|&p| centres.iter().map(|m| dist(c.px(p), m)).fold(f64::INFINITY, f64::min)).collect();
        let tot: f64 = d2.iter().sum();
        let mut t = rnd() * tot;
        let mut pick = train[0];
        for (i, &p) in train.iter().enumerate() {
            t -= d2[i];
            if t <= 0.0 {
                pick = p;
                break;
            }
        }
        centres.push(c.px(pick).iter().map(|&v| v as f64).collect());
    }
    let mut assign = vec![usize::MAX; train.len()];
    for _ in 0..iters.max(1) {
        let mut moved = 0usize;
        let mut sum = vec![vec![0.0; nb]; k];
        let mut cnt = vec![0usize; k];
        for (i, &p) in train.iter().enumerate() {
            let x = c.px(p);
            let (mut b, mut bd) = (0, f64::INFINITY);
            for (j, m) in centres.iter().enumerate() {
                let d = dist(x, m);
                if d < bd {
                    bd = d;
                    b = j;
                }
            }
            if assign[i] != b {
                moved += 1;
                assign[i] = b;
            }
            cnt[b] += 1;
            for q in 0..nb {
                sum[b][q] += x[q] as f64;
            }
        }
        for j in 0..k {
            if cnt[j] > 0 {
                centres[j] = sum[j].iter().map(|s| s / cnt[j] as f64).collect();
            }
        }
        if (moved as f64) < change * train.len() as f64 {
            break;
        }
    }
    let labels = (0..c.n())
        .map(|p| {
            if !c.valid(p) {
                return 0;
            }
            let x = c.px(p);
            let mut b = 0;
            let mut bd = f64::INFINITY;
            for (j, m) in centres.iter().enumerate() {
                let d = dist(x, m);
                if d < bd {
                    bd = d;
                    b = j;
                }
            }
            (b + 1) as u8
        })
        .collect();
    (labels, centres)
}

/// ISODATA parameters (Ball and Hall 1965, the usual set).
#[derive(Clone, Copy, Debug)]
pub struct Isodata {
    pub k_min: usize,
    pub k_max: usize,
    pub iters: usize,
    pub change: f64,
    pub min_pixels: usize,
    pub max_std: f64,
    pub min_dist: f64,
    pub max_merge: usize,
    pub step: usize,
}

/// ISODATA: K-means passes with splitting of clusters whose largest band σ exceeds `max_std`,
/// merging of centres closer than `min_dist`, and deletion of clusters under `min_pixels`.
pub fn isodata(c: &Cube, p: Isodata) -> (Vec<u8>, Vec<Vec<f64>>) {
    let nb = c.nb;
    let train: Vec<usize> = (0..c.n()).step_by(p.step.max(1)).filter(|&q| c.valid(q)).collect();
    let (_, mut centres) = kmeans(c, p.k_min.max(1), 3, p.step, p.change);
    let dist = |x: &[f32], m: &[f64]| x.iter().zip(m).map(|(&a, b)| (a as f64 - b).powi(2)).sum::<f64>();
    for it in 0..p.iters.max(1) {
        // Assign.
        let k = centres.len();
        let mut members: Vec<Vec<usize>> = vec![Vec::new(); k];
        for &q in &train {
            let x = c.px(q);
            let b = (0..k).min_by(|&i, &j| dist(x, &centres[i]).partial_cmp(&dist(x, &centres[j])).unwrap()).unwrap();
            members[b].push(q);
        }
        // Delete small clusters, recompute centres and σ.
        let mut next: Vec<(Vec<f64>, Vec<f64>, usize)> = Vec::new();
        for m in members.iter().filter(|m| m.len() >= p.min_pixels.min(train.len() / k.max(1)).max(1)) {
            let mut mu = vec![0.0; nb];
            for &q in m {
                for b in 0..nb {
                    mu[b] += c.px(q)[b] as f64;
                }
            }
            mu.iter_mut().for_each(|v| *v /= m.len() as f64);
            let mut sd = vec![0.0; nb];
            for &q in m {
                for b in 0..nb {
                    sd[b] += (c.px(q)[b] as f64 - mu[b]).powi(2);
                }
            }
            sd.iter_mut().for_each(|v| *v = (*v / m.len() as f64).sqrt());
            next.push((mu, sd, m.len()));
        }
        // Split (on odd iterations or when too few clusters), else merge.
        let mut out: Vec<Vec<f64>> = Vec::new();
        if (it % 2 == 0 || next.len() < p.k_min) && next.len() < p.k_max {
            for (mu, sd, _) in &next {
                let (bi, bs) = sd.iter().enumerate().fold((0, 0.0), |a, (i, &v)| if v > a.1 { (i, v) } else { a });
                if bs > p.max_std && out.len() + 2 <= p.k_max {
                    let mut a = mu.clone();
                    let mut b = mu.clone();
                    a[bi] += bs;
                    b[bi] -= bs;
                    out.push(a);
                    out.push(b);
                } else {
                    out.push(mu.clone());
                }
            }
        } else {
            let mut used = vec![false; next.len()];
            let mut merges = 0;
            let mut pairs: Vec<(f64, usize, usize)> = Vec::new();
            for i in 0..next.len() {
                for j in i + 1..next.len() {
                    let d = next[i].0.iter().zip(&next[j].0).map(|(a, b)| (a - b).powi(2)).sum::<f64>().sqrt();
                    if d < p.min_dist {
                        pairs.push((d, i, j));
                    }
                }
            }
            pairs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            for (_, i, j) in pairs {
                if used[i] || used[j] || merges >= p.max_merge || next.len() - merges <= p.k_min {
                    continue;
                }
                let (ni, nj) = (next[i].2 as f64, next[j].2 as f64);
                out.push(next[i].0.iter().zip(&next[j].0).map(|(a, b)| (a * ni + b * nj) / (ni + nj)).collect());
                used[i] = true;
                used[j] = true;
                merges += 1;
            }
            for (i, n) in next.iter().enumerate() {
                if !used[i] {
                    out.push(n.0.clone());
                }
            }
        }
        if out.is_empty() {
            break;
        }
        centres = out;
    }
    let labels = (0..c.n())
        .map(|q| {
            if !c.valid(q) {
                return 0;
            }
            let x = c.px(q);
            let b = (0..centres.len()).min_by(|&i, &j| dist(x, &centres[i]).partial_cmp(&dist(x, &centres[j])).unwrap()).unwrap_or(0);
            (b + 1).min(255) as u8
        })
        .collect();
    (labels, centres)
}

/// Majority filter (window 3 or 5): each pixel takes the most frequent label around it.
pub fn majority(l: &[u8], w: usize, h: usize, win: usize) -> Vec<u8> {
    let r = (win.max(3) / 2) as isize;
    let mut out = l.to_vec();
    let mut cnt = [0u16; 256];
    for y in 0..h as isize {
        for x in 0..w as isize {
            cnt.iter_mut().for_each(|c| *c = 0);
            for dy in -r..=r {
                for dx in -r..=r {
                    let (xx, yy) = (x + dx, y + dy);
                    if xx >= 0 && yy >= 0 && xx < w as isize && yy < h as isize {
                        cnt[l[yy as usize * w + xx as usize] as usize] += 1;
                    }
                }
            }
            let (b, _) = cnt.iter().enumerate().skip(1).fold((l[(y as usize) * w + x as usize] as usize, 0u16), |a, (i, &c)| if c > a.1 { (i, c) } else { a });
            out[y as usize * w + x as usize] = b as u8;
        }
    }
    out
}

/// Connected components (4-connected) of equal labels: (component id per pixel, sizes).
fn components(l: &[u8], w: usize, h: usize) -> (Vec<u32>, Vec<usize>) {
    let mut id = vec![u32::MAX; w * h];
    let mut sizes = Vec::new();
    let mut stack = Vec::new();
    for s in 0..w * h {
        if id[s] != u32::MAX {
            continue;
        }
        let c = sizes.len() as u32;
        let lab = l[s];
        let mut n = 0;
        stack.push(s);
        id[s] = c;
        while let Some(p) = stack.pop() {
            n += 1;
            let (x, y) = (p % w, p / w);
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx < w && ny < h {
                    let q = ny * w + nx;
                    if id[q] == u32::MAX && l[q] == lab {
                        id[q] = c;
                        stack.push(q);
                    }
                }
            }
        }
        sizes.push(n);
    }
    (id, sizes)
}

/// Sieve: clumps smaller than `min` pixels take the most common neighbouring label.
pub fn sieve(l: &[u8], w: usize, h: usize, min: usize) -> Vec<u8> {
    let (id, sizes) = components(l, w, h);
    let mut out = l.to_vec();
    for p in 0..w * h {
        if sizes[id[p] as usize] >= min {
            continue;
        }
        let mut cnt = [0u32; 256];
        let (x, y) = (p % w, p / w);
        for dy in -2isize..=2 {
            for dx in -2isize..=2 {
                let (xx, yy) = (x as isize + dx, y as isize + dy);
                if xx >= 0 && yy >= 0 && (xx as usize) < w && (yy as usize) < h {
                    let q = yy as usize * w + xx as usize;
                    if sizes[id[q] as usize] >= min {
                        cnt[l[q] as usize] += 1;
                    }
                }
            }
        }
        if let Some((b, _)) = cnt.iter().enumerate().max_by_key(|(_, &c)| c).filter(|(_, &c)| c > 0) {
            out[p] = b as u8;
        }
    }
    out
}

/// Fill unclassified pixels (0) from the most common classified neighbour, repeatedly.
pub fn fill(l: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut out = l.to_vec();
    for _ in 0..64 {
        let mut changed = false;
        let prev = out.clone();
        for p in 0..w * h {
            if prev[p] != 0 {
                continue;
            }
            let mut cnt = [0u16; 256];
            let (x, y) = (p % w, p / w);
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx < w && ny < h {
                    cnt[prev[ny * w + nx] as usize] += 1;
                }
            }
            if let Some((b, _)) = cnt.iter().enumerate().skip(1).max_by_key(|(_, &c)| c).filter(|(_, &c)| c > 0) {
                out[p] = b as u8;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_on_noisy_labels_is_fast() {
        let (w, h) = (512usize, 512usize);
        let mut s = 3u64;
        let l: Vec<u8> = (0..w * h)
            .map(|i| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                if s % 10 == 0 { (s % 7 + 1) as u8 } else { ((i % w) / 128 + 1) as u8 }
            })
            .collect();
        let t = std::time::Instant::now();
        let m = majority(&l, w, h, 3);
        let sv = sieve(&m, w, h, 8);
        let f = fill(&sv, w, h);
        assert!(t.elapsed().as_secs_f64() < 5.0, "{:?}", t.elapsed());
        assert_eq!(f.len(), w * h);
    }
}
