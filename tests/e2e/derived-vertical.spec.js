// #86, #92: a DEM derived from a terrain keeps the terrain's vertical datum. The Ground Filter DTM
// and TIN → DEM of an EGM2008 or NAVD88 terrain come back as that datum (not EGM96), their files
// carry its vertical key, and Use as Terrain proposes it when they are reopened.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

test('#86 #92 derived DEMs keep the source vertical datum', async ({ page }) => {
  test.setTimeout(240000);
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx02/fx02_dsm_truth.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const src = [...app.layers.values()].find((l) => /dsm_truth/.test(l.rec.name));
    const out = {};
    for (const vertical of ['egm2008', 'navd88']) {
      await app.useAsTerrain(src, vertical);
      const gf = await app.groundFilter({ maxWindowM: 50, slope: 0.15, height: 0.5 }, app.terrain.entry(src.id));
      const tinId = await app.tin.create({ from: 'dem', layer: src.id, tolerance: 0.5 });
      const td = await app.tin.toDem(tinId, { postM: 2 });
      const of = (l) => ({ terrain: app.terrain.entry(l.id).vertical, key: l.info.meta?.geoKeys?.VerticalCSTypeGeoKey });
      out[vertical] = { tin: app.tin.list().find((x) => x.id === tinId)?.vertical, dtm: of(gf.layer), tinDem: of(td.layer) };
    }
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.egm2008).toEqual({ tin: 'egm2008', dtm: { terrain: 'egm2008', key: 3855 }, tinDem: { terrain: 'egm2008', key: 3855 } });
  expect(r.navd88).toEqual({ tin: 'navd88', dtm: { terrain: 'navd88', key: 5703 }, tinDem: { terrain: 'navd88', key: 5703 } });
});
