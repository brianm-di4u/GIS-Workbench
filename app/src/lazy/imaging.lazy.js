// Lazy 2.4 imaging block (REQ-GAP-14, REQ-GAP-34; 2.4 group imaging): pan-sharpened products and
// COLLADA / model-KMZ import. Loaded the first time one of those commands, app.pansharpen
// functions or a model import runs
// (features/imaging-lazy.js). Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs).

import { install as installPansharpen } from '../features/pansharpen.js';
import { openModelFile } from '../hub/mesh-import.js';

(globalThis.__lib ??= {})['js-imaging'] = {
  install(app) {
    installPansharpen(app);
  },
  openModelFile,
};
