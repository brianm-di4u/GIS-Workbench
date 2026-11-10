// Lazy 2.7.0 hydrology block (REQ-GAP-80, SDP-2.7 §4.2): fill, flow accumulation, stream networks
// and watersheds on the terrain grid. Loaded the first time a Hydrology command or an
// app.hydrology function runs (features/hydrology.js). Its imports of the app's stateful modules
// are the app's own (build/host-modules.mjs).

import { install } from '../features/hydrology-tools.js';

(globalThis.__lib ??= {})['js-hydrology'] = { install };
