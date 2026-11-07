// Tile sets in the decode worker (FC-05, FC-06, FC-07; REQ-FMT-28, 30, 32): MBTiles (SQLite)
// and PMTiles (by range) as pyramid sources (workers/decode/pyramid.js contract). Raster tiles
// make a georeferenced EPSG:3857 image on GDAL's grid (origin and size from the bounds at the
// maximum zoom, lower zooms as native overviews); vector tiles are drawn with the default style
// (tiles/style.js) at one zoom past their maximum, every pyramid level from the matching zoom.
// The same handles serve basemap tiles (`tsTile`), identify (`tsQuery`) and extraction (`tsExtract`).

import { openMbtiles, mercBounds, MBTILES_CAP, mbtilesTooLargeError, R } from '../../formats/mbtiles.js';
import { openPmtilesSet } from '../../tiles/pmtiles-set.js';
import { makeDecompress, brotliWith, LIMIT } from '../../tiles/decompress.js';
import { zstdDecode } from '../../codecs/zstd.js';
import { decodeMvt, drawTile, backgroundFor, queryTile, tileGeoJSON, lonLatToWorld } from '../../tiles/mvt.js';
import { BACKGROUND } from '../../tiles/style.js';
import { gwError } from '../../i18n/index.js';

const { GW } = self;
const HALF = Math.PI * R;

let sqlP = null;
/** sql.js (rtree-sql.js) in this worker, from the verified js-sqlite and wasm-sqlite blocks. */
export function workerSqlite() {
  sqlP ??= (async () => {
    await GW.lib('js-sqlite');
    const lib = self.__lib?.['js-sqlite'];
    if (!lib?.initSqlJs) throw new Error('the SQLite library did not load in the worker');
    const module = await GW.module('sqlite');
    return lib.initSqlJs({
      instantiateWasm(imports, ok) {
        WebAssembly.instantiate(module, imports).then((inst) => ok(inst));
        return {};
      },
    });
  })();
  sqlP.catch(() => (sqlP = null));
  return sqlP;
}

export const decompress = makeDecompress({ brotli: brotliWith(() => GW.ensure('brotli')), zstd: (u8) => zstdDecode(u8, LIMIT) });

/** Open a tile set from a File (MBTiles or PMTiles, by the first bytes). */
export async function openTileset(file, name) {
  const h = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const s = String.fromCharCode(...h.slice(0, 7));
  if (s === 'PMTiles') return openPmtilesSet(file, decompress);
  if (s.startsWith('SQLite')) {
    if (file.size > MBTILES_CAP) {
      const e = mbtilesTooLargeError(file.size);
      e.code = 3; // the worker's "too large" status, which callers test
      throw e;
    }
    const SQL = await workerSqlite();
    return openMbtiles(SQL, new Uint8Array(await file.arrayBuffer()), name);
  }
  throw new Error('not an MBTiles (SQLite) or PMTiles file');
}

class Lru {
  constructor(n, drop = () => {}) {
    this.n = n;
    this.m = new Map();
    this.drop = drop;
  }
  get(k) {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k, v) {
    this.m.set(k, v);
    while (this.m.size > this.n) {
      const [k0, v0] = this.m.entries().next().value;
      this.m.delete(k0);
      this.drop(v0);
    }
  }
}

const BITMAP = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };

/** RGBA canvas pixels → three u8 planes (or a subset of bands). */
function planes(img, w, h, bands) {
  const px = img.data;
  return bands.map((b) => {
    const out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = px[4 * i + b];
    return out;
  });
}

/**
 * Raster tile set → pyramid source on GDAL's MBTiles grid (mbtilesdataset.cpp): pixel size of the
 * maximum zoom, origin at the bounds' west/north edge, size rounded from the bounds.
 */
async function rasterSource(ts) {
  let z = ts.maxZoom;
  if (ts.kind === 'pmtiles') {
    // PMTiles have no GDAL raster grid to match: the deepest zoom that holds tiles (headers may
    // claim zoom 22 for one tile), and at most 2^21 px across.
    const all = await ts.list(null, 200_000).catch(() => null);
    if (all?.length) z = Math.max(ts.minZoom, Math.min(z, Math.max(...all.map((t) => t[0]))));
    const [w0, s0, e0, n0] = ts.bounds;
    const span = Math.max(lonLatToWorld(e0, 0)[0] - lonLatToWorld(w0, 0)[0], lonLatToWorld(0, s0)[1] - lonLatToWorld(0, n0)[1]);
    while (z > ts.minZoom && span * 256 * 2 ** z > 2 ** 21) z--;
  }
  // Tile size from a tile at the maximum zoom (256 or 512).
  let T = 256;
  const probe = await firstTile(ts, z);
  if (probe) {
    try {
      const bmp = await createImageBitmap(new Blob([probe]), BITMAP);
      T = bmp.width;
      bmp.close();
    } catch (e) {
      throw gwError('the {format} tiles cannot be decoded by this browser ({msg})', { format: ts.format.toUpperCase(), msg: String(e.message) });
    }
  }
  const res = (2 * HALF) / (T * 2 ** z);
  const [minX, minY, maxX, maxY] = mercBounds(ts.bounds);
  const width = Math.floor(0.5 + (maxX - minX) / res);
  const height = Math.floor(0.5 + (maxY - minY) / res);
  if (!(width > 0 && height > 0)) throw new Error('the tile set bounds are empty');
  if (width * height > 2 ** 40) throw new Error('the tile set is too large to open as one image');
  const shiftX = Math.floor(0.5 + (minX + HALF) / res);
  const shiftY = Math.floor(0.5 + (HALF - maxY) / res);
  const bmps = new Lru(96, (b) => b?.close?.());
  const pending = new Map();
  const tileBitmap = (zz, x, y) => {
    const k = `${zz}/${x}/${y}`;
    const hit = bmps.get(k);
    if (hit !== undefined) return Promise.resolve(hit);
    if (pending.has(k)) return pending.get(k);
    const p = ts
      .getTile(zz, x, y)
      .then((b) => (b && b.length ? createImageBitmap(new Blob([b]), BITMAP).catch(() => null) : null))
      .then((bmp) => {
        bmps.set(k, bmp);
        pending.delete(k);
        return bmp;
      }, (e) => {
        pending.delete(k);
        throw e;
      });
    pending.set(k, p);
    return p;
  };
  const read = async (L, x, y, w, h, bands) => {
    const zz = z - L;
    const sx = Math.round(shiftX / 2 ** L) + x;
    const sy = Math.round(shiftY / 2 ** L) + y;
    const n = 2 ** zz;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    const jobs = [];
    for (let ty = Math.floor(sy / T); ty <= Math.floor((sy + h - 1) / T); ty++)
      for (let tx = Math.floor(sx / T); tx <= Math.floor((sx + w - 1) / T); tx++) {
        if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
        jobs.push(tileBitmap(zz, tx, ty).then((bmp) => bmp && g.drawImage(bmp, tx * T - sx, ty * T - sy, T, T)));
      }
    await Promise.all(jobs);
    return planes(g.getImageData(0, 0, w, h), w, h, bands);
  };
  return {
    width,
    height,
    bands: 3,
    sampleType: 'u8',
    nodata: null,
    readWindow: (x, y, w, h, bands) => read(0, x, y, w, h, bands),
    readLevel: (L, x, y, w, h, bands) => read(L, x, y, w, h, bands),
    hasLevel: (L) => z - L >= ts.minZoom && L > 0,
    geotransform: [minX, res, 0, maxY, 0, -res],
    tileSize: T,
    zoom: z,
  };
}

async function firstTile(ts, z) {
  if (ts.kind === 'mbtiles') {
    for (const [, x, y] of (await ts.list(z)).slice(0, 8)) {
      const b = await ts.getTile(z, x, y);
      if (b?.length) return b;
    }
    return null;
  }
  // PMTiles: the centre of the bounds at the maximum zoom, else any tile of the root directory.
  const [w, s, e, n] = ts.bounds;
  const [cx, cy] = lonLatToWorld((w + e) / 2, (s + n) / 2);
  const N = 2 ** z;
  const b = await ts.getTile(z, Math.min(N - 1, Math.floor(cx * N)), Math.min(N - 1, Math.floor(cy * N)));
  if (b?.length) return b;
  const [x0, y0] = lonLatToWorld(w, n);
  for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
    const t = await ts.getTile(z, Math.min(N - 1, Math.floor(x0 * N) + dx), Math.min(N - 1, Math.floor(y0 * N) + dy));
    if (t?.length) return t;
  }
  return null;
}

/** Decoded vector tiles, shared by drawing, identify and extraction. */
function vectorCache(ts) {
  const lru = new Lru(64);
  const pending = new Map();
  return (z, x, y) => {
    const k = `${z}/${x}/${y}`;
    const hit = lru.get(k);
    if (hit !== undefined) return Promise.resolve(hit);
    if (pending.has(k)) return pending.get(k);
    const p = ts.getTile(z, x, y).then((b) => {
      const vt = b && b.length ? decodeMvt(b) : null;
      lru.set(k, vt);
      pending.delete(k);
      return vt;
    }, (e) => {
      pending.delete(k);
      throw e;
    });
    pending.set(k, p);
    return p;
  };
}

/**
 * Vector tile set → pyramid source: the default style drawn at `zr` (three zooms past the data's
 * maximum, at most 2^22 px across), each level from the closest data zoom (over- or under-zoomed).
 */
function vectorSource(ts) {
  const T = 256;
  const [w, s, e, n] = ts.bounds;
  const [wx0, wy0] = lonLatToWorld(w, n);
  const [wx1, wy1] = lonLatToWorld(e, s);
  let zr = Math.min(ts.maxZoom + 3, 24);
  while (zr > 0 && Math.max(wx1 - wx0, wy1 - wy0) * T * 2 ** zr > 2 ** 22) zr--;
  const N = T * 2 ** zr;
  const x0 = Math.floor(wx0 * N);
  const y0 = Math.floor(wy0 * N);
  const width = Math.max(1, Math.ceil(wx1 * N) - x0);
  const height = Math.max(1, Math.ceil(wy1 * N) - y0);
  const res = (2 * HALF) / N;
  const tile = vectorCache(ts);
  // Drawn data tiles (transparent ImageBitmaps of 512–1024 px), about 64 MB at most.
  const drawn = new Lru(64, (b) => b?.close?.());
  let bg;
  const read = async (L, x, y, ww, hh, bands, job) => {
    const zl = zr - L;
    // Vector tiles are made for 512-px display: drawing zoom zl (256-px tiles) reads data zoom zl − 1.
    const zd = Math.max(ts.minZoom, Math.min(ts.maxZoom, zl - 1));
    const size = T * 2 ** (zl - zd); // drawn size of one data tile
    const gx = Math.round(x0 / 2 ** L) + x;
    const gy = Math.round(y0 / 2 ** L) + y;
    const c = new OffscreenCanvas(ww, hh);
    // GPU-backed canvas: thousands of stroked roads draw far faster than in a CPU (willReadFrequently)
    // canvas, and one getImageData per window is a cheap read-back.
    const g = c.getContext('2d');
    const nd = 2 ** zd;
    const tx0 = Math.max(0, Math.floor(gx / size));
    const ty0 = Math.max(0, Math.floor(gy / size));
    const tx1 = Math.min(nd - 1, Math.floor((gx + ww - 1) / size));
    const ty1 = Math.min(nd - 1, Math.floor((gy + hh - 1) / size));
    const list = [];
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) <= 256) for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) list.push([tx, ty]);
    const vts = await Promise.all(list.map(([tx, ty]) => tile(zd, tx, ty).catch(() => null)));
    job?.checkCancel?.();
    if (bg === undefined) bg = vts.find(Boolean) ? backgroundFor(vts.find(Boolean)) : null;
    g.fillStyle = bg ?? '#ffffff';
    g.fillRect(0, 0, ww, hh);
    list.forEach(([tx, ty], i) => {
      const vt = vts[i];
      if (!vt) return;
      const ox = tx * size - gx;
      const oy = ty * size - gy;
      // A data tile spans several pyramid windows: it is drawn once per zoom and composited after.
      if (size <= 1024) {
        const k = `${zl}/${tx}/${ty}`;
        let bmp = drawn.get(k);
        if (!bmp) {
          const tc = new OffscreenCanvas(size, size);
          const tg = tc.getContext('2d');
          drawTile(tg, vt, { size, zoom: zl - 1 });
          bmp = tc.transferToImageBitmap();
          drawn.set(k, bmp);
        }
        g.drawImage(bmp, ox, oy);
        return;
      }
      g.save();
      g.beginPath();
      g.rect(ox, oy, size, size);
      g.clip();
      drawTile(g, vt, { ox, oy, size, zoom: zl - 1 });
      g.restore();
    });
    return planes(g.getImageData(0, 0, ww, hh), ww, hh, bands);
  };
  return {
    width,
    height,
    bands: 3,
    sampleType: 'u8',
    nodata: null,
    readWindow: (x, y, ww, hh, bands, job) => read(0, x, y, ww, hh, bands, job),
    readLevel: (L, x, y, ww, hh, bands, job) => read(L, x, y, ww, hh, bands, job),
    hasLevel: (L) => L > 0 && zr - L >= Math.max(0, ts.minZoom - 6),
    statsCoarsest: true,
    geotransform: [x0 * res - HALF, res, 0, HALF - y0 * res, 0, -res],
    tileSize: T,
    zoom: zr,
    tile,
  };
}

/** Pyramid source and metadata of a tile set (the decode worker's `open` for kind 'tileset'). */
export async function tilesetSource(ts) {
  const vector = ts.tileType === 'mvt';
  const src = vector ? vectorSource(ts) : await rasterSource(ts);
  const what = ts.kind === 'mbtiles' ? 'MBTiles' : 'PMTiles';
  const meta = {
    format: `${what} ${vector ? 'vector (MVT)' : ts.format.toUpperCase()}${vector ? `, drawn at zoom ${src.zoom}` : ''}`,
    container: what,
    tileType: ts.tileType,
    vector,
    name: ts.name,
    minZoom: ts.minZoom,
    maxZoom: ts.maxZoom,
    bounds: ts.bounds,
    boundsFromMetadata: ts.boundsFromMetadata,
    center: ts.center,
    tiles: ts.tiles,
    tileCompression: ts.tileCompression,
    internalCompression: ts.internalCompression ?? null,
    tileSize: src.tileSize,
    drawZoom: src.zoom,
    attribution: ts.attribution,
    metadata: Object.fromEntries(Object.entries(ts.metadata ?? {}).filter(([k, v]) => k !== 'json' && (typeof v !== 'object' || v === null)).map(([k, v]) => [k, String(v).slice(0, 2000)])),
    vectorLayers: (ts.vectorLayers ?? []).map((l) => ({ id: l.id, fields: Object.keys(l.fields ?? {}), minzoom: l.minzoom, maxzoom: l.maxzoom })),
    epsg: 3857,
    geotransform: src.geotransform,
  };
  return { meta, source: src };
}

// ---- basemap tiles, identify, extraction ----

/** One basemap tile as an ImageBitmap: a raster tile decoded, or a vector tile drawn (size px). */
export async function basemapTile(ent, z, x, y, size = 512) {
  const ts = ent.ts;
  if (ts.tileType !== 'mvt') {
    const b = await ts.getTile(z, x, y);
    if (!b?.length) return null;
    return createImageBitmap(new Blob([b]));
  }
  ent.vtile ??= vectorCache(ts);
  const zd = Math.max(ts.minZoom, Math.min(ts.maxZoom, z));
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  if (zd === z) {
    const vt = await ent.vtile(z, x, y);
    if (!vt) return null;
    const bg = backgroundFor(vt);
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, size, size);
    }
    drawTile(g, vt, { size, zoom: z, dpr: size / 256 });
  } else if (z > zd) {
    // Over-zoom: the part of the parent tile that covers this one.
    const k = 2 ** (z - zd);
    const px = Math.floor(x / k);
    const py = Math.floor(y / k);
    const vt = await ent.vtile(zd, px, py);
    if (!vt) return null;
    const bg = backgroundFor(vt);
    if (bg) {
      g.fillStyle = bg;
      g.fillRect(0, 0, size, size);
    }
    g.save();
    g.beginPath();
    g.rect(0, 0, size, size);
    g.clip();
    drawTile(g, vt, { ox: -(x - px * k) * size, oy: -(y - py * k) * size, size: size * k, zoom: z, dpr: size / 256 });
    g.restore();
  } else return null; // under the minimum zoom: nothing (the basemap shows from minZoom)
  return c.transferToImageBitmap();
}

/** Features under (lat, lon) at zoom z (clamped to the data), within tol pixels of a 256-px tile. */
export async function queryAt(ent, lat, lon, z, tolPx = 4) {
  const ts = ent.ts;
  if (ts.tileType !== 'mvt') throw new Error('identify reads vector tiles; this tile set is raster');
  ent.vtile ??= vectorCache(ts);
  const zd = Math.max(ts.minZoom, Math.min(ts.maxZoom, Math.round(z)));
  const [wx, wy] = lonLatToWorld(lon, lat);
  const n = 2 ** zd;
  const tx = Math.floor(wx * n);
  const ty = Math.floor(wy * n);
  const vt = await ent.vtile(zd, tx, ty);
  if (!vt) return { zoom: zd, tile: [zd, tx, ty], features: [] };
  const scale = 2 ** Math.max(0, z - zd);
  return { zoom: zd, tile: [zd, tx, ty], features: queryTile(vt, wx * n - tx, wy * n - ty, tolPx / 256 / scale).slice(0, 50) };
}

/**
 * Features of the tiles at zoom z that cover bbox [w, s, e, n] (null: the whole set), clipped to
 * their tiles (no buffer), as GeoJSON per layer — the way GDAL's MVT driver reads a tile set.
 * Refuses more than maxTiles tiles or maxFeatures features.
 */
export async function extractFeatures(ent, { bbox = null, zoom = null, layers = null, clip = true, maxTiles = 4096, maxFeatures = 500_000 } = {}, job) {
  const ts = ent.ts;
  if (ts.tileType !== 'mvt') throw new Error('extraction reads vector tiles; this tile set is raster');
  ent.vtile ??= vectorCache(ts);
  const z = Math.max(ts.minZoom, Math.min(ts.maxZoom, zoom ?? ts.maxZoom));
  const box = bbox ?? ts.bounds;
  const n = 2 ** z;
  let tiles;
  if (!bbox && ts.list) tiles = (await ts.list(z, maxTiles + 1)).map(([, x, y]) => [x, y]);
  else {
    const [a, b] = lonLatToWorld(box[0], box[3]);
    const [c, d] = lonLatToWorld(box[2], box[1]);
    const x0 = Math.max(0, Math.floor(a * n));
    const y0 = Math.max(0, Math.floor(b * n));
    const x1 = Math.min(n - 1, Math.floor(c * n - 1e-12));
    const y1 = Math.min(n - 1, Math.floor(d * n - 1e-12));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxTiles) throw gwError('the area covers {n} tiles at zoom {z} (at most {max}): choose a lower zoom or a smaller area', { n: String((x1 - x0 + 1) * (y1 - y0 + 1)), z: String(z), max: String(maxTiles) });
    tiles = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push([x, y]);
  }
  if (tiles.length > maxTiles) throw gwError('the tile set has {n} tiles at zoom {z} (at most {max} are extracted at once): choose a lower zoom or an area', { n: String(tiles.length), z: String(z), max: String(maxTiles) });
  const out = {};
  let count = 0;
  let read = 0;
  for (let i = 0; i < tiles.length; i++) {
    job?.checkCancel?.();
    const [x, y] = tiles[i];
    const vt = await ent.vtile(z, x, y);
    if (!vt) continue;
    read++;
    const got = tileGeoJSON(vt, z, x, y, { layers: layers ? new Set(layers) : null, clip, bbox });
    for (const [name, fs] of Object.entries(got)) {
      (out[name] ??= []).push(...fs);
      count += fs.length;
    }
    if (count > maxFeatures) throw gwError('more than {max} features: choose a lower zoom or a smaller area', { max: maxFeatures.toLocaleString('en') });
    job?.progress?.((i + 1) / tiles.length);
  }
  return { zoom: z, tiles: read, features: count, layers: out };
}

export { BACKGROUND };
