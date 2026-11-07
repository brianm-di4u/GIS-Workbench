// Lazy 2.5 LiDAR registration block (REQ-GAP-46; 2.5 group lidarreg): Register Image to LiDAR
// (features/lidarreg.js). Loaded the first time the command or an app.lidarreg function runs
// (features/lidarreg-lazy.js). Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs).

import { install } from '../features/lidarreg.js';

(globalThis.__lib ??= {})['js-lidarreg'] = { install };
