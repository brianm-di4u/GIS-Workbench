// Online services and publishing (REQ-GAP-05, 06, 07, 59): the commands, and the loader of the lazy
// js-services block (svc/services.js, svc/publish.js) that does the work. The block's imports of
// the app's stateful modules are the app's own (build.mjs hostModules), handed over by
// features/lazy-host.js.

import { msgOf } from '../i18n/index.js';
import { HOST, loadBlock } from './lazy-host.js';

export const name = 'services';

/** The app modules a lazy app block uses as the app's own (features/lazy-host.js; build/host-modules.mjs HOST_MODULES). */
export { HOST };

export function install(app) {
  const C = app.commands;
  let loading = null;
  /** Load the services block once → {services, publish} (app.services, app.publish). */
  app.loadServices = () =>
    (loading ??= (async () => {
      const lib = await loadBlock(app, 'js-services');
      lib.install(app);
      return { services: app.services, publish: app.publish };
    })().catch((e) => {
      loading = null;
      throw e;
    }));
  const run = (fn) => async (arg) => {
    try {
      await app.loadServices();
      await fn(arg);
    } catch (e) {
      app.toast(msgOf(e), { kind: e?.code === 'E_STEP_FIRST' ? 'warn' : 'error', ms: 9000 });
    }
  };
  C.implement('svc.connect', { run: run((u) => app.services.dialog(u)) });
  C.implement('svc.publish', { run: run(() => app.publish.dialog('detections')) });
  C.implement('det.publish', { run: run(() => app.publish.dialog('detections')) });
  C.implement('obs.publish', { run: run(() => app.publish.dialog('observations')) });
}
