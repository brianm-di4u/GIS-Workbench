//! GIS Workbench SAR processing (Appendix D `gw-sar`; REQ-SAR-07..11, 13, 14; radargrammetry
//! REQ-GAP-42). Pixel arrays are
//! row-major; complex samples are [`fft::Cx`]. Display remaps live in the image chain's LUT
//! (`app/src/render/chain.js`), the projections in `gw-sensor::sicd`.

pub mod change;
pub mod fft;
pub mod pairs;
pub mod polsar;
pub mod radargram;
pub mod register;
pub mod speckle;
pub mod subap;
