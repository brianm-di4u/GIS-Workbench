// REQ-GAP-40 (GR-14): the polarimetric decompositions of the `sar` WASM bundle (crates/gw-sar
// polsar.rs) against an independent numpy reference (tests/tools/polsar_ref.py) run in the gw-te
// environment. PolSARpro and SNAP are not in gw-te, so they are not the oracle here (see
// docs/validation/2.4/terrsar.md). Synthetic quad-pol scenes with surface, double-bounce and
// volume regions under complex Gaussian speckle; every input kind, filter and product. Skipped
// when the bundle or gw-te is absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SarBundle } from '../../app/src/wasm/sar.js';

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_sar.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const GWTE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
const haveTe = existsSync(`${GWTE}/python.exe`);
const env = { ...process.env, PATH: `${GWTE}/Library/bin;${GWTE};${GWTE}/Scripts;${process.env.PATH}` };
const REF = resolve('tests/tools/polsar_ref.py');

/** xorshift + Box–Muller, deterministic. */
function rng(seed) {
  let s = BigInt(seed) | 1n;
  const M = (1n << 64n) - 1n;
  const u = () => {
    s ^= (s << 13n) & M;
    s ^= s >> 7n;
    s ^= (s << 17n) & M;
    return Number(s >> 11n) / 2 ** 53;
  };
  return () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
}

/** A w × h quad-pol scene (HH, HV, VH, VV interleaved complex): surface, dihedral, volume, oriented. */
export function scene(w, h, seed = 1) {
  const g = rng(seed);
  const n = w * h;
  const ch = Array.from({ length: 4 }, () => new Float32Array(2 * n));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const reg = x < w / 4 ? 0 : x < w / 2 ? 1 : x < (3 * w) / 4 ? 2 : 3;
      const c = () => [g(), g()];
      let hh;
      let hv;
      let vv;
      if (reg === 0) {
        // Bragg surface: HH and VV correlated in phase, VV stronger, weak HV.
        const a = c();
        hh = [0.8 * a[0] + 0.1 * g(), 0.8 * a[1] + 0.1 * g()];
        vv = [1.2 * a[0] + 0.1 * g(), 1.2 * a[1] + 0.1 * g()];
        hv = c().map((v) => 0.08 * v);
      } else if (reg === 1) {
        // Dihedral: HH and VV in anti-phase.
        const a = c();
        hh = [1.5 * a[0] + 0.2 * g(), 1.5 * a[1] + 0.2 * g()];
        vv = [-1.1 * a[0] + 0.2 * g(), -1.1 * a[1] + 0.2 * g()];
        hv = c().map((v) => 0.15 * v);
      } else if (reg === 2) {
        // Random volume: independent channels, HV about a third of the co-pol power.
        hh = c();
        vv = c();
        hv = c().map((v) => 0.58 * v);
      } else {
        // Oriented dihedral plus helix-like cross terms.
        const a = c();
        const b = c();
        hh = [a[0] + 0.3 * b[0], a[1] + 0.3 * b[1]];
        vv = [-0.6 * a[0] + 0.3 * b[0], -0.6 * a[1] + 0.3 * b[1]];
        hv = [0.5 * a[0] - 0.4 * b[1], 0.5 * a[1] + 0.4 * b[0]];
      }
      const vh = [hv[0] + 0.02 * g(), hv[1] + 0.02 * g()];
      for (const [k, v] of [hh, hv, vh, vv].entries()) {
        ch[k][2 * i] = v[0];
        ch[k][2 * i + 1] = v[1];
      }
    }
  return ch;
}

const cat = (arrs) => {
  const o = new Float32Array(arrs.reduce((s, a) => s + a.length, 0));
  let k = 0;
  for (const a of arrs) {
    o.set(a, k);
    k += a.length;
  }
  return o;
};

/** Run the numpy reference on the same input. */
function reference(dir, tag, data, w, h, opts) {
  const bin = join(dir, `${tag}.in`);
  writeFileSync(bin, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  const job = join(dir, `${tag}.json`);
  writeFileSync(job, JSON.stringify({ w, h, data: bin, ...opts }));
  const out = join(dir, `${tag}.out`);
  execFileSync(`${GWTE}/python.exe`, ['-I', REF, job, out], { env, timeout: 600000 });
  const meta = JSON.parse(readFileSync(`${out}.json`, 'utf8'));
  const f = new Float32Array(new Uint8Array(readFileSync(out)).buffer);
  const n = w * h;
  let k = 0;
  return { wishart: meta.wishart, products: meta.products.map((p) => ({ name: p.name, planes: Object.fromEntries(p.planes.map((nm) => [nm, f.subarray(n * k, n * ++k)])) })) };
}

/** Per-plane agreement: share of pixels within tol (abs, or relative to the span), max error. */
function compare(a, b, tolOf) {
  const out = {};
  for (const pa of a.products) {
    const pb = b.products.find((p) => p.name === pa.name);
    expect(pb, pa.name).toBeTruthy();
    for (const [nm, va] of Object.entries(pa.planes)) {
      const vb = pb.planes[nm];
      let ok = 0;
      let n = 0;
      let max = 0;
      const errs = [];
      for (let i = 0; i < va.length; i++) {
        if (!Number.isFinite(vb[i]) && !Number.isFinite(va[i])) continue;
        n++;
        const e = Math.abs(va[i] - vb[i]);
        errs.push(e);
        if (e <= tolOf(pa.name, nm, i)) ok++;
        if (e > max) max = e;
      }
      errs.sort((x, y) => x - y);
      out[`${pa.name}/${nm}`] = { share: ok / n, max, p99: errs[Math.floor(0.99 * (errs.length - 1))] ?? 0, n };
    }
  }
  return out;
}

// Each case starts the gw-te Python: slow under a loaded machine.
describe.skipIf(!haveWasm || !haveTe)('REQ-GAP-40 polarimetric decompositions: sar bundle vs numpy reference', { timeout: 120000 }, () => {
  const B = haveWasm ? new SarBundle(new WebAssembly.Module(readFileSync(wasmPath))) : null;
  const dir = mkdtempSync(join(tmpdir(), 'polsar24-'));
  const [w, h] = [64, 40];
  const ch = scene(w, h, 7);
  const quad3 = cat([ch[0], ch[1], ch[3]]);
  const quad4 = cat(ch);
  const all3 = ['t3', 'c3', 'span', 'freeman', 'yamaguchi', 'haalpha', 'wishart'];
  const summary = {};

  const cases = [
    ['quad boxcar 5', quad3, { input: 'quad', filter: 'boxcar', win: 5, products: all3, iterations: 10 }],
    ['quad+VH boxcar 7 Y4R', quad4, { input: 'quad', hasVH: true, filter: 'boxcar', win: 7, products: all3, rotate: true, iterations: 10 }],
    ['quad refined Lee H/A/alpha Wishart', quad3, { input: 'quad', filter: 'refinedlee', looks: 1, products: all3, useA: true, iterations: 10 }],
    ['dual VV+VH boxcar 7', cat([ch[3], ch[2]]), { input: 'dual', filter: 'boxcar', win: 7, products: ['c2', 'span', 'halpha2'] }],
    ['compact CTLR boxcar 7', quad3, { input: 'compact', filter: 'boxcar', win: 7, products: ['c2', 'span', 'halpha2'] }],
  ];
  for (const [tag, data, opts] of cases)
    it(tag, () => {
      const a = B.polsar(data, w, h, opts);
      const b = reference(dir, tag.replace(/\W+/g, '_'), data, w, h, opts);
      // The span of the filtered matrix sets the scale of the power tolerances.
      const spanA = a.products.find((p) => p.name === 'Span')?.planes.Span;
      const tol = (name, plane, i) => {
        if (/alpha/.test(name) && !/Wishart/.test(name)) return plane === 'alpha' ? 0.01 : plane === 'H' ? 1e-4 : 1e-3;
        if (/Wishart/.test(name)) return 0;
        return 1e-4 * Math.max(1e-6, spanA?.[i] ?? 1);
      };
      const r = compare(a, b, tol);
      summary[tag] = r;
      for (const [k, v] of Object.entries(r)) {
        // Wishart labels: at least 99 % the same; every other plane: 99.5 % within tolerance.
        expect(v.share, `${tag} ${k} ${JSON.stringify(v)}`).toBeGreaterThanOrEqual(/Wishart/.test(k) ? 0.99 : 0.995);
      }
      if (opts.products.includes('wishart')) expect(a.wishart.iterations).toBe(b.wishart.iterations);
    });

  it('C3 planes input (UAVSAR MLC/GRD form) equals the quad-pol path', () => {
    const viaQuad = B.polsar(quad3, w, h, { input: 'quad', filter: 'boxcar', win: 5, products: ['c3', 'haalpha', 'freeman'] });
    const c3 = viaQuad.products[0].planes;
    const data = cat(['C11', 'C22', 'C33', 'C12_real', 'C12_imag', 'C13_real', 'C13_imag', 'C23_real', 'C23_imag'].map((k) => c3[k]));
    const a = B.polsar(data, w, h, { input: 'c3', products: ['haalpha', 'freeman'] });
    const b = reference(dir, 'c3', data, w, h, { input: 'c3', products: ['haalpha', 'freeman'] });
    const r = compare(a, b, (name, plane) => (/alpha/.test(name) ? (plane === 'alpha' ? 0.01 : plane === 'H' ? 1e-4 : 1e-3) : 1e-4));
    summary.c3 = r;
    for (const v of Object.values(r)) expect(v.share).toBeGreaterThanOrEqual(0.995);
    // And the decomposition of the round-tripped C3 matches the direct one.
    const al1 = viaQuad.products.find((p) => p.name === 'H/A/alpha').planes.alpha;
    const al2 = a.products.find((p) => p.name === 'H/A/alpha').planes.alpha;
    let d = 0;
    for (let i = 0; i < al1.length; i++) if (Number.isFinite(al1[i])) d = Math.max(d, Math.abs(al1[i] - al2[i]));
    expect(d).toBeLessThan(0.05);
  });

  it('mechanisms land where they should (sanity on the synthetic regions)', () => {
    const a = B.polsar(quad3, w, h, { input: 'quad', filter: 'boxcar', win: 7, products: ['freeman', 'haalpha'] });
    const [fd, ha] = ['Freeman-Durden', 'H/A/alpha'].map((nm) => a.products.find((p) => p.name === nm));
    const mean = (arr, x0, x1) => {
      let s = 0;
      let c = 0;
      for (let y = 5; y < h - 5; y++)
        for (let x = x0 + 4; x < x1 - 4; x++) {
          s += arr[y * w + x];
          c++;
        }
      return s / c;
    };
    const q = w / 4;
    // Surface region: Ps dominant, low α; dihedral: Pd dominant, α > 45°; volume: Pv dominant, high H.
    expect(mean(fd.planes.Ps, 0, q)).toBeGreaterThan(2 * mean(fd.planes.Pd, 0, q));
    expect(mean(ha.planes.alpha, 0, q)).toBeLessThan(25);
    expect(mean(fd.planes.Pd, q, 2 * q)).toBeGreaterThan(2 * mean(fd.planes.Ps, q, 2 * q));
    expect(mean(ha.planes.alpha, q, 2 * q)).toBeGreaterThan(45);
    expect(mean(fd.planes.Pv, 2 * q, 3 * q)).toBeGreaterThan(mean(fd.planes.Ps, 2 * q, 3 * q));
    expect(mean(ha.planes.H, 2 * q, 3 * q)).toBeGreaterThan(0.8);
    console.log('polsar24 summary', JSON.stringify(summary));
  });

  it('refuses mismatched inputs by name', () => {
    expect(() => B.polsar(new Float32Array(10), 4, 4, { input: 'quad', products: ['t3'] })).toThrow(/size/);
    expect(() => B.polsar(cat([ch[3], ch[2]]), w, h, { input: 'dual', products: ['freeman'] })).toThrow(/quad-pol/);
  });
});
