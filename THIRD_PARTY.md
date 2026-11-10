# Third-party content

The license allowlist and a record of everything borrowed. Changing this file needs the admin's approval.

## Allowed licenses

Code may be adapted or depended on only under these licenses:

MIT, BSD-2-Clause, BSD-3-Clause, ISC, Apache-2.0, Apache-2.0 WITH LLVM-exception, Unlicense, CC0-1.0, 0BSD, Zlib, MPL-2.0 (dependencies only, unmodified)

Anything else, including GPL, AGPL, unlicensed, or unclear code, is reference-only: read it for ideas, but never copy it or add it as a dependency without a legal decision.

`.pipeline/check-licenses.mjs` checks npm packages. `cargo deny` checks crates against `crates/deny.toml` and `sidecar/deny.toml`, and `build/gates.mjs` checks what's linked into a build. Notices for everything shipped are generated into `THIRD-PARTY-NOTICES.txt` at build time.

## Exceptions

These are in `licenseExceptions` in `pipeline.config.json`.

| Package | License | Why it's allowed |
|---|---|---|
| `h5wasm` | NIST public-service terms | Ships in the HDF5 pack. The notice is kept intact |
| `resource-tracker` | EPL-1.0 | Installed with `proj-wasm`. Not in anything shipped |
| `squint-cljs` | No license field | Installed with `proj-wasm`. Not in anything shipped |

The PROJ pack bundles only `proj-wasm`'s Emscripten build, so the last two never reach users.

## Handling samples

Downloaded sample code is untrusted data. Keep it outside the repo, don't run its install, build, or test scripts, and don't open it in a browser.

## Record

Third-party data sources are pinned with their licenses in `build/packs-sources.json`.

| Source | URL | License | Version or commit | Used for |
|---|---|---|---|---|
| Earth Gravitational Model 2008 (EGM2008), U.S. National Geospatial-Intelligence Agency (NGA) | https://earth-info.nga.mil/ | EGM2008 data: public, no restrictions; attribution below. GeographicLib packaging of the 5′ and 1′ grids: MIT (C. F. F. Karney) | 5′ grid from GeographicLib `egm2008-5`; 1′ grid from GeographicLib `egm2008-1` (SHA-256 `bdb382d0…`), cut into tiles with values unchanged; 2.5′ grid `us_nga_egm08_25` from PROJ-data | The `geoid`, `geoid-egm2008-1` and `geoid-egm2008-25` packs |

**EGM2008 attribution, as NGA gives it:** "The data and coefficients for Earth Gravitational Model 2008 (EGM2008), developed and released by the U.S. National Geospatial-Intelligence Agency (NGA), are publicly available with no special restrictions or limitations on their use."
