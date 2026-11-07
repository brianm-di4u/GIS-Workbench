// 2.1 tiles group (SDP-2.1 FC-05..07, P10/P14; REQ-FMT-28..33, REQ-NET-05): MBTiles raster and
// vector, PMTiles with every compression (FX-21 fixtures written by Node's own encoders and checked
// by GDAL/OGR and the protomaps Python reader), vector tiles drawn, identified, extracted and used
// as a basemap, and the tile writers read back — against the build in TILES_DIST, from file://, with
// no console error, CSP violation or network request.
//
//   node build/fixtures/fxformats21.mjs --only=tiles
//   TILES_DIST=dist-21-tiles/gis-workbench.html npx playwright test tests/e2e/21-tiles.spec.js --project=chrome --workers=2
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openApp, openFiles, DIST as HELPERS_DIST } from './helpers.js';

const DIST = process.env.TILES_DIST ? resolve(process.env.TILES_DIST) : HELPERS_DIST; // or GW_DIST (helpers.js)
const FX = resolve('fixtures/fx21/tiles');
const fx = (n) => join(FX, n);
const C = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
const cp = (...p) => join(C, ...p);
const MAN = existsSync(fx('manifest.json')) ? JSON.parse(readFileSync(fx('manifest.json'), 'utf8')).files : {};

test.describe.configure({ mode: 'parallel' });
test.skip(!existsSync(DIST) || !existsSync(fx('manifest.json')), 'build or FX-21 tiles fixtures missing');

async function boot(page) {
  const s = await openApp(page, 'file', { htmlPath: DIST, prefs: { layout: 'classic', network: 'offline' } });
  return s;
}
async function clean(s) {
  expect(s.logs, 'console errors').toEqual([]);
  expect(s.requests, 'network requests').toEqual([]);
  expect(await s.csp(), 'CSP violations').toEqual([]);
}
const layersOf = (frame) => frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ w: l.width, h: l.height, bands: l.bands, model: l.modelName, kind: l.info?.kind, meta: { vector: l.info?.meta?.vector, container: l.info?.meta?.container, minZoom: l.info?.meta?.minZoom, maxZoom: l.info?.meta?.maxZoom } })));
const pixel = (frame, x, y) => frame.evaluate(async ([x, y]) => {
  const a = window.gisworkbench;
  const l = [...a.layers.values()][0];
  const r = await a.pool.run('pixels', { handle: l.handle, x, y, w: 1, h: 1, bands: [0, 1, 2] }, { affinity: l.affinity });
  return (r.planes ?? r.values ?? r).map((p) => (p.length !== undefined ? p[0] : p));
}, [x, y]);

test('REQ-FMT-28 a raster MBTiles opens on GDAL\'s grid with exact pixels (TMS flip)', async ({ page }) => {
  const s = await boot(page);
  const log = await openFiles(s.frame, [fx('fx21_raster_png.mbtiles')]);
  expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
  const [l] = await layersOf(s.frame);
  // gdalinfo: Size is 1024, 1024 (zoom 2, EPSG:3857).
  expect(l).toMatchObject({ w: 1024, h: 1024, bands: 3, model: 'Map (EPSG:3857)', kind: 'tileset', meta: { container: 'MBTiles', maxZoom: 2 } });
  // Tile z2/x1/y3 (XYZ; TMS row 0): R = 90, G = 8, B = 24 inside its frame.
  expect(await pixel(s.frame, 256 + 100, 768 + 100)).toEqual([90, 8, 24]);
  expect(await pixel(s.frame, 256, 768)).toEqual([0, 0, 0]); // the 1-px frame
  await clean(s);
});

test('REQ-FMT-28 MBTiles bounds cut tiles the way GDAL does (597 × 508 at zoom 3)', async ({ page }) => {
  const s = await boot(page);
  await openFiles(s.frame, [fx('fx21_raster_bounds.mbtiles')]);
  const [l] = await layersOf(s.frame);
  expect([l.w, l.h]).toEqual([597, 508]);
  await clean(s);
});

for (const c of ['none', 'gzip', 'brotli', 'zstd']) {
  test(`REQ-FMT-30 REQ-FMT-32 vector PMTiles, ${c} directories and tiles: drawn, extracted (OGR: 16 per layer)`, async ({ page }) => {
    const s = await boot(page);
    const log = await openFiles(s.frame, [fx(`fx21_vector_${c}.pmtiles`)]);
    expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
    const [l] = await layersOf(s.frame);
    expect(l).toMatchObject({ kind: 'tileset', meta: { vector: true, container: 'PMTiles', minZoom: 0, maxZoom: 2 } });
    const r = await s.frame.evaluate(() => window.gisworkbench.tilesets.extract({ scope: 'all', clip: false }));
    expect(Object.fromEntries(r.layers.map((x) => [x.name, x.features]))).toEqual(MAN[`fx21_vector_${c}.pmtiles`].layers);
    // Attributes and the MVT id come through (GDAL's mvt_id).
    const f = await s.frame.evaluate(() => {
      const a = window.gisworkbench;
      const v = a.store.all('vlayer').find((x) => /points$/.test(x.name));
      const f = a.store.all('feature').find((x) => x.vlayer === v.id && x.name === 'p2/1/1');
      return f && { ...f.attrs, name: f.name };
    });
    expect(f).toMatchObject({ mvt_id: 2011, name: 'p2/1/1', z: 2, flag: true });
    await clean(s);
  });
  test(`REQ-FMT-30 raster PMTiles, ${c} directories: a layer alone, a basemap under an image`, async ({ page }) => {
    const s = await boot(page);
    const log = await openFiles(s.frame, [fx(`fx21_raster_${c}.pmtiles`)]);
    expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
    const [l] = await layersOf(s.frame);
    expect(l).toMatchObject({ w: 1024, h: 1024, kind: 'tileset', meta: { container: 'PMTiles', maxZoom: 2 } });
    expect(await pixel(s.frame, 356, 868)).toEqual([90, 8, 24]);
    await openFiles(s.frame, [fx(`fx21_raster_${c}.pmtiles`)]);
    expect(await s.frame.evaluate(() => window.gisworkbench.basemapCurrent()?.maxZoom)).toBe(2);
    await clean(s);
  });
}

test('REQ-FMT-30 leaf directories (gzip and Brotli) and a cut Brotli archive refused by name', async ({ page }) => {
  const s = await boot(page);
  for (const c of ['gzip', 'brotli']) {
    await openFiles(s.frame, [fx(`fx21_vector_${c}_leaves.pmtiles`)]);
    const r = await s.frame.evaluate(() => window.gisworkbench.tilesets.extract({ scope: 'all', clip: false }));
    expect(r.features).toBe(48);
    await s.frame.evaluate(() => {
      const a = window.gisworkbench;
      for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
      a.desktop.addMultiport(a.newProject());
    });
  }
  await openFiles(s.frame, [fx('fx21_vector_brotli_cut.pmtiles')]);
  const said = await s.frame.evaluate(async () => {
    try {
      await window.gisworkbench.tilesets.extract({ scope: 'all', clip: false });
      return 'no error';
    } catch (e) {
      return e.message;
    }
  });
  expect(said).toMatch(/Brotli|cut short|damaged|past the end/);
  await clean(s);
});

test('REQ-FMT-32 identify finds the features under a point', async ({ page }) => {
  const s = await boot(page);
  await openFiles(s.frame, [fx('fx21_vector_gzip.pmtiles')]);
  // The centre of tile z2/1/1 (its point) lies at lon −45°, lat 40.98°.
  const r = await s.frame.evaluate(() => window.gisworkbench.tilesets.identify(40.979898, -45, { zoom: 2 }));
  expect(r.tile).toEqual([2, 1, 1]);
  expect(r.features[0]).toMatchObject({ layer: 'points', type: 'Point', properties: { name: 'p2/1/1' } });
  expect(r.features.some((f) => f.layer === 'polygons')).toBe(false); // the point is in the square's hole
  await clean(s);
});

test('REQ-FMT-32 Identify Tile Features: click a place, the features and attributes are listed', async ({ page }) => {
  const s = await boot(page);
  await openFiles(s.frame, [fx('fx21_vector_gzip.pmtiles')]);
  await s.frame.evaluate(() => void window.gisworkbench.commands.run('vt.identify')); // it waits for the click
  const box = await s.frame.evaluate(() => {
    const r = window.gisworkbench.activePane().el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  const dlg = s.frame.locator('[data-id="vt:identify"]');
  await expect(dlg).toBeVisible({ timeout: 10000 });
  await expect(dlg).toContainText(/features? at the point/); // ICU plural since 2.3 (DN-62 rule 2)
  await clean(s);
});

test('REQ-FMT-32 S-46 the vector renderer draws a Protomaps extract (non-uniform, water and roads)', async ({ page }) => {
  const f = cp('vector-pmtiles-mvt-protomaps', 'protomaps_vector_ODbL_firenze.pmtiles');
  test.skip(!existsSync(f), 'T&E corpus absent');
  const s = await boot(page);
  await openFiles(s.frame, [f]);
  const st = await s.frame.evaluate(async () => {
    const a = window.gisworkbench;
    const l = [...a.layers.values()][0];
    const t0 = performance.now();
    const w = await a.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: 512, h: 512, step: 4, bands: [0, 1, 2] }, { affinity: l.affinity });
    const ms = performance.now() - t0;
    const colours = new Set();
    let water = 0;
    for (let i = 0; i < w.planes[0].length; i++) {
      const c = [w.planes[0][i], w.planes[1][i], w.planes[2][i]];
      colours.add(c.join(','));
      if (c[2] > c[0] + 40) water++; // bluish: the Arno and other water
    }
    return { colours: colours.size, water, ms, w: l.width, h: l.height };
  });
  expect(st.colours).toBeGreaterThan(20);
  expect(st.water).toBeGreaterThan(50);
  expect(st.ms).toBeLessThan(5000);
  await clean(s);
});

test('REQ-FMT-32 REQ-NET-05 a vector PMTiles is a basemap under a georeferenced image', async ({ page }) => {
  const s = await boot(page);
  await openFiles(s.frame, [fx('fx21_raster_png.mbtiles')]);
  await openFiles(s.frame, [fx('fx21_vector_zstd.pmtiles')]);
  const b = await s.frame.evaluate(() => {
    const x = window.gisworkbench.basemapCurrent();
    return { vector: x?.vector, worker: !!x?.worker, maxZoom: x?.maxZoom };
  });
  expect(b).toEqual({ vector: true, worker: true, maxZoom: 6 });
  // Tiles are drawn in the worker and come back as bitmaps: the panel shows the basemap.
  await s.frame.waitForFunction(() => window.gisworkbench.activePane()._basemapShown?.vector === true, null, { timeout: 15000 });
  const bmp = await s.frame.evaluate(async () => {
    const a = window.gisworkbench;
    const x = a.basemapCurrent();
    const r = await a.pool.run('tsTile', { handle: x.worker.handle, z: 3, x: 2, y: 3, size: 256 }, { affinity: x.worker.affinity });
    return r.bmp ? [r.bmp.width, r.bmp.height] : null;
  });
  expect(bmp).toEqual([256, 256]); // over-zoomed from zoom 2
  await clean(s);
});

test('REQ-FMT-30 the corpus Brotli PMTiles (pmtiles-rs fixture) opens', async ({ page }) => {
  const f = cp('raster-pmtiles-martin-pmtilesrs-fixtures', 'single_tile_brotli.pmtiles');
  test.skip(!existsSync(f), 'T&E corpus absent');
  const s = await boot(page);
  const log = await openFiles(s.frame, [f]);
  expect(log.flatMap((r) => r.errors ?? [])).toEqual([]);
  const [l] = await layersOf(s.frame);
  expect(l).toMatchObject({ kind: 'tileset', meta: { container: 'PMTiles' } });
  // And as a basemap on the main thread (Brotli through the decode worker).
  await openFiles(s.frame, [f]);
  expect(await s.frame.evaluate(() => !!window.gisworkbench.basemapCurrent()?.pm)).toBe(true);
  await clean(s);
});

test('REQ-FMT-29 REQ-FMT-31 an image tiled to PMTiles and MBTiles reopens with the same pixels', async ({ page }) => {
  const s = await boot(page);
  await openFiles(s.frame, [fx('fx21_raster_png.mbtiles')]);
  const out = await s.frame.evaluate(async () => {
    const a = window.gisworkbench;
    const l = [...a.layers.values()][0];
    const res = {};
    for (const to of ['pmtiles', 'mbtiles']) {
      const r = await a.tilesets.tileImage(l, { to, type: 'png', minZoom: 0, maxZoom: 2, save: false });
      res[to] = { tiles: r.tiles, bytes: Array.from(r.bytes) };
    }
    return res;
  });
  expect(out.pmtiles.tiles).toBe(21);
  expect(out.mbtiles.tiles).toBe(21);
  // Re-read the MBTiles: same grid, same pixel as the source.
  const again = await s.frame.evaluate(async (bytes) => {
    const a = window.gisworkbench;
    for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
    a.desktop.addMultiport(a.newProject());
    await a.openFiles([new File([new Uint8Array(bytes)], 'again.mbtiles')]);
    const l = [...a.layers.values()][0];
    const p = await a.pool.run('pixels', { handle: l.handle, x: 356, y: 868, w: 1, h: 1, bands: [0, 1, 2] }, { affinity: l.affinity });
    return { w: l.width, h: l.height, p: (p.planes ?? p.values ?? p).map((q) => (q.length !== undefined ? q[0] : q)) };
  }, out.mbtiles.bytes);
  expect(again).toEqual({ w: 1024, h: 1024, p: [90, 8, 24] });
  await clean(s);
});

test('REQ-FMT-33 a vector layer tiled to MVT (PMTiles, MBTiles) reads back feature for feature', async ({ page }) => {
  const s = await boot(page);
  const r = await s.frame.evaluate(async () => {
    const a = window.gisworkbench;
    const fc = { type: 'FeatureCollection', features: [] };
    for (let i = 0; i < 50; i++) fc.features.push({ type: 'Feature', properties: { i, name: `p${i}` }, geometry: { type: 'Point', coordinates: [10 + i * 0.01, 45 + i * 0.005] } });
    fc.features.push({ type: 'Feature', properties: { name: 'line' }, geometry: { type: 'LineString', coordinates: [[10, 45], [10.5, 45.25]] } });
    fc.features.push({ type: 'Feature', properties: { name: 'area' }, geometry: { type: 'Polygon', coordinates: [[[10.1, 45.1], [10.3, 45.1], [10.3, 45.2], [10.1, 45.2], [10.1, 45.1]]] } });
    await a.openFiles([new File([JSON.stringify(fc)], 'pts.geojson')]);
    const id = a.store.all('vlayer')[0].id;
    const out = {};
    for (const to of ['pmtiles', 'mbtiles']) {
      const t = await a.tilesets.tileVector(id, { to, minZoom: 0, maxZoom: 10, save: false });
      out[to] = { tiles: t.tiles, perZoom: t.perZoom, bytes: Array.from(t.bytes) };
    }
    return out;
  });
  expect(Object.keys(r.pmtiles.perZoom).map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  for (const to of ['pmtiles', 'mbtiles']) {
    const back = await s.frame.evaluate(async ([bytes, to]) => {
      const a = window.gisworkbench;
      for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
      a.desktop.addMultiport(a.newProject());
      await a.openFiles([new File([new Uint8Array(bytes)], `pts.${to}`)]);
      const x = await a.tilesets.extract({ scope: 'all' });
      const names = new Set(a.store.all('feature').map((f) => f.name));
      return { features: x.features, zoom: x.zoom, names: names.size };
    }, [r[to].bytes, to]);
    // Clipped to their tiles: the line and the polygon may come in pieces; each point exactly once.
    expect(back.zoom).toBe(10);
    expect(back.names).toBe(52);
  }
  await clean(s);
});
