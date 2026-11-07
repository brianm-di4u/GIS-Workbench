//! Sidecar security suite (SDP-2.1 §7.3, REQ-SDC-03/04/06/07): Host, Origin, token, DNS rebinding,
//! CORS and LNA preflights, path traversal, argument injection through every profile option,
//! HTTP fuzzing of every route, oversized bodies, cancel/kill mid-job, disk full, concurrent jobs,
//! no output on failure, pairing, the sidecar window's secret, `/app/` hash check.

mod common;
use common::*;
use serde_json::json;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn host_header_and_dns_rebinding() {
    let h = start().await;
    let ok = Req::new("GET", "/v1/hello").send(h.port).await;
    assert_eq!(ok.status, 200);
    for host in ["evil.example", "evil.example:80", &format!("evil.example:{}", h.port), &format!("127.0.0.1.nip.io:{}", h.port), &format!("127.0.0.2:{}", h.port), "127.0.0.1", &format!("[::1]:{}", h.port), &format!("0x7f000001:{}", h.port), &format!("localhost.:{}", h.port)] {
        let r = Req::new("GET", "/v1/hello").host(host).send(h.port).await;
        assert_eq!(r.status, 421, "Host {host} must be refused");
        assert!(r.header("access-control-allow-origin").is_none(), "no CORS on a refused Host");
    }
    // Two Host headers.
    let r = raw(h.port, format!("GET /v1/hello HTTP/1.1\r\nHost: 127.0.0.1:{0}\r\nHost: evil.example\r\nOrigin: null\r\nConnection: close\r\n\r\n", h.port).as_bytes()).await;
    assert!(r.status == 421 || r.status == 400, "double Host: {}", r.status);
    // No Host at all (HTTP/1.0).
    let r = raw(h.port, b"GET /v1/hello HTTP/1.0\r\nOrigin: null\r\n\r\n").await;
    assert!(r.status == 421 || r.status == 400, "no Host: {}", r.status);
}

#[tokio::test(flavor = "multi_thread")]
async fn origin_allow_list_and_cors() {
    let h = start().await;
    let r = Req::new("GET", "/v1/caps").send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("access-control-allow-origin"), Some("null"));
    assert!(r.header("vary").unwrap_or("").contains("Origin"));
    for bad in ["https://evil.example", "http://gwb.example", "https://gwb.example.evil.com", "https://sub.gwb.example", "file://", "chrome-extension://abc", "http://localhost:1", "https://GWB.example/path"] {
        let r = Req::new("GET", "/v1/hello").origin(Some(bad)).token(None).send(h.port).await;
        assert!(r.status == 403 || r.status == 400, "{bad}: {}", r.status);
        assert!(r.header("access-control-allow-origin").is_none(), "{bad} must get no CORS header");
    }
    // The configured hosted origin may ask; the sidecar window's origin may not use the API.
    let r = Req::new("GET", "/v1/hello").origin(Some(HOSTED)).token(None).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["paired"], json!(false));
    assert_eq!(r.header("access-control-allow-origin"), Some(HOSTED));
    let r = Req::new("GET", "/v1/hello").origin(Some(&format!("http://localhost:{}", h.port))).token(None).send(h.port).await;
    assert_eq!(r.status, 403);
    // The sidecar's own /app/ origin is allowed.
    let app = format!("http://127.0.0.1:{}", h.port);
    let r = Req::new("GET", "/v1/hello").origin(Some(&app)).token(None).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("access-control-allow-origin"), Some(app.as_str()));
    // No Origin (same-origin GET from /app/) counts as the /app/ origin.
    let r = Req::new("GET", "/v1/hello").origin(None).token(None).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.json()["origin"], json!(app));
    // Two Origin headers.
    let r = Req::new("GET", "/v1/hello").header("Origin", HOSTED).send(h.port).await;
    assert_eq!(r.status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn preflights_private_and_local_network_access() {
    let h = start().await;
    let r = Req::new("OPTIONS", "/v1/files?name=x").token(None).header("Access-Control-Request-Method", "PUT").header("Access-Control-Request-Headers", "authorization, content-type").header("Access-Control-Request-Private-Network", "true").header("Access-Control-Request-Local-Network", "true").send(h.port).await;
    assert_eq!(r.status, 204);
    assert_eq!(r.header("access-control-allow-origin"), Some("null"));
    assert_eq!(r.header("access-control-allow-private-network"), Some("true"));
    assert_eq!(r.header("access-control-allow-local-network"), Some("true"));
    assert!(r.header("access-control-allow-methods").unwrap().contains("PUT"));
    assert!(r.header("access-control-allow-headers").unwrap().to_ascii_lowercase().contains("authorization"));
    let r = Req::new("OPTIONS", "/v1/jobs").token(None).header("Access-Control-Request-Method", "PATCH").send(h.port).await;
    assert_eq!(r.status, 403);
    let r = Req::new("OPTIONS", "/v1/jobs").token(None).header("Access-Control-Request-Method", "POST").header("Access-Control-Request-Headers", "x-evil").send(h.port).await;
    assert_eq!(r.status, 403);
    let r = Req::new("OPTIONS", "/v1/jobs").origin(Some("https://evil.example")).token(None).header("Access-Control-Request-Method", "POST").send(h.port).await;
    assert_eq!(r.status, 403);
    assert!(r.header("access-control-allow-origin").is_none());
    // No Private-Network grant unless asked.
    let r = Req::new("OPTIONS", "/v1/caps").token(None).header("Access-Control-Request-Method", "GET").send(h.port).await;
    assert!(r.header("access-control-allow-private-network").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn tokens() {
    let h = start().await;
    for (t, want) in [(None, 401), (Some("x"), 401), (Some(&TOKEN[..63]), 401), (Some("ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"), 401), (Some(TOKEN), 200)] {
        let r = Req::new("GET", "/v1/caps").token(t).send(h.port).await;
        assert_eq!(r.status, want, "token {t:?}");
    }
    // A token is bound to its origin.
    let r = Req::new("GET", "/v1/caps").origin(Some(HOSTED)).send(h.port).await;
    assert_eq!(r.status, 401);
    // Every protected route refuses without a token.
    for (m, p) in [("GET", "/v1/caps"), ("GET", "/v1/jobs"), ("POST", "/v1/jobs"), ("GET", "/v1/files"), ("PUT", "/v1/files?name=a"), ("POST", "/v1/pick"), ("POST", "/v1/batch"), ("DELETE", "/v1/pair"), ("GET", "/v1/files/0123456789abcdef0123456789abcdef"), ("GET", "/v1/caps/drivers/GTiff"), ("POST", "/v1/views"), ("GET", "/v1/views/0123456789abcdef01234567"), ("DELETE", "/v1/views/0123456789abcdef01234567")] {
        let r = Req::new(m, p).token(None).send(h.port).await;
        assert_eq!(r.status, 401, "{m} {p}");
        assert_eq!(r.header("access-control-allow-origin"), Some("null"), "401s are readable by the app");
    }
    // Basic auth, lower-case scheme, two Authorization headers.
    let r = Req::new("GET", "/v1/caps").token(None).header("Authorization", format!("Basic {TOKEN}")).send(h.port).await;
    assert_eq!(r.status, 401);
    let r = Req::new("GET", "/v1/caps").header("Authorization", format!("Bearer {TOKEN}")).send(h.port).await;
    assert_eq!(r.status, 401);
}

async fn ui_session(h: &H) -> String {
    let code = h.svc.new_launch_code();
    let r = Req::new("POST", "/ui/api/session").host(&format!("localhost:{}", h.port)).origin(Some(&format!("http://localhost:{}", h.port))).token(None).json(json!({"launch": code})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    r.json()["secret"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn pairing_flow() {
    let h = start().await;
    let r = Req::new("POST", "/v1/pair").origin(Some(HOSTED)).token(None).json(json!({"client": "GIS Workbench test"})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let start = r.json();
    let pid = start["pairing_id"].as_str().unwrap().to_string();
    let code = start["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 6);
    let poll = |o: &'static str| {
        let pid = pid.clone();
        let port = h.port;
        async move { Req::new("GET", &format!("/v1/pair/{pid}")).origin(Some(o)).token(None).send(port).await }
    };
    assert_eq!(poll(HOSTED).await.json()["state"], "pending");
    // Another origin cannot see it.
    assert_eq!(poll("null").await.status, 404);
    // The window shows the same code; approve with the window's secret.
    let secret = ui_session(&h).await;
    let lh = format!("localhost:{}", h.port);
    let lo = format!("http://localhost:{}", h.port);
    let st = Req::new("GET", "/ui/api/state").host(&lh).origin(None).token(None).header("X-Gwb-Admin", secret.clone()).send(h.port).await;
    assert_eq!(st.status, 200);
    let pend = st.json()["pending"].clone();
    assert_eq!(pend[0]["code"], json!(code));
    assert_eq!(pend[0]["origin"], json!(HOSTED));
    // Approving needs the secret, the window's origin and Host.
    let body = json!({"id": pid, "approve": true});
    for (host, origin, sec) in [(lh.as_str(), lo.as_str(), "wrong"), (lh.as_str(), "https://evil.example", secret.as_str()), (&*format!("127.0.0.1:{}", h.port), lo.as_str(), secret.as_str())] {
        let r = Req::new("POST", "/ui/api/decide").host(host).origin(Some(origin)).token(None).header("X-Gwb-Admin", sec.to_string()).json(body.clone()).send(h.port).await;
        assert!(r.status == 403 || r.status == 404, "decide via {host}/{origin} → {}", r.status);
    }
    let r = Req::new("POST", "/ui/api/decide").host(&lh).origin(Some(&lo)).token(None).header("X-Gwb-Admin", secret.clone()).json(body).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let got = poll(HOSTED).await.json();
    assert_eq!(got["state"], "approved");
    let token = got["token"].as_str().unwrap().to_string();
    assert!(poll(HOSTED).await.json()["token"].is_null(), "the token is handed over once");
    let r = Req::new("GET", "/v1/caps").origin(Some(HOSTED)).token(Some(&token)).send(h.port).await;
    assert_eq!(r.status, 200);
    // Forget sidecar: the token stops working.
    let r = Req::new("DELETE", "/v1/pair").origin(Some(HOSTED)).token(Some(&token)).send(h.port).await;
    assert_eq!(r.status, 204);
    let r = Req::new("GET", "/v1/caps").origin(Some(HOSTED)).token(Some(&token)).send(h.port).await;
    assert_eq!(r.status, 401);
    // Revocation from the window.
    let r = Req::new("POST", "/ui/api/revoke").host(&lh).origin(Some(&lo)).token(None).header("X-Gwb-Admin", secret.clone()).json(json!({"origin": "null"})).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(Req::new("GET", "/v1/caps").send(h.port).await.status, 401);
    // Pairing-request flooding is bounded.
    let mut busy = false;
    for _ in 0..5 {
        let r = Req::new("POST", "/v1/pair").origin(Some(HOSTED)).token(None).json(json!({"client": "x"})).send(h.port).await;
        busy |= r.status == 429;
    }
    assert!(busy);
}

#[tokio::test(flavor = "multi_thread")]
async fn sidecar_window_secret() {
    let h = start().await;
    let lh = format!("localhost:{}", h.port);
    // The page itself is served only on localhost:<port>, framing forbidden.
    let r = Req::new("GET", "/ui/").host(&lh).origin(None).token(None).send(h.port).await;
    assert_eq!(r.status, 200);
    assert!(r.header("content-security-policy").unwrap().contains("frame-ancestors 'none'"));
    assert_eq!(Req::new("GET", "/ui/").origin(None).token(None).send(h.port).await.status, 404);
    // State needs the secret.
    assert_eq!(Req::new("GET", "/ui/api/state").host(&lh).origin(None).token(None).send(h.port).await.status, 403);
    // A launch code works once.
    let code = h.svc.new_launch_code();
    let mk = |c: String| Req::new("POST", "/ui/api/session").host(&lh).origin(Some("")).token(None).json(json!({"launch": c}));
    let lo = format!("http://localhost:{}", h.port);
    let r1 = Req::new("POST", "/ui/api/session").host(&lh).origin(Some(&lo)).token(None).json(json!({"launch": code.clone()})).send(h.port).await;
    assert_eq!(r1.status, 200);
    let r2 = Req::new("POST", "/ui/api/session").host(&lh).origin(Some(&lo)).token(None).json(json!({"launch": code})).send(h.port).await;
    assert_eq!(r2.status, 403);
    let _ = mk;
    // A cross-site page cannot trade a code.
    let c3 = h.svc.new_launch_code();
    let r3 = Req::new("POST", "/ui/api/session").host(&lh).origin(Some("https://evil.example")).token(None).json(json!({"launch": c3})).send(h.port).await;
    assert_eq!(r3.status, 403);
    // The launch endpoint wants the key file's key and no page origin.
    let r = Req::new("POST", "/ui/api/launch").host(&lh).origin(None).token(None).header("X-Gwb-Key", "bad").send(h.port).await;
    assert_eq!(r.status, 403);
    let r = Req::new("POST", "/ui/api/launch").host(&lh).origin(Some(&lo)).token(None).header("X-Gwb-Key", h.svc.admin.key.clone()).send(h.port).await;
    assert_eq!(r.status, 403);
    let r = Req::new("POST", "/ui/api/launch").host(&lh).origin(None).token(None).header("X-Gwb-Key", h.svc.admin.key.clone()).send(h.port).await;
    assert_eq!(r.status, 200);
    assert!(r.json()["url"].as_str().unwrap().starts_with(&format!("http://localhost:{}/ui/?launch=", h.port)));
}

#[tokio::test(flavor = "multi_thread")]
async fn path_traversal_and_names() {
    let h = start().await;
    for name in ["..\\..\\x.sid", "../x", "a/b", "a\\b", "C:x", "x:ads", "CON", "nul.tif", "COM1.sid", "x.", "x ", "", "\u{0}x", "a\u{202e}b"] {
        let r = Req::new("PUT", &format!("/v1/files?name={}", urlenc(name))).body(b"x".to_vec()).send(h.port).await;
        assert_eq!(r.status, 400, "name {name:?}: {}", r.text());
    }
    // Ids are opaque hex; anything else is not found (and never a path).
    for p in ["/v1/files/..%2F..%2Fpairings.json", "/v1/files/../pairings.json", "/v1/files/C:%5CWindows%5Cwin.ini", "/v1/files/%5C%5Cserver%5Cshare", "/v1/jobs/..%2F..", "/v1/files/0123456789abcdef0123456789abcdeZ", "/v1/views/..%2F..%2Fpairings.json"] {
        let r = Req::new("GET", p).send(h.port).await;
        assert!(r.status == 404 || r.status == 400, "{p}: {}", r.status);
        assert!(!r.text().contains("tokens"), "{p} leaked the pairing store");
    }
    // A group id of another origin cannot be joined.
    let r = Req::new("PUT", "/v1/files?name=a.bin").body(b"a".to_vec()).send(h.port).await;
    let g = r.json()["group"].as_str().unwrap().to_string();
    let r = Req::new("PUT", &format!("/v1/files?name=b.bin&group={g}")).origin(Some(HOSTED)).send(h.port).await;
    assert_eq!(r.status, 401);
    let r = Req::new("PUT", "/v1/files?name=b.bin&group=../../x").body(b"b".to_vec()).send(h.port).await;
    assert_eq!(r.status, 400);
    // Same name twice in a group.
    let r = Req::new("PUT", &format!("/v1/files?name=a.bin&group={g}")).body(b"a".to_vec()).send(h.port).await;
    assert_eq!(r.status, 409);
    // Unknown query fields are refused.
    let r = Req::new("PUT", "/v1/files?name=c.bin&path=C:/x").body(b"c".to_vec()).send(h.port).await;
    assert_eq!(r.status, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn pointer_inputs_are_refused() {
    let h = start().await;
    let vrt = upload(&h, "evil.xml", b"<VRTDataset rasterXSize='1' rasterYSize='1'><VRTRasterBand><SimpleSource><SourceFilename>C:\\Users\\victim\\secret.tif</SourceFilename></SimpleSource></VRTRasterBand></VRTDataset>").await;
    let r = job(&h, "raster-cog", &[&vrt], json!({})).await;
    assert_eq!(r.status, 422, "{}", r.text());
    let url = upload(&h, "x.vrt", b"/vsicurl/https://evil.example/x.tif").await;
    assert_eq!(job(&h, "raster-cog", &[&url], json!({})).await.status, 422);
}

/// Every option of every profile, with hostile values.
#[tokio::test(flavor = "multi_thread")]
async fn argument_injection_through_every_profile_option() {
    let h = start().await;
    let input = upload(&h, "in.tif", b"OK").await;
    let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
    let hostile = [json!("x; calc.exe"), json!("DEFLATE -of VRT"), json!("$(whoami)"), json!("`id`"), json!("|cmd /c calc"), json!("&& del C:\\x"), json!("\"quoted\" arg"), json!("-co"), json!("--config GDAL_HTTP_PROXY x"), json!("C:\\Windows\\System32\\calc.exe"), json!("\\\\server\\share\\x"), json!("/vsicurl/http://evil/"), json!("a\nb"), json!(1e308), json!(-1e308), json!(f64::MAX), json!("NaN"), json!(null), json!([1, 2]), json!({"a": 1}), json!(true), json!(-99999999999i64), json!(99999999999i64), json!("EPSG:4326 -t_srs EPSG:3857"), json!("EPSG:-1"), json!(""), json!("x".repeat(70000))];
    let mut checked = 0;
    for p in caps["profiles"].as_array().unwrap() {
        let id = p["id"].as_str().unwrap();
        // A gated profile refuses before it looks at anything (gated_profiles_stay_off below).
        if !p["available"].as_bool().unwrap() {
            continue;
        }
        // As many inputs as the profile takes, so the option is what gets refused.
        let n = p["min_inputs"].as_u64().unwrap().max(1) as usize;
        let inputs: Vec<&str> = vec![input.as_str(); n];
        for o in p["options"].as_array().unwrap() {
            let name = o["name"].as_str().unwrap();
            let values: Vec<String> = o["values"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
            for v in &hostile {
                // A hostile value that happens to be valid for this option (true for a bool, null for an
                // optional one) is not an injection; skip those.
                let valid = match o["type"].as_str().unwrap() {
                    "bool" => v.is_boolean(),
                    "enum" => v.as_str().is_some_and(|s| values.iter().any(|x| x == s)),
                    "int" | "float" => v.is_number() && v.as_f64().is_some_and(|f| f >= o["min"].as_f64().unwrap_or(f64::MIN) && f <= o["max"].as_f64().unwrap_or(f64::MAX) && (o["type"] == "float" || v.is_i64())),
                    "creation_options" => v.as_array().is_some_and(|a| a.is_empty()),
                    "float_list" => v.as_array().is_some_and(|a| !a.is_empty() && a.iter().all(|x| x.is_number())),
                    _ => false,
                } || v.is_null();
                if valid {
                    continue;
                }
                let mut opts = serde_json::Map::new();
                if id.starts_with("export-") && name != "driver" {
                    opts.insert("driver".into(), json!("GTiff"));
                }
                opts.insert(name.into(), v.clone());
                let r = job(&h, id, &inputs, serde_json::Value::Object(opts)).await;
                assert!(r.status == 400 || r.status == 413, "{id}.{name} = {v}: accepted ({} {})", r.status, r.text());
                checked += 1;
            }
        }
        // Unknown options, too many inputs, wrong input ids.
        assert_eq!(job(&h, id, &inputs, json!({"shell": "cmd"})).await.status, 400, "{id}: unknown option");
        assert_eq!(job(&h, id, &vec!["../../x"; n], json!({})).await.status, 404);
    }
    assert!(checked > 200, "only {checked} cases");
    // A valid value reaches the tool as exactly one argument.
    // The fake tool's side file goes in a Low-labelled folder (tools run at Low integrity).
    let argfile = low_dir(&h.dir).join("args.txt");
    let echo = upload(&h, "echo.tif", format!("ECHOARGS {}", argfile.display()).as_bytes()).await;
    let r = job(&h, "export-gdal", &[&echo], json!({"driver": "GTiff", "co": ["COMPRESS=LZW", "ZLEVEL=9", "TITLE=a b; c -of VRT"]})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let j = wait(&h, r.json()["id"].as_str().unwrap()).await;
    assert_eq!(j["state"], "succeeded", "{j}");
    let args = std::fs::read_to_string(&argfile).unwrap();
    let lines: Vec<&str> = args.lines().collect();
    assert!(lines.contains(&"TITLE=a b; c -of VRT"), "{lines:?}");
    assert_eq!(lines.iter().filter(|l| **l == "-of").count(), 1, "{lines:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn gated_profiles_stay_off() {
    // OD-2.17: a tool that opens a database connection stays off in shipped builds. The test flag
    // alone does nothing outside a GWB_SIDECAR_TEST run, and config.toml has no such key.
    for on in [false, true] {
        let h = start_with(|c| c.test_allow_database = on).await;
        let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
        let p = caps["profiles"].as_array().unwrap().iter().find(|p| p["id"] == "pgraster-cog").unwrap().clone();
        assert_eq!(p["available"], json!(false));
        let r = job(&h, "pgraster-cog", &[], json!({"dbname": "gis", "user": "u", "table": "t"})).await;
        assert_eq!(r.status, 403, "{}", r.text());
        assert!(r.text().contains("external security review"), "{}", r.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn csm_host_stays_off() {
    // OD-2.18: third-party plug-ins stay off in shipped builds. Outside a test run the test field
    // does nothing. tests/csmgate.rs repeats this inside one, for a build without the feature.
    assert!(std::env::var("GWB_SIDECAR_TEST").is_err(), "this suite runs without GWB_SIDECAR_TEST");
    for on in [false, true] {
        let h = start_with(|c| c.test_allow_csm = on).await;
        let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
        assert_eq!(caps["csm_host"]["available"], json!(false));
        assert!(caps["csm_host"]["note"].as_str().unwrap().contains("external security review"));
        for (m, p) in [("GET", "/v1/csm"), ("GET", "/v1/csm/plugins"), ("POST", "/v1/csm/plugins"), ("POST", "/v1/csm/sessions"), ("POST", "/v1/csm/sessions/abc/g2i"), ("POST", "/v1/csm/sessions/abc/i2g"), ("POST", "/v1/csm/sessions/abc/partials"), ("POST", "/v1/csm/sessions/abc/covariance"), ("DELETE", "/v1/csm/sessions/abc")] {
            let r = Req::new(m, p).json(json!({})).send(h.port).await;
            assert_eq!(r.status, 403, "{m} {p}: {}", r.text());
            assert_eq!(r.json()["code"], json!("csm_off"), "{m} {p}");
            assert!(r.text().contains("external security review"), "{}", r.text());
        }
        let lh = format!("localhost:{}", h.port);
        let r = Req::new("POST", "/ui/api/csm/decide").host(&lh).origin(None).token(None).json(json!({"sha256": "0", "approve": true})).send(h.port).await;
        assert_eq!(r.status, 403, "{}", r.text());
        assert_eq!(r.json()["code"], json!("csm_off"));
        // No token, no way in either, and the refusal gives the same answer it would for a stranger.
        assert_eq!(Req::new("GET", "/v1/csm/plugins").token(None).send(h.port).await.status, 401);
        assert!(!h.dir.join("data").join("csm").exists(), "nothing of the host is even created");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_two_input_profile_counts_its_inputs() {
    let h = start().await;
    let a = upload(&h, "pan.tif", b"OK").await;
    let r = job(&h, "raster-pansharpen", &[&a], json!({})).await;
    assert_eq!(r.status, 400);
    assert!(r.text().contains("2"), "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_and_malformed_bodies() {
    let h = start_with(|c| c.max_upload = 1 << 20).await;
    let big = vec![b' '; 70 * 1024];
    let r = Req::new("POST", "/v1/jobs").header("Content-Type", "application/json").body(big).send_head_first(h.port).await;
    assert_eq!(r.status, 413);
    let r = Req::new("POST", "/v1/jobs").header("Content-Type", "text/plain").body(b"{}".to_vec()).send(h.port).await;
    assert_eq!(r.status, 415);
    for b in ["{", "[]", "null", "{\"profile\":1}", "{\"profile\":\"probe\",\"inputs\":\"x\"}", "{\"profile\":\"probe\",\"inputs\":[],\"extra\":1}"] {
        let r = Req::new("POST", "/v1/jobs").header("Content-Type", "application/json").body(b.as_bytes().to_vec()).send(h.port).await;
        assert!(r.status == 400 || r.status == 404, "{b}: {}", r.status);
    }
    let r = Req::new("PUT", "/v1/files?name=big.bin").body(vec![0u8; 2 << 20]).send_head_first(h.port).await;
    assert_eq!(r.status, 413);
    assert!(Req::new("GET", "/v1/files").send(h.port).await.json().as_array().unwrap().is_empty(), "no partial upload is kept");
    // A Content-Length that lies (shorter body, connection closed): no file appears.
    let _ = raw(h.port, format!("PUT /v1/files?name=lie.bin HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: null\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 1000\r\n\r\nshort", h.port).as_bytes()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(Req::new("GET", "/v1/files").send(h.port).await.json().as_array().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn disk_full_upload_and_job() {
    let h = start_with(|c| c.quota_bytes = 3 << 20).await;
    let r = Req::new("PUT", "/v1/files?name=a.bin").body(vec![1u8; 4 << 20]).send_head_first(h.port).await;
    assert_eq!(r.status, 507, "{}", r.text());
    // A job whose output outgrows the space left is stopped, and leaves nothing.
    let w = upload(&h, "w.tif", b"WRITE 20000000").await;
    let r = job(&h, "raster-cog", &[&w], json!({})).await;
    let j = wait(&h, r.json()["id"].as_str().unwrap()).await;
    assert_eq!(j["state"], "failed", "{j}");
    assert!(j["error"].as_str().unwrap().contains("space"), "{j}");
    assert!(j["outputs"].as_array().unwrap().is_empty());
    let outs = std::fs::read_dir(h.svc.cfg.data_dir.join("outputs")).unwrap().count();
    assert_eq!(outs, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_kills_the_process_tree() {
    let h = start().await;
    let pidfile = low_dir(&h.dir).join("pids.txt");
    let s = upload(&h, "spawn.tif", format!("SPAWN {}", pidfile.display()).as_bytes()).await;
    let r = job(&h, "raster-cog", &[&s], json!({})).await;
    let id = r.json()["id"].as_str().unwrap().to_string();
    for _ in 0..100 {
        if pidfile.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let pids: Vec<u32> = std::fs::read_to_string(&pidfile).unwrap().lines().filter_map(|l| l.parse().ok()).collect();
    assert_eq!(pids.len(), 2);
    assert!(pids.iter().all(|p| alive(*p)));
    let r = Req::new("DELETE", &format!("/v1/jobs/{id}")).send(h.port).await;
    assert_eq!(r.status, 202);
    let j = wait(&h, &id).await;
    assert_eq!(j["state"], "cancelled");
    tokio::time::sleep(Duration::from_millis(500)).await;
    for p in &pids {
        assert!(!alive(*p), "process {p} survived the cancel");
    }
    assert!(j["outputs"].as_array().unwrap().is_empty());
    assert!(!h.svc.cfg.data_dir.join("jobs").join(&id).exists(), "the job folder is removed");
    // Retry of a cancelled job is a new job.
    let r = Req::new("POST", &format!("/v1/jobs/{id}/retry")).send(h.port).await;
    assert_eq!(r.status, 201);
    let nid = r.json()["id"].as_str().unwrap().to_string();
    assert_eq!(r.json()["retry_of"], json!(id));
    Req::new("DELETE", &format!("/v1/jobs/{nid}")).send(h.port).await;
    wait(&h, &nid).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn no_output_on_failure() {
    let h = start().await;
    let f = upload(&h, "fail.tif", b"FAIL").await;
    let r = job(&h, "raster-cog", &[&f], json!({})).await;
    let j = wait(&h, r.json()["id"].as_str().unwrap()).await;
    assert_eq!(j["state"], "failed");
    assert!(j["error"].as_str().unwrap().contains("fake failure"), "{j}");
    assert!(j["outputs"].as_array().unwrap().is_empty());
    let files = Req::new("GET", "/v1/files").send(h.port).await.json();
    assert_eq!(files.as_array().unwrap().len(), 1, "only the upload: {files}");
    assert_eq!(std::fs::read_dir(h.svc.cfg.data_dir.join("outputs")).unwrap().count(), 0);
    // Log and events are readable after the fact.
    let id = j["id"].as_str().unwrap();
    let log = Req::new("GET", &format!("/v1/jobs/{id}/log")).send(h.port).await.text();
    assert!(log.contains("$ gdal_translate"));
    let ev = Req::new("GET", &format!("/v1/jobs/{id}/events")).send(h.port).await;
    assert_eq!(ev.header("content-type"), Some("application/x-ndjson"));
    let last: serde_json::Value = serde_json::from_str(ev.text().lines().filter(|l| !l.trim().is_empty()).last().unwrap()).unwrap();
    assert_eq!(last["type"], "done");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_jobs_respect_the_limit() {
    let h = start_with(|c| c.concurrent_jobs = 2).await;
    let s = upload(&h, "sleep.tif", b"SLEEP 2").await;
    let mut ids = vec![];
    for _ in 0..6 {
        ids.push(job(&h, "raster-cog", &[&s], json!({})).await.json()["id"].as_str().unwrap().to_string());
    }
    let mut max = 0;
    for _ in 0..80 {
        max = max.max(h.svc.jobs.running_count());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for id in &ids {
        let j = wait(&h, id).await;
        assert_eq!(j["state"], "succeeded", "{j}");
        assert_eq!(j["outputs"].as_array().unwrap().len(), 2, "output + provenance");
    }
    assert!(max >= 1 && max <= 2, "at most two at once, saw {max}");
}

#[tokio::test(flavor = "multi_thread")]
async fn files_are_private_to_their_origin_and_ranges() {
    let h = start().await;
    let id = upload(&h, "r.bin", b"0123456789").await;
    let path = format!("/v1/files/{id}");
    let get = |range: Option<&str>| {
        let mut r = Req::new("GET", &path);
        if let Some(x) = range {
            r = r.header("Range", x.to_string());
        }
        r
    };
    let r = get(Some("bytes=2-4")).send(h.port).await;
    assert_eq!((r.status, r.text().as_str(), r.header("content-range")), (206, "234", Some("bytes 2-4/10")));
    assert_eq!(get(Some("bytes=-3")).send(h.port).await.text(), "789");
    assert_eq!(get(None).send(h.port).await.text(), "0123456789");
    for bad in ["bytes=10-", "bytes=5-2", "bytes=0-1,4-5", "lines=1-2", "bytes=abc"] {
        let r = get(Some(bad)).send(h.port).await;
        assert_eq!(r.status, 416, "{bad}");
        assert_eq!(r.header("content-range"), Some("bytes */10"));
    }
    let r = Req::new("HEAD", &format!("/v1/files/{id}")).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-length"), Some("10"));
    // Another (paired) origin sees nothing.
    h.svc.pairings.add_token(HOSTED, &"f".repeat(64), "t");
    let other = "f".repeat(64);
    let r = Req::new("GET", &format!("/v1/files/{id}")).origin(Some(HOSTED)).token(Some(&other)).send(h.port).await;
    assert_eq!(r.status, 404);
    let r = Req::new("DELETE", &format!("/v1/files/{id}")).origin(Some(HOSTED)).token(Some(&other)).send(h.port).await;
    assert_eq!(r.status, 404);
    assert!(Req::new("GET", "/v1/files").origin(Some(HOSTED)).token(Some(&other)).send(h.port).await.json().as_array().unwrap().is_empty());
    let r = job(&h, "probe", &[&id], json!({})).await;
    assert_eq!(r.status, 201);
    let r = Req::new("POST", "/v1/jobs").origin(Some(HOSTED)).token(Some(&other)).json(json!({"profile": "probe", "inputs": [id]})).send(h.port).await;
    assert_eq!(r.status, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn app_fallback_is_hash_checked() {
    let h = start().await;
    let r = Req::new("GET", "/app/").origin(None).token(None).send(h.port).await;
    assert_eq!(r.status, 503);
    std::fs::create_dir_all(&h.svc.cfg.app_dir).unwrap();
    let html = b"<!DOCTYPE html><title>GIS Workbench</title>";
    std::fs::write(h.svc.cfg.app_dir.join("gis-workbench.html"), html).unwrap();
    std::fs::write(h.svc.cfg.app_dir.join("SHA256SUMS"), format!("{}  gis-workbench.html\n", gwb_sidecar::util::sha256_hex(html))).unwrap();
    let r = Req::new("GET", "/app/").origin(None).token(None).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body, html);
    // Not on localhost (that is the window's origin), not with POST, not other names.
    assert_eq!(Req::new("GET", "/app/").host(&format!("localhost:{}", h.port)).origin(None).token(None).send(h.port).await.status, 404);
    assert_eq!(Req::new("POST", "/app/").origin(None).token(None).send(h.port).await.status, 405);
    assert_eq!(Req::new("GET", "/app/..%2Fpairings.json").origin(None).token(None).send(h.port).await.status, 404);
    std::fs::write(h.svc.cfg.app_dir.join("gis-workbench.html"), b"<script>evil()</script>").unwrap();
    assert_eq!(Req::new("GET", "/app/").origin(None).token(None).send(h.port).await.status, 503);
}

/// Random requests against every route: the service never panics, never answers 5xx for a
/// client mistake, and keeps serving.
#[tokio::test(flavor = "multi_thread")]
async fn http_fuzz_every_route() {
    let h = start().await;
    let fid = upload(&h, "f.bin", b"abc").await;
    let routes = ["/v1/hello", "/v1/pair", "/v1/pair/0123", "/v1/caps", "/v1/caps/drivers/GTiff", "/v1/caps/drivers/%00", "/v1/jobs", "/v1/jobs/aaaaaaaaaaaaaaaaaaaaaaaa", "/v1/jobs/x/events", "/v1/jobs/x/log", "/v1/jobs/x/retry", "/v1/batch", "/v1/pick", "/v1/files", "/v1/files/{fid}", "/v1/files/{fid}/save", "/app/", "/app/lite", "/ui/", "/ui/api/state", "/ui/api/decide", "/relay/v1/hello", "/relay/v1/pair", "/relay/v1/pair/0123", "/relay/v1/mcp", "/relay", "/v1/relay/attach", "/v1/relay/0123", "/v1/relay/0123/inbox", "/v1/relay/0123/reply", "/", "/v1", "/v2/x", "//v1//caps", "/v1/caps?x=%ZZ", "/v1/files?name=%", "/v1/views", "/v1/views/aaaaaaaaaaaaaaaaaaaaaaaa", "/v1/views/x", "/sync/v1/hello", "/sync/v1/pair", "/sync/v1/pair/0123", "/sync/v1/state", "/sync/v1/next", "/sync", "/v1/sync/attach", "/v1/sync/0123", "/v1/sync/0123/state", "/v1/sync/0123/next", "/v1/stereo", "/v1/stereo/aaaaaaaaaaaaaaaaaaaaaaaa", "/v1/stereo/x", "/stereo", "/stereo/v1/aaaaaaaaaaaaaaaaaaaaaaaa/scene", "/stereo/v1/x/tile/left/0/0/0", "/stereo/v1/aaaaaaaaaaaaaaaaaaaaaaaa/report", "/v1/cors-relay/fetch"];
    let methods = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE", "CONNECT", "FOO"];
    let bodies: Vec<Vec<u8>> = vec![vec![], b"{}".to_vec(), b"{\"mode\":\"file\"}".to_vec(), b"\xff\xfe\x00".to_vec(), vec![b'['; 5000], b"{\"profile\":\"raster-cog\",\"inputs\":[]}".to_vec()];
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let mut n = 0;
    for _ in 0..1500 {
        let route = routes[(next() % routes.len() as u64) as usize];
        let method = methods[(next() % methods.len() as u64) as usize];
        if method == "PUT" && route.starts_with("/v1/files?") {
            continue;
        }
        let body = &bodies[(next() % bodies.len() as u64) as usize];
        let ct = ["application/json", "text/plain", "", "application/json; charset=utf-8"][(next() % 4) as usize];
        let origin = [Some("null"), Some(HOSTED), None, Some("https://evil.example")][(next() % 4) as usize];
        let mut r = Req::new(method, route).origin(origin).body(body.clone());
        if !ct.is_empty() {
            r = r.header("Content-Type", ct);
        }
        if next() % 3 == 0 {
            r = r.header("Range", "bytes=0-1");
        }
        if next() % 5 == 0 {
            r = r.token(None);
        }
        let resp = r.send(h.port).await;
        assert!(resp.status != 0 && resp.status < 500 || resp.status == 503, "{method} {route} → {} {}", resp.status, resp.text());
        n += 1;
    }
    // Malformed HTTP.
    for junk in [&b"\x00\x01\x02\r\n\r\n"[..], b"GET\r\n\r\n", b"GET / HTTP/9.9\r\n\r\n", b"GET /v1/hello HTTP/1.1\r\nHost: \xff\r\n\r\n", &[b'A'; 20000][..]] {
        let _ = raw(h.port, junk).await;
    }
    assert_eq!(Req::new("GET", "/v1/hello").send(h.port).await.status, 200, "still serving after {n} fuzz requests");
}

#[test]
fn memory_cap_is_enforced() {
    // The Job Object memory limit stops a tool that allocates past it.
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let dir = std::env::temp_dir().join(format!("gwb-mem-{}", gwb_sidecar::util::random_hex(4)));
        let input = dir.join("in.txt");
        gwb_sidecar::winjob::create_low_dir(&dir).unwrap();
        std::fs::write(&input, "ALLOC 600").unwrap();
        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_gwb-fake-tool"));
        cmd.arg(&input).arg(dir.join("out.txt"));
        let (mut child, job) = gwb_sidecar::winjob::spawn_in_job(cmd, gwb_sidecar::winjob::JobLimits { memory_bytes: 64 << 20, cpu_seconds: 60, processes: 2 }).unwrap();
        let st = child.wait().await.unwrap();
        assert!(!st.success(), "a 600 MB allocation under a 64 MB cap must fail");
        assert!(job.peak_memory() <= 70 << 20);
        std::fs::write(&input, "ALLOC 16").unwrap();
        let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_gwb-fake-tool"));
        cmd.arg(&input).arg(dir.join("out.txt"));
        let (mut child, _job) = gwb_sidecar::winjob::spawn_in_job(cmd, gwb_sidecar::winjob::JobLimits { memory_bytes: 64 << 20, cpu_seconds: 60, processes: 2 }).unwrap();
        assert!(child.wait().await.unwrap().success());
        std::fs::remove_dir_all(&dir).ok();
    });
}

#[tokio::test(flavor = "multi_thread")]
async fn two_pairings_of_one_origin_are_isolated() {
    // Every file:// page has Origin null: files and jobs belong to the pairing, not the origin.
    let h = start().await;
    let other = "e".repeat(64);
    h.svc.pairings.add_token("null", &other, "second browser profile");
    let id = upload(&h, "mine.bin", b"abc").await;
    let r = Req::new("GET", &format!("/v1/files/{id}")).token(Some(&other)).send(h.port).await;
    assert_eq!(r.status, 404, "another null pairing must not read it");
    assert!(Req::new("GET", "/v1/files").token(Some(&other)).send(h.port).await.json().as_array().unwrap().is_empty());
    let j = job(&h, "probe", &[&id], json!({})).await;
    let jid = j.json()["id"].as_str().unwrap().to_string();
    assert_eq!(Req::new("GET", &format!("/v1/jobs/{jid}")).token(Some(&other)).send(h.port).await.status, 404);
    assert_eq!(Req::new("DELETE", &format!("/v1/jobs/{jid}")).token(Some(&other)).send(h.port).await.status, 404);
    assert_eq!(Req::new("GET", &format!("/v1/files/{id}")).send(h.port).await.status, 200);
}

#[cfg(any(windows, target_os = "linux"))]
#[test]
fn tools_run_at_low_integrity_and_write_only_to_the_job_folder() {
    // Linux: Landlock in place of Low integrity (winjob.rs); a kernel without it cannot pass.
    #[cfg(target_os = "linux")]
    if gwb_sidecar::winjob::confinement().contains("not available") {
        eprintln!("skipped: no Landlock on this kernel");
        return;
    }
    // REQ-SDC-04 hardening (own review, owner item 2): a tool writes its output in the job folder,
    // which is labelled Low, but cannot write anywhere else the user can (here: an unlabelled folder).
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let base = std::env::temp_dir().join(format!("gwb-il-{}", gwb_sidecar::util::random_hex(4)));
        let job = base.join("job");
        let user = base.join("user");
        std::fs::create_dir_all(&user).unwrap();
        gwb_sidecar::winjob::create_low_dir(&job).unwrap();
        let input = base.join("in.txt");
        std::fs::write(&input, "OK").unwrap();
        let lim = gwb_sidecar::winjob::JobLimits { memory_bytes: 256 << 20, cpu_seconds: 60, processes: 2 };
        for (dir, allowed) in [(&job, true), (&user, false)] {
            let mut cmd = tokio::process::Command::new(env!("CARGO_BIN_EXE_gwb-fake-tool"));
            cmd.arg(&input).arg(dir.join("out.tif"));
            let (mut child, _j) = gwb_sidecar::winjob::spawn_in_job(cmd, lim).unwrap();
            let ok = child.wait().await.unwrap().success() && dir.join("out.tif").exists();
            assert_eq!(ok, allowed, "write to {} at Low integrity", dir.display());
        }
        std::fs::remove_dir_all(&base).ok();
    });
}

/// A folder Low-integrity tools may write to (the fake tool's side files).
fn low_dir(base: &std::path::Path) -> std::path::PathBuf {
    let d = base.join("low");
    gwb_sidecar::winjob::create_low_dir(&d).unwrap();
    d
}
