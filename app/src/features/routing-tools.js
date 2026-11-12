// Geocoding and routing on the user's own data (REQ-GAP-85, SDP-2.7 §4.12; Full; the lazy
// js-routing block). No online service: an address index is built from an address layer the user
// names (points with a number and street, or street lines with number ranges), and a road graph
// from a line layer with its one-way and speed fields. On them: Find Address (also from the
// coordinate box), batch geocoding of a CSV with match scores, reverse geocoding, shortest routes
// and service areas. The index can be saved as a GeoPackage with an FTS4 table and opened again,
// so a large area can be split into one GeoPackage per district. The search runs in the `vector`
// WASM bundle in the analysis worker.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { parseDelimited } from './workspace-tools.js';
import { groundOf } from '../tools/tools.js';
import { parts, fromParts } from '../vector/geom.js';
import { inferFields } from '../vector/io.js';
import { loadSqlite, writeGpkg, readGpkg } from '../vector/gpkg.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { int, length as fmtLength } from '../i18n/format.js';
import { buildIndex, search, reverse, normalise } from '../analysis/geocode.js';
import { buildGraph, graphData, nearestNode, routeLine, serviceLines } from '../analysis/network.js';

/**
 * Limits (S-67, measured on 2026-11-10): an address costs about 390 bytes of memory with its layer
 * data (200,000 index in 0.3 s; an exact search 0.01 ms, a misspelt one 2 ms), so a million is
 * about 400 MB. A road network of 404,000 pieces builds in 0.8 s and passes 19 MB to the bundle;
 * a route across it takes 0.1 s. A million pieces keeps the graph's coordinates and the search
 * under about 400 MB too. Beyond these, split the data by area.
 */
export const MAX_ADDRESSES = 1_000_000;
export const MAX_EDGES = 1_000_000;
/** How far a picked point may be from the nearest network node. */
const SNAP_M = 500;
// A number field: blank, null and text are no number (NaN), not 0.
const numberOf = (v) => (v === null || v === undefined || String(v).trim() === '' ? NaN : Number(v));

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const toast = (m, o) => app.toast(m, o);
  const pane = () => app.activePane();
  const net = app.routing;
  const run = (fn) => async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      toast(msgOf(e), { kind: /^E_NEED_/.test(e.code ?? '') ? 'warn' : 'error' });
      return undefined;
    }
  };
  const vlayers = (kind) => S.all('vlayer').filter((v) => S.all('feature').some((f) => f.vlayer === v.id && (!kind || kind.test(f.geom?.type ?? ''))));
  const fieldsOf = (id) => {
    const fs = S.all('feature').filter((f) => f.vlayer === id);
    return ['name', ...new Set([...(S.get(id)?.fields ?? []).map((x) => x.name), ...inferFields(fs).map((x) => x.name)])];
  };
  const valueOf = (f, k) => (!k ? undefined : k === 'name' ? f.name : f.attrs?.[k]);
  const guess = (fields, re) => fields.find((f) => re.test(f)) ?? '';
  const fieldSel = (fields, value, label, none = true) => h('select', { class: 'inp', 'aria-label': label }, ...(none ? [h('option', { value: '' }, t('(none)'))] : []), ...fields.map((f) => h('option', { value: f, selected: f === value }, f)));
  const layerSel = (layers, label) => h('select', { class: 'inp', 'aria-label': label }, ...layers.map((v) => h('option', { value: v.id }, v.name)));

  // ---- address index ----

  /**
   * Index the address layer `layer` (id) with the field mapping: points need `number` and
   * `street`; lines need `street` and the ranges `leftFrom`, `leftTo`, `rightFrom`, `rightTo`.
   * `place` is optional for both.
   */
  function indexLayer(layer, map) {
    const fs = S.all('feature').filter((f) => f.vlayer === layer);
    if (fs.length > MAX_ADDRESSES) throw gwError('{n} addresses are more than one index holds ({max}): split the layer by area, and save each part as an address GeoPackage', { n: int(fs.length), max: int(MAX_ADDRESSES) }, 'E_NEED_SPLIT');
    const points = [];
    const ranges = [];
    for (const f of fs) {
      const g = f.geom;
      if (!g) continue;
      const street = valueOf(f, map.street);
      const place = valueOf(f, map.place);
      if (/Point/.test(g.type)) points.push({ id: f.id, number: valueOf(f, map.number), street, place, at: [g.xyz[0], g.xyz[1]] });
      else if (/LineString/.test(g.type)) {
        const num = (k) => numberOf(valueOf(f, map[k]));
        for (const p of parts(g)) ranges.push({ id: f.id, street, place, line: p.map((v) => [v[0], v[1]]), left: [num('leftFrom'), num('leftTo')], right: [num('rightFrom'), num('rightTo')] });
      }
    }
    const ix = buildIndex({ points, ranges });
    if (!ix.streets.size) throw gwError('No addresses in {layer}: map the street field (and the number, or the number ranges)', { layer: S.get(layer)?.name ?? '' }, 'E_NEED_ADDRESSES');
    net.geocoder = { index: ix, name: S.get(layer)?.name ?? '', layer, map, points, ranges };
    return { streets: ix.streets.size, addresses: ix.count };
  }

  /** The index as a GeoPackage: the addresses as a point or line layer, an FTS4 table of their normalised streets, and the mapping. */
  async function saveIndex() {
    const g = need();
    const SQL = await loadSqlite(app.gw);
    const features = [
      ...g.points.map((p) => ({ geom: fromParts('Point', [[[p.at[0], p.at[1], 0]]]), attrs: { number: p.number ?? '', street: p.street ?? '', place: p.place ?? '' } })),
      ...g.ranges.map((r) => ({ geom: fromParts('LineString', [r.line.map((v) => [v[0], v[1], 0])]), attrs: { street: r.street ?? '', place: r.place ?? '', left_from: r.left[0], left_to: r.left[1], right_from: r.right[0], right_to: r.right[1] } })),
    ];
    const { bytes } = writeGpkg(SQL, [{ name: 'addresses', fields: inferFields(features), features }], { title: t('Address index: {name}', { name: g.name }) });
    const db = new SQL.Database(bytes);
    try {
      db.exec('CREATE VIRTUAL TABLE gw_geocode USING fts4(street, place, fid); CREATE TABLE gw_geocode_meta (key TEXT PRIMARY KEY, value TEXT);');
      const ins = db.prepare('INSERT INTO gw_geocode (street, place, fid) VALUES (?, ?, ?)');
      features.forEach((f, i) => ins.run([normalise(f.attrs.street), normalise(f.attrs.place), i + 1]));
      ins.free();
      db.run('INSERT INTO gw_geocode_meta VALUES (?, ?)', ['format', 'gis-workbench-address-index/1']);
      const out = db.export();
      await saveBlob(app, new Blob([out], { type: 'application/geopackage+sqlite3' }), { name: `${g.name.replace(/[^\w.-]+/g, '_') || 'addresses'}.addresses.gpkg`, types: ['.gpkg'], description: 'GeoPackage' });
      return { bytes: out.length, addresses: features.length };
    } finally {
      db.close();
    }
  }

  /** Load an address GeoPackage written by saveIndex as the index (it is not added as a layer). */
  async function openIndex(bytes, name = '') {
    const SQL = await loadSqlite(app.gw);
    const db = new SQL.Database(bytes);
    try {
      const meta = db.exec("SELECT value FROM gw_geocode_meta WHERE key = 'format'")[0]?.values?.[0]?.[0];
      if (meta !== 'gis-workbench-address-index/1') throw gwError('{name} is not an address index GeoPackage written by GIS Workbench', { name }, 'E_NEED_ADDRESSES');
      // Count before reading: the file may come from anywhere, and reading it whole is the cost.
      const table = db.exec("SELECT table_name FROM gpkg_contents WHERE data_type = 'features' LIMIT 1")[0]?.values?.[0]?.[0];
      const n = table ? Number(db.exec('SELECT COUNT(*) FROM "' + String(table).replace(/"/g, '""') + '"')[0]?.values?.[0]?.[0] ?? 0) : 0;
      if (n > MAX_ADDRESSES) throw gwError('{n} addresses are more than one index holds ({max}): split the layer by area, and save each part as an address GeoPackage', { n: int(n), max: int(MAX_ADDRESSES) }, 'E_NEED_SPLIT');
      const { layers } = readGpkg(SQL, bytes, { name });
      const points = [];
      const ranges = [];
      for (const f of layers[0]?.features ?? []) {
        const a = f.attrs ?? {};
        if (/Point/.test(f.geom.type)) points.push({ id: f.fid, number: a.number, street: a.street, place: a.place, at: [f.geom.xyz[0], f.geom.xyz[1]] });
        else for (const p of parts(f.geom)) ranges.push({ id: f.fid, street: a.street, place: a.place, line: p.map((v) => [v[0], v[1]]), left: [numberOf(a.left_from), numberOf(a.left_to)], right: [numberOf(a.right_from), numberOf(a.right_to)] });
      }
      const ix = buildIndex({ points, ranges });
      net.geocoder = { index: ix, name, layer: null, map: null, points, ranges };
      return { streets: ix.streets.size, addresses: ix.count };
    } finally {
      db.close();
    }
  }

  const need = () => {
    if (!net.geocoder) throw gwError('No address index: use Address Index… on an address layer first', {}, 'E_NEED_ADDRESSES');
    return net.geocoder;
  };
  /** Candidates for an address, best first ({at: [lon, lat], score, match, street, number}). */
  const geocode = (q, o) => search(need().index, q, o);

  // ---- the map: points, markers, layers ----

  /** Pick a point on the image (one click); resolves {lat, lon}, or null on Esc. */
  const pickPoint = (cue) =>
    new Promise((res) => {
      app.tools.register({
        id: 'net.pick',
        cue,
        onDown(p, e, sx, sy) {
          const g = groundOf(app, p, sx, sy);
          res(g ? { lat: g.lat, lon: g.lon } : null);
          app.tools.done();
          return true;
        },
        end: () => res(null),
      });
      app.tools.select('net.pick');
    });
  const show = (at) => {
    const p = pane();
    try {
      p?.centreOnGround(at[1], at[0]);
      app.tools.flashGround?.(p, at[1], at[0]);
    } catch {
      // The image does not cover the place: the result is still in its layer.
    }
  };
  /** A new point or line layer from [{coords | at, attrs}], styled. */
  function addLayer(name, type, items, style) {
    const features = items.map((x) => ({ geom: type === 'Point' ? fromParts('Point', [[[x.at[0], x.at[1], 0]]]) : fromParts('LineString', [x.coords.map((v) => [v[0], v[1], 0])]), attrs: x.attrs, name: x.name ?? null }));
    const id = app.addVectorLayer({ name, fields: inferFields(features), features }, { format: 'network' });
    if (style) S.transact(t('Layer style'), (tx) => tx.set(id, 'style', { ...S.get(id).style, ...style }), { kind: 'load' });
    return id;
  }

  // ---- batch ----

  /** The rows of a table; a file whose header has no delimiter is one column, a cell per line. */
  function tableRows(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    if (lines.length && !/[\t,;|]/.test(lines[0])) return lines.map((l) => [l.trim().replace(/^"(.*)"$/, '$1').replace(/""/g, '"')]);
    return parseDelimited(text).rows;
  }
  /** Geocode every row of a CSV (text): a point layer with the row's fields, the match, its score and what it matched. */
  function geocodeTable(text, opts) {
    return app.activity.track(t('Geocoding a table…'), (job) => geocodeRows(text, opts, job));
  }
  async function geocodeRows(text, { address, place = '', name = t('Geocoded') }, job) {
    const rows = tableRows(text);
    const [head, ...body] = rows;
    const ai = head.indexOf(address);
    const pi = place ? head.indexOf(place) : -1;
    if (ai < 0) throw gwError('No column {col} in the table', { col: address }, 'E_NEED_ADDRESSES');
    const ok = [];
    const failed = [];
    for (const [k, r] of body.entries()) {
      // A misspelt search takes about 2 ms on a large index: give the page a turn every few hundred rows.
      if (k % 250 === 249) {
        job?.set?.(k / body.length);
        await new Promise((res) => setTimeout(res, 0));
      }
      const q = pi >= 0 && r[pi] ? `${r[ai]}, ${r[pi]}` : r[ai];
      const [best] = geocode(q, { limit: 1 });
      const attrs = Object.fromEntries(head.map((k, i) => [k, r[i] ?? '']));
      if (best) ok.push({ at: best.at, attrs: { ...attrs, match: best.match, score: Math.round(best.score), matched: `${best.number ? `${best.number} ` : ''}${best.street}` } });
      else failed.push(attrs);
    }
    const id = ok.length ? addLayer(name, 'Point', ok, { stroke: '#e0a020', fill: '#e0a02099' }) : null;
    return { layer: id, matched: ok.length, unmatched: failed.length, failed };
  }

  // ---- roads ----

  /** The layer's lines, each named by its `idField` value (as turn bans name them), or by its feature id. */
  function roadLines(layer, idField = null) {
    const lines = [];
    for (const f of S.all('feature').filter((x) => x.vlayer === layer && /LineString/.test(x.geom?.type ?? ''))) {
      const id = idField ? String(valueOf(f, idField) ?? '') : f.id;
      for (const p of parts(f.geom)) lines.push({ id, coords: p.map((v) => [v[0], v[1]]), attrs: { ...f.attrs, name: f.name } });
    }
    return lines;
  }
  /** Turn bans from a CSV: two columns naming the road the turn is from and the road it would go onto. */
  function bansFromCsv(text) {
    const [head, ...rows] = parseDelimited(text).rows;
    const fi = head.findIndex((c) => /^from/i.test(c));
    const ti = head.findIndex((c) => /^to/i.test(c));
    if (fi < 0 || ti < 0) throw gwError('A turn-ban table needs a "from" and a "to" column of road ids', {}, 'E_NEED_ROADS');
    return rows.filter((r) => r[fi] && r[ti]).map((r) => ({ from: String(r[fi]).trim(), to: String(r[ti]).trim() }));
  }
  /**
   * Build the road graph from line layer `layer` (id): {oneway, speed, cost: 'length' | 'time',
   * defaultSpeed, idField, bans: [{from, to}] road ids (the idField values, else feature ids)}.
   */
  function buildRoads(layer, o = {}) {
    const lines = roadLines(layer, o.idField ?? null);
    // Every line is at least one piece, so this refuses an oversize layer before the graph copies it.
    if (lines.length > MAX_EDGES) throw gwError('{n} road pieces are more than one network holds ({max}): clip the layer to the area you need', { n: int(lines.length), max: int(MAX_EDGES) }, 'E_NEED_SPLIT');
    const g = buildGraph(lines, o);
    if (!g || !g.edges.length) throw gwError('{layer} has no lines to build a network from', { layer: S.get(layer)?.name ?? '' }, 'E_NEED_ROADS');
    if (g.edges.length > MAX_EDGES) throw gwError('{n} road pieces are more than one network holds ({max}): clip the layer to the area you need', { n: int(g.edges.length), max: int(MAX_EDGES) }, 'E_NEED_SPLIT');
    net.graph = { g, data: graphData(g), name: S.get(layer)?.name ?? '', layer, opts: o };
    return { nodes: g.nodes.length, edges: g.edges.length, banned: g.banned.length, bans: o.bans?.length ?? 0 };
  }
  const graph = () => {
    if (!net.graph) throw gwError('No road network: use Road Network… on a line layer first', {}, 'E_NEED_ROADS');
    return net.graph;
  };
  const call = (prm) => app.pool.run('network', { prm, data: graph().data }, { kind: 'analysis', label: t('road network'), timeout: 300000 });
  const snap = (at) => {
    if (!Array.isArray(at) || !Number.isFinite(at[0]) || !Number.isFinite(at[1])) throw gwError('A route needs a start and an end, and a service area a place to start from', {}, 'E_NEED_ROADS');
    const { g } = graph();
    const s = nearestNode(g, at);
    if (s.node < 0 || s.metres > SNAP_M) throw gwError('That point is {d} from the nearest junction of the road network (more than {max}): routes start and end at junctions', { d: fmtLength(s.metres), max: fmtLength(SNAP_M) }, 'E_NEED_ROADS');
    return s.node;
  };
  const costLabel = (c) => (graph().g.cost === 'time' ? t('{min} min', { min: (c / 60).toFixed(1) }) : fmtLength(c));

  /** The least-cost route between two lon/lat points as a line layer; null when there is none. */
  async function route(from, to) {
    const { g } = graph();
    const r = await call([0, snap(from), snap(to)]);
    if (r.cost === null) return null;
    if (!r.edges.length) throw gwError('The start and the end are at the same junction', {}, 'E_NEED_ROADS');
    const coords = routeLine(g, r.edges, r.forward.map(Boolean));
    const metres = r.edges.reduce((s, e) => s + g.edges[e].len, 0);
    const attrs = { length_m: Math.round(metres * 10) / 10, ...(g.cost === 'time' ? { time_s: Math.round(r.cost * 10) / 10 } : {}), edges: r.edges.length };
    const id = addLayer(t('Route'), 'LineString', [{ coords, attrs }], { stroke: '#2a7de1', width: 4 });
    return { layer: id, cost: r.cost, metres, edges: r.edges.length };
  }

  /** The network within each break (cost units: seconds or metres) of a lon/lat point, as lines with their break. */
  async function serviceArea(at, breaks) {
    const { g } = graph();
    const bs = [...new Set(breaks.filter((b) => b > 0))].sort((a, b) => a - b);
    if (!bs.length) throw gwError('Give at least one break greater than zero', {}, 'E_NEED_ROADS');
    const r = await call([1, bs.at(-1), snap(at)]);
    const pieces = serviceLines(g, r.cost, bs, r.entry).reverse();
    const id = addLayer(t('Service area'), 'LineString', pieces.map((p) => ({ coords: p.coords, attrs: { break: p.brk } })), { stroke: '#1a9850', width: 3 });
    return { layer: id, nodes: r.cost.filter((c) => c !== null && c <= bs.at(-1)).length, pieces: pieces.length };
  }

  /** `fn` with the activity indicator up, painted first: indexing and building a network hold the page. */
  const tracked = (label, fn) => (...a) => app.activity.track(label(), () => fn(...a), { immediate: true });
  const indexing = tracked(() => t('Building the address index…'), indexLayer);
  const saving = tracked(() => t('Saving the address index…'), saveIndex);
  const opening = tracked(() => t('Opening the address index…'), openIndex);
  const building = tracked(() => t('Building the road network…'), buildRoads);

  // ---- commands ----

  C.implement('addr.index', {
    enabled: () => vlayers(/Point|LineString/).length > 0,
    run: run(async (args) => {
      if (args?.layer) {
        const r = await indexing(args.layer, args.map ?? {});
        return args.save ? { ...r, saved: await saving() } : r;
      }
      const layers = vlayers(/Point|LineString/);
      const L = layerSel(layers, t('Address layer'));
      const box = h('div');
      const sels = {};
      const fill = () => {
        clear(box);
        const fs = fieldsOf(L.value);
        const isLine = S.all('feature').some((f) => f.vlayer === L.value && /LineString/.test(f.geom?.type ?? ''));
        sels.street = fieldSel(fs, guess(fs, /street|road/i) || guess(fs, /^name$/i), t('Street'), false);
        sels.place = fieldSel(fs, guess(fs, /city|town|place|locality|post/i), t('Place'));
        box.append(field(t('Street'), sels.street));
        if (isLine) {
          for (const [k, lbl, re] of [['leftFrom', t('Left side, first number'), /l.*f|from.*l/i], ['leftTo', t('Left side, last number'), /l.*t(o)?$|to.*l/i], ['rightFrom', t('Right side, first number'), /r.*f|from.*r/i], ['rightTo', t('Right side, last number'), /r.*t(o)?$|to.*r/i]]) {
            sels[k] = fieldSel(fs, guess(fs, re), lbl);
            box.append(field(lbl, sels[k]));
          }
        } else {
          sels.number = fieldSel(fs, guess(fs, /number|house|addr_?num|^num/i), t('House number'));
          box.append(field(t('House number'), sels.number));
        }
        box.append(field(t('Place'), sels.place));
      };
      L.addEventListener('change', fill);
      if (layers.length) fill();
      const save = h('input', { type: 'checkbox', 'aria-label': t('Also save the index as a GeoPackage') });
      const fromFile = h('button', { class: 'btn', type: 'button' }, t('Open an address GeoPackage…'));
      let opened = null;
      const body = h('div', {}, layers.length ? field(t('Address layer'), L) : h('p', { class: 'hint' }, t('No point or line layer is open.')), box, h('label', { class: 'fld fld-inline' }, save, h('span', {}, t('Also save the index as a GeoPackage'))), h('p', { class: 'hint' }, t('Or open an index saved before (one per district keeps each small):')), fromFile);
      fromFile.addEventListener('click', async () => {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.gpkg'], description: t('Address index') });
        if (!f) return;
        try {
          opened = await opening(new Uint8Array(await f.arrayBuffer()), f.name);
          toast(t('Address index of {n} addresses on {s} streets opened', { n: int(opened.addresses), s: int(opened.streets) }), { kind: 'info' });
        } catch (e) {
          toast(msgOf(e), { kind: 'error' });
        }
      });
      const v = await modal({ title: t('Address Index'), body, buttons: [{ label: t('Build'), value: 'build', primary: true }, { label: t('Close'), value: 'cancel' }], width: 520, id: 'net-addresses' });
      if (v !== 'build') return opened ?? undefined;
      const map = Object.fromEntries(Object.entries(sels).map(([k, s]) => [k, s.value]));
      const r = await indexing(L.value, map);
      toast(t('Address index of {n} addresses on {s} streets', { n: int(r.addresses), s: int(r.streets) }), { kind: 'info' });
      if (save.checked) await saving();
      return r;
    }),
  });

  C.implement('addr.find', {
    enabled: () => !!net.geocoder,
    run: run(async (args) => {
      if (args?.query !== undefined) {
        const c = geocode(args.query, { limit: args.limit ?? 5 });
        if (c[0] && args.show !== false) show(c[0].at);
        return c;
      }
      need();
      const q = h('input', { class: 'inp', type: 'search', 'aria-label': t('Address'), placeholder: t('12 Main Street, Springfield') });
      const list = h('div', { class: 'net-results', role: 'listbox', 'aria-label': t('Matches') });
      let found = [];
      const refresh = () => {
        found = q.value.trim() ? geocode(q.value, { limit: 8 }) : [];
        clear(list);
        if (q.value.trim() && !found.length) list.append(h('p', { class: 'hint' }, t('No match')));
        found.forEach((c, i) => {
          const b = h('button', { class: 'btn net-result', type: 'button', role: 'option' }, `${c.number ? `${c.number} ` : ''}${c.street} · ${t('{score}% ({match})', { score: Math.round(c.score), match: matchLabel(c.match) })}`);
          b.addEventListener('click', () => {
            show(c.at);
            addLayer(t('Found: {q}', { q: q.value.trim() }), 'Point', [{ at: c.at, attrs: { address: q.value.trim(), match: c.match, score: Math.round(c.score), matched: `${c.number ? `${c.number} ` : ''}${c.street}` } }], { stroke: '#e0a020', fill: '#e0a02099' });
          });
          list.append(b);
          if (i === 0) b.setAttribute('aria-selected', 'true');
        });
      };
      q.addEventListener('input', refresh);
      await modal({ title: t('Find Address'), body: h('div', {}, field(t('Address'), q), list, h('p', { class: 'hint' }, t('Searches {name} only: nothing is sent anywhere.', { name: net.geocoder.name || t('the address index') }))), buttons: [{ label: t('Close'), value: 'close' }], width: 480, id: 'net-find', modeless: true });
      return found;
    }),
  });
  const matchLabel = (m) => ({ exact: t('number found'), interpolated: t('number interpolated'), 'nearest number': t('nearest number'), street: t('street only'), 'other place': t('in another place') })[m] ?? m;

  C.implement('addr.batch', {
    enabled: () => !!net.geocoder,
    run: run(async (args) => {
      need();
      if (args?.text !== undefined) return geocodeTable(args.text, args);
      const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt', '.tsv'], description: t('Address table') });
      if (!f) return undefined;
      const text = await f.text();
      const head = tableRows(text)[0] ?? [];
      const a = fieldSel(head, guess(head, /addr|address|street/i), t('Address column'), false);
      const p = fieldSel(head, guess(head, /city|town|place/i), t('Place column'));
      if ((await modal({ title: t('Geocode a Table'), body: h('div', {}, field(t('Address column'), a), field(t('Place column'), p)), buttons: [{ label: t('Geocode'), value: 'go', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'net-batch' })) !== 'go') return undefined;
      const r = await geocodeTable(text, { address: a.value, place: p.value, name: f.name.replace(/\.\w+$/, '') });
      toast(t('{ok} of {n} addresses found', { ok: int(r.matched), n: int(r.matched + r.unmatched) }), { kind: r.unmatched ? 'warn' : 'info' });
      return r;
    }),
  });

  C.implement('addr.reverse', {
    enabled: () => !!net.geocoder,
    run: run(async (args) => {
      const at = args?.at ?? (await pickPoint(t('Click a place to find its address')).then((g) => g && [g.lon, g.lat]));
      if (!at) return undefined;
      const r = reverse(need().index, at, { max: args?.max ?? 250 });
      if (!args?.at) toast(r ? t('{number} {street} ({d} away)', { number: r.number, street: r.street, d: fmtLength(r.d) }) : t('No address within {d}', { d: fmtLength(250) }), { kind: r ? 'info' : 'warn' });
      return r;
    }),
  });

  C.implement('route.roads', {
    enabled: () => vlayers(/LineString/).length > 0,
    run: run(async (args) => {
      if (args?.layer) return building(args.layer, { ...args, bans: args.bansCsv ? bansFromCsv(args.bansCsv) : args.bans });
      const layers = vlayers(/LineString/);
      const L = layerSel(layers, t('Road layer'));
      const box = h('div');
      const sels = {};
      const costSel = h('select', { class: 'inp', 'aria-label': t('Cost') }, h('option', { value: 'time' }, t('Travel time')), h('option', { value: 'length' }, t('Distance')));
      const dflt = h('input', { class: 'inp inp-num', type: 'number', value: '50', min: '1', max: '300', 'aria-label': t('Speed where none is given (km/h)') });
      const fill = () => {
        clear(box);
        const fs = fieldsOf(L.value);
        sels.oneway = fieldSel(fs, guess(fs, /one.?way|dir/i), t('One-way field'));
        sels.speed = fieldSel(fs, guess(fs, /speed|maxspeed|kmh|limit/i), t('Speed field (km/h)'));
        sels.id = fieldSel(fs, guess(fs, /^(id|osm_?id|link_?id|road_?id|fid)$/i), t('Road id field'));
        box.append(field(t('One-way field'), sels.oneway, t('yes, -1, no (OpenStreetMap), Y and N, or FT, TF, B, N (HERE, where N is closed).')), field(t('Speed field (km/h)'), sels.speed), field(t('Road id field'), sels.id, t('Only for turn bans, which name roads by it.')));
      };
      L.addEventListener('change', fill);
      fill();
      let bans = [];
      const bansBtn = h('button', { class: 'btn', type: 'button' }, t('Turn bans (CSV)…'));
      const bansNote = h('span', { class: 'hint', 'aria-live': 'polite' }, t('None'));
      bansBtn.addEventListener('click', async () => {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt'], description: t('Turn bans') });
        if (!f) return;
        try {
          bans = bansFromCsv(await f.text());
          bansNote.textContent = t('{n, plural, one {# ban} other {# bans}} from {file}', { n: bans.length, file: f.name });
        } catch (e) {
          toast(msgOf(e), { kind: 'warn' });
        }
      });
      const body = h('div', {}, field(t('Road layer'), L), box, field(t('Cost'), costSel), field(t('Speed where none is given (km/h)'), dflt), field(t('Turn bans'), h('div', { class: 'ts-bar' }, bansBtn, bansNote), t('A table with "from" and "to" road ids: no turn from the first road onto the second where they meet.')), h('p', { class: 'hint' }, t('Roads join where lines share a vertex, so a bridge that only crosses a road stays apart from it.')));
      if ((await modal({ title: t('Road Network'), body, buttons: [{ label: t('Build'), value: 'build', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'net-roads' })) !== 'build') return undefined;
      const r = await building(L.value, { oneway: sels.oneway.value || null, speed: sels.speed.value || null, cost: costSel.value, defaultSpeed: +dflt.value || 50, idField: sels.id.value || null, bans });
      toast(t('Road network of {n} nodes and {e} pieces', { n: int(r.nodes), e: int(r.edges) }), { kind: 'info' });
      return r;
    }),
  });

  C.implement('route.shortest', {
    enabled: () => !!net.graph,
    run: run(async (args) => {
      graph();
      const from = args?.from ?? (await pickPoint(t('Click the start')).then((g) => g && [g.lon, g.lat]));
      if (!from) return undefined;
      const to = args?.to ?? (await pickPoint(t('Click the end')).then((g) => g && [g.lon, g.lat]));
      if (!to) return undefined;
      const r = await route(from, to);
      if (!r) {
        toast(t('No route: the end cannot be reached from the start (one-way streets or a closed road)'), { kind: 'warn' });
        return null;
      }
      if (!args?.from) toast(t('Route of {len}, {cost}', { len: fmtLength(r.metres), cost: costLabel(r.cost) }), { kind: 'info' });
      return r;
    }),
  });

  C.implement('route.service', {
    enabled: () => !!net.graph,
    run: run(async (args) => {
      graph();
      const time = graph().g.cost === 'time';
      let breaks = args?.breaks;
      let at = args?.at;
      if (!breaks) {
        const b = h('input', { class: 'inp', value: time ? '5, 10, 15' : '500, 1000, 2000', 'aria-label': time ? t('Breaks (minutes)') : t('Breaks (metres)') });
        if ((await modal({ title: t('Service Area'), body: h('div', {}, field(time ? t('Breaks (minutes)') : t('Breaks (metres)'), b), h('p', { class: 'hint' }, t('Then click the place to start from. The area starts at the nearest junction.'))), buttons: [{ label: t('Next'), value: 'go', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'net-service' })) !== 'go') return undefined;
        breaks = b.value
          .split(/[,;\s]+/)
          .map(Number)
          .filter((x) => x > 0)
          .map((x) => (time ? x * 60 : x));
      }
      at ??= await pickPoint(t('Click the start')).then((g) => g && [g.lon, g.lat]);
      if (!at) return undefined;
      return serviceArea(at, breaks);
    }),
  });

  Object.assign(net, { indexLayer: indexing, saveIndex: saving, openIndex: opening, geocode, reverse: (at, o) => reverse(need().index, at, o), geocodeTable, buildRoads: building, route, serviceArea });
}
