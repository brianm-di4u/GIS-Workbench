// Online services (REQ-GAP-05, REQ-GAP-06, REQ-GAP-07): one dialog to connect to a WMS, WMTS,
// ArcGIS REST (MapServer, FeatureServer, ImageServer, VectorTileServer, SceneServer), OGC API
// (Features with CQL2, Tiles, Maps, Coverages, Records, Processes), WCS 2.0, WPS 2.0 or
// SensorThings endpoint, browse what it offers, and use each item as
//   • a Map-view background, or a basemap warped under images through their sensor models;
//   • a service image layer: a georeferenced image layer fetched for the current area (GetMap,
//     export, exportImage, OGC API Maps, WCS GetCoverage or OGC API Coverages as GeoTIFF) that
//     measurement, chips and the error budget treat like any opened image, with its pixel size
//     and the accuracy the service states (none, unless the analyst enters one) shown;
//   • a vector layer (OGC API Features pages, SensorThings Things, I3S building footprints, ArcGIS
//     layers through Edit Online Layer).
// Every request goes through the logged fetch: nothing leaves before the origin is in the
// allow-list (REQ-ARC-16, REQ-SEC-12). Tokens stay in memory (REQ-SEC-10).

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { openImageFile } from '../formats/open.js';
import { crsOf } from '../geo/crs.js';
import { boxInCrs, auxXml, imageSize, MERC_EPSG } from '../connectors/service-image.js';
import { fromGeoJSON } from '../vector/geom.js';
import * as OE from '../connectors/ogc.js';
import * as OC from '../connectors/ogc-clients.js';
import * as A from '../connectors/arcgis.js';
import * as I from '../connectors/i3s.js';
import { exceptionText } from '../connectors/xml.js';
import { t, tc, N_, tr, msgOf, gwError } from '../i18n/index.js';
import { num } from '../i18n/format.js';

const O = { ...OE, ...OC };
const geojsonToGeom = (g) => {
  try {
    const geom = g ? fromGeoJSON(g) : null;
    return Array.isArray(geom) ? null : geom;
  } catch {
    return null;
  }
};

const KINDS = ['auto', 'wms', 'wmts', 'arcgis', 'ogcapi', 'wcs', 'wps', 'sta'];
/** Item types: the record keeps the English key; the dialog shows it translated. */
const TYPE_LABEL = {
  'WMS layer': N_('WMS layer'),
  'WMTS layer': N_('WMTS layer'),
  'WCS coverage': N_('WCS coverage'),
  'WPS process': N_('WPS process'),
  SensorThings: N_('SensorThings Things'),
  'OGC API Features': N_('OGC API Features'),
  'OGC API Records': N_('OGC API Records'),
  'OGC API Coverage': N_('OGC API Coverage'),
  'OGC API Maps': N_('OGC API Maps'),
  'OGC API Tiles': N_('OGC API Tiles'),
  'OGC API collection': N_('OGC API collection'),
  'OGC API process': N_('OGC API process'),
  'ArcGIS cached map': N_('ArcGIS cached map'),
  'ArcGIS dynamic map': N_('ArcGIS dynamic map'),
  'ArcGIS map layer': N_('ArcGIS map layer'),
  'ArcGIS feature layer': N_('ArcGIS feature layer'),
  'ArcGIS image service': N_('ArcGIS image service'),
  'ArcGIS vector tiles': N_('ArcGIS vector tiles'),
};
const typeLabel = (type) => (TYPE_LABEL[type] ? tr(TYPE_LABEL[type]) : /^I3S /.test(type) ? t('I3S {kind} layer', { kind: type.replace(/^I3S | layer$/g, '') }) : type);

const inter = (a, b) => !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const boxOf = (pts) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];

export function install(app) {
  const S = app.store;
  const tokens = new Map(); // service URL → token (memory only, REQ-SEC-10)
  const services = new Map(); // id → connected service
  let seq = 0;

  // ---------------- HTTP through the logged fetch ----------------
  function request(svc, url, init = {}) {
    const tok = tokens.get(svc.url) ?? null;
    let u = url;
    const headers = { ...(init.headers ?? {}) };
    if (tok && svc.kind === 'arcgis') u = O.withParams(u, { token: tok });
    else if (tok) headers.Authorization = `Bearer ${tok}`;
    return app.netlog.fetchFor(`Service: ${svc.title || svc.url}`)(u, { credentials: 'omit', ...init, headers });
  }
  async function check(r, svc) {
    if (r.ok) return r;
    const body = await r.text().catch(() => '');
    const ex = exceptionText(body);
    throw gwError('{name}: HTTP {status}{detail}', { name: svc.title || svc.url, status: r.status, detail: ex ? ` (${ex})` : '' }, 'E_HTTP');
  }
  async function json(svc, url, init = {}) {
    const r = await check(await request(svc, url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } }), svc);
    const j = await r.json();
    const e = A.esriError(j, svc.title || svc.url);
    if (e) throw e;
    return j;
  }
  async function textOf(svc, url, init = {}) {
    const r = await check(await request(svc, url, init), svc);
    const s = await r.text();
    const ex = exceptionText(s);
    if (ex) throw gwError('{name}: {msg}', { name: svc.title || svc.url, msg: ex }, 'E_SERVICE');
    return s;
  }

  // ---------------- connect and browse ----------------
  /** Guess the kind of a service URL from its form (no request). */
  function guessKind(url) {
    if (A.arcgisParts(url)) return 'arcgis';
    const m = /[?&]service=(wms|wmts|wcs|wps)/i.exec(url);
    if (m) return m[1].toLowerCase();
    if (/\/v1\.[01]\/?$/.test(url) || /sensorthings|frost/i.test(url)) return 'sta';
    const p = /\/(wms|wmts|wcs|wps)\/?$/i.exec(url.replace(/[?#].*$/, ''));
    if (p) return p[1].toLowerCase();
    return null;
  }

  /**
   * Connect to a service: {id, kind, url, title, items: [{id, title, type, can: {...}, …}]}.
   * kind 'auto' guesses from the URL, then tries the JSON landing page (OGC API, SensorThings),
   * then GetCapabilities as WMS, WMTS, WCS and WPS.
   */
  async function connect(url0, { kind = 'auto', token = null, signal = null } = {}) {
    const url = String(url0 ?? '').trim();
    if (!/^https?:\/\//.test(url)) throw gwError('enter a service URL that starts with http:// or https:// first', null, 'E_STEP_FIRST');
    if (token) tokens.set(url, token);
    let k = kind === 'auto' ? guessKind(url) : kind;
    const svc = { id: `svc${++seq}`, url, kind: k, title: '', items: [] };
    if (!k) {
      // A JSON landing page first (one request), then the OWS capabilities in turn.
      try {
        const j = await json({ ...svc, kind: 'ogcapi' }, url, { signal });
        k = Array.isArray(j.value) && j.value.some((v) => v.name === 'Things' || v.name === 'Datastreams') ? 'sta' : 'ogcapi';
        svc.landing = j;
      } catch (e) {
        if (e?.notAllowed || e?.offline || e?.code === 'E_CANCELLED') throw e;
        for (const kk of ['wms', 'wmts', 'wcs', 'wps']) {
          try {
            svc.kind = kk;
            await browse(svc, { signal });
            k = kk;
            break;
          } catch (e2) {
            if (e2?.notAllowed || e2?.offline || e2?.code === 'E_CANCELLED') throw e2;
          }
        }
        if (!svc.items.length && !k) throw gwError('{url}: no WMS, WMTS, WCS, WPS, OGC API, SensorThings or ArcGIS REST service answered there', { url }, 'E_SERVICE_UNKNOWN');
      }
    }
    svc.kind = k;
    if (!svc.items.length) await browse(svc, { signal });
    if (token) tokens.set(svc.url, token);
    services.set(svc.id, svc);
    return svc;
  }

  async function browse(svc, { signal = null } = {}) {
    const u = svc.url;
    switch (svc.kind) {
      case 'wms': {
        const caps = O.parseWmsCapabilities(await textOf(svc, O.withParams(u, { SERVICE: 'WMS', REQUEST: 'GetCapabilities' }), { signal }), u);
        svc.caps = caps;
        svc.title = caps.title || u;
        svc.items = caps.layers.map((l) => ({ id: l.name, title: l.title, type: 'WMS layer', layer: l, bbox: l.bbox, time: l.time, can: { background: true, image: true, identify: l.queryable } }));
        break;
      }
      case 'wmts': {
        const caps = O.parseWmtsCapabilities(await textOf(svc, O.withParams(u, { SERVICE: 'WMTS', REQUEST: 'GetCapabilities' }), { signal }), u);
        svc.caps = caps;
        svc.title = caps.title || u;
        svc.items = caps.layers.map((l) => ({ id: l.id, title: l.title, type: 'WMTS layer', layer: l, bbox: l.bbox, time: l.dims.find((d) => /^time$/i.test(d.id)) ? { values: l.dims.find((d) => /^time$/i.test(d.id)).values, default: l.dims.find((d) => /^time$/i.test(d.id)).default } : null, can: { background: l.tms.some((id) => [3857, 4326].includes(caps.tms[id]?.epsg)) } }));
        break;
      }
      case 'wcs': {
        const caps = O.parseWcsCapabilities(await textOf(svc, O.withParams(u, { SERVICE: 'WCS', REQUEST: 'GetCapabilities', ACCEPTVERSIONS: '2.0.1' }), { signal }));
        svc.caps = caps;
        svc.title = caps.title || u;
        svc.items = caps.coverages.map((c) => ({ id: c.id, title: c.title || c.id, type: 'WCS coverage', bbox: c.bbox, can: { image: true } }));
        break;
      }
      case 'wps': {
        const caps = O.parseWpsCapabilities(await textOf(svc, O.withParams(u, { SERVICE: 'WPS', REQUEST: 'GetCapabilities', ACCEPTVERSIONS: '2.0.0' }), { signal }));
        svc.caps = caps;
        svc.title = caps.title || u;
        svc.items = caps.processes.map((p) => ({ id: p.id, title: p.title, type: 'WPS process', process: p, can: { run: true } }));
        break;
      }
      case 'sta': {
        const j = svc.landing ?? (await json(svc, u, { signal }));
        svc.title = u;
        svc.items = (j.value ?? []).some((v) => v.name === 'Things') ? [{ id: 'Things', title: 'Things', type: 'SensorThings', can: { features: true } }] : []; // i18n-ignore: the SensorThings entity set
        break;
      }
      case 'ogcapi': {
        const land = svc.landing ?? (await json(svc, O.withParams(u, { f: 'json' }), { signal }));
        svc.title = land.title || u;
        const cUrl = O.linkOf(land.links, 'conformance');
        const conf = O.conformance(land.conformsTo ?? (cUrl ? await json(svc, O.withParams(O.resolveUrl(cUrl, u), { f: /[?&]f=/.test(cUrl) ? null : 'json' }), { signal }).catch(() => ({})) : {}));
        svc.conf = conf;
        if (land.stac_version || conf.itemSearch) svc.stac = true;
        const items = [];
        const colUrl = O.linkOf(land.links, 'data') ?? `${u.replace(/\/$/, '')}/collections`;
        const cols = await O.collectPages(async (href) => {
          const j = await json(svc, href, { signal });
          return { items: j.collections ?? [], next: O.nextLink(j, href)?.href ?? null };
        }, { first: O.withParams(O.resolveUrl(colUrl, u), { f: /[?&]f=/.test(colUrl) ? null : 'json' }), max: 2000, signal }).catch(() => ({ items: [] }));
        for (const c of cols.items) {
          const off = O.collectionOffers(c);
          const sb = c.extent?.spatial?.bbox?.[0] ?? null;
          items.push({ id: c.id, title: c.title || c.id, type: off.records ? 'OGC API Records' : off.coverage ? 'OGC API Coverage' : off.features ? 'OGC API Features' : off.map ? 'OGC API Maps' : off.tiles ? 'OGC API Tiles' : 'OGC API collection', collection: c, bbox: sb, can: { features: off.features && !off.records, records: off.records, tiles: off.tiles, map: off.map, image: off.map || off.coverage, coverage: off.coverage, background: off.tiles || off.map } });
        }
        if (conf.processes || O.linkOf(land.links, 'processes')) {
          const pUrl = O.resolveUrl(O.linkOf(land.links, 'processes') ?? `${u.replace(/\/$/, '')}/processes`, u);
          const pj = await json(svc, O.withParams(pUrl, { f: /[?&]f=/.test(pUrl) ? null : 'json' }), { signal }).catch(() => ({ processes: [] }));
          for (const p of pj.processes ?? []) items.push({ id: p.id, title: p.title || p.id, type: 'OGC API process', process: p, processesUrl: pUrl, can: { run: true } });
        }
        svc.items = items;
        break;
      }
      case 'arcgis': {
        const parts = A.arcgisParts(u);
        if (!parts) throw gwError('{url} is not an ArcGIS REST service URL (…/MapServer, …/FeatureServer, …/ImageServer, …/VectorTileServer or …/SceneServer)', { url: u }, 'E_NOT_ARCGIS');
        const j = await json(svc, O.withParams(u, { f: 'json' }), { signal });
        svc.info = j;
        svc.parts = parts;
        svc.title = j.documentInfo?.Title || j.name || j.mapName || u.split('/').slice(-2).join('/');
        const items = [];
        const root = parts.root;
        if (parts.layer !== null && parts.type !== 'SceneServer') items.push({ id: String(parts.layer), title: j.name ?? String(parts.layer), type: j.type ?? 'Feature Layer', url: `${root}/${parts.layer}`, info: j, can: { features: true, edit: parts.type === 'FeatureServer' } });
        else if (parts.type === 'MapServer') {
          items.push({ id: 'map', title: svc.title, type: j.singleFusedMapCache ? 'ArcGIS cached map' : 'ArcGIS dynamic map', url: root, info: j, time: j.timeInfo ? { extent: j.timeInfo.timeExtent } : null, can: { background: true, image: true, identify: true } });
          for (const l of j.layers ?? []) if (!l.subLayerIds?.length) items.push({ id: String(l.id), title: l.name, type: 'ArcGIS map layer', url: `${root}/${l.id}`, can: { features: true } });
        } else if (parts.type === 'FeatureServer') {
          for (const l of [...(j.layers ?? []), ...(j.tables ?? [])]) items.push({ id: String(l.id), title: l.name, type: 'ArcGIS feature layer', url: `${root}/${l.id}`, can: { features: true, edit: true } });
        } else if (parts.type === 'ImageServer') {
          items.push({ id: 'image', title: j.name ?? svc.title, type: 'ArcGIS image service', url: root, info: j, can: { background: true, image: true, identify: true } });
        } else if (parts.type === 'VectorTileServer') {
          items.push({ id: 'vt', title: j.name ?? svc.title, type: 'ArcGIS vector tiles', url: root, info: j, can: { background: true } });
        } else if (parts.type === 'SceneServer') {
          const ls = parts.layer !== null ? [{ id: parts.layer, name: j.name, layerType: j.layerType }] : j.layers ?? [];
          for (const l of ls) items.push({ id: String(l.id), title: l.name ?? String(l.id), type: `I3S ${l.layerType ?? 'scene'} layer`, url: I.sceneLayerUrl(root, l.id), can: { scene: true } });
        }
        svc.items = items;
        break;
      }
      default:
        throw gwError('unknown service type {kind}', { kind: String(svc.kind) }, 'E_SERVICE_UNKNOWN');
    }
    if (!svc.items.length) throw gwError('{name}: the service lists nothing GIS Workbench can use', { name: svc.title || u }, 'E_SERVICE_EMPTY');
    return svc;
  }

  // ---------------- areas ----------------
  /** The lon/lat box being looked at: the active image view's ground footprint, else the Map view. */
  function viewBox() {
    const p = app.activePane?.();
    const l = p?.geoLayer?.();
    if (l?.modelId) {
      const { w, h: hh } = p.size();
      const pts = [];
      for (const [x, y] of [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]]) {
        try {
          const v = p.viewPoint(x, y);
          const g = l.groundAt(v.x, v.y);
          if (g && Number.isFinite(g.lat)) pts.push([g.lon, g.lat]);
        } catch {
          /* outside the model */
        }
      }
      if (pts.length >= 2) return boxOf(pts);
    }
    const map = app.desktop?.workspace?.map;
    if (map) {
      const r = map.el.getBoundingClientRect();
      const hw = (r.width || 800) / 2 / map.view.zoom;
      const hh = (r.height || 600) / 2 / map.view.zoom;
      return [Math.max(-180, map.view.lon - hw), Math.max(-90, map.view.lat - hh), Math.min(180, map.view.lon + hw), Math.min(90, map.view.lat + hh)];
    }
    return null;
  }

  // ---------------- backgrounds (Map view; under images when Web Mercator) ----------------
  /** Add an item as an online map source and make it the active background. Returns the source. */
  async function addBackground(svc, item, { crs = null, style = null, time = null, under = false } = {}) {
    let src;
    const base = { name: item.title, attribution: svc.info?.copyrightText ?? svc.caps?.title ?? '', service: { kind: svc.kind, url: svc.url, item: item.id } };
    if (svc.kind === 'wms') {
      const l = item.layer;
      const has = (re) => l.crs.find((c) => re.test(c));
      const c = crs ?? has(/^EPSG:(3857|900913|102100)$/i) ?? has(/^(CRS:84|EPSG:4326)$/i);
      if (!c) throw gwError('{layer} is offered only in {crs}; the Map view draws EPSG:3857 and EPSG:4326. Open it as an image layer instead.', { layer: item.title, crs: l.crs.slice(0, 4).join(', ') }, 'E_WMS_CRS');
      const fmt = svc.caps.formats.find((f) => /png/.test(f)) ?? svc.caps.formats[0] ?? 'image/png';
      src = { ...base, kind: 'wms', url: svc.caps.getMap || svc.url, layers: l.name, styles: style ?? '', format: fmt, version: svc.caps.version, crs: epsgName(c), time: time ?? l.time?.default ?? null, times: l.time?.values?.slice(0, 500) ?? null, infoUrl: svc.caps.getFeatureInfo, infoFormat: O.pickInfoFormat(svc.caps.infoFormats), queryable: l.queryable, maxZoom: 19 };
    } else if (svc.kind === 'wmts') {
      const l = item.layer;
      const tmsId = l.tms.find((id) => svc.caps.tms[id]?.epsg === 3857) ?? l.tms.find((id) => svc.caps.tms[id]?.epsg === 4326);
      if (!tmsId) throw gwError('{layer}: none of its tile matrix sets is in EPSG:3857 or EPSG:4326', { layer: item.title }, 'E_WMTS_CRS');
      const set = svc.caps.tms[tmsId];
      const tdim = l.dims.find((d) => /^time$/i.test(d.id));
      const { template } = O.wmtsTemplate(svc.caps, l, { tms: tmsId, style, dims: tdim ? { [tdim.id]: '{Time}' } : {} });
      src = { ...base, kind: 'wmts', url: template.replace(/%7BTime%7D/gi, '{Time}'), grid: { epsg: set.epsg, levels: set.levels }, time: time ?? tdim?.default ?? null, times: tdim?.values ?? null, maxZoom: set.levels.length - 1 };
    } else if (svc.kind === 'arcgis' && item.type === 'ArcGIS vector tiles') {
      const vt = A.vectorTileInfo(item.url, item.info);
      src = { ...base, kind: 'arcgis-vt', url: vt.template, grid: vt.grid && !(vt.grid.epsg === 3857 && vt.grid.levels.every((x, i) => Number(x.id) === i)) ? vt.grid : null, maxZoom: vt.maxZoom };
    } else if (svc.kind === 'arcgis' && item.type === 'ArcGIS image service') {
      src = { ...base, kind: 'arcgis-image', url: item.url, time: time ?? null, maxZoom: 19 };
    } else if (svc.kind === 'arcgis' && item.id === 'map') {
      const g = item.info.singleFusedMapCache ? A.arcgisGrid(item.info.tileInfo) : null;
      if (g && [3857, 4326].includes(g.epsg)) src = { ...base, kind: 'arcgis', url: item.url, grid: g.epsg === 3857 && g.levels.every((x, i) => Number(x.id) === i) && Math.abs(g.levels[0].res - 156543.03392804097) < 1e-3 ? null : g, maxZoom: Math.max(...g.levels.map((x) => Number(x.id))) };
      else src = { ...base, kind: 'arcgis-export', url: item.url, time: time ?? null, crs: crs ? epsgName(crs) : null, maxZoom: 19 };
    } else if (svc.kind === 'ogcapi' && item.can.tiles) {
      const c = item.collection;
      const tl = O.linkOf(c.links, ['tilesets-map', 'tilesets-vector', 'tiles']);
      const tsList = await json(svc, O.withParams(O.resolveUrl(tl, svc.url), { f: /[?&]f=/.test(tl) ? null : 'json' }));
      const sets = tsList.tilesets ?? [tsList];
      const ts = sets.find((x) => /WebMercatorQuad/i.test(x.tileMatrixSetURI ?? x.tileMatrixSetId ?? x.title ?? '')) ?? sets[0];
      let tmpl = O.ogcTileTemplate(tsList.tilesets ? { ...ts, links: [...(ts.links ?? []), ...(tsList.links ?? [])] } : ts, svc.url);
      if (!tmpl) {
        const self = O.linkOf(ts.links, 'self');
        if (self) tmpl = O.ogcTileTemplate(await json(svc, O.resolveUrl(self, svc.url)), svc.url);
      }
      if (!tmpl) throw gwError('{layer}: the tileset gives no tile URL template', { layer: item.title }, 'E_OGC_TILES');
      if (!/WebMercatorQuad/i.test(tmpl.tms)) throw gwError('{layer}: only WebMercatorQuad tilesets are drawn (this one is {tms})', { layer: item.title, tms: tmpl.tms }, 'E_OGC_TILES');
      src = { ...base, kind: 'ogc-tiles', url: tmpl.template.replace(/\{tileMatrixSetId\}/g, 'WebMercatorQuad').replace(/\{tileMatrix\}/g, '{TileMatrix}').replace(/\{tileRow\}/g, '{TileRow}').replace(/\{tileCol\}/g, '{TileCol}'), vector: tmpl.vector, maxZoom: 16 };
    } else if (svc.kind === 'ogcapi' && item.can.map) {
      const href = O.resolveUrl(O.linkOf(item.collection.links, 'map') ?? `${svc.url.replace(/\/$/, '')}/collections/${encodeURIComponent(item.id)}/map`, svc.url);
      src = { ...base, kind: 'ogc-map', url: href.replace(/([?&])f=[^&]*/, '$1').replace(/[?&]$/, ''), crs: crs ?? 'EPSG:3857', maxZoom: 19 };
    } else throw gwError('{layer} cannot be shown as a map background', { layer: item.title }, 'E_NOT_BACKGROUND');
    const s = app.online.addSource({ ...src, token: tokens.get(svc.url) ?? null, tokenParam: svc.kind === 'arcgis' ? 'token' : null });
    app.online.active = s.id;
    app.online.visible = true;
    app.onlineTiles.reset();
    app.online.save();
    if (under && app.onlineIsMercator(s) && app.setBasemap) await app.setBasemap(`user:${s.id}`);
    return s;
  }
  const epsgName = (c) => (O.isCrs84(c) ? 'CRS:84' : `EPSG:${O.epsgOf(c)}`);

  // ---------------- service image layers (REQ-GAP-07) ----------------
  /** The CRS to request an image in: EPSG:4326 when offered, else Web Mercator, else the first CRS the app knows. */
  function imageCrs(svc, item, wanted) {
    if (wanted) return O.epsgOf(wanted);
    if (svc.kind === 'wms') {
      const l = item.layer.crs;
      if (l.some((c) => /^(EPSG:4326|CRS:84)$/i.test(c))) return 4326;
      if (l.some((c) => MERC_EPSG.has(O.epsgOf(c)))) return 3857;
      const k = l.map(O.epsgOf).find((e) => e && crsOf({ epsg: e }));
      if (!k) throw gwError('{layer}: none of its CRSs ({crs}) is known to GIS Workbench', { layer: item.title, crs: l.slice(0, 6).join(', ') }, 'E_CRS_UNKNOWN');
      return k;
    }
    return 4326;
  }

  /**
   * Fetch an item as a georeferenced image layer for a lon/lat box (default: the current view):
   * WMS GetMap, ArcGIS export / exportImage, OGC API Maps (PNG with a geotransform sidecar), WCS
   * 2.0 GetCoverage or OGC API Coverages (GeoTIFF). opts: bbox, size (longer side, px), crs,
   * time, accuracy (a CE90 in metres the analyst states for the service), pane.
   */
  async function openImage(svc, item, { bbox = null, size = 1024, crs = null, time = null, accuracy = null, pane = null, signal = null } = {}) {
    const ll = bbox ?? viewBox();
    if (!ll) throw gwError('open a georeferenced image or move the Map view to the area first, so the request knows where to look', null, 'E_STEP_FIRST');
    let file;
    let sidecars = [];
    let epsg = 4326;
    let gsd = null;
    const safe = String(item.id).replace(/[^\w.-]+/g, '_').slice(0, 40) || 'service';
    if (svc.kind === 'wcs' || (svc.kind === 'ogcapi' && item.can.coverage)) {
      let url;
      if (svc.kind === 'wcs') {
        const d = O.parseWcsDescribe(await textOf(svc, O.withParams(svc.url, { SERVICE: 'WCS', VERSION: '2.0.1', REQUEST: 'DescribeCoverage', COVERAGEID: item.id }), { signal }));
        epsg = d.epsg ?? 4326;
        const { box } = boxInCrs(ll, epsg);
        const fmt = svc.caps.formats.find((f) => /tiff/i.test(f)) ?? 'image/tiff';
        url = O.wcsGetCoverageUrl(svc.url, d, { bbox: box, format: fmt });
      } else url = O.ogcCoverageUrl(item.collection, { base: svc.url, bbox: ll, format: 'GTiff' });
      const r = await check(await request(svc, url, { signal, headers: { Accept: 'image/tiff; application=geotiff, image/tiff' } }), svc);
      const ct = r.headers.get('content-type') ?? '';
      const buf = await r.arrayBuffer();
      const u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
      const isTiff = (u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d);
      if (!isTiff) throw gwError('{layer}: the service sent {type}, not a GeoTIFF', { layer: item.title, type: ct || t('an unknown format') }, 'E_NOT_GEOTIFF');
      file = new File([buf], `${safe}.tif`, { type: 'image/tiff' });
    } else {
      epsg = imageCrs(svc, item, crs);
      const { box } = boxInCrs(ll, epsg);
      const { width, height, gt } = imageSize(box, epsg, size);
      let url;
      if (svc.kind === 'wms') url = O.wmsGetMapUrl({ url: svc.caps.getMap || svc.url, layers: item.layer.name, version: svc.caps.version, format: svc.caps.formats.find((f) => /png/.test(f)) ?? 'image/png', time: time ?? item.layer.time?.default ?? null, transparent: false }, { bbox: box, crs: epsg === 4326 ? (item.layer.crs.includes('EPSG:4326') ? 'EPSG:4326' : 'CRS:84') : `EPSG:${epsg}`, width, height });
      else if (svc.kind === 'arcgis' && item.type === 'ArcGIS image service') url = A.arcgisImageUrl(item.url, { bbox: box, sr: epsg, width, height, format: 'png', time });
      else if (svc.kind === 'arcgis' && item.id === 'map') url = A.arcgisExportUrl(item.url, { bbox: box, sr: epsg, width, height, time, transparent: false, format: 'png32' });
      else if (svc.kind === 'ogcapi' && item.can.map) url = O.ogcMapUrl(item.collection, { base: svc.url, bbox: box, crs: epsg === 4326 ? 'CRS84' : `EPSG:${epsg}`, width, height, transparent: false, datetime: time });
      else throw gwError('{layer} cannot be opened as an image layer', { layer: item.title }, 'E_NOT_IMAGE');
      const r = await check(await request(svc, url, { signal }), svc);
      const ct = r.headers.get('content-type') ?? '';
      const blob = await r.blob();
      if (/xml|json|text/i.test(ct)) {
        const body = await blob.text();
        throw gwError('{layer}: {msg}', { layer: item.title, msg: exceptionText(body) ?? body.slice(0, 200) }, 'E_SERVICE');
      }
      const ext = /jpe?g/i.test(ct) ? 'jpg' : 'png';
      file = new File([blob], `${safe}.${ext}`, { type: ct || `image/${ext}` });
      sidecars = [new File([auxXml(gt, epsg)], `${safe}.${ext}.aux.xml`, { type: 'application/xml' })];
      gsd = epsg === 4326 ? -gt[5] * 111320 : -gt[5];
    }
    const res = await openImageFile(app, file, { sidecars, pane: pane ?? app.activePane() });
    const l = res.layers?.[0];
    const statement = { service: svc.kind, url: svc.url, item: item.id, bbox: ll, epsg, gsd, ce90: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : null, stated: Number.isFinite(accuracy) && accuracy > 0 ? 'analyst' : 'none', fetched: new Date().toISOString() };
    if (l?.id && S.get(l.id)) S.transact(t('Service layer'), (tx) => tx.set(l.id, 'service', statement), { kind: 'load' });
    app.toast(accuracyText(statement, item.title), { kind: 'info', ms: 9000 });
    return { layer: l, statement };
  }
  /** The accuracy note of a service image layer, in words (REQ-GAP-07). */
  function accuracyText(st, title) {
    const px = Number.isFinite(st.gsd) ? num(st.gsd, st.gsd < 10 ? 2 : 0) : t('unknown');
    return st.ce90 ? t('{layer}: service image in EPSG:{epsg}, pixel {px} m; accuracy stated by the analyst: CE90 {ce} m. Measurements use the map model and show the error budget of the model, not this statement.', { layer: title, epsg: String(st.epsg), px, ce: num(st.ce90, 1) }) : t('{layer}: service image in EPSG:{epsg}, pixel {px} m. The service states no positional accuracy, so measurements on it show "error not available".', { layer: title, epsg: String(st.epsg), px });
  }

  // ---------------- vector layers ----------------
  function vectorLayer(nameV, feats, source, style = { stroke: '#22d3ee', width: 2, fill: '#22d3ee22' }) {
    const keys = [...new Set(feats.slice(0, 200).flatMap((f) => Object.keys(f.properties ?? {})))];
    const fields = keys.map((k) => ({ name: k, type: feats.some((f) => typeof f.properties?.[k] === 'number') && feats.every((f) => f.properties?.[k] === null || f.properties?.[k] === undefined || typeof f.properties[k] === 'number') ? 'number' : 'string' }));
    let vl;
    let skipped = 0;
    S.transact(t('Open {name}', { name: nameV }), (tx) => {
      vl = tx.create('vlayer', { name: nameV, visible: true, style, fields, source: { format: source.format, url: source.url, service: source, remote: false }, created: new Date().toISOString() });
      for (const f of feats) {
        const geom = geojsonToGeom(f.geometry);
        if (!geom) {
          skipped++;
          continue;
        }
        const attrs = {};
        for (const [k, v] of Object.entries(f.properties ?? {})) attrs[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        tx.create('feature', { vlayer: vl, geom, attrs, name: null, remoteId: f.id ?? null, prov: { kind: 'service', source: source.url } });
      }
    }, { kind: 'load' });
    app.emit('state');
    return { vl, count: feats.length - skipped, skipped };
  }

  /**
   * Load an item's features into a vector layer: OGC API Features (paged by next links, with a
   * CQL2 filter), SensorThings Things (paged by @iot.nextLink), or an ArcGIS layer (Edit Online
   * Layer, paged). opts: bbox, filter (CQL2 text), max, signal, onPage.
   */
  async function loadFeatures(svc, item, { bbox = null, filter = null, max = 10000, signal = null, onPage = null, datetime = null } = {}) {
    if (svc.kind === 'arcgis') {
      const vl = await app.remoteEdit.open({ kind: 'arcgis', url: item.url, name: item.title }, { token: tokens.get(svc.url) ?? null, bbox, max, signal, onPage, where: filter || '1=1' });
      return { vl, ...(app.remoteEdit.info(vl) ?? {}) };
    }
    if (svc.kind === 'sta') {
      const got = await O.collectPages(async (href) => {
        const j = await json(svc, href, { signal });
        return { items: j.value ?? [], next: j['@iot.nextLink'] ?? null };
      }, { first: O.staThingsUrl(svc.url, { top: Math.min(200, max), bbox }), max, signal, onPage });
      const feats = O.staToFeatures(got.items);
      return { ...vectorLayer(`${item.title} (SensorThings)`, feats, { format: 'sensorthings', url: svc.url, kind: 'sta' }), pages: got.pages, truncated: got.truncated };
    }
    if (svc.kind !== 'ogcapi' || !(item.can.features || item.can.records)) throw gwError('{layer} has no features to load', { layer: item.title }, 'E_NOT_FEATURES');
    if (filter) {
      const bad = O.checkCql2(filter);
      if (bad) throw bad;
      if (svc.conf && !svc.conf.filter) throw gwError('{name} does not declare CQL2 filtering (OGC API Features Part 3); remove the filter or use another service', { name: svc.title }, 'E_NO_CQL2');
    }
    const first = O.itemsUrl(item.collection, { base: svc.url, bbox, limit: Math.min(1000, max), filter: filter || null, datetime });
    const got = await O.collectPages(async (href) => {
      const j = await json(svc, href, { signal, headers: { Accept: 'application/geo+json, application/json' } });
      return { items: j.features ?? [], next: O.nextLink(j, href)?.href ?? null };
    }, { first, max, signal, onPage });
    return { ...vectorLayer(item.title, got.items, { format: 'ogcapi-features', url: first, kind: 'ogcapi', collection: item.id, filter: filter || null }), pages: got.pages, truncated: got.truncated };
  }

  /** OGC API Records: search a catalogue collection → [{id, title, description, links, bbox}]. */
  async function searchRecords(svc, item, { q = null, bbox = null, max = 200, signal = null } = {}) {
    const first = O.itemsUrl(item.collection, { base: svc.url, bbox, limit: Math.min(100, max), q });
    const got = await O.collectPages(async (href) => {
      const j = await json(svc, href, { signal });
      return { items: j.features ?? [], next: O.nextLink(j, href)?.href ?? null };
    }, { first, max, signal });
    return got.items.map((r) => ({ id: r.id, title: r.properties?.title ?? r.id, description: r.properties?.description ?? '', links: r.links ?? [], geometry: r.geometry ?? null }));
  }

  /**
   * Read an I3S 3DObject layer's leaf nodes in a lon/lat box into building footprints with base
   * and top heights (REQ-GAP-05). opts: bbox, maxNodes (leaf nodes read), maxAttributes.
   */
  async function loadScene(svc, item, { bbox = null, maxNodes = 64, maxAttributes = 8, signal = null, onPage = null } = {}) {
    const lj = await json(svc, item.url, { signal });
    const info = I.sceneLayerInfo(lj);
    const box = bbox ?? viewBox() ?? info.extent;
    // Top-down from the root: only the node pages that hold nodes over the area are read.
    const { nodes, leaves, pages } = await I.nodesIn((u) => json(svc, u, { signal }), item.url, info, box, { maxLeaves: maxNodes, signal });
    const pick = leaves.filter((n) => inter(I.nodeBox(n, info.wkid), box)).slice(0, maxNodes);
    const feats = [];
    const seen = new Set();
    const decodable = info.layerType === '3DObject' && info.plain.some(Boolean);
    let read = 0;
    for (const n of pick) {
      if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
      const res = n.mesh?.geometry?.resource ?? n.index;
      if (!decodable) {
        const b = I.nodeBox(n, info.wkid);
        if (b) feats.push({ type: 'Feature', id: `node ${n.index}`, properties: { node: n.index, zmin: n.obb.center[2] - n.obb.halfSize[2], zmax: n.obb.center[2] + n.obb.halfSize[2] }, geometry: { type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] } });
        continue;
      }
      const def = info.plain[n.mesh.geometry.definition ?? 0] ?? info.plain.find(Boolean);
      const r = await check(await request(svc, `${item.url}/nodes/${res}/geometries/${def.index}`, { signal }), svc);
      const geom = I.decodeGeometry(await r.arrayBuffer(), def.layout);
      const fs = I.nodeFeatures(n, geom);
      const attrs = {};
      for (const a of info.attributes.slice(0, maxAttributes)) {
        try {
          const ar = await check(await request(svc, `${item.url}/nodes/${n.mesh?.attribute?.resource ?? res}/attributes/${a.key}/0`, { signal }), svc);
          attrs[a.name] = I.decodeAttribute(await ar.arrayBuffer(), a);
        } catch (e) {
          if (e?.code === 'E_CANCELLED') throw e;
        }
      }
      fs.forEach((f, i) => {
        if (seen.has(f.featureId)) return;
        seen.add(f.featureId);
        const props = { featureId: f.featureId, zmin: +f.zmin.toFixed(3), zmax: +f.zmax.toFixed(3), height: +(f.zmax - f.zmin).toFixed(3), node: n.index };
        for (const [k, vals] of Object.entries(attrs)) if (vals.length === fs.length) props[k] = vals[i];
        feats.push({ type: 'Feature', id: String(f.featureId), properties: props, geometry: { type: 'Polygon', coordinates: [f.ring.map(([x, y]) => [x, y, f.zmin])] } });
      });
      onPage?.({ pages: ++read, items: feats.length });
    }
    const out = vectorLayer(`${item.title} (I3S)`, feats, { format: 'i3s', url: item.url, kind: 'arcgis', layerType: info.layerType }, { stroke: '#f59e0b', width: 1.5, fill: '#f59e0b22' });
    return { ...out, nodes: nodes.length, leaves: leaves.length, pages, read: pick.length, decoded: decodable, layerType: info.layerType };
  }

  // ---------------- processes (OGC API Processes, WPS 2.0) ----------------
  async function describeProcess(svc, item) {
    if (svc.kind === 'wps') return O.parseWpsDescribe(await textOf(svc, O.withParams(svc.url, { SERVICE: 'WPS', VERSION: '2.0.0', REQUEST: 'DescribeProcess', IDENTIFIER: item.id })));
    const u = `${item.processesUrl.replace(/[?#].*$/, '').replace(/\/$/, '')}/${encodeURIComponent(item.id)}`;
    return { ...(await json(svc, O.withParams(u, { f: 'json' }))), _url: u };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * Run a process with typed values: OGC API (sync when offered, else async with job polling) or
   * WPS 2.0 Execute (sync, else async with GetStatus / GetResult). Returns {outputs, raw, job}.
   */
  async function runProcess(svc, item, values, { desc = null, signal = null, onStatus = null, pollMs = 1000, maxPolls = 600 } = {}) {
    const d = desc ?? (await describeProcess(svc, item));
    if (svc.kind === 'wps') {
      const mode = d.sync ? 'sync' : 'async';
      let res = O.parseWpsResponse(await textOf(svc, svc.url, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: O.wpsExecuteXml(d, values, { mode }), signal }));
      for (let i = 0; res.status !== 'Succeeded' && i < maxPolls; i++) {
        if (/Failed/i.test(res.status)) throw gwError('{process} failed on the server', { process: item.title }, 'E_PROCESS_FAILED');
        onStatus?.(res);
        await sleep(pollMs);
        if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
        const st = O.parseWpsResponse(await textOf(svc, O.withParams(svc.url, { SERVICE: 'WPS', VERSION: '2.0.0', REQUEST: 'GetStatus', JOBID: res.jobId }), { signal }));
        res = st.status === 'Succeeded' ? O.parseWpsResponse(await textOf(svc, O.withParams(svc.url, { SERVICE: 'WPS', VERSION: '2.0.0', REQUEST: 'GetResult', JOBID: res.jobId }), { signal })) : { ...st, jobId: st.jobId || res.jobId };
      }
      if (res.status !== 'Succeeded') throw gwError('{process} did not finish in time', { process: item.title }, 'E_PROCESS_TIMEOUT');
      return { outputs: Object.fromEntries(res.outputs.map((o) => [o.id, o.json ?? o.text ?? o.href])), raw: res, job: res.jobId };
    }
    const sync = (d.jobControlOptions ?? ['sync-execute']).includes('sync-execute');
    const exec = O.resolveUrl(O.linkOf(d.links, 'execute') ?? `${d._url}/execution`, d._url);
    const body = JSON.stringify(O.processExecuteBody(d, values, { async: !sync }));
    const post = (type) => request(svc, exec, { method: 'POST', headers: { 'content-type': type, Accept: 'application/json', ...(sync ? {} : { Prefer: 'respond-async' }) }, body, signal });
    let r;
    try {
      r = await post('application/json');
    } catch (e) {
      // Some servers answer the CORS preflight without allowing Content-Type (the pygeoapi demo
      // does): the same JSON body then goes once more as a CORS "simple" request (text/plain).
      if (e?.code !== 'E_FETCH_FAILED' || !sync) throw e;
      r = await post('text/plain;charset=UTF-8');
    }
    if (r.status === 201 || r.status === 202 || (!sync && r.ok)) {
      let loc = r.headers.get('location');
      const first = await r.json().catch(() => ({}));
      loc ??= O.linkOf(first.links, ['monitor', 'status', 'self']);
      if (!loc && first.jobID) loc = `${svc.url.replace(/\/$/, '')}/jobs/${first.jobID}`;
      if (!loc) throw gwError('{process}: the server started a job but gave no address to follow it', { process: item.title }, 'E_PROCESS_JOB');
      loc = O.resolveUrl(loc, exec);
      for (let i = 0; i < maxPolls; i++) {
        const st = await json(svc, loc, { signal });
        onStatus?.(st);
        if (st.status === 'successful') {
          const rl = O.resolveUrl(O.linkOf(st.links, 'results') ?? `${loc.replace(/[?#].*$/, '')}/results`, loc);
          const out = await json(svc, rl, { signal });
          return { outputs: out, raw: out, job: st.jobID ?? null };
        }
        if (st.status === 'failed' || st.status === 'dismissed') throw gwError('{process} failed on the server: {msg}', { process: item.title, msg: st.message ?? st.status }, 'E_PROCESS_FAILED');
        await sleep(pollMs);
        if (signal?.aborted) throw gwError('the request was cancelled', null, 'E_CANCELLED');
      }
      throw gwError('{process} did not finish in time', { process: item.title }, 'E_PROCESS_TIMEOUT');
    }
    await check(r, svc);
    const out = await r.json();
    return { outputs: out.outputs ?? out, raw: out, job: null };
  }
  /** GeoJSON features among process outputs (a FeatureCollection, a Feature or a geometry). */
  function featuresIn(outputs) {
    const out = [];
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      if (v.type === 'FeatureCollection') out.push(...(v.features ?? []));
      else if (v.type === 'Feature') out.push(v);
      else if (/^(Multi)?(Point|LineString|Polygon)$/.test(v.type ?? '') && v.coordinates) out.push({ type: 'Feature', properties: {}, geometry: v });
      else for (const x of Object.values(v)) visit(typeof x === 'object' && x?.value !== undefined ? x.value : x);
    };
    visit(outputs);
    return out;
  }

  app.services = { connect, browse, list: () => [...services.values()], get: (id) => services.get(id), viewBox, addBackground, openImage, loadFeatures, searchRecords, loadScene, describeProcess, runProcess, featuresIn, accuracyText, setToken: (url, tok) => (tok ? tokens.set(url, tok) : tokens.delete(url)) };

  // ---------------- the dialog ----------------
  async function dialog(preset = null) {
    const body = h('div', { class: 'svc-dialog' });
    const url = h('input', { class: 'inp', type: 'url', spellcheck: 'false', placeholder: 'https://…/wms · …/MapServer · …/ogcapi · …/v1.1', 'aria-label': t('Service address'), 'data-id': 'svc:url', value: typeof preset === 'string' ? preset : '' }); // i18n-ignore: URL examples
    const kind = h('select', { class: 'inp', 'aria-label': t('Service type'), 'data-id': 'svc:kind' }, KINDS.map((k) => h('option', { value: k }, kindLabel(k))));
    const tok = h('input', { class: 'inp', type: 'password', autocomplete: 'off', placeholder: t('Typed here; kept in memory only'), 'aria-label': t('Token'), 'data-id': 'svc:token' });
    const go = h('button', { class: 'btn btn-primary', 'data-id': 'svc:connect' }, t('Connect'));
    const cancel = h('button', { class: 'btn', hidden: true, 'data-id': 'svc:cancel' }, t('Cancel request'));
    const status = h('div', { class: 'hint', role: 'status', 'aria-live': 'polite', 'data-id': 'svc:status' });
    const size = h('input', { class: 'inp', type: 'number', min: '64', max: '4096', step: '64', value: '1024', 'aria-label': t('Image size (pixels, longer side)') });
    const acc = h('input', { class: 'inp', type: 'number', min: '0', step: '0.1', placeholder: t('not stated'), 'aria-label': t('Stated accuracy, CE90 in metres') });
    const filter = h('input', { class: 'inp', spellcheck: 'false', placeholder: t('for example {cql}', { cql: "name LIKE 'A%' AND pop > 1000" }), 'aria-label': t('CQL2 filter'), 'data-id': 'svc:filter' });
    const max = h('input', { class: 'inp', type: 'number', min: '1', max: '50000', value: '5000', 'aria-label': t('Most features to read') });
    const time = h('select', { class: 'inp', 'aria-label': t('Time'), 'data-id': 'svc:time' }, h('option', { value: '' }, t('Default time')));
    const under = h('input', { type: 'checkbox', 'aria-label': t('Also draw it under georeferenced images') });
    const list = h('div', { class: 'svc-items', 'data-id': 'svc:items' });
    let ctl = null;
    let svc = null;
    const busy = (on, msg = '') => {
      cancel.hidden = !on;
      go.disabled = on;
      status.textContent = msg;
      if (!on) ctl = null;
    };
    cancel.addEventListener('click', () => ctl?.abort());
    const act = (label, fn, dataId) => {
      const b = h('button', { class: 'btn', 'data-id': dataId }, label);
      b.addEventListener('click', async () => {
        ctl = new AbortController();
        busy(true, t('Working…'));
        try {
          const msg = await fn(ctl.signal);
          busy(false, msg ?? t('Done.'));
        } catch (e) {
          busy(false, msgOf(e));
        }
      });
      return b;
    };
    const progress = ({ pages, items }) => (status.textContent = t('{pages, plural, one {# page} other {# pages}} read, {n, plural, one {# feature} other {# features}} so far…', { pages, n: items }));
    const render = () => {
      clear(list);
      if (!svc) return;
      const rows = svc.items.map((it) => {
        const acts = [];
        const sig = (s) => ({ signal: s });
        if (it.can.background) acts.push(act(t('Show on map'), async () => {
          const s = await addBackground(svc, it, { time: time.value || null, under: under.checked });
          return t('{layer} is the Map view background ({kind}).', { layer: it.title, kind: s.kind });
        }, `svc:bg:${it.id}`));
        if (it.can.image) acts.push(act(t('Open as image layer'), async (s) => {
          const r = await openImage(svc, it, { size: Number(size.value) || 1024, time: time.value || null, accuracy: Number(acc.value) || null, ...sig(s) });
          return accuracyText(r.statement, it.title);
        }, `svc:img:${it.id}`));
        if (it.can.features) acts.push(act(t('Load features'), async (s) => {
          const r = await loadFeatures(svc, it, { bbox: viewBox(), filter: filter.value.trim() || null, max: Number(max.value) || 5000, onPage: progress, ...sig(s) });
          return Number.isFinite(r.count) ? t('{layer}: {n, plural, one {# feature} other {# features}} in {pages, plural, one {# page} other {# pages}}.', { layer: it.title, n: r.count, pages: r.pages ?? 1 }) : t('Done.');
        }, `svc:feat:${it.id}`));
        if (it.can.records) acts.push(act(t('Search'), async (s) => {
          const recs = await searchRecords(svc, it, { bbox: viewBox(), q: filter.value.trim() || null, ...sig(s) });
          showRecords(it.title, recs);
          return t('{n, plural, one {# record} other {# records}} found.', { n: recs.length });
        }, `svc:rec:${it.id}`));
        if (it.can.scene) acts.push(act(t('Load buildings'), async (s) => {
          const r = await loadScene(svc, it, { onPage: progress, ...sig(s) });
          return r.decoded ? t('{layer}: {n, plural, one {# footprint} other {# footprints}} with heights from {k, plural, one {# node} other {# nodes}}.', { layer: it.title, n: r.count, k: r.read }) : t('{layer}: {layerType} content is not decoded; {n, plural, one {# node extent} other {# node extents}} loaded.', { layer: it.title, layerType: r.layerType, n: r.count });
        }, `svc:scene:${it.id}`));
        if (it.can.run) acts.push(act(t('Run…'), () => processDialog(svc, it), `svc:run:${it.id}`));
        if (it.time?.values?.length) {
          const tb = h('button', { class: 'btn' }, t('Times'));
          tb.addEventListener('click', () => {
            clear(time).append(h('option', { value: '' }, t('Default time')), ...it.time.values.map((v) => h('option', { value: v }, v)));
            status.textContent = t('{layer}: {n, plural, one {# time} other {# times}} offered.', { layer: it.title, n: it.time.values.length });
          });
          acts.push(tb);
        }
        return h('tr', {}, h('td', {}, it.title), h('td', { class: 'small muted' }, typeLabel(it.type)), h('td', {}, ...acts));
      });
      list.append(h('table', { class: 'grid-table', 'aria-label': t('Service contents') }, h('thead', {}, h('tr', {}, [t('Layer'), t('Type'), t('Use')].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)));
    };
    go.addEventListener('click', async () => {
      ctl = new AbortController();
      busy(true, t('Connecting…'));
      try {
        svc = await connect(url.value, { kind: kind.value, token: tok.value || null, signal: ctl.signal });
        busy(false, t('{name}: {n, plural, one {# item} other {# items}}.', { name: svc.title, n: svc.items.length }));
      } catch (e) {
        svc = null;
        busy(false, msgOf(e));
      }
      render();
    });
    url.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
    body.append(
      h('p', { class: 'hint' }, t('Requests go only to origins in this file’s network allow-list and are listed in View ▸ Network Log. Tokens stay in memory.')),
      h('div', { class: 'btn-row' }, url, kind),
      field(t('Token'), tok),
      h('div', { class: 'btn-row' }, go, cancel),
      status,
      list,
      field(t('Image size (pixels, longer side)'), size),
      field(t('Stated accuracy, CE90 in metres'), acc, t('Only when the provider states one; otherwise measurements say "error not available".')),
      field(t('CQL2 filter (OGC API Features) or search words (Records)'), filter),
      field(t('Most features to read'), max),
      field(t('Time'), time),
      h('label', {}, under, ' ', t('Also draw it under georeferenced images')),
    );
    await modal({ title: t('Online Services'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 900, id: 'online-services' });
    ctl?.abort();
  }
  function kindLabel(k) {
    return { auto: t('Detect automatically'), wms: 'WMS', wmts: 'WMTS', arcgis: 'ArcGIS REST', ogcapi: 'OGC API', wcs: 'WCS 2.0', wps: 'WPS 2.0', sta: 'SensorThings' }[k]; // i18n-ignore: standard names
  }
  function showRecords(title, recs) {
    const rows = recs.map((r) => {
      const tif = r.links.find((l) => /tiff|cog/i.test(l.type ?? '') || /\.tiff?($|\?)/i.test(l.href ?? ''));
      const b = tif ? h('button', { class: 'btn' }, tc('verb', 'Open')) : null;
      b?.addEventListener('click', () => app.openUrl?.(tif.href).catch((e) => app.toast(msgOf(e), { kind: 'warn' })));
      return h('tr', {}, h('td', {}, r.title), h('td', { class: 'small' }, String(r.description).slice(0, 200)), h('td', {}, b));
    });
    modal({ title: t('Records: {name}', { name: title }), body: h('table', { class: 'grid-table', 'aria-label': t('Records') }, h('thead', {}, h('tr', {}, [t('Title'), t('Description'), ''].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 760, id: 'svc-records' });
  }
  async function processDialog(svc, item) {
    const d = await describeProcess(svc, item);
    const ins = svc.kind === 'wps' ? d.inputs.map((i) => ({ id: i.id, title: i.title, type: i.kind === 'complex' ? 'object' : i.kind === 'bbox' ? 'bbox' : /double|float|integer|int/i.test(i.dataType ?? '') ? 'number' : 'string', enum: i.allowed.length ? i.allowed : null, default: i.default, required: i.minOccurs > 0 })) : O.processInputs(d);
    const inputs = {};
    const rows = ins.map((i) => {
      const el = i.enum ? h('select', { class: 'inp', 'aria-label': i.title }, i.enum.map((v) => h('option', { value: String(v) }, String(v)))) : h(i.type === 'object' || i.type === 'geometry' ? 'textarea' : 'input', { class: 'inp', 'aria-label': i.title, value: i.default ?? '', placeholder: i.type === 'bbox' ? 'west,south,east,north' : i.type === 'geometry' ? '{"type":"Point","coordinates":[0,0]}' : '' }); // i18n-ignore: format examples
      if (i.type === 'bbox' && !el.value) el.value = (viewBox() ?? []).map((v) => v.toFixed(5)).join(',');
      inputs[i.id] = el;
      return field(i.required ? t('{input} (required)', { input: i.title }) : i.title, el);
    });
    if ((await modal({ title: t('Run {process}', { process: item.title }), body: h('div', {}, h('p', { class: 'hint' }, d.description ?? d.abstract ?? ''), ...rows), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 600, id: 'svc-process' })) !== 'run') return t('Not run.');
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    const res = await runProcess(svc, item, values, { desc: d });
    const feats = featuresIn(res.outputs);
    if (feats.length) vectorLayer(t('{process} result', { process: item.title }), feats, { format: 'process', url: svc.url, kind: svc.kind, process: item.id });
    modal({ title: t('{process} result', { process: item.title }), body: h('pre', { class: 'mono small', style: 'max-height:50vh;overflow:auto;white-space:pre-wrap' }, JSON.stringify(res.outputs, null, 2).slice(0, 20000)), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 700, id: 'svc-process-result' });
    return feats.length ? t('{process}: done; {n, plural, one {# feature} other {# features}} loaded.', { process: item.title, n: feats.length }) : t('{process}: done.', { process: item.title });
  }

  app.services.dialog = (u) => dialog(typeof u === 'string' ? u : null);
}
