//! gwb-run against a real installed browser (REG-150), with a stand-in page in place of the app: the
//! page answers the automation API the way the app does, so this checks the runner's own half (the
//! hash check, the pipe, the inputs, outputs larger than one chunk, a page dialog nobody answers,
//! the provenance, the log and the exit codes) without a build of the app. SCN-80, the same run in
//! the real app and in the page, is tests/e2e/sidecar/27-gwb-run.spec.js.
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
    builtin: [ECHO],
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
