//! Buildings and trees from a DSM (REQ-EXT-16, AC-10.4; Research/13 §3.2): the normalised DSM
//! (DSM − DTM) above a height threshold, split by surface roughness (the RMS residual of a local
//! plane: roofs are planar, canopies are not), connected components of the smooth part grown back
//! over their walls, a crack-following trace of each component's outline, Douglas–Peucker
//! simplification, right-angle squaring, and the median height. Rough components become trees at
//! their highest post. Coordinates are metres from post (0, 0): x east, y north.

use crate::Grid;

#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// Lowest object height above the ground (m), smallest building (m²) and tree crown (m²).
    pub min_height: f64,
    pub min_area: f64,
    pub min_tree_area: f64,
    /// Largest plane residual for a roof post (m).
    pub roughness: f64,
    /// Outline simplification tolerance (m) and squaring on/off.
    pub simplify: f64,
    pub square: bool,
}

impl Default for Params {
    fn default() -> Self {
        Params { min_height: 2.5, min_area: 25.0, min_tree_area: 3.0, roughness: 0.15, simplify: 0.8, square: true }
    }
}

#[derive(Clone, Debug)]
pub struct Building {
    pub ring: Vec<[f64; 2]>,
    pub height: f64,
    pub area: f64,
    pub posts: usize,
    pub squared: bool,
    pub corner_error_deg: f64,
}

#[derive(Clone, Debug)]
pub struct Tree {
    pub at: [f64; 2],
    pub height: f64,
    pub crown: f64,
}

/// RMS residual of the least-squares plane through the 3 × 3 posts around each post.
fn roughness(g: &Grid<'_>) -> Vec<f32> {
    let (w, h) = (g.w, g.h);
    let mut out = vec![f32::INFINITY; w * h];
    for y in 1..h.saturating_sub(1) {
        for x in 1..w.saturating_sub(1) {
            let mut z = [0f64; 9];
            let mut ok = true;
            for dy in 0..3 {
                for dx in 0..3 {
                    let v = g.z[(y + dy - 1) * w + x + dx - 1];
                    if !v.is_finite() {
                        ok = false;
                    }
                    z[dy * 3 + dx] = f64::from(v);
                }
            }
            if !ok {
                continue;
            }
            // Plane z = a + b·u + c·v on u, v ∈ {−1, 0, 1}: closed-form fit.
            let mean = z.iter().sum::<f64>() / 9.0;
            let b = (z[2] + z[5] + z[8] - z[0] - z[3] - z[6]) / 6.0;
            let c = (z[6] + z[7] + z[8] - z[0] - z[1] - z[2]) / 6.0;
            let mut ss = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    let r = z[dy * 3 + dx] - (mean + b * (dx as f64 - 1.0) + c * (dy as f64 - 1.0));
                    ss += r * r;
                }
            }
            out[y * w + x] = (ss / 9.0).sqrt() as f32;
        }
    }
    out
}

/// 8-connected components of `mask`; returns labels (0 = none) and the count.
fn components(mask: &[bool], w: usize, h: usize) -> (Vec<u32>, u32) {
    let mut lab = vec![0u32; w * h];
    let mut n = 0u32;
    let mut stack = Vec::new();
    for s in 0..w * h {
        if !mask[s] || lab[s] != 0 {
            continue;
        }
        n += 1;
        lab[s] = n;
        stack.push(s);
        while let Some(k) = stack.pop() {
            let (x, y) = ((k % w) as i64, (k / w) as i64);
            for dy in -1..=1i64 {
                for dx in -1..=1i64 {
                    let (xx, yy) = (x + dx, y + dy);
                    if xx < 0 || yy < 0 || xx >= w as i64 || yy >= h as i64 {
                        continue;
                    }
                    let q = yy as usize * w + xx as usize;
                    if mask[q] && lab[q] == 0 {
                        lab[q] = n;
                        stack.push(q);
                    }
                }
            }
        }
    }
    (lab, n)
}

/// Outer outline of the posts labelled `id` (4-connected cells), along cell edges, as corners in
/// post units (cell (i, j) spans i−½ … i+½). Counter-clockwise in (x east, y north).
fn trace(lab: &[u32], w: usize, h: usize, id: u32, start: usize) -> Vec<[f64; 2]> {
    let inside = |x: i64, y: i64| x >= 0 && y >= 0 && x < w as i64 && y < h as i64 && lab[y as usize * w + x as usize] == id;
    // Start at the top edge of the first (top-left) cell, walking east; corners (cx, cy) are
    // cell-corner indices: corner (cx, cy) sits at x = cx − ½, row y = cy − ½ (rows grow south).
    let (sx, sy) = ((start % w) as i64, (start / w) as i64);
    let mut out = Vec::new();
    let (mut cx, mut cy) = (sx, sy);
    // Direction: 0 east, 1 south, 2 west, 3 north (in rows/cols).
    let mut d = 0i64;
    let dirs = [(1i64, 0i64), (0, 1), (-1, 0), (0, -1)];
    let limit = 8 * (w + h) * 4 + 16 * lab.iter().filter(|&&v| v == id).count();
    for _ in 0..limit {
        out.push([cx as f64 - 0.5, -(cy as f64 - 0.5)]);
        // Cells around corner (cx, cy): ahead-left and ahead-right relative to direction d.
        // With the region kept on the right (clockwise in rows = counter-clockwise in north-up),
        // try turning left, straight, right.
        let cell = |dd: i64| -> (bool, bool) {
            // For moving from corner (cx,cy) in direction dd: the cell to the right of the edge
            // and the cell to the left.
            let (ddx, ddy) = dirs[dd.rem_euclid(4) as usize];
            let (r, l) = match (ddx, ddy) {
                (1, 0) => ((cx, cy), (cx, cy - 1)),
                (0, 1) => ((cx - 1, cy), (cx, cy)),
                (-1, 0) => ((cx - 1, cy - 1), (cx - 1, cy)),
                _ => ((cx, cy - 1), (cx - 1, cy - 1)),
            };
            (inside(r.0, r.1), inside(l.0, l.1))
        };
        let mut moved = false;
        for turn in [1i64, 0, -1, 2] {
            let nd = (d + turn).rem_euclid(4);
            let (r, l) = cell(nd);
            if r && !l {
                d = nd;
                let (ddx, ddy) = dirs[d as usize];
                cx += ddx;
                cy += ddy;
                moved = true;
                break;
            }
        }
        if !moved || (cx == sx && cy == sy) {
            break;
        }
    }
    // Drop collinear corners.
    let n = out.len();
    let mut r = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b, c) = (out[(i + n - 1) % n], out[i], out[(i + 1) % n]);
        if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])).abs() > 1e-9 {
            r.push(b);
        }
    }
    r
}

fn area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

/// Extract buildings and trees. `ndsm` = DSM − DTM; `dsm` the surface (for roughness).
pub fn extract(dsm: &Grid<'_>, ndsm: &[f32], p: &Params) -> (Vec<Building>, Vec<Tree>) {
    let (w, h) = (dsm.w, dsm.h);
    let rough = roughness(dsm);
    let cell_area = dsm.cell_x * dsm.cell_y;
    let above: Vec<bool> = ndsm.iter().map(|v| v.is_finite() && f64::from(*v) > p.min_height).collect();
    let smooth: Vec<bool> = (0..w * h).map(|k| above[k] && f64::from(rough[k]) <= p.roughness).collect();
    let (core, nc) = components(&smooth, w, h);
    // Per core component: size and median height.
    let mut heights: Vec<Vec<f32>> = vec![Vec::new(); nc as usize + 1];
    for k in 0..w * h {
        if core[k] > 0 {
            heights[core[k] as usize].push(ndsm[k]);
        }
    }
    let median = |v: &mut Vec<f32>| -> f64 {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        f64::from(v[v.len() / 2])
    };
    let mut keep = vec![false; nc as usize + 1];
    let mut med = vec![0f64; nc as usize + 1];
    for id in 1..=nc as usize {
        // A building core needs some size of its own.
        if (heights[id].len() as f64) * cell_area >= p.min_area * 0.4 {
            keep[id] = true;
            med[id] = median(&mut heights[id]);
        }
    }
    // Grow kept cores over adjacent above-ground posts of similar height (walls and eaves).
    let mut lab: Vec<u32> = core.iter().map(|&c| if keep[c as usize] { c } else { 0 }).collect();
    for _ in 0..2 {
        let prev = lab.clone();
        for y in 0..h {
            for x in 0..w {
                let k = y * w + x;
                if prev[k] != 0 || !above[k] {
                    continue;
                }
                let mut best = 0u32;
                for (dx, dy) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                    let (xx, yy) = (x as i64 + dx, y as i64 + dy);
                    if xx < 0 || yy < 0 || xx >= w as i64 || yy >= h as i64 {
                        continue;
                    }
                    let c = prev[yy as usize * w + xx as usize];
                    if c != 0 && (f64::from(ndsm[k]) - med[c as usize]).abs() < 1.5 {
                        best = c;
                    }
                }
                lab[k] = best;
            }
        }
    }
    let mut buildings = Vec::new();
    let mut first = vec![usize::MAX; nc as usize + 1];
    let mut count = vec![0usize; nc as usize + 1];
    for k in 0..w * h {
        let c = lab[k] as usize;
        if c > 0 {
            count[c] += 1;
            if first[c] == usize::MAX {
                first[c] = k;
            }
        }
    }
    for id in 1..=nc as usize {
        if !keep[id] || (count[id] as f64) * cell_area < p.min_area {
            continue;
        }
        // Roofs are mostly planar: most of the grown outline must be smooth posts (canopies are not).
        if (heights[id].len() as f64) < 0.5 * count[id] as f64 {
            keep[id] = false;
            continue;
        }
        let corners = trace(&lab, w, h, id as u32, first[id]);
        if corners.len() < 3 {
            continue;
        }
        let mut ring: Vec<[f64; 2]> = corners.iter().map(|c| [c[0] * dsm.cell_x, c[1] * dsm.cell_y]).collect();
        if area(&ring) < 0.0 {
            ring.reverse();
        }
        // Simplify as a closed ring: split at the vertex farthest from the first.
        let far = (0..ring.len()).max_by(|&a, &b| {
            let da = (ring[a][0] - ring[0][0]).hypot(ring[a][1] - ring[0][1]);
            let db = (ring[b][0] - ring[0][0]).hypot(ring[b][1] - ring[0][1]);
            da.partial_cmp(&db).unwrap()
        });
        let far = far.unwrap_or(0);
        let mut a1: Vec<[f64; 2]> = ring[..=far].to_vec();
        let mut a2: Vec<[f64; 2]> = ring[far..].to_vec();
        a2.push(ring[0]);
        let k1 = gw_extract::simplify(&a1, p.simplify);
        let k2 = gw_extract::simplify(&a2, p.simplify);
        a1 = k1.iter().map(|&i| a1[i]).collect();
        a2 = k2.iter().map(|&i| a2[i]).collect();
        let mut simp = a1;
        simp.extend_from_slice(&a2[1..a2.len() - 1]);
        let mut squared = false;
        let mut err = f64::NAN;
        // A near-rectangular outline becomes its minimum-area rectangle (four exact corners).
        let rect = if p.square { gw_extract::min_area_rect(&simp).ok() } else { None };
        if let Some(r) = rect.filter(|r| area(&r.ring).abs() <= 1.2 * area(&simp).abs()) {
            simp = r.ring;
            squared = true;
            err = r.max_corner_error_deg;
        } else if p.square && simp.len() >= 4 {
            if let Ok(s) = gw_extract::square(&simp, false) {
                // Keep the squared outline unless it moved the area much.
                if (area(&s.ring).abs() - area(&simp).abs()).abs() < 0.25 * area(&simp).abs() {
                    simp = s.ring;
                    squared = true;
                    err = s.max_corner_error_deg;
                }
            }
        }
        // Squaring can leave collinear vertices on straight walls: drop them.
        let n0 = simp.len();
        let mut clean: Vec<[f64; 2]> = Vec::with_capacity(n0);
        for i in 0..n0 {
            let (a, b, c) = (simp[(i + n0 - 1) % n0], simp[i], simp[(i + 1) % n0]);
            let (u, v) = ([b[0] - a[0], b[1] - a[1]], [c[0] - b[0], c[1] - b[1]]);
            let sin = (u[0] * v[1] - u[1] * v[0]) / (u[0].hypot(u[1]) * v[0].hypot(v[1])).max(1e-12);
            if sin.abs() > 0.02 {
                clean.push(b);
            }
        }
        if clean.len() >= 3 {
            simp = clean;
        }
        buildings.push(Building { area: area(&simp).abs(), ring: simp, height: med[id], posts: count[id], squared, corner_error_deg: err });
    }
    // Trees: rough above-ground components outside buildings.
    let rough_mask: Vec<bool> = (0..w * h).map(|k| above[k] && lab[k] == 0 && !smooth[k] || (above[k] && lab[k] == 0 && core[k] != 0 && !keep[core[k] as usize])).collect();
    let (tl, nt) = components(&rough_mask, w, h);
    let mut best = vec![(f32::MIN, 0usize, 0usize); nt as usize + 1];
    for k in 0..w * h {
        let t = tl[k] as usize;
        if t == 0 {
            continue;
        }
        best[t].2 += 1;
        if ndsm[k] > best[t].0 {
            best[t].0 = ndsm[k];
            best[t].1 = k;
        }
    }
    let mut trees = Vec::new();
    for (hmax, k, n) in best.into_iter().skip(1) {
        let a = n as f64 * cell_area;
        if a < p.min_tree_area {
            continue;
        }
        let (x, y) = ((k % w) as f64 * dsm.cell_x, -((k / w) as f64) * dsm.cell_y);
        trees.push(Tree { at: [x, y], height: f64::from(hmax), crown: 2.0 * (a / std::f64::consts::PI).sqrt() });
    }
    (buildings, trees)
}
