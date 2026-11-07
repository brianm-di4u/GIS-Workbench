// REQ-GAP-21: what the app takes from the sidecar's OSSIM tool, before anything is fitted.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../app/src/shell/dialogs.js', () => ({ modal: vi.fn(), field: vi.fn() }));
vi.mock('../../app/src/shell/dom.js', () => ({ h: vi.fn(), fmtNum: (v) => String(v) }));
const { checkGrid, sampleJob } = await import('../../app/src/features/ossim.js');

const row = (i) => [40 + i * 1e-3, -105 - i * 1e-3, 100 + i, 10.5 + i, 20.5 + i];
const grid = (over = {}) => ({ tool: 'gwb-ossim-model', ossim: '2.12.1', model: 'ossimRadarSat2Model', width: 300, height: 200, box: { lat: [40, 41], lon: [-106, -105], h: [0, 500] }, fit: Array.from({ length: 40 }, (_, i) => row(i)), check: [row(50), row(51)], ...over });
const layer = { width: 300, height: 200, rec: { name: 'scene' } };

describe('the OSSIM sample job', () => {
  it('lays out the box, the counts and the samples as gw_fit_rpc_samples reads them', () => {
    const g = grid();
    const j = sampleJob(g);
    expect(j.length).toBe(10 + 42 * 5);
    expect([...j.slice(0, 10)]).toEqual([40, 41, -106, -105, 0, 500, 300, 200, 40, 2]);
    expect([...j.slice(10, 15)]).toEqual(row(0));
    expect([...j.slice(10 + 40 * 5, 15 + 40 * 5)]).toEqual(row(50));
  });

  it('the Rust side reads the same layout', () => {
    const src = readFileSync(new URL('../../crates/bundles/photo/src/lib.rs', import.meta.url), 'utf8');
    expect(src).toContain('a.len() != 10 + 5 * (nf + nc)');
    expect(src).toContain('let (nf, nc) = (a[8] as usize, a[9] as usize);');
  });
});

describe('what is refused before a fit', () => {
  it('takes a grid for this image', () => expect(checkGrid(grid(), layer).model).toBe('ossimRadarSat2Model'));
  it('refuses a model of another image size, by name', () => {
    expect(() => checkGrid(grid({ width: 301 }), layer)).toThrow(/301 × 200/);
    try {
      checkGrid(grid({ height: 9 }), layer);
    } catch (e) {
      expect(e.code).toBe('E_OSSIM_SIZE');
    }
  });
  for (const [what, over] of [['another tool', { tool: 'x' }], ['too few samples', { fit: [row(1)] }], ['no check samples', { check: [] }], ['no size', { width: NaN }], ['no samples', { fit: null }]]) {
    it(`refuses ${what}`, () => expect(() => checkGrid(grid(over), layer)).toThrow(/no usable OSSIM samples/));
  }
  it('refuses nothing at all', () => expect(() => checkGrid(null, layer)).toThrow());
});
