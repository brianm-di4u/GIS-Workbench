//! The CSM 3.0.x plug-in host (REQ-GAP-25, OD-2.18; design in
//! `docs/design/csm-host.md`).
//!
//! OFF in every shipped build. Three locks, each enough alone:
//!   1. The `csm-host` Cargo feature. Without it nothing below `mod imp` exists in the binary: every
//!      `/v1/csm` path answers 403 and the test flags are unknown flags. No package build sets it.
//!   2. With the feature, the `csm-plugin` gate needs `--test-allow-csm` and `GWB_SIDECAR_TEST=1`.
//!   3. The host program is not in any package (`sidecar/installer/gates.mjs` fails a stage that
//!      holds it), so a binary with the gate open would still have nothing to start.
//!
//! The project distributes no plug-ins.

use crate::server::{err, ApiError};
use crate::service::Service;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use gwb_sidecar_api::CsmHostCaps;
use std::sync::Arc;

pub const GATE: &str = "csm-plugin";
pub const OFF: &str = "The CSM plug-in host is off: it stays off until the sidecar is signed and has passed its external security review";

fn off() -> ApiError {
    err(403, "csm_off", OFF)
}

pub fn caps(svc: &Service) -> CsmHostCaps {
    CsmHostCaps { available: svc.cfg.gate_open(GATE), note: if svc.cfg.gate_open(GATE) { "test gate open".into() } else { OFF.into() } }
}

async fn refuse() -> Response {
    off().into_response()
}

fn off_router() -> Router<Arc<Service>> {
    Router::new().route("/v1/csm", any(refuse)).route("/v1/csm/{*rest}", any(refuse)).route("/ui/api/csm/{*rest}", any(refuse))
}

#[cfg(not(feature = "csm-host"))]
pub fn router(_svc: Arc<Service>) -> Router<Arc<Service>> {
    off_router()
}

#[cfg(feature = "csm-host")]
pub fn router(svc: Arc<Service>) -> Router<Arc<Service>> {
    if svc.cfg.gate_open(GATE) {
        imp::router(svc)
    } else {
        off_router()
    }
}

#[cfg(feature = "csm-host")]
mod imp;
#[cfg(feature = "csm-host")]
pub mod proto;
#[cfg(feature = "csm-host")]
pub mod sandbox;
#[cfg(feature = "csm-host")]
pub mod signer;

#[cfg(feature = "csm-host")]
pub use imp::{close_all, State};

/// The plug-in records for the sidecar window; `null` while the host is off, so it shows nothing.
pub fn window_state(svc: &Service) -> serde_json::Value {
    #[cfg(feature = "csm-host")]
    if svc.cfg.gate_open(GATE) {
        return imp::window_state(svc);
    }
    let _ = svc;
    serde_json::Value::Null
}

#[cfg(test)]
mod tests {
    use crate::config::Config;

    #[test]
    fn no_other_gate_name_opens() {
        let mut c = Config::defaults(std::env::temp_dir());
        c.test_allow_csm = true;
        c.test_allow_database = true;
        for g in ["", "network", "CSM-PLUGIN", "csm-plugin ", "plugin"] {
            assert!(!c.gate_open(g), "{g:?}");
        }
    }
}
