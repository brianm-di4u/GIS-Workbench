// REG-024 (REQ-GAP-16), SCN-71: EGM2008 2.5′ heights interpolated Catmull-Rom bicubic in the
// shipped `geod` bundle, against GeographicLib GeoidEval's cubic interpolation of its own 2.5′
// grid at 1,000 random points. GeographicLib's PGM holds the grid in 3 mm steps and its cubic is a
// different (12-point least-squares) scheme, so the two agree to a few millimetres, against
// 2.8 cm for the bilinear PROJ arithmetic. Against GeographicLib's 1′ grid (closer to the model)
// cubic 2.5′ is also the better of the two.
// Needs: the PROJ-data grid us_nga_egm08_25.tif (node build/packs.mjs --fetch), GeoidEval and
// GeographicLib's egm2008-2_5 grid (tests/tools/geoideval.mjs).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GeodBundle } from '../../app/src/wasm/geod.js';
import { built, blockBytes } from './wasm.js';
import { haveGeoidEval, geoidEval, randomPoints } from '../tools/geoideval.mjs';

const GRID = join(resolve(process.env.GW_PACKS_CACHE ?? '.cache/packs-src'), 'grids', 'us_nga_egm08_25.tif');
const wasm = () => (process.env.GEOD_WASM && existsSync(process.env.GEOD_WASM) ? readFileSync(process.env.GEOD_WASM) : built ? blockBytes('wasm-geod') : null);
const ready = existsSync(GRID) && haveGeoidEval('egm2008-2_5') && (built || !!process.env.GEOD_WASM);

const stats = (a, b) => {
  const d = a.map((x, i) => Math.abs(x - b[i]));
  return { max: Math.max(...d), rms: Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length) };
};

describe.skipIf(!ready)('REG-024 SCN-71 EGM2008 2.5′ cubic against GeographicLib GeoidEval', () => {
  it('matches GeoidEval within 3 mm at 1,000 random points, where bilinear is off by centimetres', () => {
    const g = new GeodBundle(new WebAssembly.Module(wasm()));
    const h = g.open(readFileSync(GRID), 'vertical', 'us_nga_egm08_25.tif', { cacheMb: 96 });
    const pts = randomPoints(1000);
    const cubic = pts.map(([lat, lon]) => g.value(h, lon, lat, 1, true));
    const bilinear = pts.map(([lat, lon]) => g.value(h, lon, lat, 1, false));
    // The batch route (vgridshift with the cubic flag) gives the same values.
    const batch = g.apply('vgridshift', [h], pts.map(([lat, lon]) => [lon, lat, 0]), { multiplier: 1, interpolation: 'cubic' }).pts.map((p) => p[2]);
    expect(stats(batch, cubic).max).toBe(0);
    const ref = geoidEval('egm2008-2_5', pts);
    const c = stats(cubic, ref);
    const b = stats(bilinear, ref);
    const report = { cubic: c, bilinear: b };
    if (haveGeoidEval('egm2008-1')) {
      const fine = geoidEval('egm2008-1', pts);
      report.cubicVs1 = stats(cubic, fine);
      report.bilinearVs1 = stats(bilinear, fine);
      expect(report.cubicVs1.max).toBeLessThan(report.bilinearVs1.max / 4);
    }
    console.log(`EGM2008 2.5′ vs GeoidEval: ${JSON.stringify(report)}`);
    expect(c.max).toBeLessThan(0.003);
    expect(c.rms).toBeLessThan(0.001);
    expect(b.max).toBeGreaterThan(0.01);
  });
});
