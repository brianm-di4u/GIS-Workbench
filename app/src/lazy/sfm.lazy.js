// Lazy 2.6 block (group sfm): the dialog of the UAV structure-from-motion route (features/sfm.js).
// Loaded the first time the command runs (features/sfm-lazy.js). Full only: Lite has no sidecar.

import { install } from '../features/sfm.js';

(globalThis.__lib ??= {})['js-sfm'] = { install };
