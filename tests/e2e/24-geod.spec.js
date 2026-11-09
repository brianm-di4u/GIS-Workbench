// REQ-GAP-16 (GR-05) end to end: the 2.4 grid packs in the built app. grids-eu and EGM2008 2.5′:
// the active geoid from the grid (Catmull-Rom, against GeographicLib GeoidEval; REG-024), OSGB36 maps through OSTN15 (crs.js grid
// route, the model note naming transform, grid and accuracy), the PROJ pack given the same grid
// (PROJ-WASM against geod in the browser), and the Datum Transform dialog (ODN heights by
// OSGM15, report, axe). grids-na: the NADCON5 chain and the Canadian NTv2 fallback against cct.
// Hosted copy: a grid pack kept in OPFS comes back after a reload without a prompt.
import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { openApp, openFiles, servers, DIST, DIST_DIR, restart } from './helpers.js';
import { haveGeoidEval, geoidEval } from '../tools/geoideval.mjs';

const PACKS = resolve(DIST_DIR, 'packs');
const pk = (n) => {
  const f = existsSync(PACKS) ? readdirSync(PACKS).find((x) => x.startsWith(`${n}-`) && x.endsWith('.gwpack')) : null;
  return f ? resolve(PACKS, f) : null;
};
const ENV = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const BIN = `${ENV}/Library/bin`;
const GRIDS = resolve('.cache/packs-src/grids');
const haveCct = existsSync(`${BIN}/cct.exe`) && existsSync(GRIDS);
const MM = 1e-3;

/** Run cct on [x, y, z] rows; null for rows PROJ rejects. */
function cct(args, rows) {
  const out = execFileSync(`${BIN}/cct.exe`, ['-d', '12', ...args], { input: rows.map((r) => r.join(' ')).join('\n') + '\n', env: { ...process.env, PROJ_DATA: `${ENV}/Library/share/proj;${GRIDS}`, PROJ_NETWORK: 'OFF' }, encoding: 'utf8' });
  const res = [];
  const lines = out.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (lines[i].startsWith('#')) {
      res.push(null);
      if (lines[i + 1]?.startsWith(' (')) i++;
      continue;
    }
    res.push(lines[i].trim().split(/\s+/).slice(0, 3).map(Number));
  }
  return res;
}
const deg = (g) => ['+proj=pipeline', '+step', '+proj=unitconvert', '+xy_in=deg', '+xy_out=rad', ...g, '+step', '+proj=unitconvert', '+xy_in=rad', '+xy_out=deg'];
const horiz = (a, b) => Math.hypot((a[1] - b[1]) * 111_320, (a[0] - b[0]) * 111_320 * Math.cos((b[1] * Math.PI) / 180));

test.describe.configure({ timeout: 600_000 });

test('REQ-GAP-16 grids-eu + EGM2008 2.5′: geoid, OSTN15 maps, PROJ pack with the grid, Datum Transform dialog (axe)', async ({ page }) => {
  test.skip(!pk('grids-eu') || !pk('geoid-egm2008-25') || !haveCct, 'needs the grid packs in the build and the gw-te PROJ');
  const { frame, logs } = await openApp(page, 'file');
  const geoidPts = [[-0.1276, 51.5072, 0], [86.925, 27.9881, 0], [-77.0353, 38.8895, 0], [151.2153, -33.8568, 0], [179.99, 0.5, 0], [-179.99, -60, 0], [0, 89.9, 0], [10.5, -89.9, 0]];
  // EGM2008 2.5′ is cubic (REG-024): GeoidEval's cubic on GeographicLib's grid agrees within 3 mm.
  // Without GeoidEval, PROJ's bilinear value bounds it by bilinear's own worst error (13.5 cm).
  const geoidEvalRef = haveGeoidEval('egm2008-2_5');
  const egmRef = geoidEvalRef ? geoidEval('egm2008-2_5', geoidPts.map(([lo, la]) => [la, lo])) : cct(deg(['+step', '+proj=vgridshift', '+grids=us_nga_egm08_25.tif', '+multiplier=1']), geoidPts).map((v) => v[2]);
  const egmTol = geoidEvalRef ? 3 * MM : 0.135;
  // OSGM15 (ODN) and OSTN15 at points in Great Britain (ETRS89 / OSGB36 lon, lat).
  const gb = [[-0.1276, 51.5072, 50], [-3.1883, 55.9533, 120], [-5.7, 50.07, 10], [-1.5, 53.8, 200]];
  const osgmRef = cct(deg(['+step', '+inv', '+proj=vgridshift', '+grids=uk_os_OSGM15_GB.tif', '+multiplier=1']), gb).map((v) => v[2]);
  await openFiles(frame, [pk('grids-eu'), pk('geoid-egm2008-25'), pk('proj')]);
  await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 2.5′' && window.gisworkbench.grids.has('uk_os_OSTN15_NTv2_OSGBtoETRS'), null, { timeout: 180_000 });
  const r = await frame.evaluate(async ({ geoidPts, gb }) => {
    const app = window.gisworkbench;
    const n = geoidPts.map(([lo, la]) => app.core.undulation(la, lo));
    const vd = document.querySelector('[data-id="status:vdatum"]')?.textContent;
    // EPSG:27700 (British National Grid) now converts through OSTN15.
    const c = app.crs.crsOf({ epsg: 27700 });
    const conv = c.conv;
    const E = 530_000;
    const N = 180_000;
    const ll = conv.toLonLat(E, N);
    const back = conv.fromLonLat(ll[0], ll[1]);
    // The same point by PROJ-WASM (the PROJ pack) with the OSTN15 grid mounted, OSGB36 → ETRS89.
    await app.proj.ensure();
    const projLL = (await app.proj.transform('EPSG:27700', 'EPSG:4258', [[E, N, 0]]))[0];
    const proj4LL = conv.local.forward([E, N]);
    const ours = await app.datumTransform({ src: 'grid:OSGB36', tgt: 'ETRF2014', pts: [[proj4LL[0], proj4LL[1], 0]] });
    await app.useEgm96();
    return { n, vd, grid: c.grid, note: c.note.name, acc: c.note.acc, steps: c.note.routes[0].steps.map((s) => `EPSG:${s.epsg}`), back: [back[0] - E, back[1] - N], ll, projLL, oursETRS: ours.pts[0], oursSteps: ours.steps.map((s) => s.epsg), mounted: [...app.proj.grids], name: app.core.geoidName };
  }, { geoidPts, gb });
  r.n.forEach((v, i) => expect(Math.abs(v - egmRef[i]), `EGM2008 2.5′ N at ${geoidPts[i]}`).toBeLessThanOrEqual(egmTol));
  expect(r.vd).toBe('MSL(EGM2008 2.5′)');
  expect(r.name).toBe('EGM96');
  expect(r.grid).toBe(true);
  expect(r.note).toMatch(/OSGB36 → WGS 84 \(G2296\) by grid \(uk_os_OSTN15_NTv2_OSGBtoETRS\.tif\)/);
  expect(r.steps[0]).toBe('EPSG:7709');
  expect(r.acc).toBeGreaterThan(0.1);
  expect(r.acc).toBeLessThan(0.2);
  expect(Math.hypot(...r.back)).toBeLessThan(MM);
  expect(r.mounted).toContain('uk_os_OSTN15_NTv2_OSGBtoETRS.tif');
  expect(r.oursSteps[0]).toBe(7709);
  // PROJ-WASM (OSTN15 mounted) and geod agree on OSGB36 → ETRS89.
  expect(horiz(r.oursETRS, r.projLL), `PROJ ${r.projLL} vs geod ${r.oursETRS}`).toBeLessThan(MM);

  // ---- Datum Transform dialog: ETRS89 (ETRF2014) with ODN heights → ETRS89 ellipsoidal ----
  // The command resolves when the dialog closes: start it without waiting.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('geo.transform');
  });
  const dlg = frame.locator('[data-id="datum-transform"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Source system').first().selectOption('ETRF2014');
  await dlg.getByLabel('Source heights').first().selectOption('odn');
  await dlg.getByLabel('Target system').first().selectOption('ETRF2014');
  await dlg.getByLabel('Target heights').first().selectOption('hae');
  await frame.locator('[data-id="datum-points"]').fill(gb.map(([lo, la, hh]) => `${la} ${lo} ${hh}`).join('\n'));
  await expect(frame.locator('[data-id="datum-report"]')).toContainText('uk_os_OSGM15_GB.tif', { timeout: 20_000 });
  await expect(frame.locator('[data-id="datum-report"]')).toContainText('EPSG:7713');
  await expect(frame.locator('[data-id="datum-accuracy"]')).toContainText('0.02');
  const heights = await frame.evaluate(async (gb) => (await window.gisworkbench.datumTransform({ src: 'ETRF2014', tgt: 'ETRF2014', srcHeight: 'odn', pts: gb })).pts.map((p) => p[2]), gb);
  // H → h is h = H + N; cct gives H = h − N for h = the same numbers, so N = h − H.
  heights.forEach((hh, i) => expect(Math.abs(hh - gb[i][2] - (gb[i][2] - osgmRef[i])), `ODN point ${i}`).toBeLessThanOrEqual(MM));
  const cells = await frame.locator('[data-id="datum-results"] td').allTextContents();
  expect(cells.length).toBe(4 * gb.length);
  // A point outside OSGM15 is reported, not guessed.
  await frame.locator('[data-id="datum-points"]').fill('40 -30 0');
  await expect(frame.locator('[data-id="datum-results"]')).toContainText('outside the grids');
  // axe on the dialog
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('[data-id="dialog:datum-transform"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary}`).slice(0, 5).join(', ')}`));
  expect(v).toEqual([]);
  await page.keyboard.press('Escape');
  expect(logs).toEqual([]);
});

test('REQ-GAP-16 grids-na: NADCON5 NAD27 → NAD83(2011) chain and the Canadian NTv2 fallback agree with PROJ cct', async ({ page }) => {
  test.skip(!pk('grids-na') || !haveCct, 'needs grids-na in the build and the gw-te PROJ');
  const { frame, logs } = await openApp(page, 'file');
  const us = [[-77.0353, 38.8895, 10], [-122.4194, 37.7749, 50], [-104.99, 39.74, 1600], [-90.07, 29.95, 2]];
  // Canadian points outside the NADCON5 CONUS grid (where both cover, NADCON5 comes first, as
  // PROJ cs2cs EPSG:4267 → EPSG:4269 also picks it at Toronto).
  const ca = [[-113.49, 53.55, 0], [-114.07, 51.05, 0], [-52.71, 47.56, 0]];
  const nad5 = ['us_noaa_nadcon5_nad27_nad83_1986_conus', 'us_noaa_nadcon5_nad83_1986_nad83_harn_conus', 'us_noaa_nadcon5_nad83_harn_nad83_fbn_conus', 'us_noaa_nadcon5_nad83_fbn_nad83_2007_conus', 'us_noaa_nadcon5_nad83_2007_nad83_2011_conus'].flatMap((g) => ['+step', '+proj=gridshift', `+grids=${g}.tif`]);
  const usRef = cct(deg(nad5), us);
  const caRef = cct(deg(['+step', '+proj=hgridshift', '+grids=ca_nrc_ntv2_0.tif']), ca);
  const geoidRef = cct(deg(['+step', '+inv', '+proj=vgridshift', '+grids=us_noaa_g2018u0.tif', '+multiplier=1']), us).map((v) => v[2]);
  await openFiles(frame, [pk('grids-na')]);
  await frame.waitForFunction(() => window.gisworkbench.grids.has('us_noaa_nadcon5_nad27_nad83_1986_conus'), null, { timeout: 300_000 });
  const r = await frame.evaluate(async ({ us, ca }) => {
    const app = window.gisworkbench;
    const a = await app.datumTransform({ src: 'grid:NAD27', tgt: 'NAD83(2011)', pts: us });
    const b = app.grids.transformDatum('NAD27', ca);
    const n = await app.datumTransform({ src: 'NAD83(2011)', tgt: 'NAD83(2011)', srcHeight: 'hae', tgtHeight: 'navd88', pts: us });
    const c = app.crs.crsOf({ epsg: 26717 });
    return { a: a.pts, aSteps: a.steps.map((s) => s.epsg), b: b.pts, used: b.used, n: n.pts.map((p) => p[2]), note: c.note.name, acc: c.note.acc };
  }, { us, ca });
  r.a.forEach((p, i) => {
    expect(horiz(p, usRef[i]), `NADCON5 chain point ${i}`).toBeLessThan(MM);
    expect(Math.abs(p[2] - usRef[i][2]), `NADCON5 ellipsoidal height point ${i}`).toBeLessThan(MM);
  });
  expect(r.aSteps.slice(0, 5)).toEqual([8555, 8556, 8861, 8862, 8559]);
  // Canada: outside NADCON5, the ntv2_0 chain (EPSG:1693, to WGS 84) applies.
  expect(r.used).toEqual([1, 1, 1]);
  r.b.forEach((p, i) => expect(horiz(p, caRef[i]), `NTv2 point ${i}`).toBeLessThan(MM));
  r.n.forEach((hh, i) => expect(Math.abs(hh - geoidRef[i]), `GEOID18 point ${i}`).toBeLessThanOrEqual(MM));
  expect(r.note).toMatch(/NAD27 → WGS 84 \(G2296\) by grid/);
  expect(r.acc).toBeGreaterThan(0.3);
  expect(r.acc).toBeLessThan(0.4);
  expect(logs).toEqual([]);
});

test('REQ-GAP-16 hosted copy: the EGM2008 2.5′ pack is kept in OPFS and comes back after a reload without a prompt', async ({ page }) => {
  test.skip(!pk('geoid-egm2008-25'), 'needs geoid-egm2008-25 in the build');
  const srv = await servers(DIST);
  try {
    const { frame } = await openApp(page, 'http', { srv });
    await openFiles(frame, [pk('geoid-egm2008-25')]);
    await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 2.5′', null, { timeout: 180_000 });
    const kept = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const s = app.packs.stored.get('geoid-egm2008-25');
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('gw-packs');
      const f = await (await dir.getFileHandle('geoid-egm2008-25.gwpack')).getFile();
      return { opfs: !!s?.opfs, size: f.size };
    });
    expect(kept.opfs).toBe(true);
    expect(kept.size).toBeGreaterThan(80e6);
    await restart(page);
    await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 2.5′', null, { timeout: 180_000 });
    const n = await frame.evaluate(() => window.gisworkbench.core.undulation(51.5072, -0.1276));
    expect(n).toBeGreaterThan(45);
    expect(n).toBeLessThan(47);
    await frame.evaluate(() => window.gisworkbench.packs.forget('geoid-egm2008-25'));
  } finally {
    await srv.close();
  }
});

