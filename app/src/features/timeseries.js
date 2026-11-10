// Time series of images (REQ-GAP-83; Full). The work — time stacks, the Time Series panel,
// playback, the temporal profile, trend and anomaly — is the lazy js-timeseries block
// (lazy/timeseries.lazy.js → features/timeseries-tools.js). Here: the commands with their enabled
// tests, and app.timeseries methods that load the block on first use.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
import { layerDates } from '../analysis/time-series.js';

export const name = 'timeseries';

export const TS_COMMANDS = ['ts.stack', 'ts.panel', 'ts.trend', 'ts.anomaly'];
export const TS_METHODS = ['dateOfImage', 'stack', 'show', 'play', 'stop', 'profile', 'exportProfile', 'trend', 'anomaly', 'openPanel'];

export function install(app) {
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-timeseries');
    lib.install(app);
    return lib;
  });
  // Which layers are time series needs no block: a date on every band.
  const datesOf = (l) => (l ? layerDates(app.msi?.bandsOf(l) ?? l.info?.bandsMeta, l.info) : null);
  app.timeseries = { datesOf };
  lazyMethods(app.timeseries, TS_METHODS, load);
  const series = () => datesOf(app.activeLayer())?.length >= 2;
  const images = () => [...(app.layers?.values() ?? [])].filter((l) => l.rec?.pane === app.activePane()?.id && l.handle).length;
  lazyCommands(app, TS_COMMANDS, load, {
    'ts.stack': { enabled: () => images() >= 2 },
    'ts.trend': { enabled: series },
    'ts.anomaly': { enabled: series },
  });
}
