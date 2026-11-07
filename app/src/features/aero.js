// Aerial triangulation (REQ-GAP-22): the commands (implemented by the lazy js-aero block,
// features/aero-ui.js) and the solved frame models, which follow the store: a layer's
// rec.aeroModel {label, name, rec} (a gw_sensor::frame parameter record) becomes its active
// "Frame camera (aerial triangulation …)" model; undo, redo and project reload rebuild or remove
// it, and the image's earlier frame model comes back when it is removed.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
import { t, msgOf } from '../i18n/index.js';
import { saveBlob } from '../storage/files.js';

export const name = 'aero';

export function install(app) {
  const S = app.store;
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-aero');
    lib.install(app, { saveBlob }); // the app's own (the block carries no copy)
    return lib;
  });
  const hasFrame = (l) => l?.kind === 'image' && (l.models ?? []).some((m) => m.record?.type === 3);
  app.aero = {};
  lazyMethods(app.aero, ['collect', 'solve', 'apply', 'resect', 'fiducials', 'reportText'], load, () => app.aero);
  lazyCommands(app, ['tri.aero', 'tri.resect', 'tri.fiducials'], load, {
    'tri.aero': { enabled: () => [...app.layers.values()].some(hasFrame) },
    'tri.resect': { enabled: () => hasFrame(app.activePane()?.geoLayer?.()) },
    'tri.fiducials': { enabled: () => [...app.layers.values()].some((l) => l.kind === 'image') },
  });

  function sync() {
    let changed = false;
    for (const l of app.layers.values()) {
      const a = l.rec?.aeroModel ?? null;
      const sig = a ? `${a.label}:${JSON.stringify(a.rec)}` : '';
      if ((l._aeroSig ?? '') === sig) continue;
      l._aeroSig = sig;
      const others = (l.models ?? []).filter((m) => !m.aero);
      if (a) {
        try {
          const id = app.core.frameModelEx(a.rec, a.name);
          const info = app.core.modelInfo(id);
          l.models = [...others, { name: info.name, id, info, aero: true, record: { type: 3, rec: a.rec } }];
          l.modelId = id;
          l.modelName = info.name;
          l.modelInfo = info;
        } catch (e) {
          app.toast(t('{layer}: triangulated frame model not restored ({msg})', { layer: l.rec?.name ?? '', msg: msgOf(e) }), { kind: 'warn' });
          continue;
        }
      } else {
        const was = (l.models ?? []).some((m) => m.aero && m.id === l.modelId);
        l.models = others;
        if (was) {
          const back = others.find((m) => m.wizard) ?? others.find((m) => m.record?.type === 3) ?? others[0];
          if (back) {
            l.modelId = back.id;
            l.modelName = back.name;
            l.modelInfo = back.info;
          }
        }
      }
      changed = true;
    }
    if (changed) {
      app.renderer?.invalidate?.();
      for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) p.invalidate();
      app.emit('state');
    }
  }
  S.on('change', sync);
  app.on('state', sync); // layers created after their records (project reload)
}
