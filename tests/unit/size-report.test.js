import { describe, expect, it } from 'vitest';
import { sizeDelta, snapshot } from '../../build/size-report.mjs';

const report = (over = {}, blocks = {}) => ({
  build: { version: '2.6.0', id: 'abc' },
  sizes: { total: 9_000_000, airgap: 8_990_000, lite: 3_700_000, eager: 2_800_000, rustTotalGzip: 1_900_000, ...over, blocks },
});

describe('size report', () => {
  it('keeps the file sizes and each block stored size, blocks sorted', () => {
    const s = snapshot(report({}, { 'wasm-b': { stored: 2, raw: 9 }, 'wasm-a': { stored: 1, raw: 9 } }));
    expect(s.files).toEqual({ total: 9_000_000, airgap: 8_990_000, lite: 3_700_000, eager: 2_800_000, rustTotalGzip: 1_900_000 });
    expect(Object.entries(s.blocks)).toEqual([['wasm-a', 1], ['wasm-b', 2]]);
  });

  it('shows each change with its limit, and the blocks that moved most', () => {
    const base = snapshot(report({}, { keep: { stored: 5 }, grow: { stored: 100 }, gone: { stored: 30 } }));
    const now = snapshot(report({ total: 9_012_345, lite: 3_699_000 }, { keep: { stored: 5 }, grow: { stored: 1100 }, added: { stored: 40 } }));
    const text = sizeDelta(base, now);
    expect(text).toContain('### Size against 2.6.0 (build abc)');
    expect(text).toContain('| Full HTML | 9,012,345 B | +12,345 B | 18 MB | 50.1 % |');
    expect(text).toContain('| Lite HTML | 3,699,000 B | -1,000 B | 5.5 MB | 64.1 % |');
    expect(text).toContain('| Air-gap HTML | 8,990,000 B | 0 B | 18 MB |');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- `grow`: +1,000 B', '- `added`: +40 B (new)', '- `gone`: -30 B (gone)']);
  });

  it('says so when no block moved', () => {
    const s = snapshot(report({}, { a: { stored: 1 } }));
    expect(sizeDelta(s, s)).toContain('No embedded block changed size.');
  });
});
