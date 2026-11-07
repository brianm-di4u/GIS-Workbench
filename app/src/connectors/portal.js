// ArcGIS portals, protocol side (REQ-GAP-64): ArcGIS Online and ArcGIS Enterprise sign-in
// metadata (OAuth 2.0 with PKCE through the REQ-GAP-09 routes), portal search and items, web maps
// as layer lists, feature attachments (query, add, delete), related records (query, edit with the
// 2.4 typed-field checks) and branch versions (Version Management Service: list, start reading or
// editing, save, reconcile and post). No fetching here: callers pass the logged fetch (REQ-SEC-12),
// which adds the portal token in a header (connectors/auth.js), never in a URL.

import { gwError, N_, en } from '../i18n/index.js';
import { arcgisMeta } from './auth.js';
import { withParams } from './ogc.js';
import { esriError, esriFields, esriSubtypes, checkEsriAttrs, writeEsriAttrs, readEsriAttrs, arcgisParts } from './arcgis.js';

/** The portal root an address names: https://www.arcgis.com, https://org.maps.arcgis.com, https://host/portal (Enterprise web adaptor). */
export function portalRoot(url) {
  let u;
  try {
    u = new URL(String(url).trim());
  } catch {
    throw gwError('"{text}" is not a URL', { text: String(url ?? '').slice(0, 200) }, 'E_NOT_A_URL');
  }
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) throw gwError('a portal is signed in to over https only: {url}', { url: u.href }, 'E_PORTAL_NOT_HTTPS');
  const path = u.pathname.replace(/\/(sharing(\/rest)?|home)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${u.origin}${path}`;
}

export const restOf = (root) => `${root}/sharing/rest`;

/** OAuth 2.0 metadata of a portal (connectors/auth.js, shared with the sign-in windows). */
export { arcgisMeta };

/** Esri JSON reply or a refusal by name. */
export function esriJson(j, name) {
  const e = esriError(j, name);
  if (e) throw e;
  return j;
}

/** portals/self and the signed-in user (null when anonymous). */
export async function portalSelf(getJson, root) {
  const j = esriJson(await getJson(withParams(`${restOf(root)}/portals/self`, { f: 'json' })), root);
  return { id: j.id ?? null, name: j.name ?? null, isPortal: !!j.isPortal, user: j.user?.username ?? null, customBaseUrl: j.customBaseUrl ?? null, urlKey: j.urlKey ?? null, helperServices: j.helperServices ?? {}, raw: j };
}

/** Federated and hosting servers of an Enterprise portal (portals/self/servers), as origins. */
export async function portalServers(getJson, root) {
  try {
    const j = await getJson(withParams(`${restOf(root)}/portals/self/servers`, { f: 'json' }));
    if (j?.error) return [];
    return (j?.servers ?? []).map((s) => ({ url: s.url, adminUrl: s.adminUrl ?? null, role: s.serverRole ?? null, type: s.serverType ?? null }));
  } catch {
    return [];
  }
}

/** Item types the app opens, by kind; everything else is listed and refused by name. */
export const ITEM_KINDS = {
  'Feature Service': 'feature',
  'Map Service': 'map',
  'Image Service': 'image',
  'Vector Tile Service': 'vector-tile',
  'Scene Service': 'scene',
  'Web Map': 'webmap',
  WMS: 'wms',
  WMTS: 'wmts',
  'OGCFeatureServer': 'ogcapi',
};

export function itemKind(item) {
  return ITEM_KINDS[item?.type] ?? null;
}

/**
 * Portal search (sharing/rest/search): q, an item-type filter, paging by start/num.
 * → {total, start, num, nextStart (−1 at the end), results}
 */
export async function searchItems(getJson, root, { q = '', types = [], start = 1, num = 20, sortField = '', sortOrder = '' } = {}) {
  const parts = [];
  if (String(q).trim()) parts.push(`(${String(q).trim()})`);
  if (types.length) parts.push(`(${types.map((t) => `type:"${String(t).replace(/"/g, '')}"`).join(' OR ')})`);
  const query = parts.join(' AND ') || '*';
  const j = esriJson(await getJson(withParams(`${restOf(root)}/search`, { q: query, start: Math.max(1, start), num: Math.max(1, Math.min(100, num)), sortField: sortField || null, sortOrder: sortOrder || null, f: 'json' })), root);
  return { total: Number(j.total) || 0, start: Number(j.start) || start, num: Number(j.num) || num, nextStart: Number(j.nextStart ?? -1), results: (j.results ?? []).map(itemSummary) };
}

export const itemSummary = (it) => ({ id: String(it.id), title: String(it.title ?? it.name ?? it.id), type: String(it.type ?? ''), owner: it.owner ?? null, url: it.url ?? null, snippet: it.snippet ?? '', access: it.access ?? null, extent: Array.isArray(it.extent) && it.extent.length === 2 ? it.extent : null, typeKeywords: it.typeKeywords ?? [], kind: itemKind(it) });

export async function itemInfo(getJson, root, id) {
  if (!/^[0-9a-f]{32}$/i.test(String(id))) throw gwError('"{id}" is not a portal item ID (32 hexadecimal digits)', { id: String(id).slice(0, 60) }, 'E_PORTAL_ITEM_ID');
  return itemSummary(esriJson(await getJson(withParams(`${restOf(root)}/content/items/${id}`, { f: 'json' })), root));
}

export async function itemData(getJson, root, id) {
  return esriJson(await getJson(withParams(`${restOf(root)}/content/items/${id}/data`, { f: 'json' })), root);
}

const LAYER_TYPE_KIND = {
  ArcGISFeatureLayer: 'feature',
  ArcGISMapServiceLayer: 'map',
  ArcGISTiledMapServiceLayer: 'map',
  ArcGISImageServiceLayer: 'image',
  ArcGISTiledImageServiceLayer: 'image',
  VectorTileLayer: 'vector-tile',
  WMS: 'wms',
  WMTS: 'wmts',
  ArcGISSceneServiceLayer: 'scene',
  OGCFeatureLayer: 'ogcapi',
};

/**
 * A web map's operational layers as a flat list (group layers opened): [{title, kind, url, itemId,
 * layerType, visible, opacity, featureCollection, path, refused}]. `refused` names a layer the
 * app does not open (CSV, KML, GeoRSS, a layer with neither URL nor item). Basemap layers are
 * listed with basemap:true.
 */
export function webmapLayers(data) {
  const out = [];
  const walk = (list, path, basemap) => {
    for (const l of list ?? []) {
      const title = String(l.title ?? l.id ?? '');
      // A group layer holds layers; a map service layer's `layers` are its sublayer settings, not layers
      // of the web map (found on ArcGIS Online's World Traffic Map, TE-C25).
      if (l.layerType === 'GroupLayer' || (Array.isArray(l.layers) && !l.url && !LAYER_TYPE_KIND[l.layerType])) {
        walk(l.layers, [...path, title], basemap);
        continue;
      }
      let kind = LAYER_TYPE_KIND[l.layerType] ?? null;
      if (!kind && l.featureCollection) kind = 'collection';
      if (!kind && l.url) {
        const p = arcgisParts(l.url);
        kind = p ? { FeatureServer: 'feature', MapServer: 'map', ImageServer: 'image', VectorTileServer: 'vector-tile', SceneServer: 'scene' }[p.type] ?? null : null;
      }
      const e = { title, kind, url: l.url ?? l.styleUrl ?? null, itemId: l.itemId ?? null, layerType: l.layerType ?? null, visible: l.visibility !== false, opacity: Number.isFinite(l.opacity) ? l.opacity : 1, featureCollection: l.featureCollection ?? null, definitionExpression: l.layerDefinition?.definitionExpression ?? null, path, basemap, refused: null };
      // refused: English (results, logs); refusedMsg: the message shown with tr().
      if (!kind) e.refusedMsg = l.layerType ? { src: N_('layer type {type}'), params: { type: String(l.layerType) } } : { src: N_('no service URL or feature collection'), params: null };
      else if (kind !== 'collection' && !e.url && !e.itemId) e.refusedMsg = { src: N_('no service URL'), params: null };
      if (e.refusedMsg) e.refused = en(e.refusedMsg.src, e.refusedMsg.params);
      out.push(e);
    }
  };
  walk(data?.operationalLayers, [], false);
  walk(data?.baseMap?.baseMapLayers, [], true);
  return out;
}

/** A web map's embedded feature collection → [{name, geometryType, fields, features: [{geometry (Esri), attributes}]}]. */
export function collectionLayers(fc) {
  return (fc?.layers ?? []).map((l) => ({ name: l.layerDefinition?.name ?? l.featureSet?.geometryType ?? 'layer', geometryType: l.featureSet?.geometryType ?? l.layerDefinition?.geometryType ?? null, fields: l.layerDefinition?.fields ?? [], sr: l.featureSet?.spatialReference ?? l.layerDefinition?.spatialReference ?? null, features: l.featureSet?.features ?? [], drawingInfo: l.layerDefinition?.drawingInfo ?? null }));
}

// ---------------------------------------------------------------- attachments

const oidOk = (oid) => {
  const n = Number(oid);
  if (!Number.isSafeInteger(n) || n < 0) throw gwError('"{id}" is not an object ID', { id: String(oid).slice(0, 40) }, 'E_ARCGIS_OID');
  return n;
};

/**
 * Attachments of features: layer-level queryAttachments where the layer offers it (10.7+, ArcGIS
 * Online), else /<oid>/attachments per feature. → Map(oid → [{id, name, contentType, size, keywords, url}]).
 */
export async function queryAttachments(getJson, layerUrl, info, objectIds) {
  if (info && info.hasAttachments === false) throw gwError('the layer {name} has no attachments enabled', { name: info.name ?? layerUrl }, 'E_ARCGIS_NO_ATTACHMENTS');
  const ids = objectIds.map(oidOk);
  const out = new Map(ids.map((id) => [id, []]));
  const norm = (oid, a) => ({ id: a.id, globalId: a.globalId ?? null, name: a.name ?? `attachment ${a.id}`, contentType: a.contentType ?? 'application/octet-stream', size: Number(a.size) || 0, keywords: a.keywords ?? '', url: a.url ?? `${layerUrl}/${oid}/attachments/${a.id}` });
  if (info?.advancedQueryCapabilities?.supportsQueryAttachments) {
    const j = esriJson(await getJson(withParams(`${layerUrl}/queryAttachments`, { objectIds: ids.join(','), returnUrl: 'true', f: 'json' })), info?.name ?? layerUrl);
    for (const g of j.attachmentGroups ?? []) out.set(Number(g.parentObjectId), (g.attachmentInfos ?? []).map((a) => norm(g.parentObjectId, a)));
    return out;
  }
  for (const id of ids) {
    const j = esriJson(await getJson(withParams(`${layerUrl}/${id}/attachments`, { f: 'json' })), info?.name ?? layerUrl);
    out.set(id, (j.attachmentInfos ?? []).map((a) => norm(id, a)));
  }
  return out;
}

/** addAttachment (multipart): → {id, globalId}. `post(url, FormData)` returns the JSON reply. */
export async function addAttachment(post, layerUrl, oid, file, { name = '' } = {}) {
  const id = oidOk(oid);
  const fd = new FormData();
  fd.append('f', 'json');
  fd.append('attachment', file, name || file.name || 'attachment');
  const j = esriJson(await post(`${layerUrl}/${id}/addAttachment`, fd), layerUrl);
  const r = j.addAttachmentResult;
  if (!r?.success) throw gwError('the service did not add the attachment: {msg}', { msg: r?.error?.description ?? 'no result' }, 'E_ARCGIS_ATTACHMENT');
  return { id: r.objectId, globalId: r.globalId ?? null };
}

/** deleteAttachments: → the ids deleted; refuses by name when any was not. */
export async function deleteAttachments(post, layerUrl, oid, ids) {
  const id = oidOk(oid);
  const list = ids.map(oidOk);
  const fd = new URLSearchParams({ f: 'json', attachmentIds: list.join(',') });
  const j = esriJson(await post(`${layerUrl}/${id}/deleteAttachments`, fd), layerUrl);
  const res = j.deleteAttachmentResults ?? [];
  const bad = res.filter((r) => !r.success);
  if (bad.length || res.length !== list.length) throw gwError('{n, plural, one {# attachment was} other {# attachments were}} not deleted: {msg}', { n: bad.length || list.length - res.length, msg: bad.map((r) => r.error?.description ?? r.objectId).join('; ') || 'no result' }, 'E_ARCGIS_ATTACHMENT');
  return res.map((r) => r.objectId);
}

// ---------------------------------------------------------------- related records

/** A layer's relationships: [{id, name, relatedTableId, cardinality, role, keyField, keyFieldInRelationshipTable, composite}]. */
export function relationships(info) {
  return (info?.relationships ?? []).map((r) => ({ id: r.id, name: r.name ?? `relationship ${r.id}`, relatedTableId: r.relatedTableId, cardinality: r.cardinality ?? null, role: r.role ?? null, keyField: r.keyField ?? null, keyFieldInRelationshipTable: r.keyFieldInRelationshipTable ?? null, composite: !!r.composite }));
}

/** The URL of a sibling layer or table of a FeatureServer/MapServer layer. */
export function siblingUrl(layerUrl, id) {
  const p = arcgisParts(layerUrl);
  if (!p) throw gwError('{url} is not an ArcGIS service layer', { url: layerUrl }, 'E_ARCGIS_URL');
  return `${p.root}/${id}`;
}

/** queryRelatedRecords → Map(parent oid → [{attributes, geometry}]) and the related fields. */
export async function queryRelated(getJson, layerUrl, { objectIds, relationshipId, outFields = '*', definitionExpression = null, gdbVersion = null }) {
  const j = esriJson(await getJson(withParams(`${layerUrl}/queryRelatedRecords`, { objectIds: objectIds.map(oidOk).join(','), relationshipId, outFields, definitionExpression, returnGeometry: 'false', gdbVersion, f: 'json' })), layerUrl);
  const groups = new Map();
  for (const g of j.relatedRecordGroups ?? []) groups.set(Number(g.objectId), (g.relatedRecords ?? []).map((r) => ({ attributes: r.attributes ?? {}, geometry: r.geometry ?? null })));
  return { groups, fields: j.fields ?? null };
}

/**
 * Related record edits for one parent (origin role): adds get the relationship key from the
 * parent, every add and update is checked against the related table's fields, domains and
 * subtypes first (REQ-GAP-63 checks), and nothing is sent while any value is refused.
 * → the applyEdits body for the related table.
 */
export function relatedEdits(rel, tableInfo, parentAttrs, { adds = [], updates = [], deletes = [] }) {
  if (rel.cardinality === 'esriRelCardinalityManyToMany') throw gwError('many-to-many relationships ({name}) are read only here', { name: rel.name }, 'E_ARCGIS_REL_MANY');
  if (rel.role && rel.role !== 'esriRelRoleOrigin') throw gwError('related records are edited from the origin side of {name}; open its origin layer', { name: rel.name }, 'E_ARCGIS_REL_ROLE');
  const fields = esriFields(tableInfo);
  const subtypes = esriSubtypes(tableInfo);
  const idField = tableInfo.objectIdField ?? fields.find((f) => f.esri === 'esriFieldTypeOID')?.name ?? 'OBJECTID';
  const fk = rel.keyFieldInRelationshipTable;
  const key = rel.keyField ? parentAttrs?.[rel.keyField] : undefined;
  if (!fk || key === undefined || key === null) throw gwError('the parent feature has no value in {field}, the key of {name}', { field: rel.keyField ?? '?', name: rel.name }, 'E_ARCGIS_REL_KEY');
  const issues = [];
  const addsOut = adds.map((a) => {
    const attrs = { ...a, [fk]: key };
    for (const e of checkEsriAttrs(fields, subtypes, attrs, { isNew: true })) issues.push(e);
    return { attributes: writeEsriAttrs(fields, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== idField))) };
  });
  const updOut = updates.map((u) => {
    if (u[idField] === undefined) throw gwError('a related record update has no {field}', { field: idField }, 'E_ARCGIS_OID');
    if (fk in u && String(u[fk]) !== String(key)) throw gwError('a related record update would move it to another parent ({field}); not sent', { field: fk }, 'E_ARCGIS_REL_KEY');
    for (const e of checkEsriAttrs(fields, subtypes, u)) issues.push(e);
    return { attributes: { ...writeEsriAttrs(fields, Object.fromEntries(Object.entries(u).filter(([k]) => k !== idField))), [idField]: oidOk(u[idField]) } };
  });
  if (issues.length) throw Object.assign(gwError('{n, plural, one {# value is} other {# values are}} not allowed by the related table, so nothing was sent', { n: issues.length }, 'E_ATTRS_INVALID'), { issues });
  return { adds: addsOut, updates: updOut, deletes: deletes.map(oidOk), idField, fields };
}

export const readRelatedAttrs = (tableInfo, attrs) => readEsriAttrs(esriFields(tableInfo), attrs);

/** An applyEdits reply → {addIds, updated, deleted}; refuses by name when any edit failed. */
export function editResults(j, name) {
  esriJson(j, name);
  const all = [...(j.addResults ?? []), ...(j.updateResults ?? []), ...(j.deleteResults ?? [])];
  const bad = all.filter((x) => !x.success);
  if (bad.length) throw gwError('{name}: {n, plural, one {# edit} other {# edits}} refused: {msg}', { name, n: bad.length, msg: bad.map((x) => x.error?.description ?? 'error').join('; ') }, 'E_EDITS_REFUSED');
  return { addIds: (j.addResults ?? []).map((x) => x.objectId), updated: (j.updateResults ?? []).length, deleted: (j.deleteResults ?? []).length, editMoment: j.editMoment ?? null };
}

// ---------------------------------------------------------------- branch versions

/** The Version Management Service beside a FeatureServer (branch versioning, ArcGIS Enterprise 10.6+). */
export function versionServiceUrl(url) {
  const p = arcgisParts(url);
  if (!p || p.type !== 'FeatureServer') throw gwError('{url} is not a FeatureServer: branch versions are managed beside a feature service', { url }, 'E_ARCGIS_URL');
  return p.root.replace(/\/FeatureServer$/i, '/VersionManagementServer');
}

const guidOf = (g) => {
  const s = String(g ?? '').replace(/[{}]/g, '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) throw gwError('"{id}" is not a version GUID', { id: String(g).slice(0, 60) }, 'E_ARCGIS_VERSION');
  return s.toUpperCase();
};
/** A session ID for startReading/startEditing: a GUID in braces, as the service expects. */
export const newSessionId = (uuid = () => crypto.randomUUID()) => `{${uuid().toUpperCase()}}`;

/** versionInfos → [{name, guid, owner, access, description, modified, isDefault}]. */
export async function listVersions(getJson, vms) {
  const j = esriJson(await getJson(withParams(`${vms}/versionInfos`, { f: 'json' })), vms);
  return (j.versions ?? []).map((v) => ({ name: v.versionName, guid: guidOf(v.versionGuid), owner: String(v.versionName ?? '').split('.')[0] || null, access: v.access ?? null, description: v.description ?? '', modified: v.modifiedDate ?? null, isDefault: /\.DEFAULT$/i.test(v.versionName ?? '') || v.versionName === 'DEFAULT' }));
}

async function vmsCall(post, vms, guid, op, params, name) {
  const j = esriJson(await post(`${vms}/versions/${guidOf(guid)}/${op}`, new URLSearchParams({ f: 'json', ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) })), name);
  if (j.success === false) throw gwError('{name}: {op} failed', { name, op }, 'E_ARCGIS_VERSION_OP');
  return j;
}

export const startReading = (post, vms, guid, sessionId) => vmsCall(post, vms, guid, 'startReading', { sessionId }, vms);
export const stopReading = (post, vms, guid, sessionId) => vmsCall(post, vms, guid, 'stopReading', { sessionId }, vms);
export const startEditing = (post, vms, guid, sessionId) => vmsCall(post, vms, guid, 'startEditing', { sessionId }, vms);
/** stopEditing: saveEdits true keeps the session's edits in the version, false discards them. */
export const stopEditing = (post, vms, guid, sessionId, saveEdits) => vmsCall(post, vms, guid, 'stopEditing', { sessionId, saveEdits: saveEdits ? 'true' : 'false' }, vms);
/** reconcile with DEFAULT, optionally posting: → {hasConflicts, didPost, moment}. A default version cannot be reconciled. */
export async function reconcile(post, vms, guid, sessionId, { withPost = false, abortIfConflicts = true, conflictDetection = 'byObject' } = {}) {
  const j = await vmsCall(post, vms, guid, 'reconcile', { sessionId, abortIfConflicts: abortIfConflicts ? 'true' : 'false', conflictDetection, withPost: withPost ? 'true' : 'false' }, vms);
  return { hasConflicts: !!j.hasConflicts, didPost: !!j.didPost, moment: j.moment ?? null };
}
export async function postVersion(post, vms, guid, sessionId) {
  const j = await vmsCall(post, vms, guid, 'post', { sessionId }, vms);
  return { moment: j.moment ?? null };
}
