// Recipes dock (2.0 plan P6; REQ-PIP-01..04): one-click workflows run as a visible linear
// stepper. Each step shows its state, time and result; clicking a step opens its parameters in
// the drawer below, where a change re-runs from that step. Gate steps pause with the candidates
// on the map until the analyst has reviewed them (accept / reject in the queue, or 1 / 2 / 3)
// and presses Enter or Resume. Recipes are saved and opened as .gwrecipe.json files; four are
// built in. Since 2.7.1 (REQ-GAP-84) operations declare a parameter schema and typed inputs and
// outputs, so a workflow (gw-recipe/2) can wire one step's layer into the next; the node editor is
// the lazy js-workflow block (features/workflow.js). The user's recipes are kept in a library in
// IndexedDB with no cap, and workflows saved in the project travel in the .gwb.

import { h, clear } from '../shell/dom.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { walkFolder } from '../formats/sniff.js';
import { RecipeRunner, validateRecipe, defaults, checkParam, FORMAT } from '../recipes/recipe.js';
import { listLibrary, putLibrary, removeFromLibrary, migrateFromPrefs } from '../recipes/library.js';
import { t, N_, tr, msgOf, gwError } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';

export const name = 'recipes';

/** Built-in recipes (REQ-PIP-04). */
export const BUILTIN = [
  {
    format: FORMAT,
    id: 'airfield-triage',
    name: N_('Airfield triage'),
    description: N_('Auto contrast, find aircraft in view, review them, then a chip deck and a GeoJSON of the accepted ones.'),
    steps: [
      { op: 'contrast', title: N_('Auto contrast') },
      { op: 'find', title: N_('Find aircraft'), params: { objects: ['aircraft', 'helicopter'], threshold: 0.15 } },
      { op: 'gate', title: N_('Review the detections'), params: { message: N_('Accept or reject each aircraft (✓ / ✗ in the queue, or J then 2 / 1), then press Enter.') } },
      { op: 'chips', title: N_('Chip the accepted ones'), params: { status: 'accepted', max: 20 } },
      { op: 'exportDeck', title: N_('Export the chip deck') },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'damage-triage',
    name: N_('Damage triage'),
    description: N_('Align the post-event image to the pre-event one with learned matching, find damage, review it, export GeoJSON.'),
    steps: [
      { op: 'align', title: N_('Co-register (AI)') },
      { op: 'find', title: N_('Find damage'), params: { objects: ['collapsed building', 'flooded area', 'debris'], threshold: 0.12 } },
      { op: 'gate', title: N_('Review the candidates'), params: { message: N_('Use flicker (hold F) or swipe (S + drag) against the pre-event image; accept or reject each candidate, then press Enter.') } },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'accepted-detections' } },
    ],
  },
  {
    format: FORMAT,
    id: 'folder-to-cog',
    name: N_('Convert a folder to COG'),
    description: N_('Every raster in a folder becomes a Cloud-Optimized GeoTIFF; vectors become GeoParquet.'),
    steps: [{ op: 'convertFolder', title: N_('Convert the folder'), params: { vectors: 'geoparquet' } }],
  },
  {
    format: FORMAT,
    id: 'building-extraction',
    name: N_('Building extraction'),
    description: N_('Find buildings in view, outline each with SAM 2.1 and square its corners, review, export GeoJSON.'),
    steps: [
      { op: 'find', title: N_('Find buildings'), params: { objects: ['building'], threshold: 0.15 } },
      { op: 'outline', title: N_('Outline and square them'), params: { square: true, max: 60 } },
      { op: 'gate', title: N_('Review the outlines'), params: { message: N_('Delete wrong outlines (select, Del) or redraw them, then press Enter.') } },
      { op: 'exportGeojson', title: N_('Export GeoJSON'), params: { what: 'outlines' } },
    ],
  },
];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const pending = () => S.all('detection').filter((d) => d.status === 'pending');

  // ---- typed operations (REQ-GAP-84): a layer passes from step to step by its id ----
  const vlayerBy = (x) => S.all('vlayer').find((v) => v.id === x || v.name === x) ?? null;
  const rasterBy = (x) => [...app.layers.values()].find((l) => l.id === x || l.rec?.name === x) ?? null;
  /** The layer wired or given to input `k`, of the kind it needs. */
  const inputLayer = (ctx, k, kind) => {
    const x = ctx.inputs?.[k];
    if (x === undefined || x === null || x === '') throw gwError('input {input} has no layer: wire it to a step, or give it when the workflow runs', { input: k }, 'E_RECIPE_INPUT');
    const ok = kind === 'vector' ? vlayerBy(x) : rasterBy(x);
    if (!ok) throw gwError('input {input}: no {kind} layer {layer}', { input: k, kind: kind === 'vector' ? t('vector') : t('raster'), layer: String(x) }, 'E_RECIPE_INPUT');
    return ok.id;
  };
  const demOf = (ctx) => {
    const id = inputLayer(ctx, 'dem', 'raster');
    const d = app.terrain?.entry(id);
    if (!d) throw gwError('{layer} is not loaded as terrain: use it as terrain first', { layer: app.layers.get(id)?.rec?.name ?? id }, 'E_HYDRO_NO_DEM');
    return d;
  };
  const featureCount = (id) => S.all('feature').filter((f) => f.vlayer === id).length;
  const vSummary = (id) => t('{layer}: {n, plural, one {# feature} other {# features}}', { layer: S.get(id)?.name ?? id, n: featureCount(id) });
  const V_IN = [{ name: 'layer', type: 'layer:vector' }];
  const V_OUT = [{ name: 'out', type: 'layer:vector' }];
  const R_OUT = [{ name: 'out', type: 'layer:raster' }];
  const DEM_IN = [{ name: 'dem', type: 'layer:raster' }];
  const vector = (fn) => async (p, ctx) => {
    const id = await fn(p, ctx);
    return { summary: vSummary(id), outputs: { out: id } };
  };

  const TYPED = {
    // Source steps name a layer the user already has: they pass it on and make nothing (source: true).
    vectorLayer: { title: N_('Vector layer'), source: true, schema: { layer: { type: 'text', label: N_('Layer (name or id)'), default: '' } }, outputs: V_OUT, pythonHint: 'gw.layer(name)', run: ({ layer }) => {
      const v = vlayerBy(layer);
      if (!v) throw gwError('no vector layer {layer}', { layer: String(layer) }, 'E_RECIPE_INPUT');
      return { summary: vSummary(v.id), outputs: { out: v.id } };
    } },
    rasterLayer: { title: N_('Raster layer'), source: true, schema: { layer: { type: 'text', label: N_('Layer (name or id)'), default: '' } }, outputs: R_OUT, pythonHint: 'gw.layer(name)', run: ({ layer }) => {
      const l = rasterBy(layer);
      if (!l) throw gwError('no raster layer {layer}', { layer: String(layer) }, 'E_RECIPE_INPUT');
      return { summary: l.rec?.name ?? l.id, outputs: { out: l.id } };
    } },
    buffer: { title: N_('Buffer'), inputs: V_IN, outputs: V_OUT, pythonHint: 'gw.buffer(layer, distance)', schema: {
      distance: { type: 'number', label: N_('Distance'), unit: 'm', default: 100 },
      geodesic: { type: 'boolean', label: N_('Geodesic (WGS 84)'), default: true },
      cap: { type: 'enum', label: N_('Line ends'), values: ['round', 'flat', 'square'], default: 'round' },
      quadSegs: { type: 'integer', label: N_('Segments per quarter circle'), min: 1, max: 90, default: 8 },
      dissolve: { type: 'boolean', label: N_('Dissolve the result'), default: false },
    }, run: vector((p, ctx) => app.geoproc.buffer(inputLayer(ctx, 'layer', 'vector'), p)) },
    overlay: { title: N_('Overlay'), inputs: [{ name: 'a', type: 'layer:vector' }, { name: 'b', type: 'layer:vector' }], outputs: V_OUT, pythonHint: 'gw.overlay(a, b, op)', schema: {
      op: { type: 'enum', label: N_('Operation'), values: ['intersect', 'union', 'erase', 'symdiff'], default: 'intersect' },
    }, run: vector(({ op }, ctx) => app.geoproc.overlay(inputLayer(ctx, 'a', 'vector'), inputLayer(ctx, 'b', 'vector'), op)) },
    dissolve: { title: N_('Dissolve'), inputs: V_IN, outputs: V_OUT, pythonHint: 'gw.dissolve(layer, field)', schema: {
      field: { type: 'text', label: N_('Dissolve field'), default: '' },
    }, run: vector(({ field }, ctx) => app.geoproc.dissolve(inputLayer(ctx, 'layer', 'vector'), field || null)) },
    join: { title: N_('Spatial join'), inputs: [{ name: 'target', type: 'layer:vector' }, { name: 'join', type: 'layer:vector' }], outputs: V_OUT, pythonHint: 'gw.spatial_join(target, join, predicate)', schema: {
      predicate: { type: 'enum', label: N_('Relationship'), values: ['intersects', 'within', 'contains', 'nearest'], default: 'intersects' },
      field: { type: 'text', label: N_('Summarise field'), default: '' },
      maxDistance: { type: 'number', label: N_('Maximum distance'), unit: 'm', min: 0 },
    }, run: vector(({ predicate, field, maxDistance }, ctx) => app.geoproc.join(inputLayer(ctx, 'target', 'vector'), inputLayer(ctx, 'join', 'vector'), { predicate, field: field || null, maxDistance: Number.isFinite(maxDistance) ? maxDistance : null })) },
    fillSinks: { title: N_('Fill sinks'), inputs: DEM_IN, outputs: R_OUT, pythonHint: 'gw.fill_sinks(dem)', schema: {
      eps: { type: 'boolean', label: N_('Epsilon (a small slope across flats)'), default: true },
    }, run: async ({ eps }, ctx) => {
      const r = await app.hydrology.fill({ eps }, demOf(ctx));
      return { summary: t('{n, plural, one {# post raised} other {# posts raised}}', { n: r.raised }), outputs: { out: r.layer.id } };
    } },
    flowAccumulation: { title: N_('Flow accumulation'), inputs: DEM_IN, outputs: R_OUT, pythonHint: 'gw.flow_accumulation(dem, method)', schema: {
      method: { type: 'enum', label: N_('Method'), values: ['d8', 'dinf'], default: 'd8' },
    }, run: async ({ method }, ctx) => {
      const r = await app.hydrology.accumulation({ method }, demOf(ctx));
      return { summary: t('largest {n}', { n: int(r.max) }), outputs: { out: r.layer.id } };
    } },
    streams: { title: N_('Stream network'), inputs: DEM_IN, outputs: V_OUT, pythonHint: 'gw.streams(dem, min_area)', schema: {
      minArea: { type: 'number', label: N_('Smallest contributing area'), unit: 'm²', min: 1, default: 100000 },
    }, run: vector(async ({ minArea }, ctx) => (await app.hydrology.streams({ minArea }, demOf(ctx))).layer) },
    watershed: { title: N_('Watershed'), inputs: DEM_IN, outputs: V_OUT, pythonHint: 'gw.watershed(dem, lonlat, snap)', schema: {
      at: { type: 'lonlat', label: N_('Pour point (longitude, latitude)') },
      snap: { type: 'number', label: N_('Snap within'), unit: 'm', min: 0, default: 50 },
    }, run: vector(async ({ at, snap }, ctx) => {
      if (!at) throw gwError('give the pour point as longitude, latitude', null, 'E_HYDRO_POUR');
      return (await app.hydrology.watershed({ lon: at[0], lat: at[1], snap }, demOf(ctx))).layer;
    }) },
    // REG-016: endmembers of a multispectral or hyperspectral image (VCA), pinned for unmixing, with the pixel purity layer.
    endmembers: { title: N_('Endmembers'), inputs: [{ name: 'image', type: 'layer:raster' }], outputs: [{ name: 'ppi', type: 'layer:raster' }], pythonHint: 'gw.endmembers(image, m)', schema: {
      m: { type: 'integer', label: N_('Endmembers'), min: 2, max: 64, default: 5 },
      skewers: { type: 'integer', label: N_('Pixel purity skewers (0: none)'), min: 0, max: 100000, default: 1000 },
      seed: { type: 'integer', label: N_('Random seed'), min: 0, default: 1 },
    }, run: async ({ m, skewers, seed }, ctx) => {
      const r = await app.msi.endmembers(app.layers.get(inputLayer(ctx, 'image', 'raster')), { m, skewers, seed });
      return { summary: t('{n, plural, one {# endmember} other {# endmembers}}', { n: r.endmembers.length }), outputs: r.ppi ? { ppi: r.ppi.id } : {} };
    } },
    // REQ-GAP-87: a new layer of a catalogue's feature type (ISO 19110, INSPIRE, OSM presets or gw-catalog/1).
    newSchemaLayer: { title: N_('New layer from schema'), outputs: V_OUT, pythonHint: 'gw.new_schema_layer(catalog, type)', schema: {
      catalog: { type: 'text', label: N_('Feature catalogue (id)'), default: '' },
      type: { type: 'text', label: N_('Feature type (code)'), default: '' },
      subtype: { type: 'text', label: N_('Subtype (code)'), default: '' },
      name: { type: 'text', label: N_('Layer name'), default: '' },
    }, run: vector(({ catalog, type, subtype, name: nm }) => app.attribution.newSchemaLayer(type, { catalog: catalog || undefined, subtype: subtype || null, name: nm || null, activate: false })) },
    exportVector: { title: N_('Export a vector layer'), inputs: V_IN, pythonHint: 'gw.export(layer, format)', schema: {
      format: { type: 'enum', label: N_('Format'), values: ['geojson', 'gpkg', 'kml', 'csv', 'shp'], default: 'geojson' },
    }, run: async ({ format }, ctx) => {
      const id = inputLayer(ctx, 'layer', 'vector');
      if (format === 'gpkg') {
        const { bytes } = await app.attribution.gpkgBytes([id]);
        const stem = (S.get(id).name || 'layer').replace(/[^\w.-]+/g, '_');
        await saveBlob(app, new Blob([bytes], { type: 'application/geopackage+sqlite3' }), { name: `${stem}.gpkg`, types: ['.gpkg'], description: 'GeoPackage' });
      } else {
        const out = app.encodeLayer(id, format);
        await saveBlob(app, out.blob, { name: out.name, types: out.types, description: format.toUpperCase() });
      }
      return { summary: vSummary(id) };
    } },
  };

  /** The operations a step can run (REQ-PIP-02): params → {summary}. */
  const OPS = {
    contrast: { title: N_('Auto contrast'), pythonHint: 'gw.auto_contrast()', run: () => {
      const p = app.aiLocal.autoContrast();
      return { summary: t('CLAHE clip {clip}, gamma {gamma}', { clip: p.clip, gamma: p.gamma }) };
    } },
    find: { title: N_('Find objects'), schema: { objects: { type: 'texts', label: N_('Objects'), default: ['vehicle'] }, threshold: { type: 'number', label: N_('Threshold'), min: 0, max: 1, default: 0.15 } }, pythonHint: 'gw.find(objects, threshold)', run: async ({ objects, threshold }) => {
      const r = await app.aiLocal.find(objects, { threshold });
      return { summary: Object.entries(r.counts).map(([k, n]) => t('{n} {object}', { n, object: k })).join(', ') };
    } },
    search: { title: N_('Search imagery'), schema: { text: { type: 'text', label: N_('Text'), default: '' }, k: { type: 'integer', label: N_('Places'), min: 1, max: 100, default: 8 } }, run: async ({ text, k }) => {
      const r = await app.aiLocal.search(text, { k });
      return { summary: t('{n, plural, one {# place} other {# places}}, best {best}', { n: r.hits.length, best: Number.isFinite(r.hits[0]?.score) ? num(r.hits[0].score, 2) : '–' }) };
    } },
    align: { title: N_('Co-register (AI)'), pythonHint: 'gw.auto_align_ai()', run: async () => {
      const r = await app.autoAlignAI();
      return { summary: t('{n, plural, one {# tie point} other {# tie points}}, RMS {rms} px', { n: r.used, rms: num(r.rms, 2) }) };
    } },
    outline: { title: N_('Outline detections'), schema: { square: { type: 'boolean', label: N_('Square the corners'), default: true }, max: { type: 'integer', label: N_('At most'), min: 1, max: 1000, default: 60 } }, run: async ({ square, max }, ctx) => {
      const l = pane()?.geoLayer?.() ?? pane()?.activeLayer?.();
      if (!l) throw new Error('open an image first');
      const list = pending().filter((d) => d.anchor === 'image' && d.ring).slice(0, max);
      let n = 0;
      for (const d of list) {
        const cx = d.ring.reduce((s, q) => s + q[0], 0) / d.ring.length;
        const cy = d.ring.reduce((s, q) => s + q[1], 0) / d.ring.length;
        // Detections in one 1024 px tile share the tile's embedding: the encoder runs once per tile.
        const r = await app.sam.select(l, cx, cy, { square, size: 1024, at: { x0: Math.floor(cx / 1024) * 1024, y0: Math.floor(cy / 1024) * 1024 } });
        if (r.graphic) {
          S.transact(t('Recipe outline'), (tx) => tx.set(r.graphic, 'tag', 'recipe-outline'));
          n++;
        }
        ctx.runner.state[ctx.index].summary = `${n} / ${list.length}`;
        ctx.runner.emit('change');
      }
      return { summary: t('{n, plural, one {# outline} other {# outlines}}', { n }) };
    } },
    gate: { title: N_('Review'), gate: true, schema: { message: { type: 'text', label: N_('Message'), default: N_('Review, then press Enter.') } }, run: ({ message }, ctx) => {
      const n = pending().length;
      if (ctx?.headless) return { summary: n ? t('{n} to review', { n }) : t('waiting for you') };
      if (n) {
        app.activeMp()?.docks.show('detections');
        app.detections.zoomTo?.(pending()[0].id);
      }
      app.toast(t('Recipe paused: {message}', { message: tr(message) }), { kind: 'info', ms: 8000 });
      return { summary: n ? t('{n} to review', { n }) : t('waiting for you') };
    }, after: () => ({ summary: t('{a} accepted, {r} rejected', { a: S.all('detection').filter((d) => d.status === 'accepted').length, r: S.all('detection').filter((d) => d.status === 'rejected').length }) }) },
    chips: { title: N_('Chip detections'), schema: { status: { type: 'enum', label: N_('Detections'), values: ['accepted', 'pending', 'rejected'], default: 'accepted' }, max: { type: 'integer', label: N_('At most'), min: 1, max: 500, default: 20 } }, run: async ({ status, max }) => {
      const p = pane();
      const list = S.all('detection').filter((d) => d.status === status && d.anchor === 'image' && d.ring).slice(0, max);
      for (const d of list) {
        const xs = d.ring.map((q) => q[0]);
        const ys = d.ring.map((q) => q[1]);
        const pad = Math.max(32, 0.5 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)));
        p.setView({ cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 });
        const a = p.screenPoint(Math.min(...xs) - pad, Math.min(...ys) - pad);
        const b = p.screenPoint(Math.max(...xs) + pad, Math.max(...ys) + pad);
        await app.quickChip(p, { sx: Math.min(a.sx ?? a.x, b.sx ?? b.x), sy: Math.min(a.sy ?? a.y, b.sy ?? b.y) }, { sx: Math.max(a.sx ?? a.x, b.sx ?? b.x), sy: Math.max(a.sy ?? a.y, b.sy ?? b.y) });
      }
      return { summary: t('{n, plural, one {# chip} other {# chips}} in the session deck', { n: list.length }) };
    } },
    exportDeck: { title: N_('Export the deck'), run: async () => {
      if (!app.sessionDeck?.length) return { summary: t('nothing to export') };
      await C.run('deck.export');
      return { summary: t('{n, plural, one {# slide} other {# slides}}', { n: app.sessionDeck.length }) };
    } },
    exportGeojson: { title: N_('Export GeoJSON'), schema: { what: { type: 'enum', label: N_('What'), values: ['accepted-detections', 'outlines'], default: 'accepted-detections' } }, run: async ({ what }) => {
      if (what === 'outlines') {
        const gs = S.all('graphic').filter((g) => g.tag === 'recipe-outline' && g.anchor === 'ground');
        if (!gs.length) return { summary: t('no outlines') };
        const fc = { type: 'FeatureCollection', features: gs.map((g) => ({ type: 'Feature', properties: { source: g.provenance?.model ?? 'SAM', iou: g.provenance?.iou ?? null }, geometry: { type: 'Polygon', coordinates: [[...g.coords.map((c) => [c[0], c[1]]), [g.coords[0][0], g.coords[0][1]]]] } })) };
        await saveBlob(app, new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), { name: 'outlines.geojson', types: ['.geojson'], description: 'GeoJSON' });
        return { summary: t('{n, plural, one {# outline} other {# outlines}}', { n: gs.length }) };
      }
      const v = S.all('vlayer').find((x) => x.role === 'accepted-detections');
      if (!v) return { summary: t('no accepted detections') };
      const out = app.encodeLayer(v.id, 'geojson');
      await saveBlob(app, out.blob, { name: 'accepted-detections.geojson', types: out.types, description: 'GeoJSON' });
      return { summary: t('{n, plural, one {# feature} other {# features}}', { n: S.all('feature').filter((f) => f.vlayer === v.id).length }) };
    } },
    convertFolder: { title: N_('Convert a folder'), schema: { vectors: { type: 'enum', label: N_('Vectors to'), values: ['geoparquet', 'flatgeobuf', 'geojson'], default: 'geoparquet' } }, run: async ({ vectors, files: given }, ctx) => {
      let files = given;
      if (ctx?.headless && !files?.length) throw new Error('headless: give the files to convert (params.files, File objects)');
      if (files?.length) {
        await app.convertFiles(files, vectors);
        return { summary: t('{n, plural, one {# file} other {# files}}', { n: files.length }) };
      }
      if (window.showDirectoryPicker) files = await walkFolder(await window.showDirectoryPicker({ mode: 'read' }));
      else files = await pickFiles(app, { multiple: true, accept: [], description: t('Files to convert') });
      await app.convertFiles(files, vectors);
      return { summary: t('{n, plural, one {# file} other {# files}}', { n: files.length }) };
    } },
    ...TYPED,
    command: { title: N_('Run a command'), schema: { id: { type: 'text', label: N_('Command id'), default: '' } }, run: async ({ id, args }) => {
      await C.run(id, args);
      return { summary: id };
    } },
  };

  /** Each layer a step makes records the workflow, its version, the step and its parameters (REQ-GAP-84). */
  const provenance = (step, outputs, recipe) => {
    if (OPS[step.op]?.source) return;
    const ids = Object.values(outputs).filter((x) => typeof x === 'string' && (S.get(x)?.type === 'vlayer' || app.layers.get(x)));
    if (!ids.length) return;
    const rec = { id: recipe.id, version: recipe.version, step: step.id, op: step.op, params: JSON.parse(JSON.stringify(step.params)), at: new Date().toISOString() };
    S.transact(t('Workflow {name}: step {step}', { name: tr(recipe.name), step: step.id }), (tx) => ids.forEach((id) => tx.set(id, 'recipe', rec)));
  };
  const runner = new RecipeRunner(OPS, { app, provenance });

  // The user's recipes: the library in IndexedDB (no cap), read once and kept here for the picker.
  let library = [];
  const refreshLibrary = () =>
    listLibrary()
      .then((rs) => {
        library = rs;
        render();
      })
      .catch(() => {});
  const ready = migrateFromPrefs(app.prefs)
    .catch((e) => app.log('warn', `recipes: the settings' recipes stay there (${e.message})`))
    .then(refreshLibrary);
  /** Every recipe the picker offers: built in, saved in the project, then the library. */
  const known = () => {
    const ids = new Set(BUILTIN.map((r) => r.id));
    // Each id once: built in, then the project, then the library (the builder saves a built-in's copy under a new id).
    const proj = S.all('workflow').map((x) => x.recipe).filter((r) => r && !ids.has(r.id) && ids.add(r.id));
    const seen = new Set([...BUILTIN, ...proj].map((r) => r.id));
    // A library the settings could not move (no IndexedDB) still shows the settings' list.
    return [...BUILTIN, ...proj, ...library.filter((r) => !seen.has(r.id)), ...(app.prefs.get('recipes') ?? []).filter((r) => !seen.has(r.id) && !library.some((x) => x.id === r.id))];
  };
  /** Keep a recipe in the library; false when there is no IndexedDB. */
  async function keep(r) {
    try {
      await putLibrary(r);
      await refreshLibrary();
      return true;
    } catch (e) {
      app.log('warn', `recipes: not kept in the library (${e.message})`);
      return false;
    }
  }
  /** Remove a recipe from the library, and from the list the dock and API v2 read. */
  async function forget(id) {
    await removeFromLibrary(id);
    await refreshLibrary();
  }
  let panelEl = null;
  let selected = -1;

  const fmtMs = (ms) => (ms === null ? '' : ms < 1000 ? t('{ms} ms', { ms: int(ms) }) : t('{s} s', { s: num(ms / 1000, 1) }));
  // Step states as shown (the data-status attribute keeps the English value).
  const STATUS = { pending: N_('pending'), running: N_('running'), waiting: N_('waiting'), done: N_('done'), failed: N_('failed'), stale: N_('stale'), skipped: N_('skipped') };

  function drawer(i) {
    const step = runner.recipe.steps[i];
    const rows = Object.entries(step.params).map(([k, v]) => {
      const inp = h('input', { class: 'inp', value: Array.isArray(v) ? v.join(', ') : String(v), 'aria-label': k, 'data-id': `recipe:param:${k}` });
      inp.addEventListener('change', () => {
        const raw = inp.value.trim();
        const val = Array.isArray(v) ? raw.split(',').map((s) => s.trim()).filter(Boolean) : typeof v === 'number' ? Number(raw) : typeof v === 'boolean' ? raw === 'true' : raw;
        // The op's schema checks and coerces it ('-120' → -120); a refused value is marked, not kept.
        try {
          runner.setParam(i, k, val);
          inp.removeAttribute('aria-invalid');
        } catch (e) {
          inp.setAttribute('aria-invalid', 'true');
          app.toast(msgOf(e), { kind: 'warn' });
        }
      });
      return h('label', { class: 'rcp-param' }, h('span', {}, k), inp);
    });
    const rerun = h('button', { class: 'btn btn-small btn-primary', 'data-id': 'recipe:rerun', disabled: runner.running }, t('Re-run from here'));
    rerun.addEventListener('click', () => go(i));
    return h('div', { class: 'rcp-drawer', 'data-id': 'recipe:drawer' }, h('strong', {}, `${i + 1}. ${tr(step.title)}`), step.note ? h('p', { class: 'hint' }, tr(step.note)) : null, rows.length ? h('div', { class: 'rcp-params' }, rows) : h('p', { class: 'hint' }, t('This step has no parameters.')), runner.state[i].error ? h('p', { class: 'err' }, msgOf(runner.state[i].error)) : null, h('div', { class: 'btn-row' }, rerun));
  }

  function render() {
    if (!panelEl) return;
    clear(panelEl);
    const pick = h('select', { class: 'inp', 'data-id': 'recipe:pick', 'aria-label': t('Recipe') }, h('option', { value: '' }, t('Choose a recipe…')), ...known().map((r) => h('option', { value: r.id, selected: runner.recipe?.id === r.id }, tr(r.name))));
    pick.addEventListener('change', () => {
      const r = known().find((x) => x.id === pick.value);
      if (r) open(r);
    });
    const btn = (label, id, fn, dis = false) => {
      const b = h('button', { class: 'btn btn-small', 'data-id': `recipe:${id}`, disabled: dis }, label);
      b.addEventListener('click', fn);
      return b;
    };
    const bar = h('div', { class: 'btn-row rcp-bar' }, pick, btn(t('Run'), 'run', () => go(0), !runner.recipe || runner.running), btn(t('Resume'), 'resume', () => runner.resume(), !runner.waiting), btn(t('Stop'), 'stop', () => runner.stop(), !runner.running), btn(t('Open…'), 'open', importRecipe), btn(t('Save…'), 'save', exportRecipe, !runner.recipe), btn(t('Workflow Builder'), 'builder', () => C.run('pip.builder')));
    const r = runner.recipe;
    // The runner is shared with the Workflow Builder, which may have loaded a shorter workflow.
    if (!r || selected >= r.steps.length) selected = -1;
    const steps = r
      ? h(
          'ol',
          { class: 'rcp-steps', 'data-id': 'recipe:steps', role: 'list' },
          r.steps.map((s, i) => {
            const st = runner.state[i];
            const li = h('li', { class: ['rcp-step', `rcp-${st.status}`, i === selected ? 'sel' : null], tabindex: '0', 'data-step': String(i), 'data-status': st.status, title: tr(s.note || s.title) }, h('span', { class: 'rcp-n' }, String(i + 1)), h('span', { class: 'rcp-t' }, tr(s.title)), h('span', { class: 'rcp-s small muted' }, st.status === 'waiting' ? t('waiting for you · Enter') : [tr(STATUS[st.status] ?? st.status), st.summary, fmtMs(st.ms)].filter(Boolean).join(' · ')));
            li.addEventListener('click', () => {
              selected = selected === i ? -1 : i;
              render();
            });
            return li;
          }),
        )
      : h('p', { class: 'hint pad' }, t('A recipe runs a workflow step by step in front of you. Choose one, or open a .gwrecipe.json file.'));
    panelEl.append(h('div', { class: 'rcp' }, bar, r?.description ? h('p', { class: 'hint' }, tr(r.description)) : null, steps, r && selected >= 0 ? drawer(selected) : null));
  }
  runner.on('change', render);

  function open(r) {
    // Before load: load redraws, and the old selection may be past the new recipe's steps.
    selected = -1;
    runner.load(r);
    app.panels?.show?.('recipes', 'bottom') ?? app.activeMp()?.docks.show('recipes');
    return runner.recipe;
  }
  async function go(from) {
    const r = await runner.run(from);
    if (r.ok) app.toast(t('Recipe "{name}" finished.', { name: tr(runner.recipe.name) }), { kind: 'info' });
    else if (r.error) app.toast(t('Recipe step {n} failed: {msg}', { n: r.failed + 1, msg: msgOf({ message: r.error, i18n: r.i18n }) }), { kind: 'warn', ms: 9000 });
    return r;
  }
  async function importRecipe() {
    const [f] = await pickFiles(app, { accept: ['.json'], description: t('GIS Workbench recipe') });
    if (f) await importRecipeFile(f);
  }
  /** A .gwrecipe.json file (Open… or a drop): validated, kept with the user's recipes and opened. */
  async function importRecipeFile(f) {
    const r = validateRecipe(JSON.parse(await f.text()), OPS);
    if (!(await keep(r))) app.toast(t('The recipe is open, but this browser has no storage to keep it in your library.'), { kind: 'warn' });
    open(r);
  }
  async function exportRecipe() {
    const r = runner.toJSON();
    await saveBlob(app, new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }), { name: `${r.id}.gwrecipe.json`, types: ['.json'], description: t('GIS Workbench recipe') });
  }

  // Enter continues past a gate (not while typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !runner.waiting || e.target.closest?.('input, textarea, select, [contenteditable], .dlg')) return;
    e.preventDefault();
    runner.resume();
  });

  app.on('ready', (mp) => mp.docks.register({ id: 'recipes', title: t('Recipe'), icon: 'template', home: 'bottom', create: (a, m, el) => {
    panelEl = el;
    render();
    return { onShow: render };
  } }));
  C.implement('rcp.open', { run: () => app.panels?.toggle('recipes', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('recipes') });
  for (const r of BUILTIN) C.implement(`rcp.${r.id}`, { run: () => (open(r), go(0)) });
  C.implement('rcp.import', { run: importRecipe });
  // ---- headless runner (REQ-GAP-01): no dock, no dialogs, files returned ----
  let runN = 0;
  const fileOf = async (blob, name) => {
    const out = { name, type: blob.type || 'application/octet-stream', size: blob.size };
    if (/^(text\/|application\/(json|geo\+json|vnd\.google-earth\.kml\+xml))/.test(out.type) && blob.size < 8e6) out.text = await blob.text();
    else out.blob = blob;
    return out;
  };
  /** Run fn with saves captured into `files` (the previous capture is restored afterwards). */
  async function capturing(files, fn) {
    const prev = app.saveCapture;
    app.saveCapture = (blob, name) => files.push(fileOf(blob, name));
    try {
      return await fn();
    } finally {
      app.saveCapture = prev;
    }
  }
  /**
   * A headless run of a recipe: {id, start(from), resume(), status()}. gates: 'continue' passes
   * every gate, 'stop' waits at a gate until resume(), 'fail' ends the run at the first gate.
   * params: overrides {stepId: {param: value}} applied before the run. inputs: values for inputs
   * left unwired, {"stepId.input": value}.
   */
  function headless(src, { gates = 'continue', params = {}, inputs = {} } = {}) {
    const r = validateRecipe(src, OPS);
    for (const s of r.steps) if (params[s.id]) for (const [k, v] of Object.entries(params[s.id])) s.params[k] = checkParam(OPS[s.op].schema?.[k], v, { where: s.id, param: k });
    const id = `run-${++runN}`;
    const R = new RecipeRunner(OPS, { app, headless: true, provenance });
    R.load(r);
    const files = [];
    let state = 'idle';
    let result = null;
    let gateFailed = -1;
    let onWait = null;
    R.on('change', () => {
      const i = R.current;
      if (state !== 'running' || i < 0 || R.state[i]?.status !== 'waiting') return;
      // The runner sets its gate right after this event: act on the next microtask.
      queueMicrotask(() => {
        if (!R.waiting) return;
        if (gates === 'continue') R.resume();
        else if (gates === 'fail') {
          gateFailed = i;
          R.stop();
        } else {
          state = 'waiting';
          onWait?.();
        }
      });
    });
    let done = null;
    const until = () => new Promise((res) => (onWait = res));
    /** Run kick() (which starts or resumes the runner) with saves captured until the run ends or waits at a gate. */
    async function drive(kick) {
      // The capture is set before the runner starts: a step's first save can happen synchronously.
      await capturing(files, () => {
        kick();
        return Promise.race([done, until()]);
      });
    }
    const status = () => ({
      run: id,
      recipe: r.id,
      state,
      ok: state === 'done' && !!result?.ok,
      ...(result?.failed !== undefined ? { failed: result.failed, error: result.error } : {}),
      ...(gateFailed >= 0 ? { failed: gateFailed, error: `gate "${r.steps[gateFailed].title}" reached (gates: fail)` } : {}),
      steps: r.steps.map((s, i) => ({ id: s.id, op: s.op, status: R.state[i].status, ms: R.state[i].ms, summary: String(R.state[i].summary ?? '') })),
      files: files.filter((f) => !(f instanceof Promise)),
    });
    return {
      id,
      async start(from = 0) {
        // A fresh runner has no earlier outputs, so a wired step can only run after its upstream steps.
        if (from > 0 && r.steps.some((s) => Object.values(s.inputs ?? {}).some((w) => 'from' in w))) throw gwError('a workflow with wires runs headless from its first step (from 0)', {}, 'E_RECIPE_FROM');
        state = 'running';
        await drive(() => {
          done = R.run(from, { inputs }).then((res) => {
            result = res;
            state = gateFailed >= 0 ? 'stopped' : res.ok ? 'done' : res.error ? 'failed' : 'stopped';
          });
        });
        for (let i = 0; i < files.length; i++) files[i] = await files[i];
      },
      async resume() {
        if (state !== 'waiting') throw new Error(`the run is ${state}, not waiting at a gate`);
        state = 'running';
        await drive(() => R.resume());
        for (let i = 0; i < files.length; i++) files[i] = await files[i];
      },
      status,
    };
  }
  /** One operation headless → {summary, files}. */
  async function runOp(op, params = {}, inputs = {}) {
    const o = OPS[op];
    if (!o) throw new Error(`no recipe operation ${op}; call recipes.ops`);
    const files = [];
    const p = { ...defaults(o), ...params };
    for (const [k, v] of Object.entries(p)) p[k] = checkParam(o.schema?.[k], v, { where: op, param: k });
    const fake = { state: [{ summary: '' }], emit() {} };
    const r = await capturing(files, async () => {
      const x = (await o.run(p, { app, headless: true, step: { op, params: p }, index: 0, runner: fake, inputs })) ?? {};
      if (o.gate && o.after) return (await o.after(p, { app, headless: true })) ?? x;
      return x;
    });
    return { summary: String(r.summary ?? ''), files: await Promise.all(files) };
  }

  app.recipes = { runner, ops: OPS, builtin: BUILTIN, open, run: go, validate: (r) => validateRecipe(r, OPS), importFile: importRecipeFile, headless, runOp, keep, forget, known, library: () => ready.then(() => library), refreshLibrary };
}
