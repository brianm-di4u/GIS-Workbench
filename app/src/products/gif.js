// Animated GIF encoder (REQ-PRD-12): short clips of motion imagery or panel animations for HTML
// and PPTX products. One global 256-colour palette from a median cut over samples of every
// frame; LZW per GIF89a; NETSCAPE2.0 loop; frame delay in centiseconds. No dithering.

function medianCut(samples, k = 256) {
  // samples: Uint8Array RGB triples. Boxes split on their widest channel at the median.
  let boxes = [{ idx: Array.from({ length: samples.length / 3 }, (_, i) => i) }];
  const range = (b) => {
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) {
      const v = samples[3 * i + c];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
    return hi.map((v, c) => v - lo[c]);
  };
  while (boxes.length < k) {
    let best = -1;
    let bw = -1;
    let bc = 0;
    boxes.forEach((b, j) => {
      if (b.idx.length < 2) return;
      const r = range(b);
      const c = r.indexOf(Math.max(...r));
      if (r[c] > bw) [bw, best, bc] = [r[c], j, c];
    });
    if (best < 0 || bw === 0) break;
    const b = boxes[best];
    b.idx.sort((p, q) => samples[3 * p + bc] - samples[3 * q + bc]);
    const mid = b.idx.length >> 1;
    boxes.splice(best, 1, { idx: b.idx.slice(0, mid) }, { idx: b.idx.slice(mid) });
  }
  const pal = boxes.map((b) => {
    const s = [0, 0, 0];
    for (const i of b.idx) for (let c = 0; c < 3; c++) s[c] += samples[3 * i + c];
    return s.map((v) => Math.round(v / Math.max(1, b.idx.length)));
  });
  while (pal.length < k) pal.push([0, 0, 0]);
  return pal;
}

/** GIF LZW: variable code size from minCode + 1 to 12 bits; the code size grows after a code is
 * written once the next free entry exceeds the current maximum (as decoders expect). */
function lzw(indices, minCode = 8) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let maxcode = (1 << size) - 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let cur = 0;
  let nbits = 0;
  const write = (code) => {
    cur |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      nbits -= 8;
    }
  };
  const emit = (code) => {
    write(code);
    if (code === clear) {
      size = minCode + 1;
      maxcode = (1 << size) - 1;
      next = eoi + 1;
      dict = new Map();
    } else if (next > maxcode && size < 12) {
      size++;
      maxcode = (1 << size) - 1;
    }
  };
  emit(clear);
  let w = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = w * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      w = hit;
      continue;
    }
    emit(w);
    if (next < 4096) dict.set(key, next++);
    else emit(clear);
    w = k;
  }
  emit(w);
  emit(eoi);
  if (nbits > 0) out.push(cur & 255);
  return out;
}

/**
 * frames: [{data: RGBA Uint8ClampedArray|Uint8Array, width, height}] (same size); delayMs per
 * frame. Returns Uint8Array (GIF89a, looping forever).
 */
export function encodeGif(frames, { delayMs = 100, loop = 0 } = {}) {
  const W = frames[0].width;
  const H = frames[0].height;
  // Palette from up to 64k samples across the frames.
  const per = Math.max(1, Math.floor((W * H * frames.length) / 65536));
  const samples = [];
  for (const f of frames) for (let i = 0; i < W * H; i += per) samples.push(f.data[4 * i], f.data[4 * i + 1], f.data[4 * i + 2]);
  const pal = medianCut(Uint8Array.from(samples));
  const cache = new Map();
  const nearest = (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = cache.get(key);
    if (v !== undefined) return v;
    let bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2;
      if (d < bd) [bd, v] = [d, i];
    }
    cache.set(key, v);
    return v;
  };
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  const str = (s) => out.push(...[...s].map((c) => c.charCodeAt(0)));
  str('GIF89a');
  u16(W);
  u16(H);
  out.push(0xf7, 0, 0); // global colour table, 8 bits, 256 entries
  for (const [r, g, b] of pal) out.push(r, g, b);
  out.push(0x21, 0xff, 11);
  str('NETSCAPE2.0');
  out.push(3, 1);
  u16(loop);
  out.push(0);
  const delay = Math.max(2, Math.round(delayMs / 10));
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0); // graphic control: no disposal, delay
    out.push(0x2c);
    u16(0);
    u16(0);
    u16(W);
    u16(H);
    out.push(0);
    const idx = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) idx[i] = nearest(f.data[4 * i], f.data[4 * i + 1], f.data[4 * i + 2]);
    out.push(8);
    const data = lzw(idx, 8);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(data[i + j]);
    }
    out.push(0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

/** Frame count and size of a GIF (for checks). */
export function gifInfo(b) {
  if (String.fromCharCode(...b.subarray(0, 6)) !== 'GIF89a') return null;
  const W = b[6] | (b[7] << 8);
  const H = b[8] | (b[9] << 8);
  let p = 13 + (b[10] & 0x80 ? 3 * (1 << ((b[10] & 7) + 1)) : 0);
  let frames = 0;
  let loop = false;
  while (p < b.length) {
    const t = b[p];
    if (t === 0x3b) break;
    if (t === 0x21) {
      if (b[p + 1] === 0xff && String.fromCharCode(...b.subarray(p + 3, p + 14)) === 'NETSCAPE2.0') loop = true;
      p += 2;
      while (b[p]) p += b[p] + 1;
      p++;
    } else if (t === 0x2c) {
      frames++;
      const f = b[p + 9];
      p += 10 + (f & 0x80 ? 3 * (1 << ((f & 7) + 1)) : 0) + 1;
      while (b[p]) p += b[p] + 1;
      p++;
    } else break;
  }
  return { width: W, height: H, frames, loop };
}
