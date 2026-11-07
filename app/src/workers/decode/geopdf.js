// GeoPDF raster pages (REQ-FMT-14): the Rust scanner (`gw_pdf_scan`) finds the page, its ISO
// 32000-2 geospatial viewport (or the older LGIDict), its image XObjects (also inside Form
// XObjects) and its content streams. Content streams are inflated here and their `cm … Do`
// placements read by `gw_pdf_placements`; images are decoded through their whole filter chain
// (ASCII85/hex, Flate with PNG/TIFF predictors, DCT through the browser), soft masks applied,
// composited with their full placement matrix and cropped to the viewport: a page up to 2048 px
// at native resolution at once; a larger one (US Topo) first at the pyramid level that fits
// 2048 px, its JPEGs decoded at that size, and its finer levels drawn tile by tile on demand
// (REQ-GAP-66 first tile). The viewport's LPTS ↔ GPTS pairs (or LGIDict points) become ground
// control at the crop's pixels. A georeferenced page without images opens with no raster; its
// vector layers come from the decode worker's `pdfVectors` (crates/gw-parse/src/pdfvec.rs).

import { memorySource } from './simple.js';
import { gwError } from '../../i18n/index.js';
import { wasmError } from '../errors.js';

/**
 * Inflate a zlib stream. PDF writers often leave bytes after the end of the stream, which
 * DecompressionStream reports as an error (surfacing in Chrome as "Failed to fetch"): keep what
 * was decoded and only fail when nothing came out.
 */
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } catch (e) {
    if (!n) throw gwError('PDF stream: the Flate data is corrupt ({msg})', { msg: String(e.message || e) });
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

function ascii85(b) {
  // Typed output (US Topo wraps every JPEG strip in ASCII85: 20+ MB per map).
  let out = new Uint8Array(Math.ceil((b.length * 4) / 5) + 8);
  let n = 0;
  let tuple = 0;
  let k = 0;
  let i = 0;
  if (b[0] === 0x3c && b[1] === 0x7e) i = 2; // <~
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x7e) break; // ~>
    if (c <= 0x20) continue;
    if (c === 0x7a && k === 0) {
      if (n + 4 > out.length) {
        const grown = new Uint8Array(out.length * 2 + 8); // 'z' (four zero bytes) is shorter than five characters
        grown.set(out);
        out = grown;
      }
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = 0;
      out[n++] = 0;
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new Error('PDF stream: invalid ASCII85 data');
    tuple = tuple * 85 + (c - 33);
    if (++k === 5) {
      if (n + 4 > out.length) {
        const grown = new Uint8Array(out.length * 2 + 8);
        grown.set(out);
        out = grown;
      }
      out[n++] = (tuple >>> 24) & 255;
      out[n++] = (tuple >>> 16) & 255;
      out[n++] = (tuple >>> 8) & 255;
      out[n++] = tuple & 255;
      tuple = 0;
      k = 0;
    }
  }
  if (k > 1) {
    for (let j = k; j < 5; j++) tuple = tuple * 85 + 84;
    if (n + 4 > out.length) {
      const grown = new Uint8Array(n + 8);
      grown.set(out.subarray(0, n));
      out = grown;
    }
    for (let j = 0; j < k - 1; j++) out[n++] = (tuple >>> (24 - 8 * j)) & 255;
  }
  return out.subarray(0, n);
}

function asciiHex(b) {
  const out = [];
  let hi = -1;
  for (const c of b) {
    if (c === 0x3e) break; // >
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else (out.push((hi << 4) | v), (hi = -1));
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

/** Undo a PNG (≥ 10) or TIFF (2) predictor on 8-bit samples. */
function unpredict(raw, dp) {
  const pred = dp?.predictor ?? 1;
  if (pred < 2) return raw;
  const colors = dp.colors ?? 1;
  const cols = dp.columns ?? 1;
  const bpp = Math.max(1, (colors * (dp.bpc ?? 8)) >> 3);
  const row = (colors * (dp.bpc ?? 8) * cols + 7) >> 3;
  if (pred === 2) {
    const out = raw.slice();
    for (let r = 0; r + row <= out.length; r += row) for (let i = bpp; i < row; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(raw.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const t = raw[r * (row + 1)];
    const src = r * (row + 1) + 1;
    const dst = r * row;
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r ? out[dst - row + i] : 0;
      const ul = r && i >= bpp ? out[dst - row + i - bpp] : 0;
      let v = raw[src + i];
      if (t === 1) v += a;
      else if (t === 2) v += up;
      else if (t === 3) v += (a + up) >> 1;
      else if (t === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** Run a stream through its filter chain → {raw} (decoded samples) or {jpeg} or {unsupported}. */
async function decodeChain(bytes, filters = [], dp) {
  let b = bytes;
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f === 'ASCII85Decode' || f === 'A85') b = ascii85(b);
    else if (f === 'ASCIIHexDecode' || f === 'AHx') b = asciiHex(b);
    else if (f === 'FlateDecode' || f === 'Fl') b = unpredict(await inflate(b), dp);
    else if (f === 'DCTDecode' || f === 'DCT') return { jpeg: b };
    else return { unsupported: f };
  }
  return { raw: b };
}

const components = (im) => im.components ?? (/RGB/.test(im.colorSpace) ? 3 : /Gray/.test(im.colorSpace) ? 1 : /CMYK/.test(im.colorSpace) ? 4 : 0);

/**
 * An image XObject → something drawImage takes (an ImageBitmap, or an OffscreenCanvas when the
 * samples are raw), the soft mask applied as alpha, or {skip: reason}. A JPEG without a mask is the
 * browser's bitmap as it is; a mask is composited on the GPU ('destination-in') rather than read
 * back and rewritten pixel by pixel.
 */
async function decodeImage(bytes, im, size = null) {
  const filters = im.filters ?? (im.filter ? im.filter.split(',') : []);
  const d = await decodeChain(bytes.subarray(im.offset, im.offset + im.length), filters, im.decodeParms);
  if (d.unsupported) return { skip: `${im.name} (${d.unsupported})` };
  // `size`: decode reduced ({w, h} below the image's own): the browser's JPEG decoder then scales
  // in the DCT, several times faster than a full decode (the preview level of openGeoPdf).
  const tw = size?.w ?? im.width;
  const th = size?.h ?? im.height;
  const rs = size ? { resizeWidth: tw, resizeHeight: th, resizeQuality: 'medium' } : undefined;
  let src;
  if (d.jpeg) src = await createImageBitmap(new Blob([d.jpeg], { type: 'image/jpeg' }), rs);
  else {
    const nc = components(im);
    if (!nc || nc === 4 || im.bpc !== 8 || d.raw.length < im.width * im.height * nc) return { skip: `${im.name} (${filters.join('+') || 'raw'}, ${im.colorSpace}${im.bpc !== 8 ? `, ${im.bpc}-bit` : ''})` };
    const id = new ImageData(im.width, im.height);
    const o = new Uint32Array(id.data.buffer);
    const r = d.raw;
    if (nc === 3) for (let i = 0, k = 0; i < o.length; i++, k += 3) o[i] = 0xff000000 | (r[k + 2] << 16) | (r[k + 1] << 8) | r[k];
    else for (let i = 0; i < o.length; i++) o[i] = 0xff000000 | (r[i] * 0x010101);
    src = await createImageBitmap(id, rs);
  }
  if (im.smask?.bpc !== 8) return { canvas: src };
  const m = await decodeChain(bytes.subarray(im.smask.offset, im.smask.offset + im.smask.length), im.smask.filters, im.smask.decodeParms);
  if (!(m.raw?.length >= im.smask.width * im.smask.height)) return { canvas: src };
  const mw = im.smask.width;
  const mh = im.smask.height;
  const md = new ImageData(mw, mh);
  const mo = new Uint32Array(md.data.buffer);
  for (let i = 0; i < mo.length; i++) mo[i] = m.raw[i] << 24;
  const mask = await createImageBitmap(md, rs);
  const c = new OffscreenCanvas(tw, th);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, tw, th);
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(mask, 0, 0, tw, th); // a mask of another size is scaled to the image grid
  src.close?.();
  mask.close();
  return { canvas: c };
}

/**
 * Draw images placed by `m` (image pixels → canvas) in two passes when `seams`: each first grown by
 * 0.75 canvas pixel on every side, then exact. Tiles of a map drawn reduced fall on fractional
 * pixels, and their antialiased edges let the white page show through as a grid of light lines;
 * the grown pass fills those seams and the exact pass keeps every image where it belongs.
 */
function drawPlaced(g, list, seams) {
  for (const pass of seams ? [0, 1] : [1])
    for (const { img, im, m } of list) {
      g.setTransform(...m);
      if (pass) g.drawImage(img, 0, 0, im.width, im.height);
      else {
        const ex = 0.75 / Math.max(1e-9, Math.hypot(m[0], m[1]));
        const ey = 0.75 / Math.max(1e-9, Math.hypot(m[2], m[3]));
        g.drawImage(img, -ex, -ey, im.width + 2 * ex, im.height + 2 * ey);
      }
    }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

// PDF matrices [a b c d e f] (row vectors): mul(m1, m2) applies m1 then m2.
const mul = (m1, m2) => [m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3], m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3], m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5]];

function placementsOf(parse, content) {
  if (!content.length) return [];
  const [p, n] = parse.put(content);
  try {
    if (parse.x.gw_pdf_placements(p, n) !== 0) throw wasmError(parse);
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
}

async function streamBytes(bytes, s) {
  const d = await decodeChain(bytes.subarray(s.offset, s.offset + s.length), s.filters, s.decodeParms);
  return d.raw ?? new Uint8Array(0);
}

/** Every image drawn on the page with its user-space matrix, following Form XObjects. */
async function pageDraws(bytes, page, parse) {
  const images = new Map(page.images.map((im) => [im.name, im]));
  const forms = new Map((page.forms ?? []).map((f) => [f.id, f]));
  const out = [];
  const walk = async (placed, scope, ctm, depth) => {
    for (const { name, matrix } of placed) {
      const id = scope ? `${scope}/${name}` : name;
      const m = mul(matrix, ctm);
      if (images.has(id)) out.push({ name: id, matrix: m });
      else if (forms.has(id) && depth < 8) {
        const f = forms.get(id);
        await walk(placementsOf(parse, await streamBytes(bytes, f)), id, mul(f.matrix, m), depth + 1);
      }
    }
  };
  if (page.contents?.length) {
    const parts = [];
    for (const c of page.contents) parts.push(await streamBytes(bytes, c), new Uint8Array([10]));
    const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) all.set(p, (o += p.length) - p.length);
    await walk(placementsOf(parse, all), '', [1, 0, 0, 1, 0, 0], 0);
  } else if (page.draws?.length) out.push(...page.draws);
  return out;
}

/** LGIDict (pre-ISO GeoPDF) → projected control points at PDF user-space positions. */
function lgiPoints(lgi) {
  if (lgi.registration?.length >= 3) return lgi.registration.filter((r) => r.length >= 4).map(([x, y, X, Y]) => ({ x, y, X, Y }));
  if (lgi.ctm?.length === 6) {
    const [a, b, c, d, e, f] = lgi.ctm;
    const nl = lgi.neatline?.length >= 8 ? lgi.neatline : null;
    const pts = nl ? Array.from({ length: nl.length >> 1 }, (_, i) => [nl[2 * i], nl[2 * i + 1]]) : null;
    return (pts ?? []).map(([x, y]) => ({ x, y, X: a * x + c * y + e, Y: b * x + d * y + f }));
  }
  return [];
}

/** → {meta {format, page, viewport, gcps, epsg, lgi}, source}. */
export async function openGeoPdf(file, parse) {
  const T = [performance.now()];
  const mark = () => T.push(performance.now());
  const bytes = new Uint8Array(await file.arrayBuffer());
  mark();
  const [p, n] = parse.put(bytes);
  let scan;
  try {
    if (parse.x.gw_pdf_scan(p, n) !== 0) throw wasmError(parse);
    scan = parse.outJson();
  } finally {
    parse.free(p, n);
  }
  mark();
  const page = scan.pages.find((x) => (x.viewports.length || x.lgi?.length) && x.images.length) ?? scan.pages.find((x) => x.images.length);
  if (!page) {
    // Vectors only (REQ-GAP-66): a georeferenced page opens as vector layers, no raster.
    const geo = scan.pages.find((x) => x.viewports.length || x.lgi?.length);
    if (geo) return { meta: { format: `GeoPDF (${scan.objects} objects; vector page)`, page: geo.object, vectorPage: true, width: 0, height: 0 }, source: null };
    throw gwError('the PDF has no page with a raster image or a geospatial viewport');
  }
  const [mx0, my0, mx1, my1] = page.mediaBox.length === 4 ? page.mediaBox : [0, 0, 612, 792];
  let draws = await pageDraws(bytes, page, parse);
  mark();
  if (!draws.length) draws = page.images.map((im) => ({ name: im.name, matrix: [mx1 - mx0, 0, 0, my1 - my0, mx0, my0] }));
  // Native resolution: the finest image pixels per point.
  let s = 1;
  for (const d of draws) {
    const im = page.images.find((x) => x.name === d.name);
    const scale = Math.hypot(d.matrix[0], d.matrix[1]);
    if (im && scale > 0) s = Math.max(s, im.width / scale);
  }
  // The map is the largest viewport (US Topo also carries small locator diagrams); BBox corners
  // may come in either order.
  const norm = (b) => [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])];
  const vps = page.viewports.filter((v) => v.bbox?.length === 4).map((v) => ({ ...v, bbox: norm(v.bbox), rawBBox: v.bbox }));
  const vp = vps.sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]))[0] ?? null;
  const lgi = !vp && page.lgi?.length ? page.lgi[0] : null;
  const lpts = lgi ? lgiPoints(lgi) : [];
  let crop = [mx0, my0, mx1, my1];
  if (vp?.bbox?.length === 4) crop = vp.bbox;
  else if (lpts.length >= 3) crop = [Math.min(...lpts.map((q) => q.x)), Math.min(...lpts.map((q) => q.y)), Math.max(...lpts.map((q) => q.x)), Math.max(...lpts.map((q) => q.y))];
  const [bx0, by0, bx1, by1] = crop;
  const area = (bx1 - bx0) * (by1 - by0) * s * s;
  if (area > 64e6) s = Math.sqrt(64e6 / ((bx1 - bx0) * (by1 - by0)));
  const W = Math.max(1, Math.round((bx1 - bx0) * s));
  const H = Math.max(1, Math.round((by1 - by0) * s));
  const byName = new Map(page.images.map((im) => [im.name, im]));
  const order = draws.filter((d) => byName.has(d.name));
  /**
   * The page at `sc` pixels per point into a cw x ch canvas -> {planes, drawn, skipped}. reduced:
   * each image decoded at the size it is drawn (JPEG scaled in the decoder).
   */
  async function composite(sc, cw, ch, reduced) {
    const c = new OffscreenCanvas(cw, ch);
    // The full page in the background on a CPU canvas: a GPU one read back (up to 64 MP) stalled
    // the display's own frames while the user roamed (60 → 42 fps measured on US Topo).
    const g = c.getContext('2d', { willReadFrequently: !reduced });
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    const skipped = [];
    let drawn = 0;
    // Each image's drawn size: the largest of its placements, never above its own.
    const sizes = new Map();
    if (reduced)
      for (const d of order) {
        const im = byName.get(d.name);
        const [a, b, cc, dd] = d.matrix;
        const w = Math.min(im.width, Math.max(1, Math.ceil(sc * Math.hypot(a, b))));
        const hh = Math.min(im.height, Math.max(1, Math.ceil(sc * Math.hypot(cc, dd))));
        const o = sizes.get(d.name);
        sizes.set(d.name, { w: Math.max(w, o?.w ?? 0), h: Math.max(hh, o?.h ?? 0) });
      }
    // Decode up to AHEAD images while drawing in page order (the browser decodes JPEG off the
    // worker thread); each image is decoded once however often it is drawn.
    const uses = new Map();
    for (const d of order) uses.set(d.name, (uses.get(d.name) ?? 0) + 1);
    const pending = new Map();
    const start = (k) => {
      const n = order[k]?.name;
      if (!n || pending.has(n)) return;
      const im = byName.get(n);
      const z = sizes.get(n);
      pending.set(n, decodeImage(bytes, im, z && (z.w < im.width || z.h < im.height) ? z : null));
    };
    const AHEAD = 8;
    const placed = [];
    for (let k = 0; k < AHEAD; k++) start(k);
    for (let k = 0; k < order.length; k++) {
      start(k + AHEAD);
      const d = order[k];
      const im = byName.get(d.name);
      const img = await pending.get(d.name);
      const left = uses.get(d.name) - 1;
      uses.set(d.name, left);
      if (!left) pending.delete(d.name);
      if (img.skip) {
        if (!left) skipped.push(img.skip);
        continue;
      }
      // Image space (u right, v down, w x h pixels) -> unit square -> user space (matrix) -> crop pixels.
      const [a, b, cc, dd, e, f] = d.matrix;
      const m = [(sc * a) / im.width, (-sc * b) / im.width, (-sc * cc) / im.height, (sc * dd) / im.height, sc * (cc + e - bx0), sc * (by1 - dd - f)];
      // Reduced: kept for the two passes (small); full size: drawn exactly and let go at once.
      if (reduced) placed.push({ img: img.canvas, im, m });
      else {
        drawPlaced(g, [{ img: img.canvas, im, m }], false);
        if (!left) img.canvas.close?.();
      }
      drawn++;
    }
    if (reduced) drawPlaced(g, placed, true);
    if (!drawn) throw gwError("the PDF's images could not be decoded: {why}", { why: skipped.slice(0, 3).join('; ') || 'none placed' });
    const px = new Uint32Array(g.getImageData(0, 0, cw, ch).data.buffer);
    const planes = [0, 1, 2].map(() => new Uint8Array(cw * ch));
    const [p0, p1, p2] = planes;
    for (let i = 0; i < px.length; i++) {
      const v = px[i];
      p0[i] = v & 255;
      p1[i] = (v >>> 8) & 255;
      p2[i] = (v >>> 16) & 255;
    }
    return { planes, drawn, skipped };
  }
  // First tile (REQ-GAP-66; 3.2-5.1 s on US Topo in 2.3): a large page is composited at the
  // pyramid level whose larger side is at most 2048 px, its images decoded at that size, and
  // opens from that. Finer levels are drawn tile by tile when they are asked for, from only the
  // images under the tile, decoded at that level's size (and kept, up to 256 MB): no full-page
  // composite (up to 64 MP) runs while the user roams.
  const LP = Math.max(0, Math.ceil(Math.log2(Math.max(W, H) / 2048)));
  let source;
  let first;
  if (!LP) {
    first = await composite(s, W, H, false);
    source = memorySource('pdf', W, H, 3, 'u8', null, first.planes);
  } else {
    const Wp = Math.ceil(W / 2 ** LP);
    const Hp = Math.ceil(H / 2 ** LP);
    first = await composite(s / 2 ** LP, Wp, Hp, true);
    const preview = memorySource('pdf', Wp, Hp, 3, 'u8', null, first.planes);
    // Decoded images per level: `${name}|${L}` → Promise of {canvas} (or {skip}), least recently used last.
    const decoded = new Map();
    let bytesHeld = 0;
    const decodedAt = (name, L, size) => {
      const k = `${name}|${L}`;
      let e = decoded.get(k);
      if (e) {
        decoded.delete(k);
        decoded.set(k, e);
        return e.p;
      }
      const im = byName.get(name);
      e = { p: decodeImage(bytes, im, size && (size.w < im.width || size.h < im.height) ? size : null), n: 4 * (size?.w ?? im.width) * (size?.h ?? im.height) };
      decoded.set(k, e);
      bytesHeld += e.n;
      for (const [key, old] of decoded) {
        if (bytesHeld <= 256 << 20 || key === k) break;
        decoded.delete(key);
        bytesHeld -= old.n;
      }
      return e.p;
    };
    const renderWindow = async (L, x0, y0, w, h, sel) => {
      const sc = s / 2 ** L;
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#fff';
      g.fillRect(0, 0, w, h);
      const list = [];
      for (const d of order) {
        const im = byName.get(d.name);
        const [a, b, cc, dd, e, f] = d.matrix;
        const m = [(sc * a) / im.width, (-sc * b) / im.width, (-sc * cc) / im.height, (sc * dd) / im.height, sc * (cc + e - bx0) - x0, sc * (by1 - dd - f) - y0];
        const xs = [0, im.width].flatMap((u) => [0, im.height].map((v) => m[0] * u + m[2] * v + m[4]));
        const ys = [0, im.width].flatMap((u) => [0, im.height].map((v) => m[1] * u + m[3] * v + m[5]));
        if (Math.max(...xs) <= 0 || Math.min(...xs) >= w || Math.max(...ys) <= 0 || Math.min(...ys) >= h) continue;
        const size = L ? { w: Math.min(im.width, Math.max(1, Math.ceil(sc * Math.hypot(a, b)))), h: Math.min(im.height, Math.max(1, Math.ceil(sc * Math.hypot(cc, dd)))) } : null;
        const img = await decodedAt(d.name, L, size);
        if (!img.skip) list.push({ img: img.canvas, im, m });
      }
      drawPlaced(g, list, true);
      const px = new Uint32Array(g.getImageData(0, 0, w, h).data.buffer);
      return sel.map((band) => {
        const out = new Uint8Array(w * h);
        const sh = 8 * band;
        for (let i = 0; i < px.length; i++) out[i] = (px[i] >>> sh) & 255;
        return out;
      });
    };
    source = {
      kind: 'pdf',
      width: W,
      height: H,
      bands: 3,
      sampleType: 'u8',
      nodata: null,
      readWindow: (x0, y0, w, h, sel) => renderWindow(0, x0, y0, w, h, sel),
      hasLevel: (L) => L >= 1 && L <= LP,
      readLevel: (L, x0, y0, w, h, sel) => (L === LP ? preview.readWindow(x0, y0, w, h, sel) : renderWindow(L, x0, y0, w, h, sel)),
    };
  }
  const { drawn, skipped } = first;
  mark();
  let gcps = null;
  if (vp && vp.gpts.length >= 8 && vp.lpts.length >= 8) {
    gcps = [];
    // LPTS are relative to the BBox as written: US Topo 2022 writes it top first ([0 2088 1728 49]),
    // so v = 1 is the bottom of the page (2.3 drew that map upside down; GDAL reads it so).
    const [rx0, ry0, rx1, ry1] = vp.rawBBox;
    for (let k = 0; k + 1 < vp.lpts.length && k + 1 < vp.gpts.length; k += 2) {
      const [lx, ly] = [vp.lpts[k], vp.lpts[k + 1]];
      const [lat, lon] = [vp.gpts[k], vp.gpts[k + 1]];
      if (!Number.isFinite(lat)) break;
      const px = rx0 + lx * (rx1 - rx0);
      const py = ry0 + ly * (ry1 - ry0);
      gcps.push({ x: ((px - bx0) / (bx1 - bx0)) * W, y: ((by1 - py) / (by1 - by0)) * H, lat, lon });
    }
  }
  // LGIDict control points stay projected; the main thread converts them through the CRS.
  const lgiGcps = lpts.map((q) => ({ x: (q.x - bx0) * s, y: (by1 - q.y) * s, X: q.X, Y: q.Y }));
  return {
    meta: {
      format: `GeoPDF (${scan.objects} objects; ${vp ? 'ISO 32000 /GEO viewport' : lgi ? 'LGIDict' : 'no georeferencing'}; ${drawn} image${drawn === 1 ? '' : 's'})`,
      timing: T.slice(1).map((t, i) => Math.round(t - T[i])), // read, scan, placements, first composite (ms)
      previewLevel: LP,
      width: W, height: H, page: page.object, viewport: vp && { ...vp, rawBBox: undefined }, gcps, epsg: vp?.epsg ?? null, wkt: vp?.wkt ?? null, skipped,
      lgi: lgi ? { projection: lgi.projection, gcps: lgiGcps } : null,
    },
    source,
  };
}
