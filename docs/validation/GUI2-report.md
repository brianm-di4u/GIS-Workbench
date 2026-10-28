# v2.0.1 GUI campaign — validation report

Release 2.0.1, 2026-10-28. The campaign tested the GUI of GIS Workbench 2.0.0 — both layouts (Modern, the 2.0 default, and Classic) in all three files (Standard `gis-workbench.html`, Lite `gis-workbench-lite.html`, Air-gapped `gis-workbench-airgap.html`) — fixed what it found, and released the result as 2.0.1. Findings are in [GUI-findings.md](GUI-findings.md) (GUI-028 to GUI-058); the hands-on checklist is [GUI2-checklist.md](GUI2-checklist.md). The v1.1.0 campaign (GUI-001 to GUI-027, Classic only) is [GUI-report.md](GUI-report.md).

## Why

The only exhaustive GUI sweep, `tests/e2e/gui-sweep.spec.js` from v1.1.0, forced the Classic layout and never opened the air-gapped file. The Modern layout that 2.0 made the default — app bar, navigation rail, Ctrl+K palette, contextual pill, radial menu, tiled docks, workspaces — had feature tests but no sweep that pressed everything.

## Method

All runs used the built files, Windows 11, Playwright 1.64.1 with Chrome and Edge (stable channels, software WebGL), plus a live pass with hardware WebGL.

- **Modern sweep** (`tests/e2e/gui-modern.spec.js`, new), per file:
  - every implemented command through **Ctrl+K**, typed by its label, in eleven data states (empty, NITF with RPC, DEM made terrain, 8-band MSI, SICD, two-date pair, stereo pair with the Stereo Panel open, LAS, MPEG-TS with KLV, GeoJSON, MSI with detections). Each state runs the commands it enables; the empty state runs all of them, and greyed-out ones must say why;
  - **every button of every dialog** those commands open, each pressed after reopening the dialog (except buttons that delete data or start long downloads, which have feature tests);
  - the **app bar**, the main (☰), Help and workspace menus with every submenu item, the **navigation rail** (each item open and closed, with its pressed state) and its Products menu, the **status bar** switches;
  - the **contextual pill** and the **radial menu** in every state, and the radial tools of each of the three workspaces;
  - **every dock panel**: shown beside the imagery (never over it), every button, list, check box and radio in it, closed from its title bar;
  - the **cursor shortcuts** (hold F, S + drag, C + drag, Alt + wheel, J/K, paste-to-pan), the **window commands** (new, clone, separate, close window, full screen, print, recordings, XR), the **first-run card** (each choice, in a fresh profile) and the chrome at **1920, 1440, 1280 and 1024 px**.
- **Classic sweep** (`tests/e2e/gui-sweep.spec.js`), now on all three files and sharing its harness (`tests/e2e/gui-lib.js`) with the Modern sweep: every Ribbon control in every main and contextual tab per state, every File and Workspace menu item, QAT, docks, context menus, hot keys and KeyTips, window layouts.
- **Fail criteria**, for every action: a page error, console error or CSP violation; an unexpected error message (refusals that are the file working as designed — Lite's missing modules, the air-gapped file's network — are allowed); a dialog that ignores Esc, does not fit the window, scrolls sideways or has a control without an accessible name; an empty menu or a missing control.
- **Live pass** in the browser pane of the Claude desktop app (Chromium, Intel Arc GPU) over `tests/tools/serve.mjs`: pointer and keyboard with screenshots, plus short in-page measurements of what the eye judges (overlaps, overflow, colours). See the checklist.
- **Accessibility helper** `tests/tools/contrast.mjs`: axe-core colour contrast and naming over the chrome, fourteen dock panels and six dialogs in six theme and layout combinations.
- **Coverage** `tests/tools/gui-coverage.mjs`: the running app's inventory (commands, panels, rail, app bar, radial tools), the Ribbon and menu data and every dialog id in the source, against the sweep reports.
- **Regression tests**: one per finding in `tests/e2e/gui2-fixes.spec.js`, titled with its id. Each was run against the 2.0.0 files to confirm it fails there.

## Findings

31 findings: 5 S2 (a function fails), 10 S3 (degraded or confusing), 11 S4 (cosmetic), 5 improvements. All 31 are fixed and verified by a named regression test. None is open.

| Severity | Findings |
|---|---|
| S2 | GUI-028 Undo of “Open image” broke Report Template and Draft with AI · GUI-033 stereo after Undo failed to draw · GUI-043 3D and point-cloud colour failed on two-band images · GUI-045 ten dock panels missing after New Project / New Window · GUI-052 Allow-List ▸ Save New Copy failed with the list unchanged |
| S3 | GUI-030 radial slices overlapped · GUI-032 Triangulation steps enabled when they could not run · GUI-034 no pill over video, point clouds or vectors · GUI-042 hidden error on New Project · GUI-046 Lite 2D / 3D enabled but failing · GUI-048 greyed-out buttons looked enabled · GUI-049 WCAG contrast failures in the Dark and Material themes · GUI-053 empty addresses shown as errors · GUI-056 Use as Terrain reachable only from a right-click menu · GUI-058 detections CSV read as a map layer |
| S4 | GUI-029, GUI-054 unnamed controls · GUI-031 dark status bar in the light theme · GUI-036 air-gapped file called itself Standard · GUI-039 duplicate rail icon · GUI-040 AI options wrapped · GUI-041 raw JSON in About · GUI-044 Classify precondition as an error · GUI-050 panels wider than their dock · GUI-055 status wrapped · GUI-057 Auto Contrast gamma shown on the slider scale |
| Improvement | GUI-035 docked editors widen the dock · GUI-037 unexpected errors reported · GUI-038 hints match the layout · GUI-047 greyed-out commands say what to open · GUI-051 Catalog and Convert feedback |

Two kinds of finding stood out:

- **Hidden for a long time.** GUI-045 (panels missing after New Project), GUI-056 (Surface Tools unreachable for GeoTIFF DEMs) and GUI-058 (a detections CSV read as a map layer) were found only because the campaign measured coverage and followed flows past the first one. GUI-056 and GUI-058 had also kept the sweeps away from the Surface, Auto Detections and Observation tabs since 1.3.0. The global error report added for GUI-037 found GUI-042 the first time it ran.
- **Undo leaves runtimes behind.** GUI-028 and GUI-033 have one cause: Undo and Remove take a layer's record out of the store but keep its runtime for redo. `app.layers` now lists only layers with a record, which closes the whole class rather than the two places the sweep reached.

Not defects (harness): a selector that matched a whole dialog instead of its buttons, toggles (CLAHE, Contours) that switch off instead of reopening their dialog, a palette query run after earlier commands had changed the active panel, and a panel measured before its dock had re-laid out. Each was fixed in the harness.

## Coverage

From `tests/tools/gui-coverage.mjs` on the 2.0.1 Standard file and the final sweep reports (`reports/gui`, `reports/gui2`, `reports/gui2/coverage.json`):

| Inventory | Actuated |
|---|---|
| Commands (every implemented command, through Ctrl+K or its window-command test) | 501 / 501 (100 %), in all three files |
| Ribbon controls, main and contextual tabs (Classic) | 419 / 424 (99 %); the other five are window-level commands run through the palette |
| Dialogs, by id | 111 / 148 (75 %) opened by the sweeps, 3,883 dialog buttons pressed |
| Dock panels | 20 / 20 |
| Navigation rail items, app bar controls | 9 / 9, 12 / 12 |
| Radial tools of the three workspaces | 20 / 20 |
| QAT buttons | 8 / 8 |
| File and Workspace menu commands | 66 in the data, every item and submenu item swept by label |

The 37 dialogs the sweeps did not open need data the eleven states do not have (an edited attribute form, GCPs, a mosaic, a DSM pair, a selected detection, a point-cloud DoD, an MCP client…); their feature specs open them.

## Results

Sweep actions / problem actions, final 2.0.1 files (the Modern palette sweep of the image, MSI and detections states and the detections-state Ribbon were re-run on the final build after GUI-057 and GUI-058):

| Area | Standard · Chrome | Standard · Edge | Lite · Chrome | Lite · Edge | Air-gapped · Chrome | Air-gapped · Edge |
|---|---|---|---|---|---|---|
| Modern: every command via Ctrl+K + dialog buttons (11 states) | 2255 / 0 | 2254 / 0 | 2173 / 0 | 2173 / 0 | 2255 / 0 | 2255 / 0 |
| Modern: contextual pill and radial menu (11 states) | 136 / 0 | 136 / 0 | 123 / 0 | 123 / 0 | 136 / 0 | 136 / 0 |
| Modern: radial tools of each workspace | 24 / 0 | 24 / 0 | 24 / 0 | 24 / 0 | 24 / 0 | 24 / 0 |
| Modern: app bar, menus, workspace chip, rail, Products, status bar | 104 / 0 | 104 / 0 | 104 / 0 | 104 / 0 | 104 / 0 | 104 / 0 |
| Modern: dock panels and every control in them | 115 / 0 | 115 / 0 | 115 / 0 | 115 / 0 | 115 / 0 | 115 / 0 |
| Modern: cursor shortcuts | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 |
| Modern: window commands | 11 / 0 | 11 / 0 | 11 / 0 | 11 / 0 | 11 / 0 | 11 / 0 |
| Modern: first-run card | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 | 6 / 0 |
| Modern: chrome at four window sizes | 4 / 0 | 4 / 0 | 4 / 0 | 4 / 0 | 4 / 0 | 4 / 0 |
| Classic: Ribbon, every tab and control (11 states) | 1033 / 0 | 1033 / 0 | 991 / 0 | 991 / 0 | 1033 / 0 | 1033 / 0 |
| Classic: File and Workspace menus | 81 / 0 | 81 / 0 | 81 / 0 | 81 / 0 | 81 / 0 | 81 / 0 |
| Classic: QAT and Workspace toolbar | 16 / 0 | 16 / 0 | 16 / 0 | 16 / 0 | 16 / 0 | 16 / 0 |
| Classic: dock panels (dock, float, close) | 20 / 0 | 20 / 0 | 20 / 0 | 20 / 0 | 20 / 0 | 20 / 0 |
| Classic: context menus | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 |
| Classic: hot keys and KeyTips | 29 / 0 | 29 / 0 | 29 / 0 | 29 / 0 | 29 / 0 | 29 / 0 |
| Classic: split layouts, tabs, Multiports | 18 / 0 | 18 / 0 | 18 / 0 | 18 / 0 | 18 / 0 | 18 / 0 |

**23,041 actions, 0 problems.**

Full regression on the 2.0.1 files:

| Suite | Result |
|---|---|
| Rust (`cargo test`, whole workspace) | 171 passed, 0 failed |
| Unit (`vitest`) | 131 passed, 0 failed |
| E2E, Chrome and Edge (all 67 specs, including the three GUI suites) | First full run: 865 passed, 6 skipped, 5 failed (the WebGPU DSM budget under parallel load, and the Auto Contrast software-WebGL redraw, fixed in the harness; GUI-057 note); all five plus the 31 regression tests re-run: 208 passed. Clean full run on the final build (6 workers, 1.0 h): **873 passed, 6 skipped, 1 failed**: the WebGPU DSM budget again, 10.05 s against 10 s while five other workers ran; run alone it passes in 6.8 s. |
| Traceability (`npm run trace`) | 188 R0+R1 requirements, all tested, none without a citing test. The 4 Musts without a passing result (REQ-FMT-02, -06, -12, -16) are the field-corpus sample files in `c01-ingest.spec.js`, the same 4 as in the 2.0.0 report; not touched by this campaign. |

## Exit criteria

| Criterion | Result |
|---|---|
| Every GUI control of both layouts actuated in Standard, Lite and Air-gapped, Chrome and Edge, with no error | **Met**: 23,041 actions in both layouts, three files, Chrome and Edge; 0 problems. |
| Every finding fixed with a regression test | **Met**: 31 of 31, each test failing on 2.0.0 and passing on 2.0.1. |
| No regression in the existing suites | **Met**: Rust 171, unit 131, E2E 873 passed in the clean run; the one timing failure passes alone (see Results). Traceability unchanged from 2.0.0. |
| Version bumped and the change history published | **Met**: 2.0.1 in `package.json`, About and the `generator` meta of all three files; `CHANGELOG.md`, Help ▸ What's New in the app, `/changelog` and the Recent changes strip on the website. |

## Known limits

- Native file pickers, the print dialog and downloads are stubbed or captured in the sweeps; nothing is sent to a network service. Send to Google Sheet, TAK and remote AI were driven to their dialogs and refusals, not to a live endpoint.
- Safari was not tested; Firefox remains best effort.
- In the live pass the Standard file was checked line by line; Lite and Air-gapped were checked live on the items the checklist marks ✓ and otherwise rely on the sweeps.
- Dialogs that need data the eleven states do not provide (for example the GCP report, mosaic seam editing, point-cloud DoD) were opened by their feature tests, not by the sweeps; the coverage table lists them.
