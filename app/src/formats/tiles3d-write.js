// 3D Tiles writers (REQ-FMT-37, FC-10..FC-13): point clouds as pnts (one tile, or an implicit
// octree tileset: 3D Tiles 1.1 implicitTiling with binary subtrees and ADD refinement), meshes
// as b3dm, placed models as i3dm, mixes as cmpt; a tileset is a {path: bytes} map that is packed
// as a ZIP folder or a .3tz (OGC CS 22-025: an uncompressed ZIP with a sorted MD5 index).
// Pure functions (no DOM): the app, the FX-21 generator and the unit tests share them.
// Coordinates: content is written in an east-north-up frame at an origin, the root carrying the
// ENU → ECEF transform (so float32 positions keep millimetres), unless the caller gives ECEF.

import { zipSync } from 'fflate';

const A = 6378137;
const E2 = 0.0066943799901413165;
const te = new TextEncoder();

export function geoToEcef(lat, lon, h) {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const s = Math.sin(la);
  const n = A / Math.sqrt(1 - E2 * s * s);
  return [(n + h) * Math.cos(la) * Math.cos(lo), (n + h) * Math.cos(la) * Math.sin(lo), (n * (1 - E2) + h) * s];
}

/** Column-major ENU → ECEF matrix at (lat, lon, h). */
export function enuToEcef(lat, lon, h = 0) {
  const [la, lo] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
  const e = [-Math.sin(lo), Math.cos(lo), 0];
  const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const o = geoToEcef(lat, lon, h);
  return [...e, 0, ...n, 0, ...u, 0, ...o, 1];
}

const pad = (n, k = 8) => (k - (n % k)) % k;
/** JSON padded with spaces to 8 bytes (the table header rule), from byte offset `at`. */
function jsonBytes(obj, at = 0) {
  const s = JSON.stringify(obj);
  const b = te.encode(s);
  const out = new Uint8Array(b.length + pad(at + b.length));
  out.fill(0x20);
  out.set(b);
  return out;
}
function binPadded(parts) {
  let n = 0;
  for (const p of parts) n += p.byteLength + pad(p.byteLength);
  const out = new Uint8Array(n);
  let o = 0;
  const offs = [];
  for (const p of parts) {
    offs.push(o);
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += p.byteLength + pad(p.byteLength);
  }
  return { bin: out, offs };
}

/** A tile: magic, header (28 or 32 bytes), feature table, batch table, body. */
function tile(magic, ftJson, ftBin, btJson, btBin, body = new Uint8Array(0), gltfFormat) {
  const head = magic === 'i3dm' ? 32 : 28;
  const ftj = jsonBytes(ftJson, head);
  const ftb = ftBin ?? new Uint8Array(0);
  const btj = btJson && Object.keys(btJson).length ? jsonBytes(btJson, head + ftj.length + ftb.length) : new Uint8Array(0);
  const btb = btJson && Object.keys(btJson).length ? btBin ?? new Uint8Array(0) : new Uint8Array(0);
  const bodyAt = head + ftj.length + ftb.length + btj.length + btb.length;
  const total = bodyAt + body.length + pad(bodyAt + body.length);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(te.encode(magic), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, ftj.length, true);
  dv.setUint32(16, ftb.length, true);
  dv.setUint32(20, btj.length, true);
  dv.setUint32(24, btb.length, true);
  if (magic === 'i3dm') dv.setUint32(28, gltfFormat, true);
  let o = head;
  for (const p of [ftj, ftb, btj, btb, body]) {
    out.set(p, o);
    o += p.length;
  }
  // An i3dm glTF URI is padded with spaces, not NULs.
  if (magic === 'i3dm' && gltfFormat === 0) out.fill(0x20, o);
  return out;
}

/**
 * Batch-table properties → {json, bin}: numeric typed arrays go to the binary body
 * ({byteOffset, componentType, type}); plain arrays stay in the JSON.
 */
function batchTable(props = {}) {
  const json = {};
  const parts = [];
  const CT = { Int8Array: 'BYTE', Uint8Array: 'UNSIGNED_BYTE', Int16Array: 'SHORT', Uint16Array: 'UNSIGNED_SHORT', Int32Array: 'INT', Uint32Array: 'UNSIGNED_INT', Float32Array: 'FLOAT', Float64Array: 'DOUBLE' };
  let at = 0;
  for (const [k, v] of Object.entries(props)) {
    if (ArrayBuffer.isView(v) && CT[v.constructor.name]) {
      json[k] = { byteOffset: at, componentType: CT[v.constructor.name], type: 'SCALAR' };
      parts.push(v);
      at += v.byteLength + pad(v.byteLength);
    } else if (v && ArrayBuffer.isView(v.values) && CT[v.values.constructor.name]) {
      json[k] = { byteOffset: at, componentType: CT[v.values.constructor.name], type: ['SCALAR', 'SCALAR', 'VEC2', 'VEC3', 'VEC4'][v.size ?? 1] };
      parts.push(v.values);
      at += v.values.byteLength + pad(v.values.byteLength);
    } else if (Array.isArray(v)) json[k] = v;
  }
  return { json, bin: binPadded(parts).bin };
}

/**
 * pnts from points: {positions (Float32Array/Float64Array, xyz in the tile frame), colors?
 * (Uint8Array RGB or RGBA), normals? (Float32Array), batch? (per-point properties)}.
 * opts: {rtc: [x, y, z] (subtracted from positions), quantize, octNormals, rgb565, constantRgba}.
 */
export function writePnts({ positions, colors = null, colorSize = 3, normals = null, batch = null }, { rtc = null, quantize = false, octNormals = false, rgb565 = false, constantRgba = null } = {}) {
  const n = positions.length / 3;
  const ft = { POINTS_LENGTH: n };
  const parts = [];
  const add = (name, arr, extra = {}) => {
    ft[name] = { byteOffset: parts.reduce((s, p) => s + p.byteLength + pad(p.byteLength), 0), ...extra };
    parts.push(arr);
  };
  const c = rtc ?? [0, 0, 0];
  if (rtc) ft.RTC_CENTER = rtc;
  if (quantize) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], positions[3 * i + k] - c[k])), (hi[k] = Math.max(hi[k], positions[3 * i + k] - c[k]));
    const sc = hi.map((h, k) => Math.max(h - lo[k], 1e-6));
    const q = new Uint16Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) q[3 * i + k] = Math.round(((positions[3 * i + k] - c[k] - lo[k]) / sc[k]) * 65535);
    ft.QUANTIZED_VOLUME_OFFSET = lo;
    ft.QUANTIZED_VOLUME_SCALE = sc;
    add('POSITION_QUANTIZED', q);
  } else {
    const p = new Float32Array(3 * n);
    for (let i = 0; i < 3 * n; i++) p[i] = positions[i] - c[i % 3];
    add('POSITION', p);
  }
  if (colors && rgb565) {
    const v = new Uint16Array(n);
    for (let i = 0; i < n; i++) v[i] = ((colors[colorSize * i] >> 3) << 11) | ((colors[colorSize * i + 1] >> 2) << 5) | (colors[colorSize * i + 2] >> 3);
    add('RGB565', v);
  } else if (colors) add(colorSize === 4 ? 'RGBA' : 'RGB', colors);
  if (constantRgba) ft.CONSTANT_RGBA = constantRgba;
  if (normals && octNormals) {
    const o = new Uint8Array(2 * n);
    for (let i = 0; i < n; i++) o.set(octEncode(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2], 255), 2 * i);
    add('NORMAL_OCT16P', o);
  } else if (normals) add('NORMAL', normals instanceof Float32Array ? normals : Float32Array.from(normals));
  const bt = batch ? batchTable(batch) : { json: {}, bin: new Uint8Array(0) };
  return tile('pnts', ft, binPadded(parts).bin, bt.json, bt.bin);
}

/** Oct encoding of a unit vector into two values of 0…range. */
export function octEncode(x, y, z, range) {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  return [Math.round((u * 0.5 + 0.5) * range), Math.round((v * 0.5 + 0.5) * range)];
}

/** b3dm around a GLB: opts {rtc, batchLength, batch}. */
export function writeB3dm(glb, { rtc = null, batchLength = 0, batch = null } = {}) {
  const ft = { BATCH_LENGTH: batchLength };
  if (rtc) ft.RTC_CENTER = rtc;
  const bt = batch ? batchTable(batch) : { json: {}, bin: new Uint8Array(0) };
  return tile('b3dm', ft, null, bt.json, bt.bin, glb);
}

/**
 * i3dm: {glb | uri, positions (tile frame), up?, right? (Float32Array), scale?, scaleNonUniform?,
 * eastNorthUp?, batch?}. opts: {rtc, quantize, octNormals}.
 */
export function writeI3dm({ glb = null, uri = null, positions, up = null, right = null, scale = null, scaleNonUniform = null, eastNorthUp = false, batch = null }, { rtc = null, quantize = false, octNormals = false } = {}) {
  const n = positions.length / 3;
  const ft = { INSTANCES_LENGTH: n };
  const parts = [];
  const add = (name, arr) => {
    ft[name] = { byteOffset: parts.reduce((s, p) => s + p.byteLength + pad(p.byteLength), 0) };
    parts.push(arr);
  };
  const c = rtc ?? [0, 0, 0];
  if (rtc) ft.RTC_CENTER = rtc;
  if (quantize) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], positions[3 * i + k] - c[k])), (hi[k] = Math.max(hi[k], positions[3 * i + k] - c[k]));
    const sc = hi.map((h, k) => Math.max(h - lo[k], 1e-6));
    const q = new Uint16Array(3 * n);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) q[3 * i + k] = Math.round(((positions[3 * i + k] - c[k] - lo[k]) / sc[k]) * 65535);
    ft.QUANTIZED_VOLUME_OFFSET = lo;
    ft.QUANTIZED_VOLUME_SCALE = sc;
    add('POSITION_QUANTIZED', q);
  } else {
    const p = new Float32Array(3 * n);
    for (let i = 0; i < 3 * n; i++) p[i] = positions[i] - c[i % 3];
    add('POSITION', p);
  }
  if (up && right && octNormals) {
    const u = new Uint16Array(2 * n);
    const r = new Uint16Array(2 * n);
    for (let i = 0; i < n; i++) {
      u.set(octEncode(up[3 * i], up[3 * i + 1], up[3 * i + 2], 65535), 2 * i);
      r.set(octEncode(right[3 * i], right[3 * i + 1], right[3 * i + 2], 65535), 2 * i);
    }
    add('NORMAL_UP_OCT32P', u);
    add('NORMAL_RIGHT_OCT32P', r);
  } else if (up && right) {
    add('NORMAL_UP', Float32Array.from(up));
    add('NORMAL_RIGHT', Float32Array.from(right));
  }
  if (scaleNonUniform) add('SCALE_NON_UNIFORM', Float32Array.from(scaleNonUniform));
  else if (scale) add('SCALE', Float32Array.from(scale));
  if (eastNorthUp) ft.EAST_NORTH_UP = true;
  const bt = batch ? batchTable(batch) : { json: {}, bin: new Uint8Array(0) };
  const body = glb ?? te.encode(uri);
  return tile('i3dm', ft, binPadded(parts).bin, bt.json, bt.bin, body, glb ? 1 : 0);
}

/** cmpt of inner tiles (each a b3dm/pnts/i3dm/cmpt, 8-byte aligned). */
export function writeCmpt(tiles) {
  const total = 16 + tiles.reduce((s, t) => s + t.length + pad(t.length), 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(te.encode('cmpt'), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, tiles.length, true);
  let o = 16;
  for (const t of tiles) {
    // Inner tiles are padded to 8 bytes and their own byteLength set to include the padding.
    const len = t.length + pad(t.length);
    out.set(t, o);
    new DataView(out.buffer).setUint32(o + 8, len, true);
    o += len;
  }
  return out;
}

const morton3 = (x, y, z) => {
  let m = 0;
  for (let i = 0; i < 21; i++) m += ((x >> i) & 1) * 2 ** (3 * i) + ((y >> i) & 1) * 2 ** (3 * i + 1) + ((z >> i) & 1) * 2 ** (3 * i + 2);
  return m;
};

/**
 * A point cloud as an implicit octree tileset (3D Tiles 1.1, ADD refinement). points: {positions
 * (ENU metres about `origin`), colors?, colorSize?, batch? (per-point typed arrays)}; origin
 * {lat, lon, h}. Each tile keeps up to `maxPoints` points spread over its volume (one per voxel of
 * a grid sized for that budget); the rest go to its children. Returns {files, tileset, stats}.
 */
export function writePointCloudTileset(points, origin, { maxPoints = 20000, subtreeLevels = 3, maxLevels = 12, quantize = true } = {}) {
  const P = points.positions;
  const n = P.length / 3;
  if (!n) throw new Error('3D Tiles writer: the point cloud is empty');
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) (lo[k] = Math.min(lo[k], P[3 * i + k])), (hi[k] = Math.max(hi[k], P[3 * i + k]));
  const c = lo.map((l, k) => (l + hi[k]) / 2);
  const half = Math.max(0.5, ...hi.map((h, k) => (h - lo[k]) / 2)) * 1.0001;
  const tiles = new Map(); // `${l}/${x}/${y}/${z}` → indices
  const stack = [{ l: 0, x: 0, y: 0, z: 0, idx: Uint32Array.from({ length: n }, (_, i) => i) }];
  let levels = 1;
  while (stack.length) {
    const t = stack.pop();
    const size = (2 * half) / 2 ** t.l;
    const x0 = c[0] - half + t.x * size;
    const y0 = c[1] - half + t.y * size;
    const z0 = c[2] - half + t.z * size;
    let keep = t.idx;
    let rest = null;
    if (t.idx.length > maxPoints && t.l + 1 < maxLevels) {
      const g = Math.max(1, Math.floor(Math.cbrt(maxPoints)));
      const seen = new Set();
      const k = [];
      const r = [];
      for (const i of t.idx) {
        const cell = Math.min(g - 1, Math.floor(((P[3 * i] - x0) / size) * g)) + g * (Math.min(g - 1, Math.floor(((P[3 * i + 1] - y0) / size) * g)) + g * Math.min(g - 1, Math.floor(((P[3 * i + 2] - z0) / size) * g)));
        if (!seen.has(cell) && k.length < maxPoints) {
          seen.add(cell);
          k.push(i);
        } else r.push(i);
      }
      keep = Uint32Array.from(k);
      rest = r;
    }
    tiles.set(`${t.l}/${t.x}/${t.y}/${t.z}`, keep);
    levels = Math.max(levels, t.l + 1);
    if (rest?.length) {
      const kids = new Map();
      const mid = [x0 + size / 2, y0 + size / 2, z0 + size / 2];
      for (const i of rest) {
        const b = (P[3 * i] >= mid[0] ? 1 : 0) | (P[3 * i + 1] >= mid[1] ? 2 : 0) | (P[3 * i + 2] >= mid[2] ? 4 : 0);
        (kids.get(b) ?? kids.set(b, []).get(b)).push(i);
      }
      for (const [b, list] of kids) stack.push({ l: t.l + 1, x: 2 * t.x + (b & 1), y: 2 * t.y + ((b >> 1) & 1), z: 2 * t.z + ((b >> 2) & 1), idx: Uint32Array.from(list) });
    }
  }
  const files = {};
  // Content: one pnts per tile, positions relative to the tile centre.
  for (const [key, idx] of tiles) {
    const [l, x, y, z] = key.split('/').map(Number);
    const size = (2 * half) / 2 ** l;
    const tc = [c[0] - half + (x + 0.5) * size, c[1] - half + (y + 0.5) * size, c[2] - half + (z + 0.5) * size];
    const pos = new Float64Array(3 * idx.length);
    idx.forEach((i, j) => pos.set([P[3 * i], P[3 * i + 1], P[3 * i + 2]], 3 * j));
    const cs = points.colorSize ?? 3;
    const col = points.colors ? Uint8Array.from({ length: cs * idx.length }, (_, q) => points.colors[cs * idx[Math.floor(q / cs)] + (q % cs)]) : null;
    const batch = points.batch ? Object.fromEntries(Object.entries(points.batch).map(([k, arr]) => [k, arr.constructor.from(idx, (i) => arr[i])])) : null;
    files[`content/${l}/${x}/${y}/${z}.pnts`] = writePnts({ positions: pos, colors: col, colorSize: cs, batch }, { rtc: tc, quantize });
  }
  // Subtrees.
  const S = Math.min(subtreeLevels, levels);
  const nodes = (8 ** S - 1) / 7;
  const has = (l, x, y, z) => tiles.has(`${l}/${x}/${y}/${z}`);
  // A tile is available if it or a descendant holds points (tiles always exist down to a content tile here).
  const avail = new Set();
  for (const key of tiles.keys()) {
    let [l, x, y, z] = key.split('/').map(Number);
    while (l >= 0) {
      avail.add(`${l}/${x}/${y}/${z}`);
      [l, x, y, z] = [l - 1, x >> 1, y >> 1, z >> 1];
    }
  }
  const isAvail = (l, x, y, z) => avail.has(`${l}/${x}/${y}/${z}`);
  let subtrees = 0;
  const writeSub = (L, X, Y, Z) => {
    const tileBits = new Uint8Array(Math.ceil(nodes / 8));
    const contBits = new Uint8Array(Math.ceil(nodes / 8));
    const childBits = new Uint8Array(Math.ceil(8 ** S / 8));
    let tc = 0;
    let cc = 0;
    let chc = 0;
    for (let ll = 0; ll < S; ll++) {
      const d = 2 ** ll;
      for (let lx = 0; lx < d; lx++)
        for (let ly = 0; ly < d; ly++)
          for (let lz = 0; lz < d; lz++) {
            const g = [L + ll, X * d + lx, Y * d + ly, Z * d + lz];
            const i = (8 ** ll - 1) / 7 + morton3(lx, ly, lz);
            if (isAvail(...g)) {
              tileBits[i >> 3] |= 1 << (i & 7);
              tc++;
            }
            if (has(...g)) {
              contBits[i >> 3] |= 1 << (i & 7);
              cc++;
            }
          }
    }
    const d = 2 ** S;
    const children = [];
    for (let lx = 0; lx < d; lx++)
      for (let ly = 0; ly < d; ly++)
        for (let lz = 0; lz < d; lz++) {
          const g = [L + S, X * d + lx, Y * d + ly, Z * d + lz];
          if (g[0] < levels && isAvail(...g)) {
            const i = morton3(lx, ly, lz);
            childBits[i >> 3] |= 1 << (i & 7);
            chc++;
            children.push(g);
          }
        }
    const views = [];
    const parts = [];
    const avField = (bits, count, total) => {
      if (count === 0) return { constant: 0 };
      if (count === total) return { constant: 1 };
      views.push({ buffer: 0, byteOffset: parts.reduce((s, p) => s + p.byteLength + pad(p.byteLength), 0), byteLength: bits.length });
      parts.push(bits);
      return { bitstream: views.length - 1, availableCount: count };
    };
    const json = { tileAvailability: avField(tileBits, tc, nodes), contentAvailability: [avField(contBits, cc, nodes)], childSubtreeAvailability: avField(childBits, chc, 8 ** S) };
    const { bin } = binPadded(parts);
    if (bin.length) {
      json.buffers = [{ byteLength: bin.length }];
      json.bufferViews = views;
    }
    const jb = jsonBytes(json, 24);
    const out = new Uint8Array(24 + jb.length + bin.length);
    const dv = new DataView(out.buffer);
    out.set(te.encode('subt'), 0);
    dv.setUint32(4, 1, true);
    dv.setBigUint64(8, BigInt(jb.length), true);
    dv.setBigUint64(16, BigInt(bin.length), true);
    out.set(jb, 24);
    out.set(bin, 24 + jb.length);
    files[`subtrees/${L}.${X}.${Y}.${Z}.subtree`] = out;
    subtrees++;
    for (const g of children) writeSub(...g);
  };
  writeSub(0, 0, 0, 0);
  const ge = half * 2 * 0.05 * 2; // about 5 % of the diagonal at the root, halving per level
  const tileset = {
    asset: { version: '1.1', generator: 'GIS Workbench' },
    geometricError: ge * 2,
    root: {
      transform: enuToEcef(origin.lat, origin.lon, origin.h ?? 0),
      boundingVolume: { box: [...c, half, 0, 0, 0, half, 0, 0, 0, half] },
      geometricError: ge,
      refine: 'ADD',
      content: { uri: 'content/{level}/{x}/{y}/{z}.pnts' },
      implicitTiling: { subdivisionScheme: 'OCTREE', subtreeLevels: S, availableLevels: levels, subtrees: { uri: 'subtrees/{level}.{x}.{y}.{z}.subtree' } },
    },
  };
  files['tileset.json'] = te.encode(JSON.stringify(tileset, null, 1));
  return { files, tileset, stats: { points: n, tiles: tiles.size, levels, subtrees } };
}

/** A one-tile explicit tileset around a content file (b3dm/pnts/i3dm/cmpt) in an ENU frame at `origin`. */
export function singleTileTileset(uri, origin, box, { geometricError = 0 } = {}) {
  return {
    asset: { version: '1.0', generator: 'GIS Workbench' },
    geometricError: Math.max(geometricError, 1),
    root: { transform: enuToEcef(origin.lat, origin.lon, origin.h ?? 0), boundingVolume: { box }, geometricError, refine: 'ADD', content: { uri } },
  };
}

/** ZIP of a tileset folder (deflated; ZIP of a folder for any server or this app). */
export const zipTileset = (files, folder) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${folder}/${k}`, v])));

/**
 * .3tz (OGC CS 22-025): entries stored, then `@3dtilesIndex1@` last, the MD5 of each path with
 * its local-header offset, sorted by the hash as two little-endian uint64 halves (bytes 0–7 first).
 * `md5(bytes)` → Uint8Array(16) (node:crypto or a JS MD5).
 */
export function write3tz(files, md5) {
  const names = Object.keys(files).sort((a, b) => (a === 'tileset.json' ? -1 : b === 'tileset.json' ? 1 : a.localeCompare(b)));
  const ordered = Object.fromEntries(names.map((k) => [k, [files[k], { level: 0 }]]));
  const zip = zipSync(ordered);
  // Local header offsets, by walking the local headers in order.
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const offsets = [];
  let o = 0;
  for (let i = 0; i < names.length; i++) {
    if (dv.getUint32(o, true) !== 0x04034b50) throw new Error('3tz: unexpected ZIP layout');
    offsets.push(o);
    const csize = dv.getUint32(o + 18, true);
    const nl = dv.getUint16(o + 26, true);
    const xl = dv.getUint16(o + 28, true);
    o += 30 + nl + xl + csize;
  }
  const idx = names.map((n, i) => ({ h: md5(te.encode(n)), off: offsets[i] }));
  // The order 3d-tiles-tools / 3d-tiles-validator search with: bytes 0–7 as a little-endian
  // uint64 first, then bytes 8–15.
  const key = (h) => {
    const d = new DataView(h.buffer, h.byteOffset, 16);
    return [d.getBigUint64(0, true), d.getBigUint64(8, true)];
  };
  idx.sort((a, b) => {
    const [ah, al] = key(a.h);
    const [bh, bl] = key(b.h);
    return ah < bh ? -1 : ah > bh ? 1 : al < bl ? -1 : al > bl ? 1 : 0;
  });
  const index = new Uint8Array(24 * idx.length);
  const iv = new DataView(index.buffer);
  idx.forEach((e, i) => {
    index.set(e.h, 24 * i);
    iv.setBigUint64(24 * i + 16, BigInt(e.off), true);
  });
  return zipSync({ ...ordered, '@3dtilesIndex1@': [index, { level: 0 }] });
}

/** MD5 of bytes (RFC 1321): the .3tz index needs it and Web Crypto has none. */
export function md5(bytes) {
  const K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const n = bytes.length;
  const len = (((n + 8) >> 6) + 1) << 6;
  const m = new Uint8Array(len);
  m.set(bytes);
  m[n] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(len - 8, (n * 8) >>> 0, true);
  dv.setUint32(len - 4, Math.floor((n * 8) / 2 ** 32), true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let o = 0; o < len; o += 64) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const t = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + dv.getUint32(o + 4 * g, true)) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
      a = t;
    }
    [a0, b0, c0, d0] = [(a0 + a) >>> 0, (b0 + b) >>> 0, (c0 + c) >>> 0, (d0 + d) >>> 0];
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(4 * i, v, true));
  return out;
}
