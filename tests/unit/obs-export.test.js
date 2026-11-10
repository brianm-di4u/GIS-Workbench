// OD-2.23 field tools: observations out as GeoJSON and KML/KMZ (vector/obs-export.js), each
// with its photos. Oracle: GDAL/OGR (ogrinfo) reads the GeoJSON, the KML and the KMZ back with the
// same positions and fields (skipped when GDAL is not on this machine); fflate reads the archives.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { observationsGeoJSON, observationsKml, observationsKmz, dataUrlBytes, photoPath, placed } from '../../app/src/vector/obs-export.js';
import { fitSize, PHOTO_MAX } from '../../app/src/features/field.js';

const GDAL = process.env.GW_GDAL_BIN ?? 'E:/gwb-sidecar-deps/osgeo4w/root/bin';
const haveGdal = existsSync(join(GDAL, 'ogrinfo.exe')) || existsSync(join(GDAL, 'ogrinfo'));
const gdalEnv = { ...process.env, PATH: `${GDAL}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`, GDAL_DATA: resolve(GDAL, '../apps/gdal/share/gdal'), PROJ_DATA: resolve(GDAL, '../share/proj'), PROJ_LIB: resolve(GDAL, '../share/proj') };
const ogrJson = (file) => JSON.parse(execFileSync(join(GDAL, 'ogrinfo'), ['-json', '-features', '-ro', file], { env: gdalEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
const TMP = join(tmpdir(), 'gw-obs-export');

// A 1×1 JPEG (the smallest valid baseline JPEG) as a data: URL.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

const OBS = [
  { id: 'o1', text: '(U) Two trucks at the gate & a <tent>', category: 'vehicle activity', confidence: 'high', time: '2026-11-03T10:15:00Z', lat: 36.123456789, lon: -115.17123456, h: 612.4, analyst: 'field-1', place: 'gps', photos: [{ name: 'gate.jpg', type: 'image/jpeg', data: JPEG }, { name: 'gate2.jpg', type: 'image/jpeg', data: JPEG }] },
  { id: 'o2', text: '(U) Café sign — ünïcödé ✓', category: 'infrastructure', confidence: 'moderate', created: '2026-11-03T11:00:00Z', lat: -33.8, lon: 151.2, photos: [] },
  { id: 'o3', text: '(U) No position', category: 'other', confidence: 'low', lat: null, lon: null },
];

describe('observations as GeoJSON', () => {
  it('writes RFC 7946 points (lon, lat, height) with the fields and the photos', () => {
    const g = observationsGeoJSON(OBS);
    expect(g.type).toBe('FeatureCollection');
    expect(g.features.length).toBe(2); // o3 has no position
    expect(g.features[0].geometry.coordinates).toEqual([-115.17123456, 36.123456789, 612.4]);
    expect(g.features[1].geometry.coordinates).toEqual([151.2, -33.8]);
    expect(g.features[0].properties).toMatchObject({ text: OBS[0].text, category: 'vehicle activity', confidence: 'high', time: '2026-11-03T10:15:00Z', analyst: 'field-1' });
    expect(g.features[0].properties.photos.map((p) => p.name)).toEqual(['gate.jpg', 'gate2.jpg']);
    expect(g.features[0].properties.photos[0].href).toBe(JPEG);
    expect(g.features[1].properties.time).toBe('2026-11-03T11:00:00Z'); // created when there is no time
    expect(observationsGeoJSON(OBS, { photos: false }).features[0].properties.photos[0].href).toBeUndefined();
    expect(placed(OBS).length).toBe(2);
  });

  it.skipIf(!haveGdal)('reads back in GDAL with the same positions and fields (oracle)', () => {
    mkdirSync(TMP, { recursive: true });
    const f = join(TMP, 'obs.geojson');
    writeFileSync(f, JSON.stringify(observationsGeoJSON(OBS)));
    const j = ogrJson(f);
    const fs = j.layers[0].features;
    expect(fs.length).toBe(2);
    expect(fs[0].geometry.coordinates[0]).toBeCloseTo(-115.17123456, 9);
    expect(fs[0].geometry.coordinates[1]).toBeCloseTo(36.123456789, 9);
    expect(fs[0].properties.text).toBe(OBS[0].text);
    expect(fs[1].properties.text).toBe(OBS[1].text);
  }, 60000);
});

describe('observations as KML and KMZ', () => {
  it('escapes text, keeps UTF-8 and writes lon,lat with 8 decimals', () => {
    const k = observationsKml(OBS);
    expect(k).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
    expect(k).toContain('<coordinates>-115.17123456,36.12345679</coordinates>');
    expect(k).toContain('Two trucks at the gate &amp; a &lt;tent&gt;');
    expect(k).toContain('Café sign — ünïcödé ✓');
    expect(k.match(/<Placemark /g).length).toBe(2);
    expect(k).toContain('<TimeStamp><when>2026-11-03T10:15:00Z</when></TimeStamp>');
    expect(k).not.toContain('<img'); // plain KML has no photo paths
  });

  it('a CDATA end inside the text cannot break out of the description', () => {
    const k = observationsKml([{ id: 'x', text: 'a ]]> <script>', category: 'other', lat: 1, lon: 2 }]);
    // The text is escaped before it goes into the CDATA section: the only ]]> is the section's own end.
    expect(k.match(/]]>/g).length).toBe(1);
    expect(k).toContain('a ]]&gt; &lt;script&gt;');
  });

  it('KMZ: doc.kml first-level, with the photos under files/ and referenced from the description', () => {
    const z = unzipSync(observationsKmz(OBS));
    expect(Object.keys(z).sort()).toEqual(['doc.kml', 'files/o1-1.jpg', 'files/o1-2.jpg']);
    const kml = strFromU8(z['doc.kml']);
    expect(kml).toContain('<img src="files/o1-1.jpg"');
    expect([...z['files/o1-1.jpg']]).toEqual([...dataUrlBytes(JPEG)]);
    expect(z['files/o1-1.jpg'][0]).toBe(0xff);
    expect(photoPath({ id: 'a b/c' }, 0, { type: 'image/png' })).toBe('files/a_b_c-1.png');
  });

  it.skipIf(!haveGdal)('GDAL reads the KML and the KMZ: two placemarks at the same places (oracle)', () => {
    mkdirSync(TMP, { recursive: true });
    for (const [name, bytes] of [['obs.kml', observationsKml(OBS)], ['obs.kmz', observationsKmz(OBS)]]) {
      const f = join(TMP, name);
      writeFileSync(f, bytes);
      const j = ogrJson(f);
      const fs = j.layers.flatMap((l) => l.features);
      expect(fs.length, name).toBe(2);
      const pts = fs.map((x) => x.geometry.coordinates);
      expect(pts[0][0]).toBeCloseTo(-115.17123456, 7);
      expect(pts[0][1]).toBeCloseTo(36.12345679, 7);
      expect(pts[1][0]).toBeCloseTo(151.2, 9);
      expect(pts[1][1]).toBeCloseTo(-33.8, 9);
    }
  }, 60000);
});

describe('the AOI, GRG cells and annotations in the export', () => {
  const SCENE = [
    { id: 'a1', kind: 'aoi', name: 'AOI', shape: 'polygon', coords: [[-115, 36, 0], [-114.99, 36, 0], [-114.99, 36.01, 0], [-115, 36.01, 0]] },
    { id: 'g1', kind: 'graphic', name: 'A1', shape: 'polygon', coords: [[-115, 36], [-114.999, 36], [-114.999, 36.001]] },
    { id: 'g2', kind: 'graphic', name: 'Rally <1>', shape: 'marker', coords: [[-114.995, 36.005, 610]] },
    { id: 'g3', kind: 'graphic', name: '', shape: 'arrow', coords: [[-115, 36], [-114.99, 36.01]] },
  ];
  it('GeoJSON: closed polygons, points and lines after the observations', () => {
    const g = observationsGeoJSON(OBS, { scene: SCENE });
    const extra = g.features.slice(placed(OBS).length);
    expect(extra.map((f) => f.geometry.type)).toEqual(['Polygon', 'Polygon', 'Point', 'LineString']);
    const ring = extra[0].geometry.coordinates[0];
    expect(ring.length).toBe(5);
    expect(ring[4]).toEqual(ring[0]);
    expect(extra[2].properties).toEqual({ kind: 'graphic', shape: 'marker', name: 'Rally <1>' });
    expect(observationsGeoJSON(OBS).features.length).toBe(placed(OBS).length);
  });
  it('KML: a closed ring, with names escaped', () => {
    const k = observationsKml([], { scene: SCENE });
    expect(k).toContain('<name>Rally &lt;1&gt;</name>');
    expect(k).toContain('<name>arrow</name>');
    expect(k).toContain('<coordinates>-115.000000000,36.000000000 -114.990000000,36.000000000 -114.990000000,36.010000000 -115.000000000,36.010000000 -115.000000000,36.000000000</coordinates>');
    expect(k).toContain('<LineString><coordinates>-115.000000000,36.000000000 -114.990000000,36.010000000</coordinates></LineString>');
  });
  it.skipIf(!haveGdal)('GDAL reads the same geometries back', () => {
    mkdirSync(TMP, { recursive: true });
    const f = join(TMP, 'scene.kml');
    writeFileSync(f, observationsKml([], { scene: SCENE }));
    const types = ogrJson(f).layers.flatMap((l) => l.features.map((x) => x.geometry.type));
    expect(types.sort()).toEqual(['LineString', 'Point', 'Polygon', 'Polygon']);
  });
});

describe('photo scaling', () => {
  it('fits the longer side to the limit and never upscales', () => {
    expect(fitSize(4032, 3024)).toEqual({ w: PHOTO_MAX, h: 1200 });
    expect(fitSize(3024, 4032)).toEqual({ w: 1200, h: PHOTO_MAX });
    expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitSize(1, 100000)).toEqual({ w: 1, h: PHOTO_MAX });
  });
});
