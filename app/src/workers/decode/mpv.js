// MPEG program streams and MPEG-1/MPEG-2 video in the decode worker (FC-22, REQ-FMT-52,
// REQ-GAP-48). The Rust `mpeg` bundle indexes program streams (gw_ps_*) and decodes MPEG-1 and
// MPEG-2 video (gw_mpv_*); the `parse` bundle extracts transport-stream PES (gw_ts_pes) for video
// inside MPEG-TS.
//
// A decoder session reads its stream sequentially from a file offset: each read takes a block,
// keeps the elementary-stream bytes of the video stream from its complete packets, and resumes
// where the first incomplete packet starts. A seek resets the decoder and moves the reader to the
// packet holding a keyframe's start; pictures come out in display order, each tagged with its
// decode ordinal, so the caller maps them to its access-unit index (`baseAu + ord`).

import { wasmError } from '../errors.js';

const BLOCK = 256 << 10;
const MAX_BLOCK = 16 << 20;

/** `[u32 json len][json][pad4][bytes]` → {meta, data}. */
export function unpack(out) {
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const jl = dv.getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + jl)));
  const at = 4 + jl + ((4 - ((4 + jl) % 4)) % 4);
  return { meta, data: out.subarray(at) };
}

function call(b, bytes, fn) {
  const [p, n] = b.put(bytes);
  try {
    const rc = fn(p, n);
    if (rc !== 0) throw wasmError(b, { code: rc });
  } finally {
    b.free(p, n);
  }
}

/** Index a program stream (or a bare MPEG video elementary stream) → JSON (see gw-parse ps.rs). */
export async function psIndex(lg, file, { block = 4 << 20, job = null } = {}) {
  const id = lg.x.gw_ps_open();
  try {
    for (let off = 0; off < file.size; off += block) {
      job?.checkCancel();
      const b = new Uint8Array(await file.slice(off, Math.min(file.size, off + block)).arrayBuffer());
      call(lg, b, (p, n) => lg.x.gw_ps_push(id, p, n, off));
      job?.progress(Math.min(1, (off + block) / file.size));
    }
  } catch (e) {
    lg.x.gw_ps_finish(id);
    throw e;
  }
  if (lg.x.gw_ps_finish(id) !== 0) throw wasmError(lg);
  return lg.outJson();
}

/**
 * One MPEG-1 or MPEG-2 (`codec` 'mp2v') decoder reading `file`. `container`: 'ps' | 'es' | 'ts'; `sid`: the PS stream id or
 * the TS PID of the video; `auPts`: presentation time of every access unit (decode order).
 */
export class MpvSession {
  constructor(lg, parse, { file, container, sid, auPts = [], codec = 'mp1v' }) {
    this.lg = lg;
    this.parse = parse;
    this.file = file;
    this.container = container;
    this.sid = sid;
    this.auPts = auPts;
    this.codec = codec;
    // A `mpeg` bundle without the MPEG-2 decoder (older build) has no gw_mpv_new_kind.
    if (codec === 'mp2v' && !lg.x.gw_mpv_new_kind) throw new Error('this build has no MPEG-2 decoder');
    this.dec = codec === 'mp2v' ? lg.x.gw_mpv_new_kind(2) : lg.x.gw_mpv_new();
    this.pos = 0;
    this.eof = false;
    this.baseAu = 0;
    this.minPts = -Infinity;
    this.info = null;
  }

  /** Elementary-stream bytes of the next block from `pos`; advances `pos`. */
  async readBlock(size = BLOCK) {
    const size0 = size;
    for (;;) {
      const end = Math.min(this.file.size, this.pos + size);
      const atEnd = end >= this.file.size;
      const b = new Uint8Array(await this.file.slice(this.pos, end).arrayBuffer());
      let data;
      let next;
      if (this.container === 'es') {
        data = b;
        next = end;
      } else {
        const bundle = this.container === 'ts' ? this.parse : this.lg;
        call(bundle, b, (p, n) => (this.container === 'ts' ? bundle.x.gw_ts_pes(p, n, this.pos, this.sid, atEnd ? 1 : 0) : bundle.x.gw_ps_es(p, n, this.pos, this.sid, atEnd ? 1 : 0)));
        const u = unpack(bundle.outBytes());
        data = u.data;
        next = u.meta.next ?? end;
      }
      if (next > this.pos || atEnd) {
        this.pos = atEnd ? this.file.size : next;
        this.eof = atEnd;
        return data;
      }
      // One packet larger than the block (a big I picture in one TS PES): read more at once.
      if (size >= MAX_BLOCK) {
        this.pos = end; // skip it: it cannot be read
        return new Uint8Array(0);
      }
      size = Math.max(size0, size) * 2;
    }
  }

  push(data) {
    if (data.length) call(this.lg, data, (p, n) => this.lg.x.gw_mpv_push(this.dec, p, n));
  }

  ctl(what) {
    const rc = this.lg.x.gw_mpv_ctl(this.dec, what);
    if (rc !== 0) throw wasmError(this.lg, { code: rc });
  }

  /** Read from `seqOff` until the sequence header is known → {width, height, fps, …}. */
  async open(seqOff = 0) {
    this.pos = seqOff;
    for (let k = 0; k < 64 && !this.eof; k++) {
      this.push(await this.readBlock(64 << 10));
      this.ctl(3);
      if (this.lg.outText() === '1') break;
    }
    if (this.lg.x.gw_mpv_info(this.dec) !== 0) throw wasmError(this.lg);
    this.info = this.lg.outJson();
    if (!this.info.hasSeq) throw new Error(this.codec === 'mp2v' ? 'no MPEG-2 sequence header and extension in the video stream' : 'no MPEG-1 sequence header in the video stream');
    this.ctl(2);
    this.eof = false;
    return this.info;
  }

  /** Reset to the packet at `off`; pictures map to access units from `baseAu`; those shown before `minPts` are dropped. */
  seek({ off, baseAu, minPts = -Infinity }) {
    this.ctl(2);
    this.pos = off;
    this.eof = false;
    this.baseAu = baseAu;
    this.minPts = minPts;
  }

  /**
   * Decode until `count` pictures are out (or `wantAu` is out, or the stream ends) →
   * {frames: [{au, ord, type, rgba | i420}], eof}; pictures before `minPts` (or other than
   * `wantAu`) are not returned. `pixels: 'i420'` returns MPEG-2 pictures as packed I420.
   */
  async run({ count = 8, wantAu = null, maxBlocks = 4096, job = null, pixels = 'rgba' } = {}) {
    // 'i420': packed I420 (MPEG-2 sessions; for a WebCodecs VideoFrame), else RGBA.
    const i420 = pixels === 'i420' && this.codec === 'mp2v' && !!this.lg.x.gw_mpv_i420;
    const frames = [];
    const lg = this.lg;
    let ended = false;
    for (let blocks = 0; ; ) {
      // Drain what the buffered input yields.
      for (;;) {
        const rc = lg.x.gw_mpv_decode(this.dec);
        if (rc !== 0) throw wasmError(lg, { code: rc });
        const text = lg.outText();
        if (!text) break;
        const o = JSON.parse(text);
        const au = this.baseAu + o.ord;
        const pts = this.auPts[au];
        const keep = wantAu === null ? !(pts < this.minPts) : au === wantAu;
        if (!keep) continue;
        if (i420) {
          if (lg.x.gw_mpv_i420(this.dec) !== 0) throw wasmError(lg);
          frames.push({ au, ord: o.ord, type: o.type, pts, i420: lg.outBytes() });
        } else {
          if (lg.x.gw_mpv_rgba(this.dec) !== 0) throw wasmError(lg);
          frames.push({ au, ord: o.ord, type: o.type, pts, rgba: lg.outBytes() });
        }
        if (wantAu !== null || frames.length >= count) return { frames, eof: false };
      }
      if (ended) return { frames, eof: true };
      if (this.eof) {
        this.ctl(1);
        ended = true;
        continue;
      }
      if (++blocks > maxBlocks) return { frames, eof: false };
      job?.checkCancel?.();
      this.push(await this.readBlock());
    }
  }

  close() {
    this.lg.x.gw_mpv_free(this.dec);
  }
}
