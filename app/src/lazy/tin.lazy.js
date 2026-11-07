// Lazy TIN editing block (REQ-GAP-39; 2.5 group tin): TIN layers, their builds, edits, display,
// import, export, TIN → DEM and the 3D mesh (features/tin-editor.js). Loaded by the first TIN
// command, or when a project brings TINs (features/tin.js). Its imports of the app's stateful
// modules are the app's own (build/host-modules.mjs).

import { install } from '../features/tin-editor.js';

(globalThis.__lib ??= {})['js-tin'] = { install };
