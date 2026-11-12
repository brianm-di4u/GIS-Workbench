//! The part of the UAV structure-from-motion route (REQ-GAP-29) that is not COLMAP: checking the
//! block, georeferencing the model from the cameras' GPS, CPU multi-view stereo, and the products
//! (DSM, orthomosaic, oriented frames, point cloud). COLMAP's own dense stage needs CUDA, and the
//! CUDA runtime is not cleared for the sidecar (docs/validation/2.6/sfm.md), so this crate computes
//! the depth maps and COLMAP's `stereo_fusion`, which runs on the CPU, fuses them.

#![allow(clippy::too_many_arguments, clippy::type_complexity)]

pub mod ba;
pub mod colmap;
pub mod exifgps;
pub mod gcp;
pub mod geo;
pub mod georef;
pub mod las;
pub mod mvs;
pub mod products;
pub mod tiff;

pub type Res<T> = Result<T, String>;

/// A `PROGRESS <0..1>` line for the sidecar's job (runner.rs `lines`).
pub fn progress(p: f64) {
    use std::io::Write;
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "PROGRESS {:.4}", p.clamp(0.0, 1.0));
    let _ = o.flush();
}
