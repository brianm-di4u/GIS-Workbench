// Quantized-mesh terrain writer (REQ-FMT-39, FC-14): a DEM loaded as terrain → Cesium
// quantized-mesh-1.0 tiles ({z}/{x}/{y}.terrain, TMS) and a layer.json with the `available`
// ranges, in the geographic (EPSG:4326) or Web Mercator (EPSG:3857) tiling, packed as a ZIP that
// any quantized-mesh server, CesiumJS or this app (drop the ZIP) reads. Heights are above the
// WGS 84 ellipsoid, sampled at each tile's (2^k + 1)² posts from the terrain; each tile is meshed
// and encoded in Rust (gw-tiles qmesh, `tiles` bundle) in the analysis worker.

import { zipSync } from 'fflate';
import { tileBounds } from '../render/qmesh.js';
import { gwError } from '../i18n/index.js';

const MERC_MAX = Math.PI * 6378137;
const mercY = (lat) => 6378137 * Math.log(Math.tan(Math.PI / 4 + (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 360));

/** TMS tile ranges covering bounds {west, south, east, north} at level z. */
export function tileRange(z, b, mercator) {
  if (mercator) {
    const k = 2 ** z;
    const tx = (lon) => Math.min(k - 1, Math.max(0, Math.floor(((lon + 180) / 360) * k)));
    const ty = (lat) => Math.min(k - 1, Math.max(0, Math.floor(((mercY(lat) + MERC_MAX) / (2 * MERC_MAX)) * k)));
    return { startX: tx(b.west), endX: tx(b.east - 1e-12), startY: ty(b.south), endY: ty(b.north - 1e-12) };
  }
  const s = 180 / 2 ** z;
  const cx = (lon) => Math.min(2 ** (z + 1) - 1, Math.max(0, Math.floor((lon + 180) / s)));
  const cy = (lat) => Math.min(2 ** z - 1, Math.max(0, Math.floor((lat + 90) / s)));
  return { startX: cx(b.west), endX: cx(b.east - 1e-12), startY: cy(b.south), endY: cy(b.north - 1e-12) };
}

/** Deepest level whose posts (size − 1 per tile) are about as dense as the DEM's (degrees per post). */
export function levelFor(postDeg, size = 65, mercator = false) {
  const z = Math.round(Math.log2((mercator ? 360 : 180) / ((size - 1) * postDeg)));
  return Math.max(0, Math.min(18, z));
}

/**
 * Write the tile set. `heightAt(lat, lon)` → metres above the ellipsoid (NaN outside the DEM);
 * `encode(z Float32Array, prm Float64Array)` → Promise<Uint8Array> (the Rust encoder).
 * opts: {bounds, mercator, minZoom, maxZoom, size, maxError, normals, maxTiles, name, onProgress}.
 * Returns {files: {path: Uint8Array}, layer, tiles}.
 */
export async function writeQuantizedMesh(heightAt, encode, { bounds, mercator = false, minZoom = 0, maxZoom, size = 65, maxError = 1, normals = true, maxTiles = 4096, name = 'terrain', onProgress } = {}) {
  if (!bounds) throw new Error('quantized-mesh writer: the terrain bounds are needed');
  if (!(maxZoom >= minZoom)) throw new Error('quantized-mesh writer: maxZoom must be ≥ minZoom');
  const ranges = [];
  let total = 0;
  for (let z = 0; z <= maxZoom; z++) {
    const r = tileRange(z, bounds, mercator);
    ranges.push(r);
    if (z >= minZoom) total += (r.endX - r.startX + 1) * (r.endY - r.startY + 1);
  }
  if (total > maxTiles) throw gwError('{n} tiles for levels {min}–{max}; lower the deepest level', { n: total.toLocaleString(), min: String(minZoom), max: String(maxZoom) }, 'E_QMESH_TOO_MANY');
  const files = {};
  let done = 0;
  let fallback = NaN;
  for (let z = minZoom; z <= maxZoom; z++) {
    const r = ranges[z];
    for (let x = r.startX; x <= r.endX; x++)
      for (let y = r.startY; y <= r.endY; y++) {
        const b = tileBounds(z, x, y, mercator);
        const zz = new Float32Array(size * size);
        const ys = mercator ? mercY(b.south) : 0;
        const yn = mercator ? mercY(b.north) : 0;
        let have = 0;
        for (let row = 0; row < size; row++) {
          const f = row / (size - 1);
          const lat = mercator ? (Math.atan(Math.sinh((yn - f * (yn - ys)) / 6378137)) * 180) / Math.PI : b.north - f * (b.north - b.south);
          for (let col = 0; col < size; col++) {
            const h = heightAt(lat, b.west + (col / (size - 1)) * (b.east - b.west));
            zz[row * size + col] = h;
            if (Number.isFinite(h)) have++;
          }
        }
        // Posts off the DEM take the tile's lowest height (or the last good one): Cesium needs every tile of the pyramid.
        let lo = Infinity;
        for (const h of zz) if (Number.isFinite(h) && h < lo) lo = h;
        if (Number.isFinite(lo)) fallback = lo;
        const fill = Number.isFinite(lo) ? lo : Number.isFinite(fallback) ? fallback : 0;
        if (have < zz.length) for (let i = 0; i < zz.length; i++) if (!Number.isFinite(zz[i])) zz[i] = fill;
        const prm = Float64Array.from([size, b.west, Math.max(-90, b.south), b.east, Math.min(90, b.north), mercator ? 1 : 0, maxError * 2 ** Math.max(0, maxZoom - z), normals ? 1 : 0]);
        files[`${z}/${x}/${y}.terrain`] = await encode(zz, prm);
        done++;
        onProgress?.(done / total);
      }
  }
  const layer = {
    tilejson: '2.1.0',
    name,
    description: 'Quantized-mesh 1.0 terrain written by GIS Workbench (heights above the WGS 84 ellipsoid)',
    version: '1.0.0',
    format: 'quantized-mesh-1.0',
    attribution: '',
    scheme: 'tms',
    tiles: ['{z}/{x}/{y}.terrain?v={version}'],
    projection: mercator ? 'EPSG:3857' : 'EPSG:4326',
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
    minzoom: minZoom,
    maxzoom: maxZoom,
    extensions: normals ? ['octvertexnormals'] : [],
    // Every level from 0 is listed (Cesium walks the pyramid from the root); levels below minZoom are empty.
    available: ranges.map((r, z) => (z >= minZoom ? [r] : [])),
  };
  files['layer.json'] = new TextEncoder().encode(JSON.stringify(layer, null, 1));
  return { files, layer, tiles: done };
}

/** ZIP of a written set under a folder name. */
export const zipTileSet = (files, folder) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [`${folder}/${k}`, [v, { level: 0 }]])));
