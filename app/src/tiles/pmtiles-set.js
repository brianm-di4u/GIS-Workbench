// A PMTiles v3 archive as a tile set (FC-06, FC-07): read by range through the pmtiles library
// with the decompress hook of tiles/decompress.js (gzip, Brotli, Zstandard). The same shape as
// formats/mbtiles.js openMbtiles, so readers, basemaps and writers take either.

import { PMTiles, FileSource, SharedPromiseCache, tileIdToZxy } from 'pmtiles';
import { COMPRESSION } from './decompress.js';
import { gwError } from '../i18n/index.js';

export const TILE_TYPE = { 0: 'unknown', 1: 'mvt', 2: 'png', 3: 'jpeg', 4: 'webp', 5: 'avif', 6: 'mlt' };

/** A decompressed PMTiles directory → entries (bounds-checked varints, at most 2^22 entries). */
export function readDirectory(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
      if (pos >= buf.length) throw new Error('the PMTiles directory is cut short');
      const c = buf[pos++];
      v += (c & 0x7f) * mul;
      if (c < 0x80) return v;
      mul *= 128;
    }
    throw new Error('a PMTiles directory varint is longer than 10 bytes');
  };
  const n = varint();
  if (n > 1 << 22 || n > buf.length) throw new Error('the PMTiles directory claims more entries than it holds');
  const es = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let last = 0;
  for (const e of es) e.tileId = last += varint();
  for (const e of es) e.runLength = varint();
  for (const e of es) e.length = varint();
  es.forEach((e, i) => {
    const v = varint();
    if (v === 0 && i === 0) throw new Error('the first PMTiles directory entry has no offset');
    e.offset = v === 0 ? es[i - 1].offset + es[i - 1].length : v - 1;
  });
  return es;
}

export async function openPmtilesSet(file, decompress) {
  const pm = new PMTiles(new FileSource(file), new SharedPromiseCache(100, true, decompress), decompress);
  let hd;
  try {
    hd = await pm.getHeader();
  } catch (e) {
    if (/magic number/i.test(e.message)) throw new Error('not a PMTiles archive (bad magic number)');
    throw gwError('the PMTiles header or root directory cannot be read ({detail})', { detail: e.message }, 'E_PMTILES_HEADER');
  }
  const tileType = TILE_TYPE[hd.tileType] ?? 'unknown';
  if (tileType === 'mlt') throw new Error('MapLibre Tiles (MLT) are not read: GIS Workbench reads MVT vector and PNG/JPEG/WebP/AVIF raster PMTiles');
  if (tileType === 'unknown') throw new Error('the PMTiles tile type is "unknown"');
  let meta = {};
  try {
    meta = (await pm.getMetadata()) ?? {};
  } catch (e) {
    // Metadata is optional for drawing, but a damaged block in a Brotli/Zstandard archive is worth naming.
    if (/Brotli|Zstandard/.test(e.message)) throw e;
    meta = {};
  }
  const ok = (v) => Number.isFinite(v);
  const bounds = [hd.minLon, hd.minLat, hd.maxLon, hd.maxLat];
  const valid = bounds.every(ok) && hd.maxLon > hd.minLon && hd.maxLat > hd.minLat;
  return {
    kind: 'pmtiles',
    name: meta?.name ?? file.name,
    tileType,
    format: tileType,
    minZoom: hd.minZoom,
    maxZoom: hd.maxZoom,
    bounds: valid ? bounds : [-180, -85.0511287798066, 180, 85.0511287798066],
    boundsFromMetadata: valid,
    center: [hd.centerLon, hd.centerLat, hd.centerZoom],
    metadata: meta,
    attribution: meta?.attribution ? String(meta.attribution).replace(/<[^>]*>/g, '') : '',
    vectorLayers: meta?.vector_layers ?? null,
    tiles: hd.numAddressedTiles,
    tileCompression: COMPRESSION[hd.tileCompression] ?? String(hd.tileCompression),
    internalCompression: COMPRESSION[hd.internalCompression] ?? String(hd.internalCompression),
    header: hd,
    pm,
    async getTile(z, x, y) {
      if (z < hd.minZoom || z > hd.maxZoom) return null;
      const r = await pm.getZxy(z, x, y);
      return r?.data ? new Uint8Array(r.data) : null;
    },
    /** Every (z, x, y) the directories address (one zoom, or all), at most `max`. */
    async list(z = null, max = 1_000_000) {
      const lo = z === null ? 0 : ((4 ** z - 1) / 3);
      const hi = z === null ? Infinity : ((4 ** (z + 1) - 1) / 3);
      const out = [];
      const walk = async (offset, length, depth) => {
        if (depth > 3) throw new Error('PMTiles directories nest deeper than 3 leaves');
        const raw = new Uint8Array(await decompress((await pm.source.getBytes(offset, length)).data, hd.internalCompression));
        for (const e of readDirectory(raw)) {
          if (e.runLength === 0) {
            // A leaf covers ids from its tileId to the next entry's: visit it if that can reach [lo, hi).
            if (e.tileId < hi) await walk(hd.leafDirectoryOffset + e.offset, e.length, depth + 1);
            continue;
          }
          for (let id = Math.max(e.tileId, lo); id < Math.min(e.tileId + e.runLength, hi); id++) {
            if (out.length >= max) throw gwError('the archive addresses more than {n, plural, one {# tile} other {# tiles}}', { n: max }, 'E_PMTILES_TOO_MANY');
            out.push(tileIdToZxy(id));
          }
        }
      };
      await walk(hd.rootDirectoryOffset, hd.rootDirectoryLength, 0);
      return out;
    },
    close() {},
  };
}
