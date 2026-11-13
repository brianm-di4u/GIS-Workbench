// SCN-82 (REQ-GAP-94, REG-075, decision 0018): an analyst places a UAV block on surveyed ground
// control points marked in its photographs, checks it on points kept out of the adjustment, and
// compares the DSM with the survey team's own.
//
// The block is Bamboi bridge on the Black Volta (4TU.ResearchData, CC BY 4.0, test data only, never
// committed): about 311 DJI photographs, 7 surveyed points with 4 to 5 marks each in ODM's
// gcp_list.txt (GCPS_Final.txt), and the authors' ODM DSM made with those points. GW_SFM_GCP_DATA
// points at its Bamboi folder. The run uses the authors' marks, so it measures the route, not a
// person's marking; the marking dialog is checked on its own against the same marks.
//
// 1. Both stages through the app's command: 5 control points and 2 checkpoints (the 2 nearest the
//    block's centre, so they are inside the control).
// 2. The marking dialog on the published model: where it predicts each mark, axe, a click and the
//    arrow keys.
// 3. Leave-one-out over all 7 points with the stage-2 georef (gwb-sfm from the bundle) on the same
//    model: each point in turn a checkpoint.
// 4. The DSM against the authors': theirs resampled onto ours by the bundle's gdalwarp (average),
//    then the median difference (the bias), the NMAD, the RMSE and the 95th percentile.
//
// Runs in the `sidecar` projects on a sidecar of its own. Long: hours on a CPU. Keep GWB_SIDECAR_DATA
// and TE_OUT off C:.

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { join, resolve, dirname } from 'node:path';
import { openApp } from '../helpers.js';
import { startSidecar, stopSidecar, approvePending, DATA_ROOT, DIST_DIR, MODULES, LINUX } from './harness.js';
import { parseControl, controlCsv, readModelHeader, candidates } from '../../../app/src/features/sfm-gcp.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const BV = process.env.GW_SFM_GCP_DATA ?? (LINUX ? `${process.env.HOME}/gwb/data-sfm/blackvolta/Bamboi` : 'E:/TE-corpus/frames-4tu-blackvolta-gcp/data/Bamboi');
const PHOTOS = join(BV, 'images');
const GCPS = join(PHOTOS, 'GCPS_Final.txt');
const AUTHORS_DSM = join(BV, 'filtered_data', 'rerun-Bamboi-Bridge-21-03-2023-with-GCPs-and-classifications-dsm.tif');
const DATA = resolve(DATA_ROOT, 'scn82-data');
const WORK = resolve(DATA_ROOT, 'scn82-work');
const OUT = process.env.TE_OUT ? resolve(process.env.TE_OUT, 'scn82') : resolve(DATA_ROOT, 'scn82-out');
const REPORT = resolve('reports', 'sidecar', 'scn82.json');
const PORT = 47823;
const EXE = (n) => join(MODULES, 'sfm', 'bin', LINUX ? n : `${n}.exe`);
const HAS_MODULE = existsSync(EXE('colmap')) && existsSync(EXE('gwb-sfm'));

/** A GDAL tool from the bundle's core-gdal module. */
const gdal = (tool, args) => {
  const dir = join(MODULES, 'core-gdal');
  const env = { ...process.env, GDAL_DATA: join(dir, 'share', 'gdal'), PROJ_DATA: join(dir, 'share', 'proj'), PATH: `${join(dir, 'bin')}${LINUX ? ':' : ';'}${process.env.PATH}`, ...(LINUX ? { LD_LIBRARY_PATH: join(dir, 'lib') } : {}) };
  return execFileSync(join(dir, 'bin', LINUX ? tool : `${tool}.exe`), args, { env, encoding: 'utf8', maxBuffer: 256 << 20, timeout: 3000_000 });
};
// Stage 1 as sfm-block's defaults; stage 2 smaller than its defaults, to keep the dense stage to hours.
// GW_SCN82_STAGE1 and GW_SCN82_STAGE2 (JSON) override them, for a smoke run on a subset.
const STAGE1 = JSON.parse(process.env.GW_SCN82_STAGE1 ?? '{"feature_threads":4}');
const STAGE2 = JSON.parse(process.env.GW_SCN82_STAGE2 ?? '{"image_size":2000,"depth_size":1000,"views":5}');
// GW_SCN82_MODEL is a model file an earlier run's first stage published: the first stage is then not run again.
const MODEL = process.env.GW_SCN82_MODEL;

const results = {};
const record = (k, v) => {
  results[k] = v;
  for (const f of [REPORT, join(OUT, 'scn82.json')]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, data: BV, stage1: STAGE1, stage2: STAGE2, results }, null, 2));
  }
};
// Regression floors, set with room above what the full block measured (reports/sidecar/scn82.json, quoted in the pull request):
// they say the run has not got worse, not how accurate the method is. A subset run misses them.
// The DSM's whole-block spread is the river and the trees, made differently by two dense methods;
// at the surveyed points both DSMs sit on the ground.
const FLOORS = { check_h: 0.2, check_v: 0.25, loo_h: 0.15, loo_v: 0.16, loo_gain: 0.85, dsm_cover: 0.9, dsm_median: 0.5, dsm_nmad: 1.2, dsm_points: 0.3 };
// Floors are checked in the last test: these tests run in series, and one that fails stops the ones
// after it, which would lose their measurements.
const floors = [];
const floor = (what, value, limit, above = false) => {
  floors.push({ what, value, limit: `${above ? '>' : '<'} ${limit}`, ok: above ? value > limit : value < limit });
  record('floors', floors);
};
const rms = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length);
const axes = (ds) => ({ east: rms(ds.map((d) => d[0])), north: rms(ds.map((d) => d[1])), up: rms(ds.map((d) => d[2])) });

async function axe(frame, sel) {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async (q) => (await window.axe.run(document.querySelector(q), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((v) => v.id), sel);
}

test.describe.configure({ mode: 'serial' });
test.skip(!HAS_MODULE, 'the sfm module is not in this bundle');
test.skip(!existsSync(GCPS), `the Black Volta block is not at ${BV}`);

let page;
let frame;
let s;
let authors; // the 7 points with the authors' marks
let checks; // ids of the 2 checkpoints
let run; // stage 2's job, the model file and the report

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  authors = parseControl(readFileSync(GCPS, 'utf8'));
  expect(authors.points).toHaveLength(7);
  const n = authors.points.length;
  const c = [0, 1].map((k) => authors.points.reduce((a, p) => a + p.xyz[k], 0) / n);
  checks = [...authors.points]
    .sort((a, b) => Math.hypot(a.xyz[0] - c[0], a.xyz[1] - c[1]) - Math.hypot(b.xyz[0] - c[0], b.xyz[1] - c[1]))
    .slice(0, 2)
    .map((p) => p.id);
  const main = { ...authors, points: authors.points.map((p) => ({ ...p, check: checks.includes(p.id) })) };
  writeFileSync(join(WORK, 'gcp-5-2.csv'), controlCsv(main));
  s = await startSidecar({ dataDir: DATA, port: PORT, extra: ['--test-pick', PHOTOS, '--test-pick', join(WORK, 'gcp-5-2.csv'), ...(MODEL ? ['--test-pick', MODEL] : [])] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
  await frame.evaluate((port) => {
    const cl = window.gisworkbench.sidecar.client;
    cl.ports = [port];
    cl.base = null;
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

test('SCN-82: both stages, 5 control points and 2 checkpoints', async () => {
  test.setTimeout(10 * 3600_000);
  const began = Date.now();
  run = await frame.evaluate(
    async ({ STAGE1, STAGE2 }) => {
      const g = window.gisworkbench;
      const [folder, control, model] = (await g.sidecar.client.pick('folder')).files;
      try {
        const r = await g.commands.run('sidecar.sfmcontrol', { folder, control, model, yes: true, options: STAGE1, options2: STAGE2 });
        if (r) return { state: r.job.state, id: r.job.id, outputs: r.job.outputs.map((o) => o.name), opened: r.opened, report: r.report, model: r.model };
        const list = await g.sidecar.client.request('GET', '/v1/jobs');
        const jobs = Array.isArray(list) ? list : list.jobs;
        return { state: jobs[0]?.state, error: jobs[0]?.error, jobs: jobs.map((j) => [j.profile, j.state, j.error]) };
      } catch (e) {
        return { state: 'failed', error: String(e?.message ?? e) };
      }
    },
    { STAGE1, STAGE2 },
  );
  expect(run.state, JSON.stringify(run)).toBe('succeeded');
  const g = run.report.georef;
  const c = g.control;
  record('both_stages', { minutes: (Date.now() - began) / 60000, first_stage: MODEL ? `not run: ${MODEL}` : 'run', checks, registered: g.registered, images: g.images, reprojection_px: g.reprojection_px, gps_rms_m: g.gps_rms_m, control: c, stage_one: g.stage_one, vertical: run.report.vertical, cloud_points: run.report.cloud_points, dsm: run.report.dsm, ortho: run.report.ortho, model: run.model?.name });
  for (const n of ['images.ortho.tif', 'images.dsm.tif', 'images.copc.laz', 'images.frames.geojson', 'images.sfm-report.json']) expect(run.outputs).toContain(n);
  expect(run.opened).toHaveLength(4);
  expect([c.gcps, c.checks]).toEqual([5, 2]);
  expect(c.epsg).toBe(32630);
  expect(g.stage_one.provenance).toContain('profile=sfm-model');
  expect(run.report.crs).toBe('EPSG:32630');
  expect(run.report.vertical).toContain('ground control');
  expect(g.registered / g.images).toBeGreaterThan(0.9);
  expect(c.adjustment.control_weight).toBeGreaterThan(1);
  // Floors, not the measurement (that is in the report): the survey's own accuracy is not published.
  floor('2 checkpoints, horizontal RMSE m', Math.hypot(c.rmse_check_m.east, c.rmse_check_m.north), FLOORS.check_h);
  floor('2 checkpoints, vertical RMSE m', Math.abs(c.rmse_check_m.up), FLOORS.check_v);
});

/** The stage-1 model file the run published, on the sidecar's disk. */
function modelPath() {
  if (MODEL) return MODEL;
  const root = join(DATA, 'outputs');
  for (const job of readdirSync(root)) {
    const f = join(root, job, run.model.name);
    if (existsSync(f)) return f;
  }
  throw new Error(`${run.model.name} is not under ${root}`);
}


test('leave-one-out: each of the 7 points a checkpoint in turn', async () => {
  test.setTimeout(3600_000);
  expect(run?.model, 'the run published no model').toBeTruthy();
  const w = join(WORK, 'loo');
  rmSync(w, { recursive: true, force: true });
  mkdirSync(w, { recursive: true });
  const sfm = (args) => execFileSync(EXE('gwb-sfm'), args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  sfm(['import', '--images', PHOTOS, '--sparse', join(w, 'sparse'), '--gps', join(w, 'gps.json'), '--control', join(w, 'unused.txt'), '--in', modelPath(), '--in', join(WORK, 'gcp-5-2.csv')]);
  const after = [];
  const before = [];
  const each = [];
  for (const p of authors.points) {
    const csv = join(w, `${p.id}.csv`);
    writeFileSync(csv, controlCsv({ ...authors, points: authors.points.map((q) => ({ ...q, check: q.id === p.id })) }));
    sfm(['georef', '--sparse', join(w, 'sparse'), '--gps', join(w, 'gps.json'), '--model', join(w, `model-${p.id}`), '--sim3', join(w, `${p.id}.sim3`), '--json', join(w, `${p.id}.json`), '--gcp', csv]);
    const j = JSON.parse(readFileSync(join(w, `${p.id}.json`), 'utf8'));
    const r = j.control.points.find((q) => q.id === p.id && q.role === 'check');
    expect(r, `${p.id} was not measured`).toBeTruthy();
    const d = [r.residual_m.east, r.residual_m.north, r.residual_m.up];
    after.push(d);
    const b = j.control.before_adjustment.rmse_check_m;
    before.push([b.east, b.north, b.up]);
    each.push({ id: p.id, residual_m: r.residual_m, before_adjustment_m: b, iterations: j.control.adjustment.iterations });
  }
  const summary = { points: each.length, rmse_m: axes(after), rmse_before_adjustment_m: axes(before), each };
  record('leave_one_out', summary);
  expect(each).toHaveLength(7);
  const d3 = (v) => Math.hypot(v.east, v.north, v.up);
  floor('leave-one-out, horizontal RMSE m', Math.hypot(summary.rmse_m.east, summary.rmse_m.north), FLOORS.loo_h);
  floor('leave-one-out, vertical RMSE m', summary.rmse_m.up, FLOORS.loo_v);
  // What the adjustment is for: it must predict a point it was not given better than the similarity alone.
  floor('leave-one-out, 3D RMSE after the adjustment over before it', d3(summary.rmse_m) / d3(summary.rmse_before_adjustment_m), FLOORS.loo_gain);
});

test("the DSM against the authors' DSM made with the same points", async () => {
  test.setTimeout(3600_000);
  test.skip(!existsSync(AUTHORS_DSM), "the authors' DSM is not extracted");
  expect(run?.id, 'no stage 2 run').toBeTruthy();
  const ours = join(DATA, 'outputs', run.id, 'images.dsm.tif');
  const info = JSON.parse(gdal('gdalinfo', ['-json', ours]));
  const [w, h] = info.size;
  const gt = info.geoTransform;
  const nd = info.bands[0].noDataValue;
  const a = join(WORK, 'ours.bin');
  const b = join(WORK, 'theirs.bin');
  gdal('gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Float32', ours, a]);
  gdal('gdalwarp', ['-q', '-overwrite', '-of', 'ENVI', '-ot', 'Float32', '-t_srs', 'EPSG:32630', '-te', String(gt[0]), String(gt[3] + gt[5] * h), String(gt[0] + gt[1] * w), String(gt[3]), '-ts', String(w), String(h), '-r', 'average', '-dstnodata', 'nan', AUTHORS_DSM, b]);
  const read = (f) => {
    const buf = readFileSync(f);
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const z = read(a);
  const r = read(b);
  const d = [];
  let valid = 0;
  for (let i = 0; i < z.length; i++) {
    if (!Number.isFinite(z[i]) || z[i] === nd) continue;
    valid += 1;
    if (Number.isFinite(r[i])) d.push(z[i] - r[i]);
  }
  d.sort((x, y) => x - y);
  const med = d[d.length >> 1];
  const dev = d.map((x) => Math.abs(x - med)).sort((x, y) => x - y);
  const abs = d.map(Math.abs).sort((x, y) => x - y);
  // Our DSM at each surveyed point, less its surveyed height.
  const at = authors.points.map((p) => {
    const i = Math.floor((p.xyz[0] - gt[0]) / gt[1]);
    const j = Math.floor((p.xyz[1] - gt[3]) / gt[5]);
    const v = i >= 0 && j >= 0 && i < w && j < h ? z[j * w + i] : NaN;
    return { id: p.id, dsm_less_survey_m: Number.isFinite(v) && v !== nd ? v - p.xyz[2] : null };
  });
  const atPoints = at.map((p) => p.dsm_less_survey_m).filter((v) => v != null);
  const out = { at_points: at, at_points_rmse_m: rms(atPoints), cell_m: Math.abs(gt[1]), cells_ours: valid, cells_compared: d.length, covered_share: d.length / Math.max(1, valid), median_m: med, nmad_m: 1.4826 * dev[dev.length >> 1], rmse_m: rms(d), p95_abs_m: abs[Math.floor(abs.length * 0.95)], mean_m: d.reduce((s, x) => s + x, 0) / d.length };
  record('dsm_vs_authors', out);
  rmSync(a, { force: true });
  rmSync(b, { force: true });
  floor('DSM, share of our cells the authors cover', out.covered_share, FLOORS.dsm_cover, true);
  floor('DSM less the authors, median m', Math.abs(out.median_m), FLOORS.dsm_median);
  floor('DSM less the authors, NMAD m', out.nmad_m, FLOORS.dsm_nmad);
  expect(atPoints).toHaveLength(authors.points.length);
  floor('DSM less the survey at the 7 points, RMSE m', out.at_points_rmse_m, FLOORS.dsm_points);
});

test('the marking dialog: where it predicts each mark, axe, a click and the arrow keys', async () => {
  test.setTimeout(600_000);
  expect(run?.model, 'the run published no model').toBeTruthy();
  const header = await readModelHeader({ body: Readable.toWeb(createReadStream(modelPath())) });
  // How far stage 1 (placed by GPS) predicts each of the authors' marks.
  const off = [];
  let missed = 0;
  for (const p of authors.points) {
    const cand = candidates(header, p, { max: 1000 });
    for (const m of p.marks) {
      const at = cand.find((c) => c.image === m.image);
      if (at) off.push(Math.hypot(at.px - m.px, at.py - m.py));
      else missed += 1;
    }
  }
  off.sort((a, b) => a - b);
  const prediction = { marks: off.length + missed, predicted: off.length, median_px: off[off.length >> 1], max_px: off[off.length - 1], within_view: off.filter((d) => d < 220).length };
  record('prediction', prediction);
  expect(prediction.predicted / prediction.marks).toBeGreaterThan(0.8);
  // The dialog on the first point, with the photographs it lists opened in the page.
  const first = authors.points[0];
  const cand = candidates(header, first);
  const input = await frame.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.style.display = 'none';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(cand.map((c) => join(PHOTOS, c.image)));
  await frame.evaluate(
    async ({ i, model }) => {
      const g = window.gisworkbench;
      const [folder, control] = (await g.sidecar.client.pick('folder')).files;
      const photos = [...i.files];
      i.remove();
      window.__scn82 = g.commands.run('sidecar.sfmcontrol', { folder, control, model, photos });
    },
    { i: input, model: run.model },
  );
  // With a model given, the first stage does not run again, but its dialog still opens.
  const opts = frame.locator('[data-id="dialog:sidecar-sfm-gcp"]');
  await expect(opts).toBeVisible({ timeout: 60_000 });
  expect(await axe(frame, '[data-id="dialog:sidecar-sfm-gcp"]')).toEqual([]);
  await opts.getByRole('button', { name: 'Run the first stage' }).click();
  const dlg = frame.locator('[data-id="dialog:sidecar-sfm-mark"]');
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  const caption = dlg.locator('[data-id="sfm:photo"]');
  await expect(caption).toContainText(`${first.id} in ${cand[0].image}`, { timeout: 30_000 });
  await page.screenshot({ path: join(OUT, 'scn82-marking.png') });
  expect(await axe(frame, '[data-id="dialog:sidecar-sfm-mark"]')).toEqual([]);
  // A click lands where the photograph's pixel is: at the authors' mark when it is in view.
  const ox = Math.round(cand[0].px - 320);
  const oy = Math.round(cand[0].py - 220);
  const theirs = first.marks.find((m) => m.image === cand[0].image);
  const target = theirs && theirs.px - ox > 0 && theirs.px - ox < 640 && theirs.py - oy > 0 && theirs.py - oy < 440 ? [theirs.px, theirs.py] : [cand[0].px + 10, cand[0].py + 10];
  const canvas = dlg.locator('[data-id="sfm:canvas"]');
  const box = await canvas.boundingBox();
  await canvas.click({ position: { x: ((target[0] - ox) * box.width) / 640, y: ((target[1] - oy) * box.height) / 440 } });
  const got = /marked at (-?[\d.]+), (-?[\d.]+)\./.exec(await caption.textContent());
  expect(got, await caption.textContent()).toBeTruthy();
  expect(Math.abs(Number(got[1]) - target[0])).toBeLessThan(1.5);
  expect(Math.abs(Number(got[2]) - target[1])).toBeLessThan(1.5);
  // The keyboard: three to the right from the mark, then Enter.
  await canvas.focus();
  for (let i = 0; i < 3; i++) await canvas.press('ArrowRight');
  await canvas.press('Enter');
  await expect(caption).toContainText(`marked at ${(Number(got[1]) + 3).toFixed(1)}, ${Number(got[2]).toFixed(1)}.`);
  await expect(dlg.locator('[data-id="sfm:markstatus"]')).toContainText('control points marked');
  record('dialog', { point: first.id, photo: cand[0].image, clicked: target, marked: [Number(got[1]), Number(got[2])] });
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(await frame.evaluate(() => window.__scn82)).toBeNull();
});

test('the floors hold', () => {
  expect(floors.length).toBeGreaterThan(0);
  expect(floors.filter((f) => !f.ok)).toEqual([]);
});
