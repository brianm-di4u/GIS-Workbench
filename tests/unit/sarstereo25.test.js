// REQ-GAP-42 (GR-15): the DSM accuracy statistics (app/src/analysis/sarstereo-report.js) on known
// inputs, and the `sar` WASM bundle's radargrammetry ABI (gw_sar_stereo_*) on the SICD models of
// the Umbra and Capella collects (fixtures/fx25/sarstereo, read by the `parse` bundle): the pair
// finder's geometry, a job run to the end through the stepping calls, and refusals by name.
// The matching accuracy itself is measured in Rust (crates/gw-sar radargram tests, synthetic) and
// on real pairs (tests/campaign/c61-sar-stereo.spec.js). Skipped where the bundles are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SarBundle } from '../../app/src/wasm/sar.js';
import { Core } from '../../app/src/wasm/core.js';
import { Bundle } from '../../app/src/wasm/abi.js';
import { errorStats, dsmAccuracy, reportCsv, FLAG } from '../../app/src/analysis/sarstereo-report.js';

const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => (target ? join(target, 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`) : '');
const haveWasm = !!target && existsSync(wasm('sar')) && existsSync(wasm('parse'));
const FX = resolve('fixtures/fx25/sarstereo');

describe('DSM accuracy statistics', () => {
  it('errorStats gives the textbook values', () => {
    const s = errorStats([1, -1, 2, -2, 0, NaN, 10]);
    expect(s.n).toBe(6);
    expect(s.mean).toBeCloseTo(10 / 6, 12);
    expect(s.median).toBeCloseTo(0.5, 12);
    expect(s.rmse).toBeCloseTo(Math.sqrt(110 / 6), 12);
    // |e − median| = 0.5, 1.5, 1.5, 2.5, 0.5, 9.5 → MAD 1.5.
    expect(s.nmad).toBeCloseTo(1.4826 * 1.5, 12);
    expect(s.le90).toBe(10);
    expect(s.min).toBe(-2);
    expect(s.max).toBe(10);
    expect(errorStats([NaN])).toBeNull();
  });

  it('the CSV carries a warning when the report has one', () => {
    const stats = { n: 1, mean: 0, median: 0, std: 0, nmad: 0, rmse: 0, le90: 0, le95: 0, min: 0, max: 0 };
    const rep = { error: stats, bySlope: {}, completeness: 1, masked: { share: 0 } };
    expect(reportCsv(rep, 'x')).not.toContain('warning');
    expect(reportCsv({ ...rep, warning: 'opposite-side pair, not recommended' }, 'x')).toContain('x,warning,opposite-side pair, not recommended');
  });

  it('counts completeness, masks and calibration on a grid', () => {
    const nx = 20;
    const ny = 10;
    const grid = { lat0: 40, lon0: -105, dlat: 1e-4, dlon: 1e-4, nx, ny };
    const n = nx * ny;
    const heights = new Float32Array(n).fill(NaN);
    const sigma = new Float32Array(n).fill(NaN);
    const flags = new Uint8Array(n);
    // A plane rising 0.5 m per post to the east (about 3.4° at 8.5 m posts) as the reference.
    const ref = (lat, lon) => (lon > -105 + 15.5e-4 ? NaN : 1000 + ((lon + 105) / 1e-4) * 0.5);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (i < 4) flags[k] = FLAG.layoverA;
        else if (i === 4) flags[k] = FLAG.shadowB;
        else if (i === 5) flags[k] = FLAG.weak;
        else {
          heights[k] = 1000 + i * 0.5 + (j % 2 ? 1 : -1);
          sigma[k] = j < 5 ? 2 : 0.6;
        }
      }
    const rep = dsmAccuracy({ grid, heights, sigma, flags }, ref);
    // Columns 16–19 have no reference: 16 columns × 10 rows are covered.
    expect(rep.covered).toBe(160);
    expect(rep.matched).toBe(100);
    expect(rep.completeness).toBeCloseTo(100 / 160, 12);
    expect(rep.masked.any).toBe(50);
    expect(rep.masked.layover).toBe(40);
    expect(rep.masked.shadow).toBe(10);
    expect(rep.rejected.weak).toBe(10);
    expect(rep.error.mean).toBeCloseTo(0, 6);
    expect(rep.error.rmse).toBeCloseTo(1, 6);
    expect(rep.bySlope.flat.n).toBe(rep.matched);
    // σ 2 for half the posts (|e| = 1 within 1σ), 0.6 for the other half (within 2σ only).
    expect(rep.calibration.within1).toBeCloseTo(0.5, 12);
    expect(rep.calibration.within2).toBeCloseTo(1, 12);
    expect(reportCsv(rep, 'x')).toMatch(/^dsm,group,n,mean/);
  });
});

class ParseBundle extends Bundle {
  constructor(m) {
    super(m, 'parse');
  }
  sarXml(text) {
    const b = new TextEncoder().encode(text);
    return this.guard(() => {
      const [p, n] = this.put(b);
      try {
        this.check(this.x.gw_sar_xml(p, n, 0), 'sarXml');
        return this.outJson();
      } finally {
        this.free(p, n);
      }
    });
  }
}

describe.skipIf(!haveWasm)('radargrammetry ABI (sar bundle)', () => {
  const load = async (n) => new WebAssembly.Module(readFileSync(wasm(n)));
  const sicd = async () => {
    const parse = new ParseBundle(await load('parse'));
    const out = {};
    for (const f of readdirSync(FX).filter((x) => x.endsWith('.sicd.xml'))) out[f.replace('.sicd.xml', '')] = parse.sarXml(readFileSync(join(FX, f), 'utf8'));
    return out;
  };

  it('a SICD with no CompositeSCP has no stated horizontal sigma (not a sigma of 0)', async () => {
    const x = await sicd();
    const core = new Core(await load('core'));
    for (const [k, v] of Object.entries(x)) expect(core.modelInfo(core.sicdModel(v.record, k)).sigmaH ?? null, k).toBeNull();
  });

  it('ranks the Hetch Hetchy and Capella pairs by their geometry', async () => {
    const x = await sicd();
    const sar = new SarBundle(await load('sar'));
    const names = Object.keys(x).sort();
    const collects = names.map((k) => ({ start: Date.parse(x[k].collectStart) / 1000, record: x[k].record }));
    const pairs = sar.stereoPairs(collects);
    expect(pairs.length).toBe((names.length * (names.length - 1)) / 2);
    const find = (a, b) => pairs.find((p) => [names[p.a], names[p.b]].sort().join('|') === [a, b].sort().join('|'));
    const p10 = find('umbra_2023-09-28-05-16-39_UMBRA-04', 'umbra_2023-07-27-05-21-14_UMBRA-05');
    expect(p10.ok).toBe(true);
    expect(p10.geometry.sameSide).toBe(true);
    expect(p10.geometry.intersectionDeg).toBeGreaterThan(8.5);
    expect(p10.geometry.intersectionDeg).toBeLessThan(11.5);
    expect(p10.geometry.parallax).toBeCloseTo(0.548, 2);
    const p22 = find('umbra_2023-08-25-05-12-40_UMBRA-05', 'umbra_2023-07-27-05-21-14_UMBRA-05');
    expect(p22.ok).toBe(false);
    expect(p22.reasons).toContain('wide');
    // Collects of different sites do not overlap.
    const far = find('umbra_2023-07-27-05-21-14_UMBRA-05', 'CAPELLA_C10_SM_SICD_HH_20240923022852_20240923022856');
    expect(far.reasons).toContain('overlap');
    // Hatay (Capella spotlight, 2022): the C06 pair is same side at about 16°; C05 28 Oct looks
    // from the other side (left-looking descending against right-looking descending).
    const c06 = find('CAPELLA_C06_SP_SICD_HH_20221012045810_20221012045839', 'CAPELLA_C06_SP_SICD_HH_20221017032649_20221017032714');
    expect(c06.geometry.sameSide).toBe(true);
    expect(c06.geometry.intersectionDeg).toBeGreaterThan(13);
    expect(c06.geometry.intersectionDeg).toBeLessThan(19);
    const opp = find('CAPELLA_C05_SP_SICD_HH_20221016120716_20221016120739', 'CAPELLA_C05_SP_SICD_HH_20221028123957_20221028124018');
    expect(opp.geometry.sameSide).toBe(false);
    expect(opp.notes).toContain('opposite');
    expect(opp.geometry.left.sort()).toEqual([false, true]);
    // Denver (Capella stripmap, 2024): same side, about 4°.
    const den = find('CAPELLA_C10_SM_SICD_HH_20240923022852_20240923022856', 'CAPELLA_C14_SM_SICD_HH_20240922060342_20240922060351');
    expect(den.geometry.sameSide).toBe(true);
    expect(den.geometry.intersectionDeg).toBeGreaterThan(3);
    expect(den.geometry.intersectionDeg).toBeLessThan(6);
    expect(den.ok).toBe(true);
  }, 60000);

  it('runs a DSM job through the stepping calls and refuses bad records by name', async () => {
    const x = await sicd();
    const sar = new SarBundle(await load('sar'));
    const a = x['umbra_2023-09-28-05-16-39_UMBRA-04'];
    const b = x['umbra_2023-07-27-05-21-14_UMBRA-05'];
    const lat = a.scpLat;
    const lon = a.scpLon;
    const h = a.scpHae;
    const dlat = 2 / 111000;
    const dlon = 2 / (111000 * Math.cos((lat * Math.PI) / 180));
    const prm = [1, lat + 12 * dlat, lon - 12 * dlon, dlat, dlon, 24, 24, lat + 40 * dlat, lon - 40 * dlon, 2 * dlat, 2 * dlon, 40, 40, 0, 0, 4, 4, 48, 48, 0, 0, 4, 4, 48, 48, 1, 2, 20, 0.5, 0, 0.3, 0.03, 0, 0, 5, 0.5, 2, 4, 0, 8];
    const chip = Float32Array.from({ length: 48 * 48 }, (_, k) => 1 + ((k * 7919) % 101) / 10);
    const id = sar.stereoNew(prm, a.record, b.record, new Float32Array(1600).fill(h), chip, chip);
    let p = 0;
    let steps = 0;
    while (p < 1 && steps < 10000) {
      p = sar.stereoStep(id, 4);
      steps++;
    }
    expect(p).toBe(1);
    const r = sar.stereoResult(id, 24 * 24);
    sar.stereoFree(id);
    expect(r.heights.length).toBe(576);
    expect(r.stats.posts).toBe(576);
    expect(r.stats.geometry.sameSide).toBe(true);
    // These SICDs state no CompositeSCP: the record's null stays absent, not a σ of zero.
    expect(r.stats.sigmaSysSource).toBe('none');
    // The chips are not where the area images, so nothing matches.
    expect(r.stats.matched).toBe(0);
    expect([...r.flags].every((f) => f === FLAG.noData || f & 15)).toBe(true);
    // A job id that is gone, and parameters out of range, are refused with their reason.
    expect(() => sar.stereoStep(id, 1)).toThrow(/no such job/);
    expect(() => sar.stereoNew([...prm.slice(0, 26), 0, ...prm.slice(27)], a.record, b.record, new Float32Array(1600), chip, chip)).toThrow(/window out of range/);
    expect(() => sar.stereoNew(prm, a.record, a.record, new Float32Array(1600).fill(h), chip, chip)).toThrow(/no height sensitivity/);
    expect(() => sar.multilook(new Float32Array(5), 3, 2, 1, 1)).toThrow(/does not match/);
    const ml = sar.multilook(Float32Array.from([1, 2, 3, 4]), 2, 2, 2, 2, true);
    expect(ml.w).toBe(1);
    expect(ml.v[0]).toBeCloseTo(7.5, 6);
  }, 60000);
});
