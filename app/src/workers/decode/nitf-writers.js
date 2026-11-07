// The 2.1 nitf-group writer runs in the decode worker through the lazily loaded Rust `legacy` bundle:
// ARIDPCM blocks for a NITF IC=M2 image (REQ-FMT-45). The caller (features/products.js) assembles
// the NITF file.

import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

/** ARIDPCM-code an image as blocks of `block` × `block` (≤ 248: GDAL decodes ≤ 1000 neighbourhoods
 * per block) → {blocks: [Uint8Array] row-major, nbpr, nbpc, block}. `px`: Uint8Array (8-bit) or
 * Uint16Array (11-bit). */
export function aridpcmEncode(legacy, { px, width, height, nbpp, comrat, block = 248 }) {
  const bs = Math.max(8, Math.min(248, block - (block % 8)));
  const nbpr = Math.ceil(width / bs);
  const nbpc = Math.ceil(height / bs);
  const wide = nbpp > 8;
  const cr = new TextEncoder().encode(comrat);
  const blocks = [];
  for (let by = 0; by < nbpc; by++)
    for (let bx = 0; bx < nbpr; bx++) {
      // A partial block at the right/bottom edge is padded by repeating its last column/row.
      const tile = wide ? new Uint16Array(bs * bs) : new Uint8Array(bs * bs);
      for (let y = 0; y < bs; y++) {
        const sy = Math.min(height - 1, by * bs + y);
        for (let x = 0; x < bs; x++) tile[y * bs + x] = px[sy * width + Math.min(width - 1, bx * bs + x)];
      }
      const bytes = wide ? new Uint8Array(tile.buffer) : tile;
      const [p, n] = legacy.put(bytes);
      const [cp, cn] = legacy.put(cr);
      try {
        if (legacy.x.gw_aridpcm_encode(p, n, bs, bs, nbpp, cp, cn) !== 0) throw gwError('ARIDPCM encode: {msg}', { msg: nested(wasmError(legacy)) });
        blocks.push(legacy.outBytes());
      } finally {
        legacy.free(p, n);
        legacy.free(cp, cn);
      }
    }
  return { blocks, nbpr, nbpc, block: bs };
}
