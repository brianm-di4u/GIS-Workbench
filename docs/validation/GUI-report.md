# v1.1.0 GUI campaign — validation report

Build: `dist/gis-workbench.html` 5.40 MB (5,665,377 bytes; eager 2.28 MB), build `8051948bbe63136e`;
`gis-workbench-lite.html` 3.94 MB (3,944,757 bytes), without the 3D, LiDAR, video and SAR-analysis
modules. Version 1.1.0 (`package.json`), 452 commands. SHA-256 in `dist/SHA256SUMS`.

Tested on Windows 11 with Chrome and Edge (stable channels) through Playwright 1.64.1 (headless,
software WebGL), and hands-on in a Chromium browser pane over `http://127.0.0.1` with hardware
WebGL. Date 2026-10-27.

## Scope and method

Earlier campaigns (R0–R3, T&E) ran every command through `commands.run()`. This campaign drove the
**GUI itself** on both files: the controls a user clicks, types into and presses keys on.

- **Live pass** (`tests/tools/serve.mjs` + browser pane): pointer, keyboard and screenshots over
  the shell, Ribbon, menus, dialogs, docks, context menus, video transport, whiteboard and its
  review/send pages, stereo, About and What's New, themes and window sizes 800–1500 px.
- **Automated sweep** (`tests/e2e/gui-sweep.spec.js`): enumerates the live DOM and actuates every
  Ribbon control, split caret, combo option, slider and input in every tab — main and contextual —
  in eleven data states; every Workspace and File menu item and submenu item; every QAT and
  Workspace toolbar button; every dock panel (dock left/right/bottom, float, close); the panel
  context menu, mini toolbar, Layer Manager row menu and status-bar menu; every hot key and KeyTip;
  all ten panel layouts, tabbed panels, new/clone/close Multiport and Tile/Tabs. Each action fails
  on a page error, console error, CSP violation, unexpected error toast, a dialog that ignores Esc
  or does not fit the window or scrolls sideways, an empty split-caret menu, or a missing control.
- **Regression tests** (`tests/e2e/gui-fixes.spec.js`): one per fixed finding, titled with its id.

Data states: S0 empty · S1 NITF + RPC (FX-01) · S2 DEM (FX-05) · S3 8-band MSI (FX-08) · S4 SICD
(FX-07) · S5 two-date pair (FX-06) · S6 stereo pair, Stereo Panel open (FX-02) · S7 LAS (FX-09,
Standard only) · S8 MPEG-TS with KLV (FX-10) · S9 GeoJSON (FX-12) · S10 MSI + ML detections.

## Exit criteria

| Criterion | Result |
|---|---|
| Every GUI control actuated in Standard and Lite, Chrome and Edge, with no error | **Met**: 4,396 actions, 0 problems (table below). |
| Every finding fixed with a regression test, or accepted with a reason | **Met**: 27 findings; 24 fixed and verified, 2 not a defect, 1 accepted known limit ([GUI-findings.md](GUI-findings.md)). |
| No regression in the existing suites | **Met**: totals below. |
| Version bumped and the change history published | **Met**: 1.1.0; `CHANGELOG.md`, Help ▸ What's New in the app, `/changelog` on the website. |

## Sweep results (actions / problems)

| Area | Standard · Chrome | Standard · Edge | Lite · Chrome | Lite · Edge |
|---|---|---|---|---|
| Ribbon S0 empty (7 main tabs) | 161 / 0 | 161 / 0 | 161 / 0 | 161 / 0 |
| Ribbon S1 image (main + Image/Spectral Tools) | 215 / 0 | 215 / 0 | 215 / 0 | 215 / 0 |
| Ribbon S2 DEM (Image, Surface) | 54 / 0 | 54 / 0 | 54 / 0 | 54 / 0 |
| Ribbon S3 MSI (Image, Spectral) | 89 / 0 | 89 / 0 | 89 / 0 | 89 / 0 |
| Ribbon S4 SICD (Image, SAR) | 69 / 0 | 69 / 0 | 69 / 0 | 69 / 0 |
| Ribbon S5 pair (Image, Layer) | 69 / 0 | 69 / 0 | 69 / 0 | 69 / 0 |
| Ribbon S6 stereo (Image, Layer, Stereo) | 102 / 0 | 102 / 0 | 102 / 0 | 102 / 0 |
| Ribbon S7 point cloud (3D, Point Cloud) | 42 / 0 | 42 / 0 | n/a (refused by name) | n/a |
| Ribbon S8 video (Video) | 17 / 0 | 17 / 0 | 17 / 0 | 17 / 0 |
| Ribbon S9 vectors (Feature) | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 |
| Ribbon S10 detections (Image, Spectral, Observation) | 89 / 0 | 89 / 0 | 89 / 0 | 89 / 0 |
| Workspace + File menus and submenus | 78 / 0 | 78 / 0 | 78 / 0 | 78 / 0 |
| QAT and Workspace toolbar | 16 / 0 | 16 / 0 | 16 / 0 | 16 / 0 |
| Dock panels (17 × dock L/R/B, float, close) | 17 / 0 | 17 / 0 | 17 / 0 | 17 / 0 |
| Context menus, mini toolbar, layer row, status bar | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 |
| Hot keys and KeyTips | 28 / 0 | 28 / 0 | 28 / 0 | 28 / 0 |
| Layouts and windows | 18 / 0 | 18 / 0 | 18 / 0 | 18 / 0 |

In Lite the 3D, LiDAR and SAR-analysis commands are greyed out with a tooltip naming the Standard
file (GUI-007); the sweep counts them as disabled, as intended.

## Findings

| | Count |
|---|---|
| S2 (a function fails) | 4: GUI-001, 011, 012, 021 |
| S3 (degraded or confusing) | 11: GUI-002, 003, 004, 013, 014, 018, 019, 020, 022, 025, 026 |
| S4 (cosmetic) | 5: GUI-005, 015, 016, 023, 024 |
| Improvements | 4: GUI-007, 008, 010, 017 |
| Not a defect | 2: GUI-006, 009 |
| Accepted known limit | 1: GUI-027 |

Details, root causes and regression tests: [GUI-findings.md](GUI-findings.md).

## Totals

| Check | Result |
|---|---|
| E2E (Playwright), whole suite | 508 pass, 0 fail, 0 flaky, 2 skipped by design: 255 tests in each of Chrome and Edge (21.6 min), the 205 R0–R3 tests per browser included |
| GUI sweep + GUI fix tests | 98 pass, 2 skipped by design (Lite point-cloud state), Chrome and Edge (12.9 min) |
| Unit and golden (Vitest) | 85 pass (13 files) |
| Website | `astro check` 0 errors; `/changelog` built and in the sitemap; checked at 375 px and desktop, light and dark |

## Known limits

- **GUI-027:** on software WebGL (no GPU) a redraw with Sharpness above 0 takes seconds; on
  hardware WebGL about 1 ms.
- Native OS surfaces (file pickers, the print dialog, screen capture) were exercised through their
  fallbacks: the sweep answers pickers with no file, and the browser pane blocks screen capture, so
  whiteboard capture used its rendered-snapshot path.
- External send actions (mail drafts, Gmail, Outlook, online sources, AI providers) were opened but
  not sent.
- Safari was not tested; Firefox remains best effort.
