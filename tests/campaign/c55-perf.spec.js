// TE-C55 performance budgets on the corpus (2.0.4 campaign). For each census format key, the largest
// and the median file of the stratified set are opened and measured: open time, first tile on the GPU
// (REQ-PRF-03 ≤ 1 s for imagery), statistics, roaming frame rate and frame time (REQ-PRF-02), the
// cursor read-out (REQ-PRF-04 < 16.7 ms), GPU memory against the budget (REQ-PRF-08), JS heap, and a
// leak check (the file opened and closed ten times; heap growth after GC ≤ 64 MB). Point clouds over
// 5 M points report the 3D frame rate (REQ-PRF-05 ≥ 30 fps). Records go to results/<run>/c55-*.json;
// build/campaign/perf-report.mjs turns them into reports/campaign/perf-baseline.json.
//
//   TE_DIST=dist-cx5/gis-workbench.html TE_RUN=cx-perf [TE_ONLY=<regex>]
//   npx playwright test -c playwright.campaign.config.js c55-perf --project=chrome --workers=1
import { test, expect } from '@playwright/test';
import { existsSync, statSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ASCII_CRS, openFiles } from './helpers.js';
import { cases, CENSUS, EXPECT, refusedKeys, ROBUST } from './cases.js';
import { session, recordWriter, outDir } from './cross-lib.js';

const RUN = process.env.TE_RUN ?? 'cx-perf';
const OUT = outDir(RUN);
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;
const BUDGET = { firstTileMs: 1000, readoutMs: 16.7, fps: 50, frameMs: 16.7, leakMB: 64, cloudFps: 30 };

// Largest and median file per census key (refused formats and robustness seeds have no budget).
const byKey = new Map();
for (const c of cases) {
  const k = `${c.it.id}/${c.f.name}`;
  if (ONLY && !ONLY.test(k)) continue;
  if (EXPECT[c.f.name.split('/').pop()]?.refuse || refusedKeys(c.it, c.f).length || ROBUST(c.it) || !c.files.every(existsSync)) continue;
  c.bytes = c.files.reduce((t, p) => t + statSync(p).size, 0);
  for (const key of CENSUS.get(k) ?? []) (byKey.get(key) ?? byKey.set(key, []).get(key)).push(c);
}
const chosen = new Set();
for (const list of byKey.values()) {
  list.sort((a, b) => a.bytes - b.bytes);
  chosen.add(list.at(-1));
  chosen.add(list[Math.floor((list.length - 1) / 2)]);
}

// One worker keeps the machine otherwise idle; a budget miss does not stop the files after it.
test.describe.configure({ mode: 'default' });

// The corpus disk (USB) spins down when idle: the first read after a pause took ~5 s, which was
// measured as a 5.3 s first tile on a 528-byte TIFF (CX-H22). The head and tail of every file are
// read once before timing starts, so the budgets measure the app, not the disk waking.
function wake(paths) {
  const buf = Buffer.alloc(1 << 20);
  for (const p of paths) {
    const fd = openSync(p, 'r');
    try {
      const size = statSync(p).size;
      readSync(fd, buf, 0, Math.min(buf.length, size), 0);
      if (size > buf.length) readSync(fd, buf, 0, buf.length, size - buf.length);
    } finally {
      closeSync(fd);
    }
  }
}
for (const c of [...chosen].sort((a, b) => a.bytes - b.bytes)) {
  const name = c.f.name.split('/').pop();
  const key = `${c.it.id}/${c.f.name}`;
  test(`TE-C55 REQ-PRF-02 REQ-PRF-03 REQ-PRF-04 REQ-PRF-08 ${key}`, async ({ page }, info) => {
    test.setTimeout(c.bytes > 200e6 ? 3600_000 : 900_000);
    mkdirSync(OUT, { recursive: true });
    const rec = { spec: 'c55-perf', project: info.project.name, key, item: c.it.id, file: name, bytes: c.bytes, keys: CENSUS.get(key) ?? [], budget: BUDGET };
    const save = recordWriter(join(OUT, `c55-${info.project.name}-${key.replace(/[^\w.-]+/g, '_')}.json`), rec);
    wake(c.files);
    const s = await session(page, { files: c.files, epsg: ASCII_CRS[name] ?? null, big: c.bytes > 200e6, setupSteps: [] });
    // First tile: poll the GPU tile count from the moment the files are handed over.
    await s.frame.evaluate(() => {
      window.__teFirst = null;
      const t0 = performance.now();
      window.__teT0 = t0;
      const tick = () => {
        const ls = [...window.gisworkbench.layers.values()];
        if (ls.some((l) => l.lutTex && l.tiles?.gpu?.size > 0)) window.__teFirst = performance.now() - t0;
        else if (performance.now() - t0 < 900_000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const o = await s.open();
    rec.openMs = o.ms;
    rec.open = { ok: o.ok, errors: o.errors, layers: o.layers.length };
    // An 8-bit layer is displayable before its statistics (CX-086), so "opened" can come before the
    // first tile: wait for the tile itself (bounded), or the measurement read null and passed.
    const imagery = o.layers.some((l) => !l.error && l.kind !== 'dem');
    if (imagery) await s.frame.waitForFunction(() => window.__teFirst !== null, null, { timeout: 120_000, polling: 50 }).catch(() => {});
    const m = await s.frame.evaluate(async () => {
      const a = window.gisworkbench;
      const out = { firstTileMs: window.__teFirst === null ? null : Math.round(window.__teFirst) };
      const l = [...a.layers.values()].find((x) => !x.error && x.handle);
      if (l) {
        const t = performance.now();
        await l.ensureStats?.();
        out.statsMs = Math.round(performance.now() - t);
        // Roaming: 3 s of view changes on every animation frame.
        const p = a.activePane();
        p.fitWhole?.();
        await new Promise((r) => setTimeout(r, 800));
        const v0 = { ...p.view };
        const f0 = a.renderer.frame;
        const t0 = performance.now();
        let k = 0;
        await new Promise((res) => {
          const step = () => {
            k++;
            p.setView({ cx: v0.cx + (l.width / 8) * Math.sin(k / 25), cy: v0.cy + (l.height / 8) * Math.cos(k / 25), zoom: v0.zoom * (1.5 + Math.sin(k / 40)) });
            if (performance.now() - t0 < 3000) requestAnimationFrame(step);
            else res();
          };
          requestAnimationFrame(step);
        });
        out.fps = Math.round((10 * (a.renderer.frame - f0)) / ((performance.now() - t0) / 1000)) / 10;
        out.frameMs = Math.round(a.renderer.stats.frameMs * 10) / 10;
        out.gpuMB = Math.round(a.renderer.gpuBytes / 1048576);
        out.gpuBudgetMB = Math.round(a.renderer.gpuBudget / 1048576);
      }
      const c = a.pc?.cloudOf?.();
      if (c) {
        out.points = c.n;
        const v = a.pc.view?.();
        if (v) {
          const f0 = v.frames ?? null;
          const t0 = performance.now();
          let k = 0;
          await new Promise((res) => {
            const step = () => {
              k++;
              // Orbit the camera about its target (as the view's own turntable does).
              const tg = v.controls?.target;
              const cam = v.camera?.position;
              if (tg && cam) {
                const dx = cam.x - tg.x;
                const dy = cam.y - tg.y;
                const an = 0.01;
                cam.set(tg.x + dx * Math.cos(an) - dy * Math.sin(an), tg.y + dx * Math.sin(an) + dy * Math.cos(an), cam.z);
              }
              v.invalidate?.();
              if (performance.now() - t0 < 3000) requestAnimationFrame(step);
              else res();
            };
            requestAnimationFrame(step);
          });
          out.cloudFrameMs = v.lastFrameMs ?? null;
          out.cloudFps = f0 !== null && v.frames !== undefined ? Math.round((10 * (v.frames - f0)) / ((performance.now() - t0) / 1000)) / 10 : k / 3;
        }
      }
      return out;
    });
    Object.assign(rec, m);
    // Read-out: mouse moves over the panel.
    const box = await s.frame.locator('.multiport .pane').first().boundingBox().catch(() => null);
    if (box && m.fps !== undefined) {
      const ms = [];
      for (let i = 0; i < 20; i++) {
        await page.mouse.move(box.x + 60 + i * 17, box.y + 70 + i * 11);
        await page.waitForTimeout(30);
        ms.push(await s.frame.evaluate(() => window.gisworkbench.readoutMs ?? null));
      }
      const v = ms.filter((x) => x !== null).sort((a, b) => a - b);
      if (v.length) rec.readoutMs = { median: v[Math.floor(v.length / 2)], max: v.at(-1) };
    }
    // Leak check: open and close ten times; heap after GC compared with the first open.
    const gcHeap = async () => {
      await s.cdp.send('HeapProfiler.collectGarbage').catch(() => {});
      const mm = await s.cdp.send('Performance.getMetrics');
      return Math.round(mm.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1048576);
    };
    if (c.bytes < 400e6) {
      const h0 = await gcHeap();
      for (let i = 0; i < 10; i++) {
        await s.frame.evaluate(() => {
          const a = window.gisworkbench;
          a.dirty = false;
          for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
          a.desktop.addMultiport(a.newProject());
          a.importLog.length = 0;
        });
        await openFiles(s.frame, c.files).catch(() => {});
        await page.waitForTimeout(300);
      }
      const h1 = await gcHeap();
      rec.heapMB = { first: h0, after10: h1, growth: h1 - h0 };
    }
    rec.logs = s.logs.slice(0, 10);
    // Verdicts against the budgets (imagery only for the tile budget).
    const over = [];
    if (m.firstTileMs !== undefined && m.firstTileMs !== null && m.firstTileMs > BUDGET.firstTileMs) over.push(`first tile ${m.firstTileMs} ms`);
    if (imagery && m.firstTileMs === null) over.push('no first tile within 120 s');
    if (m.fps !== undefined && m.fps < BUDGET.fps) over.push(`roaming ${m.fps} fps`);
    if (m.frameMs !== undefined && m.frameMs > BUDGET.frameMs) over.push(`frame ${m.frameMs} ms`);
    if (rec.readoutMs && rec.readoutMs.median > BUDGET.readoutMs) over.push(`read-out ${rec.readoutMs.median} ms`);
    if (m.gpuMB !== undefined && m.gpuMB > m.gpuBudgetMB) over.push(`GPU ${m.gpuMB} MB over ${m.gpuBudgetMB} MB`);
    if (rec.heapMB && rec.heapMB.growth > BUDGET.leakMB) over.push(`heap +${rec.heapMB.growth} MB after 10 opens`);
    if (m.points >= 5e6 && m.cloudFps < BUDGET.cloudFps) over.push(`point cloud ${m.cloudFps} fps`);
    rec.over = over;
    save();
    expect.soft(over, `${key}: within the performance budgets`).toEqual([]);
  });
}
