// TE-C18 Phase 5 live services. Endpoints come from corpus items with area "live" (service field).
// Reachability is checked from Node first (a dead public endpoint is a data finding, not an app
// finding); app-side tests prove the network guard: nothing leaves the machine until the user
// allow-lists the origin (REQ-SEC-12), and the request log records what did.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, itemsBy, record, item } from './helpers.js';
import { itemDir } from '../../build/campaign/corpus-lib.mjs';

const live = itemsBy((it) => it.area === 'live' && it.service);

test.describe.configure({ mode: 'parallel' });

for (const it of live) {
  test(`TE-C18 ${it.id} endpoint reachable [${it.service.type}]`, async ({}, info) => {
    test.skip(info.project.name !== 'chrome', 'once per run');
    // Tile templates are probed at tile 0/0/0.
    const url = it.service.url.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0').replace('{s}', 'a');
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20_000) }).catch((e) => ({ ok: false, status: String(e.message) }));
    record('c18-live', info.project.name, { key: `${it.id}-reach`, url, status: r.status, cors: r.headers?.get?.('access-control-allow-origin') ?? null });
    expect(r.ok, `${url} → ${r.status}`).toBe(true);
  });
}

test('TE-C18 REQ-SEC-12 no request leaves before an origin is allowed', async ({ page }, info) => {
  const { frame, requests } = await openApp(page, 'file');
  // Exercise every online entry point with no allow-list: each must refuse or ask, never fetch.
  for (const id of ['online.add', 'online.backgrounds', 'bg.map', 'vec.remoteopen', 'pc.stream', '3d.tiles']) {
    await frame.evaluate((c) => {
      window.gisworkbench.commands.run(c);
    }, id);
    await frame.waitForTimeout(400);
    for (let i = 0; i < 3; i++) await frame.locator('body').press('Escape').catch(() => {});
  }
  record('c18-live', info.project.name, { key: 'guard', requests });
  expect(requests).toEqual([]);
});

// Part B (Phase 8). Each test saves a copy of the app with the origins it needs allow-listed (the
// user's add → save → reload path), then drives the live service. Public services are only read
// (GET): the write path of remote editing (applyEdits, WFS-T Transaction) runs against a local
// service in tests/e2e/remote-edit.spec.js, never against a shared public server.
async function allowed(page, origins) {
  const { frame } = await openApp(page, 'file');
  const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins(o), origins);
  const dir = join(tmpdir(), 'gw-te-live');
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, `gw-live-${Date.now()}-${Math.random().toString(16).slice(2)}.html`);
  writeFileSync(copy, html);
  const page2 = await page.context().newPage();
  return { page2, ...(await openApp(page2, 'file', { htmlPath: copy })) };
}
const online = async (u) => (await fetch(u, { signal: AbortSignal.timeout(15_000) }).catch(() => null))?.ok ?? false;

const BASEMAPS = [
  { id: 'gibs', name: 'NASA GIBS Blue Marble (WMTS)', kind: 'wmts', url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{TileMatrix}/{TileRow}/{TileCol}.jpeg', maxZoom: 8, probe: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/3/3/1.jpeg' },
  { id: 'tnm', name: 'USGS The National Map topo (ArcGIS REST)', kind: 'arcgis', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer', maxZoom: 16, probe: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/3/3/1' },
  { id: 'osm', name: 'OpenStreetMap (XYZ)', kind: 'xyz', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19, probe: 'https://tile.openstreetmap.org/3/1/3.png' },
];
for (const { probe, ...bm } of BASEMAPS) {
  test(`TE-C18 REQ-UI-26 REQ-ARC-16 REQ-SEC-12 allow-listed basemap renders: ${bm.name}`, async ({ page }, info) => {
    test.skip(!(await online(probe)), 'service unreachable from this machine');
    const origin = new URL(bm.url).origin;
    const { page2, frame, logs } = await allowed(page, [origin]);
    const r = await frame.evaluate(
      async ({ bm, origin }) => {
        const app = window.gisworkbench;
        app.online.sources = [{ ...bm }];
        app.online.active = bm.id;
        app.online.visible = true;
        app.online.save();
        app.desktop.workspace.map.zoomTo(39.74, -104.99, 6);
        for (let i = 0; i < 150 && !app.onlineTiles.cache.size; i++) await new Promise((res) => setTimeout(res, 100));
        await new Promise((res) => setTimeout(res, 800));
        const cap = app.renderer.capture();
        const b = app.desktop.workspace.map.el.getBoundingClientRect();
        // Colour variety over a grid of map pixels: tiles drawn, not a flat background.
        const seen = new Set();
        for (let gy = 1; gy < 8; gy++)
          for (let gx = 1; gx < 8; gx++) {
            const x = Math.round((b.left + (b.width * gx) / 8) * cap.dpr);
            const y = Math.round((b.top + (b.height * gy) / 8) * cap.dpr);
            const i = (y * cap.width + x) * 4;
            seen.add(`${cap.data[i] >> 4},${cap.data[i + 1] >> 4},${cap.data[i + 2] >> 4}`);
          }
        const net = app.netlog.entries.filter((e) => e.origin === origin);
        return { tiles: app.onlineTiles.cache.size, colours: seen.size, ok: net.filter((e) => /^2/.test(String(e.status))).length, other: net.filter((e) => !/^2/.test(String(e.status))).map((e) => `${e.status} ${e.path}`).slice(0, 5) };
      },
      { bm, origin },
    );
    record('c18-live', info.project.name, { key: `basemap-${bm.id}`, ...r });
    expect(r.tiles, 'tiles cached').toBeGreaterThan(0);
    expect(r.ok, 'tile requests answered 2xx (request log)').toBeGreaterThan(0);
    expect(r.colours, 'map pixels show tile content').toBeGreaterThan(3);
    expect(logs).toEqual([]);
    await page2.close();
  });
}

test('TE-C18 REQ-EXT-26 REQ-SEC-12 a public ArcGIS feature service opens for editing (read only; no edit sent)', async ({ page }, info) => {
  const url = 'https://sampleserver6.arcgisonline.com/arcgis/rest/services/Wildfire/FeatureServer/0';
  test.skip(!(await online(`${url}?f=json`)), 'service unreachable from this machine');
  const { page2, frame, logs } = await allowed(page, [new URL(url).origin]);
  const r = await frame.evaluate(async (url) => {
    const app = window.gisworkbench;
    const RE = app.remoteEdit;
    const vl = await RE.open({ kind: 'arcgis', url, name: 'Wildfire response points' });
    const fs = app.store.all('feature').filter((f) => f.vlayer === vl);
    // A local edit is diffed against the service snapshot; it is not saved (public data).
    app.store.transact('TE edit (not saved)', (tx) => tx.set(fs[0].id, 'attrs', { ...fs[0].attrs, description: 'TE campaign: not sent' }));
    const p = RE.pending(vl);
    return { n: fs.length, fields: Object.keys(fs[0]?.attrs ?? {}).length, idOk: fs.every((f) => f.remoteId !== undefined && f.remoteId !== null), pending: { a: p.adds.length, u: p.updates.length, d: p.deletes.length }, posts: app.netlog.entries.filter((e) => e.method === 'POST').length };
  }, url);
  record('c18-live', info.project.name, { key: 'remote-arcgis-read', ...r });
  expect(r.n, 'features read from the service').toBeGreaterThan(0);
  expect(r.fields).toBeGreaterThan(1);
  expect(r.idOk, 'every feature keeps its OBJECTID').toBe(true);
  expect(r.pending).toEqual({ a: 0, u: 1, d: 0 });
  expect(r.posts, 'nothing posted to the public service').toBe(0);
  expect(logs).toEqual([]);
  await page2.close();
});

test('TE-C18 REQ-LDR-02 REQ-SEC-12 COPC streams over HTTPS range requests (Autzen, 81 MB)', async ({ page }, info) => {
  const url = 'https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz';
  const head = await fetch(url, { headers: { range: 'bytes=0-1023' }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  test.skip(head?.status !== 206, 'COPC host unreachable or without range support');
  const { page2, frame, logs } = await allowed(page, [new URL(url).origin]);
  const r = await frame.evaluate(async (url) => {
    const app = window.gisworkbench;
    const e = await app.pc.streamCopc(url, app.activePane(), { px: 2e6 });
    // Streamed clouds live in the 3-D view (view3d._streams), node by node.
    // Refine: a fine screen-space threshold asks for the next octree levels.
    e.opts.px = 1e-3;
    e.opts.maxInFlight = 6;
    for (let i = 0; i < 300 && !(e.stream.stats?.loaded >= 8); i++) {
      app.activePane().view3d?.requestRender?.();
      app.activePane().invalidate?.();
      await new Promise((res) => setTimeout(res, 150));
    }
    const net = app.netlog.entries.filter((x) => x.origin === new URL(url).origin && x.method === 'GET');
    return { kind: e.stream.kind, total: e.stream.total, nodesLoaded: e.stream.stats?.loaded ?? 0, requests: net.length, bytes: net.reduce((t, x) => t + (Number(x.received) || 0), 0), statuses: [...new Set(net.map((x) => x.status))] };
  }, url);
  record('c18-live', info.project.name, { key: 'copc-https', ...r });
  expect(r.kind).toBe('COPC');
  expect(r.total, 'octree point count from the COPC header').toBeGreaterThan(1e6);
  expect(r.nodesLoaded, 'octree nodes streamed').toBeGreaterThanOrEqual(8);
  expect(r.statuses, 'every read a byte range').toEqual([206]);
  // Streaming reads part of the 81 MB file, not all of it (ARC-07).
  expect(r.bytes).toBeLessThan(40e6);
  expect(logs).toEqual([]);
  await page2.close();
});

test('TE-C18 REQ-STR-15 3D Tiles stream from a local http server (CesiumGS samples)', async ({ page }, info) => {
  const root = itemDir(item('3d-tiles-discrete-lod'));
  test.skip(!existsSync(join(root, 'TilesetWithDiscreteLOD', 'tileset.json')), 'not on disk');
  const srv = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*' };
    const p = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, ''));
    if (!p.startsWith(root) || !existsSync(p)) {
      res.writeHead(404, cors);
      return res.end();
    }
    res.writeHead(200, { ...cors, 'content-type': p.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    res.end(readFileSync(p));
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { page2, frame, logs } = await allowed(page, [origin]);
    const r = await frame.evaluate(async (o) => {
      const app = window.gisworkbench;
      await app.scene3d.ensureView();
      await app.scene3d.addTiles(`${o}/TilesetWithDiscreteLOD/tileset.json`);
      for (let i = 0; i < 100; i++) {
        if (app.netlog.entries.some((e) => e.origin === o && /\.b3dm$/.test(e.path) && /^2/.test(String(e.status)))) break;
        await new Promise((res) => setTimeout(res, 150));
      }
      await new Promise((res) => setTimeout(res, 800));
      return { net: app.netlog.entries.filter((e) => e.origin === o).map((e) => `${e.status} ${e.path}`) };
    }, origin);
    record('c18-live', info.project.name, { key: '3dtiles-local', ...r });
    expect(r.net.some((x) => /^2\d\d \/TilesetWithDiscreteLOD\/tileset\.json/.test(x)), r.net.join(', ')).toBe(true);
    expect(r.net.some((x) => /^2\d\d \/TilesetWithDiscreteLOD\/dragon_\w+\.b3dm/.test(x)), `b3dm content fetched: ${r.net.join(', ')}`).toBe(true);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    srv.close();
  }
});
