// REQ-GAP-82 automatic endmembers: the `spectral` WASM bundle (crates/gw-spectral endmember.rs)
// through its JS wrapper.
// * a synthetic scene mixed from six USGS splib07 minerals of the embedded starter library, with
//   smooth abundances, a pure patch of each and noise: VCA finds every mineral, PPI ranks the pure
//   patches purest, and unmixing with the endmembers found gives back the abundances;
// * a differential test against the independent Python reference (tests/tools/endmember_ref.py:
//   the published VCA, SVD subspace and numpy's generator), run when the gw-te environment is
//   present: both find the same spectra (compared by spectral angle, not pixel);
// * malformed requests refused. Skipped when the bundle is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SpectralBundle } from '../../app/src/wasm/spectral.js';

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
const PY = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe';
const havePy = existsSync(PY);
// numpy's DLLs load from the environment's Library\bin, which only an activated environment has on PATH.
const PYENV = { ...process.env, PATH: [join(PY, '..'), join(PY, '..', 'Library', 'bin'), process.env.PATH].join(';') };

const STARTER = JSON.parse(readFileSync(resolve('app/src/data/splib07-starter.json'), 'utf8'));
const MINERALS = ['Alunite GDS84', 'Buddingtonite GDS85', 'Calcite WS272 BECKa', 'Kaolinite CM9 BECKb', 'Muscovite GDS107', 'Hematite GDS27'];

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const angle = (a, b) => {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return Math.acos(Math.min(1, Math.max(-1, d / Math.sqrt(x * y))));
};
/** For each truth spectrum, the smallest angle to any found spectrum. */
const bestAngles = (truth, found) => truth.map((t) => Math.min(...found.map((f) => angle(t, f))));

// Bands with a value in every chosen mineral (the starter has nulls in deep water bands).
const ends0 = MINERALS.map((n) => STARTER.spectra.find((s) => s.name.startsWith(n)));
const keepBands = STARTER.wavelengths.map((_, b) => b).filter((b) => ends0.every((s) => s.values[b] !== null));
const ENDS = ends0.map((s) => keepBands.map((b) => s.values[b]));
const NB = keepBands.length;

/** The scene: abundances vary smoothly (as land cover does: MNF takes noise from neighbouring pixels). */
function scene(w = 90, h = 70, noise = 0.003) {
  const m = ENDS.length;
  const rnd = lcg(7);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const pure = [[4, 4], [40, 6], [80, 10], [10, 55], [50, 40], [75, 60]];
  const patch = (x, y) => pure.findIndex(([px, py]) => x >= px && x < px + 3 && y >= py && y < py + 3);
  const v = new Float32Array(w * h * NB);
  const ab = new Float64Array(w * h * m);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let a = Array.from({ length: m }, (_, i) => Math.exp(1.4 * Math.sin((i + 1) * 2.3 * (x / w) + i) * Math.cos((m - i) * 1.9 * (y / h) + 0.5 * i)));
      const e = patch(x, y);
      if (e >= 0) a = a.map((_, i) => (i === e ? 1 : 0));
      const s = a.reduce((q, r) => q + r, 0);
      for (let i = 0; i < m; i++) ab[p * m + i] = a[i] / s;
      for (let b = 0; b < NB; b++) {
        let val = 0;
        for (let i = 0; i < m; i++) val += ab[p * m + i] * ENDS[i][b];
        v[p * NB + b] = val + noise * gauss();
      }
    }
  return { v, w, h, ab, pure, patch };
}

describe.skipIf(!haveWasm)('automatic endmembers (REQ-GAP-82)', () => {
  const S = haveWasm ? scene() : null;

  it('finds every mineral of a mixed scene, and PPI ranks the pure patches purest', () => {
    const r = B.endmembers(S.v, S.w, S.h, NB, { m: ENDS.length, skewers: 3000, seed: 1, step: 1 });
    expect(r.pixels).toHaveLength(ENDS.length);
    expect(r.components).toBe(10);
    const found = r.pixels.map((p) => Array.from(S.v.subarray(p * NB, (p + 1) * NB)));
    // The returned spectra are the cube's own values at those pixels.
    expect(Array.from(r.spectra)).toEqual(found.flat());
    const best = bestAngles(ENDS, found);
    console.log('VCA best angle per mineral (rad)', best.map((a) => a.toFixed(4)).join(' '));
    for (const a of best) expect(a).toBeLessThan(0.05);
    // PPI: the purest pixels lie in the pure patches, every patch among them.
    const order = Array.from(r.ppi.keys()).sort((a, b) => r.ppi[b] - r.ppi[a]);
    const hit = new Set(order.slice(0, 24).map((p) => S.patch(p % S.w, Math.floor(p / S.w))).filter((e) => e >= 0));
    expect(hit.size).toBe(ENDS.length);
    // A seed gives the same endmembers.
    expect(B.endmembers(S.v, S.w, S.h, NB, { m: ENDS.length, skewers: 0, seed: 1, step: 1 }).pixels).toEqual(r.pixels);
  });

  it('unmixes the scene with the endmembers found back to its abundances', () => {
    const r = B.endmembers(S.v, S.w, S.h, NB, { m: ENDS.length, skewers: 0, seed: 1, step: 1 });
    const found = r.pixels.map((p) => Array.from(S.v.subarray(p * NB, (p + 1) * NB)));
    // Each found endmember stands for the mineral nearest to it.
    const which = found.map((f) => ENDS.map((e) => angle(e, f)).reduce((bi, a, i, arr) => (a < arr[bi] ? i : bi), 0));
    expect(new Set(which).size).toBe(ENDS.length);
    const u = B.transform('unmix', S.v, S.w, S.h, NB, { endmembers: found });
    const m = ENDS.length;
    let se = 0;
    let n = 0;
    for (let p = 0; p < S.w * S.h; p++)
      for (let i = 0; i < m; i++) {
        se += (u.cube[p * (m + 1) + i] - S.ab[p * m + which[i]]) ** 2;
        n++;
      }
    const rmse = Math.sqrt(se / n);
    console.log('abundance RMSE', rmse.toFixed(4));
    expect(rmse).toBeLessThan(0.03);
  });

  it.skipIf(!havePy)('finds the same spectra as the independent Python reference', () => {
    const dir = mkdtempSync(join(tmpdir(), 'emref-'));
    writeFileSync(join(dir, 'cube.f32'), Buffer.from(S.v.buffer));
    writeFileSync(join(dir, 'in.json'), JSON.stringify({ cube: join(dir, 'cube.f32'), w: S.w, h: S.h, nb: NB, m: ENDS.length, seed: 3 }));
    execFileSync(PY, ['-I', resolve('tests/tools/endmember_ref.py'), join(dir, 'in.json'), join(dir, 'out.json')], { timeout: 600000, env: PYENV });
    const ref = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
    const r = B.endmembers(S.v, S.w, S.h, NB, { m: ENDS.length, skewers: 0, seed: 1, step: 1 });
    const ours = r.pixels.map((p) => Array.from(S.v.subarray(p * NB, (p + 1) * NB)));
    const refBest = bestAngles(ENDS, ref.spectra);
    const cross = bestAngles(ref.spectra, ours);
    console.log('reference', ref.branch, `SNR ${ref.snr_db.toFixed(1)} dB; best angle per mineral`, refBest.map((a) => a.toFixed(4)).join(' '), '; reference to ours', cross.map((a) => a.toFixed(4)).join(' '));
    for (const a of refBest) expect(a).toBeLessThan(0.05);
    for (const a of cross) expect(a).toBeLessThan(0.05);
  });

  it('refuses impossible requests', () => {
    expect(() => B.endmembers(S.v, S.w, S.h, NB, { m: 1 })).toThrow(/2 to 64/);
    expect(() => B.endmembers(S.v, S.w, S.h, NB, { m: 65 })).toThrow(/2 to 64/);
    expect(() => B.endmembers(S.v, S.w, S.h, NB, { m: 4, skewers: -1 })).toThrow(/skewers/);
    expect(() => B.endmembers(new Float32Array(3 * 4).fill(NaN), 2, 2, 3, { m: 3 })).toThrow(/too few valid pixels/);
  });
});
