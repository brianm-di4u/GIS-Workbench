//! A file's own triangulation (REQ-GAP-39 as amended by OD-2.41: LandXML import keeps the file's
//! triangles). The TIN is built through the file's points as usual; then every face edge the build
//! does not have is forced (a swapped edge, so Re-triangulate an area can undo it), and when some
//! triangles are not visible faces of the file (outside a concave outline, in a hole, or hidden
//! with `i="1"`), the outline and holes of the visible faces become face rings (`FRING`), which
//! exclude everything else. A valid file comes back face for face, with its own heights.

use crate::mesh::{Fail, Loc, Map, Mesh, Res, FRING, INF, NONE, SWAP};
use crate::pred::orient;

/// What keeping the faces did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Kept {
    /// Faces in the file.
    pub faces: usize,
    /// Faces left out: a corner is not a TIN vertex, two corners are one vertex, or the three are on one line.
    pub skipped: usize,
    /// Face edges the build did not have, forced.
    pub forced: usize,
    /// Outline and hole rings made.
    pub rings: usize,
    /// Visible faces that are triangles of the TIN afterwards.
    pub kept: usize,
}

/// The first line key of forced edges and rings (above any key the app gives an edit).
pub const KEY0: u64 = 1 << 40;

const fn dkey(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

/// Keep the faces of a file in `m`, which was built through the file's points. `pts` = x, y, z per
/// point (plane metres), `faces` = three 0-based point indices per face, `hidden` = one flag per
/// face (non-zero: hidden). Forced edges and rings take line keys from `key0` up.
pub fn keep_faces(m: &mut Mesh, pts: &[f64], faces: &[u32], hidden: &[u8], key0: u64) -> Res<Kept> {
    let n = pts.len() / 3;
    let mut vid = vec![NONE; n];
    for (k, v) in vid.iter_mut().enumerate() {
        if let Some((gx, gy)) = m.snap(pts[3 * k], pts[3 * k + 1]) {
            if let Loc::Vert(w) = m.locate(gx, gy) {
                *v = w;
            }
        }
    }
    let nf = faces.len() / 3;
    let mut r = Kept { faces: nf, ..Default::default() };
    // Directed edge a → b of a counter-clockwise face → (its third corner, visible).
    let mut dir: Map<u64, (u32, bool)> = Map::default();
    let mut tris: Vec<[u32; 3]> = Vec::with_capacity(nf);
    for f in 0..nf {
        let c = [faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]];
        if c.iter().any(|&i| i as usize >= n) {
            r.skipped += 1;
            continue;
        }
        let v = c.map(|i| vid[i as usize]);
        if v.contains(&NONE) || v[0] == v[1] || v[1] == v[2] || v[0] == v[2] {
            r.skipped += 1;
            continue;
        }
        let o = orient(m.x[v[0] as usize], m.y[v[0] as usize], m.x[v[1] as usize], m.y[v[1] as usize], m.x[v[2] as usize], m.y[v[2] as usize]);
        if o == 0 {
            r.skipped += 1;
            continue;
        }
        let t = if o > 0 { v } else { [v[0], v[2], v[1]] };
        let vis = hidden.get(f).copied().unwrap_or(0) == 0;
        for i in 0..3 {
            dir.insert(dkey(t[i], t[(i + 1) % 3]), (t[(i + 2) % 3], vis));
        }
        tris.push(t);
    }
    // Force the edges the build does not have.
    let mut key = key0;
    let mut seen: Map<u64, ()> = Map::default();
    for t in &tris {
        for i in 0..3 {
            let (a, b) = (t[i], t[(i + 1) % 3]);
            if seen.insert(crate::mesh::ekey(a, b), ()).is_some() || m.find_edge(a, b).is_some() || m.find_edge(b, a).is_some() {
                continue;
            }
            m.add_line(key, SWAP, false, vec![a, b], vec![a, b])?;
            key += 1;
            r.forced += 1;
        }
    }
    // Is every triangle a visible face? Then the TIN is the file's surface as it stands.
    let mut all = true;
    for t in m.triangles().collect::<Vec<_>>() {
        let v = m.tv[t as usize];
        if (0..3).any(|i| dir.get(&dkey(v[i], v[(i + 1) % 3])) == Some(&(v[(i + 2) % 3], true))) {
            r.kept += 1;
        } else {
            all = false;
        }
    }
    if all {
        return Ok(r);
    }
    // Boundary edges of the visible faces (face on the left), traced into rings. At a vertex where
    // two rings touch, the next edge is the first clockwise from the way back, so each ring is simple.
    let vis_edge = |a: u32, b: u32| matches!(dir.get(&dkey(a, b)), Some((_, true)));
    let mut out: Map<u64, Vec<u32>> = Map::default();
    let mut nb = 0usize;
    for (&k, &(_, vis)) in &dir {
        let (a, b) = ((k >> 32) as u32, k as u32);
        if vis && !vis_edge(b, a) {
            out.entry(a as u64).or_default().push(b);
            nb += 1;
        }
    }
    for l in out.values_mut() {
        l.sort_unstable();
    }
    let mut starts: Vec<u64> = out.keys().copied().collect();
    starts.sort_unstable();
    let ang = |m: &Mesh, from: u32, to: u32| ((m.y[to as usize] - m.y[from as usize]) as f64).atan2((m.x[to as usize] - m.x[from as usize]) as f64);
    let mut used = 0usize;
    for s in starts {
        while let Some(&b0) = out.get(&s).and_then(|l| l.first()) {
            let a0 = s as u32;
            take(&mut out, a0, b0);
            let mut ring = vec![a0];
            let (mut a, mut b) = (a0, b0);
            used += 1;
            while b != a0 {
                ring.push(b);
                let back = ang(m, b, a);
                let Some(list) = out.get(&(b as u64)) else { return Err(Fail::Refused(crate::err::Error::invalid("the file's faces have an open outline"))) };
                // Clockwise turn from the way back to each candidate, in (0, 2π].
                let w = *list
                    .iter()
                    .min_by(|&&p, &&q| {
                        let cw = |w: u32| {
                            let d = back - ang(m, b, w);
                            let d = d.rem_euclid(std::f64::consts::TAU);
                            if d == 0.0 { std::f64::consts::TAU } else { d }
                        };
                        cw(p).total_cmp(&cw(q))
                    })
                    .unwrap_or(&INF);
                take(&mut out, b, w);
                used += 1;
                (a, b) = (b, w);
                if used > nb {
                    return Err(Fail::Refused(crate::err::Error::invalid("the file's faces have an open outline")));
                }
            }
            if ring.len() >= 3 {
                m.add_line(key, FRING, true, ring.clone(), ring)?;
                key += 1;
                r.rings += 1;
            }
        }
    }
    Ok(r)
}

fn take(out: &mut Map<u64, Vec<u32>>, a: u32, b: u32) {
    if let Some(l) = out.get_mut(&(a as u64)) {
        if let Some(k) = l.iter().position(|&w| w == b) {
            l.remove(k);
        }
        if l.is_empty() {
            out.remove(&(a as u64));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::make::from_points;
    use crate::mesh::{T_EXCL, VOID};

    /// Faces of the TIN as sorted corner positions, visible or not.
    fn faces_of(m: &mut Mesh) -> (Vec<[(i64, i64); 3]>, Vec<[(i64, i64); 3]>) {
        m.classify();
        let (mut vis, mut hid) = (Vec::new(), Vec::new());
        for t in m.triangles().collect::<Vec<_>>() {
            let mut c = m.tv[t as usize].map(|v| (m.x[v as usize], m.y[v as usize]));
            c.sort();
            if m.tf[t as usize] & T_EXCL != 0 { hid.push(c) } else { vis.push(c) }
        }
        vis.sort();
        hid.sort();
        (vis, hid)
    }
    fn file_faces(m: &Mesh, pts: &[f64], f: &[u32]) -> Vec<[(i64, i64); 3]> {
        let g = |k: u32| m.snap(pts[3 * k as usize], pts[3 * k as usize + 1]).unwrap();
        let mut v: Vec<_> = f.chunks_exact(3).map(|c| {
            let mut t = [g(c[0]), g(c[1]), g(c[2])];
            t.sort();
            t
        }).collect();
        v.sort();
        v
    }

    #[test]
    fn keeps_a_non_delaunay_concave_triangulation_with_a_hidden_face() {
        // A 3 × 3 grid of points, every square split on the "wrong" diagonal for a Delaunay of the
        // slightly sheared grid, the top-right square left out (a concave L), and one face hidden.
        let mut pts = Vec::new();
        for j in 0..3 {
            for i in 0..3 {
                pts.extend_from_slice(&[i as f64 * 10.0 + j as f64 * 0.7, j as f64 * 10.0, (i * 3 + j) as f64]);
            }
        }
        let id = |i: u32, j: u32| j * 3 + i;
        let mut f = Vec::new();
        for j in 0..2 {
            for i in 0..2 {
                if (i, j) == (1, 1) {
                    continue;
                }
                // Split on (i, j)–(i+1, j+1) ... and the other diagonal, alternating.
                if (i + j) % 2 == 0 {
                    f.extend_from_slice(&[id(i, j), id(i + 1, j), id(i, j + 1), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
                } else {
                    f.extend_from_slice(&[id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
                }
            }
        }
        let (mut m, _) = from_points(&pts, 0.001, 0.0, 1000).unwrap();
        let mut hidden = vec![0u8; f.len() / 3];
        hidden[5] = 1;
        let k = keep_faces(&mut m, &pts, &f, &hidden, 1 << 40).unwrap();
        assert_eq!(k.skipped, 0);
        assert!(k.forced > 0, "{k:?}");
        assert_eq!(k.rings, 1, "the L's outline: the hidden face is on it");
        m.check().unwrap();
        let (vis, hid) = faces_of(&mut m);
        let mut want = file_faces(&m, &pts, &f);
        let gone = file_faces(&m, &pts, &f[15..18]);
        want.retain(|t| !gone.contains(t));
        assert_eq!(vis, want, "every visible face, and nothing else, is surface");
        assert!(hid.contains(&gone[0]), "the hidden face is a triangle, excluded");
        // Heights are the file's: the middle of a face is the mean of its corners.
        let z = m.height_at(10.0 / 3.0 + 0.7 / 3.0, 10.0 / 3.0);
        assert!((z - (0.0 + 3.0 + 1.0) / 3.0).abs() < 1e-6, "{z}");
    }

    #[test]
    fn a_hole_is_a_ring_and_a_convex_delaunay_file_needs_nothing() {
        // A 4 × 4 grid; the centre square has no faces (a hole).
        let mut pts = Vec::new();
        for j in 0..4 {
            for i in 0..4 {
                pts.extend_from_slice(&[i as f64 * 10.0, j as f64 * 10.0 + i as f64 * 0.01, 0.0]);
            }
        }
        let id = |i: u32, j: u32| j * 4 + i;
        let mut f = Vec::new();
        for j in 0..3 {
            for i in 0..3 {
                if (i, j) == (1, 1) {
                    continue;
                }
                f.extend_from_slice(&[id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
            }
        }
        let (mut m, _) = from_points(&pts, 0.001, 0.0, 1000).unwrap();
        let k = keep_faces(&mut m, &pts, &f, &[], 1 << 40).unwrap();
        assert_eq!(k.rings, 2, "{k:?}");
        let (vis, hid) = faces_of(&mut m);
        assert_eq!(vis, file_faces(&m, &pts, &f));
        assert_eq!(hid.len(), 2);
        assert!(m.lines.iter().all(|l| l.kind != VOID));
        // The TIN's own faces back in: nothing to force, no rings.
        let (mut m2, _) = from_points(&pts, 0.001, 0.0, 1000).unwrap();
        let mut own = Vec::new();
        for t in m2.triangles().collect::<Vec<_>>() {
            own.extend(m2.tv[t as usize]);
        }
        let k2 = keep_faces(&mut m2, &pts, &own, &[], 1 << 40).unwrap();
        assert_eq!((k2.forced, k2.rings, k2.kept, k2.skipped), (0, 0, own.len() / 3, 0));
    }
}
