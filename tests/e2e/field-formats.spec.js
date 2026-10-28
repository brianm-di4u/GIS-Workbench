// Field-data findings (phase F) on fixtures shaped like the user's deliveries (build/fixtures/fxfield.mjs):
// TE-060 big-endian JPEG tile sets, TE-062 JPEG YCbCr shown as RGB, IMP-21 imagery opened from ZIPs (nested, deflated),
// IMP-22 DIMAP metadata, TE-061 MrSID refused by name.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const F = (n) => resolve('fixtures/formats', n);
const truth = JSON.parse(readFileSync(F('te060_bigendian_jpeg.json'), 'utf8'));
test.describe.configure({ timeout: 180000 });

const layers = (frame) => frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ name: l.rec.name, error: l.error ?? null, w: l.width, h: l.height, bands: l.chain.bands, sun: l.info.sun ?? null, datetime: l.info.datetime, ready: !!l.lutTex })));
const toasts = (frame) => frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => `${[...t.classList].find((c) => c.startsWith('toast-'))}: ${t.textContent}`));
const ready = (frame, n = 1) => frame.waitForFunction((k) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex || l.error).length >= k, n, { timeout: 90000 });

test('TE-060 TE-062 REQ-FMT-04 a big-endian JPEG/YCbCr tiled GeoTIFF decodes (tile tables past the header read) as GDAL RGB', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('te060_bigendian_jpeg.tif')]);
  await ready(frame);
  const [l] = await layers(frame);
  expect(l.error).toBeNull();
  expect([l.w, l.h]).toEqual([truth.width, truth.height]);
  for (const [k, rgb] of Object.entries(truth.pixels)) {
    const [x, y] = k.split(',').map(Number);
    const v = await frame.evaluate(async ([x, y]) => {
      const L = [...window.gisworkbench.layers.values()][0];
      return (await window.gisworkbench.pool.run('pixels', { handle: L.handle, x, y, w: 1, h: 1, bands: [0, 1, 2] }, { affinity: L.affinity })).values.map((b) => b[0]);
    }, [x, y]);
    // JPEG decoders differ by a few DN in the IDCT and colour conversion.
    v.forEach((d, b) => expect(Math.abs(d - rgb[b]), `pixel ${k} band ${b}: ${d} vs GDAL ${rgb[b]}`).toBeLessThanOrEqual(4));
  }
  expect(logs).toEqual([]);
});

test('IMP-21 REQ-FMT-20 REQ-FMT-04 a delivery ZIP of ZIPs opens its imagery and overlays without unpacking', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => (window.gisworkbench.zipPick = 'default'));
  const log = await openFiles(frame, [F('te060_delivery.zip')]);
  await ready(frame);
  const ls = await layers(frame);
  expect(ls.map((l) => l.name)).toEqual(['Reef_20150101_R1C1.tif']); // not the _BROWSE quick look
  expect(ls[0].error).toBeNull();
  const v = await frame.evaluate(() => window.gisworkbench.store.all('vlayer').map((v) => v.name));
  expect(v.length, 'the TILE_SHAPE shapefile ZIP opened as a vector layer').toBeGreaterThan(0);
  expect(log.find((r) => r.file === 'te060_delivery.zip')?.warnings.join(' ')).toMatch(/opened \d+ of \d+ files from the ZIP/);
  expect((await toasts(frame)).filter((t) => t.startsWith('toast-error'))).toEqual([]);
  expect(logs).toEqual([]);
});

test('IMP-21 IMP-22 REQ-FMT-20 REQ-FMT-21 a deflated DIMAP volume opens from its ZIP with the product band order, sun and time', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => (window.gisworkbench.zipPick = 'default'));
  await openFiles(frame, [F('te060_dimap.zip')]);
  await ready(frame);
  const ls = await layers(frame);
  expect(ls.map((l) => l.name)).toEqual(['IMG_PHR1B_PMS_201804210157279_ORT_TEST_R1C1.TIF']);
  expect(ls[0].bands).toEqual([2, 1, 0]);
  expect(ls[0].sun).toMatchObject({ azimuth: 147.16, elevation: 55, source: 'DIMAP' });
  expect(ls[0].datetime).toBe('20180421015732');
  expect(logs).toEqual([]);
});

test('IMP-21 REQ-FMT-20 REQ-UI-14 REQ-UI-16 opening an imagery ZIP asks which files to open (accessible picker); Cancel opens nothing', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const done = openFiles(frame, [F('te060_delivery.zip')]);
  const dlg = frame.locator('[data-id="dialog:zip-open"]');
  await expect(dlg).toBeVisible({ timeout: 30000 });
  await expect(dlg.locator('input[type=checkbox]:checked')).not.toHaveCount(0);
  // WCAG 2.2 AA on the picker (axe-core), as for the other dialogs (pages.spec.js).
  await frame.evaluate(readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:zip-open"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).join(', ')}`));
  expect(v, 'axe violations in the ZIP picker').toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await done;
  expect(await layers(frame)).toEqual([]);
});

test('TE-061 REQ-SEC-02 a MrSID file is refused by name with its size, not as unrecognised data', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [F('te061_header.sid'), F('te061_header.sdw')]);
  const said = [...log.flatMap((r) => r.errors), ...(await toasts(frame))].join(' ');
  expect(said).toMatch(/MrSID \(MG3; 20,000 × 12,000 px, 3 bands, 8-bit\)/);
  expect(said).toMatch(/Cloud-Optimized GeoTIFF/);
  expect(said).not.toMatch(/unrecognised data|\.sdw/);
  expect(logs).toEqual([]);
});

test('IMP-23 TE-065 REQ-EXT-30 DIMAP GML masks open as vector layers in WGS 84 (empty masks too)', async ({ page }) => {
  const t = JSON.parse(readFileSync(F('te063_truth.json'), 'utf8')).roi;
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('te063_roi.gml'), F('te063_empty.gml')]);
  const v = await frame.evaluate(() => {
    const S = window.gisworkbench.store;
    return S.all('vlayer').map((l) => ({ name: l.name, feats: S.all('feature').filter((f) => f.vlayer === l.id).map((f) => ({ type: f.geom.type, xyz: [...f.geom.xyz] })) }));
  });
  expect(v.map((l) => l.name).sort()).toEqual(['Cloud mask', 'ROI mask']);
  const roi = v.find((l) => l.name === 'ROI mask').feats;
  expect(roi.length).toBe(1);
  expect(roi[0].type).toBe('Polygon');
  expect(roi[0].xyz.length / 3).toBe(t.vertices); // closing vertex dropped
  for (const [k, [lon, lat]] of [[0, t.v0], [13, t.v13]]) {
    expect(Math.abs(roi[0].xyz[k * 3] - lon), `vertex ${k} lon vs ${t.oracle}`).toBeLessThan(1e-7);
    expect(Math.abs(roi[0].xyz[k * 3 + 1] - lat), `vertex ${k} lat vs ${t.oracle}`).toBeLessThan(1e-7);
  }
  expect(v.find((l) => l.name === 'Cloud mask').feats).toEqual([]);
  expect((await toasts(frame)).filter((x) => x.startsWith('toast-error'))).toEqual([]);
  expect(logs).toEqual([]);
});

test('TE-069 REQ-MSI-09 REQ-SNS-09 a classification made from every k-th pixel keeps its geolocation (window model)', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [F('te060_bigendian_jpeg.tif')]);
  await ready(frame);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const L = [...app.layers.values()][0];
    const P = await app.msi.cluster(L, 'kmeans', { k: 3, iterations: 3, window: { x0: 100, y0: 50, w: 800, h: 600, step: 4 } });
    const lay = P.layer ?? P;
    const d = [[10.5, 20.5], [0.5, 0.5], [199.5, 149.5]].map(([x, y]) => {
      const a = lay.groundAt(x, y);
      const b = L.groundAt(100 + 4 * Math.floor(x) + 0.5, 50 + 4 * Math.floor(y) + 0.5);
      const back = lay.imageAt(b.lat, b.lon, 0);
      return { dLat: Math.abs(a.lat - b.lat), dLon: Math.abs(a.lon - b.lon), dx: Math.abs(back.x - x), dy: Math.abs(back.y - y) };
    });
    return { w: lay.width, h: lay.height, d };
  });
  expect([r.w, r.h]).toEqual([200, 150]);
  for (const q of r.d) {
    expect(q.dLat + q.dLon, 'product pixel centre vs the sampled source pixel (deg)').toBeLessThan(1e-9);
    expect(q.dx + q.dy, 'ground → product pixel round trip').toBeLessThan(1e-6);
  }
  expect(logs).toEqual([]);
});
