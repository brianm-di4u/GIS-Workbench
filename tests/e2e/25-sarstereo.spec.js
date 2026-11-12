// 2.5 gap wave T0b, group sarstereo (GR-15): REQ-GAP-42 SAR stereo terrain on FX-25 — two
// synthetic SICD chips on the geometry of the Umbra Hetch Hetchy 10° pair (SARkit writer and
// projections, build/fixtures/fx25-sarstereo.py), a GLO-30-like prior 3 m high and the truth DEM.
// * the stereo pair finder: same side, about 10°, parallax about 0.55 m per m;
// * the DSM: posts matched about the prior, the steep ridge masked (layover), heights against the
//   truth (the accuracy report), and the product opened as terrain with its four bands;
// * levelling on the prior moves the heights onto the prior's +3 m;
// * the dialogs (pair finder, DSM, report) pass axe, and the DSM runs from them.
// Real pairs (Umbra, Capella) are measured in tests/campaign/c61-sar-stereo.spec.js.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';

const FX = resolve('fixtures/fx25/sarstereo');
const truth = JSON.parse(readFileSync(resolve(FX, 'fx25_sarstereo_truth.json'), 'utf8'));
const FILES = ['fx25_sarstereo_a.nitf', 'fx25_sarstereo_b.nitf', 'fx25_sarstereo_prior.tif', 'fx25_sarstereo_truth.tif'].map((f) => resolve(FX, f));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axeOn(frame, sel) {
  return frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });
}

async function setup(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, FILES);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 4, null, { timeout: 120000 });
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    for (const l of [...app.layers.values()].filter((x) => /prior|truth/.test(x.rec.name))) await app.useAsTerrain(l, 'hae');
  });
  await frame.evaluate(axeSource);
  return { frame, logs };
}

test('REQ-GAP-42 FX-25 SAR stereo: pair finder, radargrammetric DSM with masks, accuracy against the truth', async ({ page }) => {
  test.setTimeout(600000);
  const { frame, logs } = await setup(page);
  const r = await frame.evaluate(async (c) => {
    const app = window.gisworkbench;
    const all = [...app.layers.values()];
    const [A, B] = ['_a', '_b'].map((s) => all.find((l) => l.rec.name.includes(`sarstereo${s}`)));
    const te = (re) => app.terrain.dems.find((d) => re.test(d.name));
    const prior = te(/prior/);
    const tr = te(/truth/);
    const enabled = ['sar.stereopairs', 'sar.stereodsm', 'sar.stereoreport'].map((id) => app.commands.enabled(id));
    const pairs = await app.sarStereo.findPairs([A, B]);
    const kn = 111132.954 - 559.822 * Math.cos((2 * c.lat * Math.PI) / 180);
    const ke = 111412.84 * Math.cos((c.lat * Math.PI) / 180);
    const aoi = { north: c.lat + 150 / kn, south: c.lat - 150 / kn, west: c.lon - 150 / ke, east: c.lon + 150 / ke };
    const t0 = performance.now();
    const dsm = await app.sarStereo.extract(A, B, { aoi, postM: 4, levels: 2, shiftM: 8, prior });
    const ms = Math.round(performance.now() - t0);
    const vsTruth = app.sarStereo.report(dsm, tr);
    const vsPrior = app.sarStereo.report(dsm, prior);
    // The ridge's posts (inside its footprint) are masked.
    const g = dsm.grid;
    let ridge = 0;
    let ridgeMasked = 0;
    for (let j = 0; j < g.ny; j++)
      for (let i = 0; i < g.nx; i++) {
        const e = (g.lon0 + i * g.dlon - c.lon) * ke;
        const n = (g.lat0 - j * g.dlat - c.lat) * kn;
        if (Math.abs(e - c.ridge.eastM) < c.ridge.halfWidthM * 0.8 && Math.abs(n - c.ridge.northM) < c.ridge.halfLengthM * 0.8) {
          ridge++;
          if (dsm.flags[j * g.nx + i] & 15) ridgeMasked++;
        }
      }
    const anch = await app.sarStereo.extract(A, B, { aoi, postM: 4, levels: 2, shiftM: 8, prior, anchor: true });
    const anchPrior = app.sarStereo.report(anch, prior);
    const anchTruth = app.sarStereo.report(anch, tr);
    // REG-084: the anchored DSM, levelled on the (biased) prior, levelled again on the truth.
    const lev = await app.sarStereo.level(anch, tr);
    const levTruth = app.sarStereo.report(lev.dsm, tr);
    // A DSM read back from a terrain has heights only (no σ, score or flags): it levels and saves too.
    const pg = prior.grid;
    const bare = await app.sarStereo.level({ grid: { lat0: pg.lat0, lon0: pg.lon0, dlat: pg.dlat, dlon: pg.dlon, nx: pg.width, ny: pg.height }, heights: prior.current ?? pg.heights, sigma: null, flags: null, names: [prior.name], stats: null }, tr).then((x) => x.layer.bands, (e) => e.message);
    // A DEM with orthometric (EGM96) heights levels on the ellipsoid: the truth as H = h − N levels
    // on the truth by about 0, not by the geoid separation N.
    const tg = tr.grid;
    const N = app.core.undulation(tg.lat0 - (tg.height / 2) * tg.dlat, tg.lon0 + (tg.width / 2) * tg.dlon);
    const Hs = Float32Array.from(tr.current ?? tg.heights, (v, k) => v - app.core.undulation(tg.lat0 - Math.floor(k / tg.width) * tg.dlat, tg.lon0 + (k % tg.width) * tg.dlon));
    const msl = await app.sarStereo.dsmFromTerrain({ ...tr, vertical: 'egm96', gridV: null, current: Hs });
    const mslLev = await app.sarStereo.level(msl, tr);
    const geoid = { N, offset: mslLev.offset };
    const { layer } = await app.sarStereo.saveDsm(dsm);
    // Reopened from its file, the product keeps its σ, score and flags.
    const re = await app.sarStereo.dsmFromTerrain(app.terrain.entry(layer.id));
    const reopened = { flags: re.flags?.length ?? 0, same: re.flags ? re.flags.every((v, k) => v === dsm.flags[k]) : false, sigma: !!re.sigma, sameSide: re.stats?.geometry?.sameSide, prior: re.prior === dsm.prior, items: layer.info?.meta?.gdalItems ?? null };
    return { lev: { offset: lev.offset, sigma: lev.sigma, used: lev.used, terrain: !!app.terrain.entry(lev.layer.id), truth: levTruth.error, bare, enabled: app.commands.enabled('sar.stereolevel') }, enabled, pairs: pairs.map((p) => ({ ok: p.ok, g: p.geometry, notes: p.notes })), stats: dsm.stats, ms, vsTruth, vsPrior, ridge, ridgeMasked, anch: { stats: anch.stats, prior: anchPrior.error, truth: anchTruth.error }, product: { bands: layer.bands, terrain: !!app.terrain.entry(layer.id), name: layer.rec.name }, reopened, geoid };
  }, { lat: truth.centre.lat, lon: truth.centre.lon, ridge: truth.ridge });
  console.log(JSON.stringify({ ms: r.ms, stats: { matched: r.stats.matched, posts: r.stats.posts, shiftM: r.stats.shiftM, levels: r.stats.levels, latticeMaxPx: r.stats.latticeMaxPx, intersectMaxM: r.stats.intersectMaxM }, vsTruth: { error: r.vsTruth.error, completeness: r.vsTruth.completeness, masked: r.vsTruth.masked, calibration: r.vsTruth.calibration, bySlope: r.vsTruth.bySlope }, vsPrior: r.vsPrior.error, ridge: [r.ridgeMasked, r.ridge], anch: r.anch, lev: r.lev }));
  expect(r.enabled).toEqual([true, true, true]);
  // Pair finder: the 10° same-side Umbra geometry.
  expect(r.pairs.length).toBe(1);
  expect(r.pairs[0].ok).toBe(true);
  expect(r.pairs[0].g.sameSide).toBe(true);
  expect(r.pairs[0].g.intersectionDeg).toBeGreaterThan(8.5);
  expect(r.pairs[0].g.intersectionDeg).toBeLessThan(11.5);
  expect(r.pairs[0].g.parallax).toBeCloseTo(0.55, 1);
  // DSM: most posts matched, the heights close to the truth (not to the biased prior), no relative
  // offset was simulated, and the model check holds.
  expect(r.vsTruth.completeness).toBeGreaterThan(0.6);
  expect(Math.abs(r.vsTruth.error.median)).toBeLessThan(1);
  expect(r.vsTruth.error.rmse).toBeLessThan(2.5);
  expect(r.vsPrior.error.median).toBeLessThan(-1.5);
  expect(Math.abs(r.stats.shiftM)).toBeLessThan(2.5);
  expect(r.stats.latticeMaxPx).toBeLessThan(0.05);
  expect(r.stats.intersectMaxM).toBeLessThan(0.05);
  // The σ: the fixture's SICDs state no CompositeSCP, so σ has no bias term and says so; about the
  // median error it brackets the truth (90 % within 2σ on 2026-11-03, nominal 95 %).
  expect(r.stats.sigmaSysSource).toBe('none');
  expect(r.vsTruth.calibration.centredWithin2).toBeGreaterThan(0.85);
  // The steep ridge is masked where the prior shows it steep: the 30 m block average turns its 59°
  // faces into about 30°, so only part of it (28 % on 2026-11-03) is laid over in the prior. The
  // masks are only as sharp as the prior DEM (validation note).
  expect(r.vsTruth.masked.layover).toBeGreaterThan(0);
  expect(r.ridgeMasked / r.ridge).toBeGreaterThan(0.15);
  // Levelled on the prior: zero median against the prior, so about +3 m against the truth.
  expect(Math.abs(r.anch.prior.median)).toBeLessThan(0.3);
  expect(r.anch.truth.median).toBeGreaterThan(1.5);
  expect(r.anch.stats.anchored).toBe(true);
  // REG-084: levelled on the truth, the +3 m comes off (it is the prior's bias), over stable posts.
  expect(r.lev.enabled).toBe(true);
  expect(r.lev.offset).toBeGreaterThan(1.5);
  expect(r.lev.offset).toBeLessThan(4.5);
  expect(Math.abs(r.lev.truth.median)).toBeLessThan(0.5);
  expect(r.lev.used).toBeGreaterThan(500);
  expect(r.lev.terrain).toBe(true);
  // A heights-only DSM levels to a heights-only product, not to four bands with zero flags.
  expect(r.lev.bare).toBe(1);
  expect(r.reopened).toEqual({ flags: r.stats.posts, same: true, sigma: true, sameSide: true, prior: true, items: { GWB_PRODUCT: 'SAR_STEREO_DSM', GWB_SAME_SIDE: '1', GWB_PRIOR: expect.any(String) } });
  // REG-084: an EGM96 DEM is levelled on the ellipsoid, so the geoid is not fitted as a bias.
  expect(Math.abs(r.geoid.N)).toBeGreaterThan(1);
  expect(Math.abs(r.geoid.offset)).toBeLessThan(0.1);
  // The product: four bands, opened as terrain.
  expect(r.product.bands).toBe(4);
  expect(r.product.terrain).toBe(true);
  expect(logs.filter((l) => l.type === 'error')).toEqual([]);
});

test('REQ-GAP-42 SAR stereo dialogs pass axe and run the DSM with its report', async ({ page }) => {
  test.setTimeout(600000);
  const { frame, logs } = await setup(page);
  await frame.evaluate(() => void window.gisworkbench.commands.run('sar.stereopairs'));
  const dp = frame.locator('[data-id="dialog:sarstereo-pairs"]');
  await expect(dp).toBeVisible({ timeout: 60000 });
  await expect(dp.locator('[data-id="sarstereo-pairs"] tbody tr')).toHaveCount(1);
  expect(await axeOn(frame, '[data-id="dialog:sarstereo-pairs"]')).toEqual([]);
  await dp.getByRole('button', { name: 'Extract DSM…' }).click();
  const dd = frame.locator('[data-id="dialog:sarstereo-dsm"]');
  await expect(dd).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:sarstereo-dsm"]')).toEqual([]);
  await dd.getByLabel('Size (m)').fill('240');
  await dd.getByLabel('Post spacing (m)').fill('4');
  await dd.getByLabel('Cross-parallax shift search (± m)').fill('8');
  const truthId = await frame.evaluate(() => window.gisworkbench.terrain.dems.find((d) => /truth/.test(d.name)).layerId);
  const priorId = await frame.evaluate(() => window.gisworkbench.terrain.dems.find((d) => /prior/.test(d.name)).layerId);
  await dd.getByLabel('Prior DEM').selectOption(priorId);
  await dd.getByLabel('Reference DEM for the report').selectOption(truthId);
  await dd.getByRole('button', { name: 'Run' }).click();
  const dr = frame.locator('[data-id="dialog:sarstereo-report"]');
  await expect(dr).toBeVisible({ timeout: 300000 });
  await expect(dr.locator('[data-id="sarstereo-report"] tbody tr')).toHaveCount(4);
  expect(await axeOn(frame, '[data-id="dialog:sarstereo-report"]')).toEqual([]);
  const last = await frame.evaluate(() => {
    const d = window.gisworkbench.sarStereo.last;
    return { posts: d.stats.posts, matched: d.stats.matched, postM: d.params.postM, layer: !!d.layerId };
  });
  expect(last.postM).toBe(4);
  expect(last.matched / last.posts).toBeGreaterThan(0.5);
  expect(last.layer).toBe(true);
  await dr.getByRole('button', { name: 'Close' }).first().click();
  // The report command on the DSM against the truth.
  await frame.evaluate(() => void window.gisworkbench.commands.run('sar.stereoreport'));
  const pick = frame.locator('[data-id="dialog:sarstereo-report-pick"]');
  await expect(pick).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:sarstereo-report-pick"]')).toEqual([]);
  await pick.getByLabel('Reference DEM').selectOption(truthId);
  await pick.getByRole('button', { name: 'Run' }).click();
  const rd = frame.locator('[data-id="dialog:sarstereo-report"]');
  await expect(rd).toBeVisible();
  await rd.getByRole('button', { name: 'Close' }).first().click();
  // REG-084: Level DSM on Reference, against the truth.
  await frame.evaluate(() => void window.gisworkbench.commands.run('sar.stereolevel'));
  const lv = frame.locator('[data-id="dialog:sarstereo-level"]');
  await expect(lv).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:sarstereo-level"]')).toEqual([]);
  await lv.getByLabel('Reference DEM').selectOption(truthId);
  await lv.getByRole('button', { name: 'Run' }).click();
  await expect.poll(() => frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => l.rec?.name ?? '').join(' | ')), { timeout: 30_000 }).toMatch(/_LEVELLED/);
  expect(logs.filter((l) => l.type === 'error')).toEqual([]);
});

// The FX-25 pair is same-side, so the pair finder's answer is changed to reach these paths. The real
// opposite-side pair is HATOPP in tests/campaign/c61-sar-stereo.spec.js.
test('REQ-GAP-42 an opposite-side pair is listed as poor, runs only by choice, and its report warns', async ({ page }) => {
  test.setTimeout(600000);
  const { frame } = await setup(page);
  const r = await frame.evaluate(async (c) => {
    const app = window.gisworkbench;
    const all = [...app.layers.values()];
    const [A, B] = ['_a', '_b'].map((s) => all.find((l) => l.rec.name.includes(`sarstereo${s}`)));
    const prior = app.terrain.dems.find((d) => /prior/.test(d.name));
    const kn = 111132.954 - 559.822 * Math.cos((2 * c.lat * Math.PI) / 180);
    const ke = 111412.84 * Math.cos((c.lat * Math.PI) / 180);
    const aoi = { north: c.lat + 150 / kn, south: c.lat - 150 / kn, west: c.lon - 150 / ke, east: c.lon + 150 / ke };
    const real = app.pool.run;
    app.pool.run = function (op, ...a) {
      const p = real.call(this, op, ...a);
      return op === 'sar.stereoPairs' ? p.then((qs) => qs.map((q) => ({ ...q, ok: true, notes: ['opposite'], geometry: { ...q.geometry, sameSide: false } }))) : p;
    };
    const code = await app.sarStereo.extract(A, B, { aoi, postM: 4, levels: 2, shiftM: 8, prior }).then(() => null, (e) => e.code);
    const dsm = await app.sarStereo.extract(A, B, { aoi, postM: 4, levels: 2, shiftM: 8, prior, allowOpposite: true });
    dsm.stats.geometry.sameSide = false;
    const rep = app.sarStereo.report(dsm, prior);
    // REG-084: an opposite-side DSM is not levelled.
    const levelCode = await app.sarStereo.level(dsm, prior).then(() => null, (e) => e.code);
    // Saved and reopened, it is still known as opposite-side (GDAL metadata, not the prose), so still refused.
    const { layer } = await app.sarStereo.saveDsm(dsm);
    app.sarStereo.last = null;
    const re = await app.sarStereo.dsmFromTerrain(app.terrain.entry(layer.id));
    if (re === dsm) throw new Error('reopened from the session, not the file');
    const reopenedCode = await app.sarStereo.level(re, prior).then(() => null, (e) => e.code);
    // A file 2.6 wrote: four bands and the prose description only, no GDAL metadata. Its flags and
    // pair side are still read back, so it is refused too.
    const g = dsm.grid;
    const data = new Float32Array(4 * g.nx * g.ny);
    for (let i = 0; i < g.nx * g.ny; i++) [data[4 * i], data[4 * i + 1], data[4 * i + 2], data[4 * i + 3]] = [dsm.heights[i], dsm.sigma[i], dsm.score[i], dsm.flags[i]];
    const desc = `GIS Workbench SAR stereo DSM (radargrammetry) from A + B: band 1 height above the WGS 84 ellipsoid (m), band 2 per-post sigma (m), band 3 matching score, band 4 flags (1/2 layover A/B, 4/8 shadow A/B, 16 weak, 32 ambiguous, 64 rejected, 128 no data); prior ${prior.name}; opposite-side pair, not recommended`;
    const tif = await app.__test.writeGeoTiff({ width: g.nx, height: g.ny, bands: 4, type: 'f32', data }, { epsg: 4326, vertical: 'hae', geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: desc, overviews: true });
    await app.openFiles([new File([tif], 'SARDSM_v26.tif')]);
    const old = [...app.layers.values()].find((x) => x.rec?.name?.startsWith('SARDSM_v26'));
    await app.useAsTerrain(old, 'hae');
    const v26 = await app.sarStereo.dsmFromTerrain(app.terrain.entry(old.id));
    const v26Code = await app.sarStereo.level(v26, prior).then(() => null, (e) => e.code);
    const v26Facts = { flags: v26.flags ? v26.flags.every((v, k) => v === dsm.flags[k]) : false, prior: v26.prior === prior.name };
    return { code, levelCode, reopenedCode, v26Code, v26Facts, warning: rep.warning, sameSide: app.sarStereo.report({ ...dsm, stats: { ...dsm.stats, geometry: { ...dsm.stats.geometry, sameSide: true } } }, prior).warning ?? null };
  }, { lat: truth.centre.lat, lon: truth.centre.lon });
  expect(r).toEqual({ code: 'E_SARSTEREO_OPPOSITE', levelCode: 'E_SARSTEREO_OPPOSITE', reopenedCode: 'E_SARSTEREO_OPPOSITE', v26Code: 'E_SARSTEREO_OPPOSITE', v26Facts: { flags: true, prior: true }, warning: 'opposite-side pair, not recommended', sameSide: null });
  await frame.evaluate(() => void window.gisworkbench.commands.run('sar.stereopairs'));
  await expect(page.locator('[data-id="sarstereo-pairs"]')).toContainText('poor: opposite side, not recommended');
  await page.locator('[data-id="dialog:sarstereo-pairs"] .dlg-buttons button', { hasText: 'Extract DSM' }).click();
  await expect(page.locator('[data-id="sarstereo:allow-opposite"]')).not.toBeChecked();
});
