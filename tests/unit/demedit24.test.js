// REQ-DEM-08, REQ-GAP-37, REQ-GAP-38: the DEM edit kernels of the `terrain` WASM bundle
// (crates/gw-terrain edit.rs) against the JS oracle (app/src/analysis/dem-edit.js applyEdit),
// edit by edit and over random edit logs, on a synthetic grid and on the FX-05 DEM (1682 × 1466
// posts); block statistics against blockRows; malformed edit lists refused, not trapped.
// Skipped when the bundle is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fromArrayBuffer } from 'geotiff';
import { TerrainBundle } from '../../app/src/wasm/terrain.js';
import { applyEdit, encodeEdits, blockRows, smrf } from '../../app/src/analysis/dem-edit.js';

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_terrain.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

function synthetic(w = 220, h = 190) {
  const g = { width: w, height: h, lat0: 34.52, lon0: -116.53, dlat: 1 / 36000, dlon: 1 / 36000 };
  const z = new Float32Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) z[j * w + i] = 600 + 0.3 * i - 0.2 * j + 15 * Math.sin(i / 17) * Math.cos(j / 23) + (i > 60 && i < 70 && j > 80 && j < 92 ? 9 : 0) + (i === 150 && j === 40 ? 40 : 0);
  // Two voids.
  for (let j = 100; j < 104; j++) for (let i = 30; i < 35; i++) z[j * w + i] = NaN;
  return { g, z };
}

/** A random edit of each kind inside the grid. */
function randomEdit(g, r, kind) {
  const lon = (i) => g.lon0 + i * g.dlon;
  const lat = (j) => g.lat0 - j * g.dlat;
  const ci = 10 + r() * (g.width - 20);
  const cj = 10 + r() * (g.height - 20);
  const rad = 4 + r() * Math.min(40, g.width / 5);
  const nv = 3 + Math.floor(r() * 5);
  const ring = Array.from({ length: nv }, (_, k) => {
    const t = (2 * Math.PI * k) / nv + r() * 0.3;
    const rr = rad * (0.6 + 0.4 * r());
    return [lon(ci + rr * Math.cos(t)), lat(cj + rr * Math.sin(t))];
  });
  const hole = ring.map(([x, y]) => [lon(ci) + 0.3 * (x - lon(ci)), lat(cj) + 0.3 * (y - lat(cj))]);
  switch (kind) {
    case 'post':
      return { kind, params: { lat: lat(cj), lon: lon(ci), h: 500 + 300 * r() } };
    case 'raise':
      return { kind, params: { ring, dh: -5 + 10 * r(), feather: r() < 0.3 ? 0 : 30 * r() } };
    case 'flatten':
      return { kind, params: { ring, h: r() < 0.5 ? NaN : 600 + 20 * r() } };
    case 'plane':
    case 'interpolate':
      return { kind, params: { ring } };
    case 'lake':
      return { kind, params: { ring, holes: r() < 0.5 ? [hole] : [], level: r() < 0.5 ? NaN : 590 + 20 * r() } };
    case 'smooth':
      return { kind, params: { ring, radius: 1 + Math.floor(3 * r()) } };
    case 'despike':
      return { kind, params: r() < 0.3 ? { threshold: 3 + 5 * r() } : { ring, threshold: 3 + 5 * r() } };
    case 'breakline':
      return { kind, params: { line: ring.slice(0, 3).map(([x, y]) => [x, y, 580 + 40 * r()]), width: 1 + 6 * r() } };
    case 'bareearth':
      return { kind, params: { ring, maxWindowM: 10 + 30 * r(), slope: 0.15, height: 0.5 } };
    case 'recorrelate': {
      // A coarser patch over the ring box with a tilted surface and holes (unmatched posts).
      const nx = 12 + Math.floor(r() * 20);
      const ny = 12 + Math.floor(r() * 20);
      const dlat = (2.2 * rad * g.dlat) / ny;
      const dlon = (2.2 * rad * g.dlon) / nx;
      const heights = Array.from({ length: nx * ny }, (_, k) => (r() < 0.1 ? null : Math.round((610 + 0.1 * (k % nx) - 0.05 * Math.floor(k / nx) + r()) * 1000) / 1000));
      return { kind, params: { ring, patch: { lat0: lat(cj - 1.1 * rad), lon0: lon(ci - 1.1 * rad), dlat, dlon, nx, ny, heights } } };
    }
  }
  throw new Error(kind);
}

const KINDS = ['post', 'raise', 'flatten', 'plane', 'lake', 'smooth', 'interpolate', 'despike', 'breakline', 'bareearth', 'recorrelate'];

function diff(a, b) {
  let max = 0;
  let same = 0;
  let nanMismatch = 0;
  for (let k = 0; k < a.length; k++) {
    if (Number.isNaN(a[k]) || Number.isNaN(b[k])) {
      if (Number.isNaN(a[k]) !== Number.isNaN(b[k])) nanMismatch++;
      else same++;
      continue;
    }
    const e = Math.abs(a[k] - b[k]);
    if (e === 0) same++;
    if (e > max) max = e;
  }
  return { max, identical: same / a.length, nanMismatch };
}

describe.skipIf(!haveWasm)('REQ-DEM-08 REQ-GAP-37 REQ-GAP-38 DEM edit kernels: Rust vs the JS oracle', () => {
  const B = haveWasm ? new TerrainBundle(new WebAssembly.Module(readFileSync(wasmPath))) : null;
  const geo = (g) => [g.width, g.height, g.lat0, g.lon0, g.dlat, g.dlon];
  const js = (g, z, ops) => {
    const H = z.slice();
    for (const op of ops) applyEdit(g, H, op);
    return H;
  };
  const results = {};

  for (const kind of KINDS)
    it(`${kind}: every edit of 12 random ones matches`, () => {
      const { g, z } = synthetic();
      const r = lcg(KINDS.indexOf(kind) + 1);
      let worst = { max: 0, identical: 1, nanMismatch: 0 };
      for (let n = 0; n < 12; n++) {
        const op = randomEdit(g, r, kind);
        const a = B.demReplay(geo(g), encodeEdits([op]), z);
        const b = js(g, z, [op]);
        const d = diff(a, b);
        if (d.max > worst.max) worst.max = d.max;
        worst.identical = Math.min(worst.identical, d.identical);
        worst.nanMismatch += d.nanMismatch;
      }
      results[kind] = worst;
      expect(worst.nanMismatch).toBe(0);
      expect(worst.max).toBeLessThanOrEqual(1e-3);
      expect(worst.identical).toBeGreaterThan(0.999);
    });

  it('random edit logs of 25 mixed edits replay the same', () => {
    const { g, z } = synthetic();
    const r = lcg(99);
    for (let n = 0; n < 6; n++) {
      const ops = Array.from({ length: 25 }, () => randomEdit(g, r, KINDS[Math.floor(r() * KINDS.length)]));
      const d = diff(B.demReplay(geo(g), encodeEdits(ops), z), js(g, z, ops));
      results[`log${n}`] = d;
      expect(d.nanMismatch).toBe(0);
      expect(d.max).toBeLessThanOrEqual(1e-3);
    }
  });

  it('FX-05 DEM (1682 × 1466 posts): mixed edits and block status', async () => {
    const f = resolve('fixtures/fx05/fx05_dem_hae.tif');
    const buf = readFileSync(f);
    const tif = await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const im = await tif.getImage();
    const [r0] = await im.readRasters();
    const [ox, sx, , oy, , sy] = [im.getOrigin()[0], im.getResolution()[0], 0, im.getOrigin()[1], 0, im.getResolution()[1]];
    const g = { width: im.getWidth(), height: im.getHeight(), lat0: oy + sy / 2, lon0: ox + sx / 2, dlat: -sy, dlon: sx };
    const z = Float32Array.from(r0);
    const r = lcg(5);
    const ops = KINDS.map((k) => randomEdit(g, r, k));
    const t0 = performance.now();
    const a = B.demReplay(geo(g), encodeEdits(ops), z);
    const tr = performance.now() - t0;
    const t1 = performance.now();
    const b = js(g, z, ops);
    const tj = performance.now() - t1;
    const d = diff(a, b);
    results.fx05 = { ...d, rustMs: Math.round(tr), jsMs: Math.round(tj) };
    expect(d.nanMismatch).toBe(0);
    expect(d.max).toBeLessThanOrEqual(1e-3);
    const rb = B.demBlocks(geo(g), z, a, 256);
    const jb = blockRows(g, z, b, 256);
    expect(rb.length).toBe(jb.length);
    for (let k = 0; k < rb.length; k++) {
      expect([rb[k].tx, rb[k].ty, rb[k].posts, rb[k].voids]).toEqual([jb[k].tx, jb[k].ty, jb[k].posts, jb[k].voids]);
      expect(Math.abs(rb[k].edited - jb[k].edited)).toBeLessThanOrEqual(2);
    }
    expect(rb.some((x) => x.edited > 0)).toBe(true);
    console.log('demedit24', JSON.stringify(results));
  });

  it('bare earth in a polygon removes a building and leaves the rest of the DEM alone', () => {
    const { g, z } = synthetic();
    // The 9 m block at i 61..69, j 81..91 (about 25 × 31 m at 0.1″ posts).
    const lon = (i) => g.lon0 + i * g.dlon;
    const lat = (j) => g.lat0 - j * g.dlat;
    const ring = [[lon(55), lat(75)], [lon(76), lat(75)], [lon(76), lat(98)], [lon(55), lat(98)]];
    const op = { kind: 'bareearth', params: { ring, maxWindowM: 40 } };
    const a = B.demReplay(geo(g), encodeEdits([op]), z);
    let worst = 0;
    for (let j = 82; j < 91; j++)
      for (let i = 62; i < 69; i++) {
        const k = j * g.width + i;
        worst = Math.max(worst, Math.abs(a[k] - (z[k] - 9)));
      }
    expect(worst).toBeLessThan(2.5);
    let outside = 0;
    for (let k = 0; k < z.length; k++) {
      const i = k % g.width;
      const j = Math.floor(k / g.width);
      if ((i < 54 || i > 77 || j < 74 || j > 99) && a[k] !== z[k] && !(Number.isNaN(a[k]) && Number.isNaN(z[k]))) outside++;
    }
    expect(outside).toBe(0);
    // The whole-grid SMRF agrees about that block too.
    const { dtm } = smrf(g, z, { maxWindowM: 40 });
    expect(Math.abs(dtm[86 * g.width + 65] - (z[86 * g.width + 65] - 9))).toBeLessThan(2.5);
  });

  it('NaN and huge parameters (a malformed project) replay the same in both and finish quickly', () => {
    const { g, z } = synthetic(60, 50);
    const lon = (i) => g.lon0 + i * g.dlon;
    const lat = (j) => g.lat0 - j * g.dlat;
    const ring = [[lon(5), lat(5)], [lon(30), lat(6)], [lon(28), lat(30)], [lon(6), lat(28)]];
    const ops = [
      { kind: 'post', params: { lat: NaN, lon: lon(3), h: 900 } },
      { kind: 'post', params: { lat: lat(3), lon: NaN, h: 900 } },
      { kind: 'smooth', params: { ring, radius: 1e12 } },
      { kind: 'breakline', params: { line: [[lon(2), lat(2), 600], [lon(2) + 1e9, lat(2), 600]], width: 1e9 } },
      { kind: 'breakline', params: { line: [[NaN, lat(2), 600], [lon(40), lat(40), 600]], width: 2 } },
      { kind: 'raise', params: { ring: [[NaN, NaN], ...ring], dh: 2, feather: 1e12 } },
      { kind: 'bareearth', params: { ring, maxWindowM: 1e12 } },
      { kind: 'flatten', params: { ring: [[lon(1), lat(1)], [lon(1), lat(1)], [lon(1), lat(1)]] } },
    ];
    const t0 = performance.now();
    const a = B.demReplay(geo(g), encodeEdits(ops), z);
    const ms = performance.now() - t0;
    const d = diff(a, js(g, z, ops));
    expect(d.nanMismatch).toBe(0);
    expect(d.max).toBeLessThanOrEqual(1e-3);
    expect(ms).toBeLessThan(10000);
  });

  it('refuses malformed edit lists and grids with an error, not a trap', () => {
    const { g, z } = synthetic(40, 30);
    for (const bad of [[1, 99], [3, 1, 0], [1, 2, 5, 3, -1], [1, 11, 0, 0, 1, 1, 5e9, 2, 0], [1, 2, 1, 1, 1e12]]) expect(() => B.demReplay(geo(g), Float64Array.from(bad), z)).toThrow(/dem edit/);
    expect(() => B.demReplay([41, 30, g.lat0, g.lon0, g.dlat, g.dlon], Float64Array.from([0]), z)).toThrow(/grid/);
    // And the bundle still works afterwards.
    expect(B.demReplay(geo(g), Float64Array.from([0]), z).length).toBe(z.length);
  });
});
