// 2.7.0 hydrology (REQ-GAP-80, SDP-2.7 §4.2): Surface ▸ Hydrology commands and app.hydrology,
// whose implementation is the lazy js-hydrology block (lazy/hydrology.lazy.js:
// features/hydrology-tools.js), and the `hydro` WASM bundle for the analysis workers. Full only.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'hydrology';

export function install(app) {
  // The workers ask the pool for the bundle by name on first use.
  if (app.pool?.lazyModules && !app.pool.lazyModules.hydro) app.pool.lazyModules.hydro = () => app.gw.wasm('wasm-hydro');
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-hydrology');
    lib.install(app);
    return lib;
  });
  app.hydrology = { last: null };
  lazyMethods(app.hydrology, ['run', 'fill', 'accumulation', 'streams', 'watershed'], load, () => app.hydrology);
  const dem = { enabled: () => !!app.terrain?.dems?.length };
  lazyCommands(app, ['hydro.fill', 'hydro.flow', 'hydro.streams', 'hydro.watershed'], load, { 'hydro.fill': dem, 'hydro.flow': dem, 'hydro.streams': dem, 'hydro.watershed': dem });
}
