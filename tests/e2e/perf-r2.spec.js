// R2 performance on this machine: AT-05.3 the anaglyph pans a 2k viewport at ≥ 30 fps (FX-02);
// REQ-PRF-06 a 4k × 4k DSM in ≤ 60 s in the workers and ≤ 10 s with WebGPU (the 4096² FX-02 pair from
// `FX02_SIZE=4096 node build/fixtures/fx02.mjs fixtures-perf`). PRF-05 is in scn14.spec.js and
// PRF-07 in scn18.spec.js. Results go to reports/perf-r2-<browser>.json.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const out = {};
test.afterAll(({}, info) => {
  mkdirSync('reports', { recursive: true });
  writeFileSync(`reports/perf-r2-${info.project.name}.json`, JSON.stringify({ measured: new Date().toISOString(), ...out }, null, 1));
});

test.describe('2k viewport', () => {
  test.use({ viewport: { width: 2560, height: 1440 } });
  test('AT-05.3 REQ-STR-04 FX-02 the anaglyph pans a 2k viewport at 30 fps or more', async ({ page }) => {
    test.setTimeout(180000);
    const truth = JSON.parse(readFileSync(resolve('fixtures/fx02/fx02_truth.json'), 'utf8'));
    const { frame, logs } = await openApp(page, 'file');
    await openFiles(frame, truth.images.map((i) => resolve('fixtures/fx02', i.file)));
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 60000 });
    const r = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const ls = [...app.layers.values()].sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
      app.stereo.open(ls[0], ls[1]);
      app.commands.run('stereo.mode.dubois');
      const p = app.activePane();
      const { w, h } = p.size();
      await new Promise((res) => setTimeout(res, 1500));
      const c0 = { ...p.view };
      const f0 = app.renderer.frame;
      const t0 = performance.now();
      let k = 0;
      await new Promise((res) => {
        const step = () => {
          k++;
          p.setView({ cx: c0.cx + 200 * Math.sin(k / 25), cy: c0.cy + 200 * Math.cos(k / 25) });
          if (performance.now() - t0 < 3000) requestAnimationFrame(step);
          else res();
        };
        requestAnimationFrame(step);
      });
      const secs = (performance.now() - t0) / 1000;
      return { fps: (app.renderer.frame - f0) / secs, viewport: [innerWidth, innerHeight], paneCss: [w, h], dpr: window.devicePixelRatio, frameMs: app.renderer.stats.frameMs, mode: p.stereo.displayOpts?.().mode };
    });
    out.anaglyph2k = r;
    console.log(JSON.stringify(r));
    // The 2k viewport is the window; the stereo pane is what remains beside the panels.
    expect(r.viewport[0] * r.dpr).toBeGreaterThanOrEqual(1920);
    expect(r.paneCss[0] * r.paneCss[1]).toBeGreaterThan(1920 * 1080);
    expect(r.fps).toBeGreaterThanOrEqual(30);
    expect(logs).toEqual([]);
  });
});

test('REQ-PRF-06 a 4k × 4k DSM in 60 s or less in the workers and 10 s or less with WebGPU', async ({ page }) => {
  const dir = resolve('fixtures-perf/fx02');
  test.skip(!existsSync(resolve(dir, 'fx02_truth.json')), 'the 4096² pair is not generated (FX02_SIZE=4096 node build/fixtures/fx02.mjs fixtures-perf)');
  test.setTimeout(600000);
  const truth = JSON.parse(readFileSync(resolve(dir, 'fx02_truth.json'), 'utf8'));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, truth.images.map((i) => resolve(dir, i.file)));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 2, null, { timeout: 120000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
    const t0 = performance.now();
    const d = await app.extractDsm(ls[0], ls[1], { hMin: 680, hMax: 760, engine: 'worker' });
    const ms = performance.now() - t0;
    const out = { ms, size: [ls[0].width, ls[0].height], grid: [d.grid.nx, d.grid.ny], tiles: d.stats.tiles, matched: d.stats.matchedFraction, workers: app.pool.workers.get('analysis')?.length ?? 0, webgpu: !!navigator.gpu, matcher: d.stats.matcher };
    if (navigator.gpu && (await navigator.gpu.requestAdapter())) {
      const t1 = performance.now();
      const g = await app.extractDsm(ls[0], ls[1], { hMin: 680, hMax: 760, engine: 'gpu' });
      out.gpu = { ms: performance.now() - t1, matched: g.stats.matchedFraction, matcher: g.stats.matcher };
      // Heights against the worker's on the posts both matched.
      const diffs = [];
      for (let k = 0; k < d.heights.length; k += 7) if (Number.isFinite(d.heights[k]) && Number.isFinite(g.heights[k])) diffs.push(Math.abs(d.heights[k] - g.heights[k]));
      diffs.sort((a, b) => a - b);
      out.gpu.medianDiff = diffs[Math.floor(diffs.length / 2)];
      out.gpu.p95Diff = diffs[Math.floor(diffs.length * 0.95)];
    }
    return out;
  });
  out.dsm4k = r;
  console.log(JSON.stringify(r));
  expect(r.size).toEqual([4096, 4096]);
  expect(r.ms).toBeLessThanOrEqual(60000);
  expect(r.matcher).toBe('worker');
  if (r.gpu) {
    expect(r.gpu.matcher).toBe('webgpu');
    expect(r.gpu.ms).toBeLessThanOrEqual(10000);
    expect(Math.abs(r.gpu.matched - r.matched)).toBeLessThan(0.02);
    expect(r.gpu.medianDiff).toBeLessThan(0.05);
  }
  expect(logs).toEqual([]);
});
