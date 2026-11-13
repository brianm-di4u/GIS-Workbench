// REQ-GAP-84 the typed workflow ops not in SCN-77, each run through the workflow runner on the built
// file and compared with the same tool called directly: dissolve, spatial join and new layer from
// schema (REQ-GAP-79, REQ-GAP-87); fill sinks, flow accumulation, streams and watershed on the 5 m
// hydrology fixture (REQ-GAP-80, with the WhiteboxTools watershed area as a check); endmembers on a
// small mixed cube (REG-016). Every output layer records the step that made it.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

test.describe.configure({ timeout: 600000 });

const w = (from, output = 'out') => ({ from, output });

/** Load a gw-recipe/2 into the dock's runner, run it, and return the run's result. */
const runWorkflow = (frame, recipe) =>
  frame.evaluate(async (r) => {
    const R = window.gisworkbench.recipes.runner;
    R.load(window.gisworkbench.recipes.validate(r));
    const res = await R.run(0);
    return { ok: res.ok, error: res.error ?? null, states: R.state.map((s) => s.status), summaries: R.state.map((s) => String(s.summary ?? '')), outputs: Object.fromEntries([...R.outputs].map(([k, v]) => [k, v])) };
  }, recipe);

const sq = (x, y, d, zone) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] }, properties: { zone } });
const PARCELS = { type: 'FeatureCollection', features: [sq(-104.99, 39.74, 0.002, 'A'), sq(-104.988, 39.74, 0.002, 'A'), sq(-104.99, 39.742, 0.002, 'B'), sq(-104.986, 39.74, 0.002, 'B')] };
const PTS = { type: 'FeatureCollection', features: [[-104.989, 39.741, 3], [-104.9875, 39.7405, 5], [-104.9885, 39.7435, 7], [-104.97, 39.73, 9]].map(([x, y, v]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { v } })) };

test('REQ-GAP-84 REQ-GAP-79 REQ-GAP-87 dissolve, spatial join and new layer from schema as workflow steps equal the tools called directly', async ({ page }, info) => {
  const dir = info.outputPath('layers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'parcels.geojson'), JSON.stringify(PARCELS));
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(PTS));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [join(dir, 'parcels.geojson'), join(dir, 'points.geojson')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('vlayer').length >= 2, null, { timeout: 60000 });
  const [parcels, points] = await frame.evaluate(() => ['parcels', 'points'].map((n) => window.gisworkbench.store.all('vlayer').find((v) => v.name.startsWith(n)).name));
  const type = await frame.evaluate(() => window.gisworkbench.attribution.catalog().types[0].code);

  const run = await runWorkflow(frame, {
    format: 'gw-recipe/2',
    id: 'ops-vector',
    name: 'Vector ops',
    steps: [
      { id: 'p', op: 'vectorLayer', params: { layer: parcels } },
      { id: 'q', op: 'vectorLayer', params: { layer: points } },
      { id: 'd', op: 'dissolve', params: { field: 'zone' }, inputs: { layer: w('p') } },
      { id: 'j', op: 'join', params: { predicate: 'intersects', field: 'v' }, inputs: { target: w('p'), join: w('q') } },
      { id: 'n', op: 'newSchemaLayer', params: { type, name: 'From schema' } },
    ],
  });
  expect(run.error).toBeNull();
  expect(run.states).toEqual(['done', 'done', 'done', 'done', 'done']);

  const r = await frame.evaluate(async ([out, type]) => {
    const app = window.gisworkbench;
    const S = app.store;
    const id = (n) => S.all('vlayer').find((v) => v.name.startsWith(n)).id;
    const feats = (v) =>
      S.all('feature')
        .filter((f) => f.vlayer === v)
        .map((f) => ({ attrs: f.attrs, xyz: Array.from(f.geom.xyz) }))
        .sort((a, b) => JSON.stringify(a.attrs).localeCompare(JSON.stringify(b.attrs)));
    const dis = await app.geoproc.dissolve(id('parcels'), 'zone');
    const jn = await app.geoproc.join(id('parcels'), id('points'), { predicate: 'intersects', field: 'v', maxDistance: null });
    const ns = app.attribution.newSchemaLayer(type, { name: 'By hand', activate: false });
    const fields = (v) => S.get(v).fields.map((f) => [f.name, f.type, f.domain ?? null]);
    return {
      dissolve: { wf: feats(out.d.out), hand: feats(dis), recipe: S.get(out.d.out).recipe },
      join: { wf: feats(out.j.out), hand: feats(jn), recipe: S.get(out.j.out).recipe },
      sources: [out.p.out, out.q.out].map((v) => S.get(v).recipe),
      schema: { wf: fields(out.n.out), hand: fields(ns), schemaOf: [S.get(out.n.out).schema, S.get(ns).schema], recipe: S.get(out.n.out).recipe },
    };
  }, [run.outputs, type]);
  console.log(JSON.stringify({ dissolve: r.dissolve.wf.map((f) => f.attrs), join: r.join.wf.map((f) => f.attrs), schemaFields: r.schema.wf.length }));
  expect(r.dissolve.wf.map((f) => f.attrs.zone)).toEqual(['A', 'B']);
  expect(r.dissolve.wf).toEqual(r.dissolve.hand);
  expect(r.join.wf).toHaveLength(4);
  expect(r.join.wf).toEqual(r.join.hand);
  expect(r.schema.wf.length).toBeGreaterThan(0);
  expect(r.schema.wf).toEqual(r.schema.hand);
  expect(r.schema.schemaOf[0]).toEqual(r.schema.schemaOf[1]);
  expect(r.dissolve.recipe).toMatchObject({ id: 'ops-vector', step: 'd', op: 'dissolve', params: { field: 'zone' } });
  // The source layers made nothing, so they record no step.
  expect(r.sources).toEqual([undefined, undefined]);
  expect(r.join.recipe).toMatchObject({ step: 'j', op: 'join' });
  expect(r.schema.recipe).toMatchObject({ step: 'n', op: 'newSchemaLayer' });
  expect(logs).toEqual([]);
});

test('REQ-GAP-84 REQ-GAP-80 the hydrology chain as workflow steps equals the tools called directly, and the watershed matches WhiteboxTools', async ({ page }) => {
  const truth = JSON.parse(readFileSync(resolve('fixtures/hydro/truth.json'), 'utf8'));
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [resolve('fixtures/hydro/dem.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 120000 });
  const dem = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()][0];
    await app.useAsTerrain(l, 'navd88');
    return l.rec.name;
  });

  const run = await runWorkflow(frame, {
    format: 'gw-recipe/2',
    id: 'ops-hydro',
    name: 'Hydrology ops',
    steps: [
      { id: 'dem', op: 'rasterLayer', params: { layer: dem } },
      { id: 'fill', op: 'fillSinks', params: { eps: true }, inputs: { dem: w('dem') } },
      { id: 'acc', op: 'flowAccumulation', params: { method: 'd8' }, inputs: { dem: w('dem') } },
      { id: 'str', op: 'streams', params: { minArea: truth.streams.area_m2 }, inputs: { dem: w('dem') } },
      { id: 'ws', op: 'watershed', params: { at: [truth.pour.lon, truth.pour.lat], snap: truth.pour.snap_m }, inputs: { dem: w('dem') } },
    ],
  });
  expect(run.error).toBeNull();
  expect(run.states).toEqual(['done', 'done', 'done', 'done', 'done']);

  const r = await frame.evaluate(async ([out, truth]) => {
    const app = window.gisworkbench;
    const S = app.store;
    const d = app.terrain.entry(out.dem.out);
    const feats = (v) => S.all('feature').filter((f) => f.vlayer === v).map((f) => ({ attrs: f.attrs, n: f.geom.xyz.length }));
    const fill = await app.hydrology.fill({ eps: true }, d);
    const acc = await app.hydrology.accumulation({ method: 'd8' }, d);
    const str = await app.hydrology.streams({ minArea: truth.streams.area_m2 }, d);
    const ws = await app.hydrology.watershed({ lon: truth.pour.lon, lat: truth.pour.lat, snap: truth.pour.snap_m }, d);
    const raster = (id) => {
      const l = app.layers.get(id);
      return { name: l.rec.name, w: l.width, h: l.height, recipe: S.get(id)?.recipe ?? null };
    };
    return {
      fill: { wf: raster(out.fill.out), hand: raster(fill.layer.id), raised: fill.raised },
      acc: { wf: raster(out.acc.out), hand: raster(acc.layer.id), max: acc.max },
      streams: { wf: feats(out.str.out), hand: feats(str.layer), recipe: S.get(out.str.out).recipe },
      ws: { wf: feats(out.ws.out), hand: feats(ws.layer), recipe: S.get(out.ws.out).recipe },
    };
  }, [run.outputs, truth]);
  console.log(JSON.stringify({ summaries: run.summaries, raised: r.fill.raised, accMax: r.acc.max, streams: r.streams.wf.length, wsArea: r.ws.wf[0]?.attrs.AREA_M2, oracle: truth.watershed.area_m2 }));
  // The step summaries carry the same counts as the direct calls.
  expect(run.summaries[1].replace(/,/g, "")).toContain(String(r.fill.raised));
  expect(run.summaries[2].replace(/,/g, "")).toContain(String(r.acc.max));
  expect(r.fill.wf).toMatchObject({ w: r.fill.hand.w, h: r.fill.hand.h, recipe: { step: 'fill', op: 'fillSinks' } });
  expect(r.fill.wf.name).toMatch(/^FILLED_/);
  expect(r.acc.wf).toMatchObject({ w: r.acc.hand.w, h: r.acc.hand.h, recipe: { step: 'acc', op: 'flowAccumulation', params: { method: 'd8' } } });
  expect(r.streams.wf.length).toBeGreaterThan(0);
  expect(r.streams.wf).toEqual(r.streams.hand);
  expect(r.streams.recipe).toMatchObject({ step: 'str', op: 'streams' });
  expect(r.ws.wf).toEqual(r.ws.hand);
  expect(Math.abs(r.ws.wf[0].attrs.AREA_M2 - truth.watershed.area_m2) / truth.watershed.area_m2).toBeLessThan(0.03);
  expect(r.ws.recipe).toMatchObject({ step: 'ws', op: 'watershed' });
  expect(logs).toEqual([]);
});

/** A small BSQ float32 ENVI cube mixed from three spectra, each with a pure 3 × 3 patch. */
function writeCube(dir) {
  const ends = [
    [0.1, 0.2, 0.6, 0.7, 0.3, 0.2],
    [0.5, 0.4, 0.2, 0.1, 0.6, 0.7],
    [0.3, 0.6, 0.4, 0.5, 0.1, 0.4],
  ];
  const [wd, ht, nb] = [48, 36, 6];
  const pure = [[4, 4], [30, 8], [16, 26]];
  const v = new Float32Array(wd * ht * nb);
  for (let y = 0; y < ht; y++)
    for (let x = 0; x < wd; x++) {
      let a = [1 + Math.sin(x / 7), 1 + Math.cos(y / 5), 1 + Math.sin((x + y) / 9)];
      const e = pure.findIndex(([px, py]) => x >= px && x < px + 3 && y >= py && y < py + 3);
      if (e >= 0) a = a.map((_, i) => (i === e ? 1 : 0));
      const s = a.reduce((p, q) => p + q, 0);
      for (let b = 0; b < nb; b++) v[b * wd * ht + y * wd + x] = a.reduce((p, ai, i) => p + (ai / s) * ends[i][b], 0);
    }
  const img = join(dir, 'mix.img');
  writeFileSync(img, Buffer.from(v.buffer));
  writeFileSync(join(dir, 'mix.hdr'), `ENVI\nsamples = ${wd}\nlines = ${ht}\nbands = ${nb}\nheader offset = 0\nfile type = ENVI Standard\ndata type = 4\ninterleave = bsq\nbyte order = 0\nwavelength units = Micrometers\nwavelength = {0.45, 0.55, 0.65, 0.85, 1.6, 2.2}\n`);
  return [img, join(dir, 'mix.hdr')];
}

test('REQ-GAP-84 REG-016 endmembers as a workflow step equal the tool called directly', async ({ page }, info) => {
  const dir = info.outputPath('cube');
  mkdirSync(dir, { recursive: true });
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, writeCube(dir));
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex), null, { timeout: 90000 });
  const name = await frame.evaluate(() => [...window.gisworkbench.layers.values()][0].rec.name);

  const run = await runWorkflow(frame, {
    format: 'gw-recipe/2',
    id: 'ops-msi',
    name: 'Endmember ops',
    steps: [
      { id: 'img', op: 'rasterLayer', params: { layer: name } },
      { id: 'em', op: 'endmembers', params: { m: 3, skewers: 200, seed: 7 }, inputs: { image: w('img') } },
    ],
  });
  expect(run.error).toBeNull();
  expect(run.states).toEqual(['done', 'done']);

  const r = await frame.evaluate(async (out) => {
    const app = window.gisworkbench;
    const pinned = app.msi.plot.pinned.map((s) => ({ label: s.label, values: Array.from(s.values) }));
    const hand = await app.msi.endmembers(app.layers.get(out.img.out), { m: 3, skewers: 200, seed: 7, pin: false });
    const ppi = app.layers.get(out.em.ppi);
    return { pinned, hand: hand.endmembers.map((e) => ({ label: e.label, values: Array.from(e.values) })), ppi: { kind: ppi?.msi?.kind, skewers: ppi?.msi?.skewers, w: ppi?.width, handW: hand.ppi?.width }, recipe: app.store.get(out.em.ppi)?.recipe ?? null };
  }, run.outputs);
  console.log(JSON.stringify({ summary: run.summaries[1], labels: r.pinned.map((p) => p.label) }));
  expect(run.summaries[1]).toBe('3 endmembers');
  expect(r.pinned).toHaveLength(3);
  expect(r.pinned).toEqual(r.hand);
  expect(r.ppi).toMatchObject({ kind: 'ppi', skewers: 200 });
  expect(r.ppi.w).toBe(r.ppi.handW);
  expect(r.recipe).toMatchObject({ id: 'ops-msi', step: 'em', op: 'endmembers', params: { m: 3, skewers: 200, seed: 7 } });
  expect(logs).toEqual([]);
});
