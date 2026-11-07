# GIS Workbench

A single-file, offline imagery analysis and photogrammetry workbench for civilian use that runs in Chrome or
Edge from `file://`, a web server or an embed.

## Build

```bash
npm ci
npm run build
```

Outputs in `dist/`: `gis-workbench.html` (the product), `gis-workbench-lite.html` (loader +
gzip payload for size-limited embeds), `embed/` (paste-ready snippets and instructions),
`THIRD-PARTY-NOTICES.txt`, `build-report.json` (sizes, gates, licences) and `SHA256SUMS`.

`npm run build` works from a plain clone with no environment variables. The world basemap comes from
`build/natural-earth/` (public domain, see its `SOURCE.txt`). `node build/packs.mjs --fetch` downloads the pinned
inputs of the data packs (their hashes are in `build/packs-sources.json`) into `.cache/packs-src` and gives the
full pack set: models, datum grids, fonts and the rest. The build works without it: it skips each pack whose
inputs are missing, with a warning, and the pack catalogue in the HTML lists only the packs that were built.
A few tests need the font inputs from that download and skip without them.

`npm run build:js` skips the Rust step and reuses the last WASM bundles. The Rust step needs
the toolchain in `crates/rust-toolchain.toml` with the `wasm32-unknown-unknown` target; it runs
`cargo deny` when installed and `wasm-opt` when binaryen is installed.

## Test

```bash
npm test
```

```bash
npm run test:e2e
```

```bash
npm run test:rust
```

- `tests/unit`, `tests/golden`: Vitest. Golden tests load the WASM bundles from the built file
  and compare them with independent JavaScript oracles.
- `tests/e2e`: Playwright on the built file in Chrome and Edge (platform tests PT-01..PT-12,
  the R1 scenarios SCN-01..04, 11, 16, 17, 19, 20, the R1 Musts, performance, samples
  regression, embed kit).
- `node tests/tools/serve.mjs` serves the folder above the repository on port 8765 for hands-on
  testing in a browser, with a `/__loader` page that hands fixtures to an open app tab.
- `crates`: Rust unit and sample tests; `cargo test --release -p gw-fuzz` runs the mutation
  fuzzer (`GW_FUZZ_ITERS` sets the iterations per parser).

Tests and fixture generators that need sample files read them from `../Research/samples/` (or `TE_CORPUS`) and skip when they are absent. The synthetic fixtures with truth are
generated into `fixtures/` (dev-only, never shipped):

```bash
node build/fixtures/fx01.mjs
```

`fx01.mjs` writes FX-01 (NITF, RPC00B, 50 truth points) and FX-05 (GeoTIFF and DTED L2 terrain);
`fx03.mjs` writes FX-03 (oblique image with heights and shadows), `fx06.mjs` the two-date pair
and `fx12.mjs` the vector set. `node tests/tools/perf-swiftshader.mjs` measures software
rendering.

## Layout

| Path | What |
|---|---|
| `app/src` | Application JavaScript: shell, panes, renderer, workers, features, AI, whiteboard |
| `crates` | Rust: `gw-geodesy`, `gw-sensor`, `gw-parse`, `gw-codec`, `gw-extract`, `gw-fuzz`, bundles `core`, `parse`, `j2k` |
| `build/fixtures` | Fixture generators FX-01, 03, 05, 06, 12 and the shared synthetic camera |
| `build` | Build, gates, tokens, data blocks, traceability |
| `CHANGELOG.md` | Changes per release; embedded in the build and shown by Help ▸ What's New |

## Licence

Apache License 2.0; see [LICENSE](LICENSE). Third-party components are permissively licensed (MIT,
Apache-2.0, BSD, ISC, Zlib); their notices ship in `dist/THIRD-PARTY-NOTICES.txt` and inside the
built file.

The licence does not cover the GIS Workbench name and logo; see [TRADEMARKS.md](TRADEMARKS.md).
