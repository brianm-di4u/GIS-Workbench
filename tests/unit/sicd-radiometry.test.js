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

// Council round 6: zero fill is no data, not a −300 dB sample that terrain correction's looks
// would average in (sargeo-job.js looks() skips NaN only).
describe('calibrated SAR samples', async () => {
  const { calibratedDb } = await import('../../app/src/workers/decode/sicd.js');
  const { looks } = await import('../../app/src/analysis/sargeo-job.js');
  it('keeps β⁰ at band 5, which terrain correction reads (sar-terrain-ui.js BETA0)', () => {
    expect(SAR_BANDS[5]).toBe('beta0');
  });

  it('leaves zero fill out and keeps a sample under the noise as dark', () => {
    expect(calibratedDb(0, 0, 1)).toBeNaN();
    expect(calibratedDb(4, 1, 0.5)).toBeCloseTo(10 * Math.log10(1.5), 9);
    expect(calibratedDb(1, 2, 1)).toBeCloseTo(-300, 6);
    // A 2 × 2 look straddling the edge of a burst: two filled samples at power 1, two of zero fill.
    const db = Float32Array.from([1, 0, 1, 0], (p) => calibratedDb(p, 0, 1));
    expect(looks(db, 2, 2, 2, 2).beta[0]).toBeCloseTo(1, 9);
  });
});
