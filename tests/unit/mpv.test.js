// MPEG program streams and MPEG-1 video (FC-22, REQ-FMT-52): the Rust demuxer and decoder in the
// `mpeg` WASM bundle, driven through the worker module (app/src/workers/decode/mpv.js), against
// the FX-21 video fixtures and what ffprobe/ffmpeg (gw-te env, independent tools) report.
//
//   node build/fixtures/fxformats21.mjs --only=video   (writes fixtures/fx21/video)

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, openSync, readSync, statSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { psIndex, MpvSession, unpack } from '../../app/src/workers/decode/mpv.js';
import { tool } from '../../build/fixtures/fx21/video.mjs';

const DIR = resolve('fixtures', 'fx21', 'video');
const target = (() => {
  try {
    return JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
  } catch {
    return null;
  }
})();
const wasm = (n) => join(target ?? '', 'wasm32-unknown-unknown', 'release', `gw_bundle_${n}.wasm`);
const have = target && existsSync(wasm('mpeg')) && existsSync(wasm('parse')) && existsSync(join(DIR, 'video_truth.json'));
const truth = have ? JSON.parse(readFileSync(join(DIR, 'video_truth.json'), 'utf8')) : null;
const bundle = (n) => new Bundle(new WebAssembly.Module(readFileSync(wasm(n))), n);

/** A File-like view of a file on disk (slice → arrayBuffer). */
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

async function tsIndex(parse, file) {
  const id = parse.x.gw_ts_open();
  const b = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
  const [p, n] = parse.put(b);
  expect(parse.x.gw_ts_push(id, p, n, 0)).toBe(0);
  parse.free(p, n);
  expect(parse.x.gw_ts_finish(id)).toBe(0);
  return parse.outJson();
}

/** Seek arguments the player computes: the keyframe at or before `d` whose PTS is not after the target. */
function seekArgs(idx, d) {
  const v = idx.video;
  const keys = new Set(v.key);
  const want = v.pts[d];
  let k = d;
  while (k > 0 && !(keys.has(k) && v.pts[k] <= want)) k--;
  let base = k;
  while (base > 0 && v.off[base - 1] === v.off[k]) base--;
  return { off: v.off[k], baseAu: base, minPts: want };
}

function psnr(a, b, w, h) {
  let se = 0;
  for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) se += (a[p * 4 + c] - b[p * 3 + c]) ** 2;
  const mse = se / (w * h * 3);
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
}

describe.skipIf(!have)('MPEG program stream index (gw-parse ps.rs)', () => {
  it('indexes the MPEG-1 system stream like ffprobe', async () => {
    const lg = bundle('mpeg');
    const idx = await psIndex(lg, diskFile(join(DIR, 'mpeg1_ps.mpg')), { block: 300000 });
    const t = truth.files['mpeg1_ps.mpg'].video;
    expect(idx.container).toBe('ps');
    expect(idx.mpeg).toBe(1);
    expect(idx.systemHeader).toBe(true);
    expect(idx.video).toMatchObject({ pid: 0xe0, codec: 'mp1v', width: t.width, height: t.height, fps: 30 });
    expect(idx.video.count).toBe(t.packets);
    expect(idx.video.key.length).toBe(t.keyPackets);
    // The same picture types (decode order here, display order from ffprobe).
    const count = (s, c) => [...s].filter((x) => x === c).length;
    for (const c of 'IPB') expect(count(idx.video.types, c)).toBe(count(t.displayTypes, c));
    // Presentation times: one frame apart in display order, starting at the first coded PTS.
    const sorted = [...idx.video.pts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(Math.abs(sorted[i] - sorted[i - 1] - 3000)).toBeLessThanOrEqual(1);
    expect(idx.streams.some((s) => s.kind === 'audio' && s.pid === 0xc0)).toBe(true);
    expect(idx.errors).toEqual([]);
  });

  it('reads the KLV inserted in private stream 1, with its PTS', async () => {
    const lg = bundle('mpeg');
    const idx = await psIndex(lg, diskFile(join(DIR, 'mpeg1_ps_klv.mpg')));
    const k = truth.klvInserted;
    expect(idx.klv.length).toBe(k.count);
    expect(idx.klv.every((r) => r.packets.length === 1 && r.packets[0].kind === 'uas' && r.packets[0].ok === true)).toBe(true);
    expect(idx.klv[0].pts).toBe(k.first.pts);
    expect(idx.klv.at(-1).pts).toBe(k.last.pts);
    const time = idx.klv[0].packets[0].items.find((i) => i.t === 2).v;
    expect(time).toBe(k.first.timeUs);
    const lat = idx.klv[10].packets[0].items.find((i) => i.t === 13).v;
    expect(lat).toBeCloseTo(38.8895 + 0.0004, 5);
    expect(idx.video.count).toBe(truth.files['mpeg1_ps_klv.mpg'].video.packets);
  });

  it('indexes MPEG-2 program streams and bare elementary streams', async () => {
    const lg = bundle('mpeg');
    const m2 = await psIndex(lg, diskFile(join(DIR, 'mpeg2_ps.mpg')));
    const t2 = truth.files['mpeg2_ps.mpg'].video;
    expect(m2.mpeg).toBe(2);
    expect(m2.video).toMatchObject({ codec: 'mp2v', width: t2.width, height: t2.height, mpeg2: true, count: t2.packets });
    expect(m2.video.fps).toBeCloseTo(29.97, 2);
    const es = await psIndex(lg, diskFile(join(DIR, 'mpeg1.m1v')), { block: 100000 });
    expect(es.container).toBe('es');
    expect(es.video).toMatchObject({ codec: 'mp1v', count: truth.files['mpeg1.m1v'].video.packets, seqOff: 0 });
  });

  it('tells MPEG-1 from MPEG-2 video in transport streams', async () => {
    const parse = bundle('parse');
    const a = await tsIndex(parse, diskFile(join(DIR, 'mpeg1_ts_klv.ts')));
    expect(a.video.codec).toBe('mp1v');
    expect([a.video.width, a.video.height]).toEqual([640, 360]);
    expect(a.video.count).toBe(truth.files['mpeg1_ts_klv.ts'].video.packets);
    expect(a.klv.length).toBeGreaterThan(100);
    const b = await tsIndex(parse, diskFile(join(DIR, 'mpeg2_ts_klv.ts')));
    expect(b.video.codec).toBe('mp2v');
  });

  it('extracts elementary-stream bytes and resumes after a cut packet', () => {
    const lg = bundle('mpeg');
    const b = readFileSync(join(DIR, 'mpeg1_ps.mpg')).subarray(0, 100000);
    const [p, n] = lg.put(b);
    expect(lg.x.gw_ps_es(p, n, 0, 0xe0, 0)).toBe(0);
    lg.free(p, n);
    const { meta, data } = unpack(lg.outBytes());
    expect(meta.next).toBeGreaterThan(90000);
    expect(meta.next).toBeLessThanOrEqual(100000);
    expect([...data.subarray(0, 4)]).toEqual([0, 0, 1, 0xb3]);
  });
});

describe.skipIf(!have)('MPEG-1 video decoder (gw-codec mpeg1v.rs)', () => {
  const ffmpegOk = (() => {
    try {
      execFileSync(tool('ffmpeg'), ['-version']);
      return true;
    } catch {
      return false;
    }
  })();

  it('decodes the program stream in display order, matching ffmpeg, in real time', async () => {
    const lg = bundle('mpeg');
    const parse = bundle('parse');
    const file = diskFile(join(DIR, 'mpeg1_ps.mpg'));
    const idx = await psIndex(lg, file);
    const s = new MpvSession(lg, parse, { file, container: 'ps', sid: 0xe0, auPts: idx.video.pts });
    const info = await s.open(idx.video.seqOff);
    expect(info).toMatchObject({ width: 640, height: 480, mpeg2: false });
    s.seek({ off: idx.video.off[0], baseAu: 0 });
    const t0 = performance.now();
    const frames = [];
    for (;;) {
      const r = await s.run({ count: 16 });
      frames.push(...r.frames);
      if (r.eof) break;
    }
    const ms = (performance.now() - t0) / frames.length;
    console.log(`MPEG-1 640×480: ${frames.length} frames, ${ms.toFixed(2)} ms/frame (WASM, Node, incl. demux and RGBA)`);
    expect(frames.length).toBe(idx.video.count);
    for (let i = 1; i < frames.length; i++) expect(frames[i].pts).toBeGreaterThan(frames[i - 1].pts);
    expect(ms).toBeLessThan(1000 / 30);
    if (ffmpegOk) {
      const N = 45;
      const ref = execFileSync(tool('ffmpeg'), ['-v', 'error', '-i', join(DIR, 'mpeg1_ps.mpg'), '-frames:v', String(N), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
      let worst = 99;
      for (let k = 0; k < N; k++) worst = Math.min(worst, psnr(frames[k].rgba, ref.subarray(k * 640 * 480 * 3), 640, 480));
      console.log(`worst PSNR vs ffmpeg over ${N} frames: ${worst.toFixed(1)} dB`);
      expect(worst).toBeGreaterThan(40);
    }
    // A seek to a B picture in the middle lands exactly on it.
    const d = [...idx.video.types].findIndex((c, i) => c === 'B' && i > 150);
    const tp = idx.video.pts[d];
    const t1 = performance.now();
    s.seek(seekArgs(idx, d));
    const r = await s.run({ count: 1 });
    const seekMs = performance.now() - t1;
    console.log(`seek to frame ${d} (B): ${seekMs.toFixed(0)} ms`);
    expect(r.frames[0].au).toBe(d);
    expect(r.frames[0].pts).toBe(tp);
    const seq = frames.find((f) => f.au === d);
    expect(Buffer.compare(Buffer.from(seq.rgba), Buffer.from(r.frames[0].rgba))).toBe(0);
    expect(seekMs).toBeLessThan(1000);
    // A single exact frame (step / capture).
    s.seek({ ...seekArgs(idx, d), minPts: -Infinity });
    const one = await s.run({ wantAu: d });
    expect(one.frames).toHaveLength(1);
    expect(Buffer.compare(Buffer.from(seq.rgba), Buffer.from(one.frames[0].rgba))).toBe(0);
    s.close();
  });

  it('plays MPEG-1 inside MPEG-TS and bare elementary streams', async () => {
    const lg = bundle('mpeg');
    const parse = bundle('parse');
    const tsf = diskFile(join(DIR, 'mpeg1_ts_klv.ts'));
    const ti = await tsIndex(parse, tsf);
    const s = new MpvSession(lg, parse, { file: tsf, container: 'ts', sid: ti.video.pid, auPts: ti.video.pts });
    expect((await s.open(ti.video.off[0])).height).toBe(360);
    s.seek({ off: ti.video.off[0], baseAu: 0 });
    let n = 0;
    for (;;) {
      const r = await s.run({ count: 32 });
      n += r.frames.length;
      if (r.eof) break;
    }
    expect(n).toBe(ti.video.count);
    // Seek in TS.
    const d = 200;
    s.seek(seekArgs(ti, d));
    expect((await s.run({ wantAu: d })).frames[0].au).toBe(d);
    s.close();
    const esf = diskFile(join(DIR, 'mpeg1.m1v'));
    const ei = await psIndex(lg, esf);
    const e = new MpvSession(lg, parse, { file: esf, container: 'es', sid: 0, auPts: ei.video.pts });
    await e.open(0);
    e.seek({ off: 0, baseAu: 0 });
    let m = 0;
    for (;;) {
      const r = await e.run({ count: 50 });
      m += r.frames.length;
      if (r.eof) break;
    }
    expect(m).toBe(ei.video.count);
    e.close();
  });

  it('refuses MPEG-2 video by name', async () => {
    const lg = bundle('mpeg');
    const parse = bundle('parse');
    const file = diskFile(join(DIR, 'mpeg2_ps.mpg'));
    const s = new MpvSession(lg, parse, { file, container: 'ps', sid: 0xe0 });
    await expect(s.open(0)).rejects.toThrow(/MPEG-2/);
    s.close();
  });
});
