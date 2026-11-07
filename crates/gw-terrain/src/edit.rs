//! DEM edit kernels (REQ-DEM-08/09, REQ-GAP-37/38): the non-destructive edit log of
//! `app/src/features/dem-tools.js` replayed over a copy of the source heights. The JS
//! `applyEdit` stays as the differential oracle (tests/unit/demedit24.test.js), so this port keeps
//! its arithmetic: heights are stored as f32 after every write, working values are f64, JS
//! `Math.round` is `floor(x + 0.5)`, and iterative fills visit posts in the same order.
//!
//! Grid: posts on a geographic lattice, `lat = lat0 − j·dlat`, `lon = lon0 + i·dlon`, row-major.
//! Edits (codes of the flat f64 encoding in `parse`): 1 post, 2 raise/lower with feather,
//! 3 flatten, 4 plane fit, 5 lake fill with islands, 6 smooth, 7 interpolate from the edge,
//! 8 spike/well removal, 9 breakline, 10 bare earth in a polygon (SMRF), 11 re-correlated
//! surface patch.

#[derive(Clone, Copy, Debug)]
pub struct Geo {
    pub w: usize,
    pub h: usize,
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
}

pub type Ring = Vec<[f64; 2]>;

#[derive(Clone, Debug)]
pub struct Patch {
    pub lat0: f64,
    pub lon0: f64,
    pub dlat: f64,
    pub dlon: f64,
    pub nx: usize,
    pub ny: usize,
    pub z: Vec<f32>,
}

#[derive(Clone, Debug)]
pub enum Op {
    Post { lat: f64, lon: f64, h: f64 },
    Raise { dh: f64, feather: f64, ring: Ring },
    Flatten { h: f64, ring: Ring },
    Plane { ring: Ring },
    Lake { level: f64, ring: Ring, holes: Vec<Ring> },
    Smooth { radius: f64, ring: Ring },
    Interpolate { ring: Ring },
    Despike { threshold: f64, ring: Option<Ring> },
    Breakline { width: f64, line: Vec<[f64; 3]> },
    BareEarth { smrf: Smrf, ring: Ring },
    Recorrelate { patch: Patch, ring: Ring },
}

#[derive(Clone, Copy, Debug)]
pub struct Smrf {
    pub max_window_m: f64,
    pub slope: f64,
    pub height: f64,
    pub scale: f64,
}

impl Default for Smrf {
    fn default() -> Self {
        Smrf { max_window_m: 30.0, slope: 0.15, height: 0.5, scale: 1.25 }
    }
}

/// JS `Math.round`.
#[inline]
fn jround(x: f64) -> f64 {
    (x + 0.5).floor()
}

#[inline]
fn idx(g: &Geo, i: i64, j: i64) -> usize {
    j as usize * g.w + i as usize
}

/// A post index; a value that is not finite (JS NaN) maps far outside every grid, so bounds checks
/// refuse it as JS comparisons with NaN do.
#[inline]
fn post_index(x: f64) -> i64 {
    if x.is_finite() {
        (x as i64).clamp(-(1 << 40), 1 << 40)
    } else {
        -(1 << 40)
    }
}

#[inline]
fn post_of(g: &Geo, lat: f64, lon: f64) -> (i64, i64) {
    (post_index(jround((lon - g.lon0) / g.dlon)), post_index(jround((g.lat0 - lat) / g.dlat)))
}

#[inline]
fn lat_of(g: &Geo, j: i64) -> f64 {
    g.lat0 - j as f64 * g.dlat
}

#[inline]
fn lon_of(g: &Geo, i: i64) -> f64 {
    g.lon0 + i as f64 * g.dlon
}

fn in_ring(ring: &[[f64; 2]], lon: f64, lat: f64) -> bool {
    let mut c = false;
    let n = ring.len();
    if n == 0 {
        return false;
    }
    let mut b = n - 1;
    for a in 0..n {
        let [xa, ya] = ring[a];
        let [xb, yb] = ring[b];
        if (ya > lat) != (yb > lat) && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa {
            c = !c;
        }
        b = a;
    }
    c
}

#[derive(Clone, Copy, Debug)]
pub struct PostBox {
    pub i0: i64,
    pub i1: i64,
    pub j0: i64,
    pub j1: i64,
}

#[derive(Clone, Copy, Debug)]
struct P {
    i: i64,
    j: i64,
    k: usize,
}

fn min_max(v: impl Iterator<Item = f64>) -> (f64, f64) {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for x in v {
        if x < lo {
            lo = x;
        }
        if x > hi {
            hi = x;
        }
    }
    (lo, hi)
}

/// Posts inside a ring minus holes, row-major, and the padded bounding post box (`postsIn`).
fn posts_in(g: &Geo, ring: &[[f64; 2]], holes: &[Ring]) -> (Vec<P>, PostBox) {
    let (lon_lo, lon_hi) = min_max(ring.iter().map(|p| p[0]));
    let (lat_lo, lat_hi) = min_max(ring.iter().map(|p| p[1]));
    let a = post_of(g, lat_hi, lon_lo);
    let b = post_of(g, lat_lo, lon_hi);
    let (w, h) = (g.w as i64, g.h as i64);
    let bx = PostBox { i0: (a.0 - 1).max(0), i1: (b.0 + 1).min(w - 1), j0: (a.1 - 1).max(0), j1: (b.1 + 1).min(h - 1) };
    let mut out = Vec::new();
    for j in bx.j0..=bx.j1 {
        for i in bx.i0..=bx.i1 {
            let (lon, lat) = (lon_of(g, i), lat_of(g, j));
            if in_ring(ring, lon, lat) && !holes.iter().any(|hh| in_ring(hh, lon, lat)) {
                out.push(P { i, j, k: idx(g, i, j) });
            }
        }
    }
    (out, bx)
}

/// Metres per post (x, y) near a latitude (`cellM`).
fn cell_m(g: &Geo, lat: f64) -> (f64, f64) {
    (g.dlon * 111320.0 * (lat * std::f64::consts::PI / 180.0).cos(), g.dlat * 110950.0)
}

fn dist_to_ring(ring: &[[f64; 2]], lon: f64, lat: f64, mx: f64, my: f64) -> f64 {
    let mut d = f64::INFINITY;
    let n = ring.len();
    let mut b = n - 1;
    for a in 0..n {
        let (x1, y1) = ((ring[b][0] - lon) * mx, (ring[b][1] - lat) * my);
        let (x2, y2) = ((ring[a][0] - lon) * mx, (ring[a][1] - lat) * my);
        let (dx, dy) = (x2 - x1, y2 - y1);
        let den = dx * dx + dy * dy;
        let t = (-(x1 * dx + y1 * dy) / if den != 0.0 { den } else { 1.0 }).clamp(0.0, 1.0);
        // JS Math.min: a NaN distance (a vertex that is not a number) makes the result NaN.
        let e = (x1 + t * dx).hypot(y1 + t * dy);
        d = if e.is_nan() || d.is_nan() { f64::NAN } else { d.min(e) };
        b = a;
    }
    d
}

/// The JS `median` helper: finite values sorted, the element at ⌊n/2⌋.
fn median(v: &mut Vec<f64>) -> f64 {
    v.retain(|x| x.is_finite());
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[v.len() / 2]
}

fn solve3(n: [[f64; 3]; 3], r: [f64; 3]) -> Option<[f64; 3]> {
    let mut m = [[0f64; 4]; 3];
    for i in 0..3 {
        m[i] = [n[i][0], n[i][1], n[i][2], r[i]];
    }
    for c in 0..3 {
        let mut p = c;
        for k in c + 1..3 {
            if m[k][c].abs() > m[p][c].abs() {
                p = k;
            }
        }
        if m[p][c].abs() < 1e-12 {
            return None;
        }
        m.swap(c, p);
        for k in 0..3 {
            if k == c {
                continue;
            }
            let f = m[k][c] / m[c][c];
            for j in c..4 {
                m[k][j] -= f * m[c][j];
            }
        }
    }
    Some([m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]])
}

#[inline]
fn fin(v: f32) -> bool {
    v.is_finite()
}

/// Apply one edit in place.
pub fn apply(g: &Geo, hz: &mut [f32], op: &Op) {
    let (w, h) = (g.w as i64, g.h as i64);
    match op {
        Op::Post { lat, lon, h: v } => {
            let (i, j) = post_of(g, *lat, *lon);
            if i >= 0 && j >= 0 && i < w && j < h {
                hz[idx(g, i, j)] = *v as f32;
            }
        }
        Op::Raise { dh, feather, ring } => {
            let feather = feather.max(0.0);
            let (lat_lo, lat_hi) = min_max(ring.iter().map(|q| q[1]));
            let lat0 = (lat_hi + lat_lo) / 2.0;
            let (cx, cy) = cell_m(g, lat0);
            let mx = cx / g.dlon;
            let my = cy / g.dlat;
            // Bounded by the grid: a huge feather (a malformed project) would overflow i64 otherwise.
            let pad_i = ((feather / cx).ceil() as i64).min(w) + 1;
            let pad_j = ((feather / cy).ceil() as i64).min(h) + 1;
            let (_, bx) = posts_in(g, ring, &[]);
            for j in (bx.j0 - pad_j).max(0)..=(bx.j1 + pad_j).min(h - 1) {
                for i in (bx.i0 - pad_i).max(0)..=(bx.i1 + pad_i).min(w - 1) {
                    let (lon, lat) = (lon_of(g, i), lat_of(g, j));
                    let k = idx(g, i, j);
                    if !fin(hz[k]) {
                        continue;
                    }
                    if in_ring(ring, lon, lat) {
                        hz[k] = (hz[k] as f64 + dh) as f32;
                    } else if feather > 0.0 {
                        let d = dist_to_ring(ring, lon, lat, mx, my);
                        if d < feather {
                            let t = d / feather;
                            hz[k] = (hz[k] as f64 + dh * (1.0 - t * t * (3.0 - 2.0 * t))) as f32;
                        }
                    }
                }
            }
        }
        Op::Flatten { h: lv, ring } => {
            let (posts, _) = posts_in(g, ring, &[]);
            let level = if lv.is_finite() {
                *lv
            } else {
                let s: f64 = posts.iter().map(|q| if fin(hz[q.k]) { hz[q.k] as f64 } else { 0.0 }).sum();
                let c = posts.iter().filter(|q| fin(hz[q.k])).count();
                s / (c.max(1) as f64)
            };
            for q in &posts {
                hz[q.k] = level as f32;
            }
        }
        Op::Plane { ring } => {
            let (posts, _) = posts_in(g, ring, &[]);
            let mut n = [[0f64; 3]; 3];
            let mut r = [0f64; 3];
            for q in &posts {
                let v = hz[q.k] as f64;
                if !v.is_finite() {
                    continue;
                }
                let row = [1.0, q.i as f64, q.j as f64];
                for a in 0..3 {
                    r[a] += row[a] * v;
                    for b in 0..3 {
                        n[a][b] += row[a] * row[b];
                    }
                }
            }
            if let Some(c) = solve3(n, r) {
                for q in &posts {
                    hz[q.k] = (c[0] + c[1] * q.i as f64 + c[2] * q.j as f64) as f32;
                }
            }
        }
        Op::Lake { level, ring, holes } => {
            let (posts, _) = posts_in(g, ring, holes);
            let mut lv = *level;
            if !lv.is_finite() {
                let (rp, _) = posts_in(g, ring, &[]);
                let inside: std::collections::HashSet<usize> = rp.iter().map(|q| q.k).collect();
                let mut lo = f64::INFINITY;
                for q in &rp {
                    for (di, dj) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                        let (ii, jj) = (q.i + di, q.j + dj);
                        if ii < 0 || jj < 0 || ii >= w || jj >= h {
                            continue;
                        }
                        let k = idx(g, ii, jj);
                        if !inside.contains(&k) && fin(hz[k]) {
                            lo = lo.min(hz[k] as f64);
                        }
                    }
                }
                lv = lo;
            }
            if !lv.is_finite() {
                return;
            }
            for q in &posts {
                hz[q.k] = lv as f32;
            }
        }
        Op::Smooth { radius, ring } => {
            // Bounded by the grid (a malformed log must not hang the replay; same in dem-edit.js).
            let rad = (jround(*radius).max(1.0) as i64).min(w.max(h));
            let (posts, _) = posts_in(g, ring, &[]);
            let src = hz.to_vec();
            for q in &posts {
                let (mut s, mut c) = (0f64, 0f64);
                for dj in -rad..=rad {
                    for di in -rad..=rad {
                        let (ii, jj) = (q.i + di, q.j + dj);
                        if ii < 0 || jj < 0 || ii >= w || jj >= h {
                            continue;
                        }
                        let v = src[idx(g, ii, jj)];
                        if fin(v) {
                            s += v as f64;
                            c += 1.0;
                        }
                    }
                }
                if c > 0.0 {
                    hz[q.k] = (s / c) as f32;
                }
            }
        }
        Op::Interpolate { ring } => {
            let (posts, _) = posts_in(g, ring, &[]);
            let inside: std::collections::HashSet<usize> = posts.iter().map(|q| q.k).collect();
            let nb = |q: &P| -> Vec<usize> {
                [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)].iter().map(|(di, dj)| (q.i + di, q.j + dj)).filter(|&(ii, jj)| ii >= 0 && jj >= 0 && ii < w && jj < h).map(|(ii, jj)| idx(g, ii, jj)).collect()
            };
            let nbs: Vec<Vec<usize>> = posts.iter().map(nb).collect();
            let (mut es, mut ec) = (0f64, 0usize);
            for ks in &nbs {
                for &k in ks {
                    if !inside.contains(&k) && fin(hz[k]) {
                        es += hz[k] as f64;
                        ec += 1;
                    }
                }
            }
            let start = if ec > 0 { es / ec as f64 } else { 0.0 };
            for q in &posts {
                hz[q.k] = start as f32;
            }
            for _ in 0..400 {
                let mut change = 0f64;
                for (q, ks) in posts.iter().zip(&nbs) {
                    let (mut s, mut c) = (0f64, 0f64);
                    for &k in ks {
                        if fin(hz[k]) {
                            s += hz[k] as f64;
                            c += 1.0;
                        }
                    }
                    if c == 0.0 {
                        continue;
                    }
                    let v = s / c;
                    change = change.max((v - hz[q.k] as f64).abs());
                    hz[q.k] = v as f32;
                }
                if change < 1e-4 {
                    break;
                }
            }
        }
        Op::Despike { threshold, ring } => {
            let thr = *threshold;
            let src = hz.to_vec();
            let mut vals = Vec::with_capacity(8);
            let mut visit = |hz: &mut [f32], i: i64, j: i64| {
                let k = idx(g, i, j);
                let v = src[k];
                if !fin(v) {
                    return;
                }
                vals.clear();
                for dj in -1..=1i64 {
                    for di in -1..=1i64 {
                        if di == 0 && dj == 0 {
                            continue;
                        }
                        let (ii, jj) = (i + di, j + dj);
                        if ii >= 0 && jj >= 0 && ii < w && jj < h {
                            vals.push(src[idx(g, ii, jj)] as f64);
                        }
                    }
                }
                let m = median(&mut vals);
                if m.is_finite() && (v as f64 - m).abs() > thr {
                    hz[k] = m as f32;
                }
            };
            match ring {
                Some(r) => {
                    for q in posts_in(g, r, &[]).0 {
                        visit(hz, q.i, q.j);
                    }
                }
                None => {
                    for j in 0..h {
                        for i in 0..w {
                            visit(hz, i, j);
                        }
                    }
                }
            }
        }
        Op::Breakline { width, line } => {
            let half = (width / 2.0).max(0.5);
            for s in 1..line.len() {
                let (a, b) = (line[s - 1], line[s]);
                let (cx, cy) = cell_m(g, (a[1] + b[1]) / 2.0);
                let len = ((b[0] - a[0]) * (cx / g.dlon)).hypot((b[1] - a[1]) * (cy / g.dlat));
                let steps_f = (len / cx.min(cy)).ceil();
                // A segment longer than a million posts (or not finite) is malformed input: skipped,
                // as the JS loop runs no step for it.
                if !(steps_f <= 1e6) {
                    continue;
                }
                let steps = (steps_f as i64).max(1);
                for t in 0..=steps {
                    let f = t as f64 / steps as f64;
                    let lon = a[0] + (b[0] - a[0]) * f;
                    let lat = a[1] + (b[1] - a[1]) * f;
                    let hh = a[2] + (b[2] - a[2]) * f;
                    let c = post_of(g, lat, lon);
                    let ri = ((half / cx).ceil() as i64).min(w);
                    let rj = ((half / cy).ceil() as i64).min(h);
                    for dj in -rj..=rj {
                        for di in -ri..=ri {
                            let (ii, jj) = (c.0 + di, c.1 + dj);
                            if ii >= 0 && jj >= 0 && ii < w && jj < h && (di as f64 * cx).hypot(dj as f64 * cy) <= half {
                                hz[idx(g, ii, jj)] = hh as f32;
                            }
                        }
                    }
                }
            }
        }
        Op::BareEarth { smrf: prm, ring } => {
            // SMRF on the ring's post box padded by the largest window (plus two posts), then the
            // posts inside the ring take the DTM.
            let (posts, bx) = posts_in(g, ring, &[]);
            if posts.is_empty() {
                return;
            }
            let lat_c = (lat_of(g, bx.j0) + lat_of(g, bx.j1)) / 2.0;
            let (cx, cy) = cell_m(g, lat_c);
            let pi = ((prm.max_window_m / cx).ceil() as i64).min(w) + 2;
            let pj = ((prm.max_window_m / cy).ceil() as i64).min(h) + 2;
            let (i0, i1, j0, j1) = ((bx.i0 - pi).max(0), (bx.i1 + pi).min(w - 1), (bx.j0 - pj).max(0), (bx.j1 + pj).min(h - 1));
            let sub = Geo { w: (i1 - i0 + 1) as usize, h: (j1 - j0 + 1) as usize, lat0: lat_of(g, j0), lon0: lon_of(g, i0), dlat: g.dlat, dlon: g.dlon };
            let mut sz = vec![0f32; sub.w * sub.h];
            for j in j0..=j1 {
                for i in i0..=i1 {
                    sz[(j - j0) as usize * sub.w + (i - i0) as usize] = hz[idx(g, i, j)];
                }
            }
            let (dtm, _) = smrf(&sub, &sz, prm);
            for q in &posts {
                let v = dtm[(q.j - j0) as usize * sub.w + (q.i - i0) as usize];
                if fin(v) {
                    hz[q.k] = v;
                }
            }
        }
        Op::Recorrelate { patch, ring } => {
            let (posts, _) = posts_in(g, ring, &[]);
            for q in &posts {
                let (lat, lon) = (lat_of(g, q.j), lon_of(g, q.i));
                let fx = (lon - patch.lon0) / patch.dlon;
                let fy = (patch.lat0 - lat) / patch.dlat;
                let (x0, y0) = (fx.floor(), fy.floor());
                if x0 < 0.0 || y0 < 0.0 || x0 + 1.0 >= patch.nx as f64 || y0 + 1.0 >= patch.ny as f64 {
                    continue;
                }
                let (tx, ty) = (fx - x0, fy - y0);
                let (x0, y0) = (x0 as usize, y0 as usize);
                let at = |x: usize, y: usize| patch.z[y * patch.nx + x] as f64;
                let (a, b, c, d) = (at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1));
                if !(a.is_finite() && b.is_finite() && c.is_finite() && d.is_finite()) {
                    continue;
                }
                let top = a + (b - a) * tx;
                let bot = c + (d - c) * tx;
                hz[q.k] = (top + (bot - top) * ty) as f32;
            }
        }
    }
}

/// SMRF ground filter (Pingel et al. 2013) as `dem-tools.js smrf`: progressive square openings up
/// to `max_window_m`, slope and elevation thresholds, non-ground posts refilled by Gauss–Seidel
/// Laplace iterations from the opened surface. Returns (DTM, ground mask).
pub fn smrf(g: &Geo, hz: &[f32], p: &Smrf) -> (Vec<f32>, Vec<u8>) {
    let (cx, _) = cell_m(g, g.lat0 - (g.h as f64 * g.dlat) / 2.0);
    let (ww, hh) = (g.w, g.h);
    let n = ww * hh;
    let erode = |a: &[f32], r: i64| -> Vec<f32> {
        let mut t = vec![0f32; n];
        let mut o = vec![0f32; n];
        for j in 0..hh {
            for i in 0..ww as i64 {
                let mut m = f64::INFINITY;
                for d in -r..=r {
                    let ii = i + d;
                    if ii >= 0 && ii < ww as i64 {
                        let v = a[j * ww + ii as usize];
                        if v.is_finite() && (v as f64) < m {
                            m = v as f64;
                        }
                    }
                }
                t[j * ww + i as usize] = if m == f64::INFINITY { f32::NAN } else { m as f32 };
            }
        }
        for j in 0..hh as i64 {
            for i in 0..ww {
                let mut m = f64::INFINITY;
                for d in -r..=r {
                    let jj = j + d;
                    if jj >= 0 && jj < hh as i64 {
                        let v = t[jj as usize * ww + i];
                        if v.is_finite() && (v as f64) < m {
                            m = v as f64;
                        }
                    }
                }
                o[j as usize * ww + i] = if m == f64::INFINITY { f32::NAN } else { m as f32 };
            }
        }
        o
    };
    let dilate = |a: &[f32], r: i64| -> Vec<f32> {
        let neg: Vec<f32> = a.iter().map(|v| -v).collect();
        erode(&neg, r).iter().map(|v| -v).collect()
    };
    let mut surf = hz.to_vec();
    let mut object = vec![0u8; n];
    let max_r = (jround(p.max_window_m / cx / 2.0).max(1.0) as i64).min(ww.max(hh) as i64);
    for r in 1..=max_r {
        let opened = dilate(&erode(&surf, r), r);
        let thr = p.slope * r as f64 * cx * 2.0;
        for k in 0..n {
            if surf[k].is_finite() && (surf[k] as f64 - opened[k] as f64) > thr {
                object[k] = 1;
            }
        }
        surf = opened;
    }
    let mut ground = vec![0u8; n];
    if ww >= 3 && hh >= 3 {
        for j in 1..hh - 1 {
            for i in 1..ww - 1 {
                let k = j * ww + i;
                if !hz[k].is_finite() || !surf[k].is_finite() {
                    continue;
                }
                let gx = (surf[k + 1] as f64 - surf[k - 1] as f64) / (2.0 * cx);
                let gy = (surf[k + ww] as f64 - surf[k - ww] as f64) / (2.0 * cx);
                let s = gx.hypot(gy);
                ground[k] = (object[k] == 0 && (hz[k] as f64 - surf[k] as f64).abs() <= p.height + p.scale * s * cx) as u8;
            }
        }
    }
    let mut dtm = vec![0f32; n];
    for k in 0..n {
        dtm[k] = if ground[k] != 0 { hz[k] } else if surf[k].is_finite() { surf[k] } else { f32::NAN };
    }
    let free: Vec<usize> = (0..n).filter(|&k| ground[k] == 0 && dtm[k].is_finite()).collect();
    for _ in 0..200 {
        let mut ch = 0f64;
        for &k in &free {
            let (i, j) = (k % ww, k / ww);
            let (mut s, mut c) = (0f64, 0f64);
            let nb = [if i > 0 { Some(k - 1) } else { None }, if i < ww - 1 { Some(k + 1) } else { None }, if j > 0 { Some(k - ww) } else { None }, if j < hh - 1 { Some(k + ww) } else { None }];
            for kk in nb.into_iter().flatten() {
                if dtm[kk].is_finite() {
                    s += dtm[kk] as f64;
                    c += 1.0;
                }
            }
            if c == 0.0 {
                continue;
            }
            let v = s / c;
            ch = ch.max((v - dtm[k] as f64).abs());
            dtm[k] = v as f32;
        }
        if ch < 1e-3 {
            break;
        }
    }
    (dtm, ground)
}

/// Parse the flat edit encoding: `[count, (code, params…)…]`; a ring is `n, n × (lon, lat)`.
/// See `encodeEdits` in dem-tools.js.
pub fn parse(a: &[f64]) -> Result<Vec<Op>, &'static str> {
    let mut o = 0usize;
    let get = |o: &mut usize| -> Result<f64, &'static str> {
        let v = *a.get(*o).ok_or("dem edit: truncated edit list")?;
        *o += 1;
        Ok(v)
    };
    let count = |v: f64, max: usize| -> Result<usize, &'static str> {
        if !(v >= 0.0) || v > max as f64 {
            Err("dem edit: bad length in the edit list")
        } else {
            Ok(v as usize)
        }
    };
    let ring = |o: &mut usize| -> Result<Ring, &'static str> {
        let n = count(get(o)?, 1 << 20)?;
        let mut r = Vec::with_capacity(n);
        for _ in 0..n {
            r.push([get(o)?, get(o)?]);
        }
        Ok(r)
    };
    let n = count(get(&mut o)?, 1 << 20)?;
    let mut ops = Vec::with_capacity(n);
    for _ in 0..n {
        let code = get(&mut o)? as i32;
        ops.push(match code {
            1 => Op::Post { lat: get(&mut o)?, lon: get(&mut o)?, h: get(&mut o)? },
            2 => Op::Raise { dh: get(&mut o)?, feather: get(&mut o)?, ring: ring(&mut o)? },
            3 => Op::Flatten { h: get(&mut o)?, ring: ring(&mut o)? },
            4 => Op::Plane { ring: ring(&mut o)? },
            5 => {
                let level = get(&mut o)?;
                let r = ring(&mut o)?;
                let nh = count(get(&mut o)?, 1 << 16)?;
                let mut holes = Vec::with_capacity(nh);
                for _ in 0..nh {
                    holes.push(ring(&mut o)?);
                }
                Op::Lake { level, ring: r, holes }
            }
            6 => Op::Smooth { radius: get(&mut o)?, ring: ring(&mut o)? },
            7 => Op::Interpolate { ring: ring(&mut o)? },
            8 => {
                let threshold = get(&mut o)?;
                let has = get(&mut o)? != 0.0;
                Op::Despike { threshold, ring: if has { Some(ring(&mut o)?) } else { None } }
            }
            9 => {
                let width = get(&mut o)?;
                let n = count(get(&mut o)?, 1 << 20)?;
                let mut line = Vec::with_capacity(n);
                for _ in 0..n {
                    line.push([get(&mut o)?, get(&mut o)?, get(&mut o)?]);
                }
                Op::Breakline { width, line }
            }
            10 => {
                let smrf = Smrf { max_window_m: get(&mut o)?, slope: get(&mut o)?, height: get(&mut o)?, scale: get(&mut o)? };
                Op::BareEarth { smrf, ring: ring(&mut o)? }
            }
            11 => {
                let (lat0, lon0, dlat, dlon) = (get(&mut o)?, get(&mut o)?, get(&mut o)?, get(&mut o)?);
                let (nx, ny) = (count(get(&mut o)?, 1 << 14)?, count(get(&mut o)?, 1 << 14)?);
                let r = ring(&mut o)?;
                let mut z = Vec::with_capacity(nx * ny);
                for _ in 0..nx * ny {
                    z.push(get(&mut o)? as f32);
                }
                Op::Recorrelate { patch: Patch { lat0, lon0, dlat, dlon, nx, ny, z }, ring: r }
            }
            _ => return Err("dem edit: unknown edit code"),
        });
    }
    Ok(ops)
}

/// Replay an edit list over a copy of the source heights.
pub fn replay(g: &Geo, src: &[f32], ops: &[Op]) -> Vec<f32> {
    let mut hz = src.to_vec();
    for op in ops {
        apply(g, &mut hz, op);
    }
    hz
}

/// Block status (REQ-GAP-37): per 256² post block, the posts, voids, edited posts and the edited
/// height range. Returns rows `[tx, ty, posts, voids, edited, maxAbsChange]`.
pub fn blocks(g: &Geo, src: &[f32], cur: &[f32], tile: usize) -> Vec<[f64; 6]> {
    let mut out = Vec::new();
    let (nx, ny) = (g.w.div_ceil(tile), g.h.div_ceil(tile));
    for ty in 0..ny {
        for tx in 0..nx {
            let (mut posts, mut voids, mut edited, mut dmax) = (0usize, 0usize, 0usize, 0f64);
            for y in ty * tile..((ty + 1) * tile).min(g.h) {
                for x in tx * tile..((tx + 1) * tile).min(g.w) {
                    let k = y * g.w + x;
                    posts += 1;
                    let (a, b) = (src[k], cur[k]);
                    if !b.is_finite() {
                        voids += 1;
                    }
                    if a != b && !(a.is_nan() && b.is_nan()) {
                        edited += 1;
                        let d = (b as f64 - a as f64).abs();
                        if d.is_finite() && d > dmax {
                            dmax = d;
                        }
                    }
                }
            }
            out.push([tx as f64, ty as f64, posts as f64, voids as f64, edited as f64, dmax]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(w: usize, h: usize) -> (Geo, Vec<f32>) {
        let g = Geo { w, h, lat0: 34.51, lon0: -116.51, dlat: 1.0 / 3600.0, dlon: 1.0 / 3600.0 };
        let mut z = vec![0f32; w * h];
        for j in 0..h {
            for i in 0..w {
                z[j * w + i] = (100.0 + 0.5 * i as f64 + 0.25 * j as f64 + 3.0 * ((i as f64) * 0.2).sin()) as f32;
            }
        }
        (g, z)
    }

    fn square(g: &Geo, i0: f64, j0: f64, i1: f64, j1: f64) -> Ring {
        let ll = |i: f64, j: f64| [g.lon0 + i * g.dlon, g.lat0 - j * g.dlat];
        vec![ll(i0, j0), ll(i1, j0), ll(i1, j1), ll(i0, j1)]
    }

    #[test]
    fn plane_flatten_lake_and_post() {
        let (g, z) = grid(60, 50);
        let r = square(&g, 10.3, 10.3, 30.7, 25.7);
        let h = replay(&g, &z, &[Op::Plane { ring: r.clone() }]);
        // A plane in (i, j) has zero second differences inside.
        let k = 18 * 60 + 20;
        assert!((h[k - 1] as f64 + h[k + 1] as f64 - 2.0 * h[k] as f64).abs() < 1e-3);
        let h = replay(&g, &z, &[Op::Flatten { h: 120.0, ring: r.clone() }]);
        assert_eq!(h[k], 120.0);
        let h = replay(&g, &z, &[Op::Lake { level: f64::NAN, ring: r.clone(), holes: vec![] }]);
        let lv = h[k];
        assert!(lv < z[k]);
        assert_eq!(h[15 * 60 + 25], lv);
        let h = replay(&g, &z, &[Op::Post { lat: g.lat0 - 5.0 * g.dlat, lon: g.lon0 + 7.0 * g.dlon, h: 900.0 }, Op::Despike { threshold: 5.0, ring: None }]);
        assert!((h[5 * 60 + 7] - z[5 * 60 + 7]).abs() < 4.0);
    }

    #[test]
    fn bare_earth_removes_a_box_and_keeps_the_ground() {
        // About 3 m posts: a 6 × 6 post (about 17 m) building, under the 30 m window.
        let (mut g, mut z) = grid(80, 80);
        g.dlat = 1.0 / 36000.0;
        g.dlon = 1.0 / 36000.0;
        let base = z.clone();
        for j in 30..36 {
            for i in 30..36 {
                z[j * 80 + i] += 12.0;
            }
        }
        let r = square(&g, 25.0, 25.0, 47.0, 45.0);
        let h = replay(&g, &z, &[Op::BareEarth { smrf: Smrf::default(), ring: r }]);
        let mut worst = 0f64;
        for j in 30..36 {
            for i in 30..36 {
                worst = worst.max((h[j * 80 + i] - base[j * 80 + i]).abs() as f64);
            }
        }
        assert!(worst < 2.0, "{worst}");
        // Outside the ring nothing changes.
        assert_eq!(h[5 * 80 + 5], z[5 * 80 + 5]);
    }

    #[test]
    fn recorrelate_patch_bilinear_and_blocks() {
        let (g, z) = grid(40, 40);
        let patch = Patch { lat0: g.lat0, lon0: g.lon0, dlat: g.dlat * 2.0, dlon: g.dlon * 2.0, nx: 20, ny: 20, z: (0..400).map(|k| (k % 20) as f32).collect() };
        let r = square(&g, 5.0, 5.0, 15.0, 15.0);
        let h = replay(&g, &z, &[Op::Recorrelate { patch, ring: r }]);
        // Post (9, 10) is at patch x = 4.5 → 4.5.
        assert!((h[10 * 40 + 9] - 4.5).abs() < 1e-6);
        let b = blocks(&g, &z, &h, 16);
        assert_eq!(b.len(), 9);
        assert!(b[0][4] > 0.0 && b[8][4] == 0.0);
    }

    #[test]
    fn parse_round_trip_and_refusals() {
        let a = [2.0, 1.0, 34.5, -116.5, 10.0, 3.0, 5.0, 3.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0];
        let ops = parse(&a).unwrap();
        assert_eq!(ops.len(), 2);
        assert!(parse(&[1.0, 99.0]).is_err());
        assert!(parse(&[3.0, 1.0, 0.0]).is_err());
        assert!(parse(&[1.0, 3.0, 5.0, -1.0]).is_err());
    }
}
