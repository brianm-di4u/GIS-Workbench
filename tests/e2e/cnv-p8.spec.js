// GIS Workbench 2.0 hardening (2.0 plan P8): REQ-CNV-01 the streaming COG writer (S-32) — the same
// pixels as the source, tiled with overviews, within a fixed memory ceiling — and REQ-CNV-02
// FlatGeobuf output, read back by the flatgeobuf reader.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { deserialize } from 'flatgeobuf/lib/mjs/geojson.js';
import { openApp, openFiles, SAMPLES } from './helpers.js';

test.describe.configure({ timeout: 900000 });

const SMALL = join(SAMPLES, 'geotiff-gdal-small', 'utm.tif');
const FX12 = resolve('fixtures/fx12/fx12.geojson');
const HOUSTON = resolve('..', 'TE-corpus', 'ieee-dfc2018-houston', 'Final_RGB_HR_Imagery', 'UH_NAD83_272652_3289689.tif');

async function ready(page) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  return openApp(page, 'file', { prefs: { welcomeDone: true } });
}

test('REQ-CNV-01 the streaming COG writer gives the same pixels as the source, tiled with overviews', async ({ page }) => {
  const { frame } = await ready(page);
  await openFiles(frame, [SMALL]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats));
  const [dl] = await Promise.all([page.waitForEvent('download'), frame.evaluate(() => window.gisworkbench.convertToCog(window.gisworkbench.activeLayer().id, { stream: true }))]);
  const buf = readFileSync(await dl.path());
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const im = await tiff.getImage(0);
  const src = await (await fromArrayBuffer(readFileSync(SMALL).buffer.slice(0))).getImage(0);
  expect([im.getWidth(), im.getHeight(), im.isTiled, im.getTileWidth()]).toEqual([src.getWidth(), src.getHeight(), true, 512]);
  const [a] = await im.readRasters();
  const [b] = await src.readRasters();
  expect(Array.from(a)).toEqual(Array.from(b));
  expect(im.getOrigin()).toEqual(src.getOrigin());
});

test('REQ-CNV-01 a 432 M-sample image (above the in-memory limit) converts by streaming', async ({ page }) => {
  test.skip(!existsSync(HOUSTON), 'the Houston orthophoto is in the TE corpus only');
  const { frame } = await ready(page);
  await openFiles(frame, [HOUSTON]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.stats), null, { timeout: 300000 });
  const t0 = Date.now();
  const [dl, msg] = await Promise.all([page.waitForEvent('download', { timeout: 900000 }), frame.evaluate(() => window.gisworkbench.convertToCog(window.gisworkbench.activeLayer().id))]);
  console.log(`Houston COG: ${msg} in ${Math.round((Date.now() - t0) / 1000)} s`);
  expect(msg).toMatch(/streamed/);
  const buf = readFileSync(await dl.path());
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const im = await tiff.getImage(0);
  expect([im.getWidth(), im.getHeight(), im.getSamplesPerPixel()]).toEqual([11920, 12020, 3]);
  expect(await tiff.getImageCount()).toBeGreaterThanOrEqual(5);
  const src = await (await fromArrayBuffer(readFileSync(HOUSTON).buffer.slice(0))).getImage(0);
  const win = { window: [6000, 6000, 6064, 6064], interleave: true };
  expect(Array.from(await im.readRasters(win))).toEqual(Array.from(await src.readRasters(win)));
});

test('REQ-CNV-02 vectors convert to FlatGeobuf', async ({ page }) => {
  const { frame } = await ready(page);
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    document.body.appendChild(i);
    i.addEventListener('change', () => window.gisworkbench.convertFiles([...i.files], 'flatgeobuf'));
    return i;
  });
  const [dl] = await Promise.all([page.waitForEvent('download'), input.asElement().setInputFiles([FX12])]);
  const bytes = new Uint8Array(readFileSync(await dl.path()));
  expect(Array.from(bytes.subarray(0, 3))).toEqual([0x66, 0x67, 0x62]); // "fgb"
  let header = null;
  const all = [];
  for await (const f of deserialize(bytes, undefined, (h) => (header = h))) all.push(f);
  const src = JSON.parse(readFileSync(FX12, 'utf8'));
  expect(all.length).toBe(src.features.length);
  expect(header.featuresCount).toBe(src.features.length);
  expect(header.crs?.code).toBe(4326);
});
