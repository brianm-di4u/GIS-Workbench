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
