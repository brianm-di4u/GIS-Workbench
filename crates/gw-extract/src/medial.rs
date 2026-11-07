//! Medial axis of a polygon (REQ-MEN-08): length along the axis and width across it, for roads,
//! rivers, runways and long buildings. The polygon (metric x, y) is rasterised; an exact
//! Euclidean distance transform (Felzenszwalb–Huttenlocher) gives the distance to the boundary;
//! Zhang–Suen thinning gives the skeleton; the longest skeleton path is the axis. Its length is
//! extended at both ends by the distance there (the thinned axis stops half a width short of
//! the boundary), and the width is twice the mean distance along the axis.

use gw_abi::{Error, Result};

/// A medial-axis measurement.
#[derive(Debug, Clone)]
pub struct Medial {
    pub length: f64,
    pub mean_width: f64,
    pub max_width: f64,
    pub min_width: f64,
    /// Axis polyline (metric), end to end.
    pub path: Vec<[f64; 2]>,
    pub cell: f64,
}

fn point_in(r: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = r.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (r[i][0], r[i][1]);
        let (xj, yj) = (r[j][0], r[j][1]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// 1-D squared distance transform of f (Felzenszwalb–Huttenlocher lower envelope).
fn dt1(f: &[f64], out: &mut [f64]) {
    let n = f.len();
    let mut v = vec![0usize; n];
    let mut z = vec![0f64; n + 1];
    let mut k = 0usize;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    let sect = |q: usize, p: usize| ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64)) / (2.0 * q as f64 - 2.0 * p as f64);
    for q in 1..n {
        let mut s = sect(q, v[k]);
        while s <= z[k] {
            k -= 1; // z[0] = −∞ stops this at k = 0
            s = sect(q, v[k]);
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, o) in out.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let p = v[k];
        *o = (q as f64 - p as f64).powi(2) + f[p];
    }
}

/// Euclidean distance (in cells) of every inside cell to the nearest outside cell.
fn distance(mask: &[bool], w: usize, h: usize) -> Vec<f64> {
    let big = 1e20;
    let mut g = vec![0f64; w * h];
    let mut col = vec![0f64; h];
    let mut tmp = vec![0f64; h.max(w)];
    for x in 0..w {
        for y in 0..h {
            col[y] = if mask[y * w + x] { big } else { 0.0 };
        }
        dt1(&col, &mut tmp[..h]);
        for y in 0..h {
            g[y * w + x] = tmp[y];
        }
    }
    let mut row = vec![0f64; w];
    for y in 0..h {
        row.copy_from_slice(&g[y * w..(y + 1) * w]);
        dt1(&row, &mut tmp[..w]);
        for x in 0..w {
            g[y * w + x] = tmp[x].sqrt();
        }
    }
    g
}

/// Zhang–Suen thinning of a binary image (in place).
fn thin(m: &mut [bool], w: usize, h: usize) {
    let at = |m: &[bool], x: isize, y: isize| -> bool { x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && m[y as usize * w + x as usize] };
    loop {
        let mut changed = false;
        for step in 0..2 {
            let mut del = Vec::new();
            for y in 0..h as isize {
                for x in 0..w as isize {
                    if !at(m, x, y) {
                        continue;
                    }
                    let p = [at(m, x, y - 1), at(m, x + 1, y - 1), at(m, x + 1, y), at(m, x + 1, y + 1), at(m, x, y + 1), at(m, x - 1, y + 1), at(m, x - 1, y), at(m, x - 1, y - 1)];
                    let b = p.iter().filter(|&&v| v).count();
                    if !(2..=6).contains(&b) {
                        continue;
                    }
                    let a = (0..8).filter(|&i| !p[i] && p[(i + 1) % 8]).count();
                    if a != 1 {
                        continue;
                    }
                    let ok = if step == 0 { !(p[0] && p[2] && p[4]) && !(p[2] && p[4] && p[6]) } else { !(p[0] && p[2] && p[6]) && !(p[0] && p[4] && p[6]) };
                    if ok {
                        del.push(y as usize * w + x as usize);
                    }
                }
            }
            if !del.is_empty() {
                changed = true;
            }
            for i in del {
                m[i] = false;
            }
        }
        if !changed {
            break;
        }
    }
}

/// Medial axis of a ring (metric, open or closed) on a grid of about `cells` across its longer side.
pub fn medial_axis(ring: &[[f64; 2]], cells: usize) -> Result<Medial> {
    if ring.len() < 3 {
        return Err(Error::invalid("a polygon needs at least 3 vertices"));
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in ring {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let span = (x1 - x0).max(y1 - y0);
    if span <= 0.0 {
        return Err(Error::invalid("the polygon is degenerate"));
    }
    let cells = cells.clamp(64, 1500);
    let cell = span / cells as f64;
    let w = ((x1 - x0) / cell).ceil() as usize + 4;
    let h = ((y1 - y0) / cell).ceil() as usize + 4;
    let ox = x0 - 2.0 * cell;
    let oy = y0 - 2.0 * cell;
    let centre = |i: usize, j: usize| [ox + (i as f64 + 0.5) * cell, oy + (j as f64 + 0.5) * cell];
    let mut mask = vec![false; w * h];
    for j in 0..h {
        for i in 0..w {
            let c = centre(i, j);
            mask[j * w + i] = point_in(ring, c[0], c[1]);
        }
    }
    if !mask.iter().any(|&v| v) {
        return Err(Error::invalid("the polygon covers no grid cell"));
    }
    let dist = distance(&mask, w, h);
    let mut sk = mask.clone();
    thin(&mut sk, w, h);
    // Longest path in the skeleton graph (8-connected): BFS from any node, then from the farthest.
    let nodes: Vec<usize> = (0..w * h).filter(|&i| sk[i]).collect();
    if nodes.is_empty() {
        return Err(Error::invalid("no skeleton"));
    }
    let nb = |i: usize| -> Vec<(usize, f64)> {
        let (x, y) = ((i % w) as isize, (i / w) as isize);
        let mut out = Vec::new();
        for dy in -1..=1isize {
            for dx in -1..=1isize {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let (nx, ny) = (x + dx, y + dy);
                if nx >= 0 && ny >= 0 && (nx as usize) < w && (ny as usize) < h {
                    let k = ny as usize * w + nx as usize;
                    if sk[k] {
                        out.push((k, if dx != 0 && dy != 0 { std::f64::consts::SQRT_2 } else { 1.0 }));
                    }
                }
            }
        }
        out
    };
    // Dijkstra over the (small) skeleton for path lengths.
    let far = |src: usize| -> (usize, Vec<f64>, Vec<usize>) {
        let mut d = vec![f64::INFINITY; w * h];
        let mut prev = vec![usize::MAX; w * h];
        d[src] = 0.0;
        let mut heap = std::collections::BinaryHeap::new();
        heap.push((std::cmp::Reverse(0u64), src));
        while let Some((std::cmp::Reverse(dk), u)) = heap.pop() {
            let du = dk as f64 / 1e6;
            if du > d[u] + 1e-9 {
                continue;
            }
            for (v, c) in nb(u) {
                let nd = du + c;
                if nd < d[v] - 1e-12 {
                    d[v] = nd;
                    prev[v] = u;
                    heap.push((std::cmp::Reverse((nd * 1e6) as u64), v));
                }
            }
        }
        let best = nodes.iter().copied().filter(|&k| d[k].is_finite()).max_by(|a, b| d[*a].total_cmp(&d[*b])).unwrap_or(src);
        (best, d, prev)
    };
    // Start from the deepest skeleton cell so the component is the main one.
    let start = nodes.iter().copied().max_by(|a, b| dist[*a].total_cmp(&dist[*b])).unwrap();
    let (a, _, _) = far(start);
    let (b, d, prev) = far(a);
    let mut path_idx = vec![b];
    let mut k = b;
    while k != a && prev[k] != usize::MAX {
        k = prev[k];
        path_idx.push(k);
    }
    // Trim corner spurs: from each end, drop cells whose distance is below 80 % of the median
    // (a spur runs from the axis into a corner, its distance falling to zero).
    let mut ds: Vec<f64> = path_idx.iter().map(|&i| dist[i]).collect();
    ds.sort_by(|x, y| x.total_cmp(y));
    let med = ds[ds.len() / 2];
    let mut lo = 0;
    let mut hi = path_idx.len() - 1;
    while lo < hi && dist[path_idx[lo]] < 0.8 * med {
        lo += 1;
    }
    while hi > lo && dist[path_idx[hi]] < 0.8 * med {
        hi -= 1;
    }
    let path_idx: Vec<usize> = path_idx[lo..=hi].to_vec();
    // Length along straight chords every few cells: 8-connected steps overstate a slanted line
    // (by 8 % at 23°), chords over ~half a width do not, and still follow a curve.
    let step = ((0.5 * med).round() as usize).clamp(3, 50);
    let mut picks: Vec<usize> = (0..path_idx.len()).step_by(step).collect();
    if *picks.last().unwrap() != path_idx.len() - 1 {
        picks.push(path_idx.len() - 1);
    }
    let mut along = 0.0;
    for w2 in picks.windows(2) {
        let (a0, b0) = (path_idx[w2[0]], path_idx[w2[1]]);
        along += (((a0 % w) as f64) - ((b0 % w) as f64)).hypot(((a0 / w) as f64) - ((b0 / w) as f64));
    }
    let along = along * cell;
    let ends = (dist[path_idx[0]] + dist[*path_idx.last().unwrap()]) * cell;
    let ws: Vec<f64> = path_idx.iter().map(|&i| 2.0 * dist[i] * cell).collect();
    let mean = ws.iter().sum::<f64>() / ws.len() as f64;
    let _ = (d, b);
    Ok(Medial {
        length: along + ends,
        mean_width: mean,
        max_width: ws.iter().cloned().fold(0.0, f64::max),
        min_width: ws.iter().cloned().fold(f64::MAX, f64::min),
        path: path_idx.iter().map(|&i| centre(i % w, i / w)).collect(),
        cell,
    })
}
