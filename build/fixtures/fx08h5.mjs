// HDF5 variants of FX-08 for REQ-MSI-02 (the HDF5 data pack): the same 512 × 512 × 8 scene as
// fixtures/fx08 laid out like an EMIT L2A NetCDF-4 file (reflectance [rows, cols, bands],
// sensor_band_parameters, location/lat, lon) and like a PRISMA L2D HDF5-EOS file (VNIR_Cube
// [rows, bands, cols] in descending wavelength order, List_Cw_Vnir, L2ScaleVnirMin/Max,
// Geolocation Fields). Written with h5wasm (Node build). Run after fx08.mjs.
//
//   node build/fixtures/fx08h5.mjs [outdir]

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import h5wasm from 'h5wasm/node';
import proj4 from 'proj4';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'fx08') : join(ROOT, 'fixtures', 'fx08');
mkdirSync(OUT, { recursive: true });
const truth = JSON.parse(readFileSync(join(OUT, 'fx08_truth.json'), 'utf8'));
const W = 512;
const H = 512;
const NB = 8;
// ENVI BIL big-endian u16 (fx08.img).
const raw = readFileSync(join(OUT, 'fx08.img'));
const dn = (r, b, c) => raw.readUInt16BE(2 * ((r * NB + b) * W + c));
const bands = truth.bands;
const gt = truth.geo.geotransform;
const utm = '+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs';
const ll = (c, r) => proj4(utm, 'EPSG:4326', [gt[0] + gt[1] * (c + 0.5) + gt[2] * (r + 0.5), gt[3] + gt[4] * (c + 0.5) + gt[5] * (r + 0.5)]);
const lat = new Float64Array(W * H);
const lon = new Float64Array(W * H);
for (let r = 0; r < H; r++)
  for (let c = 0; c < W; c++) {
    const [x, y] = ll(c, r);
    lat[r * W + c] = y;
    lon[r * W + c] = x;
  }

await h5wasm.ready;
function write(name, fill) {
  const tmp = join(OUT, `${name}.tmp`);
  const f = new h5wasm.File(tmp, 'w');
  fill(f);
  f.close();
  const b = readFileSync(tmp);
  unlinkSync(tmp);
  writeFileSync(join(OUT, name), b);
  return b.length;
}

const emitN = write('fx08_emit.nc', (f) => {
  const refl = new Float32Array(H * W * NB);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) for (let b = 0; b < NB; b++) refl[(r * W + c) * NB + b] = dn(r, b, c) * 1e-4;
  f.create_attribute('title', 'EMIT L2A Estimated Surface Reflectance (GIS Workbench FX-08 synthetic)');
  const ds = f.create_dataset({ name: 'reflectance', data: refl, shape: [H, W, NB], dtype: '<f4' });
  ds.create_attribute('_FillValue', -9999, null, '<f4');
  const g = f.create_group('sensor_band_parameters');
  g.create_dataset({ name: 'wavelengths', data: Float32Array.from(bands.map((x) => x.cw * 1000)), shape: [NB], dtype: '<f4' });
  g.create_dataset({ name: 'fwhm', data: Float32Array.from(bands.map((x) => x.fwhm * 1000)), shape: [NB], dtype: '<f4' });
  g.create_dataset({ name: 'good_wavelengths', data: Uint8Array.from(bands.map(() => 1)), shape: [NB], dtype: '<B' });
  const loc = f.create_group('location');
  loc.create_dataset({ name: 'lat', data: lat, shape: [H, W], dtype: '<d' });
  loc.create_dataset({ name: 'lon', data: lon, shape: [H, W], dtype: '<d' });
});

const prismaN = write('fx08_prisma.he5', (f) => {
  // VNIR in descending wavelength order, as PRISMA stores it; reflectance = min + DN·(max − min)/65535.
  const order = [...bands.keys()].reverse();
  const cube = new Uint16Array(H * NB * W);
  for (let r = 0; r < H; r++) for (let k = 0; k < NB; k++) for (let c = 0; c < W; c++) cube[(r * NB + k) * W + c] = Math.round(dn(r, order[k], c) * 1e-4 * 65535);
  f.create_attribute('Product_ID', 'PRS_L2D_HCO');
  f.create_attribute('Processing_Level', 'L2D');
  f.create_attribute('List_Cw_Vnir', Float32Array.from(order.map((b) => bands[b].cw * 1000)), [NB], '<f4');
  f.create_attribute('List_Fwhm_Vnir', Float32Array.from(order.map((b) => bands[b].fwhm * 1000)), [NB], '<f4');
  f.create_attribute('L2ScaleVnirMin', 0, null, '<f4');
  f.create_attribute('L2ScaleVnirMax', 1, null, '<f4');
  const sw = f.create_group('HDFEOS').create_group('SWATHS').create_group('PRS_L2D_HCO');
  sw.create_group('Data Fields').create_dataset({ name: 'VNIR_Cube', data: cube, shape: [H, NB, W], dtype: '<H' });
  const geo = sw.create_group('Geolocation Fields');
  geo.create_dataset({ name: 'Latitude', data: Float32Array.from(lat), shape: [H, W], dtype: '<f4' });
  geo.create_dataset({ name: 'Longitude', data: Float32Array.from(lon), shape: [H, W], dtype: '<f4' });
});
console.log(`FX-08 HDF5: fx08_emit.nc ${emitN} B, fx08_prisma.he5 ${prismaN} B → ${OUT}`);
