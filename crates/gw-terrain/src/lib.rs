//! GIS Workbench terrain analysis (Appendix D `gw-terrain`): viewsheds (REQ-DEM-13, D16), helicopter
//! landing zones (REQ-DEM-14) and class rasters for raster-to-vector.

pub mod buildings;
pub mod hlz;
pub mod rtin;
pub mod viewshed;

/// A height grid in metres with its cell size (metres per post in x and y).
pub struct Grid<'a> {
    pub w: usize,
    pub h: usize,
    pub z: &'a [f32],
    pub cell_x: f64,
    pub cell_y: f64,
}
