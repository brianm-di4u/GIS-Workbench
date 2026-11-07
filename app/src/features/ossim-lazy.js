// The command of the OSSIM route is eager; its implementation is the lazy js-ossim block (REQ-GAP-21).

import { lazyCommands, loadBlock, once } from './lazy-host.js';

export const name = 'ossim';

export function install(app) {
  /** Add the fitted RPC to a layer. Eager: a project reload needs it, and needs nothing else here. */
  app.addOssimRpc = (l, { name, rec, notes }, { activate }) => {
    const id = app.core.rpcModel(rec);
    const info = app.core.modelInfo(id);
    l.models = [...(l.models ?? []).filter((m) => m.name !== name), { name, id, info, record: { type: 0, rec }, notes }];
    if (activate) {
      l.modelId = id;
      l.modelName = name;
      l.modelInfo = info;
    }
    app.activePane?.()?.applyOrientation?.();
    app.emit('state');
    return id;
  };
  // Project reload: active again only if it was the layer's model when saved.
  app.restoreOssimModel = (l) => {
    const s = l.rec?.ossimRpc;
    if (s?.rec) app.addOssimRpc(l, s, { activate: !l.rec?.model || l.rec.model === s.name });
  };
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-ossim');
    lib.install(app);
    return lib;
  });
  lazyCommands(app, ['model.ossim'], load, { 'model.ossim': { enabled: () => app.activeLayer?.()?.kind === 'image' } });
}
