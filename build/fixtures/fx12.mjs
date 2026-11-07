// FX-12 generator (Research/03 §1.1, SCN-17): the same vectors as GeoJSON (written here by hand,
// RFC 7946), Shapefile, KML and KMZ (written by the app's writers), with UTF-8 attributes in
// Arabic, Cyrillic and CJK, Z (HAE), a polygon with a hole, multi-part geometries, nulls, a long
// field name and a text longer than 254 bytes. GeoPackage joins with REQ-EXT-22 (R2).
// Dev-only. Usage: node build/fixtures/fx12.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import egmPkg from 'egm96-universal';
import { fromGeoJSON } from '../../app/src/vector/geom.js';
import { writeShapefile, writeKml } from '../../app/src/vector/io.js';

const { ellipsoidToEgm96 } = egmPkg;
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(process.argv[2] ?? join(root, 'fixtures'), 'fx12');
const LAT = 34.5;
const LON = -116.5;
const d = (e, n, h = 640) => [Number((LON + e * 1e-5).toFixed(9)), Number((LAT + n * 1e-5).toFixed(9)), h];
const ring = (pts) => [...pts, pts[0]];
const longText = 'سجل طويل '.repeat(30); // > 254 bytes of UTF-8

const features = [
  { name: 'مبنى الإدارة', geometry: { type: 'Polygon', coordinates: [ring([d(0, 0, 645), d(20, 0, 645), d(20, 15, 646), d(0, 15, 646)]), ring([d(5, 5, 645), d(5, 10, 645), d(10, 10, 645), d(10, 5, 645)])] }, props: { class_code: 'AL013', height_m: 12.5, floors: 3, verified: true, survey_date: '2026-03-15', long_description_text: longText } },
  { name: 'Склад', geometry: { type: 'Polygon', coordinates: [ring([d(40, 0, 641.25), d(60, 0, 641.25), d(60, 20, 641.25), d(40, 20, 641.25)])] }, props: { class_code: 'AL013', height_m: 6, floors: 1, verified: false, survey_date: null, long_description_text: 'Кириллица' } },
  { name: '仓库', geometry: { type: 'Polygon', coordinates: [ring([d(80, 0, 650), d(95, 0, 650), d(95, 12, 650), d(80, 12, 650)])] }, props: { class_code: 'AL013', height_m: null, floors: 2, verified: true, survey_date: '2025-11-30', long_description_text: '中文说明' } },
  { name: 'Twin block', geometry: { type: 'MultiPolygon', coordinates: [[ring([d(0, 40), d(10, 40), d(10, 50), d(0, 50)])], [ring([d(15, 40), d(25, 40), d(25, 50), d(15, 50)])]] }, props: { class_code: 'AL015', height_m: 4.75, floors: 1, verified: null, survey_date: '2026-01-02', long_description_text: null } },
  { name: 'طريق ١', geometry: { type: 'LineString', coordinates: [d(-20, -10, 638), d(50, -10, 639), d(120, -5, 640.5)] }, props: { class_code: 'AP030', height_m: null, floors: null, verified: true, survey_date: null, long_description_text: 'road' } },
  { name: 'Дорога 2', geometry: { type: 'LineString', coordinates: [d(-20, 70), d(30, 75), d(80, 70)] }, props: { class_code: 'AP030', height_m: null, floors: null, verified: false, survey_date: null, long_description_text: null } },
  { name: '河道', geometry: { type: 'MultiLineString', coordinates: [[d(100, 40, 630), d(110, 60, 629)], [d(110, 60, 629), d(130, 80, 628)]] }, props: { class_code: 'BH140', height_m: null, floors: null, verified: true, survey_date: '2024-07-04', long_description_text: '水' } },
  { name: 'برج', geometry: { type: 'Point', coordinates: d(30, 30, 660.125) }, props: { class_code: 'AL241', height_m: 35, floors: null, verified: true, survey_date: '2026-03-15', long_description_text: null } },
  { name: 'Мачта', geometry: { type: 'Point', coordinates: d(70, 30, 655) }, props: { class_code: 'AL241', height_m: 20, floors: null, verified: false, survey_date: null, long_description_text: null } },
  { name: '塔', geometry: { type: 'Point', coordinates: d(90, 30, 652) }, props: { class_code: 'AL241', height_m: 18.5, floors: null, verified: null, survey_date: null, long_description_text: null } },
  { name: 'Wells', geometry: { type: 'MultiPoint', coordinates: [d(-10, 20, 640), d(-12, 24, 640), d(-8, 26, 640)] }, props: { class_code: 'BH230', height_m: null, floors: null, verified: true, survey_date: '2025-05-05', long_description_text: null } },
];

const fields = [
  { name: 'class_code', type: 'string' },
  { name: 'height_m', type: 'number' },
  { name: 'floors', type: 'integer' },
  { name: 'verified', type: 'boolean' },
  { name: 'survey_date', type: 'date' },
  { name: 'long_description_text', type: 'string' },
];

mkdirSync(out, { recursive: true });
// GeoJSON by hand: RFC 7946, no "crs" member.
const gj = { type: 'FeatureCollection', name: 'fx12', features: features.map((f, i) => ({ type: 'Feature', id: i + 1, geometry: f.geometry, properties: { name: f.name, ...f.props } })) };
writeFileSync(join(out, 'fx12.geojson'), JSON.stringify(gj, null, 1));

const layer = { name: 'fx12', fields, features: features.map((f, i) => ({ geom: fromGeoJSON(f.geometry), attrs: { ...f.props }, name: f.name, description: `Feature ${i + 1}: ${f.props.class_code}`, style: f.geometry.type.includes('Point') ? { stroke: '#ffcc00', width: 2, fill: '#ffcc0080', icon: 'files/marker.png' } : { stroke: '#0050ff', width: 3, fill: '#0050ff40' } })), assets: {} };
const shp = writeShapefile(layer);
writeFileSync(join(out, 'fx12_shp.zip'), zipSync(shp.files));
const toMsl = (lat, lon, h) => ellipsoidToEgm96(lat, lon, h);
const kml = writeKml(layer, { toMsl });
writeFileSync(join(out, 'fx12.kml'), kml.text);
// A 1 × 1 PNG icon for the KMZ.
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(join(out, 'fx12.kmz'), zipSync({ 'doc.kml': strToU8(kml.text), 'files/marker.png': png }));

const byType = {};
for (const f of features) byType[f.geometry.type] = (byType[f.geometry.type] ?? 0) + 1;
writeFileSync(
  join(out, 'fx12_truth.json'),
  JSON.stringify({ fixture: 'FX-12', note: 'Coordinates WGS 84 lon/lat; Z = HAE. KML altitudes are EGM96 (egm96-universal). Shapefile sets are split by geometry family.', count: features.length, byType, fields, shapefile: { fieldsRenamed: shp.report.fields_renamed, textTruncated: shp.report.text_truncated, files: Object.keys(shp.files) }, features: gj.features }, null, 1),
);
console.log(`FX-12: ${features.length} features; shapefile renamed ${JSON.stringify(shp.report.fields_renamed)}, truncated ${JSON.stringify(shp.report.text_truncated)}`);
