// REG-024 (REQ-GAP-16), SCN-71: EGM2008 2.5′ heights interpolated Catmull-Rom bicubic in the
// shipped `geod` bundle, against GeographicLib GeoidEval's cubic interpolation of its own 2.5′
// grid at 1,000 random points. GeographicLib's PGM holds the grid in 3 mm steps and its cubic is a
// different (12-point least-squares) scheme, so the two agree to RMS 0.7 mm and a few millimetres
// at worst (3.6 mm over 20,000 points; 6.9 mm on Everest, where cubic schemes part most), against
// 2.8 cm for the bilinear PROJ arithmetic. Against GeographicLib's 1′ grid, which is closer to the
// model, ours is as good as GeographicLib's own 2.5′ cubic and far better than bilinear.
// Needs: the PROJ-data grid us_nga_egm08_25.tif (node build/packs.mjs --fetch), GeoidEval and
// GeographicLib's egm2008-2_5 grid (tests/tools/geoideval.mjs).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { unzipSync } from 'fflate';
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
  it('matches GeoidEval to RMS 1 mm at 1,000 random points, where bilinear is off by centimetres', () => {
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
      report.geoidEval25Vs1 = stats(ref, fine);
      expect(report.cubicVs1.max).toBeLessThan(report.bilinearVs1.max / 4);
      expect(report.cubicVs1.rms).toBeLessThan(1.1 * report.geoidEval25Vs1.rms);
    }
    console.log(`EGM2008 2.5′ vs GeoidEval: ${JSON.stringify(report)}`);
    expect(c.max).toBeLessThan(0.005);
    expect(c.rms).toBeLessThan(0.001);
    expect(b.max).toBeGreaterThan(0.01);
  });
});

// REG-024 step 2: the EGM2008 1′ pack (geoid-egm2008-1, built by build/packs.mjs from
// GeographicLib's egm2008-1 grid), read a tile at a time by geod, against GeoidEval on the same
// grid: within 1 mm at 1,000 random points (REG-024's bar; GeoidEval prints to 0.1 mm), and at
// tile edges and corners, the poles and ±180°. Catmull-Rom against GeographicLib's own cubic
// differs by up to 1.01 mm over 20,000 points, so the bound allows GeoidEval's 0.05 mm rounding.
// In the cell next to a pole GeographicLib switches to a polar stencil and we clamp rows as the
// whole-grid code does: up to 1.9 mm there, so that one cell row is held to 2 mm.
// Uses the built pack (dist/packs) when there is one, else cuts the tiles from the PGM.
const PACKS = resolve(process.env.TE_DIST ? join(process.env.TE_DIST, '..', 'packs') : 'dist/packs');
const PGM1 = join(resolve(process.env.GW_PACKS_CACHE ?? '.cache/packs-src'), 'egm2008-1.pgm');
const packFile = () => (existsSync(PACKS) ? readdirSync(PACKS).find((f) => /^geoid-egm2008-1-.*\.gwpack$/.test(f)) : null);
const ready1 = (!!packFile() || existsSync(PGM1)) && haveGeoidEval('egm2008-1') && (built || !!process.env.GEOD_WASM);

describe.skipIf(!ready1)('REG-024 SCN-71 EGM2008 1′ tiled pack against GeographicLib GeoidEval', () => {
  it('matches GeoidEval within 1 mm at 1,000 random points and at tile edges, poles and ±180°', async () => {
    let index;
    let bin;
    if (packFile()) {
      const files = unzipSync(readFileSync(join(PACKS, packFile())));
      index = JSON.parse(new TextDecoder().decode(files['tiles.json']));
      bin = files['tiles.bin'];
    } else {
      const { geoidTiles } = await import('../../build/packs.mjs');
      const t = geoidTiles(readFileSync(PGM1));
      index = JSON.parse(t.index);
      bin = t.bin;
    }
    expect(index).toMatchObject({ format: 'gw-geoid-tiles/1', rows: 10801, cols: 21600, cells: 300, offset: -108, scale: 0.003, tiles: 2592 });
    const g = new GeodBundle(new WebAssembly.Module(wasm()));
    const geoid = g.tiledGeoid(index, bin);
    const random = randomPoints(1000, 5);
    const edges = [];
    for (let k = 0; k < 300; k++) {
      const lat = -90 + 5 * ((k * 7) % 37) + [0, 1e-9, -1e-9, 1 / 60, -1 / 120][k % 5];
      const lon = -180 + 5 * ((k * 11) % 73) + [0, -1e-9, 1e-9, 1 / 120, -1 / 60][(k >> 2) % 5];
      edges.push([Math.max(-90, Math.min(90, lat)), lon]);
    }
    edges.push([90, 0], [-90, 0], [90, 179.99], [-90, -179.99], [89.999, -180], [-89.999, 180], [0, 180], [0, -180], [12.3, 359.99], [-45.5, -0.0001]);
    const polar = (p) => Math.abs(p[0]) > 90 - 1 / 60;
    for (const [name, pts, tol] of [['random', random, 0.00105], ['edges', edges.filter((p) => !polar(p)), 0.00105], ['pole cells', edges.filter(polar), 0.002]]) {
      const ours = pts.map(([lat, lon]) => geoid.value(lat, lon));
      const ref = geoidEval('egm2008-1', pts);
      const s = stats(ours, ref);
      console.log(`EGM2008 1′ tiled vs GeoidEval, ${name} (${pts.length}): max ${(s.max * 1000).toFixed(3)} mm, RMS ${(s.rms * 1000).toFixed(3)} mm`);
      expect(s.max).toBeLessThanOrEqual(tol);
    }
    geoid.close();
  });
});
