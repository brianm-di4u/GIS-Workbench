//! Where the folders beside the main checkout are (Research, TE-tools, Docs), from any worktree:
//! git's common dir is <main>/.git, two levels below the folder that holds them. GWB_SAMPLES
//! overrides the samples folder. The tests take this file with `#[path]`, so it is one lookup
//! with no crate of its own; tests/tools/samples.mjs is the JavaScript twin (#296, #299).

use std::path::PathBuf;
use std::process::Command;

/// The folder `name` beside the main checkout.
pub fn sibling(name: &str) -> PathBuf {
    let here = env!("CARGO_MANIFEST_DIR");
    Command::new("git")
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .current_dir(here)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()).join("..").join("..").join(name))
        .unwrap_or_else(|| PathBuf::from(here).join("..").join("..").join("..").join(name))
}

/// The Research samples.
pub fn samples() -> PathBuf {
    std::env::var_os("GWB_SAMPLES").map(PathBuf::from).unwrap_or_else(|| sibling("Research").join("samples"))
}
