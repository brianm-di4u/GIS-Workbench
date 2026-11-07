# Product requirements

This is the public scope statement. Changing it needs the admin's approval, because it sets scope. The full requirements are kept privately, in the companion repo ([0004](decisions/0004-private-docs-repo.md)), and are traced to tests by `build/traceability.mjs`.

## Vision

GIS Workbench is an imagery analysis and photogrammetry tool delivered as one self-contained HTML file. It opens from local disk in a current Chromium browser with no install, no server, and no network. Heavy work runs in Rust compiled to WebAssembly. An optional native sidecar adds more formats and tool chains over loopback.

"Double-click one file and work with real imagery."

## Users

Imagery analysts and GIS practitioners who need a quick, rigorous look at a file on a locked-down or offline machine. New users get a simple layout. Users of desktop imagery tools can switch to a familiar one.

## Goals

- Zero install and zero server for the app. The file keeps working with no sidecar.
- No network request unless the user adds an origin. The air-gapped variant makes none.
- Every measurement carries a stated error, or says that none is available.
- Real formats: each sample file opens or is refused cleanly.
- Safe with hostile files: memory-safe parsers, fuzzed, run in workers.
- No frozen screen: long jobs show progress.
- Usable in the user's own language, offline.

## Non-goals

- Civilian use only. Military-leaning functions were removed in 2.6.0. See [0001](decisions/0001-civilian-use.md).
- No hosted or installed features. New work goes only in the HTML file or the optional sidecar. See [0002](decisions/0002-no-hosted-or-installed.md).
- No claim of conformance to any standard. The product may say "designed to follow".
- No telemetry.
- No server-side processing.

## Requirements

The full requirements are private. Each is numbered and traced to a test by `build/traceability.mjs`. They are not listed here.

## Budgets

| Part | Limit |
|---|---|
| Full build | 18 MB |
| Lite build | 5.5 MB |
| Eager part | 6 MiB |
| All WASM | 4 MiB gzip, total |

The build fails when a limit is passed.

## Out of scope for now

- The AI wave, planned after 2.7.0.
- Anything that needs a hosted service or an installer.
