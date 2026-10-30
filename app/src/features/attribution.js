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
import { getCatalog, typeOf, fieldsFor, nullOf, checkValue, checkAttrs, coerce, crosswalkMGCP, catalogFromLayers, registerCatalog, listCatalogs } from '../vector/schema.js';
import { loadSqlite, writeGpkg, readGpkg } from '../vector/gpkg.js';
import { readCsv, writeCsv } from '../vector/csv.js';
import { parts, isPolygonal, isLinear } from '../vector/geom.js';
import { crsOf, converter } from '../geo/crs.js';
import { decodeGrayPng } from '../formats/png-gray.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';

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
  function newSchemaLayer(code, { name: nm = null, catalog = getCatalog().id, activate = true } = {}) {
    const cat = getCatalog(catalog);
    const t = typeOf(cat, code);
    if (!t) throw new Error(`feature class ${code} is not in the catalogue`);
    let id;
    S.transact(`New ${t.name} layer`, (tx) => {
      id = tx.create('vlayer', { name: nm ?? `${t.name} (${code})`, visible: true, style: { stroke: '#ff2020', width: 2, fill: '#ff202040', outline: '#2060ff' }, styleRules: TDS_STYLES, fields: fieldsFor(cat, code), schema: { catalog: cat.id, code, name: t.name, geometry: t.geometry }, defaults: {}, attrSets: {}, source: { format: 'new' }, created: new Date().toISOString() });
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
      const m = f && checkValue(cat, f, val);
      if (m) throw new Error(m);
    }
    S.transact('Set default attributes', (tx) => tx.set(layerId, 'defaults', { ...(v.defaults ?? {}), ...values }));
  }

  /** Set one attribute with its domain/range check (AC-10.3); throws with the allowed values. */
  function setAttr(featureId, nameK, value) {
    const f = S.get(featureId);
    const v = S.get(f?.vlayer);
    const fd = fieldsOf(v).find((x) => x.name === nameK);
    const val = fd ? coerce(fd, value) : value;
    const m = v?.schema && fd ? checkValue(catOf(v), fd, val) : null;
    if (m) throw new Error(m);
    S.transact(`Edit ${nameK}`, (tx) => tx.set(featureId, 'attrs', { ...f.attrs, [nameK]: val }));
  }
  /** For the attribute table: a message when the edit is not allowed, else null. */
  function checkEdit(f, nameK, value) {
    const v = S.get(f.vlayer);
    const fd = fieldsOf(v).find((x) => x.name === nameK);
    return v?.schema && fd ? checkValue(catOf(v), fd, value) : null;
  }

  /** Attribute sets: named value presets per layer. */
  function saveSet(layerId, setName, values) {
    const v = S.get(layerId);
    S.transact('Save attribute set', (tx) => tx.set(layerId, 'attrSets', { ...(v.attrSets ?? {}), [setName]: values }));
  }
  function applySet(layerId, setName, featureIds) {
    const v = S.get(layerId);
    const vals = v.attrSets?.[setName];
    if (!vals) throw new Error(`no attribute set ${setName}`);
    S.transact(`Apply ${setName}`, (tx) => {
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
    for (const f of S.all('feature').filter((x) => x.vlayer === layerId)) for (const m of checkAttrs(cat, fieldsOf(v), f.attrs)) out.push({ featureId: f.id, ...m });
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
    const rows = fs.map((fd) => {
      const cur = f.attrs?.[fd.name];
      let el;
      if (fd.domain) {
        el = h('select', { class: 'inp', 'aria-label': fd.title ?? fd.name }, Object.entries(fd.domain).map(([k, l]) => h('option', { value: k }, `${k} — ${l}`)));
        el.value = cur === null || cur === undefined ? String(nullOf(cat, fd)) : String(cur);
      } else {
        el = h('input', { class: 'inp', type: fd.type === 'string' ? 'text' : 'number', spellcheck: fd.type === 'string' ? 'true' : 'false', step: 'any', value: cur === null || cur === undefined ? '' : String(cur), 'aria-label': fd.title ?? fd.name, ...(fd.range ? { min: String(fd.range[0]), max: String(fd.range[1]) } : {}), ...(fd.length ? { maxlength: String(fd.length) } : {}) });
      }
      inputs[fd.name] = el;
      const label = `${fd.title ?? fd.name}${fd.unit ? ` (${fd.unit})` : ''}${fd.required ? ' *' : ''}`;
      return field(`${fd.name} · ${label}`, el, fd.range ? `${fd.range[0]} – ${fd.range[1]}` : '');
    });
    const err = h('p', { class: 'hint err', role: 'alert' });
    const asDefault = h('input', { type: 'checkbox', 'aria-label': 'Use these values as the layer defaults' });
    const body = h('div', { class: 'attr-form' }, section(`${v.schema?.name ?? v.name} ${v.schema?.code ?? ''}`, ...rows), h('label', {}, asDefault, ' Make these the defaults for new features (persistent attribution)'), err);
    for (;;) {
      const r = await modal({ title: 'Attributes', body, buttons: ['OK', 'Cancel'], width: 560, id: 'attr-form' });
      if (r !== 'OK') return;
      const vals = {};
      const msgs = [];
      for (const fd of fs) {
        const val = coerce(fd, inputs[fd.name].value);
        const m = v.schema ? checkValue(cat, fd, val ?? nullOf(cat, fd)) : null;
        if (m) msgs.push(m);
        vals[fd.name] = val ?? (v.schema ? nullOf(cat, fd) : null);
      }
      if (msgs.length) {
        err.textContent = msgs.join(' · ');
        continue;
      }
      S.transact('Edit attributes', (tx) => tx.set(featureId, 'attrs', { ...f.attrs, ...vals }));
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
    const list = (app.prefs.get('customTools') ?? []).filter((t) => t.name !== nm);
    list.push({ name: nm, tool, mods: m, layer: activeLayerId() });
    app.prefs.set('customTools', list);
    app.emit('state');
  }
  function runCustomTool(nm) {
    const t = (app.prefs.get('customTools') ?? []).find((x) => x.name === nm);
    if (!t) throw new Error(`no custom tool ${nm}`);
    app.prefs.set('extract', { ...(app.prefs.get('extract') ?? {}), ...t.mods });
    if (t.layer && S.has(t.layer)) app.prefs.set('vlayerActive', t.layer);
    app.selectExtractTool(t.tool);
    return t;
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
    for (const t of tiles ?? [])
      await openTileSet(t, nm).then(
        () => tilesOpened++,
        (e) => app.toast(`${nm} / ${t.name}: ${e.message}`, { kind: 'error', ms: 8000 }),
      );
    for (const c of coverages ?? [])
      await openCoverage(c, nm).then(
        () => tilesOpened++,
        (e) => app.toast(`${nm} / ${c.name}: ${e.message}`, { kind: 'error', ms: 8000 }),
      );
    const hasDomains = layers.some((l) => l.fields.some((f) => f.domain || f.range));
    const cat = hasDomains ? registerCatalog(catalogFromLayers(nm.replace(/\.gpkg$/i, ''), layers)) : null;
    const ids = [];
    for (const l of layers) {
      const id = app.addVectorLayer(l, { format: 'GeoPackage', file: nm, table: l.table, report });
      if (cat) {
        const code = l.features.find((x) => x.attrs?.F_CODE)?.attrs.F_CODE ?? l.table;
        S.transact('Schema from GeoPackage', (tx) => tx.set(id, 'schema', { catalog: cat.id, code, name: l.name, geometry: [l.geometryType] }), { kind: 'load' });
      }
      ids.push({ id, report });
    }
    ids.tilesOpened = tilesOpened;
    return ids;
  }
  async function openTileSet(t, nm) {
    if (!t.data.length) throw new Error(`zoom level ${t.zoom} holds no tiles`);
    const [tw, th] = t.tile;
    // Only the occupied tile window is composited (TE-027: zoom 16 of a world matrix is 16 M px wide).
    const [c0, r0, c1, r1] = t.occupied;
    const [px, py] = t.pixel;
    const [mx0, , , my1] = t.bounds;
    // Window in matrix pixels: the occupied tiles, cut to the contents extent when it shares the
    // matrix SRS, as GDAL does (TE 2.0.4: the padding of the last tile column came in as a black strip).
    let wx0 = c0 * tw;
    let wy0 = r0 * th;
    let wx1 = (c1 + 1) * tw;
    let wy1 = (r1 + 1) * th;
    if (t.contents?.every(Number.isFinite)) {
      wx0 = Math.max(wx0, Math.round((t.contents[0] - mx0) / px));
      wx1 = Math.min(wx1, Math.round((t.contents[2] - mx0) / px));
      wy0 = Math.max(wy0, Math.round((my1 - t.contents[3]) / py));
      wy1 = Math.min(wy1, Math.round((my1 - t.contents[1]) / py));
      if (!(wx1 > wx0 && wy1 > wy0)) [wx0, wy0, wx1, wy1] = [c0 * tw, r0 * th, (c1 + 1) * tw, (r1 + 1) * th];
    }
    const W = wx1 - wx0;
    const H = wy1 - wy0;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    let drawn = 0;
    for (const d of t.data) {
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
    const stem = `${nm.replace(/\.gpkg$/i, '')}_${t.table}_z${t.zoom}`;
    const world = [px, 0, 0, -py, mx0 + (wx0 + 0.5) * px, my1 - (wy0 + 0.5) * py].join('\n');
    const files = [new File([png], `${stem}.png`, { type: 'image/png' }), new File([world], `${stem}.pgw`)];
    const prj = t.wkt ?? (t.epsg === 4326 ? 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AUTHORITY["EPSG","4326"]]' : t.epsg === 3857 ? 'PROJCS["WGS 84 / Pseudo-Mercator",AUTHORITY["EPSG","3857"]]' : null);
    if (prj) files.push(new File([prj], `${stem}.prj`));
    await app.openFiles(files);
    app.importLog.push({ file: nm, errors: [], warnings: [`${t.name}: tile pyramid zoom ${t.zoom} (${t.matrix[0]}×${t.matrix[1]} matrix, tiles of ${tw}×${th}, ${drawn} decoded) opened as ${stem}.png`] });
  }

  /**
   * IMP-11: a gridded coverage level as a float GeoTIFF (heights, NaN no-data), opened as a DEM-
   * ready image. value = (raw · tile scale + tile offset) · scale + offset; raw = data_null is
   * no-data. Clipped to gpkg_contents when it shares the matrix set's SRS, as GDAL does.
   */
  async function openCoverage(c, nm) {
    if (!c.data.length) throw new Error(`zoom level ${c.zoom} holds no tiles`);
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
          const r = await app.pool.run('tiffBand', { bytes: d.bytes.slice() }, { kind: 'decode', label: 'coverage tile' });
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
    app.importLog.push({ file: nm, errors: [], warnings: [`${c.name}: gridded coverage zoom ${c.zoom} (${c.datatype}, ${decoded} tile(s)) opened as ${stem}.tif, ${W}×${H}`] });
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

  app.attribution = { newSchemaLayer, initialAttrs, setDefaults, setAttr, checkEdit, saveSet, applySet, ruleStyle, attributeIssues, openForm, saveCustomTool, runCustomTool, openGpkgBytes, gpkgBytes, readCsv, writeCsv, catalogs: listCatalogs, catalog: getCatalog, fieldsFor, crosswalkMGCP };
  app.vectorReaders = { ...(app.vectorReaders ?? {}), gpkg: openGpkgBytes, csv: async (b, nm) => [{ id: app.addVectorLayer(readCsv(new TextDecoder().decode(b), { name: nm.replace(/\.\w+$/, '') }).layer, { format: 'CSV', file: nm }) }] };

  // ---- commands ----
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  C.implement('ext.newschema', {
    run: run(async () => {
      const cat = getCatalog();
      const sel = h('select', { class: 'inp', 'aria-label': 'Feature class' }, cat.types.map((t) => h('option', { value: t.code }, `${t.code} ${t.name} (${t.geometry.join('/')})`)));
      if ((await modal({ title: 'New Layer from Schema', body: field(`Feature class (${cat.name})`, sel), id: 'ext-newschema' })) !== 'OK') return;
      newSchemaLayer(sel.value);
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
      const sel = h('select', { class: 'inp', 'aria-label': 'Attribute set' }, sets.map((s) => h('option', { value: s }, s)));
      const chosen = [...app.selection].filter((x) => S.get(x)?.vlayer === v.id);
      const r = await modal({ title: 'Attribute Sets', body: h('div', {}, field('Set', sel, sets.length ? '' : 'No sets yet: "Save Defaults as Set" stores the layer defaults under a name.'), h('p', { class: 'hint' }, `${chosen.length} selected feature(s) in ${v.name}`)), buttons: ['Apply', 'Save Defaults as Set…', 'Close'], id: 'ext-attrsets' });
      if (r === 'Apply' && sel.value) applySet(v.id, sel.value, chosen);
      if (r === 'Save Defaults as Set…') {
        const nm = await promptBox('Save Attribute Set', 'Name', 'Set 1');
        if (nm) saveSet(v.id, nm, v.defaults ?? {});
      }
    }),
  });
  C.implement('ext.custom', {
    run: run(async () => {
      const list = app.prefs.get('customTools') ?? [];
      const sel = h('select', { class: 'inp', 'aria-label': 'Custom tool' }, list.map((t) => h('option', { value: t.name }, `${t.name} — ${t.tool.replace('ext.', '')}`)));
      const tool = h('select', { class: 'inp', 'aria-label': 'Base tool' }, ['ext.point', 'ext.polyline', 'ext.polygon', 'ext.rect3', 'ext.ngon'].map((t) => h('option', { value: t }, t.replace('ext.', ''))));
      const r = await modal({ title: 'Custom Tools', body: h('div', {}, field('Run a saved tool', sel), section('Save the current modifiers as a tool', field('Base tool', tool))), buttons: ['Run', 'Save Current…', 'Close'], id: 'ext-custom' });
      if (r === 'Run' && sel.value) runCustomTool(sel.value);
      if (r === 'Save Current…') {
        const nm = await promptBox('Save Custom Tool', 'Name', 'Squared building');
        if (nm) saveCustomTool(nm, tool.value);
      }
    }),
  });
  C.implement('ext.styles', {
    enabled: () => !!activeLayerId(),
    run: run(async () => {
      const id = activeLayerId();
      const v = S.get(id);
      const ta = h('textarea', { class: 'inp mono', rows: '14', 'aria-label': 'Style sheet (JSON rules)' }, JSON.stringify(v.styleRules ?? TDS_STYLES, null, 1));
      if ((await modal({ title: `Style Sheet — ${v.name}`, body: h('div', {}, ta, h('p', { class: 'hint' }, 'Rules: {class, filter: {field, op, value}, style: {stroke, fill, outline, width}}; the first match wins. KML export writes them as shared styles.')), width: 620, id: 'ext-styles' })) !== 'OK') return;
      const rules = JSON.parse(ta.value);
      if (!Array.isArray(rules)) throw new Error('the style sheet must be a JSON array of rules');
      S.transact('Style sheet', (tx) => tx.set(id, 'styleRules', rules));
    }),
  });
  C.implement('ext.arcgis', {
    enabled: () => vlayers().length > 0,
    run: run(async () => {
      const ids = vlayers().map((v) => v.id);
      const { bytes, report } = await gpkgBytes(ids, { title: 'GIS Workbench hand-off to ArcGIS Pro' });
      await saveBlob(app, new Blob([bytes], { type: 'application/geopackage+sqlite3' }), { name: `${(app.project()?.name || 'handoff').replace(/[^\w.-]+/g, '_')}_arcgis.gpkg`, types: ['.gpkg'], description: 'GeoPackage' });
      app.toast(`ArcGIS Pro hand-off: ${report.tables.length} table(s), ${report.features_out} feature(s); coded domains in gpkg_data_column_constraints`);
    }),
  });
  C.implement('file.opengpkg', { run: run(async () => app.openVectorFiles(await pickFiles(app, { accept: ['.gpkg', '.csv'], description: 'GeoPackage or CSV' }))) });
}
