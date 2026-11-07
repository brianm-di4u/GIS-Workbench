// Automation API v2 (REQ-GAP-01): `gisworkbench.api.v2`. The methods of automation/v2-spec.js
// bound to the app, each callable with parameters and no dialog:
//
//   const v2 = gisworkbench.api.v2;
//   await v2.call('ai.find', { objects: ['aircraft'], scope: 'scene' });
//   await v2.ai.find({ objects: ['aircraft'] });          // the same, as a namespaced function
//   const off = v2.on('job', (e) => console.log(e.label, e.state, e.progress));
//
// Every call is checked against the method's schema first. Changes are store transactions (one
// undo step each, as if the analyst had done them). Files are returned in the result
// ({name, type, size, text | blob}) unless `save: true`; while a call runs, the saves of the tools
// it drives are captured instead of opening a dialog (storage/files.js saveCapture). Events
// (layer, selection, view, job) are delivered to on() listeners and kept in a 500-entry ring for
// events.recent (MCP clients poll it).
//
// Errors and results are developer API text (DN-62 rule 7): English.

import { apiError, makeV2Api, wireEvents } from './api-v2-core.js';
import { makeV2Impl } from './api-v2-impl.js';

export { apiError, wireEvents, makeV2Impl };

/**
 * Build the v2 API for an app with its implementations bound now (tests, tools). Returns {call, on,
 * off, …namespaces}. `impl` may be given to replace implementations.
 */
export function makeV2(app, { impl: override = {} } = {}) {
  const api = makeV2Api(app, () => impl);
  const impl = makeV2Impl(app, api, override);
  api._bind(impl);
  return api;
}
