//! Surface model: runway definitions in, the lowest limiting surface at any position out.
//!
//! Three regimes:
//! * `0` FAA 14 CFR Part 77 §77.19;
//! * `1` ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20
//!   November 2030 (Table 4-1, with Table 4-2 and §3.4 of the strip). The inner approach, inner
//!   transitional and balked landing surfaces of a precision approach runway, with the part of the
//!   strip between them, form the obstacle-free zone. They mostly lie above the strip, transitional
//!   and approach surfaces, and Annex 14 limits what may stand above them more strictly, so `limits`
//!   also gives the zone's own lowest limit: a penetration of the zone would otherwise read as one of
//!   a lower surface, or not show;
//! * `2` the same amendment's Chapter 4 as applicable from 21 November 2030: obstacle free surfaces
//!   (OFS) and obstacle evaluation surfaces (OES), table-driven in a18.rs. `limits` gives the lowest
//!   of them all and, as the zone, the lowest obstacle free surface.
//!
//! Definition list (f64, version 3):
//! `[3, regime (0 Part 77, 1 Annex 14, 2 Annex 14 Amendment 18 OFS/OES), aerodrome elevation m, IHS
//! datum m (NaN: the aerodrome elevation), runway count, code letter F flag (1: the aerodrome takes
//! code letter F aeroplanes without go-around steering avionics, and the zone's inner edges are
//! 140 m), then per runway: paved (0/1), Annex 14 code number (1–4), take-off climb final width m
//! (NaN: the table's), aeroplane design group (0 none, 1 I, 2 IIA, 3 IIB, 4 IIC, 5 III, 6 IV, 7 V),
//! runway width m (NaN: unknown), maximum certificated take-off mass kg of its aeroplanes (NaN:
//! unknown), then per end (two): lat, lon, end elevation m, Part 77 category, Annex 14 approach
//! type, displaced threshold m, threshold elevation m (NaN: the end's), flags (bit 0 an approach to
//! this end, bit 1 a take-off climb surface beyond this end), clearway m]`.
//! Version 2 lists, without the three runway values after the take-off climb width, still load,
//! for regimes 0 and 1.
//!
//! Part 77 categories (NASR `FAR_PART_77_CODE`): 0 A(V) utility visual, 1 A(NP) utility
//! non-precision, 2 B(V) other than utility, visual, 3 C non-precision with visibility minimums
//! above ¾ statute mile, 4 D non-precision as low as ¾ mile, 5 PIR precision instrument.
//! Annex 14 approach types: 0 non-instrument, 1 non-precision, 2 precision category I, 3 precision
//! category II or III (Amendment 18 Chapter 4 from 2030 treats 2 and 3 alike).

use crate::a18;
use crate::frame::Frame;
use crate::hull::{Disc, DiscHull};
use crate::FT;

pub const MAX_RUNWAYS: usize = 32;
/// Surface indices travel as u8 with 255 for none.
pub const MAX_SURFACES: usize = 254;
const HEAD: usize = 6;
const PER_RWY_V2: usize = 3;
const PER_RWY: usize = 6;
const PER_END: usize = 9;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Regime {
    Part77,
    Icao,
    /// Annex 14 Chapter 4 as applicable from 21 November 2030 (Amendment 18 OFS and OES).
    IcaoA18,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
pub enum Kind {
    Primary,
    Approach,
    Transitional,
    Horizontal,
    Conical,
    Strip,
    InnerHorizontal,
    TakeOff,
    InnerApproach,
    InnerTransitional,
    BalkedLanding,
    /// The part of the strip bounded by the zone's surfaces.
    OfzStrip,
    /// Amendment 18 §4.3.3: the surface for straight-in instrument approaches.
    StraightIn,
    /// Amendment 18 §4.3.4: the components of the surface for precision approaches.
    PrecisionApproach,
    PrecisionMissedApproach,
    PrecisionTransitional,
    PrecisionLower,
    /// Amendment 18 §4.3.5: the instrument departure surface.
    Departure,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::Primary => "primary",
            Kind::Approach => "approach",
            Kind::Transitional => "transitional",
            Kind::Horizontal => "horizontal",
            Kind::Conical => "conical",
            Kind::Strip => "strip",
            Kind::InnerHorizontal => "innerHorizontal",
            Kind::TakeOff => "takeoff",
            Kind::InnerApproach => "innerApproach",
            Kind::InnerTransitional => "innerTransitional",
            Kind::BalkedLanding => "balkedLanding",
            Kind::OfzStrip => "ofzStrip",
            Kind::StraightIn => "straightIn",
            Kind::PrecisionApproach => "precisionApproach",
            Kind::PrecisionMissedApproach => "precisionMissedApproach",
            Kind::PrecisionTransitional => "precisionTransitional",
            Kind::PrecisionLower => "precisionLower",
            Kind::Departure => "departure",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct EndDef {
    pub lat: f64,
    pub lon: f64,
    pub elev: f64,
    pub p77: u8,
    pub icao: u8,
    pub disp: f64,
    pub thr_elev: f64,
    pub approach: bool,
    pub takeoff: bool,
    pub clearway: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct RunwayDef {
    pub paved: bool,
    pub code: u8,
    pub tocs_width: f64,
    /// Aeroplane design group 1 I, 2 IIA, 3 IIB, 4 IIC, 5 III, 6 IV, 7 V (0: not given).
    pub adg: u8,
    /// Runway width m (NaN: unknown).
    pub width: f64,
    /// Maximum certificated take-off mass of the runway's aeroplanes, kg (NaN: unknown).
    pub mtom: f64,
    pub ends: [EndDef; 2],
}

#[derive(Clone, Debug)]
pub struct Airport {
    pub regime: Regime,
    pub elev: f64,
    pub ihs_datum: f64,
    pub code_f: bool,
    pub runways: Vec<RunwayDef>,
}

pub(crate) fn bad(m: &str) -> String {
    format!("obstruction surfaces: {m}")
}

/// Parse and check a definition list (version 3, or version 2 for regimes 0 and 1).
pub fn parse(v: &[f64]) -> Result<Airport, String> {
    if v.len() < HEAD || !(v[0] == 2.0 || v[0] == 3.0) {
        return Err(bad("not a version 2 or 3 definition list"));
    }
    let v3 = v[0] == 3.0;
    let regime = match v[1] {
        x if x == 0.0 => Regime::Part77,
        x if x == 1.0 => Regime::Icao,
        x if x == 2.0 && v3 => Regime::IcaoA18,
        _ => return Err(bad("unknown regime")),
    };
    let elev = v[2];
    if !elev.is_finite() || !(-500.0..=9000.0).contains(&elev) {
        return Err(bad("aerodrome elevation out of range"));
    }
    let ihs_datum = if v[3].is_nan() { elev } else { v[3] };
    if !ihs_datum.is_finite() || !(-500.0..=9000.0).contains(&ihs_datum) {
        return Err(bad("inner horizontal datum out of range"));
    }
    let nr = v[4];
    if !(nr >= 1.0 && nr <= MAX_RUNWAYS as f64 && nr.fract() == 0.0) {
        return Err(bad("runway count must be 1 to 32"));
    }
    let nr = nr as usize;
    if v[5] != 0.0 && v[5] != 1.0 {
        return Err(bad("code letter F flag out of range"));
    }
    let per_rwy = if v3 { PER_RWY } else { PER_RWY_V2 };
    if v.len() != HEAD + nr * (per_rwy + 2 * PER_END) {
        return Err(bad("definition length does not match the runway count"));
    }
    let mut runways = Vec::with_capacity(nr);
    for r in 0..nr {
        let b = HEAD + r * (per_rwy + 2 * PER_END);
        let code = v[b + 1];
        if !(code >= 1.0 && code <= 4.0 && code.fract() == 0.0) {
            return Err(bad("code number must be 1 to 4"));
        }
        let tw = v[b + 2];
        if !(tw.is_nan() || (tw.is_finite() && (100.0..=5000.0).contains(&tw))) {
            return Err(bad("take-off climb final width out of range"));
        }
        let (adg, width, mtom) = if v3 { (v[b + 3], v[b + 4], v[b + 5]) } else { (0.0, f64::NAN, f64::NAN) };
        if !(adg >= 0.0 && adg <= 7.0 && adg.fract() == 0.0) {
            return Err(bad("aeroplane design group out of range"));
        }
        if !(width.is_nan() || (width.is_finite() && (3.0..=150.0).contains(&width))) {
            return Err(bad("runway width out of range"));
        }
        if !(mtom.is_nan() || (mtom.is_finite() && (1.0..=1.0e6).contains(&mtom))) {
            return Err(bad("maximum take-off mass out of range"));
        }
        let mut ends = [EndDef { lat: 0.0, lon: 0.0, elev: 0.0, p77: 0, icao: 0, disp: 0.0, thr_elev: 0.0, approach: true, takeoff: true, clearway: 0.0 }; 2];
        for (k, e) in ends.iter_mut().enumerate() {
            let o = b + per_rwy + k * PER_END;
            let (lat, lon, el) = (v[o], v[o + 1], v[o + 2]);
            if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 85.0 && lon.abs() <= 180.0) {
                return Err(bad("runway end position out of range"));
            }
            if !el.is_finite() || !(-500.0..=9000.0).contains(&el) {
                return Err(bad("runway end elevation out of range"));
            }
            let (p77, icao) = (v[o + 3], v[o + 4]);
            if !(p77 >= 0.0 && p77 <= 5.0 && p77.fract() == 0.0) || !(icao >= 0.0 && icao <= 3.0 && icao.fract() == 0.0) {
                return Err(bad("approach category out of range"));
            }
            let disp = v[o + 5];
            let te = if v[o + 6].is_nan() { el } else { v[o + 6] };
            let fl = v[o + 7];
            let cw = v[o + 8];
            if !(disp.is_finite() && (0.0..=5000.0).contains(&disp)) || !te.is_finite() || !(-500.0..=9000.0).contains(&te) || !(cw.is_finite() && (0.0..=3000.0).contains(&cw)) {
                return Err(bad("threshold or clearway out of range"));
            }
            if !(fl >= 0.0 && fl <= 3.0 && fl.fract() == 0.0) {
                return Err(bad("end flags out of range"));
            }
            let f = fl as u32;
            *e = EndDef { lat, lon, elev: el, p77: p77 as u8, icao: icao as u8, disp, thr_elev: te, approach: f & 1 != 0, takeoff: f & 2 != 0, clearway: cw };
        }
        runways.push(RunwayDef { paved: v[b] != 0.0, code: code as u8, tocs_width: tw, adg: adg as u8, width, mtom, ends });
    }
    Ok(Airport { regime, elev, ihs_datum, code_f: v[5] == 1.0, runways })
}

/// The version 3 definition list of an airport (tests and fuzz seeds).
pub fn encode(a: &Airport) -> Vec<f64> {
    let regime = match a.regime {
        Regime::Part77 => 0.0,
        Regime::Icao => 1.0,
        Regime::IcaoA18 => 2.0,
    };
    let mut v = vec![3.0, regime, a.elev, a.ihs_datum, a.runways.len() as f64, a.code_f as u8 as f64];
    for r in &a.runways {
        v.extend([if r.paved { 1.0 } else { 0.0 }, r.code as f64, r.tocs_width, r.adg as f64, r.width, r.mtom]);
        for e in &r.ends {
            v.extend([e.lat, e.lon, e.elev, e.p77 as f64, e.icao as f64, e.disp, e.thr_elev, (e.approach as u32 + 2 * e.takeoff as u32) as f64, e.clearway]);
        }
    }
    v
}

/// One surface of the model (the reporting unit).
#[derive(Clone, Debug)]
pub struct Surface {
    pub kind: Kind,
    pub runway: i32,
    pub end: i32,
    /// Slopes (rise / run) of its sections, for the report; 0 for horizontal.
    pub slopes: Vec<f64>,
}

/// A surface rising off the sides of a fan, measured at right angles to the centre line, up to a
/// height: Amendment 18's transitional surfaces (§4.2.2) and transitional components (§4.3.4.8).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Side {
    pub slope: f64,
    pub id: usize,
    pub top: f64,
}

/// A sloped trapezoid along a runway's axis, away from an inner edge: approaches, take-off climbs,
/// departure surfaces and the components of the Amendment 18 surface for precision approaches.
#[derive(Clone, Debug)]
pub(crate) struct Fan {
    pub id: usize,
    /// Station of the inner edge along the runway axis, and +1/−1 for the direction it runs.
    pub s0: f64,
    pub dir: f64,
    pub hw0: f64,
    /// The final half-width (∞: none).
    pub hw_max: f64,
    /// Sections (length m, slope, divergence each side); total length.
    pub sections: Vec<(f64, f64, f64)>,
    pub len: f64,
    pub base: f64,
    /// Part 77 precision approach: its transitional surfaces reach 5 000 ft beyond the conical.
    pub pir: bool,
    /// Its own lateral surface, if any (the Part 77 and current Annex 14 approaches use the
    /// runway's transitional instead).
    pub side: Option<Side>,
}

impl Fan {
    #[inline]
    fn rise(&self, x: f64) -> f64 {
        let mut z = 0.0;
        let mut x0 = 0.0;
        for &(l, s, _) in &self.sections {
            if x <= x0 + l {
                return z + (x - x0) * s;
            }
            z += l * s;
            x0 += l;
        }
        z
    }
    #[inline]
    fn half(&self, x: f64) -> f64 {
        let mut hw = self.hw0;
        let mut x0 = 0.0;
        for &(l, _, d) in &self.sections {
            if x <= x0 + l {
                return (hw + (x - x0) * d).min(self.hw_max);
            }
            hw += l * d;
            x0 += l;
        }
        hw.min(self.hw_max)
    }
    /// Where the half-width reaches its final value, if inside the fan.
    fn knee(&self) -> Option<f64> {
        let (mut hw, mut x0) = (self.hw0, 0.0);
        for &(l, _, d) in &self.sections {
            if d > 0.0 && hw + l * d > self.hw_max {
                let x = x0 + (self.hw_max - hw) / d;
                return (x > 0.0 && x < self.len).then_some(x);
            }
            hw += l * d;
            x0 += l;
        }
        None
    }
}

// Table 4-1 (current edition) columns (9) to (11): the same for every precision approach.
const OFZ_DIST: f64 = 60.0;
const OFZ_LEN: f64 = 900.0;
/// Balked landing divergence each side: current Table 4-1 and Amendment 18 Table 4-9 alike.
pub(crate) const OFZ_DIV: f64 = 0.10;

/// The inner surfaces of an approach to one end: the current edition's obstacle-free zone of a
/// precision approach, or Amendment 18's inner approach, inner transitional and balked landing
/// surfaces. Stations `u` run from the threshold along the landing direction: the inner approach
/// lies before it, the balked landing beyond.
#[derive(Clone, Debug)]
pub(crate) struct Ofz {
    pub dir: f64,
    pub s_thr: f64,
    pub hw: f64,
    pub thr_elev: f64,
    /// Inner approach: its inner edge's distance before the threshold, length and slope.
    pub dist: f64,
    pub ia_len: f64,
    pub ia_slope: f64,
    /// Inner transitional: slope, and the height of its vertical section (0: none).
    pub it_slope: f64,
    pub vert: f64,
    /// The station where the strip part ends (the balked landing's inner edge, or where the inner
    /// transitional ends), and the balked landing's elevation there, slope, and length to its top
    /// (0: none).
    pub ub: f64,
    pub b_elev: f64,
    pub b_slope: f64,
    pub b_len: f64,
    /// The upper edges: the inner horizontal plane, or 60 m above the highest threshold.
    pub top: f64,
    pub ia_id: usize,
    pub it_id: usize,
    pub bl_id: usize,
    pub st_id: usize,
}

impl Ofz {
    /// Half-width, height and surface of the zone's floor at station `u`, or None beyond its ends.
    #[inline]
    fn floor(&self, u: f64, centre: f64) -> Option<(f64, f64, usize)> {
        if u < -(self.dist + self.ia_len) || u > self.ub + self.b_len {
            None
        } else if u <= -self.dist {
            Some((self.hw, self.thr_elev + (-self.dist - u) * self.ia_slope, self.ia_id))
        } else if u <= self.ub {
            Some((self.hw, centre, self.st_id))
        } else {
            let x = u - self.ub;
            Some((self.hw + x * OFZ_DIV, self.b_elev + x * self.b_slope, self.bl_id))
        }
    }
}

/// A level rectangle about a runway's axis: the upper section of Amendment 18's surface for
/// straight-in instrument approaches.
#[derive(Clone, Debug)]
pub(crate) struct Rect {
    pub id: usize,
    pub s0: f64,
    pub s1: f64,
    pub hw: f64,
    pub z: f64,
}

/// A level surface over a hull of discs: Amendment 18's horizontal surfaces, one per height.
#[derive(Clone, Debug)]
pub(crate) struct Horiz {
    pub id: usize,
    pub hull: DiscHull,
    pub z: f64,
}

#[derive(Clone, Debug)]
pub(crate) struct Rwy {
    pub ax: f64,
    pub ay: f64,
    pub ux: f64,
    pub uy: f64,
    pub len: f64,
    pub ea: f64,
    pub eb: f64,
    /// Primary surface (Part 77) or strip (Annex 14): half-width and the extension beyond each end.
    pub hw: f64,
    pub ext: f64,
    pub base_id: usize,
    pub trans_id: usize,
    pub trans_slope: f64,
    /// The transitional's upper edge (None: Part 77, where it ends with the horizontal and conical).
    pub trans_top: Option<f64>,
    /// Approaches whose sides carry the runway's transitional surface (Part 77, current Annex 14).
    pub approaches: Vec<Fan>,
    /// Every other fan, with its own lateral surface if any.
    pub fans: Vec<Fan>,
    pub zones: Vec<Ofz>,
    pub rects: Vec<Rect>,
}

impl Rwy {
    #[inline]
    pub(crate) fn elev_at(&self, s: f64) -> f64 {
        let f = (s / self.len).clamp(0.0, 1.0);
        self.ea + (self.eb - self.ea) * f
    }
}

/// A built model: surfaces in a tangent plane at the aerodrome.
#[derive(Clone, Debug)]
pub struct Model {
    pub regime: Regime,
    pub frame: Frame,
    pub surfaces: Vec<Surface>,
    rwys: Vec<Rwy>,
    pub hull: DiscHull,
    /// Horizontal (inner horizontal) surface height, conical rise limit (horizontal distance m) and
    /// slope; NaN, 0, 0 for Amendment 18, which has neither.
    pub h_elev: f64,
    pub con_reach: f64,
    pub con_slope: f64,
    h_id: usize,
    c_id: usize,
    /// The horizontal and conical surfaces over `hull` exist (Part 77 and the current Annex 14).
    hc: bool,
    /// Amendment 18's horizontal surfaces, and the lower section of its straight-in surface.
    horiz: Vec<Horiz>,
    /// Per surface: its limit is also reported as the zone's (the current edition's obstacle-free
    /// zone, or Amendment 18's obstacle free surfaces).
    zone_of: Vec<bool>,
    /// Part 77 §77.19(e): 5 000 ft beyond the conical for precision approaches.
    pir_band: f64,
    /// Plane bounding box of every surface (x0, y0, x1, y1).
    pub bbox: (f64, f64, f64, f64),
    /// The Amendment 18 assumptions this model makes (a18::ASSUMPTIONS bits; 0 otherwise).
    pub assumed: u32,
}

/// Where a position's limits come from: the lowest surface of all, and the lowest of the zone. Each
/// is (height m, surface index), or (NaN, usize::MAX) where none lies.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub lowest: (f64, usize),
    pub zone: (f64, usize),
}

const NONE: (f64, usize) = (f64::NAN, usize::MAX);

// ---- dimension tables ----
// Part 77 §77.19(c) primary surface width (ft) for the most precise approach of the runway.
fn p77_primary_width(cats: [u8; 2], utility: bool) -> f64 {
    let best = cats[0].max(cats[1]);
    if utility {
        if cats.iter().all(|&c| c == 0) {
            250.0
        } else {
            500.0
        }
    } else if best >= 4 {
        1000.0
    } else {
        500.0
    }
}

/// §77.19(d)(1) approach outer width (ft) and §77.19(d)(2) sections (ft, slope).
fn p77_approach(cat: u8) -> (f64, Vec<(f64, f64)>) {
    match cat {
        0 => (1250.0, vec![(5000.0, 1.0 / 20.0)]),
        1 => (2000.0, vec![(5000.0, 1.0 / 20.0)]),
        2 => (1500.0, vec![(5000.0, 1.0 / 20.0)]),
        3 => (3500.0, vec![(10000.0, 1.0 / 34.0)]),
        4 => (4000.0, vec![(10000.0, 1.0 / 34.0)]),
        _ => (16000.0, vec![(10000.0, 1.0 / 50.0), (40000.0, 1.0 / 40.0)]),
    }
}

/// Annex 14 Table 4-1 approach: (inner edge m, distance from threshold m, divergence, sections).
fn icao_approach(typ: u8, code: u8) -> (f64, f64, f64, Vec<(f64, f64)>) {
    let c = (code.clamp(1, 4) - 1) as usize;
    match typ {
        // Amendment 18: the code 3 inner edge is 110 m (it was 150 m).
        0 => ([60.0, 80.0, 110.0, 150.0][c], [30.0, 60.0, 60.0, 60.0][c], 0.10, vec![([1600.0, 2500.0, 3000.0, 3000.0][c], [0.05, 0.04, 0.0333, 0.025][c])]),
        1 => {
            let mut s = vec![([2500.0, 2500.0, 3000.0, 3000.0][c], [0.0333, 0.0333, 0.02, 0.02][c])];
            if c >= 2 {
                s.push((3600.0, 0.025));
                s.push((8400.0, 0.0));
            }
            ([140.0, 140.0, 280.0, 280.0][c], 60.0, 0.15, s)
        }
        2 => {
            let s = if c < 2 { vec![(3000.0, 0.025), (12000.0, 0.03)] } else { vec![(3000.0, 0.02), (3600.0, 0.025), (8400.0, 0.0)] };
            ([140.0, 140.0, 280.0, 280.0][c], 60.0, 0.15, s)
        }
        _ => (280.0, 60.0, 0.15, vec![(3000.0, 0.02), (3600.0, 0.025), (8400.0, 0.0)]),
    }
}

/// Annex 14 Table 4-1 transitional slope, inner horizontal radius and conical height, for the
/// runway's most demanding approach type.
fn icao_runway(typ: u8, code: u8) -> (f64, f64, f64) {
    let c = (code.clamp(1, 4) - 1) as usize;
    match typ {
        0 => ([0.20, 0.20, 0.143, 0.143][c], [2000.0, 2500.0, 4000.0, 4000.0][c], [35.0, 55.0, 75.0, 100.0][c]),
        1 => ([0.20, 0.20, 0.143, 0.143][c], [3500.0, 3500.0, 4000.0, 4000.0][c], [60.0, 60.0, 75.0, 100.0][c]),
        2 => (0.143, [3500.0, 3500.0, 4000.0, 4000.0][c], [60.0, 60.0, 100.0, 100.0][c]),
        _ => (0.143, 4000.0, 100.0),
    }
}

/// Annex 14 §3.4.3–3.4.5 strip half-width and §3.4.2 extension beyond the runway end (m).
pub(crate) fn icao_strip(typ: u8, code: u8) -> (f64, f64) {
    let c = (code.clamp(1, 4) - 1) as usize;
    if typ == 0 {
        // Amendment 18, §3.4.5: code 3 is 55 m (it was 75 m), half of the 110 m inner edge.
        ([30.0, 40.0, 55.0, 75.0][c], if c == 0 { 30.0 } else { 60.0 })
    } else {
        ([70.0, 70.0, 140.0, 140.0][c], 60.0)
    }
}

/// Annex 14 Table 4-2 take-off climb: (inner edge m, distance from runway end m, divergence,
/// final width m, length m, slope).
fn icao_takeoff(code: u8) -> (f64, f64, f64, f64, f64, f64) {
    match code {
        1 => (60.0, 30.0, 0.10, 380.0, 1600.0, 0.05),
        2 => (80.0, 60.0, 0.10, 580.0, 2500.0, 0.04),
        _ => (180.0, 60.0, 0.125, 1200.0, 15000.0, 0.02),
    }
}

/// Table 4-1 columns (9) to (11): (width m, inner approach slope, inner transitional slope, balked
/// landing slope, the balked landing inner edge at the strip end (column 9) rather than 1 800 m).
/// Note e widens columns (10) and (11) to 140 m for code letter F, except at aerodromes whose code
/// letter F aeroplanes have digital go-around steering avionics.
fn icao_ofz(typ: u8, code: u8, code_f: bool) -> (f64, f64, f64, f64, bool) {
    if typ == 2 && code <= 2 {
        (90.0, 0.025, 0.40, 0.04, true)
    } else {
        (if code_f { 140.0 } else { 120.0 }, 0.02, 0.333, 0.0333, false)
    }
}

/// Surfaces under construction: each new one gets the next index.
pub(crate) struct Surfaces(pub Vec<Surface>);

impl Surfaces {
    pub(crate) fn add(&mut self, kind: Kind, runway: i32, end: i32, slopes: Vec<f64>) -> usize {
        self.0.push(Surface { kind, runway, end, slopes });
        self.0.len() - 1
    }
}

impl Model {
    pub fn build(a: &Airport) -> Result<Model, String> {
        let (mut sl, mut so, mut n) = (0.0, 0.0, 0.0);
        for r in &a.runways {
            for e in &r.ends {
                sl += e.lat;
                so += e.lon;
                n += 1.0;
            }
        }
        let frame = Frame::new(sl / n, so / n);
        let mut sf = Surfaces(Vec::new());
        let mut rwys = Vec::new();
        let mut discs = Vec::new();
        let mut a18 = a18::Acc::default();
        let (mut h_rad_icao, mut con_h_icao) = (0.0f64, 0.0f64);
        let ihs_plane = a.ihs_datum + 45.0;
        for (ri, r) in a.runways.iter().enumerate() {
            let (ax, ay) = frame.fwd(r.ends[0].lat, r.ends[0].lon);
            let (bx, by) = frame.fwd(r.ends[1].lat, r.ends[1].lon);
            let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
            if !(len >= 30.0 && len <= 8000.0) {
                return Err(bad("runway length must be 30 m to 8 km"));
            }
            let (ux, uy) = ((bx - ax) / len, (by - ay) / len);
            let ri = ri as i32;
            let mut rw = Rwy { ax, ay, ux, uy, len, ea: r.ends[0].elev, eb: r.ends[1].elev, hw: 0.0, ext: 0.0, base_id: 0, trans_id: 0, trans_slope: 0.0, trans_top: None, approaches: vec![], fans: vec![], zones: vec![], rects: vec![] };
            match a.regime {
                Regime::Part77 => {
                    let cats = [r.ends[0].p77, r.ends[1].p77];
                    let utility = cats.iter().all(|&c| c <= 1);
                    rw.hw = p77_primary_width(cats, utility) * FT / 2.0;
                    rw.ext = if r.paved { 200.0 * FT } else { 0.0 };
                    rw.base_id = sf.add(Kind::Primary, ri, -1, vec![0.0]);
                    rw.trans_slope = 1.0 / 7.0;
                    rw.trans_id = sf.add(Kind::Transitional, ri, -1, vec![1.0 / 7.0]);
                    for k in 0..2 {
                        let (wo, secs) = p77_approach(cats[k]);
                        let total: f64 = secs.iter().map(|s| s.0 * FT).sum();
                        let div = (wo * FT / 2.0 - rw.hw) / total;
                        let secs: Vec<(f64, f64, f64)> = secs.into_iter().map(|(l, s)| (l * FT, s, div)).collect();
                        let id = sf.add(Kind::Approach, ri, k as i32, secs.iter().map(|s| s.1).collect());
                        let (s0, dir) = if k == 0 { (-rw.ext, -1.0) } else { (len + rw.ext, 1.0) };
                        rw.approaches.push(Fan { id, s0, dir, hw0: rw.hw, hw_max: f64::INFINITY, len: total, sections: secs, base: r.ends[k].elev, pir: cats[k] == 5, side: None });
                    }
                    // §77.19(a): 5 000 ft for utility or visual runways, 10 000 ft for all others,
                    // the larger for both ends of a runway.
                    let rad = if cats.iter().all(|&c| c <= 2) { 5000.0 } else { 10000.0 } * FT;
                    discs.push(Disc { x: ax - rw.ext * ux, y: ay - rw.ext * uy, r: rad });
                    discs.push(Disc { x: bx + rw.ext * ux, y: by + rw.ext * uy, r: rad });
                }
                Regime::Icao => {
                    let typ = r.ends[0].icao.max(r.ends[1].icao);
                    if typ == 3 && r.code < 3 {
                        return Err(bad("Table 4-1 has no precision category II or III column for code numbers 1 and 2"));
                    }
                    let (ts, rad, ch) = icao_runway(typ, r.code);
                    let (hs, se) = icao_strip(typ, r.code);
                    rw.hw = hs;
                    rw.ext = se;
                    rw.base_id = sf.add(Kind::Strip, ri, -1, vec![0.0]);
                    rw.trans_slope = ts;
                    // §4.1.13: the transitional's upper edge is in the plane of the inner horizontal.
                    rw.trans_top = Some(ihs_plane);
                    rw.trans_id = sf.add(Kind::Transitional, ri, -1, vec![ts]);
                    h_rad_icao = h_rad_icao.max(rad);
                    con_h_icao = con_h_icao.max(ch);
                    for k in 0..2 {
                        let e = &r.ends[k];
                        if e.approach {
                            let (l0, d0, div, secs) = icao_approach(e.icao, r.code);
                            let total: f64 = secs.iter().map(|s| s.0).sum();
                            let id = sf.add(Kind::Approach, ri, k as i32, secs.iter().map(|s| s.1).collect());
                            let (s0, dir) = if k == 0 { (e.disp - d0, -1.0) } else { (len - e.disp + d0, 1.0) };
                            let sections = secs.into_iter().map(|(l, s)| (l, s, div)).collect();
                            rw.approaches.push(Fan { id, s0, dir, hw0: l0 / 2.0, hw_max: f64::INFINITY, len: total, sections, base: e.thr_elev, pir: false, side: None });
                        }
                        if e.takeoff {
                            let (l0, d0, div, wf, l, slope) = icao_takeoff(r.code);
                            let wf = if r.tocs_width.is_nan() { wf } else { r.tocs_width };
                            let start = d0.max(e.clearway);
                            let id = sf.add(Kind::TakeOff, ri, k as i32, vec![slope]);
                            let (s0, dir) = if k == 0 { (-start, -1.0) } else { (len + start, 1.0) };
                            rw.fans.push(Fan { id, s0, dir, hw0: l0 / 2.0, hw_max: wf / 2.0, len: l, sections: vec![(l, slope, div)], base: e.elev, pir: false, side: None });
                        }
                    }
                    // The zone of each precision approach, after the surfaces above so that their
                    // indices keep their order. Its upper edges lie in the inner horizontal plane.
                    for k in 0..2 {
                        let e = &r.ends[k];
                        if !e.approach || e.icao < 2 {
                            continue;
                        }
                        let (w, ia_slope, it_slope, b_slope, to_strip) = icao_ofz(e.icao, r.code, a.code_f);
                        let run = len - e.disp;
                        if run <= 0.0 {
                            return Err(bad("a displaced threshold lies beyond the far end of its runway"));
                        }
                        // Note c: to the end of the strip; note d: 1 800 m or the runway end if nearer.
                        let ub = if to_strip { run + se } else { run.min(1800.0) };
                        let (dir, s_thr) = if k == 0 { (1.0, e.disp) } else { (-1.0, len - e.disp) };
                        let b_elev = rw.elev_at(s_thr + dir * ub);
                        let ia_id = sf.add(Kind::InnerApproach, ri, k as i32, vec![ia_slope]);
                        let it_id = sf.add(Kind::InnerTransitional, ri, k as i32, vec![it_slope]);
                        let bl_id = sf.add(Kind::BalkedLanding, ri, k as i32, vec![b_slope]);
                        let st_id = sf.add(Kind::OfzStrip, ri, k as i32, vec![0.0]);
                        let b_len = ((ihs_plane - b_elev) / b_slope).max(0.0);
                        rw.zones.push(Ofz { dir, s_thr, hw: w / 2.0, thr_elev: e.thr_elev, dist: OFZ_DIST, ia_len: OFZ_LEN, ia_slope, it_slope, vert: 0.0, ub, b_elev, b_slope, b_len, top: ihs_plane, ia_id, it_id, bl_id, st_id });
                    }
                    discs.push(Disc { x: ax - se * ux, y: ay - se * uy, r: rad });
                    discs.push(Disc { x: bx + se * ux, y: by + se * uy, r: rad });
                }
                Regime::IcaoA18 => a18::runway(a, r, ri, &mut rw, &mut sf, &mut a18)?,
            }
            rwys.push(rw);
        }
        // The Annex 14 inner horizontal surface takes the largest radius of the aerodrome's runways.
        if a.regime == Regime::Icao {
            for d in discs.iter_mut() {
                d.r = h_rad_icao;
            }
        }
        let a18_model = a.regime == Regime::IcaoA18;
        let (h_elev, con_reach, con_slope, h_kind, c_slope) = match a.regime {
            // §77.19(a) 150 ft above the established airport elevation; (b) 20:1 for 4 000 ft.
            Regime::Part77 => (a.elev + 150.0 * FT, 4000.0 * FT, 1.0 / 20.0, Kind::Horizontal, 1.0 / 20.0),
            // Table 4-1: 45 m above the datum; conical 5 % to the table height above it.
            Regime::Icao => (ihs_plane, con_h_icao / 0.05, 0.05, Kind::InnerHorizontal, 0.05),
            Regime::IcaoA18 => (f64::NAN, 0.0, 0.0, Kind::Horizontal, 0.0),
        };
        let (mut h_id, mut c_id) = (usize::MAX, usize::MAX);
        let mut horiz = Vec::new();
        if a18_model {
            horiz = a18::horizontal(a, &mut sf, a18.discs);
        } else {
            h_id = sf.add(h_kind, -1, -1, vec![0.0]);
            c_id = sf.add(Kind::Conical, -1, -1, vec![c_slope]);
        }
        let surfaces = sf.0;
        if surfaces.len() > MAX_SURFACES {
            return Err(bad("more than 254 surfaces"));
        }
        let zone_of = surfaces
            .iter()
            .map(|s| match a.regime {
                Regime::Part77 => false,
                Regime::Icao => matches!(s.kind, Kind::InnerApproach | Kind::InnerTransitional | Kind::BalkedLanding | Kind::OfzStrip),
                Regime::IcaoA18 => a18::is_ofs(s.kind),
            })
            .collect();
        let hull = DiscHull::new(discs);
        let pir_band = 5000.0 * FT;
        let mut m = Model { regime: a.regime, frame, surfaces, rwys, hull, h_elev, con_reach, con_slope, h_id, c_id, hc: !a18_model, horiz, zone_of, pir_band, bbox: (0.0, 0.0, 0.0, 0.0), assumed: a18.assumed };
        m.bbox = m.extent();
        Ok(m)
    }

    fn extent(&self) -> (f64, f64, f64, f64) {
        let mut b = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
        let mut grow = |x: f64, y: f64| b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        if self.hc {
            let hb = self.hull.bbox;
            grow(hb.0 - self.con_reach, hb.1 - self.con_reach);
            grow(hb.2 + self.con_reach, hb.3 + self.con_reach);
        }
        for h in &self.horiz {
            grow(h.hull.bbox.0, h.hull.bbox.1);
            grow(h.hull.bbox.2, h.hull.bbox.3);
        }
        for r in &self.rwys {
            let mut put = |s: f64, reach: f64| {
                let (cx, cy) = (r.ax + s * r.ux, r.ay + s * r.uy);
                for sg in [-1.0, 1.0] {
                    grow(cx - sg * reach * r.uy, cy + sg * reach * r.ux);
                }
            };
            for f in r.approaches.iter().chain(r.fans.iter()) {
                let band = if f.pir { self.pir_band } else { 0.0 };
                // A lateral surface reaches furthest from the fan's lowest point.
                let side = f.side.map_or(0.0, |sd| (sd.top - f.base).max(0.0) / sd.slope);
                for x in [0.0, f.len] {
                    put(f.s0 + f.dir * x, f.half(x) + band + side);
                }
            }
            for o in &r.zones {
                let low = o.thr_elev.min(o.b_elev).min(r.ea).min(r.eb);
                let reach = o.hw + o.b_len * OFZ_DIV + (o.top - low).max(0.0) / o.it_slope;
                for u in [-(o.dist + o.ia_len), o.ub + o.b_len] {
                    put(o.s_thr + o.dir * u, reach);
                }
            }
            for q in &r.rects {
                put(q.s0, q.hw);
                put(q.s1, q.hw);
            }
            if let Some(top) = r.trans_top {
                let low = r.ea.min(r.eb);
                let reach = r.hw + (top - low).max(0.0) / r.trans_slope;
                put(-r.ext, reach);
                put(r.len + r.ext, reach);
            }
        }
        b
    }

    /// True when the model reports a zone limit as well as the lowest.
    pub fn has_zone(&self) -> bool {
        self.regime == Regime::IcaoA18 || self.rwys.iter().any(|r| !r.zones.is_empty())
    }

    /// The lowest limiting surface at plane position (x, y): (height m, surface index), or
    /// (NaN, usize::MAX) where no surface lies.
    pub fn limit(&self, x: f64, y: f64) -> (f64, usize) {
        self.limits(x, y).lowest
    }

    /// The lowest surface of all, and the lowest of the zone, at plane position (x, y).
    pub fn limits(&self, x: f64, y: f64) -> Limits {
        let mut best = (f64::INFINITY, usize::MAX);
        let mut zone = (f64::INFINITY, usize::MAX);
        if x < self.bbox.0 || x > self.bbox.2 || y < self.bbox.1 || y > self.bbox.3 {
            return Limits { lowest: NONE, zone: NONE };
        }
        let zone_of = &self.zone_of;
        let mut take = |z: f64, id: usize| {
            if z < best.0 {
                best = (z, id);
            }
            if zone_of[id] && z < zone.0 {
                zone = (z, id);
            }
        };
        let mut in_footprint = false;
        if self.hc {
            let d_out = self.hull.dist_out(x, y);
            in_footprint = d_out <= self.con_reach;
            if d_out <= 0.0 {
                take(self.h_elev, self.h_id);
            } else if in_footprint {
                take(self.h_elev + d_out * self.con_slope, self.c_id);
            }
        }
        for h in &self.horiz {
            if h.hull.contains(x, y) {
                take(h.z, h.id);
            }
        }
        for r in &self.rwys {
            let (dx, dy) = (x - r.ax, y - r.ay);
            let s = dx * r.ux + dy * r.uy;
            let t = (-dx * r.uy + dy * r.ux).abs();
            // Primary surface / strip and the transitional beside it. §77.19(e): beside the primary
            // surface the transitional ends where it meets the horizontal surface; Annex 14: at its
            // upper edge.
            if s >= -r.ext && s <= r.len + r.ext {
                let base = r.elev_at(s);
                if t <= r.hw {
                    take(base, r.base_id);
                } else {
                    let z = base + (t - r.hw) * r.trans_slope;
                    if r.trans_top.map_or(in_footprint, |top| z <= top) {
                        take(z, r.trans_id);
                    }
                }
            }
            for q in &r.rects {
                if t <= q.hw && s >= q.s0 && s <= q.s1 {
                    take(q.z, q.id);
                }
            }
            for f in &r.approaches {
                let xo = f.dir * (s - f.s0);
                if xo <= 0.0 || xo > f.len {
                    continue;
                }
                let hw = f.half(xo);
                let za = f.base + f.rise(xo);
                if t <= hw {
                    take(za, f.id);
                } else {
                    let z = za + (t - hw) * r.trans_slope;
                    let ok = match r.trans_top {
                        Some(top) => z <= top,
                        None => in_footprint || (f.pir && t - hw <= self.pir_band),
                    };
                    if ok {
                        take(z, r.trans_id);
                    }
                }
            }
            for f in &r.fans {
                let xo = f.dir * (s - f.s0);
                if xo < 0.0 || xo > f.len {
                    continue;
                }
                let hw = f.half(xo);
                let z = f.base + f.rise(xo);
                if t <= hw {
                    take(z, f.id);
                } else if let Some(sd) = f.side {
                    let zs = z + (t - hw) * sd.slope;
                    if zs <= sd.top {
                        take(zs, sd.id);
                    }
                }
            }
            // The zone, last, so that a tie with a surface above keeps that surface.
            for o in &r.zones {
                let u = o.dir * (s - o.s_thr);
                let Some((w, z0, id)) = o.floor(u, r.elev_at(s)) else { continue };
                if t <= w {
                    take(z0, id);
                } else {
                    let z = z0 + o.vert + (t - w) * o.it_slope;
                    if z <= o.top {
                        take(z, o.it_id);
                    }
                }
            }
        }
        Limits { lowest: if best.1 == usize::MAX { NONE } else { best }, zone: if zone.1 == usize::MAX { NONE } else { zone } }
    }

    /// Plane point at station s (m from end A of runway 0 along it) and offset t (m, left +).
    #[cfg(test)]
    pub(crate) fn station(&self, s: f64, t: f64) -> (f64, f64) {
        let r = &self.rwys[0];
        (r.ax + s * r.ux - t * r.uy, r.ay + s * r.uy + t * r.ux)
    }

    /// Runway 0's length in the plane.
    #[cfg(test)]
    pub(crate) fn length(&self) -> f64 {
        self.rwys[0].len
    }

    /// The limit at a geodetic position.
    pub fn limit_at(&self, lat: f64, lon: f64) -> (f64, usize) {
        let (x, y) = self.frame.fwd(lat, lon);
        self.limit(x, y)
    }

    /// The limits at a geodetic position.
    pub fn limits_at(&self, lat: f64, lon: f64) -> Limits {
        let (x, y) = self.frame.fwd(lat, lon);
        self.limits(x, y)
    }

    /// Geodetic bounding box of every surface [south, west, north, east].
    pub fn geo_bbox(&self) -> [f64; 4] {
        let b = self.bbox;
        let mut o = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for (x, y) in [(b.0, b.1), (b.2, b.1), (b.2, b.3), (b.0, b.3), ((b.0 + b.2) / 2.0, b.1), ((b.0 + b.2) / 2.0, b.3), (b.0, (b.1 + b.3) / 2.0), (b.2, (b.1 + b.3) / 2.0)] {
            let (la, lo) = self.frame.inv(x, y);
            o = [o[0].min(la), o[1].min(lo), o[2].max(la), o[3].max(lo)];
        }
        o
    }

    /// Facets for display and export: (surface index, ring of (lat, lon, height)).
    pub fn facets(&self) -> Vec<(usize, Vec<(f64, f64, f64)>)> {
        let mut out: Vec<(usize, Vec<(f64, f64, f64)>)> = Vec::new();
        let geo = |x: f64, y: f64, z: f64| {
            let (la, lo) = self.frame.inv(x, y);
            (la, lo, z)
        };
        for r in &self.rwys {
            let at = |s: f64, t: f64| (r.ax + s * r.ux - t * r.uy, r.ay + s * r.uy + t * r.ux);
            // Primary / strip: the runway part and the two flat extensions.
            for (s0, s1) in [(-r.ext, 0.0), (0.0, r.len), (r.len, r.len + r.ext)] {
                if s1 - s0 < 1e-6 {
                    continue;
                }
                let ring: Vec<_> = [(s0, -r.hw), (s1, -r.hw), (s1, r.hw), (s0, r.hw)]
                    .iter()
                    .map(|&(s, t)| {
                        let (x, y) = at(s, t);
                        geo(x, y, r.elev_at(s))
                    })
                    .collect();
                out.push((r.base_id, ring));
            }
            for q in &r.rects {
                let ring = [(q.s0, -q.hw), (q.s1, -q.hw), (q.s1, q.hw), (q.s0, q.hw)].map(|(s, t)| {
                    let (x, y) = at(s, t);
                    geo(x, y, q.z)
                });
                out.push((q.id, ring.to_vec()));
            }
            for f in r.approaches.iter().chain(r.fans.iter()) {
                let mut xs = vec![0.0];
                let mut acc = 0.0;
                for &(l, _, _) in &f.sections {
                    acc += l;
                    xs.push(acc);
                }
                xs.extend(f.knee());
                if let Some(sd) = f.side {
                    // Where the fan itself passes its lateral surface's top.
                    let (mut x0, mut z0) = (0.0, f.base);
                    for &(l, s, _) in &f.sections {
                        if s > 0.0 && z0 < sd.top && z0 + l * s > sd.top {
                            xs.push(x0 + (sd.top - z0) / s);
                        }
                        x0 += l;
                        z0 += l * s;
                    }
                }
                xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
                for w in xs.windows(2) {
                    let (x0, x1) = (w[0], w[1]);
                    if x1 - x0 < 1e-6 {
                        continue;
                    }
                    let ring: Vec<_> = [(x0, -1.0), (x1, -1.0), (x1, 1.0), (x0, 1.0)]
                        .iter()
                        .map(|&(xo, sg)| {
                            let (x, y) = at(f.s0 + f.dir * xo, sg * f.half(xo));
                            geo(x, y, f.base + f.rise(xo))
                        })
                        .collect();
                    out.push((f.id, ring));
                    // Its lateral surface: exact quads between the breaks, up to the top.
                    if let Some(sd) = f.side {
                        let edge = |xo: f64| {
                            let z = f.base + f.rise(xo);
                            (f.half(xo), z, f.half(xo) + (sd.top - z) / sd.slope)
                        };
                        let (a, b) = (edge(x0), edge(x1));
                        if a.1 < sd.top - 1e-9 && b.1 <= sd.top + 1e-9 {
                            for sg in [-1.0, 1.0] {
                                let band = [(x0, a.0, a.1), (x1, b.0, b.1), (x1, b.2, sd.top), (x0, a.2, sd.top)];
                                out.push((sd.id, band.iter().map(|&(xo, t, z)| {
                                    let (x, y) = at(f.s0 + f.dir * xo, sg * t);
                                    geo(x, y, z)
                                }).collect()));
                            }
                        }
                    }
                }
            }
            // Transitional surfaces: along each side, stations every 1/40 of the length, each reaching
            // out to where another surface becomes lower or the transitional ends.
            let lateral = |s: f64, t0: f64, z0: f64, f: Option<&Fan>| -> Option<f64> {
                let lim = |t: f64| -> bool {
                    let (x, y) = at(s, t);
                    let z = z0 + (t - t0) * r.trans_slope;
                    if let Some(top) = r.trans_top {
                        return z <= top;
                    }
                    let d_out = self.hull.dist_out(x, y);
                    let inf = d_out <= self.con_reach;
                    let exist = inf || f.map(|f| f.pir && t - t0 <= self.pir_band).unwrap_or(false);
                    let other = if d_out <= 0.0 { self.h_elev } else if inf { self.h_elev + d_out * self.con_slope } else { f64::INFINITY };
                    exist && z <= other
                };
                if !lim(t0 + 0.01) {
                    return None;
                }
                let (mut lo, mut hi) = (t0, t0 + 20000.0);
                if lim(hi) {
                    return Some(hi);
                }
                for _ in 0..50 {
                    let mid = (lo + hi) / 2.0;
                    if lim(mid) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                Some(lo)
            };
            for sg in [-1.0f64, 1.0] {
                let mut strip: Vec<(f64, f64, f64, f64)> = Vec::new(); // (s, t inner, t outer, z inner)
                let n = 40;
                for k in 0..=n {
                    let s = -r.ext + (r.len + 2.0 * r.ext) * (k as f64) / (n as f64);
                    let z0 = r.elev_at(s);
                    if let Some(to) = lateral(s, r.hw, z0, None) {
                        strip.push((s, r.hw, to, z0));
                    }
                }
                self.push_band(&mut out, r.trans_id, &strip, r, sg, &geo);
                for f in &r.approaches {
                    let mut strip = Vec::new();
                    let n = 60;
                    for k in 0..=n {
                        let xo = f.len * (k as f64) / (n as f64);
                        let xo = xo.max(1e-3);
                        let s = f.s0 + f.dir * xo;
                        let hw = f.half(xo);
                        let za = f.base + f.rise(xo);
                        if let Some(to) = lateral(s, hw, za, Some(f)) {
                            strip.push((s, hw, to, za));
                        } else if !strip.is_empty() {
                            self.push_band(&mut out, r.trans_id, &strip, r, sg, &geo);
                            strip.clear();
                        }
                    }
                    self.push_band(&mut out, r.trans_id, &strip, r, sg, &geo);
                }
            }
            for o in &r.zones {
                self.push_zone(&mut out, r, o, &geo);
            }
        }
        for h in &self.horiz {
            out.push((h.id, h.hull.ring_with_normals(2.0).iter().map(|&(x, y, _, _)| geo(x, y, h.z)).collect()));
        }
        if self.hc {
            // Horizontal surface and the conical ring (2° steps).
            let ring = self.hull.ring_with_normals(2.0);
            out.push((self.h_id, ring.iter().map(|&(x, y, _, _)| geo(x, y, self.h_elev)).collect()));
            let top = self.h_elev + self.con_reach * self.con_slope;
            for k in 0..ring.len() {
                let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                let d = self.con_reach;
                out.push((self.c_id, vec![geo(a.0, a.1, self.h_elev), geo(b.0, b.1, self.h_elev), geo(b.0 + d * b.2, b.1 + d * b.3, top), geo(a.0 + d * a.2, a.1 + d * a.3, top)]));
            }
        }
        out
    }

    /// Facets of one zone. Heights are linear between its stations, so one quad each will do.
    fn push_zone<G: Fn(f64, f64, f64) -> (f64, f64, f64)>(&self, out: &mut Vec<(usize, Vec<(f64, f64, f64)>)>, r: &Rwy, o: &Ofz, geo: &G) {
        let at = |u: f64, t: f64| {
            let s = o.s_thr + o.dir * u;
            (r.ax + s * r.ux - t * r.uy, r.ay + s * r.uy + t * r.ux)
        };
        let far = -(o.dist + o.ia_len);
        let mut us = vec![far, -o.dist, o.ub];
        // The strip's height kinks at the runway ends.
        for s in [0.0, r.len] {
            let u = o.dir * (s - o.s_thr);
            if u > -o.dist && u < o.ub {
                us.push(u);
            }
        }
        if o.b_len > 0.0 {
            us.push(o.ub + o.b_len);
        }
        us.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let edge = |u: f64| {
            let s = o.s_thr + o.dir * u;
            // On a shared station the inner approach's and the strip's side of it are the same line
            // unless a stated threshold height differs from the runway profile; the facet keeps
            // the side it lies on.
            o.floor(u, r.elev_at(s))
        };
        for w in us.windows(2) {
            let (u0, u1) = (w[0], w[1]);
            if u1 - u0 < 1e-6 {
                continue;
            }
            let mid = (u0 + u1) / 2.0;
            let Some((_, _, id)) = edge(mid) else { continue };
            // Floor heights just inside the piece, taken back to its ends along the piece's own line.
            let inside = |u: f64| {
                let v = u.clamp(u0 + 1e-6, u1 - 1e-6);
                edge(v).unwrap()
            };
            let (a, b) = (inside(u0), inside(u1));
            let quad = [(u0, -a.0, a.1), (u1, -b.0, b.1), (u1, b.0, b.1), (u0, a.0, a.1)];
            out.push((id, quad.iter().map(|&(u, t, z)| {
                let (x, y) = at(u, t);
                geo(x, y, z)
            }).collect()));
            // The inner transitional beside this piece (above its vertical section, if it has one),
            // where its lower edge is under the top.
            let (za, zb) = (a.1 + o.vert, b.1 + o.vert);
            if za < o.top && zb < o.top {
                let reach = |p: (f64, f64, usize)| p.0 + (o.top - p.1 - o.vert) / o.it_slope;
                let (ra, rb) = (reach(a), reach(b));
                for sg in [-1.0, 1.0] {
                    let band = [(u0, a.0, za), (u1, b.0, zb), (u1, rb, o.top), (u0, ra, o.top)];
                    out.push((o.it_id, band.iter().map(|&(u, t, z)| {
                        let (x, y) = at(u, sg * t);
                        geo(x, y, z)
                    }).collect()));
                }
            }
        }
    }

    fn push_band<G: Fn(f64, f64, f64) -> (f64, f64, f64)>(&self, out: &mut Vec<(usize, Vec<(f64, f64, f64)>)>, id: usize, strip: &[(f64, f64, f64, f64)], r: &Rwy, sg: f64, geo: &G) {
        let at = |s: f64, t: f64| (r.ax + s * r.ux - t * r.uy, r.ay + s * r.uy + t * r.ux);
        for w in strip.windows(2) {
            let (a, b) = (w[0], w[1]);
            let zo = |p: (f64, f64, f64, f64)| p.3 + (p.2 - p.1) * r.trans_slope;
            let pts = [(a.0, a.1, a.3), (b.0, b.1, b.3), (b.0, b.2, zo(b)), (a.0, a.2, zo(a))];
            out.push((id, pts.iter().map(|&(s, t, z)| {
                let (x, y) = at(s, sg * t);
                geo(x, y, z)
            }).collect()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A straight east–west runway at the equator-free latitude 36° N, ends 3 000 m apart.
    fn runway(cat: [u8; 2], icao: [u8; 2], code: u8, elev: [f64; 2]) -> RunwayDef {
        // 3 000 m of longitude at 36° N.
        let dlon = 3000.0 / (111_412.84 * 36f64.to_radians().cos() - 93.5 * (3.0 * 36f64.to_radians()).cos());
        let e = |lon: f64, el: f64, c: u8, i: u8| EndDef { lat: 36.0, lon, elev: el, p77: c, icao: i, disp: 0.0, thr_elev: el, approach: true, takeoff: true, clearway: 0.0 };
        RunwayDef { paved: true, code, tocs_width: f64::NAN, adg: 0, width: f64::NAN, mtom: f64::NAN, ends: [e(-115.0, elev[0], cat[0], icao[0]), e(-115.0 + dlon, elev[1], cat[1], icao[1])] }
    }

    fn model(regime: Regime, r: RunwayDef, elev: f64) -> Model {
        let a = Airport { regime, elev, ihs_datum: elev, code_f: false, runways: vec![r] };
        let v = encode(&a);
        Model::build(&parse(&v).unwrap()).unwrap()
    }

    /// The zone's limit at station s, offset t, and its kind.
    fn zone(m: &Model, s: f64, t: f64) -> (f64, Option<Kind>) {
        let (x, y) = at(m, s, t);
        let (z, id) = m.limits(x, y).zone;
        (z, (id != usize::MAX).then(|| m.surfaces[id].kind))
    }

    /// Plane point at station s (m from end A along the runway) and offset t (m, left +).
    fn at(m: &Model, s: f64, t: f64) -> (f64, f64) {
        let r = &m.rwys[0];
        (r.ax + s * r.ux - t * r.uy, r.ay + s * r.uy + t * r.ux)
    }

    fn lim(m: &Model, s: f64, t: f64) -> (f64, Kind) {
        let (x, y) = at(m, s, t);
        let (z, id) = m.limit(x, y);
        (z, if id == usize::MAX { Kind::Strip } else { m.surfaces[id].kind })
    }

    #[test]
    fn part77_precision_runway_hand_cases() {
        // PIR both ends, end A 600 m, end B 610 m, airport elevation 610 m. Feet → metres exact.
        let m = model(Regime::Part77, runway([5, 5], [2, 2], 4, [600.0, 610.0]), 610.0);
        let len = m.rwys[0].len;
        assert!((len - 3000.0).abs() < 1.0, "{len}");
        // §77.19(c): primary 1 000 ft wide, 200 ft beyond each end, elevation of the nearest
        // centreline point: on the centreline at mid-runway, 605 m.
        let (z, k) = lim(&m, len / 2.0, 100.0);
        assert_eq!(k, Kind::Primary);
        assert!((z - 605.0).abs() < 1e-6);
        // §77.19(d)(2)(iii): 1 000 ft beyond the primary end of A, 50:1 → 20 ft above end A.
        let (z, k) = lim(&m, -(200.0 + 1000.0) * FT, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - (600.0 + 20.0 * FT)).abs() < 1e-6, "{z}");
        // 20 000 ft out: 10 000 ft at 50:1 (200 ft) then 10 000 ft at 40:1 (250 ft) → 450 ft.
        let (z, k) = lim(&m, -(200.0 + 20000.0) * FT, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - (600.0 + 450.0 * FT)).abs() < 1e-6, "{z}");
        // Beyond 50 000 ft: nothing.
        let (z, _) = lim(&m, -(200.0 + 50100.0) * FT, 0.0);
        assert!(z.is_nan());
        // §77.19(e): 7:1 from the side of the primary surface: 350 ft out from the edge (500 ft off
        // the centreline) is 50 ft above the centreline elevation at that station.
        let (z, k) = lim(&m, len / 2.0, (500.0 + 350.0) * FT);
        assert_eq!(k, Kind::Transitional);
        assert!((z - (605.0 + 50.0 * FT)).abs() < 1e-6, "{z}");
        // §77.19(a): the horizontal surface, 150 ft above the airport elevation, 8 000 ft to the side.
        let (z, k) = lim(&m, len / 2.0, 8000.0 * FT);
        assert_eq!(k, Kind::Horizontal);
        assert!((z - (610.0 + 150.0 * FT)).abs() < 1e-6);
        // §77.19(b): 10 000 ft radius (precision), then 20:1; 2 000 ft beyond → +100 ft.
        let (z, k) = lim(&m, len / 2.0, 12000.0 * FT);
        assert_eq!(k, Kind::Conical);
        assert!((z - (610.0 + 250.0 * FT)).abs() < 1e-6, "{z}");
        // Beyond the conical (10 000 + 4 000 ft), away from the approaches: nothing.
        let (z, _) = lim(&m, len / 2.0, 14100.0 * FT);
        assert!(z.is_nan());
        // Approach half-width: from 500 ft at the inner edge to 8 000 ft at 50 000 ft.
        // At 10 000 ft out the half-width is 500 + 7 500 × 10 000/50 000 = 2 000 ft: a point
        // 2 100 ft off the centreline is in the transitional, 100 ft from the edge → 200 + 100/7 ft;
        // but the horizontal (150 ft above 610 m = 33 ft above the 600 m end + …) is lower there.
        // The point is 218 ft outside the 10 000 ft arc about the primary end, so the conical
        // (150 ft + 218/20 ft above the airport) competes, and is lower.
        let (z, k) = lim(&m, -(200.0 + 10000.0) * FT, 2100.0 * FT);
        let za = 600.0 + 200.0 * FT;
        let zt = za + 100.0 * FT / 7.0;
        let zc = 610.0 + (150.0 + ((10000.0f64.powi(2) + 2100.0f64.powi(2)).sqrt() - 10000.0) / 20.0) * FT;
        assert!((z - zt.min(zc)).abs() < 1e-6, "{z} {zt} {zc} {k:?}");
        assert_eq!(k, Kind::Conical);
    }

    #[test]
    fn part77_pir_band_beyond_conical() {
        let m = model(Regime::Part77, runway([5, 5], [2, 2], 4, [600.0, 600.0]), 600.0);
        // 30 000 ft out (beyond the 14 000 ft conical): approach half-width 500 + 0.15 × 30 000 =
        // 5 000 ft; 4 000 ft beyond the edge the transitional still holds (§77.19(e), 5 000 ft).
        let x = -(200.0 + 30000.0) * FT;
        let (za, k) = lim(&m, x, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((za - (600.0 + (200.0 + 20000.0 / 40.0) * FT)).abs() < 1e-6);
        let (z, k) = lim(&m, x, (5000.0 + 4000.0) * FT);
        assert_eq!(k, Kind::Transitional);
        assert!((z - (za + 4000.0 * FT / 7.0)).abs() < 1e-6);
        let (z, _) = lim(&m, x, (5000.0 + 5100.0) * FT);
        assert!(z.is_nan());
    }

    #[test]
    fn part77_visual_utility() {
        // A(V) both ends: primary 250 ft, approach 20:1 for 5 000 ft to 1 250 ft wide, horizontal
        // radius 5 000 ft; unpaved: the primary ends at the runway ends.
        let mut r = runway([0, 0], [0, 0], 1, [300.0, 300.0]);
        r.paved = false;
        let m = model(Regime::Part77, r, 300.0);
        let (_, k) = lim(&m, 1500.0, 120.0 * FT);
        assert_eq!(k, Kind::Primary);
        let (z, k) = lim(&m, 1500.0, 130.0 * FT);
        assert_eq!(k, Kind::Transitional);
        assert!((z - (300.0 + 5.0 * FT / 7.0)).abs() < 1e-6);
        let (z, k) = lim(&m, -1000.0 * FT, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - (300.0 + 50.0 * FT)).abs() < 1e-6);
        // At 2 000 ft out the half-width is 125 + 500 × 2/5 = 325 ft; beyond it the transitional.
        let (z, k) = lim(&m, -2000.0 * FT, 320.0 * FT);
        assert_eq!(k, Kind::Approach);
        assert!((z - (300.0 + 100.0 * FT)).abs() < 1e-6);
        let (z, k) = lim(&m, -2000.0 * FT, 330.0 * FT);
        assert_eq!(k, Kind::Transitional);
        assert!((z - (300.0 + (100.0 + 5.0 / 7.0) * FT)).abs() < 1e-6);
        let (z, k) = lim(&m, 1500.0, 4900.0 * FT);
        assert_eq!(k, Kind::Horizontal);
        assert!((z - (300.0 + 150.0 * FT)).abs() < 1e-6);
        let (_, k) = lim(&m, 1500.0, 5100.0 * FT);
        assert_eq!(k, Kind::Conical);
    }

    #[test]
    fn icao_code4_precision_hand_cases() {
        // Code 4, precision category I both ends, thresholds at the ends, elevation 100 m.
        let mut r = runway([5, 5], [2, 2], 4, [100.0, 100.0]);
        r.ends[0].takeoff = false;
        let m = model(Regime::Icao, r, 100.0);
        let len = m.rwys[0].len;
        // Table 4-1: inner edge 280 m, 60 m before the threshold; 3 000 m at 2 %, 3 600 m at 2.5 %,
        // then horizontal to 15 000 m. 1 060 m before the threshold → 1 000 m into the first section.
        let (z, k) = lim(&m, -1060.0, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - 120.0).abs() < 1e-6, "{z}");
        // 6 500 m out (beyond the conical, 4 000 + 2 000 m from the strip end): 60 m + 3 500 m at 2.5 %.
        let (z, k) = lim(&m, -(60.0 + 6500.0), 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - (100.0 + 60.0 + 3500.0 * 0.025)).abs() < 1e-6, "{z}");
        // 5 000 m out the conical (1 000 m beyond the 4 000 m arc: 145 + 50 m) is below the approach.
        let (z, k) = lim(&m, -(60.0 + 5000.0), 0.0);
        assert_eq!(k, Kind::Conical);
        assert!((z - 195.0).abs() < 1e-6, "{z}");
        let (z, _) = lim(&m, -(60.0 + 10000.0), 0.0);
        assert!((z - 250.0).abs() < 1e-6, "{z}");
        // Strip 140 m each side; transitional 14.3 % from its edge: 100 m beyond → 14.3 m.
        let (z, k) = lim(&m, len / 2.0, 240.0);
        assert_eq!(k, Kind::Transitional);
        assert!((z - 114.3).abs() < 1e-6, "{z}");
        // Inner horizontal 45 m above the datum within 4 000 m of the strip ends.
        let (z, k) = lim(&m, len / 2.0, 3000.0);
        assert_eq!(k, Kind::InnerHorizontal);
        assert!((z - 145.0).abs() < 1e-6);
        // Conical 5 % for 100 m of height (2 000 m): 1 000 m beyond → 50 m above the IHS.
        let (z, k) = lim(&m, len / 2.0, 5000.0);
        assert_eq!(k, Kind::Conical);
        assert!((z - 195.0).abs() < 1e-6);
        // Table 4-2 take-off climb: inner edge 180 m, 60 m beyond the end, 12.5 % to 1 200 m, 2 %.
        // 2 060 m beyond end B on the centreline: the approach to B and the take-off climb beyond B
        // both rise 2 % from 60 m beyond the end: 40 m.
        let (z, _) = lim(&m, len + 2060.0, 0.0);
        assert!((z - 140.0).abs() < 1e-6, "{z}");
        // 14 000 m out the approach (horizontal section, 150 m above the threshold) is below the
        // take-off climb (2 % all the way: 280 m).
        let (z, k) = lim(&m, len + 60.0 + 14000.0, 0.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - 250.0).abs() < 1e-6, "{z}");
    }

    #[test]
    fn icao_takeoff_alone() {
        // Approaches off: only the take-off climb beyond the ends, the strip, transitional and IHS.
        let mut r = runway([2, 2], [0, 0], 3, [50.0, 50.0]);
        r.ends[0].approach = false;
        r.ends[1].approach = false;
        let m = model(Regime::Icao, r, 50.0);
        let len = m.rwys[0].len;
        let (z, k) = lim(&m, len + 60.0 + 1000.0, 0.0);
        assert_eq!(k, Kind::TakeOff);
        assert!((z - 70.0).abs() < 1e-6);
        // Half-width 90 m + 12.5 % × 1 000 m = 215 m.
        let (_, k) = lim(&m, len + 60.0 + 1000.0, 210.0);
        assert_eq!(k, Kind::TakeOff);
        let (_, k) = lim(&m, len + 60.0 + 1000.0, 220.0);
        assert_ne!(k, Kind::TakeOff);
        // Past 4 080 m the width stays 1 200 m.
        let (_, k) = lim(&m, len + 60.0 + 9000.0, 595.0);
        assert_eq!(k, Kind::TakeOff);
        let (_, k) = lim(&m, len + 60.0 + 9000.0, 605.0);
        assert_ne!(k, Kind::TakeOff);
    }

    #[test]
    fn refuses_bad_lists() {
        assert!(parse(&[]).is_err());
        assert!(parse(&[1.0, 0.0, 0.0, 0.0, 1.0, 0.0]).is_err());
        let a = Airport { regime: Regime::Part77, elev: 10.0, ihs_datum: 10.0, code_f: false, runways: vec![runway([5, 5], [2, 2], 4, [10.0, 10.0])] };
        let mut v = encode(&a);
        assert!(parse(&v).is_ok());
        v[HEAD + PER_RWY] = 95.0;
        assert!(parse(&v).is_err());
        let mut v = encode(&a);
        v[HEAD + PER_RWY + 3] = 6.0;
        assert!(parse(&v).is_err());
        let mut v = encode(&a);
        v.pop();
        assert!(parse(&v).is_err());
        let mut v = encode(&a);
        v[5] = 2.0;
        assert!(parse(&v).is_err());
        // Ends on top of each other: no runway.
        let mut b = a.clone();
        b.runways[0].ends[1].lon = b.runways[0].ends[0].lon;
        assert!(Model::build(&b).is_err());
    }

    #[test]
    fn amendment_18_code_3_non_instrument() {
        // Table 4-1: inner edge 110 m (was 150 m); §3.4.5: strip 55 m each side (was 75 m).
        let mut r = runway([2, 2], [0, 0], 3, [50.0, 50.0]);
        // The 2 % take-off climb would lie below the 3.33 % approach here.
        r.ends[0].takeoff = false;
        r.ends[1].takeoff = false;
        let m = model(Regime::Icao, r, 50.0);
        let len = m.rwys[0].len;
        let (_, k) = lim(&m, len / 2.0, 54.0);
        assert_eq!(k, Kind::Strip);
        let (z, k) = lim(&m, len / 2.0, 65.0);
        assert_eq!(k, Kind::Transitional);
        assert!((z - (50.0 + 10.0 * 0.143)).abs() < 1e-9, "{z}");
        // 100 m from the inner edge (160 m before the threshold) the half-width is 55 + 10 m.
        let (z, k) = lim(&m, -160.0, 64.0);
        assert_eq!(k, Kind::Approach);
        assert!((z - (50.0 + 3.33)).abs() < 1e-9, "{z}");
        let (_, k) = lim(&m, -160.0, 66.0);
        assert_eq!(k, Kind::Transitional);
        // Codes 1, 2 and 4 are as they were.
        for (code, strip, inner) in [(1, 30.0, 60.0), (2, 40.0, 80.0), (4, 75.0, 150.0)] {
            assert_eq!(icao_strip(0, code).0, strip);
            assert_eq!(icao_approach(0, code).0, inner);
        }
    }

    #[test]
    fn non_precision_ends_have_no_zone() {
        for icao in [[0, 0], [1, 1], [0, 1]] {
            let m = model(Regime::Icao, runway([3, 3], icao, 4, [100.0, 100.0]), 100.0);
            assert!(!m.has_zone());
            assert!(zone(&m, 1500.0, 100.0).0.is_nan());
        }
        assert!(!model(Regime::Part77, runway([5, 5], [2, 2], 4, [100.0, 100.0]), 100.0).has_zone());
        // A precision approach switched off has none either; the other end keeps its own.
        let mut r = runway([5, 5], [2, 2], 4, [100.0, 100.0]);
        r.ends[0].approach = false;
        let m = model(Regime::Icao, r, 100.0);
        assert_eq!(m.rwys[0].zones.len(), 1);
        assert!(zone(&m, -500.0, 0.0).0.is_nan());
    }

    #[test]
    fn zone_code_4_category_i_hand_cases() {
        // Table 4-1 column (10), level runway at 100 m: IHS 145 m. Precision on end A only, the
        // approach to end B a non-precision one, so end A's zone stands alone.
        let m = model(Regime::Icao, runway([5, 3], [2, 1], 4, [100.0, 100.0]), 100.0);
        let len = m.rwys[0].len;
        assert!((len - 3000.0).abs() < 1.0);
        // Inner approach: 120 m wide, 60 m to 960 m before the threshold, 2 %.
        let (z, k) = zone(&m, -560.0, 59.0);
        assert_eq!(k, Some(Kind::InnerApproach));
        assert!((z - 110.0).abs() < 1e-9, "{z}");
        // Beside it the inner transitional rises 33.3 % from the inner approach's side.
        let (z, k) = zone(&m, -560.0, 90.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - (110.0 + 30.0 * 0.333)).abs() < 1e-9, "{z}");
        // No zone beyond 960 m before the threshold.
        assert!(zone(&m, -961.0, 0.0).0.is_nan());
        // Between the inner edges: the strip, at the height of the nearest centre line point.
        let (z, k) = zone(&m, 900.0, 59.0);
        assert_eq!(k, Some(Kind::OfzStrip));
        assert!((z - 100.0).abs() < 1e-9, "{z}");
        // Inner transitional along the strip: 60 m from the centre line, 33.3 %, up to the plane.
        let (z, k) = zone(&m, 900.0, 90.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - (100.0 + 30.0 * 0.333)).abs() < 1e-9, "{z}");
        let top = 60.0 + 45.0 / 0.333;
        assert_eq!(zone(&m, 900.0, top - 0.1).1, Some(Kind::InnerTransitional));
        assert!(zone(&m, 900.0, top + 0.1).0.is_nan());
        // Balked landing: 1 800 m after the threshold, 3.33 %, sides diverging 10 %. 300 m in: 9.99 m
        // up, half-width 90 m.
        let (z, k) = zone(&m, 2100.0, 89.0);
        assert_eq!(k, Some(Kind::BalkedLanding));
        assert!((z - 109.99).abs() < 1e-9, "{z}");
        let (z, k) = zone(&m, 2100.0, 100.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - (109.99 + 10.0 * 0.333)).abs() < 1e-9, "{z}");
        // It ends in the plane of the inner horizontal surface, 45 / 3.33 % = 1 351.35 m on.
        let end = 1800.0 + 45.0 / 0.0333;
        assert_eq!(zone(&m, end - 1.0, 0.0).1, Some(Kind::BalkedLanding));
        assert!(zone(&m, end + 1.0, 0.0).0.is_nan());
    }

    #[test]
    fn zone_is_reported_though_lower_surfaces_hide_it() {
        // In the strip at 100 m from the centre line the strip is the lowest limit, level with the
        // runway; the zone's own limit there is 13.32 m higher. Lowest-only would never show it.
        let m = model(Regime::Icao, runway([5, 5], [2, 2], 4, [100.0, 100.0]), 100.0);
        let (x, y) = at(&m, 1500.0, 100.0);
        let l = m.limits(x, y);
        assert_eq!(m.surfaces[l.lowest.1].kind, Kind::Strip);
        assert_eq!(m.surfaces[l.zone.1].kind, Kind::InnerTransitional);
        assert!((l.zone.0 - (100.0 + 40.0 * 0.333)).abs() < 1e-9);
        // Under the approach, the approach and the inner approach are the same height.
        let (x, y) = at(&m, -560.0, 50.0);
        let l = m.limits(x, y);
        assert_eq!(m.surfaces[l.lowest.1].kind, Kind::Approach);
        assert_eq!(m.surfaces[l.zone.1].kind, Kind::InnerApproach);
        assert!((l.lowest.0 - l.zone.0).abs() < 1e-9);
    }

    #[test]
    fn zone_is_the_lowest_limit_where_nothing_lower_lies() {
        // No approach or take-off climb beyond end B: past the strip the balked landing surface of
        // end A is the lowest limit under the inner horizontal.
        let mut r = runway([5, 5], [2, 0], 4, [100.0, 100.0]);
        r.ends[1].approach = false;
        r.ends[1].takeoff = false;
        let m = model(Regime::Icao, r, 100.0);
        let len = m.rwys[0].len;
        let (z, k) = lim(&m, len + 100.0, 0.0);
        assert_eq!(k, Kind::BalkedLanding);
        assert!((z - (100.0 + (len + 100.0 - 1800.0) * 0.0333)).abs() < 1e-9, "{z}");
    }

    #[test]
    fn zone_columns_9_and_11_and_code_letter_f() {
        // Column (9), code 2 category I: 90 m, 2.5 %, 40 %, balked landing 4 % from the strip end
        // (60 m beyond the runway end).
        let m = model(Regime::Icao, runway([5, 5], [2, 0], 2, [100.0, 100.0]), 100.0);
        let len = m.rwys[0].len;
        let (z, k) = zone(&m, -160.0, 44.0);
        assert_eq!(k, Some(Kind::InnerApproach));
        assert!((z - 102.5).abs() < 1e-9, "{z}");
        let (z, k) = zone(&m, 1000.0, 65.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - 108.0).abs() < 1e-9, "{z}");
        assert_eq!(zone(&m, len + 59.0, 0.0).1, Some(Kind::OfzStrip));
        let (z, k) = zone(&m, len + 160.0, 0.0);
        assert_eq!(k, Some(Kind::BalkedLanding));
        assert!((z - 104.0).abs() < 1e-9, "{z}");
        // Column (11): as column (10); a short runway ends its strip part at the runway end.
        let mut r = runway([5, 5], [3, 0], 4, [100.0, 100.0]);
        r.ends[0].lon = r.ends[1].lon - (r.ends[1].lon - r.ends[0].lon) * 0.5;
        let m = model(Regime::Icao, r, 100.0);
        let len = m.rwys[0].len;
        assert!((len - 1500.0).abs() < 1.0);
        assert_eq!(zone(&m, len - 1.0, 0.0).1, Some(Kind::OfzStrip));
        assert_eq!(zone(&m, len + 1.0, 0.0).1, Some(Kind::BalkedLanding));
        // Code letter F: 140 m on columns (10) and (11).
        let mut a = Airport { regime: Regime::Icao, elev: 100.0, ihs_datum: 100.0, code_f: true, runways: vec![runway([5, 5], [2, 0], 4, [100.0, 100.0])] };
        let wide = Model::build(&parse(&encode(&a)).unwrap()).unwrap();
        assert_eq!(wide.rwys[0].zones[0].hw, 70.0);
        // It does not reach column (9).
        a.runways = vec![runway([5, 5], [2, 0], 2, [100.0, 100.0])];
        let narrow = Model::build(&parse(&encode(&a)).unwrap()).unwrap();
        assert_eq!(narrow.rwys[0].zones[0].hw, 45.0);
    }

    #[test]
    fn zone_with_a_displaced_threshold_and_a_sloping_runway() {
        // End A displaced 300 m at 101 m on a 100 m to 106 m runway: stations run from the threshold.
        let mut r = runway([5, 3], [2, 1], 4, [100.0, 106.0]);
        r.ends[0].disp = 300.0;
        r.ends[0].thr_elev = 100.6;
        let m = model(Regime::Icao, r, 106.0);
        let len = m.rwys[0].len;
        // Inner approach measured from the displaced threshold, from its elevation.
        let (z, k) = zone(&m, 300.0 - 60.0 - 500.0, 0.0);
        assert_eq!(k, Some(Kind::InnerApproach));
        assert!((z - 110.6).abs() < 1e-9, "{z}");
        // The balked landing starts 1 800 m after the threshold: at 2 100 m on the runway.
        let z0 = 100.0 + 6.0 * (2100.0 / len);
        let (z, k) = zone(&m, 2100.0 + 300.0, 0.0);
        assert_eq!(k, Some(Kind::BalkedLanding));
        assert!((z - (z0 + 300.0 * 0.0333)).abs() < 1e-9, "{z}");
        // Along the strip the elevation is the centre line's nearest point.
        let (z, k) = zone(&m, 1500.0, 90.0);
        assert_eq!(k, Some(Kind::InnerTransitional));
        assert!((z - (100.0 + 6.0 * (1500.0 / len) + 30.0 * 0.333)).abs() < 1e-9, "{z}");
        // End B's mirror: a precision approach to B with the same geometry.
        let mut r = runway([3, 5], [1, 2], 4, [106.0, 100.0]);
        r.ends[1].disp = 300.0;
        r.ends[1].thr_elev = 100.6;
        let m2 = model(Regime::Icao, r, 106.0);
        let (z, k) = zone(&m2, len - (2100.0 + 300.0), 0.0);
        assert_eq!(k, Some(Kind::BalkedLanding));
        assert!((z - (z0 + 300.0 * 0.0333)).abs() < 1e-6, "{z}");
    }

    #[test]
    fn refuses_what_table_4_1_does_not_define() {
        for code in [1, 2] {
            let a = Airport { regime: Regime::Icao, elev: 10.0, ihs_datum: 10.0, code_f: false, runways: vec![runway([5, 5], [3, 2], code, [10.0, 10.0])] };
            assert!(Model::build(&a).unwrap_err().contains("no precision category II or III"));
        }
        // Part 77 does not use the column.
        let a = Airport { regime: Regime::Part77, elev: 10.0, ihs_datum: 10.0, code_f: false, runways: vec![runway([5, 5], [3, 2], 1, [10.0, 10.0])] };
        assert!(Model::build(&a).is_ok());
    }

    #[test]
    fn refuses_more_surfaces_than_an_index_holds() {
        let r = runway([5, 5], [2, 2], 4, [10.0, 10.0]);
        let a = Airport { regime: Regime::Icao, elev: 10.0, ihs_datum: 10.0, code_f: false, runways: vec![r; 19] };
        assert!(Model::build(&a).unwrap_err().contains("254"));
    }

    #[test]
    fn zone_facets_lie_on_the_zone() {
        let mut r = runway([5, 5], [2, 3], 4, [600.0, 605.0]);
        r.ends[0].disp = 200.0;
        r.ends[0].thr_elev = 600.3;
        let m = model(Regime::Icao, r, 606.0);
        zone_facets_on_zone(&m, 12);
        // Amendment 18: precision at one end, non-precision (with the vertical section) at the other.
        let mut r = runway([5, 3], [2, 1], 4, [600.0, 605.0]);
        (r.adg, r.mtom, r.width) = (4, 30000.0, 45.0);
        r.ends[0].disp = 200.0;
        r.ends[0].thr_elev = 600.3;
        zone_facets_on_zone(&model(Regime::IcaoA18, r, 606.0), 12);
    }

    fn zone_facets_on_zone(m: &Model, min: usize) {
        let mut n = 0;
        for (id, ring) in m.facets() {
            if !matches!(m.surfaces[id].kind, Kind::InnerApproach | Kind::InnerTransitional | Kind::BalkedLanding | Kind::OfzStrip) {
                continue;
            }
            n += 1;
            let c = ring.len() as f64;
            let (la, lo, z) = ring.iter().fold((0.0, 0.0, 0.0), |a, p| (a.0 + p.0 / c, a.1 + p.1 / c, a.2 + p.2 / c));
            let (lz, _) = m.limits_at(la, lo).zone;
            assert!(lz.is_finite(), "{:?} facet centroid outside the zone", m.surfaces[id].kind);
            assert!(z >= lz - 0.05, "{:?} facet {z} below the zone {lz}", m.surfaces[id].kind);
        }
        assert!(n >= min, "{n}");
    }

    #[test]
    fn facets_lie_on_their_surfaces() {
        for regime in [Regime::Part77, Regime::Icao, Regime::IcaoA18] {
            let mut r = runway([5, 3], [2, 1], 4, [600.0, 605.0]);
            (r.adg, r.mtom, r.width) = (6, 300000.0, 45.0);
            let m = model(regime, r, 606.0);
            let f = m.facets();
            assert!(f.len() > 50);
            // A facet lies on its surface, which is never below the lowest one: at each facet's
            // centroid the limit is no higher than the facet.
            for (id, ring) in &f {
                let n = ring.len() as f64;
                let (la, lo, z) = ring.iter().fold((0.0, 0.0, 0.0), |a, p| (a.0 + p.0 / n, a.1 + p.1 / n, a.2 + p.2 / n));
                let (lz, _) = m.limit_at(la, lo);
                assert!(lz.is_finite(), "{:?} facet centroid outside every surface", m.surfaces[*id].kind);
                assert!(z >= lz - 0.05, "{:?} facet {z} below the limit {lz}", m.surfaces[*id].kind);
            }
        }
    }
}
