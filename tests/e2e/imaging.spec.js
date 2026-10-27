// R1 imaging: S6 filters change pixels as expected (REQ-IMG-08), the tone curve and manual
// per-band stretch fold into the LUT (REQ-IMG-06), transparency threshold (REQ-IMG-09),
// band statistics and the Pixel Matrix Viewer (REQ-MSI-07, REQ-IMG-21), GeoTIFF RPC tag
// models against the WV3 truth (REQ-FMT-04, REQ-SNS-02) and proj4js CRSs (REQ-GEO-04).
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { openApp, openFiles, sample } from './helpers.js';

async function ready(page, file) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => {
    const l = [...window.gisworkbench.layers.values()][0];
    return l?.lutTex && !l.tiles.loading;
  });
  return { frame, logs };
}

/** Statistics of the rendered pane centre (120×120 device px): mean, local variance, zeros. */
const paneStats = (frame) =>
  frame.evaluate(async () => {
    const app = window.gisworkbench;
    for (let i = 0; i < 50; i++) {
      const l = [...app.layers.values()][0];
      if (l.lutTex && !l.tiles.loading) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150));
    const cap = app.renderer.capture();
    const r = app.activePane().el.getBoundingClientRect();
    const s = cap.dpr;
    const cx = Math.round((r.left + r.width / 2) * s);
    const cy = Math.round((r.top + r.height / 2) * s);
    let sum = 0;
    let lap = 0;
    let zeros = 0;
    let n = 0;
    const g = (x, y) => cap.data[(y * cap.width + x) * 4];
    for (let y = cy - 60; y < cy + 60; y++)
      for (let x = cx - 60; x < cx + 60; x++) {
        const v = g(x, y);
        sum += v;
        lap += Math.abs(4 * v - g(x - 1, y) - g(x + 1, y) - g(x, y - 1) - g(x, y + 1));
        if (v === 0 && cap.data[(y * cap.width + x) * 4 + 1] === 0) zeros++;
        n++;
      }
    return { mean: sum / n, detail: lap / n, zeros };
  });

test('REQ-IMG-08 REQ-IMG-06 REQ-IMG-09 filters, curve, manual stretch and clip change the rendered pixels', async ({ page }) => {
  // TE-017: many GPU read-backs; under four parallel workers it needs more than the 90 s default.
  test.setTimeout(240_000);
  const { frame, logs } = await ready(page, sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'));
  await frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    p.view.zoom = 1;
    p.invalidate();
  });
  const set = (fn) => frame.evaluate((src) => window.gisworkbench.setChain(new Function('c', src)), fn);
  const base = await paneStats(frame);
  await set("c.filter.op = 'smooth'; c.filter.size = 5;");
  const smooth = await paneStats(frame);
  await set("c.filter.op = 'sharpen'; c.filter.strength = 1;");
  const sharp = await paneStats(frame);
  await set("c.filter.op = 'median';");
  const median = await paneStats(frame);
  await set("c.filter.op = 'edge';");
  const edge = await paneStats(frame);
  await set("c.filter.op = 'none'; c.sharpen.usm = 1.5;");
  const usm = await paneStats(frame);
  expect(smooth.detail).toBeLessThan(base.detail * 0.7);
  expect(sharp.detail).toBeGreaterThan(base.detail * 1.3);
  expect(usm.detail).toBeGreaterThan(base.detail * 1.2);
  expect(median.detail).toBeLessThan(base.detail);
  expect(edge.mean).toBeLessThan(base.mean * 0.6);
  // Kernel falls back to bilinear while a filter is on.
  expect(await frame.evaluate(() => window.gisworkbench.activeLayer().kernelEffective)).toBe('bilinear');
  await set('c.filter.op = "none"; c.sharpen.usm = 0;');
  expect(await frame.evaluate(() => window.gisworkbench.activeLayer().kernelEffective)).toBe('bicubic');

  // Tone curve (darken) lowers the mean; manual stretch sets the LUT limits per band.
  await set('c.tone.curve = [[0, 0], [0.6, 0.3], [1, 1]];');
  const dark = await paneStats(frame);
  expect(dark.mean).toBeLessThan(base.mean - 10);
  await set("c.tone.curve = null; c.stretch = 'manual'; c.manual = { 0: { lo: 200, hi: 400 } };");
  const lp = await frame.evaluate(() => window.gisworkbench.activeLayer().lutParams[0]);
  expect([lp.lo, lp.hi]).toEqual([200, 400]);
  // Transparency threshold: everything below a high DN becomes transparent (pane background).
  await set("c.stretch = 'dra'; c.clip = { on: true, lo: 2047, hi: 4095 };");
  const clipped = await paneStats(frame);
  expect(clipped.zeros).toBeGreaterThan(14000 * 0.9);
  // Undo walks back through every step.
  const steps = await frame.evaluate(() => window.gisworkbench.undo.history().filter((x) => x.state !== 'redo').length);
  expect(steps).toBeGreaterThanOrEqual(9);
  expect(logs).toEqual([]);
});

test('REQ-MSI-07 REQ-IMG-21 band statistics and the Pixel Matrix Viewer read raw DN', async ({ page }) => {
  const { frame } = await ready(page, sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'));
  await frame.evaluate(() => void window.gisworkbench.commands.run('bands.stats'));
  const t = frame.locator('[data-id="dialog:band-stats"] table');
  await expect(t).toContainText('Mean');
  const cells = await t.locator('tbody tr').first().locator('td').allTextContents();
  expect(Number(cells[2])).toBeGreaterThanOrEqual(0); // min
  expect(Number(cells[3])).toBeLessThanOrEqual(2047); // max of 11-bit data
  await frame.locator('[data-id="dialog:band-stats"]').getByRole('button', { name: 'Close' }).last().click();
  await frame.evaluate(() => void window.gisworkbench.commands.run('display.pixels'));
  const r = await frame.evaluate(() => window.gisworkbench.activePane().el.getBoundingClientRect().toJSON());
  await page.mouse.move(r.left + r.width / 2, r.top + r.height / 2);
  await page.mouse.move(r.left + r.width / 2 + 3, r.top + r.height / 2 + 2);
  const centre = frame.locator('[data-id="dialog:pixel-matrix"] td.pm-centre');
  await expect(centre).toHaveCount(1);
  const shown = Number(await centre.textContent());
  const truth = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.layers()[0];
    const c = p.cursor;
    const v = await app.pool.run('pixels', { handle: l.handle, x: Math.floor(c.x), y: Math.floor(c.y), w: 1, h: 1, bands: [0] }, { affinity: l.affinity });
    return v.values[0][0];
  });
  expect(shown).toBe(truth);
});

test('REQ-FMT-04 REQ-SNS-02 the GeoTIFF RPC tag (chip-adjusted) reproduces the WV3 truth points', async ({ page }) => {
  const { frame } = await ready(page, sample('geotiff-wv3-rpc-cog', 'wv3_a_gtiff_rpc.tif'));
  const truth = JSON.parse(readFileSync(sample('nitf-wv3-mvs-stereo-chips', 'wv3_chips_truth.json'), 'utf8')).chips['wv3_a_chip.ntf'];
  const r = await frame.evaluate((pts) => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    return { name: l.modelName, xy: pts.map((p) => app.core.g2i(l.modelId, p.lat, p.lon, p.h_hae_m)) };
  }, truth.check_points);
  expect(r.name).toBe('RPC (GeoTIFF tag)');
  truth.check_points.forEach((p, i) => {
    expect(Math.abs(r.xy[i].x - p.chip_col)).toBeLessThan(1e-3);
    expect(Math.abs(r.xy[i].y - p.chip_row)).toBeLessThan(1e-3);
  });
});

test('REQ-GEO-04 a NAD27 UTM GeoTIFF is placed through proj4js within 1 cm of an independent proj4 run', async ({ page }) => {
  const { frame } = await ready(page, sample('geotiff-gdal-small', 'utm.tif'));
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const gt = l.info.meta.geotransform;
    const pts = [[0, 0], [256, 256], [512, 512], [100, 400]].map(([x, y]) => ({ x, y, e: gt[0] + gt[1] * x + gt[2] * y, n: gt[3] + gt[4] * x + gt[5] * y, g: app.core.i2g(l.modelId, x, y, 0) }));
    return { name: l.modelName, note: l.modelInfo?.note, pts };
  });
  expect(r.name).toBe('Map (EPSG:26711, fitted)');
  expect(r.note).toMatch(/NAD27/);
  const p = proj4('+proj=utm +zone=11 +ellps=clrk66 +towgs84=-8,160,176,0,0,0,0 +units=m +no_defs', '+proj=longlat +datum=WGS84 +no_defs');
  for (const q of r.pts) {
    const [lon, lat] = p.forward([q.e, q.n]);
    expect(Math.abs(q.g.lat - lat) * 111_320).toBeLessThan(0.01);
    expect(Math.abs(q.g.lon - lon) * 111_320 * Math.cos((lat * Math.PI) / 180)).toBeLessThan(0.01);
  }
});
