//! A stereo session from open to close. It needs a test device, so this binary sets
//! `GWB_SIDECAR_TEST=1` for its own process (the other suites need it unset). The fake tool stands
//! in for GDAL and for the viewer: a process that stays until it is killed.
#![cfg(windows)]

mod common;
use common::*;
use gwb_sidecar_api::{StereoMode, StereoReport, StereoState};
use serde_json::json;
use std::time::{Duration, Instant};

fn test_run() {
    unsafe { std::env::set_var("GWB_SIDECAR_TEST", "1") };
}

async fn start_stereo() -> H {
    test_run();
    let exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_gwb-fake-tool"));
    start_with(move |c| {
        c.stereo_exe = exe;
        c.test_stereo_device = Some("soft-quad".into());
    })
    .await
}

async fn open(h: &H, l: &str, r: &str) -> Resp {
    Req::new("POST", "/v1/stereo").json(json!({ "left": l, "right": r })).send(h.port).await
}

fn feed<'a>(path: &'a str, t: Option<&'a str>) -> Req<'a> {
    Req::new("GET", path).origin(None).token(t)
}

async fn session(h: &H) -> (String, String) {
    let a = upload(h, "a.tif", b"VIEW GTiff 1300 700 1 Byte\n").await;
    let b = upload(h, "b.tif", b"VIEW GTiff 1300 700 3 Byte\n").await;
    let r = open(h, &a, &b).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let id = r.json()["id"].as_str().unwrap().to_string();
    let t = h.svc.stereo.test_ticket(&id).unwrap();
    (id, t)
}

async fn gone(h: &H, id: &str) {
    let t = Instant::now();
    while h.svc.stereo.get(id, "null").is_some() {
        assert!(t.elapsed() < Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_feeds_tiles_and_ends() {
    let h = start_stereo().await;
    let (id, t) = session(&h).await;
    let scene = feed(&format!("/stereo/v1/{id}/scene"), Some(&t)).send(h.port).await;
    assert_eq!(scene.status, 200, "{}", scene.text());
    let s = scene.json();
    assert_eq!(s["tile"], json!(512));
    assert_eq!(s["left"]["width"], json!(1300));
    assert_eq!(s["left"]["levels"], json!([[1300, 700], [650, 350], [325, 175]]));
    assert_eq!(s["right"]["affine"], json!([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]));
    assert!(!scene.text().contains(":\\") && !scene.text().contains("/data/"), "no path reaches the viewer");

    // Grey from one band, the first three of three, in RGBA; the fake tool's sample rule gives the
    // value at each position.
    let r = feed(&format!("/stereo/v1/{id}/tile/left/0/0/0"), Some(&t)).send(h.port).await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.body.len(), 512 * 512 * 4);
    let at = |b: &[u8], x: usize, y: usize| b[(y * 512 + x) * 4..(y * 512 + x) * 4 + 4].to_vec();
    assert_eq!(at(&r.body, 10, 20), vec![50, 50, 50, 255]);
    let r = feed(&format!("/stereo/v1/{id}/tile/right/0/1/0"), Some(&t)).send(h.port).await;
    assert_eq!(at(&r.body, 3, 4), vec![((512 + 3 + 8) % 251) as u8, ((512 + 3 + 8 + 3) % 251) as u8, ((512 + 3 + 8 + 6) % 251) as u8, 255]);

    for bad in [format!("/stereo/v1/{id}/tile/left/9/0/0"), format!("/stereo/v1/{id}/tile/left/0/99/0"), format!("/stereo/v1/{id}/tile/middle/0/0/0")] {
        assert_eq!(feed(&bad, Some(&t)).send(h.port).await.status, 404, "{bad}");
    }
    assert_eq!(feed(&format!("/stereo/v1/{id}/tile/left/x/0/0"), Some(&t)).send(h.port).await.status, 400);
    // The ticket is this session's.
    let other = "f".repeat(64);
    assert_eq!(feed(&format!("/stereo/v1/{id}/scene"), Some(&other)).send(h.port).await.status, 401);
    assert_eq!(feed(&format!("/stereo/v1/{id}/scene"), Some(TOKEN)).send(h.port).await.status, 401);

    // The viewer reports; the page reads.
    let rep = StereoReport { state: StereoState::Showing, shown: StereoMode::Quad, quad_available: true, frames: 3, detail: Some("a\r\nb".into()), readback: None };
    let r = Req::new("POST", &format!("/stereo/v1/{id}/report")).origin(None).token(Some(&t)).json(serde_json::to_value(&rep).unwrap()).send(h.port).await;
    assert_eq!(r.status, 204, "{}", r.text());
    let i = Req::new("GET", &format!("/v1/stereo/{id}")).send(h.port).await.json();
    assert_eq!(i["state"], json!("showing"));
    assert_eq!(i["shown"], json!("quad"));
    assert_eq!(i["quad_available"], json!(true));
    assert_eq!(i["detail"], json!("ab"), "no control characters reach the log or the dialog");

    // Another page cannot read or close it.
    let t2 = "d".repeat(64);
    h.svc.pairings.add_token("null", &t2, "second page");
    assert_eq!(Req::new("GET", &format!("/v1/stereo/{id}")).token(Some(&t2)).send(h.port).await.status, 404);
    assert_eq!(Req::new("DELETE", &format!("/v1/stereo/{id}")).token(Some(&t2)).send(h.port).await.status, 404);

    // Closing ends the process, the ticket and the views.
    assert_eq!(Req::new("DELETE", &format!("/v1/stereo/{id}")).send(h.port).await.status, 204);
    assert_eq!(feed(&format!("/stereo/v1/{id}/scene"), Some(&t)).send(h.port).await.status, 401);
    assert_eq!(Req::new("GET", &format!("/v1/stereo/{id}")).send(h.port).await.status, 404);
    assert!(!h.svc.cfg.data_dir.join("views").exists() || std::fs::read_dir(h.svc.cfg.data_dir.join("views")).unwrap().next().is_none(), "the views went");
    let log: Vec<String> = h.svc.log.lock().unwrap().iter().cloned().collect();
    assert!(log.iter().any(|l| l.contains("stereo viewer") && l.contains("opened for null")), "{log:?}");
    assert!(log.iter().any(|l| l.contains("closed by null")), "{log:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pair_is_refused_before_anything_starts() {
    let h = start_stereo().await;
    let good = upload(&h, "a.tif", b"VIEW GTiff 600 600 1 Byte\n").await;
    let bad = upload(&h, "b.tif", b"VIEW GTiff 600 600 1 CFloat32\n").await;
    let r = open(&h, &good, &bad).await;
    assert_eq!(r.status, 422, "{}", r.text());
    assert_eq!(r.json()["code"], json!("not_viewable"));
    assert_eq!(h.svc.stereo.status().open, 0);
    assert!(std::fs::read_dir(h.svc.cfg.data_dir.join("views")).unwrap().next().is_none(), "the left eye's view went too");
    for a in [json!([0.0, 0.0, 0.0, 0.0, 0.0, 0.0]), json!([1.0, 2.0, 0.0, 2.0, 4.0, 0.0]), json!([1e300, 0.0, 0.0, 0.0, 1.0, 0.0])] {
        let r = Req::new("POST", "/v1/stereo").json(json!({"left": good, "right": good, "left_affine": a})).send(h.port).await;
        assert_eq!(r.status, 400, "{}", r.text());
        assert_eq!(r.json()["code"], json!("bad_affine"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_viewers_at_most_and_forgetting_closes_them() {
    let h = start_stereo().await;
    let (a, _) = session(&h).await;
    let (b, _) = session(&h).await;
    let f = upload(&h, "c.tif", b"VIEW GTiff 600 600 1 Byte\n").await;
    let r = open(&h, &f, &f).await;
    assert_eq!(r.status, 409, "{}", r.text());
    assert_eq!(r.json()["code"], json!("busy"));
    assert_eq!(Req::new("DELETE", "/v1/pair").send(h.port).await.status, 204);
    gone(&h, &a).await;
    gone(&h, &b).await;
    assert_eq!(h.svc.stereo.status().open, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_that_dies_is_reported() {
    test_run();
    // Only the fake tool stands in for the viewer here. A real program of ours may show a dialog on
    // an argument it does not know (gwb-sidecar-setup does), and no test may do that.
    let h = start_with(|c| {
        c.stereo_exe = std::path::PathBuf::from(env!("CARGO_BIN_EXE_gwb-fake-tool"));
        c.test_stereo_device = Some("soft-mono".into());
    })
    .await;
    let a = upload(&h, "a.tif", b"VIEW GTiff 600 600 1 Byte\n").await;
    let r = open(&h, &a, &a).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let id = r.json()["id"].as_str().unwrap().to_string();
    let t = Instant::now();
    loop {
        let i = Req::new("GET", &format!("/v1/stereo/{id}")).send(h.port).await.json();
        if i["state"] != json!("starting") {
            assert_eq!(i["state"], json!("failed"), "{i}");
            assert!(i["detail"].as_str().unwrap().contains("no OpenGL pixel format"), "{i}");
            break;
        }
        assert!(t.elapsed() < Duration::from_secs(20), "{i}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(h.svc.stereo.status().open, 0);
}
