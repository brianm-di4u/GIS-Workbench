// Feature schemas (REQ-EXT-09/10, D11): an open JSON catalogue — the shipped TDS 7.1 subset or one
// imported from a GeoPackage — gives each feature class its attributes with types, coded domains,
// ranges, units, TDS null values, required flags and auto-attribution rules. Value checks name the
// attribute and its allowed values (AC-10.3). The MGCP cross-walk renames codes and attributes on
// export.

import CATALOG from '../data/feature-catalog-subset.json';
import { gwError } from '../i18n/index.js';

export const DEFAULT_CATALOG = CATALOG;
const catalogs = new Map([[CATALOG.id, CATALOG]]);

export function registerCatalog(c) {
  catalogs.set(c.id, c);
  return c;
}
export function getCatalog(id = CATALOG.id) {
  return catalogs.get(id) ?? null;
}
export function listCatalogs() {
  return [...catalogs.values()];
}
export function unregisterCatalog(id) {
  if (id !== CATALOG.id) catalogs.delete(id);
}

export function typeOf(cat, code) {
  return cat?.types.find((t) => t.code === code) ?? null;
}

// ---- the open catalogue format (gw-catalog/1; REQ-GAP-52/53) ----
//
//   {format: 'gw-catalog/1', id, name, version, source, licence?, nulls?,
//    attributes: {NAME: {label, type: text|real|integer|enum|boolean, domain?: {code: label},
//                        range?: [min, max], unit?, length?, required?, definition?, auto?, field?}},
//    types: [{code, name, geometry: [..], attributes: [NAME..], definition?,
//             subtypeField?, subtypes?: [{code, name, attributes?: [NAME..], fixed?: {NAME: v},
//                                         domains?: {NAME: [codes]}, definition?}],
//             rules?: [RULE]}],
//    rules?: [RULE], crosswalk?: {...}}
//
//   RULE = {id, when: COND, then: {require?: [NAME], forbid?: [NAME], domain?: {NAME: [codes]},
//           range?: {NAME: [min, max]}}, message?}
//   COND = {field, op: = ≠ < > ≤ ≥ in notIn isNull notNull, value?} | {all: [COND]} | {any: [COND]} | {not: COND}
//
// "require": the attribute must have a value (not the TDS null) when the condition holds;
// "forbid": it must be the null; "domain": a contingent domain (only these codes are allowed);
// "range": a contingent range. A type's rules apply to its features; catalogue rules to all
// (a rule may name `classes: [codes]`). Subtypes add attributes, fix values and narrow domains.
// "field": the column a layer writes for the attribute, where it differs from NAME (a property two
// types define differently keeps one NAME each, decision #243); a type writes each column once.
// Rules, subtypes and subtypeField name attributes by NAME; they apply to the column NAME writes.

export const CATALOG_FORMAT = 'gw-catalog/1';
const ATTR_TYPES = new Set(['text', 'real', 'integer', 'enum', 'boolean']);
const COND_OPS = new Set(['=', '≠', '!=', '<', '>', '≤', '<=', '≥', '>=', 'in', 'notIn', 'isNull', 'notNull']);
const MAX_TYPES = 5000;
const MAX_ATTRS = 50000;

const bad = (msg, params) => gwError(msg, params, 'E_CATALOG_INVALID');

/**
 * Where an attribute definition goes in a catalogue's attribute table (decision #243): under its
 * column name, or, when another type already defines that column differently, under a key of the
 * type's own that names the column in `field`. Returns {key, entry}; the caller stores the entry.
 * A key already holding another definition (or a source attribute of that name) is passed over.
 */
export function attributeKey(attributes, column, a, typeCode) {
  const same = (x, y) => JSON.stringify({ ...x, label: '' }) === JSON.stringify({ ...y, label: '' });
  if (!attributes[column] || same(attributes[column], a)) return { key: column, entry: a };
  const entry = { ...a, field: column };
  let key = `${column}_${typeCode}`;
  for (let i = 2; attributes[key] && !same(attributes[key], entry); i++) key = `${column}_${typeCode}_${i}`;
  return { key, entry };
}

/** The layer column an attribute key writes: its `field`, else the key (decision #243). */
export const columnOf = (cat, key) => cat?.attributes?.[key]?.field ?? key;

/** A rule's key → the column it means for one type: its `field` only when the type (or subtype) has the key. */
function columnsOf(cat, schema) {
  const t = typeOf(cat, schema?.code);
  const own = new Set([...(t?.attributes ?? []), ...(subtypeOf(cat, schema?.code, schema?.subtype)?.attributes ?? [])]);
  return (key) => (own.has(key) ? columnOf(cat, key) : key);
}

function checkCond(c, where, attrs) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('{where}: a rule condition must be an object', { where });
  if (c.all || c.any) {
    const list = c.all ?? c.any;
    if (!Array.isArray(list) || !list.length) throw bad('{where}: "all" and "any" take a non-empty list', { where });
    list.forEach((x) => checkCond(x, where, attrs));
    return;
  }
  if (c.not) return checkCond(c.not, where, attrs);
  if (typeof c.field !== 'string' || !attrs[c.field]) throw bad('{where}: condition on an unknown attribute {field}', { where, field: String(c.field) });
  if (!COND_OPS.has(c.op ?? '=')) throw bad('{where}: unknown operator {op}', { where, op: String(c.op) });
  if ((c.op === 'in' || c.op === 'notIn') && !Array.isArray(c.value)) throw bad('{where}: "{op}" takes a list of values', { where, op: c.op });
}

function checkRule(r, where, attrs) {
  if (!r || typeof r !== 'object') throw bad('{where}: a rule must be an object', { where });
  checkCond(r.when, where, attrs);
  const th = r.then;
  if (!th || typeof th !== 'object') throw bad('{where}: a rule needs "then"', { where });
  for (const k of ['require', 'forbid']) {
    if (th[k] === undefined) continue;
    if (!Array.isArray(th[k])) throw bad('{where}: "{key}" takes a list of attributes', { where, key: k });
    for (const n of th[k]) if (!attrs[n]) throw bad('{where}: "{key}" names an unknown attribute {field}', { where, key: k, field: String(n) });
  }
  for (const [n, codes] of Object.entries(th.domain ?? {})) {
    const a = attrs[n];
    if (!a?.domain) throw bad('{where}: a contingent domain on {field}, which has no coded domain', { where, field: n });
    if (!Array.isArray(codes)) throw bad('{where}: the contingent domain of {field} must be a list of codes', { where, field: n });
    for (const v of codes) if (!(String(v) in a.domain)) throw bad('{where}: {value} is not a code of {field}', { where, value: String(v), field: n });
  }
  for (const [n, rg] of Object.entries(th.range ?? {})) {
    if (!attrs[n]) throw bad('{where}: a contingent range on an unknown attribute {field}', { where, field: n });
    if (!Array.isArray(rg) || rg.length !== 2 || !rg.every(Number.isFinite)) throw bad('{where}: the range of {field} must be [min, max]', { where, field: n });
  }
}

/**
 * Check a catalogue file (gw-catalog/1, or the older subset layout without `format`) and return
 * a normalised copy, or throw an error (code E_CATALOG_INVALID) naming the first problem.
 */
export function validateCatalog(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw bad('a feature catalogue is a JSON object', {});
  if (json.format !== undefined && json.format !== CATALOG_FORMAT) throw bad('not a feature catalogue (format "{format}", expected "{expected}")', { format: String(json.format), expected: CATALOG_FORMAT });
  const id = String(json.id ?? '').trim();
  if (!/^[\w.:@-]{1,80}$/.test(id)) throw bad('the catalogue id must be 1–80 letters, digits or . _ : @ -', {});
  if (typeof json.name !== 'string' || !json.name.trim()) throw bad('the catalogue has no name', {});
  const attrs = json.attributes;
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw bad('the catalogue has no attributes object', {});
  const names = Object.keys(attrs);
  if (names.length > MAX_ATTRS) throw bad('the catalogue has more than {n} attributes', { n: String(MAX_ATTRS) });
  const outAttrs = Object.create(null);
  for (const n of names) {
    if (n === '__proto__' || n === 'constructor' || n === 'prototype') throw bad('attribute name {field} is not allowed', { field: n });
    const a = attrs[n];
    if (!a || typeof a !== 'object') throw bad('attribute {field} is not an object', { field: n });
    const type = a.type ?? (a.domain ? 'enum' : 'text');
    if (!ATTR_TYPES.has(type)) throw bad('attribute {field} has an unknown type {type}', { field: n, type: String(type) });
    if (type === 'enum' && (!a.domain || typeof a.domain !== 'object' || !Object.keys(a.domain).length)) throw bad('attribute {field} is an enumeration without a domain', { field: n });
    if (a.range !== undefined && (!Array.isArray(a.range) || a.range.length !== 2 || !a.range.every(Number.isFinite) || a.range[0] > a.range[1])) throw bad('attribute {field} has a bad range', { field: n });
    if (a.length !== undefined && !(Number.isInteger(a.length) && a.length > 0)) throw bad('attribute {field} has a bad length', { field: n });
    if (a.field !== undefined && (typeof a.field !== 'string' || !a.field.trim() || ['__proto__', 'constructor', 'prototype'].includes(a.field))) throw bad('attribute {field} has a bad column name', { field: n });
    const o = { label: String(a.label ?? n), type };
    for (const k of ['domain', 'range', 'unit', 'length', 'definition', 'auto', 'field']) if (a[k] !== undefined) o[k] = k === 'domain' ? Object.fromEntries(Object.entries(a.domain).map(([c, l]) => [String(c), String(l)])) : a[k];
    if (a.required) o.required = true;
    outAttrs[n] = o;
  }
  if (!Array.isArray(json.types) || !json.types.length) throw bad('the catalogue has no feature types', {});
  if (json.types.length > MAX_TYPES) throw bad('the catalogue has more than {n} feature types', { n: String(MAX_TYPES) });
  const codes = new Set();
  const types = json.types.map((ty, i) => {
    const where = `type ${i + 1}`;
    if (!ty || typeof ty !== 'object') throw bad('{where} is not an object', { where });
    const code = String(ty.code ?? '').trim();
    if (!code) throw bad('{where} has no code', { where });
    if (codes.has(code)) throw bad('feature type {code} appears twice', { code });
    codes.add(code);
    if (!Array.isArray(ty.attributes)) throw bad('feature type {code} has no attribute list', { code });
    for (const n of ty.attributes) if (!outAttrs[n]) throw bad('feature type {code} uses an unknown attribute {field}', { code, field: String(n) });
    const columns = ty.attributes.map((n) => outAttrs[n].field ?? n);
    const twice = columns.find((c, k) => columns.indexOf(c) !== k);
    if (twice) throw bad('feature type {code} writes the column {field} twice', { code, field: twice });
    const geometry = Array.isArray(ty.geometry) && ty.geometry.length ? ty.geometry.map(String) : ['Point', 'LineString', 'Polygon'];
    const o = { code, name: String(ty.name ?? code), geometry, attributes: [...ty.attributes] };
    for (const k of ['definition', 'mgcp', 'label']) if (ty[k] !== undefined) o[k] = ty[k];
    if (ty.subtypes !== undefined) {
      if (!Array.isArray(ty.subtypes)) throw bad('feature type {code}: subtypes must be a list', { code });
      const sc = new Set();
      o.subtypeField = ty.subtypeField ? String(ty.subtypeField) : null;
      if (o.subtypeField && !outAttrs[o.subtypeField]) throw bad('feature type {code}: the subtype field {field} is not an attribute', { code, field: o.subtypeField });
      o.subtypes = ty.subtypes.map((s) => {
        const sco = String(s?.code ?? '').trim();
        if (!sco || sc.has(sco)) throw bad('feature type {code}: a subtype has no code or a repeated one', { code });
        sc.add(sco);
        for (const n of s.attributes ?? []) if (!outAttrs[n]) throw bad('subtype {subtype} of {code} uses an unknown attribute {field}', { subtype: sco, code, field: String(n) });
        for (const n of Object.keys(s.fixed ?? {})) if (!outAttrs[n]) throw bad('subtype {subtype} of {code} fixes an unknown attribute {field}', { subtype: sco, code, field: n });
        for (const [n, vs] of Object.entries(s.domains ?? {})) {
          if (!outAttrs[n]?.domain || !Array.isArray(vs) || vs.some((v) => !(String(v) in outAttrs[n].domain))) throw bad('subtype {subtype} of {code} narrows {field} to values outside its domain', { subtype: sco, code, field: n });
        }
        return { code: sco, name: String(s.name ?? sco), attributes: [...(s.attributes ?? [])], fixed: { ...(s.fixed ?? {}) }, domains: { ...(s.domains ?? {}) }, ...(s.definition ? { definition: String(s.definition) } : {}) };
      });
    }
    if (ty.rules !== undefined) {
      if (!Array.isArray(ty.rules)) throw bad('feature type {code}: rules must be a list', { code });
      ty.rules.forEach((r, k) => checkRule(r, `${code} rule ${k + 1}`, outAttrs));
      o.rules = ty.rules.map((r, k) => ({ ...r, id: String(r.id ?? `${code}-r${k + 1}`) }));
    }
    return o;
  });
  const rules = Array.isArray(json.rules) ? json.rules : [];
  rules.forEach((r, k) => {
    checkRule(r, `rule ${k + 1}`, outAttrs);
    if (r.classes !== undefined && (!Array.isArray(r.classes) || r.classes.some((c) => !codes.has(String(c))))) throw bad('rule {n} names a feature type that is not in the catalogue', { n: String(k + 1) });
  });
  const out = { format: CATALOG_FORMAT, id, name: json.name.trim(), version: String(json.version ?? ''), source: String(json.source ?? ''), nulls: { ...CATALOG.nulls, ...(json.nulls ?? {}) }, attributes: outAttrs, types };
  if (rules.length) out.rules = rules.map((r, k) => ({ ...r, id: String(r.id ?? `r${k + 1}`) }));
  if (json.licence !== undefined) out.licence = String(json.licence);
  if (json.crosswalk && typeof json.crosswalk === 'object') out.crosswalk = json.crosswalk;
  return out;
}

/** A subtype of a feature type (null when the type has none or the code is unknown). */
export function subtypeOf(cat, code, subtype) {
  if (subtype === null || subtype === undefined || subtype === '') return null;
  return typeOf(cat, code)?.subtypes?.find((s) => s.code === String(subtype)) ?? null;
}

/** Store field type for a catalogue attribute. */
// A coded attribute is stored as its codes are: whole numbers (TDS, ISO 19110 often) or text (INSPIRE
// code lists, OpenStreetMap, and codes such as '01' that a number would not give back).
const wholeCode = (k) => Number.isSafeInteger(Number(k)) && String(Number(k)) === k;
const storeType = (a) => (a.type === 'text' ? 'string' : a.type === 'real' ? 'number' : a.type === 'boolean' ? 'boolean' : a.type === 'enum' && !Object.keys(a.domain ?? {}).every(wholeCode) ? 'string' : 'integer');

/**
 * Layer fields for a feature class (and subtype): [{name, type, title, domain?, range?, unit?,
 * required?, length?, auto?, fixed?}]. A subtype adds its attributes, narrows domains and fixes
 * values (a fixed field's domain is just that value).
 */
export function fieldsFor(cat, code, subtype = null) {
  const t = typeOf(cat, code);
  if (!t) throw cat?.name ? gwError('feature class {code} is not in {catalogue}', { code: String(code), catalogue: cat.name }, 'E_FEATURE_CLASS') : gwError('feature class {code} is not in the catalogue', { code: String(code) }, 'E_FEATURE_CLASS');
  const st = subtypeOf(cat, code, subtype);
  if (subtype && !st) throw gwError('{code} has no subtype {subtype}', { code: String(code), subtype: String(subtype) }, 'E_FEATURE_SUBTYPE');
  const names = st ? [...new Set([...t.attributes, ...st.attributes])] : t.attributes;
  return names.map((n) => {
    const a = cat.attributes[n] ?? { label: n, type: 'text' };
    // An attribute may name its column (a definition one type gives differently, decision #243).
    const f = { name: a.field ?? n, type: storeType(a), title: a.label };
    if (a.domain) f.domain = a.domain;
    if (a.range) f.range = a.range;
    if (a.unit) f.unit = a.unit;
    if (a.required) f.required = true;
    if (a.length) f.length = a.length;
    if (a.auto) f.auto = a.auto;
    if (a.definition) f.description = a.definition;
    if (st?.domains?.[n] && f.domain) f.domain = Object.fromEntries(Object.entries(f.domain).filter(([k]) => st.domains[n].map(String).includes(k) || k === String(nullOf(cat, f))));
    if (st && n in st.fixed) {
      f.fixed = st.fixed[n];
      if (f.domain) f.domain = Object.fromEntries(Object.entries(f.domain).filter(([k]) => k === String(st.fixed[n])));
    }
    return f;
  });
}

// ---- conditional rules and contingent domains ----

const isNullAttr = (cat, f, v) => v === null || v === undefined || v === '' || (f && String(v) === String(nullOf(cat, f)));

function condHolds(cat, c, attrs, fieldOf, colOf) {
  if (c.all) return c.all.every((x) => condHolds(cat, x, attrs, fieldOf, colOf));
  if (c.any) return c.any.some((x) => condHolds(cat, x, attrs, fieldOf, colOf));
  if (c.not) return !condHolds(cat, c.not, attrs, fieldOf, colOf);
  // A rule names attributes by catalogue key; the feature's attributes are by column.
  const col = colOf(c.field);
  const v = attrs?.[col];
  const f = fieldOf(col);
  const op = c.op ?? '=';
  if (op === 'isNull') return isNullAttr(cat, f, v);
  if (op === 'notNull') return !isNullAttr(cat, f, v);
  if (isNullAttr(cat, f, v)) return false;
  const s = String(v);
  switch (op) {
    case '=':
      return s === String(c.value);
    case '≠':
    case '!=':
      return s !== String(c.value);
    case 'in':
      return c.value.map(String).includes(s);
    case 'notIn':
      return !c.value.map(String).includes(s);
    case '<':
      return Number(v) < Number(c.value);
    case '>':
      return Number(v) > Number(c.value);
    case '≤':
    case '<=':
      return Number(v) <= Number(c.value);
    case '≥':
    case '>=':
      return Number(v) >= Number(c.value);
  }
  return false;
}

/** The rules that apply to a feature class: its own, then the catalogue's (those naming it or no class). */
export function rulesFor(cat, code) {
  const t = typeOf(cat, code);
  return [...(t?.rules ?? []), ...(cat?.rules ?? []).filter((r) => !r.classes || r.classes.map(String).includes(String(code)))];
}

/**
 * The values allowed for a coded field given the other attributes (the contingent domain): the
 * field's domain narrowed by every rule whose condition holds. Returns the domain object.
 */
export function contingentDomain(cat, schema, fields, name, attrs) {
  const f = fields.find((x) => x.name === name);
  if (!f?.domain) return null;
  let allowed = Object.keys(f.domain);
  const fieldOf = (n) => fields.find((x) => x.name === n) ?? null;
  const colOf = columnsOf(cat, schema);
  for (const r of rulesFor(cat, schema?.code)) {
    const ds = Object.entries(r.then?.domain ?? {}).filter(([k]) => colOf(k) === name);
    if (!ds.length || !condHolds(cat, r.when, attrs, fieldOf, colOf)) continue;
    for (const [, d] of ds) {
      const keep = new Set(d.map(String));
      allowed = allowed.filter((k) => keep.has(k) || k === String(nullOf(cat, f)));
    }
  }
  return Object.fromEntries(allowed.map((k) => [k, f.domain[k]]));
}

/**
 * Rule issues of one feature's attributes: [{field, message (English), code, i18n, rule}], codes
 * E_RULE_REQUIRED, E_RULE_FORBIDDEN, E_RULE_DOMAIN, E_RULE_RANGE and E_SUBTYPE_FIXED.
 */
export function ruleIssues(cat, schema, fields, attrs) {
  const out = [];
  if (!cat || !schema?.code) return out;
  const fieldOf = (n) => fields.find((x) => x.name === n) ?? null;
  const colOf = columnsOf(cat, schema);
  const label = (n) => {
    const f = fieldOf(n);
    return f?.title && f.title !== n ? `${n} (${f.title})` : n;
  };
  const push = (e, field, rule) => out.push({ field, message: e.message, code: e.code, i18n: e.i18n, rule });
  for (const f of fields) {
    if (f.fixed === undefined) continue;
    const v = attrs?.[f.name];
    if (!isNullAttr(cat, f, v) && String(v) !== String(f.fixed)) push(gwError('{label} must be {value} for this subtype', { label: label(f.name), value: String(f.fixed) }, 'E_SUBTYPE_FIXED'), f.name, `subtype:${schema.subtype}`);
  }
  for (const r of rulesFor(cat, schema.code)) {
    if (!condHolds(cat, r.when, attrs, fieldOf, colOf)) continue;
    const why = r.message ? String(r.message) : r.id;
    for (const k of r.then.require ?? []) {
      const n = colOf(k);
      if (!fieldOf(n)) continue;
      if (isNullAttr(cat, fieldOf(n), attrs?.[n])) push(gwError('{label} is required here ({rule})', { label: label(n), rule: why }, 'E_RULE_REQUIRED'), n, r.id);
    }
    for (const k of r.then.forbid ?? []) {
      const n = colOf(k);
      if (!fieldOf(n)) continue;
      if (!isNullAttr(cat, fieldOf(n), attrs?.[n])) push(gwError('{label} must be empty here ({rule})', { label: label(n), rule: why }, 'E_RULE_FORBIDDEN'), n, r.id);
    }
    for (const [k, codes] of Object.entries(r.then.domain ?? {})) {
      const n = colOf(k);
      const f = fieldOf(n);
      const v = attrs?.[n];
      if (!f || isNullAttr(cat, f, v)) continue;
      if (!codes.map(String).includes(String(v))) {
        const allowed = codes.map((c) => `${c} ${f.domain?.[String(c)] ?? ''}`.trim());
        push(gwError('{label}: {value} is not allowed here ({rule}). Allowed: {allowed}', { label: label(n), value: String(v), rule: why, allowed: allowed.join('; ') }, 'E_RULE_DOMAIN'), n, r.id);
      }
    }
    for (const [k, [lo, hi]] of Object.entries(r.then.range ?? {})) {
      const n = colOf(k);
      const f = fieldOf(n);
      const v = attrs?.[n];
      if (!f || isNullAttr(cat, f, v)) continue;
      const x = Number(v);
      if (!(x >= lo && x <= hi)) push(gwError('{label}: {value} is outside {min} to {max} here ({rule})', { label: label(n), value: String(v), min: String(lo), max: String(hi), rule: why }, 'E_RULE_RANGE'), n, r.id);
    }
  }
  return out;
}

/**
 * The null ("no information") value of an attribute: the catalogue's own, else TDS's. A catalogue
 * may set '' or null to mean an empty value (catalogues converted from ISO, INSPIRE or OSM).
 */
export function nullOf(cat, field) {
  const nulls = cat?.nulls ?? {};
  const of = (k, d) => (nulls[k] !== undefined ? nulls[k] : d);
  if (field.domain) {
    const e = of('enum', -999999);
    return e === null || e === '' ? '' : field.type === 'integer' ? Number(e) : String(e);
  }
  if (field.type === 'string') return of('text', 'noInformation');
  return of('number', -999999);
}

const isNullValue = (cat, f, v) => v === null || v === undefined || v === '' || String(v) === String(nullOf(cat, f));

/**
 * Check one value: null when valid, else an error (not thrown) whose English message names the
 * attribute and what is allowed, with its message key (show it with msgOf) and a code:
 * E_ATTR_REQUIRED, E_ATTR_DOMAIN, E_ATTR_NUMBER, E_ATTR_INTEGER, E_ATTR_RANGE or E_ATTR_LENGTH.
 */
export function valueIssue(cat, field, value) {
  const label = field.title && field.title !== field.name ? `${field.name} (${field.title})` : field.name;
  if (isNullValue(cat, field, value)) return field.required ? gwError('{label} is required', { label }, 'E_ATTR_REQUIRED') : null;
  if (field.domain) {
    const ok = Object.keys(field.domain).some((k) => String(k) === String(value));
    if (!ok) {
      const allowed = Object.entries(field.domain).map(([k, l]) => `${k} ${l}`);
      return gwError('{label}: {value} is not an allowed value. Allowed: {allowed}', { label, value: String(value), allowed: allowed.join('; ') }, 'E_ATTR_DOMAIN');
    }
    return null;
  }
  if (field.type === 'integer' || field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return gwError('{label} must be a number', { label }, 'E_ATTR_NUMBER');
    if (field.type === 'integer' && !Number.isInteger(n)) return gwError('{label} must be a whole number', { label }, 'E_ATTR_INTEGER');
    if (field.range && (n < field.range[0] || n > field.range[1])) return gwError('{label}: {value} is outside the allowed range {min} to {max}{unit}', { label, value: String(n), min: String(field.range[0]), max: String(field.range[1]), unit: field.unit ? ` ${field.unit}` : '' }, 'E_ATTR_RANGE');
    return null;
  }
  if (field.length && String(value).length > field.length) return gwError('{label} is longer than {n, plural, one {# character} other {# characters}}', { label, n: field.length }, 'E_ATTR_LENGTH');
  return null;
}

/** Check one value; returns null when valid, else the English message (valueIssue gives the error with its key and code). */
export function checkValue(cat, field, value) {
  return valueIssue(cat, field, value)?.message ?? null;
}

/** All attribute issues of a feature: [{field, message (English), code, i18n}]; show them with msgOf. */
export function checkAttrs(cat, fields, attrs, schema = null) {
  const out = [];
  for (const f of fields) {
    const e = valueIssue(cat, f, attrs?.[f.name]);
    if (e) out.push({ field: f.name, message: e.message, code: e.code, i18n: e.i18n });
  }
  // Conditional rules, contingent domains and subtype values (REQ-GAP-53), when the layer has a schema.
  if (schema?.code) for (const r of ruleIssues(cat, schema, fields, attrs)) if (!out.some((o) => o.field === r.field && o.code === r.code)) out.push(r);
  return out;
}

/** Coerce a typed-in string to the field's store type. */
export function coerce(field, v) {
  if (v === '' || v === null || v === undefined) return null;
  if (field.type === 'integer') return Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : v;
  if (field.type === 'number') return Number.isFinite(Number(v)) ? Number(v) : v;
  if (field.type === 'boolean') return v === true || v === 'true' || v === '1';
  return String(v);
}

/** MGCP cross-walk of a layer in transit (feature codes and attribute names). */
export function crosswalkMGCP(cat, layer, code) {
  const t = typeOf(cat, code);
  const amap = cat.crosswalk?.MGCP?.attributes ?? {};
  const fields = layer.fields.map((f) => ({ ...f, name: amap[f.name] ?? f.name }));
  const features = layer.features.map((f) => {
    const attrs = {};
    for (const [k, v] of Object.entries(f.attrs ?? {})) attrs[amap[k] ?? k] = k === 'F_CODE' && t?.mgcp ? t.mgcp : v;
    return { ...f, attrs };
  });
  return { ...layer, name: `${layer.name}_MGCP`, fields, features };
}

/** A catalogue from GeoPackage layers with domains (REQ-EXT-10 import). */
export function catalogFromLayers(name, layers) {
  const attributes = {};
  const codes = [];
  const types = layers.map((l) => {
    const fcode = l.features.find((x) => x.attrs?.F_CODE)?.attrs.F_CODE;
    const code = fcode ?? l.table ?? l.name;
    codes.push(code);
    // A column two layers define differently keeps each layer's definition, under a key of its own that
    // names the column (decision #243), as the converters write it.
    const names = l.fields.map((f) => {
      const a = { label: f.title ?? f.name, type: f.domain ? 'enum' : f.type === 'number' ? 'real' : f.type === 'integer' ? 'integer' : 'text', ...(f.domain ? { domain: f.domain } : {}), ...(f.range ? { range: f.range } : {}), ...(f.description ? { definition: f.description } : {}) };
      const { key, entry } = attributeKey(attributes, f.name, a, code);
      attributes[key] ??= entry;
      return key;
    });
    return { code, name: l.name, geometry: [...new Set(l.features.map((x) => x.geom.type))], attributes: names };
  });
  // TDS's "no information" codes for TDS layers: a TDS feature code, or coded fields that carry the code
  // (every TDS domain does); a converted catalogue's layer (ISO 19110, INSPIRE, OSM) starts a new feature
  // empty, as it did before.
  const tds = codes.some((c) => typeOf(CATALOG, c)) || layers.some((l) => l.fields.some((f) => f.domain && Object.hasOwn(f.domain, String(CATALOG.nulls.enum))));
  return { id: `gpkg:${name}`, name: `${name} (from GeoPackage)`, version: '', nulls: tds ? CATALOG.nulls : { text: '', enum: '', number: null }, attributes, types };
}
