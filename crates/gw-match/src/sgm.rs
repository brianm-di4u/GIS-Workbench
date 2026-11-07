//! Semi-global matching (REQ-DEM-04, Hirschmüller 2008; tSGM ranges after Rothermel et al.
//! 2012): 9 × 7 census transform, Hamming matching cost, per-pixel disparity ranges of any length
//! (from the min..max of a coarser level's neighbourhood, so pixels beside a discontinuity can
//! still reach the background), 8-path aggregation with an intensity-adaptive P2,
//! winner-takes-all with a parabolic sub-pixel fit and a uniqueness test, a true left-right check
//! (a right-referenced pass on the mirrored pair), a 3 × 3 median, speckle removal and a
//! figure-of-merit band.
//!
//! Images are rectified so that a point at disparity d in the left image is at x + d in the right
//! image on the same row. Disparity maps are f32 (NaN where unmatched).

/// Figure-of-merit codes (the FOM band of the DSM): 0 = no data (outside, or no overlap),
/// 1 = left-right check failed (occlusion), 2 = ambiguous (uniqueness), 3 = removed as a speckle,
/// 4..=100 = matched (higher is more distinct).
pub const FOM_NODATA: u8 = 0;
pub const FOM_LR: u8 = 1;
pub const FOM_AMBIGUOUS: u8 = 2;
pub const FOM_SPECKLE: u8 = 3;
pub const FOM_MATCHED_MIN: u8 = 4;

/// Longest per-pixel range (disparities) kept; wider ranges are centred on the estimate.
pub const MAX_RANGE: i32 = 160;

#[derive(Clone, Copy, Debug)]
pub struct SgmParams {
    pub p1: u16,
    pub p2: u16,
    /// Required relative margin of the second-best aggregated cost (0.05 = 5 %).
    pub uniqueness: f32,
    /// Left-right tolerance (pixels).
    pub lr_tol: f32,
    /// Segments smaller than this (pixels) whose disparities differ by ≤ 1 from neighbours are removed.
    pub speckle_size: usize,
    /// Census window half-sizes (x, y): 4 × 3 is 9 × 7. Smaller windows fatten edges less.
    pub census: (usize, usize),
}

impl Default for SgmParams {
    fn default() -> Self {
        Self { p1: 7, p2: 86, uniqueness: 0.05, lr_tol: 1.0, speckle_size: 50, census: (4, 3) }
    }
}

pub struct SgmResult {
    pub disparity: Vec<f32>,
    pub fom: Vec<u8>,
    /// An estimate per pixel (the centre of its search range), for placing unmatched pixels.
    pub estimate: Vec<f32>,
}

/// Census (up to 9 × 7 = 63 bits): bit set when the neighbour is darker than the centre. Pixels
/// whose window holds a NaN are marked invalid.
pub fn census(img: &[f32], w: usize, h: usize, (rx, ry): (usize, usize)) -> (Vec<u64>, Vec<bool>) {
    let (rx, ry) = (rx.clamp(1, 4), ry.clamp(1, 3));
    let mut out = vec![0u64; w * h];
    let mut valid = vec![false; w * h];
    for y in ry..h.saturating_sub(ry) {
        for x in rx..w.saturating_sub(rx) {
            let c = img[y * w + x];
            if !c.is_finite() {
                continue;
            }
            let mut bits = 0u64;
            let mut ok = true;
            for dy in -(ry as i64)..=ry as i64 {
                let row = ((y as i64 + dy) as usize) * w;
                for dx in -(rx as i64)..=rx as i64 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let v = img[row + (x as i64 + dx) as usize];
                    if !v.is_finite() {
                        ok = false;
                    }
                    bits = (bits << 1) | u64::from(v < c);
                }
            }
            out[y * w + x] = bits;
            valid[y * w + x] = ok;
        }
    }
    (out, valid)
}

fn flip<T: Copy>(a: &[T], w: usize, h: usize) -> Vec<T> {
    let mut o = a.to_vec();
    for y in 0..h {
        for x in 0..w {
            o[y * w + (w - 1 - x)] = a[y * w + x];
        }
    }
    o
}

/// SGM with per-pixel inclusive ranges [lo, hi] and a true left-right check.
pub fn sgm(left: &[f32], right: &[f32], w: usize, h: usize, lo: &[i32], hi: &[i32], p: &SgmParams) -> SgmResult {
    // Right-image ranges: every left range moved to the right positions it can reach.
    let mut rlo = vec![i32::MAX; w * h];
    let mut rhi = vec![i32::MIN; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let (a, b) = (lo[i], hi[i]);
            // Positions reached by the range's two ends; mark the span (the range is short).
            let x0 = (x as i64 + i64::from(a)).max(0);
            let x1 = (x as i64 + i64::from(b)).min(w as i64 - 1);
            let mut xr = x0;
            while xr <= x1 {
                let k = y * w + xr as usize;
                rlo[k] = rlo[k].min(a);
                rhi[k] = rhi[k].max(b);
                xr += 1;
            }
        }
        for x in 0..w {
            let k = y * w + x;
            if rlo[k] > rhi[k] {
                rlo[k] = lo[y * w + x];
                rhi[k] = hi[y * w + x];
            }
        }
    }
    let rr = sgm_pass(&flip(right, w, h), &flip(left, w, h), w, h, &flip(&rlo, w, h), &flip(&rhi, w, h), p, None);
    let rdisp = flip(&rr.disparity, w, h);
    sgm_pass(left, right, w, h, lo, hi, p, Some(&rdisp))
}

#[allow(clippy::too_many_arguments)]
fn sgm_pass(left: &[f32], right: &[f32], w: usize, h: usize, lo_in: &[i32], hi_in: &[i32], p: &SgmParams, right_disp: Option<&[f32]>) -> SgmResult {
    let n = w * h;
    assert!(left.len() == n && right.len() == n && lo_in.len() == n && hi_in.len() == n);
    // Per-pixel ranges (at least 3 long, at most MAX_RANGE) and their offsets in the volume.
    let mut lo = vec![0i32; n];
    let mut len = vec![0u32; n];
    let mut off = vec![0usize; n + 1];
    for i in 0..n {
        let (mut a, mut b) = (lo_in[i], hi_in[i].max(lo_in[i] + 2));
        if b - a + 1 > MAX_RANGE {
            let c = (a + b) / 2;
            a = c - MAX_RANGE / 2;
            b = a + MAX_RANGE - 1;
        }
        lo[i] = a;
        len[i] = (b - a + 1) as u32;
        off[i + 1] = off[i] + len[i] as usize;
    }
    let total = off[n];
    let (cl, vl) = census(left, w, h, p.census);
    let (cr, vr) = census(right, w, h, p.census);
    const INVALID: u8 = 64;
    let mut cost = vec![INVALID; total];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !vl[i] {
                continue;
            }
            for k in 0..len[i] as usize {
                let xr = x as i64 + i64::from(lo[i]) + k as i64;
                if xr < 0 || xr >= w as i64 {
                    continue;
                }
                let j = y * w + xr as usize;
                if vr[j] {
                    cost[off[i] + k] = (cl[i] ^ cr[j]).count_ones() as u8;
                }
            }
        }
    }
    // Aggregation over 8 paths into S (u16). Path buffers hold one row of variable ranges, at
    // offsets relative to the row's start in the volume.
    let mut agg = vec![0u16; total];
    let (p1, p2) = (p.p1, p.p2);
    let p2a = |a: f32, b: f32| -> u16 {
        let g = (a - b).abs();
        ((f32::from(p2) / (1.0 + g / 16.0)) as u16).max(p1 + 1)
    };
    let maxrow = (0..h).map(|y| off[(y + 1) * w] - off[y * w]).max().unwrap_or(0);
    let mut cur_rows: Vec<Vec<u16>> = vec![vec![0; maxrow]; 4];
    let mut prev_rows: Vec<Vec<u16>> = vec![vec![0; maxrow]; 4];
    let mut tmp = vec![0u16; MAX_RANGE as usize];
    let dirs: [(i64, i64); 8] = [(1, 0), (0, 1), (1, 1), (-1, 1), (-1, 0), (0, -1), (-1, -1), (1, -1)];
    for pass in 0..2 {
        let dset = if pass == 0 { &dirs[0..4] } else { &dirs[4..8] };
        let mut first_row = true;
        for yy in 0..h {
            let y = if pass == 0 { yy } else { h - 1 - yy };
            let row0 = off[y * w];
            for xx in 0..w {
                let x = if pass == 0 { xx } else { w - 1 - xx };
                let i = y * w + x;
                let (o, l) = (off[i], len[i] as usize);
                let rel = o - row0;
                for (di, &(dx, dy)) in dset.iter().enumerate() {
                    let qx = x as i64 - dx;
                    let qy = y as i64 - dy;
                    let inside = qx >= 0 && qx < w as i64 && qy >= 0 && qy < h as i64 && !(dy != 0 && first_row);
                    if !inside {
                        for k in 0..l {
                            tmp[k] = u16::from(cost[o + k]);
                        }
                    } else {
                        let qi = qy as usize * w + qx as usize;
                        let qrel = off[qi] - off[qy as usize * w];
                        let ql = len[qi] as usize;
                        let src = if dy == 0 { &cur_rows[di] } else { &prev_rows[di] };
                        let prev = &src[qrel..qrel + ql];
                        let mut mprev = u16::MAX;
                        for v in prev {
                            mprev = mprev.min(*v);
                        }
                        let pp2 = p2a(left[i], left[qi]);
                        let shift = lo[i] - lo[qi];
                        let get = |kk: i64| -> u16 { if kk >= 0 && (kk as usize) < ql { prev[kk as usize] } else { u16::MAX / 4 } };
                        for k in 0..l {
                            let kq = k as i64 + i64::from(shift);
                            let m = get(kq).min(get(kq - 1).saturating_add(p1)).min(get(kq + 1).saturating_add(p1)).min(mprev.saturating_add(pp2));
                            tmp[k] = u16::from(cost[o + k]) + m.saturating_sub(mprev).min(255);
                        }
                    }
                    cur_rows[di][rel..rel + l].copy_from_slice(&tmp[..l]);
                    let s = &mut agg[o..o + l];
                    for k in 0..l {
                        s[k] = s[k].saturating_add(tmp[k]);
                    }
                }
            }
            for di in 0..4 {
                std::mem::swap(&mut cur_rows[di], &mut prev_rows[di]);
            }
            first_row = false;
        }
    }
    // Winner-takes-all with sub-pixel refinement and uniqueness.
    let mut disp = vec![f32::NAN; n];
    let mut fom = vec![FOM_NODATA; n];
    let mut conf = vec![0f32; n];
    for i in 0..n {
        if !vl[i] {
            continue;
        }
        let (o, l) = (off[i], len[i] as usize);
        let s = &agg[o..o + l];
        let c = &cost[o..o + l];
        let mut best = 0usize;
        for k in 1..l {
            if s[k] < s[best] {
                best = k;
            }
        }
        if c[best] == INVALID {
            continue;
        }
        let mut second = u16::MAX;
        for k in 0..l {
            if (k as i64 - best as i64).abs() > 1 {
                second = second.min(s[k]);
            }
        }
        let sb = f32::from(s[best]).max(1.0);
        let margin = (f32::from(second) - sb) / sb;
        if margin < p.uniqueness {
            fom[i] = FOM_AMBIGUOUS;
            continue;
        }
        let mut d = (lo[i] + best as i32) as f32;
        if best > 0 && best + 1 < l {
            let (a, b, cc) = (f32::from(s[best - 1]), f32::from(s[best]), f32::from(s[best + 1]));
            let den = a - 2.0 * b + cc;
            if den > 0.0 {
                d += (0.5 * (a - cc) / den).clamp(-0.5, 0.5);
            }
        }
        disp[i] = d;
        conf[i] = margin;
        fom[i] = FOM_MATCHED_MIN;
    }
    // Left-right check against the right image's own disparities (when given).
    if let Some(rd) = right_disp {
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if fom[i] != FOM_MATCHED_MIN {
                    continue;
                }
                let xr = (x as f32 + disp[i]).round() as i64;
                let ok = xr >= 0 && xr < w as i64 && {
                    let r = rd[y * w + xr as usize];
                    r.is_finite() && (r - disp[i]).abs() <= p.lr_tol
                };
                if !ok {
                    fom[i] = FOM_LR;
                    disp[i] = f32::NAN;
                }
            }
        }
    }
    // 3 × 3 median of the matched disparities.
    let mut med = disp.clone();
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let i = y * w + x;
            if !disp[i].is_finite() {
                continue;
            }
            let mut v = [0f32; 9];
            let mut m = 0;
            for dy in 0..3 {
                for dx in 0..3 {
                    let q = disp[(y + dy - 1) * w + x + dx - 1];
                    if q.is_finite() {
                        v[m] = q;
                        m += 1;
                    }
                }
            }
            if m >= 5 {
                let s = &mut v[..m];
                s.sort_by(f32::total_cmp);
                med[i] = s[m / 2];
            }
        }
    }
    let mut disp = med;
    // Speckle removal: connected segments (|Δd| ≤ 1) smaller than the limit.
    let mut seen = vec![false; n];
    let mut stack = Vec::new();
    let mut seg = Vec::new();
    for s0 in 0..n {
        if seen[s0] || !disp[s0].is_finite() {
            continue;
        }
        seg.clear();
        stack.push(s0);
        seen[s0] = true;
        while let Some(i) = stack.pop() {
            seg.push(i);
            let (x, y) = (i % w, i / w);
            let nb = [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)];
            for (nx, ny) in nb {
                if nx >= w || ny >= h {
                    continue;
                }
                let j = ny * w + nx;
                if !seen[j] && disp[j].is_finite() && (disp[j] - disp[i]).abs() <= 1.0 {
                    seen[j] = true;
                    stack.push(j);
                }
            }
        }
        if seg.len() < p.speckle_size {
            for &i in &seg {
                disp[i] = f32::NAN;
                fom[i] = FOM_SPECKLE;
            }
        }
    }
    for i in 0..n {
        if fom[i] == FOM_MATCHED_MIN && disp[i].is_finite() {
            fom[i] = FOM_MATCHED_MIN + ((conf[i] / 0.5).min(1.0) * 96.0) as u8;
        }
    }
    let estimate = (0..n).map(|i| lo[i] as f32 + (len[i] as f32 - 1.0) / 2.0).collect();
    SgmResult { disparity: disp, fom, estimate }
}

/// Box-filter downsample by an integer factor (NaN-aware), for the coarse level.
pub fn downsample(img: &[f32], w: usize, h: usize, f: usize) -> (Vec<f32>, usize, usize) {
    let (ow, oh) = (w / f, h / f);
    let mut out = vec![f32::NAN; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let (mut s, mut c) = (0f32, 0usize);
            for dy in 0..f {
                for dx in 0..f {
                    let v = img[(y * f + dy) * w + x * f + dx];
                    if v.is_finite() {
                        s += v;
                        c += 1;
                    }
                }
            }
            if c * 2 >= f * f {
                out[y * ow + x] = s / c as f32;
            }
        }
    }
    (out, ow, oh)
}

/// Coarse-to-fine: full-range SGM at 1/f resolution; at full resolution each pixel searches the
/// min..max of the coarse disparities in its 5 × 5 coarse neighbourhood, ± radius (the tile's
/// full range where the coarse level has no value nearby).
#[allow(clippy::too_many_arguments)]
pub fn sgm_pyramid(left: &[f32], right: &[f32], w: usize, h: usize, dmin: i32, dmax: i32, f: usize, radius: i32, p: &SgmParams) -> SgmResult {
    let (lc, cw, ch) = downsample(left, w, h, f);
    let (rc, _, _) = downsample(right, w, h, f);
    let lo_c = (dmin as f32 / f as f32).floor() as i32 - 1;
    let hi_c = (dmax as f32 / f as f32).ceil() as i32 + 1;
    let coarse = sgm(&lc, &rc, cw, ch, &vec![lo_c; cw * ch], &vec![hi_c; cw * ch], &SgmParams { speckle_size: (p.speckle_size / (f * f)).max(4), ..*p });
    // Neighbourhood min/max of the coarse disparities (5 × 5 cells).
    let mut cmin = vec![f32::NAN; cw * ch];
    let mut cmax = vec![f32::NAN; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let (mut a, mut b) = (f32::INFINITY, f32::NEG_INFINITY);
            for dy in -2i64..=2 {
                for dx in -2i64..=2 {
                    let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                    if xx < 0 || yy < 0 || xx >= cw as i64 || yy >= ch as i64 {
                        continue;
                    }
                    let v = coarse.disparity[yy as usize * cw + xx as usize];
                    if v.is_finite() {
                        a = a.min(v);
                        b = b.max(v);
                    }
                }
            }
            if a.is_finite() {
                cmin[y * cw + x] = a;
                cmax[y * cw + x] = b;
            }
        }
    }
    let mut lo = vec![dmin; w * h];
    let mut hi = vec![dmax; w * h];
    for y in 0..h {
        for x in 0..w {
            let k = (y / f).min(ch.saturating_sub(1)) * cw + (x / f).min(cw.saturating_sub(1));
            if cmin[k].is_finite() {
                lo[y * w + x] = ((cmin[k] * f as f32).floor() as i32 - radius).max(dmin - radius);
                hi[y * w + x] = ((cmax[k] * f as f32).ceil() as i32 + radius).min(dmax + radius);
            }
        }
    }
    sgm(left, right, w, h, &lo, &hi, p)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A textured plane with a raised box: right image = left shifted by the disparity map.
    fn scene(w: usize, h: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        let tex = |x: f64, y: f64| -> f32 { (110.0 + 50.0 * (x / 2.3).sin() * (y / 3.1).cos() + 35.0 * ((x * 0.71 + y * 0.53).sin()) + 25.0 * ((x * 1.9 - y * 0.37).cos() * (y * 0.29).sin())) as f32 };
        let disp = |x: usize, y: usize| -> f32 { if (40..80).contains(&x) && (30..70).contains(&y) { 12.0 } else { 4.0 + 0.02 * x as f32 } };
        let mut l = vec![0f32; w * h];
        let mut r = vec![0f32; w * h];
        let mut d = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                d[y * w + x] = disp(x, y);
                l[y * w + x] = tex(x as f64, y as f64);
            }
        }
        // Right pixel xr shows the left surface point whose x + d is nearest (foreground wins).
        for y in 0..h {
            for xr in 0..w {
                let mut best: Option<(f64, f32)> = None;
                for x in 0..w {
                    let dd = d[y * w + x];
                    let e = ((x as f64 + dd as f64) - xr as f64).abs();
                    if e <= 0.5 && best.map_or(true, |(_, bd)| dd > bd) {
                        best = Some((xr as f64 - dd as f64, dd));
                    }
                }
                r[y * w + xr] = best.map_or(tex(xr as f64 - 4.0, y as f64), |(bx, _)| tex(bx, y as f64));
            }
        }
        (l, r, d)
    }

    #[test]
    fn sgm_recovers_a_plane_and_a_box_without_fattening() {
        let (w, h) = (120, 100);
        let (l, r, truth) = scene(w, h);
        let res = sgm_pyramid(&l, &r, w, h, 0, 20, 2, 4, &SgmParams::default());
        let (mut n, mut good) = (0, 0);
        for y in 8..h - 8 {
            for x in 10..w - 30 {
                let i = y * w + x;
                if res.fom[i] >= FOM_MATCHED_MIN {
                    n += 1;
                    if (res.disparity[i] - truth[i]).abs() < 1.0 {
                        good += 1;
                    }
                }
            }
        }
        let total = (h - 16) * (w - 40);
        assert!(n as f64 > 0.75 * total as f64, "matched {n} of {total}");
        assert!(good as f64 > 0.97 * n as f64, "good {good} of {n}");
        // Background just right of the box (occluded in the right image) is not given the box's
        // disparity: it is flagged or matched at the background.
        let mut fat = 0;
        for y in 32..68 {
            for x in 80..86 {
                let i = y * w + x;
                if res.fom[i] >= FOM_MATCHED_MIN && (res.disparity[i] - 12.0).abs() < 2.0 {
                    fat += 1;
                }
            }
        }
        assert!(fat < 20, "fattened background pixels: {fat}");
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    #[test]
    #[ignore]
    fn sgm_1024_timing() {
        let (w, h) = (1024usize, 1024usize);
        let mut l = vec![0f32; w * h];
        let mut r = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let t = |x: f64| (110.0 + 50.0 * (x / 2.3).sin() * (y as f64 / 3.1).cos() + 35.0 * ((x * 0.71 + y as f64 * 0.53).sin())) as f32;
                l[y * w + x] = t(x as f64);
                r[y * w + x] = t(x as f64 - 6.0);
            }
        }
        let t0 = std::time::Instant::now();
        let res = sgm_pyramid(&l, &r, w, h, 0, 48, 4, 6, &SgmParams::default());
        eprintln!("SGM 1024²: {:?}, matched {}", t0.elapsed(), res.fom.iter().filter(|f| **f >= FOM_MATCHED_MIN).count());
    }
}
