//! Profiles and cross-sections (REQ-LDR-07): the points inside a swath of half-width `half` along
//! the polyline a → b, with their distance along the line and their offset across it (positive to
//! the left), ordered by distance along.

pub struct Profile {
    pub index: Vec<u32>,
    pub along: Vec<f32>,
    pub across: Vec<f32>,
}

pub fn profile(pos: &[f32], mask: Option<&[u8]>, a: [f64; 2], b: [f64; 2], half: f64, max: usize) -> Profile {
    let n = pos.len() / 3;
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    let mut hits: Vec<(f32, f32, u32)> = Vec::new();
    if len > 0.0 {
        let (ux, uy) = (dx / len, dy / len);
        for k in 0..n {
            if mask.is_some_and(|m| m[k] == 0) {
                continue;
            }
            let (px, py) = (f64::from(pos[3 * k]) - a[0], f64::from(pos[3 * k + 1]) - a[1]);
            let t = px * ux + py * uy;
            if t < 0.0 || t > len {
                continue;
            }
            let d = -px * uy + py * ux;
            if d.abs() <= half {
                hits.push((t as f32, d as f32, k as u32));
            }
        }
    }
    hits.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    if hits.len() > max && max > 0 {
        // Even thinning along the line keeps the shape.
        let step = hits.len() as f64 / max as f64;
        hits = (0..max).map(|i| hits[(i as f64 * step) as usize]).collect();
    }
    Profile { index: hits.iter().map(|h| h.2).collect(), along: hits.iter().map(|h| h.0).collect(), across: hits.iter().map(|h| h.1).collect() }
}
