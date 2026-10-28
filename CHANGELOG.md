# Changelog

All notable changes to GIS Workbench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Items carry the campaign finding id they close (GUI-nnn: `docs/validation/GUI-findings.md`; TE-nnn: `docs/validation/TE-findings.md`).

## [2.0.1] - 2026-10-28

The 2.0 GUI campaign. Every button, menu, panel, dialog and shortcut of the Modern and Classic layouts was driven by real pointer and keyboard input in the Standard, Lite and air-gapped files, in Chrome and Edge, and by hand in a browser with a GPU. This release fixes what it found and smooths what it showed could be easier.

### Added
- **Use as Terrain…** is now a command, in the command palette and on Image Tools ▸ Visualize. Opening a GeoTIFF elevation model suggests it, and the Surface tools and line of sight then work from it. Before, only the Layer Manager’s right-click menu offered it. (GUI-056)

### Fixed
- **New Project, Open Project and Window ▸ New Window** now bring every panel along. Before, Catalog, Convert, Recipes, Detections, Observations, Triangulation and four more could not open in the new window (“unknown dock panel”). (GUI-045)
- **Undo after opening an image** no longer breaks Report Template and Draft with AI. (GUI-028)
- **Stereo:** undoing the opening of one of the two images closes the stereo panel cleanly. Before, the panel failed to draw until the next reload. (GUI-033)
- **3D:** a two-band image (a band stack, for example) drapes on the terrain and colours a point cloud. Before, both stopped with an error. (GUI-043)
- **New Project in the Modern layout** no longer raises a hidden error. (GUI-042)
- **Radial menu:** the eight tools no longer overlap, so a click always picks the tool under the pointer. (GUI-030)
- **Contextual tool pill:** it now appears over video, point clouds and vector layers with their own tools, not only over images. (GUI-034)
- **Lite:** 2D / 3D is greyed out and the 3D button is hidden, as Lite leaves the 3D module out. Before, both failed when used. (GUI-046)
- **Network Allow-List ▸ Save New Copy** works when the list is unchanged. Before, it reported that the file had no security policy. (GUI-052)
- **An empty or partial web address** in Stream Point Cloud, Add 3D Tiles, Add Quantized-Mesh Terrain, Open Remote Layer and Send to a Google Sheet is a warning that says what to enter, not an error. (GUI-053)
- **Triangulation:** Automatic Tie Points, Solve, Apply and Remove Solution are greyed out, with the reason in their tooltip, until they can run. (GUI-032)
- **Find in Scene:** Classify without training classes is a warning that says what to do, not an error. (GUI-044)
- **About** names the air-gapped edition and says it makes no network requests, and shows the worker pool in words. (GUI-036, GUI-041)
- **Light theme:** the status bar is light too. (GUI-031)
- **Air-gapped file:** “Air-gapped” in the status bar no longer wraps onto two lines in a narrow window. (GUI-055)
- **Readable in every theme:** buttons, dock tabs, the Workspace rail, warnings, the Preferences page list and status cells now meet the WCAG AA contrast ratio in the Dark and Material themes. Greyed-out buttons look greyed out. (GUI-048, GUI-049)
- Controls without a name in Map Backgrounds, the Prompt Helper, the Network Allow-List and Send to a Google Sheet now have one for screen readers. (GUI-029, GUI-054)

### Changed
- **Greyed-out commands say what to open first** (“open a multispectral image first”, “open a video first”) in the command palette and in tooltips. (GUI-047)
- **Every panel fits its dock.** Panels open at their top-left instead of where the last one was scrolled; Detection Review and Spectral no longer scroll sideways in a narrow dock, where form labels now sit above their controls. (GUI-050)
- **Wide editors docked on the right** (the KLV table, for example) widen the dock to fit, up to 40 % of the window. (GUI-035)
- **Hints match the layout.** An empty panel in the Modern layout says “Open, drop files here, or press Ctrl+K”. The AI Assistant offers an **Add a connection…** button; the air-gapped file says it cannot reach a remote assistant. (GUI-038)
- **Unexpected errors are reported.** A failure outside a command shows once as an error message and goes into Help ▸ About & Diagnostics ▸ Copy Diagnostics. (GUI-037)
- **Catalog and Convert:** Open and List with an empty box say what to type; the date boxes are labelled From and To; the Convert drop zone says it can be clicked. (GUI-051)
- Recipes has its own icon in the navigation rail. The AI Assistant's attach options no longer wrap in mid-phrase. (GUI-039, GUI-040)

## [2.0.0] - 2026-10-28

GIS Workbench 2.0, the modernization release. It answers the ELT review: a clean canvas instead of a wall of tools, workspaces for the way you work, data that opens from anywhere, local AI as a first-class copilot, workflows you can watch, and hand-offs to the tools around you. The 1.x Ribbon layout is one click away for anyone who prefers it. The betas and release candidates below list every change in detail.

### Added
- **Modern layout** (the new default):
  - An app bar and a navigation rail around one edge-to-edge image panel.
  - The Ctrl+K command palette for commands, layers, coordinates and URLs, and two-line tooltips that say what each command does.
  - A contextual tool pill and a radial menu (tap Space).
  - Flicker (F), swipe (S), quick chips (C + drag), paste-to-pan and J / K target patrol.
  - Docks that tile and never cover the imagery.
  - Explorer, AI Analyst and Pro workspaces, and Material 3 light and dark themes.
- **Network you control.** An Online/Offline switch, built-in basemaps under georeferenced imagery and a 2D/3D view once you go online. The new **air-gapped file** never touches the network.
- **Data hub.**
  - Imagery opens by range from https, S3 and GCS, and STAC catalogues can be searched over the view. Folders are watched, and unnamed files are recognised by their content.
  - A Convert drop zone writes GeoJSON, GeoParquet and FlatGeobuf, and Cloud-Optimized GeoTIFF of any size.
  - A Job Queue shows progress, speed, time left and Retry.
- **Local AI from model packs**, on WebGPU or the CPU:
  - SAM 2.1 smart select with square corners, Find Objects (OWLv2), Search Imagery (CLIP), Auto Align (DISK + LightGlue) and Auto Contrast.
  - A copilot that runs plain requests on these tools first. Every model is MIT or Apache-2.0.
- **Recipes:** workflows run as a visible stepper. Change a step and re-run from there, pause at review gates, and share recipes as files. Four are built in.
- **Send to:**
  - Photoshop (layered PSD with live Levels and Curves, or 16-bit TIFF with a Curves preset).
  - Illustrator (layered PDF and SVG).
  - Blender, Unreal and iOS (GLB and USDZ terrain).
  - ATAK (CoT and data packages).
  - Google Sheets (through your own relay).

### Changed
- GIS Workbench starts Offline until you choose.
- Classification banners show automatically for imagery marked above UNCLASSIFIED, and always on request.
- The north arrow became a small compass.
- **Classic** (View ▸ Display ▸ Interface Layout) restores the 1.x Ribbon, Quick Access Toolbar, KeyTips, Layer Manager, Cue Cards and GXP-style themes.

### Known limits
- **Planned for 2.1:**
  - The whole-earth globe and an offline world basemap pack.
  - The vision-language drafter and the change mask after Auto Align (AI).
  - Live TAK Server sending, and Drive or OneDrive through their APIs.
  - Search indexes kept between sessions.
  - A spatial index in FlatGeobuf output.
- **Not yet checked in their target apps:** the Photoshop, Illustrator, Blender, Quick Look and ATAK hand-offs. Each file is checked by an independent reader in the tests.

## [2.0.0-rc.2] - 2026-10-28

Bridges to the tools around GIS Workbench, the seventh step of 2.0 (phase P7), with the first hardening work of P8, as release candidate 2. Requirements REQ-HUB-01..04 and REQ-HUB-06; REQ-CNV-01..02 completed.

### Added
- **Send to** (Products ▸ Send to, or the Products rail menu). Every file is written on this computer.
  - **Photoshop (PSD)**: the view as layers. The raw image comes first, then **Levels** and **Curves** adjustment layers that rebuild the GIS Workbench look and stay editable, then the graphics. A world file comes with it. (REQ-HUB-01)
  - **16-bit TIFF + Curves**: the view at 16 bits with its georeference, plus a Photoshop Curves preset (`.acv`) for the same look. (REQ-HUB-01)
  - **Illustrator (Layered PDF)** and **Layered SVG**: each opens with its layers: imagery, graphics, each vector layer, neatline and scale bar. The vectors are real paths. (REQ-HUB-02)
  - **3D Terrain (GLB)** for Blender and Unreal, and **3D Terrain (USDZ)** for iPhone and iPad. The ground in view becomes a textured mesh, with heights from a loaded DEM. (REQ-HUB-03)
  - **CoT Events** and **ATAK Data Package** cover markers, observations, accepted detections (typed by class) and outlines, plus the session chips. They are for ATAK, WinTAK and iTAK and work in every build, including the air-gapped one. (REQ-HUB-04)
  - **Send to Google Sheet** (experimental): appends markers, observations and accepted detections as rows through an Apps Script relay you deploy in your own Google account. Each request is signed with a secret that is not stored. (REQ-HUB-06)

- **Convert any image to COG.** Images above the in-memory limit (256 million samples) now convert by streaming: one row of tiles in memory at a time, temporary tiles in browser storage, and BigTIFF past 4 GB. A 432-million-sample orthophoto converts in under three minutes. (REQ-CNV-01)
- **FlatGeobuf** output in Convert, next to GeoJSON and GeoParquet. The file has no spatial index yet. (REQ-CNV-02)
- **Help:** new topics: What’s new in 2.0, Coming from 1.x (Classic), Online, Cloud data and conversion, Local AI, Recipes, and Send to other tools.

### Known limits
- **Photoshop:** the PSD is 8-bit; use the 16-bit TIFF for full depth. Local contrast (CLAHE) and sharpening are not rebuilt as layers.
- **Not available yet:**
  - Live TAK Server sending (REQ-HUB-05).
  - Drive and OneDrive saving through their APIs.
  - Opening published Google Sheets directly; Google's CSV links do not allow it. Use a synced folder or a downloaded CSV.
- **Not yet checked in the target apps:** Photoshop, Illustrator, Blender, Quick Look and ATAK. Each file is checked by an independent reader in the tests.

## [2.0.0-rc.1] - 2026-10-28

Recipes, the sixth step of GIS Workbench 2.0 (phase P6) and the first release candidate. A workflow runs as a row of steps you can watch, pause, adjust and share. Requirements REQ-PIP-01..04.

### Added
- **Recipes** (navigation rail ▸ Recipes, or Image Tools ▸ Recipes). A recipe runs one step after another in a stepper along the bottom. Each step shows its state, its result (“11 building”, “135 tie points”) and its time. (REQ-PIP-02)
- **Change a step and re-run from there.** Click a step to open its parameters (the objects to find, a threshold…). A change marks that step and the ones after it as stale, and **Re-run from here** runs them again. (REQ-PIP-02)
- **Review gates.** The recipe pauses with the candidates on the map and the review queue open. Accept or reject them (✓ / ✗, or J then 1 / 2 / 3), then press **Enter** or **Resume**. (REQ-PIP-03)
- **Built-in recipes** (REQ-PIP-04):
  - **Airfield triage**: auto contrast, find aircraft, review, then a chip deck and a GeoJSON of the accepted ones.
  - **Damage triage**: co-register (AI), find damage, review, GeoJSON.
  - **Convert a folder to COG**.
  - **Building extraction**: find buildings, outline and square each with SAM 2.1, review, GeoJSON.
  - Each is a command, so it can go on the radial menu or the Quick Access Toolbar. The AI Analyst persona has Airfield triage on its radial menu.
- **Recipes as files.** **Save…** writes the recipe with your parameters as `.gwrecipe.json`. **Open…** loads one and keeps it in your list. (REQ-PIP-01)

## [2.0.0-beta.4] - 2026-10-28

Local AI, the fifth step of GIS Workbench 2.0 (phase P5). The models run on this computer, on the graphics card when it supports WebGPU and on the processor otherwise. Nothing is sent anywhere. Requirements REQ-LAI-01..03 and REQ-LAI-05..09.

### Added
- **AI model packs**, each opened once with File ▸ Open ▸ Open Data Pack and kept for later sessions. They are attached to the release, beside the HTML files. (REQ-LAI-01, REQ-LAI-08)
  - `ai-sam2`: SAM 2.1 click-to-polygon.
  - `ai-detect`: OWLv2 open-vocabulary detection.
  - `ai-search`: CLIP semantic search.
  - `ai-match`: DISK + LightGlue matching.
  - Every model is Apache-2.0 or MIT, and the build refuses any other licence.
- **Smart Select uses SAM 2.1** when its pack is loaded. **Square Corners** gives building outlines right angles. After the first click on an area, each click takes well under a second. (REQ-LAI-02)
- **Find Objects (AI)**: name what to look for (“aircraft, vehicle”) and the objects in view go to the detections review queue, to accept or reject. J / K steps through them. (REQ-LAI-03)
- **Search Imagery (AI)**: describe a place (“unpaved runway”). The best matches in the image are outlined and the view flies to the first. (REQ-LAI-06)
- **Auto Align (AI)**: lines up two images by matching learned keypoints. It works across dates and sensors, and is next to Auto Align in Image Tools ▸ Align. (REQ-LAI-05)
- **Auto Contrast**: local contrast and brightness set from the image in one undoable step. (REQ-LAI-07)
- **The AI dock works without a connection.** Plain requests such as “detect aircraft in view”, “search for flooded fields”, “auto contrast”, “align to the reference” or “go to 38SMB4484” run on the local tools first. A connected assistant can use them too. (REQ-LAI-09)
- **AI Device** shows whether the graphics card is used, the device tier and which model packs are loaded. It can also force the CPU. (REQ-LAI-01)

### Changed
- The `ai` pack now also carries the WebGPU runtime.

### Known limits
- Devices without WebGPU run the models on the processor, slowly; the commands stay available. On integrated graphics the 8-bit models gain little from WebGPU.
- Not yet available:
  - The vision-language drafter (REQ-LAI-04).
  - The change mask after Auto Align (AI).
  - Search indexes kept between sessions or built over whole folders.

## [2.0.0-beta.3] - 2026-10-28

The data hub, the fourth step of GIS Workbench 2.0 (phase P4). Imagery in the cloud opens by range, catalogues can be searched over the view, folders are watched, and legacy formats convert to cloud-native ones from one drop zone. Requirements REQ-CON-01..06, REQ-ING-01..03 and REQ-CNV-01..03.

### Added
- **Open from URL** (top bar, palette or Catalog): an https, `s3://` or `gs://` address of a GeoTIFF, COG or NITF opens by byte range. Only the header, the overviews and the tiles in view are read, never the whole file. Paste an address into Ctrl+K to open it. (REQ-CON-03)
- **Catalog panel** (navigation rail ▸ Catalog). (REQ-CON-02, REQ-CON-04, REQ-CON-06)
  - Search **Earth Search** or **Microsoft Planetary Computer** over the view by collection and dates. Footprints draw on the map and an item opens with one click, with Planetary Computer assets signed automatically.
  - Browse **S3 buckets** (public ones as they are; private and MinIO ones with keys held in memory for the session; GCS through its S3 interface).
  - Bookmark **local folders**, catalogued and watched for new files while the app is open.
- **Convert** (navigation rail ▸ Convert): drop Shapefile zips, KML/KMZ, GPX, GeoPackage, CSV or GML to get **GeoJSON** or **GeoParquet 1.1**. Drop GeoTIFF, NITF, JPEG 2000 or DTED to get a **Cloud-Optimized GeoTIFF** (512 px tiles, Deflate, overviews). Opening a large raster that is not cloud-optimized offers to make a COG copy. (REQ-CNV-01..03)
- Dropped **folders** are walked, and files whose names say nothing are recognised by their content. (REQ-ING-03)
- The **Job Queue** shows a progress bar and time left for each job, network throughput, and **Retry** for a file that failed to open. (REQ-ING-02)

### Changed
- A new image shows its outline with a moving dash as soon as its header is read, and the file fingerprint is computed in the background. (REQ-ING-01)

### Known limits
- COG conversion works in memory up to 256 million samples (for example 9 200 × 9 200 × 3). A streaming converter for larger images is planned. FlatGeobuf output and GeoParquet input are not available yet.

## [2.0.0-beta.2] - 2026-10-28

Network, basemaps and 3D, the third step of GIS Workbench 2.0 (phase P3). Basemaps work out of the box once you choose to work online. An air-gapped file never touches the network. A 3D button shows the place in perspective. Requirements REQ-NET-01..05 and REQ-GLB-01..02.

### Added
- **Online / Offline switch** in the status bar. While Offline no request leaves this computer, whatever the file allows. GIS Workbench starts Offline until you choose, on the first-start card or with the switch, and a site can lock it. (REQ-NET-02)
- **Built-in basemaps under and around georeferenced imagery**, drawn in the image panels through the image's own sensor model. Pick one from the corner button: Sentinel-2 cloudless satellite, USGS topographic and imagery (United States), NASA relief and night lights, or OpenStreetMap streets (opt-in, under its tile policy). The attribution is always shown and every tile is listed in the Network Log. (REQ-NET-04)
- **Reviewed public origins** built into the file, each with its purpose, licence and policy (`build/origins.json`): the basemaps above, AWS Terrain Tiles, Earth Search and Planetary Computer catalogues, and open data buckets. Before, every origin had to be added by hand and the file saved and reloaded. (REQ-NET-01)
- **Air-gapped file** `gis-workbench-airgap.html`, the same app with no network origin at all. (REQ-NET-03)
- **PMTiles basemaps**: open or drop a raster `.pmtiles` file and it becomes the basemap, read by range from your disk and working offline. (REQ-NET-05)
- **2D / 3D button** on georeferenced image panels. It builds an oblique 3D scene of the same place with terrain from a loaded DEM (else, online, from AWS Terrain Tiles), the image draped through its sensor model and the basemap around it, and goes back to 2D. (REQ-GLB-01, REQ-GLB-02)

### Changed
- An online background that the file cannot reach now explains whether GIS Workbench is offline or the site is not allowed, and offers the fix.

## [2.0.0-beta.1] - 2026-10-28

The Modern shell, the second step of GIS Workbench 2.0 (phase P2). In the Modern layout the Ribbon makes way for an app bar and a navigation rail, tools come to the cursor, docked panels tile instead of floating over the image, and three workspace personas set everything up in one click. The Classic layout still runs every 1.x workflow, and it can be switched on and off without a restart. Requirements REQ-SHL-01 and REQ-SHL-08..13.

### Added
- **App bar and navigation rail** (Modern layout). The app bar holds the main menu, the search box (Ctrl+K), Open, Undo, Redo, Save, the workspace switcher, the theme toggle, feedback, settings and help. The rail opens the Catalog (Workspace window), Layers, Tools, Measure, AI and Products. The Multiport loses its title bar, Quick Access Toolbar and Ribbon, and the status bar shows one row. (REQ-SHL-01)
- **Contextual tool pill**: a floating bar at the top of the active panel with the tools that matter for what is selected (image, DEM, multiband, SAR, video, stereo, point cloud, vectors or selected graphics). **More…** opens the palette. View ▸ Display ▸ Contextual Tools hides it. (REQ-SHL-08)
- **Radial menu** at the cursor with 6–8 tools: tap Space, drag with the right button, press `, or long-press on pen and touch. Choose by pointing, clicking, the number keys or the arrows. Holding Space still pans and middle-drag still roams. (REQ-SHL-10)
- **Cursor shortcuts** (REQ-SHL-11):
  - Hold **F** to see the image underneath.
  - Hold **S** for a swipe curtain at the cursor.
  - **Alt + wheel** sets the layer's opacity.
  - **C + drag** makes a full-resolution quick chip. It goes to the clipboard and to a session deck that **Export Session Deck** saves as PowerPoint.
  - **Ctrl+V** on a panel flies to a coordinate found in the pasted text (MGRS or decimal degrees, even inside a sentence).
  - **J / K** step through markers, detections and observations at the current zoom, and **1 / 2 / 3** triage the current one as clear, active or flagged.
- **Workspace personas** (REQ-SHL-12):
  - *Imagery Explorer & Converter*: a clean canvas.
  - *AI & Exploitation Analyst*: the AI dock, smart selection and detection review.
  - *Mensuration & Photogrammetry Pro*: Layers and the Mensuration Log docked, two status rows.

  Each sets the layout, the open panels, the radial tools and the status rows. The first start offers the choice on a card over the empty panel. Save your own set-up from the workspace button; sites can ship one through Common preferences.
- **Material 3 themes**, light and dark, from the design tokens. The Modern layout starts in dark, and the theme button switches. The GXP grey, dark and print themes stay for Classic. (REQ-SHL-13)

### Changed
- **Docks tile** (REQ-SHL-09):
  - Drag a tab to the left, right or bottom edge, or onto the lower half of an open dock to show two panels at once.
  - Collapse a dock to a strip of icons.
  - Dock sizes are remembered.
  - In the Modern layout the tool editors that used to float over the image (Tonal Curve, Blend, Brightness and the other modeless editors) open as panels in the right dock.
- **Interface Layout** switches between Modern and Classic at once, keeping the project, the view and the selection. (REQ-SHL-01)

## [1.3.0] - 2026-10-28

A clean canvas, the first step of GIS Workbench 2.0 (`Docs/SDP-2.0-modernization-plan.md`, phase P1), in answer to a first user's UI review. The app now starts on one edge-to-edge image panel and brings tools to you instead of showing them all at once. The 1.x layout is one setting away. Requirements REQ-SHL-01..07.

### Added
- **Command palette (Ctrl+K)**: find and run any command, layer, bookmark or recent project by typing part of its name. A command that cannot run yet says why. Type or paste a coordinate (MGRS, decimal degrees, DMS, UTM…) and press Enter to fly there. (REQ-SHL-05)
- **Two-line tooltips** on every button: its name and shortcut, then what it does in plain words, why it cannot run now (if so) and a link to help. Every one of the 455 commands has a plain-language description. (REQ-SHL-06)
- **Compass button** in the bottom-right corner of each panel: it turns with the view, and a click turns the view north up. It replaces the north arrow drawn on the image; Preferences ▸ Display ▸ North indicator brings the arrow back. (REQ-SHL-04)
- **Job indicator** in the status bar: a progress ring with the number of running jobs; click it for the Job Queue. (REQ-SHL-07)
- **"Zoom to layer"** on the message that confirms an opened image. (REQ-SHL-07)
- **Interface layout** (View ▸ Display, or Preferences ▸ Display): Modern (default) or Classic, the 1.x start with Layer Manager and Cue Cards open, the Workspace window shown and the north arrow on the image. (REQ-SHL-01)

### Changed
- **Clean start**: no dock is open, and the Workspace window is folded into a rail on the left. Click the rail or use View ▸ Windows ▸ Workspace Window to open it. (REQ-SHL-02)
- **Classification banners** appear on their own only when an open image carries a marking above UNCLASSIFIED (or one that cannot be read). View ▸ Decorations ▸ Classification Banners shows them always, and Preferences ▸ Security Markings can turn them off. Products, captures and AI consent keep their marking rules. (REQ-SHL-03)
- **Messages** show at the bottom centre, at most three at a time, each with a close button. A repeated message is shown longer rather than twice. (REQ-SHL-07)
- **Online maps**: an online background whose site is not allowed yet explains this in plain words and offers **Enable online maps…**, which opens the allow-list with that site filled in. Before, this was an error about the CSP allow-list.

## [1.2.1] - 2026-10-28

Field-data campaign (phase F): real production imagery supplied by a first user: Pléiades and DigitalGlobe ortho packages (ZIP, DIMAP), JPEG-tiled GeoTIFF tile sets, Intermap dual-pol SAR intensity and MrSID mosaics. Findings TE-059 onward.

### Added
- **Imagery in ZIP deliveries** opens without unpacking: DigitalGlobe/Maxar tile-set ZIPs (including ZIPs of ZIPs) and Pléiades DIMAP volumes. A picker lists the files with the imagery, its sidecars and the vector overlays ticked; quick looks and masks are offered but not ticked. ZIPs of vector files open as before. (IMP-21, TE-064)
- **Pléiades/SPOT DIMAP metadata** (`DIM_*.XML`): the product's own RGB band order, the scene time and the sun azimuth/elevation for the shadow and sun tools. (IMP-22)
- **GML** vector files open, including the DIMAP product masks (cloud, snow, footprint…); an empty mask opens with a note. (IMP-23, TE-065)

### Changed
- **Change Detection** on images over 32 M pixels screens the whole scene at a reduced resolution instead of asking for an AOI first; an AOI is still compared at full resolution. (IMP-25)
- JPEG-compressed GeoTIFFs without overviews display several times faster: the browser's own JPEG decoder is used, each block is decoded once for all bands, and statistics reuse the coarse levels (a 16384² DigitalGlobe tile: first full view 125 s → 28 s). (IMP-24, TE-066)

### Fixed
- Big-endian GeoTIFFs with many tiles (DigitalGlobe/Maxar JPEG tile sets) failed with "SOI not found": the tile tables were read in the wrong byte order. (TE-060)
- JPEG-compressed YCbCr GeoTIFFs were shown and analysed as raw Y/Cb/Cr instead of RGB (wrong colours and band values). (TE-062)
- MrSID files are refused by name, with the image size and how to convert them, instead of as "unrecognised data". (TE-061)
- Classification, clustering, target/anomaly detection, PCA/MNF and spectral change run on large images: the active AOI, else the whole image read at every k-th pixel (with a note), and the result is placed correctly. Destripe, which needs full resolution, works on the AOI or the largest window around the view centre. (TE-069)
- A Pléiades/SPOT image is dated by its DIMAP acquisition time, not by when its TIFF was written. (TE-068)
- A delivery ZIP whose packages are themselves deflated ZIPs (DigitalGlobe NextView) is recognised as imagery. (TE-067)
- `.sdw` and `.tifw` world files are read as world files instead of failing as images. (TE-063)
- A LAZ file whose chunk table claims an impossible number of chunks is refused by name; it used to abort the point-cloud worker on a multi-gigabyte allocation. (TE-059)

## [1.2.0] - 2026-10-27

Validation on real data that the earlier campaigns could not reach: NASA EMIT hyperspectral scenes, IEEE GRSS Data Fusion Contest hyperspectral and LiDAR, Maxar WorldView-3 change pairs, real drone video with flight logs, Capella and Umbra SAR chips, and accuracy checks against GDAL and numpy that were planned but never run. The defects they found are fixed.

### Added
- **Layer Stack** (Analyze ▸ Spectral) combines one-band files on the same grid, such as Landsat and Sentinel-2 band files, into one multiband image, so composites, indices such as NDVI and Band Math work across them. Each band keeps its radiometry and metadata. (TE-056)
- Landsat 8/9 and Sentinel-2 band files are recognised by name (`…_B10.TIF`, `…_B8A.jp2`): sensor metadata maps to the right band, and band names and centre wavelengths are filled in. (TE-054, TE-056)
- **Brightness Temperature** asks for the Landsat MTL when the band is still DN and converts it to radiance first; it is also on Analyze ▸ Spectral. (TE-054)
- CCD warns when a pair cannot be coherent: it estimates the perpendicular baseline, height of ambiguity and range-spectrum overlap, and flags a large registration residual. (TE-051)
- A STANAG 4607 file with platform locations but no dwells opens as a platform track. (TE-047)

### Changed
- Maximum-likelihood classification regularises each class covariance toward the pooled covariance, with the weight chosen by cross-validation on the training pixels; on 220-band Indian Pines overall accuracy rises from 0.50 to 0.87. (TE-058)
- Change Detection takes images up to 32 M pixels, scopes a larger image to the active AOI, and reads only the part of date 2 that covers date 1. (TE-052)
- Radiometric Conversion and Band Math work on one-band images. (TE-054, TE-056)
- Aspect and the hillshade sun azimuth say they are measured from true north. (TE-055)
- Video metadata imported from a CSV is labelled as CSV, not KLV, in the HUD and status bar. (TE-050)

### Fixed
- GeoTIFF internal masks (GDAL PER_DATASET mask bands) are honoured: masked pixels are no-data, so statistics and change detection no longer count fill. (TE-053)
- ENVI headers with UTM map info on NAD83 or NAD27, or any datum with a coordinate system string, are georeferenced; they used to open without a map model. (TE-048)
- Reading a second full-resolution Sentinel-2 JPEG 2000 band no longer fails with "unreachable". (TE-057)
- Brightness temperature on a Landsat B10/B11 file uses that band's K1/K2 instead of returning no-data. (TE-054)
- Auto Enhance keeps the current band composite; it used to restore the default bands after a preset. (TE-049)
- A STANAG 4607 file with no dwell or platform location segments is refused by name, listing what it holds, instead of opening as nothing. (TE-047)

## [1.1.0] - 2026-10-27

A full GUI test and validation campaign over both the Standard and Lite files: every ribbon control, menu, dialog, dock, context menu and hot key was actuated through real pointer and keyboard input, in Chrome and Edge, and the defects it found are fixed.

### Added
- **Help ▸ What's New** shows this changelog inside the app; About & Diagnostics shows the edition (Standard or Lite) and links to it. (GUI-008)
- **Stereo Panel** on the Layer Tools tab, so a stereo pair can be opened from the ribbon. (GUI-012)
- **Observation Toolbox** on Products ▸ Reports and a **New observation…** button in the Observation Table, so the first observation can be made from the GUI. (GUI-013)
- **View ▸ Import Log** in the Workspace menu opens the Import Log dock. (GUI-005)
- **Ctrl+F1** minimises and restores the Ribbon, as its tooltip always said. (GUI-003)
- GIS Workbench Lite marks the 3D, LiDAR and SAR-analysis commands it cannot run: they are greyed out with a tooltip that points to the Standard file. (GUI-007)
- A hot key for a command that cannot run yet says so instead of doing nothing. (GUI-010)

### Changed
- The View ▸ Split button toggles between one panel and the last split layout chosen from its menu; it used to do nothing. (GUI-004)
- The Ribbon tab strip tightens its tabs when contextual tab sets would run past the window edge, and long set captions end in an ellipsis. (GUI-014)
- A split button's menu is greyed out with its button, and an empty menu says there is nothing to choose. (GUI-015)
- "Do this first" messages (draw an AOI first, open a video first, no AI connection yet) are warnings, not red errors; the AI one offers **Set up…** to open AI Connections. (GUI-018, GUI-019)
- Pauli composite, 3D Sync, Xport and Clip export are greyed out until they can run, instead of failing when clicked. (GUI-022)
- Toasts no longer block clicks on what is underneath them, such as the video transport bar; their own buttons still work. (GUI-020)
- The mouse wheel scrolls a Ribbon that is wider than its window. (GUI-017)
- Status-bar cells that end in an ellipsis show their whole value as a tooltip. (GUI-024)

### Fixed
- Panels redraw when the browser window, a splitter or a dock changes their size; before, part of the panel could stay black until the next pan or zoom. (GUI-011)
- In Lite, opening a 3D view or playing video now names the module Lite leaves out instead of reporting an internal "is not a script block" error. (GUI-001)
- LAS/LAZ export writes the GIS Workbench version into the file's generating-software field. (GUI-002)
- Undoing the opening of an image no longer raises an error, and the Map View footprint and the Math Model read-out go with it. (GUI-021)
- Closing a menu also closes its open submenu; before, the submenu stayed on screen and blocked clicks. (GUI-025)
- Esc closes a panel context menu straight after the right-click, and the arrow keys move into it. (GUI-026)
- Xport checks the image before changing the panel layout. (GUI-022)
- Long processing-chain parameters wrap in the Chain Editor instead of scrolling it sideways. (GUI-023)
- About & Diagnostics shows the protocol without a stray colon. (GUI-016)

## [1.0.0] - 2026-10-27

First public release: a single-file, offline imagery exploitation and photogrammetry workbench for Chrome and Edge.

### Added
- Imagery: NITF/NSIF (with JPEG 2000 and RPF/CADRG), GeoTIFF/COG, JPEG 2000, ENVI, HDF5, GeoPDF, SICD/SIDD and DTED, with sensor models (RPC, RSM, frame, pushbroom) and live geopositioning.
- Exploitation: mensuration, stereo viewing and extraction, orthorectification and mosaics, terrain analysis and line of sight, multispectral and SAR tools, full-motion video with KLV, point clouds and 3D scenes.
- Products: chips, templates, PowerPoint, PDF and GeoPDF, KMZ, DOCX reports and GIF/WebM animations, with classification markings.
- Vectors and features: GeoJSON, KML/KMZ, shapefile and GeoPackage, capture and edit tools, attribute tables and validation.
- AI assistant with an allow-listed provider, MCP client and server, and a whiteboard feedback tool.
- GIS Workbench Lite: a smaller file for size-limited embeds that leaves out the 3D, video, LiDAR and SAR-analysis modules.
