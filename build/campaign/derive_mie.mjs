// Derived MIE4NITF (REQ-FMT-14) from real drone video: frames of the three BAMBI thermal flights
// (fmv-bambi-flights) at 2 frames/s become NITF image segments with MTIMSA timing TREs (same layout
// as build/fixtures/fxformats.mjs) and IGEOLO footprints from the flight telemetry (nadir camera:
// half-width = height above the frame-centre ground × tan(hfov/2)). One file per flight; the
// flight_306 file writes its segments out of time order to test ordering. No public MIE4NITF sample
// exists (OD-05). Registers the item in sources/archive-derived.json.
//
//   node build/campaign/derive_mie.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS, HERE } from './corpus-lib.mjs';
import { writeNitfSegments } from '../../app/src/formats/nitf-writer.js';

const FF = join(HERE, '..', '..', '..', 'TE-tools', 'mamba', 'envs', 'gw-te', 'Library', 'bin', 'ffmpeg.exe');
const ID = 'derived-mie4nitf-bambi';
const OUT = join(CORPUS, ID);
const SRC = join(CORPUS, 'fmv-bambi-flights', 'derived');
const FLIGHTS = [
  ['flight_258', 'DJI_20241021165448_0001_T_point0', false],
  ['flight_306', 'DJI_20241119101935_0003_T', true],
  ['flight_316', 'DJI_20240709090401_0001_T_point0', false],
];
const W = 640;
const H = 512;
const FPS = 2;
const rad = Math.PI / 180;
mkdirSync(OUT, { recursive: true });

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
const stamp = (ms) => {
  const d = new Date(ms);
  const p = (v, k = 2) => String(v).padStart(k, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000`;
};

const files = [];
const recipe = [];
for (const [flight, stem, shuffle] of FLIGHTS) {
  const rows = readFileSync(join(SRC, flight, `${stem}.csv`), 'utf8').trim().split(/\r?\n/);
  const cols = rows[0].split(',');
  const col = (r, k) => r.split(',')[cols.indexOf(k)];
  const tel = rows.slice(1).map((r) => ({ t: Date.parse(col(r, 'time')), lat: +col(r, 'lat'), lon: +col(r, 'lon'), hae: +col(r, 'hae'), heading: +col(r, 'heading'), hfov: +col(r, 'hfov'), fcHae: +col(r, 'fc_hae') }));
  const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', join(SRC, flight, `${stem}.ts`), '-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const n = Math.floor(raw.length / (W * H));
  const t0 = tel[0].t;
  const near = (t) => tel.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b));
  const frames = [];
  for (let k = 0; k < n; k++) {
    const t = t0 + (k * 1000) / FPS;
    const s = near(t);
    const agl = Math.max(5, s.hae - (Number.isFinite(s.fcHae) ? s.fcHae : s.hae - 50));
    const hw = agl * Math.tan((s.hfov / 2) * rad);
    const hh = (hw * H) / W;
    const mLat = 110_946;
    const mLon = 111_320 * Math.cos(s.lat * rad);
    const corner = (x, y) => {
      const a = s.heading * rad; // rotate the image frame by the platform heading (x right, y up)
      const e = x * Math.cos(a) + y * Math.sin(a);
      const nn = -x * Math.sin(a) + y * Math.cos(a);
      return [s.lat + nn / mLat, s.lon + e / mLon];
    };
    const mtimsa = num(k + 1, 3) + '01' + pad('BAMBI-THERMAL', 36) + '001' + pad(`DJI ${stem}`.slice(0, 36), 36) + num(1, 6) + num(1, 3) + pad(FPS.toFixed(5).padStart(13, '0'), 13) + num(k + 1, 9) + stamp(t) + be(1_000_000, 8) + be(1, 1) + be(1, 4) + be(0, 4);
    if (mtimsa.length !== 152) throw new Error(`MTIMSA is ${mtimsa.length} bytes`);
    frames.push({
      k,
      img: { width: W, height: H, bands: 1, type: 'u8', planes: [new Uint8Array(raw.subarray(k * W * H, (k + 1) * W * H))] },
      opts: { iid1: `MIE${num(k + 1, 3)}`, iid2: `${flight} frame ${k + 1}`, idatim: stamp(t).slice(0, 14), icat: 'IR', irep: 'MONO', corners: [corner(-hw, hh), corner(hw, hh), corner(hw, -hh), corner(-hw, -hh)], tres: [['MTIMSA', mtimsa]] },
    });
  }
  const order = shuffle ? frames.map((f, i) => ({ f, key: (i * 7) % frames.length })).sort((a, b) => a.key - b.key).map((x) => x.f) : frames;
  const name = `${flight}_thermal_mie4nitf.ntf`;
  writeFileSync(join(OUT, name), writeNitfSegments(order.map((f) => ({ img: f.img, opts: f.opts })), { title: `MIE4NITF ${flight} thermal (${n} frames at ${FPS}/s)` }));
  files.push({ name, url: null, role: 'primary' });
  recipe.push(`ffmpeg -vf fps=${FPS},scale=${W}:${H},format=gray ${stem}.ts → ${n} frames; MTIMSA per segment; IGEOLO from ${stem}.csv${shuffle ? '; segments written out of time order' : ''}`);
}

const entry = {
  id: ID,
  area: 'fmv',
  title: 'MIE4NITF frame sequences from the three BAMBI thermal drone flights (2 frames/s, MTIMSA timing, telemetry footprints)',
  source: 'Derived from fmv-bambi-flights',
  landing: 'build/campaign/derive_mie.mjs',
  licence: 'CC BY 4.0 (BAMBI Raw Dataset, Zenodo)',
  attribution: 'BAMBI project (bambi.eco), Zenodo record 18983480',
  tier: 'A',
  origin: 'derived',
  format: 'NITF 2.1 MIE4NITF (MTIMSA)',
  profile: '640×512 8-bit IR frames, one image segment per frame; written by app/src/formats/nitf-writer.js writeNitfSegments',
  files,
  sign: null,
  derivation: recipe.join('; '),
  notes: 'Generated by build/campaign/derive_mie.mjs. Footprints are approximate (nadir assumption, heading rotation).',
  feeds: ['mie.play', 'ingest'],
  covers: ['fmt:nitf.mie4nitf', 'fmt:nitf.v21', 'fmt:nitf.multiimage'],
  pairs: [],
};
const srcFile = join(HERE, 'sources', 'archive-derived.json');
const all = existsSync(srcFile) ? JSON.parse(readFileSync(srcFile, 'utf8')) : [];
const i = all.findIndex((e) => e.id === ID);
if (i >= 0) all[i] = entry;
else all.push(entry);
writeFileSync(srcFile, JSON.stringify(all, null, 1));
console.log(`${ID}: ${files.map((f) => f.name).join(', ')}`);
