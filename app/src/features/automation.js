// Automation API and console (REQ-ARC-17): a small JavaScript API on `gisworkbench.api` that
// mirrors DevKit concepts — open an image, image ↔ ground through the active sensor model,
// create a graphic, set the image chain, run a command, export a chip. Each call is an undoable
// store transaction, as if the analyst had done it. The Automation Console runs one call per
// line as `method {json arguments}`: the file's CSP forbids eval, so nothing typed is evaluated
// as code.
//
// The API's method docs, results and error texts are developer API text (DN-62 rule 7): they stay
// English for scripts and AI models. Only the console's own UI and undo labels are translated.

import { h, clear } from '../shell/dom.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { chainSummary } from '../render/chain.js';
import { t } from '../i18n/index.js';
import { makeV2Api, wireEvents } from '../automation/api-v2-core.js';
import { loadBlock } from './lazy-host.js';

export const name = 'automation';

const clone = (x) => JSON.parse(JSON.stringify(x));

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const layerOf = (id) => {
    const l = id ? app.layers.get(id) : pane()?.geoLayer();
    if (!l) throw new Error(id ? `no layer ${id}` : 'no image in the active panel');
    return l;
  };

  const api = {
    version: () => ({ version: app.build?.version ?? null, build: app.build?.id ?? null, api: 1 }),
    help: () => Object.keys(api).sort(),
    /** Layers of the project: [{id, name, kind, width, height, model}]. */
    layers: () => [...app.layers.values()].map((l) => ({ id: l.id, name: l.rec?.name, kind: l.kind, width: l.width, height: l.height, model: l.modelName ?? null })),
    /** Open image files (File objects; from the console, a picker). Returns the new layer ids. */
    async openImage({ files = null } = {}) {
      const fs = files ?? (await pickFiles(app, { description: t('Imagery') }));
      const before = new Set(app.layers.keys());
      await app.openFiles(fs, pane());
      return [...app.layers.keys()].filter((k) => !before.has(k));
    },
    /** Image (x, y) → ground {lat, lon, h, heightSource, mgrs} with the terrain when loaded. */
    groundPoint({ x, y, layer = null }) {
      const l = layerOf(layer);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('give x and y (image pixels)');
      const g = l.groundWithTerrain(x, y);
      if (!g) throw new Error('the layer has no sensor model');
      return { lat: g.lat, lon: g.lon, h: g.h, heightSource: g.heightSource ?? null, mgrs: app.core.mgrs(g.lat, g.lon, 5) };
    },
    /** Ground → image (x, y). */
    imagePoint({ lat, lon, h = null, layer = null }) {
      const l = layerOf(layer);
      const hh = Number.isFinite(h) ? h : app.terrain.sample(lat, lon)?.hae ?? l.defaultHeight() ?? 0;
      const q = l.imageAt(lat, lon, hh);
      if (!q) throw new Error('the point does not project into the image');
      return { x: q.x, y: q.y, h: hh };
    },
    /** A ground graphic in the active panel: coordinates [[lon, lat(, h)], …]. Returns its id. */
    createGraphic({ shape = 'marker', coordinates, text = '', style = null }) {
      const p = pane();
      if (!p) throw new Error('no active panel');
      if (!Array.isArray(coordinates) || !coordinates.length || coordinates.some((c) => !Array.isArray(c) || c.length < 2 || !c.slice(0, 2).every(Number.isFinite))) throw new Error('coordinates must be [lon, lat] pairs');
      const h0 = p.geoLayer()?.defaultHeight() ?? 0;
      let id = null;
      app.store.transact(t('Automation: draw {shape}', { shape }), (tx) => {
        let gl = p.rec.graphicsLayer;
        if (!gl) {
          gl = tx.create('glayer', { pane: p.id, name: t('Graphics'), visible: true, saved: false });
          tx.set(p.id, 'graphicsLayer', gl);
        }
        id = tx.create('graphic', { glayer: gl, pane: p.id, shape, anchor: 'ground', coords: coordinates.map(([lon, lat, hh]) => [lon, lat, Number.isFinite(hh) ? hh : app.terrain.sample(lat, lon)?.hae ?? h0]), text, style: style ?? { stroke: '#e00000', width: 2, fill: '#e0000040' }, created: new Date().toISOString(), provenance: { kind: 'automation' } });
      });
      p.invalidate();
      return id;
    },
    /** Image chain: {layer, stretch, draScope, brightness, contrast, gamma, saturation, invert, palette, interpolation}. */
    setChain(a = {}) {
      const l = layerOf(a.layer);
      const c = clone(l.chain);
      if (a.stretch) c.stretch = a.stretch;
      if (a.draScope) c.dra.scope = a.draScope;
      for (const k of ['brightness', 'contrast', 'gamma']) if (a[k] !== undefined) c.tone[k] = a[k];
      if (a.invert !== undefined) c.tone.invert = !!a.invert;
      if (a.saturation !== undefined) c.colour.saturation = a.saturation;
      if (a.palette) c.colour.palette = a.palette;
      if (a.interpolation) c.kernel = a.interpolation;
      app.store.transact(t('Automation: image chain'), (tx) => tx.set(l.id, 'chain', c));
      return chainSummary(c);
    },
    /** Run a catalogued command by id. */
    async runCommand({ id }) {
      const c = C.get(id);
      if (!c) throw new Error(`no command ${id}`);
      if (!c.implemented) throw new Error(`${c.label} is not implemented in this build`);
      if (!C.enabled(id)) throw new Error(`${c.label} is not available now`);
      await C.run(id);
      return `ran ${id}`;
    },
    /** View of the active panel: get, or set {cx, cy, zoom, rot}. */
    view(v = null) {
      const p = pane();
      if (!p) throw new Error('no active panel');
      if (v && Object.keys(v).length) p.setView(v);
      const { cx, cy, zoom, rot } = p.view;
      return { cx, cy, zoom, rot };
    },
    /** A chip of the active panel (caption, north arrow, scale bar); `save` writes the PNG. */
    async exportChip({ width = 1024, height = 768, save = false } = {}) {
      const c = await app.makeChip({ width, height });
      if (save) {
        const blob = await new Promise((res) => c.canvas.toBlob(res, 'image/png'));
        await saveBlob(app, blob, { name: 'chip.png', types: ['.png'], description: 'PNG' });
      }
      const r = c.record;
      return { caption: r.caption, image: r.image, cornersGround: r.cornersGround, metresPerPixel: r.metresPerPixel };
    },
  };
  app.api = api;
  // API v2 (REQ-GAP-01): a separate, versioned surface; v1 above is unchanged. The object, its
  // argument checks and events are here from boot; the implementations (automation/api-v2-impl.js) bind
  // from the lazy js-apiv2 block on the first call.
  Object.defineProperty(api, 'v2', { value: makeV2Api(app, async (v2) => (await loadBlock(app, 'js-apiv2')).makeV2Impl(app, v2)), enumerable: false });
  wireEvents(app, api.v2);

  /** One console line → result (`method {json}`, or `method` alone). */
  async function runLine(line) {
    const m = /^\s*([A-Za-z][\w.]*)\s*(.*)$/s.exec(line);
    if (!m) throw new Error('write a method name, then its arguments as JSON');
    // A dotted name is an API v2 method (layers.list, ai.find …).
    const fn = m[1].includes('.') ? (a) => api.v2.call(m[1], a ?? {}) : api[m[1]];
    if (typeof fn !== 'function') throw new Error(`no method "${m[1]}"; try help (v1) or api.describe (v2)`);
    let args;
    if (m[2].trim()) {
      try {
        args = JSON.parse(m[2], (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v));
      } catch {
        throw new Error('the arguments must be a JSON object, for example x 100 and y 200 written as JSON');
      }
    }
    return fn(args);
  }
  api.runLine = runLine;

  const history = [];
  function consoleDock(el) {
    const out = h('div', { class: 'console-out mono small', role: 'log', 'aria-live': 'polite', 'data-id': 'auto-out' });
    const inp = h('input', { class: 'inp mono', spellcheck: 'false', autocomplete: 'off', placeholder: 'groundPoint {"x": 512, "y": 512}', 'aria-label': t('Automation command'), 'data-id': 'auto-in' }); // i18n-ignore: the placeholder is API call syntax
    const print = (cls, text) => {
      out.appendChild(h('div', { class: cls }, text));
      out.scrollTop = out.scrollHeight;
    };
    let at = 0;
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowUp' && history.length) {
        at = Math.max(0, at - 1);
        inp.value = history[at] ?? '';
        return;
      }
      if (e.key !== 'Enter' || !inp.value.trim()) return;
      const line = inp.value;
      history.push(line);
      at = history.length;
      inp.value = '';
      print('console-in', `› ${line}`);
      try {
        const r = await runLine(line);
        print('console-ok', typeof r === 'string' ? r : JSON.stringify(r, null, 1));
      } catch (err) {
        print('console-err', err.message); // developer API text stays English (DN-62 rule 7)
      }
    });
    clear(el);
    el.append(h('p', { class: 'hint pad' }, t('One call per line: a method and JSON arguments. The same API is gisworkbench.api in the browser console. help lists the methods.')), out, inp);
  }
  const reg = (mp) => mp.docks.register({ id: 'console', title: t('Automation Console'), icon: 'console', home: 'bottom', create: (a, m, el) => consoleDock(el) });
  app.on('ready', (mp) => reg(mp));
  const orig = app.desktop.addMultiport.bind(app.desktop);
  app.desktop.addMultiport = (id) => {
    const mp = orig(id);
    if (app._ready) reg(mp);
    return mp;
  };
  C.implement('auto.console', { run: () => app.panels.toggle('console', 'bottom'), checked: () => !!app.activeMp()?.docks.isOpen('console') });
}
