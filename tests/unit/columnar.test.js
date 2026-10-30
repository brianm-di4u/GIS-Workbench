// FlatGeobuf and GeoParquet readers (vector/columnar.js): what Convert writes reads back (features,
// geometry types, attributes, CRS), and files the reader cannot use are refused by name.
import { describe, it, expect } from 'vitest';
import { serialize, deserialize } from 'flatgeobuf/lib/mjs/geojson.js';
import { parquetWriteBuffer, geojsonToWkb } from 'hyparquet-writer';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { wkbToGeojson } from 'hyparquet/src/wkb.js';
import { gunzipSync } from 'fflate';
import { readFgb, readGeoParquet } from '../../app/src/vector/columnar.js';

const fc = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [-105.2, 39.7] }, properties: { name: 'a', n: 1 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-105, 39], [-104, 40]] }, properties: { name: 'b', n: 2 } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-105, 39], [-104, 39], [-104, 40], [-105, 39]]] }, properties: { name: 'c', n: 3 } },
  ],
};
const pq = { parquetMetadata, parquetReadObjects, wkbToGeojson };

describe('readFgb', () => {
  it('reads features, attributes and the EPSG code from the header', async () => {
    const r = await readFgb({ deserialize }, serialize(fc, 4326));
    expect(r.fc.features.map((f) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon']);
    expect(r.fc.features[2].properties).toEqual({ name: 'c', n: 3 });
    expect(r.epsg).toBe(4326);
    expect(r.fc.crs).toBeUndefined();
  });
  it('names a projected CRS so the layer is reprojected', async () => {
    const r = await readFgb({ deserialize }, serialize(fc, 32613));
    expect(r.fc.crs.properties.name).toBe('EPSG:32613');
  });
  it('refuses a file that is not FlatGeobuf', async () => {
    await expect(readFgb({ deserialize }, new Uint8Array(32))).rejects.toThrow(/not a FlatGeobuf file/);
  });
});

describe('readGeoParquet', () => {
  const write = (crs) => {
    const geo = { version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'WKB', geometry_types: [], ...(crs ? { crs } : {}) } } };
    return new Uint8Array(parquetWriteBuffer({ columnData: [{ name: 'geometry', data: fc.features.map((f) => geojsonToWkb(f.geometry)), type: 'BYTE_ARRAY' }, { name: 'name', data: fc.features.map((f) => f.properties.name), type: 'STRING' }], kvMetadata: [{ key: 'geo', value: JSON.stringify(geo) }] }));
  };
  it('reads WKB geometry and attributes (OGC:CRS84 when the CRS is absent)', async () => {
    const r = await readGeoParquet(pq, write(null), { gunzip: gunzipSync });
    expect(r.fc.features.map((f) => f.geometry.type)).toEqual(['Point', 'LineString', 'Polygon']);
    expect(r.fc.features[1].properties.name).toBe('b');
    expect(r.epsg).toBeNull();
    expect(r.fc.crs).toBeUndefined();
  });
  it('takes the EPSG code from a PROJJSON CRS', async () => {
    const r = await readGeoParquet(pq, write({ name: 'WGS 84 / UTM zone 13N', id: { authority: 'EPSG', code: 32613 } }));
    expect(r.fc.crs.properties.name).toBe('EPSG:32613');
  });
  it('refuses bytes that are not Parquet, and a non-WKB encoding', async () => {
    await expect(readGeoParquet(pq, new Uint8Array(40))).rejects.toThrow(/not a Parquet file/);
    const geo = { version: '1.1.0', primary_column: 'geometry', columns: { geometry: { encoding: 'point', geometry_types: [] } } };
    const b = new Uint8Array(parquetWriteBuffer({ columnData: [{ name: 'geometry', data: [new Uint8Array(4)], type: 'BYTE_ARRAY' }], kvMetadata: [{ key: 'geo', value: JSON.stringify(geo) }] }));
    await expect(readGeoParquet(pq, b)).rejects.toThrow(/encoding "point" \(GeoArrow\) is not read/);
  });
});

describe('FlatGeobuf cut short (TE 2.0.4 damaged-file pass)', () => {
  it('is refused by name before the library sees it', async () => {
    const magic = [0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x01];
    const bytes = new Uint8Array([...magic, 200, 0, 0, 0, ...new Array(30).fill(0)]); // header says 200 bytes; 42 in all
    await expect(readFgb({ deserialize: () => { throw new Error('must not be called'); } }, bytes)).rejects.toThrow(/cut short/);
  });
});
