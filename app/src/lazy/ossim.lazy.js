// Lazy 2.6 block (group csmhost): OSSIM rigorous models fitted back to an RPC (features/ossim.js,
// REQ-GAP-21). Loaded the first time Sensor Model ▸ Load OSSIM Rigorous Model… runs. Full only:
// Lite has no sidecar.

import { install } from '../features/ossim.js';

(globalThis.__lib ??= {})['js-ossim'] = { install };
