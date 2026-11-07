// CSM sensor models from usgscsm ISDs (REQ-GAP-24, spike S-60), in the lazy block js-csm.
//
// Model ▸ Attach CSM ISD… reads a usgscsm ISD (JSON, as ALE writes it) for the active image and
// builds the CSM model it names (frame camera, line scanner, push frame or SAR) in the usgscsm
// WebAssembly module (block wasm-usgscsm, sensor/csm-wasm.js). The model is registered in the Rust
// core as a gw_sensor::host::HostModel, so it is a selectable model like any other: read-outs,
// measurements and their CE90/LE90 (from the CSM parameter covariance and sensor partials), the
// DEM intersection, and the block adjustment through its CSM parameters (the analysis worker
// rebuilds it from its state, type-9 records). The layer keeps the model state, so the project
// restores it.
//
// The ISD's image size must be the image's. ISDs for other bodies (every usgscsm test ISD) give
// positions on that body's ellipsoid; GIS Workbench's distances and grids assume WGS 84, so it
// says so. GIS Workbench does not claim CSM conformance (D14, REQ-SEC-07).

import { t, gwError, msgOf } from '../i18n/index.js';
import { num } from '../i18n/format.js';
import { pickFiles } from '../storage/files.js';
import { Usgscsm, CSM_MODELS, stateRecord } from './csm-wasm.js';
import { installCsmBridge } from './csm-host.js';

const WGS84 = { a: 6378137, b: 6356752.314245 };
const stem = (s) => String(s ?? '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

export function installCsm(app) {
  const C = app.commands;
  const S = app.store;
  let csm = null;
  let bridge = null;

  /** The usgscsm module and its bridge on the main thread (compiled and run once). */
  async function module() {
    if (!csm) {
      const t0 = performance.now();
      const mod = await (app.gw ?? globalThis.__gw).wasm('wasm-usgscsm');
      const t1 = performance.now();
      const c = new Usgscsm(mod);
      bridge = installCsmBridge(c);
      csm = c;
      app.csmStats = { compileMs: t1 - t0, instantiateMs: performance.now() - t1, version: c.version() };
      app.log?.('info', `usgscsm ${app.csmStats.version.usgscsm} loaded: compile ${app.csmStats.compileMs.toFixed(0)} ms, instantiate ${app.csmStats.instantiateMs.toFixed(0)} ms`);
    }
    return { csm, bridge };
  }

  /** Register usgscsm handle `h` as the layer's active model. */
  function register(l, h, { file, warnings = [] }, { save = true, activate = () => true } = {}) {
    bridge.adopt(h);
    let id;
    try {
      id = app.core.hostModel(h);
    } catch (e) {
      csm.free(h);
      throw e;
    }
    const ci = csm.info(h);
    const state = csm.state(h);
    const info = app.core.modelInfo(id);
    for (const m of l.models ?? []) if (m.csm && m.id !== id) app.core.freeModel(m.id);
    const entry = { name: info.name, id, info, record: { type: 9, rec: stateRecord(state) }, csm: { file, model: ci.model, sensor: ci.sensor, platform: ci.platform, a: ci.a, b: ci.b, params: ci.params.length } };
    l.models = [...(l.models ?? []).filter((m) => !m.csm && m.name !== info.name), entry];
    if (activate(info.name)) {
      l.modelId = id;
      l.modelName = info.name;
      l.modelInfo = info;
    }
    if (save)
      S.transact(t('CSM model'), (tx) => {
        tx.set(l.id, 'csm', { file, model: ci.model, state });
        tx.set(l.id, 'model', info.name);
      });
    app.activePane()?.applyOrientation?.();
    app.emit('state');
    const notes = [...warnings];
    if (Math.abs(ci.a - WGS84.a) > 1 || Math.abs(ci.b - WGS84.b) > 1) notes.push(t('the ISD is for a body with radii {a} km × {b} km, not the Earth: positions are on that body’s ellipsoid, and distances, areas and grid references (which assume WGS 84) do not apply', { a: num(ci.a / 1000, 3), b: num(ci.b / 1000, 3) }));
    return { id, name: info.name, model: ci.model, params: ci.params.length, notes };
  }

  /** Attach ISD text (from file `file`) to layer l. */
  async function attach(l, text, file) {
    if (!l || l.kind === 'dem' || !(l.width > 0)) throw gwError('Make an image layer active to attach a CSM ISD to it', null, 'E_CSM_NO_IMAGE');
    const c0 = String(text).charCodeAt(0);
    if (c0 >= 0x80 && c0 <= 0x8f) throw gwError('{file}: msgpack ISDs are not read; write the ISD as JSON', { file }, 'E_CSM_MSGPACK');
    let isd;
    try {
      isd = JSON.parse(text);
    } catch {
      throw gwError('{file} is not a usgscsm ISD: it is not JSON', { file }, 'E_CSM_NOT_JSON');
    }
    const model = isd?.name_model;
    if (!CSM_MODELS[model]) throw gwError('{file}: the ISD names the model {model}, which is not one this build of usgscsm has (frame, line scanner, push frame or SAR)', { file, model: String(model ?? '–') }, 'E_CSM_MODEL');
    if (isd.image_samples !== l.width || isd.image_lines !== l.height) throw gwError('{file} describes a {w} × {h} image; {layer} is {lw} × {lh}', { file, w: isd.image_samples ?? '–', h: isd.image_lines ?? '–', layer: l.rec?.name ?? '', lw: l.width, lh: l.height }, 'E_CSM_SIZE');
    const { csm: c } = await module();
    const { handle, warnings } = c.fromIsd(text, { id: stem(file) });
    return register(l, handle, { file, warnings });
  }

  C.implement('model.csm', {
    enabled: () => !!app.activeLayer() && app.activeLayer().kind !== 'dem',
    /** arg: {file: File | {name, text}, layer?} (automation and tests); otherwise a file picker. */
    run: async (arg) => {
      const l = arg?.layer ? app.layers.get(arg.layer) : app.activeLayer();
      let f = arg?.file;
      if (!f) [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: t('usgscsm ISD (JSON)') });
      if (!f) return null;
      try {
        const text = typeof f.text === 'string' ? f.text : await f.text();
        const r = await attach(l, text, f.name ?? 'ISD');
        app.toast(t('{layer}: {model} from {file}. GIS Workbench does not claim CSM conformance.', { layer: l.rec?.name ?? '', model: r.name, file: f.name ?? 'ISD' }), { kind: 'ok', ms: 6000 });
        for (const n of r.notes) app.toast(t('{model}: {msg}', { model: r.name, msg: n }), { kind: 'warn', ms: 9000 });
        return r;
      } catch (e) {
        app.toast(msgOf(e), { kind: 'error', ms: 9000 });
        if (arg?.throw) throw e;
        return { error: msgOf(e), code: e.code ?? null };
      }
    },
  });

  // Project reload: the model state saved with the layer.
  app.restoreCsmModel = async (l) => {
    const s = l.rec?.csm;
    if (!s?.state) return null;
    try {
      const { csm: c } = await module();
      // Active again only if it was the layer's model when saved.
      return register(l, c.fromState(s.state), { file: s.file }, { save: false, activate: (name) => !l.rec?.model || l.rec.model === name });
    } catch (e) {
      app.toast(t('{layer}: the CSM model was not restored ({msg})', { layer: l.rec?.name ?? '', msg: msgOf(e) }), { kind: 'warn', ms: 9000 });
      return null;
    }
  };

  // For automation and tests: the module itself (load time, direct calls).
  app.csm = { module, attach };
}
