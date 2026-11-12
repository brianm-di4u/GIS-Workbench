// 2.7.4 SAR geocoding and terrain correction (REQ-GAP-90, REG-085): the Terrain Correction command and
// app.sarTerrain, whose implementation is the lazy js-sargeo block (lazy/sargeo.lazy.js:
// features/sar-terrain-ui.js), and the `sargeo` WASM bundle for the analysis workers.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
// A Sentinel-1 SAFE layer whose annotation carries the timing and orbit geocoding needs, opened with
// its calibration (β⁰ is read from the calibrated band; without the LUT it is NaN).
import { s1Layer } from '../analysis/s1-layer.js';

export const name = 'sar-terrain';

export function install(app) {
  if (app.pool?.lazyModules && !app.pool.lazyModules.sargeo) app.pool.lazyModules.sargeo = () => app.gw.wasm('wasm-sargeo');
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-sargeo');
    lib.install(app);
    return lib;
  });
  app.sarTerrain = {};
  lazyMethods(app.sarTerrain, ['run', 'readOrbit'], load, () => app.sarTerrain);
  lazyCommands(app, ['sar.terrain'], load, {
    'sar.terrain': { enabled: () => s1Layer(app.activeLayer()) },
  });
}
