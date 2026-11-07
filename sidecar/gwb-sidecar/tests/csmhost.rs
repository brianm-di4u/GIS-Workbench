//! The plug-in host on a mock plug-in, gate set for test (REQ-GAP-25, SCN-64).
//!   cargo test -p gwb-sidecar --features csm-host --test csmhost
//! GWB_CSM_BUILD names the folder of `node sidecar/csmhost/build.mjs`. With the feature on and no
//! build, these fail rather than skip: this suite is the proof the host is confined.
#![cfg(feature = "csm-host")]
#![allow(clippy::all)]

mod common;
use common::*;
use gwb_sidecar::csmhost::proto::{self, Op, Status};
use gwb_sidecar::csmhost::sandbox;
use gwb_sidecar::winjob::{create_low_dir, JobLimits};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

const CONTRACT: &str = include_str!("../../csmhost/contract/csm-host-contract.json");

fn build_dir() -> PathBuf {
    let d = PathBuf::from(std::env::var("GWB_CSM_BUILD").expect("set GWB_CSM_BUILD to the output of sidecar/csmhost/build.mjs"));
    assert!(d.join(format!("gwb-csm-host{}", std::env::consts::EXE_SUFFIX)).is_file(), "no host in {}", d.display());
    d
}

fn lib(name: &str) -> PathBuf {
    build_dir().join(format!("{name}{}", if cfg!(windows) { ".dll" } else { ".so" }))
}

async fn start_open() -> H {
    std::env::set_var("GWB_SIDECAR_TEST", "1");
    let d = build_dir();
    start_with(move |c| {
        c.test_allow_csm = true;
        c.test_csm_host = Some(d);
        c.test_csm_wall_ms = Some(8000);
    })
    .await
}

/// The sidecar window's secret, as a user opening the window gets it.
async fn window(h: &H) -> (String, String, String) {
    let lh = format!("localhost:{}", h.port);
    let lo = format!("http://{lh}");
    let key = std::fs::read_to_string(h.dir.join("data").join("ui.key")).unwrap();
    let r = Req::new("POST", "/ui/api/launch").host(&lh).origin(None).token(None).header("X-Gwb-Key", key.trim().to_string()).send(h.port).await;
    let url = r.json()["url"].as_str().unwrap().to_string();
    let code = url.split("launch=").nth(1).unwrap().to_string();
    let r = Req::new("POST", "/ui/api/session").host(&lh).origin(Some(&lo)).token(None).json(json!({"launch": code})).send(h.port).await;
    (lh.clone(), lo.clone(), r.json()["secret"].as_str().unwrap().to_string())
}

async fn decide(h: &H, sha: &str, approve: bool) -> Resp {
    let (lh, lo, secret) = window(h).await;
    Req::new("POST", "/ui/api/csm/decide").host(&lh).origin(Some(&lo)).token(None).header("X-Gwb-Admin", secret).json(json!({"sha256": sha, "approve": approve})).send(h.port).await
}

async fn add(h: &H, path: &Path) -> Value {
    let id = upload(h, path.file_name().unwrap().to_str().unwrap(), &std::fs::read(path).unwrap()).await;
    let r = Req::new("POST", "/v1/csm/plugins").json(json!({"file": id})).send(h.port).await;
    assert!(r.status == 201 || r.status == 200, "{}", r.text());
    r.json()
}

async fn approved(h: &H, path: &Path) -> String {
    let rec = add(h, path).await;
    let sha = rec["sha256"].as_str().unwrap().to_string();
    assert_eq!(decide(h, &sha, true).await.status, 200);
    sha
}

fn isd_text(behaviour: &str, extra: &str) -> String {
    let c: Value = serde_json::from_str(CONTRACT).unwrap();
    let i = &c["isd"];
    format!("gwb-mock-isd 1\nlat0 {}\nlon0 {}\ngsd {}\nlines {}\nsamples {}\ntilt {}\nbehaviour {behaviour}\n{extra}", i["lat0"], i["lon0"], i["gsd"], i["lines"], i["samples"], i["tilt"])
}

async fn session(h: &H, sha: &str, isd: &str) -> Resp {
    let id = upload(h, "scene.isd", isd.as_bytes()).await;
    Req::new("POST", "/v1/csm/sessions").json(json!({"plugin": sha, "isd": id})).send(h.port).await
}

async fn open(h: &H, sha: &str, isd: &str) -> Value {
    let r = session(h, sha, isd).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

fn post<'a>(path: &'a str, v: Value) -> Req<'a> {
    Req::new("POST", path).json(v)
}

fn close_to(a: &Value, b: &Value, tol: f64) {
    let (a, b) = (a.as_array().unwrap(), b.as_array().unwrap());
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b) {
        if x.is_array() {
            close_to(x, y, tol);
        } else {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            assert!((x - y).abs() <= tol, "{x} and {y} differ by more than {tol}");
        }
    }
}

fn first_two(v: &Value, n: usize) -> Value {
    Value::Array(v.as_array().unwrap().iter().map(|p| Value::Array(p.as_array().unwrap()[..n].to_vec())).collect())
}

#[tokio::test(flavor = "multi_thread")]
async fn the_contract_holds_from_record_to_close() {
    let c: Value = serde_json::from_str(CONTRACT).unwrap();
    let h = start_open().await;
    assert_eq!(Req::new("GET", "/v1/caps").send(h.port).await.json()["csm_host"]["available"], json!(true));

    // Recorded, with its hash and signer, and not run.
    let plugin = lib("gwb_mock_csm_plugin");
    let rec = add(&h, &plugin).await;
    let want = gwb_sidecar::util::sha256_hex(&std::fs::read(&plugin).unwrap());
    assert_eq!(rec["sha256"], json!(want));
    assert_eq!(rec["state"], json!("pending"));
    assert_eq!(rec["signer"]["status"], json!(if cfg!(windows) { "unsigned" } else { "unchecked" }));
    assert_eq!(add(&h, &plugin).await["state"], json!("pending"), "the same file is one record");
    assert_eq!(Req::new("GET", "/v1/csm/plugins").send(h.port).await.json().as_array().unwrap().len(), 1);
    let log = h.svc.log.lock().unwrap().iter().cloned().collect::<Vec<_>>().join("\n");
    assert!(log.contains(&want), "the request log carries the hash");

    // Pending does not run, and a page's token cannot approve.
    let sha = want.clone();
    let r = session(&h, &sha, &isd_text("normal", "")).await;
    assert_eq!(r.status, 403, "{}", r.text());
    assert_eq!(r.json()["code"], json!("csm_not_approved"));
    let lh = format!("localhost:{}", h.port);
    assert_eq!(Req::new("POST", "/ui/api/csm/decide").host(&lh).origin(None).json(json!({"sha256": sha, "approve": true})).send(h.port).await.status, 403);
    assert_eq!(Req::new("POST", "/ui/api/csm/decide").json(json!({"sha256": sha, "approve": true})).send(h.port).await.status, 404, "the page zone has no such route");
    let r = decide(&h, &sha, false).await;
    assert_eq!(r.json()["state"], json!("refused"));
    assert_eq!(session(&h, &sha, &isd_text("normal", "")).await.json()["code"], json!("csm_not_approved"));
    let (lh2, _lo, secret) = window(&h).await;
    let st = Req::new("GET", "/ui/api/state").host(&lh2).origin(None).token(None).header("X-Gwb-Admin", secret).send(h.port).await.json();
    assert_eq!(st["csm"][0]["sha256"], json!(sha), "the window shows the record");
    assert_eq!(decide(&h, &sha, true).await.json()["state"], json!("approved"));

    // The session, and the numbers.
    let s = open(&h, &sha, &isd_text("normal", "")).await;
    assert_eq!(s["plugin_name"], c["model"]["plugin"]);
    assert_eq!(s["model"], c["model"]["name"]);
    assert_eq!(s["sensor_type"], c["model"]["sensor_type"]);
    assert_eq!(s["sensor_mode"], c["model"]["sensor_mode"]);
    assert_eq!(s["protocol"], c["protocol"]);
    assert!(s["csm_version"].as_str().unwrap().starts_with("3.0"), "{s}");
    let conf = s["confinement"].as_str().unwrap();
    assert!(if cfg!(windows) { conf.contains("AppContainer yes") } else { conf.contains("seccomp") }, "{conf}");
    let id = s["id"].as_str().unwrap();
    let p = |op: &str| format!("/v1/csm/sessions/{id}/{op}");

    let r = post(&p("g2i"), json!({"points": c["g2i"]["points"]})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    close_to(&first_two(&r.json()["points"], 2), &c["g2i"]["expect"], c["g2i"]["tolerance_px"].as_f64().unwrap());

    let r = post(&p("i2g"), json!({"points": c["i2g"]["points"], "precision": 0.0001})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    close_to(&first_two(&r.json()["points"], 3), &c["i2g"]["expect"], c["i2g"]["tolerance_m"].as_f64().unwrap());

    let r = post(&p("partials"), json!({"ground": c["partials"]["ground"]})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    close_to(&r.json()["ground"], &c["partials"]["expect"]["ground"], c["partials"]["tolerance"].as_f64().unwrap());
    assert_eq!(r.json()["sensor"], c["partials"]["expect"]["sensor"].clone().as_array().map(|a| json!(a.iter().map(|p| json!([p[0].as_f64().unwrap(), p[1].as_f64().unwrap()])).collect::<Vec<_>>())).unwrap());

    let r = post(&p("covariance"), json!({"image": c["covariance"]["image"]})).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    let e = &c["covariance"]["expect"];
    close_to(&r.json()["unmodeled"], &e["unmodeled"], 1e-12);
    assert_eq!(r.json()["parameters"], e["parameters"]);
    close_to(&r.json()["covariance"], &e["covariance"], 1e-12);

    // Bad requests leave the session alone.
    for (op, body) in [("g2i", json!({"points": []})), ("g2i", json!({"points": [[1, 2]]})), ("g2i", json!({"points": [[1, 2, 3]], "precision": 0})), ("i2g", json!({"points": "x"})), ("partials", json!({"ground": [1, 2]})), ("covariance", json!({"image": [1e308, 1], "extra": 1}))] {
        assert_eq!(post(&p(op), body.clone()).send(h.port).await.status, 400, "{op} {body}");
    }
    assert_eq!(post(&p("g2i"), json!({"points": vec![[1.0, 2.0, 3.0]; 65537]})).send(h.port).await.status, 400);
    assert_eq!(post(&p("g2i"), json!({"points": c["g2i"]["points"]})).send(h.port).await.status, 200);

    // Another page's token sees no such session.
    let other = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
    h.svc.pairings.add_token("null", other, "another page");
    assert_eq!(post(&p("g2i"), json!({"points": c["g2i"]["points"]})).token(Some(other)).send(h.port).await.status, 404);

    // Closing leaves nothing of the run.
    let runs = h.dir.join("data").join("csm").join("run");
    assert_eq!(std::fs::read_dir(&runs).unwrap().count(), 1);
    assert_eq!(Req::new("DELETE", &format!("/v1/csm/sessions/{id}")).send(h.port).await.status, 204);
    assert_eq!(std::fs::read_dir(&runs).unwrap().count(), 0);
    assert_eq!(post(&p("g2i"), json!({"points": c["g2i"]["points"]})).send(h.port).await.status, 404);
}

/// What the sandbox is for: the plug-in tries, and each attempt is stopped by the system.
#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_cannot_reach_the_network_the_users_files_or_a_new_process() {
    let h = start_open().await;
    let sha = approved(&h, &lib("gwb_mock_csm_plugin")).await;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let datagrams = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    datagrams.set_nonblocking(true).unwrap();
    let udp = datagrams.local_addr().unwrap().port();
    // Both can hear a process outside the sandbox, so silence below means something.
    let _ctl = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    let tx = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    tx.send_to(b"x", ("127.0.0.1", udp)).unwrap();
    let t = std::time::Instant::now();
    let (mut tcp_heard, mut udp_heard) = (false, false);
    while !(tcp_heard && udp_heard) && t.elapsed().as_secs() < 5 {
        tcp_heard |= listener.accept().is_ok();
        udp_heard |= datagrams.recv(&mut [0u8; 8]).is_ok();
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(tcp_heard && udp_heard, "the control connection and datagram must arrive");
    let dir = h.dir.join("user-files");
    std::fs::create_dir_all(&dir).unwrap();
    let secret = dir.join("secret.txt");
    std::fs::write(&secret, "the user's data").unwrap();
    let forbidden = dir.join("written-by-plugin.txt");
    let extra = format!("probe_port {port}\nprobe_udp {udp}\ncanary_read {}\ncanary_write {}\n", secret.display(), forbidden.display());
    let s = open(&h, &sha, &isd_text("probe", &extra)).await;
    let report = s["trajectory"].as_str().unwrap().to_string();
    assert!(!report.contains("udp=blocked:socket:10093"), "the UDP probe must get past WSAStartup: {report}");
    for part in ["tcp=blocked", "read=blocked", "write=blocked", "spawn=blocked"] {
        assert!(report.contains(part), "{part} is missing from: {report}");
    }
    // What counts is what arrived: sendto can report success for a packet a firewall then drops.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(listener.accept().is_err(), "no connection reached the listener: {report}");
    assert!(datagrams.recv(&mut [0u8; 8]).is_err(), "no datagram reached the socket: {report}");
    assert!(!forbidden.exists(), "the plug-in wrote a user file");
    gwb_sidecar::csmhost::close_all(&h.svc).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn refusals_by_name() {
    let h = start_open().await;
    // Not a library.
    let id = upload(&h, "notes.txt", b"just text").await;
    let r = post("/v1/csm/plugins", json!({"file": id})).send(h.port).await;
    assert_eq!((r.status, r.json()["code"].clone()), (422, json!("not_a_library")));
    assert_eq!(post("/v1/csm/plugins", json!({"file": "nope"})).send(h.port).await.status, 404);
    // Only CSM 3.0.x.
    let v2 = approved(&h, &lib("gwb_mock_csm_v2")).await;
    let r = session(&h, &v2, &isd_text("normal", "")).await;
    assert_eq!((r.status, r.json()["code"].clone()), (422, json!("csm_version")), "{}", r.text());
    assert!(r.text().contains("3.0.x"), "{}", r.text());
    // An ISD no model takes.
    let sha = approved(&h, &lib("gwb_mock_csm_plugin")).await;
    let r = session(&h, &sha, "not an isd").await;
    assert_eq!((r.status, r.json()["code"].clone()), (422, json!("csm_no_model")), "{}", r.text());
    // A stored file that changed after approval does not start.
    let stored = h.dir.join("data").join("csm").join("plugins").join(&sha);
    let good = std::fs::read(&stored).unwrap();
    let mut bad = good.clone();
    let last = bad.len() - 1;
    bad[last] ^= 0xFF;
    std::fs::write(&stored, &bad).unwrap();
    let r = session(&h, &sha, &isd_text("normal", "")).await;
    assert_eq!((r.status, r.json()["code"].clone()), (409, json!("csm_tampered")), "{}", r.text());
    std::fs::write(&stored, &good).unwrap();
    // Unknown plug-in, and not a hash.
    let isd = upload(&h, "a.isd", b"x").await;
    assert_eq!(post("/v1/csm/sessions", json!({"plugin": "0".repeat(64), "isd": isd})).send(h.port).await.status, 404);
    assert_eq!(post("/v1/csm/sessions", json!({"plugin": "../x", "isd": isd})).send(h.port).await.status, 400);
    assert_eq!(post("/v1/csm/sessions", json!({"plugin": sha, "isd": isd, "shell": "x"})).send(h.port).await.status, 400);
    assert_eq!(std::fs::read_dir(h.dir.join("data").join("csm").join("run")).unwrap().count(), 0, "a refused session leaves no run");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_misbehaving_plugin_costs_its_session_and_nothing_else() {
    let c: Value = serde_json::from_str(CONTRACT).unwrap();
    let h = start_open().await;
    let sha = approved(&h, &lib("gwb_mock_csm_plugin")).await;
    let g2i = |id: &str| post(Box::leak(format!("/v1/csm/sessions/{id}/g2i").into_boxed_str()), json!({"points": [c["g2i"]["points"][0]]}));

    // A C++ exception is an answer: the session stays.
    let s = open(&h, &sha, &isd_text("throw", "")).await;
    let id = s["id"].as_str().unwrap();
    let r = g2i(id).send(h.port).await;
    assert_eq!((r.status, r.json()["code"].clone()), (422, json!("csm_error")), "{}", r.text());
    assert!(r.text().contains("the mock was told to fail"));
    assert_eq!(g2i(id).send(h.port).await.status, 422, "still open");

    // Text a plug-in prints does not reach the wire.
    let s = open(&h, &sha, &isd_text("print", "")).await;
    let r = g2i(s["id"].as_str().unwrap()).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    close_to(&first_two(&r.json()["points"], 2), &json!([c["g2i"]["expect"][0]]), 1e-6);

    // The memory cap: the allocation fails in the plug-in, which reaches the host as an exception.
    let s = open(&h, &sha, &isd_text("alloc", "")).await;
    let r = g2i(s["id"].as_str().unwrap()).send(h.port).await;
    assert!(r.status == 422 && r.text().contains("alloc") || r.status == 502, "{}", r.text());
    assert_eq!(Req::new("DELETE", Box::leak(format!("/v1/csm/sessions/{}", s["id"].as_str().unwrap()).into_boxed_str())).send(h.port).await.status, if r.status == 422 { 204 } else { 404 });

    for (behaviour, status, code) in [("crash", 502, "csm_host_ended"), ("hang", 504, "csm_host_timeout"), ("burn", 504, "csm_host_timeout"), ("nan", 502, "csm_bad_reply")] {
        let s = open(&h, &sha, &isd_text(behaviour, "")).await;
        let id = s["id"].as_str().unwrap();
        let t = std::time::Instant::now();
        let r = g2i(id).send(h.port).await;
        assert_eq!((r.status, r.json()["code"].clone()), (status, json!(code)), "{behaviour}: {}", r.text());
        assert!(t.elapsed().as_secs() < 40, "{behaviour} took {:?}", t.elapsed());
        assert_eq!(g2i(id).send(h.port).await.status, 404, "{behaviour}: the session is gone");
    }
    assert_eq!(std::fs::read_dir(h.dir.join("data").join("csm").join("run")).unwrap().flatten().filter(|d| d.path().join("input.isd").exists()).count(), 2, "only the two live sessions keep a run");

    // The sidecar and other sessions go on.
    assert_eq!(Req::new("GET", "/v1/caps").send(h.port).await.status, 200);
    let s = open(&h, &sha, &isd_text("normal", "")).await;
    assert_eq!(g2i(s["id"].as_str().unwrap()).send(h.port).await.status, 200);
    // No more than four at once: three are open now.
    let _ = open(&h, &sha, &isd_text("normal", "")).await;
    let r = session(&h, &sha, &isd_text("normal", "")).await;
    assert_eq!(r.status, 429, "{}", r.text());
    gwb_sidecar::csmhost::close_all(&h.svc).await;
    assert_eq!(std::fs::read_dir(h.dir.join("data").join("csm").join("run")).unwrap().count(), 0);
}

/// Windows: out of the sandbox the host says so and loads nothing, so a mistake in `sandbox.rs` ends
/// in a refusal. (On Linux the host installs its own filter, so it is confined wherever it starts.)
#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn an_unconfined_host_refuses_to_load() {
    use std::process::{Command, Stdio};
    let mut c = Command::new(build_dir().join("gwb-csm-host.exe")).arg(lib("gwb_mock_csm_plugin")).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let (mut w, mut r) = (c.stdin.take().unwrap(), c.stdout.take().unwrap());
    proto::write_frame(&mut w, Op::Hello, 1, &[]).unwrap();
    let (st, p) = proto::read_reply(&mut r, 1).unwrap();
    assert_eq!(st, Status::Sandbox);
    assert!(proto::parse_strings(&p, Some(4)).unwrap()[3].contains("AppContainer NO"));
    proto::write_frame(&mut w, Op::Load, 2, &[]).unwrap();
    assert_eq!(proto::read_reply(&mut r, 2).unwrap().0, Status::Sandbox);
    drop(w);
    assert!(c.wait().unwrap().success());
}

/// The host's own side of the wire, with no sidecar logic between: frames it must refuse.
#[tokio::test(flavor = "multi_thread")]
async fn the_host_refuses_bad_frames() {
    let build = build_dir();
    let run = std::env::temp_dir().join(format!("gwb-csm-wire-{}", gwb_sidecar::util::random_hex(6)));
    std::fs::create_dir_all(&run).unwrap();
    create_low_dir(&sandbox::scratch(&run)).unwrap();
    let exe_name = format!("gwb-csm-host{}", std::env::consts::EXE_SUFFIX);
    for f in std::fs::read_dir(&build).unwrap().flatten() {
        let n = f.file_name().to_string_lossy().into_owned();
        if !n.contains("mock") && f.path().is_file() {
            std::fs::copy(f.path(), run.join(&n)).unwrap();
        }
    }
    let mock = run.join("plugin.bin");
    std::fs::copy(lib("gwb_mock_csm_plugin"), &mock).unwrap();
    let limits = JobLimits { memory_bytes: 1 << 30, cpu_seconds: 30, processes: 1 };
    let spawn = || sandbox::spawn(&run, &run.join(&exe_name), &mock, limits).unwrap();

    let mut host = spawn();
    let call = |id: u32, op: Op, p: &[u8], host: &mut sandbox::Sandboxed| {
        proto::write_frame(&mut host.stdin, op, id, p).unwrap();
        proto::read_reply(&mut host.stdout, id).unwrap()
    };
    let (st, p) = call(1, Op::Hello, &[], &mut host);
    assert_eq!(st, Status::Ok, "{:?}", proto::parse_strings(&p, None));
    assert_eq!(proto::parse_strings(&p, Some(4)).unwrap()[1], "1");
    // Out of order.
    assert_eq!(call(2, Op::Open, &proto::strings(&["a", ""]), &mut host).0, Status::NotReady);
    assert_eq!(call(3, Op::G2i, &proto::numbers(&[1.0, 2.0, 3.0, 0.1]), &mut host).0, Status::NotReady);
    assert_eq!(call(4, Op::Hello, b"x", &mut host).0, Status::BadRequest);
    // An unknown operation number: only the sidecar's Rust enum stops it elsewhere.
    host.stdin.write_all(&[0x47, 0x43, 0x53, 0x51, 99, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]).unwrap();
    assert_eq!(proto::read_reply(&mut host.stdout, 5).unwrap().0, Status::BadRequest);
    // A wrong magic ends the host.
    host.stdin.write_all(&[0u8; 16]).unwrap();
    assert!(proto::read_reply(&mut host.stdout, 6).is_err());
    drop(host);

    // A length over the limit ends it too, without reading a byte of what is promised.
    let mut host = spawn();
    let mut f = proto::frame(Op::Hello, 1, &[]);
    f[12..16].copy_from_slice(&(proto::MAX_PAYLOAD + 1).to_le_bytes());
    host.stdin.write_all(&f).unwrap();
    assert!(proto::read_reply(&mut host.stdout, 1).is_err());
    drop(host);

    // Random frames: it answers or ends; it does not hang (the read would block the test).
    let mut x = 0xDEADBEEFu64;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for _ in 0..12 {
        let mut host = spawn();
        let payload: Vec<u8> = (0..(next() % 64)).map(|_| next() as u8).collect();
        let op = [Op::Open, Op::G2i, Op::I2g, Op::Partials, Op::Covariance][(next() % 5) as usize];
        let f = proto::frame(op, 9, &payload);
        host.stdin.write_all(&f).unwrap();
        let r = proto::read_reply(&mut host.stdout, 9);
        assert!(matches!(r, Ok((Status::BadRequest | Status::NotReady, _))), "{op:?}: {r:?}");
        drop(host);
    }
    std::fs::remove_dir_all(&run).ok();
}
