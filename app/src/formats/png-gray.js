// Greyscale PNG samples at full depth (8 or 16 bit), which the browser's image decoder reduces to
// 8-bit RGBA: GeoPackage gridded-coverage tiles store elevations as 16-bit PNG (OGC 17-066r1,
// IMP-11). Non-interlaced greyscale only (colour type 0); returns {width, height, data}.
import { unzlibSync } from 'fflate';

export function decodeGrayPng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((v, i) => b[i] !== v)) throw new Error('not a PNG');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let w = 0;
  let h = 0;
  let depth = 0;
  const idat = [];
  for (let o = 8; o + 8 <= b.length; ) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    const body = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = dv.getUint32(o + 8);
      h = dv.getUint32(o + 12);
      depth = body[8];
      if (body[9] !== 0) throw new Error(`PNG colour type ${body[9]} is not greyscale`);
      if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} is not read (8 or 16)`);
      if (body[12] !== 0) throw new Error('interlaced PNG tiles are not read');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!w || !h) throw new Error('PNG without IHDR');
  const all = new Uint8Array(idat.reduce((t, c) => t + c.length, 0));
  idat.reduce((at, c) => (all.set(c, at), at + c.length), 0);
  const raw = unzlibSync(all);
  const bpp = depth / 8;
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('PNG image data is short');
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = depth === 16 ? new Uint16Array(w * h) : new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) out[y * w + x] = depth === 16 ? (cur[2 * x] << 8) | cur[2 * x + 1] : cur[x];
    prev.set(cur);
  }
  return { width: w, height: h, data: out };
}
