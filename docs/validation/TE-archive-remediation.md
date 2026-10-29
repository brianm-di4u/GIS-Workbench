# T&E archive: remediation plan and record

Findings came from three sources: the archive expansion of 2026-10-28, the ingest smoke test of the 159 new archive items (TE-C01, `tests/campaign/c01-ingest.spec.js`), and the truth oracles. This page lists each finding with its cause, its fix and how the fix is verified. It is updated as items close; open items are at the end.

**Run 1** (2026-10-28, 2,252 cases) used the frozen `dist-te`. That build turned out to be **1.2.1** from the field campaign, not 2.0.x, so its 876 failures mix old-build defects, harness gaps and real findings. Runs 2 and 3 use `dist-archive`, built from the current source with these fixes, so the field campaign's `dist-te` baseline is left alone.

## A. App defects (fixed)

| # | Finding | Cause | Fix | Verified by |
|---|---|---|---|---|
| A1 | Full-size WorldView-3 J2K NITF (MVS Buenos Aires, CORE3D Jacksonville: up to 43008 × 31744, 1.37 G samples) cannot be displayed: "too large for the whole-image decoder" | C8/M8 images were decoded as one whole image, capped at 400 M samples | Tile-window J2K decoding. `gw_codec::j2k::decode_region` rewraps the intersecting tiles as their own codestream and decodes them at full or reduced resolution; the window is moved to the canvas origin because hayro reconstructs nothing at reduced resolution with an image offset. New `workers/decode/j2ktiles.js` builds a tile-part index (from TLM when present) and caches per-tile decodes. NITF C8/M8 and tiled JP2 serve every level from the tiles, with native levels down to the COD decomposition count. Reduced whole-image decodes are allowed up to 16 G source samples | `crates/gw-codec/tests/j2k_region.rs`: S2 B02 windows equal the whole decode at full resolution and at levels 1, 2 and 4, bit for bit; a WV3 strip window decodes; a reduced whole-strip decode works. Ingest run 3 |
| A2 | BPF "deflate" files refused as "compression 3 is not read (zlib only)"; FastLZ files refused | Compression codes misread: PDAL writes 0 none, 1 QuickLZ, 2 FastLZ, 3 zlib; the reader took 1 as zlib | Codes corrected; a FastLZ level 1/2 decoder added; stored blocks (compressed size = raw size) are copied; QuickLZ is refused by name | `tests/unit/points-io.test.js`: all six compressed variants and both interleaves of PDAL's chipped Autzen equal the uncompressed file |
| A3 | FlatGeobuf export file names mangled | `/[^w.-]+/g` (missing backslash) in `convert.js` | `\w` | Code review |
| A4 | A dropped `.json` GeoJSON is not opened as vector | `.json` missing from the vector drop filter (`extract.js`) | Added; app JSON files and tile-set JSON are routed first; any other JSON is refused by name: "not GeoJSON (…)" | `tests/unit/vector-io.test.js` |
| A5 | GPX selected in Convert opens nothing | `openVectorFiles` had no GPX branch | GPX → points and lines through `parseGpx`; a geometry is written 2D when it has no heights | Code review; Convert e2e |
| A6 | Open Image picker hides JPEG 2000, GeoPDF, GIF/BMP/WebP and RPF frames | `IMAGE_ACCEPT` was a short hand-kept list | The list now matches the image readers (`formats/open.js`), including RPF frame extensions | Code review |
| A7 | `.3tz`, `.pptx`/`.potx`, `.mbtiles` misrouted ("ZIP container", "GeoPackage cannot be opened") | `sniffName` renamed them by content (ZIP, SQLite) because their extensions were not in `KNOWN_EXT` | Extensions added | `tests/unit/sniff.test.js`; run 3 |
| A8 | `.3tz`, recipes (`.gwrecipe.json`), product templates (`.gwt.json`) and PowerPoint templates opened through Open or Drop did nothing or failed | They had commands but no drop or open route | `openSpecialFiles` routes each to its home; single 3D Tiles content files, `.terrain` tiles, `tileset.json`, `layer.json`, `A.TOC`, GeoParquet, FlatGeobuf and MBTiles are refused by name with the way to open them | Run 3 |
| A9 | A `.gwb` opened from the catalog, a panel or automation fails with "ZIP container" | Only the window drop handler recognised projects | `openFiles` opens a project like a drop. Projects are now logged; `relinkPick: 'skip'` lets automation skip the relink dialog | Run 3 |
| A10 | ECW, ERDAS HFA `.img` and NetCDF-3 refused as "unrecognised data" | No detection | Detected (`EHFA_HEADER_TAG`, `CDF\x01/\x02/\x05`, `.ecw`) and refused by name, with the conversion to use | Run 3 (the spec now rejects generic refusals of refused formats) |
| A11 | Draco, KTX2 and meshopt glTF fail with raw three.js loader errors | No decoders configured | Meshopt is now decoded (three.js `MeshoptDecoder` in the lazy three block). Draco and required KTX2 are refused by name before loading (`render/gltf-ext.js`), in the 3D view and in 3D Tiles | Run 3 |
| A12 | JPEG 2000 with a POC marker fails with "Marker(Unsupported)" | hayro does not implement progression order changes | Named: "a progression order change (POC marker) is not decoded in this release" (main or tile-part header) | `j2k_region.rs` `poc_codestream_is_refused_by_name` |
| A13 | BDAV `.m2ts`/`.mts` fail: "no programme tables" | 192-byte packets (4-byte timestamp prefix); the demuxer reads 188 | Repacked to plain TS in memory on open (up to 2 GB; above that, the error names the ffmpeg remux) | Run 3 |
| A14 | An MPEG program stream (`.mpeg`) is called "damaged or not MPEG-TS" | No detection | Named, with the ffmpeg remux | Run 3 |
| A15 | A JPEG/PNG delivered with its world file in a ZIP opens nothing, silently | `RASTER_IN_ZIP` had no pictures; the ZIP fell to the vector reader, which logged nothing | A picture with its world file is imagery in a ZIP (`[_-]browse` quick looks are still skipped) | `tests/unit/zip-container.test.js`; run 3 |
| A16 | A three-level ZIP delivery (`nested_deep.zip`) opens nothing, silently | `isImageryZip` looked one level down; a ZIP at the depth limit was neither expanded nor offered | Recursive probe to the expansion depth; ZIPs deeper than that are offered as packages of their own | `zip-container.test.js` |
| A17 | A ZIP with nothing readable ends with no message | No check | "the ZIP holds no vector data or imagery GIS Workbench reads (…)" | Code review |
| A18 | Spectral library CSV and ENVI `.sli` dropped go to the vector or image reader | No drop route | Routed to the spectral plot by header (a first column named wavelength) or by `.sli` with its `.hdr` | Run 3 |
| A19 | FMV metadata CSV (`SensorLatitude`/`SensorLongitude`) refused as having no coordinates | Only exact `lat`/`lon` names were recognised | Prefixed pairs are matched (with an altitude of the same prefix); the import report names the columns used | `vector-io.test.js` (866 points from the Esri tutorial CSV) |
| A20 | Detection CSV with quoted headers not recognised; a detections file opened with no image only toasts | Header sniff did not strip quotes or a BOM; no log entry | Quotes and BOM stripped; the no-image case is logged as a warning | Run 3 |
| A21 | Packs, PMTiles, projects and recipes missing from the Import Log | Toasts only | Logged like every other import | Run 3 |
| A22 | 8-band WorldView-3 MS NITF (CORE3D, 11264 × 12288 × 8) fail with "Validation(TooManyChannels)" once tiled decoding reaches them | Vendored hayro guesses a colour space from the component count and gives up above four | `GW MSI` patch: more than four components with no colour space decode as `ColorSpace::Unknown` (recorded in `VENDOR.md`) | `j2k_region.rs` `wv3_eight_band_msi_decodes`: bands 1–8 at (5000, 6000) equal GDAL's read (178, 241, 263, 121, 97, 189, 413, 269) |
| A23 | ASCII point clouds: columns proposed as 0/1/2 even when the header names them (PDAL's `"Red","Green","X","Y","Blue","Z"`); longitude/latitude guessed from the header or a `.pts` count line; a missing CRS reported as "EPSG:0 is not known" | Dialog defaults ignored the header | Columns proposed by name; the lon/lat guess uses the first data row in the chosen columns; a missing CRS is named. `asciiPick` takes `{epsg}` for automation | Run 4 |
| A24 | A CSV whose `X`/`Y` columns are projected (a point-cloud export) is drawn as features thousands of "degrees" off the globe | No range check | Out-of-range rows are skipped and counted; when every row is out of range the CSV is refused, naming the ASCII point-cloud route | `vector-io.test.js` |
| A25 | A PROJ pack dropped with a state-plane point cloud arrives too late | Point clouds were read before packs, although the code comment said packs open first | Packs open first | Run 4 |
| A26 | ERDAS HFA still refused as "unrecognised data" after A10 | The detect string held 9 characters; `EHFA_HEADER_TAG` is 15 | Compared against the first 15 bytes | Run 4 |
| A28 | glTF content with an external `.bin` inside a `.3tz` breaks the CSP ("Connecting to file:///…/simpleTriangle.bin") | Tile content was parsed with no base: relative URIs resolved against the page | External buffers and images are fetched through the tileset's own fetch (the archive, or the network log) and given to the loader as blob URLs; `data:` URIs become blobs | Run 4 |
| A29 | A `.3tz` with gzip-compressed entries fails with an empty error | The archive server returned the gzip bytes | Entries starting `1f 8b` are inflated as they are served | Run 4 (`validTilesetPackageZipped.3tz` reaches the georeference check) |
| A30 | Tilesets with no transform to ECEF (CesiumJS unit-box test packages) produce NaN vertices and a three.js console error | Nothing checked placement | Refused by name: "the tileset is not georeferenced …" | Run 4 |
| A31 | Newline-delimited GeoJSON (Microsoft's building tiles, named `….csv.gz`) refused as CSV | No GeoJSON-sequence reader; gz files were named by their outer extension | GeoJSON text sequences (RFC 8142, NDJSON) are read as a FeatureCollection; an inflated `.gz` is named by its content; `.geojsonl`/`.geojsons`/`.ndjson` accepted | Run 4 |
| A32 | Brotli PMTiles fail with "Compression method not supported" | The library has gzip only | Named from the v3 header bytes (Brotli, Zstandard; directories or tiles) | Run 4 |
| A33 | 3D Tiles 1.1 tiles with several contents (`contents`) showed nothing | The traversal read `content` only | A node lists every content URI and loads them into one group; an external tileset among them is grafted | Run 5 (`MultipleContents.3tz`, now placed by its root transform) |
| A34 | An ASCII cloud in a state-plane CRS fails with "EPSG:2994 is not known" even with the PROJ pack loaded | `crsOf` is synchronous; pack-only codes must be defined first (`app.proj.prepare`), which the LAS path did and the ASCII path did not | `readAscii` prepares the code before placing the cloud | Run 5 |
| A27 | Spectral library CSV still sent to the vector reader after A18 | `\b` after `wavelength` fails before `_um` (`_` is a word character) | Header test `wave(length)?([_ (]|$)` | Run 4 |
| A35 | The BPF zlib e2e test (REQ-LDR-11) failed after A-series BPF work: its writer labels zlib blocks with code 1 | PDAL's numbering makes 1 QuickLZ, which the reader then refused | Code 1 whose first block carries a zlib stream header is read as zlib; real QuickLZ is still refused by name | e2e, `points-io.test.js` |
| A36 | 2D/3D (`glb.toggle`) fetched AWS Terrarium tiles although a DEM under the image was loaded | The DEM was used only when it contained the whole view box (image plus margin) | The loaded DEM overlapping the box most is used, held at its edge value beyond it; online tiles only when no loaded DEM touches the view | Sweep (0 requests), e2e gui2-fixes and net-p3 |
| A37 | SAR View and Remap stayed disabled on complex SLC GeoTIFFs (Capella CInt16, derived CFloat32) although the views are offered for them (IMP-16) | Both commands were gated on SICD | Gated on any complex image; sub-aperture and CSI stay SICD-only (they need SICD geometry) | Sweep `sar.remap` on `umbra_slc_cfloat32.tif`; e2e gui-fixes, scn12 |

## B. Performance and optimisation (done)

| # | Finding | Fix | Verified by |
|---|---|---|---|
| B1 | Overviews of large J2K NITF and JP2 decoded full resolution first | A1: native reduced levels per tile; tiles cached in the block LRU | `j2k_region.rs` |
| B2 | 4.6 GB AVIRIS-NG BIL cube: 145 s to first display | ENVI BIL reads only the requested bands' runs (a 3-band view of 425 bands read 1.25 MB per line); large cubes get strided native coarse levels | `tests/unit/envi.test.js`; timed in the verification run |
| B3 | Gzipped vector text (`.csv.gz` building footprints) refused as "gzip file" | Inflated in memory (`DecompressionStream`) and read as itself | Run 3 |
| B4 | The ingest harness waited the full 120 s for routes with no image layer (glTF, GPX, packs, basemaps) | `settledAny` returns once such a route has logged its result | Run 3 duration |
| B6 | Complex SICD stacks (Umbra, 14k × 13k RE32F; 40–60 s in run 3): strided levels read whole 113 KB block rows per tile column through a 96 MB LRU that one level's rows nearly fill | Each coarse-level tile reads and unpacks only its own column span of a row (IMODE B/S/P; R keeps whole rows) | `tests/unit/nitf-level.test.js`: level samples equal the cell-centre full-resolution pixels on a pixel-interleaved complex SICD and a band-sequential SIDD |
| B5 | Overviews of WorldView-3 strips still read every tile-part (about 700 MB per strip; 105–158 s with four strips at once in run 3) | Resolution-first codestreams with one tile-part per resolution (Maxar RLCP, TNsot = NL + 1): a level-L tile reads only its first NL + 1 − L parts (1.7 KB instead of about 500 KB) | `j2k_region.rs` `wv3_reduced_tile_needs_only_its_resolution_tile_parts` (levels 1–5 identical to all-part decodes); `tests/unit/j2ktiles.test.js`: TLM index in fewer than 10 reads, an 8 × 8-tile level-5 view reads under 2 MB, and the window equals a direct decode |

## C. Harness, metadata and oracle defects (fixed)

| # | Finding | Fix |
|---|---|---|
| C1 | Truth keyed by file name: a second `N39W106.hgt` (3601² beside 1201²) or another RADARSAT-2 product's `imagery_HH.tif` overwrote the first, giving false "size vs GDAL" failures | `oracles/truth.py` keys repeated names by their path in the item; the spec looks up by path first |
| C2 | Shapefile parts, XSD schemas and Maxar `.MAN`/`.ATT`/`.EPH`/`.GEO`/`.TIL` were opened as primaries (about 500 false failures) | `make-corpus-roles.mjs`: sidecar or metadata; files unpacked from archives get their roles re-derived |
| C3 | Quantized-mesh `.terrain` tiles and implicit-tiling content were opened one by one | `tile` role, applied whatever a generator set |
| C4 | Negative samples needed a hand-kept `EXPECT` list | A file whose census keys include a format with status "refused" must be refused with a message that names it, not "unrecognised data" |
| C5 | ASCII point clouds timed out (column dialog) | `asciiPick: 'default'` automation hook, like `zipPick` |
| C6 | `pdf.nogeo` registered as refused, but a raster PDF without geo-encoding opens in image space, like a picture with no world file | Registry corrected to `variant` |
| C7 | Coverage counted a `covers` tag as an extra sample even when the census already found the key in that item | Tag counted only when the census did not find the key in the item (honest 174/179) |
| C8 | Census: A.TOC classed as NITF; Blender glTF `extensionsUsed` missed; OJPEG negatives that make GDAL throw lost their key; EINVAL on checkpoint writes | Each fixed in `census.py` |
| C9 | `SKIP_EXT` skipped every `.txt` and `.json`, so PDAL's ASCII clouds and the app's recipe and template files were never ingest-tested | Exempted; ASCII cases get their source CRS (`ASCII_CRS`) and the PROJ pack |
| C11 | The function sweep ran every command on its fixed recipe data, so `TE_PREFER` (the archive) changed nothing | Archive mode: a recipe that only names files (no setup, no earlier product, no more inputs than the row needs) gives way to an archive item that fits, rotated per command; ASCII clouds of unknown CRS are skipped, the others get their EPSG and the PROJ pack (`ASCII_CRS` shared from `helpers.js`) |
| C12 | 44 commands added in 2.0 (hub, local AI, HUD, deck, triage, converter, globe, Use as Terrain) had no recipe and were swept with no data, so they stayed disabled | Recipes: an image; image and DEM in use; two images; a Quick Chip in the deck; a marker stepped to with Patrol |
| C13 | Archive inputs that cannot satisfy a command (spectral libraries for indices, SICD XML for SAR views, CSV mappings for FMV) left 21 rows disabled, so the function itself went unexercised | When the archive input leaves the command disabled, the recipe's data is opened as well and noted in `prepared`; `msi.stack` gets a recipe (four Landsat 7 SR bands on one grid) |
| C14 | `git checkout -- reports/` during this work reverted the regenerated matrix, registry, unit report and corpus status | Regenerated: `c00-registry`, `gen-matrix.mjs` (495 rows, none of unknown status), `vitest`, `fetch.mjs --verify` |
| C10 | A project opened in a test waited on the relink dialog (3 min) | `relinkPick: 'skip'` automation hook; the missing imagery is a warning in the Import Log |

## D. Limits that stay (named refusals, by design)

Cartesian BPF (no CRS to place it). Vector files above the in-memory cap (OD-07; the 900 MB AIS CSV). A.TOC (frames open one by one). CPHD. MrSID. QuickLZ BPF. POC J2K. Draco and required KTX2 glTF. GeoParquet, FlatGeobuf and MBTiles (Convert writes the first two). Quantized-mesh terrain from local files (online `layer.json` only). An AI pack built for another build. Each is in `EXPECT` or covered by the refused-format rule (C4).

### Measured (ingest test, 4 workers, frozen `dist-archive`)

| Case | Before | After |
|---|---|---|
| Archive ingest set (1,587–2,252 cases) | 1.6 h (run 1, with 2-minute settle waits) | 11.8 min (run 4) |
| WorldView-3 PAN strip, 43008 × 36864 C8 NITF | refused (run 1); 105–158 s (run 3, all tile-parts) | 3.5–5.0 s (run 4) |
| WorldView-3 8-band MS, 11264 × 12288 × 8 C8 | refused (runs 1 and 3) | 4.5–5.0 s (run 4) |
| AVIRIS-NG 4.6 GB BIL cube | 145–166 s | 40 s (run 4, beside three other large opens) |
| Umbra complex SICD, 1.5 GB | 42–60 s in the parallel run | 4.2 s alone (a 2.9 s statistics pass, then tiles); the parallel figure is disk contention between workers |

## E. Open

- The tier-B downloads and unobtainable formats are in `TE-archive-followups.md`.
- The verification results are in the section below.

## Verification

All runs on 2026-10-29 against the working tree (nothing committed); campaign runs on the frozen `dist-archive` build, e2e on `dist/`.

| Check | Result |
|---|---|
| Ingest, every archive primary (c01, run 4) | 1,587 passed, 12 failed; the 12 fixed (A25–A34) |
| Ingest, run-4 failures and touched readers (run 5) | 296 of 296 passed |
| Ingest, BPF / ASCII / complex SLC after A35–A37 (run 6) | 196 of 196 passed (DFC2019 Track 4 local-coordinate clouds are refused by name, now listed) |
| Function sweep c02–c17, archive mode (`TE_PREFER`) | 484 of 484 passed in 8.8 min: 312 done, 164 dialogs, 4 pending jobs; 71 commands ran on 25 archive items, 21 of them with recipe data added (C13) |
| Commands still disabled in the sweep | `bg.map`, `vec.remotesave` (online; covered in c18 and e2e), `sar.pauli` (no free quad-pol SICD, OD-05); `stereo.xr` refuses by name (no headset) |
| e2e (880 tests, Chrome and Edge) | 872 passed, 6 skipped, 2 failed (REQ-LDR-11 in both browsers, fixed as A35; rerun 2 of 2 passed). Specs touched later (gui-fixes, gui2-fixes, net-p3, scn12) rerun: 58 of 58 passed |
| Unit (vitest) | 25 files, 151 of 151 passed |
| Rust (`cargo test`, workspace) | passed, including the 6 `j2k_region` tests and every gw-codec test after the hayro MSI patch |
| Corpus integrity (`fetch.mjs --verify`) | 2,328 files, 129.39 GB, every pin matches; 14 tier-B items wait for a manual download |
| Traceability (`build/traceability.mjs`) | 188 of 188 R0+R1 requirements tested; every last result passing (171 passing, 17 passing by file), no Must without a passing result |
| Format and function coverage (`coverage.mjs`) | 174 of 179 keys filled; the 5 open keys are tier B or unobtainable (`TE-archive-followups.md`) |
| USGS EarthExplorer downloads, ingest (c01, run 7) | 414 of 414 passed: SRTM DTED2 ×3 + DTED1, CIB-10 GeoTIFF ×3, Landsat 8 C2 L1 bundle, Hyperion L1T (242 bands), and 148 RPF frames + A.TOC derived from CIB-10. Coverage is now 175 of 179 (`rpf.toc` closed; `rpf.cib` is unobtainable as RPF) |
