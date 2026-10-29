# T&E archive: follow-ups

These items came out of the archive expansion of 2026-10-28 (branch `te-archive`). For counts see `TE-archive-coverage.md`, and for items see `TE-data-catalogue.md`. The data is internal test data only. Items under OD-09 licences are test-only: they are never bundled, published or used in marketing.

## Coverage after the expansion

174 of 179 format keys have at least the minimum number of samples. Two role gaps remain.

| Gap | Why | Closes with |
|---|---|---|
| `rpf.cib` 0/3 | No anonymous CIB anywhere | Tier B: USGS EarthExplorer "SPOT CIB-10" (`nitf-rpf-cib-usgs`) |
| `rpf.toc` 2/3 | GDAL ships only two A.TOC files, both already held. The app does not read A.TOC (`app/src/features/dialogs.js:49`), so a crafted TOC adds little | The CIB download includes its own A.TOC from an independent producer |
| `nitf.ic.c5`, `nitf.ic.c2`, `nitf.ic.m8` 0/1 | No public sample exists: not in the GDAL autotest, the download.osgeo.org NITF mirror, JITC/NTB or six-library | Unobtainable. They are refused codecs; an encoder for a negative sample would have to be written from the spec |
| role `sar: pair:repeat-pass` | The only pair (TE-051) is incoherent | Tier B: Sentinel-1 IW SLC 12-day pair from ASF (Earthdata login), then sarpy → SICD bursts |
| role `ingest: fmt:*` | Aggregate of the format rows above | Closes when they do |

## Tier-B downloads (owner logs in; files go to `TE-corpus/<id>/`, then `fetch.mjs --verify --lock`)

**Earthdata login (account exists):**
- ASF Sentinel-1 SLC pair (repeat-pass);
- UAVSAR / NISAR quad-pol (`sar-uavsar-quadpol-tierb`);
- LP DAAC EMIT L1B/L2A Cuprite (`emit-l1b-rad-cuprite`, `emit-l2a-rfl-cuprite`), NASADEM and SRTMGL3;
- OB.DAAC PACE OCI and HICO.

**New accounts:**
- **USGS ERS:** CIB-10 (`nitf-rpf-cib-usgs`), SRTM DTED2 (`usgs-srtm-dted2-n39w106`), Landsat 8/9 C2 L1 (`landsat8-c2-l1tp-044034-20240820-tierb`), Hyperion.
- **ASI:** PRISMA L2D (`prisma-l2d-sample`).
- **DLR EOWEB:** EnMAP full scene (`enmap-l2a-full-scene`).
- **ESA:** Third Party Missions.
- **Airbus:** sample form, for a second DIMAP v2 producer plus Pléiades tri-stereo.
- **xView / xBD.**

**Forms that email a link:**
- ECOSTRESS spectral library (`hsi-ecostress-speclib-tierb`).
- IEEE US3D Jacksonville lidar (`dem-us3d-jacksonville-lidar-tierb`).

## App defects found in passing

All fixed on 2026-10-29, along with the defects the ingest smoke test found later: see `TE-archive-remediation.md` (A3–A6; the stale-report item is C-series).

| Where | Defect | Effect |
|---|---|---|
| `app/src/features/convert.js:74` | FlatGeobuf file stem uses `/[^w.-]+/g`, which is missing the backslash before `w`. The GeoParquet branch six lines above has `\w` | Every letter except `w` becomes `_` in the saved `.fgb` name |
| `app/src/features/extract.js:22` | Drop filter `VECTOR_RE` has no `json` or `gpx`, but `openVectorFiles` reads `.json` | A dropped `.json` GeoJSON is not opened as vector |
| `app/src/features/convert.js:19` vs `extract.js` `openVectorFiles` | Convert accepts `.gpx`, but `openVectorFiles` has no GPX branch | Picking a GPX in Convert opens nothing |
| `app/src/features/files.js:18` | `IMAGE_ACCEPT` leaves out `.jp2/.j2k`, `.pdf`, `.gif`, `.bmp`, `.webp` and the RPF frame extensions, which the decoder reads | These files are hidden in the Open Image picker; drag-and-drop still works |
| `build/traceability.mjs` | Sums every `pw-*.json`, including the stale `pw-field-ingest.json` | REQ-FMT-02/06/10/12/16 show as failing |
| STANAG 4676 reader | May not match schema-style `<items>` documents (seen in the GeoWave samples) | To confirm with the ingest smoke test |

## Tooling changes in this pass

- `census.py`:
  - checkpoint writes go to a temp file, replaced with a retry; a lock made a `--fresh` run die with EINVAL;
  - an A.TOC is classed before the NITF check;
  - `.gltf` is read whole, because Blender writes `extensionsUsed` last;
  - the TIFF compression tag is read without GDAL, so OJPEG negatives that make GDAL throw still get their key.
- `coverage.mjs`: a `covers` tag no longer counts as an extra sample when the census already found that key in the same item. This took the count from an inflated 175 down to 171 before the fixes above.
- `fetch.mjs`: Planetary Computer SAS tokens are renewed before expiry.
