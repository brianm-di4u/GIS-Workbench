//! Descriptor matching for blocks with poor support data (REQ-SNS-21): ORB-style features —
//! Harris keypoints, orientation by the intensity centroid (Rosin 1999), and 256-bit rotated
//! BRIEF descriptors on a smoothed image (Rublee et al. 2011) — matched by Hamming distance with
//! a ratio test and a mutual check, then an affine between the images by RANSAC. The search does
//! not use the sensor models, so it finds pairs whose predictions are hundreds of pixels off or
//! rotated. Coordinates are corner-origin pixels, as everywhere in the crate.

use crate::{harris, Win};

/// Half size of the descriptor patch (the BRIEF pairs lie within ±13 px, rotated within 19).
const R: i64 = 15;

pub struct Feature {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
    pub desc: [u64; 4],
}

/// 256 point pairs in ±13 px, Gaussian-like (sum of three uniforms), from a fixed seed.
fn pattern() -> Vec<[f64; 4]> {
    let mut s = 0x9e37_79b9_7f4a_7c15u64;
    let mut u = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s >> 11) as f64 / (1u64 << 53) as f64
    };
    let mut g = || ((u() + u() + u()) / 3.0 - 0.5) * 2.0 * 13.0;
    (0..256).map(|_| [g(), g(), g(), g()]).collect()
}

/// 5 × 5 box blur (two passes of 3 × 3), edges clamped.
fn smooth(img: Win<'_>) -> Vec<f32> {
    let (w, h) = (img.w as i64, img.h as i64);
    let mut a: Vec<f32> = img.px.to_vec();
    for _ in 0..2 {
        let mut b = vec![0f32; a.len()];
        for y in 0..h {
            for x in 0..w {
                let mut s = 0f32;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        let (xx, yy) = ((x + dx).clamp(0, w - 1), (y + dy).clamp(0, h - 1));
                        s += a[(yy * w + xx) as usize];
                    }
                }
                b[(y * w + x) as usize] = s / 9.0;
            }
        }
        a = b;
    }
    a
}

/// Up to `n` features, strongest corners first.
pub fn orb_features(img: Win<'_>, n: usize) -> Vec<Feature> {
    let (w, h) = (img.w as i64, img.h as i64);
    let border = (R + 5) as usize;
    if img.w < 2 * border + 4 || img.h < 2 * border + 4 {
        return Vec::new();
    }
    let s = smooth(img);
    let at = |x: i64, y: i64| -> f32 { s[(y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize] };
    let min_dist = ((img.w * img.h) as f64 / n.max(1) as f64).sqrt() * 0.5;
    let pat = pattern();
    harris(img, n, border, min_dist.max(3.0))
        .into_iter()
        .map(|c| {
            let (cx, cy) = (c.x.floor() as i64, c.y.floor() as i64);
            let (mut m10, mut m01) = (0f64, 0f64);
            for dy in -R..=R {
                for dx in -R..=R {
                    if dx * dx + dy * dy <= R * R {
                        let v = f64::from(at(cx + dx, cy + dy));
                        m10 += dx as f64 * v;
                        m01 += dy as f64 * v;
                    }
                }
            }
            let angle = m01.atan2(m10);
            let (sn, cs) = angle.sin_cos();
            let rot = |px: f64, py: f64| -> f32 { at(cx + (cs * px - sn * py).round() as i64, cy + (sn * px + cs * py).round() as i64) };
            let mut desc = [0u64; 4];
            for (k, p) in pat.iter().enumerate() {
                if rot(p[0], p[1]) < rot(p[2], p[3]) {
                    desc[k / 64] |= 1 << (k % 64);
                }
            }
            Feature { x: c.x, y: c.y, angle, desc }
        })
        .collect()
}

#[inline]
fn hamming(a: &[u64; 4], b: &[u64; 4]) -> u32 {
    (0..4).map(|k| (a[k] ^ b[k]).count_ones()).sum()
}

/// Nearest neighbour of each `a` in `b` (index, distance, ratio of best to second best).
fn nearest(a: &[Feature], b: &[Feature]) -> Vec<(usize, u32, f64)> {
    a.iter()
        .map(|fa| {
            let (mut i1, mut d1, mut d2) = (usize::MAX, u32::MAX, u32::MAX);
            for (j, fb) in b.iter().enumerate() {
                let d = hamming(&fa.desc, &fb.desc);
                if d < d1 {
                    d2 = d1;
                    d1 = d;
                    i1 = j;
                } else if d < d2 {
                    d2 = d;
                }
            }
            (i1, d1, if d2 == 0 || d2 == u32::MAX { 1.0 } else { f64::from(d1) / f64::from(d2) })
        })
        .collect()
}

/// Mutual nearest neighbours that pass the ratio test and a distance limit: (ia, ib, distance).
pub fn match_features(a: &[Feature], b: &[Feature], ratio: f64, max_dist: u32) -> Vec<(usize, usize, u32)> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }
    let ab = nearest(a, b);
    let ba = nearest(b, a);
    ab.iter()
        .enumerate()
        .filter(|(i, (j, d, r))| *d <= max_dist && *r < ratio && ba[*j].0 == *i)
        .map(|(i, (j, d, _))| (i, *j, *d))
        .collect()
}

/// Least-squares affine b = A·(a, 1): [a0, a1, a2, a3, a4, a5] with bx = a0 + a1·ax + a2·ay.
pub fn fit_affine(p: &[([f64; 2], [f64; 2])]) -> Option<[f64; 6]> {
    if p.len() < 3 {
        return None;
    }
    let mut n = [[0f64; 3]; 3];
    let (mut bx, mut by) = ([0f64; 3], [0f64; 3]);
    for (a, b) in p {
        let r = [1.0, a[0], a[1]];
        for i in 0..3 {
            bx[i] += r[i] * b[0];
            by[i] += r[i] * b[1];
            for j in 0..3 {
                n[i][j] += r[i] * r[j];
            }
        }
    }
    let solve = |rhs: [f64; 3]| -> Option<[f64; 3]> {
        let mut m = [[0f64; 4]; 3];
        for i in 0..3 {
            m[i][..3].copy_from_slice(&n[i]);
            m[i][3] = rhs[i];
        }
        for c in 0..3 {
            let p = (c..3).max_by(|&a, &b| m[a][c].abs().total_cmp(&m[b][c].abs()))?;
            m.swap(c, p);
            if m[c][c].abs() < 1e-12 {
                return None;
            }
            for r in 0..3 {
                if r != c {
                    let k = m[r][c] / m[c][c];
                    for j in c..4 {
                        m[r][j] -= k * m[c][j];
                    }
                }
            }
        }
        Some([m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]])
    };
    let x = solve(bx)?;
    let y = solve(by)?;
    Some([x[0], x[1], x[2], y[0], y[1], y[2]])
}

#[inline]
fn apply(a: &[f64; 6], p: [f64; 2]) -> [f64; 2] {
    [a[0] + a[1] * p[0] + a[2] * p[1], a[3] + a[4] * p[0] + a[5] * p[1]]
}

/// RANSAC affine over point pairs (tolerance in `b` pixels): the refit on the largest consensus.
pub fn ransac_affine(p: &[([f64; 2], [f64; 2])], tol: f64, iters: usize, seed: u64) -> Option<([f64; 6], Vec<bool>)> {
    if p.len() < 3 {
        return None;
    }
    let mut s = seed | 1;
    let mut pick = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s % p.len() as u64) as usize
    };
    let inl = |a: &[f64; 6]| -> Vec<bool> {
        p.iter()
            .map(|(x, y)| {
                let q = apply(a, *x);
                (q[0] - y[0]).hypot(q[1] - y[1]) <= tol
            })
            .collect()
    };
    let mut best: Option<([f64; 6], Vec<bool>, usize)> = None;
    for _ in 0..iters {
        let (i, j, k) = (pick(), pick(), pick());
        if i == j || j == k || i == k {
            continue;
        }
        let Some(a) = fit_affine(&[p[i], p[j], p[k]]) else { continue };
        let m = inl(&a);
        let c = m.iter().filter(|&&v| v).count();
        if best.as_ref().map_or(true, |b| c > b.2) {
            best = Some((a, m, c));
        }
    }
    let (_, m, c) = best?;
    if c < 3 {
        return None;
    }
    // Two refinements: refit on the consensus, then re-select it.
    let mut m = m;
    let mut a = [0f64; 6];
    for _ in 0..2 {
        let sel: Vec<_> = p.iter().zip(&m).filter(|(_, &v)| v).map(|(q, _)| *q).collect();
        a = fit_affine(&sel)?;
        m = inl(&a);
    }
    Some((a, m))
}

pub struct OrbMatch {
    /// b = A·(a, 1).
    pub affine: [f64; 6],
    /// Inlier pairs (ax, ay, bx, by).
    pub pairs: Vec<[f64; 4]>,
    pub features: (usize, usize),
    pub candidates: usize,
}

/// Features in both windows, matched, with the RANSAC affine and its inliers.
pub fn orb_match(a: Win<'_>, b: Win<'_>, n: usize, ratio: f64, tol: f64) -> Option<OrbMatch> {
    let fa = orb_features(a, n);
    let fb = orb_features(b, n);
    let m = match_features(&fa, &fb, ratio, 80);
    let pairs: Vec<([f64; 2], [f64; 2])> = m.iter().map(|&(i, j, _)| ([fa[i].x, fa[i].y], [fb[j].x, fb[j].y])).collect();
    let (affine, inl) = ransac_affine(&pairs, tol, 4000, 0x5eed_0f0b)?;
    let pairs: Vec<[f64; 4]> = pairs.iter().zip(&inl).filter(|(_, &v)| v).map(|(p, _)| [p.0[0], p.0[1], p.1[0], p.1[1]]).collect();
    if pairs.len() < 6 {
        return None;
    }
    Some(OrbMatch { affine, pairs, features: (fa.len(), fb.len()), candidates: m.len() })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured scene and a rotated (20°), scaled (0.9) and shifted copy: the affine comes back.
    #[test]
    fn recovers_a_rotation_and_scale() {
        let (w, h) = (320usize, 320usize);
        let mut s = 12345u64;
        let mut r = || {
            s ^= s << 13;
            s ^= s >> 7;
            s ^= s << 17;
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        let blobs: Vec<[f64; 4]> = (0..400).map(|_| [r() * 400.0 - 40.0, r() * 400.0 - 40.0, 2.0 + r() * 6.0, r() * 200.0 - 100.0]).collect();
        let scene = |x: f64, y: f64| -> f32 { blobs.iter().map(|b| b[3] * (-((x - b[0]).powi(2) + (y - b[1]).powi(2)) / (2.0 * b[2] * b[2])).exp()).sum::<f64>() as f32 };
        let a: Vec<f32> = (0..w * h).map(|k| scene((k % w) as f64 + 0.5, (k / w) as f64 + 0.5)).collect();
        // b(x) = scene(T⁻¹ x): T = shift ∘ scale ∘ rotation about the centre.
        let (th, sc, tx, ty) = (20f64.to_radians(), 0.9, 17.0, -11.0);
        let (sn, cs) = th.sin_cos();
        let c = 160.0;
        let inv = |x: f64, y: f64| {
            let (u, v) = ((x - c - tx) / sc, (y - c - ty) / sc);
            (c + cs * u + sn * v, c - sn * u + cs * v)
        };
        let b: Vec<f32> = (0..w * h)
            .map(|k| {
                let (x, y) = inv((k % w) as f64 + 0.5, (k / w) as f64 + 0.5);
                scene(x, y)
            })
            .collect();
        let m = orb_match(Win { w, h, px: &a }, Win { w, h, px: &b }, 400, 0.85, 1.5).expect("a match");
        // Expected: b = c + t + sc·R·(a − c).
        let e = [c + tx - sc * (cs * c - sn * c), sc * cs, -sc * sn, c + ty - sc * (sn * c + cs * c), sc * sn, sc * cs];
        for (got, want) in m.affine.iter().zip(e) {
            assert!((got - want).abs() < if want.abs() > 2.0 { 1.0 } else { 0.01 }, "{:?} vs {:?}", m.affine, e);
        }
        assert!(m.pairs.len() >= 20, "{} inliers", m.pairs.len());
    }
}
