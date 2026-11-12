### Added
- **SAR ▸ Terrain Correction** geocodes a Sentinel-1 SLC image onto an elevation model with its orbit, flattens it to γ⁰ by projected area, and adds a layover and shadow mask. It uses a precise (POEORB) or restituted (RESORB) orbit file when you open one that covers the image, and the annotation's orbit otherwise. GIS Workbench does not download orbit files.
- **Level DSM on Reference** removes a SAR stereo DSM's vertical offset, and optionally a tilt, against a reference DEM over stable terrain, and states the residual. It also works on any DEM opened as terrain, in its heights on the ellipsoid.

### Changed
- **Calibrated Sentinel-1 bands** (β⁰, σ⁰, γ⁰) show the zero fill at burst and swath edges as no data, so it is transparent and left out of statistics. It used to read as −300 dB.
- **SAR stereo DSM files** now record their product, pair side and prior DEM as GDAL metadata, with band names that other GIS tools show. Files saved by 2.6 are still read by their description, so they keep their flags when you reopen and level them.
