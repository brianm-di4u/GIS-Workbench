// Lazy FlatGeobuf block (REQ-CNV-02): flatgeobuf 4.6.1 (BSD-3-Clause; flatbuffers, Apache-2.0; its seekable Zstandard codec left out, build/vendor-fixes.mjs) for
// Convert ▸ FlatGeobuf and for opening .fgb files. The JavaScript writer streams features without the
// packed Hilbert R-tree index (DN-59): readers open the file, but cannot filter it by area over HTTP.

import { serialize, deserialize } from 'flatgeobuf/lib/mjs/geojson.js';

(globalThis.__lib ??= {})['js-fgb'] = { serialize, deserialize };
