// Lazy 2.5 aerial triangulation block (REQ-GAP-22; group aero): the bundle-adjustment dialog
// and report, space resection and film interior orientation. Loaded the first time one of the
// tri.aero / tri.resect / tri.fiducials commands or an app.aero function runs (features/aero.js).
// Its imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { install, baseRecordOf } from '../features/aero-ui.js';

(globalThis.__lib ??= {})['js-aero'] = { install, baseRecordOf };
