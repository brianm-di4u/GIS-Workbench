// 2.4 group svc: one local mock of every service kind the clients speak (REQ-GAP-04..07, 59, 63):
// WMS 1.3.0, WMTS (EPSG:4326 matrix set), ArcGIS MapServer (dynamic), ImageServer,
// VectorTileServer, FeatureServer (typed fields, domains, subtypes, multi-part, paging, applyEdits),
// SceneServer (I3S 1.7 node pages, geometry and attribute buffers), OGC API (Features with CQL2,
// Tiles, Maps, Coverages, Records, Processes sync and async, Part 4 create), WCS 2.0, WPS 2.0,
// SensorThings, STAC and WFS-T. Every request is recorded; PNGs, GeoTIFFs and MVT are generated.
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { PbfWriter } from 'pbf';

// ---------------------------------------------------------------- payloads
const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** An RGB PNG of w × h: a left-to-right ramp in red, a fixed green, blue from `seed` (so tiles differ). */
export function png(w, h, seed = 0) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + 3 * x;
      raw[o] = Math.round((255 * x) / Math.max(1, w - 1));
      raw[o + 1] = 128;
      raw[o + 2] = (seed * 37 + y) & 255;
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A single-band GeoTIFF in EPSG:4326 covering [w, s, e, n] at cols × rows. */
export async function geotiff([w, s, e, n], cols = 64, rows = 48) {
  const v = new Uint8Array(cols * rows).map((_, i) => (i % cols) * 3 + Math.floor(i / cols));
  return Buffer.from(await writeArrayBuffer(v, { width: cols, height: rows, ModelPixelScale: [(e - w) / cols, (n - s) / rows, 0], ModelTiepoint: [0, 0, 0, w, n, 0], GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1, GeogCitationGeoKey: 'WGS 84', BitsPerSample: [8], SampleFormat: [1], SamplesPerPixel: 1, PhotometricInterpretation: 1 }));
}
/** A Mapbox Vector Tile with one "water" layer: a square polygon over the tile's centre. */
export function mvt() {
  const pbf = new PbfWriter();
  const zz = (n) => (n << 1) ^ (n >> 31);
  pbf.writeMessage(3, (_, p) => {
    p.writeVarintField(15, 2);
    p.writeStringField(1, 'water');
    p.writeMessage(2, (__, f) => {
      f.writeVarintField(1, 1);
      f.writePackedVarint(2, [0, 0]);
      f.writeVarintField(3, 3);
      f.writePackedVarint(4, [9, zz(1024), zz(1024), 26, zz(2048), 0, 0, zz(2048), zz(-2048), 0, 15]);
    });
    p.writeStringField(3, 'class');
    p.writeMessage(4, (__, v) => v.writeStringField(1, 'lake'));
    p.writeVarintField(5, 4096);
  });
  return Buffer.from(pbf.finish());
}

// ---------------------------------------------------------------- documents
const WMS_CAPS = (o) => `<?xml version="1.0" encoding="UTF-8"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
<Service><Name>WMS</Name><Title>Mock WMS</Title></Service>
<Capability><Request>
<GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="${o}/wms?"/></Get></HTTP></DCPType></GetMap>
<GetFeatureInfo><Format>text/html</Format><Format>application/json</Format><DCPType><HTTP><Get><OnlineResource xlink:href="${o}/wms?"/></Get></HTTP></DCPType></GetFeatureInfo>
</Request>
<Layer><Title>Mock layers</Title><CRS>EPSG:4326</CRS><CRS>CRS:84</CRS>
 <EX_GeographicBoundingBox><westBoundLongitude>5</westBoundLongitude><eastBoundLongitude>12</eastBoundLongitude><southBoundLatitude>45</southBoundLatitude><northBoundLatitude>50</northBoundLatitude></EX_GeographicBoundingBox>
 <Layer queryable="1"><Name>roads</Name><Title>Roads</Title><CRS>EPSG:3857</CRS><Dimension name="time" units="ISO8601" default="2024-03-01">2024-01-01/2024-03-01/P1M</Dimension></Layer>
 <Layer queryable="0"><Name>utm</Name><Title>Grid in UTM</Title><CRS>EPSG:32632</CRS></Layer>
</Layer></Capability></WMS_Capabilities>`;
const WMTS_CAPS = (o) => `<?xml version="1.0"?><Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
<ows:ServiceIdentification><ows:Title>Mock WMTS</ows:Title></ows:ServiceIdentification><Contents>
<Layer><ows:Title>Relief</ows:Title><ows:Identifier>relief</ows:Identifier><Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
<Dimension><ows:Identifier>Time</ows:Identifier><Default>2024-05-01</Default><Value>2024-05-01</Value><Value>2024-04-01</Value></Dimension>
<TileMatrixSetLink><TileMatrixSet>crs84</TileMatrixSet></TileMatrixSetLink>
<ResourceURL format="image/png" resourceType="tile" template="${o}/wmts/relief/{Style}/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/></Layer>
<TileMatrixSet><ows:Identifier>crs84</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>
${Array.from({ length: 10 }, (_, z) => `<TileMatrix><ows:Identifier>${z}</ows:Identifier><ScaleDenominator>${279541132.0143589 / 2 ** z}</ScaleDenominator><TopLeftCorner>90 -180</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>${2 * 2 ** z}</MatrixWidth><MatrixHeight>${2 ** z}</MatrixHeight></TileMatrix>`).join('')}
</TileMatrixSet></Contents></Capabilities>`;

// FeatureServer layer: typed fields, a coded domain, a range domain, feature types (subtypes).
const UNITS_INFO = { currentVersion: 11.1, name: 'Units', type: 'Feature Layer', geometryType: 'esriGeometryPolygon', objectIdField: 'OBJECTID', maxRecordCount: 2, advancedQueryCapabilities: { supportsPagination: true }, capabilities: 'Query,Create,Update,Delete,Editing', typeIdField: 'KIND', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID', nullable: false, editable: false }, { name: 'NAME', type: 'esriFieldTypeString', length: 20, nullable: false, alias: 'Unit name' }, { name: 'KIND', type: 'esriFieldTypeSmallInteger' }, { name: 'STATUS', type: 'esriFieldTypeString', domain: { type: 'codedValue', name: 'Status', codedValues: [{ code: 'A', name: 'Active' }, { code: 'I', name: 'Inactive' }] } }, { name: 'STRENGTH', type: 'esriFieldTypeInteger', domain: { type: 'range', name: 'Pct', range: [0, 100] } }, { name: 'SEEN', type: 'esriFieldTypeDate' }, { name: 'SPEED', type: 'esriFieldTypeDouble' }], types: [{ id: 1, name: 'Infantry', domains: { STATUS: { type: 'inherited' } } }, { id: 2, name: 'Armour', domains: { STATUS: { type: 'codedValue', name: 'ArmourStatus', codedValues: [{ code: 'R', name: 'Reserve' }] } } }] };
const sq = (x, y, d) => [[x, y], [x, y + d], [x + d, y + d], [x + d, y], [x, y]]; // clockwise (Esri outer)
const hole = (x, y, d) => [[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]; // counter-clockwise (Esri hole)

// I3S: two leaf nodes, one feature each (a 30 m × 20 m box, 12 m tall at one, 25 m at the other).
const I3S_LAYOUT = { offset: 8, position: { type: 'Float32', component: 3 }, featureId: { type: 'UInt64', component: 1, binding: 'per-feature' }, faceRange: { type: 'UInt32', component: 2, binding: 'per-feature' } };
const I3S_NODES = [
  { index: 0, children: [1, 2], obb: { center: [8.5, 47.5, 50], halfSize: [200, 200, 50], quaternion: [0, 0, 0, 1] } },
  { index: 1, mesh: { geometry: { definition: 0, resource: 1 }, attribute: { resource: 1 } }, obb: { center: [8.5, 47.5, 400], halfSize: [20, 20, 10], quaternion: [0, 0, 0, 1] }, base: 400, top: 412, id: 101, name: 'Hall' },
  { index: 2, mesh: { geometry: { definition: 0, resource: 2 }, attribute: { resource: 2 } }, obb: { center: [8.501, 47.5005, 400], halfSize: [20, 20, 10], quaternion: [0, 0, 0, 1] }, base: 400, top: 425, id: 102, name: 'Tower' },
];
function i3sGeometry(n) {
  const dx = 30 / (111320 * Math.cos((47.5 * Math.PI) / 180));
  const dy = 20 / 111320;
  const c = n.obb.center;
  const z0 = n.base - c[2];
  const z1 = n.top - c[2];
  // Two triangles (base and top corners): enough vertices for the footprint and the heights.
  const v = [[0, 0, z0], [dx, 0, z0], [dx, dy, z1], [0, 0, z0], [dx, dy, z1], [0, dy, z1]];
  const b = Buffer.alloc(8 + v.length * 12 + 8 + 8);
  b.writeUInt32LE(v.length, 0);
  b.writeUInt32LE(1, 4);
  v.forEach((p, i) => p.forEach((x, k) => b.writeFloatLE(x, 8 + 12 * i + 4 * k)));
  let o = 8 + v.length * 12;
  b.writeUInt32LE(n.id, o);
  b.writeUInt32LE(0, o + 4);
  o += 8;
  b.writeUInt32LE(0, o);
  b.writeUInt32LE(1, o + 4);
  return b;
}
function i3sAttr(n, key) {
  if (key === 'f_0') {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(1, 0);
    b.writeInt32LE(n.id, 4);
    return b;
  }
  const s = Buffer.from(`${n.name}\0`, 'utf8');
  const b = Buffer.alloc(12);
  b.writeUInt32LE(1, 0);
  b.writeUInt32LE(s.length, 4);
  b.writeUInt32LE(s.length, 8);
  return Buffer.concat([b, s]);
}

const LAKES = Array.from({ length: 7 }, (_, i) => ({ type: 'Feature', id: `lake.${i + 1}`, properties: { name: `Lake ${i + 1}`, area: (i + 1) * 10 }, geometry: { type: 'Polygon', coordinates: [[[8 + i * 0.01, 47], [8.005 + i * 0.01, 47], [8.005 + i * 0.01, 47.005], [8 + i * 0.01, 47], [8 + i * 0.01, 47]]] } }));

const WPS_CAPS = `<wps:Capabilities xmlns:wps="http://www.opengis.net/wps/2.0" xmlns:ows="http://www.opengis.net/ows/2.0" service="WPS" version="2.0.0"><ows:ServiceIdentification><ows:Title>Mock WPS</ows:Title></ows:ServiceIdentification><wps:Contents><wps:ProcessSummary jobControlOptions="sync-execute"><ows:Title>Centroid</ows:Title><ows:Identifier>centroid</ows:Identifier></wps:ProcessSummary><wps:ProcessSummary jobControlOptions="async-execute"><ows:Title>Slow count</ows:Title><ows:Identifier>slow</ows:Identifier></wps:ProcessSummary></wps:Contents></wps:Capabilities>`;
const WPS_DESC = (id) => `<wps:ProcessOfferings xmlns:wps="http://www.opengis.net/wps/2.0" xmlns:ows="http://www.opengis.net/ows/2.0"><wps:ProcessOffering jobControlOptions="${id === 'slow' ? 'async-execute' : 'sync-execute'}"><wps:Process><ows:Title>${id}</ows:Title><ows:Identifier>${id}</ows:Identifier><wps:Input minOccurs="1"><ows:Title>Area</ows:Title><ows:Identifier>area</ows:Identifier><wps:BoundingBoxData><wps:Format mimeType="text/xml"/></wps:BoundingBoxData></wps:Input><wps:Output><ows:Identifier>result</ows:Identifier><wps:ComplexData><wps:Format mimeType="application/geo+json"/></wps:ComplexData></wps:Output></wps:Process></wps:ProcessOffering></wps:ProcessOfferings>`;

export function mockServices() {
  const seen = []; // {method, path, query, body}
  const state = { units: new Map(), nextOid: 10, applyEdits: [], ogcCreated: [], wfsInserts: [], jobs: new Map(), wpsJobs: new Map(), wfsXml: [] };
  // Units: five polygons; #3 has two outer rings and a hole (multi-part).
  for (let i = 1; i <= 5; i++) state.units.set(i, { attributes: { OBJECTID: i, NAME: `Unit ${i}`, KIND: i % 2 ? 1 : 2, STATUS: i % 2 ? 'A' : 'R', STRENGTH: 10 * i, SEEN: Date.UTC(2024, 0, i), SPEED: i * 1.5 }, geometry: { rings: i === 3 ? [sq(8, 47, 0.01), sq(8.02, 47, 0.01), hole(8.022, 47.002, 0.004)] : [sq(8 + i * 0.03, 47.1, 0.005)], spatialReference: { wkid: 4326 } } });
  let srv;
  let origin = '';
  const handler = async (req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, prefer, accept', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'location, content-type' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const u = new URL(req.url, origin);
    const q = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toUpperCase() === k ? k : k, v]));
    const Q = (k) => [...u.searchParams].find(([x]) => x.toLowerCase() === k.toLowerCase())?.[1] ?? null;
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, path: u.pathname, query: u.search, body });
    const send = (code, type, data, extra = {}) => {
      res.writeHead(code, { ...cors, 'content-type': type, ...extra });
      res.end(data);
    };
    const json = (o, code = 200, extra = {}) => send(code, 'application/json', JSON.stringify(o), extra);
    const xml = (s, code = 200) => send(code, 'application/xml', s);
    const p = u.pathname;
    try {
      // ---------------- WMS ----------------
      if (p === '/wms') {
        const r = (Q('REQUEST') ?? '').toLowerCase();
        if (r === 'getcapabilities') return xml(WMS_CAPS(origin));
        if (r === 'getmap') return send(200, 'image/png', png(Number(Q('WIDTH')), Number(Q('HEIGHT')), seen.length));
        if (r === 'getfeatureinfo') return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'roads.42', properties: { name: 'A1', i: Q('I'), j: Q('J'), crs: Q('CRS') } }] });
        return xml('<ServiceExceptionReport><ServiceException>bad request</ServiceException></ServiceExceptionReport>', 400);
      }
      // ---------------- WMTS ----------------
      if (p === '/wmts') return xml(WMTS_CAPS(origin));
      if (p.startsWith('/wmts/relief/')) return send(200, 'image/png', png(256, 256, seen.length));
      // ---------------- ArcGIS ----------------
      if (p === '/arcgis/rest/services/Map/MapServer') return json({ currentVersion: 11.1, mapName: 'Mock map', serviceDescription: '', copyrightText: 'Mock', layers: [{ id: 0, name: 'Roads' }], singleFusedMapCache: false });
      if (p === '/arcgis/rest/services/Map/MapServer/export') return send(200, 'image/png', png(...Q('size').split(',').map(Number), seen.length));
      if (p === '/arcgis/rest/services/Map/MapServer/identify') return json({ results: [{ layerId: 0, layerName: 'Roads', attributes: { NAME: 'Main', geometry: Q('geometry') } }] });
      if (p === '/arcgis/rest/services/Img/ImageServer') return json({ currentVersion: 11.1, name: 'Mock image', bandCount: 3, pixelType: 'U8' });
      if (p === '/arcgis/rest/services/Img/ImageServer/exportImage') return send(200, 'image/png', png(...Q('size').split(',').map(Number), seen.length));
      if (p === '/arcgis/rest/services/Img/ImageServer/identify') return json({ name: 'Pixel', value: '12, 34, 56', properties: { Values: ['12 34 56'] } });
      if (p === '/arcgis/rest/services/VT/VectorTileServer') return json({ currentVersion: 11.1, name: 'Mock tiles', capabilities: 'TilesOnly', type: 'indexedVector', tiles: ['tile/{z}/{y}/{x}.pbf'], defaultStyles: 'resources/styles', maxzoom: 14, tileInfo: { rows: 512, cols: 512, dpi: 96, origin: { x: -20037508.342787, y: 20037508.342787 }, spatialReference: { wkid: 102100, latestWkid: 3857 }, lods: Array.from({ length: 15 }, (_, i) => ({ level: i, resolution: 78271.51696399994 / 2 ** i, scale: 295828763.795777 / 2 ** i })) } });
      if (p.startsWith('/arcgis/rest/services/VT/VectorTileServer/tile/')) return send(200, 'application/x-protobuf', mvt());
      if (p === '/arcgis/rest/services/Units/FeatureServer') return json({ currentVersion: 11.1, layers: [{ id: 0, name: 'Units' }], tables: [] });
      if (p === '/arcgis/rest/services/Units/FeatureServer/0') return json(UNITS_INFO);
      if (p === '/arcgis/rest/services/Units/FeatureServer/0/query') {
        const all = [...state.units.values()].sort((a, b) => a.attributes.OBJECTID - b.attributes.OBJECTID);
        const off = Number(Q('resultOffset') ?? 0);
        const n = Math.min(Number(Q('resultRecordCount') ?? 2), UNITS_INFO.maxRecordCount);
        const page = all.slice(off, off + n);
        return json({ objectIdFieldName: 'OBJECTID', geometryType: 'esriGeometryPolygon', features: page, exceededTransferLimit: off + n < all.length });
      }
      if (p === '/arcgis/rest/services/Units/FeatureServer/0/applyEdits') {
        const b = new URLSearchParams(body);
        const adds = JSON.parse(b.get('adds') || '[]');
        const updates = JSON.parse(b.get('updates') || '[]');
        state.applyEdits.push({ adds, updates, deletes: b.get('deletes') || '' });
        const addResults = adds.map((a) => {
          const id = state.nextOid++;
          state.units.set(id, { attributes: { ...a.attributes, OBJECTID: id }, geometry: a.geometry });
          return { objectId: id, success: true };
        });
        const updateResults = updates.map((a) => {
          Object.assign(state.units.get(a.attributes.OBJECTID).attributes, a.attributes);
          return { objectId: a.attributes.OBJECTID, success: true };
        });
        return json({ addResults, updateResults, deleteResults: [] });
      }
      // Detections target: a point layer with CLASS (coded), CONFIDENCE and NOTE.
      if (p === '/arcgis/rest/services/Det/FeatureServer/0') return json({ currentVersion: 11.1, name: 'Detections', geometryType: 'esriGeometryPoint', objectIdField: 'OBJECTID', capabilities: 'Query,Create,Editing', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID', editable: false }, { name: 'CLASS', type: 'esriFieldTypeString', domain: { type: 'codedValue', codedValues: [{ code: 'vehicle', name: 'Vehicle' }, { code: 'ship', name: 'Ship' }] } }, { name: 'CONFIDENCE', type: 'esriFieldTypeDouble' }, { name: 'NOTE', type: 'esriFieldTypeString', length: 200 }] });
      if (p === '/arcgis/rest/services/Det/FeatureServer/0/applyEdits') {
        const adds = JSON.parse(new URLSearchParams(body).get('adds') || '[]');
        state.applyEdits.push({ target: 'det', adds });
        return json({ addResults: adds.map((_, i) => ({ objectId: 500 + i, success: true })) });
      }
      // ---------------- I3S ----------------
      if (p === '/arcgis/rest/services/Bldg/SceneServer') return json({ serviceName: 'Bldg', layers: [{ id: 0, name: 'Buildings', layerType: '3DObject' }] });
      if (p === '/arcgis/rest/services/Bldg/SceneServer/layers/0') return json({ id: 0, name: 'Buildings', layerType: '3DObject', version: '1.7', spatialReference: { wkid: 4326 }, fullExtent: { xmin: 8.49, ymin: 47.49, xmax: 8.51, ymax: 47.51, zmin: 400, zmax: 425 }, nodePages: { nodesPerPage: 2, lodSelectionMetricType: 'maxScreenThresholdSQ' }, geometryDefinitions: [{ geometryBuffers: [I3S_LAYOUT, { compressedAttributes: { encoding: 'draco', attributes: ['position'] } }] }], attributeStorageInfo: [{ key: 'f_0', name: 'OBJECTID', header: [{ property: 'count', valueType: 'UInt32' }], ordering: ['attributeValues'], attributeValues: { valueType: 'Int32', valuesPerElement: 1 } }, { key: 'f_1', name: 'NAME', header: [{ property: 'count', valueType: 'UInt32' }, { property: 'attributeValuesByteCount', valueType: 'UInt32' }], ordering: ['attributeByteCounts', 'attributeValues'], attributeByteCounts: { valueType: 'UInt32' }, attributeValues: { valueType: 'String', encoding: 'UTF-8' } }] });
      let m = /^\/arcgis\/rest\/services\/Bldg\/SceneServer\/layers\/0\/nodepages\/(\d+)$/.exec(p);
      if (m) return json({ nodes: I3S_NODES.slice(2 * m[1], 2 * m[1] + 2).map(({ base, top, id, name, ...n }) => n) });
      m = /^\/arcgis\/rest\/services\/Bldg\/SceneServer\/layers\/0\/nodes\/(\d+)\/geometries\/0$/.exec(p);
      if (m) return send(200, 'application/octet-stream', i3sGeometry(I3S_NODES[m[1]]));
      m = /^\/arcgis\/rest\/services\/Bldg\/SceneServer\/layers\/0\/nodes\/(\d+)\/attributes\/(f_\d)\/0$/.exec(p);
      if (m) return send(200, 'application/octet-stream', i3sAttr(I3S_NODES[m[1]], m[2]));
      // ---------------- OGC API ----------------
      const O = `${origin}/ogc`;
      if (p === '/ogc' || p === '/ogc/') return json({ title: 'Mock OGC API', links: [{ rel: 'conformance', href: `${O}/conformance` }, { rel: 'data', href: `${O}/collections` }, { rel: 'http://www.opengis.net/def/rel/ogc/1.0/processes', href: `${O}/processes` }] });
      if (p === '/ogc/conformance') return json({ conformsTo: ['http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-features-3/1.0/conf/filter', 'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text', 'http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete', 'http://www.opengis.net/spec/ogcapi-tiles-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-maps-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-coverages-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-records-1/1.0/conf/core', 'http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core'] });
      if (p === '/ogc/collections') {
        const off = Number(Q('offset') ?? 0);
        const cols = [
          { id: 'lakes', title: 'Lakes', itemType: 'feature', extent: { spatial: { bbox: [[8, 47, 8.1, 47.1]] } }, links: [{ rel: 'items', type: 'application/geo+json', href: `${O}/collections/lakes/items` }, { rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-map', href: `${O}/collections/lakes/tiles` }] },
          { id: 'world', title: 'World map', links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/map', href: `${O}/collections/world/map` }] },
          { id: 'dem', title: 'Elevation', links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/coverage', href: `${O}/collections/dem/coverage` }] },
          { id: 'meta', title: 'Catalogue', itemType: 'record', links: [{ rel: 'items', href: `${O}/collections/meta/items` }] },
        ];
        // Two collections per page: the collections list is paged too.
        return json({ collections: cols.slice(off, off + 2), links: off + 2 < cols.length ? [{ rel: 'next', href: `${O}/collections?offset=${off + 2}` }] : [] });
      }
      if (p === '/ogc/collections/lakes/items' && req.method === 'GET') {
        const off = Number(Q('offset') ?? 0);
        const lim = Math.min(3, Number(Q('limit') ?? 10)); // the server caps a page at 3
        const f = Q('filter');
        let feats = LAKES.concat(state.ogcCreated.map((x, i) => ({ ...x, id: `new.${i + 1}` })));
        const fm = /^name = '([^']*)'$/.exec(f ?? '');
        if (f && !fm && !/area > (\d+)/.test(f)) return json({ code: 'InvalidParameterValue', description: `bad filter ${f}` }, 400);
        if (fm) feats = feats.filter((x) => x.properties.name === fm[1]);
        const am = /area > (\d+)/.exec(f ?? '');
        if (am) feats = feats.filter((x) => x.properties.area > Number(am[1]));
        const page = feats.slice(off, off + lim);
        const next = off + lim < feats.length ? [{ rel: 'next', type: 'application/geo+json', href: `${O}/collections/lakes/items?offset=${off + lim}&limit=${lim}${f ? `&filter=${encodeURIComponent(f)}&filter-lang=cql2-text` : ''}` }] : [];
        return send(200, 'application/geo+json', JSON.stringify({ type: 'FeatureCollection', numberMatched: feats.length, numberReturned: page.length, features: page, links: next }));
      }
      if (p === '/ogc/collections/lakes/items' && req.method === 'POST') {
        state.ogcCreated.push(JSON.parse(body));
        return send(201, 'application/json', '{}', { location: `${O}/collections/lakes/items/new.${state.ogcCreated.length}` });
      }
      if (p === '/ogc/collections/lakes') return json({ id: 'lakes', links: [{ rel: 'items', type: 'application/geo+json', href: `${O}/collections/lakes/items` }] });
      if (p === '/ogc/collections/lakes/tiles') return json({ links: [{ rel: 'item', type: 'image/png', href: `${O}/collections/lakes/tiles/{tileMatrixSetId}/{tileMatrix}/{tileRow}/{tileCol}?f=png` }], tilesets: [{ title: 'lakes', tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad', dataType: 'map', links: [] }] });
      if (p.startsWith('/ogc/collections/lakes/tiles/WebMercatorQuad/')) return send(200, 'image/png', png(256, 256, seen.length));
      if (p === '/ogc/collections/world/map') return send(200, 'image/png', png(Number(Q('width')), Number(Q('height')), 3));
      if (p === '/ogc/collections/dem/coverage') {
        const b = (Q('bbox') ?? '8,47,8.1,47.1').split(',').map(Number);
        return send(200, 'image/tiff; application=geotiff', await geotiff(b));
      }
      if (p === '/ogc/collections/meta/items') return json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'r1', properties: { title: 'Ortho 2024', description: 'An orthophoto' }, geometry: null, links: [{ rel: 'enclosure', type: 'image/tiff; application=geotiff', href: `${origin}/files/ortho.tif` }] }], links: [] });
      if (p === '/ogc/processes') return json({ processes: [{ id: 'echo', title: 'Echo', jobControlOptions: ['sync-execute'] }, { id: 'slow', title: 'Slow', jobControlOptions: ['async-execute'] }] });
      m = /^\/ogc\/processes\/(echo|slow)$/.exec(p);
      if (m) return json({ id: m[1], title: m[1], jobControlOptions: [m[1] === 'echo' ? 'sync-execute' : 'async-execute'], inputs: { name: { title: 'Name', schema: { type: 'string' } }, n: { title: 'Count', schema: { type: 'integer' }, minOccurs: 0 } }, outputs: { echo: { schema: { type: 'object' } } }, links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/execute', href: `${O}/processes/${m[1]}/execution` }] });
      m = /^\/ogc\/processes\/(echo|slow)\/execution$/.exec(p);
      if (m) {
        const inp = JSON.parse(body).inputs;
        if (m[1] === 'echo') return json({ echo: { type: 'Feature', properties: { name: inp.name, n: inp.n ?? null }, geometry: { type: 'Point', coordinates: [8.5, 47.5] } } });
        const id = `job${state.jobs.size + 1}`;
        state.jobs.set(id, { polls: 0, inp });
        return send(201, 'application/json', JSON.stringify({ jobID: id, status: 'accepted' }), { location: `${O}/jobs/${id}` });
      }
      m = /^\/ogc\/jobs\/(job\d+)(\/results)?$/.exec(p);
      if (m) {
        const j = state.jobs.get(m[1]);
        if (m[2]) return json({ count: { value: j.inp.n * 2 } });
        j.polls++;
        return json({ jobID: m[1], status: j.polls >= 2 ? 'successful' : 'running', links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/results', href: `${O}/jobs/${m[1]}/results` }] });
      }
      // ---------------- WCS 2.0 ----------------
      if (p === '/wcs') {
        const r = (Q('REQUEST') ?? '').toLowerCase();
        if (r === 'getcapabilities') return xml(`<wcs:Capabilities xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.1"><ows:ServiceIdentification><ows:Title>Mock WCS</ows:Title></ows:ServiceIdentification><wcs:ServiceMetadata><wcs:formatSupported>image/tiff</wcs:formatSupported></wcs:ServiceMetadata><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>dem</wcs:CoverageId><wcs:CoverageSubtype>RectifiedGridCoverage</wcs:CoverageSubtype><ows:WGS84BoundingBox><ows:LowerCorner>5 45</ows:LowerCorner><ows:UpperCorner>12 50</ows:UpperCorner></ows:WGS84BoundingBox></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>`);
        if (r === 'describecoverage') return xml(`<wcs:CoverageDescriptions xmlns:wcs="http://www.opengis.net/wcs/2.0" xmlns:gml="http://www.opengis.net/gml/3.2"><wcs:CoverageDescription gml:id="dem"><gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326" axisLabels="Lat Long" srsDimension="2"><gml:lowerCorner>45 5</gml:lowerCorner><gml:upperCorner>50 12</gml:upperCorner></gml:Envelope></gml:boundedBy><wcs:CoverageId>dem</wcs:CoverageId></wcs:CoverageDescription></wcs:CoverageDescriptions>`);
        if (r === 'getcoverage') {
          const subs = u.searchParams.getAll('SUBSET');
          const long = /Long\(([^,]+),([^)]+)\)/.exec(subs.join(' '));
          const lat = /Lat\(([^,]+),([^)]+)\)/.exec(subs.join(' '));
          return send(200, 'image/tiff', await geotiff([Number(long[1]), Number(lat[1]), Number(long[2]), Number(lat[2])]));
        }
      }
      // ---------------- WPS 2.0 ----------------
      if (p === '/wps') {
        const r = (Q('REQUEST') ?? '').toLowerCase();
        if (r === 'getcapabilities') return xml(WPS_CAPS);
        if (r === 'describeprocess') return xml(WPS_DESC(Q('IDENTIFIER')));
        if (r === 'getstatus') {
          const j = state.wpsJobs.get(Q('JOBID'));
          j.polls++;
          return xml(`<wps:StatusInfo xmlns:wps="http://www.opengis.net/wps/2.0"><wps:JobID>${Q('JOBID')}</wps:JobID><wps:Status>${j.polls >= 2 ? 'Succeeded' : 'Running'}</wps:Status></wps:StatusInfo>`);
        }
        if (r === 'getresult') return xml(`<wps:Result xmlns:wps="http://www.opengis.net/wps/2.0"><wps:JobID>${Q('JOBID')}</wps:JobID><wps:Output id="result"><wps:Data mimeType="application/json">{"count":3}</wps:Data></wps:Output></wps:Result>`);
        if (req.method === 'POST') {
          state.wfsXml.push(body);
          const lc = /<ows:LowerCorner>([^<]+)<\/ows:LowerCorner><ows:UpperCorner>([^<]+)<\/ows:UpperCorner>/.exec(body);
          if (/mode="async"/.test(body)) {
            const id = `w${state.wpsJobs.size + 1}`;
            state.wpsJobs.set(id, { polls: 0 });
            return xml(`<wps:StatusInfo xmlns:wps="http://www.opengis.net/wps/2.0"><wps:JobID>${id}</wps:JobID><wps:Status>Accepted</wps:Status></wps:StatusInfo>`);
          }
          const [w, s] = lc[1].split(' ').map(Number);
          const [e, n] = lc[2].split(' ').map(Number);
          return xml(`<wps:Result xmlns:wps="http://www.opengis.net/wps/2.0"><wps:Output id="result"><wps:Data mimeType="application/geo+json">{"type":"Point","coordinates":[${(w + e) / 2},${(s + n) / 2}]}</wps:Data></wps:Output></wps:Result>`);
        }
      }
      // ---------------- SensorThings ----------------
      if (p === '/sta/v1.1' || p === '/sta/v1.1/') return json({ value: [{ name: 'Things', url: `${origin}/sta/v1.1/Things` }, { name: 'Datastreams', url: `${origin}/sta/v1.1/Datastreams` }] });
      if (p === '/sta/v1.1/Things') {
        const skip = Number(Q('$skip') ?? 0);
        const things = Array.from({ length: 5 }, (_, i) => ({ '@iot.id': i + 1, name: `Station ${i + 1}`, Locations: [{ '@iot.id': 100 + i, name: `Site ${i + 1}`, location: { type: 'Point', coordinates: [8 + i * 0.01, 47] } }], Datastreams: [{ '@iot.id': 200 + i, ObservedProperty: { name: 'temperature' }, unitOfMeasurement: { symbol: '°C' }, Observations: [{ result: 20 + i, phenomenonTime: '2024-06-01T12:00:00Z' }] }] }));
        const page = things.slice(skip, skip + 2);
        return json({ value: page, ...(skip + 2 < things.length ? { '@iot.nextLink': `${origin}/sta/v1.1/Things?$skip=${skip + 2}&$top=2` } : {}) });
      }
      // ---------------- STAC ----------------
      if (p === '/stac' || p === '/stac/') return json({ type: 'Catalog', id: 'mock', title: 'Mock STAC', stac_version: '1.0.0', conformsTo: ['https://api.stacspec.org/v1.0.0/item-search'], links: [{ rel: 'search', type: 'application/geo+json', href: `${origin}/stac/search`, method: 'POST' }, { rel: 'data', href: `${origin}/stac/collections` }] });
      if (p === '/stac/collections') return json({ collections: [{ id: 'ortho' }, { id: 'dem' }], links: [] });
      if (p === '/stac/search') {
        const b = JSON.parse(body || '{}');
        const start = b.token ? Number(b.token) : 0;
        const items = Array.from({ length: 5 }, (_, i) => ({ type: 'Feature', id: `item-${i + 1}`, collection: b.collections?.[0] ?? 'ortho', properties: { datetime: `2024-0${i + 1}-01T00:00:00Z` }, geometry: { type: 'Polygon', coordinates: [[[8, 47], [8.1, 47], [8.1, 47.1], [8, 47.1], [8, 47]]] }, assets: { visual: { href: `${origin}/files/item-${i + 1}.tif`, type: 'image/tiff; application=geotiff' } } }));
        const page = items.slice(start, start + 2);
        return send(200, 'application/geo+json', JSON.stringify({ type: 'FeatureCollection', features: page, links: start + 2 < items.length ? [{ rel: 'next', href: `${origin}/stac/search`, method: 'POST', body: { token: String(start + 2) }, merge: true }] : [] }));
      }
      // ---------------- WFS-T ----------------
      if (p === '/wfs') {
        if ((Q('REQUEST') ?? '').toLowerCase() === 'describefeaturetype') return xml(`<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2"><xsd:complexType name="detType"><xsd:complexContent><xsd:extension base="gml:AbstractFeatureType"><xsd:sequence><xsd:element name="class" type="xsd:string"/><xsd:element name="confidence" type="xsd:double"/><xsd:element name="the_geom" type="gml:PointPropertyType"/></xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType></xsd:schema>`);
        if (req.method === 'POST') {
          state.wfsInserts.push(body);
          const n = (body.match(/<test:det>/g) ?? []).length;
          return xml(`<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0"><wfs:InsertResults>${Array.from({ length: n }, (_, i) => `<wfs:Feature><fes:ResourceId rid="det.${i + 1}"/></wfs:Feature>`).join('')}</wfs:InsertResults></wfs:TransactionResponse>`);
        }
      }
      res.writeHead(404, cors);
      res.end();
    } catch (e) {
      send(500, 'text/plain', String(e?.stack ?? e));
    }
  };
  srv = createServer((req, res) => void handler(req, res));
  return {
    seen,
    state,
    start: () =>
      new Promise((r) =>
        srv.listen(0, '127.0.0.1', () => {
          origin = `http://127.0.0.1:${srv.address().port}`;
          r(origin);
        }),
      ),
    close: () => new Promise((r) => srv.close(r)),
    get origin() {
      return origin;
    },
  };
}
