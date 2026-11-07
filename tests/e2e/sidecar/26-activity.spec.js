// SCN-66 REQ-ING-04 OD-2.27 through a real sidecar: the copies to and from it and every 2.6 route in
// the activity indicator, with Cancel reaching the sidecar's job. Runs in the `sidecar` projects.
// A 1.6 Gpx pan-sharpen is the long job; the 11 GB Hamilton County MrSID is the
// view. Numbers go to reports/sidecar/activity.json; what the corpus lacks is skipped.
//
//   GW_DIST=dist-sizeux GWB_SIDECAR_EXE=<exe> GWB_SIDECAR_MODULES=<modules> npx playwright test sidecar/26-activity --project=sidecar
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { openApp, openFiles } from '../helpers.js';
import { cancelWhenShown, stopActivity, watchActivity } from '../activity-lib.js';
import { state, saveState, approvePending, startSidecar, stopSidecar, CORPUS, DIST_DIR, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const FX = resolve('fixtures', 'fx26', 'gdalroutes');
const fx = (n) => join(FX, n);
const SCALE = process.env.GWB_SCALE ?? 'D:/gwb26/data-gdalroutes/scale';
const HAMILTON = process.env.GWB_HAMILTON ?? 'C:/GIS Workbench/Research/Additional Data Samples/Hamilton_2018_rgb_20x-002/Hamilton_2018_rgb_20x.sid';
const REPORT = resolve('reports', 'sidecar', 'activity.json');
const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(results, null, 1));
  console.log(k, JSON.stringify(v));
};

async function pair(frame, s) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  await expect(frame.locator('[data-id="sidecar:code"]')).toHaveText(/^\d{6}$/, { timeout: 20_000 });
  await approvePending(s);
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 20_000 });
}

async function files(frame, paths) {
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles([].concat(paths));
  await frame.evaluate((i) => {
    window.__fx = [...i.files];
    i.remove();
  }, input);
}

test.describe.configure({ mode: 'serial' });
let page;
let frame;
let s;
let restarted = false;

test.beforeAll(async ({ browser }) => {
  s = state();
  page = await browser.newPage();
  ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
  await pair(frame, s);
  await frame.evaluate(() => window.gisworkbench.sidecar.ready());
});
test.afterAll(async () => {
  await frame?.evaluate(() => window.gisworkbench.commands.run('sidecar.forget')).catch(() => {});
  await page?.close();
  // The Hamilton test restarts the shared test sidecar with its own picker answer. Put back what
  // global.setup started, so a spec that runs after this one (26-csmhost reads GWB_SIDECAR_PICK)
  // is answered as it expects, and not with the Hamilton MrSID.
  if (restarted) {
    const cur = state();
    stopSidecar(cur.pid);
    const pick = (process.env.GWB_SIDECAR_PICK ?? '').split(';').filter(Boolean).flatMap((p) => ['--test-pick', p]);
    saveState(await startSidecar({ dataDir: cur.dataDir, port: cur.port, keep: true, token: cur.token, extra: pick }));
  }
});

/** Run a sidecar command in the page → {state, error}; the dialog's Run is pressed when `dialog` opens. */
async function command(id, args, { dialog = null, fill = null, press = 'Run' } = {}) {
  const done = frame.evaluate(
    async ({ id, args }) => {
      const list = window.__fx;
      const named = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'number' ? list[v] : Array.isArray(v) ? v.map((n) => list[n]) : v]));
      try {
        const r = await window.gisworkbench.commands.run(id, named);
        return { state: r?.state ?? (r ? 'done' : null), name: r?.outputs?.[0]?.name };
      } catch (e) {
        return { state: 'error', error: e.message, code: e.code };
      }
    },
    { id, args },
  );
  if (dialog) {
    const dlg = frame.locator(`[data-id="dialog:${dialog}"]`);
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await fill?.(dlg);
    await dlg.locator('button', { hasText: press }).click();
  }
  return done;
}

const sawRunning = (seen, re) => seen.firstRunningMs !== null && seen.labels.concat(seen.running ?? []).some((l) => re.test(l));

test('sidecar.pansharpen, 1.6 Gpx: the copy and the job are shown, the percent moves, Cancel stops the job', async () => {
  test.skip(LINUX || !existsSync(join(SCALE, 'pan-40000.tif')), 'no scale scene');
  test.setTimeout(900_000);
  await files(frame, [join(SCALE, 'pan-40000.tif'), join(SCALE, 'ms-40000.tif')]);
  await watchActivity(frame);
  const done = command('sidecar.pansharpen', { pan: 0, ms: [1] }, { dialog: 'sidecar-pansharpen', fill: (d) => d.locator('[data-opt="resampling"]').selectOption('nearest') });
  await expect(frame.locator('[data-id="activity"] .activity-label')).toHaveText(/^Sidecar: /, { timeout: 120_000 });
  await frame.waitForTimeout(30_000);
  await frame.locator('[data-id="activity:cancel"]').click();
  const r = await done;
  const seen = await stopActivity(frame);
  record('pansharpen', { ...r, ...seen });
  // The command reports the failure itself and ends with nothing; the sidecar's job is what must stop.
  expect(r.state).toBeNull();
  expect(await frame.evaluate(() => [...window.gisworkbench.sidecar.jobs.values()].map((j) => j.job.state))).toContain('cancelled');
  expect(seen.labels.some((l) => /^Sidecar: .*pan-40000\.tif/.test(l)), 'named by its file, not its id').toBe(true);
  expect(seen.hadCancel).toBe(true);
  expect(seen.hiddenLongTasks).toBe(0);
  await expect(frame.locator('[data-id="activity"]')).toBeHidden({ timeout: 5000 });
});

test('sidecar.reproject appears as a job, and finishes', async () => {
  await files(frame, [fx('osgb_xy.tif')]);
  for (const [name, profile, index, options] of [['reproject', 'raster-reproject', 0, { t_srs: 'EPSG:4326', resampling: 'bilinear', compress: 'NONE' }]]) {
    await watchActivity(frame);
    const r = await frame.evaluate(
      async ({ profile, index, options }) => {
        const app = window.gisworkbench;
        const up = await app.sidecar.send(window.__fx[index]);
        const seen = new Set();
        const tick = setInterval(() => app.activity.items().forEach((i) => seen.add(i.label)), 50);
        const j = await app.sidecar.convert({ files: [up.id], profile, options, open: false, reason: 'e2e' }).catch((e) => ({ state: e.message }));
        clearInterval(tick);
        return { state: j.state, items: [...seen] };
      },
      { profile, index, options },
    );
    const seen = await stopActivity(frame);
    record(name, { ...r, ...seen });
    expect(r.state).toBe('succeeded');
    expect(r.items.some((l) => /^Sidecar: /.test(l)), JSON.stringify(r.items)).toBe(true);
  }
});

test('sidecar.modelexport and sidecar.gdbcatalog appear as jobs', async () => {
  await files(frame, [fx('two_boxes.glb'), fx('DomainsSub.gdb.zip')]);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    window.__seen = new Set();
    window.__tick = setInterval(() => app.activity.items().forEach((i) => window.__seen.add(i.label)), 30);
    // A 1 KB copy can end between two polls, so each copy is also read where it begins.
    const begin = app.activity.begin;
    window.__begin = begin;
    app.activity.begin = function (label, opts) {
      window.__seen.add(label);
      return begin.call(this, label, opts);
    };
  });
  const model = frame.evaluate(() => window.gisworkbench.commands.run('sidecar.modelexport', { file: window.__fx[0] }).then((r) => r?.state, (e) => e.message));
  const first = frame.locator('[data-id="dialog:sidecar-modelformat"]');
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.locator('select').selectOption('model-ifc');
  await first.locator('button', { hasText: 'Next' }).click();
  const dlg = frame.locator('[data-id="dialog:sidecar-modelexport"]');
  await expect(dlg).toBeVisible();
  await dlg.locator('[data-opt="crs"]').fill('EPSG:32611');
  await dlg.locator('[data-opt="origin_x"]').fill('500000');
  await dlg.locator('[data-opt="origin_y"]').fill('4000000');
  await dlg.locator('button', { hasText: 'Run' }).click();
  const m = await model;
  const gdb = frame.evaluate(() => window.gisworkbench.commands.run('sidecar.gdbcatalog', { file: window.__fx[1] }).then((r) => r?.counts, (e) => e.message));
  const cat = frame.locator('[data-id="dialog:sidecar-gdbcatalog"]');
  await expect(cat).toBeVisible({ timeout: 60_000 });
  await cat.locator('button', { hasText: 'Cancel' }).click();
  await gdb;
  const seen = await frame.evaluate(() => {
    clearInterval(window.__tick);
    window.gisworkbench.activity.begin = window.__begin;
    return [...window.__seen];
  });
  record('modelexport+gdbcatalog', { model: m, seen });
  expect(m).toBe('succeeded');
  expect(seen.filter((l) => /^Sidecar: /.test(l)).length, JSON.stringify(seen)).toBeGreaterThanOrEqual(2);
  expect(seen.filter((l) => /^Sending /.test(l)).length, JSON.stringify(seen)).toBeGreaterThanOrEqual(2);
});

test('sidecar.view of the 11 GB Hamilton County MrSID: the real path through the indicator', async ({ browser }) => {
  test.skip(LINUX || !existsSync(HAMILTON), 'tier U field data, not here');
  test.setTimeout(600_000);
  // A sidecar that answers its file picker with this file; afterAll puts the run's own back.
  await frame.evaluate(() => window.gisworkbench.commands.run('sidecar.forget')).catch(() => {});
  await page.close();
  const s0 = state();
  stopSidecar(s0.pid);
  restarted = true;
  s = await startSidecar({ dataDir: s0.dataDir, port: 47821, keep: true, token: s0.token, extra: ['--test-pick', HAMILTON] });
  saveState(s);
  page = await browser.newPage();
  ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
  await pair(frame, s);
  await frame.evaluate(() => window.gisworkbench.sidecar.ready());
  await watchActivity(frame);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const t0 = performance.now();
    const v = await app.commands.run('sidecar.view', { reason: 'MrSID' });
    return { ms: Math.round(performance.now() - t0), width: v.view.width, height: v.view.height, layers: v.layers.length };
  });
  const seen = await stopActivity(frame);
  record('view-hamilton', { ...r, ...seen });
  expect(r.width).toBe(340000);
  expect(seen.labels).toContain('Opening a view through the sidecar…');

  // Cancel while it opens: nothing opens, and nothing is left running.
  const stopped = frame.evaluate(() => window.gisworkbench.commands.run('sidecar.view', { reason: 'MrSID' }).then((v) => (v ? 'opened' : 'stopped'), (e) => e.message));
  await cancelWhenShown(frame, '^Opening a view');
  expect(await stopped).toBe('stopped');
});
