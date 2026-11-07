//! The native stereo viewer's routes (REQ-GAP-33): what the sidecar does for it, with the fake tool
//! standing in for both GDAL and the viewer (a process that stays until killed). The viewer itself
//! is tested in `gwb-stereo`, and the two together in `tests/e2e/sidecar/26-native.spec.js`. A session
//! needs a test device, so it has its own process: `tests/stereo_session.rs`.
#![cfg(windows)]

mod common;
use common::*;
use serde_json::json;

async fn start_stereo(device: Option<&str>) -> H {
    let exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_gwb-fake-tool"));
    let d = device.map(str::to_string);
    start_with(move |c| {
        c.stereo_exe = exe;
        c.test_stereo_device = d;
    })
    .await
}

async fn file(h: &H, name: &str, spec: &str) -> String {
    upload(h, name, spec.as_bytes()).await
}

async fn open(h: &H, l: &str, r: &str) -> Resp {
    Req::new("POST", "/v1/stereo").json(json!({ "left": l, "right": r })).send(h.port).await
}

fn feed<'a>(path: &'a str, t: Option<&'a str>) -> Req<'a> {
    Req::new("GET", path).origin(None).token(t)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_headless_sidecar_opens_no_window() {
    // No test device, headless: refused before anything starts. This is why no test here or in a
    // later run can put a viewer on the desktop.
    let h = start_stereo(None).await;
    let a = file(&h, "a.tif", "VIEW GTiff 600 600 1 Byte\n").await;
    let r = open(&h, &a, &a).await;
    assert_eq!(r.status, 409, "{}", r.text());
    assert_eq!(r.json()["code"], json!("no_display"));
    let caps = Req::new("GET", "/v1/caps").send(h.port).await.json();
    assert_eq!(caps["features"]["stereo_viewer"], json!(false));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_test_device_flag_needs_a_test_run() {
    // Config::from_args refuses it outside GWB_SIDECAR_TEST=1, and `open` ignores it even if set.
    let e = gwb_sidecar::config::Config::from_args(&["--test-stereo-device".to_string(), "soft-quad".to_string()]).unwrap_err();
    assert!(e.contains("GWB_SIDECAR_TEST"), "{e}");
    let h = start_stereo(Some("soft-quad")).await;
    let a = file(&h, "a.tif", "VIEW GTiff 600 600 1 Byte\n").await;
    let r = open(&h, &a, &a).await;
    assert_eq!(r.json()["code"], json!("no_display"), "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn refusals_by_name() {
    let h = start_with(|c| c.stereo_exe = std::path::PathBuf::from("Z:/no/such/viewer.exe")).await;
    let a = file(&h, "a.tif", "VIEW GTiff 600 600 1 Byte\n").await;
    // Unknown ids, another owner's file, and fields that are not on the list.
    assert_eq!(open(&h, "0123456789abcdef0123456789abcdef", &a).await.status, 404);
    assert_eq!(open(&h, &a, "nonsense").await.status, 404);
    let r = Req::new("POST", "/v1/stereo").json(json!({"left": a, "right": a, "exe": "calc.exe"})).send(h.port).await;
    assert_eq!(r.status, 400);
    let r = Req::new("POST", "/v1/stereo").json(json!({"left": a, "right": a, "mode": "holographic"})).send(h.port).await;
    assert_eq!(r.status, 400);
    assert_eq!(open(&h, &a, &a).await.json()["code"], json!("no_display"));
}

#[tokio::test(flavor = "multi_thread")]
async fn no_route_without_a_token_or_from_a_browser() {
    let h = start().await;
    assert_eq!(Req::new("POST", "/v1/stereo").token(None).json(json!({"left": "a", "right": "b"})).send(h.port).await.status, 401);
    let id = "0123456789abcdef01234567";
    for p in [format!("/stereo/v1/{id}/scene"), format!("/stereo/v1/{id}/tile/left/0/0/0")] {
        assert_eq!(feed(&p, None).send(h.port).await.status, 401, "{p}");
        assert_eq!(feed(&p, Some(TOKEN)).send(h.port).await.status, 401, "a pairing token is not a ticket: {p}");
        let r = Req::new("GET", &p).origin(Some("null")).send(h.port).await;
        assert_eq!(r.status, 403, "{p}");
        assert_eq!(r.json()["code"], json!("browser_refused"));
        assert!(r.header("access-control-allow-origin").is_none());
    }
}
