// Hydrology (2.7.0 I3, REQ-GAP-80, SDP-2.7 §4.2) on the built file, through the Surface ▸ Hydrology
// commands. The oracle is WhiteboxTools 2.3.0 run offline (tests/tools/hydro_oracle.py) on the same
// DEM crop of the USGS 3DEP 1 m DRCOG 2020 tile x48y441 (Golden, CO; UTM 13N):
// - fixtures/hydro: the crop averaged to 5 m (runs everywhere);
// - SCN-68: the crop at 1 m, cut from the T&E corpus at test time (runs where the corpus and the
//   gw-te GDAL are). The app resamples the projected DEM to its geographic terrain grid, so the
//   watershed is compared by area and outlet, not post by post (tests/golden/hydro.test.js does that).
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openApp, openFiles } from './helpers.js';

const FX = (n) => resolve('fixtures/hydro', n);
const truth5 = JSON.parse(readFileSync(FX('truth.json'), 'utf8'));
const truth1 = JSON.parse(readFileSync(FX('scn68.json'), 'utf8'));
const TILE = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'usgs-3dep-1m-x48y441-drcog2020', 'USGS_1M_13_x48y441_CO_DRCOG_2020_B20.tif');
const GWTE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const haveTe = existsSync(`${GWTE}/Library/bin/gdalwarp.exe`) && existsSync(TILE);
const TMP = mkdtempSync(join(tmpdir(), 'gw27hydro-'));
test.describe.configure({ timeout: 600000 });
test.afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** Open a DEM, use it as terrain, and record the hydro worker's progress phases. */
async function openDem(page, file) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [file]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 120000 });
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    await app.useAsTerrain([...app.layers.values()][0], 'egm96');
    window.__phases = [];
    const run = app.pool.run.bind(app.pool);
    app.pool.run = (op, args, opts = {}) => (op === 'hydro.run' ? run(op, args, { ...opts, onProgress: (p, part) => (window.__phases.push(part?.phase), opts.onProgress?.(p, part)) }) : run(op, args, opts));
  });
  return { frame, logs };
}

/** Screen position (page coordinates) of a ground point in the active panel, scrolled into view. */
async function screenOf(frame, lat, lon) {
  return frame.evaluate(([la, lo]) => {
    const p = window.gisworkbench.activePane();
    const q = p.geoLayer().imageAt(la, lo, 0);
    p.setView({ cx: q.x, cy: q.y, zoom: p.view.zoom, rot: 0, mode: 'native' });
    const s = p.screenPoint(q.x, q.y);
    const r = p.el.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [lat, lon]);
}

/** Watershed through the command: the dialog, then a click on the pour point. */
async function watershedByCommand(page, frame, pour, snap) {
  void frame.evaluate(() => window.gisworkbench.commands.run('hydro.watershed'));
  const dlg = frame.locator('[data-id="dialog:hydro-watershed"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Snap distance (m)').fill(String(snap));
  await dlg.locator('.btn-primary').click();
  await expect(dlg).toBeHidden();
  const s = await screenOf(frame, pour.lat, pour.lon);
  await page.mouse.click(s.x, s.y);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').some((v) => v.source?.format === 'hydrology' && v.fields.some((f) => f.name === 'AREA_M2')), null, { timeout: 300000 });
  return frame.evaluate(() => {
    const S = window.gisworkbench.store;
    const v = S.all('vlayer').find((x) => x.source?.format === 'hydrology' && x.fields.some((f) => f.name === 'AREA_M2'));
    const f = S.all('feature').filter((x) => x.vlayer === v.id);
    return { name: v.name, features: f.length, attrs: f[0]?.attrs };
  });
}

/** Stream network through the command, with a threshold in km². */
async function streamsByCommand(frame, km2) {
  void frame.evaluate(() => window.gisworkbench.commands.run('hydro.streams'));
  const dlg = frame.locator('[data-id="dialog:hydro-streams"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Minimum contributing area (km²)').fill(String(km2));
  await dlg.locator('.btn-primary').click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').some((v) => v.source?.format === 'hydrology' && v.fields.some((f) => f.name === 'STRAHLER')), null, { timeout: 300000 });
  return frame.evaluate(() => {
    const S = window.gisworkbench.store;
    const v = S.all('vlayer').find((x) => x.source?.format === 'hydrology' && x.fields.some((f) => f.name === 'STRAHLER'));
    const f = S.all('feature').filter((x) => x.vlayer === v.id);
    return { links: f.length, maxOrder: Math.max(...f.map((x) => x.attrs.STRAHLER)), maxShreve: Math.max(...f.map((x) => x.attrs.SHREVE)), length: f.reduce((a, x) => a + x.attrs.LENGTH_M, 0) };
  });
}

/** For each oracle stream post in `sample`, the distance (m) to the nearest vertex of our stream lines. */
const streamOffsets = (frame, sample) =>
  frame.evaluate((pts) => {
    const S = window.gisworkbench.store;
    const v = S.all('vlayer').find((x) => x.source?.format === 'hydrology' && x.fields.some((f) => f.name === 'STRAHLER'));
    const xyz = S.all('feature').filter((x) => x.vlayer === v.id).flatMap((f) => Array.from(f.geom.xyz));
    const k = 111320 * Math.cos((pts[0][0] * Math.PI) / 180);
    return pts
      .map(([la, lo]) => {
        let m = Infinity;
        for (let i = 0; i < xyz.length; i += 3) m = Math.min(m, ((xyz[i + 1] - la) * 110950) ** 2 + ((xyz[i] - lo) * k) ** 2);
        return Math.sqrt(m);
      })
      .sort((a, b) => a - b);
  }, sample);
const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];

const metresBetween = (frame, a, b) => frame.evaluate(([p, q]) => window.gisworkbench.core.inverse(p.lat, p.lon, q.lat, q.lon).distance, [a, b]);

test('REQ-GAP-80 hydrology commands on the 5 m fixture: watershed and streams match WhiteboxTools; fill and flow make layers; progress per stage; refusal above 48 M posts', async ({ page }) => {
  const { frame, logs } = await openDem(page, FX('dem.tif'));
  const ws = await watershedByCommand(page, frame, truth5.pour, truth5.pour.snap_m);
  const area = ws.attrs.AREA_M2;
  console.log(JSON.stringify({ fixture: '5 m', area, oracle: truth5.watershed.area_m2, outlet: [ws.attrs.OUTLET_LAT, ws.attrs.OUTLET_LON] }));
  expect(Math.abs(area - truth5.watershed.area_m2) / truth5.watershed.area_m2).toBeLessThan(0.03);
  expect(await metresBetween(frame, { lat: ws.attrs.OUTLET_LAT, lon: ws.attrs.OUTLET_LON }, truth5.snapped)).toBeLessThan(15);
  expect(ws.features).toBeGreaterThanOrEqual(1);
  expect(await frame.evaluate(() => window.__phases)).toEqual(expect.arrayContaining(['fill', 'd8', 'accumulate', 'watershed', 'done']));

  const st = await streamsByCommand(frame, truth5.streams.area_m2 / 1e6);
  const { sample: _s5, ...oracle5 } = truth5.streams;
  console.log(JSON.stringify({ fixture: '5 m', streams: st, oracle: oracle5 }));
  // The app resamples the projected DEM to its geographic grid, so the network is held by position,
  // length and highest order (post-for-post order is in tests/golden/hydro.test.js).
  const off5 = await streamOffsets(frame, truth5.streams.sample);
  console.log(JSON.stringify({ fixture: '5 m', streamOffsetP90: q(off5, 0.9), lengthRatio: st.length / truth5.streams.length_m }));
  expect(q(off5, 0.9)).toBeLessThan(10);
  expect(Math.abs(st.length / truth5.streams.length_m - 1)).toBeLessThan(0.15);
  expect(st.maxOrder).toBe(truth5.streams.max_strahler);
  expect(Math.abs(st.maxShreve - truth5.streams.max_shreve)).toBeLessThanOrEqual(1);

  // Fill Sinks and Flow Accumulation make their layers.
  for (const [id, re, sel] of [['hydro.fill', /^FILLED_/, null], ['hydro.flow', /^FLOWACC_DINF_/, 'dinf']]) {
    void frame.evaluate((c) => window.gisworkbench.commands.run(c), id);
    const dlg = frame.locator(`[data-id="dialog:${id.replace('.', '-')}"]`);
    await expect(dlg).toBeVisible();
    if (sel) await dlg.getByLabel('Flow model').selectOption(sel);
    await dlg.locator('.btn-primary').click();
    await frame.waitForFunction((src) => [...window.gisworkbench.layers.values()].some((l) => new RegExp(src).test(l.rec.name)), re.source, { timeout: 120000 });
  }
  expect(await frame.evaluate(() => window.__phases)).toContain('dinf');
  expect(await frame.evaluate(() => window.gisworkbench.terrain.dems.some((d) => /FILLED_/.test(d.name)))).toBe(true);

  // Refused by name before the heights are copied.
  const refusal = await frame.evaluate(async () => {
    try {
      await window.gisworkbench.hydrology.run({}, { name: 'huge', grid: { width: 7000, height: 7000, lat0: 40, lon0: -105, dlat: 1e-5, dlon: 1e-5 } });
      return null;
    } catch (e) {
      return e.message;
    }
  });
  expect(refusal).toMatch(/48 million posts/);
  expect(logs).toEqual([]);
});

test('SCN-68 REQ-GAP-80 watershed and streams from a 1 m DEM and a gauge point, against WhiteboxTools', async ({ page }) => {
  test.skip(!haveTe, 'needs the T&E corpus tile and the gw-te GDAL');
  const dem = join(TMP, 'drcog_1m_crop.tif');
  const env = { ...process.env, PROJ_DATA: `${GWTE}/Library/share/proj`, GDAL_DATA: `${GWTE}/Library/share/gdal` };
  execFileSync(`${GWTE}/Library/bin/gdalwarp.exe`, ['-q', '-te', ...truth1.window.map(String), '-tr', '1', '1', '-r', 'near', '-ot', 'Float32', '-co', 'COMPRESS=DEFLATE', TILE, dem], { env });
  const { frame, logs } = await openDem(page, dem);
  const posts = await frame.evaluate(() => {
    const g = window.gisworkbench.terrain.dems[0].grid;
    return [g.width, g.height];
  });
  const t0 = Date.now();
  const ws = await watershedByCommand(page, frame, truth1.pour, truth1.pour.snap_m);
  const wsMs = Date.now() - t0;
  const area = ws.attrs.AREA_M2;
  const outletOff = await metresBetween(frame, { lat: ws.attrs.OUTLET_LAT, lon: ws.attrs.OUTLET_LON }, truth1.snapped);
  const st = await streamsByCommand(frame, truth1.streams.area_m2 / 1e6);
  const off = await streamOffsets(frame, truth1.streams.sample);
  const { sample: _s1, ...oracleStreams } = truth1.streams;
  console.log(JSON.stringify({ scn: 'SCN-68', terrainPosts: posts, area, oracleArea: truth1.watershed.area_m2, outletOff, wsMs, streams: st, oracleStreams, streamOffsetP50: q(off, 0.5), streamOffsetP90: q(off, 0.9), lengthRatio: st.length / truth1.streams.length_m }));
  expect(Math.abs(area - truth1.watershed.area_m2) / truth1.watershed.area_m2).toBeLessThan(0.02);
  expect(outletOff).toBeLessThan(5);
  // Streams: by position and length. Flats are routed differently (priority-flood epsilon here,
  // fix_flats there), which moves where some tributaries join, so the highest Strahler order may
  // differ by one (WhiteboxTools 2.3.0 also reports order 4 on 3 posts of a network whose Shreve
  // magnitude is 4, which a tree cannot have: on its own D8 pointer the order is 3).
  expect(q(off, 0.9)).toBeLessThan(5);
  expect(Math.abs(st.length / truth1.streams.length_m - 1)).toBeLessThan(0.15);
  expect(Math.abs(st.maxOrder - 3)).toBeLessThanOrEqual(1);
  expect(logs).toEqual([]);
});
