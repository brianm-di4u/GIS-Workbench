// SCN-63 (REQ-GAP-29): an analyst runs a UAV block through structure from motion in the sidecar and
// opens its oriented frames, dense cloud, DSM and orthomosaic.
//
// The small block is ten frames of the CC0 Aukerman set, downsized (fixtures/fx26/sfm); it runs the
// real route, COLMAP and gwb-sfm, in minutes. The full block runs when GW_SFM_DATA points at the 77
// photographs, and its numbers are held as floors; docs/validation/2.6/sfm.md has the measurements,
// and tests/tools/sfm26_compare.py the differential test against COLMAP's own CUDA dense stage.
//
// Runs in the `sidecar` projects, on a sidecar of its own: only that one has `--test-pick`, and the
// page is pointed at it by port. Skips when the module is not in the bundle (GWB_SIDECAR_MODULES).

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, dirname } from 'node:path';
import { openApp } from '../helpers.js';
import { startSidecar, stopSidecar, approvePending, DATA_ROOT, DIST_DIR, MODULES, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const FX = resolve('fixtures', 'fx26', 'sfm');
const AUKERMAN = process.env.GW_SFM_DATA ?? (LINUX ? `${process.env.HOME}/gwb/data-sfm/aukerman/images` : 'E:/gwb26/data-sfm/aukerman/images');
const WORK = resolve(DATA_ROOT, 'sfm26-work');
const REPORT = resolve('reports', 'sidecar', 'scn63.json');
const PORT = 47822;
const HAS_MODULE = existsSync(join(MODULES, 'sfm', 'bin', LINUX ? 'colmap' : 'colmap.exe'));
const SMALL = { feature_size: 800, feature_threads: 4, image_size: 800, depth_size: 400, views: 4 };

const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, results }, null, 2));
};

const gdalinfo = (path) => {
  const dir = join(MODULES, 'core-gdal');
  const exe = join(dir, 'bin', LINUX ? 'gdalinfo' : 'gdalinfo.exe');
  const env = { ...process.env, GDAL_DATA: join(dir, 'share', 'gdal'), PROJ_DATA: join(dir, 'share', 'proj'), PATH: `${join(dir, 'bin')}${LINUX ? ':' : ';'}${process.env.PATH}`, ...(LINUX ? { LD_LIBRARY_PATH: join(dir, 'lib') } : {}) };
  return JSON.parse(execFileSync(exe, ['-json', path], { env, encoding: 'utf8', maxBuffer: 64 << 20 }));
};

async function axe(frame, sel) {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async (q) => (await window.axe.run(document.querySelector(q), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((v) => v.id), sel);
}

/** Folder `i` of the sidecar's --test-pick list through the command, with no dialogs. */
const run = (frame, i, options) =>
  frame.evaluate(
    async ({ i, options }) => {
      const g = window.gisworkbench;
      const folder = (await g.sidecar.client.pick('folder')).files[i];
      try {
        const r = await g.commands.run('sidecar.sfm', { folder, yes: true, options });
        if (r) return { state: r.job.state, outputs: r.job.outputs.map((o) => o.name), opened: r.opened, report: r.report, id: r.job.id };
        // A failed job reaches the user as a toast, and the command returns nothing: read the job.
        const list = await g.sidecar.client.request('GET', '/v1/jobs');
        const jobs = Array.isArray(list) ? list : list.jobs;
        return { state: jobs[0]?.state, error: jobs[0]?.error };
      } catch (e) {
        return { state: 'failed', error: String(e?.message ?? e) };
      }
    },
    { i, options },
  );

test.describe.configure({ mode: 'serial' });
test.skip(!HAS_MODULE, 'the sfm module is not in this bundle');

let page;
let frame;
let s;
const FOLDERS = { small: 0, few: 1, noGps: 2, twoCams: 3, full: 4 };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  rmSync(WORK, { recursive: true, force: true });
  const few = join(WORK, 'few');
  const noGps = join(WORK, 'nogps');
  const twoCams = join(WORK, 'twocams');
  for (const d of [few, noGps, twoCams]) mkdirSync(d, { recursive: true });
  const names = readdirSync(FX).filter((n) => /\.jpg$/i.test(n));
  names.slice(0, 3).forEach((n) => copyFileSync(join(FX, n), join(few, n)));
  // The same photographs with the EXIF segment (APP1) taken out: the pixels stay valid.
  const stripExif = (b) => {
    const keep = [b.subarray(0, 2)];
    let p = 2;
    while (p + 4 < b.length && b[p] === 0xff && b[p + 1] !== 0xda) {
      const end = p + 2 + b.readUInt16BE(p + 2);
      if (b[p + 1] !== 0xe1) keep.push(b.subarray(p, end));
      p = end;
    }
    keep.push(b.subarray(p));
    return Buffer.concat(keep);
  };
  for (const n of names.slice(0, 6)) writeFileSync(join(noGps, n), stripExif(readFileSync(join(FX, n))));
  // Two cameras: the same frames, one with its Model string changed in place.
  for (const [k, n] of names.slice(0, 6).entries()) {
    const b = Buffer.from(readFileSync(join(FX, n)));
    const at = b.indexOf('DSC-WX220');
    if (at < 0) throw new Error('the fixture has lost its camera model');
    if (k === 0) b.write('DSC-WX999', at);
    writeFileSync(join(twoCams, n), b);
  }
  const picks = [FX, few, noGps, twoCams, ...(existsSync(AUKERMAN) ? [AUKERMAN] : [])].flatMap((p) => ['--test-pick', p]);
  s = await startSidecar({ dataDir: resolve(DATA_ROOT, 'sfm26-data'), port: PORT, extra: picks });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
  await frame.evaluate((port) => {
    const c = window.gisworkbench.sidecar.client;
    c.ports = [port];
    c.base = null;
  }, PORT);
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  await expect(frame.locator('[data-id="sidecar:code"]')).toHaveText(/^\d{6}$/, { timeout: 30_000 });
  await approvePending(s);
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 30_000 });
});
test.afterAll(async () => {
  await page?.close();
  if (s) stopSidecar(s.pid);
});

test('the dialog: the limits of the result are stated, axe clean', async () => {
  test.setTimeout(120_000);
  await frame.evaluate(() => {
    const g = window.gisworkbench;
    g.sidecar.client.pick('folder').then((r) => g.commands.run('sidecar.sfm', { folder: r.files[0] }));
  });
  const dlg = frame.locator('[data-id="dialog:sidecar-sfm"]');
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  await expect(dlg).toContainText('10 JPEG photographs');
  await expect(dlg).toContainText('only as accurate as that GPS');
  await expect(dlg).toContainText('Ground control points are not used');
  await expect(dlg).toContainText('focal length in EXIF');
  expect(await axe(frame, '[data-id="dialog:sidecar-sfm"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('refusals name the problem before any long work', async () => {
  test.setTimeout(300_000);
  const few = await run(frame, FOLDERS.few, SMALL);
  expect(few.state).toBe('failed');
  expect(few.error).toContain('at least 5');
  const none = await run(frame, FOLDERS.noGps, SMALL);
  expect(none.state).toBe('failed');
  expect(none.error).toMatch(/only 0 of 6 photographs carry GPS/);
  const two = await run(frame, FOLDERS.twoCams, SMALL);
  expect(two.state).toBe('failed');
  expect(two.error).toContain('mixes 2 cameras');
  record('refusals', { few: few.error, none: none.error, two: two.error });
});

test('cancelling a run stops it and keeps nothing', async () => {
  test.setTimeout(300_000);
  const out = await frame.evaluate(
    async ({ options }) => {
      const g = window.gisworkbench;
      const c = g.sidecar.client;
      const folder = (await c.pick('folder')).files[0];
      const job = await c.createJob({ profile: 'sfm-block', inputs: [folder.id], options, reason: 'e2e cancel' });
      for (let i = 0; i < 600; i++) {
        const j = await c.job(job.id);
        if (j.state === 'running') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 1500));
      await c.cancel(job.id);
      for (let i = 0; i < 600; i++) {
        const j = await c.job(job.id);
        if (!['queued', 'running'].includes(j.state)) return { state: j.state, outputs: j.outputs };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { state: 'still running' };
    },
    { options: SMALL },
  );
  expect(out.state).toBe('cancelled');
  expect(out.outputs ?? []).toEqual([]);
});

test('SCN-63 small block: oriented frames, dense cloud, DSM and orthomosaic, all opened in the app', async () => {
  test.setTimeout(1_800_000);
  const before = await frame.evaluate(() => window.gisworkbench.layers.size);
  const r = await run(frame, FOLDERS.small, SMALL);
  expect(r.state, JSON.stringify(r)).toBe('succeeded');
  const stem = 'sfm';
  for (const n of [`${stem}.ortho.tif`, `${stem}.dsm.tif`, `${stem}.copc.laz`, `${stem}.frames.geojson`, `${stem}.sfm-report.json`]) expect(r.outputs).toContain(n);
  expect(r.opened).toHaveLength(4);
  // Seven of the ten registered in the first run: these frames are small, and a floor is all this is.
  expect(r.report.georef.registered).toBeGreaterThanOrEqual(6);
  expect(r.report.georef.reprojection_px.mean).toBeLessThan(2);
  expect(r.report.crs).toBe('EPSG:32617');
  expect(r.report.georef.focal.refined).toBe(false);
  expect(r.report.vertical).toContain('GPS');
  expect(r.report.dense_points).toBeGreaterThan(1000);
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.layers.size), { timeout: 60_000 }).toBeGreaterThan(before);
  const pub = join(s.dataDir, 'outputs', r.id);
  const ortho = gdalinfo(join(pub, `${stem}.ortho.tif`));
  const dsm = gdalinfo(join(pub, `${stem}.dsm.tif`));
  expect(ortho.driverShortName).toBe('GTiff');
  expect(ortho.metadata?.IMAGE_STRUCTURE?.LAYOUT).toBe('COG');
  expect(ortho.bands).toHaveLength(4);
  expect(ortho.bands[3].colorInterpretation).toBe('Alpha');
  expect(dsm.bands[0].type).toBe('Float32');
  expect(dsm.bands[0].noDataValue).toBe(-9999);
  for (const g of [ortho, dsm]) expect(g.stac?.['proj:epsg'] ?? g.coordinateSystem?.wkt ?? '').toEqual(expect.anything());
  expect(JSON.stringify(ortho.coordinateSystem)).toMatch(/32617/);
  // The frames are where the block is: Aukerman Park, Ohio, by the photographs' own GPS.
  const frames = JSON.parse(readFileSync(join(pub, `${stem}.frames.geojson`), 'utf8'));
  expect(frames.features.length).toBe(r.report.georef.registered);
  for (const f of frames.features) {
    expect(f.properties.lat).toBeGreaterThan(41.29);
    expect(f.properties.lat).toBeLessThan(41.32);
    expect(f.properties.lon).toBeGreaterThan(-81.77);
    expect(f.properties.lon).toBeLessThan(-81.73);
    expect(Math.abs(f.properties.phi_deg)).toBeLessThan(45);
  }
  record('small', { registered: r.report.georef.registered, reprojection: r.report.georef.reprojection_px, gps: r.report.georef.gps_rms_m, points: r.report.cloud_points, dsm: r.report.dsm, ortho: r.report.ortho });
});

test('SCN-63 Aukerman, 77 photographs (ODM data set)', async () => {
  test.skip(!existsSync(AUKERMAN), 'the ODM data set is not here (GW_SFM_DATA)');
  test.setTimeout(14_400_000);
  const r = await run(frame, FOLDERS.full, { feature_threads: 4 });
  expect(r.state, JSON.stringify(r)).toBe('succeeded');
  expect(r.opened).toHaveLength(4);
  expect(r.report.georef.registered / r.report.georef.images).toBeGreaterThanOrEqual(0.9);
  expect(r.report.ortho.covered_share).toBeGreaterThan(0.5);
  record('aukerman', { georef: r.report.georef, points: r.report.cloud_points, dsm: r.report.dsm, ortho: r.report.ortho });
});
