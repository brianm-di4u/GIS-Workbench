// Lazy 2.5 SAR stereo block (REQ-GAP-42; group sarstereo): the stereo pair finder, the
// radargrammetric DSM and the DSM accuracy report. Loaded the first time one of their commands or
// app.sarStereo functions runs (features/sarstereo-lazy.js). Its imports of the app's stateful
// modules are the app's own (build/host-modules.mjs).

import { install } from '../features/sarstereo.js';

(globalThis.__lib ??= {})['js-sarstereo'] = { install };
