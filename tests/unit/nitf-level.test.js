// Strided coarse levels of uncompressed NITF (app/src/workers/decode/nitf.js readLevel, which now
// reads only the column span a tile needs): every level sample equals the full-resolution pixel at
// the centre of its 2^L cell. Pixel-interleaved complex SICD (I/Q → magnitude) and a band-sequential
// SIDD, through the real parse WASM bundle; skipped when it or the T&E corpus is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openNitf } from '../../app/src/workers/decode/nitf.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const wasm = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_parse.wasm');
  } catch {
    return null;
  }
})();
const SAMPLES = ['derived-sar-sicd14-sidd30/capella_chip1_sicd14.nitf', 'derived-sar-sicd14-sidd30/capella_c13_sm_sidd_sidd30.nitf'].map((p) => join(CORPUS, p));
const have = wasm && existsSync(wasm) && SAMPLES.every((p) => existsSync(p));

describe.skipIf(!have)('NITF strided levels', () => {
  for (const path of SAMPLES) {
    it(`${path.split(/[\\/]/).pop()}: level samples are the cell-centre pixels`, async () => {
      const parse = new Bundle(new WebAssembly.Module(readFileSync(wasm)), 'parse');
      const file = new File([readFileSync(path)], path.split(/[\\/]/).pop());
      const { sources } = await openNitf(file, parse);
      const src = sources[0];
      const bands = Array.from({ length: src.bands }, (_, i) => i);
      for (const L of [2, 3]) {
        const sc = 2 ** L;
        const half = sc >> 1;
        const lw = Math.ceil(src.width / sc);
        const lh = Math.ceil(src.height / sc);
        // A window away from the origin, crossing the right edge when the level is narrow.
        const x0 = Math.floor(lw / 3);
        const y0 = Math.floor(lh / 4);
        const w = Math.min(40, lw - x0);
        const h = Math.min(24, lh - y0);
        const lvl = await src.readLevel(L, x0, y0, w, h, bands);
        for (const [i, j] of [[0, 0], [w - 1, 0], [Math.floor(w / 2), Math.floor(h / 2)], [w - 1, h - 1]]) {
          const X = Math.min(src.width - 1, (x0 + i) * sc + half);
          const Y = Math.min(src.height - 1, (y0 + j) * sc + half);
          const px = await src.readWindow(X, Y, 1, 1, bands);
          for (let k = 0; k < bands.length; k++) expect(lvl[k][j * w + i], `L${L} (${i},${j}) band ${k}`).toBe(px[k][0]);
        }
      }
    });
  }
});
