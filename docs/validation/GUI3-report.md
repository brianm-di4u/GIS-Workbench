# GIS Workbench 2.0.2 — visual GUI test and evaluation campaign

**Build under test:** GIS Workbench 2.0.1, the Standard, Lite and air-gapped files (`dist-gui3`), and the 2.0.2 fixes (`dist`).
**Date:** 2026-10-28.
**Findings:** GUI-059 to GUI-082 in [GUI-findings.md](GUI-findings.md); live-pass record in [GUI3-checklist.md](GUI3-checklist.md); design note DN-60 in [decisions.md](../design/decisions.md).

## 1. Why this campaign

The 2.0.1 campaign checked what the GUI *does*: 23 041 actions, every button, menu and dialog, with no problem left. It saved no pictures, though. Its only colour check was axe on a few docks and dialogs, with no menu open and nothing hovered. Users then reported screens that were hard to read, above all in dark mode, where colours sit too close in shade. This campaign targets exactly that: what the GUI *draws*, on every surface, in every theme of both layouts, in the Standard and Lite files.

## 2. Method

| Part | What it does | Where |
|---|---|---|
| Visual audit | Opens every surface a user can see: the app bar, rail, every menu and submenu, every ribbon tab (contextual ones included), the right-click menu, palette, pill, radial menu, tooltip, toasts, welcome card, status bar, whiteboard and video bars, all 20 docks, and the dialogs each of the eleven data states opens. It does this in **10 combinations**: Modern and Classic × Material dark, Material light, Dark, Grey and Print. It saves a screenshot of each surface and measures the computed colours in the DOM: **text** against its effective background (translucency and opacity included; WCAG 1.4.3, 4.5:1), **icons and input outlines** (WCAG 1.4.11, 3:1), **hover** and **focus** (forced through the Chrome DevTools protocol on two controls of every kind per surface), **states** (selected and active against plain), **region tiers** (adjacent surfaces; floating ones against what is under them) and **chart marks**. axe `color-contrast` runs alongside it. | `tests/tools/visual-audit.mjs` |
| Thresholds | Text 4.5:1. Non-text 3:1. A state at least ΔE76 12 from the plain look, and neighbouring regions at least ΔE76 6 apart (or an edge that is). ΔE counts hue, so an amber hover on near-white reads as distinct. Below about ΔE 5, two surfaces merge on an ordinary monitor: the "too close in shade" complaint. | `tests/tools/colour-math.mjs`, DN-60 |
| Token test | The same thresholds on the theme tokens of all five themes. It covers 29 text pairs, 13 mark pairs, 8 state pairs, 29 region pairs, the two-tone focus ring on 10 surfaces, inputs on 4 surfaces, and "dark themes have no light slabs". | `tests/unit/theme-contrast.test.js` |
| Screen-capture review | A live pass in the Claude desktop app's browser pane, which has a GPU (menus, docks, dialogs, toasts, Follow System, the Lite file). Every dialog was reviewed by eye in grids of the screenshots, and each key surface in before/after strips across all ten combinations. | `tests/tools/visual-sheet.mjs`, [GUI3-checklist.md](GUI3-checklist.md) |
| Regression | One test per finding, measuring what is drawn. The 2.0.1 GUI sweeps were re-run on all three files, plus the full e2e suite. | `tests/e2e/gui3-fixes.spec.js` |

**Coverage.**
- Standard file: 219 distinct surfaces × 10 combinations = 1 860 screenshots.
- Lite file: 198 surfaces, 1 670 screenshots. Lite has no point-cloud state.
- Air-gapped file: the chrome and the image state, 65 surfaces, 460 screenshots.
- That is 3 990 screenshots per run. The audit ran seven times: a smoke run, two baselines, three fix rounds and the final run.
- 113 dialogs and docked tool panels were captured. Four of them had never been opened by the 2.0.1 sweeps: Select Bands, Blend, Flicker Rate and Terrain Extraction. Terrain Extraction is where GUI-069 was found.
- 160 entries (Standard) were skipped because the command was greyed out in that state. Most of them are second-level dialogs, opened from another dialog's button, which use the same dialog styles.

## 3. Results

### 3.1 Before and after (Standard file; Lite is the same within a few counts)

Findings per layout × theme on 2.0.1 (*before*) and 2.0.2 (*after*). Each count is one element on one surface that fails one check. The audit tool and its thresholds are the same in both runs.

| Layout × theme | text before → after | icons / outlines | focus | hover (look) | hover (text) | regions | axe |
|---|---|---|---|---|---|---|---|
| Modern · Material dark | 209 → 0 | 64 → 0 | 26 → 0 | 349 → 11 | 26 → 0 | 79 → 0 | 153 → 0 |
| Modern · Material light | 0 → 0 | 3 → 0 | 26 → 0 | 349 → 0 | 0 → 0 | 147 → 0 | 0 → 0 |
| Modern · Dark | 79 → 0 | 18 → 0 | 91 → 0 | 321 → 11 | 26 → 0 | 81 → 0 | 23 → 0 |
| Modern · Grey | 11 → 0 | 3 → 0 | 0 → 0 | 321 → 0 | 0 → 0 | 27 → 0 | 11 → 0 |
| Modern · Print | 0 → 0 | 3 → 0 | 0 → 0 | 321 → 0 | 0 → 0 | 163 → 0 | 0 → 0 |
| Classic · Material dark | **759 → 0** | **567 → 0** | 36 → 0 | 312 → 0 | 101 → 0 | 250 → 0 | 336 → 0 |
| Classic · Material light | 0 → 0 | 3 → 0 | 47 → 0 | 301 → 0 | 44 → 0 | 328 → 0 | 0 → 0 |
| Classic · Dark | 81 → 0 | 21 → 0 | 0 → 0 | 46 → 0 | 47 → 0 | 281 → 0 | 31 → 0 |
| Classic · Grey | 19 → 0 | 3 → 0 | 99 → 0 | 46 → 0 | 77 → 0 | 188 → 0 | 10 → 0 |
| Classic · Print | 0 → 0 | 3 → 0 | 11 → 0 | 46 → 0 | 44 → 0 | 88 → 0 | 0 → 0 |
| **Total** | **1 158 → 0** | **688 → 0** | **336 → 0** | **2 412 → 22** | **365 → 0** | **1 632 → 0** | **564 → 0** |

*After* is the final 2.0.2 build (`dist`, audit `final-full`). Selected-state findings went from 45 to 0 and chart findings from 0 to 0. 2.0.1's charts did draw faint marks (GUI-068), but they cleared the audit's "is there any visible mark" floor; the token test catches them.

**Distinct problems:** 77 before (Standard and Lite alike), 1 after. The third fix round still left the snackbar action (110 hover-text findings: tinting it on hover cost its label contrast, 3.47:1); the final build outlines and underlines it instead, and it no longer appears. The one left is the 22 hover-look findings on the filled **Open** button in the dark themes. Its fill can change only ΔE 7 before its label loses contrast, so its hover also draws a 3 px ring, which the audit does not count. This is accepted.

### 3.2 What was wrong, in one paragraph

The dark themes were the worst, as reported.
- In **Material dark**, the 2.0 default, every menu drew black text on near-black (1.28:1), because the menu rules hard-coded `#000` and only the classic Dark theme overrode it (GUI-059).
- The same rules made the **Classic layout in Material dark** almost unreadable: the ribbon, title bars and tool buttons were black on dark grey (GUI-060).
- In both dark themes, panels, their tab strips, title bars and headers were **the same shade or ΔE 2–4 apart** (GUI-061).
- The Dark theme in the Modern layout showed **white Material slabs** (GUI-062).
- Hover and selection looks, snackbars and tooltips, the focus ring, edges and chart colours were all too faint, in dark themes and often in light ones too (GUI-063 to GUI-068, GUI-070 to GUI-078).
- The by-eye pass over the screenshots added an unstyled wizard tab bar (GUI-069) and two layout blemishes (GUI-079, GUI-080).

### 3.3 Fixes

- **Every chrome colour is a theme token**, with new roles for menus, ribbon text, title bars, edges, dividers, tooltips, snackbars, focus halo and charts. The single-theme CSS patches are gone (DN-60).
- **Re-tiered palettes.** Material dark and Dark are even ladders about L* 6.5 apart, so each region reads as its own layer. Hover is a bluer step, and selection is the primary colour. The light themes got the same treatment. The grey GXP look keeps its character; only the three places where neighbours merged changed.
- **Two-tone focus ring.** Snackbars and tooltips are inverse surfaces in Material dark. Material hover layers are doubled. Modern buttons have hover and pressed looks again.
- **Charts** draw in theme colours and redraw when the theme changes.
- **Follow System** is the new default theme (GUI-082), as the owner asked.

Before/after strips (Standard file, all ten combinations) are in [`gui3-shots/`](gui3-shots/): main-menu File submenu, image right-click menu, Home ribbon, Toolbox, Preferences, snackbars, tooltip, histogram editor, Terrain Extraction and the whole window.

### 3.4 Final verification

On the final 2.0.2 build (`dist`), run in sequence so load could not cause flakes:

| Check | Result |
|---|---|
| Visual audit, Standard (1 860 screenshots) | 22 findings, all the accepted **Open** hover (§3.1); everything else 0 |
| Visual audit, Lite (1 670 screenshots) | 20 findings, the same **Open** hover; everything else 0 |
| Token test (`theme-contrast.test.js`) and unit suite | 168 passed |
| Regression tests for this campaign (`gui3-fixes.spec.js`) | 16 / 16 passed |
| GUI sweep, Modern layout (`gui-modern`, all three files) | 85 passed, 2 skipped |
| GUI sweep, Classic layout (`gui-sweep`, all three files) | 50 passed, 1 skipped |
| GUI coverage | 502 / 502 commands run in all three files; 419 / 424 ribbon controls; 112 / 148 dialogs opened by the sweeps; 23 055 actions; **0 problem rows** |
| Full e2e suite, Chrome and Edge | 904 passed, 6 skipped, 2 failed. Both failures were the 432 M-sample streaming conversion (`cnv-p8`, REQ-CNV-01), whose worker timed out at 120 s while the rest of the suite was loading the machine. Re-run alone it passed (311 MB COG in 172 s); it touches no code this campaign changed. |

The sweeps open 112 dialogs by id; the visual audit opens its own 113 dialogs and tool panels, four of them never opened before (§2).

## 4. Limits

- Browsers: Chrome for the audit and the live pass. Edge is in the regression suite. Safari and Firefox were not tested.
- No Windows high-contrast (forced-colours) theme exists yet. The browser's own forced-colours rendering applies, and a dedicated theme is a candidate for 2.1.
- The audit measures the DOM. Two things are not measured: graphics drawn on the imagery (markers, the scale bar, measurement graphics), whose fixed high-visibility colours are by design, and the WebGL image itself.
- Hover and focus are forced on two controls of each kind per surface, not on every control. The kinds share their CSS.
- The ΔE floors (12 for a state, 6 for a region) are the campaign's own choice. WCAG sets no luminance or colour-difference requirement for a hover or a surface boundary, so the floors are recorded in DN-60 for review.
