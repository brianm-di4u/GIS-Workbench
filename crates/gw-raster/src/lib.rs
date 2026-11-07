//! GIS Workbench raster processing (Appendix D `gw-raster`): orthorectification by inverse
//! mapping on an adaptive grid (REQ-SNS-17) and mosaic blending with seams, gain/offset colour
//! balance and feathering (REQ-SNS-18); pan-sharpening at pan resolution with quality metrics
//! (REQ-GAP-14).

pub mod mosaic;
pub mod ortho;
pub mod pansharp;
pub mod resample;
