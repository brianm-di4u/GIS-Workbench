# Changelog

All notable changes to GIS Workbench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Items carry the GUI campaign finding id they close (see `docs/validation/GUI-findings.md`).

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
