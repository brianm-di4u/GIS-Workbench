//! The CORS relay is not in a shipped build (REQ-GAP-08, OD-2.17). `cargo test` with default features
//! is the shipped configuration, so this file is the proof: no route, no capability, no flag, no TLS
//! crate, no bytes. `cargo test --features cors-relay` runs the opposite half, so a check here cannot
//! pass by looking at nothing. `GWB_SIDECAR_TEST` must stay unset for this binary.

mod common;
use common::*;
use serde_json::json;

fn bytes_of_the_shipped_binary() -> Vec<u8> {
    std::fs::read(env!("CARGO_BIN_EXE_gwb-sidecar")).unwrap()
}

fn holds(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

const MARKER: &[u8] = b"GWB-CORS-RELAY-COMPILED-IN";

#[cfg(not(feature = "cors-relay"))]
mod shipped {
    use super::*;

    #[tokio::test(flavor = "multi_thread")]
    async fn the_relay_is_no_route_at_all() {
        let h = start().await;
        for m in ["GET", "POST", "PUT", "DELETE"] {
            let r = Req::new(m, "/v1/cors-relay/fetch").json(json!({"url": "https://example.org/", "method": "GET"})).send(h.port).await;
            assert_eq!(r.status, 404, "{m}: {}", r.text());
        }
        let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
        assert_eq!(caps["features"]["cors_relay"], json!(false));
        assert!(!h.svc.cfg.cors_relay_open());
    }

    #[test]
    fn no_flag_or_setting_turns_it_on() {
        for flag in ["--test-allow-cors-relay", "--test-relay-ca", "--test-relay-resolve"] {
            let e = gwb_sidecar::config::Config::from_args(&[flag.to_string(), "x".to_string()]).unwrap_err();
            assert!(e.contains("GWB_SIDECAR_TEST"), "{flag}: {e}");
        }
        let dir = std::env::temp_dir().join(format!("gwb-ship-{}", gwb_sidecar::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        for key in ["cors_relay = true", "allow_cors_relay = true", "test_allow_cors_relay = true", "relay_origins = [\"https://example.org\"]"] {
            std::fs::write(dir.join("config.toml"), key).unwrap();
            let e = gwb_sidecar::config::Config::from_args(&["--data-dir".to_string(), dir.display().to_string()]).unwrap_err();
            assert!(e.contains("unknown field"), "{key}: {e}");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_binary_holds_no_relay_and_no_tls() {
        let b = bytes_of_the_shipped_binary();
        assert!(b.len() > 100_000);
        for n in [MARKER, b"rustls", b"ring-core", b"X-Gwb-Relay", b"cors-relay:"] {
            assert!(!holds(&b, n), "{} is in the binary", String::from_utf8_lossy(n));
        }
    }

    #[test]
    fn no_tls_crate_is_in_the_dependency_tree() {
        let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
        let o = std::process::Command::new(env!("CARGO")).args(["tree", "--manifest-path", manifest, "-e", "normal", "--prefix", "none", "--offline"]).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        let t = String::from_utf8_lossy(&o.stdout);
        assert!(t.lines().count() > 20, "{t}");
        for c in ["rustls", "ring ", "tokio-rustls", "webpki", "schannel", "openssl"] {
            assert!(!t.contains(c), "{c} is in the shipped tree:\n{t}");
        }
    }
}

#[cfg(feature = "cors-relay")]
mod relay_build {
    use super::*;

    #[test]
    fn a_relay_build_does_hold_the_marker() {
        assert!(holds(&bytes_of_the_shipped_binary(), MARKER), "the package gate would look for nothing");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn compiled_in_but_the_gate_stays_shut_without_a_test_run() {
        // The flag alone does nothing with GWB_SIDECAR_TEST unset: a stolen relay build is still off.
        let h = start_with(|c| c.test_allow_cors_relay = true).await;
        assert!(!h.svc.cfg.cors_relay_open());
        let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
        assert_eq!(caps["features"]["cors_relay"], json!(false));
        let r = Req::new("POST", "/v1/cors-relay/fetch").json(json!({"url": "https://example.org/", "method": "GET"})).send(h.port).await;
        assert_eq!(r.status, 403, "{}", r.text());
        assert_eq!(r.json()["code"], json!("gate_closed"));
        assert!(r.text().contains("external security review"));
        let log: Vec<String> = h.svc.log.lock().unwrap().iter().cloned().collect();
        assert!(log.iter().any(|l| l.contains("cors-relay: refused") && l.contains("gate_closed")), "{log:?}");
    }

    #[test]
    fn config_toml_has_no_key_for_it_in_a_relay_build_either() {
        let dir = std::env::temp_dir().join(format!("gwb-ship-{}", gwb_sidecar::util::random_hex(6)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.toml"), "test_allow_cors_relay = true").unwrap();
        let e = gwb_sidecar::config::Config::from_args(&["--data-dir".to_string(), dir.display().to_string()]).unwrap_err();
        assert!(e.contains("unknown field"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
