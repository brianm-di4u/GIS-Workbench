// 3D Tiles binary content (REQ-FMT-36, FC-10..FC-13): headers, feature tables and batch tables of
// b3dm, pnts, i3dm and cmpt, and implicit-tiling subtrees. Pure functions over untrusted bytes:
// every length and offset is checked against the buffer before it is used (REQ-SEC-02), and a
// malformed tile fails with a named error, never a DataView RangeError or a runaway allocation.
// Decoding to three.js objects is in tiles3d.js.

import { N_, en } from '../i18n/index.js';
import { Msg } from '../workers/errors.js';

const td = new TextDecoder();
const MAX_COUNT = 1 << 26; // 67 M points / instances per tile: anything above is a damaged header.

export class TileError extends Error {}
const WRAP = N_('{what}: {msg}');
/**
 * Throw a TileError: the English message as before ("b3dm: version 2 is not 1"), with its key
 * (REQ-L10N-05) so msgOf shows it in the UI language; `what` names the part and stays as it is.
 */
const fail = (what, src, params = null) => {
  const e = new TileError(`${what}: ${en(src, params)}`);
  e.i18n = { src: WRAP, params: { what, msg: new Msg(src, params) } };
  e.code = 'E_TILE_INVALID';
  throw e;
};

/** Four-character magic of a tile ('b3dm', 'pnts', 'i3dm', 'cmpt', 'glTF', 'subt', '{' for JSON) or ''. */
export function tileMagic(b) {
  if (!b || b.length < 4) return '';
  if (b[0] === 0x7b) return '{';
  return String.fromCharCode(b[0], b[1], b[2], b[3]);
}

const dvOf = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function json(b, off, len, what) {
  if (!len) return {};
  if (off + len > b.length) fail(what, N_('JSON runs past the end of the tile'));
  // JSON is padded with spaces (and some writers with NULs).
  const text = td.decode(b.subarray(off, off + len)).replace(/[\0\s]+$/, '');
  if (!text) return {};
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || Array.isArray(j)) fail(what, N_('JSON is not an object'));
    return j;
  } catch (e) {
    if (e instanceof TileError) throw e;
    fail(what, N_('JSON is malformed ({detail})'), { detail: String(e.message) });
  }
}

/**
 * The tile header and its four tables: {magic, version, byteLength, ft: {json, bin}, bt: {json, bin}, body}.
 * Handles the two legacy b3dm headers (batchLength in the header; Cesium's rules).
 */
export function parseTileHeader(b, magic = tileMagic(b)) {
  const what = `3D Tiles ${magic}`;
  const head = magic === 'i3dm' ? 32 : 28;
  if (b.length < head) fail(what, N_('tile is {size} bytes, shorter than its {head}-byte header'), { size: String(b.length), head: String(head) });
  const dv = dvOf(b);
  const version = dv.getUint32(4, true);
  const byteLength = dv.getUint32(8, true);
  if (version !== 1) fail(what, N_('version {version} is not 1'), { version: String(version) });
  if (byteLength > b.length) fail(what, N_('header says {byteLength} bytes; the tile has {size}'), { byteLength: String(byteLength), size: String(b.length) });
  let [ftJ, ftB, btJ, btB] = [12, 16, 20, 24].map((o) => dv.getUint32(o, true));
  let off = head;
  let batchLength;
  if (magic === 'b3dm' && btJ >= 570425344) {
    // Legacy 1: [batchLength][batchTableByteLength] (20-byte header).
    off = 20;
    batchLength = ftJ;
    btJ = ftB;
    ftJ = ftB = btB = 0;
  } else if (magic === 'b3dm' && btB >= 570425344) {
    // Legacy 2: [batchTableJsonByteLength][batchTableBinaryByteLength][batchLength] (24-byte header).
    off = 24;
    batchLength = btJ;
    btJ = ftJ;
    btB = ftB;
    ftJ = ftB = 0;
  }
  const total = off + ftJ + ftB + btJ + btB;
  if (total > byteLength) fail(what, N_('table lengths ({tables} bytes) run past the tile ({byteLength} bytes)'), { tables: String(ftJ + ftB + btJ + btB), byteLength: String(byteLength) });
  const ft = { json: json(b, off, ftJ, `${what} feature table`), bin: b.subarray(off + ftJ, off + ftJ + ftB) };
  off += ftJ + ftB;
  const bt = { json: json(b, off, btJ, `${what} batch table`), bin: b.subarray(off + btJ, off + btJ + btB) };
  off += btJ + btB;
  if (batchLength !== undefined && ft.json.BATCH_LENGTH === undefined) ft.json.BATCH_LENGTH = batchLength;
  return { magic, version, byteLength, ft, bt, body: b.subarray(off, byteLength), gltfFormat: magic === 'i3dm' ? dv.getUint32(28, true) : undefined };
}

const COMPONENTS = {
  BYTE: [Int8Array, 1],
  UNSIGNED_BYTE: [Uint8Array, 1],
  SHORT: [Int16Array, 2],
  UNSIGNED_SHORT: [Uint16Array, 2],
  INT: [Int32Array, 4],
  UNSIGNED_INT: [Uint32Array, 4],
  FLOAT: [Float32Array, 4],
  DOUBLE: [Float64Array, 8],
};
const SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** A typed array of `count × size` values from a table's binary body (copied: unaligned offsets are legal). */
function binArray(bin, ref, count, size, componentType, what) {
  const ct = COMPONENTS[componentType];
  if (!ct) fail(what, N_('component type {componentType} is not known'), { componentType: String(componentType) });
  const off = ref.byteOffset ?? 0;
  if (!Number.isInteger(off) || off < 0) fail(what, N_('byteOffset {off} is not valid'), { off: String(off) });
  const n = count * size;
  if (!Number.isSafeInteger(n) || n > MAX_COUNT * 16) fail(what, N_('{count} values is not a valid count'), { count: String(count) });
  const bytes = n * ct[1];
  if (off + bytes > bin.length) fail(what, N_('{bytes} bytes at offset {off} run past the {body}-byte binary body'), { bytes: String(bytes), off: String(off), body: String(bin.length) });
  const copy = bin.slice(off, off + bytes);
  return new ct[0](copy.buffer, copy.byteOffset, n);
}

/**
 * A feature-table property: per-feature values in the binary body ({byteOffset}) or the JSON (an
 * array), or undefined when absent. `size` components of `componentType` (default per semantic).
 */
export function ftProperty(ft, name, count, size, componentType, what) {
  const p = ft.json[name];
  if (p === undefined || p === null) return undefined;
  if (Array.isArray(p)) {
    if (p.length < count * size) fail(what, N_('{name} has {got} values, needs {needed}'), { name: String(name), got: String(p.length), needed: String(count * size) });
    const ct = COMPONENTS[componentType] ?? COMPONENTS.FLOAT;
    return ct[0].from(p.slice(0, count * size), Number);
  }
  if (typeof p === 'object') return binArray(ft.bin, p, count, size, p.componentType ?? componentType, `${what} ${name}`);
  fail(what, N_('{name} is neither an array nor a binary reference'), { name: String(name) });
}

/** A global value (a number, an array of `size` numbers, or a binary reference). */
export function ftGlobal(ft, name, size, componentType = 'FLOAT', what = 'feature table') {
  const p = ft.json[name];
  if (p === undefined || p === null) return undefined;
  if (typeof p === 'number' || typeof p === 'boolean') return p;
  if (Array.isArray(p)) {
    if (p.length < size || p.slice(0, size).some((x) => typeof x !== 'number' || !Number.isFinite(x))) fail(what, N_('{name} must hold {size} numbers'), { name: String(name), size: String(size) });
    return p.slice(0, size);
  }
  if (typeof p === 'object') {
    const a = binArray(ft.bin, p, 1, size, p.componentType ?? componentType, `${what} ${name}`);
    return size === 1 ? a[0] : [...a];
  }
  return undefined;
}

const count = (ft, name, what) => {
  const n = ftGlobal(ft, name, 1, 'UNSIGNED_INT', what);
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) fail(what, N_('{name} {n} is missing or out of range'), { name: String(name), n: String(n) });
  return n;
};

/** Batch-table properties: {name: values[] (JSON) or typed array (binary)}; skips extensions/hierarchy. */
export function batchTable(bt, length, what) {
  const out = {};
  for (const [k, v] of Object.entries(bt.json ?? {})) {
    if (k === 'extensions' || k === 'extras') continue;
    if (Array.isArray(v)) out[k] = v.slice(0, length);
    else if (v && typeof v === 'object' && v.byteOffset !== undefined && SIZE[v.type]) {
      try {
        out[k] = { size: SIZE[v.type], values: binArray(bt.bin, v, length, SIZE[v.type], v.componentType, `${what} batch table ${k}`) };
      } catch (e) {
        if (!(e instanceof TileError)) throw e;
        out[k] = { error: e.message };
      }
    }
  }
  return out;
}

/** Oct-encoded unit vector (range 255 for OCT16P, 65535 for OCT32P) → [x, y, z]. */
export function octDecode(u, v, range) {
  let x = (u / range) * 2 - 1;
  let y = (v / range) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/**
 * pnts → {count, positions: Float32Array (tile frame, relative to rtc), rtc, colors?: Uint8Array RGBA
 * or RGB (n × 4 / 3), colorSize, normals?: Float32Array, batchIds?, batchLength, constantRgba, batch,
 * draco?: {properties, bytes, batchProperties}}. Draco-compressed attributes are returned as the
 * compressed buffer and the attribute ids; the caller decodes them (tiles3d.js).
 */
export function parsePnts(b) {
  const what = '3D Tiles pnts';
  const t = parseTileHeader(b, 'pnts');
  const ft = t.ft;
  const n = count(ft, 'POINTS_LENGTH', what);
  const rtc = ftGlobal(ft, 'RTC_CENTER', 3, 'FLOAT', what) ?? null;
  const out = { count: n, rtc, colors: null, colorSize: 0, normals: null, batchIds: null, constantRgba: ftGlobal(ft, 'CONSTANT_RGBA', 4, 'UNSIGNED_BYTE', what) ?? null, draco: null };
  const dr = ft.json.extensions?.['3DTILES_draco_point_compression'];
  if (dr) {
    const off = dr.byteOffset ?? 0;
    const len = dr.byteLength ?? 0;
    if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len <= 0 || off + len > ft.bin.length) fail(what, N_('the Draco buffer runs past the feature table'));
    const props = dr.properties ?? {};
    if (!Object.values(props).every((x) => Number.isInteger(x) && x >= 0)) fail(what, N_('Draco attribute ids are not integers'));
    out.draco = { properties: props, bytes: ft.bin.slice(off, off + len), batchProperties: t.bt.json?.extensions?.['3DTILES_draco_point_compression']?.properties ?? {} };
  }
  const inDraco = (k) => out.draco && out.draco.properties[k] !== undefined;
  if (ft.json.POSITION !== undefined && !inDraco('POSITION')) out.positions = ftProperty(ft, 'POSITION', n, 3, 'FLOAT', what);
  else if (ft.json.POSITION_QUANTIZED !== undefined && !inDraco('POSITION_QUANTIZED')) {
    const q = ftProperty(ft, 'POSITION_QUANTIZED', n, 3, 'UNSIGNED_SHORT', what);
    out.positions = dequantize(q, ft, what);
  } else if (inDraco('POSITION') || inDraco('POSITION_QUANTIZED')) {
    out.positions = null; // decoded from Draco
    if (inDraco('POSITION_QUANTIZED')) out.quantized = { offset: ftGlobal(ft, 'QUANTIZED_VOLUME_OFFSET', 3, 'FLOAT', what), scale: ftGlobal(ft, 'QUANTIZED_VOLUME_SCALE', 3, 'FLOAT', what) };
  } else fail(what, N_('no POSITION or POSITION_QUANTIZED'));
  if (ft.json.RGBA !== undefined && !inDraco('RGBA')) [out.colors, out.colorSize] = [ftProperty(ft, 'RGBA', n, 4, 'UNSIGNED_BYTE', what), 4];
  else if (ft.json.RGB !== undefined && !inDraco('RGB')) [out.colors, out.colorSize] = [ftProperty(ft, 'RGB', n, 3, 'UNSIGNED_BYTE', what), 3];
  else if (ft.json.RGB565 !== undefined && !inDraco('RGB565')) {
    const c = ftProperty(ft, 'RGB565', n, 1, 'UNSIGNED_SHORT', what);
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = c[i];
      rgb[3 * i] = Math.round((((v >> 11) & 31) * 255) / 31);
      rgb[3 * i + 1] = Math.round((((v >> 5) & 63) * 255) / 63);
      rgb[3 * i + 2] = Math.round(((v & 31) * 255) / 31);
    }
    [out.colors, out.colorSize] = [rgb, 3];
  }
  if (ft.json.NORMAL !== undefined && !inDraco('NORMAL')) out.normals = ftProperty(ft, 'NORMAL', n, 3, 'FLOAT', what);
  else if (ft.json.NORMAL_OCT16P !== undefined && !inDraco('NORMAL_OCT16P')) {
    const o = ftProperty(ft, 'NORMAL_OCT16P', n, 2, 'UNSIGNED_BYTE', what);
    out.normals = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) out.normals.set(octDecode(o[2 * i], o[2 * i + 1], 255), 3 * i);
  }
  if (ft.json.BATCH_ID !== undefined && !inDraco('BATCH_ID')) out.batchIds = ftProperty(ft, 'BATCH_ID', n, 1, 'UNSIGNED_SHORT', what);
  out.batchLength = ft.json.BATCH_LENGTH !== undefined ? count(ft, 'BATCH_LENGTH', what) : out.batchIds || inDraco('BATCH_ID') ? 0 : n;
  if (out.batchIds && !out.batchLength) for (const id of out.batchIds) out.batchLength = Math.max(out.batchLength, id + 1);
  out.batch = batchTable(t.bt, out.batchLength, what);
  return out;
}

function dequantize(q, ft, what) {
  const off = ftGlobal(ft, 'QUANTIZED_VOLUME_OFFSET', 3, 'FLOAT', what);
  const sc = ftGlobal(ft, 'QUANTIZED_VOLUME_SCALE', 3, 'FLOAT', what);
  if (!off || !sc) fail(what, N_('POSITION_QUANTIZED needs QUANTIZED_VOLUME_OFFSET and QUANTIZED_VOLUME_SCALE'));
  const p = new Float32Array(q.length);
  for (let i = 0; i < q.length; i += 3) for (let k = 0; k < 3; k++) p[i + k] = (q[i + k] / 65535) * sc[k] + off[k];
  return p;
}

/**
 * i3dm → {count, rtc, gltf: {uri} | {bytes}, positions: Float64Array (tile frame), up, right
 * (Float32Array or null), scale, scaleNonUniform, eastNorthUp, batchIds, batch}.
 */
export function parseI3dm(b) {
  const what = '3D Tiles i3dm';
  const t = parseTileHeader(b, 'i3dm');
  const ft = t.ft;
  const n = count(ft, 'INSTANCES_LENGTH', what);
  const out = { count: n, rtc: ftGlobal(ft, 'RTC_CENTER', 3, 'FLOAT', what) ?? null, eastNorthUp: !!ft.json.EAST_NORTH_UP, up: null, right: null, scale: null, scaleNonUniform: null, batchIds: null };
  if (t.gltfFormat === 0) {
    const uri = td.decode(t.body).replace(/[\0\s]+$/, '').trim();
    if (!uri) fail(what, N_('the glTF URI is empty'));
    out.gltf = { uri };
  } else if (t.gltfFormat === 1) {
    if (t.body.length < 12) fail(what, N_('the embedded glTF is empty'));
    out.gltf = { bytes: t.body };
  } else fail(what, N_('gltfFormat {gltfFormat} is not 0 or 1'), { gltfFormat: String(t.gltfFormat) });
  if (ft.json.POSITION !== undefined) out.positions = Float64Array.from(ftProperty(ft, 'POSITION', n, 3, 'FLOAT', what));
  else if (ft.json.POSITION_QUANTIZED !== undefined) out.positions = Float64Array.from(dequantize(ftProperty(ft, 'POSITION_QUANTIZED', n, 3, 'UNSIGNED_SHORT', what), ft, what));
  else fail(what, N_('no POSITION or POSITION_QUANTIZED'));
  if (ft.json.NORMAL_UP !== undefined && ft.json.NORMAL_RIGHT !== undefined) {
    out.up = ftProperty(ft, 'NORMAL_UP', n, 3, 'FLOAT', what);
    out.right = ftProperty(ft, 'NORMAL_RIGHT', n, 3, 'FLOAT', what);
  } else if (ft.json.NORMAL_UP_OCT32P !== undefined && ft.json.NORMAL_RIGHT_OCT32P !== undefined) {
    const u = ftProperty(ft, 'NORMAL_UP_OCT32P', n, 2, 'UNSIGNED_SHORT', what);
    const r = ftProperty(ft, 'NORMAL_RIGHT_OCT32P', n, 2, 'UNSIGNED_SHORT', what);
    out.up = new Float32Array(3 * n);
    out.right = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      out.up.set(octDecode(u[2 * i], u[2 * i + 1], 65535), 3 * i);
      out.right.set(octDecode(r[2 * i], r[2 * i + 1], 65535), 3 * i);
    }
  }
  if (ft.json.SCALE !== undefined) out.scale = ftProperty(ft, 'SCALE', n, 1, 'FLOAT', what);
  if (ft.json.SCALE_NON_UNIFORM !== undefined) out.scaleNonUniform = ftProperty(ft, 'SCALE_NON_UNIFORM', n, 3, 'FLOAT', what);
  if (ft.json.BATCH_ID !== undefined) out.batchIds = ftProperty(ft, 'BATCH_ID', n, 1, 'UNSIGNED_SHORT', what);
  let len = n;
  if (out.batchIds) {
    len = 0;
    for (const id of out.batchIds) len = Math.max(len, id + 1);
  }
  out.batchLength = len;
  out.batch = batchTable(t.bt, len, what);
  return out;
}

/** b3dm → {rtc, glb, batchLength, batch}. */
export function parseB3dm(b) {
  const what = '3D Tiles b3dm';
  const t = parseTileHeader(b, 'b3dm');
  const n = t.ft.json.BATCH_LENGTH !== undefined ? count(t.ft, 'BATCH_LENGTH', what) : 0;
  if (t.body.length < 12) fail(what, N_('the embedded glTF is empty'));
  return { rtc: ftGlobal(t.ft, 'RTC_CENTER', 3, 'FLOAT', what) ?? null, glb: t.body, batchLength: n, batch: batchTable(t.bt, n, what) };
}

/** cmpt → the inner tiles' bytes (each a b3dm/pnts/i3dm/cmpt), checked against the composite's length. */
export function parseCmpt(b, depth = 0) {
  const what = '3D Tiles cmpt';
  if (b.length < 16) fail(what, N_('tile is {size} bytes, shorter than its 16-byte header'), { size: String(b.length) });
  if (depth > 8) fail(what, N_('composites are nested more than 8 deep'));
  const dv = dvOf(b);
  const version = dv.getUint32(4, true);
  const byteLength = dv.getUint32(8, true);
  const tilesLength = dv.getUint32(12, true);
  if (version !== 1) fail(what, N_('version {version} is not 1'), { version: String(version) });
  if (byteLength > b.length) fail(what, N_('header says {byteLength} bytes; the tile has {size}'), { byteLength: String(byteLength), size: String(b.length) });
  if (tilesLength > (byteLength - 16) / 12) fail(what, N_('{tilesLength} inner tiles cannot fit in {byteLength} bytes'), { tilesLength: String(tilesLength), byteLength: String(byteLength) });
  const tiles = [];
  let off = 16;
  for (let i = 0; i < tilesLength; i++) {
    if (off + 12 > byteLength) fail(what, N_('inner tile {i} starts past the end'), { i: String(i) });
    const len = dv.getUint32(off + 8, true);
    if (len < 12 || off + len > byteLength) fail(what, N_('inner tile {i} ({len} bytes at {off}) runs past the composite'), { i: String(i), len: String(len), off: String(off) });
    tiles.push(b.subarray(off, off + len));
    off += len;
  }
  return tiles;
}

// ---- implicit tiling (3D Tiles 1.1 / 3DTILES_implicit_tiling) ----

/** The subtree's JSON and its internal binary buffer: binary .subtree ('subt') or JSON subtree. */
export function parseSubtreeHeader(b) {
  const what = '3D Tiles subtree';
  if (tileMagic(b) === '{') return { json: json(b, 0, b.length, what), bin: new Uint8Array(0) };
  if (tileMagic(b) !== 'subt') fail(what, N_('not a subtree file (magic is not "subt")'));
  if (b.length < 24) fail(what, N_('shorter than its 24-byte header'));
  const dv = dvOf(b);
  const version = dv.getUint32(4, true);
  if (version !== 1) fail(what, N_('version {version} is not 1'), { version: String(version) });
  const jl = Number(dv.getBigUint64(8, true));
  const bl = Number(dv.getBigUint64(16, true));
  if (!Number.isSafeInteger(jl) || !Number.isSafeInteger(bl) || 24 + jl + bl > b.length) fail(what, N_('JSON ({jl}) and binary ({bl}) lengths run past the {size}-byte file'), { jl: String(jl), bl: String(bl), size: String(b.length) });
  return { json: json(b, 24, jl, what), bin: b.subarray(24 + jl, 24 + jl + bl) };
}

/**
 * A subtree's availability: {tile(i), content(i, k), child(i)} bit tests over Morton indices.
 * `loadBuffer(uri)` fetches external buffers (resolves to Uint8Array). levels = subtreeLevels;
 * branching 4 or 8.
 */
export async function parseSubtree(b, { levels, branching, loadBuffer }) {
  const what = '3D Tiles subtree';
  const { json: j, bin } = parseSubtreeHeader(b);
  const buffers = [];
  for (const [i, buf] of (j.buffers ?? []).entries()) {
    if (buf.uri) {
      const ext = await loadBuffer(buf.uri);
      if (!(ext instanceof Uint8Array)) fail(what, N_('buffer {i} ({uri}) did not load'), { i: String(i), uri: String(buf.uri) });
      buffers.push(ext);
    } else buffers.push(bin);
  }
  const views = (j.bufferViews ?? []).map((v, i) => {
    const buf = buffers[v.buffer];
    const off = v.byteOffset ?? 0;
    if (!buf || !Number.isInteger(off) || !Number.isInteger(v.byteLength) || off < 0 || off + v.byteLength > buf.length) fail(what, N_('buffer view {i} runs past its buffer'), { i: String(i) });
    return buf.subarray(off, off + v.byteLength);
  });
  const nodes = branching === 8 ? (8 ** levels - 1) / 7 : (4 ** levels - 1) / 3;
  const nextLevel = branching ** levels;
  const bits = (a, n, name) => {
    if (!a) return () => false;
    if (a.constant !== undefined) return () => a.constant === 1;
    const view = views[a.bitstream ?? a.bufferView];
    if (!view) fail(what, N_('{name} names a missing buffer view'), { name: String(name) });
    if (view.length * 8 < n) fail(what, N_('{name} has {bits} bits, needs {n}'), { name: String(name), bits: String(view.length * 8), n: String(n) });
    return (i) => i >= 0 && i < n && ((view[i >> 3] >> (i & 7)) & 1) === 1;
  };
  const tile = bits(j.tileAvailability, nodes, 'tileAvailability');
  const ca = Array.isArray(j.contentAvailability) ? j.contentAvailability : j.contentAvailability ? [j.contentAvailability] : [];
  const contents = ca.map((a, k) => bits(a, nodes, `contentAvailability[${k}]`));
  // A tile with no content-availability entry (none given at all) has content when it is available
  // and the tileset names a content template (3DTILES_implicit_tiling 1.0 drafts).
  const content = (i, k = 0) => (contents.length ? !!contents[k]?.(i) : tile(i));
  const child = bits(j.childSubtreeAvailability, nextLevel, 'childSubtreeAvailability');
  return { tile, content, child, contentCount: Math.max(1, contents.length), json: j };
}

/** Morton (Z-order) index of (x, y[, z]). */
export function morton(x, y, z) {
  let m = 0;
  const dims = z === undefined ? 2 : 3;
  for (let i = 0; i < 21; i++) {
    const bit = 1 << i;
    const s = i * dims;
    m += (x & bit ? 1 : 0) * 2 ** s + (y & bit ? 1 : 0) * 2 ** (s + 1) + (dims === 3 && z & bit ? 1 : 0) * 2 ** (s + 2);
  }
  return m;
}

/** Index of tile (level, x, y[, z]) (all local to its subtree) in the availability bitstream. */
export function subtreeIndex(level, x, y, z, branching) {
  const off = branching === 8 ? (8 ** level - 1) / 7 : (4 ** level - 1) / 3;
  return off + morton(x, y, branching === 8 ? z : undefined);
}

/** Fill a URI template ({level}, {x}, {y}, {z}). */
export const fillTemplate = (t, c) => String(t).replace(/\{(level|x|y|z)\}/g, (m, k) => String(c[k] ?? 0));

/** Bounding volume of implicit tile (level, x, y, z) inside the root volume (box or region). */
export function implicitVolume(bv, level, x, y, z, octree) {
  const d = 2 ** level;
  if (bv.region) {
    const [w, s, e, n, h0, h1] = bv.region;
    const dx = (e - w) / d;
    const dy = (n - s) / d;
    const dz = octree ? (h1 - h0) / d : h1 - h0;
    const zz = octree ? z : 0;
    return { region: [w + x * dx, s + y * dy, w + (x + 1) * dx, s + (y + 1) * dy, h0 + zz * dz, h0 + (zz + 1) * dz] };
  }
  if (bv.box) {
    const b = bv.box;
    const c = [b[0], b[1], b[2]];
    const u = [b[3], b[4], b[5]];
    const v = [b[6], b[7], b[8]];
    const w = [b[9], b[10], b[11]];
    const fu = (2 * x + 1) / d - 1;
    const fv = (2 * y + 1) / d - 1;
    const fw = octree ? (2 * z + 1) / d - 1 : 0;
    const centre = [0, 1, 2].map((k) => c[k] + u[k] * fu + v[k] * fv + w[k] * fw);
    const sw = octree ? 1 / d : 1;
    return { box: [...centre, ...u.map((q) => q / d), ...v.map((q) => q / d), ...w.map((q) => q * sw)] };
  }
  throw new TileError('3D Tiles implicit tiling: the root bounding volume must be a box or a region');
}
