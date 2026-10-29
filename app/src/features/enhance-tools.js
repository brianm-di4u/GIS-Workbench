// Image Tools ▸ Enhance, second part (REQ-IMG-06, REQ-IMG-08, REQ-IMG-09, REQ-IMG-19):
// the sharpness slider, spatial filters (S6), the filter settings dialog with the 5×5 MTF
// kernel slot, the transparency threshold, the tonal curve editor and the histogram editor
// with per-band stretch handles. Every change is one undoable chain op (drags coalesce).

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { FILTERS, applyCurve, stretchRange, histBinValue } from '../render/chain.js';

export const name = 'enhance-tools';

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';

/** Draw a histogram (log-scaled counts) into a canvas. */
function drawHist(g, hist, w, ht, x0, x1, colour) {
  if (!hist?.count) return;
  const n = hist.bins.length;
  const cols = new Float64Array(w);
  for (let i = 0; i < n; i++) {
    if (!hist.bins[i]) continue;
    const v = histBinValue(hist, i);
    const c = Math.floor(((v - x0) / (x1 - x0 || 1)) * (w - 1));
    if (c >= 0 && c < w) cols[c] += hist.bins[i];
  }
  let max = 0;
  for (const c of cols) max = Math.max(max, Math.log1p(c));
  g.fillStyle = colour;
  for (let x = 0; x < w; x++) {
    const v = max ? Math.log1p(cols[x]) / max : 0;
    g.fillRect(x, ht - v * ht, 1, v * ht);
  }
}

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer();
  const has = () => !!layer()?.chain;
  const setFilter = (op, extra = {}) => app.setChain((c) => (c.filter = { ...c.filter, op, ...extra }), `Filter: ${op}`);

  C.implement('enh.sharpness', {
    run: () => {},
    enabled: has,
    value: () => Math.round((layer()?.chain?.sharpen?.usm ?? 0) * 50),
    setValue: (v) => app.setChain((c) => (c.sharpen = { ...c.sharpen, usm: v / 50 }), 'Sharpness', { mergeKey: `slider:sharpness:${layer()?.id}` }),
  });

  for (const [cmd, op] of [['enh.sharpen', 'sharpen'], ['enh.edge', 'edge'], ['enh.smooth', 'smooth'], ['enh.median', 'median']]) {
    C.implement(cmd, {
      enabled: has,
      checked: () => layer()?.chain?.filter?.op === op,
      run: () => setFilter(layer().chain.filter?.op === op ? 'none' : op),
    });
  }

  C.implement('enh.morph', {
    enabled: has,
    checked: () => ['dilate', 'erode', 'mtf'].includes(layer()?.chain?.filter?.op),
    run: async () => {
      const f = { ...layer().chain.filter };
      const op = h('select', { class: 'inp' }, FILTERS.map(([v, l]) => h('option', { value: v }, l)));
      op.value = f.op;
      const size = h('select', { class: 'inp inp-short' }, h('option', { value: '3' }, '3 × 3'), h('option', { value: '5' }, '5 × 5'));
      size.value = String(f.size ?? 3);
      const strength = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', max: '4', step: '0.1', value: String(f.strength ?? 1) });
      // MTF compensation kernel slot: 25 weights, row-major; default is a mild 5×5 MTFC.
      const def = f.mtf ?? [0, 0, -0.05, 0, 0, 0, -0.1, -0.2, -0.1, 0, -0.05, -0.2, 2.3, -0.2, -0.05, 0, -0.1, -0.2, -0.1, 0, 0, 0, -0.05, 0, 0];
      const cells = def.map((v, i) => h('input', { class: 'inp inp-num mtf-cell', type: 'number', step: '0.01', value: String(v), 'aria-label': `MTF weight row ${Math.floor(i / 5) + 1} column ${(i % 5) + 1}` }));
      const sum = h('span', { class: 'hint' });
      const upd = () => (sum.textContent = `Sum of weights: ${cells.reduce((a, c) => a + Number(c.value || 0), 0).toFixed(3)} (1 keeps the mean brightness)`);
      cells.forEach((c) => c.addEventListener('input', upd));
      upd();
      const grid = h('div', { class: 'mtf-grid' }, cells);
      const body = h('div', {}, section('Filter', field('Operation', op), field('Size (dilate, erode, smooth)', size), field('Strength (sharpen)', strength)), section('MTF compensation kernel (5 × 5)', grid, sum), h('p', { class: 'hint' }, 'Filters run on the pixels of the displayed resolution level, before the stretch. Median works on 3 × 3. While a filter is on, bicubic and Lanczos fall back to bilinear.'));
      const r = await modal({ title: 'Filter Settings', body, buttons: ['OK', 'Cancel'], width: 520, id: 'filter-settings' });
      if (r !== 'OK') return;
      setFilter(op.value, { size: Number(size.value), strength: Number(strength.value) || 1, mtf: cells.map((c) => Number(c.value) || 0) });
    },
  });

  // ---- clip pixels ----
  C.implement('clip.void', { enabled: has, checked: () => layer()?.chain?.voids !== false, run: () => app.setChain((c) => (c.voids = c.voids === false), 'Remove void pixels') });
  C.implement('clip.threshold', {
    enabled: has,
    checked: () => !!layer()?.chain?.clip?.on,
    run: async () => {
      const l = layer();
      const c = l.chain.clip;
      const st = l.stats?.[l.chain.bands[0]];
      const dmin = st ? histBinValue(st, st.bins.findIndex((x) => x > 0)) : 0;
      const on = h('input', { type: 'checkbox', checked: c.on || !c.on });
      const lo = h('input', { class: 'inp inp-num', type: 'number', value: String(c.on ? c.lo : dmin), step: 'any' });
      const hi = h('input', { class: 'inp inp-num', type: 'number', value: String(c.on ? c.hi : st?.type === 'u8' ? 255 : 65535), step: 'any' });
      const body = h('div', {}, h('label', { class: 'fld fld-inline' }, on, h('span', {}, 'Make pixels outside the range transparent')), field('Transparent below (DN)', lo), field('Transparent above (DN)', hi), h('p', { class: 'hint' }, 'For colour composites a pixel is transparent when all three bands are below the low value or above the high value.'));
      const r = await modal({ title: 'Transparency Threshold', body, buttons: ['OK', 'Cancel'], id: 'clip-threshold' });
      if (r === 'OK') app.setChain((ch) => (ch.clip = { on: on.checked, lo: Number(lo.value), hi: Number(hi.value) }), 'Transparency threshold');
    },
  });

  // ---- tonal curve ----
  let curveDlg = null;
  C.implement('enh.curve', {
    enabled: has,
    checked: () => !!curveDlg,
    run: () => {
      if (curveDlg) return curveDlg.focus();
      const W = 280;
      const H = 280;
      const cv = h('canvas', { class: 'curve-canvas', width: String(W), height: String(H), tabindex: '0', 'aria-label': 'Tonal curve: drag points; click adds a point; double-click removes one; arrow keys move the selected point' });
      const pts = () => layer()?.chain?.tone.curve ?? [[0, 0], [1, 1]];
      let sel = -1;
      const set = (p, merge = true) =>
        app.setChain((c) => (c.tone = { ...c.tone, curve: p.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]) }), 'Tonal curve', { mergeKey: merge ? `curve:${layer()?.id}` : undefined });
      const draw = () => {
        const g = cv.getContext('2d');
        g.fillStyle = css('--c-content-bg');
        g.fillRect(0, 0, W, H);
        const l = layer();
        const hst = l?.stats?.[l.chain.bands[0]];
        if (hst) {
          const r = stretchRange(hst, l.chain, l.chain.bands[0]);
          g.globalAlpha = 0.45;
          drawHist(g, hst, W, H, r.lo, r.hi, css('--c-chart-fill'));
          g.globalAlpha = 1;
        }
        // Chart colours are theme tokens (DN-60), read at each draw.
        g.strokeStyle = css('--c-chart-grid');
        g.beginPath();
        for (let i = 1; i < 4; i++) {
          g.moveTo((i * W) / 4, 0);
          g.lineTo((i * W) / 4, H);
          g.moveTo(0, (i * H) / 4);
          g.lineTo(W, (i * H) / 4);
        }
        g.stroke();
        const p = pts();
        g.strokeStyle = css('--c-content-text');
        g.lineWidth = 2;
        g.beginPath();
        for (let x = 0; x <= W; x++) {
          const y = applyCurve(x / W, p);
          if (x) g.lineTo(x, H - y * H);
          else g.moveTo(x, H - y * H);
        }
        g.stroke();
        p.forEach(([x, y], i) => {
          g.fillStyle = i === sel ? css('--c-chart-handle') : css('--c-content-text');
          g.fillRect(x * W - 4, H - y * H - 4, 8, 8);
        });
      };
      const at = (e) => {
        const r = cv.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
      };
      cv.addEventListener('pointerdown', (e) => {
        const [x, y] = at(e);
        const p = pts().map((q) => [...q]);
        sel = p.findIndex(([px, py]) => Math.hypot((px - x) * W, (py - y) * H) < 8);
        if (sel < 0) {
          p.push([x, y]);
          p.sort((a, b) => a[0] - b[0]);
          sel = p.findIndex((q) => q[0] === x && q[1] === y);
          set(p);
        }
        cv.setPointerCapture(e.pointerId);
        const move = (ev) => {
          const [mx, my] = at(ev);
          const q = pts().map((v) => [...v]);
          if (sel < 0 || sel >= q.length) return;
          const lo = sel > 0 ? q[sel - 1][0] + 0.005 : 0;
          const hi = sel < q.length - 1 ? q[sel + 1][0] - 0.005 : 1;
          q[sel] = [sel === 0 ? 0 : sel === q.length - 1 ? 1 : Math.min(hi, Math.max(lo, mx)), my];
          set(q);
        };
        const up = () => {
          cv.removeEventListener('pointermove', move);
          cv.removeEventListener('pointerup', up);
          app.undo.seal();
        };
        cv.addEventListener('pointermove', move);
        cv.addEventListener('pointerup', up);
        draw();
      });
      cv.addEventListener('dblclick', (e) => {
        const [x, y] = at(e);
        const p = pts().map((q) => [...q]);
        const i = p.findIndex(([px, py]) => Math.hypot((px - x) * W, (py - y) * H) < 8);
        if (i > 0 && i < p.length - 1) {
          p.splice(i, 1);
          sel = -1;
          set(p, false);
        }
      });
      cv.addEventListener('keydown', (e) => {
        const p = pts().map((q) => [...q]);
        if (sel < 0 || sel >= p.length) return;
        const d = e.shiftKey ? 0.05 : 0.01;
        const k = { ArrowUp: [0, d], ArrowDown: [0, -d], ArrowLeft: [-d, 0], ArrowRight: [d, 0] }[e.key];
        if (!k) return;
        e.preventDefault();
        p[sel] = [sel === 0 ? 0 : sel === p.length - 1 ? 1 : Math.min(1, Math.max(0, p[sel][0] + k[0])), Math.min(1, Math.max(0, p[sel][1] + k[1]))];
        set(p);
      });
      const presets = h('div', { class: 'btn-row' });
      for (const [label, p] of [
        ['Linear', null],
        ['S-curve', [[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]]],
        ['Brighten shadows', [[0, 0], [0.25, 0.4], [1, 1]]],
        ['Darken', [[0, 0], [0.6, 0.4], [1, 1]]],
        ['High key', [[0, 0.1], [0.5, 0.7], [1, 1]]],
      ]) {
        const b = h('button', { class: 'btn btn-small' }, label);
        b.addEventListener('click', () => {
          sel = -1;
          app.setChain((c) => (c.tone = { ...c.tone, curve: p }), `Tonal curve: ${label}`);
        });
        presets.appendChild(b);
      }
      const off = app.store.on('change', () => draw());
      const offTheme = app.on('theme', () => draw());
      const p = modal({ title: 'Tonal Curve', body: h('div', { class: 'curve-editor' }, cv, presets, h('p', { class: 'hint' }, 'The curve applies after the stretch and before gamma, contrast and brightness. It is folded into the band LUT.')), buttons: ['Close'], width: 330, modeless: true, id: 'tone-curve' });
      curveDlg = cv;
      draw();
      p.then(() => {
        off?.();
        offTheme();
        curveDlg = null;
        app.emit('state');
      });
      app.emit('state');
    },
  });

  // ---- histogram editor (per-band stretch handles) ----
  let histDlg = null;
  C.implement('enh.histogram', {
    enabled: has,
    checked: () => !!histDlg,
    run: () => {
      if (histDlg) return histDlg.focus();
      const l0 = layer();
      const host = h('div', { class: 'hist-editor', tabindex: '-1' });
      const W = 360;
      const H = 110;
      const build = () => {
        clear(host);
        const l = layer();
        if (!l?.stats) return host.appendChild(h('p', { class: 'hint' }, 'Statistics are still being computed…'));
        const ch = l.chain;
        const colours = ch.bands.length === 3 ? [css('--c-chart-red'), css('--c-chart-green'), css('--c-chart-blue')] : [css('--c-chart-fill')];
        ch.bands.forEach((b, i) => {
          const hst = l.stats[b];
          if (!hst?.count) return;
          const first = hst.bins.findIndex((x) => x > 0);
          let last = hst.bins.length - 1;
          while (last > 0 && !hst.bins[last]) last--;
          const x0 = histBinValue(hst, first);
          const x1 = histBinValue(hst, last);
          const cur = stretchRange(hst, ch, b);
          const cv = h('canvas', { width: String(W), height: String(H), class: 'hist-canvas', 'aria-label': `Histogram of band ${b + 1}: drag the low and high handles` });
          const lo = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: String(+cur.lo.toFixed(3)), 'aria-label': `Low limit band ${b + 1}` });
          const hi = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: String(+cur.hi.toFixed(3)), 'aria-label': `High limit band ${b + 1}` });
          const toX = (v) => ((v - x0) / (x1 - x0 || 1)) * (W - 1);
          const toV = (x) => x0 + (x / (W - 1)) * (x1 - x0);
          const draw = (a, z) => {
            const g = cv.getContext('2d');
            g.fillStyle = css('--c-content-bg');
            g.fillRect(0, 0, W, H);
            drawHist(g, hst, W, H, x0, x1, colours[i]);
            g.fillStyle = css('--c-chart-mask');
            g.fillRect(0, 0, toX(a), H);
            g.fillRect(toX(z), 0, W - toX(z), H);
            g.strokeStyle = css('--c-chart-handle');
            g.lineWidth = 2;
            g.beginPath();
            g.moveTo(toX(a), 0);
            g.lineTo(toX(a), H);
            g.moveTo(toX(z), 0);
            g.lineTo(toX(z), H);
            g.moveTo(toX(a), H);
            g.lineTo(toX(z), 0);
            g.stroke();
          };
          const apply = (a, z, merge = true) => {
            if (!(z > a)) return;
            draw(a, z);
            app.setChain(
              (c) => {
                if (c.stretch !== 'manual') {
                  // Start from the current limits of every displayed band.
                  c.manual = Object.fromEntries(c.bands.map((bb) => [bb, (({ lo: q, hi: w }) => ({ lo: q, hi: w }))(stretchRange(l.stats[bb], c, bb))]));
                  c.stretch = 'manual';
                }
                c.manual = { ...(c.manual ?? {}), [b]: { lo: a, hi: z } };
              },
              'Histogram stretch',
              { mergeKey: merge ? `hist:${l.id}:${b}` : undefined },
            );
          };
          draw(cur.lo, cur.hi);
          cv.addEventListener('pointerdown', (e) => {
            const r = cv.getBoundingClientRect();
            const x = ((e.clientX - r.left) / r.width) * W;
            let a = Number(lo.value);
            let z = Number(hi.value);
            const which = Math.abs(x - toX(a)) < Math.abs(x - toX(z)) ? 'lo' : 'hi';
            cv.setPointerCapture(e.pointerId);
            const move = (ev) => {
              const v = toV(Math.min(W - 1, Math.max(0, ((ev.clientX - r.left) / r.width) * W)));
              if (which === 'lo') a = Math.min(v, z - (x1 - x0) / 1000);
              else z = Math.max(v, a + (x1 - x0) / 1000);
              lo.value = String(+a.toFixed(3));
              hi.value = String(+z.toFixed(3));
              apply(a, z);
            };
            const up = () => {
              cv.removeEventListener('pointermove', move);
              cv.removeEventListener('pointerup', up);
              app.undo.seal();
            };
            move(e);
            cv.addEventListener('pointermove', move);
            cv.addEventListener('pointerup', up);
          });
          for (const inp of [lo, hi]) inp.addEventListener('change', () => apply(Number(lo.value), Number(hi.value), false));
          host.appendChild(h('div', { class: 'hist-band' }, h('b', {}, `Band ${b + 1}`), cv, h('div', { class: 'btn-row' }, h('label', {}, 'Low ', lo), h('label', {}, 'High ', hi), h('span', { class: 'hint' }, `data ${x0.toFixed(1)} … ${x1.toFixed(1)}`))));
        });
        const reset = h('button', { class: 'btn btn-small' }, 'Back to DRA');
        reset.addEventListener('click', () => app.setChain((c) => (c.stretch = 'dra'), 'Stretch'));
        host.appendChild(h('div', { class: 'btn-row' }, reset, h('span', { class: 'hint' }, `${l.rec?.name ?? ''} · stretch ${ch.stretch}`)));
      };
      build();
      const off = app.on('state', () => {
        if (layer() !== l0) build();
      });
      const offTheme = app.on('theme', build);
      const p = modal({ title: 'Histogram Editor', body: host, buttons: ['Close'], width: 410, modeless: true, id: 'histogram-editor' });
      histDlg = host;
      p.then(() => {
        off?.();
        offTheme();
        histDlg = null;
        app.emit('state');
      });
      app.emit('state');
    },
  });
}
