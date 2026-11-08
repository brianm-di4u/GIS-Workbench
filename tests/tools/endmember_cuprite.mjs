// REQ-GAP-82 oracle on a real scene (SCN-70): automatic endmembers of AVIRIS-NG Cuprite against the
// USGS splib07 minerals of the embedded starter library, and against the independent Python VCA
// (tests/tools/endmember_ref.py). Offline: needs the T&E corpus and a built `spectral` bundle.
//
//   node tests/tools/endmember_cuprite.mjs [--envi <img>] [--lines 1200 1357] [--step 4] [--m 12] [--out <dir>]
//
// It reads `lines` image lines of the ENVI BIL reflectance file (every `step`-th band, the water and
// end bands left out), runs the kernel (VCA on MNF, PPI) and the unmixer, matches every endmember to
// the starter library by spectral angle, and writes cuprite-endmembers.json to --out (TE_OUT).
import { readFileSync, writeFileSync, openSync, readSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SpectralBundle } from '../../app/src/wasm/spectral.js';

const arg = (k, d, n = 1) => {
  const i = process.argv.indexOf(k);
  return i < 0 ? d : n === 1 ? process.argv[i + 1] : process.argv.slice(i + 1, i + 1 + n);
};
const IMG = arg('--envi', 'D:/TE-corpus/hsi-avirisng-cuprite-20200712-rfl/ang20200712t200729_rfl_v2y1/ang20200712t200729_corr_v2y1_img');
const [L0, NL] = arg('--lines', ['1200', '1357'], 2).map(Number);
const STEP = Number(arg('--step', 4));
const M = Number(arg('--m', 12));
const OUT = arg('--out', process.env.TE_OUT ?? 'reports');
const PY = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe';

// ---- the crop ----
const hdr = readFileSync(`${IMG}.hdr`, 'latin1');
const field = (k) => hdr.match(new RegExp(`${k}\\s*=\\s*([^\\n]*)`))[1].trim();
const [S, LINES, NB] = ['samples', 'lines', 'bands'].map((k) => Number(field(k)));
if (field('interleave').toLowerCase() !== 'bil' || field('data type') !== '4') throw new Error('expects float32 BIL');
const wlAll = hdr.match(/wavelength\s*=\s*\{([^}]*)\}/)[1].split(',').map(Number);
const bad = (w) => (w > 1340 && w < 1460) || (w > 1790 && w < 1960) || w < 400 || w > 2450;
const sel = [];
for (let b = 0; b < NB; b += STEP) if (!bad(wlAll[b])) sel.push(b);
const nb = sel.length;
const h = Math.min(NL, LINES - L0);
const v = new Float32Array(S * h * nb);
const fd = openSync(IMG, 'r');
const line = Buffer.alloc(S * NB * 4);
for (let y = 0; y < h; y++) {
  readSync(fd, line, 0, line.length, (L0 + y) * line.length);
  const f = new Float32Array(line.buffer, line.byteOffset, S * NB);
  for (let x = 0; x < S; x++) {
    let ok = true;
    for (let k = 0; k < nb; k++) {
      const val = f[sel[k] * S + x];
      if (!(val > -1000) || !Number.isFinite(val)) ok = false;
      v[(y * S + x) * nb + k] = val;
    }
    if (!ok) v.fill(NaN, (y * S + x) * nb, (y * S + x + 1) * nb);
  }
}
closeSync(fd);
const wlUm = sel.map((b) => wlAll[b] / 1000);
console.log(`crop ${S}×${h}×${nb} (lines ${L0}..${L0 + h - 1}, every ${STEP}th band, ${wlUm[0].toFixed(3)}–${wlUm.at(-1).toFixed(3)} µm)`);

// ---- the kernel ----
const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
const B = new SpectralBundle(new WebAssembly.Module(readFileSync(join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_spectral.wasm'))));
let t0 = performance.now();
const r = B.endmembers(v, S, h, nb, { m: M, skewers: 1000, seed: 1, step: 2 });
const tEnd = performance.now() - t0;
const ours = r.pixels.map((p) => Array.from(v.subarray(p * nb, (p + 1) * nb)));
t0 = performance.now();
const u = B.transform('unmix', v, S, h, nb, { endmembers: ours });
const tUnmix = performance.now() - t0;
let res = 0;
let nres = 0;
for (let p = 0; p < S * h; p++) if (Number.isFinite(u.cube[p * (M + 1) + M])) (res += u.cube[p * (M + 1) + M]), nres++;

// ---- the library, resampled linearly to the crop's band centres ----
const ST = JSON.parse(readFileSync(resolve('app/src/data/splib07-starter.json'), 'utf8'));
const interp = (wl, val, x) => {
  let i = wl.findIndex((w) => w >= x);
  if (i <= 0) return NaN;
  const [a, b] = [val[i - 1], val[i]];
  if (a === null || b === null) return NaN;
  return a + ((b - a) * (x - wl[i - 1])) / (wl[i] - wl[i - 1]);
};
const lib = ST.spectra.map((s) => ({ name: s.name, values: wlUm.map((x) => interp(ST.wavelengths, s.values, x)) }));
const angle = (a, b) => {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return Math.acos(Math.min(1, Math.max(-1, d / Math.sqrt(x * y))));
};
const matches = (spectra) =>
  spectra.map((s) => {
    const ranked = lib.map((l) => ({ name: l.name, sam: angle(s, l.values) })).sort((a, b) => a.sam - b.sam);
    return ranked.slice(0, 3).map((x) => ({ name: x.name, sam: +x.sam.toFixed(4) }));
  });

// ---- the independent reference ----
let ref = null;
if (existsSync(PY)) {
  mkdirSync(OUT, { recursive: true });
  const cube = join(OUT, 'cuprite-crop.f32');
  writeFileSync(cube, Buffer.from(v.buffer));
  writeFileSync(join(OUT, 'cuprite-ref-in.json'), JSON.stringify({ cube, w: S, h, nb, m: M, seed: 3 }));
  const env = { ...process.env, PATH: [join(PY, '..'), join(PY, '..', 'Library', 'bin'), process.env.PATH].join(';') };
  t0 = performance.now();
  execFileSync(PY, ['-I', resolve('tests/tools/endmember_ref.py'), join(OUT, 'cuprite-ref-in.json'), join(OUT, 'cuprite-ref-out.json')], { env, timeout: 1800000 });
  ref = { ...JSON.parse(readFileSync(join(OUT, 'cuprite-ref-out.json'), 'utf8')), ms: performance.now() - t0 };
}

const out = {
  crop: { img: IMG, lines: [L0, L0 + h - 1], step: STEP, w: S, h, nb, wlUm: [wlUm[0], wlUm.at(-1)] },
  m: M,
  kernel: { ms: Math.round(tEnd), components: r.components, pixels: r.pixels.map((p) => [p % S, L0 + Math.floor(p / S)]), library: matches(ours), unmixMs: Math.round(tUnmix), meanRmsResidual: res / nres },
  reference: ref && { ms: Math.round(ref.ms), branch: ref.branch, snrDb: ref.snr_db, library: matches(ref.spectra), toKernel: ref.spectra.map((s) => +Math.min(...ours.map((o) => angle(s, o))).toFixed(4)) },
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'cuprite-endmembers.json'), JSON.stringify(out, null, 1));
console.log(`kernel ${out.kernel.ms} ms (${r.components} MNF components); unmix ${out.kernel.unmixMs} ms, mean RMS residual ${out.kernel.meanRmsResidual.toFixed(4)}`);
out.kernel.library.forEach((mm, i) => console.log(`EM ${i + 1} at ${out.kernel.pixels[i]}: ${mm.map((x) => `${x.name} ${x.sam}`).join(' | ')}`));
if (ref) {
  console.log(`reference ${out.reference.ms} ms (${ref.branch}, SNR ${ref.snr_db.toFixed(1)} dB)`);
  out.reference.library.forEach((mm, i) => console.log(`REF ${i + 1}: ${mm[0].name} ${mm[0].sam}; nearest kernel endmember ${out.reference.toKernel[i]} rad`));
}
