// Lazy 2.5 models3d block (REQ-GAP-35, REQ-GAP-68): I3S scene layers in the 3D view (SLPK and
// services), SLPK / OpenFlight writing and the 3D PDF (PRC). Loaded the first time one of its
// commands or app.models3d functions runs (features/models3d-lazy.js). Its imports of the app's
// stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/models3d.js';

(globalThis.__lib ??= {})['js-models3d'] = { install };
