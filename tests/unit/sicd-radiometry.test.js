import { describe, it, expect } from 'vitest';
import { radiometry, SAR_BANDS } from '../../app/src/workers/decode/sicd.js';

const poly = (v) => ({ n1: 1, n2: 1, c: [v] });
const base = { slope: 0, graze: 30, rowBW: 2, colBW: 4 };

describe('SICD radiometry (REQ-SAR-06)', () => {
  it('has the β⁰, σ⁰ and γ⁰ bands only', () => {
    expect(SAR_BANDS.slice(5)).toEqual(['beta0', 'sigma0', 'gamma0']);
  });

  it('derives the missing polynomials from any one present', () => {
    const r = radiometry({ ...base, radiometric: { sigma0: poly(2) } });
    expect(Object.keys(r.derived)).toEqual(['beta0', 'sigma0', 'gamma0']);
    expect(r.derived.sigma0).toBe('file');
    expect(r.beta0.c[0]).toBeCloseTo(2);
    expect(r.gamma0.c[0]).toBeCloseTo(4);
    expect(r.note).toBeNull();
  });

  it('still calibrates a file whose Radiometric block has only RCSSFPoly', () => {
    const r = radiometry({ ...base, rowWgt: 'HAMMING', radiometric: { rcs: poly(16) } });
    expect(r.reason).toBeNull();
    expect(r.beta0.c[0]).toBeCloseTo(128);
    expect(r.sigma0.c[0]).toBeCloseTo(128);
    expect(r.gamma0.c[0]).toBeCloseTo(256);
    expect(r).not.toHaveProperty('rcs');
    expect(r.note).toMatch(/uniform weighting/);
  });
});
