# GDAL metadata items on files the app writes

Products the app reads back as its own (so far the SAR stereo DSM) say what they are in
GDAL_METADATA (tag 42112), not in the ImageDescription. The description is prose for people, and the decoder keeps only its first 2,000
characters. `gdalMetadataXml` in `app/src/formats/geotiff-writer.js` writes the items. The decode
worker returns dataset-level items as `meta.gdalItems` and band names as `meta.bandsMeta`.

Items the app defines start with `GWB_`. Once a release has written them, they are a stored format:
add new names rather than renaming or reusing old ones.

| Item | Values | Written by | Read by |
|---|---|---|---|
| `GWB_PRODUCT` | `SAR_STEREO_DSM` | SAR stereo DSM and its levelled copies (`saveDsm`) | `dsmFileFacts` |
| `GWB_SAME_SIDE` | `1` same-side pair, `0` opposite-side; missing on a tagged product reads as `0` | SAR stereo DSM | `dsmFileFacts`: Level DSM refuses an opposite-side DSM |
| `GWB_PRIOR` | the prior DEM's name | any DSM `saveDsm` writes | `dsmFileFacts` |
| `GWB_LEVELLING` | a record of each levelling, `on <reference> by <offset> m…`, joined by `; ` (prose for people, not parsed) | a levelled DSM (`saveDsm`) | `dsmFileFacts`, carried and extended on re-levelling |

The SAR stereo DSM also names its bands `height`, `sigma`, `score` and `flags`.

Files that 2.6 wrote carry no items. `dsmFileFacts` reads them by their description, which 2.6 wrote
once and never extended. That fallback is for those files only.
