// Lazy app blocks (2.4): feature code used only when its command runs lives in main-thread blocks
// built from app/src/lazy/*.lazy.js (js-services, js-ai24, js-apiv2 …), run on first use from a
// verified inline block (boot runScript). A block's imports of the app's stateful modules
// (build/host-modules.mjs HOST_MODULES) are bound by the build to the running app's own copies,
// handed over here in globalThis.__gwHost, so a block carries no second copy of them.

import * as I18N from '../i18n/index.js';
import * as FORMAT from '../i18n/format.js';
import * as DIALOGS from '../shell/dialogs.js';
import * as DOM from '../shell/dom.js';
import * as OPEN from '../formats/open.js';
import * as CRS from '../geo/crs.js';
import * as GEOM from '../vector/geom.js';
import * as NITFW from '../formats/nitf-writer.js';
import * as VECTOR_IO from '../vector/io.js';
import * as GEOTIFF_WRITER from '../formats/geotiff-writer.js';
import { msgOf } from '../i18n/index.js';

/** The app modules a lazy app block uses as the app's own (keys: paths under app/src; build/host-modules.mjs HOST_MODULES). */
export const HOST = {
  'i18n/index.js': I18N,
  'i18n/format.js': FORMAT,
  'shell/dialogs.js': DIALOGS,
  'shell/dom.js': DOM,
  'formats/open.js': OPEN,
  'geo/crs.js': CRS,
  'vector/geom.js': GEOM,
  'formats/nitf-writer.js': NITFW,
  'vector/io.js': VECTOR_IO,
  'formats/geotiff-writer.js': GEOTIFF_WRITER,
};

const runs = new Map();

/** Run lazy app block `name` once → the library it registers (globalThis.__lib[name]). */
export function loadBlock(app, name) {
  let p = runs.get(name);
  if (!p) {
    p = (async () => {
      globalThis.__gwHost = Object.assign(globalThis.__gwHost ?? {}, HOST);
      const gw = app?.gw ?? globalThis.__gw;
      if (!gw?.runScript) throw new Error(`script block "${name}" is not available`);
      const lib = await gw.runScript(name);
      if (!lib) throw new Error(`script block "${name}" did not register`);
      return lib;
    })();
    runs.set(name, p);
    p.catch(() => runs.delete(name));
  }
  return p;
}

/** `load` once at a time: a promise kept while it succeeds, dropped when it fails (the next call retries). */
export function once(load) {
  let p = null;
  return () =>
    (p ??= Promise.resolve()
      .then(load)
      .catch((e) => {
        p = null;
        throw e;
      }));
}

/**
 * Commands whose implementation is in a lazy block. Each id gets the `enabled` / `checked`
 * predicates of `eager[id]` now (the menus ask them before the block loads; they must be the
 * block's own), and a run that loads the block, whose install implements the command for real
 * (commands.implement replaces this run), then runs that. A block that fails to load is shown as
 * an error toast, as features/services.js does; the command's own errors reach commands.run as
 * before.
 */
export function lazyCommands(app, ids, load, eager = {}) {
  const C = app.commands;
  for (const id of ids) {
    const stub = async (arg) => {
      try {
        await load();
      } catch (e) {
        app.toast(msgOf(e), { kind: 'error', ms: 9000 });
        return undefined;
      }
      const run = C.get(id)?.run;
      if (!run || run === stub) throw new Error(`${id}: its block did not implement it`);
      return run(arg);
    };
    C.implement(id, { ...(eager[id] ?? {}), run: stub });
  }
}

/**
 * Functions of `obj` whose implementation is in a lazy block: obj[name](…) loads the block, whose
 * install puts the real function at current()[name] (`current` gives the object then: the same
 * one, or the one the install put in its place), then calls that. So the result is a promise until
 * the block has loaded, and whatever the real function returns afterwards.
 */
export function lazyMethods(obj, names, load, current = () => obj) {
  for (const n of names) {
    const stub = async (...a) => {
      await load();
      const fn = current()?.[n];
      if (typeof fn !== 'function' || fn === stub) throw new Error(`${n}: its block did not provide it`);
      return fn(...a);
    };
    obj[n] = stub;
  }
}
