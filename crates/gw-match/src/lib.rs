//! GIS Workbench image matching (Appendix D `gw-match`): Harris corners for tie-point
//! candidates, normalised cross-correlation search with a sub-pixel peak and a second-peak
//! ratio, and affine least-squares matching with a radiometric gain and offset (Gruen 1985),
//! used by automatic tie points (REQ-SNS-13) and snap to ground (REQ-STR-09).
//!
//! Images are row-major f32 windows; coordinates are corner-origin pixels (the first pixel's
//! centre is (0.5, 0.5)), the crate-wide convention.

pub mod dsm;
pub mod ncc;
pub mod orb;
pub mod sgm;

/// Row-major single-band window.
#[derive(Clone, Copy)]
pub struct Win<'a> {
    pub w: usize,
    pub h: usize,
    pub px: &'a [f32],
}

impl Win<'_> {
    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.px[y * self.w + x]
    }
    /// Bilinear sample at continuous corner-origin (x, y); None outside.
    pub fn sample(&self, x: f64, y: f64) -> Option<f64> {
        let fx = x - 0.5;
        let fy = y - 0.5;
        if fx < 0.0 || fy < 0.0 || fx > (self.w - 1) as f64 || fy > (self.h - 1) as f64 {
            return None;
        }
        let i = (fx.floor() as usize).min(self.w.saturating_sub(2));
        let j = (fy.floor() as usize).min(self.h.saturating_sub(2));
        let (ax, ay) = (fx - i as f64, fy - j as f64);
        let v = |a: usize, b: usize| f64::from(self.at(a, b));
        Some(v(i, j) * (1.0 - ax) * (1.0 - ay) + v(i + 1, j) * ax * (1.0 - ay) + v(i, j + 1) * (1.0 - ax) * ay + v(i + 1, j + 1) * ax * ay)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Corner {
    pub x: f64,
    pub y: f64,
    pub score: f64,
}

/// Harris corners (k = 0.04, 5 × 5 Gaussian-weighted structure tensor), strongest first,
/// at least `min_dist` pixels apart and `border` pixels from the edge.
pub fn harris(img: Win<'_>, n: usize, border: usize, min_dist: f64) -> Vec<Corner> {
    let (w, h) = (img.w, img.h);
    if w < 7 || h < 7 {
        return Vec::new();
    }
    let mut ix = vec![0f32; w * h];
    let mut iy = vec![0f32; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            ix[y * w + x] = 0.5 * (img.at(x + 1, y) - img.at(x - 1, y));
            iy[y * w + x] = 0.5 * (img.at(x, y + 1) - img.at(x, y - 1));
        }
    }
    const G: [f32; 5] = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545];
    let mut resp = vec![0f32; w * h];
    let b = border.max(3);
    for y in b..h.saturating_sub(b) {
        for x in b..w.saturating_sub(b) {
            let (mut sxx, mut syy, mut sxy) = (0f32, 0f32, 0f32);
            for (dj, gy) in G.iter().enumerate() {
                for (di, gx) in G.iter().enumerate() {
                    let k = (y + dj - 2) * w + (x + di - 2);
                    let g = gx * gy;
                    sxx += g * ix[k] * ix[k];
                    syy += g * iy[k] * iy[k];
                    sxy += g * ix[k] * iy[k];
                }
            }
            resp[y * w + x] = sxx * syy - sxy * sxy - 0.04 * (sxx + syy) * (sxx + syy);
        }
    }
    let mut cand: Vec<(usize, usize, f32)> = Vec::new();
    for y in b..h.saturating_sub(b) {
        for x in b..w.saturating_sub(b) {
            let r = resp[y * w + x];
            if r <= 0.0 {
                continue;
            }
            let mut peak = true;
            'n: for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    if (dx, dy) != (0, 0) && resp[((y as i64 + dy) as usize) * w + (x as i64 + dx) as usize] > r {
                        peak = false;
                        break 'n;
                    }
                }
            }
            if peak {
                cand.push((x, y, r));
            }
        }
    }
    cand.sort_by(|a, b| b.2.total_cmp(&a.2));
    let mut out: Vec<Corner> = Vec::with_capacity(n);
    for (x, y, r) in cand {
        let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
        if out.iter().all(|c| (c.x - cx).hypot(c.y - cy) >= min_dist) {
            out.push(Corner { x: cx, y: cy, score: f64::from(r) });
            if out.len() >= n {
                break;
            }
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NccMatch {
    /// Position in the search window of the template's centre (corner-origin).
    pub x: f64,
    pub y: f64,
    pub score: f64,
    /// Best score over the best score outside a 3-pixel neighbourhood (≥ 1; higher is less ambiguous).
    pub ratio: f64,
}

/// Exhaustive NCC of the template over the search window, with a parabolic sub-pixel peak.
pub fn ncc_search(tpl: Win<'_>, srch: Win<'_>) -> Option<NccMatch> {
    if tpl.w > srch.w || tpl.h > srch.h || tpl.w < 3 || tpl.h < 3 {
        return None;
    }
    let n = (tpl.w * tpl.h) as f64;
    let tm = tpl.px.iter().map(|v| f64::from(*v)).sum::<f64>() / n;
    let tv: Vec<f64> = tpl.px.iter().map(|v| f64::from(*v) - tm).collect();
    let tn = tv.iter().map(|v| v * v).sum::<f64>().sqrt();
    if tn < 1e-9 {
        return None;
    }
    let (ow, oh) = (srch.w - tpl.w + 1, srch.h - tpl.h + 1);
    // Running sums for the search window's mean and energy (summed-area tables).
    let (sw, sh) = (srch.w + 1, srch.h + 1);
    let mut s1 = vec![0f64; sw * sh];
    let mut s2 = vec![0f64; sw * sh];
    for y in 0..srch.h {
        for x in 0..srch.w {
            let v = f64::from(srch.at(x, y));
            s1[(y + 1) * sw + x + 1] = v + s1[y * sw + x + 1] + s1[(y + 1) * sw + x] - s1[y * sw + x];
            s2[(y + 1) * sw + x + 1] = v * v + s2[y * sw + x + 1] + s2[(y + 1) * sw + x] - s2[y * sw + x];
        }
    }
    let rect = |s: &[f64], x: usize, y: usize| s[(y + tpl.h) * sw + x + tpl.w] - s[y * sw + x + tpl.w] - s[(y + tpl.h) * sw + x] + s[y * sw + x];
    let mut score = vec![-1f64; ow * oh];
    for oy in 0..oh {
        for ox in 0..ow {
            let sum = rect(&s1, ox, oy);
            let var = rect(&s2, ox, oy) - sum * sum / n;
            if var <= 1e-9 {
                continue;
            }
            let mut c = 0.0;
            for ty in 0..tpl.h {
                let row = &srch.px[(oy + ty) * srch.w + ox..(oy + ty) * srch.w + ox + tpl.w];
                let trow = &tv[ty * tpl.w..(ty + 1) * tpl.w];
                for (a, b) in row.iter().zip(trow) {
                    c += f64::from(*a) * b;
                }
            }
            score[oy * ow + ox] = c / (tn * var.sqrt());
        }
    }
    let (bi, &best) = score.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1))?;
    let (bx, by) = (bi % ow, bi / ow);
    let mut second = -1f64;
    for oy in 0..oh {
        for ox in 0..ow {
            if (ox as i64 - bx as i64).abs() > 3 || (oy as i64 - by as i64).abs() > 3 {
                second = second.max(score[oy * ow + ox]);
            }
        }
    }
    let sub = |m: f64, c: f64, p: f64| {
        let d = m - 2.0 * c + p;
        if d.abs() < 1e-12 {
            0.0
        } else {
            (0.5 * (m - p) / d).clamp(-0.5, 0.5)
        }
    };
    let dx = if bx > 0 && bx + 1 < ow { sub(score[by * ow + bx - 1], best, score[by * ow + bx + 1]) } else { 0.0 };
    let dy = if by > 0 && by + 1 < oh { sub(score[(by - 1) * ow + bx], best, score[(by + 1) * ow + bx]) } else { 0.0 };
    Some(NccMatch {
        x: bx as f64 + dx + tpl.w as f64 / 2.0,
        y: by as f64 + dy + tpl.h as f64 / 2.0,
        score: best,
        ratio: if second > 0.0 { best / second } else { f64::INFINITY },
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LsmResult {
    pub x: f64,
    pub y: f64,
    /// A posteriori σ of the shift (pixels, per axis, mean of the two).
    pub sigma: f64,
    pub iterations: usize,
    pub converged: bool,
    /// NCC of the template with the resampled patch at the solution.
    pub score: f64,
}

/// Affine least-squares matching of the template (centred at its middle) into the search
/// window, starting at (x0, y0): 6 geometric + 2 radiometric parameters, Gauss–Newton.
pub fn lsm(tpl: Win<'_>, srch: Win<'_>, x0: f64, y0: f64) -> Option<LsmResult> {
    let (cx, cy) = (tpl.w as f64 / 2.0, tpl.h as f64 / 2.0);
    // Search position of template pixel (u, v) offsets: x = p0 + p1·u + p2·v, y = p3 + p4·u + p5·v.
    let mut p = [x0, 1.0, 0.0, y0, 0.0, 1.0, 1.0, 0.0];
    let gxy = |x: f64, y: f64| -> Option<(f64, f64, f64)> {
        let v = srch.sample(x, y)?;
        let gx = (srch.sample(x + 0.5, y)? - srch.sample(x - 0.5, y)?) / 1.0;
        let gy = (srch.sample(x, y + 0.5)? - srch.sample(x, y - 0.5)?) / 1.0;
        Some((v, gx, gy))
    };
    let mut sigma = f64::NAN;
    let mut converged = false;
    let mut iterations = 0;
    for it in 0..30 {
        iterations = it + 1;
        let mut n = [[0f64; 8]; 8];
        let mut b = [0f64; 8];
        let mut vpv = 0.0;
        let mut cnt = 0usize;
        for ty in 0..tpl.h {
            for tx in 0..tpl.w {
                let u = tx as f64 + 0.5 - cx;
                let v = ty as f64 + 0.5 - cy;
                let x = p[0] + p[1] * u + p[2] * v;
                let y = p[3] + p[4] * u + p[5] * v;
                let (g, gx, gy) = gxy(x, y)?;
                let t = f64::from(tpl.at(tx, ty));
                // Model: t = r0 · g(x, y) + r1.
                let r = t - (p[6] * g + p[7]);
                let a = [p[6] * gx, p[6] * gx * u, p[6] * gx * v, p[6] * gy, p[6] * gy * u, p[6] * gy * v, g, 1.0];
                for i in 0..8 {
                    b[i] += a[i] * r;
                    for j in 0..8 {
                        n[i][j] += a[i] * a[j];
                    }
                }
                vpv += r * r;
                cnt += 1;
            }
        }
        let d = solve8(n, b)?;
        for i in 0..8 {
            p[i] += d[i];
        }
        if (p[0] - x0).abs() > tpl.w as f64 || (p[3] - y0).abs() > tpl.h as f64 || !(0.5..2.0).contains(&p[1]) || !(0.5..2.0).contains(&p[5]) {
            return None;
        }
        let s0 = (vpv / (cnt as f64 - 8.0).max(1.0)).sqrt();
        if let Some(inv) = invert8(n) {
            sigma = s0 * (0.5 * (inv[0][0] + inv[3][3])).sqrt();
        }
        if d[0].abs() < 1e-3 && d[3].abs() < 1e-3 {
            converged = true;
            break;
        }
    }
    // Final NCC of the resampled patch.
    let mut a = Vec::with_capacity(tpl.w * tpl.h);
    let mut t = Vec::with_capacity(tpl.w * tpl.h);
    for ty in 0..tpl.h {
        for tx in 0..tpl.w {
            let u = tx as f64 + 0.5 - cx;
            let v = ty as f64 + 0.5 - cy;
            a.push(srch.sample(p[0] + p[1] * u + p[2] * v, p[3] + p[4] * u + p[5] * v)?);
            t.push(f64::from(tpl.at(tx, ty)));
        }
    }
    Some(LsmResult { x: p[0], y: p[3], sigma, iterations, converged, score: ncc(&a, &t) })
}

/// NCC of two equal-length vectors.
pub fn ncc(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let (mut c, mut va, mut vb) = (0.0, 0.0, 0.0);
    for (x, y) in a.iter().zip(b) {
        c += (x - ma) * (y - mb);
        va += (x - ma) * (x - ma);
        vb += (y - mb) * (y - mb);
    }
    if va <= 0.0 || vb <= 0.0 {
        0.0
    } else {
        c / (va * vb).sqrt()
    }
}

fn solve8(mut n: [[f64; 8]; 8], mut b: [f64; 8]) -> Option<[f64; 8]> {
    for c in 0..8 {
        let p = (c..8).max_by(|&i, &j| n[i][c].abs().total_cmp(&n[j][c].abs()))?;
        if n[p][c].abs() < 1e-12 {
            return None;
        }
        n.swap(p, c);
        b.swap(p, c);
        for r in 0..8 {
            if r != c {
                let f = n[r][c] / n[c][c];
                for k in c..8 {
                    n[r][k] -= f * n[c][k];
                }
                b[r] -= f * b[c];
            }
        }
    }
    let mut x = [0.0; 8];
    for i in 0..8 {
        x[i] = b[i] / n[i][i];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

fn invert8(n: [[f64; 8]; 8]) -> Option<[[f64; 8]; 8]> {
    let mut out = [[0.0; 8]; 8];
    for j in 0..8 {
        let mut e = [0.0; 8];
        e[j] = 1.0;
        let x = solve8(n, e)?;
        for i in 0..8 {
            out[i][j] = x[i];
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texture(w: usize, h: usize, ox: f64, oy: f64) -> Vec<f32> {
        let mut v = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (fx, fy) = (x as f64 + 0.5 + ox, y as f64 + 0.5 + oy);
                v[y * w + x] = (100.0 + 40.0 * (fx / 3.1).sin() * (fy / 4.3).cos() + 30.0 * ((fx * 0.37 + fy * 0.61).sin()) + 20.0 * (fx * fy / 97.0).sin()) as f32;
            }
        }
        v
    }

    #[test]
    fn ncc_and_lsm_recover_a_subpixel_shift() {
        // Search window sampled with an offset of (12.3, −7.6) relative to the template's frame.
        let tpl_px = texture(21, 21, 40.0, 40.0);
        let srch_px = texture(81, 81, 40.0 - 30.0 + 12.3, 40.0 - 30.0 - 7.6);
        let tpl = Win { w: 21, h: 21, px: &tpl_px };
        let srch = Win { w: 81, h: 81, px: &srch_px };
        let m = ncc_search(tpl, srch).unwrap();
        // The template centre (10.5, 10.5) in its own frame lies at 10.5 + 30 − 12.3 in the search.
        let (ex, ey) = (10.5 + 30.0 - 12.3, 10.5 + 30.0 + 7.6);
        assert!((m.x - ex).abs() < 0.5 && (m.y - ey).abs() < 0.5, "ncc {m:?}");
        assert!(m.score > 0.95 && m.ratio > 1.05);
        let l = lsm(tpl, srch, m.x, m.y).unwrap();
        assert!(l.converged && (l.x - ex).abs() < 0.05 && (l.y - ey).abs() < 0.05, "lsm {l:?}");
        assert!(l.score > 0.99);
    }

    #[test]
    fn harris_finds_corners_of_a_square() {
        let (w, h) = (64, 64);
        let mut v = vec![10f32; w * h];
        for y in 20..44 {
            for x in 16..40 {
                v[y * w + x] = 200.0;
            }
        }
        let c = harris(Win { w, h, px: &v }, 4, 4, 5.0);
        assert_eq!(c.len(), 4);
        for k in &c {
            assert!(((k.x - 16.0).abs() < 2.5 || (k.x - 40.0).abs() < 2.5) && ((k.y - 20.0).abs() < 2.5 || (k.y - 44.0).abs() < 2.5), "{k:?}");
        }
    }
}
