//! GIS Workbench vector geoprocessing (REQ-GAP-79): buffer and dissolve on planar coordinates (a
//! metric frame chosen by the caller: the layer's local frame, or a per-feature azimuthal
//! equidistant frame for geodesic buffers). Boolean operations, offsets and strokes come from
//! `i_overlay` (MIT OR Apache-2.0). Overlay and spatial join stay in JavaScript on
//! `polygon-clipping` (S-62).
//!
//! Geometries travel as flat f64 lists, one geometry after another:
//! `[kind, part count, then per part: …]` where kind 1 is points (a part is `[x, y]`), 2 lines (a
//! part is `[n, x, y …]`) and 3 polygons (a part is a polygon: `[ring count, then per ring n, x, y …]`).
//! Results are multipolygons: `[polygon count, then per polygon: ring count, per ring n, x, y …]`,
//! outer rings counter-clockwise, holes clockwise, rings open.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;
use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::stroke::offset::StrokeOffset;
use i_overlay::mesh::float::style::{LineCap, LineJoin, OutlineStyle, StrokeStyle};

pub type Ring = Vec<[f64; 2]>;
pub type Polygon = Vec<Ring>;
pub type Shapes = Vec<Polygon>;

/// One input geometry.
#[derive(Clone, Debug)]
pub enum Geom {
    Points(Vec<[f64; 2]>),
    Lines(Vec<Ring>),
    Polygons(Shapes),
}

/// Line ends of a buffered line (GEOS / ESRI names: round, flat, square).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Cap {
    Round,
    Flat,
    Square,
}

/// Read geometries from the flat list; None when it is malformed.
pub fn decode(v: &[f64]) -> Option<Vec<Geom>> {
    let mut o = 0usize;
    let mut next = |o: &mut usize| -> Option<f64> {
        let x = *v.get(*o)?;
        *o += 1;
        x.is_finite().then_some(x)
    };
    let count = |x: f64| (x >= 0.0 && x.fract() == 0.0 && x < 1e8).then_some(x as usize);
    let mut out = Vec::new();
    while o < v.len() {
        let kind = next(&mut o)?;
        let np = count(next(&mut o)?)?;
        let ring = |o: &mut usize, next: &mut dyn FnMut(&mut usize) -> Option<f64>| -> Option<Ring> {
            let n = count(next(o)?)?;
            let mut r = Vec::with_capacity(n);
            for _ in 0..n {
                r.push([next(o)?, next(o)?]);
            }
            Some(r)
        };
        out.push(match kind as i32 {
            1 => Geom::Points((0..np).map(|_| Some([next(&mut o)?, next(&mut o)?])).collect::<Option<_>>()?),
            2 => Geom::Lines((0..np).map(|_| ring(&mut o, &mut next)).collect::<Option<_>>()?),
            3 => Geom::Polygons(
                (0..np)
                    .map(|_| {
                        let nr = count(next(&mut o)?)?;
                        (0..nr).map(|_| ring(&mut o, &mut next)).collect::<Option<Polygon>>()
                    })
                    .collect::<Option<_>>()?,
            ),
            _ => return None,
        });
    }
    Some(out)
}

/// Append a multipolygon to the flat output list.
pub fn encode(s: &Shapes, out: &mut Vec<f64>) {
    out.push(s.len() as f64);
    for p in s {
        out.push(p.len() as f64);
        for r in p {
            out.push(r.len() as f64);
            for q in r {
                out.extend(q);
            }
        }
    }
}

/// The step angle of round joins and caps: GEOS's segments per quarter circle.
fn step(quad_segs: u32) -> f64 {
    std::f64::consts::FRAC_PI_2 / quad_segs.clamp(1, 90) as f64
}

/// Union of every polygon given, with the non-zero rule: overlaps merge, rings of either
/// orientation count as filled. Also cleans self-intersections.
pub fn union(shapes: &Shapes) -> Shapes {
    let empty: Vec<Ring> = Vec::new();
    let mut s: Shapes = shapes.overlay(&empty, OverlayRule::Union, FillRule::NonZero);
    s.retain(|p| !p.is_empty());
    s
}

/// A regular polygon approximating a circle, counter-clockwise, with `4 · quad_segs` sides.
fn circle(c: [f64; 2], r: f64, quad_segs: u32) -> Ring {
    let n = 4 * quad_segs.clamp(1, 90) as usize;
    (0..n)
        .map(|k| {
            let a = 2.0 * std::f64::consts::PI * k as f64 / n as f64;
            [c[0] + r * a.cos(), c[1] + r * a.sin()]
        })
        .collect()
}

/// Buffer one geometry by `d` (metres in the caller's frame). Points and lines need d > 0;
/// polygons grow with d > 0 and shrink with d < 0 (and may vanish). Joins are round.
pub fn buffer(g: &Geom, d: f64, cap: Cap, quad_segs: u32) -> Shapes {
    if !d.is_finite() {
        return Vec::new();
    }
    let a = step(quad_segs);
    match g {
        Geom::Points(ps) => {
            if d <= 0.0 {
                return Vec::new();
            }
            union(&ps.iter().map(|&p| vec![circle(p, d, quad_segs)]).collect())
        }
        Geom::Lines(ls) => {
            if d <= 0.0 {
                return Vec::new();
            }
            let c = match cap {
                Cap::Round => LineCap::Round(a),
                Cap::Flat => LineCap::Butt,
                Cap::Square => LineCap::Square,
            };
            let paths: Vec<Ring> = ls.iter().filter(|l| l.len() >= 2).cloned().collect();
            if paths.is_empty() {
                return Vec::new();
            }
            let style = StrokeStyle::new(2.0 * d).start_cap(c.clone()).end_cap(c).line_join(LineJoin::Round(a));
            union(&paths.stroke(style, false))
        }
        Geom::Polygons(s) => {
            let clean = union(s);
            if d == 0.0 || clean.is_empty() {
                return clean;
            }
            union(&clean.outline(&OutlineStyle::new(d).line_join(LineJoin::Round(a))))
        }
    }
}

/// Dissolve: the union of each group's polygons. `groups[i]` is the group of `geoms[i]`; groups
/// are numbered from 0. Non-polygon geometries are left out.
pub fn dissolve(geoms: &[Geom], groups: &[usize]) -> Vec<Shapes> {
    let n = groups.iter().copied().max().map_or(0, |m| m + 1);
    let mut acc: Vec<Shapes> = vec![Vec::new(); n];
    for (g, &k) in geoms.iter().zip(groups) {
        if let Geom::Polygons(s) = g {
            acc[k].extend(s.iter().cloned());
        }
    }
    acc.iter().map(union).collect()
}

/// Planar area of a multipolygon (holes subtract).
pub fn area(s: &Shapes) -> f64 {
    let ring = |r: &Ring| {
        let mut a = 0.0;
        for i in 0..r.len() {
            let (p, q) = (r[i], r[(i + 1) % r.len()]);
            a += p[0] * q[1] - q[0] * p[1];
        }
        a / 2.0
    };
    s.iter().map(|p| p.iter().enumerate().map(|(i, r)| if i == 0 { ring(r).abs() } else { -ring(r).abs() }).sum::<f64>()).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn square(x: f64, y: f64, s: f64) -> Polygon {
        vec![vec![[x, y], [x + s, y], [x + s, y + s], [x, y + s]]]
    }

    #[test]
    fn point_buffer_is_a_circle() {
        let s = buffer(&Geom::Points(vec![[10.0, 20.0]]), 5.0, Cap::Round, 32);
        assert_eq!(s.len(), 1);
        let inscribed = 0.5 * 128.0 * 25.0 * (2.0 * PI / 128.0).sin();
        assert!((area(&s) - inscribed).abs() < 1e-6 * inscribed, "{}", area(&s));
    }

    #[test]
    fn line_buffer_caps() {
        let l = Geom::Lines(vec![vec![[0.0, 0.0], [100.0, 0.0]]]);
        let flat = area(&buffer(&l, 10.0, Cap::Flat, 8));
        let square = area(&buffer(&l, 10.0, Cap::Square, 8));
        let round = area(&buffer(&l, 10.0, Cap::Round, 32));
        assert!((flat - 2000.0).abs() < 1e-3, "flat {flat}");
        assert!((square - 2400.0).abs() < 1e-3, "square {square}");
        assert!((round - (2000.0 + PI * 100.0)).abs() < 2.0, "round {round}");
    }

    #[test]
    fn polygon_grows_and_shrinks() {
        let p = Geom::Polygons(vec![square(0.0, 0.0, 100.0)]);
        let grown = area(&buffer(&p, 10.0, Cap::Round, 32));
        assert!((grown - (10000.0 + 4000.0 + PI * 100.0)).abs() < 2.0, "grown {grown}");
        let shrunk = area(&buffer(&p, -10.0, Cap::Round, 8));
        assert!((shrunk - 6400.0).abs() < 1e-3, "shrunk {shrunk}");
        assert!(buffer(&p, -60.0, Cap::Round, 8).is_empty());
    }

    #[test]
    fn dissolve_merges_groups() {
        let g: Vec<Geom> = [square(0.0, 0.0, 10.0), square(10.0, 0.0, 10.0), square(0.0, 10.0, 10.0), square(50.0, 50.0, 10.0)].into_iter().map(|p| Geom::Polygons(vec![p])).collect();
        let r = dissolve(&g, &[0, 0, 1, 0]);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].len(), 2, "two separate pieces in group 0");
        assert!((area(&r[0]) - 300.0).abs() < 1e-6);
        assert!((area(&r[1]) - 100.0).abs() < 1e-6);
        // The shared edge is gone: one outer ring of 4 corners for the two touching squares.
        let piece = r[0].iter().find(|p| area(&vec![(*p).clone()]) > 150.0).unwrap();
        assert_eq!(piece.len(), 1);
        assert_eq!(piece[0].len(), 4);
    }

    #[test]
    fn decode_round_trip_and_refusal() {
        let v = [1.0, 2.0, 0.0, 0.0, 1.0, 1.0, 2.0, 1.0, 2.0, 0.0, 0.0, 5.0, 5.0, 3.0, 1.0, 1.0, 3.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        let g = decode(&v).unwrap();
        assert_eq!(g.len(), 3);
        assert!(matches!(&g[2], Geom::Polygons(s) if s[0][0].len() == 3));
        assert!(decode(&[3.0, 1.0, 1.0, 5.0, 0.0]).is_none());
        assert!(decode(&[9.0, 0.0]).is_none());
        assert!(decode(&[1.0, 1.0, f64::NAN, 0.0]).is_none());
    }
}
