# GIS Workbench 1.2 — Field-Data T&E Campaign (phase F)

| | |
|---|---|
| Status | Executed 2026-10-27/28 on branch `te-field-data` (release 1.2.1); results in [TE-report.md](TE-report.md) §2F |
| Scope | `dist/gis-workbench.html` 1.2.x on the imagery a first user supplied (`Research/Additional Data Samples`) |
| Basis | [TE-master-plan.md](TE-master-plan.md) (phases, findings loop, exit criteria), `Docs/PRD.md`, Appendix A |
| Registers | [Findings](TE-findings.md) (phase **F**, TE-059 on) · [Improvements](TE-improvements.md) (IMP-21 on) · [Owner decisions](TE-owner-decisions.md) (OD-09, OD-10) · [MrSID spike](../design/mrsid-spike.md) |

## 1. Purpose

The user's deliveries reach formats and packaging the 117-item corpus never exercised: MrSID MG3 mosaics, `.sdw` world files, DigitalGlobe NextView ZIPs of ZIPs, Pléiades DIMAP volumes in ZIPs (with GML masks), big-endian JPEG/YCbCr GeoTIFF tile sets without overviews, multi-date commercial ortho stacks, and airborne dual-pol SAR intensity georeferenced by GCPs. This campaign tests every function those files can reach, fixes what breaks, measures and optimises, and implements the gaps, on the existing T&E machinery.

## 2. Owner decisions (2026-10-27)

- MrSID: a time-boxed native-decoding **spike** → report and OD-10.
- ZIP deliveries: **implement** opening imagery from ZIPs; the unpacked copies are tested too.
- Baseline: 1.2.0 committed (`1d5e775`); fixes on `te-field-data` as **1.2.1**.
- Standing: OD-02 (fix everything; out-of-scope improvements get REQ rows) and the master plan's §2 hard constraints.
- Licence (OD-09, proposed): user data is test-only, referenced in place, never bundled, committed or used in marketing.

## 3. Test data (tier U)

Registered by `build/campaign/field.mjs` → `sources/field.json` → `corpus.json` (22 items, 229 files, SHA-256 pinned by `fetch.mjs --verify --lock`). Originals stay in `Research/Additional Data Samples` (`origin: field-data`, resolved by `corpus-lib.mjs` `FIELD`); ZIP packages are also unpacked into `TE-corpus/<id>/` (`origin: field-extract`).

| Item(s) | Profile | Exercises |
|---|---|---|
| `field-phr-millerovo` | 4 dates of Pléiades PMS ortho, 13375×12835 RGB u8, uncompressed strips, UTM 38N | strided I/O, change detection over 32 M px, compare |
| `field-dg-panama` | 12 DigitalGlobe tiles ≤16384², JPEG/YCbCr 512² tiles, big-endian, no overviews | decode, colour, pyramid speed, virtual mosaic |
| `field-dg-spratly-zip` + 14 `field-dg-spratly-<reef>-<date>` | NextView ZIP of 14 deflated reef/date ZIPs: R×C JPEG tiles, browse, tile and seamline shapefile ZIPs | ZIP of ZIPs, multi-date change (island building), vector overlays |
| `field-phr-dimap-zip` + `field-phr-dimap` | Pléiades DIMAP v2 volume: 654 MB deflated 4-band u16 TIF, TFW, DIM XML, 7 GML masks, previews | deflated streaming, DIMAP metadata, GML |
| `field-intermap-sar` | HH/VH/VV 12000×6227 float32, 4 GCPs, no geotransform | float display, GCP model, Layer Stack, σ⁰ dB |
| `field-mrsid-hamilton`, `field-mrsid-stlouis` | MrSID MG3, 10.7 GB and 2.6 GB, `.sdw`, FGDC / PAM sidecars | recognition, refusal, spike |

Oracles: GDAL/OGR via `oracles/truth.py` (raster, vector), pyproj, geotiff.js reading the files' own values in Node. MrSID has no oracle pixel truth (H-16).

## 4. Phases

| # | Phase | Spec(s) | Exit |
|---|---|---|---|
| 0 | Entry | baseline `ci:fast`, corpus registration and pins, oracle truth | done; baseline found TE-059 |
| 1 | Ingest | `c01-ingest` (tier U included), `tests/e2e/field-formats.spec.js` | every file opens or is refused by name; size/bands vs GDAL |
| 2 | Functional | `c02…c17` with `TE_ITEMS=field` (`matrix-runner.js` field mode: 85 commands runnable on field data, rotated across items) | no errors; refusals named |
| 3 | Accuracy | `c20` (corners of every field GeoTIFF vs GDAL, automatic for tier U), `c43` W3/W5 | ≤ 0.5 px (map), ≤ 1 px at GCPs, dB ≤ 1e-3 |
| 4 | Workflows | `c43-field-workflows` W1–W5 | all pass |
| 5 | Non-functional | `c44-field-perf`, `c19` | no tile/statistics timeouts; times logged |
| 6 | Close-out | `run-final.sh`, `ci:full`, `report.mjs --notes` | master plan §8 exit criteria |

Runner: `TE-tools/run-field.sh [truth|ingest|field|sweep|perf]` on a frozen build (`node build/build.mjs --out dist-te`; `TE_DIST`), logs `TE-tools/field-<phase>.log`, summaries `reports/campaign/pw-field-<phase>.json`.

## 5. Findings and improvements loop

As master plan §6: each defect is logged (`TE-nnn`, phase F), root-caused, fixed in `app/src` / `crates/` / `build/`, regression-tested with a title carrying its id, gated (`ci:fast` → specs → `ci:full` → size/licence), and closed only by a passing re-test. Third-party defects are fixed at build time in `build/vendor-fixes.mjs` (the build fails when the patched text changes). Synthetic fixtures that reproduce field defects without the licensed data: `build/fixtures/fxbigendian.py`, `fxfield.mjs` → `fixtures/formats/te06*`.

## 6. Exit criteria

Master plan §8, plus: every field file opens or is refused by name; every raster-applicable command exercised on at least one field item; OD-09 and OD-10 presented to the owner.

## 7. Outcome (2026-10-28)

- **Findings:** TE-059 … TE-069 (2 × S1, 5 × S2, 4 × S3), all Verified. **Improvements:** IMP-21 … IMP-25 done (REQ-FMT-20, REQ-FMT-21, REQ-EXT-30 added).
- **Final regression on the 1.2.1 build** (`run-final.sh`, Chrome + Edge, field items included): ingest 1270 passed; accuracy 550; workflows/products 36; non-functional 66; functional sweep 882; live 24; golden suites pass; 0 failures. Field: workflows 5/5, field sweep 136/136, performance 10/10. E2E suite 521 passed, 1 failed (the pre-existing headless video-export failure, open since 1.2.0), 2 skipped.
- **Open for the owner:** OD-09 (licence of the field data) and OD-10 (MrSID: refusal now, a footprint-and-metadata layer as a next-release Should).
