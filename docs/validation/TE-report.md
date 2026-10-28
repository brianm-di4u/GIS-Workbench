# GIS Workbench — T&E campaign report

Generated 2026-10-28T02:09:45.196Z by `build/campaign/report.mjs`. Plan: [TE-master-plan.md](TE-master-plan.md). Registers: [findings](TE-findings.md), [improvements](TE-improvements.md), [owner decisions](TE-owner-decisions.md), [data catalogue](TE-data-catalogue.md).

## 1. Build under test

- `dist/gis-workbench.html`: 5.7 MB, SHA-256 `cad24fce192fb01b…`, build 5b6f417b5e14c28c.
- Corpus: 117 items (100 on disk), 40.54 GB of public downloads plus the 29 Research samples; every file pinned by SHA-256.
- Machine: Windows 11, Intel Arc integrated GPU, Chrome and Edge stable (OD-01: not the reference laptop).

## 2. Results by phase

| Phase | Passed | Failed | Skipped | Flaky |
|---|---|---|---|---|
| 1 Ingest conformance (c01, Chrome + Edge) | 800 | 0 | 0 | 0 |
| 2 Functional sweep (c02–c17, Chrome + Edge) | 876 | 0 | 0 | 0 |
| 3 Accuracy (c20, c21, Chrome + Edge) | 238 | 0 | 4 | 0 |
| 3 Accuracy, §5.2 checks added 2026-10-27 (c22, Chrome + Edge) | 14 | 2 | 0 | 0 |
| 4 Workflows and products on real data (c30, c31, Chrome + Edge) | 36 | 0 | 0 | 0 |
| 5 Live services (c18, Chrome + Edge) | 24 | 0 | 10 | 0 |
| 6 Non-functional (c19, Chrome + Edge) | 66 | 0 | 0 | 0 |
| 8 Regression: SDP E2E suite (Chrome + Edge) | 506 | 2 | 2 | 0 |

Node accuracy suites (golden): 4/4 passed.

### Phase 1 — ingest by area (Chrome and Edge records)

| Area | Files | Opened | Refused by name | With issues |
|---|---|---|---|---|
| 3d | 12 | 12 | 0 | 0 |
| dem | 36 | 36 | 0 | 0 |
| eo | 74 | 74 | 0 | 0 |
| fmv | 64 | 60 | 4 | 0 |
| geopdf | 6 | 6 | 0 | 0 |
| gmti | 8 | 0 | 2 | 0 |
| hsi | 30 | 30 | 0 | 0 |
| landsat | 38 | 38 | 0 | 0 |
| lidar | 88 | 88 | 0 | 0 |
| naip | 2 | 2 | 0 | 0 |
| nitf | 152 | 122 | 30 | 0 |
| raster | 2 | 2 | 0 | 0 |
| robustness | 72 | 28 | 22 | 0 |
| sar | 37 | 33 | 4 | 0 |
| sentinel2 | 50 | 50 | 0 | 0 |
| vector | 162 | 146 | 12 | 0 |

### Phase 2 — command coverage

448 catalogued commands, 448 implemented. Sweep outcomes: disabled 6, dialog 306, done 550, error 10, pending 4. Commands exercised without error on real data: **428**.

### Phase 3 — accuracy against independent oracles

| Check | Cases | Within tolerance | Worst difference |
|---|---|---|---|
| Geolocation, map model vs GDAL corners | 214 | 214 | 8.3652 m |
| Geolocation, rpc model vs GDAL RPC transformer | 16 | 16 | 0.0000 px |
| Geolocation, tiles model vs GDAL corners | 6 | 6 | 0.0000 m |
| CCD coherence vs numpy, Umbra Bingham pair, 5×5 (≥ 0.8 stable, ≤ 0.4 disturbed) | 0 stable / 2586 disturbed 32² tiles (numpy) | **FAIL**: app ≤ 0.4 in 2586/2586; numpy has no stable tile (B⊥ 8015 m, h_amb 0.83 m) | mean γ app 0.194 vs numpy 0.318 |
| chg.detect vs documented method in numpy, Maxar Derna WV3 co-located 2048² crop | 948 reference candidates | pass: 947 app candidates, box-cover IoU 1.000 | gain 0.8918 vs 0.8918; threshold 317.5 vs 317.4 |
| chg.detect vs documented method in numpy, Maxar Derna WV3 pre/post as delivered | 4034 reference candidates | pass: 4025 app candidates, box-cover IoU 0.999 | gain 0.9092 vs 0.9092; threshold 476.2 vs 476.1 |
| Indian Pines ML classification vs truth (OA ≥ 90 %, κ to 3 decimals) | 4674 validation px, 9 classes | **FAIL**: OA 0.870, κ 0.849 (independent 0.849) | MD OA 0.463, SAM OA 0.477; sklearn SVM 0.892 |
| Hillshade, slope, aspect vs gdaldem (±1 DN, ±0.1°, ±0.5°; ≥ 99 % of posts) | 116844 / 116170 / 115360 posts | pass: 99.84 % / 100.00 % / 100.00 % (aspect vs gdaldem turned to true north; raw 88.3 %, TE-055) | p99 1 DN, 0.058°, 0.272° (raw 0.606°) |
| msi.thermal vs numpy K1/K2, Landsat 8 B10/B11 + MTL (0.1 K) | 2 bands × 512² | pass: ribbon B10 dialog, B11 dialog; Radiometric Conversion enabled on the band file | max \|ΔBT\| B10 0.000 K, B11 0.000 K |
| TOA reflectance and NDVI vs numpy (±0.01), landsat8-c1-l1tp-044034-20210508 | 3 bands × 512² | pass | B4 0.00000, B5 0.00000, stackNdvi —, NDVI 0.00000 |
| TOA reflectance and NDVI vs numpy (±0.01), s2-l1c-jp2-safe-10seh-20240816 | 3 bands × 512² | pass | B04 0.00000, B08 0.00000, stackNdvi —, NDVI 0.00000 |
| Viewshed vs gdal_viewshed -cc 0.87 (S-15, AT-18.2 ≥ 99 %) | 260459 posts | 99.73 % agree | — |
| KLV ST 0601 vs klvdata (klv-fmv-esri-truck-tutorial-Truck.ts) | 50 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-ffmpeg-day-flight-Day Flight.mpg) | 6 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-ffmpeg-night-flight-ir-Night Flight IR.mpg) | 18 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-impleotv-damaged-corpus-klv-corrupt-checksum.ts) | 49 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-impleotv-damaged-corpus-klv-corrupt-key.ts) | 50 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-impleotv-damaged-corpus-klv-corrupt-packets.ts) | 49 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-impleotv-damaged-corpus-klv-duplicate-tags.ts) | 50 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-impleotv-damaged-corpus-klv-missing-mandatory-tags.ts) | 50 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-libmisbklv-fixtures-synthetic-timed-0x06.ts) | 6 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-libmisbklv-fixtures-synthetic-untimed-0x06.ts) | 6 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-fmv-libmisbklv-fixtures-synthetic-video.ts) | 1 packets | all equal | — |
| KLV ST 0601 vs klvdata (klv-rs-mpegts-klv-synthetic-fx10_synthetic_klv.ts) | 50 packets | all equal | — |
| NDVI vs DN reference (ndvi-naip-ca-m3812157-sw-2022) | 262144 px | mean |Δ| 0.00000 | 0.00000 |
| SMRF vs USGS 3DEP classes; DTM RMSEz at USGS ground | 36705037 points | 79.2 % agree | RMSEz 0.128 m |

### Phase 6 — performance and run modes (this machine)

| PRF-03 first tile | Size | ms |
|---|---|---|
| eo-spacenet-vegas-wv3-pan-ms-r1c1-15OCT22183656-P2AS_R1C1-055649178030_01_P001.TIF (chrome) | 536.9 MB | 664 |
| iceye-x50-slf-20251027-sidd3-iceye_X50_SIDD_GRD_SLF.nitf (chrome) | 400.0 MB | 1141 |
| umbra-bingham-20230821-repeat-umbra_20230821_SICD.nitf (chrome) | 865.6 MB | 3004 |
| umbra-bingham-20230925-full-umbra_20230925_SICD.nitf (chrome) | 953.3 MB | 3279 |
| usgs-3dep-13-n40w106-USGS_13_n40w106.tif (chrome) | 413.5 MB | 246 |
| eo-spacenet-vegas-wv3-pan-ms-r1c1-15OCT22183656-P2AS_R1C1-055649178030_01_P001.TIF (edge) | 536.9 MB | 510 |
| iceye-x50-slf-20251027-sidd3-iceye_X50_SIDD_GRD_SLF.nitf (edge) | 400.0 MB | 1053 |
| umbra-bingham-20230821-repeat-umbra_20230821_SICD.nitf (edge) | 865.6 MB | 2739 |
| umbra-bingham-20230925-full-umbra_20230925_SICD.nitf (edge) | 953.3 MB | 3018 |
| usgs-3dep-13-n40w106-USGS_13_n40w106.tif (edge) | 413.5 MB | 233 |

Run modes (file, http, cross-origin iframe, srcdoc): 56 records, 56 clean.

## 3. Findings

58 findings in the register:

| Severity / status | Count |
|---|---|
| S1 / Verified | 2 |
| S2 / Verified | 22 |
| S3 / Fixed | 2 |
| S3 / Verified | 19 |
| S4 / Fixed | 1 |
| S4 / Verified | 8 |
| — / Expected | 1 |
| — / Not-a-defect | 3 |

| TE | Sev | Status | Summary |
|---|---|---|---|
| TE-001 | S2 | Verified | Opening a current US Topo GeoPDF fails with a raw "Failed to fetch". |
| TE-002 | S2 | Verified | A ZSTD-compressed GeoTIFF reports "Failed to fetch" instead of a decode error, so ZSTD may fail even on valid files. |
| TE-003 | S2 | Verified | Standalone GeoJP2 `.jp2` files (Sentinel-2 L1C) are refused as "unrecognised data"; JPEG 2000 is read only inside NITF. |
| TE-004 | S3 | Verified | DigitalGlobe sidecars dropped with the TIF are refused, which blocks RPB (RPC) sensor models on Level-1B imagery. |
| TE-005 | S3 | Verified | Corrupt GeoTIFFs surface raw JS exceptions ("Offset is outside the bounds of the DataView", "…exceeds MAX_SAFE_INTEGER…", "Invalid array buffer length") instead of named errors. |
| TE-006 | S3 | Verified (tiles read: IMP-03, TE-036; coverages: IMP-11) | A tiles-only GeoPackage opens silently, with no layer and no message. |
| TE-007 | S3 | Verified | The 2012 US Topo is refused with "the PDF has no page with a raster image". |
| TE-008 | S4 | Verified | An Esri `.clr` colour map dropped with its TIF gives an error toast. |
| TE-009 | S2 | Verified | A CADRG frame that GDAL reads (1536², C4) fails with "VQ: short block or tables". The other two frames open. |
| TE-010 | — | Not-a-defect | Refused with "the file has no displayable image". |
| TE-013 | S2 | Verified | LAS/LAZ files without a usable CRS are refused ("no usable coordinate reference system"). That is common for delivered and test clouds. |
| TE-014 | S4 | Verified | .lax/.wdp companions dropped with a LAZ go to the image reader and raise "unrecognised data" |
| TE-015 | S1 | Verified | WebAssembly trap ("unreachable"): the file declares EPSG:4326 over X 1–226, Y 1–100, the conversion gives an 8,000 km extent, and the LOD index allocates billions of tiles |
| TE-016 | S2 | Verified | A TS with no PAT/PMT opens nothing: no error, and the player waits for ever (SEC-02 forbids hangs) |
| TE-017 | S4 | Verified (passes in isolation; load-sensitive in the 4-worker run, also CLAHE and GPU hillshade at ~1.5 min of 90 s) | `imaging.spec.js` (filters, about 40 GPU read-backs) and the R3 PPTX/video spec fail under the 4-worker full run: 90 s timeout / "no video recorded". Both pass in isolation, so this is load sensitivity, not a regression. |
| TE-018 | S3 | Verified (IMP-02; c19 PRF-03) | First tile 31.9 s. Each 512² tile re-decoded every whole-width strip it touched (about 70×). |
| TE-019 | S2 | Verified (IMP-02; c19 PRF-03) | First tile 94–118 s. The coarse levels composed from every full-resolution block, so the whole file was read. |
| TE-020 | S3 | Verified | 2-D T.4 (Modified READ, COMRAT 2DS) bi-level images are refused ("not decoded yet"). Long-standing known gap (R1/R2 reports). |
| TE-021 | S1 | Verified | Every real 3DEP production tile traps the point-cloud WASM ("unreachable"). The LOD index peaked at ~24 bytes/point plus an output copy, above the bundle's 1 GiB memory cap. |
| TE-022 | S3 | Verified | A streamed LAZ without a chunk table was refused |
| TE-023 | S2 | Verified | Once ZSTD worked (TE-002), a corrupt ZSTD block hung for more than 180 s: geotiff.js falls back to unbounded streaming decompression |
| TE-024 | S3 | Verified | Country- and world-scale vector files hung the page for more than 900 s (run 3: 5 timeouts × 2 browsers) |
| TE-025 | S2 | Verified | ENVI "map info … rotation=27" ignored: AVIRIS ortho products placed 11.6 km off |
| TE-026 | S2 | Verified | ICORDS "C" (geocentric latitudes, NITF 2.0) read as geodetic: 0.18° (19.6 km) error |
| TE-027 | S2 | Verified | GeoPackage tile images in EPSG:3857 placed absurdly wrong: gpkg_contents may hold its extent in another CRS (4326), and the crop used it as 3857 |
| TE-028 | S2 | Verified | KML with an empty Polygon/Point throws a raw TypeError ("reading 'getElementsByTagNameNS'") |
| TE-029 | S3 | Verified | .gpx files dropped or opened go to the image reader ("unrecognised data"), though GPX reading exists (gps.load) |
| TE-030 | S4 | Verified | CPHD refused as "unrecognised data" |
| TE-031 | S3 | Verified | RPF/CADRG frames used the IGEOLO 4-corner model, with the corners taken as pixel centres and the interior interpolated |
| TE-032 | S3 | Verified | Complex-integer (CInt16) GeoTIFF SLC refused ("invalid sample layout") |
| TE-033 | — | Not-a-defect (oracle) | 9 km "error" against GDAL |
| TE-034 | S2 | Verified | Hand off to ArcGIS Pro failed: "UNIQUE constraint failed: gpkg_contents.identifier" |
| TE-035 | S3 | Verified | A .gltf without its .bin/textures fetched them from the page's own folder (a CSP violation). Embedded data: buffers were also blocked by CSP. |
| TE-036 | S2 | Verified | Every tile pyramid was dropped: "no feature layers or tile pyramids" |
| TE-037 | S4 | Verified | An empty URL gave the raw "Failed to construct 'URL': Invalid URL" |
| TE-038 | S2 | Verified | Stereo Align found 1 tie point and stopped (it needs 6) |
| TE-039 | S4 | Verified | Band Math proposed "(nir − red)/(nir + red)" on an image with no band wavelengths, then refused it |
| TE-040 | S3 | Verified | SMRF's square opening reached r·√2 on diagonals and removed raised ground (embankments), leaving the DTM 2–7 m low in places |
| TE-041 | S3 | Verified | The DTM's 3×3 local-plane posts were 35–50 % worse than the cell mean at delivered ground points |
| TE-042 | S2 | Verified | Phase-8 E2E: first tile 1.5 s (> 1 s) and AOI-scoped DRA equal to full-image DRA, in both browsers |
| TE-043 | S3 | Verified | Two-date Spectral Change was enabled by any two multiband images, then failed with a raw "Cannot read properties of undefined (reading 'width')" |
| TE-044 | S2 | Verified | Colourise failed: "Invalid typed array length: 110115111" |
| TE-045 | S3 | Verified | COPC streaming refused: "no Content-Range size" (S3 does not expose Content-Range to CORS) |
| TE-046 | S4 | Verified | Jump to Point confirmed with an empty entry threw; the core's error and stack reached the console |
| TE-012 | — | Not-a-defect | Refused: "mask table: IMDATOFF is inside the mask table". |
| TE-011 | — | Expected | NITF 1.1 is refused with a named header error. |
| TE-047 | S3 | Verified | A valid 4607 file with no dwell segment (mission + free text/test status, processing history, or platform locations only) opens as a silent no-op. |
| TE-048 | S2 | Verified | An ENVI header with `map info = {UTM, …, 15, North, North America 1983}` and a WKT `coordinate system string` opens without georeferencing: "map info: ENVI map info \"UTM\" is not read". |
| TE-049 | S3 | Verified | Auto Enhance after a band preset puts the header's default bands back: Colour Infrared + Auto Enhance and Natural Colour + Auto Enhance render byte-identical images. |
| TE-050 | S4 | Verified | With metadata imported from a platform CSV, the HUD and status bar still say "KLV time: legacy UTC" and "KLV frame model". |
| TE-051 | S3 | Fixed | CCD accepts a pair that cannot be coherent, with no warning. Grazing 50.01° vs 49.32° gives B⊥ ≈ 8.0 km, a height of ambiguity of 0.83 m and 64 % range-spectrum overlap, so coherence is at the estimator floor everywhere. The plan's "≥ 0.8 in stable areas" therefore cannot be shown on the corpus pair, because the numpy reference finds no stable area; "≤ 0.4 in disturbed areas" holds. The app's affine warp also leaves a 6.2 px tie RMS where the reference's terrain-following offsets span 21 × 11 px. |
| TE-052 | S2 | Verified | Change Detection refuses the real WV3 pair in either date order: "Change detection failed: 4137×4137 samples are more than the terrain loader takes (16 M)". Both dates are read whole through the 16 M-sample grid reader, and the message names the terrain loader. |
| TE-053 | S2 | Verified | The GeoTIFF's internal mask band is ignored (GDAL mask flag PER_DATASET, no nodata tag, 36 % fill). Fill pixels therefore count as data, which pulls the robust threshold down from 317.7 to 199.7 DN. Gain and offset match numpy (0.8918 / −82.97 vs 0.8918 / −82.85), but the candidates (803 vs 944) and their box cover (IoU 0.35) do not. Counting the fill as data in numpy reproduces the app's threshold (199.2). |
| TE-054 | S2 | Verified | Brightness Temperature cannot be reached on Landsat as delivered (one GeoTIFF per band). On B10, msi.thermal warns "brightness temperature needs radiance; the band is DN (Radiometric Conversion first)", and Radiometric Conversion is disabled on a single-band layer. Through the API (MTL radiance with bandMap [10]) the radiance is correct, but `brightnessTemperature` looks K1/K2 up by image band 1 instead of the MTL band. It then falls back to Planck with no band centre and returns NaN for every pixel. |
| TE-055 | S4 | Fixed | Aspect is measured from true north (the shader adds the grid-north angle); gdaldem measures it from grid north. On this UTM crop they differ by the meridian convergence (−0.35°), so only 88.3 % of posts are within ±0.5° of gdaldem as delivered. Against gdaldem turned to true north, 100 % are (p99 0.27°). Hillshade (99.8 % within 1 DN) and slope (100 % within 0.1°, p99 0.06°) agree. The UI does not say which north is used. |
| TE-056 | S3 | Verified | TOA reflectance from the MTL/MTD is exact: \|Δ\| = 0 on Landsat B4/B5 and S2 B04, and NDVI from the app's TOA bands is within 6e-8. It is reachable only through the API, though. On these products each band is its own single-band layer, Radiometric Conversion and Band Math need ≥ 2 bands (both disabled), and no command stacks band files, so neither TOA nor NDVI can be produced from the ribbon. |
| TE-057 | S2 | Verified | Reading a 512² window of the second Sentinel-2 L1C band (`app.msi.cube`) traps in WebAssembly with "unreachable"; the first band (B04) reads exactly. As a result, the S2 TOA/NDVI check fails in both browsers. |
| TE-058 | S3 | Fixed (target: OD-08) | Maximum likelihood reaches OA 0.497, κ 0.352 (minimum distance 0.463, SAM 0.477), against the plan's ≥ 90 %. The app's κ equals an independent κ from its label map to 4 decimals. Full-dimension ML on 220 bands with 244–1234 training pixels per class is ill-conditioned (scikit-learn QDA with reg 0.1: OA 0.490). The references do better (LDA 0.832, RBF-SVM 0.892), but none reaches 90 % on this split. |

## 4. Improvements

| IMP | Improvement | Before → after | Status |
|---|---|---|---|
| IMP-01 | Standalone JP2/J2K reader (GeoJP2, GMLJP2), lazy decode: coarse pyramid levels from the codestream's reduced resolutions, full resolution only on zoom | S2 L1C band: refused → 25 s → **0.42 s** first display | Done |
| IMP-02 | Strided coarse levels for uncompressed NITF/SICD; row-band cache for striped GeoTIFF | SICD 953 MB: 118 s → **3.4 s**; striped WV3: 31.9 s → **9.7 s** | Done |
| IMP-03 | Raster tile pyramids read: finest level within 64 Mpx, cropped to the gpkg_contents extent, opened as a georeferenced image (PNG + world file + CRS); tiles-only files no longer fail on the missing gpkg_geometry_columns table; gridded coverages refused by name | refused/silent → opens (GDAL sample, NGA conformance tiles, 3857, Denver, WebP elevation) | Done |
| IMP-04 | Uncompressed striped GeoTIFF: coarse levels from strided row reads (every 2^L-th row's span), like raw NITF | 537 MB striped WV3 first tile: 7.5 s → **0.69 s** (pixels identical to full-resolution reads) | Done |
| IMP-05 | `build.mjs --out <dir>` (documented, never implemented) | — | Done |
| IMP-06 | Debug-profile gate matches shipped behaviour: laz debug-assertions off in dev; viewshed timing asserted in release only | `npm run test:rust` red → green (166 pass) | Done |
| IMP-07 | DigitalGlobe/Maxar .RPB → RPC model (with .TIL tile offset) | no model → RPC00B model | Done |
| IMP-08 | Clouds without a CRS open in a local metric frame | refused → opens with warning | Done |
| IMP-10 | `build/traceability.mjs` reports each requirement's last pass/fail from the Playwright/Vitest JSON reports, plus PT/SCN/AT/PRF/TE family counts (SDP §8 "last result") | citations only → last results + Must-without-passing list | Done |
| IMP-11 | Gridded coverages (2d-gridded-coverage): 16-bit PNG and float TIFF tiles with table and tile scale/offset, opened as float GeoTIFF heights, clipped to gpkg_contents as GDAL does | refused by name → opens; 1114×656 and 1280×768 as GDAL; corners within 2 nm | Done |
| IMP-12 | NAD83 / UTM 1N–23N (EPSG:26901–26923) built in as exact transverse Mercator instead of a fitted polynomial | fitted residual 0.17 m → exact | Done |
| IMP-13 | glTF/GLB dropped or opened with other files goes to the 3D view; external .bin and textures resolve to blob: URLs | refused → imported | Done |
| IMP-14 | Georeference RPF frames from the coverage section (exact outer corners) and project polar ARC zones 9/18 exactly (azimuthal equidistant on the ARC sphere, a core map CRS) | 92–602 m and 185 km (polar) → **0.000 m** vs GDAL on all 5 frames | Done |
| IMP-15 | Country-scale vectors: a named size guard (512 MB, 256 MB zipped) instead of a page hang; streaming large GeoPackages through a range-read SQLite VFS is OD-07 | > 900 s hang → refused by name in ~1 s | Done (guard); streaming → OD-07 |
| IMP-16 | Complex TIFF (SampleFormat 5/6: CInt16, CInt32, CFloat32) read block by block and shown with the SAR bands (amplitude, phase, I, Q, power) | refused → opens (Capella SLC 1871×5026, RPC within 0.01 px) | Done |
| IMP-17 | Two-dimensional T.4 (Modified READ) decoding | refused → decoded, matches GDAL | Done |
| IMP-09 | Projected (non-WGS84) GCPs converted through the CRS instead of refused | refused → model | Done |
| IMP-18 | Tie-point matcher: stage-2 cell margin, 9 in-bounds stage-1 candidates, rejection statistics; Stereo Align on an 8×8 grid at NCC 0.65 | WV3 multi-date pair: 1 → 14 tie points | Done |
| IMP-19 | SMRF opening with PDAL's diamond structuring element; DTM posts as the cell mean | 3DEP DTM RMSEz at USGS ground: 0.43 m → **0.128 m** (AT-14.x 0.15 m) | Done |
| IMP-20 | Read quantized-mesh layers in Web Mercator (EPSG:3857 TMS, as written by tin-terrain), not only EPSG:4326 | `terrain-qmesh-heremaps-examples` (241 real tiles): refused by name ("EPSG:4326 only") → — | Proposed |

## 5. Traceability

348 requirements (R0, R1, R2, R3): last results 324 passing, 18 passing (file), 1 cited, no result in the reports, 5 failing. Must requirements without a passing result: 2.

## 6. Failures still open at report time

**phase3-gaps**

- [chrome] TE-C22 REQ-MSI-08 REQ-MSI-10 Indian Pines maximum-likelihood classification vs delivered truth (OA ≥ 90 %, κ to 3 decimals) — Error: maximum-likelihood OA (sklearn refs: lda 0.832, qda_reg0.1 0.490, svm_rbf 0.892)
- [edge] TE-C22 REQ-MSI-08 REQ-MSI-10 Indian Pines maximum-likelihood classification vs delivered truth (OA ≥ 90 %, κ to 3 decimals) — Error: maximum-likelihood OA (sklearn refs: lda 0.832, qda_reg0.1 0.490, svm_rbf 0.892)

**phase8-e2e**

- [chrome] REQ-PRF-06 a 4k × 4k DSM in 60 s or less in the workers and 10 s or less with WebGPU — Error: expect(received).toBeLessThanOrEqual(expected)
- [chrome] REQ-PRD-09 REQ-PRD-12 PowerPoint template import; animated GIF and a video clip from FX-10 in the HTML report and in PPTX slides — Error: frame.evaluate: Error: the browser recorded no video


