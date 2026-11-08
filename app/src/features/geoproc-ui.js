// Vector geoprocessing (REQ-GAP-79, SDP-2.7 §4.1): Feature ▸ Geoprocessing ▸ Buffer, Overlay,
// Dissolve and Spatial Join, and app.geoproc for scripts and recipes. Lazy block js-geoproc
// (features/geoprocessing.js loads it); the work runs in an analysis worker (analysis/geoproc.js
// with the `geoproc` WASM bundle), and every result is a new vector layer.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, gwError } from '../i18n/index.js';
import { isPolygonal } from '../vector/geom.js';

export function install(app) {
  const S = app.store;
  const C = app.commands;
  const layers = () => S.all('vlayer');
  const featuresOf = (id) => S.all('feature').filter((f) => f.vlayer === id);
  const nameOf = (id) => S.get(id)?.name ?? '';
  const job = (op, args, label) => app.pool.run(op, args, { kind: 'analysis', label, timeout: 3600000 });
  // A feature's name (GeoJSON and KML keep "name" there, not in the attributes) goes along as one.
  const attrsOf = (f) => (f.name != null && !('name' in (f.attrs ?? {})) ? { name: f.name, ...f.attrs } : { ...f.attrs });
  const plain = (fs) => fs.map((f) => ({ geom: f.geom, attrs: attrsOf(f) }));
  const need = (id) => {
    if (!S.get(id) || S.get(id).type !== 'vlayer') throw gwError('choose a vector layer', null, 'E_NO_VECTOR_LAYER');
    const fs = featuresOf(id);
    if (!fs.length) throw gwError('{layer} has no features', { layer: nameOf(id) }, 'E_EMPTY_LAYER');
    return fs;
  };
  const fieldsOf = (id) => {
    const v = S.get(id);
    const names = new Set((v?.fields ?? []).map((f) => f.name));
    for (const f of featuresOf(id)) for (const k of Object.keys(f.attrs ?? {})) names.add(k);
    return [...names];
  };
  const add = (name, features, op) => app.addVectorLayer({ name, features: features.filter((f) => f.geom) }, { format: 'geoprocessing', op });

  /** Buffer every feature of layer `id` by `distance` m. Returns the new layer's id. */
  async function buffer(id, { distance, geodesic = true, cap = 'round', quadSegs = 8, dissolve = false } = {}) {
    if (!Number.isFinite(distance) || distance === 0) throw gwError('the buffer distance must be a number other than 0', null, 'E_BUFFER_DISTANCE');
    const fs = need(id);
    const geoms = await job('geo.buffer', { geoms: fs.map((f) => f.geom), distance, cap, quadSegs, geodesic }, t('Buffer {layer}', { layer: nameOf(id) }));
    let out = geoms.map((g, i) => ({ geom: g, attrs: { ...fs[i].attrs }, name: fs[i].name ?? null }));
    if (dissolve) out = (await job('geo.dissolve', { features: out.filter((f) => f.geom) }, t('Dissolve {layer}', { layer: nameOf(id) }))).map((g) => ({ geom: g.geom, attrs: { count: g.count } }));
    return add(t('{layer} buffer {distance} m', { layer: nameOf(id), distance }), out, 'buffer');
  }
  /** Overlay layers a and b. op: intersect | union | erase | symdiff. Returns the new layer's id. */
  async function overlay(a, b, op = 'intersect') {
    const [fa, fb] = [need(a), need(b)];
    if (!fa.some((f) => isPolygonal(f.geom)) || !fb.some((f) => isPolygonal(f.geom))) throw gwError('overlay needs polygons in both layers', null, 'E_OVERLAY_POLYGONS');
    const r = await job('geo.overlay', { a: plain(fa), b: plain(fb), op, aFields: fieldsOf(a), bFields: fieldsOf(b) }, t('Overlay {a} and {b}', { a: nameOf(a), b: nameOf(b) }));
    if (r.failed.length) app.toast(t('{n, plural, one {# pair of polygons} other {# pairs of polygons}} could not be overlaid and were left out', { n: r.failed.length }), { kind: 'warn', ms: 9000 });
    const opName = { intersect: t('intersect'), union: t('union'), erase: t('erase'), symdiff: t('symmetric difference') }[op];
    return add(t('{a} {op} {b}', { a: nameOf(a), op: opName, b: nameOf(b) }), r.features, 'overlay');
  }
  /** Dissolve layer `id` by `field` (null: into one feature). Returns the new layer's id. */
  async function dissolve(id, field = null) {
    const fs = need(id);
    const r = await job('geo.dissolve', { features: plain(fs), field }, t('Dissolve {layer}', { layer: nameOf(id) }));
    return add(field ? t('{layer} dissolved by {field}', { layer: nameOf(id), field }) : t('{layer} dissolved', { layer: nameOf(id) }), r.map((g) => ({ geom: g.geom, attrs: field ? { [field]: g.value, count: g.count } : { count: g.count } })), 'dissolve');
  }
  /** Join layer `joinId` onto `targetId`. Returns the new layer's id. */
  async function join(targetId, joinId, { predicate = 'intersects', field = null, maxDistance = null } = {}) {
    const [ft, fj] = [need(targetId), need(joinId)];
    const r = await job('geo.join', { targets: plain(ft), joins: plain(fj), predicate, field, maxDistance }, t('Join {b} to {a}', { a: nameOf(targetId), b: nameOf(joinId) }));
    return add(t('{a} joined with {b}', { a: nameOf(targetId), b: nameOf(joinId) }), r.map((x, i) => ({ geom: ft[i].geom, attrs: x.attrs, name: ft[i].name ?? null })), 'join');
  }
  Object.assign(app.geoproc, { buffer, overlay, dissolve, join });

  // ---- dialogs ----
  const layerSelect = (label, pick = app.prefs.get('vlayerActive')) =>
    h('select', { class: 'inp', 'aria-label': label }, ...layers().map((v) => h('option', { value: v.id, selected: v.id === pick }, v.name)));
  const choice = (label, opts) => h('select', { class: 'inp', 'aria-label': label }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
  const ask = async (id, title, body) => (await modal({ title, body: h('div', {}, ...body), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id })) === 'run';
  const done = (id) => app.toast(t('{layer}: {n, plural, one {# feature} other {# features}}', { layer: nameOf(id), n: featuresOf(id).length }), { kind: 'info' });

  C.implement('vec.buffer', {
    enabled: () => layers().length > 0,
    run: async () => {
      const L = layerSelect(t('Layer'));
      const d = h('input', { class: 'inp inp-num', type: 'number', value: 100, step: 'any', 'aria-label': t('Distance (m)') });
      const m = choice(t('Method'), [['geodesic', t('Geodesic (WGS 84)')], ['planar', t('Planar (local frame)')]]);
      const cap = choice(t('Line ends'), [['round', t('Round')], ['flat', t('Flat')], ['square', t('Square')]]);
      const q = h('input', { class: 'inp inp-num', type: 'number', value: 8, min: 1, max: 90, 'aria-label': t('Segments per quarter circle') });
      const dis = h('input', { type: 'checkbox', 'aria-label': t('Dissolve the result') });
      if (!(await ask('vec-buffer', t('Buffer'), [field(t('Layer'), L), field(t('Distance (m)'), d), field(t('Method'), m), field(t('Line ends'), cap), field(t('Segments per quarter circle'), q), field(t('Dissolve the result'), dis)]))) return;
      done(await buffer(L.value, { distance: Number(d.value), geodesic: m.value === 'geodesic', cap: cap.value, quadSegs: Math.round(Number(q.value)) || 8, dissolve: dis.checked }));
    },
  });
  C.implement('vec.overlay', {
    enabled: () => layers().length > 1,
    run: async () => {
      const a = layerSelect(t('Input layer'));
      const b = layerSelect(t('Overlay layer'), layers().find((v) => v.id !== app.prefs.get('vlayerActive'))?.id);
      const op = choice(t('Operation'), [['intersect', t('Intersect')], ['union', t('Union')], ['erase', t('Erase')], ['symdiff', t('Symmetric difference')]]);
      if (!(await ask('vec-overlay', t('Overlay'), [field(t('Input layer'), a), field(t('Overlay layer'), b), field(t('Operation'), op)]))) return;
      done(await overlay(a.value, b.value, op.value));
    },
  });
  C.implement('vec.dissolve', {
    enabled: () => layers().length > 0,
    run: async () => {
      const L = layerSelect(t('Layer'));
      const f = h('select', { class: 'inp', 'aria-label': t('Dissolve field') });
      const fill = () => f.replaceChildren(h('option', { value: '' }, t('(none: one feature)')), ...fieldsOf(L.value).map((n) => h('option', { value: n }, n)));
      L.onchange = fill;
      fill();
      if (!(await ask('vec-dissolve', t('Dissolve'), [field(t('Layer'), L), field(t('Dissolve field'), f)]))) return;
      done(await dissolve(L.value, f.value || null));
    },
  });
  C.implement('vec.join', {
    enabled: () => layers().length > 1,
    run: async () => {
      const a = layerSelect(t('Target layer'));
      const b = layerSelect(t('Join layer'), layers().find((v) => v.id !== app.prefs.get('vlayerActive'))?.id);
      const p = choice(t('Relationship'), [['intersects', t('Intersects')], ['within', t('Target within join feature')], ['contains', t('Target contains join feature')], ['nearest', t('Nearest')]]);
      const f = h('select', { class: 'inp', 'aria-label': t('Summarise field') });
      const fill = () => f.replaceChildren(h('option', { value: '' }, t('(count only)')), ...fieldsOf(b.value).map((n) => h('option', { value: n }, n)));
      b.onchange = fill;
      fill();
      const dmax = h('input', { class: 'inp inp-num', type: 'number', value: '', min: 0, step: 'any', placeholder: t('no limit'), 'aria-label': t('Maximum distance (m)') });
      if (!(await ask('vec-join', t('Spatial Join'), [field(t('Target layer'), a), field(t('Join layer'), b), field(t('Relationship'), p), field(t('Summarise field'), f), field(t('Maximum distance (m)'), dmax)]))) return;
      done(await join(a.value, b.value, { predicate: p.value, field: f.value || null, maxDistance: dmax.value === '' ? null : Number(dmax.value) }));
    },
  });
}
