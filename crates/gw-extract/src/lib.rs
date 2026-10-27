//! Feature extraction maths (REQ-EXT-05, REQ-EXT-02, Research/13 §2.5): right-angle building
//! squaring by dominant direction and fixed-direction line fits, a minimum-area rectangle
//! fallback, and Douglas–Peucker thinning. Squaring works in a local metric frame (ENU about
//! the ring's centroid), never on raw longitude and latitude.

pub mod medial;

use gw_abi::{Error, Result};
use gw_geodesy::wgs84;
use std::f64::consts::PI;

/// A squared ring and how it was made.
#[derive(Debug, Clone)]
pub struct Squared {
    pub ring: Vec<[f64; 2]>,
    /// Largest |corner − nearest multiple of the step| in degrees.
    pub max_corner_error_deg: f64,
    /// Main axis in degrees (east = 0, counter-clockwise).
    pub axis_deg: f64,
    pub method: &'static str,
}

fn open_ring(pts: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut v: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    for p in pts {
        if v.last().is_none_or(|q| (q[0] - p[0]).hypot(q[1] - p[1]) > 1e-9) {
            v.push(*p);
        }
    }
    if v.len() > 1 && (v[0][0] - v[v.len() - 1][0]).hypot(v[0][1] - v[v.len() - 1][1]) <= 1e-9 {
        v.pop();
    }
    v
}

/// Signed area (counter-clockwise positive).
pub fn area(r: &[[f64; 2]]) -> f64 {
    let n = r.len();
    (0..n).map(|i| r[i][0] * r[(i + 1) % n][1] - r[(i + 1) % n][0] * r[i][1]).sum::<f64>() / 2.0
}

/// Corner errors of a ring against multiples of `step` (radians); the largest, in degrees.
pub fn max_corner_error(r: &[[f64; 2]], step: f64) -> f64 {
    let n = r.len();
    let mut worst: f64 = 0.0;
    for i in 0..n {
        let a = r[(i + n - 1) % n];
        let b = r[i];
        let c = r[(i + 1) % n];
        let a1 = (a[1] - b[1]).atan2(a[0] - b[0]);
        let a2 = (c[1] - b[1]).atan2(c[0] - b[0]);
        let mut d = (a2 - a1).rem_euclid(2.0 * PI);
        d = (d / step - (d / step).round()).abs() * step;
        worst = worst.max(d);
    }
    worst.to_degrees()
}

/// Square a ring (metric x, y). `diagonals` also allows 45° edges (8-fold classes).
pub fn square(pts: &[[f64; 2]], diagonals: bool) -> Result<Squared> {
    let r = open_ring(pts);
    let n = r.len();
    if n < 3 {
        return Err(Error::invalid("a polygon needs at least 3 distinct vertices"));
    }
    let k = if diagonals { 8.0 } else { 4.0 };
    let step = 2.0 * PI / k;
    let classes = (k / 2.0) as i64; // distinct line orientations mod 180°
    let edges: Vec<(f64, f64, [f64; 2])> = (0..n)
        .map(|i| {
            let a = r[i];
            let b = r[(i + 1) % n];
            ((b[1] - a[1]).atan2(b[0] - a[0]), (b[0] - a[0]).hypot(b[1] - a[1]), [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0])
        })
        .collect();
    // (a) Main axis: length-weighted circular mean of k·angle.
    let (s, c) = edges.iter().fold((0.0, 0.0), |(s, c), (a, l, _)| (s + l * (k * a).sin(), c + l * (k * a).cos()));
    if s.hypot(c) < 1e-12 {
        return Err(Error::invalid("the outline has no dominant direction"));
    }
    let theta = s.atan2(c) / k;
    // (b) Class of each edge: its orientation as a multiple of the step from the axis.
    let class: Vec<i64> = edges.iter().map(|(a, _, _)| (((a - theta) / step).round() as i64).rem_euclid(classes)).collect();
    // (c) Merge cyclic runs of one class.
    let start = (0..n).find(|&i| class[i] != class[(i + n - 1) % n]).ok_or_else(|| Error::invalid("cannot square: every edge has the same direction"))?;
    let mut runs: Vec<(i64, Vec<usize>)> = Vec::new();
    for j in 0..n {
        let i = (start + j) % n;
        match runs.last_mut() {
            Some((cl, v)) if *cl == class[i] => v.push(i),
            _ => runs.push((class[i], vec![i])),
        }
    }
    if runs.len() < if diagonals { 3 } else { 4 } || (!diagonals && runs.len() % 2 == 1) {
        return Err(Error::invalid("cannot square: the edges do not alternate between the two directions (a short jog may be misread)"));
    }
    // Fixed-direction lines through the length-weighted mean offset of each run.
    let lines: Vec<([f64; 2], f64)> = runs
        .iter()
        .map(|(cl, idx)| {
            let phi = theta + *cl as f64 * step;
            let nrm = [-phi.sin(), phi.cos()];
            let (sw, so) = idx.iter().fold((0.0, 0.0), |(sw, so), &i| {
                let (_, l, m) = edges[i];
                (sw + l, so + l * (nrm[0] * m[0] + nrm[1] * m[1]))
            });
            (nrm, if sw > 0.0 { so / sw } else { 0.0 })
        })
        .collect();
    // (d) Corners: intersections of consecutive lines.
    let m = lines.len();
    let mut out = Vec::with_capacity(m);
    for i in 0..m {
        let (n1, o1) = lines[(i + m - 1) % m];
        let (n2, o2) = lines[i];
        let det = n1[0] * n2[1] - n1[1] * n2[0];
        if det.abs() < 1e-9 {
            return Err(Error::invalid("cannot square: two consecutive sides are parallel"));
        }
        out.push([(o1 * n2[1] - o2 * n1[1]) / det, (n1[0] * o2 - n2[0] * o1) / det]);
    }
    let a0 = area(&r);
    let a1 = area(&out);
    if a1 == 0.0 || a0 == 0.0 || a1.signum() != a0.signum() || !(0.5..=2.0).contains(&(a1 / a0)) {
        return Err(Error::invalid("cannot square: the result differs too much from the outline"));
    }
    Ok(Squared { max_corner_error_deg: max_corner_error(&out, step), axis_deg: theta.to_degrees(), ring: out, method: if diagonals { "right angles and diagonals" } else { "right angles" } })
}

fn hull(p: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut v = p.to_vec();
    v.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lo: Vec<[f64; 2]> = Vec::new();
    for &q in &v {
        while lo.len() >= 2 && cross(lo[lo.len() - 2], lo[lo.len() - 1], q) <= 0.0 {
            lo.pop();
        }
        lo.push(q);
    }
    let mut up: Vec<[f64; 2]> = Vec::new();
    for &q in v.iter().rev() {
        while up.len() >= 2 && cross(up[up.len() - 2], up[up.len() - 1], q) <= 0.0 {
            up.pop();
        }
        up.push(q);
    }
    lo.pop();
    up.pop();
    lo.extend(up);
    lo
}

/// Minimum-area enclosing rectangle (counter-clockwise), the fallback for 4-corner buildings.
pub fn min_area_rect(pts: &[[f64; 2]]) -> Result<Squared> {
    let h = hull(pts);
    if h.len() < 3 {
        return Err(Error::invalid("the outline is degenerate"));
    }
    let mut best: Option<(f64, f64, [f64; 4])> = None;
    for i in 0..h.len() {
        let a = h[i];
        let b = h[(i + 1) % h.len()];
        let phi = (b[1] - a[1]).atan2(b[0] - a[0]);
        let (s, c) = phi.sin_cos();
        let (mut x0, mut x1, mut y0, mut y1) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for p in &h {
            let u = c * p[0] + s * p[1];
            let v = -s * p[0] + c * p[1];
            x0 = x0.min(u);
            x1 = x1.max(u);
            y0 = y0.min(v);
            y1 = y1.max(v);
        }
        let ar = (x1 - x0) * (y1 - y0);
        if best.is_none_or(|(b, _, _)| ar < b) {
            best = Some((ar, phi, [x0, x1, y0, y1]));
        }
    }
    let (_, phi, [x0, x1, y0, y1]) = best.unwrap();
    let (s, c) = phi.sin_cos();
    let back = |u: f64, v: f64| [c * u - s * v, s * u + c * v];
    let ring = vec![back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)];
    Ok(Squared { max_corner_error_deg: max_corner_error(&ring, PI / 2.0), axis_deg: phi.to_degrees(), ring, method: "minimum-area rectangle" })
}

/// Douglas–Peucker simplification of a polyline (metric), keeping the end points.
pub fn simplify(pts: &[[f64; 2]], tol: f64) -> Vec<usize> {
    let n = pts.len();
    if n <= 2 {
        return (0..n).collect();
    }
    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (pts[a], pts[b]);
        let (dx, dy) = (pb[0] - pa[0], pb[1] - pa[1]);
        let len = dx.hypot(dy);
        let mut worst = (0.0, 0usize);
        for (i, p) in pts.iter().enumerate().take(b).skip(a + 1) {
            let d = if len == 0.0 { (p[0] - pa[0]).hypot(p[1] - pa[1]) } else { ((p[0] - pa[0]) * dy - (p[1] - pa[1]) * dx).abs() / len };
            if d > worst.0 {
                worst = (d, i);
            }
        }
        if worst.0 > tol {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    (0..n).filter(|&i| keep[i]).collect()
}

/// Square a geographic ring (lon, lat, h): ENU about the centroid, square, back. Every output
/// vertex takes the mean input height (a footprint at one elevation). Falls back to the
/// minimum-area rectangle for 4-corner outlines when the line fit cannot square them.
pub fn square_geographic(lonlat_h: &[[f64; 3]], diagonals: bool) -> Result<(Vec<[f64; 3]>, Squared)> {
    let n = lonlat_h.len();
    if n < 3 {
        return Err(Error::invalid("a polygon needs at least 3 vertices"));
    }
    let lat0 = lonlat_h.iter().map(|p| p[1]).sum::<f64>() / n as f64;
    let lon0 = lonlat_h.iter().map(|p| p[0]).sum::<f64>() / n as f64;
    let h0 = lonlat_h.iter().map(|p| p[2]).sum::<f64>() / n as f64;
    let enu: Vec<[f64; 2]> = lonlat_h
        .iter()
        .map(|p| {
            let e = wgs84::geodetic_to_enu(p[1], p[0], p[2], lat0, lon0, h0);
            [e[0], e[1]]
        })
        .collect();
    let corners = open_ring(&enu).len();
    let sq = match square(&enu, diagonals) {
        Ok(s) => s,
        Err(e) if corners == 4 && !diagonals => min_area_rect(&enu).map_err(|_| e)?,
        Err(e) => return Err(e),
    };
    let ring = sq
        .ring
        .iter()
        .map(|p| {
            let (lat, lon, _) = wgs84::enu_to_geodetic(p[0], p[1], 0.0, lat0, lon0, h0);
            [lon, lat, h0]
        })
        .collect();
    Ok((ring, sq))
}

/// Medial axis of a geographic ring (lon, lat, h) in ENU about its centroid: length and widths
/// in metres and the axis as (lon, lat).
pub fn medial_geographic(lonlat_h: &[[f64; 3]], cells: usize) -> Result<(medial::Medial, Vec<[f64; 2]>)> {
    let n = lonlat_h.len();
    let lat0 = lonlat_h.iter().map(|p| p[1]).sum::<f64>() / n as f64;
    let lon0 = lonlat_h.iter().map(|p| p[0]).sum::<f64>() / n as f64;
    let h0 = lonlat_h.iter().map(|p| p[2]).sum::<f64>() / n as f64;
    let enu: Vec<[f64; 2]> = lonlat_h.iter().map(|p| { let e = wgs84::geodetic_to_enu(p[1], p[0], p[2], lat0, lon0, h0); [e[0], e[1]] }).collect();
    let m = medial::medial_axis(&enu, cells)?;
    let path = m.path.iter().map(|q| { let (lat, lon, _) = wgs84::enu_to_geodetic(q[0], q[1], 0.0, lat0, lon0, h0); [lon, lat] }).collect();
    Ok((m, path))
}
