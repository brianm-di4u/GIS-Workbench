// Lazy 2.6 block (REQ-GAP-70; group codecs): View with Sidecar. Loaded the first time sidecar.view
// runs (sidecar/feature.js). Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs); the remote-file opener comes from the sidecar feature, so that remote
// ids stay unique.

import { viewFile } from '../features/sidecar-view.js';

(globalThis.__lib ??= {})['js-sidecarview'] = { viewFile };
