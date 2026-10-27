// ESRI Shapefile reader (.shp + .dbf + .prj + .cpg), DOM-free (REQ-FMT-12, REQ-EXT-21).
// Bounded: every record length is checked against the file; attribute bags have no
// prototype. Returns GeoJSON-like features in the file's CRS (the caller reprojects).

import { bag } from '../core/util.js';

const MAX_RECORDS = 5_000_000;

function readShp(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error('not a shapefile (.shp magic 9994 missing)');
  const fileLen = dv.getInt32(24, false) * 2;
  const shapeType = dv.getInt32(32, true);
  const bbox = [dv.getFloat64(36, true), dv.getFloat64(44, true), dv.getFloat64(52, true), dv.getFloat64(60, true)];
  const end = Math.min(fileLen, buf.byteLength);
  const geoms = [];
  let p = 100;
  while (p + 8 <= end) {
    if (geoms.length >= MAX_RECORDS) throw new Error('too many shapefile records');
    const len = dv.getInt32(p + 4, false) * 2;
    const rs = p + 8;
    if (len < 4 || rs + len > end) throw new Error(`shapefile record at ${p} overruns the file`);
    geoms.push(readShape(dv, rs, len));
    p = rs + len;
  }
  return { shapeType, bbox, geoms };
}

function readShape(dv, o, len) {
  const t = dv.getInt32(o, true);
  const base = t % 10; // 1 point, 3 polyline, 5 polygon, 8 multipoint; +10 Z, +20 M
  const hasZ = t >= 11 && t <= 18;
  if (t === 0) return null;
  if (base === 1) {
    const c = [dv.getFloat64(o + 4, true), dv.getFloat64(o + 12, true)];
    if (hasZ && len >= 28) c.push(dv.getFloat64(o + 20, true));
    return { type: 'Point', coordinates: c };
  }
  if (base === 8) {
    const n = dv.getInt32(o + 36, true);
    if (n < 0 || 40 + n * 16 > len) throw new Error('bad multipoint');
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([dv.getFloat64(o + 40 + i * 16, true), dv.getFloat64(o + 48 + i * 16, true)]);
    if (hasZ) {
      const zo = o + 40 + n * 16 + 16;
      if (zo + n * 8 <= o + len) for (let i = 0; i < n; i++) pts[i].push(dv.getFloat64(zo + i * 8, true));
    }
    return { type: 'MultiPoint', coordinates: pts };
  }
  if (base === 3 || base === 5) {
    const nParts = dv.getInt32(o + 36, true);
    const nPts = dv.getInt32(o + 40, true);
    if (nParts < 0 || nPts < 0 || 44 + nParts * 4 + nPts * 16 > len) throw new Error('bad poly record');
    const parts = [];
    for (let i = 0; i < nParts; i++) parts.push(dv.getInt32(o + 44 + i * 4, true));
    const po = o + 44 + nParts * 4;
    const zo = po + nPts * 16 + 16;
    const z = hasZ && zo + nPts * 8 <= o + len;
    const rings = [];
    for (let k = 0; k < nParts; k++) {
      const s = parts[k];
      const e = k + 1 < nParts ? parts[k + 1] : nPts;
      if (s < 0 || e > nPts || s > e) throw new Error('bad part index');
      const ring = [];
      for (let i = s; i < e; i++) {
        const c = [dv.getFloat64(po + i * 16, true), dv.getFloat64(po + i * 16 + 8, true)];
        if (z) c.push(dv.getFloat64(zo + i * 8, true));
        ring.push(c);
      }
      rings.push(ring);
    }
    if (base === 3) return rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings };
    return polygonsFromRings(rings);
  }
  return null; // MultiPatch and others are not read
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2; // > 0 clockwise in x-right/y-up (shapefile outer rings are clockwise)
}

function pointInRing(pt, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Group shapefile rings: clockwise = outer, counter-clockwise = hole of the outer that contains it. */
function polygonsFromRings(rings) {
  const outers = [];
  const holes = [];
  for (const r of rings) (ringArea(r) >= 0 ? outers : holes).push(r);
  if (!outers.length) return { type: 'Polygon', coordinates: rings };
  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    const target = polys.find((p) => pointInRing(h[0], p[0])) ?? polys[0];
    target.push(h);
  }
  // GeoJSON wants outer rings counter-clockwise (RFC 7946 §3.1.6): reverse.
  for (const p of polys) for (const r of p) r.reverse();
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

function readDbf(buf, encoding = 'utf-8') {
  if (!buf || buf.byteLength < 33) return { fields: [], rows: [] };
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(4, true);
  const hlen = dv.getUint16(8, true);
  const rlen = dv.getUint16(10, true);
  if (n > MAX_RECORDS || hlen > buf.byteLength) throw new Error('bad DBF header');
  let dec;
  try {
    dec = new TextDecoder(encoding);
  } catch {
    dec = new TextDecoder('utf-8');
  }
  const fields = [];
  for (let p = 32; p + 32 <= hlen && buf[p] !== 0x0d; p += 32) {
    let name = '';
    for (let i = 0; i < 11 && buf[p + i]; i++) name += String.fromCharCode(buf[p + i]);
    fields.push({ name, type: String.fromCharCode(buf[p + 11]), len: buf[p + 16], dec: buf[p + 17] });
  }
  const rows = [];
  for (let r = 0; r < n; r++) {
    const o = hlen + r * rlen;
    if (o + rlen > buf.byteLength) break;
    const row = bag();
    let q = o + 1;
    for (const f of fields) {
      const raw = dec.decode(buf.subarray(q, q + f.len)).trim();
      q += f.len;
      let v = raw;
      if (f.type === 'N' || f.type === 'F') v = raw === '' ? null : Number(raw);
      else if (f.type === 'L') v = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
      else if (f.type === 'D') v = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw || null;
      row[f.name] = v;
    }
    rows.push(row);
  }
  return { fields, rows };
}

/**
 * Read a shapefile set. `files` maps lower-case extensions (shp, dbf, prj, cpg) to Uint8Arrays.
 * Returns { features, fields, prj, shapeType, bbox }.
 */
export function readShapefile(files) {
  if (!files.shp) throw new Error('the .shp member is missing');
  const shp = readShp(files.shp);
  const cpg = files.cpg ? new TextDecoder().decode(files.cpg).trim().toLowerCase() : 'utf-8';
  const enc = /^(utf-?8|65001)$/.test(cpg) ? 'utf-8' : /1252/.test(cpg) ? 'windows-1252' : /8859/.test(cpg) ? 'iso-8859-1' : 'utf-8';
  const dbf = readDbf(files.dbf, enc);
  const features = shp.geoms.map((g, i) => ({ type: 'Feature', geometry: g, properties: dbf.rows[i] ?? bag() }));
  const prj = files.prj ? new TextDecoder().decode(files.prj) : null;
  return { features, fields: dbf.fields, prj, shapeType: shp.shapeType, bbox: shp.bbox, encoding: enc };
}
