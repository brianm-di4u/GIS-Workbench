//! Interferometric pair finder (REQ-SAR-10, GXP's published criteria, `Research/09` §10.4):
//! same collector family, mode, polarisation and side of track, footprint overlap, time between
//! collects, incidence and azimuth differences, and MatchInfo links. Metadata only.

/// What the finder needs from each collect.
#[derive(Clone, Debug)]
pub struct Collect {
    /// Collector family, core name, mode, polarisation and side of track as ids (equal ids =
    /// equal values; the caller keeps the names).
    pub family: u32,
    pub core_name: u32,
    pub mode: u32,
    pub polarization: u32,
    pub side: u32,
    /// Seconds since an arbitrary epoch.
    pub start: f64,
    pub incidence: f64,
    pub azimuth: f64,
    /// Footprint ring as (lat, lon).
    pub footprint: Vec<(f64, f64)>,
    pub matches: Vec<u32>,
}

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub min_overlap: f64,
    pub max_days: f64,
    pub max_incidence: f64,
    pub max_azimuth: f64,
}

#[derive(Clone, Debug)]
pub struct Pair {
    pub a: usize,
    pub b: usize,
    pub overlap: f64,
    pub days: f64,
    pub d_incidence: f64,
    pub d_azimuth: f64,
    pub matched: bool,
    pub ok: bool,
    /// Failed criteria: collector, mode, polarization, side, overlap, days, incidence, azimuth.
    pub reasons: Vec<&'static str>,
    pub score: f64,
}

fn area(p: &[(f64, f64)]) -> f64 {
    let n = p.len();
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (p[i], p[(i + 1) % n]);
        s += a.1 * b.0 - b.1 * a.0;
    }
    (s / 2.0).abs()
}

/// Sutherland–Hodgman clip of a convex ring by another (degrees as a plane: fine for a footprint).
fn clip(subject: &[(f64, f64)], clipper: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut out = subject.to_vec();
    let n = clipper.len();
    let orient = {
        let mut s = 0.0;
        for i in 0..n {
            let (a, b) = (clipper[i], clipper[(i + 1) % n]);
            s += a.1 * b.0 - b.1 * a.0;
        }
        s.signum()
    };
    for i in 0..n {
        let (a, b) = (clipper[i], clipper[(i + 1) % n]);
        let inside = |p: (f64, f64)| orient * ((b.1 - a.1) * (p.0 - a.0) - (b.0 - a.0) * (p.1 - a.1)) >= 0.0;
        let input = std::mem::take(&mut out);
        if input.is_empty() {
            break;
        }
        for j in 0..input.len() {
            let (p, q) = (input[j], input[(j + 1) % input.len()]);
            let (ip, iq) = (inside(p), inside(q));
            let cut = || {
                let (x1, y1, x2, y2) = (p.1, p.0, q.1, q.0);
                let (x3, y3, x4, y4) = (a.1, a.0, b.1, b.0);
                let d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
                let t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
                (y1 + t * (y2 - y1), x1 + t * (x2 - x1))
            };
            if ip && iq {
                out.push(q);
            } else if ip && !iq {
                out.push(cut());
            } else if !ip && iq {
                out.push(cut());
                out.push(q);
            }
        }
    }
    out
}

/// Every pair, ranked: passing pairs first by overlap, then by days.
pub fn find(c: &[Collect], lim: Limits) -> Vec<Pair> {
    let mut out = Vec::new();
    for i in 0..c.len() {
        for j in i + 1..c.len() {
            let (a, b) = (&c[i], &c[j]);
            let inter = clip(&a.footprint, &b.footprint);
            let ov = if inter.len() >= 3 { area(&inter) / area(&a.footprint).min(area(&b.footprint)).max(1e-30) } else { 0.0 };
            let days = (a.start - b.start).abs() / 86400.0;
            let di = (a.incidence - b.incidence).abs();
            let da = ((a.azimuth - b.azimuth + 540.0) % 360.0 - 180.0).abs();
            let matched = a.matches.iter().any(|m| *m == b.core_name) || b.matches.iter().any(|m| *m == a.core_name);
            let mut reasons = Vec::new();
            for (bad, k) in [
                (a.family != b.family, "collector"),
                (a.mode != b.mode, "mode"),
                (a.polarization != b.polarization, "polarization"),
                (a.side != b.side, "side"),
                (ov < lim.min_overlap, "overlap"),
                (days > lim.max_days, "days"),
                (di > lim.max_incidence, "incidence"),
                (da > lim.max_azimuth, "azimuth"),
            ] {
                if bad {
                    reasons.push(k);
                }
            }
            let ok = reasons.is_empty();
            let score = (if ok { 10.0 } else { 0.0 }) + (if matched { 1.0 } else { 0.0 }) + ov - days / 1000.0 - di / 100.0;
            out.push(Pair { a: i, b: j, overlap: ov, days, d_incidence: di, d_azimuth: da, matched, ok, reasons, score });
        }
    }
    out.sort_by(|p, q| q.score.partial_cmp(&p.score).unwrap_or(std::cmp::Ordering::Equal));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(core: u32, start: f64, inc: f64, dx: f64, m: Vec<u32>) -> Collect {
        let fp = vec![(0.0, dx), (0.0, dx + 1.0), (1.0, dx + 1.0), (1.0, dx)];
        Collect { family: 1, core_name: core, mode: 1, polarization: 1, side: 1, start, incidence: inc, azimuth: 280.0, footprint: fp, matches: m }
    }

    #[test]
    fn ranks_the_matching_pair_first() {
        let l = Limits { min_overlap: 0.5, max_days: 30.0, max_incidence: 2.0, max_azimuth: 5.0 };
        let v = vec![c(10, 0.0, 40.0, 0.0, vec![11]), c(11, 11.0 * 86400.0, 40.2, 0.1, vec![10]), c(12, 400.0 * 86400.0, 45.0, 0.9, vec![])];
        let p = find(&v, l);
        assert_eq!((p[0].a, p[0].b), (0, 1));
        assert!(p[0].ok && p[0].matched && (p[0].overlap - 0.9).abs() < 1e-9, "{:?}", p[0]);
        let bad = p.iter().find(|q| q.b == 2 && q.a == 0).unwrap();
        assert!(bad.reasons.contains(&"days") && bad.reasons.contains(&"incidence") && bad.reasons.contains(&"overlap"));
    }
}
