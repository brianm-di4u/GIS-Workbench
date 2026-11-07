// Derive the ARIDPCM quantisation tables that MIL-STD-188-197A keeps on magnetic media (appendix B,
// never released) by the standard's own procedure (§6.3): compute the deltas of sample imagery,
// split each (rate, busyness class, level) distribution into 2^bits regions of equal population and
// take each region's expected delta. The published 0.75 bpp tables (appendix A) are derived the same
// way first and compared, which measures how well the procedure and training set reproduce the real
// tables. Writes crates/gw-codec/src/aridpcm_tables.rs.
//
//   node crates/gw-codec/tools/aridpcm_tables.mjs [--loops=N] <8-bit NITF>... [--11 <11-bit NITF>...]
//
// Training imagery: uncompressed 8-bit MONO images of the NTB NITF 2.0/2.1 conformance suites
// (public US Government test data) and 11-bit panchromatic WorldView NITF chips. The prediction
// rules and edge replication are those of crates/gw-codec/src/aridpcm.rs.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { openNitf } = await import(pathToFileURL(join(ROOT, 'app/src/workers/decode/nitf.js')).href);
const { Bundle } = await import(pathToFileURL(join(ROOT, 'app/src/wasm/abi.js')).href);
const tdir = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: join(ROOT, 'crates'), encoding: 'utf8' })).target_directory;
const wasm = (n) => new WebAssembly.Module(readFileSync(join(tdir, 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`)));
const parse = new Bundle(wasm('parse'), 'parse');
globalThis.self ??= {};
self.GW = { ensure: async (n) => new Bundle(wasm(n), n) };

const RATES = {
  8: [
    ['0.75', [[8, 5, 0, 0], [8, 5, 2, 0], [8, 6, 4, 0], [8, 7, 4, 2]], [45, 80, 123]],
    ['1.40', [[8, 5, 3, 0], [8, 7, 3, 0], [8, 7, 5, 0], [8, 7, 6, 3]], [40, 58, 99]],
    ['2.30', [[8, 7, 3, 0], [8, 7, 6, 0], [8, 7, 5, 3], [8, 8, 7, 4]], [38, 55, 94]],
    ['4.50', [[8, 7, 3, 2], [8, 7, 5, 3], [8, 8, 7, 5], [8, 8, 8, 7]], [38, 48, 77]],
  ],
  11: [
    ['1.40', [[11, 7, 0, 0], [11, 8, 2, 0], [11, 8, 5, 0], [11, 8, 6, 4]], [28, 72, 140]],
    ['2.30', [[11, 8, 3, 0], [11, 8, 4, 0], [11, 8, 6, 3], [11, 11, 8, 4]], [26, 68, 140]],
    ['4.50', [[11, 6, 3, 2], [11, 6, 5, 3], [11, 11, 6, 5], [11, 11, 11, 6]], [24, 54, 116]],
    ['6.40', [[11, 11, 7, 4], [11, 11, 7, 5], [11, 11, 11, 6], [11, 11, 11, 7]], [24, 54, 116]],
  ],
};
// Appendix A, for the comparison.
const APPX_A = {
  '0,1': [-71, -49, -38, -32, -27, -23, -20, -17, -14, -12, -10, -8, -6, -4, -3, -1, 1, 2, 4, 6, 8, 10, 12, 14, 16, 19, 22, 26, 31, 37, 46, 72],
  '1,2': [-24, -6, 6, 24],
  '2,2': [-68, -37, -23, -15, -9, -6, -3, -1, 1, 4, 7, 10, 16, 24, 37, 70],
  '3,2': [-117, -72, -50, -36, -25, -17, -10, -5, -1, 3, 7, 14, 25, 45, 82, 166],
  '3,3': [-47, -8, 4, 43],
};
const ORDER = [[0, 0], [0, 4], [4, 0], [4, 4], [0, 2], [2, 0], [2, 2], [0, 6], [2, 4], [2, 6], [4, 2], [6, 0], [6, 2], [4, 6], [6, 4], [6, 6]];
for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if (i % 2 || j % 2) ORDER.push([i, j]);
const levelOf = (k) => (k === 0 ? 0 : k < 4 ? 1 : k < 16 ? 2 : 3);
function predict(l, i, j) {
  const s = i % 4 === 0 && j % 4 === 0 ? 4 : i % 2 === 0 && j % 2 === 0 ? 2 : 1;
  if (i % (2 * s) === 0) return (l[i][j - s] + l[i][j + s]) >> 1;
  if (j % (2 * s) === 0) return (l[i - s][j] + l[i + s][j]) >> 1;
  return (l[i - s][j - s] + l[i - s][j + s] + l[i + s][j - s] + l[i + s][j + s]) >> 2;
}
function edges(l, top, left, stage) {
  if (stage === 0) {
    if (top && left) l[8][8] = l[0][0];
    else if (top) l[8][8] = l[0][8];
    else if (left) l[8][8] = l[8][0];
    if (top) l[8][0] = l[0][0];
    if (left) l[0][8] = l[0][0];
  } else if (stage === 2) {
    if (top) l[8][4] = l[0][4];
    if (left) l[4][8] = l[4][0];
  } else {
    if (top) (l[8][2] = l[0][2]), (l[8][6] = l[0][6]);
    if (left) (l[2][8] = l[2][0]), (l[6][8] = l[6][0]);
  }
}

/** Per neighbourhood: busyness and the deltas of levels 2–4 (k = 1..63), open loop, or closed loop
 * through `tables` (class → level → E[] for one rate) when given. */
function deltas(img, w, h, depth, rate, tables) {
  const bx = Math.floor(w / 8);
  const by = Math.floor(h / 8);
  const rec = tables ? new Int32Array(w * h) : null;
  const out = [];
  const nb = (src, nx, ny) => {
    const l = Array.from({ length: 9 }, () => new Array(9).fill(0));
    const x0 = nx * 8;
    const y0 = ny * 8;
    if (nx > 0) for (let i = 0; i < 8; i++) l[i][8] = src[(y0 + 7 - i) * w + x0 - 1];
    if (ny > 0) for (let j = 0; j < 8; j++) l[8][j] = src[(y0 - 1) * w + x0 + 7 - j];
    if (nx > 0 && ny > 0) l[8][8] = src[(y0 - 1) * w + x0 - 1];
    return l;
  };
  for (let ny = 0; ny < by; ny++)
    for (let nx = 0; nx < bx; nx++) {
      const o = nb(img, nx, ny);
      for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) o[i][j] = img[(ny * 8 + 7 - i) * w + nx * 8 + 7 - j];
      const top = ny === 0;
      const left = nx === 0;
      const ob = o.map((r) => r.slice());
      edges(ob, top, left, 0);
      edges(ob, top, left, 2);
      edges(ob, top, left, 3);
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = 16; k < 64; k++) {
        const [i, j] = ORDER[k];
        const d = ob[i][j] - predict(ob, i, j);
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      const cls = rate[2].filter((t) => hi - lo >= t).length;
      const d = new Int32Array(64);
      if (!tables) {
        for (let k = 1; k < 64; k++) d[k] = ob[ORDER[k][0]][ORDER[k][1]] - predict(ob, ORDER[k][0], ORDER[k][1]);
      } else {
        const l = nb(rec, nx, ny);
        l[0][0] = o[0][0];
        edges(l, top, left, 0);
        for (let lv = 1; lv < 4; lv++) {
          const bits = rate[1][cls][lv];
          const t = tables[cls]?.[lv];
          for (let k = [0, 1, 4, 16][lv]; k < [1, 4, 16, 64][lv]; k++) {
            const [i, j] = ORDER[k];
            const p = predict(l, i, j);
            d[k] = o[i][j] - p;
            if (bits === depth) l[i][j] = o[i][j];
            else if (bits === 0 || !t) l[i][j] = p;
            else {
              let best = 0;
              for (let c = 1; c < t.length; c++) if (Math.abs(t[c] - d[k]) < Math.abs(t[best] - d[k])) best = c;
              l[i][j] = p + t[best];
            }
          }
          edges(l, top, left, lv === 1 ? 2 : 3);
        }
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) rec[(ny * 8 + 7 - i) * w + nx * 8 + 7 - j] = Math.max(0, Math.min((1 << depth) - 1, l[i][j]));
      }
      out.push([cls, d]);
    }
  return out;
}

/** Equal-population regions → expected values, made strictly increasing. */
function tableOf(values, bits) {
  const n = 1 << bits;
  const v = Float64Array.from(values).sort();
  const t = [];
  for (let k = 0; k < n; k++) {
    const a = Math.floor((k * v.length) / n);
    const b = Math.max(a + 1, Math.floor(((k + 1) * v.length) / n));
    let s = 0;
    for (let q = a; q < b; q++) s += v[q];
    t.push(Math.round(s / (b - a)));
  }
  // Strictly increasing around the median (codes must be distinct values).
  const mid = n >> 1;
  for (let k = mid; k < n; k++) if (k > 0 && t[k] <= t[k - 1]) t[k] = t[k - 1] + 1;
  for (let k = mid - 1; k >= 0; k--) if (t[k] >= t[k + 1]) t[k] = t[k + 1] - 1;
  return t;
}

function derive(images, depth, loops) {
  const result = {};
  for (const rate of RATES[depth]) {
    let tables = null;
    for (let pass = 0; pass <= loops; pass++) {
      const pools = Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => []));
      for (const { px, w, h } of images) for (const [cls, d] of deltas(px, w, h, depth, rate, tables)) for (let k = 1; k < 64; k++) pools[cls][levelOf(k)].push(d[k]);
      const next = Array.from({ length: 4 }, () => []);
      for (let c = 0; c < 4; c++)
        for (let lv = 1; lv < 4; lv++) {
          const bits = rate[1][c][lv];
          if (bits === 0 || bits === depth) continue;
          // A class with too few samples borrows the pool of the nearest class with enough.
          let pool = pools[c][lv];
          for (let dc = 1; pool.length < 64 << bits && dc < 4; dc++) pool = pool.concat(pools[c - dc]?.[lv] ?? [], pools[c + dc]?.[lv] ?? []);
          next[c][lv] = tableOf(pool, bits);
        }
      tables = next;
    }
    result[rate[0]] = tables;
  }
  return result;
}

async function load(path, depth) {
  // A raw little-endian 16-bit chip named <stem>_<W>x<H>.u16 (e.g. cut from a WorldView pan TIFF with
  // gdal_translate -of ENVI -ot UInt16 -srcwin ...).
  const raw = /_(\d+)x(\d+)\.u16$/i.exec(path);
  if (raw) {
    const [w, h] = [Number(raw[1]), Number(raw[2])];
    const b = readFileSync(path);
    const src = new Uint16Array(b.buffer.slice(b.byteOffset, b.byteOffset + w * h * 2));
    const [w8, h8] = [w & ~7, h & ~7];
    const px = Int32Array.from({ length: w8 * h8 }, (_, k) => Math.min((1 << depth) - 1, src[Math.floor(k / w8) * w + (k % w8)]));
    return [{ px, w: w8, h: h8, name: path.split(/[\\/]/).pop() }];
  }
  const file = new File([readFileSync(path)], path);
  const r = await openNitf(file, parse);
  const out = [];
  for (const s of r.sources) {
    if (s.bands !== 1) continue;
    const w = Math.min(s.width, 2048) & ~7;
    const h = Math.min(s.height, 2048) & ~7;
    if (w < 64 || h < 64) continue;
    const [p] = await s.readWindow(0, 0, w, h, [0]);
    const px = Int32Array.from(p, (v) => (depth === 11 ? Math.min(2047, v) : v));
    // Skip blank and synthetic images (flat or with few grey levels).
    const levels = new Set(px).size;
    if (levels < (depth === 8 ? 64 : 256)) continue;
    out.push({ px, w, h, name: `${path.split(/[\\/]/).pop()}[${s.imageIndex}]` });
  }
  return out;
}

const args = process.argv.slice(2);
const loops = Number((args.find((a) => a.startsWith('--loops=')) ?? '--loops=2').slice(8));
const split = args.indexOf('--11');
const files8 = args.filter((a, i) => !a.startsWith('--') && (split < 0 || i < split));
const files11 = split < 0 ? [] : args.slice(split + 1).filter((a) => !a.startsWith('--'));
const img8 = (await Promise.all(files8.map((f) => load(f, 8)))).flat();
const img11 = (await Promise.all(files11.map((f) => load(f, 11)))).flat();
console.log(`training: ${img8.length} 8-bit images (${img8.map((i) => i.name).join(', ')}); ${img11.length} 11-bit (${img11.map((i) => i.name).join(', ')})`);
const t8 = derive(img8, 8, loops);
const t11 = img11.length ? derive(img11, 11, loops) : null;

// How well the procedure reproduces the published tables.
let worst = 0;
for (const [key, pub] of Object.entries(APPX_A)) {
  const [c, lv] = key.split(',').map(Number);
  const ours = t8['0.75'][c][lv];
  const mad = pub.reduce((a, v, k) => a + Math.abs(v - ours[k]), 0) / pub.length;
  const spread = pub[pub.length - 1] - pub[0];
  worst = Math.max(worst, mad / spread);
  console.log(`0.75 class ${'ABCD'[c]} level ${lv + 1}: mean |derived − appendix A| = ${mad.toFixed(1)} (range ${spread})\n  A: ${pub.join(' ')}\n  D: ${ours.join(' ')}`);
}

const lines = [
  '//! ARIDPCM quantisation tables for the rates whose tables MIL-STD-188-197A keeps on magnetic media',
  '//! (appendix B, not released): derived by the standard\'s §6.3 procedure (equal-population regions',
  '//! of sample-image deltas, expected value per region). Generated by',
  '//! crates/gw-codec/tools/aridpcm_tables.mjs — do not edit. Decodes that use them are approximate.',
  `//! Training: ${img8.length} 8-bit NTB conformance images${img11.length ? `, ${img11.length} 11-bit panchromatic chips` : ''}; ${loops} closed-loop passes.`,
  `//! Check: the same procedure reproduces the published 0.75 bpp tables to within ${(worst * 100).toFixed(1)} % of their range.`,
  '',
  'pub(super) fn table(depth: u8, rate: u8, class: u8, level: u8) -> Option<&\'static [i16]> {',
  '    Some(match (depth, rate, class, level) {',
];
for (const [depth, set] of [[8, t8], [11, t11]]) {
  if (!set) continue;
  RATES[depth].forEach(([name], ri) => {
    if (depth === 8 && ri === 0) return; // appendix A
    set[name].forEach((byLevel, c) =>
      byLevel.forEach((t, lv) => {
        if (t) lines.push(`        (${depth}, ${ri}, ${c}, ${lv}) => &[${t.join(', ')}],`);
      }),
    );
  });
}
lines.push('        _ => return None,', '    })', '}', '');
writeFileSync(join(ROOT, 'crates/gw-codec/src/aridpcm_tables.rs'), lines.join('\n'));
console.log('wrote crates/gw-codec/src/aridpcm_tables.rs');
