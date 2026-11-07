# Format list (REQ-GAP-71)

Generated from the shipped format tables; do not edit. Every format count the product or the site states comes from here.

## Counts

| Where | Count | What it means |
|---|---|---|
| In the browser | 81 | Formats the app opens itself (2 of them as footprint and metadata, pixels through the sidecar) |
| In the browser, variants | 120 | Sub-features of those formats checked by the campaign (COG, BigTIFF, compressions…) |
| Sidecar, windows (GDAL 3.13.3) | 233 | 201 GDAL/OGR drivers (143 raster, 75 vector, 99 writable) and 32 PDAL point-cloud readers (20 writers) |
| Sidecar, linux (GDAL 3.13.3) | 227 | 196 GDAL/OGR drivers (142 raster, 70 vector, 97 writable) and 31 PDAL point-cloud readers (19 writers) |
| Sidecar, either OS | 233 | Distinct drivers and readers across both bundles |

The browser and sidecar counts overlap (GeoTIFF is both), so they are not added together.

## Opened in the browser

| Key | Format | Mode |
|---|---|---|
| `gtiff` | GeoTIFF | full |
| `gtiff.codec.ojpeg` | TIFF old-style JPEG (6) | full |
| `jp2` | JPEG 2000 (standalone) | full |
| `img.jpg` | JPEG picture | full |
| `img.png` | PNG picture | full |
| `dimap.v2` | Airbus DIMAP v2 package | full |
| `zip.imagery` | Imagery delivered in ZIP | full |
| `geopdf.iso32000` | GeoPDF ISO 32000 /GEO | full |
| `refused.mrsid` | MrSID (footprint) | footprint |
| `refused.ecw` | ECW (footprint) | footprint |
| `refused.hfa` | ERDAS Imagine .img (HFA; read natively from 2.1, key kept for history) | full |
| `nitf.v20` | NITF 2.0 | full |
| `nitf.v21` | NITF 2.1 | full |
| `nsif.v10` | NSIF 1.0 | full |
| `nitf.v11` | NITF 1.1 (read from 2.0.4 with the 2.0 layout) | full |
| `nitf.ic.c2` | NITF IC=C2 ARIDPCM | full |
| `nitf.mie4nitf` | MIE4NITF (MTIMSA) | full |
| `rpf.frame` | RPF frame (CADRG/CIB) | full |
| `rpf.toc` | RPF A.TOC | full |
| `sar.sicd` | SICD in NITF | full |
| `sar.sidd` | SIDD in NITF | full |
| `sar.cphd` | CPHD phase history (1.0, 1.1) | full |
| `sar.uavsar` | UAVSAR binary product (.grd/.mlc/.slc/.hgt …) with its .ann | full |
| `sar.s1.safe` | Sentinel-1 SAFE product (manifest.safe) | full |
| `envi` | ENVI raw + .hdr | full |
| `hdf5` | HDF5 / NetCDF-4 cube | full |
| `refused.netcdf3` | NetCDF-3 classic (read natively from 2.1, key kept for history) | full |
| `speclib.envi-sli` | ENVI spectral library .sli | full |
| `speclib.ecostress` | ECOSTRESS / ASTER library spectrum (.spectrum.txt) | full |
| `dted.l0` | DTED Level 0 | full |
| `dted.l1` | DTED Level 1 | full |
| `dted.l2` | DTED Level 2 | full |
| `hgt` | SRTM HGT | full |
| `gpkg.coverage` | GeoPackage gridded coverage | full |
| `gpkg.tiles` | GeoPackage tiles | full |
| `gpkg.features` | GeoPackage features | full |
| `qmesh.tile` | Quantized-mesh tile | full |
| `qmesh.layer` | Quantized-mesh layer.json (local folder / ZIP, 2.1) | full |
| `qmesh.mercator` | Quantized-mesh EPSG:3857 (Web Mercator) layer.json | full |
| `las` | LAS/LAZ | full |
| `pc.bpf` | BPF v3 | full |
| `pc.ascii` | ASCII point cloud | full |
| `vec.geojson` | GeoJSON | full |
| `vec.shp` | Shapefile | full |
| `vec.kml` | KML | full |
| `vec.kmz` | KMZ | full |
| `vec.gml` | GML | full |
| `vec.gpx` | GPX | full |
| `vec.csv.wkt` | CSV with WKT | full |
| `vec.csv.lonlat` | CSV lon/lat | full |
| `det.csv` | Detections CSV (class + confidence) | full |
| `vec.geoparquet` | GeoParquet (WKB; read from 2.0.4, written by Convert) | full |
| `vec.flatgeobuf` | FlatGeobuf (read from 2.0.4, written by Convert) | full |
| `mbtiles` | MBTiles (2.1 FC-05; was refused.mbtiles) | full |
| `mbtiles.mvt` | MBTiles vector (MVT, 2.1 FC-07) | full |
| `pmtiles.png` | PMTiles raster PNG | full |
| `pmtiles.jpeg` | PMTiles raster JPEG | full |
| `pmtiles.webp` | PMTiles raster WebP | full |
| `pmtiles.avif` | PMTiles raster AVIF | full |
| `pmtiles.mvt` | PMTiles vector (MVT, 2.1 FC-07) | full |
| `pmtiles.brotli` | PMTiles Brotli directories or tiles (2.1 FC-06) | full |
| `pmtiles.zstd` | PMTiles Zstandard directories or tiles (2.1 FC-06) | full |
| `gltf` | glTF 2.0 / GLB | full |
| `gltf.draco` | glTF Draco (KHR_draco_mesh_compression) | full |
| `gltf.ktx2` | glTF KTX2 / Basis Universal (KHR_texture_basisu) | full |
| `tiles3d.tileset` | 3D Tiles tileset.json | full |
| `tiles3d.3tz` | 3D Tiles .3tz archive | full |
| `tiles3d.implicit` | 3D Tiles implicit tiling (quadtree / octree, subtrees) | full |
| `tiles3d.i3dm` | 3D Tiles i3dm (instanced models) | full |
| `tiles3d.pnts` | 3D Tiles pnts (point clouds) | full |
| `tiles3d.cmpt` | 3D Tiles cmpt (composites) | full |
| `fmv.ts` | MPEG-TS | full |
| `fmv.ps` | MPEG program stream (.mpg/.mpeg/.vob) | full |
| `fmv.es` | MPEG video elementary stream (.m1v/.m2v, bare .mpg) | full |
| `fmv.platformcsv` | FMV platform telemetry CSV | full |
| `control.gcp` | GCP / control CSV | full |
| `app.project` | GIS Workbench project .gwb | full |
| `app.pack` | Data pack .gwpack | full |
| `app.recipe` | Recipe .gwrecipe.json | full |
| `app.template` | Template .gwt.json | full |
| `app.pptx-template` | PPTX/POTX template | full |

## Sidecar GDAL/OGR drivers

| Driver | Kinds | Read | Write | Format |
|---|---|---|---|---|
| AAIGrid | raster | yes | yes | Arc/Info ASCII Grid (*.asc) |
| ACE2 | raster | yes |  | ACE2 (*.ACE2) |
| ADBC | vector | yes |  | Arrow Database Connectivity |
| ADRG | raster | yes |  | ARC Digitized Raster Graphics (*.gen) |
| AIG | raster | yes |  | Arc/Info Binary Grid |
| AirSAR | raster | yes |  | AirSAR Polarimetric Image |
| AIVector | vector | yes |  | Artificial Intelligence powered vector driver |
| AmigoCloud | vector | yes | yes | AmigoCloud |
| Arrow | vector | yes | yes | (Geo)Arrow IPC File Format / Stream (*.arrow, *.feather, *.arrows, *.ipc) |
| AVCBin | vector | yes |  | Arc/Info Binary Coverage |
| AVCE00 | vector | yes |  | Arc/Info E00 (ASCII) Coverage (*.e00) |
| BAG | raster, multidimensional raster, vector | yes | yes | Bathymetry Attributed Grid (*.bag) |
| BIGGIF | raster | yes |  | Graphics Interchange Format (.gif) (*.gif) |
| BMP | raster | yes | yes | MS Windows Device Independent Bitmap (*.bmp) |
| BSB | raster | yes |  | Maptech BSB Nautical Charts (*.kap) |
| BT | raster | yes | yes | VTP .bt (Binary Terrain) 1.3 Format (*.bt) |
| BYN | raster | yes |  | Natural Resources Canada's Geoid (*.byn, *.err) |
| CAD | raster, vector | yes |  | AutoCAD Driver (*.dwg) |
| CALS | raster | yes | yes | CALS (Type 1) (*.cal, *.ct1) |
| Carto | vector | yes | yes | Carto |
| CEOS | raster | yes |  | CEOS Image |
| COASP | raster | yes |  | DRDC COASP SAR Processor Raster (*.hdr) |
| COG | raster |  | yes | Cloud optimized GeoTIFF generator (*.tif, *.tiff) |
| COSAR | raster | yes |  | COSAR Annotated Binary Matrix (TerraSAR-X) |
| CPG | raster | yes |  | Convair PolGASP |
| CPHD | multidimensional raster | yes |  | Compensated Phase History Data Reader |
| CSV | vector | yes | yes | Comma Separated Value (.csv) (*.csv, *.tsv, *.psv) |
| CSW | vector | yes |  | OGC CSW (Catalog  Service for the Web) |
| CTG | raster | yes |  | USGS LULC Composite Theme Grid |
| DAAS | raster | yes |  | Airbus DS Intelligence Data As A Service driver |
| DERIVED | raster | yes |  | Derived datasets using VRT pixel functions |
| DGN | vector | yes | yes | Microstation DGN (*.dgn) |
| DIMAP | raster | yes |  | SPOT DIMAP |
| DOQ1 | raster | yes |  | USGS DOQ (Old Style) |
| DOQ2 | raster | yes |  | USGS DOQ (New Style) |
| DTED | raster | yes | yes | DTED Elevation Raster (*.dt0, *.dt1, *.dt2) |
| DXF | vector | yes | yes | AutoCAD DXF (*.dxf) |
| E57 | raster | yes |  | ASTM E57 3D file format (image part) (*.e57) |
| ECRGTOC | raster | yes |  | ECRG TOC format (*.xml) |
| EDIGEO | vector | yes |  | French EDIGEO exchange format (*.thf) |
| EEDA | vector | yes |  | Earth Engine Data API |
| EEDAI | raster | yes |  | Earth Engine Data API Image |
| EHdr | raster | yes | yes | ESRI .hdr Labelled (*.bil) |
| EIR | raster | yes |  | Erdas Imagine Raw |
| Elasticsearch | vector | yes | yes | Elastic Search |
| ENVI | raster | yes | yes | ENVI .hdr Labelled |
| ERS | raster | yes | yes | ERMapper .ers Labelled (*.ers) |
| ESAT | raster | yes |  | Envisat Image Format (*.n1) |
| ESRIC | raster | yes |  | Esri Compact Cache (*.json, *.tpkx) |
| ESRIJSON | vector | yes |  | ESRIJSON (*.json) |
| FAST | raster | yes |  | EOSAT FAST Format |
| FlatGeobuf | vector | yes | yes | FlatGeobuf (*.fgb) |
| GDALG | raster, vector | yes |  | GDAL Streamed Algorithm driver (*.gdalg.json) |
| GenBin | raster | yes |  | Generic Binary (.hdr Labelled) |
| GeoJSON | vector | yes | yes | GeoJSON (*.json, *.geojson) |
| GeoJSONSeq | vector | yes | yes | GeoJSON Sequence (*.geojsonl, *.geojsons) |
| GeoRSS | vector | yes | yes | GeoRSS |
| GFF | raster | yes |  | Ground-based SAR Applications Testbed File Format (.gff) (*.gff) |
| GIF | raster | yes | yes | Graphics Interchange Format (.gif) (*.gif) |
| GML | vector | yes | yes | Geography Markup Language (GML) (*.gml, *.xml) |
| GMLAS | vector | yes | yes | Geography Markup Language (GML) driven by application schemas (*.gml, *.xml) |
| GPKG | raster, vector | yes | yes | GeoPackage (*.gpkg, *.gpkg.zip) |
| GPSBabel | vector | yes | yes | GPSBabel (*.mps, *.gdb, *.osm, *.tcx, *.igc) |
| GPX | vector | yes | yes | GPX (*.gpx) |
| GRASSASCIIGrid | raster | yes |  | GRASS ASCII Grid |
| GS7BG | raster | yes | yes | Golden Software 7 Binary Grid (.grd) (*.grd) |
| GSAG | raster | yes | yes | Golden Software ASCII Grid (.grd) (*.grd) |
| GSBG | raster | yes | yes | Golden Software Binary Grid (.grd) (*.grd) |
| GSC | raster | yes |  | GSC Geogrid |
| GTFS | vector | yes |  | General Transit Feed Specification (*.zip) |
| GTI | raster | yes |  | GDAL Raster Tile Index (*.gti.gpkg, *.gti.fgb, *.gti) |
| GTiff | raster | yes | yes | GeoTIFF (*.tif, *.tiff) |
| GTX | raster | yes | yes | NOAA Vertical Datum .GTX (*.gtx) |
| GXF | raster | yes |  | GeoSoft Grid Exchange Format (*.gxf) |
| HDF4 | raster, multidimensional raster | yes |  | Hierarchical Data Format Release 4 (*.hdf) |
| HDF4Image | raster | yes | yes | HDF4 Dataset |
| HDF5 | raster, multidimensional raster | yes |  | Hierarchical Data Format Release 5 (*.h5, *.hdf5) |
| HDF5Image | raster | yes |  | HDF5 Dataset |
| HF2 | raster | yes | yes | HF2/HFZ heightfield raster (*.hf2) |
| HFA | raster | yes | yes | Erdas Imagine Images (.img) (*.img) |
| HTTP | raster, vector | yes |  | HTTP Fetching Wrapper |
| Idrisi | vector | yes |  | Idrisi Vector (.vct) (*.vct) |
| ILWIS | raster | yes | yes | ILWIS Raster Map (*.mpr, *.mpl) |
| IRIS | raster | yes |  | IRIS data (.PPI, .CAPPi etc) (*.ppi) |
| ISCE | raster | yes | yes | ISCE raster |
| ISG | raster | yes |  | International Service for the Geoid (*.isg) |
| ISIS2 | raster | yes |  | USGS Astrogeology ISIS cube (Version 2) |
| ISIS3 | raster | yes | yes | USGS Astrogeology ISIS cube (Version 3) (*.lbl, *.cub) |
| JAXAPALSAR | raster | yes |  | JAXA PALSAR Product Reader (Level 1.1/1.5) |
| JDEM | raster | yes |  | Japanese DEM (.mem) (*.mem) |
| JML | vector | yes | yes | OpenJUMP JML (*.jml) |
| JP2OpenJPEG | raster, vector | yes | yes | JPEG-2000 driver based on JP2OpenJPEG library (*.jp2, *.j2k) |
| JPEG | raster | yes | yes | JPEG JFIF (*.jpg, *.jpeg) |
| JPEGXL | raster | yes | yes | JPEG-XL (*.jxl) |
| JSONFG | vector | yes | yes | OGC Features and Geometries JSON (*.json) |
| KML | vector | yes | yes | Keyhole Markup Language (KML) (*.kml) |
| KMLSUPEROVERLAY | raster | yes | yes | Kml Super Overlay (*.kml, *.kmz) |
| KRO | raster | yes | yes | KOLOR Raw (*.kro) |
| L1B | raster | yes |  | NOAA Polar Orbiter Level 1b Data Set |
| LAN | raster | yes |  | Erdas .LAN/.GIS |
| LCP | raster | yes | yes | FARSITE v.4 Landscape File (.lcp) (*.lcp) |
| Leveller | raster | yes | yes | Leveller heightfield (*.ter) |
| LIBERTIFF | raster | yes |  | GeoTIFF (using LIBERTIFF library) (*.tif, *.tiff) |
| LIBKML | vector | yes | yes | Keyhole Markup Language (LIBKML) (*.kml, *.kmz) |
| LOSLAS | raster | yes |  | NADCON .los/.las Datum Grid Shift |
| LVBAG | vector | yes |  | Kadaster LV BAG Extract 2.0 (*.xml) |
| MAP | raster | yes |  | OziExplorer .MAP |
| MapML | vector | yes | yes | MapML |
| MBTiles | raster, vector | yes | yes | MBTiles (*.mbtiles) |
| MEM | raster, multidimensional raster, vector | yes | yes | In Memory raster, vector and multidimensional raster |
| MFF | raster | yes |  | Vexcel MFF Raster (*.hdr) |
| MFF2 | raster | yes |  | Vexcel MFF2 (HKV) Raster |
| MiraMonRaster | raster | yes | yes | MiraMon Raster Images (*.rel, *.img) |
| MiraMonVector | vector | yes | yes | MiraMon Vectors (.pol, .arc, .pnt) (*.pol, *.arc, *.pnt) |
| MRF | raster | yes | yes | Meta Raster Format (*.mrf) |
| MSGN | raster | yes |  | EUMETSAT Archive native (.nat) (*.nat) |
| MSSQLSpatial | vector | yes | yes | Microsoft SQL Server Spatial Database |
| MVT | vector | yes | yes | Mapbox Vector Tiles (*.mvt, *.mvt.gz, *.pbf) |
| NAS | vector | yes |  | NAS - ALKIS (*.xml) |
| NDF | raster | yes |  | NLAPS Data Format |
| netCDF | raster, multidimensional raster, vector | yes | yes | Network Common Data Format (*.nc) |
| NGSGEOID | raster | yes |  | NOAA NGS Geoid Height Grids (*.bin) |
| NGW | raster, vector | yes | yes | NextGIS Web |
| NITF | raster | yes | yes | National Imagery Transmission Format (*.ntf) |
| NOAA_B | raster | yes |  | NOAA GEOCON/NADCON5 .b format (*.b) |
| NSIDCbin | raster | yes |  | NSIDC Sea Ice Concentrations binary (.bin) (*.bin) |
| NTv2 | raster | yes |  | NTv2 Datum Grid Shift (*.gsb, *.gvb) |
| NWT_GRC | raster | yes |  | Northwood Classified Grid Format .grc/.tab (*.grc) |
| NWT_GRD | raster | yes | yes | Northwood Numeric Grid Format .grd/.tab (*.grd) |
| OAPIF | vector | yes |  | OGC API - Features |
| ODBC | vector | yes |  | Open Database Connectivity (ODBC) (*.mdb, *.accdb) |
| ODS | vector | yes | yes | Open Document/ LibreOffice / OpenOffice Spreadsheet (*.ods) |
| OGCAPI | raster, vector | yes |  | OGCAPI |
| OGR_GMT | vector | yes | yes | GMT ASCII Vectors (.gmt) (*.gmt) |
| OGR_PDS | vector | yes |  | Planetary Data Systems TABLE |
| OGR_VRT | vector | yes |  | VRT - Virtual Datasource (*.vrt) |
| OpenFileGDB | raster, vector | yes | yes | ESRI FileGeodatabase (using OpenFileGDB) (*.gdb) |
| OSM | vector | yes |  | OpenStreetMap XML and PBF (*.osm, *.pbf) |
| Parquet | vector | yes | yes | (Geo)Parquet (*.parquet) |
| PAux | raster | yes |  | PCI .aux Labelled |
| PCIDSK | raster, vector | yes | yes | PCIDSK Database File (*.pix) |
| PCRaster | raster | yes | yes | PCRaster Raster File (*.map) |
| PDS | raster | yes |  | NASA Planetary Data System |
| PDS4 | raster, vector | yes | yes | NASA Planetary Data System 4 (*.xml) |
| PGDUMP | vector |  | yes | PostgreSQL SQL dump (*.sql) |
| PGeo | vector | yes |  | ESRI Personal GeoDatabase (*.mdb) |
| PLMOSAIC | raster | yes |  | Planet Labs Mosaics API |
| PLSCENES | raster, vector | yes |  | Planet Labs Scenes API |
| PMTiles | vector | yes | yes | ProtoMap Tiles (*.pmtiles) |
| PNG | raster | yes | yes | Portable Network Graphics (*.png) |
| PNM | raster | yes | yes | Portable Pixmap Format (netpbm) (*.pgm, *.ppm, *.pnm) |
| PostgreSQL | vector | yes | yes | PostgreSQL/PostGIS |
| PRF | raster | yes |  | Racurs PHOTOMOD PRF (*.prf) |
| RCM | raster | yes |  | Radarsat Constellation Mission XML Product |
| RIK | raster | yes |  | Swedish Grid RIK (.rik) (*.rik) |
| RMF | raster | yes | yes | Raster Matrix Format (*.rsw) |
| ROI_PAC | raster | yes | yes | ROI_PAC raster |
| RPFTOC | raster | yes |  | Raster Product Format TOC format (*.toc) |
| RRASTER | raster | yes | yes | R Raster (*.grd) |
| RS2 | raster | yes |  | RadarSat 2 XML Product |
| RST | raster | yes | yes | Idrisi Raster A.1 (*.rst) |
| S102 | raster, multidimensional raster | yes | yes | S-102 Bathymetric Surface Product (*.h5) |
| S104 | raster, multidimensional raster | yes | yes | S-104 Water Level Information for Surface Navigation Product (*.h5) |
| S111 | raster, multidimensional raster | yes | yes | S-111 Surface Currents Product (*.h5) |
| S57 | vector | yes | yes | IHO S-57 (ENC) (*.000) |
| SAFE | raster | yes |  | Sentinel-1 SAR SAFE Product |
| SAGA | raster | yes | yes | SAGA GIS Binary Grid (.sdat, .sg-grd-z) (*.sdat, *.sg-grd-z) |
| SAR_CEOS | raster | yes |  | CEOS SAR Image |
| Selafin | vector | yes | yes | Selafin |
| SENTINEL2 | raster | yes |  | Sentinel 2 |
| SIGDEM | raster | yes | yes | Scaled Integer Gridded DEM .sigdem (*.sigdem) |
| SNAP_TIFF | raster | yes |  | Sentinel Application Processing GeoTIFF |
| SNODAS | raster | yes |  | Snow Data Assimilation System (*.hdr) |
| SQLite | vector | yes | yes | SQLite / Spatialite (*.sqlite, *.db) |
| SRP | raster | yes |  | Standard Raster Product (ASRP/USRP) (*.img) |
| SRTMHGT | raster | yes | yes | SRTMHGT File Format (*.hgt) |
| STACIT | raster | yes |  | Spatio-Temporal Asset Catalog Items |
| STACTA | raster | yes |  | Spatio-Temporal Asset Catalog Tiled Assets (*.json) |
| SXF | vector | yes |  | Storage and eXchange Format (*.sxf) |
| Terragen | raster | yes | yes | Terragen heightfield (*.ter) |
| TGA | raster | yes |  | TGA/TARGA Image File Format (*.tga) |
| TIGER | vector | yes |  | U.S. Census TIGER/Line |
| TIL | raster | yes |  | EarthWatch .TIL |
| TileDB | raster, multidimensional raster, vector | yes | yes | TileDB |
| TopoJSON | vector | yes |  | TopoJSON (*.json, *.topojson) |
| TSX | raster | yes |  | TerraSAR-X Product |
| USGSDEM | raster | yes |  | USGS Optional ASCII DEM (and CDED) (*.dem) |
| VDV | vector | yes | yes | VDV-451/VDV-452/INTREST Data Format (*.txt, *.x10) |
| VFK | vector | yes |  | Czech Cadastral Exchange Data Format (*.vfk) |
| VICAR | raster, vector | yes | yes | MIPL VICAR file |
| VRT | raster, multidimensional raster | yes | yes | Virtual Raster (*.vrt) |
| WAsP | vector | yes | yes | WAsP .map format (*.map) |
| WCS | raster | yes |  | OGC Web Coverage Service |
| WEBP | raster | yes | yes | WEBP (*.webp) |
| WFS | vector | yes |  | OGC WFS (Web Feature Service) |
| WMS | raster | yes | yes | OGC Web Map Service |
| WMTS | raster | yes | yes | OGC Web Map Tile Service |
| XLSX | vector | yes | yes | MS Office Open XML spreadsheet (*.xlsx, *.xlsm) |
| XYZ | raster | yes | yes | ASCII Gridded XYZ (*.xyz) |
| Zarr | raster, multidimensional raster | yes | yes | Zarr (*.zarr) |
| ZMap | raster | yes | yes | ZMap Plus Grid (*.dat) |
