// SCN-65 (REQ-GAP-33, 65, 08): with a mock add-in, view and cursor follow between the app and the
// sidecar loopback; a native viewer shows a stereo pair; with the gate set for test, the relay reaches
// a listed origin and refuses all others. Runs in the `sidecar` projects.
//
// Nothing here opens a window on the desktop: the viewer draws on a software GL, or on the real driver
// in a window it never shows, and a test checks that. The one test of the visible window closes itself
// and runs only with GWB_WINDOW_TEST=1. ArcGIS Pro is not here (an owner item): the mock add-in is the
// add-in's own client and loop with a fake map, plus a small one in this file.
//
// This spec starts its own sidecars, one at a time, on one port, so it can run beside other groups'
// runs: GWB_NATIVE_PORT (default 47822), and with `--no-deps` no global sidecar starts. The app's CSP
// lists only 47821-47823, so the page's calls to those are forwarded to that port by Playwright's
// routing (`forward`): nothing else differs, and CORS still comes from the sidecar's own answers.
// Env: GWB_SIDECAR_RELAY_EXE (a `--features cors-relay` build; those tests skip without one),
// GWB_PRO_MOCK (MockAddin.exe), GWB_STEREO_PAIR (two images, `;` between them).

import { test, expect } from '@playwright/test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { openApp, openFiles } from '../helpers.js';
import { approvePending, startSidecar, stopSidecar, windowPost, outboundConnections, EXE, DATA_ROOT, DIST_DIR, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const WORK = resolve('test-results', 'native');
const CERTS = resolve('fixtures/fx26/native/certs');
const RELAY_EXE = process.env.GWB_SIDECAR_RELAY_EXE ?? 'E:/qlab/ct26-native-relay/release/gwb-sidecar.exe';
const MOCK = process.env.GWB_PRO_MOCK ?? resolve('sidecar/pro-addin/MockAddin/bin/Release/net8.0/MockAddin.exe');
const PAIR = (process.env.GWB_STEREO_PAIR ?? 'E:/TE-corpus/derived-gtiff-variants/mvs_wv3_a_chip_rpc.tif;E:/TE-corpus/derived-gtiff-variants/mvs_wv3_b_chip_rpc.tif').split(';');
const PORT = Number(process.env.GWB_NATIVE_PORT ?? 47822);
const PAGE_BASE = 'http://127.0.0.1:47821'; // what the page calls, inside its CSP
const CONTRACT = JSON.parse(readFileSync(resolve('sidecar/pro-addin/contract/sync-contract.json'), 'utf8'));
mkdirSync(WORK, { recursive: true });

test.describe.configure({ timeout: 240_000 });

/** A program's HTTP call: no Origin and no Sec-Fetch headers, which Node's own fetch would add. */
function call(port, method, path, { token, body, origin, ct = 'application/json', raw } = {}) {
  return new Promise((res, rej) => {
    const payload = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
    const headers = { Host: `127.0.0.1:${port}`, ...(payload ? { 'Content-Type': ct, 'Content-Length': payload.length } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(origin ? { Origin: origin } : {}) };
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (resp) => {
      const parts = [];
      resp.on('data', (d) => parts.push(d));
      resp.on('end', () => {
        const buf = Buffer.concat(parts);
        let json = null;
        try {
          json = JSON.parse(buf.toString());
        } catch {
          /* not JSON */
        }
        res({ status: resp.statusCode, headers: resp.headers, body: buf, json });
      });
    });
    r.on('error', rej);
    if (payload) r.write(payload);
    r.end();
  });
}

/** A page's call (Origin null, the test pairing). */
const page = (s, method, path, opts = {}) => call(s.port, method, path, { token: s.token, origin: 'null', ...opts });

async function until(fn, ms = 30_000, what = 'the condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Send the page's sidecar calls to `s`. The page never reaches another sidecar on this computer. */
async function forward(p, s) {
  await p.route(/^http:\/\/127\.0\.0\.1:4782[123]\//, async (route) => {
    const req = route.request();
    const url = req.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, s.base);
    const { host: _host, ...headers } = req.headers();
    try {
      const resp = await route.fetch({ url, headers, maxRedirects: 0, timeout: 60_000 });
      await route.fulfill({ response: resp });
    } catch {
      await route.abort().catch(() => {}); // the page went away while the call was held
    }
  });
}

async function appPage(p, s) {
  await forward(p, s);
  const { frame } = await openApp(p, 'file', { htmlPath: DIST, prefs: PREFS });
  return frame;
}

/** Point the page's client at a sidecar, as pairing with it would. */
async function useSidecar(frame, s) {
  await frame.evaluate(
    async ({ base, token }) => {
      const S = window.gisworkbench.sidecar;
      Object.assign(S.client, { base, token, ports: [Number(base.split(':').pop())] });
      await S.client.store.set({ token, base, at: new Date().toISOString() });
      await S.refresh({ quiet: true });
    },
    { base: PAGE_BASE, token: s.token },
  );
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 30_000 });
}

async function axeClean(frame, selector) {
  await frame.evaluate(AXE);
  const v = await frame.evaluate(async (sel) => (await window.axe.run(sel, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] })).violations.map((x) => `${x.id}: ${x.nodes[0]?.html}`), selector);
  expect(v).toEqual([]);
}

// ---------------------------------------------------------------- shipped build: the relay is not there

/** Stop a sidecar and wait until its port can be bound again: the next one uses the same port. */
async function stopped(s) {
  stopSidecar(s.pid);
  await until(
    () =>
      new Promise((res) => {
        const srv = createNetServer();
        srv.once('error', () => res(false));
        srv.listen(PORT, '127.0.0.1', () => srv.close(() => res(true)));
      }),
    30_000,
    'the port to come free',
  );
}

/** The plain test sidecar of a group of tests: started here, stopped here, and the only one up. */
function ownSidecar(name) {
  let s = null;
  test.beforeAll(async () => {
    test.setTimeout(300_000);
    s = await startSidecar({ dataDir: resolve(DATA_ROOT, `native-${name}`), port: PORT });
  });
  test.afterAll(() => stopped(s));
  return () => s;
}

test.describe('REQ-GAP-08 in a shipped build', () => {
  test.describe.configure({ mode: 'serial' }); // one sidecar on one port; a failure stops this group only
  const state = ownSidecar('shipped');
  test('there is no relay: no route, no capability, no flag', async () => {
    const s = state();
    const caps = (await page(s, 'GET', '/v1/caps')).json;
    expect(caps.features.cors_relay).toBe(false);
    for (const m of ['GET', 'POST']) expect((await page(s, m, '/v1/cors-relay/fetch', m === 'POST' ? { body: { url: 'https://example.org/', method: 'GET' } } : {})).status).toBe(404);
    // Even in a test run the shipped binary has no such flag. --headless: a refusal opens no dialog.
    const r = spawnSync(EXE, ['--headless', '--data-dir', join(WORK, 'noflag'), '--port', String(PORT + 1), '--test-allow-cors-relay'], { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no CORS relay');
    const bytes = readFileSync(EXE);
    for (const m of ['GWB-CORS-RELAY-COMPILED-IN', 'rustls', 'X-Gwb-Relay']) expect(bytes.includes(m), m).toBe(false);
    // The shipped sidecar's sockets stay on this computer.
    expect(outboundConnections(['gwb-sidecar', 'gwb-stereo-viewer'])).toEqual([]);
  });

  test('the command is disabled, and the air-gapped file has no relay block', async ({ page: p }) => {
    const frame = await appPage(p, state());
    await useSidecar(frame, state());
    expect(await frame.evaluate(() => window.gisworkbench.commands.get('sidecar.corsrelay').enabled())).toBe(false);
    expect(await frame.evaluate(() => window.gisworkbench.commands.get('sidecar.corsrelay').profiles)).toEqual(['full']);
    const full = readFileSync(DIST, 'utf8');
    const air = readFileSync(join(DIST_DIR, 'gis-workbench-airgap.html'), 'utf8');
    expect(full).toContain('blk-js-corsrelay');
    expect(air).not.toContain('blk-js-corsrelay');
    expect(/"omitted":\[[^\]]*"js-corsrelay"/.test(air)).toBe(true);
  });
});

// ---------------------------------------------------------------- ArcGIS Pro sync

/** Pair a mock add-in the way the real one does: six digits, approved in the sidecar window. */
async function pairAddin(s, name = 'ArcGIS Pro add-in') {
  const r = await call(s.port, 'POST', '/sync/v1/pair', { body: { client: name } });
  expect(r.status).toBe(200);
  await approvePending(s, { expectCode: r.json.code });
  const st = await until(async () => {
    const j = (await call(s.port, 'GET', `/sync/v1/pair/${r.json.pairing_id}`)).json;
    return j.state === 'approved' ? j : null;
  });
  return st.token;
}

const viewOf = (frame) =>
  frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const l = p.geoLayer();
    const g = l.groundAt(p.view.cx, p.view.cy);
    return { lon: g.lon, lat: g.lat, mpp: p.groundScale(), zoom: p.view.zoom, cx: p.view.cx, cy: p.view.cy };
  });

async function syncOn(frame, direction) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.prosync');
  });
  const box = frame.locator('[data-id="prosync:on"]');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await frame.locator('[data-id="prosync:direction"]').selectOption(direction);
  await box.check();
  await expect(frame.locator('[data-id="prosync:status"]')).toHaveText(/^On/, { timeout: 30_000 });
}

const closeDialog = (frame, id) => frame.locator(`[data-id="dialog:${id}"] button`, { hasText: 'Close' }).last().click();

test.describe('REQ-GAP-65 sync with a mock add-in', () => {
  test.describe.configure({ mode: 'serial' }); // one sidecar on one port; a failure stops this group only
  const state = ownSidecar('sync');
  let addin;

  test('the add-in pairs through the sidecar window, and its token opens nothing else', async () => {
    const s = state();
    addin = await pairAddin(s);
    expect((await call(s.port, 'GET', '/sync/v1/hello', { token: addin })).json).toMatchObject({ paired: true, app: false });
    expect((await call(s.port, 'GET', '/v1/caps', { token: addin, origin: 'null' })).status).toBe(401);
    expect((await call(s.port, 'POST', '/relay/v1/mcp', { token: addin, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401);
    expect((await call(s.port, 'GET', '/sync/v1/hello', { token: addin, origin: 'null' })).status).toBe(403);
  });

  test('the add-in\'s own client replays the wire contract', async () => {
    test.skip(LINUX || !existsSync(MOCK), 'MockAddin is not built');
    const s = state();
    const r = spawnSync(MOCK, ['contract', '--port', String(s.port), '--addin-token', addin, '--page-token', s.token], { encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { ...process.env, GWB_SIDECAR_TEST: '1' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    expect(out).toEqual({ steps: CONTRACT.steps.length + 2, echo: CONTRACT.echo.length, failed: 0 });
  });

  test('view and cursor follow, both ways, with no loop', async ({ page: p }) => {
    const s = state();
    const frame = await appPage(p, s);
    await useSidecar(frame, s);
    await openFiles(frame, [resolve('fixtures/fx06/fx06_date1.tif')]);
    await expect.poll(() => frame.evaluate(() => !!window.gisworkbench.activePane()?.geoLayer()?.modelId), { timeout: 60_000 }).toBe(true);

    // Off until turned on: the add-in is refused.
    const v0 = { lon: 0, lat: 0, mpp: 1, rotation: 0 };
    expect((await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { view: v0 } })).json.code).toBe('no_app');

    await syncOn(frame, 'both');
    await axeClean(frame, '[data-id="dialog:pro-sync"]');
    await closeDialog(frame, 'pro-sync');

    // The app's view reaches the add-in.
    const here = await viewOf(frame);
    let u = (await call(s.port, 'GET', '/sync/v1/next?after=0', { token: addin })).json;
    expect(u.peer).toBe(true);
    expect(u.view.lon).toBeCloseTo(here.lon, 7);
    expect(u.view.lat).toBeCloseTo(here.lat, 7);
    expect(u.view.mpp / here.mpp).toBeCloseTo(1, 4);

    // The add-in's view moves the app: 60 image pixels away, at half the ground scale.
    const there = await frame.evaluate(() => {
      const q = window.gisworkbench.activePane();
      const g = q.geoLayer().groundAt(q.view.cx + 60, q.view.cy - 60);
      return { lon: g.lon, lat: g.lat };
    });
    const target = { ...there, mpp: here.mpp / 2, rotation: 0 };
    expect((await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { view: target } })).status).toBe(200);
    await expect.poll(async () => Math.abs((await viewOf(frame)).mpp / target.mpp - 1), { timeout: 15_000 }).toBeLessThan(0.01);
    const got = await viewOf(frame);
    const metres = Math.hypot((got.lon - target.lon) * 111320 * Math.cos((target.lat * Math.PI) / 180), (got.lat - target.lat) * 111320);
    console.log(`SCN-65 view from the add-in: ${metres.toFixed(3)} m off, ${got.mpp.toFixed(4)} m/px against ${target.mpp.toFixed(4)}`);
    expect(metres).toBeLessThan(2 * target.mpp);

    // No loop: the move the add-in asked for is not sent back, and nothing keeps moving.
    const counts = () => frame.evaluate(() => {
      const h2 = window.gisworkbench.sidecar.proSync;
      return { sent: h2.sent, received: h2.received };
    });
    const c0 = await counts();
    await new Promise((r) => setTimeout(r, 1500));
    expect(await counts()).toEqual(c0);
    expect((await viewOf(frame)).cx).toBeCloseTo(got.cx, 6);

    // The analyst pans: the add-in hears, once.
    const seq0 = (await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { cursor: { lon: 0, lat: 0, visible: false } } })).json.seq;
    await frame.evaluate(() => {
      const q = window.gisworkbench.activePane();
      q.setView({ cx: q.view.cx + 200 });
    });
    u = await until(async () => {
      const j = (await call(s.port, 'GET', `/sync/v1/next?after=${seq0}`, { token: addin })).json;
      return j.view ? j : null;
    });
    const moved = await viewOf(frame);
    expect(u.view.lon).toBeCloseTo(moved.lon, 7);

    // The app's cursor reaches the add-in; leaving the map says so.
    await frame.evaluate(() => {
      const app = window.gisworkbench;
      const q = app.activePane();
      app.cursorMoved(q, q.view.cx + 10, q.view.cy + 10);
    });
    const c = await until(async () => {
      const j = (await call(s.port, 'GET', `/sync/v1/next?after=${u.seq}`, { token: addin })).json;
      return j.cursor ? j : null;
    });
    expect(c.cursor.visible).toBe(true);
    await frame.evaluate(() => {
      const app = window.gisworkbench;
      app.cursorMoved(app.activePane(), NaN, NaN);
    });
    await until(async () => (await call(s.port, 'GET', `/sync/v1/next?after=${c.seq}`, { token: addin })).json.cursor?.visible === false);

    // The add-in's cursor is a cross where it should be, on the pixel.
    const mark = await frame.evaluate(() => {
      const q = window.gisworkbench.activePane();
      const g = q.geoLayer().groundAt(q.view.cx + 25, q.view.cy - 40);
      return { lon: g.lon, lat: g.lat, want: q.screenPoint(q.view.cx + 25, q.view.cy - 40) };
    });
    await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { cursor: { lon: mark.lon, lat: mark.lat, visible: true } } });
    const cross = await expect
      .poll(() => frame.evaluate(() => window.gisworkbench.links.cursorFor(window.gisworkbench.activePane())), { timeout: 15_000 })
      .not.toBeNull()
      .then(() => frame.evaluate(() => window.gisworkbench.links.cursorFor(window.gisworkbench.activePane())));
    expect(Math.hypot(cross.x - mark.want.x, cross.y - mark.want.y)).toBeLessThan(1);

    // The sidecar window shows it.
    await frame.evaluate(() => window.gisworkbench.sidecar.proSync.stop());
    expect((await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { view: v0 } })).json.code).toBe('no_app');
  });

  test('the side that follows cannot publish, and a reload leaves sync off', async ({ page: p }) => {
    const s = state();
    const frame = await appPage(p, s);
    await useSidecar(frame, s);
    await openFiles(frame, [resolve('fixtures/fx06/fx06_date1.tif')]);
    await expect.poll(() => frame.evaluate(() => !!window.gisworkbench.activePane()?.geoLayer()?.modelId), { timeout: 60_000 }).toBe(true);
    await syncOn(frame, 'pro_follows');
    await closeDialog(frame, 'pro-sync');
    expect((await call(s.port, 'POST', '/sync/v1/state', { token: addin, body: { cursor: { lon: 0, lat: 0, visible: false } } })).json.code).toBe('follows');
    await frame.evaluate(() => window.gisworkbench.sidecar.proSync.stop());
    await syncOn(frame, 'app_follows');
    await closeDialog(frame, 'pro-sync');
    const before = await frame.evaluate(() => window.gisworkbench.sidecar.proSync.sent);
    await frame.evaluate(() => {
      const q = window.gisworkbench.activePane();
      q.setView({ cx: q.view.cx + 50 });
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(await frame.evaluate(() => window.gisworkbench.sidecar.proSync.sent)).toBe(before);
    await frame.evaluate(() => window.gisworkbench.sidecar.proSync.stop());
  });

  test('the add-in\'s own loop follows the app and does not echo', async ({ page: p }) => {
    test.skip(LINUX || !existsSync(MOCK), 'MockAddin is not built');
    const s = state();
    const frame = await appPage(p, s);
    await useSidecar(frame, s);
    await openFiles(frame, [resolve('fixtures/fx06/fx06_date1.tif')]);
    await expect.poll(() => frame.evaluate(() => !!window.gisworkbench.activePane()?.geoLayer()?.modelId), { timeout: 60_000 }).toBe(true);
    await syncOn(frame, 'both');
    await closeDialog(frame, 'pro-sync');
    const child = spawn(MOCK, ['run', '--port', String(s.port), '--addin-token', addin], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GWB_SIDECAR_TEST: '1' } });
    const events = [];
    let tail = '';
    child.stdout.on('data', (d) => {
      tail += d;
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const l of lines) if (l.trim()) events.push(JSON.parse(l));
    });
    try {
      await until(() => events.some((e) => e.event === 'ready'), 20_000, 'the mock add-in');
      // The page's first view reached the fake map, through the real SyncLoop.
      const v = await until(() => events.find((e) => e.event === 'view'), 20_000, 'a view at the fake map');
      const here = await viewOf(frame);
      expect(v.Lon).toBeCloseTo(here.lon, 6);
      // A map repeats the move it was told to make: EchoGuard stops it, so the page hears nothing.
      const received = await frame.evaluate(() => window.gisworkbench.sidecar.proSync.received);
      child.stdin.write(`view ${v.Lon} ${v.Lat} ${v.Mpp} ${v.Rotation}\n`);
      await until(() => events.some((e) => e.event === 'sent' && e.kind === 'view'));
      await new Promise((r) => setTimeout(r, 800));
      expect(await frame.evaluate(() => window.gisworkbench.sidecar.proSync.received)).toBe(received);
      // A real move of Pro's map does reach the page.
      child.stdin.write(`view ${v.Lon + 0.002} ${v.Lat} ${v.Mpp} ${v.Rotation}\n`);
      await expect.poll(() => frame.evaluate(() => window.gisworkbench.sidecar.proSync.received), { timeout: 15_000 }).toBeGreaterThan(received);
      await expect.poll(async () => Math.abs((await viewOf(frame)).lon - (v.Lon + 0.002)), { timeout: 15_000 }).toBeLessThan(0.0002);
      child.stdin.write('quit\n');
    } finally {
      child.kill();
      await frame.evaluate(() => window.gisworkbench.sidecar.proSync?.stop());
    }
  });
});

// ---------------------------------------------------------------- the stereo viewer

const SIZE = 540;
const SHIFT = 16;
const noise = (x, y) => {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  return (h >>> 24) & 0xff;
};

/** A one-band 8-bit TIFF; `rotated` adds a georeference no ENVI file can hold (ModelTransformation). */
function tiff(file, value, { rotated = false } = {}) {
  const n = SIZE * SIZE;
  const ifd = 8 + n;
  const tags = [[256, 3, SIZE], [257, 3, SIZE], [258, 3, 8], [259, 3, 1], [262, 3, 1], [273, 4, 8], [277, 3, 1], [278, 3, SIZE], [279, 4, n]];
  const size = ifd + 2 + (tags.length + (rotated ? 1 : 0)) * 12 + 4;
  const b = Buffer.alloc(size + (rotated ? 128 : 0));
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(ifd, 4);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) b[8 + y * SIZE + x] = value(x, y);
  b.writeUInt16LE(tags.length + (rotated ? 1 : 0), ifd);
  if (rotated) {
    const at = ifd + 2 + tags.length * 12;
    b.writeUInt16LE(34264, at);
    b.writeUInt16LE(12, at + 2);
    b.writeUInt32LE(16, at + 4);
    b.writeUInt32LE(size, at + 8);
    [0.5, 0.1, 0, 100, 0.1, -0.5, 0, 200, 0, 0, 0, 0, 0, 0, 0, 1].forEach((d, i) => b.writeDoubleLE(d, size + i * 8));
  }
  tags.forEach(([id, ty, v], i) => {
    const at = ifd + 2 + i * 12;
    b.writeUInt16LE(id, at);
    b.writeUInt16LE(ty, at + 2);
    b.writeUInt32LE(1, at + 4);
    if (ty === 3) b.writeUInt16LE(v, at + 8);
    else b.writeUInt32LE(v, at + 8);
  });
  writeFileSync(file, b);
}

/** The mean of that buffer's red. */
function expectedMean(value) {
  let s = 0;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) s += value(x, y);
  return s / (960 * 540);
}

/** What the viewer's 960 × 540 buffer must hold, byte for byte: the image centred, black around it. */
function expectedSha(value) {
  const [W, H] = [960, 540];
  const b = Buffer.alloc(W * H * 4);
  for (let i = 3; i < b.length; i += 4) b[i] = 255;
  const ox = (W - SIZE) / 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < SIZE; x++) {
      const v = value(x, y);
      const at = (y * W + x + ox) * 4;
      b[at] = b[at + 1] = b[at + 2] = v;
    }
  return createHash('sha256').update(b).digest('hex');
}

const leftEye = (x, y) => noise(x, y);
const rightEye = (x, y) => (x >= SHIFT ? noise(x - SHIFT, y) : 0);

async function upload(s, file, name) {
  const r = await page(s, 'PUT', `/v1/files?name=${name}`, { raw: readFileSync(file), ct: 'application/octet-stream' });
  expect(r.status, r.body.toString()).toBe(201);
  return r.json.id;
}

async function showing(s, id, ms = 120_000) {
  return until(
    async () => {
      const i = (await page(s, 'GET', `/v1/stereo/${id}`)).json;
      if (i.state === 'failed') throw new Error(`the viewer failed: ${i.detail}`);
      return i.state === 'showing' ? i : null;
    },
    ms,
    'the viewer to show the pair',
  );
}

/** The viewer's process, a child of this sidecar, and whether it has a window anyone could see. */
function viewerProcess(sidecarPid) {
  const ps = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${sidecarPid} AND Name='gwb-stereo-viewer.exe'" | ForEach-Object { $p = Get-Process -Id $_.ProcessId; '{0} {1}' -f $_.ProcessId, $p.MainWindowHandle }`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  return out ? out.split(/\s+/).map(Number) : null;
}

test.describe('REQ-GAP-33 the native viewer', () => {
  test.describe.configure({ mode: 'serial' }); // one sidecar on one port; a failure stops this group only
  test.skip(LINUX, 'the viewer is built for Windows only in this release');
  const a = join(WORK, 'left.tif');
  const b = join(WORK, 'right.tif');
  test.beforeAll(() => {
    tiff(a, leftEye);
    tiff(b, rightEye);
  });

  const withDevice = async (device, fn, extra = []) => {
    const s = await startSidecar({ dataDir: resolve(DATA_ROOT, `native-${device}`), port: PORT, extra: ['--test-stereo-device', device, ...extra] });
    try {
      await fn(s);
    } finally {
      await stopped(s);
    }
  };

  test('a headless sidecar opens no window', async () => {
    const s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'native-nodisplay'), port: PORT });
    try {
      const caps = (await page(s, 'GET', '/v1/caps')).json;
      expect(caps.features.stereo_viewer).toBe(false);
      const id = await upload(s, a, `no-${randomBytes(4).toString('hex')}.tif`);
      const r = await page(s, 'POST', '/v1/stereo', { body: { left: id, right: id } });
      expect(r.json.code).toBe('no_display');
    } finally {
      await stopped(s);
    }
  });

  test('the quad-buffer path, on the software GL with four colour buffers: each eye, byte for byte', async () => {
    await withDevice('soft-quad', async (s) => {
      const [l, r] = [await upload(s, a, 'left.tif'), await upload(s, b, 'right.tif')];
      const open = await page(s, 'POST', '/v1/stereo', { body: { left: l, right: r } });
      expect(open.status, open.body.toString()).toBe(201);
      const i = await showing(s, open.json.id);
      expect(i.quad_available).toBe(true);
      expect(i.shown).toBe('quad');
      const rb = i.readback;
      expect(rb.gl_stereo).toBe(true);
      expect(rb.draw_buffers).toEqual(['GL_BACK_LEFT', 'GL_BACK_RIGHT']);
      expect(rb.left_sha256).toBe(expectedSha(leftEye));
      expect(rb.right_sha256).toBe(expectedSha(rightEye));
      console.log(`SCN-65 quad path: disparity ${rb.disparity_px.toFixed(3)} px against ${SHIFT}, score ${rb.disparity_score.toFixed(4)}`);
      expect(Math.abs(rb.disparity_px - SHIFT)).toBeLessThan(0.1);
      const [pid, win] = viewerProcess(s.pid);
      expect(pid).toBeGreaterThan(0);
      expect(win).toBe(0); // no window at all
      // Closing kills the process and ends the ticket.
      expect((await page(s, 'DELETE', `/v1/stereo/${i.id}`)).status).toBe(204);
      await until(() => viewerProcess(s.pid) === null, 15_000, 'the viewer to go');
      expect((await page(s, 'GET', `/v1/stereo/${i.id}`)).status).toBe(404);
    });
  });

  test('no quad-buffer display: it says so, and shows anaglyph with each eye in its channels', async () => {
    await withDevice('soft-mono', async (s) => {
      const [l, r] = [await upload(s, a, 'left.tif'), await upload(s, b, 'right.tif')];
      const open = await page(s, 'POST', '/v1/stereo', { body: { left: l, right: r, mode: 'quad' } });
      const i = await showing(s, open.json.id);
      expect(i.shown).toBe('anaglyph');
      expect(i.quad_available).toBe(false);
      expect(i.detail).toContain('no quad-buffer pixel format');
      expect(i.readback.draw_buffers).toEqual(['GL_BACK']);
      expect(i.readback.left_sha256).toBe(expectedSha(leftEye));
      expect(i.readback.right_sha256).toBe(expectedSha(rightEye));
    });
  });

  test('the real graphics driver, in a window that is never shown, at Low integrity in a Job Object', async () => {
    await withDevice('hidden', async (s) => {
      const [l, r] = [await upload(s, a, 'left.tif'), await upload(s, b, 'right.tif')];
      const open = await page(s, 'POST', '/v1/stereo', { body: { left: l, right: r } });
      const i = await showing(s, open.json.id);
      const rb = i.readback;
      console.log(`SCN-65 real driver: ${rb.renderer}, quad ${i.quad_available}, shown ${i.shown}, disparity ${rb.disparity_px.toFixed(3)} px, score ${rb.disparity_score.toFixed(4)}`);
      expect(rb.renderer).not.toContain('software GL');
      expect(i.quad_available).toBe(rb.gl_stereo);
      expect(Math.abs(rb.disparity_px - SHIFT)).toBeLessThan(0.5);
      expect(Math.abs(rb.left_mean[0] - expectedMean(leftEye))).toBeLessThan(1); // every pixel read is the window's
      expect(Math.abs(rb.right_mean[1] - expectedMean(rightEye))).toBeLessThan(1);
      expect(viewerProcess(s.pid)[1]).toBe(0); // a window handle Windows calls a main window would be non-zero
      await page(s, 'DELETE', `/v1/stereo/${i.id}`);
      await until(() => viewerProcess(s.pid) === null, 15_000, 'the viewer to go');
    });
  });

  test('the real window opens, draws and closes itself, without taking the focus', async () => {
    test.skip(process.env.GWB_WINDOW_TEST !== '1', 'it shows a window for a moment: only when asked for');
    const r = spawnSync(join(dirname(EXE), 'gwb-stereo-viewer.exe'), ['--test-pattern', '--test-exit-after', '5'], { encoding: 'utf8', timeout: 30_000 });
    console.log(`SCN-65 window: ${r.stdout.trim()}`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^frames=\d+ shown=(quad-buffer|anaglyph) quad=(true|false) renderer=\S/);
  });

  test('an image with a rotated georeference opens', async () => {
    const c = join(WORK, 'rotated.tif');
    tiff(c, leftEye, { rotated: true });
    await withDevice('soft-quad', async (s) => {
      const open = await page(s, 'POST', '/v1/stereo', { body: { left: await upload(s, c, 'r1.tif'), right: await upload(s, c, 'r2.tif') } });
      expect(open.status, open.body.toString()).toBe(201);
      const i = await showing(s, open.json.id);
      expect(i.readback.left_sha256).toBe(expectedSha(leftEye));
    });
  });

  test('a real stereo pair, WorldView-3 chips through GDAL', async () => {
    test.skip(!PAIR.every(existsSync), 'the corpus pair is absent');
    await withDevice('soft-quad', async (s) => {
      const open = await page(s, 'POST', '/v1/stereo', { body: { left: await upload(s, PAIR[0], 'a.tif'), right: await upload(s, PAIR[1], 'b.tif') } });
      expect(open.status, open.body.toString()).toBe(201);
      const i = await showing(s, open.json.id, 180_000);
      const rb = i.readback;
      console.log(`SCN-65 WV3 pair: ${i.left.width} x ${i.left.height} ${i.left.sample_type}, levels ${i.left.levels}, left mean ${rb.left_mean[0].toFixed(1)}, right mean ${rb.right_mean[0].toFixed(1)}, disparity ${rb.disparity_px.toFixed(2)} px, score ${rb.disparity_score.toFixed(3)}`);
      expect(i.shown).toBe('quad');
      expect(rb.left_sha256).not.toBe(rb.right_sha256);
      for (const m of [rb.left_mean[0], rb.right_mean[0]]) expect(m).toBeGreaterThan(5);
    });
  });

  test('the dialog: choose a pair, show it, close it', async ({ page: p }) => {
    await withDevice(
      'soft-quad',
      async (s) => {
        const frame = await appPage(p, s);
        await useSidecar(frame, s);
        await frame.evaluate(() => {
          window.gisworkbench.commands.run('sidecar.stereoviewer');
        });
        const dlg = frame.locator('[data-id="dialog:stereo-viewer"]');
        await expect(dlg).toBeVisible({ timeout: 20_000 });
        await expect(frame.locator('[data-id="stereo:show"]')).toBeDisabled();
        await frame.locator('[data-id="stereo:pick-left"]').click();
        await expect(frame.locator('[data-id="stereo:left"]')).toHaveText('left.tif');
        await frame.locator('[data-id="stereo:pick-right"]').click();
        await expect(frame.locator('[data-id="stereo:right"]')).toHaveText('right.tif');
        await axeClean(frame, '[data-id="dialog:stereo-viewer"]');
        await frame.locator('[data-id="stereo:show"]').click();
        await expect(frame.locator('[data-id="stereo:status"]')).toHaveText(/on the display: quad-buffer/, { timeout: 120_000 });
        await frame.locator('[data-id="stereo:close"]').click();
        await expect(frame.locator('[data-id="stereo:status"]')).toHaveText(/closed/);
        await until(() => viewerProcess(s.pid) === null, 15_000, 'the viewer to go');
        await closeDialog(frame, 'stereo-viewer');
      },
      ['--test-pick', a, '--test-pick', b],
    );
  });
});

// ---------------------------------------------------------------- the CORS relay, gate set for test

async function origin() {
  const srv = createServer({ key: readFileSync(join(CERTS, 'leaf.key')), cert: readFileSync(join(CERTS, 'leaf.pem')) }, (req, res) => {
    const port = srv.address().port;
    seen.push({ url: req.url, headers: req.headers });
    if (req.url.startsWith('/data')) return res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'a=b' }).end('no cors headers here');
    if (req.url === '/same') return res.writeHead(302, { location: '/data' }).end();
    if (req.url === '/away') return res.writeHead(302, { location: `https://other.test:${port}/data` }).end();
    if (req.url === '/down') return res.writeHead(302, { location: `http://origin.test:${port}/data` }).end();
    res.writeHead(404).end();
  });
  const seen = [];
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, seen, port: srv.address().port };
}

test.describe('REQ-GAP-08 with the gate set for test', () => {
  test.describe.configure({ mode: 'serial' }); // one sidecar on one port; a failure stops this group only
  test.skip(!existsSync(RELAY_EXE), 'no relay build (GWB_SIDECAR_RELAY_EXE)');

  test('compiled in, but the gate stays shut without the flag', async () => {
    const s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'native-shut'), port: PORT, exe: RELAY_EXE });
    try {
      expect((await page(s, 'GET', '/v1/caps')).json.features.cors_relay).toBe(false);
      const r = await page(s, 'POST', '/v1/cors-relay/fetch', { body: { url: 'https://example.org/', method: 'GET' } });
      expect(r.status).toBe(403);
      expect(r.json.code).toBe('gate_closed');
    } finally {
      await stopped(s);
    }
  });

  test('reaches a listed origin and refuses all others, each by name', async ({ page: p }) => {
    const o = await origin();
    const site = `https://origin.test:${o.port}`;
    const s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'native-relay'), port: PORT, exe: RELAY_EXE, extra: ['--test-allow-cors-relay', '--test-relay-ca', join(CERTS, 'ca.pem'), '--test-relay-resolve', 'origin.test=127.0.0.1', '--test-relay-resolve', 'other.test=127.0.0.1', '--test-relay-resolve', 'public.test=127.0.0.1'] });
    try {
      expect((await page(s, 'GET', '/v1/caps')).json.features.cors_relay).toBe(true);
      const fetchVia = (url, extra = {}) => page(s, 'POST', '/v1/cors-relay/fetch', { body: { url, method: 'GET', ...extra } });

      // Nothing is listed yet; no page can list anything.
      expect((await fetchVia(`${site}/data`)).json.code).toBe('not_listed');
      expect((await page(s, 'POST', '/ui/api/cors-origin', { body: { origin: site, private: true } })).status).toBe(404);
      await windowPost(s, '/ui/api/cors-origin', { origin: site, private: true });
      await windowPost(s, '/ui/api/cors-origin', { origin: `https://public.test:${o.port}`, private: false });
      await windowPost(s, '/ui/api/cors-origin', { origin: `https://other.test:${o.port}`, private: true });
      await windowPost(s, '/ui/api/cors-origin', { origin: 'https://127.0.0.1:47821', private: true }); // refused before any connection

      const ok = await fetchVia(`${site}/data?key=secret`);
      expect(ok.status).toBe(200);
      expect(ok.body.toString()).toBe('no cors headers here');
      expect(ok.headers['x-gwb-relay-status']).toBe('200');
      expect(ok.headers['set-cookie']).toBeUndefined();
      expect(ok.headers['access-control-allow-origin']).toBe('null');
      expect(o.seen[0].headers.cookie).toBeUndefined();
      expect(o.seen[0].headers.authorization).toBeUndefined();
      expect(o.seen[0].headers.origin).toBeUndefined();
      expect((await fetchVia(`${site}/same`)).body.toString()).toBe('no cors headers here');

      const n = o.seen.length;
      for (const [url, code, extra] of [
        ['http://example.org/', 'not_https'],
        ['https://not-listed.test/', 'not_listed'],
        [`https://origin.test:${o.port + 1}/data`, 'not_listed'],
        [`https://public.test:${o.port}/data`, 'private_target'], // listed, resolves to this computer, not marked
        ['https://127.0.0.1:47821/v1/caps', 'own_port'],
        ['https://2130706433/', 'bad_url'],
        ['https://user@example.org/', 'bad_url'],
        [`${site}/data`, 'bad_method', { method: 'POST' }],
        [`${site}/data`, 'bad_header', { range: 'bytes=0-1\r\nCookie: x' }],
      ]) {
        const r = await fetchVia(url, extra);
        expect(r.json?.code, `${url}: ${r.body}`).toBe(code);
      }
      expect(o.seen.length).toBe(n); // none of those reached a server
      expect((await fetchVia(`${site}/away`)).json.code).toBe('redirect_refused');
      expect((await fetchVia(`${site}/down`)).json.code).toBe('redirect_refused');
      expect(o.seen.some((x) => x.url === '/data' && x.headers.host?.startsWith('other.test'))).toBe(false);
      expect((await call(s.port, 'POST', '/v1/cors-relay/fetch', { origin: 'null', body: { url: `${site}/data`, method: 'GET' } })).status).toBe(401);

      // Every call is in the request log, with no query string.
      const log = readFileSync(join(s.dataDir, 'sidecar.log'), 'utf8');
      expect(log).toContain('/data for null');
      expect(log).toContain('refused');
      expect(log).toContain('(own_port)');
      expect(log).not.toContain('key=secret');

      // In the app: the command is on, a call goes through the logged fetch, and Offline stops it.
      const frame = await appPage(p, s);
      await useSidecar(frame, s);
      expect(await frame.evaluate(() => window.gisworkbench.commands.get('sidecar.corsrelay').enabled())).toBe(true);
      await frame.evaluate(() => {
        window.gisworkbench.commands.run('sidecar.corsrelay');
      });
      await expect(frame.locator('[data-id="dialog:cors-relay"]')).toBeVisible({ timeout: 20_000 });
      await frame.locator('[data-id="cors:origin"]').fill(site);
      await frame.locator('[data-id="cors:add"]').click();
      await expect(frame.locator('[data-id="cors:list"]')).toContainText('origin.test');
      await axeClean(frame, '[data-id="dialog:cors-relay"]');
      await closeDialog(frame, 'cors-relay');
      const got = await frame.evaluate(async (u) => {
        const app = window.gisworkbench;
        app.network.set?.('online');
        const r = await app.netlog.fetchFor('native spec')(u);
        return { status: r.status, text: await r.text(), entry: app.netlog.entries.find((e) => e.purpose === 'native spec') };
      }, `${site}/data`);
      expect(got.text).toBe('no cors headers here');
      expect(got.entry).toMatchObject({ relay: true, status: 200 });
      const refusedOffline = await frame.evaluate(async (u) => {
        const app = window.gisworkbench;
        const was = app.network.isOnline;
        app.network.isOnline = () => false;
        try {
          await app.netlog.fetchFor('native spec')(u);
          return 'went through';
        } catch (e) {
          return e.code;
        } finally {
          app.network.isOnline = was;
        }
      }, `${site}/data`);
      expect(refusedOffline).toBe('E_OFFLINE');
    } finally {
      await stopped(s);
      o.srv.close();
    }
  });
});
