// REQ-EXT-26: edit an ArcGIS REST feature service layer and a WFS-T 2.0 feature type from an
// allowed origin, with a user-typed token; edits are diffed and sent as applyEdits / Transaction.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp } from './helpers.js';

test.describe.configure({ timeout: 180000 });

/** A small in-memory ArcGIS feature service and WFS-T endpoint; both require token "secret". */
function mockServer() {
  const arc = new Map([1, 2, 3].map((i) => [i, { id: i, name: `Site ${i}`, x: -117 + i * 0.01, y: 34.5 }]));
  let nextOid = 4;
  const wfs = new Map([1, 2].map((i) => [`roads.${i}`, { id: `roads.${i}`, name: `Road ${i}`, pts: [[-117, 34.5 + i * 0.01], [-116.99, 34.5 + i * 0.01]] }]));
  let nextFid = 3;
  const seen = { tokens: [], posts: [] };
  const srv = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (o, code = 200) => {
        res.writeHead(code, { ...cors, 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (u.pathname.startsWith('/arcgis/')) {
        const token = u.searchParams.get('token') ?? new URLSearchParams(body).get('token');
        seen.tokens.push(token);
        if (token !== 'secret') return json({ error: { code: 498, message: 'Invalid token' } });
        if (u.pathname.endsWith('/FeatureServer/0')) return json({ objectIdField: 'OBJECTID', geometryType: 'esriGeometryPoint', fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }, { name: 'NAME', type: 'esriFieldTypeString' }] });
        if (u.pathname.endsWith('/query')) return json({ type: 'FeatureCollection', features: [...arc.values()].map((f) => ({ type: 'Feature', id: f.id, properties: { OBJECTID: f.id, NAME: f.name }, geometry: { type: 'Point', coordinates: [f.x, f.y] } })) });
        if (u.pathname.endsWith('/applyEdits')) {
          const p = new URLSearchParams(body);
          seen.posts.push(Object.fromEntries(p));
          const adds = JSON.parse(p.get('adds') || '[]');
          const updates = JSON.parse(p.get('updates') || '[]');
          const deletes = (p.get('deletes') || '').split(',').filter(Boolean).map(Number);
          const addResults = adds.map((a) => {
            const id = nextOid++;
            arc.set(id, { id, name: a.attributes.NAME, x: a.geometry.x, y: a.geometry.y });
            return { objectId: id, success: true };
          });
          const updateResults = updates.map((a) => {
            const f = arc.get(a.attributes.OBJECTID);
            Object.assign(f, { name: a.attributes.NAME, x: a.geometry.x, y: a.geometry.y });
            return { objectId: f.id, success: true };
          });
          const deleteResults = deletes.map((id) => ({ objectId: id, success: arc.delete(id) }));
          return json({ addResults, updateResults, deleteResults });
        }
      }
      if (u.pathname === '/wfs') {
        seen.tokens.push(u.searchParams.get('authkey'));
        if (u.searchParams.get('authkey') !== 'secret') {
          res.writeHead(403, cors);
          return res.end('<ows:ExceptionReport><ows:ExceptionText>forbidden</ows:ExceptionText></ows:ExceptionReport>');
        }
        if (req.method === 'GET') return json({ type: 'FeatureCollection', features: [...wfs.values()].map((f) => ({ type: 'Feature', id: f.id, properties: { name: f.name }, geometry: { type: 'LineString', coordinates: f.pts } })) });
        seen.posts.push(body);
        const ins = [...body.matchAll(/<test:roads><test:name>([^<]*)<\/test:name><test:geometry><gml:LineString[^>]*><gml:posList>([^<]*)<\/gml:posList>/g)].map((m) => {
          const id = `roads.${nextFid++}`;
          const n = m[2].trim().split(/\s+/).map(Number);
          const pts = [];
          for (let i = 0; i < n.length; i += 2) pts.push([n[i + 1], n[i]]);
          wfs.set(id, { id, name: m[1], pts });
          return id;
        });
        for (const m of body.matchAll(/<wfs:Update[^>]*>.*?<wfs:ValueReference>name<\/wfs:ValueReference><wfs:Value>([^<]*)<\/wfs:Value>.*?rid="([^"]+)"/gs)) wfs.get(m[2]).name = m[1];
        for (const m of body.matchAll(/<wfs:Delete[^>]*>.*?rid="([^"]+)"/gs)) wfs.delete(m[1]);
        res.writeHead(200, { ...cors, 'content-type': 'application/xml' });
        return res.end(`<wfs:TransactionResponse xmlns:wfs="http://www.opengis.net/wfs/2.0" xmlns:fes="http://www.opengis.net/fes/2.0"><wfs:TransactionSummary><wfs:totalInserted>${ins.length}</wfs:totalInserted></wfs:TransactionSummary><wfs:InsertResults>${ins.map((id) => `<wfs:Feature><fes:ResourceId rid="${id}"/></wfs:Feature>`).join('')}</wfs:InsertResults></wfs:TransactionResponse>`);
      }
      res.writeHead(404, cors);
      res.end();
    });
  });
  return { srv, arc, wfs, seen };
}

test('REQ-EXT-26 edit an ArcGIS REST feature service and a WFS-T feature type with a typed token: adds, updates, deletes reach the service', async ({ page }) => {
  const m = mockServer();
  await new Promise((r) => m.srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${m.srv.address().port}`;
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const dir = join(tmpdir(), 'gw-remote-edit');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'gis-workbench-remote.html');
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const { frame: f2, logs } = await openApp(page2, 'file', { htmlPath: copy });
    const r = await f2.evaluate(async (o) => {
      const app = window.gisworkbench;
      const S = app.store;
      const RE = app.remoteEdit;
      // A wrong token is refused by the service.
      let refused = null;
      try {
        await RE.open({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Test/FeatureServer/0`, name: 'Sites' }, { token: 'wrong' });
      } catch (e) {
        refused = e.message;
      }
      const vl = await RE.open({ kind: 'arcgis', url: `${o}/arcgis/rest/services/Test/FeatureServer/0`, name: 'Sites' }, { token: 'secret' });
      const fs = S.all('feature').filter((f) => f.vlayer === vl).sort((a, b) => a.remoteId - b.remoteId);
      S.transact('edit', (tx) => {
        tx.set(fs[0].id, 'attrs', { ...fs[0].attrs, NAME: 'Renamed' });
        const g = structuredClone(fs[1].geom);
        g.xyz[0] += 0.005;
        tx.set(fs[1].id, 'geom', g);
        tx.delete(fs[2].id);
        tx.create('feature', { vlayer: vl, geom: RE.geojsonToGeom({ type: 'Point', coordinates: [-116.95, 34.52] }), attrs: { NAME: 'New site' } });
      });
      const p0 = RE.pending(vl);
      const saved = await RE.save(vl);
      const p1 = RE.pending(vl);
      const added = S.all('feature').find((f) => f.vlayer === vl && f.attrs.NAME === 'New site');
      // WFS-T
      const wl = await RE.open({ kind: 'wfs', url: `${o}/wfs`, name: 'Roads', typeName: 'test:roads', tokenMode: 'query', tokenParam: 'authkey' }, { token: 'secret' });
      const ws = S.all('feature').filter((f) => f.vlayer === wl).sort((a, b) => String(a.remoteId).localeCompare(String(b.remoteId)));
      S.transact('edit', (tx) => {
        tx.set(ws[0].id, 'attrs', { ...ws[0].attrs, name: 'Main Street' });
        tx.delete(ws[1].id);
        tx.create('feature', { vlayer: wl, geom: RE.geojsonToGeom({ type: 'LineString', coordinates: [[-117.02, 34.53], [-117.01, 34.54]] }), attrs: { name: 'New road' } });
      });
      const wsaved = await RE.save(wl);
      const net = app.netlog.entries.filter((e) => e.origin === o).map((e) => `${e.method} ${e.path} ${e.status}`);
      return { refused, n: fs.length, p0: { a: p0.adds.length, u: p0.updates.length, d: p0.deletes.length }, saved, p1: p1.adds.length + p1.updates.length + p1.deletes.length, addedId: added.remoteId, wn: ws.length, wsaved, net, tokenInLog: JSON.stringify(app.netlog.entries).includes('secret') };
    }, origin);
    expect(r.refused).toMatch(/Invalid token/);
    expect(r.n).toBe(3);
    expect(r.p0).toEqual({ a: 1, u: 2, d: 1 });
    expect(r.saved).toMatchObject({ adds: 1, updates: 2, deletes: 1 });
    expect(r.p1).toBe(0);
    expect(r.addedId).toBe(4);
    // The service's state.
    expect(m.arc.get(1).name).toBe('Renamed');
    expect(m.arc.get(2).x).toBeCloseTo(-117 + 0.02 + 0.005, 9);
    expect(m.arc.has(3)).toBe(false);
    expect(m.arc.get(4)).toMatchObject({ name: 'New site', x: -116.95, y: 34.52 });
    expect(r.wn).toBe(2);
    expect(r.wsaved).toMatchObject({ adds: 1, updates: 1, deletes: 1, newIds: ['roads.3'] });
    expect(m.wfs.get('roads.1').name).toBe('Main Street');
    expect(m.wfs.has('roads.2')).toBe(false);
    expect(m.wfs.get('roads.3')).toMatchObject({ name: 'New road', pts: [[-117.02, 34.53], [-117.01, 34.54]] });
    expect(m.seen.posts[1]).toMatch(/<wfs:Transaction service="WFS" version="2.0.0"/);
    expect(r.net.some((x) => /POST \/arcgis\/rest\/services\/Test\/FeatureServer\/0\/applyEdits 200/.test(x))).toBe(true);
    expect(r.net.some((x) => /POST \/wfs 200/.test(x))).toBe(true);
    expect(r.tokenInLog).toBe(false);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    m.srv.close();
  }
});
