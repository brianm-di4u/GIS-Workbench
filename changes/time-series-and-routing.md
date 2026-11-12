### Added
- **Time series of images.** Time Stack puts dated images in date order on one grid, and NetCDF time axes keep their dates in every CF calendar. The Time Series panel has a date slider with playback and recording, and plots the values over time at the cursor, at a pinned point or over the AOI, with CSV export. Temporal Trend gives the slope per year and its p-value at every pixel, and Temporal Anomaly compares each date with a baseline period.
- **Geocoding and routing on your own data.** Address Index, Find Address, Geocode a Table and Reverse Geocode work from your own address layer, and an index can be saved as a GeoPackage. Road Network builds a graph from your own roads, with one-way streets, speeds and turn bans, for Shortest Route and Service Area. Nothing is sent anywhere.

### Known limits
- **Routes start and end at junctions.** Shortest Route and Service Area snap each click to the nearest junction or line end within 500 m. The stretch from the click to that junction is not in the route's length or time.
