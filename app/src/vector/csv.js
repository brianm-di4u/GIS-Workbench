// CSV with WKT geometry (REQ-EXT-24): RFC 4180 quoting, a WKT column (POINT/LINESTRING/POLYGON
// and their MULTI forms, 2D or Z) or longitude/latitude(/height) columns, WGS 84 with Z as HAE.

import { fromParts, parts, polygonGroups } from './geom.js';
import { newReport, inferFields } from './io.js';

/** Parse CSV text into rows of strings (RFC 4180). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** WKT → geometry (Z defaults to h0). */
export function parseWkt(wkt, h0 = 0) {
  const s = wkt.trim();
  const m = /^(MULTIPOLYGON|MULTILINESTRING|MULTIPOINT|POLYGON|LINESTRING|POINT)\s*(ZM|Z|M)?\s*(EMPTY|\(.*\))$/is.exec(s);
  if (!m) throw new Error(`not WKT: ${s.slice(0, 40)}`);
  const type = m[1].toUpperCase();
  const dims = (m[2] ?? '').toUpperCase();
  if (m[3].toUpperCase() === 'EMPTY') return null;
  // Nested arrays from the parentheses.
  let i = 0;
  const body = m[3];
  const parse = () => {
    // at '('
    i++;
    const out = [];
    let tok = '';
    while (i < body.length) {
      const c = body[i];
      if (c === '(') out.push(parse());
      else if (c === ')') {
        if (tok.trim()) out.push(tok.trim());
        i++;
        return out;
      } else if (c === ',') {
        if (tok.trim()) out.push(tok.trim());
        tok = '';
        i++;
      } else {
        tok += c;
        i++;
      }
    }
    return out;
  };
  const tree = parse();
  const pt = (t) => {
    const v = String(t).trim().split(/\s+/).map(Number);
    const z = dims.includes('Z') || (!dims && v.length >= 3) ? v[2] : h0;
    return [v[0], v[1], Number.isFinite(z) ? z : h0];
  };
  const seq = (a) => a.map((t) => (Array.isArray(t) ? pt(t[0]) : pt(t)));
  const open = (r) => (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r);
  switch (type) {
    case 'POINT':
      return fromParts('Point', [[pt(tree[0])]]);
    case 'LINESTRING':
      return fromParts('LineString', [seq(tree)]);
    case 'POLYGON':
      return fromParts('Polygon', tree.map((r) => open(seq(r))), [0]);
    case 'MULTIPOINT':
      return fromParts('MultiPoint', tree.map((p) => [Array.isArray(p) ? pt(p[0]) : pt(p)]));
    case 'MULTILINESTRING':
      return fromParts('MultiLineString', tree.map(seq));
    case 'MULTIPOLYGON': {
      const ps = [];
      const polys = [];
      for (const poly of tree) {
        polys.push(ps.length);
        for (const r of poly) ps.push(open(seq(r)));
      }
      return fromParts('MultiPolygon', ps, polys);
    }
    default:
      throw new Error(`WKT type ${type} is not read`);
  }
}

/** Geometry → WKT with Z (9 decimals, rings closed). */
export function toWkt(g) {
  const P = (v) => `${+v[0].toFixed(9)} ${+v[1].toFixed(9)} ${+(v[2] ?? 0).toFixed(3)}`;
  const ring = (r) => `(${[...r, r[0]].map(P).join(', ')})`;
  const line = (l) => `(${l.map(P).join(', ')})`;
  const ps = parts(g);
  switch (g.type) {
    case 'Point':
      return `POINT Z (${P(ps[0][0])})`;
    case 'LineString':
      return `LINESTRING Z ${line(ps[0])}`;
    case 'Polygon':
      return `POLYGON Z (${ps.map(ring).join(', ')})`;
    case 'MultiPoint':
      return `MULTIPOINT Z (${ps.map((p) => `(${P(p[0])})`).join(', ')})`;
    case 'MultiLineString':
      return `MULTILINESTRING Z (${ps.map(line).join(', ')})`;
    case 'MultiPolygon':
      return `MULTIPOLYGON Z (${polygonGroups(g).map((rs) => `(${rs.map(ring).join(', ')})`).join(', ')})`;
    default:
      throw new Error(`unknown geometry type ${g.type}`);
  }
}

/** CSV → layer in transit. Geometry from a WKT column, else lon/lat(/height) columns. */
export function readCsv(text, { name = 'CSV' } = {}) {
  const report = newReport('CSV', 'import');
  const rows = parseCsv(text.replace(/^﻿/, ''));
  if (rows.length < 2) throw new Error('the CSV has no data rows');
  const head = rows[0].map((h) => h.trim());
  const find = (re) => head.findIndex((h) => re.test(h));
  const iw = find(/^(wkt|geometry|geom|the_geom|shape)$/i);
  const ix = find(/^(lon|long|longitude|x)$/i);
  const iy = find(/^(lat|latitude|y)$/i);
  const iz = find(/^(z|hae|height|elevation|alt|altitude)$/i);
  if (iw < 0 && (ix < 0 || iy < 0)) throw new Error('no WKT column and no longitude/latitude columns');
  const iname = find(/^name$/i);
  const idesc = find(/^description$/i);
  const skip = new Set([iw, ix, iy, iz, iname, idesc].filter((i) => i >= 0));
  if (iw >= 0) skip.delete(iz);
  const features = [];
  for (const r of rows.slice(1)) {
    let geom;
    try {
      geom = iw >= 0 ? parseWkt(r[iw]) : fromParts('Point', [[[Number(r[ix]), Number(r[iy]), iz >= 0 ? Number(r[iz]) || 0 : 0]]]);
    } catch (e) {
      report.warnings.push(`row ${features.length + 2}: ${e.message}`);
      continue;
    }
    if (!geom) continue;
    const attrs = {};
    head.forEach((h, i) => {
      if (skip.has(i)) return;
      const v = r[i] ?? '';
      attrs[h] = v === '' ? null : /^-?\d+$/.test(v) ? Number(v) : /^-?\d*\.\d+(e[-+]?\d+)?$/i.test(v) ? Number(v) : v === 'true' || v === 'false' ? v === 'true' : v;
    });
    features.push({ geom, attrs, name: iname >= 0 ? r[iname] || null : null, description: idesc >= 0 ? r[idesc] || null : null });
    report.features_in++;
    report.features_out++;
    report.by_geometry[geom.type] = (report.by_geometry[geom.type] ?? 0) + 1;
  }
  return { layer: { name, fields: inferFields(features), features }, report };
}

/** Layer in transit → CSV text with a WKT column (UTF-8 with BOM for spreadsheet programs). */
export function writeCsv(layer) {
  const report = newReport('CSV', 'export');
  const fields = layer.fields?.length ? layer.fields : inferFields(layer.features);
  const lines = [['WKT', 'name', 'description', ...fields.map((f) => f.name)].map(csvCell).join(',')];
  for (const f of layer.features) {
    lines.push([toWkt(f.geom), f.name, f.description, ...fields.map((x) => f.attrs?.[x.name])].map(csvCell).join(','));
    report.features_in++;
    report.features_out++;
    report.by_geometry[f.geom.type] = (report.by_geometry[f.geom.type] ?? 0) + 1;
  }
  return { text: `﻿${lines.join('\r\n')}\r\n`, report };
}
