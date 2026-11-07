// Field tools (OD-2.23, REQ-HOST-05; Full and Lite): My Location, Field Observation with photos,
// and Export Observations (KML/KMZ, GeoJSON). The commands are here, eager, with their enabled
// tests; the implementation is the lazy js-field block (lazy/field.lazy.js, features/field.js),
// loaded on first use.

import { loadBlock, once, lazyCommands } from './lazy-host.js';

export const name = 'field';

export function install(app) {
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-field');
    lib.install(app);
    return lib;
  });
  const exportable = () => app.store.all('observation').some((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon)) || app.store.all('graphic').length > 0 || app.store.all('aoi').length > 0;
  lazyCommands(app, ['geo.locate', 'obs.field', 'obs.export'], load, {
    'geo.locate': { checked: () => !!app.location?.watching },
    'obs.export': { enabled: exportable },
  });
}
