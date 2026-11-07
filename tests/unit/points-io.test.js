// BPF v3 reader (app/src/formats/points-io.js) against PDAL's own test set (TE archive item
// lidar-bpf-pdal-v3): every compression (FastLZ, zlib) and interleave of the chipped Autzen file
// must decode to the same points as the uncompressed one. Skipped when the T&E corpus is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseBpf, fastlzDecompress } from '../../app/src/formats/points-io.js';

const DIR = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'lidar-bpf-pdal-v3');
const file = (n) => new File([readFileSync(join(DIR, n))], n);
const have = existsSync(join(DIR, 'autzen-utm-chipped-25-v3.bpf'));

describe('BPF v3', () => {
  it('FastLZ level 1 literal and match runs', () => {
    // "abcabcabc": a 3-byte literal run, then a match of 6 at distance 3.
    const src = Uint8Array.of(2, 97, 98, 99, (4 << 5) | 0, 2);
    expect(new TextDecoder().decode(fastlzDecompress(src, 9))).toBe('abcabcabc');
  });

  it.skipIf(!have)('zlib blocks labelled code 1 are read; real QuickLZ is refused by name', async () => {
    const ref = await parseBpf(file('autzen-utm-chipped-25-v3.bpf'));
    const z = new Uint8Array(readFileSync(join(DIR, 'autzen-utm-chipped-25-v3-deflate.bpf')));
    z[14] = 1;
    const b = await parseBpf(new File([z], 'relabelled.bpf'));
    expect(b.info.compression).toBe('zlib');
    expect([...b.x]).toEqual([...ref.x]);
    const f = new Uint8Array(readFileSync(join(DIR, 'autzen-utm-chipped-25-v3-fastlz.bpf')));
    f[14] = 1;
    await expect(parseBpf(new File([f], 'quicklz.bpf'))).rejects.toThrow(/QuickLZ/);
  });

  it.skipIf(!have)('compressed and interleaved variants equal the uncompressed file', async () => {
    const ref = await parseBpf(file('autzen-utm-chipped-25-v3.bpf'));
    expect(ref.n).toBe(1065);
    for (const n of ['deflate', 'fastlz'].flatMap((c) => ['', '-interleaved', '-segregated'].map((i) => `autzen-utm-chipped-25-v3-${c}${i}.bpf`)).concat(['autzen-utm-chipped-25-v3-interleaved.bpf', 'autzen-utm-chipped-25-v3-segregated.bpf'])) {
      const b = await parseBpf(file(n));
      expect(b.n, n).toBe(ref.n);
      expect(b.info.compression, n).toBe(/deflate/.test(n) ? 'zlib' : /fastlz/.test(n) ? 'FastLZ' : 'none');
      for (const k of ['x', 'y', 'z']) expect([...b[k]], `${n} ${k}`).toEqual([...ref[k]]);
      for (const l of ref.info.labels) expect([...b.dims[l]], `${n} ${l}`).toEqual([...ref.dims[l]]);
    }
  });
});
