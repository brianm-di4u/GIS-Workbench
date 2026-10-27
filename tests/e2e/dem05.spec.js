// REQ-DEM-05 on FX-02: the NCC "Fast" engine is faster than SGM, flagged edge-poor, and accurate on
// flat ground; multi-pair fusion of the SGM and NCC surfaces keeps the flat accuracy.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx02');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx02_truth.json'), 'utf8'));

test('REQ-DEM-05 FX-02 NCC Fast engine and multi-pair fusion', async ({ page }) => {
  test.setTimeout(420000);
  const b = readFileSync(resolve(DIR, 'fx02_dsm_truth.tif'));
  const tif = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  const im = await tif.getImage();
  const [v] = await im.readRasters();
  const [x0, y1] = im.getOrigin();
  const [dx, dy] = im.getResolution();
  const flat = [];
  for (const a of truth.flatAreas)
    for (let j = 0; j < im.getHeight(); j += 3)
      for (let i = 0; i < im.getWidth(); i += 3) {
        const lat = y1 + (j + 0.5) * dy;
        const lon = x0 + (i + 0.5) * dx;
        const dn = (lat - a.centre.lat) * 110940;
        const de = (lon - a.centre.lon) * 111320 * Math.cos((a.centre.lat * Math.PI) / 180);
        if (Math.hypot(de, dn) <= a.radiusM - 5) flat.push({ lat, lon, h: v[j * im.getWidth() + i] });
      }
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.map((i) => resolve(DIR, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(async (flat) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
    const rmse = (d) => {
      const g = d.grid;
      let ss = 0;
      let n = 0;
      for (const p of flat) {
        const ix = Math.round((p.lon - g.lon0) / g.dlon);
        const iy = Math.round((g.lat0 - p.lat) / g.dlat);
        if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) continue;
        const z = d.heights[iy * g.nx + ix];
        if (!Number.isFinite(z)) continue;
        ss += (z - p.h) ** 2;
        n++;
      }
      return { rmse: Math.sqrt(ss / n), n };
    };
    const ncc = await app.extractDsm(ls[0], ls[1], { hMin: 680, hMax: 760, preset: 'ncc' });
    const sgm = await app.extractDsm(ls[0], ls[1], { hMin: 680, hMax: 760, preset: 'fast' });
    const fused = app.fuseDsms([sgm, ncc]);
    return { ncc: { ...ncc.stats, ...rmse(ncc) }, sgm: { ...sgm.stats, ...rmse(sgm) }, fused: rmse(fused) };
  }, flat);
  console.log(JSON.stringify({ ncc: { ms: r.ncc.ms, rmse: r.ncc.rmse, engine: r.ncc.engine, matched: r.ncc.matchedFraction }, sgm: { ms: r.sgm.ms, rmse: r.sgm.rmse }, fused: r.fused }));
  expect(r.ncc.engine).toBe('NCC Fast');
  expect(r.ncc.edgePoor).toBe(true);
  expect(r.sgm.engine).toBe('SGM');
  expect(r.ncc.ms).toBeLessThan(r.sgm.ms);
  expect(r.ncc.rmse).toBeLessThan(0.5);
  expect(r.ncc.n).toBeGreaterThan(flat.length * 0.5);
  expect(r.fused.rmse).toBeLessThan(0.5);
  expect(logs).toEqual([]);
});
