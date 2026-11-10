// SAR stereo DSM levelling against a reference DEM (REQ-GAP-91, REG-084): the offset and tilt are
// recovered from stable terrain only, robustly, and an opposite-side pair is refused.
import { describe, it, expect } from 'vitest';
import { levelDsm, FLAG } from '../../app/src/analysis/sarstereo-report.js';

// A 300 × 300 grid of 3 m posts (about 0.9 km), hills of up to 60 m with steep flanks in one corner.
const g = { lat0: 38.0, lon0: -122.0, dlat: 3 / 111_000, dlon: 3 / 87_700, nx: 300, ny: 300 };
const refH = (lat, lon) => {
  const y = (g.lat0 - lat) * 111_000;
  const x = (lon - g.lon0) * 87_700;
  const steep = x > 650 && y > 650 ? (x - 650) * 0.9 : 0; // ≈ 42° in one corner
  return 500 + 30 * Math.sin(x / 140) * Math.cos(y / 170) + steep;
};
const ref = (lat, lon) => refH(lat, lon);

// A seeded random source, so the tests are the same every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());

/** DSM = reference + bias(x km, y km) + noise σ 3 m + 8 % outliers of ±40 m; some posts flagged. */
function makeDsm(bias, { steepExtra = 0, opposite = false } = {}) {
  const r = rng(7);
  const n = g.nx * g.ny;
  const heights = new Float32Array(n);
  const flags = new Uint8Array(n);
  for (let j = 0; j < g.ny; j++)
    for (let i = 0; i < g.nx; i++) {
      const k = j * g.nx + i;
      const lat = g.lat0 - j * g.dlat;
      const lon = g.lon0 + i * g.dlon;
      const x = ((i - (g.nx - 1) / 2) * g.dlon * 87_700) / 1000;
      const y = ((((g.ny - 1) / 2 - j) * g.dlat * 111_000) / 1000);
      let e = bias(x, y) + 3 * gauss(r);
      if (r() < 0.08) e += r() < 0.5 ? 40 : -40;
      const steep = i * 3 > 650 && j * 3 > 650;
      if (steep) e += steepExtra;
      // Every 7th post is masked or rejected, with a gross error the levelling must not see.
      if (k % 7 === 0) {
        flags[k] = k % 2 ? FLAG.layoverA : FLAG.rejected;
        e += 200;
      }
      heights[k] = refH(lat, lon) + e;
    }
  return { grid: g, heights, flags, stats: { geometry: { sameSide: !opposite } } };
}

describe('SAR stereo DSM levelling', () => {
  it('recovers the offset from stable posts despite outliers and flagged posts', () => {
    const lv = levelDsm(makeDsm(() => 7.5), ref);
    expect(lv.offset).toBeGreaterThan(7.3);
    expect(lv.offset).toBeLessThan(7.7);
    expect(Math.abs(lv.after.median)).toBeLessThan(0.15);
    expect(lv.before.median).toBeGreaterThan(7);
    expect(lv.tilt).toBeNull();
    expect(lv.sigma).toBeGreaterThan(2.5);
    expect(lv.sigma).toBeLessThan(3.6); // the noise's own σ, the outliers left out by NMAD
    expect(lv.offsetSigma).toBeLessThan(0.05);
  });

  it('fits a tilt robustly when asked', () => {
    const lv = levelDsm(makeDsm((x, y) => 5 + 0.8 * x - 0.5 * y), ref, { tilt: true });
    expect(lv.offset).toBeCloseTo(5, 0);
    expect(Math.abs(lv.offset - 5)).toBeLessThan(0.2);
    expect(Math.abs(lv.tilt[0] - 0.8)).toBeLessThan(0.1);
    expect(Math.abs(lv.tilt[1] + 0.5)).toBeLessThan(0.1);
    // The levelled heights sit on the reference: the median over a stable post set is about 0.
    expect(Math.abs(lv.after.median)).toBeLessThan(0.2);
  });

  it('leaves steep terrain out of the fit', () => {
    // A further 25 m only on the steep corner (slopes over 10°) does not move the offset.
    const lv = levelDsm(makeDsm(() => 6, { steepExtra: 25 }), ref);
    expect(Math.abs(lv.offset - 6)).toBeLessThan(0.25);
  });

  it('refuses an opposite-side pair unless told, and a DSM with too few stable posts', () => {
    expect(() => levelDsm(makeDsm(() => 3, { opposite: true }), ref)).toThrow(/opposite-side/);
    expect(levelDsm(makeDsm(() => 3, { opposite: true }), ref, { allowOpposite: true }).offset).toBeCloseTo(3, 0);
    expect(() => levelDsm(makeDsm(() => 3), () => NaN)).toThrow(/stable posts/);
  });
});

// Council round 3: a saved DSM is read back by GDAL metadata items, not by its prose description.
describe('SAR stereo DSM metadata (REG-084)', async () => {
  const { dsmMetadata, metaItem } = await import('../../app/src/features/sarstereo.js');
  it('round-trips the product, the pair side and a long prior with XML characters', () => {
    const prior = `GLO-30 <tile & "N38">${'; levelled on 3DEP by 1.00 m, residual NMAD 0.50 m over 900 stable posts'.repeat(40)}`;
    const md = dsmMetadata({ prior, stats: { geometry: { sameSide: false } } }, true);
    expect(metaItem(md, 'GWB_PRODUCT')).toBe('SAR_STEREO_DSM');
    expect(metaItem(md, 'GWB_SAME_SIDE')).toBe('0');
    expect(metaItem(md, 'GWB_PRIOR')).toBe(prior);
    expect(md.length).toBeLessThan(20000);
    expect(metaItem(dsmMetadata({ stats: { geometry: { sameSide: true } } }, true), 'GWB_SAME_SIDE')).toBe('1');
  });
  it('marks a heights-only DSM as no product', () => {
    expect(metaItem(dsmMetadata({ prior: 'x' }, false) ?? '', 'GWB_PRODUCT')).toBe(null);
    expect(dsmMetadata({}, false)).toBe(undefined);
  });
});
