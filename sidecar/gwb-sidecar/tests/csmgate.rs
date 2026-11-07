//! OD-2.18, for a build as it ships (no `csm-host` feature): even a test run, with
//! GWB_SIDECAR_TEST=1 and the field the test flag would set, cannot open the plug-in host. Its own
//! test binary, because security.rs must run without that variable. `sidecar/installer/gates.mjs`
//! makes the same check on the binary of each package.
#![cfg(not(feature = "csm-host"))]
#![allow(clippy::all)]

mod common;
use common::*;
use gwb_sidecar::config::Config;
use serde_json::json;

fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gate_cannot_open_in_a_build_without_the_feature() {
    std::env::set_var("GWB_SIDECAR_TEST", "1");
    let mut c = Config::defaults(std::env::temp_dir());
    c.test_allow_csm = true;
    assert!(!c.gate_open("csm-plugin"), "the field alone");
    assert!(c.gate_open("csm-plugin") == false);
    // A gate of the same kind opens here, so this run really is a test run.
    c.test_allow_database = true;
    assert!(c.gate_open("database"));

    for flag in ["--test-allow-csm", "--test-csm-host"] {
        let e = Config::from_args(&args(&["gwb-sidecar", flag, "x"])).unwrap_err();
        assert!(e.contains("unknown flag"), "{flag}: {e}");
    }

    let h = start_with(|c| {
        c.test_allow_csm = true;
        c.test_csm_host = Some(std::env::temp_dir());
    })
    .await;
    assert_eq!(Req::new("GET", "/v1/caps").send(h.port).await.json()["csm_host"]["available"], json!(false));
    let r = Req::new("POST", "/v1/csm/sessions").json(json!({"plugin": "0", "isd": "0"})).send(h.port).await;
    assert_eq!(r.status, 403, "{}", r.text());
    assert_eq!(r.json()["code"], json!("csm_off"));
}
