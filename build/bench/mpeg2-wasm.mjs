// S-58 benchmark (REQ-GAP-48): decode an MPEG-2 stream through the `mpeg` WASM bundle exactly as
// the decode worker does (workers/decode/mpv.js: TS/PS demux in WASM, decode, RGBA conversion)
// and report the time per frame. Real time for 29.97 frames/s is 33.4 ms per frame.
//
//   node build/bench/mpeg2-wasm.mjs <file.ts|.mpg|.m2v> [container ts|ps|es] [frames] [--i420] [--no-rgba] [--mpeg=<wasm>]
//   (wasm from $CARGO_TARGET_DIR/wasm32-unknown-unknown/release, or --wasm-dir=<dir>)

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Bundle } from '../../app/src/wasm/abi.js';
import { MpvSession } from '../../app/src/workers/decode/mpv.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v = true] = a.slice(2).split('='); return [k, v]; }));
const [path, container = path.endsWith('.ts') ? 'ts' : path.endsWith('.m2v') ? 'es' : 'ps', maxFrames = '300'] = args;
const target = opt['wasm-dir'] ?? join(JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: 'crates', encoding: 'utf8' })).target_directory, 'wasm32-unknown-unknown', 'release');
const bundle = (n) => new Bundle(new WebAssembly.Module(readFileSync(join(target, n.endsWith('.wasm') ? n : `gw_bundle_${n}.wasm`))), n);

function diskFile(p) {
  const size = statSync(p).size;
  return {
    name: p,
    size,
    slice: (a = 0, b = size) => ({
      arrayBuffer: async () => {
        const n = Math.max(0, Math.min(size, b) - a);
        const buf = Buffer.alloc(n);
        const fd = openSync(p, 'r');
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

const mpeg = bundle(opt.mpeg ?? 'mpeg');
const parse = bundle('parse');
const file = diskFile(path);
let sid = 0;
if (container === 'ts') {
  // The video PID from the index (the first 4 MB is enough).
  const id = parse.x.gw_ts_open();
  const b = new Uint8Array(await file.slice(0, Math.min(file.size, 4 << 20)).arrayBuffer());
  const [p, n] = parse.put(b);
  parse.x.gw_ts_push(id, p, n, 0);
  parse.free(p, n);
  parse.x.gw_ts_finish(id);
  sid = parse.outJson().video.pid;
} else if (container === 'ps') sid = 0xe0;
const s = new MpvSession(mpeg, parse, { file, container, sid, codec: 'mp2v' });
const info = await s.open(0);
s.seek({ off: 0, baseAu: 0 });
// Read all input first, so the timing is decode (+ RGBA unless --no-rgba) only.
const blocks = [];
while (!s.eof) blocks.push(await s.readBlock());
const t0 = performance.now();
let n = 0;
let rgbaMs = 0;
let decMs = 0;
let convMs = 0;
const x = mpeg.x;
const drain = () => {
  for (;;) {
    let t = performance.now();
    if (x.gw_mpv_decode(s.dec) !== 0) throw new Error('decode failed');
    const text = mpeg.outText();
    decMs += performance.now() - t;
    if (!text) return;
    n++;
    if (!opt['no-rgba']) {
      t = performance.now();
      if (opt.i420) x.gw_mpv_i420(s.dec);
      else x.gw_mpv_rgba(s.dec);
      convMs += performance.now() - t;
      mpeg.outBytes();
      rgbaMs += performance.now() - t;
    }
  }
};
for (const b of blocks) {
  if (n >= Number(maxFrames)) break;
  s.push(b);
  drain();
}
s.ctl(1);
drain();
const ms = performance.now() - t0;
mpeg.x.gw_mpv_info(s.dec);
const after = mpeg.outJson();
s.close();
console.log(JSON.stringify({ file: path, container, width: info.width, height: info.height, fps: info.fps, frames: n, ms: Math.round(ms), msPerFrame: +(ms / n).toFixed(2), realTimeX: +((1000 / info.fps) / (ms / n)).toFixed(2), decoder: after, decodeMsPerFrame: +(decMs / n).toFixed(2), rgbaMsPerFrame: +(rgbaMs / n).toFixed(2), convertMsPerFrame: +(convMs / n).toFixed(2) }));
