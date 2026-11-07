//! ArcGIS Pro sync (REQ-GAP-65, SCN-65): the wire contract shared with the add-in's client, the
//! separation of add-in tokens from every other token, and the refusals. Numbers and direction are
//! tested in `prosync.rs` itself.

mod common;
use common::*;
use gwb_sidecar::prosync::SYNC_ORIGIN;
use gwb_sidecar::relay::RELAY_ORIGIN;
use serde_json::{json, Value};

const CONTRACT: &str = include_str!("../../pro-addin/contract/sync-contract.json");
const ADDIN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PY: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn subset(want: &Value, got: &Value, at: &str) {
    match want {
        Value::String(s) if s == "@any" => assert!(!got.is_null(), "{at}: missing"),
        Value::Object(o) => {
            for (k, v) in o {
                subset(v, &got[k], &format!("{at}.{k}"));
            }
        }
        Value::Number(n) => assert_eq!(n.as_f64(), got.as_f64(), "{at}"),
        _ => assert_eq!(want, got, "{at}"),
    }
}

async fn paired() -> H {
    let h = start().await;
    h.svc.pairings.add_token(SYNC_ORIGIN, ADDIN, "ArcGIS Pro add-in");
    h
}

fn addin<'a>(method: &'a str, path: &'a str) -> Req<'a> {
    Req::new(method, path).origin(None).token(Some(ADDIN))
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wire_contract() {
    let h = paired().await;
    let c: Value = serde_json::from_str(CONTRACT).unwrap();
    let mut session = String::new();
    for step in c["steps"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        let path = step["path"].as_str().unwrap().replace("$session", &session);
        let method = step["method"].as_str().unwrap();
        let r = Req::new(method, &path);
        let r = match step["who"].as_str().unwrap() {
            "addin" => r.origin(None).token(Some(ADDIN)),
            "page" => r,
            "none" => r.origin(None).token(None),
            "page-token-no-origin" => r.origin(None),
            "addin-with-origin" => r.token(Some(ADDIN)),
            o => panic!("{o}"),
        };
        let r = if step["body"].is_null() { r } else { r.json(step["body"].clone()) };
        let got = r.send(h.port).await;
        assert_eq!(got.status as u64, step["expect"]["status"].as_u64().unwrap(), "{name}: {}", got.text());
        if let Some(code) = step["expect"]["code"].as_str() {
            assert_eq!(got.json()["code"], json!(code), "{name}");
        }
        if !step["expect"]["body"].is_null() {
            subset(&step["expect"]["body"], &got.json(), name);
        }
        if let Some(s) = got.json()["session"].as_str() {
            session = s.to_string();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn no_page_reaches_the_add_ins_side() {
    let h = paired().await;
    for (k, v) in [("Referer", "https://evil.example/"), ("Sec-Fetch-Site", "cross-site"), ("Sec-Fetch-Mode", "cors"), ("Sec-Fetch-Dest", "empty")] {
        let r = addin("GET", "/sync/v1/hello").header(k, v).send(h.port).await;
        assert_eq!(r.status, 403, "{k}");
        assert_eq!(r.json()["code"], json!("browser_refused"));
    }
    for o in ["null", HOSTED, "https://evil.example"] {
        let r = Req::new("GET", "/sync/v1/hello").origin(Some(o)).token(Some(ADDIN)).send(h.port).await;
        assert_eq!(r.status, 403, "{o}");
        assert!(r.header("access-control-allow-origin").is_none(), "no CORS on this side");
        let r = Req::new("OPTIONS", "/sync/v1/state").origin(Some(o)).header("Access-Control-Request-Method", "POST").send(h.port).await;
        assert_eq!(r.status, 403, "no preflight: {o}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn each_token_opens_its_own_door_only() {
    let h = paired().await;
    h.svc.pairings.add_token(RELAY_ORIGIN, PY, "script");
    // A Python relay token on the add-in's side, and the add-in's on every other.
    assert_eq!(Req::new("GET", "/sync/v1/next?after=0").origin(None).token(Some(PY)).send(h.port).await.status, 401);
    assert_eq!(addin("POST", "/relay/v1/mcp").json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(h.port).await.status, 401);
    for (m, p) in [("GET", "/v1/caps"), ("GET", "/v1/files"), ("GET", "/v1/jobs"), ("POST", "/v1/sync/attach")] {
        let r = Req::new(m, p).origin(Some("null")).token(Some(ADDIN)).send(h.port).await;
        assert_eq!(r.status, 401, "{m} {p}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_add_in_cannot_reach_a_page_it_is_not_attached_to() {
    let h = paired().await;
    let bad = "0123456789abcdef0123456789abcdef0123456789abcdef";
    for s in [bad, "short", "../attach"] {
        let r = Req::new("GET", &format!("/v1/sync/{s}/next")).send(h.port).await;
        assert!(r.status == 404, "{s}: {}", r.status);
    }
    let r = Req::new("POST", "/v1/sync/attach").json(json!({"client": "", "direction": "both"})).send(h.port).await;
    assert_eq!(r.status, 400);
    let r = Req::new("POST", "/v1/sync/attach").json(json!({"client": "p", "direction": "sideways"})).send(h.port).await;
    assert_eq!(r.status, 400);
    let r = Req::new("POST", "/v1/sync/attach").json(json!({"client": "x".repeat(81), "direction": "both"})).send(h.port).await;
    assert_eq!(r.status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_page_is_refused_and_forgetting_ends_it() {
    let h = paired().await;
    let (t2, _) = (&"c".repeat(64), ());
    h.svc.pairings.add_token("null", t2, "second page");
    assert_eq!(Req::new("POST", "/v1/sync/attach").json(json!({"client": "p", "direction": "both"})).send(h.port).await.status, 200);
    let r = Req::new("POST", "/v1/sync/attach").token(Some(t2)).json(json!({"client": "q", "direction": "both"})).send(h.port).await;
    assert_eq!(r.status, 409);
    assert_eq!(r.json()["code"], json!("sync_held"));
    assert!(h.svc.sync.app_on());
    assert_eq!(Req::new("DELETE", "/v1/pair").send(h.port).await.status, 204);
    assert!(!h.svc.sync.app_on(), "a forgotten pairing ends sync");
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_in_the_window_ends_it() {
    let h = paired().await;
    assert_eq!(Req::new("POST", "/v1/sync/attach").json(json!({"client": "p", "direction": "both"})).send(h.port).await.status, 200);
    h.svc.pairings.revoke("null");
    h.svc.sync.detach_where(|o, _| o == "null");
    assert!(!h.svc.sync.app_on());
    assert!(h.svc.pairings.revoke(SYNC_ORIGIN));
    assert_eq!(addin("GET", "/sync/v1/next").send(h.port).await.status, 401, "an add-in's pairing can be revoked too");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_over_long_message_is_refused() {
    let h = paired().await;
    let r = addin("POST", "/sync/v1/state").header("Content-Type", "application/json").body(vec![b' '; 2048]).send_head_first(h.port).await;
    assert_eq!(r.status, 413);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sidecar_window_shows_sync_and_the_log_shows_each_change() {
    let h = paired().await;
    let r = Req::new("POST", "/v1/sync/attach").json(json!({"client": "p", "direction": "app_follows"})).send(h.port).await;
    let s = r.json()["session"].as_str().unwrap().to_string();
    assert_eq!(addin("POST", "/sync/v1/state").json(json!({"cursor": {"lon": 1.0, "lat": 2.0, "visible": true}})).send(h.port).await.status, 200);
    let st = h.svc.sync.status();
    assert!(st.on);
    assert_eq!(st.addin.as_deref(), Some("ArcGIS Pro add-in"));
    assert_eq!(st.from_pro, 1);
    assert_eq!(Req::new("DELETE", &format!("/v1/sync/{s}")).send(h.port).await.status, 204);
    let log: Vec<String> = h.svc.log.lock().unwrap().iter().cloned().collect();
    assert!(log.iter().any(|l| l.contains("sync on for null")), "{log:?}");
    assert!(log.iter().any(|l| l.contains("sync off for null: 0 update(s) from the app, 1 from Pro")), "{log:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_is_on_the_list_of_features() {
    let h = start().await;
    let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
    assert_eq!(caps["features"]["pro_sync"], json!(true));
}
