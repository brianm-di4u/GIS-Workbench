# v2.0.1 GUI campaign — validation report

Release 2.0.1, 2026-10-28. The campaign tested the GUI of GIS Workbench 2.0.0 — both layouts (Modern, the 2.0 default, and Classic) in all three files (Standard `gis-workbench.html`, Lite `gis-workbench-lite.html`, Air-gapped `gis-workbench-airgap.html`) — fixed what it found, and released the result as 2.0.1. Findings are in [GUI-findings.md](GUI-findings.md) (GUI-028 to GUI-056); the hands-on checklist is [GUI2-checklist.md](GUI2-checklist.md). The v1.1.0 campaign (GUI-001 to GUI-027, Classic only) is [GUI-report.md](GUI-report.md).

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

29 findings: 5 S2 (a function fails), 9 S3 (degraded or confusing), 10 S4 (cosmetic), 5 improvements. All 29 are fixed and verified by a named regression test. None is open.

| Severity | Findings |
|---|---|
| S2 | GUI-028 Undo of “Open image” broke Report Template and Draft with AI · GUI-033 stereo after Undo failed to draw · GUI-043 3D and point-cloud colour failed on two-band images · GUI-045 ten dock panels missing after New Project / New Window · GUI-052 Allow-List ▸ Save New Copy failed with the list unchanged |
| S3 | GUI-030 radial slices overlapped · GUI-032 Triangulation steps enabled when they could not run · GUI-034 no pill over video, point clouds or vectors · GUI-042 hidden error on New Project · GUI-046 Lite 2D / 3D enabled but failing · GUI-048 greyed-out buttons looked enabled · GUI-049 WCAG contrast failures in the Dark and Material themes · GUI-053 empty addresses shown as errors · GUI-056 Use as Terrain reachable only from a right-click menu |
| S4 | GUI-029, GUI-054 unnamed controls · GUI-031 dark status bar in the light theme · GUI-036 air-gapped file called itself Standard · GUI-039 duplicate rail icon · GUI-040 AI options wrapped · GUI-041 raw JSON in About · GUI-044 Classify precondition as an error · GUI-050 panels wider than their dock · GUI-055 status wrapped |
| Improvement | GUI-035 docked editors widen the dock · GUI-037 unexpected errors reported · GUI-038 hints match the layout · GUI-047 greyed-out commands say what to open · GUI-051 Catalog and Convert feedback |

Two kinds of finding stood out:

- **Hidden for a long time.** GUI-045 (panels missing after New Project) and GUI-056 (Surface Tools unreachable for GeoTIFF DEMs, which also kept the sweeps away from Surface Tools since 1.3.0) were found only because the campaign looked at coverage and at flows after the first one. The global error report added for GUI-037 found GUI-042 the first time it ran.
- **Undo leaves runtimes behind.** GUI-028 and GUI-033 have one cause: Undo and Remove take a layer's record out of the store but keep its runtime for redo. `app.layers` now lists only layers with a record, which closes the whole class rather than the two places the sweep reached.

Not defects (harness): a selector that matched a whole dialog instead of its buttons, toggles (CLAHE, Contours) that switch off instead of reopening their dialog, a palette query run after earlier commands had changed the active panel, and a panel measured before its dock had re-laid out. Each was fixed in the harness.

## Coverage

FINAL_COVERAGE

## Results

FINAL_RESULTS

## Exit criteria

| Criterion | Result |
|---|---|
| Every GUI control of both layouts actuated in Standard, Lite and Air-gapped, Chrome and Edge, with no error | FINAL_EXIT_SWEEP |
| Every finding fixed with a regression test | **Met**: 29 of 29, each test failing on 2.0.0 and passing on 2.0.1. |
| No regression in the existing suites | FINAL_EXIT_REGRESSION |
| Version bumped and the change history published | **Met**: 2.0.1 in `package.json`, About and the `generator` meta of all three files; `CHANGELOG.md`, Help ▸ What's New in the app, `/changelog` and the Recent changes strip on the website. |

## Known limits

- Native file pickers, the print dialog and downloads are stubbed or captured in the sweeps; nothing is sent to a network service. Send to Google Sheet, TAK and remote AI were driven to their dialogs and refusals, not to a live endpoint.
- Safari was not tested; Firefox remains best effort.
- In the live pass the Standard file was checked line by line; Lite and Air-gapped were checked live on the items the checklist marks ✓ and otherwise rely on the sweeps.
- Dialogs that need data the eleven states do not provide (for example the GCP report, mosaic seam editing, point-cloud DoD) were opened by their feature tests, not by the sweeps; the coverage table lists them.
