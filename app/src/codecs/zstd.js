// Shared Zstandard decoder (SDP-2.1 §3.1): zstddec (MIT AND BSD-3-Clause) for GeoTIFF blocks
// (compression 50000, LERC+ZSTD) and PMTiles directories and tiles (FC-06, REQ-FMT-30). Works on
// the main thread and in workers.

import { ZSTDDecoder } from 'zstddec';
import { gwError } from '../i18n/index.js';

// TE-002: zstddec loads its WebAssembly with fetch('data:application/wasm;base64,…'), which the
// strict CSP (connect-src blob:) refuses. Serve exactly that request from the inlined bytes
// instead; it is still instantiated under 'wasm-unsafe-eval' and nothing else about fetch changes.
const WASM_DATA = 'data:application/wasm;base64,';
const g = typeof self !== 'undefined' ? self : globalThis;
if (g.fetch && !g.fetch.__gwInlineWasm) {
  const fetch0 = g.fetch.bind(g);
  const inline = (u, ...rest) => {
    if (typeof u === 'string' && u.startsWith(WASM_DATA)) {
      const bin = atob(u.slice(WASM_DATA.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }));
    }
    return fetch0(u, ...rest);
  };
  inline.__gwInlineWasm = true;
  g.fetch = inline;
}

export const zstd = new ZSTDDecoder();
let ready = null;
/** Resolves once the decoder's WebAssembly is instantiated. */
export const zstdReady = () => (ready ??= zstd.init().catch((e) => ((ready = null), Promise.reject(e))));

/** Largest output a single Zstandard frame may claim (a tile or a directory). */
export const ZSTD_MAX = 256 * 2 ** 20;

/**
 * The content size a Zstandard stream declares in its frame headers (RFC 8878 §3.1.1.1), summed
 * over concatenated frames; null when a frame does not declare it, NaN when it is not Zstandard.
 */
export function zstdContentSize(u8) {
  let o = 0;
  let total = 0;
  while (o + 5 <= u8.length) {
    const magic = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      // Skippable frame: 4-byte size follows.
      if (o + 8 > u8.length) return NaN;
      const n = (u8[o + 4] | (u8[o + 5] << 8) | (u8[o + 6] << 16) | (u8[o + 7] << 24)) >>> 0;
      o += 8 + n;
      continue;
    }
    if (magic >>> 0 !== 0xfd2fb528) return NaN;
    const fhd = u8[o + 4];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const dictFlag = fhd & 3;
    const fcsBytes = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    if (!fcsBytes) return null;
    let p = o + 5 + (single ? 0 : 1) + [0, 1, 2, 4][dictFlag];
    if (p + fcsBytes > u8.length) return NaN;
    let fcs = 0;
    for (let i = fcsBytes - 1; i >= 0; i--) fcs = fcs * 256 + u8[p + i];
    if (fcsBytes === 2) fcs += 256;
    total += fcs;
    // Walk the blocks to the next frame (a 3-byte header each: last flag, type, size).
    p += fcsBytes;
    for (;;) {
      if (p + 3 > u8.length) return NaN;
      const bh = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
      const last = bh & 1;
      const type = (bh >> 1) & 3;
      const size = bh >>> 3;
      p += 3 + (type === 1 ? 1 : size);
      if (type === 3) return NaN;
      if (last) break;
    }
    if ((fhd >> 2) & 1) p += 4; // content checksum
    o = p;
  }
  return total;
}

/** Decode a whole Zstandard stream with the size it declares; refuses one that declares none. */
export async function zstdDecode(input, max = ZSTD_MAX) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const n = zstdContentSize(u8);
  if (Number.isNaN(n)) throw new Error('the Zstandard data is damaged (bad frame header)');
  if (n === null) throw new Error('the Zstandard frame does not declare its content size, which this reader needs');
  if (n > max) throw gwError('the Zstandard data claims {n, plural, one {# byte} other {# bytes}}, above the {limit} MiB limit', { n, limit: String(max >> 20) }, 'E_ZSTD_LIMIT');
  if (n === 0) return new Uint8Array(0);
  await zstdReady();
  const out = zstd.decode(u8, n);
  if (out.byteLength !== n) throw new Error('the Zstandard data is damaged (short output)');
  return out;
}
