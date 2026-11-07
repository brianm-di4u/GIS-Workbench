// SCN-62 (2.6 filework): the Annex 14 inner approach, inner transitional and balked landing surfaces
// with the Amendment 18 edition label.
// * REQ-GAP-73: hand-placed masts on a synthetic DSM, whose penetrations are worked out here from
//   Table 4-1; the dialog and results on the FX-02 DSM, with their exports and axe; the zone over
//   the real DSMs of LAS and HOU when the corpus is present.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';

const FX = resolve('fixtures/fx25/aviation');
const NASR = { base: readFileSync(join(FX, 'APT_BASE.csv'), 'latin1'), rwy: readFileSync(join(FX, 'APT_RWY.csv'), 'latin1'), end: readFileSync(join(FX, 'APT_RWY_END.csv'), 'latin1') };
const LAS_DSM = 'D:/TE-corpus/dem-under-vegas/Copernicus_DSM_COG_10_N36_00_W116_00_DEM.tif';
const HOU_DSM = 'D:/TE-corpus/ieee-dfc2018-houston/DSM_C12/UH17c_GEF051.tif';
const OUT = resolve('reports', 'filework26');
const EDITION = 'ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20 November 2030';
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const axeOn = (frame, sel) => frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });
const savedText = (frame, re) => frame.evaluate(async (src) => {
  const s = window.gisworkbench.__saved.filter((x) => new RegExp(src).test(x.name)).at(-1);
  return s ? { name: s.name, text: await s.blob.text() } : null;
}, re.source);

/** A runway on a meridian, 3 000 m long, level at 100 m, precision category I to end 36. */
const AIRPORT = {
  ident: 'SYN',
  name: 'Synthetic',
  elev: 100,
  source: 'test',
  runways: [{ id: '18/36', length: 3000, width: 45, paved: true, code: 4, ends: [{ id: '36', lat: 36, lon: -115, elev: 100, p77: 'PIR', icao: 2, disp: 0, thrElev: null, clearway: 0, approach: true, takeoff: true }, { id: '18', lat: 36 + 3000 / 110950.6, lon: -115, elev: 100, p77: 'PIR', icao: 2, disp: 0, thrElev: null, clearway: 0, approach: true, takeoff: true }] }],
};

test('REQ-GAP-73 masts on a synthetic DSM: the zone reads them apart from the lowest surface', async ({ page }) => {
  test.setTimeout(180000);
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async (ap) => {
    const app = window.gisworkbench;
    // 1.1 m posts, flat at 99 m, centred 1 500 m along the runway.
    const dlat = 1e-5;
    const dlon = 1e-5;
    const width = 800;
    const height = 800;
    const lat1 = 36 + 1500 / 110950.6;
    const lat0 = lat1 + (height / 2) * dlat;
    const lon0 = -115 - (width / 2) * dlon;
    const z = new Float32Array(width * height).fill(99);
    const kmLon = 111412.84 * Math.cos((lat1 * Math.PI) / 180) - 93.5 * Math.cos((3 * lat1 * Math.PI) / 180);
    const post = (east) => Math.floor(height / 2) * width + Math.round(((-115 + east / kmLon) - lon0) / dlon);
    z[post(100)] = 120; // through the zone: 100 + 40 × 33.3 % = 113.32 m there
    z[post(-80)] = 104; // above the strip level, under the zone: 100 + 20 × 33.3 % = 106.66 m
    const dem = { name: 'synthetic DSM', vertical: 'msl', grid: { lat0, lon0, dlat, dlon, width, height, heights: z } };
    const x = await app.aviation.evaluate({ airport: ap, regime: 'icao', dem, draw: false, overlay: false, keep: false });
    const c = await app.aviation.evaluate({ airport: ap, regime: 'icao', dem, draw: false, overlay: false, keep: false, codeF: true });
    const p77 = await app.aviation.evaluate({ airport: ap, regime: 'part77', dem, draw: false, overlay: false, keep: false });
    return { edition: x.edition, obstacles: x.obstacles, zone: x.zone?.obstacles, zoneStats: x.zone?.stats, notes: x.notes, kinds: [...new Set(x.model.surfaces.map((s) => s.kind))], codeFNotes: c.notes, codeFEdition: c.codeF, p77: { edition: p77.edition, zone: p77.zone, notes: p77.notes } };
  }, AIRPORT);
  expect(r.edition).toBe(EDITION);
  expect(r.kinds).toEqual(expect.arrayContaining(['innerApproach', 'innerTransitional', 'balkedLanding', 'ofzStrip']));
  // The lowest surface: both masts are above the strip, the first by 20 m.
  expect(r.obstacles.map((o) => o.kind)).toEqual(['strip', 'strip']);
  expect(r.obstacles[0].pen).toBeCloseTo(20, 1);
  expect(r.obstacles[1].pen).toBeCloseTo(4, 1);
  // The zone: only the first, by 120 − 113.32 m. Half a post of offset moves the surface by 0.2 m.
  expect(r.zone.length).toBe(1);
  expect(r.zone[0]).toMatchObject({ id: 'Z1', kind: 'innerTransitional', zone: true, surface: 'Inner transitional surface 36' });
  expect(Math.abs(r.zone[0].pen - 6.68)).toBeLessThan(0.3);
  expect(r.notes.some((n) => /^Not checked/.test(n))).toBe(false);
  expect(r.notes.some((n) => /frangible/.test(n))).toBe(true);
  expect(r.notes.some((n) => /§4.2.14/.test(n) && /§4.2.15/.test(n))).toBe(true);
  expect(r.notes.some((n) => /§4.1.27/.test(n))).toBe(true);
  expect(r.codeFNotes.some((n) => /140 m/.test(n))).toBe(true);
  expect(r.codeFEdition).toBe(true);
  // Part 77 has neither a zone nor an edition.
  expect(r.p77.edition).toBeNull();
  expect(r.p77.zone).toBeNull();
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-73 no precision approach: the zone does not apply, and the results say so', async ({ page }) => {
  test.setTimeout(120000);
  const { frame, logs } = await openApp(page, 'file');
  const r = await frame.evaluate(async (ap) => {
    const app = window.gisworkbench;
    const a = structuredClone(ap);
    for (const e of a.runways[0].ends) e.icao = 1;
    const z = new Float32Array(400 * 400).fill(99);
    const dem = { name: 'flat', vertical: 'msl', grid: { lat0: 36.02, lon0: -115.01, dlat: 1e-4, dlon: 1e-4, width: 400, height: 400, heights: z } };
    const x = await app.aviation.evaluate({ airport: a, regime: 'icao', dem, draw: false, overlay: false, keep: false });
    let refused = null;
    const b = structuredClone(ap);
    b.runways[0].code = 2;
    b.runways[0].ends[0].icao = 3;
    await app.aviation.evaluate({ airport: b, regime: 'icao', dem, draw: false, overlay: false, keep: false }).catch((e) => (refused = { code: e.code, msg: e.message }));
    return { zone: x.zone, edition: x.edition, notes: x.notes, refused };
  }, AIRPORT);
  expect(r.zone).toBeNull();
  expect(r.edition).toBe(EDITION);
  expect(r.notes.some((n) => /do not apply \(Table 4-1\)/.test(n))).toBe(true);
  expect(r.refused.code).toBe('E_AIRPORT_INVALID');
  expect(r.refused.msg).toMatch(/no precision category II or III column for code number 2/);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-73 a source that misses the zone is reported as not checked, never as clear', async ({ page }) => {
  test.setTimeout(120000);
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(async (ap) => {
    const app = window.gisworkbench;
    // Flat ground 2 km to 3 km east of the runway, under the inner horizontal surface: above nothing
    // of the zone, whose reach here is about 200 m.
    const z = new Float32Array(100 * 100).fill(99);
    const lon0 = -115 + 2000 / 90000;
    const dem = { name: 'beside the runway', vertical: 'msl', grid: { lat0: 36.02, lon0, dlat: 1e-4, dlon: 1e-4, width: 100, height: 100, heights: z } };
    const r = await app.aviation.evaluate({ airport: ap, regime: 'icao', dem, draw: false, overlay: false, keep: false });
    void app.aviation.showResult(r);
  }, AIRPORT);
  const res = frame.locator('[data-id="dialog:avn-results"]');
  await expect(res).toBeVisible({ timeout: 60000 });
  await expect(res).toContainText('does not reach the obstacle-free zone');
  await expect(res).toContainText('so the zone was not checked');
  await expect(res.locator('[data-id="avn:zone-summary"]')).toHaveCount(0);
  await expect(res.getByRole('heading', { name: 'Obstacle-free zone' })).toHaveCount(0);
  // The surfaces it does reach are still reported.
  await expect(res.locator('[data-id="avn:summary"]')).toContainText('lie under a surface');
  await res.locator('.dlg-buttons').getByRole('button', { name: 'Close' }).click();
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-73 the dialog, the results and the files name the edition', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx02/fx02_dsm_truth.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 120000 });
  await frame.evaluate(axeSource);
  await frame.evaluate(async (ap) => {
    const app = window.gisworkbench;
    Object.assign(app.runMode.caps, { fsaSave: false, fsaPicker: false });
    app.__saved = [];
    app.saveCapture = (blob, name) => app.__saved.push({ blob, name });
    const l = [...app.layers.values()][0];
    await app.useAsTerrain(l, 'hae');
    const G = app.terrain.entry(l.id).grid;
    const lat = G.lat0 - (G.height * G.dlat) / 2;
    const lon = G.lon0 + (G.width * G.dlon) / 2;
    const a = structuredClone(ap);
    a.runways[0].ends.forEach((e, k) => {
      e.lat = lat + k * (3000 / 110950.6) - 1500 / 110950.6;
      e.lon = lon;
    });
    app.aviation.current = await app.aviation.addAirport(a);
  }, AIRPORT);
  await frame.evaluate(() => void window.gisworkbench.commands.run('los.obstruction'));
  const dlg = frame.locator('[data-id="dialog:avn-obstruction"]');
  await expect(dlg).toBeVisible();
  // Part 77 first: nothing about Annex 14 shows.
  await dlg.getByLabel('Surfaces', { exact: true }).selectOption('part77');
  await expect(dlg.locator('[data-id="avn:edition"]')).toBeHidden();
  await dlg.getByLabel('Surfaces', { exact: true }).selectOption('icao');
  await expect(dlg.locator('[data-id="avn:edition"]')).toHaveText(`Follows ${EDITION}.`);
  await expect(dlg.locator('[data-id="avn:icao-limit"]')).toHaveCount(0);
  expect(await axeOn(frame, '[data-id="dialog:avn-obstruction"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Evaluate' }).click();
  const res = frame.locator('[data-id="dialog:avn-results"]');
  await expect(res).toBeVisible({ timeout: 240000 });
  await expect(res.locator('[data-id="avn:edition"]')).toHaveText(`Follows ${EDITION}.`);
  await expect(res.locator('[data-id="avn:zone-summary"]')).toBeVisible();
  await expect(res).not.toContainText('Not checked');
  await expect(res).not.toContainText('leaves out');
  expect(await axeOn(frame, '[data-id="dialog:avn-results"]')).toEqual([]);
  await res.getByRole('button', { name: 'Export CSV' }).click();
  await res.getByRole('button', { name: 'Export GeoJSON' }).click();
  await res.getByRole('button', { name: 'Export KML' }).click();
  await res.getByRole('button', { name: 'Surfaces as KML' }).click();
  await res.locator('.dlg-buttons').getByRole('button', { name: 'Close' }).click();
  const csv = await savedText(frame, /^penetrations-SYN-icao\.csv$/);
  expect(csv.text.split('\n')[0].endsWith(',obstacle_free_zone,edition')).toBe(true);
  const gj = JSON.parse((await savedText(frame, /^penetrations-SYN-icao\.geojson$/)).text);
  expect(gj.gisWorkbench.edition).toBe(EDITION);
  expect((await savedText(frame, /^penetrations-SYN-icao\.kml$/)).text).toContain(EDITION);
  const skml = await savedText(frame, /^surfaces-SYN-icao\.kml$/);
  expect(skml.text).toContain(EDITION);
  expect(skml.text).toMatch(/<Folder><name>Balked landing surface 36<\/name>/);
  expect(skml.text).toMatch(/<Folder><name>Inner approach surface 18<\/name>/);
  // The kept record carries the edition.
  const rec = await frame.evaluate(() => window.gisworkbench.store.all('obstruction').at(-1));
  expect(rec.edition).toBe(EDITION);
  expect(rec.zone.stats.covered).toBeGreaterThan(0);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

for (const [name, dsm, id, vertical] of [['LAS against Copernicus GLO-30', LAS_DSM, 'LAS', 'egm2008'], ['HOU against the DFC2018 lidar DSM', HOU_DSM, 'HOU', 'hae']])
  test(`REQ-GAP-73 real data: ${name}`, async ({ page }, info) => {
    test.skip(!existsSync(dsm), 'the corpus DSM is not on this machine');
    test.setTimeout(900000);
    mkdirSync(OUT, { recursive: true });
    const { frame, logs } = await openApp(page, 'file');
    await openFiles(frame, [dsm]);
    await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 180000 });
    const r = await frame.evaluate(async ({ T, id, vertical }) => {
      const app = window.gisworkbench;
      await app.useAsTerrain([...app.layers.values()][0], vertical);
      const [ap] = await app.aviation.importNasr(T, [id]);
      const x = await app.aviation.evaluate({ airport: ap, regime: 'icao', minPen: 3, draw: false, overlay: false, keep: false });
      const byKind = {};
      for (const o of x.zone.obstacles) byKind[o.kind] = (byKind[o.kind] ?? 0) + 1;
      return { stats: x.stats, zone: x.zone.stats, byKind, top: x.zone.obstacles.slice(0, 10), low: x.obstacles.slice(0, 5), notes: x.notes, surfaces: x.model.surfaces.length, ms: x.stats.ms };
    }, { T: NASR, id, vertical });
    writeFileSync(join(OUT, `${id}-${info.project.name}.json`), JSON.stringify(r, null, 1));
    // No lower limit than the lowest surface: a post above the zone is above the lowest surface too.
    expect(r.zone.penetrating).toBeLessThanOrEqual(r.stats.penetrating);
    for (const o of r.top) expect(Math.abs(o.pen - (o.z - o.limit))).toBeLessThan(1e-3);
    expect(r.zone.evaluated).toBe(r.stats.evaluated);
    expect(r.zone.covered).toBeLessThan(r.stats.covered);
    if (id === 'LAS') expect(r.zone.covered).toBeGreaterThan(1000);
    // OD-2.31: 30 m posts miss what the FAA obstacle file lists, and the results must say so.
    expect(r.notes.some((n) => /posts about \d+ m apart/.test(n))).toBe(id === 'LAS');
    // The HOU tile lies well out under the approach to 13R: it does not reach the zone, and says so.
    if (id === 'HOU') {
      expect(r.zone.covered).toBe(0);
      expect(r.notes.some((n) => /so the zone was not checked/.test(n))).toBe(true);
    }
    expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
  });
