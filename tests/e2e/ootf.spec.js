// REQ-IMG-18 Ortho On-the-Fly and virtual mosaics on FX-04 over the FX-05 terrain: the view's
// ground centre and scale survive the switch to the map-projected product; panning past the
// rectified region re-rectifies in place; two images make a virtual mosaic; turning it off
// restores the sources.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx04');
const truth = JSON.parse(readFileSync(resolve(DIR, 'fx04_truth.json'), 'utf8'));

test('REQ-IMG-18 FX-04 FX-05 Ortho On-the-Fly, re-rectification on pan, virtual mosaic', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve(DIR, truth.images[0].file), resolve(DIR, truth.images[1].file), resolve('fixtures/fx05/fx05_dem_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 3, null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()];
    const dem = ls.find((l) => /dem/i.test(l.rec.name));
    await app.useAsTerrain(dem, 'hae');
    const p = app.activePane();
    const imgs = ls.filter((l) => l !== dem);
    // Hide the DEM so the image is the panel's geo layer.
    app.store.transact('hide dem', (tx) => {
      tx.set(dem.id, 'visible', false);
      tx.set(p.id, 'activeLayer', imgs[0].id);
    });
    p.setView({ zoom: 0.5 });
    p.centreOn(imgs[0].width / 2, imgs[0].height / 2);
    const ground = () => {
      const l = p.geoLayer();
      const { w, h } = p.size();
      const q = p.imagePoint(w / 2, h / 2);
      return l.groundAt(q.x, q.y);
    };
    const g0 = ground();
    const m0 = p.groundScale();
    const e = await app.ootf.enable(p, { layers: [imgs[0]] });
    const L = p.geoLayer();
    const g1 = ground();
    const m1 = p.groundScale();
    const out = { name: L.rec.name, model: L.modelName, ootf: !!L.rec.ootf, sourceVisible: imgs[0].rec.visible !== false, centreShift: app.core.inverse(g0.lat, g0.lon, g1.lat, g1.lon).distance, scale: m1 / m0, gen: e.state.gen, ms: e.ms, size: [e.grid.w, e.grid.h] };
    // Pan by 0.4 of the region: a new rectification replaces the old layer.
    const before = L.id;
    p.setView({ cx: p.view.cx + e.grid.w * 0.4 });
    for (let i = 0; i < 100 && p.ootf.gen < 2; i++) await new Promise((res) => setTimeout(res, 100));
    out.afterPan = { gen: p.ootf.gen, replaced: p.geoLayer().id !== before, oldGone: !p.rec.layers.includes(before), layers: p.layers().filter((l) => l.rec.ootf).length };
    app.ootf.disable(p);
    out.off = { ootfLayers: p.layers().filter((l) => l.rec.ootf).length, visible: imgs[0].rec.visible !== false, active: p.geoLayer().id === imgs[0].id };
    // Virtual mosaic of both images.
    const vm = await app.ootf.enable(p, { layers: imgs });
    out.mosaic = { name: p.geoLayer().rec.name, sources: vm.state.sources.length, bands: p.geoLayer().bands };
    app.ootf.disable(p);
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.name).toMatch(/^Ortho On-the-Fly/);
  expect(r.model).toMatch(/EPSG:326\d\d|UTM/);
  expect(r.ootf).toBe(true);
  expect(r.sourceVisible).toBe(false);
  expect(r.centreShift).toBeLessThan(2);
  expect(r.scale).toBeGreaterThan(0.9);
  expect(r.scale).toBeLessThan(1.1);
  expect(r.afterPan).toMatchObject({ gen: 2, replaced: true, oldGone: true, layers: 1 });
  expect(r.off).toEqual({ ootfLayers: 0, visible: true, active: true });
  expect(r.mosaic.name).toBe('Virtual mosaic (2 images)');
  expect(r.mosaic.sources).toBe(2);
  expect(logs).toEqual([]);
});
