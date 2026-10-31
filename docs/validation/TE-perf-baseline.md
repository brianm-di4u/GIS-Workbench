# Performance baseline: rel-perf (chrome)

From `tests/campaign/c55-perf.spec.js` on 2026-10-31: the largest and the median file of each census format key, on this machine (Intel Arc, Chrome). Budgets: first tile ≤ 1 s (REQ-PRF-03), roaming ≥ 50 fps and frame ≤ 16.7 ms (REQ-PRF-02), read-out < 16.7 ms (REQ-PRF-04), GPU within budget (REQ-PRF-08), heap growth ≤ 64 MB after ten opens, point clouds over 5 M points ≥ 30 fps (REQ-PRF-05).

- Files measured: 277; over a budget: 39, all on first tile. Roaming, frame time, read-out, GPU memory and heap growth are within budget on every file.
- Build: the 2.0.4 release `dist/gis-workbench.html` (WASM optimised by binaryen wasm-opt), on an idle machine with one worker.
- Storage: the corpus is read from the USB disk behind the `TE-corpus` junction (about 24 MB/s), so first-tile times for large files include that disk. The first-display figures in the CHANGELOG's 2.0.4 Known limits were measured from a local SSD (TE-cross-findings, NVMe rounds).

## Over budget

| File | MB | Over |
|---|---|---|
| emit-l1b-rad-cuprite/EMIT_L1B_RAD_001_20240727T213005_2420914_007.nc | 1854 | first tile 15358 ms |
| emit-l2a-rfl-cuprite/EMIT_L2A_RFL_001_20240727T213005_2420914_007.nc | 1852 | first tile 16007 ms |
| field-dg-spratly-zip/Spratly Islands.zip | 1597 | first tile 1639 ms |
| sar-umbra-stack-silver-peak/2025-07-04-05-04-32_UMBRA-05/2025-07-04-05-04-32_UMBRA-05_SICD.nitf | 1527 | first tile 13430 ms |
| eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29/nadir29_315300_PAN/09DEC22163522-P1BS-058332847010_01_P003.TIF | 1214 | first tile 3099 ms |
| nitf-mvs-wv3-buenos-aires/PAN/19DEC15WV031000015DEC19142039-P1BS-500514410020_01_P001_________AAE_0AAAAABPABW0.NTF | 1032 | first tile 2017 ms |
| umbra-bingham-20230925-full/umbra_20230925_SICD.nitf | 953 | first tile 10263 ms |
| nitf-core3d-jacksonville-wv3/PAN/21JAN15WV031100015JAN21161243-P1BS-500648061050_01_P001_________AAE_0AAAAABPABS0.NTF | 848 | first tile 1766 ms |
| nitf-mvs-wv3-buenos-aires/PAN/18DEC15WV031000015DEC18140533-P1BS-500515572050_01_P001_________AAE_0AAAAABPABJ0.NTF | 751 | first tile 1422 ms |
| nitf-core3d-jacksonville-wv3/PAN/21JAN15WV031100015JAN21161308-P1BS-501504474040_01_P001_________AAE_0AAAAABPABJ0.NTF | 713 | first tile 1454 ms |
| nitf-core3d-jacksonville-wv3/MSI/21JAN15WV031100015JAN21161243-M1BS-500648061050_01_P001_________GA_E0AAAAAAKAAL0.NTF | 652 | first tile 1604 ms |
| ieee-dfc2018-houston/FullHSIDataset/20170218_UH_CASI_S4_NAD83.pix | 501 | first tile 9001 ms |
| sar-capella-c10-sp-20240329/capella_C10_SP_SICD.ntf | 464 | first tile 8853 ms |
| iceye-x50-slf-20251027-sidd3/iceye_X50_SIDD_GRD_SLF.nitf | 400 | first tile 9135 ms |
| field-phr-dimap-zip/APMQ7332_SO18018059-2-01_DS_PHR1B_201804210157279_FR1_PX_E131N43_1205_04070.zip | 388 | first tile 3585 ms |
| sar-capella-c10-sp-20240329/capella_C10_SP_SIDD.ntf | 257 | first tile 9122 ms |
| sar-sandia-farad-quadpol-2pass/sicd_example_1_PFA_RE32F_IM32F_VV.nitf | 206 | first tile 2397 ms |
| sar-sandia-farad-quadpol-2pass/sicd_example_2_PFA_RE32F_IM32F_VH.nitf | 205 | first tile 2316 ms |
| sar-capella-c10-sp-20240329/capella_C10_SP_SLC.tif | 159 | first tile 5176 ms |
| s2-l1c-jp2-safe-10seh-20240816/S2B_MSIL1C_20240816T184919_N0511_R113_T10SEH_20240816T222835.SAFE/GRANULE/L1C_T10SEH_A038892_20240816T185441/IMG_DATA/T10SEH_20240816T184919_B08.jp2 | 133 | first tile 1356 ms |
| nitf-rpf-cib-usgs/n20e102.tif | 114 | first tile 1507 ms |
| field-dg-panama/Panama_01_R1C1.tif | 103 | first tile 2408 ms |
| eo-spacenet-atlanta-wv2-l1b-rpc/nadir52_BDDC00_MUL/09DEC22163912-M1BS-058332896010_01_P005.TIF | 85 | first tile 2043 ms |
| derived-gtiff-variants/landsat_b4_bigtiff_bigendian.tif | 64 | first tile 2153 ms |
| derived-sar-sicd14-sidd30/umbra_bingham_sidd_sidd30.nitf | 63 | first tile 2737 ms |
| sar-sicd-nitro-amp8i-phs8i/sicd_example_1_PFA_AMP8I_PHS8I_VV_with_amplitude_table_SICD.nitf | 53 | first tile 2661 ms |
| capella-c13-sm-20240924/capella_C13_SM_SIDD.ntf | 45 | first tile 2233 ms |
| geopdf-ustopo-vinehill-honkerbay-current/CA_Honker_Bay_20220107_TM_geo.pdf | 34 | first tile 6236 ms |
| field-dg-spratly-subi-reef-20150424/Subi_Reef_20150424_R1C2.tif | 27 | first tile 2171 ms |
| geopdf-ustopo-bouldin-island-current/CA_Bouldin_Island_20211230_TM_geo.pdf | 26 | first tile 5487 ms |
| geopdf-htmc-honker-bay-bouldin-island/CA_Honker_Bay_100766_1953_24000_geo.pdf | 17 | first tile 4552 ms |
| derived-gtiff-variants/naip_bigendian_striped.tif | 17 | first tile 1695 ms |
| geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf | 14 | first tile 4382 ms |
| frames-odm-aukerman/images/DSC00269.JPG | 9 | first tile 1300 ms |
| field-dg-spratly-subi-reef-20150317/Subi_Reef_20150317_R1C2.tif | 8 | first tile 1948 ms |
| field-dg-spratly-mischief-reef-20150610/Mischief_Reef_20150610_R2C2.tif | 8 | first tile 2035 ms |
| nitf-ntb-nitf20-conformance/U_4020f.ntf | 8 | first tile 1688 ms |
| vector-geopackage-conformance-set/nga/tiles.gpkg | 5 | first tile 1079 ms |
| frames-odm-copr-gcp/images/IMG_0106.jpg | 4 | first tile 1074 ms |

## All files

| File | MB | Open s | First tile ms | Stats ms | fps | Frame ms | Read-out ms | GPU MB | Heap +MB |
|---|---|---|---|---|---|---|---|---|---|
| perf-large-lroc-nac-south-pole-cog/NAC_SPOLE_mosaic_1m_cog.tif | 42596 | 0.4 | 191 | 0 | 60 | 0.8 |  | 6 |  |
| emit-l1b-rad-cuprite/EMIT_L1B_RAD_001_20240727T213005_2420914_007.nc | 1854 | 15.6 | 15358 | 0 | 59.9 | 0.9 | 0.3 | 25 |  |
| emit-l2a-rfl-cuprite/EMIT_L2A_RFL_001_20240727T213005_2420914_007.nc | 1852 | 16.5 | 16007 | 0 | 59.6 | 1 | 0.3 | 25 |  |
| field-dg-spratly-zip/Spratly Islands.zip | 1597 | 6.4 | 1639 | 0 | 60.1 | 1.9 | 0.3 | 28 |  |
| sar-umbra-stack-silver-peak/2025-07-04-05-04-32_UMBRA-05/2025-07-04-05-04-32_UMBRA-05_SICD.nitf | 1527 | 17.7 | 13430 | 0 | 60 | 0.7 | 0.3 | 4 |  |
| eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29/nadir29_315300_PAN/09DEC22163522-P1BS-058332847010_01_P003.TIF | 1214 | 6.2 | 3099 | 0 | 60 | 0.9 | 0.3 | 2 |  |
| nitf-mvs-wv3-buenos-aires/PAN/19DEC15WV031000015DEC19142039-P1BS-500514410020_01_P001_________AAE_0AAAAABPABW0.NTF | 1032 | 2.1 | 2017 | 0 | 60 | 0.8 | 0.3 | 14 |  |
| umbra-bingham-20230925-full/umbra_20230925_SICD.nitf | 953 | 12.8 | 10263 | 0 | 59.9 | 0.8 | 0.3 | 2 |  |
| nitf-core3d-jacksonville-wv3/PAN/21JAN15WV031100015JAN21161243-P1BS-500648061050_01_P001_________AAE_0AAAAABPABS0.NTF | 848 | 1.9 | 1766 | 0 | 59.9 | 0.8 | 0.4 | 15 |  |
| nitf-mvs-wv3-buenos-aires/PAN/18DEC15WV031000015DEC18140533-P1BS-500515572050_01_P001_________AAE_0AAAAABPABJ0.NTF | 751 | 1.7 | 1422 | 0 | 59.6 | 1.1 | 0.5 | 15 |  |
| nitf-core3d-jacksonville-wv3/PAN/21JAN15WV031100015JAN21161308-P1BS-501504474040_01_P001_________AAE_0AAAAABPABJ0.NTF | 713 | 1.6 | 1454 | 0 | 60 | 1 | 0.5 | 15 |  |
| nitf-core3d-jacksonville-wv3/MSI/21JAN15WV031100015JAN21161243-M1BS-500648061050_01_P001_________GA_E0AAAAAAKAAL0.NTF | 652 | 2.1 | 1604 | 0 | 59.8 | 0.8 | 0.4 | 4 |  |
| nitf-core3d-jacksonville-wv3/MSI/21JAN15WV031100015JAN21161253-M1BS-500648062050_01_P001_________GA_E0AAAAAAKAAK0.NTF | 636 | 1.4 | 922 | 0 | 59.9 | 0.8 | 0.4 | 4 |  |
| ieee-dfc2018-houston/FullHSIDataset/20170218_UH_CASI_S4_NAD83.pix | 501 | 9.7 | 9001 | 0 | 60 | 0.7 | 0.2 | 3 |  |
| vector-nhd-hu4-1019-gpkg/NHD_H_1019_HU4_GPKG.gpkg | 500 | 19.3 |  |  |  |  |  |  |  |
| dem-under-california-3dep13/USGS_13_n38w122_20250826.tif | 500 | 0.3 | 297 | 0 | 60 | 1 | 0.3 | 34 |  |
| sar-capella-c10-sp-20240329/capella_C10_SP_SICD.ntf | 464 | 11.6 | 8853 | 0 | 59.9 | 0.8 | 0.3 | 2 |  |
| ieee-dfc2018-houston/C123/272652_3289689.las | 438 | 19.6 |  |  | 59.3 (3D) |  |  |  |  |
| derived-pmtiles-raster/s2tci_png.pmtiles | 408 | 0.0 |  |  |  |  |  |  |  |
| iceye-x50-slf-20251027-sidd3/iceye_X50_SIDD_GRD_SLF.nitf | 400 | 14.9 | 9135 | 0 | 60 | 0.7 | 0.3 | 2 |  |
| field-phr-dimap-zip/APMQ7332_SO18018059-2-01_DS_PHR1B_201804210157279_FR1_PX_E131N43_1205_04070.zip | 388 | 4.3 | 3585 | 0 | 59.9 | 0.9 | 0.3 | 30 | 1 |
| lidar-3dep-co-drcog-2020-2x2/USGS_LPC_CO_DRCOG_2020_B20_w0474n4417.laz | 291 | 23.7 |  |  | 58.2 (3D) |  |  |  | 25 |
| dem-under-vegas-3dep/USGS_1M_11_x65y402_NV_Las_Vegas_Region_2016_A16.tif | 273 | 0.9 | 286 | 0 | 59.9 | 1 | 0.3 | 32 | 1 |
| sar-capella-c10-sp-20240329/capella_C10_SP_SIDD.ntf | 257 | 11.6 | 9122 | 0 | 59.7 | 0.7 | 0.3 | 1 | 1 |
| sar-sandia-farad-quadpol-2pass/sicd_example_1_PFA_RE32F_IM32F_VV.nitf | 206 | 3.7 | 2397 | 0 | 59.7 | 0.8 | 0.3 | 2 | 1 |
| sar-sandia-farad-quadpol-2pass/sicd_example_2_PFA_RE32F_IM32F_VH.nitf | 205 | 3.7 | 2316 | 0 | 60 | 0.9 | 0.3 | 2 | 1 |
| fmv-bambi-flights/derived/flight_258/DJI_20241021165448_0001_V_point0.ts | 183 | 1.9 |  |  |  |  |  |  | 1 |
| fmv-ffmpeg-night-flight-ir/Night Flight IR.mpg | 170 | 1.9 |  |  |  |  |  |  | 1 |
| sar-capella-c10-sp-20240329/capella_C10_SP_SLC.tif | 159 | 7.2 | 5176 | 0 | 59.7 | 0.9 | 0.2 | 13 | 1 |
| s2-l1c-jp2-safe-10seh-20240816/S2B_MSIL1C_20240816T184919_N0511_R113_T10SEH_20240816T222835.SAFE/GRANULE/L1C_T10SEH_A038892_20240816T185441/IMG_DATA/T10SEH_20240816T184919_B08.jp2 | 133 | 1.4 | 1356 | 0 | 60 | 1.1 | 0.3 | 17 | 1 |
| derived-fmv-variants/truck_mpeg2_klv.ts | 118 | 1.2 |  |  |  |  |  |  | 2 |
| nitf-rpf-cib-usgs/n20e102.tif | 114 | 1.6 | 1507 | 0 | 59.8 | 0.7 | 0.2 | 1 | 1 |
| ieee-flame2-sfm/RGB_Pointcloud.laz | 113 | 6.8 |  |  | 59.2 (3D) |  |  |  | 8 |
| derived-vmti-video/truck_vmti.ts | 103 | 1.4 |  |  |  |  |  |  | 1 |
| field-dg-panama/Panama_01_R1C1.tif | 103 | 4.4 | 2408 | 0 | 60 | 0.8 | 0.2 | 7 | 1 |
| landsat8-c2-l1tp-044034-20240820-tierb/LC08_L1TP_044034_20240820_20240830_02_T1_B6.TIF | 90 | 0.3 | 159 | 0 | 60 | 1.1 | 0.3 | 10 | 1 |
| landsat8-c2-l2sp-044034-20240820/LC08_L2SP_044034_20240820_20240830_02_T1_SR_B5.TIF | 87 | 0.3 | 190 | 0 | 59.9 | 1 | 0.3 | 10 | 1 |
| eo-spacenet-atlanta-wv2-l1b-rpc/nadir52_BDDC00_MUL/09DEC22163912-M1BS-058332896010_01_P005.TIF | 85 | 2.1 | 2043 | 0 | 60 | 1 | 0.4 | 2 | 1 |
| lidar-autzen-classified-copc/autzen-classified.copc.laz | 81 | 5.4 |  |  | 57.6 (3D) |  |  |  | 10 |
| derived-gtiff-variants/landsat_b4_bigtiff_bigendian.tif | 64 | 2.1 | 2153 | 0 | 59.7 | 1 | 0.3 | 10 | 1 |
| derived-sar-sicd14-sidd30/umbra_bingham_sidd_sidd30.nitf | 63 | 2.9 | 2737 | 0 | 60 | 0.9 | 0.4 | 5 | 1 |
| sar-sicd-nitro-amp8i-phs8i/sicd_example_1_PFA_AMP8I_PHS8I_VV_with_amplitude_table_SICD.nitf | 53 | 2.9 | 2661 | 0 | 59.9 | 1 | 0.5 | 27 | 2 |
| derived-fmv-variants/dayflight_mpeg2_klv.ts | 52 | 0.6 |  |  |  |  |  |  | 1 |
| derived-sar-sicd14-sidd30/capella_c13_sm_sidd_sidd30.nitf | 45 | 1.1 | 849 | 0 | 60 | 1 | 0.5 | 15 | 1 |
| capella-c13-sm-20240924/capella_C13_SM_SIDD.ntf | 45 | 2.4 | 2233 | 0 | 59.8 | 0.9 | 0.4 | 15 | 1 |
| dem-under-california/Copernicus_DSM_COG_10_N37_00_W121_00_DEM.tif | 45 | 0.3 | 195 | 0 | 59.8 | 1 | 0.3 | 17 | 1 |
| derived-pmtiles-raster/s2tci_jpeg.pmtiles | 40 | 0.0 |  |  |  |  |  |  | 1 |
| lidar-las-version-matrix/laspy/fullwave.laz | 36 | 0.2 |  |  | 59.3 (3D) |  |  |  | 3 |
| geopdf-ustopo-vinehill-honkerbay-current/CA_Honker_Bay_20220107_TM_geo.pdf | 34 | 6.5 | 6236 | 0 | 59.9 | 1 | 0.2 | 15 | 1 |
| derived-las-pdrf-matrix/houston_c1_pdrf10_las14.las | 34 | 0.8 |  |  | 59.7 (3D) |  |  |  | 3 |
| derived-hsi-cube-geotiff/aviris_refl_chip.tif | 33 | 0.3 | 167 | 0 | 60 | 0.9 | 0.2 | 2 | 1 |
| lidar-3dep-co-denver-2008-2x1/USGS_LPC_CO_DENVER_2008_000060.laz | 33 | 4.3 |  |  | 59.8 (3D) |  |  |  | 7 |
| vector-geofabrik-osm-dc/district-of-columbia-latest-free.gpkg.zip | 32 | 8.7 |  |  |  |  |  |  | 2 |
| vector-geofabrik-osm-dc/district-of-columbia-latest-free.shp.zip | 32 | 7.2 |  |  |  |  |  |  | 3 |
| derived-las-pdrf-matrix/houston_c1_pdrf5_las13.las | 32 | 1.3 |  |  | 59.8 (3D) |  |  |  | 3 |
| sar-radarsat2-quadpol-slc-samples/RS2_OK153952_PK1408403_DK1372522_SQ1_20231119_053723_HH_VV_HV_VH_SLC/imagery_HV.tif | 31 | 0.8 | 829 | 0 | 60 | 1 | 0.3 | 4 | 1 |
| derived-sar-complex-slc/umbra_slc_cfloat32.tif | 31 | 0.8 | 390 | 0 | 59.7 | 1 | 0.3 | 22 | 1 |
| lidar-3dep-co-soplatte-2013-2x2/USGS_LPC_South_Platte_River_Flood_LiDAR_13SDE474416.laz | 31 | 3.1 |  |  | 59.6 (3D) |  |  |  | 7 |
| derived-las-pdrf-matrix/houston_c1_pdrf9_las14.las | 30 | 0.7 |  |  | 60 (3D) |  |  |  | 3 |
| derived-las-pdrf-matrix/houston_c1_pdrf4_las13.las | 29 | 0.9 |  |  | 59.3 (3D) |  |  |  | 3 |
| field-dg-spratly-subi-reef-20150424/Subi_Reef_20150424_R1C2.tif | 27 | 4.1 | 2171 | 0 | 59.9 | 0.8 | 0.2 | 10 | 1 |
| derived-dted-level2/srtm-skadi/w106/n40.dt2 | 26 | 1.0 | 710 | 0 | 60 | 1 | 0.2 | 17 | 1 |
| usgs-srtm-dted2-n39w106/n39_w106_1arc_v3.dt2 | 26 | 0.8 | 714 | 0 | 59.6 | 1 | 0.3 | 17 | 1 |
| derived-hgt-variants/N40W106.hgt | 26 | 1.0 | 672 | 0 | 59.9 | 1 | 0.2 | 17 | 1 |
| derived-hgt-variants/srtm1-3601/N39W106.hgt | 26 | 0.8 | 462 | 0 | 59.9 | 1 | 0.3 | 17 | 1 |
| geopdf-ustopo-bouldin-island-current/CA_Bouldin_Island_20211230_TM_geo.pdf | 26 | 5.8 | 5487 | 0 | 59.6 | 0.9 | 0.2 | 15 | 1 |
| derived-app-artifacts/ai-1.30.0+slimsam77.webgpu.gwpack | 25 | 0.6 |  |  |  |  |  |  | 1 |
| derived-pmtiles-raster/s2tci_webp.pmtiles | 25 | 0.0 |  |  |  |  |  |  | 1 |
| derived-hsi-cube-geotiff/dfc2018_casi_chip.tif | 20 | 0.3 | 195 | 0 | 60 | 1 | 0.3 | 2 | 1 |
| derived-las-pdrf-matrix/houston_c1_pdrf8_las14.las | 19 | 0.7 |  |  | 59.3 (3D) |  |  |  | 3 |
| geopdf-htmc-honker-bay-bouldin-island/CA_Honker_Bay_100766_1953_24000_geo.pdf | 17 | 4.9 | 4552 | 0 | 60 | 0.8 |  | 16 | 1 |
| derived-gtiff-variants/naip_bigendian_striped.tif | 17 | 2.7 | 1695 | 0 | 59.9 | 0.9 | 0.2 | 16 | 1 |
| derived-fmv-variants/truck_hevc_klv.ts | 17 | 0.4 |  |  |  |  |  |  | 1 |
| derived-envi-variants/landsat_sr_bip.img | 15 | 1.1 | 675 | 0 | 59.8 | 1.1 | 0.3 | 8 | 1 |
| geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf | 14 | 4.5 | 4382 | 0 | 59.9 | 1 | 0.2 | 16 | 1 |
| srtm-skadi-n39w106-n40w106/N39W106.hgt.gz | 14 | 0.8 | 571 | 0 | 59.9 | 1.1 | 0.2 | 17 | 1 |
| nitf-misc-gdal-server/u_3054a.ntf | 14 | 0.8 | 155 | 0 | 59.9 | 0.9 |  | 5 | 1 |
| srtm-skadi-n39w106-n40w106/N40W106.hgt.gz | 14 | 0.9 | 643 | 0 | 58.9 | 1 | 0.3 | 17 | 1 |
| derived-gtiff-variants/wv3vis_packbits.tif | 12 | 1.1 | 706 | 0 | 60 | 1 | 0.3 | 16 | 1 |
| ieee-dfc2019-track2-val/Track2/JAX_163_001_006_LEFT_MSI.tif | 12 | 0.8 | 547 | 0 | 59.9 | 0.8 |  | 0 | 1 |
| vector-csv-noaa-ibtracs-last3years/ibtracs.last3years.list.v04r01.csv | 12 | 1.6 |  |  |  |  |  |  | 1 |
| derived-mie4nitf-bambi/flight_258_thermal_mie4nitf.ntf | 11 | 1.2 | 305 | 0 | 59.9 | 1.6 | 0.2 | 14 | 1 |
| derived-sar-complex-slc/capella_slc_cfloat32.tif | 11 | 0.6 | 368 | 0 | 59.9 | 1 | 0.3 | 20 | 1 |
| derived-sar-complex-slc/capella_slc_cint32.tif | 11 | 0.6 | 360 | 0 | 59.9 | 1 | 0.2 | 20 | 1 |
| 3d-gltf-sample-assets/BoomBox/glTF/BoomBox.gltf | 11 | 0.1 |  |  |  |  |  |  | 3 |
| 3d-gltf-sample-assets/BoomBox/glTF-Binary/BoomBox.glb | 11 | 0.2 |  |  |  |  |  |  | 3 |
| derived-pc-ascii/houston_c1.pts | 10 | 1.2 |  |  | 59.7 (3D) |  |  |  | 2 |
| derived-sar-complex-slc/capella_slc_cint16.tif | 10 | 0.6 | 351 | 0 | 60 | 1 | 0.3 | 20 | 1 |
| derived-vector-variants/ne_places.fgb | 10 | 0.7 |  |  |  |  |  |  | 2 |
| frames-odm-aukerman/images/DSC00269.JPG | 9 | 1.7 | 1300 | 0 | 59.8 | 0.8 |  | 18 | 1 |
| derived-mie4nitf-bambi/flight_316_thermal_mie4nitf.ntf | 9 | 0.9 | 242 | 0 | 60 | 1.4 | 0.2 | 11 | 1 |
| derived-nitf-rsm/mvs_wv3_rsm_rpc00b.ntf | 8 | 0.3 | 242 | 0 | 59.9 | 1 | 0.4 | 11 | 1 |
| derived-nitf-rsm/core3d_jax_wv3_rsm.ntf | 8 | 0.6 | 285 | 0 | 59.8 | 1 | 0.3 | 11 | 1 |
| hsi-speclib-splib07b-envi-hyperspectralpy/splib07b_asdfr.sli | 8 | 0.2 |  |  |  |  |  |  | 1 |
| field-dg-spratly-subi-reef-20150317/Subi_Reef_20150317_R1C2.tif | 8 | 3.9 | 1948 | 0 | 60 | 0.8 | 0.2 | 10 | 1 |
| derived-gtiff-variants/wv3vis_lerc.tif | 8 | 1.1 | 847 | 0 | 59.7 | 1 | 0.2 | 16 | 1 |
| field-dg-spratly-mischief-reef-20150610/Mischief_Reef_20150610_R2C2.tif | 8 | 3.9 | 2035 | 0 | 59.9 | 0.8 | 0.2 | 10 | 1 |
| nitf-ntb-nitf20-conformance/U_4020f.ntf | 8 | 1.9 | 1688 | 0 | 60 | 0.8 |  | 8 | 1 |
| derived-gtiff-variants/wv3vis_zstd.tif | 7 | 0.8 | 581 | 0 | 60 | 0.8 | 0.3 | 16 | 1 |
| derived-vector-variants/ne_countries.parquet | 7 | 0.3 |  |  |  |  |  |  | 1 |
| vector-usgs-earthquakes-month/all_month.geojson | 7 | 0.2 |  |  |  |  |  |  | 1 |
| derived-las-pdrf-5-9/autzen_pdrf5_las13.las | 7 | 0.2 |  |  | 59.7 (3D) |  |  |  | 3 |
| derived-las-pdrf-matrix/autzen_pdrf5_las13.las | 7 | 0.2 |  |  | 59.7 (3D) |  |  |  | 3 |
| derived-las-pdrf-5-9/autzen_pdrf9_las14.las | 6 | 0.2 |  |  | 59.9 (3D) |  |  |  | 3 |
| vector-geopackage-conformance-set/nga/coverage_data_tiff.gpkg | 6 | 0.7 | 486 | 0 | 60 | 1 | 0.3 | 4 | 2 |
| derived-las-pdrf-matrix/autzen_pdrf4_las13.las | 6 | 0.2 |  |  | 60 (3D) |  |  |  | 3 |
| eo1-hyperion-l1t-043034-20170312/EO1H0430342017071110KF_B107_L1T.TIF | 6 | 0.6 | 264 | 0 | 59.7 | 0.9 | 0.3 | 5 | 1 |
| eo1-hyperion-l1t-043034-20170312/EO1H0430342017071110KF_B109_L1T.TIF | 6 | 0.6 | 261 | 0 | 59.8 | 1 | 0.3 | 5 | 1 |
| eo1-hyperion-l1t-043034-20170312/EO1H0430342017071110KF_B197_L1T.TIF | 6 | 0.3 | 248 | 0 | 59.8 | 1 | 0.2 | 5 | 1 |
| lidar-las-version-matrix/pdal/4_1.las | 6 | 0.3 |  |  | 59.3 (3D) |  |  |  | 3 |
| vector-geopackage-conformance-set/nga/tiles.gpkg | 5 | 1.4 | 1079 | 0 | 60 | 1 | 0.3 | 16 | 2 |
| derived-3d-tiles-3tz/TilesetWithDiscreteLOD.3tz | 5 | 0.1 |  |  |  |  |  |  | 3 |
| rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf | 5 | 0.3 | 191 | 0 | 59.9 | 0.9 | 0.5 | 6 | 1 |
| rs-nitf-wv3-mvs-stereo-chips/wv3_b_chip.ntf | 5 | 0.3 | 174 | 0 | 59.7 | 1 | 0.4 | 6 | 1 |
| derived-nitf-bandsb-msi/s2b_l2a_10seh_bandsb_imodeP.ntf | 5 | 0.3 | 189 | 0 | 60 | 0.8 | 0.3 | 2 | 1 |
| derived-nitf-bandsb-msi/s2b_l2a_10seh_bandsb_imodeR.ntf | 5 | 0.3 | 211 | 0 | 59.7 | 1 | 0.3 | 2 | 1 |
| derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeB.ntf | 4 | 0.3 | 174 | 0 | 59.7 | 1 | 0.3 | 2 | 1 |
| derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeR.ntf | 4 | 0.3 | 174 | 0 | 59.6 | 0.9 | 0.3 | 2 | 1 |
| derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeS.ntf | 4 | 0.3 | 161 | 0 | 60 | 1 | 0.3 | 2 | 1 |
| derived-nitf-variants/cop_dem_nsif.nsf | 4 | 0.3 | 173 | 0 | 59.8 | 1 | 0.3 | 5 | 1 |
| nitf-ntb-nitf21-conformance/v_3303a.ntf | 4 | 0.6 | 285 | 0 | 59.9 | 0.8 |  | 5 | 1 |
| derived-las-pdrf-matrix/autzen_pdrf8_las14.las | 4 | 0.2 |  |  | 59.8 (3D) |  |  |  | 3 |
| rs-lidar-las-laz-copc/autzen_trim_7.las | 4 | 0.2 |  |  | 59.1 (3D) |  |  |  | 3 |
| frames-odm-copr-gcp/images/IMG_0106.jpg | 4 | 1.4 | 1074 | 0 | 59.9 | 0.7 |  | 12 | 1 |
| derived-fmv-variants/nightir_hevc_klv.ts | 4 | 0.2 |  |  |  |  |  |  | 2 |
| s2-l1c-jp2-safe-10seh-20240816/S2B_MSIL1C_20240816T184919_N0511_R113_T10SEH_20240816T222835.SAFE/GRANULE/L1C_T10SEH_A038892_20240816T185441/IMG_DATA/T10SEH_20240816T184919_B09.jp2 | 4 | 0.4 | 373 | 0 | 60 | 0.9 | 0.3 | 9 | 1 |
| rs-lidar-las-laz-copc/autzen_trim.las | 4 | 0.2 |  |  | 59.8 (3D) |  |  |  | 3 |
| derived-nitf-bandsb-msi/landsat8_sr_bandsb_imodeR.ntf | 4 | 0.3 | 184 | 0 | 60 | 0.9 | 0.3 | 2 | 1 |
| 3d-tiles-samples-i3dm-pnts/TilesetWithRequestVolume/building.b3dm | 4 | 0.0 |  |  |  |  |  |  | 1 |
| derived-zip-deliveries/nested_naip.zip | 3 | 1.1 | 608 | 0 | 60 | 0.9 | 0.2 | 4 | 1 |
| lidar-ascii-pdal-text/text/utm17_3.txt | 3 | 0.3 |  |  | 59.8 (3D) |  |  |  | 3 |
| derived-app-artifacts/proj-0.1.0.gwpack | 3 | 0.2 |  |  |  |  |  |  | 1 |
| derived-fmv-variants/dayflight_hevc_klv.ts | 3 | 0.2 |  |  |  |  |  |  | 2 |
| derived-pictures-worldfile/naip.bmp | 3 | 0.6 | 177 | 0 | 60 | 0.9 | 0.3 | 4 | 1 |
| derived-pictures-worldfile/s2tci.bmp | 3 | 0.6 | 169 | 0 | 60 | 1 | 0.3 | 4 | 1 |
| rs-nitf-jitc-imode-bprs/v_3301a.ntf | 3 | 0.6 | 213 | 0 | 60 | 0.8 |  | 4 | 1 |
| derived-vector-variants/ne_countries_epsg3857.geojson | 3 | 0.1 |  |  |  |  |  |  | 2 |
| gdal-dted-samples/w118n033.dt1 | 3 | 0.4 | 157 | 0 | 60 | 1 | 0.3 | 8 | 1 |
| rs-dted-gdal/w118n033.dt1 | 3 | 0.4 | 145 | 0 | 59.8 | 1 | 0.3 | 8 | 1 |
| usgs-srtm-dted2-n39w106/n39_w106_3arc_v2.dt1 | 3 | 0.4 | 147 | 0 | 60 | 1 | 0.3 | 8 | 1 |
| derived-hgt-variants/srtm3-1201/N39W106.hgt | 3 | 0.4 | 155 | 0 | 59.9 | 1 | 0.3 | 8 | 1 |
| derived-vector-variants/nhd_nhdflowline_m.shp | 3 | 0.1 |  |  |  |  |  |  | 1 |
| derived-vector-variants/nhd_nhdflowline_z.shp | 3 | 0.1 |  |  |  |  |  |  | 1 |
| 3d-gltf-khronos-meshopt/DragonAttenuation/glTF-Meshopt-EXT/DragonAttenuation.gltf | 3 | 0.1 |  |  |  |  |  |  | 4 |
| derived-las-pdrf-matrix/autzen_pdrf2_las12.las | 3 | 0.2 |  |  | 59.9 (3D) |  |  |  | 3 |
| lidar-las-version-matrix/pdal/lone-star.copc.laz | 3 | 0.6 |  |  | 59.8 (3D) |  |  |  | 3 |
| nitf-ntb-ns3437a-c5-lossless/ns3437a.nsf | 3 | 0.6 | 360 | 0 | 59.7 | 0.8 |  | 5 | 1 |
| derived-pmtiles-raster/cop_hillshade_jpeg.pmtiles | 3 | 0.0 |  |  |  |  |  |  | 1 |
| vector-geopackage-conformance-set/nga/example.gpkg | 2 | 1.3 | 237 | 0 | 59.9 | 1.3 | 0.3 | 29 | 1 |
| rs-nitf-jitc-multiseg-graphics/NITF21_CGM_ANNO_Uncompressed_unmasked.ntf | 2 | 0.3 | 186 | 0 | 59.7 | 0.9 | 0.2 | 3 | 1 |
| derived-gtiff-codec-matrix/dem_lerc.tif | 2 | 0.3 | 198 | 0 | 59.7 | 0.9 | 0.3 | 8 | 1 |
| derived-gtiff-codec-matrix/dem_lerc_deflate.tif | 2 | 0.3 | 219 | 0 | 60 | 1 | 0.3 | 8 | 1 |
| vector-geopackage-conformance-set/ogc/sample1_0.gpkg | 2 | 0.2 |  |  |  |  |  |  | 1 |
| derived-vmti-video/osh_sample_vmti.ts | 2 | 0.2 |  |  |  |  |  |  | 2 |
| derived-sar-sicd14-sidd30/umbra_chip1_sicd14.nitf | 2 | 0.3 | 130 | 0 | 59.9 | 0.9 | 0.4 | 1 | 1 |
| derived-sar-sicd14-sidd30/umbra_chip1_sicd15.nitf | 2 | 0.3 | 127 | 0 | 59.9 | 1 | 0.5 | 1 | 1 |
| derived-vector-variants/ne_countries_gml32.gml | 2 | 0.1 |  |  |  |  |  |  | 1 |
| derived-pictures-worldfile/s2tci.png | 2 | 0.3 | 166 | 0 | 60 | 0.8 | 0.3 | 4 | 1 |
| rs-nitf-jitc-masked-nm/v_3301c.ntf | 2 | 0.3 | 179 | 0 | 59.9 | 0.8 |  | 2 | 1 |
| gdal-dted-samples/l5102.dhm | 2 | 0.3 | 132 | 0 | 59.6 | 0.9 | 0.3 | 5 | 1 |
| derived-pmtiles-raster/cop_hillshade_webp.pmtiles | 2 | 0.0 |  |  |  |  |  |  | 1 |
| derived-pictures-worldfile/naip.png | 2 | 0.6 | 171 | 0 | 60 | 1 | 0.2 | 4 | 1 |
| derived-gtiff-codec-matrix/rgb_lerc_zstd.tif | 2 | 0.6 | 263 | 0 | 60 | 1.1 | 0.3 | 4 | 1 |
| derived-jp2-variants/naip_htj2k.j2c | 1 | 0.6 | 250 | 0 | 60 | 1 | 0.3 | 4 | 1 |
| nitf-ntb-nitf20-conformance/U_4020i.ntf | 1 | 0.8 | 780 | 0 | 59.9 | 0.8 |  | 16 | 1 |
| nitf-ntb-nitf20-conformance/U_4022a.ntf | 1 | 0.9 | 776 | 0 | 59.9 | 0.8 |  | 16 | 1 |
| derived-vector-variants/ne_rivers_wkt.csv | 1 | 0.1 |  |  |  |  |  |  | 1 |
| derived-zip-deliveries/s2tci_jp2_delivery.zip | 1 | 0.9 | 440 | 0 | 59.8 | 1 | 0.3 | 4 | 1 |
| derived-jp2-variants/s2tci_geojp2.jp2 | 1 | 0.8 | 421 | 0 | 60 | 1 | 0.3 | 4 | 1 |
| derived-sar-sicd14-sidd30/capella_chip1_sicd14.nitf | 1 | 0.3 | 133 | 0 | 60 | 1 | 0.8 | 1 | 1 |
| derived-sar-sicd14-sidd30/capella_chip1_sicd15.nitf | 1 | 0.3 | 147 | 0 | 59.9 | 1 | 0.8 | 1 | 1 |
| derived-geopdf-iso32000/naip_geo_iso32000.pdf | 1 | 0.7 | 363 | 0 | 59.8 | 0.9 | 0.3 | 16 | 1 |
| derived-pictures-worldfile/wv3vis.gif | 1 | 0.3 | 121 | 0 | 59.8 | 0.9 | 0.3 | 1 | 1 |
| rs-nitf-jitc-multiseg-graphics/U_1123a.ntf | 1 | 0.3 | 115 | 0 | 59.8 | 0.9 |  | 1 | 1 |
| derived-pictures-worldfile/s2tci.gif | 1 | 0.3 | 122 | 0 | 60 | 1 | 0.3 | 1 | 1 |
| vector-geopackage-conformance-set/nga/3857.gpkg | 1 | 0.4 | 306 | 0 | 60 | 1 | 0.3 | 9 | 1 |
| derived-zip-deliveries/naip_nitf_delivery.zip | 1 | 0.8 | 439 | 0 | 59.9 | 0.9 | 0.3 | 4 | 1 |
| derived-gtiff-variants/s2tci_webp.tif | 1 | 0.8 | 561 | 0 | 60 | 1 | 0.2 | 16 | 1 |
| derived-geopdf-iso32000/cop_hillshade_geo_both.pdf | 1 | 0.7 | 358 | 0 | 60 | 0.9 | 0.2 | 16 | 1 |
| derived-gtiff-variants/wv3vis_webp.tif | 1 | 1.1 | 699 | 0 | 59.9 | 1 | 0.3 | 16 | 1 |
| lidar-las-version-matrix/laspy/simple1_4.las | 1 | 0.1 |  |  | 59.7 (3D) |  |  |  | 3 |
| change-spacenet7-train-sample/sample/L15-0506E-1204N_2027_3374_13/labels/global_monthly_2018_03_mosaic_L15-0506E-1204N_2027_3374_13_Buildings.geojson | 1 | 0.1 |  |  |  |  |  |  | 1 |
| 3d-gltf-khronos-meshopt/BrainStem/glTF-Meshopt-EXT/BrainStem.gltf | 1 | 0.1 |  |  |  |  |  |  | 5 |
| raster-pmtiles-martin-pmtilesrs-fixtures/martin_png.pmtiles | 1 | 0.0 |  |  |  |  |  |  | 1 |
| hsi-speclib-splib07b-envi-hyperspectralpy/splib07b_asdng.sli | 1 | 0.1 |  |  |  |  |  |  | 1 |
| vector-geopackage-conformance-set/ogc/gdal_sample_v1.2_spi_nonlinear_webp_elevation.gpkg | 1 | 0.2 | 137 | 0 | 59.7 | 1.1 | 0.3 | 0 | 1 |
| rs-lidar-las-laz-copc/ellipsoid.copc.laz | 1 | 0.3 |  |  | 59.9 (3D) |  |  |  | 3 |
| vector-kml-kmz-test-set/libkml/polygons2d.kml | 1 | 0.1 |  |  |  |  |  |  | 1 |
| jp2-openjpeg-conformance/file5.jp2 | 1 | 0.6 | 289 | 0 | 59.9 | 0.7 |  | 1 | 1 |
| lidar-las-version-matrix/lastools/TO_core_last_zoom.laz | 1 | 0.4 |  |  | 59.7 (3D) |  |  |  | 3 |
| fmv-impleotv-damaged-corpus/mpegts-pcr-pts-drift.ts | 1 | 0.1 |  |  |  |  |  |  | 1 |
| vector-kml-kmz-test-set/libkml/model-macky.kmz | 0 | 0.0 |  |  |  |  |  |  | 1 |
| jp2-htj2k-openjpeg-nonregression/Bretagne1_ht.j2k | 0 | 0.3 | 174 | 0 | 59.7 | 0.8 |  | 1 | 1 |
| derived-3d-tiles-3tz/MultipleContents.3tz | 0 | 0.1 |  |  |  |  |  |  | 3 |
| nitf-ntb-nitf11-legacy/U_0001c.ntf | 0 | 0.3 | 124 | 0 | 59.7 | 0.9 |  | 0 | 1 |
| nitf-ntb-nitf11-legacy/U_0001b.ntf | 0 | 0.3 | 102 | 0 | 60 | 0.8 |  | 0 | 1 |
| vector-rareplanes-real-test-108/PS-RGB_tiled/108_10400100457A8A00_tile_78.png | 0 | 0.3 | 128 | 0 | 59.9 | 1 | 0.3 | 1 | 1 |
| derived-pictures-worldfile/s2tci.jpg | 0 | 0.6 | 167 | 0 | 60 | 1 | 0.3 | 4 | 1 |
| rs-nitf-jitc-vq-cadrg/U_3058b.ntf | 0 | 0.3 | 207 | 0 | 59.6 | 0.9 | 0.3 | 9 | 1 |
| nitf-rpf-cadrg-frames/cadrg/001zc013.on1 | 0 | 0.6 | 256 | 0 | 59.9 | 1.1 | 0.2 | 9 | 1 |
| derived-rpf-cadrg-from-cib10/n35e011/RPF/ZONE2/01EXR010.MM2 | 0 | 0.6 | 256 | 0 | 59.8 | 1 | 0.2 | 9 | 1 |
| derived-rpf-cadrg-from-cib10/n35e011/RPF/ZONE2/01H70010.MM2 | 0 | 0.6 | 257 | 0 | 59.8 | 1 | 0.3 | 9 | 1 |
| derived-rpf-cadrg-from-cib10/n60w156/RPF/ZONE4/01JFA010.MM4 | 0 | 0.3 | 244 | 0 | 59.9 | 1 | 0.2 | 9 | 1 |
| derived-rpf-cadrg-from-cib10/n60w156/RPF/ZONE4/01KY5010.MM4 | 0 | 0.6 | 254 | 0 | 59.8 | 1.1 | 0.3 | 9 | 1 |
| derived-pictures-worldfile/s2tci.webp | 0 | 0.6 | 176 | 0 | 59.7 | 0.9 | 0.3 | 4 | 1 |
| fmv-impleotv-damaged-corpus/klv-missing-mandatory-tags.ts | 0 | 0.1 |  |  |  |  |  |  | 2 |
| derived-nitf-variants/wv3vis_ic_m3.ntf | 0 | 0.6 | 220 | 0 | 59.9 | 1.1 | 0.3 | 4 | 1 |
| derived-pictures-worldfile/naip.webp | 0 | 0.6 | 164 | 0 | 59.9 | 1 | 0.2 | 4 | 1 |
| derived-nitf-variants/naip_ic_m3.ntf | 0 | 0.6 | 226 | 0 | 59.9 | 1 | 0.2 | 4 | 1 |
| vector-geopackage-conformance-set/ogc/states10.gpkg | 0 | 0.1 |  |  |  |  |  |  | 1 |
| jp2-htj2k-openjpeg-nonregression/Bretagne1_ht_lossy.j2k | 0 | 0.3 | 169 | 0 | 60 | 0.8 |  | 1 | 1 |
| derived-pictures-worldfile/wv3vis.jpg | 0 | 0.6 | 166 | 0 | 59.7 | 1.1 | 0.3 | 4 | 1 |
| vector-shp-z-cpg-shapefile-js/LGA_2013_AUST.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-vector-naturalearth-110m/ne_110m_admin_0_countries.zip | 0 | 0.1 |  |  |  |  |  |  | 1 |
| derived-gmti-tracks-ais/houston_galveston_ais_20230601.4607 | 0 | 0.1 |  |  |  |  |  |  | 11 |
| 3d-gltf-khronos-plain-glb/Fox/Fox.glb | 0 | 0.1 |  |  |  |  |  |  | 3 |
| nitf-rpf-cadrg-frames/gn3/0000M033.GN3 | 0 | 0.3 | 205 | 0 | 59.7 | 1 | 0.3 | 9 | 1 |
| sar-radarsat2-quadpol-slc-samples/RS2_OK153952_PK1408403_DK1372522_SQ1_20231119_053723_HH_VV_HV_VH_SLC/LI-11525-40 RS2 EULA_Gov't User_V1-13_9APR2024_FRENCH.pdf | 0 | 0.4 | 230 | 0 | 59.9 | 0.8 |  | 8 | 1 |
| sar-radarsat2-quadpol-slc-samples/RS2_OK153952_PK1408399_DK1372518_FQ17_20150626_052324_HH_VV_HV_VH_SLC/LI-11525-40 RS2 EULA_Gov't User_V1-13_9APR2024_SPANISH.pdf | 0 | 0.4 | 232 | 0 | 59.7 | 0.8 |  | 10 | 1 |
| 3d-gltf-sample-assets/Duck/glTF/Duck.gltf | 0 | 0.1 |  |  |  |  |  |  | 3 |
| fmv-esri-multiplexer-tutorial/FMV_Multiplexer_Tutorial/Raw_Metadata.csv | 0 | 0.0 |  |  |  |  |  |  | 1 |
| lidar-las-version-matrix/pdal/epsg_4326.las | 0 | 0.1 |  |  | 59.7 (3D) |  |  |  | 3 |
| vector-gpx-gpxpy-tests/korita-zbevnica.gpx | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-nitf-jitc-jpeg-c3/U_2005a.ntf | 0 | 0.3 | 105 | 0 | 59.7 | 0.9 |  | 0 | 1 |
| sar-sicd-sidd-six-library/SICD/cropped_sicd_100.nitf | 0 | 0.1 | 99 | 0 | 59.9 | 0.9 | 0.4 | 0 | 2 |
| sar-sicd-sidd-six-library/SICD/cropped_sicd_101.nitf | 0 | 0.1 | 95 | 0 | 60 | 1 | 0.5 | 0 | 2 |
| sar-sicd-sidd-six-library/SICD/cropped_sicd_120.nitf | 0 | 0.1 | 97 | 0 | 59.9 | 0.9 | 0.5 | 0 | 1 |
| lidar-bpf-pdal-v3/autzen-utm-chipped-25.bpf | 0 | 0.1 |  |  | 59.8 (3D) |  |  |  | 3 |
| nitf-ntb-nitf20-conformance/U_4004b.ntf | 0 | 0.3 | 226 | 0 | 59.9 | 0.8 |  | 6 | 1 |
| derived-sar-complex-slc/umbra_slc_cint32.tif | 0 | 0.6 | 243 | 0 | 60 | 0.9 | 0.2 | 22 | 1 |
| lidar-las-version-matrix/pdal/1.2-with-color.las | 0 | 0.1 |  |  | 59.8 (3D) |  |  |  | 7 |
| gdal-dted-samples/n43.dt0 | 0 | 0.1 | 88 | 0 | 59.8 | 0.9 | 0.3 | 0 | 1 |
| rs-dted-gdal/n43.dt0 | 0 | 0.3 | 92 | 0 | 59.9 | 1 | 0.3 | 0 | 1 |
| lidar-las-version-matrix/laspy/simple1_1.las | 0 | 0.1 |  |  | 59.8 (3D) |  |  |  | 7 |
| lidar-bpf-pdal-v3/autzen-utm-chipped-25-v3-fastlz-interleaved.bpf | 0 | 0.1 |  |  | 60 (3D) |  |  |  | 3 |
| derived-pptx-templates/branded_navy_16x9.pptx | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-msi-spacenet2-wv3/SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-pptx-templates/widescreen_16x9.pptx | 0 | 0.0 |  |  |  |  |  |  | 1 |
| jp2-gdal-server-samples/gcp.jp2 | 0 | 0.3 | 114 | 0 | 60 | 0.8 |  | 0 | 1 |
| derived-control-points/ngs_golden_co_control.csv | 0 | 0.0 |  |  |  |  |  |  | 2 |
| rs-hsi-indian-pines/19920612_AVIRIS_IndianPine_Site3_gr.tif | 0 | 0.3 | 91 | 0 | 59.8 | 0.8 |  | 0 | 1 |
| derived-control-points/ngs_las_vegas_control.csv | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-kml-kmz-test-set/ogc-ets/small_world.kmz | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-detections-csv/rareplanes_108_detections_xyxy.csv | 0 | 0.0 |  |  |  |  |  |  | 1 |
| sar-sicd-sidd-six-library/SIDD/sidd_1.0.0.nitf | 0 | 0.1 | 91 | 0 | 59.9 | 1 | 0.2 | 0 | 1 |
| sar-sicd-sidd-six-library/SIDD/cropped_sidd.nitf | 0 | 0.1 | 100 | 0 | 59.8 | 1 | 0.5 | 0 | 1 |
| 3d-tiles-samples-i3dm-pnts/TilesetWithRequestVolume/city/ll.b3dm | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-nitf-gdal-autotest-small/sar_sicd.ntf | 0 | 0.1 | 99 | 0 | 59.9 | 1 | 0.5 | 0 | 1 |
| derived-app-artifacts/naip_vegas_buildings.gwb | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-gpx-csv-wkt-gdal/csv/curves_polygon.csv | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-flatgeobuf-gdal-autotest/poly.fgb | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-gml-gdal-autotest/arcgis-world-wfs.gml | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-vector-variants/bambi_DJI_20240709090401_0001_T_point0.gpx | 0 | 0.0 |  |  |  |  |  |  | 1 |
| sar-radarsat2-quadpol-slc-samples/RS2_OK153952_PK1408399_DK1372518_FQ17_20150626_052324_HH_VV_HV_VH_SLC/product.kml | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-geoparquet-gdal-autotest/all_geoms.parquet | 0 | 0.0 |  |  |  |  |  |  | 2 |
| vector-gml-gdal-autotest/wfs_200_multiplelayers.gml | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-shp-z-cpg-shapefile-js/htmlcpg.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-nitf-gdal-autotest-small/SENSRB_TRE.ntf | 0 | 0.3 | 96 | 0 | 59.9 | 0.8 |  | 0 | 1 |
| nitf-mvs-wv3-buenos-aires/500514410020_01/DVD_VOL_1/500514410020_01/GIS_FILES/500514410020_01_PRODUCT_SHAPE.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| nitf-mvs-wv3-buenos-aires/500515572030_01/GIS_FILES/500515572030_01_PRODUCT_SHAPE.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-nitf-gdal-autotest-small/two_images_jp2.ntf | 0 | 0.3 | 91 | 0 | 60 | 0.8 |  | 0 | 1 |
| derived-detections-csv/rareplanes_105_detections_latlon.csv | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-app-artifacts/colorado_dem_dted2.gwb | 0 | 0.0 |  |  |  |  |  |  | 1 |
| rs-nitf-gdal-autotest-small/fake_nsif.ntf | 0 | 0.1 | 81 | 0 | 59.9 | 0.9 | 0.2 | 0 | 1 |
| vector-shp-zm-gdal-autotest/shp/multipointz_non_constant_z.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-app-artifacts/airfield-triage.gwrecipe.json | 0 | 0.0 |  |  |  |  |  |  | 1 |
| vector-shp-zm-gdal-autotest/shp/multipatch.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-app-artifacts/building-extraction.gwrecipe.json | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-app-artifacts/template_sheet.gwt.json | 0 | 0.0 |  |  |  |  |  |  | 1 |
| lidar-las-version-matrix/pdal/permutations/1.0_1.las | 0 | 0.1 |  |  | 59.7 (3D) |  |  |  | 2 |
| lidar-las-version-matrix/pdal/permutations/1.2_0.las | 0 | 0.1 |  |  | 59.7 (3D) |  |  |  | 2 |
| raster-pmtiles-gdal-autotest/byte_avif.pmtiles | 0 | 0.0 |  |  |  |  |  |  | 1 |
| raster-gdal-autotest-dimap2-rpf-nm/nitf/i_3034f.ntf | 0 | 0.3 | 83 | 0 | 59.8 | 0.8 |  | 0 | 1 |
| vector-shp-zm-gdal-autotest/shp/polygonm_with_m.shp | 0 | 0.0 |  |  |  |  |  |  | 1 |
| derived-app-artifacts/template_chip.gwt.json | 0 | 0.0 |  |  |  |  |  |  | 1 |
| raster-bigtiff-gdal-autotest/bigtiff_one_block_be_long8.tif | 0 | 0.3 | 88 | 0 | 59.9 | 0.8 |  | 0 | 1 |
| gmti-stanag4607-trane293-fixtures/hrr_signature_parked_both_time_branches.gmti | 0 | 0.1 |  |  |  |  |  |  | 1 |
