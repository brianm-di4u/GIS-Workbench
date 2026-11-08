//! Constrained Delaunay triangulation (REQ-GAP-39): incremental insertion with Lawson flips,
//! constraint segments by Sloan's flip method, vertex removal by ear flips, exact integer
//! predicates (`pred`). Triangles are counter-clockwise; edge i of a triangle is the edge
//! opposite its vertex i, and `tn[t][i]` is the triangle across it. The convex hull is closed by
//! ghost triangles through the infinite vertex `INF`: a ghost (u, w, INF) has the outside of the
//! hull to the left of u → w.
//!
//! Lines (breaklines, exclusion and boundary rings, edge swaps) are kept as vertex paths. An edge
//! is constrained while at least one line uses it (`cons`), so a line can be removed again, and a
//! vertex inserted on a constrained edge joins the path of every line on it.

use crate::pred::{incircle, orient, LIM};
use crate::err::{Error, Msg};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

pub const INF: u32 = u32::MAX;
pub const NONE: u32 = u32::MAX;

// Vertex flags.
pub const V_MASS: u8 = 1; // a mass point (source or edit)
pub const V_LINE: u8 = 2; // created for a line
pub const V_STEINER: u8 = 4; // where two lines cross
pub const V_DEAD: u8 = 8;

// Edge flags (te).
pub const E_CONS: u8 = 1;
pub const E_REGION: u8 = 2;
// Triangle flags (tf).
pub const T_DEAD: u8 = 1;
pub const T_EXCL: u8 = 2;

/// Line kinds.
pub const HARD: u8 = 1;
pub const SOFT: u8 = 2;
pub const VOID: u8 = 3;
pub const OUTER: u8 = 4;
pub const SWAP: u8 = 5;
pub const DRAIN: u8 = 6;
pub const RIDGE: u8 = 7;
/// A ring of a file's own faces (`faces`): the outline or a hole of the faces it keeps. Inside an
/// odd number of them is surface; anything else is excluded when there are any.
pub const FRING: u8 = 8;

pub fn is_region(kind: u8) -> bool {
    kind == VOID || kind == OUTER || kind == FRING
}
/// Lines that carry their own heights (a hard breakline, a ridge or a drain).
pub fn carries_z(kind: u8) -> bool {
    kind == HARD || kind == DRAIN || kind == RIDGE
}

/// FNV-style hasher for edge keys (small and fast in WASM).
#[derive(Default)]
pub struct KeyHasher(u64);
impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, b: &[u8]) {
        for &x in b {
            self.0 = (self.0 ^ x as u64).wrapping_mul(0x100_0000_01b3);
        }
    }
    fn write_u64(&mut self, v: u64) {
        self.0 = (v ^ (v >> 29)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        self.0 ^= self.0 >> 32;
    }
}
pub type Map<K, V> = HashMap<K, V, BuildHasherDefault<KeyHasher>>;

#[inline]
pub fn ekey(a: u32, b: u32) -> u64 {
    let (a, b) = if a < b { (a, b) } else { (b, a) };
    ((a as u64) << 32) | b as u64
}

#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub key: u64,
    pub kind: u8,
    pub closed: bool,
    /// The vertices the line was given (after snapping to existing ones).
    pub defs: Vec<u32>,
    /// Every vertex along it, in order (defining, collinear, crossing and station vertices).
    pub path: Vec<u32>,
    pub alive: bool,
}

/// Where a point is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Loc {
    Tri(u32),
    Edge(u32, usize),
    Vert(u32),
    Out(u32),
}

/// What a failed operation needs.
#[derive(Clone, Debug, PartialEq)]
pub enum Fail {
    /// Refused before anything changed.
    Refused(Msg),
    /// The operation stopped part way: the TIN must be rebuilt from its log.
    Broken(Msg),
}

pub type Res<T> = Result<T, Fail>;

#[derive(Default)]
pub struct Mesh {
    /// Grid step (metres) and the plane coordinates of grid point (0, 0).
    pub q: f64,
    pub ox: f64,
    pub oy: f64,
    pub x: Vec<i64>,
    pub y: Vec<i64>,
    pub z: Vec<f64>,
    /// The height a mass point had before a line changed it (NaN for line vertices).
    pub z0: Vec<f64>,
    pub vf: Vec<u8>,
    pub vt: Vec<u32>,
    /// Number of line path entries on each vertex.
    pub vl: Vec<u32>,
    pub tv: Vec<[u32; 3]>,
    pub tn: Vec<[u32; 3]>,
    pub te: Vec<[u8; 3]>,
    pub tf: Vec<u8>,
    pub free: Vec<u32>,
    pub lines: Vec<Line>,
    pub by_key: Map<u64, u32>,
    pub cons: Map<u64, Vec<u32>>,
    pub hint: u32,
    pub rng: u64,
    /// Triangles created or changed since `touched` was set (greedy thinning).
    pub touched: Option<Vec<u32>>,
    /// Exclusion must be recomputed.
    pub dirty: bool,
    pub nreal: usize,
    pub stats: Stats,
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct Stats {
    pub duplicates: u64,
    pub flips: u64,
    pub steiner: u64,
    pub snapped: u64,
    pub rebuilds: u64,
}

impl Mesh {
    /// An empty mesh on a grid of `q` metres with origin (ox, oy).
    pub fn new(q: f64, ox: f64, oy: f64) -> Mesh {
        Mesh { q, ox, oy, hint: NONE, rng: 0x9e37_79b9_7f4a_7c15, ..Default::default() }
    }

    // ---- coordinates ----
    /// Plane metres → grid steps, or None when outside the grid range.
    pub fn snap(&self, x: f64, y: f64) -> Option<(i64, i64)> {
        let gx = ((x - self.ox) / self.q).round();
        let gy = ((y - self.oy) / self.q).round();
        if !(gx.abs() <= LIM as f64 && gy.abs() <= LIM as f64) {
            return None;
        }
        Some((gx as i64, gy as i64))
    }
    pub fn px(&self, v: u32) -> f64 {
        self.ox + self.x[v as usize] as f64 * self.q
    }
    pub fn py(&self, v: u32) -> f64 {
        self.oy + self.y[v as usize] as f64 * self.q
    }
    pub fn nv(&self) -> usize {
        self.x.len()
    }
    pub fn alive_vertices(&self) -> usize {
        self.vf.iter().filter(|f| *f & V_DEAD == 0).count()
    }

    #[inline]
    fn o3(&self, a: u32, b: u32, c: u32) -> i32 {
        let (a, b, c) = (a as usize, b as usize, c as usize);
        orient(self.x[a], self.y[a], self.x[b], self.y[b], self.x[c], self.y[c])
    }
    #[inline]
    fn op(&self, a: u32, b: u32, px: i64, py: i64) -> i32 {
        let (a, b) = (a as usize, b as usize);
        orient(self.x[a], self.y[a], self.x[b], self.y[b], px, py)
    }
    #[inline]
    pub fn is_ghost(&self, t: u32) -> bool {
        self.tv[t as usize].contains(&INF)
    }
    #[inline]
    fn rand3(&mut self) -> usize {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng % 3) as usize
    }

    /// Is q inside the circumcircle of t (a ghost's is the open half-plane outside its hull edge)?
    fn in_circle(&self, t: u32, q: u32) -> bool {
        if q == INF {
            return false;
        }
        let v = self.tv[t as usize];
        match v.iter().position(|&w| w == INF) {
            None => {
                let (a, b, c, d) = (v[0] as usize, v[1] as usize, v[2] as usize, q as usize);
                incircle(self.x[a], self.y[a], self.x[b], self.y[b], self.x[c], self.y[c], self.x[d], self.y[d]) > 0
            }
            Some(k) => {
                let (u, w) = (v[(k + 1) % 3], v[(k + 2) % 3]);
                let o = self.o3(u, w, q);
                o > 0 || (o == 0 && self.strictly_between(u, w, q))
            }
        }
    }
    fn strictly_between(&self, u: u32, w: u32, q: u32) -> bool {
        let (u, w, q) = (u as usize, w as usize, q as usize);
        let dot = (self.x[q] - self.x[u]) as i128 * (self.x[w] - self.x[u]) as i128 + (self.y[q] - self.y[u]) as i128 * (self.y[w] - self.y[u]) as i128;
        let len = (self.x[w] - self.x[u]) as i128 * (self.x[w] - self.x[u]) as i128 + (self.y[w] - self.y[u]) as i128 * (self.y[w] - self.y[u]) as i128;
        dot > 0 && dot < len
    }

    // ---- storage ----
    fn add_vertex(&mut self, gx: i64, gy: i64, z: f64, flags: u8) -> u32 {
        self.x.push(gx);
        self.y.push(gy);
        self.z.push(z);
        self.z0.push(if flags & V_MASS != 0 { z } else { f64::NAN });
        self.vf.push(flags);
        self.vt.push(NONE);
        self.vl.push(0);
        (self.x.len() - 1) as u32
    }
    fn new_tri(&mut self, v: [u32; 3], n: [u32; 3], e: [u8; 3]) -> u32 {
        if !v.contains(&INF) {
            self.nreal += 1;
        }
        let t = if let Some(t) = self.free.pop() {
            let k = t as usize;
            self.tv[k] = v;
            self.tn[k] = n;
            self.te[k] = e;
            self.tf[k] = 0;
            t
        } else {
            self.tv.push(v);
            self.tn.push(n);
            self.te.push(e);
            self.tf.push(0);
            (self.tv.len() - 1) as u32
        };
        self.touch(t);
        t
    }
    fn kill_tri(&mut self, t: u32) {
        if !self.is_ghost(t) {
            self.nreal -= 1;
        }
        self.tf[t as usize] = T_DEAD;
        self.tv[t as usize] = [INF, INF, INF];
        self.free.push(t);
    }
    /// Replace t's vertices (keeping the real-triangle count right).
    fn set_tri(&mut self, t: u32, v: [u32; 3], n: [u32; 3], e: [u8; 3]) {
        let was = !self.is_ghost(t);
        let k = t as usize;
        self.tv[k] = v;
        self.tn[k] = n;
        self.te[k] = e;
        self.tf[k] &= !T_EXCL;
        let now = !v.contains(&INF);
        if was && !now {
            self.nreal -= 1;
        } else if !was && now {
            self.nreal += 1;
        }
        self.touch(t);
    }
    fn touch(&mut self, t: u32) {
        self.dirty = true;
        if let Some(l) = self.touched.as_mut() {
            l.push(t);
        }
    }
    #[inline]
    fn set_vt(&mut self, v: u32, t: u32) {
        if v != INF {
            self.vt[v as usize] = t;
        }
    }
    /// In triangle nt, the edge (b, a) — the reverse of a's edge (a, b) — now borders `new`.
    fn relink(&mut self, nt: u32, a: u32, b: u32, new: u32) {
        if nt == NONE {
            return;
        }
        let v = self.tv[nt as usize];
        for i in 0..3 {
            if v[(i + 1) % 3] == b && v[(i + 2) % 3] == a {
                self.tn[nt as usize][i] = new;
                return;
            }
        }
    }
    /// Index j in u of the edge shared with t across t's edge i.
    fn twin(&self, t: u32, i: usize) -> (u32, usize) {
        let v = self.tv[t as usize];
        let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
        let u = self.tn[t as usize][i];
        let w = self.tv[u as usize];
        for j in 0..3 {
            if w[(j + 1) % 3] == b && w[(j + 2) % 3] == a {
                return (u, j);
            }
        }
        (u, 0)
    }

    // ---- the first triangle ----
    /// Start the triangulation from three vertices that are not collinear.
    pub fn init3(&mut self, a: u32, b: u32, c: u32) {
        let (a, b, c) = if self.o3(a, b, c) > 0 { (a, b, c) } else { (a, c, b) };
        let t = self.new_tri([a, b, c], [NONE; 3], [0; 3]);
        let g0 = self.new_tri([c, b, INF], [NONE; 3], [0; 3]);
        let g1 = self.new_tri([a, c, INF], [NONE; 3], [0; 3]);
        let g2 = self.new_tri([b, a, INF], [NONE; 3], [0; 3]);
        self.tn[t as usize] = [g0, g1, g2];
        self.tn[g0 as usize] = [g2, g1, t];
        self.tn[g1 as usize] = [g0, g2, t];
        self.tn[g2 as usize] = [g1, g0, t];
        for v in [a, b, c] {
            self.vt[v as usize] = t;
        }
        self.hint = t;
    }
    pub fn ready(&self) -> bool {
        self.nreal > 0
    }

    // ---- point location ----
    fn start(&self) -> u32 {
        if self.hint != NONE && (self.hint as usize) < self.tv.len() && self.tf[self.hint as usize] & T_DEAD == 0 {
            return self.hint;
        }
        (0..self.tv.len() as u32).find(|&t| self.tf[t as usize] & T_DEAD == 0).unwrap_or(NONE)
    }

    /// Locate the grid point (px, py) by a stochastic visibility walk.
    pub fn locate(&mut self, px: i64, py: i64) -> Loc {
        let mut t = self.start();
        let cap = 4 * self.tv.len() + 64;
        for _ in 0..cap {
            let v = self.tv[t as usize];
            if let Some(k) = v.iter().position(|&w| w == INF) {
                let (u, w) = (v[(k + 1) % 3], v[(k + 2) % 3]);
                let o = self.op(u, w, px, py);
                if o > 0 {
                    return Loc::Out(t);
                }
                if o < 0 {
                    t = self.tn[t as usize][k];
                    continue;
                }
                if (self.x[u as usize], self.y[u as usize]) == (px, py) {
                    return Loc::Vert(u);
                }
                if (self.x[w as usize], self.y[w as usize]) == (px, py) {
                    return Loc::Vert(w);
                }
                let (ux, uy, wx, wy) = (self.x[u as usize] as i128, self.y[u as usize] as i128, self.x[w as usize] as i128, self.y[w as usize] as i128);
                let dot = (px as i128 - ux) * (wx - ux) + (py as i128 - uy) * (wy - uy);
                let len = (wx - ux) * (wx - ux) + (wy - uy) * (wy - uy);
                if dot > 0 && dot < len {
                    let r = self.tn[t as usize][k];
                    let rv = self.tv[r as usize];
                    let i = (0..3).find(|&i| rv[i] != u && rv[i] != w).unwrap_or(0);
                    return Loc::Edge(r, i);
                }
                t = if dot <= 0 { self.tn[t as usize][(k + 2) % 3] } else { self.tn[t as usize][(k + 1) % 3] };
                continue;
            }
            let r = self.rand3();
            let mut moved = false;
            let mut zeros = 0u8;
            for e in 0..3 {
                let i = (r + e) % 3;
                let o = self.op(v[(i + 1) % 3], v[(i + 2) % 3], px, py);
                if o < 0 {
                    t = self.tn[t as usize][i];
                    moved = true;
                    break;
                }
                if o == 0 {
                    zeros |= 1 << i;
                }
            }
            if moved {
                continue;
            }
            self.hint = t;
            return match zeros.count_ones() {
                0 => Loc::Tri(t),
                1 => Loc::Edge(t, zeros.trailing_zeros() as usize),
                _ => {
                    let k = (0..3).find(|&k| zeros & (1 << k) == 0).unwrap_or(0);
                    Loc::Vert(v[k])
                }
            };
        }
        self.locate_scan(px, py)
    }

    /// Brute-force location (a walk that did not end: never seen, kept as a guard).
    fn locate_scan(&self, px: i64, py: i64) -> Loc {
        for t in 0..self.tv.len() as u32 {
            if self.tf[t as usize] & T_DEAD != 0 || self.is_ghost(t) {
                continue;
            }
            let v = self.tv[t as usize];
            let o: Vec<i32> = (0..3).map(|i| self.op(v[(i + 1) % 3], v[(i + 2) % 3], px, py)).collect();
            if o.iter().all(|&s| s >= 0) {
                let zeros: Vec<usize> = (0..3).filter(|&i| o[i] == 0).collect();
                return match zeros.len() {
                    0 => Loc::Tri(t),
                    1 => Loc::Edge(t, zeros[0]),
                    _ => Loc::Vert(v[(0..3).find(|k| !zeros.contains(k)).unwrap_or(0)]),
                };
            }
        }
        for t in 0..self.tv.len() as u32 {
            if self.tf[t as usize] & T_DEAD == 0 && self.is_ghost(t) {
                let v = self.tv[t as usize];
                let k = v.iter().position(|&w| w == INF).unwrap_or(0);
                if self.op(v[(k + 1) % 3], v[(k + 2) % 3], px, py) > 0 {
                    return Loc::Out(t);
                }
            }
        }
        Loc::Out(self.start())
    }

    // ---- insertion ----
    /// Insert a vertex at grid point (gx, gy). An existing vertex there is returned as Err(v).
    pub fn insert(&mut self, gx: i64, gy: i64, z: f64, flags: u8) -> Result<u32, u32> {
        let loc = self.locate(gx, gy);
        self.insert_at(loc, gx, gy, z, flags)
    }

    pub fn insert_at(&mut self, loc: Loc, gx: i64, gy: i64, z: f64, flags: u8) -> Result<u32, u32> {
        let mut st = Vec::new();
        let p;
        match loc {
            Loc::Vert(v) => {
                self.stats.duplicates += 1;
                return Err(v);
            }
            Loc::Tri(t) | Loc::Out(t) => {
                p = self.add_vertex(gx, gy, z, flags);
                self.split3(t, p, &mut st);
            }
            Loc::Edge(t, i) => {
                p = self.add_vertex(gx, gy, z, flags);
                self.split_edge(t, i, p, &mut st);
            }
        }
        self.legalize(&mut st);
        Ok(p)
    }

    fn split3(&mut self, t: u32, p: u32, st: &mut Vec<(u32, usize)>) {
        let [a, b, c] = self.tv[t as usize];
        let [na, nb, nc] = self.tn[t as usize];
        let e = self.te[t as usize];
        let t2 = self.new_tri([p, c, a], [nb, NONE, t], [e[1], 0, 0]);
        let t3 = self.new_tri([p, a, b], [nc, t, t2], [e[2], 0, 0]);
        self.tn[t2 as usize][1] = t3;
        self.set_tri(t, [p, b, c], [na, t2, t3], [e[0], 0, 0]);
        self.relink(nb, c, a, t2);
        self.relink(nc, a, b, t3);
        self.vt[p as usize] = t;
        self.set_vt(a, t2);
        self.set_vt(b, t);
        self.set_vt(c, t);
        self.hint = t;
        st.push((t, 0));
        st.push((t2, 0));
        st.push((t3, 0));
    }

    /// Split edge i of t at the new vertex p (on the edge, or close enough that all four new
    /// triangles keep their orientation).
    fn split_edge(&mut self, t: u32, i: usize, p: u32, st: &mut Vec<(u32, usize)>) {
        let (t, i) = if self.tv[t as usize][i] == INF { self.twin(t, i) } else { (t, i) };
        let tv = self.tv[t as usize];
        let (c, a, b) = (tv[i], tv[(i + 1) % 3], tv[(i + 2) % 3]);
        let (u, j) = self.twin(t, i);
        let d = self.tv[u as usize][j];
        let tn = self.tn[t as usize];
        let un = self.tn[u as usize];
        let (x, y) = (tn[(i + 1) % 3], tn[(i + 2) % 3]);
        let (zz, w) = (un[(j + 1) % 3], un[(j + 2) % 3]);
        let te = self.te[t as usize];
        let ue = self.te[u as usize];
        let eab = te[i];
        let (ex, ey, ez, ew) = (te[(i + 1) % 3], te[(i + 2) % 3], ue[(j + 1) % 3], ue[(j + 2) % 3]);
        let bt = self.new_tri([c, p, b], [NONE, x, t], [eab, ex, 0]);
        let dt = self.new_tri([d, p, a], [t, zz, u], [eab, ez, 0]);
        self.set_tri(t, [c, a, p], [dt, bt, y], [eab, 0, ey]);
        self.set_tri(u, [d, b, p], [bt, dt, w], [eab, 0, ew]);
        self.tn[bt as usize][0] = u;
        self.relink(x, b, c, bt);
        self.relink(zz, a, d, dt);
        self.vt[p as usize] = t;
        self.set_vt(a, t);
        self.set_vt(c, t);
        self.set_vt(b, bt);
        self.set_vt(d, u);
        self.hint = t;
        if eab & E_CONS != 0 {
            self.split_cons(a, b, p);
        }
        st.push((t, 2));
        st.push((bt, 1));
        st.push((u, 2));
        st.push((dt, 1));
    }

    /// p now lies on the constrained edge (a, b): its lines pass through p.
    fn split_cons(&mut self, a: u32, b: u32, p: u32) {
        let Some(ls) = self.cons.remove(&ekey(a, b)) else { return };
        for &l in &ls {
            let closed = self.lines[l as usize].closed;
            let path = &mut self.lines[l as usize].path;
            let n = path.len();
            let m = if closed { n } else { n.saturating_sub(1) };
            for k in 0..m {
                let (u, w) = (path[k], path[(k + 1) % n]);
                if (u == a && w == b) || (u == b && w == a) {
                    path.insert(k + 1, p);
                    break;
                }
            }
            self.vl[p as usize] += 1;
        }
        self.cons.insert(ekey(a, p), ls.clone());
        self.cons.insert(ekey(p, b), ls);
    }

    /// Lawson flips around the new vertex: each (t, i) has the new vertex at index i.
    fn legalize(&mut self, st: &mut Vec<(u32, usize)>) {
        while let Some((t, i)) = st.pop() {
            if self.te[t as usize][i] & E_CONS != 0 {
                continue;
            }
            let (u, j) = self.twin(t, i);
            let q = self.tv[u as usize][j];
            if q == INF || !self.in_circle(t, q) {
                continue;
            }
            let (t2, u2) = self.flip(t, i, u, j);
            st.push((t2, 0));
            st.push((u2, 0));
        }
    }

    /// Flip the edge shared by t (apex at i) and u (apex at j). Afterwards t = (p, a, q) and
    /// u = (p, q, b), with p the old apex of t and q that of u.
    fn flip(&mut self, t: u32, i: usize, u: u32, j: usize) -> (u32, u32) {
        let tv = self.tv[t as usize];
        let (p, a, b) = (tv[i], tv[(i + 1) % 3], tv[(i + 2) % 3]);
        let q = self.tv[u as usize][j];
        let tn = self.tn[t as usize];
        let un = self.tn[u as usize];
        let (ta, tb) = (tn[(i + 2) % 3], tn[(i + 1) % 3]);
        let (ua, ub) = (un[(j + 1) % 3], un[(j + 2) % 3]);
        let te = self.te[t as usize];
        let ue = self.te[u as usize];
        let (eta, etb, eua, eub) = (te[(i + 2) % 3], te[(i + 1) % 3], ue[(j + 1) % 3], ue[(j + 2) % 3]);
        self.set_tri(t, [p, a, q], [ua, u, ta], [eua, 0, eta]);
        self.set_tri(u, [p, q, b], [ub, tb, t], [eub, etb, 0]);
        self.relink(ua, a, q, t);
        self.relink(tb, b, p, u);
        self.set_vt(p, t);
        self.set_vt(a, t);
        self.set_vt(q, t);
        self.set_vt(b, u);
        self.stats.flips += 1;
        (t, u)
    }

    /// Flip the edge between t (apex at i) and u (apex at j) (edits: a swapped edge).
    pub fn flip_pub(&mut self, t: u32, i: usize, u: u32, j: usize) {
        self.flip(t, i, u, j);
    }
    /// Lawson-legalise these edges (edits: re-triangulate an area).
    pub fn legalize_pub(&mut self, edges: Vec<(u32, u32)>) {
        self.legalize_edges(edges);
    }

    /// The triangle and index of edge (a, b) directed a → b (a's ccw neighbour is b).
    pub fn find_edge(&self, a: u32, b: u32) -> Option<(u32, usize)> {
        if a == INF {
            return self.find_edge(b, a).and_then(|(t, i)| {
                let (u, j) = self.twin(t, i);
                Some((u, j))
            });
        }
        let start = self.vt[a as usize];
        if start == NONE {
            return None;
        }
        let mut t = start;
        for _ in 0..1 << 20 {
            let v = self.tv[t as usize];
            let k = v.iter().position(|&w| w == a)?;
            if v[(k + 1) % 3] == b {
                return Some((t, (k + 2) % 3));
            }
            t = self.tn[t as usize][(k + 1) % 3];
            if t == start {
                return None;
            }
        }
        None
    }

    /// The triangles around vertex v in ccw order: (t, index of v in t).
    pub fn star(&self, v: u32) -> Vec<(u32, usize)> {
        let mut out = Vec::new();
        let start = self.vt[v as usize];
        if start == NONE {
            return out;
        }
        let mut t = start;
        for _ in 0..1 << 20 {
            let tv = self.tv[t as usize];
            let Some(k) = tv.iter().position(|&w| w == v) else { break };
            out.push((t, k));
            t = self.tn[t as usize][(k + 1) % 3];
            if t == start {
                break;
            }
        }
        out
    }

    fn set_edge_flags(&mut self, a: u32, b: u32, f: u8) {
        if let Some((t, i)) = self.find_edge(a, b) {
            self.te[t as usize][i] = f;
            let (u, j) = self.twin(t, i);
            self.te[u as usize][j] = f;
            self.dirty = true;
        }
    }
    fn flags_of(&self, a: u32, b: u32) -> u8 {
        match self.cons.get(&ekey(a, b)) {
            None => 0,
            Some(ls) if ls.is_empty() => 0,
            Some(ls) => E_CONS | if ls.iter().any(|&l| is_region(self.lines[l as usize].kind)) { E_REGION } else { 0 },
        }
    }
    /// Add line l to edge (a, b), which must exist.
    fn constrain(&mut self, a: u32, b: u32, l: u32) {
        self.cons.entry(ekey(a, b)).or_default().push(l);
        let f = self.flags_of(a, b);
        self.set_edge_flags(a, b, f);
    }

    /// Generic Lawson legalisation of the given edges (and of the edges around any flip).
    fn legalize_edges(&mut self, mut st: Vec<(u32, u32)>) {
        let mut guard = 0usize;
        let cap = 64 * (st.len() + 16) + 4 * self.tv.len();
        while let Some((a, b)) = st.pop() {
            guard += 1;
            if guard > cap {
                break;
            }
            let Some((t, i)) = self.find_edge(a, b) else { continue };
            if self.te[t as usize][i] & E_CONS != 0 {
                continue;
            }
            let (u, j) = self.twin(t, i);
            let p = self.tv[t as usize][i];
            let q = self.tv[u as usize][j];
            let bad = if q != INF { self.in_circle(t, q) } else { self.in_circle(u, p) };
            if !bad {
                continue;
            }
            self.flip(t, i, u, j);
            st.extend_from_slice(&[(a, q), (q, b), (b, p), (p, a)]);
        }
    }

    // ---- constraints ----
    /// Does the segment p–q cross a–e properly (interiors only)?
    fn crosses(&self, a: u32, e: u32, p: u32, q: u32) -> bool {
        if p == a || p == e || q == a || q == e || p == INF || q == INF {
            return false;
        }
        let (o1, o2) = (self.o3(a, e, p), self.o3(a, e, q));
        let (o3, o4) = (self.o3(p, q, a), self.o3(p, q, e));
        o1 * o2 < 0 && o3 * o4 < 0
    }

    fn forward(&self, a: u32, b: u32, v: u32) -> bool {
        let (a, b, v) = (a as usize, b as usize, v as usize);
        (self.x[v] - self.x[a]) as i128 * (self.x[b] - self.x[a]) as i128 + (self.y[v] - self.y[a]) as i128 * (self.y[b] - self.y[a]) as i128 > 0
    }

    /// From vertex a towards b: a vertex on the segment next to a, or the triangle whose edge
    /// opposite a the segment crosses first.
    fn first_crossing(&self, a: u32, b: u32) -> Res<Step> {
        for (t, k) in self.star(a) {
            let v = self.tv[t as usize];
            let (l, r) = (v[(k + 1) % 3], v[(k + 2) % 3]);
            if l == INF || r == INF {
                continue;
            }
            let (ol, or) = (self.o3(a, b, l), self.o3(a, b, r));
            if ol == 0 && self.forward(a, b, l) {
                return Ok(Step::Vertex(l));
            }
            if or == 0 && self.forward(a, b, r) {
                return Ok(Step::Vertex(r));
            }
            if ol < 0 && or > 0 {
                return Ok(Step::Cross(t, k));
            }
        }
        Err(Fail::Broken(Error::invalid("breakline: no way from a vertex towards the next one")))
    }

    /// Insert the constrained segment a → b for line l (a hard edge by flips); the vertices met
    /// on the way (collinear vertices, crossings with other lines) are appended to `path`.
    pub fn insert_segment(&mut self, a: u32, b: u32, l: u32) -> Res<()> {
        let kind = self.lines[l as usize].kind;
        let mut a = a;
        let mut guard = 0;
        while a != b {
            guard += 1;
            if guard > 1_000_000 {
                return Err(Fail::Broken(Error::invalid("breakline: too many pieces")));
            }
            if self.find_edge(a, b).is_some() {
                self.constrain(a, b, l);
                self.on_path(l, b);
                return Ok(());
            }
            let (t0, k0) = match self.first_crossing(a, b)? {
                Step::Vertex(v) => {
                    self.constrain(a, v, l);
                    self.on_path(l, v);
                    if carries_z(kind) {
                        self.set_z_on_line(v, a, b);
                    }
                    a = v;
                    continue;
                }
                Step::Cross(t, k) => (t, k),
            };
            // Walk the triangles the segment crosses.
            let mut edges = Vec::new();
            let (mut t, mut i) = (t0, k0);
            let mut stop = Stop::End;
            for _ in 0..(4 * self.tv.len() + 16) {
                let v = self.tv[t as usize];
                let (el, er) = (v[(i + 1) % 3], v[(i + 2) % 3]);
                if self.te[t as usize][i] & E_CONS != 0 {
                    stop = Stop::Cons(t, i);
                    break;
                }
                edges.push((el, er));
                let (u, j) = self.twin(t, i);
                let q = self.tv[u as usize][j];
                if q == b {
                    stop = Stop::End;
                    break;
                }
                if q == INF {
                    return Err(Fail::Broken(Error::invalid("breakline: left the surface")));
                }
                let o = self.o3(a, b, q);
                if o == 0 {
                    stop = Stop::Vertex(q);
                    break;
                }
                t = u;
                i = if o > 0 { (j + 1) % 3 } else { (j + 2) % 3 };
            }
            match stop {
                Stop::Cons(t, i) => {
                    // Cross another line: a vertex where they meet.
                    let s = self.steiner(a, b, t, i, kind);
                    self.insert_segment(a, s, l)?;
                    a = s;
                    continue;
                }
                Stop::Vertex(v) => {
                    self.resolve(a, v, edges)?;
                    self.constrain(a, v, l);
                    self.on_path(l, v);
                    if carries_z(kind) {
                        self.set_z_on_line(v, a, b);
                    }
                    a = v;
                }
                Stop::End => {
                    self.resolve(a, b, edges)?;
                    self.constrain(a, b, l);
                    self.on_path(l, b);
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// Line l passes through v next (its path is built in place, so a line that crosses itself
    /// finds its own earlier edges split correctly).
    fn on_path(&mut self, l: u32, v: u32) {
        self.lines[l as usize].path.push(v);
        self.vl[v as usize] += 1;
    }

    /// A vertex met on a height-carrying line takes the line's height there.
    fn set_z_on_line(&mut self, v: u32, a: u32, b: u32) {
        let (ax, ay, bx, by) = (self.x[a as usize] as f64, self.y[a as usize] as f64, self.x[b as usize] as f64, self.y[b as usize] as f64);
        let (vx, vy) = (self.x[v as usize] as f64, self.y[v as usize] as f64);
        let len = (bx - ax).powi(2) + (by - ay).powi(2);
        let s = if len > 0.0 { (((vx - ax) * (bx - ax) + (vy - ay) * (by - ay)) / len).clamp(0.0, 1.0) } else { 0.0 };
        let (za, zb) = (self.z[a as usize], self.z[b as usize]);
        if za.is_finite() && zb.is_finite() {
            self.z[v as usize] = za + (zb - za) * s;
        }
    }

    /// Sloan's flips until the segment a – e is an edge; returns the new edges.
    fn resolve(&mut self, a: u32, e: u32, edges: Vec<(u32, u32)>) -> Res<()> {
        let mut q: std::collections::VecDeque<(u32, u32)> = edges.into();
        let mut made = Vec::new();
        let cap = 64 * (q.len() + 8) * (q.len() + 8);
        let mut it = 0usize;
        while let Some((l, r)) = q.pop_front() {
            it += 1;
            if it > cap {
                return Err(Fail::Broken(Error::invalid("breakline: the crossing edges could not be flipped away")));
            }
            let Some((t, i)) = self.find_edge(l, r) else { continue };
            let (u, j) = self.twin(t, i);
            let p = self.tv[t as usize][i];
            let s = self.tv[u as usize][j];
            if p == INF || s == INF {
                return Err(Fail::Broken(Error::invalid("breakline: left the surface")));
            }
            // The quad p, l, s, r is strictly convex when both new triangles keep their orientation.
            if self.o3(p, l, s) <= 0 || self.o3(s, r, p) <= 0 {
                q.push_back((l, r));
                continue;
            }
            self.flip(t, i, u, j);
            if self.crosses(a, e, p, s) {
                q.push_back((p, s));
            } else {
                made.push((p, s));
            }
        }
        // Restore the Delaunay property around the new edges (the segment itself is constrained next).
        made.retain(|&(p, s)| !((p == a && s == e) || (p == e && s == a)));
        self.constrain_tmp(a, e);
        self.legalize_edges(made);
        self.unconstrain_tmp(a, e);
        Ok(())
    }
    fn constrain_tmp(&mut self, a: u32, e: u32) {
        let f = self.flags_of(a, e) | E_CONS;
        self.set_edge_flags(a, e, f);
    }
    fn unconstrain_tmp(&mut self, a: u32, e: u32) {
        let f = self.flags_of(a, e);
        self.set_edge_flags(a, e, f);
    }

    /// The vertex where segment a → b crosses the constrained edge i of t: the grid point nearest
    /// the crossing that keeps all four new triangles counter-clockwise, else the nearer end of
    /// that edge. Its height: a height-carrying new line's, else the existing edge's.
    fn steiner(&mut self, a: u32, b: u32, t: u32, i: usize, kind: u8) -> u32 {
        let v = self.tv[t as usize];
        let (l, r) = (v[(i + 1) % 3], v[(i + 2) % 3]);
        let (ax, ay, bx, by) = (self.x[a as usize] as f64, self.y[a as usize] as f64, self.x[b as usize] as f64, self.y[b as usize] as f64);
        let (lx, ly, rx, ry) = (self.x[l as usize] as f64, self.y[l as usize] as f64, self.x[r as usize] as f64, self.y[r as usize] as f64);
        let den = (bx - ax) * (ry - ly) - (by - ay) * (rx - lx);
        let s = if den != 0.0 { (((lx - ax) * (ry - ly) - (ly - ay) * (rx - lx)) / den).clamp(0.0, 1.0) } else { 0.5 };
        let u = if den != 0.0 { (((lx - ax) * (by - ay) - (ly - ay) * (bx - ax)) / den).clamp(0.0, 1.0) } else { 0.5 };
        let (cx, cy) = (ax + (bx - ax) * s, ay + (by - ay) * s);
        let (zl, zr, za, zb) = (self.z[l as usize], self.z[r as usize], self.z[a as usize], self.z[b as usize]);
        let z = if carries_z(kind) && za.is_finite() && zb.is_finite() { za + (zb - za) * s } else { zl + (zr - zl) * u };
        let (u2, j) = self.twin(t, i);
        let p = self.tv[t as usize][i];
        let qv = self.tv[u2 as usize][j];
        let cands = [(cx.round(), cy.round()), (cx.floor(), cy.floor()), (cx.ceil(), cy.floor()), (cx.floor(), cy.ceil()), (cx.ceil(), cy.ceil())];
        for (gx, gy) in cands {
            let (gx, gy) = (gx as i64, gy as i64);
            if (gx, gy) == (self.x[l as usize], self.y[l as usize]) || (gx, gy) == (self.x[r as usize], self.y[r as usize]) {
                continue;
            }
            let ok = p != INF && qv != INF && self.op(p, l, gx, gy) > 0 && self.op(r, p, gx, gy) > 0 && self.op(qv, r, gx, gy) > 0 && self.op(l, qv, gx, gy) > 0;
            if ok {
                let sv = self.add_vertex(gx, gy, z, V_STEINER);
                let mut st = Vec::new();
                self.split_edge(t, i, sv, &mut st);
                self.legalize(&mut st);
                // The grid point can lie just off the edge it splits, where the new spokes need not
                // be Delaunay (an exact point on the edge makes them so).
                self.legalize_edges(vec![(p, sv), (qv, sv)]);
                self.stats.steiner += 1;
                return sv;
            }
        }
        self.stats.snapped += 1;
        let dl = (lx - cx).powi(2) + (ly - cy).powi(2);
        let dr = (rx - cx).powi(2) + (ry - cy).powi(2);
        if dl <= dr {
            l
        } else {
            r
        }
    }

    /// What a segment from grid point p to grid point q meets on the TIN as it is (nothing
    /// changes), in order and strictly between p and q: an existing vertex on the segment, or the
    /// grid point where it crosses an unconstrained edge, with the surface's height there. A
    /// crossing of a constrained edge is left to `steiner` when the line goes in.
    pub fn trace_pts(&mut self, p: (i64, i64), q: (i64, i64)) -> Res<Vec<St>> {
        let mut out = Vec::new();
        if p == q {
            return Ok(out);
        }
        let len2 = (q.0 - p.0) as i128 * (q.0 - p.0) as i128 + (q.1 - p.1) as i128 * (q.1 - p.1) as i128;
        let side = |m: &Mesh, v: u32| orient(p.0, p.1, q.0, q.1, m.x[v as usize], m.y[v as usize]);
        let along = |m: &Mesh, v: u32| (m.x[v as usize] - p.0) as i128 * (q.0 - p.0) as i128 + (m.y[v as usize] - p.1) as i128 * (q.1 - p.1) as i128;
        let leave = || Fail::Refused(Error::invalid("the line leaves the surface"));
        let mut at = match self.locate(p.0, p.1) {
            Loc::Vert(v) => At::V(v),
            Loc::Tri(t) => At::T(t, 3),
            Loc::Edge(t, i) => {
                let v = self.tv[t as usize];
                let (l, r) = (v[(i + 1) % 3], v[(i + 2) % 3]);
                let o = self.op(l, r, q.0, q.1);
                if o > 0 {
                    At::T(t, i)
                } else if o < 0 {
                    let (u, j) = self.twin(t, i);
                    if self.is_ghost(u) {
                        return Err(leave());
                    }
                    At::T(u, j)
                } else {
                    let w = if along(self, l) > 0 { l } else { r };
                    if along(self, w) >= len2 {
                        return Ok(out);
                    }
                    out.push(St::V(w));
                    At::V(w)
                }
            }
            Loc::Out(_) => return Err(leave()),
        };
        for _ in 0..(8 * self.tv.len() + 64) {
            let next = match at {
                At::V(v) => {
                    let dv = along(self, v);
                    let mut nx = None;
                    for (t, k) in self.star(v) {
                        let tv = self.tv[t as usize];
                        let (l, r) = (tv[(k + 1) % 3], tv[(k + 2) % 3]);
                        if l == INF || r == INF {
                            continue;
                        }
                        let (ol, or) = (side(self, l), side(self, r));
                        let mut hit = None;
                        if ol == 0 && along(self, l) > dv {
                            hit = Some(l);
                        } else if or == 0 && along(self, r) > dv {
                            hit = Some(r);
                        }
                        if let Some(w) = hit {
                            if along(self, w) >= len2 {
                                return Ok(out);
                            }
                            out.push(St::V(w));
                            nx = Some(At::V(w));
                            break;
                        }
                        if ol < 0 && or > 0 {
                            if self.op(l, r, q.0, q.1) >= 0 {
                                return Ok(out);
                            }
                            self.cross_station(t, k, p, q, &mut out);
                            let (u, j) = self.twin(t, k);
                            if self.is_ghost(u) {
                                return Err(leave());
                            }
                            nx = Some(At::T(u, j));
                            break;
                        }
                    }
                    nx
                }
                At::T(t, e) => {
                    let tv = self.tv[t as usize];
                    if (0..3).all(|i| self.op(tv[(i + 1) % 3], tv[(i + 2) % 3], q.0, q.1) >= 0) {
                        return Ok(out);
                    }
                    let mut nx = None;
                    for i in 0..3 {
                        if i == e {
                            continue;
                        }
                        let (u, w) = (tv[(i + 1) % 3], tv[(i + 2) % 3]);
                        if self.op(u, w, q.0, q.1) >= 0 {
                            continue;
                        }
                        let (ou, ow) = (side(self, u), side(self, w));
                        let hit = if ou == 0 && along(self, u) > 0 { Some(u) } else if ow == 0 && along(self, w) > 0 { Some(w) } else { None };
                        if let Some(h) = hit {
                            if along(self, h) >= len2 {
                                return Ok(out);
                            }
                            out.push(St::V(h));
                            nx = Some(At::V(h));
                            break;
                        }
                        if ou * ow < 0 {
                            self.cross_station(t, i, p, q, &mut out);
                            let (n, j) = self.twin(t, i);
                            if self.is_ghost(n) {
                                return Err(leave());
                            }
                            nx = Some(At::T(n, j));
                            break;
                        }
                    }
                    nx
                }
            };
            at = next.ok_or_else(|| Fail::Broken(Error::invalid("breakline: no way from a vertex towards the next one")))?;
        }
        Err(Fail::Broken(Error::invalid("breakline: too many pieces")))
    }

    /// The crossing of p → q with edge i of t, rounded to the grid, with the edge's height there.
    fn cross_station(&self, t: u32, i: usize, p: (i64, i64), q: (i64, i64), out: &mut Vec<St>) {
        if self.te[t as usize][i] & E_CONS != 0 {
            return;
        }
        let v = self.tv[t as usize];
        let (u, w) = (v[(i + 1) % 3], v[(i + 2) % 3]);
        let (ux, uy, wx, wy) = (self.x[u as usize] as f64, self.y[u as usize] as f64, self.x[w as usize] as f64, self.y[w as usize] as f64);
        let (dx, dy) = ((q.0 - p.0) as f64, (q.1 - p.1) as f64);
        let den = (wx - ux) * dy - (wy - uy) * dx;
        if den == 0.0 {
            return;
        }
        let s = (((p.0 as f64 - ux) * dy - (p.1 as f64 - uy) * dx) / den).clamp(0.0, 1.0);
        let (gx, gy) = ((ux + (wx - ux) * s).round() as i64, (uy + (wy - uy) * s).round() as i64);
        if (gx, gy) == (self.x[u as usize], self.y[u as usize]) || (gx, gy) == (self.x[w as usize], self.y[w as usize]) {
            return;
        }
        out.push(St::P(gx, gy, self.z[u as usize] + (self.z[w as usize] - self.z[u as usize]) * s));
    }

    // ---- lines ----
    /// Add a line. `defs` are the vertices it was given; `via` is every vertex it is to pass
    /// through in order (`defs` with the traced stations of a densified line between them), all
    /// already inserted. Consecutive `via` vertices become constrained edges by flips; crossings
    /// with other lines get a vertex.
    pub fn add_line(&mut self, key: u64, kind: u8, closed: bool, defs: Vec<u32>, via: Vec<u32>) -> Res<u32> {
        if self.by_key.contains_key(&key) {
            return Err(Fail::Refused(Error::invalid("a line with this key exists")));
        }
        let mut d = via;
        d.dedup();
        if closed && d.len() > 1 && d[0] == *d.last().unwrap_or(&NONE) {
            d.pop();
        }
        if d.len() < 2 || (closed && d.len() < 3) {
            return Err(Fail::Refused(Error::invalid("a line needs two vertices (a ring three)")));
        }
        let l = self.lines.len() as u32;
        self.lines.push(Line { key, kind, closed, defs, path: Vec::new(), alive: true });
        self.by_key.insert(key, l);
        self.on_path(l, d[0]);
        let n = d.len();
        let segs = if closed { n } else { n - 1 };
        for k in 0..segs {
            self.insert_segment(d[k], d[(k + 1) % n], l)?;
        }
        let path = &mut self.lines[l as usize].path;
        if closed && path.len() > 1 && path[0] == *path.last().unwrap_or(&NONE) {
            let v = path.pop().unwrap_or(NONE);
            self.vl[v as usize] -= 1;
        }
        self.dirty = true;
        Ok(l)
    }

    /// Remove line l: its edges lose the constraint (Delaunay restored there), its own vertices
    /// that no other line uses go, and mass points it changed get their heights back.
    pub fn remove_line(&mut self, l: u32) -> Res<()> {
        let line = self.lines[l as usize].clone();
        if !line.alive {
            return Err(Fail::Refused(Error::invalid("the line was removed already")));
        }
        let n = line.path.len();
        let segs = if line.closed { n } else { n.saturating_sub(1) };
        let mut free_edges = Vec::new();
        for k in 0..segs {
            let (a, b) = (line.path[k], line.path[(k + 1) % n]);
            let key = ekey(a, b);
            if let Some(ls) = self.cons.get_mut(&key) {
                if let Some(pos) = ls.iter().position(|&x| x == l) {
                    ls.remove(pos);
                }
                if ls.is_empty() {
                    self.cons.remove(&key);
                    free_edges.push((a, b));
                }
            }
            let f = self.flags_of(a, b);
            self.set_edge_flags(a, b, f);
        }
        for &v in &line.path {
            self.vl[v as usize] = self.vl[v as usize].saturating_sub(1);
        }
        self.lines[l as usize].alive = false;
        self.lines[l as usize].path.clear();
        self.by_key.remove(&line.key);
        self.legalize_edges(free_edges);
        let mut seen = Vec::new();
        for &v in &line.path {
            if self.vl[v as usize] > 0 || seen.contains(&v) || self.vf[v as usize] & V_DEAD != 0 {
                continue;
            }
            seen.push(v);
            if self.vf[v as usize] & V_MASS != 0 {
                let z0 = self.z0[v as usize];
                if z0.is_finite() {
                    self.z[v as usize] = z0;
                }
            } else {
                self.remove_vertex(v)?;
            }
        }
        self.dirty = true;
        Ok(())
    }

    // ---- removal ----
    /// Remove a vertex that no constrained edge touches. Interior vertices go by ear flips;
    /// a hull vertex rebuilds the triangulation (Broken is never returned for a valid mesh).
    pub fn remove_vertex(&mut self, v: u32) -> Res<()> {
        if self.vf[v as usize] & V_DEAD != 0 {
            return Err(Fail::Refused(Error::invalid("the vertex was removed already")));
        }
        let star = self.star(v);
        for &(t, k) in &star {
            let e = self.te[t as usize];
            if e[(k + 1) % 3] & E_CONS != 0 || e[(k + 2) % 3] & E_CONS != 0 {
                return Err(Fail::Refused(Error::invalid("the vertex is on a breakline")));
            }
        }
        if star.iter().any(|&(t, _)| self.is_ghost(t)) {
            return self.rebuild_without(v);
        }
        let mut guard = 0;
        let mut chords = Vec::new();
        loop {
            guard += 1;
            if guard > 1 << 20 {
                return Err(Fail::Broken(Error::invalid("vertex removal did not finish")));
            }
            let star = self.star(v);
            let n = star.len();
            if n < 3 {
                return Err(Fail::Broken(Error::invalid("vertex removal: broken star")));
            }
            if n == 3 {
                break;
            }
            // Link vertices p[i] = the vertex after v in each triangle of the star (ccw).
            let link: Vec<u32> = star.iter().map(|&(t, k)| self.tv[t as usize][(k + 1) % 3]).collect();
            let mut pick = None;
            let mut any = None;
            for i in 0..n {
                let (pa, pi, pb) = (link[(i + n - 1) % n], link[i], link[(i + 1) % n]);
                if self.o3(pa, pi, pb) <= 0 || self.o3(v, pa, pb) <= 0 {
                    continue;
                }
                if any.is_none() {
                    any = Some(i);
                }
                // A large star takes the first flippable ear; the legalisation below repairs it.
                if n > 48 {
                    break;
                }
                let (a, b, c) = (pa as usize, pi as usize, pb as usize);
                let empty = link.iter().all(|&w| {
                    if w == pa || w == pi || w == pb {
                        return true;
                    }
                    let w = w as usize;
                    incircle(self.x[a], self.y[a], self.x[b], self.y[b], self.x[c], self.y[c], self.x[w], self.y[w]) <= 0
                });
                if empty {
                    pick = Some(i);
                    break;
                }
            }
            let Some(i) = pick.or(any) else {
                // A vertex on the diagonals of its four-sided star (usual on a lattice): no ear can
                // be cut, but a diagonal of the quadrilateral replaces the star directly.
                if n == 4 {
                    if let Some(r) = (0..4).find(|&r| self.o3(link[r], link[(r + 1) % 4], link[(r + 2) % 4]) > 0 && self.o3(link[(r + 2) % 4], link[(r + 3) % 4], link[r]) > 0) {
                        self.remove_in_quad(v, &star, &link, r, chords);
                        return Ok(());
                    }
                }
                return self.rebuild_without(v);
            };
            // Flip edge (v, link[i]): it is the edge opposite link[i+1] in triangle star[i].
            let (t, k) = star[i];
            let tv = self.tv[t as usize];
            let ai = (0..3).find(|&m| tv[m] != v && tv[m] != link[i]).unwrap_or((k + 2) % 3);
            let (u, j) = self.twin(t, ai);
            self.flip(t, ai, u, j);
            let n1 = link.len();
            chords.push((link[(i + n1 - 1) % n1], link[(i + 1) % n1]));
            chords.push((link[(i + n1 - 1) % n1], link[i]));
            chords.push((link[i], link[(i + 1) % n1]));
        }
        let star = self.star(v);
        let link: Vec<u32> = star.iter().map(|&(t, k)| self.tv[t as usize][(k + 1) % 3]).collect();
        let outer: Vec<(u32, u8)> = star.iter().map(|&(t, k)| (self.tn[t as usize][k], self.te[t as usize][k])).collect();
        let (t0, t1, t2) = (star[0].0, star[1].0, star[2].0);
        let (p0, p1, p2) = (link[0], link[1], link[2]);
        // Triangle i of the star is (v, p_i, p_{i+1}); its outer edge (p_i, p_{i+1}) borders outer[i].
        self.set_tri(t0, [p0, p1, p2], [outer[1].0, outer[2].0, outer[0].0], [outer[1].1, outer[2].1, outer[0].1]);
        self.relink(outer[1].0, p1, p2, t0);
        self.relink(outer[2].0, p2, p0, t0);
        self.kill_tri(t1);
        self.kill_tri(t2);
        for p in [p0, p1, p2] {
            self.vt[p as usize] = t0;
        }
        self.kill_vertex(v);
        self.hint = t0;
        chords.extend_from_slice(&[(p0, p1), (p1, p2), (p2, p0)]);
        self.legalize_edges(chords);
        Ok(())
    }

    /// Replace the four triangles around v by the two either side of the diagonal link[r]–link[r + 2].
    fn remove_in_quad(&mut self, v: u32, star: &[(u32, usize)], link: &[u32], r: usize, mut chords: Vec<(u32, u32)>) {
        let at = |k: usize| (r + k) % 4;
        let (a, b, c, d) = (link[at(0)], link[at(1)], link[at(2)], link[at(3)]);
        let outer: Vec<(u32, u8)> = (0..4).map(|k| {
            let (t, i) = star[at(k)];
            (self.tn[t as usize][i], self.te[t as usize][i])
        }).collect();
        let (t1, t2) = (star[at(0)].0, star[at(1)].0);
        self.set_tri(t1, [a, b, c], [outer[1].0, t2, outer[0].0], [outer[1].1, 0, outer[0].1]);
        self.set_tri(t2, [a, c, d], [outer[2].0, outer[3].0, t1], [outer[2].1, outer[3].1, 0]);
        self.relink(outer[0].0, a, b, t1);
        self.relink(outer[1].0, b, c, t1);
        self.relink(outer[2].0, c, d, t2);
        self.relink(outer[3].0, d, a, t2);
        self.kill_tri(star[at(2)].0);
        self.kill_tri(star[at(3)].0);
        for p in [a, b, c] {
            self.vt[p as usize] = t1;
        }
        self.vt[d as usize] = t2;
        self.kill_vertex(v);
        self.hint = t1;
        chords.extend_from_slice(&[(a, b), (b, c), (c, d), (d, a), (a, c)]);
        self.legalize_edges(chords);
    }

    fn kill_vertex(&mut self, v: u32) {
        self.vf[v as usize] |= V_DEAD;
        self.vt[v as usize] = NONE;
    }

    /// Rebuild the whole triangulation without vertex v (a hull vertex): every other vertex is
    /// inserted again in the same order and every line re-made, so the result depends only on the
    /// state, as a replay of the log needs.
    pub fn rebuild_without(&mut self, v: u32) -> Res<()> {
        let keep: Vec<u32> = (0..self.nv() as u32).filter(|&w| w != v && self.vf[w as usize] & V_DEAD == 0).collect();
        if keep.len() < 3 {
            return Err(Fail::Refused(Error::invalid("a TIN needs three points")));
        }
        let mut m = Mesh::new(self.q, self.ox, self.oy);
        m.stats = self.stats.clone();
        m.stats.rebuilds += 1;
        // Same vertex ids: copy the arrays, mark the removed one dead, clear the topology.
        m.x = self.x.clone();
        m.y = self.y.clone();
        m.z = self.z.clone();
        m.z0 = self.z0.clone();
        m.vf = self.vf.clone();
        m.vf[v as usize] |= V_DEAD;
        m.vt = vec![NONE; self.nv()];
        m.vl = vec![0; self.nv()];
        let order = hilbert_order(&keep.iter().map(|&w| (m.x[w as usize], m.y[w as usize])).collect::<Vec<_>>());
        let ids: Vec<u32> = order.iter().map(|&k| keep[k]).collect();
        if !m.start_with(&ids) {
            return Err(Fail::Refused(Error::invalid("a TIN needs three points that are not on one line")));
        }
        let lines = std::mem::take(&mut self.lines);
        for ln in &lines {
            if !ln.alive {
                m.lines.push(Line { alive: false, path: Vec::new(), ..ln.clone() });
                continue;
            }
            let defs: Vec<u32> = ln.defs.iter().copied().filter(|&w| w != v).collect();
            let via: Vec<u32> = ln.path.iter().copied().filter(|&w| w != v).collect();
            let at = m.lines.len() as u32;
            match m.add_line(ln.key, ln.kind, ln.closed, defs, via) {
                Ok(_) => {}
                Err(_) => {
                    // Keep the slot so line indices stay put.
                    m.by_key.remove(&ln.key);
                    if (at as usize) < m.lines.len() {
                        m.lines[at as usize].alive = false;
                    } else {
                        m.lines.push(Line { alive: false, path: Vec::new(), ..ln.clone() });
                    }
                }
            }
        }
        *self = m;
        Ok(())
    }

    /// Insert existing vertex ids (coordinates already in x, y) into an empty topology, the first
    /// three non-collinear ones forming the first triangle. False when all are collinear.
    pub fn start_with(&mut self, ids: &[u32]) -> bool {
        // The first vertex, the first one at another point, the first one off their line.
        let Some(&a) = ids.first() else { return false };
        let at = |w: u32| (self.x[w as usize], self.y[w as usize]);
        let Some(j) = ids.iter().position(|&b| at(b) != at(a)) else { return false };
        let Some(k) = ids.iter().skip(j + 1).position(|&c| self.o3(a, ids[j], c) != 0).map(|k| k + j + 1) else { return false };
        let i = 0;
        self.init3(ids[i], ids[j], ids[k]);
        for (n, &w) in ids.iter().enumerate() {
            if n == i || n == j || n == k {
                continue;
            }
            let (gx, gy) = (self.x[w as usize], self.y[w as usize]);
            let loc = self.locate(gx, gy);
            let mut st = Vec::new();
            match loc {
                Loc::Vert(_) => {
                    self.stats.duplicates += 1;
                    self.kill_vertex(w);
                    continue;
                }
                Loc::Tri(t) | Loc::Out(t) => self.split3(t, w, &mut st),
                Loc::Edge(t, e) => self.split_edge(t, e, w, &mut st),
            }
            self.legalize(&mut st);
        }
        true
    }

    // ---- queries ----
    /// The surface height at plane point (x, y): NaN outside the TIN or in an excluded triangle.
    pub fn height_at(&mut self, x: f64, y: f64) -> f64 {
        let Some((gx, gy)) = self.snap(x, y) else { return f64::NAN };
        let loc = self.locate(gx, gy);
        let t = match loc {
            Loc::Vert(v) => return self.z[v as usize],
            Loc::Tri(t) => t,
            Loc::Edge(t, i) => {
                if self.is_ghost(t) {
                    self.twin(t, i).0
                } else {
                    t
                }
            }
            Loc::Out(_) => return f64::NAN,
        };
        if self.tf[t as usize] & T_EXCL != 0 {
            return f64::NAN;
        }
        self.interp(t, x, y)
    }

    /// Linear interpolation in triangle t at plane point (x, y).
    pub fn interp(&self, t: u32, x: f64, y: f64) -> f64 {
        let v = self.tv[t as usize];
        if v.contains(&INF) {
            return f64::NAN;
        }
        let (a, b, c) = (v[0], v[1], v[2]);
        let (ax, ay, bx, by, cx, cy) = (self.px(a), self.py(a), self.px(b), self.py(b), self.px(c), self.py(c));
        let det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        if det == 0.0 {
            return f64::NAN;
        }
        let wb = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det;
        let wc = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
        let wa = 1.0 - wb - wc;
        wa * self.z[a as usize] + wb * self.z[b as usize] + wc * self.z[c as usize]
    }

    /// Nearest live vertex to (x, y) within r metres that has any of `flags` (0: any).
    pub fn nearest_vertex(&mut self, x: f64, y: f64, r: f64, flags: u8) -> Option<u32> {
        let (gx, gy) = self.snap(x, y)?;
        let loc = self.locate(gx, gy);
        let seed = match loc {
            Loc::Vert(v) => v,
            Loc::Tri(t) | Loc::Edge(t, _) | Loc::Out(t) => *self.tv[t as usize].iter().find(|&&w| w != INF)?,
        };
        // Breadth-first over the vertex graph within r.
        let r2 = r * r;
        let mut best: Option<(f64, u32)> = None;
        let mut seen: Map<u32, ()> = Map::default();
        seen.insert(seed, ());
        let mut queue = std::collections::VecDeque::from([seed]);
        let mut steps = 0;
        while let Some(w) = queue.pop_front() {
            steps += 1;
            if steps > 200_000 {
                break;
            }
            let d2 = (self.px(w) - x).powi(2) + (self.py(w) - y).powi(2);
            if (flags == 0 || self.vf[w as usize] & flags != 0) && d2 <= r2 && best.is_none_or(|(bd, _)| d2 < bd) {
                best = Some((d2, w));
            }
            if d2 > 4.0 * r2 + (self.q * 4.0).powi(2) && w != seed {
                continue;
            }
            for (t, k) in self.star(w) {
                let n = self.tv[t as usize][(k + 1) % 3];
                if n != INF && seen.insert(n, ()).is_none() {
                    queue.push_back(n);
                }
            }
        }
        best.map(|b| b.1)
    }

    /// Recompute which triangles are excluded: inside a void ring (even-odd over voids) or, when
    /// outer boundaries exist, outside every one. Regions are flooded across non-region edges and
    /// one point per region decides.
    pub fn classify(&mut self) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        let rings: Vec<(u8, Vec<(f64, f64)>)> = self.lines.iter().filter(|l| l.alive && is_region(l.kind) && l.path.len() >= 3).map(|l| (l.kind, l.path.iter().map(|&v| (self.px(v), self.py(v))).collect())).collect();
        for f in self.tf.iter_mut() {
            *f &= !T_EXCL;
        }
        if rings.is_empty() {
            return;
        }
        let has_outer = rings.iter().any(|r| r.0 == OUTER);
        let has_face = rings.iter().any(|r| r.0 == FRING);
        let nt = self.tv.len();
        let mut region = vec![u32::MAX; nt];
        let mut stack = Vec::new();
        for s in 0..nt as u32 {
            if region[s as usize] != u32::MAX || self.tf[s as usize] & T_DEAD != 0 || self.is_ghost(s) {
                continue;
            }
            // Decide this region from its first triangle's centroid.
            let v = self.tv[s as usize];
            let cx = (self.px(v[0]) + self.px(v[1]) + self.px(v[2])) / 3.0;
            let cy = (self.py(v[0]) + self.py(v[1]) + self.py(v[2])) / 3.0;
            let mut in_void = false;
            let mut in_outer = false;
            let mut in_face = false;
            for (k, r) in &rings {
                if point_in_ring(cx, cy, r) {
                    match *k {
                        VOID => in_void = !in_void,
                        FRING => in_face = !in_face,
                        _ => in_outer = true,
                    }
                }
            }
            let excl = in_void || (has_outer && !in_outer) || (has_face && !in_face);
            region[s as usize] = s;
            stack.push(s);
            while let Some(t) = stack.pop() {
                if excl {
                    self.tf[t as usize] |= T_EXCL;
                }
                for i in 0..3 {
                    if self.te[t as usize][i] & E_REGION != 0 {
                        continue;
                    }
                    let u = self.tn[t as usize][i];
                    if u == NONE || region[u as usize] != u32::MAX || self.is_ghost(u) {
                        continue;
                    }
                    region[u as usize] = s;
                    stack.push(u);
                }
            }
        }
    }

    /// Live real triangles.
    pub fn triangles(&self) -> impl Iterator<Item = u32> + '_ {
        (0..self.tv.len() as u32).filter(move |&t| self.tf[t as usize] & T_DEAD == 0 && !self.tv[t as usize].contains(&INF))
    }

    /// Check the topology (tests, state import): neighbours are mutual, orientation positive,
    /// each vertex's triangle contains it, at most one INF per triangle.
    pub fn check(&self) -> Result<(), &'static str> {
        let nv = self.nv() as u32;
        let mut real = 0;
        for t in 0..self.tv.len() as u32 {
            let k = t as usize;
            if self.tf[k] & T_DEAD != 0 {
                continue;
            }
            let v = self.tv[k];
            let infs = v.iter().filter(|&&w| w == INF).count();
            if infs > 1 || v.iter().any(|&w| w != INF && w >= nv) {
                return Err("a triangle has bad vertices");
            }
            if infs == 0 {
                real += 1;
                if self.o3(v[0], v[1], v[2]) <= 0 {
                    return Err("a triangle is not counter-clockwise");
                }
            }
            for i in 0..3 {
                let u = self.tn[k][i];
                if u == NONE || u as usize >= self.tv.len() || self.tf[u as usize] & T_DEAD != 0 {
                    return Err("a triangle has a missing neighbour");
                }
                let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
                let w = self.tv[u as usize];
                let j = (0..3).find(|&j| w[(j + 1) % 3] == b && w[(j + 2) % 3] == a);
                match j {
                    Some(j) if self.tn[u as usize][j] == t => {
                        if self.te[u as usize][j] != self.te[k][i] {
                            return Err("edge flags differ across an edge");
                        }
                    }
                    _ => return Err("a neighbour does not share its edge"),
                }
            }
        }
        if real != self.nreal {
            return Err("the real triangle count is wrong");
        }
        for v in 0..nv {
            if self.vf[v as usize] & V_DEAD != 0 {
                continue;
            }
            let t = self.vt[v as usize];
            if t == NONE {
                continue;
            }
            if t as usize >= self.tv.len() || !self.tv[t as usize].contains(&v) {
                return Err("a vertex's triangle does not contain it");
            }
        }
        for (key, ls) in &self.cons {
            let (a, b) = ((key >> 32) as u32, (key & 0xffff_ffff) as u32);
            if ls.is_empty() {
                continue;
            }
            match self.find_edge(a, b) {
                Some((t, i)) if self.te[t as usize][i] & E_CONS != 0 => {}
                _ => return Err("a constraint is not a constrained edge"),
            }
        }
        Ok(())
    }
}

enum Step {
    Vertex(u32),
    Cross(u32, usize),
}
/// A station of a traced line: an existing vertex, or a grid point with its surface height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum St {
    V(u32),
    P(i64, i64, f64),
}
enum At {
    V(u32),
    T(u32, usize),
}
enum Stop {
    End,
    Vertex(u32),
    Cons(u32, usize),
}

pub fn point_in_ring(x: f64, y: f64, r: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let n = r.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = r[i];
        let (xj, yj) = r[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Order of points along a Hilbert curve (16 bits per axis over their box), for insertion.
pub fn hilbert_order(p: &[(i64, i64)]) -> Vec<usize> {
    if p.is_empty() {
        return Vec::new();
    }
    let (mut x0, mut y0, mut x1, mut y1) = (i64::MAX, i64::MAX, i64::MIN, i64::MIN);
    for &(x, y) in p {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let span = ((x1 - x0).max(y1 - y0)).max(1) as f64;
    // Hilbert index (32 bits) above the point index (32 bits): one u64 sort.
    let mut keys: Vec<u64> = p
        .iter()
        .enumerate()
        .map(|(k, &(x, y))| {
            let hx = (((x - x0) as f64 / span) * 65535.0) as u32;
            let hy = (((y - y0) as f64 / span) * 65535.0) as u32;
            (hilbert(hx, hy) << 32) | k as u64
        })
        .collect();
    keys.sort_unstable();
    keys.into_iter().map(|k| (k & 0xffff_ffff) as usize).collect()
}

fn hilbert(mut x: u32, mut y: u32) -> u64 {
    let mut d = 0u64;
    let mut s = 1u32 << 15;
    while s > 0 {
        let rx = (x & s > 0) as u32;
        let ry = (y & s > 0) as u32;
        d += (s as u64) * (s as u64) * ((3 * rx) ^ ry) as u64;
        if ry == 0 {
            if rx == 1 {
                x = s.wrapping_sub(1).wrapping_sub(x) & 0xffff;
                y = s.wrapping_sub(1).wrapping_sub(y) & 0xffff;
            }
            std::mem::swap(&mut x, &mut y);
        }
        s >>= 1;
    }
    d
}
