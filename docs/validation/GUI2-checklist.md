# v2.0.1 GUI campaign — live pass checklist

The hands-on part of the 2.0.1 GUI campaign ([GUI2-report.md](GUI2-report.md)). Each ✓ was checked in the browser pane of the Claude desktop app (Chromium with hardware WebGL, Intel Arc), over `tests/tools/serve.mjs`, with fixtures sent by its `/__loader` page, by pointer and keyboard with screenshots, and by short in-page scripts that measure what the eye judges (overlaps, overflow, colours, contrast). It covers what the automated sweeps can only smoke-test: how things look and feel. Findings are in [GUI-findings.md](GUI-findings.md).

Files: `gis-workbench.html` (Standard), `gis-workbench-lite.html` (Lite), `gis-workbench-airgap.html` (Air-gapped), each built from the campaign branch into `dist-live/` after every fix.

Legend: **✓** checked live in the browser pane; **S** covered by the automated sweeps and regression tests only (`gui-modern`, `gui-sweep`, `gui2-fixes`), not repeated by hand in that file; **—** not applicable.

## Modern layout

| Check | Standard | Lite | Air-gapped | Finding |
|---|---|---|---|---|
| First-run card: three workspaces, Work online, Classic layout, Skip | ✓ | S | S (no Work online) | — |
| App bar at 1440 and 1024 px: Open, URL, undo/redo, save, workspace chip, theme, whiteboard, settings, help; title hides when narrow | ✓ | S | S | — |
| Navigation rail: every item opens and closes its panel, active state shown | ✓ | ✓ | ✓ (after New Project) | GUI-039 (Recipes icon) |
| Radial menu (Space): eight slices, no overlap, Esc closes | ✓ | ✓ | ✓ | GUI-030 |
| Contextual pill over an image, a video and a vector layer; collapses to icons when narrow | ✓ | ✓ (image) | S | GUI-034 |
| Command palette: commands, layers, coordinates, URLs; greyed-out entries say why | ✓ | S | S | GUI-047 |
| Docks: every panel fits 255 px, opens at top-left, tiles beside the imagery | ✓ | ✓ | ✓ | GUI-050 |
| Wide docked editor (KLV table) widens the dock | ✓ | — (no video) | S | GUI-035 |
| AI Assistant: hint, Add a connection…, attach options | ✓ | S | ✓ (no remote AI) | GUI-038, GUI-040 |
| Recipes, Convert and Catalog panels: controls, empty-box feedback, labels | ✓ | S | ✓ (local folders only) | GUI-048, GUI-051 |
| Video: transport, pill tools, KLV panel | ✓ | S (metadata only) | S | — |
| Stereo pair: open, Undo of one image | ✓ | ✓ | ✓ | GUI-033 |
| 2D / 3D view from an image and from a stereo pair | ✓ | ✓ greyed out, no 3D button | S | GUI-043, GUI-046 |
| Undo of “Open image”, then Report Template | ✓ | S | S | GUI-028 |
| New Project, then every rail item | ✓ | S | ✓ | GUI-042, GUI-045 |
| Light and dark Material themes: chrome, status bar, docks, dialogs | ✓ | ✓ (status bar) | S | GUI-031, GUI-049 |
| About & Diagnostics: version, edition, worker pool | ✓ | ✓ | ✓ | GUI-036, GUI-041 |
| Status bar Online/Offline switch | ✓ | S | ✓ (“Air-gapped”, disabled) | GUI-055 |
| Unexpected errors surface once with a pointer to Copy Diagnostics | ✓ | ✓ (found GUI-042) | S | GUI-037 |

## Classic layout

| Check | Standard | Lite | Air-gapped | Finding |
|---|---|---|---|---|
| Ribbon, contextual tabs, QAT, Workspace window and Map View after switching from Modern | ✓ | S | S | — |
| Grey, Dark and Material themes: buttons, tabs, Workspace rail, status cells, Preferences | ✓ | S | S | GUI-048, GUI-049 |
| Status bar cells (Terrain, Math Model, CE/LE) | ✓ | S | S | GUI-049 |

## Accessibility helpers

`tests/tools/contrast.mjs` (axe-core colour contrast and naming over the chrome, fourteen dock panels and six dialogs in six theme and layout combinations) reports no violation on the 2.0.1 build. The sweeps also fail any dialog with an unnamed control (GUI-029, GUI-054).
