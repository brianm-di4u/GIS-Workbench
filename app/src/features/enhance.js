// Image Tools ▸ Enhance and Analyze commands (REQ-IMG-04..07, REQ-IMG-09, REQ-IMG-19):
// every change is an undoable store op on the layer's chain (a slider drag is one step).

import { clone } from '../core/util.js';
import { autoChain, STRETCHES, PALETTES, chainRecord, chainSummary } from '../render/chain.js';
import { modal, field, section } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';

export const name = 'enhance';

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer();
  const has = () => !!layer()?.chain;

  /** Change the active layer's chain through one store op (REQ-ARC-12). */
  app.setChain = (mutate, label = 'Image chain', { mergeKey, layerId } = {}) => {
    const l = layerId ? app.layers.get(layerId) : layer();
    if (!l) return;
    const next = clone(l.chain);
    mutate(next);
    next.auto = false;
    app.store.transact(label, (tx) => tx.set(l.id, 'chain', next), { mergeKey });
    if (next.dra.lock !== l.chain.dra.lock) l.lockDra(next.dra.lock);
    app.renderer.invalidate();
  };

  const slider = (key, label) => ({
    run: () => {},
    enabled: has,
    value: () => layer()?.chain?.[key === 'saturation' ? 'colour' : 'tone']?.[key] ?? 0,
    setValue: (v) =>
      app.setChain(
        (c) => {
          if (key === 'saturation') c.colour.saturation = v;
          else c.tone[key] = v;
        },
        label,
        { mergeKey: `slider:${key}:${layer()?.id}` },
      ),
  });
  C.implement('enh.brightness', slider('brightness', 'Brightness'));
  C.implement('enh.contrast', slider('contrast', 'Contrast'));
  C.implement('enh.gamma', slider('gamma', 'Gamma'));
  C.implement('enh.saturation', slider('saturation', 'Saturation'));
  C.implement('enh.invert', { enabled: has, checked: () => !!layer()?.chain?.tone.invert, run: () => app.setChain((c) => (c.tone.invert = !c.tone.invert), 'Invert') });

  C.implement('enh.drascope', {
    run: () => {},
    enabled: has,
    options: () => [
      { value: 'full', label: 'DRA: Full image' },
      { value: 'viewport', label: 'DRA: Viewport' },
      { value: 'aoi', label: 'DRA: AOI' },
    ],
    value: () => layer()?.chain?.dra.scope ?? 'full',
    setValue: (v) => {
      if (v === 'aoi' && !app.aoiFor?.(app.activePane())) return app.toast('Draw an AOI first (Home ▸ Area of Interest)', { kind: 'warn' });
      app.setChain((c) => {
        c.dra.scope = v;
        c.stretch = 'dra';
      }, 'DRA scope');
    },
  });
  C.implement('enh.dralock', { enabled: has, checked: () => !!layer()?.chain?.dra.lock, run: () => app.setChain((c) => (c.dra.lock = !c.dra.lock), 'Lock DRA') });
  C.implement('enh.drasettings', {
    enabled: has,
    run: async () => {
      const d = layer().chain.dra;
      const num = (v, min, max, step) => h('input', { class: 'inp inp-num', type: 'number', value: String(v), min: String(min), max: String(max), step: String(step) });
      const pmin = num(d.pmin, 0, 0.5, 0.005);
      const pmax = num(d.pmax, 0.5, 1, 0.005);
      const a = num(d.a, 0, 1, 0.05);
      const b = num(d.b, 0, 1, 0.05);
      const body = h('div', {}, section('SIPS DRA parameters', field('Pmin', pmin), field('Pmax', pmax), field('Emin modifier (A)', a), field('Emax modifier (B)', b)), h('p', { class: 'hint' }, 'Defaults 0.02 / 0.98 / 0.2 / 0.4 (Research/04 §2.5; to be confirmed against the SIPS text).'));
      const r = await modal({
        title: 'DRA Settings',
        body,
        buttons: ['OK', 'Cancel'],
        onReset: () => {
          pmin.value = '0.02';
          pmax.value = '0.98';
          a.value = '0.2';
          b.value = '0.4';
        },
        id: 'dra-settings',
      });
      if (r === 'OK')
        app.setChain((c) => {
          Object.assign(c.dra, { pmin: +pmin.value, pmax: +pmax.value, a: +a.value, b: +b.value });
          c.stretch = 'dra';
        }, 'DRA settings');
    },
  });
  C.implement('enh.stretch', {
    run: () => {},
    enabled: has,
    options: () => STRETCHES.map(([value, label]) => ({ value, label })),
    value: () => layer()?.chain?.stretch ?? 'dra',
    setValue: (v) => app.setChain((c) => (c.stretch = v), 'Stretch'),
  });
  C.implement('enh.lut', {
    run: () => {},
    enabled: () => has() && layer().chain.bands.length === 1,
    options: () => PALETTES.map((p) => ({ value: p, label: `LUT: ${p}` })),
    value: () => layer()?.chain?.colour.palette ?? 'grey',
    setValue: (v) => app.setChain((c) => (c.colour.palette = v), 'Pseudo-colour LUT'),
  });
  C.implement('enh.auto', {
    enabled: has,
    run: () => {
      const l = layer();
      const ch = autoChain({ bands: l.bands, sampleType: l.sampleType, abpp: l.info.subheader?.ABPP, irep: l.info.irep, icat: l.info.icat, bandRoles: l.info.subheader?.bands?.map((b) => b.IREPBAND), kind: l.kind });
      app.setChain((c) => Object.assign(c, ch, { kernel: c.kernel }), 'Auto enhance');
    },
  });
  C.implement('enh.reset', {
    enabled: has,
    run: () =>
      app.setChain((c) => {
        c.tone = { gamma: 0, brightness: 0, contrast: 0, invert: false };
        c.colour.saturation = 0;
        c.dra = { scope: 'full', lock: false, pmin: 0.02, pmax: 0.98, a: 0.2, b: 0.4, linked: false };
      }, 'Reset enhancements'),
  });
  C.implement('enh.remove', {
    enabled: has,
    run: () =>
      app.setChain((c) => {
        c.enabled = { stretch: false, tone: false, colour: false, sharpen: false };
      }, 'Remove enhancements'),
  });
  C.implement('enh.chain', {
    enabled: has,
    run: async () => {
      const l = layer();
      const rec = chainRecord(l.chain);
      const rows = rec.map((s, i) => {
        const cb = h('input', { type: 'checkbox', checked: s.enabled !== false, disabled: s.enabled === undefined, 'aria-label': `Enable ${s.op}` });
        cb.dataset.i = String(i);
        return h('tr', {}, h('td', {}, s.stage), h('td', {}, s.op), h('td', {}, cb), h('td', { class: 'mono chain-params' }, JSON.stringify(s.params).replace(/,"/g, ', "')));
      });
      const body = h('div', {}, h('p', {}, chainSummary(l.chain)), h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Stage'), h('th', {}, 'Operation'), h('th', {}, 'On'), h('th', {}, 'Parameters'))), h('tbody', {}, rows)), h('p', { class: 'hint' }, 'Stage order follows Research/04 §2.2: geometry → filters → DRA/stretch → tone → colour. The chain is recorded with chips and measurements.'));
      const r = await modal({ title: 'Chain Editor', body, buttons: ['OK', 'Cancel'], width: 640, id: 'chain-editor' });
      if (r !== 'OK') return;
      const on = {};
      for (const cb of body.querySelectorAll('input[type=checkbox]')) {
        const s = rec[+cb.dataset.i];
        if (s.stage === 'S7') on.stretch = cb.checked;
        if (s.stage === 'S8') on.tone = cb.checked;
        if (s.stage === 'S9') on.colour = cb.checked;
        if (s.stage === 'S6') on.sharpen = cb.checked;
      }
      app.setChain((c) => Object.assign(c.enabled, on), 'Chain editor');
    },
  });

  C.implement('bands.select', {
    enabled: () => has() && layer().bands > 1,
    run: async () => {
      const l = layer();
      const mk = (v) => {
        const s = h('select', { class: 'inp' });
        for (let i = 0; i < l.bands; i++) {
          const b = l.info.subheader?.bands?.[i];
          s.appendChild(h('option', { value: String(i) }, `Band ${i + 1}${b?.IREPBAND ? ` (${b.IREPBAND})` : ''}${b?.ISUBCAT ? ` ${b.ISUBCAT}` : ''}`));
        }
        s.value = String(v);
        return s;
      };
      const cur = l.chain.bands;
      const mono = h('input', { type: 'checkbox', checked: cur.length === 1 });
      const r0 = mk(cur[0]);
      const g0 = mk(cur[1] ?? Math.min(1, l.bands - 1));
      const b0 = mk(cur[2] ?? Math.min(2, l.bands - 1));
      const body = h('div', {}, field('Red (or grey)', r0), field('Green', g0), field('Blue', b0), h('label', { class: 'fld fld-inline' }, mono, h('span', {}, 'Single band (grey)')));
      if ((await modal({ title: 'Select Bands', body, buttons: ['OK', 'Cancel'], id: 'bands' })) !== 'OK') return;
      const bands = mono.checked ? [+r0.value] : [+r0.value, +g0.value, +b0.value];
      app.setChain((c) => (c.bands = bands), 'Band selection');
      l.ensureStats().then(() => {
        l.updateLut(true);
        app.renderer.invalidate();
      });
    },
  });
  C.implement('img.voids', { enabled: has, checked: () => layer()?.chain?.voids !== false, run: () => app.setChain((c) => (c.voids = c.voids === false), 'Remove void pixels') });
  C.implement('img.footprint', { enabled: () => !!layer()?.footprint(), checked: () => app.selectedLayerId === layer()?.id, run: () => {
    app.selectedLayerId = app.selectedLayerId === layer()?.id ? null : layer()?.id;
    app.desktop.workspace.map.zoomToFootprints();
    app.desktop.workspace.render();
  } });

  // Re-derive LUTs when the store changes a chain (undo/redo included).
  app.store.on('change', ({ ids }) => {
    for (const l of app.layers.values()) if (!ids || ids.has(l.id)) {
      // An undone open leaves the layer object without its record (GUI-021).
      if (l.stats && l.rec) l.ensureStats().then(() => {
        l.updateLut();
        app.renderer.invalidate();
      });
    }
  });
}
