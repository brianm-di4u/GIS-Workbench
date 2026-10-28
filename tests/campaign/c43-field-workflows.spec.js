// TE-C43 Phase F workflows on the field data (tier U, build/campaign/field.mjs), each checked against
// the files themselves (geotiff.js in Node) or GDAL truth:
//  • W1 Millerovo Pléiades, two dates of 172 M px: change detection screens the whole scene at
//    reduced resolution (IMP-25), then compares an AOI at full resolution;
//  • W2 Spratly West Reef 2014 → 2015 (DigitalGlobe browse images, different grids): island building
//    is found, with the seamline shapefile overlaid;
//  • W3 Panama 3×4 JPEG tile set: all twelve tiles open and display, the virtual mosaic covers the
//    union of their GDAL extents;
//  • W4 the Pléiades DIMAP volume as delivered (ZIP): 4-band 16-bit image in product RGB order with
//    the DIMAP sun and time (IMP-21, IMP-22);
//  • W5 Intermap HH/VH/VV: GCP georeferencing at the file's own tie points, Layer Stack of the three
//    polarisations and σ⁰ dB by Band Math against values computed from the file's floats.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles, settledAny, runCommand, record, item, paths, truth } from './helpers.js';

const SPEC = 'c43-field-workflows';
test.describe.configure({ mode: 'parallel', timeout: 1_200_000 });
const P = (id, re) => paths(item(id), ['primary', 'sidecar']).filter((p) => re.test(p.split(/[\\/]/).pop()));
const toastsOf = (frame) => frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => `${[...t.classList].find((c) => c.startsWith('toast-'))}: ${t.textContent}`));
const changes = (frame) => frame.evaluate(() => window.gisworkbench.store.all('change').map((c) => ({ bbox: c.bbox, areaPx: c.areaPx, method: c.method })));

test('TE-C43 IMP-25 SCN-11 REQ-IMG-30 W1 Millerovo: whole-scene change screening at reduced resolution, then an AOI at full resolution', async ({ page }, info) => {
  const files = P('field-phr-millerovo', /(201701300811101|201704290827053).*\.tif$/);
  test.skip(files.length !== 2 || !files.every(existsSync), 'field data not on disk');
  const { frame, logs } = await openApp(page, 'file');
  for (const f of files) await openFiles(frame, [f]);
  await settledAny(frame, 0, 600_000);
  const dims = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => [l.width, l.height, !!l.modelId]));
  const t0 = Date.now();
  const run1 = await runCommand(page, frame, 'chg.detect', { logs, wait: 900_000 });
  const whole = await changes(frame);
  const msWhole = Date.now() - t0;
  const toasts = await toastsOf(frame);
  // An AOI of about 1 km around the scene centre (≈ 2000² px at 0.5 m): full resolution.
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const c = l.groundAt(l.width / 2, l.height / 2);
    const d = 0.005;
    app.setAoi([[c.lon - d, c.lat - d], [c.lon + d, c.lat - d], [c.lon + d, c.lat + d], [c.lon - d, c.lat + d]], 'ground', 'TE AOI');
  });
  const run2 = await runCommand(page, frame, 'chg.detect', { logs, wait: 900_000 });
  const all = await changes(frame);
  const aoi = all.slice(whole.length);
  record(SPEC, info.project.name, { key: 'w1-millerovo-change', dims, whole: { n: whole.length, method: whole[0]?.method, ms: msWhole }, aoi: { n: aoi.length, method: aoi[0]?.method }, run1: run1.errors, run2: run2.errors, toasts });
  expect(dims.every(([w, h, m]) => w * h > 32e6 && m), 'two dates over 32 M px with map models').toBe(true);
  expect(run1.errors, 'whole-scene run').toEqual([]);
  expect(whole.length, 'whole-scene candidates').toBeGreaterThan(0);
  expect(whole[0].method.step, 'screened at reduced resolution').toBeGreaterThan(1);
  expect(toasts.join(' ')).toMatch(/screened at 1\/\d+ resolution/);
  for (const c of whole) expect(c.bbox[2] <= dims[0][0] + 1 && c.bbox[3] <= dims[0][1] + 1, `candidate inside date 1: ${c.bbox}`).toBe(true);
  expect(run2.errors, 'AOI run').toEqual([]);
  expect(aoi[0]?.method.step ?? 1, 'the AOI is compared at full resolution').toBe(1);
  expect(Math.abs(whole[0].method.gain - 1), 'radiometric normalisation between Pléiades dates is plausible').toBeLessThan(0.6);
  expect(logs).toEqual([]);
});

test('TE-C43 SCN-11 REQ-IMG-30 W2 Spratly West Reef 2014-01-11 → 2015-04-17: island building is detected across different grids', async ({ page }, info) => {
  const a = P('field-dg-spratly-west-reef-20140111', /_BROWSE\.tif$/);
  const b = P('field-dg-spratly-west-reef-20150417', /_BROWSE\.tif$/);
  const seam = P('field-dg-spratly-west-reef-20150417', /SEAMLINES_SHAPE\.zip$/);
  test.skip(!a.length || !b.length || ![...a, ...b].every(existsSync), 'field data not on disk');
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, a);
  await openFiles(frame, b);
  if (seam.length) await openFiles(frame, seam);
  await settledAny(frame, 0, 300_000);
  const run = await runCommand(page, frame, 'chg.detect', { logs, wait: 600_000 });
  const got = await changes(frame);
  const area = got.reduce((s, c) => s + c.areaPx, 0);
  const vlayers = await frame.evaluate(() => window.gisworkbench.store.all('vlayer').length);
  record(SPEC, info.project.name, { key: 'w2-spratly-west-reef', n: got.length, area, method: got[0]?.method, vlayers, errors: run.errors });
  expect(run.errors).toEqual([]);
  expect(got[0]?.method.sameGrid, 'the two deliveries are on different grids (resampled through their models)').toBe(false);
  expect(got.length, 'change candidates (reclaimed land, new structures)').toBeGreaterThan(0);
  if (seam.length) expect(vlayers, 'seamline overlay').toBeGreaterThan(0);
  expect(logs).toEqual([]);
});

test('TE-C43 REQ-FMT-04 REQ-IMG-03 PRF-03 W3 Panama 3×4 JPEG tile set: every tile displays and the virtual mosaic covers their union', async ({ page }, info) => {
  const it = item('field-dg-panama');
  const files = paths(it, ['primary']);
  const T = truth(it.id);
  test.skip(files.length !== 12 || !files.every(existsSync) || !T, 'field data or truth missing');
  const { frame, logs } = await openApp(page, 'file');
  const t0 = Date.now();
  await openFiles(frame, files);
  const settled = await settledAny(frame, 0, 900_000);
  const msDisplay = Date.now() - t0;
  const ls = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ name: l.rec.name, error: l.error ?? null, ready: !!l.lutTex })));
  const run = await runCommand(page, frame, 'img.vmosaic', { logs, wait: 300_000 });
  const ext = await frame.evaluate(() => {
    const ls = [...window.gisworkbench.layers.values()];
    const pts = ls.flatMap((l) => [[0, 0], [l.width, l.height]].map(([x, y]) => l.groundAt(x, y)));
    return { lat: [Math.min(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lat))], lon: [Math.min(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lon))], mosaic: window.gisworkbench.activePane()?.ootf?.sources?.length ?? 0 };
  });
  const gd = Object.values(T.files).map((f) => f.corners);
  const ref = { lat: [Math.min(...gd.map((k) => k.ll[0])), Math.max(...gd.map((k) => k.ul[0]))], lon: [Math.min(...gd.map((k) => k.ul[1])), Math.max(...gd.map((k) => k.ur[1]))] };
  const px = Math.abs(Object.values(T.files)[0].geotransform[1]);
  const err = Math.max(...['lat', 'lon'].flatMap((k) => [0, 1].map((i) => Math.abs(ext[k][i] - ref[k][i])))) / px;
  record(SPEC, info.project.name, { key: 'w3-panama-tiles', settled, msDisplay, layers: ls, mosaicSources: ext.mosaic, extentErrorPx: err, run: run.errors });
  expect(ls.filter((l) => l.error), 'tiles that failed').toEqual([]);
  expect(settled, 'all 12 tiles displayed').toBe(true);
  expect(run.errors).toEqual([]);
  expect(ext.mosaic, 'virtual mosaic sources').toBe(12);
  expect(err, 'union extent vs GDAL corners (pixels)').toBeLessThanOrEqual(0.5);
  expect(logs).toEqual([]);
});

test('TE-C43 IMP-21 IMP-22 REQ-FMT-20 REQ-FMT-21 W4 the Pléiades DIMAP volume opens from its delivery ZIP in product colours with sun and time', async ({ page }, info) => {
  const [zip] = paths(item('field-phr-dimap-zip'), ['primary']);
  const T = truth('field-phr-dimap');
  test.skip(!zip || !existsSync(zip), 'field data not on disk');
  const tif = Object.entries(T?.files ?? {}).find(([n]) => /^IMG_.*\.TIF$/i.test(n))?.[1];
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(() => (window.gisworkbench.zipPick = 'default'));
  const t0 = Date.now();
  const log = await openFiles(frame, [zip]);
  await settledAny(frame, 0, 600_000);
  const ms = Date.now() - t0;
  const ls = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ name: l.rec.name, error: l.error ?? null, w: l.width, h: l.height, nb: l.bands, type: l.sampleType, bands: l.chain.bands, sun: l.info.sun, datetime: l.info.datetime, model: l.modelName })));
  record(SPEC, info.project.name, { key: 'w4-pleiades-dimap-zip', ms, layers: ls, log: log.map((r) => ({ file: r.file, errors: r.errors, warnings: r.warnings })) });
  const img = ls.find((l) => /^IMG_.*\.TIF$/i.test(l.name));
  expect(img, 'the IMG raster opened from the ZIP').toBeTruthy();
  expect(img.error).toBeNull();
  if (tif) expect([img.w, img.h, img.nb]).toEqual([tif.width, tif.height, tif.bands]);
  expect(img.bands, 'DIMAP Band_Display_Order R=B2 G=B1 B=B0').toEqual([2, 1, 0]);
  expect(img.sun?.azimuth).toBeCloseTo(147.16, 1);
  expect(img.sun?.elevation).toBeCloseTo(55.0, 1);
  expect(img.datetime).toBe('20180421015732');
  expect(ls.filter((l) => /PREVIEW|ICON|LOGO/i.test(l.name)), 'quick looks are not opened by default').toEqual([]);
  expect(logs).toEqual([]);
});

test('TE-C43 REQ-SNS-09 REQ-MSI-04 W5 Intermap HH/VH/VV: GCP geolocation, Layer Stack and σ⁰ dB vs the file floats', async ({ page }, info) => {
  const files = paths(item('field-intermap-sar'), ['primary']).sort();
  test.skip(files.length !== 3 || !files.every(existsSync), 'field data not on disk');
  // Reference: the file's own tie points and floats (geotiff.js in Node).
  const buf = readFileSync(files[0]);
  const tiff = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const im = await tiff.getImage();
  const tp = Array.from((await im.fileDirectory.loadValue?.('ModelTiepoint')) ?? im.fileDirectory.ModelTiepoint ?? []);
  const gcps = [];
  for (let i = 0; i + 5 < tp.length; i += 6) gcps.push({ x: tp[i], y: tp[i + 1], lon: tp[i + 3], lat: tp[i + 4] });
  const win = [5000, 3000, 64, 64];
  const ref = await Promise.all(files.map(async (f) => {
    const b = readFileSync(f);
    const t = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    const [r] = await (await t.getImage()).readRasters({ window: [win[0], win[1], win[0] + win[2], win[1] + win[3]], samples: [0] });
    return r;
  }));
  const { frame, logs } = await openApp(page, 'file');
  for (const f of files) await openFiles(frame, [f]);
  await settledAny(frame, 0, 600_000);
  const res = await frame.evaluate(async ({ gcps, win }) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].sort((a, b) => a.rec.name.localeCompare(b.rec.name));
    const l = ls[0];
    const geo = gcps.map((g) => {
      const p = l.groundAt(g.x, g.y);
      return p ? { dLat: p.lat - g.lat, dLon: p.lon - g.lon } : null;
    });
    try {
      const S = await app.msi.stack(ls, { window: { x0: win[0], y0: win[1], w: win[2], h: win[3] } });
      const db = await app.msi.bandMathValues(S, { text: '10 * log10(b1)' });
      return { model: l.modelName, geo, stackBands: S.bands, db: Array.from(db.v), w: db.w };
    } catch (e) {
      return { model: l.modelName, geo, error: e.message };
    }
  }, { gcps, win });
  const px = gcps.length >= 2 ? Math.abs(gcps[1].lon - gcps[0].lon) / Math.max(1, Math.abs(gcps[1].x - gcps[0].x)) || Math.abs(gcps[1].lat - gcps[0].lat) / Math.max(1, Math.abs(gcps[1].y - gcps[0].y)) : NaN;
  const geoErrPx = Math.max(...res.geo.filter(Boolean).map((g) => Math.hypot(g.dLat, g.dLon))) / px;
  let dbMax = 0;
  let n = 0;
  for (let i = 0; i < (res.db?.length ?? 0); i++) {
    const v = ref[0][i];
    if (!(v > 0) || !Number.isFinite(res.db[i])) continue;
    dbMax = Math.max(dbMax, Math.abs(res.db[i] - 10 * Math.log10(v)));
    n++;
  }
  record(SPEC, info.project.name, { key: 'w5-intermap-sar', model: res.model, gcps: gcps.length, geoErrPx, stackBands: res.stackBands, dbCompared: n, dbMax, error: res.error ?? null });
  expect(gcps.length, 'tie points in the file').toBeGreaterThanOrEqual(3);
  expect(res.geo.every(Boolean), 'every tie point maps to the ground').toBe(true);
  expect(geoErrPx, 'app geolocation at the file tie points (pixels)').toBeLessThanOrEqual(1);
  expect(res.error ?? null, 'Layer Stack + Band Math').toBeNull();
  expect(res.stackBands).toBe(3);
  expect(n, 'σ⁰ samples compared').toBeGreaterThan(1000);
  expect(dbMax, 'σ⁰ dB vs 10·log10 of the file floats').toBeLessThanOrEqual(1e-3);
  expect(logs).toEqual([]);
});
