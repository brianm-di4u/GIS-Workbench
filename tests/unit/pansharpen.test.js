// REQ-GAP-14: the pan-sharpening plan (analysis/pansharpen.js) and the Rust tiles through the real
// `raster` WASM bundle: band-pass weights, eigen-decomposition, NNLS weights, geotransform affines,
// tile specs; a synthetic pair fused tile by tile equals one whole-image tile for every method, and
// the statistics and quality sums add up. The Vegas WorldView-3 differential against GDAL and the
// NumPy reference is build/campaign/s24-pansharpen.mjs (reports/campaign/s24-pansharpen.json).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as P from '../../app/src/analysis/pansharpen.js';
import { Raster } from '../../app/src/wasm/raster.js';

const wasm = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_raster.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasm && existsSync(wasm) && !!new WebAssembly.Module(readFileSync(wasm)).constructor && WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(wasm))).some((e) => e.name === 'gw_ps_fuse');

describe('pan-sharpening plan', () => {
  it('band-pass weights per sensor, none for Sentinel-2', () => {
    const w = P.sensorWeights('wv3', 8);
    expect(w.weights.map((x) => +x.toFixed(4))).toEqual([0, 0.2, 0.2333, 0.1333, 0.2, 0.1333, 0.1, 0]);
    expect(w.q4).toEqual([1, 2, 4, 6]);
    expect(P.sensorWeights('oli', 3).weights.map((x) => +x.toFixed(2))).toEqual([0.3, 0.6, 0.1]); // B4, B3, B2
    expect(P.sensorWeights('s2', 4)).toBeNull();
    for (const [k, nb] of [['ge1', 4], ['phr', 4], ['wv2', 8], ['oli', 7]]) expect(P.sensorWeights(k, nb).weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(P.detectSensor('<SATID>WV03</SATID>')).toBe('wv3');
    expect(P.detectSensor('IMG_PHR1B_PMS_001')).toBe('phr');
    expect(P.detectSensor('LC09_L1TP_044034')).toBe('oli');
  });

  it('Jacobi eigen-decomposition and non-negative weights', () => {
    const A = [[4, 1, 0.5], [1, 3, 0.2], [0.5, 0.2, 1]];
    const { values, vectors } = P.eigSym(A);
    for (let k = 0; k < 3; k++) {
      const v = vectors[k];
      const Av = A.map((r) => r.reduce((s, x, j) => s + x * v[j], 0));
      Av.forEach((x, i) => expect(x).toBeCloseTo(values[k] * v[i], 10));
    }
    expect(values[0]).toBeGreaterThan(values[1]);
    // A pan that is 0.6 m1 + 0.4 m3 of three bands: the fit finds it (m2 weight 0).
    const S = new Float64Array(P.statsLen(3));
    let s = 1;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 5000; i++) {
      const m = [100 + 50 * rnd(), 80 + 60 * rnd(), 120 + 40 * rnd()];
      const p = 0.6 * m[0] + 0.4 * m[2];
      S[0]++;
      m.forEach((v, k) => {
        S[1 + k] += v;
        m.forEach((u, j) => (S[4 + k * 3 + j] += v * u));
        S[15 + k] += v * p;
      });
      S[13] += p;
      S[14] += p * p;
    }
    expect(P.estimateWeights(S, 3).map((x) => +x.toFixed(6))).toEqual([0.6, 0, 0.4]);
    expect(P.simulatedPanFit(S, 3, [0.6, 0, 0.4])).toBeCloseTo(1, 9);
  });

  it('pan → MS affine from two geotransforms, and its ratio', () => {
    const a = P.affineFromGeotransforms([-115.3075176, 2.7e-6, 0, 36.2639592, 0, -2.7e-6], [-115.3075176, 1.08e-5, 0, 36.2639592, 0, -1.08e-5]);
    expect(a.map((x) => +x.toFixed(9))).toEqual([0, 0.25, 0, 0, 0, 0.25]);
    expect(P.ratioOf(a)).toBe(4);
  });
});

describe.skipIf(!haveWasm)('pan-sharpening tiles (raster WASM)', () => {
  const raster = haveWasm ? new Raster(new WebAssembly.Module(readFileSync(wasm))) : null;
  // A synthetic 4-band pair: smooth MS (r = 4), pan = mean MS + detail.
  const PW = 512;
  const MW = PW / 4;
  const nb = 4;
  const ms = new Float32Array(nb * MW * MW);
  for (let k = 0; k < nb; k++) for (let y = 0; y < MW; y++) for (let x = 0; x < MW; x++) ms[k * MW * MW + y * MW + x] = 300 + 100 * Math.sin(x / 7 + k) + 80 * Math.cos(y / 5) + 30 * k;
  const pan = new Float32Array(PW * PW);
  for (let y = 0; y < PW; y++) for (let x = 0; x < PW; x++) {
    let m = 0;
    for (let k = 0; k < nb; k++) m += ms[k * MW * MW + (y >> 2) * MW + (x >> 2)];
    pan[y * PW + x] = m / nb + 25 * Math.sin(x / 1.7) * Math.cos(y / 2.3);
  }
  const crop = (src, w, n, rc) => {
    const out = new Float32Array(rc.w * rc.h * n);
    for (let b = 0; b < n; b++) for (let y = 0; y < rc.h; y++) out.set(src.subarray(b * w * w + (rc.y0 + y) * w + rc.x0, b * w * w + (rc.y0 + y) * w + rc.x0 + rc.w), b * rc.w * rc.h + y * rc.w);
    return out;
  };
  const io = { readPan: async (rc) => crop(pan, PW, 1, rc), readMs: async (rc) => crop(ms, MW, nb, rc), stats: async (s, m, p, n) => raster.psStats(s, m, p, n), wald: async (s, m, p) => raster.psWald(s, m, p), fuse: async (s, m, p, n) => raster.psFuse(s, m, p, n), each: P.eachWith(1) };
  const job = (method) => ({ nb, r: 4, kernel: 'cubic', gnyq: 0.3, mw: MW, mh: MW, pw: PW, ph: PW, affine: [0, 0.25, 0, 0, 0, 0.25], type: 'f32', max: 0, roundMs: false, quality: true, q4: null, method });

  for (const method of P.METHODS) {
    it(`${method}: 128-px tiles equal one whole-image tile; Wald figures from tiled sums`, async () => {
      const j = job(method);
      const win = { x0: 0, y0: 0, w: PW, h: PW };
      const st = await P.statsPass(io, j, P.statsTiles(j, win, 32));
      const whole = await P.statsPass(io, j, P.statsTiles(j, win, 512));
      st.S1.forEach((v, k) => expect(Math.abs(v - whole.S1[k])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v))));
      const P1 = P.planParams(st.S1, nb, method, [0.25, 0.25, 0.25, 0.25], 4);
      const one = await P.fuseCore(io, j, P1, { x0: 0, y0: 0, w: PW, h: PW });
      const A = new Float32Array(one.px.buffer, one.px.byteOffset, PW * PW * nb);
      let worst = 0;
      for (let ty = 0; ty < PW; ty += 128)
        for (let tx = 0; tx < PW; tx += 128) {
          const t = await P.fuseCore(io, j, P1, { x0: tx, y0: ty, w: 128, h: 128 });
          const B = new Float32Array(t.px.buffer, t.px.byteOffset, 128 * 128 * nb);
          for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let b = 0; b < nb; b++) worst = Math.max(worst, Math.abs(B[(y * 128 + x) * nb + b] - A[((ty + y) * PW + tx + x) * nb + b]));
        }
      expect(worst).toBeLessThan(method === 'ehlers' ? 3 : 1e-3); // Ehlers: each tile's FFT block is mirror-extended
      const q = P.qualityOf(one.q, nb, 4);
      expect(q.ergas).toBeGreaterThan(0);
      expect(q.q).toBeGreaterThan(0.5);
      const P2 = P.planParams(st.S2, nb, method, [0.25, 0.25, 0.25, 0.25], 4);
      const w = P.qualityOf(await P.waldPass(io, j, P2, P.statsTiles(j, win, 32), st.lows), nb, 4);
      expect(w.blocks).toBe(16);
      expect(w.sam).toBeLessThan(10);
    });
  }
});
