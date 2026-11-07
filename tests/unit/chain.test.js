// REQ-IMG-04 REQ-IMG-05 REQ-IMG-06 REQ-IMG-07: chain defaults, SIPS DRA, LUT folding.
import { describe, it, expect } from 'vitest';
import { autoChain, draRange, buildLut, stretchRange, chainRecord, chainSummary, lutDomain } from '../../app/src/render/chain.js';

function hist(values, type = 'u16') {
  const n = type === 'u8' ? 256 : 65536;
  const off = type === 'i16' ? 32768 : 0;
  const bins = new Uint32Array(n);
  for (const v of values) bins[v + off]++;
  return { bins, offset: off, min: -off, binWidth: 1, count: values.length, type };
}

describe('image chain', () => {
  it('REQ-IMG-07 picks a first-display chain by bit depth and band count', () => {
    expect(autoChain({ bands: 1, sampleType: 'u16', abpp: 11 }).stretch).toBe('dra');
    expect(autoChain({ bands: 1, sampleType: 'u8' }).stretch).toBe('minmax');
    expect(autoChain({ bands: 3, sampleType: 'u8' }).bands).toEqual([0, 1, 2]);
    expect(autoChain({ bands: 4, sampleType: 'u16', bandRoles: ['B', 'G', 'R', 'N'] }).bands).toEqual([2, 1, 0]);
    expect(autoChain({ bands: 1, sampleType: 'f32', kind: 'dem' }).colour.palette).toBe('terrain');
  });

  it('REQ-IMG-05 SIPS DRA with defaults 0.02/0.98/0.2/0.4', () => {
    // Uniform 1000..2000 with outliers at 0 and 4000.
    const v = [];
    for (let i = 1000; i <= 2000; i++) for (let k = 0; k < 10; k++) v.push(i);
    v.push(0, 4000);
    const r = draRange(hist(v));
    expect(r.amin).toBe(0);
    expect(r.amax).toBe(4000);
    expect(r.emin).toBeCloseTo(1020, -1);
    expect(r.emax).toBeCloseTo(1980, -1);
    expect(r.dmin).toBeCloseTo(r.emin - 0.2 * (r.emax - r.emin), 6);
    expect(r.dmax).toBeCloseTo(r.emax + 0.4 * (r.emax - r.emin), 6);
  });

  it('REQ-IMG-06 folds stretch and tone into one 65 536-entry LUT', () => {
    const c = autoChain({ bands: 1, sampleType: 'u16', abpp: 11 });
    c.stretch = 'minmax';
    const h = hist([100, 200, 300, 400, 500]);
    const { lut } = buildLut(h, 'u16', c);
    expect(lut.length).toBe(65536);
    expect(lut[100]).toBe(0);
    expect(lut[500]).toBe(255);
    expect(lut[300]).toBe(128);
    c.tone.invert = true;
    expect(buildLut(h, 'u16', c).lut[100]).toBe(255);
    c.tone.invert = false;
    c.tone.brightness = 100;
    expect(buildLut(h, 'u16', c).lut[300]).toBe(255);
  });

  it('maps signed and float data into the LUT domain', () => {
    expect(lutDomain(null, 'i16').offset).toBe(32768);
    const d = lutDomain({ min: -10, max: 10 }, 'f32');
    expect(d.scale * 10 + d.offset).toBeCloseTo(65535, 6);
    const c = autoChain({ bands: 1, sampleType: 'i16' });
    c.stretch = 'minmax';
    const { lut } = buildLut(hist([-100, 0, 100], 'i16'), 'i16', c);
    expect(lut[-100 + 32768]).toBe(0);
    expect(lut[100 + 32768]).toBe(255);
  });

  it('REQ-IMG-04 records the chain in stage order and summarises it', () => {
    const c = autoChain({ bands: 1, sampleType: 'u16', abpp: 12 });
    const rec = chainRecord(c);
    expect(rec.map((s) => s.stage)).toEqual(['S3', 'S4', 'S6', 'S7', 'S8', 'S9']);
    expect(chainSummary(c)).toContain('dra');
    expect(stretchRange(null, c)).toEqual({ lo: 0, hi: 1 });
  });
});

describe('S6 filters, tone curve, manual stretch (REQ-IMG-06, REQ-IMG-08, REQ-IMG-09)', async () => {
  const { filterKernel, applyCurve, normalizeChain, buildLut, autoChain } = await import('../../app/src/render/chain.js');
  const base = () => normalizeChain(autoChain({ bands: 1, sampleType: 'u8' }));
  it('linear kernels keep the mean (weights sum to 1) and nonlinear filters map to their modes', () => {
    for (const op of ['smooth', 'sharpen']) {
      const c = base();
      c.filter.op = op;
      const k = filterKernel(c);
      expect(k.mode).toBe(1);
      expect(k.k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    }
    const c = base();
    c.sharpen.usm = 1;
    expect(filterKernel(c).k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(filterKernel(c).k[12]).toBeGreaterThan(1);
    for (const [op, mode] of [['median', 2], ['dilate', 3], ['erode', 4], ['edge', 5]]) {
      const d = base();
      d.filter.op = op;
      expect(filterKernel(d).mode).toBe(mode);
    }
    const off = base();
    off.filter.op = 'sharpen';
    off.enabled.sharpen = false;
    expect(filterKernel(off).mode).toBe(0);
  });
  it('the MTF slot uses the 25 weights as given', () => {
    const c = base();
    c.filter = { op: 'mtf', size: 5, strength: 1, mtf: Array.from({ length: 25 }, (_, i) => (i === 12 ? 2 : -1 / 24)) };
    const k = filterKernel(c);
    expect(k.mode).toBe(1);
    expect(k.k[12]).toBeCloseTo(2, 6);
    expect(k.k[0]).toBeCloseTo(-1 / 24, 6);
  });
  it('the curve is piecewise linear and folds into the LUT', () => {
    const pts = [[0, 0], [0.5, 0.25], [1, 1]];
    expect(applyCurve(0.25, pts)).toBeCloseTo(0.125, 9);
    expect(applyCurve(0.75, pts)).toBeCloseTo(0.625, 9);
    const c = base();
    c.stretch = 'none';
    c.tone.curve = pts;
    const h = { bins: new Uint32Array(256).fill(1), offset: 0, count: 256, type: 'u8', binWidth: 1, min: 0 };
    const { lut } = buildLut(h, 'u8', c);
    expect(lut[255]).toBe(255);
    expect(Math.abs(lut[128] - Math.round(applyCurve(128 / 255, pts) * 255))).toBeLessThanOrEqual(1);
  });
  it('manual stretch uses the per-band limits', () => {
    const c = base();
    c.stretch = 'manual';
    c.manual = { 0: { lo: 100, hi: 200 } };
    const h = { bins: new Uint32Array(256).fill(1), offset: 0, count: 256, type: 'u8', binWidth: 1, min: 0 };
    const { lut, lo, hi } = buildLut(h, 'u8', c, 0);
    expect([lo, hi]).toEqual([100, 200]);
    expect(lut[100]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[150]).toBeGreaterThan(120);
  });
});
