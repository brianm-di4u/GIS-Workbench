//! ICAO Annex 14 Volume I, Amendment 18 (State letter SL 2025/23), Chapter 4 as applicable from 21
//! November 2030: obstacle free surfaces (OFS, §4.2) and obstacle evaluation surfaces (OES, §4.3).
//!
//! Table-driven: Tables 4-1 to 4-15 are data below, one row per aeroplane design group (ADG)
//! column, and the surfaces are built from them into the model's shared shapes (model.rs): fans
//! (approach, take-off climb, departure, the components of the surface for precision approaches),
//! the inner surfaces of each approach (`Ofz`), level rectangles and horizontal hulls. One evaluator,
//! `Model::limits`, serves them all.
//!
//! Values are from the amendment's printed tables (PDF pp.38-60, printed pp.12-34). Where the
//! document leaves a value out or is ambiguous, the reading taken is one of the `A_*` assumptions
//! below, each named here once; `Model::assumed` says which a model made, so that a result can show
//! them.

use crate::hull::{Disc, DiscHull};
use crate::model::{bad, icao_runway, icao_strip, Airport, Fan, Horiz, Kind, Ofz, Rect, RunwayDef, Rwy, Side, Surfaces};

/// One value per ADG column of Tables 4-1 to 4-9, 4-14 and 4-15: I | IIA-IIB | IIC | III | IV | V.
type Row = [f64; 6];

/// The column of an ADG (1 I, 2 IIA, 3 IIB, 4 IIC, 5 III, 6 IV, 7 V): IIA and IIB share one.
pub(crate) fn col(adg: u8) -> usize {
    [0, 1, 1, 2, 3, 4, 5][(adg.clamp(1, 7) - 1) as usize]
}

/// Table 4-10's column: I-IIA | IIB | IIC | III | IV | V.
pub(crate) fn col10(adg: u8) -> usize {
    [0, 0, 1, 2, 3, 4, 5][(adg.clamp(1, 7) - 1) as usize]
}

/// Approach surface (§4.2.1): distance of the inner edge from the threshold, inner edge, length,
/// slope; divergence 10 % each side in every column.
pub(crate) struct ApproachTable {
    pub dist: Row,
    pub inner: Row,
    pub len: Row,
    pub slope: Row,
}

/// Table 4-1, non-instrument runways (PDF p.38).
pub(crate) const T4_1: ApproachTable = ApproachTable {
    dist: [30.0, 60.0, 60.0, 60.0, 60.0, 60.0],
    inner: [60.0, 80.0, 100.0, 125.0, 135.0, 150.0],
    len: [1600.0, 2500.0, 2500.0, 2500.0, 2500.0, 2500.0],
    slope: [0.05, 0.04, 0.0333, 0.0333, 0.0333, 0.0333],
};
/// Table 4-2, instrument runways (PDF p.39).
pub(crate) const T4_2: ApproachTable = ApproachTable { dist: [60.0; 6], inner: [110.0, 125.0, 155.0, 175.0, 185.0, 200.0], len: [4500.0; 6], slope: [0.0333; 6] };
pub(crate) const APPROACH_DIV: f64 = 0.10;

/// Tables 4-3, 4-4, 4-5 (PDF pp.41-42), inner approach surface: inner edge and length for
/// non-instrument, non-precision and precision approach runways.
pub(crate) const INNER_APPROACH_EDGE: [Row; 3] = [[60.0, 80.0, 100.0, 110.0, 120.0, 120.0], [80.0, 80.0, 120.0, 120.0, 120.0, 120.0], [90.0, 90.0, 120.0, 120.0, 120.0, 120.0]];
pub(crate) const INNER_APPROACH_LEN: [Row; 3] = [[900.0, 1125.0, 1350.0, 1350.0, 1350.0, 1350.0], [1350.0; 6], [1350.0; 6]];
/// Footnote a of Tables 4-3, 4-4, 4-5 and c of 4-9, column V: code letter F aeroplanes without
/// go-around steering avionics.
pub(crate) const CODE_F_EDGE: f64 = 140.0;

/// Tables 4-6 and 4-7 (PDF p.44): the height of the inner transitional's vertical section,
/// non-instrument and non-precision approach runways.
pub(crate) const INNER_TRANS_VERT: [Row; 2] = [[6.0, 6.0, 8.4, 10.0, 5.0, 5.0], [6.0, 6.0, 5.0, 5.0, 5.0, 5.0]];
/// Tables 4-6, 4-7 and 4-8 (PDF pp.44-45): the inner transitional's (inclined section's) slope,
/// the same in all three.
pub(crate) const INNER_TRANS_SLOPE: Row = [0.40, 0.40, 0.333, 0.333, 0.333, 0.333];
/// Tables 4-6 and 4-7 (length after the threshold) and 4-9 (balked landing distance from the
/// threshold): ∞ is "to the end of the strip"; a number is that or the end of the runway,
/// whichever is less.
pub(crate) const AFTER_THRESHOLD: Row = [f64::INFINITY, f64::INFINITY, 1800.0, 1800.0, 1800.0, 1800.0];
/// Table 4-9 (PDF p.45), balked landing surface: inner edge and slope; divergence 10 %
/// (model::OFZ_DIV). Its inner edge equals Table 4-5's in every column, so one half-width serves the
/// inner approach, the strip between and the balked landing's inner edge (checked by a test).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const BALKED_EDGE: Row = [90.0, 90.0, 120.0, 120.0, 120.0, 120.0];
pub(crate) const BALKED_SLOPE: Row = [0.05, 0.04, 0.0333, 0.0333, 0.0333, 0.0333];

/// §4.2.2.2b, §4.2.4.2b, §4.2.4.3b, §4.2.5.2c: the upper edges of the transitional, inner
/// transitional and balked landing surfaces lie 60 m above the highest threshold of the runway.
pub(crate) const OFS_TOP: f64 = 60.0;

/// Table 4-10 (PDF p.49), horizontal surface, columns I-IIA | IIB | IIC | III | IV | V: radius about
/// the thresholds and height above the aerodrome elevation.
pub(crate) const HORIZ_RADIUS: Row = [3350.0, 5350.0, 10750.0, 10750.0, 10750.0, 10750.0];
pub(crate) const HORIZ_HEIGHT: Row = [45.0, 60.0, 90.0, 90.0, 90.0, 90.0];

/// Table 4-11 (PDF p.51), surface for straight-in instrument approaches: the lower section is the
/// ADG I horizontal surface; the upper section's height, shorter side and longer side's reach
/// from the thresholds (A_STRAIGHT_IN).
pub(crate) const STRAIGHT_UPPER_HEIGHT: f64 = 60.0;
pub(crate) const STRAIGHT_SHORT_SIDE: f64 = 7410.0;
pub(crate) const STRAIGHT_LONG_REACH: f64 = 5350.0;

/// Table 4-12 (PDF pp.54-55), surface for precision approaches. Sections are (length, slope,
/// divergence each side).
pub(crate) const PREC_DIST: f64 = 60.0;
pub(crate) const PREC_EDGE: f64 = 300.0;
pub(crate) const PREC_APPROACH: [(f64, f64, f64); 2] = [(3000.0, 0.02, 0.15), (9600.0, 0.025, 0.15)];
pub(crate) const PREC_MISSED_DIST: f64 = 900.0;
pub(crate) const PREC_MISSED: [(f64, f64, f64); 2] = [(1800.0, 0.025, 0.1748), (10200.0, 0.025, 0.25)];
pub(crate) const PREC_TRANS_SLOPE: f64 = 0.143;
/// §4.3.4.8b: the transitional components' upper edge, above the threshold.
pub(crate) const PREC_TRANS_TOP: f64 = 300.0;

/// Table 4-13 (PDF p.57), instrument departure surface: inner edge, and sections; one slope for
/// both (A_DEP_SLOPE). §4.3.5.3: the inner edge 5 m above the centre line.
pub(crate) const DEP_EDGE: f64 = 300.0;
pub(crate) const DEP: [(f64, f64, f64); 2] = [(3500.0, 0.025, 0.268), (8300.0, 0.025, 0.578)];
pub(crate) const DEP_RAISE: f64 = 5.0;

/// Take-off climb surface: distance from the runway end, inner edge, divergence each side, final
/// width, length, slope.
pub(crate) type TakeOffRow = (f64, f64, f64, f64, f64, f64);
/// Table 4-14 (PDF p.60), masses up to 5 700 kg: columns I and IIA-IIB only.
pub(crate) const T4_14: [TakeOffRow; 2] = [(30.0, 60.0, 0.10, 380.0, 1600.0, 0.05), (60.0, 80.0, 0.10, 580.0, 2500.0, 0.04)];
/// Table 4-15 (PDF p.60), masses above 5 700 kg: from the end of the take-off distance available
/// (A_TODA).
pub(crate) const T4_15_EDGE: Row = [144.0, 156.0, 156.0, 172.0, 180.0, 180.0];
pub(crate) const T4_15_SLOPE: Row = [0.05, 0.04, 0.02, 0.02, 0.02, 0.02];
pub(crate) const T4_15_DIV: f64 = 0.125;
pub(crate) const T4_15_WIDTH: f64 = 1800.0;
pub(crate) const T4_15_LEN: f64 = 10000.0;
/// §4.3.6.6, §4.3.6.7: Table 4-14 "up to 5 700 kg", Table 4-15 "greater than" (A_MASS_5700).
pub(crate) const MASS_LIMIT: f64 = 5700.0;

// ---- Assumptions: what the document does not give, or gives ambiguously ----
/// The transitional surface's lower edge runs at the strip's half-width (Chapter 3 §3.4, as the
/// current edition; §4.2.2.2a gives no distance). The strip is not an OFS: its lowest limit is the
/// elevation of the nearest centre line point, as in the current edition.
pub const A_STRIP: u32 = 1 << 0;
/// The inner transitional's lower edge runs at half the inner approach's width, the inner
/// approach's sides carried on (§4.2.4.2a, §4.2.4.3a give no distance).
pub const A_INNER_EDGE: u32 = 1 << 1;
/// Non-instrument and non-precision runways: the inner transitional runs along the whole inner
/// approach (§4.2.4.2a1 gives no height for its start), its vertical section rising above its lower
/// edge.
pub const A_INNER_START: u32 = 1 << 2;
/// §4.2.2.5 sets only an upper limit ("shall not be greater than 20 per cent"): the transitional
/// slope is the current edition's Table 4-1 value for the runway's code number and approach type,
/// 14.3 % for codes 3 and 4 and for precision approach runways, 20 % otherwise (decision #97).
pub const A_TRANS_SLOPE: u32 = 1 << 3;
/// The OES follow the runways, not the operations (§4.5.2.1): a horizontal surface for every
/// runway, except a runway whose most demanding approach is non-precision, which has the surface
/// for straight-in instrument approaches instead; the surface for precision approaches at precision
/// approach ends; an instrument departure surface beyond every take-off end of a runway with an
/// instrument approach; a take-off climb surface beyond every take-off end.
pub const A_OES_CHOICE: u32 = 1 << 4;
/// Table 4-11: the shorter side is 7 410 m in all (3 705 m each side of the centre line), and the
/// longer sides run 5 350 m before and after the thresholds; the upper section is 60 m high.
pub const A_STRAIGHT_IN: u32 = 1 << 5;
/// One ADG per runway, its critical aeroplane: the lower horizontal surfaces of smaller groups that
/// also use it (Table 4-10 note) are not added.
pub const A_ONE_ADG: u32 = 1 << 6;
/// Exactly 5 700 kg takes Table 4-14, as §4.3.6.6 reads, although the table's note a says "up to
/// but not including 5 700 kg".
pub const A_MASS_5700: u32 = 1 << 7;
/// 5 700 kg or less on an ADG IIC to V runway: Table 4-14 gives no values there, so Table 4-15.
pub const A_LIGHT_LARGE: u32 = 1 << 8;
/// Table 4-15's take-off climb surface starts at the end of the take-off distance available (its
/// distance row is "-").
pub const A_TODA: u32 = 1 << 9;
/// The take-off climb surface's inner edge is at the runway end's elevation (§4.3.6.4 takes the
/// highest point on the extended centre line, which is not known), the departure surface's 5 m
/// above it.
pub const A_TAKEOFF_ELEV: u32 = 1 << 10;
/// Table 4-13 prints one 2.5 % slope, taken for both sections.
pub const A_DEP_SLOPE: u32 = 1 << 11;
/// The runway width is not known: the inner edges of Tables 4-1 and 4-2 as printed, without the
/// width notes.
pub const A_WIDTH: u32 = 1 << 12;
/// The code letter F notes of Tables 4-3 to 4-5 and 4-9 are applied to ADG V.
pub const A_CODE_F: u32 = 1 << 13;
/// Slopes and lengths as printed: not reduced for approach angles under 3°, visual approach slope
/// indicators or an OCH above 150 m (§4.2.1.8-4.2.1.11, §4.2.3.7), nor the take-off climb for
/// critical operating conditions (§4.3.6.9).
pub const A_AS_PRINTED: u32 = 1 << 14;

/// Running state over an aerodrome's runways.
#[derive(Default)]
pub(crate) struct Acc {
    /// Threshold discs per Table 4-10 column, and of the straight-in surfaces' lower section (6).
    pub discs: [Vec<Disc>; 7],
    pub assumed: u32,
}

/// The surfaces whose limit is the zone's: the OFS (§4.2) and the complex surface between the inner
/// transitionals' lower edges (§4.4.1). The strip outside them is not one (A_STRIP).
pub(crate) fn is_ofs(k: Kind) -> bool {
    matches!(k, Kind::Approach | Kind::Transitional | Kind::InnerApproach | Kind::InnerTransitional | Kind::BalkedLanding | Kind::OfzStrip)
}

/// Tables 4-1 and 4-2 inner edge, with their runway-width notes.
pub(crate) fn approach_edge(instrument: bool, c: usize, width: f64, assumed: &mut u32) -> f64 {
    let base = if instrument { T4_2.inner[c] } else { T4_1.inner[c] };
    if width.is_nan() {
        // Only the I, IIA-IIB and IIC columns have notes.
        if c <= 2 {
            *assumed |= A_WIDTH;
        }
        return base;
    }
    match (instrument, c) {
        (false, 0) if width > 30.0 => 100.0, // Table 4-1 note b
        (false, 0) if width > 23.0 => 80.0,  // note a
        (false, 1 | 2) if width > 45.0 => 110.0, // note d
        (false, 1) if width > 30.0 => 100.0, // note c
        (true, 0) if width > 30.0 => 125.0,  // Table 4-2 note a
        (true, 1) if width > 30.0 => 140.0,  // note b
        (true, 2) if width <= 30.0 => 140.0, // note c
        _ => base,
    }
}

/// The take-off climb row for an ADG column and a maximum take-off mass, and whether it is Table
/// 4-15's (which starts at the end of the take-off distance available).
pub(crate) fn takeoff_row(c: usize, mtom: f64, assumed: &mut u32) -> (TakeOffRow, bool) {
    if mtom <= MASS_LIMIT {
        if mtom == MASS_LIMIT {
            *assumed |= A_MASS_5700;
        }
        if c <= 1 {
            return (T4_14[c], false);
        }
        *assumed |= A_LIGHT_LARGE;
    }
    *assumed |= A_TODA;
    ((0.0, T4_15_EDGE[c], T4_15_DIV, T4_15_WIDTH, T4_15_LEN, T4_15_SLOPE[c]), true)
}

/// One runway's surfaces.
pub(crate) fn runway(a: &Airport, r: &RunwayDef, ri: i32, rw: &mut Rwy, sf: &mut Surfaces, acc: &mut Acc) -> Result<(), String> {
    if !(1..=7).contains(&r.adg) {
        return Err(bad("Amendment 18 needs the aeroplane design group of every runway (§1.8.1)"));
    }
    if r.ends.iter().any(|e| e.takeoff) && !r.mtom.is_finite() {
        return Err(bad("Amendment 18 needs the maximum take-off mass of the aeroplanes of every runway with a take-off climb surface (§4.3.6.6)"));
    }
    let c = col(r.adg);
    let len = rw.len;
    let typ = r.ends[0].icao.max(r.ends[1].icao);
    let (hs, ext) = icao_strip(typ, r.code);
    rw.hw = hs;
    rw.ext = ext;
    rw.base_id = sf.add(Kind::Strip, ri, -1, vec![0.0]);
    // A_TRANS_SLOPE: the current edition's slope, not §4.2.2.5's 20 % limit.
    let trans = icao_runway(typ, r.code).0;
    rw.trans_slope = trans;
    rw.trans_id = sf.add(Kind::Transitional, ri, -1, vec![trans]);
    let top = r.ends[0].thr_elev.max(r.ends[1].thr_elev) + OFS_TOP;
    rw.trans_top = Some(top);
    acc.assumed |= A_STRIP | A_TRANS_SLOPE | A_OES_CHOICE | A_AS_PRINTED;
    for e in &r.ends {
        if e.approach && e.disp >= len {
            return Err(bad("a displaced threshold lies beyond the far end of its runway"));
        }
    }
    let s_thr = [r.ends[0].disp, len - r.ends[1].disp];
    let thresholds = s_thr.map(|s| (rw.ax + s * rw.ux, rw.ay + s * rw.uy));
    // §4.5.2.1, by runway (A_OES_CHOICE): the most demanding approach.
    let best = r.ends.iter().filter(|e| e.approach).map(|e| e.icao).max();
    if best == Some(1) {
        for (x, y) in thresholds {
            acc.discs[6].push(Disc { x, y, r: HORIZ_RADIUS[0] });
        }
        let id = sf.add(Kind::StraightIn, ri, -1, vec![0.0]);
        rw.rects.push(Rect { id, s0: s_thr[0] - STRAIGHT_LONG_REACH, s1: s_thr[1] + STRAIGHT_LONG_REACH, hw: STRAIGHT_SHORT_SIDE / 2.0, z: a.elev + STRAIGHT_UPPER_HEIGHT });
        acc.assumed |= A_STRAIGHT_IN;
    } else {
        for (x, y) in thresholds {
            acc.discs[col10(r.adg)].push(Disc { x, y, r: HORIZ_RADIUS[col10(r.adg)] });
        }
        acc.assumed |= A_ONE_ADG;
    }
    for k in 0..2 {
        let e = &r.ends[k];
        let ki = k as i32;
        // Outward beyond end k.
        let out = if k == 0 { -1.0 } else { 1.0 };
        if e.approach {
            let instrument = e.icao >= 1;
            let t = if instrument { &T4_2 } else { &T4_1 };
            let edge = approach_edge(instrument, c, r.width, &mut acc.assumed);
            let id = sf.add(Kind::Approach, ri, ki, vec![t.slope[c]]);
            let side = Some(Side { slope: trans, id: rw.trans_id, top });
            rw.fans.push(Fan { id, s0: s_thr[k] + out * t.dist[c], dir: out, hw0: edge / 2.0, hw_max: f64::INFINITY, sections: vec![(t.len[c], t.slope[c], APPROACH_DIV)], len: t.len[c], base: e.thr_elev, pir: false, side });
            if e.icao >= 2 {
                // §4.3.4: approach, missed approach, transitional and lower components.
                let pa = sf.add(Kind::PrecisionApproach, ri, ki, PREC_APPROACH.iter().map(|s| s.1).collect());
                let pm = sf.add(Kind::PrecisionMissedApproach, ri, ki, PREC_MISSED.iter().map(|s| s.1).collect());
                let pt = sf.add(Kind::PrecisionTransitional, ri, ki, vec![PREC_TRANS_SLOPE]);
                let pl = sf.add(Kind::PrecisionLower, ri, ki, vec![0.0]);
                let side = Some(Side { slope: PREC_TRANS_SLOPE, id: pt, top: e.thr_elev + PREC_TRANS_TOP });
                let fan = |id: usize, s0: f64, dir: f64, sections: Vec<(f64, f64, f64)>| Fan { id, s0, dir, hw0: PREC_EDGE / 2.0, hw_max: f64::INFINITY, len: sections.iter().map(|s| s.0).sum(), sections, base: e.thr_elev, pir: false, side };
                rw.fans.push(fan(pa, s_thr[k] + out * PREC_DIST, out, PREC_APPROACH.to_vec()));
                rw.fans.push(fan(pm, s_thr[k] - out * PREC_MISSED_DIST, -out, PREC_MISSED.to_vec()));
                rw.fans.push(fan(pl, s_thr[k] + out * PREC_DIST, -out, vec![(PREC_DIST + PREC_MISSED_DIST, 0.0, 0.0)]));
            }
        }
        if e.takeoff {
            let end = if k == 0 { 0.0 } else { len };
            let ((d0, edge, div, wf, l, slope), toda) = takeoff_row(c, r.mtom, &mut acc.assumed);
            // Table 4-14 note b: from the end of the clearway where it is longer than the distance.
            let start = if toda { e.clearway } else { d0.max(e.clearway) };
            let wf = if r.tocs_width.is_nan() { wf } else { r.tocs_width };
            let id = sf.add(Kind::TakeOff, ri, ki, vec![slope]);
            rw.fans.push(Fan { id, s0: end + out * start, dir: out, hw0: edge / 2.0, hw_max: wf / 2.0, sections: vec![(l, slope, div)], len: l, base: e.elev, pir: false, side: None });
            acc.assumed |= A_TAKEOFF_ELEV;
            if best.unwrap_or(0) >= 1 {
                let id = sf.add(Kind::Departure, ri, ki, DEP.iter().map(|s| s.1).collect());
                rw.fans.push(Fan { id, s0: end + out * e.clearway, dir: out, hw0: DEP_EDGE / 2.0, hw_max: f64::INFINITY, sections: DEP.to_vec(), len: DEP.iter().map(|s| s.0).sum(), base: e.elev + DEP_RAISE, pir: false, side: None });
                acc.assumed |= A_DEP_SLOPE;
            }
        }
    }
    // The inner approach, inner transitional and balked landing surfaces of each approach, after the
    // surfaces above as in the current edition.
    for k in 0..2 {
        let e = &r.ends[k];
        if !e.approach {
            continue;
        }
        let ty = e.icao.min(2) as usize;
        let precision = ty == 2;
        let t = if e.icao >= 1 { &T4_2 } else { &T4_1 };
        let mut w = INNER_APPROACH_EDGE[ty][c];
        if c == 5 && a.code_f {
            w = CODE_F_EDGE;
            acc.assumed |= A_CODE_F;
        }
        let run = len - e.disp;
        let ub = if AFTER_THRESHOLD[c].is_infinite() { run + ext } else { run.min(AFTER_THRESHOLD[c]) };
        let dir = -(if k == 0 { -1.0 } else { 1.0 });
        let b_elev = rw.elev_at(s_thr[k] + dir * ub);
        let ia_id = sf.add(Kind::InnerApproach, ri, k as i32, vec![t.slope[c]]);
        let it_id = sf.add(Kind::InnerTransitional, ri, k as i32, vec![INNER_TRANS_SLOPE[c]]);
        let (bl_id, b_slope, b_len) = if precision {
            let id = sf.add(Kind::BalkedLanding, ri, k as i32, vec![BALKED_SLOPE[c]]);
            (id, BALKED_SLOPE[c], ((top - b_elev) / BALKED_SLOPE[c]).max(0.0))
        } else {
            (usize::MAX, 0.0, 0.0)
        };
        let st_id = sf.add(Kind::OfzStrip, ri, k as i32, vec![0.0]);
        let vert = if precision { 0.0 } else { INNER_TRANS_VERT[ty][c] };
        acc.assumed |= A_INNER_EDGE | if precision { 0 } else { A_INNER_START };
        rw.zones.push(Ofz { dir, s_thr: s_thr[k], hw: w / 2.0, thr_elev: e.thr_elev, dist: t.dist[c], ia_len: INNER_APPROACH_LEN[ty][c], ia_slope: t.slope[c], it_slope: INNER_TRANS_SLOPE[c], vert, ub, b_elev, b_slope, b_len, top, ia_id, it_id, bl_id, st_id });
    }
    Ok(())
}

/// The aerodrome's horizontal surfaces, one per Table 4-10 column in use, and the lower section of
/// the straight-in surfaces.
pub(crate) fn horizontal(a: &Airport, sf: &mut Surfaces, discs: [Vec<Disc>; 7]) -> Vec<Horiz> {
    let mut out = Vec::new();
    for (k, d) in discs.into_iter().enumerate() {
        if d.is_empty() {
            continue;
        }
        let (kind, z) = if k < 6 { (Kind::Horizontal, a.elev + HORIZ_HEIGHT[k]) } else { (Kind::StraightIn, a.elev + HORIZ_HEIGHT[0]) };
        let id = sf.add(kind, -1, -1, vec![0.0]);
        out.push(Horiz { id, hull: DiscHull::new(d), z });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{encode, parse, EndDef, Model, Regime};

    /// An east–west runway of about 3 000 m at 36° N, level at `elev`, thresholds at the ends.
    fn runway(adg: u8, code: u8, icao: [u8; 2], elev: f64, width: f64, mtom: f64) -> RunwayDef {
        let dlon = 3000.0 / (111_412.84 * 36f64.to_radians().cos() - 93.5 * (3.0 * 36f64.to_radians()).cos());
        let e = |lon: f64, i: u8| EndDef { lat: 36.0, lon, elev, p77: 5, icao: i, disp: 0.0, thr_elev: elev, approach: true, takeoff: true, clearway: 0.0 };
        RunwayDef { paved: true, code, tocs_width: f64::NAN, adg, width, mtom, ends: [e(-115.0, icao[0]), e(-115.0 + dlon, icao[1])] }
    }

    fn model(r: RunwayDef, elev: f64, code_f: bool) -> Model {
        let a = Airport { regime: Regime::IcaoA18, elev, ihs_datum: f64::NAN, code_f, runways: vec![r] };
        Model::build(&parse(&encode(&a)).unwrap()).unwrap()
    }

    fn at(m: &Model, s: f64, t: f64) -> ((f64, Option<Kind>), (f64, Option<Kind>)) {
        let (x, y) = m.station(s, t);
        let l = m.limits(x, y);
        let kind = |id: usize| (id != usize::MAX).then(|| m.surfaces[id].kind);
        ((l.lowest.0, kind(l.lowest.1)), (l.zone.0, kind(l.zone.1)))
    }

    fn near(a: f64, b: f64) -> bool {
        (a.is_nan() && b.is_nan()) || (a - b).abs() < 1e-6
    }

    /// (s, t, lowest height, lowest kind, zone height, zone kind): heights NaN for none; a kind of
    /// None with a height checks the height only (where two surfaces tie).
    fn expect(m: &Model, cases: &[(f64, f64, f64, Option<Kind>, f64, Option<Kind>)], what: &str) {
        for &(s, t, lz, lk, zz, zk) in cases {
            let ((z, k), (zo, zok)) = at(m, s, t);
            assert!(near(z, lz), "{what} ({s}, {t}): lowest {z} {k:?}, want {lz} {lk:?}");
            if lk.is_some() || lz.is_nan() {
                assert_eq!(k, lk, "{what} ({s}, {t}): lowest kind");
            }
            assert!(near(zo, zz), "{what} ({s}, {t}): zone {zo} {zok:?}, want {zz} {zk:?}");
            if zk.is_some() || zz.is_nan() {
                assert_eq!(zok, zk, "{what} ({s}, {t}): zone kind");
            }
        }
    }

    #[test]
    fn tables_hold_together() {
        // Table 4-9's inner edge is Table 4-5's (PDF pp.42, 45): one half-width serves both.
        assert_eq!(BALKED_EDGE, INNER_APPROACH_EDGE[2]);
        // §4.2.3.7: the inner approach protects to 45 m (150 ft): length × the approach slope.
        for c in 0..6 {
            assert!((INNER_APPROACH_LEN[0][c] * T4_1.slope[c] - 45.0).abs() < 0.1, "{c}");
            for ty in 1..3 {
                assert!((INNER_APPROACH_LEN[ty][c] * T4_2.slope[c] - 45.0).abs() < 0.1, "{ty} {c}");
            }
        }
        // Table 4-12: both components reach the transitional components' 300 m top at their ends.
        let rise = |s: &[(f64, f64, f64)]| s.iter().map(|q| q.0 * q.1).sum::<f64>();
        assert!((rise(&PREC_APPROACH) - PREC_TRANS_TOP).abs() < 1e-9);
        assert!((rise(&PREC_MISSED) - PREC_TRANS_TOP).abs() < 1e-9);
        assert_eq!((1..=7).map(col).collect::<Vec<_>>(), [0, 1, 1, 2, 3, 4, 5]);
        assert_eq!((1..=7).map(col10).collect::<Vec<_>>(), [0, 0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn approach_inner_edge_runway_width_notes() {
        // Table 4-1 notes a-d (PDF p.38) and Table 4-2 notes a-c (PDF p.39).
        let mut a = 0;
        for (inst, c, w, want) in [
            (false, 0, 23.0, 60.0),
            (false, 0, 25.0, 80.0),
            (false, 0, 30.0, 80.0),
            (false, 0, 31.0, 100.0),
            (false, 1, 30.0, 80.0),
            (false, 1, 40.0, 100.0),
            (false, 1, 46.0, 110.0),
            (false, 2, 45.0, 100.0),
            (false, 2, 46.0, 110.0),
            (false, 3, 60.0, 125.0),
            (true, 0, 30.0, 110.0),
            (true, 0, 31.0, 125.0),
            (true, 1, 31.0, 140.0),
            (true, 2, 30.0, 140.0),
            (true, 2, 31.0, 155.0),
            (true, 5, 20.0, 200.0),
        ] {
            assert_eq!(approach_edge(inst, c, w, &mut a), want, "{inst} {c} {w}");
        }
        assert_eq!(a, 0);
        assert_eq!(approach_edge(true, 2, f64::NAN, &mut a), 155.0);
        assert_eq!(a, A_WIDTH);
        let mut b = 0;
        approach_edge(true, 4, f64::NAN, &mut b);
        assert_eq!(b, 0, "columns III to V have no width notes");
    }

    #[test]
    fn precision_adg_iv_hand_cases() {
        // ADG IV, code 4, 45 m wide, heavy. End A: a precision approach, no take-off climb beyond
        // it; end B: take-offs only. Level at 100 m; the aerodrome at 100 m.
        let mut r = runway(6, 4, [2, 2], 100.0, 45.0, 300000.0);
        r.ends[0].takeoff = false;
        r.ends[1].approach = false;
        let m = model(r, 100.0, false);
        let len = m.length();
        use Kind::*;
        expect(
            &m,
            &[
                // 1 060 m before the threshold: the Table 4-12 approach component, 60 m out, 2 % →
                // 120 m (PDF p.54); the OFS approach (Table 4-2, 3.33 %, PDF p.39) and inner approach
                // (Table 4-5, PDF p.42) tie at 133.3 m.
                (-1060.0, 0.0, 120.0, Some(PrecisionApproach), 133.3, None),
                // 4 060 m out: 3 000 m at 2 % then 1 000 m at 2.5 % → 185 m, under the 90 m horizontal
                // surface (Table 4-10 IV, 190 m, PDF p.49); the OFS approach 4 000 × 3.33 % → 233.2 m.
                (-4060.0, 0.0, 185.0, Some(PrecisionApproach), 233.2, Some(Approach)),
                // Beyond the 4 500 m approach: no OFS. The component (2.5 %, 210 m) is above the
                // horizontal surface.
                (-5060.0, 0.0, 190.0, Some(Horizontal), f64::NAN, None),
                // 500 m out, 150 m off: the approach's half-width is 92.5 + 50 = 142.5 m, so the 14.3 %
                // transitional (A_TRANS_SLOPE: Table 4-1 of the current edition, code 4) is 1.0725 m
                // above its 116.65 m side; the approach component (half-width 150 + 75 = 225 m) is
                // lower at 110 m.
                (-560.0, 150.0, 110.0, Some(PrecisionApproach), 117.7225, Some(Transitional)),
                // 300 m off: the transitional component, 14.3 % beyond 225 m → 120.725 m; the OFS
                // transitional 157.5 m beyond the approach's side → 139.1725 m.
                (-560.0, 300.0, 120.725, Some(PrecisionTransitional), 139.1725, Some(Transitional)),
                // Over the runway, 200 m off: the transitional component off the lower component's
                // 150 m side → 107.15 m; the OFS transitional off the 140 m strip → 108.58 m.
                (300.0, 200.0, 107.15, Some(PrecisionTransitional), 108.58, Some(Transitional)),
                // Mid-runway, 100 m off: the strip; the inner transitional (Table 4-8, 33.3 %, PDF
                // p.45) 40 m beyond the inner approach's 60 m half-width → 113.32 m.
                (1500.0, 100.0, 100.0, Some(Strip), 113.32, Some(InnerTransitional)),
                // Balked landing (Table 4-9, PDF p.45): 1 800 m after the threshold, 3.33 %.
                (2100.0, 0.0, 100.0, Some(Strip), 109.99, Some(BalkedLanding)),
                // The missed approach component (Table 4-12): 900 m after the threshold, 1 800 m at
                // 17.48 % then 25 %, 2.5 %: 2 800 m in → 170 m, half-width 714.64 m.
                (3700.0, 700.0, 170.0, Some(PrecisionMissedApproach), f64::NAN, None),
                (3700.0, 720.0, 170.0 + 5.36 * 0.143, Some(PrecisionTransitional), f64::NAN, None),
                // Mid-runway, 10 700 m off: within the 10 750 m arcs; 10 800 m: outside every surface.
                (1500.0, 10700.0, 190.0, Some(Horizontal), f64::NAN, None),
                (1500.0, 10800.0, f64::NAN, None, f64::NAN, None),
            ],
            "precision ADG IV",
        );
        // Beyond end B: Table 4-15 IV (PDF p.60) from the end of the TODA, 2 %; no OFS (the balked
        // landing ends 60 m above the threshold, 1 801.8 m on).
        expect(&m, &[(len + 1060.0, 0.0, 121.2, Some(TakeOff), f64::NAN, None)], "take-off");
        // Table 4-13 (PDF p.57): 11 500 m beyond, 5 m + 2.5 % → 392.5 m; half-width 150 + 3 500 ×
        // 26.8 % + 8 000 × 57.8 % = 5 712 m.
        expect(&m, &[(len + 11500.0, 1000.0, 392.5, Some(Departure), f64::NAN, None)], "departure");
        let want = A_ONE_ADG | A_TODA | A_DEP_SLOPE | A_INNER_EDGE;
        assert_eq!(m.assumed & want, want);
        assert_eq!(m.assumed & (A_STRAIGHT_IN | A_INNER_START | A_WIDTH | A_MASS_5700 | A_CODE_F), 0);
    }

    #[test]
    fn non_precision_adg_iic_straight_in_hand_cases() {
        // ADG IIC, code 3, 30 m wide: non-precision approaches to both ends, no take-offs; level at
        // 50 m. The most demanding approach is non-precision: the straight-in surface, no horizontal.
        let mut r = runway(4, 3, [1, 1], 50.0, 30.0, f64::NAN);
        r.ends[0].takeoff = false;
        r.ends[1].takeoff = false;
        let m = model(r, 50.0, false);
        use Kind::*;
        expect(
            &m,
            &[
                // Table 4-2 IIC, 30 m wide: inner edge 140 m (note c); 300 m in → 59.99 m.
                (-360.0, 0.0, 59.99, None, 59.99, None),
                (-360.0, 75.0, 59.99, Some(Approach), 59.99, Some(Approach)),
                // Table 4-7 IIC (PDF p.44): a 5 m vertical section 60 m out (Table 4-4's 120 m), then
                // 33.3 %: 2 m beyond → 55.666 m.
                (1500.0, 62.0, 50.0, Some(Strip), 55.666, Some(InnerTransitional)),
                // Code 3: the 14.3 % transitional (A_TRANS_SLOPE) 60 m beyond the 140 m strip.
                (1500.0, 200.0, 58.58, Some(Transitional), 58.58, Some(Transitional)),
                // Table 4-11 (PDF p.51): the lower section is the ADG I horizontal surface (3 350 m,
                // 45 m), the upper a 7 410 m by (runway + 2 × 5 350 m) rectangle at 60 m.
                (1500.0, 3300.0, 95.0, Some(StraightIn), f64::NAN, None),
                (1500.0, 3500.0, 110.0, Some(StraightIn), f64::NAN, None),
                (1500.0, 3700.0, 110.0, Some(StraightIn), f64::NAN, None),
                (1500.0, 3710.0, f64::NAN, None, f64::NAN, None),
                (-2000.0, 0.0, 95.0, Some(StraightIn), 50.0 + 1940.0 * 0.0333, Some(Approach)),
                (-5000.0, 0.0, 110.0, Some(StraightIn), f64::NAN, None),
                (-5400.0, 0.0, f64::NAN, None, f64::NAN, None),
            ],
            "non-precision ADG IIC",
        );
        assert!(m.surfaces.iter().all(|s| s.kind != Horizontal));
        assert_eq!(m.assumed & (A_STRAIGHT_IN | A_INNER_START), A_STRAIGHT_IN | A_INNER_START);
        assert_eq!(m.assumed & (A_ONE_ADG | A_TODA | A_WIDTH), 0);
    }

    #[test]
    fn take_off_climb_by_mass() {
        // Non-instrument code 1, no approaches; take-offs both ways; level at 10 m.
        let light = |adg: u8, mtom: f64, clearway: f64| {
            let mut r = runway(adg, 1, [0, 0], 10.0, 18.0, mtom);
            r.ends[0].approach = false;
            r.ends[1].approach = false;
            r.ends[1].clearway = clearway;
            model(r, 10.0, false)
        };
        use Kind::*;
        // Table 4-14 I (PDF p.60): 30 m beyond the end, 60 m, 10 %, 5 %: 500 m in → 35 m, half-width
        // 80 m; beside it the ADG I horizontal surface (45 m above 10 m).
        let m = light(1, 1500.0, 0.0);
        let len = m.length();
        expect(&m, &[(len + 530.0, 79.0, 35.0, Some(TakeOff), f64::NAN, None), (len + 530.0, 81.0, 55.0, Some(Horizontal), f64::NAN, None)], "4-14 I");
        assert_eq!(m.assumed & (A_TODA | A_MASS_5700 | A_LIGHT_LARGE), 0);
        // Note b: a 100 m clearway moves the inner edge to its end.
        let m = light(1, 1500.0, 100.0);
        expect(&m, &[(len + 600.0, 0.0, 35.0, Some(TakeOff), f64::NAN, None)], "4-14 clearway");
        // Above 5 700 kg, Table 4-15 I: 144 m at the end of the TODA, 12.5 %, 5 %.
        let m = light(1, 5701.0, 0.0);
        expect(&m, &[(len + 530.0, 130.0, 36.5, Some(TakeOff), f64::NAN, None)], "4-15 I");
        assert_ne!(m.assumed & A_TODA, 0);
        // Exactly 5 700 kg: Table 4-14 (§4.3.6.6), IIA-IIB: 60 m, 80 m, 10 %, 4 %.
        let m = light(3, 5700.0, 0.0);
        expect(&m, &[(len + 560.0, 89.0, 30.0, Some(TakeOff), f64::NAN, None)], "4-14 IIB at 5 700 kg");
        assert_ne!(m.assumed & A_MASS_5700, 0);
        // A light aeroplane on an ADG IIC runway: Table 4-14 has no column, so Table 4-15 IIC, 2 %.
        let m = light(4, 5000.0, 0.0);
        expect(&m, &[(len + 500.0, 0.0, 20.0, Some(TakeOff), f64::NAN, None)], "4-15 IIC light");
        assert_ne!(m.assumed & A_LIGHT_LARGE, 0);
    }

    #[test]
    fn code_letter_f_and_the_vertical_section() {
        // ADG V precision: 140 m inner edges with the code letter F flag (Table 4-5 note a).
        let mut r = runway(7, 4, [2, 1], 100.0, 60.0, 400000.0);
        r.ends[0].takeoff = false;
        r.ends[1].takeoff = false;
        let wide = model(r, 100.0, true);
        let narrow = model(r, 100.0, false);
        let (_, (z, k)) = at(&wide, 1500.0, 69.0);
        assert_eq!((z, k), (100.0, Some(Kind::OfzStrip)));
        let (_, (z, _)) = at(&narrow, 1500.0, 69.0);
        assert!((z - (100.0 + 9.0 * 0.333)).abs() < 1e-9);
        assert_ne!(wide.assumed & A_CODE_F, 0);
        assert_eq!(narrow.assumed & A_CODE_F, 0);
        // Non-instrument ADG III (Table 4-6, PDF p.44): a 10 m vertical section 55 m out (Table 4-3:
        // 110 m), then 33.3 %. Code 4: inside the 75 m strip half-width.
        let mut r = runway(5, 4, [0, 0], 20.0, 45.0, f64::NAN);
        r.ends[0].takeoff = false;
        r.ends[1].takeoff = false;
        let m = model(r, 20.0, false);
        let (_, (z, k)) = at(&m, 1500.0, 60.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - (20.0 + 10.0 + 5.0 * 0.333)).abs() < 1e-9, "{z}");
        // Code 3: the strip is 55 m, the inner approach's half-width, so the transitional (14.3 %,
        // A_TRANS_SLOPE) lies below the vertical section all along it.
        r.code = 3;
        let m = model(r, 20.0, false);
        let (_, (z, k)) = at(&m, 1500.0, 56.0);
        assert_eq!(k, Some(Kind::Transitional));
        assert!((z - 20.143).abs() < 1e-9, "{z}");
        let slope = |m: &Model| m.surfaces.iter().find(|s| s.kind == Kind::Transitional).unwrap().slopes[0];
        assert_eq!(slope(&m), 0.143);
        // Codes 1 and 2 without a precision approach: 20 %; precision approach runways: 14.3 %.
        r.code = 2;
        assert_eq!(slope(&model(r, 20.0, false)), 0.20);
        r.ends[0].icao = 2;
        assert_eq!(slope(&model(r, 20.0, false)), 0.143);
    }

    #[test]
    fn needs_the_design_group_and_the_mass() {
        let a = |r: RunwayDef| Model::build(&Airport { regime: Regime::IcaoA18, elev: 10.0, ihs_datum: f64::NAN, code_f: false, runways: vec![r] });
        assert!(a(runway(0, 4, [2, 2], 10.0, 45.0, 70000.0)).unwrap_err().contains("aeroplane design group"));
        assert!(a(runway(6, 4, [2, 2], 10.0, 45.0, f64::NAN)).unwrap_err().contains("maximum take-off mass"));
        let mut r = runway(6, 4, [2, 2], 10.0, 45.0, f64::NAN);
        r.ends[0].takeoff = false;
        r.ends[1].takeoff = false;
        assert!(a(r).is_ok());
    }

    #[test]
    fn version_2_lists_still_load() {
        let r = runway(0, 4, [2, 1], 100.0, f64::NAN, f64::NAN);
        for regime in [Regime::Part77, Regime::Icao] {
            let v3 = encode(&Airport { regime, elev: 100.0, ihs_datum: f64::NAN, code_f: false, runways: vec![r] });
            // Version 2: no design group, width or mass after the take-off climb width.
            let mut v2 = vec![2.0];
            v2.extend_from_slice(&v3[1..9]);
            v2.extend_from_slice(&v3[12..]);
            let (m2, m3) = (Model::build(&parse(&v2).unwrap()).unwrap(), Model::build(&parse(&v3).unwrap()).unwrap());
            for (s, t) in [(-1000.0, 0.0), (1500.0, 200.0), (1500.0, 3000.0), (3500.0, 50.0)] {
                let (x, y) = m3.station(s, t);
                let (a, b) = (m2.limits(x, y), m3.limits(x, y));
                assert!(near(a.lowest.0, b.lowest.0) && a.lowest.1 == b.lowest.1 && near(a.zone.0, b.zone.0));
            }
            // Regime 2 needs version 3.
            v2[1] = 2.0;
            assert!(parse(&v2).is_err());
        }
    }
}
