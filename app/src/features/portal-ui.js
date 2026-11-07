// ArcGIS portals (REQ-GAP-64): the lazy js-portal block. Sign-in to ArcGIS Online or ArcGIS
// Enterprise goes through the REQ-GAP-09 routes (connectors/auth.js: OAuth 2.0 with PKCE, the
// out-of-band code from a file opened from disk; the token in memory only, sent in the
// X-Esri-Authorization header to the portal and to the servers the user confirmed for it).
// Search and items, web maps as layer lists, feature attachments, related records and branch
// versions (connectors/portal.js), and .lyrx symbology (formats/lyrx.js). Every request goes
// through the logged fetch, so only to allow-listed origins.

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, tc, tr, en, N_, gwError, msgOf } from '../i18n/index.js';
import { num, dateTime } from '../i18n/format.js';
import { originOf } from '../ai/netlog.js';
import { withParams } from '../connectors/ogc.js';
import { arcgisParts, esriToGeoJSON, esriFields, readEsriAttrs } from '../connectors/arcgis.js';
import { portalRoot, portalSelf, searchItems, itemInfo, itemData, webmapLayers, collectionLayers, queryAttachments, addAttachment as addAtt, deleteAttachments as delAtt, relationships, siblingUrl, queryRelated, relatedEdits, editResults, versionServiceUrl, listVersions, newSessionId, startReading, startEditing, stopEditing, stopReading, reconcile, postVersion, readRelatedAttrs } from '../connectors/portal.js';
import { readLyrx, missingFields } from '../formats/lyrx.js';
import { pickFiles, saveBlob } from '../storage/files.js';

const TYPES = ['Feature Service', 'Map Service', 'Image Service', 'Vector Tile Service', 'Web Map', 'Scene Service'];

export function installPortal(app) {
  const C = app.commands;
  const S = app.store;
  const portals = new Map(); // root → {root, self}
  const infos = new Map(); // layer URL → layer JSON (public metadata)
  const versionState = new Map(); // vlayer id → {vms, guid, name, sessionId, mode}
  const fetcher = (root) => app.netlog.fetchFor(t('ArcGIS: {host}', { host: originOf(root) ?? root }));
  const getJson = (label) => async (u) => {
    const r = await fetcher(label)(u, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw gwError('{name}: HTTP {status}', { name: originOf(u) ?? u, status: r.status }, 'E_HTTP');
    return r.json();
  };
  const post = (label) => async (u, body) => {
    const r = await fetcher(label)(u, { method: 'POST', body, headers: { Accept: 'application/json' } });
    if (!r.ok) throw gwError('{name}: HTTP {status}', { name: originOf(u) ?? u, status: r.status }, 'E_HTTP');
    return r.json();
  };
  const run = (fn) => async (arg) => {
    try {
      return await fn(arg);
    } catch (e) {
      app.toast(msgOf(e), { kind: e?.code === 'E_NO_SELECTION' ? 'warn' : 'error', ms: 9000 });
      return undefined;
    }
  };

  // ---- portals and sign-in ----

  async function connect(url) {
    const root = portalRoot(url);
    const self = await portalSelf(getJson(root), root).catch((e) => {
      throw e?.code === 'E_NET_NOT_ALLOWED' ? e : gwError('{root} does not answer as an ArcGIS portal ({msg})', { root, msg: msgOf(e) }, 'E_PORTAL_SELF');
    });
    portals.set(root, { root, self });
    return { root, name: self.name, user: self.user, isPortal: self.isPortal };
  }

  const entryOf = (root) => app.auth?.policy.get(originOf(root)) ?? null;
  const signedIn = (root) => !!app.auth?.vault.has(originOf(root));

  /** Set up the portal's OAuth (client ID of the app registered in the portal) and sign in. */
  async function signIn(url, { clientId, grant = 'pkce' } = {}) {
    if (!app.auth) throw gwError('sign-in is not available in this build', null, 'E_AUTH_NONE');
    const root = portalRoot(url);
    const prev = entryOf(root);
    const id = String(clientId ?? prev?.oidc?.clientId ?? '').trim();
    if (!id) throw gwError('a client ID is needed (register GIS Workbench as an app in the portal, with a redirect URI)', null, 'E_AUTH_NO_CLIENT');
    app.auth.policy.set({ origin: originOf(root), browser: prev?.browser ?? false, oidc: { issuer: root, clientId: id, kind: 'arcgis', grant, alsoFor: prev?.oidc?.alsoFor ?? [] } });
    const ok = await app.auth.signIn(originOf(root), { grant });
    if (ok) await connect(root).catch(() => null);
    return ok;
  }

  /** Send the portal sign-in to another origin too (a hosting or federated server), on the user's word. */
  function trustServer(url, serverUrl) {
    const root = portalRoot(url);
    const e = entryOf(root);
    if (!e?.oidc) throw gwError('{origin} has no OpenID Connect setup', { origin: originOf(root) }, 'E_AUTH_NO_SETUP');
    const o = originOf(serverUrl);
    if (!o || o === originOf(root) || e.oidc.alsoFor?.includes(o)) return false;
    app.auth.policy.set({ ...e, oidc: { ...e.oidc, alsoFor: [...(e.oidc.alsoFor ?? []), o] } });
    return true;
  }

  /** Before opening a service of a signed-in portal on another origin: ask whether the sign-in goes there too. */
  async function askServer(root, url, ask) {
    if (!signedIn(root)) return;
    const o = originOf(url);
    const e = entryOf(root);
    if (!o || o === originOf(root) || e?.oidc?.alsoFor?.includes(o)) return;
    const yes = ask ? await ask(o) : (await modal({ title: t('Use Your Portal Sign-In?'), body: h('p', {}, t('The item’s service is on {origin}, not on the portal {portal}. Send your portal sign-in there too? Choose No to open it as a guest.', { origin: o, portal: originOf(root) })), buttons: [{ label: t('Yes'), value: 'yes', primary: true }, { label: t('No'), value: 'no' }], id: 'portal-trust' })) === 'yes';
    if (yes) trustServer(root, url);
  }

  async function search(url, opts = {}) {
    const root = portalRoot(url);
    return searchItems(getJson(root), root, opts);
  }

  // ---- items ----

  async function layerInfo(u, root) {
    if (!infos.has(u)) infos.set(u, await getJson(root ?? u)(withParams(u, { f: 'json' })));
    const j = infos.get(u);
    if (j?.error) {
      infos.delete(u);
      throw gwError('{name}: {msg}', { name: u, msg: j.error.message ?? `error ${j.error.code}` }, j.error.code === 498 || j.error.code === 499 ? 'E_ARCGIS_TOKEN' : 'E_SERVICE');
    }
    return j;
  }

  /** Feature layers of a FeatureServer item (or the one layer its URL names) as editable vector layers. */
  async function openFeatureService(root, url, title, { max = 8, gdbVersion = null } = {}) {
    const p = arcgisParts(url);
    if (!p || (p.type !== 'FeatureServer' && p.type !== 'MapServer')) throw gwError('{url} is not an ArcGIS feature service', { url }, 'E_ARCGIS_URL');
    let ids;
    if (p.layer !== null) ids = [{ id: p.layer, name: title }];
    else {
      const svc = await layerInfo(p.root, root);
      ids = (svc.layers ?? []).map((l) => ({ id: l.id, name: `${title} — ${l.name}` }));
    }
    const out = [];
    for (const l of ids.slice(0, max)) out.push(await app.remoteEdit.open({ kind: 'arcgis', url: `${p.root}/${l.id}`, name: l.name }, { gdbVersion }));
    if (ids.length > max) app.toast(t('{name}: opened the first {n} of {total} layers', { name: title, n: max, total: ids.length }), { kind: 'warn' });
    return out;
  }

  async function openService(url, kind, title) {
    await app.loadServices();
    const svc = await app.services.connect(url);
    const item = svc.items?.[0];
    if (!item) throw gwError('{name}: the service lists nothing to show', { name: title }, 'E_SERVICE');
    await app.services.addBackground(svc, item, kind === 'vector-tile' ? {} : { under: false });
    return { service: svc.id ?? url, kind };
  }

  /** Open a portal item by kind. → {kind, layers: [vlayer ids], services, refused}. */
  async function openItem(url, idOrItem, { ask = null } = {}) {
    const root = portalRoot(url);
    const it = typeof idOrItem === 'string' ? await itemInfo(getJson(root), root, idOrItem) : idOrItem;
    if (it.kind === 'webmap') return openWebMap(root, it.id, { ask });
    if (!it.kind) throw gwError('{title}: items of type {type} are not opened here (feature, map, image, vector tile and scene services and web maps are)', { title: it.title, type: it.type }, 'E_PORTAL_ITEM_TYPE');
    if (!it.url) throw gwError('{title}: the item has no service URL', { title: it.title }, 'E_PORTAL_ITEM_URL');
    await askServer(root, it.url, ask);
    if (it.kind === 'feature') return { kind: 'feature', layers: await openFeatureService(root, it.url, it.title), services: [], refused: [] };
    return { kind: it.kind, layers: [], services: [await openService(it.url, it.kind, it.title)], refused: [] };
  }

  /** A web map: its operational layers opened one by one; what cannot be opened is listed by name. */
  async function openWebMap(url, id, { ask = null } = {}) {
    const root = portalRoot(url);
    const data = await itemData(getJson(root), root, id);
    const list = webmapLayers(data);
    const out = { kind: 'webmap', layers: [], services: [], refused: [], basemap: list.filter((l) => l.basemap).map((l) => l.title), title: null };
    for (const l of list.filter((x) => !x.basemap)) {
      const name = [...l.path, l.title].join(' / ');
      try {
        if (l.refused) {
          out.refused.push({ title: name, reason: l.refused, msg: l.refusedMsg });
          continue;
        }
        if (l.kind === 'collection') {
          out.layers.push(...collection(name, l.featureCollection));
          continue;
        }
        let u = l.url;
        if (!u && l.itemId) u = (await itemInfo(getJson(root), root, l.itemId)).url;
        if (!u) {
          out.refused.push({ title: name, reason: en('no service URL'), msg: { src: N_('no service URL'), params: null } });
          continue;
        }
        await askServer(root, u, ask);
        if (l.kind === 'feature') {
          const ids = await openFeatureService(root, u, name);
          for (const vl of ids) {
            S.transact(t('Web map layer {name}', { name }), (tx) => {
              tx.set(vl, 'visible', l.visible);
              if (l.definitionExpression) tx.set(vl, 'note', l.definitionExpression);
            }, { kind: 'load' });
          }
          out.layers.push(...ids);
        } else if (['map', 'image', 'vector-tile', 'wms', 'wmts'].includes(l.kind)) out.services.push(await openService(u, l.kind, name));
        else out.refused.push({ title: name, reason: en('layer kind {kind}', { kind: l.kind }), msg: { src: N_('layer kind {kind}'), params: { kind: l.kind } } });
      } catch (e) {
        out.refused.push({ title: name, reason: e?.message ?? String(e), msg: e?.i18n ?? null, shown: msgOf(e) });
      }
    }
    if (out.refused.length) app.toast(t('{n, plural, one {# web map layer was} other {# web map layers were}} not opened: {list}', { n: out.refused.length, list: out.refused.map((r) => `${r.title} (${r.shown ?? (r.msg ? tr(r.msg) : r.reason)})`).slice(0, 4).join('; ') }), { kind: 'warn', ms: 10000 });
    return out;
  }

  /** A web map's embedded feature collection → read-only vector layers. */
  function collection(name, fc) {
    const ids = [];
    for (const l of collectionLayers(fc)) {
      const wgs = (l.sr?.wkid ?? l.sr?.latestWkid ?? 4326) === 4326;
      const merc = [102100, 3857].includes(l.sr?.wkid ?? l.sr?.latestWkid);
      if (!wgs && !merc) continue;
      const fields = esriFields({ fields: l.fields });
      S.transact(t('Open {name}', { name }), (tx) => {
        const vl = tx.create('vlayer', { name: `${name} — ${l.name}`, visible: true, style: { stroke: '#ff9900', width: 2, fill: '#ff990033' }, fields, source: { format: 'webmap-collection', remote: false }, created: new Date().toISOString() });
        for (const f of l.features) {
          let gj = esriToGeoJSON(f.geometry);
          if (gj && merc) gj = mercToLonLat(gj);
          const geom = gj ? app.remoteEdit.geojsonToGeom(gj) : null;
          if (geom) tx.create('feature', { vlayer: vl, geom, attrs: readEsriAttrs(fields, f.attributes ?? {}), name: null, prov: { kind: 'remote', source: 'web map' } });
        }
        ids.push(vl);
      }, { kind: 'load' });
    }
    return ids;
  }

  // ---- the selected feature of an ArcGIS layer ----

  function target(featureId) {
    const id = featureId ?? [...(app.selection ?? [])].find((x) => S.get(x)?.type === 'feature' && S.get(S.get(x).vlayer)?.source?.format === 'arcgis-fs');
    const f = id ? S.get(id) : null;
    const v = f ? S.get(f.vlayer) : null;
    if (!f || v?.source?.format !== 'arcgis-fs') throw gwError('select a feature of an ArcGIS feature layer first', null, 'E_NO_SELECTION');
    if (f.remoteId === undefined || f.remoteId === null) throw gwError('save the new feature to the service first (Save Online Edits)', null, 'E_ARCGIS_UNSAVED');
    return { f, v, url: v.source.url };
  }

  async function attachments(featureId) {
    const { f, v, url } = target(featureId);
    const info = await layerInfo(url);
    const m = await queryAttachments(getJson(url), url, info, [f.remoteId]);
    return m.get(Number(f.remoteId)) ?? [];
  }

  async function addAttachment(featureId, file) {
    const { f, url } = target(featureId);
    const r = await addAtt(post(url), url, f.remoteId, file);
    app.toast(t('{file}: attached to feature {id}', { file: file.name, id: f.remoteId }), { kind: 'info' });
    return r;
  }

  async function deleteAttachments(featureId, ids) {
    const { f, url } = target(featureId);
    return delAtt(post(url), url, f.remoteId, ids);
  }

  /** An attachment's bytes, through the logged fetch (the token goes in the header). */
  async function attachmentBlob(a) {
    const r = await fetcher(a.url)(a.url);
    if (!r.ok) throw gwError('{name}: HTTP {status}', { name: a.name, status: r.status }, 'E_HTTP');
    return new Blob([await r.arrayBuffer()], { type: a.contentType });
  }

  /** Related records of the selected feature: [{rel, tableUrl, info, fields, records}]. */
  async function related(featureId) {
    const { f, v, url } = target(featureId);
    const info = await layerInfo(url);
    const rels = relationships(info);
    if (!rels.length) throw gwError('the layer {name} has no relationships', { name: v.name }, 'E_ARCGIS_NO_RELATED');
    const out = [];
    for (const rel of rels) {
      const tableUrl = siblingUrl(url, rel.relatedTableId);
      const tinfo = await layerInfo(tableUrl);
      const q = await queryRelated(getJson(url), url, { objectIds: [f.remoteId], relationshipId: rel.id, gdbVersion: v.source.gdbVersion ?? null });
      const recs = (q.groups.get(Number(f.remoteId)) ?? []).map((r) => readRelatedAttrs(tinfo, r.attributes));
      out.push({ rel, tableUrl, info: tinfo, fields: esriFields(tinfo), records: recs });
    }
    return out;
  }

  /** Related record edits for the selected feature, checked first, then one applyEdits on the related table. */
  async function saveRelated(featureId, relId, edits) {
    const { f, v, url } = target(featureId);
    const info = await layerInfo(url);
    const rel = relationships(info).find((r) => r.id === relId);
    if (!rel) throw gwError('the layer {name} has no relationship {id}', { name: v.name, id: relId }, 'E_ARCGIS_NO_RELATED');
    const tableUrl = siblingUrl(url, rel.relatedTableId);
    const tinfo = await layerInfo(tableUrl);
    // The parent's key: the feature's attributes as read (GlobalID or another key field).
    const parent = { ...f.attrs };
    if (rel.keyField && parent[rel.keyField] === undefined && rel.keyField.toLowerCase() === (info.objectIdField ?? '').toLowerCase()) parent[rel.keyField] = f.remoteId;
    const body = relatedEdits(rel, tinfo, parent, edits);
    const fd = new URLSearchParams({ f: 'json', adds: JSON.stringify(body.adds), updates: JSON.stringify(body.updates), deletes: body.deletes.join(','), rollbackOnFailure: 'true' });
    if (v.source.gdbVersion) fd.set('gdbVersion', v.source.gdbVersion);
    const sid = app.remoteEdit.session(v.id);
    if (sid) fd.set('sessionID', sid);
    const res = editResults(await post(tableUrl)(`${tableUrl}/applyEdits`, fd), tinfo.name ?? tableUrl);
    app.toast(t('{name}: saved {adds, plural, one {# add} other {# adds}}, {updates, plural, one {# update} other {# updates}}, {deletes, plural, one {# delete} other {# deletes}}', { name: tinfo.name ?? rel.name, adds: body.adds.length, updates: body.updates.length, deletes: body.deletes.length }), { kind: 'info' });
    return res;
  }

  // ---- branch versions ----

  async function versions(vl) {
    const v = S.get(vl);
    if (v?.source?.format !== 'arcgis-fs') throw gwError('choose an ArcGIS feature layer', null, 'E_NO_LAYER');
    const vms = versionServiceUrl(v.source.url);
    return { vms, current: versionState.get(vl) ?? null, list: await listVersions(getJson(vms), vms) };
  }

  /** Read (mode 'read') or edit (mode 'edit') a branch version: the session is started and the layer reloaded from that version. */
  async function useVersion(vl, guid, { mode = 'read' } = {}) {
    const v = S.get(vl);
    const { vms, list } = await versions(vl);
    const ver = list.find((x) => x.guid === String(guid).replace(/[{}]/g, '').toUpperCase());
    if (!ver) throw gwError('"{id}" is not a version of this service', { id: String(guid) }, 'E_ARCGIS_VERSION');
    if (mode === 'edit' && ver.isDefault) throw gwError('the default version is not edited in a branch session here; create or choose a named version', null, 'E_ARCGIS_VERSION_DEFAULT');
    await endSession(vl, { save: false });
    const sessionId = newSessionId();
    await startReading(post(vms), vms, ver.guid, sessionId);
    if (mode === 'edit') await startEditing(post(vms), vms, ver.guid, sessionId);
    const name = v.name.replace(/ \[[^\]]*\]$/, '');
    const nl = await app.remoteEdit.open({ kind: 'arcgis', url: v.source.url, name: `${name} [${ver.name}]` }, { gdbVersion: ver.name });
    S.transact(t('Close {name}', { name: v.name }), (tx) => {
      for (const f of S.all('feature').filter((x) => x.vlayer === vl)) tx.delete(f.id);
      tx.delete(vl);
    }, { kind: 'load' });
    if (mode === 'edit') app.remoteEdit.setSession(nl, sessionId);
    versionState.set(nl, { vms, guid: ver.guid, name: ver.name, sessionId, mode });
    return nl;
  }

  async function endSession(vl, { save }) {
    const st = versionState.get(vl);
    if (!st) return;
    if (st.mode === 'edit') await stopEditing(post(st.vms), st.vms, st.guid, st.sessionId, save);
    await stopReading(post(st.vms), st.vms, st.guid, st.sessionId).catch(() => null);
    app.remoteEdit.setSession(vl, null);
    versionState.delete(vl);
  }

  /** Send the layer's edits to the version and save them there (stopEditing with saveEdits), then go on editing. */
  async function saveVersion(vl) {
    const st = versionState.get(vl);
    if (st?.mode !== 'edit') throw gwError('start editing a branch version first', null, 'E_ARCGIS_NOT_EDITING');
    const r = await app.remoteEdit.save(vl);
    await stopEditing(post(st.vms), st.vms, st.guid, st.sessionId, true);
    await startEditing(post(st.vms), st.vms, st.guid, st.sessionId);
    return r;
  }

  /** Reconcile the version with DEFAULT and post it (stopped when there are conflicts). */
  async function reconcilePost(vl) {
    const st = versionState.get(vl);
    if (st?.mode !== 'edit') throw gwError('start editing a branch version first', null, 'E_ARCGIS_NOT_EDITING');
    const r = await reconcile(post(st.vms), st.vms, st.guid, st.sessionId, { withPost: false, abortIfConflicts: true });
    if (r.hasConflicts) throw gwError('{name}: reconcile found conflicts with the default version; nothing was posted. Resolve them in ArcGIS Pro', { name: st.name }, 'E_ARCGIS_CONFLICTS');
    const p = await postVersion(post(st.vms), st.vms, st.guid, st.sessionId);
    app.toast(t('{name}: reconciled and posted to the default version', { name: st.name }), { kind: 'info' });
    return { ...r, posted: true, moment: p.moment ?? r.moment };
  }

  // ---- .lyrx ----

  /** Apply a layer file's symbology to a vector layer. → {layer, mapped, refused, missing}. */
  async function applyLyrx(vl, src, { layerName = null } = {}) {
    const v = S.get(vl);
    if (v?.type !== 'vlayer') throw gwError('choose a vector layer', null, 'E_NO_LAYER');
    const text = typeof src === 'string' ? src : await src.text();
    const doc = readLyrx(text);
    const want = (layerName ?? v.name ?? '').toLowerCase();
    const def = doc.layers.find((l) => l.name.toLowerCase() === want) ?? doc.layers.find((l) => want.includes(l.name.toLowerCase()) && l.name) ?? doc.layers[0];
    const names = (v.fields ?? []).map((f) => f.name);
    const attrNames = new Set(names);
    for (const f of S.all('feature')) if (f.vlayer === vl) for (const k of Object.keys(f.attrs ?? {})) attrNames.add(k);
    const byLower = new Map([...attrNames].map((n) => [n.toLowerCase(), n]));
    const fix = (n) => byLower.get(String(n).toLowerCase()) ?? n;
    const rules = def.styleRules.map((r) => ({ filter: { ...r.filter, field: fix(r.filter.field) }, style: r.style, label: r.label }));
    const style = { ...def.style, ...(def.style.labelField ? { labelField: fix(def.style.labelField) } : {}) };
    const missing = missingFields(def, [...attrNames]);
    S.transact(t('Style from {file}', { file: src?.name ?? '.lyrx' }), (tx) => {
      tx.set(vl, 'style', style);
      tx.set(vl, 'styleRules', rules);
    });
    app.renderer?.invalidate?.();
    const extra = doc.refused.map((r) => ({ what: r.name, whatMsg: null, reason: en('{type} (not a feature layer)', { type: r.type }), msg: { src: N_('{type} (not a feature layer)'), params: { type: r.type } } }));
    const refused = [...def.refused, ...extra];
    const res = { layer: def.name, mapped: def.mapped, refused, missing, rules: rules.length };
    app.toast(refused.length || missing.length ? t('{file}: style applied to {layer}; {n, plural, one {# part was} other {# parts were}} not applied: {list}', { file: src?.name ?? '.lyrx', layer: v.name, n: refused.length + missing.length, list: [...missing.map((m) => t('field {name} is missing', { name: m })), ...refused.map((r) => `${r.whatMsg ? tr(r.whatMsg) : r.what}: ${r.msg ? tr(r.msg) : r.reason}`)].slice(0, 5).join('; ') }) : t('{file}: style applied to {layer}', { file: src?.name ?? '.lyrx', layer: v.name }), { kind: refused.length || missing.length ? 'warn' : 'info', ms: 10000 });
    return res;
  }

  // ---- dialogs ----

  async function portalDialog() {
    const last = app.prefs.get('portalUrl') ?? 'https://www.arcgis.com';
    const url = h('input', { type: 'url', class: 'inp', value: last, 'data-id': 'portal:url', autocomplete: 'off', spellcheck: 'false' });
    const client = h('input', { type: 'text', class: 'inp', value: entryOf(safeRoot(last))?.oidc?.clientId ?? '', 'data-id': 'portal:client', autocomplete: 'off', spellcheck: 'false' });
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite', 'data-id': 'portal:status' }, '');
    const q = h('input', { type: 'search', class: 'inp', 'data-id': 'portal:q', autocomplete: 'off' });
    const type = h('select', { 'data-id': 'portal:type' }, h('option', { value: '' }, t('All types the app opens')), ...TYPES.map((x) => h('option', { value: x }, x))); // i18n-ignore: ArcGIS item type names
    const results = h('div', { class: 'portal-results', 'data-id': 'portal:results', role: 'list', 'aria-label': t('Portal items') });
    const btn = (label, id, fn) => {
      const b = h('button', { type: 'button', class: 'btn btn-small', 'data-id': id }, label);
      b.addEventListener('click', () => fn().catch((e) => (status.textContent = msgOf(e))));
      return b;
    };
    let root = null;
    const doConnect = async () => {
      root = portalRoot(url.value);
      app.prefs.set('portalUrl', root);
      const r = await connect(root);
      status.textContent = r.user ? t('{name}: signed in as {user}', { name: r.name ?? root, user: r.user }) : t('{name}: connected as a guest (public items only)', { name: r.name ?? root });
    };
    const doSignIn = async () => {
      root = portalRoot(url.value);
      if (await signIn(root, { clientId: client.value })) await doConnect();
    };
    const doSearch = async (start = 1) => {
      if (!root) await doConnect();
      const r = await search(root, { q: q.value, types: type.value ? [type.value] : TYPES, start, num: 20 });
      clear(results);
      if (!r.results.length) results.append(h('p', { class: 'hint' }, t('No items found.')));
      for (const it of r.results) {
        const open = h('button', { type: 'button', class: 'btn btn-small', 'data-id': `portal:open:${it.id}`, 'aria-label': t('Open {title}', { title: it.title }) }, tc('verb', 'Open'));
        open.addEventListener('click', () =>
          openItem(root, it)
            .then((o) => (status.textContent = t('{title}: opened ({layers, plural, one {# layer} other {# layers}}, {services, plural, one {# service} other {# services}})', { title: it.title, layers: o.layers.length, services: o.services.length })))
            .catch((e) => (status.textContent = msgOf(e))),
        );
        if (!it.kind) open.disabled = true;
        results.append(h('div', { class: 'portal-item', role: 'listitem', 'data-id': `portal:item:${it.id}` }, h('strong', {}, it.title), ' ', h('span', { class: 'hint' }, `${it.type}${it.owner ? ` · ${it.owner}` : ''}`), ' ', open));
      }
      status.textContent = t('{n, plural, one {# item} other {# items}} found; showing {shown}', { n: r.total, shown: r.results.length });
    };
    const body = h(
      'div',
      {},
      field(t('Portal address'), url, t('ArcGIS Online (https://www.arcgis.com or your organisation’s address) or an ArcGIS Enterprise portal (https://host/portal). Its origin must be in the network allow-list.')),
      h('div', { class: 'btn-row' }, btn(t('Connect as a Guest'), 'portal:connect', doConnect)),
      field(t('App client ID (for sign-in)'), client, t('Register GIS Workbench as an app in the portal with the redirect URI of the hosted copy, or urn:ietf:wg:oauth:2.0:oob for a file opened from disk. The token stays in memory.')),
      h('div', { class: 'btn-row' }, btn(t('Sign In'), 'portal:signin', doSignIn)),
      field(t('Search'), q),
      field(t('Item type'), type),
      h('div', { class: 'btn-row' }, btn(t('Search'), 'portal:search', () => doSearch(1))),
      status,
      results,
    );
    await modal({ title: t('ArcGIS Portal'), body, buttons: [{ label: t('Close'), value: 'close' }], width: 640, id: 'portal' });
  }

  async function attachmentsDialog() {
    const { f, v } = target();
    const list = h('ul', { 'data-id': 'att:list', 'aria-label': t('Attachments') });
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite', 'data-id': 'att:status' }, '');
    const render = async () => {
      const items = await attachments(f.id);
      clear(list);
      if (!items.length) list.append(h('li', {}, t('No attachments.')));
      for (const a of items) {
        const openB = h('button', { type: 'button', class: 'btn btn-small', 'data-id': `att:open:${a.id}`, 'aria-label': t('Save {name}', { name: a.name }) }, tc('verb', 'Save'));
        openB.addEventListener('click', async () => {
          try {
            await saveBlob(app, await attachmentBlob(a), { name: a.name });
          } catch (e) {
            status.textContent = msgOf(e);
          }
        });
        const del = h('button', { type: 'button', class: 'btn btn-small', 'data-id': `att:delete:${a.id}`, 'aria-label': t('Delete {name}', { name: a.name }) }, t('Delete'));
        del.addEventListener('click', async () => {
          try {
            await deleteAttachments(f.id, [a.id]);
            status.textContent = t('{name}: deleted', { name: a.name });
            await render();
          } catch (e) {
            status.textContent = msgOf(e);
          }
        });
        list.append(h('li', { 'data-id': `att:item:${a.id}` }, `${a.name} (${a.contentType}, ${num(a.size / 1024, 1)} KB) `, openB, ' ', del));
      }
    };
    const add = h('button', { type: 'button', class: 'btn btn-small', 'data-id': 'att:add' }, t('Add Files…'));
    add.addEventListener('click', async () => {
      try {
        for (const file of await pickFiles(app, { multiple: true, description: t('Files to attach') })) await addAttachment(f.id, file);
        await render();
      } catch (e) {
        status.textContent = msgOf(e);
      }
    });
    await render();
    await modal({ title: t('Attachments — {layer}, feature {id}', { layer: v.name, id: f.remoteId }), body: h('div', {}, list, h('div', { class: 'btn-row' }, add), status), buttons: [{ label: t('Close'), value: 'close' }], width: 560, id: 'attachments' });
  }

  async function relatedDialog() {
    const { f, v } = target();
    const groups = await related(f.id);
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite', 'data-id': 'rel:status' }, '');
    const body = h('div', {});
    for (const g of groups) {
      const editable = g.fields.filter((x) => x.editable && x.name !== g.rel.keyFieldInRelationshipTable);
      const idField = g.info.objectIdField ?? 'OBJECTID';
      const table = h('table', { class: 'tbl', 'data-id': `rel:table:${g.rel.id}` }, h('caption', {}, `${g.rel.name} (${g.records.length})`), h('thead', {}, h('tr', {}, ...[idField, ...editable.map((x) => x.title ?? x.name)].map((n) => h('th', { scope: 'col' }, n)))));
      const tb = h('tbody', {});
      const inputs = [];
      for (const r of g.records) {
        const row = { id: r[idField], cells: {} };
        const tr = h('tr', {}, h('td', {}, String(r[idField])));
        for (const x of editable) {
          const inp = h('input', { class: 'inp', value: r[x.name] ?? '', 'aria-label': t('{field} of record {id}', { field: x.title ?? x.name, id: r[idField] }), 'data-id': `rel:cell:${g.rel.id}:${r[idField]}:${x.name}` });
          row.cells[x.name] = { inp, was: r[x.name] ?? '' };
          tr.append(h('td', {}, inp));
        }
        inputs.push(row);
        tb.append(tr);
      }
      table.append(tb);
      const newRow = {};
      const addRow = h('div', { class: 'rel-new' }, ...editable.map((x) => {
        const inp = h('input', { class: 'inp', 'data-id': `rel:new:${g.rel.id}:${x.name}` });
        newRow[x.name] = inp;
        return field(x.title ?? x.name, inp);
      }));
      const save = h('button', { type: 'button', class: 'btn btn-small', 'data-id': `rel:save:${g.rel.id}` }, t('Save Related Edits'));
      save.addEventListener('click', async () => {
        const updates = inputs.map((row) => ({ id: row.id, ch: Object.fromEntries(Object.entries(row.cells).filter(([, c]) => String(c.inp.value) !== String(c.was)).map(([k, c]) => [k, c.inp.value])) })).filter((u) => Object.keys(u.ch).length).map((u) => ({ [idField]: u.id, ...u.ch }));
        const add = Object.fromEntries(Object.entries(newRow).filter(([, i]) => i.value !== '').map(([k, i]) => [k, i.value]));
        try {
          await saveRelated(f.id, g.rel.id, { adds: Object.keys(add).length ? [add] : [], updates });
          status.textContent = t('Saved.');
        } catch (e) {
          status.textContent = msgOf(e);
        }
      });
      body.append(table, h('p', { class: 'hint' }, t('New related record:')), addRow, h('div', { class: 'btn-row' }, save));
    }
    body.append(status);
    await modal({ title: t('Related Records — {layer}, feature {id}', { layer: v.name, id: f.remoteId }), body, buttons: [{ label: t('Close'), value: 'close' }], width: 720, id: 'related' });
  }

  async function versionsDialog() {
    const v = S.all('vlayer').find((x) => x.id === app.prefs.get('vlayerActive') && x.source?.format === 'arcgis-fs') ?? S.all('vlayer').find((x) => x.source?.format === 'arcgis-fs');
    if (!v) throw gwError('open an ArcGIS feature layer first', null, 'E_NO_LAYER');
    const info = await versions(v.id);
    const sel = h('select', { 'data-id': 'ver:list' }, ...info.list.map((x) => h('option', { value: x.guid, selected: info.current?.guid === x.guid }, `${x.name}${x.isDefault ? ` (${t('default')})` : ''}${x.modified ? ` · ${dateTime(x.modified)}` : ''}`)));
    const status = h('p', { class: 'hint', role: 'status', 'aria-live': 'polite', 'data-id': 'ver:status' }, info.current ? t('Now: {name} ({mode, select, edit {editing} other {reading}})', { name: info.current.name, mode: info.current.mode }) : '');
    let vl = v.id;
    const act = (label, id, fn) => {
      const b = h('button', { type: 'button', class: 'btn btn-small', 'data-id': id }, label);
      b.addEventListener('click', async () => {
        try {
          status.textContent = await fn();
        } catch (e) {
          status.textContent = msgOf(e);
        }
      });
      return b;
    };
    const body = h(
      'div',
      {},
      field(t('Branch version'), sel),
      h('div', { class: 'btn-row' },
        act(t('Read'), 'ver:read', async () => ((vl = await useVersion(vl, sel.value, { mode: 'read' })), t('Reading {name}', { name: versionState.get(vl).name }))),
        act(t('Edit'), 'ver:edit', async () => ((vl = await useVersion(vl, sel.value, { mode: 'edit' })), t('Editing {name}', { name: versionState.get(vl).name }))),
        act(t('Save Edits'), 'ver:save', async () => {
          const r = await saveVersion(vl);
          return t('saved {adds, plural, one {# add} other {# adds}}, {updates, plural, one {# update} other {# updates}}, {deletes, plural, one {# delete} other {# deletes}}', r);
        }),
        act(t('Reconcile and Post'), 'ver:post', async () => (await reconcilePost(vl), t('Posted.'))),
      ),
      status,
    );
    await modal({ title: t('Branch Versions — {layer}', { layer: v.name }), body, buttons: [{ label: t('Close'), value: 'close' }], width: 560, id: 'versions' });
  }

  async function lyrxCommand() {
    const v = S.all('vlayer').find((x) => x.id === app.prefs.get('vlayerActive')) ?? S.all('vlayer').at(-1);
    if (!v) throw gwError('open a vector layer first', null, 'E_NO_LAYER');
    const [file] = await pickFiles(app, { multiple: false, accept: ['.lyrx'], description: t('ArcGIS Pro layer file') });
    if (file) return applyLyrx(v.id, file);
    return null;
  }

  app.portal = { connect, signIn, trustServer, search, openItem, openWebMap, attachments, addAttachment, deleteAttachments, attachmentBlob, related, saveRelated, versions, useVersion, saveVersion, reconcilePost, endSession, applyLyrx, portals, versionState };
  C.implement('net.portal', { run: run(() => portalDialog()) });
  C.implement('vec.attachments', { enabled: hasSel, run: run(() => attachmentsDialog()) });
  C.implement('vec.related', { enabled: hasSel, run: run(() => relatedDialog()) });
  C.implement('vec.versions', { enabled: () => S.all('vlayer').some((x) => x.source?.format === 'arcgis-fs'), run: run(() => versionsDialog()) });
  C.implement('vec.lyrx', { enabled: () => S.all('vlayer').length > 0, run: run(() => lyrxCommand()) });
  function hasSel() {
    try {
      target();
      return true;
    } catch {
      return false;
    }
  }
  return app.portal;
}

function safeRoot(u) {
  try {
    return portalRoot(u);
  } catch {
    return 'https://www.arcgis.com';
  }
}

const R = 6378137;
function mercToLonLat(g) {
  const c = (p) => [(p[0] / R) * (180 / Math.PI), (Math.atan(Math.exp(p[1] / R)) * 2 - Math.PI / 2) * (180 / Math.PI), ...p.slice(2)];
  const walk = (a) => (typeof a[0] === 'number' ? c(a) : a.map(walk));
  return { ...g, coordinates: walk(g.coordinates) };
}
