// E2E helpers: open the built file in every run mode (REQ-HOST-09, PT-01) with console,
// CSP-violation and network capture; open sample files through a file input.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

export const ROOT = resolve('.');
// GW_DIST points the suites at another build: a folder (as gui-lib.js takes it, e.g. dist-21-video) or the .html itself (GWB_DIST: the same).
const GW_DIST = (process.env.GW_DIST ?? process.env.GWB_DIST) ? resolve(process.env.GW_DIST ?? process.env.GWB_DIST) : join(ROOT, 'dist');
export const DIST = GW_DIST.endsWith('.html') ? GW_DIST : join(GW_DIST, 'gis-workbench.html');
export const DIST_DIR = dirname(DIST); // the build's folder: its Lite and air-gapped files, packs, embed snippets
export const SAMPLES = resolve(ROOT, '..', 'Research', 'samples');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

/** Two static servers on different ports: the app origin and a "host page" origin. */
export async function servers(htmlPath = DIST) {
  const html = readFileSync(htmlPath);
  const app = createServer((req, res) => {
    if (req.url.startsWith('/gis-workbench.html') || req.url === '/') {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      return res.end(html);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appUrl = `http://127.0.0.1:${app.address().port}/gis-workbench.html`;
  const host = createServer((req, res) => {
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    if (req.url.startsWith('/srcdoc')) {
      const esc = html.toString().replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return res.end(`<!DOCTYPE html><title>host</title><iframe id="f" style="width:1400px;height:860px;border:0" allow="fullscreen; clipboard-read; clipboard-write; display-capture" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-modals" srcdoc="${esc}"></iframe>`);
    }
    res.end(`<!DOCTYPE html><title>host</title><iframe id="f" style="width:1400px;height:860px;border:0" allow="fullscreen; clipboard-read; clipboard-write; display-capture" src="${appUrl}"></iframe>`);
  });
  await new Promise((r) => host.listen(0, 'localhost', r));
  const hostUrl = `http://localhost:${host.address().port}/`;
  return { appUrl, hostUrl, close: () => Promise.all([new Promise((r) => app.close(r)), new Promise((r) => host.close(r))]) };
}

/**
 * Open the app. mode: 'file' | 'http' | 'iframe' (cross-origin) | 'srcdoc'.
 * `prefs` are User preferences set before boot. Without `prefs` the 1.x suites run in the
 * Classic layout (LEGACY_PREFS, DN-53); pass prefs: {} for the Modern
 * defaults, or e.g. { layout: 'classic' } (REQ-SHL-01/03).
 * Returns {frame, logs, csp, requests} where frame is the app's Frame.
 */
export const LEGACY_PREFS = { layout: 'classic', network: 'online' };

export async function openApp(page, mode = 'file', { srv, htmlPath = DIST, prefs = LEGACY_PREFS } = {}) {
  const logs = [];
  const requests = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Looking for a sidecar that is not running is a refused loopback connection, which the
    // browser always logs; the app reports it itself (REQ-SDC-01).
    if (/ERR_CONNECTION_REFUSED/.test(m.text()) && /^http:\/\/(127\.0\.0\.1|localhost):4782[1-3]\//.test(m.location()?.url ?? '')) return;
    // Lite's viewport meta asks Chrome for its keyboard behaviour; WebKit logs that it ignores the key.
    if (/^Viewport argument key "interactive-widget" not recognized/.test(m.text())) return;
    logs.push(m.text());
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(file|data|blob|about|chrome-extension):/.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(u)) requests.push(u);
  });
  if (prefs) {
    await page.addInitScript((p) => {
      try {
        const k = 'gisworkbench.prefs.v1';
        localStorage.setItem(k, JSON.stringify({ ...JSON.parse(localStorage.getItem(k) ?? '{}'), ...p }));
      } catch {
        /* storage blocked in this frame */
      }
    }, prefs);
  }
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  let frame;
  if (mode === 'file') {
    await page.goto(pathToFileURL(htmlPath).href);
    frame = page.mainFrame();
  } else if (mode === 'http') {
    await page.goto(srv.appUrl);
    frame = page.mainFrame();
  } else {
    await page.goto(mode === 'srcdoc' ? `${srv.hostUrl}srcdoc` : srv.hostUrl);
    const el = await page.waitForSelector('#f');
    frame = await el.contentFrame();
    for (let i = 0; i < 50 && (!frame || frame.url() === 'about:blank'); i++) {
      await page.waitForTimeout(100);
      frame = await el.contentFrame();
    }
  }
  await frame.waitForFunction(() => document.body?.dataset.ready, null, { timeout: 45_000 });
  const ready = await frame.evaluate(() => document.body.dataset.ready);
  expect(ready, 'data-ready').toBe('1');
  return { frame, logs, requests, csp: () => frame.evaluate(() => window.__csp ?? []) };
}

/**
 * Start the app again in the same tab (a reload, as a later start), and wait until it is ready. Use
 * this, not page.reload(). Chromium on Linux often gives the next file:// document an empty
 * localStorage, even with no app code on the page, while http and Windows keep it (#9). So on Linux,
 * for a file:// page, this carries over what the app wrote to localStorage, standing in for the
 * browser. The Windows local gate still tests the browser keeping it.
 */
export async function restart(page) {
  if (process.platform === 'linux' && page.url().startsWith('file:')) {
    const kept = await page.evaluate(() => Object.entries(localStorage));
    // Init scripts run in registration order, so the latest restart's copy is the one that stands.
    await page.addInitScript(([url, kept]) => {
      if (location.href !== url) return;
      for (const [k, v] of kept) localStorage.setItem(k, v);
    }, [page.url(), kept]);
  }
  await page.reload();
  const frame = page.mainFrame();
  await frame.waitForFunction(() => document.body?.dataset.ready, null, { timeout: 45_000 });
  expect(await frame.evaluate(() => document.body.dataset.ready), 'data-ready').toBe('1');
  return frame;
}

/**
 * CI has no Research samples, corpus or fetched packs, and `verify full` builds without the packs,
 * so a test that needs them skips there. Only the release gate needs everything, and a missing
 * file still fails it.
 */
export function needsData(...paths) {
  const partial = process.env.CI || process.env.GWB_PARTIAL_DATA;
  test.skip(Boolean(partial) && !paths.every((p) => existsSync(p)), 'needs data that only the release gate has');
}

let packsOfBuild;
/** The build manifest's packs ({name: {file, …}}), or null without a build. */
function builtPacks() {
  if (packsOfBuild === undefined) {
    const m = existsSync(DIST) ? /<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(readFileSync(DIST, 'utf8')) : null;
    packsOfBuild = m ? JSON.parse(m[1]).packs ?? null : null;
  }
  return packsOfBuild;
}

/** The built pack of this name (`ai` means the base AI pack). */
export function packPath(name) {
  const dir = resolve(DIST_DIR, 'packs');
  // The build manifest names each pack's file: "geoid-" also begins geoid-egm2008-25-…, and
  // versions may hold hyphens, so a prefix alone can pick the wrong pack.
  const m = builtPacks();
  const file = m ? m[name]?.file : (existsSync(dir) ? readdirSync(dir).find((f) => (name === 'ai' ? /^ai-\d/.test(f) : f.startsWith(`${name}-`))) : undefined);
  needsData(join(dir, file ?? `${name}-is-not-built`));
  return resolve(dir, file);
}

/** Open local files in the app through a temporary file input. Returns the app's result string. */
export async function openFiles(frame, paths) {
  needsData(...paths);
  for (const p of paths) if (!existsSync(p)) throw new Error(`missing sample ${p}`);
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    i.setAttribute('aria-label', 'Test files');
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(paths);
  // Each file's path below the files' common folder, as a folder pick gives it (webkitRelativePath):
  // a 3D Tiles or quantized-mesh set names its tiles by path (2.1, REQ-FMT-36/38).
  const dirs = paths.map((p) => resolve(p).split(/[\\/]/).slice(0, -1));
  let n = 0;
  while (dirs.length && dirs.every((d) => d.length > n && d[n].toLowerCase() === dirs[0][n].toLowerCase())) n++;
  const rels = paths.map((p) => resolve(p).split(/[\\/]/).slice(n).join('/'));
  return frame.evaluate(async ([i, rels]) => {
    const files = [...i.files];
    i.remove();
    files.forEach((f, k) => (f.relPath = rels[k]));
    const app = window.gisworkbench;
    const before = app.importLog.length;
    await app.openFiles(files);
    return app.importLog.slice(before);
  }, [input, rels]);
}

export function sample(...p) {
  return join(SAMPLES, ...p);
}

export function ext(p) {
  return extname(p).toLowerCase();
}
