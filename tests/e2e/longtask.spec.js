// #63 (REG-167, narrowed): no freeze on the four paths a large vector dataset takes. 100 000
// features (a 36 MB GeoJSON) go in through Open Vector, the same layer comes in again as a
// GeoPackage, and the project is saved and opened again, each through its command. The GUI
// sweep's watchdog (gui-lib.js) reports any main-thread task of 2 s or more (REQ-ING-04).
//
// On the development machine the longest task on each path is about 0.5 s at this size (it was
// 1.4 s to 3.6 s), and under 2 s at 300 000 features (it was 7 s to 15 s).

import { test, expect } from '@playwright/test';
import { boot, markNow, observe } from './gui-lib.js';

const N = 100_000;

test('#63 REQ-ING-04 a 100 000-feature layer opens as GeoJSON and GeoPackage, and saves and reopens in a project, with no task over 2 s', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'long-task timing is Chromium only');
  test.setTimeout(240_000);
  const app = await boot(page, 'full');
  const f = app.frame;
  // The data (not timed), and a stand-in for the native open picker that returns it.
  await f.evaluate((n) => {
    let s = 1;
    const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const features = [];
    for (let i = 0; i < n; i++) {
      const x = -84 + r() * 2;
      const y = 39 + r() * 2;
      const k = i % 10;
      const geometry =
        k < 6
          ? { type: 'Point', coordinates: [x, y] }
          : k < 9
            ? { type: 'LineString', coordinates: Array.from({ length: 10 }, (_, j) => [x + j * 1e-3, y + r() * 1e-3]) }
            : { type: 'Polygon', coordinates: [[...Array.from({ length: 19 }, (_, j) => [x + 1e-3 * Math.cos(j / 3), y + 1e-3 * Math.sin(j / 3)]), [x + 1e-3, y]]] };
      features.push({ type: 'Feature', properties: { id: i, name: `f${i}`, cls: k, h: r() * 100, ok: i % 2 === 0 }, geometry });
    }
    window.__pick = new File([JSON.stringify({ type: 'FeatureCollection', features })], 'big.geojson');
    window.showOpenFilePicker = async () => [{ getFile: async () => window.__pick }];
  }, N);
  const features = () => f.evaluate(() => window.gisworkbench.store.all('feature').length);
  /** Run one command, wait for `done`, let the tasks it left (the journal's write) run, and report what went wrong. */
  const step = async (command, done) => {
    const mark = await markNow(page, app);
    await f.evaluate((c) => window.gisworkbench.commands.run(c), command);
    await f.waitForFunction(done, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    const { problems } = await observe(page, app, mark, 'full');
    const long = await page.evaluate((n) => window.__longtasks.slice(n), mark.long);
    test.info().annotations.push({ type: 'timing', description: `${command}: longest task ${Math.max(0, ...long)} ms` });
    return problems;
  };

  // GeoJSON through Open Vector.
  expect(await step('file.openvector', () => window.gisworkbench.store.all('vlayer').length === 1)).toEqual([]);
  expect(await features()).toBe(N);

  // The same layer as a GeoPackage (written by the app, not timed), through Open Vector.
  await f.evaluate(async () => {
    const a = window.gisworkbench;
    const { bytes } = await a.attribution.gpkgBytes([a.store.all('vlayer')[0].id], {});
    window.__pick = new File([bytes], 'big.gpkg');
  });
  expect(await step('file.openvector', () => window.gisworkbench.store.all('vlayer').length === 2)).toEqual([]);
  expect(await features()).toBe(2 * N);

  // Save Project, captured as the automation API captures saves.
  await f.evaluate(() => (window.gisworkbench.saveCapture = (blob) => (window.__saved = blob)));
  expect(await step('file.save', () => !!window.__saved && !!window.gisworkbench.store.get('project')?.savedAt)).toEqual([]);
  const saved = await f.evaluate(() => (delete window.gisworkbench.saveCapture, (window.__pick = new File([window.__saved], 'big.gwb')), window.__saved.size));
  expect(saved).toBeGreaterThan(1e6);

  // Open Project on that file: every feature comes back.
  await f.evaluate(() => window.gisworkbench.store.transact('marker', (tx) => tx.create('observation', { text: 'after the save' })));
  expect(await step('file.openproject', () => !window.gisworkbench.store.all('observation').length && window.gisworkbench.store.all('feature').length > 0)).toEqual([]);
  expect(await features()).toBe(2 * N);
  expect(await f.evaluate(() => window.gisworkbench.store.all('vlayer').map((v) => v.name).sort())).toEqual(['big', 'big']);
});
