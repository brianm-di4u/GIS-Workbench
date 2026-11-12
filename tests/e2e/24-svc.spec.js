// 2.4 group svc (gap wave T0a): online services, service image layers and publishing, against local
// mock services (tests/e2e/svc-mock.js) in a copy of the app with the mock's origin allow-listed.
// REQ-GAP-04 paging and custom STAC · REQ-GAP-05 capabilities, GetFeatureInfo, TIME, CRSs,
// ImageServer, dynamic export, VectorTileServer, I3S · REQ-GAP-06 OGC API, WCS, WPS, SensorThings ·
// REQ-GAP-07 services as image layers · REQ-GAP-59 publish · REQ-GAP-63 typed FeatureServer
// editing · REQ-SEC-12 / REQ-ARC-16 nothing leaves before the origin is allowed.
import { test, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openApp } from './helpers.js';
import { mockServices } from './svc-mock.js';

test.describe.configure({ timeout: 180000 });

let mock;
let origin;
// Each app copy is about 8 MB. They go in one directory per run, removed after the suite.
let dir;
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gw-24-svc-'));
  mock = mockServices();
  origin = await mock.start();
});
test.afterAll(async () => {
  await mock?.close();
  rmSync(dir, { recursive: true, force: true });
  expect(existsSync(dir), `${dir} is left behind`).toBe(false);
});

/** A copy of the app with the mock's origin in the allow-list (the add → save → reload path). */
async function allowed(page) {
  const { frame } = await openApp(page, 'file');
  const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
  const copy = join(dir, `gw-svc-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  writeFileSync(copy, html);
  const page2 = await page.context().newPage();
  const r = await openApp(page2, 'file', { htmlPath: copy });
  await r.frame.evaluate(() => window.gisworkbench.loadServices());
  return { page2, ...r };
}
const quiet = (logs) => logs.filter((l) => !/ERR_CONNECTION_REFUSED|127\.0\.0\.1:4782/.test(l));

test('REQ-SEC-12 REQ-ARC-16 a service origin that is not allowed is refused with no request', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const before = mock.seen.length;
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    await app.loadServices();
    try {
      await app.services.connect(`${o}/wms`, { kind: 'wms' });
      return 'connected';
    } catch (e) {
      return { code: e.code, notAllowed: !!e.notAllowed, logged: app.netlog.entries[0]?.status };
    }
  }, origin);
  expect(r).toEqual({ code: 'E_NET_NOT_ALLOWED', notAllowed: true, logged: 'not allowed' });
  expect(mock.seen.length).toBe(before);
});

test('REQ-GAP-04 paging: ArcGIS offset pages, OGC API next links, SensorThings nextLink; a custom STAC API with paged search', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const S = app.store;
    const out = {};
    // ArcGIS: maxRecordCount 2 → five features in three pages.
    const vl = await app.remoteEdit.open({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Units/FeatureServer/0`, name: 'Units' });
    out.arc = { n: S.all('feature').filter((f) => f.vlayer === vl).length, info: app.remoteEdit.info(vl) };
    // OGC API Features: limit 3 → seven lakes in three pages; a max stops early and says so.
    const svc = await app.services.connect(`${o}/ogc`, { kind: 'ogcapi' });
    out.collections = svc.items.map((i) => `${i.id}:${i.type}`);
    const lakes = svc.items.find((i) => i.id === 'lakes');
    const pages = [];
    const all = await app.services.loadFeatures(svc, lakes, { max: 100, onPage: (p) => pages.push(p.pages) });
    out.ogc = { count: all.count, pages: all.pages };
    out.ogcLimited = await app.services.loadFeatures(svc, lakes, { max: 4 }).then((x) => ({ count: x.count, truncated: x.truncated }));
    // SensorThings: two Things per page → five Things in three pages.
    const sta = await app.services.connect(`${o}/sta/v1.1`, { kind: 'sta' });
    const st = await app.services.loadFeatures(sta, sta.items[0], { max: 100 });
    out.sta = { count: st.count, pages: st.pages, first: S.all('feature').find((f) => f.vlayer === st.vl)?.attrs };
    // STAC: add any STAC API; search pages with POST bodies merged from the next link.
    const api = await app.stacApis.add(`${o}/stac`);
    out.stacApi = { name: api.name, collections: api.collections, listed: app.stacApis.list().some((a) => a.id === api.id) };
    let pg = await app.stacSearchPage(api, { bbox: [7.9, 46.9, 8.2, 47.2], collections: ['ortho'] });
    const ids = pg.features.map((f) => f.id);
    while (pg.next) {
      pg = await app.stacSearchPage(api, {}, pg.next);
      ids.push(...pg.features.map((f) => f.id));
    }
    out.stacIds = ids;
    return out;
  }, origin);
  expect(r.arc.n).toBe(5);
  expect(r.arc.info).toMatchObject({ pages: 3, truncated: false, count: 5 });
  expect(r.collections).toEqual(['lakes:OGC API Features', 'world:OGC API Maps', 'dem:OGC API Coverage', 'meta:OGC API Records', 'echo:OGC API process', 'slow:OGC API process']);
  expect(r.ogc).toEqual({ count: 7, pages: 3 });
  expect(r.ogcLimited).toEqual({ count: 4, truncated: true });
  expect(r.sta.count).toBe(5);
  expect(r.sta.pages).toBe(3);
  expect(r.sta.first).toMatchObject({ thing: 'Station 1', temperature: 20, 'temperature unit': '°C' });
  expect(r.stacApi).toEqual({ name: 'Mock STAC', collections: ['ortho', 'dem'], listed: true });
  expect(r.stacIds).toEqual(['item-1', 'item-2', 'item-3', 'item-4', 'item-5']);
  // The ArcGIS pages asked for 2 at offsets 0, 2 and 4.
  const offs = mock.seen.filter((s) => s.path.endsWith('/Units/FeatureServer/0/query')).map((s) => new URLSearchParams(s.query).get('resultOffset'));
  expect(offs.slice(0, 3)).toEqual(['0', '2', '4']);
  // The STAC search continued with the server's token in the POST body.
  expect(mock.seen.filter((s) => s.path === '/stac/search').map((s) => JSON.parse(s.body).token ?? null)).toEqual([null, '2', '4']);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-04 the Catalog panel adds a STAC API and pages its search with More results', async ({ page }) => {
  const { page2, frame } = await allowed(page);
  await frame.evaluate((o) => window.gisworkbench.stacApis.add(`${o}/stac`), origin);
  await frame.evaluate(() => window.gisworkbench.commands.run('cat.panel'));
  await expect(frame.locator('[data-id="catalog:api"]')).toHaveValue(/custom:/);
  await expect(frame.locator('[data-id="catalog:remove-api"]')).toBeVisible();
  // A search needs an area: the panel takes it from a georeferenced view, so search through the API here.
  const n = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const api = app.stacApis.list().find((a) => a.custom);
    const p = await app.stacSearchPage(api, { bbox: [7.9, 46.9, 8.2, 47.2], collections: [api.collections[0]] });
    return { first: p.features.length, more: !!p.next };
  });
  expect(n).toEqual({ first: 2, more: true });
  await frame.locator('[data-id="catalog:remove-api"]').click();
  expect(await frame.evaluate(() => window.gisworkbench.stacApis.list().some((a) => a.custom))).toBe(false);
  await page2.close();
});

test('REQ-GAP-05 WMS capabilities, EPSG:4326 tiles with TIME, GetFeatureInfo; WMTS 4326 matrix set; ArcGIS export, ImageServer, VectorTileServer; I3S buildings', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const out = {};
    await app.commands.run('ws.mapview');
    const map = app.desktop.workspace.map;
    map.zoomTo(47.5, 8.5, 400);
    const waitTiles = async (min = 1) => {
      for (let i = 0; i < 100 && app.onlineTiles.cache.size < min; i++) await new Promise((res) => setTimeout(res, 100));
      return app.onlineTiles.cache.size;
    };
    // WMS: browse the capabilities, then draw "roads" in EPSG:4326 at a chosen time.
    const wms = await app.services.connect(`${o}/wms`);
    out.wmsKind = wms.kind;
    const roads = wms.items.find((i) => i.id === 'roads');
    out.roads = { crs: roads.layer.crs, times: roads.time.values, queryable: roads.layer.queryable };
    const s = await app.services.addBackground(wms, roads, { crs: 'EPSG:4326', time: '2024-02-01' });
    out.wmsSource = { kind: s.kind, crs: s.crs, time: s.time, grid: app.onlineIsMercator(s) };
    out.wmsTiles = await waitTiles();
    // GetFeatureInfo at a point (JSON chosen from the offered formats).
    out.info = await app.online.identify(47.5, 8.5);
    // Change the TIME: new tiles are requested with it.
    app.online.setTime(s.id, '2024-01-01');
    await waitTiles();
    // WMTS: the EPSG:4326 matrix set is the source's grid; {Time} is filled in.
    app.onlineTiles.reset();
    const wmts = await app.services.connect(`${o}/wmts`, { kind: 'wmts' });
    const t2 = await app.services.addBackground(wmts, wmts.items[0], { time: '2024-04-01' });
    out.wmts = { kind: t2.kind, grid: t2.grid.epsg, levels: t2.grid.levels.length, tiles: await waitTiles() };
    // ArcGIS dynamic MapServer export and ImageServer exportImage, each drawn as tiles.
    for (const path of ['Map/MapServer', 'Img/ImageServer']) {
      app.onlineTiles.reset();
      const a = await app.services.connect(`${o}/arcgis/rest/services/${path}`);
      const src = await app.services.addBackground(a, a.items[0]);
      out[path] = { kind: src.kind, tiles: await waitTiles(), info: await app.online.identify(47.5, 8.5) };
    }
    // VectorTileServer: tiles fetched here, drawn in the decode worker.
    app.onlineTiles.reset();
    const vt = await app.services.connect(`${o}/arcgis/rest/services/VT/VectorTileServer`);
    const vs = await app.services.addBackground(vt, vt.items[0]);
    out.vt = { kind: vs.kind, vector: true, tiles: await waitTiles(), mercator: app.onlineIsMercator(vs) };
    // I3S: two leaf nodes → two building footprints with base and top heights and attributes.
    const sc = await app.services.connect(`${o}/arcgis/rest/services/Bldg/SceneServer`);
    const b = await app.services.loadScene(sc, sc.items[0], { bbox: [8.49, 47.49, 8.51, 47.51] });
    const fs = app.store.all('feature').filter((f) => f.vlayer === b.vl).map((f) => ({ ...f.attrs, type: f.geom.type }));
    out.i3s = { count: b.count, nodes: b.nodes, leaves: b.leaves, feats: fs.sort((x, y) => x.featureId - y.featureId) };
    return out;
  }, origin);
  expect(r.wmsKind).toBe('wms');
  expect(r.roads).toEqual({ crs: ['EPSG:4326', 'CRS:84', 'EPSG:3857'], times: ['2024-01-01', '2024-02-01', '2024-03-01'], queryable: true });
  expect(r.wmsSource).toEqual({ kind: 'wms', crs: 'EPSG:4326', time: '2024-02-01', grid: false });
  expect(r.wmsTiles).toBeGreaterThan(0);
  const maps = mock.seen.filter((s) => s.path === '/wms' && /GetMap/i.test(s.query)).map((s) => new URLSearchParams(s.query));
  expect(maps.length).toBeGreaterThan(0);
  expect(maps[0].get('CRS')).toBe('EPSG:4326');
  // EPSG:4326 in WMS 1.3.0: latitude first in the BBOX.
  const bb = maps[0].get('BBOX').split(',').map(Number);
  expect(Math.abs(bb[0])).toBeLessThanOrEqual(90);
  expect(bb[0]).toBeGreaterThan(40);
  expect(maps[0].get('TIME')).toBe('2024-02-01');
  expect(maps.some((m) => m.get('TIME') === '2024-01-01')).toBe(true);
  expect(r.info).toEqual([{ layer: 'roads', props: { name: 'A1', i: '128', j: '128', crs: 'EPSG:4326' } }]);
  expect(mock.seen.some((s) => /GetFeatureInfo/.test(s.query) && /INFO_FORMAT=application\/json/.test(s.query))).toBe(true);
  expect(r.wmts).toMatchObject({ kind: 'wmts', grid: 4326, levels: 10 });
  expect(r.wmts.tiles).toBeGreaterThan(0);
  expect(mock.seen.some((s) => /^\/wmts\/relief\/default\/2024-04-01\/crs84\/\d+\/\d+\/\d+\.png$/.test(s.path))).toBe(true);
  expect(r['Map/MapServer']).toMatchObject({ kind: 'arcgis-export', info: [{ layer: 'Roads', props: { NAME: 'Main', geometry: '8.5,47.5' } }] });
  expect(r['Map/MapServer'].tiles).toBeGreaterThan(0);
  expect(r['Img/ImageServer']).toMatchObject({ kind: 'arcgis-image', info: [{ layer: 'Pixel', props: { value: '12, 34, 56' } }] });
  expect(mock.seen.some((s) => s.path.endsWith('/export') && /bboxSR=3857/.test(s.query))).toBe(true);
  expect(mock.seen.some((s) => s.path.endsWith('/exportImage') && /format=jpgpng/.test(s.query))).toBe(true);
  expect(r.vt).toMatchObject({ kind: 'arcgis-vt', mercator: true });
  expect(r.vt.tiles).toBeGreaterThan(0);
  expect(r.i3s).toMatchObject({ count: 2, nodes: 3, leaves: 2 });
  expect(r.i3s.feats.map((f) => [f.featureId, f.OBJECTID, f.NAME, f.zmin, f.zmax, f.type])).toEqual([[101, 101, 'Hall', 400, 412, 'Polygon'], [102, 102, 'Tower', 400, 425, 'Polygon']]);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-06 OGC API Features with CQL2, Tiles, Maps, Coverages, Records, Processes; WCS 2.0 GetCoverage; WPS 2.0; SensorThings', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const S = app.store;
    const out = {};
    const svc = await app.services.connect(`${o}/ogc`);
    out.kind = svc.kind;
    out.conf = svc.conf;
    const it = (id) => svc.items.find((i) => i.id === id);
    // Features with a CQL2 filter (server-side).
    const f = await app.services.loadFeatures(svc, it('lakes'), { filter: 'area > 40' });
    out.cql = { count: f.count, names: S.all('feature').filter((x) => x.vlayer === f.vl).map((x) => x.attrs.name) };
    try {
      await app.services.loadFeatures(svc, it('lakes'), { filter: "name = 'oops" });
    } catch (e) {
      out.badCql = e.code;
    }
    // Tiles (raster, WebMercatorQuad) as a background.
    const ts = await app.services.addBackground(svc, it('lakes'));
    out.tiles = { kind: ts.kind, url: ts.url };
    // Maps and Coverages as image layers.
    const m = await app.services.openImage(svc, it('world'), { bbox: [8, 47, 8.2, 47.1], size: 400 });
    out.map = { w: m.layer.width, h: m.layer.height, model: !!m.layer.modelId };
    const c = await app.services.openImage(svc, it('dem'), { bbox: [8, 47, 8.1, 47.1] });
    const g = c.layer.groundAt(0, 0);
    out.coverage = { w: c.layer.width, h: c.layer.height, model: c.layer.modelName, corner: [g.lon, g.lat] };
    // Records.
    out.records = await app.services.searchRecords(svc, it('meta'), { q: 'ortho' });
    // Processes: sync, then async with job polling.
    const echo = svc.items.find((i) => i.id === 'echo');
    const e1 = await app.services.runProcess(svc, echo, { name: 'hello', n: '3' });
    out.echo = e1.outputs;
    out.echoFeatures = app.services.featuresIn(e1.outputs).length;
    const slow = svc.items.find((i) => i.id === 'slow');
    const statuses = [];
    const e2 = await app.services.runProcess(svc, slow, { name: 'x', n: 21 }, { pollMs: 50, onStatus: (s) => statuses.push(s.status) });
    out.slow = { outputs: e2.outputs, statuses };
    // WCS 2.0: GetCoverage as GeoTIFF over a box, with the Lat/Long axis labels from DescribeCoverage.
    const wcs = await app.services.connect(`${o}/wcs`);
    const w = await app.services.openImage(wcs, wcs.items[0], { bbox: [8.2, 47.2, 8.3, 47.3] });
    const wg = w.layer.groundAt(0, 0);
    out.wcs = { kind: wcs.kind, model: w.layer.modelName, corner: [wg.lon, wg.lat] };
    // WPS 2.0: a sync process with a bounding box input, and an async one with GetStatus/GetResult.
    const wps = await app.services.connect(`${o}/wps`);
    const cen = await app.services.runProcess(wps, wps.items.find((i) => i.id === 'centroid'), { area: [8, 47, 9, 48] });
    out.wps = cen.outputs;
    const sl = await app.services.runProcess(wps, wps.items.find((i) => i.id === 'slow'), { area: '8,47,9,48' }, { pollMs: 50 });
    out.wpsAsync = sl.outputs;
    return out;
  }, origin);
  expect(r.kind).toBe('ogcapi');
  expect(r.conf).toMatchObject({ features: true, filter: true, create: true, tiles: true, maps: true, coverages: true, records: true, processes: true });
  expect(r.cql).toEqual({ count: 3, names: ['Lake 5', 'Lake 6', 'Lake 7'] });
  expect(mock.seen.some((s) => s.path === '/ogc/collections/lakes/items' && /filter=area%20%3E%2040&filter-lang=cql2-text/.test(s.query))).toBe(true);
  expect(r.badCql).toBe('E_CQL2_SYNTAX');
  expect(r.tiles).toMatchObject({ kind: 'ogc-tiles' });
  expect(r.tiles.url).toMatch(/\/tiles\/WebMercatorQuad\/\{TileMatrix\}\/\{TileRow\}\/\{TileCol\}\?f=png$/);
  expect(r.map.model).toBe(true);
  expect(r.map.w).toBe(400);
  expect(r.coverage).toMatchObject({ w: 64, h: 48 });
  expect(r.coverage.corner[0]).toBeCloseTo(8, 6);
  expect(r.coverage.corner[1]).toBeCloseTo(47.1, 6);
  expect(r.records).toEqual([{ id: 'r1', title: 'Ortho 2024', description: 'An orthophoto', links: [{ rel: 'enclosure', type: 'image/tiff; application=geotiff', href: `${origin}/files/ortho.tif` }], geometry: null }]);
  expect(r.echo).toEqual({ echo: { type: 'Feature', properties: { name: 'hello', n: 3 }, geometry: { type: 'Point', coordinates: [8.5, 47.5] } } });
  expect(r.echoFeatures).toBe(1);
  expect(r.slow.outputs).toEqual({ count: { value: 42 } });
  expect(r.slow.statuses).toEqual(['running', 'successful']);
  const gc = mock.seen.find((s) => s.path === '/wcs' && /GetCoverage/.test(s.query));
  expect(decodeURIComponent(gc.query)).toMatch(/SUBSET=Long\(8\.2,8\.3\)&SUBSET=Lat\(47\.2,47\.3\)/);
  expect(r.wcs.kind).toBe('wcs');
  expect(r.wcs.corner[0]).toBeCloseTo(8.2, 6);
  expect(r.wcs.corner[1]).toBeCloseTo(47.3, 6);
  expect(r.wps).toEqual({ result: { type: 'Point', coordinates: [8.5, 47.5] } });
  expect(r.wpsAsync).toEqual({ result: { count: 3 } });
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-07 a WMS layer opens as an image layer: georeferenced to the request, measurable, chips, stated accuracy; UTM request; a user source under the image', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const out = {};
    const wms = await app.services.connect(`${o}/wms`);
    const roads = wms.items.find((i) => i.id === 'roads');
    const box = [8.4, 47.4, 8.6, 47.5];
    const { layer: l, statement } = await app.services.openImage(wms, roads, { bbox: box, size: 800, accuracy: 5 });
    out.size = [l.width, l.height];
    out.model = l.modelName;
    // Pixel corners against the requested box: the geotransform is the request.
    const errs = [];
    for (const [x, y, lon, lat] of [[0, 0, box[0], box[3]], [l.width, 0, box[2], box[3]], [l.width, l.height, box[2], box[1]], [0, l.height, box[0], box[1]], [l.width / 2, l.height / 2, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2]]) {
      const g = l.groundAt(x, y);
      errs.push(Math.max(Math.abs(g.lon - lon), Math.abs(g.lat - lat)));
    }
    out.maxErrDeg = Math.max(...errs);
    // Measurement: a point on the layer goes through the model; the error budget is "not available".
    const g = l.groundAt(l.width / 4, l.height / 4);
    let e = null;
    try {
      e = app.core.pointError(l.modelId, l.width / 4, l.height / 4, 0, 0.5, NaN);
    } catch {}
    out.point = { lon: g.lon, lat: g.lat, modelErrorKnown: e?.modelErrorKnown ?? null };
    out.statement = { stated: statement.stated, ce90: statement.ce90, epsg: statement.epsg, gsd: statement.gsd, onRecord: app.store.get(l.id).service?.stated };
    // A chip of the view.
    const chip = await app.makeChip({ width: 256, height: 256 });
    out.chip = !!chip;
    // The same layer requested in UTM zone 32N (EPSG:32632): a fitted or native map model.
    const u = await app.services.openImage(wms, wms.items.find((i) => i.id === 'utm'), { bbox: box, size: 600, crs: 'EPSG:32632' });
    const ug = u.layer.groundAt(u.layer.width / 2, u.layer.height / 2);
    out.utm = { model: u.layer.modelName, centre: [ug.lon, ug.lat], epsg: u.statement.epsg };
    // A user WMS source as a basemap under the georeferenced image (warped through its model).
    const src = await app.services.addBackground(wms, roads, { crs: 'EPSG:3857', under: true });
    out.basemap = app.basemapCurrent()?.id === `user:${src.id}`;
    for (let i = 0; i < 80 && !app.netlog.entries.some((x) => /^Basemap: /.test(x.purpose) && /^2/.test(String(x.status))); i++) await new Promise((res) => setTimeout(res, 100));
    out.basemapRequests = app.netlog.entries.filter((x) => /^Basemap: /.test(x.purpose)).length;
    return out;
  }, origin);
  // Square ground pixels: 800 px across 0.2° of longitude, 0.1° of latitude in proportion at 47.45° N.
  expect(r.size).toEqual([800, Math.round((800 * 0.1) / (0.2 * Math.cos((47.45 * Math.PI) / 180)))]);
  expect(r.model).toMatch(/EPSG:4326/);
  // Measured: corner and centre positions agree with the requested box to floating-point precision.
  expect(r.maxErrDeg).toBeLessThan(1e-9);
  expect(r.point.lon).toBeCloseTo(8.45, 9);
  expect(r.point.lat).toBeCloseTo(47.475, 9);
  expect(r.point.modelErrorKnown).toBe(false);
  expect(r.statement).toMatchObject({ stated: 'analyst', ce90: 5, epsg: 4326, onRecord: 'analyst' });
  expect(r.statement.gsd).toBeGreaterThan(5);
  expect(r.chip).toBe(true);
  expect(r.utm.epsg).toBe(32632);
  expect(r.utm.model).toMatch(/32632/);
  expect(r.utm.centre[0]).toBeCloseTo(8.5, 3);
  expect(r.utm.centre[1]).toBeCloseTo(47.45, 3);
  const utmReq = mock.seen.find((s) => /LAYERS=utm/.test(s.query));
  expect(new URLSearchParams(utmReq.query).get('CRS')).toBe('EPSG:32632');
  expect(r.basemap).toBe(true);
  expect(r.basemapRequests).toBeGreaterThan(0);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-63 a FeatureServer layer keeps field types, coded and range domains, subtypes and multi-part polygons; refused values send nothing', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const S = app.store;
    const RE = app.remoteEdit;
    const out = {};
    const vl = await RE.open({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Units/FeatureServer/0`, name: 'Units' });
    const v = S.get(vl);
    out.fields = v.fields.map((f) => [f.name, f.type, f.domain ?? f.range ?? null]);
    out.subtypes = v.source.subtypes;
    const fs = S.all('feature').filter((f) => f.vlayer === vl).sort((a, b) => a.remoteId - b.remoteId);
    out.multi = { type: fs[2].geom.type, gj: RE.geomToGeojson(fs[2].geom).coordinates.map((p) => p.length) };
    out.seen = fs[0].attrs.SEEN;
    // Refused: STATUS 'A' is not allowed for subtype 2 (Armour), STRENGTH out of range, unknown field.
    S.transact('edit', (tx) => {
      tx.set(fs[1].id, 'attrs', { ...fs[1].attrs, STATUS: 'A', STRENGTH: 150 });
      tx.create('feature', { vlayer: vl, geom: RE.geojsonToGeom({ type: 'Polygon', coordinates: [[[8, 47.2], [8.01, 47.2], [8.01, 47.21], [8, 47.2]]] }), attrs: { NAME: 'New', KIND: 1, COLOUR: 'red' } });
    });
    try {
      await RE.save(vl);
    } catch (e) {
      out.refused = { code: e.code, n: e.issues?.length, codes: e.issues?.map((x) => x.code) };
    }
    // Fixed: valid values; the date goes out as epoch milliseconds, numbers as numbers.
    const added = S.all('feature').find((f) => f.vlayer === vl && f.attrs.NAME === 'New');
    S.transact('fix', (tx) => {
      tx.set(fs[1].id, 'attrs', { ...fs[1].attrs, STATUS: 'R', STRENGTH: '75', SEEN: '2024-06-01T00:00:00.000Z' });
      tx.set(added.id, 'attrs', { NAME: 'New', KIND: 1, STATUS: 'A', STRENGTH: 5 });
    });
    out.saved = await RE.save(vl);
    return out;
  }, origin);
  expect(r.fields).toEqual([['OBJECTID', 'integer', null], ['NAME', 'string', null], ['KIND', 'integer', null], ['STATUS', 'string', { A: 'Active', I: 'Inactive' }], ['STRENGTH', 'integer', [0, 100]], ['SEEN', 'date', null], ['SPEED', 'number', null]]);
  expect(r.subtypes).toMatchObject({ field: 'KIND', list: [{ code: 1, name: 'Infantry', domains: {} }, { code: 2, name: 'Armour', domains: { STATUS: { domain: { R: 'Reserve' } } } }] });
  expect(r.multi.type).toBe('MultiPolygon');
  expect(r.multi.gj).toEqual([1, 2]); // one polygon without a hole, one with its hole
  expect(r.seen).toBe('2024-01-01T00:00:00.000Z');
  expect(r.refused).toEqual({ code: 'E_ATTRS_INVALID', n: 3, codes: ['E_ATTR_UNKNOWN', 'E_ATTR_DOMAIN', 'E_ATTR_RANGE'] });
  expect(r.saved).toMatchObject({ adds: 1, updates: 1, deletes: 0 });
  // Only the valid edit reached the service, typed.
  expect(mock.state.applyEdits.filter((x) => !x.target)).toHaveLength(1);
  const sent = mock.state.applyEdits.find((x) => !x.target);
  expect(sent.updates[0].attributes).toMatchObject({ OBJECTID: 2, STATUS: 'R', STRENGTH: 75, SEEN: Date.UTC(2024, 5, 1) });
  expect(sent.adds[0].attributes).toEqual({ NAME: 'New', KIND: 1, STATUS: 'A', STRENGTH: 5 });
  expect(sent.adds[0].geometry.rings).toHaveLength(1);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-59 accepted detections and observations publish to a FeatureServer, WFS-T and OGC API Features, once', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const r = await frame.evaluate(async (o) => {
    const app = window.gisworkbench;
    const S = app.store;
    const out = {};
    app.detections.add(
      [
        { cls: 'vehicle', confidence: 0.91, anchor: 'ground', point: [8.5, 47.5], props: {} },
        { cls: 'ship', confidence: 0.8, anchor: 'ground', ring: [[8.6, 47.6], [8.61, 47.6], [8.61, 47.61], [8.6, 47.61], [8.6, 47.6]], props: {} },
        { cls: 'vehicle', confidence: 0.6, anchor: 'ground', point: [8.7, 47.7], props: {} },
      ],
      { layer: null, source: 'test' },
    );
    const ds = S.all('detection').sort((a, b) => a.n - b.n);
    app.detections.setStatus(ds[0].id, 'accepted');
    app.detections.setStatus(ds[1].id, 'accepted');
    app.detections.setStatus(ds[2].id, 'rejected');
    // FeatureServer (point layer): the area becomes its centroid; fields matched by name.
    out.arc = await app.publish.publish({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Det/FeatureServer/0` });
    out.arcAgain = await app.publish.publish({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Det/FeatureServer/0` });
    out.marked = S.all('detection').filter((d) => d.published?.length).map((d) => d.published[0].id);
    // WFS-T: geometry property and fields from DescribeFeatureType.
    out.wfs = await app.publish.publish({ kind: 'wfs', url: `${o}/wfs`, typeName: 'test:det' });
    // OGC API Features (Part 4): observations, one POST each.
    app.observations.add({ text: 'Two trucks at the gate', category: 'vehicle activity', lat: 47.51, lon: 8.51, graphics: [], chips: [], features: [] });
    out.ogc = await app.publish.publish({ kind: 'ogcapi', url: `${o}/ogc/collections/lakes` }, { what: 'observations' });
    // A value the target's domain refuses stops the publish before anything is sent.
    const d = S.all('detection').find((x) => x.n === 3);
    app.detections.setStatus(d.id, 'accepted', { cls: 'tank' });
    try {
      await app.publish.publish({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Det/FeatureServer/0` });
    } catch (e) {
      out.refused = e.code;
    }
    return out;
  }, origin);
  expect(r.arc).toMatchObject({ sent: 2, skipped: 0, ids: [500, 501], pointsFromAreas: 1 });
  expect(r.arc.unmatched).toEqual(expect.arrayContaining(['source', 'image', 'detection']));
  expect(r.arcAgain).toMatchObject({ sent: 0, skipped: 2 });
  expect(r.marked).toEqual([500, 501]);
  const det = mock.state.applyEdits.filter((x) => x.target === 'det');
  expect(det).toHaveLength(1);
  expect(det[0].adds.map((a) => a.attributes)).toEqual([{ CLASS: 'vehicle', CONFIDENCE: 0.91, NOTE: '' }, { CLASS: 'ship', CONFIDENCE: 0.8, NOTE: '' }]);
  expect(det[0].adds[1].geometry.x).toBeCloseTo(8.605, 6);
  expect(r.wfs).toMatchObject({ sent: 2, ids: ['det.1', 'det.2'] });
  expect(mock.state.wfsInserts[0]).toMatch(/<test:det><test:class>vehicle<\/test:class><test:confidence>0\.91<\/test:confidence><test:the_geom><gml:Point/);
  expect(r.ogc).toMatchObject({ sent: 1, ids: ['new.1'] });
  expect(mock.state.ogcCreated[0]).toMatchObject({ type: 'Feature', properties: { category: 'vehicle activity', text: 'Two trucks at the gate' }, geometry: { type: 'Point', coordinates: [8.51, 47.51] } });
  expect(r.refused).toBe('E_ATTRS_INVALID');
  expect(mock.state.applyEdits.filter((x) => x.target === 'det')).toHaveLength(1);
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});

test('REQ-GAP-05 REQ-GAP-06 the Online Services and Publish dialogs work from the keyboard-free UI and pass axe', async ({ page }) => {
  const { page2, frame, logs } = await allowed(page);
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  const axe = (sel) => frame.evaluate(async (s) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), sel);
  await frame.evaluate(() => void window.gisworkbench.commands.run('svc.connect'));
  const dlg = frame.locator('[data-id="dialog:online-services"]');
  await expect(dlg).toBeVisible();
  await frame.locator('[data-id="svc:url"]').fill(`${origin}/wms`);
  await frame.locator('[data-id="svc:connect"]').click();
  await expect(frame.locator('[data-id="svc:status"]')).toContainText('Mock WMS');
  await expect(frame.locator('[data-id="svc:items"] tbody tr')).toHaveCount(2);
  await frame.locator('[data-id="svc:bg:roads"]').click();
  await expect(frame.locator('[data-id="svc:status"]')).toContainText('Roads');
  expect(await axe('[data-id="dialog:online-services"]')).toEqual([]);
  await dlg.locator('.dlg-x').click();
  await frame.evaluate(() => void window.gisworkbench.commands.run('det.publish'));
  await expect(frame.locator('[data-id="dialog:publish-service"]')).toBeVisible();
  expect(await axe('[data-id="dialog:publish-service"]')).toEqual([]);
  await frame.locator('[data-id="dialog:publish-service"] .dlg-x').click();
  expect(quiet(logs)).toEqual([]);
  await page2.close();
});
