// Feature schemas (REQ-EXT-09/10, D11): an open JSON catalogue — the shipped TDS 7.1 subset or one
// imported from a GeoPackage — gives each feature class its attributes with types, coded domains,
// ranges, units, TDS null values, required flags and auto-attribution rules. Value checks name the
// attribute and its allowed values (AC-10.3). The MGCP cross-walk renames codes and attributes on
// export.

import CATALOG from '../data/feature-catalog-subset.json';

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

export function typeOf(cat, code) {
  return cat?.types.find((t) => t.code === code) ?? null;
}

/** Store field type for a catalogue attribute. */
const storeType = (a) => (a.type === 'text' ? 'string' : a.type === 'real' ? 'number' : 'integer');

/** Layer fields for a feature class: [{name, type, title, domain?, range?, unit?, required?, length?, auto?}]. */
export function fieldsFor(cat, code) {
  const t = typeOf(cat, code);
  if (!t) throw new Error(`feature class ${code} is not in ${cat?.name ?? 'the catalogue'}`);
  return t.attributes.map((n) => {
    const a = cat.attributes[n] ?? { label: n, type: 'text' };
    const f = { name: n, type: storeType(a), title: a.label };
    if (a.domain) f.domain = a.domain;
    if (a.range) f.range = a.range;
    if (a.unit) f.unit = a.unit;
    if (a.required) f.required = true;
    if (a.length) f.length = a.length;
    if (a.auto) f.auto = a.auto;
    if (a.definition) f.description = a.definition;
    return f;
  });
}

/** The TDS null ("no information") value of an attribute. */
export function nullOf(cat, field) {
  const nulls = cat?.nulls ?? {};
  if (field.domain) return field.type === 'integer' ? Number(nulls.enum ?? -999999) : String(nulls.enum ?? '-999999');
  if (field.type === 'string') return nulls.text ?? 'noInformation';
  return nulls.number ?? -999999;
}

const isNullValue = (cat, f, v) => v === null || v === undefined || v === '' || String(v) === String(nullOf(cat, f));

/** Check one value; returns null when valid, else a message naming the attribute and what is allowed. */
export function checkValue(cat, field, value) {
  const label = field.title && field.title !== field.name ? `${field.name} (${field.title})` : field.name;
  if (isNullValue(cat, field, value)) return field.required ? `${label} is required` : null;
  if (field.domain) {
    const ok = Object.keys(field.domain).some((k) => String(k) === String(value));
    if (!ok) {
      const allowed = Object.entries(field.domain).map(([k, l]) => `${k} ${l}`);
      return `${label}: ${value} is not an allowed value. Allowed: ${allowed.join('; ')}`;
    }
    return null;
  }
  if (field.type === 'integer' || field.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return `${label} must be a number`;
    if (field.type === 'integer' && !Number.isInteger(n)) return `${label} must be a whole number`;
    if (field.range && (n < field.range[0] || n > field.range[1])) return `${label}: ${n} is outside the allowed range ${field.range[0]} to ${field.range[1]}${field.unit ? ` ${field.unit}` : ''}`;
    return null;
  }
  if (field.length && String(value).length > field.length) return `${label} is longer than ${field.length} characters`;
  return null;
}

/** All attribute issues of a feature: [{field, message}]. */
export function checkAttrs(cat, fields, attrs) {
  const out = [];
  for (const f of fields) {
    const m = checkValue(cat, f, attrs?.[f.name]);
    if (m) out.push({ field: f.name, message: m });
  }
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
  const types = layers.map((l) => {
    for (const f of l.fields) {
      attributes[f.name] ??= { label: f.title ?? f.name, type: f.domain ? 'enum' : f.type === 'number' ? 'real' : f.type === 'integer' ? 'integer' : 'text', ...(f.domain ? { domain: f.domain } : {}), ...(f.range ? { range: f.range } : {}), ...(f.description ? { definition: f.description } : {}) };
    }
    const fcode = l.features.find((x) => x.attrs?.F_CODE)?.attrs.F_CODE;
    return { code: fcode ?? l.table ?? l.name, name: l.name, geometry: [...new Set(l.features.map((x) => x.geom.type))], attributes: l.fields.map((f) => f.name) };
  });
  return { id: `gpkg:${name}`, name: `${name} (from GeoPackage)`, version: '', nulls: CATALOG.nulls, attributes, types };
}
