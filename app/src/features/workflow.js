// 2.7.1 visual workflow builder (REQ-GAP-84, SDP-2.7 §4.11): the Workflow Builder command and
// app.workflows, whose implementation is the lazy js-workflow block (lazy/workflow.lazy.js:
// features/workflow-editor.js). The model and runner are recipes/recipe.js, already in the app.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';

export const name = 'workflow';

export function install(app) {
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-workflow');
    lib.install(app);
    return lib;
  });
  app.workflows = {};
  lazyMethods(app.workflows, ['show', 'open', 'addStep', 'wire', 'unwire', 'removeStep', 'setParam', 'run', 'saveToProject', 'library', 'removeFromLibrary', 'projectWorkflows', 'current', 'setView'], load, () => app.workflows);
  lazyCommands(app, ['pip.builder'], load);
}
