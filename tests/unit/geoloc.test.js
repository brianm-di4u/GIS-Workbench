// Swath geolocation arrays (REQ-FMT-54): the HDF5 reader's node extraction (workers/decode/hdf5.js
// geolocFrom) and the core bundle's geolocation-array model (gw-sensor geoloc) on the FX-21 swaths
// (analytic positions, antimeridian, subsampled arrays, a fill node) and on the T&E corpus PACE OCI L2
// and HICO L1B swaths: image → ground against the arrays, ground → image round trips.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import h5wasm from 'h5wasm/node';
import { Core } from '../../app/src/wasm/core.js';
import { geolocFrom } from '../../app/src/workers/decode/hdf5.js';
import { swathLatLon, generate } from '../../build/fixtures/fx21/sar.mjs';

const DIR = resolve('fixtures/fx21/sar');
if (!existsSync(join(DIR, 'swath-vegas.nc'))) await generate(DIR);
const T = JSON.parse(readFileSync(join(DIR, 'sar_truth.json'), 'utf8')).swath;
const wasm = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_core.wasm');
  } catch {
    return null;
  }
})();
const have = !!wasm && existsSync(wasm);
const core = have ? new Core(new WebAssembly.Module(readFileSync(wasm))) : null;
const TE = process.env.TE_CORPUS ?? resolve('..', 'TE-corpus');
await h5wasm.ready;
const open = (p) => new h5wasm.File(p, 'r');
const deg = (a, b) => ((a - b + 540) % 360) - 180;

describe.skipIf(!have)('geolocation-array sensor model', () => {
  for (const [name, c] of Object.entries(T.cases)) {
    it(`FX-21 ${name}`, () => {
      const f = open(join(DIR, name));
      const g = geolocFrom(f.get('navigation_data/latitude'), f.get('navigation_data/longitude'), T.W, T.H);
      f.close();
      expect(g.step).toBe(1);
      const id = core.geolocModel(g, name);
      expect(core.modelInfo(id).is3d).toBe(false);
      for (const p of c.probes) {
        const q = core.i2g(id, p.x, p.y, 0);
        // Bilinear between nodes of this curved swath: metres, not pixels (a pixel is ~1 km).
        expect(Math.abs(q.lat - p.ll[0]) * 111e3, `${name} lat at ${p.x},${p.y}`).toBeLessThan(c.sub > 1 ? 60 : 1);
        expect(Math.abs(deg(q.lon, p.ll[1])) * 90e3, `${name} lon at ${p.x},${p.y}`).toBeLessThan(c.sub > 1 ? 60 : 1);
        const { x, y } = core.g2i(id, p.ll[0], p.ll[1], 0);
        expect(Math.abs(x - p.x), `${name} x`).toBeLessThan(c.sub > 1 ? 0.05 : 1e-3);
        expect(Math.abs(y - p.y), `${name} y`).toBeLessThan(c.sub > 1 ? 0.05 : 1e-3);
      }
      // The fill node's cells have no position; a pixel elsewhere does.
      const fillAt = c.sub > 1 ? [(2 + 0.5) * c.sub, (3 + 0.5) * c.sub] : [2.5, 3.5];
      const none = (() => {
        try {
          return core.i2g(id, fillAt[0] + 0.1, fillAt[1] + 0.1, 0).lat;
        } catch {
          return NaN;
        }
      })();
      expect(none).toBeNaN();
      if (/antimeridian/.test(name)) {
        const a = core.i2g(id, 5.5, 5.5, 0);
        const b = core.i2g(id, 90.5, 5.5, 0);
        expect(a.lon).toBeGreaterThan(179);
        expect(b.lon).toBeLessThan(-179);
      }
    });
  }

  for (const [label, path, lat, lon] of [
    ['PACE OCI L2', join(TE, 'hsi-pace-oci-cuprite-20240727', 'PACE_OCI.20240727T194455.L2.OC_AOP.V3_2.nc'), 'navigation_data/latitude', 'navigation_data/longitude'],
    ['HICO L1B', join(TE, 'hsi-hico-l1b-iss-20110107', 'H2011007210825.L1B_ISS.nc'), 'navigation/latitudes', 'navigation/longitudes'],
  ]) {
    it.skipIf(!existsSync(path))(`corpus ${label}: pixel positions against the arrays`, () => {
      const f = open(path);
      const la = f.get(lat);
      const lo = f.get(lon);
      const [H, W] = la.shape;
      const g = geolocFrom(la, lo, W, H);
      const A = la.value;
      const O = lo.value;
      f.close();
      const id = core.geolocModel(g, label);
      let worst = 0;
      let worstPx = 0;
      let n = 0;
      for (let r = 1; r < H; r += 37)
        for (let c = 1; c < W; c += 23) {
          const k = r * W + c;
          if (!(Math.abs(A[k]) <= 90)) continue;
          const q = core.i2g(id, c + 0.5, r + 0.5, 0);
          const d = Math.hypot((q.lat - A[k]) * 111e3, deg(q.lon, O[k]) * 111e3 * Math.cos((A[k] * Math.PI) / 180));
          worst = Math.max(worst, d);
          const { x, y } = core.g2i(id, A[k], O[k], 0);
          worstPx = Math.max(worstPx, Math.hypot(x - c - 0.5, y - r - 0.5));
          n++;
        }
      expect(n).toBeGreaterThan(100);
      // Full-resolution nodes (step 1 up to 2048 per axis): the arrays' own positions at pixel centres,
      // and every array position maps back to its pixel centre. (With every 3rd node, PACE's terrain-corrected
      // positions were off by up to 1.4 km at the swath edge: hence full resolution.)
      expect(g.step).toBe(1);
      expect(worst, `${label} worst ${worst.toFixed(3)} m`).toBeLessThan(0.01);
      expect(worstPx, `${label} worst ${worstPx.toFixed(4)} px`).toBeLessThan(0.01);
    }, 120000);
  }
});
