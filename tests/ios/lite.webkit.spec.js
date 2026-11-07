// What tests/e2e/25-mobile does not ask of WebKit: which engine this was, whether start-up found a
// problem, whether the decode path works over HTTP with its workers and WASM, and what Web Share
// says about the export formats. Playwright's WebKit on Windows, not Safari on iOS.

import { test, expect, devices } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { defaultBrowserType, ...iphone } = devices['iPhone 15'];
test.use(iphone);

const LITE = 'http://127.0.0.1:8765/gis-workbench-lite.html';
const REPORT = join('reports', 'ios', 'webkit-facts.json');

test('REQ-HOST-05 the engine, the start-up and the image path over HTTP in WebKit', async ({ page, browserName, browser }) => {
  expect(browserName).toBe('webkit');
  await page.addInitScript(() => localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify({ network: 'offline' })));
  await page.goto(LITE);
  await page.waitForFunction(() => document.body?.dataset.ready === '1', null, { timeout: 60_000 });
  const facts = await page.evaluate(() => {
    const app = window.gisworkbench;
    const { webgl2, wasm, blobWorkers, indexedDB, secureContext, fsaSave, webgpu, offscreenCanvas } = app.runMode.caps;
    const file = (name, type) => new File([new Uint8Array(1)], name, { type });
    const can = (f) => {
      try {
        return navigator.canShare?.({ files: [f] }) ?? null;
      } catch (e) {
        return e.name;
      }
    };
    return {
      userAgent: navigator.userAgent,
      problems: app.runMode.problems,
      caps: { webgl2, wasm, blobWorkers, indexedDB, secureContext, fsaSave, webgpu, offscreenCanvas },
      share: !!navigator.share,
      canShare: { geojson: can(file('a.geojson', 'application/geo+json')), kml: can(file('a.kml', 'application/vnd.google-earth.kml+xml')), zip: can(file('a.zip', 'application/zip')) },
    };
  });
  const input = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(join('fixtures', 'fx01', 'fx01.ntf'));
  await page.evaluate(async (i) => {
    const files = [...i.files];
    i.remove();
    await window.gisworkbench.openFiles(files);
  }, input);
  await expect(page.locator('[data-id="m:readout"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => !!window.gisworkbench.activePane()?.geoLayer?.()?.modelId);
  const shot = join('reports', 'ios', 'shots', 'webkit-image.png');
  mkdirSync(join('reports', 'ios', 'shots'), { recursive: true });
  await page.screenshot({ path: shot });
  writeFileSync(REPORT, JSON.stringify({ browserVersion: browser.version(), ...facts }, null, 1));
  expect(facts.userAgent).toMatch(/AppleWebKit/);
  expect(facts.problems).toEqual([]);
});
