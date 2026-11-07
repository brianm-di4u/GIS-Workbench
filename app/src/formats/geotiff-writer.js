// GeoTIFF / COG-style writer (REQ-FMT-05, REQ-PRD-10): tiled, Deflate through
// CompressionStream, horizontal (2) or floating-point (3) predictor, reduced-resolution
// overviews, GeoKeys for an EPSG code, either a geotransform (pixel scale + tie point) or
// ground control points, GDAL_NODATA and the RPC tag 50844. Little-endian classic TIFF.

export const TYPE = { BYTE: 1, ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 };
export const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 12: 8 };
export const BPS = { u8: 8, u16: 16, i16: 16, f32: 32 };
export const FMT = { u8: 1, u16: 1, i16: 2, f32: 3 };
export const ARR = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array };

export async function deflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Bytes of one tile (chunky samples), padded with the fill value. */
function tileBytes(img, tx, ty, tw, th, fill) {
  const { width: W, height: H, bands: n, type } = img;
  const t = new ARR[type](tw * th * n);
  if (fill !== 0) t.fill(fill);
  for (let y = 0; y < th; y++) {
    const sy = ty * th + y;
    if (sy >= H) break;
    for (let x = 0; x < tw; x++) {
      const sx = tx * tw + x;
      if (sx >= W) break;
      for (let b = 0; b < n; b++) t[(y * tw + x) * n + b] = img.data[(sy * W + sx) * n + b];
    }
  }
  return new Uint8Array(t.buffer);
}

/** Predictor 2 (integer horizontal differencing) on a tile, in place. */
export function predict2(bytes, type, tw, th, n) {
  const a = new ARR[type](bytes.buffer, bytes.byteOffset, tw * th * n);
  for (let y = 0; y < th; y++) for (let x = tw - 1; x > 0; x--) for (let b = 0; b < n; b++) a[(y * tw + x) * n + b] -= a[(y * tw + x - 1) * n + b];
}

/** Predictor 3 (floating point, TIFF Technical Note 3): byte planes MSB first, then byte differences. */
export function predict3(bytes, tw, th, n) {
  const row = tw * n * 4;
  const out = new Uint8Array(bytes.length);
  const N = tw * n;
  for (let y = 0; y < th; y++) {
    const src = bytes.subarray(y * row, (y + 1) * row);
    const dst = out.subarray(y * row, (y + 1) * row);
    for (let i = 0; i < N; i++) for (let k = 0; k < 4; k++) dst[k * N + i] = src[i * 4 + (3 - k)]; // little-endian source
    for (let j = row - 1; j >= n; j--) dst[j] = (dst[j] - dst[j - n]) & 0xff;
  }
  return out;
}

/** 2×2 box (or nearest for 'nearest') reduction of an image {width, height, bands, type, data}. */
export function halve(img, mode = 'mean', nodata = null) {
  const W = Math.ceil(img.width / 2);
  const H = Math.ceil(img.height / 2);
  const n = img.bands;
  const out = new ARR[img.type](W * H * n);
  const round = img.type !== 'f32';
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let b = 0; b < n; b++) {
        if (mode === 'nearest') {
          out[(y * W + x) * n + b] = img.data[(2 * y * img.width + 2 * x) * n + b];
          continue;
        }
        let s = 0;
        let c = 0;
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(img.width - 1, 2 * x + dx);
            const sy = Math.min(img.height - 1, 2 * y + dy);
            const v = img.data[(sy * img.width + sx) * n + b];
            if (nodata !== null && v === nodata) continue;
            if (Number.isNaN(v)) continue;
            s += v;
            c++;
          }
        out[(y * W + x) * n + b] = c ? (round ? Math.round(s / c) : s / c) : nodata ?? NaN;
      }
  return { ...img, width: W, height: H, data: out };
}

export function geoKeys({ epsg, vertical = null }) {
  const keys = [];
  const geographic = epsg === 4326 || epsg === 4979 || (epsg >= 4000 && epsg < 5000);
  keys.push([1024, 0, 1, geographic ? 2 : 1]); // GTModelTypeGeoKey
  keys.push([1025, 0, 1, 1]); // GTRasterTypeGeoKey: PixelIsArea
  keys.push(geographic ? [2048, 0, 1, epsg] : [3072, 0, 1, epsg]);
  if (geographic) keys.push([2054, 0, 1, 9102]); // angular unit: degree
  else keys.push([3076, 0, 1, 9001]); // linear unit: metre
  // VerticalCSTypeGeoKey (GeoTIFF 1.1): 5030 WGS 84 ellipsoid (HAE), 5773 EGM96, 3855 EGM2008; metres.
  const vcs = { hae: 5030, egm96: 5773, egm2008: 3855 }[vertical];
  if (vcs) keys.push([4096, 0, 1, vcs], [4099, 0, 1, 9001]);
  keys.sort((a, b) => a[0] - b[0]);
  return [1, 1, 1, keys.length, ...keys.flat()]; // GeoTIFF 1.1 (KeyDirectoryVersion 1, revision 1.1)
}

/**
 * Encode a GeoTIFF. img = {width, height, bands, type: 'u8'|'u16'|'i16'|'f32', data (chunky)}.
 * opts: tile (256), compress ('deflate'|'none'), predictor (auto), overviews (true),
 * epsg, geotransform [x0, dx, 0, y0, 0, dy] or gcps [{x, y, lon, lat, h}], nodata, rpc (92
 * doubles), photometric ('minisblack'|'rgb'), description, software, vertical ('hae'|'egm96'|'egm2008').
 */
export async function writeGeoTiff(img, opts = {}) {
  const tile = opts.tile ?? 256;
  const compress = opts.compress ?? 'deflate';
  const type = img.type;
  const predictor = compress === 'none' ? 1 : opts.predictor ?? (type === 'f32' ? 3 : 2);
  const levels = [img];
  if (opts.overviews !== false) while (levels.at(-1).width > tile || levels.at(-1).height > tile) levels.push(halve(levels.at(-1), opts.overviewMode ?? 'mean', opts.nodata ?? null));
  const fill = opts.nodata ?? 0;
  // Compress every tile of every level first (sizes are needed for the layout).
  const encoded = [];
  for (const lv of levels) {
    const nx = Math.ceil(lv.width / tile);
    const ny = Math.ceil(lv.height / tile);
    const tiles = [];
    for (let ty = 0; ty < ny; ty++)
      for (let tx = 0; tx < nx; tx++) {
        let b = tileBytes(lv, tx, ty, tile, tile, fill);
        if (predictor === 2) predict2(b, type, tile, tile, img.bands);
        else if (predictor === 3) b = predict3(b, tile, tile, img.bands);
        tiles.push(compress === 'deflate' ? deflate(b) : Promise.resolve(b));
      }
    encoded.push(await Promise.all(tiles));
  }
  const ascii = (s) => new TextEncoder().encode(`${s}\0`);
  const ifds = levels.map((lv, k) => {
    const tags = [
      ...(k ? [[254, TYPE.LONG, [1]]] : []),
      [256, TYPE.LONG, [lv.width]],
      [257, TYPE.LONG, [lv.height]],
      [258, TYPE.SHORT, Array(img.bands).fill(BPS[type])],
      [259, TYPE.SHORT, [compress === 'deflate' ? 8 : 1]],
      [262, TYPE.SHORT, [opts.photometric === 'rgb' ? 2 : 1]],
      ...(k === 0 && opts.description ? [[270, TYPE.ASCII, ascii(opts.description)]] : []),
      [277, TYPE.SHORT, [img.bands]],
      [284, TYPE.SHORT, [1]],
      ...(k === 0 ? [[305, TYPE.ASCII, ascii(opts.software ?? 'GIS Workbench')]] : []),
      ...(predictor > 1 ? [[317, TYPE.SHORT, [predictor]]] : []),
      [322, TYPE.SHORT, [tile]],
      [323, TYPE.SHORT, [tile]],
      [324, TYPE.LONG, encoded[k].map(() => 0)], // offsets, patched below
      [325, TYPE.LONG, encoded[k].map((t) => t.length)],
      ...(opts.photometric === 'rgb' && img.bands === 4 ? [[338, TYPE.SHORT, [2]]] : img.bands > 1 && opts.photometric !== 'rgb' ? [[338, TYPE.SHORT, Array(img.bands - 1).fill(0)]] : []),
      [339, TYPE.SHORT, Array(img.bands).fill(FMT[type])],
    ];
    if (k === 0 && opts.epsg) {
      if (opts.geotransform) {
        const [x0, dx, , y0, , dy] = opts.geotransform;
        tags.push([33550, TYPE.DOUBLE, [dx, Math.abs(dy), 0]]);
        tags.push([33922, TYPE.DOUBLE, [0, 0, 0, x0, y0, 0]]);
      } else if (opts.gcps?.length) tags.push([33922, TYPE.DOUBLE, opts.gcps.flatMap((g) => [g.x, g.y, 0, g.lon, g.lat, g.h ?? 0])]);
      tags.push([34735, TYPE.SHORT, geoKeys({ epsg: opts.epsg, vertical: opts.vertical })]);
    }
    if (k === 0 && opts.nodata !== undefined && opts.nodata !== null) tags.push([42113, TYPE.ASCII, ascii(Number.isNaN(opts.nodata) ? 'nan' : String(opts.nodata))]);
    if (k === 0 && opts.rpc?.length === 92) tags.push([50844, TYPE.DOUBLE, opts.rpc]);
    // GDAL_METADATA (band descriptions, wavelengths, units; REQ-MSI-01).
    if (k === 0 && opts.gdalMetadata) tags.push([42112, TYPE.ASCII, ascii(opts.gdalMetadata)]);
    tags.sort((a, b) => a[0] - b[0]);
    return tags;
  });
  // Layout (cloud-optimised): header, every IFD with its out-of-line values (main image first),
  // then the tile data from the smallest overview to the full resolution.
  const valueBytes = (t, v) => (t === TYPE.ASCII ? v.length : v.length * SIZE[t]);
  let off = 8;
  const ifdOff = [];
  for (const tags of ifds) {
    ifdOff.push(off);
    off += 2 + tags.length * 12 + 4;
    for (const [, t, v] of tags) if (valueBytes(t, v) > 4) off += valueBytes(t, v) + (valueBytes(t, v) & 1);
  }
  const dataStart = off;
  let total = dataStart;
  const tileOff = encoded.map(() => []);
  for (let k = encoded.length - 1; k >= 0; k--)
    tileOff[k] = encoded[k].map((t) => {
      const o = total;
      total += t.length;
      return o;
    });
  ifds.forEach((tags, k) => (tags.find((t) => t[0] === 324)[2] = tileOff[k]));
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOff[0], true);
  ifds.forEach((tags, k) => {
    let p = ifdOff[k];
    dv.setUint16(p, tags.length, true);
    p += 2;
    let extra = p + tags.length * 12 + 4;
    for (const [tag, t, v] of tags) {
      dv.setUint16(p, tag, true);
      dv.setUint16(p + 2, t, true);
      dv.setUint32(p + 4, t === TYPE.ASCII ? v.length : v.length, true);
      const nb = valueBytes(t, v);
      let q = nb > 4 ? extra : p + 8;
      if (nb > 4) dv.setUint32(p + 8, extra, true);
      if (t === TYPE.ASCII) u8.set(v, q);
      else
        for (const x of v) {
          if (t === TYPE.SHORT) dv.setUint16(q, x, true);
          else if (t === TYPE.LONG) dv.setUint32(q, x, true);
          else if (t === TYPE.DOUBLE) dv.setFloat64(q, x, true);
          else dv.setUint8(q, x);
          q += SIZE[t];
        }
      if (nb > 4) extra += nb + (nb & 1);
      p += 12;
    }
    dv.setUint32(p, k + 1 < ifds.length ? ifdOff[k + 1] : 0, true);
  });
  encoded.forEach((lv, k) => lv.forEach((t, i) => u8.set(t, tileOff[k][i])));
  return u8;
}
