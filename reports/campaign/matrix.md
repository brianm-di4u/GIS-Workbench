# T&E functional coverage matrix

Generated 2026-10-29T12:25:18.349Z from `app/src/shell/commands.js`, `ribbon-data.js` and `build/campaign/corpus.json`.

Commands 496; implemented 496; oracle-checked 40; with no eligible corpus data 0.

| Command | Label | REQ | Rel | Spec | Context | Impl | Data items | Check |
|---|---|---|---|---|---|---|---|---|
| `qat.undo` | Undo | REQ-ARC-13 | R0 | c17-workspace | — | yes | 0 | smoke |
| `qat.redo` | Redo | REQ-ARC-13 | R0 | c17-workspace | — | yes | 0 | smoke |
| `qat.customize` | Customize Quick Access Toolbar | REQ-UI-04 | R1 | c17-workspace | — | yes | 0 | smoke |
| `file.newproject` | New Project | REQ-ARC-08 | R0 | c17-workspace | — | yes | 0 | smoke |
| `file.openimage` | Open Image… | REQ-HOST-02 | R0 | c01-ingest | — | yes | 1 | smoke |
| `file.openproject` | Open Project… | REQ-ARC-08 | R0 | c01-ingest | — | yes | 1 | smoke |
| `file.openvector` | Open Vector… | REQ-EXT-21 | R1 | c01-ingest | — | yes | 0 | smoke |
| `file.openpointcloud` | Open Point Cloud… | REQ-LDR-01 | R2 | c01-ingest | — | yes | 0 | smoke |
| `pc.dod` | DSM of Difference… | REQ-LDR-11 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.extract` | Buildings and Trees from Points | REQ-LDR-11 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.stream` | Stream Point Cloud (COPC/EPT)… | REQ-LDR-02 | R3 | c01-ingest | — | yes | 0 | smoke |
| `file.opendem` | Open DEM… | REQ-DEM-01 | R0 | c01-ingest | — | yes | 0 | smoke |
| `file.openpack` | Open Data Pack… | REQ-ARC-14 | R3 | c01-ingest | — | yes | 0 | smoke |
| `packs.manage` | Data Packs… | REQ-ARC-14 | R3 | c17-workspace | — | yes | 1 | smoke |
| `file.recent` | Recent Projects | REQ-UI-04 | R1 | c17-workspace | — | yes | 0 | smoke |
| `file.save` | Save Project | REQ-ARC-08 | R0 | c17-workspace | — | yes | 0 | smoke |
| `file.saveas` | Save Project As… | REQ-ARC-08 | R0 | c17-workspace | — | yes | 0 | smoke |
| `file.saveoptions` | Save Options… | REQ-SEC-06 | R1 | c17-workspace | — | yes | 0 | smoke |
| `file.relink` | Relink Imagery… | REQ-ARC-09 | R0 | c17-workspace | — | yes | 0 | smoke |
| `file.snapshot` | Export Snapshot | REQ-ARC-19 | R2 | c17-workspace | — | yes | 0 | smoke |
| `file.print` | Print | REQ-PRD-03 | R1 | c15-products | — | yes | 0 | 1:5000 print scale within 0.5 % |
| `file.prefs` | Preferences… | REQ-UI-11 | R0 | c17-workspace | — | yes | 0 | smoke |
| `file.projectprops` | Project Properties… | REQ-ARC-08 | R0 | c17-workspace | — | yes | 0 | smoke |
| `prod.saveas` | Save Product As… | REQ-PRD-01 | R1 | c15-products | — | yes | 0 | smoke |
| `tpl.saveas` | Save Template As… | REQ-PRD-02 | R1 | c15-products | — | yes | 0 | smoke |
| `tpl.new` | New Template | REQ-PRD-02 | R1 | c15-products | — | yes | 0 | smoke |
| `win.close` | Close Multiport | REQ-UI-02 | R0 | c02-display | — | yes | 0 | smoke |
| `edit.history` | History… | REQ-ARC-13 | R0 | c17-workspace | — | yes | 0 | smoke |
| `edit.copy` | Copy | REQ-IMG-27 | R1 | c14-annotate | — | yes | 0 | smoke |
| `edit.paste` | Paste | REQ-IMG-27 | R1 | c14-annotate | — | yes | 0 | smoke |
| `edit.delete` | Delete | REQ-IMG-26 | R1 | c14-annotate | — | yes | 0 | smoke |
| `ws.dataview` | Data View | REQ-UI-01 | R0 | c02-display | — | yes | 0 | smoke |
| `ws.windowsview` | Windows View | REQ-UI-01 | R0 | c02-display | — | yes | 0 | smoke |
| `ws.mapview` | Map View | REQ-UI-01 | R0 | c02-display | — | yes | 0 | smoke |
| `ws.preview` | Preview | REQ-UI-01 | R0 | c02-display | — | yes | 0 | smoke |
| `keys.customize` | Customize Hot Keys… | REQ-UI-09 | R1 | c17-workspace | — | yes | 0 | smoke |
| `dock.jobs` | Job Queue | REQ-ARC-06 | R0 | c17-workspace | — | yes | 0 | smoke |
| `dock.netlog` | Network Log | REQ-SEC-12 | R0 | c17-workspace | — | yes | 0 | smoke |
| `dock.importlog` | Import Log | REQ-UI-05 | R0 | c17-workspace | — | yes | 0 | smoke |
| `ribbon.minimise` | Minimise the Ribbon | REQ-UI-03 | R0 | c17-workspace | — | yes | 0 | smoke |
| `dock.layers` | Layer Manager | REQ-UI-18 | R0 | c17-workspace | — | yes | 0 | smoke |
| `dock.toolbox` | ToolBox | REQ-EXT-01 | R1 | c17-workspace | — | yes | 0 | smoke |
| `theme.system` | Follow System | REQ-UI-12 | R4 | c02-display | — | yes | 0 | smoke |
| `theme.grey` | Grey | REQ-UI-12 | R0 | c02-display | — | yes | 0 | smoke |
| `theme.dark` | Dark | REQ-UI-12 | R0 | c02-display | — | yes | 0 | smoke |
| `theme.print` | Print | REQ-UI-12 | R0 | c02-display | — | yes | 0 | smoke |
| `view.uiscale` | UI Scale… | REQ-UI-17 | R1 | c02-display | — | yes | 0 | smoke |
| `dem.folder` | Terrain Folder… | REQ-DEM-03 | R2 | c07-terrain | — | yes | 8 | smoke |
| `tools.imagelist` | Image List | REQ-UI-19 | R1 | c17-workspace | — | yes | 0 | smoke |
| `tools.loadpoints` | Load Point File… | REQ-UI-25 | R1 | c17-workspace | — | yes | 1 | smoke |
| `help.topics` | Help Topics | REQ-UI-15 | R0 | c17-workspace | — | yes | 0 | smoke |
| `help.keys` | Keyboard Map | REQ-UI-09 | R0 | c17-workspace | — | yes | 0 | smoke |
| `help.limits` | Accuracy and Limits | REQ-SEC-07 | R0 | c17-workspace | — | yes | 0 | smoke |
| `help.about` | About & Diagnostics | REQ-HOST-01 | R0 | c17-workspace | — | yes | 0 | smoke |
| `nav.glove` | Glove | REQ-UI-08 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.recenter` | Re-center | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.roam` | Mouse (Full Roam) | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.jump` | Jump to Point… | REQ-IMG-13 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.jumpbox` | Jump to Coordinate | REQ-GEO-07 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.zoombox` | Zoom to Box | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.zoomin` | Zoom In | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.zoomout` | Zoom Out | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.whole` | Whole Scene | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.onetoone` | 1:1 | REQ-IMG-11 | R0 | c02-display | — | yes | 0 | smoke |
| `nav.magnifier` | Magnifying Glass | REQ-IMG-14 | R1 | c02-display | — | yes | 0 | smoke |
| `view.interpolation` | Interpolation | REQ-IMG-02 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.zero` | Zero (Sensor Native) | REQ-IMG-12 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.upisup` | Up is Up | REQ-IMG-12 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.north` | True North | REQ-IMG-12 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.shadows` | Shadows Down | REQ-IMG-12 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.mouse` | Mouse Rotate | REQ-UI-08 | R0 | c02-display | — | yes | 0 | smoke |
| `rot.angle` | Rotation Angle | REQ-IMG-12 | R0 | c02-display | — | yes | 0 | smoke |
| `link.all` | Link All Panels | REQ-IMG-15 | R0 | c02-display | — | yes | 0 | smoke |
| `link.unlink` | Unlink | REQ-IMG-15 | R0 | c02-display | — | yes | 0 | smoke |
| `link.manager` | Link Manager… | REQ-IMG-15 | R1 | c02-display | — | yes | 0 | smoke |
| `link.cursors` | Linked Cursors… | REQ-IMG-17 | R1 | c02-display | — | yes | 0 | smoke |
| `ov.open` | Open Overview | REQ-IMG-14 | R1 | c02-display | — | yes | 0 | smoke |
| `ov.pip` | Panel-in-Panel | REQ-IMG-14 | R1 | c02-display | — | yes | 0 | smoke |
| `bm.add` | Add 2D Bookmark | REQ-IMG-13 | R1 | c02-display | — | yes | 0 | smoke |
| `bm.list` | Bookmarks | REQ-IMG-13 | R1 | c02-display | — | yes | 0 | smoke |
| `aoi.box` | Box AOI | REQ-IMG-30 | R1 | c14-annotate | — | yes | 0 | smoke |
| `aoi.polygon` | Polygon AOI | REQ-IMG-30 | R1 | c14-annotate | — | yes | 0 | smoke |
| `aoi.fromgraphic` | AOI from Graphic | REQ-IMG-30 | R1 | c14-annotate | — | yes | 0 | smoke |
| `aoi.clear` | Clear AOI | REQ-IMG-30 | R1 | c14-annotate | — | yes | 0 | smoke |
| `sel.graphics` | Select Graphics | REQ-EXT-12 | R0 | c12-vector | — | yes | 0 | smoke |
| `sel.features` | Select Features | REQ-EXT-12 | R1 | c12-vector | — | yes | 0 | smoke |
| `sel.byattr` | Select by Attribute… | REQ-EXT-12 | R1 | c12-vector | — | yes | 0 | smoke |
| `sel.byloc` | Select by Location… | REQ-EXT-12 | R1 | c12-vector | — | yes | 0 | smoke |
| `sel.all` | Select All | REQ-EXT-12 | R0 | c12-vector | — | yes | 0 | smoke |
| `draw.point` | Point | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.line` | Line | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.polyline` | Polyline | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.polygon` | Polygon | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.rect` | Rectangle | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.ellipse` | Ellipse | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.circle` | Circle | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.arrow` | Arrow | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.text` | Text Box | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.callout` | Callout | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.marker` | Marker | REQ-IMG-26 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.autolabels` | Auto Labels | REQ-IMG-28 | R1 | c14-annotate | — | yes | 0 | smoke |
| `draw.automap` | Auto Map | REQ-IMG-28 | R1 | c14-annotate | — | yes | 0 | smoke |
| `men.point` | Point Position | REQ-MEN-02 | R0 | c13-measure | — | yes | 23 | ground point vs sarpy/GDAL RPC projection; CE90/LE90 = 2.146σ/1.645σ ± 1 % |
| `men.bracket` | Bracket | REQ-MEN-02 | R1 | c13-measure | — | yes | 0 | smoke |
| `men.rangebearing` | Range & Bearing | REQ-MEN-02 | R0 | c13-measure | — | yes | 0 | inverse geodesic vs GeographicLib |
| `men.length` | Polyline Length | REQ-MEN-02 | R0 | c13-measure | — | yes | 0 | geodesic distance vs GeographicLib ≤ 1 mm/10 km (AT-03.x) |
| `men.area` | Polygon Area | REQ-MEN-02 | R0 | c13-measure | — | yes | 0 | geodesic area vs GeographicLib ≤ 0.1 % (AT-03.x) |
| `men.height` | Height | REQ-MEN-03 | R1 | c13-measure | — | yes | 0 | layover/shadow height ± max(0.5 m, 2–3 %) |
| `men.target` | Target | REQ-MEN-04 | R1 | c13-measure | — | yes | 0 | smoke |
| `men.log` | Mensuration Log | REQ-MEN-01 | R0 | c13-measure | — | yes | 0 | smoke |
| `men.tracking` | Cursor Tracking | REQ-MEN-05 | R0 | c13-measure | — | yes | 0 | smoke |
| `men.targettable` | Target Table | REQ-MEN-04 | R1 | c13-measure | — | yes | 0 | smoke |
| `men.depth` | Depth | REQ-MEN-09 | R2 | c13-measure | — | yes | 0 | smoke |
| `men.medial` | Medial Axis | REQ-MEN-08 | R1 | c13-measure | — | yes | 0 | smoke |
| `men.centre` | Line Centre Point | REQ-MEN-08 | R1 | c13-measure | — | yes | 0 | smoke |
| `draw.sequence` | Numbered Sequence | REQ-IMG-26 | R1 | c14-annotate | — | yes | 0 | smoke |
| `draw.count` | Count Graphics | REQ-IMG-26 | R1 | c14-annotate | — | yes | 0 | smoke |
| `gfx.props` | Common Properties | REQ-IMG-27 | R1 | c14-annotate | — | yes | 0 | smoke |
| `gfx.legend` | Legend | REQ-IMG-30 | R1 | c14-annotate | — | yes | 0 | smoke |
| `gfx.save` | Save Graphics… | REQ-IMG-29 | R0 | c14-annotate | — | yes | 0 | smoke |
| `gfx.load` | Load Graphics… | REQ-IMG-29 | R0 | c14-annotate | — | yes | 0 | smoke |
| `draw.symbol` | MIL-STD-2525 Symbol… | REQ-IMG-32 | R2 | c14-annotate | — | yes | 0 | smoke |
| `gps.route` | Route | REQ-IMG-31 | R2 | c17-workspace | — | yes | 0 | smoke |
| `gps.waypoint` | Waypoint | REQ-IMG-31 | R2 | c17-workspace | — | yes | 0 | smoke |
| `gps.load` | Load GPX… | REQ-IMG-31 | R2 | c17-workspace | — | yes | 0 | smoke |
| `align.glove` | Glove Align | REQ-SNS-09 | R1 | c05-sensor | — | yes | 0 | smoke |
| `align.auto` | Auto Align | REQ-SNS-09 | R1 | c05-sensor | — | yes | 0 | smoke |
| `align.quick` | Quick Align (2-point) | REQ-SNS-09 | R1 | c05-sensor | — | yes | 0 | smoke |
| `align.poly` | Polynomial Registration… | REQ-SNS-09 | R1 | c05-sensor | — | yes | 1 | smoke |
| `model.active` | Active Model | REQ-SNS-06 | R0 | c05-sensor | — | yes | 1 | smoke |
| `model.info` | Model Info… | REQ-SNS-06 | R0 | c05-sensor | — | yes | 1 | smoke |
| `model.error` | Error Budget… | REQ-MEN-06 | R0 | c05-sensor | — | yes | 4 | smoke |
| `model.gcp` | GCP Model… | REQ-SNS-05 | R1 | c05-sensor | — | yes | 2 | smoke |
| `tri.mip` | Multi-Image Point | REQ-MEN-11 | R2 | c05-sensor | — | yes | 0 | smoke |
| `tri.tiepoints` | Tie Points | REQ-SNS-13 | R2 | c05-sensor | — | yes | 3 | smoke |
| `tri.adjust` | Block Adjustment… | REQ-SNS-11 | R2 | c05-sensor | — | yes | 7 | checkpoint RMSE ≤ 1.5 GSD |
| `tri.frame` | Frame Import Wizard… | REQ-SNS-14 | R2 | c05-sensor | — | yes | 4 | smoke |
| `tri.solutions` | Solutions | REQ-SNS-15 | R2 | c05-sensor | — | yes | 0 | smoke |
| `ortho.rectify` | Orthorectify… | REQ-SNS-17 | R2 | c05-sensor | — | yes | 21 | orthoimage vs gdalwarp -rpc on the same DEM (≤ 1 GSD) |
| `ortho.true` | True Ortho | REQ-SNS-19 | R2 | c05-sensor | — | yes | 0 | smoke |
| `ortho.mosaic` | Mosaic… | REQ-SNS-18 | R2 | c05-sensor | — | yes | 3 | smoke |
| `ortho.seam` | Seamline Edit | REQ-SNS-18 | R2 | c05-sensor | — | yes | 0 | smoke |
| `ortho.balance` | Colour Balance | REQ-SNS-18 | R2 | c05-sensor | — | yes | 0 | smoke |
| `geo.convert` | Convert Coordinates… | REQ-GEO-08 | R0 | c04-geodesy | — | yes | 0 | MGRS/UTM/UPS/GARS/GEOREF vs GeographicLib + NGS NCAT (truncation rule) |
| `geo.grid` | Grid | REQ-IMG-22 | R1 | c02-display | — | yes | 0 | smoke |
| `geo.datum` | Datum Info | REQ-GEO-01 | R0 | c04-geodesy | — | yes | 3 | HAE↔MSL vs NGS geoid API ≤ 0.2 m (EGM96) |
| `online.add` | Add Online Source… | REQ-ARC-16 | R2 | c02-display | — | yes | 12 | smoke |
| `online.backgrounds` | Map Backgrounds | REQ-UI-26 | R1 | c02-display | — | yes | 0 | smoke |
| `chip.view` | Chip Current View | REQ-PRD-01 | R1 | c15-products | — | yes | 0 | chip geolocation vs gdalinfo of written GeoTIFF/NITF |
| `chip.preset` | By Preset Area Size | REQ-PRD-01 | R1 | c15-products | — | yes | 0 | smoke |
| `chip.markers` | All Markers | REQ-PRD-01 | R1 | c15-products | — | yes | 0 | smoke |
| `tpl.apply` | Apply Template | REQ-PRD-02 | R1 | c15-products | — | yes | 1 | smoke |
| `tpl.edit` | Edit Template | REQ-PRD-02 | R1 | c15-products | — | yes | 0 | smoke |
| `tpl.props` | Product Properties | REQ-PRD-04 | R1 | c15-products | — | yes | 0 | smoke |
| `snap.pptx` | PowerPoint | REQ-PRD-05 | R2 | c15-products | — | yes | 0 | python-pptx re-read |
| `snap.pdf` | PDF | REQ-PRD-03 | R1 | c15-products | — | yes | 0 | pypdf/veraPDF structure; GeoPDF registration |
| `snap.geopdf` | GeoPDF | REQ-PRD-08 | R3 | c15-products | — | yes | 0 | smoke |
| `snap.kmz` | KMZ | REQ-PRD-07 | R1 | c15-products | — | yes | 0 | ogrinfo re-read |
| `report.template` | Report Template | REQ-PRD-11 | R1 | c15-products | — | yes | 1 | smoke |
| `prod.gif` | Make Animation… | REQ-PRD-12 | R3 | c15-products | — | yes | 0 | smoke |
| `prod.mediapptx` | Media Slides (PPTX)… | REQ-PRD-12 | R3 | c15-products | — | yes | 0 | smoke |
| `prod.pptxtemplate` | Import PowerPoint Template… | REQ-PRD-09 | R3 | c15-products | — | yes | 0 | smoke |
| `report.ai` | Draft with AI… | REQ-AI-10 | R1 | c15-products | — | yes | 0 | smoke |
| `meta.edit` | Edit Metadata | REQ-PRD-04 | R1 | c17-workspace | — | yes | 0 | smoke |
| `meta.marking` | Classification & Marking… | REQ-SEC-04 | R0 | c17-workspace | — | yes | 1 | smoke |
| `meta.redact` | Redact / Split Image… | REQ-SEC-11 | R2 | c15-products | — | yes | 0 | smoke |
| `prod.finishing` | Finishing Tool | REQ-PRD-06 | R2 | c15-products | — | yes | 0 | smoke |
| `win.new` | New Multiport | REQ-UI-02 | R0 | c02-display | — | yes | 0 | smoke |
| `win.clone` | Clone | REQ-UI-02 | R1 | c02-display | — | yes | 0 | smoke |
| `win.separate` | Separate Multiport | REQ-UI-02 | R1 | c02-display | — | yes | 0 | smoke |
| `win.split` | Split | REQ-UI-02 | R0 | c02-display | — | yes | 0 | smoke |
| `win.tabbed` | Tabbed Panels | REQ-UI-02 | R1 | c02-display | — | yes | 0 | smoke |
| `panel.props` | Panel Properties | REQ-UI-18 | R1 | c02-display | — | yes | 0 | smoke |
| `panel.visibility` | Data Visibility | REQ-UI-18 | R1 | c02-display | — | yes | 0 | smoke |
| `panel.legend` | Legend | REQ-IMG-30 | R1 | c02-display | — | yes | 0 | smoke |
| `grid.map` | Map Grid | REQ-IMG-22 | R1 | c02-display | — | yes | 0 | smoke |
| `grid.grg` | GRG | REQ-IMG-23 | R2 | c02-display | — | yes | 0 | smoke |
| `grid.micro` | Micro GRG | REQ-IMG-23 | R2 | c02-display | — | yes | 0 | smoke |
| `grid.props` | Grid Properties | REQ-IMG-22 | R1 | c02-display | — | yes | 0 | smoke |
| `bg.map` | Map / Image Background | REQ-UI-26 | R1 | c02-display | — | yes | 0 | smoke |
| `bg.online` | Online Source Properties | REQ-UI-26 | R2 | c02-display | — | yes | 0 | smoke |
| `deco.north` | North Arrow | REQ-IMG-22 | R0 | c02-display | — | yes | 0 | smoke |
| `deco.sun` | Sun Azimuth | REQ-IMG-22 | R1 | c02-display | — | yes | 0 | smoke |
| `deco.sensor` | Sensor Azimuth | REQ-IMG-22 | R1 | c02-display | — | yes | 0 | smoke |
| `deco.scalebar` | Scale Bar | REQ-IMG-22 | R0 | c02-display | — | yes | 0 | smoke |
| `deco.banners` | Classification Banners | REQ-SEC-04 | R0 | c02-display | — | yes | 0 | smoke |
| `stereo.open` | Stereo Panel | REQ-STR-03 | R2 | c06-stereo3d | layer, stereo | yes | 92 | smoke |
| `stereo.manager` | Stereo Model Manager | REQ-STR-02 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.next` | Next Stereo Model | REQ-STR-02 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.finder` | Pair Finder… | REQ-STR-02 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.metrics` | Pair Metrics | REQ-STR-01 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.dubois` | Anaglyph (Dubois) | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.true` | True Anaglyph | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.grey` | Grey Anaglyph | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.half` | Half-Colour Anaglyph | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.split` | Split Screen | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.sbs` | Side-by-Side (Parallel) | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.cross` | Side-by-Side (Cross-Eyed) | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.spanned` | Spanned (Two Monitors) | REQ-STR-05 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.dual` | Dual Output (Second Window) | REQ-STR-06 | R3 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.xr` | WebXR Stereo | REQ-STR-06 | R3 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.overunder` | Over-Under | REQ-STR-05 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mode.interleaved` | Row-Interleaved | REQ-STR-05 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.parity` | Interleave Parity | REQ-STR-05 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.swap` | Swap Eyes | REQ-STR-04 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.cursor` | Floating Cursor | REQ-STR-08 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.fixedcursor` | Fixed Cursor | REQ-STR-08 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.place` | Place on Ground | REQ-STR-09 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.snap` | Snap to Ground | REQ-STR-09 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.track` | Terrain Tracking | REQ-STR-09 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.align` | Stereo Align | REQ-SNS-10 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.epipolar` | Export Epipolar Pair… | REQ-STR-16 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.ypar` | Show Y-Parallax | REQ-STR-03 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mpoint` | Point | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mheight` | Height | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mdistance` | Distance | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mslope` | Slope | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mpolyline` | Polyline Z | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mpolygon` | Polygon Z | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `stereo.mvolume` | Volume | REQ-MEN-12 | R2 | c06-stereo3d | stereo | yes | 4 | smoke |
| `3d.open` | Open 3D Multiport | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.sync` | Sync Now | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.syncalways` | Sync Always | REQ-STR-11 | R2 | c06-stereo3d | — | yes | 0 | smoke |
| `3d.close` | Close 3D View | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `input.devices` | Input Devices… | REQ-UI-20 | R2 | c02-display | — | yes | 0 | smoke |
| `3d.exag` | Vertical Exaggeration… | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.navorbit` | Orbit | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.navfree` | Free Flight | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.navroute` | Fly Route | REQ-STR-11 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.measure` | 3D Cursor Measure | REQ-STR-12 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.los` | 3D Line of Sight | REQ-STR-12 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.import` | Import glTF/GLB… | REQ-STR-13 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.qmesh` | Add Quantized-Mesh Terrain… | REQ-ARC-16 | R3 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.tiles3tz` | Open 3D Tiles Archive (.3tz)… | REQ-STR-15 | R3 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.tiles` | Add 3D Tiles… | REQ-STR-15 | R3 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `3d.record` | Record WebM… | REQ-STR-14 | R2 | c06-stereo3d | scene3d | yes | 74 | smoke |
| `ribbon.customize` | Customize the Ribbon… | REQ-UI-24 | R2 | c17-workspace | — | yes | 0 | smoke |
| `display.fullscreen` | Exploitation Fullscreen | REQ-UI-10 | R0 | c02-display | — | yes | 34 | smoke |
| `display.theme` | Theme | REQ-UI-12 | R0 | c02-display | — | yes | 34 | smoke |
| `display.pixels` | Pixel Matrix Viewer | REQ-IMG-21 | R1 | c02-display | image | yes | 166 | smoke |
| `ai.assistant` | AI Assistant | REQ-AI-01 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.smartselect` | Smart Select (local AI) | REQ-EXT-18 | R3 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.askselection` | Ask About Selection | REQ-AI-01 | R1 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.describe` | Describe View | REQ-AI-09 | R1 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.proposals` | Proposals | REQ-AI-06 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.connections` | Connections… | REQ-AI-02 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.allowlist` | Network Allow-List… | REQ-AI-05 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.prompthelper` | Prompt Helper (offline)… | REQ-AI-13 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `ai.mcp` | MCP Servers… | REQ-AI-14 | R1 | c16-ai-mcp | — | yes | 0 | smoke |
| `wb.toggle` | Feedback Whiteboard | REQ-WB-01 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `wb.review` | Review & Send… | REQ-WB-08 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `wb.import` | Import Feedback… | REQ-WB-11 | R0 | c16-ai-mcp | — | yes | 0 | smoke |
| `auto.console` | Automation Console | REQ-ARC-17 | R1 | c16-ai-mcp | — | yes | 0 | smoke |
| `auto.mcpserver` | Expose as MCP Server… | REQ-AI-15 | R1 | c16-ai-mcp | — | yes | 0 | smoke |
| `pack.load` | Load Data Pack… | REQ-ARC-14 | R3 | c17-workspace | — | yes | 0 | smoke |
| `pack.list` | Installed Packs | REQ-ARC-14 | R3 | c17-workspace | — | yes | 0 | smoke |
| `img.orthofly` | Ortho On-the-Fly | REQ-IMG-18 | R2 | c03-enhance | image | yes | 166 | smoke |
| `img.vmosaic` | Virtual Mosaic | REQ-IMG-18 | R2 | c03-enhance | image | yes | 166 | smoke |
| `img.projection` | Projection | REQ-IMG-18 | R2 | c03-enhance | image | yes | 166 | smoke |
| `img.voids` | Remove Void Pixels | REQ-IMG-19 | R0 | c03-enhance | image | yes | 166 | smoke |
| `img.footprint` | Footprint | REQ-IMG-19 | R0 | c03-enhance | image | yes | 166 | smoke |
| `img.segments` | Segments | REQ-IMG-20 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.brightness` | Brightness | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.contrast` | Contrast | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.gamma` | Gamma | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.saturation` | Saturation | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.sharpness` | Sharpness | REQ-IMG-06 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.invert` | Invert | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.drascope` | DRA Scope | REQ-IMG-05 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.dralock` | Lock DRA | REQ-IMG-05 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.drasettings` | DRA Settings… | REQ-IMG-05 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.stretch` | Histogram Stretch | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.curve` | Tonal Curve… | REQ-IMG-06 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.lut` | Pseudo-colour LUT | REQ-IMG-06 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.histogram` | Histogram Editor | REQ-IMG-06 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.sharpen` | Sharpen | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.edge` | Edge | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.smooth` | Smooth | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.median` | Median | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.morph` | Morphology | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.clahe` | CLAHE | REQ-IMG-08 | R1 | c03-enhance | image | yes | 166 | smoke |
| `enh.auto` | Auto Enhance | REQ-IMG-07 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.reset` | Reset | REQ-IMG-07 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.remove` | Remove Enhancements | REQ-IMG-07 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.chain` | Chain Editor… | REQ-IMG-04 | R0 | c03-enhance | image | yes | 166 | smoke |
| `enh.pansharpen` | Pan Sharpen | REQ-IMG-10 | R1 | c03-enhance | image | yes | 166 | smoke |
| `search.find` | Find in Scene… | REQ-MSI-07 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `search.template` | Template Match… | REQ-EXT-28 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `bands.select` | Select Bands | REQ-IMG-09 | R0 | c03-enhance | image, spectral | yes | 166 | smoke |
| `bands.preview` | Band Preview | REQ-MSI-03 | R3 | c03-enhance | image, spectral | yes | 166 | smoke |
| `bands.stats` | Band Statistics | REQ-MSI-07 | R1 | c03-enhance | image | yes | 166 | smoke |
| `bands.snr` | Assess SNR | REQ-MSI-07 | R3 | c03-enhance | image, spectral | yes | 166 | smoke |
| `clip.threshold` | Transparency Threshold | REQ-IMG-09 | R1 | c03-enhance | image | yes | 166 | smoke |
| `clip.void` | Void Pixels | REQ-IMG-19 | R1 | c03-enhance | image | yes | 166 | smoke |
| `profile.spectral` | Spectral Profile | REQ-MSI-07 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `profile.elevation` | Elevation Profile | REQ-DEM-12 | R1 | c07-terrain | image | yes | 166 | smoke |
| `lay.prev` | Previous Image | REQ-UI-18 | R1 | c02-display | layer | yes | 92 | smoke |
| `lay.next` | Next Image | REQ-UI-18 | R1 | c02-display | layer | yes | 92 | smoke |
| `lay.order` | Order Images | REQ-UI-18 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.porthole` | Porthole | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.swiper` | Swiper | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.twocolour` | Multi-Colour | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.blend` | Blend | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.play` | Play (Flicker) | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.rate` | Flicker Rate | REQ-IMG-24 | R1 | c02-display | layer | yes | 92 | smoke |
| `cmp.record` | Record | REQ-IMG-25 | R1 | c02-display | layer | yes | 92 | smoke |
| `chg.detect` | Change Detection… | SCN-11 | R1 | c12-vector | layer | yes | 92 | smoke |
| `chg.confirm` | Confirm Change | SCN-11 | R1 | c12-vector | layer | yes | 92 | smoke |
| `dem.select` | Select Terrain File | REQ-DEM-03 | R0 | c07-terrain | surface | yes | 37 | smoke |
| `dem.useterrain` | Use as Terrain… | REQ-DEM-03 | R4 | c07-terrain | image | yes | 166 | smoke |
| `dem.hillshade` | Hillshade | REQ-DEM-10 | R1 | c07-terrain | surface | yes | 37 | gdaldem hillshade ±1 DN |
| `dem.slope` | Slope Map | REQ-DEM-10 | R1 | c07-terrain | surface | yes | 37 | gdaldem slope ±0.1° |
| `dem.aspect` | Aspect Map | REQ-DEM-10 | R1 | c07-terrain | surface | yes | 37 | gdaldem aspect ±0.5° |
| `dem.relief` | Colour Relief | REQ-DEM-10 | R1 | c07-terrain | surface | yes | 37 | smoke |
| `dem.contours` | Contours | REQ-DEM-11 | R1 | c07-terrain | surface | yes | 37 | smoke |
| `dem.contourlines` | Contour Lines… | REQ-DEM-11 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `los.p2p` | Point-to-Point LOS | REQ-MEN-10 | R1 | c07-terrain | surface | yes | 37 | line of sight vs profile from GDAL |
| `los.fan` | Range Fan | REQ-DEM-13 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `los.viewshed` | 360° Viewshed | REQ-DEM-13 | R2 | c07-terrain | surface | yes | 37 | gdal_viewshed agreement ≥ 99 % (-cc 0.87, S-15) |
| `los.hlz` | HLZ… | REQ-DEM-14 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.extract` | Terrain Extraction… | REQ-DEM-04 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.groundfilter` | Ground Filter… | REQ-DEM-07 | R2 | c07-terrain | surface | yes | 37 | DTM RMSEz vs 3DEP DEM ≤ 0.15 m |
| `dem.edit` | Post Edit | REQ-DEM-08 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.volume` | Volume | REQ-DEM-15 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.diff` | DEM Difference | REQ-DEM-15 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.accuracy` | DEM Accuracy… | REQ-DEM-17 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `dem.save` | Save DEM As | REQ-DEM-16 | R2 | c07-terrain | surface | yes | 37 | gdalinfo of written COG/DTED (3601² posts for L2) |
| `dem.r2v` | Raster to Vector | REQ-DEM-18 | R2 | c07-terrain | surface | yes | 37 | smoke |
| `msi.bandmath` | Band Math… | REQ-MSI-04 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `msi.index.ndvi` | NDVI | REQ-MSI-04 | R3 | c09-msi | image, spectral | yes | 166 | NDVI vs numpy ± 0.01 |
| `msi.index.ndwi` | NDWI (McFeeters) | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.index.ndwi_gao` | NDWI (Gao) / NDMI | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.index.mndwi` | MNDWI | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.index.ndbi` | NDBI | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.index.savi` | SAVI | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.index.nbr` | NBR | REQ-MSI-04 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.natural` | Natural Colour | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.cir` | Colour Infrared | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.swir` | SWIR | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.agriculture` | Agriculture | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.rededge` | Red Edge | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.preset.bathymetric` | Bathymetric | REQ-MSI-03 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.radiometric` | Radiometric Conversion… | REQ-MSI-05 | R3 | c09-msi | image, spectral | yes | 166 | TOA reflectance vs MTL/MTD formula in numpy |
| `msi.stack` | Layer Stack… | REQ-MSI-04 | R3 | c09-msi | image | yes | 166 | smoke |
| `msi.threshold` | Classifier Threshold… | REQ-MSI-08 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.cluster` | Unsupervised… | REQ-MSI-09 | R3 | c09-msi | image, spectral | yes | 166 | overall accuracy ≥ 90 % on Indian Pines truth |
| `msi.majority` | Majority Filter | REQ-MSI-09 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.sieve` | Sieve | REQ-MSI-09 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.fill` | Fill Unclassified | REQ-MSI-09 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.vectors` | Class Vectors | REQ-MSI-09 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.accuracy` | Accuracy Assessment | REQ-MSI-10 | R3 | c09-msi | spectral | yes | 24 | OA/κ vs scikit-learn (3 decimals) |
| `msi.detect` | Target / Anomaly Detection… | REQ-MSI-11 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `msi.pca` | PCA / MNF… | REQ-MSI-12 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `msi.library` | Spectral Library… | REQ-MSI-13 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.thermal` | Brightness Temperature… | REQ-MSI-14 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `msi.xport` | Xport | REQ-MSI-15 | R3 | c09-msi | image, spectral | yes | 166 | smoke |
| `msi.destripe` | Destripe | REQ-MSI-16 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `msi.change` | Spectral Change… | REQ-MSI-16 | R3 | c09-msi | spectral | yes | 24 | smoke |
| `fmv.open` | Open Video or GMTI… | REQ-FMV-01 | R3 | c01-ingest | — | yes | 6 | smoke |
| `fmv.close` | Close Video | REQ-FMV-05 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.play` | Play / Pause | REQ-FMV-08 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.stepback` | Step Back | REQ-FMV-08 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.stepfwd` | Step Forward | REQ-FMV-08 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.loop` | Loop A–B | REQ-FMV-08 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.klv` | KLV Table | REQ-FMV-02 | R3 | c11-fmv | video | yes | 15 | ST 0601 tags vs klvdata |
| `fmv.basis` | Time Basis… | REQ-FMV-04 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.hud` | HUD | REQ-FMV-08 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.vmti` | VMTI Boxes | REQ-FMV-12 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.capture` | Capture Frame | REQ-FMV-09 | R3 | c11-fmv | video | yes | 15 | footprint vs KLV corner tags ≤ 1 m |
| `fmv.event` | Event Log… | REQ-FMV-10 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.gmti` | Open GMTI… | REQ-FMV-11 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.gmticolour` | Colour by Velocity | REQ-FMV-11 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.measure` | Measure on Video | REQ-FMV-13 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.link` | Link Video Panels | REQ-FMV-13 | R3 | c11-fmv | video | yes | 15 | map/video sync ≤ 33 ms |
| `fmv.csv` | Import Metadata CSV… | REQ-FMV-14 | R3 | c11-fmv | video | yes | 15 | smoke |
| `fmv.export` | Export Clip (burn-in)… | REQ-FMV-13 | R3 | c11-fmv | video | yes | 15 | smoke |
| `mie.play` | Play MIE4NITF Frames | REQ-FMT-14 | R3 | c11-fmv | layer | yes | 92 | smoke |
| `mie.next` | Next MIE4NITF Frame | REQ-FMT-14 | R3 | c11-fmv | layer | yes | 92 | smoke |
| `mie.prev` | Previous MIE4NITF Frame | REQ-FMT-14 | R3 | c11-fmv | layer | yes | 92 | smoke |
| `sar.metadata` | SAR Metadata | REQ-SAR-02 | R3 | c08-sar | sar | yes | 21 | SICD fields vs sarpy |
| `sar.view` | View SAR | REQ-SAR-03 | R3 | c08-sar | image, sar | yes | 166 | smoke |
| `sar.remap` | SAR Remap | REQ-SAR-03 | R3 | c08-sar | sar | yes | 21 | remap switch < 200 ms, no file re-read |
| `sar.anamorphic` | Anamorphic Correction | REQ-SAR-04 | R3 | c08-sar | image, sar | yes | 166 | smoke |
| `sar.ground` | Ground Plane | REQ-SAR-04 | R3 | c08-sar | sar | yes | 21 | image→ground corners vs SARkit ≤ 0.01 m; round trip ≤ 0.05 px |
| `sar.shadows` | Shadows Down | REQ-SAR-04 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.northup` | North Up | REQ-SAR-04 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.overlay` | SAR Overlay | REQ-SAR-04 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.speckle` | Speckle Filter… | REQ-SAR-07 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.acd` | Amplitude Change… | REQ-SAR-08 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.ccd` | Coherent Change… | REQ-SAR-09 | R3 | c08-sar | image, sar | yes | 166 | coherence ≥ 0.8 stable / ≤ 0.4 disturbed vs numpy |
| `sar.pairs` | Pair Finder… | REQ-SAR-10 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.subap` | Sub-aperture Stack | REQ-SAR-11 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.csi` | Colour Sub-aperture | REQ-SAR-11 | R3 | c08-sar | sar | yes | 21 | smoke |
| `sar.pauli` | Pauli Composite | REQ-SAR-13 | R3 | c08-sar | sar | yes | 21 | smoke |
| `pc.header` | Header | REQ-LDR-01 | R2 | c10-lidar | pointcloud | yes | 17 | header fields vs laspy/PDAL |
| `pc.close` | Close 3D View | REQ-LDR-04 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.fit` | Fit Cloud | REQ-LDR-04 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.elevation` | Colour by Elevation | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.intensity` | Colour by Intensity | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.class` | Colour by Class | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.rgb` | Colour by RGB | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.return` | Colour by Return | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.source` | Colour by Point Source | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.time` | Colour by GPS Time | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colour.hag` | Colour by Height Above Ground | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.classes` | Class Visibility | REQ-LDR-05 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.budget` | Point Budget | REQ-LDR-04 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.edl` | Eye-Dome Lighting | REQ-LDR-04 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.shave` | Elevation Shaving | REQ-LDR-06 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.profile` | Profile / Cross-Section | REQ-LDR-07 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.measure` | Measure 3D | REQ-LDR-07 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.dsm` | DSM | REQ-LDR-08 | R2 | c10-lidar | pointcloud | yes | 17 | PDAL writers.gdal max-Z grid |
| `pc.dtm` | DTM | REQ-LDR-08 | R2 | c10-lidar | pointcloud | yes | 17 | PDAL SMRF + writers.gdal min-Z grid |
| `pc.ndsm` | nDSM | REQ-LDR-08 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.intensity` | Intensity Image | REQ-LDR-08 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.density` | Density Image | REQ-LDR-08 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.groundfilter` | Ground Filter | REQ-LDR-09 | R2 | c10-lidar | pointcloud | yes | 17 | PDAL filters.smrf class agreement; DTM RMSEz ≤ 0.15 m |
| `pc.classedit` | Edit Classes | REQ-LDR-09 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.clip` | Clip Box/Polygon | REQ-LDR-09 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.colourise` | Colourise from Image | REQ-LDR-10 | R2 | c10-lidar | pointcloud | yes | 17 | smoke |
| `pc.export` | Export LAS/LAZ | REQ-LDR-10 | R2 | c10-lidar | pointcloud | yes | 17 | laspy re-read of written LAS 1.4 (point count, bbox, classes) |
| `ext.toolbox` | ToolBox | REQ-EXT-01 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.repeat` | Repeat | REQ-EXT-01 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.custom` | Custom Tools | REQ-EXT-03 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.newschema` | New Layer from Schema… | REQ-EXT-10 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.attributes` | Attributes… | REQ-EXT-09 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.styles` | Style Sheet… | REQ-EXT-11 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.fromdsm` | Buildings from DSM | REQ-EXT-16 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.wand` | Magic Wand | REQ-EXT-17 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.edgetrace` | Edge Trace | REQ-EXT-17 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.roadtrace` | Road Trace | REQ-EXT-17 | R2 | c12-vector | feature | yes | 44 | smoke |
| `file.opengpkg` | Open GeoPackage or CSV… | REQ-EXT-22 | R2 | c01-ingest | — | yes | 0 | smoke |
| `ext.vertices` | Edit Vertices | REQ-EXT-06 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.split` | Split | REQ-EXT-06 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.merge` | Merge | REQ-EXT-06 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.reshape` | Reshape | REQ-EXT-06 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.square` | Square | REQ-EXT-05 | R1 | c12-vector | feature | yes | 44 | corners 90° ± 0.1° |
| `ext.droptoground` | Drop to Ground | REQ-EXT-07 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.attrtable` | Feature Attributes Table | REQ-EXT-12 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.attrsets` | Attribute Sets | REQ-EXT-09 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.query` | Feature Query… | REQ-EXT-12 | R1 | c12-vector | feature | yes | 44 | smoke |
| `ext.validate` | Validate Now | REQ-EXT-13 | R2 | c12-vector | feature | yes | 44 | topology errors vs GDAL/GEOS validity |
| `ext.results` | Validation Results | REQ-EXT-13 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.saveas` | Save As | REQ-EXT-21 | R1 | c12-vector | feature | yes | 44 | GeoJSON round trip 1e-9°; GPKG via OGC ETS; SHP/KML via ogrinfo |
| `ext.arcgis` | Hand off to ArcGIS Pro | REQ-EXT-24 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.export3d` | 3D Export | REQ-EXT-25 | R2 | c12-vector | feature | yes | 44 | smoke |
| `ext.texture` | Texture Buildings… | REQ-EXT-15 | R3 | c12-vector | feature | yes | 44 | smoke |
| `obs.toolbox` | Observation Toolbox | REQ-EXT-20 | R3 | c12-vector | observation | yes | 59 | smoke |
| `obs.table` | Observation Table | REQ-EXT-20 | R3 | c12-vector | observation | yes | 59 | smoke |
| `det.import` | Import Detections… | REQ-EXT-19 | R3 | c01-ingest | observation | yes | 59 | smoke |
| `vec.remoteopen` | Edit Online Layer… | REQ-EXT-26 | R3 | c12-vector | feature | yes | 44 | smoke |
| `vec.remotesave` | Save Online Edits | REQ-EXT-26 | R3 | c12-vector | feature | yes | 44 | smoke |
| `det.review` | Review Queue | REQ-EXT-19 | R3 | c12-vector | observation | yes | 59 | smoke |
| `ui.palette` | Command Palette… | REQ-SHL-05 | R4 | c17-workspace | — | yes | 0 | smoke |
| `win.workspace` | Workspace Window | REQ-SHL-02 | R4 | c02-display | — | yes | 0 | smoke |
| `ui.layout` | Interface Layout | REQ-SHL-01 | R4 | c17-workspace | — | yes | 0 | smoke |
| `theme.m3light` | Light | REQ-SHL-13 | R4 | c02-display | — | yes | 0 | smoke |
| `theme.m3dark` | Dark (Material) | REQ-SHL-13 | R4 | c02-display | — | yes | 0 | smoke |
| `hud.radial` | Radial Menu | REQ-SHL-10 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hud.pill` | Contextual Tools | REQ-SHL-08 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hud.flicker` | Hold to Flicker | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hud.quickchip` | Quick Chip | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `deck.export` | Export Session Deck… | REQ-SHL-11 | R4 | c17-workspace | — | yes | 1 | smoke |
| `deck.clear` | Empty Session Deck | REQ-SHL-11 | R4 | c17-workspace | — | yes | 1 | smoke |
| `patrol.next` | Next Target | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `patrol.prev` | Previous Target | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `triage.clear` | Triage: Clear | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `triage.active` | Triage: Active | REQ-SHL-11 | R4 | c17-workspace | — | yes | 0 | smoke |
| `triage.flag` | Triage: Flag | REQ-SHL-11 | R4 | c17-workspace | — | yes | 1 | smoke |
| `net.toggle` | Online | REQ-NET-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `bm.basemap` | Basemap | REQ-NET-04 | R4 | c02-display | — | yes | 0 | smoke |
| `file.openurl` | Open from URL… | REQ-CON-03 | R4 | c01-ingest | — | yes | 0 | smoke |
| `cat.panel` | Catalog | REQ-CON-06 | R4 | c17-workspace | — | yes | 0 | smoke |
| `cat.folder` | Add Folder… | REQ-CON-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `cat.s3keys` | Connect a Bucket… | REQ-CON-04 | R4 | c17-workspace | — | yes | 0 | smoke |
| `cnv.open` | Convert… | REQ-CNV-02 | R4 | c17-workspace | — | yes | 3 | smoke |
| `cnv.cog` | Make Cloud-Optimized Copy | REQ-CNV-01 | R4 | c17-workspace | — | yes | 3 | smoke |
| `glb.toggle` | 2D / 3D | REQ-GLB-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `bm.pmtiles` | Open PMTiles Basemap… | REQ-NET-05 | R4 | c02-display | — | yes | 1 | smoke |
| `lai.find` | Find Objects (AI)… | REQ-LAI-03 | R4 | c17-workspace | — | yes | 3 | smoke |
| `lai.search` | Search Imagery (AI)… | REQ-LAI-06 | R4 | c17-workspace | — | yes | 0 | smoke |
| `lai.contrast` | Auto Contrast | REQ-LAI-07 | R4 | c17-workspace | — | yes | 0 | smoke |
| `lai.square` | Square Corners | REQ-LAI-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `lai.device` | AI Device… | REQ-LAI-01 | R4 | c17-workspace | — | yes | 0 | smoke |
| `align.ai` | Auto Align (AI) | REQ-LAI-05 | R4 | c05-sensor | — | yes | 0 | smoke |
| `rcp.open` | Recipes | REQ-PIP-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `rcp.import` | Open Recipe… | REQ-PIP-01 | R4 | c17-workspace | — | yes | 1 | smoke |
| `hub.psd` | Photoshop (PSD)… | REQ-HUB-01 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.tiff16` | 16-bit TIFF + Curves… | REQ-HUB-01 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.pdf` | Illustrator (Layered PDF)… | REQ-HUB-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.svg` | Layered SVG… | REQ-HUB-02 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.glb` | 3D Terrain (GLB)… | REQ-HUB-03 | R4 | c17-workspace | — | yes | 1 | smoke |
| `hub.usdz` | 3D Terrain (USDZ)… | REQ-HUB-03 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.cot` | CoT Events… | REQ-HUB-04 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.atak` | ATAK Data Package… | REQ-HUB-04 | R4 | c17-workspace | — | yes | 0 | smoke |
| `hub.relay` | Send to Google Sheet… | REQ-HUB-06 | R4 | c17-workspace | — | yes | 0 | smoke |
