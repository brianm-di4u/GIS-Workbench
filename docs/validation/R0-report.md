# R0 Platform & look — validation report

Build: `dist/gis-workbench.html` 2.28 MB (eager 0.91 MB), Lite 1.81 MB. Rust WASM 280 KB gzip
in total (core 101 KB, parse 97 KB, j2k 83 KB). Tested on Windows 11, Chrome and Edge (stable
channels), Intel Arc integrated GPU. Date 2026-10-26.

## Exit criteria (SDP §5, R0)

| Criterion | Result |
|---|---|
| PT-01..PT-12 pass | **Pass** in Chrome and Edge (table below) |
| SCN-19 passes | **Pass** in Chrome and Edge (`tests/e2e/scn19.spec.js`) |
| GC review done, corrections in tokens | **Partly.** Automated token check (PT-09) and the accessibility review are done and the corrections are in `ui-tokens.json` (DN-07). GC-01..GC-12 need a live reference installation or new footage; none was available. |
| Spikes reported | See "Spikes" below; S-07 and part of S-23/S-24 need people or real hosts |
| O-21, O-22, O-23 answered | **Defaults in use**, recorded in `docs/design/decisions.md`; the owner still has to confirm them |

## Platform tests

| Test | Spec | Chrome | Edge |
|---|---|---|---|
| PT-01 boot over file, http, cross-origin iframe, srcdoc: no console errors, no CSP violations | `e2e/platform.spec.js` | pass ×4 | pass ×4 |
| PT-02 no request leaves without an added origin; requests logged | `e2e/platform.spec.js` | pass | pass |
| PT-03 tampered block refused (SHA-256) | `e2e/platform.spec.js` | pass | pass |
| PT-04 build gates fail on size, dynamic code, licences, unlisted blocks, WASM imports and budgets | `unit/gates.test.js` (14 cases) + every build | pass | — |
| PT-05 worker pool: run, cancel, timeout, trap recovery | `e2e/platform.spec.js` | pass | pass |
| PT-06 store ops invertible (property test) | `unit/store.test.js` | pass | — |
| PT-07 project save, reload, relink by fingerprint | `e2e/platform.spec.js` | pass | pass |
| PT-08 WebGL context loss restores every pane | `e2e/platform.spec.js` | pass | pass |
| PT-09 shell colours (ΔE ≤ 2) and sizes (±1 px) match the tokens | `e2e/look.spec.js` | pass | pass |
| PT-10 axe-core WCAG 2.2 AA, grey/dark/print | `e2e/look.spec.js` | pass ×3 | pass ×3 |
| PT-11 whiteboard draw, pin, capture (WebGL + banners), review, export, re-import | `e2e/feedback-ai.spec.js` | pass | pass |
| PT-12 mock AI: consent, tool loop, accept/reject/stale, key never persisted | `e2e/feedback-ai.spec.js` | pass | pass |

Other suites in the same run: samples regression 41 files × 2 browsers (`e2e/samples.spec.js`),
embed kit and Lite (`e2e/embed.spec.js`), differential tests against JavaScript oracles
(`golden/rpc.test.js`, `golden/geodesy.test.js`), ABI and memory caps (`golden/abi.test.js`),
feedback/AI unit tests, 83 Rust tests and the mutation fuzzer (36 000 inputs, 0 crashes).
Totals: E2E 122/122, unit + golden 47/47, Rust all pass.

## What the tests found and fixed
- Contextual Ribbon tab colours never rendered (`--ctx` dropped by `Object.assign`) — DN-08.
- WCAG failures in measured GXP colours and sizes — DN-07.
- An opaque-origin `srcdoc` sandbox was not recognised, so saves tried a blocked download — DN-09.
- MGRS threw for latitudes a hair below the equator — DN-10.
- A hostile JPEG 2000 header kept the decoder busy for 140 s; a JPEG with a restart interval and
  no data took 4.6 s — both bounded now (DN-02, DN-03).

## Spikes

| Spike | Status | Result |
|---|---|---|
| S-01 performance on the reference laptop | Partly | This machine (Intel Arc iGPU): interactive shell 0.15 s warm, 0.54 s cold (budget 1.5 s); first tile of the WV3 chip < 0.1 s; cursor read-out with RPC, MGRS, EGM96 and CE90 2.4 ms. The managed reference laptop and SwiftShader runs are still to do. |
| S-06 inlined decoders under the CSP | Done, changed | JPEG 2000 via `hayro-jpeg2000` (pure Rust) instead of OpenJPEG: works from inlined bytes in Blob workers in Chrome and Edge; 1536² 11-bit chip in ≈ 0.3 s whole-image. rtree-sql.js and OpenJPH not tried (R1 vectors, HTJ2K). Safari not available here. |
| S-07 keyboard reach of GXP shortcuts | Not run | Needs a person at a keyboard (real key presses with and without Keyboard Lock). |
| S-22 Rust glue under the CSP | Done | Hand-written ABI works on the main thread and in Blob workers (Chrome, Edge). wasm-bindgen not needed (DN-01). |
| S-23 embed matrix | Partly | Local `srcdoc`, cross-origin iframe and scripts-only sandbox pass. Snippet 2.41 MB, Lite snippet 1.81 MB. The O-22 hosts and their size limits are not tested. |
| S-24 AI from `file://` and embeds | Partly | Network allow-list, add-origin-and-reload, error messages and the mock loop are tested. A real provider call needs an API key and network access approved by the owner (O-21). |
| S-25 whiteboard capture of WebGL | Done | The rendered-snapshot path captures WebGL pixels, DOM chrome, marks and both banners from `file://` (PT-11, SCN-19). Tab capture needs a user gesture and is the default when the browser offers it. |
| S-26 Rust vs JS size and speed | Partly | Sizes per bundle are reported on every build. Speed: RPC ground-to-image and geodesy are in Rust and verified against JS oracles; a timed comparison per function is still to write. |

## Known gaps carried into R1
- T.4 two-dimensional coding (U_1123a segment 2) is refused by name.
- JPEG 2000 decodes the whole image (no region or resolution-level decode yet).
- GeoTIFF RPC tags and NAD27 UTM (`utm.tif`) open without a sensor model; the R1 geodesy work
  adds datum transformations and the RPC tag path.
- Coverage-guided fuzzing (cargo-fuzz, nightly) is not in the CI gate.
