// Lazy GeoPDF block (REQ-GAP-66): the GeoPDF Map export (layout, projection, writer) and the
// georeferencing of GeoPDF vector layers on open. features/geopdf.js hands it the app's modules.

import { init as initMap, geoPdfMap } from '../formats/geopdf-map.js';
import { init as initVectors, openGeoPdfVectors } from '../formats/geopdf-vectors.js';

(globalThis.__lib ??= {})['js-geopdf'] = {
  init(d) {
    initMap(d);
    initVectors(d);
  },
  geoPdfMap,
  openGeoPdfVectors,
};
