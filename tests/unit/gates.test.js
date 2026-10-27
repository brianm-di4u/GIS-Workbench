// PT-04 REQ-ARC-03 REQ-ARC-04 REQ-RUST-02 REQ-RUST-08 REQ-RUST-09 REQ-RUST-11 REQ-SEC-08: the build gates
// fail on oversize files, dynamic code, disallowed licences, unlisted blocks, WASM imports
// and budgets; and the shipped file passes them.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { sizeGate, evalGate, licenceGate, manifestGate, cspGate, wasmGate, crateLicenceGate, determinismGate, scanWasm, LIMITS } from '../../build/gates.mjs';

const MB = 1024 * 1024;

describe('PT-04 size gate (REQ-ARC-03)', () => {
  it('fails over 12 MB total and 6 MB eager, warns over 9 MB', () => {
    expect(sizeGate({ total: 2 * MB, eager: 1 * MB })).toEqual({ errors: [], warnings: [] });
    expect(sizeGate({ total: 10 * MB, eager: 1 * MB }).warnings).toHaveLength(1);
    expect(sizeGate({ total: LIMITS.totalFail + 1, eager: 1 * MB }).errors[0]).toMatch(/12 MB/);
    expect(sizeGate({ total: 5 * MB, eager: LIMITS.eagerFail + 1 }).errors[0]).toMatch(/6 MB/);
  });
});

describe('PT-04 dynamic-code gate (REQ-ARC-04, REQ-RUST-02)', () => {
  const bad = [
    ['eval', 'x = eval("1+1")'],
    ['new Function', 'const f = new Function("a", "return a")'],
    ['Function string', 'Function("return this")()'],
    ['string timer', 'setTimeout("alert(1)", 10)'],
    ['template timer', 'setInterval(`tick()`, 10)'],
  ];
  for (const [label, text] of bad) it(`fails on ${label}`, () => expect(evalGate([{ name: 'app', text }])).toHaveLength(1));
  it('passes ordinary code and words that merely contain "eval"', () => {
    expect(evalGate([{ name: 'app', text: 'retrieval(); const evaluate = 1; setTimeout(() => f(), 0); obj.eval2 = 3;' }])).toEqual([]);
  });
  it('honours an audited allow-list entry up to its count only', () => {
    const allow = [{ name: 'lib', what: 'eval(', count: 1, reason: 'unreachable' }];
    expect(evalGate([{ name: 'lib', text: 'eval(a)' }], allow)).toEqual([]);
    expect(evalGate([{ name: 'lib', text: 'eval(a); eval(b)' }], allow)).toHaveLength(1);
  });
});

describe('PT-04 licence gates (REQ-SEC-08, REQ-RUST-09)', () => {
  it('rejects copyleft and unknown npm licences', () => {
    expect(licenceGate([{ name: 'ok', version: '1', license: 'MIT' }, { name: 'ok2', version: '1', license: 'Apache-2.0' }])).toEqual([]);
    expect(licenceGate([{ name: 'g', version: '1', license: 'GPL-3.0' }])).toHaveLength(1);
    expect(licenceGate([{ name: 'l', version: '1', license: 'LGPL-2.1' }])).toHaveLength(1);
    expect(licenceGate([{ name: 'u', version: '1' }])).toHaveLength(1);
    expect(licenceGate([{ name: 'dual', version: '1', license: '(MIT OR GPL-3.0)' }])).toEqual([]);
  });
  it('accepts only permissive crate licences', () => {
    const ok = ['MIT', 'MIT OR Apache-2.0', 'Apache-2.0 OR MIT', 'MIT/Apache-2.0', 'Zlib', 'BSD-3-Clause', 'ISC', '(MIT OR Apache-2.0) AND Unicode-3.0', 'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'];
    expect(crateLicenceGate(ok.map((license, i) => ({ name: `c${i}`, version: '1', license })))).toEqual([]);
    for (const license of ['GPL-3.0', 'MPL-2.0', 'LGPL-2.1 OR GPL-2.0', 'unknown', '', 'MIT AND GPL-3.0']) expect(crateLicenceGate([{ name: 'x', version: '1', license }]), license).toHaveLength(1);
  });
});

describe('PT-04 manifest and CSP gates (REQ-ARC-02, REQ-SEC-01)', () => {
  const manifest = { blocks: { a: { sha256: 'aa' }, b: { sha256: 'bb' } } };
  it('fails on an unlisted block, a changed hash and a missing block', () => {
    expect(manifestGate(manifest, [{ name: 'a', sha256: 'aa' }, { name: 'b', sha256: 'bb' }])).toEqual([]);
    expect(manifestGate(manifest, [{ name: 'a', sha256: 'aa' }, { name: 'b', sha256: 'bb' }, { name: 'c', sha256: 'cc' }])[0]).toMatch(/not in the build manifest/);
    expect(manifestGate(manifest, [{ name: 'a', sha256: 'aa' }, { name: 'b', sha256: 'XX' }])[0]).toMatch(/hash differs/);
    expect(manifestGate(manifest, [{ name: 'a', sha256: 'aa' }])[0]).toMatch(/has no block/);
  });
  it('keeps the CSP strict', () => {
    const good = "default-src 'none'; script-src 'sha256-x' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src blob:;";
    expect(cspGate(good)).toEqual([]);
    expect(cspGate(good.replace("'wasm-unsafe-eval'", "'unsafe-eval' 'wasm-unsafe-eval'"))).toHaveLength(1);
    expect(cspGate(good.replace("'sha256-x'", "'unsafe-inline'"))).toHaveLength(1);
    expect(cspGate(good.replace('connect-src blob:', 'connect-src blob: *'))).toHaveLength(1);
    expect(cspGate(good.replace('connect-src blob:', 'connect-src blob: https:'))).toHaveLength(1);
    expect(cspGate(good.replace("default-src 'none'", "default-src 'self'"))).toHaveLength(1);
  });
});

describe('PT-04 WASM gate (REQ-RUST-01, REQ-RUST-08)', () => {
  const b = (o) => ({ name: 'core', imports: [], gzip: 100 * 1024, budget: 250 * 1024, ...o });
  it('fails on host imports and over-budget bundles', () => {
    expect(wasmGate([b()])).toEqual([]);
    expect(wasmGate([b({ imports: ['wasi_snapshot_preview1.fd_write'] })])[0]).toMatch(/imports/);
    expect(wasmGate([b({ gzip: 280 * 1024 })])[0]).toMatch(/budget/);
    expect(wasmGate([b({ gzip: 700 * 1024, budget: 800 * 1024 }), b({ name: 'p', gzip: 600 * 1024, budget: 800 * 1024 })])[0]).toMatch(/all Rust WASM/);
  });
});

describe('REQ-RUST-11 determinism gate', () => {
  // One function () -> v128 whose body is `body` then `end`.
  const leb = (n) => {
    const out = [];
    do {
      let c = n & 0x7f;
      n >>>= 7;
      if (n) c |= 0x80;
      out.push(c);
    } while (n);
    return out;
  };
  const mod = (body) => {
    const fn = [0, ...body, 0x0b];
    const code = [1, ...leb(fn.length), ...fn];
    return Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7b, 3, 2, 1, 0, 10, ...leb(code.length), ...code]);
  };
  const c0 = [0xfd, 12, ...Array(16).fill(0)]; // v128.const 0
  it('passes SIMD128 arithmetic and decodes it', () => {
    const m = mod([...c0, ...c0, 0xfd, ...leb(0xe4)]); // f32x4.add
    expect(WebAssembly.validate(m)).toBe(true);
    expect(scanWasm(m)).toMatchObject({ functions: 1, relaxed: 0, simd: 3 });
    expect(determinismGate([{ name: 'ok', bytes: m }])).toEqual([]);
  });
  it('fails relaxed SIMD (f32x4.relaxed_madd) and undecodable bodies', () => {
    const m = mod([...c0, ...c0, ...c0, 0xfd, ...leb(0x105)]);
    expect(determinismGate([{ name: 'bad', bytes: m }])[0]).toMatch(/relaxed-SIMD/);
    expect(determinismGate([{ name: 'odd', bytes: mod([0x06]) }])[0]).toMatch(/unknown opcode/);
  });
});

describe('PT-04 the shipped file passes its own gates', () => {
  const DIST = 'dist/gis-workbench.html';
  it.skipIf(!existsSync(DIST))('manifest, block hashes, CSP and size', () => {
    const html = readFileSync(DIST, 'utf8');
    const manifest = JSON.parse(/<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(html)[1]);
    const blocks = [...html.matchAll(/<script type="application\/octet-stream" id="blk-([\w-]+)"[^>]*>([\s\S]*?)<\/script>/g)].map(([, name, b64]) => {
      let u8 = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
      if (manifest.blocks[name]?.gz) u8 = gunzipSync(u8);
      return { name, sha256: createHash('sha256').update(u8).digest('hex') };
    });
    expect(blocks.length).toBeGreaterThan(3);
    // REQ-RUST-11: every Rust bundle decodes and uses no relaxed SIMD or atomics.
    const wasm = [...html.matchAll(/<script type="application\/octet-stream" id="blk-([\w-]+)"[^>]*>([\s\S]*?)<\/script>/g)]
      .filter(([, name]) => manifest.blocks[name]?.kind === 'wasm' && /^wasm-(core|parse|j2k|photo|raster|terrain|pointcloud|vector|sar|spectral)$/.test(name))
      .map(([, name, b64]) => {
        let u8 = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
        if (manifest.blocks[name]?.gz) u8 = gunzipSync(u8);
        return { name, bytes: new Uint8Array(u8) };
      });
    expect(wasm.length).toBeGreaterThanOrEqual(8);
    expect(determinismGate(wasm)).toEqual([]);
    expect(manifestGate(manifest, blocks)).toEqual([]);
    const csp = /<meta http-equiv="Content-Security-Policy" id="csp" content="([^"]+)"/.exec(html)[1];
    expect(cspGate(csp)).toEqual([]);
    expect(sizeGate({ total: Buffer.byteLength(html), eager: 0 }).errors).toEqual([]);
  });
});
