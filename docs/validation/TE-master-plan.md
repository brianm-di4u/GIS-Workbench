# GIS Workbench — Live Test & Evaluation (T&E) Master Plan

| | |
|---|---|
| Status | 1.0, ready to execute when the SDP closes (Part A built 2026-10-26) |
| Scope | The completed product (`dist/gis-workbench.html`, the Lite build, the embed kit, the data packs) after R3 |
| Basis | `Docs/PRD.md`, `Docs/SDP.md` §7–8, Appendix A (requirements), Appendix E (acceptance tests) |
| Registers | [Findings](TE-findings.md) · [Improvements](TE-improvements.md) · [Owner decisions](TE-owner-decisions.md) · [Data catalogue](TE-data-catalogue.md) · Coverage matrix `reports/campaign/matrix.md` |

## 1. Purpose

R0–R2 validation passed, but mostly on synthetic FX fixtures and 41 public samples from the R1 era. This campaign exercises **every implemented command on real, free, public GIS data in its native format**. It checks the results against **independent open-source oracles**, then fixes, optimizes and improves the product while it runs.

Gaps it closes:
- The R2/R3 formats have never run on real data in the browser.
- `reports/e2e.json` has no results to use as a baseline.
- Traceability only checks that a test cites a requirement, not that it passes.
- S-15 (`gdal_viewshed`) and the RSM and usgscsm comparisons have never been run.

## 2. Owner decisions in force

See [TE-owner-decisions.md](TE-owner-decisions.md).
- The corpus budget is about 20 GB.
- The campaign may **fix everything it finds**, including out-of-scope improvements. Each out-of-scope improvement gets a new REQ row.
- PRF results are measured on the dev machine (Intel Arc) and with SwiftShader. Reference-laptop sign-off (O-14) stays open.

**Hard constraints no improvement may relax without an owner decision:**
- single-file delivery and offline-first operation
- the ARC-03 size gates
- strict CSP and no unrequested network traffic (SEC-01/12)
- the licence policy (SEC-08, RUST-11)
- the WASM memory caps

## 3. Assets (built in Part A)

| Asset | Path | Use |
|---|---|---|
| Corpus manifest | `build/campaign/corpus.json` (`make-corpus.mjs` merges `sources/*.json` with the held `Research/samples`) | One entry per item: source, licence, tier, format and profile, files with pinned SHA-256, the areas it feeds |
| Fetcher | `node build/campaign/fetch.mjs [--dry] [--lock] [--verify] [--only] [--area]` | Resumable and budget-checked; signs Planetary Computer URLs; pin-on-first-fetch; writes `SOURCE.txt` per item and `reports/campaign/corpus-status.json` |
| Corpus | `C:\GIS Workbench\TE-corpus\<id>\` (override with `TE_CORPUS`) | Untrusted data: no scripts inside, every reader runs with `python -I` |
| Oracle environment | `build/campaign/environment.yml` → `gw-te` via `../TE-tools/micromamba.exe` | GDAL 3.13, PDAL 2.10, sarpy 2.1, SARkit 1.12, laspy + lazrs, klvdata, pyproj, GeographicLib, ffmpeg, python-pptx/docx, pypdf, scikit-learn, openjdk |
| Oracles | `build/campaign/oracles/truth.py` (raster, sar, lidar, vector, fmv, geodesy) | Writes `TE-corpus/_truth/<id>.json` and `_geodesy.json` |
| Coverage matrix | `node build/campaign/gen-matrix.mjs` | command × ribbon context × eligible corpus × check, in `reports/campaign/matrix.{json,md}` |
| Browser harness | `playwright.campaign.config.js`, `tests/campaign/c00…c19-*.spec.js`, `helpers.js`, `matrix-runner.js` | Chrome and Edge; Firefox for tests tagged `@best-effort`; results go to `reports/campaign/results/*.json` |
| Node accuracy suites | `vitest.campaign.config.js`, `tests/campaign/golden/*.test.js` | Shipped WASM vs oracle truth, no browser |
| Data catalogue | `node build/campaign/catalogue.mjs` → [TE-data-catalogue.md](TE-data-catalogue.md) | |

**Run order:**
1. `make-corpus`
2. `fetch --lock`
3. `truth.py`
4. `c00-registry`
5. `gen-matrix`
6. the campaign specs and golden suites
7. `catalogue`

## 4. Test data

All data is free and public. Every item records its licence and attribution, and corpus data is used for testing only, never bundled with the product. The full list is in [TE-data-catalogue.md](TE-data-catalogue.md).

| Area | Representative real data |
|---|---|
| NITF/NSIF | JITC/NTB conformance set (GDAL data server), GDAL autotest NITF, CADRG/CIB RPF |
| EO with RPC | IARPA MVS WorldView-3 stereo, SpaceNet WV3 pan/MS, Maxar Open Data |
| Multispectral | Landsat 8/9 C2 L1 with MTL, Sentinel-2 L1C JP2 with MTD and L2A COG, NAIP 4-band |
| SAR | Umbra SICD/SIDD/GEC/CPHD and repeat-pass pairs, Capella, ICEYE |
| Hyperspectral | AVIRIS ENVI, EMIT NetCDF (tier B), Indian Pines, USGS splib07 |
| DEM | Copernicus GLO-30/90 COG, USGS 3DEP 1/3″ and 1 m, SRTM HGT, DTED |
| Lidar | USGS 3DEP LAZ (LAS 1.4 PDRF 6), PDAL/laspy version matrix (PDRF 0–10), Autzen COPC |
| FMV | FFmpeg MISB samples, ImpleoTV KLV set (including damaged streams), jmisb/klvdata vectors |
| Vector | Natural Earth 10m, TIGER/Line, USGS NHD GeoPackage, OSM extracts, OGC GPKG and KML samples |
| 3D | Khronos glTF samples, Cesium 3D Tiles samples, CityJSON |
| Products | USGS US Topo GeoPDF |
| Live services | NASA GIBS, USGS TNM WMS/ArcGIS REST, OSM tiles, Esri editable sample feature service, NGS NCAT/geoid APIs |

**Synthetic only:** STANAG 4607 (FX-11), MIE4NITF, NGA RSM and WorldView IMD have no public sample. The FX fixtures cover them, and the report flags this.

## 5. Phases

| # | Phase | Spec(s) | Exit |
|---|---|---|---|
| 0 | Entry | — | See §5.1 |
| 1 | Ingest conformance | `c01-ingest` (all items), `c19` run modes | Every file opens or is refused by name; metadata matches GDAL/sarpy/laspy/OGR truth |
| 2 | Functional coverage | `c02…c17` matrix sweep (`matrix-runner.js`) | Every implemented command runs on real data in its context with no errors; placeholders say "planned" |
| 3 | Accuracy | Oracle tests in each area spec plus `golden/*` | Every Appendix E tolerance met; see §5.2 |
| 4 | Analyst workflows | SCN-01…20 on real data (new `cNN-scn-*` specs) | All scenarios pass; every product re-opens in the app and in its oracle |
| 5 | Live services | `c18-live` | Allow-listed paths work; nothing leaves the machine otherwise |
| 6 | Non-functional | `c19`, `tests/tools/axe.mjs`, `gw-fuzz` | See §5.3 |
| 7 | Optimize and improve | Profiling and the improvements register | Before/after measured for each improvement |
| 8 | Regression and close-out | Everything plus `ci:full` | §8 exit criteria |

### 5.1 Entry criteria

- The SDP is closed and an R3 validation report exists.
- A clean `npm run build` passes every gate.
- `ci:full` is green, with a new E2E baseline in `reports/e2e.json`.
- Every tier-A corpus file is pinned (`fetch.mjs --verify` reports 0 failed).
- Oracle truth has been generated with `oracleErrors` reviewed.
- `c00-registry` has been dumped and the matrix regenerated.

### 5.2 Accuracy checks (Phase 3)

| Check | Oracle | Tolerance |
|---|---|---|
| UTM/UPS, MGRS truncation | PROJ (pyproj), GeographicLib; NGS NCAT live | 1 mm; ±0.5 m from cell centre |
| Geodesic distance and area | GeographicLib | 1 µm (AT ≤ 1 mm/10 km); 0.1 % |
| HAE↔MSL | NGS geoid API, PROJ EGM96 grid | ≤ 0.2 m (EGM96), ≤ 0.05 m (EGM2008) |
| RPC ground point, CE90/LE90 | GDAL RPC transformer | 95 % of points within 1 GSD; 2.146σ / 1.645σ within 1 % |
| SICD corners, round trip | sarpy, SARkit | 0.01 m; 0.05 px |
| SAR remap switch | timing | < 200 ms, no file re-read |
| Coherence (CCD) | numpy on the same pair | ≥ 0.8 in stable areas, ≤ 0.4 in disturbed areas |
| Viewshed | `gdal_viewshed -cc 0.87` | ≥ 99 % cells agree (closes S-15) |
| Hillshade, slope, aspect | `gdaldem` | ±1 DN, ±0.1°, ±0.5° |
| DTM from lidar | PDAL `filters.smrf` + 3DEP DEM | RMSEz ≤ 0.15 m |
| TOA reflectance, NDVI | numpy from MTL/MTD | ±0.01 |
| Classification | scikit-learn on Indian Pines truth | OA ≥ 90 %, κ to 3 decimals |
| KLV tags, footprint, sync | klvdata, ffprobe | tags equal; ≤ 1 m; ≤ 33 ms |
| Vector round trip | OGR; OGC GPKG ETS; DGIWG 126 | 1e-9°; pass |
| Building squaring | geometry | 90° ± 0.1° |
| Products | python-pptx, python-docx, pypdf/veraPDF, gdalinfo of written COG/NITF/DTED | Re-reads; geolocation within 1 GSD; print scale within 0.5 % |
| Ortho, triangulation | `gdalwarp -rpc` on the same DEM; checkpoints | ≤ 1 GSD; RMSE ≤ 1.5 GSD |

### 5.3 Non-functional (Phase 6)

- **Run modes:** parity across file, http, cross-origin iframe and srcdoc on real data.
- **Builds:** Lite build and embed kit parity.
- **Performance:** PRF-01…08 on the largest corpus items, on the Arc GPU and with SwiftShader. That includes the 3 M point budget on 3DEP, the 4k² DSM, the 1025² viewshed, the worker heaps and GPU memory.
- **Robustness:** `gw-fuzz` seeded from the real corpus; truncated and bit-flipped copies of every format; the ImpleoTV damaged streams. No hang, and every failure is a named error.
- **Security:** every spec asserts no CSP violations and no network requests. Banners and portion marks come from real NITF security fields. The redaction path is tested.
- **Accessibility:** axe on every dialog and ribbon tab.
- **Browsers:** Chrome and Edge are tier 1. Firefox ESR runs tests tagged `@best-effort`. Safari is untestable on Windows and logged as open.
- **Soak:** 8 hours of scripted mixed use; heap and undo-stack integrity.

## 6. Findings, fixes and improvements loop

This loop runs throughout phases 1–7.

1. **Log** a `TE-nnn` entry in [TE-findings.md](TE-findings.md) with the corpus item, command, repro, expected (oracle) vs actual, evidence and severity (S1–S4 or IMP).
2. **Root-cause and fix** in `app/src` or `crates/`. Add a regression test titled `TE-nnn REQ-…`. Small repro files are copied to `fixtures/` with provenance.
3. **Gate the fix:** `npm run ci:fast`, then the affected campaign specs, then `ci:full`, then the size and licence gates. A finding is "Verified" only after a passing re-test.
4. **Out-of-scope improvements:** implement them, add a REQ row (`Docs/tools/newreqs.mjs`), regenerate Appendix A, and record before/after in [TE-improvements.md](TE-improvements.md). Anything that relaxes a §2 hard constraint goes to [TE-owner-decisions.md](TE-owner-decisions.md).
5. **Priority:** S1 findings first; S3/S4 are batched by area.
6. **Oracle or test errors** are logged as Not-a-defect, with the harness fix recorded (see H-01, H-02).

## 7. Traceability and reporting

- Test titles carry `TE-Cnn` plus `REQ-…` / `AT-…` / `PRF-…` / `SCN-…`, so `build/traceability.mjs` picks them up.
- In scope for Phase 7: extend `build/traceability.mjs` to read pass/fail from `reports/*.json` and `reports/campaign/*.json`, and to match the PT/SCN/AT/PRF/TE families. SDP §8 requires "last result".
- Each run writes per-test JSON to `reports/campaign/results/` and the Playwright summary to `reports/campaign/playwright.json`. Golden suites write `reports/campaign/golden.json`.
- **Final report:** `docs/validation/TE-report.md`, following SDP §7.3. It contains:
  - build hash and size
  - coverage (commands exercised out of implemented)
  - the accuracy table, with each value against its tolerance
  - performance before/after
  - findings by severity and state
  - improvements implemented
  - open items: reference laptop, Safari, data with no public source

## 8. Exit criteria

- Zero open S1/S2 findings; every S3 fixed or accepted by the owner.
- Every implemented command exercised on real data (`commands.coverage()`); every placeholder either implemented or accepted.
- Every Must requirement has a **passing** real-data test.
- Every Appendix E tolerance met, or a deviation accepted by the owner.
- `ci:full` and the campaign suite green on Chrome and Edge.
- Zero open fuzz crashes.
- Size, CSP and licence gates pass.

## 9. Part A status (2026-10-26)

The detailed results of this smoke run are in §10.

- **Corpus:** the 29 held `Research/samples` items are registered with their SHA-256 values and verify clean. The new public sources are being added to `build/campaign/sources/`.
- **Oracles:** the `gw-te` environment is built. Truth is generated for every held item with zero oracle errors.
- **Matrix:** generated from the live registry of the current `dist/`. It has 442 catalogued commands: 430 implemented, 12 placeholders, and one implemented command (`packs.manage`) not placed in any ribbon or menu.
- **Golden geodesy:** 4/4 tests pass against PROJ/GeographicLib over 1,847 points.
- **What these runs are not:** they ran against a `dist/` that is still changing. They prove the harness works; they are **not** the campaign baseline.

## 11. Part B status (2026-10-27): complete

The SDP closed with R3. The campaign then ran through runs 1–3 and a final run on build `cc718bae`, on Chrome and Edge. Every phase passed. The exit criteria in §8 are met; see [TE-report.md](TE-report.md) §7.

- **Findings:** 46 raised. 42 Verified by a passing re-test, 3 Not-a-defect, 1 Expected. 14 harness or oracle defects (H-01 to H-14) were also fixed.
- **Improvements:** 19 implemented (IMP-01 to IMP-19). Streaming country-scale vectors is parked as owner decision OD-07.
- **Traceability:** 348 requirements, none of the Musts without a passing result.
- **Still open:** OD-01 (reference laptop), Safari, the tier-B login data (OD-04), formats with no public sample (OD-05), and OD-07.
