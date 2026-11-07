// UAVSAR (REQ-FMT-53) through the real `legacy` WASM bundle: the FX-21 PolSAR job (GRD REAL*4 and
// COMPLEX on the lat/lon grid, MLC and SLC in slant range, .dat refused by name) and the T&E corpus
// San Andreas GRDs (sizes, georeferencing, values against a direct little-endian read).
import { describe, it, expect } from 'vitest';
import { existsSync, openAsBlob, readFileSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { openUavsar, uavsarAnn } from '../../app/src/workers/decode/uavsar.js';
import { generate } from '../../build/fixtures/fx21/sar.mjs';

const DIR = resolve('fixtures/fx21/sar');
if (!existsSync(join(DIR, 'sar_truth.json')) || !JSON.parse(readFileSync(join(DIR, 'sar_truth.json'), 'utf8')).uavsar) await generate(DIR);
const T = JSON.parse(readFileSync(join(DIR, 'sar_truth.json'), 'utf8')).uavsar;
const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_legacy.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const B = haveWasm ? new Bundle(new WebAssembly.Module(readFileSync(wasmPath)), 'legacy') : null;
const file = async (p) => Object.assign(await openAsBlob(p), { name: p.split(/[\\/]/).pop() });
const CORPUS = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'sar-uavsar-quadpol-tierb');
const STEM = 'SanAnd_08527_18001_010_180205_L090';

describe.skipIf(!haveWasm)('UAVSAR', () => {
  const ann = join(DIR, `${T.stem}_CX_01.ann`);
  it('FX-21: GRD power and complex on the lat/lon grid; MLC and SLC in radar geometry', async () => {
    const a = await file(ann);
    const g = await openUavsar(await file(join(DIR, `${T.stem}HHHH_CX_01.grd`)), a, B);
    expect([g.source.width, g.source.height, g.source.bands, g.complex]).toEqual([T.grd.cols, T.grd.rows, 1, false]);
    expect(g.meta.epsg).toBe(4326);
    g.meta.geotransform.forEach((v, k) => expect(v).toBeCloseTo(T.gt[k], 12));
    const [w] = await g.source.readWindow(T.sample.c, T.sample.r, 1, 1, [0]);
    expect(w[0]).toBeCloseTo(T.sample.value, 6);
    const c = await openUavsar(await file(join(DIR, `${T.stem}HHVV_CX_01.grd`)), a, B);
    expect(c.complex).toBe(true);
    const [re, im] = await c.source.readWindow(T.sample.c, T.sample.r, 1, 1, [2, 3]);
    expect([re[0], im[0]].map((v) => +v.toFixed(6))).toEqual([+T.sample.value.toFixed(6), +(-0.5 * T.sample.value).toFixed(6)]);
    const m = await openUavsar(await file(join(DIR, `${T.stem}HHHH_CX_01.mlc`)), a, B);
    expect([m.source.width, m.source.height, m.meta.geotransform]).toEqual([T.mlc.cols, T.mlc.rows, null]);
    expect(m.meta.format).toMatch(/slant range/);
    const s = await openUavsar(await file(join(DIR, `${T.stem}HH_CX_01.slc`)), a, B);
    expect([s.source.width, s.source.height, s.complex]).toEqual([T.slc.cols, T.slc.rows, true]);
    await expect(openUavsar(await file(join(DIR, `${T.stem}_CX_01.dat`)), a, B)).rejects.toThrow(/compressed Stokes/);
    const sum = uavsarAnn(new Uint8Array(readFileSync(ann)), B);
    expect(sum.corners.length).toBe(4);
    expect(Object.keys(sum.files)).toContain('grdHHHH');
  });

  it('refuses a file the annotation does not describe, by name', async () => {
    const a = await file(ann);
    const wrong = Object.assign(new Blob([new Uint8Array(100)]), { name: `${T.stem}HHHH_CX_01.grd` });
    await expect(openUavsar(wrong, a, B)).rejects.toThrow(/matches no layer of its annotation/);
  });

  it.skipIf(!existsSync(join(CORPUS, `${STEM}_CX_01.ann`)))('corpus: San Andreas GRDs (REAL*4 and COMPLEX) by window and coarse level', async () => {
    const a = await file(join(CORPUS, `${STEM}_CX_01.ann`));
    for (const [pol, complex] of [['HHHH', false], ['HVHV', false], ['VVVV', false], ['HHVV', true]]) {
      const p = join(CORPUS, `${STEM}${pol}_CX_01.grd`);
      const g = await openUavsar(await file(p), a, B);
      expect([g.source.width, g.source.height, g.complex], pol).toEqual([31591, 5869, complex]);
      expect(g.meta.geotransform[0]).toBeCloseTo(-119.50939332 - 5.556e-5 / 2, 9);
      expect(g.meta.geotransform[3]).toBeCloseTo(34.51392756 + 5.556e-5 / 2, 9);
      const [x, y] = [15000, 3000];
      const fd = openSync(p, 'r');
      const b = Buffer.alloc(8);
      readSync(fd, b, 0, 8, (y * 31591 + x) * (complex ? 8 : 4));
      const [v] = await g.source.readWindow(x, y, 1, 1, [complex ? 2 : 0]);
      expect(v[0]).toBeCloseTo(b.readFloatLE(0), 6);
      const [lv] = await g.source.readLevel(4, Math.floor(x / 16), Math.floor(y / 16), 1, 1, [complex ? 2 : 0]);
      expect(Number.isFinite(lv[0])).toBe(true);
    }
  }, 120000);
});
