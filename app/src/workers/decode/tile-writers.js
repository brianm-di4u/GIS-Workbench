// Tile writers in the decode worker (P14: REQ-FMT-29, REQ-FMT-31, REQ-FMT-33): an image warped to
// Web Mercator tiles, a vector layer tiled to MVT by the Rust tiler, a tile set copied (MBTiles ↔
// PMTiles), each written as PMTiles v3 (Rust writer, gzip directories) or MBTiles 1.3 (SQLite).

import { writeMbtiles } from '../../formats/mbtiles.js';
import { runTiler, writePmtiles, gzipBytes } from '../../tiles/tiler.js';
import { lonLatToWorld } from '../../tiles/merc.js';
import { workerSqlite } from './tileset.js';
import { TILE } from './pyramid.js';
import { gwError } from '../../i18n/index.js';

const { GW } = self;
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

/**
 * One Web Mercator tile warped from an image pyramid: `grid` holds (G+1)² image coordinates
 * (x, y pairs; NaN outside the image's model) over the tile, interpolated bilinearly per pixel;
 * pixels are taken (nearest) from pyramid level `level`; `lut` maps each band to 0..255
 * ([scale, offset] or null for 8-bit). Returns encoded bytes, or null for an empty tile.
 */
export async function warpTile(ent, { grid, G, size = 256, level = 0, bands, lut = null, type = 'png', quality = 0.9 }, job) {
  const pyr = ent.pyr;
  if (!pyr) throw new Error('not an image handle');
  const L = Math.max(0, Math.min(pyr.levels - 1, level));
  const f = 2 ** L;
  const { w: lw, h: lh } = pyr.dims(L);
  const n = size * size;
  const ix = new Float64Array(n);
  const iy = new Float64Array(n);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const k = (a, b) => 2 * (a * (G + 1) + b);
  for (let py = 0; py < size; py++) {
    const v = ((py + 0.5) / size) * G;
    const j = Math.min(G - 1, Math.floor(v));
    const fv = v - j;
    for (let px = 0; px < size; px++) {
      const u = ((px + 0.5) / size) * G;
      const i = Math.min(G - 1, Math.floor(u));
      const fu = u - i;
      const q00 = k(j, i);
      const q01 = k(j, i + 1);
      const q10 = k(j + 1, i);
      const q11 = k(j + 1, i + 1);
      const o = py * size + px;
      const X = ((1 - fv) * ((1 - fu) * grid[q00] + fu * grid[q01]) + fv * ((1 - fu) * grid[q10] + fu * grid[q11])) / f;
      const Y = ((1 - fv) * ((1 - fu) * grid[q00 + 1] + fu * grid[q01 + 1]) + fv * ((1 - fu) * grid[q10 + 1] + fu * grid[q11 + 1])) / f;
      ix[o] = X;
      iy[o] = Y;
      if (X >= 0 && Y >= 0 && X < lw && Y < lh) {
        if (X < x0) x0 = X;
        if (Y < y0) y0 = Y;
        if (X > x1) x1 = X;
        if (Y > y1) y1 = Y;
      }
    }
  }
  if (!(x1 >= x0)) return null;
  // The pyramid's core tiles under the footprint.
  const tx0 = Math.floor(x0 / TILE);
  const tx1 = Math.floor(x1 / TILE);
  const ty0 = Math.floor(y0 / TILE);
  const ty1 = Math.floor(y1 / TILE);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 64) throw new Error('a tile reaches too much of the image: choose a higher minimum zoom');
  const cores = new Map();
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push(pyr.coreGroup(L, tx, ty, bands, job).then((g) => cores.set(`${tx}/${ty}`, g)));
  await Promise.all(jobs);
  const rgba = new Uint8ClampedArray(n * 4);
  let any = false;
  for (let o = 0; o < n; o++) {
    const X = ix[o];
    const Y = iy[o];
    if (!(X >= 0 && Y >= 0 && X < lw && Y < lh)) continue;
    const xi = Math.floor(X);
    const yi = Math.floor(Y);
    const c = cores.get(`${Math.floor(xi / TILE)}/${Math.floor(yi / TILE)}`);
    if (!c) continue;
    const idx = (yi % TILE) * c[0].w + (xi % TILE);
    for (let q = 0; q < 3; q++) {
      const bi = Math.min(q, c.length - 1);
      const v = c[bi].data[idx];
      const m = lut?.[bi];
      rgba[o * 4 + q] = m ? m[0] * v + m[1] : v;
    }
    rgba[o * 4 + 3] = 255;
    any = true;
  }
  if (!any) return null;
  const cv = new OffscreenCanvas(size, size);
  const g = cv.getContext('2d');
  if (type === 'jpeg') {
    // No alpha in JPEG: outside the image is black.
    for (let o = 0; o < n; o++) if (!rgba[o * 4 + 3]) rgba[o * 4 + 3] = 255;
  }
  g.putImageData(new ImageData(rgba, size, size), 0, 0);
  const blob = await cv.convertToBlob({ type: MIME[type] ?? 'image/png', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

/** TileJSON vector_layers of tiler input layers. */
function vectorLayersOf(layers, minzoom, maxzoom) {
  return layers.map((l) => {
    const fields = {};
    for (const f of l.features) for (const [key, v] of Object.entries(f.properties ?? {})) fields[key] ??= typeof v === 'number' ? 'Number' : typeof v === 'boolean' ? 'Boolean' : 'String';
    return { id: l.name, fields, minzoom, maxzoom };
  });
}

/** Write tiles [{z, x, y, data}] (raw tile bytes; MVT uncompressed) as PMTiles or MBTiles. */
export async function writeTiles(tiles, { to, type, bounds, name = 'GIS Workbench tiles', metadata = {}, vectorLayers = null }) {
  if (!tiles.length) throw new Error('no tiles to write');
  let minzoom = 99;
  let maxzoom = 0;
  for (const t of tiles) {
    minzoom = Math.min(minzoom, t.z);
    maxzoom = Math.max(maxzoom, t.z);
  }
  const meta = { name, description: metadata.description ?? `${name}, written by GIS Workbench`, generator: 'GIS Workbench', ...(vectorLayers ? { vector_layers: vectorLayers } : {}), ...metadata };
  const tb = await GW.ensure('tiles');
  if (to === 'pmtiles') return writePmtiles(tb, tiles, { type, bounds, metadata: { ...meta, format: type === 'mvt' ? 'pbf' : type }, centerZoom: minzoom });
  if (to !== 'mbtiles') throw gwError('unknown tile container {to}', { to: String(to) });
  const SQL = await workerSqlite();
  const rows = type === 'mvt' ? tiles.map((t) => ({ ...t, data: gzipBytes(tb, t.data, 6) })) : tiles;
  return writeMbtiles(SQL, rows, { name, format: type === 'mvt' ? 'pbf' : type === 'jpeg' ? 'jpg' : type, bounds, minzoom, maxzoom, center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, minzoom], description: meta.description, attribution: metadata.attribution, json: vectorLayers ? { vector_layers: vectorLayers } : null });
}

/** Vector layers (tiler input bytes + the layers for their field list) → an MVT tile set's bytes. */
export async function tileVectors({ input, layers, to, minZoom, maxZoom, tolerance = 1, buffer = 64, name, bounds, maxTiles = 200000 }) {
  const tb = await GW.ensure('tiles');
  const tiles = runTiler(tb, input, { minZoom, maxZoom, tolerance, buffer, maxTiles });
  if (!tiles.length) throw new Error('the layer made no tiles (no features inside ±85° latitude?)');
  const own = tiles.map((t) => ({ z: t.z, x: t.x, y: t.y, data: t.data.slice() }));
  const bytes = await writeTiles(own, { to, type: 'mvt', bounds, name, vectorLayers: vectorLayersOf(layers, minZoom, maxZoom) });
  const perZoom = {};
  for (const t of tiles) perZoom[t.z] = (perZoom[t.z] ?? 0) + 1;
  return { bytes, tiles: tiles.length, perZoom };
}

/** Copy a tile set (all of it, or bbox × zoom range) to PMTiles or MBTiles (MBTiles ↔ PMTiles). */
export async function exportTileset(ent, { to, bbox = null, minZoom = null, maxZoom = null, maxTiles = 500000 }, job) {
  const ts = ent.ts;
  const z0 = Math.max(ts.minZoom, minZoom ?? ts.minZoom);
  const z1 = Math.min(ts.maxZoom, maxZoom ?? ts.maxZoom);
  const box = bbox ?? ts.bounds;
  const want = [];
  if (ts.list && !bbox) {
    for (const [z, x, y] of await ts.list(null, maxTiles + 1)) if (z >= z0 && z <= z1) want.push([z, x, y]);
  } else {
    for (let z = z0; z <= z1; z++) {
      const n = 2 ** z;
      const [a, b] = lonLatToWorld(box[0], box[3]);
      const [c, d] = lonLatToWorld(box[2], box[1]);
      const xa = Math.max(0, Math.floor(a * n));
      const ya = Math.max(0, Math.floor(b * n));
      const xb = Math.min(n - 1, Math.floor(c * n - 1e-12));
      const yb = Math.min(n - 1, Math.floor(d * n - 1e-12));
      if (want.length + (xb - xa + 1) * (yb - ya + 1) > maxTiles) throw gwError('more than {max} tiles: choose a smaller area or zoom range', { max: maxTiles.toLocaleString('en') });
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) want.push([z, x, y]);
    }
  }
  const tiles = [];
  for (let i = 0; i < want.length; i++) {
    if (i % 64 === 0) {
      job?.checkCancel?.();
      job?.progress?.(i / want.length);
    }
    const [z, x, y] = want[i];
    const data = await ts.getTile(z, x, y);
    if (data?.length) tiles.push({ z, x, y, data });
  }
  const vector = ts.tileType === 'mvt';
  const bytes = await writeTiles(tiles, { to, type: ts.tileType, bounds: box, name: ts.name, metadata: ts.attribution ? { attribution: ts.attribution } : {}, vectorLayers: vector ? ts.vectorLayers ?? null : null });
  return { bytes, tiles: tiles.length };
}
