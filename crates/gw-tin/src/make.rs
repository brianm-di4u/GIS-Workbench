//! Building a TIN (REQ-GAP-39): from scattered points (LiDAR ground, imported mass points), from
//! DEM posts thinned to a vertical tolerance (greedy insertion: the post farthest from the TIN
//! goes in next, until every post is within the tolerance), and TIN → grid by linear
//! interpolation in each triangle.

use crate::mesh::{hilbert_order, Fail, Loc, Map, Mesh, Res, DRAIN, INF, NONE, RIDGE, T_DEAD, T_EXCL, V_MASS};
use crate::pred::LIM;
use crate::err::Error;
use std::collections::BinaryHeap;

/// Grid posts in the TIN plane: post (i, j) is at x = ax + bx·i, y = ay + by·j.
#[derive(Clone, Copy, Debug)]
pub struct GridSpec {
    pub w: usize,
    pub h: usize,
    pub ax: f64,
    pub ay: f64,
    pub bx: f64,
    pub by: f64,
}

impl GridSpec {
    pub fn valid(&self, zlen: usize) -> bool {
        self.w >= 1 && self.h >= 1 && self.w.checked_mul(self.h) == Some(zlen) && [self.ax, self.ay, self.bx, self.by].iter().all(|v| v.is_finite()) && self.bx != 0.0 && self.by != 0.0
    }
    fn xy(&self, i: usize, j: usize) -> (f64, f64) {
        (self.ax + self.bx * i as f64, self.ay + self.by * j as f64)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub input: usize,
    pub vertices: usize,
    pub duplicates: u64,
    pub max_error: f64,
    pub stopped_at_limit: bool,
}

/// The grid step for an extent: 1 mm while the extent fits, else refused.
fn origin_for(x0: f64, y0: f64, x1: f64, y1: f64, q: f64) -> Res<(f64, f64)> {
    if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
        return Err(Fail::Refused(Error::invalid("the points have no finite coordinates")));
    }
    let half = ((x1 - x0).max(y1 - y0)) / 2.0;
    if half / q > (LIM as f64) * 0.98 {
        return Err(Fail::Refused(Error::invalid("the points span more than the TIN's 1000 km")));
    }
    Ok(((x0 + x1) / 2.0, (y0 + y1) / 2.0))
}

/// A TIN through scattered points (x, y, z triples, plane metres). `cell` > 0 keeps one point per
/// cell of that size (the one nearest the cell centre); at most `maxv` points.
pub fn from_points(pts: &[f64], q: f64, cell: f64, maxv: usize) -> Res<(Mesh, Report)> {
    let n = pts.len() / 3;
    let mut keep: Vec<usize> = (0..n).filter(|&k| pts[3 * k].is_finite() && pts[3 * k + 1].is_finite() && pts[3 * k + 2].is_finite()).collect();
    if keep.len() < 3 {
        return Err(Fail::Refused(Error::invalid("a TIN needs three points")));
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for &k in &keep {
        x0 = x0.min(pts[3 * k]);
        y0 = y0.min(pts[3 * k + 1]);
        x1 = x1.max(pts[3 * k]);
        y1 = y1.max(pts[3 * k + 1]);
    }
    if cell > 0.0 && cell.is_finite() {
        let cols = ((x1 - x0) / cell).floor() as u64 + 1;
        let mut best: Map<u64, (f64, usize)> = Map::default();
        for &k in &keep {
            let (cx, cy) = (((pts[3 * k] - x0) / cell).floor(), ((pts[3 * k + 1] - y0) / cell).floor());
            let key = cy as u64 * cols + cx as u64;
            let d = (pts[3 * k] - x0 - (cx + 0.5) * cell).powi(2) + (pts[3 * k + 1] - y0 - (cy + 0.5) * cell).powi(2);
            let e = best.entry(key).or_insert((f64::INFINITY, k));
            if d < e.0 || (d == e.0 && k < e.1) {
                *e = (d, k);
            }
        }
        let mut kk: Vec<u64> = best.values().map(|v| v.1 as u64).collect();
        kk.sort_unstable();
        keep = kk.into_iter().map(|k| k as usize).collect();
    }
    if keep.len() > maxv {
        return Err(Fail::Refused(Error::invalid("too many points for one TIN: thin them (a cell size) or take a smaller area")));
    }
    let (ox, oy) = origin_for(x0, y0, x1, y1, q)?;
    let mut m = Mesh::new(q, ox, oy);
    let mut ids = Vec::with_capacity(keep.len());
    let mut grid = Vec::with_capacity(keep.len());
    for &k in &keep {
        let Some((gx, gy)) = m.snap(pts[3 * k], pts[3 * k + 1]) else { return Err(Fail::Refused(Error::invalid("the points span more than the TIN's 1000 km"))) };
        grid.push((gx, gy));
        ids.push(push_vertex(&mut m, gx, gy, pts[3 * k + 2]));
    }
    let order = hilbert_order(&grid);
    let ordered: Vec<u32> = order.iter().map(|&k| ids[k]).collect();
    if !m.start_with(&ordered) {
        return Err(Fail::Refused(Error::invalid("a TIN needs three points that are not on one line")));
    }
    let rep = Report { input: n, vertices: m.alive_vertices(), duplicates: m.stats.duplicates, max_error: 0.0, stopped_at_limit: false };
    Ok((m, rep))
}

fn push_vertex(m: &mut Mesh, gx: i64, gy: i64, z: f64) -> u32 {
    m.x.push(gx);
    m.y.push(gy);
    m.z.push(z);
    m.z0.push(z);
    m.vf.push(V_MASS);
    m.vt.push(NONE);
    m.vl.push(0);
    (m.x.len() - 1) as u32
}

/// Posts of a triangle (grid coordinates of its corners) row by row: f(i, j) for each post inside
/// or on it.
fn scan_tri(g: &GridSpec, c: [(f64, f64); 3], mut f: impl FnMut(usize, usize)) {
    let (mut j0, mut j1) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in c {
        j0 = j0.min(p.1);
        j1 = j1.max(p.1);
    }
    let eps = 1e-9;
    let ja = ((j0 - eps).ceil().max(0.0)) as i64;
    let jb = ((j1 + eps).floor().min(g.h as f64 - 1.0)) as i64;
    if jb < ja {
        return;
    }
    for j in ja..=jb {
        let fj = j as f64;
        let (mut i0, mut i1) = (f64::INFINITY, f64::NEG_INFINITY);
        for e in 0..3 {
            let (p, q) = (c[e], c[(e + 1) % 3]);
            let (lo, hi) = if p.1 <= q.1 { (p, q) } else { (q, p) };
            if fj < lo.1 - eps || fj > hi.1 + eps {
                continue;
            }
            if (hi.1 - lo.1).abs() < 1e-12 {
                i0 = i0.min(lo.0.min(hi.0));
                i1 = i1.max(lo.0.max(hi.0));
            } else {
                let s = ((fj - lo.1) / (hi.1 - lo.1)).clamp(0.0, 1.0);
                let fi = lo.0 + (hi.0 - lo.0) * s;
                i0 = i0.min(fi);
                i1 = i1.max(fi);
            }
        }
        if !i0.is_finite() {
            continue;
        }
        let ia = ((i0 - eps).ceil().max(0.0)) as i64;
        let ib = ((i1 + eps).floor().min(g.w as f64 - 1.0)) as i64;
        for i in ia..=ib {
            f(i as usize, j as usize);
        }
    }
}

/// Grid coordinates of triangle t's corners and its height as a plane in grid coordinates
/// (z = p0 + p1·i + p2·j), or None for a degenerate one.
fn tri_grid(m: &Mesh, g: &GridSpec, t: u32) -> Option<([(f64, f64); 3], [f64; 3])> {
    let v = m.tv[t as usize];
    let mut c = [(0.0, 0.0); 3];
    let mut z = [0.0; 3];
    for k in 0..3 {
        c[k] = ((m.px(v[k]) - g.ax) / g.bx, (m.py(v[k]) - g.ay) / g.by);
        z[k] = m.z[v[k] as usize];
    }
    let det = (c[1].0 - c[0].0) * (c[2].1 - c[0].1) - (c[2].0 - c[0].0) * (c[1].1 - c[0].1);
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let a = ((z[1] - z[0]) * (c[2].1 - c[0].1) - (z[2] - z[0]) * (c[1].1 - c[0].1)) / det;
    let b = ((z[2] - z[0]) * (c[1].0 - c[0].0) - (z[1] - z[0]) * (c[2].0 - c[0].0)) / det;
    Some((c, [z[0] - a * c[0].0 - b * c[0].1, a, b]))
}

/// The worst post of triangle t: (|error|, post index), skipping posts already in the TIN.
fn worst(m: &Mesh, g: &GridSpec, z: &[f32], used: &[u64], t: u32) -> (f64, usize) {
    let Some((c, p)) = tri_grid(m, g, t) else { return (0.0, usize::MAX) };
    let mut best = (0.0, usize::MAX);
    scan_tri(g, c, |i, j| {
        let k = j * g.w + i;
        if used[k >> 6] & (1 << (k & 63)) != 0 {
            return;
        }
        let zk = z[k];
        if !zk.is_finite() {
            return;
        }
        let e = (zk as f64 - (p[0] + p[1] * i as f64 + p[2] * j as f64)).abs();
        if e > best.0 || (e == best.0 && k < best.1) {
            best = (e, k);
        }
    });
    best
}

/// A TIN from DEM posts. `tol` < 0 takes every valid post; otherwise posts are added greedily
/// until every valid post is within `tol` metres of the TIN (or `maxv` vertices).
pub fn from_dem(g: &GridSpec, z: &[f32], tol: f64, maxv: usize, q: f64, mut progress: impl FnMut(usize, f64)) -> Res<(Mesh, Report)> {
    if !g.valid(z.len()) {
        return Err(Fail::Refused(Error::invalid("the grid does not match the heights")));
    }
    let valid = z.iter().filter(|v| v.is_finite()).count();
    if valid < 3 {
        return Err(Fail::Refused(Error::invalid("a TIN needs three points")));
    }
    // Hull of the valid posts (from each row's first and last valid post), on the lattice.
    let mut ext = Vec::new();
    for j in 0..g.h {
        let row = &z[j * g.w..(j + 1) * g.w];
        if let Some(a) = row.iter().position(|v| v.is_finite()) {
            let b = row.iter().rposition(|v| v.is_finite()).unwrap_or(a);
            ext.push((a as i64, j as i64));
            if b != a {
                ext.push((b as i64, j as i64));
            }
        }
    }
    let hull = lattice_hull(&mut ext);
    let corners = [g.xy(0, 0), g.xy(g.w - 1, 0), g.xy(0, g.h - 1), g.xy(g.w - 1, g.h - 1)];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (x, y) in corners {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let (ox, oy) = origin_for(x0, y0, x1, y1, q)?;
    let mut m = Mesh::new(q, ox, oy);
    let words = (g.w * g.h).div_ceil(64);
    let mut used = vec![0u64; words];
    let mark = |used: &mut Vec<u64>, k: usize| used[k >> 6] |= 1 << (k & 63);
    // Every valid post on the hull's lattice lines: the TIN covers every valid post.
    let mut boundary: Vec<usize> = Vec::new();
    let nh = hull.len();
    for k in 0..nh {
        let (a, b) = (hull[k], hull[(k + 1) % nh]);
        let (di, dj) = (b.0 - a.0, b.1 - a.1);
        let s = gcd(di.unsigned_abs(), dj.unsigned_abs()).max(1) as i64;
        for t in 0..s {
            let (i, j) = (a.0 + di / s * t, a.1 + dj / s * t);
            let kk = j as usize * g.w + i as usize;
            if z[kk].is_finite() {
                boundary.push(kk);
            }
        }
    }
    if nh < 3 {
        // All valid posts on one lattice line: no TIN.
        return Err(Fail::Refused(Error::invalid("a TIN needs three points that are not on one line")));
    }
    let mut ids = Vec::new();
    for &k in &boundary {
        if used[k >> 6] & (1 << (k & 63)) != 0 {
            continue;
        }
        mark(&mut used, k);
        let (x, y) = g.xy(k % g.w, k / g.w);
        let (gx, gy) = m.snap(x, y).ok_or_else(|| Fail::Refused(Error::invalid("the points span more than the TIN's 1000 km")))?;
        ids.push(push_vertex(&mut m, gx, gy, z[k] as f64));
    }
    if !m.start_with(&ids) {
        return Err(Fail::Refused(Error::invalid("a TIN needs three points that are not on one line")));
    }
    let insert_post = |m: &mut Mesh, k: usize| {
        let (x, y) = g.xy(k % g.w, k / g.w);
        if let Some((gx, gy)) = m.snap(x, y) {
            let _ = m.insert(gx, gy, z[k] as f64, V_MASS);
        }
    };
    if tol < 0.0 {
        // Every post, row by row in a serpentine (each next post is a neighbour: short walks).
        let mut n = 0usize;
        for j in 0..g.h {
            for ii in 0..g.w {
                let i = if j % 2 == 0 { ii } else { g.w - 1 - ii };
                let k = j * g.w + i;
                if !z[k].is_finite() || used[k >> 6] & (1 << (k & 63)) != 0 {
                    continue;
                }
                mark(&mut used, k);
                if m.alive_count_hint() >= maxv {
                    return Err(Fail::Refused(Error::invalid("too many points for one TIN: thin them (a vertical tolerance) or take a smaller area")));
                }
                insert_post(&mut m, k);
                n += 1;
                if n % 65536 == 0 {
                    progress(n, f64::NAN);
                }
            }
        }
        let rep = Report { input: valid, vertices: m.alive_vertices(), duplicates: m.stats.duplicates, max_error: 0.0, stopped_at_limit: false };
        return Ok((m, rep));
    }
    // Greedy insertion.
    let mut stamp: Vec<u32> = vec![0; m.tv.len()];
    let mut heap: BinaryHeap<(u64, u32, u32, usize)> = BinaryHeap::new();
    let push = |m: &Mesh, used: &Vec<u64>, heap: &mut BinaryHeap<(u64, u32, u32, usize)>, stamp: &Vec<u32>, t: u32| {
        let (e, k) = worst(m, g, z, used, t);
        if k != usize::MAX {
            heap.push((e.to_bits(), t, stamp[t as usize], k));
        }
    };
    let tris: Vec<u32> = m.triangles().collect();
    for t in tris {
        push(&m, &used, &mut heap, &stamp, t);
    }
    let mut n = 0usize;
    let mut max_err = 0.0;
    let mut limited = false;
    m.touched = Some(Vec::new());
    while let Some((eb, t, s, k)) = heap.pop() {
        if (t as usize) < stamp.len() && stamp[t as usize] != s {
            continue;
        }
        let e = f64::from_bits(eb);
        if e <= tol {
            max_err = e;
            break;
        }
        if m.alive_count_hint() >= maxv {
            max_err = e;
            limited = true;
            break;
        }
        mark(&mut used, k);
        insert_post(&mut m, k);
        n += 1;
        if n % 16384 == 0 {
            progress(n, e);
        }
        let mut changed = m.touched.replace(Vec::new()).unwrap_or_default();
        if changed.is_empty() {
            // The post snapped onto an existing vertex: look at the rest of its triangle again.
            changed.push(t);
        }
        let mut ck: Vec<u64> = changed.iter().map(|&c| c as u64).collect();
        ck.sort_unstable();
        ck.dedup();
        changed = ck.into_iter().map(|c| c as u32).collect();
        if stamp.len() < m.tv.len() {
            stamp.resize(m.tv.len(), 0);
        }
        for &c in &changed {
            stamp[c as usize] = stamp[c as usize].wrapping_add(1);
        }
        for &c in &changed {
            if m.tf[c as usize] & T_DEAD == 0 && !m.tv[c as usize].contains(&INF) {
                push(&m, &used, &mut heap, &stamp, c);
            }
        }
    }
    m.touched = None;
    let rep = Report { input: valid, vertices: m.alive_vertices(), duplicates: m.stats.duplicates, max_error: max_err, stopped_at_limit: limited };
    Ok((m, rep))
}

impl Mesh {
    /// Vertices so far (an upper bound: dead duplicates count too).
    pub fn alive_count_hint(&self) -> usize {
        self.x.len()
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

/// Convex hull of lattice points (counter-clockwise, no collinear vertices).
fn lattice_hull(p: &mut Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    // Sort as u64 keys (both coordinates are post indices < 2^31).
    let mut k: Vec<u64> = p.iter().map(|&(i, j)| ((i as u64) << 32) | j as u64).collect();
    k.sort_unstable();
    k.dedup();
    *p = k.into_iter().map(|v| ((v >> 32) as i64, (v & 0xffff_ffff) as i64)).collect();
    if p.len() < 3 {
        return p.clone();
    }
    let cross = |o: (i64, i64), a: (i64, i64), b: (i64, i64)| (a.0 - o.0) as i128 * (b.1 - o.1) as i128 - (a.1 - o.1) as i128 * (b.0 - o.0) as i128;
    let mut h: Vec<(i64, i64)> = Vec::with_capacity(2 * p.len());
    for &q in p.iter() {
        while h.len() >= 2 && cross(h[h.len() - 2], h[h.len() - 1], q) <= 0 {
            h.pop();
        }
        h.push(q);
    }
    let lo = h.len() + 1;
    for &q in p.iter().rev().skip(1) {
        while h.len() >= lo && cross(h[h.len() - 2], h[h.len() - 1], q) <= 0 {
            h.pop();
        }
        h.push(q);
    }
    h.pop();
    h
}

/// TIN → grid: each post inside a (not excluded) triangle gets the triangle's linear height;
/// posts outside the TIN are NaN.
pub fn rasterize(m: &mut Mesh, g: &GridSpec) -> Vec<f32> {
    m.classify();
    let mut out = vec![f32::NAN; g.w * g.h];
    let tris: Vec<u32> = m.triangles().collect();
    for t in tris {
        if m.tf[t as usize] & T_EXCL != 0 {
            continue;
        }
        let Some((c, p)) = tri_grid(m, g, t) else { continue };
        scan_tri(g, c, |i, j| {
            if inside(c, i as f64, j as f64) {
                out[j * g.w + i] = (p[0] + p[1] * i as f64 + p[2] * j as f64) as f32;
            }
        });
    }
    out
}

/// Is grid point (i, j) inside or on the triangle (barycentric, with a small tolerance)?
fn inside(c: [(f64, f64); 3], i: f64, j: f64) -> bool {
    let d = (c[1].0 - c[0].0) * (c[2].1 - c[0].1) - (c[2].0 - c[0].0) * (c[1].1 - c[0].1);
    let s = ((i - c[0].0) * (c[2].1 - c[0].1) - (c[2].0 - c[0].0) * (j - c[0].1)) / d;
    let t = ((c[1].0 - c[0].0) * (j - c[0].1) - (i - c[0].0) * (c[1].1 - c[0].1)) / d;
    let e = 1e-9;
    s >= -e && t >= -e && s + t <= 1.0 + e
}

/// Ridge and drain profiles (REQ-GAP-39): the line is put in densified (a vertex at every edge it
/// crosses, so its profile is the surface's), oriented to run downhill (start higher than end),
/// then made non-increasing along it: a drain by cutting (running minimum from the start), a
/// ridge by filling (running maximum from the end). The line stays as a hard line, so the surface
/// along it is linear between its vertices and therefore monotone. A vertex holds one height, so
/// where a profile crosses an earlier ridge or drain the later one sets it: `conflicts` counts the
/// vertices of other ridges and drains it changed (that line may no longer fall through them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Profile {
    pub vertices: usize,
    pub changed: usize,
    pub max_change: f64,
    pub conflicts: usize,
    pub reversed: bool,
    pub start: f64,
    pub end: f64,
}

pub fn enforce(z: &mut [f64], ridge: bool) {
    if ridge {
        for k in (0..z.len().saturating_sub(1)).rev() {
            if z[k] < z[k + 1] {
                z[k] = z[k + 1];
            }
        }
    } else {
        for k in 1..z.len() {
            if z[k] > z[k - 1] {
                z[k] = z[k - 1];
            }
        }
    }
}

/// Apply a ridge (true) or drain profile to line l (inserted densified), in place.
pub fn profile(m: &mut Mesh, l: u32, ridge: bool) -> Profile {
    let path = m.lines[l as usize].path.clone();
    let mut z: Vec<f64> = path.iter().map(|&v| m.z[v as usize]).collect();
    let before = z.clone();
    enforce(&mut z, ridge);
    let mut others: Vec<u64> = m.lines.iter().enumerate().filter(|(i, n)| *i != l as usize && n.alive && (n.kind == DRAIN || n.kind == RIDGE)).flat_map(|(_, n)| n.path.iter().map(|&v| v as u64)).collect();
    others.sort_unstable();
    let mut rep = Profile { vertices: path.len(), reversed: false, start: z.first().copied().unwrap_or(f64::NAN), end: z.last().copied().unwrap_or(f64::NAN), ..Default::default() };
    for (k, &v) in path.iter().enumerate() {
        let d = (z[k] - before[k]).abs();
        if d > 0.0 {
            rep.changed += 1;
            rep.max_change = rep.max_change.max(d);
            if others.binary_search(&(v as u64)).is_ok() {
                rep.conflicts += 1;
            }
            m.z[v as usize] = z[k];
        }
    }
    rep
}

/// Ensure a located point is inside the surface (not outside the hull).
pub fn on_surface(loc: Loc) -> bool {
    !matches!(loc, Loc::Out(_))
}
