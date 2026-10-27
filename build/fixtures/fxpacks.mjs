// Inputs for the data-pack tests (REQ-ARC-14, REQ-GEO-12): a 256 × 256 GeoTIFF in EPSG:31370
// (Belgian Lambert 72, outside the embedded EPSG table), 10 m pixels over Brussels, so the
// PROJ pack has to define its CRS.
//
//   node build/fixtures/fxpacks.mjs [outdir]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeGeoTiff } from '../../app/src/formats/geotiff-writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'packs') : join(ROOT, 'fixtures', 'packs');
mkdirSync(OUT, { recursive: true });
const W = 256;
const H = 256;
const px = new Uint8Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = ((x >> 4) + (y >> 4)) % 2 ? 200 : 60;
const gt = [148000, 10, 0, 172000, 0, -10];
writeFileSync(join(OUT, 'bl72.tif'), await writeGeoTiff({ width: W, height: H, bands: 1, type: 'u8', data: px }, { epsg: 31370, geotransform: gt, description: 'EPSG:31370 test raster' }));
writeFileSync(join(OUT, 'bl72_truth.json'), JSON.stringify({ epsg: 31370, geotransform: gt, width: W, height: H, note: 'Corner coordinates in EPSG:31370; the test compares the PROJ pack transform with the opened layer model.' }));
console.log(`packs fixtures → ${OUT}`);
