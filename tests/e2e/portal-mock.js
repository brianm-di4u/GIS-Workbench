// A mock ArcGIS portal and hosting server for the REQ-GAP-64 tests (2.5 streams), on two origins
// (two ports of 127.0.0.1): the portal (sharing/rest: portals/self, search, items, web map data,
// OAuth 2.0 authorize with PKCE S256 and the out-of-band page, token, refresh, revokeToken) and a
// hosting server whose Units feature service needs a token (X-Esri-Authorization or token=):
// a polygon layer with attachments and a relationship to an Inspections table (typed fields, a
// coded and a range domain), and a Version Management Service with session rules (startReading
// before startEditing, reconcile before post). Responses follow the ArcGIS REST API reference as
// documented; this is a mock, not ArcGIS. Every request is recorded with the token it carried.

import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const S256 = (v) => b64url(createHash('sha256').update(v).digest());

export function mockPortal({ clientId = 'gw-test-client', redirects = [] } = {}) {
  const seen = [];
  const state = {
    codes: new Map(), // code → {challenge, redirect, clientId, used}
    tokens: new Map(), // access → {user, exp}
    refresh: new Map(), // refresh → user
    revoked: [],
    attachments: new Map([[1, [{ id: 11, name: 'photo.jpg', contentType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), globalId: '{A1}' }]], [2, []], [3, []]]),
    nextAtt: 100,
    inspections: [
      { OBJECTID: 1, UNIT_GUID: '{G-1}', INSPECTED: Date.UTC(2024, 0, 5), RESULT: 'pass', SCORE: 8, NOTE: 'ok' },
      { OBJECTID: 2, UNIT_GUID: '{G-1}', INSPECTED: Date.UTC(2024, 3, 9), RESULT: 'fail', SCORE: 3, NOTE: 'track' },
      { OBJECTID: 3, UNIT_GUID: '{G-2}', INSPECTED: Date.UTC(2024, 2, 1), RESULT: 'pass', SCORE: 9, NOTE: '' },
    ],
    nextInsp: 10,
    applyEdits: [],
    versions: new Map(), // guid → {name, sessions: Map(sessionId → {reading, editing, reconciled})}
    versionCalls: [],
    versionData: new Map(), // version name → Map(oid → attributes override)
  };
  const DEFAULT = '{BD3F4817-9A00-41AC-B0CC-58F78DBAE0A1}';
  const FIELDWORK = '{5E3C2B11-7F6D-4E1A-9C2B-1A2B3C4D5E6F}';
  state.versions.set(DEFAULT.slice(1, -1), { name: 'sde.DEFAULT', sessions: new Map() });
  state.versions.set(FIELDWORK.slice(1, -1), { name: 'editor1.fieldwork', sessions: new Map() });
  let portal = null;
  let host = null;
  let origins = {};

  const tokenOf = (req, q, body) => {
    const h = req.headers['x-esri-authorization'] ?? req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m?.[1] ?? q.get('token') ?? body?.get?.('token') ?? null;
  };
  const valid = (tok) => {
    const s = tok && state.tokens.get(tok);
    return s && s.exp > Date.now() ? s : null;
  };

  function common(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'X-Esri-Authorization, Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  }
  const json = (res, o, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  const readBody = (req) =>
    new Promise((r) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => r(Buffer.concat(chunks)));
    });
  /** A form body (urlencoded) or a multipart one → {params: URLSearchParams, files: [{name, filename, type, data}]}. */
  function parseBody(req, raw) {
    const ct = req.headers['content-type'] ?? '';
    const files = [];
    const params = new URLSearchParams();
    const mb = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (/multipart\/form-data/.test(ct) && mb) {
      const sep = Buffer.from(`--${mb[1] ?? mb[2]}`);
      let i = raw.indexOf(sep);
      while (i >= 0) {
        const next = raw.indexOf(sep, i + sep.length);
        if (next < 0) break;
        const part = raw.subarray(i + sep.length + 2, next - 2);
        const he = part.indexOf('\r\n\r\n');
        const head = part.subarray(0, he).toString();
        const data = part.subarray(he + 4);
        const name = /name="([^"]+)"/.exec(head)?.[1];
        const filename = /filename="([^"]*)"/.exec(head)?.[1];
        const type = /Content-Type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? 'application/octet-stream';
        if (filename !== undefined) files.push({ name, filename, type, data: Buffer.from(data) });
        else if (name) params.set(name, data.toString());
        i = next;
      }
    } else for (const [k, v] of new URLSearchParams(raw.toString())) params.set(k, v);
    return { params, files };
  }

  // ---- the portal ----

  const items = () => [
    { id: 'aa11aa11aa11aa11aa11aa11aa11aa11', title: 'Units (secured)', type: 'Feature Service', owner: 'editor1', url: `${origins.host}/server/rest/services/Units/FeatureServer`, snippet: 'Units with inspections', access: 'org', extent: [[8, 47], [8.1, 47.1]], typeKeywords: ['ArcGIS Server', 'Data'] },
    { id: 'bb22bb22bb22bb22bb22bb22bb22bb22', title: 'Operations map', type: 'Web Map', owner: 'editor1', url: null, snippet: 'A web map', access: 'public', extent: null, typeKeywords: ['Web Map'] },
    { id: 'cc33cc33cc33cc33cc33cc33cc33cc33', title: 'Base map service', type: 'Map Service', owner: 'admin', url: origins.svc ? `${origins.svc}/arcgis/rest/services/Map/MapServer` : null, snippet: '', access: 'public', extent: null, typeKeywords: [] },
    { id: 'dd44dd44dd44dd44dd44dd44dd44dd44', title: 'Field manual', type: 'PDF', owner: 'admin', url: null, snippet: '', access: 'public', extent: null, typeKeywords: [] },
  ];
  const webmap = () => ({
    operationalLayers: [
      { id: 'g1', title: 'Field', layerType: 'GroupLayer', layers: [{ id: 'u', title: 'Units', layerType: 'ArcGISFeatureLayer', url: `${origins.host}/server/rest/services/Units/FeatureServer/0`, visibility: true, layerDefinition: { definitionExpression: 'STRENGTH > 0' } }] },
      { id: 'm', title: 'Map', layerType: 'ArcGISMapServiceLayer', url: origins.svc ? `${origins.svc}/arcgis/rest/services/Map/MapServer` : null },
      { id: 'c', title: 'Spreadsheet', layerType: 'CSV', url: `${origins.portal}/x.csv` },
      { id: 'fc', title: 'Sketch', featureCollection: { layers: [{ layerDefinition: { name: 'Notes', geometryType: 'esriGeometryPoint', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'TEXT', type: 'esriFieldTypeString' }] }, featureSet: { geometryType: 'esriGeometryPoint', spatialReference: { wkid: 4326 }, features: [{ geometry: { x: 8.05, y: 47.05 }, attributes: { OBJECTID: 1, TEXT: 'gate' } }] } }] } },
      { id: 'kml', title: 'Overlay', layerType: 'KML', url: `${origins.portal}/x.kml` },
    ],
    baseMap: { title: 'Topographic', baseMapLayers: [{ id: 'b', title: 'World Topographic Map', layerType: 'ArcGISTiledMapServiceLayer', url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer' }] },
    version: '2.29',
  });

  async function portalHandler(req, res) {
    if (common(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const { params } = req.method === 'POST' ? parseBody(req, raw) : { params: new URLSearchParams() };
    const tok = tokenOf(req, q, params);
    seen.push({ at: Date.now(), server: 'portal', method: req.method, path: u.pathname, query: u.search, token: tok, header: req.headers['x-esri-authorization'] ? 'x-esri' : req.headers.authorization ? 'authorization' : null, origin: req.headers.origin ?? null });
    const p = u.pathname;
    if (p === '/sharing/rest/portals/self') return json(res, { id: 'mock', name: 'Mock Portal', isPortal: true, urlKey: 'mock', user: valid(tok) ? { username: valid(tok).user } : undefined });
    if (p === '/sharing/rest/portals/self/servers') return json(res, { servers: [{ url: `${origins.host}/server`, serverRole: 'HOSTING_SERVER', serverType: 'ArcGIS' }] });
    if (p === '/sharing/rest/search') {
      const text = q.get('q') ?? '';
      const types = [...text.matchAll(/type:"([^"]+)"/g)].map((m) => m[1]);
      const words = text.replace(/\(?type:"[^"]+"\)?/g, '').replace(/[()]|\bOR\b|\bAND\b/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);
      // Secured items only with a token (an org item); public ones for everyone.
      const list = items().filter((it) => (it.access === 'public' || valid(tok)) && (!types.length || types.includes(it.type)) && words.every((w) => w === '*' || it.title.toLowerCase().includes(w) || it.snippet.toLowerCase().includes(w)));
      const start = Number(q.get('start') ?? 1);
      const num = Number(q.get('num') ?? 10);
      const page = list.slice(start - 1, start - 1 + num);
      return json(res, { query: text, total: list.length, start, num, nextStart: start - 1 + num < list.length ? start + num : -1, results: page });
    }
    let m = /^\/sharing\/rest\/content\/items\/([0-9a-f]{32})(\/data)?$/.exec(p);
    if (m) {
      const it = items().find((x) => x.id === m[1]);
      if (!it) return json(res, { error: { code: 400, message: 'Item does not exist or is inaccessible.', details: [] } });
      if (it.access !== 'public' && !valid(tok)) return json(res, { error: { code: 403, message: 'You do not have permissions to access this resource or perform this operation.', details: [] } });
      if (m[2]) return json(res, it.type === 'Web Map' ? webmap() : {});
      return json(res, it);
    }
    if (p === '/sharing/rest/oauth2/authorize') {
      const cid = q.get('client_id');
      const redirect = q.get('redirect_uri');
      if (cid !== clientId) return json(res, { error: { code: 400, message: 'Invalid client_id' } }, 400);
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, { error: { code: 400, message: 'PKCE S256 required' } }, 400);
      if (redirect !== 'urn:ietf:wg:oauth:2.0:oob' && !redirects.some((r) => redirect?.startsWith(r))) return json(res, { error: { code: 400, message: 'Invalid redirect_uri' } }, 400);
      const code = b64url(randomUUID());
      state.codes.set(code, { challenge: q.get('code_challenge'), redirect, clientId: cid, used: false });
      if (redirect === 'urn:ietf:wg:oauth:2.0:oob') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<!DOCTYPE html><title>Mock ArcGIS sign-in</title><p>Copy this code into the app:</p><code id="code">${code}</code>`);
      }
      const back = new URL(redirect);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (p === '/sharing/rest/oauth2/token' && req.method === 'POST') {
      const g = params.get('grant_type');
      if (params.get('client_id') !== clientId) return json(res, { error: { code: 400, error: 'invalid_client_id', message: 'Invalid client_id' } });
      let user = null;
      if (g === 'authorization_code') {
        const c = state.codes.get(params.get('code'));
        if (!c || c.used || c.redirect !== params.get('redirect_uri') || S256(params.get('code_verifier') ?? '') !== c.challenge) return json(res, { error: { code: 400, error: 'invalid_request', message: 'Invalid authorization code or code_verifier' } });
        c.used = true;
        user = 'editor1';
      } else if (g === 'refresh_token') {
        user = state.refresh.get(params.get('refresh_token'));
        if (!user) return json(res, { error: { code: 498, error: 'invalid_request', message: 'Invalid refresh_token' } });
      } else return json(res, { error: { code: 400, message: 'Unsupported grant_type' } });
      const access = `at-${randomUUID()}`;
      state.tokens.set(access, { user, exp: Date.now() + 1800e3 });
      const out = { access_token: access, expires_in: 1800, username: user, ssl: true };
      if (g === 'authorization_code') {
        const r = `rt-${randomUUID()}`;
        state.refresh.set(r, user);
        out.refresh_token = r;
        out.refresh_token_expires_in = 1209600;
      }
      return json(res, out);
    }
    if (p === '/sharing/rest/oauth2/revokeToken' && req.method === 'POST') {
      state.revoked.push({ auth_token: params.get('auth_token'), token: params.get('token'), client_id: params.get('client_id') });
      state.refresh.delete(params.get('auth_token'));
      return json(res, { success: true });
    }
    res.writeHead(404);
    res.end();
  }

  // ---- the hosting server ----

  const UNITS = () => ({
    currentVersion: 11.1,
    id: 0,
    name: 'Units',
    type: 'Feature Layer',
    geometryType: 'esriGeometryPolygon',
    objectIdField: 'OBJECTID',
    globalIdField: 'GlobalID',
    hasAttachments: true,
    capabilities: 'Query,Create,Update,Delete,Editing',
    advancedQueryCapabilities: { supportsPagination: true, supportsQueryAttachments: true },
    maxRecordCount: 1000,
    isDataBranchVersioned: true,
    relationships: [{ id: 0, name: 'Unit_Inspections', relatedTableId: 1, cardinality: 'esriRelCardinalityOneToMany', role: 'esriRelRoleOrigin', keyField: 'GlobalID', keyFieldInRelationshipTable: 'UNIT_GUID', composite: false }],
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', alias: 'OBJECTID', editable: false, nullable: false },
      { name: 'GlobalID', type: 'esriFieldTypeGlobalID', alias: 'GlobalID', editable: false, nullable: false, length: 38 },
      { name: 'NAME', type: 'esriFieldTypeString', length: 40, editable: true, nullable: true },
      { name: 'STATUS', type: 'esriFieldTypeString', length: 1, editable: true, nullable: true, domain: { type: 'codedValue', name: 'Status', codedValues: [{ code: 'A', name: 'Active' }, { code: 'I', name: 'Inactive' }, { code: 'R', name: 'Reserve' }] } },
      { name: 'STRENGTH', type: 'esriFieldTypeInteger', editable: true, nullable: true, domain: { type: 'range', name: 'Pct', range: [0, 100] } },
    ],
  });
  const INSPECTIONS = () => ({
    currentVersion: 11.1,
    id: 1,
    name: 'Inspections',
    type: 'Table',
    objectIdField: 'OBJECTID',
    capabilities: 'Query,Create,Update,Delete,Editing',
    relationships: [{ id: 0, name: 'Unit_Inspections', relatedTableId: 0, cardinality: 'esriRelCardinalityOneToMany', role: 'esriRelRoleDestination', keyField: 'UNIT_GUID', composite: false }],
    fields: [
      { name: 'OBJECTID', type: 'esriFieldTypeOID', editable: false, nullable: false },
      { name: 'UNIT_GUID', type: 'esriFieldTypeGUID', length: 38, editable: true, nullable: true },
      { name: 'INSPECTED', type: 'esriFieldTypeDate', editable: true, nullable: true },
      { name: 'RESULT', type: 'esriFieldTypeString', length: 4, editable: true, nullable: false, domain: { type: 'codedValue', name: 'Result', codedValues: [{ code: 'pass', name: 'Pass' }, { code: 'fail', name: 'Fail' }] } },
      { name: 'SCORE', type: 'esriFieldTypeSmallInteger', editable: true, nullable: true, domain: { type: 'range', name: 'Score', range: [0, 10] } },
      { name: 'NOTE', type: 'esriFieldTypeString', length: 20, editable: true, nullable: true },
    ],
  });
  const base = [
    { OBJECTID: 1, GlobalID: '{G-1}', NAME: 'Alpha', STATUS: 'A', STRENGTH: 80, ring: [[8.0, 47.0], [8.0, 47.01], [8.01, 47.01], [8.01, 47.0], [8.0, 47.0]] },
    { OBJECTID: 2, GlobalID: '{G-2}', NAME: 'Bravo', STATUS: 'I', STRENGTH: 40, ring: [[8.02, 47.0], [8.02, 47.01], [8.03, 47.01], [8.03, 47.0], [8.02, 47.0]] },
    { OBJECTID: 3, GlobalID: '{G-3}', NAME: 'Charlie', STATUS: 'R', STRENGTH: 10, ring: [[8.04, 47.0], [8.04, 47.01], [8.05, 47.01], [8.05, 47.0], [8.04, 47.0]] },
  ];
  const unitsIn = (version) => {
    const over = state.versionData.get(version) ?? new Map();
    return base.map((b) => ({ ...b, ...(over.get(b.OBJECTID) ?? {}) }));
  };
  const vms = '/server/rest/services/Units/VersionManagementServer';
  const fs0 = '/server/rest/services/Units/FeatureServer';

  async function hostHandler(req, res) {
    if (common(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams;
    const raw = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    const { params, files } = req.method === 'POST' ? parseBody(req, raw) : { params: new URLSearchParams(), files: [] };
    const P = (k) => params.get(k) ?? q.get(k);
    const tok = tokenOf(req, q, params);
    const p = u.pathname;
    seen.push({ at: Date.now(), server: 'host', method: req.method, path: p, query: u.search, token: tok, header: req.headers['x-esri-authorization'] ? 'x-esri' : req.headers.authorization ? 'authorization' : null, origin: req.headers.origin ?? null, params: Object.fromEntries(params) });
    if (!valid(tok)) return json(res, { error: { code: 499, message: 'Token Required', details: [] } });
    if (p === fs0) return json(res, { currentVersion: 11.1, layers: [{ id: 0, name: 'Units' }], tables: [{ id: 1, name: 'Inspections' }] });
    if (p === `${fs0}/0`) return json(res, UNITS());
    if (p === `${fs0}/1`) return json(res, INSPECTIONS());
    if (p === `${fs0}/0/query`) {
      const list = unitsIn(P('gdbVersion') ?? 'sde.DEFAULT');
      const off = Number(P('resultOffset') ?? 0);
      const n = Number(P('resultRecordCount') ?? 1000);
      const page = list.slice(off, off + n);
      return json(res, { objectIdFieldName: 'OBJECTID', globalIdFieldName: 'GlobalID', geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 }, fields: UNITS().fields, exceededTransferLimit: off + n < list.length, features: page.map(({ ring, ...a }) => ({ attributes: a, geometry: { rings: [ring] } })) });
    }
    if (p === `${fs0}/0/queryAttachments`) {
      const ids = String(P('objectIds') ?? '').split(',').map(Number);
      return json(res, { attachmentGroups: ids.filter((i) => state.attachments.has(i)).map((i) => ({ parentObjectId: i, parentGlobalId: base.find((b) => b.OBJECTID === i)?.GlobalID, attachmentInfos: state.attachments.get(i).map((a) => ({ id: a.id, globalId: a.globalId, name: a.name, contentType: a.contentType, size: a.bytes.length, keywords: '', url: `${origins.host}${fs0}/0/${i}/attachments/${a.id}` })) })) });
    }
    let m = /^\/server\/rest\/services\/Units\/FeatureServer\/0\/(\d+)\/attachments\/(\d+)$/.exec(p);
    if (m) {
      const a = (state.attachments.get(Number(m[1])) ?? []).find((x) => x.id === Number(m[2]));
      if (!a) return json(res, { error: { code: 404, message: 'Attachment not found' } });
      res.writeHead(200, { 'content-type': a.contentType, 'content-length': a.bytes.length });
      return res.end(a.bytes);
    }
    m = /^\/server\/rest\/services\/Units\/FeatureServer\/0\/(\d+)\/addAttachment$/.exec(p);
    if (m && req.method === 'POST') {
      const f = files.find((x) => x.name === 'attachment');
      if (!f) return json(res, { addAttachmentResult: { success: false, error: { code: 400, description: 'No attachment' } } });
      const id = state.nextAtt++;
      (state.attachments.get(Number(m[1])) ?? state.attachments.set(Number(m[1]), []).get(Number(m[1]))).push({ id, name: f.filename, contentType: f.type, bytes: f.data, globalId: `{N${id}}` });
      return json(res, { addAttachmentResult: { objectId: id, globalId: `{N${id}}`, success: true } });
    }
    m = /^\/server\/rest\/services\/Units\/FeatureServer\/0\/(\d+)\/deleteAttachments$/.exec(p);
    if (m && req.method === 'POST') {
      const list = state.attachments.get(Number(m[1])) ?? [];
      const ids = String(P('attachmentIds') ?? '').split(',').map(Number);
      const out = ids.map((id) => {
        const k = list.findIndex((a) => a.id === id);
        if (k < 0) return { objectId: id, success: false, error: { code: 404, description: 'Attachment not found' } };
        list.splice(k, 1);
        return { objectId: id, success: true };
      });
      return json(res, { deleteAttachmentResults: out });
    }
    if (p === `${fs0}/0/queryRelatedRecords`) {
      const ids = String(P('objectIds') ?? '').split(',').map(Number);
      return json(res, { fields: INSPECTIONS().fields, relatedRecordGroups: ids.map((i) => ({ objectId: i, relatedRecords: state.inspections.filter((r) => r.UNIT_GUID === base.find((b) => b.OBJECTID === i)?.GlobalID).map((r) => ({ attributes: { ...r } })) })).filter((g) => g.relatedRecords.length) });
    }
    if (p === `${fs0}/1/applyEdits` || p === `${fs0}/0/applyEdits`) {
      const target = p.includes('/1/') ? 'inspections' : 'units';
      const e = { target, adds: JSON.parse(P('adds') || '[]'), updates: JSON.parse(P('updates') || '[]'), deletes: String(P('deletes') ?? '').split(',').filter(Boolean).map(Number), gdbVersion: P('gdbVersion'), sessionID: P('sessionID') };
      state.applyEdits.push(e);
      if (e.sessionID) {
        const v = [...state.versions.values()].find((x) => x.name === e.gdbVersion);
        const s = v?.sessions.get(e.sessionID);
        if (!s?.editing) return json(res, { error: { code: 400, message: 'The version is not in an edit session', details: [] } });
      }
      if (target === 'inspections') {
        const addResults = e.adds.map((a) => {
          const id = state.nextInsp++;
          state.inspections.push({ OBJECTID: id, ...a.attributes });
          return { objectId: id, success: true };
        });
        const updateResults = e.updates.map((a) => {
          const r = state.inspections.find((x) => x.OBJECTID === a.attributes.OBJECTID);
          if (r) Object.assign(r, a.attributes);
          return { objectId: a.attributes.OBJECTID, success: !!r };
        });
        const deleteResults = e.deletes.map((id) => {
          const k = state.inspections.findIndex((x) => x.OBJECTID === id);
          if (k >= 0) state.inspections.splice(k, 1);
          return { objectId: id, success: k >= 0 };
        });
        return json(res, { addResults, updateResults, deleteResults });
      }
      const ver = e.gdbVersion ?? 'sde.DEFAULT';
      const over = state.versionData.get(ver) ?? state.versionData.set(ver, new Map()).get(ver);
      const updateResults = e.updates.map((a) => {
        over.set(a.attributes.OBJECTID, { ...(over.get(a.attributes.OBJECTID) ?? {}), ...a.attributes });
        return { objectId: a.attributes.OBJECTID, success: true };
      });
      return json(res, { addResults: e.adds.map((_, i) => ({ objectId: 1000 + i, success: true })), updateResults, deleteResults: e.deletes.map((id) => ({ objectId: id, success: true })) });
    }
    if (p === `${vms}/versionInfos`) return json(res, { versions: [...state.versions.entries()].map(([g, v]) => ({ versionName: v.name, versionGuid: `{${g}}`, access: 'public', description: '', modifiedDate: Date.UTC(2024, 5, 1) })) });
    m = /^\/server\/rest\/services\/Units\/VersionManagementServer\/versions\/([0-9A-F-]{36})\/(\w+)$/i.exec(p);
    if (m && req.method === 'POST') {
      const v = state.versions.get(m[1].toUpperCase());
      const op = m[2];
      const sid = P('sessionId');
      state.versionCalls.push({ guid: m[1], op, sessionId: sid, saveEdits: P('saveEdits'), withPost: P('withPost') });
      if (!v) return json(res, { error: { code: 404, message: 'Version not found' } });
      if (!/^\{[0-9A-F-]{36}\}$/.test(sid ?? '')) return json(res, { error: { code: 400, message: 'Invalid sessionId' } });
      const s = v.sessions.get(sid) ?? {};
      const fail = (msg) => json(res, { success: false, error: { code: 400, message: msg } });
      if (op === 'startReading') v.sessions.set(sid, { ...s, reading: true });
      else if (op === 'stopReading') v.sessions.delete(sid);
      else if (op === 'startEditing') {
        if (!s.reading) return fail('startReading first');
        v.sessions.set(sid, { ...s, editing: true });
      } else if (op === 'stopEditing') {
        if (!s.editing) return fail('not editing');
        v.sessions.set(sid, { ...s, editing: false, saved: P('saveEdits') === 'true' });
      } else if (op === 'reconcile') {
        if (!s.editing) return fail('reconcile needs an edit session');
        v.sessions.set(sid, { ...s, reconciled: true });
        return json(res, { success: true, hasConflicts: false, moment: Date.now(), didPost: false });
      } else if (op === 'post') {
        if (!s.reconciled) return fail('reconcile first');
        // Post: the version's edits move to DEFAULT.
        const over = state.versionData.get(v.name);
        if (over) {
          const def = state.versionData.get('sde.DEFAULT') ?? state.versionData.set('sde.DEFAULT', new Map()).get('sde.DEFAULT');
          for (const [k, a] of over) def.set(k, { ...(def.get(k) ?? {}), ...a });
        }
        state.posted = (state.posted ?? 0) + 1;
      } else return fail(`unknown operation ${op}`);
      return json(res, { success: true, moment: Date.now() });
    }
    res.writeHead(404);
    res.end();
  }

  return {
    seen,
    state,
    guids: { DEFAULT, FIELDWORK },
    async start({ svcOrigin = null } = {}) {
      portal = createServer((q, r) => portalHandler(q, r).catch((e) => (r.writeHead(500), r.end(String(e.message)))));
      host = createServer((q, r) => hostHandler(q, r).catch((e) => (r.writeHead(500), r.end(String(e.message)))));
      await new Promise((r) => portal.listen(0, '127.0.0.1', r));
      await new Promise((r) => host.listen(0, '127.0.0.1', r));
      origins = { portal: `http://127.0.0.1:${portal.address().port}`, host: `http://127.0.0.1:${host.address().port}`, svc: svcOrigin };
      return origins;
    },
    close: () => Promise.all([portal, host].filter(Boolean).map((s) => new Promise((r) => s.close(r)))),
  };
}
