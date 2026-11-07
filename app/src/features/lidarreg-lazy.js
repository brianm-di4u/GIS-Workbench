// 2.5 LiDAR registration (REQ-GAP-46, group lidarreg): Point Cloud ▸ Register Image to LiDAR is
// the lazy js-lidarreg block (lazy/lidarreg.lazy.js, features/lidarreg.js). Here: the command with
// its enabled test, and app.lidarreg, whose functions load the block on first use.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

const installs = new WeakMap();
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await loadBlock(app, 'js-lidarreg');
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export const lidarreg = {
  name: 'lidarreg',
  install(app) {
    const hasCloud = () => (app.desktop?.multiports ?? []).some((mp) => mp.panes.some((p) => p.view3d?.clouds?.some((x) => !x.cloud.streamed)));
    const hasImage = () => [...app.layers.values()].some((l) => l.kind !== 'dem' && l.handle && l.modelId);
    const load = () => loadFor(app);
    app.lidarreg = { last: null };
    lazyMethods(app.lidarreg, ['run', 'apply', 'parseSurvey', 'reportText', 'showReport'], load, () => app.lidarreg);
    lazyCommands(app, ['pc.registerimage'], load, { 'pc.registerimage': { enabled: () => hasImage() && hasCloud() } });
  },
};
