// 2.6 group gdalroutes: eager stubs of the sidecar route commands. The dialogs are the lazy
// js-gdalroutes block (lazy/gdalroutes.lazy.js, features/gdalroutes.js). Full only.

import { loadBlock, once, lazyCommands } from './lazy-host.js';

export const name = 'gdalroutes';

const installs = new WeakMap();
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-gdalroutes');
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export function install(app) {
  lazyCommands(app, ['sidecar.pansharpen', 'sidecar.reproject', 'sidecar.modelexport', 'sidecar.gdbcatalog'], () => loadFor(app));
}
