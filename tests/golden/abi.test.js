// REQ-RUST-03 (thin ABI: pointer+length buffers, explicit alloc/free, typed error codes with
// a message, no JS imports) and REQ-RUST-05 (memory caps: 256 MiB core, 1 GiB worker bundles;
// parsers enforce size limits) on the shipped bundles.
import { describe, it, expect } from 'vitest';
import { built, blockBytes, loadBundle } from './wasm.js';

const CAPS = { core: 256, parse: 1024, j2k: 1024 }; // MiB
const PAGE = 65536;

describe.skipIf(!built)('WASM ABI and limits', () => {
  for (const [name, mib] of Object.entries(CAPS)) {
    it(`${name}: no imports, the common ABI exports, and memory capped at ${mib} MiB`, () => {
      const mod = new WebAssembly.Module(blockBytes(`wasm-${name}`));
      expect(WebAssembly.Module.imports(mod)).toEqual([]);
      const ex = WebAssembly.Module.exports(mod).map((e) => e.name);
      for (const f of ['memory', 'gw_abi_version', 'gw_alloc', 'gw_free', 'gw_last_error', 'gw_out_ptr', 'gw_out_len']) expect(ex).toContain(f);
      const b = loadBundle(name);
      expect(b.x.gw_abi_version()).toBe(1);
      const mem = b.x.memory;
      const pages = mem.buffer.byteLength / PAGE;
      const max = (mib << 20) / PAGE;
      expect(() => mem.grow(max - pages + 1)).toThrow(RangeError);
      expect(mem.grow(1)).toBe(pages); // growth below the cap still works
    });
  }

  it('errors come back as typed codes with a message; buffers are explicit alloc/free', () => {
    const p = loadBundle('parse');
    const bad = new TextEncoder().encode('NITF02.10 this is not a real header');
    const [ptr, n] = p.put(bad);
    const st = p.x.gw_nitf_file_header(ptr, n, bad.length);
    p.free(ptr, n);
    expect([1, 2]).toContain(st); // INVALID or RANGE
    expect(p.lastError()).toMatch(/\S/);
    // Allocations of zero bytes and large-but-allowed sizes behave; the cap refuses the rest.
    const big = p.x.gw_alloc(64 << 20);
    expect(big).toBeGreaterThan(0);
    p.x.gw_free(big, 64 << 20);
    expect(p.x.gw_alloc(2000 << 20)).toBe(0);
  });

  it('parsers enforce their size limits (JPEG frame claiming 65535² × 4 → LIMIT)', () => {
    const p = loadBundle('parse');
    // SOI, SOF1 (12-bit, 65535 × 65535, 4 components), EOI.
    const sof = [0xff, 0xc1, 0, 20, 12, 0xff, 0xff, 0xff, 0xff, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0];
    const j = new Uint8Array([0xff, 0xd8, ...sof, 0xff, 0xd9]);
    const [ptr, n] = p.put(j);
    const st = p.x.gw_jpeg_decode(ptr, n, 0, 0);
    p.free(ptr, n);
    expect(st).toBe(3);
    expect(p.lastError()).toMatch(/too large/);
  });
});
