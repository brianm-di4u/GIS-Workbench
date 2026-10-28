// Platform tests PT-01, PT-02, PT-03, PT-05, PT-07, PT-08 on the built file. REQ-ARC-20: the built
// file is tested over file://, http:// and an iframe, with CSP, network capture and WebGL checks.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openApp, servers, openFiles, sample, DIST } from './helpers.js';

let srv;
test.beforeAll(async () => {
  srv = await servers();
});
test.afterAll(async () => srv?.close());

for (const mode of ['file', 'http', 'iframe', 'srcdoc']) {
  test(`PT-01 REQ-ARC-01 REQ-HOST-01 REQ-HOST-09 boots over ${mode} with no console errors or CSP violations`, async ({ page }) => {
    const { frame, logs, csp, requests } = await openApp(page, mode, { srv });
    const rm = await frame.evaluate(() => ({ mode: window.gisworkbench.runMode.mode, caps: window.gisworkbench.runMode.caps, bootMs: window.gisworkbench.bootMs, marks: window.gisworkbench.bootMarks }));
    // REQ-PRF-01 guard on the test machine: an interactive shell well inside 1.5 s.
    expect(rm.bootMs, JSON.stringify(rm.marks)).toBeLessThan(1500);
    expect(rm.mode).toBe({ file: 'file', http: 'hosted', iframe: 'cross-origin-iframe', srcdoc: 'srcdoc' }[mode]);
    if (mode === 'iframe') expect(rm.caps.fsaPicker).toBe(false); // REQ-HOST-02: input fallback in cross-origin frames
    expect(await csp()).toEqual([]);
    expect(logs).toEqual([]);
    expect(requests).toEqual([]);
    // The image pane renders real pixels in every mode.
    await openFiles(frame, [sample('geotiff-gdal-small', 'small_world.tif')]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex, null, { timeout: 30_000 });
  });
}

test('PT-02 REQ-SEC-01 REQ-SEC-12 REQ-AI-05 no request leaves unless the origin was added; every request is logged', async ({ page }) => {
  const { frame, requests } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    let msg = null;
    try {
      await app.netlog.fetchFor('test')('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
    } catch (e) {
      msg = e.message;
    }
    // A raw fetch is also stopped by the CSP itself.
    let raw = null;
    try {
      await fetch('https://example.org/');
    } catch (e) {
      raw = e.name;
    }
    return { msg, raw, log: app.netlog.entries, csp: document.getElementById('csp').content };
  });
  expect(r.msg).toMatch(/not in this file's network allow-list/);
  expect(r.raw).toBe('TypeError');
  expect(r.log[0]).toMatchObject({ origin: 'https://api.anthropic.com', status: 'not allowed' });
  // 2.0 (OD-2.3, REQ-NET-01): blob: plus exactly the reviewed public origins of build/origins.json,
  // used only while Online; the air-gapped file keeps blob: alone (net-p3.spec.js).
  const curated = JSON.parse(readFileSync(resolve('build/origins.json'), 'utf8')).origins.map((o) => o.origin);
  expect(/connect-src([^;]*);/.exec(r.csp)[1].trim().split(/\s+/)).toEqual(['blob:', ...curated]);
  expect(r.csp).not.toMatch(/[^-]'unsafe-eval'/);
  expect(requests).toEqual([]);
});

test('PT-03 REQ-ARC-02 REQ-RUST-01 a tampered block is refused', async ({ page }) => {
  const html = readFileSync(DIST, 'utf8');
  // Flip characters inside the lazy parse WASM block (stays valid base64).
  const m = /(<script type="application\/octet-stream" id="blk-wasm-parse"[^>]*>)([A-Za-z0-9+/=]+)/.exec(html);
  const b64 = m[2];
  const mid = Math.floor(b64.length / 2);
  const flipped = b64.slice(0, mid) + (b64[mid] === 'A' ? 'B' : 'A') + b64.slice(mid + 1);
  const dir = join(tmpdir(), 'gw-pt03');
  mkdirSync(dir, { recursive: true });
  const bad = join(dir, 'tampered.html');
  writeFileSync(bad, html.replace(m[0], m[1] + flipped));
  const { frame } = await openApp(page, 'file', { htmlPath: bad });
  const v = await frame.evaluate(() => window.__gw.verifyAll());
  expect(v['wasm-core']).toBe('ok');
  expect(v['wasm-parse']).toMatch(/SHA-256|gzip|decompress|incorrect|invalid/i);
  // Opening a NITF needs the parse bundle: it must fail cleanly, not run tampered code.
  const log = await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  expect(log[0].errors.join(' ')).toMatch(/SHA-256|refusing|worker|gzip|decompress/i);
});

test('PT-05 REQ-ARC-05 REQ-RUST-04 the worker pool runs, cancels, times out and recovers from a WASM trap', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const pool = window.gisworkbench.pool;
    const out = {};
    out.ping = await pool.run('ping', { ms: 50 });
    const job = pool.run('ping', { ms: 5000 });
    setTimeout(() => job.cancel(), 100);
    try {
      await job;
    } catch (e) {
      out.cancelled = e.cancelled === true;
    }
    try {
      await pool.run('spin', {}, { timeout: 1500 });
    } catch (e) {
      out.timedOut = e.timedOut === true;
    }
    try {
      await pool.run('trap', {});
    } catch (e) {
      out.trapped = e.trapped === true;
      out.trapMsg = e.message;
    }
    out.after = await pool.run('ping', { ms: 0 });
    out.history = pool.history.slice(0, 6).map((h) => `${h.op}:${h.state}${h.trapped ? ':trapped' : ''}`);
    return out;
  });
  expect(r.ping.pong).toBe(true);
  expect(r.cancelled).toBe(true);
  expect(r.timedOut).toBe(true);
  expect(r.trapped).toBe(true);
  expect(r.after.pong).toBe(true);
  expect(r.history.join(' ')).toContain('trap:failed:trapped');
});

test('PT-07 REQ-ARC-08 REQ-ARC-09 REQ-ARC-10 the project saves, reloads and relinks imagery by fingerprint', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles([sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf'), sample('nitf-wv3-mvs-stereo-chips', 'wv3_b_chip.ntf')]);
  const r = await frame.evaluate(async (inp) => {
    const app = window.gisworkbench;
    const { serialiseProject, readProject, relink } = app.__test;
    const pane = app.activePane();
    // Add a ground graphic through the registry (deterministic coordinates from the model).
    const view = JSON.parse((await app.registry.call('gw_get_view', {})).content);
    const prop = await app.registry.call('gw_create_graphic', { shape: 'marker', coordinates: [[view.centre.lon, view.centre.lat]], text: 'PT-07' });
    app.proposals.accept(prop.proposal.id);
    const bytes = serialiseProject(app);
    const parsed = readProject(bytes);
    const refs = parsed.records.filter((x) => x.type === 'fileref');
    const res = await relink(refs, [...inp.files]);
    return {
      size: bytes.length,
      manifest: parsed.manifest.format,
      graphics: parsed.records.filter((x) => x.type === 'graphic').length,
      layers: parsed.records.filter((x) => x.type === 'layer').length,
      linked: [...res.linked.values()].map((f) => f.name),
      missing: res.missing.length,
      paneLayer: pane.rec.layers.length,
      noImagery: !new TextDecoder().decode(bytes).includes('NITF02.10'),
    };
  }, input);
  expect(r.manifest).toBe('gis-workbench-project');
  expect(r.graphics).toBe(1);
  expect(r.layers).toBe(1);
  expect(r.linked).toEqual(['wv3_a_chip.ntf']); // b has the same size but a different fingerprint
  expect(r.missing).toBe(0);
  expect(r.noImagery).toBe(true);
});

test('PT-08 REQ-ARC-22 WebGL context loss restores every pane', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [sample('geotiff-gdal-small', 'small_world.tif')]);
  const px = () =>
    frame.evaluate(async () => {
      const app = window.gisworkbench;
      for (let i = 0; i < 100; i++) {
        const l = [...app.layers.values()][0];
        if (l?.lutTex && !l.tiles.loading) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 300));
      const cap = app.renderer.capture();
      const r = app.activePane().el.getBoundingClientRect();
      const x = Math.round((r.left + r.width / 2) * cap.dpr);
      const y = Math.round((r.top + r.height / 2) * cap.dpr);
      const i = (y * cap.width + x) * 4;
      return [cap.data[i], cap.data[i + 1], cap.data[i + 2]];
    });
  const before = await px();
  expect(before.some((v) => v > 10)).toBe(true);
  const ok = await frame.evaluate(() => new Promise((res) => {
    const app = window.gisworkbench;
    app.once('gl-restored', () => res(true));
    if (!app.renderer.simulateContextLoss(300)) res(false);
  }));
  expect(ok).toBe(true);
  const after = await px();
  expect(after.some((v) => v > 10)).toBe(true);
});
