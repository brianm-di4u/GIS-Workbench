//! Hydrology on a whole grid held in WASM linear memory (REQ-GAP-80, SDP-2.7 §4.2, S-63).
//!
//! Grids are row-major from the north-west corner, `w` × `h` posts, NaN = nodata. Post spacing
//! `dx` (east) and `dy` (north) is in metres, so geographic grids work with their own spacing.
//!
//! Direction plane (`u8`): 0 = nodata or unassigned, 1..=8 = towards neighbour `k - 1` of
//! [`DX`]/[`DY`], 9 = outlet (drains off the grid or into nodata). Neighbour `k` lies at the angle
//! `k * 45°` counter-clockwise from east (0 = E, 1 = NE, 2 = N, …), y up.
//!
//! Memory follows S-63: heights and directions first, the fill queue reserved once and freed
//! before accumulation, and the in-degree kept in the high nibble of the direction byte.

use std::collections::VecDeque;

/// Column step of neighbour k (east positive).
pub const DX: [i32; 8] = [1, 1, 0, -1, -1, -1, 0, 1];
/// Row step of neighbour k (rows grow southwards, so north is −1).
pub const DY: [i32; 8] = [0, -1, -1, -1, 0, 1, 1, 1];
/// Direction code of an outlet.
pub const OUTLET: u8 = 9;

/// The next f32 above `z` (one ulp), for epsilon filling.
#[inline(always)]
fn up(z: f32) -> f32 {
    let b = z.to_bits();
    if z > 0.0 {
        f32::from_bits(b + 1)
    } else if z == 0.0 {
        f32::from_bits(1)
    } else {
        f32::from_bits(b - 1)
    }
}

/// An order-preserving u32 key of an f32.
#[inline(always)]
fn okey(z: f32) -> u32 {
    let b = z.to_bits();
    if b >> 31 == 1 {
        !b
    } else {
        b | 0x8000_0000
    }
}

/// Binary min-heap of (key << 32 | cell): 8 bytes per entry, sized by the flood front.
struct Heap(Vec<u64>);
impl Heap {
    #[inline(always)]
    fn push(&mut self, key: u32, i: u32) {
        let e = ((key as u64) << 32) | i as u64;
        let mut c = self.0.len();
        self.0.push(e);
        while c > 0 {
            let p = (c - 1) >> 1;
            let pe = self.0[p];
            if pe <= e {
                break;
            }
            self.0[c] = pe;
            c = p;
        }
        self.0[c] = e;
    }
    #[inline(always)]
    fn pop(&mut self) -> Option<u32> {
        let top = *self.0.first()?;
        let last = self.0.pop()?;
        let n = self.0.len();
        if n > 0 {
            let mut c = 0;
            loop {
                let l = 2 * c + 1;
                if l >= n {
                    break;
                }
                let r = l + 1;
                let m = if r < n && self.0[r] < self.0[l] { r } else { l };
                if self.0[m] >= last {
                    break;
                }
                self.0[c] = self.0[m];
                c = m;
            }
            self.0[c] = last;
        }
        Some(top as u32)
    }
}

/// What the fill did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FillStats {
    /// Valid (non-NaN) posts.
    pub valid: u32,
    /// Posts raised or left on a flat (they take their flood parent as direction).
    pub raised: u32,
}

/// Priority-flood fill (Barnes, Lehman and Mulla 2014) with a FIFO for pits and flats, in place on
/// `z`. With `eps`, every raised post is one f32 ulp above its parent, so every post drains.
///
/// `dir` is cleared, then raised and flat posts get their flood parent's direction; [`d8`] fills in
/// the rest, the seeds (posts on the grid edge or next to nodata) included: a seed with a lower
/// neighbour inside the grid flows to it, as in WhiteboxTools, and only one with none is an outlet.
/// No cycle can form: D8 steps fall strictly and flood-parent steps never rise. `reserve` sizes the
/// flood queue once (S-63: `w * h` keeps the worst case inside 1 GiB up to 48 M posts).
pub fn fill(z: &mut [f32], w: usize, h: usize, eps: bool, dir: &mut [u8], reserve: usize) -> FillStats {
    let n = w * h;
    assert!(z.len() == n && dir.len() == n);
    dir.fill(0);
    let mut closed = vec![0u64; n.div_ceil(64)];
    let is_closed = |c: &[u64], i: usize| (c[i >> 6] >> (i & 63)) & 1 != 0;
    let mut valid = 0u32;
    for i in 0..n {
        if z[i].is_nan() {
            closed[i >> 6] |= 1 << (i & 63);
        } else {
            valid += 1;
        }
    }
    let mut heap = Heap(Vec::with_capacity(reserve));
    let mut pit: VecDeque<u32> = VecDeque::new();
    let (wi, hi) = (w as i32, h as i32);
    for y in 0..hi {
        for x in 0..wi {
            let i = (y * wi + x) as usize;
            if z[i].is_nan() {
                continue;
            }
            let edge = x == 0 || y == 0 || x + 1 == wi || y + 1 == hi;
            let seed = edge || (0..8).any(|k| z[((y + DY[k]) * wi + x + DX[k]) as usize].is_nan());
            if seed {
                closed[i >> 6] |= 1 << (i & 63);
                heap.push(okey(z[i]), i as u32);
            }
        }
    }
    let mut raised = 0u32;
    loop {
        let c = match pit.pop_front() {
            Some(c) => c as usize,
            None => match heap.pop() {
                Some(c) => c as usize,
                None => break,
            },
        };
        let zc = z[c];
        let cy = (c / w) as i32;
        let cx = c as i32 - cy * wi;
        let zc_up = if eps { up(zc) } else { zc };
        for k in 0..8 {
            let (nx, ny) = (cx + DX[k], cy + DY[k]);
            if nx < 0 || ny < 0 || nx >= wi || ny >= hi {
                continue;
            }
            let ni = (ny * wi + nx) as usize;
            if is_closed(&closed, ni) {
                continue;
            }
            closed[ni >> 6] |= 1 << (ni & 63);
            if z[ni] <= zc_up {
                z[ni] = zc_up;
                dir[ni] = (((k + 4) & 7) + 1) as u8;
                raised += 1;
                pit.push_back(ni as u32);
            } else {
                heap.push(okey(z[ni]), ni as u32);
            }
        }
    }
    FillStats { valid, raised }
}

/// Distances to the eight neighbours for post spacing `dx`, `dy`.
fn dists(dx: f64, dy: f64) -> [f32; 8] {
    let d = (dx * dx + dy * dy).sqrt() as f32;
    let (fx, fy) = (dx as f32, dy as f32);
    [fx, d, fy, d, fx, d, fy, d]
}

/// D8 steepest descent for every valid post still at 0 in `dir`. A post with no lower neighbour
/// becomes an outlet; returns how many (after a fill, only seeds can be: the others have a parent).
pub fn d8(z: &[f32], w: usize, h: usize, dx: f64, dy: f64, dir: &mut [u8]) -> u32 {
    let dist = dists(dx, dy);
    let (wi, hi) = (w as i32, h as i32);
    let mut stuck = 0u32;
    for y in 0..hi {
        for x in 0..wi {
            let i = (y * wi + x) as usize;
            if dir[i] != 0 || z[i].is_nan() {
                continue;
            }
            let zc = z[i];
            let mut best = 0.0f32;
            let mut bk = usize::MAX;
            for k in 0..8 {
                let (nx, ny) = (x + DX[k], y + DY[k]);
                if nx < 0 || ny < 0 || nx >= wi || ny >= hi {
                    continue;
                }
                let s = (zc - z[(ny * wi + nx) as usize]) / dist[k];
                if s > best {
                    best = s;
                    bk = k;
                }
            }
            if bk == usize::MAX {
                dir[i] = OUTLET;
                stuck += 1;
            } else {
                dir[i] = bk as u8 + 1;
            }
        }
    }
    stuck
}

#[inline(always)]
fn off(d: u8, w: isize) -> isize {
    let k = (d - 1) as usize;
    DY[k] as isize * w + DX[k] as isize
}

/// D8 accumulation (posts, each counting itself) in topological order, with no recursion and no
/// queue. For posts with `acc >= thresh` (the stream network) it also gives the Strahler order
/// (`strahler`, empty to skip) and the Shreve magnitude (`shreve`, empty to skip). Returns the
/// number of posts done, which equals the valid count unless `dir` has a cycle.
pub fn accumulate(dir: &mut [u8], w: usize, h: usize, acc: &mut [u32], strahler: &mut [u8], shreve: &mut [u32], thresh: u32) -> u32 {
    let n = w * h;
    let wi = w as isize;
    let (so, sh) = (!strahler.is_empty(), !shreve.is_empty());
    for i in 0..n {
        let d = dir[i] & 15;
        dir[i] = d;
        acc[i] = u32::from(d != 0);
        if so {
            strahler[i] = 0;
        }
        if sh {
            shreve[i] = 0;
        }
    }
    for i in 0..n {
        let d = dir[i] & 15;
        if d != 0 && d != OUTLET {
            let j = (i as isize + off(d, wi)) as usize;
            dir[j] += 16;
        }
    }
    let mut done = 0u32;
    for s in 0..n {
        if dir[s] & 0xF0 != 0 || dir[s] == 0 {
            continue;
        }
        let mut c = s;
        loop {
            let d = dir[c] & 15;
            dir[c] |= 0xF0;
            done += 1;
            let a = acc[c];
            let stream = a >= thresh;
            // Strahler: the low 6 bits hold the largest inflow order, bit 7 that two inflows had it.
            let mut ord = 0u8;
            if so {
                let st = strahler[c];
                let m = st & 0x3F;
                ord = if !stream {
                    0
                } else if m == 0 {
                    1
                } else if st & 0x80 != 0 {
                    m + 1
                } else {
                    m
                };
                strahler[c] = ord;
            }
            if sh {
                shreve[c] = if !stream { 0 } else { shreve[c].max(1) };
            }
            if d == OUTLET {
                break;
            }
            let j = (c as isize + off(d, wi)) as usize;
            acc[j] += a;
            if ord != 0 {
                let st = strahler[j];
                let m = st & 0x3F;
                if ord > m {
                    strahler[j] = ord;
                } else if ord == m {
                    strahler[j] = st | 0x80;
                }
            }
            if sh && stream {
                shreve[j] += shreve[c];
            }
            dir[j] -= 16;
            if dir[j] & 0xF0 != 0 {
                break;
            }
            c = j;
        }
    }
    for d in dir.iter_mut() {
        *d &= 15;
    }
    done
}

/// Move each pour point (post index) to the largest accumulation within `r` posts.
pub fn snap(acc: &[u32], w: usize, h: usize, pts: &mut [u32], r: i32) {
    for p in pts.iter_mut() {
        let y0 = (*p as usize / w) as i32;
        let x0 = *p as i32 - y0 * w as i32;
        let (mut best, mut bi) = (0u32, *p);
        for y in (y0 - r).max(0)..=(y0 + r).min(h as i32 - 1) {
            for x in (x0 - r).max(0)..=(x0 + r).min(w as i32 - 1) {
                let i = y as usize * w + x as usize;
                if acc[i] > best {
                    best = acc[i];
                    bi = i as u32;
                }
            }
        }
        *p = bi;
    }
}

/// Watershed labels 1..=k from pour points (post indices); 0 elsewhere. A post drains to the first
/// pour point on its flow path. `labels` may reuse the accumulation buffer.
pub fn label(dir: &[u8], w: usize, pts: &[u32], labels: &mut [u32]) {
    const NONE: u32 = u32::MAX;
    let wi = w as isize;
    labels.fill(0);
    for (j, &p) in pts.iter().enumerate() {
        labels[p as usize] = j as u32 + 1;
    }
    for s in 0..labels.len() {
        if labels[s] != 0 || dir[s] == 0 {
            continue;
        }
        let mut c = s;
        let l = loop {
            if labels[c] != 0 {
                break labels[c];
            }
            if dir[c] == OUTLET {
                break NONE;
            }
            c = (c as isize + off(dir[c], wi)) as usize;
        };
        let mut c = s;
        while labels[c] == 0 {
            labels[c] = l;
            if dir[c] == OUTLET {
                break;
            }
            c = (c as isize + off(dir[c], wi)) as usize;
        }
    }
    for v in labels.iter_mut() {
        if *v == NONE {
            *v = 0;
        }
    }
}

/// Stream lines of the network `acc >= thresh`: each link runs from a source or a junction down to
/// the next junction or an outlet, and ends on the junction post so the lines join. Encoded as
/// `[count, strahler, shreve, post…]` per link (`strahler`/`shreve` 0 when not given).
pub fn streams(dir: &[u8], acc: &[u32], strahler: &[u8], shreve: &[u32], w: usize, thresh: u32) -> Vec<u32> {
    let n = dir.len();
    let wi = w as isize;
    let on = |i: usize| dir[i] != 0 && acc[i] >= thresh;
    // Stream inflows per post (0, 1, or 2+ for a junction).
    let mut inflow = vec![0u8; n];
    for i in 0..n {
        if on(i) && dir[i] != OUTLET {
            let j = (i as isize + off(dir[i], wi)) as usize;
            inflow[j] = inflow[j].saturating_add(1);
        }
    }
    let mut out = Vec::new();
    for s in 0..n {
        if !on(s) || inflow[s] == 1 {
            continue;
        }
        let head = out.len();
        out.extend_from_slice(&[0, strahler.get(s).copied().unwrap_or(0) as u32, shreve.get(s).copied().unwrap_or(0), s as u32]);
        let mut c = s;
        while dir[c] != OUTLET {
            c = (c as isize + off(dir[c], wi)) as usize;
            out.push(c as u32);
            if inflow[c] != 1 {
                break;
            }
        }
        out[head] = (out.len() - head - 3) as u32;
    }
    out
}

/// Tarboton (1997) D-infinity on posts of spacing `dx` × `dy`. The flow is kept as a facet and the
/// share sent to its second post: `ang = facet + share` in [0, 8) (facet f lies between neighbours
/// f and f + 1); −1 = outlet, −2 = nodata. A post with no downhill facet takes its D8 direction.
pub fn dinf(z: &[f32], w: usize, h: usize, dx: f64, dy: f64, dir: &[u8], ang: &mut [f32]) {
    let (wi, hi) = (w as i32, h as i32);
    let (fx, fy) = (dx as f32, dy as f32);
    for y in 0..hi {
        for x in 0..wi {
            let i = (y * wi + x) as usize;
            let e0 = z[i];
            if e0.is_nan() {
                ang[i] = -2.0;
                continue;
            }
            if dir[i] == OUTLET || dir[i] == 0 {
                ang[i] = -1.0;
                continue;
            }
            let mut best = 0.0f32;
            let mut bang = -1.0f32;
            for f in 0..8usize {
                let (k1, k2) = (f, (f + 1) & 7);
                let (xa, ya, xb, yb) = (x + DX[k1], y + DY[k1], x + DX[k2], y + DY[k2]);
                if xa < 0 || ya < 0 || xa >= wi || ya >= hi || xb < 0 || yb < 0 || xb >= wi || yb >= hi {
                    continue;
                }
                let (za, zb) = (z[(ya * wi + xa) as usize], z[(yb * wi + xb) as usize]);
                if za.is_nan() || zb.is_nan() {
                    continue;
                }
                // The cardinal post of the facet, its distance d1, and the distance d2 across to the diagonal.
                let cardinal_first = k1 % 2 == 0;
                let (ec, ed, kc) = if cardinal_first { (za, zb, k1) } else { (zb, za, k2) };
                let (d1, d2) = if kc % 4 == 0 { (fx, fy) } else { (fy, fx) };
                let s1 = (e0 - ec) / d1;
                let s2 = (ec - ed) / d2;
                let rmax = d2.atan2(d1);
                let (r, s) = if s2 <= 0.0 {
                    (0.0, s1)
                } else {
                    let r = s2.atan2(s1);
                    if r >= rmax {
                        (rmax, (e0 - ed) / (d1 * d1 + d2 * d2).sqrt())
                    } else {
                        (r, (s1 * s1 + s2 * s2).sqrt())
                    }
                };
                if s > best {
                    best = s;
                    // Share towards the diagonal post; the facet's second post is k2.
                    let t = r / rmax;
                    bang = f as f32 + if cardinal_first { t } else { 1.0 - t };
                }
            }
            ang[i] = if best > 0.0 { bang.min(7.999_999) } else { (dir[i] - 1) as f32 };
        }
    }
}

/// D-infinity accumulation (posts, f32) from [`dinf`]. `indeg` is a scratch plane. Returns the
/// number of posts done and the flow that left the grid.
pub fn dinf_accumulate(ang: &[f32], w: usize, h: usize, indeg: &mut [u8], acc: &mut [f32]) -> (u32, f64) {
    let n = w * h;
    let (wi, hi) = (w as i32, h as i32);
    let targets = |i: usize, a: f32| -> [(isize, f32); 2] {
        let f = (a.floor() as i32).clamp(0, 7) as usize;
        let p = (a - f as f32).clamp(0.0, 1.0);
        let y = (i / w) as i32;
        let x = i as i32 - y * wi;
        let mut r = [(-1isize, 0.0f32); 2];
        for (m, (k, wt)) in [(f, 1.0 - p), ((f + 1) & 7, p)].into_iter().enumerate() {
            if wt <= 0.0 {
                continue;
            }
            let (nx, ny) = (x + DX[k], y + DY[k]);
            let ok = nx >= 0 && ny >= 0 && nx < wi && ny < hi && ang[(ny * wi + nx) as usize] != -2.0;
            r[m] = (if ok { (ny * wi + nx) as isize } else { -1 }, wt);
        }
        r
    };
    indeg.fill(0);
    for i in 0..n {
        let a = ang[i];
        acc[i] = if a == -2.0 { 0.0 } else { 1.0 };
        if a >= 0.0 {
            for (j, wt) in targets(i, a) {
                if j >= 0 && wt > 0.0 {
                    indeg[j as usize] += 1;
                }
            }
        }
    }
    let mut stack: Vec<u32> = Vec::new();
    let (mut done, mut lost) = (0u32, 0.0f64);
    for s in 0..n {
        if ang[s] == -2.0 || indeg[s] != 0 {
            continue;
        }
        stack.push(s as u32);
        while let Some(c) = stack.pop() {
            let c = c as usize;
            indeg[c] = 255;
            done += 1;
            let (a, an) = (acc[c], ang[c]);
            if an < 0.0 {
                lost += a as f64;
                continue;
            }
            for (j, wt) in targets(c, an) {
                if wt <= 0.0 {
                    continue;
                }
                if j < 0 {
                    lost += (a * wt) as f64;
                    continue;
                }
                let j = j as usize;
                acc[j] += a * wt;
                indeg[j] -= 1;
                if indeg[j] == 0 {
                    stack.push(j as u32);
                }
            }
        }
    }
    (done, lost)
}

#[cfg(test)]
mod tests;
