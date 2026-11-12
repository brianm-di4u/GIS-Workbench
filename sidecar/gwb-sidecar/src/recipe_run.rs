//! The command-line runner (REG-150): one recipe, run in the installed browser with nobody at the
//! page. Two programs run it: `gwb-run`, a console program, so a shell or cron waits for it, sees
//! its output and gets its exit code; and `gwb-sidecar run`, which takes the same arguments and
//! opens no window at all, for Windows Task Scheduler (gwb-sidecar is a windowed program, so
//! Windows gives it no console). Without a console, the log in the output folder is the output.
//!
//!   gwb-run <recipe> --out DIR [--in [STEP=]FILE]... [--gates continue|fail|stop] [--params FILE]
//!           [--timeout SECONDS] [--browser PATH] [--app-dir DIR]
//!   gwb-run --check [--browser PATH] [--app-dir DIR]
//!
//! A run starts the installed Chrome or Edge headless with a fresh profile, opens the sidecar's own
//! copy of the app (only when it matches app/SHA256SUMS) as a file, and runs the recipe there with
//! the automation API's `recipes.run`: the same code as a run in the page. The DevTools protocol runs
//! over a pipe, so nothing listens on any port (decision 0017).
//!
//! `<recipe>` is a .gwrecipe.json file or a built-in recipe id. `--in FILE` opens FILE in the app
//! before the run; `--in STEP=FILE` gives FILE to that step's `files` parameter. A recipe with a
//! step that would open a dialog, or a review gate when gates are set to stop, is refused before
//! anything runs, naming the step. `--params FILE` is a JSON object of parameter overrides by step
//! id. The run's files are written to DIR, each with a `.gwb-provenance.json` beside it, and the
//! run appends to DIR/gwb-run.log and writes its status to DIR/gwb-run.json when it finishes (a
//! run removes the last one when it starts).
//!
//! `--check` only starts the browser and the app, and prints the browser, the app build and the
//! automation API version.
//!
//! GWB_RUN_BROWSER_LOG=<file> writes the browser's own error output to that file, to see why a
//! browser did not start.
//!
//! Exit codes: 0 the run finished and every step succeeded; 1 the run failed or stopped at a gate;
//! 2 the command line is wrong; 3 no browser, no verified app, or the browser or app did not
//! start; 4 the recipe was refused; 5 the run did not finish within --timeout.

use crate::cdp::{find_browser, Browser};
use gwb_sidecar_api::{Provenance, StepRecord};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const USAGE: &str = "usage: gwb-run <recipe> --out DIR [--in [STEP=]FILE]... [--gates continue|fail|stop] [--params FILE] [--timeout SECONDS] [--browser PATH] [--app-dir DIR]\n       gwb-run --check [--browser PATH] [--app-dir DIR]";

/// The page's half of a run (see the file for its protocol).
const PAGE: &str = include_str!("recipe_run_page.js");

/// Bytes per read of an output file from the page: about 5.6 MB of base64 per message.
const CHUNK: u64 = 4 << 20;

#[derive(Debug, PartialEq)]
struct Args {
    check: bool,
    recipe: Option<String>,
    /// (name, file): the id of the step that gets the file, or "" for a file to open in the app
    /// (no step id is empty, so a step may be called anything, "open" included).
    inputs: Vec<(String, PathBuf)>,
    out: Option<PathBuf>,
    gates: String,
    params: Option<PathBuf>,
    timeout: Duration,
    browser: Option<PathBuf>,
    app_dir: Option<PathBuf>,
}

impl Default for Args {
    fn default() -> Self {
        Args {
            check: false,
            recipe: None,
            inputs: Vec::new(),
            out: None,
            gates: "continue".into(),
            params: None,
            timeout: Duration::from_secs(3600),
            browser: None,
            app_dir: None,
        }
    }
}

/// `--in` takes `STEP=FILE` when what comes before the first `=` is a step id (letters, digits,
/// `-` and `_`), else the whole value is a file to open. A file whose own name looks like that
/// (`site=2024.tif`) is taken whole when it exists and the part after `=` doesn't.
fn input(v: &str) -> (String, PathBuf) {
    input_with(v, |p| p.is_file())
}

fn input_with(v: &str, is_file: impl Fn(&Path) -> bool) -> (String, PathBuf) {
    if let Some((name, file)) = v.split_once('=') {
        if !name.is_empty()
            && !file.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            && !(is_file(Path::new(v)) && !is_file(Path::new(file)))
        {
            return (name.to_string(), PathBuf::from(file));
        }
    }
    (String::new(), PathBuf::from(v))
}

fn parse(argv: &[String]) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match arg.as_str() {
            "--check" => a.check = true,
            "--in" => a.inputs.push(input(&value("--in")?)),
            "--out" => a.out = Some(PathBuf::from(value("--out")?)),
            "--gates" => {
                a.gates = value("--gates")?;
                if !["continue", "fail", "stop"].contains(&a.gates.as_str()) {
                    return Err(format!(
                        "--gates is continue, fail or stop, not {}",
                        a.gates
                    ));
                }
            }
            "--params" => a.params = Some(PathBuf::from(value("--params")?)),
            "--timeout" => {
                let v = value("--timeout")?;
                match v.parse::<u64>() {
                    Ok(s) if s > 0 => a.timeout = Duration::from_secs(s),
                    _ => return Err(format!("--timeout is a number of seconds, not {v}")),
                }
            }
            "--browser" => a.browser = Some(PathBuf::from(value("--browser")?)),
            "--app-dir" => a.app_dir = Some(PathBuf::from(value("--app-dir")?)),
            "-h" | "--help" => return Err(String::new()),
            other if other.starts_with('-') => return Err(format!("unknown argument {other}")),
            other => {
                if a.recipe.is_some() {
                    return Err(format!("one recipe per run (also given {other})"));
                }
                a.recipe = Some(other.to_string());
            }
        }
    }
    if a.check {
        if a.recipe.is_some() {
            return Err("--check runs no recipe".into());
        }
    } else if a.recipe.is_none() {
        return Err("nothing to do".into());
    } else if a.out.is_none() {
        return Err("give --out DIR for the run's files".into());
    }
    Ok(a)
}

/// Run the command line `argv` (without the program name); the result is the exit code.
pub fn main(argv: &[String]) -> u8 {
    let args = match parse(argv) {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("gwb-run: {e}");
            }
            eprintln!("{USAGE}");
            return 2;
        }
    };
    // The status is written only when a run gets to its end, so a run that stops early must not
    // leave the last run's status looking like its own.
    if let Some(out) = &args.out {
        let _ = std::fs::remove_file(out.join("gwb-run.json"));
    }
    if args.check {
        return match check(&args) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!("gwb-run: {e}");
                3
            }
        };
    }
    let job = match Job::prepare(&args) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("gwb-run: {e}");
            eprintln!("{USAGE}");
            // A scheduled run has no console, so the reason (a missing input, say) goes in the log too.
            if let Some(mut log) = args
                .out
                .as_deref()
                .filter(|o| std::fs::create_dir_all(o).is_ok())
                .and_then(|o| Log::open(o).ok())
            {
                log.line(&format!("gwb-run: {e}"));
                log.line("exit 2");
            }
            return 2;
        }
    };
    let mut log = match Log::open(&job.out) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("gwb-run: {e}");
            return 3;
        }
    };
    let code = run(&args, &job, &mut log);
    log.line(&format!("exit {code}"));
    code
}

/// The app folder: --app-dir, else `app` beside the executable (where the installer puts it).
fn app_dir(args: &Args) -> PathBuf {
    args.app_dir.clone().unwrap_or_else(|| {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("app")))
            .unwrap_or_else(|| PathBuf::from("app"))
    })
}

/// This run's own folder (the staged app and the browser profile), removed when it goes.
struct WorkDir(PathBuf);

impl Drop for WorkDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A started browser with the verified app open in its page. Fields drop in order: the browser
/// goes (and lets go of its profile) before its folder is removed.
struct Session {
    b: Browser,
    page: String,
    exe: PathBuf,
    _work: WorkDir,
}

fn start(args: &Args) -> Result<Session, String> {
    let exe = find_browser(args.browser.as_deref())?;
    // The verified bytes, written into this run's own folder: the browser opens that copy, so the
    // file it runs is the one that was checked.
    let html = crate::appserve::load(&app_dir(args), "")?;
    let work =
        WorkDir(std::env::temp_dir().join(format!("gwb-run-{}", crate::util::random_hex(6))));
    let page_dir = work.0.join("page");
    std::fs::create_dir_all(&page_dir).map_err(|e| format!("could not make a work folder: {e}"))?;
    let file = page_dir.join("gis-workbench.html");
    std::fs::write(&file, &html).map_err(|e| format!("could not stage the app: {e}"))?;
    let mut b = Browser::launch(&exe, &work.0.join("profile"))?;
    let page = b.attach_page()?;
    open_app(&mut b, &page, &file)?;
    Ok(Session {
        b,
        page,
        exe,
        _work: work,
    })
}

fn check(args: &Args) -> Result<(), String> {
    let mut s = start(args)?;
    let version = s.b.call(
        "Browser.getVersion",
        json!({}),
        None,
        Duration::from_secs(30),
    )?;
    let page = s.page.clone();
    let api = s.b.eval(
        &page,
        "gisworkbench.api.v2.call('api.version', {})",
        Duration::from_secs(30),
    )?;
    println!(
        "browser {} ({})",
        version["product"].as_str().unwrap_or("?"),
        s.exe.display()
    );
    println!("app build {}", api["build"].as_str().unwrap_or("?"));
    println!("automation API {}", api["api"].as_str().unwrap_or("?"));
    Ok(())
}

/// What the command line asks for, read and checked before any browser starts.
struct Job {
    /// The recipe's id when it is a built-in one, else its JSON.
    id: Option<String>,
    recipe: Option<Value>,
    params: Value,
    /// Absolute paths, in command-line order.
    inputs: Vec<(String, PathBuf)>,
    out: PathBuf,
}

impl Job {
    fn prepare(args: &Args) -> Result<Job, String> {
        let r = args.recipe.as_deref().unwrap_or_default();
        let (id, recipe) = if Path::new(r).is_file() {
            let text =
                std::fs::read_to_string(r).map_err(|e| format!("could not read {r}: {e}"))?;
            let v: Value = serde_json::from_str(&text)
                .map_err(|e| format!("{r} is not a JSON recipe: {e}"))?;
            (None, Some(v))
        } else if r.ends_with(".json") || r.contains(['/', '\\']) {
            return Err(format!("there is no recipe file {r}"));
        } else {
            (Some(r.to_string()), None)
        };
        let params = match &args.params {
            None => json!({}),
            Some(p) => {
                let text = std::fs::read_to_string(p)
                    .map_err(|e| format!("could not read {}: {e}", p.display()))?;
                let v: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("{} is not JSON: {e}", p.display()))?;
                if !v.is_object() {
                    return Err(format!(
                        "{} is not a JSON object of parameters by step id",
                        p.display()
                    ));
                }
                v
            }
        };
        let mut inputs = Vec::new();
        for (name, f) in &args.inputs {
            if !f.is_file() {
                return Err(format!("there is no input file {}", f.display()));
            }
            let abs = std::path::absolute(f)
                .map_err(|e| format!("could not resolve {}: {e}", f.display()))?;
            inputs.push((name.clone(), abs));
        }
        let out = args.out.clone().unwrap_or_default();
        std::fs::create_dir_all(&out)
            .map_err(|e| format!("could not make the output folder {}: {e}", out.display()))?;
        Ok(Job {
            id,
            recipe,
            params,
            inputs,
            out,
        })
    }
}

/// The run's log: each line to standard output and appended to DIR/gwb-run.log, so a scheduled run
/// leaves its history.
struct Log {
    file: std::fs::File,
}

impl Log {
    fn open(dir: &Path) -> Result<Log, String> {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("gwb-run.log"))
            .map_err(|e| format!("could not open the log in {}: {e}", dir.display()))?;
        Ok(Log { file })
    }

    fn line(&mut self, text: &str) {
        println!("{text}");
        let _ = writeln!(self.file, "{} {text}", crate::util::now_rfc3339());
    }
}

fn run(args: &Args, job: &Job, log: &mut Log) -> u8 {
    let started = crate::util::now_rfc3339();
    let t0 = Instant::now();
    log.line(&format!(
        "gwb-run {}: recipe {}",
        env!("CARGO_PKG_VERSION"),
        args.recipe.as_deref().unwrap_or("?")
    ));
    let mut s = match start(args) {
        Ok(s) => s,
        Err(e) => {
            log.line(&format!("could not start: {e}"));
            return 3;
        }
    };
    let page = s.page.clone();
    let about = s.b.eval(
        &page,
        "gisworkbench.api.v2.call('api.version', {})",
        Duration::from_secs(30),
    );
    let build = about
        .as_ref()
        .ok()
        .and_then(|a| a["build"].as_str())
        .unwrap_or("?")
        .to_string();
    log.line(&format!("browser {}, app build {build}", s.exe.display()));
    if let Err(e) = give_inputs(&mut s, &job.inputs) {
        log.line(&format!("could not give the inputs to the page: {e}"));
        return 3;
    }
    let left = args.timeout.saturating_sub(t0.elapsed());
    let call = format!(
        "({})({})",
        PAGE,
        json!({
            "id": job.id,
            "recipe": job.recipe,
            "gates": args.gates,
            "params": job.params,
            "inputs": job.inputs.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(),
            "timeoutMs": left.as_millis() as u64,
        })
    );
    let answer = match s.b.eval(&page, &call, left) {
        Ok(a) => a,
        Err(e) => {
            let late = t0.elapsed() >= args.timeout;
            log.line(&format!(
                "the run {}: {e}",
                if late { "timed out" } else { "failed" }
            ));
            for x in &s.b.exceptions {
                log.line(&format!("  the page reported: {x}"));
            }
            return if late { 5 } else { 1 };
        }
    };
    // A run that finishes can still have had a dialog dismissed (decision 0017): say so.
    for x in &s.b.exceptions {
        log.line(&format!("  the page reported: {x}"));
    }
    if let Some(why) = answer["refused"].as_str() {
        log.line(&format!("refused, nothing was run: {why}"));
        return 4;
    }
    let status = answer["status"].clone();
    for st in status["steps"].as_array().into_iter().flatten() {
        log.line(&format!(
            "  {} {} {}{}",
            st["id"].as_str().unwrap_or("?"),
            st["status"].as_str().unwrap_or("?"),
            st["ms"]
                .as_f64()
                .map(|ms| format!("{} ms", ms.round()))
                .unwrap_or_default(),
            st["summary"]
                .as_str()
                .filter(|x| !x.is_empty())
                .map(|x| format!(", {x}"))
                .unwrap_or_default()
        ));
    }
    let names = output_names(
        status["files"]
            .as_array()
            .map(|a| a.iter().map(|f| f["name"].as_str().unwrap_or("")).collect())
            .unwrap_or_default(),
    );
    let prov = provenance(args, job, &status, &build, &started);
    let mut written = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let size = status["files"][i]["size"].as_u64().unwrap_or(0);
        let left = args.timeout.saturating_sub(t0.elapsed());
        match save(&mut s.b, &page, i, size, &job.out.join(name), left) {
            Ok(()) => {}
            Err(e) => {
                log.line(&format!("could not write {name}: {e}"));
                return if t0.elapsed() >= args.timeout { 5 } else { 1 };
            }
        }
        let p = job.out.join(format!("{name}.gwb-provenance.json"));
        if let Err(e) = std::fs::write(&p, serde_json::to_vec_pretty(&prov).unwrap_or_default()) {
            log.line(&format!("could not write {}: {e}", p.display()));
            return 1;
        }
        log.line(&format!("wrote {name} ({size} bytes)"));
        written.push(json!({ "name": name, "size": size }));
    }
    let mut record = status.clone();
    record["files"] = json!(written);
    record["started"] = json!(started);
    record["finished"] = json!(crate::util::now_rfc3339());
    let _ = std::fs::write(
        job.out.join("gwb-run.json"),
        serde_json::to_vec_pretty(&record).unwrap_or_default(),
    );
    let ok = status["state"] == "done" && status["ok"] == true;
    log.line(&format!(
        "{} in {:.1} s",
        if ok {
            "done".to_string()
        } else {
            format!(
                "{}{}",
                status["state"].as_str().unwrap_or("failed"),
                status["error"]
                    .as_str()
                    .map(|e| format!(": {e}"))
                    .unwrap_or_default()
            )
        },
        t0.elapsed().as_secs_f64()
    ));
    if ok {
        0
    } else {
        1
    }
}

/// Put the input files on a hidden file input in the page, the way a person picking them would.
fn give_inputs(s: &mut Session, inputs: &[(String, PathBuf)]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let page = s.page.clone();
    let el = s.b.call(
        "Runtime.evaluate",
        json!({ "expression": "(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'gwb-run-inputs'; i.hidden = true; document.body.appendChild(i); return i; })()" }),
        Some(&page),
        Duration::from_secs(30),
    )?;
    let object = el["result"]["objectId"]
        .as_str()
        .ok_or("the page gave no file input")?
        .to_string();
    let files: Vec<String> = inputs
        .iter()
        .map(|(_, p)| p.display().to_string())
        .collect();
    s.b.call(
        "DOM.setFileInputFiles",
        json!({ "files": files, "objectId": object }),
        Some(&page),
        Duration::from_secs(60),
    )?;
    Ok(())
}

/// Read output `i` from the page in chunks and write it to `path` (through a `.part` file, so a
/// failed run never leaves a short file under the real name).
fn save(
    b: &mut Browser,
    page: &str,
    i: usize,
    size: u64,
    path: &Path,
    left: Duration,
) -> Result<(), String> {
    let end = Instant::now() + left;
    let part = path.with_file_name(format!(
        "{}.part",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let mut f = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut off = 0;
    while off < size {
        let n = CHUNK.min(size - off);
        let wait = end.saturating_duration_since(Instant::now());
        let b64 = b.eval(
            page,
            &format!("window.__gwbRun.chunk({i}, {off}, {n})"),
            wait,
        )?;
        let bytes = base64_decode(b64.as_str().ok_or("the page sent no bytes")?)?;
        if bytes.len() as u64 != n {
            return Err(format!("the page sent {} bytes, not {n}", bytes.len()));
        }
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        off += n;
    }
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&part, path).map_err(|e| e.to_string())
}

/// Safe file names for the run's outputs: the last path part, with characters a file system can't
/// take replaced, and a number added when two are the same (case-insensitively, as on Windows).
fn output_names(raw: Vec<&str>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    raw.into_iter()
        .map(|r| {
            let last = r.rsplit(['/', '\\']).next().unwrap_or("");
            let clean: String = last
                .chars()
                .map(|c| {
                    if c.is_control() || "<>:\"|?*\u{202e}\u{feff}".contains(c) {
                        '_'
                    } else {
                        c
                    }
                })
                .collect();
            let clean = clean.trim_matches([' ', '.']).to_string();
            // A Windows device name (nul.json, con.tif) would write to the device, not a file.
            let base = if clean.is_empty()
                || crate::paths::is_reserved(&clean)
                || clean.eq_ignore_ascii_case("gwb-run.log")
                || clean.eq_ignore_ascii_case("gwb-run.json")
            {
                format!("output-{clean}")
            } else {
                clean
            };
            let mut name = base.clone();
            let mut k = 2;
            while !seen.insert(name.to_lowercase()) {
                let (stem, ext) = match base.rsplit_once('.') {
                    Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
                    _ => (base.clone(), String::new()),
                };
                name = format!("{stem} ({k}){ext}");
                k += 1;
            }
            name
        })
        .collect()
}

/// The provenance written beside each output, in the sidecar's format: the runner, the recipe, the
/// options, the inputs, and each step with its operation, the app build, its id, status and summary.
fn provenance(args: &Args, job: &Job, status: &Value, build: &str, started: &str) -> Provenance {
    let mut options = BTreeMap::new();
    options.insert("gates".to_string(), json!(args.gates));
    if job.params.as_object().is_some_and(|o| !o.is_empty()) {
        options.insert("params".to_string(), job.params.clone());
    }
    options.insert("app".to_string(), json!(build));
    let recipe = status["recipe"]
        .as_str()
        .map(str::to_string)
        .or_else(|| job.id.clone())
        .unwrap_or_default();
    Provenance {
        sidecar: format!("gwb-run {}", env!("CARGO_PKG_VERSION")),
        profile: format!("recipe {recipe}"),
        options,
        inputs: job
            .inputs
            .iter()
            .map(|(n, p)| {
                let f = p
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                if n.is_empty() {
                    f
                } else {
                    format!("{n}={f}")
                }
            })
            .collect(),
        steps: status["steps"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|st| {
                let o = st.as_object().cloned().unwrap_or_else(Map::new);
                let text = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                StepRecord {
                    tool: text("op"),
                    version: build.to_string(),
                    args: [text("id"), text("status"), text("summary")]
                        .into_iter()
                        .filter(|x| !x.is_empty())
                        .collect(),
                    exit_code: None,
                    ms: o.get("ms").and_then(Value::as_f64).unwrap_or(0.0).max(0.0) as u64,
                }
            })
            .collect(),
        started: started.to_string(),
        finished: crate::util::now_rfc3339(),
    }
}

/// Standard base64 (with padding), as FileReader.readAsDataURL writes it.
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let s = s.as_bytes();
    if s.len() % 4 != 0 {
        return Err("base64 of the wrong length".into());
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    for (k, q) in s.chunks(4).enumerate() {
        let last = k == s.len() / 4 - 1;
        let pad = q.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && !last) {
            return Err("misplaced base64 padding".into());
        }
        let mut n = 0u32;
        for &c in &q[..4 - pad] {
            n = n << 6 | val(c).ok_or("a character that is not base64")?;
        }
        n <<= 6 * pad as u32;
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8][..3 - pad]);
    }
    Ok(out)
}

/// Open the staged app with no first-run dialogs and wait until it says it is ready.
fn open_app(b: &mut Browser, s: &str, file: &Path) -> Result<(), String> {
    b.call(
        "Runtime.enable",
        json!({}),
        Some(s),
        Duration::from_secs(30),
    )?;
    b.call("Page.enable", json!({}), Some(s), Duration::from_secs(30))?;
    let seed = "try { localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify({ welcomeDone: true })); } catch (e) {}";
    b.call(
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": seed }),
        Some(s),
        Duration::from_secs(30),
    )?;
    let url = file_url(file);
    let nav = b.call(
        "Page.navigate",
        json!({ "url": url }),
        Some(s),
        Duration::from_secs(60),
    )?;
    if let Some(e) = nav.get("errorText").and_then(|v| v.as_str()) {
        return Err(format!("the app did not open: {e}"));
    }
    let ready = "new Promise((res, rej) => { const t0 = Date.now(); (function poll() { if (window.gisworkbench && window.gisworkbench._ready) res(true); else if (Date.now() - t0 > 120000) rej(new Error('the app was not ready after 120 s')); else setTimeout(poll, 100); })(); })";
    b.eval(s, ready, Duration::from_secs(130))
        .map(|_| ())
        .map_err(|e| {
            if b.exceptions.is_empty() {
                e
            } else {
                format!("{e}; the page reported: {}", b.exceptions.join("; "))
            }
        })
}

/// A file: URL for an absolute path, percent-encoding what a URL cannot carry.
fn file_url(p: &Path) -> String {
    let s = p.display().to_string().replace('\\', "/");
    let mut out = String::from(if s.starts_with('/') {
        "file://"
    } else {
        "file:///"
    });
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn arguments() {
        assert_eq!(
            parse(&v(&["--check"])).unwrap(),
            Args {
                check: true,
                ..Default::default()
            }
        );
        assert_eq!(
            parse(&v(&["--check", "--browser", "C:\\b.exe"]))
                .unwrap()
                .browser,
            Some(PathBuf::from("C:\\b.exe"))
        );
        let a = parse(&v(&[
            "folder-to-cog",
            "--in",
            "s1=C:\\in\\a=b.tif",
            "--in",
            "C:\\in\\x=1.tif",
            "--in",
            "/data/y.tif",
            "--out",
            "o",
            "--gates",
            "fail",
            "--timeout",
            "60",
        ]))
        .unwrap();
        assert_eq!(a.recipe.as_deref(), Some("folder-to-cog"));
        assert_eq!(
            a.inputs,
            vec![
                ("s1".to_string(), PathBuf::from("C:\\in\\a=b.tif")),
                (String::new(), PathBuf::from("C:\\in\\x=1.tif")),
                (String::new(), PathBuf::from("/data/y.tif")),
            ]
        );
        assert_eq!(
            (a.gates.as_str(), a.timeout),
            ("fail", Duration::from_secs(60))
        );
        assert_eq!(parse(&v(&["r", "--out", "o"])).unwrap().gates, "continue");
        for (bad, why) in [
            (&[][..], "nothing to do"),
            (&["--check", "--browser"][..], "needs a value"),
            (&["--check", "--port", "1"][..], "unknown argument --port"),
            (&["r"][..], "give --out"),
            (&["r", "s", "--out", "o"][..], "one recipe per run"),
            (&["--check", "r"][..], "runs no recipe"),
            (
                &["r", "--out", "o", "--gates", "ask"][..],
                "continue, fail or stop",
            ),
            (
                &["r", "--out", "o", "--timeout", "0"][..],
                "number of seconds",
            ),
        ] {
            assert!(parse(&v(bad)).unwrap_err().contains(why), "{bad:?}");
        }
    }

    #[test]
    fn file_urls() {
        assert_eq!(
            file_url(Path::new("C:\\Users\\a b\\x.html")),
            "file:///C:/Users/a%20b/x.html"
        );
        assert_eq!(
            file_url(Path::new("/tmp/gwb run/x.html")),
            "file:///tmp/gwb%20run/x.html"
        );
    }

    #[test]
    fn base64_round_trips() {
        assert_eq!(base64_decode("").unwrap(), b"");
        assert_eq!(base64_decode("Zg==").unwrap(), b"f");
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo");
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo");
        assert_eq!(base64_decode("AP8+/w==").unwrap(), [0, 255, 62, 255]);
        assert!(base64_decode("Zm9").is_err());
        assert!(base64_decode("Zg==Zm9v").is_err());
        assert!(base64_decode("Zm9-").is_err());
    }

    #[test]
    fn a_file_whose_name_looks_like_step_equals_file_is_taken_whole() {
        // Only "site=2024.tif" exists, as a relative name in the working folder.
        let exists = |p: &Path| p == Path::new("site=2024.tif");
        assert_eq!(
            (
                input_with("site=2024.tif", exists),
                input_with("s1=site=2024.tif", exists),
                input_with("s1=other.tif", exists),
            ),
            (
                (String::new(), PathBuf::from("site=2024.tif")),
                ("s1".to_string(), PathBuf::from("site=2024.tif")),
                ("s1".to_string(), PathBuf::from("other.tif")),
            )
        );
    }

    #[test]
    fn output_names_are_safe_and_distinct() {
        assert_eq!(
            output_names(vec![
                "a.tif",
                "A.tif",
                "../../x/b.geojson",
                "c:\\d\\e.txt",
                "q?.json",
                "gwb-run.log",
                "",
                "..",
                "nul.json",
                "Con.tif",
                "x\u{202e}y.txt",
            ]),
            vec![
                "a.tif",
                "A (2).tif",
                "b.geojson",
                "e.txt",
                "q_.json",
                "output-gwb-run.log",
                "output-",
                "output- (2)",
                "output-nul.json",
                "output-Con.tif",
                "x_y.txt",
            ]
        );
    }

    #[test]
    fn provenance_names_the_recipe_steps_and_inputs() {
        let args = Args::default();
        let job = Job {
            id: Some("folder-to-cog".into()),
            recipe: None,
            params: json!({}),
            inputs: vec![
                (String::new(), PathBuf::from("/d/a.tif")),
                ("s1".into(), PathBuf::from("/d/b.geojson")),
            ],
            out: PathBuf::from("o"),
        };
        let status = json!({ "recipe": "folder-to-cog", "steps": [
            { "id": "s1", "op": "convertFolder", "status": "done", "ms": 812.4, "summary": "2 files" }
        ] });
        let p = provenance(&args, &job, &status, "abc123", "2026-11-10T00:00:00Z");
        assert_eq!(p.profile, "recipe folder-to-cog");
        assert_eq!(p.inputs, vec!["a.tif", "s1=b.geojson"]);
        assert_eq!(p.options["gates"], json!("continue"));
        assert!(!p.options.contains_key("params"));
        assert_eq!(p.steps.len(), 1);
        assert_eq!(p.steps[0].tool, "convertFolder");
        assert_eq!(p.steps[0].version, "abc123");
        assert_eq!(p.steps[0].args, vec!["s1", "done", "2 files"]);
        assert_eq!(p.steps[0].ms, 812);
        assert!(p.sidecar.starts_with("gwb-run "));
    }

    #[test]
    fn inputs_and_recipes_are_checked_before_a_browser_starts() {
        let dir = std::env::temp_dir().join(format!("gwb-run-t-{}", crate::util::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out");
        let mut a = Args {
            recipe: Some("folder-to-cog".into()),
            out: Some(out.clone()),
            ..Default::default()
        };
        a.inputs = vec![(String::new(), dir.join("missing.tif"))];
        assert!(Job::prepare(&a).err().unwrap().contains("no input file"));
        a.inputs.clear();
        a.recipe = Some(dir.join("missing.gwrecipe.json").display().to_string());
        assert!(Job::prepare(&a).err().unwrap().contains("no recipe file"));
        let r = dir.join("r.gwrecipe.json");
        std::fs::write(&r, "{ not json").unwrap();
        a.recipe = Some(r.display().to_string());
        assert!(Job::prepare(&a)
            .err()
            .unwrap()
            .contains("not a JSON recipe"));
        std::fs::write(
            &r,
            r#"{"format":"gw-recipe/1","name":"x","steps":[{"op":"contrast"}]}"#,
        )
        .unwrap();
        let p = dir.join("p.json");
        std::fs::write(&p, "[1]").unwrap();
        a.params = Some(p);
        assert!(Job::prepare(&a)
            .err()
            .unwrap()
            .contains("not a JSON object"));
        a.params = None;
        let j = Job::prepare(&a).unwrap();
        assert!(j.id.is_none() && j.recipe.is_some() && out.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
