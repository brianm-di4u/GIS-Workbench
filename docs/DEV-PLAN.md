# Development plan

Agents keep this current. Each task here becomes a `ready` issue that autopilot can pick up.

## Milestones

No work starts until the admin says go. 2.7.0 has the go (2026-11-08). Each later release waits for its own.

- **Rules for every release below:**
  - Plans carry no time estimates: each release is limited only by its scope, its dependencies and its gates, and work runs at full speed.
  - Items are for the Full build only unless marked. New Rust goes in new lazy bundles.
  - Exit scenarios and spikes are written when each release starts.
  - **Point releases:** 2.7 ships as point releases 2.7.0 to 2.7.6. An item that is blocked by something outside the code (signing, licences or sample data) moves to a later point release rather than holding one up.
- **New requirement IDs:** REQ-GAP-83 onward and REQ-PIP-05 onward are new rows in the private matrix ([0004](decisions/0004-private-docs-repo.md)).

### 2.7.0, "Core GIS in the file"

- REQ-GAP-79: buffer, overlay, dissolve and spatial join for vector data.
- REQ-GAP-80: hydrology: sink fill, flow, watersheds and stream networks.
- REQ-GAP-81: point cloud profile selection, with edit and delete of the selected points.
- REQ-GAP-82: automatic endmember extraction.
- REQ-GAP-16: smoother interpolation of the EGM2008 2.5′ geoid, then EGM2008 at 1 arc-minute as a tiled pack.
- REQ-GAP-78: Annex 14 obstacle free and obstacle evaluation surfaces, with the current edition still selectable.
- REQ-LDR-14: assign a CRS to LAS and LAZ files.
- REQ-GAP-86: a Lite project file (Full and Lite).
- REQ-PRF-01: the lazy-loading pass (Full and Lite), with the performance sign-off on the reference machine.
- REQ-GAP-39: LandXML import keeps the file's own triangulation.
- REQ-ING-04: a long-task watchdog in the GUI sweep, and no freezes in vector and GeoPackage import or in project save and load (Full and Lite).
- REQ-L10N-02: the five flight-plan refusals become translatable.
- LAS reader warnings name the geoid in use, not always EGM96.
- Terrain from a DEM not in EPSG:4326 keeps its full detail, with no 2,048-post cap.

### 2.7.1, "Analysis and workflows in the file"

- REQ-GAP-83: time series: time slider, temporal profile, trend and anomaly.
- REQ-GAP-84: a node-based workflow builder over recipes, with typed ops and recipes saved in the project.
- REQ-GAP-85: geocoding and routing on the user's own address and road layers.
- REQ-GAP-87: civil feature catalogues: ISO 19110, INSPIRE and OpenStreetMap.

### 2.7.2, "Automation and CAD"

- REQ-GAP-95: run any recipe from the command line through the sidecar.
- REQ-GAP-96: scheduled runs from Task Scheduler or cron, with no service installed.
- REQ-GAP-94: ground control points for UAV structure from motion.
- REQ-GAP-98: DXF in the file; DWG through the sidecar.

### 2.7.3, "LiDAR QC and sensor models"

- REQ-GAP-88: lidar strip alignment and QC.
- REQ-GAP-20: rigorous models for DIMAP V2, KOMPSAT and ALOS PRISM, each only with real samples.
- REQ-GAP-89: atmospheric correction to surface reflectance.

### 2.7.4, "SAR terrain"

- REQ-GAP-90: range-Doppler geocoding and terrain correction, with precise orbit files.
- REQ-GAP-91: automatic levelling of SAR stereo heights against a reference DEM.

### 2.7.5, "SAR deformation"

- REQ-GAP-92: interferometry, with Sentinel-1 TOPS through the sidecar.
- REQ-GAP-93: SBAS deformation time series.

### 2.7.6, "The signed sidecar"

Waits for sidecar signing and the external security review.

- REQ-GAP-50: live MPEG-TS over UDP and multicast, receive only.
- REQ-GAP-97: PostGIS and SQL Server layers, on database hosts the user lists.

### 2.8.0, "Workflows and recipes"

- REQ-PIP-05: rank the most used and most useful geospatial analysis tasks, with the evidence published.
- REQ-PIP-06: a library of tested recipes and workflows for those tasks.
- REQ-PIP-07: a recipe gallery to find, preview and run recipes, in the page or from the command line.
- REQ-PIP-08: every shipped recipe checked against an independent oracle or a reference result.

### Later, with no release number

- AI and machine learning: model training and AI segmentation, random forest and SVM classification, object-based image analysis, and automatic point classes.
- Right-to-left and complex scripts: Arabic, Hebrew, Urdu, Hindi and Thai after 2.8; Persian later.

## Test matrix

Requirement coverage is in the private matrix, in the companion repo ([0004](decisions/0004-private-docs-repo.md)). This table stays empty here.

| Criterion | Test | Evidence |
|---|---|---|

## Defect log

No defects are logged here yet.

| Date | Defect | Found by | Fixed in |
|---|---|---|---|
