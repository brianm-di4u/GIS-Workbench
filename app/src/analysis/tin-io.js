// TIN plumbing without the DOM (REQ-GAP-39): the TIN plane, DEM post grids in it, mass points
// and breaklines from vector features and point tables, the LandXML and CSV writers, and the
// import and export forms (others are refused by name).
//
// The TIN plane is metres east and north of the TIN's origin (lat0, lon0), with WGS 84 metres per
// degree at lat0 (kx, ky; the same local frame as the point clouds, formats/las.js frameScales):
// x = (lon − lon0)·kx, y = (lat − lat0)·ky. Delaunay is decided in this plane.

import { gwError, N_ } from '../i18n/index.js';
import { parts, isPolygonal, isLinear } from '../vector/geom.js';

/** Metres per degree of longitude and latitude on WGS 84 at `lat`. */
export function frameScales(lat) {
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - e2 * s * s;
  const N = a / Math.sqrt(w);
  const M = (a * (1 - e2)) / (w * Math.sqrt(w));
  return { kx: (N * Math.cos((lat * Math.PI) / 180) * Math.PI) / 180, ky: (M * Math.PI) / 180 };
}

export const frameAt = (lat, lon) => ({ lat0: lat, lon0: lon, ...frameScales(lat) });
export const toPlane = (f, lon, lat) => [(lon - f.lon0) * f.kx, (lat - f.lat0) * f.ky];
/** Plane → [lon, lat]. */
export const toGeo = (f, x, y) => [f.lon0 + x / f.kx, f.lat0 + y / f.ky];

/** A geographic post grid {lat0 (north), lon0 (west), dlat, dlon, width, height} as plane posts {w, h, ax, ay, bx, by}. */
export function gridSpec(f, g) {
  return { w: g.width, h: g.height, ax: (g.lon0 - f.lon0) * f.kx, ay: (g.lat0 - f.lat0) * f.ky, bx: g.dlon * f.kx, by: -g.dlat * f.ky };
}

/** A geographic grid over a plane box [x0, y0, x1, y1] at about `postM` metres: {grid, spec}. */
export function rasterGrid(f, box, postM) {
  if (!(postM > 0)) throw gwError('the post spacing must be more than 0 m', null, 'E_TIN_POST');
  const dlat = postM / f.ky;
  const dlon = postM / f.kx;
  const [w0, s0] = toGeo(f, box[0], box[1]);
  const [e0, n0] = toGeo(f, box[2], box[3]);
  const width = Math.floor((e0 - w0) / dlon) + 1;
  const height = Math.floor((n0 - s0) / dlat) + 1;
  if (width * height > 100e6) throw gwError('the grid would have {n} million posts (at most 100): choose a larger spacing', { n: String(Math.round((width * height) / 1e6)) }, 'E_TIN_GRID_LARGE');
  const grid = { lat0: n0, lon0: w0, dlat, dlon, width, height };
  return { grid, spec: gridSpec(f, grid) };
}

// ---- forms ----
/** Import forms by extension. */
export const IMPORT = [
  { form: 'landxml', re: /\.(xml|landxml)$/i },
  { form: 'csv', re: /\.(csv|txt|xyz|pts|tsv)$/i },
  { form: 'geojson', re: /\.(geojson|json|geojsonl)$/i },
  { form: 'shapefile', re: /\.(shp|zip)$/i },
];
export const EXPORT = ['landxml', 'geojson', 'shapefile', 'csv'];

// Other surface and line forms, refused by name with what to do instead.
const REFUSED = [
  [/\.(dxf|dwg|dgn)$/i, N_('CAD drawings (DXF, DWG, DGN) are not read as TINs: export the surface from the CAD program as LandXML')],
  [/\.(tin|adf)$/i, N_('Esri TIN datasets are not read: export the TIN as LandXML')],
  [/\.(ts|tsurf)$/i, N_('GOCAD TSurf surfaces are not read: export the surface as LandXML')],
  [/\.(obj|ply|stl|off|gltf|glb|dae)$/i, N_('3-D model meshes are not read as TINs: export the surface as LandXML, or its vertices as CSV')],
  [/\.(las|laz|copc|bpf)$/i, N_('point cloud files make a TIN through Open Point Cloud, then New TIN from its ground points')],
  [/\.(tif|tiff|dt[0-2]|hgt|img|asc)$/i, N_('elevation grids make a TIN through Use as Terrain, then New TIN from the DEM')],
  [/\.(kml|kmz|gpkg|gml|fgb|parquet)$/i, N_('mass points and breaklines are read from Shapefile, GeoJSON or CSV: convert the file to one of those')],
];

/** The import form of a file name, or an error naming what is refused. */
export function importForm(name) {
  const hit = IMPORT.find((f) => f.re.test(name));
  if (hit) return hit.form;
  const r = REFUSED.find(([re]) => re.test(name));
  if (r) throw gwError(r[1], null, 'E_TIN_FORM');
  throw gwError('{file} is not a TIN form: TINs are imported from LandXML, and mass points and breaklines from Shapefile, GeoJSON or CSV', { file: name }, 'E_TIN_FORM');
}

/** An export form, or an error naming the forms there are. */
export function exportForm(form) {
  if (EXPORT.includes(form)) return form;
  throw gwError('TINs are exported as LandXML, and mass points and breaklines as Shapefile, GeoJSON or CSV ("{form}" is not one of them)', { form: String(form) }, 'E_TIN_FORM');
}

// ---- line kinds from attributes ----
const KIND_WORDS = { hard: 'hard', standard: 'hard', breakline: 'hard', soft: 'soft', nondestructive: 'soft', proximity: 'mass', void: 'void', hole: 'void', exclusion: 'void', island: 'void', outer: 'outer', boundary: 'outer', ridge: 'hard', drain: 'hard' };
export function kindWord(v, fallback) {
  const k = String(v ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  return KIND_WORDS[k] ?? fallback;
}
const kindOf = (attrs, fallback) => kindWord(attrs?.kind ?? attrs?.type ?? attrs?.brktype ?? attrs?.brkType ?? attrs?.bndtype ?? attrs?.KIND ?? attrs?.TYPE, fallback);

/**
 * Mass points and lines from vector features ({geom: {type, xyz, parts}, attrs}, lon/lat/h).
 * `zOf(lon, lat, h)` puts a height in the TIN's vertical datum. Points → mass points; lines →
 * hard breaklines (soft when their kind says so, or when no vertex has a height); polygons →
 * exclusion (void) rings, or outer boundaries when their kind says so.
 */
export function fromFeatures(features, f, zOf = (lon, lat, h) => h) {
  const points = [];
  const lines = [];
  let skipped = 0;
  for (const ft of features) {
    const g = ft.geom;
    if (!g?.xyz?.length) {
      skipped++;
      continue;
    }
    const conv = (p) => {
      const [x, y] = toPlane(f, p[0], p[1]);
      return [x, y, Number.isFinite(p[2]) ? zOf(p[0], p[1], p[2]) : NaN];
    };
    if (g.type === 'Point' || g.type === 'MultiPoint') {
      for (const part of parts(g)) for (const p of part) if (Number.isFinite(p[2])) points.push(conv(p));
      continue;
    }
    if (isLinear(g)) {
      for (const part of parts(g)) {
        if (part.length < 2) continue;
        const pts = part.map(conv);
        const hasZ = part.some((p) => Number.isFinite(p[2]) && p[2] !== 0);
        let type = kindOf(ft.attrs, hasZ ? 'hard' : 'soft');
        if (type === 'mass') {
          for (const p of pts) if (Number.isFinite(p[2])) points.push(p);
          continue;
        }
        if (type === 'hard' && !hasZ) type = 'soft';
        const closed = pts.length > 3 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1];
        if (closed) pts.pop();
        lines.push({ type: type === 'void' || type === 'outer' ? (closed ? type : 'soft') : type, closed: closed && (type === 'void' || type === 'outer'), pts });
      }
      continue;
    }
    if (isPolygonal(g)) {
      for (const ring of parts(g)) {
        const pts = ring.map(conv);
        if (pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
        if (pts.length < 3) continue;
        const t = kindOf(ft.attrs, 'void');
        lines.push({ type: t === 'outer' ? 'outer' : 'void', closed: true, pts });
      }
      continue;
    }
    skipped++;
  }
  return { points, lines, skipped };
}

/** The column of a table whose header is one of `names` (case-insensitive), or -1. */
function col(header, ...names) {
  const h = header.map((s) => String(s).trim().toLowerCase());
  return h.findIndex((s) => names.includes(s));
}

/**
 * Mass points and lines from a point table (TinBundle.pointsText). Columns by header: x / easting
 * / e, y / northing / n, or lon / longitude and lat / latitude; z / h / height / elevation / elev;
 * optionally a line column (line, line_id, breakline, id of the line a vertex belongs to) and a
 * kind column (hard, soft, void, outer). Without a header the columns are x, y, z. Projected
 * coordinates go through `toLonLat(x, y)` (null: they must be lon/lat). Rows of one line keep
 * their file order.
 */
export function fromTable(tab, f, { toLonLat = null, zOf = (lon, lat, h) => h } = {}) {
  const H = tab.header ?? [];
  let cx = col(H, 'x', 'easting', 'east', 'e');
  let cy = col(H, 'y', 'northing', 'north', 'n');
  let geo = false;
  const clon = col(H, 'lon', 'long', 'longitude', 'lng');
  const clat = col(H, 'lat', 'latitude');
  if (clon >= 0 && clat >= 0) {
    cx = clon;
    cy = clat;
    geo = true;
  }
  let cz = col(H, 'z', 'h', 'height', 'elevation', 'elev', 'hae', 'msl', 'alt', 'altitude');
  if (!H.length) [cx, cy, cz] = [0, 1, 2];
  if (cx < 0 || cy < 0 || cz < 0) throw gwError('the table needs x, y and z columns (or lon, lat and z), named in a header row', null, 'E_TIN_COLUMNS');
  if (!geo && !toLonLat) throw gwError('the table has projected x and y: give its coordinate system (EPSG code)', null, 'E_TIN_CRS');
  const cl = col(H, 'line', 'line_id', 'lineid', 'breakline', 'feature', 'string');
  const ck = col(H, 'kind', 'type', 'brktype', 'class');
  const textOf = (c, r) => tab.text?.get?.(c)?.[r] ?? (Number.isFinite(tab.values[r * tab.cols + c]) ? String(tab.values[r * tab.cols + c]) : '');
  const points = [];
  const byLine = new Map();
  let skipped = 0;
  for (let r = 0; r < tab.rows; r++) {
    const v = (c) => tab.values[r * tab.cols + c];
    const [X, Y, Z] = [v(cx), v(cy), v(cz)];
    if (![X, Y, Z].every(Number.isFinite)) {
      skipped++;
      continue;
    }
    const [lon, lat] = geo ? [X, Y] : toLonLat(X, Y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lat) > 90) {
      skipped++;
      continue;
    }
    const [x, y] = toPlane(f, lon, lat);
    const p = [x, y, zOf(lon, lat, Z)];
    const id = cl >= 0 ? textOf(cl, r).trim() : '';
    if (!id) {
      points.push(p);
      continue;
    }
    if (!byLine.has(id)) byLine.set(id, { type: kindWord(ck >= 0 ? textOf(ck, r) : '', 'hard'), pts: [] });
    byLine.get(id).pts.push(p);
  }
  const lines = [];
  for (const [name, l] of byLine) {
    if (l.type === 'mass') {
      points.push(...l.pts);
      continue;
    }
    const ring = l.type === 'void' || l.type === 'outer';
    if (l.pts.length < (ring ? 3 : 2)) {
      skipped += l.pts.length;
      continue;
    }
    lines.push({ name, type: l.type, closed: ring, pts: l.pts });
  }
  return { points, lines, skipped };
}

// ---- writers ----
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const fx = (v) => {
  const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};

/**
 * LandXML 1.2 (REQ-GAP-39): one TIN surface with its breaklines and boundaries. `en` = Float64Array
 * easting, northing, z per point (metres); faces = Uint32Array (0-based); lines = [{type, name,
 * closed, pts: [[e, n, z]…]}]. Hard, ridge and drain lines are "standard" breaklines, soft ones
 * "nonDestructive"; void and outer rings are boundaries. Written northing first, as LandXML lists them.
 */
export function writeLandXml({ name = 'TIN', epsg = null, crsName = '', vertical = '', date, time, app = 'GIS Workbench', version = '' }, en, faces, lines = [], hidden = null) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" version="1.2" date="${esc(date)}" time="${esc(time)}">`);
  out.push('  <Units><Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="HPA" angularUnit="decimal degrees" directionUnit="decimal degrees"/></Units>');
  if (epsg) out.push(`  <CoordinateSystem epsgCode="${esc(epsg)}" horizontalCoordinateSystemName="${esc(crsName)}"${vertical ? ` verticalDatum="${esc(vertical)}"` : ''}/>`);
  out.push(`  <Application name="${esc(app)}" version="${esc(version)}"/>`);
  out.push(`  <Surfaces>\n    <Surface name="${esc(name)}">`);
  out.push('      <SourceData>');
  const brk = lines.filter((l) => ['hard', 'soft', 'ridge', 'drain'].includes(l.type));
  const bnd = lines.filter((l) => l.type === 'void' || l.type === 'outer');
  const list = (pts, three, close) => {
    const p = close && pts.length ? [...pts, pts[0]] : pts;
    return p.map((q) => (three ? `${fx(q[1])} ${fx(q[0])} ${fx(q[2])}` : `${fx(q[1])} ${fx(q[0])}`)).join(' ');
  };
  if (brk.length) {
    out.push('        <Breaklines>');
    brk.forEach((l, k) => out.push(`          <Breakline brkType="${l.type === 'soft' ? 'nonDestructive' : 'standard'}" name="${esc(l.name || `BL${k + 1}`)}"><PntList3D>${list(l.pts, true, l.closed)}</PntList3D></Breakline>`));
    out.push('        </Breaklines>');
  }
  if (bnd.length) {
    out.push('        <Boundaries>');
    bnd.forEach((l, k) => out.push(`          <Boundary bndType="${l.type}" edgeTrim="true" name="${esc(l.name || `BND${k + 1}`)}"><PntList2D>${list(l.pts, false, true)}</PntList2D></Boundary>`));
    out.push('        </Boundaries>');
  }
  out.push('      </SourceData>');
  out.push('      <Definition surfType="TIN">');
  out.push('        <Pnts>');
  for (let k = 0; k < en.length / 3; k++) out.push(`          <P id="${k + 1}">${fx(en[3 * k + 1])} ${fx(en[3 * k])} ${fx(en[3 * k + 2])}</P>`);
  out.push('        </Pnts>');
  out.push('        <Faces>');
  for (let k = 0; k < faces.length / 3; k++) out.push(`          <F${hidden?.[k] ? ' i="1"' : ''}>${faces[3 * k] + 1} ${faces[3 * k + 1] + 1} ${faces[3 * k + 2] + 1}</F>`);
  out.push('        </Faces>');
  out.push('      </Definition>\n    </Surface>\n  </Surfaces>\n</LandXML>\n');
  return out.join('\n');
}

/** CSV of mass points and line vertices: kind, line, lon, lat, z (plain decimal; one row per vertex). */
export function writeCsv(points, lines) {
  const rows = ['kind,line,lon,lat,z'];
  const n = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
  for (const p of points) rows.push(`mass,,${n(p[0], 9)},${n(p[1], 9)},${n(p[2], 4)}`);
  lines.forEach((l, k) => {
    for (const p of l.pts) rows.push(`${l.type},${l.key ?? k + 1},${n(p[0], 9)},${n(p[1], 9)},${n(p[2], 4)}`);
  });
  return `${rows.join('\n')}\n`;
}

/** Hypsometric tint (low green → high brown) times a Lambert shade, as "rgb(…)". */
export function shadeColour(t, lambert) {
  const c = [
    [70, 130, 70],
    [190, 180, 110],
    [150, 100, 60],
    [235, 235, 235],
  ];
  const u = Math.max(0, Math.min(0.999, t)) * (c.length - 1);
  const k = Math.floor(u);
  const s = u - k;
  const l = 0.35 + 0.65 * Math.max(0, lambert);
  const ch = (i) => Math.round((c[k][i] + (c[k + 1][i] - c[k][i]) * s) * l);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

/** Lambert term of a triangle (plane coordinates) under a light from azimuth 315°, altitude 45°. */
export function lambertOf(ax, ay, az, bx, by, bz, cx, cy, cz, exaggeration = 1) {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = (bz - az) * exaggeration;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = (cz - az) * exaggeration;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  const L = [-Math.SQRT1_2 * Math.SQRT1_2, Math.SQRT1_2 * Math.SQRT1_2, Math.SQRT1_2];
  return nx * L[0] + ny * L[1] + nz * L[2];
}
