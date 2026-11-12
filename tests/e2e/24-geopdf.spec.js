// REQ-GAP-66 (SDP-2.3 §2 GR-24, group geopdf): GeoPDF in and out of the built app.
//   Read: GDAL-written GeoPDFs (fixtures/fx24/geopdf, made by build/fixtures/fx24-geopdf.mjs) open
//   as vector layers with their attributes (a vector-only page, Flate-compressed, in UTM), or as a
//   raster with its vector layers on top; US Topo (T&E corpus, when present) brings its
//   optional-content layers.
//   Write: File ▸ Save As ▸ GeoPDF Map in a projected CRS with a main and an overview frame, the
//   vector layers with attributes and Unicode labels (fonts-noto pack), checked by reopening the
//   file in the app and, when GDAL is installed (test-time oracle, never shipped), by GDAL's PDF
//   driver. The dialog passes axe.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openApp, openFiles, DIST_DIR } from './helpers.js';

test.describe.configure({ timeout: 300000 });

const FX = resolve('fixtures/fx24/geopdf');
const FX12 = JSON.parse(readFileSync('fixtures/fx12/fx12.geojson', 'utf8'));
const PACK = existsSync(join(DIST_DIR, 'packs')) ? readdirSync(join(DIST_DIR, 'packs')).find((f) => /^fonts-noto-.*\.gwpack$/.test(f)) : null;
const GDAL = process.env.GW_GDAL_BIN ?? 'E:/gwb-sidecar-deps/osgeo4w/root/bin';
const haveGdal = existsSync(join(GDAL, 'ogr2ogr.exe')) || existsSync(join(GDAL, 'ogr2ogr'));
const gdal = (cmd, args) => execFileSync(join(GDAL, cmd), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${GDAL}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, GDAL_DATA: resolve(GDAL, '../apps/gdal/share/gdal'), PROJ_DATA: resolve(GDAL, '../share/proj'), PROJ_LIB: resolve(GDAL, '../share/proj') } });
const TOPO = resolve('..', 'TE-corpus', 'geopdf-ustopo-vinehill-2012', 'CA_Vine_Hill_20120213_TM_geo.pdf');

async function ready(page) {
  await page.addInitScript(() => delete window.showSaveFilePicker); // saves become downloads
  return openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online' } });
}

/** Vector layers of the project: [{name, format, n, feats: [{name, attrs, geom (GeoJSON)}]}]. */
const vlayers = (frame) =>
  frame.evaluate(() => {
    const S = window.gisworkbench.store;
    return S.all('vlayer').map((v) => {
      const fs = S.all('feature').filter((f) => f.vlayer === v.id);
      return { name: v.name, format: v.source?.format, n: fs.length, style: v.style, feats: fs.map((f) => ({ name: f.name, attrs: f.attrs, type: f.geom.type, xyz: [...f.geom.xyz] })) };
    });
  });

const flat = (c) => (typeof c[0] === 'number' ? [c] : c.flatMap(flat));

test('REQ-GAP-66 read: a vector-only GDAL GeoPDF (UTM 11N, Flate) opens as a layer with its Unicode attributes', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const log = await openFiles(frame, [join(FX, 'gdal_fx12_utm11n.pdf')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  expect(await frame.evaluate(() => window.gisworkbench.layers.size)).toBe(0); // no raster on the page
  const [L] = await vlayers(frame);
  expect(L.name).toBe('fx12');
  expect(L.format).toBe('GeoPDF');
  // GDAL's writer draws nothing for the MultiPoint "Wells": 10 features with geometry, the 11th reported.
  expect(L.n).toBe(10);
  expect(log.flatMap((r) => r.warnings).join('\n')).toMatch(/draws nothing/);
  const byName = new Map(L.feats.map((f) => [f.name, f]));
  expect(byName.get('Склад').attrs.class_code).toBe('AL013');
  expect(byName.get('Склад').attrs.long_description_text).toBe('Кириллица');
  expect(byName.get('仓库').attrs.long_description_text).toBe('中文说明');
  // Vertices back in WGS 84 within 1e-6° of the FX-12 source (GDAL's writer keeps 6 decimals of a point).
  // (The store keeps rings without their closing vertex: each stored vertex against its nearest source vertex.)
  let dmax = 0;
  for (const f of FX12.features.slice(0, 10)) {
    const got = byName.get(f.properties.name);
    const src = flat(f.geometry.coordinates);
    for (let k = 0; k < got.xyz.length; k += 3) dmax = Math.max(dmax, Math.min(...src.map((c) => Math.max(Math.abs(got.xyz[k] - c[0]), Math.abs(got.xyz[k + 1] - c[1])))));
    expect(got.xyz.length / 3).toBeGreaterThanOrEqual(new Set(src.map((c) => `${c[0]},${c[1]}`)).size);
  }
  expect(dmax).toBeLessThan(1e-6);
  expect(logs).toEqual([]);
});

test('REQ-GAP-66 read: a GDAL raster GeoPDF (NAIP, UTM 10N NAD83) opens georeferenced with its vector layer on top', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const log = await openFiles(frame, [join(FX, 'gdal_naip_fx12.pdf')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    await app.geoPdfVectors;
    const l = [...app.layers.values()][0];
    const c = l.groundAt(l.width / 2, l.height / 2);
    return { model: l.modelName, w: l.width, h: l.height, lat: c.lat, lon: c.lon };
  });
  expect(r.model).toMatch(/GeoPDF viewport/);
  const [L] = await vlayers(frame);
  expect(L.n).toBe(10);
  // GDAL's own read-back of the same file (EPSG:26910) is the reference for the vertices.
  const truth = JSON.parse(readFileSync(join(FX, 'gdal_naip_fx12_gdal.geojson'), 'utf8'));
  const tf = truth.features.find((f) => f.properties.name === 'Склад');
  const got = L.feats.find((f) => f.name === 'Склад');
  expect(got.type).toBe('Polygon');
  expect(tf.geometry.coordinates[0]).toHaveLength(got.xyz.length / 3 + 1); // the store drops the closing vertex
  // The polygon's centre lies on the raster (the vector layer and the image share the frame).
  const cx = got.xyz.filter((_, i) => i % 3 === 0).reduce((s, v) => s + v, 0) / (got.xyz.length / 3);
  expect(Math.abs(cx - r.lon)).toBeLessThan(0.003);
  expect(logs).toEqual([]);
});

test('REQ-GAP-66 read: US Topo optional-content layers (T&E corpus)', async ({ page }) => {
  test.skip(!existsSync(TOPO), 'T&E corpus not present');
  const { frame, logs } = await ready(page);
  const log = await openFiles(frame, [TOPO]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.evaluate(() => window.gisworkbench.geoPdfVectors);
  const ls = await vlayers(frame);
  const counts = JSON.parse(readFileSync(join(FX, 'ustopo_vinehill_2012_gdal_counts.json'), 'utf8')).layers;
  const roads = ls.find((l) => l.name === 'Map Frame / Transportation / Roads');
  expect(roads).toBeTruthy();
  expect(Math.abs(roads.n - counts.Map_Frame_Transportation_Roads) / counts.Map_Frame_Transportation_Roads).toBeLessThan(0.01);
  expect(ls.find((l) => /Map Collar/.test(l.name))).toBeUndefined(); // the collar is outside the map frame
  expect(ls.length).toBeGreaterThanOrEqual(10);
  // A map of more than 7,000 features opens with its layers hidden (roaming stays at 60 fps).
  expect(await frame.evaluate(() => window.gisworkbench.store.all('vlayer').every((v) => v.visible === false))).toBe(true);
  // First tile from the preview level; full resolution drawn tile by tile: the same ground at
  // full resolution and at the preview level agrees (band means within 4 DN).
  const lv = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    const LP = l.info.meta.previewLevel;
    const [x, y, w, h] = [Math.round(l.width * 0.4), Math.round(l.height * 0.4), 1024, 1024];
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const out = [];
    for (const band of [0, 1, 2]) {
      const full = await app.pool.run('patch', { handle: l.handle, x, y, w, h, band }, { affinity: l.affinity });
      const coarse = await app.pool.run('patchLevel', { handle: l.handle, level: LP, x, y, w, h, band }, { affinity: l.affinity });
      out.push([mean(full.px), mean(coarse.px)]);
    }
    return { LP, out };
  });
  expect(lv.LP).toBeGreaterThan(0);
  for (const [a, b] of lv.out) expect(Math.abs(a - b)).toBeLessThan(4);
  expect(lv.out.some(([a]) => a < 250)).toBe(true); // not a blank (white) window
  expect(logs).toEqual([]);
});

test('REQ-GAP-66 read: US Topo 2022 (viewport BBox written top first) opens north up, as GDAL reads it', async ({ page }) => {
  const f = resolve('..', 'TE-corpus', 'geopdf-ustopo-vinehill-honkerbay-current', 'CA_Honker_Bay_20220107_TM_geo.pdf');
  test.skip(!existsSync(f), 'T&E corpus not present');
  const { frame, logs } = await ready(page);
  expect((await openFiles(frame, [f])).flatMap((r) => r.errors)).toEqual([]);
  const r = await frame.evaluate(() => {
    const l = [...window.gisworkbench.layers.values()][0];
    return { tl: l.groundAt(0, 0), bl: l.groundAt(0, l.height), tr: l.groundAt(l.width, 0) };
  });
  // GDAL 3.13.3 `gdalinfo -json -oo DPI=72` wgs84Extent: the page's upper left, lower left and
  // upper right (the image is the viewport, which spans the page width and its full height above y = 49 pt).
  const m = (a, lat, lon) => Math.hypot((a.lat - lat) * 111000, (a.lon - lon) * 88000);
  expect(m(r.tl, 38.138179, -122.0204778)).toBeLessThan(25);
  expect(m(r.tr, 38.138176, -121.8535435)).toBeLessThan(25);
  expect(r.bl.lat).toBeLessThan(37.99); // 2.3 had the south edge at the top
  expect(logs).toEqual([]);
});

test('REQ-GAP-66 write: GeoPDF Map in UTM with an overview frame, attributes and Unicode labels; reopened by the app and GDAL', async ({ page }) => {
  const { frame, logs } = await ready(page);
  if (PACK) expect((await openFiles(frame, [join(DIST_DIR, 'packs', PACK)])).flatMap((r) => r.errors)).toEqual([]);
  await openFiles(frame, [join(FX, 'gdal_naip_fx12.pdf')]);
  await frame.evaluate(() => window.gisworkbench.geoPdfVectors);
  // The dialog passes axe.
  const axe = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axe);
  void frame.evaluate(() => window.gisworkbench.commands.run('file.geopdf'));
  const dlg = frame.locator('[data-id="dialog:geopdf"]');
  await expect(dlg).toBeVisible();
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:geopdf"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`));
  expect(v).toEqual([]);
  // Save through the dialog: the download is the GeoPDF.
  const dl = page.waitForEvent('download');
  await dlg.getByRole('button', { name: 'Save GeoPDF…' }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toMatch(/_geo\.pdf$/);
  const bytes = readFileSync(await d.path());
  const text = bytes.toString('latin1');
  expect(text.match(/\/Type \/Viewport/g)).toHaveLength(2);
  expect(text).toMatch(/\/Type \/PROJCS \/EPSG 32610 /); // UTM zone of the view, WGS 84
  expect(text).toMatch(/\/S \/feature /);
  if (PACK) expect(text).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
  // Reopen in a new page: imagery georeferenced, the vector layer with its attributes.
  const page2 = await page.context().newPage();
  const { frame: f2 } = await ready(page2);
  const dir = join(tmpdir(), 'gw-geopdf-e2e');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'written_geo.pdf');
  writeFileSync(out, bytes);
  expect((await openFiles(f2, [out])).flatMap((r) => r.errors)).toEqual([]);
  const back = await f2.evaluate(async () => {
    const app = window.gisworkbench;
    await app.geoPdfVectors;
    const l = [...app.layers.values()][0];
    return { model: l?.modelName };
  });
  expect(back.model).toMatch(/GeoPDF viewport/);
  const ls = await vlayers(f2);
  const fx = ls.find((l) => l.name === 'fx12');
  expect(fx?.n).toBe(10);
  const src = (await vlayers(frame)).find((l) => l.name === 'fx12');
  // Round trip in WGS 84: within 1 cm of the layer that was written.
  let dmax = 0;
  for (const f of src.feats) {
    const g = fx.feats.find((x) => x.name === f.name);
    expect(g.attrs.class_code).toBe(f.attrs.class_code);
    for (let k = 0; k < f.xyz.length; k += 3) dmax = Math.max(dmax, Math.hypot((g.xyz[k] - f.xyz[k]) * 91000, (g.xyz[k + 1] - f.xyz[k + 1]) * 111000));
  }
  expect(dmax).toBeLessThan(0.01);
  // GDAL's PDF driver (oracle): the CRS, the layer, its attribute values.
  if (haveGdal) {
    const info = JSON.parse(gdal('gdalinfo', ['-json', out]));
    expect(info.coordinateSystem.wkt).toMatch(/ID\["EPSG",32610\]\]$/);
    const gj = join(dir, 'written_geo.geojson');
    if (existsSync(gj)) rmSync(gj);
    gdal('ogr2ogr', ['-f', 'GeoJSON', gj, out]);
    const g = JSON.parse(readFileSync(gj, 'utf8'));
    expect(g.name).toBe('fx12');
    expect(g.features).toHaveLength(10);
    expect(g.features.map((x) => x.properties.name)).toEqual(expect.arrayContaining(['Склад', '仓库', 'Мачта']));
  }
  await page2.close();
  expect(logs).toEqual([]);
});

test('REQ-GAP-66 write: vectors only (no imagery) in Albers, Web Mercator and WGS 84', async ({ page }) => {
  const { frame, logs } = await ready(page);
  await openFiles(frame, [join(FX, 'gdal_fx12_utm11n.pdf')]);
  for (const epsg of [5070, 3857, 4326]) {
    const r = await frame.evaluate(async (epsg) => {
      const x = await window.gisworkbench.geopdf.exportMap({ epsg, overview: epsg !== 4326, imagery: false });
      return { epsg: x.epsg, frames: x.frames, features: x.features, b64: btoa(Array.from(x.bytes, (b) => String.fromCharCode(b)).join('')) };
    }, epsg);
    expect(r.epsg).toBe(epsg);
    expect(r.frames).toBe(epsg === 4326 ? 1 : 2);
    expect(r.features).toBe(10);
    const text = Buffer.from(r.b64, 'base64').toString('latin1');
    expect(text).toContain(`/EPSG ${epsg} `);
    expect(text).toContain(epsg === 4326 ? '/Type /GEOGCS' : '/Type /PROJCS');
    if (haveGdal) {
      const dir = join(tmpdir(), 'gw-geopdf-e2e');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `vec_${epsg}.pdf`);
      writeFileSync(f, Buffer.from(r.b64, 'base64'));
      const info = JSON.parse(gdal('ogrinfo', ['-json', '-so', '-al', f]));
      expect(info.layers[0].featureCount).toBe(10);
    }
  }
  expect(logs).toEqual([]);
});
