// 2.4 group svc (REQ-GAP-04, 05, 06, 07, 59, 63): the protocol side of the service clients —
// capabilities parsers, request builders, paging, CQL2, Esri JSON and typed fields, I3S buffers.
import { describe, it, expect } from 'vitest';
import { parseXml, exceptionText, all, text } from '../../app/src/connectors/xml.js';
import * as OE from '../../app/src/connectors/ogc.js';
import * as OC from '../../app/src/connectors/ogc-clients.js';
import * as A from '../../app/src/connectors/arcgis.js';
import * as I from '../../app/src/connectors/i3s.js';
import { boxInCrs, auxXml, imageSize } from '../../app/src/connectors/service-image.js';

const O = { ...OE, ...OC };

const WMS130 = `<?xml version="1.0"?><WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
<Service><Title>Test &amp; maps</Title></Service>
<Capability><Request>
<GetMap><Format>image/jpeg</Format><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://maps.test/wms?map=a&amp;"/></Get></HTTP></DCPType></GetMap>
<GetFeatureInfo><Format>text/html</Format><Format>application/json</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://maps.test/wms?map=a&amp;"/></Get></HTTP></DCPType></GetFeatureInfo>
</Request>
<Layer><Title>Root</Title><CRS>EPSG:4326</CRS><CRS>EPSG:3857</CRS>
 <EX_GeographicBoundingBox><westBoundLongitude>-10</westBoundLongitude><eastBoundLongitude>10</eastBoundLongitude><southBoundLatitude>40</southBoundLatitude><northBoundLatitude>55</northBoundLatitude></EX_GeographicBoundingBox>
 <Style><Name>default</Name><Title>Default</Title></Style>
 <Layer queryable="1"><Name>roads</Name><Title>Roads</Title><CRS>EPSG:32631</CRS>
  <Dimension name="time" units="ISO8601" default="2024-01-03">2024-01-01/2024-01-03/P1D</Dimension>
 </Layer>
 <Layer><Name>water</Name><Title>Water</Title><Style><Name>blue</Name></Style></Layer>
</Layer></Capability></WMS_Capabilities>`;

const WMS111 = `<WMT_MS_Capabilities version="1.1.1"><Service><Title>Old</Title></Service><Capability><Request><GetMap><Format>image/png</Format></GetMap></Request>
<Layer><SRS>EPSG:4326</SRS><Layer><Name>a</Name><Title>A</Title><LatLonBoundingBox minx="1" miny="2" maxx="3" maxy="4"/><Extent name="time" default="2020">2019,2020</Extent></Layer></Layer></Capability></WMT_MS_Capabilities>`;

const WMTS = `<?xml version="1.0"?><Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
<ows:ServiceIdentification><ows:Title>Tiles</ows:Title></ows:ServiceIdentification>
<Contents>
 <Layer><ows:Title>Blue</ows:Title><ows:Identifier>blue</ows:Identifier>
  <ows:WGS84BoundingBox><ows:LowerCorner>-180 -90</ows:LowerCorner><ows:UpperCorner>180 90</ows:UpperCorner></ows:WGS84BoundingBox>
  <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format>
  <Dimension><ows:Identifier>Time</ows:Identifier><Default>2024-05-01</Default><Value>2024-05-01</Value><Value>2024-04-01</Value></Dimension>
  <TileMatrixSetLink><TileMatrixSet>crs84</TileMatrixSet></TileMatrixSetLink>
  <ResourceURL format="image/png" resourceType="tile" template="https://t.test/blue/{Style}/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/>
 </Layer>
 <TileMatrixSet><ows:Identifier>crs84</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>
  <TileMatrix><ows:Identifier>0</ows:Identifier><ScaleDenominator>279541132.0143589</ScaleDenominator><TopLeftCorner>90 -180</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>2</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
  <TileMatrix><ows:Identifier>1</ows:Identifier><ScaleDenominator>139770566.00717944</ScaleDenominator><TopLeftCorner>90 -180</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>4</MatrixWidth><MatrixHeight>2</MatrixHeight></TileMatrix>
 </TileMatrixSet>
</Contents></Capabilities>`;

describe('XML reader', () => {
  it('parses namespaces, attributes, entities, CDATA and self-closing tags', () => {
    const r = parseXml('<?xml version="1.0"?><!-- c --><a:Root xmlns:a="x" k="1 &lt; 2"><b>t&amp;u<![CDATA[<raw>]]></b><c/><d n=\'q\'>&#65;&#x42;</d></a:Root>');
    expect(r.name).toBe('Root');
    expect(r.attrs.k).toBe('1 < 2');
    expect(text(r, 'b')).toBe('t&u<raw>');
    expect(r.children.map((c) => c.name)).toEqual(['b', 'c', 'd']);
    expect(text(r, 'd')).toBe('AB');
  });
  it('refuses malformed XML and does not resolve entities beyond the five', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/malformed/);
    expect(() => parseXml('<a>')).toThrow(/not closed/);
    expect(text(parseXml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'))).toBe('&x;');
  });
  it('reads OWS and WMS exception reports', () => {
    expect(exceptionText('<ows:ExceptionReport xmlns:ows="o"><ows:Exception exceptionCode="InvalidParameterValue"><ows:ExceptionText>bad layer</ows:ExceptionText></ows:Exception></ows:ExceptionReport>')).toBe('bad layer');
    expect(exceptionText('<ServiceExceptionReport><ServiceException code="LayerNotDefined">no such layer</ServiceException></ServiceExceptionReport>')).toBe('no such layer');
    expect(exceptionText('<a>fine</a>')).toBe(null);
  });
});

describe('WMS', () => {
  it('parses 1.3.0 capabilities with inherited CRS, styles, box and TIME', () => {
    const c = O.parseWmsCapabilities(WMS130, 'https://maps.test/wms');
    expect(c.version).toBe('1.3.0');
    expect(c.title).toBe('Test & maps');
    expect(c.getMap).toBe('https://maps.test/wms?map=a&');
    expect(c.infoFormats).toEqual(['text/html', 'application/json']);
    const roads = c.layers.find((l) => l.name === 'roads');
    expect(roads.crs).toEqual(['EPSG:4326', 'EPSG:3857', 'EPSG:32631']);
    expect(roads.bbox).toEqual([-10, 40, 10, 55]);
    expect(roads.queryable).toBe(true);
    expect(roads.time.values).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    expect(roads.time.default).toBe('2024-01-03');
    expect(c.layers.find((l) => l.name === 'water').styles.map((s) => s.name)).toEqual(['default', 'blue']);
  });
  it('parses 1.1.1 capabilities (SRS, LatLonBoundingBox, Extent)', () => {
    const c = O.parseWmsCapabilities(WMS111);
    expect(c.layers[0]).toMatchObject({ name: 'a', crs: ['EPSG:4326'], bbox: [1, 2, 3, 4] });
    expect(c.layers[0].time.values).toEqual(['2019', '2020']);
  });
  it('writes the BBOX in the axis order of the version and CRS', () => {
    const s = { url: 'https://m.test/wms', layers: 'a,b', version: '1.3.0', time: '2024-01-02' };
    const u4326 = O.wmsGetMapUrl(s, { bbox: [-10, 40, 10, 55], crs: 'EPSG:4326', width: 512, height: 384 });
    expect(u4326).toMatch(/CRS=EPSG:4326&BBOX=40,-10,55,10&WIDTH=512&HEIGHT=384/);
    expect(u4326).toMatch(/LAYERS=a,b/);
    expect(u4326).toMatch(/TIME=2024-01-02/);
    expect(O.wmsGetMapUrl(s, { bbox: [-10, 40, 10, 55], crs: 'CRS:84' })).toMatch(/CRS=CRS:84&BBOX=-10,40,10,55/);
    expect(O.wmsGetMapUrl({ ...s, version: '1.1.1' }, { bbox: [-10, 40, 10, 55], crs: 'EPSG:4326' })).toMatch(/SRS=EPSG:4326&BBOX=-10,40,10,55/);
    const fi = O.wmsFeatureInfoUrl(s, { bbox: [0, 0, 1, 1], crs: 'EPSG:3857', i: 128, j: 64, infoFormat: 'application/json' });
    expect(fi).toMatch(/REQUEST=GetFeatureInfo/);
    expect(fi).toMatch(/QUERY_LAYERS=a,b/);
    expect(fi).toMatch(/I=128&J=64/);
  });
  it('reads GetFeatureInfo as GeoJSON, GML, MapServer GML and text', () => {
    expect(O.parseFeatureInfo('{"type":"FeatureCollection","features":[{"id":"roads.7","properties":{"name":"A1"}}]}', 'application/json')).toEqual([{ layer: 'roads', props: { name: 'A1' } }]);
    expect(O.parseFeatureInfo('<wfs:FeatureCollection xmlns:wfs="w" xmlns:gml="g"><gml:featureMember><roads><name>A2</name><lanes>2</lanes></roads></gml:featureMember></wfs:FeatureCollection>', 'application/vnd.ogc.gml')).toEqual([{ layer: 'roads', props: { name: 'A2', lanes: '2' } }]);
    expect(O.parseFeatureInfo('<msGMLOutput><roads_layer><roads_feature><name>A3</name></roads_feature></roads_layer></msGMLOutput>', 'text/xml')).toEqual([{ layer: 'roads', props: { name: 'A3' } }]);
    expect(O.parseFeatureInfo('<html><body><b>A4</b> lanes 2</body></html>', 'text/html')[0].props.text).toBe('A4 lanes 2');
    expect(O.pickInfoFormat(['text/html', 'text/plain', 'application/json'])).toBe('application/json');
  });
});

describe('WMTS and tile grids', () => {
  it('parses an EPSG:4326 tile matrix set with its latitude-first corner', () => {
    const c = O.parseWmtsCapabilities(WMTS);
    const g = c.tms.crs84;
    expect(g.epsg).toBe(4326);
    expect(g.levels[0]).toMatchObject({ id: '0', x0: -180, y0: 90, cols: 2, rows: 1 });
    // 279541132.0143589 × 0.28 mm / (metres per degree) = 0.703125° per pixel = 180° / 256.
    expect(g.levels[0].res).toBeCloseTo(180 / 256, 9);
    const { template } = O.wmtsTemplate(c, c.layers[0], { dims: { Time: '2024-04-01' } });
    expect(template).toBe('https://t.test/blue/default/2024-04-01/crs84/{TileMatrix}/{TileRow}/{TileCol}.png');
    expect(c.layers[0].dims[0].values).toEqual(['2024-05-01', '2024-04-01']);
  });
  it('maps tiles to boxes and boxes to tile ranges', () => {
    const g = O.geographicGrid(5);
    expect(O.tileBox(g.levels[1], 3, 1)).toEqual([90, -90, 180, 0]);
    expect(O.tileRange(g.levels[2], [-1, -1, 1, 1])).toEqual({ c0: 3, c1: 4, r0: 1, r1: 2 });
    const m = O.mercatorGrid(3);
    expect(O.tileBox(m.levels[1], 0, 0)[0]).toBeCloseTo(-20037508.342789244, 6);
    expect(O.isGoogleGrid(m)).toBe(true);
    expect(O.levelFor(m, 50000).id).toBe('2'); // the finest level at most a third finer than asked
    expect(O.levelFor(m, 70000).id).toBe('1');
    expect(O.mercLat(O.mercY(45))).toBeCloseTo(45, 10);
  });
  it('expands ISO 8601 time extents', () => {
    expect(O.expandTime('2020-01-15/2020-03-15/P1M')).toEqual(['2020-01-15', '2020-02-15', '2020-03-15']);
    expect(O.expandTime('2024-01-01T00:00:00Z/2024-01-01T02:00:00Z/PT1H')).toEqual(['2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z', '2024-01-01T02:00:00Z']);
    expect(O.expandTime('a,b, c')).toEqual(['a', 'b', 'c']);
    expect(O.expandTime('2000-01-01/2100-01-01/P1D', 10)).toHaveLength(10);
  });
});

describe('CRS names and URLs', () => {
  it('reads EPSG codes in every spelling', () => {
    expect(O.epsgOf('EPSG:4326')).toBe(4326);
    expect(O.epsgOf('urn:ogc:def:crs:EPSG::32633')).toBe(32633);
    expect(O.epsgOf('http://www.opengis.net/def/crs/EPSG/0/3857')).toBe(3857);
    expect(O.epsgOf('http://www.opengis.net/def/crs/OGC/1.3/CRS84')).toBe(4326);
    expect(O.epsgOf('EPSG:900913')).toBe(3857);
    expect(O.latFirst('EPSG:4326')).toBe(true);
    expect(O.latFirst('CRS:84')).toBe(false);
    expect(O.latFirst('EPSG:4326', '1.1.1')).toBe(false);
  });
  it('replaces query parameters case-insensitively', () => {
    expect(O.withParams('https://a.test/x?service=WMS&k=1', { SERVICE: 'WFS', n: 2 })).toBe('https://a.test/x?k=1&SERVICE=WFS&n=2');
    expect(O.withParams('https://a.test/x', { bbox: '1,2,3,4', skip: null })).toBe('https://a.test/x?bbox=1,2,3,4');
  });
});

describe('paging (REQ-GAP-04)', () => {
  it('collects every page, stops at max and on a repeated next link', async () => {
    const pages = { a: { items: [1, 2], next: 'b' }, b: { items: [3, 4], next: 'c' }, c: { items: [5], next: null } };
    const r = await O.collectPages(async (k) => pages[k], { first: 'a' });
    expect(r).toEqual({ items: [1, 2, 3, 4, 5], pages: 3, truncated: false });
    const m = await O.collectPages(async (k) => pages[k], { first: 'a', max: 3 });
    expect(m).toMatchObject({ items: [1, 2, 3], truncated: true });
    const loop = await O.collectPages(async () => ({ items: [1], next: 'same' }), { first: 'x' });
    expect(loop.pages).toBe(2);
    const ac = new AbortController();
    ac.abort();
    await expect(O.collectPages(async () => ({ items: [] }), { signal: ac.signal })).rejects.toThrow(/cancelled/);
  });
  it('pages an ArcGIS query by offset while exceededTransferLimit, and by object ids when the layer cannot page', async () => {
    const all = Array.from({ length: 2345 }, (_, i) => ({ attributes: { OBJECTID: i + 1 }, geometry: { x: i, y: 0 } }));
    const urls = [];
    const getJson = async (u) => {
      urls.push(u);
      const p = new URL(u).searchParams;
      if (p.get('returnIdsOnly')) return { objectIdFieldName: 'OBJECTID', objectIds: all.map((f) => f.attributes.OBJECTID).reverse() };
      if (p.get('objectIds')) {
        const ids = new Set(p.get('objectIds').split(',').map(Number));
        return { features: all.filter((f) => ids.has(f.attributes.OBJECTID)) };
      }
      const o = Number(p.get('resultOffset'));
      const n = Number(p.get('resultRecordCount'));
      return { features: all.slice(o, o + n), exceededTransferLimit: o + n < all.length };
    };
    const info = { objectIdField: 'OBJECTID', maxRecordCount: 1000, advancedQueryCapabilities: { supportsPagination: true } };
    const r = await A.queryAll(getJson, 'https://s.test/FeatureServer/0', info);
    expect(r.items).toHaveLength(2345);
    expect(r.pages).toBe(3);
    expect(new Set(r.items.map((f) => f.attributes.OBJECTID)).size).toBe(2345);
    expect(urls[0]).toMatch(/resultOffset=0&resultRecordCount=1000&orderByFields=OBJECTID/);
    urls.length = 0;
    const r2 = await A.queryAll(getJson, 'https://s.test/FeatureServer/0', { ...info, maxRecordCount: 500, advancedQueryCapabilities: { supportsPagination: false } });
    expect(r2.items).toHaveLength(2345);
    expect(r2.pages).toBe(5);
    expect(urls[0]).toMatch(/returnIdsOnly=true/);
    const r3 = await A.queryAll(getJson, 'https://s.test/FeatureServer/0', info, { max: 1500 });
    expect(r3).toMatchObject({ truncated: true });
    expect(r3.items).toHaveLength(1500);
  });
  it('follows OGC API and STAC next links', () => {
    expect(O.nextLink({ links: [{ rel: 'next', href: 'items?offset=10' }] }, 'https://a.test/c/x/items?limit=10')).toEqual({ href: 'https://a.test/c/x/items?offset=10', method: 'GET', body: null, merge: false });
    expect(O.nextLink({ links: [{ rel: 'next', href: 'https://a.test/search', method: 'POST', body: { token: 't2' }, merge: true }] })).toMatchObject({ method: 'POST', merge: true, body: { token: 't2' } });
    expect(O.nextLink({ links: [] })).toBe(null);
  });
  it('checks a STAC landing page for item search', () => {
    const l = O.stacLanding({ type: 'Catalog', stac_version: '1.0.0', title: 'My STAC', links: [{ rel: 'search', href: '/v1/search', method: 'POST' }, { rel: 'data', href: '/v1/collections' }] }, 'https://stac.test/v1');
    expect(l).toEqual({ title: 'My STAC', search: 'https://stac.test/v1/search', searchPost: true, collections: 'https://stac.test/v1/collections' });
    expect(() => O.stacLanding({ type: 'Catalog', stac_version: '1.0.0', links: [] }, 'https://s.test')).toThrow(/static STAC/);
    expect(() => O.stacLanding({ hello: 1 }, 'https://s.test')).toThrow(/not a STAC API/);
  });
});

describe('OGC API (REQ-GAP-06)', () => {
  it('reads conformance and what a collection offers', () => {
    const c = O.conformance(['http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core', 'http://www.opengis.net/spec/cql2/1.0/conf/cql2-text', 'http://www.opengis.net/spec/ogcapi-processes-1/1.0/conf/core']);
    expect(c).toMatchObject({ features: true, filter: true, processes: true, tiles: false, create: false });
    expect(O.collectionOffers({ itemType: 'feature', links: [{ rel: 'items' }, { rel: 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector' }] })).toMatchObject({ features: true, tiles: true, map: false });
    expect(O.collectionOffers({ itemType: 'record', links: [{ rel: 'items' }] })).toMatchObject({ records: true, features: false });
    expect(O.collectionOffers({ links: [{ rel: 'http://www.opengis.net/def/rel/ogc/1.0/coverage' }, { rel: 'http://www.opengis.net/def/rel/ogc/1.0/map' }] })).toMatchObject({ coverage: true, map: true });
  });
  it('builds items URLs with bbox, limit and a CQL2 filter', () => {
    const u = O.itemsUrl({ id: 'lakes', links: [{ rel: 'items', type: 'application/geo+json', href: 'https://o.test/collections/lakes/items' }] }, { bbox: [-10, 40, 10, 55], limit: 100, filter: "name LIKE 'L%'" });
    expect(u).toBe("https://o.test/collections/lakes/items?f=json&limit=100&bbox=-10,40,10,55&filter=name%20LIKE%20'L%25'&filter-lang=cql2-text");
  });
  it('writes CQL2 text and JSON and checks typed text', () => {
    const conds = [{ prop: 'name', op: 'like', value: 'A%' }, { prop: 'pop', op: '>', value: '1000' }, { prop: 'kind', op: 'in', value: 'a, b' }, { prop: 'h', op: 'between', value: '1..5' }, { prop: 'my field', op: '=', value: "O'Neil" }];
    expect(O.cql2Text(conds, { bbox: [0, 1, 2, 3] })).toBe(`name LIKE 'A%' AND pop > 1000 AND kind IN ('a', 'b') AND h BETWEEN 1 AND 5 AND "my field" = 'O''Neil' AND S_INTERSECTS(geometry, BBOX(0, 1, 2, 3))`);
    expect(O.cql2Json([{ prop: 'pop', op: '>=', value: 5 }])).toEqual({ op: '>=', args: [{ property: 'pop' }, 5] });
    expect(O.cql2Json(conds.slice(0, 2)).op).toBe('and');
    expect(O.checkCql2("name = 'a'")).toBe(null);
    expect(O.checkCql2("S_INTERSECTS(geometry, BBOX(0,0,1,1))")).toBe(null);
    expect(O.checkCql2("name = 'a")?.code).toBe('E_CQL2_SYNTAX');
    expect(O.checkCql2('(a = 1')?.code).toBe('E_CQL2_SYNTAX');
    expect(O.checkCql2('a = 1; drop')?.code).toBe('E_CQL2_SYNTAX');
    expect(O.checkCql2('hello')?.code).toBe('E_CQL2_SYNTAX');
    expect(() => O.cql2Text([{ prop: 'a', op: '~', value: 1 }])).toThrow(/operator/);
  });
  it('finds a tileset template, maps and coverage URLs', () => {
    const t = O.ogcTileTemplate({ dataType: 'vector', tileMatrixSetURI: 'http://www.opengis.net/def/tilematrixset/OGC/1.0/WebMercatorQuad', links: [{ rel: 'item', type: 'application/vnd.mapbox-vector-tile', href: 'https://o.test/collections/l/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=mvt' }] });
    expect(t).toEqual({ template: 'https://o.test/collections/l/tiles/WebMercatorQuad/{tileMatrix}/{tileRow}/{tileCol}?f=mvt', vector: true, tms: 'WebMercatorQuad' });
    expect(O.ogcMapUrl('https://o.test/collections/w/map', { bbox: [0, 0, 10, 10], crs: 'EPSG:3857', width: 256, height: 256 })).toBe('https://o.test/collections/w/map?f=png&bbox=0,0,10,10&bbox-crs=http://www.opengis.net/def/crs/EPSG/0/3857&crs=http://www.opengis.net/def/crs/EPSG/0/3857&width=256&height=256&transparent=true');
    expect(O.ogcCoverageUrl('https://o.test/collections/d/coverage?f=json', { bbox: [1, 2, 3, 4] })).toBe('https://o.test/collections/d/coverage?f=GTiff&bbox=1,2,3,4');
  });
  it('types process inputs and builds the execute body', () => {
    const d = { inputs: { name: { title: 'Name', schema: { type: 'string' } }, n: { schema: { type: 'integer' }, minOccurs: 0 }, area: { schema: { format: 'geojson-geometry' } } } };
    const ins = O.processInputs(d);
    expect(ins.map((i) => [i.id, i.type, i.required])).toEqual([['name', 'string', true], ['n', 'integer', false], ['area', 'geometry', true]]);
    expect(O.processExecuteBody(d, { name: 'x', n: '3', area: '{"type":"Point","coordinates":[1,2]}' })).toEqual({ inputs: { name: 'x', n: 3, area: { type: 'Point', coordinates: [1, 2] } } });
    expect(() => O.processExecuteBody(d, { n: 1 })).toThrow(/required/);
  });
});

describe('WCS 2.0, WPS 2.0, SensorThings (REQ-GAP-06)', () => {
  it('parses WCS capabilities and DescribeCoverage, and subsets with the axis labels', () => {
    const caps = O.parseWcsCapabilities(`<wcs:Capabilities xmlns:wcs="w" xmlns:ows="o" version="2.0.1"><ows:ServiceIdentification><ows:Title>Cov</ows:Title></ows:ServiceIdentification><wcs:ServiceMetadata><wcs:formatSupported>image/tiff</wcs:formatSupported></wcs:ServiceMetadata><wcs:Contents><wcs:CoverageSummary><wcs:CoverageId>dem</wcs:CoverageId><wcs:CoverageSubtype>RectifiedGridCoverage</wcs:CoverageSubtype><ows:WGS84BoundingBox><ows:LowerCorner>5 45</ows:LowerCorner><ows:UpperCorner>6 46</ows:UpperCorner></ows:WGS84BoundingBox></wcs:CoverageSummary></wcs:Contents></wcs:Capabilities>`);
    expect(caps).toMatchObject({ title: 'Cov', formats: ['image/tiff'], coverages: [{ id: 'dem', bbox: [5, 45, 6, 46] }] });
    const d = O.parseWcsDescribe(`<wcs:CoverageDescriptions xmlns:wcs="w" xmlns:gml="g"><wcs:CoverageDescription gml:id="dem"><gml:boundedBy><gml:Envelope srsName="http://www.opengis.net/def/crs/EPSG/0/4326" axisLabels="Lat Long" uomLabels="deg deg" srsDimension="2"><gml:lowerCorner>45 5</gml:lowerCorner><gml:upperCorner>46 6</gml:upperCorner></gml:Envelope></gml:boundedBy><gml:domainSet><gml:RectifiedGrid><gml:limits><gml:GridEnvelope><gml:low>0 0</gml:low><gml:high>99 199</gml:high></gml:GridEnvelope></gml:limits></gml:RectifiedGrid></gml:domainSet><wcs:ServiceParameters><wcs:nativeFormat>image/tiff</wcs:nativeFormat></wcs:ServiceParameters></wcs:CoverageDescription></wcs:CoverageDescriptions>`);
    expect(d).toMatchObject({ id: 'dem', epsg: 4326, axes: ['Lat', 'Long'], size: [100, 200], nativeFormat: 'image/tiff' });
    const u = O.wcsGetCoverageUrl('https://w.test/wcs', d, { bbox: [5.1, 45.2, 5.3, 45.4] });
    expect(decodeURIComponent(u)).toBe('https://w.test/wcs?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=dem&FORMAT=image/tiff&SUBSET=Long(5.1,5.3)&SUBSET=Lat(45.2,45.4)');
  });
  it('parses WPS 2.0 capabilities, DescribeProcess and results, and writes Execute', () => {
    const caps = O.parseWpsCapabilities(`<wps:Capabilities xmlns:wps="w" xmlns:ows="o" version="2.0.0"><wps:Contents><wps:ProcessSummary jobControlOptions="sync-execute async-execute"><ows:Title>Buffer</ows:Title><ows:Identifier>buffer</ows:Identifier></wps:ProcessSummary></wps:Contents></wps:Capabilities>`);
    expect(caps.processes).toEqual([{ id: 'buffer', title: 'Buffer', abstract: '', sync: true, async: true }]);
    const d = O.parseWpsDescribe(`<wps:ProcessOfferings xmlns:wps="w" xmlns:ows="o"><wps:ProcessOffering jobControlOptions="sync-execute"><wps:Process><ows:Title>Buffer</ows:Title><ows:Identifier>buffer</ows:Identifier><wps:Input minOccurs="1"><ows:Title>Distance</ows:Title><ows:Identifier>d</ows:Identifier><ns:LiteralData xmlns:ns="w"><wps:Format mimeType="text/plain"/><LiteralDataDomain><ows:AnyValue/><ows:DataType ows:reference="double">double</ows:DataType></LiteralDataDomain></ns:LiteralData></wps:Input><wps:Input minOccurs="1"><ows:Identifier>geom</ows:Identifier><ns:ComplexData xmlns:ns="w"><wps:Format mimeType="application/geo+json"/></ns:ComplexData></wps:Input><wps:Output><ows:Identifier>out</ows:Identifier><ns:ComplexData xmlns:ns="w"><wps:Format mimeType="application/geo+json"/></ns:ComplexData></wps:Output></wps:Process></wps:ProcessOffering></wps:ProcessOfferings>`);
    expect(d.inputs.map((i) => [i.id, i.kind, i.dataType])).toEqual([['d', 'literal', 'double'], ['geom', 'complex', null]]);
    const x = O.wpsExecuteXml(d, { d: '10', geom: { type: 'Point', coordinates: [1, 2] } });
    expect(x).toMatch(/<wps:Input id="d"><wps:Data>10<\/wps:Data><\/wps:Input>/);
    expect(x).toMatch(/<wps:Data mimeType="application\/geo\+json"><!\[CDATA\[\{"type":"Point","coordinates":\[1,2\]\}\]\]><\/wps:Data>/);
    expect(x).toMatch(/mode="sync"/);
    expect(parseXml(x).name).toBe('Execute');
    expect(() => O.wpsExecuteXml(d, { d: 1 })).toThrow(/required/);
    const res = O.parseWpsResponse(`<wps:Result xmlns:wps="w"><wps:JobID>j1</wps:JobID><wps:Output id="out"><wps:Data mimeType="application/geo+json">{"type":"Point","coordinates":[3,4]}</wps:Data></wps:Output></wps:Result>`);
    expect(res.outputs[0].json).toEqual({ type: 'Point', coordinates: [3, 4] });
    expect(O.parseWpsResponse('<wps:StatusInfo xmlns:wps="w"><wps:JobID>j2</wps:JobID><wps:Status>Running</wps:Status><wps:PercentCompleted>40</wps:PercentCompleted></wps:StatusInfo>')).toMatchObject({ status: 'Running', jobId: 'j2', progress: 40 });
  });
  it('queries SensorThings Things and turns them into point features with the latest value', () => {
    const u = O.staThingsUrl('https://st.test/v1.1', { top: 50, bbox: [1, 2, 3, 4] });
    expect(decodeURIComponent(u)).toMatch(/^https:\/\/st\.test\/v1\.1\/Things\?\$top=50&\$expand=Locations,Datastreams\(\$expand=Observations\(\$top=1;\$orderby=phenomenonTime desc\),ObservedProperty\)/);
    expect(decodeURIComponent(u)).toMatch(/st_intersects\(Locations\/location, geography'POLYGON\(\(1 2, 3 2, 3 4, 1 4, 1 2\)\)'\)/);
    const f = O.staToFeatures([{ '@iot.id': 7, name: 'Station', Locations: [{ '@iot.id': 1, name: 'here', location: { type: 'Point', coordinates: [8, 50] } }], Datastreams: [{ '@iot.id': 3, ObservedProperty: { name: 'temperature' }, unitOfMeasurement: { symbol: '°C' }, Observations: [{ result: 21.5, phenomenonTime: '2024-01-01T00:00:00Z' }] }] }]);
    expect(f).toEqual([{ type: 'Feature', id: '7/1', properties: { thing: 'Station', thingId: 7, description: '', temperature: 21.5, 'temperature time': '2024-01-01T00:00:00Z', 'temperature unit': '°C', location: 'here' }, geometry: { type: 'Point', coordinates: [8, 50] } }]);
  });
});

describe('ArcGIS REST (REQ-GAP-05, REQ-GAP-63)', () => {
  it('turns Esri rings into a MultiPolygon with each hole in its own outer ring', () => {
    // Two clockwise outers; a counter-clockwise hole inside the second.
    const g = A.esriToGeoJSON({ rings: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]], [[10, 0], [10, 4], [14, 4], [14, 0], [10, 0]], [[11, 1], [13, 1], [13, 3], [11, 3], [11, 1]]] });
    expect(g.type).toBe('MultiPolygon');
    expect(g.coordinates).toHaveLength(2);
    expect(g.coordinates[0]).toHaveLength(1);
    expect(g.coordinates[1]).toHaveLength(2);
    const area = (r) => r.reduce((a, p, i) => a + (p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1]), 0) / 2;
    expect(area(g.coordinates[1][0])).toBeGreaterThan(0); // GeoJSON outer counter-clockwise
    expect(area(g.coordinates[1][1])).toBeLessThan(0); // hole clockwise
    expect(A.esriToGeoJSON({ paths: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }).type).toBe('MultiLineString');
    expect(A.esriToGeoJSON({ points: [[0, 0, 5], [1, 1, 6]], hasZ: true })).toEqual({ type: 'MultiPoint', coordinates: [[0, 0, 5], [1, 1, 6]] });
    expect(A.esriToGeoJSON({ x: 1, y: 2 })).toEqual({ type: 'Point', coordinates: [1, 2] });
  });
  const INFO = {
    name: 'Units',
    objectIdField: 'objectid',
    globalIdField: 'globalid',
    typeIdField: 'kind',
    fields: [
      { name: 'objectid', type: 'esriFieldTypeOID', nullable: false, editable: false },
      { name: 'globalid', type: 'esriFieldTypeGlobalID', nullable: false, editable: false },
      { name: 'name', type: 'esriFieldTypeString', alias: 'Unit name', length: 8, nullable: false },
      { name: 'kind', type: 'esriFieldTypeSmallInteger' },
      { name: 'status', type: 'esriFieldTypeString', domain: { type: 'codedValue', name: 'st', codedValues: [{ code: 'A', name: 'Active' }, { code: 'I', name: 'Inactive' }] } },
      { name: 'strength', type: 'esriFieldTypeInteger', domain: { type: 'range', range: [0, 100] } },
      { name: 'seen', type: 'esriFieldTypeDate' },
      { name: 'speed', type: 'esriFieldTypeDouble' },
    ],
    types: [
      { id: 1, name: 'Infantry', domains: { status: { type: 'inherited' } } },
      { id: 2, name: 'Armour', domains: { status: { type: 'codedValue', codedValues: [{ code: 'R', name: 'Reserve' }] } } },
    ],
  };
  it('keeps field types, aliases, lengths, coded and range domains', () => {
    const f = A.esriFields(INFO);
    expect(f.map((x) => [x.name, x.type, x.editable])).toEqual([['objectid', 'integer', false], ['globalid', 'string', false], ['name', 'string', true], ['kind', 'integer', true], ['status', 'string', true], ['strength', 'integer', true], ['seen', 'date', true], ['speed', 'number', true]]);
    expect(f[2]).toMatchObject({ title: 'Unit name', length: 8, required: true });
    expect(f[4].domain).toEqual({ A: 'Active', I: 'Inactive' });
    expect(f[5].range).toEqual([0, 100]);
    const st = A.esriSubtypes(INFO);
    expect(st.field).toBe('kind');
    expect(st.list.map((s) => [s.code, s.name, Object.keys(s.domains)])).toEqual([[1, 'Infantry', []], [2, 'Armour', ['status']]]);
  });
  it('checks values against types, domains and subtypes before an edit is sent', () => {
    const f = A.esriFields(INFO);
    const st = A.esriSubtypes(INFO);
    const codes = (a, isNew = false) => A.checkEsriAttrs(f, st, a, { isNew }).map((e) => e.code);
    expect(codes({ name: 'A', kind: 1, status: 'A', strength: 50, seen: '2024-01-01T00:00:00Z', speed: 1.5 }, true)).toEqual([]);
    expect(codes({ name: 'A', kind: 2, status: 'A' })).toEqual(['E_ATTR_DOMAIN']); // subtype 2 has its own domain
    expect(codes({ name: 'A', kind: 2, status: 'R' })).toEqual([]);
    expect(codes({ name: 'A', kind: 9 })).toEqual(['E_ATTR_SUBTYPE']);
    expect(codes({ name: 'A', strength: 101 })).toEqual(['E_ATTR_RANGE']);
    expect(codes({ name: 'A', strength: 1.5 })).toEqual(['E_ATTR_INTEGER']);
    expect(codes({ name: 'A', kind: 70000 })).toEqual(['E_ATTR_SUBTYPE', 'E_ATTR_RANGE']); // not a subtype, and too big for a SmallInteger
    expect(codes({ name: 'TOO LONG NAME' })).toEqual(['E_ATTR_LENGTH']);
    expect(codes({ speed: 'fast' }, true)).toEqual(['E_ATTR_REQUIRED', 'E_ATTR_NUMBER']);
    expect(codes({ name: 'A', seen: 'yesterday' })).toEqual(['E_ATTR_DATE']);
    expect(codes({ name: 'A', colour: 'red' })).toEqual(['E_ATTR_UNKNOWN']);
  });
  it('converts values on the way in and out (dates as ISO in the store, epoch ms on the wire)', () => {
    const f = A.esriFields(INFO);
    expect(A.readEsriAttrs(f, { seen: 1704067200000, name: 'x' })).toEqual({ seen: '2024-01-01T00:00:00.000Z', name: 'x' });
    expect(A.writeEsriAttrs(f, { objectid: 3, name: 'x', strength: '7', seen: '2024-01-01T00:00:00.000Z', speed: '', status: '' })).toEqual({ name: 'x', strength: 7, seen: 1704067200000, speed: null, status: '' });
  });
  it('builds export, exportImage and tile URLs and reads tiling schemes', () => {
    expect(A.arcgisParts('https://s.test/arcgis/rest/services/A/FeatureServer/3?f=json')).toEqual({ root: 'https://s.test/arcgis/rest/services/A/FeatureServer', type: 'FeatureServer', layer: 3 });
    expect(A.arcgisParts('https://s.test/x/SceneServer/layers/0')).toMatchObject({ type: 'SceneServer', layer: 0 });
    expect(A.arcgisExportUrl('https://s.test/MapServer', { bbox: [0, 0, 1, 1], sr: 4326, width: 300, height: 200, layers: '1,2', time: '1000,2000' })).toBe('https://s.test/MapServer/export?bbox=0,0,1,1&bboxSR=4326&imageSR=4326&size=300,200&dpi=96&format=png32&transparent=true&layers=show:1,2&time=1000,2000&f=image');
    expect(A.arcgisImageUrl('https://s.test/ImageServer', { bbox: [0, 0, 1, 1], format: 'png' })).toMatch(/exportImage\?bbox=0,0,1,1&bboxSR=3857&imageSR=3857&size=256,256&format=png&interpolation=RSP_BilinearInterpolation&f=image/);
    const g = A.arcgisGrid({ rows: 256, cols: 256, origin: { x: -180, y: 90 }, spatialReference: { wkid: 4326 }, lods: [{ level: 0, resolution: 0.703125 }, { level: 1, resolution: 0.3515625 }] });
    expect(g.epsg).toBe(4326);
    expect(g.levels[1]).toMatchObject({ id: '1', cols: 4, rows: 2 });
    const vt = A.vectorTileInfo('https://v.test/VectorTileServer', { tiles: ['tile/{z}/{y}/{x}.pbf'], defaultStyles: 'resources/styles', tileInfo: { rows: 512, cols: 512, origin: { x: -20037508.342787, y: 20037508.342787 }, spatialReference: { wkid: 102100 }, lods: [{ level: 0, resolution: 78271.51696399994 }] } });
    expect(vt).toMatchObject({ template: 'https://v.test/VectorTileServer/tile/{z}/{y}/{x}.pbf', styleUrl: 'https://v.test/VectorTileServer/resources/styles/root.json' });
  });
});

describe('I3S (REQ-GAP-05)', () => {
  const layout = { offset: 8, position: { type: 'Float32', component: 3 }, normal: { type: 'Float32', component: 3 }, featureId: { type: 'UInt64', component: 1 }, faceRange: { type: 'UInt32', component: 2 } };
  function buffer() {
    // Two features of one triangle each: feature 5 around (0,0) at z 0–10, feature 2^33+1 at z 3.
    const pos = [0, 0, 0, 1e-4, 0, 10, 0, 1e-4, 5, 2e-4, 2e-4, 3, 3e-4, 2e-4, 3, 2e-4, 3e-4, 3];
    const vc = 6;
    const fc = 2;
    const b = new ArrayBuffer(8 + vc * 12 * 2 + fc * 8 + fc * 8);
    const dv = new DataView(b);
    dv.setUint32(0, vc, true);
    dv.setUint32(4, fc, true);
    pos.forEach((v, i) => dv.setFloat32(8 + 4 * i, v, true));
    let o = 8 + vc * 24;
    dv.setUint32(o, 5, true);
    dv.setUint32(o + 8, 1, true);
    dv.setUint32(o + 12, 2, true);
    o += 16;
    [0, 0, 1, 1].forEach((v, i) => dv.setUint32(o + 4 * i, v, true));
    return b;
  }
  it('decodes a geometry buffer into footprints with base and top heights', () => {
    const g = I.decodeGeometry(buffer(), layout);
    expect(g).toMatchObject({ vertexCount: 6, featureCount: 2, featureId: [5, 2 ** 33 + 1] });
    const fs = I.nodeFeatures({ obb: { center: [-122.4, 37.7, 100] } }, g);
    expect(fs).toHaveLength(2);
    expect(fs[0].zmin).toBeCloseTo(100, 6);
    expect(fs[0].zmax).toBeCloseTo(110, 6);
    expect(fs[0].ring[0][0]).toBeCloseTo(-122.4, 9);
    expect(fs[0].ring).toHaveLength(4);
    expect(fs[1].featureId).toBe(2 ** 33 + 1);
  });
  it('decodes Int32, Float64 (8-byte aligned) and String attribute resources', () => {
    const i32 = new ArrayBuffer(4 + 8);
    new DataView(i32).setUint32(0, 2, true);
    new DataView(i32).setInt32(4, -7, true);
    new DataView(i32).setInt32(8, 9, true);
    expect(I.decodeAttribute(i32, { header: [{ property: 'count', valueType: 'UInt32' }], ordering: ['attributeValues'], attributeValues: { valueType: 'Int32' } })).toEqual([-7, 9]);
    const f64 = new ArrayBuffer(8 + 16);
    new DataView(f64).setUint32(0, 2, true);
    new DataView(f64).setFloat64(8, 1.25, true);
    new DataView(f64).setFloat64(16, -3.5, true);
    expect(I.decodeAttribute(f64, { header: [{ property: 'count', valueType: 'UInt32' }], ordering: ['attributeValues'], attributeValues: { valueType: 'Float64' } })).toEqual([1.25, -3.5]);
    const enc = new TextEncoder();
    const a = enc.encode('ab\0');
    const b = enc.encode('cde\0');
    const s = new Uint8Array(8 + 8 + a.length + b.length);
    const dv = new DataView(s.buffer);
    dv.setUint32(0, 2, true);
    dv.setUint32(4, a.length + b.length, true);
    dv.setUint32(8, a.length, true);
    dv.setUint32(12, b.length, true);
    s.set(a, 16);
    s.set(b, 16 + a.length);
    expect(I.decodeAttribute(s.buffer, { header: [{ property: 'count', valueType: 'UInt32' }, { property: 'attributeValuesByteCount', valueType: 'UInt32' }], ordering: ['attributeByteCounts', 'attributeValues'], attributeValues: { valueType: 'String' } })).toEqual(['ab', 'cde']);
  });
  it('reads the layer document and walks the node pages', async () => {
    const info = I.sceneLayerInfo({ layerType: '3DObject', spatialReference: { wkid: 4326 }, nodePages: { nodesPerPage: 2 }, geometryDefinitions: [{ geometryBuffers: [{ compressedAttributes: { encoding: 'draco' } }, layout] }], attributeStorageInfo: [{ key: 'f_0', name: 'OBJECTID' }] });
    expect(info.plain[0].index).toBe(1);
    const pages = [[{ index: 0, children: [1, 2] }, { index: 1, mesh: { geometry: { resource: 1 } } }], [{ index: 2, mesh: { geometry: { resource: 2 } } }]];
    const r = await I.readNodePages(async (u) => ({ nodes: pages[Number(u.split('/').pop())] ?? [] }), 'https://s.test/layers/0', info);
    expect(r.nodes).toHaveLength(3);
    expect(r.leaves.map((n) => n.index)).toEqual([1, 2]);
    expect(I.sceneLayerUrl('https://s.test/SceneServer')).toBe('https://s.test/SceneServer/layers/0');
    // Top-down: a box over node 2 only reads the pages on its path.
    const box = (lon, lat) => ({ center: [lon, lat, 0], halfSize: [10, 10, 10] });
    const tree = [[{ index: 0, children: [1, 2], obb: { center: [0, 0, 0], halfSize: [5000, 5000, 10] } }, { index: 1, mesh: {}, obb: box(-0.01, 0) }], [{ index: 2, mesh: {}, obb: box(0.01, 0) }]];
    const seen = [];
    const t = await I.nodesIn(async (u) => (seen.push(u), { nodes: tree[Number(u.split('/').pop())] }), 'https://s.test/layers/0', { ...info, nodesPerPage: 2, wkid: 4326 }, [0.009, -0.001, 0.011, 0.001]);
    expect(t.leaves.map((n) => n.index)).toEqual([2]);
    expect(t.pages).toBe(2);
    expect(() => I.sceneLayerInfo({})).toThrow(/I3S/);
  });
});

describe('service images as image layers (REQ-GAP-07)', () => {
  it('requests square ground pixels and writes a geotransform sidecar that matches the request', () => {
    const { width, height, gt } = imageSize([10, 50, 11, 51], 4326, 1000);
    // At 50.5° N one degree of longitude is cos(50.5°) of a degree of latitude.
    expect(width).toBe(Math.round(1000 * Math.cos((50.5 * Math.PI) / 180)));
    expect(height).toBe(1000);
    expect(gt).toEqual([10, 1 / width, 0, 51, 0, -1 / 1000]);
    const aux = auxXml(gt, 4326);
    expect(aux).toMatch(/AUTHORITY\["EPSG","4326"\]\]<\/SRS>/);
    expect(text(parseXml(aux), 'GeoTransform').split(',').map(Number)).toEqual(gt);
  });
  it('projects the request box into a projected CRS (UTM 32N)', () => {
    const { box } = boxInCrs([9, 48, 9.1, 48.1], 32632);
    // UTM 32N central meridian 9° E: easting 500 000 m at 9° E.
    expect(box[0]).toBeCloseTo(500000, 0);
    expect(box[1]).toBeGreaterThan(5316000);
    expect(box[3] - box[1]).toBeGreaterThan(11000);
    const m = boxInCrs([0, 0, 1, 1], 3857).box;
    expect(m[2]).toBeCloseTo(111319.49, 1);
    expect(() => boxInCrs([0, 0, 1, 1], 99999999)).toThrow(/EPSG/);
  });
});
void all;

// #191: the walkers recurse, so nesting is bounded where the parser reads it.
import { MAX_XML_DEPTH } from '../../app/src/connectors/xml.js';
describe('#191 XML nesting depth', () => {
  it('reads a document nested to the bound and refuses one deeper', () => {
    const doc = (n) => `${'<a>'.repeat(n)}x${'</a>'.repeat(n)}`;
    expect(all(parseXml(doc(MAX_XML_DEPTH)), 'a')).toHaveLength(MAX_XML_DEPTH - 1);
    expect(() => parseXml(doc(MAX_XML_DEPTH + 1))).toThrow(/nested deeper than 512/);
  });
});
