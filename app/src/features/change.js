// Layer Tools ▸ Change (SCN-11; AT-11.3/11.4): detect change candidates between two dates in a
// panel, list them, and confirm or reject each one. A confirmed change stores both image IDs
// and dates. Images on one pixel grid are compared directly; others are resampled onto the
// date-1 grid through their sensor models.

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { detectChanges } from '../analysis/change.js';
import { fmtDate } from './compare.js';

export const name = 'change';

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const images = () => pane()?.layers().filter((l) => l.kind !== 'dem' && l.modelId) ?? [];

  // TE-052: up to MAX_PIXELS of date 1 in one run; a larger date 1 is scoped to the active AOI.
  const MAX_PIXELS = 32e6;

  /** One band of a window [x0, y0, w, h] (whole image when null), no-data as NaN (TE-053). */
  async function bandOf(l, window = null) {
    const g = await app.pool.run('grid', { handle: l.handle, band: l.chain.bands[0] ?? 0, maxSamples: MAX_PIXELS, window, what: 'change detection' }, { affinity: l.affinity, label: `change: read ${l.rec.name}`, timeout: 300000 });
    if (l.nodata !== null && l.nodata !== undefined && !Number.isNaN(l.nodata)) for (let i = 0; i < g.heights.length; i++) if (g.heights[i] === l.nodata) g.heights[i] = NaN;
    return g;
  }

  /** The date-1 window to compare: the whole image, or the active AOI when date 1 is too large. */
  function windowOf(p, l1) {
    if (l1.width * l1.height <= MAX_PIXELS) return null;
    const b = app.aoiBox?.(p, l1);
    const big = `date 1 is ${l1.width}×${l1.height} (${((l1.width * l1.height) / 1e6).toFixed(0)} M pixels)`;
    if (!b) throw new Error(`${big}: draw an AOI (up to ${MAX_PIXELS / 1e6} M pixels) to scope the detection`);
    const w = [Math.max(0, Math.floor(b.x0)), Math.max(0, Math.floor(b.y0))];
    w.push(Math.min(l1.width, Math.ceil(b.x1)) - w[0], Math.min(l1.height, Math.ceil(b.y1)) - w[1]);
    if (w[2] * w[3] > MAX_PIXELS) throw new Error(`${big} and the AOI is ${w[2]}×${w[3]}: draw a smaller AOI (up to ${MAX_PIXELS / 1e6} M pixels)`);
    return w;
  }

  /** date-2 values on the date-1 window w1 = [x0, y0, w, h]; {values, sameGrid}. */
  async function onGrid(l1, l2, w1) {
    const probes = [[0.1, 0.1], [0.9, 0.1], [0.5, 0.5], [0.1, 0.9], [0.9, 0.9]];
    const same =
      l1.width === l2.width &&
      l1.height === l2.height &&
      probes.every(([fx, fy]) => {
        const g = l1.groundAt(fx * l1.width, fy * l1.height);
        const q = g && l2.imageAt(g.lat, g.lon, g.h);
        return q && Math.hypot(q.x - fx * l1.width, q.y - fy * l1.height) < 0.5;
      });
    if (same) return { values: (await bandOf(l2, w1)).heights, sameGrid: true };
    // Only the part of date 2 that covers the date-1 window is read.
    const [X0, Y0, W, H] = w1;
    const q = [[X0, Y0], [X0 + W, Y0], [X0, Y0 + H], [X0 + W, Y0 + H], [X0 + W / 2, Y0 + H / 2]].map(([x, y]) => {
      const g = l1.groundAt(x, y);
      return g && l2.imageAt(g.lat, g.lon, g.h);
    }).filter(Boolean);
    if (!q.length) throw new Error('date 2 does not cover date 1');
    const bx0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.x))) - 2);
    const by0 = Math.max(0, Math.floor(Math.min(...q.map((p) => p.y))) - 2);
    const bx1 = Math.min(l2.width, Math.ceil(Math.max(...q.map((p) => p.x))) + 2);
    const by1 = Math.min(l2.height, Math.ceil(Math.max(...q.map((p) => p.y))) + 2);
    if (bx1 <= bx0 || by1 <= by0) throw new Error('date 2 does not cover date 1');
    const g2 = await bandOf(l2, [bx0, by0, bx1 - bx0, by1 - by0]);
    const out = new Float32Array(W * H).fill(NaN);
    const rows = 64;
    for (let y0 = 0; y0 < H; y0 += rows) {
      const n = Math.min(rows, H - y0) * W;
      const pts = new Float64Array(n * 3);
      for (let k = 0; k < n; k++) {
        const x = X0 + (k % W) + 0.5;
        const y = Y0 + y0 + Math.floor(k / W) + 0.5;
        const g = l1.groundAt(x, y);
        pts.set(g ? [g.lat, g.lon, g.h] : [NaN, NaN, 0], k * 3);
      }
      let xy;
      try {
        xy = app.core.g2iBatch(l2.modelId, pts);
      } catch {
        continue;
      }
      for (let k = 0; k < n; k++) {
        const x = xy[2 * k] - 0.5 - g2.x0;
        const y = xy[2 * k + 1] - 0.5 - g2.y0;
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        if (!(xi >= 0 && yi >= 0 && xi < g2.width - 1 && yi < g2.height - 1)) continue;
        const fx = x - xi;
        const fy = y - yi;
        const v = g2.heights;
        const i = yi * g2.width + xi;
        out[y0 * W + k] = (v[i] * (1 - fx) + v[i + 1] * fx) * (1 - fy) + (v[i + g2.width] * (1 - fx) + v[i + g2.width + 1] * fx) * fy;
      }
      await new Promise((r) => setTimeout(r, 0));
    }
    return { values: out, sameGrid: false };
  }

  C.implement('chg.detect', {
    enabled: () => images().length >= 2,
    run: async () => {
      const p = pane();
      const ls = images();
      const pick = (v) => {
        const s = h('select', { class: 'inp' }, ls.map((l) => h('option', { value: l.id }, `${l.rec.name} — ${fmtDate(l.info.datetime)}`)));
        s.value = v;
        return s;
      };
      const d1 = pick(ls[0].id);
      const d2 = pick(ls.at(-1).id);
      const k = h('input', { class: 'inp inp-num', type: 'number', min: '1', max: '20', step: '0.5', value: '4', 'aria-label': 'Threshold in robust σ' });
      const minA = h('input', { class: 'inp inp-num', type: 'number', min: '1', step: '1', value: '30', 'aria-label': 'Minimum area in pixels' });
      const body = h('div', {}, field('Date 1 (earlier)', d1), field('Date 2 (later)', d2), section('Settings', field('Threshold (robust σ of the difference)', k), field('Minimum area (date-1 pixels)', minA)), h('p', { class: 'hint' }, 'Date 2 is normalised to date 1 (orthogonal regression), differenced, smoothed and thresholded; blobs above the minimum area become candidates. Up to 32 M date-1 pixels; a larger image is compared over the active AOI.'));
      if ((await modal({ title: 'Change Detection', body, buttons: ['Detect', 'Cancel'], id: 'change-detect' })) !== 'Detect') return;
      const l1 = app.layers.get(d1.value);
      const l2 = app.layers.get(d2.value);
      if (l1 === l2) return app.toast('Choose two different images', { kind: 'warn' });
      const t0 = performance.now();
      let r;
      let sameGrid;
      try {
        const win = windowOf(p, l1);
        const g1 = await bandOf(l1, win);
        const v2 = await onGrid(l1, l2, [g1.x0, g1.y0, g1.width, g1.height]);
        sameGrid = v2.sameGrid;
        // No-data is NaN in both dates (bandOf); candidates come back in date-1 image pixels.
        r = detectChanges(g1.heights, v2.values, g1.width, g1.height, { k: +k.value || 4, minArea: +minA.value || 30 });
        for (const c of r.candidates) Object.assign(c, { x0: c.x0 + g1.x0, x1: c.x1 + g1.x0, y0: c.y0 + g1.y0, y1: c.y1 + g1.y0 });
        // An active AOI scopes the result (REQ-IMG-30).
        const inAoi = app.aoiContainsImage?.(p, l1);
        if (inAoi) r.candidates = r.candidates.filter((c) => inAoi((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2));
      } catch (e) {
        return app.toast(`Change detection failed: ${e.message}`, { kind: 'error' });
      }
      const batch = new Date().toISOString();
      app.store.transact(`Change detection (${r.candidates.length})`, (tx) => {
        let gl = p.rec.graphicsLayer;
        if (!gl) {
          gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
          tx.set(p.id, 'graphicsLayer', gl);
        }
        r.candidates.forEach((c, i) => {
          const ring = [[c.x0, c.y0], [c.x1, c.y0], [c.x1, c.y1], [c.x0, c.y1]].map(([x, y]) => l1.groundAt(x, y));
          if (ring.some((g) => !g)) return;
          const gid = tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polygon', anchor: 'ground', coords: ring.map((g) => [g.lon, g.lat, g.h]), text: `CH${i + 1}`, style: { stroke: '#ff00ff', width: 2, fill: '#ff00ff22', dash: 'dashed' }, created: batch, provenance: { kind: 'change-detection' } });
          tx.create('change', {
            name: `CH${i + 1}`,
            status: 'candidate',
            pane: p.id,
            graphic: gid,
            bbox: [c.x0, c.y0, c.x1, c.y1],
            areaPx: c.area,
            score: +(c.mean * Math.sqrt(c.area)).toFixed(2),
            meanDiff: +c.mean.toFixed(2),
            image1: { layer: l1.id, name: l1.rec.name, iid: l1.info.iid ?? null, date: l1.info.datetime },
            image2: { layer: l2.id, name: l2.rec.name, iid: l2.info.iid ?? null, date: l2.info.datetime },
            method: { gain: +r.gain.toFixed(4), offset: +r.offset.toFixed(2), threshold: +r.threshold.toFixed(2), k: +k.value, minArea: +minA.value, sameGrid },
            created: batch,
          });
        });
      });
      p.invalidate();
      app.toast(`${r.candidates.length} change candidate(s) in ${Math.round(performance.now() - t0)} ms (gain ${r.gain.toFixed(3)}, offset ${r.offset.toFixed(1)})`);
      list();
    },
  });

  const setStatus = (ids, status) =>
    app.store.transact(`${status === 'confirmed' ? 'Confirm' : 'Reject'} change`, (tx) => {
      for (const id of ids) {
        const c = app.store.get(id);
        if (!c) continue;
        tx.set(id, 'status', status);
        tx.set(id, 'decided', { at: new Date().toISOString(), by: app.prefs.get('analyst') ?? 'analyst' });
        if (c.graphic && app.store.has(c.graphic)) tx.set(c.graphic, 'style', { stroke: status === 'confirmed' ? '#00ff40' : '#808080', width: 2, fill: status === 'confirmed' ? '#00ff4022' : '#80808011', dash: status === 'confirmed' ? 'solid' : 'dotted' });
      }
    });

  let listDlg = null;
  function list() {
    if (listDlg) return;
    const body = h('div');
    const render = () => {
      clear(body);
      const cs = app.store.all('change').filter((c) => c.pane === pane()?.id);
      if (!cs.length) return body.appendChild(h('p', {}, 'No change candidates. Layer Tools ▸ Change ▸ Change Detection.'));
      const tb = h('tbody');
      for (const c of cs) {
        const go = h('button', { class: 'btn btn-small' }, 'Go');
        go.addEventListener('click', () => {
          const p = pane();
          p.centreOn((c.bbox[0] + c.bbox[2]) / 2, (c.bbox[1] + c.bbox[3]) / 2);
          app.selection = new Set([c.graphic]);
          p.invalidate();
        });
        const ok = h('button', { class: 'btn btn-small', disabled: c.status === 'confirmed' }, 'Confirm');
        ok.addEventListener('click', () => setStatus([c.id], 'confirmed'));
        const no = h('button', { class: 'btn btn-small', disabled: c.status === 'rejected' }, 'Reject');
        no.addEventListener('click', () => setStatus([c.id], 'rejected'));
        tb.appendChild(h('tr', { 'data-id': `change:${c.id}` }, h('td', {}, c.name), h('td', {}, c.status), h('td', {}, String(c.areaPx)), h('td', {}, c.meanDiff.toFixed(1)), h('td', {}, go, ok, no)));
      }
      const first = cs[0];
      body.append(h('p', { class: 'hint' }, `Date 1 ${first.image1.name} (${fmtDate(first.image1.date)}) · date 2 ${first.image2.name} (${fmtDate(first.image2.date)})`), h('table', { class: 'grid-table', 'aria-label': 'Change candidates' }, h('thead', {}, h('tr', {}, ['ID', 'Status', 'Area (px)', 'Mean |Δ|', ''].map((x) => h('th', {}, x)))), tb));
    };
    render();
    const off = app.store.on('change', render);
    listDlg = modal({ title: 'Change Candidates', body, buttons: ['Close'], width: 520, modeless: true, id: 'change-list' }).then(() => {
      off();
      listDlg = null;
    });
  }
  app.changeList = list;

  C.implement('chg.confirm', {
    enabled: () => app.store.all('change').length > 0,
    run: () => {
      // Confirm the changes whose outlines are selected; otherwise open the list.
      const ids = app.store.all('change').filter((c) => app.selection.has(c.graphic)).map((c) => c.id);
      if (ids.length) {
        setStatus(ids, 'confirmed');
        app.toast(`${ids.length} change(s) confirmed`);
      } else list();
    },
  });
}
