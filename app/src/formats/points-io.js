// BPF and ASCII point clouds (REQ-LDR-11). Both become the same cloud as a LAS file (local frame,
// columns, statistics, LOD index), so every point-cloud tool works on them.
//
// BPF (NGA Binary Point File) v3, after PDAL's BSD reader (the NGA text is not public): "BPF!",
// "0003", header length (i32), dimension count (u8), interleave (u8: 0 dimension-major, 1
// point-major, 2 byte-major), compression (u8: 0 none, 1 zlib blocks), a pad byte, point count
// (i32), coordinate type (i32: 0 Cartesian, 1 UTM with the zone as the coordinate id, negative
// south), coordinate id (i32), spacing (f32), a 4 × 4 transform (16 f64, row-major), start and end
// time (f64); then per dimension: offsets, minima and maxima (f64 each), and 32-byte labels. Values
// are f32 plus the dimension's offset. zlib data is a run of blocks of (uncompressed size,
// compressed size, deflate payload) from the header length on.
//
// ASCII: delimited text with a column map (x, y, z, and optional intensity, class, r, g, b,
// time) and the CRS of the coordinates.

import { crsOf, converter } from '../geo/crs.js';
import { frameScales, statsOf, reorder } from './las.js';

const enc = new TextDecoder('latin1');

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** BPF v3 → {name, n, x, y, z (Float64Array), dims: {label: Float64Array}, crs, info}. */
export async function parseBpf(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (enc.decode(buf.subarray(0, 4)) !== 'BPF!') throw new Error(`${file.name}: not a BPF file (no BPF! magic)`);
  const ver = Number(enc.decode(buf.subarray(4, 8)));
  if (ver !== 3) throw new Error(`${file.name}: BPF version ${enc.decode(buf.subarray(4, 8))} is not read (version 3 only)`);
  const len = dv.getInt32(8, true);
  const nd = dv.getUint8(12);
  const inter = dv.getUint8(13);
  const comp = dv.getUint8(14);
  const n = dv.getInt32(16, true);
  const coordType = dv.getInt32(20, true);
  const coordId = dv.getInt32(24, true);
  const spacing = dv.getFloat32(28, true);
  const xf = Array.from({ length: 16 }, (_, k) => dv.getFloat64(32 + 8 * k, true));
  const t0 = dv.getFloat64(160, true);
  const t1 = dv.getFloat64(168, true);
  let p = 176;
  const read = (k) => Array.from({ length: nd }, (_, d) => dv.getFloat64(p + 8 * (k * nd + d), true));
  const offset = read(0);
  const min = read(1);
  const max = read(2);
  p += 24 * nd;
  const labels = Array.from({ length: nd }, (_, d) => enc.decode(buf.subarray(p + 32 * d, p + 32 * d + 32)).replace(/\0[\s\S]*$/, '').trim());
  if (!(n > 0) || !(nd >= 3) || len < p + 32 * nd || len > buf.length) throw new Error(`${file.name}: the BPF header is not consistent`);
  if (inter > 2) throw new Error(`${file.name}: unknown BPF interleave ${inter}`);
  const ix = ['X', 'Y', 'Z'].map((k) => labels.findIndex((l) => l.toUpperCase() === k));
  if (ix.some((i) => i < 0)) throw new Error(`${file.name}: the BPF has no X, Y and Z dimensions (${labels.join(', ')})`);
  let data = buf.subarray(len);
  if (comp === 1) {
    const parts = [];
    let q = len;
    let total = 0;
    while (q + 8 <= buf.length && total < n * nd * 4) {
      const fin = dv.getUint32(q, true);
      const cl = dv.getUint32(q + 4, true);
      if (q + 8 + cl > buf.length) break;
      const out = await inflate(buf.subarray(q + 8, q + 8 + cl));
      if (out.length !== fin) throw new Error(`${file.name}: a zlib block inflated to ${out.length} bytes, not ${fin}`);
      parts.push(out);
      total += fin;
      q += 8 + cl;
    }
    data = new Uint8Array(total);
    let o = 0;
    for (const part of parts) {
      data.set(part, o);
      o += part.length;
    }
  } else if (comp !== 0) throw new Error(`${file.name}: BPF compression ${comp} is not read (zlib only)`);
  if (data.length < n * nd * 4) throw new Error(`${file.name}: the point data is truncated`);
  const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cols = Array.from({ length: nd }, () => new Float64Array(n));
  const u = new DataView(new ArrayBuffer(4));
  for (let d = 0; d < nd; d++)
    for (let k = 0; k < n; k++) {
      let f;
      if (inter === 0) f = ddv.getFloat32(4 * (d * n + k), true);
      else if (inter === 1) f = ddv.getFloat32(4 * (k * nd + d), true);
      else {
        for (let b = 0; b < 4; b++) u.setUint8(b, data[(d * 4 + b) * n + k]);
        f = u.getFloat32(0, true);
      }
      cols[d][k] = f + offset[d];
    }
  let [x, y, z] = ix.map((i) => cols[i]);
  const identity = xf.every((v, k) => Math.abs(v - (k % 5 === 0 ? 1 : 0)) < 1e-12);
  if (!identity) {
    const X = new Float64Array(n);
    const Y = new Float64Array(n);
    const Z = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      X[k] = xf[0] * x[k] + xf[1] * y[k] + xf[2] * z[k] + xf[3];
      Y[k] = xf[4] * x[k] + xf[5] * y[k] + xf[6] * z[k] + xf[7];
      Z[k] = xf[8] * x[k] + xf[9] * y[k] + xf[10] * z[k] + xf[11];
    }
    [x, y, z] = [X, Y, Z];
  }
  let epsg;
  if (coordType === 1) epsg = (coordId < 0 ? 32700 : 32600) + Math.abs(coordId);
  else throw new Error(`${file.name}: BPF coordinate type ${['Cartesian', 'UTM', 'TCR (ECEF)', 'ENU'][coordType] ?? coordType} is not read (UTM only)`);
  const dims = Object.fromEntries(labels.map((l, d) => [l, cols[d]]));
  return { name: file.name, n, x, y, z, dims, epsg, info: { format: `BPF ${ver}`, interleave: ['dimension-major', 'point-major', 'byte-major'][inter], compression: comp ? 'zlib' : 'none', labels, offset, min, max, spacing, time: [t0, t1], headerLen: len } };
}

/** Delimited text → {n, x, y, z, dims}. columns: {x, y, z, intensity?, class?, r?, g?, b?, time?} (0-based). */
export function parseAscii(text, { columns = { x: 0, y: 1, z: 2 }, skip = 0, delimiter = null, name = 'points.txt' } = {}) {
  const lines = text.split(/\r?\n/);
  const re = delimiter ? new RegExp(delimiter === ' ' ? '\\s+' : `\\s*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`) : /\s*[,;\t|]\s*|\s+/;
  const keys = Object.keys(columns).filter((k) => Number.isInteger(columns[k]));
  const vals = Object.fromEntries(keys.map((k) => [k, []]));
  let bad = 0;
  for (let i = skip; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('#') || s.startsWith('//')) continue;
    const f = s.split(re);
    const row = keys.map((k) => Number(f[columns[k]]));
    if (!Number.isFinite(row[keys.indexOf('x')]) || !Number.isFinite(row[keys.indexOf('y')]) || !Number.isFinite(row[keys.indexOf('z')])) {
      bad++;
      continue;
    }
    keys.forEach((k, j) => vals[k].push(row[j]));
  }
  const n = vals.x.length;
  if (!n) throw new Error(`${name}: no x, y, z rows`);
  const dims = Object.fromEntries(keys.map((k) => [k, Float64Array.from(vals[k])]));
  return { name, n, x: dims.x, y: dims.y, z: dims.z, dims, skipped: bad, info: { format: 'ASCII', columns } };
}

/**
 * A LAS-like cloud from source coordinates: converted to the local frame (DN-36) through the
 * CRS, heights converted to HAE when `vertical` is 'egm96'. dims may hold intensity, class,
 * r/g/b (or Red/Green/Blue), time (or GpsTime) and return numbers.
 */
export async function cloudFromXyz(src, { epsg, vertical = 'hae', pool, undulation = () => 0, ensureGeoid } = {}) {
  const t0ms = performance.now();
  const c0 = crsOf({ epsg });
  if (!c0) throw new Error(`EPSG:${epsg} is not known here (load the PROJ data pack for more codes)`);
  if (vertical === 'egm96') await ensureGeoid?.();
  const conv = converter(c0);
  const n = src.n;
  let [xa, xb, ya, yb, za, zb] = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let k = 0; k < n; k++) {
    xa = Math.min(xa, src.x[k]);
    xb = Math.max(xb, src.x[k]);
    ya = Math.min(ya, src.y[k]);
    yb = Math.max(yb, src.y[k]);
    za = Math.min(za, src.z[k]);
    zb = Math.max(zb, src.z[k]);
  }
  const [lonC, latC] = conv.toLonLat((xa + xb) / 2, (ya + yb) / 2);
  if (!Number.isFinite(latC)) throw new Error(`${src.name}: the coordinates do not convert from EPSG:${epsg}`);
  const origin = { lat0: latC, lon0: lonC, ...frameScales(latC) };
  const D = src.dims;
  const pick = (...names) => {
    for (const k of names) for (const [l, v] of Object.entries(D)) if (l.toLowerCase() === k.toLowerCase()) return v;
    return null;
  };
  const R = pick('r', 'red');
  const G = pick('g', 'green');
  const B = pick('b', 'blue');
  const rgb = R && G && B;
  const I = pick('intensity');
  const K = pick('class', 'classification');
  const T = pick('time', 'gpstime');
  const RN = pick('returnnumber', 'return');
  const NR = pick('numberofreturns');
  const tOrigin = T ? Math.round(T[0]) : 0;
  const c = { n, pos: new Float32Array(3 * n), time: new Float32Array(n), intensity: new Uint16Array(n), source: new Uint16Array(n), scan: new Int16Array(n), rgb: rgb ? new Uint16Array(3 * n) : null, class: new Uint8Array(n), ret: new Uint8Array(n), flags: new Uint8Array(n), user: new Uint8Array(n) };
  for (let k = 0; k < n; k++) {
    const [lon, lat] = conv.toLonLat(src.x[k], src.y[k]);
    c.pos[3 * k] = (lon - origin.lon0) * origin.kx;
    c.pos[3 * k + 1] = (lat - origin.lat0) * origin.ky;
    c.pos[3 * k + 2] = src.z[k] + (vertical === 'egm96' ? undulation(lat, lon) : 0);
    if (I) c.intensity[k] = Math.max(0, Math.min(65535, Math.round(I[k])));
    if (K) c.class[k] = Math.max(0, Math.min(255, Math.round(K[k])));
    if (T) c.time[k] = T[k] - tOrigin;
    c.ret[k] = (Math.max(1, Math.min(15, Math.round(RN?.[k] ?? 1))) & 15) | ((Math.max(1, Math.min(15, Math.round(NR?.[k] ?? 1))) & 15) << 4);
    if (rgb) {
      c.rgb[3 * k] = R[k];
      c.rgb[3 * k + 1] = G[k];
      c.rgb[3 * k + 2] = B[k];
    }
  }
  const stats = statsOf(c, !!rgb);
  const area = Math.max(1, (stats.max[0] - stats.min[0]) * (stats.max[1] - stats.min[1]));
  const tile = Math.min(500, Math.max(15, Math.sqrt((area * 100000) / n)));
  const ix = await pool.run('index', { pos: c.pos, tile, s0: tile / 16, maxLevel: 12 }, { kind: 'pointcloud', timeout: 600000, label: `index ${src.name}` });
  reorder(c, ix.perm);
  const vname = vertical === 'egm96' ? 'EGM96 height' : 'ellipsoidal height';
  const crs = { crs: c0, label: c0.label, hUnit: 1, vUnit: 1, vertical, vname, warnings: src.skipped ? [`${src.skipped} line(s) without x, y and z were skipped`] : [] };
  const info = { version: src.info.format, format: src.info.format, recordLen: 0, baseSize: 0, nPoints: n, byReturn: [n], fileSourceId: 0, globalEncoding: 0, systemId: src.info.interleave ? `BPF ${src.info.interleave}, ${src.info.compression}` : 'ASCII', software: '', day: 0, year: 0, headerSize: src.info.headerLen ?? 0, pointOffset: src.info.headerLen ?? 0, nVlrs: 0, nEvlrs: 0, scale: [0, 0, 0], offset: src.info.offset?.slice(0, 3) ?? [0, 0, 0], min: [xa, ya, za], max: [xb, yb, zb], dims: Object.keys(D) };
  return { order: ix.perm, name: src.name, size: src.size ?? 0, info, wkt: null, crs, origin, t0: tOrigin, ...c, hasRgb: !!rgb, hasTime: !!T, stats, tiles: ix.tiles, tileSize: tile, ms: { total: Math.round(performance.now() - t0ms) } };
}
