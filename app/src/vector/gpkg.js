// GeoPackage 1.4 read and write (REQ-EXT-22, REQ-EXT-27, AC-17.1, AC-17.5) on lazy SQLite with
// R*Tree (rtree-sql.js). Writing: application_id "GPKG", user_version 10400, the core tables,
// WGS 84 with Z as HAE (EPSG:4979 declared as the vertical frame in the SRS table), ISO WKB with
// Z in GeoPackageBinary blobs with envelopes, the R*Tree spatial index with its triggers (the
// ST_* functions are registered so the triggers run here too), the Schema extension with coded
// domains and ranges (gpkg_data_columns, gpkg_data_column_constraints), and a metadata record.
// Reading: every feature table, any SRS proj4js knows, Z, field types and the domains.

import { fromParts, parts, polygonGroups, bbox } from './geom.js';
import { newReport, inferFields } from './io.js';

let sqlPromise = null;
/** SQL.js with R*Tree from the verified blocks. */
export function loadSqlite(gw) {
  sqlPromise ??= (async () => {
    const lib = await gw.runScript('js-sqlite');
    const module = await gw.wasm('wasm-sqlite');
    return lib.initSqlJs({
      instantiateWasm(imports, ok) {
        WebAssembly.instantiate(module, imports).then((inst) => ok(inst));
        return {};
      },
    });
  })();
  sqlPromise.catch(() => (sqlPromise = null));
  return sqlPromise;
}

const WKT_4326 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]';
const WKT_4979 = 'GEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],CS[ellipsoidal,3],AXIS["latitude",north,ANGLEUNIT["degree",0.0174532925199433]],AXIS["longitude",east,ANGLEUNIT["degree",0.0174532925199433]],AXIS["ellipsoidal height",up,LENGTHUNIT["metre",1]],ID["EPSG",4979]]';

const WKB_TYPE = { Point: 1, LineString: 2, Polygon: 3, MultiPoint: 4, MultiLineString: 5, MultiPolygon: 6 };
const WKB_NAME = Object.fromEntries(Object.entries(WKB_TYPE).map(([k, v]) => [v, k]));
const SQL_TYPE = { string: 'TEXT', number: 'DOUBLE', integer: 'INTEGER', boolean: 'BOOLEAN', date: 'DATE', datetime: 'DATETIME' };

// ---- geometry blobs ----

class Writer {
  constructor(n = 256) {
    this.b = new Uint8Array(n);
    this.dv = new DataView(this.b.buffer);
    this.o = 0;
  }
  need(n) {
    if (this.o + n <= this.b.length) return;
    const nb = new Uint8Array(Math.max(this.b.length * 2, this.o + n));
    nb.set(this.b);
    this.b = nb;
    this.dv = new DataView(nb.buffer);
  }
  u8(v) {
    this.need(1);
    this.b[this.o++] = v;
  }
  u32(v) {
    this.need(4);
    this.dv.setUint32(this.o, v, true);
    this.o += 4;
  }
  i32(v) {
    this.need(4);
    this.dv.setInt32(this.o, v, true);
    this.o += 4;
  }
  f64(v) {
    this.need(8);
    this.dv.setFloat64(this.o, v, true);
    this.o += 8;
  }
  out() {
    return this.b.slice(0, this.o);
  }
}

function wkbBody(w, type, ps) {
  const pt = (v) => {
    w.f64(v[0]);
    w.f64(v[1]);
    w.f64(v[2] ?? 0);
  };
  const ring = (r, close) => {
    const rr = close && r.length && (r[0][0] !== r.at(-1)[0] || r[0][1] !== r.at(-1)[1]) ? [...r, r[0]] : r;
    w.u32(rr.length);
    for (const v of rr) pt(v);
  };
  w.u8(1);
  w.u32(WKB_TYPE[type] + 1000);
  if (type === 'Point') pt(ps[0]);
  else if (type === 'LineString') ring(ps, false);
  else if (type === 'Polygon') {
    w.u32(ps.length);
    for (const r of ps) ring(r, true);
  }
}

/** GeoPackageBinary (envelope [minx, maxx, miny, maxy, minz, maxz]) + ISO WKB with Z. */
export function encodeGeometry(g, srsId = 4326) {
  const w = new Writer(64 + g.xyz.length * 8);
  const [x0, y0, x1, y1] = bbox(g);
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 2; i < g.xyz.length; i += 3) {
    z0 = Math.min(z0, g.xyz[i]);
    z1 = Math.max(z1, g.xyz[i]);
  }
  w.u8(0x47);
  w.u8(0x50);
  w.u8(0);
  w.u8(1 | (2 << 1)); // little-endian, xyz envelope
  w.i32(srsId);
  for (const v of [x0, x1, y0, y1, z0, z1]) w.f64(v);
  const ps = parts(g);
  if (g.type === 'Point') wkbBody(w, 'Point', ps[0]);
  else if (g.type === 'LineString') wkbBody(w, 'LineString', ps[0]);
  else if (g.type === 'Polygon') wkbBody(w, 'Polygon', ps);
  else {
    w.u8(1);
    w.u32(WKB_TYPE[g.type] + 1000);
    if (g.type === 'MultiPoint') {
      w.u32(ps.length);
      for (const p of ps) wkbBody(w, 'Point', p);
    } else if (g.type === 'MultiLineString') {
      w.u32(ps.length);
      for (const p of ps) wkbBody(w, 'LineString', p);
    } else {
      const groups = polygonGroups(g);
      w.u32(groups.length);
      for (const rings of groups) wkbBody(w, 'Polygon', rings);
    }
  }
  return w.out();
}

/** Decode a GeoPackageBinary blob → {geom (WGS 84 frame of the caller), srsId, empty}. */
export function decodeGeometry(b, transform = null) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] !== 0x47 || b[1] !== 0x50) throw new Error('not a GeoPackage geometry blob');
  const flags = b[3];
  const le = (flags & 1) === 1;
  const env = (flags >> 1) & 7;
  const empty = (flags >> 4) & 1;
  const srsId = dv.getInt32(4, le);
  let o = 8 + [0, 32, 48, 48, 64][env];
  const read = () => {
    const l = b[o] === 1;
    o += 1;
    let t = dv.getUint32(o, l);
    o += 4;
    let hasZ = false;
    let hasM = false;
    // ISO (1000/2000/3000) and EWKB-style (0x80000000 Z, 0x40000000 M) flags.
    if (t & 0x80000000) hasZ = true;
    if (t & 0x40000000) hasM = true;
    t &= 0x0fffffff;
    if (t >= 3000) {
      hasZ = hasM = true;
      t -= 3000;
    } else if (t >= 2000) {
      hasM = true;
      t -= 2000;
    } else if (t >= 1000) {
      hasZ = true;
      t -= 1000;
    }
    const pt = () => {
      const x = dv.getFloat64(o, l);
      const y = dv.getFloat64(o + 8, l);
      o += 16;
      let z = 0;
      if (hasZ) {
        z = dv.getFloat64(o, l);
        o += 8;
      }
      if (hasM) o += 8;
      return transform ? transform(x, y, z) : [x, y, z];
    };
    const seq = (close) => {
      const n = dv.getUint32(o, l);
      o += 4;
      const v = [];
      for (let i = 0; i < n; i++) v.push(pt());
      if (close && v.length > 1 && v[0][0] === v.at(-1)[0] && v[0][1] === v.at(-1)[1]) v.pop();
      return v;
    };
    const name = WKB_NAME[t];
    if (name === 'Point') return { type: 'Point', ps: [[pt()]] };
    if (name === 'LineString') return { type: 'LineString', ps: [seq(false)] };
    if (name === 'Polygon') {
      const n = dv.getUint32(o, l);
      o += 4;
      const rs = [];
      for (let i = 0; i < n; i++) rs.push(seq(true));
      return { type: 'Polygon', ps: rs };
    }
    if (name === 'MultiPoint' || name === 'MultiLineString' || name === 'MultiPolygon') {
      const n = dv.getUint32(o, l);
      o += 4;
      const kids = [];
      for (let i = 0; i < n; i++) kids.push(read());
      return { type: name, kids };
    }
    throw new Error(`WKB geometry type ${t} is not read`);
  };
  if (empty) return { geom: null, srsId, empty: true };
  const r = read();
  let geom;
  if (r.kids) {
    if (r.type === 'MultiPolygon') {
      const all = [];
      const polys = [];
      for (const k of r.kids) {
        polys.push(all.length);
        all.push(...k.ps);
      }
      geom = fromParts('MultiPolygon', all, polys);
    } else geom = fromParts(r.type, r.kids.map((k) => k.ps[0]));
  } else geom = fromParts(r.type, r.ps, r.type === 'Polygon' ? [0] : null);
  return { geom, srsId, empty: false };
}

/** Envelope of a blob for the ST_* functions the R*Tree triggers call. */
function envelope(b) {
  if (!b || b.length < 8) return null;
  const flags = b[3];
  if ((flags >> 4) & 1) return null;
  try {
    const { geom } = decodeGeometry(b);
    return geom ? bbox(geom) : null;
  } catch {
    return null;
  }
}

export function registerSpatialFunctions(db) {
  const env = (b) => envelope(b instanceof Uint8Array ? b : null);
  db.create_function('ST_IsEmpty', (b) => (env(b) ? 0 : 1));
  db.create_function('ST_MinX', (b) => env(b)?.[0] ?? null);
  db.create_function('ST_MinY', (b) => env(b)?.[1] ?? null);
  db.create_function('ST_MaxX', (b) => env(b)?.[2] ?? null);
  db.create_function('ST_MaxY', (b) => env(b)?.[3] ?? null);
}

const ident = (s) => {
  let t = String(s).normalize('NFKD').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'layer';
  if (/^\d/.test(t)) t = `t_${t}`;
  return t.slice(0, 60);
};
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

function rtreeTriggers(t, c) {
  const r = `rtree_${t}_${c}`;
  const T = q(t);
  const C = q(c);
  return [
    `CREATE VIRTUAL TABLE ${q(r)} USING rtree(id, minx, maxx, miny, maxy)`,
    `CREATE TRIGGER ${q(`${r}_insert`)} AFTER INSERT ON ${T} WHEN (new.${C} NOT NULL AND NOT ST_IsEmpty(NEW.${C})) BEGIN INSERT OR REPLACE INTO ${q(r)} VALUES (NEW.fid, ST_MinX(NEW.${C}), ST_MaxX(NEW.${C}), ST_MinY(NEW.${C}), ST_MaxY(NEW.${C})); END`,
    `CREATE TRIGGER ${q(`${r}_update1`)} AFTER UPDATE OF ${C} ON ${T} WHEN OLD.fid = NEW.fid AND (NEW.${C} NOTNULL AND NOT ST_IsEmpty(NEW.${C})) BEGIN INSERT OR REPLACE INTO ${q(r)} VALUES (NEW.fid, ST_MinX(NEW.${C}), ST_MaxX(NEW.${C}), ST_MinY(NEW.${C}), ST_MaxY(NEW.${C})); END`,
    `CREATE TRIGGER ${q(`${r}_update2`)} AFTER UPDATE OF ${C} ON ${T} WHEN OLD.fid = NEW.fid AND (NEW.${C} IS NULL OR ST_IsEmpty(NEW.${C})) BEGIN DELETE FROM ${q(r)} WHERE id = OLD.fid; END`,
    `CREATE TRIGGER ${q(`${r}_update3`)} AFTER UPDATE ON ${T} WHEN OLD.fid != NEW.fid AND (NEW.${C} NOTNULL AND NOT ST_IsEmpty(NEW.${C})) BEGIN DELETE FROM ${q(r)} WHERE id = OLD.fid; INSERT OR REPLACE INTO ${q(r)} VALUES (NEW.fid, ST_MinX(NEW.${C}), ST_MaxX(NEW.${C}), ST_MinY(NEW.${C}), ST_MaxY(NEW.${C})); END`,
    `CREATE TRIGGER ${q(`${r}_update4`)} AFTER UPDATE ON ${T} WHEN OLD.fid != NEW.fid AND (NEW.${C} IS NULL OR ST_IsEmpty(NEW.${C})) BEGIN DELETE FROM ${q(r)} WHERE id IN (OLD.fid, NEW.fid); END`,
    `CREATE TRIGGER ${q(`${r}_delete`)} AFTER DELETE ON ${T} WHEN old.${C} NOT NULL BEGIN DELETE FROM ${q(r)} WHERE id = OLD.fid; END`,
  ];
}

/**
 * Write layers in transit ({name, fields: [{name, type, title?, description?, domain?: {code:
 * label}, range?: [min, max], unit?}], features}) to a GeoPackage. Returns {bytes, report}.
 * opts: {title, abstract, analyst, crosswalk?: (layer) => layer}.
 */
export function writeGpkg(SQL, layers, { title = 'GIS Workbench export', abstract = '', analyst = '', now = new Date() } = {}) {
  const db = new SQL.Database();
  registerSpatialFunctions(db);
  const report = newReport('GeoPackage', 'export');
  const iso = now.toISOString().replace(/\.\d+Z$/, '.000Z');
  db.exec('PRAGMA application_id = 1196444487'); // 'GPKG'
  db.exec('PRAGMA user_version = 10400');
  db.exec(`
CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER PRIMARY KEY, organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT, definition_12_063 TEXT NOT NULL DEFAULT 'undefined');
CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '', last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name), CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name), CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
CREATE TABLE gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL, CONSTRAINT ge_tce UNIQUE (table_name, column_name, extension_name));
CREATE TABLE gpkg_data_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, name TEXT, title TEXT, description TEXT, mime_type TEXT, constraint_name TEXT, CONSTRAINT pk_gdc PRIMARY KEY (table_name, column_name), CONSTRAINT gdc_tn UNIQUE (table_name, name));
CREATE TABLE gpkg_data_column_constraints (constraint_name TEXT NOT NULL, constraint_type TEXT NOT NULL, value TEXT, min NUMERIC, min_is_inclusive BOOLEAN, max NUMERIC, max_is_inclusive BOOLEAN, description TEXT, CONSTRAINT gdcc_ntv UNIQUE (constraint_name, constraint_type, value));
CREATE TABLE gpkg_metadata (id INTEGER CONSTRAINT m_pk PRIMARY KEY ASC NOT NULL, md_scope TEXT NOT NULL DEFAULT 'dataset', md_standard_uri TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT 'text/xml', metadata TEXT NOT NULL DEFAULT '');
CREATE TABLE gpkg_metadata_reference (reference_scope TEXT NOT NULL, table_name TEXT, column_name TEXT, row_id_value INTEGER, timestamp DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), md_file_id INTEGER NOT NULL, md_parent_id INTEGER, CONSTRAINT crmr_mfi_fk FOREIGN KEY (md_file_id) REFERENCES gpkg_metadata(id), CONSTRAINT crmr_mpi_fk FOREIGN KEY (md_parent_id) REFERENCES gpkg_metadata(id));
`);
  const srs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?,?)');
  srs.run(['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system', 'undefined']);
  srs.run(['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system', 'undefined']);
  srs.run(['WGS 84 geodetic', 4326, 'EPSG', 4326, WKT_4326, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid; Z values are heights above the ellipsoid (EPSG:4979)', WKT_4326.replace(/^GEOGCS/, 'GEOGCRS')]);
  srs.run(['WGS 84 (3D)', 4979, 'EPSG', 4979, WKT_4979, 'WGS 84 geographic 3D (ellipsoidal heights, metres)', WKT_4979]);
  srs.free();
  db.exec(`INSERT INTO gpkg_extensions VALUES ('gpkg_data_columns', NULL, 'gpkg_schema', 'http://www.geopackage.org/spec/#extension_schema', 'read-write'), ('gpkg_data_column_constraints', NULL, 'gpkg_schema', 'http://www.geopackage.org/spec/#extension_schema', 'read-write'), ('gpkg_metadata', NULL, 'gpkg_metadata', 'http://www.geopackage.org/spec/#extension_metadata', 'read-write'), ('gpkg_metadata_reference', NULL, 'gpkg_metadata', 'http://www.geopackage.org/spec/#extension_metadata', 'read-write'), ('gpkg_spatial_ref_sys', 'definition_12_063', 'gpkg_crs_wkt', 'http://www.geopackage.org/spec/#extension_crs_wkt', 'read-write')`);
  const md = `<?xml version="1.0" encoding="UTF-8"?><gmd:MD_Metadata xmlns:gmd="http://www.isotc211.org/2005/gmd" xmlns:gco="http://www.isotc211.org/2005/gco"><gmd:contact><gmd:CI_ResponsibleParty><gmd:individualName><gco:CharacterString>${esc(analyst || 'analyst')}</gco:CharacterString></gmd:individualName><gmd:role><gmd:CI_RoleCode codeList="http://www.isotc211.org/2005/resources/Codelist/gmxCodelists.xml#CI_RoleCode" codeListValue="author">author</gmd:CI_RoleCode></gmd:role></gmd:CI_ResponsibleParty></gmd:contact><gmd:dateStamp><gco:DateTime>${iso}</gco:DateTime></gmd:dateStamp><gmd:identificationInfo><gmd:MD_DataIdentification><gmd:citation><gmd:CI_Citation><gmd:title><gco:CharacterString>${esc(title)}</gco:CharacterString></gmd:title></gmd:CI_Citation></gmd:citation><gmd:abstract><gco:CharacterString>${esc(abstract || 'Features exported by GIS Workbench. Coordinates WGS 84 longitude/latitude; Z = height above the ellipsoid (m).')}</gco:CharacterString></gmd:abstract></gmd:MD_DataIdentification></gmd:identificationInfo></gmd:MD_Metadata>`;
  db.run("INSERT INTO gpkg_metadata (id, md_scope, md_standard_uri, mime_type, metadata) VALUES (1, 'dataset', 'http://www.isotc211.org/2005/gmd', 'text/xml', ?)", [md]);
  db.run("INSERT INTO gpkg_metadata_reference (reference_scope, md_file_id, timestamp) VALUES ('geopackage', 1, ?)", [iso]);
  const used = new Set();
  const usedIds = new Set();
  const tables = [];
  for (const layer of layers) {
    let t = ident(layer.name);
    while (used.has(t)) t = `${t}_2`;
    used.add(t);
    // gpkg_contents.identifier is UNIQUE: two layers with one name get numbered (TE-034).
    let id = layer.name || t;
    for (let n = 2; usedIds.has(id); n++) id = `${layer.name || t} (${n})`;
    usedIds.add(id);
    const fields = (layer.fields?.length ? layer.fields : inferFields(layer.features)).filter((f) => !['fid', 'geom', 'name', 'description', 'ufi'].includes(f.name.toLowerCase()));
    const types = new Set(layer.features.map((f) => f.geom.type));
    const gtype = types.size === 1 ? [...types][0].toUpperCase() : 'GEOMETRY';
    const cols = fields.map((f) => `${q(f.name)} ${SQL_TYPE[f.type] ?? 'TEXT'}`);
    db.exec(`CREATE TABLE ${q(t)} (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom ${gtype}, ufi TEXT, name TEXT, description TEXT${cols.length ? `, ${cols.join(', ')}` : ''})`);
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of layer.features) {
      const b = bbox(f.geom);
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    if (!layer.features.length) [x0, y0, x1, y1] = [-180, -90, 180, 90];
    db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, description, last_change, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [t, 'features', id, layer.description ?? `${layer.features.length} feature(s) from GIS Workbench`, iso, x0, y0, x1, y1, 4326]);
    db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)', [t, 'geom', gtype, 4326, 1, 0]);
    db.run("INSERT INTO gpkg_extensions VALUES (?, 'geom', 'gpkg_rtree_index', 'http://www.geopackage.org/spec/#extension_rtree', 'write-only')", [t]);
    for (const s of rtreeTriggers(t, 'geom')) db.exec(s);
    // Schema: titles, descriptions and constraints.
    for (const f of fields) {
      let cname = null;
      if (f.domain && Object.keys(f.domain).length) {
        cname = `${t}_${f.name}_domain`.slice(0, 120);
        const st = db.prepare("INSERT OR IGNORE INTO gpkg_data_column_constraints (constraint_name, constraint_type, value, description) VALUES (?, 'enum', ?, ?)");
        for (const [code, label] of Object.entries(f.domain)) st.run([cname, String(code), String(label)]);
        st.free();
      } else if (f.range) {
        cname = `${t}_${f.name}_range`.slice(0, 120);
        db.run("INSERT INTO gpkg_data_column_constraints (constraint_name, constraint_type, value, min, min_is_inclusive, max, max_is_inclusive, description) VALUES (?, 'range', NULL, ?, 1, ?, 1, ?)", [cname, f.range[0], f.range[1], f.unit ? `unit ${f.unit}` : null]);
      }
      if (cname || f.title || f.description) db.run('INSERT INTO gpkg_data_columns (table_name, column_name, name, title, description, constraint_name) VALUES (?,?,?,?,?,?)', [t, f.name, f.name, f.title ?? f.name, f.description ?? null, cname]);
    }
    const ins = db.prepare(`INSERT INTO ${q(t)} (geom, ufi, name, description${fields.map((f) => `, ${q(f.name)}`).join('')}) VALUES (?, ?, ?, ?${fields.map(() => ', ?').join('')})`);
    db.exec('BEGIN');
    for (const f of layer.features) {
      const vals = fields.map((fl) => {
        const v = f.attrs?.[fl.name];
        if (v === undefined || v === null || v === '') return null;
        if (fl.type === 'boolean') return v === true || v === 'true' || v === 1 ? 1 : 0;
        if (fl.type === 'integer') return Math.round(Number(v));
        if (fl.type === 'number') return Number(v);
        return String(v);
      });
      ins.run([encodeGeometry(f.geom), f.ufi ?? null, f.name ?? null, f.description ?? null, ...vals]);
      report.features_in++;
      report.features_out++;
      report.by_geometry[f.geom.type] = (report.by_geometry[f.geom.type] ?? 0) + 1;
    }
    db.exec('COMMIT');
    ins.free();
    tables.push(t);
  }
  const bytes = db.export();
  db.close();
  report.tables = tables;
  return { bytes, report };
}

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

const fieldType = (decl) => {
  const t = String(decl ?? '').toUpperCase();
  if (/BOOL/.test(t)) return 'boolean';
  if (/INT/.test(t)) return 'integer';
  if (/REAL|DOUB|FLOA|NUM/.test(t)) return 'number';
  if (/DATETIME/.test(t)) return 'datetime';
  if (/DATE/.test(t)) return 'date';
  return 'string';
};

/**
 * Read a GeoPackage: every feature table into a layer in transit. `reproject(srsRow)` returns a
 * (x, y, z) → [lon, lat, hae] function for SRSs other than 4326/4979, or null. Returns {layers,
 * report, checks}.
 */
export function readGpkg(SQL, bytes, { reproject = null, name = 'GeoPackage' } = {}) {
  const db = new SQL.Database(bytes);
  registerSpatialFunctions(db);
  const report = newReport('GeoPackage', 'import');
  const rows = (sql, p = []) => {
    const st = db.prepare(sql);
    st.bind(p);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    st.free();
    return out;
  };
  const appId = rows('PRAGMA application_id')[0]?.application_id;
  const userVersion = rows('PRAGMA user_version')[0]?.user_version;
  if (appId !== 1196444487 && appId !== 1196437808) report.warnings.push(`application_id ${appId} is not "GPKG"`);
  const srsRows = Object.fromEntries(rows('SELECT * FROM gpkg_spatial_ref_sys').map((r) => [r.srs_id, r]));
  const hasSchema = rows("SELECT name FROM sqlite_master WHERE name IN ('gpkg_data_columns','gpkg_data_column_constraints')").length === 2;
  const layers = [];
  // A tiles-only GeoPackage has no gpkg_geometry_columns table (OGC 12-128: features option only).
  const hasGeomCols = rows("SELECT name FROM sqlite_master WHERE name = 'gpkg_geometry_columns'").length > 0;
  const featureTables = hasGeomCols ? rows("SELECT c.table_name, c.identifier, c.description, g.column_name, g.geometry_type_name, g.srs_id, g.z FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features'") : [];
  for (const c of featureTables) {
    const t = c.table_name;
    const geomCol = c.column_name;
    const info = rows(`PRAGMA table_info(${q(t)})`);
    const pk = info.find((r) => r.pk)?.name ?? 'fid';
    const fields = info.filter((r) => r.name !== geomCol && r.name !== pk && !['ufi', 'name', 'description'].includes(r.name)).map((r) => ({ name: r.name, type: fieldType(r.type) }));
    if (hasSchema) {
      for (const dc of rows('SELECT column_name, title, description, constraint_name FROM gpkg_data_columns WHERE table_name = ?', [t])) {
        const f = fields.find((x) => x.name === dc.column_name);
        if (!f) continue;
        if (dc.title && dc.title !== f.name) f.title = dc.title;
        if (dc.description) f.description = dc.description;
        if (dc.constraint_name) {
          const cs = rows('SELECT * FROM gpkg_data_column_constraints WHERE constraint_name = ?', [dc.constraint_name]);
          const en = cs.filter((x) => x.constraint_type === 'enum');
          if (en.length) f.domain = Object.fromEntries(en.map((x) => [x.value, x.description ?? x.value]));
          const rg = cs.find((x) => x.constraint_type === 'range');
          if (rg) f.range = [rg.min, rg.max];
        }
      }
    }
    const srs = srsRows[c.srs_id];
    let tf = null;
    if (c.srs_id !== 4326 && c.srs_id !== 4979 && c.srs_id !== 0) {
      tf = reproject?.(srs) ?? null;
      if (!tf) report.warnings.push(`${t}: SRS ${srs?.organization}:${srs?.organization_coordsys_id} is not known; coordinates read as longitude/latitude`);
    }
    const features = [];
    for (const r of rows(`SELECT * FROM ${q(t)}`)) {
      const b = r[geomCol];
      if (!(b instanceof Uint8Array)) continue;
      let g;
      try {
        g = decodeGeometry(b, tf);
      } catch (e) {
        report.warnings.push(`${t} fid ${r[pk]}: ${e.message}`);
        continue;
      }
      if (!g.geom) continue;
      const attrs = {};
      for (const f of fields) {
        let v = r[f.name];
        if (v === undefined) v = null;
        if (f.type === 'boolean' && v !== null) v = v === 1 || v === true || v === '1';
        attrs[f.name] = v;
      }
      features.push({ geom: g.geom, attrs, name: r.name ?? null, description: r.description ?? null, ufi: r.ufi ?? undefined, fid: r[pk] });
      report.features_in++;
      report.features_out++;
      report.by_geometry[g.geom.type] = (report.by_geometry[g.geom.type] ?? 0) + 1;
    }
    if (!c.z) report.warnings.push(`${t}: no Z (z = 0); heights set to 0`);
    layers.push({ name: c.identifier || t, table: t, fields, features, geometryType: c.geometry_type_name, srsId: c.srs_id });
  }
  const checks = { applicationId: appId, userVersion, tables: rows("SELECT name, type FROM sqlite_master WHERE type IN ('table','trigger')").map((r) => r.name) };
  // IMP-03 (TE-006): tile pyramids (OGC 12-128 §2.2). For each tiles table pick the finest zoom
  // level whose full matrix fits 8192², and return its tiles with the georeferencing; the caller
  // composites them into one image. Coverage (gridded) tables are named but not read.
  const tiles = [];
  const coverageSets = [];
  let coverages = [];
  try {
    coverages = rows("SELECT table_name FROM gpkg_contents WHERE data_type = '2d-gridded-coverage'").map((r) => r.table_name);
    for (const t of rows("SELECT c.table_name, c.identifier, c.srs_id AS csrs, c.min_x AS cx0, c.min_y AS cy0, c.max_x AS cx1, c.max_y AS cy1, s.srs_id, s.min_x, s.min_y, s.max_x, s.max_y, r.organization, r.organization_coordsys_id, r.definition FROM gpkg_contents c JOIN gpkg_tile_matrix_set s ON s.table_name = c.table_name LEFT JOIN gpkg_spatial_ref_sys r ON r.srs_id = s.srs_id WHERE c.data_type = 'tiles'")) {
      const zooms = rows(`SELECT zoom_level, matrix_width, matrix_height, tile_width, tile_height, pixel_x_size, pixel_y_size FROM gpkg_tile_matrix WHERE table_name = '${String(t.table_name).replace(/'/g, "''")}' ORDER BY zoom_level DESC`);
      // Finest level whose occupied tiles stay within the 64 Mpx plain-image limit. The extent
      // comes from the tiles present, not gpkg_contents (which may use another CRS: TE-027).
      const tq = String(t.table_name).replace(/"/g, '""');
      const occ = (m) => rows(`SELECT min(tile_column) AS c0, max(tile_column) AS c1, min(tile_row) AS r0, max(tile_row) AS r1 FROM "${tq}" WHERE zoom_level = ${Number(m.zoom_level)}`)[0];
      let z = null;
      let box = null;
      for (const m of zooms) {
        const o = occ(m);
        if (o?.c0 === null || o?.c0 === undefined) continue;
        z = m;
        box = o;
        if ((o.c1 - o.c0 + 1) * m.tile_width * (o.r1 - o.r0 + 1) * m.tile_height <= 60e6) break;
      }
      if (!z) continue;
      const data = rows(`SELECT tile_column, tile_row, tile_data FROM "${tq}" WHERE zoom_level = ${Number(z.zoom_level)}`);
      const epsg = /^epsg$/i.test(t.organization ?? '') ? Number(t.organization_coordsys_id) : null;
      tiles.push({ table: t.table_name, name: t.identifier || t.table_name, srsId: t.srs_id, epsg, wkt: t.definition && t.definition !== 'undefined' ? t.definition : null, bounds: [t.min_x, t.min_y, t.max_x, t.max_y], contents: t.csrs === t.srs_id ? [t.cx0, t.cy0, t.cx1, t.cy1] : null, occupied: [box.c0, box.r0, box.c1, box.r1], zoom: z.zoom_level, matrix: [z.matrix_width, z.matrix_height], tile: [z.tile_width, z.tile_height], pixel: [z.pixel_x_size, z.pixel_y_size], data: data.map((r) => ({ col: r.tile_column, row: r.tile_row, bytes: r.tile_data })) });
    }
    // IMP-11: 2D gridded coverages (OGC 17-066r1): elevation tiles as 16-bit PNG ('integer') or
    // 32-bit float TIFF ('float') with per-table and per-tile scale/offset, read like the tile
    // pyramids (finest zoom within 60 Mpx over the occupied tiles).
    if (coverages.length && rows("SELECT name FROM sqlite_master WHERE name = 'gpkg_2d_gridded_coverage_ancillary'").length) {
      const hasTileAnc = rows("SELECT name FROM sqlite_master WHERE name = 'gpkg_2d_gridded_tile_ancillary'").length > 0;
      for (const t of rows("SELECT c.table_name, c.identifier, c.srs_id AS csrs, c.min_x AS cx0, c.min_y AS cy0, c.max_x AS cx1, c.max_y AS cy1, s.srs_id, s.min_x, s.min_y, s.max_x, s.max_y, r.organization, r.organization_coordsys_id, r.definition, a.datatype, a.scale, a.offset, a.precision, a.data_null, a.grid_cell_encoding, a.uom FROM gpkg_contents c JOIN gpkg_tile_matrix_set s ON s.table_name = c.table_name JOIN gpkg_2d_gridded_coverage_ancillary a ON a.tile_matrix_set_name = c.table_name LEFT JOIN gpkg_spatial_ref_sys r ON r.srs_id = s.srs_id WHERE c.data_type = '2d-gridded-coverage'")) {
        const tq = String(t.table_name).replace(/"/g, '""');
        const zooms = rows(`SELECT zoom_level, matrix_width, matrix_height, tile_width, tile_height, pixel_x_size, pixel_y_size FROM gpkg_tile_matrix WHERE table_name = '${String(t.table_name).replace(/'/g, "''")}' ORDER BY zoom_level DESC`);
        let z = null;
        let box = null;
        for (const m of zooms) {
          const o = rows(`SELECT min(tile_column) AS c0, max(tile_column) AS c1, min(tile_row) AS r0, max(tile_row) AS r1 FROM "${tq}" WHERE zoom_level = ${Number(m.zoom_level)}`)[0];
          if (o?.c0 === null || o?.c0 === undefined) continue;
          z = m;
          box = o;
          if ((o.c1 - o.c0 + 1) * m.tile_width * (o.r1 - o.r0 + 1) * m.tile_height <= 60e6) break;
        }
        if (!z) continue;
        const anc = hasTileAnc ? Object.fromEntries(rows(`SELECT tpudt_id, scale, offset FROM gpkg_2d_gridded_tile_ancillary WHERE tpudt_name = '${String(t.table_name).replace(/'/g, "''")}'`).map((r) => [r.tpudt_id, r])) : {};
        const data = rows(`SELECT id, tile_column, tile_row, tile_data FROM "${tq}" WHERE zoom_level = ${Number(z.zoom_level)}`);
        const epsg = /^epsg$/i.test(t.organization ?? '') ? Number(t.organization_coordsys_id) : null;
        coverageSets.push({
          table: t.table_name,
          name: t.identifier || t.table_name,
          epsg,
          wkt: t.definition && t.definition !== 'undefined' ? t.definition : null,
          bounds: [t.min_x, t.min_y, t.max_x, t.max_y],
          // gpkg_contents clips the matrix set when both use one SRS (as GDAL does).
          contents: t.csrs === t.srs_id ? [t.cx0, t.cy0, t.cx1, t.cy1] : null,
          occupied: [box.c0, box.r0, box.c1, box.r1],
          zoom: z.zoom_level,
          tile: [z.tile_width, z.tile_height],
          pixel: [z.pixel_x_size, z.pixel_y_size],
          datatype: t.datatype,
          scale: t.scale ?? 1,
          offset: t.offset ?? 0,
          dataNull: t.data_null ?? null,
          uom: t.uom ?? null,
          data: data.map((r) => ({ col: r.tile_column, row: r.tile_row, bytes: r.tile_data, scale: anc[r.id]?.scale ?? 1, offset: anc[r.id]?.offset ?? 0 })),
        });
      }
    }
  } catch (e) {
    // Not a conformant tile matrix set: say so rather than dropping the pyramid silently (TE-036).
    report.warnings.push(`${name}: tile tables not read (${e.message})`);
  }
  db.close();
  if (coverages.length > coverageSets.length) report.warnings.push(`${name}: ${coverages.length - coverageSets.length} gridded coverage table(s) not read (no ancillary table or no tiles)`);
  if (!layers.length && !tiles.length && !coverageSets.length) report.warnings.push(`${name}: no feature tables`);
  return { layers, report, checks, tiles, coverages: coverageSets };
}
