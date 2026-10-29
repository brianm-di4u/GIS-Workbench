// Spectral analysis (R3, `Research/10` §7–§11): the training-region workflow with
// Jeffries–Matusita separability and supervised classifiers with live thresholds (REQ-MSI-08),
// K-means/ISODATA, clean-up and class vectors with area and perimeter (REQ-MSI-09), accuracy
// (REQ-MSI-10), RX/local RX/MF/ACE/CEM/GMM with PCA reduction above 32 bands (REQ-MSI-11),
// PCA/MNF/ICA/decorrelation/unmixing (REQ-MSI-12), spectral libraries (REQ-MSI-13), brightness
// temperature (REQ-MSI-14), the Xport multiport (REQ-MSI-15), destriping and two-date change
// (REQ-MSI-16), and template matching (REQ-EXT-28). Products are in-memory layers on the
// parent's geometry; thresholds re-label them without recomputing the classifier.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { pickFiles } from '../storage/files.js';
import { openMemoryLayer, attachLayers } from '../formats/open.js';
import { fromParts } from '../vector/geom.js';
import { contourLines } from './dem-tools.js';
import { INDICES } from '../render/bandmath.js';
import STARTER from '../data/splib07-starter.json';

export const name = 'spectral-analysis';

export const CLASS_COLOURS = [[0, 0, 0], [30, 90, 200], [40, 170, 60], [200, 190, 90], [150, 100, 60], [210, 210, 210], [70, 70, 70], [200, 80, 50], [230, 120, 220], [90, 220, 220], [240, 160, 40], [140, 60, 200]];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const layer = () => app.activeLayer();
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);
  const msi = () => app.msi;
  const spec = (op, ...args) => app.pool.run('spectral', { op, args }, { kind: 'analysis', label: `spectral ${op}`, timeout: 600000 }).then((r) => r.r);

  // TE-069: whole-image analysis of a large image (every field image: 16k² DigitalGlobe tiles,
  // 13k² Pléiades) asked the worker for more than its 96 M-sample cube and was refused. Use the
  // active AOI when there is one, and read every k-th pixel when the window is still too large;
  // the product keeps its geolocation through a window model (openMemoryLayer step).
  const CUBE_MAX = 96e6;
  /** The image point of l under the view centre (the image centre when there is no view). */
  function viewCentre(l) {
    const p = pane();
    const geo = p?.geoLayer?.();
    if (p && geo) {
      const { w, h } = p.size();
      const q = p.imagePoint(w / 2, h / 2);
      const g = geo.groundAt(q.x, q.y);
      const r = g && l.imageAt(g.lat, g.lon, g.h ?? 0);
      if (r && Number.isFinite(r.x)) return r;
    }
    return { x: l.width / 2, y: l.height / 2 };
  }
  function fitWindow(l, window = null, { nb = l.bands, fullRes = null } = {}) {
    const a = window ?? aoiRect(l) ?? { x0: 0, y0: 0, w: l.width, h: l.height };
    const step = a.step ?? Math.max(1, Math.ceil(Math.sqrt((a.w * a.h * nb) / CUBE_MAX)));
    if (step > 1 && fullRes) {
      if (window || aoiRect(l)) throw new Error(`${fullRes} works at full resolution on up to ${CUBE_MAX / 1e6} M samples; the AOI is ${a.w}×${a.h}×${nb}: draw a smaller AOI`);
      // No AOI: the largest full-resolution square around the view centre.
      const side = Math.floor(Math.sqrt(CUBE_MAX / nb));
      const c = viewCentre(l);
      const x0 = Math.max(0, Math.min(l.width - side, Math.round(c.x - side / 2)));
      const y0 = Math.max(0, Math.min(l.height - side, Math.round(c.y - side / 2)));
      app.toast(`${fullRes} works at full resolution: the ${Math.min(side, l.width)}×${Math.min(side, l.height)} pixels around the view centre (draw an AOI to choose the area).`, { ms: 9000 });
      return { x0, y0, w: Math.min(side, l.width), h: Math.min(side, l.height), step: 1 };
    }
    if (step > 1) app.toast(`${l.rec?.name ?? 'The image'} is ${a.w}×${a.h}×${nb}: analysed at every ${step}th pixel. Draw an AOI of up to ${Math.floor(Math.sqrt(CUBE_MAX / nb))}² pixels for full resolution.`, { ms: 9000 });
    return { x0: a.x0, y0: a.y0, w: a.w, h: a.h, step };
  }
  app.openMemoryLayer = (parent, o) => openMemoryLayer(app, parent, o);

  // ---- training classes (REQ-MSI-08) ----

  /** Classes of a layer: store records {layer, name, colour, regions: [{x0, y0, w, h}], validation}. */
  const classesOf = (l) => S.all('msiclass').filter((c) => c.layer === l.id).sort((a, b) => a.order - b.order);
  function addClass(l, { name: nm, colour = null, regions = [], validation = [] }) {
    const k = classesOf(l).length;
    let id;
    S.transact(`Class ${nm}`, (tx) => {
      id = tx.create('msiclass', { layer: l.id, name: nm, colour: colour ?? CLASS_COLOURS[(k % (CLASS_COLOURS.length - 1)) + 1], regions, validation, order: k });
    });
    return S.get(id);
  }
  function clearClasses(l) {
    S.transact('Clear classes', (tx) => {
      for (const c of classesOf(l)) tx.delete(c.id);
    });
  }
  /** Pixel indices of rectangles inside a cube window. */
  function indicesIn(rects, win) {
    const out = [];
    for (const r of rects) {
      for (let y = Math.max(r.y0, win.y0); y < Math.min(r.y0 + r.h, win.y0 + win.h * win.step); y += win.step)
        for (let x = Math.max(r.x0, win.x0); x < Math.min(r.x0 + r.w, win.x0 + win.w * win.step); x += win.step) out.push(Math.floor((y - win.y0) / win.step) * win.w + Math.floor((x - win.x0) / win.step));
    }
    return out;
  }
  /** Mean ± σ spectra per class and the pairwise JM distance. */
  async function separability(l) {
    const cls = classesOf(l);
    const c = await msi().cube(l, {});
    const sets = cls.map((k) => indicesIn(k.regions, c));
    const r = await spec('train', c.v, c.w, c.h, c.nb, sets);
    return { classes: cls.map((k, i) => ({ ...k, ...r.classes[i] })), jm: r.jm };
  }

  // ---- classification with live thresholds ----

  const LABEL = { md: 'Minimum distance', ml: 'Maximum likelihood', mahalanobis: 'Mahalanobis', sam: 'Spectral angle (SAM)', sid: 'SID' };
  /** χ² critical values (α = 0.001) for ML rejection by degrees of freedom. */
  const chi2 = (dof, alpha = 0.001) => {
    // Wilson–Hilferty approximation.
    const z = { 0.05: 1.6449, 0.01: 2.3263, 0.001: 3.0902 }[alpha] ?? 3.0902;
    return dof * (1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof))) ** 3;
  };

  async function classify(l, method = 'ml', { threshold = NaN, window = null, signatures = null } = {}) {
    const cls = classesOf(l);
    if (!signatures && cls.length < 2) throw new Error('add at least two training classes first (Find in Scene ▸ Add Region)'); // a precondition, shown as a warning (GUI-044)
    const c = await msi().cube(l, fitWindow(l, window));
    const sets = signatures ? null : cls.map((k) => indicesIn(k.regions, c));
    if (sets?.some((s) => s.length < c.nb + 1) && (method === 'ml' || method === 'mahalanobis')) throw new Error(`${LABEL[method]} needs at least ${c.nb + 1} training pixels per class (better ${10 * c.nb})`);
    const r = await spec('classify', c.v, c.w, c.h, c.nb, method, { sets, means: signatures?.map((s) => s.values) ?? null, threshold: NaN });
    const names = signatures ? signatures.map((s) => s.name) : cls.map((k) => k.name);
    const colours = signatures ? signatures.map((_, i) => CLASS_COLOURS[(i % (CLASS_COLOURS.length - 1)) + 1]) : cls.map((k) => k.colour);
    const labels = applyThreshold(r.labels, r.scores, threshold);
    const P = await openMemoryLayer(app, l, { name: `${LABEL[method]} — ${l.rec?.name ?? ''}`, bands: 1, sampleType: 'u8', planes: [labels], nodata: 0, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], ...colours] } }, info: { bandsMeta: [{ name: 'class', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'class labels', gain: null, offset: null, unit: 'class', source: LABEL[method] } } });
    P.msi = { kind: 'classification', method, names, colours, labelsAll: r.labels, scores: r.scores, threshold, window: { x0: c.x0, y0: c.y0, w: c.w, h: c.h, step: c.step }, parent: l.id, nb: c.nb };
    return P;
  }
  function applyThreshold(labels, scores, t) {
    if (!Number.isFinite(t)) return labels.slice();
    const out = new Uint8Array(labels.length);
    for (let i = 0; i < labels.length; i++) out[i] = scores[i] <= t ? labels[i] : 0;
    return out;
  }
  /** Live threshold (radians for SAM, χ² for ML, data units for distances). Returns ms. */
  async function setThreshold(P, t) {
    const t0 = performance.now();
    P.msi.threshold = t;
    await P.updatePlanes([applyThreshold(P.msi.labelsAll, P.msi.scores, t)]);
    return performance.now() - t0;
  }

  // ---- unsupervised, clean-up, vectors (REQ-MSI-09) ----

  async function cluster(l, algo = 'kmeans', o = {}) {
    const c = await msi().cube(l, fitWindow(l, o.window));
    const r = await spec(algo, c.v, c.w, c.h, c.nb, o);
    const k = r.centres.length;
    const colours = Array.from({ length: k }, (_, i) => CLASS_COLOURS[(i % (CLASS_COLOURS.length - 1)) + 1]);
    const P = await openMemoryLayer(app, l, { name: `${algo === 'kmeans' ? 'K-means' : 'ISODATA'} (${k}) — ${l.rec?.name ?? ''}`, bands: 1, sampleType: 'u8', planes: [r.labels], nodata: 0, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], ...colours] } }, info: { bandsMeta: [{ name: 'cluster', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'cluster labels', gain: null, offset: null, unit: 'cluster', source: algo } } });
    P.msi = { kind: 'classification', method: algo, names: colours.map((_, i) => `Cluster ${i + 1}`), colours, labelsAll: r.labels, scores: null, centres: r.centres, window: { x0: c.x0, y0: c.y0, w: c.w, h: c.h, step: c.step }, parent: l.id };
    return P;
  }
  const post = (P, op, param = 3) => {
    const w = P.msi.window.w;
    const hh = P.msi.window.h;
    const cur = P.msi.scores && Number.isFinite(P.msi.threshold) ? applyThreshold(P.msi.labelsAll, P.msi.scores, P.msi.threshold) : P.msi.labelsAll;
    return app.pool.run('spectral', { op: 'post', args: [op, cur, w, hh, param] }, { kind: 'analysis', label: `clean-up ${op}` }).then(async (r) => {
      P.msi.labelsAll = r.r;
      P.msi.scores = null;
      P.msi.history = [...(P.msi.history ?? []), `${op} ${param}`];
      await P.updatePlanes([r.r]);
      return r.r;
    });
  };

  /** Class polygons with area (m²) and perimeter (m) attributes → a vector layer. */
  function classVectors(P, { minPixels = 4 } = {}) {
    const { w, h: hh } = P.msi.window;
    const lab = P.msi.scores && Number.isFinite(P.msi.threshold) ? applyThreshold(P.msi.labelsAll, P.msi.scores, P.msi.threshold) : P.msi.labelsAll;
    const core = app.core;
    const feats = [];
    for (let k = 1; k <= P.msi.names.length; k++) {
      const m = new Float32Array((w + 2) * (hh + 2));
      let any = false;
      for (let y = 0; y < hh; y++)
        for (let x = 0; x < w; x++)
          if (lab[y * w + x] === k) {
            m[(y + 1) * (w + 2) + x + 1] = 1;
            any = true;
          }
      if (!any) continue;
      const pg = { lat0: 1, lon0: -1, dlat: 1, dlon: 1, width: w + 2, height: hh + 2 };
      for (const line of contourLines(pg, m, 0.5, { indexEvery: 1, maxLines: 50000, levels: [0.5] })) {
        if (line.pts.length < 4) continue;
        const ring = line.pts.map(([lon, lat]) => ({ x: lon + 0.5, y: -lat + 0.5 }));
        let a2 = 0;
        for (let i = 0; i < ring.length; i++) a2 += ring[i].x * ring[(i + 1) % ring.length].y - ring[(i + 1) % ring.length].x * ring[i].y;
        if (Math.abs(a2) / 2 < minPixels) continue;
        const g = ring.map((q) => P.groundAt(q.x, q.y)).filter(Boolean);
        if (g.length < 3) continue;
        const area = Math.abs(core.polygonArea(g.map((p) => [p.lat, p.lon])).area);
        let per = 0;
        for (let i = 0; i < g.length; i++) per += core.inverse(g[i].lat, g[i].lon, g[(i + 1) % g.length].lat, g[(i + 1) % g.length].lon).distance;
        feats.push({ k, g, area, per });
      }
    }
    let vid = null;
    S.transact(`Class vectors ${P.rec?.name ?? ''}`, (tx) => {
      vid = tx.create('vlayer', { name: `${P.rec?.name ?? 'Classes'} polygons`, visible: true, style: { stroke: '#ffffff', width: 1, fill: '#ffffff20', outline: '#ffffff' }, fields: [{ name: 'CLASS', type: 'text' }, { name: 'CLASS_ID', type: 'int' }, { name: 'AREA_M2', type: 'real' }, { name: 'PERIM_M', type: 'real' }], source: { format: 'classification' }, created: new Date().toISOString() });
      for (const f of feats) tx.create('feature', { vlayer: vid, geom: fromParts('Polygon', [[...f.g, f.g[0]].map((p) => [p.lon, p.lat, 0])]), attrs: { CLASS: P.msi.names[f.k - 1], CLASS_ID: f.k, AREA_M2: f.area, PERIM_M: f.per }, name: P.msi.names[f.k - 1], prov: { kind: 'classification' } });
    });
    return { vlayer: vid, count: feats.length, features: feats.map((f) => ({ k: f.k, area: f.area, per: f.per })) };
  }

  // ---- accuracy (REQ-MSI-10) ----

  async function assess(P, l = app.layers.get(P.msi.parent)) {
    const cls = classesOf(l);
    const { x0, y0, w, h: hh, step } = P.msi.window;
    const ref = new Uint8Array(w * hh);
    const win = { x0, y0, w, h: hh, step };
    let n = 0;
    cls.forEach((c, i) => {
      for (const p of indicesIn(c.validation ?? [], win)) {
        if (ref[p] === 0) n++;
        ref[p] = i + 1;
      }
    });
    if (!n) throw new Error('no validation regions: add validation rectangles per class (separate from the training regions)');
    const mapped = P.msi.scores && Number.isFinite(P.msi.threshold) ? applyThreshold(P.msi.labelsAll, P.msi.scores, P.msi.threshold) : P.msi.labelsAll;
    // Mapped-area weights for the area-weighted estimate.
    const k = cls.length;
    const cnt = new Array(k).fill(0);
    let tot = 0;
    for (const v of mapped)
      if (v > 0 && v <= k) {
        cnt[v - 1]++;
        tot++;
      }
    const weights = cnt.map((c) => c / Math.max(1, tot));
    const a = await spec('accuracy', ref, mapped, k, weights);
    a.names = cls.map((c) => c.name);
    P.msi.accuracy = a;
    return a;
  }
  function accuracyTable(a) {
    const k = a.k;
    const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '–');
    const head = h('tr', {}, h('th', {}, 'Reference ↓ / Mapped →'), ...a.names.map((n) => h('th', {}, n)), h('th', {}, 'Unclassified'), h('th', {}, 'Total'), h('th', {}, 'PA'));
    const rows = a.matrix.map((r, i) => h('tr', {}, h('th', {}, a.names[i]), ...r.map((v) => h('td', {}, String(v))), h('td', {}, String(r.reduce((s, v) => s + v, 0))), h('td', {}, f3(a.producers[i]))));
    const colTot = Array.from({ length: k + 1 }, (_, c) => a.matrix.reduce((s, r) => s + r[c], 0));
    const tot = h('tr', {}, h('th', {}, 'Total'), ...colTot.map((v) => h('td', {}, String(v))), h('td', {}, String(a.n)), h('td', {}, ''));
    const ua = h('tr', {}, h('th', {}, 'UA'), ...a.users.map((v) => h('td', {}, f3(v))), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''));
    return h('div', {}, h('table', { class: 'tbl', 'data-id': 'confusion' }, h('thead', {}, head), h('tbody', {}, ...rows, tot, ua)), h('p', { 'data-id': 'accuracy-summary' }, `Overall accuracy ${f3(a.oa)} · κ = ${f3(a.kappa)} · quantity disagreement ${f3(a.quantity)} · allocation disagreement ${f3(a.allocation)}${a.oaArea ? ` · area-weighted OA ${f3(a.oaArea[0])} ± ${f3(a.oaArea[1])} (95 %)` : ''} · n = ${a.n}`), h('p', { class: 'hint' }, 'Rows are reference classes, columns mapped classes. Validation pixels never overlap training pixels when they come from separate regions.'));
  }

  // ---- detection (REQ-MSI-11) ----

  /** Reduce to `k` PCA components when the cube has more than 32 bands. */
  async function reduced(c, k = 20) {
    if (c.nb <= 32) return { ...c, reduced: null };
    const t = await spec('transform', 'pca', c.v, c.w, c.h, c.nb, { k, step: 4 });
    return { ...c, v: t.cube, nb: k, reduced: { from: c.nb, to: k, explained: t.values.slice(0, k).reduce((s, v) => s + v, 0) / t.values.reduce((s, v) => s + Math.max(0, v), 0) } };
  }
  /**
   * kind: 'rx' | 'rxlocal' | 'gmm' | 'mf' | 'ace' | 'cem'. threshold: {percentile} (default
   * 99.9 %) or {value}. Returns {layer, scores, threshold, hits: [{x, y, pixels, max}]}.
   */
  async function detect(l, kind = 'rx', { percentile = 0.999, value = NaN, target = null, window = null, outer = 15, guard = 5, k = 4 } = {}) {
    let c = await msi().cube(l, fitWindow(l, window));
    const fullNb = c.nb;
    let scores;
    if (kind === 'mf' || kind === 'ace' || kind === 'cem') {
      if (!target || target.length !== c.nb) throw new Error(`${kind.toUpperCase()} needs a target spectrum with ${c.nb} bands (pin one, or pick a library entry)`);
      const r = await spec('detect', 'target', c.v, c.w, c.h, c.nb, { step: 4, target });
      scores = r[kind];
    } else {
      c = await reduced(c);
      const r = await spec('detect', kind, c.v, c.w, c.h, c.nb, { step: 4, outer, guard, k });
      scores = r.scores;
    }
    const sorted = Array.from(scores).filter(Number.isFinite).sort((a, b) => a - b);
    const thr = Number.isFinite(value) ? value : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
    // Hits: 8-connected groups above the threshold.
    const { w, h: hh } = c;
    const seen = new Uint8Array(w * hh);
    const hits = [];
    for (let i = 0; i < w * hh; i++) {
      if (seen[i] || !(scores[i] > thr)) continue;
      const st = [i];
      seen[i] = 1;
      let sx = 0;
      let sy = 0;
      let n = 0;
      let mx = -Infinity;
      while (st.length) {
        const p = st.pop();
        const x = p % w;
        const y = (p - x) / w;
        sx += x;
        sy += y;
        n++;
        mx = Math.max(mx, scores[p]);
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
            const q = yy * w + xx;
            if (!seen[q] && scores[q] > thr) {
              seen[q] = 1;
              st.push(q);
            }
          }
      }
      hits.push({ x: c.x0 + (sx / n + 0.5) * c.step, y: c.y0 + (sy / n + 0.5) * c.step, pixels: n, max: mx });
    }
    hits.sort((a, b) => b.max - a.max);
    const names = { rx: 'Global RX', rxlocal: 'Local RX', gmm: 'GMM anomaly', mf: 'Matched filter', ace: 'ACE', cem: 'CEM' };
    const P = await openMemoryLayer(app, l, { name: `${names[kind]}${c.reduced ? ` (PCA ${c.reduced.to} of ${fullNb})` : ''} — ${l.rec?.name ?? ''}`, bands: 1, sampleType: 'f32', planes: [Float32Array.from(scores)], nodata: NaN, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'linear1', colour: { palette: 'iron' }, clip: { on: true, lo: thr, hi: Infinity } }, info: { bandsMeta: [{ name: names[kind], cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: names[kind], gain: null, offset: null, unit: 'score', source: kind } } });
    P.msi = { kind: 'detection', detector: kind, threshold: thr, hits, reduced: c.reduced };
    app.msi.lastDetect = { kind, threshold: thr, hits, scores, w: c.w, h: c.h, x0: c.x0, y0: c.y0, reduced: c.reduced, layer: P };
    return app.msi.lastDetect;
  }

  // ---- transforms (REQ-MSI-12) ----

  async function components(l, kind = 'pca', { k = 3, window = null, endmembers = null } = {}) {
    const c = await msi().cube(l, fitWindow(l, window));
    const r = await spec('transform', kind, c.v, c.w, c.h, c.nb, { k, step: 2, endmembers });
    const nb = kind === 'dstretch' ? c.nb : kind === 'unmix' ? endmembers.length + 1 : k;
    const n = c.w * c.h;
    const planes = Array.from({ length: nb }, (_, b) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = r.cube[i * nb + b];
      return p;
    });
    const names = { pca: 'PCA', mnf: 'MNF', ica: 'ICA', dstretch: 'Decorrelation stretch', unmix: 'Abundances' };
    const P = await openMemoryLayer(app, l, { name: `${names[kind]} — ${l.rec?.name ?? ''}`, bands: nb, sampleType: 'f32', planes, nodata: NaN, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { bands: nb >= 3 && kind !== 'unmix' ? [0, 1, 2] : [0], stretch: 'linear2' }, info: { bandsMeta: planes.map((_, i) => ({ name: kind === 'unmix' && i === nb - 1 ? 'RMS residual' : `${names[kind]} ${i + 1}`, cw: NaN, fwhm: NaN, bad: false })), radiometry: { state: names[kind], gain: null, offset: null, unit: 'component', source: kind } } });
    P.msi = { kind: 'transform', transform: kind, values: r.values ?? null, vectors: r.vectors ?? null };
    return { layer: P, values: r.values ?? null };
  }
  function eigenPlot(values) {
    const W = 360;
    const H = 160;
    const v = values.map((x) => Math.max(0, x));
    const tot = v.reduce((s, x) => s + x, 0) || 1;
    const bars = v.slice(0, 40).map((x, i) => `<rect x="${30 + i * 8}" y="${H - 20 - (x / v[0]) * (H - 30)}" width="6" height="${(x / v[0]) * (H - 30)}" fill="#5fd0ff"/>`).join('');
    let cum = 0;
    const line = v.slice(0, 40).map((x, i) => `${34 + i * 8},${H - 20 - ((cum += x) / tot) * (H - 30)}`).join(' ');
    const el = h('div', { 'data-id': 'eigen-plot' });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Eigenvalues"><rect width="${W}" height="${H}" fill="#1b1f24"/>${bars}<polyline points="${line}" fill="none" stroke="#ffcb5f"/><text x="4" y="12" fill="#c8ccd0" font-size="10">eigenvalues (bars), cumulative variance (line)</text></svg>`;
    return el;
  }

  // ---- libraries (REQ-MSI-13) ----

  // The embedded starter library (USGS splib07b, AVIRIS-2014 channels; acknowledgement in About).
  const libraries = STARTER.spectra.map((s) => ({ name: s.name, chapter: s.chapter, wl: STARTER.wavelengths, values: s.values.map((v) => (v === null ? NaN : v)), source: 'USGS splib07 (embedded starter)' }));
  /** Parse CSV (wavelength, value…), USGS ASCII (one value per line after a title) or ENVI .sli. */
  async function importLibrary(files) {
    const out = [];
    const hdr = files.find((f) => /\.hdr$/i.test(f.name));
    const sli = files.find((f) => /\.sli$/i.test(f.name));
    if (sli && hdr) {
      const t = await hdr.text();
      const r = await app.pool.run('envihdr', { bytes: new TextEncoder().encode(t), dataLen: sli.size }, { label: 'library header' });
      const n = r.samples;
      const m = r.lines;
      const wl = r.wavelength.map((v) => (v > 100 ? v / 1000 : v));
      const dv = new DataView(await sli.arrayBuffer(), r.headerOffset);
      const le = r.byteOrder === 0;
      const get = r.dataType === 4 ? (o) => dv.getFloat32(o, le) : r.dataType === 5 ? (o) => dv.getFloat64(o, le) : r.dataType === 2 ? (o) => dv.getInt16(o, le) : (o) => dv.getUint16(o, le);
      for (let s = 0; s < m; s++) out.push({ name: r.spectraNames[s] ?? `${sli.name} #${s + 1}`, wl, values: Array.from({ length: n }, (_, i) => get((s * n + i) * r.bytesPerSample)), source: sli.name });
    }
    for (const f of files.filter((x) => /\.(csv|txt)$/i.test(x.name))) {
      const t = await f.text();
      const lines = t.split(/\r?\n/).filter((x) => x.trim());
      const num = lines.filter((x) => /^[\s\d.+\-eE,;\t]+$/.test(x));
      const cols = num.map((x) => x.split(/[,;\t\s]+/).filter(Boolean).map(Number));
      if (cols.length && cols[0].length >= 2) {
        // CSV: first column wavelength; one spectrum per further column (header names if any).
        const head = lines[0] && !/^[\s\d.+\-eE,;\t]+$/.test(lines[0]) ? lines[0].split(/[,;\t]/).map((x) => x.trim()) : [];
        for (let k = 1; k < cols[0].length; k++) out.push({ name: head[k] || `${f.name} ${k}`, wl: cols.map((c) => (c[0] > 100 ? c[0] / 1000 : c[0])), values: cols.map((c) => c[k]), source: f.name });
      } else if (cols.length) {
        // USGS ASCII: a title line, then one reflectance per line; wavelengths in a companion file.
        const title = lines[0].trim();
        out.push({ name: title, wl: null, values: cols.map((c) => c[0]).map((v) => (v < -1e30 ? NaN : v)), source: f.name });
      }
    }
    // USGS ASCII spectra take their wavelengths from a "*Wavelengths*" file among the picks.
    const wlFile = out.find((s) => /wavelength/i.test(s.name) && !s.wl);
    for (const s of out) if (!s.wl && wlFile && s !== wlFile) s.wl = wlFile.values.map((v) => (v > 100 ? v / 1000 : v));
    const good = out.filter((s) => s.wl && s !== wlFile);
    libraries.push(...good);
    return good;
  }
  /** A library spectrum resampled to a layer's bands (Gaussian SRFs from centre and FWHM). */
  async function resampled(l, s) {
    const b = msi().bandsOf(l);
    if (!b.every((x) => Number.isFinite(x.cw))) throw new Error('library comparison needs the band centre wavelengths');
    const r = await spec('resample', s.wl, s.values, b.map((x) => x.cw), b.map((x) => (Number.isFinite(x.fwhm) ? x.fwhm : 0.01)));
    return { ...s, values: r.resampled, bands: b, label: s.name };
  }

  // ---- thermal (REQ-MSI-14) ----

  async function brightnessTemperature(l, band, { k1 = NaN, k2 = NaN, lambda = NaN, emissivity = NaN, celsius = false } = {}) {
    const meta = l.radiometry.meta;
    if (!Number.isFinite(k1) && meta?.sensor === 'landsat') {
      // TE-054: the MTL band of image band `band` (a B10 file is image band 1, MTL band 10).
      const mtlBand = l.radiometry.bandMap?.[band] ?? band + 1;
      const b = meta.bands.find((x) => x.band === mtlBand && Number.isFinite(x.k1));
      if (b) [k1, k2] = [b.k1, b.k2];
    }
    if (!Number.isFinite(k1) && !Number.isFinite(lambda)) lambda = msi().bandsOf(l)[band].cw;
    if (!/radiance/i.test(l.radiometry.state)) throw new Error(`brightness temperature needs radiance; the band is ${l.radiometry.state} (Radiometric Conversion first)`);
    const c = await msi().cube(l, { bands: [band] });
    const kv = await spec('bt', c.v, { k1, k2, lambda, emissivity });
    const v = celsius ? kv.map((x) => x - 273.15) : kv;
    return openMemoryLayer(app, l, { name: `Brightness temperature${Number.isFinite(emissivity) ? ` (ε ${emissivity})` : ''} (${celsius ? '°C' : 'K'}) — ${l.rec?.name ?? ''}`, bands: 1, sampleType: 'f32', planes: [v], nodata: NaN, chain: { stretch: 'linear1', colour: { palette: 'iron' } }, info: { bandsMeta: [{ name: 'BT', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: Number.isFinite(emissivity) ? 'surface temperature (single-channel, user ε)' : 'brightness temperature', gain: null, offset: null, unit: celsius ? '°C' : 'K', source: Number.isFinite(k1) ? 'K1/K2' : 'Planck' } } });
  }

  // ---- Xport (REQ-MSI-15) ----

  async function xport(l, views = null) {
    const all = [
      ['preset', 'natural'],
      ['preset', 'cir'],
      ['preset', 'rededge'],
      ['preset', 'swir'],
      ['preset', 'agriculture'],
      ['preset', 'bathymetric'],
      ...Object.keys(INDICES).map((k) => ['index', k]),
      ...Array.from({ length: l.bands }, (_, b) => ['band', b]),
    ];
    const ok = (v) => (v[0] === 'preset' ? !msi().presetBands(l, v[1]).missing.length : v[0] === 'index' ? msi().indexAvailable(l, v[1]).ok : true);
    const list = (views ?? all.filter(ok)).slice(0, 16);
    // Check before changing the layout (GUI-022).
    const fref = S.get(l.rec.file);
    if (!fref) throw new Error('Xport clones a file-backed image');
    const mp = app.activeMp();
    const n = list.length;
    mp.setLayout(n <= 4 ? '2x2' : n <= 9 ? '3x3' : n <= 12 ? '3x4' : '4x4');
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = mp.panes[i];
      let target = l;
      if (p !== pane() || i > 0) {
        const id = `lyr_${Math.random().toString(36).slice(2, 10)}`;
        S.transact('Xport view', (tx) => {
          tx.create('layer', { ...structuredClone(l.rec), id: undefined, pane: p.id, name: `${l.rec.name} [${list[i].join(' ')}]` }, id);
          tx.set(p.id, 'layers', [...(tx.get(p.id).layers ?? []).filter((x) => !app.layers.has(x) || app.layers.get(x).rec?.file !== l.rec.file), id]);
          tx.set(p.id, 'activeLayer', id);
        });
        [target] = await attachLayers(app, fref, [S.get(id)]);
      }
      const [kind, key] = list[i];
      if (kind === 'preset') await msi().applyPreset(target, key);
      else if (kind === 'index') await msi().setIndex(target, key);
      else await msi().showBand(target, key);
      out.push({ pane: p.id, view: list[i], layer: target.id });
    }
    app.links?.linkAll?.(mp);
    return out;
  }

  // ---- destriping, change, template matching (REQ-MSI-16, REQ-EXT-28) ----

  async function destripe(l) {
    // Stripes are per detector column: decimating would alias them, so full resolution only.
    const c = await msi().cube(l, fitWindow(l, null, { fullRes: 'Destripe' }));
    const r = await spec('correct', 'destripe', c.v, c.w, c.h, c.nb, {});
    const n = c.w * c.h;
    const planes = Array.from({ length: c.nb }, (_, b) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = r.cube[i * c.nb + b];
      return p;
    });
    return openMemoryLayer(app, l, { name: `Destriped — ${l.rec?.name ?? ''}`, bands: c.nb, sampleType: 'f32', planes, nodata: NaN, x0: c.x0, y0: c.y0, width: c.w, height: c.h, chain: { bands: l.chain.bands, stretch: 'dra' }, info: { bandsMeta: msi().bandsOf(l), radiometry: { ...l.radiometry, gain: null, offset: null, state: `${l.radiometry.state}, destriped` } } });
  }
  async function spectralChange(a, b, { threshold = NaN } = {}) {
    if (a.width !== b.width || a.height !== b.height || a.bands !== b.bands) throw new Error('two-date change needs images of the same size and bands (co-register first)');
    const win = fitWindow(a);
    const [ca, cb] = await Promise.all([msi().cube(a, win), msi().cube(b, win)]);
    const r = await spec('correct', 'change', ca.v, ca.w, ca.h, ca.nb, { b: cb.v });
    const P = await openMemoryLayer(app, a, { name: `Spectral change ${a.rec?.name} → ${b.rec?.name}`, bands: 2, sampleType: 'f32', planes: [r.magnitude, r.angle], nodata: NaN, x0: ca.x0, y0: ca.y0, step: ca.step, width: ca.w, height: ca.h, chain: { bands: [0], stretch: 'linear1', colour: { palette: 'iron' } }, info: { bandsMeta: [{ name: 'change magnitude', cw: NaN, fwhm: NaN, bad: false }, { name: 'spectral angle (rad)', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'change vector', gain: null, offset: null, unit: a.radiometry.unit, source: 'CVA' } } });
    P.msi = { kind: 'change', magnitude: r.magnitude, angle: r.angle, threshold };
    return P;
  }
  /** Template matching: the template is a window of the layer's displayed band. */
  async function templateMatch(l, t, { band = l.chain.bands[0], threshold = 0.8, maxHits = 200 } = {}) {
    const step = Math.max(1, Math.ceil(Math.sqrt((l.width * l.height) / 2048 ** 2)));
    const img = await msi().cube(l, { bands: [band], step });
    const tc = await msi().cube(l, { bands: [band], x0: t.x0, y0: t.y0, w: t.w, h: t.h, step });
    const r = await spec('template', img.v, img.w, img.h, tc.v, tc.w, tc.h);
    // Local maxima above the threshold, suppressing within half a template.
    const hits = [];
    const used = new Uint8Array(r.ncc.length);
    const order = Array.from(r.ncc.keys()).filter((i) => r.ncc[i] >= threshold).sort((a, b) => r.ncc[b] - r.ncc[a]);
    for (const i of order) {
      if (used[i]) continue;
      const x = i % r.w;
      const y = (i - x) / r.w;
      hits.push({ x: (x + tc.w / 2) * step, y: (y + tc.h / 2) * step, ncc: r.ncc[i] });
      for (let dy = -Math.floor(tc.h / 2); dy <= Math.floor(tc.h / 2); dy++)
        for (let dx = -Math.floor(tc.w / 2); dx <= Math.floor(tc.w / 2); dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < r.w && yy < r.h) used[yy * r.w + xx] = 1;
        }
      if (hits.length >= maxHits) break;
    }
    if (hits.length && l.modelId) {
      S.transact(`Template matches (${hits.length})`, (tx) => {
        const vid = tx.create('vlayer', { name: `Template matches ≥ ${threshold}`, visible: true, style: { stroke: '#ffcb5f', width: 2, fill: '#ffcb5f40', outline: '#ffcb5f' }, fields: [{ name: 'NCC', type: 'real' }], source: { format: 'template-match' }, created: new Date().toISOString() });
        for (const q of hits) {
          const g = l.groundAt(q.x, q.y);
          if (g) tx.create('feature', { vlayer: vid, geom: fromParts('Point', [[[g.lon, g.lat, g.h ?? 0]]]), attrs: { NCC: q.ncc }, name: `NCC ${q.ncc.toFixed(3)}`, prov: { kind: 'template-match' } });
        }
      });
    }
    app.msi.lastTemplate = { hits, step };
    return { hits, step };
  }

  Object.assign(app.msi, { classesOf, addClass, clearClasses, separability, classify, setThreshold, cluster, post, classVectors, assess, accuracyTable, detect, components, eigenPlot, libraries, importLibrary, resampled, brightnessTemperature, xport, destripe, spectralChange, templateMatch, chi2 });

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  const multi = () => (layer()?.bands ?? 0) >= 2;
  const isClass = () => layer()?.msi?.kind === 'classification';
  const aoiRect = (l) => {
    const b = app.aoiBox?.(pane(), l);
    return b ? { x0: Math.round(b.x0), y0: Math.round(b.y0), w: Math.round(b.x1 - b.x0), h: Math.round(b.y1 - b.y0) } : null;
  };
  C.implement('search.find', {
    enabled: multi,
    run: run(async () => {
      const l = layer();
      const cls = classesOf(l);
      const nm = h('input', { class: 'inp', value: `Class ${cls.length + 1}`, 'aria-label': 'Class name' });
      const role = h('select', { class: 'inp', 'aria-label': 'Region role' }, h('option', { value: 'train' }, 'Training'), h('option', { value: 'valid' }, 'Validation'));
      const method = h('select', { class: 'inp', 'aria-label': 'Classifier' }, ...Object.entries(LABEL).map(([v, t]) => h('option', { value: v, selected: v === 'ml' }, t)));
      const grid = h('table', { class: 'tbl', 'data-id': 'class-grid' }, h('thead', {}, h('tr', {}, ...['', 'Name', 'Training px', 'Validation px'].map((t) => h('th', {}, t)))), h('tbody', {}, ...cls.map((c) => h('tr', {}, h('td', { style: `background:rgb(${c.colour.join(',')})` }, ''), h('td', {}, c.name), h('td', {}, String(c.regions.reduce((s, r) => s + r.w * r.h, 0))), h('td', {}, String((c.validation ?? []).reduce((s, r) => s + r.w * r.h, 0)))))));
      const res = await modal({ title: 'Find in Scene — Training Classes', body: h('div', {}, grid, field('New class from the AOI', nm), field('Region', role), field('Classifier', method), h('p', { class: 'hint' }, 'Draw an AOI over a homogeneous area, then Add Region. Separability shows the Jeffries–Matusita distance (2 = fully separable).')), buttons: ['Add Region', 'Separability', 'Classify', 'Close'], width: 560, id: 'find-in-scene' });
      if (res === 'Add Region') {
        const r = aoiRect(l);
        if (!r) throw new Error('draw an AOI first');
        const ex = cls.find((c) => c.name === nm.value);
        if (ex) S.transact(`Region for ${ex.name}`, (tx) => tx.set(ex.id, role.value === 'train' ? 'regions' : 'validation', [...(role.value === 'train' ? ex.regions : ex.validation ?? []), r]));
        else addClass(l, role.value === 'train' ? { name: nm.value, regions: [r] } : { name: nm.value, validation: [r] });
      } else if (res === 'Separability') {
        const s = await separability(l);
        await modal({ title: 'Class Separability (Jeffries–Matusita)', body: h('table', { class: 'tbl', 'data-id': 'jm-table' }, h('tbody', {}, h('tr', {}, h('th', {}, ''), ...s.classes.map((c) => h('th', {}, c.name))), ...s.jm.map((row, i) => h('tr', {}, h('th', {}, s.classes[i].name), ...row.map((v, j) => h('td', {}, i === j ? '–' : v.toFixed(3))))))), buttons: ['Close'], id: 'jm' });
      } else if (res === 'Classify') {
        const P = await classify(l, method.value);
        toast(`${LABEL[method.value]}: ${P.msi.names.length} classes`);
      }
    }),
  });
  C.implement('msi.threshold', {
    enabled: () => isClass() && !!layer().msi.scores,
    run: run(async () => {
      const P = layer();
      const unit = P.msi.method === 'sam' ? 'radians' : P.msi.method === 'ml' ? `χ² (${P.msi.nb} bands; 99.9 %: ${chi2(P.msi.nb).toFixed(1)})` : 'distance';
      const inp = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: Number.isFinite(P.msi.threshold) ? P.msi.threshold : '', 'aria-label': 'Threshold' });
      inp.addEventListener('input', () => setThreshold(P, inp.value === '' ? NaN : Number(inp.value)));
      await modal({ title: 'Classifier Threshold', body: field(`Reject above (${unit}; blank = none)`, inp, 'The map updates as you type.'), buttons: ['Close'], id: 'msi-threshold', modeless: true });
    }),
  });
  C.implement('msi.cluster', {
    enabled: multi,
    run: run(async () => {
      const algo = h('select', { class: 'inp', 'aria-label': 'Algorithm' }, h('option', { value: 'kmeans' }, 'K-means'), h('option', { value: 'isodata' }, 'ISODATA'));
      const k = h('input', { class: 'inp inp-num', type: 'number', value: 6, min: 2, max: 30, 'aria-label': 'Classes' });
      const it = h('input', { class: 'inp inp-num', type: 'number', value: 20, min: 1, 'aria-label': 'Iterations' });
      if ((await modal({ title: 'Unsupervised Classification', body: h('div', {}, field('Algorithm', algo), field('Classes (K-means) / maximum (ISODATA)', k), field('Iterations', it)), buttons: ['Run', 'Cancel'], id: 'msi-cluster' })) !== 'Run') return;
      await cluster(layer(), algo.value, algo.value === 'kmeans' ? { k: Number(k.value), iters: Number(it.value) } : { kMin: Math.max(2, Math.floor(Number(k.value) / 2)), kMax: Number(k.value), iters: Number(it.value) });
    }),
  });
  for (const [cmd, op, param] of [['msi.majority', 'majority', 3], ['msi.sieve', 'sieve', 8], ['msi.fill', 'fill', 0]]) C.implement(cmd, { enabled: isClass, run: run(() => post(layer(), op, param)) });
  C.implement('msi.vectors', { enabled: isClass, run: run(() => toast(`${classVectors(layer()).count} class polygon(s) with area and perimeter`)) });
  C.implement('msi.accuracy', {
    enabled: isClass,
    run: run(async () => {
      const a = await assess(layer());
      await modal({ title: 'Accuracy Assessment', body: accuracyTable(a), buttons: ['Close'], width: 720, id: 'accuracy' });
    }),
  });
  C.implement('msi.detect', {
    enabled: multi,
    run: run(async () => {
      const kind = h('select', { class: 'inp', 'aria-label': 'Detector' }, ...[['rx', 'Global RX'], ['rxlocal', 'Local RX (AOI)'], ['gmm', 'Gaussian-mixture anomaly'], ['mf', 'Matched filter (pinned spectrum)'], ['ace', 'ACE (pinned spectrum)'], ['cem', 'CEM (pinned spectrum)']].map(([v, t]) => h('option', { value: v }, t)));
      const pct = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: 99.9, 'aria-label': 'Percentile' });
      if ((await modal({ title: 'Target and Anomaly Detection', body: h('div', {}, field('Detector', kind), field('Threshold percentile (%)', pct), h('p', { class: 'hint' }, 'Above 32 bands RX, local RX and the GMM run on 20 PCA components.')), buttons: ['Run', 'Cancel'], id: 'msi-detect' })) !== 'Run') return;
      const l = layer();
      const target = app.msi.plot.pinned[0]?.values ?? null;
      const r = await detect(l, kind.value, { percentile: Number(pct.value) / 100, target, window: kind.value === 'rxlocal' ? aoiRect(l) : null });
      toast(`${r.hits.length} detection(s) above ${r.threshold.toPrecision(4)}`);
    }),
  });
  C.implement('msi.pca', {
    enabled: multi,
    run: run(async () => {
      const kind = h('select', { class: 'inp', 'aria-label': 'Transform' }, ...[['pca', 'PCA'], ['mnf', 'MNF'], ['ica', 'ICA (FastICA)'], ['dstretch', 'Decorrelation stretch'], ['unmix', 'Linear unmixing (pinned spectra as endmembers)']].map(([v, t]) => h('option', { value: v }, t)));
      const k = h('input', { class: 'inp inp-num', type: 'number', value: 3, min: 1, 'aria-label': 'Components' });
      if ((await modal({ title: 'Spectral Transforms', body: h('div', {}, field('Transform', kind), field('Components', k)), buttons: ['Run', 'Cancel'], id: 'msi-pca' })) !== 'Run') return;
      const endmembers = kind.value === 'unmix' ? app.msi.plot.pinned.map((s) => s.values) : null;
      if (kind.value === 'unmix' && (endmembers?.length ?? 0) < 2) throw new Error('unmixing needs at least two pinned endmember spectra');
      const r = await components(layer(), kind.value, { k: Number(k.value), endmembers });
      if (r.values) await modal({ title: `${kind.value.toUpperCase()} Eigenvalues`, body: eigenPlot(r.values), buttons: ['Close'], id: 'eigen' });
    }),
  });
  C.implement('msi.library', {
    enabled: () => true,
    run: run(async () => {
      const files = await pickFiles(app, { accept: ['.sli', '.hdr', '.csv', '.txt'], description: 'Spectral library (ENVI .sli + .hdr, CSV, USGS ASCII)' });
      toast(`${(await libraryFiles(files)).length} library spectra`);
    }),
  });
  /** Library files (picker or drop) → spectra; the first four go on the spectral plot of the active image. */
  async function libraryFiles(files) {
    const s = await importLibrary(files);
    const l = layer();
    if (l && s.length) for (const x of s.slice(0, 4)) app.msi.plot.library.push(await resampled(l, x).catch(() => ({ ...x, bands: x.wl.map((cw) => ({ cw })) })));
    app.msi.drawPlot();
    return s;
  }
  app.msi.importLibraryFiles = libraryFiles;
  C.implement('msi.thermal', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const band = h('select', { class: 'inp', 'aria-label': 'Band' }, ...app.msi.bandsOf(l).map((b, i) => h('option', { value: String(i) }, `${i + 1}: ${b.name}`)));
      const em = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: 'blank = BT only', 'aria-label': 'Emissivity' });
      const cel = h('input', { type: 'checkbox', 'aria-label': 'Celsius' });
      // TE-054: a delivered Landsat band file is DN; the dialog takes the MTL and converts it here.
      const dn = !/radiance/i.test(l.radiometry.state);
      const hint = dn ? h('p', { class: 'hint' }, `The band is ${l.radiometry.state}: Run asks for the sensor metadata (Landsat …_MTL.txt) and converts it to radiance first.`) : null;
      if ((await modal({ title: 'Brightness Temperature', body: h('div', {}, field('Thermal band', band), field('Emissivity (water 0.99, vegetation 0.98, soil 0.95)', em), h('label', { class: 'fld fld-inline' }, cel, h('span', {}, '°C')), ...(hint ? [hint] : [])), buttons: ['Run', 'Cancel'], id: 'msi-thermal' })) !== 'Run') return;
      if (dn) {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.txt', '.xml'], description: 'Sensor metadata (Landsat MTL)' });
        if (!f) return;
        await app.msi.fromMetadata(l, f, { target: 'radiance' });
      }
      await brightnessTemperature(l, Number(band.value), { emissivity: em.value === '' ? NaN : Number(em.value), celsius: cel.checked });
    }),
  });
  C.implement('msi.xport', { enabled: () => multi() && !!S.get(layer()?.rec?.file), run: run(() => xport(layer())) });
  C.implement('msi.destripe', { enabled: multi, run: run(() => destripe(layer())) });
  C.implement('msi.change', {
    // A second date needs the active image's band count (TE-043: any two multiband images enabled
    // it, and with no partner the dialog ran on an empty list).
    enabled: () => (layer()?.bands ?? 0) >= 2 && [...app.layers.values()].some((l) => l !== layer() && l.bands === layer().bands),
    run: run(async () => {
      const a = layer();
      const others = [...app.layers.values()].filter((l) => l !== a && l.bands === a.bands);
      if (!others.length) throw new Error(`two-date change needs a second image with ${a.bands} bands`);
      const sel = h('select', { class: 'inp', 'aria-label': 'Second date' }, ...others.map((l) => h('option', { value: l.id }, l.rec?.name ?? l.id)));
      if ((await modal({ title: 'Two-date Spectral Change', body: field('Second date', sel), buttons: ['Run', 'Cancel'], id: 'msi-change' })) !== 'Run') return;
      await spectralChange(a, app.layers.get(sel.value));
    }),
  });
  C.implement('search.template', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const t = aoiRect(l);
      if (!t) throw new Error('draw an AOI around one example of the object first');
      const r = await templateMatch(l, t);
      toast(`${r.hits.length} match(es) at NCC ≥ 0.8`);
    }),
  });
}
