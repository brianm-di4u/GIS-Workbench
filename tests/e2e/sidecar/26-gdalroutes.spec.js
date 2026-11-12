// SCN-60 (REQ-GAP-72, 15, 17, 54, 67, 36): HDF4, FITS, KEA through new plug-ins, a gated PostGIS
// raster route, pan-sharpening and reprojection, FileGDB domains as a catalogue, PDF through
// PDFium, and multipatch, FBX and IFC, each checked against an oracle that is not the tool under test
// (tests/tools/gdalroutes_oracle.py). Runs in the `sidecar` projects; skips what its bundle lacks.
// Env: GWB_ORACLE_PY (Python with numpy and the GDAL bindings), GWB_ORACLE_BIN (another GDAL build's
// bin folder), GWB_PROJ_GRIDS (a folder of proj-data grids for the oracle's cs2cs), GWB_IFC_FULL (an
// unpacked IfcOpenShell wheel for its validator).

import { test, expect } from '@playwright/test';
import { join, resolve, dirname } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openApp } from '../helpers.js';
import { state, approvePending, DIST_DIR, LINUX } from './harness.js';

const DIST = join(DIST_DIR, 'gis-workbench.html');
const PREFS = { welcomeDone: true };
const FX = resolve('fixtures', 'fx26', 'gdalroutes');
const fx = (n) => join(FX, n);
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PY = process.env.GWB_ORACLE_PY ?? (LINUX ? `${process.env.HOME}/gwb/oracle/bin/python` : 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe');
const ORACLE_BIN = process.env.GWB_ORACLE_BIN ?? (LINUX ? `${process.env.HOME}/gwb/oracle/bin` : 'E:/gwb-sidecar-deps/osgeo4w/root/bin');
const PROJ_BIN = process.env.GWB_ORACLE_PROJ ?? (LINUX ? `${process.env.HOME}/gwb/oracle/bin` : 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin');
const GRIDS = process.env.GWB_PROJ_GRIDS ?? (LINUX ? `${process.env.HOME}/gwb/deps/proj-data-26/share/proj` : 'E:/gwb-sidecar-deps/proj-data-26/Library/share/proj');
const IFC_FULL = process.env.GWB_IFC_FULL ?? (LINUX ? `${process.env.HOME}/gwb/oracle/ifc` : 'E:/gwb26/data-gdalroutes/ifcos-win/x-win');
const REPORT = resolve('reports', 'sidecar', 'scn60.json');
const results = {};
const record = (k, v) => {
  results[k] = v;
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ at: new Date().toISOString(), platform: process.platform, results }, null, 2));
};

const IFC_PY = process.env.GWB_IFC_PY ?? (LINUX ? `${process.env.HOME}/gwb/oracle/ifc-env/bin/python` : 'E:/gwb26/envs/ifc-oracle/python.exe');
const oracle = (...a) => JSON.parse(execFileSync(PY, [resolve('tests', 'tools', 'gdalroutes_oracle.py'), ...a], { encoding: 'utf8', env: oracleEnv(), maxBuffer: 1 << 26 }).trim().split('\n').pop());
function oracleEnv() {
  // No .aux.xml beside the fixtures.
  const e = { ...process.env, GDAL_PAM_ENABLED: 'NO' };
  for (const k of ['GDAL_DATA', 'PROJ_LIB', 'PROJ_DATA', 'GDAL_DRIVER_PATH']) delete e[k];
  return e;
}
const canOracle = () => existsSync(PY);
/** The other GDAL build: its bin first on PATH, its own data, none of ours. */
function otherGdal(tool, args) {
  const root = dirname(ORACLE_BIN);
  const env = { ...oracleEnv(), PATH: `${ORACLE_BIN}${LINUX ? ':' : ';'}${process.env.PATH}` };
  const share = join(root, LINUX ? 'share' : 'apps', ...(LINUX ? [] : ['gdal', 'share']));
  if (existsSync(join(share, 'gdal'))) env.GDAL_DATA = join(share, 'gdal');
  return execFileSync(join(ORACLE_BIN, tool), args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
}

async function pair(frame, s) {
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('sidecar.pair');
  });
  const code = frame.locator('[data-id="sidecar:code"]');
  await expect(code).toHaveText(/^\d{6}$/, { timeout: 20_000 });
  await approvePending(s, { expectCode: await code.textContent() });
  await expect(frame.locator('.status-sidecar').first()).toHaveText(/Sidecar ✓|Sidecar · /, { timeout: 20_000 });
}

/** File objects in the page for these paths, kept in window.__fx. */
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

/** A job through sidecar.convert → {state, id, outputs, error, result}; the output file's path added. */
async function job(frame, s, paths, profile, options = {}, { separate = false, open = false } = {}) {
  await files(frame, paths);
  const j = await frame.evaluate(
    async ({ profile, options, separate, open }) => {
      const app = window.gisworkbench;
      const list = window.__fx;
      const inputs = separate ? [] : list;
      if (separate) for (const f of list) inputs.push((await app.sidecar.client.uploadSet(f, [])).id);
      try {
        const r = await app.sidecar.convert({ files: inputs, profile, options, open, reason: 'e2e' });
        return { state: r.state, id: r.id, outputs: r.outputs, result: r.result, provenance: r.provenance };
      } catch (e) {
        return { state: 'error', error: e.message, code: e.code };
      }
    },
    { profile, options, separate, open },
  );
  if (j.outputs?.[0]) j.path = join(s.dataDir, 'outputs', j.id, j.outputs[0].name);
  return j;
}

async function axe(frame, sel) {
  if (!(await frame.evaluate(() => !!window.axe))) await frame.evaluate(AXE);
  return frame.evaluate(async (q) => (await window.axe.run(document.querySelector(q), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((v) => `${v.id}: ${v.nodes.length}`), sel);
}

test.describe.configure({ mode: 'serial' });
let page;
let frame;
let s;
let caps;

test.beforeAll(async ({ browser }) => {
  s = state();
  page = await browser.newPage();
  ({ frame } = await openApp(page, 'file', { htmlPath: DIST, prefs: PREFS }));
  // The test sidecar's own port: another sidecar on this machine must not answer first.
  await frame.evaluate((port) => {
    const c = window.gisworkbench.sidecar.client;
    c.ports = [port];
    c.base = null;
  }, s.port);
  await pair(frame, s);
  caps = await frame.evaluate(() => window.gisworkbench.sidecar.ready());
});
test.afterAll(async () => {
  // The other sidecar specs start unpaired, and pair this origin themselves.
  await frame?.evaluate(() => window.gisworkbench.commands.run('sidecar.forget')).catch(() => {});
  await page?.close();
});

const has = (n) => caps.raster_drivers.some((d) => d.name === n);
const model3d = () => caps.modules.find((m) => m.id === 'model3d')?.installed;
const profile = (id) => caps.profiles.find((p) => p.id === id);

test('REQ-GAP-72 the plug-ins are in the caps, and PostGIS raster stays off (OD-2.17)', async () => {
  const names = ['HDF4', 'HDF4Image', 'FITS', 'KEA', 'PostGISRaster', 'PDF', ...(LINUX ? ['TileDB'] : ['TileDB'])];
  const state_ = Object.fromEntries(names.map((n) => [n, has(n)]));
  record('drivers', state_);
  for (const n of names) expect(state_[n], n).toBe(true);
  expect(profile('pgraster-cog').available).toBe(false);
  const r = await frame.evaluate(() => window.gisworkbench.sidecar.client.createJob({ profile: 'pgraster-cog', inputs: [], options: { dbname: 'gis', user: 'u', table: 't' } }).catch((e) => e.message));
  expect(String(r)).toMatch(/external security review/);
});

test('REQ-GAP-72 FITS against a parser of the standard', async () => {
  test.skip(!canOracle(), 'no oracle Python');
  const j = await job(frame, s, fx('byte_merc.fits'), 'raster-cog');
  expect(j.state, j.error).toBe('succeeded');
  const m = oracle('fits', fx('byte_merc.fits'), j.path);
  record('fits', m);
  expect(m.equal).toBe(true);
});

test('REQ-GAP-72 HDF4 against another GDAL build, KEA against its HDF5 arrays read with h5py', async () => {
  test.skip(!canOracle() || !existsSync(ORACLE_BIN), 'no oracle GDAL');
  // The file is a container: its first subdataset, by the route the probe names for one.
  const j = await job(frame, s, fx('hdifftst2.hdf'), 'raster-sds-cog', { subdataset: 1, compress: 'NONE' });
  expect(j.state, j.error).toBe('succeeded');
  const raw = join(s.dataDir, 'hdf4.bil');
  const sub = JSON.parse(otherGdal('gdalinfo', ['-json', fx('hdifftst2.hdf')])).metadata.SUBDATASETS.SUBDATASET_1_NAME;
  otherGdal('gdal_translate', ['-q', '-of', 'ENVI', '-co', 'INTERLEAVE=BSQ', sub, raw]);
  const info = JSON.parse(otherGdal('gdalinfo', ['-json', sub]));
  const hdf = oracle('raw', j.path, raw, String(info.size[0]), String(info.size[1]), String(info.bands.length), { Byte: 'u1', Int16: '<i2', UInt16: '<u2', Int32: '<i4', Float32: '<f4' }[info.bands[0].type]);
  record('hdf4', hdf);
  expect(hdf.equal).toBe(true);
  const k = await job(frame, s, fx('small.kea'), 'raster-cog', { compress: 'NONE', predictor: 'NO' });
  expect(k.state, k.error).toBe('succeeded');
  const kea = oracle('kea', fx('small.kea'), k.path);
  record('kea', kea);
  expect(kea.equal).toBe(true);
});

test('REQ-GAP-72 a container: the probe counts its subdatasets, and one of them converts', async () => {
  test.skip(!has('PDF'), 'no PDF plug-in');
  await files(frame, fx('byte_and_rgbsmall_2pages.pdf'));
  const probe = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const up = await app.sidecar.client.uploadSet(window.__fx[0], []);
    const j = await app.sidecar.client.createJob({ profile: 'probe', inputs: [up.id] });
    for (;;) {
      const r = await app.sidecar.client.job(j.id);
      if (['succeeded', 'failed'].includes(r.state)) return r.result?.match;
      await new Promise((x) => setTimeout(x, 200));
    }
  });
  expect(probe.subdatasets).toBe(2);
  const j = await job(frame, s, fx('byte_and_rgbsmall_2pages.pdf'), 'raster-sds-cog', { subdataset: 2 });
  expect(j.state, j.error).toBe('succeeded');
  const page2 = JSON.parse(otherGdal('gdalinfo', ['-json', j.path]));
  expect(page2.bands.length).toBeGreaterThanOrEqual(3);
  record('subdataset', { probe: probe.subdatasets, bands: page2.bands.length, size: page2.size });
});

test('REQ-GAP-72 the Convert dialog names the subdatasets of a container', async () => {
  await files(frame, fx('hdifftst2.hdf'));
  frame.evaluate(() => window.gisworkbench.commands.run('sidecar.convertdialog', { files: [window.__fx[0]] }));
  const dlg = frame.locator('[data-id="dialog:sidecar-convert"]');
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  const pick = dlg.locator('[data-id="sidecar:subdataset"]');
  await expect(pick).toBeVisible({ timeout: 30_000 });
  const names = await pick.locator('option').allTextContents();
  expect(names.length).toBeGreaterThan(1);
  expect(names[0]).toMatch(/^1: .*\[/);
  // The number the form sends follows the choice, and the bare number field is gone.
  await pick.selectOption({ index: 1 });
  expect(await dlg.locator('[data-opt="subdataset"]').inputValue()).toBe('2');
  await expect(dlg.locator('[data-opt="subdataset"]')).toBeHidden();
  expect(await axe(frame, '[data-id="dialog:sidecar-convert"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
});

test('REQ-GAP-15 pan-sharpen: the dialog, axe, and weighted Brovey computed independently', async () => {
  test.skip(!canOracle(), 'no oracle Python');
  await files(frame, [fx('pan.tif'), fx('ms.tif')]);
  const done = frame.evaluate(async () => {
    const [pan, ms] = window.__fx;
    const r = await window.gisworkbench.commands.run('sidecar.pansharpen', { pan, ms: [ms] });
    return { state: r?.state, id: r?.id, outputs: r?.outputs };
  });
  const dlg = frame.locator('[data-id="dialog:sidecar-pansharpen"]');
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  expect(await axe(frame, '[data-id="dialog:sidecar-pansharpen"]')).toEqual([]);
  await dlg.locator('[data-opt="weights"]').fill('0.25 0.5 0.25');
  await dlg.locator('[data-opt="resampling"]').selectOption('nearest');
  await dlg.locator('button', { hasText: 'Run' }).click();
  const j = await done;
  expect(j.state).toBe('succeeded');
  const m = oracle('brovey', fx('pan.tif'), fx('ms.tif'), join(s.dataDir, 'outputs', j.id, j.outputs[0].name), '0.25,0.5,0.25');
  record('brovey', m);
  expect(m.max_abs).toBeLessThanOrEqual(1);
});

test('REQ-GAP-17 grids: OSTN15 and NADCON through the module, measured against cs2cs; refused without them', async () => {
  test.skip(!canOracle() || !existsSync(GRIDS), 'no grids for the oracle');
  const grids = caps.modules.find((m) => m.id === 'proj-grids');
  for (const [name, fixture, to, back] of [['ostn15', 'osgb_xy.tif', 'EPSG:4326', 'EPSG:27700'], ['nadcon', 'nad27_xy.tif', 'EPSG:4269', 'EPSG:26711']]) {
    const j = await job(frame, s, fx(fixture), 'raster-reproject', { t_srs: to, resampling: 'bilinear', compress: 'NONE' });
    if (!grids?.installed) {
      // Without the grids, "best operation only" must refuse, not shift by a lesser method.
      expect(j.state).toBe('error');
      expect(j.error).toMatch(/grid|best|transform/i);
      record(`grids_${name}`, { installed: false, refused: true });
      continue;
    }
    expect(j.state, j.error).toBe('succeeded');
    // Pixel centres, sent back to the source CRS by cs2cs with the grids: a warped value holds the
    // source position of exactly that point.
    const pts = join(s.dataDir, `${name}-ll.txt`);
    const gi = JSON.parse(otherGdal('gdalinfo', ['-json', j.path]));
    const gt = gi.geoTransform;
    const ll = [];
    for (let i = 1; i < 30; i++) for (let k = 1; k < 30; k++) ll.push([gt[0] + (Math.floor((gi.size[0] * i) / 30) + 0.5) * gt[1], gt[3] + (Math.floor((gi.size[1] * k) / 30) + 0.5) * gt[5]]);
    writeFileSync(pts, ll.map(([lon, lat]) => `${lat.toFixed(12)} ${lon.toFixed(12)}`).join('\n') + '\n');
    const data = `${join(dirname(PROJ_BIN), 'share', 'proj')}${LINUX ? ':' : ';'}${GRIDS}`;
    const out = execFileSync(join(PROJ_BIN, 'cs2cs'), ['-f', '%.6f', to, back, pts], { encoding: 'utf8', env: { ...oracleEnv(), PROJ_DATA: data, PROJ_NETWORK: 'OFF' } });
    const rows = out.trim().split(/\r?\n/).map((l, i) => `${ll[i][0]} ${ll[i][1]} ${l.split(/\s+/).slice(0, 2).join(' ')}`);
    const rf = join(s.dataDir, `${name}-points.txt`);
    writeFileSync(rf, rows.join('\n') + '\n');
    const m = oracle('gridcheck', j.path, rf);
    record(`grids_${name}`, { installed: true, ...m });
    expect(m.points).toBeGreaterThan(400);
    // The source pixel is 100 m and each band a linear ramp, so bilinear is exact: this measures the shift.
    expect(m.p95).toBeLessThan(0.05);
  }
});

test('REQ-GAP-54 FileGDB domains become a catalogue the attribution tools offer', async () => {
  await files(frame, fx('DomainsSub.gdb.zip'));
  const done = frame.evaluate(async () => {
    const r = await window.gisworkbench.commands.run('sidecar.gdbcatalog', { file: window.__fx[0] });
    const roads = r?.catalog?.types?.find((x) => x.code === 'Roads');
    return r && { imported: r.imported, counts: r.counts, warnings: r.warnings, id: r.catalog?.id, surface: r.catalog?.attributes?.SurfaceType, speed: r.catalog?.attributes?.MaxSpeed, subtypes: roads?.subtypes?.map((s) => ({ code: s.code, name: s.name, narrowed: s.domains.MedianType ?? [] })) };
  });
  const dlg = frame.locator('[data-id="dialog:sidecar-gdbcatalog"]');
  await expect(dlg).toBeVisible({ timeout: 60_000 });
  expect(await axe(frame, '[data-id="dialog:sidecar-gdbcatalog"]')).toEqual([]);
  await dlg.locator('button', { hasText: 'Import' }).click();
  const r = await done;
  record('catalogue', r);
  expect(r.imported).toBe(true);
  expect(r.counts.domains).toBe(3);
  expect(r.counts.subtypes).toBe(2);
  expect(r.subtypes).toEqual([{ code: '1', name: 'Sealed', narrowed: ['0', '1'] }, { code: '2', name: 'Unsealed', narrowed: [] }]);
  expect(r.surface.domain).toEqual({ 1: 'Asphalt', 2: 'Gravel', 3: 'Oiled Sand', 4: 'Dirt' });
  expect(r.speed.range.length).toBe(2);
  expect(await frame.evaluate((id) => window.gisworkbench.catalogs.info(id)?.name, r.id)).toMatch(/DomainsSub/);
});

test('REQ-GAP-67 PDF through PDFium: read against poppler, write read back by another GDAL build', async () => {
  test.skip(!has('PDF'), 'no PDF plug-in');
  const j = await job(frame, s, fx('adobe_style_geospatial.pdf'), 'pdf-cog', { dpi: 96, compress: 'NONE' });
  expect(j.state, j.error).toBe('succeeded');
  const ours = JSON.parse(otherGdal('gdalinfo', ['-json', j.path]));
  expect(ours.geoTransform?.[1]).toBeGreaterThan(0);
  const raw = join(s.dataDir, 'pdf.bil');
  otherGdal('gdal_translate', ['-q', '--config', 'GDAL_PDF_DPI', '96', '-of', 'ENVI', '-co', 'INTERLEAVE=BSQ', fx('adobe_style_geospatial.pdf'), raw]);
  const [w, h] = ours.size;
  const n = JSON.parse(otherGdal('gdalinfo', ['-json', raw])).bands.length;
  const m = canOracle() ? oracle('raw', j.path, raw, String(w), String(h), String(n), 'u1') : null;
  const ink = canOracle() ? oracle('ink', j.path, raw, String(w), String(h), String(n)) : null;
  const other = JSON.parse(otherGdal('gdalinfo', ['-json', fx('adobe_style_geospatial.pdf'), '--config', 'GDAL_PDF_DPI', '96']));
  const gtd = Math.max(...ours.geoTransform.map((v, i) => Math.abs(v - other.geoTransform[i])));
  record('pdf_read', { size: ours.size, poppler: m, ink, geotransform_max_diff: gtd, pixel: ours.geoTransform[1] });
  expect(gtd).toBeLessThan(ours.geoTransform[1] / 100);
  // Two renderers: hairlines and anti-aliasing differ, the page must not.
  // PDFium draws grey hairlines darker than poppler, so its ink is a superset of poppler's.
  if (ink) {
    expect(ink.b_in_a).toBeGreaterThan(0.95);
    expect(ink.a_in_b).toBeGreaterThan(0.8);
  }
  // Vector layers through the PDF driver: the same layers as poppler's build lists.
  const v = await job(frame, s, fx('adobe_style_geospatial.pdf'), 'vector-gpkg');
  expect(v.state, v.error).toBe('succeeded');
  const layers = (p) => JSON.parse(otherGdal('ogrinfo', ['-json', '-so', '-al', p])).layers.map((l) => `${l.name}:${l.featureCount}`).sort();
  const lv = layers(v.path);
  const lp = layers(fx('adobe_style_geospatial.pdf'));
  record('pdf_vector', { pdfium: lv, poppler: lp });
  expect(lv).toEqual(lp);
  const w2 = await job(frame, s, fx('ms.tif'), 'export-gdal', { driver: 'PDF', co: ['COMPRESS=DEFLATE'] });
  expect(w2.state, w2.error).toBe('succeeded');
  expect(w2.outputs[0].name).toMatch(/\.pdf$/);
  const back = JSON.parse(otherGdal('gdalinfo', ['-json', w2.path]));
  const src = JSON.parse(otherGdal('gdalinfo', ['-json', fx('ms.tif')]));
  expect(Math.abs(back.geoTransform[0] - src.geoTransform[0])).toBeLessThan(Math.abs(src.geoTransform[1]));
  record('pdf_write', { size: back.size, driver: back.driverShortName });
});

test('REQ-GAP-36 multipatch, FBX and IFC against the model parsed independently', async () => {
  test.skip(!model3d() || !canOracle(), 'no model3d module or oracle');
  const glb = fx('two_boxes.glb');
  const want = oracle('glb', glb);
  // The dialog, then the job through it.
  await files(frame, glb);
  const done = frame.evaluate(async () => {
    const r = await window.gisworkbench.commands.run('sidecar.modelexport', { file: window.__fx[0] });
    return { state: r?.state, id: r?.id, outputs: r?.outputs };
  });
  const first = frame.locator('[data-id="dialog:sidecar-modelformat"]');
  await expect(first).toBeVisible({ timeout: 30_000 });
  expect(await axe(frame, '[data-id="dialog:sidecar-modelformat"]')).toEqual([]);
  await first.locator('select').selectOption('model-ifc');
  await first.locator('button', { hasText: 'Next' }).click();
  const dlg = frame.locator('[data-id="dialog:sidecar-modelexport"]');
  await expect(dlg).toBeVisible();
  expect(await axe(frame, '[data-id="dialog:sidecar-modelexport"]')).toEqual([]);
  await dlg.locator('[data-opt="crs"]').fill('EPSG:32611');
  await dlg.locator('[data-opt="origin_x"]').fill('500000');
  await dlg.locator('[data-opt="origin_y"]').fill('4000000');
  await dlg.locator('button', { hasText: 'Run' }).click();
  const j = await done;
  expect(j.state).toBe('succeeded');
  const ifcFile = join(s.dataDir, 'outputs', j.id, j.outputs[0].name);
  const ifc = existsSync(IFC_PY) && existsSync(IFC_FULL) ? JSON.parse(execFileSync(IFC_PY, [resolve('tests', 'tools', 'gdalroutes_oracle.py'), 'ifc', ifcFile, IFC_FULL], { encoding: 'utf8', env: oracleEnv() }).trim().split('\n').pop()) : oracle('ifc', ifcFile);
  record('ifc', { want, ifc });
  expect(ifc.schema).toBe('IFC4');
  expect(ifc.triangles).toBe(want.triangles);
  expect(ifc.map_conversion).toBe(true);
  // glTF Y up → Z up: (x, y, z) → (x, −z, y).
  const [lo, hi] = want.bbox;
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-5);
  expect(near(ifc.bbox[0], [lo[0], -hi[2], lo[1]])).toBe(true);
  expect(near(ifc.bbox[1], [hi[0], -lo[2], hi[1]])).toBe(true);
  if (ifc.validator_issues !== undefined) expect(ifc.validator_issues, JSON.stringify(ifc.validator_sample)).toBe(0);

  const f = await job(frame, s, glb, 'model-fbx');
  expect(f.state, f.error).toBe('succeeded');
  const fbx = oracle('fbx', f.path);
  record('fbx', fbx);
  expect(fbx.polygons).toBe(want.triangles);

  for (const id of ['model-multipatch', 'model-multipatch-shp']) {
    const g = await job(frame, s, glb, id, { crs: 'EPSG:32611', origin_x: 500000, origin_y: 4000000, origin_z: 100 });
    expect(g.state, g.error).toBe('succeeded');
    const path = id === 'model-multipatch' ? `/vsizip/${g.path.replace(/\\/g, '/')}/model.gdb` : g.path;
    const info = JSON.parse(otherGdal('ogrinfo', ['-json', '-so', '-al', path]));
    const l = info.layers[0];
    record(id, { type: l.geometryFields[0].type, features: l.featureCount, extent: l.geometryFields[0].extent, driver: info.driverShortName });
    // A shapefile's layer says only Geometry: its features say what they are.
    expect(otherGdal('ogrinfo', ['-ro', '-al', path])).toContain('TIN Z (((');
    expect(l.featureCount).toBe(2);
    const e = l.geometryFields[0].extent;
    expect(Math.abs(e[0] - (500000 + lo[0]))).toBeLessThan(1e-3);
    expect(Math.abs(e[1] - (4000000 - hi[2]))).toBeLessThan(1e-3);
  }
});

test('refusals by name: a file that is not a model, and one that is not a geodatabase', async () => {
  test.skip(!model3d(), 'no model3d module');
  const j = await job(frame, s, fx('ms.tif'), 'model-fbx');
  expect(j.state).toBe('error');
  expect(j.error).toMatch(/not a 3D model Assimp can read/);
  await files(frame, fx('ms.tif'));
  // A command's error reaches the user as a toast; the toasts on screen are capped, so read the call.
  const said = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const toast = app.toast;
    const seen = [];
    app.toast = (m, o) => (seen.push(String(m)), toast.call(app, m, o));
    await app.commands.run('sidecar.gdbcatalog', { file: window.__fx[0] });
    app.toast = toast;
    return seen;
  });
  expect(said.join(' | ')).toMatch(/ms\.tif is not a File Geodatabase/);
});
