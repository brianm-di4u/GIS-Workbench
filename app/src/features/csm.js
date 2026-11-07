// CSM sensor models from usgscsm ISDs (REQ-GAP-24): the command is eager; its implementation, the
// usgscsm loader and the host bridge are in the lazy block js-csm (sensor/csm.js), and the module
// itself in wasm-usgscsm. A layer saved with a CSM model restores it on project reload.

import { lazyCommands, loadBlock, once } from './lazy-host.js';

export const name = 'csm';

export function install(app) {
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-csm');
    lib.install(app);
    return lib;
  });
  lazyCommands(app, ['model.csm'], load, { 'model.csm': { enabled: () => !!app.activeLayer() && app.activeLayer().kind !== 'dem' } });
  const stub = async (l) => {
    await load();
    return app.restoreCsmModel === stub ? null : app.restoreCsmModel(l);
  };
  app.restoreCsmModel = stub;
}
