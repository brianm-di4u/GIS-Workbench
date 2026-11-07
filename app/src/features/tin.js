// TIN editing (REQ-GAP-39, GR-13; Full). The editor — TIN layers, their builds, edits, display,
// import, export and TIN → DEM — is the lazy js-tin block (lazy/tin.lazy.js →
// features/tin-editor.js). Here: the commands with their enabled tests, app.tin methods that load
// the block on first use, and a load when a project brings TINs (they are rebuilt and drawn).

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
import { msgOf } from '../i18n/index.js';

export const name = 'tin';

export const TIN_COMMANDS = ['tin.new', 'tin.editor', 'tin.import', 'tin.export', 'tin.raster', 'tin.view3d'];
export const TIN_METHODS = ['create', 'importFile', 'edit', 'sync', 'list', 'info', 'mesh', 'lines', 'heights', 'raster', 'toDem', 'exportFile', 'show3d', 'remove', 'setDisplay', 'snap', 'open', 'ready', 'toPlane', 'toGeo', 'active', 'setActive'];

export function install(app) {
  const S = app.store;
  const has = () => S.all('tin').length > 0;
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-tin');
    lib.install(app);
    return lib;
  });
  app.tin = {};
  lazyMethods(app.tin, TIN_METHODS, load, () => app.tin);
  const sources = () => app.terrain.dems.length > 0 || (app.pointClouds?.size ?? 0) > 0;
  lazyCommands(app, TIN_COMMANDS, load, {
    'tin.new': { enabled: sources },
    'tin.editor': { enabled: has },
    'tin.export': { enabled: has },
    'tin.raster': { enabled: has },
    'tin.view3d': { enabled: has },
  });
  // A project with TIN layers (opened, or undone back into being): build and draw them.
  S.on('change', () => {
    if (has()) load().catch((e) => app.toast(msgOf(e), { kind: 'error' }));
  });
}
