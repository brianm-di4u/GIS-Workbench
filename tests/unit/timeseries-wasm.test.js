// REQ-GAP-83 temporal trend and anomaly: the `spectral` WASM bundle (crates/gw-spectral
// temporal.rs) through its JS wrapper, on the SCN-76 fixture (fixtures/timeseries), against the
// independent reference tests/tools/timeseries_ref.py wrote beside it: scipy.stats.linregress per
// pixel over the dates present, and the anomaly by calendar month against 2010-2014 with numpy.
// Skipped when the bundle is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpectralBundle } from '../../app/src/wasm/spectral.js';
import { decimalYear, groupsOf, baselineFlags } from '../../app/src/analysis/time-series.js';

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_spectral.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const B = haveWasm ? new SpectralBundle(new WebAssembly.Module(readFileSync(wasmPath))) : null;

const REF = JSON.parse(readFileSync('fixtures/timeseries/ndvi-2010-2019.ref.json', 'utf8'));
const { width: W, height: H, dates } = REF;
const NT = dates.length;
// ndvi (time, lat, lon) is the file's last fixed-size variable, so its big-endian floats end it.
function cube() {
  const b = readFileSync('fixtures/timeseries/ndvi-2010-2019.nc');
  const dv = new DataView(b.buffer, b.byteOffset + b.length - NT * H * W * 4, NT * H * W * 4);
  const v = new Float32Array(W * H * NT);
  for (let k = 0; k < NT; k++) {
    for (let p = 0; p < W * H; p++) {
      const x = dv.getFloat32((k * W * H + p) * 4, false);
      v[p * NT + k] = x === -9999 ? NaN : x;
    }
  }
  return v;
}

describe.skipIf(!haveWasm)('REQ-GAP-83 temporal trend and anomaly (spectral bundle)', () => {
  const v = cube();
  it('the decimal years agree with the reference', () => {
    dates.forEach((d, k) => expect(decimalYear(d)).toBeCloseTo(REF.years[k], 10));
  });
  it('gives scipy linregress slope, p-value and date count at every pixel', () => {
    const r = B.trend(v, W, H, NT, dates.map(decimalYear));
    let worstSlope = 0;
    let worstP = 0;
    for (let p = 0; p < W * H; p++) {
      expect(r.n[p]).toBe(REF.trend.n[p]);
      worstSlope = Math.max(worstSlope, Math.abs(r.slope[p] - REF.trend.slope[p]));
      // p-values span 1e-40 to 1: compare in log space below 1e-3, absolutely above.
      const a = r.pvalue[p];
      const e = REF.trend.pvalue[p];
      worstP = Math.max(worstP, e < 1e-3 ? Math.abs(Math.log10(Math.max(a, 1e-300)) - Math.log10(e)) / 100 : Math.abs(a - e));
    }
    expect(worstSlope).toBeLessThan(2e-6);
    expect(worstP).toBeLessThan(1e-5);
  });
  it('gives the reference anomaly and z-score against 2010-2014 by calendar month', () => {
    const base = baselineFlags(dates, ...REF.baseline);
    const groups = groupsOf(dates, 'month');
    const a = B.anomaly(v, W, H, NT, { base, groups }).anomaly;
    const z = B.anomaly(v, W, H, NT, { base, groups, z: true }).anomaly;
    for (const s of REF.anomaly) {
      const p = s.y * W + s.x;
      for (let k = 0; k < NT; k++) {
        if (s.anomaly[k] === null) {
          expect(a[p * NT + k], `anomaly ${s.x},${s.y} date ${k}`).toBeNaN();
          continue;
        }
        expect(Math.abs(a[p * NT + k] - s.anomaly[k]), `anomaly ${s.x},${s.y} date ${k}`).toBeLessThan(2e-6);
        expect(Math.abs(z[p * NT + k] - s.z[k]), `z ${s.x},${s.y} date ${k}`).toBeLessThan(5e-5);
      }
    }
  });
  it('refuses a trend without one date per band, and an empty baseline', () => {
    expect(() => B.trend(v, W, H, NT, dates.slice(1).map(decimalYear))).toThrow(/one finite date per band/);
    expect(() => B.anomaly(v, W, H, NT, { base: dates.map(() => false) })).toThrow(/baseline holds no dates/);
  });
});
