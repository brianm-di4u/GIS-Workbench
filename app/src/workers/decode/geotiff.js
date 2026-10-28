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
import { ZSTDDecoder } from 'zstddec';

// TE-002: zstddec (geotiff.js's ZSTD and LERC+ZSTD decoder) loads its WebAssembly with
// fetch('data:application/wasm;base64,…'), which the strict CSP (connect-src blob:) refuses, so
// every ZSTD-compressed GeoTIFF failed with "Failed to fetch". Serve exactly that request from
// the inlined bytes instead; it is still instantiated under 'wasm-unsafe-eval' and nothing else
// about fetch changes.
const WASM_DATA = 'data:application/wasm;base64,';
if (typeof self !== 'undefined' && self.fetch && !self.fetch.__gwInlineWasm) {
  const fetch0 = self.fetch.bind(self);
  const inline = (u, ...rest) => {
    if (typeof u === 'string' && u.startsWith(WASM_DATA)) {
      const bin = atob(u.slice(WASM_DATA.length));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }));
    }
    return fetch0(u, ...rest);
  };
  inline.__gwInlineWasm = true;
  self.fetch = inline;
}

// TE-023: with ZSTD working (TE-002), a corrupt ZSTD block made geotiff.js's decoder fall back to
// unbounded streaming decompression and hang. Decode each block with its exact expected size
// instead (tile width × height × bytes per pixel) and reject anything that does not fill it.
const zstd = new ZSTDDecoder();
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
addDecoder(50000, () => zstd.init().then(() => BoundedZstdDecoder));

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
  })();
  return jpegReady;
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
  const tiff = file.remote ? await fromCustomClient(remoteClient(file), { blockSize: 65536, cacheSize: 400 }) : await fromBlob(file);
  const count = await tiff.getImageCount();
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
  for (const k of ['PhotometricInterpretation', 'Compression', 'TileWidth', 'TileLength', 'ModelTransformation', 'ImageDescription', 'DateTime', 'Software']) T[k] = await tag(fd, k);
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
    else geotransform = [origin[0], res[0], 0, origin[1], 0, res[1]];
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
  };

  if (complex) return { meta, source: await complexSource(tiff, main, complex) };

  // TE-018 / IMP-02: a striped (untiled) image decodes whole-width strips; reading it tile by tile
  // decoded every strip once per tile column (≈ 70× for a 35 k-pixel-wide WorldView strip). Read
  // whole-width row bands once and cut tiles from them (LRU, ~256 MB).
  const striped = !(await tag(main.fileDirectory, 'TileWidth')) && W > 2048;
  const BAND_ROWS = 512;
  const bandCache = new Map();
  let bandBytes = 0;
  async function rowBand(img, b0, sel) {
    const key = `${b0}/${sel.join(',')}`;
    if (bandCache.has(key)) {
      const v = bandCache.get(key);
      bandCache.delete(key);
      bandCache.set(key, v); // most recent last
      return v;
    }
    const y1 = Math.min(img.getHeight(), b0 + BAND_ROWS);
    const p = img.readRasters({ window: [0, b0, img.getWidth(), y1], samples: sel, interleave: false, fillValue: Number.isFinite(nodata) ? nodata : 0 }).then((r) => r.map((a) => convert(a, type)));
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
  let stripTable = null;
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
      hasLevel: (L) => overviews.some((o) => Math.abs(o.scale - 2 ** L) / 2 ** L < 0.02) || (rawStrided && L >= 1),
      async readLevel(L, x0, y0, w, h, b) {
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
  if (!((fmt === 5 && (half === 16 || half === 32)) || (fmt === 6 && half === 32))) throw new Error(`complex TIFF samples of ${bps} bits (SampleFormat ${fmt}) are not read; CInt16, CInt32 and CFloat32 are`);
  const fd = img.fileDirectory;
  if (((await tag(fd, 'Predictor')) ?? 1) !== 1) throw new Error('a complex TIFF with a predictor is not read');
  const W = img.getWidth();
  const H = img.getHeight();
  const tw = img.getTileWidth();
  const th = img.getTileHeight();
  const perRow = Math.ceil(W / tw);
  const tiled = img.isTiled;
  const decoder = await getDecoder((await tag(fd, 'Compression')) ?? 1, { tileWidth: tw, tileHeight: th, planarConfiguration: 1, bitsPerSample: bps, predictor: 1 });
  const le = tiff.littleEndian;
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
      const offset = Number(await fd.loadValueIndexed(tiled ? 'TileOffsets' : 'StripOffsets', key));
      const count = Number(await fd.loadValueIndexed(tiled ? 'TileByteCounts' : 'StripByteCounts', key));
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
  return { kind: 'geotiff', imageIndex: 0, width: W, height: H, bands: 2, sampleType: 'f32', nodata: NaN, readWindow, hasLevel: () => false };
}
