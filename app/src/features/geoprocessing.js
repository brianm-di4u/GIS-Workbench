// 2.7.0 vector geoprocessing (REQ-GAP-79): the commands and app.geoproc, whose implementation is the
// lazy js-geoproc block (lazy/geoproc.lazy.js: features/geoproc-ui.js), and the `geoproc` WASM
// bundle for the analysis workers (buffer and dissolve).

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'geoprocessing';

export function install(app) {
  // The workers ask the pool for the bundle by name on first use.
  if (app.pool?.lazyModules && !app.pool.lazyModules.geoproc) app.pool.lazyModules.geoproc = () => app.gw.wasm('wasm-geoproc');
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-geoproc');
    lib.install(app);
    return lib;
  });
  app.geoproc = {};
  lazyMethods(app.geoproc, ['buffer', 'overlay', 'dissolve', 'join'], load, () => app.geoproc);
  const n = () => app.store.all('vlayer').length;
  lazyCommands(app, ['vec.buffer', 'vec.overlay', 'vec.dissolve', 'vec.join'], load, {
    'vec.buffer': { enabled: () => n() > 0 },
    'vec.overlay': { enabled: () => n() > 1 },
    'vec.dissolve': { enabled: () => n() > 0 },
    'vec.join': { enabled: () => n() > 1 },
  });
}
