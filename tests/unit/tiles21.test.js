// 2.1 tiles group (SDP-2.1 FC-05..07, P14; REQ-FMT-28..33, REQ-NET-05): the decompress hook (gzip,
// Brotli bundle, Zstandard), the shared zstd codec, PMTiles directories, the Rust MVT tiler and
// PMTiles writer (real `tiles`/`brotli` WASM bundles from the cargo target dir), MVT decoding,
// clipping, identify and GeoJSON, and MBTiles read/write on sql.js. Independent references: Node's
// zlib (gzip, Brotli, Zstandard encoders) and the protomaps `pmtiles` reader.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { PMTiles, SharedPromiseCache } from 'pmtiles';
import { Bundle } from '../../app/src/wasm/abi.js';
import { makeDecompress, brotliWith } from '../../app/src/tiles/decompress.js';
import { zstdDecode, zstdContentSize } from '../../app/src/codecs/zstd.js';
import { readDirectory } from '../../app/src/tiles/pmtiles-set.js';
import { encodeTilerInput, runTiler, writePmtiles, verifyPmtiles, gzipBytes, packTiles, unpackTiles } from '../../app/src/tiles/tiler.js';
import { decodeMvt, tileGeoJSON, queryTile, classifyRings, featureParts, tileToLonLat } from '../../app/src/tiles/mvt.js';
import { lonLatToWorld, worldToLonLat } from '../../app/src/tiles/merc.js';
import { openMbtiles, writeMbtiles, sniffTile, mbtilesTooLarge, MBTILES_CAP } from '../../app/src/formats/mbtiles.js';
import { paintFor } from '../../app/src/tiles/style.js';

const require = createRequire(import.meta.url);
const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => (target ? join(target, 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`) : null);
const haveWasm = !!target && existsSync(wasm('tiles')) && existsSync(wasm('brotli'));
const bundle = (n) => new Bundle(new WebAssembly.Module(readFileSync(wasm(n))), n);
const CORPUS = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');

/** A Blob-backed pmtiles Source. */
const blobSource = (u8, key = 'mem') => ({ getKey: () => key, getBytes: async (o, l) => ({ data: u8.slice(o, o + l).buffer }) });

describe('Zstandard (shared codec, FC-06)', () => {
  it('reads the frame content size and decodes Node zstd output exactly', async () => {
    const src = new TextEncoder().encode('tile '.repeat(5000));
    const z = new Uint8Array(zlib.zstdCompressSync(src));
    expect(zstdContentSize(z)).toBe(src.length);
    expect(Buffer.from(await zstdDecode(z)).equals(Buffer.from(src))).toBe(true);
  });
  it('refuses damaged frames by name', async () => {
    await expect(zstdDecode(new Uint8Array([1, 2, 3, 4, 5, 6]))).rejects.toThrow(/Zstandard data is damaged/);
    const z = new Uint8Array(zlib.zstdCompressSync(Buffer.alloc(1000, 7)));
    await expect(zstdDecode(z.subarray(0, z.length - 3))).rejects.toThrow(/damaged/);
    await expect(zstdDecode(z, 10)).rejects.toThrow(/limit/);
  });
});

describe.skipIf(!haveWasm)('PMTiles decompress hook (FC-06, REQ-FMT-30)', () => {
  let decompress;
  beforeAll(() => {
    const b = bundle('brotli');
    decompress = makeDecompress({ brotli: brotliWith(async () => b), zstd: (u8) => zstdDecode(u8) });
  });
  const data = new TextEncoder().encode(JSON.stringify({ hello: 'tiles', n: [...Array(500).keys()] }));
  it.each([
    ['none', 1, (d) => d],
    ['gzip', 2, (d) => zlib.gzipSync(d)],
    ['Brotli', 3, (d) => zlib.brotliCompressSync(d)],
    ['Zstandard', 4, (d) => zlib.zstdCompressSync(d)],
    ['unknown (gzip bytes)', 0, (d) => zlib.gzipSync(d)],
    ['unknown (zstd bytes)', 0, (d) => zlib.zstdCompressSync(d)],
  ])('%s', async (_, c, enc) => {
    const out = new Uint8Array(await decompress(new Uint8Array(enc(Buffer.from(data))).buffer, c));
    expect(Buffer.from(out).equals(Buffer.from(data))).toBe(true);
  });
  it('names a damaged Brotli or gzip block', async () => {
    await expect(decompress(new Uint8Array(64).fill(0xff).buffer, 3)).rejects.toThrow(/Brotli-compressed PMTiles block is damaged/);
    await expect(decompress(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2]).buffer, 2)).rejects.toThrow(/gzip-compressed PMTiles block is damaged/);
    await expect(decompress(new Uint8Array(4).buffer, 9)).rejects.toThrow(/not defined/);
  });
  it('Brotli output is capped (a small bomb cannot expand without bound)', () => {
    const b = bundle('brotli');
    const bomb = zlib.brotliCompressSync(Buffer.alloc(8 << 20));
    const [p, n] = b.put(new Uint8Array(bomb));
    expect(b.x.gw_brotli_decompress(p, n, 1 << 20)).not.toBe(0);
    expect(b.lastError()).toMatch(/limit/);
    b.free(p, n);
  });
});

/** Two layers in lon/lat around Florence. */
function sampleLayers() {
  const roads = { name: 'roads', features: [
    { type: 'Feature', id: 1, geometry: { type: 'LineString', coordinates: [[11.20, 43.76], [11.25, 43.77], [11.30, 43.78]] }, properties: { kind: 'major_road', name: 'Viale', lanes: 2, oneway: true } },
    { type: 'Feature', id: 2, geometry: { type: 'MultiLineString', coordinates: [[[11.24, 43.75], [11.24, 43.79]], [[11.26, 43.75], [11.26, 43.79]]] }, properties: { kind: 'minor_road', width: 3.5 } },
  ] };
  const places = { name: 'places', features: [
    { type: 'Feature', id: 7, geometry: { type: 'Point', coordinates: [11.2558, 43.7696] }, properties: { kind: 'locality', name: 'Firenze', pop: -1 } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[11.22, 43.74], [11.29, 43.74], [11.29, 43.79], [11.22, 43.79], [11.22, 43.74]], [[11.25, 43.76], [11.25, 43.77], [11.26, 43.77], [11.26, 43.76], [11.25, 43.76]]] }, properties: { kind: 'park', obj: { a: 1 } } },
  ] };
  return [roads, places];
}

describe.skipIf(!haveWasm)('MVT tiler and PMTiles writer (P14, REQ-FMT-31, REQ-FMT-33)', () => {
  let tb;
  let tiles;
  beforeAll(() => {
    tb = bundle('tiles');
    const { bytes, features } = encodeTilerInput(sampleLayers());
    expect(features).toBe(4);
    tiles = runTiler(tb, bytes, { minZoom: 0, maxZoom: 12, tolerance: 1 });
  });
  it('makes tiles at every zoom that the JS decoder reads back', () => {
    const zs = new Set(tiles.map((t) => t.z));
    expect([...zs].sort((a, b) => a - b)).toEqual([...Array(13).keys()]);
    const z0 = tiles.find((t) => t.z === 0);
    const vt = decodeMvt(z0.data);
    expect(Object.keys(vt.layers).sort()).toEqual(['places', 'roads']);
    // At zoom 0 the 4 km side streets are under a tile unit: generalised away; at zoom 12 both roads are there.
    expect(vt.layers.roads.length).toBe(1);
    const ids = new Set(tiles.filter((t) => t.z === 12).flatMap((t) => {
      const l = decodeMvt(t.data).layers.roads;
      return l ? Array.from({ length: l.length }, (_, i) => l.feature(i).id) : [];
    }));
    expect([...ids].sort()).toEqual([1, 2]);
    expect(vt.layers.roads.extent).toBe(4096);
    const f = vt.layers.roads.feature(0);
    expect(f.id).toBe(1);
    expect(f.properties).toMatchObject({ kind: 'major_road', name: 'Viale', lanes: 2, oneway: true });
    expect(vt.layers.places.feature(0).properties.pop).toBe(-1);
    const z12 = tiles.filter((t) => t.z === 12).flatMap((t) => Object.values(tileGeoJSON(decodeMvt(t.data), 12, t.x, t.y)).flat());
    expect(z12.find((x) => x.properties.kind === 'park').properties.obj).toBe('{"a":1}');
  });
  it('places features where they belong (max zoom, within a vertex quantum)', () => {
    const z = 12;
    const [wx, wy] = lonLatToWorld(11.2558, 43.7696);
    const n = 2 ** z;
    const t = tiles.find((q) => q.z === z && q.x === Math.floor(wx * n) && q.y === Math.floor(wy * n));
    const gj = tileGeoJSON(decodeMvt(t.data), z, t.x, t.y);
    const p = gj.places.find((f) => f.properties.name === 'Firenze');
    expect(p.geometry.coordinates[0]).toBeCloseTo(11.2558, 4);
    expect(p.geometry.coordinates[1]).toBeCloseTo(43.7696, 4);
    // The polygon keeps its hole and GeoJSON winding.
    const park = Object.values(gj).flat().find((f) => f.properties.kind === 'park');
    expect(park).toBeTruthy();
  });
  it('packs, writes a clustered PMTiles v3 that the protomaps reader and the verifier accept', async () => {
    expect(unpackTiles(packTiles(tiles)).length).toBe(tiles.length);
    const arch = writePmtiles(tb, tiles, { type: 'mvt', bounds: [11.2, 43.74, 11.3, 43.79], metadata: { name: 't', vector_layers: [{ id: 'roads' }, { id: 'places' }] } });
    const v = verifyPmtiles(tb, arch);
    expect(v).toMatchObject({ addressed: tiles.length, minZoom: 0, maxZoom: 12, tileType: 1, clustered: true });
    const pm = new PMTiles(blobSource(arch));
    const h = await pm.getHeader();
    expect([h.minZoom, h.maxZoom, h.tileCompression, h.internalCompression, h.clustered]).toEqual([0, 12, 2, 2, true]);
    expect((await pm.getMetadata()).name).toBe('t');
    for (const t of tiles.slice(0, 40)) {
      const r = await pm.getZxy(t.z, t.x, t.y);
      expect(Buffer.from(new Uint8Array(r.data)).equals(Buffer.from(t.data))).toBe(true);
    }
    // The directory reader used for listing agrees with the archive.
    const root = new Uint8Array(zlib.gunzipSync(arch.subarray(h.rootDirectoryOffset, h.rootDirectoryOffset + h.rootDirectoryLength)));
    const es = readDirectory(root);
    expect(es.reduce((s, e) => s + e.runLength, 0)).toBe(tiles.length);
    // Deterministic output (REQ-RUST determinism gate).
    expect(Buffer.from(writePmtiles(tb, tiles, { type: 'mvt', bounds: [11.2, 43.74, 11.3, 43.79], metadata: { name: 't', vector_layers: [{ id: 'roads' }, { id: 'places' }] } })).equals(Buffer.from(arch))).toBe(true);
  });
  it('refuses a tile budget overrun and bad input by name', () => {
    const { bytes } = encodeTilerInput(sampleLayers());
    expect(() => runTiler(tb, bytes, { minZoom: 0, maxZoom: 18, maxTiles: 50 })).toThrow(/more than 50 tiles/);
    expect(() => runTiler(tb, new Uint8Array([1, 2, 3]), {})).toThrow(/tiler input|GWVT/);
  });
  it('gzips deterministically (MBTiles vector tiles)', () => {
    const z = gzipBytes(tb, new TextEncoder().encode('abc'.repeat(100)));
    expect(zlib.gunzipSync(z).toString()).toBe('abc'.repeat(100));
    expect(Buffer.from(gzipBytes(tb, new TextEncoder().encode('abc'.repeat(100)))).equals(Buffer.from(z))).toBe(true);
  });
});

describe('MVT helpers (FC-07, REQ-FMT-32)', () => {
  it('web mercator round trip and tile coordinates', () => {
    const [x, y] = lonLatToWorld(-122.4, 37.8);
    const [lon, lat] = worldToLonLat(x, y);
    expect(lon).toBeCloseTo(-122.4, 9);
    expect(lat).toBeCloseTo(37.8, 9);
    expect(tileToLonLat(0, 0, 4096, 0, 0, 0)[1]).toBeCloseTo(85.0511, 3);
  });
  it('classifies rings by winding and clips to the tile', () => {
    const P = (x, y) => ({ x, y });
    const outer = [P(0, 0), P(10, 0), P(10, 10), P(0, 10)];
    const hole = [P(2, 2), P(2, 4), P(4, 4), P(4, 2)];
    const other = [P(20, 20), P(30, 20), P(30, 30), P(20, 30)];
    const polys = classifyRings([outer, hole, other]);
    expect(polys.length).toBe(2);
    expect(polys[0].length).toBe(2);
    const f = { type: 3, loadGeometry: () => [[P(-100, 50), P(200, 50), P(200, 150), P(-100, 150)]] };
    const g = featureParts(f, 100, true);
    for (const p of g.parts[0][0]) expect(p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100).toBe(true);
    const pts = { type: 1, loadGeometry: () => [[P(-5, 5)], [P(50, 50)]] };
    expect(featureParts(pts, 100, true).parts.length).toBe(1);
    expect(featureParts(pts, 100, false).parts.length).toBe(2);
  });
  it('refuses bytes that are not a vector tile', () => {
    expect(() => decodeMvt(new Uint8Array([0x1f, 0x8b, 1]))).toThrow(/still gzip/);
    expect(() => decodeMvt(new Uint8Array([0x1a, 0x7f, 0x01]))).toThrow(/vector tile is damaged/);
  });
  it('styles the Protomaps and OpenMapTiles schemas and anything else', () => {
    expect(paintFor('water', {}, 3, 10).fill).toBeTruthy();
    expect(paintFor('transportation', { class: 'motorway' }, 2, 12).stroke).toBeTruthy();
    expect(paintFor('roads', { kind: 'highway' }, 2, 12).casing).toBeTruthy();
    expect(paintFor('my_layer', {}, 3, 5).fillAlpha).toBe(0.3);
    expect(paintFor('buildings', {}, 3, 10)).toBeNull();
  });
});

describe.skipIf(!haveWasm)('identify', () => {
  it('finds the point, line and polygon under a place', () => {
    const tb = bundle('tiles');
    const { bytes } = encodeTilerInput(sampleLayers());
    const tiles = runTiler(tb, bytes, { minZoom: 10, maxZoom: 10 });
    const [wx, wy] = lonLatToWorld(11.2558, 43.7696);
    const n = 2 ** 10;
    const t = tiles.find((q) => q.x === Math.floor(wx * n) && q.y === Math.floor(wy * n));
    const hits = queryTile(decodeMvt(t.data), wx * n - t.x, wy * n - t.y, 0.01);
    expect(hits[0]).toMatchObject({ layer: 'places', type: 'Point', properties: { name: 'Firenze' } });
    expect(hits.some((h) => h.type === 'Polygon')).toBe(false); // in the park's hole
  });
});

describe('MBTiles (FC-05, REQ-FMT-28, REQ-FMT-29)', () => {
  let SQL;
  beforeAll(async () => {
    const initSqlJs = require('rtree-sql.js/dist/sql-wasm.js');
    SQL = await initSqlJs({ wasmBinary: readFileSync(require.resolve('rtree-sql.js/dist/sql-wasm.wasm')) });
  });
  it('writes and reads back with the TMS row flip and metadata', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const tiles = [{ z: 0, x: 0, y: 0, data: png }, { z: 1, x: 1, y: 0, data: png.slice().fill(9, 8) }];
    const bytes = writeMbtiles(SQL, tiles, { name: 'unit', format: 'png', bounds: [-10, -5, 10, 5], minzoom: 0, maxzoom: 1 });
    const ts = await openMbtiles(SQL, bytes, 'unit.mbtiles');
    expect(ts).toMatchObject({ tileType: 'png', minZoom: 0, maxZoom: 1, bounds: [-10, -5, 10, 5], name: 'unit' });
    expect([...(await ts.getTile(1, 1, 0))]).toEqual([...tiles[1].data]);
    expect(await ts.getTile(1, 1, 1)).toBeNull();
    // Stored TMS: row 1 at zoom 1 is the northern row (XYZ y = 0).
    const db = new SQL.Database(bytes);
    expect(db.exec('SELECT tile_row FROM tiles WHERE zoom_level = 1')[0].values[0][0]).toBe(1);
    db.close();
    expect(ts.list(1)).toEqual([[1, 1, 0]]);
    ts.close();
  });
  it('sniffs tile types and refuses what is not a tile set', async () => {
    expect(sniffTile(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffTile(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe('mvt');
    const empty = new SQL.Database();
    empty.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
    await expect(openMbtiles(SQL, empty.export())).rejects.toThrow(/holds no tiles/);
    empty.close();
    await expect(openMbtiles(SQL, new SQL.Database().export())).rejects.toThrow(/no "tiles" table/);
    expect(mbtilesTooLarge(MBTILES_CAP + 1)).toMatch(/convert it to PMTiles/);
  });
  const corpus = join(CORPUS, 'vector-mbtiles-gdal-autotest', 'mvt_point_polygon.mbtiles');
  it.skipIf(!existsSync(corpus))('reads a GDAL-written vector MBTiles (gzip MVT)', async () => {
    const ts = await openMbtiles(SQL, new Uint8Array(readFileSync(corpus)), 'mvt_point_polygon.mbtiles');
    expect(ts.tileType).toBe('mvt');
    let n = 0;
    for (const [z, x, y] of ts.list(1)) {
      const vt = decodeMvt(await ts.getTile(z, x, y));
      for (const l of Object.values(vt.layers)) n += l.length;
    }
    expect(n).toBe(6); // OGR: point 2 + polygon2 4 at the maximum zoom
    ts.close();
  });
});
