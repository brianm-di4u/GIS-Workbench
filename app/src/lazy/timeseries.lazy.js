// Lazy time-series block (REQ-GAP-83; 2.7.1): time stacks, the Time Series panel, playback and
// recording, the temporal profile, trend and anomaly (features/timeseries-tools.js). Loaded by the
// first time-series command or app.timeseries call (features/timeseries.js). Its imports of the
// app's stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/timeseries-tools.js';

(globalThis.__lib ??= {})['js-timeseries'] = { install };
