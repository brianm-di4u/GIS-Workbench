// Online map backgrounds for the Workspace Map view (REQ-UI-26, REQ-ARC-16): XYZ, WMS (GetMap in
// EPSG:3857), WMTS (REST or KVP, GoogleMapsCompatible) and ArcGIS REST tile services the user
// adds. Tokens (REQ-SEC-10) stay in memory unless the user asks to store them, and never go into
// project or exported files. Tiles come through the logged network path, so a source works only
// after its origin is in this file's allow-list (add origin → save copy → reload, REQ-ARC-16);
// until then the Map view says so and keeps the embedded Natural Earth basemap. Tiles are
// drawn in the Map view's plate carrée as strips (Mercator latitude is not linear).

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { newId } from '../core/util.js';

export const name = 'online';

const PRESETS = [{ name: 'OpenStreetMap (standard)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', maxZoom: 19 }];
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

/** The request URL of a tile for any source kind (REQ-ARC-16); `token` is appended when set. */
export function tileUrl(s, z, x, y, token = null) {
  let u;
  const kind = s.kind ?? 'xyz';
  if (kind === 'wms') {
    const b = tileBounds(z, x, y);
    const sep = s.url.includes('?') ? '&' : '?';
    u = `${s.url}${sep}SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${encodeURIComponent(s.layers ?? '')}&STYLES=&CRS=EPSG:3857&BBOX=${b.map((v) => v.toFixed(3)).join(',')}&WIDTH=256&HEIGHT=256&FORMAT=${encodeURIComponent(s.format ?? 'image/png')}&TRANSPARENT=true`;
  } else if (kind === 'wmts') {
    u = s.url.replace(/\{TileMatrix\}/gi, String(z)).replace(/\{TileRow\}/gi, String(y)).replace(/\{TileCol\}/gi, String(x)).replace('{z}', z).replace('{x}', x).replace('{y}', y);
  } else if (kind === 'arcgis') {
    u = `${s.url.replace(/\/+$/, '')}/tile/${z}/${y}/${x}`;
  } else u = s.url.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[(x + y) % 3]);
  if (token) u += `${u.includes('?') ? '&' : '?'}${encodeURIComponent(s.tokenParam || 'token')}=${encodeURIComponent(token)}`;
  return u;
}

/** Check a new source; returns an error message or null. */
export function checkSource(s) {
  if (!/^https:\/\//.test(s.url ?? '')) return 'The URL must start with https://';
  const kind = s.kind ?? 'xyz';
  if (kind === 'xyz' && !(/\{z\}/.test(s.url) && /\{x\}/.test(s.url) && /\{y\}/.test(s.url))) return 'An XYZ template must contain {z}, {x} and {y}';
  if (kind === 'wmts' && !(/\{TileMatrix\}|\{z\}/i.test(s.url) && /\{TileRow\}|\{y\}/i.test(s.url) && /\{TileCol\}|\{x\}/i.test(s.url))) return 'A WMTS template must contain {TileMatrix}, {TileRow} and {TileCol}';
  if (kind === 'wms' && !s.layers) return 'A WMS source needs its layer names';
  return null;
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
    const fetch = this.app.netlog.fetchFor(`Map background: ${s.name}`);
    fetch(this.url(s, z, x, y), { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bmp = await createImageBitmap(await res.blob());
        this.cache.set(key, { tex: this.app.renderer.bitmapTexture(bmp), used: performance.now(), bytes: bmp.width * bmp.height * 4 });
        bmp.close?.();
        this.notice = '';
        this._evict();
        this.app.renderer.invalidate();
      })
      .catch((e) => {
        this.failed.set(key, performance.now());
        if (/allow-list/.test(e.message)) {
          // Plain words and a one-click fix instead of a policy error (review item 4; REQ-NET-02 in 2.0).
          let origin = null;
          try {
            origin = new URL(this.url(s, z, x, y)).origin;
          } catch {
            /* keep null */
          }
          this.notice = `${s.name} is an online map. This copy of GIS Workbench makes no network requests until you allow a site; the offline world map is shown instead.`;
          this.app.emit('online-notice', { text: this.notice, origin });
          if (!this.offered && origin) {
            this.offered = true;
            this.app.toast(`${s.name} needs the network. Allow ${origin} to show it.`, { kind: 'info', action: { label: 'Enable…', run: () => this.app.allowListDialog?.([origin]) } });
          }
        } else {
          this.notice = `${s.name}: ${e.message}`;
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

  /** Draw the visible tiles under the map's matrix; returns whether a background was drawn. */
  draw(r, vp, map) {
    const s = this.source();
    if (!s) return false;
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
      const s = { id: newId('src'), name: src.name || 'Map source', kind: src.kind ?? 'xyz', url: src.url.trim(), layers: src.layers ?? null, attribution: src.attribution ?? '', tokenParam: src.tokenParam ?? null, maxZoom: src.maxZoom ?? 19 };
      this.sources.push(s);
      if (token) this.setToken(s.id, token, rememberToken);
      this.save();
      return s;
    },
    tileUrl: (s, z, x, y) => tileUrl(s, z, x, y, tokens.get(s.id) ?? null),
    save() {
      app.prefs.set('mapSources', this.sources.map(({ token, ...rest }) => rest));
      app.prefs.set('mapSourceActive', this.active);
      app.prefs.set('mapSourceVisible', this.visible);
      app.renderer.invalidate();
      app.emit('state');
    },
  };
  app.onlineTiles = new TileLayer(app);
  app.on('gl-restored', () => app.onlineTiles.reset());

  async function dialog() {
    const o = app.online;
    const body = h('div');
    const render = () => {
      clear(body);
      const tb = h('tbody');
      for (const s of o.sources) {
        const use = h('input', { type: 'radio', name: 'mapsrc', checked: o.active === s.id, 'aria-label': `Use ${s.name}` });
        use.addEventListener('change', () => {
          o.active = s.id;
          o.visible = true;
          o.save();
        });
        const del = h('button', { class: 'btn btn-small' }, 'Remove');
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
      const none = h('input', { type: 'radio', name: 'mapsrc', checked: !o.visible || !o.active, 'aria-label': 'Embedded basemap only' });
      none.addEventListener('change', () => {
        o.visible = false;
        o.save();
      });
      body.append(
        h('p', { class: 'hint' }, 'Online backgrounds show only in the Workspace Map view and never take part in measurement. Requests go only to origins in this file’s network allow-list and are listed in View ▸ Network Log.'),
        h('table', { class: 'grid-table', 'aria-label': 'Map backgrounds' }, h('thead', {}, h('tr', {}, ['Source', 'URL template', 'Attribution', 'Origin', ''].map((x) => h('th', {}, x)))), h('tbody', {}, h('tr', {}, h('td', { colspan: '5' }, h('label', {}, none, ' Embedded Natural Earth basemap only (offline)'))), ...tb.children)),
      );
      const nm = h('input', { class: 'inp', placeholder: 'Name' });
      const kind = h('select', { class: 'inp', 'aria-label': 'Service type' }, [['xyz', 'XYZ tiles (Web Mercator)'], ['wms', 'WMS (GetMap, EPSG:3857)'], ['wmts', 'WMTS (GoogleMapsCompatible)'], ['arcgis', 'ArcGIS REST MapServer tiles']].map(([v, t]) => h('option', { value: v }, t)));
      const layers = h('input', { class: 'inp', placeholder: 'WMS layers (comma separated)' });
      const tok = h('input', { class: 'inp', type: 'password', placeholder: 'Token (optional)', autocomplete: 'off', 'aria-label': 'Token' });
      const tokParam = h('input', { class: 'inp', placeholder: 'token', 'aria-label': 'Token parameter name' });
      const remember = h('input', { type: 'checkbox', 'aria-label': 'Store the token in this browser' });
      const url = h('input', { class: 'inp', placeholder: 'https://host/{z}/{x}/{y}.png', spellcheck: 'false' });
      const att = h('input', { class: 'inp', placeholder: 'Attribution' });
      const preset = h('select', { class: 'inp' }, h('option', { value: '' }, 'Preset…'), PRESETS.map((p, i) => h('option', { value: String(i) }, p.name)));
      preset.addEventListener('change', () => {
        const p = PRESETS[+preset.value];
        if (!p) return;
        nm.value = p.name;
        url.value = p.url;
        att.value = p.attribution;
      });
      const add = h('button', { class: 'btn' }, 'Add source');
      add.addEventListener('click', () => {
        try {
          o.addSource({ name: nm.value, kind: kind.value, url: url.value, layers: layers.value.trim() || null, attribution: att.value.trim(), tokenParam: tokParam.value.trim() || null, token: tok.value || null, rememberToken: remember.checked });
        } catch (e) {
          return app.toast(e.message, { kind: 'warn' });
        }
        render();
      });
      const allow = h('button', { class: 'btn' }, 'Network Allow-List…');
      allow.addEventListener('click', () => C.run('ai.allowlist'));
      body.appendChild(section('Add a source', preset, field('Name', nm), field('Type', kind), field('URL (template for XYZ/WMTS; service URL for WMS and ArcGIS)', url), field('WMS layers', layers), field('Attribution', att), field('Token', tok, 'Kept in memory for this session; never written to project or exported files.'), field('Token parameter', tokParam), h('label', {}, remember, ' Store the token in this browser'), h('div', { class: 'btn-row' }, add, allow)));
    };
    render();
    await modal({ title: 'Map Backgrounds', body, buttons: ['Close'], width: 820, id: 'map-backgrounds' });
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
}
