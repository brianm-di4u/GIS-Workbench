# GUI3 live-pass checklist (2.0.2 visual campaign)

The hands-on, screen-capture half of the 2.0.2 campaign ([GUI3-report.md](GUI3-report.md)). It was run in the Claude desktop app's browser pane, which has a GPU. The files were the 2.0.1 build (`dist-gui3`) and the fixed build (`dist-gui3b`, then `dist`), served by `tests/tools/serve.mjs`, with fixtures loaded through its `/__loader` page. Each row was looked at in a screenshot, before and after the fix: live in the pane, or in the visual audit's screenshot of that layout and theme (before/after strips and contact sheets). The welcome card is not an audit surface and was checked live in all five themes on the final build. ✓ = looked right after the fix; the finding id is given where the "before" showed a defect.

## Themes and layouts (Standard file)

| Check | Modern m3-dark | Modern m3-light | Modern dark | Classic grey | Classic dark | Classic m3-dark |
|---|---|---|---|---|---|---|
| App bar, rail, search box separate from the canvas and docks | ✓ | ✓ | ✓ (GUI-062) | — | — | — |
| Main menu and its submenus readable; the item under the pointer readable | ✓ (GUI-059) | ✓ | ✓ (GUI-059) | ✓ | ✓ | ✓ (GUI-059) |
| Image right-click menu and mini toolbar over imagery | ✓ (GUI-059) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ribbon labels, icons, group captions, contextual tab captions | — | — | — | ✓ (GUI-071, GUI-072) | ✓ | ✓ (GUI-060) |
| Dock title / tab strip / content / tabs read as layers | ✓ (GUI-061) | ✓ (GUI-073) | ✓ (GUI-061) | ✓ (GUI-072) | ✓ (GUI-061) | ✓ |
| Toolbox tool buttons and their icons | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (GUI-060) |
| Preferences dialog: tree, User/Common tabs, inputs, buttons, Theme row | ✓ (GUI-082) | ✓ | ✓ | ✓ (GUI-074) | ✓ | ✓ |
| About & Diagnostics: tables, primary button outline, focus ring | ✓ (GUI-070) | ✓ | ✓ | ✓ (GUI-063) | ✓ | ✓ |
| Toasts (info / warn / error, action button) over imagery and over docks | ✓ (GUI-067) | ✓ | ✓ (GUI-067) | ✓ | ✓ | ✓ |
| Welcome card and persona cards | ✓ | ✓ | ✓ (GUI-062) | — | — | — |
| Status bar: cells, separators, Terrain Not Available, Online/Offline | ✓ | ✓ (GUI-073) | ✓ | ✓ | ✓ | ✓ |

## Follow System (GUI-082)

| Check | Result |
|---|---|
| No saved theme, OS dark → Material dark, `data-theme-pref="system"` | ✓ |
| OS switched to light while open → Material light, no reload | ✓ |
| Classic layout follows as grey (light OS) or dark (dark OS) | ✓ (regression test) |
| A chosen palette (Print) stays when the OS changes | ✓ (regression test) |
| App-bar theme button: label says the current theme and the next one; cycles Light → Dark → Follow system | ✓ |
| View ▸ Display ▸ Theme, the Workspace View ▸ Theme submenu and Preferences ▸ Display ▸ Theme list Follow System | ✓ |

## Lite file

| Check | Result |
|---|---|
| Opens in the theme the OS asks for; the fixes above hold (same stylesheet) | ✓ |
| Palette: greyed 3D, LiDAR and SAR commands readable, the "Not now…" reason in full on two lines | ✓ (GUI-081) |
| About names the Lite edition and what it leaves out | ✓ |
| Image right-click menu, pill and snackbars | ✓ |
| Classic + Material dark ribbon (Visualize / Enhance) and Layer Manager active row | ✓ |

## Dialogs and panels by eye (contact sheets)

All 113 captured dialogs and docked tool panels were reviewed in the Material light and dark contact sheets (`tests/tools/visual-sheet.mjs --grid`). The layout defects found there are GUI-079 (plain result tables without cell spacing) and GUI-080 (Input Devices gains wrapping). No dialog was clipped, overflowed sideways or had overlapping controls. The automated sweep checks the same three things at four window sizes.

## Not covered live

- Safari and Firefox: the campaign used Chrome (the audit and the pane); Edge runs in the regression suite.
- Windows high-contrast (forced colours) mode: there is no theme for it yet. The browser's own forced-colours rendering applies.
- Point clouds and 3D in Lite: Lite leaves those modules out; only their greyed commands were checked.
