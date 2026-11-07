# DN-63 Build profiles: Full and Lite (2.5, OD-2.23)

Owner decision OD-2.23 (2026-11-03): "the full version has all features but is limited to Desktop GUI only, and the Lite version carries the reduced feature set and Mobile-only GUI". REQ-HOST-05 (amended) and SCN-56 hold it. This note is the rule every new function follows.

## The two editions
| | GIS Workbench (Full) | GIS Workbench Lite |
|---|---|---|
| Files | `gis-workbench.html`, `gis-workbench-airgap.html`, `embed/snippet.html` | `gis-workbench-lite.html`, `embed/snippet-lite.html` |
| Manifest `build.profile` | `standard` or `airgap` | `lite` |
| GUI | desktop only: Ribbon, docks, Multiports, Modern and Classic layouts | mobile only: `app/src/mobile/` (touch-first shell) |
| Entry | `app/src/main.js` | `app/src/mobile/main.js` |
| Features | every feature (`features/index.js` FEATURES) | the modules of `mobile/features.js` |
| Commands | every command | the commands of `app/src/data/lite-commands.json` |
| Blocks | every block | `build/build.mjs` LITE_BLOCKS; the rest are `omitted` in its manifest |
| Sidecar | yes (loopback origins in the CSP) | no (a phone cannot reach a loopback sidecar; no loopback origin) |
| Size gate | 16 MB warning, 18 MB fail, decimal (REQ-ARC-03, OD-2.27); eager part 3 MiB warning, 6 MiB fail | 5.5 MiB fail (`build/gates.mjs` liteSizeGate) |

Full is a superset: every Lite command also runs in Full, with the desktop GUI. The Lite field tools (My Location, Field Observation with photos, Export Observations) are in Full too (`features/field-lazy.js`, lazy block `js-field`).

**What leaves a phone (OD-2.24).** Export Observations also carries the AOI, GRG and annotations. Export Snapshot is the one way to keep work in Lite, which has no project file; there it stops at 25 MB, because the whole file is built in the phone's memory. The other Lite safety net is crash recovery, which holds the edits but not the imagery.

## The rule for a new function
1. **Full only is the default.** A command added to `shell/commands.js` CATALOG, or defined later with `commands.define()`, is Full only. Nothing else is needed; `commands.get(id).profiles` is `['full']`.
2. **Also in Lite** only by adding its id to `app/src/data/lite-commands.json`, in a group whose `reason` says why it belongs on a phone: touch-friendly, light, useful in the field. A new group needs an `id`, a `title` and a reason of at least one sentence (the gate asks for 40 characters).
3. A Lite command must then
   - be implemented by a module in `app/src/mobile/features.js` (add the module there if it is not);
   - be offered by the mobile shell (`app/src/mobile/shell.js` SHEETS, FAB or a button), with touch targets of at least 44 px;
   - work without a desktop: no dock, Ribbon, palette, Workspace window or second window; dialogs from `shell/dialogs.js` are fine (Lite's CSS shows them as bottom sheets).
4. **Never in Lite:** photogrammetry, stereo, 3D, LiDAR, SAR, video, the sidecar, heavy AI, products and editing tools. `tests/unit/profile.test.js` holds this list (DESKTOP_ONLY).
5. A new lazy block that a Lite command needs goes into `build/build.mjs` LITE_BLOCKS, and the Lite file must still pass its size gate.

## How it is enforced
- `app/src/core/profile.js`: `LITE_COMMANDS`, `profilesOf(id)`, `buildProfile(gw)`, `inProfile(id, profile)`.
- `shell/commands.js`: every command carries `profiles`; in the Lite build `enabled()` is false and `run()` refuses a Full-only command by name ("… is in the Full edition only: open GIS Workbench (Full) on a desktop computer.") before anything else, implemented or not.
- `tests/unit/profile.test.js` (the Lite command list gate): the list's format and reasons; every Lite id is catalogued, implemented by a module the Lite build installs (a literal id or a template such as `` `draw.${shape}` ``), offered by the mobile shell, and not in DESKTOP_ONLY; every other command is tagged Full only; `define()` follows the list; the Lite size gate.
- `tests/e2e/25-mobile.spec.js`: at run time in the Lite file, every Lite command is implemented and tagged `full,lite`, no other command is enabled, the shell offers only Lite commands, and a Full-only command is refused by name.
- `boot.js`: a block the Lite file leaves out is refused by name ("this needs the 3D module, which GIS Workbench Lite leaves out…").

## Applying the profile tags (the integrator's steps)
There is one place to tag a command: **`app/src/data/lite-commands.json`**. `shell/commands.js` has no profile column and `define()` takes no profile field; `core/profile.js` works out `profiles` from the list.

**A Full only command needs no edit.** Leave it out of the list and it is tagged `['full']`. Each group's note says `Full only` or `also Lite` per command in its `## Lite fit` section.

**An `also Lite` command needs all of these, or the gate fails:**
| File | Edit |
|---|---|
| `app/src/data/lite-commands.json` | Add the id to the `commands` of a group whose `reason` covers it, or add a new group. |
| `app/src/mobile/features.js` | Add the module that implements the command to its imports and to `LITE_FEATURES`, unless a listed module already holds it. |
| `app/src/mobile/shell.js` | Offer it: an entry in a `cmds` list of `SHEETS`, or `FAB`, or a `cmdButton('id')` or `commands.run('id')` call. |
| `build/build.mjs` `LITE_BLOCKS` | Add any lazy block the command loads. The gate does not check this one: see below. |

Then run `npx vitest run tests/unit/profile.test.js`, build, and run `tests/e2e/25-mobile.spec.js` in Chrome and Edge. Open the command once in the Lite file as well.

**What the gate checks** (`tests/unit/profile.test.js`):
| Check | It fails when |
|---|---|
| List format | `format` is not `gw-lite-commands/1`; a group's `id` is not lower-case letters, is repeated, or the group has no commands; `title` is 3 characters or shorter; `reason` is under 40 characters. |
| Each id once | An id is in two groups, or twice in one. |
| Catalogued | An id has no row in `shell/commands.js` CATALOG. A command made only with `define()` at run time needs a row before it can be listed. |
| Not desktop-only | An id matches `DESKTOP_ONLY` in the test. That covers whole prefixes such as `stereo.`, `3d.`, `pc.`, `sar.`, `fmv.`, `sidecar.`, `ai.`, `lai.`, `dem.`, `prod.`, `vec.` and `det.`. Do not widen the test to let one through: that is an owner decision (OD-2.23). |
| Implemented | The id, or a template of its prefix such as `` `draw.${shape}` ``, is not in the text of a file the Lite build installs: the modules `mobile/features.js` imports and the `mobile/` files. The check is a text search; it does not run the command. It stops one import deep outside `mobile/`, so the id has to be in the listed module itself. |
| Offered, both ways | A listed id is not offered by the mobile shell, or the shell offers an id that is not listed. |
| Tagged | A command's `profiles` is not `['full', 'lite']` when listed and `['full']` otherwise, for CATALOG rows and for `define()`. |
| Refused by name | The Lite build runs or enables a Full-only command, or does not refuse it with "… is in the Full edition only". |
| Size | `liteSizeGate`: an error over 5.5 MB, a warning within 5 % of it. The build applies the same gate to the real file. |

`tests/e2e/25-mobile.spec.js` then checks, in the built Lite file, that every listed command is implemented and tagged `full,lite`, that no other command is enabled, that the shell offers only listed commands, and that the sheets it opens pass axe and have targets of at least 44 px. A new sheet needs adding to that spec.

**What neither checks.** A lazy block missing from `LITE_BLOCKS` passes both: a lazy command counts as implemented while its block is absent, and the failure only shows when the command runs (`boot.js` refuses the block by name). Neither judges whether a `reason` is true, or whether the tool can be used by touch.

**Merging the other groups:**
- `LITE_OMIT` is gone from `build/build.mjs`. `LITE_BLOCKS` is an allow-list, so a block not named there is left out of Lite by itself.
- `LITE_NEEDS` is gone from `shell/commands.js`, and the CATALOG now ends with the three field rows. Keep every group's new rows; `liteGap()` no longer needs a per-block entry.
- `features/index.js` is Full only. Adding a module there does not put it in Lite.

## The 2.5 audit (wave T0b)
Every command the T0b wave added was reviewed at integration against the rule above. All 32 are **Full only**, so none is in `lite-commands.json`.

| Item | Commands | Why Full only |
|---|---|---|
| REQ-GAP-20, 22, 24, 46 | `model.vendor`, `tri.aero`, `tri.resect`, `tri.fiducials`, `model.csm`, `pc.registerimage` | Photogrammetry and LiDAR (rule 4) |
| REQ-GAP-42 | `sar.stereopairs`, `sar.stereodsm`, `sar.stereoreport` | SAR, multi-GB inputs (rule 4) |
| REQ-GAP-35, 68 | `3d.i3s`, `3d.i3sidentify`, `3d.slpk`, `3d.pdf`, `hub.slpk`, `hub.flt` | 3D (rule 4) |
| REQ-GAP-39 | `tin.new`, `tin.editor`, `tin.import`, `tin.export`, `tin.raster`, `tin.view3d` | Editing tools (rule 4) |
| REQ-GAP-49 | `fmv.hls` | Video (rule 4). The streams note proposed Lite; it needs the desktop video view, so it stays Full only |
| REQ-GAP-64 | `net.portal`, `vec.attachments`, `vec.related`, `vec.versions`, `vec.lyrx` | Editing tools. `net.portal` is a later candidate: it needs a mobile sign-in flow and the 24.8 KB `js-portal` block |
| REQ-GAP-73 | `los.airports`, `los.obstruction` | Products |
| REQ-GAP-74 | `gps.flightplan` | Later candidate: light, but Lite has no route tool and the dialog is not yet touch-ready |

The three field tools from the mobile group (`geo.locate`, `obs.field`, `obs.export`) are in both editions.

## Full is desktop only
- At a viewport under 600 CSS px, or on a coarse pointer without a fine one, Full shows a translatable notice (`shell/phone-notice.js`) that points to GIS Workbench Lite (a link to `gis-workbench-lite.html` beside it). The user continues in Full with one button; "Don't show this again" keeps the choice in Preferences (`phoneNotice: 'off'`).
- Full keeps pen and touch input for Windows touchscreens (the radial menu's long press in `features/hud.js`, pointer events in the panels). The responsive breakpoints in `styles/25-shell2.css` (900–1180 px) serve narrow desktop windows and stay. Full had no code that served phones alone, so none was removed.

## Lite on a large screen
Lite keeps the mobile GUI at every size, responsive to tablet size: the image always fills the window; from 768 px wide the sheets keep a readable width (34 rem) centred at the bottom, the drawer stays 22 rem, and the app bar centres its buttons. It is not boxed into a phone-width column.
