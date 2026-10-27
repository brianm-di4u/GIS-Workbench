// E2E helpers: open the built file in every run mode (REQ-HOST-09, PT-01) with console,
// CSP-violation and network capture; open sample files through a file input.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

export const ROOT = resolve('.');
export const DIST = join(ROOT, 'dist', 'gis-workbench.html');
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
 * Returns {frame, logs, csp, requests} where frame is the app's Frame.
 */
export async function openApp(page, mode = 'file', { srv, htmlPath = DIST } = {}) {
  const logs = [];
  const requests = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(m.text());
  });
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!/^(file|data|blob|about|chrome-extension):/.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(u)) requests.push(u);
  });
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

/** Open local files in the app through a temporary file input. Returns the app's result string. */
export async function openFiles(frame, paths) {
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
  return frame.evaluate(async (i) => {
    const files = [...i.files];
    i.remove();
    const app = window.gisworkbench;
    const before = app.importLog.length;
    await app.openFiles(files);
    return app.importLog.slice(before);
  }, input);
}

export function sample(...p) {
  return join(SAMPLES, ...p);
}

export function ext(p) {
  return extname(p).toLowerCase();
}
