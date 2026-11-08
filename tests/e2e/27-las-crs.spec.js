// Assign CRS for LAS and LAZ (2.7.0 I1, REQ-LDR-14, REG-029, SDP-2.7 §4.7) on the built file.
// SCN-73: a LAS with no usable CRS (TE-015: EPSG:4326 over X 1–226, Y 1–100) opens in the local
// frame, takes a CRS through Point Cloud ▸ Assign CRS, and its CE90 against proj4js from the file's
// own coordinates is measured. A LAZ with a CRS is changed through the confirmation; assigning the
// CRS it states gives the same cloud, and the US-feet LAS meets the FX-09 truth.
import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import proj4 from 'proj4';
import { openApp, openFiles } from './helpers.js';

const TMP = mkdtempSync(join(tmpdir(), 'gw27lascrs-'));
const TE015 = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'lidar-las-version-matrix', 'laspy', 'simple1_4.las');
const FX09 = (n) => resolve('fixtures/fx09', n);
const truth = JSON.parse(readFileSync(FX09('fx09_truth.json'), 'utf8'));
const UTM11 = '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs';
test.describe.configure({ timeout: 300000 });
test.afterAll(() => rmSync(TMP, { recursive: true, force: true }));

/** A LAS 1.2 point format 0 shaped like TE-015: a 226 × 100 grid whose GeoKeys say EPSG:4326. */
function writeTe015Like(file) {
  const keys = [[1024, 0, 1, 2], [2048, 0, 1, 4326]]; // geographic; GeographicTypeGeoKey = WGS 84
  const dir = Buffer.alloc(8 + 8 * keys.length);
  [1, 1, 0, keys.length].forEach((v, i) => dir.writeUInt16LE(v, 2 * i));
  keys.forEach((k, i) => k.forEach((v, j) => dir.writeUInt16LE(v, 8 + 8 * i + 2 * j)));
  const vh = Buffer.alloc(54);
  vh.write('LASF_Projection', 2, 'latin1');
  vh.writeUInt16LE(34735, 18);
  vh.writeUInt16LE(dir.length, 20);
  vh.write('GeoKeyDirectoryTag', 22, 'latin1');
  const n = 226 * 100;
  const recs = Buffer.alloc(20 * n);
  let k = 0;
  for (let y = 1; y <= 100; y++)
    for (let x = 1; x <= 226; x++, k++) {
      recs.writeInt32LE(x * 100, 20 * k);
      recs.writeInt32LE(y * 100, 20 * k + 4);
      recs.writeInt32LE((44 + ((x * 7 + y * 3) % 210)) * 100, 20 * k + 8);
      recs.writeUInt8(0x09, 20 * k + 14); // return 1 of 1
      recs.writeUInt8(2, 20 * k + 15);
    }
  const b = Buffer.alloc(227);
  b.write('LASF', 0, 'latin1');
  b.writeUInt8(1, 24);
  b.writeUInt8(2, 25);
  b.write('GIS Workbench TE-015 shape', 26, 'latin1');
  b.write('27-las-crs.spec.js', 58, 'latin1');
  b.writeUInt16LE(227, 94);
  b.writeUInt32LE(227 + 54 + dir.length, 96);
  b.writeUInt32LE(1, 100);
  b.writeUInt8(0, 104);
  b.writeUInt16LE(20, 105);
  b.writeUInt32LE(n, 107);
  b.writeUInt32LE(n, 111);
  [0.01, 0.01, 0.01].forEach((s, a) => b.writeDoubleLE(s, 131 + 8 * a));
  [[226, 1], [100, 1], [253, 44]].forEach(([max, min], a) => {
    b.writeDoubleLE(max, 179 + 16 * a);
    b.writeDoubleLE(min, 187 + 16 * a);
  });
  writeFileSync(file, Buffer.concat([b, vh, dir, recs]));
  return file;
}

/** X, Y, Z of every point of an uncompressed LAS, from the file alone (the oracle's input). */
function lasXyz(file) {
  const u = readFileSync(file);
  const minor = u.readUInt8(25);
  const po = u.readUInt32LE(96);
  const rl = u.readUInt16LE(105);
  const n = minor >= 4 ? Number(u.readBigUInt64LE(247)) || u.readUInt32LE(107) : u.readUInt32LE(107);
  const s = [0, 1, 2].map((a) => u.readDoubleLE(131 + 8 * a));
  const o = [0, 1, 2].map((a) => u.readDoubleLE(155 + 8 * a));
  const xyz = new Float64Array(3 * n);
  for (let k = 0; k < n; k++) for (let a = 0; a < 3; a++) xyz[3 * k + a] = u.readInt32LE(po + rl * k + 4 * a) * s[a] + o[a];
  return { n, xyz };
}

/** Geodetic position of every point of a cloud, by file index. */
const geoByFileIndex = (frame, which) =>
  frame.evaluate((which) => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()].filter((x) => (which === 'assigned' ? x.crs.assigned : !x.crs.assigned)).at(-1);
    const out = new Float64Array(3 * c.n);
    for (let k = 0; k < c.n; k++) {
      const g = app.pc.toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
      out.set([g.lat, g.lon, g.hae], 3 * c.order[k]);
    }
    return { geo: Array.from(out), crs: { label: c.crs.label, local: c.crs.local, assigned: c.crs.assigned, warnings: c.crs.warnings } };
  }, which);

for (const [tag, make] of [['TE-015 shape', () => writeTe015Like(join(TMP, 'te015_shape.las'))], ['TE-015 file', () => TE015]]) {
  test(`REQ-LDR-14 SCN-73 ${tag}: no usable CRS, Assign CRS through the command, CE90 against proj4js`, async ({ page }) => {
    const file = make();
    test.skip(!existsSync(file), 'the T&E corpus is not here');
    const { frame, logs } = await openApp(page, 'file');
    const log = await openFiles(frame, [file]);
    expect(log.flatMap((r) => r.errors)).toEqual([]);
    expect(log.flatMap((r) => r.warnings).join(' ')).toMatch(/not valid longitudes and latitudes.*Assign CRS/);
    await frame.waitForFunction(() => window.gisworkbench.pointClouds.size === 1, null, { timeout: 60000 });
    expect(await frame.evaluate(() => [...window.gisworkbench.pointClouds.values()][0].crs.local)).toBe(true);

    // Point Cloud ▸ Assign CRS: no confirmation for a cloud in the local frame.
    expect(await frame.evaluate(() => window.gisworkbench.commands.enabled('pc.assigncrs'))).toBe(true);
    void frame.evaluate(() => window.gisworkbench.commands.run('pc.assigncrs'));
    const dlg = frame.locator('[data-id="dialog:pc-assigncrs"]');
    await expect(dlg).toBeVisible();
    await dlg.getByLabel('EPSG code').fill('32611');
    await dlg.locator('.btn-primary').click();
    await frame.waitForFunction(() => [...window.gisworkbench.pointClouds.values()].some((c) => c.crs.assigned), null, { timeout: 60000 });

    expect(await frame.evaluate(() => window.gisworkbench.pointClouds.size)).toBe(1);
    const r = await geoByFileIndex(frame, 'assigned');
    expect(r.crs).toMatchObject({ label: 'EPSG:32611', local: false, assigned: { epsg: 32611, vertical: 'hae' } });
    expect(r.crs.warnings.join(' ')).not.toMatch(/local metric frame|not valid longitudes/);

    // CE90 and LE90 of the placed cloud against proj4js applied to the file's own coordinates.
    const { n, xyz } = lasXyz(file);
    const to = proj4(UTM11, '+proj=longlat +datum=WGS84 +no_defs');
    const ky = 110574; // metres per degree of latitude near the equator
    const horiz = new Float64Array(n);
    const vert = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const [lon, lat] = to.forward([xyz[3 * k], xyz[3 * k + 1]]);
      const [glat, glon, ghae] = r.geo.slice(3 * k, 3 * k + 3);
      horiz[k] = Math.hypot((glat - lat) * ky, (glon - lon) * ky * Math.cos((lat * Math.PI) / 180));
      vert[k] = Math.abs(ghae - xyz[3 * k + 2]);
    }
    const p90 = (a) => Float64Array.from(a).sort()[Math.floor(0.9 * (a.length - 1))];
    const ce90 = p90(horiz);
    const le90 = p90(vert);
    console.log(JSON.stringify({ scn: 'SCN-73', file: tag, n, ce90, le90, max: Math.max(...horiz) }));
    expect(ce90).toBeLessThan(0.01);
    expect(le90).toBeLessThan(0.01);

    // The assignment is kept with the layer, and in the project file.
    const rec = await frame.evaluate(async () => {
      const app = window.gisworkbench;
      const { readProject, serialiseProject } = app.__test;
      return readProject(serialiseProject(app)).records.filter((x) => x.type === 'pointcloud').map((x) => x.assigned ?? null);
    });
    expect(rec).toEqual([null, { epsg: 32611, vertical: 'hae' }]);
    const imp = await frame.evaluate(() => window.gisworkbench.importLog.at(-1).warnings.join(' '));
    expect(imp).toMatch(/CRS assigned: EPSG:32611/);
    expect(logs).toEqual([]);
  });
}

test('REQ-LDR-14 LAZ and LAS with a CRS: Change CRS asks first; the stated CRS gives the same cloud; US feet meet the truth', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  const log = await openFiles(frame, [FX09('fx09.laz')]);
  expect(log.flatMap((r) => r.errors)).toEqual([]);
  await frame.waitForFunction(() => window.gisworkbench.pointClouds.size === 1, null, { timeout: 120000 });

  // Cancel at the confirmation leaves the cloud alone.
  void frame.evaluate(() => window.gisworkbench.commands.run('pc.assigncrs'));
  const ask = frame.locator('[data-id="dialog:pc-changecrs"]');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('EPSG:32611');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(ask).toBeHidden();
  expect(await frame.evaluate(() => window.gisworkbench.pointClouds.size)).toBe(1);

  // Change CRS… to the CRS the file states: the same points in the same places.
  await frame.evaluate(() => (window.__before = [...window.gisworkbench.pointClouds.values()][0]));
  void frame.evaluate(() => window.gisworkbench.commands.run('pc.assigncrs'));
  await ask.locator('.btn-primary').click();
  const dlg = frame.locator('[data-id="dialog:pc-assigncrs"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('EPSG code').fill('32611');
  await dlg.getByLabel('Heights').selectOption('egm96');
  await dlg.locator('.btn-primary').click();
  await frame.waitForFunction(() => [...window.gisworkbench.pointClouds.values()].some((c) => c.crs.assigned), null, { timeout: 120000 });
  const same = await frame.evaluate(() => {
    const a = window.__before;
    const all = [...window.gisworkbench.pointClouds.values()];
    const b = all[0];
    let d = 0;
    for (let k = 0; k < a.pos.length; k++) d = Math.max(d, Math.abs(a.pos[k] - b.pos[k]));
    return { size: all.length, n: [a.n, b.n], d, origin: [a.origin, b.origin], crs: b.crs.label, vertical: b.crs.vertical, drawn: window.gisworkbench.activePane().view3d.clouds.map((x) => x.cloud.id === b.id) };
  });
  expect(same.size).toBe(1); // the old cloud is gone from the app, not only from the panel
  expect(same.n[0]).toBe(same.n[1]);
  expect(same.d).toBeLessThan(1e-3);
  expect(same.origin[1]).toEqual(same.origin[0]);
  expect([same.crs, same.vertical]).toEqual(['EPSG:32611', 'egm96']);
  expect(same.drawn).toEqual([true]); // the new cloud replaced the old one in the panel

  // US feet (EPSG:2229, NAVD88 ftUS in the file): assigned with EGM96 heights, it meets the truth.
  await openFiles(frame, [FX09('fx09_ftus.las')]);
  await frame.waitForFunction(() => [...window.gisworkbench.pointClouds.values()].some((c) => /ftus/.test(c.name)), null, { timeout: 60000 });
  const ft = await frame.evaluate(async (truth) => {
    const app = window.gisworkbench;
    const c0 = [...app.pointClouds.values()].find((c) => /ftus/.test(c.name));
    const c = await app.pc.assignCrs(c0, { epsg: 2229, vertical: 'egm96' });
    const inv = new Int32Array(c.n);
    for (let k = 0; k < c.n; k++) inv[c.order[k]] = k;
    let dh = 0;
    let dz = 0;
    for (const p of truth.ftus.points) {
      const k = inv[p.k];
      const g = app.pc.toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
      dh = Math.max(dh, app.core.inverse(g.lat, g.lon, p.lat, p.lon).distance);
      dz = Math.max(dz, Math.abs(g.hae - p.hae));
    }
    return { dh, dz, hUnit: c.crs.hUnit, vUnit: c.crs.vUnit, label: c.crs.label };
  }, truth);
  expect(ft.label).toBe('EPSG:2229');
  expect(ft.hUnit).toBeCloseTo(1200 / 3937, 9);
  expect(ft.vUnit).toBeCloseTo(1200 / 3937, 9);
  expect(ft.dh).toBeLessThan(0.01);
  expect(ft.dz).toBeLessThan(0.01);
  expect(logs).toEqual([]);
});
