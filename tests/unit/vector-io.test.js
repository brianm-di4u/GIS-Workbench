// Vector interchange (REQ-EXT-21/23, AC-17.2, AC-17.3): GeoJSON and Shapefile round trips keep
// count, geometry (1e-9°), Z, field types and UTF-8 text in Arabic, Cyrillic and CJK; Shapefile
// writes .prj/.cpg, Z types, shapefile ring order and a collision-safe field-name map; text is
// cut on a code-point boundary; GeoJSON has no "crs" member.
import { describe, it, expect } from 'vitest';
import { readGeoJSON, writeGeoJSON, writeShapefile, readShapefile, shapefileSets, dbfNames, utf8Cut } from '../../app/src/vector/io.js';
import { fromParts, parts, signedArea, setVertex, insertVertex, deleteVertex, toGeoJSON, fromGeoJSON } from '../../app/src/vector/geom.js';

const layer = () => ({
  name: 'fx12',
  fields: [
    { name: 'name_long_attribute', type: 'string' },
    { name: 'name_long_attribute2', type: 'string' },
    { name: 'height', type: 'number' },
    { name: 'floors', type: 'integer' },
    { name: 'ok', type: 'boolean' },
    { name: 'built', type: 'date' },
  ],
  features: [
    { geom: fromParts('Polygon', [[[10, 50, 100], [10.001, 50, 101], [10.001, 50.001, 102], [10, 50.001, 103]], [[10.0002, 50.0002, 100], [10.0002, 50.0004, 100], [10.0004, 50.0004, 100]]], [0]), attrs: { name_long_attribute: 'مبنى', name_long_attribute2: 'Здание', height: 12.5, floors: 3, ok: true, built: '1999-04-01' } },
    { geom: fromParts('MultiPolygon', [[[11, 51, 5], [11.001, 51, 5], [11.001, 51.001, 5]], [[12, 52, 7], [12.001, 52, 7], [12.001, 52.001, 7]]], [0, 1]), attrs: { name_long_attribute: '建筑物', name_long_attribute2: null, height: null, floors: 1, ok: false, built: null } },
  ],
  assets: {},
});

describe('geometry', () => {
  it('edits vertices and keeps part offsets', () => {
    let g = fromParts('Polygon', [[[0, 0, 0], [1, 0, 0], [1, 1, 0]], [[0.2, 0.2, 0], [0.4, 0.2, 0], [0.3, 0.4, 0]]], [0]);
    g = insertVertex(g, 0, 3, [0, 1, 0]);
    expect(g.parts).toEqual([0, 4]);
    g = setVertex(g, 1, [2, 0, 5]);
    expect(parts(g)[0][1]).toEqual([2, 0, 5]);
    g = deleteVertex(g, 3);
    expect(g.parts).toEqual([0, 3]);
    expect(() => deleteVertex(g, 0)).toThrow(/at least 3/);
  });
  it('writes RFC 7946 rings: closed, outer counter-clockwise, holes clockwise', () => {
    const gj = toGeoJSON(layer().features[0].geom);
    expect(gj.coordinates[0][0]).toEqual(gj.coordinates[0].at(-1));
    expect(signedArea(gj.coordinates[0].slice(0, -1))).toBeGreaterThan(0);
    expect(signedArea(gj.coordinates[1].slice(0, -1))).toBeLessThan(0);
    expect(fromGeoJSON(gj).parts).toEqual([0, 4]);
  });
});

describe('GeoJSON', () => {
  it('round-trips with no crs member (AC-17.3)', () => {
    const { text, report } = writeGeoJSON(layer());
    const j = JSON.parse(text);
    expect(j.crs).toBeUndefined();
    expect(j.x_workbench.vertical).toBe('EPSG:4979');
    expect(report.features_out).toBe(2);
    const back = readGeoJSON(text).layer;
    expect(back.features).toHaveLength(2);
    expect(back.features[0].attrs.name_long_attribute).toBe('مبنى');
    const a = parts(back.features[0].geom)[0].find((v) => v[0] === 10.001 && v[1] === 50.001);
    expect(a[2]).toBe(102);
  });
});

describe('Shapefile', () => {
  it('maps long names deterministically', () => {
    expect(dbfNames([{ name: 'name_long_attribute' }, { name: 'name_long_attribute2' }, { name: 'name_long_' }])).toEqual(['name_long_', 'name_lon_1', 'name_lon_2']);
  });
  it('cuts UTF-8 on a code-point boundary', () => {
    const [b, cut] = utf8Cut('ab建筑', 4);
    expect(cut).toBe(true);
    expect(new TextDecoder().decode(b)).toBe('ab');
  });
  it('writes Z types, .prj, .cpg and the field map; reads back the same (AC-17.2)', () => {
    const { files, report } = writeShapefile(layer());
    expect(Object.keys(files).sort()).toEqual(['fx12.cpg', 'fx12.dbf', 'fx12.prj', 'fx12.shp', 'fx12.shx', 'fx12_fieldnames.csv']);
    expect(new TextDecoder().decode(files['fx12.cpg'])).toBe('UTF-8');
    expect(new TextDecoder().decode(files['fx12.prj'])).toMatch(/^GEOGCS\["GCS_WGS_1984"/);
    const dv = new DataView(files['fx12.shp'].buffer);
    expect(dv.getInt32(0, false)).toBe(9994);
    expect(dv.getInt32(24, false) * 2).toBe(files['fx12.shp'].length);
    expect(dv.getInt32(32, true)).toBe(15); // PolygonZ
    expect(new DataView(files['fx12.shx'].buffer).getInt32(24, false) * 2).toBe(files['fx12.shx'].length);
    // Shapefile order: the first ring of record 1 is clockwise.
    const rec = 100 + 8;
    const n = dv.getInt32(rec + 40, true);
    const pts = [];
    const xy = rec + 44 + 4 * dv.getInt32(rec + 36, true);
    for (let i = 0; i < 5; i++) pts.push([dv.getFloat64(xy + 16 * i, true), dv.getFloat64(xy + 16 * i + 8, true)]);
    expect(n).toBe(9);
    expect(signedArea(pts.slice(0, 4))).toBeLessThan(0);
    expect(report.fields_renamed).toEqual([['name_long_attribute', 'name_long_'], ['name_long_attribute2', 'name_lon_1']]);
    const [set] = shapefileSets(files);
    const back = readShapefile(set).layer;
    expect(back.features).toHaveLength(2);
    expect(back.features[0].geom.type).toBe('Polygon');
    expect(back.features[0].geom.parts).toEqual([0, 4]);
    expect(back.features[1].geom.type).toBe('MultiPolygon');
    const ring = parts(back.features[0].geom)[0];
    expect(ring.some((v) => Math.abs(v[0] - 10.001) < 1e-12 && Math.abs(v[1] - 50.001) < 1e-12 && v[2] === 102)).toBe(true);
    const at = back.features[0].attrs;
    expect([at.name_long_, at.name_lon_1, at.height, at.floors, at.ok, at.built]).toEqual(['مبنى', 'Здание', 12.5, 3, true, '1999-04-01']);
    const b2 = back.features[1].attrs;
    expect([b2.name_long_, b2.name_lon_1, b2.height, b2.ok]).toEqual(['建筑物', null, null, false]);
    expect(back.fields.find((f) => f.name === 'floors').type).toBe('integer');
    expect(back.fields.find((f) => f.name === 'height').type).toBe('number');
  });
  it('splits mixed geometry families into separate files', () => {
    const l = layer();
    l.features.push({ geom: fromParts('Point', [[[1, 2, 3]]]), attrs: {} }, { geom: fromParts('LineString', [[[1, 2, 0], [3, 4, 0]]]), attrs: {} });
    const { files, report } = writeShapefile(l);
    expect(Object.keys(files).filter((k) => k.endsWith('.shp')).sort()).toEqual(['fx12_lines.shp', 'fx12_points.shp', 'fx12_polygons.shp']);
    expect(report.features_out).toBe(4);
    expect(report.by_geometry).toMatchObject({ PointZ: 1, PolyLine: 1, PolygonZ: 2 });
  });
});
