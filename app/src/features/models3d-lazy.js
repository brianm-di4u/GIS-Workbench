// 2.5 group models3d (REQ-GAP-35, REQ-GAP-68): I3S scene layers (SLPK files and scene services)
// in the 3D view, SLPK and OpenFlight writing, and the 3D PDF. The work is the lazy js-models3d
// block (lazy/models3d.lazy.js, features/models3d.js); here: the commands' eager stubs with their
// enabled tests, and app.models3d, whose functions load the block on first use. Full only: the
// Lite profile has no 3D view (js-three).

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
import { saveBlob, pickFiles } from '../storage/files.js';

export const name = 'models3d';

const installs = new WeakMap();
/** Load the block and install its features once per app → the block's library. */
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-models3d');
        lib.install(app, { saveBlob, pickFiles });
        return lib;
      }),
    );
  return installs.get(app)();
};

export function install(app) {
  const pane = () => app.activePane?.();
  const load = () => loadFor(app);
  app.models3d = {};
  lazyMethods(app.models3d, ['openSlpk', 'openService', 'identifyAt', 'saveTerrain', 'exportBuildings', 'export3dPdf', 'layers'], load, () => app.models3d);
  const i3sIn = () => !!pane()?.view3d?.tilesets?.some((l) => l?.info?.layerType);
  lazyCommands(app, ['3d.slpk', '3d.i3s', '3d.i3sidentify', '3d.pdf'], load, { '3d.i3sidentify': { enabled: i3sIn }, '3d.pdf': { enabled: () => !!pane()?.view3d } });
}
