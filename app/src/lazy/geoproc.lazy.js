// Lazy 2.7.0 vector geoprocessing block (REQ-GAP-79): the Buffer, Overlay, Dissolve and Spatial Join
// commands and app.geoproc. Loaded the first time one of them runs (features/geoprocessing.js). Its
// imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/geoproc-ui.js';

(globalThis.__lib ??= {})['js-geoproc'] = { install };
