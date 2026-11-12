// Lazy 2.7.4 SAR geocoding and terrain correction block (REQ-GAP-90, REG-085): the Terrain Correction
// command and app.sarTerrain. Loaded the first time either is used (features/sar-terrain.js). Its
// imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/sar-terrain-ui.js';

(globalThis.__lib ??= {})['js-sargeo'] = { install };
