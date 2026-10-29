// Derived multispectral NITF with BANDSB band metadata (STDI-0002 App. X, REQ-MSI-01/05) and the
// interleave modes B/R/P/S, from three real producers: WorldView-3 MS (SpaceNet Vegas, DN),
// Landsat 8 C2 L2 surface reflectance and Sentinel-2 L2A (baseline N0511, BOA offset −1000).
// A 512² centre chip of each is cut with GDAL to raw BSQ, then written by the app's own
// writeNitf (as build/fixtures/fx08.mjs). Corners come from the chip's GDAL wgs84Extent.
// Registers the item in sources/archive-derived.json.
//
//   node build/campaign/derive_nitf_msi.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, HERE } from './corpus-lib.mjs';
import { writeNitf } from '../../app/src/formats/nitf-writer.js';

const BIN = join(HERE, '..', '..', '..', 'TE-tools', 'mamba', 'envs', 'gw-te', 'Library', 'bin');
const gdal = (tool, args) => execFileSync(join(BIN, `${tool}.exe`), args, { maxBuffer: 1 << 30, env: { ...process.env, PROJ_DATA: join(BIN, '..', 'share', 'proj'), GDAL_DATA: join(BIN, '..', 'share', 'gdal') } }).toString();
const ID = 'derived-nitf-bandsb-msi';
const OUT = join(CORPUS, ID);
const TMP = join(OUT, '_tmp');
mkdirSync(TMP, { recursive: true });
const N = 512;

const L8 = join(CORPUS, 'landsat8-c2-l2sp-044034-20240820');
const S2 = join(CORPUS, 's2-l2a-cog-10seh-20240816');
const SOURCES = [
  {
    tag: 'wv3_vegas_ms', item: 'eo-spacenet-vegas-wv3-pan-ms-r1c1', gsd: 1.24, quantity: 'DN', scale: 1, offset: 0,
    files: [join(CORPUS, 'eo-spacenet-vegas-wv3-pan-ms-r1c1', '15OCT22183656-M2AS_R1C1-055649178030_01_P001.TIF')],
    bands: [['Coastal', 0.425, 0.05], ['Blue', 0.48, 0.06], ['Green', 0.545, 0.07], ['Yellow', 0.605, 0.04], ['Red', 0.66, 0.06], ['RedEdge', 0.725, 0.04], ['NIR1', 0.8325, 0.125], ['NIR2', 0.95, 0.18]],
    modes: ['B', 'R', 'S'],
  },
  {
    tag: 'landsat8_sr', item: 'landsat8-c2-l2sp-044034-20240820', gsd: 30, quantity: 'REFLECTANCE', scale: 2.75e-5, offset: -0.2,
    files: [1, 2, 3, 4, 5, 6, 7].map((b) => join(L8, `LC08_L2SP_044034_20240820_20240830_02_T1_SR_B${b}.TIF`)),
    bands: [['B1 Coastal', 0.443, 0.016], ['B2 Blue', 0.482, 0.06], ['B3 Green', 0.561, 0.057], ['B4 Red', 0.655, 0.037], ['B5 NIR', 0.865, 0.028], ['B6 SWIR1', 1.609, 0.085], ['B7 SWIR2', 2.201, 0.187]],
    modes: ['B', 'R'],
  },
  {
    tag: 's2b_l2a_10seh', item: 's2-l2a-cog-10seh-20240816', gsd: 10, quantity: 'REFLECTANCE', scale: 1e-4, offset: -0.1,
    files: ['B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B11', 'B12'].map((b) => join(S2, `${b}.tif`)),
    bands: [['B02 Blue', 0.4921, 0.066], ['B03 Green', 0.559, 0.036], ['B04 Red', 0.665, 0.031], ['B05 RE1', 0.7039, 0.016], ['B06 RE2', 0.7392, 0.015], ['B07 RE3', 0.7797, 0.02], ['B08 NIR', 0.833, 0.106], ['B11 SWIR1', 1.6104, 0.094], ['B12 SWIR2', 2.1857, 0.185]],
    modes: ['B', 'R', 'P'],
  },
];

// BANDSB as fx08.mjs: COUNT, quantity, unit, scale/additive (float32 BE), GSDs, existence mask with
// BANDID (b28), CWAVE (b24) and FWHM (b23), wavelength unit U (µm), then per band.
function bandsb(s) {
  const A = (v, n) => String(v ?? '').slice(0, n).padEnd(n, ' ');
  const f32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeFloatBE(v);
    return b.toString('latin1');
  };
  const num = (v, n, d) => v.toFixed(d).padStart(n, '0').slice(0, n);
  const mb = Buffer.alloc(4);
  mb.writeUInt32BE(((1 << 28) | (1 << 24) | (1 << 23)) >>> 0);
  let t = String(s.bands.length).padStart(5, '0') + A(s.quantity, 24) + A('', 1) + f32(s.scale) + f32(s.offset) + num(s.gsd, 7, 3) + 'M' + num(s.gsd, 7, 3) + 'M' + A('', 7) + A('', 1) + A('', 7) + A('', 1) + A('', 48) + mb.toString('latin1') + 'U';
  for (const [id, cw, fwhm] of s.bands) t += A(id, 50) + num(cw, 7, 5) + num(fwhm, 7, 5);
  return t;
}

const files = [];
const recipe = [];
for (const s of SOURCES) {
  const vrt = join(TMP, `${s.tag}.vrt`);
  gdal('gdalbuildvrt', ['-q', '-separate', '-resolution', 'highest', vrt, ...s.files]);
  const info = JSON.parse(gdal('gdalinfo', ['-json', vrt]));
  const [w, h] = info.size;
  const x0 = Math.floor((w - N) / 2);
  const y0 = Math.floor((h - N) / 2);
  const raw = join(TMP, `${s.tag}.bsq`);
  gdal('gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'UInt16', '-srcwin', x0, y0, N, N, vrt, raw].map(String));
  const ext = JSON.parse(gdal('gdalinfo', ['-json', raw])).wgs84Extent.coordinates[0]; // UL, LL, LR, UR, UL as [lon, lat]
  const ll = ([lon, lat]) => [lat, lon];
  const corners = [ll(ext[0]), ll(ext[3]), ll(ext[2]), ll(ext[1])];
  const buf = readFileSync(raw);
  const nb = s.bands.length;
  const planes = Array.from({ length: nb }, (_, b) => {
    const p = new Uint16Array(N * N);
    for (let i = 0; i < N * N; i++) p[i] = buf.readUInt16LE((b * N * N + i) * 2);
    return p;
  });
  const img = { width: N, height: N, bands: nb, type: 'u16', planes };
  const common = { title: `${s.tag} ${nb}-band chip with BANDSB`, iid1: s.tag.slice(0, 10).toUpperCase(), iid2: `${s.item} centre ${N}x${N} at (${x0},${y0})`, icat: 'MS', irep: 'MULTI', abpp: 16, corners, tres: [['BANDSB', bandsb(s)]], isubcat: s.bands.map((b) => String(Math.round(b[1] * 1000))), block: 256 };
  for (const m of s.modes) {
    const name = `${s.tag}_bandsb_imode${m}.ntf`;
    writeFileSync(join(OUT, name), writeNitf(img, { ...common, imode: m }));
    files.push({ name, url: null, role: 'primary' });
  }
  recipe.push(`${s.item}: gdalbuildvrt -separate -resolution highest; gdal_translate -srcwin ${x0} ${y0} ${N} ${N} → writeNitf IMODE ${s.modes.join('/')}, BANDSB ${s.quantity} scale ${s.scale} offset ${s.offset}`);
}
rmSync(TMP, { recursive: true, force: true });

const entry = {
  id: ID,
  area: 'nitf',
  title: 'Multispectral NITF chips with BANDSB (WorldView-3 MS DN, Landsat 8 SR, Sentinel-2 L2A) in IMODE B, R, P and S',
  source: 'Derived from eo-spacenet-vegas-wv3-pan-ms-r1c1, landsat8-c2-l2sp-044034-20240820, s2-l2a-cog-10seh-20240816',
  landing: 'build/campaign/derive_nitf_msi.mjs',
  licence: 'CC BY-SA 4.0 (SpaceNet); public domain (USGS Landsat); Copernicus Sentinel data terms',
  attribution: 'SpaceNet / Maxar; USGS; contains modified Copernicus Sentinel data 2024',
  tier: 'A',
  origin: 'derived',
  format: 'NITF 2.1 (IC=NC, BANDSB TRE)',
  profile: '512² uint16 chips, 7-9 bands (the writer takes at most 9; S2 drops B8A), ABPP 16; band centre wavelengths and FWHM (µm) in BANDSB and ISUBCAT (nm); written by app/src/formats/nitf-writer.js writeNitf',
  files,
  sign: null,
  derivation: recipe.join('; '),
  notes: 'Generated by build/campaign/derive_nitf_msi.mjs. Reflectance = DN × scale + offset per BANDSB (Landsat C2 L2: 2.75e-5, −0.2; S2 N0511: 1e-4, −0.1). WV3 band edges are nominal; the WV3 chip stays DN (per-band absCalFactor does not fit BANDSB one scale).',
  feeds: ['msi.radiometric', 'msi.index.ndvi', 'msi.library', 'ingest'],
  covers: ['fmt:tre.BANDSB', 'fmt:nitf.imode.r', 'fmt:nitf.v21'],
  pairs: [],
};
const srcFile = join(HERE, 'sources', 'archive-derived.json');
const all = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
const i = all.findIndex((e) => e.id === ID);
if (i >= 0) all[i] = entry;
else all.push(entry);
writeFileSync(srcFile, JSON.stringify(all, null, 1));
console.log(`${ID}: ${files.map((f) => f.name).join(', ')}`);
