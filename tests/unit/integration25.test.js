// 2.5 integration fixes: bugs found across the T0b groups that belong to no one group's feature.
import { describe, it, expect } from 'vitest';
import { Bundle } from '../../app/src/wasm/abi.js';
import { parse, evaluate } from '../../app/src/render/bandmath.js';
import { detectChanges } from '../../app/src/analysis/change.js';

describe('empty arrays across the ABI', () => {
  // gw_alloc(0) returns a dangling pointer of 1: a Float32Array view on it throws RangeError.
  const host = { x: { gw_alloc: (n) => (n ? 8 : 1) }, mem: new ArrayBuffer(64) };
  it('putF32 and putF64 accept an empty array', () => {
    expect(Bundle.prototype.putF32.call(host, [])).toEqual([1, 0]);
    expect(Bundle.prototype.putF64.call(host, [])).toEqual([1, 0]);
  });
  it('still writes a non-empty array', () => {
    const [p, n] = Bundle.prototype.putF32.call(host, [1.5, 2.5]);
    expect([p, n]).toEqual([8, 8]);
    expect([...new Float32Array(host.mem, 8, 2)]).toEqual([1.5, 2.5]);
  });
});

describe('a no-data tag a float cannot hold exactly', () => {
  const tag = 1.7014100000000001e38; // GDAL's tag for a Float32 file
  it('differs from its float value (the premise)', () => expect(Math.fround(tag)).not.toBe(tag));
  it('voids Float32 samples in band math', () => {
    const v = evaluate(parse('b1 + 1', { nb: 1 }).ast, [Float32Array.of(1, Math.fround(tag))], { nodata: tag });
    expect(v[0]).toBe(2);
    expect(Number.isNaN(v[1])).toBe(true);
  });
  it('leaves no-data out of the change fit', () => {
    const n = 64;
    const a = new Float32Array(n * n).map((_, i) => (i * 7) % 251);
    const b = a.map((x) => 2 * x + 3);
    for (let i = 0; i < 40; i++) a[i * 31] = Math.fround(tag);
    const r = detectChanges(a, b, n, n, { nodata: tag });
    expect(r.gain).toBeCloseTo(2, 6);
    expect(r.offset).toBeCloseTo(3, 4);
  });
});
