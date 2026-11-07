// Lazy 2.5 aviation block (SDP-2.3 GR-27, group aviation): airports and runways, FAA Part 77 and
// ICAO Annex 14 obstruction surfaces (REQ-GAP-73) and route / flight planning (REQ-GAP-74). Loaded
// the first time one of their commands or app.aviation / app.flightPlan functions runs
// (features/aviation.js). Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs).

import { install as installObstruction } from '../features/aviation-obstruction.js';
import { install as installFlightPlan } from '../features/flight-plan.js';

(globalThis.__lib ??= {})['js-aviation'] = {
  install(app) {
    installObstruction(app);
    installFlightPlan(app);
  },
};
