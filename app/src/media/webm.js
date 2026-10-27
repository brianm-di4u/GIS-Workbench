// Minimal WebM (Matroska) muxer for one VP8/VP9 video track from WebCodecs chunks
// (REQ-IMG-25), and a GIF89a encoder (256-colour palette, LZW). No dependencies.

const enc = new TextEncoder();

function vint(n) {
  // 8-byte EBML size (0x01 + 7 bytes): simple and valid for any size we write.
  const b = new Uint8Array(8);
  b[0] = 0x01;
  let v = BigInt(n);
  for (let i = 7; i >= 1; i--) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function idBytes(id) {
  const out = [];
  for (let s = 24; s >= 0; s -= 8) if (id >>> s || out.length) out.push((id >>> s) & 0xff);
  return new Uint8Array(out.length ? out : [0]);
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const o = new Uint8Array(n);
  let k = 0;
  for (const p of parts) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

function uint(v) {
  const out = [];
  let x = BigInt(Math.max(0, Math.round(v)));
  do {
    out.unshift(Number(x & 0xffn));
    x >>= 8n;
  } while (x > 0n);
  return new Uint8Array(out);
}

function float64(v) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return b;
}

const el = (id, data) => {
  const body = data instanceof Uint8Array ? data : concat(data);
  return concat([idBytes(id), vint(body.length), body]);
};

/** chunks: [{data: Uint8Array, timestamp (µs), key: bool}] → WebM bytes. */
export function muxWebM({ width, height, codec = 'V_VP8', chunks, durationMs }) {
  const ebml = el(0x1a45dfa3, [el(0x4286, uint(1)), el(0x42f7, uint(1)), el(0x42f2, uint(4)), el(0x42f3, uint(8)), el(0x4282, enc.encode('webm')), el(0x4287, uint(2)), el(0x4285, uint(2))]);
  const info = el(0x1549a966, [el(0x2ad7b1, uint(1_000_000)), el(0x4d80, enc.encode('GIS Workbench')), el(0x5741, enc.encode('GIS Workbench')), el(0x4489, float64(durationMs))]);
  const tracks = el(0x1654ae6b, [el(0xae, [el(0xd7, uint(1)), el(0x73c5, uint(1)), el(0x83, uint(1)), el(0x86, enc.encode(codec)), el(0xe0, [el(0xb0, uint(width)), el(0xba, uint(height))])])]);
  const clusters = [];
  let cur = null;
  for (const c of chunks) {
    const ms = Math.round(c.timestamp / 1000);
    if (!cur || (c.key && ms - cur.t > 1000) || ms - cur.t > 30000) {
      if (cur) clusters.push(el(0x1f43b675, [el(0xe7, uint(cur.t)), ...cur.blocks]));
      cur = { t: ms, blocks: [] };
    }
    const rel = ms - cur.t;
    const hdr = new Uint8Array([0x81, (rel >> 8) & 0xff, rel & 0xff, c.key ? 0x80 : 0x00]);
    cur.blocks.push(el(0xa3, concat([hdr, c.data])));
  }
  if (cur) clusters.push(el(0x1f43b675, [el(0xe7, uint(cur.t)), ...cur.blocks]));
  const segment = el(0x18538067, [info, tracks, ...clusters]);
  return concat([ebml, segment]);
}

// ---- GIF89a ----

/** A 256-entry palette for RGBA frames: grey when the frames are grey, else 6×7×6 levels. */
function paletteFor(frames) {
  let grey = true;
  for (const f of frames.slice(0, 3)) {
    for (let i = 0; i < f.data.length && grey; i += 64) if (Math.abs(f.data[i] - f.data[i + 1]) > 3 || Math.abs(f.data[i + 1] - f.data[i + 2]) > 3) grey = false;
  }
  const pal = new Uint8Array(768);
  if (grey) {
    for (let i = 0; i < 256; i++) pal.set([i, i, i], i * 3);
    return { pal, index: (r) => r };
  }
  let k = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) pal.set([Math.round((r * 255) / 5), Math.round((g * 255) / 6), Math.round((b * 255) / 5)], 3 * k++);
  return { pal, index: (r, g, b) => Math.round((r * 5) / 255) * 42 + Math.round((g * 6) / 255) * 6 + Math.round((b * 5) / 255) };
}

function lzw(indices, minCode = 8) {
  // GIF LZW as in the reference compress/gif.js encoders: the code size grows on the output
  // after the table passes it (decoders add their entry one code later than the encoder).
  const out = [];
  let buf = 0;
  let nbits = 0;
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let maxcode = (1 << size) - 1;
  let free = eoi + 1;
  let clearFlag = false;
  let dict = new Map();
  const output = (code) => {
    buf |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(buf & 0xff);
      buf >>>= 8;
      nbits -= 8;
    }
    if (clearFlag) {
      size = minCode + 1;
      maxcode = (1 << size) - 1;
      clearFlag = false;
    } else if (free > maxcode) {
      size++;
      maxcode = size === 12 ? 4096 : (1 << size) - 1;
    }
  };
  output(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = prefix * 256 + c;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    output(prefix);
    if (free < 4096) dict.set(key, free++);
    else {
      dict = new Map();
      free = eoi + 1;
      clearFlag = true;
      output(clear);
    }
    prefix = c;
  }
  output(prefix);
  output(eoi);
  if (nbits > 0) out.push(buf & 0xff);
  return new Uint8Array(out);
}

/** frames: [{width, height, data: Uint8ClampedArray RGBA}], delayCs per frame → GIF bytes. */
export function encodeGif(frames, delayCs = 10) {
  const { width: w, height: h } = frames[0];
  const { pal, index } = paletteFor(frames);
  const parts = [enc.encode('GIF89a'), new Uint8Array([w & 255, w >> 8, h & 255, h >> 8, 0xf7, 0, 0]), pal, new Uint8Array([0x21, 0xff, 11]), enc.encode('NETSCAPE2.0'), new Uint8Array([3, 1, 0, 0, 0])];
  for (const f of frames) {
    const idx = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < idx.length; i++, j += 4) idx[i] = index(f.data[j], f.data[j + 1], f.data[j + 2]);
    const data = lzw(idx);
    parts.push(new Uint8Array([0x21, 0xf9, 4, 0, delayCs & 255, delayCs >> 8, 0, 0]));
    parts.push(new Uint8Array([0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 8]));
    for (let k = 0; k < data.length; k += 255) {
      const sub = data.subarray(k, k + 255);
      parts.push(new Uint8Array([sub.length]), sub);
    }
    parts.push(new Uint8Array([0]));
  }
  parts.push(new Uint8Array([0x3b]));
  return concat(parts);
}

/**
 * Encode a canvas frame by frame to WebM (REQ-STR-14 fly-throughs): `draw(i, tSeconds)` renders
 * frame i, then it is encoded with WebCodecs VP8, so the video keeps its frame rate whatever the
 * rendering speed. Returns the WebM bytes.
 */
export async function encodeCanvasWebM(canvas, { frames, fps = 30, draw, bitrate = 6e6, keyEvery = 60 }) {
  if (typeof VideoEncoder === 'undefined') throw new Error('WebCodecs is not available in this browser');
  const width = canvas.width & ~1;
  const height = canvas.height & ~1;
  const config = { codec: 'vp8', width, height, bitrate, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('VP8 encoding is not supported here');
  const chunks = [];
  let failure = null;
  const encoder = new VideoEncoder({
    output: (c) => {
      const data = new Uint8Array(c.byteLength);
      c.copyTo(data);
      chunks.push({ data, timestamp: c.timestamp, key: c.type === 'key' });
    },
    error: (e) => (failure = e),
  });
  encoder.configure(config);
  for (let i = 0; i < frames; i++) {
    await draw(i, i / fps);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(vf, { keyFrame: i % keyEvery === 0 });
    vf.close();
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    if (failure) throw failure;
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  return muxWebM({ width, height, chunks, durationMs: (frames * 1000) / fps });
}
