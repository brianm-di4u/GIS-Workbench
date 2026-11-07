// NITF ARIDPCM (IC=C2, REQ-FMT-44) through app/src/workers/decode/nitf.js and the real `parse` and
// `legacy` WASM bundles: the NTB NITF 1.1 file U_0001a.ntf holds one scene per rate (4.50, 2.30,
// 1.40 and 0.75 bpp). The 0.75 bpp image decodes with the standard's own tables (no warning) and
// equals the Rust decoder's output (crates/gw-codec/tests/te_aridpcm.rs checks that against GDAL);
// the other rates carry the derived-tables warning. Skipped when the bundles or the corpus are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openNitf } from '../../app/src/workers/decode/nitf.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const dir = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const wasm = (n) => join(dir ?? '', `gw_bundle_${n}.wasm`);
const SAMPLE = join(CORPUS, 'nitf-ntb-nitf11-legacy', 'U_0001a.ntf');
const have = dir && existsSync(wasm('parse')) && existsSync(wasm('legacy')) && existsSync(SAMPLE);

describe.skipIf(!have)('NITF ARIDPCM (C2)', { timeout: 60000 }, () => {
  it('U_0001a.ntf: four C2 images open, rates without published tables are flagged', async () => {
    globalThis.self ??= {};
    self.GW = { ensure: async (n) => new Bundle(new WebAssembly.Module(readFileSync(wasm(n))), n) };
    const parse = new Bundle(new WebAssembly.Module(readFileSync(wasm('parse'))), 'parse');
    const r = await openNitf(new File([readFileSync(SAMPLE)], 'U_0001a.ntf'), parse);
    const c2 = r.images.filter((im) => im.ish?.IC === 'C2');
    expect(c2.map((im) => im.ish.COMRAT.trim())).toEqual(['4.50', '2.30', '1.40', '0.75']);
    for (const im of c2) expect(im.error ?? null).toBeNull();
    expect(c2.map((im) => !!im.warning)).toEqual([true, true, true, false]);
    const src = r.sources.find((s) => s.imageIndex === c2[0].index);
    expect([src.width, src.height, src.sampleType]).toEqual([512, 512, 'u8']);
    const [px] = await src.readWindow(0, 0, 512, 512, [0]);
    // San Onofre generating station: a real scene, full range, mean in the mid-greys.
    const mean = px.reduce((a, v) => a + v, 0) / px.length;
    expect(mean).toBeGreaterThan(60);
    expect(mean).toBeLessThan(190);
    expect(px.reduce((a, v) => Math.max(a, v), 0)).toBeGreaterThan(200);
    // A window equals the same samples of the full read.
    const [win] = await src.readWindow(100, 200, 16, 8, [0]);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) expect(win[y * 16 + x]).toBe(px[(200 + y) * 512 + 100 + x]);
  });
});

// REQ-FMT-45: the writer's IC=C2 (blocks end to end) and IC=M2 (block mask) files. The app reads
// both back to the same samples, within the 0.75 bpp coding error of the source. GDAL (the
// independent reader) decodes M2 to the app's samples; it reads C2 blocks as fixed slots of the
// uncompressed block size, so a standard C2 file with several variable-length blocks is refused.
const GDAL = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library';
const haveGdal = existsSync(join(GDAL, 'bin', 'gdal_translate.exe'));
describe.skipIf(!(dir && existsSync(wasm('parse')) && existsSync(wasm('legacy'))))('NITF ARIDPCM writer (C2 and M2)', { timeout: 120000 }, () => {
  it('600 × 400 8-bit at 0.75 bpp: the app reads C2 and M2 alike, GDAL reads M2', async () => {
    const { aridpcmEncode } = await import('../../app/src/workers/decode/nitf-writers.js');
    const { writeNitf } = await import('../../app/src/formats/nitf-writer.js');
    globalThis.self ??= {};
    self.GW = { ensure: async (n) => new Bundle(new WebAssembly.Module(readFileSync(wasm(n))), n) };
    const legacy = await self.GW.ensure('legacy');
    const parse = new Bundle(new WebAssembly.Module(readFileSync(wasm('parse'))), 'parse');
    const W = 600;
    const H = 400;
    const px = Uint8Array.from({ length: W * H }, (_, i) => {
      const x = i % W;
      const y = Math.floor(i / W);
      return Math.round(128 + 60 * Math.sin(x / 23) * Math.cos(y / 17) + ((x >> 5) + (y >> 5)) % 2 * 30);
    });
    const ar = aridpcmEncode(legacy, { px, width: W, height: H, nbpp: 8, comrat: '0.75' });
    const reads = {};
    for (const ic of ['C2', 'M2']) {
      const bytes = writeNitf({ width: W, height: H, bands: 1, type: 'u8', planes: [px] }, { irep: 'MONO', abpp: 8, aridpcm: { ...ar, comrat: '0.75', ic } });
      const r = await openNitf(new File([bytes], `w_${ic}.ntf`), parse);
      expect(r.images[0].ish.IC).toBe(ic);
      expect(r.images[0].error ?? null).toBeNull();
      const [got] = await r.sources[0].readWindow(0, 0, W, H, [0]);
      let err = 0;
      for (let i = 0; i < W * H; i++) err += Math.abs(got[i] - px[i]);
      expect(err / (W * H), `${ic} mean |error|`).toBeLessThan(6);
      reads[ic] = got;
      if (haveGdal && ic === 'M2') {
        const tmp = join(mkdtempSync(join(tmpdir(), 'gw-arid-')), `w_${ic}`);
        writeFileSync(`${tmp}.ntf`, bytes);
        execFileSync(join(GDAL, 'bin', 'gdal_translate.exe'), ['-q', '-of', 'ENVI', `${tmp}.ntf`, `${tmp}.raw`], { env: { ...process.env, PATH: `${join(GDAL, 'bin')};${process.env.PATH}`, GDAL_DATA: join(GDAL, 'share', 'gdal') } });
        const g = readFileSync(`${tmp}.raw`);
        expect(g.length).toBe(W * H);
        let d = 0;
        for (let i = 0; i < W * H; i++) d += Math.abs(g[i] - px[i]);
        expect(d / (W * H), `GDAL ${ic} mean |error|`).toBeLessThan(6);
        reads[`gdal-${ic}`] = g;
      }
    }
    expect(Array.from(reads.C2)).toEqual(Array.from(reads.M2));

  });
});
