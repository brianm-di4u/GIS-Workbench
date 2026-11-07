//! The convex hull of discs: the perimeter of the Part 77 horizontal surface ("arcs of specified
//! radii from the center of each end of the primary surface … connecting the adjacent arcs by lines
//! tangent to those arcs", §77.19(a)) and of the Annex 14 inner horizontal surface (circles about the
//! strip ends). Containment uses a dense polygon (every 0.1° of each circle, ≤ 7 mm inside the true
//! arcs at 10 000 ft); the distance outside, which the conical surfaces rise with, is exact: it is
//! the least distance to the hull of any two of the discs (an "uneven capsule"), because the nearest
//! hull point lies on an arc of one disc or on the tangent between two.

#[derive(Clone, Copy, Debug)]
pub struct Disc {
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

#[derive(Clone, Debug)]
pub struct DiscHull {
    pub discs: Vec<Disc>,
    /// Counter-clockwise hull polygon.
    pub poly: Vec<(f64, f64)>,
    pairs: Vec<(usize, usize)>,
    /// Bounding box of the hull (x0, y0, x1, y1).
    pub bbox: (f64, f64, f64, f64),
}

fn cross(o: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
}

/// Andrew's monotone chain; counter-clockwise, no repeated end point. Each point carries a label.
pub fn convex_hull(mut pts: Vec<(f64, f64, usize)>) -> Vec<(f64, f64, usize)> {
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
    pts.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    if pts.len() < 3 {
        return pts;
    }
    let mut h: Vec<(f64, f64, usize)> = Vec::with_capacity(pts.len() * 2);
    for p in pts.iter().chain(pts.iter().rev().skip(1)) {
        while h.len() >= 2 && cross((h[h.len() - 2].0, h[h.len() - 2].1), (h[h.len() - 1].0, h[h.len() - 1].1), (p.0, p.1)) <= 0.0 {
            h.pop();
        }
        h.push(*p);
    }
    h.pop();
    h
}

/// Signed distance to the hull of two discs (Quilez's exact uneven capsule).
fn capsule(px: f64, py: f64, a: &Disc, b: &Disc) -> f64 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let l = (dx * dx + dy * dy).sqrt();
    let da = ((px - a.x).powi(2) + (py - a.y).powi(2)).sqrt() - a.r;
    let db = ((px - b.x).powi(2) + (py - b.y).powi(2)).sqrt() - b.r;
    if l <= (a.r - b.r).abs() + 1e-9 {
        // One disc holds the other.
        return if a.r >= b.r { da } else { db };
    }
    let (ux, uy) = (dx / l, dy / l);
    let along = (px - a.x) * ux + (py - a.y) * uy;
    let side = ((px - a.x) * -uy + (py - a.y) * ux).abs();
    let bb = (a.r - b.r) / l;
    let aa = (1.0 - bb * bb).sqrt();
    let k = side * -bb + along * aa;
    if k < 0.0 {
        da
    } else if k > aa * l {
        db
    } else {
        side * aa + along * bb - a.r
    }
}

impl DiscHull {
    pub fn new(discs: Vec<Disc>) -> Self {
        Self::with_step(discs, 0.1)
    }

    /// Hull sampled every `step_deg` of each circle.
    pub fn with_step(discs: Vec<Disc>, step_deg: f64) -> Self {
        let n = ((360.0 / step_deg).round() as usize).max(8);
        let mut pts = Vec::with_capacity(discs.len() * n);
        for (i, d) in discs.iter().enumerate() {
            for k in 0..n {
                let t = (k as f64) * std::f64::consts::TAU / (n as f64);
                pts.push((d.x + d.r * t.cos(), d.y + d.r * t.sin(), i));
            }
        }
        let h = convex_hull(pts);
        // Discs next to each other along the hull: the tangents between them.
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        if discs.len() <= 16 {
            for i in 0..discs.len() {
                for j in i + 1..discs.len() {
                    pairs.push((i, j));
                }
            }
        } else {
            for k in 0..h.len() {
                let (a, b) = (h[k].2, h[(k + 1) % h.len()].2);
                if a != b {
                    let p = (a.min(b), a.max(b));
                    if !pairs.contains(&p) {
                        pairs.push(p);
                    }
                }
            }
        }
        let poly: Vec<(f64, f64)> = h.iter().map(|p| (p.0, p.1)).collect();
        let mut bbox = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        for p in &poly {
            bbox = (bbox.0.min(p.0), bbox.1.min(p.1), bbox.2.max(p.0), bbox.3.max(p.1));
        }
        DiscHull { discs, poly, pairs, bbox }
    }

    /// Inside the hull polygon (O(log n), fan from vertex 0).
    pub fn contains(&self, x: f64, y: f64) -> bool {
        let p = &self.poly;
        let n = p.len();
        if n < 3 || x < self.bbox.0 || x > self.bbox.2 || y < self.bbox.1 || y > self.bbox.3 {
            return false;
        }
        let q = (x, y);
        if cross(p[0], p[1], q) < 0.0 || cross(p[0], p[n - 1], q) > 0.0 {
            return false;
        }
        let (mut lo, mut hi) = (1usize, n - 1);
        while hi - lo > 1 {
            let mid = (lo + hi) / 2;
            if cross(p[0], p[mid], q) >= 0.0 {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        cross(p[lo], p[hi], q) >= 0.0
    }

    /// Distance outside the hull (0 inside).
    pub fn dist_out(&self, x: f64, y: f64) -> f64 {
        if self.contains(x, y) {
            return 0.0;
        }
        let mut d = f64::INFINITY;
        if self.discs.len() == 1 {
            let a = &self.discs[0];
            d = ((x - a.x).powi(2) + (y - a.y).powi(2)).sqrt() - a.r;
        }
        for &(i, j) in &self.pairs {
            d = d.min(capsule(x, y, &self.discs[i], &self.discs[j]));
        }
        d.max(0.0)
    }

    /// Hull vertices with the outward normal of the disc each lies on (for offset rings).
    pub fn ring_with_normals(&self, step_deg: f64) -> Vec<(f64, f64, f64, f64)> {
        let n = ((360.0 / step_deg).round() as usize).max(8);
        let mut pts = Vec::with_capacity(self.discs.len() * n);
        for (i, d) in self.discs.iter().enumerate() {
            for k in 0..n {
                let t = (k as f64) * std::f64::consts::TAU / (n as f64);
                pts.push((d.x + d.r * t.cos(), d.y + d.r * t.sin(), i * n + k));
            }
        }
        convex_hull(pts)
            .into_iter()
            .map(|(x, y, lab)| {
                let t = ((lab % n) as f64) * std::f64::consts::TAU / (n as f64);
                (x, y, t.cos(), t.sin())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stadium_distance_and_containment() {
        // One runway: two 3048 m discs 3000 m apart (a stadium).
        let h = DiscHull::new(vec![Disc { x: 0.0, y: 0.0, r: 3048.0 }, Disc { x: 3000.0, y: 0.0, r: 3048.0 }]);
        assert!(h.contains(1500.0, 3047.0));
        assert!(!h.contains(1500.0, 3049.0));
        assert!((h.dist_out(1500.0, 4000.0) - 952.0).abs() < 1e-9);
        assert!((h.dist_out(-4048.0, 0.0) - 1000.0).abs() < 1e-9);
        let d = h.dist_out(5000.0, 5000.0);
        assert!((d - ((2000.0f64.powi(2) + 5000.0f64.powi(2)).sqrt() - 3048.0)).abs() < 1e-9);
    }

    #[test]
    fn unequal_discs_tangent() {
        // Discs r 1000 at 0 and r 500 at 3000: the tangent's distance from a far point beside it.
        let a = Disc { x: 0.0, y: 0.0, r: 1000.0 };
        let b = Disc { x: 3000.0, y: 0.0, r: 500.0 };
        let h = DiscHull::new(vec![a, b]);
        // The upper tangent line: normal n = (sin α, cos α) with sin α = (ra − rb)/L = 1/6, offset ra.
        let s = 1.0 / 6.0f64;
        let c = (1.0 - s * s).sqrt();
        let (px, py) = (1500.0, 2000.0);
        let want = px * s + py * c - 1000.0;
        assert!((h.dist_out(px, py) - want).abs() < 1e-9, "{} {}", h.dist_out(px, py), want);
        // A disc swallowed by another adds nothing.
        let h2 = DiscHull::new(vec![Disc { x: 0.0, y: 0.0, r: 3000.0 }, Disc { x: 100.0, y: 0.0, r: 500.0 }]);
        assert!((h2.dist_out(4000.0, 0.0) - 1000.0).abs() < 1e-9);
    }
}
