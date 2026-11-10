// Lazy 2.7.1 workflow builder block (REQ-GAP-84): the node editor over gw-recipe/2 and
// app.workflows. Loaded the first time the Workflow Builder opens (features/workflow.js). Its
// imports of the app's stateful modules are the app's own (build/host-modules.mjs).

import { install } from '../features/workflow-editor.js';

(globalThis.__lib ??= {})['js-workflow'] = { install };
