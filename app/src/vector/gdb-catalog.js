// A FileGDB's schema as a feature catalogue (REQ-GAP-54). The sidecar's gdb-catalogue profile answers
// with GDAL's description of the geodatabase (`info`: layers, fields, domains) and the rows of its
// GDB_Items table (`items`), whose XML definitions hold what GDAL does not report: the subtypes.
// This turns the two into a gw-catalog/1 document. It reads no file and needs no sidecar, so the
// unit tests run it on recorded answers (tests/unit/gdb-catalog.test.js).

import { gwError } from '../i18n/index.js';

/** Fields a geodatabase maintains itself: not attributes anyone fills in. */
const SYSTEM_FIELD = /^(objectid|fid|oid|shape|shape_length|shape_area|st_length\(shape\)|st_area\(shape\)|globalid)$/i;
const MAX_XML = 8 << 20;

const unxml = (s) => String(s ?? '').replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<';
  if (k === 'gt') return '>';
  if (k === 'quot') return '"';
  if (k === 'apos') return "'";
  if (k === 'amp') return '&';
  const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});

/**
 * The contents of each <name> element, in order. Indexes, not regular expressions: the text comes
 * from a file, and scanning stays linear however it is built. An empty <name/> gives ''.
 */
function blocks(xml, name) {
  const out = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  for (;;) {
    i = xml.indexOf(open, i);
    if (i < 0) return out;
    const c = xml[i + open.length];
    if (c !== '>' && c !== '/' && c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') {
      i += open.length;
      continue;
    }
    const gt = xml.indexOf('>', i);
    if (gt < 0) return out;
    if (xml[gt - 1] === '/') {
      out.push('');
      i = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt);
    if (end < 0) return out;
    out.push(xml.slice(gt + 1, end));
    i = end + close.length;
  }
}
const tag = (xml, name) => {
  const b = blocks(xml, name)[0];
  return b === undefined ? null : unxml(b).trim();
};

/**
 * The subtypes in a GDB_Items definition: {field, defaultCode, subtypes: [{code, name, fields:
 * [{name, domain, value}]}]}, or null when the class has none.
 */
export function subtypesFromXml(xml) {
  if (typeof xml !== 'string' || xml.length > MAX_XML) return null;
  const field = tag(xml, 'SubtypeFieldName');
  if (!field) return null;
  const list = blocks(xml, 'Subtype').map((b) => ({
    code: tag(b, 'SubtypeCode'),
    name: tag(b, 'SubtypeName'),
    fields: blocks(b, 'SubtypeFieldInfo').map((f) => ({ name: tag(f, 'FieldName'), domain: tag(f, 'DomainName') || null, value: tag(f, 'DefaultValue') })),
  }));
  const good = list.filter((s) => s.code !== null && s.code !== '');
  return good.length ? { field, defaultCode: tag(xml, 'DefaultSubtypeCode'), subtypes: good } : null;
}

const geometryOf = (type) => {
  const t = String(type ?? '');
  if (/point/i.test(t)) return ['Point'];
  if (/line|curve/i.test(t)) return ['LineString'];
  if (/polygon|surface|tin|multipatch/i.test(t)) return ['Polygon'];
  return ['Point', 'LineString', 'Polygon'];
};

function attributeFrom(f, domains, warn, where) {
  const d = f.domainName ? domains[f.domainName] : null;
  if (f.domainName && !d) warn(`${where}: domain ${f.domainName} is not in the geodatabase`);
  const integer = /^Integer/.test(f.type ?? '');
  const number = integer || f.type === 'Real';
  const a = { label: f.alternativeName || f.name, type: integer ? 'integer' : number ? 'real' : 'text' };
  if (f.comment) a.definition = String(f.comment);
  if (f.width > 0 && !number) a.length = f.width;
  if (f.nullable === false) a.required = true;
  if (d?.type === 'coded' && d.codedValues && Object.keys(d.codedValues).length) {
    a.type = 'enum';
    a.domain = Object.fromEntries(Object.entries(d.codedValues).map(([k, v]) => [String(k), String(v)]));
    if (d.description) a.definition ??= String(d.description);
  } else if (d?.type === 'range' && Number.isFinite(d.minValue) && Number.isFinite(d.maxValue) && number) {
    a.range = [d.minValue, d.maxValue];
    if (d.description) a.definition ??= String(d.description);
  } else if (d) {
    warn(`${where}: domain ${f.domainName} is a ${d.type} domain, kept as free text`);
  }
  return a;
}

const sameAttribute = (a, b) => JSON.stringify([a.type, a.domain ?? null, a.range ?? null]) === JSON.stringify([b.type, b.domain ?? null, b.range ?? null]);

/**
 * The catalogue of one geodatabase. `result` is the job's result. Returns {catalog, warnings,
 * counts}; the catalogue still goes through validateCatalog when it is imported. A class's field
 * shared with another class under a different domain keeps the first definition, and says so.
 */
export function catalogFromGdb(name, result) {
  const info = result?.info;
  if (!info || typeof info !== 'object' || !Array.isArray(info.layers)) throw gwError('{file} is not a File Geodatabase the sidecar can read', { file: name }, 'E_GDB_UNREADABLE');
  const warnings = [];
  const warn = (m) => warnings.length < 200 && warnings.push(m);
  const domains = info.domains ?? {};
  const defs = new Map();
  for (const f of result.items?.layers?.[0]?.features ?? []) {
    const p = f?.properties ?? {};
    const n = String(p.Name ?? '').split('.').pop();
    if (n && typeof p.Definition === 'string') defs.set(n.toLowerCase(), p.Definition);
  }
  const attributes = Object.create(null);
  const types = [];
  let subtypeCount = 0;
  let tables = 0;
  for (const l of info.layers) {
    const geom = l.geometryFields?.[0]?.type;
    if (!l.geometryFields?.length) {
      tables++;
      continue;
    }
    const fields = (l.fields ?? []).filter((f) => !SYSTEM_FIELD.test(f.name) && !/^FILEGEODATABASE_/.test(f.defaultValue ?? ''));
    const names = [];
    for (const f of fields) {
      const a = attributeFrom(f, domains, warn, `${l.name}.${f.name}`);
      if (!attributes[f.name]) attributes[f.name] = a;
      else if (!sameAttribute(attributes[f.name], a)) warn(`${l.name}.${f.name} differs from the same field in another class; the first definition is used`);
      names.push(f.name);
    }
    const t = { code: l.name, name: l.alias || l.name, geometry: geometryOf(geom), attributes: names };
    const st = subtypesFromXml(defs.get(String(l.name).toLowerCase()));
    if (st && attributes[st.field]) {
      t.subtypeField = st.field;
      t.subtypes = st.subtypes.map((s) => {
        const narrowed = {};
        for (const f of s.fields) {
          const d = f.domain ? domains[f.domain] : null;
          const at = attributes[f.name];
          if (!at || !d) continue;
          if (d.type === 'coded' && d.codedValues) {
            // A subtype may name another domain than the field's: the field offers the union,
            // and the subtype narrows it to its own.
            if (at.type === 'enum') Object.assign(at.domain, Object.fromEntries(Object.entries(d.codedValues).map(([k, v]) => [String(k), String(v)])));
            else if (at.type === 'integer' || at.type === 'text' || at.type === 'real') {
              at.domain = Object.fromEntries(Object.entries(d.codedValues).map(([k, v]) => [String(k), String(v)]));
              at.type = 'enum';
              delete at.range;
            }
            narrowed[f.name] = Object.keys(d.codedValues).map(String);
          } else warn(`${l.name}, subtype ${s.name}: the range domain ${f.domain} on ${f.name} is not kept per subtype`);
        }
        subtypeCount++;
        return { code: String(s.code), name: s.name || String(s.code), attributes: [], fixed: { [st.field]: /^-?\d+$/.test(s.code) ? Number(s.code) : s.code }, domains: narrowed };
      });
      // The subtype field's own values are the subtypes.
      if (!attributes[st.field].domain) {
        attributes[st.field].type = 'enum';
        attributes[st.field].domain = Object.fromEntries(st.subtypes.map((s) => [String(s.code), s.name || String(s.code)]));
        delete attributes[st.field].range;
      }
    } else if (st) warn(`${l.name}: the subtype field ${st.field} is not among its fields`);
    types.push(t);
  }
  if (!types.length) throw gwError('{file} has no feature classes', { file: name }, 'E_GDB_EMPTY');
  const id = `gdb:${String(name).replace(/\.gdb(\.zip)?$/i, '').replace(/[^\w.:@-]+/g, '_').slice(0, 70)}`;
  const catalog = { format: 'gw-catalog/1', id, name: `${String(name).replace(/\.gdb(\.zip)?$/i, '')} (FileGDB)`, version: '', source: String(name), attributes: { ...attributes }, types };
  return { catalog, warnings, counts: { classes: types.length, tables, domains: Object.keys(domains).length, subtypes: subtypeCount } };
}
