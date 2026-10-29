# T&E archive coverage

Generated 2026-10-29T04:31:16.070Z by `build/campaign/coverage.mjs` from `corpus.json` (301 items), `reports/campaign/format-census.json` (4475 files), `formats.json` and `function-needs.json`. Field data (tier U) is excluded from all counts. Refused formats count negative samples.

**Formats:** 174/179 at minimum. **Function data roles:** 74/76 filled.

## Formats

| Key | Format | Status | Samples | Min | Producers | OK | Examples |
|---|---|---|---|---|---|---|---|
| `gtiff` | GeoTIFF | read | 417 | 3 | 33 | yes | rs-dem-derived-s35w059/S35W059_crop1201_float32_cog.tif; rs-geotiff-gdal-small/small_world.tif; rs-geotiff-gdal-small/utm.tif |
| `gtiff.cog` | Cloud Optimized GeoTIFF | variant | 209 | 3 | 16 | yes | rs-dem-derived-s35w059/S35W059_crop1201_float32_cog.tif; rs-geotiff-wv3-rpc-cog/wv3_a_cog.tif; derived-sar-complex-slc/osml_umbra_slc_cfloat32.tif |
| `gtiff.bigtiff` | BigTIFF (valid) | variant | 13 | 3 | 4 | yes | derived-gtiff-variants/naip_bigtiff_tiled.tif; derived-gtiff-variants/cop_dem_bigtiff_striped.tif; derived-gtiff-variants/landsat_b4_bigtiff_bigendian.tif |
| `gtiff.bigendian` | Big-endian TIFF (MM) | variant | 8 | 3 | 3 | yes | derived-gtiff-variants/landsat_b4_bigtiff_bigendian.tif; derived-gtiff-variants/cop_dem_bigendian.tif; derived-gtiff-variants/naip_bigendian_striped.tif |
| `gtiff.striped` | Striped TIFF | variant | 116 | 3 | 17 | yes | rs-geotiff-gdal-small/small_world.tif; rs-geotiff-gdal-small/utm.tif; rs-hsi-indian-pines/19920612_AVIRIS_IndianPine_Site3.tif |
| `gtiff.tiled` | Tiled TIFF | variant | 281 | 3 | 23 | yes | rs-dem-derived-s35w059/S35W059_crop1201_float32_cog.tif; rs-geotiff-wv3-rpc-cog/wv3_a_gtiff_rpc.tif; rs-geotiff-wv3-rpc-cog/wv3_a_cog.tif |
| `gtiff.overviews` | TIFF internal overviews | variant | 215 | 3 | 15 | yes | rs-dem-derived-s35w059/S35W059_crop1201_float32_cog.tif; rs-geotiff-wv3-rpc-cog/wv3_a_cog.tif; landsat7-c2-l2sp-044034-20210617-slcoff/LE07_L2SP_044034_20210617_20210713_02_T1_SR_B1.TIF |
| `gtiff.codec.none` | TIFF uncompressed | variant | 104 | 3 | 14 | yes | rs-geotiff-gdal-small/small_world.tif; rs-geotiff-gdal-small/utm.tif; rs-hsi-indian-pines/19920612_AVIRIS_IndianPine_Site3.tif |
| `gtiff.codec.lzw` | TIFF LZW | variant | 89 | 3 | 8 | yes | derived-gtiff-variants/cop_dem_bigtiff_striped.tif; derived-gtiff-variants/s2tci_lzw.tif; derived-gtiff-variants/wv3vis_lzw.tif |
| `gtiff.codec.deflate` | TIFF Deflate | variant | 173 | 3 | 17 | yes | rs-dem-derived-s35w059/S35W059_crop1201_float32_cog.tif; rs-geotiff-wv3-rpc-cog/wv3_a_gtiff_rpc.tif; rs-geotiff-wv3-rpc-cog/wv3_a_cog.tif |
| `gtiff.codec.packbits` | TIFF PackBits | variant | 4 | 3 | 2 | yes | derived-gtiff-variants/naip_bigendian_striped.tif; derived-gtiff-variants/s2tci_packbits.tif; derived-gtiff-variants/wv3vis_packbits.tif |
| `gtiff.codec.jpeg` | TIFF JPEG (7) | variant | 10 | 3 | 4 | yes | derived-gtiff-variants/s2tci_jpeg.tif; derived-gtiff-variants/wv3vis_jpeg.tif; eo-maxar-turkey-eq-islahiye-prepost/2022-12-27/10300100E0287700-visual.tif |
| `gtiff.codec.webp` | TIFF WebP | variant | 3 | 3 | 2 | yes | derived-gtiff-variants/s2tci_webp.tif; derived-gtiff-variants/wv3vis_webp.tif; derived-gtiff-codec-matrix/rgb_webp.tif |
| `gtiff.codec.zstd` | TIFF ZSTD | variant | 5 | 3 | 2 | yes | derived-gtiff-variants/landsat_b4_bigtiff_bigendian.tif; derived-gtiff-variants/s2tci_zstd.tif; derived-gtiff-variants/wv3vis_zstd.tif |
| `gtiff.codec.lerc` | TIFF LERC | variant | 4 | 3 | 2 | yes | derived-gtiff-variants/s2tci_lerc.tif; derived-gtiff-variants/wv3vis_lerc.tif; derived-gtiff-codec-matrix/rgb_lerc.tif |
| `gtiff.codec.ojpeg` | TIFF old-style JPEG (6) | refused | 3 | 3 | 1 | yes | raster-ojpeg-libtiff-negatives/ojpeg_chewey_subsamp21_multi_strip.tiff; raster-ojpeg-libtiff-negatives/ojpeg_single_strip_no_rowsperstrip.tiff; raster-ojpeg-libtiff-negatives/ojpeg_zackthecat_subsamp22_single_strip.tiff |
| `gtiff.complex.cint16` | Complex SLC GeoTIFF CInt16 | variant | 5 | 3 | 2 | yes | derived-sar-complex-slc/umbra_slc_cint16.tif; derived-sar-complex-slc/capella_slc_cint16.tif; derived-sar-complex-slc/osml_umbra_slc_cint16.tif |
| `gtiff.complex.cint32` | Complex SLC GeoTIFF CInt32 | variant | 3 | 3 | 1 | yes | derived-sar-complex-slc/umbra_slc_cint32.tif; derived-sar-complex-slc/capella_slc_cint32.tif; derived-sar-complex-slc/osml_umbra_slc_cint32.tif |
| `gtiff.complex.cfloat32` | Complex SLC GeoTIFF CFloat32 | variant | 3 | 3 | 1 | yes | derived-sar-complex-slc/umbra_slc_cfloat32.tif; derived-sar-complex-slc/capella_slc_cfloat32.tif; derived-sar-complex-slc/osml_umbra_slc_cfloat32.tif |
| `rpc.gtiff` | RPC in GeoTIFF tag 50844 | variant | 19 | 3 | 5 | yes | rs-geotiff-wv3-rpc-cog/wv3_a_gtiff_rpc.tif; derived-gtiff-variants/mvs_wv3_a_chip_rpc.tif; derived-gtiff-variants/mvs_wv3_b_chip_rpc.tif |
| `georef.gcps` | GeoTIFF tie-point GCPs | variant | 27 | 3 | 5 | yes | derived-gtiff-variants/naip_gcps.tif; derived-gtiff-variants/landsat_b4_gcps.tif; derived-gtiff-variants/cop_dem_gcps.tif |
| `raster.cube` | Raster with ≥30 bands | variant | 5 | 3 | 4 | yes | rs-hsi-indian-pines/19920612_AVIRIS_IndianPine_Site3.tif; derived-hsi-cube-geotiff/aviris_refl_chip.tif; derived-hsi-cube-geotiff/dfc2018_casi_chip.tif |
| `jp2` | JPEG 2000 (standalone) | read | 88 | 3 | 6 | yes | derived-jp2-variants/naip_geojp2.jp2; derived-jp2-variants/naip_gmljp2.jp2; derived-jp2-variants/naip_codestream.j2k |
| `jp2.geojp2` | GeoJP2 UUID box | variant | 13 | 3 | 4 | yes | derived-jp2-variants/naip_geojp2.jp2; derived-jp2-variants/s2tci_geojp2.jp2; derived-jp2-variants/wv3vis_geojp2.jp2 |
| `jp2.gmljp2` | GMLJP2 | variant | 51 | 3 | 4 | yes | derived-jp2-variants/naip_gmljp2.jp2; derived-jp2-variants/s2tci_gmljp2.jp2; derived-jp2-variants/wv3vis_gmljp2.jp2 |
| `jp2.htj2k` | HTJ2K (Part 15) | variant | 11 | 3 | 3 | yes | derived-jp2-variants/naip_htj2k.j2c; derived-jp2-variants/s2tci_htj2k.j2c; derived-jp2-variants/wv3vis_htj2k.j2c |
| `jp2.codestream` | Raw J2K codestream | variant | 18 | 3 | 5 | yes | derived-jp2-variants/naip_codestream.j2k; derived-jp2-variants/naip_htj2k.j2c; derived-jp2-variants/s2tci_codestream.j2k |
| `img.jpg` | JPEG picture | read | 490 | 3 | 14 | yes | rs-jpeg-png-worldfile/small_world.jpg; derived-pictures-worldfile/naip.jpg; derived-pictures-worldfile/s2tci.jpg |
| `img.jpg.world` | JPEG + world file | variant | 4 | 3 | 2 | yes | rs-jpeg-png-worldfile/small_world.jpg; derived-pictures-worldfile/naip.jpg; derived-pictures-worldfile/s2tci.jpg |
| `img.png` | PNG picture | read | 54 | 3 | 7 | yes | rs-jpeg-png-worldfile/small_world.png; derived-pictures-worldfile/naip.png; derived-pictures-worldfile/s2tci.png |
| `img.png.world` | PNG + world file | variant | 4 | 3 | 2 | yes | rs-jpeg-png-worldfile/small_world.png; derived-pictures-worldfile/naip.png; derived-pictures-worldfile/s2tci.png |
| `img.gif.world` | GIF + world file | variant | 3 | 3 | 1 | yes | derived-pictures-worldfile/naip.gif; derived-pictures-worldfile/s2tci.gif; derived-pictures-worldfile/wv3vis.gif |
| `img.bmp.world` | BMP + world file | variant | 3 | 3 | 1 | yes | derived-pictures-worldfile/naip.bmp; derived-pictures-worldfile/s2tci.bmp; derived-pictures-worldfile/wv3vis.bmp |
| `img.webp.world` | WebP + world file | variant | 3 | 3 | 1 | yes | derived-pictures-worldfile/naip.webp; derived-pictures-worldfile/s2tci.webp; derived-pictures-worldfile/wv3vis.webp |
| `dimap.v2` | Airbus DIMAP v2 package | read | 5 | 3 | 1 | yes | raster-gdal-autotest-dimap2-rpf-nm/dimap2/bundle/DIM_foo.XML; raster-gdal-autotest-dimap2-rpf-nm/dimap2/bundle/DIM_foo2.XML; raster-gdal-autotest-dimap2-rpf-nm/dimap2/primary_rpc_center_h/DIM_PNEO3_STD_x_1_1_F_1.XML |
| `dg.rpb` | Maxar/DG .RPB | support | 21 | 3 | 3 | yes | nitf-mvs-wv3-buenos-aires/500515572010_01/DVD_VOL_1/500515572010_01/500515572010_01_P001_PAN/15DEC18140455-P1BS-500515572010_01_P001.RPB; nitf-mvs-wv3-buenos-aires/500515572040_01/DVD_VOL_1/500515572040_01/500515572040_01_P001_PAN/15DEC18140510-P1BS-500515572040_01_P001.RPB; nitf-mvs-wv3-buenos-aires/500515572020_01/DVD_VOL_1/500515572020_01/500515572020_01_P001_PAN/15DEC18140522-P1BS-500515572020_01_P001.RPB |
| `dg.til` | Maxar/DG .TIL | support | 21 | 3 | 3 | yes | nitf-mvs-wv3-buenos-aires/500515572010_01/DVD_VOL_1/500515572010_01/500515572010_01_P001_PAN/15DEC18140455-P1BS-500515572010_01_P001.TIL; nitf-mvs-wv3-buenos-aires/500515572040_01/DVD_VOL_1/500515572040_01/500515572040_01_P001_PAN/15DEC18140510-P1BS-500515572040_01_P001.TIL; nitf-mvs-wv3-buenos-aires/500515572020_01/DVD_VOL_1/500515572020_01/500515572020_01_P001_PAN/15DEC18140522-P1BS-500515572020_01_P001.TIL |
| `dg.imd` | Maxar/DG .IMD | support | 21 | 3 | 3 | yes | nitf-mvs-wv3-buenos-aires/500515572010_01/DVD_VOL_1/500515572010_01/500515572010_01_P001_PAN/15DEC18140455-P1BS-500515572010_01_P001.IMD; nitf-mvs-wv3-buenos-aires/500515572040_01/DVD_VOL_1/500515572040_01/500515572040_01_P001_PAN/15DEC18140510-P1BS-500515572040_01_P001.IMD; nitf-mvs-wv3-buenos-aires/500515572020_01/DVD_VOL_1/500515572020_01/500515572020_01_P001_PAN/15DEC18140522-P1BS-500515572020_01_P001.IMD |
| `zip.imagery` | Imagery delivered in ZIP | read | 7 | 3 | 3 | yes | derived-zip-deliveries/naip_geotiff_delivery.zip; derived-zip-deliveries/s2tci_jp2_delivery.zip; derived-zip-deliveries/naip_nitf_delivery.zip |
| `zip.nested` | ZIP inside ZIP | variant | 3 | 3 | 1 | yes | derived-zip-deliveries/nested_naip.zip; derived-zip-deliveries/nested_two.zip; derived-zip-deliveries/nested_deep.zip |
| `geopdf.iso32000` | GeoPDF ISO 32000 /GEO | read | 6 | 3 | 2 | yes | derived-geopdf-iso32000/naip_geo_iso32000.pdf; derived-geopdf-iso32000/s2tci_geo_iso32000.pdf; derived-geopdf-iso32000/cop_hillshade_geo_both.pdf |
| `geopdf.lgidict` | GeoPDF LGIDict (pre-ISO) | variant | 3 | 3 | 2 | yes | geopdf-htmc-honker-bay-bouldin-island/CA_Honker_Bay_100766_1953_24000_geo.pdf; geopdf-htmc-honker-bay-bouldin-island/CA_Bouldin_Island_288579_1952_24000_geo.pdf; geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf |
| `pdf.nogeo` | PDF without georeferencing (opens in image space, like a picture without a world file) | variant | 10 | 3 | 3 | yes | derived-raster-negatives/cop_dem_pdf.pdf; derived-raster-negatives/naip_b1_pdf.pdf; derived-raster-negatives/landsat_b4_pdf.pdf |
| `refused.mrsid` | MrSID | refused | 5 | 3 | 1 | yes | raster-mrsid-gdal-samples/lossless-mg3/utm11-27.sid; raster-mrsid-gdal-samples/lossy-mg2/utm11-27.sid; raster-mrsid-gdal-samples/lossy-mg3/mercator.sid |
| `refused.ecw` | ECW | refused | 5 | 3 | 1 | yes | raster-ecw-negatives-gdal/red_flower.ecw; raster-ecw-negatives-gdal/sandiego2m_null.ecw; raster-ecw-negatives-gdal/spif83.ecw |
| `refused.hfa` | ERDAS Imagine .img (HFA) | refused | 10 | 3 | 2 | yes | derived-raster-negatives/cop_dem_hfa.img; derived-raster-negatives/naip_b1_hfa.img; derived-raster-negatives/landsat_b4_hfa.img |
| `nitf.v20` | NITF 2.0 | read | 49 | 3 | 6 | yes | rs-nitf-jitc-bitdepth/U_4005a.ntf; rs-nitf-jitc-imode-bprs/U_3002a.ntf; rs-nitf-jitc-jpeg-c3/U_1005a.ntf |
| `nitf.v21` | NITF 2.1 | read | 109 | 3 | 22 | yes | rs-nitf-gdal-autotest-small/two_images_jp2.ntf; rs-nitf-gdal-autotest-small/two_images_jpeg.ntf; rs-nitf-gdal-autotest-small/SENSRB_TRE.ntf |
| `nsif.v10` | NSIF 1.0 | read | 7 | 3 | 4 | yes | rs-nitf-gdal-autotest-small/fake_nsif.ntf; rs-nsif-jitc/nsif_N_3001a.nsf; rs-nsif-jitc/ns3114a.nsf |
| `nitf.v11` | NITF 1.1 | refused | 6 | 3 | 1 | yes | nitf-ntb-nitf11-legacy/U_0001a.ntf; nitf-ntb-nitf11-legacy/U_0001b.ntf; nitf-ntb-nitf11-legacy/U_0001c.ntf |
| `nitf.multiimage` | NITF multi-image segments | variant | 23 | 3 | 7 | yes | rs-nitf-gdal-autotest-small/two_images_jp2.ntf; rs-nitf-gdal-autotest-small/two_images_jpeg.ntf; rs-nitf-jitc-multiseg-graphics/U_1123a.ntf |
| `nitf.ic.nc` | NITF IC=NC | variant | 113 | 3 | 20 | yes | rs-nitf-gdal-autotest-small/two_images_jp2.ntf; rs-nitf-gdal-autotest-small/two_images_jpeg.ntf; rs-nitf-gdal-autotest-small/SENSRB_TRE.ntf |
| `nitf.ic.nm` | NITF IC=NM (masked) | variant | 4 | 3 | 2 | yes | rs-nitf-jitc-masked-nm/v_3301c.ntf; rs-nitf-jitc-masked-nm/v_3301f.ntf; raster-gdal-autotest-dimap2-rpf-nm/nitf/i_3034f.ntf |
| `nitf.ic.c1` | NITF IC=C1 bi-level | variant | 5 | 3 | 2 | yes | rs-nitf-jitc-multiseg-graphics/U_1123a.ntf; nitf-ntb-nitf20-conformance/U_1036a.ntf; nitf-ntb-nitf20-conformance/U_1050a.ntf |
| `nitf.ic.c3` | NITF IC=C3 JPEG | variant | 23 | 3 | 5 | yes | rs-nitf-gdal-autotest-small/two_images_jpeg.ntf; rs-nitf-jitc-jpeg-c3/U_1005a.ntf; rs-nitf-jitc-jpeg-c3/U_4017a.ntf |
| `nitf.ic.m3` | NITF IC=M3 masked JPEG | variant | 3 | 3 | 1 | yes | derived-nitf-variants/naip_ic_m3.ntf; derived-nitf-variants/s2tci_ic_m3.ntf; derived-nitf-variants/wv3vis_ic_m3.ntf |
| `nitf.ic.c4` | NITF IC=C4 VQ | variant | 3 | 3 | 2 | yes | raster-gdal-autotest-dimap2-rpf-nm/rpftoc/zone9/RPF/ZONE9/00027010.ON9; nitf-rpf-cadrg-frames/cadrg/001zc013.on1; nitf-rpf-cadrg-frames/rpf_toc/RPFTOC01.ON2 |
| `nitf.ic.c8` | NITF IC=C8 JPEG 2000 | variant | 22 | 3 | 6 | yes | rs-nitf-gdal-autotest-small/two_images_jp2.ntf; rs-nitf-ntb-j2k-p0_01/p0_01a.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip_j2k.ntf |
| `nitf.ic.m8` | NITF IC=M8 masked JPEG 2000 | variant | 0 | 1 | 0 | **no** |  |
| `nitf.ic.c5` | NITF IC=C5 lossless JPEG | refused | 0 | 1 | 0 | **no** |  |
| `nitf.ic.c2` | NITF IC=C2 ARIDPCM | refused | 0 | 1 | 0 | **no** |  |
| `nitf.imode.b` | NITF IMODE B | variant | 107 | 3 | 22 | yes | rs-nitf-gdal-autotest-small/two_images_jp2.ntf; rs-nitf-gdal-autotest-small/two_images_jpeg.ntf; rs-nitf-gdal-autotest-small/SENSRB_TRE.ntf |
| `nitf.imode.p` | NITF IMODE P | variant | 42 | 3 | 13 | yes | rs-nitf-gdal-autotest-small/sar_sicd.ntf; rs-nitf-jitc-imode-bprs/v_3310a.ntf; rs-nitf-jitc-jpeg-c3/U_2005a.ntf |
| `nitf.imode.r` | NITF IMODE R | variant | 4 | 3 | 2 | yes | rs-nitf-jitc-imode-bprs/v_3301h.ntf; derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeR.ntf; derived-nitf-bandsb-msi/landsat8_sr_bandsb_imodeR.ntf |
| `nitf.imode.s` | NITF IMODE S | variant | 4 | 3 | 4 | yes | rs-nitf-jitc-imode-bprs/v_3301a.ntf; rs-nitf-jitc-masked-nm/v_3301c.ntf; derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeS.ntf |
| `rpc.nitf` | RPC00A/B in NITF | variant | 20 | 3 | 4 | yes | rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_b_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip_j2k.ntf |
| `sensor.rsm` | NGA RSM TREs | variant | 4 | 3 | 1 | yes | derived-nitf-rsm/mvs_wv3_rsm.ntf; derived-nitf-rsm/mvs_wv3_rsm_rpc00b.ntf; derived-nitf-rsm/core3d_jax_wv3_rsm.ntf |
| `nitf.mie4nitf` | MIE4NITF (MTIMSA) | read | 3 | 3 | 1 | yes | derived-mie4nitf-bambi/flight_258_thermal_mie4nitf.ntf; derived-mie4nitf-bambi/flight_306_thermal_mie4nitf.ntf; derived-mie4nitf-bambi/flight_316_thermal_mie4nitf.ntf |
| `rpf.frame` | RPF frame (CADRG/CIB) | read | 5 | 3 | 2 | yes | raster-gdal-autotest-dimap2-rpf-nm/rpftoc/zone9/RPF/ZONE9/00027010.ON9; nitf-rpf-cadrg-frames/cadrg/001zc013.on1; nitf-rpf-cadrg-frames/cadrg/overview.ovr |
| `rpf.cib` | RPF CIB | variant | 0 | 3 | 0 | **no** |  |
| `rpf.toc` | RPF A.TOC | support | 2 | 3 | 2 | **no** | raster-gdal-autotest-dimap2-rpf-nm/rpftoc/zone9/RPF/A.TOC; nitf-rpf-cadrg-frames/rpf_toc/A.TOC |
| `tre.USE00A` | USE00A sun angles | support | 19 | 3 | 3 | yes | rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_b_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip_j2k.ntf |
| `tre.BANDSB` | BANDSB band metadata | support | 8 | 3 | 1 | yes | derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeB.ntf; derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeR.ntf; derived-nitf-bandsb-msi/wv3_vegas_ms_bandsb_imodeS.ntf |
| `tre.ICHIPB` | ICHIPB chip mapping | support | 3 | 3 | 1 | yes | rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_b_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip_j2k.ntf |
| `tre.RPC00B` | RPC00B TRE | support | 20 | 3 | 4 | yes | rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_b_chip.ntf; rs-nitf-wv3-mvs-stereo-chips/wv3_a_chip_j2k.ntf |
| `sar.sicd` | SICD in NITF | read | 30 | 3 | 8 | yes | rs-nitf-gdal-autotest-small/sar_sicd.ntf; rs-sicd-umbra-chip/umbra_sicd_chip_1024.nitf; derived-sar-sicd14-sidd30/capella_chip1_sicd14.nitf |
| `sar.sicd.v1.1.0` | SICD 1.1 | variant | 7 | 1 | 5 | yes | rs-nitf-gdal-autotest-small/sar_sicd.ntf; sar-sicd-sidd-six-library/SICD/cropped_sicd_110.nitf; sar-sicd-sidd-six-library/SICD/sicd_1.1.0.nitf |
| `sar.sicd.v1.2.1` | SICD 1.2.1 | variant | 6 | 3 | 3 | yes | sar-sicd-sidd-six-library/SICD/sicd_50x50.nitf; umbra-bingham-20230925-full/umbra_20230925_SICD.nitf; umbra-bingham-20230821-repeat/umbra_20230821_SICD.nitf |
| `sar.sicd.v1.3.0` | SICD 1.3.0 | variant | 9 | 3 | 4 | yes | rs-sicd-umbra-chip/umbra_sicd_chip_1024.nitf; sar-capella-c10-sp-20240329/capella_C10_SP_SICD.ntf; sar-umbra-stack-silver-peak/2025-02-16-04-57-11_UMBRA-05/2025-02-16-04-57-11_UMBRA-05_SICD.nitf |
| `sar.sicd.v1.4.0` | SICD 1.4 | variant | 6 | 3 | 4 | yes | derived-sar-sicd14-sidd30/capella_chip1_sicd14.nitf; derived-sar-sicd14-sidd30/umbra_chip1_sicd14.nitf; derived-sar-sicd14-sidd30/six_50x50_sicd14.nitf |
| `sar.sicd.v1.5` | SICD 1.5 | variant | 3 | 3 | 1 | yes | derived-sar-sicd14-sidd30/capella_chip1_sicd15.nitf; derived-sar-sicd14-sidd30/umbra_chip1_sicd15.nitf; derived-sar-sicd14-sidd30/six_50x50_sicd15.nitf |
| `sar.sicd.quadpol` | Quad-pol SICD | variant | 4 | 3 | 3 | yes | rs-nitf-gdal-autotest-small/sar_sicd.ntf; sar-sicd-nitro-amp8i-phs8i/sicd_example_1_PFA_AMP8I_PHS8I_VV_with_amplitude_table_SICD.nitf; sar-sicd-nitro-amp8i-phs8i/sicd_example_1_PFA_AMP8I_PHS8I_VV_no_amplitude_table_SICD.nitf |
| `sar.sidd` | SIDD in NITF | read | 13 | 3 | 8 | yes | rs-sidd-umbra/2023-10-24-03-19-54_UMBRA-04_SIDD.nitf; derived-sar-sicd14-sidd30/capella_c10_sp_sidd_sidd30.nitf; derived-sar-sicd14-sidd30/capella_c13_sm_sidd_sidd30.nitf |
| `sar.sidd.v2.0.0` | SIDD 2.0 | variant | 6 | 3 | 4 | yes | rs-sidd-umbra/2023-10-24-03-19-54_UMBRA-04_SIDD.nitf; sar-capella-c10-sp-20240329/capella_C10_SP_SIDD.ntf; umbra-bingham-20230925-full/umbra_20230925_SIDD.nitf |
| `sar.sidd.v3.0.0` | SIDD 3.0 | variant | 4 | 3 | 2 | yes | derived-sar-sicd14-sidd30/capella_c10_sp_sidd_sidd30.nitf; derived-sar-sicd14-sidd30/capella_c13_sm_sidd_sidd30.nitf; derived-sar-sicd14-sidd30/umbra_bingham_sidd_sidd30.nitf |
| `refused.cphd` | CPHD | refused | 4 | 3 | 3 | yes | sar-cphd-gdal-autotest/test.cphd; sar-capella-c09-sm-cphd-20240923/capella_C09_SM_CPHD.cphd; umbra-bingham-20230925-full/umbra_20230925_CPHD.cphd |
| `envi` | ENVI raw + .hdr | read | 19 | 3 | 5 | yes | rs-envi-hsi-indian-pines/indian_pines_220b.hdr; derived-envi-variants/enmap_bil.hdr; derived-envi-variants/enmap_bip.hdr |
| `envi.bsq` | ENVI BSQ | variant | 5 | 3 | 3 | yes | rs-envi-hsi-indian-pines/indian_pines_220b.hdr; derived-envi-variants/enmap_bsq_bigendian.hdr; derived-envi-variants/indianpines_bsq_bigendian.hdr |
| `envi.bil` | ENVI BIL | variant | 8 | 3 | 3 | yes | derived-envi-variants/enmap_bil.hdr; derived-envi-variants/indianpines_bil.hdr; derived-envi-variants/landsat_sr_bil.hdr |
| `envi.bip` | ENVI BIP | variant | 6 | 3 | 3 | yes | derived-envi-variants/enmap_bip.hdr; derived-envi-variants/indianpines_bip.hdr; derived-envi-variants/landsat_sr_bip.hdr |
| `envi.bigendian` | ENVI big-endian | variant | 4 | 3 | 2 | yes | derived-envi-variants/enmap_bsq_bigendian.hdr; derived-envi-variants/indianpines_bsq_bigendian.hdr; derived-envi-variants/landsat_sr_bsq_bigendian.hdr |
| `envi.mapinfo` | ENVI map info | variant | 13 | 3 | 4 | yes | derived-envi-variants/enmap_bil.hdr; derived-envi-variants/enmap_bip.hdr; derived-envi-variants/enmap_bsq_bigendian.hdr |
| `hdf5` | HDF5 / NetCDF-4 cube | read | 4 | 3 | 1 | yes | emit-l2a-rfl-cuprite/EMIT_L2A_RFL_001_20240727T213005_2420914_007.nc; emit-l2a-rfl-cuprite/EMIT_L2A_MASK_001_20240727T213005_2420914_007.nc; emit-l1b-rad-cuprite/EMIT_L1B_RAD_001_20240727T213005_2420914_007.nc |
| `hdf5.netcdf4` | NetCDF-4 (.nc) | variant | 4 | 3 | 1 | yes | emit-l2a-rfl-cuprite/EMIT_L2A_RFL_001_20240727T213005_2420914_007.nc; emit-l2a-rfl-cuprite/EMIT_L2A_MASK_001_20240727T213005_2420914_007.nc; emit-l1b-rad-cuprite/EMIT_L1B_RAD_001_20240727T213005_2420914_007.nc |
| `refused.netcdf3` | NetCDF-3 classic | refused | 11 | 3 | 3 | yes | derived-raster-negatives/cop_dem_netcdf3.nc; derived-raster-negatives/naip_b1_netcdf3.nc; derived-raster-negatives/landsat_b4_netcdf3.nc |
| `speclib.envi-sli` | ENVI spectral library .sli | read | 13 | 3 | 4 | yes | derived-speclib-envi-sli/splib07_minerals.hdr; derived-speclib-envi-sli/splib07_vegetation.hdr; derived-speclib-envi-sli/splib07_artificial.hdr |
| `meta.landsat-mtl` | Landsat MTL | support | 6 | 3 | 3 | yes | landsat7-c2-l2sp-044034-20210617-slcoff/LE07_L2SP_044034_20210617_20210713_02_T1_MTL.txt; landsat7-c2-l2sp-044034-20210617-slcoff/LE07_L2SP_044034_20210617_20210713_02_T1_MTL.json; landsat8-c1-l1tp-044034-20210508/LC08_L1TP_044034_20210508_20210518_01_T1_MTL.txt |
| `meta.s2-mtd` | Sentinel-2 MTD_MSI | support | 3 | 3 | 2 | yes | s2-l2a-mtd-10seh-pc/20240816/MTD_MSIL2A.xml; s2-l2a-mtd-10seh-pc/20250123/MTD_MSIL2A.xml; s2-l1c-jp2-safe-10seh-20240816/S2B_MSIL1C_20240816T184919_N0511_R113_T10SEH_20240816T222835.SAFE/MTD_MSIL1C.xml |
| `dted.l0` | DTED Level 0 | read | 7 | 3 | 3 | yes | rs-dted-gdal/n43.dt0; gdal-dted-samples/n43.dt0; gdal-autotest-dted-edge/n43_bad_crc.dt0 |
| `dted.l1` | DTED Level 1 | read | 5 | 3 | 4 | yes | rs-dem-derived-s35w059/s35_w059_from_srtm.dt1; rs-dted-gdal/w118n033.dt1; gdal-dted-samples/n48.dt1 |
| `dted.l2` | DTED Level 2 | read | 3 | 3 | 1 | yes | derived-dted-level2/copernicus/w106/n39.dt2; derived-dted-level2/usgs-3dep-1arcsec/w106/n39.dt2; derived-dted-level2/srtm-skadi/w106/n40.dt2 |
| `hgt` | SRTM HGT | read | 6 | 3 | 3 | yes | rs-srtm-hgt-s35w059/S35W059.hgt.gz; derived-hgt-variants/srtm3-1201/N39W106.hgt; derived-hgt-variants/srtm1-3601/N39W106.hgt |
| `gpkg.coverage` | GeoPackage gridded coverage | read | 4 | 3 | 1 | yes | vector-geopackage-conformance-set/ogc/gdal_sample_v1.2_spi_nonlinear_webp_elevation.gpkg; vector-geopackage-conformance-set/nga/example.gpkg; vector-geopackage-conformance-set/nga/coverage_data.gpkg |
| `gpkg.tiles` | GeoPackage tiles | read | 6 | 3 | 2 | yes | rs-gpkg-gdal-raster-tiles/small_world_png.gpkg; vector-geopackage-conformance-set/ogc/gdal_sample_v1.2_spi_nonlinear_webp_elevation.gpkg; vector-geopackage-conformance-set/nga/example.gpkg |
| `gpkg.features` | GeoPackage features | read | 26 | 3 | 7 | yes | rs-vector-fx12-synthetic/fx12.gpkg; eo-maxar-turkey-eq-islahiye-prepost/2022-12-27/10300100E0287700-data-mask.gpkg; eo-maxar-turkey-eq-islahiye-prepost/2023-02-07/1040010082698700-data-mask.gpkg |
| `qmesh.tile` | Quantized-mesh tile | read | 346 | 3 | 4 | yes | derived-qmesh-geodetic/plain/0/0/0.terrain; derived-qmesh-geodetic/plain/1/0/1.terrain; derived-qmesh-geodetic/plain/2/1/2.terrain |
| `qmesh.geodetic` | Quantized-mesh EPSG:4326 layer.json | variant | 6 | 3 | 3 | yes | derived-qmesh-geodetic/plain/layer.json; derived-qmesh-geodetic/normals/layer.json; derived-qmesh-geodetic/watermask/layer.json |
| `las` | LAS/LAZ | read | 72 | 3 | 8 | yes | rs-lidar-las-laz-copc/autzen_trim.las; rs-lidar-las-laz-copc/autzen_trim.laz; rs-lidar-las-laz-copc/simple.copc.laz |
| `laz` | LAZ | variant | 26 | 3 | 6 | yes | rs-lidar-las-laz-copc/autzen_trim.laz; rs-lidar-las-laz-copc/simple.copc.laz; rs-lidar-las-laz-copc/ellipsoid.copc.laz |
| `copc` | COPC | variant | 4 | 3 | 3 | yes | rs-lidar-las-laz-copc/simple.copc.laz; rs-lidar-las-laz-copc/ellipsoid.copc.laz; lidar-autzen-classified-copc/autzen-classified.copc.laz |
| `las.v10` | LAS 1.0 | variant | 5 | 3 | 1 | yes | lidar-las-version-matrix/pdal/permutations/1.0_0.las; lidar-las-version-matrix/pdal/permutations/1.0_1.las; lidar-las-version-matrix/lastools/TO_core_last_zoom.laz |
| `las.v11` | LAS 1.1 | variant | 6 | 3 | 2 | yes | lidar-3dep-co-denver-2008-2x1/USGS_LPC_CO_DENVER_2008_000016.laz; lidar-3dep-co-denver-2008-2x1/USGS_LPC_CO_DENVER_2008_000060.laz; lidar-las-version-matrix/pdal/permutations/1.1_0.las |
| `las.v12` | LAS 1.2 | variant | 21 | 3 | 5 | yes | rs-lidar-las-laz-copc/autzen_trim.las; rs-lidar-las-laz-copc/autzen_trim.laz; derived-las-pdrf-matrix/autzen_pdrf2_las12.las |
| `las.v13` | LAS 1.3 | variant | 8 | 3 | 3 | yes | derived-las-pdrf-matrix/autzen_pdrf4_las13.las; derived-las-pdrf-matrix/autzen_pdrf5_las13.las; derived-las-pdrf-matrix/houston_c1_pdrf4_las13.las |
| `las.v14` | LAS 1.4 | variant | 32 | 3 | 7 | yes | rs-lidar-las-laz-copc/simple.copc.laz; rs-lidar-las-laz-copc/test1_4.las; rs-lidar-las-laz-copc/autzen_trim_7.las |
| `las.pdrf0` | LAS PDRF 0 | variant | 6 | 3 | 1 | yes | lidar-las-version-matrix/pdal/permutations/1.0_0.las; lidar-las-version-matrix/pdal/permutations/1.1_0.las; lidar-las-version-matrix/pdal/permutations/1.2_0.las |
| `las.pdrf1` | LAS PDRF 1 | variant | 19 | 3 | 3 | yes | lidar-3dep-co-soplatte-2013-2x2/USGS_LPC_South_Platte_River_Flood_LiDAR_13SDE474416.laz; lidar-3dep-co-soplatte-2013-2x2/USGS_LPC_South_Platte_River_Flood_LiDAR_13SDE474417.laz; lidar-3dep-co-soplatte-2013-2x2/USGS_LPC_South_Platte_River_Flood_LiDAR_13SDE475416.laz |
| `las.pdrf2` | LAS PDRF 2 | variant | 4 | 3 | 3 | yes | derived-las-pdrf-matrix/autzen_pdrf2_las12.las; derived-las-pdrf-matrix/houston_c1_pdrf2_las12.las; lidar-las-version-matrix/pdal/permutations/1.2_2.las |
| `las.pdrf3` | LAS PDRF 3 | variant | 8 | 3 | 2 | yes | rs-lidar-las-laz-copc/autzen_trim.las; rs-lidar-las-laz-copc/autzen_trim.laz; lidar-las-version-matrix/pdal/permutations/1.2_3.las |
| `las.pdrf4` | LAS PDRF 4 | variant | 3 | 3 | 2 | yes | derived-las-pdrf-matrix/autzen_pdrf4_las13.las; derived-las-pdrf-matrix/houston_c1_pdrf4_las13.las; lidar-las-version-matrix/laspy/simple1_3.las |
| `las.pdrf5` | LAS PDRF 5 | variant | 3 | 3 | 2 | yes | derived-las-pdrf-matrix/autzen_pdrf5_las13.las; derived-las-pdrf-matrix/houston_c1_pdrf5_las13.las; derived-las-pdrf-5-9/autzen_pdrf5_las13.las |
| `las.pdrf6` | LAS PDRF 6 | variant | 15 | 3 | 4 | yes | rs-lidar-las-laz-copc/test1_4.las; lidar-3dep-co-drcog-2020-2x2/USGS_LPC_CO_DRCOG_2020_B20_w0474n4416.laz; lidar-3dep-co-drcog-2020-2x2/USGS_LPC_CO_DRCOG_2020_B20_w0474n4417.laz |
| `las.pdrf7` | LAS PDRF 7 | variant | 5 | 3 | 3 | yes | rs-lidar-las-laz-copc/simple.copc.laz; rs-lidar-las-laz-copc/autzen_trim_7.las; rs-lidar-las-laz-copc/ellipsoid.copc.laz |
| `las.pdrf8` | LAS PDRF 8 | variant | 3 | 3 | 2 | yes | derived-las-pdrf-matrix/autzen_pdrf8_las14.las; derived-las-pdrf-matrix/houston_c1_pdrf8_las14.las; lidar-las-version-matrix/pdal/las_with_several_extra_byte_bloc.laz |
| `las.pdrf9` | LAS PDRF 9 | variant | 3 | 3 | 2 | yes | derived-las-pdrf-matrix/autzen_pdrf9_las14.las; derived-las-pdrf-matrix/houston_c1_pdrf9_las14.las; derived-las-pdrf-5-9/autzen_pdrf9_las14.las |
| `las.pdrf10` | LAS PDRF 10 | variant | 3 | 3 | 2 | yes | derived-las-pdrf-matrix/autzen_pdrf10_las14.las; derived-las-pdrf-matrix/houston_c1_pdrf10_las14.las; lidar-las-version-matrix/laspy/fullwave.laz |
| `pc.bpf` | BPF v3 | read | 14 | 3 | 1 | yes | lidar-bpf-pdal-v3/autzen-utm.bpf; lidar-bpf-pdal-v3/autzen-dd.bpf; lidar-bpf-pdal-v3/autzen-utm-chipped-25.bpf |
| `pc.ascii` | ASCII point cloud | read | 40 | 3 | 4 | yes | derived-pc-ascii/autzen.xyz; derived-pc-ascii/autzen.pts; derived-pc-ascii/test1_4.xyz |
| `vec.geojson` | GeoJSON | read | 158 | 3 | 12 | yes | rs-msi-spacenet2-wv3/SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson; rs-vector-fx12-synthetic/fx12.geojson; derived-vector-variants/nhd_waterbody_epsg4269.geojson |
| `vec.geojson.jsonext` | GeoJSON with .json extension | variant | 11 | 3 | 4 | yes | derived-vector-variants/ne_places.json; derived-vector-variants/ne_rivers.json; derived-vector-variants/nhd_flowline_sample.json |
| `vec.geojson.legacycrs` | GeoJSON legacy crs member | variant | 114 | 3 | 6 | yes | rs-msi-spacenet2-wv3/SN2_buildings_train_AOI_2_Vegas_geojson_buildings_img10.geojson; derived-vector-variants/nhd_waterbody_epsg4269.geojson; derived-vector-variants/ne_countries_epsg3857.geojson |
| `vec.shp` | Shapefile | read | 243 | 3 | 13 | yes | rs-vector-fx12-synthetic/fx12_shapefiles.zip; rs-vector-naturalearth-110m/ne_110m_admin_0_countries.zip; derived-vector-variants/nhd_nhdflowline_z.shp |
| `vec.shp.zip` | Zipped shapefile | variant | 34 | 3 | 6 | yes | rs-vector-fx12-synthetic/fx12_shapefiles.zip; rs-vector-naturalearth-110m/ne_110m_admin_0_countries.zip; lidar-opentopo-co23-roumelis/CO23_Roumelis_TileIndex.zip |
| `vec.shp.z` | Shapefile Z | variant | 13 | 3 | 5 | yes | derived-vector-variants/nhd_nhdflowline_z.shp; derived-vector-variants/nhd_nhdline_z.shp; derived-vector-variants/nhd_nhdarea_z.shp |
| `vec.shp.m` | Shapefile M | variant | 6 | 3 | 2 | yes | derived-vector-variants/nhd_nhdflowline_m.shp; derived-vector-variants/nhd_nhdline_m.shp; derived-vector-variants/nhd_nhdarea_m.shp |
| `vec.shp.multipatch` | Shapefile MultiPatch (skipped) | variant | 1 | 1 | 1 | yes | vector-shp-zm-gdal-autotest/shp/multipatch.shp |
| `vec.shp.cpg` | Shapefile with .cpg | variant | 17 | 3 | 5 | yes | derived-vector-variants/nhd_nhdflowline_z.shp; derived-vector-variants/nhd_nhdline_z.shp; derived-vector-variants/nhd_nhdarea_z.shp |
| `vec.kml` | KML | read | 18 | 3 | 6 | yes | rs-kml-iceye-footprint/ICEYE_U09WX2_20251028T000519Z_6785560_X56_SLF_QLK.kml; rs-vector-fx12-synthetic/fx12.kml; nitf-mvs-wv3-buenos-aires/kml_polygons/MasterProvisional1.kml |
| `vec.kmz` | KMZ | read | 8 | 3 | 2 | yes | rs-vector-fx12-synthetic/fx12.kmz; vector-kml-kmz-test-set/libkml/balloon-image-rel.kmz; vector-kml-kmz-test-set/libkml/screenoverlay-continents.kmz |
| `vec.gml` | GML | read | 21 | 3 | 4 | yes | derived-vector-variants/ne_countries_gml2.gml; derived-vector-variants/ne_countries_gml3.gml; derived-vector-variants/ne_countries_gml32.gml |
| `vec.gpx` | GPX | read | 15 | 3 | 5 | yes | derived-vector-variants/bambi_DJI_20241021165448_0001_T_point0.gpx; derived-vector-variants/bambi_DJI_20241119101935_0003_T.gpx; derived-vector-variants/bambi_DJI_20240709090401_0001_T_point0.gpx |
| `vec.csv.wkt` | CSV with WKT | read | 4 | 3 | 2 | yes | derived-vector-variants/ne_rivers_wkt.csv; vector-gpx-csv-wkt-gdal/csv/wkt.csv; vector-gpx-csv-wkt-gdal/csv/curves_line.csv |
| `vec.csv.lonlat` | CSV lon/lat | read | 24 | 3 | 9 | yes | derived-pc-ascii/autzen.csv; derived-pc-ascii/test1_4.csv; derived-pc-ascii/houston_c1.csv |
| `det.csv` | Detections CSV (class + confidence) | read | 4 | 3 | 2 | yes | derived-vector-variants/spacenet_vegas_img10_detections.csv; derived-detections-csv/rareplanes_105_detections_latlon.csv; derived-detections-csv/rareplanes_108_detections_xyxy.csv |
| `refused.geoparquet` | GeoParquet (read refused) | refused | 17 | 3 | 3 | yes | derived-vector-variants/ne_countries.parquet; derived-vector-variants/ne_places.parquet; derived-vector-variants/nhd_flowline.parquet |
| `refused.flatgeobuf` | FlatGeobuf (no reader) | refused | 16 | 3 | 3 | yes | derived-vector-variants/ne_countries.fgb; derived-vector-variants/ne_places.fgb; derived-vector-variants/nhd_flowline.fgb |
| `refused.mbtiles` | MBTiles | refused | 24 | 3 | 4 | yes | derived-pmtiles-raster/naip_png.mbtiles; derived-pmtiles-raster/naip_jpeg.mbtiles; derived-pmtiles-raster/naip_webp.mbtiles |
| `pmtiles.png` | PMTiles raster PNG | read | 8 | 3 | 5 | yes | derived-pmtiles-raster/naip_png.pmtiles; derived-pmtiles-raster/s2tci_png.pmtiles; derived-pmtiles-raster/cop_hillshade_png.pmtiles |
| `pmtiles.jpeg` | PMTiles raster JPEG | read | 5 | 3 | 2 | yes | derived-pmtiles-raster/naip_jpeg.pmtiles; derived-pmtiles-raster/s2tci_jpeg.pmtiles; derived-pmtiles-raster/cop_hillshade_jpeg.pmtiles |
| `pmtiles.webp` | PMTiles raster WebP | read | 6 | 3 | 4 | yes | derived-pmtiles-raster/naip_webp.pmtiles; derived-pmtiles-raster/s2tci_webp.pmtiles; derived-pmtiles-raster/cop_hillshade_webp.pmtiles |
| `pmtiles.mvt` | PMTiles vector (refused) | refused | 8 | 3 | 3 | yes | vector-pmtiles-mvt-protomaps/protomaps_vector_ODbL_firenze.pmtiles; vector-pmtiles-mvt-protomaps/test_fixture_1.pmtiles; vector-pmtiles-mvt-protomaps/test_fixture_2.pmtiles |
| `gltf` | glTF 2.0 / GLB | read | 89 | 3 | 7 | yes | 3d-gltf-draco-khronos/CesiumMilkTruck/glTF-Draco/CesiumMilkTruck.gltf; 3d-gltf-draco-khronos/Duck/glTF-Draco/Duck.gltf; 3d-gltf-draco-khronos/VirtualCity/glTF-Draco/VirtualCity.gltf |
| `gltf.draco` | glTF Draco (no loader) | refused | 4 | 3 | 2 | yes | 3d-gltf-draco-khronos/CesiumMilkTruck/glTF-Draco/CesiumMilkTruck.gltf; 3d-gltf-draco-khronos/Duck/glTF-Draco/Duck.gltf; 3d-gltf-draco-khronos/VirtualCity/glTF-Draco/VirtualCity.gltf |
| `gltf.ktx2` | glTF KTX2 (no loader) | refused | 5 | 3 | 2 | yes | 3d-gltf-khronos-ktx2/AnisotropyBarnLamp/glTF-KTX-BasisU/AnisotropyBarnLamp.gltf; 3d-gltf-khronos-ktx2/ChronographWatch/glTF-KTX-BasisU/ChronographWatch.gltf; 3d-gltf-khronos-ktx2/StainedGlassLamp/glTF-KTX-BasisU/StainedGlassLamp.gltf |
| `gltf.meshopt` | glTF meshopt (EXT/KHR_meshopt_compression, three.js MeshoptDecoder) | variant | 5 | 3 | 2 | yes | 3d-gltf-khronos-meshopt/BrainStem/glTF-Meshopt-EXT/BrainStem.gltf; 3d-gltf-khronos-meshopt/DragonAttenuation/glTF-Meshopt-EXT/DragonAttenuation.gltf; 3d-gltf-khronos-meshopt/MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf |
| `tiles3d.tileset` | 3D Tiles tileset.json | read | 18 | 3 | 4 | yes | 3d-tiles-implicit-octree-metadata/SparseImplicitOctree/tileset.json; 3d-tiles-implicit-octree-metadata/ImplicitTileMetadata/tileset_1.1.json; 3d-tiles-samples-i3dm-pnts/TilesetWithTreeBillboards/tileset.json |
| `tiles3d.b3dm` | 3D Tiles b3dm | variant | 12 | 3 | 3 | yes | 3d-tiles-implicit-octree-metadata/ImplicitTileMetadata/content/0/0/0.b3dm; 3d-tiles-implicit-octree-metadata/ImplicitTileMetadata/content/1/0/0.b3dm; 3d-tiles-implicit-octree-metadata/ImplicitTileMetadata/content/1/0/1.b3dm |
| `tiles3d.3tz` | 3D Tiles .3tz archive | read | 11 | 3 | 2 | yes | derived-3d-tiles-3tz/TilesetWithDiscreteLOD.3tz; derived-3d-tiles-3tz/MultipleContents.3tz; derived-3d-tiles-3tz/DuckGlb.3tz |
| `tiles3d.implicit` | 3D Tiles implicit (unsupported) | refused | 3 | 3 | 2 | yes | 3d-tiles-implicit-octree-metadata/SparseImplicitOctree/tileset.json; 3d-tiles-implicit-octree-metadata/ImplicitTileMetadata/tileset_1.1.json; 3d-tiles-sparse-implicit-quadtree/SparseImplicitQuadtree/tileset.json |
| `tiles3d.i3dm` | 3D Tiles i3dm (unsupported) | refused | 9 | 3 | 3 | yes | 3d-tiles-samples-i3dm-pnts/TilesetWithTreeBillboards/tree.i3dm; 3d-tiles-samples-i3dm-pnts/TilesetWithTreeBillboards/tree_billboard.i3dm; 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/Instanced/InstancedOrientation/instancedOrientation.i3dm |
| `tiles3d.pnts` | 3D Tiles pnts (unsupported) | refused | 10 | 3 | 4 | yes | 3d-tiles-samples-i3dm-pnts/TilesetWithRequestVolume/points.pnts; 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/PointCloud/PointCloudRGB/pointCloudRGB.pnts; 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/PointCloud/PointCloudDraco/pointCloudDraco.pnts |
| `tiles3d.cmpt` | 3D Tiles cmpt (unsupported) | refused | 5 | 3 | 2 | yes | 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/Composite/Composite/composite.cmpt; 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/Composite/CompositeOfComposite/compositeOfComposite.cmpt; 3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt/Composite/CompositeOfInstanced/compositeOfInstanced.cmpt |
| `cityjson` | CityJSON (export oracle) | write-oracle | 3 | 3 | 1 | yes | 3d-cityjson-samples/cityjson/delft.json; 3d-cityjson-samples/cityjson/DH_01_subs.city.json; 3d-cityjson-samples/cityjson/multi_lod.json |
| `fmv.ts` | MPEG-TS | read | 48 | 3 | 10 | yes | rs-mpegts-klv-synthetic/fx10_synthetic_klv.ts; derived-fmv-variants/truck_hevc_klv.ts; derived-fmv-variants/truck_mpeg2_klv.ts |
| `fmv.klv` | MPEG-TS with KLV | variant | 26 | 3 | 9 | yes | rs-mpegts-klv-synthetic/fx10_synthetic_klv.ts; derived-fmv-variants/truck_hevc_klv.ts; derived-fmv-variants/truck_mpeg2_klv.ts |
| `fmv.codec.h264` | H.264 video | variant | 45 | 3 | 10 | yes | rs-mpegts-klv-synthetic/fx10_synthetic_klv.ts; derived-fmv-variants/truck_h264_klv.m2ts; derived-fmv-variants/truck_h264_klv.mts |
| `fmv.codec.hevc` | H.265 video | variant | 3 | 3 | 1 | yes | derived-fmv-variants/truck_hevc_klv.ts; derived-fmv-variants/dayflight_hevc_klv.ts; derived-fmv-variants/nightir_hevc_klv.ts |
| `fmv.codec.mpeg2video` | MPEG-2 video (indexed, not played) | variant | 4 | 3 | 2 | yes | derived-fmv-variants/truck_mpeg2_klv.ts; derived-fmv-variants/dayflight_mpeg2_klv.ts; derived-fmv-variants/nightir_mpeg2_klv.ts |
| `fmv.klv.raw` | Raw KLV packets | support | 9 | 3 | 3 | yes | fmv-jmisb-st0903-vector/jmisb/0903.bin; fmv-klvdata-st0601-packets/klvdata/DynamicConstantMISMMSPacketData.bin; fmv-klvdata-st0601-packets/klvdata/DynamicOnlyMISMMSPacketData.bin |
| `fmv.vmti` | ST 0903 VMTI in ST 0601 KLV (Item 74) | variant | 4 | 3 | 2 | yes | derived-vmti-video/truck_vmti.ts; derived-vmti-video/cheyenne_vmti.ts; derived-vmti-video/osh_sample_vmti.ts |
| `fmv.platformcsv` | FMV platform telemetry CSV | read | 7 | 3 | 2 | yes | fmv-esri-multiplexer-tutorial/FMV_Multiplexer_Tutorial/Raw_Metadata.csv; fmv-bambi-flights/derived/flight_258/DJI_20241021165448_0001_T_point0.csv; fmv-bambi-flights/derived/flight_258/DJI_20241021165448_0001_V_point0.csv |
| `gmti.4607` | STANAG 4607 GMTI | read | 12 | 3 | 3 | yes | derived-gmti-tracks-ais/la_longbeach_ais_20230601.4607; derived-gmti-tracks-ais/sf_bay_ais_20230601.4607; derived-gmti-tracks-ais/houston_galveston_ais_20230601.4607 |
| `tracks.4676` | STANAG 4676 tracks | read | 6 | 3 | 1 | yes | derived-gmti-tracks-ais/la_longbeach_ais_20230601_schema.4676.xml; derived-gmti-tracks-ais/la_longbeach_ais_20230601_simple.4676.xml; derived-gmti-tracks-ais/sf_bay_ais_20230601_schema.4676.xml |
| `control.gcp` | GCP / control CSV | read | 3 | 3 | 1 | yes | derived-control-points/usgs_drcog2020_lidar_checkpoints.csv; derived-control-points/ngs_golden_co_control.csv; derived-control-points/ngs_las_vegas_control.csv |
| `app.project` | GIS Workbench project .gwb | read | 3 | 3 | 1 | yes | derived-app-artifacts/naip_vegas_buildings.gwb; derived-app-artifacts/umbra_sicd_chip.gwb; derived-app-artifacts/colorado_dem_dted2.gwb |
| `app.pack` | Data pack .gwpack | read | 4 | 3 | 1 | yes | derived-app-artifacts/proj-0.1.0.gwpack; derived-app-artifacts/hdf5-0.10.3.gwpack; derived-app-artifacts/geoid-2008.5min.gwpack |
| `app.recipe` | Recipe .gwrecipe.json | read | 4 | 3 | 1 | yes | derived-app-artifacts/airfield-triage.gwrecipe.json; derived-app-artifacts/damage-triage.gwrecipe.json; derived-app-artifacts/folder-to-cog.gwrecipe.json |
| `app.template` | Template .gwt.json | read | 3 | 3 | 1 | yes | derived-app-artifacts/template_sheet.gwt.json; derived-app-artifacts/template_slide.gwt.json; derived-app-artifacts/template_chip.gwt.json |
| `app.pptx-template` | PPTX/POTX template | read | 4 | 3 | 1 | yes | derived-pptx-templates/widescreen_16x9.pptx; derived-pptx-templates/standard_4x3.pptx; derived-pptx-templates/branded_navy_16x9.pptx |

## Function data roles

| Area | Commands | Need | Have | OK |
|---|---|---|---|---|
| ingest | file.openimage, file.opendem, file.openvector, file.openpointcloud, file.opengpkg, fmv.open, det.import | `fmt:*` every read/refused format key in formats.json at its minimum | 174/179 formats | **no** |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:wmts` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:wms` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:xyz` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:arcgis-rest` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:featureservice` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:wfs-t` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:copc-http` | service item | yes |
| ingest | file.openurl, pc.stream, cat.panel, online.add, bm.basemap, vec.remoteopen, vec.remotesave | `service:ept` | service item | yes |
| ingest | bm.pmtiles | `fmt:pmtiles.png` | 8/3 | yes |
| ingest | bm.pmtiles | `fmt:pmtiles.jpeg` | 5/3 | yes |
| ingest | bm.pmtiles | `fmt:pmtiles.webp` | 6/3 | yes |
| ingest | bm.pmtiles | `fmt:pmtiles.mvt` refused (vector PMTiles) | 8/3 | yes |
| ingest | cnv.cog, cnv.open | `pair:perf-large` ≥20 GB raster for the streaming COG case | 4/1 (nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, perf-large-lroc-nac-south-pole-cog, perf-large-co-3dep-1m-drcog-derived) | yes |
| ingest | packs.manage, pack.load, file.openproject, file.save, tpl.apply, report.template | `fmt:app.project` | 3/3 | yes |
| ingest | packs.manage, pack.load, file.openproject, file.save, tpl.apply, report.template | `fmt:app.pack` | 4/3 | yes |
| ingest | packs.manage, pack.load, file.openproject, file.save, tpl.apply, report.template | `fmt:app.recipe` | 4/3 | yes |
| ingest | packs.manage, pack.load, file.openproject, file.save, tpl.apply, report.template | `fmt:app.template` | 3/3 | yes |
| ingest | packs.manage, pack.load, file.openproject, file.save, tpl.apply, report.template | `fmt:app.pptx-template` | 4/3 | yes |
| view | rot.shadows, deco.sun, deco.sensor | `fmt:tre.USE00A` | 19/3 | yes |
| view | rot.shadows, deco.sun, deco.sensor | `fmt:dg.imd` | 21/3 | yes |
| view | rot.shadows, deco.sun, deco.sensor | `fmt:dimap.v2` | 5/3 | yes |
| view | enh.pansharpen | `pair:pan-ms` | 4/3 (nitf-core3d-jacksonville-wv3, eo-maxar-libya-floods-wv3-prepost, eo-spacenet-vegas-wv3-pan-ms-r1c1, landsat8-c1-l1tp-044034-20210508) | yes |
| view | img.orthofly, img.projection, ortho.rectify, ortho.mosaic, ortho.seam, ortho.balance | `pair:dem-under` DEM under RPC/SICD imagery | 26/6 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| view | img.orthofly, img.projection, ortho.rectify, ortho.mosaic, ortho.seam, ortho.balance | `pair:checkpoints` | 4/2 (derived-control-points, control-ngs-co-golden-x48y441, control-usgs-3dep-co-drcog2020-checkpoints, control-ngs-vegas) | yes |
| view | cmp.porthole, cmp.swiper, cmp.blend, chg.detect, chg.confirm, msi.change | `pair:pre-post` | 6/3 (landsat7-c2-l2sp-044034-20210617-slcoff, s2-l2a-cog-10seh-20250123, eo-maxar-turkey-eq-islahiye-prepost, change-spacenet7-train-sample, …) | yes |
| view | cmp.porthole, cmp.swiper, cmp.blend, chg.detect, chg.confirm, msi.change | `pair:change-truth` | 2/1 (change-maxar-turkey-eq-building-change, change-spacenet7-train-sample) | yes |
| measure | men.point, men.tracking, model.error, men.depth, men.target, men.targettable | `pair:dem-under` | 26/3 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| measure | men.point, men.tracking, model.error, men.depth, men.target, men.targettable | `pair:checkpoints` | 4/2 (derived-control-points, control-ngs-co-golden-x48y441, control-usgs-3dep-co-drcog2020-checkpoints, control-ngs-vegas) | yes |
| measure | men.height | `pair:height-truth` imagery with sun angles and lidar/DSM heights | 2/1 (nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3) | yes |
| measure | geo.datum | `pair:datum-grid` | 3/3 (support-proj-grids-geoid, support-proj-grids-hshift, support-proj-grids-vertcon) | yes |
| sensor | model.active, model.info | `fmt:rpc.nitf` | 20/3 | yes |
| sensor | model.active, model.info | `fmt:rpc.gtiff` | 19/3 | yes |
| sensor | model.active, model.info | `fmt:dg.rpb` | 21/3 | yes |
| sensor | model.active, model.info | `fmt:sensor.rsm` | 4/3 | yes |
| sensor | model.active, model.info | `fmt:sar.sicd` | 30/3 | yes |
| sensor | model.gcp, align.poly, align.quick, align.glove, tools.loadpoints | `pair:gcp` | 3/3 (derived-control-points, frames-odm-bellus-gcp, frames-odm-copr-gcp) | yes |
| sensor | align.auto, align.ai | `pair:co-register` | 6/3 (sar-umbra-stack-silver-peak, hsi-avirisng-cuprite-20200712-rfl, geopdf-htmc-honker-bay-bouldin-island, eo-maxar-libya-floods-wv3-prepost, …) | yes |
| sensor | tri.mip, tri.tiepoints, tri.adjust, tri.solutions | `pair:stereo-mate` ≥3 overlapping RPC images | 6/3 (rs-nitf-wv3-mvs-stereo-chips, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29, …) | yes |
| sensor | tri.mip, tri.tiepoints, tri.adjust, tri.solutions | `pair:gcp` | 3/2 (derived-control-points, frames-odm-bellus-gcp, frames-odm-copr-gcp) | yes |
| sensor | tri.mip, tri.tiepoints, tri.adjust, tri.solutions | `pair:checkpoints` | 4/2 (derived-control-points, control-ngs-co-golden-x48y441, control-usgs-3dep-co-drcog2020-checkpoints, control-ngs-vegas) | yes |
| sensor | tri.frame | `pair:calibration` frame stills + camera calibration + GPS/IMU | 4/2 (s2-l2a-mtd-10seh-pc, frames-odm-bellus-gcp, frames-odm-aukerman, frames-odm-seneca) | yes |
| sensor | ortho.true | `pair:dsm-truth` | 5/2 (nitf-mvs-wv3-buenos-aires, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, dem-us3d-jacksonville-lidar-tierb, …) | yes |
| stereo | stereo.open, stereo.manager, stereo.finder, stereo.metrics, stereo.align, stereo.epipolar, stereo.snap, stereo.track | `pair:stereo-mate` | 6/4 (rs-nitf-wv3-mvs-stereo-chips, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29, …) | yes |
| stereo | stereo.open, stereo.manager, stereo.finder, stereo.metrics, stereo.align, stereo.epipolar, stereo.snap, stereo.track | `pair:dem-under` | 26/2 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| terrain | dem.select, dem.folder, dem.useterrain | `fmt:dted.l0` | 7/3 | yes |
| terrain | dem.select, dem.folder, dem.useterrain | `fmt:dted.l1` | 5/3 | yes |
| terrain | dem.select, dem.folder, dem.useterrain | `fmt:dted.l2` | 3/3 | yes |
| terrain | dem.select, dem.folder, dem.useterrain | `fmt:hgt` | 6/3 | yes |
| terrain | dem.extract | `pair:dsm-truth` | 5/2 (nitf-mvs-wv3-buenos-aires, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, dem-us3d-jacksonville-lidar-tierb, …) | yes |
| terrain | dem.extract | `pair:stereo-mate` | 6/2 (rs-nitf-wv3-mvs-stereo-chips, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, eo-spacenet-atlanta-wv2-l1b-nadir10-nadir29, …) | yes |
| terrain | dem.diff, dem.volume | `pair:dem-epoch` | 2/2 (cop-dem-glo30-n39w106, usgs-3dep-13-n40w106) | yes |
| terrain | dem.accuracy | `pair:checkpoints` ≥30 surveyed checkpoints (ASPRS 2023) | 4/1 (derived-control-points, control-ngs-co-golden-x48y441, control-usgs-3dep-co-drcog2020-checkpoints, control-ngs-vegas) | yes |
| terrain | los.hlz, dem.groundfilter | `pair:dsm-truth` | 5/1 (nitf-mvs-wv3-buenos-aires, nitf-mvs-wv3-buenos-aires, nitf-core3d-jacksonville-wv3, dem-us3d-jacksonville-lidar-tierb, …) | yes |
| terrain | 3d.qmesh | `fmt:qmesh.geodetic` | 6/3 | yes |
| sar | sar.acd, sar.ccd, sar.pairs | `pair:repeat-pass` coherent short-baseline pairs | 1/2 (sar-umbra-stack-silver-peak) | **no** |
| sar | sar.pauli | `fmt:sar.sicd.quadpol` | 4/3 | yes |
| msi | msi.radiometric, msi.thermal | `fmt:meta.landsat-mtl` | 6/3 | yes |
| msi | msi.radiometric, msi.thermal | `fmt:meta.s2-mtd` | 3/3 | yes |
| msi | msi.radiometric, msi.thermal | `fmt:dg.imd` | 21/3 | yes |
| msi | msi.cluster, msi.threshold, msi.accuracy, msi.majority | `pair:labels-raster` | 4/3 (rs-hsi-indian-pines, nitf-core3d-jacksonville-wv3, enmap-potsdam-l2a-subset, ieee-dfc2018-houston) | yes |
| msi | msi.detect, msi.library, profile.spectral | `fmt:speclib.envi-sli` | 13/3 | yes |
| msi | msi.detect, msi.library, profile.spectral | `pair:spectral-lib` | 6/2 (derived-speclib-envi-sli, hsi-avirisng-cuprite-20200712-rfl, hsi-speclib-splib07b-envi-hyperspectralpy, hsi-speclib-splib06-envi-emit-sds, …) | yes |
| msi | msi.destripe | `pair:striped` | 1/1 (landsat7-c2-l2sp-044034-20210617-slcoff) | yes |
| lidar | pc.colourise | `pair:imagery-over` | 6/2 (geopdf-htmc-honker-bay-bouldin-island, naip-co-golden-x48y441-2023, naip-co-drcog-lidar-2023, naip-co-roumelis-2023, …) | yes |
| lidar | pc.dod | `pair:lidar-epoch` | 2/1 (lidar-3dep-co-soplatte-2013-2x2, lidar-3dep-co-denver-2008-2x1) | yes |
| lidar | pc.dsm, pc.dtm, pc.groundfilter | `pair:dem-under` | 26/1 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| fmv | fmv.capture, fmv.link, fmv.measure | `pair:dem-under` DEM under KLV flights | 26/2 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| fmv | fmv.vmti | `pair:vmti-video` | 1/1 (derived-vmti-video) | yes |
| fmv | fmv.gmti, fmv.gmticolour | `fmt:gmti.4607` | 12/3 | yes |
| fmv | fmv.gmti, fmv.gmticolour | `fmt:tracks.4676` | 6/3 | yes |
| fmv | mie.play, mie.next, mie.prev | `fmt:nitf.mie4nitf` | 3/3 | yes |
| vector | ext.droptoground, ext.fromdsm, ext.texture, ext.export3d, hub.glb, hub.usdz, 3d.open | `pair:dem-under` | 26/2 (rs-dem-derived-s35w059, derived-nitf-rsm, dem-under-vegas, dem-under-atlanta, …) | yes |
| vector | ext.droptoground, ext.fromdsm, ext.texture, ext.export3d, hub.glb, hub.usdz, 3d.open | `pair:imagery-over` | 6/1 (geopdf-htmc-honker-bay-bouldin-island, naip-co-golden-x48y441-2023, naip-co-drcog-lidar-2023, naip-co-roumelis-2023, …) | yes |
| ai | lai.find, lai.search, det.review, triage.flag, obs.table | `pair:labels-detect` | 4/2 (derived-detections-csv, vector-rareplanes-real-test-105, vector-rareplanes-real-test-108, eo-spacenet-vegas-wv3-pan-ms-r1c1) | yes |
| products | meta.marking, meta.redact | `pair:security-marked` | 1/1 (derived-nitf-variants) | yes |

## Census keys not in formats.json

`dimap` (5), `dted.dhm` (1), `dted.hdr1` (3), `envi.data` (11), `envi.wavelengths` (5), `fmv.codec.mjpeg` (6), `georef.none` (20), `gltf.glb` (75), `gltf.gltf` (14), `gpkg` (34), `gpkg.attributes` (10), `gpkg.corrupt` (1), `gpkg.gpkg_extensions` (1), `gtiff.codec.lerc_deflate` (1), `gtiff.codec.lerc_zstd` (1), `gtiff.unreadable` (1), `hgt.gz` (3), `hgt.size25934402` (2), `hgt.size2884802` (1), `img.bmp` (8), `img.gif` (3), `img.webp` (3), `nitf.ic.m4` (4), `pdf.layers` (4), `pmtiles` (28), `pmtiles.avif` (1), `qmesh.layer` (9), `qmesh.mercator` (4), `robustness.seed` (37), `sar.sicd.v1.0.0` (1), `sar.sicd.v1.0.1` (1), `sar.sicd.v1.2.0` (1), `sar.sidd.v1.0.0` (2), `speclib.envi-sli.data` (11), `tiles3d.subtree` (22), `vec.gml.v32` (15), `vec.gpkg.zip` (4), `vec.shp.2d` (189)

## TREs present

BANDSB (8), BLOCKA (2), CSCCGA (15), CSCRNA (19), CSDIDA (19), CSEPHA (16), CSEXRA (19), CSPROA (16), CSSFAA (16), HISTOA (19), ICHIPB (3), IOMAPA (4), IXTAGA (3), IXTAGB (3), IXTAGC (3), IXTAGC_2 (3), IXTAGD (3), IXTAGE (3), IXTAGF (3), IXTAGG (3), IXTAGH (3), IXTAGI (3), IXTAGI_2 (3), IXTAGI_3 (3), IXTAGJ (3), IXTAGK (3), IXTAGL (3), J2KLRA (17), MTIMSA (3), NBLOCA (3), PIAIMC (19), RPC00B (20), RPFDES (1), RPFHDR (8), RPFIMG (8), RSMIDA (4), RSMPCA (4), SENSRB (1), STDIDC (19), USE00A (19), XBLOCA (1)

