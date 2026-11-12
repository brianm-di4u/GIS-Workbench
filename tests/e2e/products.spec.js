// R1 products (REQ-PRD-01, REQ-PRD-10, REQ-IMG-28, AT-01.4): chips with resolved
// caption tokens and a scale bar valid within 2 % at the centre; world files that put the chip
// back on the ground; GeoTIFF and NITF chips of source samples that reopen and geolocate like
// the parent (RPC kept, ICHIPB / shifted offsets); autolabels that follow their image.
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';
import { tempDir } from '../tools/temp-dir.mjs';

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
      return { name: out.name, b64: btoa(s), record: chip.record, world: out.world ?? null };
    },
    { fmt, opts },
  );

test('REQ-PRD-01 AT-01.4 chip: caption tokens, north arrow and a scale bar within 2 %', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const chip = await app.makeChip({ width: 900, height: 700 });
    const { canvas: c, record: rec, view: cv } = chip;
    // AT-01.4: the bar's length on the ground, measured through the model along the chip's x.
    const l = cv.geoLayer();
    const a = cv.imagePoint(450 - rec.scaleBar.px / 2, 350);
    const b = cv.imagePoint(450 + rec.scaleBar.px / 2, 350);
    const ga = l.groundAt(a.x, a.y);
    const gb = l.groundAt(b.x, b.y);
    const ground = app.core.inverse(ga.lat, ga.lon, gb.lat, gb.lon).distance;
    return { rec, height: c.height, ground, caption: rec.caption };
  });
  expect(r.rec.size).toEqual([900, 700]);
  expect(r.height).toBe(700 + Math.round(Math.max(18, Math.round(700 * 0.03)) * 1.15)); // the image and its caption bar
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
    ({ w, rec }) => {
      const app = window.gisworkbench;
      const [A, D, B, E, C, F] = w.text.trim().split('\n').map(Number);
      const p = app.activePane();
      const l = p.geoLayer();
      const { ChipView } = app.__test ?? {};
      // Pixel centre (i, j) of the saved picture → (lon, lat); compare with the model at the
      // same chip position (the image area starts at the top row).
      const errs = [];
      for (const [i, j] of [
        [10, 10],
        [400, 300],
        [790, 590],
      ]) {
        const lon = A * i + B * j + C;
        const lat = D * i + E * j + F;
        const c = rec.cornersImage;
        // Bilinear on the image corners (the chip view is affine in image space).
        const u = (i + 0.5) / rec.size[0];
        const v = (j + 0.5) / rec.size[1];
        const x = c[0][0] + u * (c[1][0] - c[0][0]) + v * (c[3][0] - c[0][0]);
        const y = c[0][1] + u * (c[1][1] - c[0][1]) + v * (c[3][1] - c[0][1]);
        const g = l.groundAt(x, y);
        errs.push(app.core.inverse(lat, lon, g.lat, g.lon).distance);
      }
      return { errs, resid: w.residualM, gsd: rec.metresPerPixel };
    },
    { w: out.world, rec: out.record },
  );
  // An affine world file over a small RPC chip: within a pixel of the model.
  for (const e of res.errs) expect(e).toBeLessThan(Math.max(1, res.gsd));
  expect(res.resid).toBeLessThan(res.gsd);
});

test('REQ-PRD-10 a chip of a source with FSCLAS=C comes out with FSCLAS=C, in both subheaders', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const b64 = await frame.evaluate(() => {
    const planes = [new Uint8Array(256 * 256).map((_, i) => i % 251)];
    const u8 = window.gisworkbench.__test.writeNitf({ width: 256, height: 256, bands: 1, type: 'u8', planes }, { title: 'Test value', iid1: 'SRC', security: { file: { class: 'C', FSCLSY: 'US', FSCODE: 'AB', FSREL: 'USA' }, image: { class: 'C', ISCLSY: 'US', ISCODE: 'AB', ISREL: 'USA' } } });
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const dir = tempDir('gw-sec');
  const src = join(dir, 'source_c.ntf');
  writeFileSync(src, Buffer.from(b64, 'base64'));
  await openFiles(frame, [src]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex));
  const out = await product(frame, 'nitf-source', { width: 128, height: 128 });
  const file = join(dir, out.name);
  writeFileSync(file, Buffer.from(out.b64, 'base64'));
  await openFiles(frame, [file]);
  const stem = out.name.replace(/\.\w+$/, '');
  await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].some((l) => l.rec.name.startsWith(n) && l.lutTex), stem);
  const sec = await frame.evaluate((n) => {
    const l = [...window.gisworkbench.layers.values()].find((x) => x.rec.name.startsWith(n));
    return { file: l.info.header.security, image: l.info.subheader.security };
  }, stem);
  expect(sec.file).toMatchObject({ class: 'C', FSCLSY: 'US', FSCODE: 'AB', FSREL: 'USA' });
  expect(sec.image).toMatchObject({ class: 'C', ISCLSY: 'US', ISCODE: 'AB', ISREL: 'USA' });
  expect(logs).toEqual([]);
});

for (const fmt of ['nitf-source', 'tif-source']) {
  test(`REQ-PRD-10 ${fmt} chip reopens with the parent's samples and geolocation`, async ({ page }) => {
    const { frame, logs } = await ready(page);
    await frame.evaluate(() => window.gisworkbench.activePane().setView({ cx: 700, cy: 820, zoom: 1, rot: 0, mode: 'native' }));
    const out = await product(frame, fmt, { width: 400, height: 300 });
    const dir = tempDir('gw-prd');
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
        return { errs, model: chip.modelName, size: [chip.width, chip.height], pa: pa.values, pb: pb.values, securityClass: chip.info.header?.security?.class };
      },
      { n: out.name.replace(/\.\w+$/, ''), src },
    );
    expect(r.size).toEqual([src.w, src.h]);
    expect(r.model).toMatch(/^RPC/);
    expect(r.pa).toEqual(r.pb);
    for (const e of r.errs) expect(e).toBeLessThan(0.01);
    if (fmt === 'nitf-source') expect(r.securityClass).toBe('U'); // the required field, at its neutral value
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
