// Editing online feature layers (REQ-EXT-26): an ArcGIS REST feature service layer or a WFS-T 2.0
// feature type from an origin in this file's network allow-list opens as a vector layer; edits
// made with the usual tools are diffed against what was loaded and sent back as applyEdits
// (adds/updates/deletes) or a WFS Transaction (Insert/Update/Delete). Tokens are typed by the
// user, kept in memory only (REQ-SEC-10), and sent as the service expects (ArcGIS `token`;
// WFS as a query parameter or a Bearer header). Every request goes through the network log.
// 2.4: reads are paged (ArcGIS resultOffset or object-id batches, WFS STARTINDEX or next links;
// REQ-GAP-04); ArcGIS fields keep their types, coded-value and range domains and subtypes, and
// edits are checked against them before anything is sent (REQ-GAP-63); multi-part geometry
// round-trips (Esri rings → MultiPolygon with holes); WFS takes its geometry property and field
// types from DescribeFeatureType.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { fromGeoJSON, toGeoJSON } from '../vector/geom.js';

import { t, tc, msgOf, gwError } from '../i18n/index.js';
import { esriToGeoJSON, esriFields, esriSubtypes, checkEsriAttrs, readEsriAttrs, writeEsriAttrs, queryAll, esriError } from '../connectors/arcgis.js';
import { collectPages, withParams, nextLink } from '../connectors/ogc.js';
import { parseXml, all as xmlAll, attr as xmlAttr } from '../connectors/xml.js';

export const name = 'remoteEdit';

// ---- geometry conversions (EPSG:4326, x = lon) ----
// Every GeoJSON type the vector model holds, multi-part ones included (G0-2); a
// GeometryCollection or an unknown type is skipped by the loader.
export function geojsonToGeom(g) {
  if (!g) return null;
  try {
    const geom = fromGeoJSON(g);
    return Array.isArray(geom) ? null : geom;
  } catch {
    return null;
  }
}

const xy = (c) => [c[0], c[1]];
const flat2d = (g) => {
  const c = g.coordinates;
  switch (g.type) {
    case 'Point':
      return xy(c);
    case 'MultiPoint':
    case 'LineString':
      return c.map(xy);
    case 'MultiLineString':
    case 'Polygon':
      return c.map((l) => l.map(xy));
    default:
      return c.map((p) => p.map((r) => r.map(xy)));
  }
};

/** Geometry → 2-D GeoJSON with closed rings, outer counter-clockwise and holes clockwise. */
export function geomToGeojson(geom) {
  const g = toGeoJSON(geom);
  return { type: g.type, coordinates: flat2d(g) };
}

/** Geometry → ArcGIS JSON. Esri rings run clockwise for outers and counter-clockwise for holes. */
export function geomToEsri(geom) {
  const g = geomToGeojson(geom);
  const sr = { wkid: 4326 };
  const esriRings = (polys) => polys.flatMap((rs) => rs.map((r) => [...r].reverse()));
  switch (g.type) {
    case 'Point':
      return { x: g.coordinates[0], y: g.coordinates[1], spatialReference: sr };
    case 'MultiPoint':
      return { points: g.coordinates, spatialReference: sr };
    case 'LineString':
      return { paths: [g.coordinates], spatialReference: sr };
    case 'MultiLineString':
      return { paths: g.coordinates, spatialReference: sr };
    case 'Polygon':
      return { rings: esriRings([g.coordinates]), spatialReference: sr };
    default:
      return { rings: esriRings(g.coordinates), spatialReference: sr };
  }
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** GML 3.2 for a geometry (EPSG:4326 urn: lat lon axis order). */
export function geomToGml(geom) {
  const srs = 'urn:ogc:def:crs:EPSG::4326';
  const pos = (ps) => ps.map(([lo, la]) => `${la} ${lo}`).join(' ');
  const g = geomToGeojson(geom);
  const point = (c, s = ` srsName="${srs}"`) => `<gml:Point${s}><gml:pos>${pos([c])}</gml:pos></gml:Point>`;
  const line = (l, s = ` srsName="${srs}"`) => `<gml:LineString${s}><gml:posList>${pos(l)}</gml:posList></gml:LineString>`;
  const polygon = ([outer, ...inner], s = ` srsName="${srs}"`) =>
    `<gml:Polygon${s}><gml:exterior><gml:LinearRing><gml:posList>${pos(outer)}</gml:posList></gml:LinearRing></gml:exterior>${inner.map((q) => `<gml:interior><gml:LinearRing><gml:posList>${pos(q)}</gml:posList></gml:LinearRing></gml:interior>`).join('')}</gml:Polygon>`;
  switch (g.type) {
    case 'Point':
      return point(g.coordinates);
    case 'LineString':
      return line(g.coordinates);
    case 'Polygon':
      return polygon(g.coordinates);
    case 'MultiPoint':
      return `<gml:MultiPoint srsName="${srs}">${g.coordinates.map((c) => `<gml:pointMember>${point(c, '')}</gml:pointMember>`).join('')}</gml:MultiPoint>`;
    case 'MultiLineString':
      return `<gml:MultiCurve srsName="${srs}">${g.coordinates.map((l) => `<gml:curveMember>${line(l, '')}</gml:curveMember>`).join('')}</gml:MultiCurve>`;
    default:
      return `<gml:MultiSurface srsName="${srs}">${g.coordinates.map((p) => `<gml:surfaceMember>${polygon(p, '')}</gml:surfaceMember>`).join('')}</gml:MultiSurface>`;
  }
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const tokens = new Map(); // vlayer id → token (memory only)
  const snapshots = new Map(); // vlayer id → Map(remote id → JSON of {attrs, geom})
  const openInfo = new Map(); // vlayer id → {pages, truncated, skipped, count} of the last read
  const sessions = new Map(); // vlayer id → branch-version edit session ID (REQ-GAP-64; memory only)
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 9000 });
    }
  };
  const fetcher = (label) => app.netlog.fetchFor(label);
  const sig = (f) => JSON.stringify({ a: f.attrs ?? {}, g: f.geom ? geomToGeojson(f.geom) : null });

  function withToken(url, token, param = 'token') {
    if (!token) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${param}=${encodeURIComponent(token)}`;
  }

  async function getJson(src, url, token) {
    const f = fetcher(`${src.kind === 'arcgis' ? 'ArcGIS' : 'WFS'}: ${src.name}`);
    const headers = src.kind === 'wfs' && token && src.tokenMode === 'bearer' ? { Authorization: `Bearer ${token}` } : {};
    const u = src.kind === 'arcgis' ? withToken(url, token) : src.tokenMode === 'query' ? withToken(url, token, src.tokenParam ?? 'authkey') : url;
    const r = await f(u, { credentials: 'omit', headers });
    if (!r.ok) throw gwError('{name}: HTTP {status}', { name: src.name, status: r.status }, 'E_HTTP');
    return r.json();
  }

  /** WFS DescribeFeatureType (XSD) → {geomName, fields [{name, type}]}; null when the service gives none. */
  async function describeWfs(src, token) {
    try {
      const f = fetcher(`WFS: ${src.name}`);
      const headers = token && src.tokenMode === 'bearer' ? { Authorization: `Bearer ${token}` } : {};
      const u0 = withParams(src.url, { SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'DescribeFeatureType', TYPENAMES: src.typeName });
      const r = await f(token && src.tokenMode === 'query' ? withToken(u0, token, src.tokenParam ?? 'authkey') : u0, { credentials: 'omit', headers });
      if (!r.ok) return null;
      const doc = parseXml(await r.text());
      const local = String(src.typeName).split(':').pop();
      const types = xmlAll(doc, 'complexType');
      const ct = types.find((c) => (xmlAttr(c, 'name') ?? '').replace(/Type$/, '') === local) ?? types[0];
      if (!ct) return null;
      const XS = { string: 'string', int: 'integer', integer: 'integer', long: 'integer', short: 'integer', decimal: 'number', double: 'number', float: 'number', boolean: 'boolean', date: 'date', dateTime: 'date' };
      let geomName = null;
      const fields = [];
      for (const el of xmlAll(ct, 'element')) {
        const nm = xmlAttr(el, 'name');
        const full = xmlAttr(el, 'type') ?? '';
        const ty = full.split(':').pop();
        if (!nm) continue;
        if (/PropertyType$/.test(ty) && /^gml:/.test(full)) geomName ??= nm;
        else fields.push({ name: nm, type: XS[ty] ?? 'string' });
      }
      return { geomName, fields };
    } catch {
      return null;
    }
  }

  /** ArcGIS features (Esri JSON from f=json, or GeoJSON from f=geojson) → [{rid, geometry (GeoJSON), props}]. */
  const arcFeatures = (items, idField, fields) =>
    items.map((f) => (f.type === 'Feature' ? { rid: f.properties?.[idField] ?? f.id, geometry: f.geometry, props: readEsriAttrs(fields, f.properties ?? {}) } : { rid: f.attributes?.[idField], geometry: esriToGeoJSON(f.geometry), props: readEsriAttrs(fields, f.attributes ?? {}) }));

  /**
   * Open a remote layer. src: {kind: 'arcgis'|'wfs', url, name, typeName (WFS), tokenMode,
   * tokenParam}. opts: where (ArcGIS), bbox (lon/lat), pageSize, max, signal, onPage.
   */
  async function open(src, { token = null, where = '1=1', bbox = null, pageSize = null, max = 50000, signal = null, onPage = null, gdbVersion = null } = {}) {
    if (!/^https?:\/\//.test(src.url)) throw new Error('enter a service URL that starts with http:// or https:// first');
    let feats;
    let idField;
    let info = {};
    let fields = null;
    let subtypes = null;
    let geomName = null;
    let pages = 1;
    let truncated = false;
    if (src.kind === 'arcgis') {
      info = await getJson(src, withParams(src.url, { f: 'json' }), token);
      if (info.error) throw esriError(info, src.name);
      idField = info.objectIdField ?? (info.fields ?? []).find((x) => x.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
      fields = info.fields?.length ? esriFields(info) : null;
      subtypes = esriSubtypes(info);
      const extra = { ...(bbox ? { geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: 4326, spatialRel: 'esriSpatialRelIntersects' } : {}), ...(gdbVersion ? { gdbVersion } : {}) };
      // Offset paging unless the service says it cannot page (then object-id batches).
      const pagingInfo = info.advancedQueryCapabilities?.supportsPagination === false ? info : { ...info, advancedQueryCapabilities: { ...(info.advancedQueryCapabilities ?? {}), supportsPagination: true } };
      const got = await queryAll((u) => getJson(src, u, token), src.url, pagingInfo, { where, pageSize, max, signal, onPage, extra });
      pages = got.pages;
      truncated = got.truncated;
      feats = arcFeatures(got.items, idField, fields ?? []);
    } else {
      const d = await describeWfs(src, token);
      geomName = d?.geomName ?? null;
      fields = d?.fields?.length ? d.fields : null;
      const size = Math.max(1, Math.min(pageSize ?? 1000, 10000));
      const first = withParams(src.url, { SERVICE: 'WFS', VERSION: '2.0.0', REQUEST: 'GetFeature', TYPENAMES: src.typeName, OUTPUTFORMAT: 'application/json', SRSNAME: 'EPSG:4326', COUNT: size, STARTINDEX: 0, BBOX: bbox ? `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]},urn:ogc:def:crs:EPSG::4326` : null });
      const got = await collectPages(
        async (u) => {
          const fc = await getJson(src, u, token);
          const items = fc.features ?? [];
          const nl = nextLink(fc, u)?.href ?? null;
          const start = Number(/[?&]STARTINDEX=(\d+)/i.exec(u)?.[1] ?? 0);
          const more = Number.isFinite(fc.numberMatched) ? start + items.length < fc.numberMatched : items.length >= size;
          return { items, next: nl ?? (more && items.length ? withParams(u, { STARTINDEX: start + items.length }) : null) };
        },
        { first, max, signal, onPage },
      );
      pages = got.pages;
      truncated = got.truncated;
      feats = got.items.map((f) => ({ rid: f.id, geometry: f.geometry, props: f.properties ?? {} }));
      idField = '__fid';
    }
    let vl;
    const snap = new Map();
    let skipped = 0;
    const layerFields = fields ?? Object.keys(feats[0]?.props ?? {}).map((n) => ({ name: n, type: 'string' }));
    S.transact(t('Open {name}', { name: src.name }), (tx) => {
      vl = tx.create('vlayer', { name: src.name, visible: true, style: { stroke: '#ff9900', width: 2, fill: '#ff990033' }, fields: layerFields, source: { format: src.kind === 'arcgis' ? 'arcgis-fs' : 'wfs-t', url: src.url, typeName: src.typeName ?? null, idField, tokenMode: src.tokenMode ?? null, tokenParam: src.tokenParam ?? null, remote: true, geomName, subtypes, geometryType: info.geometryType ?? null, typed: !!fields && src.kind === 'arcgis', capabilities: info.capabilities ?? null, gdbVersion: gdbVersion ?? null, hasAttachments: !!info.hasAttachments, relationships: info.relationships?.length ? info.relationships : null }, created: new Date().toISOString() });
      for (const f of feats) {
        const geom = geojsonToGeom(f.geometry);
        if (!geom) {
          skipped++;
          continue;
        }
        const id = tx.create('feature', { vlayer: vl, geom, attrs: { ...f.props }, name: null, remoteId: f.rid, prov: { kind: 'remote', source: src.url } });
        snap.set(String(f.rid), { id, sig: null });
      }
    }, { kind: 'load' });
    for (const f of S.all('feature').filter((x) => x.vlayer === vl)) snap.get(String(f.remoteId)).sig = sig(f);
    snapshots.set(vl, snap);
    if (token) tokens.set(vl, token);
    const n = feats.length - skipped;
    app.toast(src.kind === 'arcgis' ? t('{name}: {n, plural, one {# feature} other {# features}} from the feature service', { name: src.name, n }) : t('{name}: {n, plural, one {# feature} other {# features}} from WFS', { name: src.name, n }), { kind: 'info' });
    if (truncated) app.toast(t('{name}: stopped at {n, plural, one {# feature} other {# features}}; the service has more. Narrow the query (area or filter) to read the rest.', { name: src.name, n }), { kind: 'warn', ms: 9000 });
    if (skipped) app.toast(t('{name}: {n, plural, one {# feature has} other {# features have}} no geometry the vector layer can hold; skipped.', { name: src.name, n: skipped }), { kind: 'warn', ms: 8000 });
    openInfo.set(vl, { pages, truncated, skipped, count: n });
    app.emit('state');
    return vl;
  }

  /** The edits since loading (or the last save): {adds, updates, deletes} of feature records / ids. */
  function pending(vl) {
    const snap = snapshots.get(vl) ?? new Map();
    const feats = S.all('feature').filter((f) => f.vlayer === vl);
    const adds = feats.filter((f) => f.remoteId === undefined || f.remoteId === null);
    const updates = feats.filter((f) => f.remoteId !== undefined && f.remoteId !== null && snap.has(String(f.remoteId)) && snap.get(String(f.remoteId)).sig !== sig(f));
    const present = new Set(feats.map((f) => String(f.remoteId)));
    const deletes = [...snap.keys()].filter((k) => !present.has(k));
    return { adds, updates, deletes };
  }

  async function save(vl) {
    const v = S.get(vl);
    if (!v?.source?.remote) throw new Error('not a remote layer');
    const src = { kind: v.source.format === 'arcgis-fs' ? 'arcgis' : 'wfs', url: v.source.url, name: v.name, typeName: v.source.typeName, tokenMode: v.source.tokenMode, tokenParam: v.source.tokenParam };
    const token = tokens.get(vl) ?? null;
    const { adds, updates, deletes } = pending(vl);
    if (!adds.length && !updates.length && !deletes.length) return { adds: 0, updates: 0, deletes: 0 };
    const f = fetcher(`${src.kind === 'arcgis' ? 'ArcGIS' : 'WFS-T'}: ${src.name}`);
    const idField = v.source.idField;
    let result;
    if (src.kind === 'arcgis') {
      // Typed layers (REQ-GAP-63): every add and update is checked against the field types, coded
      // and range domains and subtypes first, and nothing is sent while any value is refused.
      const fields = v.source.typed ? v.fields ?? [] : null;
      if (fields) {
        const problems = [];
        for (const x of [...adds, ...updates]) for (const e of checkEsriAttrs(fields, v.source.subtypes ?? null, x.attrs, { isNew: adds.includes(x) })) problems.push(e);
        if (problems.length) throw Object.assign(gwError('{name}: {n, plural, one {# value is} other {# values are}} not allowed by the layer, so nothing was sent: {msg}', { name: src.name, n: problems.length, msg: problems.slice(0, 4).map((e) => msgOf(e)).join('; ') }, 'E_ATTRS_INVALID'), { issues: problems });
      }
      const noId = (a) => Object.fromEntries(Object.entries(a ?? {}).filter(([k]) => k !== idField));
      const strip = (a) => (fields ? writeEsriAttrs(fields, noId(a)) : noId(a));
      const body = new URLSearchParams({ f: 'json', adds: JSON.stringify(adds.map((x) => ({ geometry: geomToEsri(x.geom), attributes: strip(x.attrs) }))), updates: JSON.stringify(updates.map((x) => ({ geometry: geomToEsri(x.geom), attributes: { ...strip(x.attrs), [idField]: x.remoteId } }))), deletes: deletes.join(','), rollbackOnFailure: 'true' });
      if (token) body.set('token', token);
      // A branch version (REQ-GAP-64): the edits go to that version, inside its edit session.
      if (v.source.gdbVersion) body.set('gdbVersion', v.source.gdbVersion);
      if (sessions.get(vl)) body.set('sessionID', sessions.get(vl));
      const r = await f(`${src.url}/applyEdits`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j = await r.json();
      if (!r.ok || j.error) throw gwError('{name}: applyEdits failed ({msg})', { name: src.name, msg: j.error?.message ?? `HTTP ${r.status}` }, 'E_APPLY_EDITS');
      const bad = [...(j.addResults ?? []), ...(j.updateResults ?? []), ...(j.deleteResults ?? [])].filter((x) => !x.success);
      if (bad.length) throw gwError('{name}: {n, plural, one {# edit} other {# edits}} refused: {msg}', { name: src.name, n: bad.length, msg: bad.map((x) => x.error?.description ?? 'error').join('; ') }, 'E_EDITS_REFUSED');
      result = { newIds: (j.addResults ?? []).map((x) => x.objectId) };
    } else {
      const [ns, local] = src.typeName.includes(':') ? src.typeName.split(':') : ['feature', src.typeName];
      const geomName = v.source.geomName ?? 'geometry';
      const props = (a) => Object.entries(a ?? {}).filter(([k]) => !k.startsWith('__'));
      const insert = adds.length ? `<wfs:Insert>${adds.map((x) => `<${ns}:${local}>${props(x.attrs).map(([k, val]) => `<${ns}:${k}>${xmlEsc(val)}</${ns}:${k}>`).join('')}<${ns}:${geomName}>${geomToGml(x.geom)}</${ns}:${geomName}></${ns}:${local}>`).join('')}</wfs:Insert>` : '';
      const upd = updates.map((x) => `<wfs:Update typeName="${src.typeName}">${props(x.attrs).map(([k, val]) => `<wfs:Property><wfs:ValueReference>${k}</wfs:ValueReference><wfs:Value>${xmlEsc(val)}</wfs:Value></wfs:Property>`).join('')}<wfs:Property><wfs:ValueReference>${geomName}</wfs:ValueReference><wfs:Value>${geomToGml(x.geom)}</wfs:Value></wfs:Property><fes:Filter><fes:ResourceId rid="${xmlEsc(x.remoteId)}"/></fes:Filter></wfs:Update>`).join('');
      const del = deletes.map((rid) => `<wfs:Delete typeName="${src.typeName}"><fes:Filter><fes:ResourceId rid="${xmlEsc(rid)}"/></fes:Filter></wfs:Delete>`).join('');
      const xml = `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:${ns}="urn:gis-workbench:${ns}">${insert}${upd}${del}</wfs:Transaction>`;
      const headers = { 'content-type': 'application/xml' };
      if (token && src.tokenMode === 'bearer') headers.Authorization = `Bearer ${token}`;
      const url = token && src.tokenMode === 'query' ? withToken(src.url, token, src.tokenParam ?? 'authkey') : src.url;
      const r = await f(url, { method: 'POST', credentials: 'omit', headers, body: xml });
      const text = await r.text();
      if (!r.ok || /ExceptionReport/.test(text)) throw gwError('{name}: WFS Transaction failed ({msg})', { name: src.name, msg: /ExceptionText>([^<]*)/.exec(text)?.[1] ?? `HTTP ${r.status}` }, 'E_WFS_TRANSACTION');
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      result = { newIds: [...doc.getElementsByTagNameNS('*', 'InsertResults')].flatMap((n) => [...n.getElementsByTagNameNS('*', 'ResourceId')].map((x) => x.getAttribute('rid'))) };
    }
    // New features get their server ids; the snapshot becomes the saved state.
    S.transact(t('Saved remote edits'), (tx) => adds.forEach((x, i) => result.newIds[i] !== undefined && tx.set(x.id, 'remoteId', result.newIds[i])), { kind: 'load' });
    const snap = new Map();
    for (const x of S.all('feature').filter((q) => q.vlayer === vl)) snap.set(String(x.remoteId), { id: x.id, sig: sig(x) });
    snapshots.set(vl, snap);
    app.toast(t('{name}: saved {adds, plural, one {# add} other {# adds}}, {updates, plural, one {# update} other {# updates}}, {deletes, plural, one {# delete} other {# deletes}}', { name: src.name, adds: adds.length, updates: updates.length, deletes: deletes.length }), { kind: 'info' });
    return { adds: adds.length, updates: updates.length, deletes: deletes.length, newIds: result.newIds };
  }

  async function dialog() {
    const kind = h('select', { 'data-id': 're-kind' }, h('option', { value: 'arcgis' }, t('ArcGIS REST feature service layer')), h('option', { value: 'wfs' }, t('WFS-T 2.0 feature type')));
    const url = h('input', { type: 'url', placeholder: t('https://…/FeatureServer/0  or  https://…/wfs'), 'data-id': 're-url' });
    const typeName = h('input', { type: 'text', placeholder: t('ns:layer (WFS only)'), 'data-id': 're-type' });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: t('Typed here; kept in memory only'), 'data-id': 're-token' });
    const mode = h('select', { 'data-id': 're-mode' }, h('option', { value: 'query' }, t('WFS token as authkey parameter')), h('option', { value: 'bearer' }, t('WFS token as Bearer header')));
    if ((await modal({ title: t('Edit Online Layer'), body: h('div', {}, field(t('Service'), kind), field(t('URL'), url), field(t('Feature type'), typeName), field(t('Token'), token), field(t('WFS token mode'), mode), h('p', { class: 'hint' }, t('The origin must be in this file’s network allow-list (Add-Ins ▸ Network Allow-List). Edits are sent only when you choose Save Online Edits.'))), buttons: [{ label: tc('verb', 'Open'), value: 'open', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'remote-edit' })) !== 'open') return;
    const u = url.value.trim();
    await open({ kind: kind.value, url: u.replace(/\/$/, ''), name: kind.value === 'arcgis' ? u.split('/').slice(-3).join('/') : typeName.value, typeName: typeName.value.trim(), tokenMode: mode.value }, { token: token.value || null });
  }

  const remoteLayers = () => S.all('vlayer').filter((v) => v.source?.remote);
  C.implement('vec.remoteopen', { run: run(() => dialog()) });
  C.implement('vec.remotesave', { enabled: () => remoteLayers().length > 0, run: run(async () => { for (const v of remoteLayers()) await save(v.id); }) });
  app.remoteEdit = { open, save, pending, setSession: (vl, id) => (id ? sessions.set(vl, id) : sessions.delete(vl)), session: (vl) => sessions.get(vl) ?? null, geomToEsri, geomToGml, geomToGeojson, geojsonToGeom, setToken: (vl, t) => tokens.set(vl, t), layers: remoteLayers, info: (vl) => openInfo.get(vl) ?? null, describeWfs };
}
