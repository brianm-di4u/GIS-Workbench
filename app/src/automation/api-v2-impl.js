// Automation API v2 (REQ-GAP-01): the method implementations of automation/v2-spec.js bound to
// the app (makeV2Impl). The API object, its argument checks and its events are
// automation/api-v2-core.js; automation/api-v2.js puts the two together. In the app this module
// is in the lazy js-apiv2 block and binds on the first call, so it takes the spec and apiError
// from the API object (api._spec) rather than importing them.
//
// Changes are store transactions (one undo step each, as if the analyst had done them). Files are
// returned in the result ({name, type, size, text | blob}) unless `save: true`; while a call runs,
// the saves of the tools it drives are captured instead of opening a dialog (storage/files.js
// saveCapture).
//
// Errors and results are developer API text (DN-62 rule 7): English.

import { readGeoJSON } from '../vector/io.js';
import { toGeoJSON, bbox } from '../vector/geom.js';
import { chainSummary } from '../render/chain.js';
import { t } from '../i18n/index.js';

const TEXT_TYPES = /^(text\/|application\/(json|geo\+json|vnd\.google-earth\.kml\+xml|xml))/;

/**
 * The v2 method implementations for an app, keyed like METHODS, for the API object `api`
 * (automation/api-v2-core.js makeV2Api; events.recent reads its ring). `override` replaces
 * implementations (tests). In the app this runs from the lazy js-apiv2 block on the first call.
 */
export function makeV2Impl(app, api, override = {}) {
  const ring = api._ring;
  const { METHODS, API_VERSION, parseSemver, mcpName, apiError } = api._spec;
  const S = app.store;
  const pane = () => app.activePane?.();
  const layerOf = (id) => {
    const l = id ? app.layers.get(id) : pane()?.geoLayer?.() ?? pane()?.activeLayer?.();
    if (!l) throw apiError(id ? `no image layer ${id}; call layers.list` : 'no image in the active panel', id ? 'E_NO_LAYER' : 'E_STEP_FIRST');
    return l;
  };
  const vlayerOf = (id) => {
    const v = S.get(id);
    if (!v || v.type !== 'vlayer') throw apiError(`no vector layer ${id}; call vectors.list`, 'E_NO_LAYER');
    return v;
  };
  const needPane = () => {
    const p = pane();
    if (!p) throw apiError('no active panel', 'E_STEP_FIRST');
    return p;
  };

  /** Run fn with the saves of the tools it drives captured (unless save is true) → {result, files}. */
  async function captured(save, fn) {
    if (save) return { result: await fn(), files: [] };
    const files = [];
    const prev = app.saveCapture;
    app.saveCapture = (blob, name) => files.push({ blob, name });
    try {
      return { result: await fn(), files: await Promise.all(files.map((f) => fileResult(f.blob, f.name))) };
    } finally {
      app.saveCapture = prev;
    }
  }
  async function fileResult(blob, name, extra = {}) {
    const type = blob.type || 'application/octet-stream';
    const out = { name, type, size: blob.size, ...extra };
    if (TEXT_TYPES.test(type) && blob.size < 8e6) out.text = await blob.text();
    else out.blob = blob;
    return out;
  }
  const viewInfo = (p = pane()) => {
    if (!p) return { pane: null, cx: 0, cy: 0, zoom: 0, rot: 0, ground: null };
    const { cx, cy, zoom, rot } = p.view;
    const g = p.geoLayer?.()?.groundAt?.(cx, cy);
    return { pane: p.id, cx, cy, zoom, rot, ground: g ? { lat: g.lat, lon: g.lon } : null };
  };
  const layerInfo = (l) => ({ id: l.id, name: l.rec?.name ?? '', kind: l.kind, width: l.width, height: l.height, bands: l.bands ?? 1, format: l.info?.format ?? null, model: l.modelName ?? null, pane: l.rec?.pane ?? null, active: app.activeLayer?.()?.id === l.id });
  const selectionItems = () => [...(app.selection ?? [])].map((id) => S.get(id)).filter(Boolean).map((r) => ({ id: r.id, type: r.type, ...(r.vlayer ? { layer: r.vlayer } : {}) }));
  const featureJson = (f) => ({ type: 'Feature', id: f.id, geometry: toGeoJSON(f.geom), properties: { ...(f.attrs ?? {}), ...(f.name ? { name: f.name } : {}) } });
  const CMP = { '=': (a, b) => String(a) === String(b), '≠': (a, b) => String(a) !== String(b), '<': (a, b) => Number(a) < Number(b), '>': (a, b) => Number(a) > Number(b), '≤': (a, b) => Number(a) <= Number(b), '≥': (a, b) => Number(a) >= Number(b), contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()) };
  const lonLat = (c, what) => {
    if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) throw apiError(`${what} must be [lon, lat]`, 'E_API_ARGS');
    return { lon: c[0], lat: c[1], h: Number.isFinite(c[2]) ? c[2] : null };
  };
  const findDem = (key) => app.terrain.dems.find((d) => d.name === key || d.layerId === key || d.id === key) ?? null;
  const recipeOps = () => {
    if (!app.recipes) throw apiError('recipes are not available in this build', 'E_UNAVAILABLE');
    return app.recipes;
  };
  const ai = () => {
    if (!app.aiLocal) throw apiError('local AI is not available in this build', 'E_UNAVAILABLE');
    return app.aiLocal;
  };

  const runs = new Map(); // headless recipe runs

  /** The implementations, keyed like METHODS. */
  const impl = {
    'api.version': () => ({ api: API_VERSION, ...parseSemver(API_VERSION), v1: 1, app: app.build?.version ?? null, build: app.build?.id ?? null }),
    'api.describe': ({ method } = {}) =>
      Object.entries(METHODS)
        .filter(([k]) => !method || k === method)
        .map(([k, m]) => ({ method: k, since: m.since, summary: m.summary, readOnly: !!m.readOnly, files: !!m.files, dialog: !!m.dialog, params: m.params, returns: m.returns, mcp: mcpName(k) })),
    'events.recent': ({ since = 0, types = null, limit = 200 } = {}) => ring.filter((e) => e.seq > since && (!types || types.includes(e.type))).slice(-limit),

    'layers.list': () => [...app.layers.values()].map(layerInfo),
    'layers.open': async ({ files }) => {
      const before = new Set(app.layers.keys());
      await app.openFiles(files, pane());
      return [...app.layers.keys()].filter((k) => !before.has(k));
    },
    'layers.activate': ({ layer }) => {
      const l = layerOf(layer);
      for (const mp of app.desktop?.multiports ?? []) {
        const p = mp.panes.find((x) => (x.rec?.layers ?? []).includes(l.id));
        if (!p) continue;
        mp.setActivePane?.(p);
        if (p.rec.activeLayer !== l.id) S.transact(t('Set active layer'), (tx) => tx.set(p.id, 'activeLayer', l.id), { kind: 'load' });
      }
      return layerInfo(l);
    },
    'vectors.list': () =>
      S.all('vlayer').map((v) => ({ id: v.id, name: v.name, features: S.all('feature').filter((f) => f.vlayer === v.id).length, fields: (v.fields ?? []).map((f) => ({ name: f.name, type: f.type, ...(f.title ? { title: f.title } : {}) })), schema: v.schema ? { catalog: v.schema.catalog, code: v.schema.code, name: v.schema.name, ...(v.schema.subtype ? { subtype: v.schema.subtype } : {}) } : null })),
    'vectors.features': ({ layer, field, op = '=', value, offset = 0, limit = 500 }) => {
      vlayerOf(layer);
      let fs = S.all('feature').filter((f) => f.vlayer === layer);
      if (field !== undefined && value !== undefined) fs = fs.filter((f) => CMP[op]?.(field === 'name' ? f.name : f.attrs?.[field], value));
      return { type: 'FeatureCollection', total: fs.length, features: fs.slice(offset, offset + limit).map(featureJson) };
    },
    'vectors.addGeoJson': ({ name = 'GeoJSON', geojson }) => {
      const { layer } = readGeoJSON(geojson, { name });
      const id = app.addVectorLayer(layer, { format: 'GeoJSON', file: name });
      return { layer: id, features: layer.features.length };
    },
    'vectors.export': async ({ layer, format, save = false }) => {
      vlayerOf(layer);
      const out = app.encodeLayer(layer, format);
      if (save) {
        const { saveBlob } = await import('../storage/files.js');
        await saveBlob(app, out.blob, { name: out.name, types: out.types, description: format.toUpperCase() });
        return { name: out.name, type: out.blob.type, size: out.blob.size, saved: 'dialog' };
      }
      return fileResult(out.blob, out.name);
    },

    'view.get': () => viewInfo(),
    'view.set': (v) => {
      const p = needPane();
      const nv = {};
      for (const k of ['cx', 'cy', 'zoom', 'rot']) if (Number.isFinite(v[k])) nv[k] = v[k];
      if (Object.keys(nv).length) p.setView(nv);
      return viewInfo(p);
    },
    'view.jumpTo': ({ text, lat, lon }) => {
      const p = needPane();
      if (text) {
        const r = app.core.parse(String(text));
        p.centreOnGround(r.lat, r.lon);
      } else if (Number.isFinite(lat) && Number.isFinite(lon)) p.centreOnGround(lat, lon);
      else throw apiError('give text, or lat and lon', 'E_API_ARGS');
      return viewInfo(p);
    },
    'view.zoomToLayer': ({ layer } = {}) => {
      const p = needPane();
      if (!layer) {
        p.fitWhole();
        return viewInfo(p);
      }
      if (app.layers.get(layer)) {
        app.zoomToLayer(layer);
        return viewInfo();
      }
      vlayerOf(layer);
      const fs = S.all('feature').filter((f) => f.vlayer === layer);
      if (!fs.length) throw apiError('the layer has no features', 'E_EMPTY');
      const bs = fs.map((f) => bbox(f.geom));
      const lon = (Math.min(...bs.map((b) => b[0])) + Math.max(...bs.map((b) => b[2]))) / 2;
      const lat = (Math.min(...bs.map((b) => b[1])) + Math.max(...bs.map((b) => b[3]))) / 2;
      p.centreOnGround(lat, lon);
      return viewInfo(p);
    },
    'selection.get': () => selectionItems(),
    'selection.set': ({ ids }) => {
      app.selection = new Set(ids.filter((id) => S.get(id)));
      app.emit('selection');
      for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.invalidate?.();
      return selectionItems();
    },
    'selection.byAttribute': ({ layer, field, op = '=', value }) => {
      vlayerOf(layer);
      const hit = S.all('feature').filter((f) => f.vlayer === layer && CMP[op]?.(field === 'name' ? f.name : f.attrs?.[field], value));
      const keep = [...(app.selection ?? [])].filter((id) => S.get(id)?.type !== 'feature');
      return impl['selection.set']({ ids: [...keep, ...hit.map((f) => f.id)] });
    },

    'geo.groundPoint': ({ x, y, layer }) => {
      const l = layerOf(layer);
      const g = l.groundWithTerrain(x, y);
      if (!g) throw apiError('the layer has no sensor model', 'E_NO_MODEL');
      return { lat: g.lat, lon: g.lon, h: g.h, heightSource: g.heightSource ?? null, mgrs: app.core.mgrs(g.lat, g.lon, 5) };
    },
    'geo.imagePoint': ({ lat, lon, h, layer }) => {
      const l = layerOf(layer);
      const hh = Number.isFinite(h) ? h : app.terrain.sample(lat, lon)?.hae ?? l.defaultHeight?.() ?? 0;
      const q = l.imageAt(lat, lon, hh);
      if (!q) throw apiError('the point does not project into the image', 'E_OFF_IMAGE');
      return { x: q.x, y: q.y, h: hh };
    },
    'geo.parse': ({ text }) => {
      const r = app.core.parse(String(text));
      return { lat: r.lat, lon: r.lon, format: r.format, ...(Number.isFinite(r.precisionM) ? { precisionM: r.precisionM } : {}) };
    },
    'geo.format': ({ lat, lon, format = 0, precision = 6 }) => app.core.format(lat, lon, format, precision),
    'measure.distance': ({ points }) => {
      const pts = points.map((c, i) => lonLat(c, `points[${i}]`));
      if (pts.length < 2) throw apiError('give at least two points', 'E_API_ARGS');
      const legs = [];
      for (let i = 1; i < pts.length; i++) {
        const r = app.core.inverse(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
        legs.push({ metres: r.distance, azimuth: (r.azi1 + 360) % 360 });
      }
      return { metres: legs.reduce((s, l) => s + l.metres, 0), legs };
    },
    'measure.area': ({ ring }) => {
      const pts = ring.map((c, i) => lonLat(c, `ring[${i}]`));
      if (pts.length < 3) throw apiError('a ring needs three points', 'E_API_ARGS');
      const r = app.core.polygonArea(pts.map((p) => [p.lat, p.lon]));
      return { squareMetres: Math.abs(r.area), perimeterMetres: r.perimeter };
    },
    'measure.lineOfSight': ({ from, to, observerH = 2, targetH = 0, samples = 256 }) => {
      if (!app.terrain.available) throw apiError('line of sight needs terrain (a DEM or DSM)', 'E_STEP_FIRST');
      const a = lonLat(from, 'from');
      const b = lonLat(to, 'to');
      const prof = app.measureLos.profile([a, b], samples);
      const r = app.measureLos.lineOfSight(prof, observerH, targetH);
      return { visible: r.visible, minClearance: r.minClearance, blocked: r.blocked ? { lat: r.blocked.lat, lon: r.blocked.lon, d: r.blocked.d } : null, lengthMetres: prof.total };
    },
    'measure.volume': ({ ring, reference = 'plane', height }) => app.measureVolume(ring.map((c) => [c[0], c[1]]), { reference, height: Number.isFinite(height) ? height : NaN, log: false }),

    'graphics.create': (a) => app.api.createGraphic(a),
    'graphics.list': ({ pane: pid } = {}) => S.all('graphic').filter((g) => !pid || g.pane === pid).map((g) => ({ id: g.id, shape: g.shape, anchor: g.anchor, text: g.text ?? '', pane: g.pane, coords: g.coords })),
    'graphics.delete': ({ ids }) => {
      const gs = ids.filter((id) => S.get(id)?.type === 'graphic');
      if (gs.length) S.transact(t('Automation: delete graphics'), (tx) => gs.forEach((id) => tx.delete(id)));
      for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.invalidate?.();
      return gs.length;
    },
    'image.setChain': (a) => app.api.setChain(a),
    'image.autoContrast': ({ layer } = {}) => {
      const p = ai().autoContrast(layerOf(layer));
      return { clip: p.clip, gamma: p.gamma };
    },
    'image.spectralIndex': ({ layer, index }) => {
      if (!app.msi) throw apiError('spectral tools are not available', 'E_UNAVAILABLE');
      const l = layerOf(layer);
      app.msi.setIndex(l, index);
      return chainSummary(l.chain);
    },
    'image.bandMath': ({ layer, expression, palette }) => {
      if (!app.msi) throw apiError('spectral tools are not available', 'E_UNAVAILABLE');
      const l = layerOf(layer);
      app.msi.setBandMath(l, expression, palette ? { palette } : {});
      return chainSummary(l.chain);
    },

    'analysis.viewshed': async ({ observers, show = false, ...o }) => {
      const ta = app.terrainAnalysis;
      if (!ta) throw apiError('terrain analysis is not available', 'E_UNAVAILABLE');
      const obs = observers.map((c, i) => lonLat(c, `observers[${i}]`));
      const r = await ta.viewshed(obs, o);
      let layer = null;
      if (show) layer = (await ta.openOverlay(r.grid, r.vis, { 0: [200, 40, 40], 1: [40, 200, 80] }, 'viewshed.tif'))?.id ?? null;
      return { ...r.stats, layer: layer ?? null };
    },
    'analysis.hlz': async ({ doctrine = 'light', centre, radius }) => {
      const ta = app.terrainAnalysis;
      if (!ta) throw apiError('terrain analysis is not available', 'E_UNAVAILABLE');
      const aoi = centre && radius ? { centre: lonLat(centre, 'centre'), radius } : null;
      const r = await ta.hlz({ doctrine, aoi });
      return { warnings: r.warnings ?? [], polygons: r.polygons?.length ?? 0, stats: r.stats ?? null };
    },
    'analysis.contours': ({ interval, indexEvery = 5 }) => app.contourLines(interval, { indexEvery }),
    'analysis.demDifference': ({ a, b, coregister = false }) => {
      const A = findDem(a);
      const B = findDem(b);
      if (!A || !B) throw apiError('both DEMs must be loaded as terrain (by name or layer id)', 'E_STEP_FIRST');
      return app.terrainAnalysis.demDifference(A, B, { coregister }).stats;
    },
    'analysis.autoAlign': async ({ kind = 'affine' } = {}) => {
      if (!app.autoAlign) throw apiError('registration is not available', 'E_UNAVAILABLE');
      return app.autoAlign({ kind });
    },

    'extract.createFeature': ({ type, coordinates, layer, square = false, attrs = null }) => {
      const p = needPane();
      if (layer) {
        vlayerOf(layer);
        app.prefs.set('vlayerActive', layer);
      }
      const pts = coordinates.map((c, i) => {
        const q = lonLat(c, `coordinates[${i}]`);
        return { ...q, h: q.h ?? app.terrain.sample(q.lat, q.lon)?.hae ?? 0, zsrc: q.h !== null ? 'given' : 'terrain' };
      });
      if (type === 'Polygon' && pts.length < 3) throw apiError('a polygon needs three points', 'E_API_ARGS');
      if (type === 'LineString' && pts.length < 2) throw apiError('a line needs two points', 'E_API_ARGS');
      const id = app.commitFeature(p, type, type === 'Point' ? pts.slice(0, 1) : pts, { square });
      const f = S.get(id);
      if (attrs && Object.keys(attrs).length) impl['extract.setAttributes']({ feature: id, attrs });
      const v = S.get(f.vlayer);
      const issues = (app.attribution?.attributeIssues(v.id) ?? []).filter((x) => x.featureId === id).map(({ field, message, code, rule }) => ({ field, message, code, ...(rule ? { rule } : {}) }));
      return { feature: id, layer: f.vlayer, issues };
    },
    'extract.setAttributes': ({ feature, attrs }) => {
      const f = S.get(feature);
      if (!f || f.type !== 'feature') throw apiError(`no feature ${feature}`, 'E_NO_FEATURE');
      const A = app.attribution;
      // Check every value first (domain, range, contingent domain), then set them in one step.
      let next = { ...f.attrs };
      for (const [k, v] of Object.entries(attrs)) {
        const e = A?.editIssue({ ...f, attrs: next }, k, v);
        if (e) throw Object.assign(new Error(e.message), { code: e.code ?? 'E_ATTR', field: k });
        const fd = S.get(f.vlayer)?.fields?.find((x) => x.name === k);
        next = { ...next, [k]: fd ? (fd.type === 'integer' ? Math.trunc(Number(v)) : fd.type === 'number' ? Number(v) : v) : v };
      }
      S.transact(t('Automation: attributes'), (tx) => tx.set(feature, 'attrs', next));
      return { feature, attrs: next };
    },
    'extract.validate': ({ layer }) => {
      vlayerOf(layer);
      return (app.attribution?.attributeIssues(layer) ?? []).map(({ featureId, field, message, code, rule }) => ({ featureId, field, message, code, ...(rule ? { rule } : {}) }));
    },
    'extract.newSchemaLayer': ({ code, catalog, subtype, name }) => app.attribution.newSchemaLayer(code, { ...(catalog ? { catalog } : {}), ...(subtype ? { subtype } : {}), ...(name ? { name } : {}) }),
    'catalogs.list': () => app.catalogs?.list() ?? [],
    'catalogs.get': ({ catalog, code }) => {
      const cat = app.attribution.catalog(catalog ?? undefined);
      if (!cat) throw apiError(`no catalogue ${catalog}`, 'E_NO_CATALOG');
      const ty = cat.types.find((x) => x.code === code);
      if (!ty) throw apiError(`${code} is not in ${cat.name}`, 'E_FEATURE_CLASS');
      return { ...ty, attributes: ty.attributes.map((n) => ({ name: n, ...cat.attributes[n] })), catalogRules: (cat.rules ?? []).filter((r) => !r.classes || r.classes.includes(code)) };
    },
    'catalogs.import': ({ catalog, keep = 'both' }) => app.catalogs.import(catalog, { keep }),
    'detections.list': ({ status, limit = 1000 } = {}) =>
      S.all('detection')
        .filter((d) => !status || d.status === status)
        .slice(0, limit)
        .map((d) => ({ id: d.id, n: d.n, cls: d.cls, confidence: d.confidence, status: d.status, anchor: d.anchor, ring: d.ring ?? null, point: d.point ?? null, layer: d.layer ?? null, source: d.source ?? '' })),
    'detections.add': ({ detections, layer, source = 'api' }) => {
      const l = layer ? layerOf(layer) : app.activeLayer?.();
      const list = detections.map((d, i) => {
        if (Array.isArray(d.box) && d.box.length === 4) {
          const [x0, y0, x1, y1] = d.box;
          return { cls: String(d.cls ?? 'object'), confidence: Number(d.confidence ?? 1), anchor: 'image', ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], props: d.props ?? {} };
        }
        if (Array.isArray(d.point)) return { cls: String(d.cls ?? 'object'), confidence: Number(d.confidence ?? 1), anchor: 'ground', point: d.point.slice(0, 2), props: d.props ?? {} };
        throw apiError(`detections[${i}] needs a box or a point`, 'E_API_ARGS');
      });
      return app.detections.add(list, { layer: l, source });
    },
    'detections.setStatus': ({ ids, status }) => {
      let n = 0;
      for (const id of ids) if (S.get(id)?.type === 'detection') (app.detections.setStatus(id, status), n++);
      return n;
    },
    'observations.add': (o) => app.observations.add(o)?.id ?? null,

    'ai.find': async ({ objects, threshold = 0.15, scope = 'view', layer, batch, commit = true }) => {
      const l = layer ? layerOf(layer) : undefined;
      if (scope === 'scene') return ai().findScene(objects, { layer: l, threshold, batch, commit });
      const r = await ai().find(objects, { layer: l, threshold, commit });
      return { count: r.count, counts: r.counts, tiles: r.tiles, batches: r.tiles, step: r.step, ms: r.ms, device: r.device, scope: 'view' };
    },
    'ai.search': async ({ text, k = 8, layer }) => {
      const r = await ai().search(text, { k, layer: layer ? layerOf(layer) : undefined });
      return { hits: r.hits, chips: r.chips, device: r.device };
    },
    'ai.segment': async ({ x, y, layer, square }) => {
      const l = layerOf(layer);
      const r = await app.sam.select(l, x, y, square === undefined ? {} : { square });
      return { polygon: r.polygon, iou: r.iou, area: r.area, graphic: r.graphic ?? null, model: r.model, device: r.device, encoderMs: r.encoderMs, decoderMs: r.decoderMs };
    },
    'ai.align': async ({ kind = 'affine' } = {}) => {
      if (!app.autoAlignAI) throw apiError('Auto Align (AI) is not available in this build', 'E_UNAVAILABLE');
      return app.autoAlignAI({ kind });
    },
    'ai.changeMask': (o = {}) => ai().changeMask(o),
    'ai.describe': (o = {}) => ai().describe({ ...o, layer: o.layer ? layerOf(o.layer) : undefined }),
    'ai.models.list': () => ai().modelList(),
    'ai.models.add': ({ descriptor, model }) => ai().addUserModel(descriptor, model),
    'ai.models.run': (o) => ai().runModel(o.model, { ...o, layer: o.layer ? layerOf(o.layer) : undefined }),

    'products.chip': async ({ width = 1024, height = 768, save = false } = {}) => {
      needPane();
      const c = await app.makeChip({ width, height });
      const r = c.record;
      const out = { caption: r.caption, image: r.image, cornersGround: r.cornersGround, metresPerPixel: r.metresPerPixel };
      const blob = await new Promise((res) => c.canvas.toBlob(res, 'image/png'));
      if (save) {
        const { saveBlob } = await import('../storage/files.js');
        await saveBlob(app, blob, { name: 'chip.png', types: ['.png'], description: 'PNG' });
      } else out.file = await fileResult(blob, 'chip.png');
      return out;
    },
    'products.report': async ({ format = 'html', title, save = false } = {}) => {
      const fields = title ? { ...(app.prefs.get('reportFields') ?? {}), title } : undefined;
      const blob = format === 'docx' ? await app.reportDocx(fields) : new Blob([app.buildReport(fields)], { type: 'text/html' });
      const name = `report.${format}`;
      if (save) {
        const { saveBlob } = await import('../storage/files.js');
        await saveBlob(app, blob, { name, types: [`.${format}`], description: format.toUpperCase() });
        return { name, type: blob.type, size: blob.size, saved: 'dialog' };
      }
      return fileResult(blob, name);
    },
    'products.cog': async ({ layer, save = false } = {}) => {
      const l = layerOf(layer);
      const { result, files } = await captured(save, () => app.convertToCog(l.id));
      return files[0] ? { ...files[0], summary: String(result ?? '') } : { name: '', type: 'image/tiff', size: 0, saved: 'dialog', summary: String(result ?? '') };
    },
    'products.deck': async ({ save = false } = {}) => {
      if (!app.sessionDeck?.length) throw apiError('the session deck is empty (make quick chips first)', 'E_EMPTY');
      const { files } = await captured(save, () => app.commands.run('deck.export'));
      return files[0] ?? { name: '', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 0, saved: 'dialog' };
    },

    'recipes.list': () => [...recipeOps().builtin.map((r) => ({ ...r, builtin: true })), ...(app.prefs.get('recipes') ?? []).map((r) => ({ ...r, builtin: false }))].map((r) => ({ id: r.id, name: String(r.name), steps: r.steps.length, builtin: r.builtin })),
    'recipes.ops': () => Object.entries(recipeOps().ops).map(([op, o]) => ({ op, title: String(o.title), defaults: o.defaults ?? {}, gate: !!o.gate })),
    'recipes.validate': ({ recipe }) => recipeOps().validate(recipe),
    'recipes.run': async ({ id, recipe, params = {}, gates = 'continue', from = 0 } = {}) => {
      const R = recipeOps();
      const src = recipe ?? [...R.builtin, ...(app.prefs.get('recipes') ?? [])].find((r) => r.id === id);
      if (!src) throw apiError(id ? `no recipe ${id}; call recipes.list` : 'give a recipe id or a recipe', 'E_NO_RECIPE');
      const run = R.headless(src, { gates, params });
      runs.set(run.id, run);
      while (runs.size > 20) runs.delete(runs.keys().next().value);
      await run.start(from);
      return run.status();
    },
    'recipes.resume': async ({ run }) => {
      const r = runs.get(run);
      if (!r) throw apiError(`no run ${run}`, 'E_NO_RUN');
      await r.resume();
      return r.status();
    },
    'recipes.status': ({ run }) => {
      const r = runs.get(run);
      if (!r) throw apiError(`no run ${run}`, 'E_NO_RUN');
      return r.status();
    },
    'recipes.op': async ({ op, params = {} }) => {
      const R = recipeOps();
      return R.runOp(op, params);
    },

    'commands.list': ({ filter = '' } = {}) => {
      const f = filter.toLowerCase();
      const C = app.commands;
      return C.list()
        .filter((c) => !f || c.id.toLowerCase().includes(f) || String(c.label).toLowerCase().includes(f))
        .map((c) => ({ id: c.id, label: String(c.label), enabled: C.enabled(c.id), checked: C.checked(c.id), implemented: !!c.implemented }));
    },
    'commands.run': async ({ id, args }) => {
      const C = app.commands;
      const c = C.get(id);
      if (!c) throw apiError(`no command ${id}`, 'E_NO_COMMAND');
      if (!c.implemented) throw apiError(`${c.label} is not implemented in this build`, 'E_UNAVAILABLE');
      if (!C.enabled(id)) throw apiError(`${c.label} is not available now`, 'E_STEP_FIRST');
      await C.run(id, args);
      return `ran ${id}`;
    },
    'jobs.list': ({ limit = 50 } = {}) => {
      const P = app.pool;
      const info = (j) => ({ id: j.id, op: j.op, kind: j.kind, label: String(j.label ?? j.op), state: j.state, progress: Number.isFinite(j.progress) ? j.progress : 0, ms: Number.isFinite(j.ms) ? Math.round(j.ms) : null, ...(j.error ? { error: j.error } : {}) });
      return [...[...P.jobs.values()].map(info), ...P.history.slice(0, limit).map(info)];
    },
    'jobs.cancel': ({ id }) => {
      if (!app.pool.jobs.has(id)) return false;
      app.pool.cancel(id);
      return true;
    },
    ...override,
  };
  return impl;
}
