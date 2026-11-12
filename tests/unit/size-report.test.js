import { describe, expect, it } from 'vitest';
import { limitText, sizeDelta, snapshot } from '../../build/size-report.mjs';

const report = (over = {}, blocks = {}) => ({
  build: { version: '2.6.0', id: 'abc' },
  sizes: { total: 9_000_000, airgap: 8_990_000, lite: 3_700_000, eager: 2_800_000, rustTotalGzip: 1_900_000, ...over, blocks },
});

describe('size report', () => {
  it('keeps the file sizes and each block stored size, blocks sorted', () => {
    const s = snapshot(report({}, { 'wasm-b': { stored: 2, raw: 9 }, 'wasm-a': { stored: 1, raw: 9 } }));
    expect(s).not.toHaveProperty('commit');
    expect(s.files).toEqual({ total: 9_000_000, airgap: 8_990_000, lite: 3_700_000, eager: 2_800_000, rustTotalGzip: 1_900_000 });
    expect(Object.entries(s.blocks)).toEqual([['wasm-a', 1], ['wasm-b', 2]]);
  });

  it('shows each change with its limit, and the blocks that moved most', () => {
    const base = snapshot(report({}, { keep: { stored: 5 }, grow: { stored: 100 }, gone: { stored: 30 } }));
    const now = snapshot(report({ total: 9_012_345, lite: 3_699_000 }, { keep: { stored: 5 }, grow: { stored: 1100 }, added: { stored: 40 } }));
    const text = sizeDelta(base, now);
    expect(text).toContain('### Size since 2.6.0 at build abc');
    expect(text).toContain('not only this change');
    expect(text).toContain('| Full HTML | 9,012,345 B | +12,345 B | 18 MB | 50.1 % |');
    expect(text).toContain('| Lite HTML | 3,699,000 B | -1,000 B | 5.5 MiB | 64.1 % |');
    expect(text).toContain('| Air-gap HTML | 8,990,000 B | 0 B | 18 MB |');
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- `grow`: +1,000 B', '- `added`: +40 B (new)', '- `gone`: -30 B (gone)']);
  });

  it('names the baseline by its build, not a commit an older baseline recorded (#212)', () => {
    const s = snapshot(report());
    expect(sizeDelta({ ...s, commit: '16fd80c' }, s)).toContain('### Size since 2.6.0 at build abc');
  });

  it('shows a file the build never wrote as not built, instead of failing', () => {
    const base = snapshot(report());
    const partial = snapshot({ build: { version: '2.6.0', id: 'x' }, sizes: { total: 19_000_000, eager: 1, rustTotalGzip: 1, blocks: {} } });
    const text = sizeDelta(base, partial);
    expect(text).toContain('| Lite HTML | not built | | 5.5 MiB | |');
    expect(text).toContain('| Air-gap HTML | not built |');
  });

  it('writes each limit the way gates.mjs states it', () => {
    expect([18_000_000, 5.5 * 1048576, 6 * 1048576, 4 * 1048576].map(limitText)).toEqual(['18 MB', '5.5 MiB', '6 MiB', '4 MiB']);
  });

  it('says so when no block moved', () => {
    const s = snapshot(report({}, { a: { stored: 1 } }));
    expect(sizeDelta(s, s)).toContain('No embedded block changed size.');
  });
});
