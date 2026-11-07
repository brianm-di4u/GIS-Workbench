// Lazy field-tools block (OD-2.23; 2.5 group mobile): My Location, Field Observation with photos
// and Export Observations (features/field.js). The commands are eager (features/field-lazy.js).
// Its imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/field.js';

(globalThis.__lib ??= {})['js-field'] = { install };
