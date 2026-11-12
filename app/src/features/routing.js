// Geocoding and routing on the user's own data (REQ-GAP-85; Full). The work — address indexes,
// Find Address, batch and reverse geocoding, road graphs, routes and service areas — is the lazy
// js-routing block (lazy/routing.lazy.js → features/routing-tools.js). Here: the commands with
// their enabled tests, app.routing methods that load the block on first use, and the address
// fallback of the coordinate box.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'routing';

export const NET_COMMANDS = ['addr.index', 'addr.find', 'addr.batch', 'addr.reverse', 'route.roads', 'route.shortest', 'route.service'];
export const NET_METHODS = ['indexLayer', 'saveIndex', 'openIndex', 'geocode', 'reverse', 'geocodeTable', 'buildRoads', 'route', 'serviceArea'];

export function install(app) {
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-routing');
    lib.install(app);
    return lib;
  });
  // The block keeps the index (geocoder) and the graph here (app.network is the online state).
  app.routing = { geocoder: null, graph: null };
  app.store.on('reset', () => {
    app.routing.geocoder = null;
    app.routing.graph = null;
  });
  lazyMethods(app.routing, NET_METHODS, load);
  const vector = (re) => app.store.all('feature').some((f) => re.test(f.geom?.type ?? ''));
  lazyCommands(app, NET_COMMANDS, load, {
    'addr.index': { enabled: () => vector(/Point|LineString/) },
    'addr.find': { enabled: () => !!app.routing.geocoder },
    'addr.batch': { enabled: () => !!app.routing.geocoder },
    'addr.reverse': { enabled: () => !!app.routing.geocoder },
    'route.roads': { enabled: () => vector(/LineString/) },
    'route.shortest': { enabled: () => !!app.routing.graph },
    'route.service': { enabled: () => !!app.routing.graph },
  });
}
