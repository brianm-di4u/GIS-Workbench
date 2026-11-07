// GeoTIFF / BigTIFF / COG source (REQ-FMT-04) through geotiff.js, reading by range from the
// File. Native overviews serve the coarser pyramid levels; geokeys, the GDAL no-data tag,
// the RPC tag 50844 and GDAL metadata are returned for the sensor model and the metadata panel.

import { fromBlob, fromCustomClient, addDecoder, getDecoder, BaseDecoder } from 'geotiff';

/**
 * A geotiff.js client over a remote file's ranges (REQ-CON-03): the bytes come through the pool
 * from the main thread (connectors/remote.js), and geotiff.js's block cache keeps the requests
 * few (64 KiB blocks, so a COG header and its tile index take one or two requests).
 */
function remoteClient(file) {
  return {
    url: file.name,
    async request({ headers }) {
      const m = /bytes=(\d+)-(\d+)/.exec(headers?.Range ?? headers?.range ?? '');
      const a = m ? Number(m[1]) : 0;
      const b = m ? Math.min(file.size, Number(m[2]) + 1) : file.size;
      const buf = await file.slice(a, b).arrayBuffer();
      return { ok: true, status: 206, getHeader: (n) => (/content-range/i.test(n) ? `bytes ${a}-${a + buf.byteLength - 1}/${file.size}` : /content-type/i.test(n) ? 'image/tiff' : null), getData: async () => buf };
    },
  };
}
// Zstandard (and its CSP fetch shim, TE-002) is shared with PMTiles: app/src/codecs/zstd.js.
import { zstd, zstdReady } from '../../codecs/zstd.js';
import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

// TE-023: with ZSTD working (TE-002), a corrupt ZSTD block made geotiff.js's decoder fall back to
// unbounded streaming decompression and hang. Decode each block with its exact expected size
// instead (tile width × height × bytes per pixel) and reject anything that does not fill it.
class BoundedZstdDecoder extends BaseDecoder {
  decodeBlock(buffer) {
    const { tileWidth, tileHeight, bitsPerSample, planarConfiguration } = this.parameters;
    const bps = Array.isArray(bitsPerSample) || ArrayBuffer.isView(bitsPerSample) ? Array.from(bitsPerSample) : [bitsPerSample];
    const bytes = planarConfiguration === 2 ? Math.ceil(bps[0] / 8) : bps.reduce((a, b) => a + Math.ceil(b / 8), 0);
    const expect = tileWidth * tileHeight * bytes;
    if (!(expect > 0) || expect > 1 << 30) throw new Error('a compressed TIFF block is corrupt (impossible ZSTD block size)');
    const out = zstd.decode(new Uint8Array(buffer), expect);
    if (out.byteLength !== expect) throw new Error('a compressed TIFF block is corrupt (ZSTD)');
    return out.buffer.byteLength === out.byteLength ? out.buffer : out.slice().buffer;
  }
}
addDecoder(50000, () => zstdReady().then(() => BoundedZstdDecoder));

/**
 * Deflate blocks (compression 8 and 32946) through the browser's own zlib (DecompressionStream)
 * instead of geotiff.js's JavaScript inflate: a 9506 × 12197 deflated CInt16 SLC spent most of its
 * 8.6 s to first tile inflating (CX-086). geotiff.js's decoder still takes any block it refuses.
 */
let deflateReady = null;
function useNativeDeflate() {
  deflateReady ??= (async () => {
    if (typeof DecompressionStream !== 'function') return;
    const JsDeflate = (await getDecoder(8, { tileWidth: 1, tileHeight: 1, planarConfiguration: 1, bitsPerSample: [8], predictor: 1 })).constructor;
    class NativeDeflateDecoder extends BaseDecoder {
      async decodeBlock(buffer) {
        try {
          return await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer();
        } catch {
          this.js ??= new JsDeflate(this.parameters);
          return this.js.decodeBlock(buffer);
        }
      }
    }
    addDecoder([8, 32946], () => NativeDeflateDecoder);
  })();
  return deflateReady;
}

/**
 * TIFF JPEG blocks (compression 7), IMP-24 and TE-062.
 * - Speed (TE-066): geotiff.js's JavaScript decoder costs 15–120 ms per 512² block; the browser's
 *   own JPEG decoder (createImageBitmap in the worker) is several times faster.
 * - Colour (TE-062): geotiff.js returns the JPEG components as stored, so YCbCr TIFFs came back as
 *   Y/Cb/Cr. The native decoder converts YCbCr to RGB as libjpeg (and GDAL) do; the JavaScript
 *   fallback's output is converted here. Blocks are returned as RGB for Photometric 6.
 * Abbreviated streams get the JPEGTables spliced in. The native path is used where its colour
 * handling is certain (YCbCr, grey, RGB with an Adobe "no transform" marker, 8-bit); anything else
 * (12-bit, CMYK, RGB without the marker) goes to geotiff.js's decoder.
 */
let jpegReady = null;
export function useFastJpeg() {
  jpegReady ??= (async () => {
    const JsJpeg = (await getDecoder(7, { tileWidth: 1, tileHeight: 1, planarConfiguration: 1, bitsPerSample: [8], predictor: 1 })).constructor;
    const native = typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function';
    class FastJpegDecoder extends BaseDecoder {
      constructor(params) {
        super(params);
        const t = params.JPEGTables;
        // The tables stream without its EOI, so a block (without its SOI) can follow it.
        this.tables = t && t.length > 4 ? Uint8Array.from(t).subarray(0, t.length - 2) : null;
        this.js = null;
      }
      async decodeBlock(buffer) {
        const { tileWidth: tw, tileHeight: th, photometric } = this.parameters;
        let d = new Uint8Array(buffer);
        if (this.tables && d[0] === 0xff && d[1] === 0xd8) {
          const s = new Uint8Array(this.tables.length + d.length - 2);
          s.set(this.tables);
          s.set(d.subarray(2), this.tables.length);
          d = s;
        }
        const info = jpegInfo(d);
        const ok = native && info && info.bits === 8 && (info.comps === 1 || (info.comps === 3 && (photometric === 6 || info.adobe === 0)));
        if (ok) {
          try {
            const bmp = await createImageBitmap(new Blob([d], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const g = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(bmp, 0, 0);
            const rgba = g.getImageData(0, 0, bmp.width, bmp.height).data;
            const w = bmp.width;
            bmp.close();
            const n = info.comps;
            const out = new Uint8Array(tw * th * n);
            const W = Math.min(w, tw);
            const H = Math.min(rgba.length / 4 / w, th);
            for (let y = 0; y < H; y++)
              for (let x = 0, i = y * w * 4, o = y * tw * n; x < W; x++, i += 4, o += n) {
                out[o] = rgba[i];
                if (n === 3) {
                  out[o + 1] = rgba[i + 1];
                  out[o + 2] = rgba[i + 2];
                }
              }
            return out.buffer;
          } catch {
            /* the browser refused this stream: the JavaScript decoder reports it by name */
          }
        }
        this.js ??= new JsJpeg(this.parameters);
        const raw = await this.js.decodeBlock(buffer);
        if (photometric === 6 && info?.comps === 3) yccToRgb(new Uint8Array(raw));
        return raw;
      }
    }
    addDecoder(7, () => FastJpegDecoder, jpegParams);
    // Old-style JPEG (compression 6, REQ-FMT-43): each strip or tile is rebuilt into a baseline JPEG
    // stream from the tables openGeoTiff prepared (Rust `legacy` bundle, as libtiff's tif_ojpeg.c
    // does), then decoded like compression 7.
    class OJpegDecoder extends FastJpegDecoder {
      async decodeBlock(buffer) {
        const { tileWidth: tw, tileHeight: th, ojpeg } = this.parameters;
        if (!ojpeg) throw new Error('OJPEG (TIFF compression 6): the tables were not prepared');
        const legacy = await self.GW.ensure('legacy');
        const [hp, hn] = legacy.put(ojpeg.header);
        const [bp, bn] = legacy.put(new Uint8Array(buffer));
        let s;
        try {
          if (legacy.x.gw_ojpeg_stream(hp, hn, bp, bn, tw, th, ojpeg.ncomp, ojpeg.hs, ojpeg.vs, ojpeg.restart) !== 0) throw gwError('OJPEG (TIFF compression 6): {msg}', { msg: nested(wasmError(legacy)) });
          s = legacy.outBytes();
        } finally {
          legacy.free(hp, hn);
          legacy.free(bp, bn);
        }
        const rgb = await super.decodeBlock(s.buffer);
        if (ojpeg.ycc) libtiffYcc(new Uint8Array(rgb), ojpeg.ycc);
        return rgb;
      }
    }
    addDecoder(6, () => OJpegDecoder, async (fd) => ({ ...(await jpegParams(fd)), JPEGTables: null, ojpeg: OJPEG.get(fd) ?? null }));
  })();
  return jpegReady;
}

/**
 * RGB decoded with the JFIF full-range YCbCr transform → RGB as libtiff's TIFFYCbCrToRGB gives it
 * for this ReferenceBlackWhite and YCbCrCoefficients (in place): back to Y, Cb, Cr, then each code
 * scaled from its reference range (Y to 255, chroma to 127) and converted with the image's luma.
 */
function libtiffYcc(a, { rbw, luma }) {
  const [lr, lg, lb] = luma;
  const k = (v, lo, hi, range) => (hi !== lo ? ((v - lo) * range) / (hi - lo) : 0);
  const c = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0; i + 2 < a.length; i += 3) {
    const [r, g, b] = [a[i], a[i + 1], a[i + 2]];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    const Y = k(y, rbw[0], rbw[1], 255);
    const Cb = k(cb, rbw[2], rbw[3], 127);
    const Cr = k(cr, rbw[4], rbw[5], 127);
    const R = Y + Cr * (2 - 2 * lr);
    const B = Y + Cb * (2 - 2 * lb);
    a[i] = c(R);
    a[i + 1] = c((Y - lb * B - lr * R) / lg);
    a[i + 2] = c(B);
  }
}

/** Old-style JPEG tables by image directory, prepared before any block is decoded. */
const OJPEG = new WeakMap();

/** Classic-TIFF IFD number `index` of a file: {off, bytes, le}, or null (BigTIFF, damaged). */
async function rawIfd(file, index) {
  const rd = async (o, n) => new Uint8Array(await file.slice(o, Math.min(file.size, o + n)).arrayBuffer());
  const h = await rd(0, 8);
  if (h.length < 8) return null;
  const le = h[0] === 0x49;
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv(h).getUint16(2, le) !== 42) return null;
  let off = dv(h).getUint32(4, le);
  for (let k = 0; off > 0 && off < file.size && k <= index && k < 1024; k++) {
    const c = await rd(off, 2);
    if (c.length < 2) return null;
    const n = dv(c).getUint16(0, le);
    const bytes = await rd(off, 2 + 12 * n + 4);
    if (bytes.length < 2 + 12 * n + 4) return null;
    if (k === index) return { off, bytes, le };
    off = dv(bytes).getUint32(2 + 12 * n, le);
  }
  return null;
}

/** Values of the wanted tags of a raw IFD (entries parsed by the Rust `legacy` bundle). */
async function rawTags(file, ifd, wanted) {
  const legacy = await self.GW.ensure('legacy');
  const [p, n] = legacy.put(ifd.bytes);
  let entries;
  try {
    if (legacy.x.gw_tiff_ifd(p, n, ifd.le ? 1 : 0) !== 0) throw gwError('TIFF directory: {msg}', { msg: nested(wasmError(legacy)) });
    entries = legacy.outJson().entries;
  } finally {
    legacy.free(p, n);
  }
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 13: 4 };
  const out = new Map();
  for (const [t, type, count, ...raw] of entries) {
    if (!wanted.includes(t) || !SIZE[type] || count < 1 || count > 4096) continue;
    const len = SIZE[type] * count;
    let b = Uint8Array.from(raw);
    if (len > 4) {
      const o = new DataView(b.buffer).getUint32(0, ifd.le);
      b = new Uint8Array(await file.slice(o, Math.min(file.size, o + len)).arrayBuffer());
      if (b.length < len) continue;
    }
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    out.set(t, Array.from({ length: count }, (_, i) => (type === 5 ? dv.getUint32(8 * i, ifd.le) / (dv.getUint32(8 * i + 4, ifd.le) || 1) : SIZE[type] === 1 ? b[i] : SIZE[type] === 2 ? dv.getUint16(2 * i, ifd.le) : dv.getUint32(4 * i, ifd.le))));
  }
  return out;
}

/**
 * Read an old-style JPEG image's tables (JPEGInterchangeFormat, or JPEGQTables/DCTables/ACTables)
 * from its directory (read directly: geotiff.js misreads some of these arrays) and build the stream
 * header every block shares. Throws a named error when libtiff could not recover the image either
 * (no tables at all, lossless mode).
 */
async function prepareOjpeg(file, img, index) {
  const fd = img.fileDirectory;
  if (OJPEG.has(fd)) return;
  const ifd = await rawIfd(file, index);
  if (!ifd) throw new Error('OJPEG (TIFF compression 6): the image directory cannot be read');
  const T = await rawTags(file, ifd, [512, 513, 514, 515, 519, 520, 521, 529, 530, 532]);
  const one = (t) => T.get(t)?.[0] ?? 0;
  if (one(512) === 14) throw new Error('OJPEG (TIFF compression 6) in lossless mode (JPEGProc 14) is not decoded; libtiff does not recover it either');
  const rd = async (o, n) => new Uint8Array(await file.slice(o, Math.min(file.size, o + n)).arrayBuffer());
  const recs = [];
  const add = (kind, k, bytes) => {
    const r = new Uint8Array(6 + bytes.length);
    r[0] = kind;
    r[1] = k;
    new DataView(r.buffer).setUint32(2, bytes.length, true);
    r.set(bytes, 6);
    recs.push(r);
  };
  if (one(513) > 0 && one(514) > 0 && one(513) < file.size) add(3, 0, await rd(one(513), Math.min(one(514), 1 << 20)));
  else {
    const [q, dc, ac] = [T.get(519) ?? [], T.get(520) ?? [], T.get(521) ?? []];
    if (!q.length || !dc.length || !ac.length) throw new Error('OJPEG (TIFF compression 6) without JPEGInterchangeFormat or JPEG tables: libtiff cannot recover it either');
    for (const [k, o] of q.entries()) add(0, k, await rd(o, 64));
    for (const [k, o] of dc.entries()) add(1, k, await rd(o, 16 + 256));
    for (const [k, o] of ac.entries()) add(2, k, await rd(o, 16 + 256));
  }
  const all = new Uint8Array(recs.reduce((a, r) => a + r.length, 0));
  recs.reduce((at, r) => (all.set(r, at), at + r.length), 0);
  const legacy = await self.GW.ensure('legacy');
  const [p, n] = legacy.put(all);
  let header;
  try {
    if (legacy.x.gw_ojpeg_header(p, n) !== 0) throw gwError('OJPEG (TIFF compression 6) tables: {msg}', { msg: nested(wasmError(legacy)) });
    header = legacy.outBytes();
  } finally {
    legacy.free(p, n);
  }
  const sub = T.get(530) ?? [2, 2];
  const spp = img.getSamplesPerPixel();
  // libtiff converts YCbCr with ReferenceBlackWhite and YCbCrCoefficients (TIFFYCbCrToRGB); the JPEG
  // decoders use the JFIF full range, so a non-default pair is applied after (see OJpegDecoder).
  const rbw = T.get(532);
  const luma = T.get(529);
  const custom = (rbw?.length === 6 && rbw.join() !== '0,255,128,255,128,255') || (luma?.length === 3 && luma.some((v, i) => Math.abs(v - [0.299, 0.587, 0.114][i]) > 1e-4));
  OJPEG.set(fd, { header, ncomp: spp >= 3 ? 3 : 1, hs: spp >= 3 ? sub[0] || 2 : 1, vs: spp >= 3 ? sub[1] || 2 : 1, restart: one(515), ycc: spp >= 3 && custom ? { rbw: rbw?.length === 6 ? rbw : [0, 255, 128, 255, 128, 255], luma: luma?.length === 3 ? luma : [0.299, 0.587, 0.114] } : null });
}

/**
 * A directory libtiff tolerates but geotiff.js refuses (entries of field type 0, as in libtiff's
 * ojpeg_single_strip_no_rowsperstrip.tiff): the same file with those entries made harmless, built as
 * a Blob of slices (no copy). Null when the first directory needs no repair.
 */
async function repairedTiff(file) {
  const ifd = await rawIfd(file, 0);
  if (!ifd) return null;
  const legacy = await self.GW.ensure('legacy');
  const [p, n] = legacy.put(ifd.bytes);
  let fixed;
  try {
    if (legacy.x.gw_tiff_ifd_repair(p, n, ifd.le ? 1 : 0) !== 0) return null;
    fixed = legacy.outBytes();
  } finally {
    legacy.free(p, n);
  }
  return fixed.length ? new Blob([file.slice(0, ifd.off), fixed, file.slice(ifd.off + fixed.length)]) : null;
}

/** geotiff.js's own JPEG decoder parameters (it adds JPEGTables), plus the photometric interpretation. */
async function jpegParams(fd) {
  const tiled = !fd.hasTag('StripOffsets');
  return {
    tileWidth: await fd.loadValue(tiled ? 'TileWidth' : 'ImageWidth'),
    tileHeight: tiled ? await fd.loadValue('TileLength') : (await fd.loadValue('RowsPerStrip')) || (await fd.loadValue('ImageLength')),
    planarConfiguration: await fd.loadValue('PlanarConfiguration'),
    bitsPerSample: await fd.loadValue('BitsPerSample'),
    predictor: (await fd.loadValue('Predictor')) || 1,
    JPEGTables: await fd.loadValue('JPEGTables'),
    photometric: await fd.loadValue('PhotometricInterpretation'),
  };
}

/** Components, precision and Adobe transform code from a JPEG stream's markers (null if none). */
function jpegInfo(d) {
  let adobe = null;
  for (let i = 2; i + 4 < d.length; ) {
    if (d[i] !== 0xff) return null;
    const m = d[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    const len = (d[i + 2] << 8) | d[i + 3];
    if (m === 0xee && len >= 12 && String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7], d[i + 8]) === 'Adobe') adobe = d[i + 15];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { bits: d[i + 4], comps: d[i + 9], adobe, progressive: m === 0xc2 };
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/** Pixel-interleaved Y, Cb, Cr → R, G, B in place (JFIF full range, as libjpeg). */
function yccToRgb(a) {
  const c = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  for (let i = 0; i + 2 < a.length; i += 3) {
    const y = a[i];
    const cb = a[i + 1] - 128;
    const cr = a[i + 2] - 128;
    a[i] = c(y + 1.402 * cr);
    a[i + 1] = c(y - 0.344136 * cb - 0.714136 * cr);
    a[i + 2] = c(y + 1.772 * cb);
  }
}

/**
 * TE-005 (REQ-SEC-02): geotiff.js reports damaged files with raw engine messages ("Offset is
 * outside the bounds of the DataView", "… exceeds MAX_SAFE_INTEGER …"). Name the failure for the
 * analyst; the library message stays on error.cause for diagnosis.
 */
export function tiffError(e) {
  const m = String(e?.message ?? e);
  let why = null;
  if (e instanceof RangeError || /DataView|array buffer length|out of (bounds|range)|Array buffer allocation/i.test(m)) why = 'the TIFF is truncated or damaged: a tag or block points outside the file';
  else if (/MAX_SAFE_INTEGER|BigInt/i.test(m)) why = 'the TIFF declares an impossible size or offset';
  else if (/Invalid field type|Unknown field type|Invalid TIFF|Invalid byte order|Invalid magic/i.test(m)) why = `the TIFF header or a tag is invalid (${m.replace(/[^\w :.-]/g, '').slice(0, 40)})`;
  else if (/Expected \w+ to be|BitsPerSample|SamplesPerPixel/i.test(m)) why = 'the TIFF has an invalid sample layout (BitsPerSample / SamplesPerPixel)';
  else if (/old style JPEG/i.test(m)) why = 'old-style JPEG compression (TIFF compression 6) is not supported; re-save with compression 7';
  else if (/Failed to fetch|incorrect header check|invalid (block|distance|code)|unexpected end|corrupt|Unknown frame descriptor|data error/i.test(m)) why = 'a compressed TIFF block is corrupt';
  else if (/Unknown compression|unsupported compression|not supported/i.test(m)) why = `the TIFF uses a compression this build does not decode (${m.slice(0, 60)})`;
  if (!why) return e instanceof Error ? e : new Error(m);
  return new Error(why, { cause: e });
}

const TAG_RPC = 50844;
const TAG_GDAL_METADATA = 42112;
const TAG_GDAL_NODATA = 42113;

/**
 * One TIFF tag by name or number. geotiff.js 3 keeps large or rare tags deferred behind
 * loadValue(); older builds exposed plain properties. Missing tags give undefined.
 */
async function tag(fd, id) {
  try {
    if (typeof fd.loadValue === 'function') return fd.hasTag(id) ? await fd.loadValue(id) : undefined;
  } catch {
    return undefined;
  }
  return fd[id];
}

async function sampleType(img) {
  const bps = img.getBitsPerSample();
  const fmt = (await tag(img.fileDirectory, 'SampleFormat'))?.[0] ?? 1; // 1 uint, 2 int, 3 float
  if (fmt === 3) return 'f32';
  if (fmt === 2) return bps <= 16 ? 'i16' : 'f32';
  if (bps <= 8) return 'u8';
  if (bps <= 16) return 'u16';
  return 'f32';
}

const CTOR = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };

function convert(arr, type) {
  const C = CTOR[type];
  return arr instanceof C ? arr : C.from(arr);
}

export async function openGeoTiff(file) {
  try {
    return await openGeoTiff0(file);
  } catch (e) {
    throw tiffError(e);
  }
}

async function openGeoTiff0(file) {
  await useFastJpeg();
  await useNativeDeflate();
  let tiff = file.remote ? await fromCustomClient(remoteClient(file), { blockSize: 65536, cacheSize: 400 }) : await fromBlob(file);
  let count;
  try {
    count = await tiff.getImageCount();
  } catch (e) {
    // A directory entry of an invalid field type, which libtiff skips (FC-17: libtiff's OJPEG samples).
    const fixed = !file.remote && /Invalid field type/i.test(String(e?.message)) ? await repairedTiff(file) : null;
    if (!fixed) throw e;
    tiff = await fromBlob(fixed);
    count = await tiff.getImageCount();
  }
  if (count < 1) throw new Error('TIFF has no images');
  const main = await tiff.getImage(0);
  const W = main.getWidth();
  const H = main.getHeight();
  // TE-066: a pyramid tile (512 px plus a 4-px border) overlaps up to four TIFF tiles, so building
  // coarse levels of an image without overviews decoded every block about four times. Keep the most
  // recently decoded blocks (≈128 MB per image) in geotiff.js's per-image tile slot.
  const keepTiles = (im) => {
    if (!im.isTiled) return;
    const per = im.getTileWidth() * im.getTileHeight() * im.getBytesPerPixel();
    const max = Math.max(16, Math.floor((128 << 20) / Math.max(1, per)));
    const m = new Map();
    im.tiles = new Proxy({}, {
      get: (_, k) => {
        const v = m.get(k);
        if (v !== undefined) (m.delete(k), m.set(k, v));
        return v;
      },
      set: (_, k, v) => {
        m.set(k, v);
        if (m.size > max) m.delete(m.keys().next().value);
        return true;
      },
    });
  };
  keepTiles(main);
  // Overviews: subsequent full-extent images that are smaller (COG). Skip masks.
  const overviews = [];
  let maskImg = null; // GDAL internal (PER_DATASET) mask at full resolution (TE-053)
  for (let i = 1; i < count; i++) {
    const im = await tiff.getImage(i);
    const sub = (await tag(im.fileDirectory, 'NewSubfileType')) ?? 0;
    if (sub & 4) {
      if (!maskImg && im.getWidth() === W && im.getHeight() === H) maskImg = im; // transparency mask
      continue;
    }
    if (im.getWidth() < W && im.getSamplesPerPixel() === main.getSamplesPerPixel()) (keepTiles(im), overviews.push({ img: im, scale: W / im.getWidth() }));
  }
  // Complex samples (SampleFormat 5 complex integer, 6 complex float: SAR SLC GeoTIFFs) are read
  // block by block here, geotiff.js not handling them (IMP-16).
  const fmt0 = (await tag(main.fileDirectory, 'SampleFormat'))?.[0] ?? 1;
  const complex = fmt0 === 5 || fmt0 === 6 ? { fmt: fmt0, bps: main.getBitsPerSample() } : null;
  const type = complex ? 'f32' : await sampleType(main);
  const fd = main.fileDirectory;
  const T = {};
  for (const k of ['PhotometricInterpretation', 'Compression', 'TileWidth', 'TileLength', 'ModelTransformation', 'ImageDescription', 'DateTime', 'Software', 'MaxSampleValue']) T[k] = await tag(fd, k);
  // Old-style JPEG (FC-17): tables prepared once per image before any block decodes.
  if (T.Compression === 6) for (const [k, im] of (await Promise.all(Array.from({ length: count }, (_, i) => tiff.getImage(i)))).entries()) await prepareOjpeg(file, im, k);
  const nodataText = await tag(fd, TAG_GDAL_NODATA);
  let nodata = nodataText !== undefined ? Number(String(nodataText).replace(/\0/g, '').trim()) : null;
  if (nodata !== null && !Number.isFinite(nodata) && !Number.isNaN(nodata)) nodata = null;
  if (type === 'f32' && nodata === null) nodata = NaN;
  // TE-053: with an internal mask and no no-data tag, masked pixels read as a no-data value (0 for
  // unsigned types, GDAL's usual fill; the type minimum for signed; NaN for float).
  if (maskImg && nodata === null) nodata = type === 'i16' ? -32768 : 0;
  let rpc = null;
  const rpcTag = await tag(fd, TAG_RPC);
  if (rpcTag && rpcTag.length >= 92) rpc = Array.from(rpcTag).slice(0, 92);
  const geoKeys = main.getGeoKeys?.() ?? {};
  // Several tie points and no pixel scale: ground control points (REQ-FMT-05).
  const tie = await tag(fd, 'ModelTiepoint');
  const scale = await tag(fd, 'ModelPixelScale');
  const gcps = tie && tie.length >= 18 && !scale ? Array.from({ length: Math.floor(tie.length / 6) }, (_, i) => ({ x: tie[i * 6], y: tie[i * 6 + 1], lon: tie[i * 6 + 3], lat: tie[i * 6 + 4], h: tie[i * 6 + 5] })) : null;
  let geotransform = null;
  try {
    const origin = main.getOrigin();
    const res = main.getResolution();
    const mt = T.ModelTransformation;
    if (mt && mt.length >= 16) geotransform = [mt[3], mt[0], mt[1], mt[7], mt[4], mt[5]];
    else {
      geotransform = [origin[0], res[0], 0, origin[1], 0, res[1]];
      // A tie point at raster (I, J) ≠ (0, 0) (DigitalGlobe tiles tie (0.5, 0.5)): geotiff.js's
      // origin is the tie point's map position; the grid origin is I and J pixels before it.
      if (tie && tie.length >= 6 && !gcps && (tie[0] || tie[1])) {
        geotransform[0] -= tie[0] * res[0];
        geotransform[3] -= tie[1] * res[1];
      }
    }
    // PixelIsPoint: shift by half a pixel to the corner convention.
    if (geoKeys.GTRasterTypeGeoKey === 2 && geotransform) {
      geotransform[0] -= geotransform[1] / 2;
      geotransform[3] -= geotransform[5] / 2;
    }
  } catch {
    geotransform = null;
  }
  if (gcps) geotransform = null;
  const epsg = geoKeys.ProjectedCSTypeGeoKey ?? geoKeys.GeographicTypeGeoKey ?? null;
  const gdalMeta = (await tag(fd, TAG_GDAL_METADATA)) ?? null;
  const bands = complex ? 2 : main.getSamplesPerPixel();
  const meta = {
    format: count > 1 && overviews.length ? 'COG/GeoTIFF' : 'GeoTIFF',
    width: W,
    height: H,
    bands,
    sampleType: complex ? `${complex.fmt === 5 ? 'CInt' : 'CFloat'}${complex.bps / 2}` : type,
    complex: !!complex,
    bitsPerSample: main.getBitsPerSample(),
    photometric: T.PhotometricInterpretation,
    compression: T.Compression,
    tiled: !!T.TileWidth,
    tile: T.TileWidth ? [T.TileWidth, T.TileLength] : null,
    overviews: overviews.map((o) => [o.img.getWidth(), o.img.getHeight()]),
    nodata: Number.isNaN(nodata) ? 'NaN' : nodata,
    mask: maskImg ? 'internal (PER_DATASET): masked pixels read as no-data' : null,
    geoKeys,
    epsg,
    gcps,
    geotransform: geotransform && geotransform.every(Number.isFinite) && (geotransform[1] !== 1 || geotransform[5] !== 1 || geotransform[0] !== 0) ? geotransform : null,
    rpc,
    gdalMetadata: gdalMeta ? String(gdalMeta).slice(0, 20000) : null,
    imageDescription: T.ImageDescription ? String(T.ImageDescription).replace(/\0+$/, '').slice(0, 2000) : null,
    dateTime: T.DateTime ?? null,
    software: T.Software ?? null,
    // MaxSampleValue (tag 281): the native bit depth of 11- and 12-bit imagery (REQ-GAP-14).
    maxSampleValue: (() => {
      const v = T.MaxSampleValue;
      const x = Array.isArray(v) || ArrayBuffer.isView(v) ? Math.max(...v) : Number(v);
      return Number.isFinite(x) && x > 0 ? x : null;
    })(),
  };

  if (complex) return { meta, source: await complexSource(tiff, main, complex) };

  // TE-018 / IMP-02: a striped (untiled) image decodes whole-width strips; reading it tile by tile
  // decoded every strip once per tile column (≈ 70× for a 35 k-pixel-wide WorldView strip). Read
  // whole-width row bands once and cut tiles from them (LRU, ~256 MB).
  // Narrow images with many short strips take the same path (CX-086: an 871 × 3271 Hyperion band in
  // 3271 one-row strips spent 3 s on statistics, each strip a separate read, twice per tile column).
  const untiled = !(await tag(main.fileDirectory, 'TileWidth'));
  const striped = untiled && (W > 2048 || H / (main.getTileHeight() || H) > 64);
  const BAND_ROWS = 512;
  const bandCache = new Map();
  let bandBytes = 0;
  // Uncompressed strips stored back to back are read as one byte range per row band.
  const fmt = (await tag(fd, 'SampleFormat'))?.[0] ?? 1;
  const bps = Number(main.getBitsPerSample());
  const rawGet = { 'u8/8/1': (dv, o) => dv.getUint8(o), 'u16/16/1': (dv, o) => dv.getUint16(o, main.littleEndian), 'i16/16/2': (dv, o) => dv.getInt16(o, main.littleEndian), 'f32/32/3': (dv, o) => dv.getFloat32(o, main.littleEndian) }[`${type}/${bps}/${fmt}`];
  const rawRows = striped && rawGet && (T.Compression ?? 1) === 1 && ((await tag(fd, 'PlanarConfiguration')) ?? 1) === 1;
  let stripTable = null;
  let stripCounts = null;
  async function rawBand(b0, y1, sel) {
    stripTable ??= Array.from(await fd.loadValue('StripOffsets'), Number);
    stripCounts ??= Array.from(await fd.loadValue('StripByteCounts'), Number);
    const rps = main.getTileHeight();
    const s0 = Math.floor(b0 / rps);
    const s1 = Math.ceil(y1 / rps);
    for (let s = s0; s + 1 < s1; s++) if (stripTable[s + 1] !== stripTable[s] + stripCounts[s]) return null;
    const spp = main.getSamplesPerPixel();
    const bytesPer = bps / 8;
    const rowBytes = W * spp * bytesPer;
    const [buf] = await main.source.fetch([{ offset: stripTable[s0] + (b0 - s0 * rps) * rowBytes, length: (y1 - b0) * rowBytes }]);
    const dv = new DataView(buf);
    const n = W * (y1 - b0);
    return sel.map((b) => {
      const out = new CTOR[type](n);
      for (let i = 0, o = b * bytesPer; i < n; i++, o += spp * bytesPer) out[i] = rawGet(dv, o);
      return out;
    });
  }
  async function rowBand(img, b0, sel) {
    const key = `${b0}/${sel.join(',')}`;
    if (bandCache.has(key)) {
      const v = bandCache.get(key);
      bandCache.delete(key);
      bandCache.set(key, v); // most recent last
      return v;
    }
    const y1 = Math.min(img.getHeight(), b0 + BAND_ROWS);
    const viaRasters = () => img.readRasters({ window: [0, b0, img.getWidth(), y1], samples: sel, interleave: false, fillValue: Number.isFinite(nodata) ? nodata : 0 }).then((r) => r.map((a) => convert(a, type)));
    const p = rawRows && img === main ? rawBand(b0, y1, sel).then((r) => r ?? viaRasters()) : viaRasters();
    bandCache.set(key, p);
    p.then((arr) => {
      bandBytes += arr.reduce((t, a) => t + a.byteLength, 0);
      for (const [k, v] of bandCache) {
        if (bandBytes <= 256 << 20 || k === key) break;
        bandCache.delete(k);
        v.then((a2) => (bandBytes -= a2.reduce((t, a) => t + a.byteLength, 0)), () => {});
      }
    }, () => bandCache.delete(key));
    return p;
  }

  // IMP-04: an uncompressed striped image (no overviews) gets coarse levels from strided row reads,
  // like raw NITF (TE-019): level L reads every 2^L-th row's span, not every strip.
  const rawStrided = striped && !overviews.length && (T.Compression ?? 1) === 1 && ((await tag(fd, 'PlanarConfiguration')) ?? 1) === 1 && [8, 16, 32].includes(Number(main.getBitsPerSample()));
  async function readStrided(L, x0, y0, w, h, bands) {
    const st = 2 ** L;
    const spp = main.getSamplesPerPixel();
    const bytesPer = Number(main.getBitsPerSample()) / 8;
    const rps = main.getTileHeight();
    if (!stripTable) stripTable = Array.from(await fd.loadValue('StripOffsets'), Number);
    const C = CTOR[type];
    const out = bands.map(() => new C(w * h).fill(Number.isFinite(nodata) ? nodata : 0));
    const fx0 = Math.min(W, x0 * st);
    const fx1 = Math.min(W, (x0 + w) * st);
    if (fx1 <= fx0) return out;
    const rows = [];
    for (let j = 0; j < h; j++) {
      const Y = (y0 + j) * st;
      if (Y >= H) break;
      const strip = Math.floor(Y / rps);
      rows.push({ j, offset: stripTable[strip] + ((Y - strip * rps) * W + fx0) * spp * bytesPer, length: (fx1 - fx0) * spp * bytesPer });
    }
    const le = main.littleEndian;
    const get = bytesPer === 1 ? (dv, o) => dv.getUint8(o) : bytesPer === 2 ? (type === 'i16' ? (dv, o) => dv.getInt16(o, le) : (dv, o) => dv.getUint16(o, le)) : type === 'f32' && ((await tag(fd, 'SampleFormat'))?.[0] ?? 1) === 3 ? (dv, o) => dv.getFloat32(o, le) : (dv, o) => dv.getUint32(o, le);
    for (let k = 0; k < rows.length; k += 256) {
      const part = rows.slice(k, k + 256);
      const bufs = await main.source.fetch(part.map((r) => ({ offset: r.offset, length: r.length })));
      part.forEach((r, i) => {
        const dv = new DataView(bufs[i]);
        for (let x = 0; x < w && fx0 + x * st < fx1; x++) {
          const px = x * st * spp;
          for (let q = 0; q < bands.length; q++) out[q][r.j * w + x] = get(dv, (px + bands[q]) * bytesPer);
        }
      });
    }
    return out;
  }

  /** Masked pixels of a full-resolution window → no-data (TE-053). */
  async function masked(out, x0, y0, w, h) {
    if (!maskImg) return out;
    let m;
    try {
      [m] = await maskImg.readRasters({ window: [Math.floor(x0), Math.floor(y0), Math.ceil(x0 + w), Math.ceil(y0 + h)], samples: [0], interleave: false, fillValue: 0 });
    } catch (e) {
      throw tiffError(e);
    }
    for (let i = 0; i < m.length; i++) if (!m[i]) for (const p of out) p[i] = nodata;
    return out;
  }

  async function read(img, scale, x0, y0, w, h, bands) {
    return img === main ? masked(await read0(img, scale, x0, y0, w, h, bands), x0, y0, w, h) : read0(img, scale, x0, y0, w, h, bands);
  }

  // TE-066 / IMP-24: a pyramid core read is exactly one 512² block of a 512-tiled image; for 8-bit
  // pixel-interleaved JPEG the decoded block is split into bands directly, instead of through
  // geotiff.js's per-sample DataView copy (most of the time per block).
  const blockFast = T.Compression === 7 && Number(main.getBitsPerSample()) === 8 && ((await tag(fd, 'PlanarConfiguration')) ?? 1) === 1 && main.isTiled;
  const decoders = new Map();
  async function readBlock(img, x0, y0, w, h, bands) {
    const tw = img.getTileWidth();
    const th = img.getTileHeight();
    if (!blockFast || x0 % tw || y0 % th || w > tw || h > th || x0 + w > img.getWidth() || y0 + h > img.getHeight()) return null;
    if (!decoders.has(img)) decoders.set(img, getDecoder(7, await jpegParams(img.fileDirectory)));
    const { data } = await img.getTileOrStrip(x0 / tw, y0 / th, 0, await decoders.get(img));
    const u8 = new Uint8Array(data);
    const spp = img.getSamplesPerPixel();
    return bands.map((b) => {
      const out = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0, i = y * tw * spp + b, o = y * w; x < w; x++, i += spp) out[o + x] = u8[i];
      return out;
    });
  }

  async function read0(img, scale, x0, y0, w, h, bands) {
    if (blockFast) {
      try {
        const r = await readBlock(img, x0, y0, w, h, bands);
        if (r) return r;
      } catch (e) {
        throw tiffError(e);
      }
    }
    if (striped && img === main) {
      try {
        const out = bands.map(() => new CTOR[type](w * h));
        for (let b0 = Math.floor(y0 / BAND_ROWS) * BAND_ROWS; b0 < y0 + h && b0 < H; b0 += BAND_ROWS) {
          const planes = await rowBand(img, b0, bands);
          const rows = Math.min(BAND_ROWS, H - b0);
          for (let k = 0; k < bands.length; k++)
            for (let y = Math.max(y0, b0); y < Math.min(y0 + h, b0 + rows); y++) {
              const ww = Math.max(0, Math.min(w, W - x0));
              out[k].set(planes[k].subarray((y - b0) * W + x0, (y - b0) * W + x0 + ww), (y - y0) * w);
            }
        }
        return out;
      } catch (e) {
        throw tiffError(e);
      }
    }
    const win = [Math.floor(x0), Math.floor(y0), Math.ceil(x0 + w), Math.ceil(y0 + h)];
    let r;
    try {
      r = await img.readRasters({ window: win, samples: bands, interleave: false, fillValue: Number.isFinite(nodata) ? nodata : 0 });
    } catch (e) {
      throw tiffError(e);
    }
    return r.map((a) => convert(a, type));
  }

  // CX-086: an 8-bit JPEG image without overviews built every coarse tile from full-resolution
  // blocks averaged 2 × 2 in JavaScript level by level, on one worker: 10–12.6 s to the first tile of
  // a 16k² DigitalGlobe tile. Its reduced levels are now read in one pass: blocks decode in the
  // browser (sixteen in flight) and each is box-averaged straight into the level window. (Drawing
  // them scaled into a canvas was faster still but darkened every band by about 2 DN.)
  let nativeLevels = false;
  let tileTable = null;
  let jpegTables = null;
  if (blockFast && !overviews.length && !maskImg && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function' && [1, 3].includes(main.getSamplesPerPixel())) {
    const t = await tag(fd, 'JPEGTables');
    jpegTables = t && t.length > 4 ? Uint8Array.from(t).subarray(0, t.length - 2) : null;
    tileTable = { offsets: Array.from(await fd.loadValue('TileOffsets'), Number), counts: Array.from(await fd.loadValue('TileByteCounts'), Number) };
    const [first] = await main.source.fetch([{ offset: tileTable.offsets[0], length: tileTable.counts[0] }]);
    const info = jpegInfo(jpegStream(new Uint8Array(first)));
    const photometric = (await tag(fd, 'PhotometricInterpretation')) ?? 2;
    // The same streams the browser decoder takes for blocks (FastJpegDecoder).
    nativeLevels = !!info && info.bits === 8 && !info.progressive && (info.comps === 1 || (info.comps === 3 && (photometric === 6 || info.adobe === 0)));
  }
  function jpegStream(d) {
    if (!jpegTables || d[0] !== 0xff || d[1] !== 0xd8) return d;
    const s = new Uint8Array(jpegTables.length + d.length - 2);
    s.set(jpegTables);
    s.set(d.subarray(2), jpegTables.length);
    return s;
  }
  async function readScaledJpeg(L, x0, y0, w, h, bands) {
    const s = 2 ** L;
    const tw = main.getTileWidth();
    const th = main.getTileHeight();
    const across = Math.ceil(W / tw);
    const fx0 = x0 * s;
    const fy0 = y0 * s;
    const fx1 = Math.min(W, (x0 + w) * s);
    const fy1 = Math.min(H, (y0 + h) * s);
    const n = w * h;
    const ch = bands.map((b) => (main.getSamplesPerPixel() === 1 ? 0 : b));
    const sums = bands.map(() => new Uint32Array(n));
    const cnts = bands.map(() => new Uint32Array(n));
    const nd = Number.isFinite(nodata) ? nodata : -1;
    const step = L >= 3 ? 2 ** (L - 2) : 1;
    const todo = [];
    for (let ty = Math.floor(fy0 / th); ty * th < fy1; ty++) for (let tx = Math.floor(fx0 / tw); tx * tw < fx1; tx++) todo.push([tx, ty]);
    // Sixteen blocks in flight: the browser decodes them on its own threads.
    let next = 0;
    const run = async () => {
      const cv = new OffscreenCanvas(tw, th);
      const g = cv.getContext('2d', { willReadFrequently: true });
      while (next < todo.length) {
        const [tx, ty] = todo[next++];
        const i = ty * across + tx;
        if (!tileTable.counts[i]) continue;
        const [buf] = await main.source.fetch([{ offset: tileTable.offsets[i], length: tileTable.counts[i] }]);
        const bmp = await createImageBitmap(new Blob([jpegStream(new Uint8Array(buf))], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        g.drawImage(bmp, 0, 0);
        bmp.close();
        const rgba = g.getImageData(0, 0, tw, th).data;
        // The block's part of the full-resolution window, each pixel added to its level cell; from
        // level 3 a regular sub-grid of each cell (16 × 16 samples or more) stands for it.
        const bx0 = Math.max(tx * tw, fx0);
        const by0 = Math.max(ty * th, fy0);
        const bx1 = Math.min((tx + 1) * tw, fx1);
        const by1 = Math.min((ty + 1) * th, fy1);
        for (let q = 0; q < ch.length; q++) {
          const c = ch[q];
          const sum = sums[q];
          const cnt = cnts[q];
          for (let Y = by0 + ((by0 - fy0) % step ? step - ((by0 - fy0) % step) : 0); Y < by1; Y += step) {
            const row = ((Y - fy0) >> L) * w;
            const dx = (bx0 - fx0) % step ? step - ((bx0 - fx0) % step) : 0;
            for (let X = bx0 + dx, j = ((Y - ty * th) * tw + (X - tx * tw)) * 4 + c; X < bx1; X += step, j += 4 * step) {
              const v = rgba[j];
              if (v === nd) continue;
              const k = row + ((X - fx0) >> L);
              sum[k] += v;
              cnt[k]++;
            }
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(16, todo.length) }, run));
    const fill = nd >= 0 ? nd : 0;
    return bands.map((_, q) => {
      const out = new Uint8Array(n);
      for (let k = 0; k < n; k++) out[k] = cnts[q][k] ? Math.round(sums[q][k] / cnts[q][k]) : fill;
      return out;
    });
  }

  return {
    meta,
    source: {
      kind: 'geotiff',
      width: W,
      height: H,
      bands,
      sampleType: type,
      nodata,
      readWindow: (x0, y0, w, h, b) => read(main, 1, x0, y0, w, h, b),
      hasLevel: (L) => overviews.some((o) => Math.abs(o.scale - 2 ** L) / 2 ** L < 0.02) || (rawStrided && L >= 1) || (nativeLevels && L >= 1),
      async readLevel(L, x0, y0, w, h, b) {
        if (nativeLevels) {
          try {
            return await readScaledJpeg(L, x0, y0, w, h, b);
          } catch (e) {
            throw tiffError(e);
          }
        }
        if (rawStrided) {
          try {
            return await readStrided(L, x0, y0, w, h, b);
          } catch (e) {
            throw tiffError(e);
          }
        }
        const ov = overviews.find((o) => Math.abs(o.scale - 2 ** L) / 2 ** L < 0.02);
        const iw = ov.img.getWidth();
        const ih = ov.img.getHeight();
        // The level grid may be one pixel larger than the overview; clip and pad.
        const cw = Math.max(0, Math.min(w, iw - x0));
        const ch = Math.max(0, Math.min(h, ih - y0));
        const C = CTOR[type];
        const out = b.map(() => new C(w * h).fill(Number.isFinite(nodata) ? nodata : 0));
        if (cw > 0 && ch > 0) {
          const part = await read(ov.img, 2 ** L, x0, y0, cw, ch, b);
          for (let k = 0; k < b.length; k++) for (let y = 0; y < ch; y++) out[k].set(part[k].subarray(y * cw, y * cw + cw), y * w);
        }
        return out;
      },
    },
  };
}

/**
 * A complex-sample TIFF image (one sample per pixel: CInt16, CInt32 or CFloat32) as a two-band
 * (re, im) f32 source for the SAR band wrapper (IMP-16). Blocks are fetched, decompressed with
 * geotiff.js's decoders and split here; an LRU keeps about 256 MB of decoded blocks.
 */
async function complexSource(tiff, img, { fmt, bps }) {
  if (img.getSamplesPerPixel() !== 1) throw new Error('a complex TIFF with several samples per pixel is not read');
  const half = bps / 2;
  if (!((fmt === 5 && (half === 16 || half === 32)) || (fmt === 6 && half === 32))) throw gwError('complex TIFF samples of {bps} bits (SampleFormat {fmt}) are not read; CInt16, CInt32 and CFloat32 are', { bps: String(bps), fmt: String(fmt) });
  const fd = img.fileDirectory;
  if (((await tag(fd, 'Predictor')) ?? 1) !== 1) throw new Error('a complex TIFF with a predictor is not read');
  const W = img.getWidth();
  const H = img.getHeight();
  const tw = img.getTileWidth();
  const th = img.getTileHeight();
  const perRow = Math.ceil(W / tw);
  const tiled = img.isTiled;
  const compression = (await tag(fd, 'Compression')) ?? 1;
  const decoder = await getDecoder(compression, { tileWidth: tw, tileHeight: th, planarConfiguration: 1, bitsPerSample: bps, predictor: 1 });
  const le = tiff.littleEndian;
  // Block offsets and byte counts loaded once (perf 2.1): geotiff.js reads a deferred array one entry
  // at a time, two extra file reads per block (a Sentinel-1 SLC has one strip per row).
  const nBlocks = perRow * Math.ceil(H / th);
  let table = null;
  async function blockAt(key) {
    if (nBlocks <= 1 << 20) {
      table ??= Promise.all([tag(fd, tiled ? 'TileOffsets' : 'StripOffsets'), tag(fd, tiled ? 'TileByteCounts' : 'StripByteCounts')]).then(([o, c]) => (o?.length > 0 && c?.length === o.length ? { o: Array.from(o, Number), c: Array.from(c, Number) } : null), () => null);
      const t = await table;
      if (t && key < t.o.length) return [t.o[key], t.c[key]];
    }
    return [Number(await fd.loadValueIndexed(tiled ? 'TileOffsets' : 'StripOffsets', key)), Number(await fd.loadValueIndexed(tiled ? 'TileByteCounts' : 'StripByteCounts', key))];
  }
  const cache = new Map();
  let bytes = 0;
  const block = (bx, by) => {
    const key = by * perRow + bx;
    if (cache.has(key)) {
      const v = cache.get(key);
      cache.delete(key);
      cache.set(key, v);
      return v;
    }
    const p = (async () => {
      const [offset, count] = await blockAt(key);
      const rows = tiled ? th : Math.min(th, H - by * th);
      const n = tw * rows;
      const re = new Float32Array(n);
      const im = new Float32Array(n);
      if (!count) return { re: re.fill(NaN), im: im.fill(NaN), rows };
      const raw = (await img.source.fetch([{ offset, length: count }]))[0];
      const dv = new DataView(await decoder.decode(raw));
      const step = bps / 8;
      if (dv.byteLength < n * step) throw new Error('a complex TIFF block is shorter than its size');
      for (let i = 0; i < n; i++) {
        const o = i * step;
        if (fmt === 6) {
          re[i] = dv.getFloat32(o, le);
          im[i] = dv.getFloat32(o + 4, le);
        } else if (half === 16) {
          re[i] = dv.getInt16(o, le);
          im[i] = dv.getInt16(o + 2, le);
        } else {
          re[i] = dv.getInt32(o, le);
          im[i] = dv.getInt32(o + 4, le);
        }
      }
      return { re, im, rows };
    })();
    cache.set(key, p);
    p.then(
      () => {
        bytes += tw * th * 8;
        for (const k of cache.keys()) {
          if (bytes <= 256 << 20 || k === key) break;
          cache.delete(k);
          bytes -= tw * th * 8;
        }
      },
      () => cache.delete(key),
    );
    return p;
  };
  async function readWindow(x0, y0, w, h, sel = [0, 1]) {
    const out = sel.map(() => new Float32Array(w * h).fill(NaN));
    const cx0 = Math.max(0, x0);
    const cy0 = Math.max(0, y0);
    const cx1 = Math.min(W, x0 + w);
    const cy1 = Math.min(H, y0 + h);
    const jobs = [];
    for (let by = Math.floor(cy0 / th); by * th < cy1; by++)
      for (let bx = Math.floor(cx0 / tw); bx * tw < cx1; bx++)
        jobs.push(
          block(bx, by).then((b) => {
            for (let y = Math.max(cy0, by * th); y < Math.min(cy1, by * th + b.rows); y++)
              for (let k = 0; k < sel.length; k++) {
                const src = sel[k] === 0 ? b.re : b.im;
                const xa = Math.max(cx0, bx * tw);
                const xb = Math.min(cx1, bx * tw + tw);
                out[k].set(src.subarray((y - by * th) * tw + (xa - bx * tw), (y - by * th) * tw + (xb - bx * tw)), (y - y0) * w + (xa - x0));
              }
          }),
        );
    await Promise.all(jobs);
    return out;
  }
  // CX-086: coarse levels were composed from fully converted blocks level by level (6.9 s to the first
  // tile of a 9506 × 12197 deflated CInt16 SLC). I and Q are decimated anyway (never averaged), so a
  // level samples the centre of each 2^L cell straight from the inflated blocks, converting only the
  // rows it takes.
  async function readLevel(L, x0, y0, w, h, sel = [0, 1]) {
    const s = 2 ** L;
    const c = s >> 1;
    const out = sel.map(() => new Float32Array(w * h).fill(NaN));
    const step = bps / 8;
    const cols = [];
    for (let i = 0; i < w; i++) if ((x0 + i) * s + c < W) cols.push(i);
    const rowsOf = new Map(); // block row → [level row j, source row Y]
    for (let j = 0; j < h; j++) {
      const Y = (y0 + j) * s + c;
      if (Y >= H) break;
      const by = Math.floor(Y / th);
      (rowsOf.get(by) ?? rowsOf.set(by, []).get(by)).push([j, Y]);
    }
    const todo = [];
    for (const by of rowsOf.keys()) for (let bx = Math.floor(((x0 + cols[0]) * s + c) / tw); cols.length && bx * tw <= (x0 + cols.at(-1)) * s + c; bx++) todo.push([bx, by]);
    let next = 0;
    const run = async () => {
      while (next < todo.length) {
        const [bx, by] = todo[next++];
        const key = by * perRow + bx;
        const [offset, count] = await blockAt(key);
        if (!count) continue;
        // Uncompressed blocks: only the bytes from the first to the last sample this level takes
        // (perf 2.1: a Sentinel-1 SLC strip is one 88 KB row, and each of a level's tiles across
        // fetched all of it).
        let base = 0;
        let length = count;
        if (compression === 1) {
          const rs = rowsOf.get(by);
          const xs = cols.map((i) => (x0 + i) * s + c).filter((X) => Math.floor(X / tw) === bx);
          if (!xs.length) continue;
          base = ((rs[0][1] - by * th) * tw + (xs[0] - bx * tw)) * step;
          length = Math.min(count, ((rs.at(-1)[1] - by * th) * tw + (xs.at(-1) - bx * tw) + 1) * step) - base;
          if (length <= 0) continue;
        }
        const dv = new DataView(compression === 1 ? (await img.source.fetch([{ offset: offset + base, length }]))[0] : await decoder.decode((await img.source.fetch([{ offset, length: count }]))[0]));
        for (const [j, Y] of rowsOf.get(by)) {
          const r = Y - by * th;
          for (const i of cols) {
            const X = (x0 + i) * s + c;
            if (Math.floor(X / tw) !== bx) continue;
            const o = (r * tw + (X - bx * tw)) * step - base;
            if (o + step > dv.byteLength) continue;
            const re = fmt === 6 ? dv.getFloat32(o, le) : half === 16 ? dv.getInt16(o, le) : dv.getInt32(o, le);
            const im = fmt === 6 ? dv.getFloat32(o + 4, le) : half === 16 ? dv.getInt16(o + 2, le) : dv.getInt32(o + 4, le);
            for (let k = 0; k < sel.length; k++) out[k][j * w + i] = sel[k] === 0 ? re : im;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, todo.length) }, run));
    return out;
  }
  return { kind: 'geotiff', imageIndex: 0, width: W, height: H, bands: 2, sampleType: 'f32', nodata: NaN, readWindow, hasLevel: (L) => L >= 1, readLevel };
}
