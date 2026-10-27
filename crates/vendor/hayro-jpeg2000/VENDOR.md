# Vendored hayro-jpeg2000 0.4.1 (+gw.1)

Upstream: https://github.com/LaurenzV/hayro, crate `hayro-jpeg2000` 0.4.1 (Apache-2.0 OR MIT,
licence files kept). Vendored to add HTJ2K (ITU-T T.814 / ISO/IEC 15444-15) code-block decoding
for REQ-FMT-17. Every change is marked `GW HTJ2K` in the sources:

| File | Change |
|---|---|
| `src/j2c/codestream.rs` | `CodeBlockStyle` reads SPcod bit 6 (HT) and bit 7 (mixed); CAP, PRF and CPF markers are skipped in the main header; mixed HT / Part 1 codestreams are refused. |
| `src/j2c/segment.rs` | HT packet headers (T.814 B.10.7): one cleanup codeword segment (with any placeholder HT sets, each adding a missing MSB) and one SigProp + MagRef segment; a second HT set in a later layer is refused. |
| `src/j2c/decode.rs` | `decode_ht_code_block`: HT code-blocks through `ndic-htj2k::decode_block` (a port of OpenJPH's 32-bit block decoder), dequantised into hayro's coefficient buffer; the rest of hayro's pipeline (IDWT, MCT, resolution reduction, tiles, JP2) is unchanged. |
| `src/lib.rs`, `Cargo.toml` | The `image` integration (and its `image`/`moxcms` dependencies) is dropped; `ndic-htj2k` =0.2.5 added. |

Checked by `crates/gw-codec/tests/htj2k.rs` against streams encoded by OpenJPH (C++):
lossless cases bit-exact, 9/7 within one count of OpenJPEG 2.5.4, reduced resolution equal to
OpenJPEG; the Part 1 sample checks (`tests/samples.rs`) are unchanged.

To update: diff upstream against this tree (search `GW HTJ2K`), reapply, rerun the tests above.
