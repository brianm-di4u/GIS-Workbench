// Inputs and outputs of the Rust MVT tiler and PMTiles writer (crates/gw-tiles/src/mvt.rs,
// pmtiles.rs; REQ-FMT-31, REQ-FMT-33): vector layers → the binary "GWVT 1" stream, packed tiles
// (u32 count; per tile u8 z, u32 x, u32 y, u32 length, bytes) both ways.

import { gwError } from '../i18n/index.js';

const enc = new TextEncoder();

class W {
  constructor(n = 1 << 16) {
    this.b = new Uint8Array(n);
    this.dv = new DataView(this.b.buffer);
    this.o = 0;
  }
  need(n) {
    if (this.o + n <= this.b.length) return;
    let m = this.b.length * 2;
    while (m < this.o + n) m *= 2;
    const nb = new Uint8Array(m);
    nb.set(this.b.subarray(0, this.o));
    this.b = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) {
    this.need(1);
    this.b[this.o++] = v;
  }
  u32(v) {
    this.need(4);
    this.dv.setUint32(this.o, v, true);
    this.o += 4;
  }
  u64(v) {
    this.need(8);
    this.dv.setBigUint64(this.o, BigInt.asUintN(64, BigInt(v)), true);
    this.o += 8;
  }
  f64(v) {
    this.need(8);
    this.dv.setFloat64(this.o, v, true);
    this.o += 8;
  }
  str(s) {
    const b = enc.encode(String(s));
    this.u32(b.length);
    this.need(b.length);
    this.b.set(b, this.o);
    this.o += b.length;
  }
  pts(cs) {
    this.u32(cs.length);
    for (const c of cs) {
      this.f64(c[0]);
      this.f64(c[1]);
    }
  }
  out() {
    return this.b.slice(0, this.o);
  }
}

/**
 * Layers [{name, features: [GeoJSON Feature]}] → tiler input. `fields`: per layer, the property
 * names to keep (null = all) — the attribute filter of REQ-FMT-33.
 */
export function encodeTilerInput(layers, { fields = null } = {}) {
  const w = new W();
  w.u8(0x47);
  w.u8(0x57);
  w.u8(0x56);
  w.u8(0x54);
  w.u32(1);
  w.u32(layers.length);
  let features = 0;
  for (const l of layers) {
    const keep = fields?.[l.name] ? new Set(fields[l.name]) : null;
    const keys = new Map();
    const vals = new Map();
    const valList = [];
    const tagged = [];
    for (const f of l.features) {
      const tags = [];
      for (const [k, v] of Object.entries(f.properties ?? {})) {
        if (v === null || v === undefined || (keep && !keep.has(k))) continue;
        let t;
        let val = v;
        if (typeof v === 'boolean') t = 4;
        else if (typeof v === 'number') t = Number.isInteger(v) && Math.abs(v) < 2 ** 53 ? 3 : 2;
        else if (typeof v === 'string') t = 1;
        else {
          t = 1;
          val = JSON.stringify(v);
        }
        if (t === 2 && !Number.isFinite(val)) continue;
        if (!keys.has(k)) keys.set(k, keys.size);
        const vk = `${t}:${val}`;
        if (!vals.has(vk)) {
          vals.set(vk, valList.length);
          valList.push([t, val]);
        }
        tags.push(keys.get(k), vals.get(vk));
      }
      tagged.push(tags);
    }
    w.str(l.name);
    w.u32(keys.size);
    for (const k of keys.keys()) w.str(k);
    w.u32(valList.length);
    for (const [t, v] of valList) {
      w.u8(t);
      if (t === 1) w.str(v);
      else if (t === 2) w.f64(v);
      else if (t === 3) w.u64(v);
      else w.u8(v ? 1 : 0);
    }
    const geoms = [];
    l.features.forEach((f, i) => {
      for (const g of flatten(f.geometry)) geoms.push([f, g, tagged[i]]);
    });
    w.u32(geoms.length);
    for (const [f, g, tags] of geoms) {
      const id = Number(f.id);
      const hasId = Number.isInteger(id) && id >= 0;
      w.u8(hasId ? 1 : 0);
      if (hasId) w.u64(id);
      w.u8(g.kind);
      w.u32(tags.length / 2);
      for (const t of tags) w.u32(t);
      if (g.kind === 1) w.pts(g.c);
      else if (g.kind === 2) {
        w.u32(g.c.length);
        for (const line of g.c) w.pts(line);
      } else {
        w.u32(g.c.length);
        for (const poly of g.c) {
          w.u32(poly.length);
          // Rings without the closing vertex.
          for (const ring of poly) w.pts(ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring);
        }
      }
      features++;
    }
  }
  return { bytes: w.out(), features };
}

function* flatten(g) {
  if (!g) return;
  switch (g.type) {
    case 'Point':
      yield { kind: 1, c: [g.coordinates] };
      break;
    case 'MultiPoint':
      if (g.coordinates.length) yield { kind: 1, c: g.coordinates };
      break;
    case 'LineString':
      yield { kind: 2, c: [g.coordinates] };
      break;
    case 'MultiLineString':
      yield { kind: 2, c: g.coordinates };
      break;
    case 'Polygon':
      yield { kind: 3, c: [g.coordinates] };
      break;
    case 'MultiPolygon':
      yield { kind: 3, c: g.coordinates };
      break;
    case 'GeometryCollection':
      for (const x of g.geometries ?? []) yield* flatten(x);
      break;
    default:
  }
}

/** Packed tiles → [{z, x, y, data}] (views into the buffer). */
export function unpackTiles(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(0, true);
  const out = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    const z = u8[o];
    const x = dv.getUint32(o + 1, true);
    const y = dv.getUint32(o + 5, true);
    const len = dv.getUint32(o + 9, true);
    o += 13;
    out.push({ z, x, y, data: u8.subarray(o, o + len) });
    o += len;
  }
  return out;
}

/** [{z, x, y, data}] → packed tiles. */
export function packTiles(tiles) {
  let n = 4;
  for (const t of tiles) n += 13 + t.data.length;
  const u8 = new Uint8Array(n);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, tiles.length, true);
  let o = 4;
  for (const t of tiles) {
    u8[o] = t.z;
    dv.setUint32(o + 1, t.x, true);
    dv.setUint32(o + 5, t.y, true);
    dv.setUint32(o + 9, t.data.length, true);
    u8.set(t.data, o + 13);
    o += 13 + t.data.length;
  }
  return u8;
}

export const PM_TYPE = { mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5 };

/** Run the tiler on a `tiles` bundle (Bundle API). Returns [{z, x, y, data}] (uncompressed MVT). */
export function runTiler(b, input, { minZoom = 0, maxZoom = 14, extent = 4096, buffer = 64, tolerance = 1, maxTiles = 200000 } = {}) {
  const [p, n] = b.put(input);
  try {
    const st = b.x.gw_mvt_tile(p, n, minZoom, maxZoom, extent, buffer, tolerance, maxTiles);
    if (st !== 0) throw gwError('MVT tiler: {detail}', { detail: b.lastError() }, 'E_MVT_TILER');
    return unpackTiles(b.outBytes());
  } finally {
    b.free(p, n);
  }
}

/** Write a PMTiles v3 archive with a `tiles` bundle. `type`: mvt|png|jpeg|webp|avif. */
export function writePmtiles(b, tiles, { type, bounds, metadata = {}, centerZoom = -1 }) {
  const packed = packTiles(tiles);
  const meta = enc.encode(JSON.stringify(metadata));
  const [p, n] = b.put(packed);
  const [mp, mn] = b.put(meta);
  try {
    const st = b.x.gw_pmtiles_write(p, n, mp, mn, PM_TYPE[type], type === 'mvt' ? 1 : 0, bounds[0], bounds[1], bounds[2], bounds[3], centerZoom);
    if (st !== 0) throw gwError('PMTiles writer: {detail}', { detail: b.lastError() }, 'E_PMTILES_WRITER');
    return b.outBytes();
  } finally {
    b.free(p, n);
    b.free(mp, mn);
  }
}

/** Verify a PMTiles archive held whole with a `tiles` bundle. */
export function verifyPmtiles(b, bytes) {
  const [p, n] = b.put(bytes);
  try {
    if (b.x.gw_pmtiles_verify(p, n) !== 0) throw gwError('PMTiles verify: {detail}', { detail: b.lastError() }, 'E_PMTILES_VERIFY');
    return b.outJson();
  } finally {
    b.free(p, n);
  }
}

/** gzip with a `tiles` bundle (deterministic: mtime 0). */
export function gzipBytes(b, u8, level = 6) {
  const [p, n] = b.put(u8);
  try {
    b.x.gw_gzip(p, n, level);
    return b.outBytes();
  } finally {
    b.free(p, n);
  }
}
