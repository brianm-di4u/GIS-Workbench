// REQ-FMT-38, REQ-FMT-39, REQ-SEC-02: quantized-mesh reading (EPSG:4326 and 3857 tiling,
// `available`, extensions, local tile lists) checked against an independent decoder
// (@here/quantized-mesh-decoder) on corpus and FX-21 tiles; the Rust writer's tiles (FX-21) decode
// with both; mutated tiles fail by name.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import hereDecode from '@here/quantized-mesh-decoder';
import { decodeQuantizedMesh, tileBounds, tilesFor, isAvailable, deepestAvailable, localTiles, isMercator, QmError, tileUrl } from '../../app/src/render/qmesh.js';
import { tileRange, levelFor } from '../../app/src/formats/qmesh-write.js';

const FX = resolve('fixtures/fx21/d3');
const TE = resolve('..', 'TE-corpus');
const decodeHere = (b) => (hereDecode.default ?? hereDecode)(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function terrains(dir, max = 400) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d) || out.length >= max) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.terrain$/i.test(n) && out.length < max) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const zxy = (p) => p.split(/[\\/]/).slice(-3).map((s) => parseInt(s, 10));

describe('tiling schemes', () => {
  it('geographic and Web Mercator TMS bounds and coverage', () => {
    expect(tileBounds(0, 1, 0)).toEqual({ west: 0, east: 180, south: -90, north: 90 });
    const m = tileBounds(0, 0, 0, true);
    expect(m.west).toBe(-180);
    expect(m.north).toBeCloseTo(85.0511, 3);
    expect(tilesFor(0, [-10, -10, 10, 10], true)).toEqual([[0, 0, 0]]);
    expect(tilesFor(1, [10, 10, 20, 20], true)).toEqual([[1, 1, 1]]);
    expect(tilesFor(1, [10, 10, 20, 20])).toEqual([[1, 2, 1]]);
    expect(isMercator({ projection: 'EPSG:3857' })).toBe(true);
    expect(isMercator({})).toBe(false);
  });
  it('available ranges and local tile lists', () => {
    const av = [[{ startX: 0, startY: 0, endX: 1, endY: 0 }], [{ startX: 0, startY: 0, endX: 3, endY: 1 }]];
    expect(isAvailable(av, 1, 3, 1)).toBe(true);
    expect(isAvailable(av, 1, 4, 1)).toBe(false);
    expect(isAvailable(av, 5, 9, 9)).toBe(true);
    expect(deepestAvailable(av)).toBe(1);
    // CesiumJS test layout: coordinates in the query of one file.
    expect(localTiles({ tiles: ['tile.terrain?v={version}&x={x}&y={y}&z={z}'], available: av }, ['tile.terrain'])).toHaveLength(8);
    expect(localTiles({ tiles: ['{z}/{x}/{y}.terrain?v={version}'] }, ['0/0/0.terrain', '0/1/0.terrain', '1/2/1.terrain'])).toEqual([[1, 2, 1]]);
    expect(tileUrl('{z}/{x}/{y}.terrain?v={version}', 3, 4, 5, '1.2.0')).toBe('3/4/5.terrain?v=1.2.0');
  });
  it('writer tile ranges match the reader’s tiling', () => {
    const b = { west: -105.05, south: 39.7, east: -104.95, north: 39.78 };
    for (const merc of [false, true])
      for (let z = 0; z < 12; z++) {
        const r = tileRange(z, b, merc);
        const t = tilesFor(z, [b.south, b.west, b.north, b.east], merc);
        expect(t.length, `z${z}`).toBe((r.endX - r.startX + 1) * (r.endY - r.startY + 1));
      }
    expect(levelFor(1 / 3600, 65)).toBeGreaterThan(10);
  });
});

describe('decoder agrees with @here/quantized-mesh-decoder', () => {
  const sets = [
    ['3d-qmesh-cesiumjs-specs-4326', false, false],
    ['derived-qmesh-geodetic', false, true],
    ['3d-qmesh-swisstopo-4326', false, true],
    ['terrain-qmesh-heremaps-examples', true, true],
  ].filter(([d]) => existsSync(join(TE, d)));
  const fx = ['qmesh-4326', 'qmesh-3857'].filter((d) => existsSync(join(FX, d)));
  it.skipIf(!sets.length && !fx.length)('vertex counts, triangles, heights and extensions', () => {
    let n = 0;
    const check = (p, merc, coords) => {
      const b = new Uint8Array(readFileSync(p));
      const [z, x, y] = coords ? zxy(p) : [0, 0, 0];
      const mine = decodeQuantizedMesh(b, tileBounds(z, x, y, merc), { mercator: merc });
      const here = decodeHere(b);
      expect(mine.vertices.length, p).toBe(here.vertexData.length / 3);
      expect(mine.indices.length, p).toBe(here.triangleIndices.length);
      expect([...mine.indices.slice(0, 30)], p).toEqual([...here.triangleIndices.slice(0, 30)]);
      expect(mine.min).toBeCloseTo(here.header.minHeight, 3);
      if (here.extensions?.vertexNormals) expect(mine.normals).toBeTruthy();
      if (here.extensions?.waterMask) expect(mine.watermask).not.toBe(null);
      for (let i = 0; i < mine.vertices.length; i += 17) {
        const h = here.header.minHeight + (here.vertexData[2 * mine.vertices.length + i] / 32767) * (here.header.maxHeight - here.header.minHeight);
        expect(Math.abs(mine.vertices[i].h - h)).toBeLessThan(1e-3);
      }
      n++;
    };
    for (const [d, merc, coords] of sets) for (const p of terrains(join(TE, d), 60)) check(p, merc, coords);
    for (const d of fx) for (const p of terrains(join(FX, d))) check(p, d.endsWith('3857'), true);
    expect(n).toBeGreaterThan(10);
  }, 60000); // the corpus tiles are read from the archive disk
});

describe.skipIf(!existsSync(join(FX, 'truth.json')))('FX-21: the Rust writer’s tile sets', () => {
  const truth = JSON.parse(readFileSync(join(FX, 'truth.json'), 'utf8')).qmesh;
  it.skipIf(!!truth.skipped)('layer.json, every level present, heights within the DEM range, centres on the tile', () => {
    for (const d of ['qmesh-4326', 'qmesh-3857']) {
      const layer = JSON.parse(readFileSync(join(FX, d, 'layer.json'), 'utf8'));
      const merc = isMercator(layer);
      expect(layer.projection).toBe(truth[d].projection);
      const tiles = terrains(join(FX, d), 10000);
      expect(tiles.length).toBe(truth[d].tiles);
      for (const p of tiles) {
        const [z, x, y] = zxy(p);
        expect(isAvailable(layer.available, z, x, y), p).toBe(true);
        const t = decodeQuantizedMesh(new Uint8Array(readFileSync(p)), tileBounds(z, x, y, merc), { mercator: merc });
        expect(t.extensions).toContain('octvertexnormals');
        expect(t.min).toBeGreaterThanOrEqual(truth[d].heightRange[0] - 1);
        expect(t.max).toBeLessThanOrEqual(truth[d].heightRange[1] + 1);
        expect(t.edges.west + t.edges.south + t.edges.east + t.edges.north).toBeGreaterThan(3);
      }
    }
  });
});

describe('REQ-SEC-02 fuzz: mutated tiles fail by name', () => {
  const seeds = [...terrains(join(TE, '3d-qmesh-cesiumjs-specs-4326'), 10), ...terrains(join(TE, 'derived-qmesh-geodetic'), 10), ...terrains(join(FX, 'qmesh-3857'), 5)];
  it.skipIf(!seeds.length)(`${seeds.length} seeds × 400 mutations`, () => {
    let s = 99;
    const rng = () => (s = (s * 1103515245 + 12345) >>> 0) >>> 8;
    for (const f of seeds) {
      const seed = new Uint8Array(readFileSync(f));
      for (let i = 0; i < 400; i++) {
        let b = seed.slice();
        const k = 1 + (rng() % 5);
        for (let j = 0; j < k; j++) {
          const at = rng() % b.length;
          const r = rng() % 4;
          if (r === 0) b[at] ^= 1 << rng() % 8;
          else if (r === 1 && at + 4 <= b.length) new DataView(b.buffer).setUint32(at, [0, 0xffffffff, 1 << 20, 65537][rng() % 4], true);
          else if (r === 2) b = b.subarray(0, at);
          else b[at] = 0xff;
          if (b.length < 1) break;
        }
        try {
          decodeQuantizedMesh(b, tileBounds(0, 0, 0));
        } catch (e) {
          if (!(e instanceof QmError)) throw new Error(`${f}: ${e.constructor.name}: ${e.message}`);
        }
      }
    }
  });
});
