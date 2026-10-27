# Design notes and implementation decisions

Decisions taken while building R0, R1 and R2. Each one refines a PRD decision (`D…`) or answers
a spike (`S-…`); none changes a requirement. The owner can reverse any of them.

## Owner decisions still open: defaults in use

| Decision | Default used in this build | Where it shows |
|---|---|---|
| O-02 Licence of the tool | **Apache-2.0** (owner decision at the 1.0 release, 2026-10-27; was the proprietary placeholder `LicenseRef-GIS-Workbench`); only permissive third-party code ships | `LICENSE`, `package.json`, `crates/Cargo.toml`, build report, notices |
| O-21 Cloud AI | Allowed only after a connection is added; off by default; consent per session; a second confirmation when the screen shows a marking above UNCLASSIFIED | AI Assistant dock, `ai/assistant.js` |
| O-22 Embed hosts | Tested locally as `srcdoc` iframe, cross-origin iframe and a scripts-only sandbox; the real hosts (Google Sites, WordPress, GitHub Pages, Netlify, SharePoint) are not tested | `tests/e2e/embed.spec.js` |
| O-23 Rust toolchain | Yes: Rust 1.99.1 pinned in `rust-toolchain.toml`, `wasm32-unknown-unknown`, crates pinned with `=` versions, `cargo deny` for licences; binaryen not required (wasm-opt is used when present) | `build/rust.mjs` |

## DN-01 Hand-written C ABI, no wasm-bindgen (S-22)
Every bundle exports `gw_alloc`, `gw_free`, `gw_last_error`, `gw_out_ptr`, `gw_out_len`,
`gw_abi_version` and typed status codes (0 OK, 1 INVALID, 2 RANGE, 3 LIMIT, 4 UNSUPPORTED,
5 INTERNAL). Modules import nothing, so they instantiate from inlined bytes under the strict
CSP (`'wasm-unsafe-eval'` only) on the main thread and in classic Blob workers. wasm-bindgen
glue is not needed. Tested by `tests/golden/abi.test.js`.

## DN-02 JPEG 2000 through hayro-jpeg2000, not OpenJPEG (S-06)
The SDP planned OpenJPEG compiled to WASM. A pure-Rust decoder (`hayro-jpeg2000` 0.4.1,
MIT/Apache-2.0) compiles to `wasm32-unknown-unknown` with no C toolchain, ships at 81 KB gzip
in its own lazy bundle (`wasm-j2k`, loaded on the first JPEG 2000 image), and decodes:
- `p0_01a.ntf` with the GDAL/OpenJPEG band checksum (1054);
- `wv3_a_chip_j2k.ntf` bit-exact against the uncompressed chip (2.36 M pixels, 11-bit).

Limits: whole-image decode (no region decode yet), so images above 400 M samples are refused
with a clear message; SIZ is pre-checked (≤ 400 M samples, ≤ 1 M tiles) because the fuzzer
found a header that kept the decoder busy for 140 s. HTJ2K (REQ-FMT-17) is not covered by this
crate and stays open.

## DN-03 Own sequential JPEG decoder for NITF (C3/M3)
`jpeg-decoder` refuses 12-bit DCT and the browser cannot decode NITF streams that rely on the
MIL-STD-188-198A default tables. `gw-codec::jpeg` decodes baseline and extended Huffman
streams, 8 and 12 bit, any sampling factors, restart intervals, and fills missing DQT/DHT from
the NITF default tables (Q level from the APP6 `NITF` segment). Results: U_4017A mean in GDAL's
[2385, 2386]; U_1005a (default tables) renders. Progressive, arithmetic and lossless (C5) are
refused with UNSUPPORTED.

## DN-04 VQ and T.4
VQ (C4/M4) kernel tables are located through the RPF location table in the RPFIMG TRE.
T.4 uses the `fax` crate for one-dimensional coding only; two-dimensional T.4 (COMRAT 2DS/2DH,
segment 2 of U_1123a) is refused by name and listed in the backlog. A layer that cannot be
decoded stays in the Layer Manager marked "not displayable"; the file's other layers display.

## DN-05 Lazy WASM bundles requested by workers
Workers receive `core` and `parse` at start-up. Other bundles (`j2k`) are compiled only when a
worker first asks (`GW.ensure(name)` → `need-module` → the pool compiles the verified block once
and posts the `WebAssembly.Module`).

## DN-06 Lite profile = loader stub + one gzip payload (REQ-HOST-05)
`gis-workbench-lite.html` is a 1.8 MB page (full file 2.28 MB) whose only script inflates the
gzip payload and writes it into the document. Its CSP is the app's CSP plus the stub's hash,
so the inner scripts still need their build hashes and every block its SHA-256. Its `srcdoc`
snippet needs no entity escaping (base64), so `snippet-lite.html` is 25 % smaller than the
standard snippet. Further savings need optional modules to drop out of the Lite build.

## DN-07 Accessibility overrides measured look where they conflict (REQ-UI-16 vs REQ-UI-12)
axe-core (WCAG 2.2 AA) found contrast and target-size failures in measured GXP values. The
token file keeps the measured value next to the adjusted one (`measured`, `a11y` fields):

| Token | Measured | Used | Why |
|---|---|---|---|
| `dock.title` (grey) | `#7c7c7c` | `#767676` | white text 4.17:1 → 4.54:1 |
| `ribbon.selectedTab` (dark) | — (grey value leaked) | `#4a4a4a` | inactive tab text 1.36:1 |
| `ribbon.buttonPressed` (dark) | `#8a6a1a` | `#94722a` | black text 4.15:1 → 4.7:1 |
| `status.bad` (dark) | `#c83c3c` | `#e05050` | black text 4.16:1 → 5.4:1 |
| `dock.titleText` (print) | white | `#111111` | white on `#d0d0d0` was 1.54:1 |
| menu bar, toolbar, dock title, dock tab, tree row, input heights | 20/22/18/20/20/20 px | 24/26/24/24/24/24 px | SC 2.5.8 target size ≥ 24 px |

The ribbon keeps its 92 px body: small buttons are 24 px (three rows fit in 76 px).
Also fixed: focusable splitters now carry `aria-valuenow/min/max`; the Ribbon minimise caret
moved out of the tablist; Layer Manager rows are list items (they contain controls).

## DN-08 Contextual tab colours were not applied (bug)
`h()` assigned style objects with `Object.assign(el.style, …)`, which silently drops custom
properties, so `--ctx` never reached the contextual tab sets. Custom properties now go through
`setProperty`. Found by PT-09.

## DN-09 Opaque-origin `srcdoc` frames
A `srcdoc` frame sandboxed without `allow-same-origin` has an opaque origin; run-mode detection
now treats it as sandboxed, so saves go straight to the in-page export panel instead of a
download the host blocks (REQ-HOST-03).

## DN-10 MGRS at the equator
A latitude a hair below zero (e.g. −5e-324) gave a southern northing of exactly 10 000 km and an
"inconsistent latitude" error. Such points now take the northern hemisphere, as latitude 0
does. Found by the differential test against the `mgrs` package.

## DN-11 Fuzzing on stable Rust (REQ-RUST-07)
`crates/gw-fuzz` is a deterministic mutation fuzzer seeded from `Research/samples/`. It runs
every parser that exists today (NITF headers and segments, TREs, mask tables, unpacking,
DTED/HGT, JPEG, JPEG 2000, VQ/RPF, T.4), catches panics and flags inputs slower than a limit.
Coverage-guided `cargo-fuzz` needs nightly and is not part of the CI gate yet. KLV, TS, 4607,
LAS/LAZ and SICD parsers join when they land.

## DN-12 Unsharp mask starts at 0
The default chain carries `sharpen.usm = 0`: sharpening changes DN-derived displays (and chips),
so it is opt-in from the Sharpness slider and the Sharpen toggle. Older chains are filled in
by `normalizeChain`.

## DN-13 Two image shader variants
Nesting the 5 × 5 filter loops inside the bicubic/Lanczos loops made one ANGLE compile take
27 s and stalled boot. The unfiltered variant keeps every kernel; a filtered variant (compiled
on first use) has nearest/bilinear only plus the S6 filters, DEM shading and contours. A layer
with a filter on drops to bilinear and says so. A boot-time gate (< 1500 ms) guards this.

## DN-14 Small robustness rules found while testing
- **NUL and CR in inline scripts.** A raw U+0000 in the source changed the inline script after
  hashing and the CSP blocked the app. `scriptSafe` escapes NUL as `\x00` and fails the build on CR.
- **Measurement kind is `mtype`.** `tx.create(type, rec)` owns `rec.type`; measurement kinds
  were silently overwritten. The Mensuration Log Type column was wrong before this fix.
- **Recording uses WebCodecs + an own WebM muxer.** MediaRecorder gave empty files headless.
  GIF uses an own GIF89a encoder with the reference LZW code-size timing.
- **Build id covers the styles.** A CSS-only change kept the old id; the id now hashes the
  loader, the app, the styles and every block.

## DN-15 Own PDF writer instead of jsPDF (REQ-PRD-03)
Pages are rasters rendered by the screen's passes, so the PDF needs only images: a 120-line
PDF 1.4 writer places JPEG strips (≤ 16 MP each, Safari's canvas limit) at the page's exact size
in points and sets `/PrintScaling /None` so a 1:n frame prints at scale (AT-16.1). This saves
the 109 KB jsPDF block and keeps text-free pages CSP-safe. Vector text in PDFs is a later
improvement; the HTML report prints through the browser (`window.print`) for selectable text.

## DN-16 Georeferenced chips
- **PNG/JPEG:** a least-squares affine world file over the image-area corners, shifted by the top
  banner, plus a WGS 84 `.prj` and the chip record, in one ZIP. The fit residual is recorded.
- **GeoTIFF (as displayed):** RGB with a 5 × 5 GCP grid (EPSG:4326); the reader now fits a
  polynomial model to GeoTIFF GCPs.
- **GeoTIFF/NITF (source samples):** the axis-aligned window under the view, every `step`-th
  pixel. A native map grid writes an exact geotransform. An RPC parent writes RPCs: in GeoTIFF,
  offsets and scales absorb the window (and a parent ICHIPB when it is scale-and-shift only);
  in NITF the parent RPC00B is kept and ICHIPB maps the chip onto the parent's full image.
  RPC00B offsets are integers, so the fractions move into the ICHIPB full-image frame and the
  written model equals the parent's (round trip < 1 cm in the E2E test).

## DN-17 Report printing in place
The app CSP has `default-src 'none'`, so a print iframe is not used: the report document is
moved into a print root and the app is hidden with print CSS for the print, then restored.
Banners are `position: fixed` in print, so every page has a top and bottom banner.

## DN-18 AI report drafts never lower a portion
REQ-AI-10 asks the draft to keep portion marks. Any drafted paragraph without a portion mark,
or marked below the highest input portion, is marked with that highest portion and counted;
the dialog says how many and labels the sections AI-drafted. This over-marks rather than
under-marks; the analyst can lower a paragraph by editing it.

## DN-19 Registration: a display affine per layer, a corrected model
All layers of a panel share one pixel frame, so a registration stores an affine (layer pixel →
panel reference pixel) on the layer; the renderer composes it into the view matrix and plans
tiles in the layer's own frame. The layer also gets a model that agrees with the reference at
aligned pixels: an RPC keeps its 3-D model with the correction folded into the ICHIPB affine
(checked at two heights to 1 cm); other models get a polynomial GCP model. Undo and project
reload restore the right model from the stored description. Auto Align correlates high-passed
patches (NCC with sub-pixel peaks) on a grid and keeps the consensus of triple fits within
0.5 px: repetitive scenes (road grids) give strong false matches that a plain least-squares fit
absorbs. It assumes a shared nominal grid (two dates, orthos); Quick Align and GCPs cover the rest.

## DN-20 Feature store and vector I/O
Feature records hold plain arrays (flat lon, lat, HAE; part and polygon offsets) so the store,
undo and project files stay JSON; a memoised typed-array view serves the index and the maths.
rbush indexes feature boxes and kdbush the vertices (rebuilt lazily after edits);
polygon-clipping does split and merge. Shapefile and KML have own readers and writers (Z types,
code-point-safe DBF text, deterministic 10-character names with a map, names and descriptions as
DBF fields; KML Schema/SchemaData, shared styles and StyleMaps, EGM96 altitudes), so shpjs and
togeojson are not needed. GeoPackage stays with REQ-EXT-22 (R2): FX-12 therefore has three of
its four formats, and AC-17.1/17.5 are R2.

## DN-21 Fixture generators
`build/fixtures/synth.mjs` has its own WGS 84 geodesy, a pinhole camera and ray casting, written
apart from the Rust core so the truth checks the product rather than itself. RPC00B fits use a
small ridge on the denominator terms: over small boxes perspective is almost affine and
unregularised denominators grow until RPC00B's seven digits lose them (0.13 px → 0.0002 px on
FX-03). FX-01 (4096² pan, RPC00B, 50 truth points), FX-03 (20° off nadir, 4 buildings, 3 poles,
shadows), FX-05 (GeoTIFF HAE and DTED L2 EGM96 of one analytic terrain), FX-06 and FX-12 exist;
FX-02, 04, 07–11 come with their R2/R3 scenarios.

## DN-22 Large uncompressed NITF blocks are read by row strips
A NITF with one block for the whole image was read as one block (FX-01: 16 MiB in one read; a
multi-gigabyte unblocked file would have been loaded whole). Uncompressed blocks over 4 MiB are
now read as cached, aligned row strips through ≤ 1 MiB slices (REQ-ARC-07), with concurrent
requests sharing one read. Limit: the first overview tile of an unblocked image without
overviews or R-sets still needs every row once, so the 1 s first-tile budget (REQ-PRF-03) holds
for FX-01 (0.7 s) but not for a multi-gigabyte unblocked file; a sampled preview is the fix.

## DN-23 UI scale and hot keys
Every px size token is emitted as `calc(<px> * var(--ui-scale))`, so UI Scale resizes the
chrome without touching device-pixel rendering. Customize Hot Keys refuses chords the browser
keeps (new tab or window, close, quit, full screen) and allows browser-used chords (F5, Ctrl+R …)
only as panel keys, which the router captures while a panel has focus.

## DN-24 Defects the scenario tests found
- The grid label helper left the stroke style black, so every grid line after the first drew
  black; grid lines also sat at the model's default height instead of the terrain's.
- Product scale (1:n frames, scale bars) is now taken on the plane at the centre's terrain
  height; Jump to Point now uses the terrain height (off-nadir images centred off target).
- Shapefile export dropped feature names and descriptions; the model status went stale until
  the cursor moved; the KML colour reader kept an opaque alpha.

## DN-25 Deferred R1 Shoulds: storage, imaging and mensuration
- **Journal (REQ-SEC-06).** Off clears the whole journal store, other projects' entries
  included. Encrypted entries are AES-GCM under a PBKDF2-SHA256 key (210 000 iterations,
  per-journal salt). The passphrase and key stay in memory; recovery asks for the passphrase.
- **CLAHE (REQ-IMG-08).** The decode worker builds 4096-bin histograms per grid cell from the
  stats level. The layer clips each one (clip × n / 256), redistributes the excess, and stores
  the CDFs as a 256 × cells × bands texture. The filtered shader blends the four nearest cell
  maps bilinearly after the LUT, so CLAHE costs no tile re-decode.
- **Pan-sharpening (REQ-IMG-10).** The MS, pan and (for IHS-NIR) NIR layers are drawn to
  offscreen targets and composited in one pass:
  - Brovey, IHS, IHS-NIR and Gram–Schmidt are offered;
  - the pan is matched to the intensity's mean and spread;
  - the MS layer is aligned to the pan through both sensor models (an affine fit), so the two
    images need not share a grid.
- **Segment merging (REQ-IMG-20).** A mosaic plan places segments by IALVL, IDLVL and ILOC.
  - It needs one root segment, the same bands and sample type, and non-negative positions.
  - Otherwise each segment opens as its own layer, and the reason is shown.
  - Segments are composited in IDLVL order.
- **Medial axis (REQ-MEN-08).** The polygon is rasterised in ENU, then:
  1. a Felzenszwalb–Huttenlocher distance transform and Zhang–Suen thinning;
  2. the longest Dijkstra path;
  3. spur trimming (distance below 80 % of the median);
  4. the length measured as chords every ½ median width, plus the end distances.

  Tested to within 2 m and 0.6 m on a rotated 100 × 10 strip, and within 3 % on a half annulus.

## DN-26 HTJ2K: vendored hayro with an HT block decoder
REQ-FMT-17 needs HTJ2K decode inside the existing `j2k` bundle (pure Rust, inlined, CSP-safe).

**`openjph-core` 0.1.0 was tried and rejected.** It is a Rust port of OpenJPH. Its HT block
decoder matched OpenJPH, but its tile pipeline did not:
- it never applies the inverse colour transform;
- it reconstructs every level when resolutions are skipped;
- multi-component 9/7 images decode wrong.

**Chosen design.** hayro-jpeg2000 0.4.1 is vendored (`crates/vendor/hayro-jpeg2000`, see
`VENDOR.md`) and gains:
- HT code-block flags, and skipping of the CAP, PRF and CPF markers;
- Part 15 packet-header segments, including placeholder HT sets;
- a call to `ndic-htj2k` 0.2.5, pinned (MIT; a port of OpenJPH's 32-bit block decoder), for
  each HT code-block.

Everything else is hayro's proven Part 1 path: IDWT, RCT/ICT, tiles, resolution reduction and
JP2. A Part 15 codestream in a NITF is IC=C8; the codestream's COD marker selects HT.

**Checks.** Streams were encoded by OpenJPH 0.32 (C++, through imagecodecs) by
`build/fixtures/gen-htj2k.py`, giving `fixtures/htj2k`:
- tiled 11-bit, 16-bit and RGB with the RCT are bit-exact to their sources;
- 9/7 with the ICT is within one count of OpenJPEG 2.5.4;
- reduced resolution equals OpenJPEG.

OpenJPEG is the lossy reference because OpenJPH's decode through imagecodecs wraps
out-of-range samples instead of clamping them.

Other checks:
- an `htj2k` fuzz target;
- an E2E that opens an HTJ2K NITF;
- the Part 1 sample checks, which are unchanged.

The `j2k` bundle is 90.6 KB gz (budget 300 KB).

**Limits.**
- Decoding is whole-image (≤ 400 M samples), like Part 1.
- A second HT set in a later quality layer is refused, as are mixed HT/Part 1 codestreams.
- Multi-pass (SigProp/MagRef) code-blocks follow the decoder's tests but have no fixture of
  their own, because OpenJPH writes cleanup passes only.
- HTJ2K encode for the internal pyramid cache (the PRD's encode column) is not done.

## DN-27 MCP client and server; Describe View
**Client (REQ-AI-14).**
- Transport: Streamable HTTP. It sends JSON-RPC POSTs and reads JSON or SSE replies, the
  `Mcp-Session-Id` and `MCP-Protocol-Version` headers, and a bearer token.
- Tokens are held in memory only.
- OAuth 2.1 uses PKCE S256 after protected-resource and authorisation-server discovery. The
  analyst pastes the returned code, because a file:// app has no redirect handler.
- A server's origin must be in the file's network allow-list (`connect-src`), which takes a
  save and reload; the client refuses otherwise.
- Remote tools join the assistant as `mcp__<server>__<tool>`. A tool not marked read-only asks
  the analyst before each call.
- Elicitation is answered through a form.
- Sampling needs two separate confirmations before the server's prompt reaches the analyst's
  AI provider.

**Server (REQ-AI-15).** One JSON-RPC dispatcher over the registry (tools, resources, prompts)
serves three channels:
- the console (`window.gisworkbench.mcp.handle`);
- a postMessage bridge that answers only listed exact origins (off by default);
- WebMCP, where the browser offers `navigator.modelContext`.

Writes from outside agents are Proposals with `mcp:<origin>` provenance, as the assistant's
are. Nothing changes until the analyst accepts.

**Describe View (REQ-AI-09).**
1. A marked 1024 × 768 chip (JPEG) and its token metadata are sent to the active connection,
   after the usual consent and allow-list checks.
2. The reply becomes a draft observation Proposal, with its confidence term parsed from the
   reply.
3. The prompt asks the model not to state measurements.

**Help answering (REQ-AI-11).** It uses three read-only tools:
- `gw_help_search` searches the help pages, the limits statement and the command cue texts;
- `gw_explain_tres` returns decoded TRE fields;
- `gw_error_budget` returns the core's error budget at a point.

## DN-28 Block adjustment: image-space corrections over any model (REQ-SNS-11..15)
Every image gets a bias polynomial in image space (shift, shift + drift, or affine; `Adjusted`
in `gw-sensor`) on top of its own model, so RPC, RSM, frame and pushbroom images adjust in one
Levenberg–Marquardt solver (Schur complement on the points) through numerical ground partials
(REQ-SNS-12). GCPs are weighted pseudo-observations, image priors are a-priori σ, blunders are
flagged at k·σ and can be rejected. The adjusted model is rebuilt from the base model and the
stored correction (`layer.rec.triangulation`), never written into the RPC itself; "Refit RPC"
(REQ-SNS-16) writes a new RPC record when one is wanted. FX-04: 3-D checkpoint RMSE 18.6 m
before, 0.24 m after.

## DN-29 Stereo: one epipolar display plane per pair (REQ-STR-01..10)
A local ENU plane at the reference height, rotated so x-parallax runs along screen x; each eye
has a viewport-local affine refitted on view changes (`fitBounds`) and a y-correction for the
right eye. Heights come from x-parallax through the models (not a disparity scale), so the
floating cursor sits on the ground. Measured y-parallax ≤ 0.5 px on FX-02.

## DN-30 Terrain extraction: census SGM with per-pixel ranges; NCC Fast (REQ-DEM-04/05)
Census (9 × 7) plus 8-path SGM on a pyramid; each pixel searches the coarse neighbourhood
min … max ± radius (tSGM style); a true right-referenced pass for the left–right check;
occlusion borders are demoted. Figures of merit: 0 no data, 1 left–right, 2 ambiguous,
3 speckle, 4–100 matched. **NCC Fast** matches 7 × 7 windows over the full range at half
resolution (posts are coarser than pixels) with a parabola, uniqueness and left–right checks:
3× faster than SGM on FX-02 with 0.10 m flat RMSE, and flagged edge-poor in the result.
WebGPU paths for PRF-06/07 were added in R3 (DN-50).

## DN-31 DEM edits are a command log (REQ-DEM-08)
The source grid never changes. Each edit is a `demedit` record (kind, ring, parameters,
analyst); the surface is the source with the log replayed, pushed to the core terrain and, as
sparse tiles, to the decode worker for display. Undo, redo and project files carry it.

## DN-32 Ortho, mosaics and Ortho On-the-Fly (REQ-SNS-17..19, REQ-IMG-18)
Inverse mapping on an adaptive grid (64-px cells split until interpolation is within 0.1 px),
NN/bilinear/cubic/Lanczos-3, UTM COGs. Mosaics use nadir-Voronoi seams, gain/offset or
histogram balance and feathering; seam edits re-blend only touched tiles. **Ortho On-the-Fly**
re-rectifies the region around the view (twice its size, at the display's ground resolution)
through the same engine as you pan or zoom past it, and swaps the transient product in place
keeping the ground centre and scale — not a GPU warp. A 1547 × 1376 region takes 0.1 s.

## DN-33 Viewshed and HLZ (REQ-DEM-13/14)
Reference-plane viewshed (Wang et al., GDAL-style) with curvature Z − 0.87·d²/(2R); an exact
ray-cast oracle checks it (99.9 % agreement) because gdal_viewshed could not be installed here
(spike S-15 stays open). HLZ: Horn slope, obstructions from a morphological opening, slope
maximum over the touchdown disc, obstruction dilation by zone/2 + buffer; a DTM input warns.

## DN-34 LiDAR reading (REQ-LDR-01..03, FMT-10)
LAS 1.0–1.5 by header size and record length; LAZ through the `laz` crate (D23, Apache-2.0),
decoded as runs of whole chunks in up to six point-cloud workers (each run rebuilt as its own
stream with a one-run chunk table). COPC files read as LAZ (their chunk table is mandatory);
**range streaming of COPC/EPT nodes is not done** (REQ-LDR-02 partial). CRS from OGC WKT 1/2
or GeoTIFF keys, units (US survey feet) and vertical datums in Rust; EGM96/EGM2008/NAVD88
heights convert to HAE with the embedded EGM96 (NAVD88 and EGM2008 with a stated ≈ 1 m
uncertainty). LAS 1.4 export (formats 6/7, WKT, optionally LAZ) goes through an inverse lattice
to WGS 84 / UTM.

## DN-35 The 3D pane (D18; REQ-LDR-04..07, REQ-STR-11..14)
three.js 0.186.1 as a lazy, verified block (`js-three`, 136 KB gz). Point clouds draw through
a flattened octree: square tiles whose points are sorted by LOD level, so any prefix is an even
thinning; the 3 M budget is shared by projected size each frame; adaptive point size; own
eye-dome-lighting pass on the depth texture (gaps to the background do not darken). Terrain is
an RTIN mesh (Rust, `gw-terrain::rtin`) draped through the image's sensor model. Navigation:
Orbit, Free, Route. **Fly-through recording uses WebCodecs VP8 frames and our WebM muxer**
(`media/webm.js`), rendering frame by frame: MediaRecorder produced no data from canvases in
headless Chromium, and frame-by-frame keeps the frame rate whatever the render speed.

## DN-36 The local 3D frame
Point clouds, terrain and models share one frame per view: east/north metres scaled from
latitude/longitude at the origin (WGS 84 radii there) and up = height above the ellipsoid. It
is not a tangent plane, so heights are true HAE everywhere and grids map to latitude/longitude
linearly; horizontal distances off the origin carry a scale error of about 1e-4 per km, so
measurements use geodesics on the converted points. Clouds with other origins are offset into
the view's frame.

## DN-37 Schema, GeoPackage and office files (REQ-EXT-09..13/22/24/25/27, REQ-PRD-05/06)
The TDS 7.1 subset (38 classes, 33 attributes) is open JSON (`app/src/data`); forms, nulls
(−999999 / "noInformation"), domain and range checks, persistent defaults and auto-attribution
come from it; a GeoPackage's domains become a catalogue on import. GeoPackage 1.4 through lazy
`rtree-sql.js` 1.7.0 (SQLite with R*Tree, MIT; WASM in its own block): core tables, ISO WKB with
Z in GeoPackageBinary, the R*Tree index with its triggers (ST_* functions registered), Schema
and Metadata extensions. Validation runs in Rust (`gw-vector`) in a worker. **pptxgenjs** 4.0.1
bundles JSZip, whose setImmediate polyfill contains `new Function` for string callbacks; the
build replaces that unreachable branch with an error so no block needs eval (eval gate holds).

## DN-38 Sensor models in Rust (REQ-SNS-03/04/14)
Frame (collinearity + Brown distortion) and pushbroom (polynomial position and attitude in time)
are the pure-Rust fallback that D4 allows until a rebuilt usgscsm passes S-05. RSM is one
polynomial section from RSMIDA + RSMPCA, labelled "experimental": the TRE field layout follows
STDI-0002 App. U as read, but no NGA sample was available to check it; an RSM made from an
RPC00B agrees with the RPC to 1e-6 px through our writer and reader. Grid sections (RSMGGA) and
the RSM error TREs are not read.

## DN-39 Worker pool: CPU kinds and the spawn cap
CPU-bound kinds (analysis, point cloud) run one job per worker and the pool adds workers up to
its size instead of stacking jobs; spawns in progress count against the size (13 workers were
seen before this fix with 13 concurrent LAZ jobs).

## DN-40 R2 partial items (closed in R3)
- REQ-LDR-02 / REQ-ARC-16: COPC and EPT stream by HTTP Range or node files (DN-47);
  quantized-mesh terrain is read (DN-47).
- REQ-EXT-15 texturing, `.3tz` and the gaps check of REQ-EXT-13 are done (DN-48).
- REQ-STR-11 Sync Always is done (DN-48).
- PRF-06 and PRF-07 have WebGPU paths (DN-50).

## DN-41 SAR exploitation (REQ-SAR-01..14)
SICD and SIDD read in Rust; projections are the SICD Volume 3 port in the core, so every
derived product (chip, filtered, change) is written as NITF with the SICD XML and its chip
offsets updated, and keeps the rigorous geometry. Remaps (Density, Brighter, Darker,
High-Contrast, Linear, Logarithmic, PEDF, NRL) are LUT steps in the image chain. Speckle filters (mean, median, Lee, Kuan, Gamma-MAP,
Frost, Refined Lee) work on detected intensity with summed-area statistics and preview on the
GPU; complex data is never filtered. CCD co-registers by amplitude cross-correlation refined to
~0.01 px (upsampled matrix DFT), fits an affine with outlier rejection and resamples with an
8-tap complex-safe sinc, then uses a noise-compensated coherence estimator (after Wahl et al.
2016): low clutter-to-noise posts are "no decision", not change. The pair finder uses
metadata only.

## DN-42 Spectral exploitation (REQ-MSI-01..16, REQ-EXT-28)
Cubes are BIP f32 read once per algorithm; labels are u8 with 0 unclassified. Band Math
compiles to shaders for display and runs in Rust for products. Radiometric conversions are
stored chain steps, and the layer states what it shows (DN, radiance, reflectance). Classifier
scores are kept, so a threshold re-labels without recomputing. Above 32 bands RX, ML and the
GMM run on PCA components (covariance estimates are unstable otherwise). MNF whitens by noise
from horizontal shift differences. Composite presets pick bands by wavelength when the sensor
is unknown.

## DN-43 Full-motion video (REQ-FMV-01..14)
MPEG-TS is demultiplexed in Rust (PES, PTS unwrap, access units, SPS size and codec, SEI
MISP microsecond time); video plays through mpegts.js and MSE, and frames are timed by
`requestVideoFrameCallback`. KLV (ST 0601, 0102, 0903 VMTI) decodes in Rust with checksum
checks; a bad packet is flagged and skipped. The time basis is MISP time by default.
Asynchronous KLV is timed by its multiplex DTS: its PTS put metadata 1–3 frames off. Edge can
deliver a callback for a stale seek, so callbacks check the seek target. The last PES of a
file is flushed explicitly (`at_end`). Footprints use, in order: the KLV corner offsets, the
frame model from platform and sensor angles (ST 0601 rotations, ≤ 3.2 m from truth on FX-10)
intersected with the DEM, then the frame centre only. Captures are PNG with a world file,
JSON, or NITF with an RPC fitted to the KLV model. STANAG 4607 dwells and targets (SA32/BA32
angles) and 4676 tracks are layers on the map clock. Clip export records MP4 where the browser
can, else WebM.

## DN-44 Data packs (REQ-ARC-14)
A `.gwpack` is a ZIP with `pack.json`. Every entry is checked by SHA-256 against `pack.json`;
JavaScript, WASM and model entries must also match the hashes this build lists in its
manifest, so a pack cannot add code the build did not ship a hash for. Pack code passes the
same eval gate as the HTML. Packs are kept in IndexedDB (file handle or Blob) and reloaded at
start. Workers ask the pool for library bytes (`need-lib`) instead of fetching. The **PROJ**
pack converts with PROJ's own transform: PROJ.4 strings without `towgs84` put BD72 108 m off.
**EGM2008** replaces EGM96 for MSL when loaded (tested against an independent bilinear read of
the PGM). **HDF5** (h5wasm) reads EMIT and PRISMA, with bands sorted by wavelength. **AI**
(onnxruntime-web, SlimSAM-77) gives smart select; its mask outline is an edge-chain trace.

## DN-45 Review and products (REQ-AI-*, REQ-PRD-*)
AI tools can propose actions as well as changes: an action proposal holds a command and runs
only when accepted, and the result is recorded. Detections are imported as a layer and reviewed
one by one (accept, reject, or edit class and note) with the decision kept. Products add DOCX (from the
report HTML; table-cell images moved to their own section), animated GIF (gif.js-style LZW),
PPTX from a user template with layout fallback, media slides, and GeoPDF with a /VP viewport.

## DN-46 R3 formats (REQ-FMT-14)
MIE4NITF image sequences are found through MTIMSA and play as a time series. CADRG and CIB
frame files open singly; corner points are re-ordered (and repaired across the antimeridian)
because some IGEOLO fields are degenerate; A.TOC is not read. GeoPDF pages are scanned for
/VP and /GEO viewports and their images placed by the content-stream matrix.

## DN-47 Streaming sources (REQ-LDR-02, REQ-ARC-16, REQ-STR-15)
COPC is read by range from a local file or over HTTP Range: header, hierarchy pages, then the
nodes the view needs by screen-space size, coarse first. EPT reads `ept.json`, the hierarchy
and binary or LAZ node files. 3D Tiles 1.0/1.1 refine by screen-space error (REPLACE and ADD)
with b3dm/glb content placed through RTC_CENTER into the local frame (DN-36). Quantized-mesh
1.0 terrain (geographic TMS) is read over a box at one level. All of these go through the
logged, allow-listed fetch.

## DN-48 R2 extraction and 3D items finished in R3
Gaps are holes of the polygon-clipping union of a layer's polygons up to 500 m² (larger holes
are taken as intended), reported at their area centroid. Building texturing projects every
model vertex into one image through its sensor model; the window under them becomes the
texture (2048 px max), so roofs come from orthos and facades from obliques, with no occlusion
test. A `.3tz` is unzipped in memory and served to the 3D Tiles loader. Sync Always moves the
3D target to the 2D panel's centre ray at the terrain (or the current target height) and
moves the panel to the target's image point, guarded against feedback.

## DN-49 Stereo outputs (REQ-STR-06)
The dual output is a second window showing one eye, kept in step with the panel; the panel
shows the other. WebXR shows the pair in a headset where the browser offers `immersive-vr` and
reports why it cannot otherwise. Both use a single-eye shader mode.

## DN-50 WebGPU (REQ-PRF-06/07)
Both paths are the default where WebGPU is available (pref `webgpu`) and fall back to the
workers; tests compare them with the worker results.
- **Viewshed:** the worker's reference-plane algorithm. Rings of Chebyshev radius r depend
  only on ring r − 1, so each ring is one dispatch and all rings go in one compute pass. With
  f32 heights, fewer than 0.001 % of FX-05 posts differ from the worker. A 1121 × 929 grid
  takes 32 ms (worker 590 ms).
- **DSM tiles:** a JS + WGSL port of the Rust tile. Census, the Hamming cost volume over
  per-pixel ranges, 8-path aggregation and winner-takes-all (sub-pixel, uniqueness) run on the
  GPU. Rectification, the pyramid ranges, the median, speckle removal, the FOM and the lookup
  accumulation follow the Rust step by step in JS. Aggregation is one dispatch for all eight
  paths, a 16-thread workgroup per scan line. Each pixel takes one barrier: ping-pong path
  buffers, a triple-buffered atomic minimum, and the next pixel's costs fetched ahead. Costs
  and sums are 16-bit pairs in 32-bit atomics; ranges start on even entries. The kernel needs
  10 storage buffers per stage, so the device is asked for that limit. One deliberate
  difference from the Rust code: the left-right check takes the right disparities from the
  left volume (Hirschmüller 2008 §3.4, 3 × 3 median) instead of a second right-referenced
  pass. That halves the GPU work; `lrPass` restores the Rust behaviour. On FX-02 the occluded
  posts flagged go from 96.5 % to 96.0 %, flat RMSE and box tops are unchanged, and the 4096²
  pair matches the worker heights (median difference 0, p95 7 mm). The 4096² pair takes
  7.2–8.1 s, against about 19 s in six workers (Intel Xe-LPG). Tiles are prepared on the main
  thread just before dispatch, so lookups overlap matching.

## DN-51 R0–R2 Shoulds and Coulds closed in R3
A runtime check found 12 catalogued commands with no implementation, and traceability found
22 R0–R2 requirements with no citing test. All are closed and cited by `closeout-ui.spec.js`
and `closeout-geo.spec.js`; every command now has an implementation, and a test enforces it.
- **Lite (REQ-ARC-15)** omits the 3D, LiDAR, video and SAR blocks. The manifest lists them as
  `omitted`, and the loader names the missing module. Lite is 3.9 MB, Standard 5.6 MB.
- **Snapshot (REQ-ARC-19):** the tool, the project and its files up to 25 MB each (100 MB in
  all) go in one HTML; reopening relinks them from the embedded data. The data element is
  stripped by its exact markup, because the app's own code contains the tag text.
- **Automation (REQ-ARC-17):** `gisworkbench.api` covers open, image ↔ ground, graphics, the
  chain, commands, the view and chips. The console takes `method {json}` lines, because the CSP
  forbids eval.
- **Preferences (REQ-UI-11):** User values over Common ones. Common values can be imported as
  JSON and locked; a locked value wins and the User control is disabled.
- **Ribbon (REQ-UI-24):** hidden groups and one custom tab, kept in the preferences.
- **Serial stereo mice (REQ-UI-22):** Web Serial with a documented text protocol
  (`dx dy dz buttons`). The Stealth and TopoMouse protocols are not public, so they plug in as
  further parsers.
- **True ortho (REQ-SNS-19):** per-cell visibility against the DSM along the image ray, with
  max-of-four occluders. On the FX-02 truth mask it finds 96.5 % of hidden posts with 0.04 %
  false alarms; occluded cells are filled from the other image.
- **Descriptor matcher (REQ-SNS-21):** ORB (Harris, intensity-centroid orientation, rotated
  BRIEF, mutual ratio test, RANSAC affine) on overviews, with no sensor model. Tie points use it
  when the model-predicted NCC search finds nothing. On FX-02: 368 inliers, 0.8 px median.
- **Epipolar export (REQ-STR-16):** both eyes resampled to the display plane as GeoTIFFs with
  five GCPs on the plane at h_ref. Checkpoint rows agree within 0.03 px.
- **Points (REQ-LDR-11):** BPF v3, after PDAL's reader since the NGA text is not public:
  three interleaves, zlib blocks, UTM coordinates. ASCII points use a column map. DoD and
  buildings from points reuse the DSM tools.
- **Terrain folder (REQ-DEM-03)** indexes by tile name or TIFF header and reads the vertical
  datum from the GeoKey or the description. Depth (REQ-MEN-09), DEM volume (REQ-DEM-15), GPX
  (REQ-IMG-31), the GeoPDF snapshot (REQ-PRD-08), the OOTF projection (REQ-IMG-18), streamed
  AI replies (REQ-AI-16), spell check (REQ-UI-23) and the mini toolbar (REQ-UI-06) complete
  the set.

## DN-52 Float determinism (REQ-RUST-11)
Reference paths are scalar IEEE-754 f64 or f32, or fixed-width SIMD128, with no fast-math or
FMA contraction (Rust never contracts on its own). They are bit-identical across engines.
Relaxed SIMD, whose results may differ between engines, is excluded. The determinism gate
decodes every function body of every Rust bundle at build time and in the unit tests, and fails
on relaxed-SIMD opcodes, atomics, undecodable bodies or a relaxed-simd target feature.
`wasm-opt` runs with `--disable-relaxed-simd` where it is installed. GPU paths are not
reference paths: they are checked against the worker results.
