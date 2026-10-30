// Vector interchange (REQ-EXT-21, REQ-EXT-23, REQ-FMT-12, SCN-17, Research/13 §5): GeoJSON
// (RFC 7946: WGS 84 lon/lat, Z = HAE, no "crs" member), Shapefile (own reader and writer: Z
// types, .prj, .cpg UTF-8, collision-safe 10-character field names, 254-byte text on a code
// point boundary, ring order) and KML 2.2/KMZ (own reader and writer: absolute altitudes as
// EGM96 heights, Schema/SchemaData, shared Styles and StyleMaps, icons). Every read and write
// returns a round-trip report (§5.8).
//
// A layer in transit is {name, fields: [{name, type}], features: [{geom, attrs, name,
// description, style}], assets: {href: Uint8Array}}; type is string | integer | number |
// boolean | date.

import { fromGeoJSON, toGeoJSON, parts, polygonGroups, signedArea, pointInRing, fromParts, isPolygonal, isLinear } from './geom.js';
import { minOf, maxOf } from '../core/util.js';

const enc = new TextEncoder();

export function newReport(format, dir) {
  return { format, direction: dir, features_in: 0, features_out: 0, by_geometry: {}, fields_renamed: [], text_truncated: {}, dropped: { M_values: 0, curves_densified: 0, styles: 'kept' }, crs: 'EPSG:4326 (WGS 84 lon/lat)', vertical: 'HAE (EPSG:4979)', encoding: 'UTF-8', warnings: [] };
}
const countGeom = (rep, t) => (rep.by_geometry[t] = (rep.by_geometry[t] ?? 0) + 1);

/** Field types inferred from values. */
export function inferFields(features) {
  const types = new Map();
  for (const f of features)
    for (const [k, v] of Object.entries(f.attrs ?? {})) {
      if (v === null || v === undefined || v === '') {
        if (!types.has(k)) types.set(k, null);
        continue;
      }
      const t = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? 'date' : 'string';
      const prev = types.get(k);
      types.set(k, !prev ? t : prev === t ? t : prev === 'integer' && t === 'number' ? 'number' : prev === 'number' && t === 'integer' ? 'number' : 'string');
    }
  return [...types].map(([name, type]) => ({ name, type: type ?? 'string' }));
}

// ---- GeoJSON ----

/**
 * GeoJSON text → object. A GeoJSON Text Sequence (RFC 8142, record separators) or newline-delimited
 * GeoJSON (one Feature per line: Microsoft building footprints, GDAL's GeoJSONSeq) becomes a
 * FeatureCollection.
 */
export function parseGeoJSONText(text) {
  const t = text.replace(/^﻿/, '');
  try {
    return JSON.parse(t);
  } catch (e) {
    const lines = t.split(/[\r\n\u001e]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2 || !lines[0].startsWith('{')) throw e;
    return { type: 'FeatureCollection', features: lines.map((l, i) => {
      try {
        const f = JSON.parse(l);
        return f.type === 'Feature' ? f : { type: 'Feature', geometry: f, properties: {} };
      } catch {
        throw new Error(`line ${i + 1} of the GeoJSON sequence is not JSON`);
      }
    }) };
  }
}

export function readGeoJSON(text, { name = 'GeoJSON', reproject = null } = {}) {
  const rep = newReport('GeoJSON', 'import');
  const j = typeof text === 'string' ? parseGeoJSONText(text) : text;
  // Any other JSON (a STAC item, a metadata file) is refused by name rather than read as an empty geometry.
  if (!j || !/^(FeatureCollection|Feature|Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection)$/.test(j.type)) throw new Error(`not GeoJSON (the JSON has ${j?.type ? `type "${String(j.type).slice(0, 40)}"` : 'no "type" member'}; GeoJSON needs a FeatureCollection, Feature or geometry)`);
  const feats = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [{ type: 'Feature', geometry: j, properties: {} }];
  let conv = null;
  const crsName = j.crs?.properties?.name;
  if (crsName && !/CRS84|EPSG:+4326$|EPSG::4326/.test(crsName)) {
    conv = reproject?.(crsName);
    rep.warnings.push(conv ? `legacy "crs" member ${crsName}: reprojected to WGS 84` : `legacy "crs" member ${crsName} not understood; coordinates taken as WGS 84`);
    rep.crs = `${crsName} (reprojected)`;
  }
  const out = [];
  for (const f of feats) {
    rep.features_in++;
    let g = fromGeoJSON(f.geometry);
    if (!g) {
      rep.warnings.push(`feature ${f.id ?? rep.features_in} has no geometry; skipped`);
      continue;
    }
    const geoms = Array.isArray(g) ? g : [g];
    if (Array.isArray(g)) rep.warnings.push(`a GeometryCollection was split into ${g.length} features`);
    for (let gg of geoms) {
      if (conv) gg = { ...gg, xyz: gg.xyz.map((v, i) => v) };
      if (conv)
        for (let i = 0; i < gg.xyz.length; i += 3) {
          const [lon, lat] = conv(gg.xyz[i], gg.xyz[i + 1]);
          gg.xyz[i] = lon;
          gg.xyz[i + 1] = lat;
        }
      const { name: nm, description, ...attrs } = f.properties ?? {};
      out.push({ geom: gg, attrs, name: nm ?? null, description: description ?? null, fid: f.id ?? null });
      countGeom(rep, gg.type);
    }
  }
  rep.features_out = out.length;
  return { layer: { name, fields: inferFields(out), features: out, assets: {} }, report: rep };
}

export function writeGeoJSON(layer, { schema = 'gisworkbench', digits = 9 } = {}) {
  const rep = newReport('GeoJSON', 'export');
  const features = layer.features.map((f, i) => {
    rep.features_in++;
    countGeom(rep, f.geom.type);
    const props = { ...f.attrs };
    if (f.name !== null && f.name !== undefined) props.name = f.name;
    if (f.description) props.description = f.description;
    return { type: 'Feature', id: f.fid ?? f.ufi ?? i + 1, geometry: toGeoJSON(f.geom, digits), properties: props };
  });
  rep.features_out = features.length;
  rep.dropped.styles = 'not written (GeoJSON has no style model)';
  const fc = { type: 'FeatureCollection', name: layer.name, x_workbench: { schema, version: 1, vertical: 'EPSG:4979' }, features };
  return { text: JSON.stringify(fc), report: rep };
}

// ---- Shapefile ----

const SHP = { point: 1, line: 3, polygon: 5, multipoint: 8 };
const familyOf = (t) => (t === 'Point' || t === 'MultiPoint' ? 'point' : t === 'LineString' || t === 'MultiLineString' ? 'line' : 'polygon');

/** UTF-8 bytes of s cut to at most n bytes on a code-point boundary; [bytes, truncated]. */
export function utf8Cut(s, n) {
  const b = enc.encode(s);
  if (b.length <= n) return [b, false];
  let k = n;
  while (k > 0 && (b[k] & 0xc0) === 0x80) k--;
  return [b.subarray(0, k), true];
}

/** Deterministic 10-character DBF names: ASCII, truncated, de-duplicated with _1, _2 … */
export function dbfNames(fields) {
  const used = new Set();
  return fields.map((f) => {
    const base = f.name.normalize('NFKD').replace(/[^\x21-\x7e]/g, '_').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 10) || 'FIELD';
    let nm = base;
    for (let i = 1; used.has(nm.toUpperCase()); i++) nm = `${base.slice(0, 10 - String(i).length - 1)}_${i}`;
    used.add(nm.toUpperCase());
    return nm;
  });
}

export const ESRI_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

function writeDbf(features, fields, rep) {
  const names = dbfNames(fields);
  fields.forEach((f, i) => names[i] !== f.name && rep.fields_renamed.push([f.name, names[i]]));
  const defs = fields.map((f, i) => {
    if (f.type === 'integer') return { name: names[i], t: 'N', len: 18, dec: 0, f };
    if (f.type === 'number') return { name: names[i], t: 'N', len: 24, dec: 15, f };
    if (f.type === 'boolean') return { name: names[i], t: 'L', len: 1, dec: 0, f };
    if (f.type === 'date') return { name: names[i], t: 'D', len: 8, dec: 0, f };
    const max = Math.max(1, ...features.map((x) => Math.min(254, enc.encode(String(x.attrs?.[f.name] ?? '')).length)));
    return { name: names[i], t: 'C', len: max, dec: 0, f };
  });
  const recLen = 1 + defs.reduce((s, d) => s + d.len, 0);
  const headLen = 32 + 32 * defs.length + 1;
  const buf = new Uint8Array(headLen + recLen * features.length + 1);
  const dv = new DataView(buf.buffer);
  const now = new Date();
  buf[0] = 0x03;
  buf[1] = now.getUTCFullYear() - 1900;
  buf[2] = now.getUTCMonth() + 1;
  buf[3] = now.getUTCDate();
  dv.setUint32(4, features.length, true);
  dv.setUint16(8, headLen, true);
  dv.setUint16(10, recLen, true);
  defs.forEach((d, i) => {
    const o = 32 + 32 * i;
    buf.set(enc.encode(d.name), o);
    buf[o + 11] = d.t.charCodeAt(0);
    buf[o + 16] = d.len;
    buf[o + 17] = d.dec;
  });
  buf[headLen - 1] = 0x0d;
  features.forEach((ft, r) => {
    let o = headLen + r * recLen;
    buf[o++] = 0x20;
    for (const d of defs) {
      const v = ft.attrs?.[d.f.name];
      let b;
      if (v === null || v === undefined || v === '' || (d.t === 'N' && !Number.isFinite(Number(v)))) b = enc.encode(d.t === 'L' ? '?' : '');
      else if (d.t === 'N') b = enc.encode((d.dec ? Number(v).toFixed(d.dec) : String(Math.round(Number(v)))).slice(0, d.len).padStart(d.len, ' '));
      else if (d.t === 'L') b = enc.encode(v === true || v === 'true' || v === 'T' ? 'T' : 'F');
      else if (d.t === 'D') b = enc.encode(String(v).replace(/-/g, '').slice(0, 8));
      else {
        const [bytes, cut] = utf8Cut(String(v), d.len);
        if (cut) rep.text_truncated[d.f.name] = (rep.text_truncated[d.f.name] ?? 0) + 1;
        b = bytes;
      }
      buf.fill(0x20, o, o + d.len);
      buf.set(b.subarray(0, d.len), d.t === 'N' ? o + d.len - Math.min(b.length, d.len) : o);
      o += d.len;
    }
  });
  buf[buf.length - 1] = 0x1a;
  return buf;
}

function shpRecord(f, type, hasZ) {
  const g = f.geom;
  const zt = hasZ ? 10 : 0;
  if (type === SHP.point) {
    const b = new DataView(new ArrayBuffer(hasZ ? 36 : 20));
    b.setInt32(0, type + zt, true);
    b.setFloat64(4, g.xyz[0], true);
    b.setFloat64(12, g.xyz[1], true);
    if (hasZ) {
      b.setFloat64(20, g.xyz[2], true);
      b.setFloat64(28, 0, true); // M
    }
    return new Uint8Array(b.buffer);
  }
  // Parts in shapefile order: outer rings clockwise, holes counter-clockwise.
  let ps;
  if (type === SHP.polygon) ps = polygonGroups(g).flatMap((rs) => rs.map((r, i) => (signedArea(r) > 0 === (i === 0) ? [...r].reverse() : r)).map((r) => [...r, r[0]]));
  else if (type === SHP.multipoint) ps = parts(g).map((p) => p.slice(0, 1));
  else ps = parts(g);
  const pts = ps.flat();
  const np = type === SHP.multipoint ? 0 : ps.length;
  const n = pts.length;
  const size = 4 + 32 + (type === SHP.multipoint ? 4 : 8) + 4 * np + 16 * n + (hasZ ? 16 + 8 * n : 0);
  const b = new DataView(new ArrayBuffer(size));
  let o = 0;
  b.setInt32(o, type + zt, true);
  o += 4;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  for (const v of [minOf(xs), minOf(ys), maxOf(xs), maxOf(ys)]) {
    b.setFloat64(o, v, true);
    o += 8;
  }
  if (type !== SHP.multipoint) {
    b.setInt32(o, np, true);
    o += 4;
  }
  b.setInt32(o, n, true);
  o += 4;
  let k = 0;
  for (const p of ps.slice(0, np)) {
    b.setInt32(o, k, true);
    o += 4;
    k += p.length;
  }
  for (const p of pts) {
    b.setFloat64(o, p[0], true);
    b.setFloat64(o + 8, p[1], true);
    o += 16;
  }
  if (hasZ) {
    const zs = pts.map((p) => p[2] ?? 0);
    b.setFloat64(o, Math.min(...zs), true);
    b.setFloat64(o + 8, Math.max(...zs), true);
    o += 16;
    for (const z of zs) {
      b.setFloat64(o, z, true);
      o += 8;
    }
  }
  return new Uint8Array(b.buffer);
}

function shpHeader(dv, lenWords, type, box) {
  dv.setInt32(0, 9994, false);
  dv.setInt32(24, lenWords, false);
  dv.setInt32(28, 1000, true);
  dv.setInt32(32, type, true);
  box.forEach((v, i) => dv.setFloat64(36 + 8 * i, v, true));
}

/** One .shp/.shx/.dbf/.prj/.cpg set per geometry family; returns {files, report}. */
export function writeShapefile(layer) {
  const rep = newReport('ESRI Shapefile', 'export');
  rep.crs = 'EPSG:4326 (.prj written)';
  rep.encoding = 'UTF-8 (.cpg written)';
  rep.dropped.styles = 'not supported by Shapefile';
  const fams = { point: [], line: [], polygon: [] };
  for (const f of layer.features) {
    rep.features_in++;
    fams[familyOf(f.geom.type)].push(f);
  }
  const files = {};
  // Feature names and descriptions travel as the first DBF fields.
  const hasName = layer.features.some((f) => f.name !== null && f.name !== undefined && f.name !== '');
  const hasDesc = layer.features.some((f) => f.description);
  const fields = [...(hasName ? [{ name: 'name', type: 'string' }] : []), ...(hasDesc ? [{ name: 'description', type: 'string' }] : []), ...(layer.fields?.length ? layer.fields : inferFields(layer.features)).filter((f) => f.name !== 'name' && f.name !== 'description')];
  for (const k of Object.keys(fams)) fams[k] = fams[k].map((f) => ({ ...f, attrs: { ...(hasName ? { name: f.name ?? null } : {}), ...(hasDesc ? { description: f.description ?? null } : {}), ...f.attrs } }));
  const used = Object.entries(fams).filter(([, v]) => v.length);
  const stem = (layer.name || 'layer').replace(/[^\w.-]+/g, '_');
  for (const [fam, feats] of used) {
    const base = used.length > 1 ? `${stem}_${fam}s` : stem;
    const multi = fam === 'point' && feats.some((f) => f.geom.type === 'MultiPoint');
    const type = fam === 'point' ? (multi ? SHP.multipoint : SHP.point) : SHP[fam];
    const hasZ = feats.some((f) => f.geom.xyz.some((v, i) => i % 3 === 2 && v !== 0));
    const recs = feats.map((f) => shpRecord(f, type, hasZ));
    feats.forEach((f) => countGeom(rep, `${{ 1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint' }[type]}${hasZ ? 'Z' : ''}`));
    // One pass over the coordinates: spreading them into Math.min overflowed the stack on country
    // outlines, and flatMap does not flatten the typed arrays FlatGeobuf and GeoParquet give (TE 2.0.4).
    const box = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity, 0, 0];
    for (const f of feats) {
      const a = f.geom.xyz;
      for (let i = 0; i + 2 < a.length; i += 3) {
        box[0] = Math.min(box[0], a[i]);
        box[1] = Math.min(box[1], a[i + 1]);
        box[2] = Math.max(box[2], a[i]);
        box[3] = Math.max(box[3], a[i + 1]);
        box[4] = Math.min(box[4], a[i + 2]);
        box[5] = Math.max(box[5], a[i + 2]);
      }
    }
    if (!hasZ) [box[4], box[5]] = [0, 0];
    const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.length, 0);
    const shp = new Uint8Array(shpLen);
    const shx = new Uint8Array(100 + 8 * recs.length);
    const dv = new DataView(shp.buffer);
    const dx = new DataView(shx.buffer);
    shpHeader(dv, shpLen / 2, type + (hasZ ? 10 : 0), box);
    shpHeader(dx, shx.length / 2, type + (hasZ ? 10 : 0), box);
    let o = 100;
    recs.forEach((r, i) => {
      dx.setInt32(100 + 8 * i, o / 2, false);
      dx.setInt32(104 + 8 * i, r.length / 2, false);
      dv.setInt32(o, i + 1, false);
      dv.setInt32(o + 4, r.length / 2, false);
      shp.set(r, o + 8);
      o += 8 + r.length;
    });
    const rep0 = { ...rep, fields_renamed: [], text_truncated: {} };
    files[`${base}.shp`] = shp;
    files[`${base}.shx`] = shx;
    files[`${base}.dbf`] = writeDbf(feats, fields, rep0);
    if (!rep.fields_renamed.length) rep.fields_renamed.push(...rep0.fields_renamed);
    for (const [k, v] of Object.entries(rep0.text_truncated)) rep.text_truncated[k] = (rep.text_truncated[k] ?? 0) + v;
    files[`${base}.prj`] = enc.encode(ESRI_WGS84);
    files[`${base}.cpg`] = enc.encode('UTF-8');
    rep.features_out += feats.length;
  }
  if (rep.fields_renamed.length) files[`${stem}_fieldnames.csv`] = enc.encode(`original,dbf\r\n${rep.fields_renamed.map(([a, b]) => `"${a.replace(/"/g, '""')}",${b}`).join('\r\n')}\r\n`);
  return { files, report: rep };
}

function readDbf(u8, encoding = 'utf-8') {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const n = dv.getUint32(4, true);
  const headLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  const dec = new TextDecoder(encoding);
  const fields = [];
  for (let o = 32; o < headLen - 1 && u8[o] !== 0x0d; o += 32) {
    const nm = new TextDecoder('latin1').decode(u8.subarray(o, o + 11)).replace(/\0.*$/, '');
    fields.push({ name: nm, t: String.fromCharCode(u8[o + 11]), len: u8[o + 16], dec: u8[o + 17] });
  }
  const rows = [];
  for (let r = 0; r < n; r++) {
    let o = headLen + r * recLen + 1;
    const row = {};
    for (const f of fields) {
      const raw = dec.decode(u8.subarray(o, o + f.len));
      o += f.len;
      const s = raw.trim();
      if (f.t === 'N' || f.t === 'F') row[f.name] = s === '' || /^\*+$/.test(s) ? null : Number(s);
      else if (f.t === 'L') row[f.name] = /^[TtYy]$/.test(s) ? true : /^[FfNn]$/.test(s) ? false : null;
      else if (f.t === 'D') row[f.name] = /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
      else row[f.name] = raw.replace(/[\s\0]+$/, '') || null;
    }
    rows.push(row);
  }
  const types = fields.map((f) => ({ name: f.name, type: f.t === 'N' || f.t === 'F' ? (f.dec ? 'number' : 'integer') : f.t === 'L' ? 'boolean' : f.t === 'D' ? 'date' : 'string' }));
  return { rows, fields: types };
}

/** Read one shapefile set {shp, dbf?, prj?, cpg?}; `reproject(wkt)` → (x, y) → [lon, lat] or null. */
export function readShapefile({ shp, dbf = null, prj = null, cpg = null }, { name = 'Shapefile', reproject = null } = {}) {
  const rep = newReport('ESRI Shapefile', 'import');
  const encoding = (cpg ? String(cpg).trim() : '') || 'UTF-8';
  rep.encoding = cpg ? `${encoding} (.cpg)` : 'UTF-8 (no .cpg; assumed)';
  let label = 'utf-8';
  try {
    new TextDecoder(encoding.toLowerCase().replace(/^(\d+)$/, 'windows-$1'));
    label = encoding.toLowerCase().replace(/^(\d+)$/, 'windows-$1');
  } catch {
    rep.warnings.push(`code page "${encoding}" not known; read as UTF-8`);
  }
  let conv = null;
  if (prj && !/GEOGCS\[[^\]]*WGS[ _]?(19)?84/i.test(prj) || (prj && /PROJCS/i.test(prj))) {
    conv = reproject?.(prj);
    rep.crs = conv ? `${/\[\s*"([^"]+)"/.exec(prj)?.[1] ?? 'projected'} (.prj; reprojected to WGS 84 for display, written back as WGS 84)` : 'unknown .prj; coordinates taken as WGS 84';
    if (!conv) rep.warnings.push('the .prj could not be read; coordinates are taken as WGS 84 lon/lat');
  } else rep.crs = prj ? 'WGS 84 (.prj)' : 'no .prj; WGS 84 assumed';
  const dv = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  // A damaged .shp is refused or read up to the damage, by name: a cut file threw a raw RangeError (TE 2.0.4 cross, c56).
  if (shp.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error(`${name}.shp is not a readable shapefile (${shp.byteLength < 100 ? `${shp.byteLength} bytes, shorter than its 100-byte header` : 'its header has no 9994 file code'})`);
  const len = dv.getInt32(24, false) * 2;
  const table = dbf ? readDbf(dbf, label) : { rows: [], fields: [] };
  const feats = [];
  let o = 100;
  let r = 0;
  const P = (x, y, z) => {
    if (conv) {
      const [lon, lat] = conv(x, y);
      return [lon, lat, z];
    }
    return [x, y, z];
  };
  while (o + 8 <= Math.min(len, shp.byteLength)) {
    const clen = dv.getInt32(o + 4, false) * 2;
    const c = o + 8;
    if (clen < 4 || c + clen > shp.byteLength) {
      rep.warnings.push(`the .shp is cut short at record ${r + 1}; the ${feats.length} record(s) before it are read`);
      break;
    }
    const t = dv.getInt32(c, true);
    const attrs = table.rows[r] ?? {};
    r++;
    o = c + clen;
    rep.features_in++;
    if (t === 0) {
      rep.warnings.push(`record ${r} is a null shape; skipped`);
      continue;
    }
    const base = t % 10 === 1 && t !== 31 ? 1 : t > 10 && t < 20 ? t - 10 : t > 20 && t < 30 ? t - 20 : t;
    const hasZ = t > 10 && t < 20;
    const realM = (m) => Number.isFinite(m) && m > -1e38 && m !== 0; // "no data" and 0 are not losses
    if (t === 31) {
      rep.warnings.push(`record ${r} is a MultiPatch; skipped`);
      continue;
    }
    let geom;
    if (base === 1) {
      const z = hasZ ? dv.getFloat64(c + 20, true) : 0;
      geom = fromParts('Point', [[P(dv.getFloat64(c + 4, true), dv.getFloat64(c + 12, true), z)]]);
      const mAt = t === 21 ? c + 20 : t === 11 && clen >= 36 ? c + 28 : 0;
      if (mAt && realM(dv.getFloat64(mAt, true))) rep.dropped.M_values++;
    } else {
      const multi = base === 8;
      const np = multi ? 0 : dv.getInt32(c + 36, true);
      const n = dv.getInt32(c + (multi ? 36 : 40), true);
      const pOff = c + (multi ? 40 : 44);
      const starts = Array.from({ length: np }, (_, i) => dv.getInt32(pOff + 4 * i, true));
      const xyOff = pOff + 4 * np;
      const zOff = xyOff + 16 * n + 16;
      const pts = Array.from({ length: n }, (_, i) => P(dv.getFloat64(xyOff + 16 * i, true), dv.getFloat64(xyOff + 16 * i + 8, true), hasZ && zOff + 8 * i + 8 <= c + clen ? dv.getFloat64(zOff + 8 * i, true) : 0));
      const mOff = (hasZ ? zOff + 8 * n : xyOff + 16 * n) + 16;
      if (t > 20 || hasZ) for (let i = 0; i < n && mOff + 8 * i + 8 <= c + clen; i++) if (realM(dv.getFloat64(mOff + 8 * i, true))) rep.dropped.M_values++;
      if (multi) geom = fromParts(n === 1 ? 'Point' : 'MultiPoint', pts.map((p) => [p]));
      else {
        const ps = starts.map((s, i) => pts.slice(s, i + 1 < starts.length ? starts[i + 1] : n));
        if (base === 3) geom = fromParts(ps.length === 1 ? 'LineString' : 'MultiLineString', ps);
        else {
          // Rings: clockwise outer rings, counter-clockwise holes inside the outer that holds them.
          const rings = ps.map((p) => (p.length > 1 && p[0][0] === p.at(-1)[0] && p[0][1] === p.at(-1)[1] ? p.slice(0, -1) : p));
          const outers = [];
          const holes = [];
          for (const rg of rings) (signedArea(rg) < 0 || rings.length === 1 ? outers : holes).push(rg);
          const groups = outers.map((x) => [x]);
          for (const hl of holes) {
            const g = groups.find((gr) => pointInRing(hl[0], gr[0]));
            if (g) g.push(hl);
            else groups.push([[...hl].reverse()]);
          }
          const flat = [];
          const polys = [];
          for (const gr of groups) {
            polys.push(flat.length);
            flat.push(...gr);
          }
          geom = fromParts(groups.length === 1 ? 'Polygon' : 'MultiPolygon', flat, groups.length === 1 ? [0] : polys);
        }
      }
    }
    const { name: nm = null, descriptio: ds = null, ...rest } = attrs;
    feats.push({ geom, attrs: rest, name: nm, description: ds, fid: r });
    countGeom(rep, geom.type);
  }
  if (rep.dropped.M_values) rep.warnings.push(`${rep.dropped.M_values} M value(s) are not kept (the workbench keeps X, Y and Z)`);
  rep.features_out = feats.length;
  return { layer: { name, fields: table.fields.filter((f) => f.name !== 'name' && f.name !== 'descriptio'), features: feats, assets: {} }, report: rep };
}

/** Group files of a zip or a multi-file pick into shapefile sets by stem. */
export function shapefileSets(files) {
  const sets = new Map();
  for (const [path, data] of Object.entries(files)) {
    const m = /^(.*?)\.(shp|shx|dbf|prj|cpg)$/i.exec(path);
    if (!m) continue;
    const s = sets.get(m[1].toLowerCase()) ?? { stem: m[1].split('/').pop() };
    const ext = m[2].toLowerCase();
    s[ext] = ext === 'prj' || ext === 'cpg' ? new TextDecoder().decode(data) : data;
    sets.set(m[1].toLowerCase(), s);
  }
  return [...sets.values()].filter((s) => s.shp);
}

// ---- KML / KMZ ----

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
/** #RRGGBB(AA) → aabbggrr. */
export const kmlColour = (hex, alpha = null) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex ?? '');
  if (!m) return 'ff0000ff';
  return `${alpha ?? m[4] ?? 'ff'}${m[3]}${m[2]}${m[1]}`.toLowerCase();
};
export const fromKmlColour = (abgr) => {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(abgr ?? '').trim());
  return m ? `#${m[4]}${m[3]}${m[2]}${m[1].toLowerCase() === 'ff' ? '' : m[1]}`.toLowerCase() : null; // opaque → #rrggbb
};
const KTYPE = { string: 'string', integer: 'int', number: 'double', boolean: 'bool', date: 'string' };

/** KML document; `toMsl(lat, lon, hae)` gives EGM96 heights for absolute altitudes. */
export function writeKml(layer, { toMsl = (lat, lon, h) => h, iconHref = null } = {}) {
  const rep = newReport('KML 2.2', 'export');
  rep.vertical = 'EGM96 (KML absolute altitudes)';
  const fields = layer.fields?.length ? layer.fields : inferFields(layer.features);
  const sid = 'schema_' + (layer.name || 'layer').replace(/[^\w]+/g, '_');
  // Shared styles: one per distinct style, with a StyleMap (normal / highlight).
  const styles = new Map();
  const styleKey = (s) => JSON.stringify(s ?? {});
  for (const f of layer.features) if (!styles.has(styleKey(f.style))) styles.set(styleKey(f.style), `s${styles.size}`);
  const styleXml = [...styles]
    .map(([k, id]) => {
      const s = JSON.parse(k);
      const icon = s.icon ?? iconHref;
      const one = (sfx, w) => `<Style id="${id}${sfx}"><LineStyle><color>${kmlColour(s.stroke ?? '#ff0000')}</color><width>${w}</width></LineStyle><PolyStyle><color>${kmlColour(s.fill ?? '#ff000040')}</color></PolyStyle>${icon ? `<IconStyle><Icon><href>${xmlEsc(icon)}</href></Icon></IconStyle>` : ''}</Style>`;
      return `${one('', s.width ?? 2)}${one('h', (s.width ?? 2) + 2)}<StyleMap id="${id}m"><Pair><key>normal</key><styleUrl>#${id}</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#${id}h</styleUrl></Pair></StyleMap>`;
    })
    .join('\n');
  const coord = (v) => `${v[0].toFixed(9)},${v[1].toFixed(9)},${toMsl(v[1], v[0], v[2]).toFixed(3)}`;
  const ring = (r) => `<LinearRing><coordinates>${[...r, r[0]].map(coord).join(' ')}</coordinates></LinearRing>`;
  const geomXml = (g) => {
    const am = '<altitudeMode>absolute</altitudeMode>';
    switch (g.type) {
      case 'Point':
        return `<Point>${am}<coordinates>${coord(parts(g)[0][0])}</coordinates></Point>`;
      case 'LineString':
        return `<LineString>${am}<coordinates>${parts(g)[0].map(coord).join(' ')}</coordinates></LineString>`;
      case 'Polygon':
        return polyXml(parts(g));
      case 'MultiPoint':
        return `<MultiGeometry>${parts(g).map((p) => `<Point>${am}<coordinates>${coord(p[0])}</coordinates></Point>`).join('')}</MultiGeometry>`;
      case 'MultiLineString':
        return `<MultiGeometry>${parts(g).map((p) => `<LineString>${am}<coordinates>${p.map(coord).join(' ')}</coordinates></LineString>`).join('')}</MultiGeometry>`;
      case 'MultiPolygon':
        return `<MultiGeometry>${polygonGroups(g).map(polyXml).join('')}</MultiGeometry>`;
      default:
        return '';
    }
  };
  const polyXml = (rs) => {
    const orient = (r, outer) => (signedArea(r) > 0 === outer ? r : [...r].reverse());
    return `<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs>${ring(orient(rs[0], true))}</outerBoundaryIs>${rs
      .slice(1)
      .map((h) => `<innerBoundaryIs>${ring(orient(h, false))}</innerBoundaryIs>`)
      .join('')}</Polygon>`;
  };
  const pms = layer.features
    .map((f) => {
      rep.features_in++;
      countGeom(rep, f.geom.type);
      // A feature without a finite position (a CSV row with no coordinates) keeps its attributes in a
      // Placemark without geometry: KML cannot carry NaN (TE 2.0.4 cross, IBTrACS).
      const placed = Array.from(f.geom.xyz ?? []).every(Number.isFinite);
      if (!placed) rep.dropped.no_position = (rep.dropped.no_position ?? 0) + 1;
      const data = fields
        .filter((fl) => f.attrs?.[fl.name] !== undefined && f.attrs?.[fl.name] !== null)
        .map((fl) => `<SimpleData name="${xmlEsc(fl.name)}">${xmlEsc(f.attrs[fl.name])}</SimpleData>`)
        .join('');
      return `<Placemark>${f.name !== null && f.name !== undefined ? `<name>${xmlEsc(f.name)}</name>` : ''}${f.description ? `<description>${xmlEsc(f.description)}</description>` : ''}<styleUrl>#${styles.get(styleKey(f.style))}m</styleUrl><ExtendedData><SchemaData schemaUrl="#${sid}">${data}</SchemaData></ExtendedData>${placed ? geomXml(f.geom) : ''}</Placemark>`;
    })
    .join('\n');
  rep.features_out = layer.features.length;
  const schema = `<Schema name="${xmlEsc(layer.name)}" id="${sid}">${fields.map((f) => `<SimpleField name="${xmlEsc(f.name)}" type="${KTYPE[f.type] ?? 'string'}"/>`).join('')}</Schema>`;
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n<name>${xmlEsc(layer.name)}</name>\n${schema}\n${styleXml}\n<Folder><name>${xmlEsc(layer.name)}</name>\n${pms}\n</Folder>\n</Document>\n</kml>\n`;
  return { text, report: rep };
}

/** Read KML text with a DOMParser; `toHae(lat, lon, alt)` turns EGM96 altitudes into HAE. */
export function readKml(text, { name = 'KML', toHae = (lat, lon, a) => a, parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('KML with a DTD or entities is refused');
  const rep = newReport('KML', 'import');
  rep.vertical = 'EGM96 altitudes converted to HAE';
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('the KML is not well-formed XML');
  const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
  const kid = (el, tag) => kids(el, tag)[0] ?? null;
  const all = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
  const txt = (el) => (el ? el.textContent.trim() : null);
  // Styles and style maps.
  const styles = {};
  for (const s of all(doc, 'Style')) {
    const id = s.getAttribute('id');
    if (!id) continue;
    const ls = all(s, 'LineStyle')[0];
    const ps = all(s, 'PolyStyle')[0];
    const ic = all(s, 'IconStyle')[0];
    styles[`#${id}`] = { stroke: fromKmlColour(txt(ls && all(ls, 'color')[0])) ?? '#ff0000', width: Number(txt(ls && all(ls, 'width')[0])) || 2, fill: fromKmlColour(txt(ps && all(ps, 'color')[0])) ?? '#ff000040', ...(ic && all(ic, 'href')[0] ? { icon: txt(all(ic, 'href')[0]) } : {}) };
  }
  for (const m of all(doc, 'StyleMap')) {
    const id = m.getAttribute('id');
    const normal = all(m, 'Pair').find((p) => txt(all(p, 'key')[0]) === 'normal');
    if (id && normal) styles[`#${id}`] = styles[txt(all(normal, 'styleUrl')[0])] ?? null;
  }
  const schemaTypes = {};
  for (const s of all(doc, 'Schema')) for (const f of all(s, 'SimpleField')) schemaTypes[f.getAttribute('name')] = f.getAttribute('type');
  const val = (k, v) => {
    const t = schemaTypes[k];
    if (v === null || v === '') return null;
    if (t === 'int' || t === 'uint' || t === 'short' || t === 'ushort') return Number.parseInt(v, 10);
    if (t === 'double' || t === 'float') return Number(v);
    if (t === 'bool') return v === '1' || v === 'true';
    return v;
  };
  const coords = (el, mode) =>
    (el ? (txt(all(el, 'coordinates')[0]) ?? '') : '')
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => {
        const [lon, lat, a] = t.split(',').map(Number);
        return [lon, lat, mode === 'absolute' && Number.isFinite(a) ? toHae(lat, lon, a) : 0];
      })
      .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  const modeOf = (el) => txt(all(el, 'altitudeMode')[0]) ?? 'clampToGround';
  const open = (r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r);
  const polyOf = (p) => {
    const m = modeOf(p);
    const outer = all(p, 'outerBoundaryIs')[0];
    return [open(coords(outer, m)), ...all(p, 'innerBoundaryIs').map((ib) => open(coords(ib, m)))];
  };
  const feats = [];
  let clamped = 0;
  for (const pm of all(doc, 'Placemark')) {
    rep.features_in++;
    const attrs = {};
    for (const d of all(pm, 'Data')) attrs[d.getAttribute('name')] = txt(all(d, 'value')[0]);
    for (const d of all(pm, 'SimpleData')) attrs[d.getAttribute('name')] = val(d.getAttribute('name'), d.textContent);
    const style = styles[txt(kid(pm, 'styleUrl'))] ?? null;
    const geoms = [];
    const collect = (el) => {
      for (const c of [...el.children]) {
        if (c.localName === 'MultiGeometry') collect(c);
        else if (['Point', 'LineString', 'LinearRing', 'Polygon'].includes(c.localName)) geoms.push(c);
      }
    };
    collect(pm);
    // TE-028: empty geometries (a Polygon with no outer ring, a Point with no coordinates — GDAL's
    // KML test file has both) are skipped with a note instead of throwing.
    const empty = geoms.filter((g) => (g.localName === 'Polygon' ? !coords(all(g, 'outerBoundaryIs')[0], 'clampToGround').length : !coords(g, 'clampToGround').length));
    if (empty.length) {
      rep.warnings.push(`placemark "${txt(kid(pm, 'name')) ?? rep.features_in}": ${empty.length} empty geometr${empty.length > 1 ? 'ies' : 'y'} skipped`);
      for (const g of empty) geoms.splice(geoms.indexOf(g), 1);
    }
    if (!geoms.length) {
      rep.warnings.push(`placemark "${txt(kid(pm, 'name')) ?? rep.features_in}" has no supported geometry (tracks and models are not read)`);
      continue;
    }
    if (geoms.some((g) => modeOf(g) !== 'absolute')) clamped++;
    const kinds = new Set(geoms.map((g) => (g.localName === 'LinearRing' ? 'LineString' : g.localName)));
    const mk = (geomList) => {
      const k = geomList[0].localName === 'LinearRing' ? 'LineString' : geomList[0].localName;
      if (k === 'Point') return fromParts(geomList.length > 1 ? 'MultiPoint' : 'Point', geomList.map((g) => [coords(g, modeOf(g))[0]]));
      if (k === 'LineString') return fromParts(geomList.length > 1 ? 'MultiLineString' : 'LineString', geomList.map((g) => coords(g, modeOf(g))));
      const groups = geomList.map(polyOf);
      const flat = [];
      const polys = [];
      for (const gr of groups) {
        polys.push(flat.length);
        flat.push(...gr);
      }
      return fromParts(groups.length > 1 ? 'MultiPolygon' : 'Polygon', flat, groups.length > 1 ? polys : [0]);
    };
    const lists = kinds.size === 1 ? [geoms] : [...kinds].map((k) => geoms.filter((g) => (g.localName === 'LinearRing' ? 'LineString' : g.localName) === k));
    if (lists.length > 1) rep.warnings.push(`placemark "${txt(kid(pm, 'name'))}" mixes geometry types; split into ${lists.length} features`);
    for (const l of lists) {
      const g = mk(l);
      feats.push({ geom: g, attrs: { ...attrs }, name: txt(kid(pm, 'name')), description: txt(kid(pm, 'description')), style });
      countGeom(rep, g.type);
    }
  }
  if (clamped) rep.warnings.push(`${clamped} placemark(s) are clamped or relative to the ground; their heights were set to 0 m HAE (drop them to the terrain to fix)`);
  rep.features_out = feats.length;
  const fields = Object.keys(schemaTypes).length ? Object.entries(schemaTypes).map(([n, t]) => ({ name: n, type: { int: 'integer', uint: 'integer', short: 'integer', ushort: 'integer', double: 'number', float: 'number', bool: 'boolean' }[t] ?? 'string' })) : inferFields(feats);
  return { layer: { name: txt(all(doc, 'Document')[0] && kid(all(doc, 'Document')[0], 'name')) || name, fields, features: feats, assets: {} }, report: rep };
}

/**
 * GML 2/3 simple features (IMP-23): Point, LineString, LinearRing, Polygon and their Multi*,
 * MultiSurface and MultiCurve forms, in any application schema — each top-level geometry is a feature
 * whose attributes are its feature element's simple children. Built for product masks such as the
 * Pléiades/SPOT DIMAP MASKS/*.GML (an empty mask is a valid "none" and opens with no features).
 * `reproject(epsg)` returns (x, y) → [lon, lat] for a CRS other than WGS 84.
 */
export function readGml(text, { name = 'GML', reproject = null, parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('GML with a DTD or entities is refused');
  const rep = newReport('GML', 'import');
  const doc = parser.parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('the GML is not well-formed XML');
  const GEOM = new Set(['Point', 'LineString', 'LinearRing', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiCurve', 'MultiPolygon', 'MultiSurface']);
  const isGeom = (el) => GEOM.has(el.localName) && /opengis\.net\/gml/.test(el.namespaceURI ?? '');
  const all = (el, tag) => [...el.getElementsByTagNameNS('*', tag)];
  // srsName → EPSG code and axis order: URN/URI forms of a geographic CRS are latitude first.
  const srsOf = (el) => {
    for (let e = el; e && e.nodeType === 1; e = e.parentNode) {
      const s = e.getAttribute('srsName');
      if (s) return s;
    }
    return all(doc, 'Envelope')[0]?.getAttribute('srsName') ?? null;
  };
  const crs = (s) => {
    const epsg = Number(/(?:EPSG[:/](?:[\d.]*[:/])*|epsg\.xml#)(\d+)\s*$/i.exec(s ?? '')?.[1]) || 4326;
    const latFirst = /^(urn:|https?:\/\/www\.opengis\.net\/def\/)/i.test(s ?? '') && [4326, 4258, 4269, 4267, 4979].includes(epsg);
    return { epsg, latFirst };
  };
  const convs = new Map();
  const toLonLat = (epsg) => {
    if (epsg === 4326 || epsg === 4979) return (x, y) => [x, y];
    if (!convs.has(epsg)) convs.set(epsg, reproject?.(epsg) ?? null);
    return convs.get(epsg);
  };
  const unknown = new Set();
  const pts = (el, c) => {
    const dim = Number(el.getAttribute('srsDimension') ?? el.closest?.('[srsDimension]')?.getAttribute('srsDimension')) || 2;
    let v = [];
    const pl = all(el, 'posList')[0];
    if (pl) {
      const n = pl.textContent.trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < n.length; i += dim) v.push([n[i], n[i + 1], dim > 2 ? n[i + 2] : 0]);
    } else if (all(el, 'pos').length) v = all(el, 'pos').map((p) => p.textContent.trim().split(/\s+/).map(Number)).map((q) => [q[0], q[1], q[2] ?? 0]);
    else if (all(el, 'coordinates')[0]) v = all(el, 'coordinates')[0].textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number)).map((q) => [q[0], q[1], q[2] ?? 0]);
    const f = toLonLat(c.epsg);
    if (!f) unknown.add(c.epsg);
    return v
      .map(([a, b, z]) => (c.latFirst ? [b, a, z] : [a, b, z]))
      .map(([x, y, z]) => (f ? [...f(x, y), z] : [x, y, z]))
      .filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  };
  const open = (r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r);
  const rings = (poly, c) => {
    const ext = all(poly, 'exterior')[0] ?? all(poly, 'outerBoundaryIs')[0];
    const ints = [...all(poly, 'interior'), ...all(poly, 'innerBoundaryIs')];
    return [ext, ...ints].filter(Boolean).map((r) => open(pts(r, c))).filter((r) => r.length >= 3);
  };
  const geomOf = (g) => {
    const c = crs(srsOf(g));
    const k = g.localName;
    if (k === 'Point') return fromParts('Point', [pts(g, c).slice(0, 1)]);
    if (k === 'LineString' || k === 'LinearRing') return fromParts('LineString', [pts(g, c)]);
    if (k === 'Polygon') return fromParts('Polygon', rings(g, c), [0]);
    if (k === 'MultiPoint') return fromParts('MultiPoint', all(g, 'Point').map((p) => pts(p, c).slice(0, 1)));
    if (k === 'MultiLineString' || k === 'MultiCurve') return fromParts('MultiLineString', all(g, 'LineString').map((l) => pts(l, c)));
    const groups = all(g, 'Polygon').map((p) => rings(p, c)).filter((r) => r.length);
    const flat = [];
    const starts = [];
    for (const gr of groups) {
      starts.push(flat.length);
      flat.push(...gr);
    }
    return fromParts('MultiPolygon', flat, starts);
  };
  const tops = [...doc.getElementsByTagName('*')].filter((el) => isGeom(el) && ![...ancestors(el)].some(isGeom));
  const feats = [];
  for (const g of tops) {
    rep.features_in++;
    const owner = g.parentNode?.parentNode?.nodeType === 1 ? g.parentNode.parentNode : g.parentNode;
    const attrs = {};
    for (const c of owner?.children ?? []) if (!c.children.length && c.textContent.trim() && c.localName !== 'name') attrs[c.localName] = c.textContent.trim();
    const id = owner?.getAttribute?.('gml:id') ?? owner?.getAttributeNS?.('http://www.opengis.net/gml', 'id') ?? null;
    if (id) attrs.gml_id = id;
    let geom;
    try {
      geom = geomOf(g);
    } catch (e) {
      rep.warnings.push(`feature ${id ?? rep.features_in}: ${e.message}; skipped`);
      continue;
    }
    feats.push({ geom, attrs, name: owner ? [...owner.children].find((c) => c.localName === 'name')?.textContent.trim() ?? null : null, description: null });
    countGeom(rep, geom.type);
  }
  for (const e of unknown) rep.warnings.push(`EPSG:${e} is not defined here; coordinates kept as they are (load the PROJ data pack)`);
  if (!feats.length) rep.warnings.push('the GML holds no features (an empty mask or collection)');
  const crsNames = [...new Set(tops.map((g) => crs(srsOf(g)).epsg))];
  if (crsNames.some((e) => e !== 4326)) rep.crs = `EPSG:${crsNames.join(', EPSG:')} (reprojected to WGS 84)`;
  rep.features_out = feats.length;
  const docName = [...doc.documentElement.children].find((c) => c.localName === 'name')?.textContent.trim();
  return { layer: { name: docName || name, fields: inferFields(feats), features: feats, assets: {} }, report: rep };
}
function* ancestors(el) {
  for (let e = el.parentNode; e && e.nodeType === 1; e = e.parentNode) yield e;
}

/** Geometry families present, for writers that need one type per file. */
export const families = (layer) => [...new Set(layer.features.map((f) => familyOf(f.geom.type)))];
export { isPolygonal, isLinear };
