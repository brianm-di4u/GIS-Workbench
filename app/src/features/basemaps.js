// Network posture and basemaps (2.0 plan P3; REQ-NET-02, REQ-NET-04). One Online/Offline switch
// gates every request (whatever the CSP allows); the first start asks, a site can lock Offline,
// and the air-gapped file has no network at all. Built-in basemaps from the curated origins
// (build/origins.json) draw UNDER georeferenced images in the image panels — each Web Mercator
// tile is warped onto the view through the image's own ground-to-image model — with the
// attribution always shown. Basemaps whose terms restrict use (the OSM tile servers) are opt-in.

import { h, clear } from '../shell/dom.js';
import { openMenu } from '../shell/menu.js';
import { confirmBox } from '../shell/dialogs.js';
import { forwardView } from '../render/renderer.js';
import { PMTiles, FileSource, TileType, SharedPromiseCache } from 'pmtiles';
import { pickFiles } from '../storage/files.js';
import { makeDecompress } from '../tiles/decompress.js';
import { t, N_, tr, msgOf, gwError } from '../i18n/index.js';

export const name = 'basemaps';

// name, short and policy are marked for translation and shown through tr(); `short` stays the
// English key in data (globe.js, tests). Attributions are the providers' credits: never translated.
export const BASEMAPS = [
  { id: 'satellite', name: N_('Satellite (Sentinel-2 cloudless 2016)'), short: N_('Satellite'), url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg', maxZoom: 15, attribution: 'Sentinel-2 cloudless – s2maps.eu by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016)', swatch: '#4a6b3a' },
  { id: 'topo', name: N_('Topographic (USGS, United States)'), short: N_('Topo'), url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', maxZoom: 16, attribution: 'USGS The National Map', swatch: '#d9d0b4' },
  { id: 'usimagery', name: N_('Imagery (USGS, United States)'), short: N_('US imagery'), url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', maxZoom: 16, attribution: 'USGS The National Map', swatch: '#5d6b4c' },
  { id: 'relief', name: N_('Relief and bathymetry (NASA Blue Marble)'), short: N_('Relief'), url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg', maxZoom: 8, attribution: 'NASA EOSDIS GIBS – Blue Marble', swatch: '#2f5f8a' },
  { id: 'night', name: N_('Night lights (NASA Black Marble)'), short: N_('Night'), url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png', maxZoom: 8, attribution: 'NASA EOSDIS GIBS – VIIRS Black Marble 2016', swatch: '#111827' },
  { id: 'streets', name: N_('Streets (OpenStreetMap)'), short: N_('Streets'), url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19, attribution: '© OpenStreetMap contributors', swatch: '#efe9dd', optIn: true, policy: N_('OpenStreetMap\'s tile servers are run by volunteers. Their usage policy allows light, interactive use only: no bulk or offline downloads, and every request is shown in the Network Log. Use them?') },
];
/** A basemap's names for display: the built-in ones translated, local ones (file and metadata names) as they are. */
const builtIn = (b) => BASEMAPS.includes(b);
export const basemapName = (b) => (builtIn(b) ? tr(b.name) : b.name);
export const basemapShort = (b) => (builtIn(b) ? tr(b.short) : b.short);

const R = 6378137;
const MAX_LAT = 85.0511287798;
const lat2y = (lat, n) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * n;
const y2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const x2lon = (x, n) => (x / n) * 360 - 180;

export function install(app) {
  const C = app.commands;
  const manifest = app.gw?.manifest ?? {};
  const airgap = manifest.build?.profile === 'airgap' || !(manifest.csp?.curated ?? []).length;

  // ---------------- Online / Offline (REQ-NET-02) ----------------
  const net = {
    get airgap() {
      return airgap;
    },
    /** 'online' | 'offline'; unset (no choice yet) counts as offline. */
    get mode() {
      if (airgap) return 'offline';
      return app.prefs.get('network') === 'online' ? 'online' : 'offline';
    },
    get chosen() {
      return airgap || app.prefs.get('network') !== undefined;
    },
    isOnline() {
      return this.mode === 'online';
    },
    set(mode) {
      if (airgap) throw gwError('this is the air-gapped file: it has no network access', null, 'E_NET_AIRGAP');
      if (app.prefs.isLocked('network')) throw gwError('your site has locked this setting', null, 'E_NET_LOCKED');
      app.prefs.set('network', mode === 'online' ? 'online' : 'offline');
      app.emit('network', this.mode);
      app.emit('state');
      app.renderer.invalidate();
    },
  };
  app.network = net;
  if (app.netlog) app.netlog.gate = () => net.isOnline();

  C.implement('net.toggle', {
    enabled: () => !airgap && !app.prefs.isLocked('network'),
    checked: () => net.isOnline(),
    run: () => {
      net.set(net.isOnline() ? 'offline' : 'online');
      app.toast(net.isOnline() ? t('Online: basemaps and cloud catalogs can be used. Every request is listed in the Network Log.') : t('Offline: no request leaves this computer.'), { kind: 'info' });
    },
  });

  // Status-bar switch (both layouts).
  const pills = new Set();
  const renderPill = (b) => {
    const on = net.isOnline();
    b.textContent = airgap ? t('Air-gapped') : on ? t('Online') : t('Offline');
    b.classList.toggle('on', on);
    b.disabled = airgap || app.prefs.isLocked('network');
    b.title = airgap ? t('This is the air-gapped file: it cannot reach the network.') : app.prefs.isLocked('network') ? t('Your site has locked the network setting.') : on ? t('Online: basemaps and cloud catalogs can be used. Click to go offline.') : t('Offline: no request leaves this computer. Click to go online.');
  };
  const addPill = (mp) => {
    const row = mp.status?.rows?.[0];
    if (!row) return;
    const b = h('button', { class: 'status-net', type: 'button', 'data-id': `status:net:${mp.id}`, 'aria-label': t('Online or offline') });
    b.addEventListener('click', () => C.run('net.toggle'));
    row.insertBefore(b, row.querySelector('.status-jobs'));
    pills.add(b);
    renderPill(b);
  };
  app.on('ready', (mp) => addPill(mp));
  const origAdd = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = origAdd(id);
    if (app._ready) addPill(mp);
    return mp;
  };
  app.on('network', () => pills.forEach(renderPill));
  app.on('state', () => pills.forEach(renderPill));

  // ---------------- Basemap tiles (REQ-NET-04) ----------------
  const cache = new Map(); // key → {tex, bytes, used}
  const pending = new Set();
  const failed = new Map();
  // The textures belong to the lost context: drop them, so the tiles are fetched and uploaded again
  // (#238). A tile that failed while the context was lost may have failed for that reason, so retry it.
  app.on('gl-restored', () => {
    cache.clear();
    failed.clear();
  });
  // Local PMTiles basemaps (REQ-NET-05): read by range from a file; they work offline.
  const locals = [];
  // The user's own Web Mercator online sources (REQ-GAP-07): drawn under images through each
  // image's ground-to-image model like the built-in basemaps, not only as Map-view backgrounds.
  const userMaps = () => (app.online?.sources ?? []).filter((s) => app.onlineIsMercator?.(s)).map((s) => ({ id: `user:${s.id}`, name: s.name, short: s.name.slice(0, 18), user: s, maxZoom: s.maxZoom ?? 19, attribution: s.attribution || s.name, swatch: '#7c5cff' }));
  const all = () => [...BASEMAPS, ...locals, ...userMaps()];
  const current = () => all().find((b) => b.id === app.prefs.get('basemap')) ?? null;
  app.basemapCurrent = current;
  // Every PMTiles compression (FC-06, REQ-FMT-30): gzip natively; Brotli (the lazy `brotli` bundle)
  // and Zstandard (the shared zstddec) in a decode worker.
  const inWorker = (compression) => (u8) => app.pool.run('tsDecompress', { bytes: u8.slice(), compression }, { priority: 'interactive', label: t('PMTiles block') }).then((r) => r.bytes);
  const decompress = makeDecompress({ brotli: inWorker(3), zstd: inWorker(4) });
  app.pmtilesDecompress = decompress;
  app.openPmtiles = async (file) => {
    const pm = new PMTiles(new FileSource(file), new SharedPromiseCache(100, true, decompress), decompress);
    let hd;
    try {
      hd = await pm.getHeader();
    } catch (e) {
      // The pmtiles library's own message (it has no error code): the only way to tell a file that is not PMTiles at all.
      if (/magic number/i.test(e.message)) throw gwError('not a PMTiles archive (bad magic number)', null, 'E_PMTILES_MAGIC');
      throw gwError('the PMTiles header or root directory cannot be read ({msg})', { msg: msgOf(e) }, 'E_PMTILES_HEADER');
    }
    // Vector tiles (FC-07): drawn with the default style in a decode worker (features/tilesets.js).
    if (hd.tileType === TileType.Mvt && app.tilesets) return app.tilesets.openVectorBasemap(file);
    if (hd.tileType === TileType.Mvt) throw gwError('{file} holds vector tiles and the vector-tile reader is not loaded', { file: file.name }, 'E_PMTILES_NO_MVT_READER');
    if (hd.tileType === 6) throw new Error('MapLibre Tiles (MLT) are not read: GIS Workbench reads MVT vector and PNG/JPEG/WebP/AVIF raster PMTiles');
    // With no georeferenced image in view a basemap would show nothing: open the tiles as a layer (2.1).
    if (app.tilesets && !app.activePane()?.geoLayer?.()?.modelId) return app.tilesets.openAsLayer(file);
    const meta = await pm.getMetadata().catch(() => ({}));
    const id = `local:${file.name}`;
    const b = { id, name: t('{name} (local file)', { name: meta?.name ?? file.name }), short: (meta?.name ?? file.name).slice(0, 18), local: true, pm, maxZoom: hd.maxZoom, minZoom: hd.minZoom, attribution: meta?.attribution ? String(meta.attribution).replace(/<[^>]*>/g, '') : file.name, swatch: '#6b7280' };
    const i = locals.findIndex((x) => x.id === id);
    if (i >= 0) locals.splice(i, 1, b);
    else locals.push(b);
    for (const k of [...cache.keys()]) if (k.startsWith(`${id}/`)) cache.delete(k);
    await choose(id);
    app.toast(t('{file}: zoom {min}–{max} basemap from this computer (it works offline).', { file: file.name, min: hd.minZoom, max: hd.maxZoom }), { kind: 'info' });
    return b;
  };
  /** A local basemap served by a decode-worker tile set (MBTiles, vector PMTiles): {id, name, worker: {handle, affinity}, …}. */
  app.addLocalBasemap = async (b, { select = true } = {}) => {
    const i = locals.findIndex((x) => x.id === b.id);
    if (i >= 0) locals.splice(i, 1, b);
    else locals.push(b);
    for (const k of [...cache.keys()]) if (k.startsWith(`${b.id}/`)) cache.delete(k);
    if (select) await choose(b.id);
    else scheduleHud();
    return b;
  };
  C.implement('bm.pmtiles', {
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.pmtiles', '.mbtiles'], description: t('PMTiles or MBTiles basemap') });
      if (!f) return;
      if (/.mbtiles$/i.test(f.name) && app.tilesets) await app.tilesets.openWorkerBasemap(f);
      else await app.openPmtiles(f);
    },
  });
  const fetchTile = (b, z, x, y, key) => {
    if (pending.has(key) || pending.size > 16) return;
    const f = failed.get(key);
    if (f && performance.now() - f < 30000) return;
    pending.add(key);
    if (b.worker) {
      // Tile sets in a decode worker: raster tiles decoded, vector tiles drawn there (FC-05, FC-07).
      app.pool
        .run('tsTile', { handle: b.worker.handle, z, x, y, size: b.vector ? 512 : 256 }, { affinity: b.worker.affinity, priority: 'interactive', label: t('basemap tile {z}/{x}/{y}', { z: String(z), x: String(x), y: String(y) }) })
        .then((r) => {
          if (!r?.bmp) throw new Error('no tile');
          cache.set(key, { tex: app.renderer.bitmapTexture(r.bmp), bytes: r.bmp.width * r.bmp.height * 4, used: performance.now() });
          r.bmp.close?.();
          if (cache.size > 400) {
            const old = [...cache.entries()].sort((a, c) => a[1].used - c[1].used);
            for (const [k, t] of old.slice(0, cache.size - 320)) {
              app.renderer.freeTexture(t.tex, t.bytes);
              cache.delete(k);
            }
          }
          app.renderer.invalidate();
        })
        .catch(() => failed.set(key, performance.now()))
        .finally(() => pending.delete(key));
      return;
    }
    if (b.local) {
      b.pm
        .getZxy(z, x, y)
        .then(async (r) => {
          if (!r?.data) throw new Error('no tile');
          const bmp = await createImageBitmap(new Blob([r.data]));
          cache.set(key, { tex: app.renderer.bitmapTexture(bmp), bytes: bmp.width * bmp.height * 4, used: performance.now() });
          bmp.close?.();
          app.renderer.invalidate();
        })
        .catch(() => failed.set(key, performance.now()))
        .finally(() => pending.delete(key));
      return;
    }
    const url = b.user ? null : b.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    (b.user ? app.online.fetchTile(b.user, z, x, y, `Basemap: ${b.short}`).then((bmp) => ({ ok: true, bmp })) : app.netlog.fetchFor(`Basemap: ${b.short}`)(url, { credentials: 'omit' }))
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bmp = res.bmp ?? (await createImageBitmap(await res.blob()));
        cache.set(key, { tex: app.renderer.bitmapTexture(bmp), bytes: bmp.width * bmp.height * 4, used: performance.now() });
        bmp.close?.();
        if (cache.size > 400) {
          const all = [...cache.entries()].sort((a, c) => a[1].used - c[1].used);
          for (const [k, t] of all.slice(0, cache.size - 320)) {
            app.renderer.freeTexture(t.tex, t.bytes);
            cache.delete(k);
          }
        }
        app.renderer.invalidate();
      })
      .catch(() => failed.set(key, performance.now()))
      .finally(() => pending.delete(key));
  };

  const IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  /**
   * Draw the basemap under the image layers of a pane: tiles at the zoom that matches the
   * view's ground scale, each warped through the geo layer's ground→image model on a 4×4 grid.
   */
  app.basemapUnder = (pane, r, vp) => {
    const b = current();
    const l = pane.geoLayer?.();
    pane._basemapShown = null;
    if (!b || (!b.local && !net.isOnline()) || !l?.modelId || pane.stereo || pane.video || pane.view3d) return;
    const { w, h: hh } = pane.size();
    // Ground footprint of the view: the centre ray and the view's ground scale (corner rays can
    // fall outside the model's domain when the view is wider than the image).
    let c0;
    try {
      const v = pane.viewPoint(w / 2, hh / 2);
      c0 = l.groundAt(v.x, v.y);
    } catch {
      return;
    }
    if (!c0 || !Number.isFinite(c0.lat)) return;
    const mpp = pane.groundScale?.(l);
    if (!Number.isFinite(mpp) || mpp <= 0) return;
    const half = (Math.hypot(w, hh) / 2) * mpp * 1.05; // metres from the centre to a corner
    const dLat = (half / 111320);
    const dLon = half / (111320 * Math.max(0.05, Math.cos((c0.lat * Math.PI) / 180)));
    const dpr = vp.dpr || 1;
    // The coarser of the two zooms around the view's scale keeps the tile count small.
    const z = Math.max(b.minZoom ?? 0, Math.min(b.maxZoom, Math.floor(Math.log2((156543.034 * Math.cos((c0.lat * Math.PI) / 180)) / (mpp / dpr)))));
    const n = 2 ** z;
    const x0 = Math.floor(lon2x(c0.lon - dLon, n));
    const x1 = Math.floor(lon2x(c0.lon + dLon, n));
    const y0 = Math.max(0, Math.floor(lat2y(Math.min(MAX_LAT, c0.lat + dLat), n)));
    const y1 = Math.min(n - 1, Math.floor(lat2y(Math.max(-MAX_LAT, c0.lat - dLat), n)));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 150) return;
    const pts = [c0];
    const now = performance.now();
    const hgt = pts.at(-1).h ?? 0;
    const screen = (lat, lon) => {
      const p = l.imageAt(lat, lon, hgt);
      if (!p || !Number.isFinite(p.x)) return null;
      return forwardView(pane.view, w, hh, p.x, p.y);
    };
    const G = 4;
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const key = `${b.id}/${z}/${wx}/${ty}`;
        const t = cache.get(key);
        if (!t) {
          fetchTile(b, z, wx, ty, key);
          continue;
        }
        t.used = now;
        const grid = [];
        let ok = true;
        for (let j = 0; j <= G && ok; j++)
          for (let i = 0; i <= G; i++) {
            const s = screen(y2lat(ty + j / G, n), x2lon(tx + i / G, n));
            if (!s) {
              ok = false;
              break;
            }
            grid.push(s);
          }
        if (!ok) continue;
        const v = new Float32Array(G * G * 6 * 4);
        let o = 0;
        for (let j = 0; j < G; j++)
          for (let i = 0; i < G; i++) {
            const c = (a, bb) => grid[a * (G + 1) + bb];
            for (const [jj, ii] of [[j, i], [j, i + 1], [j + 1, i], [j, i + 1], [j + 1, i + 1], [j + 1, i]]) {
              const p = c(jj, ii);
              v[o++] = p.x;
              v[o++] = p.y;
              v[o++] = ii / G;
              v[o++] = jj / G;
            }
          }
        r.drawTextured(t.tex, v, IDENTITY, w, hh, 1);
      }
    if (pending.size) r.invalidate();
    pane._basemapShown = b;
  };

  // ---------------- Corner switcher with attribution ----------------
  const hud = new Map(); // pane → {btn, attr}
  const ensureHud = (pane) => {
    let x = hud.get(pane);
    if (x?.btn.isConnected) return x;
    const btn = h('button', { class: 'basemap-btn', type: 'button', 'data-id': `pane:${pane.id}:basemap`, 'aria-label': t('Basemap'), 'aria-haspopup': 'menu' }, h('span', { class: 'basemap-swatch' }), h('span', { class: 'basemap-name' }));
    for (const t of ['pointerdown', 'dblclick', 'wheel']) btn.addEventListener(t, (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      basemapMenu(btn);
    });
    const attr = h('div', { class: 'basemap-attr', 'aria-live': 'polite' });
    pane.el.append(btn, attr);
    x = { btn, attr };
    hud.set(pane, x);
    return x;
  };
  const refreshHud = () => {
    for (const mp of app.desktop.multiports)
      for (const pane of mp.panes) {
        const l = pane.geoLayer?.();
        const show = !!l?.modelId && !pane.video && !pane.view3d;
        const x = ensureHud(pane);
        x.btn.hidden = !show;
        const b = current();
        x.btn.querySelector('.basemap-swatch').style.background = b?.swatch ?? 'transparent';
        x.btn.querySelector('.basemap-name').textContent = b ? basemapShort(b) : t('Basemap');
        x.btn.classList.toggle('waiting', !!b && !b.local && !net.isOnline());
        const shown = pane._basemapShown;
        x.attr.hidden = !(show && b && (b.local || net.isOnline()));
        if (x.attr.textContent !== (b?.attribution ?? '')) x.attr.textContent = b?.attribution ?? '';
        void shown;
      }
  };
  let ht = 0;
  const scheduleHud = () => {
    if (!ht) ht = setTimeout(() => ((ht = 0), refreshHud()), 40);
  };
  app.on('state', scheduleHud);
  app.on('layout', scheduleHud);
  app.on('network', scheduleHud);

  const choose = async (id) => {
    const b = all().find((x) => x.id === id);
    if (b?.optIn && !app.prefs.get(`basemapOptIn.${b.id}`)) {
      const ok = await confirmBox(basemapName(b), tr(b.policy), { ok: t('Use it'), cancel: t('Cancel') });
      if (!ok) return;
      app.prefs.set(`basemapOptIn.${b.id}`, true);
    }
    app.prefs.set('basemap', b ? b.id : null);
    if (b && !b.local && !net.isOnline() && !airgap) {
      app.toast(t('{basemap} is an online basemap and GIS Workbench is offline.', { basemap: basemapShort(b) }), { kind: 'info', action: { label: t('Go online'), run: () => C.run('net.toggle') } });
    }
    scheduleHud();
    app.renderer.invalidate();
    app.emit('state');
  };
  app.setBasemap = choose;
  function basemapMenu(anchor) {
    const cur = current()?.id ?? null;
    const items = [{ label: t('None'), checked: !cur, run: () => choose(null) }, '-'];
    for (const b of BASEMAPS) items.push({ label: b.optIn ? t('{basemap} — opt-in', { basemap: basemapName(b) }) : basemapName(b), checked: cur === b.id, disabled: airgap, run: () => choose(b.id) });
    for (const b of locals) items.push({ label: b.name, checked: cur === b.id, run: () => choose(b.id) });
    for (const b of userMaps()) items.push({ label: t('{name} (your online source)', { name: b.name }), checked: cur === b.id, disabled: airgap, run: () => choose(b.id) });
    items.push({ cmd: 'bm.pmtiles' });
    items.push('-');
    if (airgap) items.push({ label: t('This is the air-gapped file: no online basemaps'), disabled: true });
    else items.push({ label: net.isOnline() ? t('Go Offline') : t('Go Online'), run: () => C.run('net.toggle') });
    items.push({ cmd: 'online.backgrounds' });
    openMenu(items, app, { anchor });
  }
  C.implement('bm.basemap', { run: () => basemapMenu(document.activeElement), enabled: () => !!app.activePane()?.geoLayer?.()?.modelId });
}
