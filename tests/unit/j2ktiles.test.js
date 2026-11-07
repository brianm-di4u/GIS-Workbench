// Tile-by-tile JPEG 2000 (app/src/workers/decode/j2ktiles.js) on a full WorldView-3 PAN NITF strip
// (TE archive, 43008 × 31744, 1.37 G samples, 1024² tiles, RLCP with one tile-part per resolution):
// the index comes from TLM, overview tiles read only their resolution tile-parts, and a window
// through the reader equals the same pixels decoded from the tile directly. Runs the real j2k WASM
// bundle (built by build/build.mjs); skipped when it or the T&E corpus is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, openSync, readSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { j2kTileIndex, j2kTileReader } from '../../app/src/workers/decode/j2ktiles.js';
import { Bundle } from '../../app/src/wasm/abi.js';

const NTF = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'nitf-mvs-wv3-buenos-aires/PAN/07JAN16WV031000016JAN07142142-P1BS-500537128030_01_P001_________AAE_0AAAAABPABE0.NTF');
const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_j2k.wasm');
  } catch {
    return null;
  }
})();
const have = existsSync(NTF) && wasmPath && existsSync(wasmPath);

class LRU {
  constructor() {
    this.map = new Map();
  }
  get(k) {
    return this.map.get(k);
  }
  set(k, v) {
    this.map.set(k, v);
  }
}

describe.skipIf(!have)('tiled JPEG 2000 reader', () => {
  const fd = have ? openSync(NTF, 'r') : null;
  let reads = 0;
  let bytes = 0;
  const readRange = async (o, l) => {
    const b = Buffer.alloc(l);
    readSync(fd, b, 0, l, o);
    reads++;
    bytes += l;
    return new Uint8Array(b.buffer, b.byteOffset, l);
  };
  // The NITF image segment: the codestream starts after the headers; the index finds the SOC.
  const base = 0;
  const end = have ? statSync(NTF).size : 0;

  it('indexes from TLM and serves an overview from resolution tile-parts only', async () => {
    const soc = (() => {
      const h = Buffer.alloc(1 << 16);
      readSync(fd, h, 0, h.length, 0);
      return h.indexOf(Buffer.from([0xff, 0x4f, 0xff, 0x51]));
    })();
    const ix = await j2kTileIndex(readRange, base + soc, end);
    expect(ix).not.toBeNull();
    expect([ix.tx, ix.ty, ix.ntx, ix.nty, ix.levels]).toEqual([1024, 1024, 42, 31, 5]);
    expect(ix.resolutionParts).toBe(true);
    expect(reads).toBeLessThan(10); // TLM: the header reads and one probe, not 9 000 SOT reads

    const bundle = new Bundle(new WebAssembly.Module(readFileSync(wasmPath)), 'j2k');
    const read = j2kTileReader({ ix, readRange, cache: new LRU(), bundle: async () => bundle, width: 43008, height: 31744, C: Uint16Array, nodata: null });
    bytes = 0;
    const L = 5;
    const ov = await read(L, 0, 0, 256, 256, [0]);
    // 256² level-5 pixels = 8 × 8 tiles; their first tile-parts are a few KB each.
    expect(bytes).toBeLessThan(2 << 20);
    expect(ov[0].some((v) => v > 0)).toBe(true);

    // The same pixels from one tile decoded directly at that level.
    const t = 9 * 42 + 5;
    const parts = ix.parts.get(t).slice(0, ix.levels + 1 - L);
    const chunks = [ix.head, ...(await Promise.all(parts.map(([o, l]) => readRange(o, l)))), Uint8Array.of(0xff, 0xd9)];
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const [p, n] = bundle.put(new Uint8Array(buf));
    expect(bundle.x.gw_j2k_decode_region(p, n, 5 * 1024, 9 * 1024, 1, 1, L)).toBe(0);
    const out = bundle.outBytes();
    bundle.free(p, n);
    const dv = new DataView(out.buffer, out.byteOffset);
    const w = dv.getUint32(8, true);
    const px = new Uint16Array(out.buffer.slice(out.byteOffset + 24));
    const win = await read(L, 5 * 32, 9 * 32, 32, 32, [0]);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) expect(win[0][y * 32 + x]).toBe(px[y * w + x]);
  });
});
