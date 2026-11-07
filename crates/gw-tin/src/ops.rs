//! TIN edits (REQ-GAP-39), as a flat f64 list so the app's log replays them in the WASM bundle:
//! `[count, then per edit: code, …]`. Coordinates are TIN-plane metres; lines are named by a key
//! the app chooses. Every edit is checked before it changes anything where that can be known; one
//! that fails part way reports `broken` and the app rebuilds the TIN from its log without it.
//!
//! | code | edit | parameters |
//! |---|---|---|
//! | 1 | add mass point | x, y, z |
//! | 2 | delete mass point | x, y, radius |
//! | 3 | move mass point | x, y, radius, new x, new y, new z (NaN: keep) |
//! | 4 | add line | key, kind, closed, n, n × (x, y, z) |
//! | 5 | delete line | key |
//! | 6 | replace line | key, kind, closed, n, n × (x, y, z) |
//! | 7 | ridge / drain | key, 1 drain or 2 ridge, n, n × (x, y) |
//! | 8 | delete mass points in a ring | n, n × (x, y) |
//! | 9 | swap an edge | key, x, y |
//! | 10 | re-triangulate in a ring | n, n × (x, y) |

use crate::make::{profile, Profile};
use crate::err::{Error, Msg};
use crate::mesh::{carries_z, is_region, point_in_ring, Fail, Loc, Mesh, Res, St, DRAIN, E_CONS, HARD, INF, RIDGE, SOFT, SWAP, V_DEAD, V_LINE, V_MASS};

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    AddPoint { x: f64, y: f64, z: f64 },
    DelPoint { x: f64, y: f64, r: f64 },
    MovePoint { x: f64, y: f64, r: f64, nx: f64, ny: f64, nz: f64 },
    AddLine { key: u64, kind: u8, closed: bool, pts: Vec<[f64; 3]> },
    DelLine { key: u64 },
    SetLine { key: u64, kind: u8, closed: bool, pts: Vec<[f64; 3]> },
    Profile { key: u64, ridge: bool, pts: Vec<[f64; 2]> },
    DelIn { ring: Vec<[f64; 2]> },
    Swap { key: u64, x: f64, y: f64 },
    Retri { ring: Vec<[f64; 2]> },
}

/// What an edit did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Done {
    pub added: usize,
    pub removed: usize,
    pub changed: usize,
    pub profile: Option<Profile>,
}

const MAXN: usize = 4_000_000;

fn key_of(v: f64) -> Result<u64, Msg> {
    if v.is_finite() && v >= 0.0 && v <= 9.0e15 && v.fract() == 0.0 {
        Ok(v as u64)
    } else {
        Err(Error::invalid("tin edit: a line key must be a whole number"))
    }
}

/// Parse the flat edit list.
pub fn parse(a: &[f64]) -> Result<Vec<Op>, Msg> {
    let mut i = 0usize;
    let take = |i: &mut usize, n: usize| -> Result<std::ops::Range<usize>, Msg> {
        let end = i.checked_add(n).ok_or_else(|| Error::invalid("tin edit: the list ends early"))?;
        if end > a.len() {
            return Err(Error::invalid("tin edit: the list ends early"));
        }
        let r = *i..end;
        *i = end;
        Ok(r)
    };
    let count_of = |v: f64, cap: usize| -> Result<usize, Msg> {
        if v.is_finite() && v >= 0.0 && v.fract() == 0.0 && v <= cap as f64 {
            Ok(v as usize)
        } else {
            Err(Error::invalid("tin edit: bad count"))
        }
    };
    let n = count_of(*a.first().ok_or_else(|| Error::invalid("tin edit: empty list"))?, MAXN)?;
    i += 1;
    let mut ops = Vec::with_capacity(n.min(4096));
    for _ in 0..n {
        let code = a[take(&mut i, 1)?.start];
        let op = match code as i64 {
            1 => {
                let r = take(&mut i, 3)?;
                Op::AddPoint { x: a[r.start], y: a[r.start + 1], z: a[r.start + 2] }
            }
            2 => {
                let r = take(&mut i, 3)?;
                Op::DelPoint { x: a[r.start], y: a[r.start + 1], r: a[r.start + 2] }
            }
            3 => {
                let r = take(&mut i, 6)?;
                let s = r.start;
                Op::MovePoint { x: a[s], y: a[s + 1], r: a[s + 2], nx: a[s + 3], ny: a[s + 4], nz: a[s + 5] }
            }
            4 | 6 => {
                let h = take(&mut i, 4)?;
                let key = key_of(a[h.start])?;
                let kind = a[h.start + 1];
                if !(1.0..=4.0).contains(&kind) || kind.fract() != 0.0 {
                    return Err(Error::invalid("tin edit: unknown line kind"));
                }
                let closed = a[h.start + 2] != 0.0;
                let m = count_of(a[h.start + 3], MAXN)?;
                let r = take(&mut i, m.checked_mul(3).ok_or_else(|| Error::invalid("tin edit: bad count"))?)?;
                let pts = a[r].chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
                if code as i64 == 4 {
                    Op::AddLine { key, kind: kind as u8, closed, pts }
                } else {
                    Op::SetLine { key, kind: kind as u8, closed, pts }
                }
            }
            5 => Op::DelLine { key: key_of(a[take(&mut i, 1)?.start])? },
            7 => {
                let h = take(&mut i, 3)?;
                let key = key_of(a[h.start])?;
                let mode = a[h.start + 1];
                if mode != 1.0 && mode != 2.0 {
                    return Err(Error::invalid("tin edit: unknown profile mode"));
                }
                let m = count_of(a[h.start + 2], MAXN)?;
                let r = take(&mut i, m.checked_mul(2).ok_or_else(|| Error::invalid("tin edit: bad count"))?)?;
                Op::Profile { key, ridge: mode == 2.0, pts: a[r].chunks_exact(2).map(|c| [c[0], c[1]]).collect() }
            }
            8 | 10 => {
                let m = count_of(a[take(&mut i, 1)?.start], MAXN)?;
                let r = take(&mut i, m.checked_mul(2).ok_or_else(|| Error::invalid("tin edit: bad count"))?)?;
                let ring = a[r].chunks_exact(2).map(|c| [c[0], c[1]]).collect();
                if code as i64 == 8 {
                    Op::DelIn { ring }
                } else {
                    Op::Retri { ring }
                }
            }
            9 => {
                let r = take(&mut i, 3)?;
                Op::Swap { key: key_of(a[r.start])?, x: a[r.start + 1], y: a[r.start + 2] }
            }
            _ => return Err(Error::invalid("tin edit: unknown edit code")),
        };
        ops.push(op);
    }
    if i != a.len() {
        return Err(Error::invalid("tin edit: trailing values after the last edit"));
    }
    Ok(ops)
}

fn fin(v: &[f64]) -> bool {
    v.iter().all(|x| x.is_finite())
}

/// Apply one edit.
pub fn apply(m: &mut Mesh, op: &Op) -> Res<Done> {
    if !m.ready() {
        return Err(Fail::Refused(Error::invalid("the TIN has no triangles")));
    }
    let mut d = Done::default();
    match op {
        Op::AddPoint { x, y, z } => {
            if !fin(&[*x, *y, *z]) {
                return Err(Fail::Refused(Error::invalid("a point needs finite x, y and z")));
            }
            let (gx, gy) = m.snap(*x, *y).ok_or_else(|| Fail::Refused(Error::invalid("the point is outside the TIN's range")))?;
            let loc = m.locate(gx, gy);
            if let Loc::Vert(_) = loc {
                return Err(Fail::Refused(Error::invalid("there is a point at this position already")));
            }
            m.insert_at(loc, gx, gy, *z, V_MASS).map_err(|_| Fail::Refused(Error::invalid("there is a point at this position already")))?;
            d.added = 1;
        }
        Op::DelPoint { x, y, r } => {
            let v = pick_mass(m, *x, *y, *r)?;
            m.remove_vertex(v)?;
            d.removed = 1;
        }
        Op::MovePoint { x, y, r, nx, ny, nz } => {
            if !fin(&[*nx, *ny]) {
                return Err(Fail::Refused(Error::invalid("a point needs finite x, y and z")));
            }
            let v = pick_mass(m, *x, *y, *r)?;
            let z = if nz.is_finite() { *nz } else { m.z[v as usize] };
            let (gx, gy) = m.snap(*nx, *ny).ok_or_else(|| Fail::Refused(Error::invalid("the point is outside the TIN's range")))?;
            if (gx, gy) == (m.x[v as usize], m.y[v as usize]) {
                m.z[v as usize] = z;
                m.z0[v as usize] = z;
                d.changed = 1;
                return Ok(d);
            }
            if let Loc::Vert(w) = m.locate(gx, gy) {
                if w != v {
                    return Err(Fail::Refused(Error::invalid("there is a point at this position already")));
                }
            }
            m.remove_vertex(v)?;
            let loc = m.locate(gx, gy);
            m.insert_at(loc, gx, gy, z, V_MASS).map_err(|_| Fail::Broken(Error::invalid("the moved point could not be inserted")))?;
            d.changed = 1;
        }
        Op::AddLine { key, kind, closed, pts } => {
            add_line(m, *key, *kind, *closed, pts, &mut d)?;
        }
        Op::DelLine { key } => {
            let l = *m.by_key.get(key).ok_or_else(|| Fail::Refused(Error::invalid("no line with this key")))?;
            let before = m.alive_vertices();
            m.remove_line(l)?;
            d.removed = before.saturating_sub(m.alive_vertices());
        }
        Op::SetLine { key, kind, closed, pts } => {
            let l = *m.by_key.get(key).ok_or_else(|| Fail::Refused(Error::invalid("no line with this key")))?;
            check_line(m, *kind, *closed, pts)?;
            m.remove_line(l)?;
            add_line(m, *key, *kind, *closed, pts, &mut d)?;
        }
        Op::Profile { key, ridge, pts } => {
            if pts.len() < 2 {
                return Err(Fail::Refused(Error::invalid("a line needs two vertices (a ring three)")));
            }
            if m.by_key.contains_key(key) {
                return Err(Fail::Refused(Error::invalid("a line with this key exists")));
            }
            // Heights along the drawn line, from the surface.
            let mut p3: Vec<[f64; 3]> = Vec::with_capacity(pts.len());
            for p in pts {
                if !fin(p) {
                    return Err(Fail::Refused(Error::invalid("a point needs finite x, y and z")));
                }
                let z = m.height_at(p[0], p[1]);
                if !z.is_finite() {
                    return Err(Fail::Refused(Error::invalid("the line leaves the surface")));
                }
                p3.push([p[0], p[1], z]);
            }
            let reversed = p3[0][2] < p3[p3.len() - 1][2];
            if reversed {
                p3.reverse();
            }
            let kind = if *ridge { RIDGE } else { DRAIN };
            let l = insert_line(m, *key, kind, false, &p3, &mut d)?;
            let mut pr = profile(m, l, *ridge);
            pr.reversed = reversed;
            d.changed = pr.changed;
            d.profile = Some(pr);
        }
        Op::DelIn { ring } => {
            if ring.len() < 3 || !ring.iter().all(|p| fin(p)) {
                return Err(Fail::Refused(Error::invalid("a ring needs three finite corners")));
            }
            let r: Vec<(f64, f64)> = ring.iter().map(|p| (p[0], p[1])).collect();
            let victims: Vec<u32> = (0..m.nv() as u32).filter(|&v| m.vf[v as usize] & V_DEAD == 0 && m.vf[v as usize] & V_MASS != 0 && m.vl[v as usize] == 0 && point_in_ring(m.px(v), m.py(v), &r)).collect();
            let left = m.alive_vertices() - victims.len();
            if left < 3 {
                return Err(Fail::Refused(Error::invalid("a TIN needs three points")));
            }
            for v in victims {
                if m.vf[v as usize] & V_DEAD != 0 {
                    continue;
                }
                m.remove_vertex(v)?;
                d.removed += 1;
            }
        }
        Op::Swap { key, x, y } => {
            if m.by_key.contains_key(key) {
                return Err(Fail::Refused(Error::invalid("a line with this key exists")));
            }
            let (gx, gy) = m.snap(*x, *y).ok_or_else(|| Fail::Refused(Error::invalid("the point is outside the TIN's range")))?;
            let t = match m.locate(gx, gy) {
                Loc::Tri(t) | Loc::Edge(t, _) => t,
                _ => return Err(Fail::Refused(Error::invalid("no edge to swap there"))),
            };
            // The edge of t nearest the point.
            let v = m.tv[t as usize];
            let mut best = (f64::INFINITY, 0usize);
            for i in 0..3 {
                let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
                let dd = seg_dist(*x, *y, m.px(a), m.py(a), m.px(b), m.py(b));
                if dd < best.0 {
                    best = (dd, i);
                }
            }
            let i = best.1;
            if m.te[t as usize][i] & E_CONS != 0 {
                return Err(Fail::Refused(Error::invalid("the edge is on a breakline")));
            }
            let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
            let Some((t2, i2)) = m.find_edge(a, b) else { return Err(Fail::Refused(Error::invalid("no edge to swap there"))) };
            let (u, j) = twin_of(m, t2, i2);
            let p = m.tv[t2 as usize][i2];
            let q = m.tv[u as usize][j];
            if p == INF || q == INF || orient_v(m, p, a, q) <= 0 || orient_v(m, q, b, p) <= 0 {
                return Err(Fail::Refused(Error::invalid("this edge cannot be swapped (the two triangles do not form a convex quadrilateral)")));
            }
            m.flip_pub(t2, i2, u, j);
            m.add_line(*key, SWAP, false, vec![p, q], vec![p, q])?;
            d.changed = 1;
        }
        Op::Retri { ring } => {
            if ring.len() < 3 || !ring.iter().all(|p| fin(p)) {
                return Err(Fail::Refused(Error::invalid("a ring needs three finite corners")));
            }
            let r: Vec<(f64, f64)> = ring.iter().map(|p| (p[0], p[1])).collect();
            let inside = |m: &Mesh, v: u32| v != INF && point_in_ring(m.px(v), m.py(v), &r);
            let swaps: Vec<u32> = (0..m.lines.len() as u32).filter(|&l| {
                let ln = &m.lines[l as usize];
                ln.alive && ln.kind == SWAP && ln.path.iter().any(|&v| inside(m, v))
            }).collect();
            for l in swaps {
                m.remove_line(l)?;
                d.changed += 1;
            }
            let mut edges = Vec::new();
            for t in m.triangles().collect::<Vec<_>>() {
                let v = m.tv[t as usize];
                if v.iter().any(|&w| inside(m, w)) {
                    for i in 0..3 {
                        edges.push((v[(i + 1) % 3], v[(i + 2) % 3]));
                    }
                }
            }
            let before = m.stats.flips;
            m.legalize_pub(edges);
            d.changed += (m.stats.flips - before) as usize;
        }
    }
    Ok(d)
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let s = if l2 > 0.0 { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) } else { 0.0 };
    ((px - ax - s * dx).powi(2) + (py - ay - s * dy).powi(2)).sqrt()
}

fn orient_v(m: &Mesh, a: u32, b: u32, c: u32) -> i32 {
    let (a, b, c) = (a as usize, b as usize, c as usize);
    crate::pred::orient(m.x[a], m.y[a], m.x[b], m.y[b], m.x[c], m.y[c])
}
fn twin_of(m: &Mesh, t: u32, i: usize) -> (u32, usize) {
    let v = m.tv[t as usize];
    let (a, b) = (v[(i + 1) % 3], v[(i + 2) % 3]);
    let u = m.tn[t as usize][i];
    let w = m.tv[u as usize];
    let j = (0..3).find(|&j| w[(j + 1) % 3] == b && w[(j + 2) % 3] == a).unwrap_or(0);
    (u, j)
}

/// The mass point nearest (x, y) within r that no line uses.
fn pick_mass(m: &mut Mesh, x: f64, y: f64, r: f64) -> Res<u32> {
    if !fin(&[x, y, r]) || r < 0.0 {
        return Err(Fail::Refused(Error::invalid("a point needs finite x, y and z")));
    }
    let r = r.max(m.q);
    let v = m.nearest_vertex(x, y, r, V_MASS).ok_or_else(|| Fail::Refused(Error::invalid("no mass point there")))?;
    if m.vl[v as usize] > 0 {
        return Err(Fail::Refused(Error::invalid("the point is on a breakline: edit the breakline instead")));
    }
    Ok(v)
}

fn check_line(m: &Mesh, kind: u8, closed: bool, pts: &[[f64; 3]]) -> Res<()> {
    if !(kind == HARD || kind == SOFT || is_region(kind)) {
        return Err(Fail::Refused(Error::invalid("unknown line kind")));
    }
    if pts.len() < 2 || (closed && pts.len() < 3) || (is_region(kind) && !closed) {
        return Err(Fail::Refused(Error::invalid("a line needs two vertices (a ring three)")));
    }
    for p in pts {
        if !(p[0].is_finite() && p[1].is_finite()) || m.snap(p[0], p[1]).is_none() {
            return Err(Fail::Refused(Error::invalid("the line is outside the TIN's range")));
        }
        if carries_z(kind) && !p[2].is_finite() {
            return Err(Fail::Refused(Error::invalid("a hard breakline needs a height at every vertex")));
        }
    }
    Ok(())
}

fn add_line(m: &mut Mesh, key: u64, kind: u8, closed: bool, pts: &[[f64; 3]], d: &mut Done) -> Res<u32> {
    if m.by_key.contains_key(&key) {
        return Err(Fail::Refused(Error::invalid("a line with this key exists")));
    }
    check_line(m, kind, closed, pts)?;
    // Soft lines and rings take their heights from the surface: every vertex must be on it.
    let mut p3 = pts.to_vec();
    if !carries_z(kind) {
        for p in p3.iter_mut() {
            let z = m.height_at(p[0], p[1]);
            if !z.is_finite() {
                return Err(Fail::Refused(Error::invalid("the line leaves the surface")));
            }
            p[2] = z;
        }
    }
    insert_line(m, key, kind, closed, &p3, d)
}

/// Insert the line: a densified line (soft, ring, ridge, drain) is traced on the TIN as it is
/// first, so its stations carry the surface's heights; then the vertices go in (reusing a vertex
/// at the same grid point; a height-carrying line sets its height there) and the line.
fn insert_line(m: &mut Mesh, key: u64, kind: u8, closed: bool, p3: &[[f64; 3]], d: &mut Done) -> Res<u32> {
    let draped = !carries_z(kind) || kind == DRAIN || kind == RIDGE;
    let g: Vec<(i64, i64)> = p3.iter().map(|p| m.snap(p[0], p[1]).ok_or_else(|| Fail::Refused(Error::invalid("the line is outside the TIN's range")))).collect::<Res<_>>()?;
    let n = p3.len();
    let segs = if closed { n } else { n - 1 };
    // (station, is a defining vertex, index of the defining vertex)
    let mut seq: Vec<(St, bool, usize)> = Vec::with_capacity(n);
    for k in 0..n {
        seq.push((St::P(g[k].0, g[k].1, p3[k][2]), true, k));
        if draped && k < segs {
            for st in m.trace_pts(g[k], g[(k + 1) % n])? {
                seq.push((st, false, k));
            }
        }
    }
    let before = m.alive_vertices();
    let mut defs = Vec::with_capacity(n);
    let mut via = Vec::with_capacity(seq.len());
    for (st, is_def, _) in seq {
        let v = match st {
            St::V(v) => v,
            St::P(gx, gy, z) => {
                let loc = m.locate(gx, gy);
                match loc {
                    Loc::Vert(w) => {
                        if is_def && carries_z(kind) {
                            m.z[w as usize] = z;
                        }
                        w
                    }
                    _ => m.insert_at(loc, gx, gy, z, V_LINE).map_err(|_| Fail::Broken(Error::invalid("a line vertex could not be inserted")))?,
                }
            }
        };
        if is_def {
            defs.push(v);
        }
        via.push(v);
    }
    let l = m.add_line(key, kind, closed, defs, via)?;
    d.added += m.alive_vertices().saturating_sub(before);
    Ok(l)
}

/// Apply every edit of a list: (index, result) for each.
pub fn apply_all(m: &mut Mesh, ops: &[Op]) -> Vec<Res<Done>> {
    ops.iter().map(|op| apply(m, op)).collect()
}
