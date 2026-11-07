// OGC service clients, the part the always-loaded code uses (REQ-GAP-04, REQ-GAP-05): CRS names
// and axis order, query parameters and links, paging, tile grids (Web Mercator, WorldCRS84Quad,
// WMTS matrix sets), WMS GetMap / GetFeatureInfo requests and replies, OGC API Maps tiles,
// conformance and STAC landing pages. The capabilities parsers and the other clients are in
// ogc-clients.js (lazy block js-services). Nothing here fetches on its own: callers pass the
// logged fetch of ai/netlog.js (REQ-SEC-12). Pure functions, unit-tested in tests/unit/svc24.test.js.

import { parseXml, all, text } from './xml.js';
import { gwError } from '../i18n/index.js';

// ---------------------------------------------------------------- common

/** EPSG code of a CRS name in any of its spellings; CRS:84 / OGC CRS84 → 4326 (lon, lat order). */
export function epsgOf(crs) {
  const s = String(crs ?? '').trim();
  if (/CRS:?84$|OGC\/1\.3\/CRS84|OGC::CRS84|^CRS84$/i.test(s)) return 4326;
  const m = /EPSG(?::{1,2}|\/(?:\d+(?:\.\d+)*|0)\/)(\d+)$/i.exec(s) ?? /^(\d{4,6})$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n === 900913 || n === 102100 || n === 102113 || n === 3785 ? 3857 : n;
}
/** Whether a CRS name means longitude-first WGS 84 (CRS:84) rather than EPSG:4326's latitude-first order. */
export const isCrs84 = (crs) => /CRS:?84$|CRS84$/i.test(String(crs ?? ''));

/**
 * Whether coordinates in this CRS are written latitude (northing) first. True for EPSG:4326 in
 * WMS 1.3.0, WCS 2.0 and WMTS (EPSG axis order); WMS 1.1.1 is always x/y.
 */
export function latFirst(crs, version = '1.3.0') {
  if (String(version).startsWith('1.1')) return false;
  if (isCrs84(crs)) return false;
  const e = epsgOf(crs);
  // EPSG geographic 2-D CRSs (4326, 4258, 4269, 4283 …) and a few projected ones with north-first axes.
  return e === 4326 || e === 4258 || e === 4269 || e === 4283 || e === 4612 || e === 4674 || e === 4617 || (e >= 31466 && e <= 31469) || e === 3035;
}

/** Add query parameters to a URL, replacing any of the same name (case-insensitive). */
export function withParams(url, params) {
  const [base, frag] = String(url).split('#');
  const q = base.indexOf('?');
  const path = q < 0 ? base : base.slice(0, q);
  const keep = (q < 0 ? '' : base.slice(q + 1)).split('&').filter((kv) => kv && !Object.keys(params).some((k) => kv.split('=')[0].toLowerCase() === k.toLowerCase()));
  const add = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%2C/g, ',').replace(/%3A/g, ':').replace(/%2F/g, '/')}`);
  const qs = [...keep, ...add].join('&');
  return `${path}${qs ? `?${qs}` : ''}${frag ? `#${frag}` : ''}`;
}

/** The href of the first link with this rel (and type, when given). */
export function linkOf(links, rel, type = null) {
  const rels = Array.isArray(rel) ? rel : [rel];
  const ls = (links ?? []).filter((l) => rels.some((r) => l.rel === r || l.rel === `http://www.opengis.net/def/rel/ogc/1.0/${r}` || l.rel === `[ogc-rel:${r}]`));
  const pick = (type ? ls.find((l) => (l.type ?? '').split(';')[0] === type) : null) ?? ls.find((l) => !l.type || /json/.test(l.type)) ?? ls[0];
  return pick?.href ?? null;
}

/** Resolve a possibly relative href against the URL of the document it came from. */
export function resolveUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/**
 * Collect every page of a paged read (REQ-GAP-04). `page(cursor)` returns {items, next} where next
 * is the cursor of the following page or null. Stops at `max` items, on `signal` abort, or when a
 * page brings nothing new. `onPage({pages, items})` reports progress.
 */
export async function collectPages(page, { first = null, max = 50000, signal = null, onPage = null, maxPages = 2000 } = {}) {
  const out = [];
  let cursor = first;
  let pages = 0;
  let truncated = false;
  const seen = new Set();
  for (;;) {
    if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
    const r = await page(cursor);
    pages++;
    const items = r.items ?? [];
    out.push(...items);
    onPage?.({ pages, items: out.length });
    if (out.length >= max) {
      truncated = !!r.next || out.length > max;
      out.length = Math.min(out.length, max);
      break;
    }
    if (!r.next || !items.length || pages >= maxPages) {
      truncated = !!r.next && pages >= maxPages;
      break;
    }
    const key = typeof r.next === 'string' ? r.next : JSON.stringify(r.next);
    if (seen.has(key)) break; // a server that returns the same next link forever
    seen.add(key);
    cursor = r.next;
  }
  return { items: out, pages, truncated };
}

/** Expand an ISO 8601 time extent ("a,b,c", "start/end/P1D", or a mix) to its values, at most `cap`. */
export function expandTime(extent, cap = 500) {
  const out = [];
  for (const part of String(extent ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [a, b, p] = part.split('/');
    if (!b || !p) {
      out.push(part);
      continue;
    }
    const step = isoDurationMs(p);
    const t0 = Date.parse(a);
    const t1 = Date.parse(b);
    if (!(step > 0) || !Number.isFinite(t0) || !Number.isFinite(t1)) {
      out.push(part);
      continue;
    }
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(a);
    for (let t = t0; t <= t1 && out.length < cap; t = addDuration(t, p)) out.push(dateOnly ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString().replace('.000Z', 'Z'));
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
}
function isoDurationMs(p) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(p);
  if (!m) return NaN;
  const [, y, mo, w, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return (((y * 365 + mo * 30 + w * 7 + d) * 24 + h) * 60 + mi) * 60000 + s * 1000;
}
function addDuration(t, p) {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(p);
  const d = new Date(t);
  const [, y, mo, w, dd, h, mi, s] = m.map((x) => Number(x ?? 0));
  d.setUTCFullYear(d.getUTCFullYear() + y, d.getUTCMonth() + mo, d.getUTCDate() + w * 7 + dd);
  return d.getTime() + ((h * 60 + mi) * 60 + s) * 1000;
}

// ---------------------------------------------------------------- tile grids

const R = 6378137;
export const MERC_MAX = Math.PI * R;
export const DEG_M = (2 * Math.PI * R) / 360; // metres per degree on the Web Mercator equator

export const mercX = (lon) => (lon * Math.PI * R) / 180;
export const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.0511287798, Math.min(85.0511287798, lat)) * Math.PI) / 360));
export const mercLat = (y) => (Math.atan(Math.sinh(y / R)) * 180) / Math.PI;
export const mercLon = (x) => (x / (Math.PI * R)) * 180;

/** WorldCRS84Quad: geographic tiles, two at level 0. */
export function geographicGrid(maxZoom = 18, tile = 256) {
  return { epsg: 4326, levels: Array.from({ length: maxZoom + 1 }, (_, z) => ({ id: String(z), res: 180 / tile / 2 ** z, x0: -180, y0: 90, tw: tile, th: tile, cols: 2 * 2 ** z, rows: 2 ** z })) };
}
/** GoogleMapsCompatible / WebMercatorQuad. */
export function mercatorGrid(maxZoom = 19, tile = 256) {
  return { epsg: 3857, levels: Array.from({ length: maxZoom + 1 }, (_, z) => ({ id: String(z), res: (2 * MERC_MAX) / tile / 2 ** z, x0: -MERC_MAX, y0: MERC_MAX, tw: tile, th: tile, cols: 2 ** z, rows: 2 ** z })) };
}
/** Whether a grid is the standard Web Mercator quad tree (tiles addressable as z/x/y). */
export function isGoogleGrid(g) {
  if (!g || g.epsg !== 3857) return false;
  return g.levels.every((l, i) => Math.abs(l.x0 + MERC_MAX) < 1 && Math.abs(l.y0 - MERC_MAX) < 1 && l.tw === 256 && Math.abs(l.res * 256 * 2 ** Number(l.id ?? i) - 2 * MERC_MAX) < 1e-3 * l.res * 256);
}
/** The grid level whose resolution best matches `res` (grid units per pixel), not finer than the finest. */
export function levelFor(grid, res) {
  let best = grid.levels[0];
  for (const l of grid.levels) if (l.res >= res * 0.75) best = l;
  return best;
}
/** Tile bounds [minx, miny, maxx, maxy] in grid CRS units. */
export function tileBox(l, col, row) {
  const w = l.res * l.tw;
  const hgt = l.res * l.th;
  return [l.x0 + col * w, l.y0 - (row + 1) * hgt, l.x0 + (col + 1) * w, l.y0 - row * hgt];
}
/** Column and row ranges of a level covering a box in grid CRS units. */
export function tileRange(l, [minx, miny, maxx, maxy]) {
  const w = l.res * l.tw;
  const hgt = l.res * l.th;
  const c0 = Math.max(0, Math.floor((minx - l.x0) / w));
  const c1 = Math.min((l.cols ?? Infinity) - 1, Math.floor((maxx - l.x0) / w - 1e-9));
  const r0 = Math.max(0, Math.floor((l.y0 - maxy) / hgt));
  const r1 = Math.min((l.rows ?? Infinity) - 1, Math.floor((l.y0 - miny) / hgt - 1e-9));
  return { c0, c1, r0, r1 };
}
/** A lon/lat box in a grid's CRS (3857 or 4326). */
export const boxIn = (epsg, [w, s, e, n]) => (epsg === 3857 ? [mercX(w), mercY(s), mercX(e), mercY(n)] : [w, s, e, n]);

// ---------------------------------------------------------------- WMS

/** Order a box [minx, miny, maxx, maxy] (x = east) as the CRS's axis order requires in a WMS 1.3.0 BBOX. */
const bboxParam = (b, crs, version) => (latFirst(crs, version) ? [b[1], b[0], b[3], b[2]] : b).map((v) => +Number(v).toFixed(10)).join(',');

/**
 * A WMS GetMap URL. s: {url, layers, styles?, format?, version?, time?, transparent?}; bbox in the
 * CRS with x = east (or longitude); the axis order of the request follows the version and CRS.
 */
export function wmsGetMapUrl(s, { bbox, crs = 'EPSG:3857', width = 256, height = 256 }) {
  const v = s.version ?? '1.3.0';
  return withParams(s.url, { SERVICE: 'WMS', REQUEST: 'GetMap', VERSION: v, LAYERS: s.layers ?? '', STYLES: s.styles ?? '', [v.startsWith('1.1') ? 'SRS' : 'CRS']: crs, BBOX: bboxParam(bbox, crs, v), WIDTH: width, HEIGHT: height, FORMAT: s.format ?? 'image/png', TRANSPARENT: s.transparent === false ? 'FALSE' : 'TRUE', TIME: s.time ?? null });
}

/** A WMS GetFeatureInfo URL for pixel (i, j) of a GetMap of `bbox` (same conventions as wmsGetMapUrl). */
export function wmsFeatureInfoUrl(s, { bbox, crs = 'EPSG:3857', width = 256, height = 256, i, j, infoFormat = 'application/json', featureCount = 10 }) {
  const v = s.version ?? '1.3.0';
  const old = v.startsWith('1.1');
  return withParams(s.infoUrl ?? s.url, { SERVICE: 'WMS', REQUEST: 'GetFeatureInfo', VERSION: v, LAYERS: s.layers ?? '', QUERY_LAYERS: s.queryLayers ?? s.layers ?? '', STYLES: s.styles ?? '', [old ? 'SRS' : 'CRS']: crs, BBOX: bboxParam(bbox, crs, v), WIDTH: width, HEIGHT: height, [old ? 'X' : 'I']: Math.round(i), [old ? 'Y' : 'J']: Math.round(j), INFO_FORMAT: infoFormat, FEATURE_COUNT: featureCount, FORMAT: s.format ?? 'image/png', TIME: s.time ?? null });
}

/** The preferred GetFeatureInfo format among those offered: GeoJSON/JSON, then GML, then plain text, then HTML. */
export function pickInfoFormat(offered = []) {
  const pref = [/geo\+?json/i, /application\/json/i, /gml/i, /text\/xml|application\/vnd\.ogc\.gml/i, /text\/plain/i, /text\/html/i];
  for (const p of pref) {
    const f = offered.find((x) => p.test(x));
    if (f) return f;
  }
  return offered[0] ?? 'text/plain';
}

/** A GetFeatureInfo response → rows [{layer, props}] (GeoJSON, GML/XML or text/HTML as one text row). */
export function parseFeatureInfo(body, contentType = '') {
  const ct = String(contentType);
  const s = String(body ?? '').trim();
  if (/json/i.test(ct) || /^[{[]/.test(s)) {
    try {
      const j = JSON.parse(s);
      const fs = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : Array.isArray(j.results) ? j.results : [];
      return fs.map((f) => ({ layer: f.layerName ?? f.layerId ?? (typeof f.id === 'string' ? f.id.split('.')[0] : ''), props: f.properties ?? f.attributes ?? {} }));
    } catch {
      /* fall through to text */
    }
  }
  if (/xml|gml/i.test(ct) || s.startsWith('<?xml') || /^<[A-Za-z_:][^>]*>/.test(s)) {
    try {
      const r = parseXml(s);
      const rows = [];
      // GML feature members, or MapServer's msGMLOutput (<x_layer><x_feature>), or ESRI FIELDS rows.
      const members = all(r, 'featureMember').flatMap((m) => m.children).concat(all(r, 'member').flatMap((m) => m.children));
      for (const f of members) rows.push({ layer: f.name, props: Object.fromEntries(f.children.filter((c) => !c.children.length).map((c) => [c.name, text(c)])) });
      if (!rows.length) for (const l of r.children.filter((c) => /_layer$/.test(c.name))) for (const f of l.children.filter((c) => /_feature$/.test(c.name))) rows.push({ layer: l.name.replace(/_layer$/, ''), props: Object.fromEntries(f.children.filter((c) => !c.children.length).map((c) => [c.name, text(c)])) });
      if (!rows.length) for (const f of all(r, 'FIELDS')) rows.push({ layer: '', props: { ...f.attrs } });
      if (rows.length) return rows;
    } catch {
      /* HTML that is not XML: shown as text */
    }
  }
  const plain = s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return plain ? [{ layer: '', props: { text: plain.slice(0, 4000) } }] : [];
}

// ---------------------------------------------------------------- OGC API

const CONF = {
  features: /ogcapi-features-1\/1\.0\/conf\/core/,
  filter: /ogcapi-features-3\/1\.0\/conf\/(features-)?filter|cql2\/1\.0\/conf\/(basic-cql2|cql2-text)/,
  cql2json: /cql2\/1\.0\/conf\/cql2-json/,
  create: /ogcapi-features-4\/1\.0\/conf\/create-replace-delete/,
  tiles: /ogcapi-tiles-1\/1\.0\/conf\/core/,
  maps: /ogcapi-maps-1\/1\.0\/conf\/core/,
  coverages: /ogcapi-coverages-1\/1\.0\/conf\/core/,
  records: /ogcapi-records-1\/1\.0\/conf\/core/,
  processes: /ogcapi-processes-1\/1\.0\/conf\/core/,
  itemSearch: /stac-api\/[^/]+\/item-search/,
};
/** The conformance classes an OGC API declares → {features, filter, cql2json, create, tiles, maps, coverages, records, processes, itemSearch}. */
export function conformance(list) {
  const cs = Array.isArray(list) ? list : list?.conformsTo ?? [];
  return Object.fromEntries(Object.entries(CONF).map(([k, re]) => [k, cs.some((c) => re.test(c))]));
}

/** The URL of the next page of an OGC API / STAC response (a link with rel "next"), or null. */
export const nextLink = (j, base = '') => {
  const l = (j?.links ?? []).find((x) => x.rel === 'next');
  if (!l) return null;
  return { href: resolveUrl(l.href, base), method: l.method ?? 'GET', body: l.body ?? null, merge: !!l.merge };
};

/** An OGC API Maps request for a box: /map?bbox=…&bbox-crs=…&width&height&f=png. */
export function ogcMapUrl(collectionOrBase, { base = null, bbox, crs = 'http://www.opengis.net/def/crs/OGC/1.3/CRS84', width = 256, height = 256, format = 'png', transparent = true, datetime = null }) {
  const href = typeof collectionOrBase === 'string' ? collectionOrBase : linkOf(collectionOrBase.links, 'map') ?? `${String(base).replace(/\/$/, '')}/collections/${encodeURIComponent(collectionOrBase.id)}/map`;
  const e = epsgOf(crs);
  const crsUri = e === 4326 && isCrs84(crs) ? 'http://www.opengis.net/def/crs/OGC/1.3/CRS84' : e ? `http://www.opengis.net/def/crs/EPSG/0/${e}` : crs;
  return withParams(resolveUrl(href, base ?? href), { f: format, bbox: bbox.map((v) => +Number(v).toFixed(10)).join(','), 'bbox-crs': crsUri, crs: crsUri, width, height, transparent: transparent ? 'true' : null, datetime });
}

// ---------------------------------------------------------------- STAC

/** Check a STAC API landing page → {title, search (url), searchPost, collections (url)} or an error. */
export function stacLanding(j, url) {
  if (!j || (j.type !== 'Catalog' && !j.stac_version && !j.conformsTo)) throw gwError('{url} is not a STAC API landing page', { url }, 'E_NOT_STAC');
  const search = (j.links ?? []).filter((l) => l.rel === 'search');
  const post = search.find((l) => (l.method ?? 'GET').toUpperCase() === 'POST');
  const get = search.find((l) => (l.method ?? 'GET').toUpperCase() === 'GET');
  const conf = conformance(j.conformsTo ?? []);
  if (!search.length && !conf.itemSearch) throw gwError('{url} is a static STAC catalogue without item search; open its items by URL instead', { url }, 'E_STAC_NO_SEARCH');
  const s = post ?? get;
  return { title: j.title ?? j.id ?? url, search: s ? resolveUrl(s.href, url) : `${url.replace(/\/$/, '')}/search`, searchPost: !!post || (!get && conf.itemSearch), collections: resolveUrl(linkOf(j.links, 'data') ?? `${url.replace(/\/$/, '')}/collections`, url) };
}
