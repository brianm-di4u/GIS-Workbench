// Schema-driven attribution (REQ-EXT-09/10/11/03, REQ-EXT-22/24/27): layers made from a feature
// class of the catalogue (the shipped TDS 7.1 subset or one imported from a GeoPackage), forms
// generated from the schema with coded domains, ranges, units and TDS nulls, persistent
// attribution (layer defaults that apply to features captured after they are set), attribute
// sets, auto-attribution (source image and date, height, length, area), style sheets as JSON rules
// keyed by class and attribute filters (also used for KML styles), custom tools (named modifier
// stacks), GeoPackage and CSV/WKT read and write, the MGCP cross-walk on export, and the ArcGIS Pro
// hand-off GeoPackage with coded domains.

import { h } from '../shell/dom.js';
import { modal, field, section, promptBox } from '../shell/dialogs.js';
import { saveBlob, pickFiles } from '../storage/files.js';
import { getCatalog, typeOf, fieldsFor, nullOf, checkValue, valueIssue, checkAttrs, coerce, crosswalkMGCP, catalogFromLayers, registerCatalog, listCatalogs, subtypeOf, contingentDomain, ruleIssues, columnOf } from '../vector/schema.js';
import { installCatalogs } from './catalogs.js';
import { loadSqlite, writeGpkg, readGpkg } from '../vector/gpkg.js';
import { readCsv, writeCsv } from '../vector/csv.js';
import { parts, isPolygonal, isLinear } from '../vector/geom.js';
import { crsOf, converter } from '../geo/crs.js';
import { decodeGrayPng } from '../formats/png-gray.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { yieldNow } from '../core/util.js';

export const name = 'attribution';

/** Default style sheet for the TDS subset (REQ-EXT-11). First matching rule wins. */
export const TDS_STYLES = [
  { class: 'AL013', filter: { field: 'PCF', op: '=', value: 6 }, style: { stroke: '#7a7a7a', fill: '#7a7a7a40', outline: '#5a5a5a', width: 2, dash: [4, 3] } },
  { class: 'AL013', style: { stroke: '#d84315', fill: '#d8431540', outline: '#d84315', width: 2 } },
  { class: 'AP030', filter: { field: 'RTY', op: '=', value: 1 }, style: { stroke: '#e53935', width: 4 } },
  { class: 'AP030', style: { stroke: '#f9a825', width: 3 } },
  { class: 'AN010', style: { stroke: '#212121', width: 3, dash: [8, 4] } },
  { class: 'BH140', style: { stroke: '#1e88e5', fill: '#1e88e540', outline: '#1e88e5', width: 2 } },
  { class: 'BH082', style: { stroke: '#1e88e5', fill: '#1e88e560', outline: '#1565c0', width: 1 } },
  { class: 'EC015', style: { stroke: '#2e7d32', fill: '#2e7d3240', outline: '#2e7d32', width: 1 } },
  { class: 'EC005', style: { stroke: '#2e7d32', width: 2 } },
  { class: 'AQ040', style: { stroke: '#6d4c41', width: 4 } },
];

const OPS = { '=': (a, b) => String(a) === String(b), '≠': (a, b) => String(a) !== String(b), '<': (a, b) => Number(a) < Number(b), '>': (a, b) => Number(a) > Number(b), '≥': (a, b) => Number(a) >= Number(b), '≤': (a, b) => Number(a) <= Number(b) };

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const vlayers = () => S.all('vlayer');
  const activeLayerId = () => {
    const id = app.prefs.get('vlayerActive');
    return id && S.has(id) ? id : vlayers()[0]?.id ?? null;
  };
  const catOf = (v) => getCatalog(v?.schema?.catalog) ?? null;
  const fieldsOf = (v) => v?.fields ?? [];

  // ---- schema layers ----
  /** A new layer for a feature class (its fields from the catalogue). */
  function newSchemaLayer(code, { name: nm = null, catalog = getCatalog().id, subtype = null, activate = true } = {}) {
    const cat = getCatalog(catalog);
    if (!cat) throw gwError('no feature catalogue {id}', { id: String(catalog) }, 'E_NO_CATALOG');
    const ft = typeOf(cat, code);
    if (!ft) throw gwError('feature class {code} is not in the catalogue', { code }, 'E_UNKNOWN_FEATURE_CLASS');
    // A type whose one subtype is itself (an OSM preset, its tags fixed there) takes it unless told otherwise.
    const own = subtype == null && ft.subtypes?.length === 1 && ft.subtypes[0].code === code;
    const st = subtypeOf(cat, code, own ? code : subtype);
    if (subtype && !st) throw gwError('{code} has no subtype {subtype}', { code: String(code), subtype: String(subtype) }, 'E_FEATURE_SUBTYPE');
    let id;
    const label = st ? `${ft.name} / ${st.name}` : ft.name; // catalogue data
    const fields = fieldsFor(cat, code, st?.code ?? null);
    // The subtype's values are by catalogue key; the layer's defaults are by column (decision #243).
    const defaults = st ? Object.fromEntries(Object.entries({ ...st.fixed, ...(ft.subtypeField ? { [ft.subtypeField]: st.code } : {}) }).map(([k, x]) => [columnOf(cat, k), x]).filter(([k]) => fields.some((f) => f.name === k))) : {};
    S.transact(t('New {class} layer', { class: label }), (tx) => {
      id = tx.create('vlayer', { name: nm ?? `${label} (${st ? `${code}/${st.code}` : code})`, visible: true, style: { stroke: '#ff2020', width: 2, fill: '#ff202040', outline: '#2060ff' }, styleRules: TDS_STYLES, fields, schema: { catalog: cat.id, code, name: ft.name, geometry: ft.geometry, ...(st ? { subtype: st.code, subtypeName: st.name, subtypeField: ft.subtypeField ? columnOf(cat, ft.subtypeField) : null } : {}) }, defaults, attrSets: {}, source: { format: 'new' }, created: new Date().toISOString() });
    });
    if (activate) app.prefs.set('vlayerActive', id);
    return id;
  }

  /** Attributes for a new feature (REQ-EXT-09): nulls, F_CODE/UFI, the layer defaults, auto values. */
  function initialAttrs(layerId, geom, ctx = {}) {
    const v = S.get(layerId);
    if (!v?.schema) return {};
    const cat = catOf(v);
    const out = {};
    for (const f of fieldsOf(v)) out[f.name] = nullOf(cat, f);
    out.F_CODE = v.schema.code;
    if (ctx.ufi && 'UFI' in out) out.UFI = ctx.ufi;
    for (const f of fieldsOf(v)) {
      const a = f.auto;
      if (!a) continue;
      const val = autoValue(a, geom, ctx);
      if (val !== undefined && val !== null && !checkValue(cat, f, val)) out[f.name] = val;
    }
    Object.assign(out, v.defaults ?? {});
    return out;
  }

  function autoValue(rule, geom, ctx) {
    const l = ctx.layer;
    if (rule === 'image.name') return l?.rec?.name ?? undefined;
    if (rule === 'image.date') return l?.info?.date ?? l?.info?.meta?.IDATIM ?? undefined;
    if (rule === 'length' && isLinear(geom)) return Math.round(lengthOf(geom) * 100) / 100;
    if (rule === 'area' && isPolygonal(geom)) return Math.round(areaOf(geom) * 100) / 100;
    if (rule === 'height' && Number.isFinite(ctx.height)) return Math.round(ctx.height * 100) / 100;
    return undefined;
  }
  const lengthOf = (g) => {
    let s = 0;
    for (const p of parts(g)) for (let i = 1; i < p.length; i++) s += app.core.inverse(p[i - 1][1], p[i - 1][0], p[i][1], p[i][0]).distance;
    return s;
  };
  const areaOf = (g) => {
    let s = 0;
    for (const [k, r] of parts(g).entries()) {
      const lat0 = r[0][1];
      const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
      const ky = 110574;
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const p = r[i];
        const q = r[(i + 1) % r.length];
        a += (p[0] - r[0][0]) * kx * ((q[1] - r[0][1]) * ky) - (q[0] - r[0][0]) * kx * ((p[1] - r[0][1]) * ky);
      }
      s += (k === 0 ? 1 : -1) * Math.abs(a / 2);
    }
    return Math.abs(s);
  };

  /** Set layer defaults (persistent attribution, AC-10.2): later captures take them. */
  function setDefaults(layerId, values) {
    const v = S.get(layerId);
    const cat = catOf(v);
    for (const [k, val] of Object.entries(values)) {
      const f = fieldsOf(v).find((x) => x.name === k);
      const m = f && valueIssue(cat, f, val);
      if (m) throw m;
    }
    S.transact(t('Set default attributes'), (tx) => tx.set(layerId, 'defaults', { ...(v.defaults ?? {}), ...values }));
  }

  /** Set one attribute with its domain/range check (AC-10.3); throws with the allowed values. */
  function setAttr(featureId, nameK, value) {
    const f = S.get(featureId);
    const v = S.get(f?.vlayer);
    const fd = fieldsOf(v).find((x) => x.name === nameK);
    const val = fd ? coerce(fd, value) : value;
    const m = v?.schema && fd ? valueIssue(catOf(v), fd, val) ?? contingentIssue(v, f.attrs, nameK, val) : null;
    if (m) throw m;
    S.transact(t('Edit {field}', { field: nameK }), (tx) => tx.set(featureId, 'attrs', { ...f.attrs, [nameK]: val }));
  }
  /**
   * A value outside the contingent domain or range of its field, or against the subtype's fixed
   * value, given the feature's other attributes (REQ-GAP-53): the error, else null. Required and
   * forbidden fields are reported by validation, since they depend on edits still to come.
   */
  function contingentIssue(v, attrs, nameK, val) {
    const cat = catOf(v);
    const iss = ruleIssues(cat, v.schema, fieldsOf(v), { ...attrs, [nameK]: val }).find((r) => r.field === nameK && ['E_RULE_DOMAIN', 'E_RULE_RANGE', 'E_SUBTYPE_FIXED'].includes(r.code));
    if (!iss) return null;
    const e = new Error(iss.message);
    e.code = iss.code;
    e.i18n = iss.i18n;
    return e;
  }
  /** For the attribute table: a message when the edit is not allowed, else null. */
  function checkEdit(f, nameK, value) {
    return editIssue(f, nameK, value)?.message ?? null;
  }
  /** The same check as an error with its message key and code (show it with msgOf), else null. */
  function editIssue(f, nameK, value) {
    const v = S.get(f.vlayer);
    const fd = fieldsOf(v).find((x) => x.name === nameK);
    return v?.schema && fd ? valueIssue(catOf(v), fd, value) ?? contingentIssue(v, f.attrs, nameK, coerce(fd, value)) : null;
  }

  /** Attribute sets: named value presets per layer. */
  function saveSet(layerId, setName, values) {
    const v = S.get(layerId);
    S.transact(t('Save attribute set'), (tx) => tx.set(layerId, 'attrSets', { ...(v.attrSets ?? {}), [setName]: values }));
  }
  function applySet(layerId, setName, featureIds) {
    const v = S.get(layerId);
    const vals = v.attrSets?.[setName];
    if (!vals) throw gwError('no attribute set {name}', { name: setName }, 'E_NO_ATTR_SET');
    S.transact(t('Apply {name}', { name: setName }), (tx) => {
      for (const id of featureIds) {
        const f = S.get(id);
        if (f) tx.set(id, 'attrs', { ...f.attrs, ...vals });
      }
    });
  }

  /** The style for a feature from its layer's rules (REQ-EXT-11). */
  function ruleStyle(v, f) {
    const rules = v?.styleRules;
    if (!rules?.length) return null;
    const code = f.attrs?.F_CODE ?? v.schema?.code;
    for (const r of rules) {
      if (r.class && r.class !== code) continue;
      if (r.filter && !OPS[r.filter.op ?? '=']?.(f.attrs?.[r.filter.field], r.filter.value)) continue;
      return r.style;
    }
    return null;
  }

  /** Every attribute issue of a layer's features (validation, REQ-EXT-13): [{featureId, field, message}]. */
  function attributeIssues(layerId) {
    const v = S.get(layerId);
    if (!v?.schema) return [];
    const cat = catOf(v);
    const out = [];
    for (const f of S.all('feature').filter((x) => x.vlayer === layerId)) for (const m of checkAttrs(cat, fieldsOf(v), f.attrs, v.schema)) out.push({ featureId: f.id, ...m });
    return out;
  }

  // ---- the form ----
  async function openForm(featureId) {
    const f = S.get(featureId);
    const v = S.get(f?.vlayer);
    if (!f || !v) return;
    const cat = catOf(v);
    const fs = fieldsOf(v);
    const inputs = {};
    /** A coded field's choices: its domain, after an empty one when the field's null is empty and no code means it. */
    const choices = (fd, dom) => {
      const blank = nullOf(cat, fd);
      const keys = (blank === '' || blank === null) && !('' in dom) ? ['', ...Object.keys(dom)] : Object.keys(dom);
      return keys.map((k) => h('option', { value: k }, k === '' ? '' : `${k} — ${dom[k]}`));
    };
    const rows = fs.map((fd) => {
      const cur = f.attrs?.[fd.name];
      let el;
      if (fd.domain) {
        el = h('select', { class: 'inp', 'aria-label': fd.title ?? fd.name }, choices(fd, fd.domain));
        el.value = cur === null || cur === undefined ? String(nullOf(cat, fd) ?? '') : String(cur);
      } else {
        el = h('input', { class: 'inp', type: fd.type === 'string' ? 'text' : 'number', spellcheck: fd.type === 'string' ? 'true' : 'false', step: 'any', value: cur === null || cur === undefined ? '' : String(cur), 'aria-label': fd.title ?? fd.name, ...(fd.range ? { min: String(fd.range[0]), max: String(fd.range[1]) } : {}), ...(fd.length ? { maxlength: String(fd.length) } : {}) });
      }
      inputs[fd.name] = el;
      // Field names, titles, units and ranges are schema data (TDS/MGCP or the GeoPackage's own).
      const label = `${fd.title ?? fd.name}${fd.unit ? ` (${fd.unit})` : ''}${fd.required ? ' *' : ''}`;
      return field(`${fd.name} · ${label}`, el, fd.range ? `${fd.range[0]} – ${fd.range[1]}` : '');
    });
    const err = h('p', { class: 'hint err', role: 'alert' });
    // Contingent domains (REQ-GAP-53): a coded field offers only the values its rules allow for
    // the other values chosen; they are recomputed whenever a value changes.
    const current = () => Object.fromEntries(fs.map((fd) => [fd.name, coerce(fd, inputs[fd.name].value)]));
    const refreshDomains = () => {
      if (!v.schema) return;
      const at = current();
      for (const fd of fs) {
        if (!fd.domain) continue;
        const el = inputs[fd.name];
        const dom = contingentDomain(cat, v.schema, fs, fd.name, at) ?? fd.domain;
        const opts = choices(fd, dom);
        const keys = opts.map((o) => o.value);
        const have = [...el.options].map((o) => o.value);
        if (have.length === keys.length && have.every((k, i) => k === keys[i])) continue;
        const was = el.value;
        el.replaceChildren(...opts);
        el.value = keys.includes(was) ? was : String(nullOf(cat, fd) ?? '');
      }
    };
    for (const fd of fs) inputs[fd.name].addEventListener('change', refreshDomains);
    refreshDomains();
    const st = v.schema?.subtypeName ? ` / ${v.schema.subtypeName}` : '';
    const asDefault = h('input', { type: 'checkbox', 'aria-label': t('Use these values as the layer defaults') });
    const body = h('div', { class: 'attr-form' }, section(`${v.schema?.name ?? v.name}${st} ${v.schema?.code ?? ''}`, ...rows), h('label', {}, asDefault, ` ${t('Make these the defaults for new features (persistent attribution)')}`), err);
    for (;;) {
      const r = await modal({ title: t('Attributes'), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'attr-form' });
      if (r !== 'ok') return;
      const vals = {};
      const msgs = [];
      for (const fd of fs) {
        const val = coerce(fd, inputs[fd.name].value);
        const m = v.schema ? valueIssue(cat, fd, val ?? nullOf(cat, fd)) : null;
        if (m) msgs.push(msgOf(m));
        vals[fd.name] = val ?? (v.schema ? nullOf(cat, fd) : null);
      }
      if (v.schema && !msgs.length) for (const r of ruleIssues(cat, v.schema, fs, { ...f.attrs, ...vals })) msgs.push(msgOf(r));
      if (msgs.length) {
        err.textContent = msgs.join(' · ');
        continue;
      }
      S.transact(t('Edit attributes'), (tx) => tx.set(featureId, 'attrs', { ...f.attrs, ...vals }));
      if (asDefault.checked) {
        const d = { ...vals };
        for (const k of ['F_CODE', 'UFI', 'ARA', 'LZN']) delete d[k];
        setDefaults(v.id, d);
      }
      return;
    }
  }

  // ---- custom tools (REQ-EXT-03) ----
  const MODS = ['snap', 'tol', 'ortho', 'square', 'constZ', 'z', 'close', 'ngon'];
  function saveCustomTool(nm, tool, mods = null) {
    const cur = app.prefs.get('extract') ?? {};
    const m = mods ?? Object.fromEntries(MODS.filter((k) => k in cur).map((k) => [k, cur[k]]));
    const list = (app.prefs.get('customTools') ?? []).filter((x) => x.name !== nm);
    list.push({ name: nm, tool, mods: m, layer: activeLayerId() });
    app.prefs.set('customTools', list);
    app.emit('state');
  }
  function runCustomTool(nm) {
    const ct = (app.prefs.get('customTools') ?? []).find((x) => x.name === nm);
    if (!ct) throw gwError('no custom tool {name}', { name: nm }, 'E_NO_CUSTOM_TOOL');
    app.prefs.set('extract', { ...(app.prefs.get('extract') ?? {}), ...ct.mods });
    if (ct.layer && S.has(ct.layer)) app.prefs.set('vlayerActive', ct.layer);
    app.selectExtractTool(ct.tool);
    return ct;
  }

  // ---- GeoPackage, CSV ----
  const sqlite = () => loadSqlite(app.gw);
  const reprojectSrs = (srs) => {
    const crs = srs?.organization?.toUpperCase() === 'EPSG' ? crsOf({ epsg: srs.organization_coordsys_id }) : crsOf({ wkt: srs?.definition });
    if (!crs) return null;
    const c = converter(crs);
    return (x, y, z) => [...c.toLonLat(x, y), z];
  };
  /** Open a GeoPackage: every feature table as a layer; a catalogue from its domains. */
  async function openGpkgBytes(bytes, nm) {
    const SQL = await sqlite();
    const { layers, report, tiles, coverages } = readGpkg(SQL, bytes, { reproject: reprojectSrs, name: nm });
    // IMP-03: each tile pyramid level becomes one georeferenced image (PNG + world file + .prj)
    // opened through the normal image path.
    let tilesOpened = 0;
    for (const ts of tiles ?? [])
      await openTileSet(ts, nm).then(
        () => tilesOpened++,
        (e) => app.toast(t('{file} / {table}: {msg}', { file: nm, table: ts.name, msg: msgOf(e) }), { kind: 'error', ms: 8000 }),
      );
    for (const c of coverages ?? [])
      await openCoverage(c, nm).then(
        () => tilesOpened++,
        (e) => app.toast(t('{file} / {table}: {msg}', { file: nm, table: c.name, msg: msgOf(e) }), { kind: 'error', ms: 8000 }),
      );
    const hasDomains = layers.some((l) => l.fields.some((f) => f.domain || f.range));
    const cat = hasDomains ? registerCatalog(catalogFromLayers(nm.replace(/\.gpkg$/i, ''), layers)) : null;
    const ids = [];
    for (const l of layers) {
      await yieldNow(); // storing a large table is long: a task of its own after the read (#63)
      const id = app.addVectorLayer(l, { format: 'GeoPackage', file: nm, table: l.table, report });
      if (cat) {
        const code = l.features.find((x) => x.attrs?.F_CODE)?.attrs.F_CODE ?? l.table;
        S.transact(t('Schema from GeoPackage'), (tx) => tx.set(id, 'schema', { catalog: cat.id, code, name: l.name, geometry: [l.geometryType] }), { kind: 'load' });
      }
      ids.push({ id, report });
    }
    ids.tilesOpened = tilesOpened;
    return ids;
  }
  async function openTileSet(ts, nm) {
    if (!ts.data.length) throw gwError('zoom level {z} holds no tiles', { z: String(ts.zoom) }, 'E_ZOOM_NO_TILES');
    const [tw, th] = ts.tile;
    // Only the occupied tile window is composited (TE-027: zoom 16 of a world matrix is 16 M px wide).
    const [c0, r0, c1, r1] = ts.occupied;
    const [px, py] = ts.pixel;
    const [mx0, , , my1] = ts.bounds;
    // Window in matrix pixels: the occupied tiles, cut to the contents extent when it shares the
    // matrix SRS, as GDAL does (TE 2.0.4: the padding of the last tile column came in as a black strip).
    let wx0 = c0 * tw;
    let wy0 = r0 * th;
    let wx1 = (c1 + 1) * tw;
    let wy1 = (r1 + 1) * th;
    if (ts.contents?.every(Number.isFinite)) {
      wx0 = Math.max(wx0, Math.round((ts.contents[0] - mx0) / px));
      wx1 = Math.min(wx1, Math.round((ts.contents[2] - mx0) / px));
      wy0 = Math.max(wy0, Math.round((my1 - ts.contents[3]) / py));
      wy1 = Math.min(wy1, Math.round((my1 - ts.contents[1]) / py));
      if (!(wx1 > wx0 && wy1 > wy0)) [wx0, wy0, wx1, wy1] = [c0 * tw, r0 * th, (c1 + 1) * tw, (r1 + 1) * th];
    }
    const W = wx1 - wx0;
    const H = wy1 - wy0;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    let drawn = 0;
    for (const d of ts.data) {
      try {
        const bmp = await createImageBitmap(new Blob([d.bytes]));
        g.drawImage(bmp, d.col * tw - wx0, d.row * th - wy0, tw, th);
        bmp.close?.();
        drawn++;
      } catch {
        /* an undecodable tile stays empty */
      }
    }
    if (!drawn) throw new Error('no tile could be decoded (PNG/JPEG/WebP expected)');
    const png = await c.convertToBlob({ type: 'image/png' });
    // Tile (0, 0) starts at the tile matrix set's top-left corner (OGC 12-128 §2.2.7).
    const stem = `${nm.replace(/\.gpkg$/i, '')}_${ts.table}_z${ts.zoom}`;
    const world = [px, 0, 0, -py, mx0 + (wx0 + 0.5) * px, my1 - (wy0 + 0.5) * py].join('\n');
    const files = [new File([png], `${stem}.png`, { type: 'image/png' }), new File([world], `${stem}.pgw`)];
    const prj = ts.wkt ?? (ts.epsg === 4326 ? 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]' : ts.epsg === 3857 ? 'PROJCS["WGS 84 / Pseudo-Mercator",AUTHORITY["EPSG","3857"]]' : null);
    if (prj) files.push(new File([prj], `${stem}.prj`));
    await app.openFiles(files);
    app.importLog.push({ file: nm, errors: [], warnings: [t('{table}: tile pyramid zoom {z} ({mw}×{mh} matrix, tiles of {tw}×{th}, {n} decoded) opened as {file}', { table: ts.name, z: String(ts.zoom), mw: String(ts.matrix[0]), mh: String(ts.matrix[1]), tw: String(tw), th: String(th), n: drawn, file: `${stem}.png` })] });
  }

  /**
   * IMP-11: a gridded coverage level as a float GeoTIFF (heights, NaN no-data), opened as a DEM-
   * ready image. value = (raw · tile scale + tile offset) · scale + offset; raw = data_null is
   * no-data. Clipped to gpkg_contents when it shares the matrix set's SRS, as GDAL does.
   */
  async function openCoverage(c, nm) {
    if (!c.data.length) throw gwError('zoom level {z} holds no tiles', { z: String(c.zoom) }, 'E_ZOOM_NO_TILES');
    const [tw, th] = c.tile;
    const [c0, r0, c1, r1] = c.occupied;
    const [px, py] = c.pixel;
    const [mx0, , , my1] = c.bounds;
    // Window in matrix pixels: the occupied tiles, cut to the contents extent.
    let x0 = c0 * tw;
    let y0 = r0 * th;
    let x1 = (c1 + 1) * tw;
    let y1 = (r1 + 1) * th;
    if (c.contents) {
      x0 = Math.max(x0, Math.round((c.contents[0] - mx0) / px));
      x1 = Math.min(x1, Math.round((c.contents[2] - mx0) / px));
      y0 = Math.max(y0, Math.round((my1 - c.contents[3]) / py));
      y1 = Math.min(y1, Math.round((my1 - c.contents[1]) / py));
    }
    const W = x1 - x0;
    const H = y1 - y0;
    if (W <= 0 || H <= 0) throw new Error('the coverage tiles lie outside its contents extent');
    const out = new Float32Array(W * H).fill(NaN);
    let decoded = 0;
    for (const d of c.data) {
      let px2;
      let dw;
      let dh;
      try {
        if (c.datatype === 'float' || (d.bytes[0] === 0x49 && d.bytes[1] === 0x49) || (d.bytes[0] === 0x4d && d.bytes[1] === 0x4d)) {
          const r = await app.pool.run('tiffBand', { bytes: d.bytes.slice() }, { kind: 'decode', label: t('coverage tile') });
          [px2, dw, dh] = [r.data, r.width, r.height];
        } else {
          const g = decodeGrayPng(d.bytes);
          [px2, dw, dh] = [g.data, g.width, g.height];
        }
      } catch {
        continue; // an undecodable tile stays no-data
      }
      decoded++;
      for (let y = 0; y < dh; y++) {
        const gy = d.row * th + y - y0;
        if (gy < 0 || gy >= H) continue;
        for (let x = 0; x < dw; x++) {
          const gx = d.col * tw + x - x0;
          if (gx < 0 || gx >= W) continue;
          const raw = px2[y * dw + x];
          if (c.dataNull !== null && raw === c.dataNull) continue;
          out[gy * W + gx] = (raw * d.scale + d.offset) * c.scale + c.offset;
        }
      }
    }
    if (!decoded) throw new Error('no coverage tile could be decoded (16-bit PNG or float TIFF expected)');
    if (!c.epsg) throw new Error('the coverage SRS has no EPSG code');
    const stem = `${nm.replace(/\.gpkg$/i, '')}_${c.table}_z${c.zoom}`;
    const bytes = await writeGeoTiff({ width: W, height: H, bands: 1, type: 'f32', data: out }, { epsg: c.epsg, geotransform: [mx0 + x0 * px, px, 0, my1 - y0 * py, 0, -py], nodata: NaN, description: `${c.name} (${c.uom ?? 'height'}) from ${nm}, GeoPackage gridded coverage zoom ${c.zoom}`, overviews: true });
    await app.openFiles([new File([bytes], `${stem}.tif`, { type: 'image/tiff' })]);
    app.importLog.push({ file: nm, errors: [], warnings: [t('{table}: gridded coverage zoom {z} ({type}, {n, plural, one {# tile} other {# tiles}}) opened as {file}, {w}×{h}', { table: c.name, z: String(c.zoom), type: c.datatype, n: decoded, file: `${stem}.tif`, w: String(W), h: String(H) })] });
  }

  async function gpkgBytes(layerIds, { mgcp = false, title } = {}) {
    const SQL = await sqlite();
    const layers = layerIds.map((id) => {
      const v = S.get(id);
      let l = app.vectorLayerOut(id);
      if (mgcp && v.schema) l = crosswalkMGCP(catOf(v), l, v.schema.code);
      return l;
    });
    return writeGpkg(SQL, layers, { title: title ?? `GIS Workbench — ${layers.map((l) => l.name).join(', ')}`, analyst: app.prefs.get('analyst') ?? '' });
  }

  app.attribution = { newSchemaLayer, initialAttrs, setDefaults, setAttr, checkEdit, editIssue, saveSet, applySet, ruleStyle, attributeIssues, openForm, saveCustomTool, runCustomTool, openGpkgBytes, gpkgBytes, readCsv, writeCsv, catalogs: listCatalogs, catalog: getCatalog, fieldsFor, crosswalkMGCP, contingentDomain: (layerId, nameK, attrs) => {
    const v = S.get(layerId);
    return v?.schema ? contingentDomain(catOf(v), v.schema, fieldsOf(v), nameK, attrs) : null;
  } };
  // User and pack feature catalogues (REQ-GAP-52/53): import, keep in the project and settings.
  installCatalogs(app);
  app.vectorReaders = { ...(app.vectorReaders ?? {}), gpkg: openGpkgBytes, csv: async (b, nm) => [{ id: app.addVectorLayer(readCsv(new TextDecoder().decode(b), { name: nm.replace(/\.\w+$/, '') }).layer, { format: 'CSV', file: nm }) }] };

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 8000 });
    }
  };
  const OK_CANCEL = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
  C.implement('ext.newschema', {
    run: run(async () => {
      // Catalogue names, feature class codes, names and geometry types are catalogue data (TDS, NAS, a user file).
      const cats = listCatalogs();
      let cat = getCatalog(app.prefs.get('catalogLast')) ?? getCatalog();
      const catSel = h('select', { class: 'inp', 'aria-label': t('Feature catalogue'), 'data-id': 'ext-newschema:catalog' }, cats.map((c) => h('option', { value: c.id, selected: c.id === cat.id }, `${c.name}${c.version ? ` ${c.version}` : ''}`)));
      const sel = h('select', { class: 'inp', 'aria-label': t('Feature class'), 'data-id': 'ext-newschema:class' });
      const sub = h('select', { class: 'inp', 'aria-label': t('Subtype'), 'data-id': 'ext-newschema:subtype' });
      const subRow = field(t('Subtype'), sub);
      const fillSub = () => {
        const ft = typeOf(cat, sel.value);
        sub.replaceChildren(h('option', { value: '' }, t('(none)')), ...(ft?.subtypes ?? []).map((s) => h('option', { value: s.code, selected: ft.subtypes.length === 1 && s.code === ft.code }, `${s.code} ${s.name}`)));
        subRow.hidden = !ft?.subtypes?.length;
      };
      const fill = () => {
        sel.replaceChildren(...cat.types.map((ft) => h('option', { value: ft.code }, `${ft.code} ${ft.name} (${ft.geometry.join('/')})`)));
        fillSub();
      };
      catSel.addEventListener('change', () => {
        cat = getCatalog(catSel.value) ?? cat;
        fill();
      });
      sel.addEventListener('change', fillSub);
      fill();
      if ((await modal({ title: t('New Layer from Schema'), body: h('div', {}, field(t('Feature catalogue'), catSel), field(t('Feature class'), sel), subRow), buttons: OK_CANCEL(), id: 'ext-newschema' })) !== 'ok') return;
      app.prefs.set('catalogLast', cat.id);
      newSchemaLayer(sel.value, { catalog: cat.id, subtype: sub.value });
    }),
  });
  C.implement('ext.attributes', {
    enabled: () => [...app.selection].some((id) => S.get(id)?.type === 'feature'),
    run: run(async () => {
      const id = [...app.selection].find((x) => S.get(x)?.type === 'feature');
      if (id) await openForm(id);
    }),
  });
  C.implement('ext.attrsets', {
    enabled: () => !!S.get(activeLayerId())?.schema,
    run: run(async () => {
      const v = S.get(activeLayerId());
      const sets = Object.keys(v.attrSets ?? {});
      const sel = h('select', { class: 'inp', 'aria-label': t('Attribute set') }, sets.map((s) => h('option', { value: s }, s)));
      const chosen = [...app.selection].filter((x) => S.get(x)?.vlayer === v.id);
      const r = await modal({ title: t('Attribute Sets'), body: h('div', {}, field(t('Set'), sel, sets.length ? '' : t('No sets yet: "Save Defaults as Set" stores the layer defaults under a name.')), h('p', { class: 'hint' }, t('{n, plural, one {# selected feature} other {# selected features}} in {layer}', { n: chosen.length, layer: v.name }))), buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Save Defaults as Set…'), value: 'save' }, { label: t('Close'), value: 'close' }], id: 'ext-attrsets' });
      if (r === 'apply' && sel.value) applySet(v.id, sel.value, chosen);
      if (r === 'save') {
        const nm = await promptBox(t('Save Attribute Set'), t('Name'), t('Set 1'));
        if (nm) saveSet(v.id, nm, v.defaults ?? {});
      }
    }),
  });
  C.implement('ext.custom', {
    run: run(async () => {
      const list = app.prefs.get('customTools') ?? [];
      // The base tool shows its command id stem (point, polyline, rect3…), as before.
      const sel = h('select', { class: 'inp', 'aria-label': t('Custom tool') }, list.map((ct) => h('option', { value: ct.name }, `${ct.name} — ${ct.tool.replace('ext.', '')}`)));
      const tool = h('select', { class: 'inp', 'aria-label': t('Base tool') }, ['ext.point', 'ext.polyline', 'ext.polygon', 'ext.rect3', 'ext.ngon'].map((id) => h('option', { value: id }, id.replace('ext.', ''))));
      const r = await modal({ title: t('Custom Tools'), body: h('div', {}, field(t('Run a saved tool'), sel), section(t('Save the current modifiers as a tool'), field(t('Base tool'), tool))), buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Save Current…'), value: 'save' }, { label: t('Close'), value: 'close' }], id: 'ext-custom' });
      if (r === 'run' && sel.value) runCustomTool(sel.value);
      if (r === 'save') {
        const nm = await promptBox(t('Save Custom Tool'), t('Name'), t('Squared building'));
        if (nm) saveCustomTool(nm, tool.value);
      }
    }),
  });
  C.implement('ext.styles', {
    enabled: () => !!activeLayerId(),
    run: run(async () => {
      const id = activeLayerId();
      const v = S.get(id);
      const ta = h('textarea', { class: 'inp mono', rows: '14', 'aria-label': t('Style sheet (JSON rules)') }, JSON.stringify(v.styleRules ?? TDS_STYLES, null, 1));
      if ((await modal({ title: t('Style Sheet — {layer}', { layer: v.name }), body: h('div', {}, ta, h('p', { class: 'hint' }, t("Rules: '{'class, filter: '{'field, op, value'}', style: '{'stroke, fill, outline, width'}}'; the first match wins. KML export writes them as shared styles."))), buttons: OK_CANCEL(), width: 620, id: 'ext-styles' })) !== 'ok') return;
      const rules = JSON.parse(ta.value);
      if (!Array.isArray(rules)) throw new Error('the style sheet must be a JSON array of rules');
      S.transact(t('Style sheet'), (tx) => tx.set(id, 'styleRules', rules));
    }),
  });
  C.implement('ext.arcgis', {
    enabled: () => vlayers().length > 0,
    run: run(async () => {
      const ids = vlayers().map((v) => v.id);
      const { bytes, report } = await gpkgBytes(ids, { title: 'GIS Workbench hand-off to ArcGIS Pro' }); // i18n-ignore: written into the GeoPackage (file content, not UI)
      await saveBlob(app, new Blob([bytes], { type: 'application/geopackage+sqlite3' }), { name: `${(app.project()?.name || 'handoff').replace(/[^\w.-]+/g, '_')}_arcgis.gpkg`, types: ['.gpkg'], description: 'GeoPackage' });
      app.toast(t('ArcGIS Pro hand-off: {tables, plural, one {# table} other {# tables}}, {n, plural, one {# feature} other {# features}}; coded domains in gpkg_data_column_constraints', { tables: report.tables.length, n: report.features_out }), { kind: 'info' });
    }),
  });
  C.implement('file.opengpkg', { run: run(async () => app.openVectorFiles(await pickFiles(app, { accept: ['.gpkg', '.csv'], description: t('GeoPackage or CSV') }))) });
}
