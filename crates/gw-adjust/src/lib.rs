//! GIS Workbench photogrammetric adjustment (Appendix D `gw-adjust`): the RPC bias-compensated
//! block adjustment (REQ-SNS-11), its non-destructive adjustment record (REQ-SNS-15) and RPC
//! fitting to any model (REQ-SNS-16). The aerial triangulation of frame cameras (REQ-GAP-22) is
//! `gw-aero`, which builds on this crate's block types and linear algebra.

pub mod block;
pub mod gpm;
pub mod lidarreg;
pub mod linalg;
pub mod rpcfit;
pub mod rsmfit;
