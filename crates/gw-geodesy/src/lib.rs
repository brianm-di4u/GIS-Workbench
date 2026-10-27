//! GIS Workbench geodesy (Appendix D `gw-geodesy`): WGS 84 only internally, HAE heights
//! (REQ-GEO-01). Every function here is deterministic and has a test vector from
//! `Research/05`.

pub mod coords;
pub mod geodesic;
pub mod geoid;
pub mod grids;
pub mod math;
pub mod projection;
pub mod stats;
pub mod time;
pub mod wgs84;
