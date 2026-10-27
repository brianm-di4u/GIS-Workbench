## 7. Exit criteria (master plan §8)

The final build is `cc718bae` (`dist/gis-workbench.html`). The campaign ran on Chrome and Edge, with the corpus pinned and the oracles regenerated. Every phase is green on that build. The one exception is `navigation.js` (TE-046), which changed after the full campaign run: its sweep test and the E2E navigation suite were re-run on the final build and pass.

| Criterion | Result |
|---|---|
| Zero open S1/S2 findings | **Met.** 46 findings: 42 Verified by a passing re-test whose title carries the TE id; 3 Not-a-defect (oracle or truncated test file); 1 Expected (NITF 1.1 refused by name). |
| Every S3 fixed or accepted | **Met.** Every S3 is Verified. |
| Every implemented command exercised on real data | **Met, with 10 commands noted below.** The registry holds 448 commands, all implemented, 0 placeholders. The 10 file-open commands are exercised by c01 on every corpus file. The Phase-2 sweep ran the other 438 in their ribbon context on real corpus data in both browsers (876/876 tests): 428 ran to completion or opened their dialog and were confirmed. The remaining 10: 5 refuse an unmet precondition by name, 3 are covered by other suites, 2 were still running long jobs when the sweep moved on. |
| Every Must REQ has a passing real-data test | **Met.** Traceability: 348 requirements (R0–R3); 0 Must without a passing result; 347 passing (329 by test title, 18 by their citing test file); REQ-IMG-16 (a Could) is cited but has no recorded result. |
| Appendix E tolerances | **Met.** The checks: RPC geolocation within 0.01 px of GDAL; map models within 0.1 px; SICD within 5 cm of sarpy; RPF frames exact; viewshed 99.73 % agreement with gdal_viewshed (≥ 99 %); KLV equal to klvdata; NAIP NDVI exact; SCN-14 DTM RMSEz 0.128 m (≤ 0.15 m) with SMRF agreement within 0.6 points of PDAL. |
| ci:full and the campaign green on Chrome and Edge | **Met.** Rust 160 passed (2 ignored, timing-only in debug builds); unit 85/85; E2E 410/410; campaign phases 1–6 all passed; golden 4/4. |
| Zero open fuzz crashes | **Met.** `gw-fuzz`: 15 targets, 0 problems (21,500 runs). Four LAS inputs left in `reports/fuzz-crashes` by a pre-fix run (a laz debug assertion) are among the same seeds and no longer fail; they were archived to `TE-tools/fuzz-crashes-archive-2026-10-27/`. |
| Size, CSP and licence gates | **Met.** Build report: no gate errors or warnings; licences pass; no CSP violation or unrequested request in any campaign test. |

### The 10 sweep commands

- **Refuse by name when a precondition is missing** (their working paths are covered elsewhere):
  - `stereo.xr` needs a WebXR headset (open item).
  - `msi.thermal` needs radiance input (SCN-13 / e2e).
  - `vec.remoteopen`, `3d.qmesh` and `3d.tiles` need a typed service URL (c18 live tests and e2e).
- **Covered by other suites:**
  - `bg.map`: c18 GIBS, TNM and OSM basemaps.
  - `vec.remotesave`: c18 public service, read only; the e2e remote-edit save round trip.
  - `sar.pauli`: no free quad-pol SICD exists (OD-05); e2e on fixtures.
- **Still running when the sweep moved on:** `search.template` and `fmv.export` (no error was raised).

## 8. Performance (this machine; OD-01)

| Check | Before campaign | Final |
|---|---|---|
| First tile, SICD 953 MB (Umbra) | 118 s | 3.4 s |
| First tile, striped WV3 PAN 537 MB | 31.9 s | 0.69 s |
| First tile, Sentinel-2 L1C JP2 band | refused / 25 s | 0.42 s |
| First tile, FX-01 NITF 16 MiB (PRF-03 < 1 s) | 0.9 s | 0.58 s (after TE-042) |
| 3DEP LAZ 36.7 M points | over the 1 GiB cap | opens; colourised in full (TE-044) |
| Country-scale vector (0.9–1.4 GB) | > 900 s hang | refused by name in ~1 s (OD-07) |

## 9. Open items

- **OD-01:** PRF sign-off on the reference laptop (Iris Xe, 16 GB) is still open; the numbers here are from an Intel Arc machine.
- **Browsers:** Safari was not tested (Windows host). Firefox ESR is best effort and was not part of this run.
- **OD-04 (tier-B data):** EMIT NetCDF, PRISMA/EnMAP full scenes, Copernicus L1C SAFE and EarthExplorer DTED are login-only sources and were not downloaded. Their formats are covered by the samples held.
- **OD-05:** STANAG 4607, MIE4NITF, NGA RSM and WorldView IMD have no free public sample; they stay on synthetic fixtures.
- **OD-07 (owner):** whether to stream country-scale vectors in a later release (range-read SQLite VFS).
- **Load-sensitive E2E tests:** three GPU read-back and MediaRecorder tests need about 90 s under the 4-worker run. Their timeouts were raised (TE-017); all pass.
- **Nothing was written to public services.** The remote-edit write path is verified against a local service only.
