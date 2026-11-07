// TIFF old-style JPEG (compression 6, REQ-FMT-43, S-51) through app/src/workers/decode/geotiff.js and
// the real `legacy` WASM bundle: the three libtiff test images (interchange header with SOS per strip;
// JPEG tables in tags, tiled and single strip without RowsPerStrip) decode to GDAL/libtiff's values.
// Reference: GDAL 3.13 ReadAsArray band means and pixels. Node has no createImageBitmap, so this runs
// geotiff.js's JavaScript JPEG decoder (YCbCr converted after): a few DN from libjpeg. Skipped when the
// bundle or the corpus is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openGeoTiff } from '../../app/src/workers/decode/geotiff.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const dir = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const legacyWasm = join(dir ?? '', 'gw_bundle_legacy.wasm');
const D = join(CORPUS, 'raster-ojpeg-libtiff-negatives');
const have = dir && existsSync(legacyWasm) && existsSync(D);

const GDAL = {
  'ojpeg_chewey_subsamp21_multi_strip.tiff': { size: [392, 575], mean: [113.406, 87.953, 71.006], px: { '0,0': [246, 246, 182], '100,50': [245, 235, 186], '200,150': [82, 50, 39], '391,574': [211, 187, 163], '17,203': [247, 232, 189] } },
  'ojpeg_single_strip_no_rowsperstrip.tiff': { size: [234, 213], mean: [57.942, 58.115, 58.032], px: { '0,0': [134, 155, 176], '100,50': [12, 11, 17], '200,150': [11, 20, 37], '233,212': [36, 67, 85], '17,203': [42, 46, 49] } },
  'ojpeg_zackthecat_subsamp22_single_strip.tiff': { size: [234, 213], mean: [57.942, 58.115, 58.032], px: { '0,0': [134, 155, 176], '100,50': [12, 11, 17], '200,150': [11, 20, 37], '233,212': [36, 67, 85], '17,203': [42, 46, 49] } },
};

describe.skipIf(!have)('TIFF old-style JPEG (compression 6)', { timeout: 60000 }, () => {
  for (const [name, ref] of Object.entries(GDAL)) {
    it(`${name} decodes as GDAL/libtiff does`, async () => {
      globalThis.self ??= {};
      // geotiff.js reads Blobs through FileReader, which Node lacks.
      globalThis.FileReader ??= class {
        readAsArrayBuffer(blob) {
          blob.arrayBuffer().then((b) => {
            this.result = b;
            this.onload?.({ target: this });
            this.onloadend?.({ target: this });
          }, (e) => this.onerror?.(e));
        }
      };
      self.GW = { ensure: async (n) => new Bundle(new WebAssembly.Module(readFileSync(join(dir, `gw_bundle_${n}.wasm`))), n) };
      const { source } = await openGeoTiff(new Blob([readFileSync(join(D, name))]));
      expect([source.width, source.height, source.bands]).toEqual([...ref.size, 3]);
      const planes = await source.readWindow(0, 0, source.width, source.height, [0, 1, 2]);
      planes.forEach((p, k) => {
        const mean = p.reduce((a, v) => a + v, 0) / p.length;
        // c54 tolerance for lossy codecs: within 1 % of the range.
        expect(Math.abs(mean - ref.mean[k]), `band ${k} mean ${mean}`).toBeLessThan(2.55);
      });
      for (const [k, rgb] of Object.entries(ref.px)) {
        const [x, y] = k.split(',').map(Number);
        rgb.forEach((v, b) => expect(Math.abs(planes[b][y * source.width + x] - v), `${k} band ${b}`).toBeLessThanOrEqual(6));
      }
    });
  }
});
