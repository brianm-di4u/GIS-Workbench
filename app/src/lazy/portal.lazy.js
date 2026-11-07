// Lazy ArcGIS portal block (REQ-GAP-64; 2.5 group streams): portal sign-in, search and items,
// web maps, attachments, related records, branch versions and .lyrx styles
// (features/portal-ui.js over connectors/portal.js and formats/lyrx.js).

import { installPortal } from '../features/portal-ui.js';

(globalThis.__lib ??= {})['js-portal'] = { installPortal };
