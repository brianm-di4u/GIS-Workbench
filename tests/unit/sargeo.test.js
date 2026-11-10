// SAR geocoding and terrain correction (REQ-GAP-90, REG-085): the job builder, and the whole chain
// (legacy bundle's annotation → sargeo bundle) against a Sentinel-1 product's own geolocation grid,
// the S-72 oracle. The product is in the T&E corpus, not the repository (third-party data); the
// test skips without it.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { SargeoBundle } from '../../app/src/wasm/sargeo.js';
import { C, pickOrbit, imageGeometry, windowOver, looks, sargeoParams } from '../../app/src/analysis/sargeo-job.js';

const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => (target ? join(target, 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`) : '');
const haveWasm = !!target && existsSync(wasm('sargeo')) && existsSync(wasm('legacy'));
const CORPUS = process.env.TE_CORPUS ?? 'C:/GIS Workbench/TE-corpus';
const SAFE = join(CORPUS, 'sar-s1-iw-slc-vegas-20240626-20240708', 'S1A_IW_SLC__1SDV_20240626T134404_20240626T134432_054495_06A1B9_6F14.SAFE');
const haveScene = existsSync(join(SAFE, 'annotation'));

const ann0 = {
  t0: 1000,
  t1: 1025,
  lines: 100,
  samples: 50,
  azimuthTimeInterval: 0.002,
  azimuthSpacing: 14,
  rangeSpacing: 2.3,
  slantRangeTime: 0.0053,
  rangeSamplingRate: 6.4e7,
  productType: 'SLC',
  bursts: [],
  orbit: { t: [990, 1000, 1010, 1020, 1030], p: Array(15).fill(1), v: Array(15).fill(2) },
};

describe('REQ-GAP-90 REG-085 SAR geocoding jobs', () => {
  it('uses an orbit file only when it covers the product with a minute to spare', () => {
    const t = Array.from({ length: 100 }, (_, k) => 500 + 10 * k);
    const file = { type: 'AUX_POEORB', orbit: { t, p: t.flatMap(() => [1, 2, 3]), v: t.flatMap(() => [4, 5, 6]) } };
    const o = pickOrbit(ann0, file);
    expect(o.source).toBe('AUX_POEORB');
    expect(o.t[0]).toBeLessThanOrEqual(880);
    expect(o.t.at(-1)).toBeGreaterThanOrEqual(1145);
    expect(o.p.length).toBe(3 * o.t.length);
    // Ends 30 s after the product: not enough; the annotation's orbit is used.
    const short = { type: 'AUX_RESORB', orbit: { t: t.filter((x) => x <= 1055), p: [], v: [] } };
    expect(pickOrbit(ann0, short).source).toBe('annotation');
    expect(pickOrbit({ ...ann0, orbit: { t: [1, 2], p: [], v: [] } }, null)).toBeNull();
    // Another satellite's file that covers the times is refused, not used.
    expect(() => pickOrbit({ ...ann0, missionId: 'S1A' }, { ...file, mission: 'Sentinel-1C' })).toThrow(/Sentinel-1C/);
    expect(pickOrbit({ ...ann0, missionId: 'S1A' }, { ...file, mission: 'Sentinel-1A' }).source).toBe('AUX_POEORB');
    // Remembered from another scene and not covering this one: the annotation's orbit, no error.
    expect(pickOrbit({ ...ann0, t0: 5000, t1: 5025, missionId: 'S1C' }, { ...file, mission: 'Sentinel-1A' }).source).toBe('annotation');
  });

  it('builds slant-range timing for SLC and ground-range records for GRD', () => {
    const slc = imageGeometry(ann0);
    expect(slc.range).toEqual({ kind: 'slant', r0: (0.0053 * C) / 2, dr: C / (2 * 6.4e7) });
    expect(slc.blocks).toEqual([{ t0: 0, firstLine: 0, valid: [0, 100] }]);
    const bursts = imageGeometry({ ...ann0, bursts: [{ t: 1000.5, firstLine: 0, validLines: [3, 48] }, { t: 1001.4, firstLine: 50, validLines: [53, 98] }] });
    expect(bursts.blocks[0].t0).toBeCloseTo(0.5, 9);
    expect(bursts.blocks[1].t0).toBeCloseTo(1.4, 9);
    const grd = imageGeometry({ ...ann0, productType: 'GRD', conversion: [{ t: 1001, sr0: 8e5, gr0: 0, srgr: [0, 1.6], grsr: [8e5, 0.6] }] });
    expect(grd.range.kind).toBe('ground');
    expect(grd.range.recs[0].t).toBe(1);
    expect(imageGeometry({ ...ann0, productType: 'GRD', conversion: [] })).toBeNull();
  });

  it('averages β⁰ looks in linear power and lays out the parameter list', () => {
    const db = Float32Array.from([0, 10, NaN, 0, 0, 0, 0, NaN]); // 4 × 2: two 2 × 2 looks
    const l = looks(db, 4, 2, 2, 2);
    expect(l.nl).toBe(1);
    expect(l.ns).toBe(2);
    expect(l.beta[0]).toBeCloseTo((1 + 10 + 1 + 1) / 4, 6);
    expect(l.beta[1]).toBeCloseTo(1, 6); // NaN samples left out
    const prm = sargeoParams({ t: [1, 2, 3, 4], p: Array(12).fill(0), v: Array(12).fill(0) }, 1, imageGeometry(ann0), { width: 2, height: 3, lat0: 1, lon0: 2, dlat: 0.1, dlon: 0.1 }, { l0: 0, s0: 0, kl: 1, ks: 1, nl: 1, ns: 1 }, { flatten: true });
    // 1 + 4 + 12 + 12 (orbit) + 3 + 4 (one block) + 3 (slant) + 6 (DEM) + 6 (window) + 5 (options)
    expect(prm.length).toBe(56);
    expect(Array.from(prm.slice(1, 5))).toEqual([0, 1, 2, 3]);
  });

  it('finds the radar window over a DEM from the geolocation grid', () => {
    const grid = { regular: true, lines: [0, 50, 99], pixels: [0, 49], lat: [36.2, 36.2, 36.1, 36.1, 36.0, 36.0], lon: [-115.3, -115.0, -115.3, -115.0, -115.3, -115.0] };
    const w = windowOver({ ...ann0, grid }, { south: 36.15, north: 36.25, west: -115.2, east: -115.1 });
    expect(w).toEqual({ x0: 0, y0: 0, w: 50, h: 100 });
    expect(windowOver({ ...ann0, grid }, { south: 10, north: 11, west: 0, east: 1 })).toBeNull();
  });
});

describe.skipIf(!haveWasm || !haveScene)('sargeo on a Sentinel-1 IW SLC (S-72 oracle)', () => {
  const legacy = new Bundle(new WebAssembly.Module(readFileSync(wasm('legacy'))), 'legacy');
  const annotation = (file) => {
    const [p, n] = legacy.put(readFileSync(file));
    try {
      expect(legacy.x.gw_safe_xml(2, p, n)).toBe(0);
      return legacy.outJson();
    } finally {
      legacy.free(p, n);
    }
  };

  // The grid gives each point's zero-Doppler azimuth time and slant range time (rows lie on burst
  // boundaries, so burst choice is left to the native tests): one unbounded timing block makes the
  // expected line (t − t0)/dt and the expected pixel (cτ/2 − r0)/dr.
  it.each(['iw1', 'iw2', 'iw3'])('%s: every geolocation grid point maps to its own azimuth time and range', async (sw) => {
    const dir = join(SAFE, 'annotation');
    const ann = annotation(join(dir, readdirSync(dir).find((f) => f.includes(`-${sw}-`) && f.includes('-vv-'))));
    expect(ann.orbit.t.length).toBe(17);
    const orbit = pickOrbit(ann, null);
    const geom = imageGeometry(ann);
    expect(geom.blocks.length).toBe(ann.bursts.length);
    const one = { ...geom, blocks: [{ t0: 0, firstLine: 0, valid: [-1e9, 1e9] }] };
    const sg = new SargeoBundle(new WebAssembly.Module(readFileSync(wasm('sargeo'))));
    const g = ann.grid;
    let worst = [0, 0];
    for (let k = 0; k < g.lat.length; k++) {
      const dem = { width: 2, height: 2, lat0: g.lat[k], lon0: g.lon[k], dlat: 1e-5, dlon: 1e-5 };
      const z = new Float32Array(4).fill(g.height[k]);
      const prm = sargeoParams(orbit, ann.t0, one, dem, { l0: 0, s0: 0, kl: 1, ks: 1, nl: 1, ns: 1 }, { flatten: false, look: 1 });
      const r = await sg.run(prm, z, new Float32Array(1), { coords: true });
      const line = (g.t[k] - ann.t0) / geom.dt;
      const pixel = ((g.tau[k] * C) / 2 - geom.range.r0) / geom.range.dr;
      worst = [Math.max(worst[0], Math.abs(r.coords[0] - line)), Math.max(worst[1], Math.abs(r.coords[1] - pixel))];
    }
    expect(g.lat.length).toBeGreaterThan(200);
    // S-72: 2.4 µs in azimuth is 0.0012 lines (dt 2.06 ms); 8 mm in range is 0.004 pixels (2.33 m).
    expect(worst[0], `worst line error ${worst[0]}`).toBeLessThan(0.005);
    expect(worst[1], `worst pixel error ${worst[1]}`).toBeLessThan(0.01);
  });
});
