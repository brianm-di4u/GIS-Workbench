# Changelog

All notable changes to GIS Workbench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.7.1] - 2026-11-14

GIS Workbench 2.7.1 is a civilian-use application: it is designed and intended for civilian use only, and should not be used for any military purpose. This release brings time-series analysis, a visual workflow builder over recipes, geocoding and routing on your own data, feature catalogues from standard files, and SAR terrain correction and stereo DSM levelling into the file. It carries Sidecar 0.4.0, which adds a command-line runner for scheduled batch work and structure from motion tied to surveyed ground control.

### Added
- **Time series of images.** Time Stack puts dated images in date order on one grid, and NetCDF-3 time axes keep their dates in every CF calendar. The Time Series panel has a date slider with playback and recording, and plots the values over time at the cursor, at a pinned point or over the AOI, with CSV export. Temporal Trend gives the slope per year and its p-value at every pixel, and Temporal Anomaly compares each date with a baseline period.
- **Geocoding and routing on your own data.** Address Index, Find Address, Geocode a Table and Reverse Geocode work from your own address layer, and an index can be saved as a GeoPackage. Road Network builds a graph from your own roads, with one-way streets, speeds and turn bans, for Shortest Route and Service Area. Nothing is sent anywhere.
- **Workflow Builder.** Add-Ins ▸ Recipes ▸ Workflow Builder wires steps into a workflow, each output to the next step's input, with its types checked. Buffer, overlay, dissolve, join, the hydrology steps, endmembers and export are steps of their own. A workflow is saved in the project and in your library in this browser, runs again on new inputs, and is shared as a .gwrecipe.json file. Every layer it makes records the workflow, its version, the step and its settings. When a project and your library hold different workflows under the same id, the Recipes picker lists both, marked project and library, and API v2 recipes.run asks which with source: nothing is replaced without your choice.
- **Feature catalogues from standard files.** Feature Tools ▸ Attributes ▸ Import Feature Catalogue reads an ISO 19110 feature catalogue, an INSPIRE application schema with its code lists, or OpenStreetMap presets in the iD editor's presets.json and fields.json, for New Layer from Schema. Coded values keep their codes, leading zeros included.
- **OpenStreetMap feature catalogue pack.** The `catalogue-osm` data pack holds the iD editor's OpenStreetMap presets: about 1,500 feature types with their tags, fields and English names. Open it from Data Packs, and New Layer from Schema offers its types. When you pick a type's subtype, its tags, such as amenity=cafe, are filled in on every new feature.
- **SAR ▸ Terrain Correction** geocodes a Sentinel-1 SLC image onto an elevation model with its orbit, flattens it to γ⁰ by projected area, and adds a layover and shadow mask. It uses a precise (POEORB) or restituted (RESORB) orbit file when you open one that covers the image, and the annotation's orbit otherwise. GIS Workbench does not download orbit files.
- **Level DSM on Reference** removes a SAR stereo DSM's vertical offset, and optionally a tilt, against a reference DEM over stable terrain, and states the residual. It also works on any DEM opened as terrain, in its heights on the ellipsoid.
- **Structure from motion with ground control:** in the sidecar, a drone block can now be tied to surveyed ground control points. The run has two stages. The first builds the sparse model. Then you mark each control point in the photographs, where the app predicts its place, and the second stage adjusts the block to the control, weighted by each point's stated accuracy, and makes the DSM and orthophoto. The report gives checkpoint errors before and after the adjustment. Control in WGS 84 / UTM only. Sidecar only. (REG-075)
- **Command-line runner:** the sidecar now has `gwb-run`, which runs a recipe with no page open, in your installed Chrome or Edge. `gwb-sidecar run` does the same with no window, for Task Scheduler. Nothing listens on a network port. (REG-150)
- **Scheduled runs:** the runner guide shows how to run a recipe every night with Task Scheduler, cron or a systemd timer. The sidecar registers no task itself. (REG-151)
- **Help on running recipes unattended.** Help has a topic on `gwb-run`, the sidecar's command-line runner.

### Changed
- **Recipes are kept in a library with no limit.** The recipes you open or save are kept in this browser's library, where the settings kept only the last 20. Recipes from the settings move there the first time.
- **Opening a project with other files says what wasn't opened.** A project opens on its own, so files dropped or opened together with it were left out without a word. Now a message names them, and so does the import log. Open those files after the project.
- **Calibrated Sentinel-1 bands** (β⁰, σ⁰, γ⁰) show the zero fill at burst and swath edges as no data, so it is transparent and left out of statistics. It used to read as −300 dB.
- **SAR stereo DSM files** now record their product, pair side and prior DEM as GDAL metadata, with band names that other GIS tools show. Files saved by 2.6 are still read by their description, so they keep their flags when you reopen and level them.
- **API reference:** the TypeScript reference is now `gisworkbench-api-3.d.ts`, named for API 3.0.0. The old name, `gisworkbench-api-v2.d.ts`, still works through 2.7.2. (REG-179)
- **Sidecar 0.4.0:** adds the command-line runner and scheduled runs, and structure from motion tied to ground control. Its outputs and API stay compatible with 2.7.0.
- **File Geodatabase catalogues: a field two classes define differently.** Each class now keeps its own definition of the field, its values and whether it is required, where the import kept the first and warned. Layers still use the field's own name, such as `status`. One class's subtype values no longer leak into another's, and catalogue rules and subtype defaults on such a field now apply. Import the catalogue again to get this.

### Fixed
- **Basemaps draw again after the graphics context comes back.** When the browser dropped and restored the map's graphics context, for example on a phone that was put away, basemap tiles already loaded stayed blank. They are now loaded again.
- **Lite starts on iPhone and iPad even when Safari drops the graphics context during start-up.** It used to stop with "GIS Workbench failed to start" and need a reload. Now it starts, and the map draws as soon as Safari gives the graphics context back. Full has the same fix.
- **The radial menu on a slow graphics card.** A quick tap of Space over the image now opens the radial menu even while the picture is slow to draw. Before, it could be taken for a held Space and open nothing.
- **Sidecar creation options** whose value has an `&` or `<` in it stay one value. They were split in two.
- **Saving to browser storage no longer waits forever** when the browser aborts the save, for example on a full disk. That hung the recovery journal, the sidecar pairing store, the feature catalogue store and the local AI model store. A failed save now reports its real cause, where it reported none.
- **Translations:** an Erase overlay's new layer is named with the Operation's own word in every language, where German named it "A Radieren B".

### Known limits
- **Structure from motion with ground control** doesn't model a rolling shutter, needs GPS in the photographs for the first stage, and refuses control in a different UTM zone from the block.
- **Routes start and end at junctions.** Shortest Route and Service Area snap each click to the nearest junction or line end within 500 m. The stretch from the click to that junction is not in the route's length or time.
- **Trend and anomaly take at most 1,024 dates.** A longer series is refused with a message; make a Time Stack of fewer dates.
- **Dates come from NetCDF-3 (classic) files only.** The time axis of a NetCDF-4 file is not read yet; make a Time Stack from its dated images instead.

## [2.7.0] - 2026-11-12

GIS Workbench 2.7.0 is a civilian-use application: it is designed and intended for civilian use only, and should not be used for any military purpose. This release brings core GIS work into the file: vector geoprocessing, hydrology, point-cloud cleaning in the profile view, automatic endmembers, the EGM2008 1′ geoid and Annex 14 Amendment 18. Lite can now save and open projects, and the Full file starts faster. It carries Sidecar 0.3.1, with updated dependencies and a fix to the native stereo viewer.

### Added
- **Vector geoprocessing:** Buffer, Overlay (intersect, union, erase and symmetric difference), Dissolve and Spatial join (intersects, within, contains and nearest), in a new Geoprocessing group on the Feature tab. Results match GEOS. Buffers can be planar or geodesic. (REQ-GAP-79, SCN-67)
- **Hydrology:** Surface Tools ▸ Hydrology has Fill Sinks, Flow Accumulation (D8 or D-infinity), Stream Network (Strahler order and Shreve magnitude) and Watershed from a pour point, checked against WhiteboxTools. A grid over 48 million posts is refused by name. Full only. (REQ-GAP-80, SCN-68)
- **Clean point clouds in the profile view:** select points, then reclassify, withhold or delete them, with undo, and export the result. (SCN-69)
- **Automatic endmembers:** Spectral ▸ Automatic Endmembers finds endmember spectra in a hyperspectral image, with a Pixel Purity Index layer. It can add them to the spectral library and unmix with them in one go. Full only. (REQ-GAP-82, SCN-70)
- **EGM2008 1′ geoid pack:** an optional 80 MB pack of GeographicLib's 1′ grid, within 1 mm of GeographicLib. When loaded, it becomes the active geoid. (REQ-GAP-16, SCN-71)
- **Annex 14 Amendment 18:** Obstruction Surfaces can draw the obstacle free and obstacle evaluation surfaces that apply from 21 November 2030, beside the current edition and FAA Part 77. An edition selector defaults by the analysis date. Each runway takes its aeroplane design group and maximum take-off mass. Where the amendment is silent, each run lists the readings it assumed. (REQ-GAP-78, SCN-72)
- **Assign CRS to LAS and LAZ:** a cloud with no usable CRS can be given one, so it can be placed. (REQ-LDR-14, SCN-73)
- **Lite projects:** Lite can save, open and relink a project file, the same `.gwb` as Full. A Full project survives a Lite edit, and Lite names what only Full shows. (REQ-GAP-86, SCN-75)
- **SBOM for the web app:** each release now carries a CycloneDX SBOM for the HTML files.

### Changed
- **Faster start:** the Full file starts in about 1 s at 4× CPU slowdown on the reference machine, and Lite in under 0.8 s, against a 1.5 s target. The Full file is about 8.0 MB. (REQ-PRF-01, SCN-74)
- **EGM2008 2.5′ heights** are now interpolated cubically, within 1 mm RMS of GeographicLib. They were up to 13.5 cm off. Heights already converted and saved don't change.
- **Terrain from projected DEMs** keeps all its posts, instead of being thinned to 2,048 a side. Tools that walk the grid take longer on large DEMs.
- **LandXML import** keeps the file's own triangles, so a round trip changes nothing. A breakline that crosses faces away from their vertices still splits them, and the import says how many faces changed.
- **No freeze** when a large vector or GeoPackage layer is imported, or a large project is saved or opened. (REQ-ING-04)
- **Sidecar 0.3.1:** updated dependencies, and the native stereo viewer now fetches each tile once, where it could fetch a tile twice while drawing fell behind (#68).

### Fixed
- **LAS warnings** name the geoid in use. They always said EGM96.
- **Derived DEMs** keep their vertical datum, and DEM tools convert heights as their terrain does.
- **Flight-plan refusals** can now be translated. They always showed in English.
- **Crash recovery:** recovering after a save keeps the saved work and the panel views, and a second crash after Recover replays each edit once.
- **Photoshop export** writes its Levels and Curves adjustments again.
- **glTF 1.0** materials whose diffuse names a texture through an array now show that texture.
- **Projects with Windows paths** open with the fast parse.
- **Lite:** a long press opens the point sheet even when a busy page handles the release first.
- **Firefox** no longer reports a security-policy violation for a missing page icon.

### Known limits
- **Size budgets:** three WASM bundles are over their own budgets, within the build's 10 % margin: pointcloud by 6.3 %, sar by 2.7 % and tin by 1.7 %.
- **Hydrology** routes flats with priority-flood, as most tools do. WhiteboxTools routes them differently, so on a 1 m DEM a tributary can join at a different post and the highest Strahler order can differ by one.
- **Geodesic buffers** of features hundreds of kilometres long, and nearest-join distances to candidates that far away, can be off by up to 2 %.
- **Automatic endmembers** show a moving bar with no percentage on a large cube, which can take tens of seconds.
- **EGM2008 1′ pack:** converting a DEM wider than 160° of one 5° band re-reads tiles on every row, so a continental or global DEM is slow.
- **Annex 14 Amendment 18:** the edition switch uses the UTC date, so it can switch a day early or late in some time zones.
- **Point-cloud edits** and assigned CRSs stay with the open cloud and aren't saved in the project file.
- **Lite projects** were tested with phone emulation, not on a real phone, so the share sheet is untested.
- **Large imports and saves:** past about 400,000 features, one step of a vector import, a save or an open can still pause the page for over 2 seconds.
- **Translations** of the messages new in 2.7.0 are AI draft and AI review, with no native-speaker review. Right-to-left and complex-script locales are still to come.
- **LandXML:** no real Civil 3D or OpenRoads file has been tested.
- **Sidecar packages** are unsigned previews, and Windows may warn about them.
- **Lite on iPhone and iPad:** in automated tests on the iOS Simulator, Lite occasionally failed to finish starting (2 of 7 runs, one of them a test-harness fault). It hasn't been reproduced elsewhere, and the cause is being investigated (#195). If Lite doesn't finish loading, reload the page.

## [2.6.0] - 2026-11-06

GIS Workbench 2.6.0 is a civilian-use application: it is designed and intended for civilian use only, and should not be used for any military purpose. This release adds UAV structure from motion, rigorous sensor models and a native stereo viewer through the sidecar, shows progress on long jobs, and carries Sidecar 0.3.0, with a new FFmpeg and wider format routes. Everything in the sidecar is Full only.

### Added
- **UAV structure from motion:** the sidecar turns a folder of drone photographs into oriented frames, a dense cloud, a DSM and an orthomosaic, on the CPU, with no GPU needed. A 77-photo block takes about 40 minutes on the test machine. It's a separate module of 35 MB on Windows and 99 MB on Linux. (REQ-GAP-29, SCN-63)
- **OSSIM rigorous sensor models:** Load OSSIM Rigorous Model fits an RPC from a rigorous model. The fit agrees with OSSIM to about 0.01 pixel on two RADARSAT-2 scenes. (REQ-GAP-21, SCN-64)
- **Native Stereo Viewer:** a separate window on Windows shows a stereo pair with quad-buffer output where the display has it, and falls back to anaglyph where it does not. (REQ-GAP-33, SCN-65)
- **Sync with ArcGIS Pro:** view and cursor follow each other through an add-in, whose source is included. (REQ-GAP-65, SCN-65)
- **Python client:** your own scripts can drive the app through the sidecar on this computer, and writes stay proposals for you to accept. (REQ-GAP-02, SCN-61)
- **Progress on long jobs:** an activity indicator shows stages, percent and Cancel on long work, including sidecar jobs and copies to the sidecar. (REQ-ING-04, SCN-66)
- **More sidecar routes:** HDF-EOS grids and swaths, FITS up to 11 GB, KEA, TileDB and PDF through PDFium, the full PROJ grids, pan-sharpening of very large scenes, and Esri multipatch, FBX and IFC export. (REQ-GAP-72, REQ-GAP-67, REQ-GAP-17, REQ-GAP-15, REQ-GAP-36, SCN-60)
- **MrSID and ECW views:** on Windows, the sidecar serves these files to the app without converting them. (REQ-GAP-70)
- **MPEG-2 to H.264 on Linux:** this works through Cisco's own OpenH264 binary, which you add in Add or remove modules. (REQ-GAP-51)
- **File Geodatabase catalog:** domains and subtypes can be read through the sidecar. (REQ-GAP-54)

### Changed
- **Civilian use:** this release is for civilian use, and some earlier functions are no longer in the app. If you need one of them, keep your earlier copy.
- **Automation API 3.0.0:** the result of `products.chip` has one field fewer, so the API takes a major version. Scripts that don't read that field are not affected.
- **FFmpeg in the Media module** is now an LGPL build from the ffmpeg.org source, version 8.1.3, on both platforms, and the module is about 80 % smaller. It leaves out AV1 and JPEG XL decoding and all network protocols. On Windows, H.264 encoding uses the operating system's encoder. (OD-2.30)
- **Linux package:** it needs glibc 2.27, so it installs on Ubuntu 22.04 and Debian 12. It is also smaller.
- **Size:** the Full file is about 9 MB. The size limit is now 18 MB, and start-up is measured from navigation start. (OD-2.27)
- **Translations:** every message in the 34 shipped locales is translated, by AI draft and AI review.

### Fixed
- **ICAO Annex 14:** the tool now follows Amendment 18, including the 110 m inner edge for a code 3 non-instrument approach and the edition label. (REQ-GAP-73)
- **Terrain labels** now name the geoid that really converts the heights. They could name the wrong one.
- **Obstruction Surfaces** say so when a DSM is too coarse to show obstacles. (REQ-GAP-73)
- **The job button** in the status bar now has an accessible name that holds its visible text.
- **Sidecar views** of images with a rotated georeference no longer fail on every tile.
- **FITS images with BSCALE or BZERO** keep their true values through the sidecar, and MODIS scales, fill values and swath tie points are now right. These had given wrong results without an error. (REQ-GAP-72)
- **Sidecar on Linux:** a second session starting at the same moment could fail.

### Known limits
- **Real phones:** Lite has been tested on the iOS Simulator and an Android emulator. Real-device results are in the release notes when available.
- **Sidecar packages** are unsigned previews, and Windows may warn about them.
- **UAV structure from motion:** absolute position and height depend on the camera's GPS and EXIF focal length, with no ground control points. An error of 1 % in focal length is about 1 m at 100 m flying height.
- **Rigorous models:** one sensor family has been tested, and the fit figures are distances between models, not ground accuracy.
- **Stereo viewer:** quad-buffer output was checked in software, with no stereo display. The visible window on real hardware is untested.
- **ArcGIS Pro add-in:** the source is included, but it has been tested against a mock, not built or run in ArcGIS Pro.
- **Swath COGs** are not map accurate between their tie points. Values stay as stored, and scale metadata isn't applied.
- **MrSID and ECW on Linux:** there is no decoder without accepting vendor terms. On Windows, the plug-in comes from OSGeo4W and you accept its licence during set-up.
- **Linux sidecar data folder:** keep it on a native disk. On a WSL `/mnt` drive, confinement refuses tool writes, and the error doesn't say why.
- **ICAO aviation terms** in translations were not checked against published national texts in every locale.
- **Translations** are AI draft and AI review, with no native-speaker review.
- **Right-to-left and complex-script locales** are still to come.
- **FFmpeg 8.1.3** is the current release tag. It lags the earlier build by some parser fixes, and will be updated when 8.1.4 ships.
