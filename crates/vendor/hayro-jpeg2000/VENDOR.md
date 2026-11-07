# Vendored hayro-jpeg2000 0.4.1 (+gw.1)

Upstream: https://github.com/LaurenzV/hayro, crate `hayro-jpeg2000` 0.4.1 (Apache-2.0 OR MIT,
licence files kept). Vendored to add HTJ2K (ITU-T T.814 / ISO/IEC 15444-15) code-block decoding
for REQ-FMT-17. Every change is marked `GW HTJ2K` (or `GW MSI`) in the sources:

| File | Change |
|---|---|
| `src/j2c/codestream.rs` | `CodeBlockStyle` reads SPcod bit 6 (HT) and bit 7 (mixed); CAP, PRF and CPF markers are skipped in the main header; mixed HT / Part 1 codestreams are refused. |
| `src/j2c/segment.rs` | HT packet headers (T.814 B.10.7): one cleanup codeword segment (with any placeholder HT sets, each adding a missing MSB) and one SigProp + MagRef segment; a second HT set in a later layer is refused. |
| `src/j2c/decode.rs` | `decode_ht_code_block`: HT code-blocks through `ndic-htj2k::decode_block` (a port of OpenJPH's 32-bit block decoder), dequantised into hayro's coefficient buffer; the rest of hayro's pipeline (IDWT, MCT, resolution reduction, tiles, JP2) is unchanged. |
| `src/lib.rs`, `Cargo.toml` | The `image` integration (and its `image`/`moxcms` dependencies) is dropped; `ndic-htj2k` =0.2.5 added. |
| `src/j2c/codestream.rs`, `tile.rs`, `progression.rs`, `decode.rs` (`GW POC`, 2.1 FC-16) | Progression order changes (POC, A.6.6) in the main and tile-part headers are decoded: `progression_change_order` emits each change's packets (its resolution, component and layer bounds, its order) once, skipping packets an earlier change sent; a tile-part POC replaces the main header's for that tile. 16-bit POC component indices for more than 256 components. |
| `codestream.rs`, `tile.rs`, `decode.rs`, `bitplane.rs` (`GW ROI`, 2.1 FC-16) | Region-of-interest maxshift (RGN, Annex H) in the main and tile-part headers: code-blocks are decoded with s more bit-planes and magnitudes of 2^s or more are scaled down by 2^s (it used to be skipped, so ROI codestreams decoded wrongly). |
| `src/lib.rs` (`GW POC`) | `ColorSpace::Unknown` counts up to 16 384 components (u16), as Part 1 allows (p0_13: 257). |
| `src/j2c/codestream.rs` (`GW LIMIT`, 2.1 fuzzing) | SIZ refuses more than 65 535 tiles (Isot is 16-bit, A.4.2) and more than 4 194 304 tile-components: a 2.5 KB mutation of p0_13 declaring 524 289 one-pixel tiles of 257 components took 201 s. |
| `src/lib.rs` (`GW MSI`) | A codestream with more than four components and no colour space (8-band WorldView-3 MS NITF) is decoded with `ColorSpace::Unknown` instead of failing with `TooManyChannels`. |

POC and ROI are checked by `crates/gw-codec/tests/poc.rs`: the ISO/IEC 15444-4 conformance codestreams p0_03, p0_13, p0_15 and GDAL's byte_one_poc.j2k equal OpenJPEG 2.5 (opj_decompress) sample for sample.

Checked by `crates/gw-codec/tests/htj2k.rs` against streams encoded by OpenJPH (C++):
lossless cases bit-exact, 9/7 within one count of OpenJPEG 2.5.4, reduced resolution equal to
OpenJPEG; the Part 1 sample checks (`tests/samples.rs`) are unchanged.

To update: diff upstream against this tree (search `GW HTJ2K`, `GW MSI`, `GW POC`, `GW ROI`, `GW LIMIT`), reapply, rerun the tests above.
