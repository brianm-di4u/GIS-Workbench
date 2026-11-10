// Lazy geocoding and routing block (REQ-GAP-85; 2.7.1): address indexes, Find Address, batch and
// reverse geocoding, road graphs, routes and service areas (features/routing-tools.js). Loaded by
// the first net.* command or app.routing call (features/routing.js). Its imports of the app's
// stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/routing-tools.js';

(globalThis.__lib ??= {})['js-routing'] = { install };
