// Lazy automation API v2 implementations (REQ-GAP-01; 2.4 group extai). `gisworkbench.api.v2`,
// its argument checks, events and the gw2_* MCP tool list are there from boot
// (automation/api-v2-core.js, features/automation.js); the method implementations bind on the
// first call from this block. Its imports of the app's stateful modules are the app's own
// (build/host-modules.mjs).

import { makeV2Impl } from '../automation/api-v2-impl.js';

(globalThis.__lib ??= {})['js-apiv2'] = { makeV2Impl };
