// SCN-17 GeoPackage (REQ-EXT-22/27, REQ-EXT-10/24, AC-17.1, AC-17.5, AT-05.5): FX-12 through a
// GeoPackage keeps the count, geometry (1e-9°), Z, field types and UTF-8 text; the file passes the
// GeoPackage 1.4 core checks (checked here with SQLite in Node, independently of the app's
// reader) with an R*Tree index and its triggers; coded domains survive and become a schema on
// import; the MGCP cross-walk renames codes and attributes; CSV with WKT round-trips.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import initSqlJs from 'rtree-sql.js';
import { openApp, openFiles } from './helpers.js';

const DIR = resolve('fixtures/fx12');
const truth = JSON.parse(readFileSync(join(DIR, 'fx12_truth.json'), 'utf8'));
const flat = (g) => (g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' || g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' || g.type === 'MultiLineString' ? g.coordinates.flat() : g.coordinates.flat(2));

async function inspect(bytes) {
  const SQL = await initSqlJs({ wasmBinary: readFileSync(resolve('node_modules/rtree-sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database(bytes);
  const all = (q) => {
    const r = db.exec(q);
    return r.length ? r[0].values.map((v) => Object.fromEntries(r[0].columns.map((c, i) => [c, v[i]]))) : [];
  };
  const out = {
    appId: all('PRAGMA application_id')[0].application_id,
    userVersion: all('PRAGMA user_version')[0].user_version,
    srs: all('SELECT srs_id, organization, organization_coordsys_id, length(definition) AS dl FROM gpkg_spatial_ref_sys ORDER BY srs_id'),
    contents: all('SELECT table_name, data_type, identifier, srs_id, min_x, max_x, last_change FROM gpkg_contents'),
    geomCols: all('SELECT * FROM gpkg_geometry_columns'),
    extensions: all('SELECT table_name, extension_name FROM gpkg_extensions'),
    triggers: all("SELECT name FROM sqlite_master WHERE type = 'trigger'").map((r) => r.name),
    integrity: all('PRAGMA integrity_check')[0].integrity_check,
    fk: all('PRAGMA foreign_key_check').length,
    metadata: all('SELECT md_scope, md_standard_uri, mime_type FROM gpkg_metadata'),
    constraints: all('SELECT constraint_name, constraint_type, value, min, max FROM gpkg_data_column_constraints'),
    dataColumns: all('SELECT table_name, column_name, constraint_name FROM gpkg_data_columns'),
    tables: {},
  };
  for (const c of out.contents) {
    const t = c.table_name;
    const rows = db.exec(`SELECT * FROM "${t}"`)[0];
    const info = all(`PRAGMA table_info("${t}")`);
    const blobs = rows.values.map((v) => v[rows.columns.indexOf('geom')]);
    const rtree = all(`SELECT count(*) AS n FROM "rtree_${t}_geom"`)[0].n;
    // Independent blob check: magic, version, flags, srs, WKB type (ISO with Z = + 1000).
    const blob = blobs.map((b) => {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const env = (b[3] >> 1) & 7;
      const o = 8 + [0, 32, 48, 48, 64][env];
      return { magic: String.fromCharCode(b[0], b[1]), version: b[2], le: b[3] & 1, env, srs: dv.getInt32(4, true), wkbOrder: b[o], wkbType: dv.getUint32(o + 1, true) };
    });
    // The R*Tree box of each row equals its envelope.
    const env = all(`SELECT r.minx, r.maxx, f.fid FROM "rtree_${t}_geom" r JOIN "${t}" f ON f.fid = r.id`);
    out.tables[t] = { n: rows.values.length, columns: info.map((r) => [r.name, r.type]), rtree, blob, envRows: env.length };
  }
  db.close();
  return out;
}

test('SCN-17 AT-17.1 AT-17.5 AT-05.5 REQ-EXT-22 REQ-EXT-27 REQ-EXT-10 REQ-EXT-24 FX-12 GeoPackage round trip, core checks, domains, MGCP, CSV', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(DIR, 'fx12.geojson')]);
  const out = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const S = app.store;
    const src = S.all('vlayer')[0];
    const g = await app.attribution.gpkgBytes([src.id]);
    // A schema layer with coded domains (and Z from a stereo-style capture, AT-05.5).
    const bl = app.attribution.newSchemaLayer('AL013');
    const p = app.activePane();
    const zs = [702.6881618183106, 712.123456789, 655.5];
    const ids = zs.map((z, i) => app.commitFeature(p, 'Polygon', [[0, 0], [0.0002, 0], [0.0002, 0.0001], [0, 0.0001]].map(([x, y]) => ({ lon: -116.44 + x + i * 0.0005, lat: 34.56 + y, h: z, zsrc: 'stereo' }))));
    app.attribution.setAttr(ids[0], 'FFN', 563);
    app.attribution.setAttr(ids[1], 'ZI005_FNA', 'Здание 2 — 建物');
    app.attribution.setAttr(ids[2], 'HGT', 12.5);
    const d = await app.attribution.gpkgBytes([bl]);
    const m = await app.attribution.gpkgBytes([bl], { mgcp: true });
    const csv = app.attribution.writeCsv(app.vectorLayerOut(src.id));
    const back = app.attribution.readCsv(csv.text, { name: 'csv' });
    const csvCheck = { n: back.layer.features.length, types: back.layer.features.map((f) => f.geom.type), z: back.layer.features.map((f) => f.geom.xyz[2]) };
    return { g: Array.from(g.bytes), d: Array.from(d.bytes), m: Array.from(m.bytes), report: g.report, zs, csvCheck, srcN: S.all('feature').filter((f) => f.vlayer === src.id).length, srcZ: S.all('feature').filter((f) => f.vlayer === src.id).map((f) => f.geom.xyz[2]) };
  });
  const tmp = mkdtempSync(join(tmpdir(), 'gw-gpkg-'));
  const gfile = join(tmp, 'fx12.gpkg');
  const dfile = join(tmp, 'buildings.gpkg');
  writeFileSync(gfile, Uint8Array.from(out.g));
  writeFileSync(dfile, Uint8Array.from(out.d));
  // AC-17.5: core checks, independently.
  const gi = await inspect(Uint8Array.from(out.g));
  console.log(JSON.stringify({ ...gi, tables: Object.fromEntries(Object.entries(gi.tables).map(([k, v]) => [k, { ...v, blob: v.blob.slice(0, 2) }])) }));
  expect(gi.appId).toBe(0x47504b47);
  expect(gi.userVersion).toBe(10400);
  expect(gi.integrity).toBe('ok');
  expect(gi.fk).toBe(0);
  expect(gi.srs.map((r) => r.srs_id)).toEqual(expect.arrayContaining([-1, 0, 4326]));
  expect(gi.srs.every((r) => r.dl > 0)).toBe(true);
  const t = gi.contents[0];
  expect(t.data_type).toBe('features');
  expect(t.srs_id).toBe(4326);
  expect(t.last_change).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(gi.geomCols[0]).toMatchObject({ table_name: t.table_name, column_name: 'geom', srs_id: 4326, z: 1, m: 0 });
  expect(gi.extensions).toEqual(expect.arrayContaining([expect.objectContaining({ table_name: t.table_name, extension_name: 'gpkg_rtree_index' })]));
  expect(gi.triggers.filter((n) => n.startsWith(`rtree_${t.table_name}_geom_`)).length).toBe(6);
  expect(gi.metadata.length).toBe(1);
  const tt = gi.tables[t.table_name];
  expect(tt.n).toBe(truth.count);
  expect(tt.rtree).toBe(truth.count);
  expect(tt.envRows).toBe(truth.count);
  expect(tt.blob.every((b) => b.magic === 'GP' && b.version === 0 && b.le === 1 && b.srs === 4326 && b.wkbOrder === 1 && b.wkbType > 1000 && b.wkbType < 1007)).toBe(true);
  expect(tt.columns).toEqual(expect.arrayContaining([['height_m', 'DOUBLE'], ['floors', 'INTEGER'], ['verified', 'BOOLEAN'], ['survey_date', 'DATE'], ['class_code', 'TEXT']]));
  // Domains (REQ-EXT-22 coded domains, REQ-EXT-27 hand-off).
  const di = await inspect(Uint8Array.from(out.d));
  expect(di.constraints.filter((c) => c.constraint_type === 'enum' && /FFN/.test(c.constraint_name)).map((c) => c.value)).toEqual(expect.arrayContaining(['563', '-999999', '999']));
  expect(di.constraints.some((c) => c.constraint_type === 'range' && /HGT/.test(c.constraint_name) && c.min === 0 && c.max === 1000)).toBe(true);
  expect(di.dataColumns.some((c) => c.column_name === 'FFN' && c.constraint_name)).toBe(true);
  // MGCP cross-walk.
  const mi = await inspect(Uint8Array.from(out.m));
  const mcols = Object.values(mi.tables)[0].columns.map((c) => c[0]);
  expect(mcols).toEqual(expect.arrayContaining(['NAM', 'F_CODE', 'HGT']));
  expect(mcols).not.toContain('ZI005_FNA');
  // AC-17.1 / AT-05.5: re-import in the app.
  await openFiles(frame, [gfile, dfile]);
  const re = await frame.evaluate(
    ([truthFeatures, zs]) => {
      const app = window.gisworkbench;
      const S = app.store;
      const vs = S.all('vlayer').filter((v) => v.source.format === 'GeoPackage');
      const fx = vs.find((v) => /fx12/i.test(v.name) || /fx12/i.test(v.source.table ?? ''));
      const fs = S.all('feature').filter((f) => f.vlayer === fx.id);
      let xy = 0;
      let z = 0;
      const missing = [];
      for (const t of truthFeatures) {
        const f = fs.find((x) => x.name === t.properties.name);
        if (!f) {
          missing.push(t.properties.name);
          continue;
        }
        for (const p of t.flat) {
          let best = Infinity;
          let dz = 0;
          for (let i = 0; i < f.geom.xyz.length; i += 3) {
            const d = Math.hypot(f.geom.xyz[i] - p[0], f.geom.xyz[i + 1] - p[1]);
            if (d < best) {
              best = d;
              dz = Math.abs(f.geom.xyz[i + 2] - (p[2] ?? 0));
            }
          }
          xy = Math.max(xy, best);
          z = Math.max(z, dz);
        }
      }
      const attrsOk = truthFeatures.every((t) => {
        const f = fs.find((x) => x.name === t.properties.name);
        return f && ['class_code', 'height_m', 'floors', 'verified', 'survey_date', 'long_description_text'].every((k) => (t.properties[k] ?? null) === (f.attrs[k] ?? null));
      });
      const types = Object.fromEntries((fx.fields ?? []).map((f) => [f.name, f.type]));
      const bl = vs.find((v) => v !== fx);
      const bf = S.all('feature').filter((f) => f.vlayer === bl.id);
      const zback = bf.map((f) => f.geom.xyz[2]).sort((a, b) => a - b);
      let domainErr = null;
      try {
        app.attribution.setAttr(bf[0].id, 'FFN', 4242);
      } catch (e) {
        domainErr = e.message;
      }
      return { n: fs.length, xy, z, missing, attrsOk, types, zback, zs: [...zs].sort((a, b) => a - b), schema: bl.schema, ffnDomain: !!bl.fields.find((f) => f.name === 'FFN')?.domain, domainErr, names: bf.map((f) => f.attrs.ZI005_FNA) };
    },
    [truth.features.map((f) => ({ properties: f.properties, flat: flat(f.geometry) })), out.zs],
  );
  console.log(JSON.stringify({ ...re, zback: re.zback, csv: out.csvCheck }));
  expect(re.n).toBe(truth.count);
  expect(re.missing).toEqual([]);
  expect(re.xy).toBeLessThan(1e-9);
  expect(re.z).toBeLessThan(1e-9);
  expect(re.attrsOk).toBe(true);
  expect(re.types).toMatchObject({ height_m: 'number', floors: 'integer', verified: 'boolean', survey_date: 'date', class_code: 'string' });
  re.zback.forEach((v, i) => expect(Math.abs(v - re.zs[i])).toBeLessThan(1e-9));
  expect(re.schema?.catalog).toMatch(/^gpkg:/);
  expect(re.ffnDomain).toBe(true);
  expect(re.domainErr).toMatch(/FFN.*Allowed/);
  expect(re.names).toContain('Здание 2 — 建物');
  // REQ-EXT-24 CSV round trip.
  expect(out.csvCheck.n).toBe(out.srcN);
  expect(out.csvCheck.z).toEqual(out.srcZ.map((v) => Math.round(v * 1000) / 1000));
  expect(logs).toEqual([]);
});
