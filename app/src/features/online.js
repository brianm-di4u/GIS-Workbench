// Online map backgrounds for the Workspace Map view (REQ-UI-26, REQ-ARC-16): XYZ, WMS (GetMap in
// EPSG:3857, or EPSG:4326 / CRS:84 tiles, with a TIME value), WMTS (REST or KVP; any tile matrix
// set in EPSG:3857 or 4326), ArcGIS REST cached tiles, dynamic MapServer export, ImageServer
// exportImage and VectorTileServer, and OGC API Tiles and Maps (REQ-GAP-05, REQ-GAP-06) the user
// adds, most of them from the capabilities browser (features/services.js). Tokens (REQ-SEC-10) stay in memory unless the user asks to store them, and never go into
// project or exported files. Tiles come through the logged network path, so a source works only
// after its origin is in this file's allow-list (add origin → save copy → reload, REQ-ARC-16);
// until then the Map view says so and keeps the embedded Natural Earth basemap. Tiles are
// drawn in the Map view's plate carrée as strips (Mercator latitude is not linear). Vector tiles are
// fetched here and drawn in a decode worker ('mvtRender'). Identify (GetFeatureInfo or ArcGIS
// identify) asks the active source what is under a click in the Map view.

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { newId } from '../core/util.js';
import { t, N_, tr, msgOf, gwError } from '../i18n/index.js';
import { num } from '../i18n/format.js';
import { epsgOf, geographicGrid, levelFor, tileBox, tileRange, boxIn, mercLat, mercX, mercY, DEG_M, wmsGetMapUrl, wmsFeatureInfoUrl, pickInfoFormat, parseFeatureInfo, ogcMapUrl, withParams } from '../connectors/ogc.js';
import { arcgisExportUrl, arcgisImageUrl } from '../connectors/arcgis.js';

export const name = 'online';

const PRESETS = [{ name: N_('OpenStreetMap (standard)'), url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 }];
const MAX_LAT = 85.0511287798;
const lat2y = (lat, n) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * n;
const y2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

const R = 6378137;
/** Web Mercator bounds of tile (z, x, y): [minx, miny, maxx, maxy] metres. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const size = (2 * Math.PI * R) / n;
  const minx = -Math.PI * R + x * size;
  const maxy = Math.PI * R - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

const GEO = new Map(); // max zoom → WorldCRS84Quad grid
/** Kinds drawn from an image request per tile (a box in EPSG:3857, or in EPSG:4326 for a geographic `crs`). */
const BOX_KINDS = new Set(['wms', 'arcgis-export', 'arcgis-image', 'ogc-map']);
/** Kinds whose tiles are Mapbox Vector Tiles, drawn in a decode worker. */
export const isVectorSource = (s) => s.kind === 'arcgis-vt' || (s.kind === 'ogc-tiles' && !!s.vector);

/**
 * The tile grid of a source when it is not the plain Web Mercator z/x/y tree: a WMTS tile matrix
 * set or ArcGIS tiling scheme from its capabilities (`s.grid`), or WorldCRS84Quad for a box kind
 * requested in EPSG:4326 / CRS:84. null means z/x/y Web Mercator.
 */
export function gridOf(s) {
  if (s.grid?.levels?.length) return s.grid;
  if (BOX_KINDS.has(s.kind) && epsgOf(s.crs) === 4326) {
    const z = s.maxZoom ?? 18;
    if (!GEO.has(z)) GEO.set(z, geographicGrid(z));
    return GEO.get(z);
  }
  return null;
}

/** Whether a source can be drawn as a basemap under georeferenced images (Web Mercator z/x/y tiles). */
export const isMercatorSource = (s) => !gridOf(s) || (s.grid?.epsg === 3857 && s.grid.levels.every((l, i) => String(l.id) === String(i) || Number(l.id) === i) && Math.abs(s.grid.levels[0].x0 + 20037508.342789244) < 1);

/** Tile box in the source's request CRS (x = east): Web Mercator metres, or degrees for a geographic grid. */
function requestBox(s, z, x, y) {
  const g = gridOf(s);
  return g ? tileBox(g.levels[z], x, y) : tileBounds(z, x, y);
}

/**
 * The request URL of a tile for any source kind (REQ-ARC-16); `token` is appended when set. With a
 * grid (gridOf), z is the index of the grid level and x, y its column and row.
 */
export function tileUrl(s, z, x, y, token = null) {
  let u;
  const kind = s.kind ?? 'xyz';
  const g = gridOf(s);
  const level = g ? g.levels[z] : null;
  const lid = level ? level.id : String(z);
  const geo = g?.epsg === 4326;
  if (kind === 'wms' && !g && !s.version && !s.styles && !s.crs) {
    // The 2.0 form of a Web Mercator WMS tile (kept byte for byte), with a TIME value when one is set.
    const b = tileBounds(z, x, y);
    const sep = s.url.includes('?') ? '&' : '?';
    u = `${s.url}${sep}SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(s.layers ?? '')}&STYLES=&CRS=EPSG:3857&BBOX=${b.map((v) => v.toFixed(3)).join(',')}&WIDTH=256&HEIGHT=256&FORMAT=${encodeURIComponent(s.format ?? 'image/png')}&TRANSPARENT=true`;
    if (s.time) u += `&TIME=${encodeURIComponent(s.time)}`;
  } else if (kind === 'wms') {
    u = wmsGetMapUrl(s, { bbox: requestBox(s, z, x, y), crs: geo ? s.crs : s.crs ?? 'EPSG:3857', width: 256, height: 256 });
  } else if (kind === 'arcgis-export') {
    u = arcgisExportUrl(s.url, { bbox: requestBox(s, z, x, y), sr: geo ? 4326 : 3857, layers: s.layers ?? null, time: s.time ?? null });
  } else if (kind === 'arcgis-image') {
    u = arcgisImageUrl(s.url, { bbox: requestBox(s, z, x, y), sr: geo ? 4326 : 3857, time: s.time ?? null, renderingRule: s.renderingRule ?? null });
  } else if (kind === 'ogc-map') {
    u = ogcMapUrl(s.url, { bbox: requestBox(s, z, x, y), crs: geo ? s.crs : 'EPSG:3857', width: 256, height: 256, datetime: s.time ?? null });
  } else if (kind === 'wmts' || kind === 'ogc-tiles') {
    u = s.url.replace(/\{TileMatrix\}/gi, lid).replace(/\{TileRow\}/gi, String(y)).replace(/\{TileCol\}/gi, String(x)).replace('{z}', lid).replace('{x}', x).replace('{y}', y);
    if (s.time) u = u.replace(/\{Time\}/gi, encodeURIComponent(s.time));
  } else if (kind === 'arcgis') {
    u = `${s.url.replace(/\/+$/, '')}/tile/${lid}/${y}/${x}`;
  } else if (kind === 'arcgis-vt') {
    u = s.url.replace('{z}', lid).replace('{x}', x).replace('{y}', y);
  } else u = s.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
  if (token) u += `${u.includes('?') ? '&' : '?'}${encodeURIComponent(s.tokenParam || 'token')}=${encodeURIComponent(token)}`;
  return u;
}

/** Check a new source; returns an error message or null. */
export function checkSource(s) {
  if (!/^https:\/\//.test(s.url ?? '') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(s.url ?? '')) return t('The URL must start with {prefix}', { prefix: 'https://' });
  const kind = s.kind ?? 'xyz';
  if (kind === 'xyz' && !(/\{z\}/.test(s.url) && /\{x\}/.test(s.url) && /\{y\}/.test(s.url))) return t('An XYZ template must contain {z}, {x} and {y}', { z: '{z}', x: '{x}', y: '{y}' });
  if ((kind === 'wmts' || kind === 'ogc-tiles') && !(/\{TileMatrix\}|\{z\}/i.test(s.url) && /\{TileRow\}|\{y\}/i.test(s.url) && /\{TileCol\}|\{x\}/i.test(s.url))) return t('A WMTS template must contain {matrix}, {row} and {col}', { matrix: '{TileMatrix}', row: '{TileRow}', col: '{TileCol}' });
  if (kind === 'wms' && !s.layers) return t('A WMS source needs its layer names');
  if (s.crs && BOX_KINDS.has(kind) && ![3857, 4326].includes(epsgOf(s.crs))) return t('{crs} cannot be drawn in the Map view, which shows EPSG:3857 and EPSG:4326 tiles. Open the layer as an image layer instead: any CRS GIS Workbench knows works there.', { crs: String(s.crs) });
  if (s.grid && ![3857, 4326].includes(s.grid.epsg)) return t('{crs} cannot be drawn in the Map view, which shows EPSG:3857 and EPSG:4326 tiles. Open the layer as an image layer instead: any CRS GIS Workbench knows works there.', { crs: `EPSG:${s.grid.epsg}` });
  return null;
}

/** Fields of a source kept in preferences besides the basics (never the token). */
const SOURCE_EXTRA = ['version', 'styles', 'format', 'crs', 'time', 'times', 'grid', 'vector', 'renderingRule', 'infoUrl', 'infoFormat', 'queryLayers', 'queryable', 'service', 'accuracy'];

/**
 * A fetched tile response → ImageBitmap. Raster tiles decode here; vector tiles (MVT) are drawn in
 * a decode worker with the default vector style (tiles/style.js), so the main thread stays free.
 */
export async function tileBitmap(app, s, res, z) {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!isVectorSource(s)) return createImageBitmap(await res.blob());
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error('empty tile');
  const zoom = Number.isFinite(Number(gridOf(s)?.levels?.[z]?.id)) ? Number(gridOf(s).levels[z].id) : z;
  const r = await app.pool.run('mvtRender', { bytes, z: zoom, size: 512 }, { priority: 'interactive', transfer: [bytes.buffer], label: t('vector tile {z}/{x}', { z: String(zoom), x: s.name }) });
  if (!r?.bmp) throw new Error('empty tile');
  return r.bmp;
}

class TileLayer {
  constructor(app) {
    this.app = app;
    this.cache = new Map(); // key → {tex, used}
    this.pending = new Set();
    this.failed = new Map();
    this.notice = '';
  }

  source() {
    const o = this.app.online;
    return o.visible ? o.sources.find((s) => s.id === o.active) ?? null : null;
  }

  url(s, z, x, y) {
    return tileUrl(s, z, x, y, this.app.online.tokenFor(s));
  }

  fetchTile(s, z, x, y, key) {
    if (this.pending.has(key) || this.pending.size > 12) return;
    const f = this.failed.get(key);
    if (f && performance.now() - f < 30000) return;
    this.pending.add(key);
    const fetch = this.app.netlog.fetchFor(t('Map background: {name}', { name: s.name }));
    fetch(this.url(s, z, x, y), { credentials: 'omit' })
      .then(async (res) => {
        const bmp = await tileBitmap(this.app, s, res, z);
        this.cache.set(key, { tex: this.app.renderer.bitmapTexture(bmp), used: performance.now(), bytes: bmp.width * bmp.height * 4 });
        bmp.close?.();
        this.notice = '';
        this._evict();
        this.app.renderer.invalidate();
      })
      .catch((e) => {
        this.failed.set(key, performance.now());
        // The logged fetch marks an origin outside the allow-list (ai/netlog.js: notAllowed; the code
        // E_NET_NOT_ALLOWED when the source sets one), never matched on the message text (L0).
        if (e?.code === 'E_NET_NOT_ALLOWED' || e?.notAllowed) {
          // Plain words and a one-click fix instead of a policy error (review item 4; REQ-NET-02 in 2.0).
          let origin = null;
          try {
            origin = new URL(this.url(s, z, x, y)).origin;
          } catch {
            /* keep null */
          }
          this.notice = t('{name} is an online map. This copy of GIS Workbench makes no network requests until you allow a site; the offline world map is shown instead.', { name: s.name });
          this.app.emit('online-notice', { text: this.notice, origin });
          if (!this.offered && origin) {
            this.offered = true;
            this.app.toast(t('{name} needs the network. Allow {origin} to show it.', { name: s.name, origin }), { kind: 'info', action: { label: t('Enable…'), run: () => this.app.allowListDialog?.([origin]) } });
          }
        } else {
          this.notice = t('{name}: {msg}', { name: s.name, msg: msgOf(e) });
          this.app.emit('online-notice', this.notice);
        }
      })
      .finally(() => this.pending.delete(key));
  }

  _evict() {
    if (this.cache.size <= 300) return;
    const all = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [k, t] of all.slice(0, this.cache.size - 240)) {
      this.app.renderer.freeTexture(t.tex, t.bytes);
      this.cache.delete(k);
    }
  }

  /**
   * Draw a source with its own tile grid (WMTS matrix set, ArcGIS tiling scheme, WorldCRS84Quad):
   * the level nearest the view's scale, each tile a quad (EPSG:4326) or Mercator strips (EPSG:3857).
   */
  drawGrid(r, vp, map, s, g) {
    const zoomPx = map.view.zoom * vp.dpr; // device px per degree
    const want = g.epsg === 4326 ? 1 / zoomPx : DEG_M / zoomPx;
    const level = levelFor(g, want);
    const z = g.levels.indexOf(level);
    const halfW = vp.w / 2 / zoomPx;
    const halfH = vp.h / 2 / zoomPx;
    const box = [Math.max(-180, map.view.lon - halfW), Math.max(g.epsg === 3857 ? -MAX_LAT : -90, map.view.lat - halfH), Math.min(180, map.view.lon + halfW), Math.min(g.epsg === 3857 ? MAX_LAT : 90, map.view.lat + halfH)];
    if (box[2] <= box[0] || box[3] <= box[1]) return true;
    const { c0, c1, r0, r1 } = tileRange(level, boxIn(g.epsg, box));
    if (c1 < c0 || r1 < r0 || (c1 - c0 + 1) * (r1 - r0 + 1) > 400) return true;
    const m = map.matrix(vp.w, vp.h, vp.dpr);
    const now = performance.now();
    for (let row = r0; row <= r1; row++)
      for (let col = c0; col <= c1; col++) {
        const key = `${s.id}/g${z}/${col}/${row}`;
        const tt = this.cache.get(key);
        if (!tt) {
          this.fetchTile(s, z, col, row, key);
          continue;
        }
        tt.used = now;
        const [x0, y0, x1, y1] = tileBox(level, col, row);
        const lonA = g.epsg === 3857 ? (x0 / 20037508.342789244) * 180 : x0;
        const lonB = g.epsg === 3857 ? (x1 / 20037508.342789244) * 180 : x1;
        const strips = g.epsg === 3857 ? 8 : 1;
        const v = new Float32Array(strips * 6 * 4);
        let o = 0;
        for (let k = 0; k < strips; k++) {
          const ya = y1 - ((y1 - y0) * k) / strips;
          const yb = y1 - ((y1 - y0) * (k + 1)) / strips;
          const latA = g.epsg === 3857 ? mercLat(ya) : ya;
          const latB = g.epsg === 3857 ? mercLat(yb) : yb;
          const va = k / strips;
          const vb = (k + 1) / strips;
          for (const [x, y, u, w] of [[lonA, latA, 0, va], [lonB, latA, 1, va], [lonA, latB, 0, vb], [lonB, latA, 1, va], [lonB, latB, 1, vb], [lonA, latB, 0, vb]]) {
            v[o++] = x;
            v[o++] = y;
            v[o++] = u;
            v[o++] = w;
          }
        }
        r.drawTextured(tt.tex, v, m, vp.w, vp.h, 1);
      }
    if (this.pending.size) r.invalidate();
    return true;
  }

  /** Draw the visible tiles under the map's matrix; returns whether a background was drawn. */
  draw(r, vp, map) {
    const s = this.source();
    if (!s) return false;
    const g = gridOf(s);
    if (g) return this.drawGrid(r, vp, map, s, g);
    const zoomPx = map.view.zoom * vp.dpr; // device px per degree
    const z = Math.max(0, Math.min(s.maxZoom ?? 19, Math.round(Math.log2((zoomPx * 360) / 256))));
    const n = 2 ** z;
    const halfW = vp.w / 2 / zoomPx;
    const halfH = vp.h / 2 / zoomPx;
    const lon0 = map.view.lon - halfW;
    const lon1 = map.view.lon + halfW;
    const la0 = Math.max(-MAX_LAT, map.view.lat - halfH);
    const la1 = Math.min(MAX_LAT, map.view.lat + halfH);
    if (la1 <= la0) return true;
    const x0 = Math.floor(((lon0 + 180) / 360) * n);
    const x1 = Math.floor(((lon1 + 180) / 360) * n);
    const y0 = Math.max(0, Math.floor(lat2y(la1, n)));
    const y1 = Math.min(n - 1, Math.floor(lat2y(la0, n)));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return true;
    const m = map.matrix(vp.w, vp.h, vp.dpr);
    const now = performance.now();
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const key = `${s.id}/${z}/${wx}/${ty}`;
        const t = this.cache.get(key);
        if (!t) {
          this.fetchTile(s, z, wx, ty, key);
          continue;
        }
        t.used = now;
        const lonA = (tx / n) * 360 - 180;
        const lonB = ((tx + 1) / n) * 360 - 180;
        const strips = 8;
        const v = new Float32Array(strips * 6 * 4);
        let o = 0;
        for (let k = 0; k < strips; k++) {
          const ya = ty + k / strips;
          const yb = ty + (k + 1) / strips;
          const latA = y2lat(ya, n);
          const latB = y2lat(yb, n);
          const va = k / strips;
          const vb = (k + 1) / strips;
          for (const [x, y, u, w] of [[lonA, latA, 0, va], [lonB, latA, 1, va], [lonA, latB, 0, vb], [lonB, latA, 1, va], [lonB, latB, 1, vb], [lonA, latB, 0, vb]]) {
            v[o++] = x;
            v[o++] = y;
            v[o++] = u;
            v[o++] = w;
          }
        }
        r.drawTextured(t.tex, v, m, vp.w, vp.h, 1);
      }
    if (this.pending.size) r.invalidate();
    return true;
  }

  reset() {
    for (const t of this.cache.values()) this.app.renderer.freeTexture(t.tex, t.bytes);
    this.cache.clear();
    this.failed.clear();
  }
}

export function install(app) {
  const C = app.commands;
  // Tokens: memory only, unless the user chose to store one (then in this browser's preferences).
  const tokens = new Map(Object.entries(app.prefs.get('mapTokens') ?? {}));
  app.online = {
    sources: (app.prefs.get('mapSources') ?? []).map(({ token, ...rest }) => rest),
    active: app.prefs.get('mapSourceActive') ?? null,
    visible: app.prefs.get('mapSourceVisible') ?? false,
    tokenFor: (s) => tokens.get(s.id) ?? null,
    setToken(id, token, remember = false) {
      if (token) tokens.set(id, token);
      else tokens.delete(id);
      const stored = { ...(app.prefs.get('mapTokens') ?? {}) };
      if (remember && token) stored[id] = token;
      else delete stored[id];
      app.prefs.set('mapTokens', stored);
    },
    /** Add a source ({name, kind, url, layers?, attribution?, tokenParam?, token?, rememberToken?}). */
    addSource({ token = null, rememberToken = false, ...src }) {
      const err = checkSource(src);
      if (err) throw new Error(err);
      const s = { id: newId('src'), name: src.name || t('Map source'), kind: src.kind ?? 'xyz', url: src.url.trim(), layers: src.layers ?? null, attribution: src.attribution ?? '', tokenParam: src.tokenParam ?? null, maxZoom: src.maxZoom ?? 19 };
      for (const k of SOURCE_EXTRA) if (src[k] !== undefined && src[k] !== null) s[k] = src[k];
      this.sources.push(s);
      if (token) this.setToken(s.id, token, rememberToken);
      this.save();
      return s;
    },
    tileUrl: (s, z, x, y) => tileUrl(s, z, x, y, tokens.get(s.id) ?? null),
    /** Fetch one tile of a source through the logged fetch → ImageBitmap (basemaps under images use it too). */
    async fetchTile(s, z, x, y, purpose = null) {
      const res = await app.netlog.fetchFor(purpose ?? t('Map background: {name}', { name: s.name }))(tileUrl(s, z, x, y, tokens.get(s.id) ?? null), { credentials: 'omit' });
      return tileBitmap(app, s, res, z);
    },
    /** Change a source's TIME value (WMS TIME, WMTS {Time}, ArcGIS time, OGC datetime) and redraw. */
    setTime(id, time) {
      const s = this.sources.find((x) => x.id === id);
      if (!s) return;
      s.time = time || null;
      app.onlineTiles.reset();
      this.save();
    },
    identify: (lat, lon, opts) => identify(lat, lon, opts),
    save() {
      app.prefs.set('mapSources', this.sources.map(({ token, ...rest }) => rest));
      app.prefs.set('mapSourceActive', this.active);
      app.prefs.set('mapSourceVisible', this.visible);
      app.renderer.invalidate();
      app.emit('state');
    },
  };
  app.onlineTiles = new TileLayer(app);
  app.onlineIsMercator = isMercatorSource;
  app.on('gl-restored', () => app.onlineTiles.reset());

  async function dialog() {
    const o = app.online;
    const body = h('div');
    const render = () => {
      clear(body);
      const tb = h('tbody');
      for (const s of o.sources) {
        const use = h('input', { type: 'radio', name: 'mapsrc', checked: o.active === s.id, 'aria-label': t('Use {name}', { name: s.name }) });
        use.addEventListener('change', () => {
          o.active = s.id;
          o.visible = true;
          o.save();
        });
        const del = h('button', { class: 'btn btn-small' }, t('Remove'));
        del.addEventListener('click', () => {
          o.sources = o.sources.filter((x) => x !== s);
          if (o.active === s.id) o.active = null;
          o.save();
          render();
        });
        let origin = '';
        try {
          origin = new URL(s.url.replace(/\{[a-z]\}/g, '0')).origin;
        } catch {}
        tb.appendChild(h('tr', {}, h('td', {}, use, ' ', s.name), h('td', { class: 'mono small' }, s.url), h('td', {}, s.attribution ?? ''), h('td', {}, origin), h('td', {}, del)));
      }
      const none = h('input', { type: 'radio', name: 'mapsrc', checked: !o.visible || !o.active, 'aria-label': t('Embedded basemap only') });
      none.addEventListener('change', () => {
        o.visible = false;
        o.save();
      });
      body.append(
        h('p', { class: 'hint' }, t('Online backgrounds show only in the Workspace Map view and never take part in measurement. Requests go only to origins in this file’s network allow-list and are listed in View ▸ Network Log.')),
        h('table', { class: 'grid-table', 'aria-label': t('Map backgrounds') }, h('thead', {}, h('tr', {}, [t('Source'), t('URL template'), t('Attribution'), t('Origin'), ''].map((x) => h('th', {}, x)))), h('tbody', {}, h('tr', {}, h('td', { colspan: '5' }, h('label', {}, none, ' ', t('Embedded Natural Earth basemap only (offline)')))), ...tb.children)),
      );
      const nm = h('input', { class: 'inp', placeholder: t('Name') });
      const kind = h('select', { class: 'inp', 'aria-label': t('Service type') }, [['xyz', t('XYZ tiles (Web Mercator)')], ['wms', t('WMS (GetMap, EPSG:3857)')], ['wmts', t('WMTS (GoogleMapsCompatible)')], ['arcgis', t('ArcGIS REST MapServer tiles')]].map(([v, label]) => h('option', { value: v }, label)));
      const layers = h('input', { class: 'inp', placeholder: t('WMS layers (comma separated)') });
      const tok = h('input', { class: 'inp', type: 'password', placeholder: t('Token (optional)'), autocomplete: 'off', 'aria-label': t('Token') });
      const tokParam = h('input', { class: 'inp', placeholder: 'token', 'aria-label': t('Token parameter name') }); // i18n-ignore: the URL parameter name
      const remember = h('input', { type: 'checkbox', 'aria-label': t('Store the token in this browser') });
      const url = h('input', { class: 'inp', placeholder: 'https://host/{z}/{x}/{y}.png', spellcheck: 'false' }); // i18n-ignore: URL template
      const att = h('input', { class: 'inp', placeholder: t('Attribution') });
      const preset = h('select', { class: 'inp', 'aria-label': t('Preset') }, h('option', { value: '' }, t('Preset…')), PRESETS.map((p, i) => h('option', { value: String(i) }, tr(p.name))));
      preset.addEventListener('change', () => {
        const p = PRESETS[+preset.value];
        if (!p) return;
        nm.value = tr(p.name);
        url.value = p.url;
        att.value = p.attribution;
      });
      const add = h('button', { class: 'btn' }, t('Add source'));
      add.addEventListener('click', () => {
        try {
          o.addSource({ name: nm.value, kind: kind.value, url: url.value, layers: layers.value.trim() || null, attribution: att.value.trim(), tokenParam: tokParam.value.trim() || null, token: tok.value || null, rememberToken: remember.checked });
        } catch (e) {
          return app.toast(msgOf(e), { kind: 'warn' });
        }
        render();
      });
      const allow = h('button', { class: 'btn' }, t('Network Allow-List…'));
      allow.addEventListener('click', () => C.run('ai.allowlist'));
      const signin = h('button', { class: 'btn' }, t('Sign-In for Data Origins…')); // REQ-GAP-09/10
      signin.addEventListener('click', () => C.run('net.signin'));
      body.appendChild(section(t('Add a source'), preset, field(t('Name'), nm), field(t('Type'), kind), field(t('URL (template for XYZ/WMTS; service URL for WMS and ArcGIS)'), url), field(t('WMS layers'), layers), field(t('Attribution'), att), field(t('Token'), tok, t('Kept in memory for this session; never written to project or exported files.')), field(t('Token parameter'), tokParam), h('label', {}, remember, ' ', t('Store the token in this browser')), h('div', { class: 'btn-row' }, add, allow, signin)));
    };
    render();
    await modal({ title: t('Map Backgrounds'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 820, id: 'map-backgrounds' });
  }
  C.implement('online.backgrounds', { run: dialog });
  C.implement('online.add', { run: dialog });
  C.implement('bg.online', { run: dialog });
  C.implement('bg.map', {
    enabled: () => app.online.sources.length > 0,
    checked: () => app.online.visible && !!app.online.active,
    run: () => {
      const o = app.online;
      if (!o.active) o.active = o.sources[0]?.id ?? null;
      o.visible = !o.visible;
      o.save();
    },
  });

  // ---------------- Identify (REQ-GAP-05: WMS GetFeatureInfo, ArcGIS identify) ----------------
  const canIdentify = (s) => !!s && ((s.kind === 'wms' && s.queryable !== false) || s.kind === 'arcgis-export' || s.kind === 'arcgis-image' || (s.kind === 'arcgis' && /MapServer/i.test(s.url)));
  /**
   * What the active source has at a point: rows [{layer, props}]. The request is the one a 256 ×
   * 256 view of the Map view's current scale centred on the point would make (GetFeatureInfo at
   * pixel 128, 128; ArcGIS identify with a 4-pixel tolerance).
   */
  async function identify(lat, lon, { source = null, zoom = null } = {}) {
    const s = source ?? app.onlineTiles.source() ?? app.online.sources.find((x) => x.id === app.online.active);
    if (!canIdentify(s)) throw gwError('{name} cannot be identified: choose a queryable WMS layer or an ArcGIS map or image service', { name: s?.name ?? t('Map source') }, 'E_IDENTIFY_UNSUPPORTED');
    const z = zoom ?? app.desktop?.workspace?.map?.view?.zoom ?? 100; // CSS px per degree
    const fetch = app.netlog.fetchFor(t('Identify: {name}', { name: s.name }));
    const token = tokens.get(s.id) ?? null;
    const tok = (u) => (token ? withParams(u, { [s.tokenParam || 'token']: token }) : u);
    const geo = epsgOf(s.crs) === 4326 || s.grid?.epsg === 4326;
    if (s.kind === 'wms') {
      const res = geo ? 1 / z : DEG_M / z;
      const [cx, cy] = geo ? [lon, lat] : [mercX(lon), mercY(lat)];
      const bbox = [cx - 128 * res, cy - 128 * res, cx + 128 * res, cy + 128 * res];
      const fmt = s.infoFormat ?? 'text/plain';
      const r = await fetch(tok(wmsFeatureInfoUrl({ ...s, url: s.url }, { bbox, crs: geo ? s.crs : 'EPSG:3857', i: 128, j: 128, infoFormat: fmt })), { credentials: 'omit' });
      if (!r.ok) throw gwError('{name}: HTTP {status}', { name: s.name, status: r.status }, 'E_HTTP');
      return parseFeatureInfo(await r.text(), r.headers.get('content-type') ?? fmt);
    }
    const root = s.url.replace(/\/+$/, '').replace(/\/(export|exportImage|tile.*)$/, '');
    const d = 128 / z;
    const ext = [lon - d, lat - d, lon + d, lat + d];
    const u = s.kind === 'arcgis-image' ? withParams(`${root}/identify`, { geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }), geometryType: 'esriGeometryPoint', returnGeometry: 'false', returnCatalogItems: 'false', f: 'json' }) : withParams(`${root}/identify`, { geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', sr: 4326, layers: s.layers ? `visible:${s.layers}` : 'visible', tolerance: 4, mapExtent: ext.join(','), imageDisplay: '256,256,96', returnGeometry: 'false', f: 'json' });
    const r = await fetch(tok(u), { credentials: 'omit' });
    if (!r.ok) throw gwError('{name}: HTTP {status}', { name: s.name, status: r.status }, 'E_HTTP');
    const j = await r.json();
    if (j.error) throw gwError('{name}: {msg}', { name: s.name, msg: j.error.message ?? String(j.error.code) }, 'E_SERVICE');
    if (s.kind === 'arcgis-image') return [{ layer: j.name ?? s.name, props: { value: j.value, ...(j.properties?.Values ? { values: j.properties.Values.join(', ') } : {}) } }];
    return (j.results ?? []).map((x) => ({ layer: x.layerName ?? String(x.layerId ?? ''), props: x.attributes ?? {} }));
  }
  function showIdentify(rows, lat, lon) {
    const body = rows.length
      ? h('table', { class: 'grid-table', 'aria-label': t('Identify results') }, h('thead', {}, h('tr', {}, [t('Layer'), t('Field'), t('Value')].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows.flatMap((row) => Object.entries(row.props).map(([k, v]) => h('tr', {}, h('td', {}, row.layer), h('td', {}, k), h('td', {}, String(v ?? '')))))))
      : h('p', {}, t('Nothing was found at this point.'));
    return modal({ title: t('Identify at {lat}, {lon}', { lat: num(lat, 5), lon: num(lon, 5) }), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 640, id: 'online-identify' });
  }
  let identifyOn = false;
  let bound = null;
  C.implement('online.identify', {
    enabled: () => canIdentify(app.online.sources.find((x) => x.id === app.online.active)),
    checked: () => identifyOn,
    run: () => {
      const map = app.desktop?.workspace?.map;
      identifyOn = !identifyOn;
      if (identifyOn && map && !bound) {
        let down = null;
        bound = map;
        map.el.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
        map.el.addEventListener('pointerup', (e) => {
          if (!identifyOn || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
          const rc = map.el.getBoundingClientRect();
          const p = map.toLonLat(e.clientX - rc.left, e.clientY - rc.top);
          const lon = ((p.lon + 540) % 360) - 180;
          identify(p.lat, lon)
            .then((rows) => showIdentify(rows, p.lat, lon))
            .catch((err) => app.toast(msgOf(err), { kind: 'warn', ms: 8000 }));
        });
      }
      if (identifyOn) app.toast(t('Identify: click the Map view to ask the active online source what is there.'), { kind: 'info' });
      app.emit('state');
    },
  });
}
