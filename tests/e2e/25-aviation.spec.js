// 2.5 gap wave T0b, group aviation (SDP-2.3 GR-27):
// * REQ-GAP-73 obstruction surfaces: Harry Reid International (LAS) from the FAA NASR fixture rows
//   against the Copernicus GLO-30 DSM under the Las Vegas tile (corpus dem-under-vegas), Part 77 and
//   Annex 14, through the dialogs; an airport entered by hand with a runway drawn on the map, and a
//   point cloud with a hand-placed crane under its approach; exports; axe on the dialogs. No-data
//   posts become voids on both Use as Terrain paths, and a cloud that cannot be placed under the
//   surfaces is refused by name rather than reported as clear.
// * REQ-GAP-78 (SCN-72): Annex 14 Amendment 18's 2030 obstacle free and obstacle evaluation surfaces
//   through the dialog's edition selector (the default follows the analysis date), its design group
//   and mass inputs, the edition and assumptions in the results and files, and one point-cloud survey
//   with hand-placed masts under both editions.
// * REQ-GAP-74 flight planning: a route drawn on the map from North Las Vegas towards Mount
//   Charleston, leg altitudes and speeds in the Flight Plan dialog, the terrain warnings, distances
//   and courses against GeographicLib, the profile minimum against the DSM read here, and KML and
//   GPX export and import.
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import geodesic from 'geographiclib-geodesic';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles } from './helpers.js';

const FX = resolve('fixtures/fx25/aviation');
const NASR = { base: readFileSync(join(FX, 'APT_BASE.csv'), 'latin1'), rwy: readFileSync(join(FX, 'APT_RWY.csv'), 'latin1'), end: readFileSync(join(FX, 'APT_RWY_END.csv'), 'latin1') };
const DSM = 'D:/TE-corpus/dem-under-vegas/Copernicus_DSM_COG_10_N36_00_W116_00_DEM.tif';
const haveDsm = existsSync(DSM);
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const OUT = resolve('reports', 'aviation25');
const G = geodesic.Geodesic.WGS84;
const FT = 0.3048;
const KT = 1852 / 3600;

async function axeOn(frame, sel) {
  return frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });
}

/** Open the Las Vegas DSM as terrain (EGM2008 heights), with saves captured. */
async function withDsm(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [DSM]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 120000 });
  await frame.evaluate(async () => {
    const app = window.gisworkbench;
    Object.assign(app.runMode.caps, { fsaSave: false, fsaPicker: false });
    app.__saved = [];
    app.saveCapture = (blob, name) => app.__saved.push({ blob, name });
    const l = [...app.layers.values()][0];
    await app.useAsTerrain(l, 'egm2008');
  });
  await frame.evaluate(axeSource);
  return { frame, logs };
}
const savedText = (frame, re) => frame.evaluate(async (src) => {
  const s = window.gisworkbench.__saved.filter((x) => new RegExp(src).test(x.name)).at(-1);
  return s ? { name: s.name, text: await s.blob.text() } : null;
}, re.source);

/** Screen position (page coordinates) of a ground point in the active panel. */
const screenOf = (frame, lat, lon) =>
  frame.evaluate(([la, lo]) => {
    const p = window.gisworkbench.activePane();
    const q = p.geoLayer().imageAt(la, lo, 0);
    const s = p.screenPoint(q.x, q.y);
    const r = p.el.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }, [lat, lon]);
const viewTo = (frame, lat, lon, zoom) =>
  frame.evaluate(([la, lo, z]) => {
    const p = window.gisworkbench.activePane();
    const q = p.geoLayer().imageAt(la, lo, 0);
    p.setView({ cx: q.x, cy: q.y, zoom: z, rot: 0, mode: 'native' });
  }, [lat, lon, zoom]);

/** A copy of a LAS 1.2 file with no VLRs that states `epsg` (a GeoKeyDirectory VLR after the header). */
function tagLas(src, dst, epsg) {
  const b = readFileSync(src);
  expect(b.readUInt32LE(100), 'the source has no VLRs').toBe(0);
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

test('Use as Terrain: declared no-data posts become voids, on the resampled and the geographic path', async ({ page }) => {
  test.setTimeout(120000);
  const { frame, logs } = await openApp(page, 'file');
  // 64 × 64 Float32 ramps of 10–41.5 m holding an 8 × 8 no-data block; the tag is one Float32 cannot
  // hold exactly. UTM takes the resampling path (a void must not spread as interpolated heights),
  // EPSG:4326 the direct one (the tag must still match its posts).
  const out = {};
  for (const [k, file] of [['utm', 'nodata-utm15n-f32.tif'], ['wgs84', 'nodata-wgs84-f32.tif']]) {
    await openFiles(frame, [join(FX, file)]);
    await frame.waitForFunction((f) => [...window.gisworkbench.layers.values()].some((l) => l.rec.name === f && l.lutTex), file, { timeout: 60000 });
    out[k] = await frame.evaluate(async (f) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.rec.name === f);
      const g = await app.useAsTerrain(l, 'hae');
      const c = l.groundAt(32, 32);
      let finite = 0;
      let voids = 0;
      let max = -Infinity;
      let min = Infinity;
      for (const v of g.heights) {
        if (Number.isNaN(v)) voids++;
        else {
          finite++;
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
      }
      return { resampled: !!g.resampled, n: g.heights.length, finite, voids, max, min, centre: app.terrain.sample(c.lat, c.lon) };
    }, file);
  }
  expect(out.utm.resampled).toBe(true);
  expect(out.wgs84.resampled).toBe(false);
  for (const [k, o] of Object.entries(out)) {
    expect(o.max, k).toBeLessThanOrEqual(41.5 + 1e-3);
    expect(o.min, k).toBeGreaterThanOrEqual(10 - 1e-3);
    expect(o.voids, k).toBeGreaterThan(0);
    expect(o.centre, k).toBeNull(); // the middle of the block has no height
  }
  expect(out.wgs84.voids).toBe(64);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-73 a point cloud that cannot be placed under the surfaces is refused, never reported clear', async ({ page }, info) => {
  test.setTimeout(120000);
  const { frame } = await openApp(page, 'file');
  // fx09 as it is (its CRS places it far from LAS), and a copy with its CRS records removed, which
  // opens in the local frame at 0°, 0°.
  const stated = resolve('fixtures/fx09/fx09.las');
  const b = Buffer.from(readFileSync(stated));
  b.writeUInt32LE(0, 100); // VLRs
  b.writeUInt32LE(0, 243); // EVLRs (LAS 1.4)
  const none = info.outputPath('fx09-no-crs.las');
  writeFileSync(none, b);
  await openFiles(frame, [stated, none]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size === 2, null, { timeout: 60000 });
  const r = await frame.evaluate(async (T) => {
    const app = window.gisworkbench;
    const [id] = await app.aviation.importNasr(T, ['LAS']);
    const out = {};
    for (const c of app.pointClouds.values()) {
      const k = c.crs.local ? 'local' : 'placed';
      try {
        out[k] = await app.aviation.evaluate({ airport: id, regime: 'part77', source: 'points', cloud: c, draw: false, keep: true });
      } catch (e) {
        out[k] = { code: e.code, message: e.message };
      }
    }
    return { ...out, kept: app.store.all('obstruction').length };
  }, NASR);
  expect(r.local?.code).toBe('E_OBS_NO_CRS');
  expect(r.local.message).toMatch(/^fx09-no-crs.las has no coordinate system/);
  expect(r.placed?.code).toBe('E_OBS_NO_OVERLAP');
  expect(r.kept).toBe(0); // no clean-looking record is left behind
});

test('REQ-GAP-73 LAS from NASR against the Copernicus DSM: Part 77 and Annex 14, dialogs and exports', async ({ page }) => {
  test.skip(!haveDsm, 'the corpus DSM dem-under-vegas is not on this machine');
  test.setTimeout(600000);
  mkdirSync(OUT, { recursive: true });
  const { frame, logs } = await withDsm(page);
  const ids = await frame.evaluate(async (T) => window.gisworkbench.aviation.importNasr(T, ['LAS']), NASR);
  expect(ids.length).toBe(1);
  // The Obstruction Surfaces dialog: FAA Part 77 on the DSM, penetrations deeper than 3 m.
  await frame.evaluate(() => void window.gisworkbench.commands.run('los.obstruction'));
  const dlg = frame.locator('[data-id="dialog:avn-obstruction"]');
  await expect(dlg).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:avn-obstruction"]')).toEqual([]);
  await dlg.getByLabel('Surfaces', { exact: true }).selectOption('part77');
  await dlg.getByLabel('Report penetrations deeper than (m)').fill('3');
  await dlg.getByRole('button', { name: 'Evaluate' }).click();
  const res = frame.locator('[data-id="dialog:avn-results"]');
  await expect(res).toBeVisible({ timeout: 300000 });
  expect(await axeOn(frame, '[data-id="dialog:avn-results"]')).toEqual([]);
  const summary = await res.locator('[data-id="avn:summary"]').textContent();
  expect(summary).toMatch(/^LAS \(FAA Part 77\) against /);
  await res.getByRole('button', { name: 'Export CSV' }).click();
  await res.getByRole('button', { name: 'Surfaces as KML' }).click();
  await res.locator('.dlg-buttons').getByRole('button', { name: 'Close' }).click();
  const csv = await savedText(frame, /^penetrations-LAS-part77\.csv$/);
  const kml = await savedText(frame, /^surfaces-LAS-part77\.kml$/);
  expect(csv.text.split('\n')[0]).toBe('id,lat,lon,top_m_orthometric,surface_m,penetration_m,penetration_ft,surface,posts_or_points');
  expect(kml.text).toMatch(/<Folder><name>Approach surface 26R<\/name>/);
  const r77 = await frame.evaluate(() => {
    const r = window.gisworkbench.aviation.last;
    const bySurface = {};
    for (const o of r.obstacles) bySurface[o.kind] = (bySurface[o.kind] ?? 0) + 1;
    return { stats: r.stats, top: r.obstacles.slice(0, 15), bySurface, kinds: r.model.surfaces.map((s) => s.kind), horizontal: r.model.horizontal, grid: { w: r.grid.width, h: r.grid.height }, graphics: window.gisworkbench.store.all('graphic').filter((g) => g.provenance?.kind === 'obstruction').length, overlay: !!r.overlay };
  });
  writeFileSync(join(OUT, 'las-copernicus-part77.json'), JSON.stringify(r77, null, 1));
  // 4 runways: primary + transitional + 2 approaches each, horizontal, conical.
  expect(r77.kinds.length).toBe(18);
  // §77.19(a): 150 ft above the NASR airport elevation (2 183.1 ft).
  expect(r77.horizontal).toBeCloseTo((2183.1 + 150) * FT, 6);
  expect(r77.stats.covered).toBeGreaterThan(100000);
  expect(r77.stats.obstacles).toBeGreaterThan(0);
  // Every obstacle is reported where its post is highest above the lowest surface; those through
  // the horizontal surface are measured from its one height. (Copernicus GLO-30 is an edited radar
  // DSM: the Strip's towers stand only 10–40 m above the ground in it, so none of them penetrates;
  // what does is ground west of the field above the horizontal surface and posts near the south
  // ends under the approaches; see docs/validation/2.5/aviation.md.)
  for (const o of r77.top) {
    expect(Math.abs(o.pen - (o.z - o.limit))).toBeLessThan(1e-3);
    if (o.kind === 'horizontal') expect(Math.abs(o.limit - r77.horizontal)).toBeLessThan(1e-3);
    expect(o.pen).toBeGreaterThan(3);
  }
  expect(r77.top[0].pen).toBeLessThan(30);
  expect(r77.graphics).toBeGreaterThan(20);
  expect(r77.overlay).toBe(true);
  // Annex 14 through the API on the same DSM (code 4 from the runway lengths; precision category I
  // for the PIR ends).
  const ricao = await frame.evaluate(async (id) => {
    const r = await window.gisworkbench.aviation.evaluate({ airport: id, regime: 'icao', minPen: 3, draw: false, overlay: false });
    return { stats: r.stats, top: r.obstacles.slice(0, 15), kinds: [...new Set(r.model.surfaces.map((s) => s.kind))], ihs: r.model.horizontal, notes: r.notes };
  }, ids[0]);
  expect(ricao.kinds.sort()).toEqual(['approach', 'balkedLanding', 'conical', 'innerApproach', 'innerHorizontal', 'innerTransitional', 'ofzStrip', 'strip', 'takeoff', 'transitional']);
  expect(ricao.ihs).toBeCloseTo(2183.1 * FT + 45, 6);
  expect(ricao.notes.some((n) => /^Not checked/.test(n))).toBe(false); // 2.6 builds the zone: tests/e2e/26-filework.spec.js
  expect(ricao.stats.obstacles).toBeGreaterThan(0);
  writeFileSync(join(OUT, 'las-copernicus.json'), JSON.stringify({ part77: r77, icao: ricao }, null, 1));
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

const DFC = 'D:/TE-corpus/ieee-dfc2018-houston';
const haveDfc = existsSync(join(DFC, 'DSM_C12', 'UH17c_GEF051.tif')) && existsSync(join(DFC, 'C1', '272652_3289689.las'));

test('REQ-GAP-73 HOU runway 13R approach over the DFC2018 Houston lidar: DSM and point cloud', async ({ page }, info) => {
  test.skip(!haveDfc, 'the corpus lidar ieee-dfc2018-houston is not on this machine');
  test.setTimeout(900000);
  mkdirSync(OUT, { recursive: true });
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(DFC, 'DSM_C12', 'UH17c_GEF051.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 180000 });
  const r = await frame.evaluate(async (T) => {
    const app = window.gisworkbench;
    // The 2018 Data Fusion Contest lidar DSM (0.5 m, UTM 15N): ellipsoidal heights (NAD 83(2011)).
    await app.useAsTerrain([...app.layers.values()][0], 'hae');
    const [id] = await app.aviation.importNasr(T, ['HOU']);
    const out = {};
    for (const regime of ['part77', 'icao']) {
      const x = await app.aviation.evaluate({ airport: id, regime, minPen: 0, draw: false, overlay: false, keep: false });
      out[regime] = { stats: x.stats, kinds: [...new Set(x.obstacles.map((o) => o.kind))], top: x.obstacles.slice(0, 10), notes: x.notes, grid: { w: x.grid.width, h: x.grid.height, dlat: x.grid.dlat, dlon: x.grid.dlon } };
    }
    return { id, ...out };
  }, NASR);
  writeFileSync(join(OUT, 'hou-dfc2018-dsm.json'), JSON.stringify(r, null, 1));
  // The tile lies under the precision approach to 13R (Part 77 50:1 then 40:1 with its transitional
  // surfaces; Annex 14 the horizontal section 150 m above the threshold): the campus buildings stay
  // below both.
  for (const k of ['part77', 'icao']) {
    expect(r[k].stats.covered, k).toBeGreaterThan(100000);
    expect(r[k].stats.penetrating, k).toBe(0);
    expect(r[k].stats.minClearance, k).toBeGreaterThan(20);
    expect(r[k].stats.minClearanceSurface, k).toMatch(/Approach surface 13R|Transitional surface 13R\/31L/);
  }
  // The same tile's classified point cloud (Optech Titan channel 1). The contest's LAS files state no
  // CRS (and Assign CRS takes only BPF clouds), so a copy states the DSM's: NAD 83 / UTM 15N, whose
  // extent holds the cloud's.
  const las = info.outputPath('272652_3289689-epsg26915.las');
  tagLas(join(DFC, 'C1', '272652_3289689.las'), las, 26915);
  await openFiles(frame, [las]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size > 0, null, { timeout: 300000 });
  rmSync(las, { force: true });
  const pc = await frame.evaluate(async (id) => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    // The cloud covers 600 m of the DSM's 4.2 km: the two are compared over the cloud's footprint.
    const box = { s: 90, n: -90, w: 180, e: -180 };
    for (let k = 0; k < c.n; k += 97) {
      const g = app.pc.toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
      Object.assign(box, { s: Math.min(box.s, g.lat), n: Math.max(box.n, g.lat), w: Math.min(box.w, g.lon), e: Math.max(box.e, g.lon) });
    }
    const out = { n: c.n, crs: c.crs.label, box };
    for (const regime of ['part77', 'icao']) {
      const x = await app.aviation.evaluate({ airport: id, regime, source: 'points', cloud: c, minPen: 0, draw: false, keep: false });
      const d = await app.aviation.evaluate({ airport: id, regime, minPen: 0, draw: false, overlay: false, keep: false });
      const G = d.grid;
      let min = Infinity;
      let at = null;
      for (let j = 0; j < G.height; j++) {
        const lat = G.lat0 - j * G.dlat;
        if (lat < box.s || lat > box.n) continue;
        for (let i = 0; i < G.width; i++) {
          const lon = G.lon0 + i * G.dlon;
          if (lon < box.w || lon > box.e) continue;
          const v = G.limit[j * G.width + i] - G.z[j * G.width + i];
          if (v < min) [min, at] = [v, { lat, lon }];
        }
      }
      out[regime] = { stats: x.stats, top: x.obstacles.slice(0, 5), dsmInFootprint: { minClearance: min, at } };
    }
    return out;
  }, r.id);
  for (const k of ['part77', 'icao']) {
    expect(pc[k].stats.covered, k).toBeGreaterThan(pc.n * 0.5);
  }
  writeFileSync(join(OUT, 'hou-dfc2018.json'), JSON.stringify({ dsm: r, cloud: pc }, null, 1));
  // The cloud keeps returns the DSM's posts (and its resampling) smooth over: over the same ground
  // the smallest clearance agrees within 10 m.
  for (const k of ['part77', 'icao']) expect(Math.abs(pc[k].stats.minClearance - pc[k].dsmInFootprint.minClearance), k).toBeLessThan(10);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-73 an airport entered by hand, a runway drawn on the map, a crane in a point cloud', async ({ page }) => {
  test.skip(!haveDsm, 'the corpus DSM dem-under-vegas is not on this machine');
  test.setTimeout(400000);
  const { frame, logs } = await withDsm(page);
  // A desert strip north-west of Indian Springs: ends 1 200 m apart east–west at 36.62 N.
  const A = { lat: 36.62, lon: -115.62 };
  const dlon = 1200 / (111412.84 * Math.cos((36.62 * Math.PI) / 180) - 93.5 * Math.cos((3 * 36.62 * Math.PI) / 180));
  const B = { lat: 36.62, lon: -115.62 + dlon };
  await viewTo(frame, 36.62, -115.613, 4);
  await frame.evaluate(() => void window.gisworkbench.commands.run('los.airports'));
  let dlg = frame.locator('[data-id="dialog:avn-airports"]');
  await expect(dlg).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:avn-airports"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'New Airport…' }).click();
  const nd = frame.locator('[data-id="dialog:avn-new-airport"]');
  await nd.getByLabel('Identifier').fill('xdsrt');
  await nd.getByLabel('Name').fill('Desert test strip');
  const groundA = await frame.evaluate(([la, lo]) => window.gisworkbench.terrain.sample(la, lo).msl, [A.lat, A.lon]);
  await nd.getByLabel('Airport elevation (m)').fill(String(Math.round(groundA * 10) / 10));
  await nd.getByRole('button', { name: 'OK' }).click();
  dlg = frame.locator('[data-id="dialog:avn-airports"]');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Draw Runway' }).click();
  for (const q of [A, B]) {
    const s = await screenOf(frame, q.lat, q.lon);
    await page.mouse.click(s.x, s.y);
  }
  const ap = await frame.evaluate(() => window.gisworkbench.store.all('airport').find((a) => a.ident === 'XDSRT'));
  expect(ap.runways.length).toBe(1);
  const rw = ap.runways[0];
  expect(rw.id).toBe('09/27');
  // The clicked ends are within a panel pixel (≈ 8 m at this zoom) of the intended ones.
  expect(Math.abs(rw.length - 1200)).toBeLessThan(20);
  // Edit in the dialog: end 09 is a B(V) visual end; paved.
  await frame.evaluate(() => void window.gisworkbench.commands.run('los.airports'));
  dlg = frame.locator('[data-id="dialog:avn-airports"]');
  await expect(dlg.locator('[data-id="avn:runways"] tbody tr')).toHaveCount(2);
  await dlg.getByLabel('Part 77 category of end 27').selectOption('B(V)');
  await dlg.getByRole('button', { name: 'Save' }).click();
  // The cloud: flat ground 2 m below end 09 out to 900 m west of it, and a crane 600 m west of end 09
  // on the extended centreline, 70 m tall.
  const g09 = await frame.evaluate(() => window.gisworkbench.store.all('airport').find((a) => a.ident === 'XDSRT').runways[0].ends[0]);
  const mPerLon = 111412.84 * Math.cos((g09.lat * Math.PI) / 180) - 93.5 * Math.cos((3 * g09.lat * Math.PI) / 180);
  const mPerLat = 111132.95 - 559.82 * Math.cos((2 * g09.lat * Math.PI) / 180);
  const lines = [];
  for (let x = -900; x <= -20; x += 10) for (let y = -200; y <= 200; y += 10) lines.push(`${(g09.lon + x / mPerLon).toFixed(8)} ${(g09.lat + y / mPerLat).toFixed(8)} ${(g09.elev - 2).toFixed(2)}`);
  const crane = { lon: g09.lon - 600 / mPerLon, lat: g09.lat };
  for (let k = 0; k <= 70; k += 2) lines.push(`${crane.lon.toFixed(8)} ${crane.lat.toFixed(8)} ${(g09.elev - 2 + k).toFixed(2)}`);
  const r = await frame.evaluate(async ({ text, id }) => {
    const app = window.gisworkbench;
    app.asciiPick = { epsg: 4326, vertical: 'egm96' };
    const [c] = await app.openPointClouds([new File([text], 'crane.xyz', { type: 'text/plain' })]);
    const res = await app.aviation.evaluate({ airport: id, regime: 'part77', source: 'points', cloud: c, minPen: 0, draw: false });
    return { n: c.n, stats: res.stats, obstacles: res.obstacles, model: { kinds: res.model.surfaces.map((s) => s.kind) } };
  }, { text: lines.join('\n'), id: ap.id });
  expect(r.n).toBe(lines.length);
  expect(r.obstacles.length).toBe(1);
  const o = r.obstacles[0];
  // Hand check (§77.19(d)): B(V), unpaved? No — paved, so the primary surface ends 200 ft (60.96 m)
  // beyond the end; the crane is 600 − 60.96 = 539.04 m out on a 20:1 slope: 26.95 m above end 09.
  // Its top is 68 m above end 09's elevation: 41.05 m through, give or take the click (±0.5 m of
  // station → ±0.03 m of height) and the EGM96 round trip of the heights.
  expect(o.kind).toBe('approach');
  expect(Math.abs(o.limit - (g09.elev + 539.04 / 20))).toBeLessThan(0.2);
  expect(Math.abs(o.pen - (68 - 539.04 / 20))).toBeLessThan(0.2);
  expect(Math.abs(o.lat - crane.lat)).toBeLessThan(1e-6);
  expect(o.posts).toBeGreaterThan(10);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-78 SCN-72 Amendment 18 OFS/OES: the edition selector, and one obstacle survey under both editions', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await frame.evaluate(axeSource);
  // A runway on the meridian 115° W, 3 000 m north from 36° N, level at 100 m: a precision approach to
  // 36 (the south end), take-offs beyond 18 only. Stations s m north of the 36 threshold, offsets t m
  // east; metres per degree at 36° N.
  const mLat = 110950.6;
  const mLon = 111412.84 * Math.cos((36 * Math.PI) / 180) - 93.5 * Math.cos((3 * 36 * Math.PI) / 180);
  const at = (s, t) => [36 + s / mLat, -115 + t / mLon];
  const AP = {
    ident: 'SYNA',
    name: 'Synthetic 2030',
    elev: 100,
    source: 'test',
    runways: [{ id: '18/36', length: 3000, width: 45, paved: true, code: 4, ends: [{ id: '36', lat: 36, lon: -115, elev: 100, p77: 'PIR', icao: 2, disp: 0, thrElev: null, clearway: 0, approach: true, takeoff: false }, { id: '18', lat: 36 + 3000 / mLat, lon: -115, elev: 100, p77: 'PIR', icao: 2, disp: 0, thrElev: null, clearway: 0, approach: false, takeoff: true }] }],
  };
  // The survey: ground at 99 m every 50 m, and three masts, worked out here from the tables (ADG IV):
  // M1 (s 1 500, t 400, top 150 m): current edition, the 14.3 % transitional off the 140 m strip
  //   (Table 4-1) at 137.18 m → 12.82 m through; Amendment 18, the 20 % transitional (§4.2.2.5) at
  //   152 m → clear, but the missed approach component's transitional (Table 4-12: 115 m at 254.88 m
  //   off, 14.3 %) at 135.75 m → 14.25 m through an OES.
  // M2 (s −1 060, t 0, top 128 m): 2 % from 60 m out in both (Table 4-1; Table 4-12's approach
  //   component) → 8 m through; the OFS approach (Table 4-2, 3.33 %) at 133.3 m → clear.
  // M3 (s −500, t 0, top 140 m): 108.8 m in both → 31.2 m through; the current inner approach (zone)
  //   at 108.8 m, Amendment 18's OFS (approach and inner approach, 3.33 %) at 114.652 m → 25.348 m.
  const lines = [];
  for (let s = -1200; s <= 1600; s += 50) for (let t = -500; t <= 500; t += 50) lines.push(at(s, t).reverse().concat(99).map((v) => v.toFixed(8)).join(' '));
  const MASTS = { M1: [1500, 400, 150], M2: [-1060, 0, 128], M3: [-500, 0, 140] };
  for (const [s, t, top] of Object.values(MASTS)) for (let z = 99; z <= top + 1e-9; z += 1) lines.push(at(s, t).reverse().concat(z).map((v) => v.toFixed(8)).join(' '));
  const ids = await frame.evaluate(async ({ ap, text }) => {
    const app = window.gisworkbench;
    Object.assign(app.runMode.caps, { fsaSave: false, fsaPicker: false });
    app.__saved = [];
    app.saveCapture = (blob, name) => app.__saved.push({ blob, name });
    app.asciiPick = { epsg: 4326, vertical: 'egm96' };
    const [c] = await app.openPointClouds([new File([text], 'masts.xyz', { type: 'text/plain' })]);
    app.aviation.current = await app.aviation.addAirport(ap);
    return { airport: app.aviation.current, n: c.n };
  }, { ap: AP, text: lines.join('\n') });
  expect(ids.n).toBe(lines.length);
  // The dialog: Annex 14 follows the analysis date; from 21 November 2030 Amendment 18, which asks for
  // each runway's design group and take-off mass.
  await frame.evaluate(() => void window.gisworkbench.commands.run('los.obstruction'));
  const dlg = frame.locator('[data-id="dialog:avn-obstruction"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Surfaces', { exact: true }).selectOption('icao');
  await expect(dlg.getByLabel('Annex 14 edition')).toHaveValue('icao'); // today, before 2030
  await expect(dlg.locator('[data-id="avn:edition"]')).toHaveText('Follows ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20 November 2030.');
  await expect(dlg.locator('[data-id="avn:a18"]')).toBeHidden();
  await dlg.getByLabel('Analysis date').fill('2030-11-21');
  await expect(dlg.getByLabel('Annex 14 edition')).toHaveValue('icao-a18');
  await expect(dlg.locator('[data-id="avn:edition"]')).toHaveText('Follows ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable from 21 November 2030: obstacle free surfaces and obstacle evaluation surfaces.');
  await expect(dlg.locator('[data-id="avn:a18"]')).toBeVisible();
  await dlg.getByLabel('Analysis date').fill('2030-11-20');
  await expect(dlg.getByLabel('Annex 14 edition')).toHaveValue('icao');
  await dlg.getByLabel('Analysis date').fill('2031-01-01');
  await dlg.getByLabel('Aeroplane design group of runway 18/36').selectOption('IV');
  await dlg.getByLabel('Maximum take-off mass on runway 18/36 (kg)').fill('300000');
  expect(await axeOn(frame, '[data-id="dialog:avn-obstruction"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Evaluate' }).click();
  const res = frame.locator('[data-id="dialog:avn-results"]');
  await expect(res).toBeVisible({ timeout: 120000 });
  await expect(res.locator('[data-id="avn:edition"]')).toHaveText(/Chapter 4 as applicable from 21 November 2030: obstacle free surfaces and obstacle evaluation surfaces\.$/);
  await expect(res.locator('[data-id="avn:summary"]')).toContainText('SYNA (ICAO Annex 14 OFS/OES (2030)) against masts.xyz');
  await expect(res.getByRole('heading', { name: 'Obstacle free surfaces' })).toBeVisible();
  await expect(res.locator('[data-id="avn:zone-penetrations"] tbody tr')).toHaveCount(1);
  await expect(res.locator('[data-id="avn:assumptions"] li').first()).toBeVisible();
  const shownAssumptions = await res.locator('[data-id="avn:assumptions"] li').allTextContents();
  expect(shownAssumptions.some((x) => /^The transitional surfaces start at the strip edge/.test(x))).toBe(true);
  expect(await axeOn(frame, '[data-id="dialog:avn-results"]')).toEqual([]);
  await res.getByRole('button', { name: 'Export CSV' }).click();
  await res.getByRole('button', { name: 'Export GeoJSON' }).click();
  await res.getByRole('button', { name: 'Surfaces as KML' }).click();
  await res.locator('.dlg-buttons').getByRole('button', { name: 'Close' }).click();
  const A18 = 'ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable from 21 November 2030: obstacle free surfaces and obstacle evaluation surfaces';
  const csv = await savedText(frame, /^penetrations-SYNA-icao-a18\.csv$/);
  expect(csv.text.split('\n')[0].endsWith(',obstacle_free_zone,edition')).toBe(true);
  expect(csv.text).toContain(`"${A18}"`);
  const gj = JSON.parse((await savedText(frame, /^penetrations-SYNA-icao-a18\.geojson$/)).text);
  expect(gj.gisWorkbench.edition).toBe(A18);
  expect(gj.gisWorkbench.assumptions.length).toBe(shownAssumptions.length);
  const skml = await savedText(frame, /^surfaces-SYNA-icao-a18\.kml$/);
  expect(skml.text).toContain(A18);
  expect(skml.text).toMatch(/<Folder><name>Precision approach surface 36, missed approach component<\/name>/);
  expect(skml.text).toMatch(/<Folder><name>Horizontal surface, 90 m above the aerodrome<\/name>/);
  const kept = await frame.evaluate(() => ({ rec: window.gisworkbench.store.all('obstruction').at(-1), rwy: window.gisworkbench.store.all('airport').find((a) => a.ident === 'SYNA').runways[0] }));
  expect(kept.rec.edition).toBe(A18);
  expect(kept.rec.assumptions.length).toBe(shownAssumptions.length);
  expect([kept.rwy.adg, kept.rwy.mtom]).toEqual(['IV', 300000]);
  // SCN-72: the same survey under both editions, through the API.
  const both = await frame.evaluate(async (id) => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const out = {};
    for (const regime of ['icao', 'icao-a18']) {
      const r = await app.aviation.evaluate({ airport: id, regime, source: 'points', cloud: c, minPen: 0, draw: false, keep: false });
      const pick = (o) => ({ lat: o.lat, lon: o.lon, z: o.z, limit: o.limit, pen: o.pen, kind: o.kind });
      out[regime] = { edition: r.edition, low: r.obstacles.map(pick), zone: (r.zone?.obstacles ?? []).map(pick) };
    }
    return out;
  }, ids.airport);
  const which = (o) => Object.entries(MASTS).find(([, [s, t]]) => Math.abs(o.lat - at(s, t)[0]) < 2e-6 && Math.abs(o.lon - at(s, t)[1]) < 2e-6)?.[0];
  const table = (list) => Object.fromEntries(list.map((o) => [which(o), [+o.pen.toFixed(2), o.kind]]));
  const close = (got, want) => {
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const [k, [pen, kind]] of Object.entries(want)) {
      expect(Math.abs(got[k][0] - pen), `${k}: ${got[k]}`).toBeLessThan(0.2);
      expect(got[k][1], k).toBe(kind);
    }
  };
  close(table(both.icao.low), { M1: [12.82, 'transitional'], M2: [8, 'approach'], M3: [31.2, 'approach'] });
  close(table(both.icao.zone), { M3: [31.2, 'innerApproach'] });
  close(table(both['icao-a18'].low), { M1: [14.25, 'precisionTransitional'], M2: [8, 'precisionApproach'], M3: [31.2, 'precisionApproach'] });
  expect(Object.keys(table(both['icao-a18'].zone))).toEqual(['M3']);
  expect(Math.abs(table(both['icao-a18'].zone).M3[0] - 25.348)).toBeLessThan(0.2);
  expect(both.icao.edition).toMatch(/until 20 November 2030$/);
  expect(both['icao-a18'].edition).toBe(A18);
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});

test('REQ-GAP-74 a route on the map: legs, profile against the DSM, warnings, KML and GPX', async ({ page }) => {
  test.skip(!haveDsm, 'the corpus DSM dem-under-vegas is not on this machine');
  test.setTimeout(400000);
  mkdirSync(OUT, { recursive: true });
  const { frame, logs } = await withDsm(page);
  // North Las Vegas airport, Kyle Canyon, and past Mount Charleston (3 633 m).
  const wps = [
    { lat: 36.2133, lon: -115.1964 },
    { lat: 36.3, lon: -115.48 },
    { lat: 36.27, lon: -115.72 },
  ];
  await viewTo(frame, 36.25, -115.45, 0.3);
  await frame.evaluate(() => window.gisworkbench.tools.select('gps.route'));
  for (const q of wps) {
    const s = await screenOf(frame, q.lat, q.lon);
    await page.mouse.click(s.x, s.y);
  }
  await frame.evaluate(() => window.gisworkbench.tools.current.onEnter(window.gisworkbench.activePane()));
  await frame.waitForFunction(() => window.gisworkbench.store.all('graphic').some((g) => g.gps === 'route'));
  const route = await frame.evaluate(() => window.gisworkbench.store.all('graphic').find((g) => g.gps === 'route'));
  expect(route.coords.length).toBe(3);
  await frame.evaluate(() => void window.gisworkbench.commands.run('gps.flightplan'));
  const dlg = frame.locator('[data-id="dialog:flight-plan"]');
  await expect(dlg).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:flight-plan"]')).toEqual([]);
  await dlg.locator('[data-id="fp:name"]').fill('VGT-CHARLESTON');
  for (const [i, n] of ['VGT', 'KYLE', 'WEST'].entries()) await dlg.locator(`[data-id="fp:wp:${i}"]`).fill(n);
  await dlg.locator('[data-id="fp:alt:0"]').fill('8500');
  await dlg.locator('[data-id="fp:speed:0"]').fill('110');
  await dlg.locator('[data-id="fp:alt:1"]').fill('11000');
  await dlg.locator('[data-id="fp:speed:1"]').fill('120');
  await dlg.locator('[data-id="fp:clearance"]').fill('1000');
  await dlg.locator('[data-id="fp:departure"]').fill('2026-11-03T15:00:00Z');
  await expect(dlg.locator('[data-id="fp:warning"]').first()).toBeVisible();
  const warnings = await dlg.locator('[data-id="fp:warning"]').allTextContents();
  const shown = { dist: await dlg.locator('[data-id="fp:dist:0"]').textContent(), course: await dlg.locator('[data-id="fp:course:0"]').textContent(), time: await dlg.locator('[data-id="fp:time:0"]').textContent(), clear1: await dlg.locator('[data-id="fp:clear:1"]').textContent() };
  await dlg.getByRole('button', { name: 'Export KML' }).click();
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Export GPX' }).click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  const plan = await frame.evaluate((id) => window.gisworkbench.flightPlan.planOf(id), route.id);
  expect(plan.name).toBe('VGT-CHARLESTON');
  expect(plan.waypoints.map((w) => w.name)).toEqual(['VGT', 'KYLE', 'WEST']);
  expect(plan.legs[0].alt).toBeCloseTo(8500 * FT, 6);
  expect(plan.legs[1].speed).toBeCloseTo(120 * KT, 6);
  const calc = await frame.evaluate((p) => window.gisworkbench.flightPlan.compute(p), plan);
  // Distances and courses against GeographicLib (independent of the app's Rust core).
  for (const [i, L] of calc.table.legs.entries()) {
    const a = plan.waypoints[i];
    const b = plan.waypoints[i + 1];
    const g = G.Inverse(a.lat, a.lon, b.lat, b.lon);
    expect(Math.abs(L.distance - g.s12)).toBeLessThan(0.001);
    expect(Math.abs(((L.course - g.azi1 + 540) % 360) - 180)).toBeLessThan(1e-6);
    expect(L.time).toBeCloseTo(g.s12 / plan.legs[i].speed, 6);
  }
  expect(shown.dist).toBe((calc.table.legs[0].distance / 1852).toFixed(1));
  // Leg 2 at 11 000 ft crosses the Spring Mountains: the DSM read here, along the geodesic every
  // 30 m, finds the highest ground; the app's profile minimum clearance must agree within 15 m
  // (bilinear sampling against nearest posts here).
  const b = readFileSync(DSM);
  const tif = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const im = await tif.getImage();
  const [x0, y0] = im.getOrigin();
  const [dx, dy] = im.getResolution();
  const W = im.getWidth();
  const leg2 = G.InverseLine(plan.waypoints[1].lat, plan.waypoints[1].lon, plan.waypoints[2].lat, plan.waypoints[2].lon);
  // Sampled every 30 m: the highest post next to the path (an upper bound of any interpolation)
  // and the highest of the lowest posts around each sample (a lower bound), whichever way the
  // tile's tie point is registered (centre or corner).
  const pts = [];
  for (let s = 0; s <= leg2.s13; s += 30) {
    const q = leg2.Position(s);
    pts.push([(q.lon2 - x0) / dx, (q.lat2 - y0) / dy]);
  }
  const iMin = Math.floor(Math.min(...pts.map((p) => p[0]))) - 2;
  const iMax = Math.ceil(Math.max(...pts.map((p) => p[0]))) + 2;
  const jMin = Math.floor(Math.min(...pts.map((p) => p[1]))) - 2;
  const jMax = Math.ceil(Math.max(...pts.map((p) => p[1]))) + 2;
  const [win] = await im.readRasters({ window: [iMin, jMin, iMax + 1, jMax + 1] });
  const at = (i, j) => win[(j - jMin) * (iMax - iMin + 1) + (i - iMin)];
  let top = -Infinity;
  let low = -Infinity;
  for (const [fx, fy] of pts) {
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const nb = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) nb.push(at(i0 + di, j0 + dj));
    top = Math.max(top, ...nb);
    low = Math.max(low, Math.min(...nb));
  }
  const appTop = 11000 * FT - calc.profile.legs[1].minClearance;
  expect(appTop).toBeLessThanOrEqual(top + 0.5);
  expect(appTop).toBeGreaterThanOrEqual(low - 0.5);
  expect(top).toBeGreaterThan(11000 * FT); // the ridge reaches above the leg: a terrain warning
  expect(warnings.some((w) => /^Leg 2 \(KYLE → WEST\): the terrain reaches/.test(w))).toBe(true);
  expect(shown.clear1).toMatch(/^-\d+ ⚠$/);
  // The exports.
  const kml = await savedText(frame, /\.kml$/);
  const gpx = await savedText(frame, /\.gpx$/);
  expect(kml.name).toBe('VGT-CHARLESTON.kml');
  expect(kml.text).toMatch(/<LineString><altitudeMode>absolute<\/altitudeMode>/);
  expect((gpx.text.match(/<rtept /g) ?? []).length).toBe(3);
  expect(gpx.text).toMatch(/<name>KYLE<\/name><extensions><gw:speed>61\.733<\/gw:speed>/);
  // Import each back: the GPX keeps names, altitudes and speeds; KML round-trips the plan.
  const back = await frame.evaluate(async ({ gpx, kml }) => {
    const F = window.gisworkbench.flightPlan;
    const out = {};
    for (const [k, text, name] of [['gpx', gpx, 'r.gpx'], ['kml', kml, 'r.kml']]) {
      const [id] = await F.importRoutes({ text, name });
      out[k] = F.planOf(id);
    }
    let refused = null;
    try {
      F.readRoutes('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><gpx/>', 'evil.gpx');
    } catch (e) {
      refused = e.message;
    }
    // A route in a format the app does not read is refused by name.
    let unread = null;
    try {
      F.readRoutes('<?xml version="1.0"?><event version="2.0" type="b-m-r"/>', 'old.cot');
    } catch (e) {
      unread = e.message;
    }
    return { ...out, refused, unread };
  }, { gpx: gpx.text, kml: kml.text });
  for (const k of ['gpx', 'kml']) {
    expect(back[k].waypoints.map((w) => w.name), k).toEqual(['VGT', 'KYLE', 'WEST']);
    back[k].legs.forEach((l, i) => {
      expect(Math.abs(l.alt - plan.legs[i].alt), k).toBeLessThan(0.01);
      expect(Math.abs(l.speed - plan.legs[i].speed), k).toBeLessThan(0.001);
    });
    back[k].waypoints.forEach((w, i) => expect(Math.abs(w.lat - plan.waypoints[i].lat) + Math.abs(w.lon - plan.waypoints[i].lon), k).toBeLessThan(1e-6));
  }
  expect(back.refused).toMatch(/DTD/);
  expect(back.unread).toMatch(/old\.cot is not a GPX or KML route/);
  writeFileSync(join(OUT, 'route-vgt-charleston.json'), JSON.stringify({ shown, warnings, legs: calc.table.legs, minClearance: calc.profile.legs.map((l) => l.minClearance), dsmPostTopLeg2: top, dsmLowerBoundLeg2: low, appTopLeg2: appTop, profileStep: calc.profile.step }, null, 1));
  expect(logs.filter((l) => !/favicon/.test(l))).toEqual([]);
});
