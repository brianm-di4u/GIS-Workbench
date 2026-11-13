// REQ-GAP-87 civil feature catalogues: ISO 19110, INSPIRE application schemas with code lists, and
// OpenStreetMap iD presets converted to gw-catalog/1 (vector/catalog-import.js), each accepted by
// validateCatalog and checking features as its source says. The samples are written here, in the
// published structure of each format; no third-party catalogue content is copied.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fromIso19110, fromInspire, parseCodeList, fromIdPresets, sniffCatalog, attrType, catalogFromFiles } from '../../app/src/vector/catalog-import.js';
import { validateCatalog, catalogFromLayers } from '../../app/src/vector/schema.js';

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
  it('skips an abstract feature type and gives a type its supertype\'s attributes first', () => {
    const attr = (n) => `<gfc:carrierOfCharacteristics><gfc:FC_FeatureAttribute><gfc:memberName>${n}</gfc:memberName><gfc:valueType><gco:TypeName><gco:aName><gco:CharacterString>CharacterString</gco:CharacterString></gco:aName></gco:TypeName></gfc:valueType></gfc:FC_FeatureAttribute></gfc:carrierOfCharacteristics>`;
    const c = fromIso19110(`<gfc:FC_FeatureCatalogue xmlns:gfc="g" xmlns:gco="c" xmlns:xlink="http://www.w3.org/1999/xlink">
      <gfc:featureType><gfc:FC_FeatureType id="ft-way"><gfc:typeName>Way</gfc:typeName><gfc:isAbstract><gco:Boolean>true</gco:Boolean></gfc:isAbstract>${attr('owner')}</gfc:FC_FeatureType></gfc:featureType>
      <gfc:featureType><gfc:FC_FeatureType id="ft-road"><gfc:typeName>Road</gfc:typeName><gfc:inheritsFrom><gfc:FC_InheritanceRelation><gfc:supertype xlink:href="#ft-way"/></gfc:FC_InheritanceRelation></gfc:inheritsFrom>${attr('surface')}</gfc:FC_FeatureType></gfc:featureType>
    </gfc:FC_FeatureCatalogue>`);
    expect(c.types.map((t) => t.code)).toEqual(['Road']);
    expect(c.types[0].attributes).toEqual(['owner', 'surface']);
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
  it('finds a feature type that substitutes through an abstract base in another schema, and skips the base', () => {
    const base = '<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:tn"><element name="TransportLink" abstract="true" type="tn:TransportLinkType" substitutionGroup="gml:AbstractFeature"/><complexType name="TransportLinkType"><complexContent><extension base="gml:AbstractFeatureType"><sequence><element name="centrelineGeometry" type="gml:CurvePropertyType"/></sequence></extension></complexContent></complexType></schema>';
    const roads = '<schema xmlns="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:tn-ro"><element name="RoadLink" type="tn-ro:RoadLinkType" substitutionGroup="tn:TransportLink"/><complexType name="RoadLinkType"><complexContent><extension base="tn:TransportLinkType"><sequence><element name="functionalRoadClass" type="string"/></sequence></extension></complexContent></complexType></schema>';
    const c = fromInspire([roads, base]);
    expect(c.types.map((t) => t.code)).toEqual(['RoadLink']);
    expect(c.types[0]).toMatchObject({ geometry: ['LineString'], attributes: ['functionalRoadClass'] });
    // Alone, the concrete schema names no feature type: its base is not there to follow.
    expect(() => fromInspire([roads])).toThrow(/no feature types/);
  });
  it('reads names by namespace: an extension schema may reuse a name, and its type is the one offered', () => {
    const xsd = (ns, decl, body) => `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" ${decl} targetNamespace="${ns}">${body}</schema>`;
    const type = (name, base, els) => `<complexType name="${name}"><complexContent><extension base="${base}"><sequence>${els}</sequence></extension></complexContent></complexType>`;
    const base = xsd('urn:bu-base', 'xmlns:bu-base="urn:bu-base"', '<element name="AbstractBuilding" abstract="true" type="bu-base:AbstractBuildingType" substitutionGroup="gml:AbstractFeature"/>' + type('AbstractBuildingType', 'gml:AbstractFeatureType', '<element name="geometry" type="gml:SurfacePropertyType"/>'));
    const core = xsd('urn:bu-core2d', 'xmlns:bu-base="urn:bu-base" xmlns:bu-core2d="urn:bu-core2d"', '<element name="Building" type="bu-core2d:BuildingType" substitutionGroup="bu-base:AbstractBuilding"/>' + type('BuildingType', 'bu-base:AbstractBuildingType', '<element name="heightAboveGround" type="double"/>'));
    const ext = xsd('urn:bu-ext2d', 'xmlns:bu-core2d="urn:bu-core2d" xmlns:bu-ext2d="urn:bu-ext2d"', '<element name="Building" type="bu-ext2d:BuildingType" substitutionGroup="bu-core2d:Building"/>' + type('BuildingType', 'bu-core2d:BuildingType', '<element name="officialArea" type="double" minOccurs="0"/>'));
    expect(fromInspire([base, core]).types).toMatchObject([{ code: 'Building', geometry: ['Polygon'], attributes: ['heightAboveGround'] }]);
    // With the extension, its Building replaces the core one and carries both levels' properties.
    expect(fromInspire([base, core, ext]).types).toMatchObject([{ code: 'Building', geometry: ['Polygon'], attributes: ['heightAboveGround', 'officialArea'] }]);
    // Two sibling schemas that both define Building keep both, each code qualified by its schema's prefix.
    const core3d = xsd('urn:bu-core3d', 'xmlns:bu-base="urn:bu-base" xmlns:bu-core3d="urn:bu-core3d"', '<element name="Building" type="bu-core3d:BuildingType" substitutionGroup="bu-base:AbstractBuilding"/>' + type('BuildingType', 'bu-base:AbstractBuildingType', '<element name="lod" type="integer"/>'));
    const both = validateCatalog(fromInspire([base, core, core3d]));
    expect(both.types.map((t) => [t.code, t.attributes])).toEqual([['bu-core2d:Building', ['heightAboveGround']], ['bu-core3d:Building', ['lod']]]);
    // A declared namespace that is not loaded names nothing: the extension cannot borrow core3d's Building,
    // and the import names the schema it builds on instead of making a Building without core2d's properties.
    expect(() => fromInspire([base, core3d, ext])).toThrow(/add urn:bu-core2d$/);
  });
  it('reads a voidable property\'s type from its simpleContent, and binds code lists by targetCodeList', () => {
    const voidable = (name, base) => `<element name="${name}" nillable="true"><complexType><simpleContent><extension base="${base}"><attribute name="nilReason" type="gml:NilReasonType"/></extension></simpleContent></complexType></element>`;
    const ref = (name, list) => `<element name="${name}" type="gml:ReferenceType" nillable="true">${list ? `<annotation><appinfo><targetCodeList>${list}</targetCodeList></appinfo></annotation>` : ''}</element>`;
    const xsd = `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:bu="urn:bu" targetNamespace="urn:bu"><element name="Building" type="bu:BuildingType" substitutionGroup="gml:AbstractFeature"/><complexType name="BuildingType"><complexContent><extension base="gml:AbstractFeatureType"><sequence><element name="geometry" type="gml:SurfacePropertyType"/>${voidable('numberOfFloorsAboveGround', 'integer')}${voidable('heightValue', 'gml:LengthType')}${ref('currentUse', 'CurrentUseValue')}${ref('condition', 'ConditionOfConstructionValue')}${ref('parent')}</sequence></extension></complexContent></complexType></schema>`;
    const uses = { id: 'CurrentUseValue', name: 'Current use', values: { residential: 'Residential' } };
    const c = validateCatalog(fromInspire(xsd, [uses]));
    expect(c.types[0].attributes).toEqual(['numberOfFloorsAboveGround', 'heightValue', 'currentUse', 'condition']);
    expect(c.attributes.numberOfFloorsAboveGround.type).toBe('integer');
    expect(c.attributes.heightValue.type).toBe('real');
    // targetCodeList names the list, though the property is not named after it.
    expect(c.attributes.currentUse).toMatchObject({ type: 'enum', domain: { residential: 'Residential' } });
    // A list the import was not given keeps the property, as text that says which list it needs.
    expect(c.attributes.condition).toMatchObject({ type: 'text' });
    expect(c.attributes.condition.definition).toMatch(/ConditionOfConstructionValue/);
  });
  it('keeps a concrete type that a differently named subtype substitutes for', () => {
    const one = '<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:x="urn:x" targetNamespace="urn:x"><element name="Road" type="x:RoadType" substitutionGroup="gml:AbstractFeature"/><element name="Motorway" type="x:RoadType" substitutionGroup="x:Road"/><complexType name="RoadType"><complexContent><extension base="gml:AbstractFeatureType"><sequence><element name="lanes" type="integer"/></sequence></extension></complexContent></complexType></schema>';
    expect(fromInspire(one).types.map((t) => t.code)).toEqual(['Road', 'Motorway']);
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
  it('takes a feature type whose head is in a schema not given, and not one of GML\'s object heads', () => {
    const c = fromInspire(
      `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:tn="urn:tn" xmlns:x="urn:x" targetNamespace="urn:x">` +
        '<element name="RoadLink" type="x:RoadLinkType" substitutionGroup="tn:TransportLink"/><complexType name="RoadLinkType"><sequence><element name="geometry" type="gml:CurvePropertyType"/><element name="roadName" type="string"/></sequence></complexType>' +
        '<element name="Width" type="x:WidthType" substitutionGroup="gml:AbstractObject"/><complexType name="WidthType"><sequence><element name="value" type="double"/></sequence></complexType>' +
        '</schema>',
    );
    expect(c.types.map((t) => [t.code, t.geometry, t.attributes])).toEqual([['RoadLink', ['LineString'], ['roadName']]]);
    // A type that extends a base in that schema (where INSPIRE keeps the geometry) is refused, naming the schema.
    const theme = `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:tn="urn:tn" xmlns:x="urn:x" targetNamespace="urn:x">` +
      '<element name="RoadLink" type="x:RoadLinkType" substitutionGroup="tn:TransportLink"/><complexType name="RoadLinkType"><complexContent><extension base="tn:TransportLinkType"><sequence><element name="roadName" type="string"/></sequence></extension></complexContent></complexType></schema>';
    expect(() => fromInspire(theme)).toThrow(/build on schemas not given: add urn:tn$/);
    // A plain-sequence type with a voidable property, and one built on an OGC standard (O&M), import.
    const plain = fromInspire(
      `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:om="http://www.opengis.net/om/2.0" xmlns:x="urn:x" targetNamespace="urn:x">` +
        '<element name="Site" type="x:SiteType" substitutionGroup="gml:AbstractFeature"/><complexType name="SiteType"><sequence><element name="geometry" type="gml:PointPropertyType"/><element name="floors" nillable="true"><complexType><simpleContent><extension base="integer"><attribute name="nilReason" type="string"/></extension></simpleContent></complexType></element></sequence></complexType>' +
        '<element name="Obs" type="x:ObsType" substitutionGroup="om:OM_Observation"/><complexType name="ObsType"><complexContent><extension base="om:OM_ObservationType"><sequence><element name="note" type="string"/></sequence></extension></complexContent></complexType></schema>',
    );
    // An O&M observation holds no geometry: it imports with none, and no schema is asked for.
    expect(plain.types.map((t) => [t.code, t.geometry, t.attributes])).toEqual([['Site', ['Point'], ['floors']], ['Obs', undefined, ['note']]]);
    // A type built on a sampling feature takes its shape as its geometry (any kind), with no schema to add;
    // and a standard's own schema, if given, adds none of its own elements as types.
    const sams = 'http://www.opengis.net/samplingSpatial/2.0';
    const sampled = `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:sams="${sams}" xmlns:x="urn:x" targetNamespace="urn:x">` +
      '<element name="GeophObject" type="x:GeophObjectType" substitutionGroup="sams:SF_SpatialSamplingFeature"/><complexType name="GeophObjectType"><complexContent><extension base="sams:SF_SpatialSamplingFeatureType"><sequence><element name="citation" type="string"/></sequence></extension></complexContent></complexType></schema>';
    const std = `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:sams="${sams}" targetNamespace="${sams}"><element name="SF_SpatialSamplingFeature" type="sams:SF_SpatialSamplingFeatureType" substitutionGroup="gml:AbstractFeature"/><complexType name="SF_SpatialSamplingFeatureType"><sequence><element name="shape" type="gml:GeometryPropertyType"/></sequence></complexType></schema>`;
    for (const files of [[sampled], [sampled, std]]) expect(fromInspire(files).types.map((t) => [t.code, t.geometry, t.attributes])).toEqual([['GeophObject', undefined, ['citation']]]);
  });
  it('takes a type\'s geometry from its primary geometry property, and keeps other geometries out of its attributes', () => {
    const xsd = (body) => `<schema xmlns="http://www.w3.org/2001/XMLSchema" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:x="urn:x" targetNamespace="urn:x">${body}</schema>`;
    const type = (name, els) => `<element name="${name}" type="x:${name}Type" substitutionGroup="gml:AbstractFeature"/><complexType name="${name}Type"><sequence>${els}</sequence></complexType>`;
    const c = fromInspire(
      xsd(
        // A parcel's outline, with a reference point beside it: the type holds polygons only.
        type('CadastralParcel', '<element name="referencePoint" type="gml:PointPropertyType" minOccurs="0"/><element name="geometry" type="gml:MultiSurfacePropertyType"/><element name="label" type="string"/>') +
          // A building's geometry wrapped in a data type: not a required text attribute.
          type('Building', '<element name="geometry2D" type="x:BuildingGeometry2DPropertyType"/><element name="height" type="gml:LengthType" minOccurs="0"/>') +
          // No property named geometry: the first one decides.
          type('RoadLink', '<element name="centrelineGeometry" type="gml:CurvePropertyType"/><element name="startPoint" type="gml:PointPropertyType"/>'),
      ),
    );
    const by = Object.fromEntries(c.types.map((t) => [t.code, t]));
    expect(by.CadastralParcel.geometry).toEqual(['Polygon']);
    expect(by.CadastralParcel.attributes).toEqual(['label']);
    expect(by.Building.geometry).toBeUndefined();
    expect(by.Building.attributes).toEqual(['height']);
    expect(by.RoadLink.geometry).toEqual(['LineString']);
    expect(by.RoadLink.attributes).toEqual([]);
    expect(() => validateCatalog(c)).not.toThrow();
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
  it('takes the fields of a preset named as {preset}, and stops at a loop', () => {
    const presets = {
      'amenity/restaurant': { name: 'Restaurant', geometry: ['point'], tags: { amenity: 'restaurant' }, fields: ['cuisine', '{amenity/fast_food}'] },
      'amenity/fast_food': { name: 'Fast Food', geometry: ['point'], tags: { amenity: 'fast_food' }, fields: ['{amenity/restaurant}', 'drive_through'] },
    };
    const fields = { cuisine: { key: 'cuisine', type: 'combo', options: ['pizza', 'burger'] }, drive_through: { key: 'drive_through', type: 'check' } };
    const c = validateCatalog(fromIdPresets(presets, fields));
    const of = (code) => c.types.find((t) => t.code === code).attributes;
    // The loop ends: the preset resolved first takes both lists; the one met inside the loop its own.
    expect(of('amenity/restaurant')).toEqual(['amenity', 'cuisine', 'drive_through']);
    expect(of('amenity/fast_food')).toEqual(['amenity', 'drive_through']);
  });
  it('gives a preset with no fields of its own its parent\'s', () => {
    const presets = {
      'amenity/fast_food': { name: 'Fast Food', geometry: ['point'], tags: { amenity: 'fast_food' }, fields: ['drive_through'] },
      'amenity/fast_food/burger': { name: 'Burger', geometry: ['point'], tags: { amenity: 'fast_food', cuisine: 'burger' } },
    };
    const c = validateCatalog(fromIdPresets(presets, { drive_through: { key: 'drive_through', type: 'check' } }));
    expect(c.types.find((t) => t.code === 'amenity/fast_food/burger').attributes).toEqual(['amenity', 'cuisine', 'drive_through']);
    // fields and moreFields fall back each on its own, and a list of only unknown ids is a list of none.
    const more = validateCatalog(
      fromIdPresets(
        {
          'amenity/fast_food': { name: 'Fast Food', geometry: ['point'], tags: { amenity: 'fast_food' }, fields: ['drive_through'], moreFields: ['opening_hours'] },
          'amenity/fast_food/burger': { name: 'Burger', geometry: ['point'], tags: { amenity: 'fast_food', cuisine: 'burger' }, moreFields: ['takeaway'] },
          'amenity/fast_food/pizza': { name: 'Pizza', geometry: ['point'], tags: { amenity: 'fast_food', cuisine: 'pizza' }, fields: ['no_such_field'] },
        },
        { drive_through: { key: 'drive_through', type: 'check' }, opening_hours: { key: 'opening_hours', type: 'text' }, takeaway: { key: 'takeaway', type: 'check' } },
      ),
    );
    const of = (code) => more.types.find((t) => t.code === code).attributes;
    expect(of('amenity/fast_food/burger')).toEqual(['amenity', 'cuisine', 'drive_through', 'takeaway']);
    expect(of('amenity/fast_food/pizza')).toEqual(['amenity', 'cuisine', 'drive_through', 'opening_hours']);
    // References that converge (each preset naming the next twice), with a loop back to the first, are
    // walked once each: 2^40 walks would never end.
    const chain = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, { name: `P${i}`, geometry: ['point'], tags: { k: `v${i}` }, fields: i < 39 ? [`{p${i + 1}}`, `{p${i + 1}}`] : ['{p0}', 'drive_through'] }]));
    const deep = fromIdPresets(chain, { drive_through: { key: 'drive_through', type: 'check' } });
    expect(deep.types[0].attributes).toEqual(['k', 'drive_through']);
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
    // ISO 19107 multi, composite and orientable types, and their GML property types, keep their kind.
    expect(['GM_MultiSurface', 'GM_MultiCurve', 'GM_MultiPoint', 'GM_CompositeCurve', 'GM_OrientableSurface'].map(attrType)).toEqual(['geometry:Polygon', 'geometry:LineString', 'geometry:Point', 'geometry:LineString', 'geometry:Polygon']);
    expect(['gml:MultiPointPropertyType', 'gml:CompositeCurvePropertyType', 'gml:CompositeSurfacePropertyType'].map(attrType)).toEqual(['geometry:Point', 'geometry:LineString', 'geometry:Polygon']);
    // A geometry of no single kind is still a geometry, never a text attribute.
    expect(['GM_Solid', 'gml:MultiGeometryPropertyType', 'gml:SolidPropertyType', 'gml:GeometryPropertyType'].map(attrType)).toEqual(['geometry:', 'geometry:', 'geometry:', 'geometry:']);
    expect(['Point', 'Surface'].map(attrType)).toEqual(['text', 'text']);
    // Every XSD integer derivation, and the GML and ISO 19103 measure types (a speed limit is gml:VelocityType).
    expect(['xs:unsignedShort', 'xs:unsignedLong', 'xs:negativeInteger', 'xs:nonPositiveInteger', 'UnlimitedInteger'].map(attrType)).toEqual(Array(5).fill('integer'));
    expect(['gml:VelocityType', 'gml:SpeedType', 'gml:VolumeType', 'gml:ScaleType', 'Volume', 'gml:GridLengthType'].map(attrType)).toEqual(Array(6).fill('real'));
    expect(['xs:time', 'xs:dateTime'].map(attrType)).toEqual(['text', 'text']);
    // An INSPIRE data type that wraps a geometry is geometry, not text.
    expect(['bu-core2d:BuildingGeometry2DPropertyType', 'ad:GeographicPositionPropertyType'].map(attrType)).toEqual(['geometry:', 'geometry:']);
    // The rest of GML 3.2's geometry property types (GM_Primitive is gml:GeometricPrimitivePropertyType).
    expect(['gml:GeometricPrimitivePropertyType', 'gml:GeometricComplexPropertyType', 'gml:GeometricAggregatePropertyType'].map(attrType)).toEqual(['geometry:', 'geometry:', 'geometry:']);
    expect(['gml:PolyhedralSurfacePropertyType', 'gml:TriangulatedSurfacePropertyType', 'gml:TinPropertyType'].map(attrType)).toEqual(Array(3).fill('geometry:Polygon'));
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
  it('keeps a new feature empty after a GeoPackage round trip, and TDS layers keep their codes', () => {
    const layer = (domain) => ({ name: 'roads', table: 'roads', fields: [{ name: 'surface', type: 'text', domain }], features: [{ attrs: {}, geom: { type: 'LineString' } }] });
    expect(catalogFromLayers('a', [layer({ paved: 'Paved', gravel: 'Gravel' })]).nulls).toEqual({ text: '', enum: '', number: null });
    expect(catalogFromLayers('b', [layer({ '-999999': 'No Information', 1: 'Paved' })]).nulls.enum).toBe('-999999');
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
