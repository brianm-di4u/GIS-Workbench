// REQ-FMT-36, REQ-FMT-37, REQ-SEC-02: the 3D Tiles content parsers (pnts, i3dm, b3dm, cmpt,
// subtrees) read every FX-21 encoding and the corpus samples, round-trip the writers, and fail
// with a named TileError (never a RangeError, never a hang) on mutated corpus files.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePnts, parseI3dm, parseB3dm, parseCmpt, parseSubtree, parseTileHeader, tileMagic, TileError, morton, subtreeIndex, implicitVolume, fillTemplate, octDecode } from '../../app/src/render/tiles3d-content.js';
import { writePnts, writeI3dm, writeB3dm, writeCmpt, writePointCloudTileset, octEncode } from '../../app/src/formats/tiles3d-write.js';

const FX = resolve('fixtures/fx21/d3');
const TE = resolve('..', 'TE-corpus');
const truth = existsSync(join(FX, 'truth.json')) ? JSON.parse(readFileSync(join(FX, 'truth.json'), 'utf8')) : null;
const rd = (...p) => new Uint8Array(readFileSync(join(...p)));
const bounds = (p, rtc = [0, 0, 0]) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], p[i + k] + rtc[k])), (hi[k] = Math.max(hi[k], p[i + k] + rtc[k]));
  return { lo, hi };
};

/** Every corpus file of these extensions (≤ 4 MB). */
function corpus(re) {
  const out = [];
  if (!existsSync(TE)) return out;
  for (const id of ['3d-tiles-samples-i3dm-pnts', '3d-tiles-cesiumjs-specs-i3dm-pnts-cmpt', '3d-tiles-tools-specs-i3dm-pnts-cmpt', '3d-tiles-py3dtiles-pnts', '3d-tiles-implicit-octree-metadata', '3d-tiles-sparse-implicit-quadtree', '3d-tiles-discrete-lod']) {
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (re.test(n) && statSync(p).size < 4 << 20) out.push(p);
      }
    };
    walk(join(TE, id));
  }
  return out;
}

describe.skipIf(!truth)('FX-21 d3 content', () => {
  it('pnts: every encoding gives the point count and bounds', () => {
    for (const [f, t] of Object.entries(truth.pnts)) {
      const p = parsePnts(rd(FX, 'pnts', f));
      expect(p.count, f).toBe(t.points);
      if (p.positions) {
        const b = bounds(p.positions, p.rtc ?? [0, 0, 0]);
        for (let k = 0; k < 3; k++) {
          expect(Math.abs(b.lo[k] - t.min[k]), `${f} min`).toBeLessThan(t.tol ?? 0.005);
          expect(Math.abs(b.hi[k] - t.max[k]), `${f} max`).toBeLessThan(t.tol ?? 0.005);
        }
      } else expect(p.draco, f).toBeTruthy();
      if (t.properties) expect(Object.keys(p.batch)).toEqual(t.properties);
      if (t.stats) for (const [k, s] of Object.entries(t.stats)) {
        const v = p.batch[k].values;
        expect(Math.min(...v)).toBe(s.min);
        expect(Math.max(...v)).toBe(s.max);
      }
    }
    const q = parsePnts(rd(FX, 'pnts', 'quantized-octnormals-rgba.pnts'));
    expect(q.colorSize).toBe(4);
    expect(q.normals.length).toBe(6000);
    for (let i = 0; i < 6000; i += 3) expect(Math.hypot(q.normals[i], q.normals[i + 1], q.normals[i + 2])).toBeCloseTo(1, 5);
    const c = parsePnts(rd(FX, 'pnts', 'constant-rgba.pnts'));
    expect(c.constantRgba).toEqual([255, 0, 0, 255]);
  });
  it('i3dm: embedded and external glTF, orientation, scale, batch table', () => {
    for (const [f, t] of Object.entries(truth.i3dm)) {
      const p = parseI3dm(rd(FX, 'i3dm', f));
      expect(p.count, f).toBe(t.instances);
      const b = bounds(p.positions, p.rtc ?? [0, 0, 0]);
      for (let k = 0; k < 3; k++) expect(Math.abs(b.lo[k] - t.min[k]), f).toBeLessThan(t.tol ?? 0.005);
    }
    const e = parseI3dm(rd(FX, 'i3dm', 'external-enu-batch.i3dm'));
    expect(e.gltf.uri).toBe('box.glb');
    expect(e.eastNorthUp).toBe(true);
    expect(e.batch.Name).toEqual(['a', 'b', 'c', 'd', 'e']);
    const q = parseI3dm(rd(FX, 'i3dm', 'quantized-oct-scale.i3dm'));
    expect(q.up.length).toBe(15);
    expect([...q.scaleNonUniform.slice(3, 6)]).toEqual([2, 2, 2]);
  });
  it('cmpt: inner tiles, nested', () => {
    const inner = parseCmpt(rd(FX, 'cmpt', 'composite.cmpt'));
    expect(inner.map(tileMagic)).toEqual(['pnts', 'i3dm', 'b3dm']);
    const nested = parseCmpt(rd(FX, 'cmpt', 'composite-of-composite.cmpt'));
    expect(nested.map(tileMagic)).toEqual(['cmpt', 'cmpt']);
    expect(parseCmpt(nested[0]).map(tileMagic)).toEqual(['pnts', 'b3dm']);
  });
  it('implicit: the octree subtrees list the tiles the writer made; the JSON quadtree subtree reads its external buffer', async () => {
    const ts = JSON.parse(readFileSync(join(FX, 'implicit-octree', 'tileset.json'), 'utf8'));
    const it = ts.root.implicitTiling;
    const sub = await parseSubtree(rd(FX, 'implicit-octree', 'subtrees', '0.0.0.0.subtree'), { levels: it.subtreeLevels, branching: 8, loadBuffer: async () => null });
    expect(sub.tile(0)).toBe(true);
    expect(sub.content(0)).toBe(true);
    // Count every content tile reachable through all subtrees = the files written.
    let n = 0;
    const visit = async (L, X, Y, Z) => {
      const s = await parseSubtree(rd(FX, 'implicit-octree', 'subtrees', `${L}.${X}.${Y}.${Z}.subtree`), { levels: it.subtreeLevels, branching: 8, loadBuffer: async () => null });
      for (let l = 0; l < it.subtreeLevels; l++) {
        const d = 2 ** l;
        for (let x = 0; x < d; x++) for (let y = 0; y < d; y++) for (let z = 0; z < d; z++) if (s.content(subtreeIndex(l, x, y, z, 8))) n++;
      }
      const d = 2 ** it.subtreeLevels;
      for (let x = 0; x < d; x++) for (let y = 0; y < d; y++) for (let z = 0; z < d; z++) if (s.child(morton(x, y, z))) await visit(L + it.subtreeLevels, X * d + x, Y * d + y, Z * d + z);
    };
    await visit(0, 0, 0, 0);
    expect(n).toBe(truth.implicit.octree.tiles);
    const q = await parseSubtree(rd(FX, 'implicit-quadtree', 'subtrees', '0.0.0.json'), { levels: 2, branching: 4, loadBuffer: async (u) => rd(FX, 'implicit-quadtree', 'subtrees', u) });
    expect([0, 1, 2, 3, 4].map((i) => q.tile(i))).toEqual([true, true, true, false, true]);
  });
});

describe('implicit tiling helpers', () => {
  it('Morton order, bitstream index, URI templates, child volumes', () => {
    expect(morton(1, 0)).toBe(1);
    expect(morton(0, 1)).toBe(2);
    expect(morton(1, 1, 1)).toBe(7);
    expect(subtreeIndex(1, 1, 1, 0, 4)).toBe(4);
    expect(subtreeIndex(2, 0, 0, 0, 8)).toBe(9);
    expect(fillTemplate('c/{level}/{x}/{y}/{z}.glb', { level: 3, x: 1, y: 2, z: 0 })).toBe('c/3/1/2/0.glb');
    const v = implicitVolume({ box: [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 2] }, 1, 1, 0, 1, true);
    expect(v.box.slice(0, 3)).toEqual([1, -1, 1]);
    const r = implicitVolume({ region: [0, 0, 1, 1, 0, 10] }, 1, 1, 1, 0, false);
    expect(r.region).toEqual([0.5, 0.5, 1, 1, 0, 10]);
  });
  it('oct encoding round trips', () => {
    for (const n of [[0, 0, 1], [0.6, 0, -0.8], [-0.3, 0.4, Math.sqrt(0.75)]]) {
      const [u, v] = octEncode(...n, 65535);
      const d = octDecode(u, v, 65535);
      for (let k = 0; k < 3; k++) expect(d[k]).toBeCloseTo(n[k], 3);
    }
  });
});

describe('writers round-trip through the parsers', () => {
  it('pnts, i3dm, b3dm, cmpt and an octree', () => {
    const pos = new Float64Array([0, 0, 0, 1, 2, 3, -4, 5, 6]);
    const p = parsePnts(writePnts({ positions: pos, colors: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), batch: { k: new Float32Array([1, 2, 3]) } }, { quantize: true }));
    expect(p.count).toBe(3);
    expect(Math.abs(p.positions[3 * 2] - -4)).toBeLessThan(1e-3);
    expect([...p.batch.k.values]).toEqual([1, 2, 3]);
    const i = parseI3dm(writeI3dm({ uri: 'm.glb', positions: pos, scale: [1, 2, 3] }));
    expect(i.gltf.uri).toBe('m.glb');
    const glb = new Uint8Array(20);
    glb.set([0x67, 0x6c, 0x54, 0x46]);
    const b = parseB3dm(writeB3dm(glb, { rtc: [1, 2, 3], batchLength: 0 }));
    expect(b.rtc).toEqual([1, 2, 3]);
    expect(b.glb.length).toBeGreaterThanOrEqual(20);
    expect(parseCmpt(writeCmpt([writePnts({ positions: pos }), writeB3dm(glb)])).map(tileMagic)).toEqual(['pnts', 'b3dm']);
    const pts = new Float64Array(3 * 5000).map((_, k) => ((k * 7919) % 1000) / 10);
    const o = writePointCloudTileset({ positions: pts }, { lat: 0, lon: 0, h: 0 }, { maxPoints: 1000, subtreeLevels: 2 });
    let total = 0;
    for (const [k, v] of Object.entries(o.files)) if (k.endsWith('.pnts')) total += parsePnts(v).count;
    expect(total).toBe(5000);
  });
});

/** Mutations of a seed: bit flips, interesting values in length fields, truncation, splices. */
function* mutations(seed, n, rng) {
  for (let i = 0; i < n; i++) {
    const b = seed.slice();
    const k = 1 + (rng() % 6);
    for (let j = 0; j < k; j++) {
      const r = rng() % 5;
      const at = rng() % Math.max(1, b.length);
      if (r === 0) b[at] ^= 1 << rng() % 8;
      else if (r === 1) b[at] = [0, 0xff, 0x7f, 0x80][rng() % 4];
      else if (r === 2 && b.length > 32) new DataView(b.buffer).setUint32(4 * (1 + (rng() % 7)), [0, 0xffffffff, 0x7fffffff, b.length * 2, 1 << 30][rng() % 5], true);
      else if (r === 3) yield b.subarray(0, at);
      else b.fill(rng() % 256, at, Math.min(b.length, at + 1 + (rng() % 64)));
    }
    yield b;
  }
}

describe('REQ-SEC-02 fuzz: mutated content fails by name', () => {
  const seeds = [...corpus(/\.(pnts|i3dm|b3dm|cmpt|subtree)$/i), ...(existsSync(FX) ? ['pnts', 'i3dm', 'cmpt'].flatMap((d) => readdirSync(join(FX, d)).filter((n) => !n.endsWith('.glb')).map((n) => join(FX, d, n))) : [])];
  it.skipIf(!seeds.length)(`${seeds.length} seeds × 300 mutations`, async () => {
    let s = 12345;
    const rng = () => (s = (s * 1103515245 + 12345) >>> 0) >>> 8;
    let named = 0;
    let ok = 0;
    const t0 = Date.now();
    for (const f of seeds) {
      const seed = rd(f);
      for (const m of mutations(seed, 300, rng)) {
        try {
          const magic = tileMagic(m);
          if (magic === 'pnts') parsePnts(m);
          else if (magic === 'i3dm') parseI3dm(m);
          else if (magic === 'b3dm') parseB3dm(m);
          else if (magic === 'cmpt') parseCmpt(m).forEach((x) => parseTileHeader(x));
          else if (magic === 'subt') await parseSubtree(m, { levels: 3, branching: 8, loadBuffer: async () => new Uint8Array(0) });
          ok++;
        } catch (e) {
          if (!(e instanceof TileError)) throw new Error(`${f}: ${e.constructor.name}: ${e.message}`);
          named++;
        }
      }
    }
    expect(named + ok).toBeGreaterThan(seeds.length * 300);
    expect(Date.now() - t0).toBeLessThan(120000);
  }, 180000);
});
