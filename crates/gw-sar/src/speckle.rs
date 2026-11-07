//! Speckle filters on detected intensity (REQ-SAR-07, `Research/09` §6): mean, median, Lee,
//! Kuan, Gamma-MAP, Frost and Refined Lee. They take and return intensity |z|²; the complex data
//! that CCD uses is never filtered. Local statistics come from summed-area tables (O(1) per
//! pixel); windows are clamped at the image edge. NaN input stays NaN.

/// Summed-area tables of v and v² over finite samples, plus their counts.
pub struct Sat {
    w: usize,
    s1: Vec<f64>,
    s2: Vec<f64>,
    n: Vec<u32>,
}

impl Sat {
    pub fn new(v: &[f32], w: usize, h: usize) -> Sat {
        let (iw, ih) = (w + 1, h + 1);
        let mut s1 = vec![0f64; iw * ih];
        let mut s2 = vec![0f64; iw * ih];
        let mut n = vec![0u32; iw * ih];
        for y in 0..h {
            let (mut r1, mut r2, mut rn) = (0f64, 0f64, 0u32);
            for x in 0..w {
                let a = v[y * w + x];
                if a.is_finite() {
                    let a = a as f64;
                    r1 += a;
                    r2 += a * a;
                    rn += 1;
                }
                let i = (y + 1) * iw + x + 1;
                s1[i] = s1[y * iw + x + 1] + r1;
                s2[i] = s2[y * iw + x + 1] + r2;
                n[i] = n[y * iw + x + 1] + rn;
            }
        }
        Sat { w: iw, s1, s2, n }
    }
    /// (mean, variance, count) over [x0, x1) × [y0, y1).
    pub fn stats(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> (f64, f64, u32) {
        let w = self.w;
        let g = |t: &[f64]| t[y1 * w + x1] - t[y0 * w + x1] - t[y1 * w + x0] + t[y0 * w + x0];
        let c = self.n[y1 * w + x1] + self.n[y0 * w + x0] - self.n[y0 * w + x1] - self.n[y1 * w + x0];
        if c == 0 {
            return (f64::NAN, f64::NAN, 0);
        }
        let m = g(&self.s1) / c as f64;
        let v = (g(&self.s2) / c as f64 - m * m).max(0.0);
        (m, v, c)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Filter {
    Mean,
    Median,
    Lee,
    Kuan,
    GammaMap,
    Frost,
    RefinedLee,
}

impl Filter {
    pub fn from_code(c: i32) -> Option<Filter> {
        Some(match c {
            0 => Filter::Mean,
            1 => Filter::Median,
            2 => Filter::Lee,
            3 => Filter::Kuan,
            4 => Filter::GammaMap,
            5 => Filter::Frost,
            6 => Filter::RefinedLee,
            _ => return None,
        })
    }
}

/// Apply a filter. `win` is the odd window size (3–11; Refined Lee always uses 7), `looks` the
/// number of looks L (C_u = 1/√L), `damping` the Frost K.
pub fn filter(v: &[f32], w: usize, h: usize, f: Filter, win: usize, looks: f64, damping: f64) -> Vec<f32> {
    let r = (win.clamp(3, 11) / 2).max(1);
    let cu2 = 1.0 / looks.max(0.1);
    let mut out = vec![f32::NAN; w * h];
    if f == Filter::RefinedLee {
        return refined_lee(v, w, h, cu2);
    }
    let sat = Sat::new(v, w, h);
    let win_of = |x: usize, y: usize, r: usize| (x.saturating_sub(r), y.saturating_sub(r), (x + r + 1).min(w), (y + r + 1).min(h));
    let mut buf: Vec<f32> = Vec::with_capacity((2 * r + 1) * (2 * r + 1));
    for y in 0..h {
        for x in 0..w {
            let z = v[y * w + x];
            if !z.is_finite() {
                continue;
            }
            let (x0, y0, x1, y1) = win_of(x, y, r);
            let (m, var, _) = sat.stats(x0, y0, x1, y1);
            let z = z as f64;
            let ci2 = if m > 0.0 { var / (m * m) } else { 0.0 };
            let est = match f {
                Filter::Mean => m,
                Filter::Median => {
                    buf.clear();
                    for yy in y0..y1 {
                        for xx in x0..x1 {
                            let a = v[yy * w + xx];
                            if a.is_finite() {
                                buf.push(a);
                            }
                        }
                    }
                    let k = buf.len() / 2;
                    buf.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap());
                    buf[k] as f64
                }
                Filter::Lee => {
                    let wgt = if ci2 > 0.0 { (1.0 - cu2 / ci2).max(0.0) } else { 0.0 };
                    m + wgt * (z - m)
                }
                Filter::Kuan => {
                    let wgt = if ci2 > 0.0 { ((1.0 - cu2 / ci2) / (1.0 + cu2)).clamp(0.0, 1.0) } else { 0.0 };
                    m + wgt * (z - m)
                }
                Filter::GammaMap => {
                    let cu = cu2.sqrt();
                    let ci = ci2.sqrt();
                    let cmax = 2f64.sqrt() * cu;
                    if ci <= cu {
                        m
                    } else if ci >= cmax {
                        z
                    } else {
                        let l = 1.0 / cu2;
                        let alpha = (1.0 + cu2) / (ci2 - cu2);
                        let b = alpha - l - 1.0;
                        (b * m + (m * m * b * b + 4.0 * alpha * l * m * z).max(0.0).sqrt()) / (2.0 * alpha)
                    }
                }
                Filter::Frost => {
                    let k = damping.max(0.0) * ci2;
                    let (mut s, mut sw) = (0.0, 0.0);
                    for yy in y0..y1 {
                        for xx in x0..x1 {
                            let a = v[yy * w + xx];
                            if !a.is_finite() {
                                continue;
                            }
                            let d = ((xx as f64 - x as f64).powi(2) + (yy as f64 - y as f64).powi(2)).sqrt();
                            let wk = (-k * d).exp();
                            s += wk * a as f64;
                            sw += wk;
                        }
                    }
                    if sw > 0.0 {
                        s / sw
                    } else {
                        z
                    }
                }
                Filter::RefinedLee => unreachable!(),
            };
            out[y * w + x] = est as f32;
        }
    }
    out
}

/// Refined Lee (Lee 1981): in a 7 × 7 window, 3 × 3 block means give four directional
/// gradients; the strongest edge picks one of eight half-window masks on the side of the
/// centre, and the Lee weight is computed from that mask's statistics.
fn refined_lee(v: &[f32], w: usize, h: usize, cu2: f64) -> Vec<f32> {
    let mut out = vec![f32::NAN; w * h];
    let at = |x: isize, y: isize| -> f64 {
        let xx = x.clamp(0, w as isize - 1) as usize;
        let yy = y.clamp(0, h as isize - 1) as usize;
        let a = v[yy * w + xx];
        if a.is_finite() {
            a as f64
        } else {
            f64::NAN
        }
    };
    // Mask membership for (dx, dy) in −3..=3 for direction d (0..8).
    let in_mask = |d: usize, dx: isize, dy: isize| -> bool {
        match d {
            0 => dy <= 0,           // edge horizontal, keep the upper half
            1 => dy >= 0,           // lower half
            2 => dx <= 0,           // vertical edge, left half
            3 => dx >= 0,           // right half
            4 => dx + dy <= 0,      // diagonal, upper-left
            5 => dx + dy >= 0,      // lower-right
            6 => dx - dy <= 0,      // anti-diagonal, lower-left
            _ => dx - dy >= 0,      // upper-right
        }
    };
    for y in 0..h {
        for x in 0..w {
            let z = v[y * w + x];
            if !z.is_finite() {
                continue;
            }
            let (xi, yi) = (x as isize, y as isize);
            // 3 × 3 grid of 3 × 3 block means, centred on the pixel with stride 2.
            let mut bm = [[0f64; 3]; 3];
            for by in 0..3 {
                for bx in 0..3 {
                    let (cx, cy) = (xi + 2 * (bx as isize - 1), yi + 2 * (by as isize - 1));
                    let (mut s, mut n) = (0.0, 0.0);
                    for dy in -1..=1 {
                        for dx in -1..=1 {
                            let a = at(cx + dx, cy + dy);
                            if a.is_finite() {
                                s += a;
                                n += 1.0;
                            }
                        }
                    }
                    bm[by][bx] = if n > 0.0 { s / n } else { z as f64 };
                }
            }
            let gh = (bm[0][0] + bm[0][1] + bm[0][2]) - (bm[2][0] + bm[2][1] + bm[2][2]);
            let gv = (bm[0][0] + bm[1][0] + bm[2][0]) - (bm[0][2] + bm[1][2] + bm[2][2]);
            let gd = (bm[0][1] + bm[0][0] + bm[1][0]) - (bm[1][2] + bm[2][2] + bm[2][1]);
            let ga = (bm[0][1] + bm[0][2] + bm[1][2]) - (bm[1][0] + bm[2][0] + bm[2][1]);
            let g = [gh.abs(), gv.abs(), gd.abs(), ga.abs()];
            let k = (0..4).max_by(|&a, &b| g[a].partial_cmp(&g[b]).unwrap()).unwrap();
            // Of the two halves across that edge, keep the one whose mean is closer to the centre.
            let (pa, pb) = [(0usize, 1usize), (2, 3), (4, 5), (6, 7)][k];
            let c = bm[1][1];
            let half = |d: usize| -> f64 {
                match d {
                    0 => (bm[0][0] + bm[0][1] + bm[0][2]) / 3.0,
                    1 => (bm[2][0] + bm[2][1] + bm[2][2]) / 3.0,
                    2 => (bm[0][0] + bm[1][0] + bm[2][0]) / 3.0,
                    3 => (bm[0][2] + bm[1][2] + bm[2][2]) / 3.0,
                    4 => (bm[0][1] + bm[0][0] + bm[1][0]) / 3.0,
                    5 => (bm[1][2] + bm[2][2] + bm[2][1]) / 3.0,
                    6 => (bm[1][0] + bm[2][0] + bm[2][1]) / 3.0,
                    _ => (bm[0][1] + bm[0][2] + bm[1][2]) / 3.0,
                }
            };
            let d = if (half(pa) - c).abs() <= (half(pb) - c).abs() { pa } else { pb };
            let (mut s1, mut s2, mut n) = (0.0, 0.0, 0.0);
            for dy in -3..=3isize {
                for dx in -3..=3isize {
                    if !in_mask(d, dx, dy) {
                        continue;
                    }
                    let a = at(xi + dx, yi + dy);
                    if a.is_finite() {
                        s1 += a;
                        s2 += a * a;
                        n += 1.0;
                    }
                }
            }
            let m = s1 / n;
            let var_y = (s2 / n - m * m).max(0.0);
            let var_x = ((var_y - m * m * cu2) / (1.0 + cu2)).max(0.0);
            let b = if var_y > 0.0 { var_x / var_y } else { 0.0 };
            out[y * w + x] = (m + b * (z as f64 - m)) as f32;
        }
    }
    out
}

/// Boxcar multi-look: mean intensity over nr × nc blocks.
pub fn multilook(v: &[f32], w: usize, h: usize, nr: usize, nc: usize) -> (Vec<f32>, usize, usize) {
    let (nr, nc) = (nr.max(1), nc.max(1));
    let (ow, oh) = (w / nc, h / nr);
    let mut out = vec![f32::NAN; ow * oh];
    for oy in 0..oh {
        for ox in 0..ow {
            let (mut s, mut n) = (0f64, 0f64);
            for y in oy * nr..(oy + 1) * nr {
                for x in ox * nc..(ox + 1) * nc {
                    let a = v[y * w + x];
                    if a.is_finite() {
                        s += a as f64;
                        n += 1.0;
                    }
                }
            }
            if n > 0.0 {
                out[oy * ow + ox] = (s / n) as f32;
            }
        }
    }
    (out, ow, oh)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn speckled(w: usize, h: usize, seed: u64) -> Vec<f32> {
        // Single-look exponential intensity around a mean of 1 (left half) and 4 (right half).
        let mut s = seed;
        (0..w * h)
            .map(|i| {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let u = ((s >> 11) as f64 / (1u64 << 53) as f64).max(1e-12);
                let mean = if i % w < w / 2 { 1.0 } else { 4.0 };
                (-u.ln() * mean) as f32
            })
            .collect()
    }

    #[test]
    fn filters_reduce_variance_and_keep_the_mean() {
        let (w, h) = (128, 64);
        let v = speckled(w, h, 3);
        for f in [Filter::Mean, Filter::Median, Filter::Lee, Filter::Kuan, Filter::GammaMap, Filter::Frost, Filter::RefinedLee] {
            let o = filter(&v, w, h, f, 7, 1.0, 2.0);
            // Interior of the left half: far from the edge at w/2.
            let (mut s, mut s2, mut n) = (0.0, 0.0, 0.0);
            for y in 8..h - 8 {
                for x in 8..w / 2 - 8 {
                    let a = o[y * w + x] as f64;
                    s += a;
                    s2 += a * a;
                    n += 1.0;
                }
            }
            let m = s / n;
            let cv = ((s2 / n - m * m).sqrt()) / m;
            let mean_ok = if f == Filter::Median { (m - 2f64.ln()).abs() < 0.25 } else { (m - 1.0).abs() < 0.15 };
            assert!(mean_ok, "{f:?} mean {m}");
            assert!(cv < 0.75, "{f:?} coefficient of variation {cv}");
        }
    }
}
