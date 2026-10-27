// REQ-STR-15: stream OGC 3D Tiles in the 3D pane from an allowed online origin — screen-space
// error refinement (REPLACE), b3dm content with RTC_CENTER, vertices in the view's local frame.
import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openApp } from './helpers.js';
import { b3dmBox } from './mock3d.js';

test.describe.configure({ timeout: 180000 });

test('REQ-STR-15 3D Tiles stream into the 3D pane by screen-space error; b3dm vertices land in the local frame', async ({ page }) => {
  const lat0 = 34.5;
  const lon0 = -116.5;
  const r = (d) => (d * Math.PI) / 180;
  const half = 0.002;
  const tileset = {
    asset: { version: '1.0' },
    geometricError: 500,
    root: {
      boundingVolume: { region: [r(lon0 - half), r(lat0 - half), r(lon0 + half), r(lat0 + half), 0, 60] },
      geometricError: 60,
      refine: 'REPLACE',
      content: { uri: 'root.b3dm' },
      children: [
        { boundingVolume: { region: [r(lon0 - half), r(lat0 - half), r(lon0), r(lat0 + half), 0, 30] }, geometricError: 0, content: { uri: 'a.b3dm' } },
        { boundingVolume: { region: [r(lon0), r(lat0 - half), r(lon0 + half), r(lat0 + half), 0, 30] }, geometricError: 0, content: { uri: 'b.b3dm' } },
      ],
    },
  };
  const files = { '/tiles/tileset.json': Buffer.from(JSON.stringify(tileset)), '/tiles/root.b3dm': b3dmBox(lat0, lon0, 150, 40), '/tiles/a.b3dm': b3dmBox(lat0, lon0 - 0.001, 20, 12), '/tiles/b.b3dm': b3dmBox(lat0, lon0 + 0.001, 20, 18) };
  const hits = [];
  const srv = createServer((req, res) => {
    hits.push(req.url);
    const b = files[req.url];
    res.writeHead(b ? 200 : 404, { 'access-control-allow-origin': '*', 'content-type': req.url.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    res.end(b ?? '');
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { frame } = await openApp(page, 'file');
    const html = await frame.evaluate((o) => window.gisworkbench.__test.htmlWithOrigins([o]), origin);
    const dir = join(tmpdir(), 'gw-3dtiles');
    mkdirSync(dir, { recursive: true });
    const copy = join(dir, 'gis-workbench-3dtiles.html');
    writeFileSync(copy, html);
    const page2 = await page.context().newPage();
    const { frame: f2, logs } = await openApp(page2, 'file', { htmlPath: copy });
    const out = await f2.evaluate(async ({ o, lat0, lon0 }) => {
      const app = window.gisworkbench;
      const t = await app.scene3d.addTiles(`${o}/tiles/tileset.json`);
      const v = t.view;
      const settle = async () => {
        for (let i = 0; i < 80; i++) {
          v.invalidate();
          await new Promise((res) => requestAnimationFrame(res));
          if (!t.loading && i > 5) break;
        }
      };
      // Far: only the root's content.
      v.lookAtLocal(0, 0, 0, 30000);
      await settle();
      const far = { ...t.stats };
      // Close: the children replace the root.
      v.lookAtLocal(0, 0, 0, 120);
      await settle();
      await settle();
      const near = { ...t.stats };
      const kids = t.root.children.map((c) => ({ state: c.state, visible: c.object?.visible }));
      const rootVisible = t.root.object?.visible;
      // A vertex of child "a": its base corners sit at lon0 − 0.001 ± 20 m.
      const pos = t.root.children[0].object.children[0].geometry.attributes.position;
      const [e, n] = v.toLocal(lat0, lon0 - 0.001);
      let best = Infinity;
      let zmin = Infinity;
      for (let i = 0; i < pos.count; i++) {
        best = Math.min(best, Math.hypot(Math.abs(pos.getX(i) - e) - 20, Math.abs(pos.getY(i) - n) - 20));
        zmin = Math.min(zmin, pos.getZ(i));
      }
      const net = app.netlog.entries.filter((x) => x.origin === o).map((x) => x.path);
      return { far, near, kids, rootVisible, best, zmin, net };
    }, { o: origin, lat0, lon0 });
    expect(out.far.requested).toBe(1);
    expect(out.far.visible).toBe(1);
    expect(out.near.requested).toBe(3);
    expect(out.near.loaded).toBe(3);
    expect(out.kids).toEqual([{ state: 'ready', visible: true }, { state: 'ready', visible: true }]);
    expect(out.rootVisible).toBe(false);
    expect(out.best).toBeLessThan(0.3);
    expect(Math.abs(out.zmin)).toBeLessThan(0.05);
    expect(out.net).toEqual(expect.arrayContaining(['/tiles/tileset.json', '/tiles/root.b3dm', '/tiles/a.b3dm', '/tiles/b.b3dm']));
    expect(hits.length).toBe(4);
    expect(logs).toEqual([]);
    await page2.close();
  } finally {
    srv.close();
  }
});
