// FlatGeobuf and GeoParquet readers (REQ-CNV-02 round trip; TE archive 2.0.4): the bytes of a file
// become a GeoJSON FeatureCollection (with a legacy "crs" member when the file is not in WGS 84, so
// readGeoJSON reprojects it) plus notes. The libraries are passed in: the lazy js-fgb and js-parquet
// blocks in the app, the npm packages in unit tests.

/** Attribute values JSON and the store can hold: BigInt as a Number when exact, else as text; bytes as hex. */
function plain(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Uint8Array) return [...v.slice(0, 64)].map((b) => b.toString(16).padStart(2, '0')).join('') + (v.length > 64 ? '…' : '');
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

// Geometry the layer model holds: a Triangle with coordinates (ISO WKB) is its polygon ring; anything
// without a GeoJSON type or coordinates (flatgeobuf converts no Triangle, TIN or surface) is no geometry.
const fixGeom = (g) => {
  if (!g?.type || (g.type !== 'GeometryCollection' && !g.coordinates)) return null;
  return g.type === 'Triangle' ? { type: 'Polygon', coordinates: g.coordinates } : g;
};

const crsMember = (epsg) => (epsg && epsg !== 4326 && epsg !== 4979 ? { crs: { type: 'name', properties: { name: `EPSG:${epsg}` } } } : {});

/** FlatGeobuf (flatgeobuf deserialize, an async generator of features): features and header CRS (EPSG code). */
export async function readFgb(lib, bytes) {
  if (bytes.length < 12 || bytes[0] !== 0x66 || bytes[1] !== 0x67 || bytes[2] !== 0x62) throw new Error('not a FlatGeobuf file (no "fgb" magic bytes)');
  let header = null;
  const got = [];
  // As a stream: the byte-array path reads features in place, and a GDAL-written file whose features
  // are not 8-byte aligned throws ("start offset of Float64Array should be a multiple of 8"); the stream
  // path copies each feature into its own buffer.
  try {
    for await (const f of lib.deserialize(new Blob([bytes]).stream(), undefined, (h) => (header = h))) got.push(f);
  } catch (e) {
    if (/is not valid JSON|Unexpected token/.test(e.message)) throw new Error('a Json column holds text that is not JSON (written so by its producer)');
    throw new Error(`the FlatGeobuf file is not readable (${e.message})`);
  }
  const notes = [];
  const org = String(header?.crs?.org ?? 'EPSG').toUpperCase();
  const code = header?.crs?.code ?? 0;
  const epsg = org === 'EPSG' && code > 0 ? code : null;
  if (code > 0 && !epsg) notes.push(`CRS ${org}:${code} is not an EPSG code; coordinates taken as WGS 84`);
  if (!code) notes.push('no CRS in the header; coordinates taken as WGS 84');
  const features = got.map((f) => ({ type: 'Feature', geometry: fixGeom(f.geometry), properties: plain(f.properties ?? {}) }));
  if (!features.length) throw new Error('the FlatGeobuf file has no features');
  if (features.every((f) => !f.geometry)) throw new Error(`no geometry the reader converts (${[...new Set(got.map((f) => f.geometry?.type ?? 'none'))].join(', ')})`);
  return { fc: { type: 'FeatureCollection', features, ...crsMember(epsg) }, epsg, notes };
}

/**
 * The EPSG code of a CRS given as PROJJSON (object or JSON text), WKT2, "EPSG:n", "srid:n" or OGC:CRS84;
 * null (WGS 84) when absent. {epsg, note}: a note when the CRS is present but has no EPSG code.
 */
export function epsgOf(crs) {
  if (crs == null || crs === '') return { epsg: null };
  if (typeof crs === 'string') {
    const t = crs.trim();
    if (t.startsWith('{')) {
      try {
        return epsgOf(JSON.parse(t));
      } catch {
        return { epsg: null, note: 'CRS PROJJSON is not readable; coordinates taken as WGS 84' };
      }
    }
    if (/^(OGC:)?CRS84$/i.test(t)) return { epsg: 4326 };
    const m = /^(?:EPSG|srid):+(\d+)$/i.exec(t);
    if (m) return { epsg: Number(m[1]) || null };
    // WKT: the CRS's own ID is the last top-level ID[...] (inner ones name its parts).
    const ids = [...t.matchAll(/ID\["EPSG",\s*(\d+)\]/gi)];
    if (ids.length) return { epsg: Number(ids.at(-1)[1]) };
    if (/^GEOGCRS\["WGS 84"/.test(t)) return { epsg: 4326 };
    return { epsg: null, note: `CRS "${t.slice(0, 60)}" has no EPSG code; coordinates taken as WGS 84` };
  }
  const id = crs.id ?? crs.ids?.[0];
  if (id && String(id.authority).toUpperCase() === 'EPSG') return { epsg: Number(id.code) };
  if (id && /^OGC$/i.test(id.authority) && /CRS84/i.test(String(id.code))) return { epsg: 4326 };
  // PROJJSON without an id: WGS 84 / UTM zone nn N|S is common enough to name.
  const utm = /^WGS 84 \/ UTM zone (\d{1,2})([NS])$/.exec(crs.name ?? '');
  if (utm) return { epsg: (utm[2] === 'N' ? 32600 : 32700) + Number(utm[1]) };
  if (crs.type === 'GeographicCRS' && /^WGS 84$/.test(crs.name ?? '')) return { epsg: 4326 };
  return { epsg: null, note: `CRS "${crs.name ?? 'PROJJSON'}" has no EPSG code; coordinates taken as WGS 84` };
}

const GEOM_NAMES = ['geometry', 'geom', 'wkb_geometry', 'the_geom', 'shape', 'wkb'];
const CODECS = new Set(['UNCOMPRESSED', 'SNAPPY', 'GZIP']);

/** GeoParquet 1.0/1.1 with WKB geometry (hyparquet): features, CRS (EPSG from PROJJSON id) and notes. */
export async function readGeoParquet(lib, bytes, { gunzip = null } = {}) {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'PAR1' || String.fromCharCode(...bytes.subarray(bytes.length - 4)) !== 'PAR1') throw new Error('not a Parquet file (no PAR1 markers)');
  let meta;
  try {
    meta = lib.parquetMetadata(buf);
  } catch (e) {
    throw new Error(`the Parquet footer is not readable (${e.message})`);
  }
  const notes = [];
  const geoKv = meta.key_value_metadata?.find((k) => k.key === 'geo')?.value;
  const geo = geoKv ? JSON.parse(geoKv) : null;
  const leaf = meta.schema.slice(1).filter((s) => !s.num_children);
  const gcol = geo?.primary_column ?? leaf.find((s) => /^GEO(METRY|GRAPHY)$/.test(s.logical_type?.type ?? ''))?.name ?? leaf.find((s) => s.type === 'BYTE_ARRAY' && GEOM_NAMES.includes(String(s.name).toLowerCase()))?.name;
  if (!gcol) throw new Error('no geometry column: neither GeoParquet "geo" metadata nor a WKB column named geometry');
  if (!geo) notes.push(`no GeoParquet "geo" metadata; column "${gcol}" read as WKB`);
  const col = geo?.columns?.[gcol] ?? {};
  if (col.encoding && col.encoding !== 'WKB') throw new Error(`GeoParquet geometry encoding "${col.encoding}" (GeoArrow) is not read; WKB is`);
  const codecs = [...new Set(meta.row_groups.flatMap((g) => g.columns.map((c) => c.meta_data?.codec)).filter(Boolean))];
  const bad = codecs.filter((c) => !CODECS.has(c) && !(c === 'GZIP' && gunzip));
  if (bad.length) throw new Error(`Parquet pages compressed with ${bad.join(', ')} are not read (Snappy, GZIP and uncompressed are)`);
  // CRS: GeoParquet column metadata, else the Parquet GEOMETRY logical type of the column (a PROJJSON
  // string, "projjson:<key>" naming a key-value entry, "srid:<n>" or OGC:CRS84). Absent means OGC:CRS84.
  const lt = leaf.find((x) => x.name === gcol)?.logical_type;
  let crs = col.crs ?? lt?.crs ?? null;
  if (typeof crs === 'string' && /^projjson:/i.test(crs)) crs = meta.key_value_metadata?.find((k) => k.key === crs.slice(9))?.value ?? crs;
  const { epsg, note } = epsgOf(crs);
  if (note) notes.push(note);
  if (col.edges === 'spherical') notes.push('edges are spherical (geodesic); drawn as planar lines between vertices');
  // utf8: false keeps byte columns with no STRING annotation (WKB written without GeoParquet metadata) as bytes.
  const rows = await lib.parquetReadObjects({ file: buf, utf8: false, compressors: gunzip ? { GZIP: (input) => gunzip(input) } : undefined });
  const features = [];
  let skipped = 0;
  for (const r of rows) {
    const { [gcol]: g, ...props } = r;
    let geometry = g ?? null;
    if (geometry instanceof Uint8Array) geometry = lib.wkbToGeojson({ view: new DataView(geometry.buffer, geometry.byteOffset, geometry.byteLength), offset: 0 });
    geometry = fixGeom(geometry);
    if (!geometry) skipped++;
    features.push({ type: 'Feature', geometry, properties: plain(props) });
  }
  if (!features.length) throw new Error('the GeoParquet file has no rows');
  if (skipped) notes.push(`${skipped} row(s) with no geometry`);
  return { fc: { type: 'FeatureCollection', features, ...crsMember(epsg) }, epsg, notes };
}
