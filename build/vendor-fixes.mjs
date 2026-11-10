// Source fixes applied to third-party modules while bundling (esbuild onLoad). Each names the
// defect, the exact text it replaces and how many times; a dependency upgrade that changes the
// text fails the build, so every fix is re-checked against the new release instead of lapsing.

import { readFile } from 'node:fs/promises';

const FIXES = [
  {
    // TE-060: geotiff.js 3.0.5 DeferredArray reads lazily loaded tag arrays (TileOffsets,
    // TileByteCounts, … too large for the first header read) as little-endian whatever the file's
    // byte order, so big-endian ("MM") TIFFs with many tiles (DigitalGlobe/Maxar JPEG tile sets)
    // fetched every tile from a wrong offset: "SOI not found".
    file: /[\\/]geotiff[\\/]dist-module[\\/]imagefiledirectory\.js$/,
    find: /new DataSlice\(data\[0\], (this\.arrayOffset(?: \+ \(index \* this\.itemSize\))?), true, false\)/g,
    replace: 'new DataSlice(data[0], $1, this.littleEndian, false)',
    count: 2,
  },
  {
    // #32: flatgeobuf 4.6 works out a zstd.wasm URL from document.currentScript when the module
    // loads. Blocks run from blob: URLs, which cannot be a base, so `new URL` threw, js-fgb never
    // registered and Convert ▸ FlatGeobuf failed. The URL only serves seekable Zstandard reads,
    // which the app does not ask for (no `seekableZstd` option).
    file: /[\\/]flatgeobuf[\\/]lib[\\/]mjs[\\/]generic[\\/]featurecollection\.js$/,
    find: /const browserWasmUrl = \(\(\) => \{[\s\S]*?\n\}\)\(\);/g,
    replace: 'const browserWasmUrl = undefined;',
    count: 1,
  },
  {
    // #32: and the codec for those reads, @bokuweb/zstd-wasm, is left out of the js-fgb block
    // rather than shipped unused. A seekable Zstandard file is refused with a message.
    file: /[\\/]flatgeobuf[\\/]lib[\\/]mjs[\\/]seekable-zstd\.js$/,
    find: /import\('@bokuweb\/zstd-wasm'\)/g,
    replace: "Promise.reject(new Error('seekable Zstandard FlatGeobuf files are not supported'))",
    count: 1,
  },
];

export const vendorFixes = {
  name: 'vendor-fixes',
  setup(build) {
    for (const fx of FIXES) {
      build.onLoad({ filter: fx.file }, async (args) => {
        const src = await readFile(args.path, 'utf8');
        const n = src.match(fx.find)?.length ?? 0;
        if (n !== fx.count) throw new Error(`vendor fix for ${args.path}: expected ${fx.count} match(es), found ${n} — re-check the fix against this release`);
        return { contents: src.replace(fx.find, fx.replace), loader: 'js' };
      });
    }
  },
};
