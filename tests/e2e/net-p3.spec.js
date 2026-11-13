// GIS Workbench 2.0 network, basemaps and 3D (2.0 plan P3): REQ-NET-01 REQ-NET-02 REQ-NET-03
// REQ-NET-04 REQ-NET-05 REQ-GLB-01 REQ-GLB-02. No test reaches the internet: tile requests to the
// curated origins are answered by Playwright route handlers.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { openApp, openFiles, DIST, DIST_DIR } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const PMT = resolve('fixtures/basemap/toner_z3.pmtiles');
const AIRGAP = join(DIST_DIR, 'gis-workbench-airgap.html');
const ORIGINS = JSON.parse(readFileSync(resolve('build/origins.json'), 'utf8')).origins.map((o) => o.origin);
// The optional sidecar's loopback origins are in every file, the air-gapped one included (REQ-SDC-02, REQ-SDC-14).
const LOOPBACK = JSON.parse(readFileSync(resolve('build/origins.json'), 'utf8')).loopback.origins;

/** A 256×256 PNG of one colour (tiles), or a Terrarium tile at a constant height. */
function png(r, g, b) {
  const row = Buffer.alloc(1 + 256 * 3);
  for (let i = 0; i < 256; i++) row.set([r, g, b], 1 + 3 * i);
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const x of td) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0);
  ihdr.writeUInt32BE(256, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const GREEN = png(40, 160, 60);
const TERRAIN_900M = png(Math.floor((900 + 32768) / 256), (900 + 32768) % 256, 0); // Terrarium: 900 m

async function routeTiles(page, seen) {
  await page.route(/tiles\.maps\.eox\.at|basemap\.nationalmap\.gov|gibs\.earthdata\.nasa\.gov/, (r) => {
    seen.push(r.request().url());
    r.fulfill({ status: 200, contentType: 'image/png', body: GREEN, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route(/elevation-tiles-prod\/terrarium/, (r) => {
    seen.push(r.request().url());
    r.fulfill({ status: 200, contentType: 'image/png', body: TERRAIN_900M, headers: { 'access-control-allow-origin': '*' } });
  });
}

const cspOf = (html) => /<meta[^>]*id="csp"[^>]*content="([^"]*)"/.exec(html)[1];

test('REQ-NET-01 REQ-NET-03 the Standard CSP lists the curated origins; the air-gapped file lists none', () => {
  const std = cspOf(readFileSync(DIST, 'utf8'));
  const air = cspOf(readFileSync(AIRGAP, 'utf8'));
  const connect = (c) => /connect-src([^;]*)/.exec(c)[1].trim().split(/\s+/);
  expect(connect(std)).toEqual(['blob:', ...ORIGINS, ...LOOPBACK]);
  expect(connect(air)).toEqual(['blob:', ...LOOPBACK]);
  for (const o of connect(std)) expect(o).not.toMatch(/\*/);
  // Same scripts, same hashes: only the CSP and the manifest profile differ.
  expect(std.replace(/connect-src[^;]*/, '')).toBe(air.replace(/connect-src[^;]*/, ''));
});

test('REQ-NET-02 offline until chosen: no request leaves; going online lets basemap tiles through, each logged', async ({ page }) => {
  const seen = [];
  await routeTiles(page, seen);
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await expect(frame.locator('.status-net').first()).toHaveText('Offline');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  await frame.evaluate(() => window.gisworkbench.setBasemap('satellite'));
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ zoom: window.gisworkbench.activePane().view.zoom / 4 }));
  await page.waitForTimeout(800);
  expect(seen).toEqual([]);
  const refused = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.netlog.fetchFor('test')('https://tiles.maps.eox.at/x.png');
      return 'sent';
    } catch (e) {
      return e.offline ? 'offline' : e.message;
    }
  });
  expect(refused).toBe('offline');
  // Online: tiles come through the logged fetch and draw under the image.
  await frame.locator('.status-net').first().click();
  await expect(frame.locator('.status-net').first()).toHaveText('Online');
  await frame.waitForFunction(() => window.gisworkbench.activePane()._basemapShown?.id === 'satellite', null, { timeout: 15000 });
  expect(seen.length).toBeGreaterThan(0);
  const logged = await frame.evaluate(() => window.gisworkbench.netlog.entries.filter((e) => /Basemap/.test(e.purpose) && e.status === 200).length);
  expect(logged).toBeGreaterThan(0);
  await expect(frame.locator('.basemap-attr').first()).toContainText('EOX');
});

test('REQ-NET-02 a site can lock Offline', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gisworkbench.prefs.common.v1', JSON.stringify({ values: { network: 'offline' }, locked: ['network'] })));
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await expect(frame.locator('.status-net').first()).toBeDisabled();
  expect(await frame.evaluate(() => window.gisworkbench.commands.enabled('net.toggle'))).toBe(false);
});

test('REQ-NET-03 the air-gapped file says so and refuses every request', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: AIRGAP, prefs: { welcomeDone: true, network: 'online' } });
  await expect(frame.locator('.status-net').first()).toHaveText('Air-gapped');
  await expect(frame.locator('.status-net').first()).toBeDisabled();
  const r = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.netlog.fetchFor('test')('https://tiles.maps.eox.at/x.png');
      return 'sent';
    } catch (e) {
      return e.message;
    }
  });
  expect(r).toMatch(/air-gapped/);
});

test('REQ-NET-05 a PMTiles file is a basemap that works offline', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  await openFiles(frame, [PMT]);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ zoom: window.gisworkbench.activePane().view.zoom / 400 }));
  await frame.waitForFunction(() => /^local:/.test(window.gisworkbench.activePane()._basemapShown?.id ?? ''), null, { timeout: 15000 });
  expect(await frame.evaluate(() => window.gisworkbench.network.mode)).toBe('offline');
  expect(await frame.evaluate(() => window.gisworkbench.netlog.entries.length)).toBe(0);
});

test('REQ-NET-05 basemap tiles are uploaded again after the WebGL context is lost and restored', async ({ page }) => {
  // #238: the tile cache kept textures of the lost context, so the basemap drew blank after a restore.
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true } });
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  // Every texture upload is recorded from before the basemap opens, so its first tiles are seen.
  await frame.evaluate(() => {
    const R = window.gisworkbench.renderer;
    const upload = R.bitmapTexture.bind(R);
    window.__made = [];
    R.bitmapTexture = (bmp) => {
      const tex = upload(bmp);
      window.__made.push(tex);
      return tex;
    };
  });
  await openFiles(frame, [PMT]);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ zoom: window.gisworkbench.activePane().view.zoom / 400 }));
  await frame.waitForFunction(() => /^local:/.test(window.gisworkbench.activePane()._basemapShown?.id ?? '') && window.__made.length > 0, null, { timeout: 15000 });
  const r = await frame.evaluate(async () => {
    const R = window.gisworkbench.renderer;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    // An online tile held from before the loss (online.js keeps its own cache, as basemaps do).
    const bmp = await createImageBitmap(new ImageData(4, 4));
    window.gisworkbench.onlineTiles.cache.set('test', { tex: R.bitmapTexture(bmp), bytes: 64, used: performance.now() });
    const ext = R.gl.getExtension('WEBGL_lose_context');
    const lost = new Promise((res) => R.canvas.addEventListener('webglcontextlost', res, { once: true }));
    ext.loseContext();
    await lost;
    await wait(100); // the browser allows a restore once the event has been handled
    const restored = new Promise((res) => R.canvas.addEventListener('webglcontextrestored', res, { once: true }));
    ext.restoreContext();
    await restored;
    const made = window.__made;
    made.length = 0;
    for (let i = 0; i < 100 && !made.length; i++) await wait(50);
    return { again: made.length, live: made.every((tex) => R.gl.isTexture(tex)), online: window.gisworkbench.onlineTiles.cache.size, gpuBytes: R.gpuBytes, glError: R.gl.getError() };
  });
  expect(r.again).toBeGreaterThan(0);
  expect(r.live).toBe(true);
  // The online tile is forgotten, not freed in the new context: no GL error, no negative byte count.
  expect(r).toMatchObject({ online: 0, glError: 0 });
  expect(r.gpuBytes).toBeGreaterThanOrEqual(0);
});

test('REQ-GLB-01 REQ-GLB-02 the 3D button drapes the image on terrain with the basemap around it, and goes back', async ({ page }) => {
  const seen = [];
  await routeTiles(page, seen);
  const { frame } = await openApp(page, 'file', { prefs: { welcomeDone: true, network: 'online', basemap: 'satellite' } });
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  const fab = frame.locator('.fab-3d').first();
  await expect(fab).toHaveText('3D');
  await fab.click();
  await frame.waitForFunction(() => window.gisworkbench.activePane().globe?.terrain, null, { timeout: 60000 });
  const g = await frame.evaluate(() => ({ ...window.gisworkbench.activePane().globe, terrains: window.gisworkbench.activePane().view3d.terrains.length }));
  expect(g).toMatchObject({ terrain: 'AWS Terrain Tiles (Terrarium)', basemap: 'Satellite', terrains: 2 });
  expect(seen.some((u) => /terrarium/.test(u))).toBe(true);
  await expect(fab).toHaveText('2D');
  await fab.click();
  await expect(fab).toHaveText('3D');
  expect(await frame.evaluate(() => !!window.gisworkbench.activePane().view3d)).toBe(false);
});
