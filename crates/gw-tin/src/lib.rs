//! GIS Workbench TIN (REQ-GAP-39, GR-13): a constrained Delaunay triangulation with hard and soft
//! breaklines, mass points and exclusion polygons (`mesh`), built from scattered points or from
//! DEM posts thinned to a vertical tolerance (`make`), edited by a replayable edit list with
//! ridge and drain profile editors (`ops`), rasterised to a DEM (`make::rasterize`), moved between
//! threads as bytes (`state`), read and written as LandXML (`landxml`) or point text (`text`), and
//! made to keep a file's own triangles (`faces`).

pub mod err;
pub mod faces;
pub mod landxml;
pub mod make;
pub mod mesh;
pub mod ops;
pub mod pred;
pub mod state;
pub mod text;
pub mod xml;
