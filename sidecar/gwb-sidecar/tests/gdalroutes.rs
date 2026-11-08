//! Service-level checks of the 2.6 GDAL routes. Its own test binary: these need GWB_SIDECAR_TEST=1,
//! which security.rs must run without.
#![allow(clippy::style, clippy::complexity, clippy::perf)]

mod common;
use common::*;
use serde_json::json;

// The picker lock in the service (PICK_BUSY) is one per process and refuses a second picker with 409.
// Tests of this binary run on several threads in one process, so the two that pick take this first.
static PICKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_is_an_input_only_where_the_profile_says() {
    std::env::set_var("GWB_SIDECAR_TEST", "1");
    let folder = std::env::temp_dir().join(format!("gwb-gdb-{}", gwb_sidecar::util::random_hex(4))).join("Domains.gdb");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("a000000001.gdbtable"), b"x").unwrap();
    let pick = folder.clone();
    let h = start_with(move |c| c.test_pick = vec![pick]).await;
    let r = {
        let _one_picker = PICKING.lock().await;
        Req::new("POST", "/v1/pick").json(json!({"mode": "folder"})).send(h.port).await
    };
    assert_eq!(r.status, 200, "{}", r.text());
    let id = r.json()["files"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(job(&h, "raster-cog", &[&id], json!({})).await.status, 400);
    let r = job(&h, "gdb-catalogue", &[&id], json!({})).await;
    assert_eq!(r.status, 201, "{}", r.text());
    let j = wait(&h, r.json()["id"].as_str().unwrap()).await;
    assert_eq!(j["state"], "succeeded", "{j}");
    assert!(j["result"].is_object(), "{j}");
    assert_eq!(j["outputs"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_gate_opens_only_with_the_test_flag_in_a_test_run() {
    std::env::set_var("GWB_SIDECAR_TEST", "1");
    let closed = start().await;
    let caps = Req::new("GET", "/v1/caps").send(closed.port).await.json();
    let p = |c: &serde_json::Value| c["profiles"].as_array().unwrap().iter().find(|p| p["id"] == "pgraster-cog").unwrap()["available"].clone();
    assert_eq!(p(&caps), json!(false));
    let open = start_with(|c| c.test_allow_database = true).await;
    let caps = Req::new("GET", "/v1/caps").send(open.port).await.json();
    assert_eq!(p(&caps), json!(true));
    // Even open, a value cannot reach the connection string as anything but a plain name.
    let r = job(&open, "pgraster-cog", &[], json!({"dbname": "gis", "user": "u", "table": "t host=evil.example"})).await;
    assert_eq!(r.status, 400, "{}", r.text());
    let r = job(&open, "pgraster-cog", &[], json!({"dbname": "gis", "user": "u", "table": "t", "port": 80})).await;
    assert_eq!(r.status, 400, "{}", r.text());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tiledb_array_is_a_raster_input_and_a_group_is_refused_by_name() {
    std::env::set_var("GWB_SIDECAR_TEST", "1");
    let root = std::env::temp_dir().join(format!("gwb-tdb-{}", gwb_sidecar::util::random_hex(4)));
    let array = root.join("scene.tdb");
    let group = root.join("group.tdb");
    std::fs::create_dir_all(array.join("__schema")).unwrap();
    std::fs::create_dir_all(group.join("__group")).unwrap();
    std::fs::write(group.join("__tiledb_group.tdb"), b"").unwrap();
    let (a, g) = (array.clone(), group.clone());
    let h = start_with(move |c| c.test_pick = vec![a, g]).await;
    let r = {
        let _one_picker = PICKING.lock().await;
        Req::new("POST", "/v1/pick").json(json!({"mode": "folder"})).send(h.port).await
    };
    let ids: Vec<String> = r.json()["files"].as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap().to_string()).collect();
    for p in ["probe", "raster-cog", "raster-tiledb"] {
        let r = job(&h, p, &[&ids[0]], json!({})).await;
        assert_eq!(r.status, 201, "{p}: {}", r.text());
        wait(&h, r.json()["id"].as_str().unwrap()).await;
    }
    let r = job(&h, "raster-cog", &[&ids[1]], json!({})).await;
    assert_eq!(r.status, 400);
    assert!(r.text().contains("TileDB group"), "{}", r.text());
    // A writer that makes a folder is refused by name, before it runs for hours.
    let r = job(&h, "export-gdal", &[&ids[0]], json!({"driver": "TileDB"})).await;
    assert_eq!(r.status, 400);
    assert!(r.text().contains("writes a folder"), "{}", r.text());
    // A profile that is not about rasters takes neither.
    assert_eq!(job(&h, "vector-gpkg", &[&ids[0]], json!({})).await.status, 400);
}
