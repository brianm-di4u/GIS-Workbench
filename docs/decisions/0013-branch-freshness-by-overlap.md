# 0013: The gate enforces branch freshness by overlap

- **Date:** 2026-11-10
- **Class:** design
- **Issue:** none; the admin decided in chat on 2026-11-10 ("Gate checks overlap")
- **Status:** accepted

## Context

GitHub's "require branches to be up to date" rule makes landing serial: each merge puts every other open PR behind main, so each needs an update and a new verify before it can merge. Merge queues aren't offered on a personal-account repo. With several workers landing in parallel, the wait is mostly updates that change nothing the PR touches.

## Decision

`pipeline.config.json` sets `"freshness": { "mode": "overlap" }`. A PR that is behind main is held only when main changed, since the PR's merge base:

- a file the PR also changes,
- a file in a group the PR also touches, or
- a path on the floor: the pipeline's built-in floor (the pipeline's own files, `.github/`, and dependency manifests and lockfiles anywhere), plus this repo's additions below.

The gate then fails with its own title, "update the branch", and a marker the worker's wait script and the queue tools read as a job for the worker, not a call for a person. A clean update keeps the change hash (decision 0008 hashes only the PR's own added and removed lines), so an approval and a council verdict survive it, even when main changed the same file. Only a merge that has to change the PR's own lines changes the hash, and then they are needed again. The gate's message for an overlapping update says they are always needed again; that is upstream wording and is cautious, so a worker compares `node .pipeline/gate.mjs classify` before and after the update. Config can add to the floor and never take from it, and a malformed setting fails closed, to "every branch up to date".

**This repo's floor additions.** Wider is safer, because a floor change stales every open PR:
- `build/**`: the build and gate scripts and their data, which decide what verify and the release do for everyone.
- `playwright*.config.js` and `vitest.config.js`: how every test runs.
- `.node-version`, `crates/rust-toolchain.toml`, `sidecar/rust-toolchain.toml`, `crates/deny.toml` and `sidecar/deny.toml`: the toolchains and the licence and advisory gates CI uses.
- `.cargo/**`, `crates/.cargo/**`, `**/build.rs` and `crates/vendor/**`: build-time code and settings that run on every crate build.
- `REVIEW.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/agents/**`, `.claude/workflows/**` and `.claude/skills/**`: what steers agents and the council.

**Groups,** each one unit, so two PRs in the same group meet even when they edit different files:
- `i18n-and-commands`: `app/src/i18n/**` and the shell's `command-meta.js`, `ribbon-data.js` and `commands.js`, which nearly every feature edits.
- One group per crate, `crate-gw-<name>` for `crates/gw-<name>/**`, since a change to a function in one file can break another in the same crate.
- `crate-bundles` (`crates/bundles/**`), `sidecar` (`sidecar/**`), and `sidecar-client` (`app/src/sidecar/**` with `sidecar/gwb-sidecar-api/**`), where the browser's client and the sidecar's API move together.
- `test-support`: `tests/quarantine.json` and `tests/e2e/helpers.js`, the shared test registry and helpers.

## What this does not do

GitHub's "require branches to be up to date" rule is not turned off by this change. The admin turns it off by hand after the merge, and until then merging stays serial.

## Consequences

- Most PRs land without an update, in parallel.
- A PR can merge onto a main it was never tested with. Its CI ran on an older main, and the gate checks which paths overlap, not what the code depends on. A change to a function in one file can break a caller in another. The groups narrow this for code that moves together, and the floor covers the gate, CI and dependencies. A cross-group break is caught by main's post-merge run and the red-main rule.
- There is a short gap after each merge: until the gate re-evaluates open PRs for that push, a PR the merge made stale still shows its earlier pass, and auto-merge can take it. Agents run `gate.mjs fresh` before arming auto-merge, which narrows the gap and does not close it. An hourly run re-evaluates open PRs if a push's run fails.
- The groups are a judgement. A new area that several PRs share should get a group; a group that holds PRs up too often should be narrowed. The digest counts merges made while behind, and the reverts and red mains after them.
- To turn it off, remove the `freshness` key and keep GitHub's rule on.
