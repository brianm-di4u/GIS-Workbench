//! The sidecar window: pairing approval, revocation, allowed origins, modules, jobs and logs.
//! It is a local page served only on `http://localhost:<port>/ui/` (a different origin from the
//! API's `/app/`), opened with a one-time launch code, and every admin call carries the window's
//! own secret. Its CSP forbids framing (no click-jacking of "Allow").

use crate::service::Service;
use crate::util;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

const HTML: &str = include_str!("../../ui/index.html");
const JS: &str = include_str!("../../ui/ui.js");
const CSS: &str = include_str!("../../ui/ui.css");
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

pub fn router() -> Router<Arc<Service>> {
    let r = Router::new();
    #[cfg(feature = "cors-relay")]
    let r = r.route("/ui/api/cors-origin", post(cors_origin));
    r
        .route("/ui/", get(page))
        .route("/ui/ui.js", get(|| async { asset(JS, "text/javascript; charset=utf-8") }))
        .route("/ui/ui.css", get(|| async { asset(CSS, "text/css; charset=utf-8") }))
        .route("/ui/api/session", post(session))
        .route("/ui/api/launch", post(launch))
        .route("/ui/api/state", get(state))
        .route("/ui/api/decide", post(decide))
        .route("/ui/api/revoke", post(revoke))
        .route("/ui/api/origin", post(origin))
        .route("/ui/api/jobs/{id}/cancel", post(cancel_job))
        .route("/ui/api/refresh", post(refresh))
        .route("/ui/api/modules", post(modules))
        .route("/ui/api/quit", post(quit))
}

fn asset(body: &'static str, ct: &'static str) -> Response {
    let mut r = body.into_response();
    let h = r.headers_mut();
    h.insert("content-type", HeaderValue::from_static(ct));
    h.insert("content-security-policy", HeaderValue::from_static(CSP));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    r
}

async fn page() -> Response {
    asset(HTML, "text/html; charset=utf-8")
}

fn deny(msg: &str) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(json!({"code": "forbidden", "error": msg}))).into_response()
}

/// Same-origin (Origin absent or exactly the window's origin) and the window's secret.
pub(crate) fn admin_ok(svc: &Service, h: &HeaderMap) -> bool {
    if let Some(o) = h.get("origin").and_then(|v| v.to_str().ok()) {
        if o != svc.ui_origin() {
            return false;
        }
    }
    if let Some(s) = h.get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
        if s != "same-origin" {
            return false;
        }
    }
    let Some(got) = h.get("x-gwb-admin").and_then(|v| v.to_str().ok()) else { return false };
    let cur = svc.admin.session.lock().unwrap().clone();
    let ok = cur.is_some_and(|s| util::ct_eq(s.as_bytes(), got.as_bytes()));
    if ok {
        *svc.admin.last_poll.lock().unwrap() = Some(Instant::now());
    }
    ok
}

pub(crate) fn body_json<T: serde::de::DeserializeOwned>(b: &Bytes) -> Option<T> {
    if b.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice(b).ok()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionReq {
    launch: String,
}

/// Trade a one-time launch code for the window's secret (a new window replaces the old one).
async fn session(State(svc): State<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if h.get("origin").and_then(|v| v.to_str().ok()).is_some_and(|o| o != svc.ui_origin()) {
        return deny("wrong origin");
    }
    let Some(r) = body_json::<SessionReq>(&b) else { return deny("bad request") };
    let ok = {
        let mut m = svc.admin.launch.lock().unwrap();
        let ok = m.get(&r.launch).is_some_and(|t| t.elapsed().as_secs() < 120);
        m.remove(&r.launch);
        ok
    };
    if !ok {
        return deny("this link has been used or is too old: open the sidecar window from its tray icon or Start menu entry");
    }
    let s = util::random_hex(32);
    *svc.admin.session.lock().unwrap() = Some(s.clone());
    axum::Json(json!({"secret": s})).into_response()
}

/// A second start of the sidecar asks the running one for a launch link, proving it can read
/// `<data>/ui.key` (only the same Windows user can).
async fn launch(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if h.contains_key("origin") {
        return deny("not from a page");
    }
    let Some(k) = h.get("x-gwb-key").and_then(|v| v.to_str().ok()) else { return deny("no key") };
    if !util::ct_eq(k.as_bytes(), svc.admin.key.as_bytes()) {
        return deny("bad key");
    }
    axum::Json(json!({"url": svc.ui_url()})).into_response()
}

/// The relay's list, only in a build that has it and only while its gate is open.
#[cfg(feature = "cors-relay")]
fn cors_state(svc: &Service) -> serde_json::Value {
    if svc.cfg.cors_relay_open() {
        json!({ "origins": svc.cors.entries() })
    } else {
        serde_json::Value::Null
    }
}

#[cfg(not(feature = "cors-relay"))]
fn cors_state(_: &Service) -> serde_json::Value {
    serde_json::Value::Null
}

#[cfg(feature = "cors-relay")]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CorsOrigin {
    origin: String,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    remove: bool,
}

/// The relay's list changes here and nowhere else: this window's secret, no page.
#[cfg(feature = "cors-relay")]
async fn cors_origin(State(svc): State<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    if !svc.cfg.cors_relay_open() {
        return deny("the CORS relay is off");
    }
    let Some(r) = body_json::<CorsOrigin>(&b) else { return deny("bad request") };
    if r.remove {
        let ok = svc.cors.remove(&r.origin);
        svc.log(format!("cors-relay: {} taken off the list", r.origin.chars().filter(|c| !c.is_control()).take(120).collect::<String>()));
        return axum::Json(json!({"ok": ok})).into_response();
    }
    match svc.cors.set(&r.origin, r.private) {
        Ok(o) => {
            svc.log(format!("cors-relay: {o} listed{}", if r.private { " as private" } else { "" }));
            axum::Json(json!({"ok": true, "origin": o})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, axum::Json(json!({"error": e}))).into_response(),
    }
}

async fn state(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("open the window from the tray icon");
    }
    let jobs: Vec<_> = svc.jobs.list(None).iter().take(200).map(|e| json!({"owner": e.owner, "job": e.snapshot()})).collect();
    let log: Vec<String> = svc.log.lock().unwrap().iter().rev().take(300).cloned().collect();
    let caps = crate::server::caps_of(&svc);
    let errors = svc.caps.snap.lock().unwrap().errors.clone();
    let paired: Vec<_> = svc.pairings.paired().into_iter().map(|(o, n, c)| json!({"origin": o, "tokens": n, "since": c})).collect();
    axum::Json(json!({
        "version": env!("CARGO_PKG_VERSION"),
        "port": svc.port,
        "started": svc.started,
        "data_dir": svc.cfg.data_dir.display().to_string(),
        "pending": svc.pairings.list_pending(),
        "paired": paired,
        "relay": svc.relay.status(),
        "sync": svc.sync.status(),
        "stereo": svc.stereo.status(),
        "cors_relay": cors_state(&svc),
        "csm": crate::csmhost::window_state(&svc),
        "origins": {"null": svc.cfg.allow_null_origin, "config": svc.cfg.allowed_origins, "added": svc.pairings.extra_origins(), "app": svc.app_origin()},
        "modules": caps.modules,
        "vendor": caps.vendor,
        "tools": caps.tools,
        "profiles": caps.profiles.iter().map(|p| json!({"id": p.id, "title": p.title, "available": p.available})).collect::<Vec<_>>(),
        "limits": caps.limits,
        "caps_errors": errors,
        "jobs": jobs,
        "log": log,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decide {
    id: String,
    approve: bool,
}

async fn decide(State(svc): State<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    let Some(r) = body_json::<Decide>(&b) else { return deny("bad request") };
    match svc.pairings.decide(&r.id, r.approve) {
        Ok(()) => {
            svc.log(format!("pairing {} {}", r.id.chars().take(8).collect::<String>(), if r.approve { "approved" } else { "denied" }));
            axum::Json(json!({"ok": true})).into_response()
        }
        Err(e) => (StatusCode::CONFLICT, axum::Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OriginReq {
    origin: String,
    #[serde(default)]
    allow: Option<bool>,
}

async fn revoke(State(svc): State<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    let Some(r) = body_json::<OriginReq>(&b) else { return deny("bad request") };
    let had = svc.pairings.revoke(&r.origin);
    svc.relay.detach_where(|o, _| o == r.origin);
    svc.sync.detach_where(|o, _| o == r.origin);
    svc.log(format!("revoked {}", r.origin));
    axum::Json(json!({"ok": had})).into_response()
}

async fn origin(State(svc): State<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    let Some(r) = body_json::<OriginReq>(&b) else { return deny("bad request") };
    match crate::security::normalise_origin(&r.origin) {
        Ok(o) => {
            svc.pairings.set_origin(&o, r.allow.unwrap_or(true));
            svc.log(format!("origin {o} {}", if r.allow.unwrap_or(true) { "allowed" } else { "removed" }));
            axum::Json(json!({"ok": true, "origin": o})).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, axum::Json(json!({"error": e}))).into_response(),
    }
}

async fn cancel_job(State(svc): State<Arc<Service>>, h: HeaderMap, UrlPath(id): UrlPath<String>) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    match svc.jobs.list(None).into_iter().find(|e| e.snapshot().id == id) {
        Some(e) => {
            crate::jobs::cancel(&e);
            axum::Json(json!({"ok": true})).into_response()
        }
        None => (StatusCode::NOT_FOUND, axum::Json(json!({"error": "no such job"}))).into_response(),
    }
}

async fn refresh(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    svc.caps.refresh().await;
    axum::Json(json!({"ok": true})).into_response()
}

/// Adding or removing modules (and the vendor plug-ins, with their licences) is done by the
/// separate setup program, so this service itself never connects to the network (REQ-SDC-14).
async fn modules(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    let name = format!("gwb-sidecar-setup{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(&name)));
    match exe.filter(|p| p.is_file()) {
        Some(p) => match std::process::Command::new(&p).arg("--modules").spawn() {
            Ok(_) => axum::Json(json!({"ok": true})).into_response(),
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, axum::Json(json!({"error": e.to_string()}))).into_response(),
        },
        None => (StatusCode::NOT_FOUND, axum::Json(json!({"error": format!("the setup program ({name}) is not installed beside the sidecar")}))).into_response(),
    }
}

async fn quit(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if !admin_ok(&svc, &h) {
        return deny("not allowed");
    }
    svc.log("quit from the sidecar window");
    crate::QUIT.notify_waiters();
    axum::Json(json!({"ok": true})).into_response()
}
