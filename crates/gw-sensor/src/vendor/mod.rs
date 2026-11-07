//! Rigorous and view-geometry models from vendor metadata (REQ-GAP-20): DigitalGlobe/Maxar
//! EPH/ATT/GEO/IMD, ALOS PRISM CEOS Level 1B1, Landsat Collection 1/2 ANG, Sentinel-2 L1C MTD.
//! The readers turn the files into the line scanner of `crate::linescan` or the map + line-of-sight
//! model of `crate::ortholos`; they are compiled into the lazy `vendor` bundle only.

pub mod dg;
pub mod odl;
pub mod landsat;
pub mod s2;
