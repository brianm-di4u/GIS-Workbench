# R2 Photogrammetry, terrain, 3D and extraction — validation report

Build: `dist/gis-workbench.html` 4.53 MB (eager 1.70 MB). Rust WASM in eight bundles (gzip):
core 124.7 KB, parse 94.6 KB, j2k 90.6 KB, photo 85.5 KB, raster 30.1 KB, terrain 47.9 KB,
pointcloud 122.1 KB, vector 41.2 KB — 637 KB of the 1.2 MB WASM budget, each within its
Appendix D budget. Lazy JS blocks: three.js 136 KB, milsymbol 191 KB, pptxgenjs 123 KB,
SQLite/R*Tree glue 45 KB plus its 631 KB WASM (gzip). Tested on Windows 11 with Chrome and Edge
(stable channels) on an Intel Arc integrated GPU. Date 2026-10-26.

## Exit criteria (SDP §5.5, R2)

| Criterion | Result |
|---|---|
| SCN-05..10, 14, 17 and 18 pass on FX-02, 04, 05, 09 and 12 | **Pass** in Chrome and Edge (table below). |
| PRF-05..07 met | **Met on this machine** without WebGPU (table below). The WebGPU budgets of PRF-06/07 are not measured: there are no WebGPU paths (DN-30). The reference laptop was not available. |

## Scenarios

| Scenario | Fixture | Spec | What is checked | Result |
|---|---|---|---|---|
| SCN-05 stereo set-up and 3-D measurement | FX-02 | `scn05.spec.js`, `stereo-extra.spec.js`, `perf-r2.spec.js` | AT-05.1 y-parallax ≤ 0.5 px at 20 points; AT-05.2 convergence, B/H, BIE within 0.5°; AT-05.3 anaglyph pans a 2560 × 1440 viewport ≥ 30 fps; AT-05.4 box heights within 1 m with LE90; AT-05.5 Z through GeoPackage (`scn17-gpkg.spec.js`); stereo linked to mono, manager, spanned/interleaved modes | pass |
| SCN-06 multi-image triangulation | FX-04 | `scn06-07.spec.js` | AT-06.1 3-D checkpoint RMSE 18.6 m before, 0.24 m after; AT-06.2 residual table and blunder flag; AT-06.3 report; AT-06.4 bit-identical undo; AT-06.5 "triangulated: SOL-0001" | pass |
| SCN-07 multi-image point | FX-04 | `scn06-07.spec.js` | AT-07.1 ≤ 1 GSD / 1.5 GSD; AT-07.2 CE90 from the 2 × 2 covariance; AT-07.3 convergence warning; AT-07.4 MGRS truncation; AT-07.5 HAE and MSL labelled | pass |
| SCN-08 DEM extraction and edit | FX-02, FX-05 | `scn08.spec.js`, `dem05.spec.js` | AT-08.1 flat RMSE 0.13 m, 100 % of box tops within 1.5 m; AT-08.2 96.5 % of occluded posts flagged; AT-08.3 plane edit, undo; AT-08.4 GeoTIFF and DTED; AT-08.5 the < 30 checkpoint warning; NCC Fast 3× faster than SGM, 0.10 m flat RMSE; fusion | pass |
| SCN-09 orthorectification and mosaic | FX-04, FX-05 | `scn09.spec.js`, `ootf.spec.js` | AT-09.1 RMSE_r 0.02 m with CE90; AT-09.2 seam roads ≤ 0.17 m; AT-09.3 COG structure and GeoTIFF 1.1 keys; AT-09.4 seam edit re-blends 4 of 49 tiles in 152 ms; Ortho On-the-Fly and virtual mosaic | pass |
| SCN-10 building and road extraction | FX-02, FX-09 | `scn10.spec.js`, `extract.spec.js` | AT-10.1 squaring (R1); AT-10.2 ten captures take the defaults, a changed default only later ones; AT-10.3 domain and range messages name the attribute and the allowed values; AT-10.4 11 of 11 FX-09 buildings at IoU 0.87–0.96, heights within 0.21 m; AT-10.5 undershoot (1.3 m) and overshoot (0.9 m) found, snapped and trimmed; 3-D buildings in GLB/OBJ/CityJSON with gable and hip roofs; Drop to Ground; magic wand and road trace | pass |
| SCN-14 LiDAR | FX-09 | `scn14.spec.js` | AT-14.1 5.08 M points at 60 fps (vsync) with a 3 M budget, LAZ in 6 workers; AT-14.2 header and class counts; AT-14.3 DTM RMSE 0.007 m from the file's classes and from SMRF (99.998 % agreement); AT-14.4 nDSM building heights within 0.12 m; AT-14.5 profile swath exact, picks to the stored point; US-feet GeoTIFF keys; class edits with undo; colourise; LAS/LAZ 1.4 export round trips | pass |
| SCN-17 GIS round trip | FX-12 | `scn17.spec.js`, `scn17-gpkg.spec.js` | AT-17.1 GeoPackage count, 1e-9°, Z, field types, UTF-8; AT-17.2..17.4 (R1); AT-17.5 GeoPackage 1.4 core checks done with SQLite in Node (application_id, user_version 10400, SRS rows, geometry columns with z = 1, R*Tree and its six triggers, metadata); domains survive and become a schema; MGCP cross-walk; CSV/WKT | pass |
| SCN-18 LOS, viewshed and HLZ | FX-05 | `scn18.spec.js` | AT-18.2 (proxy, S-15 open) 238/238 sight lines agree; AT-18.3 pad 99.8 % suitable, cells near the building rejected; AT-18.4 curvature changes results; AT-18.5 the DTM warning; raster to vector; DEM difference | pass |

## Performance on this machine (not the reference laptop)

| Requirement | Budget | Measured | Source |
|---|---|---|---|
| PRF-05 5 M-point cloud | ≥ 30 fps | 60 fps (display-limited), 3.0 M of 5.08 M points drawn; load 2.4 s (LAZ decode 0.9 s in 6 workers) | `scn14.spec.js` |
| PRF-06 4k × 4k DSM without WebGPU | ≤ 60 s | 17.8 s Chrome, 18.2 s Edge (4096² FX-02 pair, 25 tiles in 6–7 workers, 96.6 % matched) | `perf-r2.spec.js` |
| PRF-07 1025² viewshed in a worker | ≤ 2 s | 0.3 s (Rust native 303 ms; the E2E gate is < 2 s) | `scn18.spec.js`, `gw-terrain/tests/viewshed.rs` |
| AT-05.3 anaglyph, 2k viewport | ≥ 30 fps | 60 fps (display-limited), 1.1 ms GPU frame, 2560 × 1440 window, 1896 × 1230 stereo pane | `perf-r2.spec.js` |
| REQ-DEM-05 NCC Fast vs SGM (2048² pair) | faster | 1.5 s vs 4.8 s, flat RMSE 0.10 m vs 0.13 m | `dem05.spec.js` |

Raw figures are in `reports/perf-r2-chrome.json` and `reports/perf-r2-edge.json`.

## Fixtures

New generators in `build/fixtures` with machine-readable truth (DN-21):
- **FX-02:** a 2048² stereo pair (NITF, RPC00B, USE00A) with eight boxes of 5–40 m, truth DSM,
  occlusion mask and 20 checkpoints; `FX02_SIZE=4096` makes the PRF-06 pair.
- **FX-04:** four images with known RPC biases, six GCPs and three checkpoints.
- **FX-05 DSM:** the FX-05 terrain with a 15 m building and trees on the pad.
- **FX-09:** a 1.0 M-point LAS 1.4 (format 6, UTM 11N + EGM96 compound WKT), the same as LAZ,
  a 5.08 M-point LAZ, and a LAS 1.2 format-3 subset in US survey feet with GeoTIFF keys; truth
  for the header, classes, returns, eleven buildings and ninety trees.

## Totals

| Check | Result |
|---|---|
| E2E (Playwright) | 324 of 324 pass: 162 tests in each of Chrome and Edge, 41 spec files |
| Unit (Node) | 80 pass |
| Rust workspace tests | pass, including `gw-pointcloud` FX-09, `gw-vector` validation, `gw-sensor` frame/RSM and `gw-match` NCC |
| Build gates | WASM bundle budgets, no `eval`/`new Function` in any block, single file, notices |
| Traceability (R2) | 93 requirements: 78 tested, 4 implemented without a citing test (Shoulds), 11 not cited (Coulds and deferrals in DN-40); **0 Musts without a citing test** |

## What the tests found and fixed

- The worker pool could start 13 workers under load; it now counts workers being started and
  queues CPU jobs.
- MediaRecorder gives no data from a canvas in headless browsers, so fly-throughs are encoded
  frame by frame with WebCodecs VP8 and our WebM muxer.
- Overshoots were reported as undershoots; overshoots are now checked first.
- Trees were taken for buildings until a smooth-fraction rule and roughness 0.15 were added;
  roof forms needed a four-corner footprint (minimum-area rectangle).
- The road trace wandered off the road until a line-pull prior was added.
- Building heights came from the DSM instead of the ground until the DTM was preferred.
- The first NCC engine was slower than SGM; matching at half resolution fixed it.
- RSM-from-RPC read the RPC record two values off (ERR_BIAS and ERR_RAND come first).
- AT-05.3 first checked the stereo pane, not the 2k window, against 1920 px.

## Implemented in R2 (summary)

- **Photogrammetry:** block adjustment over any model (DN-28); RPC refit; tie points (Harris,
  NCC + LSM); multi-image point; stereo display plane with ten modes, floating cursor, 3-D
  mensuration (DN-29); frame, pushbroom and RSM-polynomial models with the frame import wizard
  (DN-38).
- **Terrain:** census SGM and NCC Fast (DN-30); DEM edits as a command log (DN-31); contours,
  DTED/GeoTIFF writers, accuracy report, SMRF; ortho, mosaics, seam edits, Ortho On-the-Fly
  (DN-32); viewshed, fans, HLZ, raster to vector, DEM difference (DN-33).
- **3D and LiDAR:** LAS/LAZ (DN-34), the 3D pane with budgeted LOD and EDL, colour modes,
  shaving, profiles, grids, SMRF, class edits, clipping, colourising, LAS/LAZ export (DN-35,
  DN-36); RTIN terrain draped with imagery, Free/Orbit/Route, 3D cursor, 3D LOS, glTF import,
  WebM fly-throughs.
- **Extraction:** TDS 7.1 schema forms, persistent attribution, attribute sets, auto values,
  style sheets, custom tools, validation in Rust with fixes and saved sessions, 3D buildings
  with roof forms, buildings and trees from a DSM with heights handed back, assisted
  digitising, GeoPackage, CSV/WKT, glTF/OBJ/CityJSON, MGCP cross-walk, ArcGIS hand-off (DN-37).
- **Products and platform:** PowerPoint and the Finishing Tool; GRG and micro GRG; MIL-STD-2525
  C/D/E symbols; legacy datums with the shift σ in CE90; online sources (XYZ, WMS, WMTS, ArcGIS)
  with tokens kept out of files; provenance notice and redaction/split; streamed saves;
  Gamepad and SpaceMouse input.

## Known gaps carried into R3

See DN-40. In short: COPC/EPT range streaming; quantized-mesh and COPC online sources; WebGPU
paths; RSM grids and error TREs (RSM is experimental until it passes NGA samples); building
texturing and `.3tz` (Coulds); 3D "Sync Always"; gaps in validation. Not run here: the
reference laptop, the GC review, `gdal_viewshed` (S-15), usgscsm (S-05), Safari.
