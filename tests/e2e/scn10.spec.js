// SCN-10 building and road extraction with attributes (REQ-EXT-03/07/09/10/11/13/14/16/17/25):
// buildings from the FX-09 DSM against the truth (AT-10.4), persistent attribution over ten
// captures and a changed default (AT-10.2), domain and range checks that name the attribute and
// its allowed values (AT-10.3), road validation reporting dangles under 2 m and snapping them
// closed (AT-10.5), the 3D buildings in glTF/OBJ/CityJSON, Drop to Ground, custom tools, style
// rules, heights handed back to the DSM, and the magic wand and road trace on FX-02.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const t09 = JSON.parse(readFileSync(resolve('fixtures/fx09/fx09_truth.json'), 'utf8'));
const t02 = JSON.parse(readFileSync(resolve('fixtures/fx02/fx02_truth.json'), 'utf8'));

function inside(r, p) {
  let c = false;
  for (let a = 0, b = r.length - 1; a < r.length; b = a++) if (r[a][1] > p[1] !== r[b][1] > p[1] && p[0] < ((r[b][0] - r[a][0]) * (p[1] - r[a][1])) / (r[b][1] - r[a][1]) + r[a][0]) c = !c;
  return c;
}
/** IoU of two rings in metres (lattice of 0.2 m). */
function iou(a, b) {
  const xs = [...a, ...b].map((p) => p[0]);
  const ys = [...a, ...b].map((p) => p[1]);
  let i = 0;
  let u = 0;
  for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.2)
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.2) {
      const pa = inside(a, [x, y]);
      const pb = inside(b, [x, y]);
      if (pa && pb) i++;
      if (pa || pb) u++;
    }
  return u ? i / u : 0;
}

test('SCN-10 REQ-EXT-16 REQ-EXT-14 REQ-EXT-25 FX-09 buildings and trees from the DSM, 3D models and heights back to the DSM', async ({ page }) => {
  test.setTimeout(600000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx09/fx09.laz')]);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const c = [...app.pointClouds.values()][0];
    const dsm = await app.pc.generate(c, 'dsm', { cell: 0.5 });
    const dtm = await app.pc.generate(c, 'dtm', { cell: 0.5 });
    const de = app.terrain.entry(dsm.layer.id);
    const te = app.terrain.entry(dtm.layer.id);
    const t0 = performance.now();
    const ex = await app.extractR2.buildingsFromDsm({ dsm: de, dtm: te });
    const ms = performance.now() - t0;
    const bs = app.store.all('feature').filter((f) => f.vlayer === ex.buildingLayer);
    const trees = app.store.all('feature').filter((f) => f.vlayer === ex.treeLayer);
    const out = { ms, n: ex.buildings, nt: ex.trees, buildings: bs.map((f) => ({ ring: Array.from({ length: f.geom.xyz.length / 3 }, (_, i) => [f.geom.xyz[3 * i], f.geom.xyz[3 * i + 1]]), hgt: f.attrs.HGT, fcode: f.attrs.F_CODE, method: f.prov.height.method, squared: f.prov.squared })), trees: trees.map((f) => ({ lon: f.geom.xyz[0], lat: f.geom.xyz[1], hgt: f.attrs.HGT, fcode: f.attrs.F_CODE })) };
    // 3D models: gable on one, hip on another; exports parse.
    const four = bs.filter((f) => f.geom.xyz.length === 12);
    out.fourCorner = four.length;
    out.vertexCounts = bs.map((f) => f.geom.xyz.length / 3);
    if (four.length < 2) return out;
    const [b0, b1] = four;
    app.store.transact('roofs', (tx) => {
      tx.set(b0.id, 'attrs', { ...b0.attrs, roofType: 'gable', ridge: 3 });
      tx.set(b1.id, 'attrs', { ...b1.attrs, roofType: 'hip', ridge: 2 });
    });
    const glb = app.extractR2.export3d(ex.buildingLayer, 'glb');
    const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset);
    const jl = dv.getUint32(12, true);
    const gj = JSON.parse(new TextDecoder().decode(glb.bytes.subarray(20, 20 + jl)));
    const obj = new TextDecoder().decode(app.extractR2.export3d(ex.buildingLayer, 'obj').bytes);
    const cj = JSON.parse(new TextDecoder().decode(app.extractR2.export3d(ex.buildingLayer, 'cityjson').bytes));
    const m = app.extractR2.models(ex.buildingLayer);
    const roofFaces = (mm) => mm.model.faces.filter((f) => f.type === 'RoofSurface').length;
    const byUfi = (f) => m.models.find((x) => x.id === f.ufi);
    const flat = bs.find((f) => f !== b0 && f !== b1);
    out.models = { magic: dv.getUint32(0, true), version: dv.getUint32(4, true), length: dv.getUint32(8, true) === glb.bytes.length, nodes: gj.nodes.length, objObjects: (obj.match(/^o /gm) ?? []).length, cityjson: { type: cj.type, version: cj.version, objects: Object.keys(cj.CityObjects).length, crs: cj.metadata.referenceSystem, lods: [...new Set(Object.values(cj.CityObjects).map((o) => o.geometry[0].lod))] }, roofs: [b0, b1, flat].map((f) => byUfi(f)).map((x) => [x.model.roof, roofFaces(x)]) };
    // Heights back to the DSM used for line of sight.
    const n = await app.extractR2.heightsToDsm(ex.buildingLayer, de);
    const f = flat;
    const lon = f.geom.xyz.filter((_, i) => i % 3 === 0).reduce((s, v) => s + v, 0) / (f.geom.xyz.length / 3);
    const lat = f.geom.xyz.filter((_, i) => i % 3 === 1).reduce((s, v) => s + v, 0) / (f.geom.xyz.length / 3);
    out.handBack = { n, edits: app.demEdit.log(de).length, at: app.core.demHae(de.coreId, lat, lon), ground: app.terrain.sample(lat, lon) ? app.core.demHae(te.coreId, lat, lon) : null, hgt: f.attrs.HGT };
    return out;
  });
  const kx = t09.frame.kx;
  const ky = t09.frame.ky;
  const toM = ([lon, lat]) => [(lon - t09.site.lon) * kx, (lat - t09.site.lat) * ky];
  const found = r.buildings.map((b) => ({ ...b, m: b.ring.map(toM) }));
  const rows = t09.buildings.map((tb) => {
    const tr = tb.ringLatLon.map(([lat, lon]) => toM([lon, lat]));
    let best = { iou: 0 };
    for (const b of found) {
      const v = iou(tr, b.m);
      if (v > best.iou) best = { iou: v, hgt: b.hgt };
    }
    return { id: tb.id, iou: best.iou, dh: best.hgt - tb.height };
  });
  console.log(JSON.stringify({ ms: r.ms, n: r.n, nt: r.nt, rows, models: r.models, handBack: r.handBack, vertexCounts: r.vertexCounts }));
  // AT-10.4
  const good = rows.filter((x) => x.iou >= 0.7 && Math.abs(x.dh) <= 1);
  expect(good.length / rows.length).toBeGreaterThanOrEqual(0.8);
  expect(r.n).toBeLessThanOrEqual(t09.buildings.length + 1);
  expect(r.buildings.every((b) => b.fcode === 'AL013' && b.method === 'DSM')).toBe(true);
  expect(r.nt).toBeGreaterThan(t09.trees.length * 0.6);
  expect(r.trees.every((t) => t.fcode === 'EC005' && t.hgt > 3)).toBe(true);
  // REQ-EXT-14 / REQ-EXT-25
  expect(r.models.magic).toBe(0x46546c67);
  expect(r.models.version).toBe(2);
  expect(r.models.length).toBe(true);
  expect(r.models.nodes).toBe(r.n);
  expect(r.models.objObjects).toBe(r.n);
  expect(r.models.cityjson).toMatchObject({ type: 'CityJSON', version: '2.0', objects: r.n, crs: 'https://www.opengis.net/def/crs/EPSG/0/32611' });
  expect(r.fourCorner).toBeGreaterThanOrEqual(r.n * 0.8);
  expect(r.models.roofs[0]).toEqual(['gable', 2]);
  expect(r.models.roofs[1]).toEqual(['hip', 4]);
  expect(r.models.roofs[2]).toEqual(['flat', 1]);
  // Heights back to the DSM
  expect(r.handBack.n).toBe(r.n);
  expect(r.handBack.edits).toBe(r.n);
  expect(Math.abs(r.handBack.at - r.handBack.ground - r.handBack.hgt)).toBeLessThan(0.05);
  expect(logs).toEqual([]);
});

test('SCN-10 REQ-EXT-09 REQ-EXT-10 REQ-EXT-11 REQ-EXT-13 REQ-EXT-03 REQ-EXT-07 persistent attribution, domain checks, road validation, Drop to Ground', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx05/fx05_dem_hae.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 60000 });
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const S = app.store;
    const A = app.attribution;
    const p = app.activePane();
    const dem = [...app.layers.values()][0];
    await app.useAsTerrain(dem, 'hae');
    const out = {};
    const cat = A.catalog();
    out.catalog = { types: cat.types.length, roadAttrs: cat.types.find((t) => t.code === 'AP030').attributes };
    // AT-10.2 persistent attribution.
    const bl = A.newSchemaLayer('AL013');
    A.setDefaults(bl, { FFN: 563, BNF: 2 });
    const sq = (lon, lat, d = 0.0001) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d]].map(([x, y]) => ({ lon: x, lat: y, h: 640, zsrc: 'constant' }));
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(app.commitFeature(p, 'Polygon', sq(-116.503 + i * 0.0003, 34.5025)));
    A.setDefaults(bl, { FFN: 440 });
    const later = app.commitFeature(p, 'Polygon', sq(-116.503, 34.5035));
    out.persist = { first10: ids.map((id) => [S.get(id).attrs.FFN, S.get(id).attrs.BNF, S.get(id).attrs.F_CODE]), later: [S.get(later).attrs.FFN, S.get(later).attrs.BNF], nullHgt: S.get(ids[0]).attrs.HGT, ufi: S.get(ids[0]).attrs.UFI === S.get(ids[0]).ufi, area: S.get(ids[0]).attrs.ARA };
    // AT-10.3 domain and range checks.
    const err = (fn) => {
      try {
        fn();
        return null;
      } catch (e) {
        return e.message;
      }
    };
    out.domain = err(() => A.setAttr(ids[0], 'FFN', 12345));
    out.range = err(() => A.setAttr(ids[0], 'HGT', 5000));
    out.ok = err(() => A.setAttr(ids[0], 'HGT', 12.5));
    out.tableCheck = A.checkEdit(S.get(ids[0]), 'MCC', 77);
    // Style rules (REQ-EXT-11).
    out.style = A.ruleStyle(S.get(bl), S.get(ids[0]));
    // Custom tool (REQ-EXT-03).
    A.saveCustomTool('Squared building', 'ext.polygon', { square: true, snap: true, constZ: false });
    app.prefs.set('extract', { ...(app.prefs.get('extract') ?? {}), square: false });
    A.runCustomTool('Squared building');
    out.custom = { tool: app.tools.current?.id, square: app.prefs.get('extract').square };
    app.tools.select(null);
    // AT-10.5 road validation.
    const rl = A.newSchemaLayer('AP030');
    const m = 1 / 110940;
    const e = 1 / 91700;
    const L = (pts) => app.commitFeature(p, 'LineString', pts.map(([x, y]) => ({ lon: -116.5 + x * e, lat: 34.49 + y * m, h: 0, zsrc: 'dem' })));
    const main = L([[0, 0], [200, 0]]);
    const under = L([[100, 60], [100, 1.3]]);
    const over = L([[40, 60], [40, -0.9]]);
    const free = L([[170, 80], [170, 15]]);
    for (const id of [main, under, over, free]) A.setAttr(id, 'RTY', 3);
    const noRty = L([[0, 100], [200, 100]]);
    const v1 = await app.extractR2.validate(rl, { tol: 2 });
    out.v1 = v1.issues.map((i) => ({ check: i.check, f: [main, under, over, free, noRty].indexOf(i.featureId), msg: i.message, fix: !!i.fix }));
    for (const i of v1.issues) if (i.fix) app.extractR2.fixIssue(i, v1.sessionId);
    A.setAttr(noRty, 'RTY', 4);
    const v2 = await app.extractR2.validate(rl, { tol: 2 });
    out.v2 = v2.issues.map((i) => i.check);
    out.sessions = S.all('valsession').length;
    out.fixedRecorded = S.get(v1.sessionId).fixed.length;
    const endUnder = S.get(under).geom.xyz.slice(-3);
    out.snappedTo = (endUnder[1] - 34.49) / m;
    // Drop to Ground (REQ-EXT-07) on the FX-05 terrain.
    const dl = A.newSchemaLayer('AP050');
    const trail = app.commitFeature(p, 'LineString', [[-116.506, 34.499], [-116.497, 34.5035]].map(([lon, lat]) => ({ lon, lat, h: 0, zsrc: 'constant' })));
    void dl;
    const g1 = app.extractR2.dropToGround(trail, 'planimetric');
    const z1 = [g1.xyz[2], g1.xyz[5]];
    const t1 = [app.terrain.sample(g1.xyz[1], g1.xyz[0]).hae, app.terrain.sample(g1.xyz[4], g1.xyz[3]).hae];
    const g2 = app.extractR2.dropToGround(trail, 'topographic');
    const n2 = g2.xyz.length / 3;
    let worst2 = 0;
    for (let i = 0; i < n2; i++) worst2 = Math.max(worst2, Math.abs(g2.xyz[3 * i + 2] - app.terrain.sample(g2.xyz[3 * i + 1], g2.xyz[3 * i]).hae));
    app.store.transact('reset', (tx) => tx.set(trail, 'geom', { type: 'LineString', xyz: [-116.506, 34.499, 0, -116.497, 34.5035, 0], parts: [0], polys: [] }));
    const g3 = app.extractR2.dropToGround(trail, 'geomorphic', { tolerance: 0.3 });
    out.drop = { z1, t1, n2, worst2, n3: g3.xyz.length / 3, method: S.get(trail).prov.dropToGround.mode };
    return out;
  });
  console.log(JSON.stringify(r));
  expect(r.catalog.types).toBe(38);
  expect(r.catalog.roadAttrs).toEqual(expect.arrayContaining(['ZI016_WD1', 'ZI016_ROC', 'RTY']));
  // AT-10.2
  expect(r.persist.first10).toEqual(Array(10).fill([563, 2, 'AL013']));
  expect(r.persist.later).toEqual([440, 2]);
  expect(r.persist.nullHgt).toBe(-999999);
  expect(r.persist.ufi).toBe(true);
  expect(r.persist.area).toBeGreaterThan(80);
  // AT-10.3
  expect(r.domain).toMatch(/FFN/);
  expect(r.domain).toMatch(/Feature Function/);
  expect(r.domain).toMatch(/563 Residence/);
  expect(r.domain).toMatch(/Allowed/);
  expect(r.range).toMatch(/HGT.*0 to 1000 m/);
  expect(r.ok).toBeNull();
  expect(r.tableCheck).toMatch(/MCC/);
  expect(r.style.stroke).toBe('#d84315');
  expect(r.custom).toEqual({ tool: 'ext.polygon', square: true });
  // AT-10.5
  expect(r.v1).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'dangle', f: 1, fix: true }), expect.objectContaining({ check: 'overshoot', f: 2, fix: true }), expect.objectContaining({ check: 'required', f: 4 })]));
  expect(r.v1.some((i) => i.f === 3 && (i.check === 'dangle' || i.check === 'overshoot'))).toBe(false);
  expect(r.v2.filter((c) => c === 'dangle' || c === 'overshoot' || c === 'required')).toEqual([]);
  expect(r.sessions).toBe(2);
  expect(r.fixedRecorded).toBe(2);
  expect(Math.abs(r.snappedTo)).toBeLessThan(0.01);
  // REQ-EXT-07
  expect(Math.abs(r.drop.z1[0] - r.drop.t1[0])).toBeLessThan(1e-6);
  expect(Math.abs(r.drop.z1[1] - r.drop.t1[1])).toBeLessThan(1e-6);
  expect(r.drop.n2).toBeGreaterThan(20);
  expect(r.drop.worst2).toBeLessThan(1e-6);
  expect(r.drop.n3).toBeGreaterThan(2);
  expect(r.drop.n3).toBeLessThan(r.drop.n2);
  expect(r.drop.method).toBe('geomorphic');
  expect(logs).toEqual([]);
});

test('SCN-10 REQ-EXT-17 FX-02 magic wand on a roof and road trace along a road', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/fx02/fx02_a.ntf'), resolve('fixtures/fx02/fx02_dsm_truth.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 2, null, { timeout: 60000 });
  const box = t02.boxes.find((b) => b.sizeM[0] >= 40) ?? t02.boxes.at(-1);
  const r = await frame.evaluate(async ({ box, O }) => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const dsm = [...app.layers.values()].find((x) => /dsm/i.test(x.rec.name));
    await app.useAsTerrain(dsm, 'hae');
    app.store.transact('image on top', (tx) => tx.set(dsm.id, 'visible', false));
    const l = [...app.layers.values()].find((x) => /fx02_a/i.test(x.rec.name));
    app.store.transact('active', (tx) => tx.set(p.id, 'activeLayer', l.id));
    p.setView({ zoom: 1 });
    const [ax, ay] = box.roofCentre.a;
    p.centreOn(ax, ay);
    p.draw?.(app.renderer, { x: 0, y: 0, w: p.size().w, h: p.size().h, dpr: 1 });
    const s = p.screenPoint(ax, ay);
    const wand = await app.extractR2.magicWand(p, s.x, s.y, { tolerance: 18, commit: false });
    // Area of the wand polygon (m²) in a local frame.
    const F = app.extractR2.frame(wand[0].lat, wand[0].lon);
    const xy = wand.map((g) => F.to(g.lon, g.lat));
    let a = 0;
    for (let i = 0; i < xy.length; i++) a += xy[i][0] * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * xy[i][1];
    // Road trace along the road e = −180 m (ENU at the FX-02 origin) from n = 70 to n = 190 (clear of the other road, which crosses at n ≈ 15).
    const kx = 111320 * Math.cos((O.lat * Math.PI) / 180);
    const ky = 110940;
    const at = (e, n) => {
      const la = O.lat + n / ky;
      const lo = O.lon + e / kx;
      const q = l.imageAt(la, lo, app.terrain.sample(la, lo)?.hae ?? O.hae);
      const sc = p.screenPoint(q.x, q.y);
      return [sc.x, sc.y];
    };
    p.centreOn(...Object.values(l.imageAt(O.lat + 130 / ky, O.lon - 180 / kx, O.hae)));
    const road = await app.extractR2.liveWire(p, at(-180, 70), at(-180, 190), { mode: 'road', commit: false });
    const off = road.map((g) => Math.abs((g.lon - O.lon) * kx + 180));
    const back = at(-180, 70);
    const g0 = l.groundWithTerrain(...Object.values(p.imagePoint(back[0], back[1])));
    return { wandVertices: wand.length, wandArea: Math.abs(a) / 2, roadVertices: road.length, roadWorst: Math.max(...off), offs: off.map((v) => +v.toFixed(1)), ns: road.map((g) => +((g.lat - O.lat) * ky).toFixed(0)), endE: (g0.lon - O.lon) * kx, endN: (g0.lat - O.lat) * ky };
  }, { box, O: t02.origin });
  console.log(JSON.stringify({ box: box.sizeM, ...r }));
  const roofArea = box.sizeM[0] * box.sizeM[1];
  expect(r.wandVertices).toBeGreaterThanOrEqual(4);
  expect(r.wandArea).toBeGreaterThan(roofArea * 0.5);
  expect(r.wandArea).toBeLessThan(roofArea * 1.5);
  expect(r.roadVertices).toBeGreaterThanOrEqual(2);
  // Within the 7 m road plus 2 m everywhere, and on the road (3.5 m) for most of the way.
  expect(r.roadWorst).toBeLessThan(9);
  expect(r.offs.filter((d) => d <= 3.5).length / r.offs.length).toBeGreaterThanOrEqual(0.7);
  expect(logs).toEqual([]);
});
