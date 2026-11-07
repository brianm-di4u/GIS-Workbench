// FX-08: a synthetic 8-band WorldView-3-like VNIR scene for SCN-13 (Appendix E AT-13.1..13.5).
// Seven land-cover classes are laid out as fields; each pixel is the class reflectance plus
// spectrally correlated Gaussian noise. The class statistics are chosen so that every pair has a
// Jeffries–Matusita distance ≥ 1.8 (AT-13.2 note); the truth records the JM matrix, the training
// and validation rectangles, per-field NDVI computed from the stored DNs, and a 4 × 4 anomaly.
//
// Outputs (fixtures/fx08): fx08.ntf (IMODE B, BANDSB), fx08_s.ntf / fx08_p.ntf / fx08_r.ntf (the
// other IMODEs), fx08.tif (GeoTIFF with GDAL_METADATA wavelengths), fx08.hdr + fx08.img (ENVI
// BIL, big-endian), fx08_b.tif (a second date with two fields changed), fx08_truth.json.
//
//   node build/fixtures/fx08.mjs [outdir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNitf } from '../../app/src/formats/nitf-writer.js';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'fx08') : join(ROOT, 'fixtures', 'fx08');
mkdirSync(OUT, { recursive: true });

const W = 512;
const H = 512;
const NB = 8;
const BANDS = [
  { id: 'Coastal', cw: 0.427, fwhm: 0.040 },
  { id: 'Blue', cw: 0.478, fwhm: 0.054 },
  { id: 'Green', cw: 0.546, fwhm: 0.063 },
  { id: 'Yellow', cw: 0.608, fwhm: 0.037 },
  { id: 'Red', cw: 0.659, fwhm: 0.057 },
  { id: 'Red Edge', cw: 0.724, fwhm: 0.039 },
  { id: 'NIR1', cw: 0.831, fwhm: 0.092 },
  { id: 'NIR2', cw: 0.908, fwhm: 0.096 },
];
// Class reflectance spectra (8 bands).
const CLASSES = [
  { name: 'water', mean: [0.07, 0.065, 0.055, 0.04, 0.03, 0.022, 0.015, 0.012] },
  { name: 'vegetation', mean: [0.03, 0.04, 0.09, 0.07, 0.04, 0.2, 0.45, 0.48] },
  { name: 'dry grass', mean: [0.05, 0.07, 0.12, 0.15, 0.17, 0.23, 0.31, 0.33] },
  { name: 'bare soil', mean: [0.11, 0.13, 0.17, 0.2, 0.23, 0.26, 0.27, 0.28] },
  { name: 'concrete', mean: [0.25, 0.28, 0.31, 0.32, 0.33, 0.33, 0.34, 0.34] },
  { name: 'asphalt', mean: [0.06, 0.065, 0.07, 0.075, 0.08, 0.085, 0.09, 0.095] },
  { name: 'clay roof', mean: [0.07, 0.07, 0.09, 0.15, 0.25, 0.3, 0.33, 0.34] },
];
const SIGMA = 0.012;
const RHO = 0.6;
// Correlated noise: Σ_ij = σ² ρ^|i−j| (Cholesky factor L).
const COV = Array.from({ length: NB }, (_, i) => Array.from({ length: NB }, (_, j) => SIGMA * SIGMA * RHO ** Math.abs(i - j)));
function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(s) : s / L[j][j];
    }
  return L;
}
const L = cholesky(COV);
function inverse(A) {
  const n = A.length;
  const M = A.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let k = 0; k < 2 * n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++)
      if (r !== c) {
        const f = M[r][c];
        for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k];
      }
  }
  return M.map((r) => r.slice(n));
}
const IC = inverse(COV);
// Equal covariances: Bhattacharyya B = ⅛ Δᵀ Σ⁻¹ Δ, JM = 2 (1 − e^{−B}).
const jm = CLASSES.map((a) =>
  CLASSES.map((b) => {
    const d = a.mean.map((v, i) => v - b.mean[i]);
    let q = 0;
    for (let i = 0; i < NB; i++) for (let j = 0; j < NB; j++) q += d[i] * IC[i][j] * d[j];
    return 2 * (1 - Math.exp(-q / 8));
  }),
);

// Fields: a 4 × 4 grid of 128² cells assigned to classes; training (left half) and validation
// (right half) rectangles come from different cells of each class.
const layout = [
  [1, 2, 3, 0],
  [4, 5, 6, 1],
  [2, 3, 0, 4],
  [5, 6, 1, 2],
];
const classOf = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) classOf[y * W + x] = layout[Math.floor(y / 128)][Math.floor(x / 128)];
// xorshift32 (the LCG in synth.mjs is too short-period for this many Gaussian draws).
let seed = 808;
const r = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};
const gauss = () => {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const refl = Array.from({ length: NB }, () => new Float32Array(W * H));
for (let i = 0; i < W * H; i++) {
  const m = CLASSES[classOf[i]].mean;
  const z = Array.from({ length: NB }, gauss);
  for (let b = 0; b < NB; b++) {
    let n = 0;
    for (let k = 0; k <= b; k++) n += L[b][k] * z[k];
    refl[b][i] = Math.max(0, m[b] + n);
  }
}
// The anomaly: 4 × 4 px of painted metal inside a vegetation field (cell row 0, col 0).
const ANOM = { x0: 60, y0: 70, w: 4, h: 4, spectrum: [0.4, 0.12, 0.06, 0.05, 0.05, 0.05, 0.6, 0.1] };
for (let y = ANOM.y0; y < ANOM.y0 + ANOM.h; y++)
  for (let x = ANOM.x0; x < ANOM.x0 + ANOM.w; x++) for (let b = 0; b < NB; b++) refl[b][y * W + x] = ANOM.spectrum[b] + SIGMA * gauss();
// DN = reflectance × 10 000 (uint16, scale 1e-4, offset 0).
const dn = refl.map((p) => Uint16Array.from(p, (v) => Math.min(65535, Math.round(v * 10000))));

// Training and validation rectangles (cell index → rectangle inside it, margin 16 px).
const cells = [];
for (let cy = 0; cy < 4; cy++) for (let cx = 0; cx < 4; cx++) cells.push({ cx, cy, cls: layout[cy][cx] });
const rect = (c, k) => ({ x0: c.cx * 128 + 16 + k * 56, y0: c.cy * 128 + 16, w: 40, h: 96 });
const training = [];
const validation = [];
for (let k = 0; k < CLASSES.length; k++) {
  const cs = cells.filter((c) => c.cls === k);
  training.push({ class: k, name: CLASSES[k].name, rect: rect(cs[0], 0) });
  validation.push({ class: k, name: CLASSES[k].name, rect: rect(cs.at(-1), 1) });
}
// NDVI truth per field: mean of per-pixel (NIR1 − Red)/(NIR1 + Red) from the stored DNs, over
// each cell's interior (8 px margin), the anomaly excluded.
const ndvi = cells.map((c) => {
  let s = 0;
  let n = 0;
  for (let y = c.cy * 128 + 8; y < c.cy * 128 + 120; y++)
    for (let x = c.cx * 128 + 8; x < c.cx * 128 + 120; x++) {
      if (x >= ANOM.x0 - 2 && x < ANOM.x0 + ANOM.w + 2 && y >= ANOM.y0 - 2 && y < ANOM.y0 + ANOM.h + 2) continue;
      const a = dn[6][y * W + x];
      const b = dn[4][y * W + x];
      if (a + b === 0) continue;
      s += (a - b) / (a + b);
      n++;
    }
  return { cell: [c.cx, c.cy], class: c.cls, rect: { x0: c.cx * 128 + 8, y0: c.cy * 128 + 8, w: 112, h: 112 }, ndvi: s / n };
});

// Geography: UTM 11N, 2 m pixels (WV-3 MS ≈ 1.24 m; coarser keeps the scene small).
const E0 = 500000;
const N0 = 3770000;
const GSD = 2;
const gt = [E0, GSD, 0, N0, 0, -GSD];
const utmToLatLon = (e, n) => {
  // Transverse Mercator inverse (WGS 84, zone 11, k0 0.9996), series form.
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const k0 = 0.9996;
  const ep2 = e2 / (1 - e2);
  const x = e - 500000;
  const M = n / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const T1 = Math.tan(p1) ** 2;
  const C1 = ep2 * Math.cos(p1) ** 2;
  const R1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const D = x / (N1 * k0);
  const lat = p1 - ((N1 * Math.tan(p1)) / R1) * ((D * D) / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / Math.cos(p1);
  return [(lat * 180) / Math.PI, -117 + (lon * 180) / Math.PI];
};
const corners = [[0.5, 0.5], [W - 0.5, 0.5], [W - 0.5, H - 0.5], [0.5, H - 0.5]].map(([x, y]) => utmToLatLon(E0 + x * GSD, N0 - y * GSD));

// BANDSB (STDI-0002 App. X): COUNT, quantity, unit, scale/additive (float32 BE), GSDs, spatial
// response, reserved, existence mask with BANDID (b28), CWAVE (b24) and FWHM (b23) per band.
function bandsb() {
  const A = (v, n) => String(v ?? '').slice(0, n).padEnd(n, ' ');
  const f32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    return b.toString('latin1');
  };
  const num = (v, n, d) => v.toFixed(d).padStart(n, '0').slice(0, n);
  const mask = (1 << 28) | (1 << 24) | (1 << 23);
  const mb = Buffer.alloc(4);
  mb.writeUInt32BE(mask >>> 0);
  let s = String(NB).padStart(5, '0') + A('REFLECTANCE', 24) + A('', 1) + f32(1e-4) + f32(0) + num(GSD, 7, 3) + 'M' + num(GSD, 7, 3) + 'M' + A('', 7) + A('', 1) + A('', 7) + A('', 1) + A('', 48) + mb.toString('latin1');
  s += 'U'; // wavelength unit: micrometres (b24/b23 set)
  for (const b of BANDS) s += A(b.id, 50) + num(b.cw, 7, 5) + num(b.fwhm, 7, 5);
  return s;
}

const planes = dn;
const img = { width: W, height: H, bands: NB, type: 'u16', planes };
const common = { title: 'FX-08 synthetic multispectral', iid1: 'FX08MSI', iid2: 'FX-08 8-band VNIR (synthetic)', icat: 'MS', irep: 'MULTI', abpp: 14, corners, tres: [['BANDSB', bandsb()]], isubcat: BANDS.map((b) => String(Math.round(b.cw * 1000))), block: 256 };
writeFileSync(join(OUT, 'fx08.ntf'), writeNitf(img, { ...common, imode: 'B' }));
for (const m of ['S', 'P', 'R']) writeFileSync(join(OUT, `fx08_${m.toLowerCase()}.ntf`), writeNitf(img, { ...common, imode: m }));

const gdal = `<GDALMetadata>${BANDS.map((b, k) => `<Item name="DESCRIPTION" sample="${k}" role="description">${b.id}</Item><Item name="wavelength" sample="${k}">${b.cw}</Item><Item name="wavelength_units" sample="${k}">micrometers</Item><Item name="fwhm" sample="${k}">${b.fwhm}</Item>`).join('')}<Item name="SCALE" sample="0" role="scale">0.0001</Item></GDALMetadata>`;
const interleaved = (p) => {
  const d = new Uint16Array(W * H * NB);
  for (let i = 0; i < W * H; i++) for (let b = 0; b < NB; b++) d[i * NB + b] = p[b][i];
  return d;
};
writeFileSync(join(OUT, 'fx08.tif'), await writeGeoTiff({ width: W, height: H, bands: NB, type: 'u16', data: interleaved(planes) }, { epsg: 32611, geotransform: gt, gdalMetadata: gdal, description: 'FX-08 synthetic multispectral' }));

// Second date: cell (1, 0) vegetation → bare soil, cell (2, 1) asphalt → concrete.
const changed = [{ cell: [1, 0], from: 2, to: 3 }, { cell: [1, 1], from: 5, to: 4 }];
const dn2 = dn.map((p) => p.slice());
for (const ch of changed) {
  const [cx, cy] = ch.cell;
  for (let y = cy * 128; y < cy * 128 + 128; y++)
    for (let x = cx * 128; x < cx * 128 + 128; x++) {
      const i = y * W + x;
      const z = Array.from({ length: NB }, gauss);
      for (let b = 0; b < NB; b++) {
        let n = 0;
        for (let k = 0; k <= b; k++) n += L[b][k] * z[k];
        dn2[b][i] = Math.min(65535, Math.round(Math.max(0, CLASSES[ch.to].mean[b] + n) * 10000));
      }
    }
}
writeFileSync(join(OUT, 'fx08_b.tif'), await writeGeoTiff({ width: W, height: H, bands: NB, type: 'u16', data: interleaved(dn2) }, { epsg: 32611, geotransform: gt, gdalMetadata: gdal, description: 'FX-08 second date' }));

// ENVI: BIL, big-endian uint16 (byte order 1), with wavelengths, FWHM, band names, map info.
const bil = Buffer.alloc(W * H * NB * 2);
for (let y = 0; y < H; y++) for (let b = 0; b < NB; b++) for (let x = 0; x < W; x++) bil.writeUInt16BE(dn[b][y * W + x], ((y * NB + b) * W + x) * 2);
writeFileSync(join(OUT, 'fx08.img'), bil);
writeFileSync(
  join(OUT, 'fx08.hdr'),
  [
    'ENVI',
    'description = {FX-08 synthetic multispectral (GIS Workbench fixture)}',
    `samples = ${W}`,
    `lines = ${H}`,
    `bands = ${NB}`,
    'header offset = 0',
    'file type = ENVI Standard',
    'data type = 12',
    'interleave = bil',
    'byte order = 1',
    `map info = {UTM, 1.000, 1.000, ${E0}, ${N0}, ${GSD}, ${GSD}, 11, North, WGS-84, units=Meters}`,
    'wavelength units = Micrometers',
    `band names = {${BANDS.map((b) => b.id).join(', ')}}`,
    `wavelength = {${BANDS.map((b) => b.cw).join(', ')}}`,
    `fwhm = {${BANDS.map((b) => b.fwhm).join(', ')}}`,
    'reflectance scale factor = 10000',
    `bbl = {${BANDS.map(() => 1).join(', ')}}`,
    '',
  ].join('\n'),
);

const minJm = Math.min(...jm.flatMap((row, i) => row.filter((_, j) => j !== i)));
writeFileSync(
  join(OUT, 'fx08_truth.json'),
  JSON.stringify(
    {
      description: 'FX-08 synthetic 8-band VNIR scene (SCN-13)',
      size: [W, H],
      bands: BANDS,
      dnScale: 1e-4,
      classes: CLASSES.map((c) => c.name),
      classMeans: CLASSES.map((c) => c.mean),
      noise: { sigma: SIGMA, rho: RHO },
      jm,
      minJm,
      layout,
      cell: 128,
      training,
      validation,
      ndvi,
      anomaly: ANOM,
      changed,
      geo: { epsg: 32611, geotransform: gt, corners },
      files: { nitf: 'fx08.ntf', nitfS: 'fx08_s.ntf', nitfP: 'fx08_p.ntf', nitfR: 'fx08_r.ntf', tif: 'fx08.tif', tifB: 'fx08_b.tif', envi: ['fx08.hdr', 'fx08.img'] },
    },
    null,
    1,
  ),
);
console.log(`FX-08 written to ${OUT}: min JM ${minJm.toFixed(3)}`);
