//! GIS Workbench tiles (Appendix D §2.1.1 `gw-tiles`): decoders and writers for tiled formats.
//! Inputs are untrusted; every function returns an error instead of panicking.

#[cfg(feature = "brotli")]
pub mod brotli;
pub mod gz;
pub mod i3s;
pub mod mvt;
pub mod pmtiles;
pub mod qmesh;
