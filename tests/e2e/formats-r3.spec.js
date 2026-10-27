// REQ-FMT-14: CADRG/CIB RPF frame files, MIE4NITF frame sequences and GeoPDF raster pages.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const F = (n) => resolve('fixtures/formats', n);
const truth = JSON.parse(readFileSync(F('formats_truth.json'), 'utf8'));
test.describe.configure({ timeout: 300000 });

test('REQ-FMT-14 an RPF frame file (CADRG, VQ) opens by its frame name; MIE4NITF segments play in time order', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('0XQ0F010.JN1')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const c = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()][0];
    return { w: l.width, h: l.height, ic: l.info.subheader?.IC, icat: l.info.icat, model: l.modelName };
  });
  expect([c.w, c.h]).toEqual([truth.cadrg.width, truth.cadrg.height]);
  expect(c.ic).toBe('M4');
  expect(c.icat).toBe('MAP');
  expect(c.model).not.toBe('none');

  await openFiles(frame, [F('mie4nitf.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.info?.mie && l.lutTex).length === 6, null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.desktop.multiports[0].panes.find((x) => x.layers().some((l) => l.info?.mie)) ?? app.activePane();
    app.desktop.multiports[0].setActivePane?.(p);
    const seq = app.mie.sequence(p);
    const bright = [];
    for (let k = 0; k < seq.length; k++) {
      const s = app.mie.show(k, p);
      const l = app.layers.get(s.layer);
      const row = (await app.pool.run('pixels', { handle: l.handle, x: 0, y: 40, w: 128, h: 1, bands: [0] }, { affinity: l.affinity })).values[0];
      bright.push(row.findIndex((v) => v > 200));
    }
    const visible = p.layers().filter((l) => l.info?.mie && l.rec.visible !== false).length;
    const fps = app.mie.play(p);
    await new Promise((res) => setTimeout(res, 1300));
    const moved = p.mie.index;
    app.mie.stop();
    return { times: seq.map((l) => l.info.mie.time), segs: seq.map((l) => l.info.mie.segment), bright, visible, fps, moved, label: p.status.textContent, rate: seq[0].info.mie.frameRate };
  });
  expect(r.times).toEqual(truth.mie.times);
  expect(r.segs).toEqual([1, 2, 3, 4, 5, 6]);
  expect(r.bright).toEqual(truth.mie.squareX);
  expect(r.visible).toBe(1);
  expect(r.fps).toBe(2);
  expect(r.moved).toBeGreaterThanOrEqual(1);
  expect(r.label).toMatch(/MIE4NITF frame \d\/6 · 2025-10-25 23:59:3/);
  expect(logs).toEqual([]);
});

test('REQ-FMT-14 GeoPDF: a product page written with an ISO 32000 geospatial viewport reopens georeferenced at the map frame', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx08/fx08.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const pg = await app.renderProductPage(undefined, { dpi: 150 });
    const pdf = await app.pagesToPdf([pg], { title: 'GeoPDF test' });
    const corners = pg.record.frame.corners;
    const n0 = app.layers.size;
    app.desktop.multiports[0].setLayout('1x2');
    const p2 = app.desktop.multiports[0].panes[1];
    await app.openFiles([new File([pdf], 'product.pdf')], p2);
    const l = [...app.layers.values()].find((x) => x.info.fileName === 'product.pdf');
    const fp = l?.footprint?.() ?? null;
    const err = fp ? Math.max(...fp.map((c, i) => app.core.inverse(c[0], c[1], corners[i][0], corners[i][1]).distance)) : null;
    const px = l ? (await app.pool.run('pixels', { handle: l.handle, x: Math.floor(l.width / 2), y: Math.floor(l.height / 2), w: 1, h: 1, bands: [0, 1, 2] }, { affinity: l.affinity })).values.map((v) => v[0]) : null;
    return { n0, n1: app.layers.size, model: l?.modelName, w: l?.width, h: l?.height, frame: pg.record.frame.px, err, gsd: pg.record.frame.metresPerPixel, px, hasVp: new TextDecoder('latin1').decode(pdf).includes('/Subtype /GEO') };
  });
  expect(r.hasVp).toBe(true);
  expect(r.n1).toBe(r.n0 + 1);
  expect(r.model).toMatch(/GeoPDF viewport/);
  // The crop is the map frame; its footprint matches the frame's ground corners (JPEG strips and
  // the 150 dpi page grid: within two page pixels of ground).
  expect(Math.abs(r.w - r.frame.w)).toBeLessThanOrEqual(2);
  expect(Math.abs(r.h - r.frame.h)).toBeLessThanOrEqual(2);
  expect(r.err).toBeLessThan(2 * r.gsd + 1);
  expect(r.px.some((v) => v > 0 && v < 255)).toBe(true);
  expect(logs).toEqual([]);
});
