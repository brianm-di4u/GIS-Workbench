// NITF/NSIF image source for the decode worker (REQ-FMT-01, REQ-FMT-02). Headers are parsed
// by the Rust `parse` bundle from byte ranges; pixels are read block by block with
// File.slice. Rust decodes every block: uncompressed (any NBPP), JPEG 8/12-bit with the NITF
// default tables (C3/M3), VQ (C4/M4, RPF tables), T.4 1-D bi-level (C1/M1); JPEG 2000 and
// HTJ2K (C8/M8) go through the lazily loaded `j2k` bundle as one whole-image decode.

import { LRU } from './pyramid.js';

const PV = { INT: 0, SI: 1, R: 2, C: 3, B: 4 };
const TYPE = { 1: 'u8', 2: 'u16', 3: 'i16', 4: 'u32', 5: 'i32', 6: 'f32', 7: 'cf32' };
const BYTES = { u8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, cf32: 8 };

/** Bytes read and the largest single read, for the byte-range check (REQ-ARC-07). */
export const ioStats = { reads: 0, bytes: 0, largest: 0 };

async function readRange(file, off, len) {
  ioStats.reads++;
  ioStats.bytes += len;
  ioStats.largest = Math.max(ioStats.largest, len);
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

export async function openNitf(file, parse) {
  // 1. File header (HL may exceed the first read).
  let head = await readRange(file, 0, Math.min(file.size, 65536));
  let hdr;
  for (;;) {
    const [p, n] = parse.put(head);
    let st;
    try {
      st = parse.x.gw_nitf_file_header(p, n, file.size);
    } finally {
      parse.free(p, n);
    }
    if (st === 0) {
      hdr = parse.outJson();
      break;
    }
    const msg = parse.lastError();
    const m = /need HL=(\d+)/.exec(msg);
    if (st === 2 && m && Number(m[1]) <= file.size && Number(m[1]) > head.length) {
      head = await readRange(file, 0, Number(m[1]));
      continue;
    }
    throw new Error(`NITF header: ${msg}`);
  }
  const v21 = hdr.version !== '02.00';
  const images = [];
  const others = [];
  let imageIndex = 0;
  for (const seg of hdr.segments) {
    if (seg.subheaderOffset + seg.subheaderLength > file.size) {
      others.push({ kind: seg.kind, error: 'segment beyond the end of the file' });
      continue;
    }
    const sh = await readRange(file, seg.subheaderOffset, seg.subheaderLength);
    const [p, n] = parse.put(sh);
    try {
      if (seg.kind === 'image') {
        const st = parse.x.gw_nitf_image_subheader(p, n, seg.subheaderOffset, v21 ? 1 : 0);
        if (st !== 0) {
          images.push({ index: imageIndex++, error: parse.lastError(), seg });
          continue;
        }
        const ish = parse.outJson();
        images.push({ index: imageIndex++, ish, seg });
      } else {
        const kind = { graphic: 1, text: 2, des: 3, res: 4, label: 5 }[seg.kind];
        const st = parse.x.gw_nitf_other_subheader(kind, p, n, v21 ? 1 : 0);
        others.push(st === 0 ? { ...parse.outJson(), seg } : { kind: seg.kind, error: parse.lastError(), seg });
      }
    } finally {
      parse.free(p, n);
    }
  }
  // Text segments: read small ones for the viewer; DES XML (SICD/SIDD) for R3 — keep offsets.
  for (const o of others) {
    if (o.kind === 'text' && o.seg && o.seg.dataLength <= 1 << 20) {
      o.text = new TextDecoder(o.TXTFMT === 'U8S' ? 'utf-8' : 'iso-8859-1').decode(await readRange(file, o.seg.dataOffset, o.seg.dataLength));
    }
    if (o.kind === 'des' && o.DESID === 'XML_DATA_CONTENT' && o.seg && o.seg.dataLength <= 8 << 20) {
      o.xmlLength = o.seg.dataLength;
      // SICD/SIDD/CPHD XML (REQ-SAR-01/12): parsed by the hardened Rust reader, never DOMParser.
      const xml = await readRange(file, o.seg.dataOffset, o.seg.dataLength);
      const [p, n] = parse.put(xml);
      try {
        if (parse.x.gw_sar_xml(p, n, 1) === 0) o.sar = parse.outJson();
        else o.sarError = parse.lastError();
      } finally {
        parse.free(p, n);
      }
    }
  }
  const sources = [];
  for (const im of images) {
    if (im.error) continue;
    try {
      sources.push(await makeImageSource(file, parse, im));
    } catch (e) {
      im.error = String(e.message || e);
    }
  }
  return { header: hdr, images, others, sources };
}

async function makeImageSource(file, parse, im) {
  const s = im.ish;
  const { NROWS: height, NCOLS: width, NBPR, NBPC, NPPBH: bw, NPPBV: bh, NBPP, ABPP, IMODE, IC } = s;
  const nb = s.NBANDS;
  const pv = PV[s.PVTYPE] ?? 0;
  const tcode = parse.x.gw_nitf_sample_type(NBPP, pv);
  if (tcode < 0) throw new Error(parse.lastError());
  let type = TYPE[tcode];
  const masked = IC.startsWith('M') || IC === 'NM';
  const dataOff = im.seg.dataOffset;
  let imdatoff = 0;
  let blockOffsets = null;
  let padValue = null;
  const nBlockEntries = NBPR * NBPC * (IMODE === 'S' ? nb : 1);
  if (masked) {
    const need = Math.min(im.seg.dataLength, 10 + 8 + nBlockEntries * 8 + 64);
    const mt = await readRange(file, dataOff, need);
    const [p, n] = parse.put(mt);
    try {
      if (parse.x.gw_nitf_mask_table(p, n, nBlockEntries, NBPP) !== 0) throw new Error(`mask table: ${parse.lastError()}`);
    } finally {
      parse.free(p, n);
    }
    const m = parse.outJson();
    imdatoff = m.IMDATOFF;
    blockOffsets = m.blockOffsets ?? null;
    padValue = m.TPXCD;
  }
  const compressed = !(IC === 'NC' || IC === 'NM');
  const codec = { C3: 'jpeg', M3: 'jpeg', C4: 'vq', M4: 'vq', C8: 'j2k', M8: 'j2k', C1: 't4', M1: 't4' }[IC] ?? (compressed ? null : 'raw');
  if (!codec) {
    const names = { C5: 'lossless JPEG', M5: 'lossless JPEG', C2: 'ARIDPCM', M2: 'ARIDPCM', C7: 'complex SAR compression', C6: 'reserved' };
    throw new Error(`${names[IC] ?? IC} compression (IC=${IC}) is not decoded yet (REQ-FMT-02)`);
  }
  let jpegIndex = null;
  let vq = null;
  if (codec === 'jpeg' && !blockOffsets) jpegIndex = await indexJpegBlocks(file, dataOff, im.seg.dataLength, NBPR * NBPC * (IMODE === 'S' ? nb : 1));
  if (codec === 'vq') vq = await loadVq(file, parse, s, im, bw, bh);
  if (codec === 't4' && !blockOffsets && NBPR * NBPC * (IMODE === 'S' ? nb : 1) > 1) throw new Error('T.4 bi-level images with several blocks need a block mask (IC=M1)');
  let j2kWhole = null; // whole-image planes after the first request
  if (type === 'cf32') type = 'f32'; // complex shown as magnitude until the SAR tools (R3)
  // LUT expansion: RGB/LUT single band → three bands at decode time.
  const lutBand = s.IREP === 'RGB/LUT' && nb === 1 && s.bands[0]?.LUT?.length >= 3 ? s.bands[0].LUT : null;
  const outBands = lutBand ? 3 : nb;
  const nodata = blockOffsets?.includes(-1) || vq?.offsets?.includes(-1) || padValue !== null ? (padValue ?? 0) : null;
  const rawBandBytes = Math.ceil((bw * bh * NBPP) / 8);
  const blockCache = new LRU(96 << 20);

  async function blockBytes(br, bc, band) {
    const bi = br * NBPR + bc;
    const entry = IMODE === 'S' ? band * NBPR * NBPC + bi : bi;
    if (vq) {
      const o = blockOffsets ? blockOffsets[entry] : vq.offsets ? vq.offsets[entry] : vq.base + entry * 6144;
      if (o === undefined || o < 0) return null; // omitted subframe → no data
      return readRange(file, blockOffsets ? dataOff + imdatoff + o : o, 6144);
    }
    if (blockOffsets) {
      const o = blockOffsets[entry];
      if (o === undefined || o < 0) return null; // block not recorded → no data
      const len = compressed ? null : IMODE === 'B' ? rawBandBytes * nb : IMODE === 'S' ? rawBandBytes : Math.ceil((bw * bh * nb * NBPP) / 8);
      if (compressed) {
        const next = blockOffsets.slice(entry + 1).find((v) => v >= 0) ?? im.seg.dataLength - imdatoff;
        return readRange(file, dataOff + imdatoff + o, next - o);
      }
      return readRange(file, dataOff + imdatoff + o, len);
    }
    if (jpegIndex) {
      const [o, l] = jpegIndex[entry] ?? [];
      if (o === undefined) return null;
      return readRange(file, dataOff + o, l);
    }
    if (codec === 't4') return readRange(file, dataOff + imdatoff, im.seg.dataLength - imdatoff);
    const blockAll = IMODE === 'B' ? rawBandBytes * nb : IMODE === 'S' ? rawBandBytes : Math.ceil((bw * bh * nb * NBPP) / 8);
    const off = IMODE === 'S' ? band * NBPR * NBPC * rawBandBytes + bi * rawBandBytes : bi * blockAll;
    return readRange(file, dataOff + imdatoff + off, blockAll);
  }

  /** Decoded planes of one block: array per band (IMODE S decodes one band at a time). */
  async function block(br, bc, band) {
    const key = IMODE === 'S' ? `${br},${bc},${band}` : `${br},${bc}`;
    const hit = blockCache.get(key);
    if (hit) return hit;
    const raw = await blockBytes(br, bc, band);
    let planes;
    if (!raw) planes = null;
    else if (codec === 'jpeg') {
      const r = call(parse, raw, (p, n) => parse.x.gw_jpeg_decode(p, n, 0, 0), `JPEG block ${br},${bc}`);
      planes = fitPlanes(rasterOf(r), bw, bh, IMODE === 'S' ? 1 : nb, C);
    } else if (codec === 'vq') {
      const codes = parse.put(raw);
      const luts = parse.put(vq.luts);
      try {
        if (parse.x.gw_vq_decode(codes[0], codes[1], luts[0], luts[1]) !== 0) throw new Error(`VQ block ${br},${bc}: ${parse.lastError()}`);
        planes = [parse.outBytes()];
      } finally {
        parse.free(...codes);
        parse.free(...luts);
      }
    } else if (codec === 't4') {
      const mode2d = /2D/i.test(s.COMRAT ?? '') ? 1 : 0;
      planes = [call(parse, raw, (p, n) => parse.x.gw_t4_decode(p, n, bw, bh, mode2d), 'T.4 block')];
    } else {
      const [p, n] = parse.put(raw);
      try {
        const bands = IMODE === 'S' ? 1 : nb;
        const st = parse.x.gw_nitf_unpack(p, n, bw, bh, bands, NBPP, ABPP, s.PJUST === 'L' ? 1 : 0, pv, IMODE.charCodeAt(0));
        if (st !== 0) throw new Error(`block ${br},${bc}: ${parse.lastError()}`);
        const out = parse.outBytes();
        planes = splitPlanes(out, TYPE[tcode], bw * bh, bands);
      } finally {
        parse.free(p, n);
      }
    }
    const obj = { planes };
    blockCache.set(key, obj, planes ? planes.reduce((a, b) => a + b.byteLength, 0) : 64);
    return obj;
  }

  const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[type] ?? Float32Array;

  // Large uncompressed blocks (often one block for the whole image) are read by row ranges, so
  // a multi-gigabyte file is never loaded whole (REQ-ARC-07); reads are sliced to ≤ 1 MiB.
  const bps = NBPP / 8;
  const blockBytesTotal = IMODE === 'S' ? rawBandBytes : rawBandBytes * nb;
  const strips = codec === 'raw' && NBPP % 8 === 0 && blockBytesTotal > 4 * 2 ** 20 && 'BSPR'.includes(IMODE);
  async function readSliced(off, len) {
    const out = new Uint8Array(len);
    for (let o = 0; o < len; o += 2 ** 20) out.set(await readRange(file, off + o, Math.min(2 ** 20, len - o)), o);
    return out;
  }
  /** Rows [r0, r1) of one block for one band, assembled from cached row strips. */
  const rowBytes = IMODE === 'P' || IMODE === 'R' ? bw * nb * bps : bw * bps;
  const STRIP_ROWS = Math.max(1, Math.floor((4 * 2 ** 20) / rowBytes));
  async function blockRows(br, bc, band, r0, r1) {
    const C2 = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[TYPE[tcode]] ?? Float32Array;
    const out = new C2(bw * (r1 - r0));
    for (let s0 = Math.floor(r0 / STRIP_ROWS) * STRIP_ROWS; s0 < r1; s0 += STRIP_ROWS) {
      const s1 = Math.min(bh, s0 + STRIP_ROWS);
      const plane = await stripOf(br, bc, band, s0, s1);
      if (!plane) return null;
      const a = Math.max(r0, s0);
      const b = Math.min(r1, s1);
      out.set(plane.subarray((a - s0) * bw, (b - s0) * bw), (a - r0) * bw);
    }
    return out;
  }
  /** One strip of rows [r0, r1) of a block, decoded and cached (all bands for P/R); concurrent
   * requests for one strip share a single read. */
  const stripInflight = new Map();
  async function stripOf(br, bc, band, r0, r1) {
    const key = `s:${br},${bc},${IMODE === 'P' || IMODE === 'R' ? '*' : band},${r0}`;
    const hit = blockCache.get(key);
    if (hit) return hit.planes ? (hit.planes.length === 1 ? hit.planes[0] : hit.planes[band]) : null;
    if (!stripInflight.has(key)) stripInflight.set(key, readStrip(key, br, bc, band, r0, r1).finally(() => stripInflight.delete(key)));
    return stripInflight.get(key);
  }
  async function readStrip(key, br, bc, band, r0, r1) {
    const bi = br * NBPR + bc;
    const entry = IMODE === 'S' ? band * NBPR * NBPC + bi : bi;
    let base;
    if (blockOffsets) {
      const o = blockOffsets[entry];
      if (o === undefined || o < 0) {
        blockCache.set(key, { planes: null }, 64);
        return null;
      }
      base = dataOff + imdatoff + o;
    } else base = dataOff + imdatoff + (IMODE === 'S' ? band * NBPR * NBPC * rawBandBytes + bi * rawBandBytes : bi * blockBytesTotal);
    const rows = r1 - r0;
    let raw;
    let bands = 1;
    let mode = 'B';
    if (IMODE === 'B') raw = await readSliced(base + band * rawBandBytes + r0 * bw * bps, rows * bw * bps);
    else if (IMODE === 'S') raw = await readSliced(base + r0 * bw * bps, rows * bw * bps);
    else {
      // P (pixel interleaved) and R (row interleaved): rows hold every band.
      raw = await readSliced(base + r0 * bw * nb * bps, rows * bw * nb * bps);
      bands = nb;
      mode = IMODE;
    }
    const [p, n] = parse.put(raw);
    try {
      const st = parse.x.gw_nitf_unpack(p, n, bw, rows, bands, NBPP, ABPP, s.PJUST === 'L' ? 1 : 0, pv, mode.charCodeAt(0));
      if (st !== 0) throw new Error(`rows ${r0}–${r1} of block ${br},${bc}: ${parse.lastError()}`);
      const planes = splitPlanes(parse.outBytes(), TYPE[tcode], bw * rows, bands);
      blockCache.set(key, { planes }, planes.reduce((a, b) => a + b.byteLength, 0));
      return bands === 1 ? planes[0] : planes[band];
    } finally {
      parse.free(p, n);
    }
  }

  async function wholeJ2k() {
    if (!j2kWhole) {
      j2kWhole = (async () => {
        if (width * height * nb > 400e6) throw new Error(`JPEG 2000 image ${width}×${height}×${nb} is too large for the whole-image decoder (R1 limit 400 M samples)`);
        const j2k = await self.GW.ensure('j2k');
        const raw = await readRange(file, dataOff + imdatoff, im.seg.dataLength - imdatoff);
        const r = rasterOf(call(j2k, raw, (p, n) => j2k.x.gw_j2k_decode(p, n, 0, 0), 'JPEG 2000'));
        if (r.w < width || r.h < height) throw new Error(`JPEG 2000 codestream is ${r.w}×${r.h}, smaller than the ${width}×${height} image`);
        return r;
      })();
      j2kWhole.catch(() => (j2kWhole = null));
    }
    return j2kWhole;
  }

  return {
    kind: 'nitf',
    imageIndex: im.index,
    width,
    height,
    bands: outBands,
    sampleType: type,
    nodata,
    abpp: ABPP,
    // TE-019 / IMP-02: coarse levels of an uncompressed image read only the rows and columns they
    // sample (nearest, at the centre of each 2^L cell) instead of the whole file. A 1 GB SICD's
    // first display reads ~1/16 of it at level 4. JPEG/VQ/J2K blocks must be decoded whole and keep
    // the averaged pyramid. Images under 256 MB keep it too: one read is faster than strided ones,
    // and averaged levels keep viewport/AOI DRA histograms faithful (TE-042).
    hasLevel: (L) => codec === 'raw' && NBPP % 8 === 0 && L >= 2 && width * height * nb * (NBPP / 8) > 256 * 2 ** 20,
    async readLevel(L, x0, y0, w, h, bands, job) {
      const sc = 2 ** L;
      const half = sc >> 1;
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      for (let j = 0; j < h; j++) {
        job?.checkCancel?.();
        const Y = Math.min(height - 1, (y0 + j) * sc + half);
        const br = Math.floor(Y / bh);
        const r = Y - br * bh;
        const xa = Math.min(width - 1, x0 * sc + half);
        const xb = Math.min(width - 1, (x0 + w - 1) * sc + half);
        for (let bc = Math.floor(xa / bw); bc <= Math.floor(xb / bw); bc++) {
          for (let k = 0; k < bands.length; k++) {
            const srcBand = lutBand ? 0 : bands[k];
            const row = await readStrip(`l:${br},${bc},${IMODE === 'P' || IMODE === 'R' ? '*' : srcBand},${r}`, br, bc, srcBand, r, r + 1);
            if (!row) continue;
            const lut = lutBand ? lutBand[bands[k]] : null;
            const dst = out[k];
            for (let i = 0; i < w; i++) {
              const X = Math.min(width - 1, (x0 + i) * sc + half);
              if (Math.floor(X / bw) !== bc) continue;
              const v = row[X - bc * bw];
              dst[j * w + i] = lut ? (lut[v] ?? 0) : v;
            }
          }
        }
      }
      return out;
    },
    async readWindow(x0, y0, w, h, bands, job) {
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      if (codec === 'j2k') {
        const r = await wholeJ2k();
        for (let k = 0; k < bands.length; k++) {
          const src = r.planes[lutBand ? 0 : Math.min(bands[k], r.comps - 1)];
          const lut = lutBand ? lutBand[bands[k]] : null;
          const dst = out[k];
          for (let y = Math.max(0, y0); y < Math.min(y0 + h, height); y++) {
            const so = y * r.w;
            const dofs = (y - y0) * w - x0;
            for (let x = Math.max(0, x0); x < Math.min(x0 + w, width); x++) dst[dofs + x] = lut ? (lut[src[so + x]] ?? 0) : src[so + x];
          }
        }
        return out;
      }
      const br0 = Math.floor(y0 / bh);
      const br1 = Math.floor((y0 + h - 1) / bh);
      const bc0 = Math.floor(x0 / bw);
      const bc1 = Math.floor((x0 + w - 1) / bw);
      for (let br = br0; br <= br1; br++) {
        for (let bc = bc0; bc <= bc1; bc++) {
          job?.checkCancel?.();
          for (let k = 0; k < bands.length; k++) {
            const srcBand = lutBand ? 0 : bands[k];
            if (strips) {
              const by0 = br * bh;
              const bx0 = bc * bw;
              const ys = Math.max(y0, by0);
              const ye = Math.min(y0 + h, by0 + bh, height);
              const xs = Math.max(x0, bx0);
              const xe = Math.min(x0 + w, bx0 + bw, width);
              const plane = await blockRows(br, bc, srcBand, ys - by0, ye - by0);
              if (!plane) continue;
              const dst = out[k];
              const lut = lutBand ? lutBand[bands[k]] : null;
              for (let y = ys; y < ye; y++) {
                const so = (y - ys) * bw - bx0;
                const dofs = (y - y0) * w - x0;
                if (lut) for (let x = xs; x < xe; x++) dst[dofs + x] = lut[plane[so + x]] ?? 0;
                else for (let x = xs; x < xe; x++) dst[dofs + x] = plane[so + x];
              }
              continue;
            }
            const b = await block(br, bc, srcBand);
            if (!b.planes) continue;
            let plane = b.planes[IMODE === 'S' ? 0 : srcBand];
            if (!plane) continue;
            const by0 = br * bh;
            const bx0 = bc * bw;
            const ys = Math.max(y0, by0);
            const ye = Math.min(y0 + h, by0 + bh, height);
            const xs = Math.max(x0, bx0);
            const xe = Math.min(x0 + w, bx0 + bw, width);
            const dst = out[k];
            const lut = lutBand ? lutBand[bands[k]] : null;
            for (let y = ys; y < ye; y++) {
              const so = (y - by0) * bw - bx0;
              const dofs = (y - y0) * w - x0;
              if (lut) for (let x = xs; x < xe; x++) dst[dofs + x] = lut[plane[so + x]] ?? 0;
              else for (let x = xs; x < xe; x++) dst[dofs + x] = plane[so + x];
            }
          }
        }
      }
      return out;
    },
  };
}

function splitPlanes(bytes, type, npix, nbands) {
  const out = [];
  const bpe = BYTES[type];
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  for (let b = 0; b < nbands; b++) {
    const off = b * npix * bpe;
    if (type === 'cf32') {
      const iq = new Float32Array(buf, off, npix * 2);
      const mag = new Float32Array(npix);
      for (let i = 0; i < npix; i++) mag[i] = Math.hypot(iq[2 * i], iq[2 * i + 1]);
      out.push(mag);
    } else {
      const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, u32: Uint32Array, i32: Int32Array, f32: Float32Array }[type];
      let a = new C(buf, off, npix);
      if (type === 'u32' || type === 'i32') a = Float32Array.from(a);
      out.push(a);
    }
  }
  return out;
}

/** Find the SOI…EOI extent of each JPEG block in a C3 image segment (no mask table). */
async function indexJpegBlocks(file, off, len, nblocks) {
  if (len > 512 << 20) throw new Error('JPEG-compressed NITF segments above 512 MB need a block mask (NBLOCA) — R1');
  const b = await readRange(file, off, len);
  const out = [];
  let i = 0;
  while (i < b.length - 1 && out.length < nblocks) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8) {
      i++;
      continue;
    }
    const start = i;
    i += 2;
    // Walk marker segments to SOS, then scan entropy data for EOI.
    while (i < b.length - 3) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd9) {
        i += 2;
        break;
      }
      if (m === 0xda) {
        const l = (b[i + 2] << 8) | b[i + 3];
        i += 2 + l;
        while (i < b.length - 1 && !(b[i] === 0xff && b[i + 1] === 0xd9)) i++;
        i += 2;
        break;
      }
      if (m === 0xff || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0x00) {
        i += 2;
        continue;
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    out.push([start, i - start]);
  }
  return out;
}

/** Call a bundle function on a byte range; returns the output bytes or throws its error. */
function call(b, raw, fn, what) {
  const [p, n] = b.put(raw);
  try {
    if (fn(p, n) !== 0) throw new Error(`${what}: ${b.lastError()}`);
    return b.outBytes();
  } finally {
    b.free(p, n);
  }
}

/** gw-codec raster encoding → { w, h, comps, bits, planes }. */
function rasterOf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 16);
  const [w, h, comps, bits] = [0, 4, 8, 12].map((o) => dv.getUint32(o, true));
  const n = w * h;
  const planes = [];
  for (let c = 0; c < comps; c++) planes.push(bits <= 8 ? bytes.subarray(16 + c * n, 16 + (c + 1) * n) : new Uint16Array(bytes.buffer, bytes.byteOffset + 16 + c * n * 2, n));
  return { w, h, comps, bits, planes };
}

/** Planes of exactly bw×bh in the block's sample type (decoders may return a different size). */
function fitPlanes(r, bw, bh, bands, C) {
  const out = [];
  for (let k = 0; k < bands; k++) {
    const src = r.planes[Math.min(k, r.comps - 1)];
    if (r.w === bw && r.h === bh && src instanceof C) {
      out.push(src);
      continue;
    }
    const p = new C(bw * bh);
    for (let y = 0; y < Math.min(bh, r.h); y++) for (let x = 0; x < Math.min(bw, r.w); x++) p[y * bw + x] = src[y * r.w + x];
    out.push(p);
  }
  return out;
}

/** VQ kernel tables and spatial-data base from the RPF location table (RPFIMG TRE). */
async function loadVq(file, parse, s, im, bw, bh) {
  if (bw !== 256 || bh !== 256) throw new Error(`VQ blocks must be 256×256 (found ${bw}×${bh})`);
  const tre = (s.tres ?? []).find((t) => t.tag === 'RPFIMG');
  if (!tre) throw new Error('VQ image without an RPFIMG TRE: the kernel tables cannot be located');
  const locs = JSON.parse(new TextDecoder().decode(call(parse, await readRange(file, tre.offset, tre.length), (p, n) => parse.x.gw_rpf_locations(p, n), 'RPF location table')));
  const lut = locs.find((l) => l[0] === 132);
  if (!lut) throw new Error('RPF location table has no compression lookup subsection');
  const sub = await readRange(file, lut[2], Math.max(lut[1], 6 + 4 * 14 + 4 * 16384) + 1024);
  const luts = call(parse, sub, (p, n) => parse.x.gw_vq_luts(p, n), 'VQ tables');
  const spatial = locs.find((l) => l[0] === 140);
  const base = spatial ? spatial[2] : im.seg.dataOffset;
  // TE-009: the RPF mask subsection (location 138, MIL-STD-2411) lists each subframe's offset
  // from the spatial data subsection, 0xFFFFFFFF for an omitted subframe. Without it, every block
  // after a missing one was read from the wrong place.
  let offsets = null;
  const mask = locs.find((l) => l[0] === 138);
  if (mask && mask[2] > 0) {
    const nBlocks = Number(s.NBPR) * Number(s.NBPC);
    const head = await readRange(file, mask[2], 6);
    const dv = new DataView(head.buffer, head.byteOffset, 6);
    const subLen = dv.getUint16(0);
    const codeBits = dv.getUint16(4);
    if (subLen > 0) {
      const at = mask[2] + 6 + Math.ceil(codeBits / 8);
      const tb = await readRange(file, at, nBlocks * 4);
      if (tb.length === nBlocks * 4) {
        const t = new DataView(tb.buffer, tb.byteOffset, tb.length);
        offsets = Array.from({ length: nBlocks }, (_, i) => {
          const o = t.getUint32(4 * i);
          return o === 0xffffffff ? -1 : base + o;
        });
      }
    }
  }
  return { luts, base, offsets };
}
