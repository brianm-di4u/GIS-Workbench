// FX-21 video group (SDP-2.1 FC-22, FC-23; REQ-FMT-52, REQ-FMV-15): MPEG program streams and
// MPEG-1/MPEG-2 video in transport streams, made with ffmpeg from the gw-te test environment
// (test generation only; ffmpeg is never bundled) and checked with ffprobe.
//
//   mpeg1_ps.mpg      MPEG-1 system stream: MPEG-1 video 640×480 @ 30 fps, 10 s, GOP 15 with two
//                     B pictures, MP2 audio (a VCD-like file)
//   mpeg1_ps_klv.mpg  the same with ST 0601 KLV (10 Hz, platform moving north-east) added in
//                     private stream 1 PES packets with PTS — ffmpeg cannot mux KLV into a
//                     program stream, so the packets are inserted here
//   mpeg1.m1v         a bare MPEG-1 video elementary stream (4 s)
//   mpeg1_ts_klv.ts   MPEG-1 video in MPEG-TS with the FX-10 seed's synchronous KLV stream
//   mpeg2_ps.mpg      MPEG-2 program stream (DVD style, 720×480 @ 29.97, 4 s) with AC-3-free MP2 audio
//   mpeg2_ts_klv.ts   MPEG-2 video in MPEG-TS with the FX-10 KLV stream (indexed; played through the
//                     sidecar transcode, REQ-FMV-15)
//
// video_truth.json records, per file, what ffprobe reports (format, streams, video frame count,
// picture types in decode order, size, rate) and the KLV packets inserted, for tests/unit/mpv.test.js.
//
//   node build/fixtures/fxformats21.mjs --only=video

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_BIN = join(ROOT, '..', 'TE-tools', 'mamba', 'envs', 'gw-te', 'Library', 'bin');
const SEED = join(ROOT, '..', 'Research', 'samples', 'mpegts-klv-synthetic', 'fx10_synthetic_klv.ts');

export function tool(name) {
  const exe = join(process.env.GW_TE_BIN ?? ENV_BIN, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
  return existsSync(exe) ? exe : name;
}

function ff(args) {
  execFileSync(tool('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
}

export function probe(file) {
  const j = JSON.parse(execFileSync(tool('ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', file], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  const v = j.streams.find((s) => s.codec_type === 'video');
  const frames = execFileSync(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,dts,flags', '-print_format', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const types = execFileSync(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pict_type', '-print_format', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((s) => s.trim()[0])
    .join('');
  return {
    format: j.format.format_name,
    streams: j.streams.map((s) => ({ type: s.codec_type, codec: s.codec_name, id: s.id ?? null, tag: s.codec_tag_string })),
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, rate: v.r_frame_rate, packets: frames.length, displayTypes: types, keyPackets: frames.filter((l) => /K/.test(l)).length } : null,
  };
}

// ---- ST 0601 KLV (written independently of the Rust decoder) ----

const UAS_KEY = [0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01, 0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00];
const be = (v, n) => Array.from({ length: n }, (_, k) => Number((BigInt.asUintN(8 * n, BigInt(Math.round(v))) >> BigInt(8 * (n - 1 - k))) & 0xffn));
const berLen = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);
function checksum(b) {
  let s = 0;
  for (let i = 0; i < b.length; i++) s = (s + (b[i] << (8 * ((i + 1) % 2)))) & 0xffff;
  return s;
}
export function uasPacket({ timeUs, lat, lon, msl, heading }) {
  const items = [
    [2, be(timeUs, 8)],
    [5, be((heading / 360) * 0xffff, 2)],
    [13, be((lat / 90) * 0x7fffffff, 4)],
    [14, be((lon / 180) * 0x7fffffff, 4)],
    [15, be(((msl + 900) / 19900) * 0xffff, 2)],
    [65, [17]],
  ];
  const body = [...items.flatMap(([t, v]) => [t, v.length, ...v]), 0x01, 0x02];
  const pkt = [...UAS_KEY, ...berLen(body.length + 2), ...body];
  const cs = checksum(pkt);
  pkt.push(cs >> 8, cs & 255);
  return Uint8Array.from(pkt);
}

// ---- program stream walking and KLV insertion ----

const ptsOf = (b, i) => ((b[i] >> 1) & 7) * 2 ** 30 + ((b[i + 1] << 7) | (b[i + 2] >> 1)) * 2 ** 15 + ((b[i + 3] << 7) | (b[i + 4] >> 1));
function ptsBytes(pts, marker) {
  const hi = Math.floor(pts / 2 ** 30) & 7;
  const mid = Math.floor(pts / 2 ** 15) & 0x7fff;
  const lo = pts & 0x7fff;
  return [(marker << 4) | (hi << 1) | 1, mid >> 7, ((mid & 0x7f) << 1) | 1, lo >> 7, ((lo & 0x7f) << 1) | 1];
}

/** Units of an MPEG-1 system stream: [{off, end, code, pts?}] (packs and packets). */
function units(b) {
  const out = [];
  let i = 0;
  while (i + 4 <= b.length) {
    if (!(b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1)) throw new Error(`fx21 video: lost sync at ${i}`);
    const c = b[i + 3];
    if (c === 0xba) {
      const len = b[i + 4] >> 6 === 1 ? 14 + (b[i + 13] & 7) : 12;
      out.push({ off: i, end: i + len, code: c, scr: ptsOf(b, i + 4) });
      i += len;
    } else if (c === 0xb9) {
      out.push({ off: i, end: i + 4, code: c });
      i += 4;
    } else {
      const len = (b[i + 4] << 8) | b[i + 5];
      let pts = null;
      if (c >= 0xc0 && c <= 0xef) {
        let k = i + 6;
        while (b[k] === 0xff) k++;
        if (b[k] >> 6 === 1) k += 2;
        if (b[k] >> 4 === 2 || b[k] >> 4 === 3) pts = ptsOf(b, k);
      }
      out.push({ off: i, end: i + 6 + len, code: c, pts });
      i += 6 + len;
    }
  }
  return out;
}

/** Insert private-stream-1 KLV packs (MPEG-1 syntax, with PTS) into an MPEG-1 system stream. */
function insertKlv(ps, { rateHz = 10, seconds }) {
  const us = units(ps);
  const v0 = us.find((u) => u.code === 0xe0 && u.pts !== null).pts;
  const t0Us = 1_761_436_800_000_000; // 2025-10-26 00:00:00 UTC
  const inserted = [];
  const parts = [];
  let next = 0;
  let packStart = 0;
  const n = Math.round(rateHz * seconds);
  for (let k = 0; k < us.length; k++) {
    const u = us[k];
    if (u.code === 0xb9) {
      parts.push(ps.subarray(u.off, u.end));
      continue;
    }
    if (u.code === 0xba) packStart = u.off;
    const nx = us[k + 1];
    if (nx && nx.code !== 0xba && nx.code !== 0xb9) continue;
    parts.push(ps.subarray(packStart, us[k].end));
    // After each pack, the KLV packets due before the next pack's clock.
    const nextScr = us.slice(k + 1).find((x) => x.code === 0xba)?.scr ?? Infinity;
    while (next < n && v0 + (next * 90000) / rateHz <= nextScr + 45000) {
      const t = next / rateHz;
      const pts = Math.round(v0 + t * 90000);
      const pkt = uasPacket({ timeUs: t0Us + t * 1e6, lat: 38.8895 + 0.0004 * t, lon: -77.0353 + 0.0005 * t, msl: 1500 + 2 * t, heading: 45 });
      const pes = [0, 0, 1, 0xbd, 0, 0, ...ptsBytes(pts, 2), ...pkt];
      const len = pes.length - 6;
      pes[4] = len >> 8;
      pes[5] = len & 255;
      const pack = [0, 0, 1, 0xba, ...ptsBytes(Math.max(0, pts - 9000), 2), 0x80, 0x1b, 0x83];
      pack[4] = 0x20 | (pack[4] & 0x0e) | 1;
      parts.push(Uint8Array.from([...pack, ...pes]));
      inserted.push({ index: next, pts, timeUs: t0Us + t * 1e6 });
      next++;
    }
  }
  const out = Buffer.concat(parts);
  return { out, inserted, videoPts0: v0 };
}

export async function generate(outDir) {
  const made = [];
  const truth = { generator: 'build/fixtures/fx21/video.mjs', ffmpeg: execFileSync(tool('ffmpeg'), ['-version'], { encoding: 'utf8' }).split('\n')[0].trim(), files: {} };
  const p = (n) => join(outDir, n);
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30'];
  const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'];
  // 1. MPEG-1 system stream with audio.
  ff([...src, ...tone, '-t', '10', '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg1video', '-b:v', '900k', '-bf', '2', '-g', '15', '-c:a', 'mp2', '-b:a', '64k', '-f', 'mpeg', p('mpeg1_ps.mpg')]);
  made.push('mpeg1_ps.mpg');
  // 2. The same with KLV in private stream 1.
  {
    const { out, inserted, videoPts0 } = insertKlv(readFileSync(p('mpeg1_ps.mpg')), { seconds: 10 });
    writeFileSync(p('mpeg1_ps_klv.mpg'), out);
    made.push('mpeg1_ps_klv.mpg');
    truth.klvInserted = { file: 'mpeg1_ps_klv.mpg', count: inserted.length, rateHz: 10, videoPts0, first: inserted[0], last: inserted.at(-1) };
  }
  // 3. Bare elementary stream.
  ff([...src, '-t', '4', '-c:v', 'mpeg1video', '-b:v', '900k', '-bf', '2', '-g', '15', '-f', 'mpeg1video', p('mpeg1.m1v')]);
  made.push('mpeg1.m1v');
  // 4–6. Transport streams with the FX-10 seed's KLV, and an MPEG-2 program stream.
  if (existsSync(SEED)) {
    ff(['-i', SEED, '-map', '0:v', '-map', '0:d', '-c:v', 'mpeg1video', '-b:v', '900k', '-bf', '2', '-g', '15', '-c:d', 'copy', '-f', 'mpegts', p('mpeg1_ts_klv.ts')]);
    made.push('mpeg1_ts_klv.ts');
    ff(['-i', SEED, '-map', '0:v', '-map', '0:d', '-c:v', 'mpeg2video', '-b:v', '1200k', '-bf', '2', '-g', '15', '-c:d', 'copy', '-f', 'mpegts', p('mpeg2_ts_klv.ts')]);
    made.push('mpeg2_ts_klv.ts');
  } else {
    console.warn(`fx21 video: ${SEED} not found; the TS fixtures are skipped`);
  }
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=720x480:rate=30000/1001', ...tone, '-t', '4', '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg2video', '-b:v', '1500k', '-bf', '2', '-g', '15', '-c:a', 'mp2', '-b:a', '64k', '-f', 'vob', p('mpeg2_ps.mpg')]);
  made.push('mpeg2_ps.mpg');
  for (const f of made) truth.files[f] = probe(p(f));
  // Independent checks: every file probes with its video stream and expected codec.
  const want = { 'mpeg1_ps.mpg': ['mpeg', 'mpeg1video'], 'mpeg1_ps_klv.mpg': ['mpeg', 'mpeg1video'], 'mpeg1.m1v': ['mpegvideo', 'mpeg1video'], 'mpeg1_ts_klv.ts': ['mpegts', 'mpeg1video'], 'mpeg2_ts_klv.ts': ['mpegts', 'mpeg2video'], 'mpeg2_ps.mpg': ['mpeg', 'mpeg2video'] };
  for (const f of made) {
    const t = truth.files[f];
    const [fmt, codec] = want[f];
    if (t.format !== fmt || t.video?.codec !== codec) throw new Error(`fx21 video: ffprobe reads ${f} as ${t.format}/${t.video?.codec}, expected ${fmt}/${codec}`);
    if (/_klv\.ts$/.test(f) && !t.streams.some((s) => s.codec === 'klv')) throw new Error(`fx21 video: ffprobe finds no KLV stream in ${f}`);
  }
  if (truth.files['mpeg1_ps_klv.mpg'].video.packets !== truth.files['mpeg1_ps.mpg'].video.packets) throw new Error('fx21 video: inserting KLV changed the video packets ffprobe reads');
  writeFileSync(p('video_truth.json'), JSON.stringify(truth, null, 1));
  rmSync(p('ffreport.log'), { force: true });
  return [...made, 'video_truth.json'];
}
