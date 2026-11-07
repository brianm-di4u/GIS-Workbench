// NITF/NSIF image source for the decode worker (REQ-FMT-01, REQ-FMT-02). Headers are parsed
// by the Rust `parse` bundle from byte ranges; pixels are read block by block with
// File.slice. Rust decodes every block: uncompressed (any NBPP), JPEG 8/12-bit with the NITF
// default tables (C3/M3), VQ (C4/M4, RPF tables), T.4 1-D bi-level (C1/M1); JPEG 2000 and
// HTJ2K (C8/M8) go through the lazily loaded `j2k` bundle: tile by tile (full and reduced
// resolutions) when the codestream is tiled, otherwise as one whole-image decode.

import { LRU } from './pyramid.js';
import { j2kTileIndex, j2kTileReader } from './j2ktiles.js';
import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

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

/**
 * `defer(im)`: segments for which no image source is made at open (MIE4NITF frames, REQ-GAP-47):
 * they get `im.deferred = true` and are opened on demand with makeImageSource.
 */
export async function openNitf(file, parse, { defer = null } = {}) {
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
    const err = wasmError(parse);
    const msg = err.message;
    const m = /need HL=(\d+)/.exec(msg);
    if (st === 2 && m && Number(m[1]) <= file.size && Number(m[1]) > head.length) {
      head = await readRange(file, 0, Number(m[1]));
      continue;
    }
    throw gwError('NITF header: {msg}', { msg: nested(err) });
  }
  // Subheader layout: 0 = NITF 2.0, 1 = NITF 2.1 / NSIF 1.0, 2 = NITF 1.1 (2.0 fields, sizes from the blocks).
  const ver = hdr.version === '01.10' ? 2 : hdr.version === '02.00' ? 0 : 1;
  const v21 = ver === 1;
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
        const st = parse.x.gw_nitf_image_subheader(p, n, seg.subheaderOffset, ver);
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
    if (defer?.(im)) {
      im.deferred = true;
      continue;
    }
    try {
      sources.push(await makeImageSource(file, parse, im));
    } catch (e) {
      im.error = String(e.message || e);
    }
  }
  return { header: hdr, images, others, sources };
}

/** Bands and sample type a segment's source will have, from its subheader alone (no I/O). */
export function segmentLayout(parse, ish) {
  const tcode = parse.x.gw_nitf_sample_type(ish.NBPP, PV[ish.PVTYPE] ?? 0);
  if (tcode < 0) throw wasmError(parse);
  const t = TYPE[tcode];
  const lut = ish.IREP === 'RGB/LUT' && ish.NBANDS === 1 && ish.bands?.[0]?.LUT?.length >= 3;
  return { bands: lut ? 3 : ish.NBANDS, sampleType: t === 'cf32' ? 'f32' : t };
}

/**
 * One image segment as a pixel source. `cache`: an LRU-like {get, set} for decoded blocks (MIE4NITF
 * frames share one, keyed per segment); by default each segment has its own 96 MB LRU.
 */
export async function makeImageSource(file, parse, im, { cache = null } = {}) {
  const s = im.ish;
  const { NROWS: height, NCOLS: width, NBPR, NBPC, NPPBH: bw, NPPBV: bh, NBPP, ABPP, IMODE, IC } = s;
  const nb = s.NBANDS;
  const pv = PV[s.PVTYPE] ?? 0;
  const tcode = parse.x.gw_nitf_sample_type(NBPP, pv);
  if (tcode < 0) throw wasmError(parse);
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
      if (parse.x.gw_nitf_mask_table(p, n, nBlockEntries, NBPP) !== 0) throw gwError('mask table: {msg}', { msg: nested(wasmError(parse)) });
    } finally {
      parse.free(p, n);
    }
    const m = parse.outJson();
    imdatoff = m.IMDATOFF;
    blockOffsets = m.blockOffsets ?? null;
    padValue = m.TPXCD;
  }
  const compressed = !(IC === 'NC' || IC === 'NM');
  // C5/M5 (lossless JPEG, SOF3) go through the same JPEG decoder as C3 since 2.0.4.
  const codec = { C3: 'jpeg', M3: 'jpeg', C5: 'jpeg', M5: 'jpeg', C4: 'vq', M4: 'vq', C8: 'j2k', M8: 'j2k', C1: 't4', M1: 't4', C2: 'aridpcm', M2: 'aridpcm' }[IC] ?? (compressed ? null : 'raw');
  if (!codec) {
    const names = { C7: 'complex SAR compression', C6: 'reserved' };
    throw gwError('{name} compression (IC={ic}) is not decoded yet (REQ-FMT-02)', { name: String(names[IC] ?? IC), ic: String(IC) });
  }
  let jpegIndex = null;
  let vq = null;
  if (codec === 'jpeg' && !blockOffsets) jpegIndex = await indexJpegBlocks(file, dataOff, im.seg.dataLength, NBPR * NBPC * (IMODE === 'S' ? nb : 1));
  if (codec === 'vq') vq = await loadVq(file, parse, s, im, bw, bh);
  // ARIDPCM (REQ-FMT-44, MIL-STD-188-197A) through the lazily loaded `legacy` bundle.
  const arid = codec === 'aridpcm' ? await aridpcmSetup(file, im, s, blockOffsets, imdatoff, nBlockEntries, bw, bh) : null;
  if (arid?.warning) im.warning = arid.warning;
  if (codec === 't4' && !blockOffsets && NBPR * NBPC * (IMODE === 'S' ? nb : 1) > 1) throw new Error('T.4 bi-level images with several blocks need a block mask (IC=M1)');
  let j2kWhole = null; // whole-image planes after the first request
  // Tiled codestreams (WorldView C8: 1024² tiles) decode tile by tile, coarse levels included.
  const j2kIx = codec === 'j2k' ? await j2kTileIndex((o, l) => readRange(file, o, l), dataOff + imdatoff, dataOff + im.seg.dataLength).catch(() => null) : null;
  // A single-tile codestream (one big MIE4NITF/WAMI frame): coarse levels decode only the
  // resolutions they show (hayro's target resolution), not the whole image (REQ-GAP-47). Images
  // under 8 M pixels keep the one whole decode and the averaged pyramid.
  const j2kOne = codec === 'j2k' && !j2kIx && width * height >= 2 ** 23 ? await j2kDecompositionLevels(file, dataOff + imdatoff, dataOff + im.seg.dataLength).catch(() => 0) : 0;
  if (type === 'cf32') type = 'f32'; // complex shown as magnitude until the SAR tools (R3)
  // LUT expansion: RGB/LUT single band → three bands at decode time.
  const lutBand = s.IREP === 'RGB/LUT' && nb === 1 && s.bands[0]?.LUT?.length >= 3 ? s.bands[0].LUT : null;
  const outBands = lutBand ? 3 : nb;
  const nodata = blockOffsets?.includes(-1) || vq?.offsets?.includes(-1) || padValue !== null ? (padValue ?? 0) : null;
  const rawBandBytes = Math.ceil((bw * bh * NBPP) / 8);
  const blockCache = cache ?? new LRU(96 << 20);

  async function blockBytes(br, bc, band) {
    const bi = br * NBPR + bc;
    const entry = IMODE === 'S' ? band * NBPR * NBPC + bi : bi;
    if (vq) {
      const o = blockOffsets ? blockOffsets[entry] : vq.offsets ? vq.offsets[entry] : vq.base + entry * 6144;
      if (o === undefined || o < 0) return null; // omitted subframe → no data
      const at = blockOffsets ? dataOff + imdatoff + o : o;
      // A frame's subframes (36 × 6 KB for CADRG/CIB) are read in one request: an A.TOC overview
      // touches every subframe of every frame (REQ-FMT-40 first tile).
      if (!blockOffsets && vq.span && at >= vq.span[0] && at + 6144 <= vq.span[1]) {
        vq.all ??= readRange(file, vq.span[0], vq.span[1] - vq.span[0]);
        const all = await vq.all;
        return all.subarray(at - vq.span[0], at - vq.span[0] + 6144);
      }
      return readRange(file, at, 6144);
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
    if (arid) {
      const [o, l] = arid.index[entry] ?? [];
      return o === undefined ? null : readRange(file, dataOff + imdatoff + o, l);
    }
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
        if (parse.x.gw_vq_decode(codes[0], codes[1], luts[0], luts[1]) !== 0) throw gwError('VQ block {br},{bc}: {msg}', { br: String(br), bc: String(bc), msg: nested(wasmError(parse)) });
        planes = [parse.outBytes()];
      } finally {
        parse.free(...codes);
        parse.free(...luts);
      }
    } else if (arid) {
      planes = fitPlanes(rasterOf(arid.decode(raw)), bw, bh, 1, C);
    } else if (codec === 't4') {
      const mode2d = /2D/i.test(s.COMRAT ?? '') ? 1 : 0;
      planes = [call(parse, raw, (p, n) => parse.x.gw_t4_decode(p, n, bw, bh, mode2d), 'T.4 block')];
    } else {
      const [p, n] = parse.put(raw);
      try {
        const bands = IMODE === 'S' ? 1 : nb;
        const st = parse.x.gw_nitf_unpack(p, n, bw, bh, bands, NBPP, ABPP, s.PJUST === 'L' ? 1 : 0, pv, IMODE.charCodeAt(0));
        if (st !== 0) throw gwError('block {br},{bc}: {msg}', { br: String(br), bc: String(bc), msg: nested(wasmError(parse)) });
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
  const rowBytes = IMODE === 'P' || IMODE === 'R' ? bw * nb * bps : bw * bps;
  const STRIP_ROWS = Math.max(1, Math.floor((4 * 2 ** 20) / rowBytes));
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
      if (st !== 0) throw gwError('rows {r0}–{r1} of block {br},{bc}: {msg}', { r0: String(r0), r1: String(r1), br: String(br), bc: String(bc), msg: nested(wasmError(parse)) });
      const planes = splitPlanes(parse.outBytes(), TYPE[tcode], bw * rows, bands);
      blockCache.set(key, { planes }, planes.reduce((a, b) => a + b.byteLength, 0));
      return bands === 1 ? planes[0] : planes[band];
    } finally {
      parse.free(p, n);
    }
  }

  /**
   * Columns lx0…lx1 of row r of a block (uncompressed, byte-aligned, IMODE B/S/P): only that run is
   * read and unpacked, so a coarse level's tiles each read their own span of a row instead of the
   * whole block row (a 14k-wide complex SICD row is 113 KB; one tile needs a quarter of it or less).
   * → planes for every band (P) or the one band (B, S); null for an omitted block.
   */
  async function readSpan(br, bc, band, r, lx0, lx1) {
    const bi = br * NBPR + bc;
    const entry = IMODE === 'S' ? band * NBPR * NBPC + bi : bi;
    let base;
    if (blockOffsets) {
      const o = blockOffsets[entry];
      if (o === undefined || o < 0) return null;
      base = dataOff + imdatoff + o;
    } else base = dataOff + imdatoff + (IMODE === 'S' ? band * NBPR * NBPC * rawBandBytes + bi * rawBandBytes : bi * blockBytesTotal);
    const n = lx1 - lx0 + 1;
    const bandsIn = IMODE === 'P' ? nb : 1;
    const at = IMODE === 'B' ? base + band * rawBandBytes + (r * bw + lx0) * bps : IMODE === 'S' ? base + (r * bw + lx0) * bps : base + (r * bw + lx0) * nb * bps;
    const raw = await readRange(file, at, n * bandsIn * bps);
    const [p, len] = parse.put(raw);
    try {
      if (parse.x.gw_nitf_unpack(p, len, n, 1, bandsIn, NBPP, ABPP, s.PJUST === 'L' ? 1 : 0, pv, (IMODE === 'P' ? 'P' : 'B').charCodeAt(0)) !== 0) throw gwError('row {r} of block {br},{bc}: {msg}', { r: String(r), br: String(br), bc: String(bc), msg: nested(wasmError(parse)) });
      return splitPlanes(parse.outBytes(), TYPE[tcode], n, bandsIn);
    } finally {
      parse.free(p, len);
    }
  }

  const readJ2kTiles = j2kIx ? j2kTileReader({ ix: j2kIx, readRange: (o, l) => readRange(file, o, l), cache: blockCache, bundle: () => self.GW.ensure('j2k'), width, height, C, nodata, lutBand }) : null;

  /** Level L of a VQ image: the full-resolution pixel at the centre of each 2^L cell. */
  async function vqLevel(L, x0, y0, w, h, bands, job) {
    const sc = 2 ** L;
    const half = sc >> 1;
    const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
    let key = null;
    let b = null;
    for (let j = 0; j < h; j++) {
      job?.checkCancel?.();
      const Y = Math.min(height - 1, (y0 + j) * sc + half);
      const br = Math.floor(Y / bh);
      for (let i = 0; i < w; i++) {
        const X = Math.min(width - 1, (x0 + i) * sc + half);
        const bc = Math.floor(X / bw);
        if (key !== br * NBPR + bc) {
          key = br * NBPR + bc;
          b = await block(br, bc, 0);
        }
        if (!b.planes) continue;
        const v = b.planes[0][(Y - br * bh) * bw + (X - bc * bw)];
        for (let k = 0; k < bands.length; k++) out[k][j * w + i] = lutBand ? (lutBand[bands[k]]?.[v] ?? 0) : v;
      }
    }
    return out;
  }

  async function wholeJ2k() {
    if (!j2kWhole) {
      j2kWhole = (async () => {
        if (width * height * nb > 400e6) throw gwError('JPEG 2000 image {w}×{h}×{nb} is too large for the whole-image decoder (R1 limit 400 M samples)', { w: String(width), h: String(height), nb: String(nb) });
        const j2k = await self.GW.ensure('j2k');
        const raw = await readRange(file, dataOff + imdatoff, im.seg.dataLength - imdatoff);
        const r = rasterOf(call(j2k, raw, (p, n) => j2k.x.gw_j2k_decode(p, n, 0, 0), 'JPEG 2000'));
        if (r.w < width || r.h < height) throw gwError('JPEG 2000 codestream is {cw}×{ch}, smaller than the {w}×{h} image', { cw: String(r.w), ch: String(r.h), w: String(width), h: String(height) });
        return r;
      })();
      j2kWhole.catch(() => (j2kWhole = null));
    }
    return j2kWhole;
  }

  const j2kReduced = new Map();
  async function j2kLevel(L, x0, y0, w, h, bands) {
    if (!j2kReduced.has(L)) {
      const p = (async () => {
        const j2k = await self.GW.ensure('j2k');
        const raw = await readRange(file, dataOff + imdatoff, im.seg.dataLength - imdatoff);
        return rasterOf(call(j2k, raw, (p, n) => j2k.x.gw_j2k_decode(p, n, Math.ceil(width / 2 ** L), Math.ceil(height / 2 ** L)), 'JPEG 2000'));
      })();
      p.catch(() => j2kReduced.delete(L));
      j2kReduced.set(L, p);
      // Two reduced levels at most: a frame sequence keeps its memory flat.
      if (j2kReduced.size > 2) j2kReduced.delete(j2kReduced.keys().next().value);
    }
    const r = await j2kReduced.get(L);
    const lw = Math.ceil(width / 2 ** L);
    const lh = Math.ceil(height / 2 ** L);
    const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
    for (let k = 0; k < bands.length; k++) {
      const src = r.planes[lutBand ? 0 : Math.min(bands[k], r.comps - 1)];
      const lut = lutBand ? lutBand[bands[k]] : null;
      const dst = out[k];
      for (let y = Math.max(0, y0); y < Math.min(y0 + h, lh); y++) {
        const so = Math.min(r.h - 1, Math.floor((y * r.h) / lh)) * r.w;
        const dofs = (y - y0) * w - x0;
        for (let x = Math.max(0, x0); x < Math.min(x0 + w, lw); x++) {
          const v = src[so + Math.min(r.w - 1, Math.floor((x * r.w) / lw))];
          dst[dofs + x] = lut ? (lut[v] ?? 0) : v;
        }
      }
    }
    return out;
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
    // the averaged pyramid. Images under 64 MiB keep it too: one read is faster than strided ones,
    // and averaged levels keep viewport/AOI DRA histograms faithful (TE-042). The limit was 256 MiB:
    // a 245 MiB Capella SIDD and 197 MiB SICDs read and averaged the whole file, 5–7 s to first tile (CX-086).
    // Tiled JPEG 2000: every level down to the codestream's coarsest resolution comes from the tiles' own
    // reduced resolutions (no full-resolution decode for an overview).
    // VQ (CADRG/CIB): reduced levels sample the cell centres of decoded 256² blocks (palette data:
    // nearest, as the A.TOC mosaic needs; REQ-FMT-40).
    hasLevel: (L) => (codec === 'vq' && L >= 1 && L <= 8) || (codec === 'raw' && NBPP % 8 === 0 && L >= 2 && width * height * nb * (NBPP / 8) > 64 * 2 ** 20) || (!!j2kIx && L >= 1 && L <= j2kIx.levels && 2 ** L <= Math.min(j2kIx.tx, j2kIx.ty)) || (j2kOne > 0 && L >= 1 && L <= j2kOne),
    async readLevel(L, x0, y0, w, h, bands, job) {
      if (j2kIx) return readJ2kTiles(L, x0, y0, w, h, bands, job);
      if (j2kOne) return j2kLevel(L, x0, y0, w, h, bands);
      if (codec === 'vq') return vqLevel(L, x0, y0, w, h, bands, job);
      const sc = 2 ** L;
      const half = sc >> 1;
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      const xa = Math.min(width - 1, x0 * sc + half);
      const xb = Math.min(width - 1, (x0 + w - 1) * sc + half);
      // Span reads run ahead of the row being filled (perf 2.1): one File.slice per sampled row and
      // block column, awaited one at a time, spent most of a 1 GB SICD's first tile waiting on I/O.
      const AHEAD = 24;
      const spans = [];
      const fetchRow = (j) => {
        if (j >= h || spans[j] || IMODE === 'R') return;
        const Y = Math.min(height - 1, (y0 + j) * sc + half);
        const br = Math.floor(Y / bh);
        const r = Y - br * bh;
        const per = new Map();
        for (let bc = Math.floor(xa / bw); bc <= Math.floor(xb / bw); bc++) {
          const lx0 = Math.max(xa, bc * bw) - bc * bw;
          const lx1 = Math.min(xb, bc * bw + bw - 1) - bc * bw;
          // P: every band from one span read; B/S: one read per band shown.
          const ps = IMODE === 'P' ? [readSpan(br, bc, lutBand ? 0 : bands[0], r, lx0, lx1)] : bands.map((b) => readSpan(br, bc, lutBand ? 0 : b, r, lx0, lx1));
          for (const p of ps) p.catch(() => {}); // awaited below; a cancelled tile drops the rest
          per.set(bc, ps);
        }
        spans[j] = per;
      };
      for (let j = 0; j < Math.min(h, AHEAD); j++) fetchRow(j);
      for (let j = 0; j < h; j++) {
        job?.checkCancel?.();
        fetchRow(j + AHEAD);
        const Y = Math.min(height - 1, (y0 + j) * sc + half);
        const br = Math.floor(Y / bh);
        const r = Y - br * bh;
        for (let bc = Math.floor(xa / bw); bc <= Math.floor(xb / bw); bc++) {
          // The columns of this block the level samples: one span per row (R keeps whole-row reads).
          const lx0 = Math.max(xa, bc * bw) - bc * bw;
          const ps = spans[j]?.get(bc);
          for (let k = 0; k < bands.length; k++) {
            const srcBand = lutBand ? 0 : bands[k];
            let row;
            let o0 = 0;
            if (IMODE === 'R') row = await readStrip(`l:${br},${bc},*,${r}`, br, bc, srcBand, r, r + 1);
            else {
              const planes = await ps[IMODE === 'P' ? 0 : k];
              row = planes ? planes[IMODE === 'P' ? srcBand : 0] : null;
              o0 = lx0;
            }
            if (!row) continue;
            const lut = lutBand ? lutBand[bands[k]] : null;
            const dst = out[k];
            for (let i = 0; i < w; i++) {
              const X = Math.min(width - 1, (x0 + i) * sc + half);
              if (Math.floor(X / bw) !== bc) continue;
              const v = row[X - bc * bw - o0];
              dst[j * w + i] = lut ? (lut[v] ?? 0) : v;
            }
          }
        }
        spans[j] = null;
      }
      return out;
    },
    async readWindow(x0, y0, w, h, bands, job) {
      const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
      if (j2kIx) return readJ2kTiles(0, x0, y0, w, h, bands, job);
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
              const dst = out[k];
              const lut = lutBand ? lutBand[bands[k]] : null;
              // Straight from the cached strips (a block row is often the whole image width: copying
              // it out per tile first was most of a wide SIDD's first-tile time, perf 2.1).
              for (let s0 = Math.floor((ys - by0) / STRIP_ROWS) * STRIP_ROWS; s0 < ye - by0; s0 += STRIP_ROWS) {
                const s1 = Math.min(bh, s0 + STRIP_ROWS);
                const plane = await stripOf(br, bc, srcBand, s0, s1);
                if (!plane) break; // an omitted block: every strip of it is
                for (let y = Math.max(ys, by0 + s0); y < Math.min(ye, by0 + s1); y++) {
                  const so = (y - by0 - s0) * bw - bx0;
                  const dofs = (y - y0) * w - x0;
                  if (lut) for (let x = xs; x < xe; x++) dst[dofs + x] = lut[plane[so + x]] ?? 0;
                  else dst.set(plane.subarray(so + xs, so + xe), dofs + xs);
                }
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
              else dst.set(plane.subarray(so + xs, so + xe), dofs + xs);
            }
          }
        }
      }
      return out;
    },
  };
}

/** Decomposition levels (COD SPcod) of the codestream at [base, end), from its main header. */
async function j2kDecompositionLevels(file, base, end) {
  const h = await readRange(file, base, Math.min(end - base, 4096));
  let i = -1;
  for (let k = 0; k + 3 < Math.min(h.length, 1024); k++) {
    if (h[k] === 0xff && h[k + 1] === 0x4f && h[k + 2] === 0xff && h[k + 3] === 0x51) {
      i = k + 2;
      break;
    }
  }
  if (i < 0) return 0;
  while (i + 4 <= h.length) {
    const m = (h[i] << 8) | h[i + 1];
    if (m === 0xff90) return 0;
    if (m === 0xff52) return h[i + 9] ?? 0;
    i += 2 + ((h[i + 2] << 8) | h[i + 3]);
  }
  return 0;
}

function splitPlanes(bytes, type, npix, nbands) {
  const out = [];
  const bpe = BYTES[type];
  // outBytes() is already a fresh copy: views on it (no second copy of every block).
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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
    if (fn(p, n) !== 0) throw gwError('{what}: {msg}', { what, msg: nested(wasmError(b)) });
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

/**
 * ARIDPCM blocks: their byte extents (block mask for M2; otherwise one block is the segment, and
 * consecutive blocks are walked by their busyness codes) and a decoder. Rates whose quantisation
 * tables the standard did not publish decode with derived tables and say so (warning).
 */
async function aridpcmSetup(file, im, s, blockOffsets, imdatoff, nBlocks, bw, bh) {
  const legacy = await self.GW.ensure('legacy');
  // 11-bit ARIDPCM may sit in 16-bit words (NBPP 16, ABPP 11): the coding depth is ABPP.
  const depth = s.NBPP <= 8 ? s.NBPP : Number(s.ABPP) || s.NBPP;
  const comrat = new TextEncoder().encode(String(s.COMRAT ?? '').trim());
  const withComrat = (fn) => {
    const [cp, cn] = legacy.put(comrat);
    try {
      return fn(cp, cn);
    } finally {
      legacy.free(cp, cn);
    }
  };
  const exact = withComrat((cp, cn) => legacy.x.gw_aridpcm_exact(depth, cp, cn));
  if (exact < 0) throw gwError('ARIDPCM (IC={ic}): {msg}', { ic: String(s.IC), msg: nested(wasmError(legacy)) });
  const segLen = im.seg.dataLength - imdatoff;
  let index;
  if (blockOffsets) {
    index = blockOffsets.map((o, k) => {
      if (o < 0) return [];
      const next = blockOffsets.slice(k + 1).find((v) => v >= 0) ?? segLen;
      return [o, next - o];
    });
  } else if (nBlocks === 1) index = [[0, segLen]];
  else {
    if (segLen > 256 << 20) throw new Error('ARIDPCM images above 256 MB with several blocks need a block mask (IC=M2)');
    const all = await readRange(file, im.seg.dataOffset + imdatoff, segLen);
    const [p, n] = legacy.put(all);
    try {
      const st = withComrat((cp, cn) => legacy.x.gw_aridpcm_index(p, n, nBlocks, bw, bh, depth, cp, cn));
      if (st !== 0) throw gwError('ARIDPCM block index: {msg}', { msg: nested(wasmError(legacy)) });
      index = legacy.outJson();
    } finally {
      legacy.free(p, n);
    }
  }
  return {
    index,
    warning: exact ? null : `ARIDPCM COMRAT ${String(s.COMRAT).trim()} (${s.NBPP}-bit): MIL-STD-188-197A never published this rate's quantisation tables (appendix B); decoded with tables derived by the standard's §6.3 procedure, so values are approximate`,
    decode: (raw) => withComrat((cp, cn) => call(legacy, raw, (p, n) => legacy.x.gw_aridpcm_decode(p, n, bw, bh, depth, cp, cn), 'ARIDPCM block')),
  };
}

/** VQ kernel tables and spatial-data base from the RPF location table (RPFIMG TRE). */
async function loadVq(file, parse, s, im, bw, bh) {
  if (bw !== 256 || bh !== 256) throw gwError('VQ blocks must be 256×256 (found {bw}×{bh})', { bw: String(bw), bh: String(bh) });
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
  const starts = offsets ? offsets.filter((o) => o >= 0) : Array.from({ length: Number(s.NBPR) * Number(s.NBPC) }, (_, i) => base + i * 6144);
  const span = starts.length ? [Math.min(...starts), Math.max(...starts) + 6144] : null;
  return { luts, base, offsets, span: span && span[1] - span[0] <= 16 << 20 && span[1] <= file.size ? span : null };
}
