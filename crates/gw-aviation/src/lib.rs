//! Airfield obstruction surfaces (REQ-GAP-73, SDP-2.3 GR-27).
//!
//! * FAA 14 CFR Part 77 subpart C, §77.19 "Civil airport imaginary surfaces": primary, approach (by
//!   runway category and approach type), transitional, horizontal and conical surfaces.
//! * ICAO Annex 14 Volume I (8th edition, July 2018), Chapter 4 §4.1 and Tables 4-1 and 4-2:
//!   approach, transitional, inner horizontal, conical and take-off climb surfaces, with the runway
//!   strip of Chapter 3 §3.4 as the lower edge of the transitional surfaces.
//!
//! Every surface is a height above mean sea level as a function of the horizontal position, as both
//! documents define them; heights in and out are orthometric metres. Positions are geodetic (WGS 84)
//! and are worked in a tangent plane at the aerodrome (frame.rs), which is exact to millimetres over
//! the 15 km the longest surfaces reach. Where surfaces overlap, the lowest one limits (an object is
//! an obstruction when it penetrates any of them, §77.17(a)(5); Annex 14 §4.2).

pub mod frame;
pub mod hull;
pub mod model;

pub use model::{parse, Airport, Kind, Model, Regime};

/// One foot in metres (exact, international foot).
pub const FT: f64 = 0.3048;
