# Changelog

All notable changes to GIS Workbench. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
