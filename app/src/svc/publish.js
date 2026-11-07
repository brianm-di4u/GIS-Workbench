// Publish review results to a service (REQ-GAP-59): accepted ML detections and analyst
// observations go to an ArcGIS FeatureServer layer (applyEdits adds), a WFS-T 2.0 feature type
// (Transaction Insert) or an OGC API Features collection (Part 4: POST items). The record keys are
// matched to the target's fields by name (case-insensitive); values the target's types and
// domains refuse stop the publish before anything is sent; what was published, and where, is
// kept on each record so a second run does not duplicate it. Every request goes through the
// logged fetch and the allow-list (REQ-SEC-12); tokens stay in memory (REQ-SEC-10).

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { esriFields, esriSubtypes, checkEsriAttrs, writeEsriAttrs, esriError } from '../connectors/arcgis.js';
import { withParams, conformance, linkOf, resolveUrl } from '../connectors/ogc.js';
import { exceptionText, parseXml, all as xmlAll, attr as xmlAttr } from '../connectors/xml.js';
import { fromParts } from '../vector/geom.js';
import { t, msgOf, gwError } from '../i18n/index.js';

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The centroid of a geometry's vertices (for point targets). */
function centroid(geom) {
  const v = geom.xyz;
  let n = v.length / 3;
  // A closed ring repeats its first vertex: count it once.
  if (n > 1 && v[0] === v[3 * (n - 1)] && v[1] === v[3 * (n - 1) + 1]) n--;
  let x = 0;
  let y = 0;
  for (let i = 0; i < n; i++) [x, y] = [x + v[3 * i], y + v[3 * i + 1]];
  return fromParts('Point', [[[x / n, y / n, 0]]]);
}

export function install(app) {
  const S = app.store;
  const tokens = new Map(); // target URL → token (memory only)

  /** The records to publish: [{rec, geom, props}] for accepted detections or observations. */
  function records(what) {
    if (what === 'observations') {
      return S.all('observation')
        .filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon))
        .map((o) => ({ rec: o, geom: fromParts('Point', [[[o.lon, o.lat, 0]]]), props: { category: o.category ?? '', confidence: o.confidence ?? '', text: o.text ?? '', time: o.time ?? o.created ?? null, image: o.image ?? '', analyst: o.analyst ?? '', source: 'GIS Workbench observation' } }));
    }
    return S.all('detection')
      .filter((d) => d.status === 'accepted')
      .map((d) => {
        const f = d.feature ? S.get(d.feature) : null;
        return f?.geom ? { rec: d, geom: f.geom, props: { class: f.attrs?.CLASS ?? d.cls, confidence: Number.isFinite(d.confidence) ? d.confidence : null, source: d.source ?? '', note: f.attrs?.NOTE ?? d.note ?? '', image: d.image ?? '', detection: d.n, reviewed: d.decided ?? d.imported ?? null, analyst: app.prefs.get('analyst') ?? '' } } : null;
      })
      .filter(Boolean);
  }

  /** Map record keys to the target's field names (case-insensitive); returns {attrs, unmatched}. */
  function mapFields(props, names) {
    const by = new Map(names.map((n) => [n.toLowerCase(), n]));
    const attrs = {};
    const unmatched = [];
    for (const [k, v] of Object.entries(props)) {
      const n = by.get(k.toLowerCase());
      if (n) attrs[n] = v;
      else unmatched.push(k);
    }
    return { attrs, unmatched };
  }

  const already = (rec, url) => (rec.published ?? []).some((p) => p.url === url);

  /**
   * Publish. target: {kind: 'arcgis'|'wfs'|'ogcapi', url (layer, WFS endpoint or collection),
   * typeName (WFS), token, tokenMode ('query'|'bearer'), tokenParam}. opts: what ('detections' |
   * 'observations'), republish. → {sent, skipped, ids, unmatched, pointsFromAreas}.
   */
  async function publish(target, { what = 'detections', republish = false } = {}) {
    const url = String(target.url ?? '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw gwError('enter a service URL that starts with http:// or https:// first', null, 'E_STEP_FIRST');
    if (target.token) tokens.set(url, target.token);
    const token = tokens.get(url) ?? null;
    const all = records(what);
    if (!all.length) throw gwError(what === 'observations' ? 'there are no observations with a position to publish' : 'there are no accepted detections to publish: accept some in the review queue first', null, 'E_STEP_FIRST');
    const todo = republish ? all : all.filter((r) => !already(r.rec, url));
    const skipped = all.length - todo.length;
    if (!todo.length) return { sent: 0, skipped, ids: [], unmatched: [], pointsFromAreas: 0 };
    const fetch = app.netlog.fetchFor(`Publish: ${url}`);
    let ids = [];
    let unmatched = new Set();
    let pointsFromAreas = 0;
    if (target.kind === 'arcgis') {
      const tok = (u) => (token ? withParams(u, { token }) : u);
      const info = await (await fetch(tok(withParams(url, { f: 'json' })), { credentials: 'omit' })).json();
      const e = esriError(info, url);
      if (e) throw e;
      if (info.capabilities && !/Create|Editing/.test(info.capabilities)) throw gwError('{url} does not allow adding features (capabilities: {caps})', { url, caps: info.capabilities }, 'E_NOT_EDITABLE');
      const fields = esriFields(info);
      const subtypes = esriSubtypes(info);
      const point = info.geometryType === 'esriGeometryPoint';
      const poly = info.geometryType === 'esriGeometryPolygon';
      const adds = [];
      const problems = [];
      for (const r of todo) {
        const { attrs, unmatched: u } = mapFields(r.props, fields.filter((f) => f.editable).map((f) => f.name));
        u.forEach((k) => unmatched.add(k));
        let g = r.geom;
        if (point && g.type !== 'Point') {
          g = centroid(g);
          pointsFromAreas++;
        } else if (poly && !/Polygon/.test(g.type)) throw gwError('{url} holds polygons; the records to publish are points. Publish them to a point layer.', { url }, 'E_GEOMETRY_TYPE');
        for (const p of checkEsriAttrs(fields, subtypes, attrs, { isNew: true })) problems.push(p);
        adds.push({ geometry: app.remoteEdit.geomToEsri(g), attributes: writeEsriAttrs(fields, attrs) });
      }
      if (problems.length) throw Object.assign(gwError('{url}: {n, plural, one {# value is} other {# values are}} not allowed by the layer, so nothing was sent: {msg}', { url, n: problems.length, msg: problems.slice(0, 4).map((x) => msgOf(x)).join('; ') }, 'E_ATTRS_INVALID'), { issues: problems });
      const body = new URLSearchParams({ f: 'json', adds: JSON.stringify(adds), rollbackOnFailure: 'true' });
      if (token) body.set('token', token);
      const r = await fetch(`${url}/applyEdits`, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const j = await r.json();
      if (!r.ok || j.error) throw gwError('{name}: applyEdits failed ({msg})', { name: url, msg: j.error?.message ?? `HTTP ${r.status}` }, 'E_APPLY_EDITS');
      const bad = (j.addResults ?? []).filter((x) => !x.success);
      if (bad.length) throw gwError('{name}: {n, plural, one {# edit} other {# edits}} refused: {msg}', { name: url, n: bad.length, msg: bad.map((x) => x.error?.description ?? 'error').join('; ') }, 'E_EDITS_REFUSED');
      ids = (j.addResults ?? []).map((x) => x.objectId);
    } else if (target.kind === 'wfs') {
      if (!target.typeName) throw gwError('give the WFS feature type (ns:name) first', null, 'E_STEP_FIRST');
      const d = await app.remoteEdit.describeWfs({ url, name: url, typeName: target.typeName, tokenMode: target.tokenMode, tokenParam: target.tokenParam }, token);
      const geomName = d?.geomName ?? 'geometry';
      const names = d?.fields?.map((f) => f.name) ?? null;
      const [ns, local] = target.typeName.includes(':') ? target.typeName.split(':') : ['feature', target.typeName];
      const parts = todo.map((r) => {
        let attrs = r.props;
        if (names) {
          const m = mapFields(r.props, names);
          m.unmatched.forEach((k) => unmatched.add(k));
          attrs = m.attrs;
        }
        const props = Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined && v !== '');
        return `<${ns}:${local}>${props.map(([k, v]) => `<${ns}:${k}>${xmlEsc(v)}</${ns}:${k}>`).join('')}<${ns}:${geomName}>${app.remoteEdit.geomToGml(r.geom)}</${ns}:${geomName}></${ns}:${local}>`;
      });
      const xml = `<?xml version="1.0" encoding="UTF-8"?><wfs:Transaction service="WFS" version="2.0.0" xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0" xmlns:gml="http://www.opengis.net/gml/3.2" xmlns:${ns}="${xmlEsc(target.namespace ?? `urn:gis-workbench:${ns}`)}"><wfs:Insert>${parts.join('')}</wfs:Insert></wfs:Transaction>`;
      const headers = { 'content-type': 'application/xml' };
      if (token && target.tokenMode === 'bearer') headers.Authorization = `Bearer ${token}`;
      const u = token && target.tokenMode !== 'bearer' ? withParams(url, { [target.tokenParam ?? 'authkey']: token }) : url;
      const r = await fetch(u, { method: 'POST', credentials: 'omit', headers, body: xml });
      const text = await r.text();
      const ex = exceptionText(text);
      if (!r.ok || ex) throw gwError('{name}: WFS Transaction failed ({msg})', { name: url, msg: ex ?? `HTTP ${r.status}` }, 'E_WFS_TRANSACTION');
      ids = xmlAll(parseXml(text), 'InsertResults').flatMap((n) => xmlAll(n, 'ResourceId').map((x) => xmlAttr(x, 'rid')));
    } else if (target.kind === 'ogcapi') {
      // The collection URL (…/collections/{id}); items are POSTed one by one (Part 4).
      const headers = { 'content-type': 'application/geo+json', Accept: 'application/geo+json, application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const col = url.replace(/\/items$/, '');
      const cj = await (await fetch(withParams(col, { f: 'json' }), { credentials: 'omit', headers: { Accept: 'application/json', ...(token ? { Authorization: headers.Authorization } : {}) } })).json().catch(() => ({}));
      const itemsUrl = resolveUrl(linkOf(cj.links, 'items', 'application/geo+json') ?? `${col}/items`, col).replace(/[?].*$/, '');
      const root = col.replace(/\/collections\/[^/]+$/, '');
      const conf = await (await fetch(withParams(`${root}/conformance`, { f: 'json' }), { credentials: 'omit' })).json().then(conformance).catch(() => null);
      if (conf && !conf.create) throw gwError('{url} does not declare OGC API Features Part 4 (create, replace, delete); it cannot take new features', { url: root }, 'E_NOT_EDITABLE');
      for (const r of todo) {
        const feature = { type: 'Feature', properties: Object.fromEntries(Object.entries(r.props).filter(([, v]) => v !== null && v !== undefined)), geometry: app.remoteEdit.geomToGeojson(r.geom) };
        const res = await fetch(itemsUrl, { method: 'POST', credentials: 'omit', headers, body: JSON.stringify(feature) });
        if (res.status !== 201 && res.status !== 200 && res.status !== 204) {
          const body = await res.text().catch(() => '');
          throw gwError('{name}: the server refused feature {n} (HTTP {status}{detail})', { name: col, n: ids.length + 1, status: res.status, detail: body ? `: ${body.slice(0, 160)}` : '' }, 'E_OGC_CREATE');
        }
        const loc = res.headers.get('location');
        ids.push(loc ? decodeURIComponent(loc.replace(/[?#].*$/, '').split('/').pop()) : null);
      }
    } else throw gwError('unknown target type {kind}', { kind: String(target.kind) }, 'E_TARGET_UNKNOWN');
    const at = new Date().toISOString();
    S.transact(what === 'observations' ? t('Published observations') : t('Published detections'), (tx) => todo.forEach((r, i) => tx.set(r.rec.id, 'published', [...(r.rec.published ?? []), { url, kind: target.kind, id: ids[i] ?? null, at }])));
    unmatched = [...unmatched];
    app.toast(t('{n, plural, one {# record} other {# records}} published to {url}.', { n: todo.length, url }), { kind: 'info' });
    if (unmatched.length) app.toast(t('Not published (the target has no such field): {fields}', { fields: unmatched.join(', ') }), { kind: 'warn', ms: 9000 });
    return { sent: todo.length, skipped, ids, unmatched, pointsFromAreas };
  }

  async function dialog(what = 'detections') {
    const sel = h('select', { class: 'inp', 'aria-label': t('What to publish'), 'data-id': 'pub:what' }, h('option', { value: 'detections', selected: what === 'detections' }, t('Accepted detections')), h('option', { value: 'observations', selected: what === 'observations' }, t('Observations')));
    const kind = h('select', { class: 'inp', 'aria-label': t('Service type'), 'data-id': 'pub:kind' }, h('option', { value: 'arcgis' }, t('ArcGIS feature layer (…/FeatureServer/0)')), h('option', { value: 'wfs' }, t('WFS-T 2.0 feature type')), h('option', { value: 'ogcapi' }, t('OGC API Features collection (Part 4)')));
    const url = h('input', { class: 'inp', type: 'url', spellcheck: 'false', 'aria-label': t('Service address'), placeholder: 'https://…', 'data-id': 'pub:url' }); // i18n-ignore: URL
    const type = h('input', { class: 'inp', spellcheck: 'false', 'aria-label': t('Feature type'), placeholder: t('ns:layer (WFS only)'), 'data-id': 'pub:type' });
    const tok = h('input', { class: 'inp', type: 'password', autocomplete: 'off', 'aria-label': t('Token'), placeholder: t('Typed here; kept in memory only') });
    const again = h('input', { type: 'checkbox', 'aria-label': t('Publish records that were published there before') });
    const r = await modal({ title: t('Publish to a Service'), body: h('div', {}, field(t('What'), sel), field(t('Service'), kind), field(t('URL'), url), field(t('Feature type'), type), field(t('Token'), tok), h('label', {}, again, ' ', t('Publish records that were published there before')), h('p', { class: 'hint' }, t('Fields are matched by name. Values the layer’s types or domains refuse stop the publish before anything is sent. The origin must be in the network allow-list.'))), buttons: [{ label: t('Publish'), value: 'publish', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 620, id: 'publish-service' });
    if (r !== 'publish') return;
    const out = await publish({ kind: kind.value, url: url.value, typeName: type.value.trim() || null, token: tok.value || null, tokenMode: 'query' }, { what: sel.value, republish: again.checked });
    if (!out.sent && out.skipped) app.toast(t('All {n, plural, one {# record was} other {# records were}} published there before; nothing sent.', { n: out.skipped }), { kind: 'info' });
  }

  app.publish = { publish, records, dialog, setToken: (u, tk) => (tk ? tokens.set(u, tk) : tokens.delete(u)) };
}
