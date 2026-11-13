// Civil feature catalogues into gw-catalog/1 (REQ-GAP-87, SDP-2.7 §4.13): converters for the
// catalogues users bring — an ISO 19110 feature catalogue (XML), an INSPIRE application schema
// (its XSD, with the code lists it uses as registry XML), and OpenStreetMap presets in the iD
// editor's form (presets.json with fields.json). Each gives a catalogue that vector/schema.js
// validateCatalog accepts. Pure: no DOM, so they run in Node too (the i18n module only names the errors). Files are data: nothing in them
// is run, and no URL in them is fetched.

import { parseXml, all, kids, attr } from '../connectors/xml.js';
import { gwError } from '../i18n/index.js';

const E = (msg, params = null) => gwError(msg, params, 'E_CATALOG_CONVERT');

// Bounds on what a picked file can make the converters read or build. The type and attribute
// limits are validateCatalog's; a converter stops at them instead of building past them.
const MAX_TEXT = 64 << 20; // characters, all files together
const MAX_FILES = 200; // an INSPIRE theme is a schema and a few dozen code lists
const MAX_TYPES = 5000;
const MAX_ATTRS = 50000;
const MAX_VALUES = 20000; // values in one coded domain
// These formats have no "no information" codes like TDS's -999999: a new feature starts empty.
const EMPTY_NULLS = { text: '', enum: '', number: null };
const capTypes = (types) => {
  if (types.length >= MAX_TYPES) throw E('the catalogue has more than {n} feature types', { n: String(MAX_TYPES) });
};
const capValues = (n, what) => {
  if (n > MAX_VALUES) throw E('{what} has more than {n} values', { what, n: String(MAX_VALUES) });
};
/** parseXml, with malformed XML refused as a conversion error. */
const xmlOf = (text) => {
  try {
    return parseXml(text);
  } catch (e) {
    throw E('the file is not well-formed XML ({msg})', { msg: e.message });
  }
};

const clean = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
/** The text of an element or of its first descendant that has text (ISO wraps values in gco:CharacterString). */
function deepText(el) {
  if (!el) return '';
  if (clean(el.text)) return clean(el.text);
  for (const c of el.children ?? []) {
    const t = deepText(c);
    if (t) return t;
  }
  return '';
}
const first = (el, name) => (el?.children ?? []).find((c) => c.name === name) ?? null;
/** The element called `name`: the root itself (parseXml returns it) or the first below it. */
const find = (doc, name) => (doc?.name === name ? doc : (all(doc, name)[0] ?? null));
const safeId = (s, fallback) => (clean(s).replace(/[^\w.:@-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback);
const BAD_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
// Every feature already has these (its own name, description and UFI, and a GeoPackage's fid and
// geom): an attribute of the same name would be dropped on export, so it is kept as name_attr.
const FEATURE_COLUMNS = new Set(['fid', 'geom', 'name', 'description', 'ufi']);

/** ISO 19103 / XSD value type → a gw-catalog attribute type, or 'geometry', or null (not an attribute). */
export function attrType(t) {
  const s = String(t ?? '')
    .replace(/^.*:/, '')
    .toLowerCase();
  const g = s.match(/^gm_(?:multi|composite|orientable)?(point|curve|linestring|surface|polygon)$/) ?? s.match(/^(?:multi|composite|orientable)?(point|curve|linestring|surface|polygon)(?:property)?type$/);
  if (g) return { point: 'geometry:Point', curve: 'geometry:LineString', linestring: 'geometry:LineString', surface: 'geometry:Polygon', polygon: 'geometry:Polygon' }[g[1]];
  if (/^(?:polyhedral|triangulated)surface(?:property)?type$|^tin(?:property)?type$/.test(s)) return 'geometry:Polygon';
  if (/^gm_|^(?:multi|composite)?(?:geometry|solid|primitive)(?:property)?type$|^geometric(?:primitive|complex|aggregate)(?:property)?type$/.test(s)) return 'geometry:';
  if (/(?:geometry|geographicposition)\w*propertytype$/.test(s)) return 'geometry:';
  if (/^(boolean)$/.test(s)) return 'boolean';
  if (/^(integer|int|long|short|byte|(non)?(positive|negative)integer|unsigned(byte|short|int|long)|unlimitedinteger)$/.test(s)) return 'integer';
  if (/^(real|double|float|decimal|number|(measure|length|area|angle|distance|velocity|speed|volume|scale|gridlength)(type)?)$/.test(s)) return 'real';
  return 'text';
}

/**
 * A feature type's geometry kinds from its geometry-valued properties ([name, attrType]): the primary
 * one's, the one named geometry or else the first. Another (a parcel's reference point) does not let
 * the type hold a second kind; a primary one of no known kind restricts nothing.
 */
function primaryGeometry(props) {
  const p = props.find(([n]) => /^geometry$/i.test(n)) ?? props[0];
  return p && p[1].length > 9 ? [p[1].slice(9)] : [];
}

/** Attributes shared by types: one entry per name, or a type-qualified one when a definition differs. */
function attrTable() {
  const attrs = {};
  let n = 0;
  const add = (name, a, typeCode) => {
    let key = clean(name);
    if (!key || BAD_NAMES.has(key)) return null;
    if (FEATURE_COLUMNS.has(key.toLowerCase())) key = `${key}_attr`;
    const prev = attrs[key];
    if (prev && JSON.stringify({ ...prev, label: '' }) !== JSON.stringify({ ...a, label: '' })) key = `${key}_${typeCode}`;
    if (BAD_NAMES.has(key)) return null;
    if (!attrs[key] && ++n > MAX_ATTRS) throw E('the catalogue has more than {n} attributes', { n: String(MAX_ATTRS) });
    attrs[key] ??= a;
    return key;
  };
  return { attrs, add };
}

/**
 * An ISO 19110 feature catalogue (FC_FeatureCatalogue, XML) → gw-catalog/1. Feature types are
 * FC_FeatureType; their FC_FeatureAttribute entries become attributes, typed by valueType, with a
 * coded domain where they list FC_ListedValue; a geometry-valued attribute sets the type's geometry.
 */
export function fromIso19110(xml, { id = '', name = '' } = {}) {
  const doc = xmlOf(xml);
  const root = find(doc, 'FC_FeatureCatalogue');
  if (!root) throw E('not an ISO 19110 feature catalogue (no FC_FeatureCatalogue)');
  const title = deepText(first(root, 'name')) || name || 'ISO 19110 catalogue';
  const { attrs, add } = attrTable();
  const types = [];
  const fts = all(root, 'FC_FeatureType');
  const byId = new Map(fts.filter((ft) => attr(ft, 'id')).map((ft) => [attr(ft, 'id'), ft]));
  /** A type's attributes: its supertypes' first (inheritsFrom, by xlink:href to their id), then its own. */
  const attributesOf = (ft, seen = new Set()) => {
    if (seen.has(ft)) return [];
    seen.add(ft);
    const sups = all(ft, 'inheritsFrom').flatMap((r) => all(r, 'supertype')).map((x) => byId.get(String(attr(x, 'href') ?? '').replace(/^#/, ''))).filter(Boolean);
    // A supertype's own attributes, not those of a type nested inside an inheritance relation.
    const own = all(ft, 'FC_FeatureAttribute').filter((fa) => !all(ft, 'inheritsFrom').some((r) => all(r, 'FC_FeatureAttribute').includes(fa)));
    return [...sups.flatMap((x) => attributesOf(x, seen)), ...own];
  };
  for (const ft of fts) {
    if (/^(true|1)$/i.test(deepText(first(ft, 'isAbstract')))) continue;
    capTypes(types);
    const typeName = deepText(first(ft, 'typeName'));
    const code = deepText(first(ft, 'code')) || typeName;
    if (!code) continue;
    const geoms = [];
    const names = [];
    for (const fa of attributesOf(ft)) {
      const member = deepText(first(fa, 'memberName'));
      const t = attrType(deepText(first(fa, 'valueType')));
      if (t.startsWith('geometry:')) {
        geoms.push([member, t]);
        continue;
      }
      const listed = all(fa, 'FC_ListedValue').map((v) => [deepText(first(v, 'code')) || deepText(first(v, 'label')), deepText(first(v, 'label')) || deepText(first(v, 'code'))]).filter(([c]) => c);
      capValues(listed.length, member);
      const a = { label: member, type: listed.length ? 'enum' : t, ...(listed.length ? { domain: Object.fromEntries(listed) } : {}) };
      const def = deepText(first(fa, 'definition'));
      if (def) a.definition = def;
      const card = deepText(first(fa, 'cardinality'));
      if (/^1(\.\.|$)/.test(card)) a.required = true;
      const key = add(member, a, code);
      if (key && !names.includes(key)) names.push(key);
    }
    const def = deepText(first(ft, 'definition'));
    const geometry = primaryGeometry(geoms);
    types.push({ code, name: typeName || code, ...(geometry.length ? { geometry } : {}), attributes: names, ...(def ? { definition: def } : {}) });
  }
  if (!types.length) throw E('the ISO 19110 catalogue has no feature types');
  return { format: 'gw-catalog/1', id: safeId(id || title, 'iso19110'), name: title, version: deepText(first(root, 'versionNumber')) || '1', source: 'ISO 19110', nulls: EMPTY_NULLS, attributes: attrs, types };
}

/** A code list as the INSPIRE registry writes it (XML) → {id, name, values: {code: label}}. */
export function parseCodeList(xml) {
  const doc = xmlOf(xml);
  const cl = find(doc, 'codelist') ?? find(doc, 'CodeList');
  if (!cl) throw E('not an INSPIRE code list (no codelist element)');
  const uri = cl.attrs?.id ?? '';
  const id = uri.replace(/\/+$/, '').split('/').pop() || deepText(first(cl, 'label'));
  const values = {};
  for (const v of all(cl, 'value')) {
    const code = String(v.attrs?.id ?? '')
      .replace(/\/+$/, '')
      .split('/')
      .pop();
    if (code && !BAD_NAMES.has(code)) values[code] = deepText(first(v, 'label')) || code;
  }
  capValues(Object.keys(values).length, id || 'the code list');
  return { id, name: deepText(first(cl, 'label')) || id, values };
}

/**
 * An INSPIRE application schema (one or more XSD texts) with code lists → gw-catalog/1. Feature
 * types are the concrete elements that substitute for gml:AbstractFeature, directly or through abstract
 * elements of these schemas; their properties come from
 * their complex type's sequence, after those of the types it extends (INSPIRE keeps the geometry
 * and the identifier in abstract base types). A property typed gml:ReferenceType takes the code list whose name,
 * without "Value", is the property's name (INSPIRE's own naming: surfaceComposition →
 * SurfaceCompositionValue), or the one its annotation names (targetCodeList); one that names a list
 * not imported stays as text. Voidable and optional properties are not required.
 */
export function fromInspire(xsds, codeLists = [], { id = '', name = '' } = {}) {
  const lists = new Map(codeLists.map((c) => [c.id.replace(/Value$/, '').toLowerCase(), c]));
  // Named components by namespace and local name: an extension schema may reuse a name (bu-ext2d:Building
  // substitutes for bu-core2d:Building). Each keeps its schema's prefixes, to resolve the QNames it uses.
  const complex = new Map();
  const elements = new Map();
  const byLocal = { complex: new Map(), elements: new Map() };
  let target = '';
  for (const x of [].concat(xsds)) {
    const doc = xmlOf(x);
    const schema = find(doc, 'schema');
    if (!schema) throw E('not an XML Schema (no schema element)');
    const ns = schema.attrs?.targetNamespace ?? '';
    target ||= ns;
    const keep = (kind, map, node) => {
      const entry = { node, ns, scope: schema.attrs ?? {} };
      map.set(`${ns}|${node.attrs.name}`, entry);
      const list = byLocal[kind].get(node.attrs.name) ?? [];
      byLocal[kind].set(node.attrs.name, [...list, entry]);
    };
    for (const ct of kids(schema, 'complexType')) if (ct.attrs?.name) keep('complex', complex, ct);
    for (const el of kids(schema, 'element')) if (el.attrs?.name) keep('elements', elements, el);
  }
  /** The component a QName names, read with the prefixes of the schema it appears in (`from`). A prefix
   * the schema does not declare falls back to the local name, never to the component itself; a declared
   * one whose namespace is not among these schemas names nothing (as gml does). */
  const resolve = (kind, qname, from) => {
    if (!qname) return null;
    const q = String(qname);
    const at = q.indexOf(':');
    const pfx = at < 0 ? '' : q.slice(0, at);
    const name = at < 0 ? q : q.slice(at + 1);
    const ns = pfx ? from.scope[`xmlns:${pfx}`] : from.scope.xmlns;
    if (ns !== undefined) {
      const hit = (kind === 'complex' ? complex : elements).get(`${ns}|${name}`);
      return hit && hit.node !== from.node ? hit : null;
    }
    return (byLocal[kind].get(name) ?? []).find((e) => e.node !== from.node) ?? null;
  };
  /** Whether an element substitutes for gml:AbstractFeature, directly or through other elements of these schemas. */
  const isFeature = (entry, seen = new Set()) => {
    const group = entry.node.attrs?.substitutionGroup;
    if (!group || seen.has(entry)) return false;
    seen.add(entry);
    if (/AbstractFeature$/.test(group)) return true;
    const up = resolve('elements', group, entry);
    if (up) return isFeature(up, seen);
    // A head in a schema not given here (tn:TransportLink for a RoadLink, with TransportNetworks.xsd
    // left out) is taken to be a feature's; only GML's own heads (AbstractObject) are not.
    const at = String(group).indexOf(':');
    const ns = at < 0 ? entry.scope.xmlns : entry.scope[`xmlns:${String(group).slice(0, at)}`];
    return !!ns && !/opengis\.net\/gml/.test(ns);
  };
  let features = [...elements.values()].filter((e) => e.node.attrs?.abstract !== 'true' && isFeature(e));
  // An extension that re-declares a type under the same name (ext2d's Building for core2d's) replaces
  // it; a differently named subtype (Motorway for Road) does not.
  const replaced = new Set(features.map((e) => [e, resolve('elements', e.node.attrs.substitutionGroup, e)]).filter(([e, up]) => up && up.node.attrs.name === e.node.attrs.name).map(([, up]) => up));
  features = features.filter((e) => !replaced.has(e));
  if (features.length > MAX_TYPES) throw E('the catalogue has more than {n} feature types', { n: String(MAX_TYPES) });
  // A name two schemas both define (core2d's and core3d's Building) is qualified by its schema's prefix.
  const prefixOf = (e) => Object.entries(e.scope).find(([k, v]) => k.startsWith('xmlns:') && v === e.ns)?.[0].slice(6) || e.ns.replace(/\/+$/, '').split(/[/:]/).pop() || 'ns';
  const shared = new Set(features.map((e) => e.node.attrs.name).filter((n, i, all) => all.indexOf(n) !== i));
  const codeOf = (e) => (shared.has(e.node.attrs.name) ? `${prefixOf(e)}:${e.node.attrs.name}` : e.node.attrs.name);
  /** A type's properties: its bases' first, then its own; a base outside these schemas (gml) adds none. */
  const props = (entry, seen = new Set()) => {
    if (!entry || seen.has(entry)) return [];
    seen.add(entry);
    return [...props(resolve('complex', find(entry.node, 'extension')?.attrs?.base, entry), seen), ...all(entry.node, 'element')];
  };
  const { attrs, add } = attrTable();
  const types = [];
  for (const entry of features) {
    const code = codeOf(entry);
    const geoms = [];
    const names = [];
    for (const p of props(resolve('complex', entry.node.attrs.type, entry))) {
      const pname = p.attrs?.name;
      if (!pname) continue;
      // A voidable property carries its type in an anonymous simpleContent extension (base="integer"
      // with a nilReason attribute), not in @type.
      const ptype = String(p.attrs?.type ?? find(p, 'extension')?.attrs?.base ?? find(p, 'restriction')?.attrs?.base ?? '');
      const t = attrType(ptype);
      if (t.startsWith('geometry:')) {
        geoms.push([pname, t]);
        continue;
      }
      // A reference to a code list names it in its annotation (targetCodeList), else by the property's name;
      // a reference with neither is a link to another feature.
      const ref = /ReferenceType$/.test(ptype);
      const target = ref ? deepText(find(p, 'targetCodeList')).replace(/^.*[:/#]/, '') : '';
      const list = ref ? lists.get((target || pname).replace(/Value$/, '').toLowerCase()) : null;
      if (ref && !list && !target) continue;
      // A code list the import was not given keeps the property, as text, and says which list it needs.
      const a = list ? { label: pname, type: 'enum', domain: list.values, definition: list.name } : ref ? { label: pname, type: 'text', definition: `${target} (code list not imported)` } : { label: pname, type: t };
      if (Number(p.attrs?.minOccurs ?? 1) >= 1 && p.attrs?.nillable !== 'true') a.required = true;
      const key = add(pname, a, code);
      if (key && !names.includes(key)) names.push(key);
    }
    const geometry = primaryGeometry(geoms);
    types.push({ code, name: code.replace(/([a-z])([A-Z])/g, '$1 $2'), ...(geometry.length ? { geometry } : {}), attributes: names });
  }
  if (!types.length) throw E('the schema defines no feature types (no element in the gml:AbstractFeature group)');
  const title = name || target.replace(/\/+$/, '').split('/').slice(-2).join(' ') || 'INSPIRE application schema';
  return { format: 'gw-catalog/1', id: safeId(id || `inspire-${title}`, 'inspire'), name: title, version: '1', source: 'INSPIRE application schema', nulls: EMPTY_NULLS, attributes: attrs, types };
}

const ID_GEOMETRY = { point: 'Point', vertex: 'Point', line: 'LineString', area: 'Polygon' };

/**
 * OpenStreetMap presets as the iD editor keeps them (presets.json, fields.json: objects keyed by
 * id) → gw-catalog/1. OSM's tags are open key=value pairs: each preset becomes a type whose
 * attributes are its fields' keys and its own tag keys, with one subtype that fixes its tags
 * (amenity=cafe). A combo field with options becomes a coded domain, a check field yes/no, a number
 * field real; anything else is text. Other tags stay free: a feature may carry keys the catalogue
 * does not name.
 */
export function fromIdPresets(presets, fields = {}, { id = 'osm-presets', name = 'OpenStreetMap presets' } = {}) {
  const attrs = {};
  let n = 0;
  const attrFor = (key, f) => {
    if (!key || BAD_NAMES.has(key) || /[{}]/.test(key)) return null;
    if (FEATURE_COLUMNS.has(key.toLowerCase())) key = `${key}_attr`;
    if (attrs[key]) return key;
    if (++n > MAX_ATTRS) throw E('the catalogue has more than {n} attributes', { n: String(MAX_ATTRS) });
    const label = clean(f?.label ?? key);
    const opts = f?.options ?? (f?.strings?.options ? Object.keys(f.strings.options) : null);
    if (Array.isArray(opts)) capValues(opts.length, key);
    if ((f?.type === 'check' || f?.type === 'onewayCheck') && !opts) attrs[key] = { label, type: 'enum', domain: { yes: 'yes', no: 'no' } };
    else if (Array.isArray(opts) && opts.length && /combo|radio/.test(f?.type ?? '')) attrs[key] = { label, type: 'enum', domain: Object.fromEntries(opts.filter((o) => !BAD_NAMES.has(String(o))).map((o) => [String(o), clean(f.strings?.options?.[o]?.title ?? f.strings?.options?.[o] ?? o)])) };
    else if (f?.type === 'number') attrs[key] = { label, type: 'real' };
    else attrs[key] = { label, type: 'text' };
    return key;
  };
  const types = [];
  for (const [pid, p] of Object.entries(presets ?? {})) {
    if (!p || typeof p !== 'object' || !p.tags || typeof p.tags !== 'object' || p.searchable === false) continue;
    capTypes(types);
    // A built presets.json may leave names to its translation files: the id's last part then names it.
    const nm = clean(p.name) || pid.split('/').pop().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const arr = (x) => (Array.isArray(x) ? x : []);
    const geometry = [...new Set(arr(p.geometry).map((g) => ID_GEOMETRY[g]).filter(Boolean))];
    if (!geometry.length) continue;
    const names = [];
    const fixed = {};
    for (const [k, v] of Object.entries(p.tags)) {
      const key = attrFor(k, fields[k] ?? null);
      if (!key) continue;
      names.push(key);
      if (v !== '*' && typeof v === 'string') fixed[key] = v;
    }
    // A '{preset}' entry takes that preset's fields, as iD does.
    const fieldIds = (q, seen) =>
      [...arr(q.fields), ...arr(q.moreFields)].flatMap((fid) => {
        const m = /^\{(.+)\}$/.exec(String(fid));
        if (!m) return [fid];
        if (seen.has(m[1]) || !Object.hasOwn(presets, m[1])) return [];
        seen.add(m[1]);
        return fieldIds(presets[m[1]] ?? {}, seen);
      });
    for (const fid of fieldIds(p, new Set([pid]))) {
      const f = Object.hasOwn(fields, fid) ? fields[fid] : null;
      const key = typeof f?.key === 'string' ? attrFor(f.key, f) : null;
      if (key && !names.includes(key)) names.push(key);
    }
    // A fixed tag outside a coded domain is still a value the subtype sets.
    for (const k of Object.keys(fixed)) if (attrs[k].type === 'enum' && !Object.hasOwn(attrs[k].domain, fixed[k])) attrs[k].domain[fixed[k]] = fixed[k];
    types.push({ code: pid, name: nm, geometry, attributes: names, subtypes: [{ code: pid, name: nm, fixed }] });
  }
  if (!types.length) throw E('no presets with a name, tags and a point, line or area geometry');
  return { format: 'gw-catalog/1', id: safeId(id, 'osm-presets'), name, version: '1', source: 'OpenStreetMap iD presets', nulls: EMPTY_NULLS, attributes: attrs, types };
}

/** JSON with no prototype keys. */
const safeJson = (text, what) => {
  try {
    return JSON.parse(text, (k, v) => (BAD_NAMES.has(k) ? undefined : v));
  } catch (e) {
    throw E('{file} is not JSON ({msg})', { file: what, msg: e.message });
  }
};

/**
 * The files a user picked ([{name, text}]) → one gw-catalog/1 object (not yet validated): a
 * gw-catalog/1 JSON as it is; an ISO 19110 XML; INSPIRE XSDs with the code lists they use; or iD
 * presets.json with its fields.json. Refuses a mix, or a code list or fields.json on its own.
 */
export function catalogFromFiles(files) {
  if (files.length > MAX_FILES) throw E('choose at most {n} files', { n: String(MAX_FILES) });
  if (files.reduce((k, f) => k + String(f.text ?? '').length, 0) > MAX_TEXT) throw E('the files are larger than {n} MB together', { n: String(MAX_TEXT >> 20) });
  const by = { iso19110: [], 'inspire-xsd': [], codelist: [], 'id-presets': [], 'id-fields': [], 'gw-catalog': [] };
  for (const f of files) {
    const kind = sniffCatalog(f.name, f.text);
    if (!kind) throw E('{file} is not a feature catalogue this app reads (ISO 19110, INSPIRE XSD or code list, iD presets or fields, gw-catalog/1)', { file: f.name });
    by[kind].push(f);
  }
  const used = Object.entries(by).filter(([, v]) => v.length).map(([k]) => k);
  const one = (k) => {
    if (by[k].length > 1) throw E('choose one {kind} file at a time', { kind: { iso19110: 'ISO 19110', 'id-presets': 'presets.json', 'id-fields': 'fields.json' }[k] ?? 'gw-catalog/1' });
    return by[k][0];
  };
  const stem = (n) => String(n).replace(/(\.min)?\.(xml|xsd|json)$/i, '');
  if (used.length === 1 && used[0] === 'gw-catalog') return safeJson(one('gw-catalog').text, one('gw-catalog').name);
  if (used.length === 1 && used[0] === 'iso19110') return fromIso19110(one('iso19110').text, { name: stem(one('iso19110').name) });
  if (used.every((k) => k === 'inspire-xsd' || k === 'codelist')) {
    if (!by['inspire-xsd'].length) throw E('a code list needs the application schema (.xsd) that uses it');
    return fromInspire(by['inspire-xsd'].map((f) => f.text), by.codelist.map((f) => parseCodeList(f.text)));
  }
  if (used.every((k) => k === 'id-presets' || k === 'id-fields')) {
    if (!by['id-presets'].length) throw E('fields.json needs the presets.json that uses it');
    const fields = by['id-fields'].length ? safeJson(one('id-fields').text, one('id-fields').name) : {};
    return fromIdPresets(safeJson(one('id-presets').text, one('id-presets').name), fields);
  }
  throw E('these files are catalogues of different kinds: import one kind at a time');
}

/** Which converter a file needs, from its name and first bytes: 'iso19110' | 'inspire-xsd' | 'codelist' | 'id-presets' | 'id-fields' | 'gw-catalog' | null. */
export function sniffCatalog(name, head) {
  const n = String(name ?? '').toLowerCase();
  const h = String(head ?? '').slice(0, 4096);
  if (/FC_FeatureCatalogue/.test(h)) return 'iso19110';
  if (/<(\w+:)?schema[\s>]/.test(h) && /\.xsd$/.test(n)) return 'inspire-xsd';
  if (/<(\w+:)?codelist[\s>]/i.test(h)) return 'codelist';
  if (/gw-catalog\/1/.test(h)) return 'gw-catalog';
  if (/fields\.(min\.)?json$/.test(n)) return 'id-fields';
  if (/presets\.(min\.)?json$/.test(n)) return 'id-presets';
  return /\.json$/.test(n) ? 'gw-catalog' : null;
}
