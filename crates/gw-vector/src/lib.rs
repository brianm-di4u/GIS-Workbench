//! GIS Workbench feature validation (Appendix D `gw-vector`, REQ-EXT-13, AC-10.5): geometry
//! checks in a local metric frame (metres east/north; the caller converts) — degenerate rings,
//! holes outside their shell, self-intersections, repeated vertices, duplicate features,
//! overlapping polygons, line dangles (undershoots within the tolerance, with a snap fix, and
//! overshoots past a crossing, with a trim fix) and slivers. Attribute domains and required
//! fields are checked by the caller against its schema.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Point,
    Line,
    Polygon,
}

#[derive(Clone, Debug)]
pub struct Feature {
    pub kind: Kind,
    /// Rings (open: the closing vertex is implied) or lines, metres.
    pub parts: Vec<Vec<[f64; 2]>>,
    /// For polygons: the first part of each polygon (outer ring, then holes).
    pub polys: Vec<usize>,
}

#[derive(Clone, Copy, Debug)]
pub struct Opts {
    /// Dangle tolerance (m).
    pub tol: f64,
    /// Duplicate-vertex tolerance (m).
    pub dup_tol: f64,
    /// Sliver threshold on 4πA/P² (0 = off).
    pub sliver: f64,
    /// Largest sliver area (m²).
    pub sliver_area: f64,
}

impl Default for Opts {
    fn default() -> Self {
        Opts {
            tol: 2.0,
            dup_tol: 0.01,
            sliver: 0.05,
            sliver_area: 100.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Fix {
    /// Move vertex `vertex` of part `part` to `to`.
    Move {
        part: usize,
        vertex: usize,
        to: [f64; 2],
    },
    /// Cut part `part` at its `end` (0 = start, 1 = end): drop the vertices beyond `keep` and end at `to`.
    Trim {
        part: usize,
        end: u8,
        keep: usize,
        to: [f64; 2],
    },
}

#[derive(Clone, Debug)]
pub struct Issue {
    pub check: &'static str,
    pub feature: usize,
    pub other: Option<usize>,
    pub part: usize,
    pub at: [f64; 2],
    pub value: f64,
    pub message: String,
    pub fix: Option<Fix>,
}

type P = [f64; 2];

fn sub(a: P, b: P) -> P {
    [a[0] - b[0], a[1] - b[1]]
}
fn cross(a: P, b: P) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn dist(a: P, b: P) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

/// Proper or touching intersection point of segments ab and cd (None if parallel or apart).
fn seg_hit(a: P, b: P, c: P, d: P) -> Option<(P, f64, f64)> {
    let r = sub(b, a);
    let s = sub(d, c);
    let den = cross(r, s);
    if den.abs() < 1e-12 * (r[0].abs() + r[1].abs() + 1.0) * (s[0].abs() + s[1].abs() + 1.0) {
        return None;
    }
    let t = cross(sub(c, a), s) / den;
    let u = cross(sub(c, a), r) / den;
    if (-1e-12..=1.0 + 1e-12).contains(&t) && (-1e-12..=1.0 + 1e-12).contains(&u) {
        Some(([a[0] + t * r[0], a[1] + t * r[1]], t, u))
    } else {
        None
    }
}

/// Nearest point on segment ab to p, and its parameter.
fn nearest_on(a: P, b: P, p: P) -> (P, f64) {
    let r = sub(b, a);
    let l2 = r[0] * r[0] + r[1] * r[1];
    if l2 == 0.0 {
        return (a, 0.0);
    }
    let t = (((p[0] - a[0]) * r[0] + (p[1] - a[1]) * r[1]) / l2).clamp(0.0, 1.0);
    ([a[0] + t * r[0], a[1] + t * r[1]], t)
}

fn ring_area(r: &[P]) -> f64 {
    let n = r.len();
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (r[i], r[(i + 1) % n]);
        s += a[0] * b[1] - b[0] * a[1];
    }
    s / 2.0
}

fn ring_perimeter(r: &[P]) -> f64 {
    (0..r.len()).map(|i| dist(r[i], r[(i + 1) % r.len()])).sum()
}

fn point_in_ring(p: P, r: &[P]) -> bool {
    let mut c = false;
    let n = r.len();
    let mut j = n - 1;
    for i in 0..n {
        let (a, b) = (r[i], r[j]);
        if (a[1] > p[1]) != (b[1] > p[1])
            && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
        {
            c = !c;
        }
        j = i;
    }
    c
}

/// Polygon groups of a feature: (outer ring, holes).
fn groups(f: &Feature) -> Vec<(usize, Vec<usize>)> {
    let starts = if f.polys.is_empty() {
        vec![0]
    } else {
        f.polys.clone()
    };
    starts
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let e = starts.get(i + 1).copied().unwrap_or(f.parts.len());
            (s, (s + 1..e).collect())
        })
        .collect()
}

fn bbox(f: &Feature) -> [f64; 4] {
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for p in &f.parts {
        for v in p {
            b[0] = b[0].min(v[0]);
            b[1] = b[1].min(v[1]);
            b[2] = b[2].max(v[0]);
            b[3] = b[3].max(v[1]);
        }
    }
    b
}

fn overlaps(a: &[f64; 4], b: &[f64; 4], pad: f64) -> bool {
    a[0] <= b[2] + pad && b[0] <= a[2] + pad && a[1] <= b[3] + pad && b[1] <= a[3] + pad
}

/// Segments of a part: closed for rings.
fn segs(p: &[P], closed: bool) -> Vec<(usize, P, P)> {
    let n = p.len();
    let m = if closed { n } else { n.saturating_sub(1) };
    (0..m).map(|i| (i, p[i], p[(i + 1) % n])).collect()
}

/// Candidate pairs (i < j) whose boxes overlap (padded), through a uniform grid.
fn pairs(boxes: &[[f64; 4]], pad: f64) -> Vec<(usize, usize)> {
    if boxes.is_empty() {
        return Vec::new();
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for b in boxes {
        x0 = x0.min(b[0]);
        y0 = y0.min(b[1]);
        x1 = x1.max(b[2]);
        y1 = y1.max(b[3]);
    }
    let n = boxes.len();
    let cells = ((n as f64).sqrt().ceil() as usize).clamp(1, 512);
    let cw = ((x1 - x0) / cells as f64).max(1e-9);
    let ch = ((y1 - y0) / cells as f64).max(1e-9);
    let mut grid: Vec<Vec<usize>> = vec![Vec::new(); cells * cells];
    let cell = |v: f64, o: f64, s: f64| (((v - o) / s).floor().max(0.0) as usize).min(cells - 1);
    for (i, b) in boxes.iter().enumerate() {
        for gy in cell(b[1] - pad, y0, ch)..=cell(b[3] + pad, y0, ch) {
            for gx in cell(b[0] - pad, x0, cw)..=cell(b[2] + pad, x0, cw) {
                grid[gy * cells + gx].push(i);
            }
        }
    }
    let mut out = std::collections::HashSet::new();
    for g in &grid {
        for a in 0..g.len() {
            for b in a + 1..g.len() {
                let (i, j) = (g[a].min(g[b]), g[a].max(g[b]));
                if overlaps(&boxes[i], &boxes[j], pad) {
                    out.insert((i, j));
                }
            }
        }
    }
    let mut v: Vec<_> = out.into_iter().collect();
    v.sort_unstable();
    v
}

pub fn validate(fs: &[Feature], o: &Opts) -> Vec<Issue> {
    let mut out = Vec::new();
    let issue = |check: &'static str,
                 feature: usize,
                 other: Option<usize>,
                 part: usize,
                 at: P,
                 value: f64,
                 message: String,
                 fix: Option<Fix>| Issue {
        check,
        feature,
        other,
        part,
        at,
        value,
        message,
        fix,
    };
    // Per-feature checks.
    for (fi, f) in fs.iter().enumerate() {
        for (pi, p) in f.parts.iter().enumerate() {
            for i in 1..p.len() {
                if dist(p[i], p[i - 1]) <= o.dup_tol {
                    out.push(issue(
                        "repeated_vertex",
                        fi,
                        None,
                        pi,
                        p[i],
                        dist(p[i], p[i - 1]),
                        format!("vertices {} and {} coincide", i - 1, i),
                        None,
                    ));
                }
            }
        }
        match f.kind {
            Kind::Polygon => {
                for (outer, holes) in groups(f) {
                    for &ri in std::iter::once(&outer).chain(holes.iter()) {
                        let r = &f.parts[ri];
                        let distinct = r
                            .windows(2)
                            .filter(|w| dist(w[0], w[1]) > o.dup_tol)
                            .count()
                            + 1;
                        let a = ring_area(r).abs();
                        if r.len() < 3 || distinct < 3 || a < 1e-6 {
                            out.push(issue(
                                "ring",
                                fi,
                                None,
                                ri,
                                r.first().copied().unwrap_or([0.0, 0.0]),
                                a,
                                format!(
                                    "ring {ri} is degenerate ({} vertices, area {:.3} m²)",
                                    r.len(),
                                    a
                                ),
                                None,
                            ));
                        }
                    }
                    for &hi in &holes {
                        let h = &f.parts[hi];
                        if let Some(v) = h.first() {
                            if !point_in_ring(*v, &f.parts[outer]) {
                                out.push(issue(
                                    "ring",
                                    fi,
                                    None,
                                    hi,
                                    *v,
                                    0.0,
                                    format!("hole {hi} lies outside its outer ring"),
                                    None,
                                ));
                            }
                        }
                    }
                    let a = ring_area(&f.parts[outer]).abs()
                        - holes
                            .iter()
                            .map(|&h| ring_area(&f.parts[h]).abs())
                            .sum::<f64>();
                    let per: f64 = std::iter::once(&outer)
                        .chain(holes.iter())
                        .map(|&r| ring_perimeter(&f.parts[r]))
                        .sum();
                    if o.sliver > 0.0 && per > 0.0 {
                        let thin = 4.0 * std::f64::consts::PI * a / (per * per);
                        if thin < o.sliver && a < o.sliver_area {
                            out.push(issue(
                                "sliver",
                                fi,
                                None,
                                outer,
                                f.parts[outer][0],
                                thin,
                                format!("sliver: area {a:.2} m², thinness {thin:.3}"),
                                None,
                            ));
                        }
                    }
                }
                // Self-intersection over every ring of the feature.
                let all: Vec<(usize, usize, P, P)> = f
                    .parts
                    .iter()
                    .enumerate()
                    .flat_map(|(ri, r)| {
                        segs(r, true)
                            .into_iter()
                            .map(move |(i, a, b)| (ri, i, a, b))
                    })
                    .collect();
                self_cross(&all, fi, f, true, &mut out);
            }
            Kind::Line => {
                let all: Vec<(usize, usize, P, P)> = f
                    .parts
                    .iter()
                    .enumerate()
                    .flat_map(|(ri, r)| {
                        segs(r, false)
                            .into_iter()
                            .map(move |(i, a, b)| (ri, i, a, b))
                    })
                    .collect();
                self_cross(&all, fi, f, false, &mut out);
            }
            Kind::Point => {}
        }
    }
    let boxes: Vec<[f64; 4]> = fs.iter().map(bbox).collect();
    // Duplicates (same kind, same vertices within the tolerance) and polygon overlaps.
    for (i, j) in pairs(&boxes, o.dup_tol) {
        let (a, b) = (&fs[i], &fs[j]);
        if a.kind == b.kind && a.parts.len() == b.parts.len() && same_vertices(a, b, o.dup_tol) {
            out.push(issue(
                "duplicate",
                j,
                Some(i),
                0,
                b.parts[0][0],
                0.0,
                format!("duplicate of feature {i}"),
                None,
            ));
            continue;
        }
        if a.kind == Kind::Polygon && b.kind == Kind::Polygon {
            if let Some(at) = polygon_overlap(a, b, o.dup_tol) {
                out.push(issue(
                    "overlap",
                    i,
                    Some(j),
                    0,
                    at,
                    0.0,
                    format!("overlaps feature {j}"),
                    None,
                ));
            }
        }
    }
    // Dangles on lines.
    let lines: Vec<usize> = (0..fs.len())
        .filter(|&i| fs[i].kind == Kind::Line)
        .collect();
    let lboxes: Vec<[f64; 4]> = lines.iter().map(|&i| boxes[i]).collect();
    let mut near: Vec<Vec<usize>> = vec![Vec::new(); lines.len()];
    for (a, b) in pairs(&lboxes, o.tol) {
        near[a].push(b);
        near[b].push(a);
    }
    for (li, &fi) in lines.iter().enumerate() {
        let f = &fs[fi];
        let others: Vec<usize> = near[li].iter().map(|&k| lines[k]).collect();
        for (pi, p) in f.parts.iter().enumerate() {
            if p.len() < 2 {
                continue;
            }
            for end in 0..2u8 {
                let (vi, e) = if end == 0 {
                    (0, p[0])
                } else {
                    (p.len() - 1, p[p.len() - 1])
                };
                // Overshoot: the first crossing within the tolerance of the end, walking inwards.
                let mut walked = 0.0;
                let mut overshot = false;
                let n = p.len();
                let order: Vec<usize> = if end == 0 {
                    (0..n - 1).collect()
                } else {
                    (0..n - 1).rev().collect()
                };
                'walk: for s in order {
                    let (a, b) = if end == 0 {
                        (p[s], p[s + 1])
                    } else {
                        (p[s + 1], p[s])
                    };
                    let mut hit: Option<(f64, P, usize)> = None;
                    for &g in &others {
                        for part in &fs[g].parts {
                            for (_, c, d) in segs(part, false) {
                                if let Some((x, t, _)) = seg_hit(a, b, c, d) {
                                    if t > 1e-9 && hit.is_none_or(|h| t < h.0) {
                                        hit = Some((t, x, g));
                                    }
                                }
                            }
                        }
                    }
                    if let Some((t, x, g)) = hit {
                        let over = walked + t * dist(a, b);
                        if over > 1e-6 && over < o.tol {
                            // Keep the vertices from the crossing inwards.
                            let keep = if end == 0 { s + 1 } else { s };
                            out.push(issue("overshoot", fi, Some(g), pi, e, over, format!("{} runs {over:.2} m past feature {g} (under {:.1} m): overshoot", if end == 0 { "start" } else { "end" }, o.tol), Some(Fix::Trim { part: pi, end, keep, to: x })));
                            overshot = true;
                        }
                        break 'walk;
                    }
                    walked += dist(a, b);
                    if walked >= o.tol {
                        break;
                    }
                }
                if overshot {
                    continue;
                }
                // Nearest point on other lines and on this feature's other parts / far segments.
                let mut best: Option<(f64, P, usize)> = None;
                let mut consider = |g: usize, gp: usize, s: usize, a: P, b: P| {
                    if g == fi && gp == pi {
                        // Skip the segments touching this end.
                        let n = p.len();
                        if (end == 0 && s == 0) || (end == 1 && s + 2 >= n) {
                            return;
                        }
                    }
                    let (q, _) = nearest_on(a, b, e);
                    let d = dist(q, e);
                    if best.is_none_or(|bb| d < bb.0) {
                        best = Some((d, q, g));
                    }
                };
                for &g in others.iter().chain(std::iter::once(&fi)) {
                    for (gp, part) in fs[g].parts.iter().enumerate() {
                        for (s, a, b) in segs(part, false) {
                            consider(g, gp, s, a, b);
                        }
                    }
                }
                if let Some((d, q, g)) = best {
                    if d > 1e-6 && d < o.tol {
                        out.push(issue(
                            "dangle",
                            fi,
                            Some(g),
                            pi,
                            e,
                            d,
                            format!(
                                "{} is {d:.2} m from feature {g} (under {:.1} m): undershoot",
                                if end == 0 { "start" } else { "end" },
                                o.tol
                            ),
                            Some(Fix::Move {
                                part: pi,
                                vertex: vi,
                                to: q,
                            }),
                        ));
                    }
                }
            }
        }
    }
    out
}

/// Segments bucketed in a 2D grid (about one per cell): a query reads only the segments whose cells
/// its box touches. An x-sweep degenerates when a long border runs north–south inside a narrow band.
struct SegGrid {
    x0: f64,
    y0: f64,
    cw: f64,
    ch: f64,
    k: usize,
    cells: Vec<Vec<usize>>,
}

impl SegGrid {
    fn new(segs: &[(P, P)]) -> Self {
        let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for (a, b) in segs {
            x0 = x0.min(a[0].min(b[0]));
            y0 = y0.min(a[1].min(b[1]));
            x1 = x1.max(a[0].max(b[0]));
            y1 = y1.max(a[1].max(b[1]));
        }
        let k = ((segs.len() as f64).sqrt().ceil() as usize).clamp(1, 1024);
        let mut g = SegGrid {
            x0,
            y0,
            cw: ((x1 - x0) / k as f64).max(1e-12),
            ch: ((y1 - y0) / k as f64).max(1e-12),
            k,
            cells: vec![Vec::new(); k * k],
        };
        for (i, (a, b)) in segs.iter().enumerate() {
            let (cx0, cy0, cx1, cy1) = g.span(
                a[0].min(b[0]),
                a[1].min(b[1]),
                a[0].max(b[0]),
                a[1].max(b[1]),
            );
            for cy in cy0..=cy1 {
                for cx in cx0..=cx1 {
                    g.cells[cy * k + cx].push(i);
                }
            }
        }
        g
    }
    fn span(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> (usize, usize, usize, usize) {
        let c = |v: f64, o: f64, s: f64| (((v - o) / s).floor().max(0.0) as usize).min(self.k - 1);
        (
            c(x0, self.x0, self.cw),
            c(y0, self.y0, self.ch),
            c(x1, self.x0, self.cw),
            c(y1, self.y0, self.ch),
        )
    }
    /// Each segment index whose cells meet the box (a, b); an index may come more than once.
    fn query(&self, a: P, b: P, mut f: impl FnMut(usize) -> bool) -> bool {
        let (cx0, cy0, cx1, cy1) = self.span(
            a[0].min(b[0]),
            a[1].min(b[1]),
            a[0].max(b[0]),
            a[1].max(b[1]),
        );
        for cy in cy0..=cy1 {
            for cx in cx0..=cx1 {
                for &i in &self.cells[cy * self.k + cx] {
                    if f(i) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

fn self_cross(
    all: &[(usize, usize, P, P)],
    fi: usize,
    f: &Feature,
    closed: bool,
    out: &mut Vec<Issue>,
) {
    let grid = SegGrid::new(&all.iter().map(|s| (s.2, s.3)).collect::<Vec<_>>());
    let mut seen = std::collections::HashSet::new();
    let mut reported = 0;
    for (x, &(ra, ia, a0, a1)) in all.iter().enumerate() {
        let stop = grid.query(a0, a1, |y| {
            if y <= x || !seen.insert((x, y)) {
                return false;
            }
            let (rb, ib, b0, b1) = all[y];
            if ra == rb {
                let n = f.parts[ra].len();
                let adj = ia.abs_diff(ib) == 1
                    || (closed && ((ia == 0 && ib == n - 1) || (ib == 0 && ia == n - 1)));
                if adj {
                    return false;
                }
            }
            if let Some((p, t, u)) = seg_hit(a0, a1, b0, b1) {
                // Touching at shared ends of different rings is still an error for polygons.
                let interior = t > 1e-9 && t < 1.0 - 1e-9 && u > 1e-9 && u < 1.0 - 1e-9;
                if interior || ra != rb {
                    out.push(Issue {
                        check: "self_intersection",
                        feature: fi,
                        other: None,
                        part: ra,
                        at: p,
                        value: 0.0,
                        message: format!("segments {ia} (part {ra}) and {ib} (part {rb}) cross"),
                        fix: None,
                    });
                    reported += 1;
                    return reported >= 20;
                }
            }
            false
        });
        if stop {
            return;
        }
        // The pairs of this segment are done.
        seen.clear();
    }
}

fn same_vertices(a: &Feature, b: &Feature, tol: f64) -> bool {
    for (pa, pb) in a.parts.iter().zip(&b.parts) {
        if pa.len() != pb.len() || pa.is_empty() {
            return false;
        }
        let n = pa.len();
        let ok = if a.kind == Kind::Polygon {
            // Rings may start anywhere and run either way.
            (0..n).any(|s| {
                (0..n).all(|i| dist(pa[i], pb[(s + i) % n]) <= tol)
                    || (0..n).all(|i| dist(pa[i], pb[(s + n - i) % n]) <= tol)
            })
        } else {
            (0..n).all(|i| dist(pa[i], pb[i]) <= tol)
                || (0..n).all(|i| dist(pa[i], pb[n - 1 - i]) <= tol)
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Ring edges bucketed by y, so point-in-ring and near-edge tests read only the edges whose y range
/// reaches the point (country coastlines of 10⁴–10⁵ vertices made the plain tests quadratic).
struct RingIndex<'a> {
    r: &'a [P],
    y0: f64,
    dy: f64,
    rows: Vec<Vec<usize>>,
    bbox: [f64; 4],
}

impl<'a> RingIndex<'a> {
    fn new(r: &'a [P]) -> Self {
        let n = r.len();
        let mut bbox = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for v in r {
            bbox = [
                bbox[0].min(v[0]),
                bbox[1].min(v[1]),
                bbox[2].max(v[0]),
                bbox[3].max(v[1]),
            ];
        }
        let k = ((n as f64).sqrt().ceil() as usize).clamp(1, 2048);
        let dy = ((bbox[3] - bbox[1]) / k as f64).max(1e-12);
        let mut rows = vec![Vec::new(); k];
        let row = |y: f64| (((y - bbox[1]) / dy).floor().max(0.0) as usize).min(k - 1);
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            for q in row(a[1].min(b[1]))..=row(a[1].max(b[1])) {
                rows[q].push(i);
            }
        }
        RingIndex {
            r,
            y0: bbox[1],
            dy,
            rows,
            bbox,
        }
    }
    fn row(&self, y: f64) -> usize {
        (((y - self.y0) / self.dy).floor().max(0.0) as usize).min(self.rows.len() - 1)
    }
    /// Crossing-number test (the same rule as point_in_ring) over the edges spanning p's y.
    fn inside(&self, p: P) -> bool {
        if p[0] < self.bbox[0] || p[0] > self.bbox[2] || p[1] < self.bbox[1] || p[1] > self.bbox[3]
        {
            return false;
        }
        let n = self.r.len();
        let mut c = false;
        for &i in &self.rows[self.row(p[1])] {
            let (a, b) = (self.r[(i + 1) % n], self.r[i]);
            if (a[1] > p[1]) != (b[1] > p[1])
                && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]
            {
                c = !c;
            }
        }
        c
    }
    /// Whether an edge lies within `tol` of p.
    fn near(&self, p: P, tol: f64) -> bool {
        let n = self.r.len();
        let (lo, hi) = (self.row(p[1] - tol), self.row(p[1] + tol));
        (lo..=hi).any(|q| {
            self.rows[q]
                .iter()
                .any(|&i| dist(nearest_on(self.r[i], self.r[(i + 1) % n], p).0, p) <= tol)
        })
    }
}

/// A point inside both polygons, if their interiors overlap (shared edges do not count). Segment
/// pairs come from an x-sweep over the edges inside the other ring's box; vertex tests use RingIndex.
fn polygon_overlap(a: &Feature, b: &Feature, tol: f64) -> Option<P> {
    for (oa, _) in groups(a) {
        for (ob, _) in groups(b) {
            let (ra, rb) = (&a.parts[oa], &b.parts[ob]);
            let (ia, ib) = (RingIndex::new(ra), RingIndex::new(rb));
            if !overlaps(&ia.bbox, &ib.bbox, tol) {
                continue;
            }
            let clip = |s: &(usize, P, P), bx: &[f64; 4]| {
                overlaps(
                    &[
                        s.1[0].min(s.2[0]),
                        s.1[1].min(s.2[1]),
                        s.1[0].max(s.2[0]),
                        s.1[1].max(s.2[1]),
                    ],
                    bx,
                    tol,
                )
            };
            let sa: Vec<(usize, P, P)> = segs(ra, true)
                .into_iter()
                .filter(|s| clip(s, &ib.bbox))
                .collect();
            let sb: Vec<(usize, P, P)> = segs(rb, true)
                .into_iter()
                .filter(|s| clip(s, &ia.bbox))
                .collect();
            // sb's edges in a 2D grid: each edge of sa reads only the cells its box touches.
            let grid = SegGrid::new(&sb.iter().map(|s| (s.1, s.2)).collect::<Vec<_>>());
            let mut hit: Option<P> = None;
            for &(_, p, q) in &sa {
                if grid.query(p, q, |j| {
                    let (_, c, d) = sb[j];
                    if let Some((x, t, u)) = seg_hit(p, q, c, d) {
                        if t > 1e-6 && t < 1.0 - 1e-6 && u > 1e-6 && u < 1.0 - 1e-6 {
                            // A proper crossing: not collinear sharing.
                            let r1 = sub(q, p);
                            let r2 = sub(d, c);
                            if cross(r1, r2).abs()
                                > 1e-9 * (r1[0].hypot(r1[1]) * r2[0].hypot(r2[1])).max(1e-12)
                            {
                                hit = Some(x);
                                return true;
                            }
                        }
                    }
                    false
                }) {
                    return hit;
                }
            }
            for (r, other) in [(ra, &ib), (rb, &ia)] {
                for v in r {
                    if other.inside(*v) && !other.near(*v, tol) {
                        return Some(*v);
                    }
                }
            }
        }
    }
    None
}

/// Apply a fix to a feature's parts.
pub fn apply_fix(f: &mut Feature, fix: &Fix) {
    match fix {
        Fix::Move { part, vertex, to } => {
            if let Some(v) = f.parts.get_mut(*part).and_then(|p| p.get_mut(*vertex)) {
                *v = *to;
            }
        }
        Fix::Trim {
            part,
            end,
            keep,
            to,
        } => {
            if let Some(p) = f.parts.get_mut(*part) {
                if *end == 0 {
                    let mut q = vec![*to];
                    q.extend_from_slice(&p[*keep..]);
                    *p = q;
                } else {
                    let mut q = p[..=*keep].to_vec();
                    q.push(*to);
                    *p = q;
                }
            }
        }
    }
}
