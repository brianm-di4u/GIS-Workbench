//! The Python relay (REQ-GAP-02, SCN-61): the wire contract shared with the Python client, the
//! separation of relay tokens from page tokens, loopback and browser refusals, and what happens
//! when a client or a page goes away. The relay only passes messages: that writes become Proposals
//! is the page's rule, tested in tests/unit/relay-host.test.js and the e2e spec.

mod common;
use common::*;
use gwb_sidecar::relay::{self, RELAY_ORIGIN};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const CONTRACT: &str = include_str!("../../python/contract/relay-contract.json");
const CLIENT_NAME: &str = "contract script";

fn relay_req<'a>(method: &'a str, path: &'a str, token: Option<&'a str>) -> Req<'a> {
    Req::new(method, path).origin(None).token(token)
}

/// `@hex:N`, `@digits:N` and `@any` from the contract; everything else equal, objects by subset.
fn matches(want: &Value, got: &Value, at: &str) {
    match want {
        Value::String(s) if s == "@any" => assert!(!got.is_null(), "{at}: missing"),
        Value::String(s) if s.starts_with("@hex:") => {
            let n: usize = s[5..].parse().unwrap();
            let g = got.as_str().unwrap_or_else(|| panic!("{at}: not a string"));
            assert!(g.len() == n && g.bytes().all(|b| b.is_ascii_hexdigit()), "{at}: {g}");
        }
        Value::String(s) if s.starts_with("@digits:") => {
            let n: usize = s[8..].parse().unwrap();
            let g = got.as_str().unwrap_or_else(|| panic!("{at}: not a string"));
            assert!(g.len() == n && g.bytes().all(|b| b.is_ascii_digit()), "{at}: {g}");
        }
        Value::Object(o) => {
            for (k, v) in o {
                matches(v, &got[k], &format!("{at}.{k}"));
            }
        }
        Value::Array(a) => {
            assert_eq!(a.len(), got.as_array().map(|x| x.len()).unwrap_or(usize::MAX), "{at}: length");
            for (i, v) in a.iter().enumerate() {
                matches(v, &got[i], &format!("{at}[{i}]"));
            }
        }
        _ => assert_eq!(want, got, "{at}"),
    }
}

/// Fill the `@any` of a message the client sends (the version is the client's own).
fn concrete(v: &Value) -> Value {
    match v {
        Value::String(s) if s == "@any" => json!("0.0.0"),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), concrete(v))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(concrete).collect()),
        _ => v.clone(),
    }
}

async fn attach(h: &H) -> String {
    let r = Req::new("POST", "/v1/relay/attach").json(json!({"client": "test page"})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.json()["hold_s"], json!(25));
    r.json()["session"].as_str().unwrap().to_string()
}

/// Pair a relay client the way the sidecar window does.
async fn pair(h: &H, state: &str) -> (String, Option<String>) {
    let r = relay_req("POST", "/relay/v1/pair", None).json(json!({"client": CLIENT_NAME})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let id = r.json()["pairing_id"].as_str().unwrap().to_string();
    match state {
        "approved" => h.svc.pairings.decide(&id, true).unwrap(),
        "denied" => h.svc.pairings.decide(&id, false).unwrap(),
        _ => {}
    }
    (id, None)
}

async fn paired_token(h: &H) -> String {
    let (id, _) = pair(h, "approved").await;
    let r = relay_req("GET", &format!("/relay/v1/pair/{id}"), None).send(h.port).await;
    assert_eq!(r.json()["state"], json!("approved"));
    r.json()["token"].as_str().unwrap().to_string()
}

/// The page's side for one message: take it from the inbox, check it, answer with `reply`.
async fn page_answers(port: u16, session: String, want_client: String, want_message: Value, reply: Value) {
    let r = Req::new("GET", &format!("/v1/relay/{session}/inbox")).send(port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let d = r.json();
    assert_eq!(d["client"], json!(want_client));
    assert_eq!(d["message"], want_message);
    let r = Req::new("POST", &format!("/v1/relay/{session}/reply")).json(json!({"rid": d["rid"], "reply": reply})).send(port).await;
    assert_eq!(r.status, 204, "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_wire_contract() {
    let doc: Value = serde_json::from_str(CONTRACT).unwrap();
    let cases = doc["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let h = start().await;
        let token = paired_token(&h).await;
        let session = if case["setup"]["page"] == json!(true) { Some(attach(&h).await) } else { None };
        let pairing = match case["setup"]["pairing"].as_str() {
            Some(state) => {
                h.svc.pairings.revoke(RELAY_ORIGIN);
                Some(pair(&h, state).await.0)
            }
            None => None,
        };
        let rq = &case["request"];
        let path = rq["path"].as_str().unwrap().replace("@pairing", pairing.as_deref().unwrap_or(""));
        let mut req = relay_req(rq["method"].as_str().unwrap(), &path, rq["auth"].as_bool().unwrap().then_some(token.as_str()));
        let body = concrete(&rq["json"]);
        if !rq["json"].is_null() {
            req = req.json(body.clone());
        }
        if let Some(hs) = rq["headers"].as_object() {
            for (k, v) in hs {
                req = req.header(k.as_str(), v.as_str().unwrap().to_string());
            }
        }
        if let Some(host) = rq["host"].as_str() {
            req = req.host(host);
        }
        let page = case["page"].as_object().map(|p| {
            let s = session.clone().expect("a page case needs the page on");
            tokio::spawn(page_answers(h.port, s, p["client"].as_str().unwrap().to_string(), body.clone(), p["reply"].clone()))
        });
        let r = tokio::time::timeout(Duration::from_secs(20), req.send(h.port)).await.unwrap_or_else(|_| panic!("{name}: no answer"));
        assert_eq!(r.status as u64, case["response"]["status"].as_u64().unwrap(), "{name}: {}", r.text());
        if !case["response"]["json"].is_null() {
            matches(&case["response"]["json"], &r.json(), name);
        }
        if let Some(p) = page {
            p.await.unwrap();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_relay_token_opens_no_page_route_and_a_page_token_no_relay_route() {
    let h = start().await;
    let token = paired_token(&h).await;
    // The relay token against the API, with no Origin (the /app/ origin) and as a local file.
    for origin in [None, Some("null")] {
        for (m, p) in [("GET", "/v1/caps"), ("GET", "/v1/jobs"), ("GET", "/v1/files"), ("POST", "/v1/jobs"), ("POST", "/v1/pick"), ("POST", "/v1/relay/attach")] {
            let r = Req::new(m, p).origin(origin).token(Some(&token)).json(json!({})).send(h.port).await;
            assert_eq!(r.status, 401, "{m} {p}: {}", r.text());
        }
    }
    let r = Req::new("GET", "/ui/api/state").origin(None).token(Some(&token)).host(&format!("localhost:{}", h.port)).send(h.port).await;
    assert_eq!(r.status, 403);
    // The page's token on the client side.
    for tok in [TOKEN, "0".repeat(64).as_str()] {
        let r = relay_req("POST", "/relay/v1/mcp", Some(tok)).json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(h.port).await;
        assert_eq!(r.status, 401, "{}", r.text());
    }
    // The stored name cannot be asked for: an Origin header naming it is malformed.
    let r = Req::new("GET", "/v1/caps").origin(Some(RELAY_ORIGIN)).token(Some(&token)).send(h.port).await;
    assert_eq!(r.status, 400, "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn no_browser_reaches_the_client_side() {
    let h = start().await;
    let token = paired_token(&h).await;
    attach(&h).await;
    let app = format!("http://127.0.0.1:{}", h.port);
    for origin in ["null", HOSTED, app.as_str(), "https://evil.example"] {
        for m in ["GET", "POST", "OPTIONS", "DELETE"] {
            for p in ["/relay/v1/hello", "/relay/v1/pair", "/relay/v1/mcp"] {
                let r = Req::new(m, p).origin(Some(origin)).token(Some(&token)).header("Access-Control-Request-Method", "POST").json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(h.port).await;
                assert_eq!(r.status, 403, "{origin} {m} {p}");
                assert_eq!(r.json()["code"], json!("browser_refused"));
                assert!(r.header("access-control-allow-origin").is_none(), "no CORS for {origin}");
            }
        }
    }
    // Fetch metadata alone (a no-cors GET) is enough.
    let r = relay_req("GET", "/relay/v1/hello", None).header("Sec-Fetch-Site", "cross-site").send(h.port).await;
    assert_eq!(r.status, 403);
    // DNS rebinding: the Host rule comes first on this side too.
    for host in ["evil.example:80", "[::1]:1", "127.0.0.2:1"] {
        let r = relay_req("GET", "/relay/v1/hello", None).host(host).send(h.port).await;
        assert_eq!(r.status, 421, "{host}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_service_listens_on_loopback_only() {
    let (l, port) = gwb_sidecar::bind(&[0]).unwrap();
    let a = l.local_addr().unwrap();
    assert!(a.ip().is_loopback(), "{a}");
    assert_eq!(a.port(), port);
    // serve() takes this check first. Don't open a real listener on a wider address here: on
    // Windows that raises a firewall prompt on the desktop for each newly compiled test program.
    assert!(gwb_sidecar::require_loopback(Ok(a)).is_ok());
    assert!(gwb_sidecar::require_loopback(Ok("[::1]:47821".parse().unwrap())).is_ok());
    for wide in ["0.0.0.0:47821", "[::]:47821", "192.168.1.5:47821", "[2001:db8::1]:47821"] {
        assert!(gwb_sidecar::require_loopback(Ok(wide.parse().unwrap())).unwrap_err().contains("loopback"), "{wide}");
    }
    assert!(gwb_sidecar::require_loopback(Err(std::io::Error::other("no address"))).is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_attached_page_serves() {
    let h = start().await;
    let token = paired_token(&h).await;
    let call = json!({"jsonrpc": "2.0", "id": "a", "method": "ping"});
    // Off until a page asks: the relay never reaches a page that did not turn it on.
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(call.clone()).send(h.port).await;
    assert_eq!(r.json()["code"], json!("no_app"));
    let session = attach(&h).await;
    // A second page (another token of the same or another origin) cannot take it or read it.
    h.svc.pairings.add_token(HOSTED, &"a".repeat(64), "other page");
    let other = "a".repeat(64);
    let r = Req::new("POST", "/v1/relay/attach").origin(Some(HOSTED)).token(Some(&other)).json(json!({"client": "other"})).send(h.port).await;
    assert_eq!((r.status, r.json()["code"].clone()), (409, json!("relay_held")), "{}", r.text());
    let r = Req::new("GET", &format!("/v1/relay/{session}/inbox")).origin(Some(HOSTED)).token(Some(&other)).send(h.port).await;
    assert_eq!(r.status, 404);
    let r = Req::new("POST", &format!("/v1/relay/{session}/reply")).origin(Some(HOSTED)).token(Some(&other)).json(json!({"rid": "x", "reply": {}})).send(h.port).await;
    assert_eq!(r.status, 404);
    let r = Req::new("DELETE", &format!("/v1/relay/{session}")).origin(Some(HOSTED)).token(Some(&other)).send(h.port).await;
    assert_eq!(r.status, 404);
    // Malformed sessions and unknown calls.
    let r = Req::new("GET", "/v1/relay/nope/inbox").send(h.port).await;
    assert_eq!(r.status, 404);
    let r = Req::new("POST", &format!("/v1/relay/{session}/reply")).json(json!({"rid": "nope", "reply": {}})).send(h.port).await;
    assert_eq!(r.json()["code"], json!("no_such_call"));
    // Off again.
    let r = Req::new("DELETE", &format!("/v1/relay/{session}")).send(h.port).await;
    assert_eq!(r.status, 204);
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(call).send(h.port).await;
    assert_eq!(r.json()["code"], json!("no_app"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_hosted_page_and_the_apps_own_origin_can_attach() {
    let h = start().await;
    let app = format!("http://127.0.0.1:{}", h.port);
    let hosted = "b".repeat(64);
    h.svc.pairings.add_token(HOSTED, &hosted, "hosted page");
    let own = "c".repeat(64);
    h.svc.pairings.add_token(&app, &own, "/app/ page");
    for (origin, token) in [(HOSTED, hosted.as_str()), (app.as_str(), own.as_str())] {
        // The browser's preflight for the page's side passes, with CORS for that origin only.
        let r = Req::new("OPTIONS", "/v1/relay/attach").origin(Some(origin)).token(None).header("Access-Control-Request-Method", "POST").header("Access-Control-Request-Headers", "authorization, content-type").send(h.port).await;
        assert_eq!(r.status, 204, "{origin}");
        assert_eq!(r.header("access-control-allow-origin"), Some(origin));
        let r = Req::new("POST", "/v1/relay/attach").origin(Some(origin)).token(Some(token)).json(json!({"client": "page"})).send(h.port).await;
        assert_eq!(r.status, 200, "{origin}: {}", r.text());
        assert_eq!(r.header("access-control-allow-origin"), Some(origin));
        let s = r.json()["session"].as_str().unwrap().to_string();
        assert_eq!(h.svc.relay.status().origin.as_deref(), Some(origin));
        let r = Req::new("DELETE", &format!("/v1/relay/{s}")).origin(Some(origin)).token(Some(token)).send(h.port).await;
        assert_eq!(r.status, 204);
    }
    // An origin that is not allowed never gets as far as a token check.
    let r = Req::new("POST", "/v1/relay/attach").origin(Some("https://evil.example")).token(Some(&hosted)).json(json!({"client": "x"})).send(h.port).await;
    assert_eq!(r.status, 403);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_leaves_withdraws_its_call() {
    let h = start().await;
    let token = paired_token(&h).await;
    attach(&h).await;
    let body = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "gw2_graphics_delete", "arguments": {}}})).unwrap();
    let head = format!("POST /relay/v1/mcp HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", h.port, body.len());
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
    s.write_all(head.as_bytes()).await.unwrap();
    s.write_all(&body).await.unwrap();
    for _ in 0..100 {
        if h.svc.relay.status().outstanding == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.svc.relay.status().outstanding, 1);
    drop(s);
    for _ in 0..200 {
        if h.svc.relay.status().outstanding == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(h.svc.relay.status().outstanding, 0, "the call was not withdrawn");
}

#[tokio::test(flavor = "multi_thread")]
async fn calls_end_when_the_page_goes() {
    let h = start().await;
    let token = paired_token(&h).await;
    let session = attach(&h).await;
    let call = json!({"jsonrpc": "2.0", "id": 1, "method": "ping"});
    // The page turns it off while a call waits.
    let (port, t2, c2) = (h.port, token.clone(), call.clone());
    let w = tokio::spawn(async move { relay_req("POST", "/relay/v1/mcp", Some(&t2)).json(c2).send(port).await });
    tokio::time::sleep(Duration::from_millis(200)).await;
    Req::new("DELETE", &format!("/v1/relay/{session}")).send(h.port).await;
    assert_eq!(w.await.unwrap().json()["code"], json!("app_gone"));
    // The page stops polling: its session lapses and the call ends.
    h.svc.relay.set_limits(Duration::from_millis(300), Duration::from_secs(30));
    attach(&h).await;
    let t0 = std::time::Instant::now();
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(call.clone()).send(h.port).await;
    assert_eq!(r.json()["code"], json!("app_gone"), "{}", r.text());
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert!(!h.svc.relay.app_on());
    // The page answers too late.
    h.svc.relay.set_limits(relay::STALE, Duration::from_millis(100));
    attach(&h).await;
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(call).send(h.port).await;
    assert_eq!((r.status, r.json()["code"].clone()), (504, json!("relay_timeout")));
}

#[tokio::test(flavor = "multi_thread")]
async fn revoking_ends_it() {
    let h = start().await;
    let token = paired_token(&h).await;
    attach(&h).await;
    // The client's own forget.
    let r = relay_req("DELETE", "/relay/v1/pair", Some(&token)).send(h.port).await;
    assert_eq!(r.status, 204);
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(h.port).await;
    assert_eq!(r.status, 401);
    // "Revoke" in the sidecar window, by the name it lists.
    let token = paired_token(&h).await;
    assert!(h.svc.pairings.paired().iter().any(|(o, ..)| o == RELAY_ORIGIN));
    assert!(h.svc.pairings.revoke(RELAY_ORIGIN));
    let r = relay_req("GET", "/relay/v1/hello", Some(&token)).send(h.port).await;
    assert_eq!(r.json()["paired"], json!(false));
    // The page forgets its pairing: its relay goes with it.
    assert!(h.svc.relay.app_on());
    let r = Req::new("DELETE", "/v1/pair").send(h.port).await;
    assert_eq!(r.status, 204);
    assert!(!h.svc.relay.app_on());
}

#[tokio::test(flavor = "multi_thread")]
async fn sizes_and_queue_are_bounded() {
    let h = start().await;
    let token = paired_token(&h).await;
    attach(&h).await;
    let big = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"ping","params":{{"x":"{}"}}}}"#, "x".repeat(gwb_sidecar_api::MAX_RELAY_MESSAGE));
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).header("Content-Type", "application/json").body(big).send(h.port).await;
    assert_eq!(r.status, 413, "{}", r.text());
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).header("Content-Type", "text/plain").body(r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).send(h.port).await;
    assert_eq!(r.status, 415);
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).header("Content-Type", "application/json").body("{").send(h.port).await;
    assert_eq!(r.status, 400);
    let mut held = vec![];
    for _ in 0..relay::MAX_OUTSTANDING {
        let (port, t) = (h.port, token.clone());
        held.push(tokio::spawn(async move { relay_req("POST", "/relay/v1/mcp", Some(&t)).json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(port).await }));
    }
    for _ in 0..200 {
        if h.svc.relay.status().outstanding == relay::MAX_OUTSTANDING {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let r = relay_req("POST", "/relay/v1/mcp", Some(&token)).json(json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).send(h.port).await;
    assert_eq!((r.status, r.json()["code"].clone()), (429, json!("busy")));
    h.svc.relay.detach_where(|_, _| true);
    for w in held {
        assert_eq!(w.await.unwrap().json()["code"], json!("app_gone"));
    }
}

/// The relay's one new parser, under mutation: it never panics, and whatever it passes is one
/// request of the MCP server's list.
#[test]
fn check_message_fuzz() {
    let seeds: Vec<Vec<u8>> = [
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"gw2_layers_list","arguments":{"a":[1,2,{"b":null}]}}}"#,
        r#"{"jsonrpc":"2.0","id":"x","method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"[{"jsonrpc":"2.0","id":1,"method":"ping"}]"#,
    ]
    .iter()
    .map(|s| s.as_bytes().to_vec())
    .collect();
    let mut seed: u64 = 0x2545f4914f6cdd1d;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let (mut parsed, mut passed) = (0, 0);
    for _ in 0..200_000 {
        let mut b = seeds[(next() % seeds.len() as u64) as usize].clone();
        for _ in 0..1 + next() % 4 {
            let i = (next() % b.len() as u64) as usize;
            match next() % 4 {
                0 => b[i] = next() as u8,
                1 => b[i] = b"\"{}[]:,0\\"[(next() % 9) as usize],
                2 => {
                    b.remove(i);
                }
                _ => b.insert(i, next() as u8),
            }
            if b.is_empty() {
                b.push(b'{');
            }
        }
        let Ok(v) = serde_json::from_slice::<Value>(&b) else { continue };
        parsed += 1;
        if let Ok(c) = relay::check_message(v) {
            passed += 1;
            let m = c.value["method"].as_str().unwrap();
            assert!(relay::METHODS.contains(&m) || relay::NOTIFICATIONS.contains(&m), "{m}");
            assert_eq!(c.notification, c.value.get("id").is_none_or(Value::is_null));
            assert!(c.label.chars().all(|ch| !ch.is_control()));
        }
    }
    assert!(parsed > 1000 && passed > 100, "the mutation reached too little: {parsed} parsed, {passed} passed");
}
