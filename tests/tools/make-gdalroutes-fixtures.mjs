#!/usr/bin/env node
// The synthetic part of fixtures/fx26/gdalroutes (SOURCE.txt lists the rest). Run with GDAL's tools on
// PATH and GDAL's KEA driver loadable:  node tests/tools/make-gdalroutes-fixtures.mjs
// Each output is small and fixed by this script, so a test failure is not a change in the data.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OUT = resolve('fixtures', 'fx26', 'gdalroutes');
const TMP = resolve('test-results', 'fx26');
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const run = (t, a) => execFileSync(t, a, { stdio: ['ignore', 'pipe', 'pipe'] });

/** An ENVI raw file and header → a GeoTIFF with this CRS and geotransform. */
function raster(name, w, h, bands, type, typeId, srs, ulx, uly, px, fill, co = ['COMPRESS=DEFLATE']) {
  const B = { 1: Uint8Array, 4: Float32Array, 5: Float64Array, 12: Uint16Array }[typeId];
  const a = new B(w * h * bands);
  for (let b = 0; b < bands; b++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[b * w * h + y * w + x] = fill(x, y, b);
  const raw = join(TMP, `${name}.bsq`);
  writeFileSync(raw, Buffer.from(a.buffer));
  writeFileSync(`${raw}.hdr`.replace('.bsq.hdr', '.hdr'), `ENVI\nsamples = ${w}\nlines = ${h}\nbands = ${bands}\nheader offset = 0\nfile type = ENVI Standard\ndata type = ${typeId}\ninterleave = bsq\nbyte order = 0\n`);
  run('gdal_translate', ['-q', '-of', 'GTiff', '-a_srs', srs, '-a_ullr', String(ulx), String(uly), String(ulx + w * px), String(uly - h * px), ...co.flatMap((c) => ['-co', c]), raw, join(OUT, `${name}.tif`)]);
}

// A pan band at four times the resolution of a three-band image, with real structure in both.
const wave = (x, y, k) => 128 + 90 * Math.sin((x + k * 7) / 9) * Math.cos((y - k * 5) / 13);
raster('pan', 256, 256, 1, 'Byte', 1, 'EPSG:32611', 500000, 4000000, 1, (x, y) => Math.round(wave(x / 4, y / 4, 1)));
raster('ms', 64, 64, 3, 'Byte', 1, 'EPSG:32611', 500000, 4000000, 4, (x, y, b) => Math.round(wave(x, y, b)));
// Each pixel holds its own British National Grid coordinates: a warped value is where it came from.
raster('osgb_xy', 200, 200, 2, 'Float64', 5, 'EPSG:27700', 530000, 182000, 100, (x, y, b) => (b === 0 ? 530000 + (x + 0.5) * 100 : 182000 - (y + 0.5) * 100), ['COMPRESS=ZSTD', 'TILED=YES']);
raster('nad27_xy', 200, 200, 2, 'Float64', 5, 'EPSG:26711', 380000, 3770000, 100, (x, y, b) => (b === 0 ? 380000 + (x + 0.5) * 100 : 3770000 - (y + 0.5) * 100), ['COMPRESS=ZSTD', 'TILED=YES']);
run('gdal_translate', ['-q', '-of', 'KEA', join(OUT, 'small.src.tif').replace('small.src.tif', 'ms.tif'), join(TMP, 'x.kea')]);

// Two boxes as a glTF binary: a node with a translation, one with a rotation about Y and a scale.
const P = [];
const I = [];
for (const [x, y, z] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]) P.push(x, y, z);
for (const q of [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]) I.push(...q);
const pos = Buffer.from(new Float32Array(P).buffer);
const idx = Buffer.from(new Uint16Array(I).buffer);
const pad = Buffer.alloc((4 - (idx.length % 4)) % 4);
const bin = Buffer.concat([pos, idx, pad]);
const s = Math.SQRT1_2;
const g = {
  asset: { version: '2.0', generator: 'GIS Workbench fixtures' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes: [{ name: 'first', mesh: 0, translation: [10, 2, -3] }, { name: 'second', mesh: 1, translation: [-4, 0, 5], rotation: [0, s, 0, s], scale: [2, 2, 2] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }, { primitives: [{ attributes: { POSITION: 2 }, indices: 3 }] }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.length }, { buffer: 0, byteOffset: pos.length, byteLength: idx.length }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
    { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
    { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
  ],
};
let json = Buffer.from(JSON.stringify(g));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const head = Buffer.alloc(20);
head.writeUInt32LE(0x46546c67, 0);
head.writeUInt32LE(2, 4);
head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
head.writeUInt32LE(json.length, 12);
head.writeUInt32LE(0x4e4f534a, 16);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(bin.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);
writeFileSync(join(OUT, 'two_boxes.glb'), Buffer.concat([head, json, binHead, bin]));
rmSync(TMP, { recursive: true, force: true });
