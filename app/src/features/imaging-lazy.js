// 2.4 imaging (REQ-GAP-14, REQ-GAP-34): pan-sharpened products (features/pansharpen.js,
// analysis/pansharpen.js) and COLLADA / model-KMZ import into the 3D view (hub/mesh-import.js with the readers of
// vector/mesh-formats.js) are the lazy js-imaging block (lazy/imaging.lazy.js). Here: the
// features' commands, with their enabled tests, and app.pansharpen, which
// loads the block on first use; its install replaces them. The model writers stay eager
// (app.extractR2.export3d is synchronous).

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

const block = (app) => loadBlock(app, 'js-imaging');

/** Open a .dae or model KMZ in the 3D view (hub/mesh-import.js, in the block). */
export async function openModelFile(app, file, resources = []) {
  return (await block(app)).openModelFile(app, file, resources);
}

const installs = new WeakMap();
/** Load the block and install its features once per app → the block's library. */
const loadFor = (app) => {
  if (!installs.has(app))
    installs.set(
      app,
      once(async () => {
        const lib = await block(app);
        lib.install(app);
        return lib;
      }),
    );
  return installs.get(app)();
};

export const pansharpen = {
  name: 'pansharpen',
  install(app) {
    const pane = () => app.activePane();
    const images = (p) => (p?.visibleLayers() ?? []).filter((l) => l.kind !== 'dem' && l.handle);
    const load = () => loadFor(app);
    app.pansharpen = { last: null };
    lazyMethods(app.pansharpen, ['product', 'affineOf', 'bitsOf'], load, () => app.pansharpen);
    lazyCommands(app, ['enh.pansharpenproduct'], load, { 'enh.pansharpenproduct': { enabled: () => images(pane()).length >= 2 } });
  },
};
