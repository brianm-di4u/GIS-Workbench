// Lazy online-services block (REQ-GAP-05, 06, 07, 59; 2.4 group svc): the capabilities browser,
// the OGC API / WCS / WPS / SensorThings / I3S clients, service image layers and publishing.
// Loaded the first time one of those commands runs (features/services.js). Its imports of the
// app's stateful modules (i18n, dialogs, the image opener, CRSs, geometry) are bound by the
// build to the running app's own copies (build.mjs hostModules), so this block carries none.

import { install as installServices } from '../svc/services.js';
import { install as installPublish } from '../svc/publish.js';

(globalThis.__lib ??= {})['js-services'] = {
  install(app) {
    installServices(app);
    installPublish(app);
  },
};
