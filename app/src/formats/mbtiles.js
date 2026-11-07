// MBTiles 1.3 read and write (FC-05, REQ-FMT-28, REQ-FMT-29; amended REQ-NET-05) on the lazy
// SQLite (rtree-sql.js, app/src/vector/gpkg.js loadSqlite, or the worker's copy of the same
// verified blocks). Tiles are stored in TMS order (row 0 at the south), so the XYZ y is flipped;
// raster tiles are PNG/JPEG/WebP(/AVIF), vector tiles gzip-compressed MVT ("pbf"). The whole file
// is read into memory, so files above MBTILES_CAP are refused by name with the conversion to
// PMTiles, which is read by range (risk R-44).

import { gwError } from '../i18n/index.js';

export const MBTILES_CAP = 768 * 2 ** 20;

export function mbtilesTooLarge(size) {
  return mbtilesTooLargeError(size).message;
}

/** The same refusal as an error with its message key (REQ-L10N-05): the worker posts it, the UI shows it with msgOf. */
export function mbtilesTooLargeError(size) {
  return gwError('this {mb} MB MBTiles file is above the {cap} MB that is read whole into memory: convert it to PMTiles (pmtiles convert in.mbtiles out.pmtiles, or Convert with Sidecar), which opens by range at any size', { mb: (size / 2 ** 20).toFixed(0), cap: String(MBTILES_CAP / 2 ** 20) }, 'E_MBTILES_TOO_LARGE');
}

const IMAGE = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', avif: 'avif', pbf: 'mvt', mvt: 'mvt' };

/** The tile type of a tile's bytes (magic numbers); null when unknown. */
export function sniffTile(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return 'webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'mvt'; // gzip: MBTiles vector tiles are gzipped MVT
  if (b[0] === 0x1a) return 'mvt'; // protobuf field 3 (layer), wire type 2
  return null;
}

const MAX_LAT = 85.0511287798066;
export const R = 6378137;
const HALF = Math.PI * R;
export const mercX = (lon) => (lon * HALF) / 180;
export const mercY = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 360));
const lonOf = (x) => (x / HALF) * 180;
const latOf = (y) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI);

/**
 * Open an MBTiles database held in memory. Returns a tile set:
 * {kind: 'mbtiles', tileType, format, minZoom, maxZoom, bounds [w,s,e,n], center, metadata,
 *  vectorLayers, getTile(z, x, y) → Promise<Uint8Array|null> (XYZ; vector tiles un-gzipped),
 *  count(z), close()}.
 */
export async function openMbtiles(SQL, bytes, name = 'MBTiles') {
  let db;
  try {
    db = new SQL.Database(bytes);
    db.exec('PRAGMA query_only = 1');
  } catch (e) {
    db?.close();
    throw gwError('{file} is not a readable SQLite database ({detail})', { file: name, detail: e.message }, 'E_NOT_SQLITE');
  }
  const rows = (sql, params = []) => {
    const st = db.prepare(sql);
    try {
      st.bind(params);
      const out = [];
      while (st.step()) out.push(st.getAsObject());
      return out;
    } finally {
      st.free();
    }
  };
  let tables;
  try {
    tables = new Set(rows("SELECT name FROM sqlite_master WHERE type IN ('table','view')").map((r) => String(r.name).toLowerCase()));
  } catch (e) {
    db.close();
    throw new Error(/malformed|not a database|corrupt/i.test(e.message) ? `the MBTiles (SQLite) file is damaged: ${e.message}` : `the MBTiles file cannot be read: ${e.message}`);
  }
  if (!tables.has('tiles')) {
    db.close();
    throw new Error(tables.has('gpkg_contents') ? 'a GeoPackage, not an MBTiles file' : 'not an MBTiles tile set: the SQLite file has no "tiles" table or view');
  }
  const metadata = {};
  if (tables.has('metadata')) {
    try {
      for (const r of rows('SELECT name, value FROM metadata')) metadata[String(r.name)] = r.value == null ? '' : String(r.value);
    } catch {
      /* a damaged metadata table: tiles alone */
    }
  }
  const tileQuery = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
  const raw = (z, x, yTms) => {
    tileQuery.bind([z, x, yTms]);
    try {
      if (!tileQuery.step()) return null;
      const v = tileQuery.get()[0];
      return v instanceof Uint8Array ? v : typeof v === 'string' ? new TextEncoder().encode(v) : null;
    } finally {
      tileQuery.reset();
    }
  };
  let zr;
  try {
    zr = rows('SELECT MIN(zoom_level) AS a, MAX(zoom_level) AS b, COUNT(*) AS n FROM tiles')[0];
  } catch (e) {
    tileQuery.free();
    db.close();
    throw new Error(/malformed|corrupt/i.test(e.message) ? `the MBTiles (SQLite) file is damaged: ${e.message}` : `the MBTiles tiles cannot be read: ${e.message}`);
  }
  if (!zr || !zr.n) {
    tileQuery.free();
    db.close();
    throw new Error('the MBTiles file holds no tiles');
  }
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  let minZoom = Number.isInteger(num(metadata.minzoom)) ? num(metadata.minzoom) : zr.a;
  let maxZoom = Number.isInteger(num(metadata.maxzoom)) ? num(metadata.maxzoom) : zr.b;
  // Metadata that disagrees with the tiles present: the tiles win (they are what is drawn).
  if (maxZoom > zr.b || maxZoom < zr.a) maxZoom = zr.b;
  if (minZoom < zr.a || minZoom > maxZoom) minZoom = zr.a;
  // Tile type: the format metadata, else the bytes of a tile at the maximum zoom.
  const first = rows('SELECT tile_data FROM tiles WHERE zoom_level = ? AND length(tile_data) > 0 LIMIT 1', [maxZoom])[0]?.tile_data;
  const sniffed = sniffTile(first);
  const format = String(metadata.format ?? '').toLowerCase();
  const tileType = IMAGE[format] ?? sniffed;
  if (!tileType) {
    tileQuery.free();
    db.close();
    throw gwError('the MBTiles tile format "{format}" is not PNG, JPEG, WebP or vector (pbf)', { format: String(metadata.format ?? '(not stated)') }, 'E_MBTILES_FORMAT');
  }
  // Extent of the tiles present at the maximum zoom (TMS rows).
  const ext = rows('SELECT MIN(tile_column) AS c0, MAX(tile_column) AS c1, MIN(tile_row) AS r0, MAX(tile_row) AS r1 FROM tiles WHERE zoom_level = ?', [maxZoom])[0];
  const n = 2 ** maxZoom;
  const tileBounds = [lonOf((ext.c0 / n) * 2 * HALF - HALF), latOf(((ext.r0) / n) * 2 * HALF - HALF), lonOf(((ext.c1 + 1) / n) * 2 * HALF - HALF), latOf(((ext.r1 + 1) / n) * 2 * HALF - HALF)];
  let bounds = String(metadata.bounds ?? '').split(',').map(Number);
  const boundsFromMetadata = bounds.length === 4 && bounds.every(Number.isFinite) && bounds[2] > bounds[0] && bounds[3] > bounds[1];
  if (!boundsFromMetadata) bounds = tileBounds;
  let json = null;
  try {
    json = metadata.json ? JSON.parse(metadata.json) : null;
  } catch {
    json = null;
  }
  const c = String(metadata.center ?? '').split(',').map(Number);
  const vector = tileType === 'mvt';
  const gunzip = async (b) => {
    if (!(b[0] === 0x1f && b[1] === 0x8b)) return b;
    const out = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return out;
  };
  let closed = false;
  return {
    kind: 'mbtiles',
    name: metadata.name || name,
    tileType,
    format: format || sniffed,
    minZoom,
    maxZoom,
    bounds,
    boundsFromMetadata,
    tileBounds,
    center: c.length >= 2 && c.every(Number.isFinite) ? c : null,
    metadata,
    attribution: metadata.attribution ? String(metadata.attribution).replace(/<[^>]*>/g, '') : '',
    vectorLayers: json?.vector_layers ?? null,
    tiles: zr.n,
    tileCompression: vector ? 'gzip' : 'none',
    async getTile(z, x, y) {
      if (closed || z < 0 || z > 30) return null;
      const b = raw(z, x, 2 ** z - 1 - y);
      if (!b || !b.length) return null;
      return vector ? gunzip(b) : b;
    },
    count(z) {
      return rows('SELECT COUNT(*) AS n FROM tiles WHERE zoom_level = ?', [z])[0].n;
    },
    /** Every (z, x, y) present (XYZ), for a whole-set read. */
    list(z = null) {
      const out = [];
      const st = db.prepare(z === null ? 'SELECT zoom_level, tile_column, tile_row FROM tiles' : 'SELECT zoom_level, tile_column, tile_row FROM tiles WHERE zoom_level = ?');
      try {
        if (z !== null) st.bind([z]);
        while (st.step()) {
          const [zz, x, yt] = st.get();
          out.push([zz, x, 2 ** zz - 1 - yt]);
        }
      } finally {
        st.free();
      }
      return out;
    },
    close() {
      if (closed) return;
      closed = true;
      tileQuery.free();
      db.close();
    },
  };
}

/**
 * Write an MBTiles 1.3 file: `tiles` [{z, x, y (XYZ), data}] (vector tiles already gzip-compressed),
 * `meta` {name, format, bounds [w,s,e,n], minzoom, maxzoom, center?, type?, description?,
 * attribution?, json?}. Returns the database bytes.
 */
export function writeMbtiles(SQL, tiles, meta) {
  const db = new SQL.Database();
  try {
    db.exec('PRAGMA page_size = 4096; PRAGMA application_id = 0x4d504258;');
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE UNIQUE INDEX name ON metadata (name);');
    db.exec('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);');
    const zs = tiles.map((t) => t.z);
    const m = {
      name: meta.name ?? 'GIS Workbench tiles',
      format: meta.format,
      bounds: meta.bounds.map((v) => +v.toFixed(7)).join(','),
      minzoom: String(meta.minzoom ?? Math.min(...zs)),
      maxzoom: String(meta.maxzoom ?? Math.max(...zs)),
      type: meta.type ?? (meta.format === 'pbf' ? 'baselayer' : 'overlay'),
      version: '1.3',
      description: meta.description ?? '',
      ...(meta.center ? { center: meta.center.join(',') } : {}),
      ...(meta.attribution ? { attribution: meta.attribution } : {}),
      ...(meta.json ? { json: typeof meta.json === 'string' ? meta.json : JSON.stringify(meta.json) } : {}),
    };
    const sm = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(m)) sm.run([k, String(v)]);
    sm.free();
    db.exec('BEGIN');
    const st = db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)');
    for (const t of tiles) st.run([t.z, t.x, 2 ** t.z - 1 - t.y, t.data]);
    st.free();
    db.exec('COMMIT');
    return db.export();
  } finally {
    db.close();
  }
}

/** Web Mercator bounds [minX, minY, maxX, maxY] (metres) of [w, s, e, n] degrees. */
export function mercBounds([w, s, e, n]) {
  return [mercX(w), mercY(s), mercX(e), mercY(n)];
}
