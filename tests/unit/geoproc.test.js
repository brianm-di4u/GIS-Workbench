// REQ-GAP-79 vector geoprocessing (SDP-2.7 §4.1): analysis/geoproc.js with the `geoproc` WASM bundle
// (crates/gw-geoproc) and the core bundle's geodesics, against GEOS through GDAL
// (tests/tools/geoproc_ref.py: OGR's own buffer, overlay, dissolve and predicates, in PROJ
// azimuthal equidistant projections), run when the gw-te environment is present.
// * synthetic jittered parcels near Denver: planar and geodesic buffers of polygons, lines (round,
//   flat and square ends) and points; intersect, union, erase and symmetric difference overlays;
//   dissolve by attribute; joins by intersects, within, contains and nearest;
// * geodesic buffers at 80° N and across the antimeridian (split at ±180°), with every vertex at
//   its geodesic distance (the core bundle, GeographicLib) and areas matching GEOS; a buffer that
//   reaches a pole is refused;
// * with the T&E corpus: a county of TIGER/Line 2024 block groups and roads.
// Skipped when the bundles are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { GeoprocBundle } from '../../app/src/wasm/geoproc.js';
import { Core } from '../../app/src/wasm/core.js';
import { bufferGeoms, dissolveFeatures, overlay, spatialJoin, centreOf, relate, localFrame } from '../../app/src/analysis/geoproc.js';
import { fromParts, fromGeoJSON, toGeoJSON } from '../../app/src/vector/geom.js';

const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => (target ? join(target, 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`) : '');
const haveWasm = existsSync(wasm('geoproc')) && existsSync(wasm('core'));
const G = haveWasm ? new GeoprocBundle(new WebAssembly.Module(readFileSync(wasm('geoproc')))) : null;
const core = haveWasm ? new Core(new WebAssembly.Module(readFileSync(wasm('core')))) : null;
const PY = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe';
const havePy = existsSync(PY);
// GDAL's and numpy's DLLs load from the environment's Library\bin, on PATH only when activated.
const PYENV = { ...process.env, PATH: [join(PY, '..'), join(PY, '..', 'Library', 'bin'), process.env.PATH].join(';') };
const TIGER = 'E:/TE-corpus/vector-tiger-2024-colorado';
const haveTiger = existsSync(join(TIGER, 'tl_2024_08_bg.zip')) && existsSync(join(TIGER, 'tl_2024_08013_roads.zip'));

function ref(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'georef-'));
  writeFileSync(join(dir, 'in.json'), JSON.stringify(spec));
  execFileSync(PY, ['-I', resolve('tests/tools/geoproc_ref.py'), join(dir, 'in.json'), join(dir, 'out.json')], { timeout: 900000, env: PYENV, maxBuffer: 1 << 28 });
  return JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
}
const gj = (g) => (g ? toGeoJSON(g) : null);
const run = { buffer: (flat, d, c, q, n) => G.buffer(flat, d, c, q, n), dissolve: (flat, groups) => G.dissolve(flat, groups) };
const buffer = (geoms, o) => bufferGeoms(geoms, { ...o, geo: core, run: (flat, d, c, q) => G.buffer(flat, d, c, q, geoms.length) });

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
/** n × n parcels of about `cell` metres near (lat0, lon0), corners jittered, with a zone and a value. */
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
      const ring = [c(i, j), c(i + 1, j), c(i + 1, j + 1), c(i, j + 1)].map(([x, y]) => [...F.from(x, y), 0]);
      out.push({ geom: fromParts('Polygon', [ring]), attrs: { pid: `${shift ? 'B' : 'A'}${i}-${j}`, zone: `Z${(i * 7 + j * 3) % 5}`, value: (i + 1) * (j + 2) } });
    }
  return out;
}
function points(n, { lat0 = 39.74, lon0 = -104.99, span = 2000, seed = 9 } = {}) {
  const F = localFrame(lat0, lon0);
  const rnd = lcg(seed);
  return Array.from({ length: n }, (_, k) => ({ geom: fromParts('Point', [[[...F.from(rnd() * span, rnd() * span), 0]]]), attrs: { k, v: Math.round(rnd() * 100) } }));
}
function roads(lat0 = 39.74, lon0 = -104.99) {
  const F = localFrame(lat0, lon0);
  const L = (pts) => fromParts('LineString', [pts.map(([x, y]) => [...F.from(x, y), 0])]);
  return [
    { geom: L([[-50, 330], [700, 360], [1400, 300], [2050, 420]]), attrs: { name: 'East' } },
    { geom: L([[810, -40], [790, 900], [860, 2040]]), attrs: { name: 'North' } },
    { geom: L([[0, 0], [600, 600], [650, 1500]]), attrs: { name: 'Diagonal' } },
  ];
}

describe.skipIf(!haveWasm)('vector geoprocessing (REQ-GAP-79)', () => {
  const A = haveWasm ? parcels(20) : [];
  const B = haveWasm ? parcels(20, { shift: 0.5, seed: 6 }) : [];

  it.skipIf(!havePy)('buffers polygons, lines and points as GEOS does, planar and geodesic', () => {
    const cases = [
      { name: 'parcels +25 m', geoms: A.slice(0, 40).map((f) => f.geom), distance: 25, cap: 'round' },
      { name: 'parcels −20 m', geoms: A.slice(0, 40).map((f) => f.geom), distance: -20, cap: 'round' },
      ...['round', 'flat', 'square'].map((cap) => ({ name: `roads ${cap}`, geoms: roads().map((f) => f.geom), distance: 40, cap })),
      { name: 'points', geoms: points(30).map((f) => f.geom), distance: 75, cap: 'round' },
    ];
    for (const geodesic of [false, true])
      for (const c of cases) {
        const ours = buffer(c.geoms, { distance: c.distance, cap: c.cap, quadSegs: 8, geodesic });
        const r = ref({ op: 'buffer', features: c.geoms.map(gj), centres: c.geoms.map((g) => [centreOf(g).lat, centreOf(g).lon]), ours: ours.map(gj), distance: c.distance, cap: c.cap, quadSegs: 8 });
        let worst = { area: 0, hd: 0 };
        for (const m of r.features) {
          if (m.ref === 0) {
            expect(m.ours, `${c.name}: GEOS has nothing left`).toBeLessThan(1e-6);
            continue;
          }
          worst = { area: Math.max(worst.area, m.symdiff / m.ref), hd: Math.max(worst.hd, m.hausdorff ?? 0) };
        }
        console.log(`${geodesic ? 'geodesic' : 'planar'} ${c.name}: worst symmetric difference ${(worst.area * 100).toFixed(4)} % of the area, Hausdorff ${worst.hd.toFixed(4)} m`);
        // Both arcs are 8 segments a quarter circle, but GEOS and i_overlay start them half a step
        // apart, so one's vertices sit on the other's chords: up to d·(1 − cos π/32) = 0.48 % of d.
        expect(worst.area, c.name).toBeLessThan(0.005);
        expect(worst.hd, c.name).toBeLessThan(0.01 * Math.abs(c.distance) + 0.01);
      }
  }, 300000);

  it('puts every vertex of a geodesic buffer at its distance at 80° N, and splits it at the antimeridian', () => {
    const d = 5000;
    const q = 8;
    const P80 = fromParts('Point', [[[17.5, 80, 0]]]);
    const [b80] = buffer([P80], { distance: d, quadSegs: q, geodesic: true });
    const dist = (g, lat, lon) => {
      let lo = Infinity;
      let hi = 0;
      for (let k = 0; k < g.xyz.length; k += 3) {
        const s = core.inverse(lat, lon, g.xyz[k + 1], g.xyz[k]).distance;
        [lo, hi] = [Math.min(lo, s), Math.max(hi, s)];
      }
      return [lo, hi];
    };
    const [lo, hi] = dist(b80, 80, 17.5);
    // Corners at d; points added along the chords between them dip to d·cos(π / 4q).
    expect(hi).toBeLessThan(d + 1e-3);
    expect(hi).toBeGreaterThan(d - 1e-3);
    expect(lo).toBeGreaterThan(d * Math.cos(Math.PI / (4 * q)) - 1e-3);
    // Across ±180°: a line from 179.97° E to 179.97° W at 10° N, buffered by 2 km.
    const L = fromParts('LineString', [[[179.97, 10, 0], [-179.97, 10.02, 0]]]);
    const [bx] = buffer([L], { distance: 2000, geodesic: true });
    expect(bx.type).toBe('MultiPolygon');
    const lons = bx.xyz.filter((_, k) => k % 3 === 0);
    expect(Math.max(...lons)).toBeLessThanOrEqual(180);
    expect(Math.min(...lons)).toBeGreaterThanOrEqual(-180);
    expect(lons.some((x) => x > 179.9) && lons.some((x) => x < -179.9)).toBe(true);
    // Every vertex lies within 2 km (+1 mm) of the line, and the far ones at 2 km.
    const near = (lat, lon) => {
      const steps = 200;
      let m = Infinity;
      for (let i = 0; i <= steps; i++) {
        const a = core.inverse(10, 179.97, 10.02, -179.97);
        const p = core.direct(10, 179.97, a.azi1, (a.distance * i) / steps);
        m = Math.min(m, core.inverse(lat, lon, p.lat, p.lon).distance);
      }
      return m;
    };
    let far = 0;
    for (let k = 0; k < bx.xyz.length; k += 3) {
      const s = near(bx.xyz[k + 1], bx.xyz[k]);
      expect(s).toBeLessThan(2000 + 0.5);
      far = Math.max(far, s);
    }
    expect(far).toBeGreaterThan(1999);
    // A buffer that reaches a pole is refused.
    expect(() => buffer([fromParts('Point', [[[0, 89.99, 0]]])], { distance: 5000, geodesic: true })).toThrow(expect.objectContaining({ code: 'E_BUFFER_POLE' }));
  });

  it.skipIf(!havePy)('geodesic buffers at 80° N and across ±180° match GEOS in PROJ projections', () => {
    const geoms = [fromParts('Point', [[[17.5, 80, 0]]]), fromParts('LineString', [[[10, 80, 0], [12, 80.3, 0], [15, 80.1, 0]]]), fromParts('LineString', [[[179.97, 10, 0], [-179.97, 10.02, 0]]]), fromParts('Polygon', [[[179.9, -16.9, 0], [-179.9, -16.9, 0], [-179.9, -16.7, 0], [179.9, -16.7, 0]]])];
    const ours = buffer(geoms, { distance: 3000, geodesic: true });
    const r = ref({ op: 'buffer', features: geoms.map(gj), centres: geoms.map((g) => [centreOf(g).lat, centreOf(g).lon]), ours: ours.map(gj), distance: 3000, cap: 'round', quadSegs: 8 });
    for (const m of r.features) {
      console.log(`high latitude / antimeridian: area ${m.ours.toFixed(0)} vs ${m.ref.toFixed(0)} m², symmetric difference ${((m.symdiff / m.ref) * 100).toFixed(4)} %, Hausdorff ${m.hausdorff.toFixed(3)} m`);
      expect(m.symdiff / m.ref).toBeLessThan(0.005);
      // Arc vertex placement (0.48 % of d, above), and on the 80° N line the input's long segments,
      // which follow their geodesics here and are straight in the projection for GEOS.
      expect(m.hausdorff).toBeLessThan(0.006 * 3000 + 5);
    }
  });

  it.skipIf(!havePy)('overlays parcel layers as GEOS does: intersect, union, erase, symmetric difference', () => {
    const c = centreOf(A[210].geom);
    for (const op of ['intersect', 'union', 'erase', 'symdiff']) {
      const o = overlay(A, B, op, { aFields: ['pid', 'zone', 'value'], bFields: ['pid', 'zone', 'value'] });
      expect(o.failed).toEqual([]);
      const r = ref({ op: 'overlay', centre: [c.lat, c.lon], a: A.map((f) => gj(f.geom)), b: B.map((f) => gj(f.geom)), ours: o.features.map((f) => gj(f.geom)), kind: op });
      console.log(`overlay ${op}: ${o.features.length} pieces; GEOS area ${r.compare.ref.toFixed(1)} m², symmetric difference ${r.compare.symdiff.toExponential(2)} m²`);
      // Intersection points are computed in a local frame and measured in a PROJ projection: the
      // difference follows the boundaries, so it is bounded in m² over these 4 km² of parcels.
      expect(r.compare.symdiff).toBeLessThan(1);
      // The pieces do not overlap: their areas add up to the union of them.
      expect(Math.abs(r.oursPieceArea - r.compare.ours) / r.compare.ours).toBeLessThan(1e-7);
      if (op === 'intersect') {
        expect(o.features.length).toBe(r.pairs);
        expect(o.features[0].attrs).toHaveProperty('pid_2');
      }
    }
  }, 300000);

  it.skipIf(!havePy)('dissolves by attribute as GEOS does', () => {
    const groups = dissolveFeatures(A, { field: 'zone', run: run.dissolve });
    expect(groups.map((g) => g.value).sort()).toEqual(['Z0', 'Z1', 'Z2', 'Z3', 'Z4']);
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(A.length);
    const order = groups.map((g) => g.value);
    const c = centreOf(A[210].geom);
    const r = ref({ op: 'dissolve', centre: [c.lat, c.lon], features: A.map((f) => gj(f.geom)), groups: A.map((f) => order.indexOf(f.attrs.zone)), ours: Object.fromEntries(groups.map((g, k) => [k, gj(g.geom)])) });
    for (const m of Object.values(r.groups)) expect(m.symdiff / m.ref).toBeLessThan(1e-7);
    const all = dissolveFeatures(A, { run: run.dissolve });
    expect(all).toHaveLength(1);
    expect(all[0].geom.type).toBe('Polygon');
  });

  it.skipIf(!havePy)('joins by intersects, within, contains and nearest as GEOS does', () => {
    const P = points(400);
    const c = centreOf(A[210].geom);
    const cases = [
      { targets: A, joins: P, predicate: 'intersects', field: 'v' },
      { targets: P, joins: A, predicate: 'within', field: 'value' },
      { targets: A, joins: P, predicate: 'contains', field: 'v' },
      { targets: A, joins: roads(), predicate: 'intersects', field: null },
    ];
    for (const k of cases) {
      const ours = spatialJoin(k.targets, k.joins, { predicate: k.predicate, field: k.field });
      const r = ref({ op: 'join', centre: [c.lat, c.lon], targets: k.targets.map((f) => gj(f.geom)), joins: k.joins.map((f) => gj(f.geom)), predicate: k.predicate, field: k.field, values: k.joins.map((f) => (k.field ? f.attrs[k.field] : null)) });
      const mism = ours.map((o, i) => [o.attrs.join_count, r.targets[i].count]).filter(([a, b]) => a !== b);
      console.log(`join ${k.predicate}: ${ours.filter((o) => o.attrs.join_count).length} of ${ours.length} targets matched, ${mism.length} differ from GEOS`);
      expect(mism).toEqual([]);
      if (k.field) ours.forEach((o, i) => expect(o.attrs[`join_${k.field}_sum`] ?? null).toEqual(r.targets[i].sum));
    }
    const near = spatialJoin(P.slice(0, 80), roads(), { predicate: 'nearest' });
    const r = ref({ op: 'join', centre: [c.lat, c.lon], targets: P.slice(0, 80).map((f) => gj(f.geom)), joins: roads().map((f) => gj(f.geom)), predicate: 'nearest' });
    near.forEach((o, i) => {
      expect(o.attrs.join_name).toBe(roads()[r.targets[i].nearest].attrs.name);
      expect(Math.abs(o.attrs.join_distance - r.targets[i].distance)).toBeLessThan(0.002 * r.targets[i].distance + 0.01);
    });
  });

  it('overlays and dissolves layers that straddle the antimeridian (council S1)', () => {
    const sq = (x0, y0, x1, y1, attrs) => ({ geom: fromParts('Polygon', [[[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]]]), attrs });
    // A buffer cut at ±180°: one square either side.
    const A = [sq(179, 0, 180, 1, { side: 'E' }), sq(-180, 0, -179, 1, { side: 'W' })];
    const B = [sq(179.5, 0.2, 179.8, 0.8, { b: 1 })];
    const area = (g) => {
      let a = 0;
      for (const [k, s] of g.polys.entries()) {
        const end = g.polys[k + 1] ?? g.parts.length;
        for (let r = s; r < end; r++) {
          const from = g.parts[r];
          const to = g.parts[r + 1] ?? g.xyz.length / 3;
          const pts = [];
          for (let i = from; i < to; i++) pts.push([g.xyz[3 * i + 1], g.xyz[3 * i]]);
          a += (r === s ? 1 : -1) * Math.abs(core.polygonArea(pts).area);
        }
      }
      return a;
    };
    const lons = (g) => g.xyz.filter((_, k) => k % 3 === 0);
    const inter = overlay(A, B, 'intersect').features;
    expect(inter).toHaveLength(1);
    expect(Math.abs(area(inter[0].geom) - area(B[0].geom)) / area(B[0].geom)).toBeLessThan(1e-6);
    const erase = overlay(A, B, 'erase').features;
    expect(erase).toHaveLength(2);
    for (const f of erase) expect(Math.max(...lons(f.geom)) - Math.min(...lons(f.geom))).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.abs(erase.reduce((s, f) => s + area(f.geom), 0) - (area(A[0].geom) + area(A[1].geom) - area(B[0].geom))) / area(A[0].geom)).toBeLessThan(1e-6);
    // Dissolve: one feature, still cut at ±180°, both squares' area.
    const [d] = dissolveFeatures(A, { run: run.dissolve });
    expect(d.geom.type).toBe('MultiPolygon');
    expect(Math.max(...lons(d.geom))).toBeLessThanOrEqual(180);
    expect(Math.min(...lons(d.geom))).toBeGreaterThanOrEqual(-180);
    expect(Math.abs(area(d.geom) - area(A[0].geom) - area(A[1].geom)) / area(A[0].geom)).toBeLessThan(1e-6);
  });

  it('finds the nearest feature for a target far from the layer centre (council S2)', () => {
    // Targets at 80° N and 0° N centre the layer at 40° N.
    const F80 = localFrame(80, 10);
    const pt = (lon, lat, attrs) => ({ geom: fromParts('Point', [[[lon, lat, 0]]]), attrs });
    const at80 = (x, y, attrs) => pt(...F80.from(x, y), attrs);
    const targets = [pt(10, 80, { t: 'north' }), pt(10, 0, { t: 'equator' })];
    const joins = [at80(0, 1000, { n: 'north 1000 m' }), at80(500, 0, { n: 'east 500 m' })];
    const r = spatialJoin(targets, joins, { predicate: 'nearest' });
    expect(r[0].attrs.join_n).toBe('east 500 m');
    expect(r[0].attrs.join_distance).toBeCloseTo(500, 0);
    const only = spatialJoin(targets.slice(0, 1).concat(targets[1]), joins.slice(1), { predicate: 'nearest', maxDistance: 600 });
    expect(only[0].attrs.join_count).toBe(1);
  });

  it('keeps polygons whole in layers that span more than 180° of longitude (council round 1b, S1)', () => {
    const box = (x0, y0, x1, y1, attrs) => ({ geom: fromParts('Polygon', [[[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]]]), attrs });
    const pt = (lon, lat, attrs) => ({ geom: fromParts('Point', [[[lon, lat, 0]]]), attrs });
    const A = [box(61, 30, 70, 40, { a: 'asia' }), box(-125, 25, -67, 49, { a: 'usa' })];
    const B = [box(-100, 30, -90, 40, { b: 1 })];
    const lonsOf = (g) => g.xyz.filter((_, k) => k % 3 === 0);
    const inter = overlay(A, B, 'intersect').features;
    expect(inter).toHaveLength(1);
    expect(inter[0].attrs.a).toBe('usa');
    const erase = overlay(A, B, 'erase').features;
    expect(erase).toHaveLength(2);
    const usa = erase.find((f) => f.attrs.a === 'usa');
    expect(Math.min(...lonsOf(usa.geom))).toBeCloseTo(-125, 9);
    expect(Math.max(...lonsOf(usa.geom))).toBeCloseTo(-67, 9);
    const j = spatialJoin(A, [pt(-95, 35, { v: 1 }), pt(65, 35, { v: 2 })], { predicate: 'intersects', field: 'v' });
    expect(j.map((x) => x.attrs.join_count)).toEqual([1, 1]);
    const near = spatialJoin([pt(-118.9, 35, {})], [pt(-110, 35, { n: 'far' }), pt(-119.1, 35, { n: 'near' }), pt(65, 35, { n: 'asia' })], { predicate: 'nearest' });
    expect(near[0].attrs.join_n).toBe('near');
    const [d] = dissolveFeatures(A, { run: run.dissolve });
    expect(Math.max(...lonsOf(d.geom)) - Math.min(...lonsOf(d.geom))).toBeCloseTo(195, 6);
  });

  it('leaves missing values out of join statistics (council round 1b, S2)', () => {
    const sq = { geom: fromParts('Polygon', [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]]), attrs: {} };
    const pt = (v) => ({ geom: fromParts('Point', [[[0.5, 0.5, 0]]]), attrs: { v } });
    const [r] = spatialJoin([sq], [pt(10), pt(null), pt(''), pt(true), pt('4')], { field: 'v' });
    expect(r.attrs).toMatchObject({ join_count: 5, join_v_sum: 14, join_v_mean: 7, join_v_min: 4, join_v_max: 10 });
  });

  it('takes rings in either winding: holes stay holes, opposite-wound overlaps merge (council round 2, S1)', () => {
    const F = localFrame(39.74, -104.99);
    const ring = (pts) => pts.map(([x, y]) => [...F.from(x, y), 0]);
    const ccw = (x0, y0, x1, y1) => ring([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    const cw = (x0, y0, x1, y1) => ring([[x0, y0], [x0, y1], [x1, y1], [x1, y0]]);
    // A 100 m square with a 20 m hole wound the same way as the outer ring, shrunk by 5 m.
    const holed = fromParts('Polygon', [ccw(0, 0, 100, 100), ccw(40, 40, 60, 60)]);
    const [b] = buffer([holed], { distance: -5, geodesic: false });
    const holes = b.parts.length - (b.polys?.length ?? 1);
    expect(holes).toBe(1);
    // Two overlapping squares of opposite winding dissolve into one 150 m² rectangle.
    const [d] = dissolveFeatures([{ geom: fromParts('Polygon', [ccw(0, 0, 10, 10)]), attrs: {} }, { geom: fromParts('Polygon', [cw(5, 0, 15, 10)]), attrs: {} }], { run: run.dissolve });
    expect(d.geom.type).toBe('Polygon');
    const pts = [];
    for (let k = 0; k < d.geom.xyz.length; k += 3) pts.push([d.geom.xyz[k + 1], d.geom.xyz[k]]);
    expect(Math.abs(core.polygonArea(pts).area)).toBeCloseTo(150, 0);
  });

  it('never overwrites a target field with a join result (council round 2, S2)', () => {
    const sq = { geom: fromParts('Polygon', [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]]), attrs: { join_count: 'kept' } };
    const pt = { geom: fromParts('Point', [[[0.5, 0.5, 0]]]), attrs: { count: 7, v: 3 } };
    const [once] = spatialJoin([sq], [pt], { field: 'v' });
    expect(once.attrs).toMatchObject({ join_count: 'kept', join_count_2: 1, join_v_sum: 3 });
    const [twice] = spatialJoin([{ ...sq, attrs: once.attrs }], [pt], { field: 'v' });
    expect(twice.attrs).toMatchObject({ join_count: 'kept', join_count_2: 1, join_count_3: 1, join_v_sum: 3, join_v_sum_2: 3 });
    // Nearest: the join feature's own "count" does not clash with the match count.
    const [near] = spatialJoin([{ geom: fromParts('Point', [[[2, 2, 0]]]), attrs: {} }], [pt], { predicate: 'nearest' });
    expect(near.attrs.join_count).toBe(1);
    expect(near.attrs.join_count_2).toBe(7);
  });

  it('relates shared boundaries, holes and touching geometries', () => {
    const F = localFrame(39.74, -104.99);
    const sq = (x, y, s, hole = null) => fromParts('Polygon', [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => [...F.from(a, b), 0]), ...(hole ? [hole.map(([a, b]) => [...F.from(a, b), 0])] : [])]);
    const big = sq(0, 0, 100);
    const half = sq(0, 0, 50);
    expect(relate(half, big, F)).toMatchObject({ intersects: true, within: true, contains: false });
    expect(relate(big, half, F)).toMatchObject({ within: false, contains: true });
    const ring = sq(0, 0, 100, [[40, 40], [60, 40], [60, 60], [40, 60]]);
    expect(relate(sq(30, 30, 40), ring, F).within).toBe(false);
    expect(relate(sq(100, 0, 10), big, F)).toMatchObject({ intersects: true, within: false });
    expect(relate(sq(110, 0, 10), big, F).distance).toBeCloseTo(10, 6);
    // Boundary contact is not "within" (GEOS): a point or a line on Y's edge, a road on the edge
    // two parcels share, and the notch of a U-shaped polygon, which lies outside it.
    const pt = (x, y) => fromParts('Point', [[[...F.from(x, y), 0]]]);
    const line = (...xy) => fromParts('LineString', [xy.map(([a, b]) => [...F.from(a, b), 0])]);
    expect(relate(pt(50, 0), big, F)).toMatchObject({ intersects: true, within: false });
    expect(relate(pt(50, 50), big, F).within).toBe(true);
    expect(relate(line([0, 0], [100, 0]), big, F)).toMatchObject({ intersects: true, within: false });
    expect(relate(line([0, 0], [100, 100]), big, F).within).toBe(true);
    expect(relate(big, big, F)).toMatchObject({ within: true, contains: true });
    const road = { geom: line([100, 0], [100, 100]), attrs: {} };
    const parcels = [{ geom: big, attrs: {} }, { geom: sq(100, 0, 100), attrs: {} }];
    expect(spatialJoin([road], parcels, { predicate: 'within' })[0].attrs.join_count).toBe(0);
    expect(spatialJoin([road], parcels, { predicate: 'intersects' })[0].attrs.join_count).toBe(2);
    const U = fromParts('Polygon', [[[0, 0], [30, 0], [30, 30], [20, 30], [20, 10], [10, 10], [10, 30], [0, 30]].map(([a, b]) => [...F.from(a, b), 0])]);
    const notch = fromParts('Polygon', [[[10, 10], [20, 10], [20, 30], [10, 30]].map(([a, b]) => [...F.from(a, b), 0])]);
    expect(relate(notch, U, F)).toMatchObject({ intersects: true, within: false });
    expect(relate(U, notch, F).contains).toBe(false);
    expect(relate(sq(1, 1, 8), U, F).within).toBe(true);
  });

  it.skipIf(!havePy || !haveTiger)('a county of TIGER/Line block groups and roads matches GEOS (corpus)', () => {
    const t = ref({ op: 'tiger', bg: join(TIGER, 'tl_2024_08_bg.zip'), roads: join(TIGER, 'tl_2024_08013_roads.zip'), county: '013', polygonsFields: ['GEOID', 'TRACTCE'], linesFields: ['FULLNAME', 'MTFCC'], limit: 400 });
    const bg = t.polygons.map((f) => ({ geom: fromGeoJSON(f.geometry), attrs: f.properties }));
    const rd = t.lines.map((f) => ({ geom: fromGeoJSON(f.geometry), attrs: f.properties }));
    const c = centreOf(bg[0].geom);
    // Dissolve block groups into tracts.
    const tracts = dissolveFeatures(bg, { field: 'TRACTCE', run: run.dissolve });
    const order = tracts.map((g) => g.value);
    const rd1 = ref({ op: 'dissolve', centre: [c.lat, c.lon], features: bg.map((f) => gj(f.geom)), groups: bg.map((f) => order.indexOf(f.attrs.TRACTCE)), ours: Object.fromEntries(tracts.map((g, k) => [k, gj(g.geom)])) });
    const worst = Math.max(...Object.values(rd1.groups).map((m) => m.symdiff / m.ref));
    console.log(`TIGER Boulder: ${bg.length} block groups → ${tracts.length} tracts, worst symmetric difference ${(worst * 100).toExponential(2)} %`);
    expect(worst).toBeLessThan(1e-6);
    // 30 m geodesic road buffers, overlaid with the block groups.
    const sample = rd.slice(0, 120);
    const buf = buffer(sample.map((f) => f.geom), { distance: 30, geodesic: true });
    const rb = ref({ op: 'buffer', features: sample.map((f) => gj(f.geom)), centres: sample.map((f) => [centreOf(f.geom).lat, centreOf(f.geom).lon]), ours: buf.map(gj), distance: 30, cap: 'round', quadSegs: 8 });
    const worstB = Math.max(...rb.features.map((m) => m.symdiff / m.ref));
    expect(worstB).toBeLessThan(0.005);
    const zones = buf.map((g, i) => ({ geom: g, attrs: { road: sample[i].attrs.FULLNAME } })).filter((f) => f.geom);
    const o = overlay(bg, zones, 'intersect', { aFields: ['GEOID', 'TRACTCE'], bFields: ['road'] });
    expect(o.failed).toEqual([]);
    const ro = ref({ op: 'overlay', centre: [c.lat, c.lon], a: bg.map((f) => gj(f.geom)), b: zones.map((f) => gj(f.geom)), ours: o.features.map((f) => gj(f.geom)), kind: 'intersect' });
    console.log(`TIGER Boulder: ${sample.length} roads buffered 30 m (worst ${(worstB * 100).toFixed(4)} %), ${o.features.length} block group × road-zone pieces, symmetric difference ${(ro.compare.symdiff / ro.compare.ref).toExponential(2)}`);
    expect(ro.compare.symdiff / ro.compare.ref).toBeLessThan(1e-6);
  }, 900000);
});
