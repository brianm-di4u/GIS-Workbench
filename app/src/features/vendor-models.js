// 2.5 vendor rigorous models (REQ-GAP-20): DigitalGlobe/Maxar EPH/ATT/GEO/IMD line scanners, and
// the map + line-of-sight models of Landsat L1 (ANG) and Sentinel-2 L1C (MTD_TL). The readers are
// in the lazy vendor bundle (analysis worker); the app side is the lazy js-vendor block
// (lazy/vendor.lazy.js). Here: the command and app.vendorModels, which load the block on first use.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

const installs = new WeakMap();
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-vendor');
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export const name = 'vendorModels';

export function install(app) {
  const load = () => loadFor(app);
  app.vendorModels = {};
  lazyMethods(app.vendorModels, ['attachDg', 'loadFiles'], load, () => app.vendorModels);
  const image = () => {
    const l = app.activeLayer?.();
    return l && l.kind !== 'dem' && l.handle ? l : null;
  };
  lazyCommands(app, ['model.vendor'], load, { 'model.vendor': { enabled: () => !!image() } });
}
