// FX-21 tiles (SDP-2.1 §4 P9; FC-05..07): synthetic MBTiles and PMTiles with known content, written
// here without the app's own writers (independent of what they test): a minimal PNG encoder, MVT
// tiles from pbf's PbfWriter, MBTiles through rtree-sql.js and a PMTiles v3 writer of a single
// root directory (plus one with leaf directories). Compressions come from Node's zlib (gzip,
// Brotli, Zstandard). Checked by GDAL/OGR (MBTiles raster and vector, PMTiles vector) and the
// protomaps Python reader (gzip PMTiles); `fx21/tiles/manifest.json` holds the expected values.
//
//   node build/fixtures/fxformats21.mjs --only=tiles

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { PbfWriter } from 'pbf';

const require = createRequire(import.meta.url);

// ---- PNG (8-bit RGBA, filter 0) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(h * (1 + 4 * w));
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * 4 * w, 4 * w).copy(raw, y * (1 + 4 * w) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
/** Raster tile z/x/y: R = 40·z + 10, G = x·8 % 256, B = y·8 % 256, opaque; a 1-px black frame. */
export const tileColour = (z, x, y) => [(40 * z + 10) & 255, (x * 8) & 255, (y * 8) & 255];
function rasterTile(z, x, y) {
  const [r, g, b] = tileColour(z, x, y);
  const px = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) {
    const X = i % 256;
    const Y = (i / 256) | 0;
    const edge = X === 0 || Y === 0 || X === 255 || Y === 255;
    px.set(edge ? [0, 0, 0, 255] : [r, g, b, 255], 4 * i);
  }
  return png(256, 256, px);
}

// ---- MVT (spec 2.1) ----
const zz = (v) => (v << 1) ^ (v >> 31);
function geometry(type, parts) {
  const cmd = [];
  let cx = 0;
  let cy = 0;
  for (const part of parts) {
    const ring = type === 3;
    const pts = part;
    if (type === 1) {
      cmd.push(1 | (pts.length << 3));
      for (const [x, y] of pts) {
        cmd.push(zz(x - cx), zz(y - cy));
        [cx, cy] = [x, y];
      }
      continue;
    }
    cmd.push(1 | (1 << 3), zz(pts[0][0] - cx), zz(pts[0][1] - cy));
    [cx, cy] = pts[0];
    cmd.push(2 | ((pts.length - 1) << 3));
    for (const [x, y] of pts.slice(1)) {
      cmd.push(zz(x - cx), zz(y - cy));
      [cx, cy] = [x, y];
    }
    if (ring) cmd.push(7 | (1 << 3));
  }
  return cmd;
}
/** One tile: layers [{name, features: [{id, type, parts, props}]}]. */
function mvtTile(layers) {
  const pbf = new PbfWriter();
  for (const l of layers) {
    pbf.writeMessage(3, (layer, w) => {
      w.writeVarintField(15, 2);
      w.writeStringField(1, layer.name);
      const keys = [];
      const vals = [];
      const kIdx = (k) => (keys.includes(k) ? keys.indexOf(k) : keys.push(k) - 1);
      const vIdx = (v) => {
        const i = vals.findIndex((x) => x === v);
        return i >= 0 ? i : vals.push(v) - 1;
      };
      for (const f of layer.features) {
        w.writeMessage(2, (ft, wf) => {
          if (ft.id !== undefined) wf.writeVarintField(1, ft.id);
          const tags = [];
          for (const [k, v] of Object.entries(ft.props ?? {})) tags.push(kIdx(k), vIdx(v));
          if (tags.length) wf.writePackedVarint(2, tags);
          wf.writeVarintField(3, ft.type);
          wf.writePackedVarint(4, geometry(ft.type, ft.parts));
        }, f);
      }
      for (const k of keys) w.writeStringField(3, k);
      for (const v of vals)
        w.writeMessage(4, (val, wv) => {
          if (typeof val === 'string') wv.writeStringField(1, val);
          else if (typeof val === 'boolean') wv.writeBooleanField(7, val);
          else if (Number.isInteger(val) && val >= 0) wv.writeVarintField(5, val);
          else if (Number.isInteger(val)) wv.writeSVarintField(6, val);
          else wv.writeDoubleField(3, val);
        }, v);
      w.writeVarintField(5, 4096);
    }, l);
  }
  return Buffer.from(pbf.finish());
}
/** Vector tile z/x/y: one point (id = 1000·z + 10·x + y) at the centre, a diagonal line, a square with a hole. */
function vectorTile(z, x, y) {
  const id = 1000 * z + 10 * x + y;
  return mvtTile([
    { name: 'points', features: [{ id, type: 1, parts: [[[2048, 2048]]], props: { name: `p${z}/${x}/${y}`, z, flag: true } }] },
    { name: 'lines', features: [{ id, type: 2, parts: [[[512, 512], [3584, 3584]]], props: { kind: 'diagonal', len: 1.5 } }] },
    { name: 'polygons', features: [{ id, type: 3, parts: [[[1024, 1024], [3072, 1024], [3072, 3072], [1024, 3072]], [[1536, 1536], [1536, 2560], [2560, 2560], [2560, 1536]]], props: { kind: 'square', neg: -7 } }] },
  ]);
}

// ---- PMTiles v3 ----
function zxyToId(z, x, y) {
  let acc = (4 ** z - 1) / 3;
  const n = 2 ** z;
  let d = 0;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) > 0 ? 1 : 0;
    const ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x;
        y = n - 1 - y;
      }
      [x, y] = [y, x];
    }
  }
  return acc + d;
}
const varints = (vals) => {
  const out = [];
  for (let v of vals) {
    while (v >= 128) {
      out.push((v % 128) | 128);
      v = Math.floor(v / 128);
    }
    out.push(v);
  }
  return out;
};
function directory(entries) {
  const v = [entries.length];
  let last = 0;
  for (const e of entries) {
    v.push(e.id - last);
    last = e.id;
  }
  for (const e of entries) v.push(e.run);
  for (const e of entries) v.push(e.length);
  for (const e of entries) v.push(e.offset + 1);
  return Buffer.from(varints(v));
}
const COMP = { none: 1, gzip: 2, brotli: 3, zstd: 4 };
const compress = (b, c) => (c === 'gzip' ? zlib.gzipSync(b) : c === 'brotli' ? zlib.brotliCompressSync(b) : c === 'zstd' ? zlib.zstdCompressSync(b) : b);
/** tiles: [{z, x, y, data}] (raw); internal and tile compression c; leafSize splits the directory. */
export function pmtiles(tiles, { type, internal, tileComp, bounds, meta, leafSize = 0 }) {
  const sorted = tiles.map((t) => ({ ...t, id: zxyToId(t.z, t.x, t.y) })).sort((a, b) => a.id - b.id);
  const bodies = [];
  let off = 0;
  const entries = sorted.map((t) => {
    const b = compress(t.data, tileComp);
    bodies.push(b);
    const e = { id: t.id, offset: off, length: b.length, run: 1 };
    off += b.length;
    return e;
  });
  let root;
  let leaves = Buffer.alloc(0);
  if (leafSize && entries.length > leafSize) {
    const parts = [];
    const rootEntries = [];
    let lo = 0;
    for (let i = 0; i < entries.length; i += leafSize) {
      const d = compress(directory(entries.slice(i, i + leafSize)), internal);
      rootEntries.push({ id: entries[i].id, offset: lo, length: d.length, run: 0 });
      parts.push(d);
      lo += d.length;
    }
    leaves = Buffer.concat(parts);
    root = compress(directory(rootEntries), internal);
  } else root = compress(directory(entries), internal);
  const metaB = compress(Buffer.from(JSON.stringify(meta)), internal);
  const data = Buffer.concat(bodies);
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1');
  h[7] = 3;
  const u64 = (o, v) => h.writeBigUInt64LE(BigInt(v), o);
  const rootOff = 127;
  const metaOff = rootOff + root.length;
  const leafOff = metaOff + metaB.length;
  const dataOff = leafOff + leaves.length;
  [rootOff, root.length, metaOff, metaB.length, leafOff, leaves.length, dataOff, data.length, entries.length, entries.length, entries.length].forEach((v, i) => u64(8 + 8 * i, v));
  h[96] = 1;
  h[97] = COMP[internal];
  h[98] = COMP[tileComp];
  h[99] = type;
  const zs = tiles.map((t) => t.z);
  h[100] = Math.min(...zs);
  h[101] = Math.max(...zs);
  bounds.forEach((v, i) => h.writeInt32LE(Math.round(v * 1e7), 102 + 4 * i));
  h[118] = 0;
  h.writeInt32LE(Math.round(((bounds[0] + bounds[2]) / 2) * 1e7), 119);
  h.writeInt32LE(Math.round(((bounds[1] + bounds[3]) / 2) * 1e7), 123);
  return Buffer.concat([h, root, metaB, leaves, data]);
}

// ---- MBTiles ----
async function mbtiles(tiles, meta) {
  const initSqlJs = require('rtree-sql.js/dist/sql-wasm.js');
  const SQL = await initSqlJs({ wasmBinary: readFileSync(require.resolve('rtree-sql.js/dist/sql-wasm.wasm')) });
  const db = new SQL.Database();
  db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
  for (const [k, v] of Object.entries(meta)) db.run('INSERT INTO metadata VALUES (?, ?)', [k, String(v)]);
  for (const t of tiles) db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [t.z, t.x, 2 ** t.z - 1 - t.y, t.data]);
  const out = Buffer.from(db.export());
  db.close();
  return out;
}

/** Every tile of zooms z0..z1 inside [w, s, e, n]. */
function cover(z0, z1, [w, s, e, n]) {
  const out = [];
  const ty = (lat, N) => Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * N);
  for (let z = z0; z <= z1; z++) {
    const N = 2 ** z;
    for (let x = Math.max(0, Math.floor(((w + 180) / 360) * N)); x <= Math.min(N - 1, Math.floor(((e + 180) / 360) * N - 1e-9)); x++)
      for (let y = Math.max(0, ty(n, N)); y <= Math.min(N - 1, ty(s, N)); y++) out.push([z, x, y]);
  }
  return out;
}

export async function generate(outDir) {
  const made = [];
  const expect = {};
  const put = (name, bytes, facts) => {
    writeFileSync(join(outDir, name), bytes);
    made.push(name);
    expect[name] = facts;
  };
  // Raster: zoom 0–2 over the whole world (21 tiles), bounds metadata given.
  const world = [-180, -85.0511287798066, 180, 85.0511287798066];
  const rTiles = cover(0, 2, world).map(([z, x, y]) => ({ z, x, y, data: rasterTile(z, x, y) }));
  put('fx21_raster_png.mbtiles', await mbtiles(rTiles, { name: 'fx21 raster', format: 'png', bounds: world.join(','), minzoom: 0, maxzoom: 2, type: 'baselayer', version: '1.3' }), { kind: 'raster', width: 1024, height: 1024, tiles: 21, colour: 'tileColour(z, x, y)' });
  // A raster subset whose bounds cut tiles (GDAL's grid: origin and size from the bounds).
  const sub = [-45, -30, 60, 50];
  const sTiles = cover(2, 3, sub).map(([z, x, y]) => ({ z, x, y, data: rasterTile(z, x, y) }));
  put('fx21_raster_bounds.mbtiles', await mbtiles(sTiles, { name: 'fx21 bounds', format: 'png', bounds: sub.join(','), minzoom: 2, maxzoom: 3 }), { kind: 'raster', bounds: sub, tiles: sTiles.length });
  // Vector: zoom 0–2 everywhere (21 tiles × 3 features).
  const vTiles = cover(0, 2, world).map(([z, x, y]) => ({ z, x, y, data: vectorTile(z, x, y) }));
  const vl = [{ id: 'points', fields: { name: 'String', z: 'Number', flag: 'Boolean' } }, { id: 'lines', fields: { kind: 'String', len: 'Number' } }, { id: 'polygons', fields: { kind: 'String', neg: 'Number' } }];
  put('fx21_vector.mbtiles', await mbtiles(vTiles.map((t) => ({ ...t, data: zlib.gzipSync(t.data) })), { name: 'fx21 vector', format: 'pbf', bounds: world.join(','), minzoom: 0, maxzoom: 2, json: JSON.stringify({ vector_layers: vl }) }), { kind: 'vector', maxZoomTiles: 16, layers: { points: 16, lines: 16, polygons: 16 } });
  // PMTiles, every compression, vector and raster.
  for (const c of ['none', 'gzip', 'brotli', 'zstd']) {
    put(`fx21_vector_${c}.pmtiles`, pmtiles(vTiles, { type: 1, internal: c, tileComp: c, bounds: world, meta: { name: `fx21 vector ${c}`, vector_layers: vl } }), { kind: 'vector', compression: c, tiles: 21, layers: { points: 16, lines: 16, polygons: 16 } });
    put(`fx21_raster_${c}.pmtiles`, pmtiles(rTiles, { type: 2, internal: c, tileComp: 'none', bounds: world, meta: { name: `fx21 raster ${c}` } }), { kind: 'raster', compression: c, tiles: 21 });
  }
  // Leaf directories (root of 3 leaves) with Brotli, and with gzip.
  for (const c of ['gzip', 'brotli']) put(`fx21_vector_${c}_leaves.pmtiles`, pmtiles(vTiles, { type: 1, internal: c, tileComp: c, bounds: world, meta: { name: `fx21 leaves ${c}`, vector_layers: vl }, leafSize: 8 }), { kind: 'vector', compression: c, tiles: 21, leaves: 3 });
  // Negative: a Brotli archive cut inside its tile data (named error on the cut tiles, no hang).
  const good = pmtiles(vTiles, { type: 1, internal: 'brotli', tileComp: 'brotli', bounds: world, meta: { name: 'cut' } });
  put('fx21_vector_brotli_cut.pmtiles', good.subarray(0, good.length - 300), { kind: 'negative', reason: 'tile data cut short' });
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ generator: 'build/fixtures/fx21/tiles.mjs', files: expect }, null, 1));
  return made;
}
