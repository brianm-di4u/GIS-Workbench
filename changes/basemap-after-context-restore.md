### Fixed
- **Basemaps draw again after the graphics context comes back.** When the browser dropped and restored the map's graphics context, for example on a phone that was put away, basemap tiles already loaded stayed blank. They are now loaded again.
