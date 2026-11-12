# 0017: The command-line runner drives the browser over a pipe

- **Date:** 2026-11-10
- **Class:** design, security
- **Issue:** none; the admin approved it in chat on 2026-11-10 ("I approve both of your recommendations")
- **Status:** accepted

## Context

REG-150 (REQ-GAP-95) runs a recipe from the command line, with no page open, in the user's installed Chrome or Edge. The plan, SDP-2.7 §4.14 in the private Docs repo, said the command line would hold an automation token, and the inputs and outputs would go through the sidecar's file hand-off (REQ-SDC-07). That design needs the sidecar's loopback server running, and a token the page and the command line share.

The browser can also be driven over the DevTools protocol on a pipe (`--remote-debugging-pipe`). Then nothing listens anywhere, and no token exists to leak. That changes how the runner is exposed, so the choice was the admin's.

REG-151 (REQ-GAP-96) adds examples for scheduling a run. Each example needs a test, but a test that registers a Windows task changes the machine it runs on.

## Decision

**The runner (REG-150):**
- It starts the installed Chrome or Edge headless, with a temporary profile, and talks to it over `--remote-debugging-pipe`. No port is opened, and no token is used. If neither browser is installed, it stops with a clear message, exit code 3.
- It writes the sidecar's own copy of the app to a temporary folder, only when the copy matches `app/SHA256SUMS`, and opens it as a `file://` page.
- In the page, it runs `recipes.run` through the automation API. Inputs are set on a hidden file input. Outputs are read back over the pipe and written with a `.gwb-provenance.json` each.
- `gwb-run` is the console program. The SDP's token design is not used.

**The schedule tests (REG-151):**
- The automated tests never register a task. They run each documented command directly, and they check each task definition without registering it. On Windows that is `New-ScheduledTask`; on Linux it is `systemd-analyze verify`, plus a transient `systemd-run --user` timer, which leaves nothing behind.
- `npm run test:schedule-live` is a script run by hand. It registers a uniquely named one-shot task, waits for it, checks the outputs and their provenance, and deletes the task in a `finally` block. The admin runs it before each release, and its report is kept as release evidence.

**Added in building it (an agent's call):**
- `gwb-sidecar run …` takes the same arguments as `gwb-run`, but runs with no window. The Windows example uses it. An ordinary user's scheduled task runs on their desktop, so a console program shows a console window for the whole run. Registering the task to run without a desktop (S4U) needs administrator rights.

## Consequences

- There is no listener and no token. The runner doesn't use the sidecar's server, pairing, or file hand-off at all, so a run works when the sidecar isn't running.
- Anything that can start processes as the user can already drive their browser, so the pipe adds no new way in. The temporary profile holds no sign-ins and is deleted after the run.
- The page is the hash-checked copy, so a changed `app` folder is refused before any browser starts. The runner trusts the browser it finds on PATH (Linux) or in the usual install folders (Windows), or the one given with `--browser`.
- Outputs travel over the pipe as base64, in 4 MB pieces. That is slower than a file hand-off, but it is bounded. A very large output costs time, not memory.
- A recipe that needs a person is refused before it starts, naming the step: a step that opens a dialog (**Run a command**, or **Convert a folder** with no files given), or a review gate when gates are set to `stop`.
- A dialog the page opens anyway (alert, confirm, prompt) is dismissed, and the run's log says so.
- A real scheduled run is checked once per release, by hand. Between releases, the automated tests check the commands and definitions, but not Windows Task Scheduler itself.
- To undo it, delete `gwb-run`, `recipe_run.rs` and its page script, and the `run` branch of gwb-sidecar's `main`. Nothing else depends on them.
