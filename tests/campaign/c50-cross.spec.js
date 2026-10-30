// TE-C50 format × function cross (2.0.4 campaign): every primary file of the corpus is opened, and every
// command the app itself enables for it (its enable predicates are the ground truth for "applicable")
// is run on it in turn, with the app reset to the opened state between commands. Each cell must leave
// no console/page error, no error toast, no failed worker job, no unrequested network request, and
// must show an effect (state change, dialog, download or message); downloads must be non-empty files
// of the type they claim. Per-cell time, worker jobs and JS heap are recorded for the performance pass.
//
//   TE_DIST=dist-cx/gis-workbench.html TE_RUN=cx1 [TE_STRAT=1] [TE_SHARD=1/4] [TE_ONLY=<regex>] [TE_FRESH=1]
//   npx playwright test -c playwright.campaign.config.js c50-cross --project=chrome
//
// One record per file (results/<TE_RUN>/c50-<project>-<item>_<file>.json), rewritten after every
// command, so an interrupted run resumes where it stopped (cells already recorded are skipped).
import { test, expect } from '@playwright/test';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASCII_CRS } from './helpers.js';
import { cases, EXPECT, CENSUS, refusedKeys, ROBUST, stratify } from './cases.js';
import { session, crossCommands, excluded, heap, BAD, recordWriter, outDir, dlDirFor } from './cross-lib.js';

const STRAT = !!process.env.TE_STRAT;
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;
const [SHARD_I, SHARD_N] = (process.env.TE_SHARD ?? '1/1').split('/').map(Number);
const RUN = process.env.TE_RUN ?? 'cx';
const OUT = outDir(RUN);

const usable = cases.filter((c) => !ONLY || ONLY.test(`${c.it.id}/${c.f.name}`));
const chosen = (STRAT ? stratify(usable) : usable).filter((_, i) => i % SHARD_N === SHARD_I - 1);

test.describe.configure({ mode: 'parallel' });
for (const { it, f, files } of chosen) {
  const name = f.name.split('/').pop();
  const key = `${it.id}/${f.name}`;
  test(`TE-C50 ${key} [${it.format}]`, async ({ page }, info) => {
    test.skip(!files.every((p) => p && existsSync(p)), 'not on disk');
    const rp = join(OUT, `c50-${info.project.name}-${key.replace(/[^\w.-]+/g, '_')}.json`);
    const prev = !process.env.TE_FRESH && existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null;
    test.skip(prev?.done === true, 'already recorded (TE_FRESH=1 reruns)');
    const bytes = files.reduce((t, p) => t + statSync(p).size, 0);
    const big = bytes > 200e6;
    test.setTimeout(big ? 4 * 3600_000 : 2 * 3600_000);
    mkdirSync(OUT, { recursive: true });
    const rec = prev ?? { spec: 'c50-cross', project: info.project.name, key, item: it.id, file: name, format: it.format, area: it.area, keys: CENSUS.get(key) ?? [], bytes, cells: {} };
    rec.when = new Date().toISOString();
    rec.build = process.env.TE_DIST ?? 'dist';
    rec.done = false;
    const save = recordWriter(rp, rec);

    const s = await session(page, { files, epsg: ASCII_CRS[name] ?? null, big });
    const o = await s.open();
    rec.open = { ms: o.ms, settled: o.ok, errors: o.errors, warnings: o.warnings, layers: o.layers, setup: o.steps, heapMB: await heap(s.cdp) };
    const usableLayers = o.layers.filter((l) => !l.error).length;
    const others = await s.frame.evaluate(() => {
      const a = window.gisworkbench;
      return a.store.all('pointcloud').length + a.store.all('vlayer').length + (a.fmv?.clips?.size ?? 0) + a.store.all('graphic').length;
    });
    // Refused or unopenable files have nothing to cross: c01 judges the refusal itself.
    if (EXPECT[name]?.refuse || refusedKeys(it, f).length || ROBUST(it) || (!usableLayers && !others)) {
      Object.assign(rec, { applicable: [], done: true });
      rec.open.refused = true;
      save();
      return;
    }
    const en = await s.enabled();
    rec.applicable = en.filter((c) => !excluded(c));
    rec.excluded = en.filter((c) => excluded(c));
    save();
    // Full-resolution work scales with decoded samples, not compressed bytes: a deflated 116 M-pixel
    // complex SLC under 200 MB gets the large-file wait too.
    const samples = o.layers.reduce((t, l) => t + (l.error ? 0 : (l.w ?? 0) * (l.h ?? 0) * (l.bands ?? 1)), 0);
    await crossCommands(page, s, rec.applicable, rec, save, { wait0: big || samples > 100e6 ? 300_000 : 60_000, pick: [], dlDir: dlDirFor(RUN, info.project.name, info.workerIndex), fresh: !!process.env.TE_FRESH && !prev });
    rec.csp = await s.csp().catch(() => []);
    rec.done = !s.crashed;
    rec.crashed = s.crashed;
    save();
    const failed = Object.entries(rec.cells).filter(([, c]) => BAD.has(c.verdict));
    expect(rec.csp, 'no CSP violations (SEC-01)').toEqual([]);
    expect(failed.map(([id, c]) => `${id}: ${c.verdict} ${c.why ?? ''}`), `${key}: every applicable command runs cleanly`).toEqual([]);
  });
}
