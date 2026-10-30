# T&E format × function cross: findings (2.0.4 campaign)

The 2.0.4 campaign crosses every primary file of the T&E corpus with every command the app enables for it (`tests/campaign/c50-cross.spec.js`), plus corpus pairings (c51), pointer tools (c52), writer round trips against GDAL/OGR/laspy (c53), values against oracle truth (c54), performance budgets (c55) and damaged files (c56). Counts and the format × command table are in `TE-cross-report.md` (`build/campaign/triage.mjs`).

The status of each finding is one of: **Fixed** (the cells re-run clean on a later build), **Harness** (a test-side defect, corrected in the harness), or **Limit** (by design or out of scope, with the reason).

## Readers and writers

| ID | Finding | Status |
|---|---|---|
| CX-001 | FlatGeobuf and GeoParquet were written by Convert but refused on opening. | Fixed: `vector/columnar.js` reads both (flatgeobuf stream path, which also copes with GDAL's unaligned features; hyparquet with WKB, Snappy/GZIP/none, GeoParquet `geo` metadata, Parquet GEOMETRY logical type, PROJJSON/WKT/`srid:` CRS). 17 GeoParquet and 16 FlatGeobuf corpus files open; a 12-byte stub, empty files, a Json column holding plain text and a Triangle-only file are refused by name. |
| CX-002 | NITF 1.1 files were refused at the version check. | Fixed: headers use the 2.0 layout, with free-form user-defined data; image subheaders have an 80-character ISORCE and no NROWS…PJUST, so the size comes from the block counts. U_0001b/c and U_0005a open; U_0001a's ARIDPCM images are refused by name. |
| CX-003 | NITF IC=C5 (lossless JPEG) was refused. | Fixed: SOF3 decoding in `gw-codec` (predictors 1–7, point transform, restart intervals; bit-exact on synthetic streams). The NTB sample ns3437a renders. |
| CX-004 | REQ-FMT-07 says DTED and SRTM HGT are written; only DTED was. | Fixed: Save DEM As writes SRTM HGT 1″ and 3″ tiles (`formats/dem-writers.js`). |
| CX-005 | REQ-FMT-17 (HTJ2K) is decode-only; the encoder and the HTJ2K pyramid cache were never built. | Limit: decoding is verified (OpenJPH streams, bit-exact); an encoder is not bounded work for 2.0.4. Listed in the release's known limits. |
| CX-006 | ARIDPCM (IC=C2) remains undecoded. | Limit: refused by name. |

## Defects

| ID | Finding | Status |
|---|---|---|
| CX-010 | The first frame after any display filter (Sharpness, smoothing, median, morphology, edges, speckle) took up to two minutes: the filtered shader inlined every filter family into each resampling tap, and D3D's compiler stalled (GUI-027 had put it down to software GL). | Fixed: one shader variant per filter family and per one- or three-band output. First USM frame 117 s → 1 s; speckle 56 s → 0.7–2.3 s; later frames about 10 ms. |
| CX-011 | After a timed-out or crashed job, every later operation on that file failed with "reopen the file". | Fixed: the pool asks the app to reopen the file in a fresh worker and the job continues (`recoverHandle`; e2e PT-05b). |
| CX-012 | Validate Features ran past its 300 s timeout on Natural Earth countries (quadratic segment tests). | Fixed: 2D segment grids for polygon overlap and self-intersection, a y-bucketed ring index for point-in-ring tests. 258 countries in 16 s. |
| CX-013 | LAS and LAZ export of a 7.3 M-point cloud trapped at the 1 GiB worker memory; a 36.7 M-point 3DEP tile could not fit at all. | Fixed: the writer keeps one copy of the points; modules grown past 384 MiB are re-instantiated between jobs; clouds over 3 M points are written in slabs of whole LAZ chunks (bytes identical to the one-piece writer, Rust test `te_chunked_write`). 7.3 M points: LAS 220 MB in 1.8 s, LAZ 103 MB in 6.8 s. 36.7 M points: LAS 1.1 GB in 5.3 s, LAZ 459 MB in 20 s; laspy reads both with the source's counts, classes, returns and intensities. |
| CX-014 | PCA, MNF, ICA, the RX/GMM detectors and the classifiers returned NaN on cubes with all-NaN bands (EnMAP, Hyperion water-vapour bands). | Fixed: bands flagged bad or non-finite in most pixels are left out (`usableBands`); target spectra and endmembers follow. |
| CX-015 | Point-cloud grids (DSM, DTM, nDSM, extraction, ground filter) used a 1 m (0.5 m) post spacing whatever the density: a COPC root of 1 065 points over 4 km became 15–62 M empty posts and ran for minutes. | Fixed: the default spacing follows the mean point spacing; over 40 M posts is refused with the spacing to use. |
| CX-016 | Using a DEM over 25 M posts as terrain was refused (a 1/3″ 3DEP tile is 10 812²). | Fixed: loaded at every Nth post, with the step in the message. |
| CX-017 | GeoPackage tile sets kept the padding of the last tile column (a black strip; statistics biased toward 0). | Fixed: clipped to `gpkg_contents` when it shares the matrix SRS, as GDAL does. |
| CX-018 | The app's own Save As ▸ Shapefile ZIP and chip ZIPs reopened with errors (the field-name map, the export report and the chip record read as CSV and GeoJSON). | Fixed: companions are recognised and left out. |
| CX-019 | 3D export of a Microsoft footprints tile overflowed the call stack (`Math.min(...array)` over every building). | Fixed: loop-based `minOf`/`maxOf` wherever the array can hold one entry per feature, vertex or sample. |
| CX-020 | Band Math statistics of a 4-band NAIP tile ran past 120 s: the cube read every full-resolution row to keep one in 20. | Fixed: statistics cubes sample the pyramid level of their step. |
| CX-021 | The Gridded Reference Graphic's 100 m default cell made 100 000+ cells over a 1° DEM and failed. | Fixed: the default steps up (1-2-5) to stay within the cell limit. |
| CX-022 | Chip by Preset Area, Auto Map and Snapshot to KMZ were enabled on images with no geolocation, then failed. | Fixed: they need a sensor model. |
| CX-023 | SAR anamorphic display was enabled for complex GeoTIFFs, which have no SICD grid spacings. | Fixed. |
| CX-024 | FMV frame capture was enabled for MPEG-2 video, which the browser cannot decode. | Fixed. |
| CX-025 | Ortho On-the-Fly was enabled by any RPC image in the panel but refused when the active layer was another kind. | Fixed: it falls back to the panel's first RPC image. |
| CX-026 | Jump To a point off the image logged a console error and an error toast. | Fixed: a warning naming the point. |
| CX-027 | AOI from Graphic crashed when the graphic does not project onto the image. | Fixed: a warning. |
| CX-028 | Measure ▸ Centre Point crashed with only vectors open. | Fixed: the ground centre is reported. |
| CX-029 | Opening 3D with a terrain entry that covers none of the view meshed NaN heights (THREE error). | Fixed: refused by name. |
| CX-030 | The 3D globe failed when the image model could not place the terrain. | Fixed: terrain shown undraped, with the reason. |
| CX-031 | Target and anomaly detection crashed (`toPrecision` of undefined) when no score was finite. | Fixed: refused by name. |
| CX-032 | The eigenvalue chart drew NaN rectangles. | Fixed. |
| CX-033 | The MIE4NITF player kept firing after its panel or frames went, throwing on every tick. | Fixed: it stops itself. |
| CX-034 | The Workspace preview crashed for a layer an undo had taken out of the store. | Fixed. |
| CX-035 | A point-cloud grid finishing after its panel closed raised a raw error. | Fixed: named. |
| CX-036 | The Rust point grid's limit message read "grid: size". | Fixed: posts, spacing and the advice. |

## Harness

| ID | Finding | Status |
|---|---|---|
| CX-H01 | The sweep's pass rule accepted "dialog", "pending" and "disabled"; records were keyed by command only; downloads were never checked. | Harness: c50 judges effect, timeouts, worker-job errors, downloads (signatures) and network per cell, keyed by file and command. |
| CX-H02 | Toasts waiting behind the 3-slot snackbar were attributed to the next command. | Harness: the app keeps `toastLog` (as issued); the engine reads it. |
| CX-H03 | Slider and option commands do their work through `setValue`. | Harness: every enabled option and the slider are driven; disabled options are skipped. |
| CX-H04 | The gw-te Python run outside micromamba could not load MKL (numpy.linalg) or GDAL's data. | Harness: `Library/bin` on PATH, `GDAL_DATA`, `PROJ_DATA` for the c53 oracle. |
