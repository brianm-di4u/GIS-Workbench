// GIS tools for the registry (REQ-AI-08, REQ-WB-14, D30). Read tools describe the project;
// write tools only *propose* store changes. Coordinates, distances and errors in results
// always come from the Rust core, never from the model: the AI may name places it sees, but
// every number the tool returns is computed here.

import { chainSummary, STRETCHES, PALETTES } from '../render/chain.js';
import { menRow } from '../features/panels.js';
import { clone } from '../core/util.js';

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export function installGisTools(app, reg) {
  const core = app.core;
  const layerById = (id) => {
    const l = app.layers.get(id);
    if (!l) throw new Error(`no layer ${id}; call gw_list_layers`);
    return l;
  };

  reg.tool({
    name: 'gw_list_layers',
    title: 'List layers',
    description: 'List open image and terrain layers with their id, name, format, size, sensor model, marking and which panel shows them.',
    readOnly: true,
    inputSchema: obj({}),
    run: () =>
      [...app.layers.values()].map((l) => ({
        id: l.id,
        name: l.rec?.name,
        kind: l.kind,
        format: l.info.format,
        size: [l.width, l.height, l.bands],
        sampleType: l.sampleType,
        imageId: l.info.iid,
        acquired: l.info.datetime,
        model: l.modelName,
        marking: l.info.marking?.raw ?? null,
        pane: l.rec?.pane,
        active: app.activeLayer()?.id === l.id,
      })),
  });

  reg.tool({
    name: 'gw_get_view',
    title: 'Get the current view',
    description: 'Describe the active panel: image, centre (lat/lon and MGRS computed by the sensor model), zoom, rotation mode, ground scale and the image chain.',
    readOnly: true,
    inputSchema: obj({}),
    run: () => {
      const p = app.activePane();
      if (!p) return { pane: null };
      const l = p.geoLayer();
      const g = l?.modelId ? l.groundAt(p.view.cx, p.view.cy) : null;
      return {
        layer: l?.id ?? null,
        image: l?.info.iid ?? null,
        centre: g ? { lat: +g.lat.toFixed(7), lon: +g.lon.toFixed(7), hae: g.h, mgrs: core.mgrs(g.lat, g.lon, 5) } : null,
        zoom: p.view.zoom,
        rotationDeg: (p.view.rot * 180) / Math.PI,
        orientation: p.view.mode,
        metresPerScreenPixel: p.groundScale(),
        chain: l?.chain ? chainSummary(l.chain) : null,
        marking: p.marking()?.level ?? null,
      };
    },
  });

  reg.tool({
    name: 'gw_get_metadata',
    title: 'Get image metadata',
    description: 'Return the parsed header, subheader and TRE summary of a layer (no pixels). Use it to explain metadata or TREs.',
    readOnly: true,
    inputSchema: obj({ layer: { type: 'string', description: 'Layer id from gw_list_layers' } }, ['layer']),
    run: ({ layer }) => {
      const l = layerById(layer);
      const sh = l.info.subheader;
      return {
        format: l.info.format,
        fileHeader: l.info.header ? { ...l.info.header, segments: l.info.header.segments?.length } : null,
        subheader: sh ? { ...sh, bands: sh.bands?.map((b) => ({ IREPBAND: b.IREPBAND, ISUBCAT: b.ISUBCAT })), tres: sh.tres?.map((t) => ({ tag: t.tag, length: t.length, fields: Object.fromEntries((t.fields ?? []).slice(0, 60)) })) } : null,
        meta: l.info.meta ?? null,
      };
    },
  });

  reg.tool({
    name: 'gw_convert_coordinates',
    title: 'Convert coordinates',
    description: 'Parse a coordinate in any format (DD, DMS, DDM, MGRS, USNG, UTM/UPS, GARS, GEOREF) and return it in every format. The engine computes the results.',
    readOnly: true,
    inputSchema: obj({ text: { type: 'string' } }, ['text']),
    run: ({ text }) => {
      const r = core.parse(text);
      return { parsed: r, dd: core.format(r.lat, r.lon, 0, 7), dms: core.format(r.lat, r.lon, 1, 2), mgrs: core.format(r.lat, r.lon, 3, 5), utm: core.format(r.lat, r.lon, 4, 2), gars: core.format(r.lat, r.lon, 6, 2), georef: core.format(r.lat, r.lon, 7, 3) };
    },
  });

  reg.tool({
    name: 'gw_read_mensuration_log',
    title: 'Read the Mensuration Log',
    description: 'Return the Mensuration Log rows (values, units, method, CE90/LE90, coordinates). Quote these values; never invent measurements.',
    readOnly: true,
    inputSchema: obj({}),
    run: () => app.store.all('measurement').map(menRow),
  });

  reg.tool({
    name: 'gw_feedback_pages',
    title: 'Read feedback pages',
    description: 'Return the whiteboard feedback pages (type, summary, notes, pins, context) without images.',
    readOnly: true,
    inputSchema: obj({}),
    run: () => app.feedbackForAi?.() ?? { pages: [] },
  });

  reg.tool({
    name: 'gw_list_graphics',
    title: 'List graphics',
    description: 'List graphics (shape, text, ground coordinates) in all panels.',
    readOnly: true,
    inputSchema: obj({}),
    run: () => app.store.all('graphic').map((g) => ({ id: g.id, shape: g.shape, text: g.text, anchor: g.anchor, coords: g.coords, pane: g.pane, provenance: g.provenance?.kind })),
  });

  // ---- write tools (proposals) ----

  reg.tool({
    name: 'gw_create_graphic',
    title: 'Create a graphic',
    description: 'Propose a ground-anchored graphic in the active panel: point/marker/text/callout at one [lon, lat], line/arrow at two, polyline/polygon at several. The user must accept it.',
    readOnly: false,
    inputSchema: obj(
      {
        shape: { type: 'string', enum: ['point', 'marker', 'text', 'callout', 'line', 'arrow', 'polyline', 'polygon'] },
        coordinates: { type: 'array', description: 'Array of [lon, lat] pairs (WGS 84 degrees)' },
        text: { type: 'string' },
      },
      ['shape', 'coordinates'],
    ),
    propose: ({ shape, coordinates, text = '' }, tx) => {
      const pane = app.activePane();
      if (!pane) throw new Error('no active panel');
      if (!Array.isArray(coordinates) || !coordinates.length || coordinates.some((c) => !Array.isArray(c) || c.length < 2 || !c.every(Number.isFinite) || Math.abs(c[1]) > 90)) throw new Error('coordinates must be [lon, lat] pairs');
      const min = { line: 2, arrow: 2, callout: 2, polyline: 2, polygon: 3 }[shape] ?? 1;
      if (coordinates.length < min) throw new Error(`${shape} needs at least ${min} points`);
      const h = pane.geoLayer()?.defaultHeight() ?? 0;
      let gl = pane.rec.graphicsLayer;
      if (!gl) {
        gl = tx.create('glayer', { pane: pane.id, name: 'Graphics', visible: true });
        tx.set(pane.id, 'graphicsLayer', gl);
      }
      tx.create('graphic', { glayer: gl, pane: pane.id, shape, anchor: 'ground', coords: coordinates.map(([lon, lat]) => [lon, lat, h]), text, style: { stroke: '#e00000', width: 2, fill: '#e0000040' }, created: new Date().toISOString() });
      return { title: `Draw ${shape}${text ? ` "${text}"` : ''}`, preview: `${coordinates.length} point(s), first at ${core.format(coordinates[0][1], coordinates[0][0], 0, 6)}` };
    },
  });

  reg.tool({
    name: 'gw_set_chain',
    title: 'Change the image chain',
    description: `Propose image-chain settings for a layer: stretch (${STRETCHES.map((s) => s[0]).join(', ')}), DRA scope (full, viewport), brightness/contrast/gamma/saturation (-100..100), invert, palette (${PALETTES.join(', ')}), interpolation (nearest, bilinear, bicubic, lanczos3).`,
    readOnly: false,
    inputSchema: obj(
      {
        layer: { type: 'string' },
        stretch: { type: 'string', enum: STRETCHES.map((s) => s[0]) },
        draScope: { type: 'string', enum: ['full', 'viewport'] },
        brightness: { type: 'number', minimum: -100, maximum: 100 },
        contrast: { type: 'number', minimum: -100, maximum: 100 },
        gamma: { type: 'number', minimum: -100, maximum: 100 },
        saturation: { type: 'number', minimum: -100, maximum: 100 },
        invert: { type: 'boolean' },
        palette: { type: 'string', enum: PALETTES },
        interpolation: { type: 'string', enum: ['nearest', 'bilinear', 'bicubic', 'lanczos3'] },
      },
      ['layer'],
    ),
    propose: (a, tx) => {
      const l = layerById(a.layer);
      const c = clone(l.chain);
      if (a.stretch) c.stretch = a.stretch;
      if (a.draScope) c.dra.scope = a.draScope;
      for (const k of ['brightness', 'contrast', 'gamma']) if (a[k] !== undefined) c.tone[k] = a[k];
      if (a.invert !== undefined) c.tone.invert = a.invert;
      if (a.saturation !== undefined) c.colour.saturation = a.saturation;
      if (a.palette) c.colour.palette = a.palette;
      if (a.interpolation) c.kernel = a.interpolation;
      tx.set(l.id, 'chain', c);
      return { title: `Image chain for ${l.rec.name}`, preview: chainSummary(c) };
    },
  });

  reg.tool({
    name: 'gw_add_observation',
    title: 'Add an observation',
    description: 'Propose a draft observation (text the analyst can edit) about the current image, with a confidence term. It is labelled AI-drafted.',
    readOnly: false,
    inputSchema: obj({ text: { type: 'string' }, confidence: { type: 'string', enum: ['low', 'moderate', 'high'] } }, ['text']),
    propose: ({ text, confidence = 'moderate' }, tx) => {
      const l = app.activeLayer();
      tx.create('observation', { text, confidence, image: l?.info.iid ?? null, layer: l?.id ?? null, created: new Date().toISOString(), label: 'AI-drafted' });
      return { title: 'Add observation', preview: text.slice(0, 200) };
    },
  });

  // ---- navigation, features, mensuration and products (REQ-AI-08) ----

  reg.tool({
    name: 'gw_jump_to',
    title: 'Jump to a coordinate',
    description: 'Centre the active panel on a coordinate in any format (DD, DMS, DDM, MGRS, USNG, UTM, UPS, GARS, GEOREF). Changes only the view. Returns the parsed position.',
    readOnly: true,
    inputSchema: obj({ coordinate: { type: 'string' } }, ['coordinate']),
    run: async ({ coordinate }) => {
      const r = await app.jumpTo(coordinate);
      return { lat: r.lat, lon: r.lon, format: r.format, precisionM: r.precisionM ?? null, mgrs: core.mgrs(r.lat, r.lon, 5) };
    },
  });

  // ---- local AI models on this device (REQ-LAI-09): the assistant routes to these first ----

  reg.tool({
    name: 'gw_find_objects',
    title: 'Find objects (local AI)',
    description: 'Run the on-device open-vocabulary detector (OWLv2) over the active panel\'s view for the named objects. Results go to the detections review queue as pending, where the analyst accepts or rejects them. Returns counts per object and the boxes (image pixels) with scores. Needs the ai-detect pack.',
    readOnly: true,
    inputSchema: obj({ objects: { type: 'array', items: { type: 'string' } }, threshold: { type: 'number', minimum: 0.05, maximum: 0.9 } }, ['objects']),
    run: async ({ objects, threshold }) => {
      const r = await app.aiLocal.find(objects, { threshold: threshold ?? 0.15 });
      return { counts: r.counts, tiles: r.tiles, device: r.device, detections: r.detections.slice(0, 50).map((d) => ({ object: d.cls, score: d.confidence, box: [d.ring[0][0], d.ring[0][1], d.ring[2][0], d.ring[2][1]].map(Math.round) })) };
    },
  });
  reg.tool({
    name: 'gw_search_imagery',
    title: 'Search imagery (local AI)',
    description: 'Semantic search of the active image with on-device CLIP embeddings: outlines and centres the places that look most like the text. Scores are similarities, not probabilities. Needs the ai-search pack.',
    readOnly: true,
    inputSchema: obj({ text: { type: 'string' }, k: { type: 'integer', minimum: 1, maximum: 20 } }, ['text']),
    run: async ({ text, k }) => {
      const r = await app.aiLocal.search(text, { k: k ?? 8 });
      return { chips: r.chips, device: r.device, hits: r.hits.map((x) => ({ box: [x.x0, x.y0, x.x0 + x.size, x.y0 + x.size], score: x.score })) };
    },
  });

  const featuresOf = (layer) => app.store.all('feature').filter((f) => !layer || f.vlayer === layer);
  reg.tool({
    name: 'gw_query_features',
    title: 'Query features',
    description: 'List features (vector layers) with an optional attribute test (field, op one of = != < > contains) and a lon/lat box [west, south, east, north]. Returns id, layer, type, name, attributes and centroid.',
    readOnly: true,
    inputSchema: obj({ layer: { type: 'string' }, field: { type: 'string' }, op: { type: 'string', enum: ['=', '!=', '<', '>', 'contains'] }, value: { type: 'string' }, bbox: { type: 'array' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
    run: ({ layer, field, op = '=', value, bbox, limit = 100 }) => {
      const test = { '=': (a, b) => String(a) === String(b), '!=': (a, b) => String(a) !== String(b), '<': (a, b) => Number(a) < Number(b), '>': (a, b) => Number(a) > Number(b), contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()) }[op];
      const out = [];
      for (const f of featuresOf(layer)) {
        if (field && !test(field === 'name' ? f.name : f.attrs?.[field], value)) continue;
        const xs = f.geom.xyz.filter((_, i) => i % 3 === 0);
        const ys = f.geom.xyz.filter((_, i) => i % 3 === 1);
        const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
        if (bbox?.length === 4 && (c[0] < bbox[0] || c[1] < bbox[1] || c[0] > bbox[2] || c[1] > bbox[3])) continue;
        out.push({ id: f.id, layer: f.vlayer, type: f.geom.type, name: f.name, attrs: f.attrs, centroid: { lon: c[0], lat: c[1] }, vertices: f.geom.xyz.length / 3 });
        if (out.length >= limit) break;
      }
      return { count: out.length, features: out };
    },
  });

  reg.tool({
    name: 'gw_create_feature',
    title: 'Create a feature',
    description: 'Propose a feature in a vector layer (the active one by default): Point, LineString or Polygon from [lon, lat] or [lon, lat, h] (h = metres above the ellipsoid; the terrain height is used when h is missing). The user must accept it.',
    readOnly: false,
    inputSchema: obj({ layer: { type: 'string' }, type: { type: 'string', enum: ['Point', 'LineString', 'Polygon'] }, coordinates: { type: 'array' }, name: { type: 'string' }, attrs: { type: 'object' } }, ['type', 'coordinates']),
    propose: ({ layer, type, coordinates, name = null, attrs = {} }, tx) => {
      if (!Array.isArray(coordinates) || coordinates.some((c) => !Array.isArray(c) || c.length < 2 || !c.slice(0, 2).every(Number.isFinite) || Math.abs(c[1]) > 90)) throw new Error('coordinates must be [lon, lat] or [lon, lat, h]');
      const min = { Point: 1, LineString: 2, Polygon: 3 }[type];
      if (coordinates.length < min) throw new Error(`${type} needs at least ${min} points`);
      const hOf = (lon, lat) => app.terrain?.sample?.(lat, lon)?.hae ?? app.activePane()?.geoLayer()?.defaultHeight() ?? 0;
      const xyz = coordinates.flatMap(([lon, lat, h]) => [lon, lat, Number.isFinite(h) ? h : hOf(lon, lat)]);
      let vl = layer ?? app.prefs.get('vlayerActive') ?? app.store.all('vlayer')[0]?.id;
      if (!vl || !app.store.has(vl)) vl = tx.create('vlayer', { name: 'Features', visible: true, style: { stroke: '#ff2020', width: 2, fill: '#ff202040', outline: '#2060ff' }, fields: [], source: { format: 'new' } });
      const n = type === 'Point' ? 1 : coordinates.length;
      tx.create('feature', { vlayer: vl, ufi: crypto.randomUUID?.() ?? String(Date.now()), geom: { type, xyz: xyz.slice(0, 3 * n), parts: [0], polys: type === 'Polygon' ? [0] : [] }, attrs, name, description: null, prov: { kind: 'ai' } });
      return { title: `Create ${type}${name ? ` "${name}"` : ''}`, preview: `${n} vertex(es), first at ${core.format(xyz[1], xyz[0], 0, 6)}` };
    },
  });

  reg.tool({
    name: 'gw_square_feature',
    title: 'Square a building',
    description: 'Propose squaring a polygon feature to right angles (dominant-direction fit in a local metric frame). Returns the corner error the core computes.',
    readOnly: false,
    inputSchema: obj({ feature: { type: 'string' } }, ['feature']),
    propose: ({ feature }, tx) => {
      const f = app.store.get(feature);
      if (f?.type !== 'feature' || f.geom.type !== 'Polygon') throw new Error('feature must be the id of a Polygon feature (gw_query_features)');
      const n = f.geom.parts[1] ?? f.geom.xyz.length / 3;
      const ring = Array.from({ length: n }, (_, i) => [f.geom.xyz[3 * i], f.geom.xyz[3 * i + 1], f.geom.xyz[3 * i + 2]]);
      const r = core.squareRing(ring);
      tx.set(f.id, 'geom', { ...f.geom, xyz: r.ring.flat(), parts: [0], polys: [0] });
      return { title: `Square ${f.name || 'polygon'}`, preview: `${r.method}: corners 90° ± ${r.maxCornerErrorDeg.toExponential(1)}°` };
    },
  });

  reg.tool({
    name: 'gw_measure',
    title: 'Measure',
    description: 'Compute a geodesic distance and azimuths (two or more [lon, lat] points, along the path) or an ellipsoidal area and perimeter (three or more). Every number comes from the core (GeographicLib method); nothing is written to the Mensuration Log.',
    readOnly: true,
    inputSchema: obj({ kind: { type: 'string', enum: ['distance', 'area'] }, coordinates: { type: 'array' } }, ['kind', 'coordinates']),
    run: ({ kind, coordinates }) => {
      if (!Array.isArray(coordinates) || coordinates.some((c) => !Array.isArray(c) || !c.slice(0, 2).every(Number.isFinite))) throw new Error('coordinates must be [lon, lat] pairs');
      if (kind === 'area') {
        if (coordinates.length < 3) throw new Error('an area needs three points');
        const r = core.polygonArea(coordinates.map(([lon, lat]) => [lat, lon]));
        return { areaM2: Math.abs(r.area), perimeterM: r.perimeter, method: 'geodesic polygon on WGS 84 (Karney 2013)' };
      }
      if (coordinates.length < 2) throw new Error('a distance needs two points');
      const legs = coordinates.slice(1).map((c, i) => core.inverse(coordinates[i][1], coordinates[i][0], c[1], c[0]));
      return { distanceM: legs.reduce((s, l) => s + l.distance, 0), legs: legs.map((l) => ({ distanceM: l.distance, azimuthDeg: (l.azi1 + 360) % 360 })), method: 'geodesics on WGS 84 (Karney 2013)' };
    },
  });

  reg.tool({
    name: 'gw_make_chip',
    title: 'Make a chip',
    description: 'Render a chip of the active panel (banners, caption, north arrow, scale bar) and return its record: caption, image, ground corners, metres per pixel, scale bar and marking. Nothing is saved; the analyst saves products.',
    readOnly: true,
    inputSchema: obj({ width: { type: 'integer', minimum: 128, maximum: 4096 }, height: { type: 'integer', minimum: 128, maximum: 4096 } }),
    run: async ({ width = 1024, height = 768 }) => {
      const c = await app.makeChip({ width, height });
      const r = c.record;
      return { caption: r.caption, image: r.image, cornersGround: r.cornersGround, metresPerPixel: r.metresPerPixel, scaleBar: r.scaleBar, centreMgrs: r.centreMgrs, marking: r.marking };
    },
  });

  reg.tool({
    name: 'gw_report_outline',
    title: 'Report outline',
    description: 'Return the exploitation report outline the tool would build now: banner (rolled up from every portion), section titles and the counts of images, observations, measurements and chips.',
    readOnly: true,
    inputSchema: obj({}),
    run: () => {
      const html = app.buildReport?.() ?? '';
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { banner: doc.querySelector('.banner')?.textContent ?? null, sections: [...doc.querySelectorAll('h2')].map((x) => x.textContent), images: app.layers.size, observations: app.store.all('observation').length, measurements: app.store.all('measurement').length, chips: app.store.all('chip').length };
    },
  });

  reg.resource({ uri: 'gw://project/summary', name: 'Project summary', mimeType: 'application/json', read: () => ({ project: app.project()?.name, layers: app.layers.size, graphics: app.store.all('graphic').length, measurements: app.store.all('measurement').length }) });
  reg.resource({ uri: 'gw://feedback/pages', name: 'Feedback pages', mimeType: 'application/json', read: () => app.feedbackForAi?.() });
  reg.prompt({ name: 'first_phase_report', description: 'Draft a first-phase report outline from the current view and Mensuration Log', arguments: [] });
}
