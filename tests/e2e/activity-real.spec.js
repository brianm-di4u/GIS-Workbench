// SCN-66 REQ-ING-04 OD-2.27 with real work: obstruction surfaces against real terrain and a real point
// cloud, each through the activity indicator, then cancelled
// Numbers go to reports/activity/real.json. Needs the corpus; skips what is absent.
//
//   GW_DIST=dist-sizeux TE_CORPUS=D:/TE-corpus npx playwright test activity-real.spec.js --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openApp, openFiles, packPath } from './helpers.js';
import { cancelWhenShown, stopActivity, watchActivity } from './activity-lib.js';

const CORPUS = process.env.TE_CORPUS ?? 'D:/TE-corpus';
const FX = resolve('fixtures/fx25/aviation');
const NASR = { base: readFileSync(join(FX, 'APT_BASE.csv'), 'latin1'), rwy: readFileSync(join(FX, 'APT_RWY.csv'), 'latin1'), end: readFileSync(join(FX, 'APT_RWY_END.csv'), 'latin1') };
const DFC = join(CORPUS, 'ieee-dfc2018-houston');
const DSM = join(DFC, 'DSM_C12', 'UH17c_GEF051.tif');
const REPORT = resolve('reports', 'activity', 'real.json');
const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(results, null, 1));
  console.log(k, JSON.stringify(v));
};

test.describe.configure({ mode: 'serial' });

test('Obstruction Surfaces against a real DSM: one task with percent and stages, then Cancel', async ({ page }) => {
  test.skip(!existsSync(DSM), 'corpus absent');
  test.setTimeout(600_000);
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [DSM]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 180_000 });
  const id = await frame.evaluate(async (T) => {
    const app = window.gisworkbench;
    await app.useAsTerrain([...app.layers.values()][0], 'hae');
    return (await app.aviation.importNasr(T, ['HOU']))[0];
  }, NASR);
  await expect(frame.locator('[data-id="activity"]')).toBeHidden({ timeout: 20_000 });
  await watchActivity(frame);
  const stats = await frame.evaluate(async (id) => (await window.gisworkbench.aviation.evaluate({ airport: id, regime: 'part77', minPen: 0, keep: false })).stats, id);
  const seen = await stopActivity(frame);
  record('obstruction-dsm', { posts: stats.evaluated, ...seen });
  expect(stats.evaluated).toBeGreaterThan(1e6);
  expect(seen.firstShownMs, 'shown at once').toBeLessThan(600);
  expect(seen.labels).toContain('Evaluating the obstruction surfaces…');
  expect(seen.more, 'its strips are one task').toEqual([]);
  expect(seen.monotonic).toBe(true);
  expect(seen.hiddenLongTasks).toBe(0);

  const cancelled = frame.evaluate(async (id) => window.gisworkbench.aviation.evaluate({ airport: id, regime: 'icao', minPen: 0, keep: false }).then(() => 'finished', (e) => (e.cancelled ? 'cancelled' : String(e))), id);
  await cancelWhenShown(frame, 'Evaluating', { atPct: 20 });
  expect(await cancelled).toBe('cancelled');
  await expect.poll(() => frame.evaluate(() => [...window.gisworkbench.pool.jobs.values()].filter((j) => j.op.startsWith('obs.')).length)).toBe(0);
  await expect(frame.locator('[data-id="activity"]')).toBeHidden();
});

/** A copy of a LAS file that states its CRS, as 25-aviation does. */
function tagLas(src, dst, epsg) {
  const b = readFileSync(src);
  const hdr = b.readUInt16LE(94);
  const keys = [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 0, 1, epsg];
  const vlr = Buffer.alloc(54 + 2 * keys.length);
  vlr.write('LASF_Projection', 2, 'latin1');
  vlr.writeUInt16LE(34735, 18);
  vlr.writeUInt16LE(2 * keys.length, 20);
  keys.forEach((k, i) => vlr.writeUInt16LE(k, 54 + 2 * i));
  const head = Buffer.from(b.subarray(0, hdr));
  head.writeUInt32LE(hdr + vlr.length, 96);
  head.writeUInt32LE(1, 100);
  writeFileSync(dst, Buffer.concat([head, vlr, b.subarray(b.readUInt32LE(96))]));
}

test('Obstruction Surfaces against a real point cloud: the main-thread reading gives way to the indicator', async ({ page }, info) => {
  const src = join(DFC, 'C1', '272652_3289689.las');
  test.skip(!existsSync(src), 'corpus absent');
  test.setTimeout(600_000);
  const { frame } = await openApp(page, 'file');
  const las = info.outputPath('activity-epsg26915.las');
  tagLas(src, las, 26915);
  await openFiles(frame, [las]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size > 0, null, { timeout: 300_000 });
  rmSync(las, { force: true });
  const id = await frame.evaluate(async (T) => (await window.gisworkbench.aviation.importNasr(T, ['HOU']))[0], NASR);
  await watchActivity(frame);
  const stats = await frame.evaluate(async (id) => {
    const app = window.gisworkbench;
    return (await app.aviation.evaluate({ airport: id, regime: 'part77', source: 'points', cloud: [...app.pointClouds.values()][0], draw: false, keep: false })).stats;
  }, id);
  const seen = await stopActivity(frame);
  record('obstruction-cloud', { points: stats.evaluated, ...seen });
  expect(seen.labels).toContain('Reading the heights…');
  expect(seen.hiddenLongTasks).toBe(0);
});

test('A real 156 MB data pack is read and checked in a worker; the page keeps drawing', async ({ page }) => {
  const pack = process.env.GW_REAL_PACK ?? packPath('ai-detect');
  test.skip(!existsSync(pack), 'no real pack here');
  test.setTimeout(300_000);
  const { frame } = await openApp(page, 'file');
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(pack);
  await watchActivity(frame);
  const out = await frame.evaluate(async (i) => {
    const t0 = performance.now();
    const r = await window.gisworkbench.packs.open(i.files[0]);
    return { name: r?.name ?? r?.json?.name, ms: Math.round(performance.now() - t0) };
  }, input);
  const seen = await stopActivity(frame);
  record('pack-156MB', { ...out, ...seen });
  // The pack is read, unpacked and checked in steps of under 300 ms each, the indicator's wait, so a
  // run of 0.3 to 0.7 s may show nothing. REQ-ING-04 asks for it from 2 s, and never a freeze.
  if (out.ms > 2000) expect(seen.labels.some((l) => /^(Reading|Checking) /.test(l))).toBe(true);
  expect(seen.firstRunningMs).not.toBeNull();
  expect(seen.longestTaskMs, 'no long freeze').toBeLessThan(2000);
});
