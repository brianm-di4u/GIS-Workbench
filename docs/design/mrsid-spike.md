# MrSID decoding — spike report (phase F, 2026-10-27)

**Question (owner, campaign design):** can GIS Workbench open the field user's MrSID mosaics natively?
**Answer:** not by decoding the image. The container is readable; the wavelet codestream is not, within the product's licence policy and any reasonable effort. Recommendation and options are in **OD-10** ([TE-owner-decisions.md](../validation/TE-owner-decisions.md)).

## Data

| File | Size | Container | Image (from header) | Georeferencing carried |
|---|---|---|---|---|
| `Hamilton_2018_rgb_20x.sid` (OGRIP, public domain) | 10.7 GB | `msid` v3 (MG3) | 340,000 × 220,000 px, 3 × 8-bit | `.sdw` world file, FGDC XML, and in-container `IMAGE::WKT`, `IMAGE::XY_ORIGIN`, `IMAGE::X/Y_RESOLUTION`, GeoTIFF keys |
| `Stl_City.sid` (client delivery) | 2.6 GB | `msid` v3 (MG3, GeoExpress 9.1) | 98,304 × 188,416 px, 3 × 8-bit | `.sdw`, GDAL PAM `.aux.xml` (GeoTIFF keys only), and the same in-container keys |

The `.sdw` pixel size (0.5 ft) times the header size gives the county/city extents, which confirms the header reading.

## What was done (time-boxed, about half a day)

1. **Licence and policy gate.** No public MG2/MG3/MG4 codestream specification was found. Decoding in other software (GDAL's `MrSID` driver, QGIS, ArcGIS) goes through the Extensis/LizardTech decode SDK, distributed as native binaries under Extensis's own licence. Those binaries cannot run in the browser (no WebAssembly build) and a closed binary would breach the product's licence policy (REQ-SEC-08, REQ-RUST-11) and the single-file, offline delivery constraint. The early MrSID patents date from the mid-1990s and have most likely expired, but that has **not** been checked legally; it does not change the outcome, since there is no specification to implement.
2. **Container header (shipped, TE-061).** `app/src/workers/decode/mrsid-header.js` recognises the `msid` magic and reads, big-endian: version (byte 4), width (bytes 26–29), height (30–33), bands (36), bits per sample (40). A dropped `.sid` is now refused with the format, generation and image size and a conversion route, instead of "unrecognised data". `.sdw` world files are recognised as sidecars (TE-063).
3. **Metadata records.** The container also holds typed key/value records (`IMAGE::WIDTH`, `IMAGE::WKT`, `IMAGE::XY_ORIGIN`, `IMAGE::X_RESOLUTION`, `IMAGE::NO_DATA_VALUE`, `GEOTIFF_NUM::…` keys, `IMAGE::INPUT_NAME` listing the source tiles). Their layout was not decoded fully; they are enough, in principle, to place the image without any sidecar.
4. **Codestream.** Past the metadata, the file holds the MG3 wavelet codestream (multi-resolution, bit-plane coded, proprietary entropy coding). Reproducing it would mean reverse-engineering a codec from sample files with no reference decoder allowed in the toolchain and no oracle to check pixels against (the campaign's conda GDAL has no MrSID driver — harness note H-16). Estimate: several person-months with a high risk of never matching the vendor decoder; not recommended.

## Options for OD-10

| Option | What the user gets | Effort | Constraint impact |
|---|---|---|---|
| **(a) Keep the named refusal with a conversion recipe** (shipped) | Clear message with the image size and how to convert (`gdal_translate -of COG` with a MrSID-enabled GDAL, or Extensis GeoExpress) | done | none |
| **(b) Footprint and metadata layer** | The `.sid` opens as an outline at its true location with its metadata (size, CRS, resolution, source tiles), so it can be catalogued and overlaid; pixels still need conversion | ~2–3 days (decode the metadata records; `.sdw`/aux fallback) | none |
| (c) Clean-room codestream decoder | Native viewing | months, high risk | needs owner acceptance of the reverse-engineering and maintenance risk |
| (d) Vendor SDK | Native viewing | — | not possible in a single-file browser app (native binaries, licence) |

**Recommendation:** (a) now, (b) as a Should for the next release if users keep receiving MrSID deliveries; reject (c) and (d).

## Conversion recipe given to users

```
gdal_translate -of COG -co COMPRESS=JPEG -co QUALITY=90 Stl_City.sid Stl_City_cog.tif
```

This needs a GDAL build with the MrSID driver (on Windows, for example, OSGeo4W with its MrSID plugin package; check `gdalinfo --formats` lists `MrSID`). For a 10 GB county mosaic, add `-co BIGTIFF=YES` and expect tens of minutes; the resulting COG opens in GIS Workbench with internal overviews.

## Addendum (2026-11-01): decision and 2.1 route
The owner closed OD-10 on 2026-10-31 (product decision OD-2.9) after allowing an optional native helper (OD-11, product decisions OD-2.5..OD-2.8). The policy objection to option (d) in step 1 no longer holds for that helper: the browser bundle stays permissive-only, while the sidecar may carry closed vendor decode SDKs under their redistribution terms (OD-2.6). The Decode SDK's licence still forbids reverse engineering and encoding, so (c) stays rejected and no MrSID writer is planned.

| Part | 2.1 route | Requirement |
|---|---|---|
| Footprint and metadata (option b) | Native: the `msid` header plus the metadata records (`IMAGE::WKT`, `IMAGE::XY_ORIGIN`, resolutions, nodata, source tiles), with `.sdw`, `.aux.xml` and FGDC as fallbacks. Opens at once, with a "Convert with Sidecar" action | REQ-FMT-22 |
| Pixels | The optional sidecar runs GDAL with the MrSID plugin (`raster-cog` profile), writes a COG and serves it by range; the app opens it in place | REQ-FMT-23, REQ-SDC-07, REQ-SDC-08 |
| Oracle | H-17: a `gw-te-vendor` environment built from the sidecar's GDAL, plus the vendor `mrsiddecode` tool as an independent second decode path (H-16 stays true for the conda `gw-te` environment) | SDP-2.1 §7.2 |
| Open questions | S-44 (may the SDK be redistributed inside the helper, or must the installer download it from Extensis?), S-43 (packaging) | SDP-2.1 §8 |

The same route covers ECW (Hexagon's free read-only SDK; S-44 checks its desktop-redistribution terms). See `Docs/SDP-2.1-format-closure-plan.md` §2 (FC-01, FC-02) and design note DN-61.
