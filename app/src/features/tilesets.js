// Tile sets (2.1 FC-05..07; REQ-FMT-28..33, amended REQ-NET-05): MBTiles and PMTiles open as a
// georeferenced layer (raster tiles on GDAL's grid, vector tiles drawn with the default style) or
// as a basemap under imagery; vector tiles can be identified under the cursor and extracted, for
// the view, the AOI or the whole set, to ordinary vector layers. Writers: any georeferenced image
// or tile set to PMTiles (v3, gzip directories) or MBTiles, and vector layers through the MVT tiler.
// The tiles live in a decode worker (workers/decode/tileset.js); this module drives them.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { openImageFile } from '../formats/open.js';
import { forWorker } from '../connectors/remote.js';
import { readGeoJSON } from '../vector/io.js';
import { toGeoJSON } from '../vector/geom.js';
import { encodeTilerInput } from '../tiles/tiler.js';
import { lonLatToWorld } from '../tiles/merc.js';
import { errorText } from '../core/util.js';
import { t, tc, gwError, msgOf } from '../i18n/index.js';
import { int, num } from '../i18n/format.js';

export const name = 'tilesets';

const lat2y = (lat, n) => lonLatToWorld(0, lat)[1] * n;
const lon2x = (lon, n) => ((lon + 180) / 360) * n;
const y2lat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
const x2lon = (x, n) => (x / n) * 360 - 180;
// Save As Tiles with the maximum zoom on auto stops near this many tiles; any run stops with a named
// error once the tiles kept for the writer pass MAX_TILE_BYTES (they travel to the writer at once).
const AUTO_TILES = 4096;
const MAX_TILE_BYTES = 512 << 20;

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const worker = new Map(); // basemap id → {handle, affinity, meta, file}

  const tilesetOf = (l) => (l?.info?.kind === 'tileset' ? l : null);
  /** The vector tile set to identify or extract from: the active tile-set layer, else the vector basemap. */
  const vectorTarget = () => {
    const l = tilesetOf(app.activeLayer?.());
    if (l?.info?.meta?.vector) return { handle: l.handle, affinity: l.affinity, meta: l.info.meta, name: l.rec?.name ?? l.info.fileName, layer: l };
    const b = app.basemapCurrent?.();
    if (b?.worker && b.vector) return { handle: b.worker.handle, affinity: b.worker.affinity, meta: b.meta, name: b.file?.name ?? b.name };
    return null;
  };

  /** Open a tile set in a decode worker without an image layer (a basemap). */
  async function openWorkerBasemap(file, { select = true } = {}) {
    const job = app.pool.run('tsOpen', { file: forWorker(file), name: file.name }, { label: t('Reading {file}…', { file: file.name }), timeout: 600000 });
    const { handle, meta } = await job;
    const affinity = app.pool.lastAffinity?.(job.jobId) ?? null;
    const id = `local:${file.name}`;
    const vector = !!meta.vector || meta.tileType === 'mvt';
    const b = {
      id,
      name: vector ? t('{name} ({container}, vector, local file)', { name: meta.name ?? file.name, container: meta.container ?? t('tiles') }) : t('{name} ({container}, local file)', { name: meta.name ?? file.name, container: meta.container ?? t('tiles') }),
      short: String(meta.name ?? file.name).slice(0, 18),
      local: true,
      worker: { handle, affinity },
      vector,
      meta,
      file,
      // Vector tiles draw sharply past their last zoom (over-zoom); raster tiles stop at theirs.
      maxZoom: vector ? Math.min(22, meta.maxZoom + 4) : meta.maxZoom,
      minZoom: meta.minZoom,
      attribution: meta.attribution || file.name,
      swatch: vector ? '#c9d8b6' : '#6b7280',
    };
    worker.set(id, b);
    await app.addLocalBasemap(b, { select });
    const zoomArgs = { min: String(meta.minZoom), max: String(meta.maxZoom) };
    app.importLog.push({ file: file.name, errors: [], warnings: [vector ? t('{container} vector (MVT), zoom {min}–{max}, used as a basemap', { container: meta.container ?? t('tile set'), ...zoomArgs }) : t('{container} {type}, zoom {min}–{max}, used as a basemap', { container: meta.container ?? t('tile set'), type: String(meta.tileType ?? '').toUpperCase(), ...zoomArgs })] });
    app.toast(vector ? t('{file}: vector basemap, zoom {min}–{max}, from this computer (it works offline).', { file: file.name, ...zoomArgs }) : t('{file}: raster basemap, zoom {min}–{max}, from this computer (it works offline).', { file: file.name, ...zoomArgs }), vector ? { kind: 'info', action: { label: t('Extract Features…'), run: () => C.run('vt.extract') } } : { kind: 'info' });
    return b;
  }

  /** Open a vector PMTiles: a basemap under the georeferenced image in view, else a layer of its own. */
  async function openVectorBasemap(file) {
    const p = pane();
    if (p?.geoLayer?.()?.modelId) return openWorkerBasemap(file);
    return openAsLayer(file, p);
  }

  /** Open a tile set as a georeferenced image layer (raster tiles, or vector tiles drawn). */
  async function openAsLayer(file, p = pane()) {
    const { layers, report } = await openImageFile(app, file, { pane: p });
    const l = layers[0];
    const m = l?.info?.meta ?? {};
    const vector = !!m.vector;
    const zoomArgs = { container: m.container, min: String(m.minZoom), max: String(m.maxZoom) };
    const note = [
      vector ? t('{container} vector (MVT), drawn at zoom {z}; zoom {min}–{max}', { ...zoomArgs, z: String(m.drawZoom) }) : t('{container} {type}; zoom {min}–{max}', { ...zoomArgs, type: String(m.tileType).toUpperCase() }),
      m.tileCompression && m.tileCompression !== 'none' ? t('{codec} tiles', { codec: m.tileCompression }) : null,
      m.internalCompression && m.internalCompression !== 'none' ? t('{codec} directories', { codec: m.internalCompression }) : null,
    ].filter(Boolean).join('; ');
    report.warnings.push(note);
    const actions = vector ? { kind: 'info', action: { label: t('Extract Features…'), run: () => C.run('vt.extract') } } : { kind: 'info', action: { label: t('Use as Basemap'), run: () => C.run('vt.basemap') } };
    app.toast(t('{file}: {w} × {h} px, {note}', { file: file.name, w: int(l.width), h: int(l.height), note }), actions);
    return { layers, report };
  }

  /** Route a dropped .mbtiles / .pmtiles: MBTiles always as a layer (it matches GDAL's raster). */
  async function openFile(file, p) {
    if (/\.mbtiles$/i.test(file.name)) return openAsLayer(file, p);
    return app.openPmtiles(file);
  }

  /** Ground bounding box [w, s, e, n] of what a pane shows, or null. */
  function viewBox(p) {
    const l = p?.geoLayer?.();
    if (!l?.modelId) return null;
    const { w, h: hh } = p.size();
    const pts = [];
    for (const [x, y] of [[0, 0], [w, 0], [w, hh], [0, hh], [w / 2, hh / 2]]) {
      const q = p.imagePoint(x, y);
      const g = l.groundAt(Math.max(0, Math.min(l.width, q.x)), Math.max(0, Math.min(l.height, q.y)));
      if (g && Number.isFinite(g.lat)) pts.push(g);
    }
    if (pts.length < 3) return null;
    return [Math.min(...pts.map((g) => g.lon)), Math.min(...pts.map((g) => g.lat)), Math.max(...pts.map((g) => g.lon)), Math.max(...pts.map((g) => g.lat))];
  }
  function aoiBox(p) {
    const a = app.aoiFor?.(p);
    if (!a || a.anchor !== 'ground' || !a.coords?.length) return null;
    const xs = a.coords.map((c) => c[0]);
    const ys = a.coords.map((c) => c[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  /** Zoom whose tiles match the pane's ground scale. */
  function viewZoom(p) {
    const l = p?.geoLayer?.();
    const mpp = p?.groundScale?.(l);
    const c = viewBox(p);
    if (!Number.isFinite(mpp) || !c) return null;
    const lat = (c[1] + c[3]) / 2;
    return Math.max(0, Math.log2((156543.034 * Math.cos((lat * Math.PI) / 180)) / mpp));
  }

  /**
   * Extract the features of a vector tile set to vector layers (one per MVT layer). opts: scope
   * 'view' | 'aoi' | 'all', bbox, zoom (default the maximum), layers (names), target.
   */
  async function extract({ scope = 'all', bbox = null, zoom = null, layers = null, clip = true, target = vectorTarget() } = {}) {
    if (!target) throw gwError('no vector tile set: open a vector MBTiles or PMTiles first', null, 'E_NO_VECTOR_TILESET');
    const p = pane();
    const box = bbox ?? (scope === 'view' ? viewBox(p) : scope === 'aoi' ? aoiBox(p) : null);
    if (scope !== 'all' && !box) throw scope === 'aoi' ? gwError('set a ground AOI first (AOI ▸ Box)', null, 'E_NO_GROUND_AOI') : gwError('the panel shows no georeferenced view', null, 'E_NO_GEO_VIEW');
    const r = await app.pool.run('tsExtract', { handle: target.handle, bbox: box, zoom, layers, clip }, { affinity: target.affinity, timeout: 600000, label: t('extract {name}', { name: target.name }) });
    const ids = [];
    const stem = String(target.name).replace(/\.(mbtiles|pmtiles)$/i, '');
    for (const [lname, feats] of Object.entries(r.layers)) {
      if (!feats.length) continue;
      // GDAL's MVT driver keeps the feature id as mvt_id.
      for (const f of feats) if (f.id !== undefined && f.id !== null) f.properties = { mvt_id: f.id, ...f.properties };
      const { layer, report } = readGeoJSON({ type: 'FeatureCollection', features: feats }, { name: `${stem} ${lname}` });
      report.format = 'MVT';
      report.warnings.unshift(clip ? t('zoom {z}, {n, plural, one {# tile} other {# tiles}}, features clipped to their tiles', { z: String(r.zoom), n: r.tiles }) : t('zoom {z}, {n, plural, one {# tile} other {# tiles}}, tile features as stored (with their buffers)', { z: String(r.zoom), n: r.tiles }));
      const id = app.addVectorLayer(layer, { format: 'MVT', file: target.name, table: lname, zoom: r.zoom, report });
      ids.push({ id, name: lname, features: layer.features.length, report });
    }
    app.importLog.push({ file: target.name, errors: [], warnings: [t('extracted {f, plural, one {# feature} other {# features}} in {l, plural, one {# layer} other {# layers}} at zoom {z} from {n, plural, one {# tile} other {# tiles}}', { f: r.features, l: ids.length, z: String(r.zoom), n: r.tiles })] });
    return { zoom: r.zoom, tiles: r.tiles, features: r.features, layers: ids };
  }

  async function extractDialog() {
    const tgt = vectorTarget();
    if (!tgt) throw gwError('no vector tile set: open a vector MBTiles or PMTiles, or choose one as the basemap', null, 'E_NO_VECTOR_TILESET');
    const p = pane();
    const scope = h('select', { class: 'inp', 'aria-label': tc('region', 'Area') }, h('option', { value: 'view' }, t('What the panel shows')), h('option', { value: 'aoi', disabled: !aoiBox(p) }, t('The AOI')), h('option', { value: 'all' }, t('The whole tile set')));
    scope.value = viewBox(p) && !(tgt.layer && Math.abs(viewZoom(p) - tgt.meta.maxZoom) > 8) ? 'view' : 'all';
    const z = h('input', { class: 'inp inp-num', type: 'number', min: tgt.meta.minZoom, max: tgt.meta.maxZoom, step: 1, value: tgt.meta.maxZoom, 'aria-label': t('Zoom') });
    const names = (tgt.meta.vectorLayers ?? []).map((l) => l.id).filter(Boolean);
    const boxes = names.map((n) => h('input', { type: 'checkbox', checked: true, 'aria-label': n }));
    const body = h('div', {}, field(tc('region', 'Area'), scope), field(t('Zoom'), z, t('Tiles at this zoom are read ({min}–{max}); the maximum has the full detail. Features are clipped to their tiles, so one that crosses tiles comes in pieces.', { min: String(tgt.meta.minZoom), max: String(tgt.meta.maxZoom) })), names.length ? field(t('Layers'), h('div', {}, ...names.map((n, i) => h('label', { class: 'chk', style: { display: 'block' } }, boxes[i], ` ${n}`)))) : null);
    if ((await modal({ title: t('Extract Tile Features'), body, buttons: [{ label: t('Extract'), value: 'extract', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'vt-extract' })) !== 'extract') return;
    const layers = names.length ? names.filter((_, i) => boxes[i].checked) : null;
    app.toast(t('Extracting features from {name}…', { name: tgt.name }), { kind: 'info' });
    const r = await extract({ scope: scope.value, zoom: Number(z.value), layers, target: tgt });
    app.toast(t('{name}: {f, plural, one {# feature} other {# features}} in {l, plural, one {# layer} other {# layers}} from {n, plural, one {# tile} other {# tiles}} at zoom {z}', { name: tgt.name, f: r.features, l: r.layers.length, n: r.tiles, z: String(r.zoom) }), { kind: 'info' });
    if (r.layers.length) app.zoomToLayer?.(r.layers[0].id);
  }

  /** Features under a ground point. */
  async function identify(lat, lon, { zoom = null, target = vectorTarget() } = {}) {
    if (!target) throw gwError('no vector tile set: open a vector MBTiles or PMTiles first', null, 'E_NO_VECTOR_TILESET');
    const z = zoom ?? viewZoom(pane()) ?? target.meta.maxZoom;
    return app.pool.run('tsQuery', { handle: target.handle, lat, lon, zoom: z }, { affinity: target.affinity, priority: 'interactive', label: t('identify tile features') });
  }

  const pickGround = (cue) =>
    new Promise((res) => {
      app.tools.register({
        id: 'vt.pick',
        cue,
        onDown(p, e, sx, sy) {
          const l = p.geoLayer?.();
          const q = p.imagePoint(sx, sy);
          res(l?.modelId ? l.groundAt(q.x, q.y) : null);
          app.tools.done();
          return true;
        },
      });
      app.tools.select('vt.pick');
    });

  function showFeatures(r, name) {
    const rows = r.features.map((f) =>
      h('details', { open: r.features.length <= 3 }, h('summary', {}, [`${f.layer}`, `${f.type}`, ...[f.id !== null ? t('id {id}', { id: String(f.id) }) : null, f.properties.name ? String(f.properties.name) : null].filter(Boolean)].join(' · ')),
        h('table', { class: 'kv' }, ...Object.entries(f.properties).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, String(v)))))));
    const body = h('div', { 'data-id': 'vt:identify' }, h('p', { class: 'hint' }, t('{name}: tile {tile} — {n, plural, one {# feature} other {# features}} at the point', { name, tile: r.tile.join('/'), n: r.features.length })), h('div', { style: { maxHeight: '55vh', overflow: 'auto' } }, ...rows));
    return modal({ title: t('Tile Features'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'vt-identify' });
  }

  // ---- writers ----

  const stem = (s) => String(s ?? 'tiles').replace(/\.\w+$/, '').replace(/[^\w.-]+/g, '_');
  async function saveBytes(bytes, nm, to) {
    const ext = to === 'pmtiles' ? '.pmtiles' : '.mbtiles';
    await saveBlob(app, new Blob([bytes], { type: to === 'pmtiles' ? 'application/vnd.pmtiles' : 'application/vnd.sqlite3' }), { name: `${nm}${ext}`, types: [ext], description: to === 'pmtiles' ? 'PMTiles' : 'MBTiles' }); // format names (DN-62 rule 7)
  }

  /** Copy (convert) a tile-set layer or basemap: MBTiles ↔ PMTiles, optionally an area and zoom range. */
  async function exportTileset({ to, bbox = null, minZoom = null, maxZoom = null, target = null, save = true } = {}) {
    const l = tilesetOf(app.activeLayer?.());
    const b = app.basemapCurrent?.();
    const src = target ?? (l ? { handle: l.handle, affinity: l.affinity, name: l.rec?.name } : b?.worker ? { handle: b.worker.handle, affinity: b.worker.affinity, name: b.file?.name } : null);
    if (!src) throw new Error('no tile set to copy');
    const r = await app.pool.run('tsExport', { handle: src.handle, to, bbox, minZoom, maxZoom }, { affinity: src.affinity, timeout: 1800000, label: t('write {format}', { format: to }) });
    if (save) await saveBytes(r.bytes, stem(src.name), to);
    return r;
  }

  /** Display mapping of a layer's bands to 8 bits: null (8-bit), else 2–98 % of a coarse sample. */
  async function lutFor(l, bands) {
    if (l.sampleType === 'u8') return null;
    const step = Math.max(1, Math.ceil(Math.max(l.width, l.height) / 512));
    const win = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: Math.ceil(l.width / step), h: Math.ceil(l.height / step), step, bands }, { affinity: l.affinity, label: t('tiles: stretch') });
    return win.planes.map((pl) => {
      const v = Array.from(pl).filter((x) => Number.isFinite(x) && x !== l.nodata).sort((a, b) => a - b);
      if (!v.length) return [1, 0];
      const lo = v[Math.floor(v.length * 0.02)];
      const hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.98))];
      const s = hi > lo ? 255 / (hi - lo) : 1;
      return [s, -lo * s];
    });
  }

  /**
   * Tile a georeferenced image layer to Web Mercator (REQ-FMT-29, REQ-FMT-31): zoom range (default
   * from the image's ground sample distance), PNG/JPEG/WebP tiles, PMTiles or MBTiles.
   */
  async function tileImage(l, { to = 'pmtiles', type = 'png', minZoom = null, maxZoom = null, bbox = null, budget = null, save = true, onProgress = () => {} } = {}) {
    if (!l?.modelId) throw new Error('the image is not georeferenced');
    const g = [];
    for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
      const p = l.groundAt((i / 8) * l.width, (j / 8) * l.height);
      if (p && Number.isFinite(p.lat)) g.push(p);
    }
    if (g.length < 4) throw new Error('the image footprint cannot be found from its model');
    let box = [Math.min(...g.map((p) => p.lon)), Math.max(-85.05, Math.min(...g.map((p) => p.lat))), Math.max(...g.map((p) => p.lon)), Math.min(85.05, Math.max(...g.map((p) => p.lat)))];
    // A grid in 0..360° longitude (PROJ's GEOID18 is 230..300°E): the tiles use ±180°, the image its own.
    const east = box[0] >= 180 ? 360 : 0;
    box[0] -= east;
    box[2] -= east;
    if (bbox) box = [Math.max(box[0], bbox[0]), Math.max(box[1], bbox[1]), Math.min(box[2], bbox[2]), Math.min(box[3], bbox[3])];
    if (!(box[2] > box[0] && box[3] > box[1])) throw new Error('the area does not overlap the image');
    const lat = (box[1] + box[3]) / 2;
    // Ground sample distance across the image.
    const c0 = l.groundAt(l.width / 2, l.height / 2);
    const c1 = l.groundAt(l.width / 2 + 1, l.height / 2);
    const gsd = Math.hypot((c1.lon - c0.lon) * 111320 * Math.cos((lat * Math.PI) / 180), (c1.lat - c0.lat) * 110574) || 1;
    const zNative = Math.max(0, Math.min(22, Math.ceil(Math.log2((156543.034 * Math.cos((lat * Math.PI) / 180)) / gsd))));
    let z1 = Math.min(24, maxZoom ?? zNative);
    // A tile budget lowers the maximum zoom until the pyramid fits (checks and previews). With the
    // maximum zoom left on auto, a large image is tiled to about AUTO_TILES tiles, not to its native
    // resolution (a 1 GB SLC at native zoom is tens of thousands of tiles, minutes and gigabytes).
    const count = (z) => (Math.floor(lon2x(box[2], 2 ** z)) - Math.floor(lon2x(box[0], 2 ** z)) + 1) * (Math.floor(lat2y(box[1], 2 ** z)) - Math.floor(lat2y(box[3], 2 ** z)) + 1);
    const auto = maxZoom === null || maxZoom === undefined;
    const cap = budget ?? (auto ? AUTO_TILES : null);
    if (cap) while (z1 > 0 && count(z1) * 1.34 > cap) z1--;
    const lowered = auto && z1 < Math.min(24, zNative) ? Math.min(24, zNative) : null;
    let z0 = minZoom;
    if (z0 === null || z0 === undefined) {
      z0 = z1;
      while (z0 > 0 && (Math.floor(lon2x(box[2], 2 ** z0)) - Math.floor(lon2x(box[0], 2 ** z0)) > 0 || Math.floor(lat2y(box[1], 2 ** z0)) - Math.floor(lat2y(box[3], 2 ** z0)) > 0)) z0--;
    }
    z0 = Math.min(z0, z1);
    const list = [];
    for (let z = z0; z <= z1; z++) {
      const n = 2 ** z;
      for (let y = Math.floor(lat2y(box[3], n)); y <= Math.min(n - 1, Math.floor(lat2y(box[1], n))); y++)
        for (let x = Math.floor(lon2x(box[0], n)); x <= Math.min(n - 1, Math.floor(lon2x(box[2], n))); x++) list.push([z, x, y]);
      if (list.length > 100000) throw gwError('more than {max, number} tiles at zoom {z}: choose a lower maximum zoom or an area', { max: 100000, z: String(z) }, 'E_TILES_TOO_MANY');
    }
    const nb = l.bands >= 3 ? 3 : 1;
    const bands = nb === 3 ? (l.chain?.bands?.length === 3 && l.chain.bands.every((b) => b < l.bands) ? l.chain.bands : [0, 1, 2]) : [l.chain?.bands?.[0] ?? 0];
    const lut = await lutFor(l, bands);
    const G = 8;
    const tiles = [];
    let done = 0;
    let held = 0; // bytes of the tiles kept for the writer
    const one = async ([z, x, y]) => {
      if (held > MAX_TILE_BYTES) return;
      const n = 2 ** z;
      const grid = new Float64Array(2 * (G + 1) * (G + 1));
      let o = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j <= G; j++)
        for (let i = 0; i <= G; i++) {
          const q = l.imageAt(y2lat(y + j / G, n), x2lon(x + i / G, n) + east); // at the layer's height, as the footprint above
          grid[o++] = q && Number.isFinite(q.x) ? q.x : NaN;
          grid[o++] = q && Number.isFinite(q.y) ? q.y : NaN;
          if (q && Number.isFinite(q.x)) {
            lo = Math.min(lo, q.x);
            hi = Math.max(hi, q.x);
          }
        }
      const span = Number.isFinite(hi - lo) ? Math.max(1, hi - lo) : 256;
      const level = Math.max(0, Math.floor(Math.log2(span / 256)));
      const r = await app.pool.run('warpTile', { handle: l.handle, grid, G, size: 256, level, bands, lut, type }, { affinity: l.affinity, transfer: [grid.buffer], label: t('tile {z}/{x}/{y}', { z: String(z), x: String(x), y: String(y) }) });
      if (r.bytes) {
        tiles.push({ z, x, y, data: r.bytes });
        held += r.bytes.byteLength;
      }
      onProgress(++done / list.length);
    };
    for (let i = 0; i < list.length && held <= MAX_TILE_BYTES; i += 8) await Promise.all(list.slice(i, i + 8).map(one));
    if (held > MAX_TILE_BYTES) throw gwError('the tiles pass {mb} MB in memory by zoom {z}: choose a lower maximum zoom or an area', { mb: MAX_TILE_BYTES >> 20, z: String(z1) }, 'E_TILES_TOO_LARGE');
    if (!tiles.length) throw new Error('no tile holds image pixels');
    const r = await app.pool.run('tsWrite', { tiles, to, type, bounds: box, name: l.rec?.name ?? 'image' }, { label: t('write {format}', { format: to }), timeout: 600000 });
    if (save) await saveBytes(r.bytes, stem(l.rec?.name), to);
    return { bytes: r.bytes, tiles: tiles.length, minZoom: z0, maxZoom: z1, bounds: box, lowered };
  }

  /** Tile a vector layer to MVT (REQ-FMT-33): zoom range, simplification, attribute filter. */
  async function tileVector(id, { to = 'pmtiles', minZoom = 0, maxZoom = 12, tolerance = 1, fields = null, budget = null, save = true } = {}) {
    const lo = app.vectorLayerOut(id);
    if (!lo.features.length) throw lo.name ? gwError('{layer} has no features', { layer: lo.name }, 'E_LAYER_EMPTY') : gwError('the layer has no features', null, 'E_LAYER_EMPTY');
    const lname = (lo.name || 'layer').replace(/\s+/g, '_');
    const feats = lo.features.map((f) => ({ type: 'Feature', id: Number.isInteger(Number(f.fid)) ? Number(f.fid) : undefined, geometry: toGeoJSON(f.geom), properties: { ...(f.attrs ?? {}), ...(f.name !== null && f.name !== undefined ? { name: f.name } : {}), ...(f.description ? { description: f.description } : {}) } }));
    const layers = [{ name: lname, features: feats }];
    const { bytes: input } = encodeTilerInput(layers, { fields: fields ? { [lname]: fields } : null });
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        w = Math.min(w, c[0]);
        e = Math.max(e, c[0]);
        s = Math.min(s, c[1]);
        n = Math.max(n, c[1]);
      } else c.forEach(walk);
    };
    for (const f of feats) if (f.geometry) walk(f.geometry.coordinates);
    // A tile budget lowers the maximum zoom until the layer's extent spans few enough tiles.
    if (budget) while (maxZoom > minZoom && (Math.floor(lon2x(e, 2 ** maxZoom)) - Math.floor(lon2x(w, 2 ** maxZoom)) + 1) * (Math.floor(lat2y(Math.max(-85, s), 2 ** maxZoom)) - Math.floor(lat2y(Math.min(85, n), 2 ** maxZoom)) + 1) > budget) maxZoom--;
    const slim = [{ name: lname, features: feats.slice(0, 1000).map((f) => ({ properties: f.properties })) }];
    const r = await app.pool.run('mvtTiler', { input, layers: slim, to, minZoom, maxZoom, tolerance, name: lo.name, bounds: [w, Math.max(-85.05, s), e, Math.min(85.05, n)] }, { transfer: [input.buffer], timeout: 1800000, label: t('tile {layer}', { layer: lo.name ?? '' }) });
    if (save) await saveBytes(r.bytes, stem(lo.name), to);
    return { ...r, minZoom, maxZoom };
  }

  app.tilesets = { openFile, openAsLayer, openVectorBasemap, openWorkerBasemap, extract, identify, viewBox, exportTileset, tileImage, tileVector };

  // ---- commands ----
  // errorText() turns a parser's raw exception into plain words; anything else keeps its own message.
  const errText = (e) => {
    const m = errorText(e);
    return m === String(e?.message ?? e ?? '') ? msgOf(e) : msgOf(m);
  };
  // "Do this first" refusals are guidance, not failures.
  const STEP = new Set(['E_NO_VECTOR_TILESET', 'E_NO_GROUND_AOI', 'E_NO_GEO_VIEW']);
  const fail = (e) => app.toast(errText(e), { kind: STEP.has(e?.code) ? 'warn' : 'error', ms: 9000 });
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      if (!e?.cancelled) fail(e);
    }
  };
  C.implement('vt.extract', { enabled: () => !!vectorTarget(), run: run(extractDialog) });
  C.implement('vt.identify', {
    enabled: () => !!vectorTarget() && !!pane()?.geoLayer?.()?.modelId,
    // Selects a pick tool and returns; the click identifies (the command does not wait for it).
    run: () => {
      const tgt = vectorTarget();
      pickGround(t('Click a feature of the vector tiles.'))
        .then((g) => g && identify(g.lat, g.lon, { target: tgt }).then((r) => showFeatures(r, tgt.name)))
        .catch(fail);
    },
  });
  C.implement('vt.basemap', {
    enabled: () => !!tilesetOf(app.activeLayer?.()),
    run: run(async () => {
      const l = tilesetOf(app.activeLayer());
      const f = app.files.get(l.rec.file)?.file;
      if (!f) throw new Error('the tile set file is no longer open');
      await openWorkerBasemap(f);
    }),
  });
  C.implement('tiles.save', {
    enabled: () => !!app.activeLayer?.()?.modelId || !!app.basemapCurrent?.()?.worker,
    run: run(async () => {
      const l = app.activeLayer?.();
      const ts = tilesetOf(l) ?? (!l?.modelId && app.basemapCurrent?.()?.worker ? true : null);
      const to = h('select', { class: 'inp', 'aria-label': t('Format') }, h('option', { value: 'pmtiles' }, t('PMTiles v3 (read by range, one file)')), h('option', { value: 'mbtiles' }, t('MBTiles 1.3 (SQLite)')));
      const type = h('select', { class: 'inp', 'aria-label': t('Tile format') }, h('option', { value: 'png' }, t('PNG (lossless, transparent outside the image)')), h('option', { value: 'jpeg' }, t('JPEG (smaller, black outside)')), h('option', { value: 'webp' }, 'WebP')); // i18n-ignore: WebP is a format name (DN-62 rule 7)
      const zmin = h('input', { class: 'inp inp-num', type: 'number', min: 0, max: 24, placeholder: t('auto'), 'aria-label': t('Minimum zoom') });
      const zmax = h('input', { class: 'inp inp-num', type: 'number', min: 0, max: 24, placeholder: t('auto'), 'aria-label': t('Maximum zoom') });
      const area = h('select', { class: 'inp', 'aria-label': tc('region', 'Area') }, h('option', { value: 'all' }, ts ? t('The whole tile set') : t('The whole image')), h('option', { value: 'view' }, t('What the panel shows')), h('option', { value: 'aoi', disabled: !aoiBox(pane()) }, t('The AOI')));
      const body = h('div', {}, field(t('Format'), to), ts ? h('p', { class: 'hint' }, t('The tiles are copied as they are (MBTiles ↔ PMTiles conversion).')) : field(t('Tiles'), type), field(t('Zoom'), h('span', {}, zmin, ` ${tc('zoom range', 'to')} `, zmax), ts ? t('Empty: every zoom of the set.') : t('Empty: from the image\'s ground sample distance down to one tile.')), field(tc('region', 'Area'), area));
      if ((await modal({ title: t('Save As Tiles'), body, buttons: [{ label: t('Save'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'tiles-save' })) !== 'save') return;
      const zoomOf = (el) => (el.value === '' ? null : Number(el.value));
      const bbox = area.value === 'view' ? viewBox(pane()) : area.value === 'aoi' ? aoiBox(pane()) : null;
      app.toast(to.value === 'pmtiles' ? t('Writing PMTiles…') : t('Writing MBTiles…'), { kind: 'info' });
      const r = await app.activity.track(to.value === 'pmtiles' ? t('Writing PMTiles…') : t('Writing MBTiles…'), (job) => (ts ? exportTileset({ to: to.value, bbox, minZoom: zoomOf(zmin), maxZoom: zoomOf(zmax) }) : tileImage(l, { to: to.value, type: type.value, minZoom: zoomOf(zmin), maxZoom: zoomOf(zmax), bbox , onProgress: (f) => job.set(f) })));
      const args = { n: r.tiles, mb: num(r.bytes.byteLength / 1048576, 1) };
      const msg = r.lowered
        ? t('{n, plural, one {# tile} other {# tiles}} written ({mb} MB); zoom {min}–{max}, as the image\'s native zoom {native} makes too many tiles: set a maximum zoom or choose an area for more detail', { ...args, min: String(r.minZoom), max: String(r.maxZoom), native: String(r.lowered) })
        : t('{n, plural, one {# tile} other {# tiles}} written ({mb} MB)', args);
      app.toast(msg, { kind: 'info', ms: r.lowered ? 9000 : 4000 });
    }),
  });
  // Vector layers that hold features: an empty layer has nothing to tile.
  const tileable = () => {
    const has = new Set(S.all('feature').map((f) => f.vlayer));
    return S.all('vlayer').filter((v) => has.has(v.id));
  };
  C.implement('tiles.mvt', {
    enabled: () => tileable().length > 0,
    run: run(async () => {
      const ls = tileable();
      const layer = h('select', { class: 'inp', 'aria-label': t('Layer') }, ...ls.map((v) => h('option', { value: v.id }, v.name)));
      const active = app.prefs.get('vlayerActive');
      layer.value = ls.some((v) => v.id === active) ? active : ls[0].id;
      const to = h('select', { class: 'inp', 'aria-label': t('Format') }, h('option', { value: 'pmtiles' }, 'PMTiles v3'), h('option', { value: 'mbtiles' }, 'MBTiles 1.3')); // i18n-ignore: format names with versions (DN-62 rule 7)
      const zmin = h('input', { class: 'inp inp-num', type: 'number', min: 0, max: 20, value: 0, 'aria-label': t('Minimum zoom') });
      const zmax = h('input', { class: 'inp inp-num', type: 'number', min: 0, max: 20, value: 12, 'aria-label': t('Maximum zoom') });
      const tol = h('input', { class: 'inp inp-num', type: 'number', min: 0, max: 64, step: 0.5, value: 1, 'aria-label': t('Simplification') });
      const fieldsIn = h('input', { class: 'inp', type: 'text', placeholder: t('all fields'), 'aria-label': t('Fields to keep') });
      const body = h('div', {}, field(t('Layer'), layer), field(t('Format'), to), field(t('Zoom'), h('span', {}, zmin, ` ${tc('zoom range', 'to')} `, zmax)), field(t('Simplification (tile units of 4096)'), tol, t('Below the maximum zoom; the maximum keeps every vertex.')), field(t('Fields'), fieldsIn, t('Comma-separated names to keep; empty keeps all.')));
      if ((await modal({ title: t('Save As Vector Tiles (MVT)'), body, buttons: [{ label: t('Save'), value: 'save', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'tiles-mvt' })) !== 'save') return;
      const fields = fieldsIn.value.trim() ? fieldsIn.value.split(',').map((x) => x.trim()).filter(Boolean) : null;
      const r = await tileVector(layer.value, { to: to.value, minZoom: Number(zmin.value), maxZoom: Number(zmax.value), tolerance: Number(tol.value), fields });
      app.toast(t('{n, plural, one {# vector tile} other {# vector tiles}} written ({zooms})', { n: r.tiles, zooms: Object.entries(r.perZoom).map(([z, n]) => `z${z}: ${int(n)}`).join(', ') }), { kind: 'info' });
    }),
  });
}
