// Lazy CSM block (REQ-GAP-24): Model ▸ Attach CSM ISD… and the usgscsm module's loader and host
// bridge (sensor/csm.js). features/csm.js loads it on first use; the WASM is block wasm-usgscsm.

import { installCsm } from '../sensor/csm.js';

(globalThis.__lib ??= {})['js-csm'] = { install: installCsm };
