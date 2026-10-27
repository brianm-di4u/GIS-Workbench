# T&E improvements register

These are improvements the campaign implements or proposes. Owner decision (2026-10-26): the campaign may implement any improvement it finds, including ones outside the current PRD scope.

Two rules apply:
- Each out-of-scope improvement gets a new REQ row through `Docs/tools/newreqs.mjs`, and the Appendix A matrix is regenerated, so the PRD stays truthful.
- An improvement that would relax a hard constraint goes to [TE-owner-decisions.md](TE-owner-decisions.md) instead. The hard constraints are: single-file and offline-first, the ARC-03 size gates, strict CSP, no unrequested network traffic, the licence policy and the WASM memory caps.

| IMP | Source (TE / phase) | Area | Improvement | In PRD scope? | New REQ | Before → after (measured) | Status | Test |
|---|---|---|---|---|---|---|---|---|
| IMP-01 | TE-003 / 1 | JPEG 2000 | Standalone JP2/J2K reader (GeoJP2, GMLJP2), lazy decode: coarse pyramid levels from the codestream's reduced resolutions, full resolution only on zoom | FMT-02 covers JPEG 2000 in NITF; standalone JP2 extends it | REQ-FMT-18 (new) | S2 L1C band: refused → 25 s → **0.42 s** first display | Done | c01 S2 bands; c19 |
| IMP-02 | TE-018/019 / 6 | Raster I/O | Strided coarse levels for uncompressed NITF/SICD; row-band cache for striped GeoTIFF | PRF-03, ARC-07 | — | SICD 953 MB: 118 s → **3.4 s**; striped WV3: 31.9 s → **9.7 s** | Done | c19 PRF-03 |
| IMP-03 | TE-006 / 1 | GeoPackage | Raster tile pyramids read: finest level within 64 Mpx, cropped to the gpkg_contents extent, opened as a georeferenced image (PNG + world file + CRS); tiles-only files no longer fail on the missing gpkg_geometry_columns table; gridded coverages refused by name | FMT-12 Could | REQ-EXT-22 extension | refused/silent → opens (GDAL sample, NGA conformance tiles, 3857, Denver, WebP elevation) | Done | c01 GeoPackage set |
| IMP-04 | TE-018 / 6 | GeoTIFF | Uncompressed striped GeoTIFF: coarse levels from strided row reads (every 2^L-th row's span), like raw NITF | PRF-03 | — | 537 MB striped WV3 first tile: 7.5 s → **0.69 s** (pixels identical to full-resolution reads) | Done | c19 PRF-03 |
| IMP-05 | Phase 0 | Build | `build.mjs --out <dir>` (documented, never implemented) | ARC tooling | — | — | Done | used for dist-te |
| IMP-06 | Phase 0 | Rust gate | Debug-profile gate matches shipped behaviour: laz debug-assertions off in dev; viewshed timing asserted in release only | SDP CI | — | `npm run test:rust` red → green (166 pass) | Done | test:rust |
| IMP-07 | TE-004 / 1 | Sensor models | DigitalGlobe/Maxar .RPB → RPC model (with .TIL tile offset) | SNS-02 | — | no model → RPC00B model | Done | c01, c20 rpc |
| IMP-08 | TE-013 / 1 | Lidar | Clouds without a CRS open in a local metric frame | LDR-01 | — | refused → opens with warning | Done | c01 |
| IMP-10 | Phase 7 | Traceability | `build/traceability.mjs` reports each requirement's last pass/fail from the Playwright/Vitest JSON reports, plus PT/SCN/AT/PRF/TE family counts (SDP §8 "last result") | SDP §8 | — | citations only → last results + Must-without-passing list | Done | `node build/traceability.mjs --release=R0,R1,R2,R3` |
| IMP-11 | IMP-03 | GeoPackage | Gridded coverages (2d-gridded-coverage): 16-bit PNG and float TIFF tiles with table and tile scale/offset, opened as float GeoTIFF heights, clipped to gpkg_contents as GDAL does | FMT-12 Could | — | refused by name → opens; 1114×656 and 1280×768 as GDAL; corners within 2 nm | Done | c01, c20 coverage_data*.gpkg |
| IMP-12 | Phase 3 | Map models | NAD83 / UTM 1N–23N (EPSG:26901–26923) built in as exact transverse Mercator instead of a fitted polynomial | SNS-06 | — | fitted residual 0.17 m → exact | Done | c20 (3DEP 1 m) |
| IMP-13 | TE-029 / 1 | 3D / glTF | glTF/GLB dropped or opened with other files goes to the 3D view; external .bin and textures resolve to blob: URLs | STR-13 | — | refused → imported | Done | c01 glTF set |
| IMP-14 | TE-031 / 3 | RPF / CADRG | Georeference RPF frames from the coverage section (exact outer corners) and project polar ARC zones 9/18 exactly (azimuthal equidistant on the ARC sphere, a core map CRS) | FMT-14 Could | — | 92–602 m and 185 km (polar) → **0.000 m** vs GDAL on all 5 frames | Done | c20 |
| IMP-15 | TE-024 / 1 | Vector | Country-scale vectors: a named size guard (512 MB, 256 MB zipped) instead of a page hang; streaming large GeoPackages through a range-read SQLite VFS is OD-07 | EXT-21 | — | > 900 s hang → refused by name in ~1 s | Done (guard); streaming → OD-07 | c01 large vectors |
| IMP-16 | TE-032 / 1 | SAR / GeoTIFF | Complex TIFF (SampleFormat 5/6: CInt16, CInt32, CFloat32) read block by block and shown with the SAR bands (amplitude, phase, I, Q, power) | SAR-01 | — | refused → opens (Capella SLC 1871×5026, RPC within 0.01 px) | Done | c01, c20 Capella SLC |
| IMP-17 | TE-020 / 1 | NITF T.4 | Two-dimensional T.4 (Modified READ) decoding | FMT-02 | — | refused → decoded, matches GDAL | Done | `gw-codec/tests/te_t4.rs` |
| IMP-09 | campaign | GeoTIFF GCPs | Projected (non-WGS84) GCPs converted through the CRS instead of refused | known limit in open.js | — | refused → model | Done | c20 (when data present) |
| IMP-18 | TE-038 / 2 | Triangulation | Tie-point matcher: stage-2 cell margin, 9 in-bounds stage-1 candidates, rejection statistics; Stereo Align on an 8×8 grid at NCC 0.65 | SNS-10 | — | WV3 multi-date pair: 1 → 14 tie points | Done | TE-C06 stereo.align |
| IMP-19 | TE-040/041 / 4 | Lidar | SMRF opening with PDAL's diamond structuring element; DTM posts as the cell mean | LDR-07/08 | — | 3DEP DTM RMSEz at USGS ground: 0.43 m → **0.128 m** (AT-14.x 0.15 m) | Done | TE-C30 SCN-14 |

## Candidates known at campaign design (to be confirmed in execution)

| Candidate | Why | Evidence |
|---|---|---|
| Implement the 12 placeholder commands. GPX read (`gps.load/route/waypoint`), GeoPDF write (`snap.geopdf`), `img.projection`, `dem.volume`, `dem.folder`, `file.snapshot`, `bg.online`, `auto.console`; fold `pack.load`/`pack.list` into `file.openpack`/`packs.manage`. | They show "planned" toasts in the shipped ribbon. | `reports/campaign/matrix.json` → `summary.placeholders` |
| Windowed / resolution-level JPEG 2000 and HTJ2K decode, instead of decoding the whole image. | Sentinel-2 L1C JP2 and large NITF C8 files hit the whole-image path. | R2-report known gaps |
| Decoder gaps: C5/M5 lossless JPEG, progressive JPEG, 2-D T.4 (U_1123a), GCPs not in WGS84, ENVI map info outside UTM/geographic, raster GeoPackage tiles. | Real data uses all of these. | `formats/open.js`, `gw-codec` limits |
| Traceability reports last pass/fail per requirement, not just citations, and matches PT/SCN/AT/PRF/TE ids. | SDP §8 requires "last result". | `build/traceability.mjs` |
| `packs.manage` is implemented but not placed in any ribbon or menu. | Unreachable from the UI. | `matrix.json` → `summary.unplaced` |
