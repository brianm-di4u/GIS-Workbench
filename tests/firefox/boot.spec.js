// OD-2.31 D24, a non-blocking Firefox run: PT-01 without its timing guard, so that the checks after it
// are reached (platform.spec.js stops at 1.5 s, which Firefox misses here). Read by
// playwright.firefox.config.js only; the release gates do not run it.
import { test, expect } from '@playwright/test';
import { openApp, openFiles, servers, sample } from '../e2e/helpers.js';

let srv;
test.beforeAll(async () => {
  srv = await servers();
});
test.afterAll(async () => srv?.close());

for (const mode of ['file', 'http', 'iframe', 'srcdoc'])
  test(`boots over ${mode}: no console errors, no CSP violations, no requests, real pixels`, async ({ page }) => {
    const { frame, logs, csp, requests } = await openApp(page, mode, { srv });
    const rm = await frame.evaluate(() => ({ mode: window.gisworkbench.runMode.mode, gl: window.gisworkbench.runMode.caps.gl, bootMs: window.gisworkbench.bootMs }));
    console.log(JSON.stringify({ mode, bootMs: rm.bootMs, gl: rm.gl }));
    expect(await csp()).toEqual([]);
    expect(logs).toEqual([]);
    expect(requests).toEqual([]);
    await openFiles(frame, [sample('geotiff-gdal-small', 'small_world.tif')]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex, null, { timeout: 30_000 });
  });
