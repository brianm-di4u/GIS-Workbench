// FileGDB catalogue mapper (REQ-GAP-54): GDAL's report on a geodatabase plus its GDB_Items XML becomes
// a gw-catalog/1 document that the app's own checker accepts. `info` below is what ogrinfo 3.13.3 gave
// for GDAL's autotest Domains.gdb; the XML follows the DEFeatureClassInfo layout a geodatabase stores.

import { describe, it, expect } from 'vitest';
import { catalogFromGdb, subtypesFromXml } from '../../app/src/vector/gdb-catalog.js';
import { validateCatalog, fieldsFor, checkAttrs } from '../../app/src/vector/schema.js';

const domains = {
  MedianType: { description: 'Road median types.', type: 'coded', fieldType: 'Integer', fieldSubType: 'Int16', codedValues: { 0: 'None', 1: 'Cement' } },
  RoadSurfaceType: { description: 'The road surface type', type: 'coded', fieldType: 'Integer', codedValues: { 1: 'Asphalt', 2: 'Gravel', 3: 'Oiled Sand', 4: 'Dirt' } },
  SpeedLimit: { description: 'The maximun speed of the road', type: 'range', fieldType: 'Integer', fieldSubType: 'Int16', minValue: 40, maxValue: 120 },
  Paved: { description: 'Paved', type: 'coded', fieldType: 'Integer', codedValues: { 1: 'Asphalt' } },
  Glob: { type: 'glob', fieldType: 'String', glob: 'A*' },
};
const roads = {
  name: 'Roads',
  geometryFields: [{ name: 'SHAPE', type: 'MultiLineString', nullable: true }],
  featureCount: 3,
  fields: [
    { name: 'Name', type: 'String', width: 50, nullable: true },
    { name: 'MaxSpeed', type: 'Integer', subType: 'Int16', nullable: true, domainName: 'SpeedLimit' },
    { name: 'MedianType', type: 'Integer', subType: 'Int16', nullable: true, domainName: 'MedianType' },
    { name: 'SurfaceType', type: 'Integer', nullable: true, domainName: 'RoadSurfaceType' },
    { name: 'Class', type: 'Integer', nullable: false },
    { name: 'SHAPE_Length', type: 'Real', nullable: true, defaultValue: 'FILEGEODATABASE_SHAPE_LENGTH' },
  ],
};
const XML = `<DEFeatureClassInfo xmlns:typens="http://www.esri.com/schemas/ArcGIS/10.1"><CatalogPath>\\Roads</CatalogPath>
<SubtypeFieldName>Class</SubtypeFieldName><DefaultSubtypeCode>1</DefaultSubtypeCode>
<Subtypes xsi:type="esri:ArrayOfSubtype">
<Subtype xsi:type="esri:Subtype"><SubtypeName>Main &amp; Trunk</SubtypeName><SubtypeCode>1</SubtypeCode>
<FieldInfos xsi:type="esri:ArrayOfSubtypeFieldInfo"><SubtypeFieldInfo xsi:type="esri:SubtypeFieldInfo"><FieldName>SurfaceType</FieldName><DomainName>Paved</DomainName><DefaultValue xsi:type="xs:int">1</DefaultValue></SubtypeFieldInfo>
<SubtypeFieldInfo xsi:type="esri:SubtypeFieldInfo"><FieldName>MaxSpeed</FieldName><DomainName>SpeedLimit</DomainName></SubtypeFieldInfo></FieldInfos></Subtype>
<Subtype xsi:type="esri:Subtype"><SubtypeName>Track</SubtypeName><SubtypeCode>2</SubtypeCode><FieldInfos/></Subtype>
</Subtypes></DEFeatureClassInfo>`;
const answer = (over = {}) => ({ info: { domains, layers: [roads, { name: 'lookup', geometryFields: [], fields: [{ name: 'k', type: 'String' }] }] }, items: { layers: [{ features: [{ properties: { Name: 'dbo.Roads', Definition: XML } }] }] }, ...over });

describe('subtypes in a GDB_Items definition', () => {
  it('reads the field, the default and each subtype, with entities undone', () => {
    const s = subtypesFromXml(XML);
    expect(s.field).toBe('Class');
    expect(s.defaultCode).toBe('1');
    expect(s.subtypes.map((x) => [x.code, x.name])).toEqual([['1', 'Main & Trunk'], ['2', 'Track']]);
    expect(s.subtypes[0].fields[0]).toEqual({ name: 'SurfaceType', domain: 'Paved', value: '1' });
    expect(s.subtypes[1].fields).toEqual([]);
  });
  it('reads self-closed elements as empty, not as the next element', () => {
    const s = subtypesFromXml('<SubtypeFieldName>k</SubtypeFieldName><Subtypes><Subtype><SubtypeName/><SubtypeCode>3</SubtypeCode><FieldInfos><SubtypeFieldInfo><FieldName>a</FieldName><DomainName/><DefaultValue>7</DefaultValue></SubtypeFieldInfo></FieldInfos></Subtype></Subtypes>');
    expect(s.subtypes[0].code).toBe('3');
    expect(s.subtypes[0].name).toBe('');
    expect(s.subtypes[0].fields[0]).toEqual({ name: 'a', domain: null, value: '7' });
  });
  it('stays linear on a file built to make it slow', () => {
    const many = '<SubtypeFieldName>k</SubtypeFieldName>' + '<Subtype>'.repeat(800_000);
    const t0 = performance.now();
    expect(subtypesFromXml(many)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('fuzz: mutated definitions and answers end in a catalogue or a named refusal', () => {
    let seed = 0x2f6e2b1;
    const rnd = (n) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const junk = ['<', '>', '</Subtype>', '<Subtype>', '&amp', '&#x110000;', '&#0;', '\0', '"', '<SubtypeCode>', '__proto__', '</', '/>'];
    for (let i = 0; i < 3000; i++) {
      let x = XML;
      for (let k = 0; k < 1 + rnd(6); k++) {
        const at = rnd(x.length);
        x = rnd(2) ? x.slice(0, at) + junk[rnd(junk.length)] + x.slice(at) : x.slice(0, at) + x.slice(at + rnd(40));
      }
      expect(() => subtypesFromXml(x)).not.toThrow();
      try {
        const r = catalogFromGdb('f.gdb', answer({ items: { layers: [{ features: [{ properties: { Name: 'Roads', Definition: x } }] }] } }));
        validateCatalog(r.catalog);
      } catch (e) {
        expect(e.code ?? '').toMatch(/^E_(GDB|CATALOG)/);
      }
    }
  });
  it('gives nothing for a class without subtypes, for rubbish and for a huge string', () => {
    expect(subtypesFromXml('<DEFeatureClassInfo><Name>x</Name></DEFeatureClassInfo>')).toBeNull();
    expect(subtypesFromXml('<SubtypeFieldName></SubtypeFieldName>')).toBeNull();
    expect(subtypesFromXml('<SubtypeFieldName>a</SubtypeFieldName>')).toBeNull();
    expect(subtypesFromXml(null)).toBeNull();
    expect(subtypesFromXml('x'.repeat(9 << 20))).toBeNull();
  });
});

describe('catalogFromGdb', () => {
  it('makes a catalogue the app validates, with domains, ranges and subtypes', () => {
    const { catalog, warnings, counts } = catalogFromGdb('Domains.gdb', answer());
    expect(counts).toEqual({ classes: 1, tables: 1, domains: 5, subtypes: 2 });
    const c = validateCatalog(catalog);
    expect(c.id).toBe('gdb:Domains');
    expect(c.attributes.SurfaceType.type).toBe('enum');
    expect(c.attributes.SurfaceType.domain).toEqual({ 1: 'Asphalt', 2: 'Gravel', 3: 'Oiled Sand', 4: 'Dirt' });
    expect(c.attributes.MaxSpeed.range).toEqual([40, 120]);
    expect(c.attributes.Name.length).toBe(50);
    expect(c.attributes.Class.required).toBe(true);
    expect(c.attributes.SHAPE_Length).toBeUndefined();
    expect(c.types[0].geometry).toEqual(['LineString']);
    expect(c.types[0].subtypeField).toBe('Class');
    expect(warnings.join(' ')).toMatch(/range domain SpeedLimit on MaxSpeed is not kept per subtype/);
  });
  it('a subtype narrows the domain and fixes its own field', () => {
    const c = validateCatalog(catalogFromGdb('Domains.gdb', answer()).catalog);
    const main = fieldsFor(c, 'Roads', '1');
    expect(main.find((f) => f.name === 'SurfaceType').domain).toEqual({ 1: 'Asphalt' });
    expect(main.find((f) => f.name === 'Class').fixed).toBe(1);
    const track = fieldsFor(c, 'Roads', '2');
    expect(Object.keys(track.find((f) => f.name === 'SurfaceType').domain).length).toBe(4);
  });
  it('a class with the same fields and no subtypes keeps its own definitions, in either order (#249)', () => {
    const lanes = { ...roads, name: 'Lanes' };
    for (const layers of [[lanes, roads], [roads, lanes]]) {
      const base = answer();
      const c = validateCatalog(catalogFromGdb('Domains.gdb', { ...base, info: { ...base.info, layers } }).catalog);
      const roadsType = c.types.find((t) => t.code === 'Roads');
      // Roads's Class takes the subtypes as its values; Lanes's stays a free integer, under its own key.
      expect(c.attributes[roadsType.subtypeField]).toMatchObject({ type: 'enum', domain: { 1: 'Main & Trunk', 2: 'Track' } });
      expect(fieldsFor(c, 'Lanes').find((f) => f.name === 'Class').domain).toBeUndefined();
      expect(checkAttrs(c, fieldsFor(c, 'Lanes'), { Class: 7 })).toEqual([]);
      // The subtype still fixes and narrows by column.
      const main = fieldsFor(c, 'Roads', '1');
      expect(main.find((f) => f.name === 'Class').fixed).toBe(1);
      expect(main.find((f) => f.name === 'SurfaceType').domain).toEqual({ 1: 'Asphalt' });
    }
  });
  it('a subtype on a field another class defines differently keys its values by that class (#249)', () => {
    const other = { name: 'A', geometryFields: [{ type: 'Point' }], fields: [{ name: 'SurfaceType', type: 'String' }, { name: 'Class', type: 'String' }] };
    const base = answer();
    const c = validateCatalog(catalogFromGdb('Domains.gdb', { ...base, info: { ...base.info, layers: [other, roads] } }).catalog);
    const t = c.types.find((x) => x.code === 'Roads');
    expect(t.subtypeField).toBe('Class_Roads');
    expect(t.subtypes[0].fixed).toEqual({ Class_Roads: 1 });
    expect(Object.keys(t.subtypes[0].domains)).toEqual(['SurfaceType_Roads']);
    const main = fieldsFor(c, 'Roads', '1');
    expect(main.find((f) => f.name === 'Class').fixed).toBe(1);
    expect(main.find((f) => f.name === 'SurfaceType').domain).toEqual({ 1: 'Asphalt' });
  });
  it('a field with no domain gets the subtypes as its values', () => {
    const c = validateCatalog(catalogFromGdb('Domains.gdb', answer()).catalog);
    expect(c.attributes.Class.domain).toEqual({ 1: 'Main & Trunk', 2: 'Track' });
  });
  it('says what it could not keep, and does not guess', () => {
    const l = { name: 'B', geometryFields: [{ type: 'Point' }], fields: [{ name: 'SurfaceType', type: 'Integer' }, { name: 'G', type: 'String', domainName: 'Glob' }, { name: 'Lost', type: 'String', domainName: 'Nope' }] };
    const { warnings, catalog } = catalogFromGdb('x.gdb.zip', { info: { domains, layers: [roads, l] } });
    // B's SurfaceType differs from Roads': B keeps its own, writing the same column (decision #243).
    expect(warnings.join('\n')).not.toMatch(/SurfaceType/);
    expect(catalog.attributes.SurfaceType_B).toMatchObject({ type: 'integer', field: 'SurfaceType' });
    expect(fieldsFor(validateCatalog(catalog), 'B').find((f) => f.name === 'SurfaceType').domain).toBeUndefined();
    expect(warnings.join('\n')).toMatch(/glob domain, kept as free text/);
    expect(warnings.join('\n')).toMatch(/Nope is not in the geodatabase/);
    expect(catalog.attributes.G.type).toBe('text');
    expect(catalog.id).toBe('gdb:x');
    expect(() => validateCatalog(catalog)).not.toThrow();
  });
  it('refuses by name what is not a geodatabase', () => {
    expect(() => catalogFromGdb('a.gdb', { info: null, items: null })).toThrow(/not a File Geodatabase/);
    expect(() => catalogFromGdb('a.gdb', {})).toThrow(/not a File Geodatabase/);
    expect(() => catalogFromGdb('a.gdb', { info: { layers: [{ name: 't', geometryFields: [], fields: [] }] } })).toThrow(/no feature classes/);
  });
  it('a hostile field name cannot reach the prototype', () => {
    const l = { name: 'P', geometryFields: [{ type: 'Point' }], fields: [{ name: '__proto__', type: 'String' }] };
    const { catalog } = catalogFromGdb('p.gdb', { info: { domains: {}, layers: [l] } });
    expect(() => validateCatalog(catalog)).toThrow(/not allowed|unknown attribute/);
    expect({}.label).toBeUndefined();
  });
});
