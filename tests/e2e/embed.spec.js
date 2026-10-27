// Embed kit and Lite profile: REQ-HOST-04 (paste-ready snippet), REQ-HOST-05 (Lite loader
// stub + gzip payload), REQ-HOST-06 (own CSP kept inside the frame), REQ-HOST-07 (runs with
// storage blocked, with a warning), REQ-HOST-08 (degrades without iframe permissions).
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles, sample, ROOT } from './helpers.js';

const LITE = join(ROOT, 'dist', 'gis-workbench-lite.html');
const SNIPPET = join(ROOT, 'dist', 'embed', 'snippet.html');
const SNIPPET_LITE = join(ROOT, 'dist', 'embed', 'snippet-lite.html');

let host;
let base;
test.beforeAll(async () => {
  const pages = {
    '/snippet': () => readFileSync(SNIPPET, 'utf8'),
    '/snippet-lite': () => readFileSync(SNIPPET_LITE, 'utf8'),
    // A host that grants only scripts: no same-origin (storage throws), no downloads, no permissions.
    '/locked': () => readFileSync(SNIPPET_LITE, 'utf8').replace(/ allow="[^"]*"/, '').replace(/sandbox="[^"]*"/, 'sandbox="allow-scripts"'),
  };
  host = createServer((req, res) => {
    if (req.url === '/favicon.ico') return res.writeHead(204).end();
    const make = pages[req.url];
    res.writeHead(make ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    // The snippet is pasted into an ordinary page of the host, with the host's own chrome around it.
    res.end(make ? `<!DOCTYPE html><title>Host page</title><h1 style="font:14px sans-serif">Team wiki</h1>${make().replace('<iframe ', '<iframe id="f" ')}` : '');
  });
  await new Promise((r) => host.listen(0, 'localhost', r));
  base = `http://localhost:${host.address().port}`;
});
test.afterAll(() => new Promise((r) => host.close(r)));

async function inHost(page, path) {
  const logs = [];
  page.on('console', (m) => m.type() === 'error' && logs.push(m.text()));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(base + path);
  const el = await page.waitForSelector('#f');
  let frame = await el.contentFrame();
  await frame.waitForFunction(() => document.body?.dataset.ready === '1', null, { timeout: 45_000 });
  frame = await el.contentFrame();
  return { frame, logs };
}

test('REQ-HOST-05 the Lite file boots from file:// and decodes JPEG 2000 through the lazy bundle', async ({ page }) => {
  const size = readFileSync(LITE).length;
  expect(size).toBeLessThan(readFileSync(join(ROOT, 'dist', 'gis-workbench.html')).length * 0.85);
  const { frame, logs } = await openApp(page, 'file', { htmlPath: LITE });
  expect(await frame.evaluate(() => window.__gw.manifest.build.profile)).toBe('lite');
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip_j2k.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex, null, { timeout: 30_000 });
  // The written document carries the app's own CSP meta (REQ-HOST-06).
  expect(await frame.evaluate(() => document.getElementById('csp').content)).toMatch(/^default-src 'none'/);
  expect(logs).toEqual([]);
});

for (const path of ['/snippet', '/snippet-lite']) {
  test(`REQ-HOST-04 REQ-HOST-06 the pasted ${path.slice(1)} boots inside a host page and keeps its CSP`, async ({ page }) => {
    const { frame, logs } = await inHost(page, path);
    const r = await frame.evaluate(() => ({ mode: window.gisworkbench.runMode.mode, csp: document.getElementById('csp').content, warn: window.gisworkbench.storageWarning ?? null }));
    expect(r.mode).toBe('srcdoc');
    expect(r.csp).toContain("connect-src blob:");
    expect(r.warn).toBeNull();
    await openFiles(frame, [sample('geotiff-gdal-small', 'small_world.tif')]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex, null, { timeout: 30_000 });
    expect(logs).toEqual([]);
  });
}

test('REQ-HOST-03 REQ-HOST-07 REQ-HOST-08 a locked-down sandbox (scripts only) still runs, warns about storage and keeps working', async ({ page }) => {
  const { frame, logs } = await inHost(page, '/locked');
  const r = await frame.evaluate(() => {
    const app = window.gisworkbench;
    return { warn: app.storageWarning, journal: app.journal.available, caps: app.runMode.caps, problems: app.runMode.problems ?? [] };
  });
  expect(r.warn).toMatch(/storage is unavailable/i);
  expect(r.journal).toBe(false);
  expect(r.caps.downloadsLikely).toBe(false);
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex, null, { timeout: 30_000 });
  // Saving falls back to the in-page export panel instead of a blocked download.
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.save'));
  await expect(frame.locator('.dlg')).toContainText(/Downloads look blocked/);
  // Whiteboard pages still work for the session (no IndexedDB).
  await frame.evaluate(() => window.gisworkbench.feedback.toggle(true));
  expect(await frame.evaluate(() => window.gisworkbench.feedback.active)).toBe(true);
  expect(logs.filter((l) => !/IndexedDB|localStorage|sessionStorage|SecurityError/i.test(l))).toEqual([]);
});
