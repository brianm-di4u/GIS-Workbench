# T&E data catalogue

Generated 2026-10-27T23:36:32.614Z from `build/campaign/corpus.json` (117 items). Tier A = anonymous download by `build/campaign/fetch.mjs`; tier B = free login, downloaded by the owner into `TE-corpus/<id>/`; RS = already held in `Research/samples`.

| Area | Items | Size | On disk |
|---|---|---|---|
| 3d | 6 | 38.0 MB | 6 |
| dem | 13 | 853.3 MB | 12 |
| eo | 10 | 3.88 GB | 10 |
| fmv | 9 | 1.97 GB | 9 |
| geopdf | 2 | 80.6 MB | 2 |
| gmti | 2 | 3 kB | 1 |
| hsi | 10 | 17.86 GB | 8 |
| landsat | 3 | 1.74 GB | 2 |
| lidar | 8 | 1.78 GB | 8 |
| live | 11 | 0 kB | 0 |
| naip | 1 | 386.6 MB | 1 |
| nitf | 16 | 58.6 MB | 15 |
| raster | 1 | 130 kB | 1 |
| robustness | 1 | 166 kB | 1 |
| sar | 8 | 4.62 GB | 8 |
| sentinel2 | 2 | 2.16 GB | 2 |
| vector | 14 | 5.21 GB | 14 |

## 3d

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `3d-gltf-sample-assets` | glTF 2.0 / GLB (Minimal (Box), textured legacy (Duck), PBR metallic-roughness with emissive/normal/ORM (BoomBox); KHR_draco_mesh_compression (Box-Draco); data-URI buffers (Box-Embedded)) | [Khronos Group](https://github.com/KhronosGroup/glTF-Sample-Assets) | Box: CC-BY-4.0; Duck: SCEA Shared Source 1.0 + CC-BY-4.0; BoomBox: CC0-1.0 + CC-BY-4.0 (pe | A | 21.5 MB | yes |
| `3d-tiles-discrete-lod` | 3D Tiles 1.0 (b3dm) (3-level REPLACE refinement, b3dm (glTF inside), geometricError LOD) | [Cesium GS](https://github.com/CesiumGS/3d-tiles-samples/tree/main/1.0/TilesetWithDiscreteLOD) | CC0-1.0 (per tileset README) | A | 4.8 MB | yes |
| `3d-tiles-sparse-implicit-quadtree` | 3D Tiles 1.1 (implicit, glb) (Implicit QUADTREE, subtreeLevels 3, sparse availability bitstreams (.subtree), 32 glb leaf contents at level 5) | [Cesium GS](https://github.com/CesiumGS/3d-tiles-samples/tree/main/1.1/SparseImplicitQuadtree) | CC0-1.0 | A | 43 kB | yes |
| `3d-tiles-multiple-contents` | 3D Tiles 1.1 (glb) (tile.contents[] with point-cloud glb + triangle glb) | [Cesium GS](https://github.com/CesiumGS/3d-tiles-samples/tree/main/1.1/MultipleContents) | CC0-1.0 | A | 381 kB | yes |
| `3d-cityjson-samples` | CityJSON (delft.json (BGT-derived, many CityObjects); DH_01_subs CityJSON 1.1 BuildingParts; multi_lod.json with multiple LoDs) | [CityJSON / TU Delft 3D geoinformation](https://www.cityjson.org/datasets/) | MIT (cjio repo); underlying Den Haag/Delft data is open municipal data (licence per source | A | 1.5 MB | yes |
| `terrain-qmesh-heremaps-examples` | Cesium quantized-mesh 1.0 (.terrain) (TMS tile tree, no layer.json) | [GitHub heremaps/quantized-mesh-viewer @4fa86fe](https://github.com/heremaps/quantized-mesh-viewer) | MIT (repository LICENSE) | A | 9.8 MB | yes |

## dem

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-dem-derived-s35w059` | GeoTIFF/COG float32 + DTED1 | [derived](derived) | Public domain source (SRTM); see srtm-hgt-s35w059/SOURCE.txt. | RS | 5.1 MB | yes |
| `rs-dted-gdal` | DTED0/1 | [https://download.osgeo.org/gdal/data/dted/](https://download.osgeo.org/gdal/data/dted/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 2.9 MB | yes |
| `rs-srtm-hgt-s35w059` | SRTM HGT | [https://registry.opendata.aws/terrain-tiles/](https://registry.opendata.aws/terrain-tiles/) | SRTM: U.S. Government public domain. Terrain Tiles attribution terms: https://github.com/t | RS | 4.5 MB | yes |
| `derived-dem-utm13-viewshed` | GeoTIFF (float32 DEM + Byte viewshed (255 visible)) | [Derived (GDAL) from cop-dem-glo30-n39w106](build/campaign/derive.py) | Copernicus DEM licence (free use with attribution) | A | 3.5 MB | yes |
| `cop-dem-glo30-n39w106` | GeoTIFF/COG (1 arcsec (~30 m), Float32, EGM2008 heights, DSM) | [ESA / Copernicus (AWS Open Data)](https://registry.opendata.aws/copernicus-dem/) | Copernicus DEM GLO-30 Public / GLO-90 licence (free for the general public): https://datas | A | 39.2 MB | yes |
| `cop-dem-glo30-n40w106` | GeoTIFF/COG (1 arcsec, Float32) | [ESA / Copernicus (AWS Open Data)](https://registry.opendata.aws/copernicus-dem/) | Copernicus DEM GLO-30 Public / GLO-90 licence (free for the general public): https://datas | A | 38.9 MB | yes |
| `cop-dem-glo90-n39w106` | GeoTIFF/COG (3 arcsec (~90 m), Float32) | [ESA / Copernicus (AWS Open Data)](https://registry.opendata.aws/copernicus-dem/) | Copernicus DEM GLO-30 Public / GLO-90 licence (free for the general public): https://datas | A | 4.8 MB | yes |
| `usgs-3dep-13-n40w106` | GeoTIFF/COG (1/3 arcsec (~10 m) Float32, NAVD88, NAD83; plus 1 arcsec version) | [USGS National Map](https://www.usgs.gov/3d-elevation-program) | US Government public domain | A | 465.0 MB | yes |
| `usgs-3dep-1m-x48y441-drcog2020` | GeoTIFF/COG (1 m, UTM zone 13N NAD83, NAVD88, 10x10 km) | [USGS National Map](https://apps.nationalmap.gov/downloader/) | US Government public domain | A | 254.3 MB | yes |
| `srtm-skadi-n39w106-n40w106` | SRTM HGT (gzip) (3601x3601 Int16 big-endian, EGM96, 1 arcsec) | [NASA/USGS SRTM via Mapzen / AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | SRTM is US Government public domain; Terrain Tiles attribution terms https://github.com/ti | A | 27.5 MB | yes |
| `gdal-dted-samples` | DTED0 \| DTED1 \| DTED (1-arcsec) (n43.dt0 (W080 N43, 30 arcsec); n48.dt1 (W124 N48, 3 arcsec); w118n033.dt1 (starts with an 80-byte HDR1 tape label before UHL, an edge case); l5102.dhm (E005 N47, 1 arcsec spacing in UHL = DTED2-like, .dhm extension)) | [OSGeo / GDAL project](https://download.osgeo.org/gdal/data/dted/) | Redistributed by OSGeo as GDAL test data (originally US Government DTED); no explicit lice | A | 7.6 MB | yes |
| `gdal-autotest-dted-edge` | DTED0 \| DTED1 (malformed) (negative / robustness tests) | [OSGeo GDAL (GitHub)](https://github.com/OSGeo/gdal/tree/master/autotest/gdrivers/data/dted) | GDAL autotest data under the GDAL MIT/X licence (https://github.com/OSGeo/gdal/blob/master | A | 83 kB | yes |
| `usgs-srtm-dted2-n39w106` | DTED2 (3601x3601, 1 arcsec, EGM96) | [USGS EROS EarthExplorer](https://earthexplorer.usgs.gov/) | US Government public domain; free USGS ERS login required | B | 0 kB | no |

## eo

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-geotiff-gdal-small` | GeoTIFF | [https://download.osgeo.org/gdal/data/gtiff/](https://download.osgeo.org/gdal/data/gtiff/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 504 kB | yes |
| `rs-geotiff-wv3-rpc-cog` | GeoTIFF/COG RPC | [derived](derived) | IARPA Multi-View Stereo 3D Mapping benchmark (JHU/APL), hosted in the SpaceNet AWS bucket. | RS | 5.9 MB | yes |
| `rs-jpeg-png-worldfile` | JPEG/PNG + world file | [derived](derived) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 103 kB | yes |
| `rs-msi-spacenet2-wv3` | GeoTIFF 8-band | [https://spacenet-dataset.s3.amazonaws.com/spacenet/SN2_buildings/](https://spacenet-dataset.s3.amazonaws.com/spacenet/SN2_buildings/) | CC BY-SA 4.0 (SpaceNet Buildings Dataset v2, https://spacenet.ai/spacenet-buildings-datase | RS | 3.0 MB | yes |
| `rs-nitf-wv3-mvs-stereo-chips` | NITF2.1 RPC00B | [https://spacenet-dataset.s3.amazonaws.com/Hosted-Datasets/MVS_dataset/WV3/PAN/](https://spacenet-dataset.s3.amazonaws.com/Hosted-Datasets/MVS_dataset/WV3/PAN/) | IARPA Multi-View Stereo 3D Mapping benchmark (JHU/APL), hosted in the SpaceNet AWS bucket. | RS | 11.2 MB | yes |
| `derived-gtiff-codec-matrix` | GeoTIFF (NONE/LZW/DEFLATE/PACKBITS/JPEG/WEBP/ZSTD/LERC/LERC_ZSTD/LERC_DEFLATE) | [Derived (GDAL) from corpus items](build/campaign/derive.py) | Public domain (USDA NAIP) and Copernicus DEM licence (free use with attribution) | A | 30.5 MB | yes |
| `eo-maxar-libya-floods-wv3-prepost` | GeoTIFF/COG (WV03 ARD ortho, UTM 34N; ms = 8-band VNIR 16-bit (~1.2 m), pan = 16-bit (~0.3 m), visual = 3-band 8-bit; 0% cloud both dates) | [Maxar Open Data Program](https://www.maxar.com/open-data/libya-floods) | CC BY-NC 4.0 (Creative Commons Attribution Non Commercial 4.0; AWS Open Data Registry maxa | A | 968.8 MB | yes |
| `eo-spacenet-vegas-wv3-pan-ms-r1c1` | GeoTIFF (DigitalGlobe LV2A Standard tile) + DG XML (WV03, PAN 16-bit 16384x16384 (~0.31 m), MS 8-band 16-bit (~1.24 m), RPC00B in XML <RPB> block, off-nadir 16.8, 0% cloud, 2015-10-22) | [SpaceNet (AWS Open Data)](https://spacenet.ai/spacenet-buildings-dataset-v2/) | CC BY-SA 4.0 (The SpaceNet Dataset by SpaceNet Partners, https://spacenet.ai/off-nadir-bui | A | 805.4 MB | yes |
| `eo-spacenet-atlanta-wv2-l1b-rpc` | GeoTIFF (DigitalGlobe LV1B, sensor geometry) + RPB/IMD/ATT/EPH/GEO/TIL/XML (WV02 LV1B 16-bit; PAN + 8-band MUL; RPC00B (.RPB); off-nadir 52.5 / 53.7 deg, 2009-12-22, 0% cloud) | [SpaceNet (AWS Open Data)](https://spacenet.ai/off-nadir-building-detection/) | CC BY-SA 4.0 (The SpaceNet Dataset by SpaceNet Partners, https://spacenet.ai/off-nadir-bui | A | 581.8 MB | yes |
| `ieee-dfc2019-track2-val` | GeoTIFF + METADATA.json (Archive kept whole; one tile set (JAX_163_001_006) extracted) | [IEEE DataPort (Open Access)](https://doi.org/10.21227/c6tm-vw12) | CC BY 4.0 (IEEE DataPort Open Access; uploads are CC BY under the DataPort Terms of Servic | B | 1.47 GB | yes |

## fmv

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-mpegts-klv-synthetic` | MPEG-TS/KLV (synthetic) | [synthetic](synthetic) | Synthetic test data created by WS14; no third-party content. Free to use. | RS | 993 kB | yes |
| `fmv-ffmpeg-day-flight` | MPEG-TS/KLV (MPEG-2 TS, H.264 1280x720, asynchronous KLVA ST 0601 (valid checksums; Tag 22 encoded as 4 bytes, which strict decoders reject)) | [FFmpeg samples archive](https://samples.ffmpeg.org/MPEG2/mpegts-klv/) | No licence published (public test sample; redistribution rights unclear) | A | 102.0 MB | yes |
| `fmv-ffmpeg-night-flight-ir` | MPEG-TS/KLV (MPEG-2 TS, H.264 1280x720 IR, asynchronous KLVA ST 0601) | [FFmpeg samples archive](https://samples.ffmpeg.org/MPEG2/mpegts-klv/) | No licence published (public test sample; redistribution rights unclear) | A | 170.1 MB | yes |
| `fmv-esri-truck-tutorial` | MPEG-TS/KLV (zip) (H.264 video + AAC audio + synchronous KLVA (ST 0601) in TS. Known negative traits: no metadata_std descriptor, metadata AU discontinuities, PCR interval violations) | [Esri](https://www.arcgis.com/home/item.html?id=55ec6f32d5e342fcbfba376ca2cc409a) | Esri tutorial data; no explicit licence on the item (Esri Terms of Use apply); publicly sh | A | 199.5 MB | yes |
| `fmv-impleotv-damaged-corpus` | MPEG-TS/KLV (zip) (15 MPEG-TS faults (CC error, duplicate packets, PAT/PMT blackout/removal, PCR backward/jump, PTS/DTS monotonicity, PSI CRC, sync-byte corruption, TEI, PES length, PCR/PTS drift) + 6 KLV faults (corrupt checksum, corrupt key, corrupt packets, duplicate tags, missing mandatory ST0601 tags, missing KLV PID)) | [ImpleoTV Systems Ltd](https://impleotv.com/content/stinspector/help/docs/test-files/) | No licence stated (public GitHub release asset 'Stanag Inspector demo files'); treat as lo | A | 9.2 MB | yes |
| `fmv-jmisb-st0903-vector` | KLV binary / JSON (ST 0903 VMTI local set (650 B); ST 1201 IMAPB floating-point test cases (JSON)) | [WestRidge Systems (jmisb)](https://github.com/WestRidgeSystems/jmisb) | MIT | A | 667 kB | yes |
| `fmv-klvdata-st0601-packets` | KLV binary (ST 0601 UAS Datalink LS packets (dynamic+constant, dynamic-only)) | [paretech/klvdata](https://github.com/paretech/klvdata) | MIT | A | 0 kB | yes |
| `fmv-libmisbklv-fixtures` | KLV binary / MPEG-TS (VMTI ST0903 nested/standalone/VTarget (hand-authored; some omit mandatory items); ST0601 synthetic packets; synchronous (0x15) / asynchronous (0x06) metadata TS snippets) | [nitsuga/libmisbklv](https://github.com/nitsuga/libmisbklv) | Apache-2.0 | A | 19 kB | yes |
| `fmv-bambi-flights` | MPEG-TS (H.264, remuxed) + platform metadata CSV; source MP4 + DJI SRT (derived/<flight>/*.ts are lossless -c copy remuxes; *.csv are the app's fmv.csv import built by build/campaign/bambi_to_fmv.py) | [Zenodo, BAMBI Raw Dataset (bambi.eco)](https://zenodo.org/records/18983480) | CC BY 4.0 (Zenodo record licence) | A | 1.49 GB | yes |

## geopdf

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `geopdf-ustopo-vinehill-honkerbay-current` | GeoPDF (ISO 32000 geospatial PDF, layered) (1:24,000, layered (OCG) vector + orthoimage + shaded relief, embedded georeferencing (Measure/LGIDict)) | [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/us-topo-maps-america) | Public domain (USGS; https://www.usgs.gov/information-policies-and-instructions/copyrights | A | 66.1 MB | yes |
| `geopdf-ustopo-vinehill-2012` | GeoPDF (2012-generation US Topo (TerraGo-era GeoPDF encoding)) | [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/us-topo-maps-america) | Public domain (USGS) | A | 14.5 MB | yes |

## gmti

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `gmti-stanag4607-none` | STANAG 4607 (n/a) | [n/a](https://github.com/pentlandedge/s4607) | n/a | A | 0 kB | no |
| `gmti-stanag4607-trane293-fixtures` | STANAG 4607 (.gmti) (8 small packets, independently encoded) | [GitHub trane293/stanag4607 @5a4cdbb](https://github.com/trane293/stanag4607/tree/main/tests/fixtures) | MIT (repository LICENSE) | A | 3 kB | yes |

## hsi

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-envi-hsi-indian-pines` | ENVI BSQ | [derived](derived) | CC0 1.0 Universal. | RS | 9.3 MB | yes |
| `rs-hsi-indian-pines` | GeoTIFF 220-band | [https://purr.purdue.edu/publications/1947/1](https://purr.purdue.edu/publications/1947/1) | CC0 1.0 Universal (public domain dedication). | RS | 9.3 MB | yes |
| `emit-l2a-rfl-cuprite` | NetCDF4 (285 bands 381-2493 nm, 60 m, unorthorectified swath with GLT) | [NASA LP DAAC](https://lpdaac.usgs.gov/products/emitl2arflv001/) | NASA open data, no use restrictions; Earthdata Login required to download | B | 1.90 GB | yes |
| `emit-l1b-rad-cuprite` | NetCDF4 (radiance uW/cm2/sr/nm, 285 bands) | [NASA LP DAAC](https://lpdaac.usgs.gov/products/emitl1bradv001/) | NASA open data, no use restrictions; Earthdata Login required | B | 1.96 GB | yes |
| `aviris-classic-f130410t01p00r09` | ENVI (binary + .hdr) in tar.gz (224 bands 365-2500 nm; reflectance image uncompressed 430 MB) | [NASA JPL AVIRIS](https://aviris.jpl.nasa.gov/dataportal/) | NASA/JPL AVIRIS data, freely available with no usage restrictions (acknowledgement request | A | 1.32 GB | yes |
| `enmap-potsdam-l2a-subset` | GeoTIFF (224-band Float32) + GeoPackage (EnMAP L2A scene ENMAP01-____L2A-DT0000001867_20220724T104526Z, 30 m, 224 bands 400-2450 nm, 330x200 px) | [DLR / EnMAP-Box (Humboldt-Universitat zu Berlin)](https://github.com/EnMAP-Box/enmap-box/tree/main/enmapbox/exampledata) | EnMAP data © DLR, redistributed in the EnMAP-Box repository (GPL-3.0); land-cover truth de | A | 38.5 MB | yes |
| `usgs-splib07-ascii` | ASCII spectra (zip) (splib07a native resolution; cvAVIRISc2013 resampled to AVIRIS 2013 bands (matches aviris-classic-f130410t01p00r09)) | [USGS](https://www.sciencebase.gov/catalog/item/586e8c88e4b0f5ce109fccae) | US Government public domain (USGS) | A | 26.1 MB | yes |
| `prisma-l2d-sample` | HDF5 (HE5) (~240 bands 400-2500 nm, 30 m, 30x30 km) | [ASI (Italian Space Agency)](https://prisma.asi.it/) | ASI PRISMA data licence (free for registered users; non-commercial/research) | B | 0 kB | no |
| `enmap-l2a-full-scene` | GeoTIFF (SPECTRAL_IMAGE.TIF) + METADATA.XML (224 bands, 30 m, 30x30 km) | [DLR EOC](https://www.enmap.org/data_access/) | EnMAP data licence (free; registration via DLR EOWEB GeoPortal) | B | 0 kB | no |
| `ieee-dfc2018-houston` | ENVI-style .pix/.hdr HSI + LAS 1.x + GeoTIFF/TFW (Archive kept whole; extracted subset: full HSI cube, training/test GT rasters, DSM_C12 and DEM_C123_3msr rasters, RGB tile 272652_3289689, LiDAR tiles C1 and C123 272652_3289689) | [IEEE DataPort (Open Access)](https://doi.org/10.21227/jnh9-nz89) | CC BY 4.0 (IEEE DataPort Open Access; uploads are CC BY under the DataPort Terms of Servic | B | 12.60 GB | yes |

## landsat

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `landsat8-c1-l1tp-044034-20210508` | GeoTIFF (C1 L1TP, 16-bit DN, B1-B11 (B8 pan 15 m), BQA, MTL.txt (radiance/reflectance rescaling), ANG.txt; cloud cover 0.07%) | [USGS, via Google Cloud Public Datasets (gcp-public-data-landsat)](https://cloud.google.com/storage/docs/public-datasets/landsat) | Public domain (USGS Landsat data, no restrictions; https://www.usgs.gov/information-polici | A | 1.04 GB | yes |
| `landsat8-c2-l1tp-044034-20240820-tierb` | GeoTIFF/COG (C2 L1TP 16-bit DN, B1-B11, QA_PIXEL, QA_RADSAT, MTL.txt/xml/json, ANG.txt, per-pixel angle bands) | [USGS EROS (LandsatLook / EarthExplorer)](https://landsatlook.usgs.gov/stac-browser/collection02/level-1/standard/oli-tirs/2024/044/034/LC08_L1TP_044034_20240820_20240830_02_T1) | Public domain (USGS) | B | 0 kB | no |
| `landsat8-c2-l2sp-044034-20240820` | GeoTIFF/COG (C2 L2SP: SR_B1-B7 (scaled reflectance uint16), ST_B10, ST_QA, QA_PIXEL, QA_RADSAT, SR_QA_AEROSOL, C2 MTL.txt/xml/json, ANG.txt; cloud 0.03%) | [USGS, via Microsoft Planetary Computer (landsat-c2-l2)](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2) | Public domain (USGS; https://www.usgs.gov/core-science-systems/hdds/data-policy) | A | 698.6 MB | yes |

## lidar

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-lidar-las-laz-copc` | LAS/LAZ/COPC | [https://github.com/PDAL/PDAL/tree/master/test/data/las](https://github.com/PDAL/PDAL/tree/master/test/data/las) | Test data from PDAL (BSD-style licence, Hobu Inc.), laspy (BSD-2-Clause) and copc.js (MIT, | RS | 9.0 MB | yes |
| `derived-las-pdrf-5-9` | LAS (PDRF 5, PDRF 9 (waveform packet fields, no waveform data)) | [Derived (laspy) from rs-lidar-las-laz-copc](build/campaign/derive.py) | PDAL/laspy test data (BSD) | A | 13.4 MB | yes |
| `lidar-3dep-co-drcog-2020-2x2` | LAZ (LAS1.4 PDRF6) (LAS 1.4, PDRF 6, 30-byte records, WKT CRS (global encoding bit 4), ~36.7M pts/tile; tiles w0474-0475 / n4416-4417 form a 2x2 block) | [USGS 3D Elevation Program (3DEP)](https://apps.nationalmap.gov/downloader/) | Public domain (US Government work) | A | 1.11 GB | yes |
| `lidar-autzen-classified-copc` | COPC (LAS 1.4 PDRF 7 (RGB), LAZ-compressed COPC, 10,653,336 pts, WKT CRS) | [Hobu Inc. / PDAL](https://github.com/PDAL/data/tree/main/autzen) | Public sample data distributed by PDAL (PDAL/data repo; no explicit data licence; source l | A | 81.1 MB | yes |
| `lidar-las-version-matrix` | LAS1.0-1.4 / LAZ / COPC (Coverage: LAS 1.0,1.1,1.2,1.3,1.4; PDRF 0,1,2,3,4,6,7,8,10; extra bytes, EVLR, WKT CRS, GeoTIFF+WKT, 390 VLRs, negatives. NOT covered: PDRF 5 and 9 (none found in public test corpora).) | [PDAL / laspy / LAStools / laz-perf (GitHub)](https://github.com/PDAL/PDAL/tree/master/test/data/las) | Test data distributed in repos: PDAL BSD-3-Clause; laspy BSD-2-Clause; LAStools/LASzip LGP | A | 56.0 MB | yes |
| `lidar-opentopo-co23-roumelis` | LAZ (LAS1.4 PDRF6) + LAX (LAS 1.4 PDRF 6, WKT, UTM 13N 1 km tiles, 0.25-7.4M pts/tile; LAStools .lax spatial index sidecars) | [OpenTopography / NCALM](https://doi.org/10.5069/G9HD7SMZ) | CC BY 4.0 | A | 44.6 MB | yes |
| `ieee-dfc2019-track4-val` | ASCII XYZ point cloud + class truth (10 tiles; coordinates are tile-local offsets) | [IEEE DataPort (Open Access)](https://doi.org/10.21227/c6tm-vw12) | CC BY 4.0 (IEEE DataPort Open Access; uploads are CC BY under the DataPort Terms of Servic | B | 349.9 MB | yes |
| `ieee-flame2-sfm` | LAZ 1.2 (Agisoft Metashape) + JPEG (Point cloud WGS84 (EPSG:4326), ortho ~7.6 cm/pixel) | [IEEE DataPort (Open Access)](https://doi.org/10.21227/swyw-6j78) | CC BY 4.0 (IEEE DataPort Open Access; uploads are CC BY under the DataPort Terms of Servic | B | 118.9 MB | yes |

## live

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `live-gibs-wmts-4326` | WMTS (wmts) | [NASA EOSDIS GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | No restrictions on use (NASA EOSDIS data policy); attribution requested | A | 0 kB | service |
| `live-gibs-wmts-3857` | WMTS (wmts) | [NASA EOSDIS GIBS](https://nasa-gibs.github.io/gibs-api-docs/) | No restrictions on use; attribution requested | A | 0 kB | service |
| `live-tnm-usgstopo-wms` | WMS (wms) | [USGS The National Map](https://basemap.nationalmap.gov/) | Public domain | A | 0 kB | service |
| `live-tnm-usgstopo-rest` | ArcGIS REST MapServer (arcgis-rest) | [USGS The National Map](https://basemap.nationalmap.gov/arcgis/rest/services) | Public domain | A | 0 kB | service |
| `live-osm-tiles` | XYZ (xyz) | [OpenStreetMap Foundation](https://operations.osmfoundation.org/policies/tiles/) | ODbL 1.0 data; attribution required; subject to the OSMF Tile Usage Policy | A | 0 kB | service |
| `live-esri-sampleserver6-wildfire` | ArcGIS FeatureServer (featureservice) | [Esri](https://sampleserver6.arcgisonline.com/arcgis/rest/services) | Esri sample/demo service (Esri Terms of Use); data reset periodically | A | 0 kB | service |
| `live-wfst-geosolutions-gs-stable` | WFS-T (wfs-t) | [GeoSolutions](https://gs-stable.geo-solutions.it/geoserver/web/) | Demo server (no SLA); layer data under each source's licence | A | 0 kB | service |
| `live-ngs-ncat` | REST/JSON (ncat) | [NOAA National Geodetic Survey](https://geodesy.noaa.gov/web_services/ncat/) | Public domain (US Government) | A | 0 kB | service |
| `live-ngs-geoid` | REST/JSON (geoid) | [NOAA National Geodetic Survey](https://geodesy.noaa.gov/web_services/geoid.shtml) | Public domain (US Government) | A | 0 kB | service |
| `live-copc-autzen-https` | COPC (copc-http) | [Hobu Inc.](https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz) | See lidar-autzen-classified-copc | A | 0 kB | service |
| `live-ept-usgs-3dep-drcog` | EPT | [USGS 3DEP via AWS Open Data (usgs-lidar-public)](https://s3-us-west-2.amazonaws.com/usgs-lidar-public/CO_DRCOG_1_2020/ept.json) | Public domain (USGS) | A | 0 kB | no |

## naip

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `naip-ca-m3812157-sw-2022` | GeoTIFF/COG (0.6 m, 4-band RGB+NIR 8-bit, UTM 10N, acquired 2022-05-19) | [USDA Farm Service Agency, via Microsoft Planetary Computer (naip)](https://planetarycomputer.microsoft.com/dataset/naip) | Public domain (USDA FSA NAIP imagery; https://www.fsa.usda.gov/programs-and-services/aeria | A | 386.6 MB | yes |

## nitf

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-nitf-gdal-autotest-small` | NITF2.1/NSIF | [https://github.com/OSGeo/gdal/tree/master/autotest/gdrivers/data/nitf](https://github.com/OSGeo/gdal/tree/master/autotest/gdrivers/data/nitf) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 18 kB | yes |
| `rs-nitf-gdal-rset` | NITF R-set | [https://github.com/OSGeo/gdal/tree/master/autotest/gdrivers/data/nitf](https://github.com/OSGeo/gdal/tree/master/autotest/gdrivers/data/nitf) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 13 kB | yes |
| `rs-nitf-jitc-bitdepth` | NITF2.x | [https://download.osgeo.org/gdal/data/nitf/](https://download.osgeo.org/gdal/data/nitf/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 3.8 MB | yes |
| `rs-nitf-jitc-imode-bprs` | NITF2.x | [https://download.osgeo.org/gdal/data/nitf/](https://download.osgeo.org/gdal/data/nitf/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 3.7 MB | yes |
| `rs-nitf-jitc-jpeg-c3` | NITF C3 | [https://download.osgeo.org/gdal/data/nitf/nitf2.0/](https://download.osgeo.org/gdal/data/nitf/nitf2.0/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 1.5 MB | yes |
| `rs-nitf-jitc-masked-nm` | NITF NM | [https://download.osgeo.org/gdal/data/nitf/nitf2.1/](https://download.osgeo.org/gdal/data/nitf/nitf2.1/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 2.0 MB | yes |
| `rs-nitf-jitc-multiseg-graphics` | NITF multi-segment + CGM | [https://download.osgeo.org/gdal/data/nitf/](https://download.osgeo.org/gdal/data/nitf/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 3.5 MB | yes |
| `rs-nitf-jitc-vq-cadrg` | NITF C4 VQ | [https://download.osgeo.org/gdal/data/nitf/nitf2.0/](https://download.osgeo.org/gdal/data/nitf/nitf2.0/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 294 kB | yes |
| `rs-nitf-ntb-j2k-p0_01` | NITF C8 | [https://download.osgeo.org/gdal/data/nitf/jpeg2000/](https://download.osgeo.org/gdal/data/nitf/jpeg2000/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 12 kB | yes |
| `rs-nsif-jitc` | NSIF1.0 | [https://download.osgeo.org/gdal/data/nitf/](https://download.osgeo.org/gdal/data/nitf/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 1.1 MB | yes |
| `nitf-ntb-nitf20-conformance` | NITF2.0 (Mixed: uncompressed mono/RGB/multiband, LUT, C3/M3 JPEG, VQ (C4), bi-level C1, CGM/text segments, TREs, multi-image) | [OSGeo / GDAL (mirror of NITFS Technical Board test suite)](https://download.osgeo.org/gdal/data/nitf/nitf2.0/) | GDAL sample-data server: 'public and freely redistributable geodata' (https://download.osg | A | 20.1 MB | yes |
| `nitf-ntb-nitf11-legacy` | NITF1.1 (Legacy NITF 1.1 headers; uncompressed and compressed images, symbols/labels) | [OSGeo / GDAL (mirror of NITFS Technical Board test suite)](https://download.osgeo.org/gdal/data/nitf/nitf1.1/) | GDAL sample-data server: 'public and freely redistributable geodata' (https://download.osg | A | 1.4 MB | yes |
| `nitf-ntb-nitf21-conformance` | NITF2.1 + BMP truth (v_3001a (1024x1024 mono), v_3303a (large multi-image); *r.bmp = expected rendering) | [OSGeo / GDAL (mirror of NITFS Technical Board test suite)](https://download.osgeo.org/gdal/data/nitf/nitf2.1/) | GDAL sample-data server: 'public and freely redistributable geodata' (https://download.osg | A | 6.9 MB | yes |
| `nitf-misc-gdal-server` | NITF2.1 (u_3054a: 13 MB multi-segment; bug3337: GDAL bug #3337 repro; p0_01syntax.txt describes p0_01a.ntf (J2K codestream conformance)) | [OSGeo / GDAL](https://download.osgeo.org/gdal/data/nitf/) | GDAL sample-data server: 'public and freely redistributable geodata' (https://download.osg | A | 13.9 MB | yes |
| `nitf-rpf-cadrg-frames` | RPF (CADRG) / NITF-wrapped frames (CADRG ONC 1:1M frame (.on1), GNC frame (.GN3), RPF overview (.ovr), A.TOC + RPFTOC01.ON2 frame, testtest.on9) | [OSGeo / GDAL (download server + autotest)](https://download.osgeo.org/gdal/data/nitf/cadrg/) | GDAL sample-data server: 'public and freely redistributable geodata' (https://download.osg | A | 591 kB | yes |
| `nitf-rpf-cib-usgs` | RPF CIB (expected) / GeoTIFF (10 m panchromatic orthoimage, 1986-1993, partial coverage) | [USGS EROS](https://www.usgs.gov/centers/eros/science/usgs-eros-archive-commercial-satellites-spot-controlled-image-base-10-meter) | USGS EROS archive, public access (free EarthExplorer login required) | B | 0 kB | no |

## raster

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-gpkg-gdal-raster-tiles` | GeoPackage tiles | [https://download.osgeo.org/gdal/data/geopackage/](https://download.osgeo.org/gdal/data/geopackage/) | GDAL sample/test data. The GDAL project states that its download-server sample data and au | RS | 130 kB | yes |

## robustness

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `robustness-gdal-autotest-seeds` | NITF / NSIF / DTED / GeoTIFF / BigTIFF (truncated, out-of-bounds TRE, invalid UDID, OSS-Fuzz repro, SICD, bad CRC, inverted coords, partial/sparse DTED columns, corrupted deflate/zstd/LZW, huge strip counts, bad tile offsets) | [OSGeo / GDAL autotest (GitHub)](https://github.com/OSGeo/gdal/tree/master/autotest) | GDAL repository licence MIT/X (https://github.com/OSGeo/gdal/blob/master/LICENSE.TXT); tes | A | 166 kB | yes |

## sar

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-sicd-sidd-xml-iceye` | SICD/SIDD XML | [https://iceye-open-data-catalog.s3.us-west-2.amazonaws.com/data/spot-fine/ICEYE_U09WX2_20251028T000519Z_6785560_X56_SLF/](https://iceye-open-data-catalog.s3.us-west-2.amazonaws.com/data/spot-fine/ICEYE_U09WX2_20251028T000519Z_6785560_X56_SLF/) | CC BY 4.0 (ICEYE Open Data, AWS Registry "iceye-opendata"). | RS | 18 kB | yes |
| `rs-sicd-umbra-chip` | SICD1.3/NITF2.1 | [https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/sar-data/tasks/ship_detection_testdata/ccd1026c-96c5-481b-a89f-54bcc096ad9b/2023-01-18-07-24-10_UMBRA-04/2023-01-18-07-24-10_UMBRA-04_SICD.nitf](https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/sar-data/tasks/ship_detection_testdata/ccd1026c-96c5-481b-a89f-54bcc096ad9b/2023-01-18-07-24-10_UMBRA-04/2023-01-18-07-24-10_UMBRA-04_SICD.nitf) | CC BY 4.0 (Umbra Open Data, https://umbra.space/open-license; AWS Registry of Open Data "u | RS | 8.4 MB | yes |
| `rs-sidd-umbra` | SIDD/NITF2.1 | [https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/](https://umbra-open-data-catalog.s3.us-west-2.amazonaws.com/) | CC BY 4.0 (Umbra Open Data, https://umbra.space/open-license). | RS | 6.6 MB | yes |
| `umbra-bingham-20230925-full` | SICD1.2.1/NITF2.1 \| SIDD2.0.0/NITF2.1 \| GeoTIFF (GEC) \| CPHD1.1.0 (UMB-SPOTLIGHT-50-1, X-band VV, UMBRA-05, descending, left-looking, az -32.1 deg, inc 40.0 deg, squint 135.5; scene centre -112.1461, 40.5224) | [Umbra Space](https://registry.opendata.aws/umbra-open-data/) | CC BY 4.0 (https://umbra.space/open-license) | A | 2.59 GB | yes |
| `umbra-bingham-20230821-repeat` | SICD1.2.1/NITF2.1 \| SIDD2.0.0/NITF2.1 \| GeoTIFF (GEC) (UMB-SPOTLIGHT-50-1, X-band VV, same satellite UMBRA-05, descending, left, az -32.1 deg, inc 40.7 deg, squint 135.5; matches 2023-09-25 within 0.7 deg incidence, 35-day baseline) | [Umbra Space](https://registry.opendata.aws/umbra-open-data/) | CC BY 4.0 (https://umbra.space/open-license) | A | 1.02 GB | yes |
| `capella-c13-sm-20240924` | SICD1.3.0/NITF2.1 \| SIDD2.0.0/NITF2.1 \| GeoTIFF SLC + extended JSON \| GeoTIFF/COG GEO \| CPHD1.1.0 (Stripmap (SM), X-band VV, inc 13.3 deg, East African coast (~11 S, 40.7 E)) | [Capella Space](https://registry.opendata.aws/capella_opendata/) | CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) plus a Capella Open Data conditio | A | 578.6 MB | yes |
| `iceye-x50-slf-20251027-sidd3` | SIDD3.0.0/NITF2.1 \| SICD1.3.0 XML (Spotlight Fine (SLF), X-band, ICEYE-X50) | [ICEYE](https://registry.opendata.aws/iceye-opendata/) | CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/) | A | 400.0 MB | yes |
| `sar-osml-sicd-sidd-chips` | SICD 1.2.1/1.3.0 and SIDD 2.0 in NITF 2.1 (single-pol chips (not quad-pol)) | [GitHub awslabs/osml-imagery-toolkit @cbe3e77 (Git LFS)](https://github.com/awslabs/osml-imagery-toolkit/tree/main/test/data) | Apache-2.0 (repository LICENSE) | A | 8.9 MB | yes |

## sentinel2

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `s2-l2a-cog-10seh-20240816` | GeoTIFF/COG (L2A BOA reflectance uint16, baseline N05.11 (offset -1000), B01-B12 (no B10), SCL, AOT; 10/20/60 m; cloud 0.003%) | [ESA Copernicus, processed/hosted by Element 84 Earth Search (AWS sentinel-cogs)](https://registry.opendata.aws/sentinel-2-l2a-cogs/) | Copernicus Sentinel data terms: free, full and open access (https://sentinels.copernicus.e | A | 1.30 GB | yes |
| `s2-l1c-jp2-safe-10seh-20240816` | JPEG2000 (SAFE) (L1C TOA reflectance, 13 bands B01-B12 incl. B10 cirrus, native .jp2 (OpenJPEG/Kakadu-encoded, 15-bit), TCI.jp2 8-bit RGB, MTD_MSIL1C.xml, MTD_TL.xml, MTD_DS.xml (20 MB datastrip incl. detector/geometry info), QI masks as JP2) | [ESA Copernicus, via Google Cloud Public Datasets (gcp-public-data-sentinel-2)](https://cloud.google.com/storage/docs/public-datasets/sentinel-2) | Copernicus Sentinel data terms: free, full and open access (https://sentinels.copernicus.e | A | 859.8 MB | yes |

## vector

| Id | Format | Source | Licence | Tier | Size | On disk |
|---|---|---|---|---|---|---|
| `rs-kml-iceye-footprint` | KML | [https://iceye-open-data-catalog.s3.us-west-2.amazonaws.com/](https://iceye-open-data-catalog.s3.us-west-2.amazonaws.com/) | CC BY 4.0 (ICEYE Open Data). | RS | 2 kB | yes |
| `rs-vector-fx12-synthetic` | GeoJSON/GPKG/KML/KMZ/SHP (synthetic) | [synthetic](synthetic) | Synthetic test data created by WS14; no third-party content. Free to use. | RS | 232 kB | yes |
| `rs-vector-naturalearth-110m` | Shapefile | [https://www.naturalearthdata.com/downloads/110m-cultural-vectors/](https://www.naturalearthdata.com/downloads/110m-cultural-vectors/) | Public domain (Natural Earth terms of use). | RS | 215 kB | yes |
| `vector-natural-earth-10m-shp` | Shapefile (zip) (EPSG:4326; admin-0 countries, populated places, roads, rivers+lake centerlines, lakes) | [Natural Earth (NACIS)](https://www.naturalearthdata.com/downloads/10m-cultural-vectors/) | Public domain | A | 21.2 MB | yes |
| `vector-natural-earth-gpkg` | GeoPackage (zip) (All NE vector layers (10m/50m/110m) in one GPKG (more than 100 tables)) | [Natural Earth (NACIS)](https://www.naturalearthdata.com/downloads/) | Public domain | A | 1.33 GB | yes |
| `vector-tiger-2024-colorado` | Shapefile (zip) (EPSG:4269 (NAD83); counties Adams, Arapahoe, Boulder, Broomfield, Denver, Douglas, El Paso, Jefferson, Larimer, Weld) | [US Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html) | Public domain (US Government work) | A | 123.5 MB | yes |
| `vector-nhd-hu4-1019-gpkg` | GeoPackage (zip) (NHD HR feature classes (flowlines with Z/M, waterbodies, areas, WBD HUC polygons) in one GPKG) | [USGS National Hydrography Dataset](https://www.usgs.gov/national-hydrography/access-national-hydrography-products) | Public domain (US Government work) | A | 682.6 MB | yes |
| `vector-geofabrik-osm-colorado` | Shapefile (zip) + GeoPackage (zip) (Geofabrik 'free' layer schema (roads, buildings, landuse, water, pois, places, railways...), EPSG:4326) | [Geofabrik GmbH / OpenStreetMap](https://download.geofabrik.de/north-america/us/colorado.html) | ODbL 1.0 | A | 2.88 GB | yes |
| `vector-geofabrik-osm-dc` | Shapefile (zip) + GeoPackage (zip) (Same content in both encodings, for format parity tests) | [Geofabrik GmbH / OpenStreetMap](https://download.geofabrik.de/north-america/us/district-of-columbia.html) | ODbL 1.0 | A | 139.0 MB | yes |
| `vector-geopackage-conformance-set` | GeoPackage (GPKG 1.0/1.1/1.2 samples; features, tiles, 2D gridded coverage (elevation PNG/TIFF), related tables (RTE), styles/portrayal, domains, 3D envelopes, non-conformant/corrupt negatives) | [OGC / NGA / OSGeo GDAL](https://www.geopackage.org/) | OGC samples: OGC repo licence (GitHub shows NOASSERTION; OGC document/software notice); NG | A | 25.4 MB | yes |
| `vector-kml-google-samples` | KML (KML 2.2: placemarks, styles, ground overlays, screen overlays, paths, polygons, extruded geometry, NetworkLinks) | [Google Developers](https://developers.google.com/kml/documentation/kml_tut) | CC BY 4.0 (Google Developers content); code samples Apache-2.0 | A | 36 kB | yes |
| `vector-kml-kmz-test-set` | KML / KMZ (gx: extensions (Track, MultiTrack, altitude modes), time/TimeSpan, ExtendedData+Schema, KMZ with relative images/models, corrupt KMZ negatives) | [Google libkml / OGC ets-kml22 / GDAL](https://github.com/google/libkml) | libkml: BSD-3-Clause (repo LICENSE; GitHub shows NOASSERTION); OGC ets-kml22: see repo LIC | A | 1.5 MB | yes |
| `vector-ogc-kml23-schema` | XSD (KML 2.3 schema) | [OGC](https://schemas.opengis.net/kml/2.3/) | OGC Software/Document Notice (free use) | A | 97 kB | yes |
| `vector-gpx-csv-wkt-gdal` | GPX / CSV (WKT) (GPX 1.1 waypoints/routes/tracks + time extension; CSV with WKT polygon column; CSV with curved WKT (CIRCULARSTRING/COMPOUNDCURVE); CSVT type sidecar) | [OSGeo GDAL](https://github.com/OSGeo/gdal/tree/master/autotest/ogr/data) | MIT | A | 19 kB | yes |

