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
import { parseSpecLibText, decodeLibraryText, rankLibrary } from '../formats/speclib.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { num, int } from '../i18n/format.js';

export const name = 'spectral-analysis';

/** Errors that ask for a step first (draw an AOI, add classes): shown as warnings in every language (GUI-044). */
const STEP_CODES = new Set(['E_NEED_AOI', 'E_NEED_CLASSES', 'E_NEED_ENDMEMBERS']);


export const CLASS_COLOURS = [[0, 0, 0], [30, 90, 200], [40, 170, 60], [200, 190, 90], [150, 100, 60], [210, 210, 210], [70, 70, 70], [200, 80, 50], [230, 120, 220], [90, 220, 220], [240, 160, 40], [140, 60, 200]];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const layer = () => app.activeLayer();
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);
  const msi = () => app.msi;
  const spec = (op, ...args) => app.pool.run('spectral', { op, args }, { kind: 'analysis', label: t('spectral {op}', { op }), timeout: 600000 }).then((r) => r.r);

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
      if (window || aoiRect(l)) throw gwError('{tool} works at full resolution on up to {max} M samples; the AOI is {w}×{h}×{nb}: draw a smaller AOI', { tool: fullRes, max: CUBE_MAX / 1e6, w: a.w, h: a.h, nb }, 'E_AOI_TOO_LARGE');
      // No AOI: the largest full-resolution square around the view centre.
      const side = Math.floor(Math.sqrt(CUBE_MAX / nb));
      const c = viewCentre(l);
      const x0 = Math.max(0, Math.min(l.width - side, Math.round(c.x - side / 2)));
      const y0 = Math.max(0, Math.min(l.height - side, Math.round(c.y - side / 2)));
      app.toast(t('{tool} works at full resolution: the {w}×{h} pixels around the view centre (draw an AOI to choose the area).', { tool: fullRes, w: Math.min(side, l.width), h: Math.min(side, l.height) }), { kind: 'info', ms: 9000 });
      return { x0, y0, w: Math.min(side, l.width), h: Math.min(side, l.height), step: 1 };
    }
    if (step > 1) {
      const args = { image: l.rec?.name ?? '', w: a.w, h: a.h, nb, step, side: Math.floor(Math.sqrt(CUBE_MAX / nb)) };
      app.toast(l.rec?.name ? t('{image} is {w}×{h}×{nb}: analysed at every {step, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} pixel. Draw an AOI of up to {side}² pixels for full resolution.', args) : t('The image is {w}×{h}×{nb}: analysed at every {step, selectordinal, one {#st} two {#nd} few {#rd} other {#th}} pixel. Draw an AOI of up to {side}² pixels for full resolution.', args), { kind: 'info', ms: 9000 });
    }
    return { x0: a.x0, y0: a.y0, w: a.w, h: a.h, step };
  }
  app.openMemoryLayer = (parent, o) => openMemoryLayer(app, parent, o);

  // ---- training classes (REQ-MSI-08) ----

  /** Classes of a layer: store records {layer, name, colour, regions: [{x0, y0, w, h}], validation}. */
  const classesOf = (l) => S.all('msiclass').filter((c) => c.layer === l.id).sort((a, b) => a.order - b.order);
  function addClass(l, { name: nm, colour = null, regions = [], validation = [] }) {
    const k = classesOf(l).length;
    let id;
    S.transact(t('Class {name}', { name: nm }), (tx) => {
      id = tx.create('msiclass', { layer: l.id, name: nm, colour: colour ?? CLASS_COLOURS[(k % (CLASS_COLOURS.length - 1)) + 1], regions, validation, order: k });
    });
    return S.get(id);
  }
  function clearClasses(l) {
    S.transact(t('Clear classes'), (tx) => {
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
    const c = usableBands(await msi().cube(l, {}), l).c;
    const sets = cls.map((k) => indicesIn(k.regions, c));
    const r = await spec('train', c.v, c.w, c.h, c.nb, sets);
    return { classes: cls.map((k, i) => ({ ...k, ...r.classes[i] })), jm: r.jm };
  }

  // ---- classification with live thresholds ----

  const LABEL = { md: N_('Minimum distance'), ml: N_('Maximum likelihood'), mahalanobis: N_('Mahalanobis'), sam: N_('Spectral angle (SAM)'), sid: 'SID' };
  /** χ² critical values (α = 0.001) for ML rejection by degrees of freedom. */
  const chi2 = (dof, alpha = 0.001) => {
    // Wilson–Hilferty approximation.
    const z = { 0.05: 1.6449, 0.01: 2.3263, 0.001: 3.0902 }[alpha] ?? 3.0902;
    return dof * (1 - 2 / (9 * dof) + z * Math.sqrt(2 / (9 * dof))) ** 3;
  };

  async function classify(l, method = 'ml', { threshold = NaN, window = null, signatures = null } = {}) {
    const cls = classesOf(l);
    if (!signatures && cls.length < 2) throw gwError('add at least two training classes first (Find in Scene ▸ Add Region)', null, 'E_NEED_CLASSES'); // a precondition, shown as a warning (GUI-044)
    const u = usableBands(await msi().cube(l, fitWindow(l, window)), l);
    const c = u.c;
    const sets = signatures ? null : cls.map((k) => indicesIn(k.regions, c));
    if (sets?.some((s) => s.length < c.nb + 1) && (method === 'ml' || method === 'mahalanobis')) throw gwError('{method} needs at least {min} training pixels per class (better {better})', { method: tr(LABEL[method]), min: c.nb + 1, better: 10 * c.nb }, 'E_TRAINING_PIXELS');
    const r = await spec('classify', c.v, c.w, c.h, c.nb, method, { sets, means: signatures?.map((s) => pick(s.values, u.keep)) ?? null, threshold: NaN });
    const names = signatures ? signatures.map((s) => s.name) : cls.map((k) => k.name);
    const colours = signatures ? signatures.map((_, i) => CLASS_COLOURS[(i % (CLASS_COLOURS.length - 1)) + 1]) : cls.map((k) => k.colour);
    const labels = applyThreshold(r.labels, r.scores, threshold);
    const P = await openMemoryLayer(app, l, { name: t('{product} — {image}', { product: tr(LABEL[method]), image: l.rec?.name ?? '' }), bands: 1, sampleType: 'u8', planes: [labels], nodata: 0, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], ...colours] } }, info: { bandsMeta: [{ name: 'class', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'class labels', gain: null, offset: null, unit: 'class', source: LABEL[method] } } });
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
    const c = usableBands(await msi().cube(l, fitWindow(l, o.window)), l).c;
    const r = await spec(algo, c.v, c.w, c.h, c.nb, o);
    const k = r.centres.length;
    const colours = Array.from({ length: k }, (_, i) => CLASS_COLOURS[(i % (CLASS_COLOURS.length - 1)) + 1]);
    const P = await openMemoryLayer(app, l, { name: t('{algorithm} ({k}) — {image}', { algorithm: algo === 'kmeans' ? 'K-means' : 'ISODATA', k, image: l.rec?.name ?? '' }), bands: 1, sampleType: 'u8', planes: [r.labels], nodata: 0, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'none', kernel: 'nearest', colour: { palette: 'grey', table: [[0, 0, 0], ...colours] } }, info: { bandsMeta: [{ name: 'cluster', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'cluster labels', gain: null, offset: null, unit: 'cluster', source: algo } } });
    P.msi = { kind: 'classification', method: algo, names: colours.map((_, i) => t('Cluster {n}', { n: i + 1 })), colours, labelsAll: r.labels, scores: null, centres: r.centres, window: { x0: c.x0, y0: c.y0, w: c.w, h: c.h, step: c.step }, parent: l.id };
    return P;
  }
  const post = (P, op, param = 3) => {
    const w = P.msi.window.w;
    const hh = P.msi.window.h;
    const cur = P.msi.scores && Number.isFinite(P.msi.threshold) ? applyThreshold(P.msi.labelsAll, P.msi.scores, P.msi.threshold) : P.msi.labelsAll;
    return app.pool.run('spectral', { op: 'post', args: [op, cur, w, hh, param] }, { kind: 'analysis', label: t('clean-up {op}', { op }) }).then(async (r) => {
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
    S.transact(t('Class vectors {layer}', { layer: P.rec?.name ?? '' }), (tx) => {
      vid = tx.create('vlayer', { name: P.rec?.name ? t('{layer} polygons', { layer: P.rec.name }) : t('Classes polygons'), visible: true, style: { stroke: '#ffffff', width: 1, fill: '#ffffff20', outline: '#ffffff' }, fields: [{ name: 'CLASS', type: 'text' }, { name: 'CLASS_ID', type: 'int' }, { name: 'AREA_M2', type: 'real' }, { name: 'PERIM_M', type: 'real' }], source: { format: 'classification' }, created: new Date().toISOString() });
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
    if (!n) throw gwError('no validation regions: add validation rectangles per class (separate from the training regions)', null, 'E_NEED_VALIDATION');
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
    const f3 = (v) => num(v, 3);
    const head = h('tr', {}, h('th', {}, t('Reference ↓ / Mapped →')), ...a.names.map((n) => h('th', {}, n)), h('th', {}, t('Unclassified')), h('th', {}, t('Total')), h('th', {}, t('PA')));
    const rows = a.matrix.map((r, i) => h('tr', {}, h('th', {}, a.names[i]), ...r.map((v) => h('td', {}, int(v))), h('td', {}, int(r.reduce((s, v) => s + v, 0))), h('td', {}, f3(a.producers[i]))));
    const colTot = Array.from({ length: k + 1 }, (_, c) => a.matrix.reduce((s, r) => s + r[c], 0));
    const tot = h('tr', {}, h('th', {}, t('Total')), ...colTot.map((v) => h('td', {}, int(v))), h('td', {}, int(a.n)), h('td', {}, ''));
    const ua = h('tr', {}, h('th', {}, t('UA')), ...a.users.map((v) => h('td', {}, f3(v))), h('td', {}, ''), h('td', {}, ''), h('td', {}, ''));
    return h('div', {}, h('table', { class: 'tbl', 'data-id': 'confusion' }, h('thead', {}, head), h('tbody', {}, ...rows, tot, ua)), h('p', { 'data-id': 'accuracy-summary' }, a.oaArea ? t('Overall accuracy {oa} · κ = {kappa} · quantity disagreement {q} · allocation disagreement {alloc} · area-weighted OA {oaa} ± {ci} (95 %) · n = {n}', { oa: f3(a.oa), kappa: f3(a.kappa), q: f3(a.quantity), alloc: f3(a.allocation), oaa: f3(a.oaArea[0]), ci: f3(a.oaArea[1]), n: a.n }) : t('Overall accuracy {oa} · κ = {kappa} · quantity disagreement {q} · allocation disagreement {alloc} · n = {n}', { oa: f3(a.oa), kappa: f3(a.kappa), q: f3(a.quantity), alloc: f3(a.allocation), n: a.n })), h('p', { class: 'hint' }, t('Rows are reference classes, columns mapped classes. Validation pixels never overlap training pixels when they come from separate regions.')));
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
    const c0 = await msi().cube(l, fitWindow(l, window));
    const fullNb = c0.nb;
    if (target && target.length !== fullNb) throw gwError('{detector} needs a target spectrum with {nb} bands (pin one, or pick a library entry)', { detector: kind.toUpperCase(), nb: fullNb }, 'E_TARGET_SPECTRUM');
    const u = usableBands(c0, l);
    let c = u.c;
    target = pick(target, u.keep);
    let scores;
    if (kind === 'mf' || kind === 'ace' || kind === 'cem') {
      if (!target) throw gwError('{detector} needs a target spectrum with {nb} bands (pin one, or pick a library entry)', { detector: kind.toUpperCase(), nb: fullNb }, 'E_TARGET_SPECTRUM');
      const r = await spec('detect', 'target', c.v, c.w, c.h, c.nb, { step: 4, target });
      scores = r[kind];
    } else {
      c = await reduced(c);
      const r = await spec('detect', kind, c.v, c.w, c.h, c.nb, { step: 4, outer, guard, k });
      scores = r.scores;
    }
    const sorted = Array.from(scores).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length && !Number.isFinite(value)) throw gwError('{detector} gave no finite score: the image has too few pixels or constant bands for this detector', { detector: kind.toUpperCase() }, 'E_NO_FINITE_SCORE');
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
    const shown = { rx: t('Global RX'), rxlocal: t('Local RX'), gmm: t('GMM anomaly'), mf: t('Matched filter'), ace: 'ACE', cem: 'CEM' }[kind];
    const P = await openMemoryLayer(app, l, { name: c.reduced ? t('{product} (PCA {k} of {nb}) — {image}', { product: shown, k: c.reduced.to, nb: fullNb, image: l.rec?.name ?? '' }) : t('{product} — {image}', { product: shown, image: l.rec?.name ?? '' }), bands: 1, sampleType: 'f32', planes: [Float32Array.from(scores)], nodata: NaN, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { stretch: 'linear1', colour: { palette: 'iron' }, clip: { on: true, lo: thr, hi: Infinity } }, info: { bandsMeta: [{ name: names[kind], cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: names[kind], gain: null, offset: null, unit: 'score', source: kind } } });
    P.msi = { kind: 'detection', detector: kind, threshold: thr, hits, reduced: c.reduced };
    app.msi.lastDetect = { kind, threshold: thr, hits, scores, w: c.w, h: c.h, x0: c.x0, y0: c.y0, reduced: c.reduced, layer: P };
    return app.msi.lastDetect;
  }

  // ---- transforms (REQ-MSI-12) ----

  /**
   * The bands an algorithm can use: not flagged bad, and finite in at least half the sampled pixels.
   * A pixel counts only when every band is finite, so one all-NaN band (EnMAP and Hyperion leave their
   * water-vapour bands NaN) left PCA, MNF and RX with no pixels and NaN results (TE 2.0.4 cross).
   * Returns {c, keep}: the cube of those bands, and their indices (null when all are kept).
   */
  function usableBands(c, l) {
    const meta = msi().bandsOf(l);
    const n = c.w * c.h;
    const stride = Math.max(1, Math.floor(n / 4096));
    const keep = [];
    for (let b = 0; b < c.nb; b++) {
      if (meta[b]?.bad) continue;
      let fin = 0;
      let tot = 0;
      for (let p = 0; p < n; p += stride, tot++) if (Number.isFinite(c.v[p * c.nb + b])) fin++;
      if (fin >= tot * 0.5) keep.push(b);
    }
    if (keep.length < 2) throw gwError('only {n, plural, one {# band holds} other {# bands hold}} data in most pixels; the transform needs two or more', { n: keep.length }, 'E_TOO_FEW_BANDS');
    if (keep.length === c.nb) return { c, keep: null };
    const v = new Float32Array(n * keep.length);
    for (let p = 0; p < n; p++) for (let i = 0; i < keep.length; i++) v[p * keep.length + i] = c.v[p * c.nb + keep[i]];
    return { c: { ...c, v, nb: keep.length }, keep };
  }
  const pick = (vals, keep) => (keep && vals ? keep.map((b) => vals[b]) : vals);

  async function components(l, kind = 'pca', { k = 3, window = null, endmembers = null } = {}) {
    const u = usableBands(await msi().cube(l, fitWindow(l, window)), l);
    const c = u.c;
    if (u.keep) endmembers = endmembers?.map((e) => pick(e, u.keep));
    const r = await spec('transform', kind, c.v, c.w, c.h, c.nb, { k, step: 2, endmembers });
    const nb = kind === 'dstretch' ? c.nb : kind === 'unmix' ? endmembers.length + 1 : k;
    const n = c.w * c.h;
    const planes = Array.from({ length: nb }, (_, b) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = r.cube[i * nb + b];
      return p;
    });
    const names = { pca: 'PCA', mnf: 'MNF', ica: 'ICA', dstretch: 'Decorrelation stretch', unmix: 'Abundances' };
    const shown = { pca: 'PCA', mnf: 'MNF', ica: 'ICA', dstretch: t('Decorrelation stretch'), unmix: t('Abundances') }[kind];
    const P = await openMemoryLayer(app, l, { name: t('{product} — {image}', { product: shown, image: l.rec?.name ?? '' }), bands: nb, sampleType: 'f32', planes, nodata: NaN, x0: c.x0, y0: c.y0, step: c.step, width: c.w, height: c.h, chain: { bands: nb >= 3 && kind !== 'unmix' ? [0, 1, 2] : [0], stretch: 'linear2' }, info: { bandsMeta: planes.map((_, i) => ({ name: kind === 'unmix' && i === nb - 1 ? 'RMS residual' : `${names[kind]} ${i + 1}`, cw: NaN, fwhm: NaN, bad: false })), radiometry: { state: names[kind], gain: null, offset: null, unit: 'component', source: kind } } });
    P.msi = { kind: 'transform', transform: kind, values: r.values ?? null, vectors: r.vectors ?? null };
    return { layer: P, values: r.values ?? null };
  }
  function eigenPlot(values) {
    const W = 360;
    const H = 160;
    // Non-finite eigenvalues (a constant or degenerate band set) draw as zero, never as NaN geometry.
    const v = values.map((x) => (Number.isFinite(x) ? Math.max(0, x) : 0));
    const tot = v.reduce((s, x) => s + x, 0) || 1;
    const top = Math.max(...v) || 1;
    const bars = v.slice(0, 40).map((x, i) => `<rect x="${30 + i * 8}" y="${H - 20 - (x / top) * (H - 30)}" width="6" height="${(x / top) * (H - 30)}" fill="#5fd0ff"/>`).join('');
    let cum = 0;
    const line = v.slice(0, 40).map((x, i) => `${34 + i * 8},${H - 20 - ((cum += x) / tot) * (H - 30)}`).join(' ');
    const el = h('div', { 'data-id': 'eigen-plot' });
    const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(t('Eigenvalues'))}"><rect width="${W}" height="${H}" fill="#1b1f24"/>${bars}<polyline points="${line}" fill="none" stroke="#ffcb5f"/><text x="4" y="12" fill="#c8ccd0" font-size="10">${esc(t('eigenvalues (bars), cumulative variance (line)'))}</text></svg>`;
    return el;
  }

  // ---- automatic endmembers (REQ-GAP-82) ----

  /**
   * Endmembers of l: VCA on the leading MNF components (S-62), with, when `skewers` > 0, a Pixel
   * Purity Index layer. Each endmember is the image's own spectrum at the pixel VCA picked; with
   * `pin` they replace the spectra pinned to the Spectral Plot, so unmixing uses them as they are.
   * Returns {endmembers: [{x, y, values, label}], ppi: layer or null, components}.
   */
  async function endmembers(l, { m = 5, skewers = 1000, seed = 1, window = null, pin = true } = {}) {
    const c0 = await msi().cube(l, fitWindow(l, window));
    const { c } = usableBands(c0, l);
    if (!(Number.isInteger(m) && m >= 2 && m <= Math.min(64, c.nb))) throw gwError('the number of endmembers must be 2 to {max} for this image', { max: Math.min(64, c.nb) }, 'E_ENDMEMBER_COUNT');
    const r = await spec('endmembers', c.v, c.w, c.h, c.nb, { m, skewers, seed, step: 2 });
    const bands = msi().bandsOf(l);
    const ems = r.pixels.map((p, i) => {
      const x = c0.x0 + (p % c0.w) * c0.step;
      const y = c0.y0 + Math.floor(p / c0.w) * c0.step;
      return { kind: 'point', x, y, values: Array.from(c0.v.subarray(p * c0.nb, (p + 1) * c0.nb)), std: null, bands, unit: l.radiometry.unit, endmember: true, label: t('EM {n} ({x}, {y})', { n: i + 1, x, y }) };
    });
    if (pin) {
      msi().plot.pinned = [];
      for (const e of ems) msi().pin(e, e.label);
    }
    let ppi = null;
    if (r.ppi?.length) {
      ppi = await openMemoryLayer(app, l, { name: t('{product} — {image}', { product: t('Pixel purity'), image: l.rec?.name ?? '' }), bands: 1, sampleType: 'f32', planes: [r.ppi], nodata: NaN, x0: c0.x0, y0: c0.y0, step: c0.step, width: c0.w, height: c0.h, chain: { bands: [0], stretch: 'linear2' }, info: { bandsMeta: [{ name: 'PPI count', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'PPI', gain: null, offset: null, unit: 'count', source: `PPI, ${skewers} skewers` } } });
      ppi.msi = { kind: 'ppi', skewers };
    }
    return { endmembers: ems, ppi, components: r.components };
  }
  /** Add spectra of l (endmembers or pinned) to the spectral library, with l's band centres. */
  function addToLibrary(l, spectra, { prefix = l.rec?.name ?? t('Image') } = {}) {
    const wl = msi().bandsOf(l).map((b) => b.cw);
    const unit = l.radiometry?.unit ?? '';
    const added = spectra.map((s, i) => ({ name: `${prefix} ${s.label ?? `#${i + 1}`}`, wl: wl.every(Number.isFinite) ? wl : null, values: [...s.values], source: `${prefix} (endmembers)`, quantity: unit === 'reflectance' ? 'reflectance' : unit || 'unknown' }));
    libraries.push(...added);
    return added;
  }

  // ---- libraries (REQ-MSI-13) ----

  // The embedded starter library (USGS splib07b, AVIRIS-2014 channels; acknowledgement in About):
  // the data block data-splib07 (app/src/data/splib07-starter.json), read in the background as the
  // tool starts (a few milliseconds after it is ready). The library's users wait for the read.
  const libraries = [];
  let starterCount = 0;
  const starter = Promise.resolve()
    .then(() => app.gw.text('data-splib07'))
    .then((text) => {
      const STARTER = JSON.parse(text);
      starterCount = STARTER.spectra.length;
      libraries.unshift(...STARTER.spectra.map((s) => ({ name: s.name, chapter: s.chapter, wl: STARTER.wavelengths, values: s.values.map((v) => (v === null ? NaN : v)), source: 'USGS splib07 (embedded starter)', quantity: 'reflectance' })));
    })
    .catch((e) => app.log?.('warn', `starter spectral library: ${e.message}`));
  /** Parse CSV (wavelength, value…), USGS ASCII (one value per line after a title) or ENVI .sli. */
  async function importLibrary(files) {
    await starter; // the starter spectra stay first in the list
    const out = [];
    const hdr = files.find((f) => /\.hdr$/i.test(f.name));
    const sli = files.find((f) => /\.sli$/i.test(f.name));
    if (sli && hdr) {
      const hdrText = await hdr.text();
      const r = await app.pool.run('envihdr', { bytes: new TextEncoder().encode(hdrText), dataLen: sli.size }, { label: t('library header') });
      const n = r.samples;
      const m = r.lines;
      const wl = r.wavelength.map((v) => (v > 100 ? v / 1000 : v));
      const dv = new DataView(await sli.arrayBuffer(), r.headerOffset);
      const le = r.byteOrder === 0;
      const get = r.dataType === 4 ? (o) => dv.getFloat32(o, le) : r.dataType === 5 ? (o) => dv.getFloat64(o, le) : r.dataType === 2 ? (o) => dv.getInt16(o, le) : (o) => dv.getUint16(o, le);
      for (let s = 0; s < m; s++) out.push({ name: r.spectraNames[s] ?? `${sli.name} #${s + 1}`, wl, values: Array.from({ length: n }, (_, i) => get((s * n + i) * r.bytesPerSample)), source: sli.name });
    }
    for (const f of files.filter((x) => /\.(csv|txt)$/i.test(x.name))) {
      const t = decodeLibraryText(await f.arrayBuffer());
      const eco = parseSpecLibText(t, f.name);
      if (eco) {
        out.push(eco);
        continue;
      }
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
    // Importing a file again replaces its spectra: every re-import added a second copy (+16 MB per
    // open of the 8 MB USGS ASD library, CX-087).
    const sources = new Set(good.map((s) => s.source));
    for (let i = libraries.length - 1; i >= 0; i--) if (sources.has(libraries[i].source)) libraries.splice(i, 1);
    libraries.push(...good);
    return good;
  }
  /** A library spectrum resampled to a layer's bands (Gaussian SRFs from centre and FWHM). */
  async function resampled(l, s) {
    const b = msi().bandsOf(l);
    if (!b.every((x) => Number.isFinite(x.cw))) throw gwError('library comparison needs the band centre wavelengths', null, 'E_NO_WAVELENGTHS');
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
    if (!/radiance/i.test(l.radiometry.state)) throw gwError('brightness temperature needs radiance; the band is {state} (Radiometric Conversion first)', { state: l.radiometry.state }, 'E_NEED_RADIANCE');
    const c = await msi().cube(l, { bands: [band] });
    const kv = await spec('bt', c.v, { k1, k2, lambda, emissivity });
    const v = celsius ? kv.map((x) => x - 273.15) : kv;
    return openMemoryLayer(app, l, { name: Number.isFinite(emissivity) ? t('Brightness temperature (ε {e}) ({unit}) — {image}', { e: num(emissivity, 2), unit: celsius ? '°C' : 'K', image: l.rec?.name ?? '' }) : t('Brightness temperature ({unit}) — {image}', { unit: celsius ? '°C' : 'K', image: l.rec?.name ?? '' }), bands: 1, sampleType: 'f32', planes: [v], nodata: NaN, chain: { stretch: 'linear1', colour: { palette: 'iron' } }, info: { bandsMeta: [{ name: 'BT', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: Number.isFinite(emissivity) ? 'surface temperature (single-channel, user ε)' : 'brightness temperature', gain: null, offset: null, unit: celsius ? '°C' : 'K', source: Number.isFinite(k1) ? 'K1/K2' : 'Planck' } } });
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
        S.transact(t('Xport view'), (tx) => {
          tx.create('layer', { ...structuredClone(l.rec), id: undefined, pane: p.id, name: `${l.rec.name} [${list[i].join(' ')}]` }, id);
          tx.set(p.id, 'layers', [...(tx.get(p.id).layers ?? []).filter((x) => !app.layers.has(x) || app.layers.get(x).rec?.file !== l.rec.file), id]);
          tx.set(p.id, 'activeLayer', id);
        });
        [target] = await attachLayers(app, fref, [S.get(id)], { share: l });
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
    const c = await msi().cube(l, fitWindow(l, null, { fullRes: t('Destripe') }));
    const r = await spec('correct', 'destripe', c.v, c.w, c.h, c.nb, {});
    const n = c.w * c.h;
    const planes = Array.from({ length: c.nb }, (_, b) => {
      const p = new Float32Array(n);
      for (let i = 0; i < n; i++) p[i] = r.cube[i * c.nb + b];
      return p;
    });
    return openMemoryLayer(app, l, { name: t('Destriped — {image}', { image: l.rec?.name ?? '' }), bands: c.nb, sampleType: 'f32', planes, nodata: NaN, x0: c.x0, y0: c.y0, width: c.w, height: c.h, chain: { bands: l.chain.bands, stretch: 'dra' }, info: { bandsMeta: msi().bandsOf(l), radiometry: { ...l.radiometry, gain: null, offset: null, state: `${l.radiometry.state}, destriped` } } });
  }
  async function spectralChange(a, b, { threshold = NaN } = {}) {
    if (a.width !== b.width || a.height !== b.height || a.bands !== b.bands) throw new Error('two-date change needs images of the same size and bands (co-register first)');
    const win = fitWindow(a);
    const [ca, cb] = await Promise.all([msi().cube(a, win), msi().cube(b, win)]);
    const r = await spec('correct', 'change', ca.v, ca.w, ca.h, ca.nb, { b: cb.v });
    const P = await openMemoryLayer(app, a, { name: t('Spectral change {a} → {b}', { a: a.rec?.name ?? '', b: b.rec?.name ?? '' }), bands: 2, sampleType: 'f32', planes: [r.magnitude, r.angle], nodata: NaN, x0: ca.x0, y0: ca.y0, step: ca.step, width: ca.w, height: ca.h, chain: { bands: [0], stretch: 'linear1', colour: { palette: 'iron' } }, info: { bandsMeta: [{ name: 'change magnitude', cw: NaN, fwhm: NaN, bad: false }, { name: 'spectral angle (rad)', cw: NaN, fwhm: NaN, bad: false }], radiometry: { state: 'change vector', gain: null, offset: null, unit: a.radiometry.unit, source: 'CVA' } } });
    P.msi = { kind: 'change', magnitude: r.magnitude, angle: r.angle, threshold };
    return P;
  }
  /** Template matching: the template is a window of the layer's displayed band. */
  async function templateMatch(l, tpl, { band = l.chain.bands[0], threshold = 0.8, maxHits = 200 } = {}) {
    const step = Math.max(1, Math.ceil(Math.sqrt((l.width * l.height) / 2048 ** 2)));
    const img = await msi().cube(l, { bands: [band], step });
    const tc = await msi().cube(l, { bands: [band], x0: tpl.x0, y0: tpl.y0, w: tpl.w, h: tpl.h, step });
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
      S.transact(t('Template matches ({n})', { n: hits.length }), (tx) => {
        const vid = tx.create('vlayer', { name: t('Template matches ≥ {threshold}', { threshold: num(threshold, 2) }), visible: true, style: { stroke: '#ffcb5f', width: 2, fill: '#ffcb5f40', outline: '#ffcb5f' }, fields: [{ name: 'NCC', type: 'real' }], source: { format: 'template-match' }, created: new Date().toISOString() });
        for (const q of hits) {
          const g = l.groundAt(q.x, q.y);
          if (g) tx.create('feature', { vlayer: vid, geom: fromParts('Point', [[[g.lon, g.lat, g.h ?? 0]]]), attrs: { NCC: q.ncc }, name: `NCC ${q.ncc.toFixed(3)}`, prov: { kind: 'template-match' } });
        }
      });
    }
    app.msi.lastTemplate = { hits, step };
    return { hits, step };
  }

  Object.assign(app.msi, { classesOf, addClass, clearClasses, separability, classify, setThreshold, cluster, post, classVectors, assess, accuracyTable, detect, components, eigenPlot, endmembers, addToLibrary, libraries, importLibrary, resampled, brightnessTemperature, xport, destripe, spectralChange, templateMatch, chi2 });

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      toast(msgOf(e), { kind: STEP_CODES.has(e?.code) ? 'warn' : 'error', ms: 8000 });
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
      const nm = h('input', { class: 'inp', value: t('Class {n}', { n: cls.length + 1 }), 'aria-label': t('Class name') });
      const role = h('select', { class: 'inp', 'aria-label': t('Region role') }, h('option', { value: 'train' }, t('Training')), h('option', { value: 'valid' }, t('Validation')));
      const method = h('select', { class: 'inp', 'aria-label': t('Classifier') }, ...Object.entries(LABEL).map(([v, label]) => h('option', { value: v, selected: v === 'ml' }, tr(label))));
      const grid = h('table', { class: 'tbl', 'data-id': 'class-grid' }, h('thead', {}, h('tr', {}, ...['', t('Name'), t('Training px'), t('Validation px')].map((x) => h('th', {}, x)))), h('tbody', {}, ...cls.map((c) => h('tr', {}, h('td', { style: `background:rgb(${c.colour.join(',')})` }, ''), h('td', {}, c.name), h('td', {}, int(c.regions.reduce((s, r) => s + r.w * r.h, 0))), h('td', {}, int((c.validation ?? []).reduce((s, r) => s + r.w * r.h, 0)))))));
      const res = await modal({
        title: t('Find in Scene — Training Classes'),
        body: h('div', {}, grid, field(t('New class from the AOI'), nm), field(t('Region'), role), field(t('Classifier'), method), h('p', { class: 'hint' }, t('Draw an AOI over a homogeneous area, then Add Region. Separability shows the Jeffries–Matusita distance (2 = fully separable).'))),
        buttons: [
          { label: t('Add Region'), value: 'add', primary: true },
          { label: t('Separability'), value: 'separability' },
          { label: t('Classify'), value: 'classify' },
          { label: t('Close'), value: 'close' },
        ],
        width: 560,
        id: 'find-in-scene',
      });
      if (res === 'add') {
        const r = aoiRect(l);
        if (!r) throw gwError('draw an AOI first', null, 'E_NEED_AOI');
        const ex = cls.find((c) => c.name === nm.value);
        if (ex) S.transact(t('Region for {name}', { name: ex.name }), (tx) => tx.set(ex.id, role.value === 'train' ? 'regions' : 'validation', [...(role.value === 'train' ? ex.regions : ex.validation ?? []), r]));
        else addClass(l, role.value === 'train' ? { name: nm.value, regions: [r] } : { name: nm.value, validation: [r] });
      } else if (res === 'separability') {
        const s = await separability(l);
        await modal({ title: t('Class Separability (Jeffries–Matusita)'), body: h('table', { class: 'tbl', 'data-id': 'jm-table' }, h('tbody', {}, h('tr', {}, h('th', {}, ''), ...s.classes.map((c) => h('th', {}, c.name))), ...s.jm.map((row, i) => h('tr', {}, h('th', {}, s.classes[i].name), ...row.map((v, j) => h('td', {}, i === j ? '–' : num(v, 3))))))), buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'jm' });
      } else if (res === 'classify') {
        const P = await classify(l, method.value);
        toast(t('{method}: {n, plural, one {# class} other {# classes}}', { method: tr(LABEL[method.value]), n: P.msi.names.length }), { kind: 'info' });
      }
    }),
  });
  C.implement('msi.threshold', {
    enabled: () => isClass() && !!layer().msi.scores,
    run: run(async () => {
      const P = layer();
      const unit = P.msi.method === 'sam' ? t('radians') : P.msi.method === 'ml' ? t('χ² ({n, plural, one {# band} other {# bands}}; 99.9 %: {crit})', { n: P.msi.nb, crit: num(chi2(P.msi.nb), 1) }) : t('distance');
      const inp = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: Number.isFinite(P.msi.threshold) ? P.msi.threshold : '', 'aria-label': t('Threshold') });
      inp.addEventListener('input', () => setThreshold(P, inp.value === '' ? NaN : Number(inp.value)));
      await modal({ title: t('Classifier Threshold'), body: field(t('Reject above ({unit}; blank = none)', { unit }), inp, t('The map updates as you type.')), buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'msi-threshold', modeless: true });
    }),
  });
  C.implement('msi.cluster', {
    enabled: multi,
    run: run(async () => {
      const algo = h('select', { class: 'inp', 'aria-label': t('Algorithm') }, h('option', { value: 'kmeans' }, 'K-means'), h('option', { value: 'isodata' }, 'ISODATA')); // i18n-ignore: algorithm names
      const k = h('input', { class: 'inp inp-num', type: 'number', value: 6, min: 2, max: 30, 'aria-label': t('Classes') });
      const it = h('input', { class: 'inp inp-num', type: 'number', value: 20, min: 1, 'aria-label': t('Iterations') });
      if ((await modal({ title: t('Unsupervised Classification'), body: h('div', {}, field(t('Algorithm'), algo), field(t('Classes (K-means) / maximum (ISODATA)'), k), field(t('Iterations'), it)), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-cluster' })) !== 'run') return;
      await cluster(layer(), algo.value, algo.value === 'kmeans' ? { k: Number(k.value), iters: Number(it.value) } : { kMin: Math.max(2, Math.floor(Number(k.value) / 2)), kMax: Number(k.value), iters: Number(it.value) });
    }),
  });
  for (const [cmd, op, param] of [['msi.majority', 'majority', 3], ['msi.sieve', 'sieve', 8], ['msi.fill', 'fill', 0]]) C.implement(cmd, { enabled: isClass, run: run(() => post(layer(), op, param)) });
  C.implement('msi.vectors', { enabled: isClass, run: run(() => toast(t('{n, plural, one {# class polygon} other {# class polygons}} with area and perimeter', { n: classVectors(layer()).count }), { kind: 'info' })) });
  C.implement('msi.accuracy', {
    enabled: isClass,
    run: run(async () => {
      const a = await assess(layer());
      await modal({ title: t('Accuracy Assessment'), body: accuracyTable(a), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 720, id: 'accuracy' });
    }),
  });
  C.implement('msi.detect', {
    enabled: multi,
    run: run(async () => {
      const kind = h('select', { class: 'inp', 'aria-label': t('Detector') }, ...[['rx', t('Global RX')], ['rxlocal', t('Local RX (AOI)')], ['gmm', t('Gaussian-mixture anomaly')], ['mf', t('Matched filter (pinned spectrum)')], ['ace', t('ACE (pinned spectrum)')], ['cem', t('CEM (pinned spectrum)')]].map(([v, label]) => h('option', { value: v }, label)));
      const pct = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: 99.9, 'aria-label': t('Percentile') });
      if ((await modal({ title: t('Spectral Anomaly Detection'), body: h('div', {}, field(t('Detector'), kind), field(t('Threshold percentile (%)'), pct), h('p', { class: 'hint' }, t('Above 32 bands RX, local RX and the GMM run on 20 PCA components.'))), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-detect' })) !== 'run') return;
      const l = layer();
      const target = app.msi.plot.pinned[0]?.values ?? null;
      const r = await detect(l, kind.value, { percentile: Number(pct.value) / 100, target, window: kind.value === 'rxlocal' ? aoiRect(l) : null });
      toast(t('{n, plural, one {# detection} other {# detections}} above {threshold}', { n: r.hits.length, threshold: Number(r.threshold.toPrecision(4)) }), { kind: 'info' });
    }),
  });
  C.implement('msi.pca', {
    enabled: multi,
    run: run(async () => {
      const kind = h('select', { class: 'inp', 'aria-label': t('Transform') }, ...[['pca', 'PCA'], ['mnf', 'MNF'], ['ica', t('ICA (FastICA)')], ['dstretch', t('Decorrelation stretch')], ['unmix', t('Linear unmixing (pinned spectra as endmembers)')]].map(([v, label]) => h('option', { value: v }, label)));
      const k = h('input', { class: 'inp inp-num', type: 'number', value: 3, min: 1, 'aria-label': t('Components') });
      if ((await modal({ title: t('Spectral Transforms'), body: h('div', {}, field(t('Transform'), kind), field(t('Components'), k)), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-pca' })) !== 'run') return;
      const endmembers = kind.value === 'unmix' ? app.msi.plot.pinned.map((s) => s.values) : null;
      if (kind.value === 'unmix' && (endmembers?.length ?? 0) < 2) throw gwError('unmixing needs at least two pinned endmember spectra', null, 'E_NEED_ENDMEMBERS');
      const r = await components(layer(), kind.value, { k: Number(k.value), endmembers });
      if (r.values) await modal({ title: t('{transform} Eigenvalues', { transform: kind.value.toUpperCase() }), body: eigenPlot(r.values), buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'eigen' });
    }),
  });
  C.implement('msi.endmembers', {
    enabled: () => (layer()?.bands ?? 0) >= 3,
    run: run(async () => {
      const l = layer();
      const max = Math.min(64, l.bands);
      const m = h('input', { class: 'inp inp-num', type: 'number', value: Math.min(5, max), min: 2, max, 'aria-label': t('Endmembers') });
      const sk = h('input', { class: 'inp inp-num', type: 'number', value: 1000, min: 0, max: 100000, step: 100, 'aria-label': t('Purity skewers') });
      const lib = h('input', { type: 'checkbox', 'aria-label': t('Add them to the spectral library') });
      const um = h('input', { type: 'checkbox', checked: true, 'aria-label': t('Unmix with them') });
      const body = h('div', {}, field(t('Endmembers'), m), field(t('Purity skewers (0: no purity image)'), sk), field(t('Add them to the spectral library'), lib), field(t('Unmix with them'), um));
      if ((await modal({ title: t('Automatic Endmembers'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-endmembers' })) !== 'run') return;
      const r = await endmembers(l, { m: Math.round(Number(m.value)), skewers: Math.max(0, Math.round(Number(sk.value) || 0)) });
      if (lib.checked) addToLibrary(l, r.endmembers);
      const n = r.endmembers.length;
      toast(lib.checked ? t('{n, plural, one {# endmember} other {# endmembers}} pinned to the Spectral Plot and added to the spectral library', { n }) : t('{n, plural, one {# endmember} other {# endmembers}} pinned to the Spectral Plot', { n }), { kind: 'info' });
      if (um.checked) await components(l, 'unmix', { endmembers: r.endmembers.map((e) => e.values) });
    }),
  });
  C.implement('msi.library', {
    enabled: () => true,
    run: run(async () => {
      const files = await pickFiles(app, { accept: ['.sli', '.hdr', '.csv', '.txt'], description: t('Spectral library (ENVI .sli + .hdr, CSV, USGS ASCII, ECOSTRESS/ASTER .spectrum.txt)') });
      const s = await libraryFiles(files);
      const other = s.filter((x) => (x.quantity ?? 'reflectance') !== 'reflectance').length;
      toast(other ? t('{n, plural, one {# library spectrum} other {# library spectra}} ({other} not reflectance: shown, left out of matching)', { n: s.length, other }) : t('{n, plural, one {# library spectrum} other {# library spectra}}', { n: s.length }), { kind: 'info' });
    }),
  });
  /** Library files (picker or drop) → spectra; the first four go on the spectral plot of the active image,
   * reflectance first (CX-094: a transmittance spectrum is not comparable with a reflectance image). */
  async function libraryFiles(files) {
    const s = await importLibrary(files);
    const l = layer();
    const first = [...s.filter((x) => (x.quantity ?? 'reflectance') === 'reflectance'), ...s.filter((x) => (x.quantity ?? 'reflectance') !== 'reflectance')].slice(0, 4);
    if (l && s.length) for (const x of first) app.msi.plot.library.push(await plotted(l, x));
    app.msi.drawPlot();
    return s;
  }
  app.msi.importLibraryFiles = libraryFiles;
  const QUANTITY_TAG = { transmittance: N_('transmittance'), emissivity: N_('emissivity'), absorbance: N_('absorbance'), unknown: N_('quantity unknown') };
  const plotted = (l, x) => resampled(l, x).then((r) => ({ ...r, label: tagged(x) })).catch(() => ({ ...x, label: tagged(x), bands: x.wl.map((cw) => ({ cw })) }));
  const tagged = (x) => (QUANTITY_TAG[x.quantity] ? `${x.name} [${tr(QUANTITY_TAG[x.quantity])}]` : x.name);

  // IMP-26: the library browser. An import of the full ECOSTRESS library (3,451 spectra) put four on the
  // plot and left the rest out of reach; here every imported spectrum can be found, ranked by spectral
  // angle against the first pinned (or cursor) spectrum, plotted, or pinned for SAM, detection and unmixing.
  const BROWSE_ROWS = 200;
  async function browseLibrary() {
    await starter;
    const l = layer();
    const bands = l ? msi().bandsOf(l) : [];
    const centres = bands.map((b) => b.cw);
    const canRank = bands.length >= 3 && centres.every(Number.isFinite);
    const tgt = app.msi.plot.pinned[0] ?? app.msi.plot.last ?? null;
    const q = h('input', { class: 'inp', type: 'search', placeholder: t('Name, type, class or file'), 'aria-label': t('Filter spectra') });
    const kind = h('select', { class: 'inp', 'aria-label': t('Quantity') }, ...[['all', t('All quantities')], ['reflectance', t('Reflectance')], ['transmittance', t('Transmittance')], ['other', t('Other')]].map(([v, label]) => h('option', { value: v }, label)));
    const list = h('div', { 'data-id': 'library-list', style: { maxHeight: '320px', overflow: 'auto' } });
    const count = h('p', { class: 'hint', 'data-id': 'library-count' });
    const picked = new Set();
    let ranked = null;
    const matches = (s) => {
      const k = kind.value;
      const qty = s.quantity ?? 'reflectance';
      if (k !== 'all' && (k === 'other' ? ['reflectance', 'transmittance'].includes(qty) : qty !== k)) return false;
      const f = q.value.trim().toLowerCase();
      return !f || [s.name, s.source, s.chapter, s.meta?.type, s.meta?.class].some((x) => x && String(x).toLowerCase().includes(f));
    };
    const render = () => {
      list.replaceChildren();
      const rows = ranked ? ranked.filter((r) => matches(r.spectrum)) : libraries.filter(matches).map((spectrum) => ({ spectrum }));
      const parts = [ranked ? t('{n} of {total} spectra (ranked, reflectance only)', { n: rows.length, total: libraries.length }) : t('{n} of {total} spectra', { n: rows.length, total: libraries.length })];
      if (rows.length > BROWSE_ROWS) parts.push(t('showing {max}, narrow the filter', { max: BROWSE_ROWS }));
      count.textContent = parts.join('; ');
      for (const { spectrum: s, angle } of rows.slice(0, BROWSE_ROWS)) {
        const cb = h('input', { type: 'checkbox', checked: picked.has(s), 'aria-label': t('Select {name}', { name: s.name }), onchange: (e) => (e.target.checked ? picked.add(s) : picked.delete(s)) });
        const range = s.wl ? t('{from}–{to} µm', { from: num(s.wl[0], 2), to: num(s.wl[s.wl.length - 1], 2) }) : '';
        list.append(h('label', { class: 'fld fld-inline', title: s.source }, cb, h('span', {}, [Number.isFinite(angle) ? t('{angle} rad', { angle: num(angle, 4) }) : '', tagged(s), s.meta?.type || s.chapter || '', range].filter(Boolean).join(' · '))));
      }
    };
    // Bad bands and the deep water-vapour windows (1.34–1.45, 1.79–1.97 µm) carry noise, not material, in
    // any reflectance product: an AVIRIS pixel ranked "Fine Snow" first while they counted.
    const masked = (v, i) => (bands[i]?.bad || (centres[i] > 1.34 && centres[i] < 1.45) || (centres[i] > 1.79 && centres[i] < 1.97) ? NaN : v);
    const rank = () => {
      ranked = rankLibrary(tgt.values.map(masked), centres, bands.map((b) => b.fwhm), libraries, { limit: libraries.length });
      render();
    };
    const rankBtn = h('button', { class: 'btn', disabled: !(canRank && tgt), title: canRank ? (tgt ? '' : t('Pin a spectrum (or hover the image) first')) : t('The active image needs band centre wavelengths'), onclick: rank }, app.msi.plot.pinned[0] ? t('Rank by match to {spectrum}', { spectrum: app.msi.plot.pinned[0].label }) : t('Rank by match to cursor'));
    const importBtn = h('button', { class: 'btn', onclick: async () => {
      const files = await pickFiles(app, { accept: ['.sli', '.hdr', '.csv', '.txt'], description: t('Spectral library (ENVI .sli + .hdr, CSV, USGS ASCII, ECOSTRESS/ASTER .spectrum.txt)') });
      if (files?.length) await importLibrary(files);
      ranked = null;
      render();
    } }, t('Import…'));
    q.addEventListener('input', render);
    kind.addEventListener('change', render);
    // The ranking runs on open when it can, so Apply with nothing ticked pins the best match.
    if (canRank && tgt) rank();
    else render();
    const body = h('div', {}, h('div', { class: 'tb-row' }, q, kind, importBtn, rankBtn), count, list, h('p', { class: 'hint' }, t('Apply pins the ticked spectra (or the best match) on the Spectral Plot, resampled to the image bands, for SAM, target detection and unmixing.')));
    if ((await modal({ title: t('Spectral Library Browser'), body, buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Close'), value: 'close' }], width: 640, id: 'msi-library-browse' })) !== 'apply') return null;
    const chosen = picked.size ? [...picked] : ranked?.length ? [ranked[0].spectrum] : [];
    if (!chosen.length) return [];
    for (const s of chosen) {
      if ((s.quantity ?? 'reflectance') !== 'reflectance') toast(t('{name} is {quantity}, not reflectance: its angle to an image spectrum is not a material match', { name: s.name, quantity: QUANTITY_TAG[s.quantity] ? tr(QUANTITY_TAG[s.quantity]) : s.quantity }), { kind: 'warn' });
      if (l) app.msi.pin(await plotted(l, s), tagged(s));
      else app.msi.plot.library.push({ ...s, label: tagged(s), bands: s.wl.map((cw) => ({ cw })) });
    }
    app.msi.drawPlot();
    return chosen;
  }
  app.msi.browseLibrary = browseLibrary;
  C.implement('msi.library.browse', {
    // With imported spectra, or a multiband image to rank the starter library against.
    enabled: () => libraries.length > starterCount || multi(),
    run: run(async () => {
      const s = await browseLibrary();
      if (s?.length) toast(t('{n, plural, one {# library spectrum} other {# library spectra}} pinned', { n: s.length }), { kind: 'info' });
    }),
  });
  C.implement('msi.thermal', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const band = h('select', { class: 'inp', 'aria-label': t('Band') }, ...app.msi.bandsOf(l).map((b, i) => h('option', { value: String(i) }, `${i + 1}: ${b.name}`)));
      const em = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: t('blank = BT only'), 'aria-label': t('Emissivity') });
      const cel = h('input', { type: 'checkbox', 'aria-label': t('Celsius') });
      // TE-054: a delivered Landsat band file is DN; the dialog takes the MTL and converts it here.
      const dn = !/radiance/i.test(l.radiometry.state);
      const hint = dn ? h('p', { class: 'hint' }, t('The band is {state}: Run asks for the sensor metadata (Landsat …_MTL.txt) and converts it to radiance first.', { state: l.radiometry.state })) : null;
      if ((await modal({ title: t('Brightness Temperature'), body: h('div', {}, field(t('Thermal band'), band), field(t('Emissivity (water {water}, vegetation {veg}, soil {soil})', { water: num(0.99, 2), veg: num(0.98, 2), soil: num(0.95, 2) }), em), h('label', { class: 'fld fld-inline' }, cel, h('span', {}, '°C')), ...(hint ? [hint] : [])), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-thermal' })) !== 'run') return; // i18n-ignore: °C is a unit symbol
      if (dn) {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.txt', '.xml'], description: t('Sensor metadata (Landsat MTL)') });
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
      if (!others.length) throw gwError('two-date change needs a second image with {n} bands', { n: a.bands }, 'E_NEED_SECOND_DATE');
      const sel = h('select', { class: 'inp', 'aria-label': t('Second date') }, ...others.map((l) => h('option', { value: l.id }, l.rec?.name ?? l.id)));
      if ((await modal({ title: t('Two-date Spectral Change'), body: field(t('Second date'), sel), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'msi-change' })) !== 'run') return;
      await spectralChange(a, app.layers.get(sel.value));
    }),
  });
  C.implement('search.template', {
    enabled: () => !!layer(),
    run: run(async () => {
      const l = layer();
      const box = aoiRect(l);
      if (!box) throw gwError('draw an AOI around one example of the object first', null, 'E_NEED_AOI');
      const r = await templateMatch(l, box);
      toast(t('{n, plural, one {# match} other {# matches}} at NCC ≥ {threshold}', { n: r.hits.length, threshold: num(0.8, 1) }), { kind: 'info' });
    }),
  });
}
