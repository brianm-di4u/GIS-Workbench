// REQ-GAP-87 civil feature catalogues: ISO 19110, INSPIRE application schemas with code lists, and
// OpenStreetMap iD presets converted to gw-catalog/1 (vector/catalog-import.js), each accepted by
// validateCatalog and checking features as its source says. The samples are written here, in the
// published structure of each format; no third-party catalogue content is copied.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromIso19110, fromInspire, parseCodeList, fromIdPresets, sniffCatalog, attrType, catalogFromFiles } from '../../app/src/vector/catalog-import.js';
import { validateCatalog } from '../../app/src/vector/schema.js';

const F = (n) => readFileSync(`fixtures/catalogs/${n}`, 'utf8');

describe('REQ-GAP-87 ISO 19110', () => {
  const c = validateCatalog(fromIso19110(F('iso19110-roads.xml')));
  it('takes the feature types, their attributes, domains and geometry', () => {
    expect(c.name).toBe('Sample transport catalogue');
    expect(c.types.map((t) => t.code)).toEqual(['RD', 'BR']);
    const rd = c.types[0];
    expect(rd.name).toBe('Road');
    expect(rd.geometry).toEqual(['LineString']);
    // A catalogue's own "name" would clash with the feature's name: it is kept as name_attr.
    expect(rd.attributes).toEqual(['surface', 'lanes', 'name_attr']);
    expect(c.attributes.surface).toMatchObject({ type: 'enum', domain: { 1: 'Paved', 2: 'Unpaved' }, required: true });
    expect(c.attributes.lanes.type).toBe('integer');
    expect(c.attributes.name_attr.type).toBe('text');
    expect(c.types[1].geometry).toEqual(['Point']);
  });
  it('refuses what is not a feature catalogue', () => {
    expect(() => fromIso19110('<a/>')).toThrow(/FC_FeatureCatalogue/);
  });
});

describe('REQ-GAP-87 INSPIRE application schema', () => {
  const list = parseCodeList(F('inspire-surfacecomposition.xml'));
  it('reads a registry code list', () => {
    expect(list.id).toBe('SurfaceCompositionValue');
    expect(list.values).toEqual({ asphalt: 'asphalt', gravel: 'gravel', concrete: 'concrete' });
  });
  const c = validateCatalog(fromInspire([F('inspire-roads.xsd')], [list], { name: 'Transport networks: roads (sample)' }));
  it('finds the feature types, takes the code list by name and skips links to other features', () => {
    expect(c.types.map((t) => t.code)).toEqual(['RoadLink', 'RoadNode']);
    const link = c.types[0];
    expect(link.geometry).toEqual(['LineString']);
    expect(link.attributes).toEqual(['surfaceComposition', 'numberOfLanes', 'localRoadCode']);
    expect(c.attributes.surfaceComposition).toMatchObject({ type: 'enum', domain: list.values });
    expect(c.attributes.numberOfLanes).toMatchObject({ type: 'integer', required: true });
    expect(c.attributes.localRoadCode.required).toBeUndefined();
    expect(c.types[1].geometry).toEqual(['Point']);
  });
  it('takes the properties of the types a feature type extends, its bases first', () => {
    const xsd = (body) => `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:x="urn:x" targetNamespace="urn:x">${body}</schema>`;
    const ext = (name, base, els) => `<complexType name="${name}"><complexContent><extension base="${base}"><sequence>${els}</sequence></extension></complexContent></complexType>`;
    const two = fromInspire(
      xsd(
        '<element name="RoadLink" type="x:RoadLinkType" substitutionGroup="gml:AbstractFeature"/>' +
          ext('RoadLinkType', 'x:TransportLinkType', '<element name="functionalRoadClass" type="string"/>') +
          ext('TransportLinkType', 'x:NetworkElementType', '<element name="centrelineGeometry" type="gml:CurvePropertyType"/><element name="validFrom" type="dateTime" nillable="true"/>') +
          // A cycle in a broken schema ends instead of looping.
          ext('NetworkElementType', 'x:RoadLinkType', '<element name="inNetwork" type="string" minOccurs="0"/>'),
      ),
    );
    expect(two.types[0].geometry).toEqual(['LineString']);
    expect(two.types[0].attributes).toEqual(['inNetwork', 'validFrom', 'functionalRoadClass']);
  });
});

describe('REQ-GAP-87 OpenStreetMap presets', () => {
  const c = validateCatalog(fromIdPresets(JSON.parse(F('id-presets.json')), JSON.parse(F('id-fields.json'))));
  it('makes a type per preset with its tags fixed, its fields as attributes, and skips the unsearchable', () => {
    expect(c.types.map((t) => t.code)).toEqual(['amenity/cafe', 'highway/residential']);
    const cafe = c.types[0];
    expect(cafe.geometry).toEqual(['Point', 'Polygon']);
    expect(cafe.subtypes[0].fixed).toEqual({ amenity: 'cafe' });
    expect(cafe.attributes).toEqual(['amenity', 'name_attr', 'cuisine', 'outdoor_seating']);
    expect(c.attributes.outdoor_seating.domain).toEqual({ yes: 'yes', no: 'no' });
    expect(c.attributes.cuisine.domain).toMatchObject({ coffee_shop: 'Coffee Shop' });
    expect(c.attributes.lanes.type).toBe('real');
  });
});

describe('REQ-GAP-87 the files a user picks', () => {
  const file = (name) => ({ name, text: F(name) });
  it('converts each kind, and an INSPIRE schema with its code list together', () => {
    expect(catalogFromFiles([file('iso19110-roads.xml')]).source).toBe('ISO 19110');
    const insp = validateCatalog(catalogFromFiles([file('inspire-roads.xsd'), { name: 'surface.xml', text: F('inspire-surfacecomposition.xml') }]));
    expect(insp.attributes.surfaceComposition.type).toBe('enum');
    expect(validateCatalog(catalogFromFiles([{ name: 'presets.json', text: F('id-presets.json') }, { name: 'fields.json', text: F('id-fields.json') }])).types).toHaveLength(2);
    expect(catalogFromFiles([{ name: 'mine.gwcatalog.json', text: '{"format":"gw-catalog/1","id":"m","__proto__":{"x":1}}' }])).toEqual({ format: 'gw-catalog/1', id: 'm' });
  });
  it('refuses a mix, a code list alone, two ISO files and an unknown file, naming the problem', () => {
    expect(() => catalogFromFiles([file('iso19110-roads.xml'), file('inspire-roads.xsd')])).toThrow(/different kinds/);
    expect(() => catalogFromFiles([{ name: 'surface.xml', text: F('inspire-surfacecomposition.xml') }])).toThrow(/needs the application schema/);
    expect(() => catalogFromFiles([file('iso19110-roads.xml'), file('iso19110-roads.xml')])).toThrow(/one ISO 19110 file/);
    expect(() => catalogFromFiles([{ name: 'notes.txt', text: 'hello' }])).toThrow(/notes.txt is not a feature catalogue/);
  });
  it('names a preset from its id when presets.json leaves names to translations', () => {
    const c = fromIdPresets({ 'leisure/picnic_table': { geometry: ['point'], tags: { leisure: 'picnic_table' } } });
    expect(c.types[0].name).toBe('Picnic table');
  });
});

describe('REQ-GAP-87 which converter a file needs', () => {
  it('sniffs each format', () => {
    expect(sniffCatalog('roads.xml', F('iso19110-roads.xml'))).toBe('iso19110');
    expect(sniffCatalog('roads.xsd', F('inspire-roads.xsd'))).toBe('inspire-xsd');
    expect(sniffCatalog('x.xml', F('inspire-surfacecomposition.xml'))).toBe('codelist');
    expect(sniffCatalog('presets.json', '{')).toBe('id-presets');
    expect(sniffCatalog('fields.json', '{')).toBe('id-fields');
    expect(sniffCatalog('mine.gwcatalog.json', '{"format":"gw-catalog/1"')).toBe('gw-catalog');
    expect(sniffCatalog('notes.txt', 'hello')).toBeNull();
  });
  it('types ISO and XSD values', () => {
    expect(['gco:Integer', 'xs:double', 'Boolean', 'gml:LengthType', 'CharacterString'].map(attrType)).toEqual(['integer', 'real', 'boolean', 'real', 'text']);
    expect(['GM_Curve', 'gml:PointPropertyType', 'gml:MultiSurfacePropertyType'].map(attrType)).toEqual(['geometry:LineString', 'geometry:Point', 'geometry:Polygon']);
  });
});

describe('REQ-GAP-87 coded attributes keep their codes', () => {
  it('stores word codes as text and whole-number codes as integers', async () => {
    const { fieldsFor } = await import('../../app/src/vector/schema.js');
    const insp = validateCatalog(fromInspire([F('inspire-roads.xsd')], [parseCodeList(F('inspire-surfacecomposition.xml'))]));
    expect(fieldsFor(insp, 'RoadLink').find((f) => f.name === 'surfaceComposition').type).toBe('string');
    const iso = validateCatalog(fromIso19110(F('iso19110-roads.xml')));
    expect(fieldsFor(iso, 'RD').find((f) => f.name === 'surface').type).toBe('integer');
    // Codes a number would not give back ('01' → 1) stay text.
    const padded = validateCatalog({ format: 'gw-catalog/1', id: 'pad', name: 'Padded', attributes: { cls: { type: 'enum', domain: { '01': 'One', '02': 'Two' } } }, types: [{ code: 'T', name: 'T', geometry: ['POINT'], attributes: ['cls'] }] });
    expect(fieldsFor(padded, 'T').find((f) => f.name === 'cls').type).toBe('string');
  });
  it('starts a new feature empty, not with the TDS "no information" codes', async () => {
    const { fieldsFor, nullOf, getCatalog } = await import('../../app/src/vector/schema.js');
    const insp = validateCatalog(fromInspire([F('inspire-roads.xsd')], [parseCodeList(F('inspire-surfacecomposition.xml'))]));
    const iso = validateCatalog(fromIso19110(F('iso19110-roads.xml')));
    const osm = validateCatalog(fromIdPresets(JSON.parse(F('id-presets.json')), JSON.parse(F('id-fields.json'))));
    for (const [c, type] of [[insp, 'RoadLink'], [iso, 'RD'], [osm, osm.types[0].code]]) {
      // No field takes a column every feature already has (GeoPackage export writes those itself).
      for (const f of fieldsFor(c, type)) expect(['fid', 'geom', 'name', 'description', 'ufi']).not.toContain(f.name.toLowerCase());
      for (const f of fieldsFor(c, type)) expect([f.name, nullOf(c, f)]).toEqual([f.name, f.domain || f.type === 'string' ? '' : null]);
    }
    // TDS keeps its own.
    const tds = getCatalog();
    const coded = Object.values(tds.attributes).find((a) => a.domain);
    expect(String(nullOf(tds, { ...coded, domain: coded.domain }))).toBe('-999999');
    expect(nullOf(tds, { type: 'string' })).toBe('noInformation');
  });
});

describe('REQ-GAP-87 untrusted catalogue files', () => {
  const SETS = [
    [{ name: 'roads.xml', text: F('iso19110-roads.xml') }],
    [{ name: 'roads.xsd', text: F('inspire-roads.xsd') }, { name: 'SurfaceCompositionValue.en.xml', text: F('inspire-surfacecomposition.xml') }],
    [{ name: 'presets.json', text: F('id-presets.json') }, { name: 'fields.json', text: F('id-fields.json') }],
  ];
  it('fuzz: mutated files end in a catalogue or a named refusal', () => {
    let seed = 0x5eed87;
    const rnd = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const junk = ['<', '>', '</', '/>', '"', "'", '&amp', '&#x110000;', '\0', '{', '}', '[', ']', ',', ':', 'null', '__proto__', 'constructor', '<FC_FeatureType>', '<xs:element name="X" substitutionGroup="gml:AbstractFeature"/>', '"tags":1', '"geometry":"line"', '"fields":7'];
    let ok = 0;
    for (let i = 0; i < 3000; i++) {
      const set = SETS[i % SETS.length].map((f) => ({ ...f }));
      const f = set[rnd(set.length)];
      for (let k = 0; k < 1 + rnd(6); k++) {
        const at = rnd(f.text.length);
        f.text = rnd(2) ? f.text.slice(0, at) + junk[rnd(junk.length)] + f.text.slice(at) : f.text.slice(0, at) + f.text.slice(at + rnd(40));
      }
      try {
        validateCatalog(catalogFromFiles(set));
        ok++;
      } catch (e) {
        expect(e.code ?? `${e.name}: ${e.message}`).toMatch(/^E_CATALOG_(CONVERT|INVALID)$/);
      }
    }
    expect(ok).toBeGreaterThan(100);
  });
  it('refuses too many files, too much text and too many types or values', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `c${i}.xml`, text: F('inspire-surfacecomposition.xml') }));
    expect(() => catalogFromFiles(many)).toThrow(/at most 200 files/);
    expect(() => catalogFromFiles([{ name: 'big.json', text: ' '.repeat((64 << 20) + 1) }])).toThrow(/larger than 64 MB/);
    const types = '<FC_FeatureType><typeName>T</typeName></FC_FeatureType>'.repeat(5001);
    expect(() => fromIso19110(`<FC_FeatureCatalogue>${types}</FC_FeatureCatalogue>`)).toThrow(/more than 5000 feature types/);
    const values = Array.from({ length: 20001 }, (_, i) => `<value id="x/v${i}"><label>v</label></value>`).join('');
    expect(() => parseCodeList(`<codelist id="x/BigValue">${values}</codelist>`)).toThrow(/more than 20000 values/);
    const presets = { a: { name: 'A', geometry: ['point'], tags: { k: '*' }, fields: ['k'] } };
    const fields = { k: { key: 'k', type: 'combo', options: Array.from({ length: 20001 }, (_, i) => `o${i}`) } };
    expect(() => fromIdPresets(presets, fields)).toThrow(/more than 20000 values/);
    // Wrong shapes in a preset are skipped, not thrown on.
    const odd = { a: { name: 'A', geometry: 'point', tags: { k: 'v' } }, b: { name: 'B', geometry: ['line'], tags: { k: 'w' }, fields: 7, moreFields: 'x' } };
    expect(fromIdPresets(odd, {}).types.map((ty) => ty.code)).toEqual(['b']);
  });
});
