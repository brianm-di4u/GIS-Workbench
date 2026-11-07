//! Records, sessions and routes of the plug-in host. Compiled only with the `csm-host` feature, and
//! routed only while the `csm-plugin` gate is open (see `csmhost.rs`).
//!
//! A plug-in passes through three steps, and no code of it runs before the third:
//!   1. A page names a file. The sidecar copies it to its own folder and records the SHA-256 and
//!      what the system says of the signer, as `pending`.
//!   2. The user approves or refuses it in the sidecar window. A page cannot do this.
//!   3. A session copies the stored file into a fresh run folder, hashes that copy against the
//!      approved hash, and starts a host on it in the sandbox.

use super::proto::{self, Op, ProtoError, Status};
use super::sandbox::{self, Sandboxed};
use super::signer;
use crate::server::{err, json, parse, ApiError, ApiResult, Caller};
use crate::service::Service;
use crate::util;
use crate::winjob::{JobLimits, ProcessJob};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, State as Axum};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Router};
use gwb_sidecar_api::*;
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_SESSIONS: usize = 4;
const MAX_PLUGIN: u64 = 512 << 20;
const MAX_ISD: u64 = 256 << 20;
const CALL_WALL_S: u64 = 60;
const IDLE: Duration = Duration::from_secs(300);
const LIMITS: JobLimits = JobLimits { memory_bytes: 2 << 30, cpu_seconds: 600, processes: 1 };
/// The only files of the host's folder that go into a run: never a mock, never anything else.
const HOST_FILES: &[&str] = &["gwb-csm-host.exe", "gwb-csm-host", "csmapi.dll", "libcsmapi.so", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

struct Conn {
    host: Sandboxed,
    next: u32,
}

impl Conn {
    fn call(&mut self, op: Op, payload: &[u8]) -> Result<(Status, Vec<u8>), ProtoError> {
        self.next += 1;
        proto::write_frame(&mut self.host.stdin, op, self.next, payload)?;
        proto::read_reply(&mut self.host.stdout, self.next)
    }
}

struct Session {
    owner: String,
    conn: tokio::sync::Mutex<Option<Conn>>,
    job: Arc<ProcessJob>,
    run: PathBuf,
    used: Mutex<Instant>,
    wall: Duration,
}

impl Session {
    /// One call, in order, with the wall limit. A host that hangs, dies or breaks the protocol is
    /// finished: its session is gone and the caller hears why.
    async fn call(&self, op: Op, payload: Vec<u8>) -> Result<(Status, Vec<u8>), End> {
        let wall = self.wall;
        let mut g = self.conn.lock().await;
        let Some(mut conn) = g.take() else { return Err(End::Ended) };
        *self.used.lock().unwrap() = Instant::now();
        let work = tokio::task::spawn_blocking(move || {
            let r = conn.call(op, &payload);
            (conn, r)
        });
        match tokio::time::timeout(wall, work).await {
            Ok(Ok((conn, Ok(r)))) => {
                *g = Some(conn);
                Ok(r)
            }
            Ok(Ok((_, Err(ProtoError::Gone)))) | Ok(Err(_)) => Err(End::Ended),
            Ok(Ok((_, Err(ProtoError::Bad(w))))) => Err(End::Broke(w)),
            Err(_) => {
                // Closing the job ends the host, and the blocked read with it.
                self.job.terminate(1);
                Err(End::TimedOut)
            }
        }
    }
}

enum End {
    Ended,
    Broke(String),
    TimedOut,
}

pub struct State {
    path: PathBuf,
    store: PathBuf,
    runs: PathBuf,
    records: Mutex<Vec<CsmPluginRecord>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl State {
    pub fn open(data_dir: &Path) -> State {
        let root = data_dir.join("csm");
        let runs = root.join("run");
        let _ = std::fs::remove_dir_all(&runs); // left by a crash
        sandbox::sweep();
        let path = root.join("plugins.json");
        let records = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        State { path, store: root.join("plugins"), runs, records: Mutex::new(records), sessions: Mutex::new(HashMap::new()) }
    }

    fn save(&self, r: &[CsmPluginRecord]) -> Result<(), String> {
        let t = self.path.with_extension("tmp");
        std::fs::write(&t, serde_json::to_vec_pretty(r).unwrap_or_default()).and_then(|_| std::fs::rename(&t, &self.path)).map_err(|e| e.to_string())
    }

    fn record(&self, sha: &str) -> Option<CsmPluginRecord> {
        self.records.lock().unwrap().iter().find(|r| r.sha256 == sha).cloned()
    }
}

pub fn router(_svc: Arc<Service>) -> Router<Arc<Service>> {
    Router::new()
        .route("/v1/csm/plugins", get(plugins).post(add))
        .route("/v1/csm/sessions", post(open))
        .route("/v1/csm/sessions/{id}", delete(close))
        .route("/v1/csm/sessions/{id}/g2i", post(g2i))
        .route("/v1/csm/sessions/{id}/i2g", post(i2g))
        .route("/v1/csm/sessions/{id}/partials", post(partials))
        .route("/v1/csm/sessions/{id}/covariance", post(covariance))
        .route("/ui/api/csm/decide", post(decide))
        .layer(DefaultBodyLimit::max(8 << 20))
}

fn is_sha(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

async fn plugins(Axum(svc): Axum<Arc<Service>>) -> Response {
    json(StatusCode::OK, &*svc.csm.records.lock().unwrap())
}

/// The first bytes of a Windows DLL or a Linux shared object: anything else is no plug-in.
fn native_library(path: &Path) -> bool {
    use std::io::Read;
    let mut h = [0u8; 4];
    let ok = std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut h)).is_ok();
    ok && if cfg!(windows) { h[..2] == *b"MZ" } else { h == *b"\x7fELF" }
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut b = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            return Ok(hex::encode(h.finalize()));
        }
        h.update(&b[..n]);
    }
}

async fn add(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmPluginAdd = parse(&h, &body)?;
    let f = svc.files.get(&r.file, &c.owner).ok_or_else(|| err(404, "not_found", "no such file"))?;
    if f.is_dir {
        return Err(err(400, "bad_request", format!("{} is a folder; a plug-in is one library file", f.name)));
    }
    if f.size > MAX_PLUGIN {
        return Err(err(413, "too_large", format!("{} is over the {} MiB limit for a plug-in", f.name, MAX_PLUGIN >> 20)));
    }
    if !native_library(&f.path) {
        return Err(err(422, "not_a_library", format!("{} is not a native library for this system", f.name)));
    }
    std::fs::create_dir_all(&svc.csm.store).map_err(|e| err(500, "io", e.to_string()))?;
    // The copy is what the record speaks for: the original can change after this.
    let copy = svc.csm.store.join(format!("incoming-{}", util::random_hex(8)));
    std::fs::copy(&f.path, &copy).map_err(|e| err(500, "io", e.to_string()))?;
    let (sha, sig) = {
        let c2 = copy.clone();
        tokio::task::spawn_blocking(move || (sha256_of(&c2), signer::signer_of(&c2))).await.map_err(|e| err(500, "io", e.to_string()))?
    };
    let sha = sha.map_err(|e| err(500, "io", e.to_string()))?;
    let dest = svc.csm.store.join(&sha);
    let mut rs = svc.csm.records.lock().unwrap();
    if let Some(rec) = rs.iter().find(|x| x.sha256 == sha) {
        let _ = std::fs::remove_file(&copy);
        return Ok(json(StatusCode::OK, rec));
    }
    std::fs::rename(&copy, &dest).map_err(|e| err(500, "io", e.to_string()))?;
    let rec = CsmPluginRecord { sha256: sha.clone(), name: f.name.clone(), size: f.size, signer: sig, state: "pending".into(), added: util::now_rfc3339(), decided: None };
    rs.push(rec.clone());
    svc.csm.save(&rs).map_err(|e| err(500, "io", e))?;
    drop(rs);
    svc.log(format!("CSM plug-in {} recorded for approval: sha256 {sha}, signer {} {}", rec.name, rec.signer.status, rec.signer.subject.as_deref().unwrap_or("(none)")));
    Ok(json(StatusCode::CREATED, &rec))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decide {
    sha256: String,
    approve: bool,
}

/// The sidecar window only: a page holds a token, not the window's secret.
async fn decide(Axum(svc): Axum<Arc<Service>>, h: HeaderMap, b: Bytes) -> Response {
    if !crate::ui::admin_ok(&svc, &h) {
        return err(403, "forbidden", "not allowed").into_response();
    }
    let Some(r) = crate::ui::body_json::<Decide>(&b) else { return err(400, "bad_request", "bad request").into_response() };
    if !is_sha(&r.sha256) {
        return err(400, "bad_request", "not a SHA-256").into_response();
    }
    let mut rs = svc.csm.records.lock().unwrap();
    let Some(rec) = rs.iter_mut().find(|x| x.sha256 == r.sha256) else { return err(404, "not_found", "no such plug-in").into_response() };
    rec.state = if r.approve { "approved" } else { "refused" }.into();
    rec.decided = Some(util::now_rfc3339());
    let out = rec.clone();
    if let Err(e) = svc.csm.save(&rs) {
        return err(500, "io", e).into_response();
    }
    drop(rs);
    svc.log(format!("CSM plug-in {} {}: sha256 {}", out.name, out.state, out.sha256));
    json(StatusCode::OK, &out)
}

/// End every session (tests, and a service that is stopping).
pub async fn close_all(svc: &Service) {
    let all: Vec<Arc<Session>> = svc.csm.sessions.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all {
        finish(s).await;
    }
}

pub fn window_state(svc: &Service) -> serde_json::Value {
    serde_json::to_value(&*svc.csm.records.lock().unwrap()).unwrap_or_default()
}

/// Fill a run folder: the host, the approved plug-in as a copy that is hashed again, and the ISD.
fn prepare(run: &Path, host: &Path, stored: &Path, sha: &str, isd: &Path) -> Result<(PathBuf, PathBuf, PathBuf), ApiError> {
    let io = |e: std::io::Error| err(500, "io", e.to_string());
    std::fs::create_dir_all(run).map_err(io)?;
    crate::winjob::create_low_dir(&sandbox::scratch(run)).map_err(io)?;
    let mut exe = None;
    for name in HOST_FILES {
        let src = host.join(name);
        if src.is_file() {
            std::fs::copy(&src, run.join(name)).map_err(io)?;
            if name.starts_with("gwb-csm-host") {
                exe = Some(run.join(name));
            }
        }
    }
    let exe = exe.ok_or_else(|| err(409, "csm_no_host", format!("no plug-in host in {}", host.display())))?;
    let plugin = run.join(if cfg!(windows) { "plugin.dll" } else { "plugin.so" });
    std::fs::copy(stored, &plugin).map_err(io)?;
    if sha256_of(&plugin).map_err(io)? != sha {
        return Err(err(409, "csm_tampered", "the stored plug-in no longer matches the approved SHA-256; it was not started"));
    }
    let isd_copy = run.join("input.isd");
    std::fs::copy(isd, &isd_copy).map_err(io)?;
    Ok((exe, plugin, isd_copy))
}

fn host_error(status: Status, payload: &[u8]) -> ApiError {
    let why = proto::parse_strings(payload, Some(1)).ok().and_then(|v| v.into_iter().next()).unwrap_or_else(|| "no reason given".into());
    match status {
        Status::BadRequest => err(400, "bad_request", why),
        Status::NotReady => err(409, "csm_not_ready", why),
        Status::CsmVersion => err(422, "csm_version", why),
        Status::NoModel => err(422, "csm_no_model", why),
        Status::LoadFailed => err(422, "csm_load_failed", why),
        Status::Sandbox => err(500, "csm_sandbox", why),
        Status::CsmError | Status::PluginException | Status::Ok => err(422, "csm_error", why),
    }
}

fn end_error(e: End) -> ApiError {
    match e {
        End::Ended => err(502, "csm_host_ended", "the plug-in host ended; the session is closed"),
        End::Broke(w) => err(502, "csm_bad_reply", format!("the plug-in host broke the protocol ({w}); the session is closed")),
        End::TimedOut => err(504, "csm_host_timeout", "the plug-in took too long and was stopped; the session is closed"),
    }
}

fn remove_session(svc: &Service, id: &str) -> Option<Arc<Session>> {
    let s = svc.csm.sessions.lock().unwrap().remove(id)?;
    svc.log(format!("CSM session {} closed", &id[..8.min(id.len())]));
    Some(s)
}

/// End a session and leave nothing of its run behind.
async fn finish(s: Arc<Session>) {
    s.job.terminate(1);
    if let Some(conn) = s.conn.lock().await.take() {
        drop(conn);
    }
    let run = s.run.clone();
    let _ = tokio::task::spawn_blocking(move || {
        // The system can hold the last handle of a process that just ended for a moment.
        for _ in 0..50 {
            if std::fs::remove_dir_all(&run).is_ok() || !run.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })
    .await;
}

async fn open(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmSessionOpen = parse(&h, &body)?;
    if !is_sha(&r.plugin) {
        return Err(err(400, "bad_request", "plugin is a SHA-256"));
    }
    if let Some(m) = &r.model {
        if m.is_empty() || m.len() > 200 || !m.chars().all(|c| c.is_ascii_graphic()) {
            return Err(err(400, "bad_request", "not a model name"));
        }
    }
    let rec = svc.csm.record(&r.plugin).ok_or_else(|| err(404, "not_found", "no such plug-in"))?;
    if rec.state != "approved" {
        return Err(err(403, "csm_not_approved", format!("{} is {}: it runs only once it is approved in the sidecar window", rec.name, rec.state)));
    }
    if svc.csm.sessions.lock().unwrap().len() >= MAX_SESSIONS {
        return Err(err(429, "busy", format!("{MAX_SESSIONS} plug-in sessions are open already")));
    }
    let isd = svc.files.get(&r.isd, &c.owner).ok_or_else(|| err(404, "not_found", "no such file"))?;
    if isd.is_dir || isd.size > MAX_ISD {
        return Err(err(400, "bad_request", format!("{} is not an ISD file of at most {} MiB", isd.name, MAX_ISD >> 20)));
    }
    let host_dir = svc.cfg.test_csm_host.clone().ok_or_else(|| err(409, "csm_no_host", "this build has no plug-in host"))?;
    let id = util::random_hex(16);
    let run = svc.csm.runs.join(&id);
    let (run2, stored, sha, isd_path) = (run.clone(), svc.csm.store.join(&rec.sha256), rec.sha256.clone(), isd.path.clone());
    let prep = tokio::task::spawn_blocking(move || prepare(&run2, &host_dir, &stored, &sha, &isd_path)).await.map_err(|e| err(500, "io", e.to_string()))?;
    let (exe, plugin, isd_copy) = match prep {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&run);
            return Err(e);
        }
    };
    let host = match sandbox::spawn(&run, &exe, &plugin, LIMITS) {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&run);
            return Err(err(500, "csm_sandbox", e.to_string()));
        }
    };
    let job = host.job.clone();
    let s = Arc::new(Session { owner: c.owner.clone(), conn: tokio::sync::Mutex::new(Some(Conn { host, next: 0 })), job, run: run.clone(), used: Mutex::new(Instant::now()), wall: Duration::from_millis(svc.cfg.test_csm_wall_ms.unwrap_or(CALL_WALL_S * 1000)) });
    match handshake(&s, &r, &isd_copy, &id).await {
        Ok(info) => {
            svc.csm.sessions.lock().unwrap().insert(id.clone(), s.clone());
            svc.log(format!("CSM session {} opened: {} (sha256 {}), model {}; {}", &id[..8], rec.name, rec.sha256, info.model, info.confinement));
            let svc2 = svc.clone();
            let id2 = id.clone();
            tokio::spawn(async move { watch_idle(svc2, id2).await });
            Ok(json(StatusCode::CREATED, &info))
        }
        Err(e) => {
            finish(s).await;
            Err(e)
        }
    }
}

async fn handshake(s: &Session, r: &CsmSessionOpen, isd: &Path, id: &str) -> Result<CsmSessionInfo, ApiError> {
    let (st, p) = s.call(Op::Hello, vec![]).await.map_err(end_error)?;
    if st != Status::Ok {
        // A host that is not confined says so here, and nothing has been loaded yet.
        return Err(if st == Status::Sandbox { err(500, "csm_sandbox", format!("the host is not confined: {}", proto::parse_strings(&p, Some(4)).ok().and_then(|v| v.into_iter().nth(3)).unwrap_or_default())) } else { host_error(st, &p) });
    }
    let hello = proto::parse_strings(&p, Some(4)).map_err(|e| err(502, "csm_bad_reply", e.to_string()))?;
    if hello[0] != "gwb-csm-host" || hello[1] != proto::PROTOCOL.to_string() {
        return Err(err(502, "csm_bad_reply", format!("{} protocol {} is not this sidecar's", hello[0], hello[1])));
    }
    let (st, p) = s.call(Op::Load, vec![]).await.map_err(end_error)?;
    if st != Status::Ok {
        return Err(host_error(st, &p));
    }
    let plug = proto::parse_strings(&p, Some(5)).map_err(|e| err(502, "csm_bad_reply", e.to_string()))?;
    let isd_text = isd.display().to_string();
    let (st, p) = s.call(Op::Open, proto::strings(&[&isd_text, r.model.as_deref().unwrap_or("")])).await.map_err(end_error)?;
    if st != Status::Ok {
        return Err(host_error(st, &p));
    }
    let m = proto::parse_strings(&p, Some(8)).map_err(|e| err(502, "csm_bad_reply", e.to_string()))?;
    Ok(CsmSessionInfo {
        id: id.to_string(),
        protocol: proto::PROTOCOL,
        confinement: format!("{}: {}", sandbox::describe(), hello[3]),
        plugin_name: plug[0].clone(),
        manufacturer: plug[1].clone(),
        release_date: plug[2].clone(),
        csm_version: plug[3].clone(),
        model: m[0].clone(),
        model_version: m[1].clone(),
        sensor: m[2].clone(),
        platform: m[3].clone(),
        collection: m[4].clone(),
        trajectory: m[5].clone(),
        sensor_type: m[6].clone(),
        sensor_mode: m[7].clone(),
    })
}

async fn watch_idle(svc: Arc<Service>, id: String) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        let Some(s) = svc.csm.sessions.lock().unwrap().get(&id).cloned() else { return };
        if s.used.lock().unwrap().elapsed() > IDLE + s.wall {
            if let Some(s) = remove_session(&svc, &id) {
                finish(s).await;
            }
            return;
        }
    }
}

fn session(svc: &Service, id: &str, c: &Caller) -> ApiResult<Arc<Session>> {
    svc.csm.sessions.lock().unwrap().get(id).filter(|s| s.owner == c.owner).cloned().ok_or_else(|| err(404, "not_found", "no such session"))
}

async fn close(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>) -> ApiResult<StatusCode> {
    session(&svc, &id, &c)?;
    if let Some(s) = remove_session(&svc, &id) {
        finish(s).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// A call on a live session. A host error leaves the session open; an ended host closes it.
async fn ask(svc: &Arc<Service>, id: &str, c: &Caller, op: Op, q: &[f64]) -> ApiResult<Vec<u8>> {
    if q.iter().any(|x| !x.is_finite()) {
        return Err(err(400, "bad_request", "every number must be finite"));
    }
    let s = session(svc, id, c)?;
    match s.call(op, proto::numbers(q)).await {
        Ok((Status::Ok, p)) => Ok(p),
        Ok((st, p)) => Err(host_error(st, &p)),
        Err(e) => {
            if let Some(s) = remove_session(svc, id) {
                finish(s).await;
            }
            Err(end_error(e))
        }
    }
}

/// A reply that breaks the protocol ends the session: nothing more from that host is believed.
async fn bad_reply(svc: &Arc<Service>, id: &str, e: ProtoError) -> ApiError {
    svc.log(format!("CSM host reply refused: {e}"));
    if let Some(s) = remove_session(svc, id) {
        finish(s).await;
    }
    err(502, "csm_bad_reply", format!("{e}; the session is closed"))
}

fn four(r: &CsmPoints) -> ApiResult<Vec<f64>> {
    if r.points.is_empty() || r.points.len() > proto::MAX_POINTS {
        return Err(err(400, "bad_request", format!("1 to {} points", proto::MAX_POINTS)));
    }
    let precision = r.precision.unwrap_or(0.001);
    if !(precision > 0.0) {
        return Err(err(400, "bad_request", "precision must be above zero"));
    }
    Ok(r.points.iter().flat_map(|p| [p[0], p[1], p[2], precision]).collect())
}

async fn g2i(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmPoints = parse(&h, &body)?;
    let p = ask(&svc, &id, &c, Op::G2i, &four(&r)?).await?;
    let v = match proto::parse_numbers(&p, Some(r.points.len() * 3)) {
        Ok(v) => v,
        Err(e) => return Err(bad_reply(&svc, &id, e).await),
    };
    Ok(json(StatusCode::OK, &CsmPointsReply { points: v.chunks_exact(3).map(|c| c.to_vec()).collect() }))
}

async fn i2g(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmPoints = parse(&h, &body)?;
    let p = ask(&svc, &id, &c, Op::I2g, &four(&r)?).await?;
    let v = match proto::parse_numbers(&p, Some(r.points.len() * 4)) {
        Ok(v) => v,
        Err(e) => return Err(bad_reply(&svc, &id, e).await),
    };
    Ok(json(StatusCode::OK, &CsmPointsReply { points: v.chunks_exact(4).map(|c| c.to_vec()).collect() }))
}

async fn partials(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmPartialsRequest = parse(&h, &body)?;
    let p = ask(&svc, &id, &c, Op::Partials, &r.ground).await?;
    let v = match proto::parse_numbers(&p, None) {
        Ok(v) if v.len() >= 6 && v.len() % 2 == 0 && v.len() <= 6 + 2 * 1024 => v,
        Ok(_) => return Err(bad_reply(&svc, &id, ProtoError::Bad("partials of the wrong size".into())).await),
        Err(e) => return Err(bad_reply(&svc, &id, e).await),
    };
    let mut ground = [0.0; 6];
    ground.copy_from_slice(&v[..6]);
    Ok(json(StatusCode::OK, &CsmPartials { ground, sensor: v[6..].chunks_exact(2).map(|c| [c[0], c[1]]).collect() }))
}

async fn covariance(Axum(svc): Axum<Arc<Service>>, Extension(c): Extension<Caller>, UrlPath(id): UrlPath<String>, h: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let r: CsmCovarianceRequest = parse(&h, &body)?;
    let p = ask(&svc, &id, &c, Op::Covariance, &r.image).await?;
    let v = match proto::parse_numbers(&p, None) {
        Ok(v) => v,
        Err(e) => return Err(bad_reply(&svc, &id, e).await),
    };
    let n = v.get(3).copied().unwrap_or(-1.0);
    if !(0.0..=1024.0).contains(&n) || n.fract() != 0.0 || v.len() != 4 + (n as usize) * (n as usize) {
        return Err(bad_reply(&svc, &id, ProtoError::Bad("a covariance of the wrong size".into())).await);
    }
    Ok(json(StatusCode::OK, &CsmCovariance { unmodeled: [v[0], v[1], v[2]], parameters: n as u32, covariance: v[4..].to_vec() }))
}
