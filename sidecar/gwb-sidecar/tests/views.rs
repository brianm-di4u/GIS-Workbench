//! Views (REQ-GAP-70) against the fake tool: the whole route, its refusals and its limits. The real
//! decoders are in tests/e2e/sidecar/26-codecs.spec.js.

mod common;
use common::*;
use gwb_sidecar::views::{Layout, MAX_RANGE, META, TILE};
use serde_json::json;

async fn up(h: &H, name: &str, body: &str) -> String {
    upload(h, name, body.as_bytes()).await
}

async fn view(h: &H, name: &str, body: &str) -> serde_json::Value {
    let id = up(h, name, body).await;
    let r = Req::new("POST", "/v1/views").json(json!({ "file": id })).send(h.port).await;
    assert_eq!(r.status, 201, "{}", r.text());
    r.json()
}

async fn range(h: &H, id: &str, a: u64, b: u64) -> Resp {
    Req::new("GET", &format!("/v1/views/{id}")).header("Range", &format!("bytes={a}-{}", b - 1)).send(h.port).await
}

/// What the fake tool's image holds at a full-resolution position.
fn sample(x: u64, y: u64, band: u64) -> u8 {
    ((x + 2 * y + 3 * band) % 251) as u8
}

fn layout_of(v: &serde_json::Value) -> Layout {
    Layout::new(v["width"].as_u64().unwrap() as u32, v["height"].as_u64().unwrap() as u32, v["bands"].as_u64().unwrap() as u32, 1, 1, &[]).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_view_reads_like_a_tiff() {
    let h = start().await;
    let v = view(&h, "a.sid", "VIEW MrSID 1300 700 3 Byte\n").await;
    assert_eq!(v["driver"], "MrSID");
    assert_eq!(v["levels"], 3);
    assert_eq!(v["tile"], 512);
    let id = v["id"].as_str().unwrap();
    let size = v["size"].as_u64().unwrap();
    // HEAD: the size, no decoding.
    let r = Req::new("HEAD", &format!("/v1/views/{id}")).send(h.port).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.header("content-length"), Some(size.to_string().as_str()));
    assert_eq!(r.header("accept-ranges"), Some("bytes"));
    // The header is a BigTIFF with the template's no-data tag.
    let r = range(&h, id, 0, 16).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.header("content-range"), Some(format!("bytes 0-15/{size}").as_str()));
    assert_eq!(&r.body[..4], b"II\x2b\0");
    // Every pixel of a tile at full resolution, and only that tile's bytes.
    let l = layout_of(&v);
    let tb = l.tile_bytes;
    let off = l.levels[0].first + l.stride; // tile (1, 0)
    let r = range(&h, id, off, off + tb).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body.len() as u64, tb);
    let at = |x: u64, y: u64, b: u64| r.body[((y * 512 + x) * 3 + b) as usize];
    assert_eq!(at(0, 0, 0), sample(512, 0, 0));
    assert_eq!(at(17, 301, 2), sample(512 + 17, 301, 2));
    assert_eq!(at(511, 511, 1), sample(1023, 511, 1));
    // The last column holds 276 pixels; the rest of the tile is zero.
    let off = l.levels[0].first + l.stride * 2;
    let r = range(&h, id, off, off + tb).await;
    assert_eq!(r.body[(275 * 3) as usize], sample(1299, 0, 0));
    assert!(r.body[276 * 3..512 * 3].iter().all(|b| *b == 0));
    // An overview: each pixel stands for 2 × 2 of the image (the fake tool takes the first).
    let off = l.levels[1].first;
    let r = range(&h, id, off, off + tb).await;
    assert_eq!(r.body[((10 * 512 + 20) * 3) as usize], sample(40, 20, 0));
    // A range across two tiles.
    let off = l.levels[0].first;
    let r = range(&h, id, off + tb - 3, off + l.stride + 3).await;
    assert_eq!(r.status, 206);
    assert_eq!(r.body[..3], [sample(1023 - 512, 511, 0), sample(511, 511, 1), sample(511, 511, 2)]);
    assert_eq!(&r.body[r.body.len() - 3..], [sample(512, 0, 0), sample(512, 0, 1), sample(512, 0, 2)]);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn ranges_and_owners() {
    let h = start().await;
    let v = view(&h, "b.ecw", "VIEW ECW 5000 5000 3 Byte\n").await;
    let id = v["id"].as_str().unwrap();
    let size = v["size"].as_u64().unwrap();
    assert_eq!(v["driver"], "ECW");
    // Past the end, and malformed.
    let r = Req::new("GET", &format!("/v1/views/{id}")).header("Range", &format!("bytes={size}-")).send(h.port).await;
    assert_eq!(r.status, 416);
    assert_eq!(r.header("content-range"), Some(format!("bytes */{size}").as_str()));
    let r = Req::new("GET", &format!("/v1/views/{id}")).header("Range", "bytes=0-1,4-5").send(h.port).await;
    assert_eq!(r.status, 416);
    // Too much at once, or the whole of it.
    let r = range(&h, id, 0, MAX_RANGE + 2).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.json()["code"], "too_large");
    let r = Req::new("GET", &format!("/v1/views/{id}")).send(h.port).await;
    assert_eq!(r.status, 413);
    // No token, no view; another owner's view does not exist.
    let r = Req::new("GET", &format!("/v1/views/{id}")).token(None).send(h.port).await;
    assert_eq!(r.status, 401);
    let t2 = "f".repeat(64);
    h.svc.pairings.add_token("null", &t2, "second page");
    let r = Req::new("GET", &format!("/v1/views/{id}")).token(Some(&t2)).header("Range", "bytes=0-15").send(h.port).await;
    assert_eq!(r.status, 404);
    let r = Req::new("DELETE", &format!("/v1/views/{id}")).token(Some(&t2)).send(h.port).await;
    assert_eq!(r.status, 404);
    // Bad ids never reach the map.
    for bad in ["x", "../../etc/passwd", &"g".repeat(24)] {
        let r = Req::new("GET", &format!("/v1/views/{bad}")).send(h.port).await;
        assert!(r.status == 404, "{bad}: {}", r.status);
    }
    // Closed: gone, and its folder too.
    let r = Req::new("DELETE", &format!("/v1/views/{id}")).send(h.port).await;
    assert_eq!(r.status, 204);
    let r = range(&h, id, 0, 16).await;
    assert_eq!(r.status, 404);
    assert!(!h.svc.cfg.data_dir.join("views").join(id).exists());
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn refusals_by_name() {
    let h = start().await;
    let port = h.port;
    let open = |id: String| async move { Req::new("POST", "/v1/views").json(json!({ "file": id })).send(port).await };
    // A driver the app reads itself.
    let id = up(&h, "a.tif", "VIEW GTiff 100 100 1 Byte\n").await;
    let r = open(id).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["code"], "not_viewable");
    assert!(r.text().contains("a.tif is GTiff"), "{}", r.text());
    // Samples a view cannot carry; bands of different types come through the unit test.
    let id = up(&h, "c.sid", "VIEW MrSID 100 100 1 CFloat32\n").await;
    let r = open(id).await;
    assert_eq!(r.status, 422);
    assert!(r.text().contains("CFloat32"), "{}", r.text());
    // A pointer file never reaches a tool.
    let id = up(&h, "p.sid", "<VRTDataset rasterXSize='1'><SourceFilename>C:/secret.sid</SourceFilename></VRTDataset>").await;
    let r = open(id).await;
    assert_eq!(r.status, 422);
    assert_eq!(r.json()["code"], "pointer_file");
    // Unknown file, and a body with more than the schema allows.
    let r = open("0".repeat(32)).await;
    assert_eq!(r.status, 404);
    let r = Req::new("POST", "/v1/views").json(json!({ "file": "x", "path": "C:/secret.sid" })).send(h.port).await;
    assert_eq!(r.status, 400);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_that_fails_or_dies_is_a_named_error_and_can_be_retried() {
    let h = start().await;
    let v = view(&h, "d.sid", "VIEW MrSID 600 600 1 Byte\nDIE\n").await;
    let id = v["id"].as_str().unwrap();
    let l = layout_of(&v);
    let r = range(&h, id, l.levels[0].first, l.levels[0].first + 16).await;
    assert_eq!(r.status, 502);
    assert_eq!(r.json()["code"], "tool_failed");
    assert!(r.text().contains("d.sid"), "{}", r.text());
    // The header stays readable: nothing was cached of the failure.
    let r = range(&h, id, 0, 16).await;
    assert_eq!(r.status, 206);
    // The working folders of the failed runs are gone.
    let left: Vec<_> = std::fs::read_dir(h.svc.cfg.data_dir.join("views").join(id)).unwrap().flatten().collect();
    assert!(left.is_empty(), "{left:?}");
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn one_decode_per_metatile_however_many_readers() {
    let h = start().await;
    let v = view(&h, "e.sid", "VIEW MrSID 2048 2048 1 Byte\nSLOW 300\n").await;
    let id = v["id"].as_str().unwrap().to_string();
    let l = layout_of(&v);
    let first = l.levels[0].first;
    let t = std::time::Instant::now();
    // All 16 tiles of the one metatile at once.
    assert_eq!(l.levels[0].tiles_x * l.levels[0].tiles_y, META * META);
    let mut set = tokio::task::JoinSet::new();
    for i in 0..16u64 {
        let (port, id, off) = (h.port, id.clone(), first + i * l.stride);
        set.spawn(async move { Req::new("GET", &format!("/v1/views/{id}")).header("Range", &format!("bytes={off}-{}", off + 511)).send(port).await });
    }
    while let Some(r) = set.join_next().await {
        assert_eq!(r.unwrap().status, 206);
    }
    // Serial, the 300 ms tool would take 4.8 s over 16 runs.
    assert!(t.elapsed().as_secs_f64() < 3.0, "{:?}", t.elapsed());
    // A second pass reads the cache.
    let t = std::time::Instant::now();
    let r = range(&h, &id, first + 3 * l.stride, first + 3 * l.stride + 512).await;
    assert_eq!(r.status, 206);
    assert!(t.elapsed().as_millis() < 250, "{:?}", t.elapsed());
    assert_eq!(TILE, 512);
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_that_leaves_stops_its_decode() {
    let h = start().await;
    let v = view(&h, "f.sid", "VIEW MrSID 600 600 1 Byte\nSLOW 30000\n").await;
    let id = v["id"].as_str().unwrap().to_string();
    let l = layout_of(&v);
    let first = l.levels[0].first;
    // Ask, then close the socket after a moment: the tool (which would sleep 30 s) must go.
    let req = format!("GET /v1/views/{id} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nOrigin: null\r\nAuthorization: Bearer {TOKEN}\r\nRange: bytes={first}-{}\r\nConnection: close\r\n\r\n", h.port, first + 15);
    let dir = h.svc.cfg.data_dir.join("views").join(&id);
    {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", h.port)).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut s, req.as_bytes()).await.unwrap();
        for _ in 0..100 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if std::fs::read_dir(&dir).map(|d| d.flatten().count()).unwrap_or(0) > 0 {
                break;
            }
        }
    }
    // The next read of the same metatile starts its own run at once: a new permit was free, so
    // the first run did not keep it. The tool's folder of the dropped run stays until the view closes.
    let t = std::time::Instant::now();
    let r = Req::new("DELETE", &format!("/v1/views/{id}")).send(h.port).await;
    assert_eq!(r.status, 204);
    assert!(t.elapsed().as_secs() < 5, "{:?}", t.elapsed());
    for _ in 0..100 {
        if !dir.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = std::fs::remove_dir_all(&dir);
    }
    assert!(!dir.exists(), "a tool still holds the view's folder");
    std::fs::remove_dir_all(&h.dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn old_views_are_swept_and_owners_keep_at_most_sixteen() {
    let h = start().await;
    let mut ids = vec![];
    for i in 0..17 {
        ids.push(view(&h, &format!("v{i}.sid"), "VIEW MrSID 100 100 1 Byte\n").await["id"].as_str().unwrap().to_string());
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    let r = range(&h, &ids[0], 0, 16).await;
    assert_eq!(r.status, 404, "the oldest view made way");
    let r = range(&h, &ids[16], 0, 16).await;
    assert_eq!(r.status, 206);
    assert_eq!(h.svc.views.sweep(std::time::Duration::from_secs(3600)), 0);
    assert_eq!(h.svc.views.sweep(std::time::Duration::ZERO), 16);
    let r = range(&h, &ids[16], 0, 16).await;
    assert_eq!(r.status, 404);
    std::fs::remove_dir_all(&h.dir).ok();
}
