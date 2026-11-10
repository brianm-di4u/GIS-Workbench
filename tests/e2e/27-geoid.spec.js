// REG-024 SCN-71 on the built file: with the EGM2008 2.5′ pack loaded, the active geoid
// (app.core.undulation, which MSL heights, DEM conversions and the readout use) is the cubic
// interpolation: against GeographicLib GeoidEval's cubic on its own 2.5′ grid, RMS under 1 mm at
// random points, and under 1 cm at worst across ±180°, the poles and Everest, where two cubic
// schemes differ most (tests/golden/geoid.test.js). The Datum Transform route says it is cubic.
// The EGM2008 1′ pack (geoid-egm2008-1, 80 MB of 5° tiles) takes over as the active geoid and
// EGM2008 height grid, within 1 mm of GeoidEval on GeographicLib's 1′ grid, and gives way to
// EGM96 when it is forgotten.
import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles, DIST_DIR } from './helpers.js';
import { haveGeoidEval, geoidEval, randomPoints } from '../tools/geoideval.mjs';

const PACKS = join(DIST_DIR, 'packs');
// The pack from this build, else GW_GEOID_PACK (a geoid-egm2008-25 .gwpack from another build).
const built = (re) => (existsSync(PACKS) && readdirSync(PACKS).map((n) => join(PACKS, n)).find((p) => re.test(p))) || '';
const PACK = built(/geoid-egm2008-25-.*\.gwpack$/) || process.env.GW_GEOID_PACK || '';
const PACK1 = built(/geoid-egm2008-1-.*\.gwpack$/) || process.env.GW_GEOID1_PACK || '';
test.describe.configure({ timeout: 300000 });

test('SCN-71 REG-024 EGM2008 2.5′ heights are cubic, against GeographicLib GeoidEval', async ({ page }) => {
  test.skip(!PACK || !existsSync(PACK) || !haveGeoidEval('egm2008-2_5'), 'needs the geoid-egm2008-25 pack and GeoidEval with egm2008-2_5 (tests/tools/geoideval.mjs)');
  const pts = [...randomPoints(200, 11), [0.5, 179.99], [-60, -179.99], [89.99, 10], [-89.99, -170], [27.9881, 86.925], [-33.8568, 151.2153]];
  const ref = geoidEval('egm2008-2_5', pts);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [PACK]);
  await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 2.5′', null, { timeout: 180000 });
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const n = pts.map(([la, lo]) => app.core.undulation(la, lo));
    const t = await app.datumTransform({ src: 'WGS 84 (G2296)', tgt: 'WGS 84 (G2296)', srcHeight: 'egm2008', tgtHeight: 'hae', pts: pts.slice(0, 20).map(([la, lo]) => [lo, la, 100]) });
    return { n, h: t.pts.map((p) => p[2]), steps: t.steps.filter((s) => s.kind === 'grid').map((s) => s.interpolation) };
  }, pts);
  const d = r.n.map((v, i) => Math.abs(v - ref[i]));
  const worst = Math.max(...d);
  const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
  console.log(`SCN-71 EGM2008 2.5′ in the app vs GeoidEval at ${pts.length} points: RMS ${(rms * 1000).toFixed(2)} mm, worst ${(worst * 1000).toFixed(2)} mm`);
  expect(rms).toBeLessThan(0.001);
  expect(worst).toBeLessThan(0.01);
  // The dialog's route gives the same heights (H + N) and names its interpolation.
  r.h.forEach((hh, i) => expect(Math.abs(hh - 100 - r.n[i])).toBeLessThan(1e-9));
  expect(r.steps).toEqual(['cubic']);
  expect(logs).toEqual([]);
});

test('SCN-71 REG-024 EGM2008 1′ pack: the active geoid a tile at a time, within 1 mm of GeoidEval', async ({ page }) => {
  test.skip(!PACK1 || !existsSync(PACK1) || !haveGeoidEval('egm2008-1'), 'needs the geoid-egm2008-1 pack and GeoidEval with egm2008-1 (tests/tools/geoideval.mjs)');
  // Random points, tile corners at multiples of 5° (just either side) and ±180°; not the cell next
  // to a pole, where GeographicLib's polar stencil differs by up to 1.9 mm (tests/golden/geoid.test.js).
  const pts = [...randomPoints(300, 13), [0.5, 179.999], [0.5, -179.999], [35, -5 - 1e-7], [35 - 1e-7, -5], [-60, 0], [27.9881, 86.925], [89.9, 45], [-89.9, -45]];
  const ref = geoidEval('egm2008-1', pts);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [PACK1]);
  await frame.waitForFunction(() => window.gisworkbench.core.geoidName === 'EGM2008 1′', null, { timeout: 180000 });
  const r = await frame.evaluate(async (pts) => {
    const app = window.gisworkbench;
    const n = pts.map(([la, lo]) => app.core.undulation(la, lo));
    const t = await app.datumTransform({ src: 'WGS 84 (G2296)', tgt: 'WGS 84 (G2296)', srcHeight: 'egm2008', tgtHeight: 'hae', pts: pts.slice(0, 10).map(([la, lo]) => [lo, la, 100]) });
    const vd = document.querySelector('[data-id="status:vdatum"]')?.textContent;
    await app.packs.forget('geoid-egm2008-1');
    return { n, h: t.pts.map((p) => p[2]), steps: t.steps.filter((s) => s.kind === 'grid').map((s) => `EPSG:${s.epsg} ${s.grid} ${s.interpolation}`), vd, after: app.core.geoidName };
  }, pts);
  const d = r.n.map((v, i) => Math.abs(v - ref[i]));
  const worst = Math.max(...d);
  console.log(`SCN-71 EGM2008 1′ in the app vs GeoidEval at ${pts.length} points: worst ${(worst * 1000).toFixed(3)} mm`);
  expect(worst).toBeLessThanOrEqual(0.00105);
  r.h.forEach((hh, i) => expect(Math.abs(hh - 100 - r.n[i])).toBeLessThan(1e-9));
  expect(r.steps).toEqual(['EPSG:3859 geoid-egm2008-1 cubic']);
  expect(r.vd).toBe('MSL(EGM2008 1′)');
  expect(r.after).toBe('EGM96');
  expect(logs).toEqual([]);
});
