// Lazy Datum Transform dialog block (REQ-GAP-16; 2.4 group geod): Georeference ▸ Datum Transform
// (features/datum-dialog.js). The grid engine, the grid packs and the geoid hooks stay eager
// (features/datum-grids.js). Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs).

import { installDatumDialog } from '../features/datum-dialog.js';

(globalThis.__lib ??= {})['js-geod'] = { installDatumDialog };
