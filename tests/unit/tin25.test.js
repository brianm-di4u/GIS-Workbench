// REQ-GAP-39 (GR-13): the `tin` WASM bundle (crates/gw-tin) against independent oracles.
// * Unconstrained triangulation: scipy.spatial.Delaunay (Qhull, gw-te) — the same triangle set.
// * Constrained cases: no `triangle` or CGAL binding is in gw-te, so an independent exact check
//   written here (BigInt predicates on the 1 mm grid): a valid triangulation of the convex hull,
//   every line's edges present, and no vertex inside a triangle's circumcircle that the triangle
//   can see (constraints block the view).
// * TIN to grid: matplotlib.tri linear interpolation on the bundle's own triangles, and
//   the same on Qhull's own triangles for unconstrained points (tests/tools/tin_oracle.py says why).
// * Corpus (E:\TE-corpus, skipped when absent): a 1000 × 1000 window of the USGS 3DEP 1 m DEM
//   (1 M posts) and LiDAR ground points: build time, memory and edit latency (printed and kept in
//   reports/tin25-measure.json), and the thinning tolerance checked post by post.
// The JS module code (encodeTinEdits, tin-io conversions and writers) is tested without the bundle.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tempDir } from '../tools/temp-dir.mjs';
import { execFileSync } from 'node:child_process';
import { TinBundle, encodeTinEdits, KIND, FILE_KEY0 } from '../../app/src/wasm/tin.js';
import { frameAt, toPlane, toGeo, gridSpec, rasterGrid, importForm, exportForm, fromFeatures, fromTable, writeLandXml, writeCsv } from '../../app/src/analysis/tin-io.js';
import { fromParts } from '../../app/src/vector/geom.js';

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    const raw = join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_tin.wasm');
    return existsSync(`${raw}.opt.wasm`) ? `${raw}.opt.wasm` : raw;
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const GWTE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const haveTe = existsSync(`${GWTE}/python.exe`);
const ORACLE = resolve('tests/tools/tin_oracle.py');
const DEM = 'E:/TE-corpus/usgs-3dep-1m-x48y441-drcog2020/USGS_1M_13_x48y441_CO_DRCOG_2020_B20.tif';
const LAZ = 'E:/TE-corpus/lidar-3dep-co-drcog-2020-2x2/USGS_LPC_CO_DRCOG_2020_B20_w0474n4416.laz';
const DERIVED = 'E:/gwb25/data-tin/derived';
const MEASURE = resolve('reports/tin25-measure.json');

const bundle = () => new TinBundle(new WebAssembly.Module(readFileSync(wasmPath)));
const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
let scratchDir = null;
const scratch = () => (scratchDir ??= tempDir('gw-tin25'));
function oracle(job) {
  const d = scratch();
  const p = join(d, `${job.mode}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(job));
  execFileSync(`${GWTE}/python.exe`, ['-I', ORACLE, p], { env, timeout: 900000 });
}
const writeBin = (name, arr) => {
  const p = join(scratch(), name);
  writeFileSync(p, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
  return p;
};
function measure(key, value) {
  let m = {};
  try {
    m = JSON.parse(readFileSync(MEASURE, 'utf8'));
  } catch {
    /* first */
  }
  m[key] = value;
  mkdirSync(resolve('reports'), { recursive: true });
  writeFileSync(MEASURE, JSON.stringify(m, null, 1));
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// ---- the independent exact checker (BigInt on the 1 mm grid) ----
/** Grid integers of the mesh's vertices relative to its first vertex. */
function gridOf(m, q = 0.001) {
  const n = m.xyz.length / 3;
  const X = new Array(n);
  const Y = new Array(n);
  for (let k = 0; k < n; k++) {
    X[k] = BigInt(Math.round((m.xyz[3 * k] - m.xyz[0]) / q));
    Y[k] = BigInt(Math.round((m.xyz[3 * k + 1] - m.xyz[1]) / q));
  }
  return { X, Y, n };
}
const sgn = (v) => (v > 0n ? 1 : v < 0n ? -1 : 0);
const orient = (ax, ay, bx, by, cx, cy) => sgn((ax - cx) * (by - cy) - (ay - cy) * (bx - cx));
function incircle(ax, ay, bx, by, cx, cy, dx, dy) {
  const [adx, ady, bdx, bdy, cdx, cdy] = [ax - dx, ay - dy, bx - dx, by - dy, cx - dx, cy - dy];
  return sgn((adx * adx + ady * ady) * (bdx * cdy - cdx * bdy) + (bdx * bdx + bdy * bdy) * (cdx * ady - adx * cdy) + (cdx * cdx + cdy * cdy) * (adx * bdy - bdx * ady));
}

/**
 * Check a mesh (TinBundle.mesh of the whole TIN): every triangle counter-clockwise, every edge
 * in one or two triangles (opposite ways), the triangles' area the hull's (no overlap, no gap),
 * the constrained edges `cons` ([[a, b]…] local ids) are triangle edges, and no vertex in a
 * triangle's circumcircle is visible from it. `sample` checks only every k-th triangle for the
 * Delaunay part. Returns {triangles, violations, hullOk, ...}.
 */
function exactCheck(m, cons = [], { sample = 1 } = {}) {
  const { X, Y, n } = gridOf(m);
  const nt = m.tris.length / 3;
  const T = m.tris;
  const edges = new Map();
  let area2 = 0n;
  let ccw = true;
  for (let k = 0; k < nt; k++) {
    const [a, b, c] = [T[3 * k], T[3 * k + 1], T[3 * k + 2]];
    const ar = (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
    if (ar <= 0n) ccw = false;
    area2 += ar;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = `${p},${q}`;
      if (edges.has(key)) return { error: `edge ${key} twice in one direction` };
      edges.set(key, k);
    }
  }
  // Hull: boundary edges (no reverse) must form the convex hull of all vertices.
  const boundary = [];
  for (const key of edges.keys()) {
    const [p, q] = key.split(',').map(Number);
    if (!edges.has(`${q},${p}`)) boundary.push([p, q]);
  }
  let hullOk = true;
  for (const [p, q] of boundary) {
    // Every vertex is left of or on each boundary edge (convexity).
    for (let v = 0; v < n; v += Math.max(1, Math.floor(n / 4000))) if (orient(X[p], Y[p], X[q], Y[q], X[v], Y[v]) < 0) hullOk = false;
  }
  // Hull area from the boundary loop (shoelace on its edges) equals the triangles' area.
  let hullArea2 = 0n;
  for (const [p, q] of boundary) hullArea2 += X[p] * Y[q] - X[q] * Y[p];
  const consMissing = cons.filter(([a, b]) => !edges.has(`${a},${b}`) && !edges.has(`${b},${a}`)).length;
  // Delaunay emptiness with visibility, on a bucket grid of vertices.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < n; k++) {
    const [x, y] = [m.xyz[3 * k], m.xyz[3 * k + 1]];
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const cells = Math.max(1, Math.floor(Math.sqrt(n / 4)));
  const cw = Math.max(1e-9, (x1 - x0) / cells);
  const ch = Math.max(1e-9, (y1 - y0) / cells);
  const bucket = new Map();
  for (let k = 0; k < n; k++) {
    const key = Math.min(cells - 1, Math.floor((m.xyz[3 * k] - x0) / cw)) * 100003 + Math.min(cells - 1, Math.floor((m.xyz[3 * k + 1] - y0) / ch));
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key).push(k);
  }
  const consSeg = cons.map(([a, b]) => [3n * X[a], 3n * Y[a], 3n * X[b], 3n * Y[b]]);
  let violations = 0;
  let checked = 0;
  for (let k = 0; k < nt; k += sample) {
    const [a, b, c] = [T[3 * k], T[3 * k + 1], T[3 * k + 2]];
    const P = (i) => [m.xyz[3 * i], m.xyz[3 * i + 1]];
    const [[ax, ay], [bx, by], [cx, cy]] = [P(a), P(b), P(c)];
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (d === 0) continue;
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy) * (1 + 1e-9) + 0.002;
    const i0 = Math.max(0, Math.floor((ux - r - x0) / cw));
    const i1 = Math.min(cells - 1, Math.floor((ux + r - x0) / cw));
    const j0 = Math.max(0, Math.floor((uy - r - y0) / ch));
    const j1 = Math.min(cells - 1, Math.floor((uy + r - y0) / ch));
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4000) continue; // a huge hull sliver: skipped (counted below)
    checked++;
    const cxx = X[a] + X[b] + X[c];
    const cyy = Y[a] + Y[b] + Y[c];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (const v of bucket.get(i * 100003 + j) ?? []) {
          if (v === a || v === b || v === c) continue;
          if (incircle(X[a], Y[a], X[b], Y[b], X[c], Y[c], X[v], Y[v]) <= 0) continue;
          const pv = [3n * X[v], 3n * Y[v]];
          const hidden = consSeg.some(([sx, sy, ex, ey]) => orient(cxx, cyy, pv[0], pv[1], sx, sy) * orient(cxx, cyy, pv[0], pv[1], ex, ey) < 0 && orient(sx, sy, ex, ey, cxx, cyy) * orient(sx, sy, ex, ey, pv[0], pv[1]) < 0);
          if (!hidden) violations++;
        }
  }
  return { triangles: nt, ccw, hullOk, areaOk: area2 === hullArea2, consMissing, violations, checked, boundary: boundary.length };
}

/**
 * Input index of each mesh vertex: the input point within 1 mm (the bundle snaps to a 1 mm grid
 * about its own origin, so the coordinates differ by up to 0.5 mm). Unmatched: undefined.
 */
function matchInput(pts, m) {
  const n = pts.length / 3;
  const cell = new Map();
  const key = (x, y) => `${Math.floor(x * 100)},${Math.floor(y * 100)}`;
  for (let k = 0; k < n; k++) {
    const kk = key(pts[3 * k], pts[3 * k + 1]);
    if (!cell.has(kk)) cell.set(kk, []);
    cell.get(kk).push(k);
  }
  return Array.from({ length: m.xyz.length / 3 }, (_, v) => {
    const [x, y] = [m.xyz[3 * v], m.xyz[3 * v + 1]];
    let best;
    let bd = 1e-3;
    for (const dx of [-0.01, 0, 0.01])
      for (const dy of [-0.01, 0, 0.01])
        for (const k of cell.get(key(x + dx, y + dy)) ?? []) {
          const d = Math.hypot(pts[3 * k] - x, pts[3 * k + 1] - y);
          if (d <= bd) [best, bd] = [k, d];
        }
    return best;
  });
}

/** Run scipy on the mesh's own (snapped) coordinates in input order → triangle keys; and the mesh's keys. */
function scipyCompare(pts, m, tag) {
  const n = pts.length / 3;
  const idx = matchInput(pts, m);
  const xy = new Float64Array(2 * n).fill(NaN);
  const x0 = m.xyz[0];
  const y0 = m.xyz[1];
  idx.forEach((k, v) => {
    if (k === undefined) return;
    xy[2 * k] = m.xyz[3 * v] - x0;
    xy[2 * k + 1] = m.xyz[3 * v + 1] - y0;
  });
  // Input points the bundle merged as duplicates keep their own coordinates (scipy sees them too).
  for (let k = 0; k < n; k++) if (Number.isNaN(xy[2 * k])) [xy[2 * k], xy[2 * k + 1]] = [pts[3 * k] - x0, pts[3 * k + 1] - y0];
  const out = join(scratch(), `${tag}.tri`);
  oracle({ mode: 'delaunay', points: writeBin(`${tag}.f64`, xy), out });
  const s = new Uint32Array(new Uint8Array(readFileSync(out)).buffer);
  const mine = new Set();
  for (let k = 0; k < m.tris.length / 3; k++) mine.add([idx[m.tris[3 * k]], idx[m.tris[3 * k + 1]], idx[m.tris[3 * k + 2]]].sort((a, b) => a - b).join(','));
  let same = 0;
  for (let k = 0; k < s.length / 3; k++) if (mine.has(`${s[3 * k]},${s[3 * k + 1]},${s[3 * k + 2]}`)) same++;
  return { mine: mine.size, scipy: s.length / 3, same, unmatched: idx.filter((k) => k === undefined).length };
}

/** Constrained edges of the mesh as local id pairs. */
const consOf = (m) => Array.from({ length: m.edges.length / 2 }, (_, k) => [m.edges[2 * k], m.edges[2 * k + 1]]);

// ---- pure JS ----
describe('REQ-GAP-39 TIN plumbing (no bundle)', () => {
  it('encodes every edit kind and refuses unknown ones', () => {
    const a = encodeTinEdits([
      { kind: 'addpoint', params: { x: 1, y: 2, z: 3 } },
      { kind: 'addline', params: { key: 7, type: 'soft', closed: false, pts: [[0, 0, NaN], [1, 1, NaN]] } },
      { kind: 'profile', params: { key: 8, mode: 'ridge', pts: [[0, 0], [5, 5]] } },
      { kind: 'retri', params: { ring: [[0, 0], [1, 0], [0, 1]] } },
    ]);
    expect(a.slice(0, 5)).toEqual([4, 1, 1, 2, 3]);
    expect(a.slice(5, 10)).toEqual([4, 7, KIND.soft, 0, 2]);
    expect(() => encodeTinEdits([{ kind: 'explode', params: {} }])).toThrow(/explode/);
  });

  it('plane frame, DEM grid spec and raster grid are consistent', () => {
    const f = frameAt(39.9, -105.29);
    const [x, y] = toPlane(f, -105.28, 39.91);
    const [lon, lat] = toGeo(f, x, y);
    expect(lon).toBeCloseTo(-105.28, 12);
    expect(lat).toBeCloseTo(39.91, 12);
    const g = { lat0: 39.95, lon0: -105.33, dlat: 1 / 10800, dlon: 1 / 10800, width: 100, height: 80 };
    const s = gridSpec(f, g);
    const [px, py] = toPlane(f, g.lon0 + 7 * g.dlon, g.lat0 - 9 * g.dlat);
    expect(s.ax + s.bx * 7).toBeCloseTo(px, 6);
    expect(s.ay + s.by * 9).toBeCloseTo(py, 6);
    const r = rasterGrid(f, [-500, -300, 500, 300], 2);
    expect(r.grid.width).toBeGreaterThan(490);
    expect(() => rasterGrid(f, [-1e6, -1e6, 1e6, 1e6], 0.1)).toThrow(/million posts/);
  });

  it('import and export forms; others refused by name', () => {
    expect(importForm('EG.xml')).toBe('landxml');
    expect(importForm('pts.CSV')).toBe('csv');
    expect(importForm('lines.geojson')).toBe('geojson');
    expect(importForm('brk.zip')).toBe('shapefile');
    for (const [f, re] of [['site.dwg', /CAD drawings/], ['tin.adf', /Esri TIN/], ['s.ts', /GOCAD/], ['m.obj', /3-D model/], ['c.laz', /point cloud/], ['d.tif', /elevation grids/], ['a.kml', /Shapefile, GeoJSON or CSV/], ['x.foo', /not a TIN form/]]) expect(() => importForm(f)).toThrow(re);
    expect(exportForm('landxml')).toBe('landxml');
    expect(() => exportForm('dxf')).toThrow(/LandXML/);
  });

  it('mass points and lines from features and tables', () => {
    const f = frameAt(40, -105);
    const feats = [
      { geom: fromParts('Point', [[[-105, 40, 1600]]]), attrs: {} },
      { geom: fromParts('LineString', [[[-105.001, 40, 1601], [-105, 40.001, 1602]]]), attrs: {} },
      { geom: fromParts('LineString', [[[-105.002, 40, 0], [-105, 40.002, 0]]]), attrs: {} },
      { geom: fromParts('LineString', [[[-105.003, 40, 5], [-105, 40.003, 5]]]), attrs: { kind: 'soft' } },
      { geom: fromParts('Polygon', [[[-105, 40, 0], [-104.999, 40, 0], [-104.999, 40.001, 0], [-105, 40, 0]]]), attrs: {} },
      { geom: fromParts('Polygon', [[[-105, 40, 0], [-104.998, 40, 0], [-104.998, 40.002, 0], [-105, 40, 0]]]), attrs: { type: 'boundary' } },
    ];
    const r = fromFeatures(feats, f);
    expect(r.points.length).toBe(1);
    expect(r.lines.map((l) => l.type)).toEqual(['hard', 'soft', 'soft', 'void', 'outer']);
    expect(r.lines[3].closed && r.lines[3].pts.length).toBe(3);
    const tab = { header: ['line', 'kind', 'lon', 'lat', 'z'], rows: 5, cols: 5, values: new Float64Array([NaN, NaN, -105, 40, 1, NaN, NaN, -105.001, 40, 2, 1, NaN, -105, 40.001, 3, 1, NaN, -105.001, 40.001, 4, NaN, NaN, -105.002, 40.002, NaN]), text: new Map([[1, ['', '', 'soft', 'soft', '']]]) };
    const r2 = fromTable(tab, f);
    expect(r2.points.length).toBe(2);
    expect(r2.lines).toHaveLength(1);
    expect(r2.lines[0].type).toBe('soft');
    expect(r2.skipped).toBe(1);
    expect(() => fromTable({ header: ['x', 'y', 'z'], rows: 0, cols: 3, values: new Float64Array(0) }, f)).toThrow(/EPSG/);
  });

  it('LandXML and CSV writers', () => {
    const x = writeLandXml({ name: 'EG & co', epsg: 26913, crsName: 'NAD83 / UTM zone 13N', date: '2026-11-03', time: '12:00:00' }, new Float64Array([500000, 4400000, 1600.25, 500010, 4400000, 1601.5, 500000, 4400010, 1602]), new Uint32Array([0, 1, 2]), [{ type: 'hard', pts: [[500000, 4400000, 1600.25], [500010, 4400000, 1601.5]] }, { type: 'void', closed: true, pts: [[500001, 4400001, 0], [500002, 4400001, 0], [500001, 4400002, 0]] }], new Uint8Array([1]));
    expect(x).toContain('<P id="1">4400000 500000 1600.25</P>');
    expect(x).toContain('<F i="1">1 2 3</F>');
    expect(x).toContain('brkType="standard"');
    expect(x).toContain('bndType="void"');
    expect(x).toContain('EG &amp; co');
    expect(writeCsv([[-105, 40, 1600]], [{ key: 3, type: 'soft', pts: [[-105, 40, 1], [-105.1, 40.1, 2]] }]).split('\n')).toHaveLength(5);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-39 TIN bundle', () => {
  it('random points: the same triangles as scipy.spatial.Delaunay, and exactly valid', { timeout: 300000 }, () => {
    const B = bundle();
    const r = lcg(7);
    const n = 20000;
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) {
      pts[3 * k] = 480000 + 3000 * r();
      pts[3 * k + 1] = 4415000 + 2000 * r();
      pts[3 * k + 2] = 1600 + 50 * Math.sin(pts[3 * k] / 300);
    }
    const { id, report } = B.fromPoints(pts);
    expect(report.vertices).toBe(n);
    const m = B.mesh(id);
    const chk = exactCheck(m);
    expect(chk).toMatchObject({ ccw: true, hullOk: true, areaOk: true, violations: 0 });
    if (haveTe) {
      const c = scipyCompare(pts, m, 'random20k');
      expect(c.unmatched).toBe(0);
      expect(c.scipy).toBe(c.mine);
      expect(c.same).toBe(c.mine);
      measure('scipy_random_20k', c);
    }
    B.dispose(id);
  });

  it('constrained: lines, crossings and rings present; constrained-Delaunay exactly; edits keep it', { timeout: 300000 }, () => {
    const B = bundle();
    const r = lcg(11);
    const n = 3000;
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) {
      pts[3 * k] = 1000 * r();
      pts[3 * k + 1] = 1000 * r();
      pts[3 * k + 2] = 100 + 20 * Math.sin(pts[3 * k] / 70) * Math.cos(pts[3 * k + 1] / 90);
    }
    const { id } = B.fromPoints(pts);
    const ops = [];
    let key = 1;
    for (let k = 0; k < 40; k++) {
      const nv = 2 + (k % 5);
      const line = Array.from({ length: nv }, () => [20 + 960 * r(), 20 + 960 * r(), 110 + 10 * r()]);
      ops.push({ kind: 'addline', params: { key: key++, type: k % 3 === 0 ? 'soft' : 'hard', closed: false, pts: line } });
    }
    ops.push({ kind: 'addline', params: { key: key++, type: 'void', closed: true, pts: [[400, 400, 0], [500, 410, 0], [480, 520, 0], [390, 480, 0]] } });
    for (let k = 0; k < 200; k++) ops.push({ kind: 'addpoint', params: { x: 1000 * r(), y: 1000 * r(), z: 105 } });
    ops.push({ kind: 'profile', params: { key: key++, mode: 'drain', pts: [[100, 900], [500, 600], [900, 120]] } });
    ops.push({ kind: 'profile', params: { key: key++, mode: 'ridge', pts: [[900, 900], [150, 150]] } });
    for (let k = 0; k < 10; k++) ops.push({ kind: 'delline', params: { key: 2 + 3 * k } });
    const res = B.apply(id, encodeTinEdits(ops));
    const ok = res.filter((x) => x.ok).length;
    expect(res.filter((x) => x.broken)).toEqual([]);
    expect(ok).toBeGreaterThan(ops.length * 0.95);
    const m = B.mesh(id);
    const chk = exactCheck(m, consOf(m));
    expect(chk).toMatchObject({ ccw: true, hullOk: true, areaOk: true, consMissing: 0, violations: 0 });
    // Every line's path: consecutive vertices are triangle edges, and the path stays on the drawn line.
    const info = B.info(id);
    const lines = B.lines(id);
    expect(lines.length).toBe(info.lines.length);
    const vid = new Map();
    for (let k = 0; k < m.xyz.length / 3; k++) vid.set(`${m.xyz[3 * k]},${m.xyz[3 * k + 1]}`, k);
    const triEdges = new Set();
    for (let k = 0; k < m.tris.length / 3; k++) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) triEdges.add([m.tris[3 * k + a], m.tris[3 * k + b]].sort((p, q) => p - q).join(','));
    let off = 0;
    for (const l of lines) {
      const P = (arr, k) => [arr[3 * k], arr[3 * k + 1]];
      const np = l.path.length / 3;
      for (let k = 0; k + 1 < np + (l.closed ? 1 : 0); k++) {
        const [a, b] = [vid.get(P(l.path, k).join(',')), vid.get(P(l.path, (k + 1) % np).join(','))];
        expect(triEdges.has([a, b].sort((p, q) => p - q).join(','))).toBe(true);
      }
      const nd = l.defs.length / 3;
      for (let k = 0; k < np; k++) {
        const [x, y] = P(l.path, k);
        let best = Infinity;
        for (let s = 0; s + 1 < nd + (l.closed ? 1 : 0); s++) {
          const [ax, ay] = P(l.defs, s);
          const [bx, by] = P(l.defs, (s + 1) % nd);
          const dx = bx - ax;
          const dy = by - ay;
          const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
          best = Math.min(best, Math.hypot(x - ax - u * dx, y - ay - u * dy));
        }
        off = Math.max(off, best);
      }
    }
    expect(off).toBeLessThan(0.01);
    // Ridge and drain profiles fall along their paths.
    // The ridge crosses the earlier drain: one vertex holds one height, the ridge's. That is the one
    // place the drain may rise, and the ridge's result reports it.
    const prof = res.filter((x) => x.profile).map((x) => x.profile);
    expect(prof[0].conflicts).toBe(0);
    expect(prof[1].conflicts).toBeGreaterThan(0);
    const [drainL, ridgeL] = [KIND.drain, KIND.ridge].map((kd) => lines.find((x) => x.kind === kd));
    const onRidge = new Set(Array.from({ length: ridgeL.path.length / 3 }, (_, k) => `${ridgeL.path[3 * k]},${ridgeL.path[3 * k + 1]}`));
    const fall = (l) => {
      const z = Array.from({ length: l.path.length / 3 }, (_, k) => l.path[3 * k + 2]);
      return z.map((v, k) => k).filter((k) => k > 0 && z[k] > z[k - 1] + 1e-9);
    };
    expect(fall(ridgeL)).toEqual([]);
    for (const k of fall(drainL)) expect(onRidge.has(`${drainL.path[3 * k]},${drainL.path[3 * k + 1]}`)).toBe(true);
    // The exclusion ring's inside is a void.
    expect(B.heights(id, new Float64Array([450, 460]))[0]).toBeNaN();
    measure('constrained_3k', { ...chk, lines: lines.length, edits: ops.length, applied: ok, steiner: info.stats.steiner, snapped: info.stats.snapped });
    B.dispose(id);
  });

  it('TIN to grid equals linear interpolation by matplotlib on the same triangles, and scipy for points', { timeout: 300000 }, () => {
    const B = bundle();
    const r = lcg(23);
    const n = 4000;
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) {
      pts[3 * k] = 600 * r();
      pts[3 * k + 1] = 400 * r();
      pts[3 * k + 2] = 1500 + 0.2 * pts[3 * k] + 15 * Math.sin(pts[3 * k + 1] / 40);
    }
    const { id } = B.fromPoints(pts);
    const g = { w: 241, h: 161, ax: 0, ay: 0, bx: 2.5, by: 2.5 };
    const plain = B.raster(id, g);
    const q = new Float64Array(2 * g.w * g.h);
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) q.set([g.ax + g.bx * i, g.ay + g.by * j], 2 * (j * g.w + i));
    // Heights by the bundle's point query agree with its raster.
    const hq = B.heights(id, q);
    let d0 = 0;
    for (let k = 0; k < plain.length; k++) if (Number.isFinite(plain[k])) d0 = Math.max(d0, Math.abs(plain[k] - hq[k]));
    expect(d0).toBeLessThan(5e-4);
    if (haveTe) {
      const m = B.mesh(id);
      const out = join(scratch(), 'mpl.f64');
      oracle({ mode: 'interp', vertices: writeBin('v.f64', m.xyz), triangles: writeBin('t.u32', m.tris), queries: writeBin('q.f64', q), out });
      const ref = new Float64Array(new Uint8Array(readFileSync(out)).buffer);
      const out2 = join(scratch(), 'qhull.f64');
      const v = new Float64Array(m.xyz);
      oracle({ mode: 'qhull_interp', vertices: writeBin('v2.f64', v), queries: writeBin('q2.f64', q), out: out2 });
      const ref2 = new Float64Array(new Uint8Array(readFileSync(out2)).buffer);
      let [dm, ds, nm, nanDiff] = [0, 0, 0, 0];
      for (let k = 0; k < plain.length; k++) {
        if (Number.isFinite(ref[k]) !== Number.isFinite(plain[k])) {
          nanDiff++;
          continue;
        }
        if (!Number.isFinite(ref[k])) continue;
        nm++;
        dm = Math.max(dm, Math.abs(plain[k] - ref[k]));
        ds = Math.max(ds, Math.abs(plain[k] - ref2[k]));
      }
      // f32 output near 1600 m carries 1.2e-4 m.
      expect(dm).toBeLessThan(2.5e-4);
      expect(ds).toBeLessThan(2.5e-4);
      // Posts exactly on the hull may fall either way in the two point-location codes.
      expect(nanDiff).toBeLessThan(g.w * g.h * 0.002);
      measure('raster_vs_oracles', { posts: nm, maxDiffMatplotlib: dm, maxDiffScipy: ds, insideOutsideDisagree: nanDiff });
    }
    B.dispose(id);
  });

  it('edit replay is deterministic across save/load; damaged input refused without a trap', () => {
    const B = bundle();
    const r = lcg(31);
    const pts = new Float64Array(3 * 800).map((_, k) => (k % 3 === 2 ? 100 + 10 * r() : 500 * r()));
    const ops = [];
    for (let k = 0; k < 60; k++) {
      if (k % 3 === 0) ops.push({ kind: 'addpoint', params: { x: 500 * r(), y: 500 * r(), z: 120 } });
      else if (k % 3 === 1) ops.push({ kind: 'addline', params: { key: k, type: 'hard', closed: false, pts: [[20 + 460 * r(), 20 + 460 * r(), 115], [20 + 460 * r(), 20 + 460 * r(), 118]] } });
      else ops.push({ kind: 'delline', params: { key: k - 1 } });
    }
    const a = B.fromPoints(pts).id;
    B.apply(a, encodeTinEdits(ops));
    let b = B.fromPoints(pts).id;
    for (const op of ops) {
      B.apply(b, encodeTinEdits([op]));
      const s = B.save(b);
      B.dispose(b);
      b = B.load(s);
    }
    expect(Buffer.from(B.save(a)).equals(Buffer.from(B.save(b)))).toBe(true);
    // Damaged state and edit lists: refused with a message, the instance keeps working.
    const s = B.save(a);
    for (const cut of [0, 9, 100, s.length - 3]) expect(() => B.load(s.subarray(0, cut))).toThrow(/tin state/);
    expect(() => B.apply(a, [1, 99])).toThrow(/tin edit/);
    expect(() => B.apply(a, [1, 4, 1.5, 1, 0, 2, 0, 0, 0, 1, 1, 1])).toThrow(/tin edit/);
    expect(B.apply(a, [1, 5, 123456])[0]).toMatchObject({ ok: false, broken: false });
    expect(B.info(a).vertices).toBeGreaterThan(0);
    expect(() => B.landxml(new TextEncoder().encode('<NotLandXML/>'))).toThrow(/not LandXML/);
    expect(() => B.landxml(new TextEncoder().encode('<LandXML><Surfaces><Surface><Definition surfType="grid"/></Surface></Surfaces></LandXML>'))).toThrow(/no TIN surface/);
    expect(() => B.pointsText(new TextEncoder().encode('onecolumn\n1\n2\n'))).toThrow(/columns/);
    B.dispose(a);
    B.dispose(b);
  });

  it('LandXML: the JS writer → the Rust reader keeps points, faces, lines and units', () => {
    const B = bundle();
    const en = new Float64Array([500000, 4400000, 1600.25, 500010, 4400000, 1601.5, 500000, 4400010, 1602, 500010, 4400010, 1603]);
    const x = writeLandXml({ name: 'EG', epsg: 26913, date: '2026-11-03', time: '12:00:00' }, en, new Uint32Array([0, 1, 3, 0, 3, 2]), [{ type: 'soft', pts: [[500000, 4400000, 1600.25], [500010, 4400010, 1603]] }, { type: 'outer', closed: true, pts: [[500000, 4400000, 0], [500010, 4400000, 0], [500005, 4400010, 0]] }]);
    const r = B.landxml(new TextEncoder().encode(x));
    expect(Array.from(r.points)).toEqual(Array.from(en));
    expect(Array.from(r.faces)).toEqual([0, 1, 3, 0, 3, 2]);
    expect(r.doc.epsg).toBe(26913);
    expect(r.lines.map((l) => [l.kind, l.closed, l.n])).toEqual([[KIND.soft, false, 2], [KIND.outer, true, 3]]);
    const ft = '<LandXML><Units><Imperial linearUnit="USSurveyFoot"/></Units><Surfaces><Surface name="s"><Definition surfType="TIN"><Pnts><P id="a">100 200 300</P><P id="b">100 210 300</P><P id="c">110 200 310</P></Pnts><Faces><F>a b c</F></Faces></Definition><SourceData><Breaklines><Breakline brkType="wall"><PntList3D>1 2 3 4 5 6</PntList3D></Breakline></Breaklines></SourceData></Surface></Surfaces></LandXML>';
    const f = B.landxml(new TextEncoder().encode(ft));
    expect(f.points[0]).toBeCloseTo((200 * 1200) / 3937, 9);
    expect(f.doc.refused).toEqual([{ what: 'breakline', name: '', type: 'wall' }]);
  });

  it('OD-2.41: a LandXML surface keeps its own faces, outline, holes and hidden faces', () => {
    const B = bundle();
    // A sheared 8 × 8 grid split on the long diagonal everywhere (none of it Delaunay), with a
    // notch out of one side (concave), a hole in the middle and one hidden face.
    const N = 8;
    const en = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) en.push(500000 + 10 * i + 3 * j, 4400000 + 10 * j, 100 + ((i * 7 + j * 3) % 5));
    const id = (i, j) => j * N + i;
    const faces = [];
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        if ((i === 3 && j === 3) || (i === N - 2 && j >= 2 && j <= 4)) continue;
        faces.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
      }
    const hidden = new Uint8Array(faces.length / 3);
    hidden[1] = 1; // on the outline
    const x = writeLandXml({ name: 'EG', epsg: 32613 }, new Float64Array(en), new Uint32Array(faces), [], hidden);
    const r = B.landxml(new TextEncoder().encode(x));
    const tin = B.fromPoints(r.points).id;
    const kept = B.keepFaces(tin, r.points, r.faces, r.hidden);
    expect(kept).toMatchObject({ faces: faces.length / 3, skipped: 0, rings: 2, visible: faces.length / 3 - 1 });
    // The app's FILE_KEY0 is the bundle's: the first forced edge has that key (#77).
    expect(Math.min(...B.lines(tin).filter((l) => l.kind === KIND.swap).map((l) => l.key))).toBe(FILE_KEY0);
    expect(kept.forced).toBeGreaterThan(30);
    const m = B.mesh(tin);
    const key = (xy) => xy.map(([a, b]) => `${Math.round(a * 1000)},${Math.round(b * 1000)}`).sort().join(' ');
    const meshFaces = (want) => {
      const out = [];
      for (let k = 0; k < m.tris.length / 3; k++) if (!!m.excluded[k] === want) out.push(key([0, 1, 2].map((c) => [m.xyz[3 * m.tris[3 * k + c]], m.xyz[3 * m.tris[3 * k + c] + 1]])));
      return out.sort();
    };
    const fileFaces = (pick) => {
      const out = [];
      for (let k = 0; k < faces.length / 3; k++) if (pick(k)) out.push(key([0, 1, 2].map((c) => [r.points[3 * faces[3 * k + c]], r.points[3 * faces[3 * k + c] + 1]])));
      return out.sort();
    };
    expect(meshFaces(false)).toEqual(fileFaces((k) => !hidden[k]));
    expect(meshFaces(true)).toEqual(expect.arrayContaining(fileFaces((k) => hidden[k])));
    // The file's heights: the centroid of every face is the mean of its corners.
    const cen = [];
    const want = [];
    for (let k = 0; k < faces.length / 3; k++) {
      if (hidden[k]) continue;
      const c = [0, 1, 2].map((q) => faces[3 * k + q]);
      cen.push(c.reduce((s, v) => s + r.points[3 * v], 0) / 3, c.reduce((s, v) => s + r.points[3 * v + 1], 0) / 3);
      want.push(c.reduce((s, v) => s + r.points[3 * v + 2], 0) / 3);
    }
    const got = B.heights(tin, new Float64Array(cen));
    expect(Math.max(...Array.from(got, (v, k) => Math.abs(v - want[k])))).toBeLessThan(1e-9);
    // It survives the state round trip; outline rings are lines of their own kind.
    const back = B.load(B.save(tin));
    expect(B.info(back).excluded).toBe(B.info(tin).excluded);
    expect(B.lines(back).filter((l) => l.kind === KIND.outline)).toHaveLength(2);
    B.dispose(tin);
    B.dispose(back);
  });
});

// ---- corpus: 1 M posts and LiDAR ground (measurements) ----
describe.skipIf(!haveWasm || !existsSync(DEM))('REQ-GAP-39 corpus: USGS 3DEP 1 m DEM, 1 M posts', () => {
  it('build every post, thin to tolerances, edit latency', { timeout: 1800000 }, async () => {
    const { fromFile } = await import('geotiff');
    const tif = await fromFile(DEM);
    const im = await tif.getImage();
    const [ox, oy] = im.getOrigin();
    const [rx, ry] = im.getResolution();
    const W = 1000;
    const H = 1000;
    const c0 = 4500;
    const r0 = 4500;
    const [z0] = await im.readRasters({ window: [c0, r0, c0 + W, r0 + H] });
    const nodata = im.getGDALNoData();
    const z = Float32Array.from(z0, (v) => (v === nodata || v < -1e30 ? NaN : v));
    // The plane is the DEM's own UTM metres (a projected grid: post (i, j) at x0 + i, y0 − j).
    const g = { w: W, h: H, ax: ox + (c0 + 0.5) * rx, ay: oy + (r0 + 0.5) * ry, bx: rx, by: ry };
    const B = bundle();
    const mem = () => B.x.memory.buffer.byteLength;
    const t0 = performance.now();
    const all = B.fromDem(g, z, { tolerance: -1 });
    const buildMs = performance.now() - t0;
    const info = B.info(all.id);
    expect(info.vertices).toBe(z.filter(Number.isFinite).length);
    const memAll = mem();
    const ts = performance.now();
    const state = B.save(all.id);
    const saveMs = performance.now() - ts;
    const tl = performance.now();
    const back = B.load(state);
    const loadMs = performance.now() - tl;
    B.dispose(back);
    // Edits on the 1 M-vertex TIN, each timed (median of runs).
    const xc = g.ax + 500;
    const yc = g.ay - 500;
    const timed = (ops) => {
      const t1 = performance.now();
      const r = B.apply(all.id, encodeTinEdits(ops));
      return { ms: performance.now() - t1, ok: r.every((x) => x.ok), r };
    };
    const lat = {};
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const runs = (name, mk, n = 15) => {
      const ms = [];
      for (let k = 0; k < n; k++) {
        const x = timed(mk(k));
        expect(x.ok, `${name} ${k}: ${JSON.stringify(x.r)}`).toBe(true);
        ms.push(x.ms);
      }
      lat[name] = { medianMs: med(ms), maxMs: Math.max(...ms) };
    };
    runs('addPoint', (k) => [{ kind: 'addpoint', params: { x: xc + 0.37 + k * 3.1, y: yc - 0.41 - k * 2.3, z: 1800 } }]);
    runs('movePoint', (k) => [{ kind: 'movepoint', params: { x: xc + 0.37 + k * 3.1, y: yc - 0.41 - k * 2.3, r: 0.01, nx: xc + 0.71 + k * 3.1, ny: yc - 0.13 - k * 2.3, nz: 1801 } }]);
    runs('deletePoint', (k) => [{ kind: 'delpoint', params: { x: xc + 0.71 + k * 3.1, y: yc - 0.13 - k * 2.3, r: 0.01 } }]);
    runs('hardBreakline100m', (k) => [{ kind: 'addline', params: { key: 100 + k, type: 'hard', closed: false, pts: [[xc - 50, yc + 30 - k * 20.3, 1810], [xc + 50, yc + 31 - k * 20.3, 1812]] } }]);
    runs('softBreakline100m', (k) => [{ kind: 'addline', params: { key: 200 + k, type: 'soft', closed: false, pts: [[xc - 300 + k * 13.7, yc - 50, NaN], [xc - 299 + k * 13.7, yc + 50, NaN]] } }]);
    runs('drain200m', (k) => [{ kind: 'profile', params: { key: 300 + k, mode: 'drain', pts: [[xc + 100 + k * 11.3, yc + 150], [xc + 105 + k * 11.3, yc - 50]] } }], 9);
    runs('ridge200m', (k) => [{ kind: 'profile', params: { key: 400 + k, mode: 'ridge', pts: [[xc - 400, yc + 200 - k * 15.1], [xc - 200, yc + 205 - k * 15.1]] } }], 9);
    runs('deleteLine', (k) => [{ kind: 'delline', params: { key: 100 + k } }]);
    // A cell centre is on the cell's diagonal, whichever way it runs: a strictly convex quadrilateral.
    runs('swapEdge', (k) => [{ kind: 'swap', params: { key: 600 + k, x: xc + 200.5 + k * 7, y: yc - 300.5 } }], 9);
    runs('retriangulate20m', (k) => [{ kind: 'retri', params: { ring: [[xc + 190 + k * 7, yc - 310], [xc + 210 + k * 7, yc - 310], [xc + 210 + k * 7, yc - 290], [xc + 190 + k * 7, yc - 290]] } }], 9);
    const big = timed([{ kind: 'addline', params: { key: 999, type: 'soft', closed: false, pts: [[g.ax + 5, g.ay - 5, NaN], [g.ax + 995, g.ay - 995, NaN]] } }]);
    lat.softBreakline1400m = { ms: big.ms, ok: big.ok };
    // Display query at a 400 m view, and the whole-TIN raster back to the posts.
    const tq = performance.now();
    const view = B.mesh(all.id, [xc - 200, yc - 200, xc + 200, yc + 200], 60000);
    lat.viewQuery400m = { ms: performance.now() - tq, triangles: view.tris.length / 3, total: view.total };
    const tr = performance.now();
    B.raster(all.id, g);
    lat.raster1M = { ms: performance.now() - tr };
    // A sampled exact check of the edited 1 M TIN.
    const m = B.mesh(all.id);
    const chk = exactCheck(m, consOf(m), { sample: 97 });
    expect(chk).toMatchObject({ ccw: true, hullOk: true, areaOk: true, consMissing: 0, violations: 0 });
    B.dispose(all.id);
    // Thinned: every post within the tolerance (checked here, post by post, from the raster).
    const thin = {};
    for (const tol of [0.1, 0.25, 0.5, 1]) {
      const B2 = bundle();
      const t1 = performance.now();
      const r = B2.fromDem(g, z, { tolerance: tol });
      const ms = performance.now() - t1;
      const back2 = B2.raster(r.id, g);
      let worst = 0;
      for (let k = 0; k < z.length; k++) if (Number.isFinite(z[k])) worst = Math.max(worst, Math.abs(back2[k] - z[k]));
      thin[tol] = { vertices: r.report.vertices, ms, worstPostError: worst, memoryMB: B2.x.memory.buffer.byteLength / 2 ** 20 };
      expect(worst).toBeLessThanOrEqual(tol + 2e-4);
    }
    const out = { dem: DEM, window: [c0, r0, W, H], posts: z.length, valid: info.vertices, buildAllMs: buildMs, triangles: info.triangles, wasmMemoryMB: memAll / 2 ** 20, stateMB: state.length / 2 ** 20, saveMs, loadMs, latency: lat, checkSampled: chk, thinned: thin };
    measure('dem_1m', out);
    console.log(JSON.stringify(out, null, 1));
  });
});

describe.skipIf(!haveWasm || !haveTe || !existsSync(LAZ))('REQ-GAP-39 corpus: LiDAR ground points (3DEP CO DRCOG 2020)', () => {
  it('about 1 M ground points: build time, memory, and the same triangles as scipy (sampled exact check)', { timeout: 1800000 }, () => {
    mkdirSync(DERIVED, { recursive: true });
    const bin = join(DERIVED, 'w0474n4416-ground.f64');
    if (!existsSync(bin) || !existsSync(`${bin}.json`)) oracle({ mode: 'ground', las: LAZ, out: bin });
    const meta = JSON.parse(readFileSync(`${bin}.json`, 'utf8'));
    const all = new Float64Array(new Uint8Array(readFileSync(bin)).buffer);
    // About 1 M of them: every k-th.
    const every = Math.max(1, Math.floor(all.length / 3 / 1e6));
    const n = Math.floor(all.length / 3 / every);
    const pts = new Float64Array(3 * n);
    for (let k = 0; k < n; k++) pts.set(all.subarray(3 * k * every, 3 * k * every + 3), 3 * k);
    const B = bundle();
    const t0 = performance.now();
    const { id, report } = B.fromPoints(pts);
    const ms = performance.now() - t0;
    const m = B.mesh(id);
    const chk = exactCheck(m, [], { sample: 53 });
    expect(chk).toMatchObject({ ccw: true, hullOk: true, areaOk: true, violations: 0 });
    // scipy on the same snapped points: how many of its triangles the bundle has (cocircular
    // points on the 1 cm LAS grid make the Delaunay triangulation not unique).
    const c = scipyCompare(pts, m, 'ground');
    const res = { file: LAZ, groundPoints: meta.ground, used: n, every, vertices: report.vertices, duplicates: report.duplicates, buildMs: ms, wasmMemoryMB: B.x.memory.buffer.byteLength / 2 ** 20, triangles: m.tris.length / 3, scipyTriangles: c.scipy, identical: c.same, unmatched: c.unmatched, checkSampled: chk };
    measure('lidar_ground_1m', res);
    console.log(JSON.stringify(res, null, 1));
    expect(c.same / c.scipy).toBeGreaterThan(0.99);
    B.dispose(id);
  });
});
