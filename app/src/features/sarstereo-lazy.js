// 2.5 SAR stereo terrain (REQ-GAP-42, GR-15; group sarstereo): the pair finder, the
// radargrammetric DSM and its accuracy report (features/sarstereo.js) are the lazy js-sarstereo
// block (lazy/sarstereo.lazy.js). Here: the commands with their enabled tests, and
// app.sarStereo, whose functions load the block on first use; its install replaces them.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'sarstereoLazy';

const installs = new WeakMap();
/** Load the block and install the feature once per app. */
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-sarstereo');
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export function install(app) {
  const sicds = () => [...app.layers.values()].filter((l) => l.info?.sar?.kind === 'SICD' && Array.isArray(l.info.sar.record) && l.modelId && l.handle);
  const load = () => loadFor(app);
  app.sarStereo = { last: null };
  lazyMethods(app.sarStereo, ['findPairs', 'extract', 'saveDsm', 'report', 'reportDialog', 'pairsDialog', 'dsmDialog'], load, () => app.sarStereo);
  lazyCommands(app, ['sar.stereopairs', 'sar.stereodsm', 'sar.stereoreport'], load, {
    'sar.stereopairs': { enabled: () => sicds().length >= 2 },
    'sar.stereodsm': { enabled: () => sicds().length >= 2 },
    'sar.stereoreport': { enabled: () => (app.terrain?.dems?.length ?? 0) >= 2 },
  });
}
