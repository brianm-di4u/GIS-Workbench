// MPEG-2 video in WebAssembly (REQ-GAP-48, S-58): the Rust decoder in the `mpeg` bundle, driven
// through the decode-worker module (app/src/workers/decode/mpv.js) exactly as the player drives it,
// against ffmpeg's decode of the same frames (`-idct simple`, I420; MD5 per frame in
// fixtures/fx24/motion/mpeg2_truth.json): every frame bit-exact, in display order, after seeks.
// The corpus files (SCN-30 data, E:\TE-corpus) are checked by the Rust differential test
// crates/gw-codec/tests/mpeg2v_ref.rs.
//
//   node build/fixtures/fx24-motion-mpeg2.mjs   (writes the fixtures and the truth)

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, openSync, readSync, statSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Bundle } from '../../app/src/wasm/abi.js';
import { MpvSession } from '../../app/src/workers/decode/mpv.js';

const DIR = resolve('fixtures', 'fx24', 'motion');
const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => join(target ?? '', 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`);
const have = target && existsSync(wasm('mpeg')) && existsSync(wasm('parse')) && existsSync(join(DIR, 'mpeg2_truth.json'));
const truth = have ? JSON.parse(readFileSync(join(DIR, 'mpeg2_truth.json'), 'utf8')) : null;
const bundle = (n) => new Bundle(new WebAssembly.Module(readFileSync(wasm(n))), n);
const mpeg2 = have && !!bundle('mpeg').x.gw_mpv_new_kind;

function diskFile(path) {
  const size = statSync(path).size;
  return {
    name: path,
    size,
    slice: (a = 0, b = size) => ({
      arrayBuffer: async () => {
        const n = Math.max(0, Math.min(size, b) - a);
        const buf = Buffer.alloc(n);
        const fd = openSync(path, 'r');
        try {
          readSync(fd, buf, 0, n, a);
        } finally {
          closeSync(fd);
        }
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + n);
      },
    }),
  };
}

function tsIndex(parse, bytes) {
  const id = parse.x.gw_ts_open();
  const [p, n] = parse.put(bytes);
  expect(parse.x.gw_ts_push(id, p, n, 0)).toBe(0);
  parse.free(p, n);
  expect(parse.x.gw_ts_finish(id)).toBe(0);
  return parse.outJson();
}

/** Display order of the access units (decode order) by PTS → frame index of each AU. */
function displayIndex(idx) {
  const order = idx.video.pts.map((p, d) => [p, d]).sort((a, b) => a[0] - b[0]);
  const fi = new Array(order.length);
  order.forEach(([, d], k) => (fi[d] = k));
  return fi;
}

const md5 = (b) => createHash('md5').update(b).digest('hex');

async function open(name) {
  const lg = bundle('mpeg');
  const parse = bundle('parse');
  const file = diskFile(join(DIR, name));
  const idx = tsIndex(parse, new Uint8Array(await file.slice().arrayBuffer()));
  const s = new MpvSession(lg, parse, { file, container: 'ts', sid: idx.video.pid, auPts: idx.video.pts, codec: 'mp2v' });
  const info = await s.open(idx.video.off[0]);
  return { lg, s, idx, info };
}

describe.skipIf(!have || !mpeg2)('MPEG-2 video decoder in WebAssembly (REQ-GAP-48)', () => {
  for (const name of ['mpeg2_i576_klv.ts', 'mpeg2_fields.ts']) {
    it(`${name}: every frame bit-exact against ffmpeg, in display order`, async () => {
      const t = truth.files[name];
      const { s, idx, info } = await open(name);
      expect(info).toMatchObject({ hasSeq: true, mpeg2: true, decoder: 'mpeg2', width: t.width, height: t.height, progressiveSequence: false });
      expect(idx.video.codec).toBe('mp2v');
      expect(idx.video.count).toBe(t.frames);
      const fi = displayIndex(idx);
      s.seek({ off: idx.video.off[0], baseAu: 0 });
      const got = [];
      for (;;) {
        const r = await s.run({ count: 8, pixels: 'i420' });
        for (const f of r.frames) got.push([fi[f.au], md5(f.i420)]);
        if (r.eof) break;
      }
      expect(got.length).toBe(t.frames);
      // Output order is display order, and each frame is ffmpeg's.
      expect(got.map((g) => g[0])).toEqual([...Array(t.frames).keys()]);
      const exact = got.filter(([k, h]) => h === t.md5[k]).length;
      expect(exact).toBe(t.frames);
      s.lg.x.gw_mpv_info(s.dec);
      const after = s.lg.outJson();
      expect(after.errors).toBe(0);
      if (name === 'mpeg2_fields.ts') expect(after.fieldPictures).toBeGreaterThanOrEqual(8);
      else expect(after.interlacedFrames).toBe(t.frames);
      s.close();
    });
  }

  it('seeks land on the exact frame (closed and open GOPs, B pictures after the seek point)', async () => {
    const name = 'mpeg2_i576_klv.ts';
    const t = truth.files[name];
    const { s, idx } = await open(name);
    const fi = displayIndex(idx);
    const keys = new Set(idx.video.key);
    for (const target of [57, 3, 118, 61, 0, 90]) {
      // The player's seek point (shell/mpeg1media.js seekPoint): the keyframe at or before the
      // target's access unit whose PTS is not after the target.
      const d = fi.indexOf(target);
      const want = idx.video.pts[d];
      let k = d;
      while (k > 0 && !(keys.has(k) && idx.video.pts[k] <= want)) k--;
      let base = k;
      while (base > 0 && idx.video.off[base - 1] === idx.video.off[k]) base--;
      s.seek({ off: idx.video.off[k], baseAu: base, minPts: want });
      const r = await s.run({ count: 1, pixels: 'i420' });
      expect(fi[r.frames[0].au]).toBe(target);
      expect(md5(r.frames[0].i420)).toBe(t.md5[target]);
    }
    s.close();
  });

  it('RGBA output (SIMD128 rows) is the I420 output through the integer BT.601 conversion of the MPEG-1 path, at every pixel', async () => {
    const { s, idx, info } = await open('mpeg2_i576_klv.ts');
    s.seek({ off: idx.video.off[0], baseAu: 0 });
    const a = (await s.run({ count: 1, pixels: 'i420' })).frames[0];
    s.seek({ off: idx.video.off[0], baseAu: 0 });
    const b = (await s.run({ count: 1 })).frames[0];
    const { width: w, height: h } = info;
    const y = a.i420;
    const cb = y.subarray(w * h);
    const cr = cb.subarray((w / 2) * (h / 2));
    const clamp = (v) => Math.max(0, Math.min(255, v));
    let worst = 0;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const yy = ((y[py * w + px] - 16) * 76309) >> 16;
      const u = cb[(py >> 1) * (w / 2) + (px >> 1)] - 128;
      const v = cr[(py >> 1) * (w / 2) + (px >> 1)] - 128;
      const rgb = [clamp(yy + ((v * 104597) >> 16)), clamp(yy - ((u * 25674 + v * 53278) >> 16)), clamp(yy + ((u * 132201) >> 16))];
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(rgb[c] - b.rgba[(py * w + px) * 4 + c]));
    }
    expect(worst).toBe(0);
    s.close();
  });

  it('refuses a 4:2:2 Profile stream by name (the player then offers the sidecar)', async () => {
    const { s } = await open('mpeg2_422.ts').catch((e) => ({ s: null, e }));
    // open() throws: the sequence extension's chroma_format is 4:2:2.
    expect(s).toBe(null);
    const lg = bundle('mpeg');
    const parse = bundle('parse');
    const file = diskFile(join(DIR, 'mpeg2_422.ts'));
    const idx = tsIndex(parse, new Uint8Array(await file.slice().arrayBuffer()));
    const s2 = new MpvSession(lg, parse, { file, container: 'ts', sid: idx.video.pid, codec: 'mp2v' });
    await expect(s2.open(idx.video.off[0])).rejects.toThrow(/4:2:2/);
    s2.close();
  });

  it('garbage after a valid sequence header gives damaged pictures, not a trap', async () => {
    const lg = bundle('mpeg');
    const dec = lg.x.gw_mpv_new_kind(2);
    const head = [0, 0, 1, 0xb3, 0x2d, 0x02, 0x40, 0x33, 0xff, 0xff, 0xe0, 0x18, 0, 0, 1, 0xb5, 0x14, 0x82, 0x00, 0x01, 0x00, 0x00];
    let seed = 7;
    const body = [];
    for (let k = 0; k < 30; k++) {
      body.push(0, 0, 1, 0x00, k >> 2, ((k & 3) << 6) | ((1 + (k % 3)) << 3), 0xff, 0xff, 0xf8, 0, 0, 1, 0xb5, 0x82, 0x22, 0x10 | [3, 1, 2][k % 3], 0x5a, 0x80);
      for (let sl = 1; sl <= 3; sl++) {
        body.push(0, 0, 1, sl);
        for (let i = 0; i < 700; i++) {
          seed = (seed * 1103515245 + 12345) >>> 0;
          body.push(seed >>> 24);
        }
      }
    }
    const bytes = new Uint8Array([...head, ...body]);
    const [p, n] = lg.put(bytes);
    expect(lg.x.gw_mpv_push(dec, p, n)).toBe(0);
    lg.free(p, n);
    lg.x.gw_mpv_ctl(dec, 1);
    let frames = 0;
    for (let i = 0; i < 100; i++) {
      expect(lg.x.gw_mpv_decode(dec)).toBe(0);
      if (!lg.outText()) break;
      expect(lg.x.gw_mpv_rgba(dec)).toBe(0);
      expect(lg.outBytes().length).toBe(720 * 576 * 4);
      frames++;
    }
    expect(frames).toBeGreaterThan(0);
    lg.x.gw_mpv_free(dec);
  });
});

// The corpus MPEG-2 KLV transport streams (SCN-30 data, E:\TE-corpus\derived-fmv-variants; test
// only, never bundled): every frame of each 60 s file through the TS demuxer and the decoder,
// against `ffmpeg -idct simple -f framemd5` (gw-te environment). Skipped when either is missing.
const CORPUS = resolve(process.env.TE_CORPUS ?? '../TE-corpus', 'derived-fmv-variants');
const FFMPEG = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin/ffmpeg.exe';
// The 1080p SCN-30 file by default (about 30 s); all three with GW_MPEG2_ALL=1 (about 90 s).
const corpusFiles = (process.env.GW_MPEG2_ALL ? ['truck_mpeg2_klv.ts', 'dayflight_mpeg2_klv.ts', 'nightir_mpeg2_klv.ts'] : ['truck_mpeg2_klv.ts']).filter((n) => existsSync(join(CORPUS, n)));

describe.skipIf(!have || !mpeg2 || !corpusFiles.length || !existsSync(FFMPEG))('MPEG-2 decoder on the corpus MPEG-2 KLV transport streams (SCN-30)', () => {
  for (const name of corpusFiles) {
    it(`${name}: every frame bit-exact against ffmpeg`, async () => {
      const path = join(CORPUS, name);
      const ref = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-idct', 'simple', '-i', path, '-map', '0:v:0', '-f', 'framemd5', '-pix_fmt', 'yuv420p', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 })
        .split('\n')
        .filter((l) => /^\s*0,/.test(l))
        .map((l) => l.trim().split(/,\s*/).at(-1));
      const lg = bundle('mpeg');
      const parse = bundle('parse');
      const file = diskFile(path);
      // Index the whole stream as the player does (KLV included).
      const id = parse.x.gw_ts_open();
      for (let off = 0; off < file.size; off += 8 << 20) {
        const b = new Uint8Array(await file.slice(off, Math.min(file.size, off + (8 << 20))).arrayBuffer());
        const [p, n] = parse.put(b);
        expect(parse.x.gw_ts_push(id, p, n, off)).toBe(0);
        parse.free(p, n);
      }
      expect(parse.x.gw_ts_finish(id)).toBe(0);
      const idx = parse.outJson();
      const s = new MpvSession(lg, parse, { file, container: 'ts', sid: idx.video.pid, auPts: idx.video.pts, codec: 'mp2v' });
      const info = await s.open(idx.video.off[0]);
      s.seek({ off: idx.video.off[0], baseAu: 0 });
      const t0 = performance.now();
      const got = [];
      for (;;) {
        const r = await s.run({ count: 16, pixels: 'i420' });
        for (const f of r.frames) got.push(md5(f.i420));
        if (r.eof) break;
      }
      const ms = performance.now() - t0;
      const exact = got.filter((h, k) => h === ref[k]).length;
      console.log(`${name}: ${got.length} frames ${info.width}×${info.height} (ffmpeg ${ref.length}), ${exact} bit-exact; ${(ms / got.length).toFixed(2)} ms/frame incl. TS demux (WASM, Node); KLV packets indexed ${idx.klv.length}`);
      expect(got.length).toBe(ref.length);
      expect(exact).toBe(ref.length);
      s.close();
    }, 600000);
  }
});
