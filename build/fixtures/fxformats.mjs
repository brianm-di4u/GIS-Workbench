// Inputs for REQ-FMT-14:
//   mie4nitf.ntf   six 128 × 96 frames as image segments, each with an MTIMSA TRE (2 frames/s,
//                  one frame per segment) and IGEOLO corners; a bright square moves 10 px a frame;
//                  the segments are written out of time order to test ordering;
//   0XQ0F010.JN1   a CADRG frame file (the JITC U_3058b.ntf VQ sample under an RPF frame name).
//
//   node build/fixtures/fxformats.mjs [outdir]

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeNitfSegments } from '../../app/src/formats/nitf-writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.argv[2] ? join(process.argv[2], 'formats') : join(ROOT, 'fixtures', 'formats');
mkdirSync(OUT, { recursive: true });

const W = 128;
const H = 96;
const N = 6;
const pad = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
const num = (v, n) => String(v).padStart(n, '0').slice(-n);
const be = (v, n) => {
  let x = BigInt(v);
  let s = '';
  for (let i = 0; i < n; i++) {
    s = String.fromCharCode(Number(x & 255n)) + s;
    x >>= 8n;
  }
  return s;
};
const base = Date.UTC(2025, 9, 25, 23, 59, 31);
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (v, k = 2) => String(v).padStart(k, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
};
const order = [3, 0, 5, 1, 4, 2]; // file order of the frames
const frames = order.map((k) => {
  const px = new Uint8Array(W * H).fill(40);
  for (let y = 30; y < 50; y++) for (let x = 10 + 10 * k; x < 30 + 10 * k; x++) px[y * W + x] = 230;
  const t = base + k * 500;
  const mtimsa = num(k + 1, 3) + '01' + pad('GW-MIE-LAYER', 36) + '001' + pad('GW-SYNTH-CAM', 36) + num(1, 6) + num(1, 3) + pad('0000002.00000', 13) + num(k + 1, 9) + stamp(t) + be(1_000_000, 8) + be(1, 1) + be(1, 4) + be(0, 4);
  if (mtimsa.length !== 3 + 2 + 36 + 3 + 36 + 6 + 3 + 13 + 9 + 24 + 8 + 1 + 4 + 4) throw new Error(`MTIMSA is ${mtimsa.length} bytes`);
  return { k, t, img: { width: W, height: H, bands: 1, type: 'u8', planes: [px] }, opts: { iid1: `MIE${num(k + 1, 3)}`, iid2: `MIE4NITF frame ${k + 1}`, idatim: stamp(t).slice(0, 14), icat: 'VIS', irep: 'MONO', corners: [[34.51, -117.01], [34.51, -116.99], [34.49, -116.99], [34.49, -117.01]], tres: [['MTIMSA', mtimsa]] } };
});
writeFileSync(join(OUT, 'mie4nitf.ntf'), writeNitfSegments(frames.map((f) => ({ img: f.img, opts: f.opts })), { title: 'GIS Workbench MIE4NITF test (6 frames)' }));
const cadrg = join(ROOT, '..', 'Research', 'samples', 'nitf-jitc-vq-cadrg', 'U_3058b.ntf');
if (existsSync(cadrg)) copyFileSync(cadrg, join(OUT, '0XQ0F010.JN1'));
writeFileSync(join(OUT, 'formats_truth.json'), JSON.stringify({ mie: { frames: N, fileOrder: order, times: [...Array(N).keys()].map((k) => new Date(base + k * 500).toISOString()), frameRate: 2, squareX: [...Array(N).keys()].map((k) => 10 + 10 * k) }, cadrg: { width: 1536, height: 1536, source: 'Research/samples/nitf-jitc-vq-cadrg/U_3058b.ntf' } }));
console.log(`formats fixtures → ${OUT}`);
void readFileSync;
