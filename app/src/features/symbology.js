// Gridded Reference Graphics (REQ-IMG-23): square cells of a set size over the panel's AOI (or the
// view) in a local metric frame, labelled column letter + row number from the north-west, with
// micro-GRG sub-cells (keypad 1–9).

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { writeNitf } from '../formats/nitf-writer.js';
import * as rsm from '../sensor/rsm.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { int } from '../i18n/format.js';

export const name = 'symbology';

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
      app.toast(msgOf(e), { kind: 'error', ms: 8000 });
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
    if (gs.length < 4) throw gwError('the view has no ground footprint', null, 'E_NO_GROUND_FOOTPRINT');
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
    if (cols * rows * (micro ? 10 : 1) > maxCells) throw gwError('{cols} × {rows} cells is too many; use larger cells', { cols: int(cols), rows: int(rows) }, 'E_GRG_TOO_MANY');
    const pt = (x, y) => {
      const lon = lon0 + x / kx;
      const lat = lat0 - y / ky;
      const ts = app.terrain?.sample?.(lat, lon);
      return [lon, lat, ts ? ts.hae : 0];
    };
    const ids = [];
    const cells = [];
    S.transact(t('GRG {cell} m', { cell }), (tx) => {
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
        const cell = h('input', { class: 'inp inp-num', type: 'number', min: '1', step: 'any', value: String(def), 'aria-label': t('Cell size (m)') });
        const hint = micro ? t("Over the panel's AOI (or the view), labelled A1 from the north-west, with keypad sub-cells 1–9.") : t("Over the panel's AOI (or the view), labelled A1 from the north-west.");
        const buttons = [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
        if ((await modal({ title: micro ? t('Micro GRG') : t('Gridded Reference Graphic'), body: field(t('Cell size (m)'), cell, hint), buttons, id: id.replace('.', '-') })) !== 'ok') return;
        const r = grg({ cell: Number(cell.value) || 100, micro });
        app.toast(t('GRG: {cols} × {rows} cells', { cols: int(r.cols), rows: int(r.rows) }), { kind: 'info' });
      }),
    });
}
