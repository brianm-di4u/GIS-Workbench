// REQ-LDR-02 REQ-ARC-16: COPC read by range (local file and HTTP Range from an allowed origin) and
// EPT streamed node by node into the 3D pane.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp, openFiles, sample } from './helpers.js';

test.describe.configure({ timeout: 300000 });
const COPC = sample('lidar-las-laz-copc', 'ellipsoid.copc.laz');

const settle = (frame, n = 60) =>
  frame.evaluate(async (n) => {
    const v = window.gisworkbench.activePane().view3d;
    for (let i = 0; i < n; i++) {
      v.invalidate();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => setTimeout(r, 15));
      if (v._streams?.every((e) => !e.inFlight) && i > 10) break;
    }
  }, n);

test('REQ-LDR-02 a local COPC streams by range: coarse nodes first, all 100,000 points when refined, positions as the whole-file read', async ({ page }) => {
  const { frame, logs } = await openApp(page, 'file');
  // A coarse threshold first: only the root node is wanted.
  const bytes = readFileSync(COPC).toString('base64');
  await frame.evaluate(async (b64) => {
    const app = window.gisworkbench;
    const u8 = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await app.pc.streamCopc(new File([u8], 'ellipsoid.copc.laz'), app.activePane(), { px: 1e9 });
  }, bytes);
  await frame.waitForFunction(() => window.gisworkbench.activePane().view3d?._streams?.length === 1, null, { timeout: 60000 });
  await settle(frame);
  const coarse = await frame.evaluate(() => {
    const e = window.gisworkbench.activePane().view3d._streams[0];
    return { ...e.stream.stats, nodes: [...e.stream.nodes.values()].filter((n) => n.count > 0).length, total: e.stream.total, kind: e.stream.kind };
  });
  expect(coarse.kind).toBe('COPC');
  expect(coarse.total).toBe(100000);
  expect(coarse.loaded).toBe(1);
  // Refine everything.
  await frame.evaluate(() => {
    const e = window.gisworkbench.activePane().view3d._streams[0];
    e.opts.px = 1e-6;
    e.opts.maxInFlight = 8;
  });
  for (let k = 0; k < 6; k++) await settle(frame, 80);
  const full = await frame.evaluate(() => {
    const v = window.gisworkbench.activePane().view3d;
    const e = v._streams[0];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const t of e.tiles) {
      const p = t.geom.attributes.position;
      for (let i = 0; i < p.count; i++) for (let a = 0; a < 3; a++) {
        const val = p.array[3 * i + a] + (a < 2 ? e.offset[a] : 0);
        if (val < min[a]) min[a] = val;
        if (val > max[a]) max[a] = val;
      }
    }
    return { points: e.cloud.n, loaded: e.stream.stats.loaded, nodes: [...e.stream.nodes.values()].filter((n) => n.count > 0).length, min, max };
  });
  expect(full.points).toBe(100000);
  expect(full.loaded).toBe(full.nodes);
  expect(coarse.loaded).toBeLessThan(full.nodes);
  // The same file read whole, in a second panel's frame: same bounds in the shared local frame.
  await frame.evaluate(() => window.gisworkbench.prefs.set('copcStream', false));
  await openFiles(frame, [COPC]);
  await frame.waitForFunction(() => window.gisworkbench.activePane().view3d?.clouds.some((c) => !c.cloud.streamed), null, { timeout: 60000 });
  const whole = await frame.evaluate(() => {
    const v = window.gisworkbench.activePane().view3d;
    const c = v.clouds.find((x) => !x.cloud.streamed);
    return { min: c.cloud.stats.min.map((x, a) => x + (a < 2 ? c.offset[a] : 0)), max: c.cloud.stats.max.map((x, a) => x + (a < 2 ? c.offset[a] : 0)), n: c.cloud.n };
  });
  expect(whole.n).toBe(100000);
  for (let a = 0; a < 3; a++) {
    expect(Math.abs(full.min[a] - whole.min[a])).toBeLessThan(0.01);
    expect(Math.abs(full.max[a] - whole.max[a])).toBeLessThan(0.01);
  }
  expect(logs).toEqual([]);
});

test('REQ-LDR-02 REQ-ARC-16 COPC over HTTP Range and EPT (binary) from an allowed origin stream into the 3D pane', async ({ page }) => {
  const copc = readFileSync(COPC);
  // An EPT dataset: a 1 km cube in UTM 11N, two levels, binary schema (X, Y, Z scaled ints, Intensity, Classification).
  const x0 = 500000;
  const y0 = 3800000;
  const schema = [{ name: 'X', type: 'signed', size: 4, scale: 0.01, offset: x0 }, { name: 'Y', type: 'signed', size: 4, scale: 0.01, offset: y0 }, { name: 'Z', type: 'signed', size: 4, scale: 0.01, offset: 0 }, { name: 'Intensity', type: 'unsigned', size: 2 }, { name: 'Classification', type: 'unsigned', size: 1 }];
  const rec = 15;
  const nodeBin = (pts) => {
    const b = Buffer.alloc(pts.length * rec);
    pts.forEach(([x, y, z, c], i) => {
      b.writeInt32LE(Math.round((x - x0) / 0.01), i * rec);
      b.writeInt32LE(Math.round((y - y0) / 0.01), i * rec + 4);
      b.writeInt32LE(Math.round(z / 0.01), i * rec + 8);
      b.writeUInt16LE(100 + i, i * rec + 12);
      b.writeUInt8(c, i * rec + 14);
    });
    return b;
  };
  const grid = (cx, cy, step, n, z, c) => {
    const out = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) out.push([cx + i * step, cy + j * step, z, c]);
    return out;
  };
  const ept = { bounds: [x0, y0, 0, x0 + 1000, y0 + 1000, 1000], boundsConforming: [x0, y0, 0, x0 + 1000, y0 + 1000, 100], dataType: 'binary', hierarchyType: 'json', points: 0, schema, span: 16, srs: { authority: 'EPSG', horizontal: '32611' }, version: '1.0.0' };
  const files = { '/ept/ept-data/0-0-0-0.bin': nodeBin(grid(x0 + 31.25, y0 + 31.25, 62.5, 16, 10, 2)), '/ept/ept-data/1-0-0-0.bin': nodeBin(grid(x0 + 15.625, y0 + 15.625, 31.25, 16, 12, 6)), '/ept/ept-data/1-1-1-0.bin': nodeBin(grid(x0 + 515.625, y0 + 515.625, 31.25, 16, 14, 6)) };
  ept.points = 256 * 3;
  files['/ept/ept.json'] = Buffer.from(JSON.stringify(ept));
  files['/ept/ept-hierarchy/0-0-0-0.json'] = Buffer.from(JSON.stringify({ '0-0-0-0': 256, '1-0-0-0': 256, '1-1-1-0': 256 }));
  let ranges = 0;
  const srv = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range', 'access-control-expose-headers': 'content-range, content-length' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.url === '/data/ellipsoid.copc.laz') {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (!m) {
        res.writeHead(200, { ...cors, 'content-length': copc.length });
        return res.end(copc);
      }
      ranges++;
      const [a, b] = [Number(m[1]), Math.min(Number(m[2]), copc.length - 1)];
      res.writeHead(206, { ...cors, 'content-range': `bytes ${a}-${b}/${copc.length}`, 'content-length': b - a + 1 });
      return res.end(copc.subarray(a, b + 1));
    }
    const f = files[req.url];
    res.writeHead(f ? 200 : 404, { ...cors, 'content-type': req.url.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    res.end(f ?? '');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const dir = join(tmpdir(), 'gw-stream-pc');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'gis-workbench-stream.html');
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const { frame: f2, logs } = await openApp(page2, 'file', { htmlPath: copy });
    const r = await f2.evaluate(async (o) => {
      const app = window.gisworkbench;
      const wait = async (pred) => {
        for (let i = 0; i < 300 && !pred(); i++) {
          app.activePane().view3d?.invalidate();
          await new Promise((res) => setTimeout(res, 20));
        }
      };
      const c = await app.pc.streamCopc(`${o}/data/ellipsoid.copc.laz`);
      await wait(() => c.stream.stats.loaded > 0 && !c.inFlight);
      const copcStats = { ...c.stream.stats, ranges: c.stream.file.ranges, total: c.stream.total };
      // EPT in a second panel.
      app.desktop.multiports[0].setLayout('1x2');
      const p2 = app.desktop.multiports[0].panes[1];
      const e = await app.pc.streamEpt(`${o}/ept/ept.json`, p2);
      e.opts.px = 1e-6;
      for (let i = 0; i < 200 && e.stream.stats.loaded < 3; i++) {
        p2.view3d.invalidate();
        await new Promise((res) => setTimeout(res, 20));
      }
      // The first point of node 1-1-1-0 at (x0 + 515.625, y0 + 515.625, 14) → lat/lon.
      const t = e.tiles.find((x) => x.key === '1-1-1-0');
      const p = t.geom.attributes.position;
      const g = p2.view3d.toGeo(p.getX(0) + e.offset[0], p.getY(0) + e.offset[1], p.getZ(0));
      return { copcStats, ept: { ...e.stream.stats, n: e.cloud.n }, g, cls: t.geom.attributes.classification.array[0], net: app.netlog.entries.filter((x) => x.origin === o).length };
    }, origin);
    expect(r.copcStats.total).toBe(100000);
    expect(r.copcStats.loaded).toBeGreaterThan(0);
    expect(r.copcStats.ranges).toBeGreaterThan(2);
    expect(ranges).toBeGreaterThan(2);
    expect(r.ept.loaded).toBe(3);
    expect(r.ept.n).toBe(768);
    // UTM 11N (500515.625, 3800515.625) = 34.345953°N, −116.994394°E (proj4).
    expect(Math.abs(r.g.lat - 34.345953)).toBeLessThan(1e-5);
    expect(Math.abs(r.g.lon - -116.994394)).toBeLessThan(1e-5);
    expect(Math.abs(r.g.hae - 14)).toBeLessThan(0.05);
    expect(r.cls).toBe(6);
    expect(r.net).toBeGreaterThan(5);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    srv.close();
  }
});
