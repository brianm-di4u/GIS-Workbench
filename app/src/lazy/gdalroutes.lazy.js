// Lazy 2.6 block (group gdalroutes): the dialogs of the sidecar's GDAL, PROJ and 3D model routes
// (features/gdalroutes.js) and the FileGDB catalogue mapper. Loaded the first time one of those
// commands runs (features/gdalroutes-lazy.js). Full only: Lite has no sidecar.

import { install } from '../features/gdalroutes.js';

(globalThis.__lib ??= {})['js-gdalroutes'] = { install };
