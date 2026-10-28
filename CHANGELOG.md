# Changelog

All notable changes to GIS Workbench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Items carry the campaign finding id they close (GUI-nnn: `docs/validation/GUI-findings.md`; TE-nnn: `docs/validation/TE-findings.md`).

## [1.2.1] - Unreleased

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
