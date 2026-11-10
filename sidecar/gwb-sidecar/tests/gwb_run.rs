//! gwb-run against a real installed browser (REG-150), with a stand-in page in place of the app: the
//! page answers the automation API the way the app does, so this checks the runner's own half (the
//! hash check, the pipe, the inputs, outputs larger than one chunk, a page dialog nobody answers,
//! the provenance, the log and the exit codes) without a build of the app. SCN-80, the same run in
//! the real app and in the page, is tests/e2e/sidecar/27-gwb-run.spec.js.
//!
//! The scheduling examples of docs/runner.md (REG-151, SCN-81) are checked here too: each command
//! is run as written (with the paths changed), and each task definition is built without being
//! registered. No test here registers a task; `npm run test:schedule-live` does, by hand.
//!
//! Skips, saying so, when neither Chrome nor Edge is installed.

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const RUN: &str = env!("CARGO_BIN_EXE_gwb-run");

/// The stand-in app. Its one recipe, "echo", returns a file of 9 MB plus the first input's size
/// (more than two of the runner's 4 MB chunks) and a text file, after an alert nobody answers.
const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>stand-in</title><script>
const ECHO = { format: 'gw-recipe/1', id: 'echo', name: 'Echo', steps: [{ id: 's1', op: 'echo', title: 'Echo' }, { id: 'g', op: 'gate', title: 'Look' }] };
window.gisworkbench = {
  _ready: true,
  layers: new Map(),
  opened: [],
  prefs: { get: () => [] },
  openFiles: async (fs) => { window.gisworkbench.opened.push(...fs.map((f) => f.name)); },
  openPackFiles: async () => {},
  recipes: {
    builtin: [ECHO, { ...ECHO, id: 'folder-to-cog', steps: [ECHO.steps[0]] }],
    validate: (r) => { if (r.format !== 'gw-recipe/1') throw new Error('not a recipe'); return r; },
    unattended: (r, { gates }) => (gates === 'stop' ? { step: 'g', title: 'Look', reason: 'is a review gate, and gates are set to stop' } : null),
  },
  api: { v2: {
    call: async (m) => ({ api: '3.0.0', build: 'stand-in' }),
    recipes: { run: async ({ params }) => {
      const given = params.s1?.files ?? [];
      const n = 9 * 1024 * 1024 + (given[0]?.size ?? 0);
      const big = new Uint8Array(n);
      for (let i = 0; i < n; i++) big[i] = i % 251;
      alert('nobody is here');
      const text = JSON.stringify({ given: given.map((f) => f.name), opened: window.gisworkbench.opened });
      return { run: 'run-1', recipe: 'echo', state: 'done', ok: true,
        steps: [{ id: 's1', op: 'echo', status: 'done', ms: 12, summary: 'echoed' }, { id: 'g', op: 'gate', status: 'done', ms: 0, summary: '' }],
        files: [{ name: 'big.bin', type: 'application/octet-stream', size: n, blob: new Blob([big]) }, { name: 'sub/what.json', type: 'application/json', size: text.length, text }] };
    } },
  } },
};
</script>"#;

fn sha256(b: &[u8]) -> String {
    gwb_sidecar::util::sha256_hex(b)
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "gwb-run-it-{tag}-{}",
        gwb_sidecar::util::random_hex(4)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn app(dir: &Path, html: &str) -> PathBuf {
    let a = dir.join("app");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::write(a.join("gis-workbench.html"), html).unwrap();
    std::fs::write(
        a.join("SHA256SUMS"),
        format!("{}  gis-workbench.html\n", sha256(PAGE.as_bytes())),
    )
    .unwrap();
    a
}

fn run(args: &[&str]) -> (i32, String) {
    let o = Command::new(RUN).args(args).output().unwrap();
    (
        o.status.code().unwrap_or(-1),
        format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        ),
    )
}

fn browser() -> bool {
    match gwb_sidecar::cdp::find_browser(None) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("skipped: {e}");
            false
        }
    }
}

#[test]
fn a_run_writes_its_files_provenance_and_log() {
    if !browser() {
        return;
    }
    let d = scratch("ok");
    let a = app(&d, PAGE);
    let input = d.join("in put.tif");
    std::fs::write(&input, vec![7u8; 1000]).unwrap();
    let other = d.join("other.geojson");
    std::fs::write(&other, "{}").unwrap();
    let out = d.join("out");
    let (code, text) = run(&[
        "echo",
        "--app-dir",
        a.to_str().unwrap(),
        "--out",
        out.to_str().unwrap(),
        "--in",
        &format!("s1={}", input.display()),
        "--in",
        other.to_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{text}");
    let big = std::fs::read(out.join("big.bin")).unwrap();
    assert_eq!(big.len(), 9 * 1024 * 1024 + 1000);
    assert!(
        big.iter().enumerate().all(|(i, &b)| b == (i % 251) as u8),
        "the bytes changed on the way"
    );
    let what: Value =
        serde_json::from_slice(&std::fs::read(out.join("what.json")).unwrap()).unwrap();
    assert_eq!(what["given"], serde_json::json!(["in put.tif"]));
    assert_eq!(what["opened"], serde_json::json!(["other.geojson"]));
    let prov: Value =
        serde_json::from_slice(&std::fs::read(out.join("big.bin.gwb-provenance.json")).unwrap())
            .unwrap();
    assert_eq!(prov["profile"], "recipe echo");
    assert_eq!(
        prov["inputs"],
        serde_json::json!(["s1=in put.tif", "other.geojson"])
    );
    assert_eq!(prov["steps"][0]["tool"], "echo");
    assert_eq!(
        prov["steps"][0]["args"],
        serde_json::json!(["s1", "done", "echoed"])
    );
    assert!(out.join("what.json.gwb-provenance.json").is_file());
    let rec: Value =
        serde_json::from_slice(&std::fs::read(out.join("gwb-run.json")).unwrap()).unwrap();
    assert_eq!(rec["files"].as_array().unwrap().len(), 2);
    let log = std::fs::read_to_string(out.join("gwb-run.log")).unwrap();
    assert!(
        log.contains("wrote big.bin") && log.contains("exit 0"),
        "{log}"
    );
    // No part files, and the work folder went with the browser.
    assert!(std::fs::read_dir(&out)
        .unwrap()
        .flatten()
        .all(|e| !e.file_name().to_string_lossy().ends_with(".part")));
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn refusals_and_a_tampered_app_have_their_own_exit_codes() {
    if !browser() {
        return;
    }
    let d = scratch("no");
    let a = app(&d, PAGE);
    let out = d.join("out");
    let o = out.to_str().unwrap();
    let (code, text) = run(&[
        "echo",
        "--app-dir",
        a.to_str().unwrap(),
        "--out",
        o,
        "--gates",
        "stop",
    ]);
    assert_eq!(code, 4, "{text}");
    assert!(
        text.contains(r#"step "Look" (g) is a review gate"#),
        "{text}"
    );
    let (code, text) = run(&[
        "echo",
        "--app-dir",
        a.to_str().unwrap(),
        "--out",
        o,
        "--in",
        &format!("s7={}", a.join("SHA256SUMS").display()),
    ]);
    assert_eq!(code, 4, "{text}");
    assert!(text.contains(r#"the recipe has no step "s7""#), "{text}");
    let (code, text) = run(&["missing", "--app-dir", a.to_str().unwrap(), "--out", o]);
    assert_eq!(code, 4, "{text}");
    assert!(text.contains(r#"no built-in recipe "missing""#), "{text}");
    let (code, text) = run(&[
        "echo",
        "--app-dir",
        a.to_str().unwrap(),
        "--out",
        o,
        "--in",
        "no-such-file.tif",
    ]);
    assert_eq!(code, 2, "{text}");
    // The page is not the one SHA256SUMS lists: no browser opens it.
    std::fs::write(
        a.join("gis-workbench.html"),
        format!("{PAGE}<!-- changed -->"),
    )
    .unwrap();
    let (code, text) = run(&["echo", "--app-dir", a.to_str().unwrap(), "--out", o]);
    assert_eq!(code, 3, "{text}");
    assert!(text.contains("does not match SHA256SUMS"), "{text}");
    let (code, text) = run(&["--check", "--app-dir", a.to_str().unwrap()]);
    assert_eq!(code, 3, "{text}");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn check_reports_the_browser_and_the_app() {
    if !browser() {
        return;
    }
    let d = scratch("check");
    let a = app(&d, PAGE);
    let (code, text) = run(&["--check", "--app-dir", a.to_str().unwrap()]);
    assert_eq!(code, 0, "{text}");
    assert!(
        text.contains("app build stand-in") && text.contains("automation API 3.0.0"),
        "{text}"
    );
    let _ = std::fs::remove_dir_all(&d);
}

// ---- the scheduling examples of docs/runner.md (REG-151) ----

/// The fenced block after `<!-- example: NAME -->` in docs/runner.md.
fn example(name: &str) -> String {
    let doc =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/runner.md"))
            .unwrap();
    let at = doc
        .find(&format!("<!-- example: {name} -->"))
        .unwrap_or_else(|| panic!("no example {name}"));
    let rest = &doc[at..];
    let body = &rest[rest.find("```").unwrap()..];
    let body = &body[body.find('\n').unwrap() + 1..];
    body[..body.find("```").unwrap()].replace("\r\n", "\n")
}

/// An app folder, a recipe input, and where the run's files go, for running the examples.
#[allow(dead_code)]
fn stage(tag: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let d = scratch(tag);
    let a = app(&d, PAGE);
    let input = d.join("site.tif");
    std::fs::write(&input, vec![1u8; 64]).unwrap();
    let out = d.join("nightly");
    (d, a, input, out)
}

#[allow(dead_code)]
fn check_outputs(out: &Path, text: &str) {
    let text = format!(
        "{text}\n{}",
        std::fs::read_to_string(out.join("gwb-run.log")).unwrap_or_default()
    );
    assert_eq!(
        std::fs::metadata(out.join("big.bin"))
            .map(|m| m.len())
            .unwrap_or(0),
        9 * 1024 * 1024 + 64,
        "{text}"
    );
    assert!(out.join("big.bin.gwb-provenance.json").is_file());
    let log = std::fs::read_to_string(out.join("gwb-run.log")).unwrap();
    assert!(
        log.contains("recipe folder-to-cog") && log.contains("exit 0"),
        "{log}"
    );
}

#[test]
fn the_schtasks_example_is_the_same_task_as_the_powershell_one() {
    let ps = example("windows-task");
    let value = |var: &str| {
        let line = ps
            .lines()
            .find(|l| l.starts_with(&format!("${var} = '")))
            .unwrap();
        line[var.len() + 5..line.len() - 1].to_string()
    };
    let st = example("windows-schtasks");
    let st = st.trim();
    let tr = st[st.find("/TR \"").unwrap() + 5..st.len() - 1].replace("\\\"", "\"");
    assert_eq!(
        tr,
        format!("\"{}\" {}", value("sidecar"), value("arguments"))
    );
    assert!(
        st.contains("/TN \"GIS Workbench nightly\" /SC DAILY /ST 02:00 "),
        "{st}"
    );
    assert!(
        ps.contains("-TaskName 'GIS Workbench nightly'") && ps.contains("-Daily -At 2am"),
        "{ps}"
    );
    // The task runs gwb-sidecar, which opens no window, not the console gwb-run.
    assert!(
        value("sidecar").ends_with("gwb-sidecar.exe") && value("arguments").starts_with("run ")
    );
}

#[cfg(windows)]
#[test]
fn the_windows_task_example_builds_and_its_command_runs() {
    use std::os::windows::process::CommandExt;
    if !browser() {
        return;
    }
    let (d, a, input, out) = stage("win");
    let ps = example("windows-task")
        .replace(
            r"C:\Tools\GIS Workbench Sidecar\gwb-sidecar.exe",
            env!("CARGO_BIN_EXE_gwb-sidecar"),
        )
        .replace(r"C:\GIS\in\site.tif", input.to_str().unwrap())
        .replace(
            r#"--out "C:\GIS\nightly""#,
            &format!(r#"--out "{}" --app-dir "{}""#, out.display(), a.display()),
        );
    assert!(
        ps.contains("Register-ScheduledTask -TaskName 'GIS Workbench nightly' "),
        "{ps}"
    );
    // The dry run: the same definition, built and never registered.
    let dry = ps.replace("Register-ScheduledTask -TaskName 'GIS Workbench nightly' ", "$task = New-ScheduledTask ")
        + "\n[pscustomobject]@{ execute = $task.Actions[0].Execute; arguments = $task.Actions[0].Arguments; trigger = $task.Triggers[0].CimClass.CimClassName; at = ([datetime]$task.Triggers[0].StartBoundary).ToString('HH:mm'); days = $task.Triggers[0].DaysInterval; limit = $task.Settings.ExecutionTimeLimit } | ConvertTo-Json -Compress\n";
    assert!(!dry.contains("Register-ScheduledTask"));
    let o = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &dry])
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr);
    assert!(o.status.success(), "{text}");
    let task: Value = serde_json::from_str(text.trim()).unwrap_or_else(|e| panic!("{e}: {text}"));
    assert_eq!(task["execute"], env!("CARGO_BIN_EXE_gwb-sidecar"));
    assert_eq!(task["trigger"], "MSFT_TaskDailyTrigger");
    assert_eq!(task["at"], "02:00", "{text}"); // local time; StartBoundary is in UTC
    assert_eq!(
        (task["days"].as_u64(), task["limit"].as_str()),
        (Some(1), Some("PT2H"))
    );
    // The command, run as Task Scheduler runs it: the program, and the arguments as one string.
    let o = Command::new(task["execute"].as_str().unwrap())
        .raw_arg(task["arguments"].as_str().unwrap())
        .output()
        .unwrap();
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}",
        std::fs::read_to_string(out.join("gwb-run.log")).unwrap_or_default()
    );
    // The task runs a windowed program (PE subsystem 2), so Windows gives it no console window;
    // gwb-run is the console one (3).
    let subsystem = |exe: &str| {
        let b = std::fs::read(exe).unwrap();
        let pe = u32::from_le_bytes(b[0x3c..0x40].try_into().unwrap()) as usize;
        u16::from_le_bytes(b[pe + 0x5c..pe + 0x5e].try_into().unwrap())
    };
    assert_eq!(subsystem(env!("CARGO_BIN_EXE_gwb-sidecar")), 2);
    assert_eq!(subsystem(RUN), 3);
    check_outputs(&out, "");
    let _ = std::fs::remove_dir_all(&d);
}

#[cfg(target_os = "linux")]
#[test]
fn the_linux_examples_run_and_the_units_check() {
    if !browser() {
        return;
    }
    let (d, a, input, out) = stage("lin");
    let to = format!("{} --app-dir {}", out.display(), a.display());
    let swap = |s: &str| {
        s.replace("/usr/bin/gwb-run", env!("CARGO_BIN_EXE_gwb-run"))
            .replace("/home/me/gis/in/site.tif", input.to_str().unwrap())
            .replace("%h/gis/in/site.tif", input.to_str().unwrap())
            .replace("/home/me/gis/nightly", &to)
            .replace("%h/gis/nightly", &to)
    };
    // cron: five schedule fields, then the command, run here as cron would run it.
    let cron = example("linux-cron");
    let fields: Vec<&str> = cron.split_whitespace().collect();
    assert_eq!(&fields[..5], ["0", "2", "*", "*", "*"]);
    let line = swap(cron.trim());
    let command = line.splitn(6, ' ').nth(5).unwrap();
    let o = Command::new("sh").args(["-c", command]).output().unwrap();
    assert_eq!(o.status.code(), Some(0));
    check_outputs(&out, &String::from_utf8_lossy(&o.stderr));
    std::fs::remove_dir_all(&out).unwrap();
    // systemd: the units, checked as written (with the paths changed); then the service's command
    // on a transient timer, which is gone once it has run.
    let service = swap(&example("linux-service"));
    let timer = example("linux-timer");
    assert!(timer.contains("OnCalendar=*-*-* 02:00:00") && timer.contains("Persistent=true"));
    let user_systemd = Command::new("systemctl")
        .args(["--user", "show-environment"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !user_systemd {
        eprintln!("skipped the systemd half: no user systemd here");
        let _ = std::fs::remove_dir_all(&d);
        return;
    }
    let units = d.join("units");
    std::fs::create_dir_all(&units).unwrap();
    std::fs::write(units.join("gwb-nightly.service"), &service).unwrap();
    std::fs::write(units.join("gwb-nightly.timer"), &timer).unwrap();
    let v = Command::new("systemd-analyze")
        .args(["--user", "verify"])
        .arg(units.join("gwb-nightly.service"))
        .arg(units.join("gwb-nightly.timer"))
        .output()
        .unwrap();
    assert!(v.status.success(), "{}", String::from_utf8_lossy(&v.stderr));
    let exec = service
        .lines()
        .find_map(|l| l.strip_prefix("ExecStart="))
        .unwrap();
    let unit = format!("gwb-run-test-{}", gwb_sidecar::util::random_hex(4));
    // The user manager has its own environment: give the run this one's PATH (and library path),
    // where the test found its browser.
    let pass: Vec<String> = ["PATH", "LD_LIBRARY_PATH"]
        .iter()
        .filter(|k| std::env::var_os(k).is_some())
        .map(|k| format!("--setenv={k}"))
        .collect();
    let started = Command::new("systemd-run")
        .args(&pass)
        .args([
            "--user",
            "--quiet",
            "--collect",
            "--on-active=1",
            &format!("--unit={unit}"),
            "--",
        ])
        .args(exec.split_whitespace())
        .status()
        .unwrap();
    assert!(started.success());
    let wait = |what: &dyn Fn() -> bool, secs: u64| {
        let t0 = std::time::Instant::now();
        while !what() && t0.elapsed() < std::time::Duration::from_secs(secs) {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    };
    wait(
        &|| {
            std::fs::read_to_string(out.join("gwb-run.log"))
                .unwrap_or_default()
                .contains("exit ")
        },
        120,
    );
    let _ = Command::new("systemctl")
        .args([
            "--user",
            "stop",
            &format!("{unit}.timer"),
            &format!("{unit}.service"),
        ])
        .output(); // quiet: a collected unit is already gone
    check_outputs(&out, "the transient timer's run");
    let _ = std::fs::remove_dir_all(&d);
}
