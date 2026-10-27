//! GIS Workbench hardened parsers (Appendix D `gw-parse`, REQ-SEC-02, REQ-RUST-07).
//! Every parser here takes a byte slice, checks every length against it, and returns an
//! error rather than panicking or looping on malformed input. Fuzz targets: `crates/fuzz`.

pub mod bytes;
pub mod dted;
pub mod envi;
pub mod klv;
pub mod msimeta;
pub mod nitf;
pub mod pdf;
pub mod pixels;
pub mod s4607;
pub mod sicd;
pub mod tre;
pub mod ts;
pub mod xml;
