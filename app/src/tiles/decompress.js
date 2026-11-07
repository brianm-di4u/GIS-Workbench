// PMTiles compressions (FC-06, REQ-FMT-30): none, gzip (the browser's DecompressionStream),
// Brotli (the lazy `brotli` WASM bundle, crates/gw-tiles/src/brotli.rs) and Zstandard (the
// shared zstddec, app/src/codecs/zstd.js). The pmtiles library takes this as its `decompress`
// hook for directories, metadata and tiles. The Brotli and Zstandard decoders are passed in, so
// the main thread can hand them to a decode worker and keep zstddec out of the eager code.

import { gwError } from '../i18n/index.js';

export const COMPRESSION = { 0: 'unknown', 1: 'none', 2: 'gzip', 3: 'Brotli', 4: 'Zstandard' };
export const LIMIT = 256 * 2 ** 20;

async function gunzip(u8) {
  const out = await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (out.byteLength > LIMIT) throw new Error('gzip data expands past 256 MiB');
  return out;
}

const own = (u8) => (u8.buffer.byteLength === u8.byteLength && u8.byteOffset === 0 ? u8.buffer : u8.slice().buffer);

/** Brotli through a `brotli` bundle (app/src/wasm/abi.js Bundle API). */
export function brotliWith(getBundle) {
  return async (u8) => {
    const b = await getBundle();
    const [p, n] = b.put(u8);
    try {
      if (b.x.gw_brotli_decompress(p, n, LIMIT) !== 0) throw new Error(b.lastError());
      return b.outBytes();
    } finally {
      b.free(p, n);
    }
  };
}

/**
 * A `decompress(buf, compression)` for the pmtiles library. `brotli(u8)` and `zstd(u8)` resolve
 * to the decompressed bytes.
 */
export function makeDecompress({ brotli, zstd }) {
  return async function decompress(buf, compression) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    switch (compression) {
      case 1:
        return own(u8);
      case 0:
        // "Unknown": GDAL and other writers use it for gzip; look at the bytes.
        if (u8[0] === 0x1f && u8[1] === 0x8b) return gunzip(u8);
        if (u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) return own(await zstd(u8));
        return own(u8);
      case 2:
        try {
          return await gunzip(u8);
        } catch (e) {
          throw gwError('a gzip-compressed PMTiles block is damaged ({detail})', { detail: e.message }, 'E_PMTILES_BLOCK');
        }
      case 3:
        try {
          return own(await brotli(u8));
        } catch (e) {
          throw gwError('a Brotli-compressed PMTiles block is damaged ({detail})', { detail: e.message }, 'E_PMTILES_BLOCK');
        }
      case 4:
        try {
          return own(await zstd(u8));
        } catch (e) {
          throw gwError('a Zstandard-compressed PMTiles block cannot be read ({detail})', { detail: e.message }, 'E_PMTILES_BLOCK');
        }
      default:
        throw gwError('PMTiles compression {compression} is not defined by the specification', { compression: String(compression) }, 'E_PMTILES_COMPRESSION');
    }
  };
}
