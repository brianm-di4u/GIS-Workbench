//! HTTP API (Appendix D §8.2). Every request first passes `guard`: Host allow-list, zone, Origin
//! allow-list, CORS preflight, bearer token. Bodies are size-limited and schema-checked
//! (`deny_unknown_fields`), and handlers only ever see file ids, never paths.

use crate::files::FileRec;
use crate::jobs::{self, JobEntry};
use crate::paths::safe_name;
use crate::prosync::{self, SyncError, SYNC_ORIGIN};
use crate::relay::{self, RelayError, RELAY_ORIGIN};
use crate::security::{self, HostKind, Zone};
use crate::service::Service;
use crate::{appserve, picker, stereo, ui, util, views};
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Extension, Router};
use futures_util::StreamExt;
use gwb_sidecar_api::*;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Clone)]
pub struct Caller {
    pub origin: String,
    /// Who owns files and jobs: the origin plus its pairing token, so two pages of the same
    /// origin (two browser profiles, or every file:// page, which all share "null") stay apart.
    pub owner: String,
    pub token: Option<String>,
    pub authed: bool,
}

pub struct ApiError(pub StatusCode, pub &'static str, pub String);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = serde_json::to_vec(&ErrorBody { code: self.1.into(), error: self.2 }).unwrap_or_default();
        let mut r = (self.0, body).into_response();
        r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
        r
    }
}

pub(crate) fn err(s: u16, code: &'static str, msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::from_u16(s).unwrap_or(StatusCode::BAD_REQUEST), code, msg.into())
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

pub(crate) fn json<T: serde::Serialize>(s: StatusCode, v: &T) -> Response {
    let mut r = (s, serde_json::to_vec(v).unwrap_or_default()).into_response();
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/json"));
    r
}

/// A JSON body: content type checked, size limited (DefaultBodyLimit), unknown fields refused.
pub(crate) fn parse<T: DeserializeOwned>(h: &HeaderMap, body: &Bytes) -> ApiResult<T> {
    let ct = h.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !ct.to_ascii_lowercase().starts_with("application/json") {
        return Err(err(415, "bad_content_type", "the body must be application/json"));
    }
    serde_json::from_slice(body).map_err(|e| err(400, "bad_request", format!("the request does not match the API schema: {e}")))
}

pub fn router(svc: Arc<Service>) -> Router {
    let api = Router::new()
        .route("/v1/hello", get(hello))
        .route("/v1/pair", post(pair_start).delete(pair_forget))
        .route("/v1/pair/{id}", get(pair_poll))
        .route("/v1/caps", get(caps))
        .route("/v1/caps/drivers/{name}", get(driver_detail))
        .route("/v1/jobs", post(job_create).get(job_list))
        .route("/v1/jobs/{id}", get(job_get).delete(job_cancel))
        .route("/v1/jobs/{id}/events", get(job_events))
        .route("/v1/jobs/{id}/log", get(job_log))
        .route("/v1/jobs/{id}/retry", post(job_retry))
        .route("/v1/batch", post(batch))
        .route("/v1/pick", post(pick))
        .route("/v1/files/{id}", get(file_get).head(file_get).delete(file_delete))
        .route("/v1/files/{id}/save", post(file_save))
        .route("/v1/files", get(file_list))
        .route("/v1/views", post(view_create))
        .route("/v1/views/{id}", get(view_get).head(view_get).delete(view_delete))
        .route("/v1/stereo", post(stereo_open))
        .route("/v1/stereo/{id}", get(stereo_get).delete(stereo_close))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY));
    // Uploads stream to disk with their own limit (max_upload and the space left).
    let upload = Router::new().route("/v1/files", put(file_put)).layer(DefaultBodyLimit::disable());
    let app = Router::new().route("/app/", get(app_html)).route("/app/{which}", get(app_html_named));
    // The Python relay (REQ-GAP-02): the client side for programs, the page side for a paired page.
    let relay_clients = Router::new()
        .route("/relay/v1/hello", get(relay_hello))
        .route("/relay/v1/pair", post(relay_pair_start).delete(relay_pair_forget))
        .route("/relay/v1/pair/{id}", get(relay_pair_poll))
        .route("/relay/v1/mcp", post(relay_mcp))
        .layer(DefaultBodyLimit::max(MAX_RELAY_MESSAGE));
    let relay_page = Router::new()
        .route("/v1/relay/attach", post(relay_attach))
        .route("/v1/relay/{session}", delete(relay_detach))
        .route("/v1/relay/{session}/inbox", get(relay_inbox))
        .route("/v1/relay/{session}/reply", post(relay_reply))
        .layer(DefaultBodyLimit::max(MAX_RELAY_REPLY));
    // ArcGIS Pro sync (REQ-GAP-65): the same two sides, for a position and nothing else.
    let sync_clients = Router::new()
        .route("/sync/v1/hello", get(sync_hello))
        .route("/sync/v1/pair", post(sync_pair_start).delete(sync_pair_forget))
        .route("/sync/v1/pair/{id}", get(sync_pair_poll))
        .route("/sync/v1/state", post(sync_publish_pro))
        .route("/sync/v1/next", get(sync_next_pro))
        .layer(DefaultBodyLimit::max(MAX_SYNC_MESSAGE));
    let sync_page = Router::new()
        .route("/v1/sync/attach", post(sync_attach))
        .route("/v1/sync/{session}", delete(sync_detach))
        .route("/v1/sync/{session}/state", post(sync_publish_app))
        .route("/v1/sync/{session}/next", get(sync_next_app))
        .layer(DefaultBodyLimit::max(MAX_SYNC_MESSAGE));
    // The native viewer's feed (REQ-GAP-33).
    let stereo_feed = Router::new()
        .route("/stereo/v1/{id}/scene", get(stereo_scene))
        .route("/stereo/v1/{id}/tile/{eye}/{level}/{x}/{y}", get(stereo_tile))
        .route("/stereo/v1/{id}/report", post(stereo_report))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY));
    let extra = Router::new().merge(sync_clients).merge(sync_page).merge(stereo_feed);
    // The CORS relay (REQ-GAP-08): this route exists only in a build with the feature.
    #[cfg(feature = "cors-relay")]
    let extra = extra.route("/v1/cors-relay/fetch", post(cors_fetch).layer(DefaultBodyLimit::max(MAX_JSON_BODY)));
    Router::new()
        .merge(extra)
        .merge(api)
        .merge(upload)
        .merge(app)
        .merge(relay_clients)
        .merge(relay_page)
        .merge(crate::csmhost::router(svc.clone()))
        .merge(ui::router())
        .fallback(|| async { err(404, "not_found", "no such route") })
        .layer(middleware::from_fn_with_state(svc.clone(), guard))
        .with_state(svc)
}

const OPEN_ROUTES: [(&str, &str); 3] = [("GET", "/v1/hello"), ("POST", "/v1/pair"), ("GET", "/v1/pair/")];
const RELAY_OPEN_ROUTES: [(&str, &str); 3] = [("GET", "/relay/v1/hello"), ("POST", "/relay/v1/pair"), ("GET", "/relay/v1/pair/")];
const SYNC_OPEN_ROUTES: [(&str, &str); 3] = [("GET", "/sync/v1/hello"), ("POST", "/sync/v1/pair"), ("GET", "/sync/v1/pair/")];

async fn guard(State(svc): State<Arc<Service>>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();
    let Some(host) = security::check_host(req.headers(), svc.port) else {
        // DNS rebinding or a confused client: no CORS headers, nothing else.
        return err(421, "bad_host", "this service answers only 127.0.0.1 and localhost on its own port").into_response();
    };
    let zone = security::zone(&path);
    if (matches!(zone, Zone::Relay | Zone::Sync | Zone::Stereo) || path.starts_with("/v1/relay/") || path.starts_with("/v1/sync/")) && !security::peer_is_loopback(req.extensions().get::<ConnectInfo<std::net::SocketAddr>>().map(|c| c.0)) {
        return err(403, "not_loopback", "the relay serves this computer only").into_response();
    }
    let mut resp = match zone {
        Zone::Other => return err(404, "not_found", "no such route").into_response(),
        Zone::Relay | Zone::Sync => {
            // No page reaches this side: no CORS header, no preflight, whatever the origin.
            if security::from_a_browser(req.headers()) {
                return err(403, "browser_refused", "this side of the sidecar is for programs on this computer, not web pages").into_response();
            }
            let (name, routes) = if zone == Zone::Relay { (RELAY_ORIGIN, RELAY_OPEN_ROUTES) } else { (SYNC_ORIGIN, SYNC_OPEN_ROUTES) };
            let token = security::bearer(req.headers());
            let authed = token.as_deref().map(|t| svc.pairings.verify(name, t)).unwrap_or(false);
            let open = routes.iter().any(|(m, p)| method.as_str() == *m && (path == *p || p.ends_with('/') && path.starts_with(p)));
            if !open && !authed {
                return err(401, "unauthorized", "pair this client with the sidecar first").into_response();
            }
            req.extensions_mut().insert(Caller { origin: name.into(), owner: name.into(), token, authed });
            next.run(req).await
        }
        // One process with one ticket: `stereo_ticket` in each handler, by session. No page, no CORS.
        Zone::Stereo => {
            if security::from_a_browser(req.headers()) {
                return err(403, "browser_refused", "this feed is for the native viewer, not web pages").into_response();
            }
            next.run(req).await
        }
        Zone::App => {
            if host != HostKind::Ip {
                return err(404, "not_found", "the app is served at http://127.0.0.1:<port>/app/").into_response();
            }
            if method != Method::GET && method != Method::HEAD {
                return err(405, "method", "GET only").into_response();
            }
            next.run(req).await
        }
        Zone::Ui => {
            if host != HostKind::Localhost {
                return err(404, "not_found", "no such route").into_response();
            }
            next.run(req).await
        }
        Zone::Api => {
            let reqh = req.headers().clone();
            let origin = match security::request_origin(req.headers(), host, svc.port) {
                Ok(o) => o,
                Err(e) => return err(400, "bad_origin", e).into_response(),
            };
            if !svc.origin_allowed(&origin) {
                return err(403, "origin_not_allowed", format!("{origin} may not use this sidecar; allow it in the sidecar window first")).into_response();
            }
            let mut out = if method == Method::OPTIONS {
                if security::preflight_ok(req.headers()) {
                    StatusCode::NO_CONTENT.into_response()
                } else {
                    return err(403, "preflight", "method or header not allowed").into_response();
                }
            } else {
                let token = security::bearer(req.headers());
                let authed = token.as_deref().map(|t| svc.pairings.verify(&origin, t)).unwrap_or(false);
                let open = OPEN_ROUTES.iter().any(|(m, p)| method.as_str() == *m && (path == *p || p.ends_with('/') && path.starts_with(p)));
                if !open && !authed {
                    let mut r = err(401, "unauthorized", "pair this page with the sidecar first").into_response();
                    security::cors_headers(r.headers_mut(), &origin, req.headers(), &method);
                    return r;
                }
                let owner = match (&token, authed) {
                    (Some(t), true) => format!("{origin}#{}", &util::sha256_hex(t.to_ascii_lowercase().as_bytes())[..16]),
                    _ => origin.clone(),
                };
                req.extensions_mut().insert(Caller { origin: origin.clone(), owner, token, authed });
                next.run(req).await
            };
            security::cors_headers(out.headers_mut(), &origin, &reqh, &method);
            out
        }
    };
    let h = resp.headers_mut();
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.entry("cache-control").or_insert(HeaderValue::from_static("no-store"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("x-gwb-api", HeaderValue::from(API_LEVEL));
    resp
}

// ---------------------------------------------------------------- hello and pairing

async fn hello(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> Response {
    let h = Hello { service: "gwb-sidecar".into(), version: env!("CARGO_PKG_VERSION").into(), api: API_LEVEL, port: svc.port, paired: c.authed, origin: c.origin.clone(), channel: "preview".into() };
    // Always 200 (paired tells): a 401 here would put an error in the console of every
    // unpaired page that looks for the sidecar. Every other route answers 401 without a token.
    json(StatusCode::OK, &h)
}

async fn pair_start(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: PairRequest = parse(&h, &body)?;
    let s = svc.pairings.start(&c.origin, &r.client).map_err(|e| err(429, "busy", e))?;
    svc.log(format!("pairing request from {} ({}) code {}", c.origin, r.client.chars().take(80).collect::<String>(), s.code));
    crate::tray::pairing_requested(&svc);
    Ok(json(StatusCode::OK, &s))
}

async fn pair_poll(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    if id.len() != 48 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such pairing request"));
    }
    let st = svc.pairings.poll(&id, &c.origin).ok_or_else(|| err(404, "not_found", "no such pairing request"))?;
    Ok(json(StatusCode::OK, &st))
}

async fn pair_forget(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> ApiResult<StatusCode> {
    let t = c.token.ok_or_else(|| err(401, "unauthorized", "no token"))?;
    svc.pairings.revoke_token(&c.origin, &t);
    svc.relay.detach_where(|_, owner| owner == c.owner);
    svc.sync.detach_where(|_, owner| owner == c.owner);
    svc.stereo.close_owner(&svc, &c.owner);
    svc.log(format!("{} forgot its pairing", c.origin));
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- caps

pub fn caps_of(svc: &Service) -> Caps {
    let snap = svc.caps.snap.lock().unwrap().clone();
    let profiles = svc
        .profiles
        .iter()
        .map(|p| {
            let ok = svc.caps.installed(&p.module) && p.requires.iter().all(|m| svc.caps.installed(m)) && p.gate.as_ref().is_none_or(|g| svc.cfg.gate_open(g)) && p.steps.iter().filter(|s| !s.optional).all(|s| svc.caps.tool_available(&s.tool));
            p.info(ok)
        })
        .collect();
    Caps {
        service: "gwb-sidecar".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        api: API_LEVEL,
        modules: svc.caps.modules(),
        tools: snap.tools,
        raster_drivers: snap.raster,
        vector_drivers: snap.vector,
        pdal_readers: snap.pdal_readers,
        pdal_writers: snap.pdal_writers,
        ffmpeg_encoders: snap.ffmpeg_encoders,
        ffmpeg_decoders: snap.ffmpeg_decoders,
        vendor: svc.caps.vendor(),
        profiles,
        csm_host: crate::csmhost::caps(svc),
        limits: Limits { max_json_body: MAX_JSON_BODY as u64, max_upload: svc.cfg.max_upload, max_job_inputs: MAX_JOB_INPUTS as u32, concurrent_jobs: svc.cfg.concurrent_jobs as u32, quota_bytes: svc.cfg.quota_bytes, free_bytes: svc.space_left() },
        features: Features { stereo_viewer: stereo::available(svc), pro_sync: true, cors_relay: svc.cfg.cors_relay_open() },
    }
}

async fn caps(State(svc): State<Arc<Service>>) -> Response {
    json(StatusCode::OK, &caps_of(&svc))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DriverQuery {
    #[serde(default)]
    kind: Option<String>,
}

async fn driver_detail(State(svc): State<Arc<Service>>, UrlPath(name): UrlPath<String>, Query(q): Query<DriverQuery>) -> ApiResult<Response> {
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | ' ')) {
        return Err(err(400, "bad_request", "not a driver name"));
    }
    let d = svc.caps.driver(&name).ok_or_else(|| err(404, "not_found", format!("no driver {name}")))?;
    if !d.write {
        return Ok(json(StatusCode::OK, &DriverDetail { driver: d, creation_options: vec![] }));
    }
    let flag = match q.kind.as_deref() {
        None | Some("dataset") => {
            if d.raster {
                "-co"
            } else {
                "-dsco"
            }
        }
        Some("layer") => "-lco",
        Some(_) => return Err(err(400, "bad_request", "kind is dataset or layer")),
    };
    let co = svc.caps.ensure_creation_options(&name, flag).await.map_err(|e| err(502, "tool_failed", e))?;
    Ok(json(StatusCode::OK, &DriverDetail { driver: d, creation_options: co }))
}

// ---------------------------------------------------------------- jobs

async fn job_create(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: JobRequest = parse(&h, &body)?;
    let prep = jobs::prepare(&svc, &c.owner, &r).await.map_err(|(s, m)| err(s, "bad_job", m))?;
    let e = jobs::enqueue(&svc, &c.owner, r, prep, None).map_err(|m| err(429, "busy", m))?;
    let j = e.snapshot();
    svc.log(format!("job {} {} queued for {}", j.id, j.profile, c.origin));
    Ok(json(StatusCode::CREATED, &j))
}

async fn job_list(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> Response {
    let jobs = svc.jobs.list(Some(&c.owner)).iter().map(|e| e.snapshot()).collect();
    json(StatusCode::OK, &JobList { jobs })
}

fn job_of(svc: &Service, c: &Caller, id: &str) -> ApiResult<Arc<JobEntry>> {
    if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such job"));
    }
    svc.jobs.get(id, &c.owner).ok_or_else(|| err(404, "not_found", "no such job"))
}

async fn job_get(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    Ok(json(StatusCode::OK, &job_of(&svc, &c, &id)?.snapshot()))
}

async fn job_cancel(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let e = job_of(&svc, &c, &id)?;
    jobs::cancel(&e);
    svc.log(format!("job {id} cancelled by {}", c.origin));
    Ok(json(StatusCode::ACCEPTED, &e.snapshot()))
}

async fn job_log(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let e = job_of(&svc, &c, &id)?;
    let text = e.log.lock().unwrap().join("\n");
    let mut r = (StatusCode::OK, text).into_response();
    r.headers_mut().insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    Ok(r)
}

async fn job_retry(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let e = job_of(&svc, &c, &id)?;
    let st = e.snapshot().state;
    if st != JobState::Failed && st != JobState::Cancelled {
        return Err(err(409, "not_finished", "only a failed or cancelled job can be retried"));
    }
    let r = e.req.clone();
    let prep = jobs::prepare(&svc, &c.owner, &r).await.map_err(|(s, m)| err(s, "bad_job", m))?;
    let n = jobs::enqueue(&svc, &c.owner, r, prep, Some(id)).map_err(|m| err(429, "busy", m))?;
    Ok(json(StatusCode::CREATED, &n.snapshot()))
}

/// NDJSON progress stream (REQ-SDC-02: fetch + ReadableStream, no WebSocket).
async fn job_events(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let e = job_of(&svc, &c, &id)?;
    let (hist, rx) = e.subscribe();
    let done = hist.iter().any(|x| matches!(x, JobEvent::Done { .. }));
    struct St {
        hist: VecDeque<JobEvent>,
        rx: tokio::sync::broadcast::Receiver<JobEvent>,
        done: bool,
    }
    let st = St { hist: hist.into(), rx, done: false };
    let s = futures_util::stream::unfold(st, move |mut st| async move {
        if st.done {
            return None;
        }
        if let Some(ev) = st.hist.pop_front() {
            if matches!(ev, JobEvent::Done { .. }) {
                st.done = true;
            }
            return Some((Ok::<Bytes, std::convert::Infallible>(line(&ev)), st));
        }
        if done {
            return None;
        }
        loop {
            match tokio::time::timeout(Duration::from_secs(15), st.rx.recv()).await {
                Ok(Ok(ev)) => {
                    if matches!(ev, JobEvent::Done { .. }) {
                        st.done = true;
                    }
                    return Some((Ok(line(&ev)), st));
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => return None,
                Err(_) => return Some((Ok(Bytes::from_static(b"\n")), st)), // keep-alive
            }
        }
    });
    let mut r = Response::new(Body::from_stream(s));
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/x-ndjson"));
    Ok(r)
}

fn line(ev: &JobEvent) -> Bytes {
    let mut v = serde_json::to_vec(ev).unwrap_or_default();
    v.push(b'\n');
    Bytes::from(v)
}

async fn batch(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: BatchRequest = parse(&h, &body)?;
    let folder = svc.files.get(&r.folder, &c.owner).filter(|f| f.is_dir).ok_or_else(|| err(404, "not_found", "no such folder"))?;
    if r.extensions.is_empty() || r.extensions.len() > 16 || r.extensions.iter().any(|e| e.is_empty() || e.len() > 10 || !e.bytes().all(|b| b.is_ascii_alphanumeric())) {
        return Err(err(400, "bad_request", "extensions: 1–16 plain extensions without dots"));
    }
    let exts: Vec<String> = r.extensions.iter().map(|e| e.to_ascii_lowercase()).collect();
    let names: Vec<&String> = folder.entries.iter().filter(|n| n.rsplit_once('.').map(|(_, e)| exts.contains(&e.to_ascii_lowercase())).unwrap_or(false)).collect();
    if names.is_empty() {
        return Err(err(404, "not_found", format!("no .{} files in {}", exts.join("/."), folder.name)));
    }
    if names.len() > MAX_JOB_INPUTS {
        return Err(err(400, "bad_request", "too many files"));
    }
    let mut out = Vec::new();
    for n in names {
        let rec = svc.files.add_pick(&c.owner, &folder.path.join(n)).map_err(|e| err(400, "bad_path", e))?;
        let jr = JobRequest { profile: r.profile.clone(), inputs: vec![rec.id.clone()], options: r.options.clone(), output_name: None, reason: Some(format!("batch of {}", folder.name)) };
        let prep = jobs::prepare(&svc, &c.owner, &jr).await.map_err(|(s, m)| err(s, "bad_job", format!("{n}: {m}")))?;
        out.push(jobs::enqueue(&svc, &c.owner, jr, prep, None).map_err(|m| err(429, "busy", m))?.snapshot());
    }
    Ok(json(StatusCode::CREATED, &BatchResult { jobs: out }))
}

// ---------------------------------------------------------------- files

static PICK_BUSY: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pick(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: PickRequest = parse(&h, &body)?;
    let title: String = r.title.unwrap_or_else(|| "Choose a file for GIS Workbench".into()).chars().filter(|c| !c.is_control()).take(100).collect();
    let _g = PICK_BUSY.try_lock().map_err(|_| err(409, "busy", "a picker is already open in the sidecar"))?;
    let mode = match r.mode {
        PickMode::File => picker::Mode::File,
        PickMode::Files => picker::Mode::Files,
        PickMode::Folder => picker::Mode::Folder,
    };
    let paths = if crate::config::test_mode() && !svc.cfg.test_pick.is_empty() {
        svc.cfg.test_pick.clone()
    } else if svc.cfg.headless {
        Vec::new() // nobody is there to answer a dialog
    } else {
        let t = format!("{title} — requested by {}", if c.origin == "null" { "a local file (file://)".to_string() } else { c.origin.clone() });
        tokio::task::spawn_blocking(move || picker::pick(mode, &t)).await.unwrap_or_default()
    };
    let mut files = Vec::new();
    let mut refused = Vec::new();
    for p in paths {
        match svc.files.add_pick(&c.owner, &p) {
            Ok(r) => files.push(r.info()),
            Err(e) => refused.push(e),
        }
    }
    if files.is_empty() && !refused.is_empty() {
        return Err(err(400, "bad_path", refused.join("; ")));
    }
    svc.log(format!("{} picked {} file(s) in the sidecar", c.origin, files.len()));
    Ok(json(StatusCode::OK, &PickResult { files }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PutQuery {
    name: String,
    #[serde(default)]
    group: Option<String>,
}

async fn file_put(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, Query(q): Query<PutQuery>, h: HeaderMap, body: Body) -> ApiResult<Response> {
    let name = safe_name(&q.name).map_err(|e| err(400, "bad_name", format!("file name: {e}")))?;
    let limit = svc.cfg.max_upload;
    let left = svc.space_left();
    if let Some(len) = h.get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()) {
        if len > limit {
            return Err(err(413, "too_large", format!("uploads are limited to {} GB", limit / 1_000_000_000)));
        }
        if len > left {
            return Err(err(507, "no_space", format!("the sidecar has {} MB left for files; free some space or use Pick in sidecar", left / 1_000_000)));
        }
    }
    let (group, dir) = svc.files.upload_dir(&c.owner, q.group.as_deref()).map_err(|e| err(400, "bad_group", e))?;
    let target = dir.join(&name);
    if target.exists() {
        return Err(err(409, "exists", format!("{name} is already in this group")));
    }
    let part = dir.join(format!("{name}.part"));
    let mut f = tokio::fs::File::create(&part).await.map_err(|e| err(500, "io", e.to_string()))?;
    let mut n: u64 = 0;
    let mut stream = body.into_data_stream();
    let fail = |part: std::path::PathBuf| async move {
        let _ = tokio::fs::remove_file(&part).await;
    };
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                drop(f);
                fail(part).await;
                return Err(err(400, "aborted", "the upload was interrupted"));
            }
        };
        n += chunk.len() as u64;
        if n > limit || n > left {
            drop(f);
            fail(part).await;
            return Err(if n > limit { err(413, "too_large", "upload too large") } else { err(507, "no_space", "the disk is full") });
        }
        if let Err(e) = f.write_all(&chunk).await {
            drop(f);
            fail(part).await;
            return Err(err(507, "no_space", format!("could not write: {e}")));
        }
    }
    f.flush().await.map_err(|e| err(500, "io", e.to_string()))?;
    drop(f);
    tokio::fs::rename(&part, &target).await.map_err(|e| err(500, "io", e.to_string()))?;
    let r = FileRec { id: util::random_hex(16), name, size: n, origin: FileOrigin::Upload, owner: c.owner.clone(), path: target, group, entries: vec![], is_dir: false, created: util::unix_secs() };
    svc.files.insert(r.clone());
    Ok(json(StatusCode::CREATED, &r.info()))
}

async fn file_list(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> Response {
    let v: Vec<FileInfo> = svc.files.list(&c.owner).iter().map(|r| r.info()).collect();
    json(StatusCode::OK, &v)
}

fn file_of(svc: &Service, c: &Caller, id: &str) -> ApiResult<FileRec> {
    if id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such file"));
    }
    svc.files.get(id, &c.owner).ok_or_else(|| err(404, "not_found", "no such file"))
}

fn mime(name: &str) -> &'static str {
    let l = name.to_ascii_lowercase();
    match l.rsplit('.').next().unwrap_or("") {
        "tif" | "tiff" => "image/tiff",
        "jp2" => "image/jp2",
        "json" => "application/json",
        "ts" => "video/mp2t",
        "gpkg" => "application/geopackage+sqlite3",
        "laz" | "las" => "application/vnd.laszip",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b`, `bytes=a-`, `bytes=-n` → [start, end) within `size`.
pub fn parse_range(v: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = v.trim().strip_prefix("bytes=") else { return Err(()) };
    if spec.contains(',') {
        return Err(());
    }
    let (a, b) = spec.split_once('-').ok_or(())?;
    let (a, b) = (a.trim(), b.trim());
    let r = if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (size.saturating_sub(n), size)
    } else {
        let s: u64 = a.parse().map_err(|_| ())?;
        let e = if b.is_empty() { size } else { b.parse::<u64>().map_err(|_| ())?.saturating_add(1).min(size) };
        (s, e)
    };
    if r.0 >= size || r.0 >= r.1 {
        return Err(());
    }
    Ok(Some(r))
}

async fn file_get(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, method: Method, h: HeaderMap, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let r = file_of(&svc, &c, &id)?;
    if r.is_dir {
        return Err(err(400, "is_folder", "a folder has no bytes"));
    }
    // Re-check the path every time: a picked file may since have become a link.
    if r.origin == FileOrigin::Pick {
        crate::paths::check_user_path(&r.path).map_err(|e| err(403, "bad_path", e.to_string()))?;
    } else {
        crate::paths::confined(&svc.cfg.data_dir, &r.path).map_err(|e| err(403, "bad_path", e.to_string()))?;
    }
    let mut f = tokio::fs::File::open(&r.path).await.map_err(|e| err(410, "gone", e.to_string()))?;
    let size = f.metadata().await.map_err(|e| err(500, "io", e.to_string()))?.len();
    let range = match h.get("range").and_then(|v| v.to_str().ok()) {
        None => None,
        Some(v) => match parse_range(v, size) {
            Ok(r) => r,
            Err(()) => {
                let mut resp = err(416, "range", "unsatisfiable range").into_response();
                resp.headers_mut().insert("content-range", HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
                return Ok(resp);
            }
        },
    };
    let (start, end, status) = match range {
        Some((a, b)) => (a, b, StatusCode::PARTIAL_CONTENT),
        None => (0, size, StatusCode::OK),
    };
    let len = end - start;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        f.seek(std::io::SeekFrom::Start(start)).await.map_err(|e| err(500, "io", e.to_string()))?;
        Body::from_stream(tokio_util::io::ReaderStream::with_capacity(f.take(len), 256 * 1024))
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = status;
    let hh = resp.headers_mut();
    hh.insert("content-type", HeaderValue::from_static(mime(&r.name)));
    hh.insert("content-length", HeaderValue::from(len));
    hh.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        hh.insert("content-range", HeaderValue::from_str(&format!("bytes {start}-{}/{size}", end - 1)).unwrap());
    }
    let ascii: String = r.name.chars().map(|c| if c.is_ascii_alphanumeric() || ".-_ ".contains(c) { c } else { '_' }).collect();
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{ascii}\"")) {
        hh.insert("content-disposition", v);
    }
    hh.insert("x-gwb-file", HeaderValue::from_str(&r.id).unwrap());
    Ok(resp)
}

async fn file_delete(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<StatusCode> {
    file_of(&svc, &c, &id)?;
    svc.files.remove(&id, &c.owner);
    Ok(StatusCode::NO_CONTENT)
}

/// "Save to folder": the user picks the folder in the sidecar; the file (and its provenance
/// sidecar) is copied there. Only the folder's name goes back to the browser.
async fn file_save(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let r = file_of(&svc, &c, &id)?;
    if r.origin == FileOrigin::Pick || r.is_dir {
        return Err(err(400, "bad_request", "only uploads and outputs can be saved"));
    }
    let _g = PICK_BUSY.try_lock().map_err(|_| err(409, "busy", "a picker is already open in the sidecar"))?;
    let dir = if crate::config::test_mode() && svc.cfg.test_save_dir.is_some() {
        svc.cfg.test_save_dir.clone()
    } else if svc.cfg.headless {
        None // nobody is there to answer a dialog
    } else {
        let t = format!("Save {} to…", r.name);
        tokio::task::spawn_blocking(move || picker::pick(picker::Mode::SaveFolder, &t)).await.unwrap_or_default().into_iter().next()
    };
    let Some(dir) = dir else { return Ok(json(StatusCode::OK, &SaveResult { saved: false, folder: None })) };
    let dir = crate::paths::check_user_path(&dir).map_err(|e| err(400, "bad_path", e.to_string()))?;
    let group = svc.files.group_of(&id);
    let prov_name = format!("{}.gwb-provenance.json", r.name);
    for f in std::iter::once(&r).chain(group.iter().filter(|g| g.name == prov_name)) {
        let mut dst = dir.join(&f.name);
        let mut k = 1;
        while dst.exists() {
            let (s, e) = f.name.rsplit_once('.').unwrap_or((&f.name, ""));
            dst = dir.join(format!("{s} ({k}){}{e}", if e.is_empty() { "" } else { "." }));
            k += 1;
        }
        let (src, d2) = (f.path.clone(), dst.clone());
        tokio::task::spawn_blocking(move || std::fs::copy(src, d2)).await.map_err(|e| err(500, "io", e.to_string()))?.map_err(|e| err(507, "io", format!("could not copy: {e}")))?;
    }
    let folder = dir.file_name().map(|s| s.to_string_lossy().into_owned()).or_else(|| Some(dir.display().to_string()));
    svc.log(format!("{} saved {} to a folder", c.origin, r.name));
    Ok(json(StatusCode::OK, &SaveResult { saved: true, folder }))
}

// ---------------------------------------------------------------- the Python relay

fn relay_err(e: RelayError) -> ApiError {
    let (s, code, msg) = e.http();
    err(s, code, msg)
}

fn session_id(id: &str) -> ApiResult<()> {
    if id.len() == 48 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(relay_err(RelayError::NotAttached))
    }
}

async fn relay_hello(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> Response {
    json(StatusCode::OK, &RelayHello { service: "gwb-sidecar".into(), version: env!("CARGO_PKG_VERSION").into(), api: API_LEVEL, port: svc.port, paired: c.authed, app: c.authed && svc.relay.app_on() })
}

async fn relay_pair_start(State(svc): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: PairRequest = parse(&h, &body)?;
    let s = svc.pairings.start(RELAY_ORIGIN, &r.client).map_err(|e| err(429, "busy", e))?;
    svc.log(format!("relay pairing request ({}) code {}", r.client.chars().filter(|c| !c.is_control()).take(80).collect::<String>(), s.code));
    crate::tray::pairing_requested(&svc);
    Ok(json(StatusCode::OK, &s))
}

async fn relay_pair_poll(State(svc): State<Arc<Service>>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    if id.len() != 48 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such pairing request"));
    }
    let st = svc.pairings.poll(&id, RELAY_ORIGIN).ok_or_else(|| err(404, "not_found", "no such pairing request"))?;
    Ok(json(StatusCode::OK, &st))
}

async fn relay_pair_forget(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> ApiResult<StatusCode> {
    let t = c.token.ok_or_else(|| err(401, "unauthorized", "no token"))?;
    svc.pairings.revoke_token(RELAY_ORIGIN, &t);
    svc.log("a relay client forgot its pairing");
    Ok(StatusCode::NO_CONTENT)
}

/// One JSON-RPC message, answered when the page has answered. If the client goes away first, the
/// handler is dropped, and with it the ticket, which withdraws a message not yet delivered.
async fn relay_mcp(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let v: serde_json::Value = parse(&h, &body)?;
    let m = relay::check_message(v).map_err(|e| err(400, "bad_message", e))?;
    if m.notification {
        return Ok(StatusCode::ACCEPTED.into_response());
    }
    let client = c.token.as_deref().and_then(|t| svc.pairings.client_of(RELAY_ORIGIN, t)).unwrap_or_else(|| "relay client".into());
    let mut ticket = svc.relay.submit(&client, m.value).map_err(relay_err)?;
    svc.log(format!("relay: {client}: {}", m.label));
    let out = ticket.wait().await.map_err(relay_err)?;
    Ok(json(StatusCode::OK, &out))
}

async fn relay_attach(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: RelayAttach = parse(&h, &body)?;
    if r.client.trim().is_empty() || r.client.chars().count() > 80 {
        return Err(err(400, "bad_request", "client: 1–80 characters"));
    }
    let session = svc.relay.attach(&c.owner, &c.origin, &r.client).map_err(relay_err)?;
    svc.log(format!("relay on for {}", c.origin));
    Ok(json(StatusCode::OK, &RelayAttached { session, hold_s: relay::HOLD.as_secs() as u32 }))
}

async fn relay_detach(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>) -> ApiResult<StatusCode> {
    session_id(&session)?;
    svc.relay.detach(&session, &c.owner).map_err(relay_err)?;
    svc.log(format!("relay off for {}", c.origin));
    Ok(StatusCode::NO_CONTENT)
}

/// Long poll: a message, or 204 after `HOLD` (the page simply asks again).
async fn relay_inbox(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>) -> ApiResult<Response> {
    session_id(&session)?;
    match svc.relay.next(&session, &c.owner, relay::HOLD).await.map_err(relay_err)? {
        Some(d) => Ok(json(StatusCode::OK, &d)),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

async fn relay_reply(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<StatusCode> {
    session_id(&session)?;
    let r: RelayReply = parse(&h, &body)?;
    svc.relay.reply(&session, &c.owner, &r.rid, r.reply).map_err(relay_err)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- ArcGIS Pro sync (REQ-GAP-65)

fn sync_err(e: SyncError) -> ApiError {
    let (s, code, msg) = e.http();
    err(s, code, msg)
}

fn sync_session(id: &str) -> ApiResult<()> {
    if id.len() == 48 && id.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(sync_err(SyncError::NotAttached))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncQuery {
    #[serde(default)]
    after: u64,
}

async fn sync_hello(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> Response {
    let (app, direction) = if c.authed { (svc.sync.app_on(), svc.sync.direction()) } else { (false, None) };
    json(StatusCode::OK, &SyncHello { service: "gwb-sidecar".into(), version: env!("CARGO_PKG_VERSION").into(), api: API_LEVEL, port: svc.port, paired: c.authed, app, direction })
}

async fn sync_pair_start(State(svc): State<Arc<Service>>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: PairRequest = parse(&h, &body)?;
    let s = svc.pairings.start(SYNC_ORIGIN, &r.client).map_err(|e| err(429, "busy", e))?;
    svc.log(format!("add-in pairing request ({}) code {}", r.client.chars().filter(|c| !c.is_control()).take(80).collect::<String>(), s.code));
    crate::tray::pairing_requested(&svc);
    Ok(json(StatusCode::OK, &s))
}

async fn sync_pair_poll(State(svc): State<Arc<Service>>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    if id.len() != 48 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such pairing request"));
    }
    let st = svc.pairings.poll(&id, SYNC_ORIGIN).ok_or_else(|| err(404, "not_found", "no such pairing request"))?;
    Ok(json(StatusCode::OK, &st))
}

async fn sync_pair_forget(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>) -> ApiResult<StatusCode> {
    let t = c.token.ok_or_else(|| err(401, "unauthorized", "no token"))?;
    svc.pairings.revoke_token(SYNC_ORIGIN, &t);
    svc.log("an add-in forgot its pairing");
    Ok(StatusCode::NO_CONTENT)
}

fn sync_client(svc: &Service, c: &Caller) -> String {
    c.token.as_deref().and_then(|t| svc.pairings.client_of(SYNC_ORIGIN, t)).unwrap_or_else(|| "add-in".into())
}

async fn sync_publish_pro(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let p: SyncPublish = parse(&h, &body)?;
    let seq = svc.sync.publish_pro(&sync_client(&svc, &c), &p).map_err(sync_err)?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "seq": seq })))
}

/// Long poll: what the page published since `after`, or an empty update after `HOLD`.
async fn sync_next_pro(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, Query(q): Query<SyncQuery>) -> ApiResult<Response> {
    let u = svc.sync.next_pro(&sync_client(&svc, &c), q.after, prosync::HOLD).await.map_err(sync_err)?;
    Ok(json(StatusCode::OK, &u))
}

async fn sync_attach(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: SyncAttach = parse(&h, &body)?;
    if r.client.trim().is_empty() || r.client.chars().count() > 80 {
        return Err(err(400, "bad_request", "client: 1–80 characters"));
    }
    let session = svc.sync.attach(&c.owner, &c.origin, &r.client, r.direction).map_err(sync_err)?;
    svc.log(format!("ArcGIS Pro sync on for {}", c.origin));
    Ok(json(StatusCode::OK, &SyncAttached { session, hold_s: prosync::HOLD.as_secs() as u32 }))
}

async fn sync_detach(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>) -> ApiResult<StatusCode> {
    sync_session(&session)?;
    let st = svc.sync.status();
    svc.sync.detach(&session, &c.owner).map_err(sync_err)?;
    svc.log(format!("ArcGIS Pro sync off for {}: {} update(s) from the app, {} from Pro", c.origin, st.from_app, st.from_pro));
    Ok(StatusCode::NO_CONTENT)
}

async fn sync_publish_app(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    sync_session(&session)?;
    let p: SyncPublish = parse(&h, &body)?;
    let seq = svc.sync.publish_app(&session, &c.owner, &p).map_err(sync_err)?;
    Ok(json(StatusCode::OK, &serde_json::json!({ "seq": seq })))
}

async fn sync_next_app(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(session): UrlPath<String>, Query(q): Query<SyncQuery>) -> ApiResult<Response> {
    sync_session(&session)?;
    let u = svc.sync.next_app(&session, &c.owner, q.after, prosync::HOLD).await.map_err(sync_err)?;
    Ok(json(StatusCode::OK, &u))
}

// ---------------------------------------------------------------- the stereo viewer (REQ-GAP-33)

fn stereo_of(svc: &Service, c: &Caller, id: &str) -> ApiResult<Arc<stereo::Session>> {
    if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such stereo session"));
    }
    svc.stereo.get(id, &c.owner).ok_or_else(|| err(404, "not_found", "no such stereo session"))
}

async fn stereo_open(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: StereoRequest = parse(&h, &body)?;
    let left = file_of(&svc, &c, &r.left)?;
    let right = file_of(&svc, &c, &r.right)?;
    let s = stereo::open(&svc, &c.owner, left, right, &r).await.map_err(|(st, code, m)| err(st, code, m))?;
    let i = s.info();
    svc.log(format!("stereo viewer {} opened for {}: {} and {}", i.id, c.origin, i.left.name, i.right.name));
    Ok(json(StatusCode::CREATED, &i))
}

async fn stereo_get(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    Ok(json(StatusCode::OK, &stereo_of(&svc, &c, &id)?.info()))
}

async fn stereo_close(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<StatusCode> {
    let s = stereo_of(&svc, &c, &id)?;
    svc.stereo.close(&svc, &s);
    svc.log(format!("stereo viewer {id} closed by {}", c.origin));
    Ok(StatusCode::NO_CONTENT)
}

/// The viewer's side: the session's ticket, compared in constant time, and nothing else opens it.
fn stereo_ticket(svc: &Service, h: &HeaderMap, id: &str) -> ApiResult<Arc<stereo::Session>> {
    let refused = || err(401, "unauthorized", "this feed needs the session's ticket");
    if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(refused());
    }
    let t = security::bearer(h).ok_or_else(refused)?;
    svc.stereo.by_ticket(id, &t).ok_or_else(refused)
}

async fn stereo_scene(State(svc): State<Arc<Service>>, h: HeaderMap, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    Ok(json(StatusCode::OK, &stereo_ticket(&svc, &h, &id)?.scene()))
}

async fn stereo_tile(State(svc): State<Arc<Service>>, h: HeaderMap, UrlPath((id, eye, level, x, y)): UrlPath<(String, String, u32, u32, u32)>) -> ApiResult<Response> {
    let s = stereo_ticket(&svc, &h, &id)?;
    let b = stereo::tile(&svc, &s, &eye, level, x, y).await.map_err(|(st, code, m)| err(st, code, m))?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert("content-type", HeaderValue::from_static("application/octet-stream"));
    Ok(r)
}

async fn stereo_report(State(svc): State<Arc<Service>>, h: HeaderMap, UrlPath(id): UrlPath<String>, body: Bytes) -> ApiResult<StatusCode> {
    let s = stereo_ticket(&svc, &h, &id)?;
    let r: StereoReport = parse(&h, &body)?;
    s.report(&svc, r);
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- the CORS relay (REQ-GAP-08)

#[cfg(feature = "cors-relay")]
async fn cors_fetch(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CorsRelayRequest = parse(&h, &body)?;
    crate::corsrelay::fetch(&svc, &c.origin, r).await.map_err(|e| {
        let (s, code, m) = e.http();
        err(s, code, m)
    })
}

// ---------------------------------------------------------------- views (REQ-GAP-70)

async fn view_create(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: ViewRequest = parse(&h, &body)?;
    let f = file_of(&svc, &c, &r.file)?;
    let v = views::open(&svc, &c.owner, f).await.map_err(|(s, code, m)| err(s, code, m))?;
    let i = v.info();
    svc.log(format!("view {} of {} ({} × {}, {}) opened for {}", i.id, i.name, i.width, i.height, i.driver, c.origin));
    Ok(json(StatusCode::CREATED, &i))
}

fn view_of(svc: &Service, c: &Caller, id: &str) -> ApiResult<Arc<views::View>> {
    if id.len() != 24 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(err(404, "not_found", "no such view"));
    }
    svc.views.get(id, &c.owner).ok_or_else(|| err(404, "not_found", "no such view"))
}

/// The view's bytes by range. Nobody can read a whole view of a large image at once: that is what
/// conversion is for.
async fn view_get(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, method: Method, h: HeaderMap, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let v = view_of(&svc, &c, &id)?;
    let size = v.layout.size;
    let range = match h.get("range").and_then(|x| x.to_str().ok()) {
        None => None,
        Some(x) => match parse_range(x, size) {
            Ok(r) => r,
            Err(()) => {
                let mut resp = err(416, "range", "unsatisfiable range").into_response();
                resp.headers_mut().insert("content-range", HeaderValue::from_str(&format!("bytes */{size}")).unwrap());
                return Ok(resp);
            }
        },
    };
    let (start, end, status) = match range {
        Some((a, b)) => (a, b, StatusCode::PARTIAL_CONTENT),
        None => (0, size, StatusCode::OK),
    };
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        if end - start > views::MAX_RANGE {
            return Err(err(413, "too_large", "a view is read by range, up to 64 MB at a time; convert the file to read it whole"));
        }
        Body::from(views::read(&svc, &v, start, end).await.map_err(|(s, code, m)| err(s, code, m))?)
    };
    let mut resp = Response::new(body);
    *resp.status_mut() = status;
    let hh = resp.headers_mut();
    hh.insert("content-type", HeaderValue::from_static("image/tiff"));
    hh.insert("content-length", HeaderValue::from(end - start));
    hh.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        hh.insert("content-range", HeaderValue::from_str(&format!("bytes {start}-{}/{size}", end - 1)).unwrap());
    }
    Ok(resp)
}

async fn view_delete(State(svc): State<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<StatusCode> {
    view_of(&svc, &c, &id)?;
    svc.views.close(&id, &c.owner);
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------- /app/

async fn app_html(State(svc): State<Arc<Service>>) -> Response {
    serve_app(&svc, "")
}

async fn app_html_named(State(svc): State<Arc<Service>>, UrlPath(which): UrlPath<String>) -> Response {
    let w = which.trim_end_matches(".html");
    let w = match w {
        "index" | "gis-workbench" => "",
        "lite" | "gis-workbench-lite" => "lite",
        "airgap" | "gis-workbench-airgap" => "airgap",
        _ => return err(404, "not_found", "no such file").into_response(),
    };
    serve_app(&svc, w)
}

fn serve_app(svc: &Service, which: &str) -> Response {
    match appserve::load(&svc.cfg.app_dir, which) {
        Ok(bytes) => {
            let mut r = Response::new(Body::from(bytes));
            let h = r.headers_mut();
            h.insert("content-type", HeaderValue::from_static("text/html; charset=utf-8"));
            h.insert("x-frame-options", HeaderValue::from_static("SAMEORIGIN"));
            h.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
            r
        }
        Err(e) => {
            svc.log(format!("/app/: {e}"));
            err(503, "app_unavailable", e).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_range;
    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-0", 10), Ok(Some((0, 1))));
        assert_eq!(parse_range("bytes=2-", 10), Ok(Some((2, 10))));
        assert_eq!(parse_range("bytes=-3", 10), Ok(Some((7, 10))));
        assert_eq!(parse_range("bytes=5-100", 10), Ok(Some((5, 10))));
        for bad in ["bytes=10-", "bytes=5-4", "bytes=a-b", "items=0-1", "bytes=0-1,3-4", "bytes=-0", "bytes=-", "bytes=18446744073709551615-"] {
            assert_eq!(parse_range(bad, 10), Err(()), "{bad}");
        }
        assert_eq!(parse_range("bytes=0-18446744073709551615", 10), Ok(Some((0, 10))));
    }
}
