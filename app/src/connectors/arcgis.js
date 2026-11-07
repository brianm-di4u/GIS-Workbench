// ArcGIS REST, protocol side (REQ-GAP-04, REQ-GAP-05, REQ-GAP-63): service and layer metadata,
// Esri JSON geometry (multi-part, with holes), typed fields with coded-value and range domains,
// subtypes (feature types), attribute checks before applyEdits, paged queries, dynamic MapServer
// export, ImageServer exportImage, cached tiling schemes and VectorTileServer tiles. No fetching
// here: callers pass the logged fetch (REQ-SEC-12).

import { gwError } from '../i18n/index.js';
import { withParams, MERC_MAX, DEG_M, collectPages } from './ogc.js';

/** What an ArcGIS REST URL points at: {root, type, layer} (type MapServer, FeatureServer, ImageServer, VectorTileServer, SceneServer). */
export function arcgisParts(url) {
  const u = String(url).replace(/[?#].*$/, '').replace(/\/+$/, '');
  const m = /^(.*\/(MapServer|FeatureServer|ImageServer|VectorTileServer|SceneServer|GPServer))(?:\/(?:layers\/)?(\d+))?$/i.exec(u);
  if (!m) return null;
  const type = ['MapServer', 'FeatureServer', 'ImageServer', 'VectorTileServer', 'SceneServer', 'GPServer'].find((t) => t.toLowerCase() === m[2].toLowerCase());
  return { root: m[1], type, layer: m[3] !== undefined ? Number(m[3]) : null };
}

/** The Esri error of a JSON reply (`{error: {code, message, details}}`) as an Error, or null. */
export function esriError(j, name = '') {
  if (!j?.error) return null;
  const msg = [j.error.message, ...(j.error.details ?? [])].filter(Boolean).join(' — ') || `error ${j.error.code ?? ''}`;
  const e = gwError('{name}: {msg}', { name, msg }, j.error.code === 498 || j.error.code === 499 ? 'E_ARCGIS_TOKEN' : 'E_SERVICE');
  e.status = j.error.code;
  return e;
}

// ---------------------------------------------------------------- geometry

const signedArea = (r) => {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i++) {
    const [x1, y1] = r[i];
    const [x2, y2] = r[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
};
const inRing = ([px, py], r) => {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const close = (r) => (r.length && (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) ? [...r, r[0]] : r);
const dims = (c, hasZ) => (hasZ && c.length > 2 ? [c[0], c[1], c[2]] : [c[0], c[1]]);

/**
 * Esri JSON geometry → GeoJSON. Rings: clockwise ones are outer rings and counter-clockwise ones
 * holes (Esri's rule); each hole goes to the smallest outer ring that contains it, so a polygon
 * with several outer rings becomes a MultiPolygon (G0-2, REQ-GAP-63). Paths → (Multi)LineString,
 * points → (Multi)Point. Z is kept when present.
 */
export function esriToGeoJSON(g) {
  if (!g) return null;
  const z = !!g.hasZ || (g.z !== undefined && g.z !== null);
  if (Number.isFinite(g.x) && Number.isFinite(g.y)) return { type: 'Point', coordinates: z && Number.isFinite(g.z) ? [g.x, g.y, g.z] : [g.x, g.y] };
  if (Array.isArray(g.points)) {
    const pts = g.points.map((c) => dims(c, z || c.length > 2));
    return pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
  }
  if (Array.isArray(g.paths)) {
    const ls = g.paths.filter((p) => p.length >= 2).map((p) => p.map((c) => dims(c, z || c.length > 2)));
    if (!ls.length) return null;
    return ls.length === 1 ? { type: 'LineString', coordinates: ls[0] } : { type: 'MultiLineString', coordinates: ls };
  }
  if (Array.isArray(g.rings)) {
    const rings = g.rings.filter((r) => r.length >= 3).map((r) => close(r.map((c) => dims(c, z || c.length > 2))));
    const outers = [];
    const holes = [];
    for (const r of rings) (signedArea(r) <= 0 ? outers : holes).push(r); // clockwise (negative area in x-east/y-north) = outer
    if (!outers.length && holes.length) outers.push(...holes.splice(0).map((r) => [...r].reverse())); // all counter-clockwise: treat as outers
    const polys = outers.map((o) => ({ outer: [...o].reverse(), area: Math.abs(signedArea(o)), holes: [] })); // GeoJSON: outer counter-clockwise
    for (const h of holes) {
      const cands = polys.filter((p) => inRing(h[0], p.outer) || inRing(h[Math.floor(h.length / 2)], p.outer)).sort((a, b) => a.area - b.area);
      (cands[0] ?? polys[0])?.holes.push([...h].reverse()); // holes clockwise in GeoJSON
    }
    if (!polys.length) return null;
    const coords = polys.map((p) => [p.outer, ...p.holes]);
    return coords.length === 1 ? { type: 'Polygon', coordinates: coords[0] } : { type: 'MultiPolygon', coordinates: coords };
  }
  return null;
}

/** Esri geometryType of a GeoJSON type (for the layers a publish creates features in). */
export const esriGeometryType = (t) => ({ Point: 'esriGeometryPoint', MultiPoint: 'esriGeometryMultipoint', LineString: 'esriGeometryPolyline', MultiLineString: 'esriGeometryPolyline', Polygon: 'esriGeometryPolygon', MultiPolygon: 'esriGeometryPolygon' })[t] ?? null;

// ---------------------------------------------------------------- fields, domains, subtypes

const TYPES = {
  esriFieldTypeOID: 'integer',
  esriFieldTypeSmallInteger: 'integer',
  esriFieldTypeInteger: 'integer',
  esriFieldTypeBigInteger: 'integer',
  esriFieldTypeSingle: 'number',
  esriFieldTypeDouble: 'number',
  esriFieldTypeString: 'string',
  esriFieldTypeDate: 'date',
  esriFieldTypeDateOnly: 'date',
  esriFieldTypeTimeOnly: 'string',
  esriFieldTypeTimestampOffset: 'date',
  esriFieldTypeGUID: 'string',
  esriFieldTypeGlobalID: 'string',
  esriFieldTypeXML: 'string',
};
const INT_RANGE = { esriFieldTypeSmallInteger: [-32768, 32767], esriFieldTypeInteger: [-2147483648, 2147483647] };

/** An Esri domain → the store's {domain: {code: name}} or {range: [min, max]}. */
export function esriDomain(d) {
  if (!d) return {};
  if (d.type === 'codedValue') return { domain: Object.fromEntries((d.codedValues ?? []).map((c) => [String(c.code), c.name ?? String(c.code)])), domainName: d.name ?? null };
  if (d.type === 'range' && Array.isArray(d.range)) return { range: [Number(d.range[0]), Number(d.range[1])], domainName: d.name ?? null };
  return {};
}

/**
 * Layer fields as the store keeps them ({name, type, title, domain?, range?, required?, length?,
 * editable, esri}), the store type from the Esri field type (REQ-GAP-63); system fields (OID,
 * GlobalID, shape length/area, editor tracking) are kept but marked read-only.
 */
export function esriFields(info) {
  const sys = new Set([info.objectIdField, info.globalIdField, info.geometryProperties?.shapeLengthFieldName, info.geometryProperties?.shapeAreaFieldName, info.editFieldsInfo?.creationDateField, info.editFieldsInfo?.creatorField, info.editFieldsInfo?.editDateField, info.editFieldsInfo?.editorField].filter(Boolean).map((s) => s.toLowerCase()));
  return (info.fields ?? []).filter((f) => f.type !== 'esriFieldTypeGeometry' && f.type !== 'esriFieldTypeBlob' && f.type !== 'esriFieldTypeRaster').map((f) => {
    const out = { name: f.name, type: TYPES[f.type] ?? 'string', title: f.alias && f.alias !== f.name ? f.alias : f.name, esri: f.type, ...esriDomain(f.domain) };
    if (f.nullable === false && !sys.has(f.name.toLowerCase()) && f.type !== 'esriFieldTypeOID') out.required = true;
    if (f.type === 'esriFieldTypeString' && f.length > 0) out.length = f.length;
    out.editable = f.editable !== false && !sys.has(f.name.toLowerCase()) && f.type !== 'esriFieldTypeOID' && f.type !== 'esriFieldTypeGlobalID';
    if (f.defaultValue !== undefined && f.defaultValue !== null) out.default = f.defaultValue;
    return out;
  });
}

/**
 * Subtypes of a layer: `subtypeField` + `subtypes` (ArcGIS 10.8+ / Enterprise) or the older
 * `typeIdField` + `types` (feature types). → {field, list: [{code, name, domains: {field: {domain|range}}, defaults}]} or null.
 */
export function esriSubtypes(info) {
  const field = info.subtypeField || info.typeIdField;
  const raw = info.subtypes?.length ? info.subtypes : info.types;
  if (!field || !raw?.length) return null;
  return {
    field,
    list: raw.map((s) => ({
      code: s.code ?? s.id,
      name: s.name ?? String(s.code ?? s.id),
      domains: Object.fromEntries(Object.entries(s.domains ?? {}).map(([k, d]) => [k, d.type === 'inherited' ? null : esriDomain(d)]).filter(([, d]) => d)),
      defaults: s.defaultValues ?? s.templates?.[0]?.prototype?.attributes ?? {},
    })),
  };
}

/** The field definition that applies to a feature: the subtype's domain replaces the field's. */
export function fieldForFeature(field, subtypes, attrs) {
  if (!subtypes) return field;
  const code = attrs?.[subtypes.field];
  const st = subtypes.list.find((s) => String(s.code) === String(code));
  const d = st?.domains?.[field.name];
  if (!d) return field;
  const { domain, range, ...rest } = field;
  return { ...rest, ...d };
}

const issue = (src, params, code) => gwError(src, params, code);
/**
 * Check one feature's attributes against the layer's typed fields, domains and subtypes before
 * they are sent (REQ-GAP-63) → [errors]. Unknown attributes are refused too: the service would
 * otherwise drop them without saying so.
 */
export function checkEsriAttrs(fields, subtypes, attrs, { isNew = false } = {}) {
  const out = [];
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const k of Object.keys(attrs ?? {})) if (!byName.has(k.toLowerCase())) out.push(issue('{field} is not a field of this layer', { field: k }, 'E_ATTR_UNKNOWN'));
  if (subtypes) {
    const code = attrs?.[subtypes.field];
    if (code !== undefined && code !== null && code !== '' && !subtypes.list.some((s) => String(s.code) === String(code))) out.push(issue('{field}: {value} is not a subtype of this layer. Allowed: {allowed}', { field: subtypes.field, value: String(code), allowed: subtypes.list.map((s) => `${s.code} ${s.name}`).join('; ') }, 'E_ATTR_SUBTYPE'));
  }
  for (const f0 of fields) {
    const f = fieldForFeature(f0, subtypes, attrs);
    const v = attrs?.[f.name];
    const empty = v === undefined || v === null || v === '';
    if (empty) {
      if (f.required && isNew && f.editable && f.default === undefined) out.push(issue('{field} is required', { field: f.name }, 'E_ATTR_REQUIRED'));
      continue;
    }
    if (!f.editable) continue;
    if (f.domain) {
      if (!Object.keys(f.domain).some((c) => String(c) === String(v))) out.push(issue('{field}: {value} is not an allowed value. Allowed: {allowed}', { field: f.name, value: String(v), allowed: Object.entries(f.domain).map(([c, n]) => `${c} ${n}`).join('; ') }, 'E_ATTR_DOMAIN'));
      continue;
    }
    if (f.type === 'integer' || f.type === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) out.push(issue('{field} must be a number', { field: f.name }, 'E_ATTR_NUMBER'));
      else if (f.type === 'integer' && !Number.isInteger(n)) out.push(issue('{field} must be a whole number', { field: f.name }, 'E_ATTR_INTEGER'));
      else if (f.range && (n < f.range[0] || n > f.range[1])) out.push(issue('{field}: {value} is outside the allowed range {min} to {max}', { field: f.name, value: String(n), min: String(f.range[0]), max: String(f.range[1]) }, 'E_ATTR_RANGE'));
      else if (INT_RANGE[f.esri] && (n < INT_RANGE[f.esri][0] || n > INT_RANGE[f.esri][1])) out.push(issue('{field}: {value} does not fit the field type {type}', { field: f.name, value: String(n), type: f.esri }, 'E_ATTR_RANGE'));
    } else if (f.type === 'date') {
      if (!Number.isFinite(typeof v === 'number' ? v : Date.parse(v))) out.push(issue('{field} must be a date', { field: f.name }, 'E_ATTR_DATE'));
    } else if (f.length && String(v).length > f.length) out.push(issue('{field} is longer than {n, plural, one {# character} other {# characters}}', { field: f.name, n: f.length }, 'E_ATTR_LENGTH'));
  }
  return out;
}

/** Attribute values as read → the store's values (dates as ISO 8601 strings, domain codes as they are). */
export function readEsriAttrs(fields, attrs) {
  const out = { ...(attrs ?? {}) };
  for (const f of fields) if (f.type === 'date' && Number.isFinite(out[f.name])) out[f.name] = new Date(out[f.name]).toISOString();
  return out;
}
/** The store's values → what applyEdits takes (numbers typed, dates as epoch milliseconds, read-only fields left out). */
export function writeEsriAttrs(fields, attrs, { keep = [] } = {}) {
  const out = {};
  const byName = new Map(fields.map((f) => [f.name.toLowerCase(), f]));
  for (const [k, v] of Object.entries(attrs ?? {})) {
    const f = byName.get(k.toLowerCase());
    if (!f) continue;
    if (!f.editable && !keep.includes(k)) continue;
    if (v === undefined || v === null || (v === '' && f.type !== 'string')) out[f.name] = null;
    else if (f.type === 'integer' || f.type === 'number') out[f.name] = Number(v);
    else if (f.type === 'date') out[f.name] = typeof v === 'number' ? v : Date.parse(v);
    else out[f.name] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

// ---------------------------------------------------------------- paged query (REQ-GAP-04)

/**
 * Every feature of a layer query, page by page: `resultOffset`/`resultRecordCount` while the
 * service sets `exceededTransferLimit` (supportsPagination), else object-id batches (all ids
 * first, then `objectIds=` in chunks of maxRecordCount). getJson(url) → parsed JSON.
 */
export async function queryAll(getJson, layerUrl, info, { where = '1=1', outSR = 4326, pageSize = null, max = 50000, signal = null, onPage = null, extra = {} } = {}) {
  const size = Math.max(1, Math.min(pageSize ?? Infinity, info.maxRecordCount || 1000, 2000));
  const base = `${layerUrl.replace(/\/+$/, '')}/query`;
  const q = (p) => withParams(base, { where, outFields: '*', returnGeometry: 'true', outSR, f: 'json', ...extra, ...p });
  const paging = info.advancedQueryCapabilities?.supportsPagination ?? (Number(info.currentVersion) >= 10.3);
  if (paging) {
    return collectPages(
      async (offset) => {
        const j = await getJson(q({ resultOffset: offset ?? 0, resultRecordCount: size, orderByFields: info.objectIdField ? `${info.objectIdField} ASC` : null }));
        const e = esriError(j, info.name ?? layerUrl);
        if (e) throw e;
        const items = j.features ?? [];
        return { items, next: j.exceededTransferLimit || (pageSize && items.length === size && !('exceededTransferLimit' in j)) ? (offset ?? 0) + items.length : null };
      },
      { first: 0, max, signal, onPage },
    );
  }
  const ids = await getJson(withParams(base, { where, returnIdsOnly: 'true', f: 'json', ...extra }));
  const e = esriError(ids, info.name ?? layerUrl);
  if (e) throw e;
  const all = (ids.objectIds ?? []).sort((a, b) => a - b);
  return collectPages(
    async (i) => {
      const chunk = all.slice(i ?? 0, (i ?? 0) + size);
      if (!chunk.length) return { items: [], next: null };
      const j = await getJson(q({ objectIds: chunk.join(','), where: null }));
      const err = esriError(j, info.name ?? layerUrl);
      if (err) throw err;
      return { items: j.features ?? [], next: (i ?? 0) + size < all.length ? (i ?? 0) + size : null };
    },
    { first: 0, max, signal, onPage },
  );
}

// ---------------------------------------------------------------- images and tiles (REQ-GAP-05)

/** A dynamic MapServer /export URL for a box in `sr` (wkid; x = east), drawn at width × height. */
export function arcgisExportUrl(root, { bbox, sr = 3857, width = 256, height = 256, layers = null, time = null, format = 'png32', transparent = true, dpi = 96 }) {
  return withParams(`${root.replace(/\/+$/, '')}/export`, { bbox: bbox.map((v) => +Number(v).toFixed(10)).join(','), bboxSR: sr, imageSR: sr, size: `${width},${height}`, dpi, format, transparent: transparent ? 'true' : 'false', layers: layers ? `show:${layers}` : null, time, f: 'image' });
}
/** An ImageServer /exportImage URL (format png, jpgpng or tiff; a rendering rule as JSON). */
export function arcgisImageUrl(root, { bbox, sr = 3857, width = 256, height = 256, format = 'jpgpng', time = null, renderingRule = null, mosaicRule = null, interpolation = 'RSP_BilinearInterpolation' }) {
  return withParams(`${root.replace(/\/+$/, '')}/exportImage`, { bbox: bbox.map((v) => +Number(v).toFixed(10)).join(','), bboxSR: sr, imageSR: sr, size: `${width},${height}`, format, time, renderingRule: renderingRule ? JSON.stringify(renderingRule) : null, mosaicRule: mosaicRule ? JSON.stringify(mosaicRule) : null, interpolation, f: 'image' });
}

/** A cached service's tiling scheme (tileInfo) → a tile grid (EPSG:3857 or 4326), or null for other CRSs. */
export function arcgisGrid(tileInfo) {
  if (!tileInfo?.lods?.length) return null;
  const wkid = tileInfo.spatialReference?.latestWkid ?? tileInfo.spatialReference?.wkid;
  const epsg = wkid === 102100 || wkid === 102113 || wkid === 3857 || wkid === 900913 ? 3857 : wkid === 4326 ? 4326 : wkid ?? null;
  const tw = tileInfo.cols ?? tileInfo.size?.[0] ?? 256;
  const th = tileInfo.rows ?? tileInfo.size?.[1] ?? 256;
  const x0 = tileInfo.origin?.x ?? -MERC_MAX;
  const y0 = tileInfo.origin?.y ?? MERC_MAX;
  // Rows and columns follow from the origin and the service extent (Web Mercator: the square world).
  const ext = epsg === 3857 ? 2 * MERC_MAX : epsg === 4326 ? 360 : null;
  const levels = tileInfo.lods.map((l) => ({ id: String(l.level), res: l.resolution, x0, y0, tw, th, cols: ext ? Math.ceil(ext / (l.resolution * tw) - 1e-9) : undefined, rows: ext ? Math.ceil((epsg === 4326 ? 180 + (y0 - 90) : ext) / (l.resolution * th) - 1e-9) : undefined }));
  return { epsg, levels, dpi: tileInfo.dpi ?? 96 };
}

/** VectorTileServer root JSON → {template, grid, maxZoom, styleUrl}. */
export function vectorTileInfo(root, info) {
  const t = info.tiles?.[0] ?? 'tile/{z}/{y}/{x}.pbf';
  const template = /^https?:/.test(t) ? t : `${root.replace(/\/+$/, '')}/${t.replace(/^\.?\//, '')}`;
  const grid = arcgisGrid(info.tileInfo);
  const maxZoom = info.maxzoom ?? (grid ? Math.max(...grid.levels.map((l) => Number(l.id))) : 15);
  return { template, grid, maxZoom, styleUrl: info.defaultStyles ? `${root.replace(/\/+$/, '')}/${info.defaultStyles.replace(/^\.?\//, '')}/root.json` : null };
}

/** Metres per pixel of a grid level at the equator (for zoom matching in the Map view). */
export const levelMetres = (grid, l) => (grid.epsg === 4326 ? l.res * DEG_M : l.res);
