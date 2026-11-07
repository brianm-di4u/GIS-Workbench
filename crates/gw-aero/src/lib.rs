//! GIS Workbench aerial triangulation (REQ-GAP-22, GR-08): the bundle adjustment of frame
//! cameras (`aero`), space resection (`resect`), film interior orientation from fiducials
//! (`fiducial`) and their small 3-D geometry (`geom`). Built for size in the photo bundle
//! (crates/Cargo.toml profile override): dense linear algebra that size optimisation slows little.

pub mod aero;
pub mod fiducial;
pub mod geom;
pub mod resect;
