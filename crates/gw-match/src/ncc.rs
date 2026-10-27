//! The NCC "Fast" engine (REQ-DEM-05): winner-take-all normalised cross-correlation of square
//! windows over the disparity range (left x matches right x + d, as in `sgm`), with box sums from
//! integral images (one pass per disparity), a sub-pixel parabola, a uniqueness ratio and a
//! left–right check. Much faster than SGM and blunt at depth edges: the windows straddle them, so
//! the result is flagged edge-poor. Output uses the SGM figure-of-merit codes.

use crate::sgm::{SgmResult, FOM_AMBIGUOUS, FOM_LR, FOM_MATCHED_MIN, FOM_NODATA};

fn integral(a: &[f64], w: usize, h: usize) -> Vec<f64> {
    let (iw, ih) = (w + 1, h + 1);
    let mut s = vec![0f64; iw * ih];
    for y in 0..h {
        let mut row = 0.0;
        for x in 0..w {
            row += a[y * w + x];
            s[(y + 1) * iw + x + 1] = s[y * iw + x + 1] + row;
        }
    }
    s
}

#[inline]
fn boxsum(s: &[f64], iw: usize, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
    s[y1 * iw + x1] - s[y0 * iw + x1] - s[y1 * iw + x0] + s[y0 * iw + x0]
}

/// NCC disparities, one direction, at disparities base(x) + δ for δ in [dmin, dmax] (base = 0 for a
/// plain range). Returns (disparity, best NCC, second-best NCC away from the peak).
#[allow(clippy::too_many_arguments)]
fn wta(a: &[f32], b: &[f32], w: usize, h: usize, dmin: i32, dmax: i32, r: usize, sign: i32, base: Option<&[i32]>) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let n = w * h;
    let fa: Vec<f64> = a.iter().map(|v| if v.is_finite() { f64::from(*v) } else { 0.0 }).collect();
    let fb: Vec<f64> = b.iter().map(|v| if v.is_finite() { f64::from(*v) } else { 0.0 }).collect();
    let iw = w + 1;
    let sa = integral(&fa, w, h);
    let sa2 = integral(&fa.iter().map(|v| v * v).collect::<Vec<_>>(), w, h);
    let sb = integral(&fb, w, h);
    let sb2 = integral(&fb.iter().map(|v| v * v).collect::<Vec<_>>(), w, h);
    let nd = (dmax - dmin + 1).max(1) as usize;
    let mut scores = vec![f32::NEG_INFINITY; n * nd];
    let mut prod = vec![0f64; n];
    for (di, d) in (dmin..=dmax).enumerate() {
        let d = d * sign;
        let bd = |k: usize| base.map_or(0, |b| b[k] * sign);
        for y in 0..h {
            for x in 0..w {
                let xb = x as i32 + d + bd(y * w + x);
                prod[y * w + x] = if xb >= 0 && (xb as usize) < w { fa[y * w + x] * fb[y * w + xb as usize] } else { 0.0 };
            }
        }
        let sp = integral(&prod, w, h);
        for y in r..h.saturating_sub(r) {
            for x in r..w.saturating_sub(r) {
                let xb = x as i32 + d + bd(y * w + x);
                if xb - (r as i32) < 0 || xb + r as i32 >= w as i32 {
                    continue;
                }
                let (x0, y0, x1, y1) = (x - r, y - r, x + r + 1, y + r + 1);
                let (bx0, bx1) = ((xb as usize) - r, xb as usize + r + 1);
                let m = ((2 * r + 1) * (2 * r + 1)) as f64;
                let (ma, mb) = (boxsum(&sa, iw, x0, y0, x1, y1) / m, boxsum(&sb, iw, bx0, y0, bx1, y1) / m);
                let va = boxsum(&sa2, iw, x0, y0, x1, y1) / m - ma * ma;
                let vb = boxsum(&sb2, iw, bx0, y0, bx1, y1) / m - mb * mb;
                if va <= 1e-6 || vb <= 1e-6 {
                    continue;
                }
                let cov = boxsum(&sp, iw, x0, y0, x1, y1) / m - ma * mb;
                scores[(y * w + x) * nd + di] = (cov / (va * vb).sqrt()) as f32;
            }
        }
    }
    let mut disp = vec![f32::NAN; n];
    let mut best = vec![f32::NAN; n];
    let mut second = vec![f32::NAN; n];
    for k in 0..n {
        let s = &scores[k * nd..(k + 1) * nd];
        let (mut bi, mut bv) = (usize::MAX, f32::NEG_INFINITY);
        for (i, v) in s.iter().enumerate() {
            if *v > bv {
                bv = *v;
                bi = i;
            }
        }
        if bi == usize::MAX || !bv.is_finite() {
            continue;
        }
        let mut sv = f32::NEG_INFINITY;
        for (i, v) in s.iter().enumerate() {
            if i.abs_diff(bi) > 1 && *v > sv {
                sv = *v;
            }
        }
        // Sub-pixel parabola through the neighbours.
        let mut dsub = bi as f32;
        if bi > 0 && bi + 1 < nd && s[bi - 1].is_finite() && s[bi + 1].is_finite() {
            let den = s[bi - 1] - 2.0 * s[bi] + s[bi + 1];
            if den < 0.0 {
                dsub += (0.5 * (s[bi - 1] - s[bi + 1]) / den).clamp(-0.5, 0.5);
            }
        }
        disp[k] = dmin as f32 + dsub + base.map_or(0, |b| b[k]) as f32;
        best[k] = bv;
        second[k] = sv;
    }
    (disp, best, second)
}

fn down(a: &[f32], w: usize, h: usize, f: usize) -> (Vec<f32>, usize, usize) {
    let (cw, ch) = (w.div_ceil(f), h.div_ceil(f));
    let mut o = vec![0f32; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let (mut s, mut n) = (0f32, 0f32);
            for yy in y * f..((y + 1) * f).min(h) {
                for xx in x * f..((x + 1) * f).min(w) {
                    let v = a[yy * w + xx];
                    if v.is_finite() {
                        s += v;
                        n += 1.0;
                    }
                }
            }
            o[y * cw + x] = if n > 0.0 { s / n } else { f32::NAN };
        }
    }
    (o, cw, ch)
}

/// NCC Fast disparities over [dmin, dmax] with a (2r + 1)² window, matched at half resolution
/// (the DSM posts are coarser than the pixels) and scaled back to full-resolution disparities.
#[allow(clippy::too_many_arguments)]
pub fn ncc_fast(left: &[f32], right: &[f32], w: usize, h: usize, dmin: i32, dmax: i32, r: usize, min_ncc: f32, uniqueness: f32, lr_tol: f32) -> SgmResult {
    let f = 2usize;
    let (lc, cw, ch) = down(left, w, h, f);
    let (rc, _, _) = down(right, w, h, f);
    let (c0, c1) = ((dmin as f32 / f as f32).floor() as i32 - 1, (dmax as f32 / f as f32).ceil() as i32 + 1);
    let (dl, best, second) = wta(&lc, &rc, cw, ch, c0, c1, r, 1, None);
    // Right-referenced pass: right x matches left x − d.
    let (dr, _, _) = wta(&rc, &lc, cw, ch, c0, c1, r, -1, None);
    let mut cd = vec![f32::NAN; cw * ch];
    let mut cf = vec![FOM_NODATA; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let k = y * cw + x;
            let d = dl[k];
            if !d.is_finite() || best[k] < min_ncc {
                continue;
            }
            if second[k].is_finite() && (1.0 - second[k]) * uniqueness < (1.0 - best[k]) {
                cf[k] = FOM_AMBIGUOUS;
                continue;
            }
            let xr = (x as f32 + d).round() as i64;
            if xr < 0 || xr >= cw as i64 || !dr[y * cw + xr as usize].is_finite() || (dr[y * cw + xr as usize] - d).abs() > lr_tol / f as f32 {
                cf[k] = FOM_LR;
                continue;
            }
            cd[k] = d * f as f32;
            // NCC 0.5 … 1 → FOM 4 … 100.
            cf[k] = (FOM_MATCHED_MIN as f32 + (96.0 * ((best[k] - 0.5) / 0.5).clamp(0.0, 1.0))).round() as u8;
        }
    }
    let n = w * h;
    let mut disparity = vec![f32::NAN; n];
    let mut fom = vec![FOM_NODATA; n];
    let mid = (dmin + dmax) as f32 / 2.0;
    for y in 0..h {
        for x in 0..w {
            let k = (y / f).min(ch - 1) * cw + (x / f).min(cw - 1);
            disparity[y * w + x] = cd[k];
            fom[y * w + x] = cf[k];
        }
    }
    SgmResult { disparity, fom, estimate: vec![mid; n] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plane_with_box() {
        let (w, h) = (96usize, 80usize);
        let tex = |x: f64, y: f64| -> f32 { (110.0 + 50.0 * (x / 2.3).sin() * (y / 3.1).cos() + 35.0 * ((x * 0.71 + y * 0.53).sin()) + 25.0 * ((x * 1.9 - y * 0.37).cos() * (y * 0.29).sin())) as f32 };
        let disp = |x: f64, y: f64| -> f64 { if (40.0..70.0).contains(&x) && (30.0..60.0).contains(&y) { 9.0 } else { 4.0 } };
        let l: Vec<f32> = (0..w * h).map(|k| tex((k % w) as f64, (k / w) as f64)).collect();
        // right(xr) = left(xr − d): left x matches right x + d.
        let r: Vec<f32> = (0..w * h)
            .map(|k| {
                let (xr, y) = ((k % w) as f64, (k / w) as f64);
                let d = if disp(xr - 9.0, y) > 5.0 { 9.0 } else { 4.0 };
                tex(xr - d, y)
            })
            .collect();
        let res = ncc_fast(&l, &r, w, h, 0, 14, 3, 0.6, 0.9, 1.0);
        let (mut ok, mut n) = (0, 0);
        for y in 10..h - 10 {
            for x in 10..w - 24 {
                let d = res.disparity[y * w + x];
                if !d.is_finite() {
                    continue;
                }
                n += 1;
                if (f64::from(d) - disp(x as f64, y as f64)).abs() < 0.5 {
                    ok += 1;
                }
            }
        }
        assert!(n > 2000, "matched {n}");
        assert!(ok as f64 / n as f64 > 0.9, "{ok}/{n}");
    }
}
