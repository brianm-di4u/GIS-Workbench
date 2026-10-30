// MIL-STD-2525 symbols (REQ-IMG-32) from lazy milsymbol (2525 C, D and E; 2525B is not claimed)
// as ground-anchored graphics, and Gridded Reference Graphics (REQ-IMG-23): square cells of a set
// size over the panel's AOI (or the view) in a local metric frame, labelled column letter + row
// number from the north-west, with micro-GRG sub-cells (keypad 1–9).

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { groundOf } from '../tools/tools.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { writeNitf } from '../formats/nitf-writer.js';
import * as rsm from '../sensor/rsm.js';

export const name = 'symbology';

const PRESETS = [
  ['10031000001211000000', 'Friendly infantry (2525D)'],
  ['10061000001211000000', 'Hostile infantry (2525D)'],
  ['10031000001205000000', 'Friendly armour (2525D)'],
  ['10061500001101000000', 'Hostile ground vehicle (2525D)'],
  ['SFGPUCI----K---', 'Friendly infantry (2525C)'],
  ['SHGPUCA----K---', 'Hostile armour (2525C)'],
  ['SNGPEVC----K---', 'Neutral civilian vehicle (2525C)'],
];

/** Column label: A … Z, AA, AB … */
export function colLabel(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  const glayerOf = (tx, p) => {
    let gl = p.rec?.graphicsLayer ?? null;
    if (!gl) {
      gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
      tx.set(p.id, 'graphicsLayer', gl);
    }
    return gl;
  };

  // ---- MIL-STD-2525 ----
  let ms = null;
  const cache = new Map();
  const load = async () => {
    if (!ms) ms = (await app.gw.runScript('js-milsymbol')).ms;
    return ms;
  };
  /** Symbol canvas (cached): {canvas, anchor: {x, y}, valid}. */
  function symbolCanvas(sidc, size = 30, extra = {}) {
    const key = `${sidc}|${size}|${JSON.stringify(extra)}`;
    if (cache.has(key)) return cache.get(key);
    if (!ms) return null;
    const sym = new ms.Symbol(sidc, { size, ...extra });
    const out = { canvas: sym.asCanvas(), anchor: sym.getAnchor(), valid: sym.isValid(), octagon: sym.getOctagonAnchor?.() };
    cache.set(key, out);
    return out;
  }
  app.milsym = {
    load,
    symbolCanvas,
    draw(g, r, p) {
      const c = symbolCanvas(r.sidc, r.size ?? 30, r.modifiers ?? {});
      if (!c) {
        load().then(() => app.renderer?.invalidate());
        return;
      }
      g.drawImage(c.canvas, Math.round(p.x - c.anchor.x), Math.round(p.y - c.anchor.y));
    },
    /** Place a symbol at a ground point. */
    async place(p, { lat, lon, h: hh = 0 }, sidc, { size = 30, modifiers = {} } = {}) {
      await load();
      const c = symbolCanvas(sidc, size, modifiers);
      if (!c.valid) throw new Error(`${sidc} is not a valid MIL-STD-2525 C/D/E symbol identifier`);
      let id;
      S.transact(`Symbol ${sidc}`, (tx) => (id = tx.create('graphic', { glayer: glayerOf(tx, p), pane: p.id, shape: 'symbol', sidc, size, modifiers, anchor: 'ground', coords: [[lon, lat, hh]], text: modifiers.uniqueDesignation ?? '', style: { stroke: '#000000', width: 1 }, created: new Date().toISOString(), provenance: { kind: 'user', standard: /^\d{20}$/.test(sidc) ? 'MIL-STD-2525D/E' : 'MIL-STD-2525C' } })));
      return id;
    },
  };
  app.tools.register({
    id: 'draw.symbol',
    cue: 'MIL-STD-2525 Symbol: click to place the chosen symbol (Esc stops).',
    onDown(p, e, sx, sy) {
      const gr = groundOf(app, p, sx, sy);
      if (!gr) return true;
      const o = app.prefs.get('milsym') ?? { sidc: PRESETS[0][0], size: 30, designation: '' };
      app.milsym.place(p, gr, o.sidc, { size: o.size, modifiers: o.designation ? { uniqueDesignation: o.designation } : {} }).catch((er) => app.toast(er.message, { kind: 'error' }));
      return true;
    },
  });
  C.implement('draw.symbol', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId,
    run: run(async () => {
      await load();
      const o = app.prefs.get('milsym') ?? { sidc: PRESETS[0][0], size: 30, designation: '' };
      const preset = h('select', { class: 'inp', 'aria-label': 'Symbol' }, [h('option', { value: '' }, 'Custom SIDC…'), ...PRESETS.map(([v, t]) => h('option', { value: v }, t))]);
      const sidc = h('input', { class: 'inp mono', value: o.sidc, 'aria-label': 'Symbol identification code' });
      const size = h('input', { class: 'inp inp-num', type: 'number', min: '10', max: '120', value: String(o.size), 'aria-label': 'Size (px)' });
      const des = h('input', { class: 'inp', value: o.designation ?? '', 'aria-label': 'Unique designation' });
      const prev = h('div', { class: 'sym-preview' });
      const show = () => {
        prev.replaceChildren();
        const c = symbolCanvas(sidc.value.trim(), 50, des.value ? { uniqueDesignation: des.value } : {});
        if (c) prev.append(c.canvas, h('span', { class: 'hint' }, c.valid ? ' valid' : ' not a valid C/D/E code'));
      };
      preset.addEventListener('change', () => {
        if (preset.value) sidc.value = preset.value;
        show();
      });
      sidc.addEventListener('input', show);
      des.addEventListener('input', show);
      show();
      if ((await modal({ title: 'MIL-STD-2525 Symbol', body: h('div', {}, field('Preset', preset), field('SIDC (2525C letters or 2525D/E 20 digits)', sidc), field('Size (px)', size), field('Unique designation', des), prev, h('p', { class: 'hint' }, 'Drawn by milsymbol (MIT). MIL-STD-2525B rendering is not claimed.')), id: 'draw-symbol' })) !== 'OK') return;
      app.prefs.set('milsym', { sidc: sidc.value.trim(), size: Number(size.value) || 30, designation: des.value });
      app.tools.select('draw.symbol', { sticky: true });
    }),
  });

  // ---- GRG (REQ-IMG-23) ----
  /** Ground box of the panel: its AOI, else the view. [south, west, north, east]. */
  function areaOf(p) {
    const a = app.aoiFor?.(p);
    if (a?.coords?.length) {
      const lons = a.coords.map((c) => c[0]);
      const lats = a.coords.map((c) => c[1]);
      return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
    }
    const l = p.geoLayer();
    const { w, h: hh } = p.size();
    const gs = [
      [0, 0],
      [w, 0],
      [w, hh],
      [0, hh],
    ]
      .map(([x, y]) => {
        const q = p.imagePoint(x, y);
        return l.groundAt(q.x, q.y);
      })
      .filter(Boolean);
    if (gs.length < 4) throw new Error('the view has no ground footprint');
    return [Math.min(...gs.map((g) => g.lat)), Math.min(...gs.map((g) => g.lon)), Math.max(...gs.map((g) => g.lat)), Math.max(...gs.map((g) => g.lon))];
  }
  /**
   * Make a GRG: cells of `cell` m from the north-west corner of `box`, labelled A1 (column letter,
   * row number); `micro` adds 3 × 3 keypad sub-cells. Returns {cells, ids}.
   */
  function grg({ p = pane(), box = null, cell = 100, micro = false, colour = '#ffd400', maxCells = 2500 } = {}) {
    const [s, w, n, e] = box ?? areaOf(p);
    const lat0 = n;
    const lon0 = w;
    const kx = (Math.PI / 180) * 6378137 * Math.cos((((s + n) / 2) * Math.PI) / 180);
    const ky = 110574 + 1110 * Math.sin((((s + n) / 2) * Math.PI) / 180) ** 2;
    const W = (e - w) * kx;
    const H = (n - s) * ky;
    const cols = Math.max(1, Math.ceil(W / cell - 1e-9));
    const rows = Math.max(1, Math.ceil(H / cell - 1e-9));
    if (cols * rows * (micro ? 10 : 1) > maxCells) throw new Error(`${cols} × ${rows} cells is too many; use larger cells`);
    const pt = (x, y) => {
      const lon = lon0 + x / kx;
      const lat = lat0 - y / ky;
      const t = app.terrain?.sample?.(lat, lon);
      return [lon, lat, t ? t.hae : 0];
    };
    const ids = [];
    const cells = [];
    S.transact(`GRG ${cell} m`, (tx) => {
      const gl = glayerOf(tx, p);
      const now = new Date().toISOString();
      const add = (x0, y0, size, label, sub) => {
        const ring = [pt(x0, y0), pt(x0 + size, y0), pt(x0 + size, y0 + size), pt(x0, y0 + size)];
        ids.push(tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polygon', anchor: 'ground', coords: ring, text: label, style: { stroke: colour, width: sub ? 1 : 2, fill: '#00000000', dash: sub ? 'dotted' : null }, created: now, provenance: { kind: 'grg', cell: size, label } }));
        ids.push(tx.create('graphic', { glayer: gl, pane: p.id, shape: 'text', anchor: 'ground', coords: [pt(x0 + size * 0.08, y0 + size * 0.2)], text: label, style: { stroke: colour, width: 1, fontSize: sub ? 10 : 14 }, created: now, provenance: { kind: 'grg-label', label } }));
        cells.push({ label, ring });
      };
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const label = `${colLabel(c)}${r + 1}`;
          add(c * cell, r * cell, cell, label, false);
          if (micro) for (let k = 0; k < 9; k++) add(c * cell + (k % 3) * (cell / 3), r * cell + Math.floor(k / 3) * (cell / 3), cell / 3, `${label}-${k + 1}`, true);
        }
    });
    return { cells, ids, cols, rows };
  }
  app.grg = { make: grg, areaOf, colLabel };
  // Test hook (E2E): build GeoTIFFs in any CRS the writer supports.
  app.__test = { ...(app.__test ?? {}), writeGeoTiff, writeNitf, rsm };
  for (const [id, micro] of [['grid.grg', false], ['grid.micro', true]])
    C.implement(id, {
      enabled: () => !!pane()?.geoLayer?.()?.modelId,
      run: run(async () => {
        // Default cell: 100 m (300 m micro), or the next 1-2-5 size that keeps the AOI or view within
        // the cell limit (a whole 1° DEM at 100 m would be 100 000 cells).
        let def = micro ? 300 : 100;
        try {
          const [s, w, n, e] = areaOf(pane());
          const m2 = (e - w) * 111320 * Math.cos((((s + n) / 2) * Math.PI) / 180) * (n - s) * 110574;
          const need = 1.15 * Math.sqrt((m2 * (micro ? 10 : 1)) / 2500); // margin for the ceil() of each side
          while (def < need) def = [1, 2, 5].map((k) => k * 10 ** Math.floor(Math.log10(def))).concat(10 ** (Math.floor(Math.log10(def)) + 1)).find((x) => x > def);
        } catch {
          /* no footprint: grg() says so */
        }
        const cell = h('input', { class: 'inp inp-num', type: 'number', min: '1', step: 'any', value: String(def), 'aria-label': 'Cell size (m)' });
        if ((await modal({ title: micro ? 'Micro GRG' : 'Gridded Reference Graphic', body: field('Cell size (m)', cell, `Over the panel's AOI (or the view), labelled A1 from the north-west${micro ? ', with keypad sub-cells 1–9' : ''}.`), id: id.replace('.', '-') })) !== 'OK') return;
        const r = grg({ cell: Number(cell.value) || 100, micro });
        app.toast(`GRG: ${r.cols} × ${r.rows} cells`);
      }),
    });
}
