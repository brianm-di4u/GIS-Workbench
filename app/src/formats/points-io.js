// BPF and ASCII point clouds (REQ-LDR-11). Both become the same cloud as a LAS file (local frame,
// columns, statistics, LOD index), so every point-cloud tool works on them.
//
// BPF (NGA Binary Point File) v3, after PDAL's BSD reader (the NGA text is not public): "BPF!",
// "0003", header length (i32), dimension count (u8), interleave (u8: 0 dimension-major, 1
// point-major, 2 byte-major), compression (u8: 0 none, 1 QuickLZ, 2 FastLZ, 3 zlib), a pad byte, point count
// (i32), coordinate type (i32: 0 Cartesian, 1 UTM with the zone as the coordinate id, negative
// south), coordinate id (i32), spacing (f32), a 4 × 4 transform (16 f64, row-major), start and end
// time (f64); then per dimension: offsets, minima and maxima (f64 each), and 32-byte labels. Values
// are f32 plus the dimension's offset. Compressed data (FastLZ, zlib) is a run of blocks of
// (uncompressed size, compressed size, payload) from the header length on; a block that did not
// shrink is stored raw.
//
// ASCII: delimited text with a column map (x, y, z, and optional intensity, class, r, g, b,
// time) and the CRS of the coordinates.

import { crsOf, converter } from '../geo/crs.js';
import { frameScales, statsOf, reorder } from './las.js';
import { ecefToGeodeticJs, geodeticToEcefJs } from '../geo/ecef.js';
import { t, gwError } from '../i18n/index.js';

export { ecefToGeodeticJs, geodeticToEcefJs };

const enc = new TextDecoder('latin1');
// BPF compression codes as PDAL writes them.
const COMP = ['none', 'QuickLZ', 'FastLZ', 'zlib'];

async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** FastLZ block (levels 1 and 2, the level in the top bits of the first byte) → `size` bytes. */
export function fastlzDecompress(src, size) {
  const out = new Uint8Array(size);
  const level = src[0] >> 5;
  if (level > 1) throw new Error(`FastLZ level ${level + 1} is not known`);
  let ip = 0;
  let op = 0;
  let ctrl = src[ip++] & 31;
  for (;;) {
    if (ctrl >= 32) {
      let len = (ctrl >> 5) - 1;
      let ofs = (ctrl & 31) << 8;
      let ref = op - ofs - 1;
      if (len === 6) {
        if (level === 0) len += src[ip++];
        else {
          let code;
          do len += (code = src[ip++]);
          while (code === 255);
        }
      }
      const code = src[ip++];
      ref -= code;
      len += 3;
      // Level 2: a far match (distance beyond 8191) carries a 16-bit distance.
      if (level === 1 && code === 255 && ofs === 31 << 8) {
        ofs = (src[ip] << 8) | src[ip + 1];
        ip += 2;
        ref = op - ofs - 8191 - 1;
      }
      if (ref < 0 || op + len > size) throw new Error('FastLZ data is corrupt');
      for (let k = 0; k < len; k++) out[op++] = out[ref++];
    } else {
      ctrl++;
      if (ip + ctrl > src.length || op + ctrl > size) throw new Error('FastLZ data is corrupt');
      out.set(src.subarray(ip, ip + ctrl), op);
      ip += ctrl;
      op += ctrl;
    }
    if (ip >= src.length) break;
    ctrl = src[ip++];
  }
  if (op !== size) throw new Error(`a FastLZ block decoded to ${op} bytes, not ${size}`);
  return out;
}

/**
 * FastLZ level 1 (MIT format, as `fastlzDecompress` reads it): literal runs of up to 32 bytes and matches
 * of 3–264 bytes at distances up to 8192, found through a hash of the next three bytes. The stream starts
 * with a literal run, as the format requires.
 */
export function fastlzCompress(src) {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 32) + 16);
  let op = 0;
  const table = new Int32Array(1 << 13).fill(-1);
  const hash = (i) => Math.imul((src[i] << 16) | (src[i + 1] << 8) | src[i + 2], 2654435761) >>> 19;
  let lit = 0; // start of the pending literal run
  const flush = (end) => {
    for (let s = lit; s < end; s += 32) {
      const k = Math.min(32, end - s);
      out[op++] = k - 1;
      out.set(src.subarray(s, s + k), op);
      op += k;
    }
  };
  let ip = n > 0 ? 1 : 0; // the first byte is always a literal
  while (ip + 3 <= n) {
    const h = hash(ip);
    const ref = table[h];
    table[h] = ip;
    const d = ip - ref;
    if (ref < 0 || d > 8192 || src[ref] !== src[ip] || src[ref + 1] !== src[ip + 1] || src[ref + 2] !== src[ip + 2]) {
      ip++;
      continue;
    }
    let len = 3;
    while (ip + len < n && len < 264 && src[ref + len] === src[ip + len]) len++;
    flush(ip);
    const dd = d - 1;
    if (len - 2 < 7) out[op++] = ((len - 2) << 5) | (dd >> 8);
    else {
      out[op++] = (7 << 5) | (dd >> 8);
      out[op++] = len - 9;
    }
    out[op++] = dd & 255;
    for (let k = 1; k < len && ip + k + 3 <= n; k++) table[hash(ip + k)] = ip + k;
    ip += len;
    lit = ip;
  }
  flush(n);
  return out.subarray(0, op);
}

/**
 * BPF v3 → {name, n, x, y, z (Float64Array), dims: {label: Float64Array}, epsg, frame, local, info}.
 * `ecefToGeodetic(X, Y, Z) → [lat, lon, h]` converts TCR points (default: a closed form here).
 */
export async function parseBpf(file, { ecefToGeodetic = null } = {}) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (enc.decode(buf.subarray(0, 4)) !== 'BPF!') throw gwError('{file}: not a BPF file (no BPF! magic)', { file: file.name }, 'E_NOT_BPF');
  const ver = Number(enc.decode(buf.subarray(4, 8)));
  if (ver !== 3) throw gwError('{file}: BPF version {version} is not read (version 3 only)', { file: file.name, version: enc.decode(buf.subarray(4, 8)) }, 'E_BPF_VERSION');
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
  if (!(n > 0) || !(nd >= 3) || len < p + 32 * nd || len > buf.length) throw gwError('{file}: the BPF header is not consistent', { file: file.name }, 'E_BPF_HEADER');
  if (inter > 2) throw gwError('{file}: unknown BPF interleave {n}', { file: file.name, n: String(inter) }, 'E_BPF_HEADER');
  const ix = ['X', 'Y', 'Z'].map((k) => labels.findIndex((l) => l.toUpperCase() === k));
  if (ix.some((i) => i < 0)) throw gwError('{file}: the BPF has no X, Y and Z dimensions ({dims})', { file: file.name, dims: labels.join(', ') }, 'E_BPF_DIMS');
  let data = buf.subarray(len);
  // Some writers label zlib blocks with code 1 (QuickLZ in PDAL's numbering): read those by their zlib stream header.
  const zlibAt = (q) => q + 10 <= buf.length && (buf[q + 8] & 0x0f) === 8 && ((buf[q + 8] << 8) | buf[q + 9]) % 31 === 0;
  const codec = comp === 1 && zlibAt(len) ? 3 : comp;
  if (codec === 1) throw gwError("{file}: BPF QuickLZ compression is not read (QuickLZ is GPL, and the sidecar's PDAL decodes it wrongly; zlib, FastLZ and uncompressed BPF are read): have it re-written with zlib or no compression", { file: file.name }, 'E_BPF_QUICKLZ');
  if (codec === 2 || codec === 3) {
    const parts = [];
    let q = len;
    let total = 0;
    while (q + 8 <= buf.length && total < n * nd * 4) {
      const fin = dv.getUint32(q, true);
      const cl = dv.getUint32(q + 4, true);
      if (q + 8 + cl > buf.length) break;
      const block = buf.subarray(q + 8, q + 8 + cl);
      // A block that did not shrink is stored as it is (compressed size = raw size).
      const out = cl === fin ? block : codec === 3 ? await inflate(block) : fastlzDecompress(block, fin);
      if (out.length !== fin) throw gwError('{file}: a {codec} block decoded to {got} bytes, not {want}', { file: file.name, codec: String(COMP[codec]), got: String(out.length), want: String(fin) }, 'E_BPF_BLOCK');
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
  } else if (comp !== 0) throw gwError('{file}: unknown BPF compression {n}', { file: file.name, n: String(comp) }, 'E_BPF_COMPRESSION');
  if (data.length < n * nd * 4) throw gwError('{file}: the point data is truncated', { file: file.name }, 'E_BPF_TRUNCATED');
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
  // Coordinate types (FC-20, REQ-FMT-47): UTM (zone in the id, negative south); TCR, the
  // Earth-centred Earth-fixed frame (id 1 = WGS 84, as PDAL reads it), converted to WGS 84 longitude,
  // latitude and ellipsoidal height; Cartesian and ENU have no stated datum or origin, so they open in a
  // local metric frame (REQ-LDR-13) until the user assigns a CRS.
  let epsg = null;
  let frame;
  if (coordType === 1) {
    if (!(Math.abs(coordId) >= 1 && Math.abs(coordId) <= 60)) throw gwError('{file}: BPF UTM zone {zone} is not a zone (1–60, negative for south)', { file: file.name, zone: String(coordId) }, 'E_BPF_ZONE');
    epsg = (coordId < 0 ? 32700 : 32600) + Math.abs(coordId);
    frame = 'utm';
  } else if (coordType === 2) {
    if (coordId !== 1 && coordId !== 0) throw gwError('{file}: BPF TCR (ECEF) coordinate id {id} names no known datum (1 = WGS 84)', { file: file.name, id: String(coordId) }, 'E_BPF_DATUM');
    const geo = ecefToGeodetic ?? ecefToGeodeticJs;
    const lon = new Float64Array(n);
    const lat = new Float64Array(n);
    const hae = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const g = geo(x[k], y[k], z[k]);
      [lat[k], lon[k], hae[k]] = g;
    }
    [x, y, z] = [lon, lat, hae];
    epsg = 4326;
    frame = 'ecef';
  } else if (coordType === 0 || coordType === 3) frame = coordType === 0 ? 'cartesian' : 'enu';
  else throw gwError('{file}: BPF coordinate type {type} is not defined (0 Cartesian, 1 UTM, 2 TCR/ECEF, 3 ENU)', { file: file.name, type: String(coordType) }, 'E_BPF_COORD_TYPE');
  const dims = Object.fromEntries(labels.map((l, d) => [l, cols[d]]));
  return { name: file.name, n, x, y, z, dims, epsg, frame, local: !epsg, info: { format: `BPF ${ver}`, interleave: ['dimension-major', 'point-major', 'byte-major'][inter], compression: COMP[codec], labels, offset, min, max, spacing, time: [t0, t1], headerLen: len, coordType: COORD[coordType], coordId } };
}

const COORD = ['Cartesian', 'UTM', 'TCR (ECEF)', 'ENU'];

// BPF dimension labels as PDAL names them, and the cloud column each comes from.
const BPF_DIMS = [
  ['Intensity', (c, k) => c.intensity[k]],
  ['ReturnNumber', (c, k) => c.ret[k] & 15],
  ['NumberOfReturns', (c, k) => c.ret[k] >> 4],
  ['Classification', (c, k) => c.class[k]],
  ['ScanAngleRank', (c, k) => c.scan[k]],
  ['UserData', (c, k) => c.user[k]],
  ['PointSourceId', (c, k) => c.source[k]],
];

/**
 * A cloud → BPF v3 bytes (REQ-FMT-48). `coords` [n][3] are the point coordinates already in the chosen
 * frame (coordType 0 Cartesian, 1 UTM with `coordId` the zone, negative south, 2 TCR/ECEF with id 1,
 * 3 ENU); every attribute column of the cloud follows as an extra dimension. compression 'none', 'zlib'
 * or 'fastlz' (QuickLZ is GPL and never written); interleave 0 dimension-major, 1 point-major, 2 byte-major.
 */
export async function writeBpf(c, { x, y, z, coordType = 1, coordId = 0, compression = 'zlib', interleave = 0, time = null, extra = {} } = {}) {
  const n = c.n;
  const cols = [['X', x], ['Y', y], ['Z', z]];
  if (time) cols.push(['GpsTime', time]);
  for (const [label, get] of BPF_DIMS) {
    const v = new Float64Array(n);
    for (let k = 0; k < n; k++) v[k] = get(c, k);
    cols.push([label, v]);
  }
  if (c.rgb) for (const [b, label] of ['Red', 'Green', 'Blue'].entries()) cols.push([label, Float64Array.from({ length: n }, (_, k) => c.rgb[3 * k + b])]);
  for (const [label, v] of Object.entries(extra)) if (v?.length === n && !cols.some(([l]) => l === label)) cols.push([label.slice(0, 31), v]);
  const nd = cols.length;
  if (nd > 255) throw new Error('a BPF holds at most 255 dimensions');
  const len = 176 + 56 * nd;
  const head = new Uint8Array(len);
  const dv = new DataView(head.buffer);
  head.set(new TextEncoder().encode('BPF!0003'), 0);
  dv.setInt32(8, len, true);
  dv.setUint8(12, nd);
  dv.setUint8(13, interleave);
  dv.setUint8(14, compression === 'zlib' ? 3 : compression === 'fastlz' ? 2 : 0);
  dv.setInt32(16, n, true);
  dv.setInt32(20, coordType, true);
  dv.setInt32(24, coordId, true);
  dv.setFloat32(28, 0, true);
  for (let k = 0; k < 16; k++) dv.setFloat64(32 + 8 * k, k % 5 === 0 ? 1 : 0, true);
  let [ta, tb] = [0, 0];
  if (time && n) {
    [ta, tb] = [Infinity, -Infinity];
    for (let k = 0; k < n; k++) [ta, tb] = [Math.min(ta, time[k]), Math.max(tb, time[k])];
  }
  dv.setFloat64(160, ta, true);
  dv.setFloat64(168, tb, true);
  // Values are f32 after the dimension's offset: the middle of its range keeps coordinates to the millimetre.
  const off = [];
  cols.forEach(([label, v], d) => {
    let [lo, hi] = [Infinity, -Infinity];
    for (let k = 0; k < n; k++) [lo, hi] = [Math.min(lo, v[k]), Math.max(hi, v[k])];
    if (!n) [lo, hi] = [0, 0];
    const o = d < 3 || label === 'GpsTime' ? Math.round((lo + hi) / 2) : 0;
    off.push(o);
    dv.setFloat64(176 + 8 * d, o, true);
    dv.setFloat64(176 + 8 * (nd + d), lo, true);
    dv.setFloat64(176 + 8 * (2 * nd + d), hi, true);
    head.set(new TextEncoder().encode(label.slice(0, 31)), 176 + 24 * nd + 32 * d);
  });
  const body = new Uint8Array(4 * n * nd);
  const bv = new DataView(body.buffer);
  const u = new DataView(new ArrayBuffer(4));
  for (let d = 0; d < nd; d++) {
    const v = cols[d][1];
    for (let k = 0; k < n; k++) {
      const f = v[k] - off[d];
      if (interleave === 0) bv.setFloat32(4 * (d * n + k), f, true);
      else if (interleave === 1) bv.setFloat32(4 * (k * nd + d), f, true);
      else {
        u.setFloat32(0, f, true);
        for (let b = 0; b < 4; b++) body[(d * 4 + b) * n + k] = u.getUint8(b);
      }
    }
  }
  if (compression !== 'zlib' && compression !== 'fastlz') return concat([head, body]);
  // zlib (RFC 1950) or FastLZ level-1 blocks of (raw size, compressed size, payload), one per MiB of
  // point data; a block that does not shrink is stored as it is (compressed size = raw size).
  const parts = [head];
  const B = 1 << 20;
  for (let o = 0; o < body.length || o === 0; o += B) {
    const raw = body.subarray(o, Math.min(body.length, o + B));
    let zb;
    if (compression === 'fastlz') zb = fastlzCompress(raw);
    else zb = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    if (compression === 'fastlz' && zb.length >= raw.length) zb = raw;
    const bh = new Uint8Array(8);
    const hv = new DataView(bh.buffer);
    hv.setUint32(0, raw.length, true);
    hv.setUint32(4, zb.length, true);
    parts.push(bh, zb);
    if (!body.length) break;
  }
  return concat(parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
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
  if (!n) throw gwError('{file}: no x, y, z rows', { file: name }, 'E_XYZ_EMPTY');
  const dims = Object.fromEntries(keys.map((k) => [k, Float64Array.from(vals[k])]));
  return { name, n, x: dims.x, y: dims.y, z: dims.z, dims, skipped: bad, info: { format: 'ASCII', columns } };
}

/**
 * A LAS-like cloud from source coordinates: converted to the local frame (DN-36) through the
 * CRS, heights converted to HAE when `vertical` is 'egm96'. dims may hold intensity, class,
 * r/g/b (or Red/Green/Blue), time (or GpsTime) and return numbers.
 */
export async function cloudFromXyz(src, { epsg, local = false, vertical = 'hae', pool, undulation = () => 0, ensureGeoid } = {}) {
  const t0ms = performance.now();
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
  // REQ-LDR-13: coordinates with no datum (BPF Cartesian and ENU) open in a local metric frame, a
  // transverse Mercator tangent at 0°, 0° with the cloud's centre as false origin, until a CRS is assigned.
  const c0 = local ? { def: `+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +x_0=${(xa + xb) / 2} +y_0=${(ya + yb) / 2} +ellps=WGS84 +units=m +no_defs`, label: src.frame === 'enu' ? t('Local frame (ENU, no CRS)') : t('Local frame (Cartesian, no CRS)'), note: { name: 'local', acc: -1 } } : crsOf({ epsg });
  if (!c0) throw gwError('EPSG:{code} is not known here (load the PROJ data pack for more codes)', { code: String(epsg) }, 'E_EPSG_UNKNOWN');
  if (vertical === 'egm96') await ensureGeoid?.();
  const conv = converter(c0);
  const [lonC, latC] = conv.toLonLat((xa + xb) / 2, (ya + yb) / 2);
  if (!Number.isFinite(latC)) throw gwError('{file}: the coordinates do not convert from EPSG:{code}', { file: src.name, code: String(epsg) }, 'E_XYZ_CONVERT');
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
  const SA = pick('scananglerank', 'scanangle');
  const PS = pick('pointsourceid');
  const UD = pick('userdata');
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
    if (SA) c.scan[k] = Math.max(-32768, Math.min(32767, Math.round(SA[k])));
    if (PS) c.source[k] = Math.max(0, Math.min(65535, Math.round(PS[k])));
    if (UD) c.user[k] = Math.max(0, Math.min(255, Math.round(UD[k])));
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
  const ix = await pool.run('index', { pos: c.pos, tile, s0: tile / 16, maxLevel: 12 }, { kind: 'pointcloud', timeout: 600000, label: t('Indexing {file}…', { file: src.name }) });
  reorder(c, ix.perm);
  const vname = vertical === 'egm96' ? 'EGM96 height' : 'ellipsoidal height';
  const warnings = src.skipped ? [t('{n, plural, one {{count} line} other {{count} lines}} without x, y and z were skipped', { n: src.skipped, count: String(src.skipped) })] : [];
  if (local) warnings.push(t('BPF {frame} coordinates state no CRS: shown in a local metric frame placed at 0°, 0°. Lengths, areas and heights are exact; map overlays, geographic coordinates and CE90 are not meaningful until a CRS is assigned (Point Cloud ▸ Assign CRS).', { frame: src.frame === 'enu' ? 'ENU' : 'Cartesian' }));
  if (src.frame === 'ecef') warnings.push(t('BPF TCR (ECEF, WGS 84) coordinates converted to WGS 84 longitude, latitude and ellipsoidal height'));
  const crs = { crs: c0, label: c0.label, hUnit: 1, vUnit: 1, vertical, vname, warnings, local };
  const info = { version: src.info.format, format: src.info.format, recordLen: 0, baseSize: 0, nPoints: n, byReturn: [n], fileSourceId: 0, globalEncoding: 0, systemId: src.info.interleave ? `BPF ${src.info.interleave}, ${src.info.compression}` : 'ASCII', software: '', day: 0, year: 0, headerSize: src.info.headerLen ?? 0, pointOffset: src.info.headerLen ?? 0, nVlrs: 0, nEvlrs: 0, scale: [0, 0, 0], offset: src.info.offset?.slice(0, 3) ?? [0, 0, 0], min: [xa, ya, za], max: [xb, yb, zb], dims: Object.keys(D) };
  return { order: ix.perm, name: src.name, size: src.size ?? 0, info, wkt: null, crs, origin, t0: tOrigin, ...c, hasRgb: !!rgb, hasTime: !!T, stats, tiles: ix.tiles, tileSize: tile, ms: { total: Math.round(performance.now() - t0ms) } };
}
