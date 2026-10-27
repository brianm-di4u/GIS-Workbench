// LAS/LAZ reading (REQ-LDR-01/03, REQ-FMT-10): the header and VLRs/EVLRs by range, the CRS from
// WKT or GeoTIFF keys (horizontal through proj4js, vertical units and datum to HAE), then the
// records in parallel point-cloud workers — LAS by blocks, LAZ by runs of whole chunks — into
// columns in the local frame (DN-36), and the LOD index for budgeted rendering.

import { crsOf, converter } from '../geo/crs.js';
import { columnsOf } from '../wasm/pointcloud.js';

export const POINTCLOUD_EXT = /\.(las|laz|bpf|xyz|pts)$/i;

const UNITS = { 9001: 1, 9002: 0.3048, 9003: 1200 / 3937, 9030: 1852 };
const BLOCK = 400000; // points per decode job

/** Metres per degree of longitude and latitude on WGS 84 at `lat` (the local frame's scales). */
export function frameScales(lat) {
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - e2 * s * s;
  const N = a / Math.sqrt(w);
  const M = (a * (1 - e2)) / (w * Math.sqrt(w));
  return { kx: (N * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (M * Math.PI) / 180 };
}

/** Vertical datum code from a vertical EPSG code or CRS name. */
function verticalOf(epsg, name) {
  const t = `${epsg ?? ''} ${name ?? ''}`;
  if (/\b(5773|5171)\b|EGM96|EGM\s?1996/i.test(t)) return 'egm96';
  if (/\b(3855|1027)\b|EGM2008|EGM08/i.test(t)) return 'egm2008';
  if (/\b(5703|6360|8228|5103)\b|NAVD\s?88/i.test(t)) return 'navd88';
  if (/\b(4979|4326|6326)\b|ellipsoid/i.test(t)) return 'hae';
  return t.trim() ? 'other' : 'unstated';
}

/** The CRS of a LAS file: {crs (proj4js), label, hUnit, vUnit, vertical, warnings}. */
export function lasCrs(info, wkt, wktInfo) {
  const warnings = [];
  let crs = null;
  let hUnit = 1;
  let vUnit = 1;
  let vertical = 'unstated';
  let vname = '';
  if (wkt) {
    const w = wktInfo ?? {};
    crs = crsOf({ epsg: w.hEpsg, wkt: w.horizontal || wkt });
    if (!crs && w.hEpsg) crs = crsOf({ epsg: w.hEpsg });
    hUnit = w.geographic ? 1 : w.hUnit || 1;
    vUnit = w.vUnit || 1;
    vname = /\[\s*"([^"]+)"/.exec(w.vertical ?? '')?.[1] ?? '';
    vertical = w.vertical ? verticalOf(w.vEpsg, w.vertical) : 'unstated';
  } else if (info.geoKeys?.length) {
    const k = Object.fromEntries(info.geoKeys);
    const epsg = k[3072] && k[3072] !== 32767 ? k[3072] : k[2048] && k[2048] !== 32767 ? k[2048] : null;
    crs = epsg ? crsOf({ epsg }) : null;
    if (!crs && typeof k[3073] === 'string') crs = crsOf({ wkt: k[3073] });
    if (!crs && epsg) warnings.push(`EPSG:${epsg} is not in the embedded EPSG table`);
    hUnit = UNITS[k[3076]] ?? 1;
    vUnit = UNITS[k[4099]] ?? hUnit;
    vertical = k[4096] ? verticalOf(k[4096], '') : 'unstated';
    vname = k[4096] ? `EPSG:${k[4096]}` : '';
  }
  let local = false;
  // TE-015: a geographic CRS whose coordinates cannot be latitude/longitude (test files declare
  // EPSG:4326 over 0–226 "degrees") is not usable: fall back to the local frame and say so.
  const geographic = /\+proj=longlat|\+proj=lonlat/.test(String(crs?.def ?? '')) || /^EPSG:(4326|4979|4269|4258|4267)$/.test(crs?.label ?? '') || (wktInfo?.geographic && !!crs);
  if (crs && geographic && info.min && info.max && (info.min[1] < -90 || info.max[1] > 90 || info.min[0] < -180 || info.max[0] > 360)) {
    warnings.push(`${crs.label} is geographic, but the coordinates (X ${info.min[0]}…${info.max[0]}, Y ${info.min[1]}…${info.max[1]}) are not valid longitudes and latitudes; the CRS is ignored`);
    crs = null;
  }
  if (!crs && info.min && info.max) {
    // TE-013: many delivered and test clouds carry no CRS. Show them in a local metric frame (a
    // transverse Mercator tangent at 0°, 0° with the cloud's centre as false origin) rather than
    // refusing them; distances, areas and heights stay exact, geographic positions do not.
    const cx = (info.min[0] + info.max[0]) / 2;
    const cy = (info.min[1] + info.max[1]) / 2;
    crs = { def: `+proj=tmerc +lat_0=0 +lon_0=0 +k=1 +x_0=${cx} +y_0=${cy} +ellps=WGS84 +units=m +no_defs`, label: 'Local frame (no CRS in the file)', note: { name: 'local', acc: -1 } };
    local = true;
    warnings.push('No horizontal CRS in the file: shown in a local metric frame placed at 0°, 0°. Lengths, areas and heights are exact; map overlays, geographic coordinates and CE90 are not meaningful.');
  }
  if (vertical === 'navd88') warnings.push('NAVD88 heights are converted to HAE with EGM96 (no GEOID18 pack): about 1 m uncertainty');
  if (vertical === 'egm2008') warnings.push('EGM2008 heights are converted with EGM96: differences up to about 1 m');
  if (vertical === 'unstated') warnings.push('The file states no vertical CRS: heights are used as ellipsoidal (HAE)');
  if (vertical === 'other') warnings.push(`Vertical CRS ${vname} is not known: heights are used as ellipsoidal (HAE)`);
  return { crs, label: crs?.label ?? 'unknown CRS', hUnit, vUnit, vertical, vname, warnings, local };
}

const text = (u8, a, b) => new TextDecoder().decode(u8.subarray(a, b)).replace(/\0[\s\S]*$/, '');

/** Read the header, VLRs, EVLRs and CRS. `run(op, args)` runs on a point-cloud worker. */
export async function readLasHeader(file, run) {
  const read = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  let head = await read(0, Math.min(file.size, 4096));
  let info = await run('info', { head });
  if (info.need) {
    head = await read(0, info.need);
    info = await run('info', { head });
  }
  let wkt = info.wkt ?? null;
  let wktInfo = info.wktInfo ?? null;
  info.evlrs = [];
  if (info.nEvlrs > 0 && info.evlrStart > 0) {
    let pos = info.evlrStart;
    for (let i = 0; i < info.nEvlrs && pos + 60 <= file.size; i++) {
      const hb = await read(pos, pos + 60);
      const dv = new DataView(hb.buffer);
      const e = { user: text(hb, 2, 18), id: dv.getUint16(18, true), len: Number(dv.getBigUint64(20, true)), desc: text(hb, 28, 60), offset: pos + 60 };
      info.evlrs.push(e);
      if (e.user === 'LASF_Projection' && e.id === 2112 && !wkt) {
        wkt = text(await read(e.offset, e.offset + e.len), 0, e.len);
        wktInfo = await run('wkt', { text: wkt });
      }
      pos += 60 + e.len;
    }
  }
  const crs = lasCrs(info, wkt, wktInfo);
  return { info, wkt, wktInfo, crs };
}

/**
 * The CRS lattice (source X, Y → local east, north, height correction) over the header bounds,
 * the frame origin and scales. `undulation(lat, lon)` gives the geoid height for orthometric data.
 */
export function buildLattice(info, crs, undulation, n = 17) {
  const conv = converter(crs.crs);
  const [x0, y0] = [info.min[0], info.min[1]];
  const sx = Math.max(info.max[0] - x0, 1e-6);
  const sy = Math.max(info.max[1] - y0, 1e-6);
  const pad = 0.02;
  const ax = x0 - pad * sx;
  const ay = y0 - pad * sy;
  const dx = (sx * (1 + 2 * pad)) / (n - 1);
  const dy = (sy * (1 + 2 * pad)) / (n - 1);
  const [lonC, latC] = conv.toLonLat(x0 + sx / 2, y0 + sy / 2);
  if (!Number.isFinite(latC) || !Number.isFinite(lonC)) throw new Error(`${crs.label}: the cloud's bounds do not convert to latitude and longitude`);
  const origin = { lat0: latC, lon0: lonC, ...frameScales(latC) };
  const ortho = ['egm96', 'egm2008', 'navd88'].includes(crs.vertical);
  const nodes = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [lon, lat] = conv.toLonLat(ax + i * dx, ay + j * dy);
      nodes.push((lon - origin.lon0) * origin.kx, (lat - origin.lat0) * origin.ky, ortho ? undulation(lat, lon) : 0);
    }
  return { flat: [ax, ay, dx, dy, n, n, crs.vUnit, ...nodes], origin };
}

/** The inverse lattice (local east, north → X, Y in `crs`, height offset) over a local box. */
export function inverseLattice(origin, box, crs, dz = 0, n = 17) {
  const conv = converter(crs);
  const [e0, n0, e1, n1] = box;
  const dx = Math.max(e1 - e0, 1) / (n - 1);
  const dy = Math.max(n1 - n0, 1) / (n - 1);
  const nodes = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const e = e0 + i * dx;
      const nn = n0 + j * dy;
      const [x, y] = conv.fromLonLat(origin.lon0 + e / origin.kx, origin.lat0 + nn / origin.ky);
      nodes.push(x, y, typeof dz === 'function' ? dz(origin.lat0 + nn / origin.ky, origin.lon0 + e / origin.kx) : dz);
    }
  return [e0, n0, dx, dy, n, n, 1, ...nodes];
}

function allocate(n, rgb) {
  return {
    n,
    pos: new Float32Array(3 * n),
    time: new Float32Array(n),
    intensity: new Uint16Array(n),
    source: new Uint16Array(n),
    scan: new Int16Array(n),
    rgb: rgb ? new Uint16Array(3 * n) : null,
    class: new Uint8Array(n),
    ret: new Uint8Array(n),
    flags: new Uint8Array(n),
    user: new Uint8Array(n),
  };
}

const FIELDS = ['pos', 'time', 'intensity', 'source', 'scan', 'rgb', 'class', 'ret', 'flags', 'user'];
const WIDTH = { pos: 3, rgb: 3 };

/**
 * Read a LAS/LAZ file into a point cloud. opts: {pool, undulation, onProgress, label}. Returns
 * {name, info, wkt, crs, origin, t0, ...columns, stats, tiles, ms}.
 */
export async function readLas(file, { pool, undulation, onProgress, ensureGeoid } = {}) {
  const t0ms = performance.now();
  const run = (op, args, transfer = []) => pool.run(op, args, { kind: 'pointcloud', transfer, label: `${op} ${file.name}`, timeout: 600000 });
  const { info, wkt, crs } = await readLasHeader(file, run);
  if (!crs.crs) throw new Error(`${file.name}: no usable coordinate reference system (${crs.warnings.join('; ') || 'no WKT or GeoTIFF keys'})`);
  if (['egm96', 'egm2008', 'navd88'].includes(crs.vertical)) await ensureGeoid?.();
  const lat = buildLattice(info, crs, undulation);
  const n = info.nPoints;
  if (!n) throw new Error(`${file.name}: the file holds no points`);
  const fmt = info.format;
  const hasRgb = [2, 3, 5, 7, 8, 10].includes(fmt);
  const hasTime = ![0, 2].includes(fmt);
  const prmOf = (t0) => [fmt, info.recordLen, ...info.scale, ...info.offset, t0, ...lat.flat];
  const read = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  // Jobs: [{first point, count, make: (t0) => job promise}].
  const jobs = [];
  let lazVlr = null;
  let tOrigin = 0;
  if (!info.compressed) {
    const po = info.pointOffset;
    const rl = info.recordLen;
    if (po + n * rl > file.size) throw new Error(`${file.name}: the point data is truncated (${n} points of ${rl} bytes do not fit)`);
    if (hasTime) {
      const r0 = await read(po, po + rl);
      tOrigin = Math.round(new DataView(r0.buffer).getFloat64(fmt >= 6 ? 22 : 20, true));
    }
    for (let s = 0; s < n; s += BLOCK) {
      const c = Math.min(BLOCK, n - s);
      jobs.push({ first: s, count: c, make: async (t0) => {
        const raw = await read(po + s * rl, po + (s + c) * rl);
        return run('decodeLas', { prm: prmOf(t0), raw }, [raw.buffer]);
      } });
    }
  } else {
    if (!info.laz) throw new Error(`${file.name}: compressed, but the laszip VLR is missing`);
    lazVlr = await read(info.laz.vlrOffset, info.laz.vlrOffset + info.laz.vlrLen);
    const po = info.pointOffset;
    const off = Number(new DataView((await read(po, po + 8)).buffer).getBigInt64(0, true));
    const end = info.evlrStart > off ? info.evlrStart : file.size;
    if (!(off > po && off < file.size)) {
      // TE-022: a streamed LAZ (no chunk table): one sequential job over the whole point stream.
      if (n * info.recordLen > 1 << 30) throw new Error(`${file.name}: a streamed LAZ (no chunk table) above 1 GiB of points is not read`);
      jobs.push({ first: 0, count: n, make: async (t0) => {
        const data = await read(po, info.evlrStart > po ? info.evlrStart : file.size);
        return run('decodeLazStream', { prm: prmOf(t0), vlr: lazVlr.slice(), data, n }, [data.buffer]);
      } });
    }
    if (!jobs.length) {
      const table = await read(off, end);
      const ch = await run('lazChunks', { vlr: lazVlr, table, n });
      // Runs of whole chunks of about BLOCK points.
      let first = 0;
      let byte = po + 8;
      for (let i = 0; i < ch.length / 2; ) {
        const run0 = [];
        let pts = 0;
        let bytes = 0;
        while (i < ch.length / 2 && (pts === 0 || pts + ch[2 * i] <= BLOCK)) {
          run0.push(ch[2 * i], ch[2 * i + 1]);
          pts += ch[2 * i];
          bytes += ch[2 * i + 1];
          i++;
        }
        const [a, b, f] = [byte, byte + bytes, first];
        jobs.push({ first: f, count: pts, make: async (t0) => {
          const data = await read(a, b);
          return run('decodeLaz', { prm: prmOf(t0), vlr: lazVlr, data, chunks: run0 }, [data.buffer]);
        } });
        first += pts;
        byte += bytes;
      }
      if (first !== n) throw new Error(`${file.name}: the chunk table holds ${first} points, the header ${n}`);
    }
    if (hasTime && jobs.length) {
      // GPS-time origin from the first chunk (f32 times relative to 0 are good to ~2 min: enough).
      const b0 = await jobs[0].make(0);
      const c0 = columnsOf(b0.buffer, jobs[0].count, hasRgb);
      tOrigin = Math.round(c0.time[0]);
    }
  }
  const out = allocate(n, hasRgb);
  let done = 0;
  await Promise.all(
    jobs.map(async (j) => {
      const b = await j.make(tOrigin);
      const c = columnsOf(b.buffer, j.count, hasRgb);
      for (const f of FIELDS) if (c[f]) out[f].set(c[f], j.first * (WIDTH[f] ?? 1));
      done += j.count;
      onProgress?.(done / n);
    }),
  );
  const decodeMs = performance.now() - t0ms;
  const tStats = performance.now();
  const stats = statsOf(out, hasRgb);
  // LOD index and reordering.
  const area = Math.max(1, (stats.max[0] - stats.min[0]) * (stats.max[1] - stats.min[1]));
  const tile = Math.min(500, Math.max(15, Math.sqrt((area * 100000) / n)));
  const tIndex = performance.now();
  const ix = await run('index', { pos: out.pos, tile, s0: tile / 16, maxLevel: 12 });
  const tReorder = performance.now();
  reorder(out, ix.perm);
  // order[k] = the file index of point k.
  return { order: ix.perm, name: file.name, size: file.size, info, wkt, crs, origin: lat.origin, t0: tOrigin, ...out, hasRgb, hasTime, stats, tiles: ix.tiles, tileSize: tile, ms: { decode: Math.round(decodeMs), stats: Math.round(tIndex - tStats), index: Math.round(tReorder - tIndex), reorder: Math.round(performance.now() - tReorder), total: Math.round(performance.now() - t0ms), jobs: jobs.length } };
}

export function reorder(c, perm) {
  const n = perm.length;
  for (const f of FIELDS) {
    const a = c[f];
    if (!a) continue;
    const w = WIDTH[f] ?? 1;
    const b = new a.constructor(n * w);
    if (w === 1) for (let k = 0; k < n; k++) b[k] = a[perm[k]];
    else
      for (let k = 0; k < n; k++) {
        const s = perm[k] * 3;
        b[3 * k] = a[s];
        b[3 * k + 1] = a[s + 1];
        b[3 * k + 2] = a[s + 2];
      }
    c[f] = b;
  }
}

export function statsOf(c, hasRgb) {
  const n = c.n;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const classes = {};
  const returns = {};
  const cls = new Uint32Array(256);
  let iMax = 0;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let k = 0; k < n; k++) {
    for (let a = 0; a < 3; a++) {
      const v = c.pos[3 * k + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
    cls[c.class[k]]++;
    const r = c.ret[k];
    const key = `${r & 15}/${r >> 4}`;
    returns[key] = (returns[key] ?? 0) + 1;
    if (c.intensity[k] > iMax) iMax = c.intensity[k];
    if (c.time[k] < tMin) tMin = c.time[k];
    if (c.time[k] > tMax) tMax = c.time[k];
  }
  for (let i = 0; i < 256; i++) if (cls[i]) classes[i] = cls[i];
  // Intensity 2–98 % for the colour stretch.
  const hist = new Uint32Array(65536);
  for (let k = 0; k < n; k++) hist[c.intensity[k]]++;
  const pct = (p) => {
    let s = 0;
    for (let i = 0; i < 65536; i++) {
      s += hist[i];
      if (s >= p * n) return i;
    }
    return iMax;
  };
  // Height range for the elevation ramp: 1–99 % of a sample (noise points do not stretch it).
  const step = Math.max(1, Math.floor(n / 200000));
  const zs = [];
  for (let k = 0; k < n; k += step) zs.push(c.pos[3 * k + 2]);
  zs.sort((a, b) => a - b);
  const zRange = zs.length ? [zs[Math.floor(zs.length * 0.01)], zs[Math.min(zs.length - 1, Math.floor(zs.length * 0.99))]] : [min[2], max[2]];
  let rgbMax = 0;
  if (hasRgb) for (let k = 0; k < c.rgb.length; k++) if (c.rgb[k] > rgbMax) rgbMax = c.rgb[k];
  return { min, max, zRange, classes, returns, intensity: [pct(0.02), Math.max(pct(0.98), pct(0.02) + 1)], iMax, time: [tMin, tMax], rgbMax, rgb16: rgbMax > 255 };
}
