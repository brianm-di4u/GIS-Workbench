// Lazy app block js-corsrelay: the CORS relay's page side (REQ-GAP-08, sidecar/cors-relay.js). Left out
// of the air-gapped file (build/build.mjs airgapHtml); off in every shipped build (OD-2.17).
import { install } from '../sidecar/cors-relay.js';

(globalThis.__lib ??= {})['js-corsrelay'] = { install };
