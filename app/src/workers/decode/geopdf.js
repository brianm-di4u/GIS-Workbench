// GeoPDF raster pages (REQ-FMT-14): the Rust scanner (`gw_pdf_scan`) finds the page, its ISO
// 32000-2 geospatial viewport (or the older LGIDict), its image XObjects (also inside Form
// XObjects) and its content streams. Content streams are inflated here and their `cm … Do`
// placements read by `gw_pdf_placements`; images are decoded through their whole filter chain
// (ASCII85/hex, Flate with PNG/TIFF predictors, DCT through the browser), soft masks applied,
// composited at native resolution with their full placement matrix and cropped to the viewport.
// The viewport's LPTS ↔ GPTS pairs (or LGIDict points) become ground control at the crop's pixels.

import { memorySource } from './simple.js';

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
    if (!n) throw new Error(`PDF stream: the Flate data is corrupt (${e.message || e})`);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
}

function ascii85(b) {
  const out = [];
  let tuple = 0;
  let k = 0;
  let i = 0;
  if (b[0] === 0x3c && b[1] === 0x7e) i = 2; // <~
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 0x7e) break; // ~>
    if (c <= 0x20) continue;
    if (c === 0x7a && k === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new Error('PDF stream: invalid ASCII85 data');
    tuple = tuple * 85 + (c - 33);
    if (++k === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      k = 0;
    }
  }
  if (k > 1) {
    for (let j = k; j < 5; j++) tuple = tuple * 85 + 84;
    for (let j = 0; j < k - 1; j++) out.push((tuple >>> (24 - 8 * j)) & 255);
  }
  return Uint8Array.from(out);
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

/** An image XObject → an OffscreenCanvas of its pixels (soft mask as alpha), or {skip: reason}. */
async function decodeImage(bytes, im) {
  const filters = im.filters ?? (im.filter ? im.filter.split(',') : []);
  const d = await decodeChain(bytes.subarray(im.offset, im.offset + im.length), filters, im.decodeParms);
  if (d.unsupported) return { skip: `${im.name} (${d.unsupported})` };
  const c = new OffscreenCanvas(im.width, im.height);
  const g = c.getContext('2d', { willReadFrequently: !!im.smask });
  if (d.jpeg) {
    const bmp = await createImageBitmap(new Blob([d.jpeg], { type: 'image/jpeg' }));
    g.drawImage(bmp, 0, 0, im.width, im.height);
    bmp.close?.();
  } else {
    const nc = components(im);
    if (!nc || nc === 4 || im.bpc !== 8 || d.raw.length < im.width * im.height * nc) return { skip: `${im.name} (${filters.join('+') || 'raw'}, ${im.colorSpace}${im.bpc !== 8 ? `, ${im.bpc}-bit` : ''})` };
    const id = new ImageData(im.width, im.height);
    for (let i = 0; i < im.width * im.height; i++) {
      id.data[4 * i] = d.raw[nc * i];
      id.data[4 * i + 1] = d.raw[nc * i + (nc === 3 ? 1 : 0)];
      id.data[4 * i + 2] = d.raw[nc * i + (nc === 3 ? 2 : 0)];
      id.data[4 * i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
  }
  if (im.smask?.bpc === 8) {
    const m = await decodeChain(bytes.subarray(im.smask.offset, im.smask.offset + im.smask.length), im.smask.filters, im.smask.decodeParms);
    if (m.raw?.length >= im.smask.width * im.smask.height) {
      let alpha = m.raw;
      if (im.smask.width !== im.width || im.smask.height !== im.height) {
        // Resample the mask to the image grid (nearest).
        alpha = new Uint8Array(im.width * im.height);
        for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) alpha[y * im.width + x] = m.raw[Math.floor((y * im.smask.height) / im.height) * im.smask.width + Math.floor((x * im.smask.width) / im.width)];
      }
      const px = g.getImageData(0, 0, im.width, im.height);
      for (let i = 0; i < im.width * im.height; i++) px.data[4 * i + 3] = alpha[i];
      g.putImageData(px, 0, 0);
    }
  }
  return { canvas: c };
}

// PDF matrices [a b c d e f] (row vectors): mul(m1, m2) applies m1 then m2.
const mul = (m1, m2) => [m1[0] * m2[0] + m1[1] * m2[2], m1[0] * m2[1] + m1[1] * m2[3], m1[2] * m2[0] + m1[3] * m2[2], m1[2] * m2[1] + m1[3] * m2[3], m1[4] * m2[0] + m1[5] * m2[2] + m2[4], m1[4] * m2[1] + m1[5] * m2[3] + m2[5]];

function placementsOf(parse, content) {
  if (!content.length) return [];
  const [p, n] = parse.put(content);
  try {
    if (parse.x.gw_pdf_placements(p, n) !== 0) throw new Error(parse.lastError());
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  const [p, n] = parse.put(bytes);
  let scan;
  try {
    if (parse.x.gw_pdf_scan(p, n) !== 0) throw new Error(parse.lastError());
    scan = parse.outJson();
  } finally {
    parse.free(p, n);
  }
  const page = scan.pages.find((x) => (x.viewports.length || x.lgi?.length) && x.images.length) ?? scan.pages.find((x) => x.images.length);
  if (!page) throw new Error('the PDF has no page with a raster image');
  const [mx0, my0, mx1, my1] = page.mediaBox.length === 4 ? page.mediaBox : [0, 0, 612, 792];
  let draws = await pageDraws(bytes, page, parse);
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
  const vps = page.viewports.filter((v) => v.bbox?.length === 4).map((v) => ({ ...v, bbox: norm(v.bbox) }));
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
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  const skipped = [];
  let drawn = 0;
  for (const d of draws) {
    const im = page.images.find((x) => x.name === d.name);
    if (!im) continue;
    const img = await decodeImage(bytes, im);
    if (img.skip) {
      skipped.push(img.skip);
      continue;
    }
    // Image space (u right, v down, w × h pixels) → unit square → user space (matrix) → crop pixels.
    const [a, b, cc, dd, e, f] = d.matrix;
    g.setTransform((s * a) / im.width, (-s * b) / im.width, (-s * cc) / im.height, (s * dd) / im.height, s * (cc + e - bx0), s * (by1 - dd - f));
    g.drawImage(img.canvas, 0, 0);
    drawn++;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (!drawn) throw new Error(`the PDF's images could not be decoded: ${skipped.slice(0, 3).join('; ') || 'none placed'}`);
  const px = g.getImageData(0, 0, W, H).data;
  const planes = [0, 1, 2].map(() => new Uint8Array(W * H));
  for (let i = 0; i < W * H; i++) for (let bnd = 0; bnd < 3; bnd++) planes[bnd][i] = px[4 * i + bnd];
  let gcps = null;
  if (vp && vp.gpts.length >= 8 && vp.lpts.length >= 8) {
    gcps = [];
    for (let k = 0; k + 1 < vp.lpts.length && k + 1 < vp.gpts.length; k += 2) {
      const [lx, ly] = [vp.lpts[k], vp.lpts[k + 1]];
      const [lat, lon] = [vp.gpts[k], vp.gpts[k + 1]];
      if (!Number.isFinite(lat)) break;
      gcps.push({ x: lx * W, y: (1 - ly) * H, lat, lon });
    }
  }
  // LGIDict control points stay projected; the main thread converts them through the CRS.
  const lgiGcps = lpts.map((q) => ({ x: (q.x - bx0) * s, y: (by1 - q.y) * s, X: q.X, Y: q.Y }));
  return {
    meta: {
      format: `GeoPDF (${scan.objects} objects; ${vp ? 'ISO 32000 /GEO viewport' : lgi ? 'LGIDict' : 'no georeferencing'}; ${drawn} image${drawn === 1 ? '' : 's'})`,
      width: W, height: H, page: page.object, viewport: vp, gcps, epsg: vp?.epsg ?? null, wkt: vp?.wkt ?? null, skipped,
      lgi: lgi ? { projection: lgi.projection, gcps: lgiGcps } : null,
    },
    source: memorySource('pdf', W, H, 3, 'u8', null, planes),
  };
}
