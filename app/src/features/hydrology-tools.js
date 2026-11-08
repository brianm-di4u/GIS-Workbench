// Hydrology on the terrain grid (REQ-GAP-80, SDP-2.7 §4.2; lazy js-hydrology block): sink fill,
// D8 or D-infinity flow accumulation, stream networks with Strahler and Shreve order, and
// watersheds from a pour point. The chain runs in an analysis worker in the `hydro` bundle, one
// stage per step with progress and a cancel between stages; grids above 48 million posts are
// refused before anything is copied (S-63).

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { fromParts } from '../vector/geom.js';
import { groundOf } from '../tools/tools.js';
import { decodeStreams, HYDRO_MAX_POSTS } from '../wasm/hydro.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { num, int, area, length } from '../i18n/format.js';

const STAGES = { fill: N_('filling sinks'), d8: N_('flow directions'), dinf: N_('D-infinity flow'), accumulate: N_('flow accumulation'), streams: N_('stream lines'), watershed: N_('watershed'), done: N_('finishing') };
const OK_CANCEL = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const core = app.core;
  const toast = (m, o) => app.toast(m, o);
  const entry = () => {
    const al = app.activePane()?.activeLayer();
    return (al && app.terrain.entry(al.id)) || app.terrain.dems[0] || null;
  };
  const heightsOf = (d) => d.current ?? d.grid.heights;
  const baseName = (d) => (app.layers.get(d.layerId)?.rec?.name ?? d.name ?? 'dem').replace(/\.[^.]+$/, '');
  /** Post spacing (m) east and north at the grid's middle latitude. */
  const spacing = (g) => {
    const lat = g.lat0 - (g.height * g.dlat) / 2;
    return [g.dlon * core.inverse(lat, 0, lat, 1).distance, g.dlat * core.inverse(lat - 0.5, 0, lat + 0.5, 0).distance];
  };
  const postLatLon = (g, k) => [g.lat0 - Math.floor(k / g.width) * g.dlat, g.lon0 + (k % g.width) * g.dlon];
  const postOf = (g, lat, lon) => {
    const i = Math.round((lon - g.lon0) / g.dlon);
    const j = Math.round((g.lat0 - lat) / g.dlat);
    return i < 0 || j < 0 || i >= g.width || j >= g.height ? -1 : j * g.width + i;
  };
  const geoTransform = (g) => [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat];

  /**
   * Run the chain on terrain `d` (the active one by default). opts as HydroBundle.run, with `pour`
   * as [{lat, lon}] and `snap` in metres. Returns {d, grid, dx, dy, r} where r is the worker's result.
   */
  async function run(opts = {}, d = entry()) {
    if (!d?.grid) throw gwError('hydrology needs an elevation model loaded as terrain', null, 'E_HYDRO_NO_DEM');
    const g = d.grid;
    const n = g.width * g.height;
    if (n > HYDRO_MAX_POSTS) throw gwError('hydrology: {n} posts is more than the 48 million posts it takes; crop or resample the elevation model first', { n: int(n) }, 'E_HYDRO_SIZE');
    const [dx, dy] = spacing(g);
    const pour = (opts.pour ?? []).map((p) => {
      const k = postOf(g, p.lat, p.lon);
      if (k < 0) throw gwError('hydrology: the pour point {lat}, {lon} is outside {dem}', { lat: num(p.lat, 6), lon: num(p.lon, 6), dem: d.name }, 'E_HYDRO_POUR');
      return k;
    });
    const snap = Math.round((opts.snap ?? 0) / Math.min(dx, dy));
    const z = Float32Array.from(heightsOf(d));
    const label = t('Hydrology on {dem}', { dem: d.name });
    let task = null;
    const r = await app.activity.track(
      label,
      (job) => {
        task = app.pool.run('hydro.run', { z, w: g.width, h: g.height, opts: { ...opts, dx, dy, pour, snap } }, { kind: 'analysis', transfer: [z.buffer], timeout: 1800000, label, part: true, onProgress: (p, partial) => job.set(p, partial?.phase ? t('Hydrology on {dem}: {stage}', { dem: d.name, stage: tr(STAGES[partial.phase] ?? partial.phase) }) : undefined) });
        return task;
      },
      { cancel: () => task?.cancel() },
    );
    app.hydrology.last = { dem: d.name, stats: r.stats, dx, dy };
    return { d, grid: g, dx, dy, r };
  }

  async function openRaster(g, data, type, fname, description, { terrainOf = null } = {}) {
    const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type, data }, { epsg: 4326, ...(terrainOf ? { vertical: terrainOf.vertical === 'hae' ? 'hae' : 'egm96' } : {}), geotransform: geoTransform(g), nodata: NaN, description });
    const { layers } = await openImageFile(app, new File([bytes], fname, { type: 'image/tiff' }));
    if (terrainOf) await app.useAsTerrain(layers[0], terrainOf.vertical === 'hae' ? 'hae' : 'egm96');
    return layers[0];
  }

  /** Sink fill (epsilon by default) as a new terrain layer. */
  async function fill({ eps = true } = {}, d = entry()) {
    const { grid, r } = await run({ eps, want: ['filled'] }, d);
    const layer = await openRaster(grid, r.filled, 'f32', `FILLED_${baseName(d)}.tif`, `GIS Workbench filled DEM (priority flood${eps ? ', epsilon' : ''}) from ${d.name}`, { terrainOf: d });
    return { layer, raised: r.stats.raised, posts: r.stats.posts };
  }

  /** Flow accumulation (upslope posts, D8 or D-infinity) as a new layer. */
  async function accumulation({ method = 'd8' } = {}, d = entry()) {
    const dinf = method === 'dinf';
    const { grid, r } = await run({ dinf, want: [dinf ? 'dinfAcc' : 'acc'] }, d);
    const acc = dinf ? r.dinfAcc : Float32Array.from(r.acc);
    const layer = await openRaster(grid, acc, 'f32', `FLOWACC_${dinf ? 'DINF' : 'D8'}_${baseName(d)}.tif`, `GIS Workbench flow accumulation (${dinf ? 'D-infinity' : 'D8'}, upslope posts) from ${d.name}`);
    return { layer, max: acc.reduce((a, b) => (b > a ? b : a), 0) };
  }

  /** Heights of a post for vector vertices (HAE, as the contour lines carry). */
  const haeAt = (d, k, lat, lon) => {
    const z = heightsOf(d)[k];
    if (!Number.isFinite(z)) return 0;
    return d.vertical === 'hae' ? z : z + core.undulation(lat, lon);
  };

  /** Stream network of contributing area ≥ `minArea` m², as a line layer with Strahler and Shreve order. */
  async function streams({ minArea = 1e5 } = {}, d = entry()) {
    const g0 = d?.grid;
    if (!g0) throw gwError('hydrology needs an elevation model loaded as terrain', null, 'E_HYDRO_NO_DEM');
    const [dx0, dy0] = spacing(g0);
    const thresh = Math.max(2, Math.ceil(minArea / (dx0 * dy0)));
    const { grid: g, dx, dy, r } = await run({ thresh }, d);
    const links = decodeStreams(r.streams);
    const diag = Math.hypot(dx, dy);
    let id;
    S.transact(t('Stream network'), (tx) => {
      id = tx.create('vlayer', { name: t('Streams ≥ {area} ({dem})', { area: area(minArea), dem: d.name }), visible: true, style: { stroke: '#3a8ee6', width: 1.5, fill: '#00000000' }, fields: [{ name: 'STRAHLER', type: 'integer' }, { name: 'SHREVE', type: 'integer' }, { name: 'LENGTH_M', type: 'real' }], source: { format: 'hydrology', dem: d.name, minArea, thresholdPosts: thresh }, created: new Date().toISOString() });
      for (const L of links) {
        let len = 0;
        const pts = [];
        for (let m = 0; m < L.posts.length; m++) {
          const k = L.posts[m];
          const [lat, lon] = postLatLon(g, k);
          pts.push([lon, lat, haeAt(d, k, lat, lon)]);
          if (m) {
            const a = L.posts[m - 1];
            const step = Math.abs((k % g.width) - (a % g.width)) + Math.abs(Math.floor(k / g.width) - Math.floor(a / g.width));
            len += step === 2 ? diag : (k % g.width) === (a % g.width) ? dy : dx;
          }
        }
        tx.create('feature', { vlayer: id, geom: fromParts('LineString', [pts]), attrs: { STRAHLER: L.strahler, SHREVE: L.shreve, LENGTH_M: Math.round(len * 10) / 10 }, style: { width: 0.8 + 0.7 * L.strahler }, name: t('Order {n}', { n: L.strahler }), prov: { kind: 'hydrology', dem: d.name } });
      }
    });
    const maxOrder = links.reduce((a, L) => Math.max(a, L.strahler), 0);
    return { layer: id, links: links.length, maxOrder, thresholdPosts: thresh, stats: r.stats };
  }

  /** The watershed draining to a pour point ({lat, lon}), snapped within `snap` m, as a polygon layer. */
  async function watershed({ lat, lon, snap = 50 } = {}, d = entry()) {
    const { grid: g, dx, dy, r } = await run({ pour: [{ lat, lon }], snap, want: ['labels'] }, d);
    const [plat, plon] = postLatLon(g, r.pour[0]);
    const rings = app.terrainAnalysis.rasterToPolygons(g, r.labels, 1);
    const posts = r.labels.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);
    const areaM2 = posts * dx * dy;
    let id;
    S.transact(t('Watershed'), (tx) => {
      id = tx.create('vlayer', { name: t('Watershed {lat}, {lon} ({dem})', { lat: num(plat, 5), lon: num(plon, 5), dem: d.name }), visible: true, style: { stroke: '#2a6fd0', width: 2, fill: '#2a6fd030', outline: '#2a6fd0' }, fields: [{ name: 'AREA_M2', type: 'real' }, { name: 'POSTS', type: 'integer' }, { name: 'OUTLET_LAT', type: 'real' }, { name: 'OUTLET_LON', type: 'real' }], source: { format: 'hydrology', dem: d.name, snap }, created: new Date().toISOString() });
      for (const ring of rings) tx.create('feature', { vlayer: id, geom: fromParts('Polygon', [ring.map(([x, y]) => [x, y, 0])]), attrs: { AREA_M2: Math.round(areaM2), POSTS: posts, OUTLET_LAT: plat, OUTLET_LON: plon }, name: t('Watershed'), prov: { kind: 'hydrology', dem: d.name } });
    });
    return { layer: id, posts, areaM2, outlet: { lat: plat, lon: plon }, accumulated: r.pourAcc[0], rings: rings.length, labels: r.labels, grid: g };
  }

  Object.assign(app.hydrology, { run, fill, accumulation, streams, watershed });

  // ---- commands ----
  const report = (e) => toast(msgOf(e), { kind: 'error', ms: 9000 });
  const numIn = (v, lab, extra = {}) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', min: '0', value: v, 'aria-label': lab, ...extra });
  const pickPoint = (cue) =>
    new Promise((res) => {
      app.tools.register({ id: 'hydro.pick', cue, onDown(p, e, sx, sy) {
        res(groundOf(app, p, sx, sy));
        app.tools.done();
        return true;
      } });
      app.tools.select('hydro.pick');
    });

  C.implement('hydro.fill', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const eps = h('input', { type: 'checkbox', checked: true, 'aria-label': t('Drain flats') });
      if ((await modal({ title: t('Fill Sinks'), body: h('div', {}, h('label', { class: 'fld fld-inline' }, eps, h('span', {}, t('Drain flats: raise filled posts by the smallest step so every post flows somewhere')))), buttons: OK_CANCEL(), id: 'hydro-fill' })) !== 'ok') return;
      try {
        const r = await fill({ eps: eps.checked });
        toast(t('Fill Sinks: {n, plural, one {# post} other {# posts}} raised of {total}', { n: r.raised, total: int(r.posts) }), { kind: 'info' });
      } catch (e) {
        report(e);
      }
    },
  });
  C.implement('hydro.flow', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const method = h('select', { class: 'inp', 'aria-label': t('Flow model') }, h('option', { value: 'd8' }, t('D8 (single direction)')), h('option', { value: 'dinf' }, t('D-infinity (shared between two posts)')));
      if ((await modal({ title: t('Flow Accumulation'), body: h('div', {}, field(t('Flow model'), method, t('The sinks are filled first. The result counts the posts upslope of each post.'))), buttons: OK_CANCEL(), id: 'hydro-flow' })) !== 'ok') return;
      try {
        const r = await accumulation({ method: method.value });
        toast(t('Flow Accumulation: up to {n} upslope posts', { n: int(r.max) }), { kind: 'info' });
      } catch (e) {
        report(e);
      }
    },
  });
  C.implement('hydro.streams', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const a = numIn('0.1', t('Minimum contributing area (km²)'));
      if ((await modal({ title: t('Stream Network'), body: h('div', {}, field(t('Minimum contributing area (km²)'), a, t('A post is on a stream when at least this much area drains through it. Links carry their Strahler order and Shreve magnitude.'))), buttons: OK_CANCEL(), id: 'hydro-streams' })) !== 'ok') return;
      try {
        const r = await streams({ minArea: Math.max(0, Number(a.value)) * 1e6 || 1e5 });
        toast(t('Stream Network: {n, plural, one {# link} other {# links}}, up to order {order}', { n: r.links, order: r.maxOrder }), { kind: 'info' });
      } catch (e) {
        report(e);
      }
    },
  });
  C.implement('hydro.watershed', {
    enabled: () => !!app.terrain.dems.length,
    run: async () => {
      const s = numIn('50', t('Snap distance (m)'));
      const buttons = [{ label: t('Pick Pour Point'), value: 'pick', primary: true }, { label: t('Cancel'), value: 'cancel' }];
      if ((await modal({ title: t('Watershed'), body: h('div', {}, field(t('Snap distance (m)'), s, t('The pour point moves to the post with the most flow within this distance, as a gauge on the channel should.'))), buttons, id: 'hydro-watershed' })) !== 'pick') return;
      const g = await pickPoint(t('Click the pour point (a gauge or outlet).'));
      if (!g) return;
      try {
        const r = await watershed({ lat: g.lat, lon: g.lon, snap: Math.max(0, Number(s.value) || 0) });
        toast(t('Watershed: {area} above {lat}, {lon} ({length} snap)', { area: area(r.areaM2), lat: num(r.outlet.lat, 5), lon: num(r.outlet.lon, 5), length: length(core.inverse(g.lat, g.lon, r.outlet.lat, r.outlet.lon).distance, 0) }), { kind: 'info', ms: 9000 });
      } catch (e) {
        report(e);
      }
    },
  });
}
