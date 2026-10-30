// Pan-sharpening (REQ-IMG-10) and CLAHE (REQ-IMG-08 Should). Pan-sharpening fuses a
// multispectral layer with a panchromatic one in the same panel, in real time on the GPU:
// Brovey, fast IHS, IHS-NIR and a Gram–Schmidt-style injection with per-band gains, the pan
// first matched to the intensity's mean and spread. The MS layer is placed on the pan grid
// through the two sensor models (a registration affine), so a 4× coarser MS image lines up.
// PCA (a Should within this Should) and Ehlers (a Could) are not provided.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { TileSet } from '../render/tiles.js';
import { histBinValue } from '../render/chain.js';
import { fitTransform } from './register.js';

export const name = 'fusion';
export const METHODS = [
  ['brovey', 'Brovey'],
  ['ihs', 'Fast IHS'],
  ['ihsnir', 'IHS with NIR'],
  ['gs', 'Gram–Schmidt (gain injection)'],
];
const CODE = { brovey: 0, ihs: 1, ihsnir: 2, gs: 3 };

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const images = (p) => (p?.visibleLayers() ?? []).filter((l) => l.kind !== 'dem');

  /** Mean and standard deviation of a band's displayed values (0 … 1) from its statistics. */
  function displayStats(l, k) {
    const b = l.chain.bands[k] ?? l.chain.bands[0];
    const st = l.stats?.[b];
    const lut = l._baseLuts?.[k];
    const p = l.lutParams?.[k];
    if (!st || !lut || !p) return null;
    let n = 0;
    let s = 0;
    let s2 = 0;
    for (let i = 0; i < st.bins.length; i++) {
      const c = st.bins[i];
      if (!c) continue;
      const dn = histBinValue(st, i);
      const idx = Math.max(0, Math.min(65535, Math.floor(dn * p.scale + p.offset + 0.5)));
      const v = lut[idx] / 255;
      n += c;
      s += c * v;
      s2 += c * v * v;
    }
    if (!n) return null;
    const m = s / n;
    return { mean: m, std: Math.sqrt(Math.max(1e-12, s2 / n - m * m)) };
  }

  /** A view of a layer showing one other band (the NIR pass), sharing its decoder and stats. */
  function bandProxy(l, band) {
    const px = Object.create(l);
    Object.defineProperty(px, 'chain', { get: () => ({ ...l.chain, bands: [band], colour: { ...l.chain.colour, palette: 'grey' } }) });
    px.lutTex = null;
    px.palTex = null;
    px._chainSig = '';
    px.viewHist = null;
    px.tiles = new TileSet(px, app.renderer, (L, tx, ty, bands) => app.pool.run('tile', { handle: l.handle, level: L, tx, ty, bands }, { affinity: l.affinity, priority: 'interactive', label: `tile ${L}/${tx}/${ty} (NIR)`, timeout: 180000 }));
    return px;
  }

  const proxies = new Map();
  const statsCache = new Map();

  /** The fusion pass for a panel, or null: {ms, pan, nir, method, stats}. */
  app.panSharpenFor = (p) => {
    const cfg = p.rec?.pansharpen;
    if (!cfg?.on) return null;
    const ms = app.layers.get(cfg.ms);
    const pan = app.layers.get(cfg.pan);
    const vis = p.visibleLayers();
    if (!ms || !pan || !vis.includes(ms) || !vis.includes(pan) || !ms.stats || !pan.stats) return null;
    ms.updateLut();
    pan.updateLut();
    let nir = null;
    if (cfg.method === 'ihsnir') {
      const key = `${ms.id}:${cfg.nir}`;
      if (!proxies.has(key)) proxies.set(key, bandProxy(ms, cfg.nir));
      nir = proxies.get(key);
      if (!ms.stats?.[cfg.nir]) {
        nir.ensureStats().then(() => app.renderer.invalidate());
        return null; // statistics of the NIR band first
      }
      nir.updateLut();
    }
    const sig = `${ms._chainSig}|${pan._chainSig}|${nir?._chainSig ?? ''}`;
    let stats = statsCache.get(p.id);
    if (!stats || stats.sig !== sig) {
      const ks = [0, 1, 2].map((k) => displayStats(ms, k));
      const pn = displayStats(pan, 0);
      const ns = nir ? displayStats(nir, 0) : null;
      if (ks.every(Boolean) && pn) {
        stats = { sig, mean: [...ks.map((x) => x.mean), ns?.mean ?? ks[0].mean], std: [...ks.map((x) => x.std), ns?.std ?? ks[0].std], panMean: pn.mean, panStd: pn.std };
        statsCache.set(p.id, stats);
      } else stats = null;
    }
    return { ms, pan, nir, method: CODE[cfg.method] ?? 0, stats };
  };

  /**
   * Registration affine of `l` onto `ref` through their models: layer pixel → reference pixel
   * on a 7 × 7 grid at the default height, fitted (affine).
   */
  app.alignByModels = (l, ref) => {
    if (!l.modelId || !ref.modelId) throw new Error('both layers need a sensor model');
    const pairs = [];
    for (let j = 0; j <= 6; j++)
      for (let i = 0; i <= 6; i++) {
        const s = { x: (l.width * i) / 6, y: (l.height * j) / 6 };
        const g = l.groundAt(s.x, s.y);
        const t = g ? ref.imageAt(g.lat, g.lon, g.h) : null;
        if (t) pairs.push({ s, t });
      }
    if (pairs.length < 6) throw new Error('the two images do not overlap');
    return fitTransform(pairs, 'affine');
  };

  /** Turn pan-sharpening on for a panel: {ms, pan, method, nir}. */
  app.setPanSharpen = (p, cfg) => {
    const ms = app.layers.get(cfg.ms);
    const pan = app.layers.get(cfg.pan);
    if (!ms || !pan) throw new Error('choose the multispectral and the pan layer');
    if (ms.bands < 3) throw new Error('the multispectral layer needs three bands or more');
    S.transact('Pan-sharpen', (tx) => {
      if (!ms.rec.align && (ms.width !== pan.width || ms.height !== pan.height) && ms.modelId && pan.modelId) tx.set(ms.id, 'align', app.alignByModels(ms, pan));
      tx.set(p.id, 'pansharpen', { on: true, ms: ms.id, pan: pan.id, method: cfg.method ?? 'brovey', nir: cfg.nir ?? Math.min(ms.bands - 1, 3) });
    });
    statsCache.delete(p.id);
    app.renderer.invalidate();
    p.invalidate();
  };

  C.implement('enh.pansharpen', {
    enabled: () => images(pane()).length >= 2,
    checked: () => !!pane()?.rec?.pansharpen?.on,
    menu: () =>
      METHODS.map(([v, label]) => ({
        label,
        checked: pane()?.rec?.pansharpen?.on && pane().rec.pansharpen.method === v,
        run: () => {
          const p = pane();
          const cur = p.rec.pansharpen;
          if (cur?.ms) app.setPanSharpen(p, { ...cur, method: v });
          else C.run('enh.pansharpen');
        },
      })).concat([{ label: 'Off', run: () => S.transact('Pan-sharpen off', (tx) => tx.set(pane().id, 'pansharpen', { ...(pane().rec.pansharpen ?? {}), on: false })) }]),
    run: async () => {
      const p = pane();
      if (p.rec.pansharpen?.on) {
        S.transact('Pan-sharpen off', (tx) => tx.set(p.id, 'pansharpen', { ...p.rec.pansharpen, on: false }));
        return app.renderer.invalidate();
      }
      const ls = images(p);
      const opt = (l) => h('option', { value: l.id }, `${l.rec.name} (${l.bands} band${l.bands > 1 ? 's' : ''}, ${l.width} × ${l.height})`);
      const ms = h('select', { class: 'inp', 'aria-label': 'Multispectral layer' }, ...ls.map(opt));
      const pan = h('select', { class: 'inp', 'aria-label': 'Pan layer' }, ...ls.map(opt));
      ms.value = (ls.find((l) => l.bands >= 3) ?? ls[0]).id;
      pan.value = (ls.find((l) => l.bands === 1) ?? ls.at(-1)).id;
      const method = h('select', { class: 'inp', 'aria-label': 'Method' }, ...METHODS.map(([v, t]) => h('option', { value: v }, t)));
      const nir = h('input', { class: 'inp inp-small', type: 'number', min: '1', step: '1', value: '4', 'aria-label': 'NIR band (1-based)' });
      const body = h('div', {}, field('Multispectral', ms), field('Pan', pan), field('Method', method), field('NIR band (IHS-NIR)', nir), h('p', { class: 'hint' }, 'The MS colour bands come from its image chain. A coarser MS image is placed on the pan grid through the two sensor models.'));
      if ((await modal({ title: 'Pan Sharpen', body, buttons: ['Apply', 'Cancel'], id: 'pansharpen' })) !== 'Apply') return;
      try {
        app.setPanSharpen(p, { ms: ms.value, pan: pan.value, method: method.value, nir: Math.max(0, Number(nir.value) - 1) });
      } catch (e) {
        app.toast(e.message, { kind: 'warn' });
      }
    },
  });

  // ---- CLAHE ----
  C.implement('enh.clahe', {
    enabled: () => !!app.activeLayer(),
    checked: () => !!app.activeLayer()?.chain?.clahe?.on,
    run: async () => {
      const l = app.activeLayer();
      if (l.chain.clahe?.on) return app.setChain((c) => (c.clahe = { ...c.clahe, on: false }), 'CLAHE off');
      const grid = h('input', { class: 'inp inp-small', type: 'number', min: '2', max: '32', step: '1', value: String(l.chain.clahe?.grid ?? 8), 'aria-label': 'Tiles per side' });
      const clip = h('input', { class: 'inp inp-small', type: 'number', min: '1', max: '10', step: '0.5', value: String(l.chain.clahe?.clip ?? 2.5), 'aria-label': 'Clip limit' });
      const body = h('div', {}, field('Tiles per side', grid), field('Clip limit (× mean bin)', clip), h('p', { class: 'hint' }, 'Contrast-limited adaptive equalisation of the displayed image: tile maps from the full-image statistics, blended per pixel on the GPU.'));
      if ((await modal({ title: 'CLAHE', body, buttons: ['Apply', 'Cancel'], id: 'clahe' })) !== 'Apply') return;
      app.setChain((c) => (c.clahe = { on: true, grid: Number(grid.value) || 8, clip: Number(clip.value) || 2.5 }), 'CLAHE');
    },
  });
}
