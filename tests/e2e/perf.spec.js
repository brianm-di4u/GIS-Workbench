// Performance on this machine (REQ-PRF-02, REQ-PRF-03, REQ-PRF-04, REQ-PRF-08). The SDP gate is
// the managed reference laptop; these runs record the numbers here (reports/perf-<browser>.json)
// and fail only on gross regressions against the budgets.
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const COG = sample('geotiff-wv3-rpc-cog', 'wv3_a_cog.tif');
const out = {};

test.afterAll(({ browserName }, info) => {
  mkdirSync('reports', { recursive: true });
  writeFileSync(`reports/perf-${info.project.name}.json`, JSON.stringify({ measured: new Date().toISOString(), ...out }, null, 1));
});

test('REQ-PRF-03 first tile of a local NITF and a COG within 1 s', async ({ page }) => {
  for (const [name, file] of [['FX-01 NITF 4096² (16 MiB, one block)', FX01], ['WV3 COG', COG]]) {
    const { frame } = await openApp(page, 'file');
    const t0 = Date.now();
    await openFiles(frame, [file]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && l.tiles.gpu.size > 0), null, { timeout: 15000, polling: 10 });
    const ms = Date.now() - t0;
    out[`firstTileMs ${name}`] = ms;
    expect(ms, name).toBeLessThan(1000);
  }
});

test('REQ-PRF-02 REQ-PRF-08 a 2×2 multiport with DRA and bicubic while roaming; memory within budget', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('2x2'));
  for (let i = 0; i < 4; i++) {
    await frame.evaluate((i) => window.gisworkbench.activeMp().setActivePane(window.gisworkbench.activeMp().panes[i]), i);
    await openFiles(frame, [FX01]);
  }
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].length === 4 && [...window.gisworkbench.layers.values()].every((l) => l.lutTex && !l.tiles.loading), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    for (const l of app.layers.values()) app.setChain((c) => ((c.kernel = 'bicubic'), (c.dra.scope = 'viewport')), 'perf', { layerId: l.id });
    const panes = app.activeMp().panes;
    panes.forEach((p) => p.setView({ cx: 2048, cy: 2048, zoom: 0.6, rot: 0, mode: 'native' }));
    await new Promise((res) => setTimeout(res, 1500)); // tiles in place
    const f0 = app.renderer.frame;
    const t0 = performance.now();
    let k = 0;
    await new Promise((res) => {
      const step = () => {
        k++;
        panes.forEach((p, i) => p.setView({ cx: 2048 + 300 * Math.sin(k / 30 + i), cy: 2048 + 300 * Math.cos(k / 30 + i) }));
        if (performance.now() - t0 < 3000) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    });
    const secs = (performance.now() - t0) / 1000;
    return { fps: (app.renderer.frame - f0) / secs, frameMs: app.renderer.stats.frameMs, gpu: app.renderer.gpuBytes, budget: app.renderer.gpuBudget, pool: app.pool.stats(), heap: performance.memory?.usedJSHeapSize ?? null, gl: app.runMode.caps.gl?.renderer, software: app.softwareGl };
  });
  out.multiport2x2 = r;
  expect(r.fps).toBeGreaterThan(50); // 60 Hz display; allow for the headless compositor
  expect(r.frameMs).toBeLessThan(16.7);
  expect(r.gpu).toBeLessThanOrEqual(r.budget);
  expect(r.budget).toBeLessThanOrEqual(384 * 2 ** 20);
});

test('REQ-PRF-04 the cursor read-out (ground, MGRS, EGM96, CE90) answers within one frame', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  const box = await frame.locator('.multiport .pane').first().boundingBox();
  const ms = [];
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(box.x + 50 + i * 17, box.y + 60 + i * 11);
    await page.waitForTimeout(30);
    ms.push(await frame.evaluate(() => window.gisworkbench.readoutMs));
  }
  ms.sort((a, b) => a - b);
  out.readoutMs = { median: ms[10], max: ms.at(-1) };
  expect(ms[10]).toBeLessThan(16.7);
  expect(ms.at(-1)).toBeLessThan(16.7);
});
