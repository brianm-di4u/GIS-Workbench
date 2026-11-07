// Lazy app block js-relay: the Python relay's page side (REQ-GAP-02, sidecar/relay-ui.js). The
// command is eager (sidecar/feature.js); the block loads when the analyst first opens it.
import { install } from '../sidecar/relay-ui.js';

(globalThis.__lib ??= {})['js-relay'] = { install };
