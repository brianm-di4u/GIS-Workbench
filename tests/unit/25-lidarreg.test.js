// 2.5 group lidarreg (REQ-GAP-46): the survey reader, the joint adjustment job the app builds
// (features/lidarreg.js jointJob) solved by the `photo` WASM bundle against the synthetic truth,
// the registration export on a synthetic scene, and malformed jobs refused, not trapped.
// The WASM parts are skipped when the bundle is absent (build it, or set CARGO_TARGET_DIR).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRows, parseSurvey, jointJob } from '../../app/src/features/lidarreg.js';
import { Photo } from '../../app/src/wasm/photo.js';

const wasmPath = (() => {
  try {
    const t = process.env.CARGO_TARGET_DIR ?? JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_photo.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);

describe('REQ-GAP-46 surveyed points on the cloud', () => {
  it('reads comma, semicolon and tab files with quotes', () => {
    expect(parseRows('id,lat,lon\n"A, 1",34.5,-116.5\n# note\n')).toEqual([['id', 'lat', 'lon'], ['A, 1', '34.5', '-116.5']]);
    expect(parseRows('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseRows('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('takes id, lat, lon, height, role and σ, and refuses files without them', () => {
    const s = parseSurvey('PID,Latitude,Longitude,HAE,Role,Sigma\nKK1,39.8,-105.2,1700.5,control,0.02\nKK2,39.81,-105.21,1710,checkpoint,\n,39.82,-105.22,1720.2,,\nbad,x,y,z,,');
    expect(s).toEqual([
      { id: 'KK1', lat: 39.8, lon: -105.2, h: 1700.5, check: false, sigma: 0.02 },
      { id: 'KK2', lat: 39.81, lon: -105.21, h: 1710, check: true, sigma: 0.05 },
      { id: 'S3', lat: 39.82, lon: -105.22, h: 1720.2, check: false, sigma: 0.05 },
    ]);
    const code = (f) => {
      try {
        f();
      } catch (e) {
        return e.code;
      }
      return null;
    };
    expect(code(() => parseSurvey('id,x,y\n1,2,3'))).toBe('E_LREG_SURVEY');
    expect(code(() => parseSurvey('lat,lon,h'))).toBe('E_LREG_SURVEY');
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-46 the joint adjustment and the registration in the photo bundle', () => {
  const B = haveWasm ? new Photo(new WebAssembly.Module(readFileSync(wasmPath))) : null;
  // A geographic ortho (EPSG:4326) of 0.5 m pixels: x = (lon − lon0)/dlon, y = (lat0 − lat)/dlat.
  const lat0 = 34.51;
  const lon0 = -116.51;
  const dlat = 0.5 / 110940;
  const dlon = 0.5 / 91742;
  const rec = { type: 4, rec: [4326, lon0, dlon, 0, lat0, 0, -dlat] };
  const px = (lat, lon) => ({ x: (lon - lon0) / dlon, y: (lat0 - lat) / dlat });

  it('recovers the image shift and the cloud vertical shift; held-out and surveyed checkpoints improve', () => {
    // Truth: the image shows ground g at gt⁻¹(g) + (6, −3) px; the cloud is 0.4 m low.
    let s = 11;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const points = [];
    const obs = [];
    for (let k = 0; k < 40; k++) {
      const lat = lat0 - (50 + 900 * r()) * dlat;
      const lon = lon0 + (50 + 900 * r()) * dlon;
      const h = 1500 + 30 * r();
      const p = px(lat, lon);
      points.push({ kind: k % 5 === 4 ? 4 : 3, lat, lon, h: h - 0.4 });
      obs.push([0, points.length - 1, p.x + 6, p.y - 3, 0.5]);
    }
    const cloud = [0, 1, 2, 3, 4].map((k) => ({ lat: lat0 - (100 + 150 * k) * dlat, lon: lon0 + (120 + 140 * k) * dlon, h: 1510 + k, z: 1510 + k - 0.4, gE: 0.02 * k, gN: -0.03, sigma: 0.03, check: k === 4 }));
    const job = jointJob({ rec, centrePx: { x: 500, y: 500 }, half: [500, 500], points, obs, datum: 3, datumSigma: [1, 1, 1], centre: { lat: lat0 - 500 * dlat, lon: lon0 + 500 * dlon, h: 1500 }, cloud });
    const sol = B.adjust(job);
    expect(sol.converged).toBe(true);
    // The survey sees dU − slope·(dE, dN) and the priors pull every parameter to zero, so the split
    // moves by millimetres (dN ≈ 0.012 m with the survey's constant north slope of −0.03).
    expect(Math.abs(sol.images[0].c[3] - 6)).toBeLessThan(0.05); // Δx
    expect(Math.abs(sol.images[0].c[0] + 3)).toBeLessThan(0.05); // Δy
    expect(Math.abs(sol.datum[2] - 0.4)).toBeLessThan(0.002);
    expect(sol.datumCov).toHaveLength(9);
    expect(sol.lidarBefore.n).toBe(8);
    expect(sol.lidarBefore.rmseR).toBeGreaterThan(3);
    expect(sol.lidarAfter.rmseR).toBeLessThan(0.01);
    expect(sol.cloudBefore.rmse[2]).toBeCloseTo(0.4, 6);
    expect(sol.cloudAfter.rmse[2]).toBeLessThan(0.005);
    // The GPM-style propagation of the shift's covariance: the shift cancels between two points.
    const g = B.gpm(Float64Array.from([3, lat0, lon0, 1500, ...sol.datumCov, 2, lat0, lon0, 1500, 0, 0, 0, lat0 - 1e-3, lon0, 1500, 0, 0, 0, 0, 0, 0, 1]));
    expect(g.ce90[0]).toBeGreaterThan(0);
    expect(g.relCe90[0]).toBeLessThan(1e-6);
  });

  it('matches a synthetic scene and refuses malformed jobs instead of trapping', () => {
    // 128 × 128 posts of 0.5 m with texture; the ortho is 3 m east and 2 m north of the truth.
    const w = 128;
    // The frame scaled so that one image pixel is 0.5 m: e = (x − 40)·0.5, n = (40 − y)·0.5.
    const kx = 0.5 / dlon;
    const ky = 0.5 / dlat;
    // Value noise: random lattice values (hashed integer corners) interpolated, two octaves.
    const hash = (i, j) => {
      let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const noise = (x, y) => {
      const i = Math.floor(x);
      const j = Math.floor(y);
      const u = x - i;
      const v = y - j;
      return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
    };
    const tex = (e, n) => noise(e / 2.5, n / 2.5) + 0.5 * noise(e / 1.1 + 50, n / 1.1 + 50);
    const dsm = new Float32Array(w * w).fill(1500);
    const inten = new Float32Array(w * w);
    for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) inten[j * w + i] = tex(i * 0.5, -j * 0.5);
    const cw = 200;
    const chip = new Float32Array(cw * cw);
    // Chip pixel (i, j) centre: image (i + 0.5, j + 0.5); its ground through the model, minus the error.
    for (let j = 0; j < cw; j++)
      for (let i = 0; i < cw; i++) {
        // The model puts this pixel at (e, n); it shows the ground 3 m west and 2 m south of that.
        const e = ((i + 0.5) - 40) * 0.5 - 3;
        const n = (40 - (j + 0.5)) * 0.5 - 2;
        chip[j * cw + i] = tex(e, n);
      }
    // The frame origin at image corner (40, 40): post (i, j) is image (40 + i, 40 + j).
    const prm = Float64Array.from([4, 7, ...rec.rec, lat0 - 40 * dlat, lon0 + 40 * dlon, kx, ky, 0, 0, 0.5, w, w, cw, cw, 0, 0, 1, 0, NaN, 45, 32, 32, 10, 0.05, 1.3, 0.3, 1.5, 0]);
    const m = B.lidarRegister(prm, dsm, inten, chip);
    const inl = m.matches.filter((x) => x[11]);
    expect(inl.length).toBeGreaterThan(5);
    const de = inl.reduce((a, x) => a + x[3], 0) / inl.length;
    const dn = inl.reduce((a, x) => a + x[4], 0) / inl.length;
    expect(Math.abs(de - 3)).toBeLessThan(0.15);
    expect(Math.abs(dn - 2)).toBeLessThan(0.15);
    // Malformed: truncated, bad datum count, grids that do not match.
    expect(() => B.adjust(Float64Array.from([3, 1, 0, 0, 1, 3, 0, 4, 0]))).toThrow();
    expect(() => B.lidarRegister(prm.slice(0, 20), dsm, inten, chip)).toThrow();
    expect(() => B.lidarRegister(prm, dsm.slice(1), inten, chip)).toThrow();
    expect(() => B.gpm(Float64Array.from([4]))).toThrow();
    // Hillshade only, with no intensity (an empty array): a flat DSM is refused by name, not by a trap.
    const prmH = prm.slice();
    prmH[2 + 7 + 14] = 1;
    expect(() => B.lidarRegister(prmH, dsm, new Float32Array(0), chip)).toThrow(/hillshade/);
  });
});
