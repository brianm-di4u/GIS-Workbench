//! The CORS relay with its gate set for test (REQ-GAP-08, SCN-65): a real TLS origin on loopback, the
//! real service, and every refusal by its code. Only a `--features cors-relay` build has this file's
//! subject, and this binary sets `GWB_SIDECAR_TEST=1` for its own process.
#![cfg(feature = "cors-relay")]

mod common;
use common::*;
use gwb_sidecar::corsrelay::{Refusal, COMPILED_IN, MAX_REDIRECTS};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::TlsAcceptor;

fn certs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/fx26/native/certs")
}

/// A TLS origin that sends no CORS headers. Every request's head is kept.
struct Origin {
    port: u16,
    seen: Arc<Mutex<Vec<String>>>,
}

async fn answer(path: &str, port: u16) -> (String, Vec<u8>) {
    let ok = |extra: &str, body: &[u8]| (format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nSet-Cookie: session=stolen\r\nWWW-Authenticate: Basic\r\nX-Internal: secret\r\nETag: \"v1\"\r\nConnection: close\r\n{extra}\r\n", body.len()), body.to_vec());
    let to = |loc: String| (format!("HTTP/1.1 302 Found\r\nLocation: {loc}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"), vec![]);
    match path.split('?').next().unwrap() {
        "/ok" => ok("", b"hello from the origin"),
        "/same" => to("/ok".into()),
        "/relative" => to("ok".into()),
        "/two" => to("/same".into()),
        "/loop" => to("/loop".into()),
        "/other" => to(format!("https://other.test:{port}/ok")),
        "/down" => to(format!("http://origin.test:{port}/ok")),
        "/scheme" => to("//evil.example/ok".into()),
        "/file" => to("file:///c:/windows/win.ini".into()),
        "/metadata" => to("https://169.254.169.254/latest/meta-data/".into()),
        "/noloc" => ("HTTP/1.1 302 Found\r\nContent-Length: 0\r\n\r\n".into(), vec![]),
        "/big" => ("HTTP/1.1 200 OK\r\nContent-Length: 99999999999\r\n\r\n".into(), vec![]),
        "/long" => ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".into(), vec![b'x'; 100_000]),
        "/range" => ("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 2-4/10\r\nContent-Length: 3\r\n\r\n".into(), b"abc".to_vec()),
        "/hang" => {
            tokio::time::sleep(Duration::from_secs(60)).await;
            ok("", b"late")
        }
        "/garbage" => ("not http at all\r\n\r\n".into(), vec![]),
        _ => ("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".into(), vec![]),
    }
}

async fn serve_origin() -> Origin {
    let dir = certs();
    let cert: Vec<CertificateDer> = CertificateDer::pem_file_iter(dir.join("leaf.pem")).unwrap().map(|c| c.unwrap()).collect();
    let key = PrivateKeyDer::from_pem_file(dir.join("leaf.key")).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ServerConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_no_client_auth().with_single_cert(cert, key).unwrap();
    let acceptor = TlsAcceptor::from(Arc::new(cfg));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = l.accept().await else { return };
            let (a, seen) = (acceptor.clone(), s2.clone());
            tokio::spawn(async move {
                let Ok(mut s) = a.accept(tcp).await else { return };
                let mut b = vec![0u8; 8192];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut b).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&b[..n]),
                    }
                }
                let head = String::from_utf8_lossy(&got).into_owned();
                seen.lock().unwrap().push(head.clone());
                let path = head.split(' ').nth(1).unwrap_or("/").to_string();
                let (h, body) = answer(&path, port).await;
                let _ = s.write_all(h.as_bytes()).await;
                if !head.starts_with("HEAD") {
                    let _ = s.write_all(&body).await;
                }
                let _ = s.shutdown().await;
            });
        }
    });
    Origin { port, seen }
}

fn test_run() {
    unsafe { std::env::set_var("GWB_SIDECAR_TEST", "1") };
}

/// The service with its gate open, trusting the test CA, and `origin.test` and `other.test`
/// answering at the addresses given.
async fn gate_open(resolve: &[(&str, &str)]) -> H {
    test_run();
    let r: Vec<(String, std::net::IpAddr)> = resolve.iter().map(|(h, a)| (h.to_string(), a.parse().unwrap())).collect();
    start_with(move |c| {
        c.test_allow_cors_relay = true;
        c.test_relay_ca = Some(certs().join("ca.pem"));
        c.test_relay_resolve = r;
    })
    .await
}

async fn fetch(h: &H, url: &str) -> Resp {
    Req::new("POST", "/v1/cors-relay/fetch").json(json!({ "url": url, "method": "GET" })).send(h.port).await
}

fn code(r: &Resp) -> Value {
    r.json()["code"].clone()
}

fn log(h: &H) -> Vec<String> {
    h.svc.log.lock().unwrap().iter().cloned().collect()
}

fn refused(h: &H, what: &str, why: &str) -> bool {
    log(h).iter().any(|l| l.contains("cors-relay: refused") && l.contains(what) && l.contains(why))
}

#[test]
fn the_marker_is_what_the_package_gate_looks_for() {
    assert_eq!(&COMPILED_IN, b"GWB-CORS-RELAY-COMPILED-IN");
}

#[tokio::test(flavor = "multi_thread")]
async fn reaches_a_listed_origin() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let url = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&url, true).unwrap();
    let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
    assert_eq!(caps["features"]["cors_relay"], json!(true));
    let r = fetch(&h, &format!("{url}/ok?token=abc")).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.text(), "hello from the origin");
    assert_eq!(r.header("x-gwb-relay-status"), Some("200"));
    assert_eq!(r.header("x-gwb-relay-content-type"), Some("text/plain"));
    assert_eq!(r.header("x-gwb-relay-etag"), Some("\"v1\""));
    // CORS to the page comes from the sidecar: exact origin, as for every other route.
    assert_eq!(r.header("access-control-allow-origin"), Some("null"));
    assert!(r.header("access-control-expose-headers").unwrap().contains("X-Gwb-Relay-Status"));
    // Nothing of the origin's that could set state in a browser comes back.
    for k in ["set-cookie", "www-authenticate", "x-internal", "x-gwb-relay-set-cookie", "x-gwb-relay-x-internal"] {
        assert_eq!(r.header(k), None, "{k}");
    }
    // What the origin saw: no cookie, no credential, nothing of the page's.
    let seen = o.seen.lock().unwrap()[0].to_ascii_lowercase();
    assert!(seen.starts_with("get /ok?token=abc http/1.1"), "{seen}");
    for k in ["cookie", "authorization", "origin:", "referer", "x-gwb"] {
        assert!(!seen.contains(k), "{k} reached the origin: {seen}");
    }
    assert!(seen.contains("user-agent: gis-workbench-sidecar/"), "{seen}");
    // Every call is in the log, with no query string.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let l = log(&h);
    assert!(l.iter().any(|x| x.contains("cors-relay: GET") && x.contains("/ok for null → 200, 21 bytes")), "{l:?}");
    assert!(!l.iter().any(|x| x.contains("token=abc")), "{l:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn head_range_and_accept_go_through() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let url = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&url, true).unwrap();
    let r = Req::new("POST", "/v1/cors-relay/fetch").json(json!({"url": format!("{url}/range"), "method": "GET", "range": "bytes=2-4", "accept": "image/tiff"})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("x-gwb-relay-status"), Some("206"));
    assert_eq!(r.header("x-gwb-relay-content-range"), Some("bytes 2-4/10"));
    assert_eq!(r.text(), "abc");
    let seen = o.seen.lock().unwrap().join("\n").to_ascii_lowercase();
    assert!(seen.contains("range: bytes=2-4") && seen.contains("accept: image/tiff"), "{seen}");
    let r = Req::new("POST", "/v1/cors-relay/fetch").json(json!({"url": format!("{url}/ok"), "method": "HEAD"})).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("x-gwb-relay-status"), Some("200"));
    assert!(r.body.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_is_needed_and_only_a_pages_token_will_do() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let url = format!("https://127.0.0.1:{}/ok", o.port);
    h.svc.cors.set(&format!("https://127.0.0.1:{}", o.port), true).unwrap();
    let r = Req::new("POST", "/v1/cors-relay/fetch").token(None).json(json!({"url": url, "method": "GET"})).send(h.port).await;
    assert_eq!(r.status, 401);
    let bad = "e".repeat(64);
    assert_eq!(Req::new("POST", "/v1/cors-relay/fetch").token(Some(&bad)).json(json!({"url": url, "method": "GET"})).send(h.port).await.status, 401);
    // A Python script's or an add-in's token is no page's.
    h.svc.pairings.add_token(gwb_sidecar::relay::RELAY_ORIGIN, &"1".repeat(64), "script");
    h.svc.pairings.add_token(gwb_sidecar::prosync::SYNC_ORIGIN, &"2".repeat(64), "addin");
    for t in ["1".repeat(64), "2".repeat(64)] {
        assert_eq!(Req::new("POST", "/v1/cors-relay/fetch").token(Some(&t)).json(json!({"url": url, "method": "GET"})).send(h.port).await.status, 401);
    }
    // An origin that may not use the sidecar at all.
    let r = Req::new("POST", "/v1/cors-relay/fetch").origin(Some("https://evil.example")).json(json!({"url": url, "method": "GET"})).send(h.port).await;
    assert_eq!(r.status, 403);
    assert_eq!(code(&r), json!("origin_not_allowed"));
    assert!(o.seen.lock().unwrap().is_empty(), "nothing reached the origin");
}

#[tokio::test(flavor = "multi_thread")]
async fn only_listed_origins() {
    let o = serve_origin().await;
    let h = gate_open(&[("origin.test", "127.0.0.1"), ("other.test", "127.0.0.1")]).await;
    let port = o.port;
    h.svc.cors.set(&format!("https://origin.test:{port}"), true).unwrap();
    assert_eq!(fetch(&h, &format!("https://origin.test:{port}/ok")).await.status, 200);
    for u in [format!("https://other.test:{port}/ok"), format!("https://origin.test:{}/ok", port + 1), "https://origin.test/ok".to_string(), format!("https://sub.origin.test:{port}/ok"), format!("https://127.0.0.1:{port}/ok")] {
        let r = fetch(&h, &u).await;
        assert_eq!(r.status, 403, "{u}: {}", r.text());
        assert_eq!(code(&r), json!("not_listed"), "{u}");
    }
    assert_eq!(o.seen.lock().unwrap().len(), 1, "only the listed call reached a server");
    assert!(refused(&h, "other.test", "not_listed"), "{:?}", log(&h));
    h.svc.cors.remove(&format!("https://origin.test:{port}"));
    assert_eq!(code(&fetch(&h, &format!("https://origin.test:{port}/ok")).await), json!("not_listed"));
}

#[tokio::test(flavor = "multi_thread")]
async fn https_only_and_every_other_url_form_by_name() {
    let h = gate_open(&[]).await;
    for (u, c) in [
        ("http://example.org/", "not_https"),
        ("ftp://example.org/", "not_https"),
        ("file:///c:/windows/win.ini", "not_https"),
        ("https://user:pw@example.org/", "bad_url"),
        ("https://example.org/#x", "bad_url"),
        ("https://2130706433/", "bad_url"),
        ("https://127.1/", "bad_url"),
        ("https://example.org./", "bad_url"),
        ("https://exa%6dple.org/", "bad_url"),
        ("https://example.org/\r\nX: y", "bad_url"),
        ("not a url", "bad_url"),
    ] {
        let r = fetch(&h, u).await;
        assert_eq!(code(&r), json!(c), "{u}: {}", r.text());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn methods_and_headers_are_narrow() {
    let h = gate_open(&[]).await;
    h.svc.cors.set("https://example.org", false).unwrap();
    for m in ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "get", ""] {
        let r = Req::new("POST", "/v1/cors-relay/fetch").json(json!({"url": "https://example.org/", "method": m})).send(h.port).await;
        assert_eq!(code(&r), json!("bad_method"), "{m}: {}", r.text());
    }
    for extra in [json!({"accept": "a\r\nCookie: x"}), json!({"range": "bytes=0-1,5-6"}), json!({"range": "bytes=0-1\r\nCookie: x"})] {
        let mut b = json!({"url": "https://example.org/", "method": "GET"});
        for (k, v) in extra.as_object().unwrap() {
            b[k] = v.clone();
        }
        let r = Req::new("POST", "/v1/cors-relay/fetch").json(b).send(h.port).await;
        assert_eq!(code(&r), json!("bad_header"), "{}", r.text());
    }
    // There is no field for a body, a cookie or a credential.
    for k in ["body", "headers", "cookie", "authorization"] {
        let mut b = json!({"url": "https://example.org/", "method": "GET"});
        b[k] = json!("x");
        let r = Req::new("POST", "/v1/cors-relay/fetch").json(b).send(h.port).await;
        assert_eq!(r.status, 400, "{k}");
        assert_eq!(code(&r), json!("bad_request"), "{k}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn loopback_and_private_targets_need_the_users_mark() {
    let o = serve_origin().await;
    // A listed origin whose name resolves to this computer: DNS rebinding, refused before a socket.
    let h = gate_open(&[("origin.test", "127.0.0.1"), ("metadata.test", "169.254.169.254"), ("mixed.test", "93.184.216.34"), ("mixed.test", "10.0.0.1"), ("mapped.test", "::ffff:127.0.0.1")]).await;
    let port = o.port;
    for (host, addr) in [("origin.test", "127.0.0.1"), ("metadata.test", "169.254.169.254"), ("mixed.test", "10.0.0.1"), ("mapped.test", "::ffff:127.0.0.1")] {
        let site = format!("https://{host}:{port}");
        h.svc.cors.set(&site, false).unwrap();
        let r = fetch(&h, &format!("{site}/ok")).await;
        assert_eq!(r.status, 403, "{host}: {}", r.text());
        assert_eq!(code(&r), json!("private_target"), "{host}");
        assert!(r.text().contains(addr), "{}", r.text());
    }
    for ip in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1"] {
        let site = format!("https://{ip}:{port}");
        h.svc.cors.set(&site, false).unwrap();
        assert_eq!(code(&fetch(&h, &format!("{site}/ok")).await), json!("private_target"), "{ip}");
    }
    let site = format!("https://[::1]:{port}");
    h.svc.cors.set(&site, false).unwrap();
    assert_eq!(code(&fetch(&h, &format!("{site}/ok")).await), json!("private_target"));
    assert!(o.seen.lock().unwrap().is_empty(), "no connection was made");
    // The user's mark opens it.
    h.svc.cors.set(&format!("https://origin.test:{port}"), true).unwrap();
    assert_eq!(fetch(&h, &format!("https://origin.test:{port}/ok")).await.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn some_targets_no_mark_opens() {
    let h = gate_open(&[("multi.test", "224.0.0.1"), ("zero.test", "0.0.0.0")]).await;
    for (site, want) in [("https://multi.test", "never_target"), ("https://zero.test", "never_target"), ("https://0.0.0.0", "never_target"), ("https://255.255.255.255", "never_target"), ("https://[ff02::1]", "never_target"), ("https://[::]", "never_target")] {
        h.svc.cors.set(site, true).unwrap();
        let r = fetch(&h, &format!("{site}/")).await;
        assert_eq!(code(&r), json!(want), "{site}: {}", r.text());
    }
    for p in gwb_sidecar_api::PORTS {
        let site = format!("https://127.0.0.1:{p}");
        h.svc.cors.set(&site, true).unwrap();
        assert_eq!(code(&fetch(&h, &format!("{site}/v1/caps")).await), json!("own_port"), "{p}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn redirects_stay_on_the_origin() {
    let o = serve_origin().await;
    let h = gate_open(&[("origin.test", "127.0.0.1"), ("other.test", "127.0.0.1")]).await;
    let site = format!("https://origin.test:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    for p in ["/same", "/relative", "/two"] {
        let r = fetch(&h, &format!("{site}{p}")).await;
        assert_eq!(r.status, 200, "{p}: {}", r.text());
        assert_eq!(r.text(), "hello from the origin", "{p}");
    }
    // Even another listed origin is not a redirect's to reach.
    h.svc.cors.set(&format!("https://other.test:{}", o.port), true).unwrap();
    for p in ["/other", "/down", "/scheme", "/file", "/metadata"] {
        let n = o.seen.lock().unwrap().len();
        let r = fetch(&h, &format!("{site}{p}")).await;
        assert_eq!(code(&r), json!("redirect_refused"), "{p}: {}", r.text());
        assert_eq!(o.seen.lock().unwrap().len(), n + 1, "{p}: the redirect was not followed");
        assert!(refused(&h, p, "redirect_refused"), "{p}: {:?}", log(&h));
    }
    assert_eq!(code(&fetch(&h, &format!("{site}/loop")).await), json!("too_many_redirects"));
    assert_eq!(o.seen.lock().unwrap().iter().filter(|l| l.contains("GET /loop")).count(), MAX_REDIRECTS + 1);
    assert_eq!(code(&fetch(&h, &format!("{site}/noloc")).await), json!("upstream"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_certificate_that_does_not_verify_is_refused() {
    let o = serve_origin().await;
    test_run();
    // Trusting only a CA that signed nothing here, as a client with the system's roots would be.
    let h = start_with(|c| {
        c.test_allow_cors_relay = true;
        c.test_relay_ca = Some(certs().join("other-ca.pem"));
    })
    .await;
    let site = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    let r = fetch(&h, &format!("{site}/ok")).await;
    assert_eq!(code(&r), json!("tls"), "{}", r.text());
    assert!(o.seen.lock().unwrap().is_empty(), "no request went over it");
    // A name the certificate does not cover, with the right CA.
    let h = gate_open(&[("wrong-name.test", "127.0.0.1")]).await;
    let site = format!("https://wrong-name.test:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    assert_eq!(code(&fetch(&h, &format!("{site}/ok")).await), json!("tls"));
    assert!(o.seen.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_http_on_the_port_is_a_tls_failure() {
    // A sidecar-like loopback HTTP server, listed by mistake: TLS fails and nothing is sent to it.
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
        }
    });
    let h = gate_open(&[]).await;
    let site = format!("https://127.0.0.1:{port}");
    h.svc.cors.set(&site, true).unwrap();
    assert_eq!(code(&fetch(&h, &format!("{site}/")).await), json!("tls"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_response_past_the_limit_stops() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let site = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    let r = fetch(&h, &format!("{site}/big")).await;
    assert_eq!(r.status, 413, "{}", r.text());
    assert_eq!(code(&r), json!("too_large"));
    h.svc.cors.set_limits(1000, Duration::from_secs(30));
    let r = fetch(&h, &format!("{site}/long")).await;
    assert!(r.body.len() <= 66_000, "the stream was cut: {}", r.body.len());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(log(&h).iter().any(|l| l.contains("/long") && l.contains("stopped: too large")), "{:?}", log(&h));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_origin_times_out_and_a_bad_one_is_named() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let site = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    h.svc.cors.set_limits(1 << 20, Duration::from_millis(300));
    let r = fetch(&h, &format!("{site}/hang")).await;
    assert_eq!(r.status, 504, "{}", r.text());
    assert_eq!(code(&r), json!("timeout"));
    h.svc.cors.set_limits(1 << 20, Duration::from_secs(10));
    assert_eq!(code(&fetch(&h, &format!("{site}/garbage")).await), json!("upstream"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_name_that_does_not_resolve_is_named() {
    let h = gate_open(&[]).await;
    h.svc.cors.set("https://no-such-host.invalid", false).unwrap();
    let r = fetch(&h, "https://no-such-host.invalid/").await;
    assert!([json!("dns"), json!("timeout")].contains(&code(&r)), "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn calls_at_once_are_capped() {
    let o = serve_origin().await;
    let h = gate_open(&[]).await;
    let site = format!("https://127.0.0.1:{}", o.port);
    h.svc.cors.set(&site, true).unwrap();
    h.svc.cors.set_limits(1 << 20, Duration::from_secs(3));
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let (port, url) = (h.port, format!("{site}/hang"));
        set.spawn(async move { Req::new("POST", "/v1/cors-relay/fetch").json(json!({"url": url, "method": "GET"})).send(port).await });
    }
    let mut codes = Vec::new();
    while let Some(r) = set.join_next().await {
        codes.push(code(&r.unwrap()));
    }
    assert_eq!(codes.iter().filter(|c| **c == json!("busy")).count(), 4, "{codes:?}");
    assert_eq!(codes.iter().filter(|c| **c == json!("timeout")).count(), 4, "{codes:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_page_can_add_to_the_list() {
    let h = gate_open(&[]).await;
    // The list has one route, in the sidecar window's zone: Host localhost, the window's secret.
    let body = json!({"origin": "https://evil.example", "private": true});
    for (host, tok) in [(format!("127.0.0.1:{}", h.port), Some(TOKEN)), (format!("localhost:{}", h.port), Some(TOKEN)), (format!("localhost:{}", h.port), None)] {
        let r = Req::new("POST", "/ui/api/cors-origin").host(&host).token(tok).json(body.clone()).send(h.port).await;
        assert!(r.status == 403 || r.status == 404, "{host}: {} {}", r.status, r.text());
    }
    for (m, p) in [("POST", "/v1/cors-relay/origins"), ("PUT", "/v1/cors-relay/origins"), ("POST", "/v1/cors-relay/list")] {
        assert_eq!(Req::new(m, p).json(body.clone()).send(h.port).await.status, 404, "{p}");
    }
    assert!(h.svc.cors.entries().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn every_refusal_has_a_status_a_code_and_a_message() {
    for r in [
        Refusal::GateClosed,
        Refusal::BadUrl("x".into()),
        Refusal::NotHttps,
        Refusal::NotListed("o".into()),
        Refusal::BadMethod("m".into()),
        Refusal::BadHeader("h"),
        Refusal::PrivateTarget("a".into()),
        Refusal::NeverTarget("a".into()),
        Refusal::OwnPort,
        Refusal::RedirectRefused("t".into()),
        Refusal::TooManyRedirects,
        Refusal::Busy,
        Refusal::Dns("d".into()),
        Refusal::Connect("c".into()),
        Refusal::Tls("t".into()),
        Refusal::Upstream("u".into()),
        Refusal::TooLarge,
        Refusal::Timeout,
    ] {
        let (s, c, m) = r.http();
        assert!((400..600).contains(&s) && !c.is_empty() && !m.is_empty(), "{r:?}");
    }
}
