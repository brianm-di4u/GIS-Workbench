// Sentinel-1 SAFE (REQ-FMT-55) through the real `legacy` and `core` WASM bundles: the FX-21 SAFE skeleton
// and the T&E corpus IW SLC (Las Vegas): manifest objects and footprint, bursts and valid ranges, the
// geolocation grid as a model (exact at the grid points the measurement's GCPs repeat), and the
// calibration/noise look-up tables (σ⁰ = (|DN|² − η)/A², A interpolated between the vectors).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { Core } from '../../app/src/wasm/core.js';
import { safeXml, s1Luts } from '../../app/src/workers/decode/safe.js';
import { generate } from '../../build/fixtures/fx21/sar.mjs';

const tdir = (() => {
  try {
    return join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
  } catch {
    return null;
  }
})();
const have = !!tdir && existsSync(join(tdir, 'gw_bundle_legacy.wasm')) && existsSync(join(tdir, 'gw_bundle_core.wasm'));
const B = have ? new Bundle(new WebAssembly.Module(readFileSync(join(tdir, 'gw_bundle_legacy.wasm'))), 'legacy') : null;
const core = have ? new Core(new WebAssembly.Module(readFileSync(join(tdir, 'gw_bundle_core.wasm')))) : null;
const FX = resolve('fixtures/fx21/sar/S1A_IW_SLC__FX21.SAFE');
if (!existsSync(join(FX, 'manifest.safe'))) await generate(resolve('fixtures/fx21/sar'));
const SAFE = join(process.env.TE_CORPUS ?? resolve('..', 'TE-corpus'), 'sar-s1-iw-slc-vegas-20240626-20240708', 'S1A_IW_SLC__1SDV_20240626T134404_20240626T134432_054495_06A1B9_6F14.SAFE');
const read = (p) => new Uint8Array(readFileSync(p));

function check(dir, { swaths, pols, bursts }) {
  const m = safeXml(B, 'manifest', read(join(dir, 'manifest.safe')));
  expect(m.polarisations.sort()).toEqual(pols);
  expect([...new Set(m.swaths)].sort()).toEqual(swaths);
  expect(m.footprint.length).toBeGreaterThanOrEqual(4);
  const meas = m.objects.filter((o) => o.kind === 'measurement');
  expect(meas.length).toBe(swaths.length * pols.length);
  const ann = readdirSync(join(dir, 'annotation')).filter((n) => n.endsWith('.xml'));
  const name = ann.sort()[0];
  const a = safeXml(B, 'annotation', read(join(dir, 'annotation', name)));
  expect(a.bursts.length).toBe(bursts);
  expect(a.grid.regular).toBe(true);
  // The model is exact at the grid points.
  const g = a.grid;
  const id = core.geolocModel({ xs: g.pixels.map((p) => p + 0.5), ys: g.lines.map((l) => l + 0.5), lat: g.lat, lon: g.lon }, 's1');
  const P = g.pixels.length;
  for (const k of [0, P + 3, g.lat.length - 1]) {
    const q = core.i2g(id, g.pixels[k % P] + 0.5, g.lines[Math.floor(k / P)] + 0.5, 0);
    expect(q.lat).toBeCloseTo(g.lat[k], 9);
    expect(q.lon).toBeCloseTo(g.lon[k], 9);
  }
  const cal = safeXml(B, 'calibration', read(join(dir, 'annotation', 'calibration', `calibration-${name}`)));
  const nz = safeXml(B, 'noise', read(join(dir, 'annotation', 'calibration', `noise-${name}`)));
  const L = s1Luts(cal, nz);
  // At a vector node, 1/A² of σ⁰ is the vector's own value; η is the range LUT × the azimuth LUT.
  const r = 1;
  const k = 2;
  const [s0] = L.sigma0(cal.pixels[k], cal.lines[r], 1, 1);
  expect(s0).toBeCloseTo(1 / cal.sigma[r * cal.pixels.length + k] ** 2, 12);
  const [x, y] = [nz.range[0].pixels[1], nz.range[0].line];
  const [n0] = L.noise(x, y, 1, 1);
  const blk = nz.azimuth.find((q) => y >= q.firstAzimuthLine && y <= q.lastAzimuthLine && x >= q.firstRangeSample && x <= q.lastRangeSample);
  let fa = 1;
  if (blk) {
    const i = Math.max(0, blk.lines.findIndex((l, j) => l <= y && (blk.lines[j + 1] ?? Infinity) > y));
    const t = blk.lines[i + 1] !== undefined ? (y - blk.lines[i]) / (blk.lines[i + 1] - blk.lines[i]) : 0;
    fa = (1 - t) * blk.values[i] + t * (blk.values[i + 1] ?? blk.values[i]);
  }
  expect(n0 / (nz.range[0].values[1] * fa)).toBeCloseTo(1, 5);
  return { m, a, cal };
}

describe.skipIf(!have)('Sentinel-1 SAFE', () => {
  it('FX-21 skeleton: one product, bursts, grid model, LUTs', () => {
    const { a } = check(FX, { swaths: ['IW1', 'IW2'], pols: ['VH', 'VV'], bursts: 2 });
    expect(a.bursts[0].validLines).toEqual([2, 18]);
  });
  it.skipIf(!existsSync(join(SAFE, 'manifest.safe')))('corpus IW SLC pair (2024-06-26): manifest, 9 bursts, grid, calibration and noise', () => {
    const { a, cal } = check(SAFE, { swaths: ['IW1', 'IW2', 'IW3'], pols: ['VH', 'VV'], bursts: 9 });
    expect([a.samples, a.lines]).toEqual([22060, 13509]);
    expect(a.grid.lines.length * a.grid.pixels.length).toBe(210);
    expect(cal.lines.length).toBe(30);
  }, 120000);
  it('refuses the wrong documents by name', () => {
    expect(() => safeXml(B, 'annotation', new TextEncoder().encode('<calibration/>'))).toThrow(/not a Sentinel-1 product annotation/);
    expect(() => safeXml(B, 'manifest', new TextEncoder().encode('<product/>'))).toThrow(/not a SAFE manifest/);
    expect(() => safeXml(B, 'noise', new TextEncoder().encode('<!DOCTYPE x><noise/>'))).toThrow(/DOCTYPE/);
  });
});
