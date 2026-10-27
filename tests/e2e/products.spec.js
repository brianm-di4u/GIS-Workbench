// R1 products (REQ-PRD-01, REQ-PRD-10, REQ-IMG-28, AT-01.4): chips with banners, resolved
// caption tokens and a scale bar valid within 2 % at the centre; world files that put the chip
// back on the ground; GeoTIFF and NITF chips of source samples that reopen and geolocate like
// the parent (RPC kept, ICHIPB / shifted offsets); autolabels that follow their image.
import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

const WV3 = sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [WV3]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && !l.tiles.loading && l.modelId));
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 700, cy: 820, zoom: 0.8, rot: 0.3, mode: 'native' }));
  return { frame, logs };
}

/** Encode a product in the page; returns {name, b64, record}. */
const product = (frame, fmt, opts = {}) =>
  frame.evaluate(
    async ({ fmt, opts }) => {
      const app = window.gisworkbench;
      const chip = await app.makeChip(opts);
      const out = await app.encodeProduct(chip, fmt);
      const u8 = new Uint8Array(await out.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return { name: out.name, b64: btoa(s), record: chip.record, imageTop: chip.imageTop, world: out.world ?? null };
    },
    { fmt, opts },
  );

test('REQ-PRD-01 AT-01.4 chip: banners, caption tokens, north arrow and a scale bar within 2 %', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const chip = await app.makeChip({ width: 900, height: 700 });
    const { canvas: c, record: rec, view: cv, imageTop } = chip;
    const g = c.getContext('2d');
    const px = (x, y) => [...g.getImageData(x, y, 1, 1).data];
    // AT-01.4: the bar's length on the ground, measured through the model along the chip's x.
    const l = cv.geoLayer();
    const a = cv.imagePoint(450 - rec.scaleBar.px / 2, 350);
    const b = cv.imagePoint(450 + rec.scaleBar.px / 2, 350);
    const ga = l.groundAt(a.x, a.y);
    const gb = l.groundAt(b.x, b.y);
    const ground = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance;
    return { rec, imageTop, height: c.height, top: px(3, 3), bottom: px(3, c.height - 3), ground, caption: rec.caption };
  });
  expect(r.rec.size).toEqual([900, 700]);
  expect(r.height).toBe(700 + 2 * r.imageTop + Math.round(r.imageTop * 1.15));
  // UNCLASSIFIED banners (green) at the top and bottom.
  for (const p of [r.top, r.bottom]) expect(p[1]).toBeGreaterThan(p[0] + 40);
  expect(r.rec.marking.text).toBe('UNCLASSIFIED');
  expect(r.caption).toMatch(/^Chip \d+ · /);
  expect(r.caption).not.toContain('[n/a]');
  expect(r.rec.centreMgrs).toMatch(/^\d{1,2}[C-X][A-Z]{2}\d{10}$/);
  expect(r.rec.northAngle).not.toBeNull();
  expect(Math.abs(r.ground - r.rec.scaleBar.metres) / r.rec.scaleBar.metres).toBeLessThan(0.02);
  expect(r.rec.cornersGround).toHaveLength(4);
  expect(logs).toEqual([]);
});

test('REQ-PRD-10 world file of a PNG chip puts its pixels back on the ground', async ({ page }) => {
  const { frame } = await ready(page);
  const out = await product(frame, 'png', { width: 800, height: 600 });
  expect(out.name).toMatch(/\.zip$/);
  expect(out.world).not.toBeNull();
  const res = await frame.evaluate(
    ({ w, rec, top }) => {
      const app = window.gisworkbench;
      const [A, D, B, E, C, F] = w.text.trim().split('\n').map(Number);
      const p = app.activePane();
      const l = p.geoLayer();
      const { ChipView } = app.__test ?? {};
      // Pixel centre (i, j) of the saved picture → (lon, lat); compare with the model at the
      // same chip position (image area origin is `top` rows down).
      const errs = [];
      for (const [i, j] of [
        [10, top + 10],
        [400, top + 300],
        [790, top + 590],
      ]) {
        const lon = A * i + B * j + C;
        const lat = D * i + E * j + F;
        const c = rec.cornersImage;
        // Bilinear on the image corners (the chip view is affine in image space).
        const u = (i + 0.5) / rec.size[0];
        const v = (j + 0.5 - top) / rec.size[1];
        const x = c[0][0] + u * (c[1][0] - c[0][0]) + v * (c[3][0] - c[0][0]);
        const y = c[0][1] + u * (c[1][1] - c[0][1]) + v * (c[3][1] - c[0][1]);
        const g = l.groundAt(x, y);
        errs.push(app.core.inverse(lat, lon, g.lat, g.lon).distance);
      }
      return { errs, resid: w.residualM, gsd: rec.metresPerPixel };
    },
    { w: out.world, rec: out.record, top: out.imageTop },
  );
  // An affine world file over a small RPC chip: within a pixel of the model.
  for (const e of res.errs) expect(e).toBeLessThan(Math.max(1, res.gsd));
  expect(res.resid).toBeLessThan(res.gsd);
});

for (const fmt of ['nitf-source', 'tif-source']) {
  test(`REQ-PRD-10 ${fmt} chip reopens with the parent's samples and geolocation`, async ({ page }) => {
    const { frame, logs } = await ready(page);
    await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 700, cy: 820, zoom: 1, rot: 0, mode: 'native' }));
    const out = await product(frame, fmt, { width: 400, height: 300 });
    const dir = mkdtempSync(join(tmpdir(), 'gw-prd-'));
    const file = join(dir, out.name);
    writeFileSync(file, Buffer.from(out.b64, 'base64'));
    const src = out.record.source;
    expect(src.step).toBe(1);
    await openFiles(frame, [file]);
    await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].some((l) => l.rec.name.startsWith(n) && l.lutTex && l.modelId), out.name.replace(/\.\w+$/, ''));
    const r = await frame.evaluate(
      async ({ n, src }) => {
        const app = window.gisworkbench;
        const ls = [...app.layers.values()];
        const parent = ls.find((l) => !l.rec.name.startsWith(n));
        const chip = ls.find((l) => l.rec.name.startsWith(n));
        const errs = [];
        for (const [c, rw] of [
          [0.5, 0.5],
          [200.5, 150.5],
          [src.w - 0.5, src.h - 0.5],
        ]) {
          const a = chip.groundAt(c, rw, 0);
          const b = parent.groundAt(src.x0 + c, src.y0 + rw, 0);
          errs.push(app.core.inverse(a.lat, a.lon, b.lat, b.lon).distance);
        }
        const run = (l, x, y) => app.pool.run('pixels', { handle: l.handle, x, y, w: 4, h: 1, bands: [0] }, { affinity: l.affinity });
        const pa = await run(chip, 37, 41);
        const pb = await run(parent, src.x0 + 37, src.y0 + 41);
        return { errs, model: chip.modelName, size: [chip.width, chip.height], pa: pa.values, pb: pb.values, marking: chip.info.marking?.level };
      },
      { n: out.name.replace(/\.\w+$/, ''), src },
    );
    expect(r.size).toEqual([src.w, src.h]);
    expect(r.model).toMatch(/^RPC/);
    expect(r.pa).toEqual(r.pb);
    for (const e of r.errs) expect(e).toBeLessThan(0.01);
    if (fmt === 'nitf-source') expect(r.marking).toBe('U');
    expect(logs).toEqual([]);
  });
}

test('REQ-IMG-28 AT-16.3 autolabels resolve tokens for the image they are on', async ({ page }) => {
  const { frame } = await ready(page);
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const t = '{IMAGE_ID[0:6]} {ACQ_DAY|x} {FOO|fallback} {SENSOR} {NOW_UTC[0:4]}';
    return { a: app.resolveLabel(p, t), none: app.resolveLabel({ geoLayer: () => null, activeLayer: () => null }, '{IMAGE_ID} {MGRS_CENTER}') };
  });
  expect(r.a).not.toContain('{');
  expect(r.a).toContain('fallback');
  expect(r.none).toBe('[n/a] [n/a]');
});
