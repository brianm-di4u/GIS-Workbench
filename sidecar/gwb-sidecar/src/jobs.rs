//! Jobs (REQ-SDC-06, SDP-2.1 §3.4): a queue with a concurrency limit, per-job progress, log,
//! cancel and retry, a time limit, and outputs that are published only when every step succeeded
//! (a cancelled, killed or failed job leaves nothing behind marked complete).

use crate::files::{is_pointer_file, FileRec};
use crate::profiles::{ExpandCtx, OptVal, Profile};
use crate::runner::{self, Progress, RunSpec, Sink};
use crate::service::Service;
use crate::util;
use crate::winjob::JobLimits;
use gwb_sidecar_api::{FileOrigin, Job, JobEvent, JobRequest, JobState, Provenance, StepRecord};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;

const MAX_LOG_LINES: usize = 5000;
const MAX_QUEUED_PER_ORIGIN: usize = 256;

pub struct JobEntry {
    pub owner: String,
    pub req: JobRequest,
    pub job: Mutex<Job>,
    pub log: Mutex<Vec<String>>,
    pub events: Mutex<Vec<JobEvent>>,
    pub tx: broadcast::Sender<JobEvent>,
    pub cancel: CancellationToken,
}

impl JobEntry {
    pub fn snapshot(&self) -> Job {
        self.job.lock().unwrap().clone()
    }

    fn emit(&self, e: JobEvent) {
        let mut ev = self.events.lock().unwrap();
        // Progress events are coalesced in the history; the live stream still sees each one.
        if let (JobEvent::Progress { .. }, Some(JobEvent::Progress { .. })) = (&e, ev.last()) {
            ev.pop();
        }
        if !matches!(e, JobEvent::Log { .. }) || ev.len() < 2000 {
            ev.push(e.clone());
        }
        let _ = self.tx.send(e);
    }

    fn set_state(&self, s: JobState) {
        self.job.lock().unwrap().state = s;
        self.emit(JobEvent::State { state: s });
    }

    pub fn log_line(&self, line: &str) {
        let l: String = line.chars().take(2000).collect();
        {
            let mut log = self.log.lock().unwrap();
            if log.len() < MAX_LOG_LINES {
                log.push(l.clone());
            } else if log.len() == MAX_LOG_LINES {
                log.push("… (log truncated)".into());
            }
        }
        self.emit(JobEvent::Log { line: l });
    }

    /// History plus a live receiver, taken atomically (no event is lost or doubled).
    pub fn subscribe(&self) -> (Vec<JobEvent>, broadcast::Receiver<JobEvent>) {
        let ev = self.events.lock().unwrap();
        (ev.clone(), self.tx.subscribe())
    }
}

pub struct Jobs {
    map: Mutex<HashMap<String, Arc<JobEntry>>>,
    order: Mutex<Vec<String>>,
    sem: Arc<Semaphore>,
}

impl Jobs {
    pub fn new(concurrent: usize) -> Jobs {
        Jobs { map: Mutex::new(HashMap::new()), order: Mutex::new(Vec::new()), sem: Arc::new(Semaphore::new(concurrent.max(1))) }
    }

    pub fn get(&self, id: &str, owner: &str) -> Option<Arc<JobEntry>> {
        self.map.lock().unwrap().get(id).filter(|j| j.owner == owner).cloned()
    }

    pub fn list(&self, owner: Option<&str>) -> Vec<Arc<JobEntry>> {
        let map = self.map.lock().unwrap();
        self.order.lock().unwrap().iter().rev().filter_map(|id| map.get(id)).filter(|j| owner.is_none_or(|o| j.owner == o)).cloned().collect()
    }

    pub fn running_count(&self) -> usize {
        self.map.lock().unwrap().values().filter(|j| j.snapshot().state == JobState::Running).count()
    }

    fn insert(&self, e: Arc<JobEntry>) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let queued = map.values().filter(|j| j.owner == e.owner && !j.snapshot().state.finished()).count();
        if queued >= MAX_QUEUED_PER_ORIGIN {
            return Err("too many jobs are waiting".into());
        }
        let id = e.job.lock().unwrap().id.clone();
        map.insert(id.clone(), e);
        let mut o = self.order.lock().unwrap();
        o.push(id);
        // Keep the 500 most recent finished jobs.
        if o.len() > 1000 {
            let drop: Vec<String> = o.iter().filter(|id| map.get(*id).map(|j| j.snapshot().state.finished()).unwrap_or(true)).take(o.len() - 500).cloned().collect();
            for d in &drop {
                map.remove(d);
            }
            o.retain(|x| !drop.contains(x));
        }
        Ok(())
    }
}

/// What the request handler checked before a job is queued.
pub struct Prepared {
    pub profile: Profile,
    pub opts: BTreeMap<String, OptVal>,
    pub inputs: Vec<FileRec>,
}

/// Validate a request: profile, module, inputs (owned, not pointer files), options.
pub async fn prepare(svc: &Arc<Service>, owner: &str, req: &JobRequest) -> Result<Prepared, (u16, String)> {
    let profile = svc.profiles.iter().find(|p| p.id == req.profile).cloned().ok_or((404, format!("no profile {:?}", req.profile)))?;
    if let Some(g) = &profile.gate {
        if !svc.cfg.gate_open(g) {
            return Err((403, format!("{} is off: it would open a database connection, which stays off until the sidecar is signed and has passed its external security review", profile.title)));
        }
    }
    for m in std::iter::once(&profile.module).chain(profile.requires.iter()) {
        if !svc.caps.installed(m) {
            return Err((409, format!("the {} module is not installed", crate::modules::def(m).map(|m| m.title).unwrap_or("?"))));
        }
    }
    let n = req.inputs.len() as u32;
    if n < profile.min_inputs || n > profile.max_inputs || req.inputs.len() > gwb_sidecar_api::MAX_JOB_INPUTS {
        return Err((400, format!("{} takes {}–{} input(s), not {n}", profile.id, profile.min_inputs, profile.max_inputs)));
    }
    if let Some(r) = &req.reason {
        if r.chars().count() > 200 {
            return Err((400, "reason is longer than 200 characters".into()));
        }
    }
    if let Some(n) = &req.output_name {
        crate::paths::safe_name(n).map_err(|e| (400, format!("output_name: {e}")))?;
    }
    let mut inputs = Vec::new();
    for id in &req.inputs {
        let r = svc.files.get(id, owner).ok_or((404, format!("no file {id:?}")))?;
        if r.is_dir && !profile.allow_dir_inputs {
            let raster_input = profile.input == gwb_sidecar_api::DataKind::Raster || profile.id == "probe";
            if !(raster_input && is_tiledb_array(&r.path)) {
                let why = if raster_input && r.path.join("__tiledb_group.tdb").exists() { "a TileDB group, which can name other locations; pick the array inside it" } else { "a folder; use /v1/batch" };
                return Err((400, format!("{} is {why}", r.name)));
            }
        }
        if !r.is_dir && !profile.allow_pointer_inputs && is_pointer_file(&r.path) {
            return Err((422, format!("{} is a VRT or another file that points at other files or URLs; it is refused as an input", r.name)));
        }
        // S-45: PDAL 2.10 decodes DEFLATE BPF, but returns wrong coordinates without an error for
        // QuickLZ (1) and FastLZ (2). Refuse them rather than write a wrong COPC (the app itself
        // reads FastLZ BPF natively).
        if profile.steps.iter().any(|s| s.tool == "pdal") {
            if let Some(c) = bpf_compression(&r.path) {
                if c == 1 || c == 2 {
                    return Err((422, format!("{} is a BPF with {} compression, which PDAL does not decode correctly; {}", r.name, if c == 1 { "QuickLZ" } else { "FastLZ" }, if c == 2 { "open it in the app directly (it reads FastLZ BPF)" } else { "no decoder is available yet (S-45)" })));
                }
            }
        }
        inputs.push(r);
    }
    // Creation options are checked against the chosen driver's list, asked of GDAL first.
    for o in profile.options.iter().filter(|o| o.kind == gwb_sidecar_api::OptionKind::CreationOptions) {
        if let Some(Value::String(d)) = req.options.get(o.driver_option.as_deref().unwrap_or("")) {
            if svc.caps.raster_writer_any(d) {
                svc.caps.ensure_creation_options(d, o.flag.as_deref().unwrap_or("-co")).await.map_err(|e| (400, e))?;
            }
        }
    }
    if let Some(Value::String(d)) = req.options.get("driver") {
        if profile.id == "export-gdal" && FOLDER_WRITERS.iter().any(|w| w.eq_ignore_ascii_case(d)) {
            return Err((400, format!("{d} writes a folder, which this conversion cannot hand back{}", if d.eq_ignore_ascii_case("TileDB") { "; use Raster to a TileDB array" } else { "" })));
        }
    }
    let opts = profile.check_options(&req.options, svc.caps.as_ref()).map_err(|e| (400, e))?;
    Ok(Prepared { profile, opts, inputs })
}

pub fn enqueue(svc: &Arc<Service>, owner: &str, req: JobRequest, prep: Prepared, retry_of: Option<String>) -> Result<Arc<JobEntry>, String> {
    let (tx, _) = broadcast::channel(256);
    let job = Job { id: util::random_hex(12), profile: req.profile.clone(), state: JobState::Queued, progress: None, inputs: req.inputs.clone(), outputs: vec![], error: None, result: None, provenance: None, created: util::now_rfc3339(), reason: req.reason.clone(), retry_of };
    let e = Arc::new(JobEntry { owner: owner.into(), req, job: Mutex::new(job), log: Mutex::new(vec![]), events: Mutex::new(vec![]), tx, cancel: CancellationToken::new() });
    e.emit(JobEvent::State { state: JobState::Queued });
    svc.jobs.insert(e.clone())?;
    let svc2 = svc.clone();
    let e2 = e.clone();
    tokio::spawn(async move { run_job(svc2, e2, prep).await });
    Ok(e)
}

/// GDAL raster writers whose output is a folder, not a file.
const FOLDER_WRITERS: [&str; 2] = ["TileDB", "Zarr"];

/// A plain TileDB array, which GDAL opens as a raster. It holds only its own data, so unlike a group,
/// whose members can be URIs anywhere, it cannot reach outside the folder (REQ-SDC-14).
pub fn is_tiledb_array(p: &Path) -> bool {
    p.join("__schema").is_dir() && !p.join("__group").exists() && !p.join("__tiledb_group.tdb").exists()
}

/// The compression byte of a BPF v3 file ("BPF!" magic, byte 14), if it is one.
pub fn bpf_compression(path: &Path) -> Option<u8> {
    use std::io::Read;
    let mut h = [0u8; 16];
    std::fs::File::open(path).ok()?.read_exact(&mut h).ok()?;
    (&h[..4] == b"BPF!").then_some(h[14])
}

pub fn cancel(e: &JobEntry) {
    e.cancel.cancel();
}

struct JobSink {
    entry: Arc<JobEntry>,
    base: f64,
    weight: f64,
    workdir: PathBuf,
    budget: u64,
}

impl Sink for JobSink {
    fn log(&self, line: &str) {
        self.entry.log_line(line);
    }
    fn progress(&self, p: f64) {
        let v = (self.base + self.weight * p).clamp(0.0, 1.0);
        self.entry.job.lock().unwrap().progress = Some(v);
        self.entry.emit(JobEvent::Progress { progress: (v * 1000.0).round() / 1000.0 });
    }
    fn watchdog(&self) -> Option<String> {
        // Disk quota / disk full (REQ-SDC-06): the job's folder may not outgrow the space left.
        let used = dir_size(&self.workdir);
        (used > self.budget).then(|| format!("the output outgrew the space left for the sidecar ({} MB); the job was stopped", self.budget / 1_000_000))
    }
}

/// Address space a PDF job needs beyond its memory cap, on Linux. PDFium's allocator reserves its
/// pools when it starts (measured: 48 GiB fails, 64 GiB works) and aborts if it cannot, and Linux
/// caps a tool with RLIMIT_AS, which counts reservations; Windows caps committed memory. Only a
/// job that reads or writes a PDF gets it (writing too: gdal_translate reopens what it wrote), so
/// every other job keeps its cap. In such a job the cap no longer holds PDFium's own allocations,
/// which live inside those pools.
const PDF_ADDRESS_SPACE: u64 = 64 << 30;

fn address_headroom(windows: bool, inputs: &[FileRec], opts: &BTreeMap<String, OptVal>) -> u64 {
    let writes_pdf = matches!(opts.get("driver"), Some(OptVal::Text(d)) if d == "PDF");
    if !windows && (writes_pdf || inputs.iter().any(|r| !r.is_dir && is_pdf(&r.path))) {
        PDF_ADDRESS_SPACE
    } else {
        0
    }
}

/// The header GDAL's PDF driver identifies a file by.
fn is_pdf(path: &Path) -> bool {
    use std::io::Read;
    let mut h = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut h)).is_ok() && &h == b"%PDF"
}

/// The name GDAL gives subdataset `n` (from 1) in its JSON report.
fn subdataset_name(report: &Value, n: i64) -> Option<String> {
    report.pointer("/metadata/SUBDATASETS")?.get(format!("SUBDATASET_{n}_NAME"))?.as_str().map(String::from)
}

/// Each subdataset's number and GDAL's description of it, for a person to choose by.
fn subdataset_list(report: &Value) -> Vec<Value> {
    let Some(m) = report.pointer("/metadata/SUBDATASETS") else { return vec![] };
    (1..=2000).map_while(|n| m.get(format!("SUBDATASET_{n}_DESC")).and_then(|d| d.as_str()).map(|d| json!({"n": n, "desc": d.chars().take(160).collect::<String>()}))).collect()
}

/// `scale_factor` in MOD13 and in some other MODIS land products is a divisor: NDVI is the stored value
/// over 10000, where MOD09A1 of the same collection writes 0.0001 and MOD11A1 0.02. GDAL takes every one
/// as a multiplier, so the output would say NDVI 99 950 000. A scale of 10 or more on a unit that cannot
/// reach such values is that convention. Metres (MOD09GA Range, 25) and the like stay as they are.
fn modis_divisor(report: &Value) -> Option<f64> {
    let md = report.pointer("/metadata/")?;
    let name = md.get("SHORTNAME")?.as_str()?;
    if !["MOD", "MYD", "MCD"].iter().any(|p| name.starts_with(p)) {
        return None;
    }
    let scale = report.pointer("/bands/0/scale")?.as_f64()?;
    let unit = report.pointer("/bands/0/unit").or_else(|| md.get("units"))?.as_str()?.trim().to_ascii_lowercase();
    (scale >= 10.0 && ["reflectance", "ndvi", "evi", "degree", "degrees"].contains(&unit.as_str())).then_some(scale)
}

type Gcp = (f64, f64, f64, f64, f64);

fn gcp_list(report: &Value) -> Option<Vec<Gcp>> {
    let v = |g: &Value, k: &str| g.get(k).and_then(|x| x.as_f64());
    Some(report.pointer("/gcps/gcpList")?.as_array()?.iter().filter_map(|g| Some((v(g, "pixel")?, v(g, "line")?, v(g, "x")?, v(g, "y")?, v(g, "z").unwrap_or(0.0)))).collect())
}

/// GDAL places a swath's tie points through the dimension map even for a field that is already at the
/// geolocation's own size, such as Height in a MODIS L1B file, so they fall far outside the raster and
/// the field would land in a fifth of the swath. The tie points of such a field, put back on its pixels.
fn swath_gcps(report: &Value) -> Option<Vec<Gcp>> {
    let (w, h) = (report.pointer("/size/0")?.as_f64()?, report.pointer("/size/1")?.as_f64()?);
    let pts = gcp_list(report)?;
    let (pmin, pmax) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.0), a.1.max(p.0)));
    let (lmin, lmax) = pts.iter().fold((f64::MAX, f64::MIN), |a, p| (a.0.min(p.1), a.1.max(p.1)));
    if pts.is_empty() || (pmax <= w + 1.0 && lmax <= h + 1.0) {
        return None;
    }
    let (ix, iy) = ((pmax / w).round().max(1.0), (lmax / h).round().max(1.0));
    Some(pts.iter().map(|p| ((p.0 - pmin) / ix + 0.5, (p.1 - lmin) / iy + 0.5, p.2, p.3, p.4)).collect())
}

/// The CRS of a swath's tie points. GDAL's HDF4 driver leaves their own CRS empty: for ASTER it gives UTM
/// as the dataset's CRS, for MODIS nothing, though the points are longitude and latitude, and a COG with
/// neither holds coordinates that nobody can place.
fn swath_crs(report: &Value) -> Option<String> {
    let list = report.pointer("/gcps/gcpList")?.as_array()?;
    let wkt = |p: &str| report.pointer(p).and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    if list.is_empty() || report.get("driverShortName")?.as_str()? != "HDF4Image" || wkt("/gcps/coordinateSystem/wkt").is_some() {
        return None;
    }
    if let Some(w) = wkt("/coordinateSystem/wkt") {
        return Some(w.to_string());
    }
    let degrees = list.iter().all(|g| g.get("x").and_then(|v| v.as_f64()).is_some_and(|x| x.abs() <= 360.0) && g.get("y").and_then(|v| v.as_f64()).is_some_and(|y| y.abs() <= 90.0));
    degrees.then(|| "EPSG:4326".to_string())
}

/// What gdal_translate needs beyond the file, from GDAL's report on one subdataset.
fn sds_args(report: &Value) -> Vec<String> {
    let mut a = vec![];
    // MOD11 QC layers hold the text "NA" as _FillValue, which GDAL reads as 0: and 0 is their best-quality
    // value, so every good pixel would turn into no-data.
    let fill = report.pointer("/metadata/").and_then(|m| m.get("_FillValue")).and_then(|v| v.as_str());
    if fill.is_some_and(|f| f.trim_matches(|c: char| c.is_whitespace() || c == ' ').parse::<f64>().is_err()) {
        a.extend(["-a_nodata".to_string(), "none".to_string()]);
    }
    // gdal_translate gives -a_srs to tie points only when they come through -gcp.
    let crs = swath_crs(report);
    if let Some(c) = &crs {
        a.extend(["-a_srs".to_string(), c.clone()]);
    }
    if let Some(d) = modis_divisor(report) {
        a.extend(["-a_scale".to_string(), format!("{}", 1.0 / d)]);
        a.extend(["-mo".to_string(), format!("GWB_SCALE_NOTE=scale_factor {d} is a divisor in this product: the band scale is 1/{d}")]);
    }
    let gcps = swath_gcps(report).or_else(|| crs.and_then(|_| gcp_list(report)));
    for (p, l, x, y, z) in gcps.unwrap_or_default() {
        a.push("-gcp".into());
        a.extend([p, l, x, y, z].iter().map(|n| n.to_string()));
    }
    a
}

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            // Not DirEntry::metadata: on Windows the directory entry's size of a file that is
            // still being written lags behind; opening the file gives the real size.
            Ok(_) => std::fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0),
            Err(_) => 0,
        })
        .sum()
}

fn stem_of(name: &str) -> String {
    let n = name.trim();
    let lower = n.to_ascii_lowercase();
    for ext in [".copc.laz", ".tar.gz", ".nitf.gz", ".gdb.zip", ".shp.zip", ".gdb"] {
        if lower.ends_with(ext) {
            return n[..n.len() - ext.len()].to_string();
        }
    }
    match n.rfind('.') {
        Some(i) if i > 0 => n[..i].to_string(),
        _ => n.to_string(),
    }
}

async fn run_job(svc: Arc<Service>, e: Arc<JobEntry>, prep: Prepared) {
    let permit = tokio::select! {
        p = svc.jobs.sem.clone().acquire_owned() => p.ok(),
        _ = e.cancel.cancelled() => None,
    };
    if permit.is_none() || e.cancel.is_cancelled() {
        e.job.lock().unwrap().error = Some("cancelled before it started".into());
        finish(&e, JobState::Cancelled);
        return;
    }
    e.set_state(JobState::Running);
    let id = e.job.lock().unwrap().id.clone();
    let workdir = svc.cfg.data_dir.join("jobs").join(&id);
    let result = execute(&svc, &e, &prep, &workdir).await;
    match result {
        Ok((outputs, result, prov)) => {
            {
                let mut j = e.job.lock().unwrap();
                j.outputs = outputs.iter().map(|r| r.info()).collect();
                j.result = result;
                j.provenance = Some(prov);
                j.progress = Some(1.0);
            }
            e.log_line("finished");
            finish(&e, JobState::Succeeded);
        }
        Err(msg) => {
            let cancelled = e.cancel.is_cancelled();
            e.log_line(&msg);
            e.job.lock().unwrap().error = Some(msg);
            finish(&e, if cancelled { JobState::Cancelled } else { JobState::Failed });
        }
    }
    // Nothing of a job's working folder survives it: outputs were moved out on success.
    let _ = tokio::fs::remove_dir_all(&workdir).await;
    drop(permit);
}

fn finish(e: &JobEntry, s: JobState) {
    e.set_state(s);
    let snap = e.snapshot();
    e.emit(JobEvent::Done { job: snap });
}

type Outcome = (Vec<FileRec>, Option<Value>, Provenance);

async fn execute(svc: &Arc<Service>, e: &Arc<JobEntry>, prep: &Prepared, workdir: &Path) -> Result<Outcome, String> {
    let p = &prep.profile;
    let started = util::now_rfc3339();
    let outdir = workdir.join("out");
    let tmp = workdir.join("tmp");
    // The tools run at Low integrity and write only here (winjob.rs): label the folder first, so
    // everything created in it inherits the label.
    crate::winjob::create_low_dir(workdir).map_err(|err| format!("cannot create the job folder: {err}"))?;
    for d in [&outdir, &tmp] {
        std::fs::create_dir_all(d).map_err(|err| format!("cannot create the job folder: {err}"))?;
    }
    let inputs: Vec<String> = prep.inputs.iter().map(|r| r.path.display().to_string()).collect();
    let stem = stem_of(e.req.output_name.as_deref().or(prep.inputs.first().map(|r| r.name.as_str())).unwrap_or(&p.id));
    let ext = if p.output_ext == "*" {
        let d = match prep.opts.get("driver") {
            Some(OptVal::Text(d)) => svc.caps.driver(d),
            _ => None,
        };
        d.and_then(|d| d.extensions.first().cloned()).unwrap_or_else(|| "dat".into())
    } else {
        p.output_ext.clone()
    };
    let out_name = if ext.is_empty() { String::new() } else { format!("{}.{}", p.output_name.replace("{stem}", &stem), ext) };
    let out_name = if out_name.is_empty() { out_name } else { crate::paths::safe_name(&out_name).map_err(|err| err.to_string())? };
    let output = outdir.join(&out_name);
    let list = workdir.join("inputs.txt");
    std::fs::write(&list, inputs.join(if cfg!(windows) { "\r\n" } else { "\n" })).map_err(|err| err.to_string())?;
    let tools: Vec<String> = p.steps.iter().map(|s| s.tool.clone()).collect();
    let versions = svc.caps.snap.lock().unwrap().tools.clone();
    let ver_of = |tool: &str| -> String {
        let m = crate::modules::module_of_tool(tool).map(|m| m.id).unwrap_or("");
        versions.iter().find(|t| t.module == m).map(|t| t.version.clone()).unwrap_or_default()
    };
    let opt_text: Vec<String> = prep.opts.iter().map(|(k, v)| format!("{k}={}", v.render())).collect();
    let provenance_line = format!("gwb-sidecar {} profile={} tools={} {} options[{}]", env!("CARGO_PKG_VERSION"), p.id, tools.join("+"), ver_of(&tools[0]), opt_text.join(" "));
    let mut ctx = ExpandCtx { inputs: inputs.clone(), output: output.display().to_string(), workdir: tmp.display().to_string(), provenance: provenance_line.chars().take(900).collect(), stem: stem.clone(), list: list.display().to_string(), script_dir: svc.cfg.modules_dir.join("sar").join("scripts").display().to_string(), modules_dir: svc.cfg.modules_dir.display().to_string(), sds: String::new(), sds_args: vec![] };
    let quota_left = svc.space_left();
    let steps: Vec<_> = p.steps.iter().filter(|s| p.step_runs(s, &prep.opts)).collect();
    let total_w: f64 = steps.iter().map(|s| s.weight.unwrap_or(1.0)).sum::<f64>().max(1e-9);
    let mut base = 0.0;
    let mut records = Vec::new();
    let mut captures = serde_json::Map::new();
    for s in &steps {
        if e.cancel.is_cancelled() {
            return Err("cancelled".into());
        }
        let w = s.weight.unwrap_or(1.0) / total_w;
        if s.optional && !svc.caps.tool_available(&s.tool) {
            e.log_line(&format!("{}: not installed, skipped", s.tool));
            base += w;
            continue;
        }
        let args = p.expand(s, &ctx, &prep.opts)?;
        e.log_line(&format!("$ {} {}", s.tool, args.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" ")));
        let sink = Arc::new(JobSink { entry: e.clone(), base, weight: w, workdir: workdir.to_path_buf(), budget: quota_left });
        let spec = RunSpec {
            modules_dir: &svc.cfg.modules_dir,
            tool: &s.tool,
            args: &args,
            cwd: &tmp,
            tmp: &tmp,
            limits: JobLimits { memory_bytes: (p.memory_mb << 20) + address_headroom(cfg!(windows), &prep.inputs, &prep.opts), cpu_seconds: p.cpu_limit_s, processes: p.processes },
            wall: Duration::from_secs(p.time_limit_s),
            capture_stdout: if s.capture.is_some() { 16 << 20 } else { 0 },
            progress: Progress::parse(&s.progress),
        };
        let o = runner::run(spec, e.cancel.clone(), sink).await?;
        e.log_line(&format!("{}: {} ms, peak memory {} MB", s.tool, o.ms, o.peak_memory >> 20));
        records.push(StepRecord { tool: s.tool.clone(), version: ver_of(&s.tool), args: args.clone(), exit_code: o.exit_code, ms: o.ms });
        if o.cancelled {
            return Err("cancelled; the tool was stopped and nothing was kept".into());
        }
        if let Some(r) = o.killed_reason {
            return Err(r);
        }
        if o.timed_out {
            return Err(format!("{} ran longer than the profile allows ({} s) and was stopped", s.tool, p.time_limit_s));
        }
        if let Some(key) = &s.capture {
            if o.exit_code == Some(0) {
                let text = String::from_utf8_lossy(&o.stdout);
                let v = serde_json::from_str::<Value>(text.trim()).unwrap_or_else(|_| Value::String(text.chars().take(4000).collect()));
                match (key.as_str(), prep.opts.get("subdataset")) {
                    ("gdal", Some(OptVal::Int(n))) => ctx.sds = subdataset_name(&v, *n).ok_or_else(|| format!("{} has no subdataset {n}", prep.inputs[0].name))?,
                    ("sds", _) => ctx.sds_args = sds_args(&v),
                    _ => {}
                }
                captures.insert(key.clone(), v);
            } else {
                if key == "gdal" && prep.opts.contains_key("subdataset") {
                    return Err(format!("{} cannot be read as a raster: {}", prep.inputs[0].name, o.stderr_tail.last().cloned().unwrap_or_default()));
                }
                captures.insert(key.clone(), Value::Null);
            }
        } else if o.exit_code != Some(0) {
            let why = o.stderr_tail.iter().rev().find(|l| l.contains("ERROR") || l.contains("rror")).cloned().or_else(|| o.stderr_tail.last().cloned()).unwrap_or_default();
            let mem = if o.peak_memory >= (p.memory_mb << 20) * 95 / 100 { format!(" (it reached the {} MB memory cap)", p.memory_mb) } else { String::new() };
            return Err(format!("{} failed (exit {}){mem}: {why}", s.tool, o.exit_code.map(|c| c.to_string()).unwrap_or_else(|| "killed".into())));
        }
        base += w;
        let _ = w;
    }
    let prov = Provenance { sidecar: format!("gwb-sidecar {}", env!("CARGO_PKG_VERSION")), profile: p.id.clone(), options: prep.opts.iter().map(|(k, v)| (k.clone(), v.to_json())).collect(), inputs: prep.inputs.iter().map(|r| r.name.clone()).collect(), steps: records, started, finished: util::now_rfc3339() };
    if p.output_ext.is_empty() {
        // probe: the result is the tools' reports and the matching profile. Any other profile
        // without an output (the FileGDB catalogue) answers with what its steps captured.
        let first = prep.inputs.first().map(|r| r.path.clone()).unwrap_or_default();
        let result = if p.id == "probe" { probe_match(&first, &captures, svc) } else { Value::Object(captures) };
        return Ok((vec![], Some(result), prov));
    }
    if let Some(z) = &p.zip_dir {
        let src = tmp.join(z);
        let cancel = e.cancel.clone();
        let (out, src2) = (output.clone(), src.clone());
        tokio::task::spawn_blocking(move || crate::zipdir::zip_dir(&src2, &out, &cancel)).await.map_err(|err| err.to_string())??;
    }
    // Publish: only now, only if the main output exists and is not empty.
    let main_ok = std::fs::metadata(&output).map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
    if !main_ok {
        return Err(format!("{} produced no output", p.steps.last().map(|s| s.tool.as_str()).unwrap_or("the tool")));
    }
    let job_id = e.job.lock().unwrap().id.clone();
    let pub_dir = svc.cfg.data_dir.join("outputs").join(&job_id);
    std::fs::create_dir_all(&pub_dir).map_err(|err| err.to_string())?;
    let prov_name = format!("{out_name}.gwb-provenance.json");
    std::fs::write(outdir.join(&prov_name), serde_json::to_vec_pretty(&prov).unwrap_or_default()).map_err(|err| err.to_string())?;
    let mut names: Vec<String> = std::fs::read_dir(&outdir).map_err(|err| err.to_string())?.flatten().filter(|d| d.file_type().map(|t| t.is_file()).unwrap_or(false)).map(|d| d.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by_key(|n| (n != &out_name, n.ends_with(".gwb-provenance.json"), n.clone()));
    let group = util::random_hex(12);
    let mut recs = Vec::new();
    for n in names {
        let src = outdir.join(&n);
        let dst = pub_dir.join(&n);
        std::fs::rename(&src, &dst).map_err(|err| format!("could not publish {n}: {err}"))?;
        let size = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
        let r = FileRec { id: util::random_hex(16), name: n, size, origin: FileOrigin::Output, owner: e.owner.clone(), path: dst, group: group.clone(), entries: vec![], is_dir: false, created: util::unix_secs() };
        svc.files.insert(r.clone());
        recs.push(r);
    }
    Ok((recs, None, prov))
}

/// Universal import (REQ-SDC-09): which profile fits the probed file.
pub fn probe_match(path: &Path, cap: &serde_json::Map<String, Value>, svc: &Service) -> Value {
    let mut matches = Vec::new();
    let head = std::fs::read(path).map(|b| b.into_iter().take(16).collect::<Vec<u8>>()).unwrap_or_default();
    let has = |id: &str| svc.caps.installed(svc.profiles.iter().find(|p| p.id == id).map(|p| p.module.as_str()).unwrap_or(""));
    if let Some(p) = cap.get("pdal").filter(|v| v.is_object()) {
        let reader = p.get("reader").or_else(|| p.pointer("/summary/reader")).cloned().unwrap_or(Value::Null);
        let count = p.pointer("/summary/num_points").cloned().unwrap_or(Value::Null);
        matches.push(json!({"kind": "points", "profile": "points-copc", "format": reader, "points": count, "available": has("points-copc")}));
    }
    if let Some(f) = cap.get("ffprobe").filter(|v| v.is_object()) {
        let streams = f.get("streams").and_then(|s| s.as_array()).cloned().unwrap_or_default();
        let video: Vec<&Value> = streams.iter().filter(|s| s.get("codec_type") == Some(&json!("video"))).collect();
        let fmt = f.pointer("/format/format_name").and_then(|v| v.as_str()).unwrap_or("");
        let klv = streams.iter().filter(|s| s.get("codec_name").and_then(|c| c.as_str()) == Some("klv") || s.get("codec_tag_string").and_then(|c| c.as_str()) == Some("KLVA")).count();
        if let Some(v) = video.first() {
            let codec = v.get("codec_name").and_then(|c| c.as_str()).unwrap_or("");
            let container = if fmt.contains("mpegts") { "mpegts" } else if fmt == "mpeg" || fmt.contains("mpeg,") { "mpeg" } else { fmt };
            if codec == "mpeg2video" || codec == "mpeg1video" {
                matches.push(json!({"kind": "video", "profile": "video-h264-klv", "format": format!("{codec} in {fmt}"), "options": {"container": container}, "klv_streams": klv, "available": has("video-h264-klv") && (container == "mpegts" || container == "mpeg")}));
            } else if !fmt.contains("image2") && !fmt.contains("tiff") && !fmt.contains("png") && !fmt.contains("jpeg") && !fmt.contains("fits") {
                matches.push(json!({"kind": "video", "profile": null, "format": format!("{codec} in {fmt}"), "klv_streams": klv, "available": false}));
            }
        }
    }
    if let Some(g) = cap.get("gdal").filter(|v| v.is_object()) {
        let drv = g.get("driverShortName").and_then(|v| v.as_str()).unwrap_or("");
        let bands = g.get("bands").and_then(|b| b.as_array()).map(|a| a.len()).unwrap_or(0);
        // A container (HDF4, HDF5, netCDF, a PDF of several pages) lists its subdatasets.
        let subs = g.pointer("/metadata/SUBDATASETS").and_then(|m| m.as_object()).map(|m| m.keys().filter(|k| k.ends_with("_NAME")).count()).unwrap_or(0);
        let sub_list = subdataset_list(g);
        if bands > 0 {
            let id = if drv == "PDF" { "pdf-cog" } else { "raster-cog" };
            matches.push(json!({"kind": "raster", "profile": id, "format": drv, "long_name": g.get("driverLongName"), "size": g.get("size"), "bands": bands, "subdatasets": subs, "subdataset_list": sub_list, "available": has(id)}));
        } else if subs > 0 {
            matches.push(json!({"kind": "raster", "profile": "raster-sds-cog", "format": drv, "long_name": g.get("driverLongName"), "subdatasets": subs, "subdataset_list": sub_list, "available": has("raster-sds-cog")}));
        }
    }
    if let Some(o) = cap.get("ogr").filter(|v| v.is_object()) {
        let layers = o.get("layers").and_then(|l| l.as_array()).cloned().unwrap_or_default();
        if !layers.is_empty() {
            let drv = o.get("driverShortName").and_then(|v| v.as_str()).unwrap_or("");
            let summary: Vec<Value> = layers.iter().take(50).map(|l| json!({"name": l.get("name"), "features": l.get("featureCount"), "geometry": l.pointer("/geometryFields/0/type")})).collect();
            matches.push(json!({"kind": "vector", "profile": "vector-gpkg", "format": drv, "layers": summary, "available": has("vector-gpkg")}));
        }
    }
    let best = matches.iter().find(|m| m.get("available") == Some(&json!(true))).cloned().unwrap_or(Value::Null);
    // Trim the raw reports: the app needs the match, the sidecar log keeps the rest.
    let mut tools = serde_json::Map::new();
    for (k, v) in cap {
        let t = serde_json::to_string(v).unwrap_or_default();
        tools.insert(k.clone(), if t.len() > 200_000 { json!({"truncated": true, "bytes": t.len()}) } else { v.clone() });
    }
    json!({"match": best, "matches": matches, "tools": tools})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_pdf_gets_address_space_and_only_on_linux() {
        let d = std::env::temp_dir().join(format!("gwb-pdf-{}", util::random_hex(4)));
        std::fs::create_dir_all(&d).unwrap();
        let rec = |name: &str, body: &[u8], is_dir: bool| {
            let path = d.join(name);
            if !is_dir {
                std::fs::write(&path, body).unwrap();
            }
            FileRec { id: name.into(), name: name.into(), size: 0, origin: FileOrigin::Upload, owner: "null".into(), path, group: "g".into(), entries: vec![], is_dir, created: 0 }
        };
        let pdf = rec("a.pdf", b"%PDF-1.7\n", false);
        let tif = rec("a.tif", b"II*\0", false);
        let named = rec("b.pdf", b"II*\0", false); // the header decides, not the name
        let short = rec("c.pdf", b"%P", false);
        let dir = rec("x.gdb", b"", true);
        let none = BTreeMap::new();
        assert_eq!(address_headroom(false, std::slice::from_ref(&pdf), &none), PDF_ADDRESS_SPACE);
        assert_eq!(address_headroom(true, std::slice::from_ref(&pdf), &none), 0);
        assert_eq!(address_headroom(false, &[tif.clone(), pdf.clone()], &none), PDF_ADDRESS_SPACE);
        // Writing a PDF: the input is not one, and the tool still opens PDFium on its output.
        let writer = |d: &str| BTreeMap::from([("driver".to_string(), OptVal::Text(d.into()))]);
        assert_eq!(address_headroom(false, std::slice::from_ref(&tif), &writer("PDF")), PDF_ADDRESS_SPACE);
        assert_eq!(address_headroom(true, std::slice::from_ref(&tif), &writer("PDF")), 0);
        assert_eq!(address_headroom(false, std::slice::from_ref(&tif), &writer("GTiff")), 0);
        for other in [tif, named, short, dir] {
            assert_eq!(address_headroom(false, &[other], &none), 0);
        }
        assert_eq!(address_headroom(false, &[], &none), 0);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn modis_divisor_scales_are_told_from_multipliers() {
        let r = |name: &str, scale: f64, unit: &str| json!({"metadata": {"": {"SHORTNAME": name, "units": unit}}, "bands": [{"scale": scale}]});
        assert_eq!(modis_divisor(&r("MOD13Q1", 10000.0, "NDVI")), Some(10000.0));
        assert_eq!(modis_divisor(&r("MYD13A1", 100.0, "degrees")), Some(100.0));
        // Real multipliers of the same collection.
        assert_eq!(modis_divisor(&r("MOD09A1", 0.0001, "reflectance")), None);
        assert_eq!(modis_divisor(&r("MOD09GA", 25.0, "meters")), None);
        assert_eq!(modis_divisor(&r("MOD11A1", 0.02, "K")), None);
        // Not MODIS: left alone.
        assert_eq!(modis_divisor(&r("OTHER", 10000.0, "reflectance")), None);
        let a = sds_args(&r("MOD13Q1", 10000.0, "NDVI"));
        assert_eq!(&a[..2], ["-a_scale", "0.0001"]);
        assert!(sds_args(&r("MOD09A1", 0.0001, "reflectance")).is_empty());
    }

    #[test]
    fn swath_tie_points_outside_the_raster_are_put_back_on_it() {
        // Height, 271 x 886, at the geolocation's size, with tie points placed for the 1 km image.
        let gcp = |p: f64, l: f64| json!({"pixel": p, "line": l, "x": 1.0, "y": 2.0, "z": 0.0});
        let r = json!({"size": [271, 886], "gcps": {"gcpList": [gcp(2.5, 2.5), gcp(122.5, 2.5), gcp(1322.5, 4402.5)]}});
        let g = swath_gcps(&r).unwrap();
        assert_eq!((g[0].0, g[0].1), (0.5, 0.5));
        assert_eq!((g[1].0, g[1].1), (24.5, 0.5));
        assert_eq!((g[2].0, g[2].1), (264.5, 880.5));
        // Tie points already on the raster stay.
        let r = json!({"size": [1354, 2030], "gcps": {"gcpList": [gcp(2.5, 2.5), gcp(1322.5, 2002.5)]}});
        assert!(swath_gcps(&r).is_none());
        assert!(swath_gcps(&json!({"size": [10, 10]})).is_none());
    }

    #[test]
    fn a_fill_value_that_is_text_is_no_no_data() {
        let r = |f: &str| json!({"metadata": {"": {"_FillValue": f}}});
        assert_eq!(sds_args(&r("NA")), ["-a_nodata", "none"]);
        assert!(sds_args(&r("-28672")).is_empty());
        assert!(sds_args(&r("0")).is_empty());
    }

    #[test]
    fn a_swath_keeps_a_crs_for_its_tie_points() {
        let gcp = |x: f64, y: f64| json!({"pixel": 1.0, "line": 1.0, "x": x, "y": y, "z": 0.0});
        let modis = json!({"driverShortName": "HDF4Image", "gcps": {"gcpList": [gcp(-110.0, 40.0)]}});
        assert_eq!(swath_crs(&modis).as_deref(), Some("EPSG:4326"));
        let aster = json!({"driverShortName": "HDF4Image", "coordinateSystem": {"wkt": "PROJCRS[]"}, "gcps": {"gcpList": [gcp(583483.0, 4251166.0)]}});
        assert_eq!(swath_crs(&aster).as_deref(), Some("PROJCRS[]"));
        let unknown = json!({"driverShortName": "HDF4Image", "gcps": {"gcpList": [gcp(583483.0, 4251166.0)]}});
        assert_eq!(swath_crs(&unknown), None);
        let other = json!({"driverShortName": "netCDF", "gcps": {"gcpList": [gcp(-110.0, 40.0)]}});
        assert_eq!(swath_crs(&other), None);
        let grid = json!({"driverShortName": "HDF4Image"});
        assert_eq!(swath_crs(&grid), None);
        // Through -gcp, or the CRS would not reach the tie points.
        let a = sds_args(&modis);
        assert_eq!(&a[..2], ["-a_srs", "EPSG:4326"]);
        assert_eq!(a.iter().filter(|x| *x == "-gcp").count(), 1);
    }

    #[test]
    fn a_tiledb_array_is_a_raster_input_and_a_group_is_not() {
        let d = std::env::temp_dir().join(format!("gwb-tdb-{}", util::random_hex(6)));
        std::fs::create_dir_all(d.join("__schema")).unwrap();
        assert!(is_tiledb_array(&d));
        std::fs::write(d.join("__tiledb_group.tdb"), b"").unwrap();
        assert!(!is_tiledb_array(&d));
        std::fs::remove_dir_all(&d).unwrap();
        assert!(!is_tiledb_array(&std::env::temp_dir()));
    }

    #[test]
    fn subdatasets_are_found_by_number() {
        let r = json!({"metadata": {"SUBDATASETS": {"SUBDATASET_1_NAME": "PDF:1:a.pdf", "SUBDATASET_1_DESC": "Page 1", "SUBDATASET_2_NAME": "PDF:2:a.pdf"}}});
        assert_eq!(subdataset_name(&r, 2).as_deref(), Some("PDF:2:a.pdf"));
        assert_eq!(subdataset_name(&r, 3), None);
        assert_eq!(subdataset_name(&json!({"metadata": {}}), 1), None);
    }

    #[test]
    fn stems() {
        assert_eq!(stem_of("Hamilton.sid"), "Hamilton");
        assert_eq!(stem_of("x.copc.laz"), "x");
        assert_eq!(stem_of("testopenfilegdb.gdb.zip"), "testopenfilegdb");
        assert_eq!(stem_of("noext"), "noext");
        assert_eq!(stem_of(".hidden"), ".hidden");
    }
}
