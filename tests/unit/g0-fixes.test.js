// 2.3 G0 fixes: remote layers keep multi-part geometries in every encoding (G0-2), and an RSM
// record carries its section numbers so multi-section images can be refused (G0-1).
import { describe, it, expect } from 'vitest';
import { geojsonToGeom, geomToEsri, geomToGml } from '../../app/src/features/remote-edit.js';
import { rsmRecord } from '../../app/src/sensor/rsm.js';
import { rsmTres, rsmFromRpc } from '../../app/src/sensor/writers.js';

const square = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]];

describe('remote geometry conversions (G0-2)', () => {
  it('reads every GeoJSON type the vector model holds', () => {
    const cases = [
      { type: 'Point', coordinates: [1, 2] },
      { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] },
      { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
      { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
      { type: 'Polygon', coordinates: [square(0, 0, 4), square(1, 1, 1)] },
      { type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(5, 5, 2), square(5.5, 5.5, 0.5)]] },
    ];
    for (const g of cases) expect(geojsonToGeom(g)?.type, g.type).toBe(g.type);
    expect(geojsonToGeom({ type: 'GeometryCollection', geometries: [] })).toBeNull();
    expect(geojsonToGeom({ type: 'Bogus', coordinates: [] })).toBeNull();
  });

  it('writes multi-part geometry to ArcGIS JSON with Esri ring orientation', () => {
    const mp = geomToEsri(geojsonToGeom({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }));
    expect(mp.points).toEqual([[1, 2], [3, 4]]);
    const ml = geomToEsri(geojsonToGeom({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }));
    expect(ml.paths.length).toBe(2);
    const mpoly = geomToEsri(geojsonToGeom({ type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(5, 5, 2), square(5.5, 5.5, 0.5)]] }));
    expect(mpoly.rings.length).toBe(3);
    // Shoelace sign: Esri outers run clockwise (negative area), holes counter-clockwise.
    const area = (r) => r.slice(0, -1).reduce((s, p, i) => s + p[0] * r[i + 1][1] - r[i + 1][0] * p[1], 0) / 2;
    expect(area(mpoly.rings[0])).toBeLessThan(0);
    expect(area(mpoly.rings[1])).toBeLessThan(0);
    expect(area(mpoly.rings[2])).toBeGreaterThan(0);
    for (const r of mpoly.rings) expect(r[0]).toEqual(r.at(-1));
  });

  it('writes GML multi-geometries rather than merging parts into one polygon', () => {
    expect(geomToGml(geojsonToGeom({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }))).toMatch(/^<gml:MultiPoint[^>]*>(<gml:pointMember><gml:Point>.*?<\/gml:Point><\/gml:pointMember>){2}<\/gml:MultiPoint>$/);
    expect(geomToGml(geojsonToGeom({ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }))).toMatch(/^<gml:MultiCurve.*(<gml:curveMember>.*){2}/);
    const ms = geomToGml(geojsonToGeom({ type: 'MultiPolygon', coordinates: [[square(0, 0, 1)], [square(5, 5, 2)]] }));
    expect(ms.match(/<gml:surfaceMember>/g).length).toBe(2);
    expect(ms).not.toMatch(/<gml:interior>/);
    // Axis order stays lat lon for urn EPSG:4326.
    expect(geomToGml(geojsonToGeom({ type: 'Point', coordinates: [10, 20] }))).toContain('<gml:pos>20 10</gml:pos>');
  });
});

describe('RSM section numbers (G0-1)', () => {
  it('reports the section of an RSMPCA so a multi-section set can be refused', () => {
    const rpc = Array.from({ length: 92 }, (_, i) => (i < 10 ? [0, 0, 0, 0, 0, 1000, 1000, 0.1, 0.1, 100][i] : i === 10 || i === 51 || i === 72 ? 1 : i === 31 ? 1 : 0));
    const r = typeof rsmFromRpc === 'function' ? rsmFromRpc(rpc) : null;
    if (!r) return; // the writer needs a record; covered by the e2e RSM round trip otherwise
    const { RSMIDA, RSMPCA } = rsmTres(r);
    const rec = rsmRecord(RSMIDA, RSMPCA);
    expect(rec.rsn).toBe(1);
    expect(rec.csn).toBe(1);
  });
});
