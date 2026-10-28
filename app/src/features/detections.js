// ML detections (REQ-EXT-19, REQ-AI-12): import GeoJSON or CSV detections (ground or pixel
// coordinates), filter by confidence, and review them in a queue (accept, reject, edit). Accepted
// detections become features in an "Accepted detections" vector layer with their class,
// confidence and source. The assistant can summarise, sort and *propose* decisions; the analyst
// accepts those proposals like any other.

import { h } from '../shell/dom.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { modal, field } from '../shell/dialogs.js';
import { fromParts } from '../vector/geom.js';
import { screenOfGround, halo, poly } from '../tools/tools.js';

export const name = 'detections';

const CLASS_KEYS = ['class', 'label', 'category', 'type', 'name', 'cls'];
const CONF_KEYS = ['confidence', 'score', 'prob', 'probability', 'conf'];
const pick = (o, keys) => {
  for (const k of keys) {
    const hit = Object.keys(o ?? {}).find((x) => x.toLowerCase() === k);
    if (hit !== undefined && o[hit] !== '' && o[hit] !== null && o[hit] !== undefined) return o[hit];
  }
  return undefined;
};
const conf01 = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n > 1 ? n / 100 : n;
};

/** Detections from GeoJSON text → [{cls, confidence, anchor, ring|point, props}]. */
export function parseGeoJson(text) {
  const j = JSON.parse(text);
  const feats = j.type === 'FeatureCollection' ? j.features : j.type === 'Feature' ? [j] : [];
  const out = [];
  for (const f of feats) {
    const g = f.geometry;
    if (!g) continue;
    const props = f.properties ?? {};
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p) => p[0]) : null;
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : null;
    const all = (rings ?? [pts ?? []]).flat();
    // Pixel detections: coordinates outside the lon/lat range, or an explicit image CRS.
    const image = props.pixel === true || /image|pixel/i.test(j.crs?.properties?.name ?? '') || all.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90);
    for (const r of rings ?? []) out.push({ cls: String(pick(props, CLASS_KEYS) ?? 'object'), confidence: conf01(pick(props, CONF_KEYS)), anchor: image ? 'image' : 'ground', ring: r.map((c) => [c[0], c[1]]), props });
    for (const p of pts ?? []) out.push({ cls: String(pick(props, CLASS_KEYS) ?? 'object'), confidence: conf01(pick(props, CONF_KEYS)), anchor: image ? 'image' : 'ground', point: [p[0], p[1]], props });
  }
  return out;
}

/** Detections from CSV: lat/lon (or lon/lat) points, x/y[/w/h] pixels, or xmin…ymax boxes. */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines.shift().split(',').map((x) => x.trim().toLowerCase());
  const col = (...ns) => head.findIndex((x) => ns.includes(x));
  const c = { lat: col('lat', 'latitude', 'y_lat'), lon: col('lon', 'lng', 'longitude', 'x_lon'), x: col('x', 'col', 'cx', 'px'), y: col('y', 'row', 'cy', 'py'), w: col('w', 'width'), h: col('h', 'height'), xmin: col('xmin', 'x0', 'left'), ymin: col('ymin', 'y0', 'top'), xmax: col('xmax', 'x1', 'right'), ymax: col('ymax', 'y1', 'bottom'), cls: head.findIndex((x) => CLASS_KEYS.includes(x)), conf: head.findIndex((x) => CONF_KEYS.includes(x)) };
  const out = [];
  for (const l of lines) {
    const v = l.split(',').map((x) => x.trim());
    const n = (k) => (c[k] >= 0 ? Number(v[c[k]]) : NaN);
    const props = Object.fromEntries(head.map((k, i) => [k, v[i]]));
    const base = { cls: c.cls >= 0 ? v[c.cls] : 'object', confidence: c.conf >= 0 ? conf01(v[c.conf]) : NaN, props };
    if (Number.isFinite(n('lat')) && Number.isFinite(n('lon'))) out.push({ ...base, anchor: 'ground', point: [n('lon'), n('lat')] });
    else if ([n('xmin'), n('ymin'), n('xmax'), n('ymax')].every(Number.isFinite)) out.push({ ...base, anchor: 'image', ring: [[n('xmin'), n('ymin')], [n('xmax'), n('ymin')], [n('xmax'), n('ymax')], [n('xmin'), n('ymax')], [n('xmin'), n('ymin')]] });
    else if (Number.isFinite(n('x')) && Number.isFinite(n('y'))) {
      if (Number.isFinite(n('w')) && Number.isFinite(n('h'))) {
        const [x0, y0, x1, y1] = [n('x') - n('w') / 2, n('y') - n('h') / 2, n('x') + n('w') / 2, n('y') + n('h') / 2];
        out.push({ ...base, anchor: 'image', ring: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] });
      } else out.push({ ...base, anchor: 'image', point: [n('x'), n('y')] });
    }
  }
  return out;
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const opts = { minConfidence: 0.5, current: null, showRejected: false };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };

  const all = () => S.all('detection');
  /** The queue: above the confidence filter, pending first, then by confidence (high → low). */
  function queue({ min = opts.minConfidence, status = null } = {}) {
    const rank = { pending: 0, edited: 1, accepted: 2, rejected: 3 };
    return all()
      .filter((d) => !(d.confidence < min) && (!status || d.status === status))
      .sort((a, b) => rank[a.status] - rank[b.status] || (Number.isFinite(b.confidence) ? b.confidence : -1) - (Number.isFinite(a.confidence) ? a.confidence : -1) || a.n - b.n);
  }

  /** Ground ring/point of a detection (image anchors go through the layer's model). */
  function groundOf(d) {
    const l = d.layer ? app.layers.get(d.layer) : null;
    const g = (x, y) => {
      if (d.anchor === 'ground') return [x, y, 0];
      const q = l?.groundAt?.(x, y);
      return q ? [q.lon, q.lat, q.h] : null;
    };
    if (d.point) return { type: 'Point', pts: [g(...d.point)] };
    return { type: 'Polygon', pts: d.ring.map(([x, y]) => g(x, y)) };
  }

  /** Add detections [{cls, confidence, anchor, ring|point, props}] to the review queue (import or local AI). */
  function add(list, { layer = app.activeLayer(), source = 'detections' } = {}) {
    if (list.some((d) => d.anchor === 'image') && !layer) throw new Error('pixel detections need an image: open it and make it active first');
    const base = all().length;
    const batch = new Date().toISOString();
    S.transact(`Add ${list.length} detections`, (tx) => {
      list.forEach((d, i) => tx.create('detection', { n: base + i + 1, cls: d.cls, confidence: d.confidence, anchor: d.anchor, ring: d.ring ?? null, point: d.point ?? null, layer: d.anchor === 'image' ? layer.id : null, image: d.anchor === 'image' ? layer.rec?.name ?? null : null, source, props: d.props, status: 'pending', note: '', imported: batch }));
    });
    opts.current = queue()[0]?.id ?? null;
    redraw();
    return list.length;
  }

  async function importFile(file, { layer = app.activeLayer(), source = file.name } = {}) {
    const text = await file.text();
    const list = /\.csv$/i.test(file.name) ? parseCsv(text) : parseGeoJson(text);
    if (!list.length) throw new Error(`${file.name}: no detections found`);
    add(list, { layer, source });
    app.importLog.push({ file: file.name, errors: [], warnings: [`${list.length} detections imported (${list.filter((d) => d.anchor === 'image').length} in pixel coordinates)`] });
    app.toast(`${list.length} detections from ${file.name}; ${queue().length} at confidence ≥ ${opts.minConfidence}`);
    return list.length;
  }

  function acceptedLayer(tx) {
    let v = S.all('vlayer').find((x) => x.role === 'accepted-detections');
    if (v) return v.id;
    return tx.create('vlayer', { name: 'Accepted detections', role: 'accepted-detections', visible: true, style: { stroke: '#00ff66', width: 2, fill: '#00ff6622' }, fields: [{ name: 'CLASS', type: 'string' }, { name: 'CONF', type: 'real' }, { name: 'SOURCE', type: 'string' }, { name: 'NOTE', type: 'string' }], source: { format: 'new' }, created: new Date().toISOString() });
  }

  /** Apply a decision inside a transaction (shared by the queue and the assistant's proposals). */
  function decide(tx, d, status, { reason = '', cls = null, note = null } = {}) {
    const upd = { status, decided: new Date().toISOString(), reason };
    if (cls) upd.cls = cls;
    if (note !== null) upd.note = note;
    for (const [k, v] of Object.entries(upd)) tx.set(d.id, k, v);
    if (d.feature && status === 'rejected') {
      tx.delete?.(d.feature);
      tx.set(d.id, 'feature', null);
    }
    if (status === 'accepted' && !d.feature) {
      const g = groundOf({ ...d, ...upd });
      if (g.pts.every(Boolean)) {
        const vl = acceptedLayer(tx);
        const geom = g.type === 'Point' ? fromParts('Point', [g.pts]) : fromParts('Polygon', [g.pts]);
        const fid = tx.create('feature', { vlayer: vl, geom, attrs: { CLASS: cls ?? d.cls, CONF: Number.isFinite(d.confidence) ? d.confidence : null, SOURCE: d.source, NOTE: note ?? d.note ?? '' }, name: `${cls ?? d.cls} #${d.n}`, prov: { kind: 'ml-detection', source: d.source, detection: d.id, confidence: d.confidence } });
        tx.set(d.id, 'feature', fid);
      }
    }
  }

  function setStatus(id, status, extra = {}) {
    const d = S.get(id);
    if (!d) throw new Error('no such detection');
    S.transact(`${status[0].toUpperCase()}${status.slice(1)} detection #${d.n}`, (tx) => decide(tx, d, status, extra));
    const q = queue({ status: 'pending' });
    opts.current = q[0]?.id ?? null;
    redraw();
  }

  async function edit(id = opts.current) {
    const d = S.get(id);
    if (!d) return;
    const cls = h('input', { type: 'text', value: d.cls, spellcheck: 'true', 'data-id': 'det-class' });
    const note = h('textarea', { rows: 3, 'data-id': 'det-note' }, d.note ?? '');
    const b = await modal({ title: `Edit detection #${d.n}`, body: h('div', {}, field('Class', cls), field('Note', note), h('p', { class: 'hint' }, `Confidence ${Number.isFinite(d.confidence) ? d.confidence.toFixed(2) : 'n/a'} · ${d.source}`)), buttons: ['Save and accept', 'Save', 'Cancel'], id: 'det-edit' });
    if (b === 'Save and accept') setStatus(id, 'accepted', { cls: cls.value.trim() || d.cls, note: note.value });
    else if (b === 'Save') setStatus(id, 'edited', { cls: cls.value.trim() || d.cls, note: note.value });
  }

  function zoomTo(id = opts.current) {
    const d = S.get(id);
    const p = app.activePane();
    if (!d || !p) return;
    const pts = d.point ? [d.point] : d.ring;
    const cx = pts.reduce((s, q) => s + q[0], 0) / pts.length;
    const cy = pts.reduce((s, q) => s + q[1], 0) / pts.length;
    if (d.anchor === 'image') p.setView?.({ cx, cy });
    else {
      const l = p.geoLayer?.();
      const q = l?.imageAt?.(cy, cx, 0) ?? (l?.modelId ? app.core.g2i(l.modelId, cy, cx, 0) : null);
      if (q) p.setView?.({ cx: q.x, cy: q.y });
    }
  }

  function summary({ min = 0 } = {}) {
    const ds = all().filter((d) => !(d.confidence < min));
    const byClass = {};
    const byStatus = {};
    for (const d of ds) {
      byClass[d.cls] = (byClass[d.cls] ?? 0) + 1;
      byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    }
    const cs = ds.map((d) => d.confidence).filter(Number.isFinite).sort((a, b) => a - b);
    const q = (p) => (cs.length ? cs[Math.min(cs.length - 1, Math.floor(p * cs.length))] : null);
    return { total: ds.length, byClass, byStatus, confidence: { min: cs[0] ?? null, median: q(0.5), max: cs.at(-1) ?? null }, filter: opts.minConfidence };
  }

  // ---- review queue dock ----
  let dockEl = null;
  function redraw() {
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.invalidate();
    if (!dockEl?.isConnected) return;
    const q = queue();
    const s = summary();
    const slider = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(opts.minConfidence), 'data-id': 'det-min', 'aria-label': 'Minimum confidence' });
    slider.addEventListener('input', () => {
      opts.minConfidence = Number(slider.value);
      redraw();
    });
    const row = (d) => {
      const b = (label, fn, id) => {
        const x = h('button', { type: 'button', class: 'btn-s', 'data-id': `det-${id}:${d.n}` }, label);
        x.addEventListener('click', fn);
        return x;
      };
      return h('tr', { class: `det-${d.status}${d.id === opts.current ? ' current' : ''}`, 'data-det': String(d.n) }, h('td', {}, String(d.n)), h('td', {}, d.cls), h('td', {}, Number.isFinite(d.confidence) ? d.confidence.toFixed(2) : '–'), h('td', {}, d.status), h('td', {}, b('✓', () => setStatus(d.id, 'accepted'), 'accept'), b('✗', () => setStatus(d.id, 'rejected'), 'reject'), b('✎', () => edit(d.id), 'edit'), b('⌖', () => zoomTo(d.id), 'zoom')));
    };
    dockEl.classList.add('pad'); // GUI-050
    dockEl.replaceChildren(
      h('div', { class: 'det-head', 'data-id': 'det-summary' }, [`${s.total} detections`, `${q.length} at ≥ ${opts.minConfidence.toFixed(2)}`, ...Object.entries(s.byStatus).map(([k, v]) => `${k} ${v}`)].join(' · ')),
      field(`Minimum confidence (${opts.minConfidence.toFixed(2)})`, slider),
      h('p', { class: 'hint' }, 'Keys: A accept, R reject, E edit, N next (current row).'),
      h('table', { class: 'tbl det-table', 'data-id': 'det-queue' }, h('thead', {}, h('tr', {}, ...['#', 'Class', 'Conf.', 'Status', ''].map((t) => h('th', {}, t)))), h('tbody', {}, ...q.slice(0, 300).map(row))),
    );
  }
  app.on('ready', (mp) =>
    mp.docks.register({
      id: 'detections',
      title: 'Detection Review',
      icon: 'list',
      home: 'right',
      create: (a, m, el) => {
        dockEl = el;
        el.tabIndex = 0;
        el.addEventListener('keydown', (e) => {
          const id = opts.current;
          if (!id) return;
          const k = e.key.toLowerCase();
          if (k === 'a') setStatus(id, 'accepted');
          else if (k === 'r') setStatus(id, 'rejected');
          else if (k === 'e') edit(id);
          else if (k === 'n') {
            const q = queue({ status: 'pending' });
            opts.current = q[(q.findIndex((d) => d.id === id) + 1) % Math.max(1, q.length)]?.id ?? null;
            redraw();
            zoomTo();
          } else return;
          e.preventDefault();
        });
        redraw();
        return { onShow: redraw };
      },
    }),
  );
  S.on('commit', (cs) => {
    if (cs.ops.some((o) => (o.rec?.type ?? S.get(o.id)?.type) === 'detection')) redraw();
  });

  // ---- drawing on image panels ----
  const COL = { pending: '#ffd400', edited: '#00c8ff', accepted: '#00ff66', rejected: '#ff4040' };
  const prev = app.graphics?.drawPane;
  if (app.graphics) {
    app.graphics.drawPane = (p, g, w, hh) => {
      prev?.(p, g, w, hh);
      const l = p.geoLayer?.();
      if (!l) return;
      g.save();
      for (const d of all()) {
        if (d.confidence < opts.minConfidence || (d.status === 'rejected' && !opts.showRejected)) continue;
        const src = d.point ? [d.point] : d.ring;
        const pts = src.map(([x, y]) => (d.anchor === 'image' ? (d.layer === l.id ? p.screenPoint(x, y) : null) : screenOfGround(p, y, x, 0)));
        if (!pts.every(Boolean)) continue;
        g.strokeStyle = COL[d.status] ?? '#ffd400';
        g.lineWidth = d.id === opts.current ? 3 : 1.5;
        if (d.point) {
          const q = pts[0];
          halo(g, () => g.strokeRect(q.x - 5, q.y - 5, 10, 10));
        } else halo(g, () => poly(g, pts, true));
        g.fillStyle = g.strokeStyle;
        g.font = '11px sans-serif';
        g.fillText(`${d.cls} ${Number.isFinite(d.confidence) ? Math.round(d.confidence * 100) : '?'}%`, pts[0].x + 2, pts[0].y - 3);
      }
      g.restore();
    };
  }

  // ---- assistant tools (REQ-AI-12) ----
  const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
  const reg = app.registry;
  if (reg) {
    reg.tool({
      name: 'gw_list_detections',
      title: 'List ML detections',
      description: 'Summary of imported ML detections (counts by class and status, confidence statistics) and the queue sorted by confidence: id, number, class, confidence, status, source, position.',
      readOnly: true,
      inputSchema: obj({ minConfidence: { type: 'number', minimum: 0, maximum: 1 }, status: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'edited'] }, limit: { type: 'integer', minimum: 1, maximum: 500 } }),
      run: ({ minConfidence = 0, status = null, limit = 100 } = {}) => ({ summary: summary({ min: minConfidence }), queue: queue({ min: minConfidence, status }).slice(0, limit).map((d) => ({ id: d.id, n: d.n, cls: d.cls, confidence: d.confidence, status: d.status, source: d.source, anchor: d.anchor, at: d.point ?? d.ring?.[0] ?? null })) }),
    });
    reg.tool({
      name: 'gw_review_detections',
      title: 'Propose detection decisions',
      description: 'Propose accept or reject decisions (with a short reason each) for detections by id. The analyst accepts or rejects the proposal; accepted detections become features.',
      readOnly: false,
      inputSchema: obj({ decisions: { type: 'array', items: obj({ id: { type: 'string' }, status: { type: 'string', enum: ['accepted', 'rejected'] }, reason: { type: 'string' } }, ['id', 'status']) } }, ['decisions']),
      propose: ({ decisions }, tx) => {
        let a = 0;
        let r = 0;
        for (const x of decisions) {
          const d = S.get(x.id);
          if (!d || d.type !== 'detection') throw new Error(`no detection ${x.id}`);
          decide(tx, d, x.status, { reason: x.reason ?? 'AI proposal' });
          if (x.status === 'accepted') a++;
          else r++;
        }
        return { title: `Review ${decisions.length} detection(s): ${a} accept, ${r} reject`, preview: decisions.slice(0, 8).map((x) => `${S.get(x.id)?.n ?? '?'} ${x.status}${x.reason ? ` (${x.reason})` : ''}`).join('; ') };
      },
    });
  }

  function csvOut() {
    const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    return ['n,class,confidence,status,reason,note,source,anchor,x_or_lon,y_or_lat', ...all().map((d) => [d.n, d.cls, d.confidence, d.status, d.reason ?? '', d.note ?? '', d.source, d.anchor, ...(d.point ?? d.ring?.[0] ?? ['', ''])].map(esc).join(','))].join('\n') + '\n';
  }

  C.implement('det.import', { run: run(async () => { for (const f of await pickFiles(app, { accept: ['.geojson', '.json', '.csv'], description: 'ML detections (GeoJSON or CSV)' })) await importFile(f); app.activeMp().docks.show('detections'); }) });
  C.implement('det.review', { run: run(() => app.activeMp().docks.show('detections')) });
  app.detections = { add, importFile, queue, setStatus, edit, zoomTo, summary, options: opts, csv: csvOut, parseCsv, parseGeoJson, exportCsv: () => saveBlob(app, new Blob([csvOut()], { type: 'text/csv' }), { name: 'detections_review.csv' }) };
}
