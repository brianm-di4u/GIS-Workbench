// Lazy FlatGeobuf block (REQ-CNV-02): flatgeobuf 4.6.1 (BSD-3-Clause; flatbuffers, Apache-2.0; its seekable Zstandard codec left out, build/vendor-fixes.mjs) for
// Convert ▸ FlatGeobuf and for opening .fgb files. The JavaScript writer streams features without the
// packed Hilbert R-tree index (DN-59): readers open the file, but cannot filter it by area over HTTP.

import { serialize, deserialize } from 'flatgeobuf/lib/mjs/geojson.js';

/**
 * Every feature of a FlatGeobuf file, and its header: the only place that calls the library's
 * reader (#158), used by the app's reader worker and by vector/columnar.js. As a stream: the
 * byte-array path reads features in place, and a GDAL-written file whose features are not 8-byte
 * aligned throws ("start offset of Float64Array should be a multiple of 8"); the stream path copies
 * each feature into its own buffer.
 */
export async function readAll(bytes) {
  let header = null;
  const got = [];
  for await (const f of deserialize(new Blob([bytes]).stream(), { headerMetaFn: (h) => (header = h) })) got.push(f);
  return { header, got };
}

(globalThis.__lib ??= {})['js-fgb'] = { serialize, readAll };
