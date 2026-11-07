//! `tiles` bundle (lazy): tiled-format codecs and writers (Appendix D §2.2.1).
//! One module per area; each holds its `extern "C"` exports.

gw_abi::export_abi!();

mod brotli;
mod i3s;
mod mvt;
mod pmtiles;
mod qmesh;
