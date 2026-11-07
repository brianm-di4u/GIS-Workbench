// OGC service clients, protocol side (REQ-GAP-05, REQ-GAP-06): capabilities parsers and request
// builders for WMS 1.1.1/1.3.0 and WMTS 1.0, the OGC API family (Features with CQL2, Records,
// Tiles, Coverages, Processes), WCS 2.0, WPS 2.0 and SensorThings 1.1. Loaded with the services
// block (lazy/services.lazy.js). Nothing here fetches on its own: callers pass the logged fetch
// (REQ-SEC-12). Pure functions, unit-tested in tests/unit/svc24.test.js.

import { parseXml, child, kids, all, text, attr } from './xml.js';
import { gwError } from '../i18n/index.js';
import { epsgOf, latFirst, withParams, linkOf, resolveUrl, expandTime, DEG_M } from './ogc.js';

const OGC_PIXEL = 0.00028; // m (WMTS standardized rendering pixel)

const llBox = (el) => {
  if (!el) return null;
  if (el.name === 'EX_GeographicBoundingBox') {
    const v = ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map((k) => Number(text(el, k)));
    return v.every(Number.isFinite) ? v : null;
  }
  const v = ['minx', 'miny', 'maxx', 'maxy'].map((k) => Number(attr(el, k)));
  return v.every(Number.isFinite) ? v : null;
};

/**
 * WMS GetCapabilities (1.1.1 or 1.3.0) → {version, title, formats, infoFormats, getMap, getFeatureInfo,
 * layers: [{name, title, abstract, queryable, crs, bbox (lon/lat), styles, time, opaque}]}. Layers
 * inherit CRS, styles, bounding box and dimensions from their parents (WMS §7.2.4.8).
 */
export function parseWmsCapabilities(xmlText, baseUrl = '') {
  const root = parseXml(xmlText);
  if (!/WMS_Capabilities|WMT_MS_Capabilities/.test(root.name)) throw gwError('not a WMS capabilities document ({root})', { root: root.name }, 'E_NOT_WMS_CAPS');
  const version = attr(root, 'version') ?? '1.3.0';
  const cap = child(root, 'Capability');
  const req = child(cap, 'Request');
  const opUrl = (op) => {
    const o = child(req, op);
    const href = attr(child(o, 'DCPType/HTTP/Get/OnlineResource'), 'href');
    return href ? resolveUrl(href, baseUrl) : baseUrl;
  };
  const formats = (op) => kids(child(req, op), 'Format').map((f) => text(f));
  const layers = [];
  const walk = (el, inh) => {
    const crs = [...new Set([...inh.crs, ...kids(el, version.startsWith('1.1') ? 'SRS' : 'CRS').flatMap((c) => text(c).split(/\s+/)).filter(Boolean)])];
    const styles = [...inh.styles, ...kids(el, 'Style').map((s) => ({ name: text(s, 'Name'), title: text(s, 'Title') || text(s, 'Name'), legend: attr(child(s, 'LegendURL/OnlineResource'), 'href') }))];
    const bbox = llBox(child(el, 'EX_GeographicBoundingBox') ?? child(el, 'LatLonBoundingBox')) ?? inh.bbox;
    const bboxes = { ...inh.bboxes };
    for (const b of kids(el, 'BoundingBox')) {
      const c = attr(b, 'CRS') ?? attr(b, 'SRS');
      const v = ['minx', 'miny', 'maxx', 'maxy'].map((k) => Number(attr(b, k)));
      if (c && v.every(Number.isFinite)) bboxes[c] = v;
    }
    // TIME: a <Dimension name="time"> (1.3.0 with its values) or a 1.1.1 <Extent name="time">.
    let time = inh.time;
    const dim = kids(el, 'Dimension').find((d) => /^time$/i.test(attr(d, 'name') ?? ''));
    const ext = kids(el, 'Extent').find((d) => /^time$/i.test(attr(d, 'name') ?? ''));
    const dv = text(dim ?? {}) || text(ext ?? {});
    if (dim || ext) time = { extent: dv, values: expandTime(dv), default: attr(ext ?? dim, 'default') ?? null, current: (attr(ext ?? dim, 'current') ?? '') === '1' };
    const name = text(el, 'Name');
    const queryable = (attr(el, 'queryable') ?? (inh.queryable ? '1' : '0')) === '1';
    if (name) layers.push({ name, title: text(el, 'Title') || name, abstract: text(el, 'Abstract'), queryable, crs, bbox, bboxes, styles, time, opaque: attr(el, 'opaque') === '1' });
    for (const k of kids(el, 'Layer')) walk(k, { crs, styles, bbox, bboxes, time, queryable });
  };
  for (const l of kids(cap, 'Layer')) walk(l, { crs: [], styles: [], bbox: null, bboxes: {}, time: null, queryable: false });
  return { version, title: text(child(root, 'Service'), 'Title'), abstract: text(child(root, 'Service'), 'Abstract'), formats: formats('GetMap'), infoFormats: formats('GetFeatureInfo'), getMap: opUrl('GetMap'), getFeatureInfo: child(req, 'GetFeatureInfo') ? opUrl('GetFeatureInfo') : null, layers };
}

// ---------------------------------------------------------------- WMTS

/**
 * WMTS GetCapabilities → {title, layers: [{id, title, formats, styles, tms (ids), templates
 * [{format, type, template}], dims [{id, default, values}], bbox}], tms: {id: grid}, kvp}.
 * Tile matrix sets become grids in EPSG:3857 or 4326 (others are kept with their EPSG code).
 */
export function parseWmtsCapabilities(xmlText, baseUrl = '') {
  const root = parseXml(xmlText);
  if (root.name !== 'Capabilities') throw gwError('not a WMTS capabilities document ({root})', { root: root.name }, 'E_NOT_WMTS_CAPS');
  const contents = child(root, 'Contents');
  const tms = {};
  for (const s of kids(contents, 'TileMatrixSet')) {
    const id = text(s, 'Identifier');
    const crs = text(s, 'SupportedCRS');
    const epsg = epsgOf(crs);
    const lf = latFirst(crs);
    const metresPerUnit = epsg === 4326 || epsg === 4258 || epsg === 4269 ? DEG_M : 1;
    const levels = kids(s, 'TileMatrix').map((m) => {
      const tl = text(m, 'TopLeftCorner').split(/\s+/).map(Number);
      const [x0, y0] = lf ? [tl[1], tl[0]] : tl;
      return { id: text(m, 'Identifier'), res: (Number(text(m, 'ScaleDenominator')) * OGC_PIXEL) / metresPerUnit, x0, y0, tw: Number(text(m, 'TileWidth')), th: Number(text(m, 'TileHeight')), cols: Number(text(m, 'MatrixWidth')), rows: Number(text(m, 'MatrixHeight')) };
    });
    levels.sort((a, b) => b.res - a.res);
    tms[id] = { id, crs, epsg, levels, wellKnown: text(s, 'WellKnownScaleSet') };
  }
  const layers = kids(contents, 'Layer').map((l) => {
    const wgs = child(l, 'WGS84BoundingBox');
    const lc = wgs ? text(wgs, 'LowerCorner').split(/\s+/).map(Number) : null;
    const uc = wgs ? text(wgs, 'UpperCorner').split(/\s+/).map(Number) : null;
    return {
      id: text(l, 'Identifier'),
      title: text(l, 'Title') || text(l, 'Identifier'),
      abstract: text(l, 'Abstract'),
      formats: kids(l, 'Format').map((f) => text(f)),
      infoFormats: kids(l, 'InfoFormat').map((f) => text(f)),
      styles: kids(l, 'Style').map((s) => ({ id: text(s, 'Identifier'), title: text(s, 'Title') || text(s, 'Identifier'), default: attr(s, 'isDefault') === 'true' })),
      tms: kids(l, 'TileMatrixSetLink').map((k) => text(k, 'TileMatrixSet')),
      templates: kids(l, 'ResourceURL').map((r) => ({ format: attr(r, 'format'), type: attr(r, 'resourceType'), template: resolveUrl(attr(r, 'template') ?? '', baseUrl).replace(/%7B/gi, '{').replace(/%7D/gi, '}') })),
      dims: kids(l, 'Dimension').map((d) => ({ id: text(d, 'Identifier'), default: text(d, 'Default'), values: kids(d, 'Value').map((v) => text(v)) })),
      bbox: lc && uc ? [lc[0], lc[1], uc[0], uc[1]] : null,
    };
  });
  // The KVP GetTile endpoint, for servers without RESTful ResourceURLs.
  const gt = all(child(root, 'OperationsMetadata') ?? { children: [] }, 'Operation').find((o) => attr(o, 'name') === 'GetTile');
  const kvp = gt ? all(gt, 'Get').map((g) => attr(g, 'href')).find(Boolean) : null;
  return { title: text(child(root, 'ServiceIdentification') ?? { children: [] }, 'Title'), layers, tms, kvp: kvp ? resolveUrl(kvp, baseUrl) : null };
}

/**
 * The tile URL template of a WMTS layer, with {TileMatrix}, {TileRow} and {TileCol} left in it and
 * the style, matrix set, format and dimension values filled in.
 */
export function wmtsTemplate(caps, layer, { style = null, tms = null, format = null, dims = {} } = {}) {
  const st = style ?? layer.styles.find((s) => s.default)?.id ?? layer.styles[0]?.id ?? 'default';
  const set = tms ?? layer.tms[0];
  const tiles = layer.templates.filter((r) => (r.type ?? 'tile') === 'tile');
  const res = (format ? tiles.find((r) => r.format === format) : null) ?? tiles.find((r) => /png/.test(r.format ?? '')) ?? tiles[0];
  const fmt = res?.format ?? format ?? layer.formats.find((f) => /png/.test(f)) ?? layer.formats[0] ?? 'image/png';
  const dimVal = (id) => dims[id] ?? layer.dims.find((d) => d.id === id)?.default ?? '';
  if (res) {
    let u = res.template.replace(/\{Style\}/gi, st).replace(/\{TileMatrixSet\}/gi, set);
    for (const d of layer.dims) u = u.replace(new RegExp(`\\{${d.id}\\}`, 'gi'), encodeURIComponent(dimVal(d.id)));
    return { template: u, format: fmt };
  }
  if (!caps.kvp) throw gwError('{layer}: the WMTS service gives neither a ResourceURL template nor a KVP GetTile address', { layer: layer.id }, 'E_WMTS_NO_TEMPLATE');
  const dimsKvp = Object.fromEntries(layer.dims.map((d) => [d.id, dimVal(d.id)]));
  return { template: withParams(caps.kvp, { SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer.id, STYLE: st, TILEMATRIXSET: set, FORMAT: fmt, ...dimsKvp }).replace('TILEMATRIXSET=', 'TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}&TILEMATRIXSET='), format: fmt };
}

/** What a collection offers, from its links and itemType: features, records, tiles, map, coverage. */
export function collectionOffers(c) {
  const rels = new Set((c.links ?? []).map((l) => String(l.rel).replace('http://www.opengis.net/def/rel/ogc/1.0/', '').replace(/^\[ogc-rel:(.*)\]$/, '$1')));
  const it = c.itemType ?? '';
  return {
    features: rels.has('items') && it !== 'record' && it !== 'stac-item' ? true : it === 'feature',
    records: it === 'record' || rels.has('ogc-catalog'),
    stac: it === 'stac-item' || c.type === 'Collection',
    tiles: rels.has('tilesets-vector') || rels.has('tilesets-map') || rels.has('tiles'),
    map: rels.has('map'),
    coverage: rels.has('coverage'),
  };
}

/**
 * The items URL of an OGC API Features / Records collection with its query: bbox (lon/lat),
 * limit, datetime, a CQL2 filter (text or JSON), free-text q and properties.
 */
export function itemsUrl(collection, { base = null, bbox = null, limit = 500, datetime = null, filter = null, filterLang = 'cql2-text', q = null, crs = null } = {}) {
  const href = linkOf(collection.links, 'items', 'application/geo+json') ?? `${String(base).replace(/\/$/, '')}/collections/${encodeURIComponent(collection.id)}/items`;
  const u = resolveUrl(href, base ?? href);
  return withParams(u, { f: /[?&]f=/.test(u) ? null : 'json', limit, bbox: bbox ? bbox.map((v) => +v.toFixed(8)).join(',') : null, datetime, filter: filter ? (filterLang === 'cql2-json' ? JSON.stringify(filter) : filter) : null, 'filter-lang': filter ? filterLang : null, q, crs });
}

// CQL2 (OGC 21-065r2): a small builder for the filters the dialog offers, plus a checker for typed text.
const cqlLit = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'boolean' ? String(v).toUpperCase() : `'${String(v).replace(/'/g, "''")}'`);
const cqlProp = (p) => (/^[A-Za-z_][\w.]*$/.test(p) ? p : `"${String(p).replace(/"/g, '""')}"`);
/**
 * CQL2 text from conditions [{prop, op, value}] (op: = <> < <= > >= like in between isNull) joined by
 * AND, plus an optional S_INTERSECTS with a lon/lat box and a T_INTERSECTS with an interval.
 */
export function cql2Text(conds = [], { bbox = null, geometry = 'geometry', interval = null, timeProp = 'datetime' } = {}) {
  const parts = conds.map(({ prop, op, value }) => {
    const p = cqlProp(prop);
    switch (op) {
      case 'like':
        return `${p} LIKE ${cqlLit(String(value))}`;
      case 'in':
        return `${p} IN (${(Array.isArray(value) ? value : String(value).split(',').map((s) => s.trim())).map((v) => cqlLit(numOrStr(v))).join(', ')})`;
      case 'between': {
        const [a, b] = Array.isArray(value) ? value : String(value).split(/\s*(?:,|\.\.)\s*/);
        return `${p} BETWEEN ${cqlLit(numOrStr(a))} AND ${cqlLit(numOrStr(b))}`;
      }
      case 'isNull':
        return `${p} IS NULL`;
      default:
        if (!['=', '<>', '<', '<=', '>', '>='].includes(op)) throw gwError('unknown CQL2 operator {op}', { op: String(op) }, 'E_CQL2_OP');
        return `${p} ${op} ${cqlLit(numOrStr(value))}`;
    }
  });
  if (bbox) parts.push(`S_INTERSECTS(${cqlProp(geometry)}, BBOX(${bbox.map((v) => +v.toFixed(8)).join(', ')}))`);
  if (interval) parts.push(`T_INTERSECTS(${cqlProp(timeProp)}, INTERVAL('${interval[0] ?? '..'}', '${interval[1] ?? '..'}'))`);
  return parts.join(' AND ');
}
const numOrStr = (v) => (typeof v === 'number' ? v : /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(String(v).trim()) ? Number(v) : v);

/** CQL2 JSON for the same conditions (for servers that conform to cql2-json only). */
export function cql2Json(conds = [], { bbox = null, geometry = 'geometry' } = {}) {
  const args = conds.map(({ prop, op, value }) => {
    const p = { property: prop };
    if (op === 'like') return { op: 'like', args: [p, String(value)] };
    if (op === 'in') return { op: 'in', args: [p, (Array.isArray(value) ? value : String(value).split(',')).map((v) => numOrStr(String(v).trim()))] };
    if (op === 'between') {
      const [a, b] = Array.isArray(value) ? value : String(value).split(/\s*(?:,|\.\.)\s*/);
      return { op: 'between', args: [p, numOrStr(a), numOrStr(b)] };
    }
    if (op === 'isNull') return { op: 'isNull', args: [p] };
    return { op, args: [p, numOrStr(value)] };
  });
  if (bbox) args.push({ op: 's_intersects', args: [{ property: geometry }, { bbox }] });
  return args.length === 1 ? args[0] : { op: 'and', args };
}

/**
 * A light check of typed CQL2 text: balanced parentheses and quotes, a known comparison or
 * function, no statement separators. Returns null when it looks valid, else an error.
 */
export function checkCql2(textIn) {
  const s = String(textIn ?? '').trim();
  if (!s) return null;
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      if (inStr && s[i + 1] === "'") i++;
      else inStr = !inStr;
    } else if (!inStr && c === '(') depth++;
    else if (!inStr && c === ')' && --depth < 0) break;
    else if (!inStr && c === ';') return gwError('CQL2: a filter is one expression; ";" is not allowed', null, 'E_CQL2_SYNTAX');
  }
  if (inStr) return gwError('CQL2: a quoted string is not closed', null, 'E_CQL2_SYNTAX');
  if (depth !== 0) return gwError('CQL2: the parentheses do not balance', null, 'E_CQL2_SYNTAX');
  if (!/(<>|<=|>=|=|<|>|\bLIKE\b|\bIN\b|\bBETWEEN\b|\bIS\s+(NOT\s+)?NULL\b|\b[ST]_[A-Z]+\s*\(|\bA_[A-Z]+\s*\(|\bCASEI\s*\(|\bACCENTI\s*\(|\bTRUE\b|\bFALSE\b)/i.test(s)) return gwError('CQL2: no comparison, LIKE, IN, BETWEEN, IS NULL or spatial/temporal function found', null, 'E_CQL2_SYNTAX');
  return null;
}

/** The tile URL template of an OGC API tileset ({tileMatrix}, {tileRow}, {tileCol}), and its type. */
export function ogcTileTemplate(tileset, base = '') {
  const item = (tileset.links ?? []).filter((l) => l.rel === 'item');
  const pick = item.find((l) => /png|jpeg|webp/.test(l.type ?? '')) ?? item.find((l) => /mapbox-vector-tile|pbf|mvt/.test(l.type ?? l.href ?? '')) ?? item[0];
  if (!pick) return null;
  const href = resolveUrl(pick.href, base).replace(/%7B/gi, '{').replace(/%7D/gi, '}');
  const vector = /mapbox-vector-tile|mvt|pbf/i.test(`${pick.type ?? ''} ${pick.href}`) || tileset.dataType === 'vector';
  return { template: href, vector, tms: tileset.tileMatrixSetId ?? /\/([^/]+)$/.exec(tileset.tileMatrixSetURI ?? tileset.tileMatrixSet ?? '')?.[1] ?? 'WebMercatorQuad' };
}

/** An OGC API Coverages request for a lon/lat box as GeoTIFF. */
export function ogcCoverageUrl(collectionOrBase, { base = null, bbox = null, width = null, format = 'GTiff', datetime = null, properties = null }) {
  const href = typeof collectionOrBase === 'string' ? collectionOrBase : linkOf(collectionOrBase.links, 'coverage', 'image/tiff; application=geotiff') ?? `${String(base).replace(/\/$/, '')}/collections/${encodeURIComponent(collectionOrBase.id)}/coverage`;
  return withParams(resolveUrl(href, base ?? href).replace(/([?&])f=[^&]*/, '$1').replace(/[?&]$/, ''), { f: format, bbox: bbox ? bbox.map((v) => +Number(v).toFixed(10)).join(',') : null, 'scale-size': width ? `x(${width})` : null, datetime, properties });
}

/**
 * The inputs of an OGC API process description → [{id, title, type: 'string'|'number'|'integer'|
 * 'boolean'|'object'|'geometry', enum?, default?, required}].
 */
export function processInputs(desc) {
  const ins = desc?.inputs ?? {};
  const list = Array.isArray(ins) ? ins.map((x) => [x.id, x]) : Object.entries(ins);
  return list.map(([id, x]) => {
    const sc = x.schema ?? {};
    const type = sc.format === 'geojson-geometry' || /geometry/i.test(sc.$ref ?? '') ? 'geometry' : sc.type ?? (sc.oneOf ? 'object' : 'string');
    return { id, title: x.title ?? id, description: x.description ?? '', type, enum: sc.enum ?? null, default: sc.default ?? null, required: (x.minOccurs ?? 1) > 0 };
  });
}
/** The execute request body (OGC API Processes 1.0) from typed values. */
export function processExecuteBody(desc, values, { async = false } = {}) {
  const inputs = {};
  for (const i of processInputs(desc)) {
    const v = values[i.id];
    if (v === undefined || v === '' || v === null) {
      if (i.required && i.default === null) throw gwError('{input} is required', { input: i.title }, 'E_PROCESS_INPUT');
      continue;
    }
    inputs[i.id] = i.type === 'number' || i.type === 'integer' ? Number(v) : i.type === 'boolean' ? v === true || v === 'true' : i.type === 'object' || i.type === 'geometry' ? (typeof v === 'string' ? JSON.parse(v) : v) : v;
  }
  return { inputs, ...(async ? { response: 'document' } : {}) };
}

// ---------------------------------------------------------------- WCS 2.0

/** WCS 2.0 GetCapabilities → {version, title, coverages: [{id, subtype, bbox (lon/lat)}], formats}. */
export function parseWcsCapabilities(xmlText) {
  const root = parseXml(xmlText);
  if (root.name !== 'Capabilities') throw gwError('not a WCS capabilities document ({root})', { root: root.name }, 'E_NOT_WCS_CAPS');
  const contents = child(root, 'Contents');
  const coverages = kids(contents, 'CoverageSummary').map((c) => {
    const w = child(c, 'WGS84BoundingBox');
    const lc = w ? text(w, 'LowerCorner').split(/\s+/).map(Number) : null;
    const uc = w ? text(w, 'UpperCorner').split(/\s+/).map(Number) : null;
    return { id: text(c, 'CoverageId') || text(c, 'Identifier'), title: text(c, 'Title'), subtype: text(c, 'CoverageSubtype'), bbox: lc && uc ? [lc[0], lc[1], uc[0], uc[1]] : null };
  });
  const formats = all(child(root, 'ServiceMetadata') ?? { children: [] }, 'formatSupported').map((f) => text(f));
  return { version: attr(root, 'version') ?? '2.0.1', title: text(child(root, 'ServiceIdentification') ?? { children: [] }, 'Title'), coverages, formats };
}

/** WCS 2.0 DescribeCoverage → {id, srs, epsg, axes [labels], lower, upper, size [cols, rows], nativeFormat}. */
export function parseWcsDescribe(xmlText) {
  const root = parseXml(xmlText);
  const cd = all(root, 'CoverageDescription')[0];
  if (!cd) throw gwError('not a WCS DescribeCoverage document ({root})', { root: root.name }, 'E_NOT_WCS_DESCRIBE');
  const env = all(cd, 'Envelope')[0] ?? all(cd, 'EnvelopeWithTimePeriod')[0];
  const srs = attr(env, 'srsName') ?? '';
  const axes = (attr(env, 'axisLabels') ?? '').split(/\s+/).filter(Boolean);
  const lower = text(env, 'lowerCorner').split(/\s+/).map(Number);
  const upper = text(env, 'upperCorner').split(/\s+/).map(Number);
  const lim = all(cd, 'GridEnvelope')[0];
  const lo = lim ? text(lim, 'low').split(/\s+/).map(Number) : null;
  const hi = lim ? text(lim, 'high').split(/\s+/).map(Number) : null;
  return { id: attr(cd, 'id') ?? text(cd, 'CoverageId'), srs, epsg: epsgOf(srs), axes, lower, upper, size: lo && hi ? hi.map((v, i) => v - lo[i] + 1) : null, nativeFormat: text(all(cd, 'nativeFormat')[0] ?? { children: [] }) };
}

/**
 * A WCS 2.0 GetCoverage KVP URL for a box in the coverage's CRS (x = east), with the axis labels
 * from DescribeCoverage (e.g. Lat/Long, E/N, x/y), as GeoTIFF by default.
 */
export function wcsGetCoverageUrl(url, d, { bbox = null, format = 'image/tiff', scaleSize = null, version = '2.0.1' } = {}) {
  const ax = d.axes?.length >= 2 ? d.axes : ['Long', 'Lat'];
  // Which label is the east axis: the one named like longitude/x/east; otherwise the CRS order.
  const eastIdx = ax.findIndex((a) => /^(lon|long|longitude|x|e|easting)$/i.test(a));
  const iE = eastIdx >= 0 ? eastIdx : latFirst(d.srs) ? 1 : 0;
  const iN = iE === 0 ? 1 : 0;
  const u = withParams(url, { SERVICE: 'WCS', VERSION: version, REQUEST: 'GetCoverage', COVERAGEID: d.id, FORMAT: format, SCALESIZE: scaleSize ? `${ax[iE]}(${scaleSize[0]}),${ax[iN]}(${scaleSize[1]})` : null });
  if (!bbox) return u;
  const n = (v) => +Number(v).toFixed(10);
  return `${u}&SUBSET=${encodeURIComponent(`${ax[iE]}(${n(bbox[0])},${n(bbox[2])})`)}&SUBSET=${encodeURIComponent(`${ax[iN]}(${n(bbox[1])},${n(bbox[3])})`)}`;
}

// ---------------------------------------------------------------- WPS 2.0

/** WPS 2.0 GetCapabilities → {title, processes [{id, title, abstract, sync, async}]}. */
export function parseWpsCapabilities(xmlText) {
  const root = parseXml(xmlText);
  if (root.name !== 'Capabilities') throw gwError('not a WPS capabilities document ({root})', { root: root.name }, 'E_NOT_WPS_CAPS');
  const processes = all(child(root, 'Contents') ?? root, 'ProcessSummary').map((p) => {
    const modes = (attr(p, 'jobControlOptions') ?? 'sync-execute').split(/\s+/);
    return { id: text(p, 'Identifier'), title: text(p, 'Title') || text(p, 'Identifier'), abstract: text(p, 'Abstract'), sync: modes.includes('sync-execute'), async: modes.includes('async-execute') };
  });
  return { version: attr(root, 'version') ?? '2.0.0', title: text(child(root, 'ServiceIdentification') ?? { children: [] }, 'Title'), processes };
}

/** WPS 2.0 DescribeProcess → {id, title, inputs [{id, title, kind: literal|complex|bbox, dataType, allowed, mimeTypes, minOccurs}], outputs}. */
export function parseWpsDescribe(xmlText) {
  const root = parseXml(xmlText);
  const off = all(root, 'ProcessOffering')[0];
  const p = off ? child(off, 'Process') : all(root, 'Process')[0];
  if (!p) throw gwError('not a WPS DescribeProcess document ({root})', { root: root.name }, 'E_NOT_WPS_DESCRIBE');
  const io = (el) => {
    const lit = child(el, 'LiteralData');
    const cpx = child(el, 'ComplexData');
    const bb = child(el, 'BoundingBoxData');
    const ldd = lit ? all(lit, 'LiteralDataDomain')[0] : null;
    return {
      id: text(el, 'Identifier'),
      title: text(el, 'Title') || text(el, 'Identifier'),
      kind: lit ? 'literal' : bb ? 'bbox' : cpx ? 'complex' : 'literal',
      dataType: ldd ? text(ldd, 'DataType') || attr(child(ldd, 'DataType'), 'reference') : null,
      allowed: ldd ? all(ldd, 'Value').map((v) => text(v)) : [],
      default: ldd ? text(ldd, 'DefaultValue') || null : null,
      mimeTypes: [...new Set(all(cpx ?? lit ?? bb ?? { children: [] }, 'Format').map((f) => attr(f, 'mimeType')).filter(Boolean))],
      minOccurs: Number(attr(el, 'minOccurs') ?? 1),
    };
  };
  return { id: text(p, 'Identifier'), title: text(p, 'Title'), inputs: kids(p, 'Input').map(io), outputs: kids(p, 'Output').map(io), sync: (attr(off, 'jobControlOptions') ?? 'sync-execute').split(/\s+/).includes('sync-execute'), async: (attr(off, 'jobControlOptions') ?? '').split(/\s+/).includes('async-execute') };
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** A WPS 2.0 Execute request: literal inputs as text, complex inputs as JSON/XML data, bbox inputs as ows:BoundingBox. */
export function wpsExecuteXml(desc, values, { mode = 'sync' } = {}) {
  const inputs = desc.inputs
    .filter((i) => values[i.id] !== undefined && values[i.id] !== '' && values[i.id] !== null)
    .map((i) => {
      const v = values[i.id];
      if (i.kind === 'bbox') {
        const [w, s, e, n] = Array.isArray(v) ? v : String(v).split(',').map(Number);
        return `<wps:Input id="${xmlEsc(i.id)}"><wps:Data><ows:BoundingBox crs="urn:ogc:def:crs:OGC:1.3:CRS84"><ows:LowerCorner>${w} ${s}</ows:LowerCorner><ows:UpperCorner>${e} ${n}</ows:UpperCorner></ows:BoundingBox></wps:Data></wps:Input>`;
      }
      if (i.kind === 'complex') {
        const mt = i.mimeTypes.find((m) => /json/.test(m)) ?? i.mimeTypes[0] ?? 'application/json';
        const body = typeof v === 'string' ? v : JSON.stringify(v);
        return `<wps:Input id="${xmlEsc(i.id)}"><wps:Data mimeType="${xmlEsc(mt)}">${/xml|gml/.test(mt) ? body : `<![CDATA[${body.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`}</wps:Data></wps:Input>`;
      }
      return `<wps:Input id="${xmlEsc(i.id)}"><wps:Data>${xmlEsc(v)}</wps:Data></wps:Input>`;
    });
  const outs = desc.outputs.map((o) => `<wps:Output id="${xmlEsc(o.id)}" transmission="value"/>`);
  for (const i of desc.inputs) if (i.minOccurs > 0 && (values[i.id] === undefined || values[i.id] === '') && !i.default) throw gwError('{input} is required', { input: i.title }, 'E_PROCESS_INPUT');
  return `<?xml version="1.0" encoding="UTF-8"?><wps:Execute xmlns:wps="http://www.opengis.net/wps/2.0" xmlns:ows="http://www.opengis.net/ows/2.0" service="WPS" version="2.0.0" mode="${mode}" response="document"><ows:Identifier>${xmlEsc(desc.id)}</ows:Identifier>${inputs.join('')}${outs.join('')}</wps:Execute>`;
}

/** A WPS 2.0 Result or StatusInfo → {status, jobId, outputs: [{id, text, json, href, mimeType}]}. */
export function parseWpsResponse(xmlText) {
  const root = parseXml(xmlText);
  if (root.name === 'StatusInfo') return { status: text(root, 'Status'), jobId: text(root, 'JobID'), progress: Number(text(root, 'PercentCompleted')) || null, outputs: [] };
  if (root.name !== 'Result') throw gwError('not a WPS result ({root})', { root: root.name }, 'E_WPS_RESULT');
  const outputs = kids(root, 'Output').map((o) => {
    const d = child(o, 'Data');
    const ref = child(o, 'Reference');
    const raw = d ? (d.children.length ? xmlOf(d.children[0]) : d.text.trim()) : '';
    let json = null;
    if (/^[{[]/.test(raw)) {
      try {
        json = JSON.parse(raw);
      } catch {
        /* text */
      }
    }
    return { id: attr(o, 'id'), mimeType: attr(d ?? ref, 'mimeType'), text: raw, json, href: ref ? attr(ref, 'href') : null };
  });
  return { status: 'Succeeded', jobId: text(root, 'JobID') || null, outputs };
}
const xmlOf = (el) => `<${el.qname}${Object.entries(el.attrs).map(([k, v]) => ` ${k}="${xmlEsc(v)}"`).join('')}>${xmlEsc(el.text)}${el.children.map(xmlOf).join('')}</${el.qname}>`;

// ---------------------------------------------------------------- SensorThings 1.1

/** A SensorThings Things query with their Locations and Datastreams (and each datastream's latest observation). */
export function staThingsUrl(base, { top = 200, bbox = null } = {}) {
  const b = String(base).replace(/\/$/, '');
  const root = /\/v1\.[01]$/.test(b) ? b : `${b}`;
  const filter = bbox ? `st_intersects(Locations/location, geography'POLYGON((${bbox[0]} ${bbox[1]}, ${bbox[2]} ${bbox[1]}, ${bbox[2]} ${bbox[3]}, ${bbox[0]} ${bbox[3]}, ${bbox[0]} ${bbox[1]}))')` : null;
  return withParams(`${root}/Things`, { $top: top, $expand: 'Locations,Datastreams($expand=Observations($top=1;$orderby=phenomenonTime desc),ObservedProperty)', $filter: filter }).replace(/%24/g, '$').replace(/%3B/g, ';').replace(/%28/g, '(').replace(/%29/g, ')');
}
/** SensorThings Things (expanded) → GeoJSON features: one per Location, with the latest value of each datastream. */
export function staToFeatures(things) {
  const out = [];
  for (const th of things ?? []) {
    const props = { thing: th.name ?? '', thingId: th['@iot.id'] ?? null, description: th.description ?? '' };
    for (const ds of th.Datastreams ?? []) {
      const o = ds.Observations?.[0];
      const key = ds.ObservedProperty?.name ?? ds.name ?? `ds${ds['@iot.id']}`;
      props[key] = o?.result ?? null;
      if (o?.phenomenonTime) props[`${key} time`] = String(o.phenomenonTime).split('/').pop();
      if (ds.unitOfMeasurement?.symbol) props[`${key} unit`] = ds.unitOfMeasurement.symbol;
    }
    for (const loc of th.Locations ?? []) {
      const g = loc.location?.type === 'Feature' ? loc.location.geometry : loc.location;
      if (g?.type && g.coordinates) out.push({ type: 'Feature', id: `${th['@iot.id']}/${loc['@iot.id']}`, properties: { ...props, location: loc.name ?? '' }, geometry: g });
    }
  }
  return out;
}
