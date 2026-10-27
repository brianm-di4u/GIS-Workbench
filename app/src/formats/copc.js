// COPC and EPT streaming (REQ-LDR-02, REQ-ARC-16): octree point clouds read node by node — COPC
// by byte range from a local file (File.slice) or an allowed online origin (HTTP Range through the
// network log), EPT by node file. COPC: the 1.4 header and the copc info VLR (centre, half size,
// spacing, root hierarchy page), hierarchy pages of 32-byte entries (key, offset, size, count;
// count −1 = a child page), each node one LAZ chunk decoded by the point-cloud workers. EPT:
// ept.json, JSON hierarchy files, and node data as LAZ files or the "binary" schema. Every node
// lands in the view's local frame through the same CRS lattice as whole-file clouds (DN-36).

import { readLasHeader, buildLattice, lasCrs, statsOf } from './las.js';
import { columnsOf } from '../wasm/pointcloud.js';
import { crsOf } from '../geo/crs.js';

/** A File-like object over HTTP Range requests (size from Content-Range). */
export async function rangeFile(url, fetch) {
  const r = await fetch(url, { credentials: 'omit', headers: { Range: 'bytes=0-0' } });
  if (r.status !== 206) throw new Error(`${url}: the server does not answer byte-range requests (HTTP ${r.status}); COPC streaming needs Range support`);
  let size = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1]);
  await r.arrayBuffer();
  // Many hosts (S3 among them) do not expose Content-Range to CORS (TE-045). Content-Length is
  // CORS-safelisted, so a HEAD gives the size; without it, COPC still reads by the offsets in its
  // own header and hierarchy, so the size is only a bound.
  if (!Number.isFinite(size)) {
    const h = await fetch(url, { method: 'HEAD', credentials: 'omit' }).catch(() => null);
    const n = Number(h?.headers.get('content-length'));
    size = h?.ok && n > 0 ? n : Infinity;
  }
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'cloud.copc.laz');
  const f = { name, size, url, remote: true, ranges: 0 };
  f.slice = (a, b) => ({
    arrayBuffer: async () => {
      f.ranges++;
      // An unknown size gives an open-ended range for a read to the end.
      const end = Math.min(size, b);
      const q = await fetch(url, { credentials: 'omit', headers: { Range: `bytes=${a}-${Number.isFinite(end) ? end - 1 : ''}` } });
      if (q.status !== 206 && !(q.status === 200 && a === 0 && b >= size)) throw new Error(`${name}: range ${a}–${b} failed (HTTP ${q.status})`);
      return q.arrayBuffer();
    },
  });
  return f;
}

/** Bilinear lookup of the CRS lattice: source X, Y → local [e, n, dz]. */
export function latticeAt(flat, X, Y) {
  const [ax, ay, dx, dy, nx, ny] = flat;
  const fx = Math.max(0, Math.min(nx - 1.000001, (X - ax) / dx));
  const fy = Math.max(0, Math.min(ny - 1.000001, (Y - ay) / dy));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const at = (ii, jj, k) => flat[7 + 3 * (jj * nx + ii) + k];
  return [0, 1, 2].map((k) => (at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx) * (1 - ty) + (at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx) * ty);
}

const keyOf = (d, x, y, z) => `${d}-${x}-${y}-${z}`;

function childKeys(k) {
  const [d, x, y, z] = k.split('-').map(Number);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(keyOf(d + 1, 2 * x + (i & 1), 2 * y + ((i >> 1) & 1), 2 * z + ((i >> 2) & 1)));
  return out;
}

class Stream {
  constructor(opts) {
    Object.assign(this, opts);
    this.nodes = new Map(); // key → {key, count, offset?, bytes?, page?, state, columns}
    this.pending = new Set();
    this.stats = { requested: 0, loaded: 0, points: 0, failed: 0 };
  }

  /** Source-CRS cube of a node. */
  cube(key) {
    const [d, x, y, z] = key.split('-').map(Number);
    const size = (2 * this.half) / 2 ** d;
    const lo = [this.center[0] - this.half + x * size, this.center[1] - this.half + y * size, this.center[2] - this.half + z * size];
    return { lo, hi: [lo[0] + size, lo[1] + size, lo[2] + size], size };
  }

  /** Local-frame bounding sphere of a node (centre e, n, z and radius in metres). */
  sphere(key) {
    const c = this.cube(key);
    const X = (c.lo[0] + c.hi[0]) / 2;
    const Y = (c.lo[1] + c.hi[1]) / 2;
    const [e, n, dz] = latticeAt(this.lattice, X, Y);
    const u = this.crs.hUnit || 1;
    return { c: [e, n, ((c.lo[2] + c.hi[2]) / 2) * (this.crs.vUnit || 1) + dz], r: (c.size * Math.sqrt(3) * u) / 2 };
  }

  spacingOf(key) {
    const d = Number(key.split('-')[0]);
    return (this.spacing * (this.crs.hUnit || 1)) / 2 ** d;
  }

  children(key) {
    return childKeys(key).filter((k) => this.nodes.has(k) && this.nodes.get(k).count !== 0);
  }

  /** Make sure the hierarchy below `key` is known (child pages are loaded on demand). */
  async expand(key) {
    for (const k of childKeys(key)) {
      const n = this.nodes.get(k);
      if (n?.page && !n.pageLoaded) await this.loadPage(n);
    }
  }
}

/** Open a COPC file (local File or rangeFile). */
export async function openCopc(file, { pool, undulation, ensureGeoid } = {}) {
  const run = (op, args, transfer = []) => pool.run(op, args, { kind: 'pointcloud', transfer, label: `${op} ${file.name}`, timeout: 600000 });
  const { info, wkt, crs } = await readLasHeader(file, run);
  if (!crs.crs) throw new Error(`${file.name}: no usable coordinate reference system`);
  if (['egm96', 'egm2008', 'navd88'].includes(crs.vertical)) await ensureGeoid?.();
  const read = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  // The copc info VLR follows the 375-byte header (COPC 1.0 §3).
  const vh = await read(375, 375 + 54 + 160);
  const user = new TextDecoder().decode(vh.subarray(2, 18)).replace(/\0.*$/s, '');
  if (user !== 'copc') throw new Error(`${file.name}: not a COPC file (no copc info VLR)`);
  const dv = new DataView(vh.buffer, vh.byteOffset + 54, 160);
  const center = [dv.getFloat64(0, true), dv.getFloat64(8, true), dv.getFloat64(16, true)];
  const half = dv.getFloat64(24, true);
  const spacing = dv.getFloat64(32, true);
  const rootOff = Number(dv.getBigUint64(40, true));
  const rootSize = Number(dv.getBigUint64(48, true));
  if (!info.laz) throw new Error(`${file.name}: the laszip VLR is missing`);
  const lazVlr = await read(info.laz.vlrOffset, info.laz.vlrOffset + info.laz.vlrLen);
  const lat = buildLattice(info, crs, undulation);
  const hasRgb = [2, 3, 5, 7, 8, 10].includes(info.format);
  const prm = [info.format, info.recordLen, ...info.scale, ...info.offset, 0, ...lat.flat];
  const s = new Stream({ statsOf, kind: 'COPC', name: file.name, file, info, wkt, crs, origin: lat.origin, lattice: lat.flat, hasRgb, center, half, spacing, root: '0-0-0-0', total: info.nPoints });
  s.loadPage = async (p) => {
    const b = await read(p.offset, p.offset + p.bytes);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let o = 0; o + 32 <= b.length; o += 32) {
      const k = keyOf(v.getInt32(o, true), v.getInt32(o + 4, true), v.getInt32(o + 8, true), v.getInt32(o + 12, true));
      const offset = Number(v.getBigUint64(o + 16, true));
      const bytes = v.getInt32(o + 24, true);
      const count = v.getInt32(o + 28, true);
      if (count === -1) s.nodes.set(k, { ...(s.nodes.get(k) ?? {}), key: k, page: true, offset, bytes, count: s.nodes.get(k)?.count ?? -1, state: s.nodes.get(k)?.state ?? 'none' });
      else s.nodes.set(k, { ...(s.nodes.get(k) ?? {}), key: k, offset, bytes, count, state: s.nodes.get(k)?.state ?? 'none', page: false });
    }
    p.pageLoaded = true;
  };
  await s.loadPage({ offset: rootOff, bytes: rootSize });
  s.load = async (key) => {
    const n = s.nodes.get(key);
    if (!n || n.count <= 0) return null;
    const data = await read(n.offset, n.offset + n.bytes);
    const out = await run('decodeLaz', { prm, vlr: lazVlr, data, chunks: [n.count, n.bytes] }, [data.buffer]);
    return columnsOf(out.buffer, n.count, hasRgb);
  };
  return s;
}

/** Open an EPT dataset from its ept.json URL. */
export async function openEpt(url, fetch, { pool, undulation, ensureGeoid } = {}) {
  const run = (op, args, transfer = []) => pool.run(op, args, { kind: 'pointcloud', transfer, label: `${op} EPT`, timeout: 600000 });
  const base = url.replace(/ept\.json(\?.*)?$/, '');
  const get = async (u, as = 'json') => {
    const r = await fetch(u, { credentials: 'omit' });
    if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
    return as === 'json' ? r.json() : new Uint8Array(await r.arrayBuffer());
  };
  const ept = await get(url);
  const b = ept.bounds;
  const epsg = Number(ept.srs?.horizontal ?? /EPSG:?(\d+)/.exec(ept.srs?.authority === 'EPSG' ? `EPSG:${ept.srs.horizontal}` : '')?.[1]);
  const c = crsOf({ epsg: Number.isFinite(epsg) ? epsg : null, wkt: ept.srs?.wkt ?? null });
  if (!c) throw new Error('EPT: the srs is not known (EPSG code or WKT)');
  const crs = { crs: c, label: c.label, hUnit: 1, vUnit: 1, vertical: 'unstated', vname: '', warnings: ['The EPT srs states no vertical CRS: heights are used as ellipsoidal (HAE)'] };
  if (ept.srs?.vertical) crs.vertical = 'other';
  void lasCrs;
  void ensureGeoid;
  const infoLike = { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] };
  const lat = buildLattice(infoLike, crs, undulation);
  const schema = ept.schema ?? [];
  const has = (n) => schema.some((x) => x.name === n);
  const hasRgb = has('Red') && has('Green') && has('Blue');
  const center = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
  const half = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) / 2;
  const s = new Stream({ statsOf, kind: 'EPT', name: base.split('/').filter(Boolean).pop() ?? 'EPT', url, ept, crs, origin: lat.origin, lattice: lat.flat, hasRgb, center, half, spacing: (2 * half) / (ept.span ?? 128), root: '0-0-0-0', total: ept.points ?? 0 });
  s.loadPage = async (p) => {
    const h = await get(`${base}ept-hierarchy/${p.key}.json`);
    for (const [k, v] of Object.entries(h)) {
      if (v === -1) s.nodes.set(k, { ...(s.nodes.get(k) ?? {}), key: k, page: true, count: -1, state: 'none' });
      else s.nodes.set(k, { ...(s.nodes.get(k) ?? {}), key: k, count: v, state: s.nodes.get(k)?.state ?? 'none', page: s.nodes.get(k)?.page && k !== p.key ? true : false });
    }
    p.pageLoaded = true;
  };
  await s.loadPage({ key: '0-0-0-0' });
  s.load = async (key) => {
    const n = s.nodes.get(key);
    if (!n || n.count <= 0) return null;
    if (ept.dataType === 'binary') return binaryNode(await get(`${base}ept-data/${key}.bin`, 'bytes'), n.count, schema, lat.flat, hasRgb);
    if (ept.dataType === 'laszip') {
      // A node is a whole LAZ file: its own header, scale and chunk table; the shared lattice.
      const bytes = await get(`${base}ept-data/${key}.laz`, 'bytes');
      const f = new File([bytes], `${key}.laz`);
      const { info } = await readLasHeader(f, run);
      const vlr = bytes.slice(info.laz.vlrOffset, info.laz.vlrOffset + info.laz.vlrLen);
      const po = info.pointOffset;
      const tOff = Number(new DataView(bytes.buffer, bytes.byteOffset + po, 8).getBigInt64(0, true));
      const ch = await run('lazChunks', { vlr, table: bytes.slice(tOff, info.evlrStart > tOff ? info.evlrStart : bytes.length), n: info.nPoints });
      const data = bytes.slice(po + 8, tOff);
      const prm = [info.format, info.recordLen, ...info.scale, ...info.offset, 0, ...lat.flat];
      const out = await run('decodeLaz', { prm, vlr, data, chunks: Array.from(ch) }, [data.buffer]);
      return columnsOf(out.buffer, info.nPoints, [2, 3, 5, 7, 8, 10].includes(info.format));
    }
    throw new Error(`EPT data type "${ept.dataType}" is not read`);
  };
  return s;
}

/** EPT "binary" node: the schema's dimensions per point, little-endian. */
function binaryNode(bytes, n, schema, lattice, hasRgb) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rec = schema.reduce((s, d) => s + d.size, 0);
  if (rec * n > bytes.length) throw new Error('EPT binary node is shorter than its point count');
  const offs = {};
  let o = 0;
  for (const d of schema) {
    offs[d.name] = { o, d };
    o += d.size;
  }
  const rd = (name, base) => {
    const e = offs[name];
    if (!e) return 0;
    const { d } = e;
    const p = base + e.o;
    let v;
    if (d.type === 'float') v = d.size === 8 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
    else if (d.type === 'signed') v = d.size === 4 ? dv.getInt32(p, true) : d.size === 2 ? dv.getInt16(p, true) : d.size === 1 ? dv.getInt8(p) : Number(dv.getBigInt64(p, true));
    else v = d.size === 4 ? dv.getUint32(p, true) : d.size === 2 ? dv.getUint16(p, true) : d.size === 1 ? dv.getUint8(p) : Number(dv.getBigUint64(p, true));
    return v * (d.scale ?? 1) + (d.offset ?? 0);
  };
  const c = { n, pos: new Float32Array(3 * n), time: new Float32Array(n), intensity: new Uint16Array(n), source: new Uint16Array(n), scan: new Int16Array(n), rgb: hasRgb ? new Uint16Array(3 * n) : null, class: new Uint8Array(n), ret: new Uint8Array(n), flags: new Uint8Array(n), user: new Uint8Array(n) };
  for (let i = 0; i < n; i++) {
    const p = i * rec;
    const X = rd('X', p);
    const Y = rd('Y', p);
    const [e, nn, dz] = latticeAt(lattice, X, Y);
    c.pos.set([e, nn, rd('Z', p) + dz], 3 * i);
    c.intensity[i] = rd('Intensity', p);
    c.class[i] = rd('Classification', p);
    c.ret[i] = (rd('ReturnNumber', p) & 15) | ((rd('NumberOfReturns', p) & 15) << 4);
    c.time[i] = rd('GpsTime', p);
    c.source[i] = rd('PointSourceId', p);
    if (hasRgb) c.rgb.set([rd('Red', p), rd('Green', p), rd('Blue', p)], 3 * i);
  }
  return c;
}

export { statsOf };
