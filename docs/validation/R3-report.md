# R3 Multi-sensor — validation report

Build: `dist/gis-workbench.html` 5.34 MB (eager 2.15 MB); `gis-workbench-lite.html` 3.9 MB
without the 3D, LiDAR, video and SAR modules. Rust WASM in ten bundles (gzip): core 136.8 KB,
parse 158.6 KB, j2k 90.6 KB, photo 93.6 KB, raster 30.1 KB, terrain 47.9 KB, pointcloud
122.1 KB, vector 41.2 KB, sar 51.6 KB, spectral 63.2 KB. That is 836 KB of the 1.2 MB WASM
budget, each bundle within its Appendix D budget. Data packs (`dist/packs`): EGM2008 5′
(16 MB), PROJ (proj-wasm 0.1.0, 3.4 MB), HDF5 (1.1 MB) and AI (onnxruntime-web + SlimSAM-77, 17.6 MB), each
listed with its SHA-256 in the build manifest and in `SHA256SUMS`.

Tested on Windows 11 with Chrome and Edge (stable channels) on an Intel Xe-LPG integrated GPU
(WebGPU available in pages and workers). This is not the reference laptop. Date 2026-10-27.

## Exit criteria (SDP §5.6, R3)

| Criterion | Result |
|---|---|
| SCN-12, 13 and 15 pass on FX-07, 08, 10 and 11 | **Pass** in Chrome and Edge (table below). |
| SAR, MSI, FMV, data packs (AI, HDF5, EGM2008, PROJ), online sources, MCP | Done: DN-41..DN-47, DN-27; every R3 requirement has a citing test (traceability below). |

## Scenarios

| Scenario | Fixture | Spec | What is checked | Result |
|---|---|---|---|---|
| SCN-12 SAR complex exploitation | FX-07, Umbra SICD | `scn12.spec.js` | AT-12.1 SICD 1.3.0 metadata card and tree; AT-12.3 image → ground → image through R/Rdot (< 0.05 px), corners against SARkit (< 0.01 px); AT-12.2 views and remaps under 200 ms on a 2k viewport without re-reading the file, pixel types (RE32F, RE16I, AMP8I_PHS8I) agree; σ⁰/β⁰/γ⁰/RCS; AT-12.4 registration within 0.05 px, CCD coherence ≥ 0.8 stable and ≤ 0.4 disturbed, CNR mask over water, amplitude change finds the moved vehicles, pair finder; AT-12.5 layover, aspect and shadows-down against the geometry | pass |
| SCN-13 multispectral classification | FX-08, Indian Pines | `scn13.spec.js`, `packs.spec.js` | AT-13.4 band names and wavelengths from BANDSB, GeoTIFF and ENVI; every IMODE reads the same pixels; AT-13.1 NDVI per field within 0.01, presets, Band Preview, Band Math on the GPU; AT-13.2 maximum likelihood (and minimum distance, Mahalanobis) ≥ 90 % OA, Jeffries–Matusita ≥ 1.8; AT-13.3 confusion matrix totals, κ to three decimals; AT-13.5 RX, local RX, GMM and ACE flag the inserted target; PCA and MNF ordering; EMIT and PRISMA through the HDF5 pack | pass |
| SCN-15 FMV with KLV and GMTI | FX-10, FX-11 | `scn15.spec.js` | AT-15.1 300 KLV packets with checksums, Items 1/2/65, unknown items listed, ST 0102 banners and conflicts, MISP time basis (−29 s to UTC, leap seconds), async KLV timed by its DTS; AT-15.2 footprints within 1 m of the truth from full corners, offset corners and the KLV frame model; AT-15.3 map, video and slider within one frame, exact frame steps, DVR rate and A–B loop, HUD; AT-15.4 PNG + world file + JSON captures, NITF with RPC00B reopening on the footprint; AT-15.5 STANAG 4607 targets within 1 m, filtered by the time slider | pass |

R3 rows outside the scenarios: `packs.spec.js` (pack verification, EGM2008, PROJ for
EPSG:31370, HDF5), `r3-review-products.spec.js` (MCP action proposals, ML detection review,
observations, DOCX, PPTX templates, GIF and video in products), `formats-r3.spec.js`
(CADRG/CIB frames, MIE4NITF, GeoPDF), `remote-edit.spec.js` (ArcGIS applyEdits, WFS-T),
`stream-pc.spec.js` (COPC by range, EPT), `tiles3d.spec.js` (3D Tiles), `stereo-out.spec.js`
(dual window, WebXR).

## R2 items finished in R3

`r2-gaps.spec.js` covers four of them; DN-40 and DN-48 give the details.
- Gap validation: one 50 m² hole found at its centroid.
- Building texturing from FX-02 image A: B05a's base corners and roof centre land within 1 px of
  the truth pixels.
- A local `.3tz` archive opens with no network.
- Sync Always runs both ways, 2D → 3D within 1 m and 3D → 2D within 1.5 px.
- Quantized-mesh terrain from an allowed origin: every vertex within 0.05 m of the generating
  surface.

## R0–R2 Shoulds and Coulds closed in R3

A runtime check found 12 catalogued commands with no implementation (two of them R3 ribbon
buttons, Load Data Pack and Installed Packs). Traceability found 22 R0–R2 requirements without
a citing test. All are implemented and cited (DN-51). `closeout-ui.spec.js` also asserts that
every catalogued command has an implementation.

| Requirement | Spec | Measured |
|---|---|---|
| REQ-UI-06/10/11/14/23/24 | `closeout-ui.spec.js` | Context menu with mini toolbar and cue-card tooltips. Exploitation Fullscreen. Preferences: tree, User/Common tabs, locks, Help/Reset/Apply/OK/Cancel. Spell check in free text only. Ribbon groups hidden and a custom tab. |
| REQ-ARC-06/15/17/19 | `closeout-ui.spec.js` | Job Queue with progress and Cancel. Lite leaves out five module blocks and names them. Automation API and console, with no eval. Snapshot round trip with the image and graphics, no relink. |
| REQ-WB-14, REQ-AI-16 | `closeout-ui.spec.js` | Feedback pages are a read-only tool without images. Streamed replies grow monotonically; Stop keeps the partial text and rolls the question back. |
| REQ-MEN-09, REQ-DEM-15 | `closeout-geo.spec.js` | Depth from the B05a roof to a checkpoint within 0.5 m of the truth. Volume of the 5 m box within 10 %. |
| REQ-IMG-31, REQ-PRD-08, REQ-IMG-18, REQ-UI-26, REQ-UI-22 | `closeout-geo.spec.js` | GPX in (MSL → HAE within 1 cm) and out. GeoPDF with /VP /GEO. OOTF in a fixed UTM zone and back. Source properties. Serial text protocol. |
| REQ-DEM-03 | `closeout-geo.spec.js` | Terrain folder: HGT/DTED by name, GeoTIFF by header; loads the DSM under new imagery as hidden HAE terrain. |
| REQ-STR-16 | `closeout-geo.spec.js` | Epipolar pair: 20 checkpoints on the same output row within 0.03 px. The GeoTIFF reopens through its GCPs. |
| REQ-SNS-19 | `closeout-geo.spec.js` | Occlusion against the FX-02 truth mask: 96.5 % of 3212 hidden posts found, 0.04 % false alarms. True ortho of A and B: 0.02 % of cells hidden from both. |
| REQ-SNS-21 | `closeout-geo.spec.js` | ORB without sensor models: 368 inliers, median 0.8 px against the truth. 13 descriptor-path tie points at a median 0.1 px from the model prediction. |
| REQ-LDR-11 | `closeout-geo.spec.js` | BPF (dimension- and point-major, zlib) and ASCII give the same points within 1 cm. The DoD finds the 3 m rise (100 m², nothing lowered). The block is extracted as a 3 m building. |
| REQ-RUST-11 | `gates.test.js` | The determinism gate decodes all ten bundles: no relaxed SIMD and no atomics (DN-52). |

## Performance on this machine (not the reference laptop)

| Requirement | Budget | Measured | Source |
|---|---|---|---|
| PRF-06 4k × 4k DSM with WebGPU | ≤ 10 s | 7.2–8.1 s in Chrome and Edge (25 tiles; heights against the workers: median difference 0, p95 7 mm; DN-50) | `perf-r2.spec.js` |
| PRF-06 4k × 4k DSM without WebGPU | ≤ 60 s | 18.6–31.2 s (6 workers; the slower run was on a busy machine) | `perf-r2.spec.js` |
| PRF-07 1025² viewshed with WebGPU | ≤ 250 ms | 32 ms on a 1121 × 929 grid; 99.9996 % of posts agree with the worker | `scn18.spec.js` |
| PRF-07 viewshed in a worker | ≤ 2 s | 0.59 s | `scn18.spec.js` |
| AT-12.2 SAR view and remap changes | ≤ 200 ms | under 200 ms (2k viewport) | `scn12.spec.js` |

## Fixtures

New generators in `build/fixtures` with machine-readable truth (DN-21):
- **FX-07:** a SICD pair with a known sub-pixel shift, a phase ramp, stable and disturbed areas
  and moved vehicles.
- **FX-08:** a multispectral NITF in every IMODE, GeoTIFF and ENVI copies, EMIT and PRISMA
  HDF5 layouts, fields with known NDVI and classes, and an inserted target.
- **FX-10:** MPEG-TS with ST 0601 KLV:
  - `fx10.ts`;
  - `fx10_b.ts` with asynchronous KLV, offset corners, ST 0102, VMTI and two bad checksums;
  - `fx10_c.ts` with no corners.
  Truth per frame.
- **FX-11:** STANAG 4607 with 30 dwells and 6 vehicles.
- **Packs and products:** a BD72 / Belgian Lambert GeoTIFF for the PROJ pack, a PPTX
  template, detections, MIE4NITF and CADRG frames.

## Totals

| Check | Result |
|---|---|
| E2E (Playwright) | 410 of 410 pass: 205 tests in each of Chrome and Edge (16.0 min) |
| Unit (Node) | 85 pass (13 files) |
| Rust workspace tests | 161 pass, 2 ignored (timing benches) |
| Fuzz (`gw-fuzz`, release) | 15 targets (NITF, TRE, DTED, unpack, JPEG, J2K, HTJ2K, VQ, T.4, SAR XML, LAS, TS, KLV, 4607, PDF), 500–1500 runs each, 0 problems |
| Traceability | R0 38/38, R1 150/150, R2 93/93, R3 63/63 tested; 344/344 in all, no untested Must |

## Known limits

- RPF A.TOC tables of contents are not read; CADRG/CIB frame files open one by one
  (REQ-FMT-14 is a Could).
- The Stealth and TopoMouse serial protocols are not public. Serial stereo mice use the
  documented text protocol (REQ-UI-22).
- Performance figures are from this machine. The reference laptop (S-01) was not available.
- The SAR, MSI and FMV accuracy claims rest on synthetic fixtures and public samples. Customer
  samples are still needed (O-12, R-15).
