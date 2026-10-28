// Editing online feature layers (REQ-EXT-26): an ArcGIS REST feature service layer or a WFS-T 2.0
// feature type from an origin in this file's network allow-list opens as a vector layer; edits
// made with the usual tools are diffed against what was loaded and sent back as applyEdits
// (adds/updates/deletes) or a WFS Transaction (Insert/Update/Delete). Tokens are typed by the
// user, kept in memory only (REQ-SEC-10), and sent as the service expects (ArcGIS `token`;
// WFS as a query parameter or a Bearer header). Every request goes through the network log.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { fromParts, parts } from '../vector/geom.js';

export const name = 'remoteEdit';

// ---- geometry conversions (EPSG:4326, x = lon) ----
export function geojsonToGeom(g) {
  if (!g) return null;
  const c = g.coordinates;
  switch (g.type) {
    case 'Point':
      return fromParts('Point', [[c]]);
    case 'LineString':
      return fromParts('LineString', [c]);
    case 'Polygon':
      return fromParts('Polygon', c);
    case 'MultiPolygon': {
      const rings = c.flat();
      let k = 0;
      const polys = c.map((p) => {
        const s = k;
        k += p.length;
        return s;
      });
      return fromParts('MultiPolygon', rings, polys);
    }
    default:
      return null;
  }
}

function ringsOf(geom) {
  return parts(geom).map((p) => p.map((v) => [v[0], v[1]]));
}

export function geomToGeojson(geom) {
  const r = ringsOf(geom);
  if (geom.type === 'Point') return { type: 'Point', coordinates: r[0][0] };
  if (geom.type === 'LineString') return { type: 'LineString', coordinates: r[0] };
  if (geom.type === 'Polygon') return { type: 'Polygon', coordinates: r };
  return { type: geom.type, coordinates: r };
}

export function geomToEsri(geom) {
  const r = ringsOf(geom);
  const sr = { wkid: 4326 };
  if (geom.type === 'Point') return { x: r[0][0][0], y: r[0][0][1], spatialReference: sr };
  if (geom.type === 'LineString' || geom.type === 'MultiLineString') return { paths: r, spatialReference: sr };
  return { rings: r, spatialReference: sr };
}

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** GML 3.2 for a geometry (EPSG:4326 urn: lat lon axis order). */
export function geomToGml(geom) {
  const srs = 'urn:ogc:def:crs:EPSG::4326';
  const pos = (ps) => ps.map(([lo, la]) => `${la} ${lo}`).join(' ');
  const r = ringsOf(geom);
  if (geom.type === 'Point') return `<gml:Point srsName="${srs}"><gml:pos>${pos(r[0])}</gml:pos></gml:Point>`;
  if (geom.type === 'LineString') return `<gml:LineString srsName="${srs}"><gml:posList>${pos(r[0])}</gml:posList></gml:LineString>`;
  const [outer, ...inner] = r;
  return `<gml:Polygon srsName="${srs}"><gml:exterior><gml:LinearRing><gml:posList>${pos(outer)}</gml:posList></gml:LinearRing></gml:exterior>${inner.map((q) => `<gml:interior><gml:LinearRing><gml:posList>${pos(q)}</gml:posList></gml:LinearRing></gml:interior>`).join('')}</gml:Polygon>`;
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const tokens = new Map(); // vlayer id → token (memory only)
  const snapshots = new Map(); // vlayer id → Map(remote id → JSON of {attrs, geom})
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 9000 });
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
    if (!r.ok) throw new Error(`${src.name}: HTTP ${r.status}`);
    return r.json();
  }

  /** Open a remote layer. src: {kind: 'arcgis'|'wfs', url, name, typeName (WFS), tokenMode, tokenParam}. */
  async function open(src, { token = null } = {}) {
    if (!/^https?:\/\//.test(src.url)) throw new Error('enter a service URL that starts with http:// or https:// first');
    let fc;
    let idField;
    let info = {};
    if (src.kind === 'arcgis') {
      info = await getJson(src, `${src.url}?f=json`, token);
      if (info.error) throw new Error(`${src.name}: ${info.error.message ?? 'service error'}`);
      idField = info.objectIdField ?? (info.fields ?? []).find((x) => x.type === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
      fc = await getJson(src, `${src.url}/query?where=1%3D1&outFields=*&outSR=4326&f=geojson`, token);
    } else {
      const sep = src.url.includes('?') ? '&' : '?';
      fc = await getJson(src, `${src.url}${sep}SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=${encodeURIComponent(src.typeName)}&OUTPUTFORMAT=${encodeURIComponent('application/json')}&SRSNAME=EPSG:4326`, token);
      idField = '__fid';
    }
    const feats = fc.features ?? [];
    let vl;
    const snap = new Map();
    S.transact(`Open ${src.name}`, (tx) => {
      vl = tx.create('vlayer', { name: src.name, visible: true, style: { stroke: '#ff9900', width: 2, fill: '#ff990033' }, fields: Object.keys(feats[0]?.properties ?? {}).map((n) => ({ name: n, type: 'string' })), source: { format: src.kind === 'arcgis' ? 'arcgis-fs' : 'wfs-t', url: src.url, typeName: src.typeName ?? null, idField, tokenMode: src.tokenMode ?? null, tokenParam: src.tokenParam ?? null, remote: true }, created: new Date().toISOString() });
      for (const f of feats) {
        const rid = src.kind === 'arcgis' ? f.properties?.[idField] ?? f.id : f.id;
        const geom = geojsonToGeom(f.geometry);
        if (!geom) continue;
        const id = tx.create('feature', { vlayer: vl, geom, attrs: { ...(f.properties ?? {}) }, name: null, remoteId: rid, prov: { kind: 'remote', source: src.url } });
        snap.set(String(rid), { id, sig: null });
      }
    }, { kind: 'load' });
    for (const f of S.all('feature').filter((x) => x.vlayer === vl)) snap.get(String(f.remoteId)).sig = sig(f);
    snapshots.set(vl, snap);
    if (token) tokens.set(vl, token);
    app.toast(`${src.name}: ${feats.length} feature(s) from ${src.kind === 'arcgis' ? 'the feature service' : 'WFS'}`);
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
      const strip = (a) => Object.fromEntries(Object.entries(a ?? {}).filter(([k]) => k !== idField));
      const body = new URLSearchParams({ f: 'json', adds: JSON.stringify(adds.map((x) => ({ geometry: geomToEsri(x.geom), attributes: strip(x.attrs) }))), updates: JSON.stringify(updates.map((x) => ({ geometry: geomToEsri(x.geom), attributes: { ...strip(x.attrs), [idField]: x.remoteId } }))), deletes: deletes.join(','), rollbackOnFailure: 'true' });
      if (token) body.set('token', token);
      const r = await f(`${src.url}/applyEdits`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(`${src.name}: applyEdits failed (${j.error?.message ?? `HTTP ${r.status}`})`);
      const bad = [...(j.addResults ?? []), ...(j.updateResults ?? []), ...(j.deleteResults ?? [])].filter((x) => !x.success);
      if (bad.length) throw new Error(`${src.name}: ${bad.length} edit(s) refused: ${bad.map((x) => x.error?.description ?? 'error').join('; ')}`);
      result = { newIds: (j.addResults ?? []).map((x) => x.objectId) };
    } else {
      const [ns, local] = src.typeName.includes(':') ? src.typeName.split(':') : ['feature', src.typeName];
      const geomName = 'geometry';
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
      if (!r.ok || /ExceptionReport/.test(text)) throw new Error(`${src.name}: WFS Transaction failed (${/ExceptionText>([^<]*)/.exec(text)?.[1] ?? `HTTP ${r.status}`})`);
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      result = { newIds: [...doc.getElementsByTagNameNS('*', 'InsertResults')].flatMap((n) => [...n.getElementsByTagNameNS('*', 'ResourceId')].map((x) => x.getAttribute('rid'))) };
    }
    // New features get their server ids; the snapshot becomes the saved state.
    S.transact('Saved remote edits', (tx) => adds.forEach((x, i) => result.newIds[i] !== undefined && tx.set(x.id, 'remoteId', result.newIds[i])), { kind: 'load' });
    const snap = new Map();
    for (const x of S.all('feature').filter((q) => q.vlayer === vl)) snap.set(String(x.remoteId), { id: x.id, sig: sig(x) });
    snapshots.set(vl, snap);
    app.toast(`${src.name}: saved ${adds.length} add(s), ${updates.length} update(s), ${deletes.length} delete(s)`);
    return { adds: adds.length, updates: updates.length, deletes: deletes.length, newIds: result.newIds };
  }

  async function dialog() {
    const kind = h('select', { 'data-id': 're-kind' }, h('option', { value: 'arcgis' }, 'ArcGIS REST feature service layer'), h('option', { value: 'wfs' }, 'WFS-T 2.0 feature type'));
    const url = h('input', { type: 'url', placeholder: 'https://…/FeatureServer/0  or  https://…/wfs', 'data-id': 're-url' });
    const typeName = h('input', { type: 'text', placeholder: 'ns:layer (WFS only)', 'data-id': 're-type' });
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Typed here; kept in memory only', 'data-id': 're-token' });
    const mode = h('select', { 'data-id': 're-mode' }, h('option', { value: 'query' }, 'WFS token as authkey parameter'), h('option', { value: 'bearer' }, 'WFS token as Bearer header'));
    if ((await modal({ title: 'Edit Online Layer', body: h('div', {}, field('Service', kind), field('URL', url), field('Feature type', typeName), field('Token', token), field('WFS token mode', mode), h('p', { class: 'hint' }, 'The origin must be in this file’s network allow-list (Add-Ins ▸ Network Origins). Edits are sent only when you choose Save Edits.')), buttons: ['Open', 'Cancel'], id: 'remote-edit' })) !== 'Open') return;
    const u = url.value.trim();
    await open({ kind: kind.value, url: u.replace(/\/$/, ''), name: kind.value === 'arcgis' ? u.split('/').slice(-3).join('/') : typeName.value, typeName: typeName.value.trim(), tokenMode: mode.value }, { token: token.value || null });
  }

  const remoteLayers = () => S.all('vlayer').filter((v) => v.source?.remote);
  C.implement('vec.remoteopen', { run: run(() => dialog()) });
  C.implement('vec.remotesave', { enabled: () => remoteLayers().length > 0, run: run(async () => { for (const v of remoteLayers()) await save(v.id); }) });
  app.remoteEdit = { open, save, pending, geomToEsri, geomToGml, geojsonToGeom, setToken: (vl, t) => tokens.set(vl, t), layers: remoteLayers };
}
