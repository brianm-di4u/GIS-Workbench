//! GIS Workbench photogrammetric adjustment (Appendix D `gw-adjust`): the RPC bias-compensated
//! block adjustment (REQ-SNS-11), its non-destructive adjustment record (REQ-SNS-15) and RPC
//! fitting to any model (REQ-SNS-16).

pub mod block;
pub mod linalg;
pub mod rpcfit;
