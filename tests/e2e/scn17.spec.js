// SCN-17 GIS round trip of vectors on FX-12 (AC-17.2..17.4; AC-17.1/17.5 are GeoPackage, R2):
// the same vectors as GeoJSON, Shapefile, KML and KMZ open with the truth count, coordinates
// (1e-9°), Z, attributes in Arabic, Cyrillic and CJK; Shapefile reports its field-name map and
// truncation; GeoJSON has no "crs"; KML keeps name, description, ExtendedData and shared
// styles; the KMZ icon re-imports. Each layer then exports and re-imports in every format.
// REQ-FMT-12 for GeoJSON, Shapefile and KML/KMZ (GeoPackage is REQ-EXT-22, R2); REQ-FMT-15 (FX-12).
import { test, expect } from '@playwright/test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx12');
const truth = JSON.parse(readFileSync(join(DIR, 'fx12_truth.json'), 'utf8'));
const flat = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' || g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' || g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates.flat(2));

/** Compare the store's layers of one format with the truth features. */
const compare = (frame, format) =>
  frame.evaluate(
    ([format, truthFeatures]) => {
      const app = window.gisworkbench;
      const vs = app.store.all('vlayer').filter((v) => v.source.format === format);
      const fs = app.store.all('feature').filter((f) => vs.some((v) => v.id === f.vlayer));
      let xy = 0;
      let z = 0;
      const missing = [];
      for (const t of truthFeatures) {
        const f = fs.find((x) => x.name === t.properties.name);
        if (!f) {
          missing.push(t.properties.name);
          continue;
        }
        const pts = t.flat;
        for (const p of pts) {
          let best = Infinity;
          let dz = 0;
          for (let i = 0; i < f.geom.xyz.length; i += 3) {
            const d = Math.hypot(f.geom.xyz[i] - p[0], f.geom.xyz[i + 1] - p[1]);
            if (d < best) {
              best = d;
              dz = Math.abs(f.geom.xyz[i + 2] - p[2]);
            }
          }
          xy = Math.max(xy, best);
          z = Math.max(z, dz);
        }
      }
      const pick = (n) => fs.find((x) => x.name === n);
      return { n: fs.length, xy, z, missing, types: [...new Set(fs.map((f) => f.geom.type))].sort(), admin: pick('مبنى الإدارة'), store: pick('Склад'), tower: pick('塔'), layers: vs.map((v) => ({ name: v.name, report: v.source.report, assets: Object.keys(v.assets ?? {}) })) };
    },
    [format, truth.features.map((f) => ({ ...f, flat: flat(f.geometry) }))],
  );

test('SCN-17 AC-17.2..17.4 FX-12 opens in four formats with the truth geometry and attributes', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, ['fx12.geojson', 'fx12_shp.zip', 'fx12.kml', 'fx12.kmz'].map((f) => join(DIR, f)));
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 4);
  for (const fmt of ['GeoJSON', 'Shapefile', 'KML', 'KMZ']) {
    const r = await compare(frame, fmt);
    expect(r.missing, fmt).toEqual([]);
    expect(r.n, fmt).toBe(truth.count);
    expect(r.xy, fmt).toBeLessThan(1e-9);
    // KML altitudes are EGM96; the app's grid and the writer's agree to a few centimetres.
    expect(r.z, fmt).toBeLessThan(fmt.startsWith('KM') ? 0.05 : 1e-6);
    expect(r.types, fmt).toEqual(['LineString', 'MultiLineString', 'MultiPoint', 'MultiPolygon', 'Point', 'Polygon']);
    const a = r.admin.attrs;
    const code = a.class_code;
    expect(code, fmt).toBe('AL013');
    expect(Number(a.floors ?? a.FLOORS), fmt).toBe(3);
    expect(r.store.attrs.long_description_text ?? r.store.attrs.long_descr, fmt).toBe('Кириллица');
    expect(r.tower.attrs.long_description_text ?? r.tower.attrs.long_descr ?? null, fmt).toBe(null);
    if (fmt === 'Shapefile') {
      // AC-17.2: the field-name map and the truncation are reported; text is cut on a code point.
      const rep = r.layers.map((l) => l.report);
      expect(rep.every((x) => /\.prj/.test(x.crs) || /WGS 84/.test(x.crs))).toBe(true);
      expect(rep.every((x) => /UTF-8/.test(x.encoding))).toBe(true);
      expect(Buffer.byteLength(a.long_descr, 'utf8')).toBeLessThanOrEqual(254);
      expect(a.long_descr.endsWith('�')).toBe(false);
      expect(r.admin.description).toMatch(/^Feature 1/);
    }
    if (fmt.startsWith('KM')) {
      // AC-17.4: name, description, ExtendedData and shared styles; the KMZ icon.
      expect(r.admin.description).toBe('Feature 1: AL013');
      expect(r.admin.style).toMatchObject({ stroke: '#0050ff', width: 3 });
      expect(r.tower.style.icon).toBe('files/marker.png');
      if (fmt === 'KMZ') expect(r.layers[0].assets).toEqual(['files/marker.png']);
    }
  }
  expect(logs).toEqual([]);
});

test('SCN-17 step 5–6 every layer exports and re-imports in every format with a report', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [join(DIR, 'fx12.geojson')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length === 1);
  const dir = mkdtempSync(join(tmpdir(), 'gw-scn17-'));
  for (const fmt of ['geojson', 'shp', 'kml', 'kmz']) {
    const o = await frame.evaluate(async (fmt) => {
      const app = window.gisworkbench;
      const v = app.store.all('vlayer')[0];
      const e = app.encodeVectorLayer(v.id, fmt);
      const u8 = new Uint8Array(await e.blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return { name: e.name, b64: btoa(s), report: e.report };
    }, fmt);
    expect(o.report.features_in).toBe(truth.count);
    expect(o.report.features_out).toBe(truth.count);
    if (fmt === 'geojson') expect(JSON.parse(Buffer.from(o.b64, 'base64').toString('utf8')).crs).toBeUndefined();
    if (fmt === 'shp') expect(o.report.text_truncated).toEqual({ long_description_text: 1 });
    writeFileSync(join(dir, `rt_${o.name}`), Buffer.from(o.b64, 'base64'));
    await openFiles(frame, [join(dir, `rt_${o.name}`)]);
  }
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 5);
  for (const fmt of ['Shapefile', 'KML', 'KMZ']) {
    const r = await compare(frame, fmt);
    expect(r.missing, fmt).toEqual([]);
    expect(r.n, fmt).toBe(truth.count);
    expect(r.xy, fmt).toBeLessThan(1e-9);
    expect(r.z, fmt).toBeLessThan(fmt.startsWith('KM') ? 1e-3 : 1e-6);
  }
  const g = await frame.evaluate(() => window.gisworkbench.store.all('vlayer').filter((v) => v.source.format === 'GeoJSON').length);
  expect(g).toBe(2);
});
