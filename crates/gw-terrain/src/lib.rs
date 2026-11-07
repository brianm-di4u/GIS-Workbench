//! GIS Workbench terrain analysis (Appendix D `gw-terrain`): viewsheds (REQ-DEM-13, D16), helicopter
//! landing zones (REQ-DEM-14), class rasters for raster-to-vector and the DEM edit kernels
//! (REQ-DEM-08/09, REQ-GAP-37/38) and SAR layover and shadow masks (REQ-GAP-42).

pub mod buildings;
pub mod edit;
pub mod hlz;
pub mod rtin;
pub mod sarmask;
pub mod viewshed;

/// A height grid in metres with its cell size (metres per post in x and y).
pub struct Grid<'a> {
    pub w: usize,
    pub h: usize,
    pub z: &'a [f32],
    pub cell_x: f64,
    pub cell_y: f64,
}
