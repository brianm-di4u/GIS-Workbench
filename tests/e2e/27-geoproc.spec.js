// SCN-67 REQ-GAP-79 vector geoprocessing in the built file: parcel, road and point layers opened as
// GeoJSON; a geodesic buffer of the roads through Feature ▸ Geoprocessing ▸ Buffer; overlay of the
// parcels with a shifted parcel set; dissolve by zone; spatial joins. The parcels are the ones
// tests/unit/geoproc.test.js checks against GEOS through GDAL, so the counts here are GEOS's.
import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles } from './helpers.js';
import { localFrame } from '../../app/src/analysis/geoproc.js';

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
// The same generator as tests/unit/geoproc.test.js.
function parcels(n, { lat0 = 39.74, lon0 = -104.99, cell = 100, shift = 0, seed = 5 } = {}) {
  const F = localFrame(lat0, lon0);
  const rnd = lcg(seed);
  const corner = new Map();
  const c = (i, j) => {
    const k = `${i},${j}`;
    if (!corner.has(k)) corner.set(k, [(i + shift) * cell + (rnd() - 0.5) * cell * 0.3, (j + shift) * cell + (rnd() - 0.5) * cell * 0.3]);
    return corner.get(k);
  };
  const out = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const ring = [c(i, j), c(i + 1, j), c(i + 1, j + 1), c(i, j + 1)].map(([x, y]) => F.from(x, y));
      out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: { pid: `${shift ? 'B' : 'A'}${i}-${j}`, zone: `Z${(i * 7 + j * 3) % 5}`, value: (i + 1) * (j + 2) } });
    }
  return { type: 'FeatureCollection', features: out };
}
function points(n, { lat0 = 39.74, lon0 = -104.99, span = 2000, seed = 9 } = {}) {
  const F = localFrame(lat0, lon0);
  const rnd = lcg(seed);
  return { type: 'FeatureCollection', features: Array.from({ length: n }, (_, k) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: F.from(rnd() * span, rnd() * span) }, properties: { k, v: Math.round(rnd() * 100) } })) };
}
function roads(lat0 = 39.74, lon0 = -104.99) {
  const F = localFrame(lat0, lon0);
  const L = (pts, name) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts.map(([x, y]) => F.from(x, y)) }, properties: { name } });
  return { type: 'FeatureCollection', features: [L([[-50, 330], [700, 360], [1400, 300], [2050, 420]], 'East'), L([[810, -40], [790, 900], [860, 2040]], 'North'), L([[0, 0], [600, 600], [650, 1500]], 'Diagonal')] };
}

test('SCN-67 REQ-GAP-79 buffer, overlay, dissolve and spatial join on a parcel set', async ({ page }, info) => {
  test.setTimeout(300000);
  const dir = info.outputPath('layers');
  mkdirSync(dir, { recursive: true });
  const files = { 'parcels.geojson': parcels(20), 'parcels-b.geojson': parcels(20, { shift: 0.5, seed: 6 }), 'roads.geojson': roads(), 'points.geojson': points(400) };
  for (const [n, fc] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(fc));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, Object.keys(files).map((n) => join(dir, n)));
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 4, null, { timeout: 60000 });
  const ids = await frame.evaluate(() => Object.fromEntries(window.gisworkbench.store.all('vlayer').map((v) => [v.name, v.id])));
  const id = (n) => ids[n] ?? ids[`${n}.geojson`];

  // Buffer through the ribbon command's dialog: the roads, 40 m, geodesic, flat ends.
  await frame.evaluate((rid) => {
    window.gisworkbench.prefs.set('vlayerActive', rid);
    window.gisworkbench.commands.run('vec.buffer'); // resolves when the dialog closes and the job is done
  }, id('roads'));
  const dlg = frame.locator('[data-id="dialog:vec-buffer"]');
  await expect(dlg).toBeVisible();
  await dlg.getByLabel('Distance (m)').fill('40');
  await dlg.getByLabel('Line ends').selectOption('flat');
  await dlg.getByRole('button', { name: 'Run' }).click();
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').some((v) => /buffer 40 m$/.test(v.name)), null, { timeout: 120000 });

  const r = await frame.evaluate(async (L) => {
    const app = window.gisworkbench;
    const feats = (lid) => app.store.all('feature').filter((f) => f.vlayer === lid);
    const area = (g) => {
      // Geodesic area of every polygon of a feature (WGS 84, core bundle).
      const groups = [];
      let ps = [];
      const rings = g.parts.map((s, i) => g.xyz.slice(3 * s, 3 * (g.parts[i + 1] ?? g.xyz.length / 3)));
      for (const [k, r] of rings.entries()) {
        if ((g.polys ?? [0]).includes(k) && ps.length) (groups.push(ps), (ps = []));
        ps.push(r);
      }
      groups.push(ps);
      let a = 0;
      for (const rs of groups)
        rs.forEach((r, k) => {
          const pts = [];
          for (let i = 0; i < r.length; i += 3) pts.push([r[i + 1], r[i]]);
          a += (k ? -1 : 1) * Math.abs(app.core.polygonArea(pts).area);
        });
      return a;
    };
    const buf = app.store.all('vlayer').find((v) => /buffer 40 m$/.test(v.name));
    const bf = feats(buf.id);
    const inter = await app.geoproc.overlay(L.a, L.b, 'intersect');
    const uni = await app.geoproc.overlay(L.a, L.b, 'union');
    const dis = await app.geoproc.dissolve(L.a, 'zone');
    const jn = await app.geoproc.join(L.a, L.pts, { predicate: 'intersects', field: 'v' });
    const within = await app.geoproc.join(L.pts, L.a, { predicate: 'within', field: 'value' });
    const near = await app.geoproc.join(L.pts, L.roads, { predicate: 'nearest' });
    const sum = (lid) => feats(lid).reduce((s, f) => s + area(f.geom), 0);
    return {
      buffer: { n: bf.length, names: bf.map((f) => f.name), area: sum(buf.id) },
      inter: { n: feats(inter).length, fields: Object.keys(feats(inter)[0].attrs), area: sum(inter) },
      union: { n: feats(uni).length },
      parcelsArea: sum(L.a),
      dissolve: { zones: feats(dis).map((f) => f.attrs.zone).sort(), count: feats(dis).reduce((s, f) => s + f.attrs.count, 0), area: sum(dis) },
      join: { matched: feats(jn).filter((f) => f.attrs.join_count > 0).length, total: feats(jn).reduce((s, f) => s + f.attrs.join_count, 0) },
      within: { matched: feats(within).filter((f) => f.attrs.join_count > 0).length },
      near: { names: [...new Set(feats(near).map((f) => f.attrs.join_name))].sort(), max: Math.max(...feats(near).map((f) => f.attrs.join_distance)) },
      layers: app.store.all('vlayer').length,
    };
  }, { a: id('parcels'), b: id('parcels-b'), pts: id('points'), roads: id('roads') });
  console.log(JSON.stringify(r));
  // Buffer: one zone per road, flat ends: length × 80 m within 1 % (round joins add, inner bends
  // take away). The roads are 2,114 + 2,082 + 1,750 m long.
  expect(r.buffer.n).toBe(3);
  expect(r.buffer.names.sort()).toEqual(['Diagonal', 'East', 'North']);
  expect(Math.abs(r.buffer.area - 5946 * 80) / (5946 * 80)).toBeLessThan(0.01);
  // Overlay: GEOS's 1,521 intersecting pairs (tests/unit/geoproc.test.js), with both layers' fields.
  expect(r.inter.n).toBe(1521);
  expect(r.inter.fields).toEqual(expect.arrayContaining(['pid', 'zone', 'value', 'pid_2', 'zone_2', 'value_2']));
  expect(r.union.n).toBe(1599);
  // Dissolve: five zones holding all 400 parcels, with the parcels' area.
  expect(r.dissolve.zones).toEqual(['Z0', 'Z1', 'Z2', 'Z3', 'Z4']);
  expect(r.dissolve.count).toBe(400);
  expect(Math.abs(r.dissolve.area - r.parcelsArea) / r.parcelsArea).toBeLessThan(1e-6);
  // Joins: GEOS's counts (251 parcels hold a point; 399 points lie in a parcel).
  expect(r.join.matched).toBe(251);
  expect(r.join.total).toBe(399);
  expect(r.within.matched).toBe(399);
  expect(r.near.names).toEqual(['Diagonal', 'East', 'North']);
  expect(r.layers).toBe(4 + 7);
  expect(logs).toEqual([]);
});
