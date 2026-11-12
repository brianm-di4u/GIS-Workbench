// REQ-GAP-47 fixtures (fixtures/fx24/motion): synthetic MIE4NITF files written with the app's own
// NITF writer (app/src/formats/nitf-writer.js) and TRE encoders (app/src/formats/mie4nitf.js). No
// independently produced MIE4NITF sample exists (OD-05, O-12): these test the reader against the
// writer and the TRE layouts of STDI-0002-1 Appendix AF as NFX (MIT, github.com/mdegan2020/NFX)
// implements them.
//
//   mie_multicam.ntf  camera set 1 (layer EO, u8): three cameras in an L-shaped mosaic (CAMSDA IDLVL /
//                     IALVL / ILOC), two temporal blocks per camera, each one image segment of four
//                     frames (IMODE F); block 1 has one DT per frame (uneven spacing), block 2 one DT
//                     for every frame; REFERENCE_FRAME_NUM aligns the cameras. Camera set 2 (layer IR,
//                     u16): one camera, five one-frame segments (NUMBER_DT 0) written out of time order.
//                     MIMCSA per layer, TMINTA, MTIMFA per set with one temporal block held in another
//                     file of the collection (no image segment). Pixel values encode camera and frame.
//   mie_long40.ntf    40 one-frame 128² segments at 25 frames/s (a "long" sequence for the OPFS store).
//   mie_j2k.ntf       four 1024 × 1024 frames, each a lossless JPEG 2000 codestream (IC C8) of 256²
//                     tiles (opj_compress from the gw-te environment), for the tile-wise region decode.
//   E:\gwb24\data-motion\mie_wami_8k_j2k.ntf (with --large): six 8192 × 8192 frames, 1024² tiles, a
//                     resolution-first (RLCP) with one tile-part per resolution, a ramp with 4 bits of noise (about 4.6 bits a pixel losslessly, like imagery): the
//                     region-decode measurements (too large for the repository).
//
//   node build/fixtures/fx24-motion.mjs [--large]

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { writeNitfSegments } from '../../app/src/formats/nitf-writer.js';
import { encodeMTIMSA, encodeCAMSDA, encodeMIMCSA, encodeMTIMFA, encodeTMINTA, parseStamp } from '../../app/src/formats/mie4nitf.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'fixtures', 'fx24', 'motion');
const LARGE = 'E:/gwb24/data-motion';
const OPJ = join(ROOT, '..', 'TE-tools', 'mamba', 'envs', 'gw-te', 'Library', 'bin', 'opj_compress.exe');
mkdirSync(OUT, { recursive: true });

const T0 = parseStamp('20251025120000.000000000').ns;
const S = 1_000_000_000n;
const truth = {};

// Corners [UL, UR, LR, LL] of a w × h camera at pixel offset (x, y) in a mosaic whose origin moves east
// with the frame (1e-4° per pixel, about 11 m; 0.002° per frame). IGEOLO keeps whole arc-seconds.
const corners = (x, y, w, h, f) => {
  const lon0 = -117 + f * 0.002 + x * 1e-4;
  const lat0 = 34.5 - y * 1e-4;
  return [[lat0, lon0], [lat0, lon0 + (w - 1) * 1e-4], [lat0 - (h - 1) * 1e-4, lon0 + (w - 1) * 1e-4], [lat0 - (h - 1) * 1e-4, lon0]];
};

// ---- mie_multicam.ntf -------------------------------------------------------------------------
{
  const CAMS = [
    { id: '11111111-1111-4111-8111-111111111111', desc: 'EO camera A', idlvl: 1, ialvl: 0, iloc: [0, 0], x: 0, y: 0 },
    { id: '22222222-2222-4222-8222-222222222222', desc: 'EO camera B (east of A)', idlvl: 2, ialvl: 1, iloc: [0, 96], x: 96, y: 0 },
    { id: '33333333-3333-4333-8333-333333333333', desc: 'EO camera C (south of A)', idlvl: 3, ialvl: 1, iloc: [64, 0], x: 0, y: 64 },
  ];
  const IR = { id: '44444444-4444-4444-8444-444444444444', desc: 'IR camera', idlvl: 1, ialvl: 0, iloc: [0, 0] };
  const W = 96;
  const H = 64;
  // Block 1: frames 1–4 at 0, 0.4, 1.0, 1.5 s (DT 0, 400, 600, 500 ms); block 2: frames 5–8 at 2.0 + 0.5 k s
  // (one DT of 500 ms: T(n) = base + n × DT, base 1.5 s).
  const b1 = [0n, 400_000_000n, 600_000_000n, 500_000_000n];
  const times = [0n, 400_000_000n, 1_000_000_000n, 1_500_000_000n, 2_000_000_000n, 2_500_000_000n, 3_000_000_000n, 3_500_000_000n].map((d) => T0 + d);
  const list = [];
  const blocks = CAMS.map(() => []);
  const px = (cam, f, x, y) => (cam * 50 + f * 5 + ((x + y) % 5)) & 255;
  for (let b = 0; b < 2; b++) {
    CAMS.forEach((c, ci) => {
      const frames = [];
      for (let k = 0; k < 4; k++) {
        const f = b * 4 + k;
        const p = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = px(ci, f, x, y);
        frames.push([p]);
      }
      const seg = list.length + 1;
      const mtimsa = b === 0 ? encodeMTIMSA({ segment: seg, layer: 'EO', set: 1, camera: c.id, interval: 1, block: b + 1, rate: 2, refFrame: b * 4 + 1, base: T0, mult: 1n, dts: b1, frames: 4 }) : encodeMTIMSA({ segment: seg, layer: 'EO', set: 1, camera: c.id, interval: 1, block: b + 1, rate: 2, refFrame: b * 4 + 1, base: T0 + 1_500_000_000n, mult: 1_000_000n, dts: [500n], frames: 4 });
      list.push({ img: { width: W, height: H, bands: 1, type: 'u8', frames }, opts: { iid1: `MIE${String(seg).padStart(3, '0')}`, iid2: `${c.desc} block ${b + 1}`, idatim: '20251025120000', icat: 'VIS', imode: 'F', idlvl: seg, corners: corners(c.x, c.y, W, H, b * 4), tres: [['MTIMSA', mtimsa]] } });
      blocks[ci].push({ start: times[b * 4], end: times[b * 4 + 3] + 500_000_000n, segment: seg });
    });
  }
  // IR: frames at 0, 1, 2, 3, 4 s, one segment each, written in the order 3, 1, 5, 2, 4.
  const irOrder = [2, 0, 4, 1, 3];
  const irSeg = [];
  for (const f of irOrder) {
    const p = new Uint16Array(80 * 60);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 80; x++) p[y * 80 + x] = 1000 + f * 100 + x;
    const seg = list.length + 1;
    irSeg[f] = seg;
    list.push({ img: { width: 80, height: 60, bands: 1, type: 'u16', planes: [p] }, opts: { iid1: `MIE${String(seg).padStart(3, '0')}`, iid2: `IR frame ${f + 1}`, idatim: '20251025120000', icat: 'IR', abpp: 12, idlvl: seg, corners: corners(0, 0, 80, 60, f), tres: [['MTIMSA', encodeMTIMSA({ segment: seg, layer: 'IR', set: 2, camera: IR.id, interval: 1, block: f + 1, rate: 1, refFrame: f + 1, base: T0 + BigInt(f) * S, mult: 1n, dts: [], frames: 1 })]] } });
  }
  const fileTres = [
    ['CAMSDA', encodeCAMSDA([{ cameras: CAMS.map((c) => ({ ...c, layer: 'EO', nrows: H, ncols: W })) }, { cameras: [{ ...IR, layer: 'IR', nrows: 60, ncols: 80 }] }])],
    ['MIMCSA', encodeMIMCSA({ layer: 'EO', rate: 2, minRate: 1.6, maxRate: 2.5, decoder: 'NC' })],
    ['MIMCSA', encodeMIMCSA({ layer: 'IR', rate: 1, decoder: 'NC' })],
    ['TMINTA', encodeTMINTA([{ index: 1, start: T0, end: T0 + 6n * S }])],
    // Set 1: every block here, plus camera A's block 3 (4.0–6.0 s) held in another file of the collection.
    ['MTIMFA', encodeMTIMFA({ layer: 'EO', set: 1, interval: 1, cameras: CAMS.map((c, ci) => ({ id: c.id, blocks: ci === 0 ? [...blocks[ci], { start: T0 + 4n * S, end: T0 + 6n * S, segment: null }] : blocks[ci] })) })],
    ['MTIMFA', encodeMTIMFA({ layer: 'IR', set: 2, interval: 1, cameras: [{ id: IR.id, blocks: [0, 1, 2, 3, 4].map((f) => ({ start: T0 + BigInt(f) * S, end: T0 + BigInt(f + 1) * S, segment: irSeg[f] })) }] })],
  ];
  const bytes = writeNitfSegments(list, { title: 'GIS Workbench MIE4NITF test: two camera sets', fileTres });
  writeFileSync(join(OUT, 'mie_multicam.ntf'), bytes);
  truth.multicam = {
    sequences: [
      { set: 1, layer: 'EO', width: 192, height: 128, frames: 8, cameras: CAMS.map((c) => [c.x, c.y]), times: times.map(String), pixel: 'cam*50 + frame*5 + (x+y)%5 (u8)', gapPixel: [150, 100] },
      { set: 2, layer: 'IR', width: 80, height: 60, frames: 5, times: [0, 1, 2, 3, 4].map((f) => String(T0 + BigInt(f) * S)), pixel: '1000 + frame*100 + x (u16)', fileOrder: irOrder.map((f) => f + 1) },
    ],
    gaps: 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// ---- mie_long40.ntf: 40 one-frame segments at 25 frames/s (the OPFS tile store starts at 32 frames) ----
{
  const N = 40;
  const list = [];
  for (let f = 0; f < N; f++) {
    const p = new Uint8Array(128 * 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) p[y * 128 + x] = (x + 3 * f) & 255;
    const seg = f + 1;
    list.push({ img: { width: 128, height: 128, bands: 1, type: 'u8', planes: [p] }, opts: { iid1: `MIE${String(seg).padStart(3, '0')}`, iid2: `frame ${seg}`, idatim: '20251025120000', icat: 'VIS', idlvl: seg, corners: corners(0, 0, 128, 128, f), tres: [['MTIMSA', encodeMTIMSA({ segment: seg, layer: 'EO25', set: 1, camera: '66666666-6666-4666-8666-666666666666', interval: 1, block: seg, rate: 25, refFrame: seg, base: T0 + BigInt(f) * 40_000_000n, mult: 1n, dts: [], frames: 1 })]] } });
  }
  const bytes = writeNitfSegments(list, { title: 'GIS Workbench MIE4NITF test: 40 frames at 25/s', fileTres: [['MIMCSA', encodeMIMCSA({ layer: 'EO25', rate: 25, decoder: 'NC' })]] });
  writeFileSync(join(OUT, 'mie_long40.ntf'), bytes);
  truth.long40 = { frames: N, rate: 25, pixel: '(x + 3*frame) & 255', sha256: createHash('sha256').update(bytes).digest('hex') };
}

// ---- JPEG 2000 frames ---------------------------------------------------------------------------
function j2kFrames({ n, size, tile, name, dir, value, opj = [] }) {
  if (!existsSync(OPJ)) {
    console.log(`skip ${name}: ${OPJ} not found`);
    return null;
  }
  const tmp = join(tmpdir(), `gw-fx24-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const list = [];
  for (let f = 0; f < n; f++) {
    const pgm = join(tmp, `f${f}.pgm`);
    const head = Buffer.from(`P5\n${size} ${size}\n255\n`);
    const px = Buffer.alloc(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[y * size + x] = value(f, x, y);
    writeFileSync(pgm, Buffer.concat([head, px]));
    const j2k = join(tmp, `f${f}.j2k`);
    execFileSync(OPJ, ['-i', pgm, '-o', j2k, '-t', `${tile},${tile}`, '-n', '6', ...opj], { stdio: 'pipe' });
    const cs = new Uint8Array(readFileSync(j2k));
    const seg = f + 1;
    list.push({ img: { width: size, height: size, bands: 1, type: 'u8', planes: [] }, opts: { codestream: cs, iid1: `MIE${String(seg).padStart(3, '0')}`, iid2: `WAMI frame ${seg}`, idatim: '20251025120000', icat: 'VIS', idlvl: seg, corners: corners(0, 0, size, size, f), tres: [['MTIMSA', encodeMTIMSA({ segment: seg, layer: 'WAMI', set: 1, camera: '55555555-5555-4555-8555-555555555555', interval: 1, block: seg, rate: 2, refFrame: seg, base: T0 + BigInt(f) * 500_000_000n, mult: 1n, dts: [], frames: 1 })]] } });
  }
  rmSync(tmp, { recursive: true, force: true });
  const fileTres = [['MIMCSA', encodeMIMCSA({ layer: 'WAMI', rate: 2, decoder: 'C8', profile: 'ISO/IEC 15444-1', level: 'class2' })]];
  const bytes = writeNitfSegments(list, { title: `GIS Workbench MIE4NITF test: ${n} JPEG 2000 frames of ${size}²`, fileTres });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
  return { frames: n, size, tile, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
// A diagonal ramp that moves 8 px a frame, with a frame-number band at rows 100–119.
const ramp = (f, x, y) => (y >= 100 && y < 120 ? 40 * (f + 1) : (x + y + 8 * f) & 255);
truth.j2k = j2kFrames({ n: 4, size: 1024, tile: 256, name: 'mie_j2k.ntf', dir: OUT, value: ramp });
if (process.argv.includes('--large')) {
  truth.large = j2kFrames({ n: 6, size: 8192, tile: 1024, name: 'mie_wami_8k_j2k.ntf', dir: LARGE, opj: ['-p', 'RLCP', '-TP', 'R'], value: (f, x, y) => (y >= 100 && y < 120 ? 40 * (f + 1) : (((x >> 3) + (y >> 3) + 8 * f) & 0xf0) | (Math.imul(x * 7919 + y * 104729 + f, 2654435761) >>> 28)) });
  if (truth.large) truth.large.path = `${LARGE}/mie_wami_8k_j2k.ntf`;
}
if (!truth.large && existsSync(join(OUT, 'fx24_motion_truth.json'))) truth.large = JSON.parse(readFileSync(join(OUT, 'fx24_motion_truth.json'), 'utf8')).large ?? null;
writeFileSync(join(OUT, 'fx24_motion_truth.json'), JSON.stringify(truth, null, 1));
writeFileSync(
  join(OUT, 'SOURCE.txt'),
  [
    'fixtures/fx24/motion: synthetic MIE4NITF test files (REQ-GAP-47)',
    'Generated by build/fixtures/fx24-motion.mjs with the app\'s own NITF writer and MIE4NITF TRE encoders;',
    'JPEG 2000 codestreams by opj_compress (OpenJPEG, gw-te environment), lossless, 256 x 256 tiles.',
    'Licence: generated test data of this repository (no third-party content).',
    'No independently produced MIE4NITF sample exists (OD-05, O-12): these files check the reader',
    'against the writer and the TRE layouts of STDI-0002-1 Appendix AF as NFX implements them.',
    `mie_multicam.ntf sha256 ${truth.multicam.sha256}`,
    `mie_long40.ntf sha256 ${truth.long40.sha256}`,
    truth.j2k ? `mie_j2k.ntf sha256 ${truth.j2k.sha256}` : '',
  ].join('\n') + '\n',
);
console.log(JSON.stringify(truth, null, 1));
