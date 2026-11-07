// 2.6 group sfm: the eager stub of the structure-from-motion command. The dialog is the lazy js-sfm
// block (lazy/sfm.lazy.js, features/sfm.js). Full only.

import { loadBlock, once, lazyCommands } from './lazy-host.js';

export const name = 'sfm';

const installs = new WeakMap();
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-sfm');
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export function install(app) {
  lazyCommands(app, ['sidecar.sfm'], () => loadFor(app));
}
