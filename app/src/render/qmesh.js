// Quantized-mesh terrain (REQ-ARC-16, REQ-FMT-38, FC-14, IMP-20): Cesium quantized-mesh-1.0 tiles
// from an online source or a local folder / ZIP (layer.json + {z}/{x}/{y}.terrain, TMS), in the
// geographic EPSG:4326 tiling (two tiles at level 0) or the Web Mercator EPSG:3857 tiling (one tile
// at level 0). A tile is a header (centre, height range, bounding sphere, horizon point), zig-zag
// delta encoded u/v/height vertex arrays (0…32767 over the tile), high-water-mark encoded triangle
// indices, edge lists and extensions: oct-encoded vertex normals (1), water mask (2) and metadata
// (4, with child availability). layer.json `available` ranges choose the tiles that exist.
// Every length is checked against the tile (REQ-SEC-02). Vertices go to the 3D view's local frame.

import { gwError } from '../i18n/index.js';

const zz = (v) => (v >> 1) ^ -(v & 1);
const MERC_R = 6378137;
const MERC_MAX = Math.PI * MERC_R; // 20037508.34 m

export class QmError extends Error {}
const fail = (m) => {
  throw new QmError(`quantized-mesh tile: ${m}`);
};

/**
 * One tile's bytes → {vertices: [{lat, lon, h}], u, v, heights, indices: Uint32Array, min, max,
 * center, edges, normals?: Float32Array (ECEF unit vectors), watermask?, metadata?, extensions}.
 * `bounds` {west, south, east, north} in degrees; `mercator` interpolates v in Web Mercator y.
 * `extensions` false skips them.
 */
export function decodeQuantizedMesh(bytes, { west, south, east, north }, { mercator = false } = {}) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  if (len < 88 + 4) fail(`${len} bytes is shorter than the 92-byte header`);
  const center = [dv.getFloat64(0, true), dv.getFloat64(8, true), dv.getFloat64(16, true)];
  const minH = dv.getFloat32(24, true);
  const maxH = dv.getFloat32(28, true);
  if (!Number.isFinite(minH) || !Number.isFinite(maxH)) fail('the height range is not finite');
  let p = 88;
  const n = dv.getUint32(p, true);
  p += 4;
  if (n === 0 || n > 1 << 24 || p + n * 6 > len) fail(`${n} vertices run past the tile`);
  const u = new Uint16Array(n);
  const v = new Uint16Array(n);
  const hh = new Uint16Array(n);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    a += zz(dv.getUint16(p + 2 * i, true));
    b += zz(dv.getUint16(p + 2 * n + 2 * i, true));
    c += zz(dv.getUint16(p + 4 * n + 2 * i, true));
    u[i] = a;
    v[i] = b;
    hh[i] = c;
  }
  p += 6 * n;
  const wide = n > 65536;
  const size = wide ? 4 : 2;
  if (p % size) p += size - (p % size);
  if (p + 4 > len) fail('the triangle count runs past the tile');
  const tri = dv.getUint32(p, true);
  p += 4;
  if (tri > 1 << 25 || p + tri * 3 * size > len) fail(`${tri} triangles run past the tile`);
  const idx = new Uint32Array(tri * 3);
  let highest = 0;
  for (let i = 0; i < tri * 3; i++) {
    const code = wide ? dv.getUint32(p + 4 * i, true) : dv.getUint16(p + 2 * i, true);
    // Modulo the index width, as Cesium's decoder (a Uint16Array / Uint32Array store) does:
    // encoders that do not order vertices by first use (quantized-mesh-encoder) rely on it.
    const k = wide ? (highest - code) >>> 0 : (highest - code) & 0xffff;
    if (k >= n) fail('a triangle index is out of range');
    idx[i] = k;
    if (code === 0) highest++;
  }
  p += tri * 3 * size;
  // Edge vertex lists (west, south, east, north).
  const edges = {};
  for (const side of ['west', 'south', 'east', 'north']) {
    if (p + 4 > len) fail(`the ${side} edge list runs past the tile`);
    const m = dv.getUint32(p, true);
    p += 4;
    if (m > n || p + m * size > len) fail(`the ${side} edge list runs past the tile`);
    edges[side] = m;
    p += m * size;
  }
  // Extensions: [id u8][length u32][data].
  const ext = { list: [] };
  while (p + 5 <= len) {
    const id = dv.getUint8(p);
    const el = dv.getUint32(p + 1, true);
    p += 5;
    if (p + el > len) fail(`extension ${id} (${el} bytes) runs past the tile`);
    const data = bytes.subarray(p, p + el);
    if (id === 1) {
      if (el < 2 * n) fail('the oct-encoded normals are shorter than the vertex count');
      ext.normals = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) ext.normals.set(octDecode255(data[2 * i], data[2 * i + 1]), 3 * i);
      ext.list.push('octvertexnormals');
    } else if (id === 2) {
      if (el !== 1 && el !== 256 * 256) fail(`the water mask is ${el} bytes (1 or 65536 expected)`);
      ext.watermask = el === 1 ? data[0] : data.slice();
      ext.list.push('watermask');
    } else if (id === 4) {
      if (el < 4) fail('the metadata extension is too short');
      const jl = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
      if (4 + jl > el) fail('the metadata JSON runs past its extension');
      try {
        ext.metadata = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + jl)));
      } catch {
        fail('the metadata JSON is malformed');
      }
      ext.list.push('metadata');
    } else ext.list.push(`ext${id}`);
    p += el;
  }
  const vertices = [];
  const yS = mercator ? mercY(south) : 0;
  const yN = mercator ? mercY(north) : 0;
  for (let i = 0; i < n; i++) {
    const lon = west + (u[i] / 32767) * (east - west);
    const lat = mercator ? mercLat(yS + (v[i] / 32767) * (yN - yS)) : south + (v[i] / 32767) * (north - south);
    vertices.push({ lon, lat, h: minH + (hh[i] / 32767) * (maxH - minH) });
  }
  return { vertices, u, v, heights: hh, indices: idx, min: minH, max: maxH, center, edges, normals: ext.normals ?? null, watermask: ext.watermask ?? null, metadata: ext.metadata ?? null, extensions: ext.list };
}

function octDecode255(a, b) {
  let x = (a / 255) * 2 - 1;
  let y = (b / 255) * 2 - 1;
  const z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const ox = x;
    x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1);
    y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1);
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

const mercY = (lat) => MERC_R * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 360));
const mercLat = (y) => (Math.atan(Math.sinh(y / MERC_R)) * 180) / Math.PI;

/** Is a layer.json in Web Mercator? (`projection` EPSG:3857 / 900913; absent means EPSG:4326.) */
export const isMercator = (layer) => /3857|900913|mercator/i.test(String(layer?.projection ?? ''));

/** TMS tile bounds (degrees) at level z: geographic 2^(z+1) × 2^z tiles, or Web Mercator 2^z × 2^z. */
export function tileBounds(z, x, y, mercator = false) {
  if (mercator) {
    const s = (2 * MERC_MAX) / 2 ** z;
    return { west: ((-MERC_MAX + x * s) / MERC_MAX) * 180, east: ((-MERC_MAX + (x + 1) * s) / MERC_MAX) * 180, south: mercLat(-MERC_MAX + y * s), north: mercLat(-MERC_MAX + (y + 1) * s) };
  }
  const s = 180 / 2 ** z;
  return { west: -180 + x * s, east: -180 + (x + 1) * s, south: -90 + y * s, north: -90 + (y + 1) * s };
}

/** Tiles at level z covering a box [south, west, north, east]. */
export function tilesFor(z, [s, w, n, e], mercator = false) {
  const out = [];
  if (mercator) {
    const k = 2 ** z;
    const ty = (lat) => ((mercY(lat) + MERC_MAX) / (2 * MERC_MAX)) * k;
    const [x0, x1] = [Math.max(0, Math.floor(((w + 180) / 360) * k)), Math.min(k - 1, Math.floor(((e + 180) / 360) * k - 1e-12))];
    const [y0, y1] = [Math.max(0, Math.floor(ty(s))), Math.min(k - 1, Math.floor(ty(n) - 1e-12))];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    return out;
  }
  const sz = 180 / 2 ** z;
  for (let x = Math.floor((w + 180) / sz); x <= Math.floor((e + 180) / sz - 1e-12); x++) for (let y = Math.floor((s + 90) / sz); y <= Math.floor((n + 90) / sz - 1e-12); y++) out.push([z, x, y]);
  return out;
}

/** Is tile (z, x, y) inside the layer's `available` ranges? (No ranges for z: unknown → true.) */
export function isAvailable(available, z, x, y) {
  const ranges = available?.[z];
  if (!Array.isArray(ranges)) return true;
  return ranges.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
}

/** Deepest level of `available` (or -1). */
export const deepestAvailable = (available) => (Array.isArray(available) ? available.reduce((d, r, z) => (Array.isArray(r) && r.length ? z : d), -1) : -1);

/** Fill a tile URL template. */
export const tileUrl = (tmpl, z, x, y, version = '1.0.0') => tmpl.replace(/\{z\}/g, z).replace(/\{x\}/g, x).replace(/\{y\}/g, y).replace(/\{version\}/g, version);

/**
 * Load the tiles of a layer.json into the 3D view as terrain meshes. Either over a box [south,
 * west, north, east] at a level, or (local sets) the explicit `tiles` list [[z, x, y], …].
 */
export async function loadQuantizedMesh(view, layerUrl, fetch, { box, level = 12, maxTiles = 64, tiles = null, name = null } = {}) {
  const r = await fetch(layerUrl, { credentials: 'omit' });
  if (!r.ok) throw new Error(`${layerUrl}: HTTP ${r.status}`);
  const layer = await r.json();
  if (!/quantized-mesh/i.test(layer.format ?? '') && !layer.tiles) throw new Error('not a quantized-mesh layer.json');
  const mercator = isMercator(layer);
  if (layer.projection && !mercator && !/4326/.test(layer.projection)) throw gwError('terrain projection {projection} is not read (EPSG:4326 and EPSG:3857 only)', { projection: String(layer.projection) }, 'E_QMESH_PROJECTION');
  if (!Array.isArray(layer.tiles) || !layer.tiles.length) throw new Error('the layer.json names no tile URL template');
  let z = Math.min(level, layer.maxzoom ?? level);
  // The deepest level the `available` ranges list, when the request asks for deeper tiles.
  const deep = deepestAvailable(layer.available);
  if (deep >= 0 && z > deep && !layer.metadataAvailability) z = deep;
  if (!tiles) {
    if (!box) throw new Error('give a box or a list of tiles');
    tiles = tilesFor(z, box, mercator).filter(([tz, tx, ty]) => isAvailable(layer.available, tz, tx, ty));
    if (!tiles.length) throw gwError('no available tiles at level {z} over the box', { z: String(z) }, 'E_QMESH_NO_TILES');
  }
  if (tiles.length > maxTiles) throw gwError('{n, plural, one {# tile} other {# tiles}} at level {z}; choose a smaller box or a lower level', { n: tiles.length, z: String(z) }, 'E_QMESH_TOO_MANY');
  const T = view.T;
  const group = new T.Group();
  const stats = { tiles: 0, vertices: 0, triangles: 0, failed: 0, extensions: [], projection: mercator ? 'EPSG:3857' : 'EPSG:4326', min: Infinity, max: -Infinity, bounds: null };
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [tz, tx, ty] of tiles) {
    const b = tileBounds(tz, tx, ty, mercator);
    bb[0] = Math.min(bb[0], b.south);
    bb[1] = Math.min(bb[1], b.west);
    bb[2] = Math.max(bb[2], b.north);
    bb[3] = Math.max(bb[3], b.east);
  }
  if (!view.origin) {
    const lat = (bb[0] + bb[2]) / 2;
    const s = Math.sin((lat * Math.PI) / 180);
    const w = 1 - 0.0066943799901413165 * s * s;
    view.setOrigin({ lat0: lat, lon0: (bb[1] + bb[3]) / 2, kx: ((6378137 / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (((6378137 * (1 - 0.0066943799901413165)) / (w * Math.sqrt(w))) * Math.PI) / 180 });
  }
  const lastError = [];
  for (const [tz, tx, ty] of tiles) {
    const url = new URL(tileUrl(layer.tiles[0], tz, tx, ty, layer.version ?? '1.0.0'), layerUrl).href;
    try {
      const q = await fetch(url, { credentials: 'omit', headers: { Accept: `application/vnd.quantized-mesh${(layer.extensions ?? []).length ? `;extensions=${layer.extensions.join('-')}` : ''},application/octet-stream;q=0.9` } });
      if (!q.ok) throw new Error(`HTTP ${q.status}`);
      let bytes = new Uint8Array(await q.arrayBuffer());
      // Tiles served or stored gzip-compressed.
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      const t = decodeQuantizedMesh(bytes, tileBounds(tz, tx, ty, mercator), { mercator });
      const pos = new Float32Array(t.vertices.length * 3);
      t.vertices.forEach((v, i) => {
        const [e, n] = view.toLocal(v.lat, v.lon);
        pos.set([e, n, v.h], 3 * i);
      });
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setIndex(new T.BufferAttribute(t.indices, 1));
      if (t.normals) {
        // ECEF unit normals → the local east/north/up frame at each vertex.
        const nl = new Float32Array(t.vertices.length * 3);
        t.vertices.forEach((v, i) => {
          const [la, lo] = [(v.lat * Math.PI) / 180, (v.lon * Math.PI) / 180];
          const [x, y, zc] = [t.normals[3 * i], t.normals[3 * i + 1], t.normals[3 * i + 2]];
          const e = -Math.sin(lo) * x + Math.cos(lo) * y;
          const nn = -Math.sin(la) * Math.cos(lo) * x - Math.sin(la) * Math.sin(lo) * y + Math.cos(la) * zc;
          const up = Math.cos(la) * Math.cos(lo) * x + Math.cos(la) * Math.sin(lo) * y + Math.sin(la) * zc;
          nl.set([e, nn, up], 3 * i);
        });
        g.setAttribute('normal', new T.BufferAttribute(nl, 3));
      } else g.computeVertexNormals();
      // A tile that is all water (water mask 255) is drawn blue.
      const water = t.watermask === 255 || (t.watermask?.length && t.watermask.every?.((x) => x === 255));
      const mesh = new T.Mesh(g, new T.MeshLambertMaterial({ color: water ? 0x4a78a8 : 0x9a8f7a, side: T.DoubleSide }));
      mesh.userData = { tile: [tz, tx, ty], min: t.min, max: t.max, extensions: t.extensions, metadata: t.metadata };
      group.add(mesh);
      for (const e of t.extensions) if (!stats.extensions.includes(e)) stats.extensions.push(e);
      stats.tiles++;
      stats.vertices += t.vertices.length;
      stats.triangles += t.indices.length / 3;
      stats.min = Math.min(stats.min, t.min);
      stats.max = Math.max(stats.max, t.max);
    } catch (e) {
      stats.failed++;
      lastError.push(e.message);
      view.app?.log?.('warn', `quantized-mesh ${tz}/${tx}/${ty}: ${e.message}`);
    }
  }
  if (!stats.tiles) throw gwError('no terrain tile could be read ({msg})', { msg: [...new Set(lastError)].slice(0, 2).join('; ') }, 'E_QMESH_UNREADABLE');
  stats.bounds = bb;
  view.world.add(group);
  const entry = { object: group, name: name ?? layer.name ?? 'quantized-mesh terrain', meshes: stats.tiles, placedBy: 'terrain', stats, layer };
  view.models.push(entry);
  view.invalidate();
  return entry;
}

/**
 * Tiles to show from a local set: the paths of its .terrain files relative to the layer.json
 * (z/x/y.terrain) give the levels present; the deepest level with ≤ maxTiles tiles is chosen.
 * A template that keeps the coordinates in the query (one tile file for every request, as in the
 * CesiumJS test data) uses the `available` ranges instead.
 */
export function localTiles(layer, paths, maxTiles = 64) {
  const tmpl = String(layer.tiles?.[0] ?? '');
  const byZ = new Map();
  if (/\{z\}/.test(tmpl.split('?')[0])) {
    // Build a matcher from the template's path part.
    const pat = tmpl.split('?')[0].replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{version\}/g, '[^/]+').replace(/\{z\}/g, '(?<z>\\d+)').replace(/\{x\}/g, '(?<x>\\d+)').replace(/\{y\}/g, '(?<y>\\d+)');
    const re = new RegExp(`(^|/)${pat}$`, 'i');
    for (const p of paths) {
      const m = re.exec(p.replace(/\\/g, '/'));
      if (!m) continue;
      const t = [Number(m.groups.z), Number(m.groups.x), Number(m.groups.y)];
      (byZ.get(t[0]) ?? byZ.set(t[0], []).get(t[0])).push(t);
    }
  } else {
    (layer.available ?? []).forEach((ranges, z) => {
      for (const r of ranges ?? []) for (let x = r.startX; x <= r.endX && x - r.startX < 256; x++) for (let y = r.startY; y <= r.endY && y - r.startY < 256; y++) (byZ.get(z) ?? byZ.set(z, []).get(z)).push([z, x, y]);
    });
    if (!byZ.size) byZ.set(0, isMercator(layer) ? [[0, 0, 0]] : [[0, 0, 0], [0, 1, 0]]);
  }
  const levels = [...byZ.keys()].sort((a, b) => b - a);
  const z = levels.find((l) => byZ.get(l).length <= maxTiles) ?? levels.at(-1);
  if (z === undefined) return [];
  return byZ.get(z).slice(0, maxTiles);
}
