// Standalone JPEG 2000 (TE-003, REQ-FMT-02): JP2/JPX files (e.g. Sentinel-2 L1C bands) and raw
// J2K codestreams. The box structure gives size, components and georeferencing — the GeoJP2
// UUID box (a degenerate GeoTIFF) or GMLJP2 (gml:RectifiedGrid in an asoc/xml box). Pixels come
// from the `j2k` bundle as one decode, at full resolution up to 400 M samples or at the coarsest
// reduced resolution that fits.

import { fromArrayBuffer } from 'geotiff';

const GEOJP2_UUID = 'b14bf8bd083d4b43a5ae8cd7d5a6ce03';
const MAX_SAMPLES = 400e6;

async function readRange(file, off, len) {
  return new Uint8Array(await file.slice(off, off + len).arrayBuffer());
}

/** Top-level (and jp2h/asoc nested) boxes: [{type, off, len, data?}] with small boxes read. */
async function boxes(file) {
  const out = [];
  let off = 0;
  for (let guard = 0; off + 8 <= file.size && guard < 10000; guard++) {
    const h = await readRange(file, off, 16);
    const dv = new DataView(h.buffer);
    let len = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    let hdr = 8;
    if (len === 1) {
      len = Number(dv.getBigUint64(8));
      hdr = 16;
    } else if (len === 0) len = file.size - off;
    if (len < hdr || off + len > file.size) throw new Error(`JPEG 2000: box ${type} at ${off} runs past the end of the file`);
    const b = { type, off: off + hdr, len: len - hdr };
    if (type !== 'jp2c' && b.len < 32 << 20) b.data = await readRange(file, b.off, b.len);
    out.push(b);
    off += len;
  }
  return out;
}

function subBoxes(data) {
  const out = [];
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let o = 0; o + 8 <= data.length; ) {
    let len = dv.getUint32(o);
    const type = String.fromCharCode(data[o + 4], data[o + 5], data[o + 6], data[o + 7]);
    if (len === 0) len = data.length - o;
    if (len < 8 || o + len > data.length) break;
    out.push({ type, data: data.subarray(o + 8, o + len) });
    o += len;
  }
  return out;
}

/** GMLJP2: origin, offset vectors and srsName of the first gml:RectifiedGrid. */
function gmlGeoref(xml) {
  const srs = /srsName="([^"]+)"/.exec(xml)?.[1] ?? '';
  const epsg = Number(/EPSG(?:::|:|\/0\/|\/)(\d+)/.exec(srs)?.[1]) || null;
  const pos = /<gml:origin>[\s\S]*?<gml:pos[^>]*>([^<]+)<\/gml:pos>/.exec(xml)?.[1] ?? /<gml:origin>[\s\S]*?<gml:coordinates[^>]*>([^<]+)</.exec(xml)?.[1];
  const offs = [...xml.matchAll(/<gml:offsetVector[^>]*>([^<]+)<\/gml:offsetVector>/g)].map((m) => m[1].trim().split(/[\s,]+/).map(Number));
  if (!pos || offs.length < 2) return null;
  let [ox, oy] = pos.trim().split(/[\s,]+/).map(Number);
  let [[ax, ay], [bx, by]] = offs;
  // EPSG geographic CRSs in GML are latitude-first.
  if (epsg && (epsg === 4326 || epsg === 4258 || epsg === 4269)) [ox, oy, ax, ay, bx, by] = [oy, ox, ay, ax, by, bx];
  // gml:origin is the centre of the first pixel; a geotransform uses its corner.
  return { epsg, gt: [ox - (ax + bx) / 2, ax, bx, oy - (ay + by) / 2, ay, by], source: 'GMLJP2' };
}

/** GeoJP2: the UUID box carries a 1×1 GeoTIFF whose tie point / pixel scale or transform apply. */
async function geojp2(data) {
  const tiff = await fromArrayBuffer(data.slice().buffer);
  const img = await tiff.getImage(0);
  const fd = img.fileDirectory;
  const val = async (k) => (typeof fd.loadValue === 'function' ? (fd.hasTag(k) ? await fd.loadValue(k) : undefined) : fd[k]);
  const keys = img.getGeoKeys?.() ?? {};
  const epsg = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey ?? null;
  const tp = await val('ModelTiepoint');
  const ps = await val('ModelPixelScale');
  const mt = await val('ModelTransformation');
  let gt = null;
  if (mt?.length >= 16) gt = [mt[3], mt[0], mt[1], mt[7], mt[4], mt[5]];
  else if (tp?.length >= 6 && ps?.length >= 2) gt = [tp[3] - tp[0] * ps[0], ps[0], 0, tp[4] + tp[1] * ps[1], 0, -ps[1]];
  // PixelIsPoint shifts by half a pixel.
  if (gt && keys.GTRasterTypeGeoKey === 2) (gt[0] -= gt[1] / 2), (gt[3] -= gt[5] / 2);
  return gt ? { epsg: epsg && epsg !== 32767 ? epsg : null, gt, source: 'GeoJP2' } : null;
}

/** SIZ and COD of a J2K codestream: size, components, depth, decomposition levels. */
function codestreamHeader(cs) {
  const dv = new DataView(cs.buffer, cs.byteOffset, cs.byteLength);
  if (dv.getUint16(0) !== 0xff4f) throw new Error('JPEG 2000: the codestream does not start with SOC');
  let o = 2;
  const out = { width: 0, height: 0, comps: 1, bpc: 8, levels: 5 };
  for (let guard = 0; o + 4 <= cs.length && guard < 64; guard++) {
    const m = dv.getUint16(o);
    const len = dv.getUint16(o + 2);
    if (m === 0xff51) {
      const xs = dv.getUint32(o + 6);
      const ys = dv.getUint32(o + 10);
      const xo = dv.getUint32(o + 14);
      const yo = dv.getUint32(o + 18);
      out.width = xs - xo;
      out.height = ys - yo;
      out.comps = dv.getUint16(o + 38);
      out.bpc = (cs[o + 40] & 0x7f) + 1;
    } else if (m === 0xff52) out.levels = cs[o + 9];
    else if (m === 0xff90 || m === 0xff93) break; // first tile-part: the main header is done
    o += 2 + len;
  }
  if (!out.width || !out.height) throw new Error('JPEG 2000: no SIZ marker in the main header');
  return out;
}

/** → {meta, source} for a .jp2/.jpx/.j2k/.j2c file. */
export async function openJp2(file, j2k, kind) {
  let width;
  let height;
  let comps;
  let bpc = 8;
  let georef = null;
  let top = null;
  if (kind === 'jp2') {
    top = await boxes(file);
    const jp2h = top.find((b) => b.type === 'jp2h');
    const ihdr = jp2h && subBoxes(jp2h.data).find((b) => b.type === 'ihdr');
    if (!ihdr) throw new Error('JPEG 2000: no image header (jp2h/ihdr) box');
    const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
    height = dv.getUint32(0);
    width = dv.getUint32(4);
    comps = dv.getUint16(8);
    if (ihdr.data[10] !== 255) bpc = (ihdr.data[10] & 0x7f) + 1; // signed samples come back unsigned
    for (const b of top) {
      if (b.type === 'uuid' && b.data?.length > 16 && [...b.data.subarray(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('') === GEOJP2_UUID && !georef) georef = await geojp2(b.data.subarray(16)).catch(() => null);
      if (b.type === 'asoc' && b.data) {
        const xml = new TextDecoder().decode(b.data);
        if (/RectifiedGrid/.test(xml)) georef = gmlGeoref(xml) ?? georef;
      }
    }
    if (!top.some((b) => b.type === 'jp2c')) throw new Error('JPEG 2000: no codestream (jp2c) box');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Codestream header: SIZ (size, components, depth) and COD (decomposition levels).
  const csStart = top ? top.find((b) => b.type === 'jp2c').off : 0;
  const cs = bytes.subarray(csStart, csStart + Math.min(bytes.length - csStart, 1 << 16));
  const hdr = codestreamHeader(cs);
  width ??= hdr.width;
  height ??= hdr.height;
  comps ??= hdr.comps;
  if (kind !== 'jp2') bpc = hdr.bpc;
  const levels = hdr.levels;
  // TE-campaign IMP-01: decode lazily. Coarse pyramid levels come from the codestream's own
  // reduced resolutions (one cheap decode per level), the full resolution only when it is shown —
  // a 10980² Sentinel-2 band no longer decodes 120 M samples before its first tile.
  const st = bpc <= 8 ? 'u8' : 'u16';
  const cache = new Map(); // level → Promise<{w, h, planes}>
  const decodeAt = (L) => {
    if (cache.has(L)) return cache.get(L);
    const p = (async () => {
      const tw = L ? Math.max(1, Math.floor(width / 2 ** L)) : 0;
      const th = L ? Math.max(1, Math.floor(height / 2 ** L)) : 0;
      if (!L && width * height * comps > MAX_SAMPLES) throw new Error(`JPEG 2000 ${width}×${height}×${comps} is above the 400 M-sample full-resolution limit; zoom out`);
      const [p0, n0] = j2k.put(bytes);
      let out;
      try {
        if (j2k.x.gw_j2k_decode(p0, n0, tw, th) !== 0) throw new Error(`JPEG 2000: ${j2k.lastError()}`);
        out = j2k.outBytes();
      } finally {
        j2k.free(p0, n0);
      }
      const dv = new DataView(out.buffer, out.byteOffset, 16);
      const [w, h, nc, bits] = [0, 4, 8, 12].map((o) => dv.getUint32(o, true));
      const N = w * h;
      const planes = [];
      for (let c = 0; c < nc; c++) planes.push(bits <= 8 ? out.slice(16 + c * N, 16 + (c + 1) * N) : new Uint16Array(out.buffer.slice(out.byteOffset + 16 + c * N * 2, out.byteOffset + 16 + (c + 1) * N * 2)));
      return { w, h, planes };
    })();
    // Keep the full resolution and at most two reduced levels.
    cache.set(L, p);
    const reduced = [...cache.keys()].filter((k) => k > 0);
    if (reduced.length > 2) cache.delete(reduced.find((k) => k !== L));
    p.catch(() => cache.delete(L));
    return p;
  };
  const C = st === 'u8' ? Uint8Array : Uint16Array;
  const crop = (r, x0, y0, w, h, sel) =>
    sel.map((b) => {
      const src = r.planes[Math.min(b, r.planes.length - 1)];
      const out = new C(w * h);
      for (let y = 0; y < h && y0 + y < r.h; y++) {
        const ww = Math.max(0, Math.min(w, r.w - x0));
        if (ww) out.set(src.subarray((y0 + y) * r.w + x0, (y0 + y) * r.w + x0 + ww), y * w);
      }
      return out;
    });
  const source = {
    kind: 'jp2',
    width,
    height,
    bands: comps,
    sampleType: st,
    nodata: null,
    readWindow: async (x0, y0, w, h, sel) => crop(await decodeAt(0), x0, y0, w, h, sel),
    hasLevel: (L) => L >= 1 && L <= levels,
    readLevel: async (L, x0, y0, w, h, sel) => crop(await decodeAt(L), x0, y0, w, h, sel),
  };
  const scale = 1;
  const w = width;
  const h = height;
  const nc = comps;
  return {
    meta: {
      format: `JPEG 2000 (${kind === 'jp2' ? 'JP2' : 'codestream'}${georef ? `, ${georef.source}` : ''}; ${width}×${height}×${comps}, ${bpc}-bit, ${levels} resolution levels)`,
      width: w, height: h, fullWidth: width ?? w, fullHeight: height ?? h, bits: bpc, epsg: georef?.epsg ?? null, geotransform: georef?.gt ?? null, reduced: scale,
    },
    source,
  };
}
