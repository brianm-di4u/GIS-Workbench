// REQ-GAP-66 (SDP-2.3 §2 GR-24) GeoPDF first-tile time: the US Topo and derived ISO 32000 GeoPDFs
// of the T&E corpus, opened from a local copy, timed from hand-over to the first GPU tile (as
// tests/campaign/c55-perf.spec.js measures it), and roaming fps with the vector layers loaded.
// Runs only with GW_GEOPDF_PERF=1 and the corpus present (GW_GEOPDF_PERF_RUNS, _TAG, _DIR). Results
// go to reports/geopdf-perf-<project>[-tag].json for docs/validation/2.4/geopdf.md.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { openApp } from './helpers.js';

test.describe.configure({ mode: 'serial', timeout: 300000 });

const CORPUS = resolve('..', 'TE-corpus');
const FILES = [
  'derived-geopdf-iso32000/naip_geo_iso32000.pdf',
  'geopdf-ustopo-vinehill-2012/CA_Vine_Hill_20120213_TM_geo.pdf',
  'geopdf-htmc-honker-bay-bouldin-island/CA_Honker_Bay_100766_1953_24000_geo.pdf',
  'geopdf-ustopo-bouldin-island-current/CA_Bouldin_Island_20211230_TM_geo.pdf',
  'geopdf-ustopo-vinehill-honkerbay-current/CA_Honker_Bay_20220107_TM_geo.pdf',
].map((f) => join(CORPUS, f));
// The corpus sits on a USB disk: read from a local copy so the timing is the app's, not the disk's.
const LOCAL = process.env.GW_GEOPDF_PERF_DIR ?? 'D:/gwb24/geopdf/perf';
const RUNS = Number(process.env.GW_GEOPDF_PERF_RUNS ?? 3);
const results = [];

for (const src of FILES) {
  test(`REQ-GAP-66 GeoPDF first tile: ${basename(src)}`, async ({ page }, info) => {
    test.skip(!process.env.GW_GEOPDF_PERF, 'a measurement: GW_GEOPDF_PERF=1, one worker (npx playwright test tests/e2e/24-geopdf-perf.spec.js --workers=1)');
    test.skip(!existsSync(src), 'T&E corpus not present');
    mkdirSync(LOCAL, { recursive: true });
    const local = join(LOCAL, basename(src));
    if (!existsSync(local) || statSync(local).size !== statSync(src).size) copyFileSync(src, local);
    const times = [];
    for (let r = 0; r < RUNS; r++) {
      // A fresh page per run: nothing cached from the previous open.
      const pg = r ? await page.context().newPage() : page;
      const { frame } = await openApp(pg, 'file', { prefs: { welcomeDone: true } });
      const input = await frame.evaluateHandle(() => {
        const i = document.createElement('input');
        i.type = 'file';
        i.style.display = 'none';
        document.body.appendChild(i);
        return i;
      });
      await input.asElement().setInputFiles([local]);
      if (process.env.GW_GEOPDF_NOVEC) await frame.evaluate(() => (window.gisworkbench.geopdf.openVectors = async () => []));
      const got = await frame.evaluate(async (i) => {
        const app = window.gisworkbench;
        const f = i.files[0];
        i.remove();
        let first = null;
        const t0 = performance.now();
        const tick = () => {
          if ([...app.layers.values()].some((l) => l.lutTex && l.tiles?.gpu?.size > 0)) first = performance.now() - t0;
          else if (performance.now() - t0 < 120000) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        await app.openFiles([f]);
        const opened = performance.now() - t0;
        while (first === null && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 20));
        return { first: first === null ? null : Math.round(first), opened: Math.round(opened), log: app.importLog.at(-1), timing: [...app.layers.values()].at(-1)?.info?.meta?.timing ?? null };
      }, input);
      expect(got.first, JSON.stringify(got.log)).not.toBeNull();
      // Roaming with the GeoPDF's vector layers loaded (as c55-perf measures it), on the last run.
      if (r === RUNS - 1)
        got.roam = await frame.evaluate(async () => {
          const a = window.gisworkbench;
          const ids = (await a.geoPdfVectors) ?? [];
          const feats = a.store.all('feature').length;
          const p = a.activePane();
          const l = [...a.layers.values()].at(-1);
          p.fitWhole?.();
          await new Promise((res) => setTimeout(res, 800));
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
          return { vectorLayers: ids.length, features: feats, fps: Math.round((10 * (a.renderer.frame - f0)) / ((performance.now() - t0) / 1000)) / 10, frameMs: Math.round(a.renderer.stats.frameMs * 10) / 10 };
        });
      times.push(got);
      if (r) await pg.close();
    }
    const firsts = times.map((x) => x.first).sort((a, b) => a - b);
    results.push({ file: basename(src), mb: +(statSync(src).size / 1e6).toFixed(1), project: info.project.name, firstTileMs: firsts, median: firsts[Math.floor(firsts.length / 2)], openedMs: times.map((x) => x.opened), stagesMs: times.map((x) => x.timing), roam: times.at(-1).roam });
    mkdirSync('reports', { recursive: true });
    writeFileSync(join('reports', `geopdf-perf-${info.project.name}${process.env.GW_GEOPDF_PERF_TAG ? `-${process.env.GW_GEOPDF_PERF_TAG}` : ''}.json`), JSON.stringify(results, null, 1));
  });
}
