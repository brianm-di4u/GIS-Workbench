// Lazy app block js-sidecarnative: the native stereo viewer's and ArcGIS Pro sync's page side
// (REQ-GAP-33, REQ-GAP-65; sidecar/native-ui.js). The commands are eager (sidecar/feature.js); the
// block loads when the analyst first opens one of them.
import { install } from '../sidecar/native-ui.js';

(globalThis.__lib ??= {})['js-sidecarnative'] = { install };
